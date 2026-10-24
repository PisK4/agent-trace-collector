# ATC 性能工作单元实施计划

> **For agentic workers:** 按任务在当前会话逐项实施；用户已授权开始落地，无需再次选择执行方式。每阶段独立验证、独立提交。

**Goal:** 减少派生对 hook 投递的阻塞、消除后台空转写事务，并让文件证据与读取游标原子提交。

**Architecture:** 在线派生使用有时间预算的工作单元，内部复用同步组事务和实验切片阶段机。存储层接收具名提交意图，先只读准备，存在写入需求才提交。文件摄入共用游标与事务边界，追加文件和封口 gzip 保留各自的读取方式。

**Tech Stack:** TypeScript、Bun、bun:sqlite、node:zlib；不增加依赖，不修改 schema。

**Spec:** 2026-10-24 架构性能评审与实施交接；已确认约束以[架构设计](../../architecture-design.md)为准，实施取舍保存在各阶段 Agent Note 中。

## Global Constraints

- 数据库使用单 writer，查询使用独立只读连接；写事务内不得 await。
- 测试只使用合成数据；正文、账号、令牌与用户配置不进入提交。
- 不修改右栏改版已有的 `web/app.js`、`web/body-view.js`、`web/index.html`、`tests/body-view.test.ts`、`tests/web.test.ts`。
- 生产切片启用仍遵守 `slice_read_unmigrated` 拒绝路径；C1 首轮不迁移读模型，C1.5 独立评估并排在 C2 之后。
- C4 窗口读取等待右栏改版合并或读侧实测显示事件循环竞争。
- 每阶段提交只包括所属文件，提交前执行 `bun run verify:notes`；源码提交到 ATC 仓库。

---

### Task 1: 派生预算工作单元（含阶段 0）

**Files:** 新建 `src/derive-unit.ts`、`tests/derive-unit.test.ts`；修改 `src/derive.ts`、`src/derive-slice.ts`、`src/main.ts`、`tests/derive-slice.test.ts`、架构设计与相关 Agent Note。

**Interfaces:** 消费 `drainRequestPurposesTx`、同步组派生和切片阶段机；产出 `createDeriveUnit(store).run({budgetMs}) → {didWork,nextDueMs}`。维护和容量实验的 `drainDeriveEntry` 保留完整计数返回值。

- [ ] 添加空闲零事务用例：记录 `writeStats.count`，调用工作单元，断言计数不变且 `didWork=false`。
- [ ] 添加预算停止用例：合成多个独立组，在组提交后让计时超过预算，断言已完成组保留、其余仍 dirty，下轮可继续。
- [ ] 添加故障恢复用例：第二组确认触发 SQL 错误，重开库后第一组 clean、第二组 dirty，移除故障后继续完成。
- [ ] 实现用途小批事务、同步每组事务和组间预算检查；每轮最多 10 个组，默认 400 ms。每个组的链、角色、工具、摘要与 CAS 不可分割。
- [ ] 让切片完整流程测试调用调度入口；阶段专项测试可直接调用对应阶段，避免完整流程复制阶段次序。
- [ ] 在线 tick 按 `nextDueMs` 安排后续调用，积压时让出事件循环；停止时取消定时器。
- [ ] 执行 `bun test tests/derive-unit.test.ts tests/derive.test.ts tests/derive-slice.test.ts tests/main.test.ts tests/capacity-slice.test.ts`；同步维护共享实现时补跑 `tests/maintenance.test.ts`。
- [ ] 更新组事务与崩溃语义：已完成组保留；未完成同步组回滚；启动恢复丢弃未发布切片代。写明同步单大组仍可能超过预算。
- [ ] 运行 note 门禁并提交 `perf(derive): bound online work and commit groups independently`。

### Task 2: 具名提交与空闲判断

**Files:** 修改 `src/store.ts`、`src/capacity.ts`、`src/main.ts`、`src/hook.ts`、`src/retention.ts`、`src/sources/magpie.ts`、对应窄测试、架构设计；新增提交单元 Agent Note。

**Interfaces:** 存储层接收具名写意图与只读准备函数，准备返回无操作时不打开事务；`writer` 保留累计计数并增加按名统计。

- [ ] 在存储测试中覆盖空准备零事务、具名成功和具名回滚都计数，异步事务仍拒绝。
- [ ] probe 只在探测结果变化时写；pending 没有可合并或新歧义时不写；gap 状态不变时不写；raw_prune 没有到期候选时不写。
- [ ] cost 在请求和校验页成功后提交进度，失败前不单独写窗口重置；相同空页不重复提交。保留费用冲突整页回滚与独立健康记录。
- [ ] 有积压的 pending、gap、raw_prune 使用有界候选批次，提交归属名出现在 `/api/ingest-metrics`。
- [ ] 执行 `bun test tests/store.test.ts tests/hook.test.ts tests/retention.test.ts tests/magpie.test.ts tests/capacity.test.ts tests/main.test.ts` 与 `bun run typecheck`。
- [ ] 在隔离合成采集器中采样 120 s 稳态写事务，区分启动写入与窗口增量；保留真实采集器聚合基线，不重启真实进程。
- [ ] 更新架构设计与 note，执行 note 门禁并提交 `perf(store): skip idle commits and attribute writer time`。

### Task 3: 原子文件摄入

**Files:** 修改 `src/sources/files.ts`、`src/reconcile.ts`、`src/main.ts`、`tests/files.test.ts`、`tests/reconcile.test.ts`；更新架构设计和摄入 Agent Note。

**Interfaces:** `ingestSource` 接收统一来源读取结果；追加 jsonl 与封口 gzip 各自适配到同一游标与提交流程。证据映射的事务内函数由既有公共入口复用。

- [ ] 添加路由批仅一个事务与坏行、记录、游标共同回滚的用例，失败后同内容可重读重记。
- [ ] 添加路由与账本共享的同代同 rewrite_epoch 偏移不回退用例，换代或重写可归零。
- [ ] 统一 cursor upsert，删除 `fileCursorOf` / `routeCursorOf`，保留 gzip 整体指纹和半行不推进。
- [ ] 将在线 ledger/route 调度接入统一摄入入口；暂停与缺口逻辑保持可恢复。
- [ ] 执行 `bun test tests/files.test.ts tests/reconcile.test.ts`，按调用方影响补跑 hook、retention 与 maintenance 测试；不重复已通过且未再改变的检查。
- [ ] 更新文档与 note，执行门禁并提交 `refactor(ingest): commit source evidence and cursors atomically`。

### 收尾

- [ ] 检查 C1.5 的真实读侧状态和迁移范围，记录后续任务与启用前提；C4 保持冻结。
- [ ] 对实现差异进行独立审查；只修证据可确认的行为问题。
- [ ] 运行剩余必要检查，核对阶段提交与用户 WIP，提供按仓库分类的英文 Git commit message。
