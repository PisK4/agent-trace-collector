# Agent Note: 不确定闭包里的确定增量可以当轮次起点

Status: implemented

## Problem

[链角色不确定传播](2026-10-27-chain-role-uncertainty-propagation.md)把「关系 unknown 的节点及其 confirmed 后继」统一记成 `chain_role='unknown'`。轮次读取随之把起点资格收窄成「`main`，或 `unknown` 且自身 `prev_relation='unknown'`」，用意是排除不确定闭包里的后继。

这条排除把两类证据不同的行混在了一起：

- 不确定闭包后继的 `delta` 是相对**可读前驱**算出来的确定增量。用户命令的证据成立，只是归属无法证明。
- 正文回收的起点同样落 `unknown`，它的 delta 算不出来，靠保留的 kind 位进带。

规划期在 v5 链角色近似上模拟：当前 64 个会话 / 163 轮；只放宽起点资格得 78 / 296。被排除的行里有大量真实命令——2026-10-28 走读报告里轮次数为 0 的会话就是这样。

## Decision

`listTurns` 的起点资格不再看 `prev_relation`：`chain_role='main'` 或 `chain_role='unknown'` 都进候选。命令判据包括 `delta` 与后续增加的 `tail_command`，见[末尾命令形状](../architecture/2026-10-28-tail-command-shape.md)。

`chain_role` 回答这笔请求在主链上的位置能不能证明；`delta` 给出相对可读前驱的输入证据，不依赖链归属。归属证明不了，不等于命令不存在。

`branch` 仍然不进带：它能被证明与主链不相接，与「证明不了」是两个结论。

这一条不需要新的派生位，改完立刻对现有数据生效；正因如此，它必须排在旁路登记（`PURPOSE_VERSION` 换代）的重建之后上线，否则重建前的指纹行会被这条更宽的判据拉进轮次带。

## Alternatives considered

**在派生期给不确定闭包后继单独写一个「delta 可算」位。** 那正是本决策的判据，但需要新增列与重建回填；`input_preview_kind='delta'` 已经表达了同一事实。多加一位是把已有事实抄第二遍。不采用。[`tail_command`](../architecture/2026-10-28-tail-command-shape.md)处理另一种情况：delta 算不出来，只有输入形状可用。

**把整条不确定闭包都排除。** 闭包的后继 delta 相对可读前驱成立，排除它们会让证据最强的链延续从轮次带消失，正是走读报告里的缺陷形状。不采用。

**放宽到 branch，凡有 delta 就进带。** branch 的结论是「已证明与主链不相接」；把已证明的次链混进轮次带，轮次会跨两条链结算。不采用。

## Consequences

- 得到：不确定闭包里的真实命令重新成为轮次起点，会话轮次数回到与输入证据一致的水平。
- 代价：这些行的归属仍然未知；如果它们其实属于次链，轮次带会把两条链的片段并排展示。这是把「命令存在」与「命令在主链上」分开之后的必然代价，读者从正文状态与链状态行仍能看到归属证据不足。
- 轮次数增加会改变轮号全序；`from` 窗口语义不变，加载更早历史不重号。

## Testing

- `tests/turn-settlement.test.ts` 新增四笔「命令 + final」用例：回收第一笔后，第 3、4 笔的链角色落 `unknown` 且 kind 为 `delta`。本决策落地时轮次起点为 `[1, 3, 4]`，修复前为 `[1]`。
- 末尾形状判据落地后，第 2 笔成为 `tail_command` 起点，当前测试期望 `[1, 2, 3, 4]`；末条为工具回传的反例仍保持 `tail`，不作为起点。
