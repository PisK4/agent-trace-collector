# Agent Note: 右栏正文页与配对页去壳改行

Status: proposed

## Problem

右栏还剩两处把同一批事实包在 `body-panel` 里：正文页的消息、回复、System、回复块与未知块五类详情，头部一行放角色 chip、协议路径、动作按钮，下面 `bp-meta` 再补一行 `role=… · N 个内容块`；工具页配对页两端各一个 `body-panel`。中栏对同一批事实只给一行，靠间距、对齐与分隔线分层。

角色 chip 已经说明了「这是谁的内容」，`bp-meta` 里的 `role=` 与 chip 重复，「N 个内容块」不帮助判断。面板头加 meta 两行，读一次内容先穿过两层标题。

工具往返部分已改行直出，见[工具往返去壳改行](../../implemented/simplification/2026-10-28-tool-roundtrip-flat-rows.md)；本提案只覆盖剩下的两个面。

## Proposal

### 正文页签

五个 `render*Detail` 去掉 `body-panel`。头部压成一行：角色 chip + 协议路径 + 动作按钮。删 `bp-meta`。

### 工具页签

配对页两端的 `body-panel` 去掉，各压成一行头：工具 chip + 协议路径 + 请求/调用身份。`.body-panel.pair-error` 的 tint 落到行级，异常仍然一眼可见。

### 保留的壳

- `rail-fold` 用于请求结构、证据缺口、能力清单、上下文构成、用量：这些是按需展开的长列表，折叠在做披露控制。
- 推理块折叠：内容长，多数时候不是阅读重点。
- 导航与动作：页签条、返回、消息下拉、复制、重试。
- 数据口径说明：回复详情尾注（工具结果不在本回复里）、工具概览的时长归属。这些是口径而不是装饰。

### 不动的面

[web/turn-band.js](../../../../web/turn-band.js) 的轮次态也用 `body-panel`（11 处），但那是请求作用域之外的目录层，不在用户点名的「正文&工具」范围内。本轮不动；如果去壳之后两种读法在同一屏显得割裂，再单独提。

有一处耦合要先处理：轮次态的最终回复面板（`replyPanel`）在可读分支直接返回 `renderReplyDetail`，所以 `renderReplyDetail` 去壳会连带改掉轮次态，让命令面板带壳、回复不带壳。两种收法，取其一：

- 轮次态改用 `renderReply` 自己拼头（它已经在用 `bp-head` 那一套），`renderReplyDetail` 只服务正文页。
- 暂不动 `renderReplyDetail` 的外层，正文页在调用处换壳。

按「一个事实一个家」偏向前者。

## Alternatives considered

**三处一起改。** 工具往返、正文页与配对页一起去壳是 2026-10-28 的原始范围。2026-10-29 用户决定先只收工具往返这一处；剩下两个面单独评审，避免一次改三个面。

**保留面板头，只去 `bp-meta`。** 外壳还在，只是少一行说明，「去壳」没做到。

**整行可点开配对。** 用户明确要保留配对按钮；整行可点会让按钮语义重复，还吞掉选中文本。

**照搬中栏的序号与角色标签。** 右栏是请求作用域，序号无意义；角色由 chip 与协议路径表达。

## Acceptance criteria

- 正文页签五类详情无 `body-panel` 与 `bp-meta`，内容直接可见。
- 工具页签配对页两端无 `body-panel`。
- 异常态仍可见：多候选、`is_error` 为真、读取失败、结果位置无效。
- 320px 窄栏实测不横向溢出。
- `tests/body-view.test.ts`、`tests/trace-pair.test.ts`、`tests/web.test.ts` 改锁新结构并通过，`bun run typecheck` 通过。

## Risks

- 协议路径压进头部后不易扫读。行内保留，只降低视觉重量，不删。
- 结构断言面大：`body-view.test.ts`、`trace-pair.test.ts` 里多处 `bp-kind`、`body-panel` 断言要跟着改；`web.test.ts` 有一条把「返回消息列表在 body-panel 之前」当位置约束，去壳后该断言失去锚点，要换成新的落点。
- 部分取代[配对页与右栏就地阅读](../../implemented/feature/2026-10-24-trace-pair-rail-page.md)里「复用正文详情的 body-panel 组件语言」的决定，也触及[正文面板常挂说明清理](../../implemented/simplification/2026-10-25-body-panel-standing-notes.md)。落地的实现 note 要写明这条覆盖关系。
