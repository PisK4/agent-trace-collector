# Agent Note: 有界阅读批与 HTTP 批端点

Status: implemented

## Problem

读取架构提案（[读取架构与多客户端演进](../../proposed/architecture/2026-11-02-read-architecture-and-client-seams.md)）Task 4：读取端只有单项端点，窗口合入要为一个请求付一次往返；正文准备（状态行、骨架解压、系统文本）在单项路径内私有，批次无法共享，也没有任何字节/时间预算约束一次批量的代价。

## Decision

- `src/reading.ts` 新增 `getReadingBatch` 与 `getReadingRangeBatch`：一次只读事务内逐项结算，返回 `BatchPage<T>`（`items` + `next_index`）。软预算 `{maxBytes: 1MiB, maxMs: 20, clock}` 只在项边界检查——单项解码不可抢占，超时计入观测而不是中断；ok 项序列化超限时重建为 `oversized`/`item_too_large`，内容丢弃但预算按原始内容字节计。所有返回路径满足 `next_index===null` 或已返回项恰好覆盖 `[0, next_index)`。
- 正文准备从 `getBodyPage` 提取为 `protocols.ts` 的 `prepareBody`/`preparedPage`/`appendMessages`（导出供批与单项共用）：批次内同一请求多区间共享一次骨架解压与消息块缓存，准备不跨调用缓存。
- 批项错误逐项单列：canonical 解析失败与跨会话 `not_found`（先解析再核对会话，不泄漏内容）、旧 token `reading_changed`、内部异常固定 `failed`/`read_failed` 不泄 SQL 或正文。重复 id 与同请求多区间各保留自己的 index，别名按旧 id 回显、内容来自 canonical。
- HTTP 批端点 `/api/sessions/:key/readings?ids=` 与 `/reading-ranges?items=`：URL 超 16 KiB 414（客户端折半重试），形状、0 项、超 32/64 项、非正 safe integer、token 格式与每片 ≤40 条整体 400 `invalid_input`；HTTP 端用固定默认预算，不接受调用者覆盖。GET/HEAD 与 Host/Origin 检查沿用现有闸门。
- 测试替身同步：`createInProcessReadTransport` 的 dispatchQuery 直调两个批函数（HTTP 与进程内 transport 对照同一实现）；合成服务器按 `detailOf`/`bodyPageOf`/`readingTokenOf` 实现同形端点与参数校验，不设预算——生产语义由 SQLite 契约测试验证，合成服务器只负责交互夹具。

## Alternatives considered

**预算放在客户端（服务器一次性算完）。** 服务器失去对单次事务代价的控制权，20ms 事件循环尖刺会随批量大小无界增长；预算必须在事务内项边界生效。否决。

**批次跨调用缓存 prepared 结果。** 阅读身份要求每次读取与当前派生输入绑定，跨调用缓存需要另设失效通路；共享只在一次批内发生，收益已够。否决。

**0 项返回空成功。** 空批几乎总是调用方构造错误，静默成功会把 bug 推到客户端「为什么什么都没显示」；显式 `invalid_input` 让错误在发起处暴露。沿用计划决定。

## Consequences

- `src/protocols.ts` 的状态行带 `conv_key`（批次核对会话需要），三项准备函数成为导出 API。
- HTTP 批端点的 `invalid_input` 对应客户端 `batch_too_large` 折半与单项重试的接线在 Task 5 落地；414 的客户端映射同批接入。
