# Agent Note: 字段保真优先——与 magpie 对标的缺口收敛路线

Status: proposed

本提案作为字段缺口与对标问题的输入材料保留；下一轮统筹范围与顺序见[架构演进方案 v2](../../../../docs/architecture-evolution-v2.md)，来源、回填和隐私方面的事实修正见[联合评审](../../../../docs/agent-request-kind-review.md#与字段保真方案的联合评估)。键名与类型状态的已交付决定见[来源字段按上游真实键读取](../../implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md)。本文尚未修订的列集合、重算方式与验收不直接作为执行依据。

## Problem

对标问题的提法是「magpie 有哪些小特性值得搬进 agent-trace-collector」，重点在它对每个 Agent 的兼容性、上下文管理与追踪记录。逐条核对两条仓库的源码与本机 trace 库之后，结论与提法不同：ATC 这条链上最缺的不是新的数据源，而是**已经采到却读错、或采到却没上浮的字段**。

两类缺口在结构上同源：账本的采集层（`raw_ledger`、`raw_route`）与请求层（`request`、`route_summary`）之间没有一条字段保真的契约——采集层按 magpie 的真实 JSON 键写入，映射层按记忆中的键名读取，读不到的键就静默落成 NULL，页面再把 NULL 解释成「本地估计」「无此数据」。于是同一个事实存在三种说法，且没有一处报错。这类失效不会让测试失败，只会让读数看起来完整。

具体形态有三：

- 键名与类型读错。`requested`（magpie 的 tag 是 `req`）、`own_cost`（tag 是 `cost`）读不到；`prompt.counted` 是布尔却被当数字读，落在 `prompt_counted` 上永远是 NULL。
- 采集了但停在 raw 层。`effort`、`native_session`、`host`、`account`、`tier_served` 都在 `raw_ledger` 里，`request` 表没有对应列，页面也从不读。按本机只读计数（采集@2026-10-22，`raw_ledger` 1703 行）：`effort` 1669、`native_session` 1702、`host` 1701、`account` 1463、`tier_served` 152。
- 采集层确实缺的只有 `compaction`/`compact_ms`、`upstream`,以及只经 magpie API 提供的 direct 行。

同时发现了三处会误导后续判断的既有事实：折叠行的上下文组成按一套与 magpie 不同的 part 名映射颜色，token 占比最大的三类正好落在这套映射之外；请求分页实际追加的是更晚的请求，按钮与注释却写「更早」；`docs/project-overview.md` 说 direct 行来自各 Agent 的会话文件并写在账本里，与 magpie 源码不符（direct 行只在内存里生成，靠 API 提供）。

现在补缝成本最低：首版 tag 之前，`request` 与 `route_summary` 还没有别的消费者，键名映射、part 口径与列集合可以一次定对；等这些契约冻结后再补，代价是迁移路径与兼容分支。

## 对标锚点与证据等级

证据等级沿用本仓库的用法：`实测`（本机 trace 库只读查询或逐行核对当前工作树）、`版本锁定`（锚定提交的源码，引用带 file:line）、`推断`、`未知`。

- magpie `2374ffe161439b02a8e7f23b793461b39a635bf8`；agent-trace-collector `a9df065c92de5f986602be2a1b0fa402c328f14e`。
- 本轮为只读调研：两条仓库都没有改动，本文引用的本机数字都来自只读连接，未复制请求正文、账号或令牌。
- 数字随本机使用增长，引用时带采集时间；`未知` 的项在落地前需要补一次实测。

## 实测缺口

### 读错的字段

| 字段 | ATC 侧 | magpie 侧 | 实测 | 等级 |
|---|---|---|---|---|
| `prompt_counted` | `src/sources/magpie.ts:238` 用 `optionalNumber(prompt,'counted')` | `Counted bool json:"counted,omitempty"`（`internal/gateway/prompt.go:48`） | `request.prompt_counted` 非空 0 / 1659；payload 里 `"counted"` 键出现 0 次 | 版本锁定 + 实测 |
| `model_requested` | `magpie.ts:164` 读 `row.requested` | tag 是 `req`（`internal/usage/usage.go:56`） | `raw_ledger.requested` 非空 0；`SUM(request.model_requested = raw_ledger.model) = 1639`，而 `= json_extract(payload_json,'$.req')` 为 0 | 版本锁定 + 实测 |
| `own_cost` | `magpie.ts:199` 读 `own_cost`/`ownCost` | tag 是 `cost`（`usage.go:198`） | `raw_ledger.own_cost` 非空 0 | 版本锁定 + 实测 |
| vendor 错误文本 | `magpie.ts:194` 只映射 `err_type` | `Error json:"err"`（`usage.go:136`）与 `ErrType json:"err_type"`（`:137`）是两个字段 | `raw_ledger.err_type` 非空 0 / 1703，而 vendor 原话在 payload 的 `err` 里 | 版本锁定 + 实测 |
| 列表状态标记 | `src/queries.ts:167` 恒返回 `[]` | — | 页面的失败/缺正文/待确认三个状态点已写好（`web/app.js:414-417`），永远不亮 | 实测 |

键名读错的后果不是「少一个字段」，而是**「请求模型 vs 实际去向」这条主线失真**：`model_requested` 现在实际取自账本的 `model`（`src/reconcile.ts:275-300` 的兜底链 `final?.model ?? final?.requested`），等于把「实际服务的模型」当成「请求的模型」，中间的改写、换模型、分组路由全部看不见。

`err` 的补映射必须取**已脱敏**的那份 payload：账本落库前已过 `redact`（`src/reconcile.ts:467`），从改写后的 payload 取才不会引入新的泄漏路径。

### 已在 raw 层、未进 `request` 或未进页面

| 字段 | 采集位置 | 上浮状态 | 实测（采集@2026-10-22） |
|---|---|---|---|
| `effort` | `raw_ledger.effort`（`src/schema.sql:33`） | `request` 无此列 | 非空 1669 |
| `native_session` | `raw_ledger.native_session`（`:36`） | `request` 无此列 | 非空 1702 |
| `host` | `raw_ledger.host` | `request` 无此列 | 非空 1701。magpie 语义是「调用去了哪个 provider 端点」（`usage.go:32`），不是机器名 |
| `account` | `raw_ledger.account` | `request` 无此列 | 非空 1463 |
| `tier_served` | `raw_ledger.tier_served`（`:40`） | `request` 无此列 | 非空 152；`tier_asked`/`tier_sent` 本机 0 |
| `computer` | `raw_ledger.computer` | 不适用 | 本机 0：magpie 只在跨机转手时写（`usage.go:188`），所以「来源机器」在本地账本并不存在 |
| `stop` / `via` / `subagent` | 已在 `request` | 不在列表视图与页面 | `request.subagent` 非空 716、`parent_agent` 0；`REQUEST_COLUMNS`（`src/queries.ts:178-181`）不含 `stop`/`via`，web 全文件引用 0 处 |
| route 决策字段 | `raw_route` 存 `error/folder/kind/conv/subagent_id/for_json/effort`（`src/reconcile.ts:495-505`） | `route_summary` 只留 14 列（`src/schema.sql:81`），`z` blob 全仓无读者 | `route_summary.tries_json` 已含每次尝试的 `fail` 码、`status`、耗时与 vendor 原话（6150 行中 82 行带 fail 码），`order_json` 含候选的 provider/name/plan/kind/known 快照 |

最后一行是这份清单里最便宜的一处：失败原因与 vendor 原话**已经在库**，页面对尝试链却直接转义打印 JSON（`web/app.js:1006`）。

### 采集层确实缺的

- `compaction` / `compact_ms`：magpie 有 `Compaction *bool`（`usage.go:100-102`）与 `compact_ms`，本机 payload 无此键，`raw_ledger` 也没有对应列。
- `upstream`：magpie `usage.go:60`，`LedgerFields` 未列，本机 payload 无。
- direct 行：`internal/usage/direct.go:17-84` 只在内存里生成（`Source:"log"`），不进 `usage.jsonl`，只能从 `/v1/magpie/usage/requests?via=direct` 取；`src/sources/magpie.ts:497` 的用量同步写死 `via=through`，全仓仅此一个调用点。本机 `via` 分布：through 1311 / hook 14 / rejected 2。

### 页面与账本的口径不一致

折叠行的上下文组成用 `web/app.js:175-176` 的 `PART_NAME`/`PARTS_ORDER`（system/tools/history/user/files/other）给颜色，magpie 报的是 system/tools/memory/files/results/chat（`internal/gateway/prompt.go:31-40`）。`partColor` 对不认识的键算出 `var(--p0)`，而调色板只有 `--p1…--p6`（`web/index.html:25`）——条带拿到未定义的变量，图例退回原始英文键名。本机 parts token 分布：files 44.8M、results 39.1M、system 35.1M、chat 34.6M、tools 14.0M、memory 1.15M，占比最大的三类恰好都在映射之外。

分页方向与文案相反：`src/queries.ts:194-207` 是 `ORDER BY started_ms ASC` 加 `(started_ms, req_id) > (?, ?)` 游标，按钮写「加载更早请求」（`web/index.html:613`），注释也写反（`web/app.js:234-235`、`:548`）。现有测试只验不漏不重，不验方向。

`docs/project-overview.md` 关于 direct 行的来源与存放位置与 magpie 源码不符。

## 明确不搬的 magpie 部分

magpie 的 Agent 层里，`Field`/`Option` 表单模型（`internal/agent/agent.go:89-107`）、`Sync`/`Unwire`/`Check`/`Apply`/`Reapply`/`Keep`/`Disconnect`、CLI 安装与更新（`cliupdate.go`、`install.go`）、plugin host、WSL 写配置，全部服务于**改写别人的配置文件**。ATC 是只读观测者，搬过来会把它变成第二个配置管理器，收益为零、风险是误写用户文件。`Agent.Running` 在 Windows 恒真、`CLIs` 依赖 brew 与 npm 网络，也不可靠。

真正可借的是「身份与语义」那一薄层，且其中两条已经在本仓库有主：语义归并的口径（保留未知、不折叠）与辅助请求的判定属于 [Agent Profile 与请求类别注册表](2026-10-22-agent-request-kind-registry.md)；「一次读失败是未知、不是空」属于本仓库已有的 `have`/`miss_reason`/`parse_state` 三件套，本文只要求把它贯彻到拉取路径。

## Proposal

分四批，前两批不带新数据源。

### 批 0：按 magpie 的真实键读账本

改映射层读 `req`、`cost`、`err`，把 `counted` 当布尔标志（`true` → 已校准，`false`/缺键 → 本地估计），给列表视图接上 `flags`，把折叠行的 part 颜色与图例改成 magpie 的六个 kind。不写兼容读法：首版 tag 之前，一个错误键名的兼容分支会被永久固化。

代价要说清：`model_requested` 现在保存的是兜底来的 `model`，修好键名后它才会变成真正的 `req`。历史行因此会出现新旧口径混合，需要一次受控重算——先在库副本上按会话重算，核对「请求模型 ≠ 实际服务模型」的比例是否从 0 变成合理值，再决定对真实库执行。`prompt_counted` 的历史 NULL 则不必补：magpie 侧的 `counted` 只在 vendor 报了计数时才出现，NULL 表示未知，补不出信息。

### 批 1：一次 schema 升版把已采字段上浮

把 `effort`、`native_session`、`host`、`account`、`tier_served`（未来 `tier_asked`/`tier_sent`）与 vendor 错误文本一次加进 `request`，并把 `raw_route` 里已有的 route 决策字段（`error`、`folder`、`kind`、`effort`）折进 `route_summary` 的派生列。走仓库既定的「拒绝而非就地升级」路径，不为这一次加字段开就地改写的口子。

为什么不按字段分多次升版：升版与重算的成本不在加列，而在每次都要重跑核对；一次把同一族字段（身份、档位、来源、失败）定完，后续只做展示。代价是 `request` 与 `route_summary` 每行变大——后者是**永不回收**的元数据（见 [2026-10-20-retention-three-gates.md](../../implemented/architecture/2026-10-20-retention-three-gates.md) 的 16 GB 上限与每行约 2 KB 的估算），加列前先按真实行字节估一次年增长，超过预算就先只加 `request` 侧。

`account` 与 `err` 都带身份与正文性质，上浮前按 [2026-10-20-privacy-and-local-access-boundary.md](../../implemented/architecture/2026-10-20-privacy-and-local-access-boundary.md) 的口径确认：只从已脱敏的 payload 取，不新增未脱敏路径，不进测试与提交。

### 批 2：把已在库的信息变成能读的东西

用已在库的 `fail` 码与 vendor 原话做**尝试链人话化**：失败原因、间隔、最终去向、候选顺序，不再打印原始 JSON。magpie 侧的分类表（`internal/gui/assets/plugins/routing/client.js` 的 `FAIL`）可以照抄语义，不必照抄实现。

同时补三件读者侧的缺口：上下文占用率与健康阈值（`prompt_tokens / prompt_window`，magpie 用 75%/90% 两档，`internal/gui/assets/context.js`）、切换 tab 与选中请求时的滚动位置保持、请求 ID 与正文的一键复制。搜索从「只在已加载的会话里匹配」改成服务端全文搜索并给出命中片段。

不做实时动画流图、不做回放：ATC 是历史阅读器，动画不增加信息量。

### 批 3：direct 行另立提案

direct 只能经 API 拿，且要以 `native_session` 作为软身份键才不会把同一个调用记两次——magpie 自己在配对上给了明确态度（`internal/usage/ledger.go:367-372` 的「ID 先行，其次 native session、等 token、2s 内」，以及 `calls_dsh.go`、`calls_workbuddy.go` 里明知会双计就**放弃配对**）。因此批 3 排在批 1 之后，第一版只做「读进来、不合并」的观测态，配对规则与取消配对的判据单独评审。批 3 最重的证据来自 zcode：30 天 6,365 次调用对 ATC 库里的 56 笔，量级与实测见[zcode 的 Agent 支持](../feature/2026-10-24-zcode-agent-support.md)。

## 与现有记录的关系

**交付现状。** 批 0 的字段读法已交付：映射层按 magpie 的真实键读、`counted` 当布尔三态、折叠行的 part 颜色与列表标志接上真实值，形状见[来源投影与字段保真](../../implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md)与[账本读数溢出](../../archived/bug-fix/2026-10-21-ledger-readings-overflow.md)。批 1 没有按本文的加列清单落地：`effort`、`native_session`、`host`、`account`、`tier_asked`／`tier_sent`／`tier_served` 与 vendor 错误文本仍只在 `raw_ledger` 行上，route 决策字段也没有折进 `route_summary`——投影改用 `source_facts_json` 承载，见[有界来源事实与来源依据](../../implemented/architecture/2026-10-22-bounded-source-facts-and-provenance.md)。批 2 与批 3 未做。

本文与[Agent Profile 与请求类别注册表](2026-10-22-agent-request-kind-registry.md)的分工不变：它持有 agent 语义缝（`req_kind`/`chain_role` 的注册机制、保留未知值），本文不重写它，只要求批 1 的列集合与它的验收项不冲突。

- [2026-10-20-retention-three-gates.md](../../implemented/architecture/2026-10-20-retention-three-gates.md) 约束元数据增长与回收边界；本文的加列必须落在它的预算里。
- [2026-10-20-privacy-and-local-access-boundary.md](../../implemented/architecture/2026-10-20-privacy-and-local-access-boundary.md) 约束脱敏顺序与「真实数据不进仓库」；本文的 `err`/`account` 上浮受它约束。
- 存储形状以 [docs/architecture-design.md](../../../../docs/architecture-design.md) 为准，运维步骤以 [docs/operations.md](../../../../docs/operations.md) 为准；本文只写为什么这样排序、否决了什么。

## 待决问题

1. **请求分页的方向**。代码是 `ASC` 加 `>` 游标（追加更晚的请求），文案写「加载更早」。若首屏应是最近若干笔，应改成 `DESC` 加 `<`；若确实从最早读起，则文案与注释改「更晚」。这是产品意图，本文不代定。
2. **direct 做不做**。批 3 的价值取决于是否要回答「Agent 直连 vs 经网关」，也取决于 magpie 是否长期保留 `via` 查询。
3. **加列的升版范围**：一次加完（本文倾向）还是按族分批；`route_summary` 侧是否同步加，取决于第 1 批的字节估算。
4. **证据表的归属**（已定）：真实库的形状普查、键名与未采用的读数在[真实库格式研究](../../../../docs/atc-real-format-research.md)，本文留决策与代价。

## Alternatives considered

**照搬 magpie 的 Agent 能力表（`Fields`/`Sync`/`Drift`）。** 那是配置写入器的模型；ATC 只读观测，搬过来要复刻「如何配置这个 agent」的全部语义，却回答不了 ATC 唯一要问的四件事：标签对应谁、会话与子代理怎么命名、模型名与 effort 词表长什么样、版本如何门控。

**先接 direct 行。** 信息量最大，但 direct 行没有物理身份，先从它入手会把 UUID 当身份、把同一调用记两次。magpie 在同一条链上已经选了保守方向，先修身份键再谈新源。

**只加列，不补阅读器。** 数据从 raw 层搬到 request 层却没人看，等于把浪费换了个位置；尝试链是反例——它的数据早已齐备，缺的一直是读法。

**新建 `req_*`/`agent_*` 专表。** 派生列已经能承载，专表会带来迁移、查询与回收三重成本，违背「一个事实一个家」。

**反过来让账本向页面现有六类收敛（把 magpie 的 memory/results/chat 归并成 history/user/other）。** 会让账本口径与 magpie 脱钩，之后每一次归并都得在采集侧再解释一遍；选页面向 magpie 对齐，账本保持原样。

**自建模型价目表与币种。** magpie 的定价链（provider/model 有效价 → 用户 `*/model` → 去日期后缀 → `PricedName` → catalog）已经覆盖聚合器与别名情形，另建一份必然漂移；ATC 继续从用量 API 取 `cost`/`priced`。

**把正文级内容（vendor 原话、错误体）留在 raw 层只做计数。** 会丢掉「为什么失败」这一唯一的解释权，而 `route_summary` 已经在存脱敏后的 `error`，沿用同一路径即可。

## Acceptance criteria

- 合成库上四个键名修正后字段有值：`req` → `model_requested`、`cost` → `own_cost`、`err` → 错误文本；`counted=true` 的路由显示「总量已校准」，`false` 或缺失显示「本地估计」。
- 合成库上六个 part kind 都有颜色与中文名，渲染结果里不出现 `var(--p0)`。
- 页面：切换 rail 分区与选中请求后，右栏滚动位置不回到顶部；请求 ID 与正文可一键复制。
- 尝试链显示失败原因、间隔与 vendor 原话；不再出现把尝试数组当 JSON 打印。
- 合成库：`stop`/`via`/`subagent` 在列表视图可得；`flags` 至少一种状态能点亮。
- 批 1 的重算只在库副本上验证，核对「`model_requested` ≠ `model_served`」的比例从 0 变为合理值后再决定是否对真实库执行；报告里区分合成验收与真实流量验收。
- direct 在批 3 落地前，库里不得出现任何伪造的 direct 行；`docs/project-overview.md` 里与 magpie 源码不符的表述被修正。
- `bun test`、`bun run typecheck`、`bun run verify:notes` 通过；本提案的每个批次各自带 note 更新。

## Risks

- **历史口径混合**：修好 `requested` 后，旧行的 `model_requested` 仍来自 `model` 兜底，同一列里会有两种来源。必须在库副本上先算清比例并决定是否重算，不能直接在真实库跑。
- **元数据增长**：`request` 与 `route_summary` 不参与正文回收，加列是永久成本；`route_summary` 每行已有约 2 KB 的估算，加列前要按真实字节复核。
- **脱敏路径**：`err` 与 `account` 都带身份性质，只能取改写后的 payload；一旦从原始行回读，就把泄漏面扩大到了映射层。
- **part 键混存**：本机实测 `parts_json` 存的是 magpie 原样键，若历史上某版本按 ATC 键写过，页面改映射后会出现两种键并存；落地前先统计库里的 distinct kind。
- **facade 式归一化**：模型名归一（去 `[1m]` 后缀、点号与短横互认、`provider/model` 前缀）是随厂商漂移的活，若采用必须遵守「原值永不丢、只加归一键」，否则会掩盖真实差异。
- **过度扩张**：批 2 的读者功能一旦开始，容易滑向「为了图表而图表」。统计页、热力图、i18n、币种都排在本路线之外，需要单独提案。