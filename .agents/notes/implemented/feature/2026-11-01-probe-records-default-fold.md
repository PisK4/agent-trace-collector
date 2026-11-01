# Agent Note: 无正文探针记录默认折叠

Status: implemented

## Problem

左栏连续出现四行「（无标题）· magpie · 1 笔 · 缺正文」，时间 04:26、05:26、06:26、07:26。它们不是任何一次对话，是 magpie 自己的探针请求。

实现时的只读快照（2026-11-01）：708 个会话组里 258 个是探针组，占 36%；最近 50 个会话行里有 21 个。构成是 `source:model_list` 135 笔（10-26 起每小时一次，日均约 23）、`source:provider_test` 119 笔（其中 83 笔 HTTP ≥400）、`source:api_detect` 4 笔。

它们以会话行的样子出现，是三件事叠在一起：

- 探针没有 session 归属，`ledgerConv`（`src/evidence.ts`）退回 `["request", refKey]`，一笔自成一组。258 组的 `conv_source` 全是 `request`。
- 组里没有参与链请求，`SESSION_TITLE_SQL` 取不到标题，界面回退「（无标题）」；`agent` 列是上游客户端标签 `magpie`。
- 258 笔全部 `via='through'`、`have=2`（只有账本和路由）、`body_state='pending'`、`miss_reason='hook_absent'`。`model_list` 是 `GET /backend-api/codex/models`，本来就没有消息正文；探针也没有 session 可供 hook 关联。缺正文在这里是结构性的，等多久都不会出现，不是采集故障。

这些记录有保留价值。`provider_test` 的 83 笔失败是本机到各 provider 的连通性证据，错误文本只存在 `raw_ledger.err` 与 `payload_json`，`request` 表没有错误列。删掉它们，provider 出问题时就只剩「请求失败」一个结论，没有原因。

要解决的是阅读投影：这些记录不该以会话行的形式占据左栏。中栏对无内容请求的处理见[不可读 trace 的默认阅读投影](../../implemented/feature/2026-10-31-unreadable-trace-recovery.md)；旁路会话折叠的判据与代价见 [OMP 接入](../../implemented/feature/2026-10-25-omp-harness-integration.md)。

## Decision

探针记录与旁路会话在左栏默认折叠，可展开；存储、用途判定与统计口径不变。

### 判定：全量探针、无正文、零用量

`listSessions`（`src/queries/sessions.ts`）的 `SESSION_FLAG_COLUMNS` 聚合四个条件，全满足才给 `probe` 标志：

- 组内每一笔 `req_kind` 属于 `PROBE_KINDS`：`source:model_list`、`source:provider_test`、`source:api_detect`；
- 组内没有一笔 `body_state='available'`；
- 组内 token 与费用全为零：`in_tok`、`out_tok`、`cache_read`、`cache_write` 相加为 0（NULL 按 0 计），`cost` 为 0 或 NULL；
- 组内每一笔 `actor IS NULL`。

每个条件都在防误杀。全量要求保证混组不折；正文与用量检查挡住「上游标了探针但其实有内容」；`actor` 检查保证有归属的组不动。`probe` 排在失败、待确认、缺正文、旁路之后。

实现时按同一判定在库上聚合，258 组命中，等于库内探针 kind 组数，差集为 0。同类的非探针 kind 不受影响：`source:vision` 155 笔里 145 笔有 token 与费用，`source:web_search` 44 笔里 43 笔有，`source:ambient_suggestions` 4 笔全部有，`source:memory_consolidation` 1 笔有 actor。

### 列表投影

- `web/app.js` 的 `renderSessions` 默认过滤带 `probe` 或 `bypass` 的行，`state.showFolded` 是唯一的展开开关。
- `web/session-view.js` 的 `sessionsListFoldHtml`（原 `sessionsListBypassHtml`）按两类计数渲染一行：`已折叠 21 条探针记录 · 3 条旁路会话（已加载页）`；只有一类时只显示那一类，展开后改为「收起 21 条探针记录 · 3 条旁路会话」。
- 默认选中跳过折叠行：确定会话时取第一笔既不是 `probe` 也不是 `bypass` 的组。今天 `items[0]` 很可能就是探针组，不跳过，折叠等于白做。
- 选中的会话即使带 `probe` 或 `bypass` 也临时出现在列表里，离开选择后回到折叠；折叠计数只算实际折起来的行。
- `sess-count` 的比较基准是折叠前的搜索结果，只在搜索或 Agent 筛选收窄时出现分数，折叠不再被算成收窄。

### 不做的事

- 不改存储、不改 schema：探针记录照常入库，正文状态、证据位与错误文本不动。
- 不改用途判定：`sourceDecision` 仍然让所有非 `title` 来源 kind 参与链，`PURPOSE_VERSION` 不变，不触发重建。
- 不改 `/api/stats`：探针仍计入 `requests`。magpie 自己不计探针，ATC 的口径与之不同。

### 与既有记录的关系

- [不可读 trace 的默认阅读投影](../../implemented/feature/2026-10-31-unreadable-trace-recovery.md)管会话内中栏时间线，本记录管左栏会话列表。两者都只做阅读投影，互不取代。
- [请求用途与链](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)的「其它非空来源 kind 一律参与链」保持不变；这里只消费它产出的 `req_kind`。

## Alternatives considered

**删除探针请求，或入库时丢弃。** 落选：83 笔 `provider_test` 失败的错误文本只存在账本里，删了就失去 provider 故障原因；探针本身也是本机连通性的时间序列。

**在用途层把探针标成 exclude。** 落选：`sourceDecision` 对所有非 `title` 来源 kind 一律 `participate`，是[请求用途与链](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)记录的决定。收紧它要升 `PURPOSE_VERSION`、列反例、按显式重建交付，影响所有消费链的地方。以后要给探针做独立诊断面时再走这条路。

**按结构特征折叠（无 session、`have=2`、零用量、无正文）。** 落选：用户自己发的、没有 session 归属的 curl 类调用也符合这组特征，会被一起折掉。kind 白名单能证明这是 magpie 自己标的探针，结构特征不能。

**在 `/api/sessions` 里直接排除。** 落选：接口报存储事实，折叠放在渲染层；SQL 层过滤会改游标与 `next_cursor` 语义，折叠计数还得另开全量查询，否决记录见 [OMP 接入](../../implemented/feature/2026-10-25-omp-harness-integration.md)。

**彻底隐藏，不留折叠行。** 落选：误判时读者看不到任何痕迹。折叠行给出条数，错折能立刻发现，展开还能核对。

**把 magpie 的 `source: probe` 落成请求事实（新列加 backfill）。** 未采纳。账本 `payload_json` 里的 `source` 才是探针的权威标记，落成列后未来新增探针 kind 自动覆盖；代价是 schema 变更、mapping 与合并逻辑、一次性 backfill。今天三个 kind 是 magpie `probelog` 的封闭集合，`req_kind` 已经能精确区分，先用现成字段。触发条件：magpie 新增探针 kind，或要建探针诊断面。这不算地基错误：`req_kind` 本来就是来源 kind 的规范落点，探针只是它的三个取值。

## Consequences

收益：左栏不再被每小时一次、一笔一组的探针占据；默认打开页面落在真正的对话上；探针的失败证据、用量与时间序列完整保留，展开就能核对。

代价与风险：

- **kind 白名单漏新探针**：magpie 新增探针 kind 时不会折叠，表现为多几行噪音，不是误杀。改一行 `PROBE_KINDS` 即可。
- **`magpie` 筛选 chip 变空**：Agent 筛选项来自已加载行，折叠后选 `magpie` 只剩折叠行。本轮不处理；要处理就把折叠组从筛选项里去掉。
- **搜索不穿透折叠**：与旁路现状一致，搜索探针 ID 需要先展开。
- **探针突发时列表几乎为空**：一页 50 行全被折叠时，左栏只剩折叠行，中栏未选择。措辞如实给出条数。
- **统计口径仍与 magpie 不同**：`/api/stats.requests` 含探针。这是已知差异。

### Testing

- `bun test tests/queries.test.ts tests/web.test.ts`：77 通过。覆盖全量探针命中、带 token、带费用、带正文、带 actor、混组与 `source:vision` 七种形状，以及折叠行的两类计数与展开文案。
- `bun run typecheck` 通过。
- 生产库只读（2026-11-01）：按判定聚合出 258 组，等于库内探针 kind 组数，差集为 0；总组数 708。
