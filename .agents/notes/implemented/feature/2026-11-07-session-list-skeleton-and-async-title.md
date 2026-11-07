# Agent Note: 会话列表骨架先出与标题异步回填（Tracery）

Status: implemented

## Problem

用户首次打开 Tracery 时，左栏会话列表与中栏请求区长时间停留在「正在读取本机会话…」「正在读取请求…」黑屏等待，要等几秒才刷新出列表。中间不是网络慢，而是服务端 `/api/sessions` 的阶段二标题子查询把首屏堵住了：阶段二对页内 20 个会话各算一次包含跨组绑定的标题表达式，成本随会话数线性，叠加后台任务的事件循环尖刺，首屏就是数秒。

## Decision

首屏拆成两步：先用轻量模式拉列表，标题随后回填。

- `listSessions` 新增 `title: 'full' | 'light'`，默认为 `full`；`light` 时标题子查询不出列，行里标题保持空。
- 新增 `getSessionTitles(keys)` 单取各会话标题，`sessionsTitle` 具名操作供 `/api/sessions/titles` 直接取一批。
- 前端 `loadSessions` 默认走 `title: 'light'`，列表先落地，`onSessionsChanged` 立即渲染；标题在列表后单独请求，成功逐项覆盖并二次渲染，失败不阻断列表。
- 左栏首屏接入骨架条占位（`.sess-skeleton`），数据到达前是占位条而不是空白；主栏等待仍按原文字显示。
- 标题失败静默保留空标题；用户仍可点进会话，不阻断主流程。

## Alternatives considered

- **删除或削弱跨组标题。** 跨组标题仍是主会话命名的重要依据，删掉会改产品行为；这次只拆首屏路径。
- **事件循环预算化治本。** 后台任务的事件循环阻塞仍是长尾来源；本次先解决首屏 UX，预算化另行跟进。

## Consequences

- 首屏时间从数秒降到候选与计数查询的线性时间（20 个会话、覆盖索引、无标题子查询）。
- 标题回填是一次真实网络往返；标题到手前用户看到空标题占位，标题二次渲染可能导致一次轻微重排。
- `/api/sessions` 的默认 `'full'` 保持旧契约不变；`title=light` 是新参数，旧调用方不受影响。
- 验证：`bun test` 155 pass（`tests/reader-store.test.ts`、`tests/read-http.test.ts`、`tests/read-contract.test.ts`、`tests/queries.test.ts`、`tests/http.test.ts`），`bun run typecheck` 通过。生产走查待部署后做真实流量验收。
