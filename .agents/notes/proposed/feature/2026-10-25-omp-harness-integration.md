# Agent Note: OMP harness 集成——旁路降噪、压缩事件位、背景作业配对与 OMP 语义补齐

Status: proposed

## Problem

ATC 的定位是收敛 magpie 三路证据、按会话阅读 Agent Harness 的 trace。派生层目前是 harness 通用的骨架：工具配对、前驱链、轮次结算、标题与摘要都不绑定具体 harness；harness 特定语义只有零星几处（输入解释认 OMP 的 `job`/`file`/`chat` 标签，标题生成器兼容 OMP 的回复形状）。这意味着同一个 harness 的 feature 语义——压缩何时发生、后台作业何时唤醒、哪些请求是旁路——全部沉在正文里，阅读层看不见。

用户的主力 harness 之一是 OMP（oh-my-pi，pi-mono 的 fork，Stencil Labs 维护，本机源码在 `repos-external/oh-my-pi`）。2026-10-25 对 OMP 做了一次完整调研：README 与 docs/（86 篇）、packages/（18 个包）逐个过、`~/.omp/agent` 运行数据抽样、生产库 OMP 流量逐笔解剖。结论有两层：

1. OMP 的一批 feature 在 wire 上留有结构化痕迹（模板文案、字段、消息形态），现有三路证据不需要扩源就能派生出展示语义。
2. 生产上用户已经报告了阅读痛点：同一条对话被切成多个会话。根因查清了（见下文「生产实况」），定性为上游证据形状而非 ATC 缺陷，本提案用「降噪」回应它，不做无证据的归并。

原始需求一句话：按 harness feature 做 trace 展示派生——把 OMP 的 feature 语义带进 ATC 的读模型与阅读层，让 OMP 会话在页面上读得出「这一轮发生了什么」。

调研口径备注：本机 OMP 源码检出是 18.0.10（2026-08-28，`33cc6b9a04`），装机运行时是 18.12.6（session 文件 `runtime` 字段），两者有漂移。本文所有识别锚点以生产流量实测为准，源码只用来解释机制；这本身是 Risks 里的第一条。调研期对 `~/.omp/agent` 的读取是一次性只读（确认锚点归属与源码对照），运行时不读 `~/.omp` 下任何文件，与架构设计的安全边界一致。这句边界要落到实现里：后续实现不得以本文为由增加对 OMP 本机文件的读取。

## Proposal

三条总原则，评审时请先校这三条再谈细节：

1. **wire-first**。只用现有三路证据能观察到的信号。本地 session 文件、OMP extension hook、OTel 都能提供更强的信号，但它们是新证据源，超出本提案范围（见「边界外」）。
2. **规则进既有体系并带版本**。旁路识别进 purpose 规则体系（对照 [request-purpose-and-chain](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)），消息解释进输入解释层，不散落 if。
3. **降噪不归并**。旁路会话在列表里折叠，不试图挂回母会话。归并需要线上不存在的证据。

与 [Agent Profile 与请求类别注册表](../architecture/2026-10-22-agent-request-kind-registry.md) 的关系：那篇主张把 agent 特称从通用派生管线里移出、收进 RequestKind 注册表，本提案把 OMP 规则直接写进 `classifyPurpose`，方向相反。registry 提案仍是 proposed 且自述「作为输入材料保留，不直接作为执行依据」，本提案按现行体系落地；registry 实施时这两条规则迁入注册表，本文随之更新锚点。

分两批交付。第一批五项（下文「第一批」），全部是派生层与展示层改动，不动采集与存储结构（新增一张纯派生结算表除外）。第二批三项（「第二批」），保守启发式，逐项单独评审后再做。

## 生产实况（识别规则的依据）

生产库 2026-10-25 23:03 快照的 OMP 流量：316 笔请求、9 个 conv_key。解剖结果：

- 协议全部是 OpenAI Chat Completions 流式（`/v1/chat/completions`），工具调用是标准 `tool_calls` / `role:tool`，配对直接工作（某会话 19 笔 bash 调用全部 resolved）。
- 9 个会话里 3 个是真实用户会话（24、69、215 笔）。其余 6 个是旁路：4 个是同一秒（20:59:56）并行的 skill 描述压缩调用（各 1 笔、随机 v4 session id、`purpose_status` 全是 `unrecognized`），2 个是标题生成会话（各 2 笔，ATC 已正确判 `title/exclude`，规则 `title.reply.v1`）。
- 当前 9 个会话里，全部请求 `purpose_chain='exclude'` 的只有 2 个（两个标题会话），没有任何会话是「部分 exclude」。降噪规则上线后，hint 旁路那 4 个会从 `participate` 改判成 `exclude`，折叠的正是它们。
- **会话切割的根因**：OMP 的旁路一次性调用各自创建新的 SDK 会话，各带独立 session id，与母会话在 wire 上没有任何可关联字段。advisor 更极端——provider-facing session id 是内存映射生成的随机 UUIDv7（`packages/coding-agent/src/advisor/config.ts` 的 `getOrCreateAdvisorProviderSessionId`），刻意不携带母会话线索。magpie 侧对 OMP 也没有 subagent 标注（其实测 `subagent_id` 全空；其 subagent 识别只覆盖 Claude Code 与 Codex）。这是上游证据形状，不是 ATC 缺陷；按用户定性，接受不处理，本提案只做降噪。
- OMP 通过 `session_id` / `x-session-id` 类请求头向 magpie 声明会话身份（magpie `internal/gateway/gateway.go` 的 `sessionHeaders` 清单），所以主会话的 session 归组是可靠的。
- 一个未解的对账差异：10-24 那个 24 笔的会话，OMP 自己的 session 账本记了 46 笔 `model_usage`。差异来自哪（未过 magpie 的直连、内部尝试、还是口径不同）没有结论，本提案不解决采集覆盖问题，只在 Risks 记录。

生产观测到的识别锚点（模板文案，属 OMP 生成内容而非用户隐私，可直接进规则与 fixture）：

| 锚点 | 出处 | 用途 |
| --- | --- | --- |
| 某条 user 消息里**任一文本块的块首**命中 `Compress into one routing hint of at most 12 words:` | skill 描述压缩管线（`~/.omp/agent/skill-descriptions.db` 的写入方） | 旁路识别 |
| 某条 user 消息里任一文本块的块首命中 `Resume prior conversation. Earlier turns archived under HISTORY`；同块含 `About NNN characters of older middle history dropped to fit archive budget.` 与 `Archived transcript scopes:` | snapcompact 压缩后的续会话归档消息（源码 `packages/snapcompact/src/prompts/snapcompact-summary.md`） | 压缩事件位 |
| bash 工具结果 `Backgrounded as job bg_NNN (…)` | bash 后台化 | 背景作业配对（发起） |
| user 消息 `<system-notice>` 块内 `Background job bg_NNN has completed.`，以及复数形态 `N background jobs have completed.` 下的 `── Job bg_NNN ──` 行 | 作业完成通知注入（源码 `packages/coding-agent/src/prompts/tools/async-result.md`） | 背景作业配对（通知） |
| 重试请求新增消息含 `<system-interrupt reason="rule_violation" rule="…" path="…">`（源码模板 `packages/coding-agent/src/prompts/system/ttsr-interrupt.md`） | TTSR 流规则中断后注入 | TTSR 识别（第二批，流量未实证） |
| Chat 请求顶层字段 `reasoning_effort`（实测 `high` / `low`） | OMP 按 thinking level 映射 | 读数展示 |

锚点判据一律按**块首**而不是消息首行：归档消息实测有 8 个内容块，块 0 是 `<system-reminder>`（日期与 cwd），块 1 才是归档正文；按消息首行写匹配器一笔都命中不了。块级判据与 `input-interpretation.ts` 的 `cleanBlock` 逐块剥壳一致。

## 第一批交付（P0）

### 一、旁路调用识别与列表降噪

规则：分类器强指纹模式，对照 claude security monitor 分类器的写法（`src/semantics.ts`）：`agent='omp'` 且任一 user 文本块块首命中 `Compress into one routing hint of at most 12 words:` 前缀 → `req_kind='skill_hint'`、`purpose_chain='exclude'`，`purpose_rule` 记 `omp.skill-hint.v1`。`PURPOSE_VERSION` 随之递增。版本号与 [zcode 的 Agent 支持](../feature/2026-10-24-zcode-agent-support.md) 的 3→4 撞车，实施时取当时的当前值 +1，两篇同步更新。

**用途取数要扩一处**。`readPurposeViewTx`（`src/request-purpose.ts`）目前只解骨架、引用索引与 role=2 的 System 块，普通 User 块不解压，`PurposeView` 也没有「user 文本块」字段。本规则要读 user 文本，必须扩取数：读 `request_block` 里 role=0 的行，按 ord 取前若干条解压（旁路请求通常只有 1–2 条 user 消息，成本不随正文体积增长）。扩展的边界照 zcode 提案的先例写：一次按 ord 限额的单行查询，不扫全表。取数成本契约见 [联合评审](../../../docs/agent-request-kind-review.md)。

注意一个实证：18.0.10 的源码树里 grep 不到这段文案，说明这条管线在 18.0.10 之后才进的主线（或位置变了）。实现时锚点以流量为准，同时 grep 装机版本（`~/.omp` 侧或上游仓库）确认机制归属，把结论写回本文。

已知但第一版**不写规则**的旁路族（先采样再定，避免闭眼写前缀）：memory 两阶段管线的抽取与合并调用、`/review` 子代理、`eval` 内核的 `agent()` 调用、advisor 逐轮调用。它们的共同特征（单笔或极少笔、无 session 文件、消息是 harness 生成的 brief）可以在后续版本做成弱信号，但弱信号只进观察、不进 exclude。

降噪展示：`listSessions`（`src/queries/sessions.ts`）对「会话内全部请求 `purpose_chain` 均为 exclude」的会话标记 `bypass`，列表默认折叠这批条目、显示折叠计数、可展开。判定要求**全量** exclude，任一笔参与链就不折叠——错折叠一个真会话的代价远高于多显示一条噪音。

折叠的分页口径要定死，二选一：SQL 层过滤（`GROUP BY conv_key` 之后 `HAVING MAX(purpose_chain='participate')=1`，游标与 `next_cursor` 语义跟着改，折叠计数需另开一条全量聚合查询）或渲染层过滤（只在 `web/app.js` 的 `renderSessions` 里隐藏，分页仍按全量，折叠计数只覆盖已加载页）。推荐后者：改动小、不动游标，代价是计数随翻页增长，界面上要写成「已加载页里折叠 N 条」而不是全量。

### 二、compaction 事件位

OMP 的压缩（compaction）有六种触发（`docs/compaction.md`），wire 上统一表现为：续会话里一条以 `Resume prior conversation. Earlier turns archived under HISTORY` 开头的 user 消息承载归档（snapcompact 策略下旧史栅格化成 image 块 + `¶user:`/`¶think:`/`¶ai:`/`¶call:` 作用域文本 + FILES 目录树 + 预算丢弃量说明）。

**这条消息在会话每笔请求都会重发**，实测 24 笔会话的 req 4、6、13、98 都在 user 块 ord 1 带着同一份归档。所以判据必须是「本笔的**确定增量**里新增了归档消息」，即 `prev_relation='first'` 且 `delta` 含该 ord；写成「输入里存在归档消息」会让整场会话每一行都挂上压缩标记，正好违反降噪约定。

落点三层：

1. **输入解释**（`src/input-interpretation.ts`）：该消息现在的解释结果是 `text`（块首是 `<system-reminder>`，剥壳后剩裸文本），会被当用户输入并污染标题——生产上 req 4 的标题就是 `Resume prior conversation. Earlier turns archived under HIST…`。改为识别成 `injected`，解释结果带 kind `omp-history-archive`，标题选源随之自然跳过它。代价要写明：该会话的 `title_source` 从 `user_delta` 退化为 `model_time`，标题变成 `step-5-preview · 11:04` 这类模型时间兜底，不再是被污染的内容标题，但也不再是内容标题。这是降噪换来的，不是副作用。
2. **请求级派生位**：`request` 加 `context_event`（第一版取值 `none` / `omp_compaction`），写入路径与选源逻辑对照 `reply_shape` 三态的先例（发布代优先、正文回收保留旧值、NULL 表示从未判定）。basis 里记从消息文本提取的 dropped characters 数。展示时注明这是字符数，不是 token。这一列要同时进 `published_derive_request` 与 `effective_request` 两个视图（`src/schema-v6.sql`），否则按发布代读取的读模型取不到。
3. **branch 归因注记**：该请求的 `prev_relation` 是 `branch`（消息前缀完全变了），这本身正确；补一个展示层注记 `branch_by_compaction`，让「为什么另起一支」可读。链判定本身不动。**流量未实证**：现有 9 个会话的 `prev_relation` 分布是 confirmed 288 / first 7 / unknown 14 / aux 4 / null 3，没有一个 `branch`——压缩都发生在会话起点。这条注记只有源码依据，实现后可能在真实数据里长期不出现，验收按合成 fixture 判，不按生产可见性判。

### 三、背景作业配对

OMP 的 bash 工具可把命令后台化为 `bg_NNN` 作业，完成时以 `<system-notice>` 用户消息注入结果。这是 OMP 的「发起→唤醒」循环，在 trace 上落在两处痕迹里。

发起痕迹实测有三处，配对必须只认其中一处：role=3 的工具结果（`Backgrounded as job`，389 次）、role=0 归档文本里的复述（161 次）、以及同一 conv 后续每笔请求重发的同一工具结果块（`bg_372` 的发起痕迹出现在 23 笔请求的 ord 157）。规则写成「取该 conv 内最早出现且 `role=3` 的发起位置」，否则 `spawn_req` 会落到某个重发请求上，时延与位置全错。

通知同样有两种形态，锚点表已列：单数 `Background job bg_NNN has completed.` 与复数 `N background jobs have completed.` 下的 `── Job bg_NNN ──` 行（全库 23 次）。实测 `bg_376` 与 `bg_377` 只以复数形态出现，只认单数会让这两个作业永远停在 pending。

结算表（纯派生、可重建，对照 `tool_call` 的 pending/resolved 模式）：

```text
bg_job(job_id, conv_key, spawn_req, spawn_call_ord, notice_req, notice_ord, state)
PRIMARY KEY (conv_key, job_id)
```

主键带 `conv_key`：OMP 重启后 `bg_` 编号从头开始，单以 `job_id` 为主键会跨 conv 撞键。同 conv_key 内按 bg 编号配对；结果先到或通知先到都要能接（对照工具配对对反向到达的处理）。`<system-notice>` 也承载其它通知，只配对文本命中上面两种作业完成形态的。

展示：轨迹里发起处（bash 结果行）与通知处（Event 步骤）配对标注。时延按两笔请求的 `started_ms` 差，**同笔内配对没有请求级时延**——实测 27 个作业里 16 个的发起与通知落在同一笔请求，差值恒为 0，界面要写「同一请求内」而不是印一个 0 ms。

新表不是「无 backfill 负担」。存量库 `user_version` 已是 6，`openStore` 的 `migrate` 只对新库执行 `SCHEMA`，不会给旧库补表。落法二选一：照 `scripts/backfill-summary-facts.ts` 的幂等脚本模式补建表与视图，或明确走运维删除重建。前者的部署顺序仍是停采集器 → 跑脚本 → 起新代码。

### 四、reasoning_effort 读数展示

`reasoning_effort` 已随骨架的 `request_without_messages`（`src/skeleton.ts`）保存、经 `request_fields`（`src/protocols.ts` 组装）透出到正文接口——实测 OMP 骨架可读的 302 笔全部带 `reasoning_effort`（`high` / `low`）。缺的只是读数页的一行。

落点：web 读数折叠行加「effort」，值取正文 `request_fields.reasoning_effort`。注意现状是这一行**只出现在尝试链里**，而尝试链只在重试、失败或未结束时渲染（`web/app.js` 的 `attemptsAbnormal`）；单次干净调用根本看不到 effort。所以这次不是「加一行」那么简单，是把 effort 从异常态读数提到常规读数行。

magpie 账本侧 `raw_route.effort` 是另一个来源（实测 OMP 侧 high 996 / low 12），两者不一致时以正文字段展示为准、差异保留不合并：两个来源说的是两件事——客户端发了什么、网关读到了什么。

### 五、OMP 工具的摘要分派与色类

web 的工具色类现有 Read/Edit/Write/Bash/Skill/Agent 六色。OMP 的工具名实测是**小写**：`bash`/`read`/`write`/`edit`/`grep`/`ask`（`packages/coding-agent/src/tools/builtin-names.ts` 的内置清单还含 `glob`/`todo`/`task`/`web_search`/`eval`/`ast_grep` 等）。

现状有一处要先修：`dispatchSummary`（`web/trace-view.js`）只有 `Bash`/`bash` 两个大小写，`Read`/`Edit`/`Write` 没有小写分支；`toolTint`（`web/body-view.js`）同样只认大写。所以 OMP 的 read/write/edit 现在走 `fallbackSummary`、落在 `tint-other`。**OMP 的 read/write/edit 并不直接命中现有类**，前提句要改成「需补小写别名」。

另一处并进本项：OMP 的路径参数键是 `path`，不是 `file_path`（实测 `{"path":"README.md","i":"Reading README"}`），而 `src/derive/decision.ts` 的 `argsOf` 只认 `file_path`。结果是 OMP 的 read/write/edit 调用 `arg_path` 全为 NULL，已交付的 [会话信息汇总](../../implemented/feature/2026-10-25-session-trace-summary.md) 里「写入尝试 / 读取请求」两组对 OMP 会话是空的。提取补 `path` 键（不猜其它近邻键，`command`/`pattern` 之类仍不提取），汇总层无需另写规则，键名统一后自动生效。这一项不在原需求里，但它与第五项同属「OMP 工具语义可读」，且不改就会让已交付功能对 OMP 半瞎，建议并进来。

推荐先做**摘要分派**、缓做色类：grep 显 pattern、glob 显 pattern、todo 显 mutation 摘要、task 显 agent 名与 task 首行、web_search 显 query、ask 显 question。原文列过 `wait`，OMP 没有这个内置工具（`wait` 是 `vibe` 工具的 op），删掉。理由是界面约定「布局解释结构，正常态不加装饰」——色类是既有语言，扩类要克制；先让摘要行本身可读，阅读效果不够再议色类。实现者评审时可推翻这个取舍，把理由记回来即可。

## 第二批交付（P1，逐项单独评审）

### TTSR 中断-重试识别

形态：一笔 abort/499 + 紧邻的同 conv_key 重试，且重试请求的新增消息里含 `<system-interrupt reason="rule_violation" …>` 注入（TTSR 流规则命中后中断、注入、原点重试，`docs/ttsr-injection-lifecycle.md`）。判据以注入特征为准，不是所有 499 都是 TTSR（用户手动 ESC 中断也是 499，其后继是新的用户输入）。**流量未实证**：全库 3 处 `system-interrupt reason="rule_violation"` 都在 `agent='claude'` 的请求里（System 块，不是 user 增量），OMP 侧 0 例；OMP 的 3 笔 499 后继关系全是 unknown。这条规则目前只有源码模板依据。

### 客户端重试/fallback 族

OMP 有客户端侧的失败重试与模型 fallback chain（`docs/non-compaction-retry-policy.md`）：相邻请求消息序列是共同前缀重放、`model_requested` 变化、前笔失败或中断 → relation 补注 `client_retry`。TTSR 是这个族的特例（同模型 + 注入），实现时合并成一个「重试族」的处理。注意与 magpie 网关侧 `tries` 是两层：网关在同一 route 里换供应商，OMP 在客户端换模型发新请求。注记只进展示，不进祖先判定。实测 OMP 会话内没有出现 `model_requested` 变化，这一族同样缺流量样本。

### 子代理启发式（最低优先，可不做）

主会话 `task` 工具调用的参数（agent 名 + task 文本）与时间窗内其它 conv_key 会话的首条 user 消息吻合，只能算候选线索。落成 confirmed 的误判代价是串会话，违反「身份不足不猜」。列在这里是记录「考虑过、倾向不做」；如果做，只做列表上的候选提示，不做链合并。

## 与并行工作的协调

[session-trace-summary](../../implemented/feature/2026-10-25-session-trace-summary.md) 与 [turn-pair-reading](../../implemented/feature/2026-10-25-turn-pair-reading.md) 都在读模型与展示层动刀。实现前先核对它们的当前落地状态与 UI 占位，读数页折叠行、会话列表条目、轮次带三处最容易撞。旁路降噪与会话信息汇总（session summary）对「哪些请求算数」的口径要一致：exclude 的请求不应进汇总的输入集合（现状已是如此，`src/queries/session-summary.ts` 按 `purpose_chain` 分主链与旁路）。

第五项的 `path` 键提取与汇总共用同一处实现（`src/derive/decision.ts` 的 `argsOf`），改动会同时影响 `tool_call.arg_path` 与 `derive_tool_result.arg_path` 两条路径，需要算法号 bump 重算；与汇总那篇的 backfill 路线一致。

## 交接给实现者

代码锚点：

| 关注点 | 位置 |
| --- | --- |
| purpose 规则与分类器 | `src/semantics.ts`（`title.reply.v1` 先例）、`src/request-purpose.ts`（`PURPOSE_VERSION` 管线、`readPurposeViewTx` 取数扩展） |
| 输入解释 | `src/input-interpretation.ts`（drop 清单已含 `system-notice`/`job`/`file`/`chat`；`cleanBlock` 是块级剥壳的现成实现） |
| 能力视图（tools/skills） | `src/capabilities.ts`（OMP 的 tagged skills 已可读，无需动） |
| 请求字段透出 | `src/skeleton.ts`（`request_without_messages`）、`src/protocols.ts`（`request_fields`） |
| 会话列表查询 | `src/queries/sessions.ts` |
| 轮次结算先例 | `src/queries/turns.ts`（读模型即时结算、不落表） |
| 派生判定（工具参数提取、展示决策） | `src/derive/decision.ts`（`argsOf` 的 `arg_path`/`arg_skill`、`presentationDecision`、`deriveTitle`） |
| 派生读端口 | `src/derive/read.ts`（`tailUserPreview`/`firstUserPreview`）、`src/derive/state.ts`（`derivedColSql`、`GROUP_ALGORITHM`/`DERIVE_ALGORITHM`） |
| 派生位选源先例 | `reply_shape` 三态（发布代优先、回收保留旧值） |
| web 步骤与工具色类 | `web/trace-view.js`（`dispatchSummary`）、`web/body-view.js`（`toolTint`）；会话列表与 chips 在 `web/app.js`；轮次带 `web/turn-band.js`；读数折叠行在 `web/rail-facts.js` |
| 新表落点 | `src/schema.sql`（新库建表）/ `src/schema-v6.sql`（视图与派生表），存量库按 `scripts/backfill-summary-facts.ts` 模式写幂等脚本；`bg_job` 是纯派生结算表，可整体重建，无数据搬迁负担，但表本身要显式建 |

OMP 源码参照（`repos-external/oh-my-pi`，注意 18.0.10 滞后于装机 18.12.6）：`docs/compaction.md`、`docs/session.md`、`docs/memory.md`、`docs/magic-keywords.md`、`docs/ttsr-injection-lifecycle.md`、`docs/non-compaction-retry-policy.md`、`docs/task-agent-discovery.md`、`packages/snapcompact/src/prompts/snapcompact-summary.md`、`packages/coding-agent/src/prompts/tools/async-result.md`、`packages/coding-agent/src/prompts/system/ttsr-interrupt.md`、`packages/coding-agent/src/tools/builtin-names.ts`、`packages/coding-agent/src/advisor/config.ts`。真实 session 样本在 `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`（只看 schema 与模板文案，不复制用户内容进 fixture）。

建议实现顺序：四（纯展示，最小）→ 五（工具名与 `path` 键，改动集中在一处）→ 一（取数扩展 + 规则 + 降噪）→ 二（解释 + 派生位 + 视图）→ 三（新表 + 配对）。每步一个提交，提交前 `bun run verify:notes`。

**升级路径要单独一步**：`upgradePurposeTargetTx` 只在显式 `bun run maintain rebuild --session <key>` 时执行，普通 tick 不升级 clean 的历史行。规则上线后，现有 9 个 OMP 会话不会自动改判，需逐个 rebuild 才能看到折叠与 `context_event` 效果。这一步写进交付清单，别只在验收里假定。

合成 fixture 清单（tests 只用合成数据，锚点文案可直接用上面的模板字符串）：旁路压缩调用会话、含 HISTORY 归档消息的请求（含块 0 是 `system-reminder` 的形态）、归档消息在后续请求重发的请求、bg_NNN 发起与通知跨两笔、bg_NNN 发起与通知在同一笔、复数通知 `N background jobs have completed.` 与 `── Job bg_NNN ──` 行、`<system-notice>` 里的非作业通知、带与不带 `reasoning_effort` 的 Chat 请求、OMP 小写工具名调用步骤（含 `path` 参数）、（第二批）TTSR 注入对与 fallback 重放对。

## 实施记录

随实现逐项回填；最终随 proposed → implemented 转写合并进 Decision。

- 2026-10-25 第四项已交付：effort 读数行落在「用量与上下文」折叠行（`usageFoldHtml` 第三参收正文首片，新增 `requestEffortOf` 从 `request_fields.reasoning_effort` 取值），装配处在 `web/app.js` 的 `railFacts`。值取自正文首片而非尝试链，因此单次干净调用（尝试链不渲染）也显示；未读正文或字段缺失时整行不渲染，不占位。
- 2026-10-25 第五项已交付。`argsOf` 补 `path` 键（`file_path` 优先，`command`/`pattern` 仍不提取）；OMP 源码 18.0.10 复核了参数形状：read 只收 `path`、write 收 `path`+`content`、edit 常态是 replace 模式 `path`+`old_string`+`new_string`、grep 是 `pattern`+`path?`、glob 的 pattern 本身在 `path` 键、todo 按 `op` 组织、task 收 `agent`+`task`、web_search 收 `query`、ask 收 `questions` 数组——摘要分派按这些形状落，核心键缺失走既有回退链。色类按验收标准补了 read/edit/write 的小写别名（与大写同色，不扩新类），grep/glob/todo/task/web_search/ask 落中性色，维持「色类是既有语言、扩类克制」的取舍。会话汇总的写入/读取分组与点击定位改按小写化工具名过滤。算法号 GROUP_ALGORITHM 3→4、DERIVE_ALGORITHM 7→8，`scripts/backfill-omp-semantics.ts` 按汇总回填先例建骨架（本提交只做全组标脏重派生，补列补表随后续交付扩展）。

- 2026-10-25 第一项已交付。`PURPOSE_VERSION` 3→4（与 zcode 提案的 3→4 撞车按实施时的当前值 +1 解决，本提案取 4，两篇锚点在 zcode 实施时各自对齐）；`readPurposeViewTx` 扩取数收 `userBlockHeads`（前 5 条 user 消息、逐块取前 200 字符，双限额让成本不随正文体积增长）；`skillHintDecision` 按分类器强指纹先例进规则链，位置在分类器之后、来源 kind 之前。列表降噪走推荐方案：`listSessions` 聚合 `has_participate` 给 `bypass` 标志（判定要求会话内零参与链请求），渲染层过滤 + 折叠计数行（`sessionsListBypassHtml`），不动游标，计数只覆盖已加载页。

- 2026-10-25 第二项已交付。解释层：归档消息改判 `injected`、kind `omp_history_archive`（`finalize` 在剥壳后的拼接文本上判锚点）。事件位：`request` 与 `derive_request_result` 各加 `context_event` 列（`none`/`omp_compaction`，NULL 从未判定），两个视图同步带列；判定适配 `contextEventTx` 收 relation+delta——first/confirmed 按确定增量新增归档判，branch 按输入含归档归因（bounded 扫前 20 条 user 消息，归档实测在 ord 1），aux 判 none，其余判不出保留旧值，与 `reply_shape` 三态同套选源语义。dropped 字符数进 basis（同步路径并进 `summary_basis` 的 JSON，切片路径在摘要阶段对压缩行覆写 `basis_json`）。branch 归因注记落在展示层：轨迹 `compaction` 记录步骤（带丢弃量，注明字符数非 token）与关系文案「另起一支 · 压缩归档改写了上下文前缀」。切片与同步的 parity 测试列加 `context_event` 锁两路一致。存量库由 `backfill-omp-semantics.ts` 补列并从 schema-v6.sql 重取视图 DDL。

- 2026-10-25 第三项已交付。`bg_job(conv_key, job_id)` 结算表建在 schema.sql 与回填脚本两处；列名与提案的 `spawn_call_ord` 有一处偏差：spawn 记的是**承载发起工具结果的消息 ord**（`spawn_ord`），不是调用 ord——展示锚点是发起处的 bash 结果行，按消息 ord 直接对位轨迹步骤，不必再 join tool_call。发起只认 role=3 工具结果块（matchAll，一个结果多行发起都能收），通知只认 user 消息里单数完成句与复数公告下的 `── Job bg_N ──` 行；conv 内最早位置先到先得，重发不改判。重建语义对照工具配对：组完成事务里按可读正文整体重算本 actor 的行，两端正文都回收的行保留（retained），重算与保留行撞键时保留行胜（它记的更早位置）。旁路请求不参与配对。配对挂进同步路径组完成（与 tool_call 同批）；切片路径同 tool_call 先例不写这张表，note 如实记录该边界。展示：`/api/sessions/:key/bg-jobs` 端点 + reader-store 快照；轨迹发起结果行尾注配对读数（`bg_N 已配对 · 2.31 s` / `同一请求内` / `等待完成通知`），完成通知出 Event 步骤（该消息被解释层判 injected 本来不占气泡）。

## Alternatives considered

**读 `~/.omp/agent` 作第四路证据源。** session JSONL 是结构化金矿：`model_usage`（api/provider/model/purpose/usage 含 cost 与 reasoningTokens）、`compaction`（tokensBefore/After/firstKeptEntryId）、`title_change`、`thinking_level_change`、`custom` 事件（tool_execution_start、async-result）、header 的 `parentSession`/`previousSessionFiles` lineage 能解掉子代理与 advisor 的归并问题。否决理由：架构设计的安全边界明写「不扫描 Agent 会话文件，只读 magpie 自己写的来源」；引入第四源是方向性决策，需要用户单独拍板（见边界外），不该夹带在本提案里。

**OMP extension hook 桥。** 用户 `~/.omp/agent/extensions/` 里已有 `ata-omp-trace` 先例（OMP extension 往本机端口推 pi-hooks 事件、读 `PI_SUBAGENT_*` lineage env），同型桥可以给 ATC 提供 magpie 看不见的 harness 语义（turn 边界、工具执行时序、子代理 lineage）。否决理由同上：新证据通道 + 与 OMP 版本耦合的维护面，属边界外决策项。

**开 OMP 的 OTel。** OMP 支持 OTLP 三信号（默认关，`OTEL_*` 开启，service name `oh-my-pi`）。否决理由：信号与现有三路大量重复，换来的是第二套采集运维面，性价比最低。

**时间邻接的旁路会话归并。** 把 20:59:56 的四个压缩会话与 21:00 的主会话按时间窗挂接。否决理由：无证据链，纯启发式；advisor 的 session id 是刻意随机化的，说明 OMP 有意在 provider 侧切断会话关联，我们硬猜会猜错。

**改 magpie 上游补 subagent 标注。** magpie 的 subagent 识别只覆盖 Claude Code 与 Codex；给 OMP 加识别要改上游。否决理由：超出本项目边界，且 OMP 子代理本来就是独立子进程会话，上游改动的收益不如 extension 桥。

**把 `context_event` 判据写成「输入里含归档消息」。** 归档消息在会话每笔请求都重发，这条判据会给整场会话每一行挂压缩标记，降噪变成加噪。改用 delta 判据。

## Acceptance criteria

合成验收（每条规则一个 fixture，断言进 `bun test`）：

1. 任一 user 文本块块首命中 `Compress into one routing hint` 的请求判 `skill_hint`/`exclude`（含块 0 为 `system-reminder`、块 1 才命中的形态）；同会话混入一笔参与链的请求时不折叠。
2. 含 HISTORY 归档消息的请求：解释结果 `injected` 且 kind `omp-history-archive`；`context_event='omp_compaction'` 且 basis 记 dropped 数；标题选源跳过该消息（该会话标题退化为 `model_time`，作为预期值断言）；同一归档消息出现在后续请求时 `context_event` 仍为 `none`；`branch` 请求带 `branch_by_compaction` 注记（仅合成 fixture，生产暂无样本）。
3. bg_NNN 发起与通知跨两笔配对为 resolved，时延按请求 `started_ms` 差；发起与通知同笔时标注「同一请求内」且不给数值时延；通知缺失时 state 停在 pending；复数通知形态能配对；`<system-notice>` 的非作业通知不参与配对；同一 conv 内发起痕迹被后续请求重发时仍取最早 `role=3` 位置。
4. 带与不带 `reasoning_effort` 的请求在读数页分别显示与不显示该行；单次干净调用（尝试链不渲染）也显示。
5. OMP 小写工具名调用的步骤摘要按分派显示参数要点；小写 read/write/edit 命中对应色类；`path` 参数的调用在会话汇总里进「写入尝试 / 读取请求」。
6. （第二批）TTSR 注入对识别为中断-重试；纯 499 + 新用户输入不误判；fallback 重放对注记 `client_retry`。

真实数据人工验收（生产库，与合成验收分开报告，数字随流量增长，按相对表述判）：

1. 全部请求 `exclude` 的会话在列表里折叠、显示折叠计数、可展开；任一请求参与链的会话保持可见。
2. 24 笔那个会话出现压缩标记与 bg 配对（含同笔内配对与跨笔配对两种）；归档消息所在请求之外的请求不带压缩标记。
3. 读数页显示 effort（单次干净调用也显示）；会话标题不再是 `Resume prior conversation…`。
4. 升级路径：对现有 OMP 会话逐个 `rebuild --session` 后上述效果才出现；未 rebuild 的会话保持旧判定。

## Risks

- **模板漂移**。源码 18.0.10 与装机 18.12.6 已有实证差异（routing hint 文案在源码树里不存在）。所有锚点规则必须带版本号进 purpose 体系，并沿用形状探针思路：锚点失配时规则静默退化为 `unrecognized`，不报错、不误判，降噪失效只是回到现状。
- **误降噪的代价**。错 exclude 会把真会话从视野里藏掉。缓解：折叠必须可展开、判定要求全量 exclude、`bypass` 只影响列表默认态不影响任何派生。
- **标题退化为时间兜底**。归档消息改判注入后，压缩起点的会话失去内容标题，只剩模型名加时间。这是「不再污染」与「仍有内容」之间的取舍，代价如实记录；后续若要补回内容标题，需要第四源或 extension 桥，属边界外。
- **启发式误判**（第二批）。TTSR 与重试族的注记错误只影响展示注记，硬边界是不进祖先判定、不影响轮次结算。两项目前都缺 OMP 流量样本，实现后可能长期不触发，不能以「生产没看到」判为规则错误。
- **采集覆盖的系统性缺口**。46 对 24 的对账差异未解：如果 OMP 相当一部分流量不过 magpie，本提案派生得再好也只是已采集流的语义。覆盖率审计是独立工作，不阻塞本提案，但值得排期。
- **`arg_path` 口径变更影响面**。补 `path` 键会让 OMP 会话汇总的路径分组从空变成有值，同一会话的历史数字会跳变；两条派生路径都要重算，算法号 bump 与 backfill 顺序要对齐。
- **版本基线**。本文的生产数字是 2026-10-25 23:03 快照，引用需带时间（仓库惯例）。装机版本与源码版本的行为差异未逐项核对，实现中遇到锚点对不上时优先信流量、再查装机版本源码。

## 边界外（P2 决策项，需用户拍板，不在本提案内）

- `~/.omp/agent` 第四路证据源（安全边界豁免 + 隐私口径）。
- OMP extension hook 桥（`ata-omp-trace` 同型，拿 turn 边界与子代理 lineage）。
- OTel 旁路采集。
- 模型角色语义：wire 上只有 `group/…` 组名，role→group 映射在 `~/.omp/agent/config.yml`，要讲清角色得读本地配置，同属第四源决策。
