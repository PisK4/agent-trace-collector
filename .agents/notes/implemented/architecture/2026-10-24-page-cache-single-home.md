# Agent Note: 页面读取缓存收拢进 reader-store

Status: implemented

## Problem

页面持有 reads/toolReadings/routes 三个副本 Map，与 store 构成双份真相：每次作废都要两处同步清理，[路由读取生命周期修复](../../implemented/bug-fix/2026-10-24-reader-route-lifecycle.md)里的漏清与迟到 409 误清正是漏同步的实例；`structure.selected/open` 这类 UI 选择混在 store 的读取快照里，页面直接改写 store 对象。`selectSession`/`refreshWindow` 的 await 后没有代次守卫，旧导航的后续动作可以覆盖新选择。

## Decision

store 是唯一的读取缓存，页面删除三个副本 Map。

- 同步读取入口 `peekRequest`/`peekToolResult`/`peekRoute`：不发网络。`peekRequest` 最初以详情到手为界，详情未到手返回 null（读取中与失败不做区分）；2026-10-25 起记录存在即返回带 `status` 的快照，null 只表示本会话没有这笔记录，见[作废读取的自动重读与快照状态](../feature/2026-10-25-reader-invalidation-auto-reread.md)。`readToolResult` 登记成功值，普通失败登记 `unavailable` 占位（重试仍显式发起，迟到响应不登记）；`readRoute` 完成值随任务身份校验通过登记。`invalidate` 与会话切换同时清 Promise 缓存与完成值。
- UI 选择迁出 store：快照的 `structure` 不再有 `selected`/`open`。折叠开合统一以 folds 表为准（既有 data-fold 恢复机制），选中消息存页面的 `structureSelected` Map。`structureFoldHtml` 改收独立的 `open`/`selected` 入参，store 对象不再被页面改写。
- 作废单一入口：store 真正作废当前记录时通知页面（作废态与自动重读现都归 store，见[作废读取的自动重读与快照状态](../feature/2026-10-25-reader-invalidation-auto-reread.md)），页面无副本可清。
- 导航代次 `navEpoch`：`selectSession`/`refreshWindow` 在 `store.selectSession` 与 `resolveInitialTrace` 的 await 后检查自身代次，旧导航的后续动作静默结束。切窗续体和选择、视口的检查见[切窗收尾服从较新的阅读选择](../bug-fix/2026-10-28-window-navigation-intent-guards.md)。

[生产阅读缓存 reader-store](../../implemented/feature/2026-10-24-reader-store-cache.md) 的 4 并发、两套游标与迟到响应守卫不变；重读政策 2026-10-25 起演进为自动重读加立即重读，见[作废读取的自动重读与快照状态](../feature/2026-10-25-reader-invalidation-auto-reread.md)。本决策集中处理的是页面侧副本与 UI 字段的归属。

## Alternatives considered

**页面保留副本、双写保持同步。** 作废路径已经证明两处同步必然有遗漏。副本的同步渲染价值由 peek 入口等价提供，双份真相只留下风险。

**peek 返回半成品快照（详情未到手也返回）。** 渲染面要逐点判空，「没读到」的判断被复杂化。快照以详情到手为界，读取中与失败同走占位路径。该边界 2026-10-25 起改为「记录存在即返回带 `status` 的快照」，渲染按 status 分支而非逐字段判空，见[作废读取的自动重读与快照状态](../feature/2026-10-25-reader-invalidation-auto-reread.md)。

**`structure.selected`/`open` 留在 store 快照上。** 页面会继续改写 store 对象，读取状态与 UI 选择在作废重建时一起消失，选择无法跨重读保留。

## Consequences

reader-store 的对外形状实质变更：`RequestRead.structure` 收窄为 `{next, total, ords, loading, error}`，新增三个 peek 入口与作废通知参数（现 `onReadChanged`）。渲染语义：peek null 即「未读到」（2026-10-25 起为「没有这笔记录」，作废与失败经快照 `status` 区分），工具失败占位可见，409 后重读入口由待重读标记驱动。导航竞态在 await 边界被代次挡住。窗口准备代次归准备模块，见[中栏窗口读取的准备流水线](2026-10-27-trace-window-preparation.md)。

## Testing

- peek 语义回归：未读全 null、成功值同步可见、失败占位可见、调用不发网、invalidate 与换会话后回到未读。
- `bun test` 591 例全过（37 文件），`bun run typecheck` 通过（2026-10-24）。
