# Agent Note: 回复协议拆分收敛进 replyView 单点

Status: implemented

## Problem

同一个 `meta.reply` wire 对象被拆分两遍：`body-view.js` 的 `replyView` 拆出 state/finish/calls 与调用路径前缀 callBase，`trace-view.js` 的 `projectSteps` 又重算一遍 replyBase 并重跑 `messageBlocks` 来出中栏的回复步骤行。两处各自维护「anthropic 读 content 数组、chat 读 choices[0].message」的协议分叉：块路径靠两边拼出相同字符串（`reply.content[i]`、`reply.choices[0].message.tool_calls[i]`），多 choice 的判定只在第二处、读取的是原始 choices 数组。回复形状再变（比如新的回复协议字段）时必须同时改两处，且两处对同一对象的解释可能悄悄分叉。`projectSteps` 里还有一段 `blocks.length === 0 && view.text.length > 0` 的兜底步骤行，但两边跑的是同一套归一化，该条件不可达。

## Decision

`replyView` 成为回复协议形状的唯一拆分点。返回值在原有 state/text/thinking/calls/finish/model/raw 之外新增 `blocks` 与 `choiceCount`：blocks 按协议原始顺序给出，块路径从回复根算起（`reply.content[i]`、`reply.choices[0].message.*`），序号沿用协议内位置；choiceCount 声明 chat 原始 choice 项数（非 chat 协议为 null），多 choice 不在拆分点隐瞒。`projectSteps` 只消费 view：按 choiceCount>1 出「保留原始对象」的记录行，否则遍历 `view.blocks` 出文本/调用/未知块步骤；不再 import `messageBlocks`，不再触碰 `meta.reply`。不可达的兜底步骤行删除。步骤键、source 路径、多 choice 与无效回复的行为全部保持不变（57 例窄测试零修改通过）；右栏对多 choice 仍显示 choice0 文本的现状也保持——中栏不拆行的限制由调用方按 choiceCount 判定，拆分点不替调用方做这个决定。

## Alternatives considered

**trace-view 反向吞并 replyView。** 中栏与右栏消费同一份归一化，但 replyView 先存在且消费面更广（toolEntries、callOf、replyCompleteness、renderReply），归它更自然。

**多 choice 时 replyView 拒绝结构化（blocks 置空）。** 会改变右栏现状（choice0 文本仍可读），超出本单元「行为保持」的边界；限制作为数据声明，展示取舍留给调用方。

**保留兜底步骤行。** 兜底条件在两边解析等价的前提下不可达，留着会让读者以为存在一条真实路径；按删除测试原则摘除，并在测试中锚定无效回复不带块。

**顺带统一工具呈现。** tint 已单家（`toolTint`，四消费面共享），截断预算按用途刻意分立（rail 60、chip 90、行内靠列宽），收拢只会制造假共享。

## Consequences

回复形状相关的阅读面改动从此只碰 `body-view.js` 一处；`ReplyView` 类型增两个字段，所有既有消费面是纯增量。将来右栏想对多 choice 给出专门说明（而不是显示 choice0），只需消费 choiceCount，不再需要重新解析原始对象。工具呈现的统一仍被搁置，理由见上。

## Testing

- `bun test tests/body-view.test.ts tests/trace-view.test.ts` 57 例 0 失败：既有 56 例在实现改动后零修改通过（行为保持的直接证据），新增两处锚定——blocks 的全路径与协议序号（两协议）、choiceCount 的 null/1/2 与无效回复不带块、choice 结构损坏时仍先声明多 choice 限制。
- `bun run typecheck` 通过。改动仅 touches 现有 web 模块，无 STATIC_FILES 变更，生产端 launchd 服务不需要重启。
