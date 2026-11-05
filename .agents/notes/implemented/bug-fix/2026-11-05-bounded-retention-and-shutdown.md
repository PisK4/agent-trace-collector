# Agent Note: 有界保留清理与可靠停止

Status: implemented

## Problem

2026-11-04 巡查清单（[open-bug-findings](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)）的三条保留层与停止项，本批一并处理：

- **F11** raw 层 7 天 TTL 实际未生效：每小时一个 tick、每批各表 100 行，五张按行删的 raw 表每表每天最多清 2,400 行，低于日增量（hook 2,141–7,436、ledger 2,333–8,092、otlp span 单日 150,603），超期存量合计 5.6 万行以上持续累积。清单原建议「循环到空」；Pis 于 2026-11-05 定案**性能优先、不能阻塞主线程**——一次性循环到空会在主线程制造长写事务与 WAL 尖刺，本批不采纳，改为有界分批。
- **F12** 清单条目已部分过时：v12 已把 `raw_droid_event` 改名为 `raw_session_event`（`src/schema-v12.sql`），且代际清理分支已在 coverage-foundation 一批加入 `pruneRaw`（孤儿代际与封口代际可清、追加代际保留重放）。**仍然成立的只剩半边**：`measureBodyBytes` 与 `BODY_SUM_SOURCES` 只算 `block` + `request.skeleton_z` + `raw_hook`，`raw_session_event` 的 `payload_json` 不计入 body 预算。
- **F42** SIGTERM 停止无上限也无 `catch`：`stop()` 里 `await deriveLanded` 没有超时（注释自认「等待没有上限」），`stop().then(() => process.exit(0))` 没有 `.catch`，派生永不落盘或关闭步骤抛错时进程不退出；`store.close()` 不做 `wal_checkpoint(TRUNCATE)`，正常退出后 `-wal` 留 4.2 MB 待回放。

动笔前的 supersession check：implemented 树里与此最接近的两篇是 [coverage-foundation](../feature/2026-11-04-coverage-foundation.md)（持有 `raw_session_event` 按代际清理的语义，本批原样保留该语义、只补计量，不取代）与 [service-lifecycle-commands](../process/2026-10-26-service-lifecycle-commands.md)（持有 `bun run service stop` 的 30 s 轮询口径，本批的进程内上限与其对齐、互为补充）。没有既有 note 持有 body 预算构成或停止等待上限的决策，无完全取代；[封口分块](2026-11-04-sealed-ingest-chunking.md)立下的「不制造长写事务」约束是本批 F11 取舍的直接前提。

## Decision

- **F11：`pruneRaw` 之上的有界 drain。** 新增 `pruneRawBounded`：循环调用单批的 `pruneRaw`，每批仍是各表 `LIMIT 100`、独立提交的 `raw_prune` 写事务；批间用 `setImmediate` 让出事件循环（复用计量分块的同一原语）；单次调用到 **200 批**或 **200 ms 墙钟**即停，先到为准。吞吐账：每小时一个 tick × 200 批 × 100 行/表 ≈ 2 万行/表/时，覆盖 otlp span 峰值日 150,603 行（约 6,300 行/时）还有 3 倍余量。`RAW_PRUNE_INTERVAL_MS` 保持 1 h——单轮多批已覆盖日增量，更高频率只是增加空转检查。`raw_session_event` 的按代际分支不受批数上限约束的语义不变，它本来就在同一个单批事务里按代际整批删。
- **F12：body 计量纳入 `raw_session_event`。** `measureBodyBytes` 与 `BODY_SUM_SOURCES` 增加 `length(payload_json)` 一项，注释写明该表是「追加转录的当前代际原始行，按代际清理、计入可回收字节」。该表是 WITHOUT ROWID，没有 rowid 可分块，`measureBodyBytesChunked` 对它整表一次求和（当前量级毫秒级）；不加逐行 TTL。
- **F42：停止的三处加固。** `stop()` 对 `deriveLanded` 的等待包 `Promise.race` 上限，常量 `STOP_DERIVE_WAIT_MS = 30_000`，与 `bun run service stop` 的 30 s 轮询对齐；超时只是不再等，不取消在飞的计算（`deriveUnit.run` 的预算不动），随后照常 `deriveWorker?.close()` → `server.stop` → `store.close()`。`onSignal` 加 `.catch`：停止失败记一行结构化日志并以 `process.exit(1)` 退出，不再停在半关状态等 launchd 补 SIGKILL。`store.close()` 在关闭连接前做一次 `wal_checkpoint(TRUNCATE)`，忙或失败只记一行 stderr JSON，不阻塞退出。为验收新增两个测试注入点：`CollectorOptions.deriveCompute`（替换派生计算，优先于 Worker）与 `CollectorOptions.stopDeriveWaitMs`（缩短停止等待上限），缺省值只在生产与显式启动生效。

## Alternatives considered

- **F11 一次调用循环到空（清单原建议）**：落选。5.6 万行存量一次删完等于把五张表的清理压进一个长写事务，重演封口分块之前的 6.17 s 写事务与 WAL 尖刺；与「性能优先、不能阻塞主线程」直接冲突。
- **F11 提高 `RAW_PRUNE` 频率或加大单批行数**：落选。频率加密解决不了「单批 × 频率仍小于日增量」的算术（2,400/日 vs 15 万/日的峰值），只有把单轮吞吐提上去才有用；加大单批（如 2,000 行/表）则回到长事务老路。
- **F11 把 `pruneRaw` 本体改成 async 内部循环**：落选。要动 9 处既有调用点并重定义 `limit` 参数语义，而单批契约已被既有测试锁定；有界 drain 作为独立包装，单批语义与全部既有测试原样保留。
- **F12 给 `raw_session_event` 加 7 天逐行 TTL**：落选。追加文件的重放需要当前代际的完整原始行，逐行过期会把活跃代际打穿、破坏批次间重放；按代际清理是 coverage-foundation 定下的语义，本批不动。
- **F42 SIGTERM 直接 `process.exit(0)`、不等派生**：落选。会把在飞的计算丢掉、并在 Worker 仍持连接时关闭库；保留有上限的等待，失败路径走非零退出。
- **F42 checkpoint 放在 `main.ts` 的 `stop()` 里**：落选。`store.close()` 是服务、维护脚本与测试共用的关闭点，放在那里所有路径同样免回放，main 不复制关闭语义。

## Consequences

- 有界清理把超期存量从「一次性清空」改为「多轮收敛」：存量大的首轮按 ≤2 万行/表/时的速率回收，约 1–3 个 tick 清完；运维需连续观察数轮 `/api/ingest-metrics` 的 raw 计数，验收口径是「连续多轮后超期计数持续下降直至归零」，不能按单次调用是否归零判断。
- admission 的正文读数从此包含 `raw_session_event` 的 payload（当前约 103 MiB）：`body_budget` 触发线会更早算上这部分字节，而正文淘汰本身释放不了它，要等代际清理。F38 的「可回收/不可回收」口径重构另行处理，本批不碰 F39 的 diskTight 目标，也不砍 `deriveUnit.run` 的计算预算。
- 停止等待有上限后，超时的那一轮派生会被 Worker close 丢弃，日志出现 `derive_worker_closed` / `derive.run` failure：这是如实报告（组仍 dirty，重启后重建），不是静默丢失。
- `store.close()` 对所有调用方做 checkpoint：正常停止后数据目录的 `-wal` 为 0 B，重启免去回放；checkpoint 忙或失败只记一行结构化日志，不影响退出。

## Related

[容量计数与主线程阻塞回归](2026-11-05-capacity-meter-main-thread-regression.md)复核 F12 整表量测和 F11 单批耗时的生产风险并交付 v14 计数；本记录的代际保留与停止语义仍适用。

## Testing

- `tests/retention.test.ts`「有界清理分批独立提交、批间让出，连续调用收敛到零」：620 行超期 span、`maxBatches=2` 的合成种子——单次调用删 200 行停手、两次独立的 `raw_prune` 写事务、批间 `setImmediate` 链获得执行机会、4 次调用共 7 个写事务后累计删除等于种子行数且超期计数归零。
- `tests/retention.test.ts`「body 计量纳入会话原始层 payload，分块求和与同步版一致」：插入 2,048 B 的 `raw_session_event` payload 后同步计量恰好多出 2,048，分块路径对该 WITHOUT ROWID 表整表求和的结果与同步版一致。
- `tests/main.test.ts`「派生永不落盘时 SIGTERM 在等待上限内退出」：子进程（`tests/stop-hang-child.ts`）注入永不返回的派生计算与 1 s 停止上限，父进程在 ready 后发 SIGTERM——进程以退出码 0 在上限内自行退出；没有上限的旧实现永远不会走到断言。ready 在 `startCollector` 返回后才发：此刻信号处理器已注册、首轮派生已同步进入计算并挂住，避免信号落在注册前触发默认终止（第一版子进程实测退出码 143 的教训）。
- `tests/store.test.ts`「正常关闭把 WAL 截断到 0，重启免回放」：一笔写入留在 WAL 后关闭，`-wal` 从非 0 变为 0 B。
