# Agent Note: 选择状态的唯一写者 selection.js

Status: implemented

## Problem

选择元组（session / reqId / selectedStep / toolOrd / toolOwner / toolPage / railTab / missingReqId / offPageReqId）在 app.js 里有约 18 个手写点：九个点击类、五个导航类、一个键盘、一个渲染期自愈（railTools 在 render 里改 state 再递归重绘），外加四处复制粘贴的路由读取接线（同一个 `routeReadTarget + ensureRoute` 抄在 selectSession、refreshWindow、locateRequest 与页签点击）。不变量全靠手维护：missing 与 offPage 互斥、toolOwner 可不等于 reqId（配对页描述 owner 请求的调用）、步骤来源到页签的映射。e7a111c 就是一次行为修订要四处齐改的实例；这层接线没有测试面（tests/web.test.ts 只从 app.js 取 restoreScroll）。

## Decision

新增 `web/selection.js`：纯转换函数 `applyIntent(state, intent) → {state, effects}`，无 DOM、无网络、无 store，是选择元组的唯一写者。app.js 的 `dispatch` 收口：按 `SELECTION_KEYS` 提取元组、应用转换、回写并执行效果；渲染函数不再改 state。装配层（handlers 与导航函数）只解析事件与步骤来源后发意图，共 17 个意图（open-session / restore-url / trace-resolved / session-default / select-latest / refresh-start / locate / select-step / select-message / select-delta / open-tool / open-pair / close-tool / select-tab / select-tool-page / clear-step / tool-gone）。配对判定（pair 或 reply/call）、side→页签映射、missing/offPage 的清除规则、页签归一化都归转换；步骤来源解析（resolveSelectedSource）与异步守卫（navEpoch / loadEpoch）留在装配层。路由读取策略收成 `selection.js` 内唯一的 `routeEffects`：nav-settled（选会话、刷新、定位后的导航完成）与 select-tab 统一发出，四处手抄接线退役，效果顺序保持现行（页签点击先读路由再渲染）。

效果清单（open-rail / render-* / update-url / focus-step / scroll-group / ensure-read / ensure-pair / resume-delta / read-route）由页面执行器按序消费；URL、读取、焦点与滚动仍归页面执行，不做 navigate() 大一统出口。`renderRail` 入口以 tool-gone 意图清掉调用方读取里已不存在的工具选择（读取未就绪不算消失），替代渲染期自愈。

三处行为修正随本次落地（grilling 批准，其余行为纯搬移逐一保持）：右栏消息下拉（change 事件）补 renderMain，与结构折叠路径对齐，选中高亮不再停在旧步骤；删除 toggle 监听里 `route:` 前缀的死分支（全 web/ 无生成侧，路由读取已走页签与导航完成点，含 `key.slice(6)` 反解析）；渲染期自愈收进转换。Escape 只清工具选择不清 selectedStep 等其余现状保留。`selection.js` 登记 `src/http.ts` 的 STATIC_FILES 与 `tests/http.test.ts` 白名单，见[web 阅读器模块拆分](2026-10-24-web-reader-module-split.md)的登记约定。

## Alternatives considered

**navigate({...}) 大一统出口。** 自由组合 reqId / stepKey / toolOrd / toolOwner / railTab 维护不了不变量（toolOwner 与 reqId 不同是配对页的合法状态）；拆成纯转换加页面执行器后，handlers 只表达意图，不变量集中一处可测。

**为 fold 读取触发引入声明式属性与通用事件系统。** 前置核实时发现 `route:` 折叠分支是死代码（无生成侧），没有要替换的通道；不引入新机制。

**顺手规整全部已知不一致。** 与机械搬移混在同一变更会扩大审查面；经 grilling 只保留三处与本次目标直接相关的修正（下拉缺渲染、渲染期自愈、死分支），Escape 半清等现状留待单独判断。

## Consequences

选择状态的单一家：规则变化改 `applyIntent` 一处，handlers 不再各自记忆重置顺序；「四点漏一处」类接线错误结构上消失。纯函数获得直接测试面（`tests/selection.test.ts` 断言各意图的落位、效果清单与顺序、路由读取策略）。代价：意图词汇是新的一层间接（17 个意图名），效果执行仍是命令式清单；异步编排（navEpoch、loadEpoch、窗口批次）没有进入转换，仍在装配层。[阅读角色、步骤定位与缓存一致性](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)记录的选择语义（stepKey 身份、步骤来源到阅读入口的路由）不变，写入机制改由本记录持有。

## Testing

`bun test tests/selection.test.ts tests/web.test.ts tests/http.test.ts` 全过：open-session/restore-url 的页签保留与声明差异、trace-resolved 三分支与互斥、session-default 的条件默认、select-step 的配对归属与页签映射（含跨请求 owner）、select-message 的 bodyTab 与 missing/offPage 保留（现行行为锚定）、效果清单与顺序（clear-step 不更新 URL、页签点击先读路由）、nav-settled 只在路由页且有请求时发 read-route。`bun run typecheck`、`bun run verify:notes` 通过（2026-10-25）。
