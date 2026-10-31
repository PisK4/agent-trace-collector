# Agent Note: response id 规范化改为幂等

Status: implemented

## Problem

2026-10-31 在本机 OMP 会话里读到四格全空的请求。OMP 的网关记录没有缺数据：845 条 `through` 行全部带 `prompt_tokens`、`prompt_window` 与 `parts_json`。缺的是同一笔调用的两份证据没有合到一行：hook 行有正文、没有读数，路由行有读数、正文待补。

hook 回执 id 是 `chatcmpl-msg_<hash>`，账本侧是 `msg_<hash>`。`normalizeResponseId` 按前缀表找到第一个匹配就返回：hook 侧剥掉 `chatcmpl-` 后停在 `msg_<hash>`，账本侧剥掉 `msg_` 后是裸 hash。`findCandidates` 只按 `response_id_norm` 找路由行，两个键不相等，hook 侧于是新建一条请求，`pending_hook` 也一直留着。

全库只读计数：

| 指标 | 数值 |
| --- | --- |
| OMP `through` 行 / 带 prompt / 带 parts | 845 / 845 / 845 |
| OMP `hook` 行 | 35 |
| 回执 id 多一层前缀、重剥后唯一命中路由行 | 22 |
| 流式 hook 没有可用回执 id | 13 |
| 存量 `request.response_id_norm` 还能再剥一层 | 745 |
| 其中会与既有路由行撞到同一键（待合并） | 22 |

13 条流式 hook 的 12 条留存回执是 `absent`，`response_bytes` 为 0。它们与同 session、同一秒、同模型的路由行一一对应，却没有 join 键。Claude 也有 1101 条同类孤儿，`markHookAbsent` 的注释已经把这类回调写成长期现实。这次只修前缀，不为孤儿另造规则。

## Decision

`normalizeResponseId` 改为循环剥离：每次按原顺序找第一个匹配前缀，剥到不再匹配为止。前缀表与顺序不变，`normalize(normalize(x)) === normalize(x)`。这保证两侧无论报出几层前缀，最终落在同一个匹配键上。

新增维护命令 `maintain normalize-response-ids`，默认预览，`--apply` 需要 `--approval-id`：

- 按当前规则重算 `request`、`pending_hook`、`raw_ledger` 的 `response_id_norm` 存量列；`raw_ledger` 的原始 `response_id` 不动。
- 随后循环调用 `reconcilePending`，把唯一候选的等待项并入路由行；多候选保持 pending，不取首条猜测。
- 合并沿用 `mergeHookInto`：正文迁到目标行，重复行删除，证据改 `merged`。
- 只改派生列与等待队列，不动正文、不改 schema。

命令幂等：第二次运行时三个存量计数都是 0，已合并的等待项不再出现。

## Alternatives considered

**只在 hook 入口多剥一层。** 只能修 OMP 这一种层数，账本侧已有的 `chatcmpl-msg_…` 与其它组合仍在；匹配规则会从一处变成两处。落选。

**在 `findCandidates` 里同时查新旧两种键。** 存量能合，但同一事实有了两个匹配规则，后续每加一层前缀都要再补一条查询。落选。

**按 session 加时间近邻合并孤儿回调。** 13 条 OMP 与 1101 条 Claude 孤儿都按时间对得上，但同一会话的并发请求会给出多个候选；这等于把猜测写进证据。本次不做，重开条件是有能排除并发的额外证据键。

**重投影全部请求，而不是直接更新存量列。** 投影会从 `raw_ledger.payload_json` 重新映射出同一个值，结果等价，但要把 3 万多行都跑一遍派生。存量列本身就是原始 id 的一层剥离结果，直接重剥更窄。落选。

## Consequences

- 新到的 hook 不再受前缀层数影响；OMP 的 22 条 hook 行会并入路由行，会话里同一笔调用只剩一行，正文与四格读数同屏。
- 745 行存量键被重算：22 行与路由行同键后合并，其余 723 行只是换键；其中多数是 hermes 的 `chatcmpl-msg_…`，没有同键邻居。
- 费用匹配继续一致：`matchCostRow` 用同一套规范化规则，存量键也同步重算，不会因为一侧升级变成 `ambiguous`。
- 13 条 OMP 孤儿与 Claude 的 1101 条仍在等待队列；`hook-delivery` 的 `missing_without_response_id` 口径不变。
- 维护命令成为这次修复的一部分。它要求采集器已停止，与其它写库命令相同。
- 不升 `PURPOSE_VERSION`，不改接口与 schema；派生结论不受影响，`response_id_norm` 只参与证据匹配。

## Testing

`tests/magpie.test.ts` 锁定规范化：`chatcmpl-msg_…`、`msg_resp_…`、`resp_msg_…`、双层 `chatcmpl-` 都剥到同一个裸值；前缀本身不产出空键；结果幂等。`tests/hook.test.ts` 锁定回归：hook 回执带 `chatcmpl-` 时仍直接并入裸 hash 的账本行，只剩一条请求。`tests/response-ids.test.ts` 锁定维护命令：合成旧库一行 hook 行加一行路由行，预览报 1 行请求、1 条等待项、1 行原始账本、1 个唯一候选；应用后正文迁到路由行、hook 行删除、证据 `merged`、原始账本键重算；重复执行计数归零。

`bun test tests/magpie.test.ts tests/hook.test.ts tests/response-ids.test.ts` 64 例通过，`bun run typecheck` 通过。生产库的真实写入与只读复核记在[验收记录](../../../../docs/acceptance.md)。