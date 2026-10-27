# Agent Note: 中栏键控提交计划

Status: implemented

## Problem

中栏此前每次重绘整体替换 `main.innerHTML`：同一条步骤即使可见内容没变，节点、焦点、浏览器文字选择也一起消失；选择变化与右栏补读同样走整栏重建。要做到「渲染输入没变就不动 DOM」，先得有一份只依赖稳定键与可见结果的提交计划，否则每个调用方都会各自发明比较规则。

## Decision

提交计划是纯函数 `planCommit(shown, desired)`，落在 [trace-commit.js](../../../../web/trace-commit.js)：`shown` 是上次提交的键到可见结果 HTML，`desired` 是这次期望的键与 HTML，返回 `remove`、`create`、`replace` 与完整期望键序 `order`。判据是「同键同 HTML 即同一条显示」，HTML 就是实际渲染输入生成的结果，不引入哈希或第二份指纹字段。重复键只认第一次出现；落位由应用层按 `order` 执行，计划本身不碰 DOM。

单行渲染从 `renderTraceRows` 拆出 `renderTraceRow(row, step, ordinal, callOf, selected = false)`，`renderTraceRows` 变成逐行拼接，输出逐字节不变（现有锁定测试原样通过）。选中默认 `false`：提交路径用默认值生成比较用的 HTML，选择不进入比较；提交后由视图单独写回 `aria-current`。

结构容器（加载入口、请求组、空态与结尾标记）传空串作可见结果，只按键保留，内部再做行级计划——容器换掉会把子节点连同焦点一起丢掉。

## Alternatives considered

**用指纹或哈希做比较。** 可见结果本来就是字符串，直接比较即可；引入哈希要多维护一门「哪些字段算显示输入」的规则，字段增减时容易漏算，反倒让「显示没变却不等于」的误判变成常态。

**继续用整段 HTML 相等判断要不要整体重绘。** 只能回答「变没变」，回答不了「变了哪几行」；一段变化就让整组重建，与本决策的目的相反。

**这一轮就引入框架或复用库。** 页面是无依赖的原生 ES 模块，只为键控更新引入运行时会把整条构建链一起拖进来；纯计划加原生 DOM 足够表达这批节点关系。

## Consequences

收益：比较口径只有一条，可被测试锁定；节点身份、焦点与文字选择在无变化时不再被无故重建；选择与内容比较解耦，点选不会因为高亮变化而替换整组。

代价：HTML 比较要求渲染函数输出稳定（属性顺序、空白都应确定），这是既有字符串模板本来就具备的性质；计划只解决「哪些变」，视口补偿与滚动锚定仍由调用方负责。

## Testing

`bun test tests/trace-commit.test.ts tests/trace-view.test.ts tests/http.test.ts` 通过（57 项）：计划在渲染结果不变时为空、单行变化只替换该行、新增与移除分开、prepend 只有创建、重复键不重复落位；`renderTraceRows` 的既有输出锁定测试原样通过，说明拆分没有改动可见结果。`bun run typecheck` 通过。新模块登记进 `STATIC_FILES`，静态白名单与 `web/` 目录的互相覆盖测试一并通过（2026-10-27）。
