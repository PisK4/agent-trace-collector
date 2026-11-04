# Agent Note: 社区轨的本地包加载与 Worker 隔离

Status: implemented

## Problem

社区轨要在采集器进程里执行第三方代码。需要回答四件事：外部代码在哪跑、清单从哪读、api 版本怎么协商、出错时怎么保证其余四栏照常工作。首版范围已拍板：Bun Worker 加载、只装本地包、不联网、不写市场模块（见[页面 Plugin 机制与首个 Todo 插件](../../proposed/architecture/2026-11-04-plugin-system-and-todo-feature.md)的「社区轨首版范围」）。

## Decision

**执行位置。** `src/plugins/runtime/worker.ts` 的 `createCommunityWorker()` 照 `src/derive/worker.ts` 的形状写：懒启动、`new Worker(ENTRY)`、按 id 丢弃迟到回复、出错 terminate 并置空引用。两处差异是读路径带来的：并发来自多个页面请求，所以后来的任务排队而不是像派生那样直接拒绝；并补上派生实现没有的超时——默认 1500 ms，到点 terminate。超时、崩溃、包内抛错都折成固定分类码（`plugin_timeout` / `plugin_failed`），包的异常文本不出线程。同一包失败一次即记入 `dead`，本进程内不再重试，避免每次读都等满一个超时。

**清单与认领。** `src/plugins/runtime/manifest.ts` 读数据目录下的 `plugins/plugins.json`，每项声明 `id`、`agent`、`api`、`entry`。`agent` 由清单给出而不是 import 包再读：主线程不执行外部代码，认领关系在启动时就定下来。校验顺序是 api 比对、id 必须在 `PLUGIN_REGISTRY` 里、entry 解析后必须仍在根目录内、文件必须存在；任何一项不过只记固定分类码并跳过该包。清单缺失按「没有社区包」处理，不报错。

**让位规则。** 清单里登记了某家 Agent 的社区包后，该 Agent 的内置 Parser 让位，避免两套状态机各自折叠出互相覆盖的结果。这是 `src/queries/todo-by-turn.ts` 里唯一按来源分支的地方，仍不出现 Agent 名称比较。

**失败可见性。** `TodoByTurn.state` 增加 `failed`，与 `absent`（本轮没有待办）分开。社区包超时、抛错或交回畸形 DTO 时返回 `failed`，页面显示「读取失败」；不写空列表，也不把失败冒充成没有待办。内置轨不受影响：被拒的包不进折叠入口，`parsersOf` 仍返回四个内置 Parser。

**装配与关闭。** 清单加载与 Worker 在 `startCollector` 里装配（`main.ts` 只做 wiring），`CollectorOptions.communityPlugins` 可注入目录或 `false` 整路关闭，单测不读真实数据目录。`stop()` 里先停 HTTP 再终止 Worker，在飞的折叠不会写回已关闭的页面。

## Alternatives considered

**把社区包作为第二条 `id:'todo'` 的登记项追加进 `PLUGIN_REGISTRY`。** 落选。`parsersOf` 用 `find` 只取第一个同 id 项，社区项永远不会被命中；改成 `filter` 虽然可行，但 Parser 是同步 `parse`，而社区包必须异步跨线程，两者共用同一个数组会把同步折叠路径拖成异步。因此社区轨单独一条 `CommunityTodoSource` 入口，按 agent 认领。

**让清单里的包自己声明 agent（import 后读导出）。** 落选。那要求主线程先执行外部代码才能知道它认领谁，等于把隔离推迟到已经执行之后。

**给社区包一个 SDK 类型包，让包直接 import 核心类型。** 首版不做。包只导出 `parsers`，形状靠约定与 `validateTodoSnapshot` 校验；真做类型包要解决外部路径的解析与版本对齐，首版没有收益。

## Consequences

代价是社区包与内置 Parser 走两条折叠路径，DTO 校验必须两处都生效；`failed` 是新的状态值，前端、读取校验与契约测试都要认它。收益是外部代码的错误止步于一个线程与一个页签，内置轨与其余四栏不受影响；被拒的包连 import 都不发生。

未覆盖：Worker 崩溃后的自动重启（同一包失败后本进程内不再重试）、社区包的安装/卸载 UI（首版靠改 `plugins.json` 与重启）、签名与回滚。安装入口写明外部代码拥有宿主权限，只装可信代码。与内置轨接缝的关系见[Plugin 登记层、第五页签与 todoByTurn 接缝](2026-11-05-plugin-registry-and-todo-tab.md)。
