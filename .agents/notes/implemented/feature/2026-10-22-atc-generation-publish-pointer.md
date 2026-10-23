# Agent Note: 派生结果按代整体发布，读侧按组状态整组屏蔽

Status: implemented

## Problem

v6 把派生结果从 `request` 列搬进了代际结构（[v6 把派生结果放进代际结构](../architecture/2026-10-22-atc-schema-v6-generations.md)），但"一代算完之后怎么变成读者看到的那一份"没有落地。少了这一层，结构虽然能装下按代的结果，却没有任何机制说清三件事：

1. 半套结果能不能被读到。切片派生分多个阶段、跨多个事务写结果，中途被读到就会把"工具配对还没做"当成"这一笔没有工具调用"。
2. 上一代还在不在。整组重算时如果把旧结果原地删掉再写新的，读者会经历一个"什么都没有"的窗口；进程中途死掉，整组结果就永久缺失。
3. 过期的一代怎么处理。算出结果的这段时间里又来了新输入，这一代对应的输入修订已经不是当前值；把它发出去，读者拿到的是按旧输入算的结论，而且没有任何标记能看出来。

## Decision

`derive_queue` 上的 `published_generation` 是唯一的发布指针，`derive_generation.state` 是这一代的生命周期。

**一代一行，认领时开代。** `beginGeneration(store, convKey, actor, now)` 只认领一个组（一个组就是一次批的边界），要求队列不是 clean、没有在途的 `compute_generation`、且 `target_algorithm` 等于 `DERIVE_ALGORITHM`；不满足返回 `null`，`target_algorithm` 不符则抛 `derive_algorithm_mismatch`（算法号不同的结果不能互相复用，静默复用比失败更坏）。开出的代从 `building`/`requests` 起步，队列同时写 `compute_generation`、`compute_started_ms`、`last_claimed_ms`，并累加 `attempts`。

**发布在切换之前校验完。** `publishGeneration(db, generation, now)` 在一个 `BEGIN IMMEDIATE` 事务里按指针级条件校验：这一代必须是 `ready`/`done`；队列仍然存在，且 `group_epoch`、`input_revision`、`target_algorithm` 三者与开代时相等；全组 `known` 请求数等于 `request_count`、没有漏行、工具行数等于 `tool_count`。任一条不成立就丢弃这一代并返回 `false`，指针不动。因此 `published_generation` 上永远不会短暂出现一个过期代——"先发布再发现过期"的顺序会留下一个真实存在的错误窗口。

**发布是原子切换，旧代转 `retired` 而不是被删。** 校验通过后，同一事务里：先把本组原有的 `published` 代转成 `retired`，再把这代写成 `published`，最后把队列写 clean 并同步 `published_revision`/`published_algorithm`/`legacy_snapshot=0`、清空 `compute_generation`。旧代的结果行原样保留：历史详情与"上一代怎么算的"都还要读它们，回收只由保留上限执行。

**丢弃只针对未发布的代。** `discardGeneration` 删这一代的结果行与四张工作表，把状态写成 `discarded`，并只在队列的 `compute_generation` 正好是它时清空认领并记 `last_error`。已经 `published` 或 `retired` 的代走到这里直接返回：它们是历史，不是可回收的中间产物。

**进程重开丢弃未发布的代。** `recoverSlice(db, now)` 在 `startCollector` 里、起定时器和 handler 之前调用，把所有 `compute_generation` 指向 `building`/`ready` 的代连同结果一起丢弃。未发布的代没有读者，任何在途状态都是上一个进程留下的半成品；留着它会在下一次认领时被当成"可以续跑的一代"，而续跑本身没有可靠依据（阶段推进的位置与输入修订的对应关系并不完整）。

**读侧按组状态整组屏蔽。** `readEffectiveGroup(read, convKey, actor)` 在一个 `BEGIN DEFERRED` 事务里先读队列状态与发布指针，组不是 clean 或没有发布指针就返回 `{state:'masked', rows:[]}`——一行都不返回；是 clean 才读 `effective_request` 并核对每行的 `generation` 与指针相同（不同则抛 `derive_snapshot_mismatch`）。**不回退到 `request` 旧列**：`d.title` 为 NULL 就是"这一代没有给这个字段结论"，用 `COALESCE(d.title, r.title)` 把它补成旧标题，等于把过期值伪装成当前值，而且会让等价性判据失去定义。

## Alternatives considered

**边算边发布，队列 clean 时就可见部分结果。** 读到"阶段还没跑到的字段"和"这一代在这个字段上就是没有结论"在 JSON 里长得一样，调用方无法区分；按组整组屏蔽是唯一不产生歧义的读法。

**发布时原地删旧结果再写新结果。** 读者会看到一个没有结果的窗口，进程死在中途还会留下永久缺失的一代。旧代转 `retired` 保留，代价是磁盘占用，收益是任何时刻都能回退到完整的一代。

**先切换指针，再校验过期。** 校验失败时指针已经指过去了，读者可能已经读到；要修就得再写一次指针，中间那段时间是错的。校验放前面，失败时指针完全没动过。

**把在途代留在库里做续跑。** 需要额外记录"每个阶段推进到了哪一行"，且这个位置必须和输入修订绑定才有意义；v6 建了阶段游标列（`cursor_req_id`、`role_scan_ord`、`tool_cursor_ord` 等），但跨进程续跑还要证明"上次留下的工作行与本代当前输入一致"。第一版选择丢弃：重算一遍的代价是可控的，把半成品当续跑目标的代价是静默错误。

**`readEffectiveGroup` 返回 `masked` 时逐字段回退旧列。** 见上：会把过期值伪装成当前值，也让等价性判据（Task 19 的 oracle）无法陈述。

**`discardGeneration` 只包一层带 `BEGIN IMMEDIATE` 的实现。** `publishGeneration` 在自己的事务里也要走丢弃路径，直接调用就会嵌套事务（`bun:sqlite` 抛 `cannot start a transaction within a transaction`）。所以拆成 `discardGenerationTx`（调用方已在事务中）与包事务的 `discardGeneration`，删除逻辑只有一份。

## Consequences

- 读者只有两种状态：整组当前，或整组屏蔽。没有"部分当前"这个中间态，调用方不必按字段判断新旧。
- 发布前必须把该代的工作全部做完（`ready`/`done` 且覆盖完整）；一批做不完就继续攒，不发布。代价是一代完成的时间变长。各阶段怎么攒这些事实见[切片派生的请求事实与工具候选](2026-10-22-atc-sliced-request-candidates.md)。
- `retired` 代会累积，回收责任明确落在保留上限（`maxRetiredGenerations`）上；本决策不回收它们。
- 每组的 `derive_generation` 行会随重算持续增长，每代一行；这是保留上限要读的数据，也是排查"这一代为什么被丢弃"的唯一依据（`last_error`、`attempts`）。
- 进程重开必然丢弃在途代：崩一次就重算一遍这个组。这是刻意的取舍，不是待修的缺陷。
- `legacy_snapshot` 在全新库里恒为 0；发布路径把它写 0，标记"这一代是算出来的"，而不是从旧列读出来的。

## Testing

`bun test tests/derive-slice.test.ts` 覆盖 5 条：发布指针原子切换且旧代结果保留（旧代转 `retired`、结果行仍在、队列字段同步）；输入修订在开代之后变化时 `publishGeneration` 返回 `false` 并且这一代被丢弃、结果行清零、发布指针不动；`recoverSlice` 丢弃未发布的在途代且不碰上一代已发布结果与指针；组 dirty 时 `readEffectiveGroup` 返回 `masked` 且零行，组 clean 时返回整组，其中结果 `title` 为 NULL 时必须保持 NULL（不回退到 `request.title` 的 `old title`）；对已发布代调 `discardGeneration` 是空操作（状态仍 `published`、结果保留、指针与 clean 状态不变）。