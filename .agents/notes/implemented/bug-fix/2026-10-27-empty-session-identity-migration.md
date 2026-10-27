# Agent Note: 空 session 不是会话身份

Status: implemented

## Problem

上游对「没有会话」有两种写法：缺字段与空串。账本与路由的映射层已经把空串转成 NULL，hook envelope 保留原值，[hookConv](../../../../src/evidence.ts) 也只把 NULL 当缺失。于是 `session=''` 的 hook 请求把空串当成了会话身份：组键落 `["session",""]`，`session` 列存空串，`actor` 也写成空串，`actor_state` 仍是 `unknown`。

后果集中在 hook 初建、尚未关联账本或路由的请求。它们不参与组派生，却共享同一个会话列表分组；这个桶与任何真实会话无关，排查时也无法按请求区分来源。新数据继续进入同一个桶，旧数据靠修 helper 不会改变——[rebuild](../../../../docs/operations.md#rebuild) 只重算用途与派生，不重建会话身份；重复投递同一个 hook_id 走幂等路径直接返回，不会重写已有行。

生产只读快照里，这个桶有 57 行，`conv_source='session'`、`via='hook'`、`have=1`，各持一份 pending hook 证据，`response_id_norm` 全空。数量不大，但每来一笔无会话的 hook 请求都会继续增加。

## Decision

[会话身份 helper](../../../../src/evidence.ts)新增 `sessionIdentity`：长度为零的字符串不是身份，返回 null 而不是原值。`hookConv` 先规范化再选组键，`insertHookRequest` 用规范化后的值写 `session` 与 `actor`；`raw_hook.session` 保留上游原值，原始证据不改写。账本、路由与 OTLP 的映射层此前已转 NULL，本次只改真正缺少规范化的 hook 入口。

新请求的组键因此回退到证据自己的前缀 `["hook", hook_id]`，同一会话的后续 hook 在关联到账本目标之前也不再互相混淆。`actor_state` 仍是 `unknown`：不知道会话不等于确认归属，不凭拆分分组给 actor 结论。

### 存量迁移

[maintenance/identity.ts](../../../../src/maintenance/identity.ts)提供 `previewHookIdentityMigration` 与 `migrateHookIdentity`，命令入口是 [maintain migrate-hook-identity](../../../../docs/operations.md#migrate-hook-identity)，默认只预览，`--apply` 必须带 `--approval-id`。

候选判据只认证据，按下列顺序判定：

| 判据 | 结论 |
| --- | --- |
| `conv_source<>'session'` | `identity_changed`，执行期间已被改写 |
| `via<>'hook'` | `not_hook_born` |
| `actor_state<>'unknown'` 或 actor 非空 | `actor_known` / `actor_present` |
| `have` 带账本/路由位，或已有账本、路由、OTLP 证据 | `ownership_attached` |
| `session` 非空 | `session_present` |
| hook 证据 0 条 / 多份 / 已合并 | `hook_evidence_missing` / `hook_evidence_ambiguous` / `hook_evidence_merged` |
| `raw_hook` 缺失，或其 session 非空 | `hook_source_missing` / `hook_session_present` |

多份 hook 证据无法确定唯一回退身份时拒绝，不取首条猜测。已有关联的行不套用 hook 回退，单列核查——它们不符合孤儿迁移条件，动它们等于用猜测覆盖账本归属。

每行一个独立事务，事务内重新读取并复核判据；只改 `conv_key`、`conv_source`、`session`、`actor`、`updated_at`，随后按现有归属规则处理旧组并推进输入修订。未知 actor 不凭空建派生组，`actor_state` 不升级。报告对账请求、证据、块、别名、工具链接的行数与费用合计，`conserved` 为假即视为失败。重复执行时桶里只剩被拒绝的行：`migrated` 为 0，不推进修订。迁移不动 hook 证据与等待队列，唯一 response ID 到达时仍按 `mergeHookInto` 并入账本目标，目标身份不被 hook 回退覆盖。

## Alternatives considered

**只改 `hookConv`，不提供迁移。** 新请求停止进桶，旧行永远留在 `["session",""]`；按判据它们都已无资格被正常关联逻辑改写，只能由显式迁移处理。

**用 rebuild 修身份。** 现有重建只升级用途与派生，不重算 `conv_key`；重复 hook 投递也走幂等路径。把身份修复塞进 rebuild 会改变它的作用域，且对整键重算换不来身份更新。

**把整桶所有行改成各自的 hook 回退键。** 已有关联账本或路由的行，其身份由账本确认；改成 hook 回退是用较弱证据覆盖较强证据。这类行必须拒绝并单列。

**在读取时把空串当 NULL 存进 `raw_hook.session`。** 原始证据保真是既有约束：上游写空串就是空串，解释在上层完成，不靠改写来源掩盖派生错误。

**自动迁移，或把迁移挂在启动路径。** 身份是持久数据，改变它的写入必须经过显式审批与维护窗口；启动时静默改写会让问题不可见。

## Consequences

新数据不再制造空会话桶，旧数据在迁移执行前保持原状；报告里的 `remaining` 就是未处理完的存量。被拒绝的行保留可解释原因，需要人工核查，不会因为命令跑过就被当成已修好。

迁移只确认身份，不确认归属：这些行仍是未知 actor，不进入链候选与组派生。即使后续 hook 并入账本目标，目标身份也保持不变。

`["session",""]` 作为历史键仍可能被查询与重建入口看到；迁移把候选行拆走后，桶内只剩拒绝行。命令幂等，但每轮都会重新扫描整个桶，桶很大时需要维护窗口。

## Testing

[tests/hook-identity.test.ts](../../../../tests/hook-identity.test.ts)锁定新请求的空 session 处理：组键落 `["hook", hook_id]`、`session` 与 `actor` 为 NULL、`actor_state='unknown'`、`raw_hook.session` 仍为空串、不产生派生队列行；非空 session 保持原身份。预览用五行种子分别覆盖候选与 `ownership_attached`、`hook_evidence_ambiguous`、`hook_session_present`、`hook_source_missing` 四种拒绝，并断言不改库。命令路径覆盖预览、缺审批标识退出 1、执行成功（`migrated:1`、`remaining:1`、`conserved:true`）与重复执行零新增；迁移后的孤儿在唯一 response ID 到达时仍能并入账本目标，别名与证据落在目标行，目标身份不被覆盖。

[tests/evidence.test.ts](../../../../tests/evidence.test.ts)补空串回退断言。`tests/evidence.test.ts`、`tests/hook.test.ts`、`tests/hook-identity.test.ts`、`tests/maintenance.test.ts` 共 76 项通过，`tsc --noEmit` 通过。
