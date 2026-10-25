# Agent Note: 切片派生的请求事实与工具候选只按页物化，顺序沿用同步比较器

Status: implemented

## Problem

同步派生把一整个组一次性读进内存再算。`drainDeriveTx` 取整组 `request` 行进内存、按时间与来源位置排序、逐笔找前驱、配对工具、写摘要，全在一个事务里。成本按"组里累计了多少请求"增长，实测 5 rps 场景下派生占 48%、单笔写事务 5.29 秒，10,000 笔长组的单笔写事务 1.96 秒。要把它切成可中断的多个批次，第一件事实就必须能分批落进库里：请求事实、工具调用候选与工具结果候选。

切片化同时引入两个必须当场定死的口径，否则后续阶段会各写一套：

1. **顺序规则只有一份。** 遍历序决定遍历次序、前驱扫描的推进方向，以及主链根的选取。切片若自己实现一遍排序，同一个组在同步与切片两条路径上会得到不同的链。而等价性判据正是要以两条路径结果相同为定义。
2. **"这一笔的正文读不出来"是一个判据，不是一个状态值。** `body_state` 说"我们打算保存正文"，不等于"现在读得出正文"。骨架损坏或块引用不连续时，它的值仍是 `available`。按状态判，会在这种行上把旧标题覆盖成 NULL，而这正是同步路径靠 `fingerprintsOf` 避开的错。

## Decision

`sliceRequestsStage(store, generation, budget, now)` 是切片管线的第一个阶段，一次调用是一个阶段批次。

**一页一个事务，页就是批的边界。** 按 `req_id` keyset 取 `LIMIT min(50, maxCandidatesPerBatch)` 行，每页一次 `store.write`。逐请求的三个预算各自独立：`maxCandidatesPerBatch` 同时是页大小与单笔请求的候选上限；单笔物化耗时超 `maxRequestMs` 就整代作废；整批累计写次数到 `maxWritesPerBatch`、或调用耗时到 `maxStageBatchMs`，就返回 `advanced` 让调度方下一轮接着来。三项都超限时**不切一半**。候选写一半，后续配对就分不清"这一笔确实没有第二个工具调用"与"第二个还没写进来"，宁可直接丢掉整代。

**丢弃发生在失败事务之外。** 预算类失败抛出固定原因码（`slice_group_revision_changed`、`slice_request_budget`、`slice_candidate_budget`），在页事务外接住，再用一次新的写事务调 `discardGeneration`。其余异常照旧冒泡。把真实故障吞成"切片决策"，会让坏掉的代码看起来像在正常工作。理由见「曾考虑的替代方案」里嵌套事务那一条。

**可读性由 `readBodyTx` 判定。** 读得出正文才标 `recomputed`，标题、标题来源、输入摘要与回复摘要全部留 NULL，交给摘要阶段写本次重算的值。读不出来标 `retained`，这几列原样保留 `request` 上的旧值。

**候选抽取复用共享实现。** 工具调用用 `anthropicReplyCalls`，工具结果用 `anthropicRequestResults`，结果正文压平用 `flattenToolContent`，三者都在[判定内核](../../implemented/architecture/2026-10-23-derive-decision-kernel.md) `src/derive/decision.ts` 里，两条路径同一份。候选行写进 `derive_call_work`/`derive_result_work`，`traversal_ord` 与 `request_index` 先记 -1（"还没排序"只有一个哨兵），配对之后再回填。结果摘要先存 200 字符的前缀，最终展示长度由摘要阶段裁。

**顺序阶段读全组轻量排序键，用 `compareTraversalOrder` 排一次。** 内存里只有 `(req_id, started_ms, sort_source, sort_key)` 元组，正文与结果都不驻留。按 500 行一批写回 `traversal_ord`，同一遍把两张 work 表的 `traversal_ord`/`request_index` 对齐。排序阶段与最后一个空页在同一个事务里执行，做完就把 `stage` 推到 `roles`。

**过期由组修订判定，不由请求修订判定。** 每页开头执行 `assertQueueRevision`，组身份（`group_epoch`）与组修订（`input_revision`）与开代时相同才继续。请求行自己的 `input_revision` 是它自己变了多少次，组的 `input_revision` 是组内发生过多少次变化，两者量纲不同，从不相等。拿它们相等当条件，会把每一代都判成过期。

## Alternatives considered

**让切片自己实现一遍遍历排序。** 排序规则（时间优先、同毫秒按来源位置、`req_id` 只兜底）是等价性判据的一半。两份实现会在漂移时悄无声息地让两条路径给出不同的链，到那时等价性测试已经无法定义"应该相等的是什么"。

**逐请求比对 `request.input_revision`。** 见上。这种比法量纲错了，会让每一代都被判过期。组修订已经覆盖同一个问题。成员一改，组修订就涨。

**按 `body_state` 判可读性。** 会把骨架损坏的行当成本次重算，写 `title=NULL` 丢掉旧标题。同步路径在这类行上标 `retained`，切片必须给出同一个答案。

**把整个阶段包在一个 `store.write` 里、每页开一个嵌套 `db.transaction`。** 实测 `bun:sqlite` 的嵌套 `transaction()` 不是 savepoint，内层抛错会把外层一起回滚（探针：外层插 1、内层插 2 后抛错，提交后表里 0 行）。所以"每页一个事务"是假的。更坏的是，若在这一层里 catch 住预算错误再丢弃整代，这次丢弃会被同一个回滚一起带走，那一代就以"半套请求事实、`state` 仍是 `building`"的形态留在库里。而它恰恰是最不该被续跑的东西。

**候选超预算时只写一部分。** 配对阶段无法区分"没有更多候选"和"还有候选没写进来"，会把未完成的组算成"工具都配好了"。整笔失败比留下半套候选更可读。

**把正文或完整工具结果整组读进内存再排。** 内存随正文规模增长，而 10,000 笔长组的正文正是要躲开的那部分。排序只需要元组。

**请求阶段顺手把 `retention_state` 定为终值。** `retention_state` 的权威判据与链阶段同源（`fingerprintsOf` 的"可比/不可比"），请求阶段只能按正文读得出与否给出临时值。终值由链阶段对齐；发布发生在 `stage='done'`，中间值不进读者的视野。

## Consequences

- 一页的事务只覆盖至多 50 行请求，长组不再靠一个巨型写事务收尾。代价是同一个组要跨多次调用才能建完，中途被丢弃就要从头重算。
- 请求阶段的预算超限会让整代作废并重来。这是刻意的。半套事实没有读者，留着只会被下一代误认为可续跑。
- `derive_request_result` 在请求阶段结束时还不是终值。可读行的标题与两类摘要都是 NULL，`basis_json` 是 `'{}'`。读者看不到这些行。它们只在这一代被发布时才可见，而发布要求 `stage='done'`。
- 可读性的判据与同步路径在效果上一致但不完全同源。请求阶段用 `readBodyTx`，链阶段仍会用 `fingerprintsOf`（后者还要求指纹非空）。两者对"骨架损坏"给同一个答案，对"引用完整但指纹为空"可能不同，链阶段会以自己那套覆盖。
- 排序阶段的内存是 O(组内请求数) 的元组，不是 O(正文)。
- 队列行的 `target_algorithm` 仍由同步路径写成 `GROUP_ALGORITHM`，切片模式必须先把它切到 `DERIVE_ALGORITHM` 才能认领（Task 14 记下的布线缺口）。本阶段不改这条布线。

## Testing

`bun test tests/derive-slice.test.ts` 覆盖：四笔请求（两笔有正文、一笔无正文、一笔 `body_state='missing'`）在一个组里分批物化后，`traversal_ord` 按同一毫秒的账本偏移定序得到 `[3,2,1,4]` 且连续为 0..3，`retention_state` 为 `['retained','recomputed','recomputed','retained']`，`derive_call_work` 与 `derive_result_work` 各 1 行且 `traversal_ord` 回填为对应请求的序号，代际的 `stage` 到 `roles`、`request_count` 为 4；以及页之间组修订被推进时整代被丢弃（`state='discarded'`、结果行清零、`compute_generation` 清空、`last_error='slice_group_revision_changed'`）。`tests/fixtures.ts` 新增 `seedRequest` 与 `SEED_GROUP`，组键只有一处定义。