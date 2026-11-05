# Agent Note: Hermes 本地会话适配器——照抄它自己的展示投影

Status: implemented

## Problem

用户 2026-11-05 明确两条要求：Hermes 必须接入，接入后要完全忠于 Hermes 原本的对话 trace 顺序，记录的数据必须正确。同一天又重申了多数据源规则：任何一个来源只要有数据，就要能独立解析并展示，不能依赖另一个来源。

前两次侦查留下了两组事实。[本地来源侦查](2026-11-05-hermes-local-source-recon.md)确认 `~/.hermes/state.db` 有会话与消息，但没有逐笔调用记录；[conv id 更正](2026-11-05-hermes-conv-id-correction.md)确认网关侧 `magpie-` 会话 id 是从请求正文首条 user 消息算出的摘要，ATC 的 `convDigestOf` 与之一致。问题是本地消息的顺序权威是谁、一条消息算不算一次调用、本地行怎样与网关行对齐而不重复建行，这三件都没有验证过。

## Decision

### 1. 顺序照抄 Hermes 的展示投影，不按插入序

Hermes 自己的读取路径是 `hermes_state_messages.py` 的 `_display_rows_from_conn`：按 `display_order` 取槽位，同槽按 `active DESC, id DESC` 选代表行，可见集合是 `active = 1 OR compacted = 1`，再排除 `display_metadata.model_only` 与「后出现的工具副本」。适配器逐条复刻这组规则（`displayRowsOf`），没有按 `messages.id` 或 `timestamp` 排序。

实测本机 11,762 行里，会话内 `id` 序与 `display_order` 序有 1,748 行不一致；`display_order` 全库唯一（11,700 个槽位、0 个跨会话重复），可以直接作 `sortOffset`。三种状态也核对清楚：`(1,0)` 现役 9,714 行、`(0,1)` 压缩归档且照常展示 1,819 行、`(0,0)` rewind 丢弃且不展示 229 行——rewind 的实现只写 `active = 0`，不动 `compacted`，所以展示条件天然排除它。

### 2. 一条 assistant 消息算一次调用

`messages` 里 role 是 user/assistant/tool 三种；assistant 行是模型输出，4,966 行带 `tool_calls`，307 行是纯文本，tool 行 5,882 行全部有 `tool_call_id`，配对完整。适配器只对展示集里的 assistant 行发调用，`callId` 用 `String(messages.id)`（AUTOINCREMENT、全局唯一、永不变），`sortOffset` 用 `display_order`，请求窗口是展示集里槽位更小的所有行，按 chat 形状重建。

`messages.timestamp` 的语义用只读对账定了：与网关 `started_ms` 的中位差 353 毫秒（4,603 笔可比样本），所以 `startedMs = timestamp * 1000`；缺值时退回会话 `started_at`。Hermes 源码自己注明这个字段不可用于排序（时钟回退），适配器只把它当时间戳，不当顺序。

### 3. 会话坐标：摘要唯一才用，否则退回本地 id

网关侧 4,896 行、525 个 conv id。把本地每个会话的展示集首条 user 消息按 `convDigestOf` 口径算摘要，125/159 命中。未命中 34 个，其中 3 个 local 大会话共 1,387 行。

更要紧的是碰撞：28 个 `oneshot` 会话的首条 user 内容完全相同，算出的摘要也完全相同。直接拿摘要当 `convKey` 会把 28 个独立会话并成一条。适配器的规则因此是「本库内该摘要唯一对应一个会话时才用，否则退回 `sessionConvKey(本地 id)`」。真实库上 2,850 笔用摘要、28 笔用本地键，与碰撞诊断的数字对得上。

子代理会话（`source = 'subagent'`、有 `parent_session_id`）沿父链折叠到根会话，`subagent` 与 `parent_agent` 各自填自己的 id，`convKey` 用根会话的摘要。

### 4. 用量：逐笔留 null，只写会话累计

`messages.token_count` 全空，`session_model_usage` 是 `(session, model)` 聚合行（253 行、6,088 次调用）。适配器逐笔 `usage = null`，`afterFile` 把聚合值求和写进 `session_usage`，`model` 取调用次数最多的那个。子代理的聚合值不写：`session_usage` 主键是 `(agent, session)`，而请求行的 `session` 已折叠到根，写进去会把两份累计值覆盖成一份。

### 5. 独立解析

适配器的 `read()` 只打开 `~/.hermes/state.db`，摘要与唯一性检查全部在本地库内完成，不查询生产库。与网关行的合并发生在 `ingest.ts` 的通用 owner 匹配，不是适配器依赖另一来源。即使网关侧一条数据都没有，这批行照样能按自己的会话坐标展示。

### 验收

合成数据 7 个用例：顺序（id 序与槽位序相反）、三态过滤与同槽裁决、model_only 与工具副本过滤、摘要碰撞回退、子代理折叠、增量游标、会话累计用量。`bun test tests/session-hermes.test.ts` 全过，`bun run typecheck` 通过，受影响的既有测试 30 个全过。

真实库只读验收：168 个会话被发现，159 个有调用；模拟多轮摄入全量收敛到 5,273 笔，与 Hermes 展示集 assistant 行数精确相等；顺序违规 0、坏行 0、卡住的会话 0；单会话最多 15 轮。这项验证只读、不写生产库，与合成数据验收分开记。

## Alternatives considered

**按 `messages.id` 排序。** 插入序看起来更自然，但压缩与 rewind 会插入新副本，实测有 1,748 行与展示序不一致。按 id 排会把助手回复排到它引用的 user 消息前面，请求窗口直接错。

**按 `timestamp` 排序。** Hermes 源码注释写明 id 排序是刻意的：「never timestamp: clocks regress」。对账里 p90 差值到 4 天，也印证了这个字段不能当顺序。

**全量用内容摘要作 `convKey`。** 28 个同 prompt 的 oneshot 会话会被并成一条，`conv_key` 相同、时间窗相近，`byConvTimeModel` 可能把它们错误合并到同一批网关行。 uniqueness 检查只多一次本库扫描，代价远小于错并。

**只做会话与消息补充，不进 `request` 行。** 与用户「忠于 trace」的要求冲突：这种做法只能得到消息浏览，拿不到逐笔请求行，也没法用现有 owner 匹配去重。用户已明确接入后要能被当作数据源使用。

**新建 crosswalk 表存本地会话与网关 conv 的映射。** `ingest.ts` 已有 `findRequestOwnerTx`：`convKey` 相同、agent 相同、±60 秒、模型归一后相等才合并，多候选标 ambiguous。适配器只要给出正确的 `convKey` 与 `startedMs`，不需要第二套身份表。

**把 rewind 掉的行（`0/0`）也摄入，或反过来重写它们的状态。** 前者违背 Hermes 自己的展示集（用户已放弃的分支会出现在 trace 里）；后者没有删除语义可用：`ingest.ts` 只插入、合并、刷新，不删行。适配器选择只发展示集，已经摄入的 rewind 行保留，代价见下文。

## Consequences

收益：Hermes 的 trace 顺序与 Hermes 自己完全一致，不再依赖 `id` 或时间戳猜测；摘要唯一性检查把 28 个碰撞会话挡在门外；逐笔用量缺失按已有 Grok 口径处理，不摊、不造数。

代价：一，行一旦摄入，后来被 rewind 也不会从 ATC 消失——`ingest.ts` 没有删除路径。要清掉只能整库重建，或是将来给读模型加失效标记，本轮不做。二，34 个摘要未命中的会话与 28 个碰撞会话用本地 session 键，暂时不会与网关行归到同一对话，它们本身仍是完整可读的会话。三，只有主会话写 `session_usage`，子代理的 token 不进会话累计。四，逐笔用量仍然没有，页面上的单笔用量列对 Hermes 是空的。

相关：[本地来源侦查](2026-11-05-hermes-local-source-recon.md)、[conv id 更正](2026-11-05-hermes-conv-id-correction.md)、[会话适配器契约](../feature/2026-11-04-agent-session-adapters.md)、[多来源身份归一提案](../../proposed/feature/2026-11-04-multi-source-call-identity.md)。