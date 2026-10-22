# Agent Note: v5 结构由显式迁移落地，未完成即拒绝启动

Status: implemented

## Problem

v4 库里的派生结果按旧口径算错，且缺少来源依据、请求修订与组发布状态。补列能让新代码读得下去，但不会让旧结果变对；删库重来又会丢掉只在本库里的正文。两种做法都不能单独用。

同时，"结构已经是 v5"与"迁移跑完了"是两件事。若只靠 `user_version` 判断，一个刚补完列、还没重算的库会被当成可用库启动，在线写入随即在半迁移数据上追加新事实，事后无法分辨哪些行来自哪条规则。

## Decision

v4→v5 只有一条路径：显式迁移。普通 `openStore` 不做 `ALTER`；空库直接建到 v5 并在建表事务里写入 `complete=true` 的标记；低版本报 `schema_rebuild_required`；高版本报 `schema_version_unsupported`。

结构存在之后还要读 `collector_state['migration:v5']` 的标记：标记缺失报 `migration_marker_missing`，格式不合法报 `migration_marker_invalid`，未完成且调用方没有显式传 `allowIncompleteMigration` 时报 `migration_incomplete`。显式迁移是唯一允许绕过完成标记的调用方，它自己续跑剩余阶段。

标记与 DDL、`PRAGMA user_version` 在同一事务里提交，因此不存在"列补上了但标记没写"的中间态；注入失败的用例证明回滚后列与版本号都回到 v4。

`src/conservation.ts` 提供守恒摘要，只覆盖迁移不得改变的表：请求 ID、别名、证据 owner、正文引用、费用观测、游标、淘汰墓碑，以及按 id/hash/z 流式计算的正文块。新增长期列与派生结果不进摘要，否则一次合法重算就会让摘要失效。

`derive_queue` 从待办集合变成持久组状态：`clean` 行保留，待办查询一律 `state<>'clean'`；`group_epoch` 标识组的世代，`input_revision` 随输入变化增长，完成时记 `published_revision` 与 `published_algorithm`；`dirty_since_ms` 只表示首次未完成触发时间，重复 dirty 保最早值，clean 后清 NULL。任何事务失败都不能提前把组标成 clean。

## Alternatives considered

**启动时自动补列。** 会把结构升级与派生重算混进一次启动，失败时既没有明确错误也没有可重跑入口；更糟的是重算中断后库已标成当前版本，直接启动会继续使用未完成的派生。

**只靠 `user_version` 判断可用性。** 版本号在补列时就写了，无法区分"结构就绪"与"迁移完成"，正是这一轮要修的问题。

**守恒摘要覆盖全部表。** 迁移本来就要重写派生列与新增长期列，把它们计入摘要会让每次合法的重算都被判成失败，摘要也就失去意义。

**迁移完成前允许只读打开。** 读模型会看到半迁移行的混合口径，而读模型没有版本标记可以区分，读者无从判断哪一列可信。

## Consequences

- 旧库不能直接启动，必须先跑显式迁移；迁移未完成期间任何普通启动都会被拒绝。
- 迁移按阶段与游标推进，中断后重跑从上次提交的批次继续；已提交的批次不会重复产生副作用。
- 正文块与证据在摘要里，迁移若重新编码了原文会立刻失败。
- `derive_queue` 的 clean 行会长期保留，增长成本随会话组数而不是请求数；回收策略需要测量后才定，见[容量收敛计划](../../../../docs/superpowers/plans/2026-10-22-atc-capacity-convergence.md)。
- 标记里保留初始 baseline，续跑不重建摘要；这同时意味着迁移期间被外部修改的守恒表会让校验失败，而不是被悄悄接受。

## Testing

`tests/migration-v5.test.ts` 的「v5 结构和未完成标记原子提交并拒绝普通打开」「v5 初始化 marker 失败回滚全部 DDL」「新空库 v5 标记完整」锁定结构、拒绝与回滚；`tests/store.test.ts` 的「拒绝未知的高版本 schema」保持。合成库由 `tests/fixtures/schema-v4.sql` 固定为 v4 原文。
