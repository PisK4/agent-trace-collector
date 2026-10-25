# Agent Note: 按职责重组大模块，建立可评审的分层边界

Status: implemented

## Problem

本仓库已经有多个源码文件超过 500 行，Agent 阅读与修改时需要在同一份文件里区分多项无关职责。原始需求是重新组织代码结构、更好地分层管理实现，让一次修改只需要读它真正涉及的部分。

500 行不是拆分标准。它在这里只触发一次职责检查：文件里是否住着多项可以独立描述的能力、是否有多处共享可变状态、是否有跨模块契约被埋在实现细节里。评估没有测量 Agent 阅读耗时，因此不给出「超过 500 行导致效率下降多少」的数字；判断依据是源码里的职责边界与依赖方向。

背景来自一次连续的功能迭代。查询层陆续接入请求列表、详情、路由解释、来源事实、轮次结算与会话汇总；页面在同一份脚本里接入会话头、轮次带、右栏四页与布局控制。每一项单独看都合理，累计之后，`src/queries.ts` 与 `web/app.js` 各自成了「与某个对象有关的全部代码」的容器。文件名仍在回答对象，不再回答职责。

仓库此前已经做过两次同类收敛：[web 读者页面按概念拆出三个纯函数模块](../../implemented/architecture/2026-10-24-web-reader-module-split.md)把 21 个无状态导出从 `app.js` 移出，[派生层四片共享逻辑各归其位](../../implemented/architecture/2026-10-24-derive-layer-consolidation.md)把两条派生路径的共享判定收进 `derive-decision` 与 `derive-read`。这两次的经验构成本次重组的前提：按概念拆、测试跟随符号的新家、不留 re-export 桥。

## Decision

按「一个模块回答一个问题」重组，四条原则贯穿全部阶段：按能力拆不按行号拆；契约跟随概念、不建集中式 types；共享规则只留一个实现（当前判定、发布代选源、来源投影、工具配对阶梯、转义策略）；不建 barrel、不留 re-export 桥，调用方直接改到新家。

重组在 2026-10-25 按 0–5 阶段逐提交交付（ccfedf2…24b518b），每阶段独立可回退，行为与对外契约不变。

### 后端结构

`src/queries/` 九个模块：`cursor.ts` 分页游标、limit 校验与 `QueryInputError`；`projection.ts` 行投影（`RequestRow`、`projectRow`、`derivedStateOf`、`GROUP_READ_COLUMNS`、`SUMMARY_*_COL` 族），附查询层共用的安全读取原语（`isRecord`、`finite`、`stringOrNull`、`parseJsonOrNull`）；`sessions.ts`、`requests.ts`、`routes.ts`、`readings.ts`、`stats.ts`、`turns.ts`、`session-summary.ts` 各自承接一项能力的入口与契约。`getRequest` 的 alias 解析、行读取与工具行读取仍在同一个只读事务内；`projectRow` 与 `derivedStateOf` 仍是列表与详情共用的唯一投影实现。

`src/sources/magpie/` 三模块按执行方式分家：`mapping.ts` 字段读取原语与账本/路由映射，`probe.ts` 版本探测与探针持久化（含读取已持久化版本的 `probeVersion`），`costs.ts` 费用同步与窗口、冲突、匹配辅助。

`src/maintenance/` 六模块：`lock.ts`（含 `maintenanceLockPresent` 启动检查）、`verify.ts`、`backup.ts`、`purge.ts`、`rebuild.ts`、`cli.ts`。`runMaintenance` 的 rebuild 分支抽成 `rebuildSession(store, session)`，报告字段与退出码不变；`main.ts` 只从 `maintenance/lock.ts` 导入 `maintenanceLockPresent`，启动路径不再认识备份与淘汰。

`src/derive/` 六模块：`state.ts`（组待办与当前判定、`GROUP_ALGORITHM` 与 `DERIVE_ALGORITHM` 两个算法常量并列、互不复用）、`read.ts`、`decision.ts`、`unit.ts`、`sync.ts`（原 `derive.ts`）。切片实现在 `src/derive/slice/` 七文件：`scheduler.ts` 只留 `sliceGroupStep` 与阶段分派；`generation.ts` 开代、发布指针、丢弃、恢复、退役回收，附阶段共用的 `one`/`count`、`SliceStep`、`assertQueueRevision` 与丢弃判定；`requests.ts`、`roles.ts`、`tools.ts`、`summary.ts`、`ready.ts` 按阶段拆。`derive/unit.ts` 只导入 `slice/scheduler.ts` 与 `slice/generation.ts`（`recoverSlice`），不认识具体阶段；阶段文件之间可以互相导入，导入图无环。

读模型不再依赖切片实现：`DERIVE_ALGORITHM` 从切片实现移进 `derive/state.ts`，`queries/session-summary.ts` 与回填脚本改从 state 导入。两处原有的依赖倒挂（读模型 import 切片实现、启动入口 import 整个维护模块）就此消除。

### 前端结构

第一轮继续平铺在 `web/`：`session-view.js`（会话头、合计行、汇总折叠区、条目列表的纯展示，函数签名改显式输入，附 `clock`/`dayTime`/`agentLabel` 展示格式化）；`layout.js`（主题偏好、首选宽度与拖拽指针由模块持有，暴露 `initLayout`、`openRail`、`applyTheme`、`syncPanelButtons`；轨迹锚点、选中步骤焦点与轮次带定位留在控制器）；`body-model.js`（消息归一化、块视图、回复拆分、工具条目与类型，两种协议的 ord/path 归一化同一实现）；`html.js`（`esc` 与 `mdToHtml`，转义策略唯一实现，`trace-view` 删除逐字副本）；`app.css`（页面全部样式从 `index.html` 整体外置，规则顺序不变）。`reader-store.js` 改为只依赖 `body-model.js`，读取层不再依赖展示层。`body-view.js` 只留字符串渲染、详情面板与能力清单；`roleTag`/`roleClass` 随渲染留下，`toolTint` 是跨轨迹与配对页的工具身份规则，留在 `body-view.js`。`renderAttemptChain`、`PARTS`、`partLabel`、`partColor` 只服务右栏展示，归 `rail-facts.js`。

`web/app.js` 保留页面控制器：store 装配、dispatch/runEffects、导航生命周期、DOM 提交与事件入口，现约 1440 行——低于拆分前的 1771，但仍超过 500 行。接受这个结果：验收看职责归属与状态所有权，不看行数。

### 测试归属

`tests/derive.test.ts` 的 69 个用例按行为归入 `derive-chain`、`derive-presentation`、`derive-tool-pairing`、`derive-purpose`、`derive-rebuild` 五个文件；跨模块一致性测试不拆散——同步与切片逐行等价（`derive-slice.test.ts`）、事务回滚与维护入口对齐（`derive-rebuild.test.ts`）各留在一个文件里。多个文件共用的种子与快照辅助升入 `tests/fixtures.ts`（`seedDeriveRound`、`deriveSnapshot`、`rebuildDeriveGroup`、`seedTextChain`）。`tests/queries.test.ts` 的端口冲突、SIGTERM 与启动任务接线三个进程级用例迁到 `tests/main.test.ts`，与 `startCollector` 其余用例同住。

### 提案与交付的差异

两处有意偏离提案原文，均为避免循环导入：丢弃判定（`SLICE_DISCARD_REASONS` + `sliceDiscardReason`）随丢弃操作住在 `slice/generation.ts` 而非 scheduler——阶段文件要用它，放 scheduler 会造出阶段→调度器的环；`derive/unit.ts` 除 `slice/scheduler.ts` 外另从 `slice/generation.ts` 导入 `recoverSlice`。查询层的安全读取原语落在 `queries/projection.ts`，不设集中式 utils。

## Alternatives considered

**不拆，只加一份模块索引文档。** 索引会腐烂，且不改变「改一个功能要读多少」。仓库的「一个事实一个家」规则也要求实现与文档同处，索引只会新增第二个家。

**按 500 行机械切分。** 会得到若干互传可变对象的小文件：`reader-store` 的缓存按端点拆成多个 store，`derive-slice` 按行号切成几个阶段文件却仍共享同一事务。阅读成本不降，一致性成本上升。

**一次性完成全部重组。** diff 覆盖后端与前端全部大文件，无法按行为范围 review，也无法定位回归来自哪一步。分阶段交付让每个阶段单独回退，本次实际按 11 个提交落地。

**让旧文件 re-export 新符号，调用方不动。** 同一符号会有两个导入点，单一事实重新分裂。此前 web 模块拆分已经否决过这个做法。

**引入前端框架或构建器支撑拆分。** 仓库栈约定不引第三方依赖，现有原生 ES module 与 `bun:test` 足够。

**把 `web/` 新模块放进子目录。** `prototypes/static-web.ts` 的文件名正则拒绝斜杠，生产白名单与目录覆盖断言也按平铺工作。第一轮保持平铺。

**把 `DERIVE_ALGORITHM` 与 `GROUP_ALGORITHM` 合并成一个常量。** 两个号分开是为了让两条路径的产物不能互相复用。本次只把常量搬到同一文件，取值不合并。

**把 `reader-store` 的会话窗口、turns、summary 提成独立模块。** 它们与请求缓存共用 epoch、窗口清理与 turns 串行化。为压行数引入共享 Map、epoch getter 与 reset 回调，会让失效规则更难验证。`reader-store.js` 保持 710 行整体不动。

## Consequences

- 修改会话汇总、工具配对或请求详情时，能从功能名直接找到实现文件与对应测试，不再通读整份单文件实现或整页导航。
- 对外行为不变：API 响应字段、数据库 schema、事务边界、算法号取值、错误码与退出码全部与重组前相同；`getRequest` 单事务、`ingestSource` 单事务等快照边界逐处保留。
- 前端 DOM 契约字符串（`data-step-key`、`data-tool-owner`、`data-call-ord`、`data-fold`、`data-summary-*`）逐字保留；异步代次防护（会话 epoch、`loadEpoch`、`navEpoch`、每请求 `rev`）全部留在控制器与 store。
- 前端新增文件必须登记 `src/http.ts` 的 `STATIC_FILES`，`tests/http.test.ts` 的目录覆盖断言在测试期暴露遗漏。
- 文档与活跃 note 的现行路径引用随各阶段同步；历史实施计划（`docs/superpowers/plans/`）与研究记录保留当时的路径原貌，不作为现行权威。
- 容量脚本整理进 `scripts/capacity/`（场景执行、门槛、支撑、采集器与决策五个文件），纯路径移动；命令入口为 `bun scripts/capacity/capacity.ts`。历史上的基线记录与决策 JSON 保留当时的命令原貌。
- 合成 Demo 不提供会话汇总端点，汇总折叠区的人机验收在生产库完成（[会话信息汇总](../feature/2026-10-25-session-trace-summary.md)）；本次重组对折叠区的验证以纯函数单测与模块图加载为准。

## Testing

每个阶段提交前独立验证：`bun test` 全量 681 用例与阶段 0 基线逐次一致（文件数 44→48，用例总数不变）；`bun run typecheck` 干净；`bun run maintain verify --db <合成库>` 与 `rebuild --db <合成库> --session <key>` 输出与改动前逐字段一致。阶段 4 另用合成 Demo 做了浏览器验收：初始 URL 还原、会话切换、工具配对页四页签、轮次带点击进轮次态、键盘与拖拽调宽、面板折叠 aria 同步、app.css 经样式表加载。
