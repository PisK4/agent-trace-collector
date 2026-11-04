# Agent Note: Zcode 不落会话原始层

Status: implemented

## Problem

Zcode 适配器首轮生产回填后，`raw_session_event` 里 `zcode_session` 的 5,516 行占了 1.59 GB，平均每条 288 KB，而同一批调用的正文块合计只有约 1.4 GB。数据库在十几分钟内从 5.8 GB 涨到 6.7 GB。

原因是 Zcode 的“原始行”不是来源自己的行，而是适配器重建的完整 `SessionCall`：每次调用都带截至当时的整段 `requestMessages`。共用摄入把它脱敏、序列化后写入原始层，正文层又按块存了一份。Zcode 的 `replaysState` 本来就是 false——解析状态不依赖原始层；这张表对它是只写不读，纯属重复存储。回填 342 个会话会把这条浪费放大到数 GB。

## Decision

`SessionAdapter` 增加可选 `storesRaw`，默认 true；Zcode 设为 false。

- 不落原始层的来源跳过 `sanitizedPayload` 的脱敏后重序列化与二次解析，直接用内存里的解析结果走 `apply`；正文仍由 `persistBodyTx` 脱敏后入库，落盘内容不变。
- 原始层的读写（重放查询、同位置 payload 比对、插入）只在 `storesRaw !== false` 时执行。
- 其他四家 JSONL 适配器保持落原始层：追加文件需要按代际重放恢复消息窗口，且原始行是来源自己的小行。
- 生产存量 `zcode_session` 原始行一次性删除；删除后 `VACUUM` 回收页面。这些行没有读者，也不参与重放。

## Alternatives considered

**把 Zcode 的原始行改成紧凑形状（只存 `model_usage` 的 rowid 与消息 id）。** 需要给 ingest 增加“原始层与正文来源分离”的第二种契约：解析用的 payload 与落盘的 payload 不再是同一份文本。为省一张本来就不需要写的表引入两套语义，不划算。

**保留原始层，等 rawPrune 覆盖 `raw_session_event` 再回收。** 当前 `raw_session_event` 是 JSONL 适配器重放的唯一来源，整表不参与回收；为一个只写不读的来源扩展回收规则，回收点反而更复杂。

**降低 Zcode 单轮文件数来压数据库增长。** 只减慢增长速度，单条 288 KB 的重复仍在；空间问题应从不写源头解决。

## Consequences

- 新 Zcode 摄入不再产生 `raw_session_event` 行，单条调用的原始层开销从约 288 KB 降到 0；正文与证据不变。
- Zcode 的 `read()` 每秒少做一次大对象脱敏与 JSON 往返，首轮回填的 CPU 下降。
- 失去 Zcode 原始层的审计副本；本地 `db.sqlite` 仍在，物化行可重读，`request` 证据键仍可回溯到 `session_id/message_id`。
- 生产已落库的 `zcode_session` 原始行删除后不可恢复；它们没有读者，删除不影响正文、证据与游标。

## Testing

- `tests/session-zcode.test.ts` 断言一次 Zcode 摄入后 `raw_session_event` 为 0 行，正文、证据与游标照旧。
- 其余会话适配器测试确认 JSONL 来源仍写原始层；`bun test` 全量通过。
- 生产验收：删除存量 Zcode 原始行后 `VACUUM`，确认库大小回落、后续 Zcode 轮转不再新增该来源的原始行。
