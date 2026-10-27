# Agent Note: loadEarlier 按服务端分页上限收窄请求页大小

Status: implemented

## Problem

窗口的「加载更早记录」按当前行数翻倍请求：30 → 60 → 120 → 240。窗口读取端点有服务端上限（`queries.checkLimit(limit, 200)`），翻倍越过 200 后，每一次点击都会以 `invalid_limit` 400 被拒绝，窗口停在 400 行以内，且没有任何提示能解释为什么历史加载不动。错误文本只会进会话头的读取失败说明。这发生在[中栏间距修正](../../simplification/2026-10-24-reader-layout-and-entry-fixes.md)的浏览器验收里：会话 B 有 1024 笔请求，窗口加载到 240 行后卡住，千位序号的验收路径被这个既有缺陷挡住。

## Decision

`web/reader-store.js` 的窗口扩展函数（原名 `loadEarlier`，[窗口锚点调转](../feature/2026-10-28-start-anchored-trace-window.md)后为 `loadLater`，方向由 `older` 换为 `forward`）把请求页大小 clamp 到 200：`Math.min(windowRows.length || 30, 200)`。翻倍照常进行，到顶后每次点击按上限继续加载，直到 `next_cursor` 为 null。初始窗口大小不受影响（`windowLimit()` 上限 100，低于服务端上限）。

## Alternatives considered

**放宽服务端上限。** 上限是窗口读取的批量边界，为前端翻倍策略放宽等于让客户端策略决定服务端预算。保持服务端不变、客户端遵守契约更合理。

**翻倍封顶后降回固定页大小。** 效果一样，但引入第二套数字。clamp 到服务端上限就能最大化每次点击的加载量，无需第二个常量。

## Consequences

长会话可以一直加载到会话起点，不再在 200 行之后静默卡住；每次点击加载的行数在 200 以内。代价是达到上限后每次点击仍是 200 行，不再翻倍。这是服务端契约决定的，不是新的损失。
