# Agent Note: 派生层四片共享逻辑各归其位

Status: implemented

## Problem

两条派生路径（同步 `derive.ts` 与切片 `derive-slice.ts`）的判定已经收进 [`derive-decision`](2026-10-23-derive-decision-kernel.md)，但四片支撑逻辑仍各存两份或放错位置：

- **确定增量判据**：同步路径在 `pairToolCallsTx` 里写 `ordinalConfirmed`，切片路径在结算阶段写 `confirmedAll`/`deltaOrds`，两边用不同形状表达同一条规则（first 全确认、confirmed 只看增量、其余不确认）。
- **用途门控谓词**：同步路径认领后查 `actor_state='known' AND purpose_pending=1`，切片选组时把同一条件写进 `NOT EXISTS`。两条 SQL 各自维护。
- **算法归一**：认领前把 `derive_queue.target_algorithm` 归一到本模式算法号的 UPDATE 语句，同步与切片逐字重复。
- **共享读取层**：`LogicalRow`、顺序比较、`fingerprintsOf`、`firstUserPreview`、`tailUserPreview`、`replyInfoOf`、`messageAt`、`presentationPortsOf` 都住在 `derive.ts`；切片路径为了取值 import 同步引擎模块。两个预览函数除 `ORDER BY` 方向外逐行相同。另有一段 `blocksOf` 无任何引用。

## Decision

四件事在同一片代码里一次归位，语义与判据不变：

1. **增量判据**：`derive/decision.ts` 新增 `confirmedDeltaOf(relation, delta)`，返回 `{ all, ords }`。同步配对用它构造 `ordinalConfirmed`，切片结算用它逐行写 `confirmed` 位。
2. **用途门控**：`derive/state.ts` 新增 `purposePendingSql(alias?)` 只产出谓词片段。**两个查询角色保留**：切片选组时是外层过滤，同步路径认领后是 TOCTOU 复查。选组与处理之间可能有新请求挂进来，外层过滤看不到那次变化。
3. **算法归一**：`derive/state.ts` 新增 `normalizeTargetAlgorithmTx(db, convKey, actor, algorithm)`，算法号是参数；`GROUP_ALGORITHM` 与 `DERIVE_ALGORITHM` 两个常量各自保留。只改未完成行——clean 行的已发布产物不能被改号伪造出处。
4. **共享读取层**：新建 `derive/read.ts`，承接 `LogicalRow`、`DeriveScope`、`compareLogicalOrder`/`compareTraversalOrder`、`uncertainOrderIds`、`fingerprintsOf`、`replyInfoOf`、`messageAt`、`presentationPortsOf`；`firstUserPreview`/`tailUserPreview` 合并成 `userPreview(db, reqId, 'first' | 'tail')`，`LIMIT 5` 与首/末条用户文本语义逐字保留。`derive/sync.ts` re-export `DeriveScope` 保持既有 import 点。删除 `blocksOf` 死代码。

依赖方向变成 `derive/sync` / `derive/slice` → `derive/read` → `derive/decision` 与 `body`，切片路径不再 import 同步引擎模块。

## Alternatives considered

**让切片继续从 `derive.ts` 取共享读取。** 读取实现与引擎流程同文件，改一个取值函数要通读整个引擎；切片只为取值而依赖同步模块，这掩盖了两条路径真正的共同契约。

**把同步的 waiting 复查换成切片的外层 `NOT EXISTS` 过滤。** 外层过滤发生在选组时，认领与处理之间新请求可能挂进来；复查必须发生在认领后，这是 TOCTOU 的时序要求，不是写法重复。

**合并 `GROUP_ALGORITHM` 与 `DERIVE_ALGORITHM`。** 两个算法号分开是为了让产物不能互相复用（切片注释已写明）；合并等于允许把一套算法的结果当成另一套的产物。

**把两个预览函数留成两份实现，只抽公共循环。** 它们唯一的差别是扫描方向；`LIMIT 5` 是「最多看五条」的语义边界，参数化后这条边界与取值判据在同一处，不会一边改了方向、另一边忘了这条边界。

## Consequences

读取实现与门控语义各有唯一位置。新增读取 helper 应进 `derive-read`，新增门控查询应复用 `purposePendingSql`。切片路径与同步引擎之间只剩类型级入口（`DeriveScope` 经 re-export 或直接从 `derive-read` 取）。归一语句共享后，改「只改未完成行」的规则会同时作用于两条路径。

## Testing

- 五分支等价：`first`/`confirmed`/`unknown`/`branch`/`aux` 以及 confirmed 缺增量记录的形态，逐一断言 `{ all, ords }`。
- 门控片段：带别名与不带别名两种拼法逐字断言。
- 算法归一：pending 行改号、clean 行保持原号。
- 派生四文件（derive / derive-slice / derive-state / derive-unit）107 例、下游三文件（capacity-slice / maintenance / queries）68 例全过；`bun test` 全量 602 例（39 文件）通过，`bun run typecheck` 干净（2026-10-24）。
