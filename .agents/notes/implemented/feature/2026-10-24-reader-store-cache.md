# Agent Note: 生产阅读缓存 reader-store

Status: implemented

## Problem

生产页面的读取协调散在 DOM 闭包里：详情缓存永不失效，正文按请求只有一个 inflight，异步响应没有会话代次守卫。这无法支撑带阅读版本的窗口阅读，也难以注入网络做行为测试。

## Decision

新增 `web/reader-store.js`：无 DOM、无持久状态的读取协调层，页面只消费它。网络走共享的固定 4 并发队列，失败也在 finally 里释放。页面缓存按 canonical `req_id` 归属，由 `reading_token` 标识版本，区间 inflight 键为 `[id, token, from, to]`，工具结果键为 `[owner, token, ord]`。结构（连续历史上界）与增量（已消费可信 delta 计数）是两套游标，不能共用。定点读不推进结构上界，结构成功才推进 `next = min(to, total)`；空页且未到起点时报出 `body_page_empty`，游标不动。delta 每片跨度小于 40，每轮最多两片，并且可以重复地显式消费。每片返回后校验所需 ord 都实际拿到，有缺口就抛 `delta_gap`，不推进消费位置，坏页不留在区间缓存；`delta_ordinals` 为 null 时不读消息，标记未确认。409 时整笔作废——详情、元信息、消息、区间、结构、增量、工具与路由一起清，且只在失败读取仍是当前记录的当前版本时执行；2026-10-25 起作废改为记录原地重置并按冷却自动重读，作废态经快照 `status` 可查，见[作废读取的自动重读与快照状态](2026-10-25-reader-invalidation-auto-reread.md)。迟到响应必须同时匹配会话代次、`reads` 记录归属与捕获 token 才可写入，任一不符抛 `reading_changed`；作废记录自 2026-10-25 起以带作废态的快照返回（同篇）。validate 读取发现 token 变化时原地重置整笔快照（含元信息），并等在跑的详情读取结束后再拉一次详情；普通详情读取合并进在跑请求。切换会话时递增代次并释放旧正文缓存。工具结果不自动读取，detail 里 `resolved` 不等于已读。路由只在显式读取时发起，随同一记录作废。路由任务带身份校验，成功与失败路径都核对捕获的任务仍是当前缓存条目；被取代的旧任务抛 `reading_changed`，不误删新缓存。真正作废当前记录时（当前版本 409、token 变化重置、详情迟到拒绝）通过 `createReaderStore` 的可选回调通知页面（`onInvalidated(id)`，2026-10-25 起扩义更名 `onReadChanged`）；迟到响应与会话切换后的旧任务不作废，也不通知，页面不按错误自行清理，见[路由读取生命周期与作废通知](../../implemented/bug-fix/2026-10-24-reader-route-lifecycle.md)。切换会话后清空读取缓存，只保留当前窗口与显式选中的窗口外请求。

[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)统一了版本失效、409 作废与增量续读的实现；两套游标、4 并发和显式重读的决定继续有效。

## Alternatives considered

**沿用 DOM 闭包里的缓存。** 无法注入网络测试，迟到响应守卫也没有统一位置；缓存所有权必须先移出 DOM。

**409 后自动重读。** 会掩盖「请求已变化」这个事实；该立场维持到 2026-10-25，被带「已更新」留痕与冷却限频的自动重读部分取代，见[作废读取的自动重读与快照状态](2026-10-25-reader-invalidation-auto-reread.md)。

**结构与增量共用游标。** 定点读取会把稀疏缓存误当成连续历史；两套游标分别表达「连续读到哪」和「可信增量消费到哪」。

## Consequences

页面接入只消费 store 的返回形状（`RequestRead` 的 status/detail/meta/messages/structure/delta 与 JSDoc typedef）。页面侧的失效展示由回调通知驱动（现 `onReadChanged`），作废态与自动重读见[作废读取的自动重读与快照状态](2026-10-25-reader-invalidation-auto-reread.md)。页面已无副本缓存，同步渲染经 `peekRequest`/`peekToolResult`/`peekRoute` 消费，UI 选择不进 store，见[页面读取缓存收拢进 reader-store](../../implemented/architecture/2026-10-24-page-cache-single-home.md)。验证：`bun test tests/reader-store.test.ts tests/web.test.ts` 全过（fetch 序列与元信息、并发去重与精确 URL、结构 40+5 与定点读不推进、503 与空页保留旧态、409 作废后普通读取重建、token 变化重取元信息、迟到 409 不清新缓存、invalidate 后旧详情拒绝、validate 串行重拉、迟到详情不写入新会话、工具按 owner+ord 缓存与失败重试、resolved 不自动读、81 条增量两片后显式续读、增量缺口不推进位置且重试走网络、delta 分片与未确认、并发 ≤ 4、同会话作废后迟到路由成功不可用、迟到路由失败不清新缓存、409 只在真正作废时通知、peek 同步读取入口、失效说明重读入口、静态模块白名单），`bun run typecheck` 通过（2026-10-24）。
