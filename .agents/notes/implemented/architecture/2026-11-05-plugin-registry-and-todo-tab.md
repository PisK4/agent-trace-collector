# Agent Note: Plugin 登记层、第五页签与 todoByTurn 接缝

Status: implemented

## Problem

页面 Plugin 机制的首版方案在[页面 Plugin 机制与首个 Todo 插件](../../proposed/architecture/2026-11-04-plugin-system-and-todo-feature.md)里拍板，但方案落到代码时需要回答三个具体问题：登记项装什么、轮次号从哪来、第五页签怎么接进既有读取架构。这三个接缝在代码里定型后，第二个 Plugin 照着接进来才有可复制的形状。

## Decision

服务端 `src/plugins/registry.ts` 的 `PLUGIN_REGISTRY` 是静态登记数组，一项装 id、页签 key、是否启用、Parser 数组与 DTO 校验入口；`parsersOf()` 注入空数组即可整路关闭，形状沿用 `PURPOSE_RULES` 与 `SESSION_ADAPTERS`。前端 `web/rail-tabs.js` 的 `RAIL_TABS` 是页签登记数组，次序即页签次序与滑动方向，`scope` 区分请求作用域与轮次作用域：轮次作用域页签在轮次态点击时保留 `turn`，其余四栏点一下仍回请求态。两份登记靠 tab key 静态对齐，不新增一条拉注册表的读取。

`todoByTurn` 是第 15 个具名读取操作，走新 HTTP 路由 `/api/sessions/:key/todo`。现有批端点的输入是 id 列表与正文区间，与它的（会话、actor、轮号）输入和一致性要求都不同；按[读取功能接入规则](../../../../docs/read-feature-rules.md)核对后不复用批端点。actor 为空串时服务端用 `mainActorOf()` 结算主链归属，前端不猜。轮号不落库，`src/queries/todo-by-turn.ts` 调 `listTurns()` 即时结算，用 `start_req`/`reply_req` 与 `started_ms` 界定轮内请求；工具身份从 `tool_call.tool_name` 取，不依赖 `result_req`。

参数不在 `tool_call` 里，在正文块的 `tool_use.input`。查询按请求分组解压一次，把 `tool_name` 与 `input` 按 ord 对齐后交给 Parser 按序折叠：全量快照型覆盖上一时点，增量命令型在上一时点上累积，末次即该轮显示值。正文回收后如实返回 `unavailable`，不写成空列表。四家 Parser 只交 DTO，`validateTodoSnapshot()` 收口畸形值，`tests/plugin-boundaries.test.ts` 用 AST 守它们不 import 核心、不 fetch、不产出 HTML。

前端 `web/todo-tab.js` 只拼 HTML 字符串，动态文本全部 `esc()`；`web/reader-store.js` 的 `loadTodoByTurn()` 用会话代次、会话键、actor 与轮号组成复合身份，切会话或切轮次后的迟到响应不写回缓存。

## Alternatives considered

**让前端从服务端拉一份注册表动态生成页签。** 落选。那是一条新的具名读取，把页签渲染耦合到网络往返；两份登记靠 tab key 静态对齐即可，关掉 Plugin 时前端只渲染空内容。

**把 todoByTurn 塞进 `readings` 批端点。** 落选。批内每项要求稳定 index 与身份，Todo 的输入是轮次三元组而不是 id 列表，塞进去会违反[读取功能接入规则](../../../../docs/read-feature-rules.md)的用例成批要求。

**前端持有 actor。** 落选。轮次态的 actor 由 `mainActorOf()` 按参与请求数结算，属于轮次结算口径；前端从 `listTurns` 拿不到它，自己猜会让跨 actor 会话串线。

## Consequences

代价是两处登记数组要人工对齐 tab key，改一处要同时改另一处；收益是新增一栏只动登记数组与一个渲染模块，URL 往返、选择归一化、滑动次序、主体分派都从同一份登记派生。四家 Parser 的形状差异进插件目录，核心查询不出现 Agent 名称比较。正文回收后 Todo 消失是零迁移的代价，查询返回 `unavailable` 而不是空列表，页面能区分没写待办与读不到。社区轨的 Worker 隔离、清单加载与 `failed` 状态见[社区轨的本地包加载与 Worker 隔离](2026-11-05-community-plugin-worker.md)；本篇只覆盖内置轨与页面注册能力。
