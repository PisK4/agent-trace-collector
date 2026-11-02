# ATC 派生算/写接缝实施计划

> **For agentic workers:** 逐任务执行，每任务带自己的测试与复核；不虚构技能调用。本文只编排合成回归与显式部署动作，不授权真实库回填、push 或提交。

**Goal:** 让派生组的读与计算不再持有写锁：计算在只读快照上跑完并产出落库计划，写事务只执行计划、CAS 守卫与队列确认。

**Architecture:** `drainDeriveGroupTx` 拆成 `computeDeriveGroup`（只读，产出 `ApplyPlan`）与 `applyDeriveGroup`（一个短事务执行计划）。算法与判定规则不动，改的是读发生在哪个时刻、写在哪个事务里。计算容器先是主线程调用，任务 6 把它交给 Worker。

**Tech Stack:** TypeScript、Bun、`bun:sqlite` WAL、不增加依赖。执行位置用 Bun `new Worker`（已有 spike 证据）。

**Spec:** [派生移出主线程提案](../../../.agents/notes/proposed/architecture/2026-11-02-derive-worker-isolation.md)、[语句级拆分读数](../../acceptance.md#派生写事务语句级拆分生产读数真实流量2026-11-02)、[组内原子性](../../../.agents/notes/implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md)、[按组提交的预算调度](../../../.agents/notes/implemented/architecture/2026-10-24-budgeted-derive-unit.md)。

**当前数字（565.0 秒、78 组真实流量）：** 读语句 40.2%、纯计算 51.4%、写语句 5.6%、事务开合 2.8%。落库段合计 8.4%，最长一组 13.35 s 里推算约 1.1 s。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL、写操作走一个 writer、查询走独立只读连接；不增加第三方依赖。
- 判定规则不搬家：链、角色、工具、摘要的判据留在 `derive/decision.ts` 与 `derive/read.ts`，本批只改读写时序。
- CAS 守卫（`derive_input_changed`）是接缝的正确性依赖：计划落库前输入修订变了就丢弃本轮、下一 tick 重算，不做部分落库。
- 测试只用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。
- 合成验收与真实流量验收分开写；未覆盖项单列，不把推算当实测。
- 本批不启用切片路径，不改 `derive_version` 口径，不动 schema。

## 范围、文件与 Interface

| 文件 | 职责与计划改动 |
| --- | --- |
| `src/derive/sync.ts:260-390` | 组入口拆成计算与落库两段；`ApplyPlan` 类型定义 |
| `src/derive/sync.ts:150-167` | `assignChainRoles` 改为从内存节点算角色，返回待写角色表 |
| `src/derive/sync.ts:423-565` | `pairToolCallsTx` 拆成「算出 calls/results 与关联」与「DELETE + INSERT 工具行」 |
| `src/derive/bg-jobs.ts` | 同上：算出作业行，落库段执行 DELETE + INSERT |
| `src/derive/sync.ts:82-135` | `writePresentationTx` 改为返回每行的列值，落库段执行 UPDATE |
| `src/derive/unit.ts:44-84` | 调用点改成 compute → apply，预算与轮询语义不变 |
| `src/store.ts` | 落库段保持 `write(fn,'derive')`；插桩口径随之变化，读数解读要更新 |

`ApplyPlan` 是唯一的跨段契约，形状固定为四组写操作加一个守卫：

```ts
export type ApplyPlan = {
  group: QueuedGroup;                    // CAS 用：group_epoch 与 input_revision
  chain: { reqId: number; prevReqId: number | null; relation: string; deltaJson: string | null }[];
  roles: { reqId: number; role: string }[];
  tools: { reqId: number; ord: number; callId: string; name: string; /* … */ }[];
  jobs: { jobId: string; /* … */ }[];
  presentations: { reqId: number; columns: Record<string, unknown> }[];
};
```

## Task 1：计算段与计划类型（先不动调用点）

- [ ] 定义 `ApplyPlan` 与 `computeDeriveGroup(db, convKey, actor, options)`，返回计划或 `null`（无待办组、用途未定）。
- [ ] 计算段用只读连接：`store.read` 传入，或接受一个 `Database` 参数由调用方决定，测试两种都覆盖。
- [ ] 链阶段循环改成只收集：`match`、`interrupts`、`context`、`presentations` 与 `chain` 数组进计划，不执行 UPDATE。
- [ ] 测试：合成组上 `computeDeriveGroup` 不产生任何写（用 `store.writeStats.count` 与库内容双重断言），且计划里的关系与现行实现的写值逐行一致。

## Task 2：落库段

- [ ] `applyDeriveGroup(store, plan)`：一个 `write(fn,'derive')` 内按序执行链更新、角色、工具、作业、摘要列、CAS、队列确认。
- [ ] CAS 失败（`changes !== 1`）抛 `derive_input_changed`，由调用方按「丢弃本轮」处理。
- [ ] 测试：把计划喂给落库段得到的库状态与旧实现一次事务跑完的状态逐表一致；CAS 失败时库回到计划前状态。

## Task 3：角色与工具配对改成「算 + 写」两段

- [ ] `assignChainRoles` 的节点来自计划里的链关系，不再回读自己写的关系；角色判定仍走 `chainRolesOf`。
- [ ] `pairToolCallsTx` 拆出纯计算部分（calls/results/关联），落库段执行本组 DELETE 与 INSERT。
- [ ] 测试：分组测试用同一合成组，比较拆前拆后的 `tool_call` 行集合与 `chain_role` 分布；正文已回收的行保持原样这条既有断言必须仍过。

## Task 4：展示列与后台作业

- [ ] `writePresentationTx` 拆出列值计算；`retained` 语义（不可读保留旧值）按现行规则，测试不变。
- [ ] `pairBackgroundJobsTx` 同样拆成算与写。
- [ ] 测试：`derive-bg-jobs`、`derive-presentation` 既有用例全过，另加一条断言计划里的列值与旧实现写值一致。

## Task 5：单元调度接缝

- [ ] `drain()` 的同步分支改成「读候选 → compute（读连接）→ apply（写事务）」，预算检查保持在组之间。
- [ ] 入口等待与空转语义不变：`commitUnit` 准备意图为空的轮次不开事务。
- [ ] 测试：`derive-unit` 既有用例（空闲零事务、预算截断、组数上限、第二组失败回滚）全过。

## Task 6：计算交 Worker（显式动作）

- [ ] 计算段搬进 Worker（spike 的 `perf-derive-worker-entry` 形状），主线程只跑落库段。
- [ ] 主线程写策略显式化：落库窗口内的 `busy_timeout` 与失败重试写进[架构设计](../../architecture-design.md)与[运维手册](../../operations.md)。
- [ ] 崩溃与关闭：Worker 在计算或落库中被终止后重启，组状态不半发布；`service stop` 等当前组落盘。
- [ ] 合成验收：长组派生期间事件循环 lag、读探针、写探针三项读数（沿用 `scripts/perf-derive-worker.ts` 的探针口径）。

## Task 7：真实流量验收（显式动作）

- [ ] 部署后按同一窗口口径取 `writer.by_name.derive.sql` 与 `event_loop`：落库段占写事务总时长的比例、最长一组单次写事务耗时。
- [ ] 派生追平：`derive_queue` 无长期 dirty 组，`input_revision == published_revision`。
- [ ] hook 摄入 `busy` 拒绝次数与窗口对照，不作因果结论，只记观测。
- [ ] 未覆盖项单列：分组级落库耗时、Worker 崩溃恢复、多 Worker 竞争。

## 验收与回退

- 合成：全套 `bun test` 与 `bun run typecheck`；逐任务的窄测试先过，再跑全量。
- 真实：Task 7 的窗口读数与队列追平；合成读数不替代真实验收。
- 回退：任务 1–5 是纯代码结构改变，回退到旧 `drainDeriveGroupTx` 即恢复；任务 6 单独开关（Worker 与否），关闭即回到主线程计算。