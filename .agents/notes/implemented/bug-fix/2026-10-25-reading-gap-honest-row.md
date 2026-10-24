# Agent Note: 中栏读取缺口行如实区分作废与失败，重读恢复原行组成

Status: implemented

## Problem

活跃会话里派生持续发布新代。阅读身份包含 derive 组的发布代与派生结果列，一次发布就会让同组所有请求的 `reading_token` 同时变化（真实库实测 3 秒内可见变化）。此后凡是带 `if_reading` 的读取——工具结果、结构、增量、定点补读——服务器一律返回 409，reader-store 收到后会把这笔请求的缓存整笔作废。中栏随即把这一组收成一条「读取中」记录行。实际上这时没有任何读取在进行，这个文案与事实不符；组里也没有重读入口，除非用户碰巧再次点开这一组。塌行后点击会走普通读取，重建详情与元信息，但增量游标已归零且无人消费，组以缺行状态重新展开。可信 delta 的输入与结果行消失，换成「还有 N 条新增未读取」。读者看到的是「点一下 Message 整个画面变掉、行数变错」，而右栏只在选中的请求上给出作废说明与重读按钮。

## Decision

`projectSteps` 增加可选 `readGap` 参数，read 为 null 时由装配层区分三种态，如实显示对应文案：`readingChanged` 里已登记的 id 显示「阅读版本已变化 · 点击重读」；详情读取失败经 reader-store 新增的 `peekDetailError` 同步读取（「详情读取失败 · <原因>」）；其余仍显示「读取中」。三种态共用 `req:loading` 步骤键，点击行都走普通读取重建。409 整笔作废与「不自动重读」的决定继续有效，见[生产阅读缓存 reader-store](../feature/2026-10-24-reader-store-cache.md)。本修复补齐的是它的另一半——作废态在中栏可见、可一键重读，而不是冒充读取中。

`ensureRead` 在详情到手后按初始装载深度补最多两片可信增量（与 `loadWindowReads` 的每笔预算一致），重读一次点击就能恢复塌行前的行组成；超出两片仍走显式续读，见[阅读角色、步骤定位与缓存一致性](2026-10-24-reader-role-and-selection-consistency.md)。

## Alternatives considered

**作废后保留旧快照渲染到重读完成。** 需要在页面侧重新引入副本缓存，与「页面读取缓存收拢进 reader-store」的决定相反；作废记录不作为可用快照返回仍是 reader-store 的契约。

**409 后自动重读。** 已被 reader-store-cache note 否决：会掩盖「请求已变化」这一事实。

## Consequences

作废与失败的组在中栏各有一行如实文案，点击行即重建；代价是活跃会话里的塌行仍会出现（派生发布不受阅读端控制），只是从「永久卡在读取中」变成「可见、可一键恢复」。`peekDetailError` 是 store 的新同步入口，只暴露 `detailError`，不改变 `peekRequest` 无快照返回 null 的契约。

## Testing

- `bun test tests/trace-view.test.ts tests/reader-store.test.ts` 全过（作废/失败/读取中三种文案与共享 `req:loading` 键；peekDetailError 失败可见、重读成功清空），`bun run typecheck` 通过（2026-10-25）。
- 真实库浏览器验收（launchd 生产页）：修复前实测一次真实 409——工具结果读取带着页面装载时的旧 token 被拒，组当场塌成「读取中」；修复后对一次工具结果读取注入与服务器同格式的 409 复现塌行，塌行显示「阅读版本已变化 · 点击重读」，点击一行恢复原行组成，不再出现「还有 N 条新增未读取」的中间态。
