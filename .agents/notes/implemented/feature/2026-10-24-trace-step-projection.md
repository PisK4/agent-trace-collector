# Agent Note: 单行步骤投影 trace-view

Status: implemented

## Problem

生产中栏需要把可信新增输入与实际回复投影成单行步骤，但渲染与读取耦合在 DOM 闭包里，无法独立测试；工具按钮按 `result_req/result_ord` 反查调用，同消息多个结果时定位混淆。

## Decision

新增 `web/trace-view.js`：`projectSteps`（纯投影）、`toolSummary`（动作对象摘要）、`renderTraceRows`（单行 HTML），无 DOM、无网络。投影语义继承 Task 0 验证过的口径：用户步骤只来自可信 delta 的输入解释（text 与 unrecognized 各自成行）；回复块按协议原始顺序，thinking 不常驻，未知块给记录入口；请求级失败、缺正文、未收到回复、截断、未知停止各占一条记录行，已有内容步骤时不省略；辅助请求一条辅助记录，分支保留归属标记，dirty/unknown/branch 不产出确定用户步骤。`TraceStep.status` 只表达请求级与回复完整性，`result` 只表达工具关联；结果正文是否已读由 reader-store 决定。稳定键形如 `reqId:message:N` / `reqId:reply:text:N` / `reqId:call:N`，同一 `call_id` 出现在两笔请求不冲突。Chat 只对单 choice 结构化，多 choice 保留原始对象并说明限制。行 HTML 每行带窗口展示号（`data-request-ordinal`，仅显示），计量只在最后一步且增量读全时渲染一次，状态放独立元素不被摘要省略号裁剪，`toolSummary` 截断到 140 字符且不含结果正文。

`body-view.js` 的 `toolEntries` 保留调用者 `owner` 与 `result_path`；`renderTools` 按钮改为 `data-tool-owner` + `data-call-ord` 调用者身份，不再按结果位置反查——两个调用指向同一目标消息的不同内容块时按钮仍各有自己的调用序号。

## Alternatives considered

**把投影写进 app.js。** 无法脱离 DOM 测试顺序、键与 XSS；投影必须是纯函数。

**工具按钮继续用结果位置反查。** 结果消息里可以有多个内容块，反查会混淆同消息多结果；调用身份是 owner+ord。

**把「结果已读」写进步骤。** 已读是读取层状态，会随缓存失效回退；投影只描述派生事实。

## Consequences

Task 6 的中栏只需消费 `projectSteps` + `renderTraceRows`，行 CSS 类名与原型验证过的 compact-* 命名一致。验证：`bun test tests/trace-view.test.ts tests/body-view.test.ts tests/http.test.ts tests/web.test.ts` 全过（顺序与稳定键、unrecognized、注入转义、dirty/branch/unknown、aux、同 call_id 键不冲突、截断/未知/未收到、纯工具回复、多 choice、失败与缺正文并存、摘要只含动作、双工具同目标各自序号），`bun run typecheck` 通过（2026-10-24）。
