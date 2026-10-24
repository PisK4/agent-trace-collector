# Agent Note: 路由读取生命周期与作废通知

Status: implemented

## Problem

路由读取有三处生命周期缺口。页面 `refreshWindow` 与 `selectSession` 清 reads/toolReadings 但不清 routes 副本，导航完成处的自动读取命中旧窗口缓存，刷新或切走再回来后路由不再发请求。store 的 `readRoute` 只校验会话代次：同一会话作废后，旧成功响应仍作为可用值返回给调用方；旧任务的失败 catch 无条件 `routes.delete(id)`，会删掉已重建的新缓存。此外正文与工具路径的过期响应与当前版本 409 都抛 `reading_changed`，页面按 id 全清，把 store 已保住的新数据一并作废。`ensureMessageOrd` 这类静默路径的整笔作废更是无人接收。

## Decision

`readRoute` 给路由任务加身份校验：成功与失败路径都核对捕获的任务仍是当前缓存条目（与 `routes.get(id)` 比对），被取代的旧任务抛 `reading_changed`，失败 catch 只在仍是当前条目时删键。

`createReaderStore` 增加可选 `onInvalidated(id)` 通知，只在真正作废当前记录时触发：`invalidateIfCurrent` 判定通过、token 变化原地重置、详情迟到拒绝时当前记录被删。迟到响应与会话切换后的旧任务不作废、不通知。页面把回调接到 `handleReadingChanged`，各 catch 点不再按 `reading_changed` 自行清副本；`refreshWindow` 与 `selectSession` 补清 routes 副本。

[生产阅读缓存 reader-store](../../implemented/feature/2026-10-24-reader-store-cache.md) 的 4 并发、两套游标与显式重读决定不变；[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md) 的「清副本加显式重读入口」仍成立，只是清副本改由 store 通知驱动。

## Alternatives considered

**页面在每个 catch 继续自行清理。** `reading_changed` 不区分迟到与真作废，页面无法判断 store 是否已重建新数据，只能按 id 全清，误伤新缓存。

**给路由接口携带 reading token，按正文模式校验。** 路由接口不携带 token；任务身份校验已覆盖本批竞态，与正文共享服务端版本一致性另行决定，不在本修复承诺。

## Consequences

同会话作废后的旧路由响应不再可用，旧失败不再删新缓存；迟到 409 不再清页面副本，真作废经通知统一清理。token 变化的 validate 重建计作一次作废通知，页面的工具结果与路由副本随之失效。路由任务身份守卫放在 store 内，有测试覆盖。页面副本随后已整体删除（见[页面读取缓存收拢进 reader-store](../../implemented/architecture/2026-10-24-page-cache-single-home.md)），路由展示改经 `peekRoute` 消费。

## Testing

- 三个回归先在旧实现失败再随修复通过：同会话作废后迟到的路由成功响应不可用、迟到的路由失败不清除已重建的新缓存、409 只在真正作废当前记录时通知（token 变化通知一次，迟到 409 不新增）。
- `bun test tests/reader-store.test.ts tests/web.test.ts` 43 例全过，`bun run typecheck` 通过（2026-10-24）。
