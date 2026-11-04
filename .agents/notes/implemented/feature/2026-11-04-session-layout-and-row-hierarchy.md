# Agent Note: 会话页栏结构与行信息层级收敛——会话双通道、主栏单 logo、轨迹单行

Status: implemented

## Problem

主页截图标出的问题都落在「同一事实被画了两遍」和「一行放不下一个事实」上。按[真实三栏结构](#structure)定位：

- **顶栏**：`#crumb` 同时输出 `Request NN` 与会话标题（`web/app.js:547-558`），主栏 sticky `h1` 已是同一标题（`web/session-view.js:457`），页面名出现两次。
- **会话栏**：截图里第二行是 `logo + Agent 名 + 「线程」+ 笔数 + 时间`，行内还有 token/费用读数；长会话 ID 折进第二行，行高在 80–109px 之间浮动（无固定高度，`web/app.css:179-183`）。
- **主栏**：`.session-facts` 第一格直接写 Agent 名（`web/session-view.js:465`），与同一行的会话 key、已加载笔数、时间同权；轨迹里工具条目是「工具名一行 / 参数一行」，`read_file` 多文件全量铺开，`bash` 折行（截图口径）。
- **详情栏**：`.rail-head` 第一行是 `req id · 时间 · Agent · 模型`（`web/app.js:1113-1116`），时间在会话行有、Agent 在主栏有、模型在读数区有；「用量与上下文」上方还有一层 `CONTEXT COMPOSITION / 上下文构成` 小标题。

**截图与 master 的差异**（先核对再落点，避免把已修的再改一遍）：

| 截图现象 | master 现状 | 处理 |
| --- | --- | --- |
| 顶栏「总览 / 会话」面包屑 | `#crumb` 实际是 `Request NN · 会话标题`（`web/app.js:553-555`） | 只删重复标题，保留 `Request NN` 位置 |
| Agent 名后的「线程」 | `web/` 全树无此串；行内是 `· N 笔`（`web/app.js:656`） | 不新增同义后缀，验收锁定 |
| 会话行内 token/费用读数 | 行内无读数，只有笔数与时间（`web/app.js:653-659`） | 作为约束：新增读数一律进悬浮卡，不回到行内 |
| 详情栏刷新/问号 | `#refresh-window` 在主栏 `.head-actions`（`web/session-view.js:459`），详情栏无按钮 | 见 ⑤：窗口刷新留主栏，列表刷新进会话栏 |
| `CONTEXT COMPOSITION` 小标题 | `web/` 无此串；只有 `<summary>用量与上下文</summary>`（`web/rail-facts.js:617-618`） | 不新增二级标题，验收锁定 |

截图来自线上版本或旧快照，落点以 master 为准；差异本身也是本笔记要防止的误解。实现前逐条对着真实页面与源码走了一遍，**源码优先于截图**。

<a id="structure"></a>

### 真实结构：三栏 + 6px 拖动条，不是双栏

- `:root` 定义 `--sidebar-width:250px` 与 `--rail-width:clamp(280px, calc(100vw - var(--sidebar-width) - 326px), 640px)`；`.app` 是 `grid-template-columns:var(--sidebar-width) minmax(0,1fr) 6px var(--rail-width)`（`web/app.css:118-120`）。1440 下实测 **250 | 544 | 6 | 640**；1240 下 **220 | 374 | 6 | 640**（`web/app.css:785-786`）。
- DOM 是三个真栏加一个分隔条：`aside.col-sessions` / `main.col-main` / `div#rail-resize[role=separator]` / `aside.col-rail`（`web/index.html:30-49`）。分隔条 `aria-valuemin="280"`、`aria-valuemax="640"`（`web/index.html:44`），拖宽上下限见 `web/layout.js:51-57`，默认 640（`web/layout.js:63`）。
- **双栏只是收起态**：`body.rail-collapsed .app{grid-template-columns:var(--sidebar-width) minmax(0,1fr) 0 0}`（`web/app.css:133-135`）；`body.sidebar-collapsed` 同理只留主栏与详情栏。≤1000px 走 `display:block` 单列堆叠（`web/app.css:788-794`）。
- **滚动分层**：会话栏 `overflow:hidden` + `.sessions-list{overflow:auto}`（`web/app.css:122,173`）；主栏 `.session-head` sticky 在顶部（`web/app.css:229`）；详情栏 `rail-head` 固定（`web/app.css:617`）+ `rail-body` 独立滚动（`web/app.css:632`）。

```
┌ topbar 44px ────────────────────────────────────────────────────┐
├ 会话栏 250 ┬ 主栏 544 ┬6px┬ 详情栏 640 ┤
│ head 固定  │ head 固定 │拖 │ rail-head 固定（约 76）│
│ list 滚动  │ 正文滚动  │动 │ rail-body 滚动      │
└───────────┴──────────┴───┴────────────────────┘
```

## Decision

### 改动清单（①–⑩）

| # | 现在（master） | 改成 | 落点 |
| --- | --- | --- | --- |
| ① | `#crumb` 渲染 `Request NN · 会话标题`，与 h1 重复 | crumb 只留 `Request NN` 位置，会话标题只归 h1；品牌区不承载页面名 | `web/index.html:19`；`web/app.js:553-555` |
| ② | 会话行已是 `logo + 第一个 Agent 名 + · N 笔 + 时间`（`web/app.js:646-660`），多 Agent 已用 `+N` | **锁定双通道常显**：不采用 logo-only；名字参与扫视，不靠 hover；不加「线程」；笔数留在 meta 行 | `web/app.js:646-660`；`web/app.css:186-206` |
| ③ | 行内无 token/费用读数 | 读数不进会话行；将来要加，只能进悬浮卡或详情栏 | 约束落在 `web/app.js:651-660`（不新增字段） |
| ④ | `.sess` 靠 padding 与两行内容撑高（实测 51.14px，长标题可折）；标题已 `nowrap + ellipsis`（`web/app.css:187`） | 行高固定 **44px**，标题单行省略；长会话 ID 不进行，只进详情栏/悬浮卡 | `web/app.css:179-183` |
| ⑤ | 窗口刷新在主栏 `.head-actions`（`web/session-view.js:455-463`）；详情栏无按钮；无帮助入口 | 窗口刷新留在主栏（它重读当前窗口）；会话栏标题行右侧补「刷新列表」，帮助入口并到列表头；详情栏不放全局按钮 | `web/index.html:31-38`；`web/app.js` 会话栏头部渲染与 `refreshWindow` 同文件 |
| ⑥ | `.session-facts` 第一格写 `<b>Claude Code</b>`（`web/session-view.js:465`），与 key/笔数/时间同权 | 改 logo-only：`<span class="fact-agent" role="img">` 18×18 命中区，`title` + `aria-label` + `tabindex="0"`，hover/focus 出名字；保持 `.session-facts` 行高与右侧数字基线不变 | `web/session-view.js:465`；`web/app.css:235-238` |
| ⑦ | 每个 step 已是单行 `.compact-row`（36px，`web/app.css:302`；预览 `nowrap`，`web/app.css:338`）；工具参数取 `step.toolArgs` 全文（`web/trace-view.js:567`） | 把单行升格为硬约束：多文件调用只显示第一个 + `+N`；`+N` 悬停/聚焦/点击看完整清单；`bash` 超长省略号不折行；任何情况不产生第二行 | `web/trace-view.js:554-574`；`web/app.css:338` |
| ⑧ | `.rail-head` 首行 `req id · 时间 · Agent · 模型`（`web/app.js:1113-1116`） | 整行删除；第一行直接是会话标题（`contentTitle`，`web/app.js:1094-1097`），状态点并入标题行右端；节奏：head padding-top 11→15、title margin-top 4→0、tabs 0→10 | `web/app.js:1113-1119`；`web/app.css:617-628` |
| ⑨ | `sessionHiddenFold` 可见文本是「序号 · 无正文/缺正文」，id 只在 `data-summary-req`（`web/session-view.js:386-397`） | 折叠条不显示 id（保持）；子节点改为 toggle 时才构建，默认 DOM 为空 | `web/session-view.js:386-397`；`web/app.js:986-1000` |
| ⑩ | 无 `CONTEXT COMPOSITION / 上下文构成` 小标题；`usageFoldHtml` 直接 `<summary>用量与上下文</summary>` 后接树图（`web/rail-facts.js:617-621`） | 保持无二级标题；若截图版本有，删除；验收禁止新增 | `web/rail-facts.js:617-621` |

### 决策记录

- **会话栏双通道，主栏只留 logo**：会话栏是导航，名字要能被扫视、被朗读、被搜索；logo 只做辅助，因此名字常显。主栏是当前唯一一行的内容区，Agent 身份在会话栏与详情栏已有两处，第三处退为图标即可，且用 18×18 命中区 + `title`/`aria-label`/`tabindex` 补可达性。
- **为什么维持 12px**：名字常显后 logo 的职责从「唯一标识」降为「辅助识别」；12px 与 10.5px 的第二行文字视觉同高（`web/app.css:192-194`）。提到 14px 要付第二行 18→20、行高 44→46，8 行多 16px；而「Claude / Codex / OMP / Hermes 四家图标分不清」已由常显名字解决，这笔高度不值得。
- **为什么详情栏身份行可以整行删除**：时间是会话行的既有事实，Agent 在主栏 `.session-facts`，模型在「用量与上下文」里已有；保留它只是第三次复述，且把标题挤到第二行。
- **为什么 ⑤ 不搬 `#refresh-window`**：它调用 `refreshWindow()` 重读当前窗口，作用域是主栏；搬到会话栏会让「刷新」看起来重载列表。列表刷新是另一个动作，应新加在 `.sessions-head`，两者各自命名。
- **`+N` 的清单按需取**：行内只留计数，完整清单不落 DOM，悬停 160ms、聚焦立即、点击就地开合；收起即清空节点。这样 100 条轨迹也不会为每个多文件调用预渲染一份清单。

### 量化对比（实测，非演示稿）

演示稿的口径与真实 master 有差距，实现以实测为准：

| 项 | 演示稿口径 | master 实测（改前） | 改后实测 |
| --- | --- | --- | --- |
| 会话行高 | 80–109px 浮动 | **51.14px** | **44px** |
| 轨迹组 | 12 条 19 行 / 472px | 最大请求组 **5 行 / 184px**（行高 36px） | 5 行 / 184px（行高仍 36px） |
| 详情栏头部 | 119px → 75px | 有标题 **78.2px**、无标题 56px | 有标题 **76.2px**、无标题 55px |
| 折叠条 | 预渲染子节点 | 收起态 0 子节点 | 收起 0 → 点击后 1 |

- `.compact-row` 在 master 上已是 36px 单行（`web/app.css:302`），⑦ 的增量是「多文件 +N 与按需清单」，不是从两行起步。
- 详情栏头部净减 2px，是因为删掉的 12px 身份行被 `padding-top 11→15` 与 `tabs` 上边距 10px 吸收；**标题起点从 27px 上移到 15px** 是实际收益。

### 不在本轮范围

空状态蜘蛛的暗色配色（三个变量硬编码 hex、暗色只改身体）与 `sess-empty-art` 截图验证，用户已明确「先不做」；另案处理，不写成待修项。

### 演示稿位置

`<tmp>/tracery-style-demo/index.html`（单文件自包含，含修改前/后切换、①–⑩ 标注、`+N` 与折叠按需渲染）。**本机临时目录，不入库，不作为实现依据**；实现以本笔记的落点行号为准。

## Alternatives considered

- **会话栏也只留 logo（B 版全站统一）**：导航需要扫视名字；12px 图标无法承担四家 Agent 的区分，hover 在触屏不存在。否决，仅主栏 ⑥ 采用。
- **logo 提到 14px**：换来的是 +2px 第二行、+2px 行高与 8 行 16px 高度，名字常显后收益不足以抵消。否决。
- **保留详情栏身份行**：时间/Agent/模型三处重复，且把标题推离顶部；删除后标题成为第一行。否决。
- **把 `#refresh-window` 整体搬到会话栏**：语义是「重读当前窗口」，搬过去会误导为刷新列表。否决；改为两个动作分开命名。
- **整行删除面包屑**：会丢掉「我在第几个请求」这个位置事实；改为只删标题，保留 `Request NN`。
- **用 CSS 隐藏第二行 / 预渲染隐藏内容**：违反「折叠即收起」，且会在 DOM 里留下不可见文本。否决。

## Verification

在 worktree `feat/session-layout-row-hierarchy`（tip `7715736`，7 笔按主题切分）上完成，随后 `merge --no-ff` 合入 master（merge commit `ac0015a`，父提交 `7fbda9a` + `7715736`，7 个原提交哈希保留）。合入时 master 已前进 12 笔（整轮 i18n），`web/app.js`、`web/session-view.js`、`web/trace-view.js` 三处按「结构改动优先、字符串保持 `t()` 包裹」解冲突。

- **测试**：合入后 `bun test` **1,164 通过 / 0 失败**，12,116 expect，91 文件；分支上为 1,157 通过 / 89 文件（差额来自 i18n 新增测试）。
- **类型**：`bun run typecheck`（`tsc --noEmit`）通过。
- **i18n 覆盖闸门**：`tests/i18n-coverage.test.ts` 通过；本分支新增的 5 个文案已进 `web/i18n-en.js`（「刷新会话列表」「重新读取会话列表第一页」「另有 {n} 个目标…」「完整目标 {n}」「完整目标清单」）。
- **回归**：`live-activity` / `live-session-settle` / `live-session-view` / `web` / `trace-view` / `http` 六文件 **132 通过**；`createLivePartition`、`LIVE_SETTLE_MS`、`LIVE_COMMIT_MS`、`live_until`、`liveCommitAt` 与沉降用例原样通过。
- **会话行**：51.14px → **44px**，5 行同高；第二行 `logo + Agent 名 + · N 笔 + 时间` 常显。
- **主栏 facts**：第一格只剩 logo，命中区 18×18；`aria-label`/`title`/`tabindex="0"` 齐；真实 `focus()` 后 `::after` content 为 `"Hermes"`、opacity 1。
- **轨迹**：最大请求组 5 行 / 184px，行高 36px；改前后行数一致。
- **详情栏头部**：78.2 → **76.2px**（标题起点 27→15，上移 12px）；无标题 56 → 55；首行身份信息整行消失。
- **折叠条**：无 id，收起态 `.more-body` **0 子节点**，点击后 1。
- **真实实例**：临时 `ATC_DATA_DIR` + 独立端口起服务，1440×900 截图核对三栏（250 / 544 / 6 / 640）、live 分区、`sess-empty-art` 与 `rail-empty-art`、`ctx-gauge`/`ctx-pin`/`ctx-cache` 图标均在。

## Consequences

- **截图口径与 master 有差异**：若照截图改，会把 master 已修的「线程」「行内读数」「详情栏按钮」再改一遍。落点必须先跑 `git log -S` 或读源码确认——本次实测已把 119px / 80–109px / 19 行 472px 三个演示稿数字作废。
- **面包屑删标题后失去上下文**：只保留 `Request NN` 时，`document.title` 仍需保留会话标题（`web/app.js:556`），否则标签页丢名；已保留。
- **18×18 命中区偏小**：低于触屏 24px 推荐值；键盘与读屏可用，但触摸仍易点空，需要后续补 click 或放大透明命中区。
- **`+N` 隐藏文件**：默认只给第一个文件，其余必须可展开且可键盘触发，否则排查时要先猜路径；已提供 hover/focus/click 三条入口。
- **折叠懒渲染**：破坏浏览器查找已折叠文本、打印完整性与无 JS 降级；保留 `<details>` 语义，但默认内容为空。
- **两个刷新入口**：靠 `aria-label`/`title` 区分「刷新列表」与「重读窗口」；视觉上同为 20px 图标，发现成本仍在。
- **i18n 合入后的增量**：结构改动与 `t()` 包裹是两套独立线索，冲突集中在三处事件委托（`const t` 与 `const target` 命名冲突）与 rail head 字符串；解冲突后 `const target` 统一命名，避免遮蔽 `t()`。

## Deferred

- **`+N` 悬停/点击弹层只有单测**：`tests/trace-view.test.ts` 覆盖 `summaryTargets` 与行内 `+N` 标记；生产数据的 `.row-more` 计数为 **0**（LESSONS 会话 30 个请求组、71 行渲染），真实数据里没有多目标参数，**真机未触发过弹层**。
- **触屏无 hover**：`+N` 弹层与 facts 名字浮层都依赖 hover/focus；触屏只能靠点击开合 `+N`，主栏那一格点击无行为。
- **help 入口未做**：⑤ 原计划把帮助入口并到列表头，本轮只做了「刷新列表」。
- **连续 Tab 路径未逐键验证**：headless 下连续 Tab 不可靠，只验证了真实 `focus()` 落在 `.fact-agent` 时的焦点环与名字浮层；未从页首逐键 Tab 到该格。
- **12px 下四家 Agent 仍不能靠图标区分**：主栏 logo-only 处依赖 `title`/`aria-label`。
- **折叠懒渲染的边角行为**：浏览器查找、打印、无 JS 降级未验证。
- **详情栏默认 640 比主栏 544 宽 96px**：阅读重心偏右；6px handle 只有 hover/focus 才显色。
- **长标题单行省略**：键盘用户无法看全（只有 `title` 悬浮）。

## Related

- 会话行与顶栏的前序决策：[方向 A 第 3 步——会话栏与顶栏降噪](../../implemented/feature/2026-11-02-direction-a-step3-sessions-topbar.md)；其中「面包屑带会话标题」与「计数进标题行」被本笔记部分取代（本笔记只收紧这两点，其余导航降噪继续有效）。
- 对齐修正：[方向 A 对齐修正](../../implemented/bug-fix/2026-11-02-direction-a-alignment-audit.md)。
- 头部两栏事实：[会话头部两栏](../../implemented/feature/2026-11-01-session-header-two-column.md)。
- 降噪常备约束：[前端降噪常备约束](../../implemented/process/2026-10-24-frontend-denoise-standing-rule.md)。
- 视觉语言提案（第 3 步与本笔记有重叠）：[前端主界面按方向 A 重制视觉语言](../../proposed/feature/2026-11-02-frontend-direction-a-restyle.md)。
- 双语化：i18n 合并说明见 `web/i18n.js` 与 `web/i18n-en.js` 文件头。
