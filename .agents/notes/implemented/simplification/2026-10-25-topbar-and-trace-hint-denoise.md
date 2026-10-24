# Agent Note: 顶栏与中栏常挂提示降噪

Status: implemented

## Problem

读数页样式评审后，[前端降噪原则](../process/2026-10-24-frontend-denoise-standing-rule.md)已立为常备约束，但顶栏与中栏仍留有成批不承载信息的元素：品牌旁的「请求账本」静态副标；顶栏 crumb 重复中栏 sticky h1 的整段会话标题；左栏「20 / 已加载 20」在无筛选时与列表自明重复；中栏「步骤轨迹」伪页签是唯一视图的 chrome；view-row 与 history-loader 两条交互提示同屏可见且互相重复（「点击行查看详情」「时间从上往下」）；会话头还有 Session/Unassigned eyebrow。

## Decision

- 品牌只留名称与图标；crumb 只显示请求定位（`Request NN` 与未找到/窗口外状态），会话标题交给常驻的 sticky h1，浏览器标签页标题仍含会话名。
- 左栏计数只在搜索或筛选把列表收窄时显示「命中 / 已加载」，全量时留空；「加载更多会话」按钮继续表达还有未加载页。
- 「步骤轨迹」伪页签与两条交互提示删除；「序号表示当前窗口内的请求」这一口径移入中栏序号的悬停 title（`compact-meta`），与读数页「口径解释进 title」的做法一致。
- 会话头 Session/Unassigned eyebrow 删除：会话键在 facts 行，归属未知已有具体标记。
- history-loader 只在存在更早记录或正在读取时渲染，窗口到顶时中栏直接从步骤列表开始，不再留一条空横线与提示文字。

## Alternatives considered

**保留 crumb 全标题，供滚动后辨认会话。** 中栏会话头是 sticky 的，标题永远在视口内；crumb 的标题段是每屏都在场的重复。
**伪页签留给未来第二视图。** 现在只有一个视图，单个 tab 是纯装饰；引入第二视图时应以真分段控件回来，而不是留着单格 tab。
**序号口径保留一行可见文字。** 它只在「加载更早记录」之后才反直觉，悬停即可及；常驻一行让每一屏都为低频问题付费。

## Consequences

顶栏只剩品牌、请求定位与操作按钮；中栏顶部不再有常驻说明行。已知代价：行的可点击性靠 hover 高亮与光标自明；序号口径需要悬停才能看到。验证（2026-10-25）：`bun test tests/trace-view.test.ts tests/web.test.ts`（52 例）、`bun run typecheck` 通过；提交前跑 `bun run verify:notes --staged`。
