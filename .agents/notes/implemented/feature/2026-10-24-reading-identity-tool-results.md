# Agent Note: 阅读身份与按位置的工具结果读取

Status: implemented

## Problem

详情、正文与工具结果是三次独立 GET，中间摄入可以推进：旧详情的增量配着新正文，工具结果按全局 `call_id` 猜配。生产阅读需要「同一批派生输入」的可验证读取，以及一个调用精确到一个内容块的结果定位。

## Decision

新增 `src/reading.ts`。每笔请求的读取身份是 `r1-` 加 SHA-256：绑定 canonical id、输入 epoch/修订、会话与 actor、用途四列、正文三态与 adapter 版本、组八列（组不存在占固定 null 槽位）、实际派生来源的算法与保留状态——发布代来源额外绑定代际行的 epoch/修订/用途修订。费用更新不在身份里。详情响应附带 `reading_token`；正文接口的 `if_reading` 可选，工具结果接口必填，与当前身份不符抛 `ReadingConflictError`，HTTP 映射 409 `reading_changed`，畸形值 400。alias 解析、身份与数据读取在同一个只读事务，内嵌 `getRequest` 走 Bun 保存点。

工具结果按调用位置读取：owner 的调用序号定位一次调用，关系 `resolved` 且组 current 才继续；路径只认 `request.messages[N](.content[M])?`，N 必须等于 `result_ord`，目标 canonical、conv_key 与 actor 必须与调用方一致；Anthropic 目标块必须是配对 `tool_use_id` 的 `tool_result`，Chat 必须是 `tool_call_id` 匹配的 `role=tool` 消息。不跨请求搜索、不回退第一块。状态固定六值，原因用固定词，`is_error` 三态；关联已确认与工具成功、正文已读取是三件事。

[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)修正了前端失效实现，并统一多 choice 的调用位置限制；本决定的条件读取与 owner+ord 结果身份继续有效。

## Alternatives considered

**一个全会话事务冻结全部历史。** 长会话读取与保留成本高；请求级条件读取已能检测失效，不承诺跨 GET 冻结。

**用 `updated_at` 当版本。** 它随费用等非轨迹写入推进，会把不相关更新误判为失效；身份必须列名固定。

**工具结果按 `call_id` 全局查。** 同一 `call_id` 出现在两笔请求会串用；按 owner+调用序号+记录路径才精确到内容块。

## Consequences

前端可以在下次读取时发现版本过期并整笔重建，迟到响应没有伪造确定步骤的空间；同消息多个工具结果按完整位置分别可读。验证：`bun test tests/reading.test.ts tests/body-api.test.ts tests/http.test.ts tests/queries.test.ts` 全过（输入修订/组 dirty/新发布代/正文回收/请求折叠拒绝旧 token、费用更新不换 token、from0/to0 元信息、44/45 区间、同消息双结果、Chat role=tool、pending/ambiguous、位置与身份校验、HTTP 409/400/404 区分）、`bun run typecheck` 通过（2026-10-24）。
