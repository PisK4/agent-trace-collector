# Agent Note: 会话切换的保留画面与一次换场（Tracery）

Status: implemented

## Problem

在「活跃对话」里快速连点会话时，中栏经历三段可感知的跳变：点击瞬间整栏只剩一行标题（`renderMain` 的 `pendingSession` 分支先 `mainView.reset()` 再写占位），20–150ms 后换成二十多行「读取中」骨架，0.1–1.2s 内逐批填成正文。每次会话变化还播一次 150ms 的整栏 WAAPI 淡入（`renderMain` 里的 `motion(main, { opacity: [0, 1] })`），即使内容很快到达也照播。

两个加重因素。点当前会话同样走完整重读，返回刚看过的会话也不复用任何阅读状态：`selectSession` 每次都让 `store.selectSession` 清空 reads/page 缓存。活跃会话更明显：后台 derive 发布改变 `published_revision`，`reading_token` 随之变化，窗口页请求收到 409，整笔作废后自动重读，中栏出现几行「阅读版本已变化 · 自动重读中」。本次不改 reading_token 与 409 重读机制，只调整中栏在切换期间画什么。

真实数据上帧级复现后，问题的核心不是「数据来得慢」，而是旧画面在数据到达前被主动清掉，用户看到的是清空、骨架、填充三个阶段，而不是一次有交代的换场。

## Decision

四件事合起来解决切换观感，改动只在 `web/app.js`、`web/app.css` 与 `web/trace-dom.js`：

1. **点当前会话直接 no-op。** 列表点击处理里，键与 `state.session` 相同且 `store.getWindow().error === null` 时不再调用 `selectSession`；读取失败时保留点击重试入口。
2. **换会话先保留旧画面，最多 300ms。** `selectSession` 用 `lastRenderedSession`（实际画着的会话）而不是语义上的 `state.session` 判定能否保留；有真实会话头部时进入 `data-switch-state="switching"`：旧列表压暗到 `opacity:.55`、`pointer-events:none`，`main` 加 `aria-busy` 与 `inert`，顶部跑一条 2px 扫描线。窗口页在 300ms 内到达就一次 `renderAll` 换场；超过上限就走原来的占位路径，不无限期压着旧内容。
3. **换场只淡入一次。** 换场时切到 `data-switch-state="entering"`，180ms 从 `opacity:.55` 回到 1，220ms 后清状态。组从占位变真实内容时 `commitGroup` 挂一次 `data-enter="fill"`（160ms 从 `.55` 渐显），后续增量批次不重播。
4. **连点只画最后一个目标。** 400ms 窗口内再次点击，先等 140ms 让点击停稳；期间被下一次点击取代就整次放弃（`navEpoch` 守卫），不渲染、不动画中间目标。左栏高亮仍随点击即时变化。popstate 离开到无会话时显式 `endSwitchHold(false)`，避免残留压暗空栏。

JS 侧原来的整栏 WAAPI 淡入随之删除：换场状态由 CSS 类承载，reduced-motion 沿用动效区既有的 blanket 规则。

## Alternatives considered

- **保留旧画面直到整窗就绪，不设上限。** 大会话或慢网下旧画面会长时间压暗，读者无法判断是加载中还是卡死；300ms 之后如实显示占位，代价是慢网仍会出现骨架。
- **会话快照缓存（保留已读会话的 DOM 与数据）。** 能彻底消除返回旧会话的重读，但要把缓存生命周期、失效与内存上限铺进 reader-store，改动面远超本次手感验证；先不做，等交互稳定后另行提案。
- **View Transitions 或交叉溶解。** 大会话整页快照捕获成本高，前一份动效 note 已否决；本次不做真溶解。
- **换场动效继续用 JS WAAPI。** 与既有 `motion()` 的 reduced-motion 短路重复，且 CSS 状态类已能表达切换与入场两个阶段，少一层 JS 等待。
- **点击后立即清空再淡入。** 仍是硬切，清空整栏正是要解决的问题本身。

## Consequences

- `lastRenderedSession` 与 `state.session` 从此分家：前者表示中栏实际画着谁，只在 `renderMain` 提交时更新；保留判定、换场判定与 popstate 清理都依赖这个区分。
- 300ms 上限之后仍会出现占位与骨架。这是有意保留的如实反馈，没有掩盖慢读，只是把「清空」推迟到确认窗口页赶不上之后。
- 保留期间 `main` 带 `inert`，焦点会被浏览器移走；30ms 级的快速换场无感，慢网下读者需要重新点选，换取的是旧画面不被误触。
- 组级 `data-enter="fill"` 靠 200ms 定时器清理，元素复用期间不会重播；同一窗口内二次填充被 `dataset.enter === 'fill'` 判定去重，不会叠加动画。
- 验证口径：`bun run typecheck` 通过；`tests/web.test.ts` 与 `tests/trace-commit.test.ts` 共 59 pass。真实流量（生产库副本）浏览器走查覆盖：点当前会话完全无变化；单次切换保留旧画面 27–32ms 后一次 `entering`；120ms 连点只有最后一个目标换场；慢网 900ms 时约 120ms 压暗、约 300ms 切占位、数据到达后淡回；保留态中后退到无会话不留 `data-switch-state`、`inert`、`aria-busy` 或压暗空栏。没有新增自动化测试：这些行为是 DOM 与时序，靠合成页与真实数据走查确认，下一步若继续做会话快照缓存再补 store 级测试。

相关：[窗口准备](../architecture/2026-10-27-trace-window-preparation.md)、[阅读版本保留](2026-10-27-trace-version-retention.md)、[稳定渐进读取提案](../../proposed/architecture/2026-10-27-stable-progressive-trace-reader.md)、[页面交互动效层](2026-11-04-web-interaction-motion.md)。
