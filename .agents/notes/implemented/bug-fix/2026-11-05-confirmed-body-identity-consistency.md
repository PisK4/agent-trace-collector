# Agent Note: 正文与弱合并的数据一致性修复（F09/F24/F25）

Status: implemented

## Problem

2026-11-04 的缺陷清单留下三条与数据一致性直接相关的条目：F25 的弱时间窗会在模型明显不同时仍把唯一候选并掉；F24 的合并在搬正文时漏写 `body_bytes` 与 `redact_version`；F09 把「hook 正文证据已到、骨架不存在」的行永久留在 `pending`。

只读生产基线（2026-11-05，未写库）：

- F09 组合 `body_state='pending' AND (have & 1)<>0 AND skeleton_z IS NULL AND miss_reason='disk_body_paused'` 共 **671** 行，全部集中在 2026-10-31，claude 610、hermes 61；同形但原因未知或尚无正文证据的行当前为 **0**。
- F24 宽口径 `body_state='available' AND skeleton_z IS NOT NULL AND body_bytes IS NULL` 共 **29,385** 行，跨 2026-10-24 至 2026-11-05。它只证明这些行缺少 `body_bytes`，**不能证明全部由 merge 产生**。近期样本带 `request_alias`、`hook` 证据与 `via='through'`，符合合并路径的特征，但历史全集的归因未逐行回溯。
- 宽口径里有 **344** 行的块引用数与 `msg_count` 不一致，无法按写入时的口径可靠重算字节；其余 **29,041** 行引用连续、无悬空块。

## Decision

### F25：弱时间窗的唯一候选也要过模型闸

`conv_time_model.v1` 仍保留，因为缺强标识的 codex/zcode 调用需要它。变化只有一条：候选唯一时，若查询侧与候选侧都给出了模型，且 `normalizedModel` 后不相等，则 **不合并**，返回 `absent` 并独立成行。模型归一规则原样保留（`group/`、`auto/` 前缀与标点差异仍视为同一模型）；一方缺模型仍不构成拒绝理由。`response_id_norm`、`turn_ref`、`usage_fingerprint.v1`、`conv_end.v1` 四条线索未改，提供了完成时间的来源仍不回退弱开始窗。

### F24：搬正文时以被搬来源的正文元数据为准

`mergeRequestTx` 只有在目标正文不可读、源行有骨架时才搬正文。搬动时 `body_bytes`、`redact_version`、`body_prev_state`、`body_evicted_at`、`body_evict_reason`、`parse_state`、`reply_state`、`adapter_version`、`msg_count` 全部取自源行，不再用目标的旧值 `COALESCE`。`body_bytes` 是这笔请求的逐请求逻辑字节，不是删行时物理释放的字节；purge 的可回收估算不因本次修复被当成实际释放量。

历史缺元数据另由维护函数补，不复制旧值、不猜大小：`previewBodyBytesBackfill(db)` 与 `backfillBodyBytes(db, { approvalId, expectedCandidates, now? })` 只处理引用完整、能按 `persistBodyTx` 同一口径重算的行——骨架压缩长度加本请求去重后各块压缩长度。计算只用 `length()` 与 `request_block`/`block` 的连接，不解压正文，也不把逻辑字节合计当物理释放量。`redact_version` 需要解压骨架才能还原，本批 **不写、不猜**，只在预览里报出仍为 NULL 的数量。引用与 `msg_count` 不一致的行保持 NULL，留给人工核对。`body_bytes` 不参与派生计算，重算不推进请求修订。

### F09：先修产生路径，再重判可证明的历史

新流量的产生路径是合并：hook 源行已是 `partial`、无骨架且带 `HAVE_BODY`，并入 `pending` 的账本目标时只继承了 `have` 位与 `miss_reason`，没有继承状态。`mergeRequestTx` 现在只对精确组合「目标 `pending`、源 `partial`、源无骨架、源带 `HAVE_BODY`」把目标改成 `partial`。正文仍不可读；之后若有别的来源补上正文，`persistBodyTx` 会照常改回 `available`。

历史重判由 `previewBodyConsistency(db)` 与 `reclassifyBodyConsistency(db, { approvalId, expectedCandidates, now? })` 完成，范围固定在「`pending` + `HAVE_BODY` + 无骨架 + 原因等于 `disk_body_paused`」。原因集合是固定常量，不提供参数，也不由 CLI 暴露可改原因。它只改 `body_state` 与 `updated_at`，保留 `miss_reason`、`have` 与骨架缺失事实，因此不是正文恢复，也不把「还在等正文」的行一起改掉。应用必须带预览计数，集合变化即抛 `body_consistency_scope_changed`；更新在单个事务里，失败整体回滚，返回实际改动的 `req_id`。默认不运行，CLI 由维护入口显式接线。

`body_state` 本身是派生输入：`fingerprintsOf` 只读 `available|partial`，工具重建与后台任务清理也直接按状态取范围；hook 写正文状态时同样调用 `markRequestInputTx`。就这批无骨架行而言，`pending` 与 `partial` 在正文指纹上都得到 null，派生结果当前相同，但结论不能依赖这个巧合。应用对每个改动行调用 `markRequestInputTx`，推进修订并标记所属组，重启后不会复用 pending 时代算出的组结论；不靠停服重启清缓存来掩盖失效，也没有新增缓存层。

两个维护函数都接收 `Database` 而不是 `Store`，以便与停止服务后的 `withStoppedDatabase(path, fn(db))` 共用同一个独占连接；预览可传只读连接。

## Production evidence

只读预览结果（未执行 apply）：

- F09：671 个候选，`unproven_pending=0`，窗口 2026-10-31。
- F24：29,041 个可重算候选，逻辑字节合计 **8,074,278,492**；`uncomputable=344`，`missing_redact_version=29,041`；分布 claude 24,946、hermes 3,263、omp 448、zcode 295、codex 62、其它 27。

F09 在 2026-10-31 之后没有新增行，但产生该形态的合并路径在修复前仍然可达，合成用例已复现；本次同时修掉路径并保留显式历史重判。

## Alternatives considered

**保留「模型不同时唯一候选仍合并」。** 60 秒窗内的唯一候选只证明没有别的候选，不证明两笔调用相同；模型不同的误并会把 usage 与轮次归到错误请求。落选。

**删掉 `conv_time_model.v1` 弱规则。** 能彻底消除误并，但会让缺强标识的 codex/zcode 调用全部变成孤儿；保留规则、加模型闸的改动更小。落选。

**把模型闸扩成「模型或 usage 至少一项有交集」。** 当前弱窗路径的 usage 常常缺失或不可比，且 `usage_fingerprint.v1` 已单独处理四段用量相等的场景；本次只落模型硬约束，避免在同一批里引入第二套判据。落选。

**F24 历史回填复制同会话其它行的旧 `body_bytes`。** 不同请求的正文大小不同，复制旧值是猜测。落选；按骨架与块长度重算。

**F24 解压骨架以恢复 `redact_version`。** 29,385 条骨架压缩后约 **914 MiB**，解压与大范围解析会长时间占用维护进程主线程，且这一列当前没有读取消费端。落选；本批只补可无解压重算的 `body_bytes`，`redact_version` 留给有明确消费需求时的分块处理。

**F09 把所有「pending 且有正文证据但无骨架」的行一律重判。** 其中可能有仍在等待其它来源或仍在运行的请求；原因未知时不具备「不可恢复」证据。落选；范围限定在可证明原因集合。

**在 `markHookAbsent` 里自动重判历史行。** 会把历史修复变成后台定时写，且与显式审批的维护流程冲突；新流量已由合并路径修好。落选；历史修复走显式预览/应用。

**F09 重判只改状态、不推进派生修订。** 这批行没有骨架，两种状态下正文指纹都算不出来，短期产物确实相同；但 `body_state` 是派生范围的直接输入，依赖「恰好结果相同」会让未来读取范围变化时静默复用旧组结论。落选；逐行 `markRequestInputTx`，与 hook 写状态的失效方式一致。

**只修 purge 侧反算、不回填 `body_bytes`。** 其它消费端仍会看到 NULL，且 purge 的估算口径继续依赖每处自行重算。落选；优先在合并路径补写，历史再由维护函数显式重算。

## Consequences

- F25 收紧后，同会话 60 秒内模型明确不同的两笔调用会各自成行，不再并成一条；模型别名写法不同仍合并。多候选与提供了完成时间的来源行为不变。
- F24 新发生的合并会保留完整正文元数据；已有 29,041 行可通过维护预览/应用补 `body_bytes`。344 行引用不完整与全部历史 `redact_version=NULL` 仍是已知边界，不会在本批被修好。
- F09 的 671 行可在显式维护后显示为 `partial`，但正文仍然不可读；这改变的是状态事实，不是恢复正文。新流量不再产生同一组合。
- 维护函数默认不写库；应用需要审批标识与预览计数，失败整体回滚。F09 apply 逐行推进派生修订并标记所属组，后续派生会重新结算这些组；F24 只补元数据，不推进修订。生产 apply 未执行，审批拒绝与部署结果见[生产验收](../../../../docs/acceptance.md#开放缺陷生产部署真实流量2026-11-06)。

## Testing

合成数据回归（旧版失败、修复后通过）：

| 缺陷 | 旧版失败证据 | 修复后 |
| --- | --- | --- |
| F25 | 模型归一后不相等、唯一候选时返回 `matched` + `reqId=1` | 返回 `{reqId:null, outcome:'absent', rule:null}` |
| F24 | 搬正文后 `body_bytes=null`、`redact_version=null` | 取源行的 4096 / 1，并同步 parse/reply/msg/adapter |
| F09 根因 | 合并后目标仍 `body_state='pending'` | 目标改为 `partial`，`miss_reason='disk_body_paused'`、`have` 保留 |
覆盖文件：

- `tests/owner-fingerprint.test.ts`：模型不同唯一候选不合并；候选缺模型仍兜底；别名归一后仍按弱窗认领。
- `tests/merge-body-metadata.test.ts`：正文搬运携带 `body_bytes`/`redact_version`；目标已有正文不覆盖；F09 组合转 partial；调用方事务失败整体回滚。
- `tests/body-consistency.test.ts`：F09 预览/应用范围、计数闸、事务回滚、应用后 `input_revision` 推进；F24 共享块去重、`msg_count` 不一致行排除、`redact_version` 不猜、计数闸与事务回滚。
- `tests/droid-dedupe.test.ts`、`tests/hook.test.ts` 的旧断言随行为更新：模型不同不再合并；合并 `partial` 源行后目标为 `partial`。

执行结果：上述三份新增/修改测试 `30 pass / 0 fail`；`hook`、`reconcile`、`session-hermes`、`session-dedupe`、`maintenance` 合计 `132 pass / 0 fail`；其余会话适配器 `37 pass / 0 fail`；`bun run typecheck` 通过。生产只读预览见上节，未对生产库执行 apply。

相关：[F09/F24/F25 原始清单](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)、[跨来源模型名不参与调用身份比较](./2026-11-04-session-model-name-dedupe.md)、[Hermes 本地行按完成时间认领网关调用](./2026-11-05-hermes-call-time-basis.md)、[hook 缺席正文的老化标注](./2026-10-25-hook-absent-body-aging.md)。
