# Agent Note: 空回复继承正文状态

Status: implemented

## Problem

2026-10-28 的生产前端走读发现三个症状指向同一处缺陷：读数页写「上游没有提供可用回复」、中栏 Event 行写「未收到回复」、OTLP 行的完整性标签写「缺失回复」。三者都断言了同一件事——上游确实没有回复，但真实情况常常只是正文还没到。

[body-model.js](../../../../web/body-model.js) 的 `replyView` 把所有「没有回复对象」的正文页一律折成 `state='absent'`，丢掉了 `BodyPage.state`。正文页的 `state` 是采集侧的事实：`pending`（hook 尚未回调）、`evicted`（正文已回收）、`summary`（OTLP 摘要）、`partial`（正文不完整）、`unsupported`（协议未适配）。这五种状态里，只有「正文可读且服务端明说没有回复对象」才是真的缺失回复。合并成一态后，页面无法区分「再等等」与「没有」，读者拿到的结论比证据强。

## Decision

`ReplyView.state` 的联合从 `'ok' | 'absent' | 'invalid'` 扩到再加 `'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial'`。空回复时由 `emptyReplyState(page)` 继承正文状态，规则按证据强度排序：

1. 正文状态是上述五态之一，直接继承——那是采集侧对本笔正文的事实，比回复判定更根本。
2. 正文可读时看 `reply_state`：`invalid` 表示回复对象存在但无法结构化，`unsupported` 表示协议未适配。
3. 剩下才是 `absent`：读得到正文、服务端明说没有回复对象。

三个消费端按同一份状态各自出文案：

- [body-view.js](../../../../web/body-view.js) 的 `EMPTY_REPLY` 文案表按状态给标题与说明：未到可等，回收与摘要不可等，缺失才是真的没有。
- [row-summary.js](../../../../web/row-summary.js) 的 `replyCompleteness` 把 `absent` 留给「缺失回复」，其余状态一律 `key='unknown'`——完整性未判定不等于缺失。
- [trace-view.js](../../../../web/trace-view.js) 只在 `absent` 时记 `missing_reply`；`partial` 单列一条说明；`invalid` 记无法结构化；其余状态不再补事件，因为正文状态行已经说明，同屏两句话互相打架比少一句更糟。多 choice 分支提到状态分支之前：它是回复对象的形状事实，结构损坏时仍要保留原始对象。

收尾检查从 `view.state !== 'absent'` 收紧成 `view.state === 'ok'`：截断与未知停止只在真读到回复时才有意义。

## Alternatives considered

**只改文案，让 absent 的说明更模糊。** 页面仍然无法区分可等与不可等，且 `replyCompleteness` 继续把未到的回复标成缺失。文案模糊化只是把错误结论包装得更含糊。不采用。

**在展示层按 `row.body_state` 重新判定，不改 `ReplyView`。** 三个消费端各判一次 `body_state`，判据复制三份，且 `ReplyView` 继续丢信息——下一个消费方还会踩同一个坑。`replyView` 是回复归一化的唯一拆分点，状态在那里定一次。不采用。

**新增独立的 `ReplyAbsence` 类型，与 `ReplyView` 并列。** 空回复仍然要占 `ReplyView` 的位置（`renderReply` 与 `replyCompleteness` 都接它），并列类型会迫使每个消费端先判用哪个。扩联合值改动最小。不采用。

## Consequences

- 得到：正文未到、已回收、摘要与部分正文在三个消费端分开报；「缺失回复」恢复原义——读得到正文却没有回复对象。
- 代价：`ReplyView.state` 从三值扩到八值，新增消费方必须穷举。`body-view.js` 与 `row-summary.js` 都用文案表兜住全部取值，漏一个会在类型检查里暴露。
- 正文可读、`reply_state='ok'` 但 `reply` 为 null 的行仍落 `absent`——那是服务端与正文块的真实矛盾，页面照实说没有回复对象，不猜哪一侧错了。

## Testing

- `tests/body-view.test.ts` 新增用例覆盖五种正文状态的继承、`available + absent` 仍落 `absent`、以及 pending/evicted 的文案与完整性标签。
- `tests/trace-view.test.ts` 新增用例断言正文未到的请求只有 `正文状态：pending` 一行，没有「未收到回复」；既有的多 choice 与回复完整性用例继续通过。
