# Agent Note: 容量三门槛与正文回收

Status: implemented

## Problem

正文按请求增长。10 GB 的正文预算挡不住整个库。`request`、`request_evidence`、`route_summary` 长期保留，按每笔约 2 KB 的读数字段加索引，4000 笔一天一年约 2.9 GB；请求量翻十倍时，单靠元数据就会超过 16 GB 的硬上限。容量到线时如果只是抛错或静默丢数据，既丢证据，也没有可恢复的缺口记录。

## Decision

正文预算默认 10 GB，总磁盘上限默认 16 GB，都可用 `ATC_BODY_BUDGET`、`ATC_DISK_LIMIT` 覆盖。三道门槛都带滞回，模式变化才写 `collector_state`，重启后接着上次的模式算：

| 触发 | 效果 | 恢复条件 |
|---|---|---|
| 正文占用 ≥ 预算 | 回收最旧正文到 90% 预算 | 回到 90% 以下 |
| 总盘 ≥ 80% | 只接元数据：证据、关联、raw 元数据照写，正文标 `partial` / `disk_body_paused` | 跌回 75% 以下 |
| 总盘 ≥ 95% | hook 一律 507，什么都不写 | 跌回 90% 以下 |
| 剩余空间 < `max(256 MiB, 2 × 本批上界)` | 暂停 | 余量回到门槛以上 |

回收按 `day`、`started_ms`、`req_id` 从旧到新，单批最多 100 笔、10,000 条块引用；删引用、删孤儿块、清骨架、改状态在同一个事务里，`have` 与历史读数不动，`body_prev_state` 保留原状态。共享块只在最后一个引用消失时删除。每批后执行 `incremental_vacuum(256)`，再执行 `wal_checkpoint(TRUNCATE)`；不做在线全库 `VACUUM`。

账本暂停时 `committed_off` 不动、只推进 `observed_off`。同一来源代际的连续区间合并成一条 `source_gap`，补齐后标 `filled`；文件换代补不回来的标 `unrecoverable` 并一直可见。raw 层保留 7 天，先给对应证据标 `payload_state=expired` 再删原文；仍带正文又没完成关联的 hook 原文不按到期删，只在 `ingest_issue` 记 `raw_hook_body_unlinked`。

常量见 [src/retention.ts](../../../../src/retention.ts)，默认值见 [src/config.ts](../../../../src/config.ts)，完整策略见[架构设计的容量与保留](../../../../docs/architecture-design.md#容量与保留)。

## Alternatives considered

**只设一个正文预算，到线就停止写入。** 正文停了元数据照涨，16 GB 硬上限仍然会被突破；停止写入还会丢掉本可以保存的证据行。

**只按天淘汰最旧的请求行。** 删 `request` 行会让历史读数、会话导航与标题一起消失，和「元数据保留全部历史」的初衷冲突。合成验证里执行这条删除后，请求行数归零。

**到线时做一次全库 `VACUUM`。** 全库 `VACUUM` 需要独占且长时间持有锁，采集器在线时不可行；改成按批删除后 `incremental_vacuum` 加 `wal_checkpoint(TRUNCATE)`，文件也能收缩。

**第一版就做超大块降级与 zstd 字典训练。** 超大块降级只存哈希、前 4 KB 预览与原始大小，字典训练另带一套版本管理流程；两者都留接口，第一版只做分级保留。

## Consequences

- 正文按预算滚动，元数据保留全部历史；代价是元数据本身仍会增长，16 GB 是否够用要在上线后单独统计 `request` 行字节。
- 三道门槛都有滞回，模式不会在水位附近抖动；代价是恢复比触发晚，短暂回落后仍可能停留一档。
- 回收只动正文，`request`、`route_summary`、`request_evidence` 不删；正文被回收的请求仍能被导航与读数，只是读不到正文。
- 账本暂停留下 `source_gap`，补齐后标 `filled`；文件换代导致补不回来的缺口标 `unrecoverable` 并一直可见。
- 批量回收与 checkpoint 会增加写延迟；每批上限与回收到 90% 的目标共同限制单次停顿。
- 95% 档的 507 让 hook 明确失败，采集器不写半份数据；恢复要等磁盘回落到 90% 以下。
