# Agent Note: 读者页面按概念拆出三个纯函数模块

Status: implemented

## Problem

`web/app.js` 近 1900 行，除状态与事件编排外还装着 21 个导出纯函数：行级标签与摘要、右栏读数组合、URL 与路由目标。它们与页面状态没有依赖，测试却只能从同一个文件导入；改一句文案要通读整份页面脚本，模块边界与实际概念不对应。

## Decision

按概念拆出三个无状态模块，`app.js` 只留 DOM 辅助与编排：

- **`web/row-summary.js`**：用途标签（`purposeLabel`）、辅助行判定与摘要（`isAuxRow`、`auxSummary`）、正文状态文案（`bodyStateText`、`bodyLabelText`）与回复完整性（`replyCompleteness`）。
- **`web/rail-facts.js`**：右栏事实页（`railFactsHtml`）、结构折叠（`structureFoldHtml`）、工具概览与 Schema（`toolOverviewHtml`、`toolSchemaSection`）、阅读版本说明（`readingChangedNote`）、system 上下文（`systemContextOf`）、选中来源解析（`resolveSelectedSource`）、用量读数与折叠行（`ledgerParts`、`ledgerRowsHtml`、`usageFoldHtml`）；四个格式化函数（`n`/`kk`/`secs`/`fmtCost`）随用量读数留在模块内部。
- **`web/url-route.js`**：trace 目标解析（`resolveTraceTarget`）、页签参数与声明（`railTabFromParam`、`railTabParam`）、路由读取目标（`routeReadTarget`）。

`restoreScroll` 留在 `app.js`：它直接读写元素的滚动位置，属于渲染编排而非纯呈现。三个新模块登记 `src/http.ts` 的 `STATIC_FILES`，`tests/http.test.ts` 的白名单用例同步扩展——漏登记会让页面整块加载失败。测试按新家导入：`tests/web.test.ts` 从三个模块取符号、`restoreScroll` 仍从 `app.js`；`tests/trace-view.test.ts` 的 `resolveSelectedSource` 改从 `rail-facts.js` 取。

## Alternatives considered

**一个 `app-pure.js` 装下全部纯函数。** 文件数量最少，但仍然是「什么都有一点」的模块，概念边界和拆分前一样模糊；测试按概念查找符号仍要跨全部主题。

**按「纯函数 / 非纯函数」二分。** 纯函数之间并不共享同一概念：URL 解析与用量格式化没有共同读者，按纯度拆只是把没概念的东西装进一个袋子。

**引前端框架或 DOM 测试库来支撑拆分。** 仓库栈约定不引第三方依赖；现有纯函数在 `bun:test` 下直接断言即可，拆分不需要新工具。

**让 `app.js` re-export 新符号、测试不动。** 同一符号会有两个导入点，事实重新分裂；测试跟随新家才能让模块边界成为真的边界。

## Consequences

呈现函数的归属明确：行级文案进 `row-summary`，右栏组合进 `rail-facts`，URL 目标进 `url-route`。新增 web 模块必须同时登记 `STATIC_FILES` 与白名单测试。`app.js` 只剩 `restoreScroll` 一个导出与 `document` 守卫内的编排代码。[Demo 复用生产页面](../process/2026-10-24-demo-reuses-production-page.md)的模块清单已同步；读取协调与步骤投影的既有边界不变（[单一轨迹生产阅读](2026-10-23-single-timeline-production-reader.md)）。

## Testing

- `tests/web.test.ts`、`tests/trace-view.test.ts` 改导入源后全过。
- `tests/http.test.ts` 白名单覆盖三个新模块。
- `bun test` 全量通过（2026-10-25）。`bun run typecheck` 的 `src/` 与 `web/` 无错误；同日并行进行中的 `prototypes/` 重构另有类型错误，不属于本决策。
