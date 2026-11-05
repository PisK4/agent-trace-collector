# 本地 Agent 覆盖矩阵

本文回答两件事：本机 19 家本地会话 Agent 各自处在什么位置，以及下一批适配器按什么顺序接。`src/sources/catalog.ts` 是目录骨架，只有 `agent`、`sourceKind`、`format`、`status` 四列，用来防止目录与注册表漂移。真实覆盖与接入顺序在这里展开；`docs/architecture-design.md` 的「本地 Agent 会话适配器」写已实现适配器的现行行为，`docs/acceptance.md` 写各轮验收读数，都不在这里复述。

读数采集于 2026-11-04，来自本机只读扫描与生产库 `~/Library/Application Support/tracery/trace.db` 的聚合查询。文件数与字节数只 stat，不读正文；真实请求正文、账号与令牌不进本文。

## 三个口径别混

| 口径 | 含义 | 从哪看 |
| --- | --- | --- |
| 有适配器 | `registry.ts` 数组里登记了这家，能发现、解析、归约成调用 | `source_cursor` 里有没有对应 `source_kind` 的游标 |
| 本机有数据 | 根目录存在且有会话文件，或有网关侧请求行 | 根目录扫描、`request.agent` 聚合 |
| 已入库 | 这家的数据已经落成 `request` 行 | `request` 按 agent 分组、`request_evidence` 按 `source_kind` 分组 |

三者可以两两不同。Qoder 在本机有数据，却没有适配器；目录里标 `unimplemented` 的几家大多连根目录都没有；同一家也可能只有网关侧行而没有本地游标，或反过来。把其中任何一个口径当成「已支持」，报告就会失真。

## 生产库现状

`request` 按 agent 分组（2026-11-05 读数，随使用增长）：

| agent | request | 首日 | 末日 | 证据来源 |
| --- | --- | --- | --- | --- |
| claude | 58,282 | 2026-10-24 | 2026-11-05 | hook / ledger / route / `claude_session_call` |
| codex | 17,715 | 2026-08-30 | 2026-11-03 | `codex_session_call` / 账本 |
| omp | 13,644 | 2026-09-28 | 2026-11-05 | `omp_session_call` / 账本 |
| droid | 9,582 | 2026-08-21 | 2026-08-30 | `session_call` |
| zcode | 6,630 | 2026-10-05 | 2026-11-04 | `zcode_session_call` / 账本 |
| hermes | 6,393 | 2026-10-26 | 2026-11-05 | hook / ledger / route / `hermes_session_call` |
| pi | 3,142 | 2026-08-21 | 2026-09-02 | `pi_session_call` |
| dsh | 2,542 | 2026-08-22 | 2026-09-04 | `dsh_session_call` |
| magpie | 435 | 2026-10-26 | 2026-11-05 | 账本 / 路由 |
| workbuddy | 141（已到 EOF） | 2026-09-03 | 2026-09-03 | `workbuddy_session_call` |
| grok | 139（已到 EOF） | 2026-09-23 | 2026-09-23 | `grok_session_call` |
| 其它直连客户端 | 59 | 2026-10-25 | 2026-11-04 | 账本 |

十家本地会话来源有游标：claude 174、codex 383、omp 273、zcode 83、dsh 77、pi 46、droid 216、workbuddy 6、grok 6、hermes 159（droid 走独立定时器，不在 `registry.ts` 轮转里）。`ingest_issue` 当前落在 `omp_session`（64 条，消息内容与角色格式）、`otlp_span`（8 条）与 `zcode_session`（1 条，会话根不可读），其余来源为 0。DSH 回填收敛与批次 A 首轮的对账见[验收记录](acceptance.md)。

Hermes 有网关侧与本地两条路径。网关侧的行由 hook、账本、路由三种证据构成；本地 `~/.hermes/state.db` 由 `hermes_session` 适配器读取。本地行用首条 user 消息的 magpie 摘要挂到网关会话，摘要在本库不唯一（同 prompt 的 oneshot 会话）或算不出时退回本地会话键，不按时间近邻猜会话坐标。是否与网关行是同一笔由通用 owner 匹配决定：`messages.timestamp` 是落库时刻，按完成时间 ±2 秒唯一命中才合并；只有消息没有落库时刻时才退回弱开始窗。逐笔用量本地不可得，只有 `session_model_usage` 的会话级聚合。设计与真实读数见 [Hermes 会话适配器 note](../.agents/notes/implemented/feature/2026-11-05-hermes-session-adapter.md) 与[验收记录](acceptance.md)。

## 19 家矩阵

「本机数据」列是 2026-11-04 的只读扫描结果。「参照」列是 `repos-external/magpie/internal/sessions/` 下有没有对应解析器，以及有没有专用的 `calls_*.go` 调用解析；这些文件只读，不作为运行时依赖。

| Agent | 目录 status | 本机数据 | 生产库 | Magpie 参照 | 接入批次 |
| --- | --- | --- | --- | --- | --- |
| claude | `implemented` | `~/.claude/projects` 有 348 个 jsonl | 58,282 / 174 游标 | `claude.go`、`claude_usage.go` | 已接（第一版） |
| codex | `implemented` | `~/.codex/sessions` 含 zst 归档 | 17,715 / 383 游标 | `codex.go`、`codex_discovery.go`、`codex_usage.go` | 已接（第一版） |
| zcode | `implemented` | `~/.zcode/cli/db` SQLite | 6,630 / 83 游标 | `zcode.go`、`calls_zcode.go` | 已接（第一版） |
| omp | `implemented` | `~/.omp/agent/sessions` 多根 | 13,644 / 273 游标 | `omp.go` | 已接（第一版） |
| pi | `implemented` | `~/.pi/agent/sessions` | 3,142 / 46 游标 | `pi.go`、`calls_pi.go` | 已接（第一版，共用 OMP 解析） |
| dsh | `implemented` | `~/.dsh/sessions` 77 目录 / 32.9 MB | 2,542 / 77 游标 | `dsh.go`、`calls_dsh.go`、`frames.go` | 已接（第二版） |
| droid | `implemented` | `~/.factory/sessions` 648 文件 | 9,582 / 216 游标 | `droid.go` | 已接（独立定时器） |
| workbuddy | `implemented` | `~/.workbuddy/projects` 6 个 jsonl / 3.65 MB，含 4 个 subagents 文件 | 141 / 6 游标 | `workbuddy.go`、`calls_workbuddy.go` | 批次 A（已交付） |
| grok | `implemented` | `~/.grok/sessions` 6 会话 / 23 个 jsonl（`chat_history`、`events`、`updates`、`rewind_points` 各 6 份，另有 1 份 `prompt_history`），含 `summary.json`、`usage.json` | 139 / 6 游标 | `grok.go`（`readGrokSummary`、`parseGrok`、`grokUsage.tokens`） | 批次 A（已交付） |
| qoder | `local_data` | `~/.qoder` 566 文件 / 78 MB；119 个 jsonl 共 1,164 行事件，零 assistant 回复与零 usage 字段 | 无 | `qoder.go`（仅 `QoderDir`，调用解析复用 `ccFiles`） | 不排期（等可读会话样本） |
| hermes | `implemented` | `~/.hermes/state.db` 168 会话 / 11,762 行消息，含压缩归档与 rewind 三态 | 6,393 / 159 游标 | `hermes.go`、`hermes_display.go` | 已接（批次 C） |
| codebuddy | `unimplemented` | `~/.codebuddy` 仅 3 个 memwatch 日志，无 `projects/` 目录 | 无 | `workbuddy.go` 的 `codebuddyFiles()`、`buddyFiles()`（与 WorkBuddy 共用） | 不排期（等项目会话目录） |
| opencode | `unimplemented` | `~/.config/opencode` 仅 3 个配置文件，无会话库 | 无 | `opencode.go`、`calls_opencode.go`、`traces_opencode_db.go` | 批次 C |
| qoder-cn | `unimplemented` | 无根目录 | 无 | `qoder.go`（`QoderDir("qoder-cn")`） | 不排期 |
| cline | `unimplemented` | 无根目录 | 无 | `cline.go` | 不排期 |
| cursor | `unimplemented` | 无根目录 | 无 | `cursor*.go`、`cursor_editor.go` | 不排期 |
| alma | `unimplemented` | 无根目录 | 无 | `alma.go` | 不排期 |
| kimi | `unimplemented` | 无根目录 | 无 | `kimi.go`、`calls_kimi.go`、`transcript_kimi.go` | 不排期 |
| agy | `unimplemented` | 无根目录 | 无 | `agy.go`、`calls_agy.go` | 不排期 |

目录 status 与本机实测有出入的地方，以矩阵为准：`~/.codebuddy` 与 `~/.config/opencode` 有根目录，但里面没有会话文件，标 `unimplemented` 描述的是「格式已知、本机没有数据」，不是「没装」。目录骨架不存这些细节，所以本文补上。

## 格式差异决定工作量

未接入的几家解析难度差别很大，按「一份文件能不能独立还原一笔调用」排。批次 A 两家的实现已交到[验收记录](acceptance.md)，下面保留格式差异作为后续批次的判据：

**WorkBuddy 最接近现有适配器。** `~/.workbuddy/projects/<project>/<uuid>.jsonl` 每行是带 `id`、`timestamp`、`type`、`role`、`content` 的消息；抽样一个主会话有 45 条 `role=assistant`、15 条 `role=user`，另有 `function_call`、`function_call_result`、`reasoning`、`output_text` 等行型。`subagents/agent-*.jsonl` 与主会话同形。这与 Claude Code 适配器的消息窗口模型一致，正文协议可复用 `anthropic` 或 `chat` 的判断路径。Magpie 的 `calls_workbuddy.go` 有逐行建调用的实现可核对。

**Grok 是「一个会话多个文件」。** 每个会话目录有 `chat_history.jsonl`（system / user / assistant / reasoning / tool_result 等行型）、`summary.json`（会话 id、cwd、模型、消息数）、`usage.json`（四段 token、`modelCalls`、`turnCount`、`modelUsage` 累计）、`events.jsonl`、`rewind_points.jsonl`、`tool_definitions.json` 等。抽样一个会话的 `chat_history.jsonl` 有 107 条 assistant 与 107 条 reasoning，`usage.json` 记 `modelCalls: 107`，两者能对上。逐笔用量在会话级累计里，没有逐调用的 token 行；要建 request 得从 chat_history 的消息边界切调用，用量只能按会话累计摊或留空。共用摄入的 `SessionCall` 要求 `usage` 四段齐全或为 null，这里倾向留 null 并把累计值放进 `session_usage`，与 droid 的处理一致。

**Qoder 是日志事件流，本机可读文件里没有模型调用。** 2026-11-04 对 `~/.qoder` 的全量结构扫描（只看字段名与值类型，不读正文）：566 文件 / 78 MB，119 个 jsonl 共 1,164 行 JSON 全部合法，零坏行；出现的字段是 `type`、`ts`、`seq`、`level`、`data`、`turn_id`，`type` 值集中在 `session.phase.started/finished`（526 条）、`hook.started/finished`（456 条）、`session.config.loaded`（80 条）、`cli.route.entered`（80 条）。带 assistant 角色的文件 0 个，带 `usage` 字段的文件 0 个，`role` 值一次都没出现；调用相关只有 1 条 `model.request.started` 与 1 条 `model.request.attempt_failed`，没有成对回复或完成事件。`~/.qoder/projects` 只有 1 个 10 行 jsonl，内容是 workspace-directories、runtime-config、一条用户消息、4 条 attachment 与 active-leaf。`~/.qoder/logs/runs/*/qodercli.log` 158 个 CLI 日志共 139,041 行、22 MB，只有 18 行沾到 `assistant`、`completion`、`model.request`、`input_tokens` 等关键词，形态是日志语句，不是可还原的调用记录。

Magpie 的 `qoder.go` 注释说 `projects/<项目>/<id>.jsonl` 与 Claude Code 同形（`user`/`assistant` 加 Anthropic usage），调用解析走 `ccFiles("qoder", QoderDir("qoder"))` 复用 Claude Code 的 `projects` 形状；本机这份数据没有体现这个形状，注释只做目录定位，不是可核对的调用样本。生产库 `request` 里也没有 qoder 任何一行，连网关侧证据都没有。侦查结论与判据见[批次 B 侦查记录](../.agents/notes/implemented/process/2026-11-04-batch-b-source-recon.md)。

**CodeBuddy 连会话目录都不存在。** `~/.codebuddy` 只有 3 个 `cli-memwatch-*.log`（内存与 CPU 采样），`~/Library/Application Support/CodeBuddyExtension` 下只有 1 个 4 KB 的 auth 文件；没有 `projects/`。Magpie 的 `codebuddyFiles()` 与 WorkBuddy 共用 `buddyFiles()` 读 `projects/`，复用批次 A 的解析器本身成本低，但本机没有可读样本，合成 fixture 之外的验收为零。

Hermes 是另一类：`~/.hermes` 下有多个 SQLite 库与 20 万个文件，Magpie 的 `hermes.go`、`hermes_display.go` 处理的是它自己的 `state.db` 形状。它的展示顺序由 `display_order` 决定，不是插入 id：压缩与 rewind 会插入新副本，本机有 1,748 行的 id 序与展示序不一致。适配器照抄 Hermes 自己的展示投影，退化成「按 id 排」会直接打乱请求窗口；逐笔用量在本地库里不存在，只有会话级聚合。

## 分批路线

判据按优先级排：本机有真实会话数据、格式能还原逐笔调用、与已实现适配器同构、不需要先解决跨来源去重、有 Magpie 解析器可核对。没有真实样本的不排期，避免把「已支持」写进报告却无法验收。

### 批次 A：WorkBuddy 与 Grok（已交付）

两家都有真实会话文件，格式可还原调用，Magpie 有现成解析器。两家各走一个 `worktree` 分支、合成 fixture、生产部署与逐项对账，共享登记面先由准备分支一次铺好，避免两处实现同时改同一批文件。WorkBuddy 按 `providerData.messageId` 把同组行归成一笔调用，子代理折叠到父会话；Grok 一个会话目录一条流，单笔用量留 null、累计值写 `session_usage`。两家的首轮生产读数与已知边界见[验收记录](acceptance.md)。

### 批次 B：Qoder 与 CodeBuddy（侦查后不排期）

按[批次 B 侦查记录](../.agents/notes/implemented/process/2026-11-04-batch-b-source-recon.md)，两家的本机数据都不足以还原一笔调用：Qoder 的 119 个 jsonl 零 assistant、零 usage，`projects` 只有 10 行骨架，158 个 CLI 日志里只有 18 行沾到调用关键词；CodeBuddy 连 `projects/` 目录都没有。生产库也没有这两家的网关侧行。按「每批完成条件」第 3 条，写出来的解析器无法做生产对账，只能靠合成 fixture 自证，与「没有真实样本的不排期」判据冲突，因此本批不落地代码。

恢复排期的判据是「至少有一个文件同时含 assistant 回复与逐笔用量」，不是「目录里有 jsonl」。Qoder 若换版本把调用正文写进 `projects/`，或 CodeBuddy 建出项目会话目录，重新做一次结构侦查再排；CodeBuddy 届时可复用 WorkBuddy 的 `buddyFiles()` 同构解析。

### 批次 C：OpenCode（Hermes 已交付）

Hermes 的本地适配器已交付：顺序照抄 `display_order` 展示投影，会话坐标用唯一时才采信的 magpie 摘要，逐笔用量留 null、累计值写 `session_usage`。实现在 `src/sources/session/adapters/hermes.ts`，设计与实测见 [Hermes 会话适配器 note](../.agents/notes/implemented/feature/2026-11-05-hermes-session-adapter.md)，生产读数见[验收记录](acceptance.md)。OpenCode 本机只有配置文件、没有会话库，等有真实数据再排。

### 不排期

qoder、codebuddy 两家有根但没有可读的调用数据（见批次 B），qoder-cn、cline、cursor、alma、kimi、agy 六家在本机没有根目录，也没有真实样本；八家都不写解析器。`catalog.ts` 保留它们是为了目录与 Magpie 对齐。Wake 的 24 项清单里另有 Grok Bot、Kiro、Gemini、Copilot、Antigravity、Openclaw、CraftAgents、Devin、Kilo、MimoCode 等候选，比 Magpie 的 19 家多出一批桌面与新客户端；根路径不可靠就不凭猜测加扫描路径。

### 每批的完成条件

一批适配器交付时，按下列顺序核完，缺一项就不宣称接入：

1. `src/sources/files.ts` 的 `SourceKind` 与 `registry.ts` 各加一行，`catalog.ts` 的 `status` 改 `implemented` 并填 `sourceKind`。
2. 合成 fixture 覆盖首次摄入、追加读取、坏行停游标、子代理折叠与证据键不相撞；窄测试先过，再跑 `bun test` 与 `bun run typecheck`。
3. 生产部署后对账：游标数、原始层 assistant 行数、`request` 行数、`request_evidence` 的 `ref_key` 唯一数四者相等或差额有解释；`ingest_issue` 与重复 owner 为 0。
4. 抽样一笔走 `/api/requests/<id>/body`，确认正文协议与页面可读。
5. 读数追加到 `docs/acceptance.md`，本文的矩阵与生产库现状同步更新，架构设计补该家的根与形态。

## 与 Wake 的对标

Wake 的 `crates/wake-core/src/models.rs:39` 用 `AgentId::ALL: [AgentId; 24]` 钉死 24 个 Agent，枚举声明序同时是侧栏展示序，注释写明新增 Agent 要问过用户再定位置。比 Magpie 的 19 家多出 Grok Bot、Kiro、Gemini、Copilot、Antigravity、Openclaw、CraftAgents、Devin、Kilo、MimoCode 这一批桌面与新客户端。ATC 的目录以 Magpie 的 19 家为准，Wake 多出的候选先不登记，理由见分批路线的「不排期」。

Wake 给每家 Agent 一个 adapter 文件：`crates/wake-core/src/adapters/` 下有 30 个 `.rs`，按 id 一一对应并含变体（Grok 分 `grok.rs`、`grok_bot.rs`、`grok_group.rs`，Cursor 分 `cursor.rs`、`cursor_ide.rs`，另有 `claude_desktop.rs`）。契约测试 `crates/wake-core/tests/adapter_contracts.rs` 为 24 家里的绝大多数写了独立的 `*_parse_contract()`，例如 `qoder_parse_contract()` 在 1767 行、`grok_parse_contract()` 在 2662 行、`workbuddy` 没有独立用例而是由 `codebuddy_parse_contract()`（7347 行）覆盖。这说明 Wake 的「登记了名字」与「有完整 transcript 解析」是同一层：一个 id 进 `ALL` 就有 adapter 与契约测试。

ATC 不照搬这个结构。`catalog.ts` 的 19 家是目录骨架，其中 7 家才有适配器；目录状态与解析能力分成两层，是为了让「本机有这家、但还没接」这件事在页面上可见，不被误读成零调用。Wake 的清单是产品要支持哪些 Agent，ATC 的目录是本机可能有哪些来源，两边的问题不同。照搬 Wake 的单层结构，会把「本机有这家、但还没接」写成「已支持」。

Wake 的适配器契约在 `crates/wake-core/src/adapters/mod.rs:48` 的 `AgentAdapter` trait 里，几条与 ATC 直接对应：

- `detect()`（第 57 行）由 `data_roots().iter().any(|p| p.exists())` 派生，注释明写不要覆写，因为面板逐路径的 `exists()` 必须用同一判据；手写 `is_dir`/`is_file` 与它打架是历史上反复修的缺陷。ATC 的 `catalog.ts` 状态靠手工维护，`source-health` 未落地，这一条正是自动检测该守的边界。
- `list_session_files()`（第 65 行）的契约是枚举必须廉价、绝不全量解析：多数家只 stat，SQLite 型跑元数据查询，DSH 读有界首行。根不在就返回空；读不出返回 `Err`，scanner 冻结这一家这一轮，库里归它的行原样留着，别家照常。ATC 的 `discover` 与 `root_unreadable` 是同一套语义。
- `quick_meta()`（第 94 行）是不解析文件直接给 meta 的快路径，默认 `None`，Codex、Copilot、Hermes、OpenCode、Cursor IDE、Antigravity 等有状态库或边车的 Agent 覆写它；`merge_quick_meta()` 默认以 parsed 为准、quick 补缺。ATC 的 Zcode 用 `storesRaw:false` 与物化行达到相近目的。

`crates/wake-core/src/scanner.rs` 把变化的文件入队后台解析，文件按 `(mtime, size)` 判断脏；`Skip` 枚举（第 95 行起）区分库已在、库缺失、拿错索引、镜像目录不在旁边四种收场。ATC 的[覆盖护栏](../.agents/notes/implemented/feature/2026-11-04-coverage-foundation.md)已经把廉价发现、live/backfill 两档调度、单家失败冻结落进共用摄入，不需要再建一套索引。

## 边界

本文的读数是 2026-11-04 的一次快照，文件数、字节数与 request 数会随使用增长，重新测量时不要直接引用这里的数字。`source-health` 与真实覆盖状态的自动计算还没有实现，目录 status 目前靠手工维护；[数据源契约漂移检测](../.agents/notes/proposed/feature/2026-11-04-source-contract-drift.md)与[采集健康监控](../.agents/notes/proposed/bug-fix/2026-11-03-monitoring-health-check-findings.md)是后续议题。本文不写适配器实现，不替代 `src/sources/session/types.ts` 的契约。
