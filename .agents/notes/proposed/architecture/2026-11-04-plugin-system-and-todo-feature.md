# Agent Note: 页面 Plugin 机制与首个 Todo 插件

Status: proposed

## Problem

项目开源，希望外部开发者能提 PR 给页面加新的阅读能力。当前页面没有可注册、可关闭的能力边界：右栏四个页签硬编码在五处，新增一栏要同时改按钮、URL 往返、分派、主体渲染与滑动次序；每家 Agent 的工具形状差异只能进核心代码。Todo List 是引子，用一件事跑通第二个插件能照着接进来的闭环。衡量这套机制的标准是外部开发者改了哪些文件，Todo 这一屏好看只是第一份证据。

仓库已有本机真实数据。只读探测在 2026-11-04 的快照里找到 744 次 Todo 调用、115 个会话、4 家 Agent；同口径复核时已涨到 819 次、125 个会话。四家是四种状态模型：zcode 与 droid 交全量快照，pi 与 omp 交增量命令；zcode 的 201 次调用里有 194 次 `pending` 没有配对结果。droid 的 `todos` 在 2026-11-05 按真实库校准为带编号的纯文本行，11-04 交接文档记的「JSON 字符串」有误。数字带采集时间，不当固定值。读取不能依赖 `tool_call.result_req`，要从 `request_block` 的 tool_use 参数直接取，配对只作补充。

`plugins/` 这个目录名已被 magpie 的薄 hook 占用。首版要给新机制让出目录，生产 `~/.config/magpie/plugins.json` 第 37 行的 spec 指向旧绝对路径，改名当天不改就会让 hook 加载失败。

## Proposal

首版内置轨与社区轨一起做，社区轨直接接入。Todo 绑定轮次：一轮含多笔 Request，其中一笔更新 Todo，具体哪笔不 care，一轮跑完的 total list 才是要显示的东西。查询输入是会话、actor 与轮号，输出带时点编号与该时点的列表。右栏在路由之后新增第五个页签，Plugin 机制提供注册新页签的能力；页签行提到轮次分岔之前，请求态与轮次态都能点。Todo 按 actor 归属，请求态取当前请求的 `actor`，轮次态取 `mainActorOf()` 的结果，与轮次结算口径一致。

四个页签是请求作用域，现有 `web/app.js:1169` 的 `railHead()` 在 `state.turn !== null` 时整行隐藏，`web/app.js:1409` 的 `railBody()` 同时提前返回命令与回复两块面板。页签硬编码散在 `web/app.js:1194`、`web/app.js:1568` 的 `TAB_ORDER`、`web/url-route.js:40` 与 `:45`、`web/selection.js:239`、`web/app.js:1494`。注册能力把五处收成一份登记数组；登记次序即页签次序，分派不写品牌分支，沿用 [Harness 语义的静态扩展](../../implemented/architecture/2026-10-26-harness-semantics-adapters.md) 的形状。

Plugin 只交 DTO。核心管取数、转义、缓存、失败与页签槽位，插件不 import 核心、不 fetch、不产出 HTML。正文与路由内容在页面一律转义。读取按[读取功能接入规则](../../../../docs/read-feature-rules.md)接入：具名操作进 `src/read-contract.ts`，HTTP Fetch 只进 `web/read-http.js`，并发与取消只归 `web/read-scheduler.js`，证据缓存只归 `web/reader-store.js`。新增 UI 不自动意味着新增 HTTP 路由，`todoByTurn` 走新路由还是复用批端点，按该规则先核对输入、返回事实与一致性要求再定。`src/http.ts` 的 `STATIC_FILES` 白名单要登记新增前端文件，`tests/read-boundaries.test.ts` 与 `tests/http.test.ts` 双向守门。

不新增表、不加列、不升 `SCHEMA_VERSION`、不升 `PURPOSE_VERSION` / `GROUP_ALGORITHM`、不动 `derive`、不装推送通道。状态纯只读，跟着选中轮号重绘，不需要 SSE 或写事务。目录改名把薄 hook 移到 `integrations/magpie-hook/`，同批改 `tsconfig.json`、`scripts/verify-change-notes.mjs` 的 `TRIGGER_PREFIXES`、`scripts/service.ts`、双 README、`docs/operations.md`、根 `AGENTS.md:50` 与 `tests/hook.test.ts` 的 import；生产配置与重启 magpie 宿主是仓库外的部署动作。历史计划文档里的旧路径是当时的记录，不追改。

### 首批 Plugin 与 Parser

Feature 指一类可解释的阅读能力，Parser 指某家 Agent 对该能力的形状适配，Plugin 指可注册、可关闭的一份能力包。首版只做 Todo 一个 Plugin，内含四个 Parser。第一批做全量快照型的 zcode 与 droid，验证第五页签、读取契约与静态登记；第二批做增量命令型的 pi 与 omp，验证同一 Plugin 能容纳重放状态机。Todo 跑通之前不立第二个 Plugin；Plan、Subagent、Skill 调用留作后续候选，本轮只排序。

旧功能不做搬迁。右栏四页签内部的 skill chip、WebSearch 子事件卡、工具往返配对页只是在既有页签里多渲染一种行或卡片，搬走只能证明能搬，证明不了可注册、可关闭。会话汇总组清单看起来像独立页签，实际由 `web/app.js:1409` 的 `summaryList` 把右栏整块替换，优先于轮次态与请求态；它没有独立页签槽位，按同一判据留到 Todo 闭环之后再评估。摄入、derive、schema、三路证据收敛、HTTP 身份认证、读取架构的调度与缓存留在核心；它们是账本与信任边界，关掉任何一项都会让数据不完整或不可信。`src/harness/purpose.ts` 的 `PURPOSE_RULES` 与 `src/sources/session/registry.ts` 的 `SESSION_ADAPTERS` 已经给出登记加注入关闭的现成形状，前者有 `tests/harness-purpose.test.ts` 的注入式测试 seam；两者分别属于 derive 期与摄入期，原地保留，Plugin 的登记数组照它们的形状写。

### 与既有记录的关系

supersession check 覆盖三条记录。[Harness 语义的静态扩展](../../implemented/architecture/2026-10-26-harness-semantics-adapters.md) 在 `:85` 否决过建设动态插件加载器，理由是当时只需要仓内静态适配、不需要第三方代码执行和市场；现在要做社区轨，失效的是这条理由的前提，Harness 专属用途走静态登记这个决策本身继续有效。旧记录保持活跃，实施时双向链接。已交付的登记层、第五页签与 `todoByTurn` 接缝另见[Plugin 登记层与 Todo 页签](../../implemented/architecture/2026-11-05-plugin-registry-and-todo-tab.md)，社区轨的清单加载、Worker 隔离与 `failed` 状态见[社区轨的本地包加载与 Worker 隔离](../../implemented/architecture/2026-11-05-community-plugin-worker.md)，本提案继续持有整体方案与社区轨决策。[读取架构与多客户端演进](../../implemented/architecture/2026-11-02-read-architecture-and-client-seams.md) 继续持有页面读取的统一入口，本提案只消费它，规则细节归 `docs/read-feature-rules.md`。[Agent Profile 与请求类别注册表](2026-10-22-agent-request-kind-registry.md) 在 `:109` 与 `:212` 声明 RequestKind 不是插件系统、不需要运行时加载，限定的是该机制自身，两者范围不重叠。目录改名会让 implemented 记录里指向 `plugins/collector.hooks.ts` 的链接与目录描述过期，按 [implemented 记录同步规则](../../implemented/AGENTS.md) 在同一个变更里更新事实，不改决策。

### 社区轨首版范围

2026-11-05 拍板：外部代码用 Bun Worker 加载，首版只装本地包。Worker 复用 `src/derive/worker.ts:51` 的 `new Worker(ENTRY)`，超时与崩溃可以 terminate，兑现社区包出错只隐藏该页签、其余四栏照常工作；`src/plugins/runtime/` 首版就写，承载 Worker host 与消息协议。Bun Worker 仍与采集器同进程，外部代码拥有宿主权限，安装入口要写明只装可信代码。

市场不联网：用户把可信包放进本机目录，清单登记，`api` 字段比对后不兼容就拒绝加载，内置轨照常工作。首版不做远程 registry、自动更新、签名校验与安装失败回滚，`market.ts` 不写，本地包清单加载器另起名。Magpie 社区轨是 5774 行 host、长驻 Bun 子进程、NDJSON 行协议加信用窗口，官方明说 Bun 插件有宿主权限、只装可信代码；Tracery 是 Bun 单进程、不引依赖，CSP 没有 `frame-src`，照搬会先扩大信任边界，进程级隔离与远程市场留到后续。

## Alternatives considered

**首版只做内置轨。** 落选。用户要求首版双轨都做、社区轨直接接入，理由是日后要开放社区市场。只交付静态登记会让第二个外部 PR 再改一次架构。

**Todo 绑 reqId。** 落选。一轮含多笔 Request，某笔更新的具体位置不影响阅读；按请求号取列表会漏掉同轮后续更新，也会让子代理的工具行插进主流程时间线。

**绑轮次但按会话归属。** 落选。真实库 115 个含 Todo 会话里有 6 个跨 actor，共 123 个 `(conv_key, actor)` 组。按会话合并会让子代理的 Todo 插进主流程时间线，同一时点出现两份列表；增量命令按序 apply 时，A 的 create 可能被 B 的 done 提前关掉。按 actor 与轮次结算口径一致，这 6 个会话是两种口径差别的全部影响面。

**在右栏读数页加一个 section。** 落选。四个页签各有请求作用域的取数与渲染，Todo 是轮次态全量列表；塞进读数页会把两套作用域混在同一栏。用户拍板在路由之后新增第五个页签，Plugin 提供注册能力。

**Todo 物化成表、改 derive 或加推送。** 落选。零 schema 变更、零 backfill、零 derive 改动是首版地基，复用 `renderRail()` 的重绘链即可跟选中轮号变。代价是正文回收后 Todo 会消失，要长期保留就得接受 v13 加表与显式 backfill。

**把现有四页签的内容整体搬进 Plugin 模块。** 落选。它们与核心取数、账本身份和阅读态耦合，搬动只会增加一层转发，且关掉任何一个都会让页面缺一块基础事实。首版要证明的是新增能力可注册、可关闭，用 Todo 一个独立页签即可。

**先把会话汇总组清单或工具往返配对页搬成第二个 Plugin。** 落选。汇总组清单是 `summaryList` 的第三态，把右栏整块替换；配对页仍持有 `toolOrd` / `toolOwner` / `toolPage` 状态。两者都要先改宿主状态模型，Todo 闭环之前动它们会把首版从验证机制变成改造页面。

**照搬 Magpie 的社区轨。** 落选。5774 行 host 里很大一部分在跨 Go 与 Node.js 边界，Tracery 没有这道边界；远程 registry、自动更新与 iframe 沙箱会把首版拉成另一个项目。2026-11-05 定为 Bun Worker 加本地包清单，进程级隔离与远程市场留到后续。

## Acceptance criteria

- 合成数据覆盖四家 Parser 的命中、形状相似但不命中、参数缺失、正文已回收四类反例。
- 同一会话按轮次递增读取，第五页签内容随轮号变化，回退轮号能还原；一轮内多次 Todo 更新先 apply 完再显示，不出现中间态。
- 页签行上提后，请求态与轮次态都能点到第五栏，四栏在轮次态不误读请求作用域。
- 6 个跨 actor 会话按 actor 验证：Todo 不串线，增量命令 apply 不互相关闭。
- 迟到响应不写回；插件返回畸形 DTO 时核心不崩，全部文本经过 `esc()`。
- 社区包 `api` 不兼容时拒绝加载，内置轨照常工作；社区包超时或抛错时只隐藏该页签内容，其余四栏不受影响。
- `tests/plugin-boundaries.test.ts` 覆盖 Parser 不 import 核心、不 fetch、不产出 HTML；`tests/read-boundaries.test.ts`、`tests/http.test.ts` 静态白名单双向覆盖；`bun run typecheck` 通过。
- 目录改名后 `tests/hook.test.ts` 通过，生产 `plugins.json` 的 spec 已同步且 magpie 宿主已重启。
- `verify:notes` 通过；合成验收与真实流量验收分开记录。

## Risks

zcode 的 `TodoWrite` 大量未配对结果，读取若退回依赖 `tool_call.result_req`，列表会静默变空。正文回收后 Todo 会消失，这是零迁移的代价。双轨首版同批扩大审查面：Worker 超时与崩溃隔离、`api` 不兼容拒绝、畸形 DTO 都要跟合成测试，不能只验内置 Parser。Bun Worker 与采集器同进程，外部代码拥有宿主权限，安装入口写清只装可信代码；进程级沙箱与远程市场留到后续。目录改名牵动生产配置，漏改或漏重启会让 hook 加载失败，采集出现缺口。

实现走仓库上级目录 `.codex-worktrees/atc-plugin-system` 的 `feat/plugin-system` 分支，合并前不动主检出的 `src/` 与 `web/`。测试只用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。
