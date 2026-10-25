# Agent Note: 作废读取的自动重读与快照状态

Status: implemented

## Problem

「已作废、待显式重读」这个状态有两个家：reader-store 负责检测（会话代次、记录归属、token 三查）并整笔删除记录，页面用 `readingChanged` 集合靠回调记住，11 个协作点跨两个模块同步，作废原因在删除后无处可查。批量补读 `loadWindowReads` 按「`peekRequest` 为 null」圈名单，作废记录删完后正好落进这个条件，「加载更早」会顺带重建它们——显式重读政策被静默绕过（[中栏读取缺口如实区分](../bug-fix/2026-10-25-reading-gap-honest-row.md)修过塌行文案的那一半，另一半就是这个洞）。活跃会话里派生一重新发布，整组请求的 reading token 一起换，成串塌行都要手点。

## Decision

作废态归 reader-store 单一家。作废从「删除记录」改为「记录原地重置」：正文缓存清空，快照 `status` 落为 `invalidated`（`reading | fresh | invalidated | failed` 四值，只描述 detail/meta/token 层，结构、增量与逐工具的局部失败态保持独立），记录修订 `rev` 自增，迟到的详情响应凭它不得写入已重置的记录。

作废即自动重读：同一笔按冷却窗口限频（默认 10 秒，`createReaderStore` 第三参 `autoRereadCooldownMs` 可注入），不设尝试上限，会话切换或记录被取代、重建时放弃；深度与手动重读一致（详情 + 元信息，再补最多两片可信增量）。自动换新后置 `updatedSinceSeen`，中栏组头出现「已更新」标记，点进组里经 `clearUpdated` 清除；手动「立即重读」随时可用且不置标记。

读取接口收成单出口：`peekRequest` 记录存在即返回带 `status`/`detailError`/`updatedSinceSeen` 的快照，null 只表示本会话没有这笔记录；`peekDetailError` 退役。页面 `readingChanged` 集合、`readGapOf` 与 projectSteps 的 `ReadGap` 参数一并退役，缺口行文案由快照 status 推导（「阅读版本已变化 · 自动重读中，点击立即重读」）。批量补读只圈「无记录或 failed」，作废项归自动重读管，两条路不重复。作废与自动重读的页面重绘由 `onReadChanged`（原 `onInvalidated` 扩义：作废、自动重读各阶段完成都通知）驱动。`invalidate` 公共入口保留为原地重置，不通知、不排自动重读，供测试与强制失效。projectSteps 仍只收纯数据，不访问 store。

## Alternatives considered

**保持显式重读、页面集合修补批量洞。** 集合再多一处 `has()` 检查只是把两个家的同步面加宽；活跃会话的成串塌行仍要逐笔手点。

**作废后保留旧快照渲染到重读完成。** 需要让 store 返回带过期标记的旧正文，「作废记录不作为可用快照返回」的契约整体翻转，旧版本证据与新派生并排展示对忠实阅读器是误导；[读取缺口 note](../bug-fix/2026-10-25-reading-gap-honest-row.md)否决它的理由仍然成立。

**全自动重读不留痕。** 吞掉「请求已变化」的事实，正是[生产阅读缓存 reader-store](2026-10-24-reader-store-cache.md)当初否决自动重读的理由。自动重读换新后以组级「已更新」标记留痕，点进组里即清除——事实可见，只是不再要求手点。

## Consequences

作废原因可查、状态单家、批量补读与自动重读分工清晰；「加载更早」不再静默重建作废记录。代价：reader-store 引入定时器与冷却参数；自动重读与用户点击合并进同一 inflight 时也会置「已更新」标记（可接受的宽松）；缺口行的「点击重读」文案变为「自动重读中，点击立即重读」。

部分取代[生产阅读缓存 reader-store](2026-10-24-reader-store-cache.md)的「409 后自动重读」否决项与「作废记录不作为可用快照返回」「peekRequest 无快照返回 null」边界，该记录保持活跃并交叉链接本篇；[中栏读取缺口如实区分](../bug-fix/2026-10-25-reading-gap-honest-row.md)的三态文案机制由 `ReadGap` 参数改为快照 status 推导、`peekDetailError` 退役，其「不自动重读」引用同样被本篇部分取代；[路由读取生命周期与作废通知](../bug-fix/2026-10-24-reader-route-lifecycle.md)的 `onInvalidated` 更名扩义为 `onReadChanged`；[页面读取缓存收拢进 reader-store](../architecture/2026-10-24-page-cache-single-home.md)的 peekRequest 边界描述随之更新。

## Testing

`bun test tests/reader-store.test.ts tests/trace-view.test.ts tests/web.test.ts tests/reader-types.ts` 全过：作废即自动重读（换新置标记、冷却内不重复发起、到期再发起）、peek 四态（无记录 null / fresh / failed 带原因 / invalidated 记录保留）、迟到 409 与迟到详情不回标不写入（rev 守卫）、既有 409/token 变化/路由生命周期/并发上限套件全部保留通过。app.js 的批量补读过滤与「已更新」标记的清除是 DOM 接线，无注入式测试面，按仓库惯例由合成生产环境验收覆盖。`bun run typecheck` 通过（2026-10-25）。
