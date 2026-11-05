# Agent Note: 容量计数与主线程阻塞回归

Status: implemented

## Problem

2026-11-05 页面卡顿调查确认，容量统计仍有两条同步长扫描。生产 `/api/stats` 等待 13.8 s，轻量 `/api/metrics` 等待 57.7 s；浏览器 JS 与 SVG 的首字节等待约 47 s。服务运行约 10 小时且源码未落后，未做重启对照，不能归因为运行时间过长。

`enforceBodyBudget` 每 30 s 调用同步 `measureStorage`，即使未达到回收线也先全表求和。生产累计 1,064 轮平均 14.9 s。独立只读拆测为 block 3,843 ms、request 骨架 4,466 ms、raw_hook 41 ms、raw_session_event 8,060 ms，合计 16,410 ms。拆测发生在在线库上，缓存与并发 I/O 未受控，不能把合计当作每轮固定时长。

另一条路径是准入后台刷新。`88022f0` 为 F12 补计 `raw_session_event.payload_json`，在 `measureBodyBytesChunked` 中为 WITHOUT ROWID 表增加一次整表求和，再在查询结束后让出事件循环。该查询本身仍阻塞主线程。没有 rowid 不表示不能分页，该表已有 `(file_generation, byte_offset)` 主键；只读 EXPLAIN 确认复合键游标查询走 `SEARCH ... USING PRIMARY KEY`。

历史依据有两部分。[准入量测提案](../2026-11-03-admission-storage-measure-block.md)决定准入分块、回收保留同步精确量测；[F11/F12/F42 修复](2026-11-05-bounded-retention-and-shutdown.md)补了计量来源，却认为新表整表查询只需毫秒。前一决策留下周期长扫描，后一改动扩大了同步执行范围。现有性能用例的 88,000 个 block 只有每行 64 B、52,000 个骨架只有每行 32 B；F12 用例只加 2,048 B 原始载荷，无法覆盖当前约 7.4 GB 文件的读取成本。

本记录部分取代上述两份记录中容量量测的执行方式，保留容量门槛、代际清理、停止规则和写入所有权。派生的 [Worker 只读计算、主线程唯一 writer](2026-11-02-derive-compute-worker.md)仍成立。这里评估容量路径，不声称系统内所有长任务都已完成隔离。

## Decision

在线容量查询改为事务内增量计数。扫描整份历史数据只用于明确的离线初始化与对账，不再由在线 timer、准入请求或容量读取隐式触发。回收判断继续读取当前已提交值，不引入异步快照过期后的删除决策。

schema v14 加 `capacity_meter(source, bytes, row_count)` 与 12 个触发器。四个来源各一行：`block.z`、`request.skeleton_z`、`raw_hook.request_z + response_z`、`raw_session_event.payload_json`。BLOB 用 `length()`；TEXT 先 `CAST(... AS BLOB)` 按 UTF-8 字节计；可空列各自 `IFNULL` 后相加，单边 hook 正文不会被当成 0 或重复计。`block` 一行代表一个共享块，只计一次；`request` 行数表示请求行数，不把 `body_bytes` 累加成全局共享块总量。

触发器只绑定 INSERT、影响载荷的 `UPDATE OF` 列与 DELETE。计数与来源行在同一事务提交、回滚；应用层不各自加减。`PRAGMA recursive_triggers=ON` 让未来误用 `INSERT OR REPLACE` 的隐式删除也触发 DELETE 分支，当前写路径没有使用 REPLACE。普通 INSERT、`INSERT OR IGNORE` 与 `ON CONFLICT DO UPDATE` 各有回归测试。

迁移在单个 immediate 事务里建表、建触发器、从四张来源表回填、核对并推进 `user_version=14`。空库直接建到 v14；v6–v13 的既有原地升级路径都在末尾执行同一段 v14。已有计数只核对不覆盖，半迁移或人为改过的库明确报错。失败整体回滚，`user_version` 停在 13，不留半张计数表。正常重启只校验四行结构与 12 个触发器，不重扫历史。

在线路径读固定的四行。`measureStorage` 的磁盘部分仍是目录扫描、`statfs` 与页计数，正文部分改为四行读取；`createAdmissionGate` 的初始化、TTL 刷新、`invalidate()`、每 30 s 回收判断与批间复测共用这一个事实源。在线分块求和、后台刷新与第二份缓存已删除。`metadataSnapshot` 的 `requestCount`、`raw_session_rows` 与 `raw_session_bytes` 复用同一份计数；其他元数据聚合仍需单独量测，不宣称整个诊断报表都是常数成本。

存量初始化与全量对账是显式动作：

- `bun run maintain capacity-check --db <path>`：只读比较四源计数与全表求和，默认只报告差异，服务运行中可用。
- `bun run maintain capacity-recount --db <path>`：只读预览；`--apply --approval-id <id>` 才在维护锁与停服务条件下用一个事务修正并复核。首版没有在线自动校准。

巡查与监控接入保持各自事实边界：`collectWeekly` 优先读计数，v13 旧库回退全表求和并标记 `meterUsed=false`；`body_ratio` 继续只表示三源正文比例，四源预算总量另出 `body_budget`，历史快照带 `meterVersion`，版本不同时提示不能直接比较。`monitor.ts` 对计数缺失、非法、版本不符或来源数不为 4 单独告警，不在提取指标时补零。`storage.measure` 只度量准入实际执行的同步部分，不反证其它长任务有界。

## 合成实验

2026-11-05 在临时库做了两组探针，代码保存在 `/tmp/atc-capacity-eval-20261105-wAX2e2/`，合成数据库已由脚本清理。没有复制真实数据、修改生产库、重启或部署服务。

第一组为 WITHOUT ROWID 的复合主键表，4,096 行、每行约 64 KiB ASCII JSON，总载荷 256 MiB。每 10 ms 采样主线程并执行一笔微小写入。三种方式求和结果一致：

| 方式 | 总耗时 | 主线程最大采样滞后 | 同时写入探针最大耗时 |
| --- | ---: | ---: | ---: |
| 主线程整表扫描 | 97.1 ms | 96.1 ms | 0.8 ms |
| 主线程按复合主键每批 64 行 | 107.6 ms | 3.6 ms | 0.1 ms |
| 独立只读 Worker，单轮读事务 | 100.1 ms | 1.0 ms | 0.1 ms |

这组顺序测试没有控制冷缓存，不能推出生产 8 s 查询会按相同比例缩短。它验证了执行位置与让出点会改变主线程停顿。

第二组为 2,048 行、128 MiB ASCII JSON，按每批 64 行插入，对照单表三个触发器。无计数插入 349.0 ms，有计数 381.2 ms，单次观察约增加 9.2%；计数读取 1,000 次的平均值为 0.0013 ms。普通插入、重复 IGNORE、upsert 替换、删除和事务回滚的计数断言均通过。这不是四表集成验收，也不代表生产摄入只会增加 9.2%。

## Alternatives considered

**补全主键分块，并把回收判断也异步化。** 复用程度高，合成实验也证明有效。但每轮仍需读取全部历史数据；按行数限制不能约束一条超大 TEXT，也不能保证冷盘下单次同步查询的耗时。回收跨多个快照后还要定义统计误差与删除时机。作为不允许 schema 迁移时的备选，不作为首选。

**增加独立只读容量 Worker，共享测量结果。** 能隔离主线程扫描，沿用已有 Worker 客户端形状也容易；不得塞进派生 Worker，以免容量扫描与派生排队。代价是重复 I/O、单轮长读固定 WAL 快照，以及旧结果用于回收时的过期判断。适合离线方案不足、必须在线全量校准的场景。只加 Worker 而不消除回收中的同步复测并不能完成修复。

**在各适配器手动加减计数。** 旧提案已经指出正文保存、合并、回收与维护路径分散，漏一处就会漂移。SQLite 触发器把不变量放在数据表上，新增适配器复用这些表时自然生效，因此采用计数方案，不采用分散的应用层计数。

**只降低频率、加 TTL、改成 async 或重启。** 会改变停顿出现的频率或时刻，单次同步查询仍然阻塞。原先的异步刷新即是 async 包裹同步 SQL 的反例，不作为修复。

**为长度表达式加索引。** 能减少载荷页读取，但仍全量扫描，且同样需要 schema 迁移与每次写入维护。固定行计数直接回答总量，在线查询成本更明确。

## Verification

日常测试分两层。在线装配的回归在 `tests/capacity-meter.test.ts`：四源计数与全表逐项一致（中文、emoji、TEXT UTF-8 字节、单边 hook、共享块）、upsert/REPLACE/删除/事务回滚后的计数一致，以及通过真实 `createAdmissionGate` 装配拦截 `store.read.query`，证明检查路径只读 `capacity_meter` 与 PRAGMA，不出现四张来源表的 `FROM`。迁移回填与失败回滚在 `tests/store.test.ts`；`tests/retention.test.ts` 验证在线量测与全表求和一致、recount/准入收敛；`tests/maintenance.test.ts` 覆盖只读对账与停服务修正；patrol、monitor、容量快照与轻量指标各自锁定新增字段。

2026-11-05 的显式容量脚本为 `scripts/perf-capacity-meter.ts`。默认合成载荷 1,152 MiB：112 行 × 8 MiB 的 `raw_session_event`（稀疏 `byte_offset`）、64 块 × 2 MiB 共享块、1,024 个请求 × 64 KiB 骨架与 64 个 hook × 1 MiB。一次运行结果：

| 检查 | 实测 |
| --- | --- |
| 在线准入检查（200 次，期间 1 ms 间隔小写入） | 单次 max 0.16 ms，p95 0.11 ms；事件循环 max 1.34 ms |
| 摄入写事务 | 61 笔、1,152 MiB；p95 88.2 ms、p99 95.9 ms、426 MiB/s |
| 无触发器基线（同种子） | p95 98.8 ms、p99 108.2 ms、395 MiB/s；WAL 同为 0.03 MiB |
| 吞吐变化 | 带触发器比基线 +7.8%（单次测量噪声内，未出现 >15% 退化） |
| 触顶回收 `enforceBodyBudget` | 1,143 ms，单次不可抢占；淘汰 1,000 个请求 |
| 单次 `pruneRaw`（整代际 + hook） | 1,000 ms；删除 112 行会话事件、64 行 hook |
| `shrinkStorage` + checkpoint | 2,999 ms |

这组数字说明在线检查已经常量化，也说明保留层的长事务仍然存在：`pruneRaw`、`enforceBodyBudget` 与 `shrinkStorage` 都是不可抢占单元，外层 200 ms 预算不能给它们的有界性背书。F11 的单事务清理、F38/F39 的预算归属没有被本轮解决；生产上曾出现 29.4 s 的 `raw_prune` 写事务，后续拆分候选准备与写入另立批次。

生产部署于 2026-11-05 完成：master `732d281`，停服 bundle 后 v13→v14 原地迁移，pid 12084，启动 7 秒；启动后与 15 分钟真实流量后的两次 `capacity-check` delta 均为 0。随后另一个会话重启部署 Hermes 修复 `3e2209e`，重启后的第三次对账仍为 0。接口、事件循环与残余长尾读数见[验收记录](../../../../docs/acceptance.md#容量计数生产部署真实流量2026-11-05)。

## Consequences

在线容量检查从全表扫描降为四行读取，准入、完整指标与巡查共用同一事实源；计量公式修正了 TEXT 字符数与单边 NULL 的偏差，容量读数与旧版不完全可比，巡查快照用 `meterVersion` 标明断点。

代价是把少量工作移到真实写入事务：每次插入、载荷列更新与删除多维护四行计数。1 GiB 级、行数很少的合成摄入没有观察到超过 15% 的吞吐退化；部署后的 15 分钟窗口没有出现容量路径的秒级停顿，真实高频小事务下的触发器写放大仍缺同形状对照。触发器计数只代表逻辑载荷，不代表 SQLite 页分配、索引、WAL 或文件回收效果，物理磁盘保护仍由既有预算与准入承担。

v14 库不能被 v13 代码打开（`schema_version_unsupported`）。回滚要先恢复 v13 的 bundle，不能直接换回旧二进制；迁移失败会整体回滚，库保持 v13 可重新启动。存量初始化与对账本身仍要扫描历史，耗时随库规模与缓存变化，安排在显式维护窗口，不承诺固定停机时长。
