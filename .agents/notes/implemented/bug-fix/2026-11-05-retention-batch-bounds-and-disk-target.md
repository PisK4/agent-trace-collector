# Agent Note: 保留清理的单批边界与磁盘回收目标

Status: implemented

## Problem

[11-04 开放缺陷清单](../../proposed/bug-fix/2026-11-04-open-bug-findings.md) 的 F11 与 F39 在上一批之后仍有实质缺口。

**F11** 上一批已把 `pruneRaw` 包成「多批 + 批间让出」，但每条边仍不成立：`raw_session_event` 的代际分支在一个写事务里整代际 `DELETE`，行数与载荷都不受单批上限约束；候选准备一次扫全表，`pruneRawBounded` 每批还会重复准备；载荷长度只在删除后才统计，无法在建事务前截断；在线增量 vacuum 虽有轮数上限，缺少批间墙钟停止条件。生产只读基线（uptime 7.46 h）里 `raw_prune` 计数 7、最长一次 **156,896 ms**，说明外层分批并没有把最慢同步单元压下来。

**F39** `enforceBodyBudget` 的磁盘分支复用了正文预算的 `bodyBudget × 0.9` 作为退出条件：磁盘到 80% 后每 30 s 淘汰 100 条正文，直到正文历史被清空也可能降不到目标线。空闲页先收、目标是否可达、逻辑载荷与物理分配的区别都没有进入判断。

这两项都不要求 schema 变更、新 writer/常驻 worker，也不该给长期表加 TTL。

## Decision

**单批清理有明确边界。** 候选在调用开始时一次性准备，只取键，不取 payload；每张表最多 `limit` 条，没有索引可排序的表不加 `ORDER BY`。会话表按主键 `(file_generation, byte_offset)` 逐代际 seek，不再 `SELECT DISTINCT` 全表扫描；进程内游标按 `store.read` 对象隔离，取满换代际时停在代际之前，下一轮续取同一代际，到末尾回卷；单次准备最多 seek 4,096 个代际，超出的留给下一轮，避免大量活跃代际把死代际饿死。

写事务里逐行先取 `length(CAST(... AS BLOB))` 再决定删不删：每张表既受行数上限，也受 `PRUNE_PAYLOAD_BUDGET_BYTES = 4 MiB` 截断。首行总是处理，因此单条超大行不可切分，是明确残余，不宣称每个同步单位严格墙钟有界。route 与 hook 的删除条件在写事务里重新确认，避免准备后新建的引用被误删。

**在线清理只做有界循环。** `pruneRawBounded` 只准备一次候选，每批是独立的小 `raw_prune` 事务，批间让出事件循环，受 `PRUNE_MAX_BATCHES = 200` 与 `PRUNE_WALL_BUDGET_MS = 200` 限制。准备阶段本身可能超过墙钟预算，所以首批无条件执行：否则每个 tick 都在未删任何行时退出，永远不推进。单批事务仍是同步执行，「不阻塞」指限量后耗时短，不是可抢占。

**物理收缩有显式上限。** `shrinkStorage` 按轮数（`SHRINK_MAX_ROUNDS = 32`）、每轮页数（`SHRINK_PAGES_PER_ROUND = 256`）与批间墙钟（`SHRINK_WALL_BUDGET_MS = 500`）停止；checkpoint 受连接 `busy_timeout` 约束，忙时如实返回 `busy`。

**磁盘压力有独立目标。** 触发仍是 `diskLimit × 0.8`，目标改为 `diskLimit × 0.75`（`DISK_EVICT_TARGET_RATIO`），与暂停后恢复正常的回落线一致。触顶后先 `incremental_vacuum` 收空闲页并重测；若已回到触发线以下且正文未满，直接收手。仍紧时用「空闲页字节 + `capacity_meter` 里 block/request 的可淘汰逻辑字节」判断缺口能否补齐；不够就停止为磁盘压力淘汰，正文预算仍独立执行。够时只按缺口淘汰，累计已释放逻辑字节达标即停。

**回收统计修正。** `evictOldestBodyBatch` 先删本批 `request_block` 引用，再统计真正失去最后一个引用的块字节，`releasedLogicalBytes` 从此包含独占块；仍被其他请求引用的共享块不计。

新增/变更的对外签名：

```ts
export function pruneRaw(store, beforeMs, limit = 100, payloadBudget = 4 * MiB): PruneResult
export async function pruneRawBounded(store, beforeMs, budget?: PruneBudget): Promise<PruneResult>
export function enforceBodyBudget(store, dataDir, limits, hooks, budget?: RetentionBudget): number
export function shrinkStorage(store, budget?: ShrinkBudget): ShrinkResult
export function capacityMeterEvictableBytes(db): number
```

`main.ts` 的接线不变：`retentionTick` 继续调 `enforceBodyBudget`，`rawPruneTick` 继续 `await pruneRawBounded(...)` 后按需 `shrinkStorage(store)`；所有新参数都有缺省值，`ShrinkBudget` 由 `enforceBodyBudget` 透传，不需要在 main 里拆开配置。

## Alternatives considered

- **只把 `pruneRaw` 改成 async 包装**：落选。外层让出事件循环不改变单批里整代际 `DELETE` 或一次全表准备的同步时长，F11 的生产 156 s 现场正是这种形状。
- **保留每批重新准备候选**：落选。200 批 × 每批全表扫描会把准备成本乘 200；改为一次准备后，候选上限固定为 2,000 行/表。
- **用 `SELECT DISTINCT source_kind, file_generation WHERE ...` 找会话候选**：落选。相关子查询会读整张 WITHOUT ROWID 表；主键逐代际 seek 只跳过同代际的大行。
- **准备阶段先取 `length(CAST(TEXT AS BLOB))`**：落选。这仍会读取整段 TEXT；长度检查移到写事务内逐行执行，准备只拿键。
- **一次调用循环到空**：落选。会把清理重新压成长写事务与 WAL 尖刺，和封口分块立下的约束冲突。
- **磁盘压力继续用 `bodyBudget × 0.9` 作目标**：落选。磁盘与正文预算是两种资源，逻辑载荷到不了磁盘目标时继续删只会清空历史，文件并不会降到线下。
- **为磁盘压力加新 worker 或在线 `VACUUM`**：落选。单进程同步 SQLite 下前者要跨连接协调写锁，后者会长时间独占库；增量 vacuum 加假可达判断已经够用。

## Consequences

- 单次最多准备 2,000 个候选键/表；批间墙钟与载荷上限还会进一步限制实际处理数。超期存量大的首轮需要多个 tick 收敛，验收看连续多轮计数下降，不能看单次调用是否归零。
- 单条超大行、单条 SQL 的同步执行、繁忙时的 checkpoint 仍是不可抢占的残余；准备扫描仍可能一次读完某张无索引表。这些边界写在代码注释与 `## Testing` 的断言里，不用「严格墙钟有界」描述。
- 磁盘目标不可达时返回 0 是有意行为：告警与报告应显示「可回收上界不足」，而不是让回收循环继续删正文假装在收敛。
- 会话代际游标是进程内状态，重启后从最小代际重新开始；幂等删除保证重复扫描不会多删。

## Testing

`tests/retention.test.ts` 新增窄回归，均以合成数据构造；删除前旧实现分别失败于：

- 「单个死代际按行限批清理，不再整代际一次删完」：250 行死代际、单批 100，旧实现返回 1 并全删，现返回 100。
- 「跨调用续取同一死代际，不因代际轮转跳过剩余行」：`pruneRaw` 取 100 后，`pruneRawBounded` 仍能续取 150。
- 「单个 raw 表按载荷预算截断，不把整批大 payload 一次删完」：10 行、100 B 预算，旧实现全删，现删 2 行。
- 「回收统计包含独占块字节，不计仍被引用的共享块」：旧实现 `releasedLogicalBytes=3`，现为 23。
- 「准备阶段超出墙钟预算时仍至少提交一批，避免每个 tick 空转」：`wallMs=0` 时仍删 100 行。
- 「磁盘触顶先回收空闲页，回到阈值下就不淘汰正文」：旧实现 `evicted=1`，现为 0。
- 「磁盘压力用独立目标，按可回收上界继续淘汰而不是每轮只删一批」：旧实现只删 100，现按缺口继续淘汰。

`bun run typecheck` 通过；`bun test tests/retention.test.ts` 32 通过；与本改动相关的 6 个测试文件（retention、capacity-meter、capacity、metrics-light、commit-unit、store）合计 53 通过。

## Related

[有界保留清理与可靠停止](2026-11-05-bounded-retention-and-shutdown.md) 仍持有 F12 与 F42 的决策；其中 F11「`raw_session_event` 按代际整批删不受批数上限」与「单批就是各表 100 行」的表述已被本记录部分取代，两篇互链保留。

[容量计数与主线程阻塞回归](2026-11-05-capacity-meter-main-thread-regression.md) 持有 v14 计数口径；本记录新增的 `capacityMeterEvictableBytes` 复用同一 `capacity_meter` 表，不改变其版本与触发器。
