# Agent Note: main.ts 的定时任务体归位到各自 module

Status: implemented

## Problem

`main.ts` 是 composition root，但它的三个定时任务体里住着摄入与保留的实现：`routeTick` 内联了第二份 `ingest_issue` upsert（冲突子句与 `reconcile.ts` 的 `recordIssue` 不同，还不记 `byte_length`）和第二份路由游标 upsert；`ledgerTick` 内联了 `observed_off` 推进；`retentionTick` 内联了触顶判定与二十批回收循环；本地 `readCursor` 与 `sources/files.ts` 各持一份游标形状的理解，函数体里还有一段解析了却不用的死代码。五个任务没有单元测试，改一条行格式规则要同时动 `files.ts`、`reconcile.ts`、`main.ts` 三处。

## Decision

任务体下放到拥有对应概念的 module，`main.ts` 只留 wiring（timer、防重入锁、配置装配、进程日志）：

- `reconcile.ts` 新增 `readFileCursor`（游标读取，死代码删除）、`observeSourceOffset`（只推进观察位）、`committedRouteFingerprints`（已提交指纹）、`ingestDecodedRouteFile`（一个已解码路由文件的完整落库：坏行按 `recordIssue` 记账、`ingestRoute`、推进指纹游标）；
- `retention.ts` 新增 `enforceBodyBudget`（触顶判定、按批回收、收缩文件、失效准入缓存），返回回收请求数；
- `routeTick`/`ledgerTick`/`retentionTick` 的任务体各自缩成对上述入口的调用加 `stderr` 日志；`pendingTick`/`deriveTick`/`gapTick`/`costTick` 原本就是一行委托，不动。

随归位带来的两处行为改进：路由坏行的 issue 记账走 `recordIssue`，冲突更新现在也写 `byte_length`（原来只更新 `observed_at`）；一个文件的坏行记账合并进单个写事务（原来每行一个事务）。游标语义、触顶门槛与批次数都不变。

## Alternatives considered

**任务体留在 main.ts，只补测试。** 测试需要 boot 整个采集器或把 startCollector 拆到能注入 fake timer，成本高于把任务体移到已有 module；而且 SQL 留在编排根里，「一个事实一个家」的规则继续被违反。

**给任务体建一个独立的 tasks.ts。** 任务体的自然归属是它们操作的概念（摄入归 reconcile、保留归 retention），集中到一个 tasks.ts 只是把 main.ts 的体积换个文件名，seam 位置没有变。

## Consequences

- 行格式与游标规则一个家：改路由游标语义只动 `reconcile.ts`，改触顶策略只动 `retention.ts`。
- 路由落库与预算回收首次有了直接测试（`reconcile.test.ts` 的指纹游标与坏行记账、`retention.test.ts` 的触顶回收与闸门失效），此前只有 `queries.test.ts`/`maintenance.test.ts` 间接覆盖。
- `main.ts` 仍然没有直接测试文件；剩余的任务体都是一行委托，进程装配（signal、server、启动顺序）留给端到端用例。
