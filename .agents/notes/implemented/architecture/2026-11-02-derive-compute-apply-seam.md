# Agent Note: 派生算/写接缝：计算只读、落库短事务

Status: implemented

## Problem

在线派生把一组的全部阶段放进一个写事务：链匹配、角色重算、工具配对、后台作业与摘要列都在事务里读正文、算结论、写回请求行。真实流量 565.0 秒、78 组的语句级拆分（[验收记录](../../../../docs/acceptance.md#派生写事务语句级拆分生产读数真实流量2026-11-02)）把这段时间切成四段：读语句 40.2%、纯计算 51.4%、写语句 5.6%、事务开合 2.8%。写库合计 8.4%，其余九成多既不产生写入也不占写锁，却整段占住写者与事件循环（同窗口 `event_loop` p99 273.6 ms、max 13,856 ms，hook 摄入 10 次以 `busy` 429 被拒）。

事务边界还决定了算与写的分工。配对阶梯要读 `tool_call` 才知道上一轮判成什么，角色判定要回读刚写下的 `prev_req_id`：这两处读回读的都是本事务自己刚写的行。事务一拆开，这类读回就没有依据。

## Decision

组派生拆成两段，跨段只有一个契约：

- `computeDeriveGroup(db, convKey, actor, options)`：只读，产出 `ApplyPlan` 与本次读数（`processed` / `recomputed` / `retained` / `body_read`）。没有待办组、或组里还有用途未判定的请求时返回 `null`。
- `applyDeriveGroup(db, round)`：一个事务按序执行计划——算法号归一、链关系、角色、工具行、后台作业行、展示列——末尾交换 `derive_queue`，`changes !== 1` 抛 `derive_input_changed`。

`ApplyPlan` 是五组写操作加守卫身份：`chain`（前驱、关系、增量、`aux`/`main`）、`roles`、`tools`、`jobs`、`presentations`，加上认领时读到的 `group`（`group_epoch`、`input_revision`、`target_algorithm`）。计算期读到的旧值（标题、摘要依据、配对关联、前驱关系）随计划带走，落库段不再回头读。

计算段不写库，靠三处改动成立：配对阶梯的 `alreadyResolved` / `alreadyPending` 查本轮内存状态表（重建语义下本组旧行在落库时先被 `DELETE`，读回等于读内存）；角色判定消费按 `req_id` 建的关系表；算法号归一从认领处移到落库段第一句，写与交换因此仍在同一个事务里。

在线调用点（`src/derive/unit.ts` 的同步分支）改成 `computeDeriveGroup(store.read, …)` 加 `store.write(db => applyDeriveGroup(db, round), 'derive')`：计算跑在只读连接上，该连接开了 `query_only`，计算段真出现写语句会直接抛错；写事务只覆盖写语句与事务开合。`drainDeriveGroupTx` 保留为两段的组合，维护、容量实验与探针脚本的调用不变。

交换守卫沿用现有机制：`group_epoch` 与 `input_revision` 在计划落库前变过就整轮丢弃、下一 tick 重算，不做部分落库。

## Alternatives considered

**只把读与计算移出写事务。** 计算留在主线程，51.4% 的纯计算继续占住事件循环；写锁短了，阻塞只是减轻。换位置与瘦身得一起做，单独瘦身不成立。

**先按 Worker 隔离（W1 唯一 writer / W2 忙则不等）。** 合成长链四场景实测：Worker 派生、主线程写等待锁时事件循环 lag 833.9 ms，与不隔离持平；不等待则 40 次写里 38 次被 `SQLITE_BUSY` 拒绝。收益取决于主线程是否等 Worker 的写锁，而写库只占 8.4%，不值得为它改写者归属。计算搬进 Worker 仍是要走的下一步，接缝先交付，见[派生移出主线程提案](../../proposed/architecture/2026-11-02-derive-worker-isolation.md)。

**不做交换守卫，靠"单 writer 串行"保正确。** 在线路径里计算与落库之间没有让出点，今天确实不会交错。守卫随接缝一起交付，为的是下一步：计算搬进 Worker 之后，没有它就只能拿半发布的组状态换延迟。

**切片路径按同一形状改写。** 切片读写的是 `derive_generation` 一族表，形状是发布指针加六阶段游标，与同步路径的逐字段写回不同。本批不动切片。

## Consequences

- 写锁只覆盖写语句与事务开合（真实流量合计 8.4%，最长一组推算约 1.1 秒）。读与计算不持写锁，计算容器因此可以离开主线程。
- 行值不变：`tests/derive-apply-plan.test.ts` 拿同一合成组的"只读连接算 + 独立写事务落库"与"读写在同一个事务"两条路径逐表比对（`request`、`tool_call`、`bg_job`、`derive_queue`）。组内阶段顺序（链 → 角色 → 工具 → 后台作业 → 展示 → 交换）与各自的写语句不变。
- 计划把计算期读到的值一次带走，代价是计划与库之间多了一个靠交换守卫弥合的窗口。窗口内到达的输入让整轮作废、下一 tick 重算；作废整轮而不是部分落库，是这条接缝的正确性代价。
- 计算段的块级读取缓存作用域改成一次计算段，`body_read` 读数与它同寿命，见[正文块读取复用](../../../../docs/architecture-design.md#正文块读取复用)。
- 组内原子性的落点从整个组事务移到落库段，见[缺失正文与空消息序列分开判定](../bug-fix/2026-10-22-atomic-synchronous-derivation.md)；按组提交的预算调度与空闲零事务不变，见[派生预算工作单元](../architecture/2026-10-24-budgeted-derive-unit.md)。

## Deferred

- 计算段搬进 Worker，以及随之而来的主线程写策略、崩溃恢复与关闭语义，见[派生移出主线程提案](../../proposed/architecture/2026-11-02-derive-worker-isolation.md)。
- 部署后的真实流量复测：落库段占写事务总时长的比例、最长一组单次写事务耗时、队列追平与 hook 拒绝计数。口径与步骤见[实施计划](../../../../docs/superpowers/plans/2026-11-02-derive-compute-apply-seam.md)。
- 切片路径的同形状改写。
- 计算段里的块解码每次重来（真实流量窗口内 68,060 次解码、命中 0），与线程方案并行治理，见[派生正文重复解压修复](../../proposed/bug-fix/2026-10-26-derive-body-decompression-amplification.md)。

## Testing

`tests/derive-apply-plan.test.ts` 四条：计算段在只读连接上算完计划后写计数与库内容都不变、计划里的关系与角色就是本轮结论；读连接算出的计划落库与单事务路径逐表一致；计划落库前输入变过就整轮丢弃且库回到计划前状态；没有待办组时返回 `null` 且不写。派生家族既有用例（链、角色、工具配对、后台作业、展示、单元调度、切片、重建、轮次结算）不改一行全过。

真实验收未执行：本提交只做到合成等价与只读断言，部署后的窗口读数按 `Deferred` 一节单独记录。