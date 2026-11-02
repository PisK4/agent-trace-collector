# Agent Note: 前缀判定排除发布代组

Status: implemented

## Problem

读侧的 `prefixValid` 只比位置，SQL 侧的 `rowPrefixSql` 还要求 `published_generation IS NULL`。同一个判据的两处实现分叉：切片路径留下发布代的组一旦被标脏、`from_sort` 写下数字边界，JS 会把代际行当成前缀行放行，摘要列在 SQL 侧却是 NULL。

## Decision

`GROUP_READ_COLUMNS` 多读一列 `group_generation`；`prefixValid` 见到非空发布代直接判 false，与 `rowPrefixSql` 注释里的「发布代非空的组走代际表，不参与前缀」一致。行值由代际发布给出，`from_sort` 描述的不是那一次发布。

## Alternatives considered

**反过来放宽 SQL，两处都只看位置。** 摘要的三个 `CASE` 在发布代非空时走第一支，`rowPrefixSql` 本来轮不到；删掉它不改 SQL 行为。但这会让读侧在组未 current 时放行代际行值，越过「发布代只随发布代发布」的既有闸门。

**只留 SQL 守卫。** 摘要列 NULL、行值却按前缀放行，同一条请求在页面上自相矛盾。

## Consequences

- 发布代组不参与前缀，切片路径的读侧语义保持不变。
- 每行读多带一列 `group_generation`，行数与索引不变。
- 守卫只在组同时有发布代与数字边界时起作用；生产当前没有发布代组，行为与改动前一致。

## Testing

`tests/derive-prefix-publish.test.ts` 新增用例：脏组写入发布代后，行不再带 `derived_prefix`，详情链状态退回 `unavailable`。7 项通过，typecheck 通过。