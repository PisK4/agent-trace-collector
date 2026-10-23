# Agent Note: 最近请求窗口与向前分页

Status: implemented

## Problem

列表分页只有 forward：从最早页向后追加，生产阅读需要默认打开最近窗口并向更早方向翻页。已有会话时间索引 (conv_key, started_ms DESC, req_id DESC) 本可反向扫描，但接口没有方向参数。

## Decision

`listRequests` 增加 `direction` 参数，默认 `forward` 保持旧行为。`older` 无游标取最近一页，之后向更早翻；两方向的返回 items 都按 (started_ms, req_id) 升序，older 内部先 DESC 取页再反转。older 游标编码四元组 `[tag, conv_key, started_ms, req_id]`，解码时校验方向标记与会话一致，forward 旧二元游标不能混用；未知 direction 在查询层抛 `invalid_direction`、HTTP 层返回 400，不静默忽略。比较符与排序只在两个固定分支间选择，值仍全部参数化。

## Alternatives considered

**offset 分页或按 req_id 单列翻页。** 摄入持续写入，offset 会漂移；同毫秒多笔时单列 req_id 在不同 started_ms 之间不构成全序，必须保持二元组 keyset。

**正序扫描再取尾部。** 取最近窗口要扫全表尾部，DESC 反向走 `i_req_session_time` 不需要新索引，EXPLAIN 断言沿用该索引且无 TEMP B-TREE。

## Consequences

生产阅读界面可以用 `direction=older` 建立最近窗口，顶部「加载更早」拿 `next_cursor` 继续翻，正序渲染逻辑不变。验证：`bun test tests/queries.test.ts tests/http.test.ts` 全过（同毫秒 7 笔三页不漏不重、游标混用/越界/跨会话/非安全整数均 400）、`bun run typecheck` 通过（2026-10-24）。
