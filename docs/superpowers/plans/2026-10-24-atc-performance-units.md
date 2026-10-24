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

已提交 `3870eea`；派生、切片、启动与维护六文件 126 项测试通过。同步组事务提取保留了离线批事务回滚用例。

**Files:** 新建 `src/derive-unit.ts`、`tests/derive-unit.test.ts`；修改 `src/derive.ts`、`src/derive-slice.ts`、`src/main.ts`、`tests/derive-slice.test.ts`、架构设计与相关 Agent Note。

**Interfaces:** 消费 `drainRequestPurposesTx`、同步组派生和切片阶段机；产出 `createDeriveUnit(store).run({budgetMs}) → {didWork,nextDueMs}`。维护和容量实验的 `drainDeriveEntry` 保留完整计数返回值。

- [x] 添加空闲零事务用例：记录 `writeStats.count`，调用工作单元，断言计数不变且 `didWork=false`。
- [x] 添加预算停止用例：合成多个独立组，在组提交后让计时超过预算，断言已完成组保留、其余仍 dirty，下轮可继续。
- [x] 添加故障恢复用例：第二组确认触发 SQL 错误，重开库后第一组 clean、第二组 dirty，移除故障后继续完成。
- [x] 实现用途小批事务、同步每组事务和组间预算检查；每轮最多 10 个组，默认 400 ms。每个组的链、角色、工具、摘要与 CAS 不可分割。
- [x] 让切片完整流程测试调用调度入口；阶段专项测试可直接调用对应阶段，避免完整流程复制阶段次序。
- [x] 在线 tick 按 `nextDueMs` 安排后续调用，积压时让出事件循环；停止时取消定时器。
- [x] 执行 `bun test tests/derive-unit.test.ts tests/derive.test.ts tests/derive-slice.test.ts tests/main.test.ts tests/capacity-slice.test.ts`；同步维护共享实现时补跑 `tests/maintenance.test.ts`。
- [x] 更新组事务与崩溃语义：已完成组保留；未完成同步组回滚；启动恢复丢弃未发布切片代。写明同步单大组仍可能超过预算。
- [x] 运行 note 门禁并提交 `perf(derive): bound online work and commit groups independently`。

### Task 2: 具名提交与空闲判断

已提交 `9f36f50`。

合成验收：`bun scripts/perf-work-units.ts`，120 s 稳态写事务增量 0；100 组共 800 笔积压期间 hook 80/80 成功，投递最大 21.9 ms，derive job 最大 68.1 ms，具名派生事务最大 3.45 ms。实验第一次因临时根前缀错误被隔离断言拒绝，修正后重跑成功；不将第一次启动失败算作性能采样。真实采集器仅只读采样，writer 累计最大 1911.5 ms，未发布或重启。

**Files:** 修改 `src/store.ts`、`src/capacity.ts`、`src/main.ts`、`src/hook.ts`、`src/retention.ts`、`src/sources/magpie.ts`、对应窄测试、架构设计；新增提交单元 Agent Note。

**Interfaces:** 存储层接收具名写意图与只读准备函数，准备返回无操作时不打开事务；`writer` 保留累计计数并增加按名统计。

- [x] 在存储测试中覆盖空准备零事务、具名成功和具名回滚都计数，异步事务仍拒绝。
- [x] probe 只在探测结果变化时写；pending 没有可合并或新歧义时不写；gap 状态不变时不写；raw_prune 没有到期候选时不写。
- [x] cost 在请求和校验页成功后提交进度，失败前不单独写窗口重置；相同空页不重复提交。保留费用冲突整页回滚与独立健康记录。
- [x] 有积压的 pending、gap、raw_prune 使用有界候选批次，提交归属名出现在 `/api/ingest-metrics`。
- [x] 执行 `bun test tests/store.test.ts tests/hook.test.ts tests/retention.test.ts tests/magpie.test.ts tests/capacity.test.ts tests/main.test.ts` 与 `bun run typecheck`。
- [x] 在隔离合成采集器中采样 120 s 稳态写事务，区分启动写入与窗口增量；保留真实采集器聚合基线，不重启真实进程。
- [x] 更新架构设计与 note，执行 note 门禁并提交 `perf(store): skip idle commits and attribute writer time`。

### Task 3: 原子文件摄入

**Files:** 修改 `src/sources/files.ts`、`src/reconcile.ts`、`src/main.ts`、`tests/files.test.ts`、`tests/reconcile.test.ts`；更新架构设计和摄入 Agent Note。

**Interfaces:** `ingestSource` 接收统一来源读取结果；追加 jsonl 与封口 gzip 各自适配到同一游标与提交流程。证据映射的事务内函数由既有公共入口复用。

- [x] 添加路由批仅一个事务与坏行、记录、游标共同回滚的用例，失败后同内容可重读重记。
- [x] 添加路由与账本共享的同代同 rewrite_epoch 偏移不回退用例，换代或重写可归零。
- [x] 统一 cursor upsert，删除 `fileCursorOf` / `routeCursorOf`，保留 gzip 整体指纹和半行不推进。
- [x] 将在线 ledger/route 调度接入统一摄入入口；暂停与缺口逻辑保持可恢复。账本显式保留 `usage.jsonl` 身份，稳定半行不重复写观察位置。
- [x] 执行 `bun test tests/files.test.ts tests/reconcile.test.ts`，按调用方影响补跑 hook、retention 与 maintenance 测试；不重复已通过且未再改变的检查。在线接线后 main、reconcile、retention、maintenance 共 81 项测试通过。
- [x] 更新文档与 note，执行门禁并提交 `refactor(ingest): commit source evidence and cursors atomically`（`40fa2ad`）。C3 读取与摄入测试在子任务中 49 项通过，扩展旧调用方后 98 项通过；父线程在线集成后 81 项测试与全库 typecheck 通过，Agent Note 与差异格式检查通过。

### 收尾

- [x] 检查 C1.5：查询、会话标题与 reading token 已有发布代读取，`tests/queries.test.ts`、`tests/reading.test.ts`、`tests/http.test.ts` 通过；交接对迁移范围的描述过时。生产开关继续冻结，后续核验实际切片发布后的读侧完整性、算法切换和长组容量，不能仅据读代测试解除启用限制。C4 保持冻结，右栏虽已出现新提交，后续阅读修复仍在进行。
- [x] 对实现差异进行独立审查；C1/C2 未发现可复现的正确性缺陷。审查方补跑工作单元与存储 20 项回归，并用临时合成探针核验未发布切片的重开恢复与 Bun 嵌套事务行为；C3 由父线程核对记录语义、调用方和最终接线。
- [x] 运行剩余必要检查，核对阶段提交与用户 WIP，提供按仓库分类的英文 Git commit message。阶段提交为 `3870eea`、`9f36f50`、`40fa2ad`；工作区剩余的阅读角色提案、计划、旧 note 反向链接与页面改动属于另一条工作线，未纳入本任务。生产切片与 C4 的冻结未改变，5 rps 目标仍未重新验收。
