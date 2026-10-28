# Agent Note: 单行步骤投影 trace-view

Status: implemented

## Problem

生产中栏需要把可信新增输入与实际回复投影成单行步骤，但渲染与读取耦合在 DOM 闭包里，无法独立测试。工具按钮按 `result_req/result_ord` 反查调用，同消息多个结果时定位混淆。

## Decision

新增 `web/trace-view.js`：`projectSteps`（纯投影）、`toolSummary`（按工具分派的动作摘要，见 [pretty-trace](2026-10-24-pretty-trace-tool-summary-and-tint.md)）、`renderTraceRows`（单行 HTML），无 DOM、无网络。投影语义继承 Task 0 验证过的口径，并按[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)扩展。用户步骤来自可信 delta 的输入解释（text 与 unrecognized 各自成行）。可信 delta 内的 System 消息与工具结果内容块各出独立步骤（`tool_result` 按内容块拆键），System 消息不再是纯用户输入的排除项。顶层 System 由装配层按同 actor 已确认前驱比较后经 `systemContext` 参数传入。与前驱同值时不重复，有变化就标明，不可比时只声明当前；投影不做时间推断。每个内容步骤带 `source`（`request.system`、`request.messages[N](.content[M])`、`reply.content[i]`、`reply.choices[0].message.tool_calls[i]` 等实际协议路径）；记录与辅助步骤的 `source` 为 null。可信增量未完成或失败时投影一条 `reqId:delta` 事件记录（剩余条数或失败原因），点击由装配层续读两片，完成时不出现。回复块按协议原始顺序，thinking 不常驻显示，未知块给记录入口。请求级失败、缺正文、未收到回复、截断、未知停止各占一条记录行，已有内容步骤时不省略。辅助请求产出一条辅助记录，分支保留归属标记；dirty/unknown/branch 的消息不认作确定新增。actor 未知且正文可读时展示请求本身的消息，见[孤立请求的正文与来源报告](../bug-fix/2026-10-27-unassigned-request-reading.md)。角色标签统一英文（`User`/`Assistant`/`Tool`/`System`/`Aux`/`Event`）：调用行显示 Assistant 加工具名着色 chip，结果行显示 Tool 加调用方摘要 chip（缓存内同款摘要、缓存外只工具名、未配对中性，见 [pretty-trace](2026-10-24-pretty-trace-tool-summary-and-tint.md)）。标签只负责显示，CSS 类名用稳定 kind。`TraceStep.status` 只表达请求级与回复完整性，`result` 只表达工具关联；结果正文是否已读由 reader-store 决定。稳定键形如 `reqId:message:N` / `reqId:message:N:result:M` / `reqId:reply:text:N` / `reqId:call:N` / `reqId:system` / `reqId:delta`，同一 `call_id` 出现在两笔请求不冲突。Chat 只对单 choice 结构化，多 choice 保留原始对象并说明限制。行 HTML 每行带窗口展示号（`data-request-ordinal`，仅显示），只呈现角色、工具身份 chip 与内容，选中用稳定步骤键标识；行内展示取舍见[中栏内容与右栏详情](../simplification/2026-10-24-trace-content-only-and-wide-rail.md)。`toolSummary` 的摘要形态与截断口径由 [pretty-trace](2026-10-24-pretty-trace-tool-summary-and-tint.md) 解释。摘要不在字符数上截断（超长由列宽省略号处理），不含结果正文。

`body-view.js` 的 `toolEntries` 保留调用者 `owner` 与 `result_path`。`renderTools` 按钮改为 `data-tool-owner` + `data-call-ord` 调用者身份，不再按结果位置反查。两个调用指向同一目标消息的不同内容块时，按钮仍各有自己的调用序号。

[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)扩展了本 note 原来仅用户输入进入轨迹的范围，并统一英文角色标签；稳定键、调用身份与纯投影的决定继续有效，部分取代关系随修复实施同步。

[回复协议拆分收敛进 replyView 单点](../architecture/2026-10-25-reply-single-protocol-split.md)之后，本 note 描述的回复步骤语义不变，但 `projectSteps` 不再自行解析 `meta.reply`：有序块、全路径与 choiceCount 都来自 `replyView`，协议分叉只有那一个家。

## Alternatives considered

**把投影写进 app.js。** 无法脱离 DOM 测试顺序、键与 XSS；投影必须是纯函数。

**工具按钮继续用结果位置反查。** 结果消息里可以有多个内容块，反查会混淆同消息多结果；调用身份是 owner+ord。

**把「结果已读」写进步骤。** 已读是读取层状态，会随缓存失效回退；投影只描述派生事实。

## Consequences

生产中栏消费 `projectSteps` + `renderTraceRows`，行 CSS 类名沿用原型验证过的 compact-* 命名。验证：`bun test tests/trace-view.test.ts tests/body-view.test.ts tests/web.test.ts` 全过（顺序与稳定键、unrecognized、注入转义、dirty/branch/unknown、aux、同 call_id 键不冲突、截断/未知/未收到、纯工具回复、多 choice、失败与缺正文并存、摘要按工具分派、System 顶层与消息级来源键、System 上下文三态、混合消息按块出步骤、两类协议回复来源路径、英文标签与工具 chip、systemContextOf 前驱比较），`bun run typecheck` 通过（2026-10-24）。

[中栏按承载请求的 delta 分组](2026-10-28-request-delta-trace-groups.md)部分取代本篇关于 delta 只投影输入消息、回复对象投影，以及 `reqId:reply:*` 与 `reqId:call:*` 行语义的决定：assistant 文本块与 tool_use 调用块现在各出一行，回复只在末尾组投影，普通组不再有回复行。纯投影、稳定步骤键、精确协议来源、可信 delta 闸门与请求状态、配对状态分立的决定继续有效。
