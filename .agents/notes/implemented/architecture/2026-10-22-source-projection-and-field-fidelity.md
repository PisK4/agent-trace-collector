# Agent Note: 来源字段按上游真实键读取并保留类型状态

Status: implemented

## Problem

来源 Adapter 按记忆中的键名读取上游账本与路由行，读不到的键静默落成 NULL，页面再把 NULL 解释成"本地估计"或"无此数据"。三处键名或类型读错，三处都不会让任何测试失败：

- 请求模型读 `requested`，magpie 的 JSON tag 是 `req`。
- 客户自报费用读 `own_cost` / `ownCost`，tag 是 `cost`。
- `prompt.counted` 是布尔，被 `optionalNumber` 读成数字，`prompt_counted` 因此恒为 NULL。
- vendor 错误原话在 `err`，Adapter 只映射了 `err_type`。

同样的读取方式把四种不同的事实压成一个 null：上游没有这个键、写了空串、写了别的类型、写了合法值。合并之后无法回答"这一笔到底是没报，还是报了个空值，还是报了读不懂的东西"。

## Decision

`src/sources/magpie.ts` 用 `stringField` / `numberField` / `promptFields` 读取，每个字段带 `FieldState`：`reported`（读到值）、`empty`（空串）、`absent`（没有键或显式 null）、`invalid`（类型不对）。`invalid` 不抛错、不转类型，值保持 null，状态记下来。空串既不是值也不是撤销。

模型三列各读自己的键：`model` 是 provider 侧模型 id，`requested` 读 `req`（agent 请求的模型：别名、路由组或 `provider/model`），`served` 读 `served`。三者不互相顶替。费用只读 `cost`；旧账本的 `own_cost` / `ownCost` 不再是来源。account 读 `account`，缺失时退回 `providerAccount`。

`prompt.counted` 走三态：`true` / `false` 分别写 1 / 0；键省略时写 0 但状态记 `absent`（合法省略等于未校准，不等于 false）；其他类型写 null 并记 `invalid`。`prompt.tokens` 不是合法非负数时整组记 `invalid`，窗口、轮数与 parts 一并留空——没有分母的比例不能单独拿出去当事实。

`LedgerShape` 与 `RouteShape` 随字段一起返回，供投影层判断完整性。

## Decision：一个来源投影模块决定"当前事实"

`src/sources/projection.ts` 把 `request_evidence` 的每一行重读成准备态证据，再决定哪一族列可以写。它只读 `request_evidence`，不读 `request` 现有列——旧列是历史保留，不是输入。

**完整与部分的分界。** 账本族只有在全部 ref 都是 present、且尝试指纹互不相同时才 complete；任一条过期或读不懂是 partial / invalid，同物理证据出现相同尝试指纹是 duplicate。partial、duplicate、invalid 一律不重算最终值与尝试合计，旧列原样保留。

**重复尝试指纹。** 判重不看 ref 也不同时看全部字段：`tMs`、归一响应 id、`handed_on`、状态、停止原因、四类 token、模型三列、provider、错误类型与原话一起入指纹。同一行被两条物理证据指到，是重复记账嫌疑，不是两次尝试。

**pending_final 与 failed 的差别。** 两者都来自最终尝试行，差别在"这笔结束了吗"：`handed_on=1` 或 status 缺失说明上游还没交最终结果，写 `pending_final` 且不发布行级最终事实；status 存在且 ≥400 才是 failed，照常写行级事实与 500 类状态。顺序不可证时也写 `pending_final`——不发布 final 与"最终失败了"是两件事。

**顺序与合计分开。** 同毫秒只在同一账本代际内用 byte offset 证明先后；跨代际的同毫秒、route_id、hook UUID 都不证明尝试顺序。顺序不可证时 `selected` 为 null、族状态 conflict、原因带 `attempt_order_unprovable`，但尝试合计（次数、token、起点）与顺序无关，照常发布。

**Prompt 只认最新一条 route。** 最大 `time_ms` 唯一时才有一条"当前" route；两条同毫秒的 route 无法证明哪条是当前尝试，族状态 conflict 且不写列。该 route 的 Prompt 缺失、非法或 counted 非法时旧整族作为历史保留、`current=false`、原因带 `prompt_retained`；`current` 是读者判断"这列是不是新事实"的唯一依据。

**hook 报告的集合语义。** hook 报告只给 `raw_hook` 的 model 与 success 去重集合，不选单条、不按到达或时间覆盖；多模型或多成功态即 conflict。它与账本完全独立：只有 hook 证据时 `selected` 仍为 null，模型列不被 hook 顶替。

**历史保留政策。** 任何后到的 invalid、absent、expired、partial、conflict、duplicate 都不清空旧列，只把该族 `current` 置 false 并写原因；`unprovable` 是唯一例外——顺序不可证时清空排序键与响应身份，因为留着它们等于声称知道顺序。

`request.req_kind`、长期版本列与 `projection_meta` 不在这里写；kind、hook 与 nativeSession 只返回给调用方。长期落库由[来源事实有界落盘](2026-10-22-bounded-source-facts-and-provenance.md)的 `source_facts_json` 与 `projection_meta_json` 承载。

## Decision：在线写入只经过同一个投影入口

`src/reconcile.ts` 的账本与路由写入不再各自拼聚合 SQL。`src/sources/raw.ts` 只负责把已准备字段写进 raw 层（`insertPreparedLedgerTx`、`upsertPreparedRouteTx`），行级事实一律由 `projectRequestTx` 决定。

**脱敏先于映射。** `ingestLedger` 与 `ingestRoute` 先 `redact` 再 `mapLedgerRow` / `mapRouteRow`，raw 列、`payload_json` 与投影读到的字段都来自同一个已脱敏对象。否则列与 payload 各说一套，而 payload 会留着未脱敏副本。

**插入不预判最终值。** 新请求的 `status`、模型三列、token、耗时列与排序键先写 NULL，投影随后写入。此前插入时先拿这一行冒充最终尝试，route 还没到时读者会看到"已成功"的假象。

**归属与排序键留在写入者。** 投影只写行级事实；`applyLedgerOwnershipTx` 写会话归属、`actor`、标题与排序键，并在身份确认后入派生队列。`orderState` 决定排序键：`provable` 才写，`unprovable` 清空，`unknown`（证据不完整）保留旧键。

**路由只挂证据与归属。** `applyRouteToRequest` 只登记 `request_evidence`、写会话归属与标题，然后调一次投影取 Prompt 族。Prompt 不再由 route 到达顺序决定，同一 route 先到还是后到得到相同列。

**hook 不合成账本事实。** hook 请求插入时 `status`、`model_requested`、`model_served` 都是 NULL：`success` 是"这个 hook 观察到调用成功"，不是 HTTP 状态码；`model` 是 hook 侧看到的模型，不是 provider 侧账本读数。两者都留在 `raw_hook` 里，由 `HookProjection` 作为独立报告给出。`acceptHook` 与 `mergeHookInto` 末尾各调一次投影，合并时按目标已完整的证据重算，不迁移 hook 的 model 或 success。旧结构里写进这两列的 hook 伪值随旧库一起删除，不做原地修复：v5 起没有跨结构迁移，见[旧库删除重建](2026-10-23-destructive-schema-replacement.md)。

账号脱敏归一到同一形态：`account` 与 `providerAccount` 都是敏感键，都得到同一个 `credential` 占位符，所以同一个订阅身份在两个入口下不会看起来像两个人。`placeholder` 对已经是占位符的值原样返回，敏感键、请求头与普通字符串三处分支都调用它，重复脱敏不会把占位符再散列成另一个 digest。历史明文账号只在旧库里存在，随旧库一起丢弃；本仓库不提供逐行改写路径，可用的补救只有重建后按新规则重新采集。隐私变换版本记在 `privacy_version` 上，用来分辨一行是按哪版规则变换的，见[来源事实有界落盘](2026-10-22-bounded-source-facts-and-provenance.md)。

## Decision：读模型也按真实键名读取，读不到的键删掉

来源投影之外的读模型与正文视图同样以上游真实键为准。2026-10-23 用只读 v4 副本复核后，按下述键集读取：

- 路由首字时间读 `firstText`。`raw_route.payload_json` 的 14,679 行里 `firstText` 有 2,382 行，`first_text` 0 行；`route_summary.first_text` 此前因此恒为 NULL。摘要列与 `z.first_text` 都来自同一个 `RouteFields.firstText`，只改映射入口。
- `safeAffinity` 的键集是 `mode`、`why`、`turn`、`at`、`lastTurn`、`within`、`kept`、`cacheRead`、`cacheWrite`。真实的 affinity 对象（12,644 条）没有 `cache_read` / `cache_write`；`last` 是账号或来源身份，与 `order[].who` / `id` 同属身份，继续排除。没有证据的键不加。
- `attemptChainOf` 只读真实 tries 键：`model`、`status`、`fail`、`error`、`start`、`ms`、`ttft`、`flow`、`firstText`、`firstReasoning`、`served`、`done`、`effort`、`tierServed`、`reasoningHidden`、`queued`。`provider`、`replan`、`gone`、`earlier` 在 14,803 个尝试项里 0 次出现，删掉；`id` 是身份，`net` 与 `rest` 是嵌套透传对象（`rest.key` 含账号），整体不透出。`done` 与 `reasoningHidden` 按布尔透出，缺失保持 null。
- 工具结果的 `is_error` 在正文块里：14,817 个去重后的工具结果块中 9,012 个带该布尔，286 个为 true。它不落新列；正文 API 本来就返回原始块，页面展开消息时按需读取，只有 `true` 标“工具结果失败”，缺失不等于成功。

## Alternatives considered

**继续用 `optionalString` / `optionalNumber`。** 它们把缺失、空串与非法类型合并成 null，正是这轮要修的问题；保留它们只会让下游无法区分"上游没报"与"上游报了读不懂"。

**读错时抛错拒绝整行。** 一条类型不对的字段会让整笔来源记录被丢弃，代价远大于收益：其余字段仍然可用，读者更需要知道哪个字段没读懂，而不是整笔消失。

**保留 `requested` / `own_cost` 作为后备键。** 本机账本里这两列从未有值，后备读取只会掩盖键名错误；真正的历史兼容在迁移批次里显式处理，不在 Adapter 里静默兜底。

**`counted` 省略时写 NULL。** 省略是"未校准"这一合法状态，写 NULL 会让它看起来像"读不出"，也无法与 `invalid` 区分。

**为 `first_text`、`cache_read`、`cache_write` 保留蛇形后备键。** 这些键在真实路由与 affinity 数据里 0 次出现，后备分支只会继续掩盖键名错误；首版前不为错误键名写兼容读法。

**把键名自动做 camelCase / snake_case 或大小写归一。** 归一等于替上游猜键名，会把不同来源的同名字段混成一个量；映射在一处显式列出，读不到就是没有。

**给 `is_error` 加长期列。** 工具结果块本来就在正文里，页面按需读取即可；加列要同时改 schema、派生与迁移，首版前没有证据表明需要长期列。

**整体透出 `net` 与 `rest`。** `rest.key` 是账号或来源身份，`net` 是网络阶段耗时；整体透出越过白名单，只抽布尔或计数也无法回答当前页面要问的问题，所以都不透出。

## Consequences

- `request.model_requested` 与 `request.own_cost` 从此可能真有值；此前它们恒为 NULL，任何"这两个字段没有数据"的判断都要重新核对。
- 字段状态进到投影层的完整性判断，但不进结构化列；需要长期保留的部分走 `source_facts_json` 的有界集合，见[来源事实有界落盘](2026-10-22-bounded-source-facts-and-provenance.md)。
- 旧账本里的 `own_cost` 不再被读取。若存在只写了旧键的来源，它的自报费用会表现为 `absent`，而不是一个可疑的数值。
- 非法类型不再被静默吞掉成"没有值"，但也没有日志：状态字段是唯一出口，读它的人必须显式检查。
- 投影不写库时读不到"这列是哪一版映射算出来的"：同一列里可能并存新事实与历史保留值，读者只能看 `families.*.current` 判断。
- 新摄入的路由开始写 `route_summary.first_text`；既有摘要行不自动回填，仍为 NULL，读旧行时不能把 NULL 当成"上游没报"。
- 路由详情的 affinity 会多出 `at`、`lastTurn`、`cacheRead`、`cacheWrite`；`last` 与 `order[].who` / `id` 仍不出现在响应里。
- 尝试链响应删掉四个恒空字段（`provider`、`replan`、`gone`、`earlier`），新增 `first_text_ms`、`first_reasoning_ms`、`done`、`tier_served`、`reasoning_hidden`；消费方按新形状读取，当前仓库内只有阅读页面消费。
- `is_error` 只在展开正文消息时可见，工具配对卡不显示失败态：配对表没有这一列，也不打算为首版加列。

## Testing

`tests/magpie.test.ts` 的「账本来源字段按 req 与 cost 读取并给出类型状态」「账本旧键、空串与非法类型分开记录且都不当新值」「路由 Prompt 只在校准布尔与 tokens 合法时给出 counted」锁定读取与状态；`tests/privacy.test.ts` 的「account 别名共享占位符且已脱敏值不再散列」锁定账号归一与占位符幂等；`tests/projection.test.ts` 的十四条用例锁定完整选择、pending_final、failed、同毫秒可证与跨代际不可证、缺 req、partial 保留、duplicate 保留、后到非法 counted 保留、当前 route 缺 Prompt、同毫秒 route 冲突、kind 冲突、hook 独立与重复投影幂等；`tests/reconcile.test.ts` 的「账本 req 与 served 分别落列」「缺 req 保持 NULL」「同一脱敏对象」「部分 raw 过期」「后到非法账本行」「清空排序键」锁定账本写入路径，「路由列、payload 与长期摘要来自同一脱敏对象」「counted 布尔与合法省略」「非法 counted 不写 prompt 族」「到达顺序不改变请求事实」锁定路由写入路径；`tests/hook.test.ts` 的「hook-only 不合成 HTTP 状态」「账本缺 req 时 hook 报告独立」「success 为 false 同样不产生失败状态」「hook 证据过期」锁定 hook 与账本事实的分离。`tests/magpie.test.ts` 的「路由首字时间按 firstText 读取，旧键名不兜底」锁定首字键名；`tests/queries.test.ts` 的「affinity 按真实 camelCase 键挑选且不透出身份键」「尝试链按真实键读取并丢掉读不到的键」锁定白名单与嵌套对象边界；`tests/body-view.test.ts` 的「工具结果的 is_error 按需透出为失败标记」锁定失败标记与缺失不等于成功。上游键名以锚定检出 `开源源码@magpie-2374ffe` 的 `internal/usage/usage.go` 与 `internal/gateway/prompt.go` 为准。
