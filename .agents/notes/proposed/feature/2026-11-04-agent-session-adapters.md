# Agent Note: 本地 Agent 会话适配器第一版

Status: proposed

本文承接[多来源同一调用的身份归一与去重](2026-11-04-multi-source-call-identity.md)。那篇定义适配层要交出的字段和认领顺序；本文定义这些字段从本机会话里怎么读出来。droid 的[现有摄入](../../implemented/feature/2026-11-04-droid-session-ingestion.md)是第一个实例，本文把它抽成多家共用的采集缝，并给出第一版适配器范围。

它部分取代 [zcode 的 Agent 支持](2026-10-24-zcode-agent-support.md)里「不直接摄入本地 zcode 库」的否决。多来源提案已经把本地库改为主来源，本文补上采集实现；那篇的用途识别与标签规则仍然有效。Codex 的辅助线程归类归 [Codex 接入](2026-11-03-codex-integration.md)，Hermes 的用途识别归 [Hermes 接入](2026-10-27-hermes-agent-integration.md)，本文不重复。

**取代检查。** 活动树里没有记录持有「多 Agent 本地会话采集」这一决策。`2026-11-04-multi-source-call-identity` 只定义身份与去重；`2026-11-04-source-contract-drift` 只定义漂移检测；`2026-11-04-droid-session-ingestion` 只覆盖 droid 一家。本文补的是采集层：发现哪些 Agent、怎么廉价枚举、怎么按增量解析、怎么把一家读坏控制在自家范围内。

本文与多来源提案分开，是因为两层的失败模式不同：采集层坏在文件格式、库锁与增量读取，身份层坏在错并、漏并与候选歧义。合在一篇，验收边界会混在一起。

2026-11-04 对 Magpie、Wake 与本机会话目录做过只读核对。文件数与体积是当天快照，不是验收结果。

## Problem

### 只有 droid 在读本地会话

ATC 现在能从 magpie 账本、路由、hook、OTLP 与 droid 转录里拿到请求。Claude Code、Codex、Zcode、OMP 的本地会话没有入口，只能等它们的请求经过 magpie。直连调用、本地已删除但网关没记的会话、以及本地独有的子代理谱系，都会缺。

用户要的是同一段对话在 ATC 里能看到完整 trace，不要求每个 Agent 都有同样的字段密度。能还原多少就还原多少，缺的字段留空，不猜。

### 本机的量级不允许每次全量解析

2026-11-04 只读统计：

| Agent | 默认根 | JSONL 文件 | 体积 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects` | 330 | 1.8 GB |
| Codex | `~/.codex/sessions` | 296 | 1.1 GB |
| OMP | `~/.omp/agent/sessions` | 441 | 392 MB |
| Pi | `~/.pi/agent/sessions` | 46 | 37 MB |
| droid | `~/.factory/sessions` | 216 | 114 MB |

合计约 3.4 GB。启动时全量解析会拖住进程，每一轮重新扫也会把 CPU 和磁盘读放大。droid 的全量扫描用了 49 批、30.5 秒才读完 111 MB；照这个速度，五家一起全量解析会让采集器长时间占用事件循环，页面读取也会被拖慢。

### 每家的格式与身份材料不一样

Claude Code 的 assistant 行带 `message.id`，去掉 `msg_` 后通常等于网关的 `response_id`；行时间是回复结束，开始时间取同一回合上一条消息的时间，有 `durationMs` 时用时长反推。Codex 的 rollout 带 `response_id` 与 thread/turn；用量记录在回合末，也要反推开始。Zcode 的本地库是 OpenCode 表结构，消息带四个 token 数和 `time.created`，没有 response id。OMP 与 Pi 共用一种 JSONL，assistant 消息带完整 usage、`durationMs`/`duration` 和消息 id，子代理放在会话文件旁的 artifacts 目录。

droid 已经有解析器，但它的摄入循环、认领、正文、游标与 issue 逻辑写在一家自己的文件里。再复制四份，会把同一套 owner 查找和证据写入散到五个地方，后面修一个去重缺陷要改五遍。

### 对标的是会话解析器，不是 Agent 注册表

Magpie 的 `Clients()` 有 60 多个条目，其中大量是网关接线、桌面客户端和 IDE；它真正读本地会话的 `internal/sessions/sessions.go` 里，`Session.Agent` 注释只列了 19 种：claude、codex、opencode、pi、omp、zcode、dsh、cline、qoder、qoder-cn、grok、workbuddy、codebuddy、droid、cursor、hermes、alma、kimi、agy。Wake 的 `AgentId::ALL` 是 24 种，多出的包括 Gemini、Copilot、Kiro、Antigravity 这类桌面 Agent。第一版目录以 Magpie 的 19 种为准；Wake 多出的作为候选，根路径不可靠时标 `unknown_root`，不凭猜测加扫描路径。

第一版不追这个数量。每多一家，就要多一套解析器、身份语义、合成 fixture 和真实样本核对；没有真实数据支撑的适配器只会制造假覆盖。第一版先做本机正在用、身份材料最清楚、能与 magpie 对账的五套适配器（六家 Agent）。

### Wake 的秒开不是因为不用数据库

Wake 有持久化 SQLite 索引，`crates/wake-core/src/db.rs` 里的 `sessions`、`messages`、`messages_fts` 都是实表，还有 `schema_meta` 与重建逻辑。`crates/wake-core/src/scanner.rs` 的扫描也是先把变化的文件入队，再在后台解析。它打开快的原因是：

- 列表只查索引，不解析文件；
- 枚举会话文件只做 `readdir` 与 `stat`，不做全文解析；
- 文件按 `(mtime, size)` 判断变化，只解析变化的那一份；
- Codex 这类有状态库的 Agent 走 `quick_meta` 快路径，先让列表出现；
- 详情页打开时才调用 `parse_transcript` 解析整段会话；
- 扫描在后台跑，UI 先显示已有索引。

ATC 已经有 SQLite 与读取架构，不需要再建一套索引。需要借的是这套分层：廉价发现、增量解析、按需读取、单家失败不拖垮全局。

### 目标

- 第一版接入 Claude Code、Codex、Zcode、OMP/Pi 与已有的 droid。
- 本机其他 Magpie 会话 Agent 能被发现并标出「已安装、未支持」，不伪装成零用量。
- 每家适配器只产出多来源提案定义的归一字段；认领、证据、正文与派生继续走现有路径。
- 枚举不读正文，解析只读新增字节；启动不阻塞，页面读取不触发扫描。
- 一家读坏时只冻结这一家，其他来源继续；坏行不静默跳过。

### 非目标

- 不在第一版实现全部 19 种 Magpie 本地会话解析器。
- 不监听文件系统事件，不接远程主机，不做自定义根目录。
- 不自动回填全部历史，不自动修改上游文件。
- 不为每家新建一套用途分类；用途识别继续走 `src/harness/purpose.ts` 的静态登记。
- 不把 Magpie 或 Wake 作为运行时依赖。

## Proposal

### 1. 目录与适配器分开

新增两层，先别混在一起：

| 层 | 回答的问题 | 第一版内容 |
| --- | --- | --- |
| Agent 目录 | 本机有没有这家、根目录在不在、能不能读 | Magpie 的 19 种本地会话 Agent，全部只做检测 |
| 会话适配器 | 这家怎么枚举、怎么解析、怎么归一 | 5 个实现，覆盖 6 个 Agent |

目录只做 `existsSync`、`readdir` 与 `stat`，不读文件内容。它决定报告里写 `not_installed`、`installed_unsupported`、`ready` 还是 `unreadable`。适配器才持有格式知识。根路径从 Magpie 的 `internal/sessions` 或 Wake 的 adapter 抄；找不到可靠根的 Agent 标 `unknown_root`，不猜路径，也不扫整个 home。

这样做的原因很直接：如果只做适配器，没接入的 Agent 在页面上看起来就是零调用；如果只做目录，用户会以为已经采到了。两层分开，覆盖缺口才看得见。

### 2. 第一版范围

| Agent | 默认根 | 格式 | 最强本地身份 | 第二来源 | 第一版 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl`，含 `subagents/agent-*.jsonl` | JSONL | `message.id`，归一后对 `response_id` | 网关、OTLP | 是 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL | `response_id`、`thread.id`/`turn.id` | 网关、OTLP | 是 |
| Zcode | `~/.zcode/cli/db/db.sqlite` | SQLite，OpenCode 表结构 | 消息 id；四段 token 指纹 | 网关、direct | 是 |
| OMP | `~/.omp/agent/sessions/**/*.jsonl`，含 profiles 与 artifacts | Pi 系 JSONL | 消息 id；四段 token 指纹 | 网关、direct | 是 |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | 与 OMP 同构 | 消息 id；四段 token 指纹 | 网关、direct | 是，复用 OMP 解析 |
| droid | `~/.factory/sessions` | JSONL | `openaiMessageId` | 无 | 已有，后续并入共用路径 |

第一版之后按本机实际使用补：Dsh、Grok、OpenCode、Kimi、Qoder/Qoder CN、Cline、Cursor、Workbuddy/Codebuddy、Hermes、Alma、Agy。它们先在目录里显示检测状态，不建请求行。

选择这五套的理由：本机都有数据；Claude 与 Codex 有精确响应 id；Zcode 与 OMP/Pi 有完整四段 token；droid 已经在跑。它们覆盖了精确 id 与 token 指纹两类身份材料，也覆盖了 SQLite 与 JSONL 两类存储，足够把共用缝压出来。

### 3. 适配器契约

新增 `src/sources/session/`，每家一个文件，共用一套类型。接口保持小而完整：

| 方法 | 约束 |
| --- | --- |
| `agent` / `sourceKind` | `agent` 与网关、OTLP 的取值一致；`sourceKind` 每家一个，例如 `claude_session`、`codex_session`、`zcode_session`、`omp_session`、`pi_session` |
| `roots()` | 只返回存在的默认根；根缺失是正常状态，不算错误 |
| `discover()` | 返回 `SessionFileRef[]` 或 `unreadable`；只做 `readdir`/`stat` 或 SQLite 元数据查询，不读正文 |
| `read(ref, cursor)` | 返回新增行或行区间；JSONL 用现有 `readBatch`，SQLite 用 `updated_at`/rowid 水位 |
| `parse(ref, batch)` | 产出归一字段与可读正文；不写库、不看其他来源 |
| `parentOf(ref)` / `subagents(ref)` | 子代理沿路径或 `parent_id` 归到根会话；没有就返回空 |
| `versionOf(ref)` | 文件头、库表或 CLI 能拿到的版本；拿不到写 `unknown` |

四条硬约束：

1. `discover` 不读正文。测试里把文件内容换成不可读标记，发现仍然要成功；`parse` 是唯一允许打开内容的阶段。
2. 根存在但读不出，返回 `unreadable`，不能折成空列表。空列表会让删除检测把这一家的行当成磁盘已删；这是 Wake 在 Zcode、OpenCode 库锁住时明确防过的事故。
3. 同一原生会话 id 出现在多个根时，按 (根优先级, mtime, 路径) 选一份，只解析胜者；胜者解析失败才按顺序回退。两份不能各写一遍请求。
4. 坏行停在原地，不跳过。已有 raw 表的来源可以继续读并标批次；本地文件本身就是原始层，不复制 raw 表，坏行停游标，修复后从同一位置重读。

### 4. 共用摄入路径

把 droid 的 `ingestCallTx`、`mergeIntoOwnerTx`、正文落库、证据写入与游标更新抽到 `src/sources/session/ingest.ts`。每家适配器只负责把自己的行变成 `SessionCall`，后面的写入只有一份。

| 共用项 | 落点 |
| --- | --- |
| 归一字段 | 多来源提案第 1 节；适配器产出，owner 消费 |
| 认领 | `findRequestOwnerTx`，不新增第二套查找 |
| 证据 | `request_evidence`；`source_kind` 与游标一致，每家一个；droid 现有的 `session_call` 保持不变，迁移时再决定是否改名；`ref_key` 用 `<session>/<message>` |
| 正文 | 现有 `persistBodyTx`；Claude、Zcode、OMP 与 Pi 用 `anthropic`（四家的消息块本来就是 thinking/text/toolCall/toolResult 形状），Codex 用 `responses`，droid 保留 `droid-session` |
| 游标 | 现有 `source_cursor`；JSONL 用 `readBatch` 的代际与偏移，SQLite 用虚拟来源名 `<db>#<session>` 加水位 |
| 问题 | 现有 `ingest_issue`；reason 前缀按 Agent 区分，例如 `claude_parse`、`zcode_db` |

不新增表。`request.via` 沿用 `session`，`request.have` 加现有的 `HAVE_SESSION=16`，来源身份由 `agent` 与 `source_kind` 区分，不新增 via 值。SQLite 适配器把 `committed_off` 当作最后处理的消息 rowid 或 `updated_at`，把 `file_generation` 当作数据库文件身份加 schema 版本；库被迁移或替换时 generation 变化，整段重读。这个约定写在适配器注释里，避免以后把字节偏移的语义套到 SQLite 上。`src/sources/files.ts` 的 `SourceKind` 目前只列了账本、路由与 droid，第一版把五个会话值加进这个联合；`readBatch` 仍然只负责字节读取，不认 Agent 语义。

正文协议不新造。Claude 的 assistant message 本来就是 Anthropic 形状，Codex 的 rollout 是 Responses 形状，Zcode 的 tool part 与 OMP/Pi 的 `toolCall`/`toolResult`/`thinking` 块映射进 Anthropic 形状；能直接映射就映射，映射不了的部分留在原始层，读取端按现有 `unsupported` 处理。只有真实样本证明四种协议都装不下时，才另开提案加协议。

### 5. 调度与预算

`src/main.ts` 只加一个 `sessions` 定时器，不按 Agent 各起一个定时器。每轮按顺序轮转适配器，每家有独立预算：

- 每家每轮最多 64 个文件、2 MiB 新增字节；
- 未读完的文件靠游标留到下一轮；
- 新文件按 mtime 从新到旧处理；
- 每批一个事务，批间 `await` 让出事件循环；
- 一家抛错只冻结这一家，其他家继续；
- 第一轮不阻塞 HTTP 监听，页面先读已有库。

按本机 3.4 GB 估算，历史回填会持续数小时；这段时间新会话优先。需要提前灌完时，用一次显式维护命令把预算调大，不把大预算写进常驻进程。

### 6. 每家怎么读

**Claude Code。** 根是 `~/.claude/projects`，每个项目目录下是 `<session-id>.jsonl`，子代理在同名目录的 `subagents/agent-*.jsonl`。主会话 id 取文件名；assistant 行的 `message.id` 是调用身份，去掉 `msg_` 后与网关 `response_id` 对齐。assistant 行时间是结束；开始时间取同一回合上一条 user 或 tool 消息的时间，有 `durationMs` 时优先用时长反推，两者都缺失时标 `timeBasis='unknown'`。usage 的 `input_tokens` 不含缓存，`cache_read_input_tokens` 与 `cache_creation_input_tokens` 分开记。子代理按目录归到主会话，不另起对话。

**Codex。** 根是 `~/.codex/sessions`，按年/月/日分目录，文件名里带时间与 thread id。首行 `session_meta` 给 thread id、cwd 与版本；assistant 行带 `response_id`，turn 上下文里有 `turn.id`。usage 记录在回合末，input 含缓存，要减 `cached_input_tokens`；开始时间用回合时长反推。Codex 的状态库（`state_*.sqlite`）可做 `quick_meta` 的等价物，但第一版先不做快路径，避免多一套状态一致性。

**Zcode。** 根是 `~/.zcode/cli/db/db.sqlite`，只读连接。会话表给 `id`、`parent_id`、`title`、时间；消息表给 `role`、`tokens`、`time.created`/`time.completed`、`modelId`。调用单位是 assistant 消息；`model_usage` 补 attempt、provider 与状态。子会话沿 `parent_id` 上溯到根，详情保留谱系。库被上游迁移或锁住时返回 `unreadable`，不把整库当空。

**OMP 与 Pi。** 根分别是 `~/.omp/agent/sessions` 与 `~/.pi/agent/sessions`。首行 `{type:session,version,id,timestamp,cwd}` 给会话身份；后续 `message` 行的 assistant 消息带 `usage.input/output/cacheRead/cacheWrite`、`durationMs`（Pi）或 `duration`（OMP）、`responseId`（若存在）与消息 `id`。OMP 的子代理与 advisor 在会话文件同名的 artifacts 目录里，按目录归到主会话；profiles 下的会话也走同一解析器。Pi 与 OMP 共用一份解析，只换根与 `agent`。

**droid。** 保留现有行为，先把 `parse.ts` 与 `ingest.ts` 的纯函数接到共用路径，用现有 216 个转录做回归。迁移前后 `via='session'` 行数、正文可读率、issue 数必须一致；不一致就回退，不在迁移里改语义。

### 7. 与 Magpie、Wake 的取舍

| 做法 | Wake | ATC 第一版 |
| --- | --- | --- |
| 持久化索引 | 有 SQLite + FTS | 已有 trace 库，不建第二份 |
| 列表元数据 | 先写 `quick_meta` 让列表出现 | 直接写 `request` 行；不另做快路径 |
| 枚举 | `readdir`/`stat`，SQLite 查元数据 | 照做 |
| 解析 | 只解析变化文件；详情按需解析 | 只读新增字节；正文在摄入时落库，页面读取走现有读取架构 |
| 父子会话 | `parent_links` 与虚拟路径 | 沿路径或 `parent_id`；根会话作为对话单位 |
| 失败隔离 | 单家 `Err` 冻结整家 | 照做 |
| 文件监听 | FSEvents/inotify | 第一版 60 秒轮询 |
| 多根副本 | `dedup_rank` + fallback | 第一版只开默认根；副本裁决留接口 |
| 远程主机 | rsync 镜像 | 不做 |

不照搬 Wake 的 FTS 与详情二次解析。ATC 的正文已经入库，页面读取有独立的读取架构与缓存；再解析一遍会让同一份内容有两个读取真相。要借的是采集侧的分层，不是它的存储结构。

### 8. 落地顺序

| 阶段 | 交付 | 验收 | 依赖 |
| --- | --- | --- | --- |
| 0 只读试跑 | 用现有 `readBatch` 对 Claude、Codex、OMP 各一个文件做解析计时，不写库 | 单批解析耗时与事件循环延迟有实测；2 MiB 预算按实测调整，不凭感觉定 | 无 |
| 1 采集缝 | `src/sources/session/types.ts`、`registry.ts`、`ingest.ts`；droid 纯函数抽离；目录骨架 | 现有 droid 测试全过；`bun run typecheck` 通过 | 阶段 0 |
| 2 Claude Code | 发现、解析、子代理、正文；合成 fixture 与真实只读试跑 | 单会话多次调用只建对应行；`message.id` 能对上一条网关 `response_id`；子代理不另起对话 | 阶段 1 |
| 3 Codex | rollout 解析、`response_id`/turn、usage 归一、开始时间反推 | 同一 thread 的调用按 turn 合并；OTLP `turn_ref` 命中；无重复行 | 阶段 1 |
| 4 OMP / Pi | 共用 Pi 解析器、profiles、artifacts 子代理 | 父子会话只出现一份；四段 token 与 direct 行唯一命中 | 阶段 1 |
| 5 Zcode | SQLite 只读、水位、`model_usage` 补字段 | 637 笔网关重叠与 585 笔 direct 重叠按多来源提案复现；库锁住时冻结不删行 | 阶段 1、多来源 owner |
| 6 droid 并入 | droid 走共用 `ingest.ts` | 迁移前后行数、正文可读率、issue 数一致 | 阶段 1 |
| 7 目录与健康 | 19 种 Agent 的检测状态；接 `maintain source-health`；文档与验收 | 未支持 Agent 显示 `installed_unsupported`；根缺失不告警；真实读数与合成验收分开写 | 阶段 2-6、漂移提案 |

Claude 放在最前，因为它有精确响应 id，最容易验证共用缝是否正确。Zcode 放后面，因为 SQLite 水位与既有多来源规则要先稳定。droid 最后迁移，避免在缝还没稳定时改一条已经在生产跑的路径。

## Alternatives considered

**第一版把 Magpie 的 19 种本地会话 Agent 全部实现。** 解析器数量不等于覆盖质量。多数 Agent 在本机没有数据，语义只能靠上游源码猜；没有真实样本的适配器无法验收，还会把「已支持」写进报告。先做五家，余下先检测。

**写一个配置驱动的通用 JSONL 解析器。** 文件布局可以配置，身份、时间基准、token 是否含缓存、子代理归并这几件事不能只靠配置。把它们抽成配置语言，等于在仓库里造一门小 schema，读的人还要再学一层。每家一个短解析器更直接。

**复制 droid 的摄入循环，每家改一份。** 五份 owner 查找、证据写入、正文落库和游标更新会各自漂移；修一个去重缺陷要改五遍。抽共用路径的成本更低。

**像 Wake 一样再建一个索引库。** ATC 的 trace 库已经是索引与正文的存储，再建一份会多一套重建、迁移和一致性问题。Wake 的索引是它的唯一库，不是第二份。

**每次全量解析。** 3.4 GB 的文件每轮重读，磁盘和 CPU 都受不了；droid 111 MB 已经要 30 秒。按游标读新增字节是唯一可行的常驻方案。

**先上文件监听。** 监听能降低延迟，但第一版 60 秒轮询已经够用；监听要处理事件丢失、重命名、跨平台差异，成本高于收益。等轮询的延迟成为真实问题再加。

**根目录读不出就当成空。** 这会把临时不可读的库当成会话全删，下一轮再全部重建；删除检测还会把行清掉。必须区分「没有」与「读不出」。

**把所有检测到的 Agent 都显示成已支持。** 用户会以为 trace 完整。目录状态要明确写出未支持，宁可显示覆盖缺口。

**只接 magpie，不读本地。** 直连调用、本地独有会话和子代理谱系都会缺；用户已经明确要本地会话。

## Acceptance criteria

合成数据：

1. 目录：根不存在时状态为 `not_installed`；根存在但读不出时为 `unreadable`；两者都不产生删除或告警。
2. 发现：`discover` 只做元数据读取；把文件内容设为不可读，发现仍成功。测试用注入的 `readFile` 计数断言发现阶段为 0。
3. 追加：同一 JSONL 追加一行后，第二轮只解析新增字节；已处理行不重复建请求。
4. 截断与重写：文件变短或头部哈希变化时，游标从 0 重读；旧行按唯一键更新，不产生第二份。
5. 坏行：坏行停在原地，写 issue；下一轮从同一偏移重试；跳过坏行会让后续请求体缺消息，测试必须失败。
6. 副本：同一原生会话 id 出现在两个根时只解析胜者；胜者损坏时回退到副本；两份不各建一行。
7. Claude：同一会话三次 assistant 调用建三行；`message.id` 去掉 `msg_` 后与 `response_id` 对齐；子代理不新增对话。
8. Codex：带 `response_id` 的调用按精确 id 合并；只有 thread/turn 时按 `turn_ref` 合并；两者都没有时走 token 指纹，两个候选不合并。
9. Zcode：四种会话 id 拼法归一到同一根会话；子会话调用并入根会话；`model_usage` 只补空字段，不相加用量。
10. OMP/Pi：profiles 与 artifacts 子会话归到主会话；四段 token 与 direct 行唯一命中；两个候选写 `match_ambiguous` 并保留两行。
11. 正文：每家至少一条合成 fixture 能通过现有正文读取路径读出用户输入、回复与工具调用；不认识的形状标 `unsupported`，不丢原文。
12. 调度：一家抛错时其他家照常；单家失败不冻结全局；每批事务提交后 `await`，事件循环不被长批次占满。
13. 隐私：测试 fixture 全部合成；真实会话路径、正文、账号与令牌不进测试、日志或提交。
14. 回填：批量摄入只走增量派生，不触发全量重建；回填期间的事件循环阻塞不高于现有采集器基线，已有派生尖刺不被放大。

真实只读复核（不入测试、不进提交）：

| 项 | 2026-11-04 现状 | 期望 |
| --- | --- | --- |
| 本机文件数 | Claude 330、Codex 296、OMP 441、Pi 46、droid 216 | 发现数与之一致；不含不可读文件 |
| Claude 精确线索 | 本机已核对一条 `msg_…` 对 `response_id_norm` | 适配器抽样能复现，且不产生重复行 |
| Codex OTLP | `turn_ref` 映射版本 4 可用 | 本地 rollout 与 OTLP 按 turn 合并，无第二行 |
| Zcode 重叠 | 637 网关唯一命中、585 direct 唯一命中 | 接入后仍为 637/585，多候选为 0 |
| droid 回归 | 216 个转录、9,582 行、正文可读 | 迁移后行数、正文可读率、issue 数不变 |
| 页面 | 打开会话不触发扫描 | 读取只走库；采集器日志不出现页面触发的解析 |
| 资源 | 采集器常驻 RSS 与磁盘有上限 | 回填期间 RSS 不随文件总量线性增长；正文预算生效 |

## Risks

- **上游格式变化会让一家解析器失效。** 结构、字段与语义漂移由[数据源契约漂移检测](2026-11-04-source-contract-drift.md)接手；本文的适配器必须带版本与结构化 issue，否则漂移只能靠坏行发现。
- **副本裁决写错会丢会话。** 同一会话 id 在多根出现时，胜者选择与回退顺序要测试；第一版只开默认根，但接口先按多根设计，避免以后改结构。
- **子代理会重复计量。** Claude 的 subagents、Codex 的子线程、OMP 的 artifacts 都容易被当成独立会话；必须沿父链归到根会话，验收要卡父子只出现一份。
- **正文体积会顶到预算。** 3.4 GB 原始文件会产出更大的请求正文；现有 body 预算会淘汰旧正文。回填按新到旧，页面先有最近会话；旧请求保留元数据，正文可能不可读。
- **回填会放大既有派生尖刺。** 本地适配器一次写入大量 `request` 会触发派生；必须沿用增量派生队列，按批提交，不在摄入事务里做重派生。回填期间要测事件循环延迟，不能只看采集器自己的耗时。
- **事件循环仍可能被单批拖慢。** 2 MiB 与新到旧只是上限，单行很大时仍会慢；验收要测批间延迟，必要时再降批大小。
- **SQLite 库会被上游锁住或迁移。** Zcode 常驻时可能正在写库；只读连接、短事务与 `unreadable` 冻结要一起做。不能把锁当成空库。
- **OMP/Pi 的版本差异。** Pi 与 OMP 同构但不完全同版本；profiles、artifacts、`duration` 与 `durationMs` 的差异要用合成 fixture 分开测。
- **token 指纹会撞。** 相同上下文重复调用会得到相同计数；多来源提案的候选唯一与 ±2 秒窗口是兜底，不能单靠 token。
- **目录状态会给人假安全感。** 检测到根不等于能读，能读不等于解析正确；报告要把 `ready`、`unreadable`、`installed_unsupported` 与解析 issue 分开写。
- **droid 迁移有回归风险。** 共用路径要先保行为再谈统一；迁移前后用现有行数与正文可读率对账，不一致就回退。
- **真实数据不能进 fixture。** 本机会话可能含账号、路径、提示词与工具输出；测试只用合成数据，真实复核只记录聚合计数。

## Deferred

- 其余 13 种 Magpie 本地会话 Agent 的适配器。
- 文件系统监听与更低延迟。
- 自定义根、多根副本裁决、远程主机镜像。
- Codex 的 `state_*.sqlite` 快路径与标题优先级。
- Zcode 的 `session_alias` 表与跨机器会话身份。
- 新增 Agent 的用途识别规则与前端标签。
- 显式的大预算历史回填命令。
- 目录状态的独立页面；第一版只进 `maintain source-health` 与 `/api/stats` 摘要。

## 落地状态（2026-11-04）

第一版已落地的部分：

- `src/sources/session/` 的共用缝：`types.ts` 契约、`ingest.ts` 摄入、`read.ts` 与 `adapters/` 五个实现、`registry.ts` 调度次序；Claude、Codex、Zcode、OMP、Pi 都有合成数据测试。
- `src/main.ts` 的 `sessions` 定时器，每 60 秒轮转一家；测试用 `CollectorOptions.sessionAdapters` 与 `sessionRoots` 注入合成根。
- schema v12：`raw_droid_event` 原地改名 `raw_session_event` 并加 `source_kind`；droid 与五家适配器共用原始层。
- 统一 owner 新增 `usage_fingerprint.v1`；`turn_ref` 线索也排除同来源证据，避免同一 user turn 的多笔调用互相认领。
- 会话 id 在账本、路由与本地适配器入口按同一前缀口径归一；投影写用量列改为 `COALESCE`，网关迟到且无用量时不擦掉本地读数。
- 单轮字节预算按实际读到的字节累计，不按 `remaining` 估：大文件首轮只读一个批次，按整份估会把同一轮的后续小文件挤掉（部署首轮实测只推进了一个文件）。

与本文的差异与未落地项：

- 正文协议按实际形状收敛为 `anthropic` 与 `responses` 两种，没有新增 `chat`。
- Claude 的 `isSidechain` 行本轮不建调用，子代理谱系未折叠；Codex 的跨根副本只靠证据幂等吸收，`mutable=false` 下不刷新正文。
- Zcode 的 `turn_id` 粒度未用真实库核实；owner 的同来源排除保证了即使一轮多调用也不会少建行。
- droid 仍走自己的摄入路径，没有迁到共用缝；Magpie 19 种 Agent 的目录检测、`maintain source-health`、多根副本裁决与真实流量验收都未做。
