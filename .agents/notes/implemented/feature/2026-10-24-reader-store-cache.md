# Agent Note: 生产阅读缓存 reader-store

Status: implemented

## Problem

生产页面的读取协调散在 DOM 闭包里：详情缓存永不失效、正文按请求单一 inflight、异步响应没有会话代次守卫，无法支撑带阅读版本的窗口阅读，也难以注入网络做行为测试。

## Decision

新增 `web/reader-store.js`：无 DOM、无持久状态的读取协调层，页面只消费它。网络走共享的固定 4 并发队列，失败在 finally 释放；页面缓存按 canonical `req_id` 归属、`reading_token` 标识版本，区间 inflight 键为 `[id, token, from, to]`，工具结果键为 `[owner, token, ord]`。结构（连续历史上界）与增量（已消费可信 delta 计数）是两套游标，不能共用；定点读不推进结构上界，结构成功才推进 `next = min(to, total)`，空页且未到起点时报 `body_page_empty` 且游标不动。delta 每片跨度小于 40、每轮最多两片，`delta_ordinals` 为 null 时不读消息、标记未确认。409 整笔作废（清记录、由下一次显式读取重建），不自动重试；迟到响应必须同时匹配会话代次与当前 token 才可写入，切换会话递增代次并释放旧正文缓存。工具结果不自动读取——detail 里 `resolved` 不等于已读；路由只在显式读取时发起。切换会话后清空读取缓存，只保留当前窗口与显式选中的窗口外请求。

## Alternatives considered

**沿用 DOM 闭包里的缓存。** 无法注入网络测试，迟到响应守卫也没有统一位置；缓存所有权必须先移出 DOM。

**409 后自动重读。** 会掩盖「请求已变化」这个事实；正确行为是作废后由用户显式重读，界面展示变化并提供按钮。

**结构与增量共用游标。** 定点读取会把稀疏缓存误当成连续历史；两套游标分别表达「连续读到哪」和「可信增量消费到哪」。

## Consequences

Task 6 的页面接入只需消费 store 的返回形状（`RequestRead` 的 detail/meta/messages/structure/delta 与 JSDoc typedef）。验证：`bun test tests/reader-store.test.ts tests/http.test.ts` 全过（fetch 序列与元信息、并发去重与精确 URL、结构 40+5 与定点读不推进、503 与空页保留旧态、409 作废重建、迟到详情不写入新会话、工具按 owner+ord 缓存与失败重试、resolved 不自动读、delta 分片与未确认、并发 ≤ 4、静态模块白名单），`bun run typecheck` 通过（2026-10-24）。
