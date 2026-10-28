# 轨迹阅读架构实施计划

> 按任务核对代码、合成回归和浏览器结果；提交需另有明确授权。任务状态反映本工作树，生产服务与生产库的状态单独记录。

**Goal:** 让窗口准备、轮次命令与导航都使用当前阅读证据，并保持轨迹视口稳定。

**Architecture:** store 持有读取快照，准备模块负责窗口内任务与提交资格，页面负责选择与 DOM。轮次依据派生证据结算，按原始正文形态定位命令；视口提交仍由键控视图同步补偿，异步定位独立检查其资格。

**Tech Stack:** TypeScript、Bun、SQLite、浏览器原生 ES module。

**Spec:** [架构设计](../../architecture-design.md#轨迹阅读布局)、[轮次两端阅读](../../../.agents/notes/implemented/feature/2026-10-25-turn-pair-reading.md)、[窗口准备流水线](../../../.agents/notes/implemented/architecture/2026-10-27-trace-window-preparation.md)。

## 全局约束

- 测试与原型仅使用合成数据；不读取真实正文构造测试。
- 不改 schema、派生用途门控或生产库，不重启生产采集器；末尾坏块的组派生规则升版，历史会话由显式重建处理。
- 已处理的 unknown 起点与吸顶遮挡不重复实现；以当前 HEAD 为基线。
- 行为回归只跑能覆盖该变化的最窄测试；交付前执行类型和 note 闸门。

## 任务 1：轮次命令与正文形态

**文件：** `src/queries/turns.ts`、`src/tail-command.ts`、`src/derive/read.ts`、`src/protocols.ts`、`web/body-model.js`、`web/body-view.js`、`web/trace-view.js`、`web/rail-facts.js`、`web/turn-band.js`。合成原型同步分页形态。

**接口：** `listTurns` 返回起点内部序号；`tailCommandOrdinal` 复用末尾判据。`BodyPage.message_location` 给原始键与形态，`messagePathOf` 据此生成路径，未知时为空。

- [x] 可信增量读取正文实际拆出的消息块，包含裸字符串合成消息与旧骨架的 `messages`；末尾形状只定位末尾一条命令，不伪造增量。
- [x] 正文引用缺失或末尾块损坏时返回空位置，面板展示缺口；原始字符串路径不加数组下标。
- [x] 合成场景覆盖 Responses 数组、字符串、工具循环、未知前驱、损坏与同步/切片派生一致性。
- [x] 运行受影响的轮次、正文、轨迹和右栏合成回归，覆盖坏骨架、正文回收与工具配对消费方。

## 任务 2：窗口准备与阅读版本

**文件：** `web/trace-preparation.js`、`web/app.js`、`web/reader-store.js`、`src/http.ts`、`tests/trace-preparation.test.ts`、`tests/reader-store.test.ts`。

**接口：** `createTracePreparation(store, onPrepared)` 提供组准备、窗口准备、提交资格、撤销与换代；store 继续持有正文与读取状态。

- [x] 目标先准备，余下最多四组并行；只读取窗口内确认依赖，每组自动消费最多 20 片。
- [x] 同组共享任务；失败重试先撤销资格，token 变化后重算依赖，换代和离窗任务不提交。
- [x] 自动重读完成后校验记录仍属于当前会话；旧投影只供显示，不用于来源与配对判定。
- [x] 运行准备、自动重读和静态白名单合成回归。
- [x] 在合成浏览器中检查旧投影交互：读数、正文和工具页在当前请求换版期间等待；跨请求调用方换版、失败与调用消失均按准备状态处理，路由页可用。

## 任务 3：导航与视口

**文件：** `web/app.js`、`web/trace-dom.js`；视口验收使用隔离合成原型。

**接口：** 既有选择意图继续负责选择与效果；导航代次、选择代次和本次动画帧捕获的滚动位置决定延迟定位能否执行。同步 DOM 提交继续负责锚点补偿。

- [x] 合成浏览器复现切窗期间换会话污染新会话，以及用户新选择被切窗收尾覆盖。
- [x] 延迟动画帧条件下复现定位拉回视口；自然时序尚未命中。
- [x] 守卫切窗和动画帧收尾。
- [x] 复测两项竞态、放大时序与正常切窗；记录切窗途中滚动时的锚点补偿观察。
- [x] 记录合成证据；不将未执行的真实流量验收标为通过。

## 任务 4：决策同步与交付检查

**文件：** `docs/architecture-design.md`、相关活跃 Agent Note、`docs/acceptance.md`。

- [x] 搜索同一机制的活跃 note，保留并交叉引用部分取代的决策。
- [x] 同步正文路径、轮次判据和准备模块归属；记下导航取舍与实际验收结果。
- [x] 运行 `bun run typecheck`、`bun run verify:notes` 与受影响的回归；检查未跟踪文件。note 格式与归档检查已执行；未暂存时 staged 闸门未覆盖本次改动。
- [x] 独立复核改动并修复确认的问题；旧骨架工具路径经合成对照核查，路径不同不强配。
- [x] 交付时按仓库提供英文提交信息建议；未经明确要求不提交、合并或部署。
