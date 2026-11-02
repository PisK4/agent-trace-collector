# Agent Note: 派生移出主线程：Worker 只算与主线程落库

Status: implemented

## Problem

在线派生跑在 Bun 唯一的事件循环上，一组一个不可中断的写事务：链匹配、正文读取、工具配对与摘要都在事务里完成。主会话组 1,502 笔，每来一笔新请求就整组重算，单次事务可到十几秒。

生产实测（pid 12759，最近 15.6 分钟窗口，`GET /api/ingest-metrics`）：

| 读数 | 值 |
| --- | ---: |
| `writer.by_name.derive` | 240 次 / 495.0 s（写事务总耗时 500.7 s 的 98.9%），单次 max 13.3 s |
| 其余全部命名写（hook、cost、pending、ledger、route…） | 447 次 / 5.7 s |
| `event_loop`（50 ms 采样） | p50 1.02 ms、p95 30.8 ms、p99 645.8 ms、max 13,777 ms |
| `ingest` | 到达 278 次，其中 61 次以 `busy` 429 被拒 |

被占住的不只是页面读。hook 摄入走同一事件循环，`src/http.ts` 的 `ingesting` 单飞守卫在有摄入在飞时直接回 429 `busy`——派生阻塞期间到达的 hook POST 就是这样被拒的。这条通道今天已经在丢请求，不是隔离方案新引入的风险。

已经试过的两条路：切片路径实现完整但容量实验否决（合成长链 300 笔 16.4×、800 笔 67.2×，每步约 250–279 ms，见[切片长组容量实验](../../../../docs/acceptance.md#切片长组容量实验合成2026-11-02)）；费用扫描的长耗时已由[头部增量](../../implemented/bug-fix/2026-11-02-cost-sync-incremental-window.md)单独治理。剩下的是执行位置与事务形状，本提案处理前者。

## Decision

把派生的算与写分开挪位：计算（读语句与纯 JS）离开主线程与写锁，落库只保留今天的写语句与 CAS 守卫。算法与组内一致性规则不动——[组内原子性](../../implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md)与[按组提交的预算调度](../../implemented/architecture/2026-10-24-budgeted-derive-unit.md)照旧成立，改的是计算在哪个线程跑、事务包住哪一段。

先做过合成长链四场景探针（旧 `scripts/perf-derive-worker.ts`，800 笔累积链，临时库）：

| 场景 | 派生耗时 | 事件循环 lag max | 读探针 max | 写探针 max | 写被拒 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 主线程同步派生（基线） | 780.9 ms | 771.8 ms | 0.8 ms | 0.1 ms | 0 |
| Worker 派生，主线程只读 | 759.3 ms | 1.4 ms | 0 ms | — | — |
| Worker 派生，主线程写等待锁（`busy_timeout=5000`） | 776.9 ms | 833.9 ms | 0 ms | 834.6 ms | 0 |
| Worker 派生，主线程写不等待（`busy_timeout=0`） | 795.1 ms | 1.9 ms | 0 ms | 0.9 ms | 38/40 |

三条结论：

1. 计算搬出主线程后，主线程事件循环不再被派生占住（lag max 1.4 ms 对基线 771.8 ms），只读路径读数不变。这印证了阻塞源是主线程 CPU 时间，不是 SQLite 锁——WAL 下读者本来就不被写者阻塞。
2. 收益完全取决于主线程写是否等待 Worker 的写锁。等待会把锁等原样转成事件循环阻塞（lag max 833.9 ms，与不隔离持平）；不等待则事件循环保持毫秒级，代价是这段时间里主线程写基本全被拒（38/40）。
3. 因此正式实现要一起定的是写事务边界与写锁归属。原以为要在两条路里二选一：

- **W1：Worker 成为唯一 writer。** 沿用[架构设计](../../../../docs/architecture-design.md#系统边界与进程模型)的「写操作全部走一个 writer」，主线程的写经消息投递给 Worker 执行。保留写者不变式，读连接不迁移；代价是 hook ingest 的 200 应答要等长事务结束，确认语义得重排。
- **W2：主线程保留 writer，Worker 的写事务忙则不等。** Worker 用 `busy_timeout=0`，拿不到锁就放弃本轮，靠下一 tick 重试。derive 本来就是 tick 驱动、状态持久化的幂等轮次（dirty 组不因放弃而丢），重试代价低；但 hook 摄入不能靠 tick 重试，必须给它一条明确的「拒绝即可重试」契约，并把这个计数纳入观测。

决定 W1 与 W2 谁更划算的是组事务里**计算**与**写库**的比例：写库本身短，就会出现第三条路——Worker 只算（只读连接、不持写锁），短事务落库，也就是[交互延迟第一轮](../../implemented/bug-fix/2026-11-01-collection-interactive-latency.md#deferred)提到的长事务方向的落点；那时两边不争写锁，「写操作全部走一个 writer」这条不变式也不用改。

这个比例已用真实流量测出（`writer.by_name.derive.sql`，565.0 秒窗口、78 组，读数细节见[验收记录](../../../../docs/acceptance.md#派生写事务语句级拆分生产读数真实流量2026-11-02)）：读语句 40.2%、纯计算 51.4%、写语句 5.6%、事务开合 2.8%。写库段（写语句加事务开合）合计 8.4%，最长一组 13.35 s 里推算约 1.1 s。九成以上的时间不在写锁上，所以第三条路提为首选，W1 与 W2 降为落库段仍然过长时的备选。

接缝本身已交付，见[派生算/写接缝](../../implemented/architecture/2026-11-02-derive-compute-apply-seam.md)：同步路径现在是只读计算加短事务落库，计算与落库之间的窗口由队列交换守卫收口。

落地选择第三条路：Worker 只算、主线程落库。`src/derive/worker-entry.ts` 在计算线程里打开同一份库的只读连接（`readonly:true`、`query_only=ON`、`busy_timeout=1000`），跑 `computeDeriveGroup` 并把 `ApplyPlan` 与读数交回；`src/derive/worker.ts` 是主线程侧客户端，懒启动、按 id 匹配回复、同一时刻只允许一个在飞请求（第二个以 `derive_worker_busy` 拒绝，与 `guard` 的防重入一致）。`createDeriveUnit` 的 `compute` 选项注入执行位置：在线注入 Worker，维护、回填与容量脚本不传，留在主线程用 `store.read`。回退开关是 `CollectorOptions.deriveComputeInWorker: false`，关闭即回到主线程计算。

落库窗口的写策略不变：主线程仍是唯一 writer，写连接 `busy_timeout=1000`，没有新增重试层。落库失败让这一轮抛错、组保持 dirty，下一 tick 整组重算；上一组已提交的产物不受影响。计算线程崩溃（`onerror`）时客户端终止实例、拒绝在飞请求并置空引用，下一 tick 重建；因为计算不写库，崩溃不会留下半发布的组。`stop()` 先等在飞的那一轮把当前组落库（`deriveLanded`），再关线程与库，`service stop` 因此等得到当前组。

插桩形态：`TIMED_WRITES` 只列派生名下的写事务，由语句代理累计四段耗时（`src/store.ts`）；接缝之后这个事务只覆盖落库段，其余短事务写路径不引入代理。

落地步骤、文件范围与逐任务验收见[派生算/写接缝实施计划](../../../../docs/superpowers/plans/2026-11-02-derive-compute-apply-seam.md)。接缝的跨段契约是 `ApplyPlan`：链关系、角色、工具行、后台作业行与展示列值五组写操作，加上 `group_epoch` 与 `input_revision` 两个守卫字段；计算段只读，落库段一个事务执行计划并在 CAS 失败时整轮丢弃。

## Alternatives considered

**直接启用已有切片路径。** 已实测否决：长链上总耗时放大 16.4×–67.2×，不满足启用门槛，且每步 250–279 ms 仍会打断事件循环。切片作为阶段化实现保留，不是本轮手段。

**只在主线程做事务瘦身。** 把读与计算移出写事务、用 revision 守卫提交，写锁占用同样是 8.4%。计算留在主线程等于让 51.4% 的纯计算继续占住事件循环，阻塞只减轻不消除；所以瘦身要与 Worker 一起做，单独做不成立。

**派生限频或静默合并。** 只降低阻塞频率，不改变单次阻塞形态；真实负载下每笔新请求都会让整组重算，限频等于接受结果陈旧。作为运行时参数保留，不作为治理手段。

**主线程写继续等待锁。** 等价于没有隔离（见场景三），收益为零，弃。

## Consequences

合成长链两场景读数（`bun scripts/perf-derive-worker.ts --requests 800`，同一脚本改成「Worker 计算 + 主线程落库」两场景；仅计计数与毫秒，临时库）：

| 场景 | 派生耗时 | 事件循环 lag max | 读探针 max | 写探针 max |
| --- | ---: | ---: | ---: | ---: |
| 主线程同步派生（基线） | 869.2 ms | 861.0 ms | 1.0 ms | 0.3 ms |
| Worker 只算 + 主线程落库 | 793.0 ms | 1.8 ms | 0.0 ms | 2.8 ms |

派生耗时差异在噪声内，事件循环 lag 从 861.0 ms 降到 1.8 ms；两场景处理同一组后队列都是 `state='clean'`。生产窗口的 p99 与 max 是否与 `writer.by_name.derive` 单次耗时解耦，按真实流量验收判，合成读数不替代。

代价与未覆盖项：

- 落库段仍持有写锁，最长一组推算约 1.1 s；在线路径下争这把锁的只有同进程其它写任务，它们共用同一 writer 排队。Worker 不写库，所以这条约束没有变成跨线程的等待或拒绝策略。
- 算与写的接缝本身是新增复杂度：落库携带计算期读到的旧值（标题、摘要、配对关联、前驱关系），期间到达的新输入由 CAS 守卫挡住并重试本轮。这层边界没有现成实现，切片路径的放大效应说明改写阶段划分很容易把重复工作带进来。
- 计算段的解码每次重来：窗口内 68,060 次消息块解码，命中数为 0，每次都是冷解码；[派生正文重复解压修复](../bug-fix/2026-10-26-derive-body-decompression-amplification.md)是能独立压掉的一段计算，与本条并行。
- Bun Worker 与 `bun:sqlite` 的跨线程行为覆盖极窄：现有证据来自本机合成库、单组、无并发摄入；Worker 崩溃恢复、WAL checkpoint 与主线程关闭顺序、维护任务替换库文件都没覆盖。
- 读侧代际不受影响：计算线程不写发布指针，指针写入仍在主线程的落库事务里。
- 多 Worker 不承诺：多会话并行派生会放大写锁竞争与公平性问题；本条只说单 Worker 串行。

## Testing

- `tests/derive-worker.test.ts`：同一合成组在主线程与 Worker 两条路径上逐表一致（`request`、`tool_call`、`derive_queue`）；计算线程打不开库时这一组保持 `dirty`、`prev_relation` 一行未写。
- `tests/derive-unit.test.ts`、`tests/derive-slice.test.ts`、`tests/capacity-slice.test.ts`、`tests/commit-unit.test.ts` 随入口异步化更新，覆盖预算截断、组数上限、第二组失败回滚与两条路径等价。
- `bun scripts/perf-derive-worker.ts --requests 800` 是显式动作，不进测试套件。