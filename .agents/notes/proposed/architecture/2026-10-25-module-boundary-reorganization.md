# Agent Note: 按职责重组大模块，建立可评审的分层边界

Status: proposed

## Problem

本仓库已经有多个源码文件超过 500 行，Agent 阅读与修改时需要在同一份文件里区分多项无关职责。原始需求是重新组织代码结构、更好地分层管理实现，让一次修改只需要读它真正涉及的部分。这份提案记录评估结论与实施计划，交给后续 Agent 评审并执行。

500 行不是拆分标准。它在这里只触发一次职责检查：文件里是否住着多项可以独立描述的能力、是否有多处共享可变状态、是否有跨模块契约被埋在实现细节里。评估没有测量 Agent 阅读耗时，因此不给出「超过 500 行导致效率下降多少」的数字；判断依据是源码里的职责边界与依赖方向。

背景来自一次连续的功能迭代。查询层陆续接入请求列表、详情、路由解释、来源事实、轮次结算与会话汇总；页面在同一份脚本里接入会话头、轮次带、右栏四页与布局控制。每一项单独看都合理，累计之后，`src/queries.ts` 与 `web/app.js` 各自成了「与某个对象有关的全部代码」的容器。文件名仍在回答对象，不再回答职责。

仓库此前已经做过两次同类收敛：[web 读者页面按概念拆出三个纯函数模块](../../implemented/architecture/2026-10-24-web-reader-module-split.md)把 21 个无状态导出从 `app.js` 移出，[派生层四片共享逻辑各归其位](../../implemented/architecture/2026-10-24-derive-layer-consolidation.md)把两条派生路径的共享判定收进 `derive-decision` 与 `derive-read`。这两次的经验构成本提案的前提：按概念拆、测试跟随符号的新家、不留 re-export 桥。

## 评估证据

以下数字是 2026-10-25 在提交 `898574b` 上按物理行统计的快照，含空行、注释与类型声明。

| 范围 | 超过 500 行的文件 | 最大者 |
| --- | --- | --- |
| `src/` | 9 | `queries.ts` 1651、`derive-slice.ts` 1314 |
| `web/` | 4 | `app.js` 1771、`body-view.js` 788 |
| `tests/` | 14 | `derive.test.ts` 1532、`derive-slice.test.ts` 976 |
| `scripts/` | 3 | `capacity.ts` 1527 |
| `prototypes/` | 1 | `synthetic-server.ts` 836 |

同一批文件里，行数分布并不等于阅读成本。`web/index.html` 的 663 行中有 610 行是内联样式，页面骨架只有约 40 行；`web/reader-store.js` 的 710 行围绕一套缓存与失效规则展开，语义集中。真正需要处理的是职责混合、共享状态与跨模块契约，行数只是把这些问题的位置标出来。

### 后端：文件名无法回答「改这个功能该读哪」

`src/queries.ts` 同时承载八项可独立描述的能力，各有自己的入口：

| 能力 | 入口符号 |
| --- | --- |
| 会话列表与标题选取 | `listSessions`、`SESSION_TITLE_SQL`、`SESSION_FLAG_COLUMNS` |
| 派生状态与行投影 | `derivedStateOf`、`projectRow` |
| 请求列表与详情 | `listRequests`、`getRequest`、`REQUEST_COLUMNS` |
| 路由解释 | `attemptChainOf`、`routeSummaryReading`、`getRoute` |
| 来源事实展示 | `sourceFactsReading`、`projectionMetaReading`、`promptReadingOf`、`derivationOf` |
| 健康统计 | `getStats` |
| 轮次结算 | `listTurns`、`mainActorOf`、`commandOrdinals` |
| 会话汇总 | `getSessionSummary`、`getSummaryEntries`、`EFFECTIVE_TOOL_SQL` |

其中两项必须保持同处：`getRequest` 在一个只读事务里解析 alias、取行与工具行，`projectRow` 与 `derivedStateOf` 被列表与详情共同消费。拆分时不能把「谁决定当前值」和「谁在哪个快照里读」分开。

`src/sources/magpie.ts` 把三种执行方式不同的职责放在一起：字段映射是纯数据转换（`mapLedgerRow`、`mapRouteRow`、`normalizeResponseId`），版本探测是一次外部 HTTP 加本地文件读取（`probeMagpie`、`saveProbe`），费用同步是带持久进度的分页任务（`syncCosts` 及其窗口、冲突、匹配辅助）。它们共享的只有 magpie 这个对象名。

`src/maintenance.ts` 的 860 行里，维护锁（`lockPath`、`acquireMaintenanceLock`）、库校验（`verifyDatabase`）、备份与恢复（`backupDatabase`、`backupBundle`、`restoreBundle`）、元数据淘汰（`previewMetadataPurge`、`purgeMetadata`）与 CLI 解析（`parseArgs`、`runMaintenance`）各自有独立契约。`runMaintenance` 的 rebuild 分支内联了排空循环与报告拼装，约 60 行。

### 两处真实的依赖倒挂

`src/queries.ts` 为读取一个算法版本常量导入整个切片实现（`DERIVE_ALGORITHM` 来自 `derive-slice.ts`），于是读模型的依赖图里挂上了整台切片流水线。`src/main.ts` 为检查维护锁是否存在导入整个维护模块（`maintenanceLockPresent` 来自 `maintenance.ts`），启动入口因此认识备份、淘汰与 CLI。

两处都不影响正确性，但都让「理解这个功能需要读多少」变大。这与[五个放错层的符号归位](../../implemented/architecture/2026-10-23-symbol-relocations.md)处理的形状相同：符号应当住在它概念所属的层。

### 前端：一个 DOM 闭包承担整页

`web/app.js` 在 `typeof document !== 'undefined'` 的守卫内运行，一个闭包同时持有选择状态（`state`、`dispatch`、`runEffects`）、折叠状态、会话汇总条目视图（`summaryList`）、批次与导航代次（`loadEpoch`、`navEpoch`）、布局宽度与主题偏好。职责区块大致是：会话栏与面包屑、会话头与汇总折叠区、轨迹与轮次带、右栏四页、汇总条目列表、导航与分页、滚动与焦点恢复、主题与拖拽。

`web/reader-store.js` 从 `web/body-view.js` 导入 `deltaOrdinals` 与 `messageEntries`。这两个函数是读取模型转换，不产生 HTML，却与 Markdown、转义和整套正文渲染住在同一文件。读取层因此依赖展示层。

`web/trace-view.js` 复制了一份 `esc`（与 `body-view.js` 的导出逐字同义）。转义策略是安全边界，应当只有一处实现。

`web/index.html` 的 `<style>` 覆盖页面全部样式，含工具色类顺序与响应式覆盖。样式有真实的加载顺序依赖，不适合按 500 行继续切分。

### 测试与静态发布的耦合

`tests/queries.test.ts` 的 882 行里混有端口冲突、SIGTERM 停止与启动任务接线三个进程级用例，其余才是查询行为。`tests/derive.test.ts` 的 60 个用例跨前驱关系、标题与摘要、工具配对、用途协调与维护重建。按功能名找不到对应测试入口。

前端新增文件必须同时满足三处约束：`src/http.ts` 的 `STATIC_FILES` 白名单、`prototypes/static-web.ts` 的 `serveWeb`（文件名正则拒绝斜杠，不接受子目录）、`tests/http.test.ts` 对 `web/` 目录与白名单的互相覆盖断言。`tests/web.test.ts` 直接导入 `app.js` 的 `restoreScroll`，依赖 `app.js` 的 `document` 守卫避免在测试里初始化页面。

## Proposal

按「一个模块回答一个问题」重组，先把职责混合最严重的文件拆开，再按依赖方向归位共享契约。目录与命名可以自由调整，这是首版 tag 之前的地基优先立场（[根 AGENTS.md](../../../../AGENTS.md)）。

四条原则：

1. **按能力拆，不按行号拆。** 每个新模块能用一句话说明它负责什么；说不出来就说明还没找到边界。
2. **契约跟随概念。** 类型、常量与 SQL 片段住在它服务的那个能力里。确实被多方共享的契约再单独归位，不建集中式 `types.ts`。
3. **共享规则只留一个实现。** 当前判定、发布代选源、来源投影、工具配对阶梯、转义策略，拆分后不得出现第二份。
4. **不建 barrel，不留 re-export 桥。** 调用方直接改到新家，测试跟随符号。理由见 [web 模块拆分](../../implemented/architecture/2026-10-24-web-reader-module-split.md)对 re-export 的否决。

### 后端目标结构

```text
src/
  main.ts
  config.ts
  store.ts
  format.ts

  queries/
    cursor.ts            分页游标、limit 校验、QueryInputError、Page
    projection.ts        DerivedState、derivedStateOf、projectRow、HistoricalResult
    sessions.ts          listSessions、会话标题与状态列
    requests.ts          listRequests、getRequest、请求行列清单与类型
    routes.ts            attemptChainOf、routeSummaryReading、getRoute、白名单挑选
    readings.ts          sourceFactsReading、projectionMetaReading、promptReadingOf、derivationOf
    stats.ts             getStats
    turns.ts             listTurns、mainActorOf、commandOrdinals
    session-summary.ts   getSessionSummary、getSummaryEntries、EFFECTIVE_TOOL_SQL

  sources/
    magpie/
      mapping.ts         字段读取、时间与响应 ID 规范化、账本与路由映射、形状类型
      probe.ts           版本探测与探针持久化
      costs.ts           费用周期校验、费用状态、分页同步与窗口状态
    files.ts
    raw.ts
    projection.ts
    facts.ts

  maintenance/
    lock.ts              维护锁与启动期检查
    verify.ts            verifyDatabase
    backup.ts            backupDatabase、backupBundle、restoreBundle
    purge.ts             previewMetadataPurge、purgeMetadata
    rebuild.ts           单会话重建的排空与报告
    cli.ts               参数解析、USAGE、命令分派

  derive/
    state.ts             组待办与当前判定、算法常量
    read.ts              共享读取层
    decision.ts          判定内核
    unit.ts              调度入口
    sync.ts              同步组阶段
    slice/
      scheduler.ts       选组、阶段分派、丢弃判定
      generation.ts      开代、发布、丢弃、恢复、退役回收
      requests.ts        请求物化阶段
      roles.ts           角色阶段
      tools.ts           工具配对阶段
      summary.ts         摘要阶段
      ready.ts           完成校验与发布
```

`queries/` 的拆分必须保留两条事实：`projectRow` 与 `derivedStateOf` 是列表与详情共用的唯一投影实现；`getRequest` 的 alias 解析、行读取与工具行读取留在同一个只读事务内。拆成模块不等于拆成事务。

`DERIVE_ALGORITHM` 从 `derive-slice.ts` 移到 `derive/state.ts`，与 `GROUP_ALGORITHM` 并列。两个号仍保持不同取值、互不复用，只是不再让读模型为读一个常量依赖整条切片流水线。这条改动不合并算法号，[派生层四片共享逻辑](../../implemented/architecture/2026-10-24-derive-layer-consolidation.md)里对合并的否决继续有效。

`maintenance/lock.ts` 独立后，`main.ts` 只导入 `maintenanceLockPresent`，启动路径不再认识备份与淘汰。

### 前端目标结构

第一轮继续平铺在 `web/`，只按职责增加语义明确的文件：

```text
web/
  app.js            页面控制器：store 装配、dispatch/runEffects、导航生命周期、DOM 提交、事件入口
  app.css           页面全部样式，从 index.html 整体移出
  session-view.js   会话头、合计行、汇总折叠区、汇总条目列表的纯展示
  layout.js         主题、侧栏与详情栏宽度、拖拽与键盘调宽、面板按钮同步
  body-model.js     消息归一化、块视图、角色、增量序号、回复视图、工具条目与类型
  body-view.js      正文字符串渲染、详情面板、能力清单、路由尝试链展示
  html.js           esc 与 mdToHtml，转义策略唯一实现
  reader-store.js   请求读取生命周期，保持整体
  trace-view.js     步骤投影与行渲染，esc 改从 html.js 取
  rail-facts.js     右栏事实页
  row-summary.js、selection.js、trace-pair.js、turn-band.js、url-route.js  不变
```

`session-view.js` 的函数接收显式输入：会话行、窗口状态、汇总快照、展开状态与定位提示。它不接收整个 `state`、不接收 store、不发网络请求。`layout.js` 自己持有主题偏好、首选宽度与拖拽指针，只暴露初始化、`openRail` 与必要的布局同步能力。

`body-model.js` 承接 `messageBlocks`、`messageEntries`、`deltaOrdinals`、`replyView`、`toolEntries`、`previewOf`、`blockView`、`roleOf`、`displayRoleOf`、`topSystemText`、`messageCopyText` 与 Entry/Block/ReplyView 类型。两种协议的 ord/path 归一化保持同一实现，不按协议再分两个会互相调用的文件。`reader-store.js` 改为只依赖 `body-model.js`。

`renderAttemptChain`、`PARTS`、`partLabel`、`partColor` 只服务右栏展示，与协议正文解析无关，归 `rail-facts.js`。`toolTint` 是跨轨迹、配对页与汇总共用的工具身份规则，单独成为工具展示模块或留在 `body-view.js`，不放进 `body-model.js`。

### 不拆的部分

| 模块 | 保留理由 |
| --- | --- |
| `web/reader-store.js` | 会话 epoch、请求 token、缓存 revision、迟到响应、整笔失效与四并发共用一套一致性规则；按端点拆会各自复制失效逻辑 |
| `src/reconcile.ts` | `ingestSource` 保证坏行、证据、游标同事务提交；内部账本与路由处理可拆文件，提交顺序不能外移 |
| `src/derive-decision.ts` | 两条派生路径共用的判定内核；可按链关系、工具配对、摘要分内部文件，不能按路径复制 |
| `src/sources/projection.ts` | 以证据集合为输入统一决定请求事实，入口集中；继续增长时再分证据读取、判定与写入 |
| `web/selection.js` | `applyIntent` 是选择转换的唯一写者，纯转换加有序 effects 的边界已经成立 |
| `web/index.html` 样式 | 整体外置为一份 `app.css`；继续分组要按主题变量、布局、组件划分，并保持覆盖顺序，不按行数切 |

## 分阶段实施计划

每个阶段独立提交、独立可回退。同一阶段内先做纯移动，再改导入点，最后跑验证。阶段之间不共享分支。

### 阶段 0：基线

1. 在干净工作区记录 `bun test` 与 `bun run typecheck` 的通过状态，记下用例总数，作为后续对照。
2. 删除评估中发现的零调用符号：`app.js` 的 `requestOpen`、`messageOrdOf`、`HAVE_ROUTE`，以及 `app.js` 从 `body-view` 导入但未使用的 `partColor`、`partLabel`。删除前逐个 `rg` 确认无调用。
3. 不做其他改动。这一步只为让后续 diff 干净。

验收：全量测试与类型检查通过，且与改动前用例数一致。

### 阶段 1：查询按能力拆分

1. 新建 `src/queries/`，按上表逐文件搬移符号。`cursor.ts` 承接 `encodeCursor`、`decodeCursor`、`checkLimit`、`QueryInputError`、`Page`。
2. `projection.ts` 承接 `DerivedState`、`derivedStateOf`、`projectRow`、`ProjectableRow`、`HistoricalResult`、`GROUP_READ_COLUMNS`、`SUMMARY_STATE_COL` 族。`sessions.ts` 与 `requests.ts` 都从它导入，不在各自文件里复制判定。
3. `requests.ts` 的 `getRequest` 保持单事务结构：alias 解析、行读取、工具行与反向配对读取仍在同一个 `store.read.transaction` 内。
4. 直接改导入点，不保留 `src/queries.ts` 汇总入口。调用方是 `src/http.ts`、`src/reading.ts`、`prototypes/synthetic-server.ts` 与六个测试文件。
5. 删除 `src/queries.ts`。

验收：`bun run typecheck` 通过；`bun test tests/queries.test.ts tests/session-summary.test.ts tests/turn-settlement.test.ts tests/http.test.ts` 通过；`bun test` 全量通过且用例数不变。

### 阶段 2：magpie 三项职责分开

1. 新建 `src/sources/magpie/mapping.ts`，承接字段读取、`parseTimestamp`、`normalizeResponseId`、`classifyLedger`、`mapLedgerRow`、`mapRouteRow` 与全部形状类型。
2. 新建 `probe.ts`，承接 `ProbeResult`、`versionVerified`、`probeMagpie`、`saveProbe`。
3. 新建 `costs.ts`，承接 `validateCostPeriod`、`assertCostPagePeriod`、`costState`、`costWindowKey`、`syncCosts` 及其窗口、冲突、匹配辅助。
4. 改导入点：`src/reconcile.ts`、`src/hook.ts`、`src/sources/raw.ts`、`src/sources/projection.ts`、`src/main.ts` 与相关测试。
5. 删除 `src/sources/magpie.ts`。

验收：`bun test tests/magpie.test.ts tests/projection.test.ts tests/reconcile.test.ts tests/hook.test.ts tests/commit-unit.test.ts` 通过；全量测试通过；`bun run typecheck` 通过。

### 阶段 3：维护模块与启动锁

1. 新建 `src/maintenance/`，按上表搬移锁、校验、备份恢复、淘汰与 CLI。
2. 把 `runMaintenance` 的 rebuild 分支抽成 `rebuild.ts` 的 `rebuildSession(store, session)`，返回现在拼进 JSON 的字段；`cli.ts` 只保留参数解析、锁获取与输出格式。抽取是纯移动，不改报告字段与退出码。
3. `src/main.ts` 改为从 `maintenance/lock.ts` 导入 `maintenanceLockPresent`。
4. `package.json` 的 `maintain` 脚本与 `docs/operations.md` 的命令位置同步到新入口。
5. 改测试导入点：`tests/maintenance.test.ts`、`tests/reconcile.test.ts`、`tests/derive.test.ts`。

验收：`bun test tests/maintenance.test.ts` 通过；`bun run maintain verify --db <合成库>` 输出与改动前逐字段一致；全量测试通过。

### 阶段 4：页面展示、布局与正文模型

按四个小步交付，每步单独可回退：

1. **`session-view.js`**：搬出 `sessionTotalsHtml`、`coverageHoverText`、`pathLabel`、`summaryToolChips`、`summaryPathFlow`、`summarySkills`、`summaryStructure`、`sessionSummaryFold`、`sessionHead`、`railSummaryListHtml`。函数签名改为显式输入；`openSummaryList` 的网络与状态更新留在控制器。
2. **`layout.js`**：搬出 `applyTheme`、主题按钮处理、`clampWidth`、`resizeRail`、`fitRail`、`syncPanelButtons` 与拖拽、键盘事件。模块自己持有 `themePref`、`preferredRailWidth`、`draggingPointer`。轨迹锚点、选中步骤焦点与轮次带定位留在控制器。
3. **`body-model.js` 与 `html.js`**：搬出读取模型函数与类型，`reader-store.js` 改依赖；`esc` 与 `mdToHtml` 归 `html.js`，`trace-view.js` 删除本地 `esc` 并改从 `html.js` 导入。`tests/body-view.test.ts` 按新家改导入，保留协议路径、XSS 转义与复制原文三类断言。
4. **`app.css`**：把 `index.html` 的 `<style>` 整体移到 `web/app.css`，规则顺序不变，`<link rel="stylesheet" href="/app.css">` 替换原标签。CSP 的 `style-src 'unsafe-inline'` 保留，页面仍有动态 style 属性。

每步都要同步 `src/http.ts` 的 `STATIC_FILES`（新增 `app.css` 的 `text/css` 条目）与 `tests/web.test.ts` 的导入源。`tests/http.test.ts` 的目录覆盖断言会自动发现漏登记。

验收：`bun test tests/web.test.ts tests/http.test.ts tests/body-view.test.ts tests/trace-view.test.ts tests/reader-store.test.ts` 通过；`bun run typecheck` 通过；用合成 Demo 打开页面，确认初始 URL 还原、窗口外请求、工具配对页、轮次带、汇总折叠、滚动与焦点恢复、窄屏堆叠与详情栏拖拽。合成验收与真实流量验收分开记录。

### 阶段 5：派生目录与测试归属

1. 新建 `src/derive/`，先搬 `state.ts`、`read.ts`、`decision.ts`、`unit.ts`、`sync.ts`，改全部导入点。这一步只换路径。
2. 再拆 `slice/`。`scheduler.ts` 保留 `sliceGroupStep` 与丢弃判定；`generation.ts` 保留开代、发布、丢弃、恢复与退役回收；其余按阶段拆。`derive/unit.ts` 只导入 `slice/scheduler.ts`。阶段文件之间可以互相导入，但不得让 `unit` 认识具体阶段。
3. 测试按行为重新分组，文件名对应功能：链关系与增量、展示与标题、工具配对、用途协调、维护重建。跨模块一致性测试（同步与切片逐行等价、事务回滚、发布快照、缓存失效）保留在同一文件，不随源码拆分拆散。
4. 把 `tests/queries.test.ts` 的端口冲突、SIGTERM 与启动任务接线用例移到 `tests/main.test.ts`。

验收：`bun test tests/derive.test.ts tests/derive-slice.test.ts tests/main.test.ts` 通过；全量测试通过且用例总数不变；`bun run typecheck` 通过；`bun run maintain rebuild --db <合成库> --session <key>` 报告字段不变。

### 阶段 6：容量脚本（可选，最后做）

`scripts/capacity.ts`、`capacity-gate.ts`、`capacity-support.ts`、`capacity-collector.ts` 按参数解析、场景执行、子进程生命周期、报告与门槛评估整理到 `scripts/capacity/`。同步 `package.json`、`docs/superpowers/capacity/` 与 `tests/capacity*.test.ts` 的路径。这一步不影响运行时，可以单独排期。

### 文档同步

每个阶段同一提交内更新：`docs/architecture-design.md` 中引用的源码路径、`docs/operations.md` 的命令位置、`.agents/notes/implemented/` 里提到旧路径的活跃 note、根 `AGENTS.md` 的仓库布局（仅在顶层目录变化时）、`README.md` 的运行命令。归档区冻结，不改。

## Alternatives considered

**不拆，只加一份模块索引文档。** 索引会腐烂，且不改变「改一个功能要读多少」。仓库的「一个事实一个家」规则也要求实现与文档同处，索引只会新增第二个家。

**按 500 行机械切分。** 会得到若干互传可变对象的小文件：`reader-store` 的缓存按端点拆成多个 store，`derive-slice` 按行号切成几个阶段文件却仍共享同一事务。阅读成本不降，一致性成本上升。

**一次性完成全部重组。** diff 覆盖后端与前端全部大文件，无法按行为范围 review，也无法定位回归来自哪一步。分阶段交付可以让每个阶段单独回退。

**让旧文件 re-export 新符号，调用方不动。** 同一符号会有两个导入点，单一事实重新分裂。此前 web 模块拆分已经否决过这个做法。

**引入前端框架或构建器支撑拆分。** 仓库栈约定不引第三方依赖，现有原生 ES module 与 `bun:test` 足够。拆分不需要新工具。

**把 `web/` 新模块放进子目录。** `prototypes/static-web.ts` 的文件名正则拒绝斜杠，生产白名单与目录覆盖断言也按平铺工作。第一轮先平铺，等确实需要分组时再统一改两个发布面。

**把 `DERIVE_ALGORITHM` 与 `GROUP_ALGORITHM` 合并成一个常量。** 两个号分开是为了让两条路径的产物不能互相复用。本提案只把常量搬到同一文件，不合并取值。

**把 `reader-store` 的会话窗口、turns、summary 提成独立模块。** 它们与请求缓存共用 epoch、窗口清理与 turns 串行化。为压行数引入共享 Map、epoch getter 与 reset 回调，会让失效规则更难验证。

## Acceptance criteria

每个阶段单独满足，不要求一次性全部完成：

1. `bun test` 全量通过，用例总数与阶段 0 基线一致；`bun run typecheck` 干净。
2. 对外行为不变：API 响应字段、数据库 schema、事务边界、算法号取值、错误码与退出码都与改动前相同。
3. 导入图无环，且不出现「下层模块导入上层模块」的新倒挂。`src/queries/` 不依赖 `derive/slice/` 的实现，`main.ts` 不依赖维护模块的实现。
4. 每个新模块能用一句话描述职责；同一职责不在两个文件里各有一份实现。
5. 修改会话汇总、工具配对或请求详情时，能从功能名直接找到实现文件与对应测试，不需要通读整页导航或缓存生命周期。
6. 前端新增文件已登记 `STATIC_FILES`，`tests/http.test.ts` 的目录覆盖断言通过；页面在合成 Demo 上完成阶段 4 列出的交互验收。
7. 文档与活跃 note 中不再有指向已删除路径的引用。
8. 不因拆分删除承担契约的 JSDoc、`@ts-check` 或 `tests/reader-types.ts` 的类型检查。

## Risks

**拆散事务与快照。** `getRequest` 的 alias、行与工具行必须同快照；`ingestSource` 的坏行、证据与游标必须同事务；派生发布校验必须在切换指针之前完成。拆分时最容易犯的错是把「搬函数」做成「搬事务边界」。缓解：这些入口在阶段验收里单独列出，改完先跑对应测试再跑全量。

**丢失异步代次防护。** 页面有 store 的会话 epoch、批次 `loadEpoch`、导航 `navEpoch` 与每请求 `rev` 四层身份。抽展示与布局时，导航防护必须留在控制器；`resolveInitialTrace` 一类在 await 之后写选择的地方要逐处核对。缓解：阶段 4 的合成验收包含快速切换会话与迟到响应。

**DOM 契约字符串被改名。** `data-step-key`、`data-tool-owner`、`data-call-ord`、`data-fold`、`data-summary-*` 是渲染模块与事件委托之间的实际接口。搬文件不代表可以改这些字符串，失败按钮先处理再 early return 的顺序也要保留。

**静态白名单漏登记。** 新增模块未登记会让整个 ES module 依赖图加载失败，页面白屏。缓解：`tests/http.test.ts` 的目录覆盖断言在测试期暴露，阶段 4 每步都跑它。

**测试拆分后失去跨模块验证。** 同步与切片等价、事务回滚、发布快照、缓存失效这些测试保护的是系统契约，不随源码拆分拆散。缓解：验收条件要求用例总数不变，且这些用例仍在同一文件。

**文档路径腐烂。** 架构文档与活跃 note 大量引用 `src/queries.ts`、`src/sources/magpie.ts`、`web/app.js` 等路径。缓解：每个阶段同一提交内更新引用，`rg` 旧路径作为收尾检查。

**范围蔓延。** 重组过程中容易顺手修掉评估里发现的既有问题，例如 `summaryList` 的异步归属与切会话清理。这些应另立 bug-fix note 并单独验证，不混进结构变更，否则回归无法归因。缓解：阶段 0 明确列出只做死代码删除，其余问题记录不处理。

**本提案有意放弃的东西。** 第一轮不追求每个文件都在 500 行以内：`app.js` 仍可能超过 500 行，`reader-store.js` 仍保持 710 行左右。接受这个结果，因为验收看的是职责归属与状态所有权，不看行数。
