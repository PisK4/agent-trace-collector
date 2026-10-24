# Agent Note: hook 写事务具名与 raw 层死导出清理

Status: implemented

## Problem

hook 的主写事务（建行、raw、证据、pending、投影）没有名字，`writeStats` 把它计入 `other`，capacity 快照看不出 hook 通道的写占用。`src/sources/raw.ts` 里 `writePreparedLedgerTx` 与 `writePreparedRouteTx` 是零调用的死导出：列清单接口没有写入方，保留只会让读者误以为存在第二条账本/路由写入路径。`LEDGER_COLUMNS` 与 `ledgerColumns` 两份清单各自重排时参数个数仍然对得上，列序错位静默落错列且没有测试能发现。

## Decision

`acceptHook` 的 `store.write` 具名 `'hook'`；`by_name.hook` 从此出现在 capacity 快照里，其余写入路径名称不变。删除两个零调用函数；`upsertPreparedRouteTx` 仍被 `reconcile.ts` 生产调用，保留。新增 `tests/raw.test.ts`：按 schema 具名列回读唯一哨兵值，`LEDGER_COLUMNS` 与 `ledgerColumns` 任一侧重排都会在按名对齐处失败；schema 列集合与契约表不一致同样失败。

hook 事务的原子性与入口不动，[来源摄入单元](../../implemented/architecture/2026-10-24-source-ingest-unit.md)维持 hook 与 `ingestSource` 分立；[来源投影与字段保真](../../implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md) 点名的 raw 层函数清单同步收窄。

## Alternatives considered

**把 hook 写入并入 `ingestSource` 统一具名。** `ingestSource` 接收带文件坐标的 decoded 读取，hook 使用 hook_id、匹配与暂存语义，三路合并没有共同输入；合并方案已被来源摄入单元 note 否决。

**保留 `writePrepared*Tx` 备将来迁移用。** 迁移批次真要用时再加，死导出不会让将来的实现更省事，只会掩盖「只有一条写入路径」的现状。

## Consequences

capacity 快照的 `writer.by_name.hook` 可观察（count/total_ms/max_ms），准入拒绝的事务同样计入。raw 层对外的写入口收窄为 `insertPreparedLedgerTx` 与 `upsertPreparedRouteTx` 两个；列序契约有按名测试兜底，重排不再静默。

## Testing

- `bun test tests/hook.test.ts tests/raw.test.ts tests/commit-unit.test.ts` 全过，含新增的 `by_name.hook` 归属断言与列序哨兵测试；`bun run typecheck` 通过（2026-10-24）。
- 准入拒绝（paused）时零写入的既有断言继续覆盖具名事务。
