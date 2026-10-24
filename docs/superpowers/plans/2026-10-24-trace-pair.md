# Trace Pair Implementation Plan

> 本次在当前会话直接实施；用户随后要求逐模块提交，实际落为两个提交（后端 9ba9ff8、前端 ec7fd1f）。
> 执行范围来自用户的 Trace Pair 需求与 2026-10-24 拍板：Tool pair 必做、无跳转、视觉统一；其余配对候选记入 note 边界。

**Goal:** 点击 Tool call 或 Tool result 步骤，在右栏配对页就地同屏阅读两端，Call 与 Result 用同一套原文样式；阅读在右栏完成，不跳转。

**Architecture:** 详情提供 `tool_results` 反向配对（本请求承载的结果块指向的调用）；前端按调用身份复用 reader-store 与结果读取接口，按需加载窗口外调用方。未确认关联不猜配，阅读版本变化沿用整笔作废。

**Tech Stack:** TypeScript、Bun、SQLite、原生 JavaScript；不新增依赖，不变更 schema。

**Spec:** 用户本次需求与拍板：Tool pair 必做；工具声明对照（Schema vs 参数）不做；请求级 Request/Reply 与 Subagent 派发配对不做，边界记入 note。

## Global Constraints

- 测试只用合成数据；真实正文不进入 fixture 或日志。
- 正文一律转义；不变更 schema，不扫描全部历史正文。
- 交互原则：阅读类信息在右栏就地展示，不新增「点击后跳到别处阅读」的按钮；承载请求等身份只以文本显示。
- 视觉统一：配对页复用正文详情既有组件（body-panel、pre.raw、detail-label、note、chain），不引入新样式体系，不分左右栏。
- 只跑相关回归、类型检查及 note 检查；不自动提交。

## Task 1: 反向配对索引与原始结果

**Files:** `src/queries.ts`、`src/reading.ts`、`tests/queries.test.ts`、`tests/reading.test.ts`。

**Interfaces:** `RequestDetail.tool_results: (ToolCallRow & { owner_req: number })[]`；`ToolResultReading.raw` 在 available 时提供精确协议对象（Anthropic 为 tool_result 块，Chat 为整条 role=tool 消息），其余状态为 null。

- [x] 同一事务内反查：发布代表先读 `derive_tool_result`（generation 前缀有界），非空优先；回退同步 `tool_call` 时用同组请求（conv_key/actor）IN 子查询驱动 `(req_id, ord)` 主键，不全局扫描。非 current 一律空数组。
- [x] 查询回归沿用已就位的三条断言（同步反向、dirty 清空、发布代优先于同步诱饵）；retained/dirty 处补空断言。
- [x] reading 成功响应带 raw 并同步类型；reading 测试补 Anthropic 块、Chat 消息与 pending raw=null 断言。
- [x] 运行 `bun test tests/queries.test.ts tests/reading.test.ts`。

## Task 2: 配对页与就地阅读

**Files:** 新建 `web/trace-pair.js` 与 `tests/trace-pair.test.ts`；修改 `web/app.js`、`web/body-view.js`、`web/trace-view.js` 及相关回归。

**Interfaces:** `renderTracePair(input)` 纯函数生成配对页：Call 面板在上、Result 面板在下，默认同时展开；状态文案（pairStateText/loadStateText/isErrorText）迁入 trace-pair.js，app.js 引用。

- [x] 工具四页第三页由「结果」改为「配对」；点调用步骤、结果步骤或工具行直达配对页并自动发起一次结果读取（失败保留显式重试）。
- [x] 结果步骤反向解析：`detail.tool_results` 按 result_ord + 精确路径匹配（Anthropic 内容块路径、Chat 整条消息），resolved 才携带 owner；未匹配（dirty/legacy/未配对）保留现行正文定位。
- [x] Chat 的 role=tool 结果步骤按整条协议消息投影，路径与后端 result_path 一致；`ensureRead` 的消息序号解析不再用 `split(':').pop()`。
- [x] 删除 `toolResultPanel` 与 `data-result-owner`→`locateRequest` 跳转流程；工具往返行的「→ 结果」按钮改为右栏内打开配对页；配对页内承载请求身份只以文本显示。
- [x] 配对页对窗口外调用方按需 `ensureRead`；迟到写入沿用 owner 键缓存与 409 整笔作废。
- [x] 用合成测试锁住：两方向进入、混合消息精确块、同 ID 多调用、未配对/待定/多候选状态、转义、无跳转属性（data-result-owner/data-locate 不出现）、窗口外调用方。
- [x] 运行相关前端测试与 `bun run typecheck`。

## Task 3: 文档与验收

**Files:** `docs/architecture-design.md`、`.agents/notes/implemented/feature/2026-10-24-trace-pair.md`，交叉链接现有角色定位与工具详情 note。

- [x] 架构文档：轨迹阅读布局更新配对页点击行为与无跳转原则；接口表补 raw；读模型补 tool_results 反向索引口径。
- [x] note 记录：身份依据（result_req/ord/path 精确匹配、resolved 才携带）、按需读取、无跳转与视觉统一原则；其他候选 pair 的逐条边界——Schema 对照不做（两端已在工具四页）、Request/Reply 请求级不做（读数页已覆盖且输入过大）、Subagent 派发配对暂缓（subagent/parent_agent/subagent_id 仅身份路由字段，可靠关联缺采集侧证据，否决时间窗启发式；Agent 工具调用本身随 Tool pair 展示）、System 前驱对比不另做（时间线变更标注已覆盖）。
- [x] 部分取代交叉链接：更新工具详情与角色定位两篇旧 note 的点击导航说明，不归档。
- [x] 检查 `git diff --check`、`bun run verify:notes`，记录实际结果。
- [x] 报告改动、测试与限制，按仓库提供英文 commit message。
