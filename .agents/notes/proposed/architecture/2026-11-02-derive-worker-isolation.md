# Agent Note: 派生移出主线程：Worker 隔离与写锁归属

Status: proposed

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

## Proposal

把派生从主线程移到一个 Bun Worker：Worker 打开同一个 WAL 库，跑既有入口 `drainDeriveEntry`，主线程只保留采集、HTTP 与读路径。算法与事务边界都不动——[组内原子性](../implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md)与[按组提交的预算调度](../implemented/architecture/2026-10-24-budgeted-derive-unit.md)照旧成立，改的只是这些事务在哪个线程执行。

合成长链四场景已验证可行（`bun scripts/perf-derive-worker.ts --requests 800`，800 笔累积链，临时库）：

| 场景 | 派生耗时 | 事件循环 lag max | 读探针 max | 写探针 max | 写被拒 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 主线程同步派生（基线） | 780.9 ms | 771.8 ms | 0.8 ms | 0.1 ms | 0 |
| Worker 派生，主线程只读 | 759.3 ms | 1.4 ms | 0 ms | — | — |
| Worker 派生，主线程写等待锁（`busy_timeout=5000`） | 776.9 ms | 833.9 ms | 0 ms | 834.6 ms | 0 |
| Worker 派生，主线程写不等待（`busy_timeout=0`） | 795.1 ms | 1.9 ms | 0 ms | 0.9 ms | 38/40 |

三条结论：

1. 计算搬出主线程后，主线程事件循环不再被派生占住（lag max 1.4 ms 对基线 771.8 ms），只读路径读数不变。这印证了阻塞源是主线程 CPU 时间，不是 SQLite 锁——WAL 下读者本来就不被写者阻塞。
2. 收益完全取决于主线程写是否等待 Worker 的写锁。等待会把锁等原样转成事件循环阻塞（lag max 833.9 ms，与不隔离持平）；不等待则事件循环保持毫秒级，代价是这段时间里主线程写基本全被拒（38/40）。
3. 因此正式实现要一起定的是写锁归属，不是只挪执行位置。两条候选：

- **W1：Worker 成为唯一 writer。** 沿用[架构设计](../../../../docs/architecture-design.md#系统边界与进程模型)的「写操作全部走一个 writer」，主线程的写经消息投递给 Worker 执行。保留写者不变式，读连接不迁移；代价是 hook ingest 的 200 应答要等长组事务结束，确认语义得重排。
- **W2：主线程保留 writer，Worker 的组事务忙则不等。** Worker 用 `busy_timeout=0`，拿不到锁就放弃本轮，靠下一 tick 重试。derive 本来就是 tick 驱动、状态持久化的幂等轮次（dirty 组不因放弃而丢），重试代价低；但 hook 摄入不能靠 tick 重试，必须给它一条明确的「拒绝即可重试」契约，并把这个计数纳入观测。

还有一个未测的分界，决定 W1 与 W2 谁更划算：把组事务的**计算**与**写库**分开测。若写库本身短，就会出现第三条路——Worker 只算（只读连接、不持写锁），主线程提交短事务，也就是[交互延迟第一轮](../bug-fix/2026-11-01-collection-interactive-latency.md#deferred)提到的长事务方向的落点；那时两边不争写锁，「写操作全部走一个 writer」这条不变式也不用改。

插桩已落地：`writer.by_name.derive.sql` 给出累计的读语句、写语句、事务体与事务开合四段。只有派生名下的写事务代理语句计时（`src/store.ts` 的 `TIMED_WRITES`），其余短事务写路径不引入开销。写库占比由 `write_ms` 与 `txn_ms` 给出；纯计算由 `fn_ms` 减掉两条语句耗时得到。真实流量读数与结论补齐后回填本节。

## Alternatives considered

**直接启用已有切片路径。** 已实测否决：长链上总耗时放大 16.4×–67.2×，不满足启用门槛，且每步 250–279 ms 仍会打断事件循环。切片作为阶段化实现保留，不是本轮手段。

**事务瘦身但不动线程。** 把读与计算移出写事务、用 revision 守卫提交，理论上直接消掉长事务。未实测，且要在主线程上继续做同样的重算，收益上限受限于单线程 CPU 占用；它是上面「计算与提交分开测」的对象，不与 Worker 互斥。

**派生限频或静默合并。** 只降低阻塞频率，不改变单次阻塞形态；真实负载下每笔新请求都会让整组重算，限频等于接受结果陈旧。作为运行时参数保留，不作为治理手段。

**主线程写继续等待锁。** 等价于没有隔离（见场景三），收益为零，弃。

## Acceptance criteria

1. 派生运行期间事件循环不再出现派生同量级的停顿：`event_loop` 的 p99 与 13 s 级 max 与 `writer.by_name.derive` 的单次耗时解耦。
2. 派生追平能力不退化：`derive_queue` 不出现长期 dirty 组（`oldest_dirty_age_ms` 回到秒级），目标组 `input_revision == published_revision`。
3. 写规则落到文档并可见：被拒写的计数、重试路径、最坏情况下哪些写会作废，写进[架构设计](../../../../docs/architecture-design.md)与[运维手册](../../../../docs/operations.md)。
4. 崩溃与关闭有定义：Worker 在事务中被终止后重启，组状态不半发布，读侧仍只读已发布代；`bun run service stop` 等当前组落盘。
5. 合成与真实分开验收，真实验收必须覆盖一个含长组的真实流量窗口；合成读数不替代。

## Risks

- **hook 摄入的确认语义是硬约束。** Worker 长事务期间主线程写几乎全灭（spike 38/40 被拒）。若不能定义「拒绝即可重试」，就必须走 W1，或让 Worker 在提交前让锁——否则是拿丢数据换延迟。
- **Bun Worker 与 `bun:sqlite` 的跨线程行为覆盖极窄。** 现有证据来自本机合成库、单组、无并发摄入的 spike：Worker 崩溃恢复、WAL checkpoint 与主线程关闭顺序、维护任务替换库文件，都没覆盖。
- **读侧代际要对齐提交边界。** 读路径按 `published_generation` 读已发布代，Worker 若在发布指针写入前后被终止，边界必须与现有恢复语义一致；这是实现时首先要写的测试。
- **多 Worker 不承诺。** 多会话并行派生会放大写锁竞争与公平性问题；本提案只说单 Worker 串行，扩面另议。