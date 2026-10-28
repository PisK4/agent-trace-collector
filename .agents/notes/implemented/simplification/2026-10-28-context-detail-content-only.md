# Agent Note: 上下文明细条目内容直出

Status: implemented

## Problem

用量与上下文弹窗的条目正文（`entryContentHtml`，[web/context-detail.js](../../../../web/context-detail.js)）曾在每个展开条目下固定挂一个「原始对象」折叠。抽得出文本时，文本下面再压一份完整 JSON；抽不出文本时，这个折叠是唯一能看到内容的地方。

这个弹窗是逐条核对「这块占多少 token、里面是什么」的界面。读者点开一条，期望直接读到内容，而每次展开都多一层，两层读的又是同一份东西。

2026-10-28 的用户反馈：点开某个细节之后直接展开详细内容，不需要「原始对象」这个模块。

直接删掉折叠会留下空白：`contentTextOf`（同文件）只覆盖字符串、文本块、`text`/`output` 字段与图片/推理块的占位标注，其余形状返回 `null`。`contentTextOf({role: 'user', content: 'hi'})` 就是 `null`，而正文页消息条目的 `data.messages[0].value` 正是整条消息对象，这类条目当时只有原始对象折叠里有内容。

## Decision

条目展开即内容，只渲染一层：

- 抽得出文本：`<pre class="ctx-d-text">` 直接给文本。
- 抽不出文本：同一位置的同一个 `<pre class="ctx-d-text">` 给缩进 JSON（`JSON.stringify(value, null, 1)`），不包 `<details>`。

两条分支共用 `.ctx-d-text`，`max-height: 300px` 与内部滚动同时覆盖 JSON 分支，长条目不会把弹窗撑高。`.ctx-d-raw` 的标记与四条样式规则（[web/app.css](../../../../web/app.css)）删除，弹窗 DOM 里不再出现「原始对象」字样。`entryContentHtml` 的 JSDoc 同步改口径。

`bun test tests/context-detail.test.ts` 锁定新行为：文本条目只渲染一份内容；整条消息对象直出 JSON、不出现折叠；`is_error` 与不可读状态说明照旧。

## Alternatives considered

**保留折叠但默认展开。** 多一层 `<details>` 仍然要在视觉上解释自己，默认展开等于承认它不承担折叠职责；用户点名要去掉的就是这个模块。

**只删折叠、不做兜底。** 正文页消息条目（整条消息对象）会渲染成空白，比多一层折叠更糟。否决。

**抽得出文本、但块数组里有丢弃块时，文本之后再给一份 JSON。** 能保住有损抽取的完整信息，代价是同一屏出现两份内容，与「内容直出」的初衷相反。本轮按单一来源交付；出现「文本缺了某块」的真实阅读痛点时再启用这条。

**给 JSON 分支单独加类名与样式。** 会多一条只在一条路径上用到的规则，而 `.ctx-d-text` 的等宽、换行、限高与滚动对两者都成立，直接复用。

## Consequences

收益：每条展开只剩一份内容，逐条核对不用多点一次；正文页消息条目从空白变成可读的 JSON；样式少四条规则。

代价：`contentTextOf` 是有损抽取，块数组里返回空串的未知块会被丢掉，抽得出文本的条目看不到这些块；兜底 JSON 直接铺开，长条目的展开高度比原来折叠时大，靠 `max-height: 300px` 内部滚动约束。

与[上下文矩阵布局与点击明细](../feature/2026-10-26-context-treemap-drilldown.md)的关系：弹窗结构、目录查询与按需读正文的决定不变，本次只改条目正文的呈现层。
