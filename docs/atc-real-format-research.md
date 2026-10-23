# 真实数据形状：v4 归档库对照

本文核对本机真实流量在 v4 库里的实际形状，以及当前代码（提交 `e3c9af0`）读这些数据时对上的键、落空的字段与仍未采用的读数。

数据来源是本机真实库的只读归档 `<dataDir>.v4-2026-10-23/trace.db`，v4 结构，2026-10-23 归档。采集时用的临时快照已删除，归档目录是权威副本；`<dataDir>` 的位置见[运维手册的数据目录](operations.md#数据目录)。代码行号按提交 `e3c9af0` 解析。

归档是一个两天窗口：`request` 10,296 笔，2026-10-21 23:13 至 2026-10-23 16:18，`raw_route` 14,679 行从 2026-10-21 00:16 起。重建后的新库从磁盘上仍在的路由文件重放回更早的行，所以"归档里没有这个键"与"上游没有这个键"不是一回事：`conv` 就是一例（见[路由层](#路由层-raw_route)）。需要判断某个键是否存在时，先看窗口。

全文只统计键名、类型、枚举与计数，不含请求正文、账号、令牌或用户路径。所有查询对归档库只读执行，正文普查只解压后取键与类型。

## 证据口径

| 等级 | 含义 | 物证 |
| --- | --- | --- |
| `实测` | 对归档库的只读查询与全量解压普查，输出只有键名、类型、枚举与计数 | `归档库@2026-10-23-v4` |
| `新库实测` | 对重建后运行库的只读查询，用来对照归档窗口之外的形状 | `运行库@2026-10-23` |
| `版本锁定` | 按提交 `e3c9af0` 读出的键名、白名单与控制流 | `源码@e3c9af0` |
| `推断` | 数据与源码合并后的读取结果，例如某列在本库恒为 NULL | — |
| `未知` | 当前证据不能判定的语义 | — |

计数随本机使用增长，引用时带归档时间。下文读取侧钉在提交 `e3c9af0`，行号按该提交解析，不是工作区 HEAD。

## 结论

真实流量与当前代码的骨架吻合：身份、尝试次数、账本三列、正文协议与分类器指纹都能对上。曾经的缺口集中在两类键名——上游 camelCase 家族的字段，以及嵌在对象里的读数；两类都已按真实键名读取，剩下的是没有消费者的读数。

| 面 | 归档库观测 | 当前代码 |
| --- | --- | --- |
| 账本身份与读数 | `req`、`served`、`model`、`status`、`err`、`tier_served`、`reasoning_hidden`、`subagent`、`providerAccount` 都有值 | 按这些键读取，费用与错误另有状态位（`src/sources/magpie.ts:250-330`） |
| 路由标量读数 | `firstText` 2,382 行，`first_text` 0 行 | 读 `firstText`（`mapRouteRow`，`src/sources/magpie.ts:356`），蛇形键不作后备 |
| 尝试链 | 真实项带 `net`、`rest`、`fixed`、`tierServed`、`firstText`、`firstReasoning`、`reasoningHidden`；`provider`/`replan`/`gone`/`earlier` 在 14,803 个尝试项里 0 次出现 | 按真实键读取（`attemptChainOf`，`src/queries.ts:742`），那四个键不读 |
| 正文协议 | `anthropic` 7,534、`chat` 564 | 两个适配器，其余标 `unsupported`（[架构设计](architecture-design.md#派生字段)） |
| 标题 | 21 条 title：回复是单键 JSON 10 条、`<title>` 标签 11 条 | 严格形状命中 21/21，非 title 行 0 命中（`src/semantics.ts:123-141`） |
| 分类器 | 1,520 条，全部 claude + `</block>` + security monitor | 三条件联合判定：`src/semantics.ts:151-185` |
| 用户输入包装 | 去重后 65 个块的首标签不在旧标签集里；另有 8,905 个提醒块不在消息开头 | 按内容块清洗，覆盖表见[语义层](#语义层) |

命名并存有一条直接后果：`route.firstText` 与账本 `first_text_ms` 是两个字段，按大小写自动归一或互相顶替会把它们并成一个（`推断`）。没被读的键逐条列在文末的[读数现状与未采用的键](#读数现状与未采用的键)，每条注明是落空、还是有意不用。

## 账本层 `raw_ledger`

10,201 行，全部是合法 JSON 对象，无重复键；行长 364–908 字节（`实测`，物证 `归档库@2026-10-23-v4`）。

| 键 | 行数 | 当前代码 |
| --- | --- | --- |
| `agent`、`cache_read`、`cache_write`、`ep`、`in`、`model`、`ms`、`out`、`provider`、`req`、`session`、`status`、`t` | 各 10,201 | 是 |
| `route_id`、`host` | 10,198 | 是 |
| `native_session` | 10,192 | 是 |
| `served`、`response_id` | 10,122 | 是 |
| `effort` | 8,985 | 是 |
| `providerAccount`（camelCase） | 8,012 | 是（`account` 回退） |
| `flow_ms`、`ttft_ms` | 7,964 | 是 |
| `stop` | 7,943 | 是 |
| `reasoning` | 6,875 | 是 |
| `first_reasoning_ms`（camelCase） | 4,427 | 否 |
| `rid` | 4,409 | 是 |
| `tier_served` | 3,305 | 是 |
| `subagent` | 3,104 | 是 |
| `own_ms`、`sent_ms` | 2,254 | 是 |
| `providerKeyId`（脱敏键） | 2,186 | 否（隐私） |
| `first_text_ms` | 1,599 | 是 |
| `credits`（integer 851、real 71） | 922 | 只落 `raw_ledger.credits`，无下游 |
| `reasoning_hidden`（true） | 459 | 是 |
| `err` | 106 | 是 |
| `tries` | 81 | 是 |
| `retried_ms` | 17 | 是 |
| `kind`（值只有 `vision`） | 9 | 是 |
| `rejected`（true） | 3 | 是（分类） |

当前代码读了、归档库却没有的键：`cost`、`err_type`、`account`、`via`、`computer`、`archive`、`handed_on`、`parent_agent`、`queued_ms`、`tier_asked`、`tier_sent`、`magpie_version`/`version`、`prompt`。账本行没有 `prompt` 对象，`mapLedgerRow` 的 `prompt.tries` 回退在归档窗口里不会触发（`实测` + `版本锁定`，`src/sources/magpie.ts:255`、`:317`、`:319`；[来源字段保真](../.agents/notes/implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md)）。

状态分布：200 有 10,103 行，499 有 95 行，404 与 429 合计 3 行。那 3 行的 `provider` 是空串，也正好是 3 条 `rejected: true` 行；其余 95 条 499 行的 `provider` 非空。`classifyLedger` 的第二判据（provider 为空且 status ≥ 400）只命中这 3 行，与显式 `rejected` 重合，最终分类仍是 through 10,198、hook 95、rejected 3（`实测` + `版本锁定`，`src/sources/magpie.ts:243-248`）。

时间字段 `t` 全部是 28–32 字符的 ISO 串，偏移一律 `+08:00`，没有 `Z`，也没有纯 epoch。`route_id` 在账本里恰好一行：10,198 个非空 `route_id` 的计数全为 1。`stop` 缺失 2,258 行，占 22%（`实测`）。

费用侧：账本 `cost` 键 0 行，`own_cost` 列 0 非空，`credits` 有 922 行。`request.cost` 与 `attempt_cost` 由 `cost_observation` 回填，归档库里有 priced 3,902、zero 1,725、unpriced 4,560、absent 109；它们是费用 API 的读数，不是账本键（`实测`，口径见[架构设计的缺失与健康](architecture-design.md#缺失与健康)）。归档库的 `request.prompt_counted` 全为 NULL，而 payload 里 `prompt.counted` 有 14,551 行 true：这一列是 v4 的派生结果，不是 payload 事实（`实测`）。

## 路由层 `raw_route`

14,679 行，行长 1,304–9,423 字节，全部是合法 JSON 对象，无重复键（`实测`）。

| 键 | 行数 | 当前代码 |
| --- | --- | --- |
| `agent`、`done`（true）、`id`、`model`、`ms`、`order`（array）、`prompt`（object）、`provider`、`seq`、`session`、`status`、`time`、`tries`（array） | 各 14,679 | 除 `seq` 外都读 |
| `out`、`tokens`、`usage`（array） | 14,551 | `out`、`tokens` 读；`usage` 不读 |
| `served` | 14,548 | 是 |
| `group`（object） | 14,021 | 否 |
| `folder` | 13,006 | 是 |
| `affinity`（object） | 12,644 | 原样存，详情按白名单投影 |
| `effort` | 11,354 | 是 |
| `flow`、`ttft` | 11,319 | 是 |
| `reasoning` | 9,463 | 是 |
| `firstReasoning`（camelCase） | 5,953 | 否 |
| `sub`、`subagentId` | 3,362 | `subagentId` 是（`sub` 是别名） |
| `own`、`sent` | 3,359 | 否 |
| `firstText`（camelCase） | 2,382 | 是（`src/sources/magpie.ts:356`） |
| `reasoningHidden`（camelCase） | 582 | 否 |
| `error` | 140 | 是 |
| `retried` | 25 | 否 |
| `for`（object）、`kind`（值只有 `vision`） | 各 14 | 是 |

当前代码读了、归档库却没有的键：`first_text`、`magpie_version`/`version`。`raw_route.first_text` 0 非空（`实测` + `版本锁定`，`src/sources/magpie.ts:356`、`:369`）。

`conv` 要看窗口：归档的 14,679 行里 0 行，但重建后的运行库有 16,054 行带 `conv`（`新库实测`）。差别不是上游没有这个键，而是 omp 侧改过字段：运行库里带 `conv` 的 16,022 行 omp 路由集中在 2026-10-12 17:39 至 2026-10-20 14:16，同在这一侧的约 2,470 行 omp 路由则带 `session`，最新一笔到 2026-10-23，两批互斥（`conv` 行与 `session` 行数相加等于 omp 路由总数）。`applyRouteOwnershipTx` 只在 `session` 缺失时才用 `conv` 建会话键（`src/reconcile.ts:261`），运行库里 `conv_source='conv'` 的请求有 16,110 笔，全部来自那批更早的行——分支在用，不是死代码（`新库实测` + `版本锁定`）。

嵌套形状：

| 嵌套 | 真实键与计数 | 当前代码 |
| --- | --- | --- |
| `prompt{}` | `parts`、`tokens`、`turns`、`window` 各 14,679；`counted` true 14,551 | 全部读；`safePrompt` 丢了 `turns` 与 `parts[].items`（`src/queries.ts:699-715`） |
| `prompt.parts[]` | 长度 1 → 1、2 → 3,342、3 → 73、4 → 84、5 → 330、6 → 10,849；每项 `{kind,tokens,items[]}` | 原样存 JSON；详情只取 `kind`+`tokens`，`items` 不出 |
| `prompt.parts[].kind` | `chat` 14,679、`system` 14,678、`tools` 11,322、`memory` 11,263、`results` 11,153、`files` 10,889 | 按字符串原样读出 |
| `tries[]` 长度 | 1 → 14,575、2 → 86、3 → 16、4 → 2 | 长度用于 `attempt_count` |
| `tries[0]` 标量 | `done`、`id`、`model`、`ms`、`start`、`status` 14,679；`served` 14,471；`effort` 13,121；`flow`、`ttft` 11,242 | 读 `model`、`effort`、`status`、`start`、`ms`、`ttft`、`flow`、`served` |
| `tries[0]` 真实读数 | `firstReasoning` 5,898、`net` 4,300、`tierServed` 3,467、`fixed` 2,710、`firstText` 2,359、`reasoningHidden` 580、`error`/`fail` 241、`rest` 108、`again` 3 | 读 `firstReasoning`、`tierServed`、`firstText`、`reasoningHidden`、`queued`、`done`；`net`、`rest`、`fixed`、`again`、`id` 不透出（`attemptChainOf`，`src/queries.ts:742`） |
| `tries[].net{}` | `asks` 4,300、`reused` 4,185；`send`/`own`/`wait`/`head`/`pool`/`connect`/`tls`/`dns` 为 int/real 混用；`before` 4 | 不读；随 `tries_json` 原样保留 |
| `tries[].rest{}` | `by`、`key`、`status`、`until`、`why` 各 108；`failures` 91 | 不读；原样保留 |
| `usage[]` | 长度 1 → 14,551，缺失 128；`usage[0]` 的 `in`、`model`、`out`、`provider` 各 14,551，`cache_read` 14,276，`reasoning` 9,463 | 不读 |
| `group{}` | `affinity`、`id`、`members`、`name`、`routing` 各 14,021；`ref` 9,348；`auto` 1,377；`sink` 833 | 不读 |
| `affinity{}` | `at`、`mode`、`turn`、`why` 各 12,644；`last`、`lastTurn` 各 12,558；`kept` 12,400；`cacheRead` 12,383；`within` 8,931；`cacheWrite` 175 | 原样存；详情白名单是 `mode`、`why`、`turn`、`at`、`lastTurn`、`within`、`kept`、`cacheRead`、`cacheWrite`（`safeAffinity`，`src/queries.ts:687`）；`last` 是账号或来源身份，排除 |
| `order[]` 长度 | 1 → 2,035、3 → 833、6 → 515、7 → 2,654、8 → 4,409、9 → 819、10 → 3,414 | 详情白名单只取 12 个标量（`src/queries.ts:671-683`） |
| `order[0]` 键 | `icon`、`id`、`kind`、`model`、`name`、`provider`、`routing` 各 14,679；`who` 11,583；`agent`、`plan` 11,193；`known`、`pace` 11,178；`renews` 9,944；`used` 9,464；`limit`、`unit` 6,452；`due`、`usedRenews` 5,744；`amount` 5,153、`shared` 1,873、`rank` 1,855；`sunk` 561、`turn` 87、`rest` 5 | 白名单去掉 `who`/`id`（隐私，见[隐私边界](../.agents/notes/implemented/architecture/2026-10-20-privacy-and-local-access-boundary.md)）；白名单里的 `fast`/`fallback` 在真实数据 0 行；`amount`/`pace`/`due`/`rank`/`renews` 未透出 |

路由状态：200 有 14,548 行，499 有 131 行。`prompt.counted` 缺失 128 行，其中 123 行是 499、5 行是 200；499 行的 `prompt` 也不完整，当前代码按 `prompt_absent`/`invalid` 处理（`实测` + `版本锁定`）。

`usage[]` 与顶层不是同一份读数：`usage[0].model` 与顶层 `model` 在 14,551 行里全部不同，`usage[0].provider` 与顶层 `provider` 有 9,100 行不同。哪一层是"最终服务方"的权威，当前证据不能判定（`实测`；语义 `未知`）。

`affinity.last` 的值域只有 13 个，载荷本身不能说明它标识什么；`safeAffinity` 不投影它（`实测`；语义 `未知`）。

## 正文层

`sqlite_master` 形状：`request.skeleton_z` 是 zstd 压缩的 `{format, protocol, request_without_messages, reply, redact_version, has_messages}`；`block.z` 按消息存；`request_block(req_id, ord, role, block)` 引用。正文只来自 hook，归档库的 `raw_hook.request_z`/`response_z` 8,098 行全为 NULL，元数据仍在（`实测`）。

| 项 | 实测 |
| --- | --- |
| 协议 | `anthropic` 7,534（agent 全是 claude）、`chat` 564（agent 全是 omp）；无第三值 |
| 骨架键集合 | 只有一种：`format`、`has_messages`、`protocol`、`redact_version`、`reply`、`request_without_messages` |
| 请求顶层键集合 | 7 种；anthropic 侧带 `context_management`/`max_tokens`/`metadata`/`output_config`/`stream`/`system`/`thinking`/`tools`，chat 侧带 `max_completion_tokens`/`reasoning_effort`/`store`/`stream`/`stream_options`/`tools`/`tool_choice`/`temperature` |
| 回复形状 | `{content[], id, model, role, stop_reason, stop_sequence, type, usage}` 7,450；`{choices[], created, id, model, object, usage}` 555；`null` 93 |
| 响应 id 前缀 | `msg_*` 7,450、`chatcmpl-*` 555 |
| `stop_reason` | anthropic `tool_use` 4,976、`end_turn` 2,434、`max_tokens` 40；chat `tool_calls` 527、`stop` 27、`length` 1 |
| usage 键 | anthropic 4 个；chat 5 个（`prompt_tokens`、`completion_tokens`、`total_tokens` 与两个 `*_details`） |

消息块共 26,700 条消息、719,490 条引用。块类型：`text` 65,999、`tool_result` 14,817、`tool_use` 14,698、`thinking` 8,386、`image_url` 29、`image` 2。块键形状只有 11 种，和当前代码认识的 `text`/`thinking`/`tool_use`/`tool_result` 对得上，另外多出 `image_url` 与 `image`（`实测`）。

`tool_result` 里 `is_error` 键出现 9,012 次，其中 true 286、false 8,726；`content` 是字符串 14,600、数组 217。`tool_use.input` 14,698 个全部是对象。`content` 为字符串的消息 1,696 条（system 243、user 46、assistant 650、tool 757），tool 消息的键固定为 `{content, role, tool_call_id}` 757/757。`ToolResultView` 只有 `id/ord/path/value`（`src/protocols.ts:17`），配对表没有失败位；失败标记由正文视图按需读 `is_error`，只有 `true` 才标（`web/body-view.js`；`实测` + `版本锁定`）。

完整性检查全部 0 例外：悬挂引用 0、`msg_count` 与引用数不符 0、序号不连续 0、孤儿块 0；14,812 个块被多个请求共享。`msg_count` 1–576，块裸长最大 426,919 字节，`block.z` 压缩总量 101,343,172 字节，骨架 486–80,126 字节。hook 的 `request_bytes` 1,971–2,347,335，距离 32 MiB 单体上限与 64 MiB 信封上限很远（`实测` + `版本锁定`，`src/hook.ts:63-76`）。

## 语义层

| 维度 | 实测分布 |
| --- | --- |
| `agent` | claude 9,541、omp 755；与协议一一对应 |
| `via` | through 10,198、hook 95、rejected 3 |
| `stop` | `tool_calls` 6,470、`stop` 855、`completed` 616、`length` 2、缺失 2,353 |
| `conv_source` / `actor_state` | 100% `session`；known 10,201 / unknown 95（95 条是 hook-only） |
| `req_kind` | chat 10,275、title 21 |
| `chain_role` | main 6,103、branch 4,172、aux 21 |
| `reply_state` | ok 8,005、absent 93、未派生 2,198 |
| `parse_state` | ok 8,098、未派生 2,198 |

分类器强指纹（agent=claude ∧ system 含 security monitor 标记 ∧ `stop_sequences` 含 `</block>`）命中 1,520 条，全部 `msg_count=2`；带 `</block>` 的请求也正好是这 1,520 条，没有 agent 非 claude 的样本（`实测`）。

标题判定在归档库里有 21 条 title：10 条 claude 回复是单键 `{"title":…}`，11 条 omp 回复是整段 `<title>` 标签，其中 4 条的标签带属性。当前代码的严格形状（`^<title\b[^>]*>…</title>$` 或单键 JSON）对全部 21 条命中，对任何非 title 行 0 命中；那 4 条带属性的请求里共用一个 `<title-request>` 去重块。`src/input-interpretation.ts:194` 会把 `<title-request>` 标成 `title_request`，但这个 kind 没有消费者，标题判定落在回复形状上（`实测` + `版本锁定`，`src/semantics.ts:123-141`；[Title Generator 与主链分离](../.agents/notes/implemented/feature/2026-10-21-title-generator-and-main-chain.md)）。

用户消息首包装标签，按 (agent, 块) 去重、取每个块首个文本块的首标签，共 2,875 个有文本的用户块：

| agent | 标签与计数 |
| --- | --- |
| claude | `transcript` 1,829、`system-reminder` 145、`session` 9、`pasted_content` 6、`command-message` 6、`local-command-caveat` 1；非标签标记 skill-injection 34、midturn-prefix 3、stepped-away 1；plain 703 |
| omp | `job` 50、`system-notice` 31、`system-reminder` 17、`chat` 5、`recap` 3、`user` 2、`file` 2、`title-request` 1；plain 27 |

同一批数据按**出现次数**数得到另一组数字：用户角色的文本块共 103,942 个，其中带包装的在下面。两组都对，差别在去重还是计次——一条粘贴在后续每一笔请求的历史里都会重现，所以去重后只有几个，计次是几百个。

| 项 | 出现次数 | 位置特征 |
| --- | --- | --- |
| `system-reminder` | 19,758 | 8,905 个不在消息的第一个块 |
| `system-notice` | 1,947 | 全部在第一个块 |
| `local-command-caveat` / `local-command-stdout` | 830 / 765 | 804 / 765 个不在第一个块 |
| `command-name` / `command-message` | 765 / 161 | 与命令回显链在同一块内 |
| `job` / `file` / `chat` | 53 / 64 / 5 | `job` 的规格之后紧跟用户的话；`file` 独占整条消息，块长 p50 12 KB |
| `pasted_content` 开标签 / 闭标签 | 248 / 343 个块（321 条消息带闭标签） | 闭标签带属性；248 条消息里开闭同现，闭标签落在后续块 |
| `transcript` 开标签 / 闭标签 | 1,872 / 1,911 | 1,872 条有开块的消息全部在同一条消息里带闭块 |

按消息级拼接后送进解释器，归档里 2,820 条用户消息的可见输入带着整段 `system-reminder`；改成按块清洗后 1,992 条消息的可见文本变化，64 个附件块与 5 个简报块整段丢弃。规则与实测结果见[输入包装按内容块清洗](../.agents/notes/implemented/bug-fix/2026-10-23-input-wrapper-blocks.md)，标签表在[架构设计的输入解释](architecture-design.md#输入解释与能力阅读)；实际覆盖的标签是 `system-reminder`、`transcript`、`local-command-*`、`system-notice`、`recap`、`job`、`file`、`chat`（整段丢弃），`session`、`user`（剥壳留内容）与 `<pasted_content id=…>`（只删标记行）。

## 异常面

| 检查 | 结果 |
| --- | --- |
| JSON 合法性 | 账本 10,201/10,201、路由 14,679/14,679 全部合法；块与骨架全部可解压可解析；`ingest_issue` 0 行 |
| 重复键 | 账本与路由的对象内同名键 0 |
| 空串与缺失 | 空串只有账本 `provider` 3 行；`stop` 缺失 2,258 行；回复 null 93 行；无正文的请求 2,198 行 |
| 键名大小写 | 两套并存：`providerAccount`、`providerKeyId`、`subagentId`、`firstText`、`firstReasoning`、`reasoningHidden`、`tierServed`、`cacheRead`、`lastTurn`、`usedRenews`；同一层里 snake_case 与 camelCase 混用：`usage[].cache_read`、`affinity.cacheRead`、`tries[0].tierServed` |
| 同义异名 | `response_id`/`responseId`、`sub`/`subagentId`、`first_text`/`firstText`、`out`/`out_tok`；顶层 `tokens` 与 `usage[0].in` 在 14,551 行全部不同，而 `out` 与 `usage[0].out`、`reasoning` 与 `usage[0].reasoning` 一致 |
| 类型 | 布尔出现在 `done`、`counted`、`kept`、`within`、`reasoning_hidden`、`rejected`、`reused`、`known`、`shared`、`auto`、`sink`、`turn`；`credits`、`used`、`amount` 有 int 与 real 两种表示；`status` 全为 integer |
| 时间 | 全部 ISO8601 带偏移，28–32 字符、有小数秒、无 `Z`、无纯数字 |
| 超大载荷 | 账本 908 B、路由 9,423 B、骨架 80,126 B、块 426,919 B、hook 请求 2,347,335 B；均低于 32 MiB/64 MiB 阈值 |

## 读数现状与未采用的键

下表只回答每个读数落在哪条读取路径、当前拿到什么，不含执行顺序。

| 读取路径 | 归档库事实 | 当前代码 | 等级 |
| --- | --- | --- | --- |
| 路由首字时间（`raw_route.first_text`、`route_summary.first_text`） | `firstText` 2,382 行，`first_text` 0 行 | `mapRouteRow` 读 `firstText`（`src/sources/magpie.ts:356`）；归档里的旧行与既有摘要仍为 NULL，页面另有账本 `first_text_ms`（`web/app.js:1151`） | `实测` + `版本锁定` |
| 亲和缓存读数 | `cacheRead` 12,383、`cacheWrite` 175 | 白名单含 `cacheRead`/`cacheWrite`（`safeAffinity`，`src/queries.ts:687`） | `实测` + `版本锁定` |
| 亲和上下文 | `at` 12,644、`lastTurn` 12,558；`last` 12,558，值域 13 | `at`、`lastTurn` 进白名单；`last` 是身份，排除且语义未定 | `实测`；语义 `未知` |
| 尝试链 | `tries[]` 没有 `provider`/`replan`/`gone`/`earlier`；有 `served` 14,471、`tierServed` 3,467、`firstText` 2,359、`firstReasoning` 5,898、`queued` 3 | `attemptChainOf` 读真实键（`src/queries.ts:742`），`net`/`rest`/`fixed`/`again`/`id` 不透出 | `实测` + `版本锁定` |
| 工具失败 | `is_error` 键 9,012，其中 true 286 | 配对表没有失败位；正文视图按需读该布尔，只有 `true` 标失败（`web/body-view.js`） | `实测` + `版本锁定` |
| 账本思考首字 | `first_reasoning_ms` 4,427 | 未采用：账本段无此列，`mapLedgerRow` 不读，页面也没有消费方 | `实测` + `版本锁定` |
| 路由用量 | `usage[]` 14,551；`usage[0].model` 与顶层 `model` 全部不同，`usage[0].provider` 与顶层 `provider` 9,100 行不同 | 未采用：不读；顶层 `provider` 不等于实际服务方 | `实测`；哪层权威 `未知` |
| 路由组 | `group{}` 14,021，含 `affinity`、`id`、`members`、`name`、`routing`、`ref`、`auto`、`sink` | 未采用：不读，会话归属走 `session`/`conv`/`request` 三级回退 | `实测`；语义 `未知` |
| 自报费用 | `credits` 922；账本 `cost` 键 0 行 | `credits` 落 `raw_ledger.credits`，无下游；`request.cost` 由 `cost_observation` 填（priced 3,902、zero 1,725） | `实测` |
| 路由 `conv` | 归档 0 行；运行库 16,054 行（omp 2026-10-20 前） | `applyRouteOwnershipTx` 的 conv 分支（`src/reconcile.ts:261`）在 `session` 缺失时使用，运行库有 16,110 笔请求走它 | `实测` + `新库实测` |
| 路由详情 prompt | `prompt.turns` 14,679 | `safePrompt` 只出 `tokens/counted/window/held/parts`（`src/queries.ts:699-715`），丢 `turns` 与 `parts[].items`；`request.prompt_turns` 另有 10,198 行 | `实测` + `版本锁定` |
| 用户输入包装 | 去重后 65 个块的首标签不在旧标签集里；8,905 个提醒块不在消息开头 | 按内容块清洗：丢弃 8 类整段包装，剥 `session`/`user` 的壳，只删粘贴标记；未知标签原样保留 | `实测` + `版本锁定` |
| 分类器 | 1,520 条，全部 `msg_count=2` | 三条件联合判定覆盖；`msg_count` 只作信号，不作门槛（`src/semantics.ts:151-185`） | `实测` + `版本锁定` |
| 标题 | 21 条：10 条 JSON 回复、11 条 `<title>` 回复（4 条带属性） | 严格回复形状 21/21 命中，非 title 行 0 命中；输入侧 `title_request` 没有消费者 | `实测` + `版本锁定` |

## 复核方式

数据库始终只读打开：

```sh
sqlite3 "file:<dataDir>.v4-2026-10-23/trace.db?mode=ro"
```

账本键分布：

```sql
WITH k AS (SELECT j.key AS key, j.type AS t, count(*) AS n
  FROM raw_ledger, json_each(raw_ledger.payload_json) j GROUP BY j.key, j.type)
SELECT key, group_concat(t||':'||n, ' | ') FROM k GROUP BY key ORDER BY sum(n) DESC;
```

路由键与嵌套（把路径换成 `$.prompt`、`$.prompt.parts[0]`、`$.tries[0]`、`$.tries[0].net`、`$.tries[0].rest`、`$.usage[0]`、`$.group`、`$.affinity`、`$.order[0]`）：

```sql
SELECT j.key, j.type, count(*) FROM raw_route, json_each(raw_route.payload_json) j GROUP BY 1,2 ORDER BY 3 DESC;
SELECT j.key, j.type, count(*) FROM raw_route, json_each(raw_route.payload_json,'$.prompt') j GROUP BY 1,2;
```

缺失键、单位与尝试分布：

```sql
SELECT count(route_id), count(conv), count(first_text), count(magpie_version) FROM raw_route;
SELECT count(*), count(own_cost), count(credits), count(first_text_ms) FROM raw_ledger;
SELECT key, count(*) FROM raw_ledger, json_each(raw_ledger.payload_json)
WHERE key IN ('account','via','cost','err_type','parent_agent','queued_ms','handed_on','first_reasoning_ms')
GROUP BY key;
SELECT cnt, count(*) FROM (SELECT route_id, count(*) cnt FROM raw_ledger
  WHERE route_id IS NOT NULL GROUP BY 1) GROUP BY 1 ORDER BY 1;
SELECT json_array_length(json_extract(payload_json,'$.tries')), count(*) FROM raw_route GROUP BY 1 ORDER BY 1;
```

正文完整性：

```sql
SELECT count(*) FROM request_block rb LEFT JOIN block b ON b.id=rb.block WHERE b.id IS NULL;
SELECT count(*) FROM request r WHERE r.msg_count IS NOT NULL
  AND (SELECT count(*) FROM request_block rb WHERE rb.req_id=r.req_id)<>r.msg_count;
SELECT count(*) FROM (SELECT req_id,count(*) c,max(ord) m,min(ord) mn FROM request_block
  GROUP BY req_id HAVING c<>m+1 OR mn<>0);
SELECT count(*) FROM block b LEFT JOIN request_block rb ON rb.block=b.id WHERE rb.block IS NULL;
```

协议与回复形状普查（全量解压，只打印计数）：

```sh
sqlite3 "file:<dataDir>.v4-2026-10-23/trace.db?mode=ro" \
  "select hex(skeleton_z) from request where skeleton_z is not null order by req_id" \
| python3 -I -c '
import sys, json, collections
from compression import zstd
proto = collections.Counter(); reply = collections.Counter()
for line in sys.stdin:
    obj = json.loads(zstd.decompress(bytes.fromhex(line.strip())))
    proto[obj.get("protocol")] += 1
    reply["null" if obj.get("reply") is None else "object"] += 1
print(dict(proto), dict(reply))
'
```

块类型与工具失败：

```sh
sqlite3 "file:<dataDir>.v4-2026-10-23/trace.db?mode=ro" \
  "select hex(z) from block order by id" \
| python3 -I -c '
import sys, json, collections
from compression import zstd
kinds = collections.Counter(); err = collections.Counter()
for line in sys.stdin:
    msg = json.loads(zstd.decompress(bytes.fromhex(line.strip())))
    content = msg.get("content")
    for block in content if isinstance(content, list) else []:
        kinds[block.get("type")] += 1
        if block.get("type") == "tool_result" and "is_error" in block:
            err[str(block["is_error"]).lower()] += 1
print(dict(kinds), dict(err))
'
```

分类器与标题形状（对全量骨架重算）：

```sh
sqlite3 "file:<dataDir>.v4-2026-10-23/trace.db?mode=ro" \
  "select agent || char(124) || hex(skeleton_z) from request where skeleton_z is not null" \
| python3 -I -c '
import sys, json, re, collections
from compression import zstd
tag = re.compile(r"^<title\b[^>]*>([\s\S]*?)</title>\s*$", re.I)
cls = 0; shapes = collections.Counter()
for line in sys.stdin:
    agent, hexed = line.rstrip("\n").split("|", 1)
    obj = json.loads(zstd.decompress(bytes.fromhex(hexed)))
    req = obj.get("request_without_messages") or {}
    system = req.get("system")
    text = system if isinstance(system, str) else " ".join(
        b.get("text", "") for b in system or [] if isinstance(b, dict))
    if agent == "claude" and "security monitor for autonomous ai coding agents" in text.lower() \
            and "</block>" in (req.get("stop_sequences") or []):
        cls += 1
    reply = obj.get("reply"); texts = []
    if isinstance(reply, dict):
        for b in reply.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "text": texts.append(b.get("text") or "")
        for ch in reply.get("choices") or []:
            c = (ch.get("message") or {}).get("content")
            if isinstance(c, str): texts.append(c)
    s = "\n".join(texts).strip()
    if s:
        if tag.match(s): shapes["tag"] += 1
        elif s.startswith("{"):
            try:
                v = json.loads(s); shapes["json" if list(v) == ["title"] else "json-other"] += 1
            except Exception: shapes["json-bad"] += 1
print(cls, dict(shapes))
'
```

用户包装层有两种口径，都只看角色与标签名：去重口径按 `request_block.role=0` 取每个块的第一个文本块首标签，按 (agent, block id) 去重；计次口径把每条用户消息的全部文本块用换行拼接后逐块取首标签。开闭标签要在拼接后的全文里配对，只按块看会把跨块的 `<transcript>` 与带属性的 `</pasted_content …>` 误判成未闭合，算出来的"开块多、闭块少"是假的。

跨窗口对照（`conv` 一类只在归档窗口外出现的键，对重建后的运行库跑）：

```sql
SELECT agent,
  sum(json_type(payload_json,'$.conv')    IS NOT NULL) AS has_conv,
  sum(json_type(payload_json,'$.session') IS NOT NULL) AS has_session,
  count(*) FROM raw_route GROUP BY agent;
SELECT conv_source, agent, count(*) FROM request GROUP BY 1,2 ORDER BY 3 DESC;
```
