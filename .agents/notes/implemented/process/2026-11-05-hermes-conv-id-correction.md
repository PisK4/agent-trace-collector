# Agent Note: 更正 Hermes 侦查归因——conv id 是从请求正文确定性派生的

Status: implemented

## Problem

[Hermes 本地来源侦查](2026-11-05-hermes-local-source-recon.md)把网关侧 4,787 行与本地 `state.db` 的会话 id 零交集归因为「两套会话命名空间」，并据此推断「补本地解析器会把同一批调用第二次送进库」不成立、批次 C 的「先解决去重」既非必要也不充分。用户 2026-11-05 明确「Hermes Agent 是肯定要接的」，随后派 subagent 查对接方案。核查发现零交集这个读数是对的，归因错了：网关侧 conv id 并非另一套互不相干的身份，而是由请求正文首条 user 消息确定性算出的摘要，仓内已有同一口径的实现。归因错误会让下一步围着「要不要新建身份锚点」打转，必须先更正。

## Decision

**网关侧 conv id 的口径已在生产代码里。** `repos-external/magpie/internal/gateway/gateway.go:6723` 的 `conversationID` 取请求体 `messages`/`contents`/`input` 中首条 `role="user"` 元素的原始字节，算 SHA-256 取前 12 字节 hex，加 `magpie-` 前缀；注释写明后续每个 turn 都会重复首条 user 消息，所以这个 id 是会话级稳定锚点。ATC 在 `src/hook.ts:100` 的 `convDigestOf()` 里用同一口径（提交 `9629a57`，见[hook 会话摘要](../bug-fix/2026-11-02-hermes-hook-conv-digest.md)）为缺 session 的 hook 行自算 `["conv", "magpie-<digest>"]`。

**生产库复算全量命中。** 从 `request_block` 取首条 `role=0`（user）块，用 `node:zlib` 的 `zstdDecompressSync` 解压 `block.z`、按 `JSON.stringify({role:'user', content})` 序列化后套上述公式，对 `agent='hermes'`、`body_state='available'`、`conv_key` 为 `["conv", "magpie-…"]` 的行逐笔比对：3,745 / 3,745 命中，0 miss、0 解压失败、0 无块。4,721 个 conv 行全部是 `magpie-` + 24 位 hex，形状一致；69 个 `["hook", <UUID>]` 是摘要算不出的失败行，走的是 11-02 note 里已有的回退路径。这次用的是 ATC 自己存的请求正文与仓内序列化口径，不依赖 Hermes 本地库的格式反推，比按本地 user 行重算更可靠。顺带把 11-02 note 留作未复测的「真实库摘要保真度」验收项在更大样本上做实了。

**更正后的因果。** 零交集成立的原因是网关侧用内容哈希、本地 `state.db` 用 `sessions.id`/`session_key`，两者本来就不该字符串相等；这不代表两边看的不是同一批调用，也不代表关联无解。按日聚合两侧读数接近（10-29 网关 448 行 / `in_tok` 5,461,960，本地 445 次 / 5,461,677），subagent 报告里的这条只读对账可作方向佐证，但它是聚合比较，不是逐笔配对，未作为本记录的结论依据。本地库缺逐笔调用记录这条事实不变：`session_model_usage` 仍是 `(session, model)` 聚合，assistant 行 `token_count` 仍全空。

**对路线的影响（待用户拍板，本轮不改）。** 覆盖矩阵批次 C 的前置条件「先落地多来源身份归一」在侦查记录里被判为「既非必要也不充分」；其中「非必要」的理由原本是零交集，现在要换成更准的表述：网关侧已有确定性会话锚点，本地会话不会被当成另一批调用重复建行，需要解决的是本地会话如何挂到这个锚点上，而不是等去重提案落地。去重提案本身不动，它对 zcode 等来源的实测样本仍成立。矩阵正文、侦查记录原文与提案 note 都按用户「路线暂不改」的选择保留，本记录只更正归因并留指针。

## Alternatives considered

**改写侦查记录原文，把「两套命名空间」整段替换掉。** 按 [implemented note 规则](../AGENTS.md)，决策依据反转必须另写新 note 并互相链接，不能把已交付记录改成相反结论。旧记录里「零交集」「本地缺调用级记录」「时间范围重叠」这些读数依然正确，只有归因和由此推出的路线判断需要更正；用新记录承载更正，旧记录加一行指针。

**把 subagent 的本地 user 行重算（119/153 命中）当主证据。** 那是按 Hermes 本地库的消息形状反推序列化，subagent 自己也标注「未见 Hermes 源码权威确认」。改用 magpie 源码 + 仓内 `convDigestOf` + 生产库 3,745 笔复算，三层都落在已受控的代码与数据上，不依赖对外部库格式的猜测。

**据此直接把 Hermes 降为不排期，或立刻开工写适配器。** 用户上轮明确选择「先记结论、路线暂不改」；本轮只说「肯定要接」，没有批准具体接入形态（逐笔调用还是会话级补充、`session_usage` 是否保留 model 维度、锚点放适配器还是独立 crosswalk 表）。subagent 列出的三项待拍板决定仍悬着，不在本记录里替用户选。

**顺手把 11-02 note 的 Verification 段改成「已验收 3,745」。** 那篇 note 记的是 63 条失败 hook 的保真度口径，与本次 3,745 笔的样本范围不同；直接改写会把两个验收混成一个。本记录写明「更大样本上做实了同一保真度」，不改旧 note 的验收范围。

## Consequences

收益：下一步不必再找「新的身份锚点」——仓内已有 `convDigestOf`，magpie 有 `conversationID`，生产库 3,745 笔复算证明口径一致。Hermes 接入方案可以围绕「本地会话挂到 conv 摘要」展开，比从零设计 crosswalk 短得多。11-02 遗留的真实库保真度验收也有了实测结果。

代价：侦查记录里那句「补本地解析器会把同一调用第二次送进库不成立」现在要读作「按 id 字符串对齐不成立，但按内容摘要可以对齐」，读者必须同时看两篇记录才得到完整判断；这是按 Agent Note 规则保留历史归因的必然后果，等路线定稿时一次性把矩阵与侦查记录的指针收齐。

仍未解决：`messages.timestamp` 的精确语义未校准；本地侧按 user 行重算有 34 个会话未归因；11-01/11-03 两日两侧行数不吻合的原因未查；按日聚合只证明量级接近，没有逐笔配对。接入形态的三项决定等用户拍板。

相关：[Hermes 本地来源侦查](2026-11-05-hermes-local-source-recon.md)（本记录更正其归因）、[hook 会话摘要](../bug-fix/2026-11-02-hermes-hook-conv-digest.md)、[覆盖矩阵提案](../../proposed/feature/2026-11-04-agent-coverage-matrix.md)、[多来源身份归一提案](../../proposed/feature/2026-11-04-multi-source-call-identity.md)。
