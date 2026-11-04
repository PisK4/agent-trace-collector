# Agent Note: WorkBuddy 本地会话适配器：messageId 回复组与子代理折叠

Status: implemented

WorkBuddy 把会话写在 `~/.workbuddy/projects/<project>/<uuid>.jsonl`，子代理另写在 `<uuid>/subagents/agent-*.jsonl`。接入前 `workbuddyAdapter` 是占位实现：`roots()` 恒返回空，扫不到本机两个主会话与四个子代理文件里的 141 笔带用量的模型回复。批次 A 的共享登记面已经把 `workbuddy_session` / `workbuddy_session_call` 与 `implemented` 状态铺好，本分支只填适配器本身。

## Problem

### 一行不是一笔调用

WorkBuddy 的每行是 OpenAI Agents SDK 的一条 item：`message`、`reasoning`、`function_call`、`function_call_result`、`file-history-snapshot` 等。抽样本机六个文件，带 `providerData.usage` 的 141 行里 123 行是 `function_call`、18 行是 `assistant` 消息；同一笔模型回复的若干行靠 `providerData.messageId` 串起来，组内只有一行带 usage。Claude 适配器按 `message.id` 合并内容块的写法能借鉴，但「assistant 行直接建调用」的判据在 WorkBuddy 上会漏掉以 function_call 收尾的回复，也会把同一回复的 reasoning / 工具行算成多笔。

### 用量口径含缓存

`providerData.usage.inputTokens` 把缓存读与缓存写算在里面，`inputTokensDetails[].cached_tokens` 另记缓存读，`cacheCreationTokens` 记缓存写。共用摄入约定 `SessionCall.usage.input` 不含缓存读写，直接照抄会把 input 报大。Magpie 的 `calls_workbuddy.go` 用 `max(0, in - read - write)` 归一，旧历史还用 `input_tokens` / `output_tokens` 蛇形字段名。

### 子代理的身份会相撞

子代理文件与主会话同形，`sessionId` 是子代理自己的 id，父会话 id 只能从路径 `<uuid>/subagents/` 反推。同父的多个子代理各自编号，文件内 messageId 可能相同；DSH 已经踩过一次，把子代理调用折叠到父会话时若 callId 不带子代理身份，证据 `ref_key` 会相撞、后到的行被当成重复丢掉。

### 快照行不该进原始层

`file-history-snapshot` 每行带整份文件快照，本机 61 行。落进 `raw_session_event` 只是把大块元数据再存一份，对归约没有用处。

## Decision

### 1. 发现与读取

- 根是 `$WORKBUDDY_CONFIG_DIR`，未设置时取 `~/.workbuddy/projects`；环境变量值以 `~/` 开头时展开成 home。与 Magpie 的 `WorkBuddyDir` 一致。
- `discover` 用 `discoverJsonl(root, cursorFor)`，默认深度 5 覆盖 `<uuid>/subagents/agent-*.jsonl`，只读 stat 不读正文；`read` 用 `jsonlRead(file, cursor, 'workbuddy_session')` 按代际续读。
- `read` 是纯追加 JSONL，行偏移就是真实游标位置，没有容器层，不设 `lineCommit: false`。

### 2. 解析

- 坏 JSON 与非对象行记 `workbuddy_invalid_json` / `workbuddy_invalid_object`，游标停在坏行起点。
- `file-history-snapshot`、`ai-title`、`custom-title`、`resend-fork-notice` 返回 `ignore`：游标照常前进，不落原始层、不进状态。其余行型都进状态，未知行型不判坏。
- `providerData.model` 优先，退回 `requestModelId`；`messageId` 作为回复组身份；usage 归一到 magpie 四段口径，兼容蛇形字段名与 `inputTokensDetails` 的单对象/数组两种形状。

### 3. 归约：messageId 是一笔调用

- `apply` 按行顺序累积消息窗口。遇到用户 `message` 先结算挂起回复再进窗口；换 `messageId` 结算上一笔；同 id 的 reasoning / function_call / assistant message / function_call_result 行合并进同一笔的 `replyContent`。
- 组内在任意一行出现 `usage` 就取其值，后到的覆盖先到的（本机样本每个 messageId 恰好一行带 usage）。
- 批末 `flush` 补发仍挂起的回复；`liveDirty` 只在有本批新行时置位，重放的历史行不触发补发，避免每轮重复刷新同一笔。
- 旧历史没有 messageId 但带 usage 的行按 `off:<行偏移>` 给它稳定身份，一行即一笔调用。
- 正文协议是 `chat`：请求侧是此前累积的用户/助手/工具消息数组，回复侧包成 `choices[0].message`。
- `mutable: true` 配 `refreshOnDuplicate: true`：同一回复的行跨批次到达时，重放后以同一 ref 补发，刷新既有正文而不新建行。

### 4. 子代理折叠

- `emptyState(file)` 从路径里的 `subagents` 段取父目录名作为 `sessionId` 与 `parentSessionId`；文件内 `sessionId` 归 `subagentId`。
- `callId` 是 `<subagentId>/<messageId>`，证据 `ref_key` 是 `<父会话>/<callId>`。主会话不带子代理前缀。
- `SessionCall` 的 `subagent` 与 `parent_agent` 同源填好，页面按父会话阅读时子代理行有正确归属。

### 5. 无 schema 变更

`workbuddy_session` 已登记在 `SourceKind`、注册表与 `catalog.ts` 的 `implemented` 状态里，本分支不动这五个共享文件。共用 `raw_session_event`、`request`、`request_evidence` 与 `body`，没有新表或新列。

## Alternatives considered

**按 assistant 消息行逐行建调用。** 与 Claude 适配器最像，改动最小。本机 141 笔带 usage 的回复里 123 笔的 usage 落在 `function_call`，assistant 消息行经常不带用量甚至不存在（纯工具回复），这条判据会漏掉绝大多数调用。

**只认带 `providerData.usage` 的行，一行一笔。** Magpie 的 `calls_workbuddy.go` 走的是这条路，它只需要用量账本。ATC 还要存正文：同一回复的 reasoning、文本、工具调用散在几行里，只取一行会丢掉回复的其余部分，请求窗口也无从累积。

**用 `parentId` 还原组内顺序。** 同 reply 的行跨批次到达时，重放按偏移排序会把后到的 function_call 追加到 reply 末尾，与文件里的 `parentId` 链顺序不一致。按链重排要在状态里维护全组拓扑，且本机 `parentId` 只指向上一行、不是稳定的回复根，收益不抵复杂度。刷新后的正文保留全部内容块，顺序差异记在下面的代价里。

**把子代理按文件内 sessionId 当独立会话。** 实现省事，页面却会因此把一次委派拆成多个会话；其它本地 Agent 的子代理都折叠到父会话，WorkBuddy 不该单独一套。

**为子代理追到根会话。** 需要在发现阶段读所有文件头，本机路径只有一层 `subagents`，直接父会话已足够，深链以后再补。

**不改 `mutable`，跨批次行直接丢弃。** 同一回复分批到达时会永久丢掉后到的工具行；`refreshOnDuplicate` 让证据重复时仍刷新正文，与 Claude 同口径。

## Testing

新增 `tests/session-workbuddy.test.ts`，全部使用合成目录与合成行，不引用真实请求正文、账号、令牌或用户配置：

- 首次摄入：reasoning / function_call / function_call_result / assistant 四行按 messageId 归一成一笔，`inputTokens=100` 扣掉 30 缓存读后写 70，正文含四个内容块，快照行不落原始层，证据是 `<会话>/gen-reply-1`。
- 追加读取：同 reply 的 function_call 下一批到达时以同一 ref 刷新正文（0 新调用、1 重复、1 刷新）；再追加新 messageId 建第二笔，重放后的请求窗口带着首笔回复。
- 坏行停游标：坏行前的调用已落库，坏行记 `workbuddy_invalid_json`，`committed_off` 小于 `seen_size`。
- 子代理折叠：主会话与子代理各建一行，`session` 归父、`subagent` 归己、证据带子代理 id。
- 两个子代理用完全相同的 messageId 各建一行，`ref_key` 唯一数为 2，`ingest_issue` 为 0。

`bun test tests/session-workbuddy.test.ts` 5 pass / 0 fail，`bun run typecheck` 退出 0。真实流量与生产回填读数由主线程串行部署后补进验收记录，本 note 不复制。

## Consequences

- 收益：WorkBuddy 的逐笔模型回复进入统一的 `request` / `request_evidence` / `body`；用量按 magpie 口径归一；子代理折叠到父会话且不因同序号撞键丢行。
- 代价：同一回复的行跨批次到达时，重放按偏移顺序刷新正文，后到的工具块会排在文本块之后，与文件里的 `parentId` 链顺序不一致。内容不丢，顺序以摄入先后为准。
- 未覆盖：`ai-title` / `custom-title` 的会话标题、`resend-fork-notice` 的重发语义、`reasoning` 的 `rawContent` 与思考档位都没有进 `request` 或 `source_facts`；缺 messageId 且不带 usage 的行只进窗口、不建调用。Magpie 的 `models.json` 网关模型排除规则也没实现，经 magpie 网关发出的调用可能与网关侧证据各建一行，这属于跨来源认领的后续议题。
- 验收缺口：生产部署、真实流量对账、正文抽样可读、`docs/acceptance.md` 读数与覆盖矩阵更新都由主线程收口，本分支不碰这些文件。

## Related

- [覆盖护栏](2026-11-04-coverage-foundation.md) 记录 live/backfill 双档调度与来源目录骨架。
- [DSH 本地会话适配器](2026-11-04-dsh-session-adapter.md) 的子代理证据键教训是本次 `callId` 带 `subagentId` 的直接依据。
- [覆盖矩阵](../../../../docs/agent-coverage.md) 的批次 A 与「每批完成条件」定义本分支的交付边界。
