# Agent Note: 派生选源 SQL 片段单家与对照指纹列清单

Status: implemented

## Problem

选源 join 与取值条件有两份手写：`queries.ts` 的文件私有 `DERIVED_JOIN`/`DERIVED_COL`，与 `reading.ts` `IDENTITY_SQL` 里逐字复写的同一对 join。选源语义本身有单家（[整套选源](../feature/2026-10-24-published-derivation-reading.md)，判据在 `groupCurrentSql`），但承载它的 join 形状没有——指针列或 join 条件一变就要两处同步，漏一处则是静默错读。容量脚本里 `derivedHash` 与 `derivedHashSlice` 各自手写同一份 13 列有序清单：列顺序参与哈希，单侧加列、掉列或换序会让 `long-10000` 与 `long-10000-slice` 的 `result_sha256` 对照静默失效。

## Decision

join 与取值片段落进 `derive-state.ts`（`deriveJoinSql`/`derivedColSql`，随该模块 `*Sql` 命名），挨着 `queuePendingSql`/`groupCurrentSql`/`purposePendingSql`——它们本就共享「片段相同、查询角色各自保留」的哲学。queries 的全部用点与 reading 的 `IDENTITY_SQL` 共用；选源语义、`projectRow` 的 current 屏蔽、身份槽位（固定 null 槽、两条取源列并读）全部不动。`IDENTITY_SQL` 只是把 join 的形状外包，选哪些列仍由身份语义决定。

容量脚本侧，`HASH_COLUMNS` 有序清单（标注 `fact`/`derived` 归属）成为唯一一份：同步路径全列读 request，切片路径派生列读发布代 result 行、事实列 join 回 request。两条取源路径刻意保留——统一成一条回退路径会让对照失去意义，指纹相等恰恰要证明两条不同来源读出同一组值。`derivedHash` 导出供对照锚使用。

不碰 `effective_request` 视图与 schema：视图没有同步列回退也没有 current 判定，不能替代生产读取；存量 v6 库不重执行 schema，`IF NOT EXISTS` 下单改定义不生效，版本抬升（伴随重建成本）留给真正需要结构变更的场合。

## Alternatives considered

**用视图统一选源（v1 提案）。** 上述能力缺口决定它最多做旁路核对，替代不了生产查询；为去重抬 schema 版本不值。

**新建 derive-sql.ts 专门安家。** derive-state 已是共享 SQL 片段之家，再开一个家违背一个事实一个家。

**指纹清单也搬进 derive-state。** 清单是容量脚本的对照契约，不是引擎不变量；唯一消费文件就是它的家。

**指纹对照靠 E2E 场景跑出来再比。** 十分钟级长组跑一次才知道分叉，锚测试在合成库上直接钉住清单一致性。

## Consequences

join 形状与指纹清单从此单点改；reading 新增对 derive-state 的 import，依赖方向（config ← store ← 引擎与读模型）不受影响。清单或 join 后续变化时，同步改一处即可，对照锚会拦住任何单侧漂移。

## Testing

- 行为保持：`bun test tests/queries.test.ts tests/reading.test.ts tests/http.test.ts tests/derive.test.ts tests/capacity.test.ts` 149 例在改动后零修改通过（2026-10-25）。
- 新锚 `同步与切片指纹共享同一份有序列清单`：同一组派生值经两条路径必须同指纹；变异验证过咬合——手写清单掉一列（单侧漂移）即失败，共享清单整体换序不误伤（两侧一致变化，指纹仍相等，符合设计）。
- `bun run typecheck`、`bun run verify:notes` 通过。
