# Agent Note: v6 把派生结果放进代际结构，旧库仍删除重建

Status: implemented

## Problem

同步派生的成本按"脏组里累计了多少请求"乘"重算了多少轮"增长：实测 600 秒的 5 rps 场景只投递 3.39 rps，派生作业占 48%、单笔写事务 5.29 秒；10,000 笔长组的单笔写事务 1.96 秒。要把重算范围收到"这一次新输入"，派生结果就必须能按代整体发布、整体作废、整体保留上一代；而 v5 把派生结果写在 `request` 行上（`title`、`chain_role`、`prev_req_id`、`input_preview` 等），没有"这份结果出自哪一代"这个身份，没法只换掉其中一部分。

## Decision

v6 把派生结果从 `request` 行搬到代际结构：`derive_generation` 一代一行（组键、输入修订、算法号、阶段、游标、两侧摘要），`derive_request_result` 与 `derive_tool_result` 存结果，`derive_chain_work`、`derive_role_work`、`derive_call_work`、`derive_result_work` 是只建不改的工作表。`derive_queue` 原地补列：`published_generation` 是唯一发布指针，`legacy_snapshot` 标记这一代来自旧列，`compute_generation`/`last_claimed_ms`/`attempts`/`last_error` 给阶段调度用。

D 的用途权威（`req_kind`、`model_title`）留在 `request` 上，结果表只存它消费到的 `purpose_revision` 与 `purpose_version`。两个视图都按整代连接：`published_derive_request` 只连 `published_generation`，`effective_request` 左连结果，`d.*` 为 NULL 就是"没有当前代结果"，调用方按 `group_state` 屏蔽，不逐字段回退到旧列。旧列（`request.title`、`chain_role`、`request_block` 等）这一版保留不动：只换读口径，不删证据。

**v5 数据不迁移，沿用破坏式重建。** 迁移要按组分批、可中断续跑、还要在恢复侧认出半迁移的包，而旧库按既定立场可以直接删。所以普通 `openStore` 只接受两种状态：空数据目录（在同一事务里写 v5 基础结构 + v6 结构与 `user_version=6`）或已经是 v6 的库。低版本报 `schema_rebuild_required`，高版本报 `schema_version_unsupported`，没有"结构已 v6、数据还在搬"的中间态，也没有 `migrateV6` 之类的续跑入口。

## Alternatives considered

**做 v5→v6 的可续跑迁移。** 曾按两阶段标记与 keyset 分批写过一版（`scripts/migrate-v6.ts`），实测可中断续跑、摘要两侧相等。放弃的理由是它保护的是本机那份 v5 库，而这份库按既定立场可以删；保下来的代价是长期维护一套只在旧库上触发的阶段、标记与恢复分支。

**启动时原地 `ALTER` 并补算。** 把结构升级与派生重算混进一次启动：失败没有明确错误、没有可重跑入口，而库已经标成新版本，下一次启动会继续在半迁移数据上写新事实。

**只建代际表，结果继续写在 `request` 列上。** 两套读口径并存，切片结果没有落点，也没有地方表达"这一代作废"。

**结果表里逐字段 `COALESCE(d.title, r.title)`。** 会把旧标题当成新结果返回，等价性判据（Task 19 的 oracle）随之失去定义；缺结果必须表现为缺结果。

## Consequences

- 从 v5 升到 v6 是"停采集器 → 移走或删除数据目录 → 启动建新库"；旧库里的请求正文与派生结果一起消失。
- 恢复侧的 bundle 白名单只含当前版本 `6`（[旧库删除重建](2026-10-23-destructive-schema-replacement.md) 的同一条立场）：v5 的包搬回来也打不开，所以不进白名单。
- `derive_queue` 的 `legacy_snapshot` 与结果的 `legacy` 保留态在全新库里不会出现；它们留给"从旧列读出来"的过渡路径与后续阶段使用，写入者不得把它们当算法覆盖。
- 读到没有当前代结果的请求是正常状态：调用方按 `group_state` 屏蔽，不能把 `d.*` 为 NULL 拼成旧值。
- 这一版没有迁移，因此没有半迁移库、没有续跑命令、也没有"标记未完成"这一档错误。

## Testing

`bun test tests/store.test.ts` 覆盖：26 个业务表、空库建到 `user_version=6`、低版本（含 `user_version=5`）报 `schema_rebuild_required`、未知高版本报 `schema_version_unsupported`。`bun test tests/maintenance.test.ts` 覆盖 v6 库的 bundle 备份写出 `schema: 6` 并可恢复，以及白名单外版本在备份与恢复两侧都被拒。