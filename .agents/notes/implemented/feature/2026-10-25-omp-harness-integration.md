# Agent Note: OMP harness 集成——旁路降噪、压缩事件位、背景作业配对与 OMP 语义补齐

Status: implemented

## Problem

ATC 的定位是收敛 magpie 三路证据、按会话阅读 Agent Harness 的 trace。派生层是 harness 通用的骨架：工具配对、前驱链、轮次结算、标题与摘要都不绑定具体 harness；harness 特定语义只有零星几处（输入解释认 OMP 的 `job`/`file`/`chat` 标签，标题生成器兼容 OMP 的回复形状）。这意味着同一个 harness 的 feature 语义——压缩何时发生、后台作业何时唤醒、哪些请求是旁路——全部沉在正文里，阅读层看不见。

用户的主力 harness 之一是 OMP（oh-my-pi，pi-mono 的 fork，Stencil Labs 维护，本机源码在 `repos-external/oh-my-pi`）。2026-10-25 对 OMP 做了一次完整调研：README 与 docs/（86 篇）、packages/（18 个包）逐个过、`~/.omp/agent` 运行数据抽样、生产库 OMP 流量逐笔解剖。结论有两层：

1. OMP 的一批 feature 在 wire 上留有结构化痕迹（模板文案、字段、消息形态），现有三路证据不需要扩源就能派生出展示语义。
2. 生产上用户已经报告了阅读痛点：同一条对话被切成多个会话。根因查清了（见下文「生产实况」），定性为上游证据形状而非 ATC 缺陷，本决策用「降噪」回应它，不做无证据的归并。

原始需求一句话：按 harness feature 做 trace 展示派生——把 OMP 的 feature 语义带进 ATC 的读模型与阅读层，让 OMP 会话在页面上读得出「这一轮发生了什么」。

调研口径备注：本机 OMP 源码检出是 18.0.10（2026-08-28，`33cc6b9a04`），装机运行时是 18.12.6（session 文件 `runtime` 字段），两者有漂移。所有识别锚点以生产流量实测为准，源码只用来解释机制；这本身是 Risks 里的第一条。调研期对 `~/.omp/agent` 的读取是一次性只读（确认锚点归属与源码对照），运行时不读 `~/.omp` 下任何文件，与架构设计的安全边界一致。这句边界落到实现里：实现没有增加对 OMP 本机文件的任何读取。

## Decision

三条总原则贯穿交付：

1. **wire-first**。只用现有三路证据能观察到的信号。本地 session 文件、OMP extension hook、OTel 都能提供更强的信号，但它们是新证据源，见「边界外」。
2. **规则进既有体系并带版本**。旁路识别进 purpose 规则体系（对照 [request-purpose-and-chain](../../architecture/2026-10-22-request-purpose-and-chain.md)），消息解释进输入解释层，不散落 if。
3. **降噪不归并**。旁路会话在列表里折叠，不试图挂回母会话。归并需要线上不存在的证据。

与 [Agent Profile 与请求类别注册表](../../proposed/architecture/2026-10-22-agent-request-kind-registry.md) 的关系：那篇主张把 agent 特称从通用派生管线里移出、收进 RequestKind 注册表，本决策把 OMP 规则直接写进 `classifyPurpose`，方向相反。registry 提案仍是 proposed 且自述「作为输入材料保留，不直接作为执行依据」，本决策按现行体系落地；registry 实施时这两条规则迁入注册表，本文随之更新锚点。

第一批五项全部交付（各一个提交，2026-10-25）；第二批三项未交付，见 [Deferred](#deferred)。

### 生产实况（识别规则的依据）

生产库 2026-10-25 23:03 快照的 OMP 流量：316 笔请求、9 个 conv_key。解剖结果：

- 协议全部是 OpenAI Chat Completions 流式（`/v1/chat/completions`），工具调用是标准 `tool_calls` / `role:tool`，配对直接工作（某会话 19 笔 bash 调用全部 resolved）。
- 9 个会话里 3 个是真实用户会话（24、69、215 笔）。其余 6 个是旁路：4 个是同一秒（20:59:56）并行的 skill 描述压缩调用（各 1 笔、随机 v4 session id、`purpose_status` 全是 `unrecognized`），2 个是标题生成会话（各 2 笔，ATC 已正确判 `title/exclude`，规则 `title.reply.v1`）。
- 当前 9 个会话里，全部请求 `purpose_chain='exclude'` 的只有 2 个（两个标题会话），没有任何会话是「部分 exclude」。降噪规则上线后，hint 旁路那 4 个会从 `participate` 改判成 `exclude`，折叠的正是它们。
- **会话切割的根因**：OMP 的旁路一次性调用各自创建新的 SDK 会话，各带独立 session id，与母会话在 wire 上没有任何可关联字段。advisor 更极端——provider-facing session id 是内存映射生成的随机 UUIDv7（`packages/coding-agent/src/advisor/config.ts` 的 `getOrCreateAdvisorProviderSessionId`），刻意不携带母会话线索。magpie 侧对 OMP 也没有 subagent 标注（其 `subagent_id` 全空；其 subagent 识别只覆盖 Claude Code 与 Codex）。这是上游证据形状，不是 ATC 缺陷；接受不处理，只做降噪。
- OMP 通过 `session_id` / `x-session-id` 类请求头向 magpie 声明会话身份（magpie `internal/gateway/gateway.go` 的 `sessionHeaders` 清单），所以主会话的 session 归组是可靠的。
- 一个未解的对账差异：10-24 那个 24 笔的会话，OMP 自己的 session 账本记了 46 笔 `model_usage`。差异来自哪（未过 magpie 的直连、内部尝试、还是口径不同）没有结论，本决策不解决采集覆盖问题，代价记录在 Consequences。

生产观测到的识别锚点（模板文案，属 OMP 生成内容而非用户隐私，直接进规则与 fixture）：

| 锚点 | 出处 | 用途 |
| --- | --- | --- |
| 某条 user 消息里**任一文本块的块首**命中 `Compress into one routing hint of at most 12 words:` | skill 描述压缩管线（`~/.omp/agent/skill-descriptions.db` 的写入方） | 旁路识别 |
| 某条 user 消息里任一文本块的块首命中 `Resume prior conversation. Earlier turns archived under HISTORY`；同块含 `About NNN characters of older middle history dropped to fit archive budget.` 与 `Archived transcript scopes:` | snapcompact 压缩后的续会话归档消息（源码 `packages/snapcompact/src/prompts/snapcompact-summary.md`） | 压缩事件位 |
| bash 工具结果 `Backgrounded as job bg_NNN (…)` | bash 后台化 | 背景作业配对（发起） |
| user 消息 `<system-notice>` 块内 `Background job bg_NNN has completed.`，以及复数形态 `N background jobs have completed.` 下的 `── Job bg_NNN ──` 行 | 作业完成通知注入（源码 `packages/coding-agent/src/prompts/tools/async-result.md`） | 背景作业配对（通知） |
| 重试请求新增消息含 `<system-interrupt reason="rule_violation" rule="…" path="…">`（源码模板 `packages/coding-agent/src/prompts/system/ttsr-interrupt.md`） | TTSR 流规则中断后注入 | TTSR 识别（未交付，流量未实证） |
| Chat 请求顶层字段 `reasoning_effort`（实测 `high` / `low`） | OMP 按 thinking level 映射 | 读数展示 |

锚点判据一律按**块首**而不是消息首行：归档消息实测有 8 个内容块，块 0 是 `<system-reminder>`（日期与 cwd），块 1 才是归档正文；按消息首行写匹配器一笔都命中不了。块级判据与 `input-interpretation.ts` 的 `cleanBlock` 逐块剥壳一致。

18.0.10 的源码树里 grep 不到 routing hint 文案，说明这条管线在 18.0.10 之后才进的主线（或位置变了）。锚点以流量为准；装机版本源码的机制归属未再深查，锚点失配时规则按版本静默退化。

### 一、旁路调用识别与列表降噪

`classifyPurpose` 的规则链在分类器之后、来源 kind 之前加 `omp.skill-hint.v1`：`agent='omp'` 且任一 user 文本块块首命中 `Compress into one routing hint of at most 12 words:` → `req_kind='skill_hint'`、`purpose_chain='exclude'`。锚点失配时规则静默不命中，退回 `participate`。

取数扩了一处：`readPurposeViewTx`（`src/request-purpose.ts`）此前只解骨架、引用索引与 role=2 的 System 块；现在加读 role=0 的前 5 条 user 消息、逐块取前 200 字符的块首（`PurposeView.userBlockHeads`）。双限额让取数成本不随正文体积增长；一次按 ord 限额的单行查询，不扫全表，符合[联合评审](../../../docs/agent-request-kind-review.md)的取数成本契约。

`PURPOSE_VERSION` 3→4。与 [zcode 的 Agent 支持](../../proposed/feature/2026-10-24-zcode-agent-support.md) 的 3→4 撞车按「实施时的当前值 +1」解决：OMP 先实施取 4，zcode 实施时取当时的当前值 +1，两篇各自记录。

已知但**不写规则**的旁路族（先采样再定，避免闭眼写前缀）：memory 两阶段管线的抽取与合并调用、`/review` 子代理、`eval` 内核的 `agent()` 调用、advisor 逐轮调用。它们的共同特征（单笔或极少笔、无 session 文件、消息是 harness 生成的 brief）可以在后续版本做成弱信号，但弱信号只进观察、不进 exclude。

降噪展示走渲染层方案：`listSessions` 聚合 `has_participate`，会话内零参与链请求的给 `bypass` 标志；`renderSessions` 默认折叠这批条目、列表末尾出折叠计数行（「已折叠 N 条旁路会话（已加载页）」），可展开收起。判定要求**全量** exclude，任一笔参与链就不折叠——错折叠一个真会话的代价远高于多显示一条噪音。分页仍按全量，折叠计数只覆盖已加载页，界面措辞如实标注。

### 二、compaction 事件位

OMP 的压缩（compaction）有六种触发（`docs/compaction.md`），wire 上统一表现为：续会话里一条以 `Resume prior conversation. Earlier turns archived under HISTORY` 开头的 user 消息承载归档（snapcompact 策略下旧史栅格化成 image 块 + `¶user:`/`¶think:`/`¶ai:`/`¶call:` 作用域文本 + FILES 目录树 + 预算丢弃量说明）。

**这条消息在会话每笔请求都会重发**，所以判据是「本笔的**确定增量**里新增了归档消息」；按「输入里存在」判会让整场会话每一行都挂上压缩标记，正好违反降噪约定。

落点三层：

1. **输入解释**（`src/input-interpretation.ts`）：归档消息解释为 `injected`、kind `omp_history_archive`，标题与折叠行摘要的选源自然跳过它。代价如实记录：压缩起点的会话标题从 `user_delta` 退化为 `model_time`（模型名 · 时间兜底），不再是被污染的内容标题，但也不再是内容标题。这是降噪换来的，不是副作用。
2. **请求级派生位**：`request` 与 `derive_request_result` 各加 `context_event` 列（`none` / `omp_compaction`，NULL 表示从未判定），`published_derive_request` 与 `effective_request` 两个视图都带此列。写入与选源对照 `reply_shape` 三态的先例：发布代优先、正文回收保留旧值、NULL 从未判定。判定适配 `contextEventTx`（`src/derive/read.ts`，两条派生路径共用）：`first`/`confirmed` 按确定增量判；`branch` 关系没有增量可比，按输入含归档归因（bounded 扫前 20 条 user 消息，归档实测在 ord 1）；`aux` 判 `none`；其余判不出保留旧值。basis 里记从归档块提取的 `dropped_chars`（同步路径并进 `summary_basis`，切片路径在摘要阶段覆写压缩行的 `basis_json`），展示注明这是字符数，不是 token。
3. **branch 归因注记**：`branch` + `omp_compaction` 在轨迹出 `compaction` 记录步骤（带丢弃量），关系文案出「另起一支 · 压缩归档改写了上下文前缀」。链判定本身不动。生产流量里 `branch` 与压缩并存尚未出现（压缩都发生在会话起点），这条注记目前只有合成 fixture 证据。

### 三、背景作业配对

OMP 的 bash 工具可把命令后台化为 `bg_NNN` 作业，完成时以 `<system-notice>` 用户消息注入结果。结算表（纯派生、可重建，对照 `tool_call` 的 pending/resolved 模式）：

```text
bg_job(job_id, conv_key, spawn_req, spawn_ord, notice_req, notice_ord, state)
PRIMARY KEY (conv_key, job_id)
```

主键带 `conv_key`：OMP 重启后 `bg_` 编号从头开始，单以 `job_id` 为主键会跨 conv 撞键。有一处与提案时的形状不同：spawn 记的是**承载发起工具结果的消息 ord**（`spawn_ord`），不是调用 ord——展示锚点是发起处的 bash 结果行，按消息 ord 直接对位轨迹步骤，不必再 join `tool_call`。

发起只认 role=3 的工具结果块（归档正文里的复述与后续请求的重发都是同一文本的再出现）；规则取该 conv 内**最早出现**的位置，否则时延与位置全落到重发请求上。一个结果块内多行发起按 matchAll 全收。通知只认两种完成形态：单数 `Background job bg_NNN has completed.` 与复数 `N background jobs have completed.` 之下的 `── Job bg_NNN ──` 行——只认单数会让只以复数出现的作业永远停在 pending。`<system-notice>` 也承载其它通知，两种形态都不命中的不参与配对。

重建语义对照工具配对：组完成事务里按可读正文整体重算本 actor 的行（旁路请求不参与），两端正文都已回收的行原样保留，重算与保留行撞键时保留行胜（它记的是更早的真实位置）。配对挂进同步路径的组完成，与 `tool_call` 同批；切片路径同 `tool_call` 先例不写这张表——切片只是显式容量实验路径，生产走同步。

展示：`/api/sessions/:key/bg-jobs` 端点 + reader-store 会话级快照。轨迹里发起处（bash 结果行）行尾注配对读数，通知处（`<system-notice>` 消息被解释层判 injected 本来不占气泡）出 Event 步骤。时延按两笔请求的 `started_ms` 差；**同笔内配对没有请求级时延**，界面写「同一请求内」而不印一个 0 ms。

### 四、reasoning_effort 读数展示

`reasoning_effort` 已随骨架的 `request_without_messages`（`src/skeleton.ts`）保存、经 `request_fields`（`src/protocols.ts` 组装）透出到正文接口。缺的只是读数页的一行，且这一行此前只出现在尝试链里，而尝试链只在重试、失败或未结束时渲染——单次干净调用根本看不到 effort。

落点：`usageFoldHtml` 收正文首片，`requestEffortOf` 从 `request_fields.reasoning_effort` 取值，effort 行常驻「用量与上下文」折叠行；未读正文或字段缺失时整行不渲染，不占位。magpie 账本侧 `raw_route.effort` 是另一个来源，两者不一致时以正文字段展示为准、差异保留不合并：两个来源说的是两件事——客户端发了什么、网关读到了什么。

### 五、OMP 工具的摘要分派与色类

`argsOf`（`src/derive/decision.ts`）补 `path` 键（`file_path` 优先；`command`/`pattern` 之类近邻键仍不提取）：OMP 的 read/write/edit/grep/glob 用 `path` 声明目标文件，此前 OMP 会话的 `arg_path` 全为 NULL，已交付的[会话信息汇总](2026-10-25-session-trace-summary.md)里「写入尝试 / 读取请求」两组对 OMP 半瞎。OMP 源码 18.0.10 复核的参数形状：read 只收 `path`、write 收 `path`+`content`、edit 常态是 replace 模式、grep 是 `pattern`+`path?`、glob 的 pattern 本身在 `path` 键、todo 按 `op` 组织、task 收 `agent`+`task`、web_search 收 `query`、ask 收 `questions`。`grep`/`glob` 的 `path` 是搜索范围，落到 `arg_path` 语义不变形，汇总按工具名过滤不受污染。算法号 GROUP_ALGORITHM 3→4、DERIVE_ALGORITHM 7→8。

`dispatchSummary`（`web/trace-view.js`）补小写分支：read/edit/write 与大写同逻辑认两键；grep 显 pattern、glob 显 pattern、todo 显 op 与要点、task 显 agent 名与 task 首行、web_search 显 query、ask 显 question（OMP 没有 `wait` 内置工具，原提案里的 `wait` 删除）。`toolTint`（`web/body-view.js`）补 read/edit/write 小写别名归同色，不扩新色类；grep/glob/todo/task/web_search/ask 落中性色——色类是既有语言，扩类要克制，先让摘要行本身可读。会话汇总的写入/读取分组与点击定位按小写化工具名过滤。

### 升级路径

`upgradePurposeTargetTx` 只在显式 `bun run maintain rebuild --session <key>` 时执行，普通 tick 不升级 clean 的历史行。生产升级按此顺序执行完毕：停采集器 → `maintain backup` 全库备份 → `scripts/backfill-omp-semantics.ts`（幂等补 `context_event` 两列、建 `bg_job`、从 schema-v6.sql 重取两个视图 DDL，全组标脏重派生）→ 9 个 OMP 会话逐个 `rebuild --session` → 起采集器。回填脚本二次执行验证过幂等。

## 与并行工作的协调

[session-trace-summary](2026-10-25-session-trace-summary.md) 与 [turn-pair-reading](2026-10-25-turn-pair-reading.md) 都在读模型与展示层动刀。旁路降噪与会话信息汇总对「哪些请求算数」的口径一致：exclude 的请求不进汇总的输入集合（`src/queries/session-summary.ts` 按 `purpose_chain` 分主链与旁路，现状已是如此）。`path` 键提取与汇总共用 `argsOf`，改动同时影响 `tool_call.arg_path` 与 `derive_tool_result.arg_path` 两条路径，算法号 bump 与全组重派生一次完成。

## Testing

合成验收进 `bun test`（700 用例全绿），每条规则一组 fixture：skill_hint 块首判据（含块 0 为 system-reminder 的形态、锚点失配退化、非 omp agent 不命中）；归档消息解释与 `context_event`（增量新增判 omp_compaction、重发判 none、branch 按输入归因、正文回收保留旧值、标题退化 model_time 作预期值断言）；bg 配对（跨两笔/同笔/复数通知/非作业通知/role=0 复述不认/重发取最早/pending/正文回收保留行/旁路不参与）；effort 行有值才显示；OMP 小写工具摘要与色类、`path` 提取、汇总小写过滤；切片与同步的 parity 列加 `context_event` 锁两路一致；回填脚本幂等补列重建视图。

真实数据人工验收（生产库，快照 2026-10-26 00:20，与合成验收分开呈报，全文见[验收记录](../../../docs/acceptance.md)）：四个 skill 描述压缩会话全部改判 `omp.skill-hint.v1/exclude`，6 个全员 exclude 会话带 `bypass` 标志；24 笔会话 req 4 判 `omp_compaction`、basis 记 `dropped_chars: 999551`、标题退化为模型时间兜底；bg 配对 24 个作业（同笔 resolved 13、跨笔 resolved 5、pending 6，含发起正文已回收的诚实缺口）；effort 行在单次干净调用可见；小写工具 arg_path 重算后非空（read 42 / edit 38 / write 15 / grep 1）。

## Deferred

第二批三项保持提案形态，逐项单独评审后再做，都不在本决策内：

- **TTSR 中断-重试识别**：判据是 abort/499 + 紧邻重试的新增消息含 `<system-interrupt reason="rule_violation" …>`。全库 3 处命中都在 `agent='claude'` 的请求里，OMP 侧 0 例，只有源码模板依据。
- **客户端重试/fallback 族**：相邻请求共同前缀重放 + `model_requested` 变化 + 前笔失败 → 注记 `client_retry`。与 magpie 网关侧 `tries` 是两层，注记只进展示不进祖先判定。实测 OMP 会话内没有 `model_requested` 变化，缺流量样本。
- **子代理启发式**（最低优先，可不做）：`task` 工具参数与时间窗内其它 conv 首条 user 消息吻合只是候选线索，落 confirmed 的误判代价是串会话，违反「身份不足不猜」。若做只做列表候选提示，不做链合并。

规则上线后现有 9 个 OMP 会话不会自动改判，需逐个 rebuild——这一步已在生产执行完毕；此后新流量按当前规则自动判定。

## Alternatives considered

**读 `~/.omp/agent` 作第四路证据源。** session JSONL 是结构化金矿：`model_usage`（api/provider/model/purpose/usage 含 cost 与 reasoningTokens）、`compaction`（tokensBefore/After/firstKeptEntryId）、`title_change`、`thinking_level_change`、`custom` 事件（tool_execution_start、async-result）、header 的 `parentSession`/`previousSessionFiles` lineage 能解掉子代理与 advisor 的归并问题。否决理由：架构设计的安全边界明写「不扫描 Agent 会话文件，只读 magpie 自己写的来源」；引入第四源是方向性决策，需要用户单独拍板（见边界外），不该夹带在本决策里。

**OMP extension hook 桥。** 用户 `~/.omp/agent/extensions/` 里已有 `ata-omp-trace` 先例（OMP extension 往本机端口推 pi-hooks 事件、读 `PI_SUBAGENT_*` lineage env），同型桥可以给 ATC 提供 magpie 看不见的 harness 语义（turn 边界、工具执行时序、子代理 lineage）。否决理由同上：新证据通道 + 与 OMP 版本耦合的维护面，属边界外决策项。

**开 OMP 的 OTel。** OMP 支持 OTLP 三信号（默认关，`OTEL_*` 开启，service name `oh-my-pi`）。否决理由：信号与现有三路大量重复，换来的是第二套采集运维面，性价比最低。

**时间邻接的旁路会话归并。** 把 20:59:56 的四个压缩会话与 21:00 的主会话按时间窗挂接。否决理由：无证据链，纯启发式；advisor 的 session id 是刻意随机化的，说明 OMP 有意在 provider 侧切断会话关联，我们硬猜会猜错。

**改 magpie 上游补 subagent 标注。** magpie 的 subagent 识别只覆盖 Claude Code 与 Codex；给 OMP 加识别要改上游。否决理由：超出本项目边界，且 OMP 子代理本来就是独立子进程会话，上游改动的收益不如 extension 桥。

**把 `context_event` 判据写成「输入里含归档消息」。** 归档消息在会话每笔请求都重发，这条判据会给整场会话每一行挂压缩标记，降噪变成加噪。改用 delta 判据。

**旁路折叠走 SQL 层过滤。** `GROUP BY conv_key` 后 `HAVING MAX(purpose_chain='participate')=1`，游标与 `next_cursor` 语义跟着改，折叠计数需另开全量聚合查询。否决理由：改动大、动游标；渲染层过滤改动小，代价是计数随翻页增长，界面措辞如实写「已加载页」即可。

## Consequences

- **模板漂移是常驻风险**。源码 18.0.10 与装机 18.12.6 已有实证差异（routing hint 文案在源码树里不存在）。所有锚点规则带版本号进 purpose 体系，并沿用形状探针思路：锚点失配时规则静默退化为 `unrecognized`，不报错、不误判，降噪失效只是回到现状。OMP 升级后锚点需人工复核。
- **误降噪的代价有硬边界**。错 exclude 会把真会话从视野里藏掉。缓解：折叠必须可展开、判定要求全量 exclude、`bypass` 只影响列表默认态不影响任何派生。
- **标题退化为时间兜底**。归档消息改判注入后，压缩起点的会话失去内容标题，只剩模型名加时间（生产已按此呈现：`step-5-preview · 11:04`）。这是「不再污染」与「仍有内容」之间的取舍；后续若要补回内容标题，需要第四源或 extension 桥，属边界外。
- **背景作业配对有覆盖缺口**。发起正文已回收的作业只能以 notice-only 的 pending 呈现（生产已出现），时延与发起位置不猜。bg 配对挂同步路径，切片实验路径不维护这张表——切片读侧未迁移，这个边界与 `tool_call` 一致。
- **`arg_path` 口径变更的历史数字跳变**。补 `path` 键让 OMP 会话汇总的路径分组从空变成有值，同一会话的历史数字会跳变；两条派生路径已随算法号 bump 全组重算。
- **采集覆盖的系统性缺口未解**。46 对 24 的对账差异：如果 OMP 相当一部分流量不过 magpie，本决策派生得再好也只是已采集流的语义。覆盖率审计是独立工作，值得排期。
- **第二批规则可能长期不触发**。TTSR 与重试族缺 OMP 流量样本，实现后不能以「生产没看到」判为规则错误；它们目前连实现都未交付，见 Deferred。

## 边界外（P2 决策项，需用户拍板，不在本决策内）

- `~/.omp/agent` 第四路证据源（安全边界豁免 + 隐私口径）。
- OMP extension hook 桥（`ata-omp-trace` 同型，拿 turn 边界与子代理 lineage）。
- OTel 旁路采集。
- 模型角色语义：wire 上只有 `group/…` 组名，role→group 映射在 `~/.omp/agent/config.yml`，要讲清角色得读本地配置，同属第四源决策。
