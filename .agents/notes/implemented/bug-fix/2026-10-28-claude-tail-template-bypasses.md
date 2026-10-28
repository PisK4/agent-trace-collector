# Agent Note: Claude 的末尾模板族与权限审查分类器新形状登记为旁路

Status: implemented

## Problem

生产重建后的真实流量验收发现轮次带仍被注入模板占着。全库 624 个已结算轮里有 451 个起点是 harness 写的固定文本，而不是用户原话，直接违反验收判据「起点命令文本是用户原话，不含模板」。

按起点文本聚类，模板集中在五族，全部写在**最后一条 user 消息的块首**：

| 块首 | 行数 | 实际身份 |
| --- | --- | --- |
| `Review the classification process and follow it carefully` | 281 轮起点 / 393 行 | 权限审查分类器（新形状） |
| `Describe your most recent action in 3-5 words` | 159 轮起点 / 897 行 | 状态栏的动作描述生成 |
| `Tool loaded.` | 10 轮起点 / 37 行 | 工具装载通知 |
| `Perform a web search for the query: ` | 7 轮起点 / 10 行 | WebSearch 的内部检索请求 |
| `Current state: working (for ` | 4 轮起点 / 5 行 | 运行中状态栏 |

`The user stepped away and is coming back.`（104 行）在 `input-interpretation` 里已按 system_notice 丢弃文本，但派生期的 `tail_command` 判据看的是消息级 `state === 'text'`，这条判据走的是另一份解释，于是它照样成了轮起点。两处解释不同源，是这一族漏检的直接原因。

权限审查分类器是**另一支分类器**：没有 system 与 stop_sequences，首条 user 消息是 `The following is the user's CLAUDE.md configuration.` 上下文，末条是 `<transcript>` 加审查指令，回复仍是 `<block>yes|no</block>`。[claude.ts](../../../../src/harness/claude.ts) 的旧分类器规则要求 system 文本与 `</block>` 双指纹，这一支两条都拿不到，因此 393 行全部落 `unrecognized`。

## Decision

`claude.ts` 增加两条规则：

- `classifierReviewDecision`（`claude.auto-mode-classifier.v2`，kind 仍是 `auto-mode-classifier`）：`userBlockHeads` 含 CLAUDE.md 上下文前缀、且 `tailUserBlockHeads` 含审查指令前缀，两条缺一不可。裁决沿用同一份 `verdictOf`（抽成函数，与旧分类器共用）。
- `tailTemplateDecision`：一张 `TAIL_TEMPLATES` 表，前缀 → 规则与 kind，五族各一条（`action_description`、`recap`、`status_line`、`web_search`、`tool_loaded`）。命中即认，不拿消息数或工具数当门槛；前缀只在块首生效，用户正文里提到同款句子不算。

两条都登记在 [purpose.ts](../../../../src/harness/purpose.ts)，claude 的规则数从三变五，次序为旧分类器 → 新分类器 → suggestion → 压缩 → 末尾模板族。`PURPOSE_VERSION` 6→7。

## Alternatives considered

**只补 `The user stepped away` 一族的解释源，让 `input-interpretation` 与 `tail_command` 判据同源。** 能修 recap 一族，但另外四族（尤其 281 个轮起点的权限审查）不是包装文本，是真实的请求语义；只统一解释也识别不出它们是什么。不采用。

**把模板判定写进 `input-interpretation` 的 DROP 规则。** 那会让页面上的用户气泡消失：这些请求的正文仍要被阅读，只是不进主链。旁路是用途结论，不是文本清洗。不采用。

**按回复形状（`<block>` 开头）识别权限审查。** 形状与旧分类器相同，但按回复判定会让正文回收后的行无法重算；指纹在输入侧，回收后块首不再可读时按旧解释保留（`unavailableDecision`），与既有旁路一致。不采用。

**给五族各写一条判定函数。** 五族都是「末尾块首等于某个固定前缀」，写成一张表比分五个导出函数少四处重复，新增一族只加一行。不采用分散写法。

## Consequences

- 得到：1585 行转入旁路（分类器 412、动作描述 977、recap 104、工具装载 78、检索 9、状态栏 5），涉及 60 个会话；轮次起点回到用户原话。
- 代价：`Describe your most recent action` 是唯一有下游请求的族（4 个 confirmed 子请求指向它），转旁路后这些子请求的父节点改指更早的参与祖先，配对与增量重算一次；`Tool loaded.` 的 42 个子请求同理。
- 五族都是经验前缀：上游改措辞会漏检，命中率随时间下降而不产生误判。块首长度 200 字符远大于这些前缀。
- 生产重建需要显式执行；新代码上线前重建会被旧结论回写覆盖，收敛以换版为前提。

## Testing

- `tests/harness-purpose.test.ts`：新分类器两条指纹缺一不可、裁决信号正确；五族模板各自命中对应 kind；正文中间的同款句子不命中；生产登记次序固定。
- 真实请求块首复核（只读，不进 fixture）：五族各取 5 笔生产请求，按派生同一套取数（`userBlockHeads` 前 5 条、`tailUserBlockHeads` 末尾 2 条）重跑 `classifyPurposeWithRules`，全部命中预期规则。
