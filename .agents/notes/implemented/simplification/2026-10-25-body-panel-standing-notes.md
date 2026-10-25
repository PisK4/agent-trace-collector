# Agent Note: 正文面板常挂说明清理与死代码移除

Status: implemented

## Problem

右栏正文详情面板在每条消息、System 详情与回复详情尾部挂着常驻说明：「内容按脱敏后的原文保存；未知块以转义 JSON 展示，不做语义推测」「System 是请求顶层字段，不属于 messages……这里转义展示」「回复与请求上下文分开保存……」，bp-meta 里还有「按协议字段顺序展示」这类描述渲染方式的字样。它们要么与面板头的协议路径同义（`request.system`、`messages[N]`），要么描述 UI 自身，每次阅读都要再扫一遍；未知块的口径在未知块专属详情里已有归属。回复无法结构化的提示还引用已不存在的「原始脱敏对象」分区。`web/app.js` 的 `completenessRows` 无任何调用。

## Decision

- `renderMessageDetail`：bp-meta 只留 role 与内容块数；尾部说明删除——未知块的「转义 JSON、不做语义推测」口径由 `renderUnknownBlockDetail` 自己说明。
- `renderSystemDetail`：尾部说明删除；`request.system` 路径已表达「请求顶层字段」。
- `renderReplyDetail`：只留「工具结果不在本回复里，按 call id 指向后续请求的消息」——它解释一个真正不直观的缺失；「回复与请求上下文分开保存」是存储细节。
- 回复无法结构化的提示去掉「可在『原始脱敏对象』里查看」：UI 没有这个分区（`renderRaw` 只剩测试在用）。
- 删除无调用的 `completenessRows`。

## Alternatives considered

**把「内容按脱敏后的原文保存」上移为页面级说明。** 脱敏是写入口径，[架构设计](../../../../../docs/architecture-design.md)是它的家，界面按面板逐条复述只会失修。
**同步删除 `renderRaw`。** 它仍被测试断言使用；本轮只清理用户可见的失效引用，函数本身不动。该缓期在[清仓](2026-10-25-cleanup-dead-exits-and-single-homes.md)兑现：连同测试一并删除。
**保留「回复与请求上下文分开保存」。** 读者要回答的是「结果正文为什么不在回复里」，保留的后半句已完整回答。

## Consequences

正文面板从面板头直达内容，每条消息少一段常驻文字。已知代价：脱敏口径不再在面板内出现，以架构文档为权威。验证（2026-10-25）：`bun test tests/body-view.test.ts tests/web.test.ts`、`bun run typecheck` 通过。
