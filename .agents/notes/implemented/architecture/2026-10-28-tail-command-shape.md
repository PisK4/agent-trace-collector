# Agent Note: 用输入收尾形状补 tail 的命令证据

Status: implemented

## Problem

轮次起点需要命令证据。派生期能拿到的证据有两种：

- 相对可读前驱的确定增量 `delta`，写进 `input_preview_kind='delta'`。
- 正文回收后保留的旧 kind 位。

两者都要求前驱可读或曾经可读。会话 `0a950369` 的命令行落在 `tail`：前驱正文不可读，delta 算不出来，`tail` 又只说明「末轮输入」——轮次读取无法把它与「只是回传工具结果」分开，整场会话的轮次数因此是 0。

但这一笔输入有一个可靠的结构事实：它以用户主动文本收尾，而不是工具结果。这个事实在派生期可判，不需要前驱正文。

## Decision

`input_preview_kind` 增加取值 `tail_command`：关系未知、另起一支或排除用途的行，在 `tail` 分支里再判一次末条消息形状。末条是用户主动文本记 `tail_command`，否则仍是 `tail`。

判定在 [read.ts](../../../../src/derive/read.ts) 的 `lastUserMessageIsCommand`：从末尾往前跳过 system 消息与注入型 user 消息（归档、技能注入、系统提醒都是壳），遇到工具结果或 assistant 消息即停，最多看 6 条。判据与 `interpretMessage` 同一套——只有 `state='text'` 算用户主动文本，wrapped 与 midturn 都算，注入不算。

[轮次读取](../../../../src/queries/turns.ts)的命令判据随之接受两个值：`delta` 或 `tail_command`。`branch` 与 `aux` 行仍不进带，排除在 `purpose_chain='participate'` 与起点资格两层完成。

`tail_command` 只新增取值，不改表结构：列是 `TEXT`，无 DDL，无需 backfill 脚本。历史行靠 `maintain rebuild --session` 按会话换代。

### 为什么不升派生算法号

`GROUP_ALGORITHM` 与 `DERIVE_ALGORITHM` 的语义是「产物变化时旧结论不得冒充新结论」。这次产物确实多了一个取值，但影响面可以精确圈定：只有「参与链 + 前驱关系 unknown + 当前 kind=tail」的行可能翻成轮起点，其余 tail 行的取值只影响标签文字。

升版会让所有未重建会话的 `session-summary` 事实已知性按算法号失配，整库汇总退化到未知，直到逐个重建——代价远大于收益。本决策选择按会话显式重建这批行，在同一个部署窗口完成；重建清单与验收见[验收记录](../../../../docs/acceptance.md)。

否决这条取舍的边界：如果以后出现第三类需要「所有 tail 行重新判定」的变更，升版仍然必要，届时应整体重建而不是继续按清单点修。

## Alternatives considered

**把所有 tail 行都标成 `tail_command`。** 工具回传的 tail 行会被误标成命令，轮次带会为每一笔工具往返都开一轮。判据必须看末条消息形状。不采用。

**按消息数量或工具调用数当门槛。** 上游改形状时门槛会失效，而末条消息的类型是协议里的稳定字段。不采用。

**在读取侧从正文现判，不写派生位。** `listTurns` 是只读快照内的结算，不读正文块；把正文读取塞进轮次查询会让每次翻页都解压消息。派生期写一次，读侧只读列。不采用。

**给所有 `tail` 行加一列布尔位而不是新 kind 取值。** 需要 DDL 与全库 backfill，且 kind 列本来就是「摘要是什么」的枚举，多一个取值比多一列更贴近它的职责。不采用。

## Consequences

- 得到：前驱正文缺失时，真实的命令行仍能成为轮次起点；工具回传的末轮输入不会被误判成命令。
- 代价：判定要多解压末尾最多 6 条消息，成本有上限；正文已回收的行仍判不出来，保持 `tail` 或保留旧 kind。
- 历史行在新代码上线并重建前仍显示旧 kind；重建窗口与验收记录绑定，不把「未重建」写成「已修复」。

## Testing

- `tests/turn-settlement.test.ts`：四笔「命令 + final」回收第一笔后期望 `[1, 2, 3, 4]`；末条是工具结果的反例期望 `[1]`；既有回收起点用例更新为 `[1, 2]`。
- `tests/derive-presentation.test.ts`：纯函数用例断言 `delta === null` 时按 `lastUserMessageIsCommand` 产出 `tail_command` 或 `tail`；aux 行更新为 `tail_command` 且注明不进轮次带。
