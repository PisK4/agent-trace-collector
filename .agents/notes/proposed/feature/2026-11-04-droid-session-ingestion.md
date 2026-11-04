# Agent Note: Droid 会话文件摄入与跨来源去重

Status: proposed

## Problem

### 未接入 Agent 在 ATC 里完全不可见

2026-11-04 对生产库做只读查询，`request` 按 `via` 分布是 `through` 52,210、`hook` 1,357、`rejected` 21、`otlp` 1，`direct` 为 0。magpie 账本里另有 31,072 条 direct 记录（2026-10-20 架构基线），这些是 Agent 绕过网关、magpie 从本机会话文件读出的调用；ATC 一条都没有摄入。本机约四成调用量落在视野之外。

Droid（Factory 的编码 Agent）属于完全未接入的一类。它的调用不经过 magpie 网关，magpie 账本里 `agent:"droid"` 为 0 条；magpie 自己也不把 droid 计入 direct 统计，`callFiles` 只含 claude、claude-desktop、codex 与 WSL 里的同类文件，droid 只进会话列表摘要（[calls.go:291](https://github.com/yetone/magpie/blob/3173440ca3be3eb0a855870d92faeadea6785aaa/internal/sessions/calls.go#L291-L340)、[droid.go](https://github.com/yetone/magpie/blob/3173440ca3be3eb0a855870d92faeadea6785aaa/internal/sessions/droid.go)）。ATC 要看见 droid，只能自己扫。

### 本机 droid 的数据形状

`~/.factory/sessions/` 下 216 个 `.jsonl` 转录、114 MB，另有 183 个 `.settings.json`。文件按工作目录分目录，旧版直接放在根目录。抽样一个 270 行会话（2026-08-24）：

| 行类型 | 数量 | 内容 |
| --- | --- | --- |
| `session_start` | 1 | id、title、cwd、lastCwd、parent、forkedAtMessageId、callingSessionId |
| `message` | 254 | id、timestamp、`message{role,content,modelId,openaiMessageId,reasoningEffort}` |
| `agent_turn_outcome` | 9 | turnId、resultKind、reason（completed / cancelled） |
| `todo_state` | 6 | 待办快照，与调用无关 |

`message.content` 是 Anthropic 形状的块数组：user 侧是 `text` 与 `tool_result`，assistant 侧是 `thinking`、`text`、`tool_use`。60 条 assistant 消息全部带 `modelId`。`openaiMessageId` 有两种拼写，`gen-<时间戳>-<随机串>` 与 `<时间戳><十六进制>`。

`<id>.settings.json` 里有用量与模型：`tokenUsage{inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,thinkingTokens,factoryCredits}`、`lastCallTokenUsage`、`inclusiveTokenUsage`、`childInclusiveTokenUsageBySessionId`、`model`、`reasoningEffort`。`tokenUsage.inputTokens` 不含缓存读，`outputTokens` 含思考；`lastCallTokenUsage` 只保留最后一笔。没有逐笔用量。

### 为什么第一版选 droid

droid 完全未接入，不会与现有 magpie 行产生重叠，去重压力最小；转录带完整正文、逐条时间、逐条模型与响应 id，是「尽量还原」能拿到的最好材料；本机有 114 MB 真实数据可用于验收。Claude Code 与 Codex 已走 magpie，扫描它们的第一价值是历史回填，牵涉的跨来源去重更重，放在后续。

### 还原度

能还原：会话身份（id、cwd、parent、子代理关系）、每轮调用（assistant 消息）的时间、模型、响应 id、完整消息正文、工具调用与结果；会话级累计用量。

不能还原：逐笔用量与费用、请求状态码、provider 与 served 模型、路由决策、system prompt 与工具定义。droid 转录不记录这些。会话累计用量只按最后一条消息的日期归属，跨天会话无法按天拆分。

请求体是重建的：每轮的消息数组按转录拼接，不含 droid 发给模型的 system prompt 与工具定义。界面必须标明「会话文件还原」，不能把它当成与 hook 正文同等的原始请求。

## Proposal

### 来源与发现

新增 `src/sources/droid/`，三个文件：`discover.ts` 找文件与游标，`parse.ts` 把转录行解析成调用，`ingest.ts` 落库。第一版不做多 Agent 通用注册表；第二个来源接入时再抽公共接口，避免现在为一种格式写适配层。

扫描根目录取 `$FACTORY_HOME_OVERRIDE/.factory/sessions`，否则 `~/.factory/sessions`，与 magpie 的 `FactoryDir` 一致（[droid.go:35](https://github.com/yetone/magpie/blob/3173440ca3be3eb0a855870d92faeadea6785aaa/internal/sessions/droid.go#L35-L43)）。匹配 `*.jsonl` 与 `*/*.jsonl`，忽略 `.settings.json`。

转录是 append-only，复用 `source_cursor`，`source_kind='droid_transcript'`，按文件身份、`committed_off` 与冻结头部基线增量读；规则与账本、路由相同。`.settings.json` 是覆盖写，整份读、按内容哈希判变化，不占游标。取件只选还有剩余字节的转录，所以转录停止增长时文件不会进批次；每批结束再按 `session_usage.source_path` 刷新一次已记录的 settings，覆盖写不会漏。文件消失时保留已摄入行，不删除。

每轮按剩余字节从大到小取文件，单轮上限 64 个文件或 8 MiB，未读完的下一轮继续。新增 `intervalOf(config, 'droid', …)`，默认 60 秒。

### 解析与轮次

一条 assistant `message` 行算一次调用，建一条 `request` 行。消息窗口按转录顺序累积，本轮请求体是截至该行之前的全部消息；回复取该行的 `content`。这假设一条 assistant 消息对应一次模型调用，工具调用循环里的每条 assistant 消息都是独立调用。抽样会话里 assistant 消息与 `agent_turn_outcome` 不一一对应（60 对 9），turn 边界不能用于切分，只能按消息切。

`started_ms` 取该 assistant 行之前最近一条 message 的 `timestamp`，缺失时退回 assistant 行自身的时间。droid 只记录消息时间，不记录请求发出时刻，这个值用于排序，不当作精确的开始时间。

`model_requested` 取 `message.modelId`。`model_served`、`provider`、`status`、`stop` 留 NULL，不用相邻字段顶替。`agent='droid'`，`session` 取 `session_start.id`，`cwd` 取 `cwd` 或 `lastCwd`，`conv_key` 为 `["session", id]`，`conv_source='droid-session'`。`reasoningEffort` 进 `source_facts_json`，不写 `reasoning` 列（那一列是 token 数）。

fork 处理：`forkedAtMessageId` 之前的行是源会话的复制。它们进消息窗口（fork 的上下文包含它们），但不建 request 行；遇到该 id 之后的 assistant 行才开始建行。子代理处理：`callingSessionId` 非空时，`subagent` 与 `actor` 取自身 session id，`parent_agent` 取调用者 id；子代理的调用照常建行。

`agent_turn_outcome` 第一版只落原始层，不解析成败。本机样本只有 completed 与 cancelled，失败形状未覆盖，先不猜。

### 落库与正文

schema v11 增加两张表。`raw_droid_event` 存脱敏后的整行原文与物理身份 `(file_generation, byte_offset)`，供重放与审计；`session_usage` 存会话级累计用量，主键 `(agent, session)`，字段为 model、四件套、thinkingTokens、factoryCredits、来源文件与观测时间。

`request_evidence` 用 `source_kind='session_call'`，`ref_key=<session_id>/<message_id>`；`have` 加第 5 位 `HAVE_SESSION=16`，`via='session'`。

正文走现有 `persistBodyTx`：`protocol='droid-session'`，`request={messages:[…]}`，`reply=<assistant content>`，消息先脱敏再落块库。块哈希去重、骨架、派生、搜索都复用现有路径。重建的正文标 `body_state='available'`，来源差异由 `via` 与详情页的来源标注承担。

### 用量只到会话级

`tokenUsage` 是会话累计，不拆到轮。把总量摊到每轮是编造，方案否决。`request` 行的 `in_tok`、`out_tok`、`cache_read`、`cache_write` 留 NULL，`source_facts_json` 记 `usage_scope='session'`。会话头部与会话列表从 `session_usage` 读累计值，界面标「会话累计」。

只对主会话读 settings：`callingSessionId` 为空的转录。本机样本里 `tokenUsage` 与 `inclusiveTokenUsage` 相等，`childInclusiveTokenUsageBySessionId` 为空，与 magpie「子代理用量计入调用它的会话」的注释一致。子代理转录的 settings 不另计，避免双算。这个判断需要更多样本复核，列为开放问题。

`lastCallTokenUsage` 不用于逐笔展示：它只覆盖最后一笔，历史轮次没有值，单独显示会误导成「其他轮没有用量」。

### 跨来源去重与迟到合并

用户要求任何来源都不能靠独立建行显示双份，OTLP 现有的独立行也要一并处理。现状是单向合并：OTLP 晚到时按 `turn_ref` 或同会话时间窗找到 magpie 行，只写证据；magpie 账本晚到时 `mergeLedgerRow` 只按 `route_id` 查找（[reconcile.ts:479](../../../../src/reconcile.ts)），找不到就新建，于是同一笔调用留下两行。

新增一个统一的 owner 查找，写入前依次尝试：

1. `response_id_norm` 精确命中，且只命中一行；
2. `turn_ref` 命中（Codex 已有）；
3. 同 `conv_key`、同 agent、起止时间在 ±60 秒窗口内、模型相等，且只命中一行。

多候选或零候选都不合并，独立成行，记 `match_ambiguous` 或 `match_absent`。这沿用仓库「不按相邻时间猜」的规则。`via='rejected'` 的行不参与任何一条线索：被上游拒绝的调用没有走到模型，不是同一笔调用的另一份证据。droid 写入前调用这个查找；`mergeLedgerRow` 在 `route_id` 未命中时也调用，账本迟到就能认领 OTLP 或 droid 已建的行，双份消失。

`normalizeResponseId` 的前缀表目前是 `chatcmpl-`、`msg_resp_`、`msg_`、`resp_`（[mapping.ts:217](../../../../src/sources/magpie/mapping.ts)）。droid 的 `gen-` 是否应加入，取决于它是否与 magpie 账本的 `response_id` 同值；本机 droid 不走 magpie，无法验证。第一版按原样比较，验证后再决定是否升匹配规则版本。

投影层仍只把 ledger、route、hook 作为字段来源；`otlp_span` 与 `session_call` 只贡献证据位与缺失标记。这样避免为一种新来源改动整个投影家族，也不会用低置信字段覆盖账本读数。合并到既有行时，droid 只补空字段，不覆盖已有值。

### 派生与界面

droid 行建好或合并后调用 `markRequestInputTx` 进派生队列。标题、前驱、工具配对走现有派生内核；重建的消息数组与 Claude Code 的形状一致，块序列比较可以直接使用。

请求详情页在来源处标「droid 会话文件」；请求列表沿用现有 `via` 展示，不新增二级标签。会话头部显示「会话累计」用量，与逐笔用量的视觉分开。第一版不做 Agent 总览页；它等 direct 回填与第二个来源接入后再定。

### 实施顺序

1. schema v11：`raw_droid_event`、`session_usage`、`HAVE_SESSION`、`source_kind='session_call'`。
2. `src/sources/droid/` 的发现、解析与单测，先只产出内存中的调用列表。
3. 摄入接缝：游标、原始层、request 行、正文、派生入队。
4. 统一 owner 查找与账本迟到合并，补 OTLP 双份用例。
5. 查询与会话用量展示，来源标注。
6. 本机全量验收，部署后再做真实流量核对。

## Alternatives considered

**只吃 magpie 的 direct 行。** droid 不在 magpie 的 `callSources` 里，magpie 没有 droid 的 direct 数据，这条路看不见 droid。

**把会话累计用量摊到每轮。** 总量不是逐笔数据，摊分会制造看似精确的假读数，违反报告忠实。

**一条会话建一条 request 行。** 违背以请求为记录单位，正文无法按轮阅读，前驱与工具配对也失去粒度。

**新来源独立建行、靠 `via` 区分。** 用户明确否决；同一笔调用在两处出现，会话视图无法判断哪个是事实。

**现在抽多 Agent 通用解析器接口。** 只有一个来源时抽象是空转；第二个来源接入时按真实差异抽，代价更低。

## Risks

- droid 没有逐笔用量，界面必须长期区分「会话累计」与「逐笔读数」，否则会被误读成每轮都没有用量。
- 重建的请求体缺 system prompt 与工具定义，不能与 hook 正文同等对待；详情页要标来源。
- `openaiMessageId` 与 magpie `response_id` 是否同值未验证。若不同值，droid 接入 magpie 后仍会双份，需要扩展匹配键。
- 账本先到、OTLP 后到时，OTLP 仍按既有启发式独立建行；span 不带会话 id 或时间、模型对不上时两行并存。统一 owner 查找只覆盖 droid 写入与账本迟到，未改动 OTLP 的认领路径。
- `raw_droid_event` 保存脱敏原文供每批重放，当前没有回收路径，体积随转录与改写代际线性增长。回收前要先有解析状态检查点，否则下一批会丢失会话与消息窗口。
- 坏行停在原地会阻塞该文件后续所有调用，直到原文修复；这是为了后续请求体不缺点而做的取舍，issue 与游标位置可查。
- droid 转录没有版本契约，`session_start.version` 目前为 2。格式变化时解析器要跟着改，错误行进 `ingest_issue`，不能让坏行推进游标。
- 首次全量扫描 114 MB、216 个文件，会在启动后占用一段后台时间；分批读取把单轮代价压在 8 MiB 内。

## Acceptance criteria

合成 fixture 覆盖：普通会话、fork、子代理、截断文件、settings 缺失、assistant 消息缺 modelId。断言 assistant 消息数与 request 行数守恒，fork 复制段零建行，子代理归属正确。

去重用合成数据验证双向：droid 先建行、账本晚到；账本先建行、droid 晚到；两者 response id 相同；同会话时间窗内模型不同（断言不合并）。OTLP 与账本的迟到合并用同一组用例，断言最终只有一行、证据位齐全。

本机全量验收：扫描 216 个转录，统计建行数、正文可读率、`ingest_issue` 原因分布、单轮耗时与内存峰值。生产部署后只用只读查询核对 droid 行的数量与形状，不接受把合成结果写成真实流量通过。

## 开放问题

- droid 接入 magpie 后，请求头里的 session id 是否等于 `session_start.id`。
- `openaiMessageId` 与上游响应 id、magpie 账本 `response_id` 的对应关系。
- 子代理 settings 是否真的不独立计数，需要更多样本或 droid 文档确认。
- 一条 assistant 消息是否恒为一次模型调用，thinking-only 或空回复的边界未覆盖。
- `agent_turn_outcome` 的失败形状，本机样本只有 completed 与 cancelled。
