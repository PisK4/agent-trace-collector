# Agent Note: 组待办与当前判定收进 derive-state

Status: implemented

## Problem

「这一组的产物还算不算当前结论」这个读模型判据，在代码里有八处编码：TS 一处（`queries.ts` 的 `derivedStateOf`）、SQL 内联四处（`SESSION_TITLE_SQL` 的四个候选子查询各写一遍 `state='clean' AND published_revision=input_revision AND published_algorithm=target_algorithm`）。待办条件 `state<>'clean'` 另有九处，散在 `derive.ts`（排空与积压计数）、`derive-slice.ts`（认领与排空）、`maintenance.ts`（verify 与 rebuild 报告）、`capacity.ts`（积压探测）。各处靠字符串约定对齐，改一次判据要同步四个文件。`request` 行也有自己的 `input_revision`，手写条件还容易漏掉别名限定，join 语义会因此悄悄变化。

## Decision

`derive/state.ts`（dirty 标记的内核）拥有判定的唯一写法，本次交付三个符号：

- `queuePendingSql(alias?)`：待办条件 `state<>'clean'` 的 SQL 片段；
- `groupCurrentSql(alias)`：「当前」条件三连的 SQL 片段，别名必填；
- `groupIsCurrent(row)`：同一判定的行形态，输入队列行的原始列名。

消费方全部改为引用片段：`queries/projection.ts` 的 `derivedStateOf` 与 `queries/sessions.ts` 的会话标题候选、`derive/sync.ts` 的组选取与 `remaining` 计数、`derive/slice.ts` 的候选选取/算法归一/`remaining`、`maintenance/verify.ts` 与 `maintenance/rebuild.ts` 的报告、`capacity.ts` 的积压探测。判据本身的语义（clean 行是完成记录、修订与算法追赶、`dirty_since_ms` 口径）不变，仍由[组发布前处理请求](2026-10-22-request-work-before-group-publish.md)与[持久组状态与输入修订](2026-10-22-durable-group-state-and-input-revision.md)持有，本 note 只把判据在代码里的家固定下来。

## Alternatives considered

**在 `derive_queue` 上建一个视图。** 视图能把条件收进 schema，但容量探测需要容忍没有 `state` 列的 v5 实验库，列存在性守卫没法在视图里表达；视图还多出一层 schema 演进面，与「普通 `openStore` 不做 ALTER」的升级策略叠加后成本更高。

**只收 TS 谓词，SQL 维持内联。** 漂移风险最高的恰恰是四处 SQL 字符串。TS 谓词收进来后，SQL 仍然各写各的，判定还是没有唯一的家。

**维持现状，靠注释互指。** 注释已经存在（capacity.ts 的「C 的现行屏蔽条件」），但没有约束力。判据改动依然要求人记得同步四处。

## Consequences

- 改判据只动 `derive/state.ts` 一处；SQL 与 TS 两种形态同文件相邻，不一致在 review 里直接可见。
- 片段是带别名参数的函数，不是常量。`request` 与 `derive_queue` 都有 `input_revision`，join 内插必须限定别名，这条约束写进片段的文档注释。
- `capacity.ts` 的旧库列探测（`hasState` 守卫）与片段组合使用，容量实验对 v5 库的容忍路径不受影响。
- `schema.sql` 里描述约定的注释保留：它面向读 schema 的人，不是判定的实现位置。
