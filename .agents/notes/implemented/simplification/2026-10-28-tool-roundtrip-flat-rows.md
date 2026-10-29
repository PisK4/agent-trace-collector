# Agent Note: 右栏工具往返去壳改行

Status: implemented

## Problem

右栏「工具往返」把调用行包在 `<details class="rail-fold sub" open>` 里：标题行「工具往返 N 次」加每次读回复都要穿过的一层缩进。这个折叠默认展开，标题只提供「可收起」这一条退路。中栏对同一批调用只给一行，靠间距与对齐分层，两种读法摆在同一个屏幕上。

同一批 chip 上还有一处配色被覆盖。`.tool-chip.call` 在样式表里用双类选择器写死 `--k-assistant` 的琥珀色，权重压过 `.tint-*` 的单类选择器；`toolTint` 在模板里一直有输出，右栏每个调用 chip 却都显示成同一种琥珀，工具身份在视觉上不存在。这与[工具摘要与工具强调色](../feature/2026-10-24-pretty-trace-tool-summary-and-tint.md)定下的「右栏 chip 与中栏同款色类」相反。

2026-10-28 用户反馈：工具往返改成中栏的行风格，保留行。2026-10-29 用户指着截图里的黄框要求去掉。

## Decision

`renderTools` 去掉折叠壳与计数标题，每次调用一行直出。行内保留两段：工具 chip（工具名加参数摘要，来自 `summaryParts`）与「配对两端」按钮；完整参数仍在悬停 title 里。多候选的异常提示照旧。外层由 `.tool-rows` 容器给行距。

`data-fold="round:<reqId>"` 随之消失，这一处的开合不再跨重绘保持；`renderTools` 不再接收 `foldKey`，`renderReply` 的键仍服务于推理块折叠。

`.tool-chip.call` 只保留透明边框占位，颜色与底色交给 `.tint-*`。这条规则同时覆盖正文页工具往返、工具页列表与会话页配对列表的调用 chip：三处共用同一份样式与同一个 `toolTint` 映射。

## Deferred

正文页五类详情（消息、回复、系统、回复块、未知块）与工具页配对页两端的 `body-panel` 外壳没有动。2026-10-29 用户选择先把工具往返这一处收干净，这些面维持现状；后续提案见[右栏正文页与配对页去壳改行](../../proposed/simplification/2026-10-28-rail-flat-rows.md)。

## Alternatives considered

**三处一起去壳。** 原草案的范围是工具往返、正文页五类详情与配对页两端一起改。用户 2026-10-29 选择先只做工具往返：改动面更小，其余两处的收益没有单独验证过。

**只去 chip 黄框，保留折叠壳。** 黄框只是一半问题；标题与缩进仍在，用户点名的「包裹」没有去掉。

**整行可点开配对。** 用户明确要保留配对按钮；整行可点会让按钮语义重复，还吞掉选中文本。

**照搬中栏的序号与角色标签。** 右栏是请求作用域，序号无意义；角色由 chip 与协议路径表达。

**给右栏另写一份摘要。** 与 `summaryParts` 同源是既定决策；另写一份会让两处格式漂移。

## Consequences

工具往返少一层标题与缩进，每次读回复少扫一行；代价是调用多时不能一键收起，只能滚动。这一处的开合状态不再持久化，其他折叠键不受影响。

chip 回到工具身份色：Read 蓝、Edit 橙、Bash 玫红等，正常态不再有琥珀边框。`.tool-chip.res` 与 `.tool-chip.miss` 保留原有的结果色与异常色。透明边框保留 1px 占位，有无身份色时行高不跳动。

## Testing

`bun test tests/body-view.test.ts`（34 项）与 `bun run typecheck` 通过。测试锁定：`renderTools` 输出 `.tool-rows` 容器、每次调用一个 `.tool-row`、没有 `<details>` 与 `data-fold="round:`、chip 带 `tool-chip call tint-*` 类。页面实测见[验收记录](../../../../docs/acceptance.md)。
