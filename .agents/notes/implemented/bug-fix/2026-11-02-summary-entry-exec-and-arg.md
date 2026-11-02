# Agent Note: 汇总条目补执行段与已有参数摘要

Status: implemented

## Problem

方向 A 走查发现工具列表与配对页缺调用耗时，列表行也无法区分同名调用的不同参数。`GET /api/sessions/:key/summary/entries` 此前只返回 `req_id`、`ord`、`tool_name` 与 `state`；第 5 步为避免读正文，明确选择不动数据层，代价是两次同名调用不点开无法分辨。

数据层其实已有这些事实：`tool_call` 与 `derive_tool_result` 都带 `arg_path`、`arg_skill` 和配对位置，请求行也带 `started_ms` 与 `ms`。缺的只是点击查询把已有事实带出来。

本记录部分取代[方向 A 第 5 步](../feature/2026-11-02-direction-a-step5-tools-pair-page.md)中「列表只给调用序号、不动数据层」的取舍；汇总端点字段的扩展同步更新[会话信息汇总](../feature/2026-10-25-session-trace-summary.md)。

## Decision

条目增加两个字段：

- `exec_ms` 复用 `getRequest` 的同一条窗口公式：结果请求 `started_ms` 减调用请求 `started_ms + ms`。只看调用方 `ms` 与结果请求 `started_ms` 是否存在，负值折成 null；不按 `state` 另设门控，异常 `result_req` 仍按既有位置事实计算。
- `summary = COALESCE(arg_path, arg_skill)`，只复用已提取的参数事实。Bash 等没有摘要的调用返回 null，不读正文、不解压、不加数据库列、不升派生版本。

选源继续沿用发布代优先、同步回退。额外 join 包在原有有界查询外层，只回查至多 `LIMIT 1000 + 1` 个主键，`(req_id, ord)` 顺序与截断语义不变；首页 `getSessionSummary` 的全表聚合只多选一个 `result_req` 列，不做 join。HTTP adapter 只对条目新增字段做顶层校验：`exec_ms` 必须是 null 或非负有限数，缺字段或负值按 `invalid_response` 拒绝。

## Alternatives considered

**逐条调用 `getRequest` 或解压正文取参数。** 列表最多 1000 条，逐条读取会放大解压与配对成本，正文回收后还得不到结果。否决。

**新增数据库列或物化摘要。** 摘要可由已有 `arg_path`/`arg_skill` 直接得出，加列要改 schema 与派生版本，收益不足。否决。

**把耗时与摘要加到首屏 `getSessionSummary`。** 只有点击列表需要它们；首屏全表聚合不应为此扩大。额外计算只发生在点击查询。否决。

**按 `state = resolved` 门控 `exec_ms`。** 会与 `getRequest` 的现有读数语义分叉，配对是否成立属于展示层判断。继续沿用同一公式，异常 `result_req` 的处理保持不变。否决。

## Consequences

- 列表可在不读正文的情况下显示调用耗时与已有参数摘要；Bash 没有现存摘要，前端只同步复用已缓存详情，缺值时仍按调用序号定位。
- 代价是点击查询多两次主键回查，且 `tool_call`/`derive_tool_result` 的公共聚合行多带一个 `result_req` 列；首屏聚合不做新的 join。
- 旧调用若 `result_req` 异常但时间齐备，`exec_ms` 仍会计算，与 `getRequest` 一致。这是既有位置事实的语义，不在本次另判。

## Testing

- `tests/session-summary.test.ts`：resolved 正值、零、负值、调用方缺时长与 pending；`arg_path` 优先于 `arg_skill`、Skill 摘要与 Bash null；发布代与同步回退互斥且同一请求不重复。
- `tests/read-http.test.ts`：完整条目通过；缺 `exec_ms`/`summary` 与负 `exec_ms` 均按 `invalid_response` 拒绝。
- `tests/star-session.test.ts`：合成调用带回 Read/Edit/Write 路径与 Skill 名称，Bash 无摘要。
- 合成浏览器由主 Agent 在隔离分支验收，结果见[合成验收](../../../../docs/acceptance.md#方向-a-界面对齐修正合成2026-11-02)。生产发布由用户在 2026-11-02 显式授权，真实流量结果单独记录在[生产验收](../../../../docs/acceptance.md#方向-a-界面对齐修正生产2026-11-02)，合成结果不替代生产结果。
