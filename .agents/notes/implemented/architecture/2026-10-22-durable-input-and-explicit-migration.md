# Agent Note: v5 结构由显式迁移落地，未完成即拒绝启动

Status: implemented

## Problem

v4 库里的派生结果按旧口径算错，且缺少来源依据、请求修订与组发布状态。补列能让新代码读得下去，但不会让旧结果变对；删库重来又会丢掉只在本库里的正文。两种做法都不能单独用。

同时，"结构已经是 v5"与"迁移跑完了"是两件事。若只靠 `user_version` 判断，一个刚补完列、还没重算的库会被当成可用库启动，在线写入随即在半迁移数据上追加新事实，事后无法分辨哪些行来自哪条规则。

## Decision

> v4→v5 的显式迁移已被[旧库删除重建](2026-10-23-destructive-schema-replacement.md)取代：迁移状态机、完成标记与 `src/conservation.ts` 已从源码移除，旧库报 `schema_rebuild_required` 后由运维删除重建。下方保留当时的迁移决策作为背景；持久输入与组修订部分仍然有效。

当时的迁移路径是显式迁移：普通 `openStore` 不做 `ALTER`；空库直接建到 v5 并在建表事务里写入 `complete=true` 的标记；低版本报 `schema_rebuild_required`；高版本报 `schema_version_unsupported`。结构存在之后还要读 `collector_state['migration:v5']` 标记，未完成的库拒绝普通启动；标记与 DDL、`PRAGMA user_version` 同事务提交，不存在"列补上了但标记没写"的中间态。

以下持久输入与组修订决策仍然有效。

`derive_queue` 从待办集合变成持久组状态：`clean` 行保留，待办查询一律 `state<>'clean'`；`group_epoch` 标识组的世代，`input_revision` 随输入变化增长，完成时记 `published_revision` 与 `published_algorithm`；`dirty_since_ms` 只表示首次未完成触发时间，重复 dirty 保最早值，clean 后清 NULL。任何事务失败都不能提前把组标成 clean。

推进修订的动作集中在 `src/derive-state.ts`，由各个写入者在自己已经持有的 writer 事务里调用，不嵌套 `Store.write`：

| 写入者 | 触发点 | 为什么必须推进 |
| --- | --- | --- |
| `persistBodyTx` | 骨架、块引用与解析状态写完之后 | 正文是前驱比对与摘要的唯一输入 |
| `acceptHook` | 直接命中已有请求、新建请求、metadata-only 三种结局 | hook 证据与降级原因都会改变投影完整度 |
| `mergeHookInto` | 改归属前标源组；删源请求前标目标旧组；之后换存活请求 epoch 再标 | 源组少一个成员、目标多了源请求的证据 |
| `reconcile` 账本与路由写入 | 投影签名与写入前基线不同才标 | 字段级事实变化才算输入变化，费用刷新不算 |
| `evictOldestBodyBatch` | 删正文的同一事务，按本批候选 | 引用没了，序列指纹不再可比 |
| `pruneRaw` | 证据转 expired 的同一事务，重算投影后标 | 读模型不能看到"raw 已删但还标 current" |
| `purgeMetadata` | 删行前记录受影响组；空组同步 clean | 有剩余成员的组要重算，空组不产生积压 |

基线必须在写入之前取。投影是幂等的，写完再读只会读到已包含新证据的结果，差异永远为零；这是实现这一层时最容易写错的地方，回归用「同值重放不推进、kind 变化推进」两侧一起锁定。

## Alternatives considered

**启动时自动补列。** 会把结构升级与派生重算混进一次启动，失败时既没有明确错误也没有可重跑入口；更糟的是重算中断后库已标成当前版本，直接启动会继续使用未完成的派生。

**只靠 `user_version` 判断可用性。** 版本号在补列时就写了，无法区分"结构就绪"与"迁移完成"，正是这一轮要修的问题。

**守恒摘要覆盖全部表。** 迁移本来就要重写派生列与新增长期列，把它们计入摘要会让每次合法的重算都被判成失败，摘要也就失去意义。

**迁移完成前允许只读打开。** 读模型会看到半迁移行的混合口径，而读模型没有版本标记可以区分，读者无从判断哪一列可信。

## Consequences

- 旧库不能直接启动，报 `schema_rebuild_required`；升级方式是删除旧数据目录后重建，迁移不再提供续跑入口。
- `derive_queue` 的 clean 行会长期保留，增长成本随会话组数而不是请求数；回收策略需要测量后才定，没有安全的 GC 证据前不自动删状态，见[容量收敛计划](../../../../docs/superpowers/plans/2026-10-22-atc-capacity-convergence.md)。
- 同一事务里多处触发会多次推进修订；正确性只依赖单调性，不承诺恰好加一。因此回归断言用"增长"与"不变"，不写死具体差值。

## Testing

`tests/store.test.ts` 的「低版本库拒绝打开，空库建到当前版本」锁定 `schema_rebuild_required` 与新库版本，「拒绝未知的高版本 schema」保持；迁移相关的结构与标记用例已随迁移一起删除。

`tests/derive-state.test.ts` 锁定修订单调、epoch 复用与未知归属不入队；每个写入者的入口各有一条最窄回归：`tests/body.test.ts` 的「正文保存推进输入修订并置待处理，补正文再次推进」、`tests/hook.test.ts` 的「重复hook_id不推进修订，补正文与合并才推进」「合并先标源组再换存活请求epoch」「命中账本的metadata_only无骨架请求保持不可比较」、`tests/reconcile.test.ts` 的「账本字段级变化推进修订，重复证据与费用刷新不推进」「route kind变化推进修订，同值重放不推进」、`tests/retention.test.ts` 的「回收正文在同一事务推进修订并标脏所属组」「原始层过期在同一事务推进修订，证据族转expired」、`tests/maintenance.test.ts` 的「淘汰在删行前标记受影响组，空组同步完成」。
