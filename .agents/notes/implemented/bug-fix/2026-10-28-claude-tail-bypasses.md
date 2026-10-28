# Agent Note: Claude 的 suggestion 与压缩请求按末尾块首登记为旁路

Status: implemented

## Problem

2026-10-28 的生产前端走读发现，Claude Code 的两族旁路请求被算进了主链：suggestion 生成与上下文压缩。它们在界面上占着轮次起点，把注入模板当用户命令渲染。规划期实测：82 条带指纹的行全部是 `delta + confirmed + final`，其中 43 条已经是 `chain_role='main'`。

两族的强指纹都写在**最后一条 user 消息**的块首：

- suggestion：`[SUGGESTION MODE:`
- 上下文压缩：`CRITICAL: Respond with TEXT ONLY`

[request-purpose.ts](../../../../src/request-purpose.ts) 的旁路取数 `purposeUserBlockHeadsTx` 只解前 5 条 user 消息。长会话里模板贴在末尾，前 5 条全是历史对话，两族指纹一条都取不到。照抄 OMP skill 压缩的写法会 0 命中，必须先补末尾取数。

## Decision

`PurposeView` 增加 `tailUserBlockHeads`：末尾 2 条 user 消息的文本块块首，条数与块首长度沿用 `PURPOSE_USER_MESSAGES` 与 `PURPOSE_HEAD_CHARS` 同一组限额，成本不随正文体积增长。两族指纹都只在这里匹配，前几条 user 消息里的同款文本不参与——那是历史上下文，不是本次旁路模板。

[claude.ts](../../../../src/harness/claude.ts) 增加 `suggestionDecision` 与 `compactionDecision`，各返回 `chain: 'exclude'`，kind 分别为 `suggestion_mode` 与 `context_compaction`。两条规则在 [purpose.ts](../../../../src/harness/purpose.ts) 的登记数组里紧跟分类器；命中即认，不拿消息数或工具数当门槛——上游改形状时仍应认出这是旁路，而不是退回普通对话。

`PURPOSE_VERSION` 5→6：用途结论变化，旧行不得冒充新结论。版本只影响之后被标脏或被显式重建的组；历史行必须按会话 `maintain rebuild` 换代。

## Alternatives considered

**把 `userBlockHeads` 的取数扩到全部 user 消息。** 长会话的 user 消息可能有几百条，解压成本随正文体积增长，而旁路模板只出现在末尾。按位置取尾部 2 条，限额不变。不采用。

**按回复形状识别（压缩请求的回复以 `<analysis>` 开头）。** 回复是结果不是输入，同一形状可能来自普通请求；而且 suggestion 没有稳定回复形状。指纹在输入侧且足够强。不采用。

**把两族指纹合进分类器规则。** 分类器有 system 与 stop_sequences 的强指纹，suggestion/压缩没有；合并会让分类器规则变成多个来源的 OR，失败原因也说不清。三条独立规则各自返回自己的 kind，页面能分开表达。不采用。

**在读取侧改判而不升 `PURPOSE_VERSION`。** 已存的 `purpose_rule` 与 `purpose_chain` 会与新判据不一致，且重建路径无法识别哪些行需要重算。版本是换代的唯一依据。不采用。

## Consequences

- 得到：suggestion 与压缩请求进入旁路，不再占轮次起点、不再把注入模板当用户命令渲染；两族在界面上可以分开读。
- 代价：历史行在重建前仍显示旧结论。生产采集器运行旧代码期间 rebuild 会被后续流量回写覆盖，收敛以新代码上线为前提；重建窗口与验收见[验收记录](../../../../docs/acceptance.md)。
- 末尾 2 条是经验窗口：如果上游把模板放到更靠前的位置，取数需要调整。两族指纹是强前缀，误判风险低于漏判。

## Testing

- `tests/semantics.test.ts`：两族指纹在 `tailUserBlockHeads` 命中；同款文本只在 `userBlockHeads` 时不命中。
- `tests/request-purpose.test.ts`：模板贴在第 6 条 user 消息（前 5 条之外）时 `tailUserBlockHeads` 取得到，结算后 `purpose_chain='exclude'`。
- `tests/harness-purpose.test.ts`：生产登记含 claude 三条规则，次序固定。
