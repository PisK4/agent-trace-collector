# Agent Note: 配对页返回记住来路

Status: proposed

## Problem

从读数页或正文页点「配对两端 ▸」进配对页，返回时落点不是来处。

- 点「← 返回请求」：落回工具页签的调用列表。
- 按 Esc：落到读数页。

两条路都不回原页面。复现（`applyIntent`，合成数据）：

```
起点:        {railTab:'body', selectedStep:'7:message:3'}
点配对两端:  {railTab:'tools', selectedStep:'7:call:1', toolPage:'pair'}
点返回请求:  {railTab:'tools', selectedStep:'7:call:1', toolOrd:null}
按 Esc:      {railTab:'facts', selectedStep:'7:call:1'}
```

根因在 [web/selection.js](../../../../web/selection.js)：`open-pair` 为渲染配对页硬写 `railTab: 'tools'`，同时把 `selectedStep` 覆盖成调用步骤；`close-tool` 只清工具选择，不回滚页签与选中步骤。配对页只能挂在工具页签下（`railTools` 只在 `railTab === 'tools'` 渲染），改页签本身是必要的，丢的是「改之前是什么」。

## Proposal

选择元组加一个字段：

```js
toolOrigin: { railTab, selectedStep } | null
```

- `open-pair`：进入前记录 `{railTab, selectedStep}`，再照旧写工具选择与页签。配对入口出现在正文详情、结构折叠与会话汇总列表里（`data-tool-owner` 与 `data-summary-pair`），都在工具页之外，进到这里时 `toolOrd` 为 `null`；写入前补一句判空，`toolOrd` 非空时不覆盖上一段来路。
- `open-tool`（从工具页签列表进）：置 `null`。它本来就在工具页签里，返回即回调用列表。
- `close-tool`：有来路就恢复 `railTab` 与 `selectedStep` 并清空 `toolOrigin`，效果里补 `render-main`（中栏高亮要跟着回）；没有来路维持现行——`andTab` 为真回读数页，为假留工具列表。

Esc（`andTab: true`）与「← 返回请求」（`andTab: false`）共用这条规则：有来路时两者都回来路，`andTab` 只在无来路时决定默认落点。

`app.js` 的初始 state 与 `SELECTION_KEYS` 同步加字段。`updateURL` 已按 `railTab` 写 tab 参数，恢复后 URL 自动一致。

### 不变量

`toolOrigin` 的寿命与 `toolOrd` 一致：凡是把 `toolOrd` 清成 `null` 的意图都要同时清 `toolOrigin`（`open-session`、`restore-url`、`locate`、`select-step`、`select-message`、`select-delta`、`select-turn`、`select-latest`、`select-first`、`open-offpage`、`tool-gone`、`close-tool`），`open-tool` 也要清；`open-pair` 只在 `toolOrd` 为 `null` 时写入。

还有一个例外要单独处理：`select-tab` 不清 `toolOrd`（现在从配对页直接点「正文」会留下陈旧的工具选择），但它是一次明确的离开，必须清 `toolOrigin`。否则用户在配对页点了「正文」，之后按 Esc 会被送回更早的来路。

这条不是洁癖：全局 Esc 在任何页面都会发 `close-tool`。如果清了 `toolOrd` 却留着 `toolOrigin`，用户读完别的步骤后按 Esc 会被送回上一次的来路。实现时让 `toolOrigin: null` 跟着 `toolOrd: null` 走，`select-tab` 单独补一句。

## Alternatives considered

**`open-pair` 不改页签，配对页做成覆盖层。** 页签条会高亮在错误的页上，URL 的 tab 参数与显示也对不上。

**用浏览器 history 回退。** 现在全程 `history.replaceState`，没有可回退的条目。

**只记页签、不记选中步骤。** 从正文页的消息详情进入时，`selectedStep` 已被改成调用步骤；只回页签会显示调用详情，不是原来那条消息。

**滚动位置一并记忆。** `renderRail` 的滚动键是 `turn:reqId:railTab`，页签变化即回顶。要记忆得按页签存位置，是另一笔改动。用户 2026-10-29 同意本轮不记忆。

## Acceptance criteria

- 从读数页进入配对，返回落回读数页，原选中步骤仍在。
- 从正文页消息详情进入配对，返回落回正文页，仍显示那条消息。
- 从工具页签列表进入配对，返回落回工具列表。
- Esc 与「← 返回请求」在有来路时落点一致。
- URL 的 tab 参数与恢复后的页签一致。
- `tests/selection.test.ts` 覆盖上述四条。

## Risks

- 滚动位置不恢复，回到长页面会回顶。
- 会话汇总条目进入的配对页（`data-summary-pair`）返回时页签能回，但汇总列表本身不恢复：`summaryList` 是装配层瞬态，不进选择元组。
- 这条兑现[选择状态的唯一写者](../../implemented/architecture/2026-10-25-selection-single-writer.md)里悬置的「Escape 半清等现状留待单独判断」；实现 note 要链接回去，说明该悬置项已收口。
