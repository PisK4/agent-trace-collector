# Agent Note: Grok 本地会话适配器与会话级用量口径

Status: implemented

## Problem

批次 A 要接 Grok 本地会话。共享登记面已在 `feat/session-batch-a-base` 基线铺好（`grok_session`、`grok_session_call`、catalog 标 `implemented`），`adapters/grok.ts` 仍是 `discover` 恒返回空的占位，本地数据完全读不进来。

本机 `~/.grok/sessions/<url-encoded-cwd>/<uuid>/` 有 6 个会话。一个会话是**一个目录、多个文件**：`chat_history.jsonl`、`summary.json`、`usage.json`、`events.jsonl`、`rewind_points.jsonl`、`tool_definitions.json`、`signals.json`、`updates.jsonl` 等。`chat_history.jsonl` 是可追加的消息流，行型有 `system`、`user`、`assistant`、`reasoning`、`tool_result`、`text`、`summary_text`。抽样一个 104 行的会话，行序是 `system → user… → reasoning → assistant → tool_result… → reasoning → assistant…`。

关键约束来自真实形状，不是猜测：

- `chat_history` 行**没有 session id、没有时间戳、没有消息 id、没有逐笔用量**。assistant 行只有 `content:string`、`model_id`、`tool_calls:array`、`model_fingerprint`。会话 id 只能从目录名（UUID）取，`summary.info.id` 与之相等。
- 四段 token 只以**会话累计**形式存在于 `usage.json` 的 `session.*` 子对象（`inputTokens`、`outputTokens`、`cachedReadTokens`、`cacheCreationTokens`、`reasoningTokens`、`totalTokens`、`modelCalls`、`turnCount`、`primaryModelId`、`modelUsage`），另有 `turns` 数组按轮次汇总。抽样会话 30 条 assistant 对应 `modelCalls:30`，`turnCount:3`。逐笔拆不出来。
- 时间只在旁路文件里：`summary.json` 的 `created_at`/`last_active_at`、`usage.json` 的 `updatedAt`、`events.jsonl` 的 `ts`、`updates.jsonl` 的 `timestamp`（Unix 秒）。
- 6 个会话里有 2 个只有 `system`、`user` 两行，没有 `usage.json`；有 4 个带 `usage.json`。

Magpie 的 `internal/sessions/grok.go` 读的是 `updates.jsonl` 的 `turn_completed` 事件，按轮次累计用量，与本机这份 `chat_history.jsonl` 不是同一种格式。它能确认的只有 `GrokDir`（`$GROK_HOME` 优先，否则 `~/.grok`）与 `grokUsage.tokens()` 的口径（`input` 不含缓存读写）。解析路径得按本机真实形状自己写。

共用摄入的 `SessionCall.usage` 要求四段齐全或为 `null`。四段只有会话级累计，摊到逐笔是编造，用 0 冒充也是编造。Pis 已拍板：单笔 `usage` 一律 `null`，累计值走 `afterFile` 写 `session_usage`，沿用 droid 已有的钩子形状，不改 `ingest.ts` 主体。

## Decision

### 一条流是一个会话目录

`discover` 按 `<cwd>/<uuid>/chat_history.jsonl` 枚举，一个目录一条流。`source_name` 是该文件绝对路径（`readBatch` 需要真实文件、按字节偏移增量读），会话 id 由 `emptyState(file)` 从父目录名取，经 `canonicalSessionId` 归一。目录里其余文件不进发现、不各自建游标；它们是旁路快照，只在 `read`/`afterFile` 里按路径读。这样「一个会话多个文件」不会变成多条流，也不会把 `events.jsonl`（4,638 行）当调用源。

`roots()` 对齐 Magpie 的 `GrokDir`：`GROK_HOME` 有值用它，否则 `~/.grok`，拼上 `sessions`。

会话目录缺 `chat_history.jsonl` 时跳过，不建空流；`usage.json` 缺失时 `afterFile` 静默返回 0，保留旧累计行，不记 issue。

### 调用单位与证据键

一条 `assistant` 行算一笔调用。`callId` 用 `off:<行偏移>`——`chat_history` 行没有 id，物理字节偏移是唯一稳定身份：追加不改变已有行偏移，重放按同一偏移恢复，跨会话目录由 `sessionId` 前缀天然隔离。证据 `ref_key = <sessionId>/off:<偏移>`，两个会话即便行偏移相同也不相撞。

`sortOffset` 取行偏移，`sort_key` 沿用共用摄入的 `generation|offset` 形状。

### 消息窗口与正文

`system`、`user`、`tool_result`、`assistant` 按行序累积成重建正文，形状按 `chat` 协议解释：`user.content` 原样保留数组，`tool_result` 映射成 `{role:'tool', tool_call_id, content}`，assistant 的 `content` 字符串与 `tool_calls` 映射成 `text` 与 `tool_use` 块。`reasoning` 行的 `summary` 数组拼成可读文本，作为下一笔 assistant 回复的首个 `thinking` 块；`request.reasoning` 是 token 数列，保持 `null`，不放文本。`text`/`summary_text` 与不认识的行型只跳过（或只落原始层），不判坏、不进窗口。

`replaysState: true`：追加读取从本代际 `raw_session_event` 按偏移重放，恢复完整消息窗口，批次之间不靠内存。每行都是自成一笔的调用，重放阶段的 `calls` 被共用摄入丢弃，不需要 `flush` 延迟补发。

`startedMs` 取 `summary.json.created_at` 作会话起点，按调用序号每笔加 1 秒。行里没有时间，这个值只用于排序，不冒充精确请求时刻；`atMs` 留 `null`。`model` 取 assistant 行的 `model_id`，`cwd` 取 `summary.info.cwd`。`responseIdNorm`、`turnRef`、`parentSessionId`、`subagentId` 都留 `null`——本机样本里没有子代理目录，折叠规则没有依据，不凭 Magpie 的另一套格式猜。

### 用量只到会话级

单笔 `SessionCall.usage` 一律 `null`，`request` 的四段读数列保持 NULL，`source_facts_json` 由共用摄入记 `usageScope:'session'`。

`afterFile` 整份读 `usage.json`，按内容 SHA-256 判变化，把 `session.*` 累计写进 `session_usage(agent='grok', session=<目录 UUID>)`：

- `input_tokens` 按 magpie 口径算 `inputTokens - cachedReadTokens - cacheCreationTokens`，下限 0；
- `output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`thinking_tokens` 直接映射；
- `model` 取 `primaryModelId`；`factory_credits` 取 `costUsdTicks / 1e8`（`session_usage` 没有专门列，复用 droid 的 credits 列存 USD 近似值）；
- `source_path` 与 `source_hash` 留作来源审计；覆盖写按 `WHERE source_hash<>excluded.source_hash`。

会话页 `session_summary` 按 `(agent, session)` 读这一行，与逐笔 `totals` 并列展示。逐笔没有用量不是缺数据，是这份来源不记录逐笔用量。

## Alternatives considered

**把会话累计摊到每笔 assistant。** `usage.json` 的 `modelCalls` 与 assistant 行数对得上，除以笔数看似可行。但累计里有 `modelUsage` 分模型、`turns` 分轮次，各笔实际用量不均匀，平摊会把每笔都写成一个假数，还会进 `usage_fingerprint.v1` 与网关行错误去重。否决。

**用 `usage.json.turns` 按轮次建调用。** `turns` 只有 3 条、`modelCalls` 有 30 条，一轮里含多次工具循环调用。按轮次建会丢 27 笔，且 `turns` 没有消息正文，请求体重建不出来。否决。

**照搬 Magpie `grok.go` 读 `updates.jsonl` 的 `turn_completed`。** 本机 `updates.jsonl` 确实存在，但那是另一套 ACP 事件格式，与本仓库的 `SessionCall` 消息窗口模型不兼容，且 `turn_completed` 的 usage 是轮次累计而非逐笔。Magpie 的清单页只需要会话级读数，ATC 要逐笔 request 行。只借它的 `GrokDir` 与 `tokens()` 口径。否决。

**给每个会话目录建多个 `SessionFile`（chat_history + usage + events）。** 共用摄入按 `source_name` 去重、按文件推进游标，多流会让同一会话的窗口被切开，且 `usage.json` 是覆盖写，按字节追加读会读错。否决。

**用 `events.jsonl` 的 `ts` 给每笔调用配精确时间。** `events.jsonl` 有 4,638 行、带 `ts`，但事件与 `chat_history` 行没有可对齐的序号或 id，硬关联会制造错位。只用于确认「时间不在 chat_history 里」这一事实。否决。

**改 `ingest.ts` 主体让静止的 chat_history 也能触发 `afterFile`。** `afterFile` 只在文件有推进的写事务里调用；`usage.json` 在 `chat_history` 停止追加后被单独改写时，共用摄入走 `unchanged` 分支直接返回，累计值刷新不到。droid 用独立批次入口 `ingestDroidBatch` 做批次后刷新，grok 走通用 `sessions` 调度、没有这个入口。本次硬边界禁止改 `ingest.ts` 主体与 `main.ts` 调度，留作后续治理。否决。

## Consequences

- 收益：本机 6 个会话的 `chat_history` 能逐 assistant 建 request 行，正文按 `chat` 协议可读；四段累计进 `session_usage`，会话页「会话累计」与逐笔合计分开，不编造逐笔用量；共享登记面零改动，与并行中的 WorkBuddy 分支无冲突。
- 代价：`started_ms` 是合成序号时间，不是真实请求时刻，跨会话排序只能到会话内粒度；请求体是重建的，不含 Grok 实际发给模型的 system prompt 与工具定义，页面必须标「会话文件还原」。
- 代价：`chat_history` 静止期间 `usage.json` 被改写时累计值刷新不到，要等下一次追加或由后续批次刷新入口补上。合成测试只覆盖「随下一次推进刷新」，不覆盖静止改写。
- 代价：`factory_credits` 复用 droid 的 credits 列存 USD 近似值，列名字面含义与内容不完全一致；要精确费用展示得给 `session_usage` 加专门列。
- 未覆盖：`updates.jsonl`、`events.jsonl`、`rewind_points.jsonl`、`tool_definitions.json`、`signals.json` 只作为「多文件组成一个会话」的证据存在，不解析；本机样本未观察到子代理目录，`subagent`/`parent_agent` 折叠规则只留 `null` 占位；`reasoning.encrypted_content` 是密文，只用可读的 `summary`。
- 窄测试 `tests/session-grok.test.ts` 6 例覆盖首次摄入、追加读取、坏行停游标、多文件会话、单笔 usage 留 null 与 `session_usage` 累计、内容哈希覆盖、证据 ref_key 唯一、未知行型不判坏。全部用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture。
- 生产部署、真实流量对账、验收记录与架构/覆盖文档更新由主线程串行完成，本分支不做。

## Related

- [批次 A 共享登记面先铺](../process/2026-11-04-batch-a-shared-registry.md) 定基线、占位与两分支的边界。
- [覆盖矩阵与分批路线](../../proposed/feature/2026-11-04-agent-coverage-matrix.md) 定「格式差异决定工作量」与每批完成条件。
- [Droid 会话文件摄入与跨来源去重](2026-11-04-droid-session-ingestion.md) 提供会话级累计用量与 `afterFile` 的先例。
