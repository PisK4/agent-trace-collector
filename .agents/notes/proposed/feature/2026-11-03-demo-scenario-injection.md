# Agent Note: 宣传片场景注入与完整阅读

Status: proposed

## Problem

宣传片拍摄需要控制会话列表、Trace 对话、工具 Pair 和失败情节。同一份素材还要重复使用。目前合成服务已经加载生产页面，但数据写在 TypeScript 内；增加或调整素材需要修改服务器源码。会话归属、汇总和上下文目录又分散登记，外部只塞入请求数组不能保证各页一致。

真实 CLI 的工具选择、语言、请求数量和失败状态不可控。为补镜头反复运行既费时，也无法复现相同画面。本需求是让拍摄方提供完整场景，产品页面可以实际点击、导航和读取这些数据。

## Proposal

在现有合成服务增加一个版本化 JSON 注入入口。一次提交多个会话，校验并生成完整只读快照后，一次替换当前场景。所有 GET 继续使用生产接口形状，静态文件继续加载生产 `web/`。首版数据保存在内存，场景 JSON 文件负责保存和重用素材。

实现基于 [Demo 复用生产页面](../../implemented/process/2026-10-24-demo-reuses-production-page.md) 和 [宣传片友好的合成明星会话](../../implemented/feature/2026-11-02-promo-friendly-prototype.md)。本提案只部分替代后者的固定池归属、目录和读取版本机制；两篇既有记录保持活跃，实施时更新对应事实并双向链接。既有五个内置场景及其叙事数字继续作为默认素材，不重新设计它们。

### 范围与约束

- 覆盖多会话列表、Trace、请求正文分页、工具 Pair、主代理与子代理、辅助请求、轮次、会话汇总、上下文目录和路由尝试链。
- 可以控制标题、正文、工具顺序、成功与失败状态、用量及时间。不从真实库导入素材，也不伪造真实采集证据。
- 保持 `127.0.0.1` 监听。默认端口 8770；测试和隔离拍摄可用 `ATC_DEMO_PORT` 指定临时端口。不得读取生产配置、令牌或数据库，不启动 collector。
- 不增加依赖，不修改生产 `src/` 或 `web/`。若发现必须修改消费端的独立缺陷，先报告具体反例，不混入本次实现。
- 完整替换，不提供追加、PATCH、任意 SQL、浏览器自动化服务或实时订阅。注入完成后重新打开返回 URL，明确清空浏览器内存中的旧读取状态。
- 实现走 `../../.codex-worktrees/atc-demo-scenario` 的 `feat/demo-scenario-injection` 分支。没有本轮明确的 git 提交授权，代码保留为 worktree 中可审阅的未提交改动，不 commit、merge 或 push。

### 场景输入

外部输入采用现有 [SynthRequest](../../../../prototypes/synthetic-types.ts) 的内容与状态字段，只替换隐式拼消息所用的 `history` 和 `inputs`。外部消息完整给出，避免自动混入内置场景的中文前缀。

```ts
import type { SynthMessage, SynthRequest } from './synthetic-types';
import type { TurnPairRow } from '../src/queries/turns';

export type DemoRequest = Omit<SynthRequest, 'history' | 'inputs'> & {
  started_ms: number;
  actor: string;
  messages: SynthMessage[];
  input_ordinals: number[];
  skills?: { name: string; description: string }[];
};

export type DemoSession = {
  key: string;
  title: string;
  agent: 'claude' | 'omp' | 'codex';
  main_actor: string;
  requests: DemoRequest[];
  turns: TurnPairRow[];
};

export type DemoScenario = { format: 1; sessions: DemoSession[] };
```

`DemoRequest` 中的 `id`、`title`、`protocol`、`reply`、`toolCalls`、`usage`、`timing`、正文状态、增量与主旁链字段继续使用现有类型。请求 `agent` 可覆盖会话默认值；`actor` 表示会话内代理身份，`main_actor` 明确指定主代理。模型字段首版沿用合成服务默认值，不增加独立模型编排能力。

`messages` 是正文消息数组；`input_ordinals` 标明其中哪些 user 消息属于用户主动文本。`delta` 继续表示本笔新增消息的序号。调用参数放在回复的 `tool_use` 或 `tool_calls` 块内，`toolCalls` 提供结果关联，不重复放另一份参数。

`system`、`tools` 与 `skills` 均来自当前请求。未提供时返回空值或空清单，不借用其他场景的说明。上下文 `promptPlan` 可显式给出八类权重；提供时每项有限、非负、类别唯一、总和为 1，未列类别份额为 0。总 token 由用量字段计算，类别分配处理取整余差，合计必须闭合。类别名称与生产能力范围保持一致，`harness` 目录仍返回既有 unsupported 语义。

### 顺序与引用

会话列表按最近请求时间降序、同时间按会话 key 降序。请求按 `(started_ms, id)` 升序，两种分页方向遵守同一比较规则；改变时间即可控制排列，不依赖 ID 所处区间或注入数组碰巧有序。相同消息内的文本与工具块按原数组顺序保留。

请求 ID 在整个包内唯一，代理身份在会话内解释。前驱从同会话、同 actor 的先前参与请求生成；辅助请求不承接主链。`first` 与 `aux` 不产生前驱。工具结果只关联同会话、同 actor 的调用；Agent 工具本身可以在主代理链上，其执行内容由子代理请求独立表达。

轮次由 `turns` 显式声明，从 1 连续编号。起点与终点必须位于主代理参与链，起点不晚于终点，`ordinals` 必须定位起点中的主动用户消息。默认窗口和轮次下界按请求实际顺序解释，不能用 ID 大小代替时间关系。`?turn=`、`?trace=`、`?summary=` 和 `?expand=summary` 复用生产页面已有入口。

工具调用的 `ord`、`call_id` 和名称必须能在调用笔回复中找到。resolved 调用要求 `result_req`、`result_ord` 与 `result_path` 三者有效，结果位置的 `tool_use_id` 或 `tool_call_id` 与调用相等；pending、ambiguous、unpaired 可以没有结果，不冒充已配对。HTTP 请求失败由 `status` 表达，工具失败由结果 `is_error` 表达，不互相替代。

### 注入协议与原子替换

```http
POST /__demo/scenario
Authorization: Bearer <ATC_DEMO_WRITE_TOKEN>
Content-Type: application/json
```

只有设置了非空 `ATC_DEMO_WRITE_TOKEN` 才启用写入口，未设置返回 404。该值只在 Demo 进程内使用，不落盘、不出现在页面或日志，不复用生产令牌。Host 必须为本机当前端口；有 Origin 时必须与 Host 同源，拒绝跨域，不增加 CORS。命令行可以没有 Origin，但必须通过 Bearer 鉴权；生产 GET 的同源限制保持原样。

请求先按流累计字节再解析，预算为 8 MiB。包最多 20 个会话、合计 500 笔请求，单请求消息最多 1000 条；这些是拍摄素材预算，不是生产限制。超过字节预算返回 413，其余形状和引用错误返回 400。校验覆盖数值有限性、非负用量和时长、安全整数 ID、字段类型与枚举、非空身份、重复身份、消息序号、工具引用、轮次引用和上述总量预算。未知 format 返回 400。JSON 解析失败不暴露正文。

仅完成全部校验并建立索引、前驱、汇总与目录后才替换当前快照。错误响应形如 `{error:'invalid_scenario', path:'sessions[0].requests[1].toolCalls[0]', reason:'result_not_found'}`。失败不改变当前任何读取结果。HTTP handler 在等待请求体后，校验、构建和发布之间不再 await，单次 GET 只读取一个快照。

成功响应形状为 `{format:1, revision, sessions:[{key, request_ids, url}]}`，其中 `request_ids` 按实际展示顺序返回，URL 包含 `session` 与 `demo=1`。revision 是内容摘要，不使用随机数或当前时间。再次提交完全相同内容保持确定性。相同 ID 的正文、调用关联、身份、轮次或上下文变化都使受影响读取版本变化；首版可让整个场景版本参与每笔 reading token，正确性优先于更细粒度缓存。

不新增 reset 入口。重新启动恢复内置五场景，或再次注入保存的 JSON；重拍不用重跑模型。

### 数据一致性与现有模块

引入一个场景构建模块，集中校验外部输入和构建场景索引；HTTP 与响应生成继续留在合成服务，不另造通用 adapter 层。按快照保存会话、请求、请求归属、时间、代理、轮次与汇总。现有五场景用同一归属登记机制接线，固定叙事样本允许保留原汇总，外部场景汇总必须由请求和调用生成。

汇总的主旁链、子代理、工具、路径、Skill、错误和用量采用生产 [SessionSummary](../../../../src/queries/session-summary.ts) 含义。特别注意会话 cache_hit 按生产字段注释的公式计算，不从明星场景的手写数字反推规则。工具分布与 summary entries 使用相同调用索引，文件目录来自当前场景可定位的读取调用，results 来自当前场景的反向配对。

上下文明细只返回能定位的内容；不从内置 `PART_ITEMS` 猜文件或工具名称。tools 只列当前请求声明，chat 对应消息数组，system 对应请求字段，files/results 对应真实存在的调用或结果；memory 没有明确可定位证据时给空集，skills 只列显式提供的技能。不要借用 `STAR.fileFirstCall` 或 `starTurns()` 来解释外部请求。

读取版本仍遵守 `r1-` 加 64 位十六进制的既有格式。正文、工具结果和目录端点检查 token；换版后的旧 token 返回 409，批端点逐项返回 reading_changed，不把整批失败写成空成功。列表与详情的会话、actor、时间、标题和用量必须一致。

## 实施任务

本节是给同一个实施 subagent 的顺序交接。实现可以按现有代码作局部命名调整，但不得省略可观察行为；不为任务拆分引入额外模块。

### 任务 1：场景输入与构建

涉及新建 `prototypes/demo-scenario.ts`、修改 `prototypes/synthetic-types.ts`、新建 `tests/demo-scenario.test.ts`。

对外导出 `parseDemoScenario(value: unknown): DemoScenario` 与 `buildDemoSnapshot(scenario: DemoScenario)`。前者返回完整校验后的输入或带 path/reason 的错误，后者生成当前包全部读取所需索引，不能启动服务或访问文件。已有类型上增加可选的显式消息、时间、代理与技能字段，或在新类型中承载这些字段；不改变既有生成器默认行为。

- [ ] 先写并运行行为测试：乱序请求得到时间正序；重复 ID、悬空结果与非法消息序号被拒绝；错误可定位；相同包产生相同 revision。
- [ ] 实现输入校验、身份与顺序索引、同 actor 前驱，以及全量版本摘要。
- [ ] 补齐主动用户消息、轮次和 resolved 调用正文的交叉校验。
- [ ] 运行 `bun test tests/demo-scenario.test.ts`，只报告实际结果。

测试必须覆盖同 ID 换内容，例如在包含 101 与 102 两笔的合成包上修改 101 的 reply，断言 revision 及读取版本变化；不只断言哈希函数自身。

### 任务 2：现有 GET 读取接入

涉及 `prototypes/synthetic-server.ts`、`prototypes/demo-scenario.ts` 与 `tests/demo-scenario.test.ts`。

将所有读取改为消费一次捕获的当前快照。保留现有响应构建函数，消除外部场景的 ID 分段、固定主 actor、固定中文 BRIEF、默认技能和明星目录依赖。两向分页用完整时间与 ID 比较；轮次下界使用快照中的请求位置。

- [ ] 写能观察串场的测试：两个会话使用相近 ID，一个主代理加一个子代理，详情和前驱均属于正确会话与 actor。
- [ ] 接入列表、详情、正文分页、轮次和反向工具结果；保证输入数组消息顺序不变。
- [ ] 从当前请求构建汇总、entries、上下文目录和类别份额，修正外部数据的取整闭合。
- [ ] 复测内置五场景与明星叙事数字；运行 `bun test tests/demo-scenario.test.ts tests/star-session.test.ts tests/url-route.test.ts`。

### 任务 3：写入口与可复用英文素材

涉及 `prototypes/synthetic-server.ts`、新建 `prototypes/scenarios/promo-en.json`、新建 `tests/demo-scenario-http.test.ts`。

可以导出不启动监听的 handler/server factory 供 HTTP 测试使用，生产入口只在 `import.meta.main` 时监听。测试起临时端口，不占用常驻 8770 或生产 8320。端口与凭据由入口装配，测试直接传配置，不修改用户环境文件。

- [ ] 写集成测试，观察未启用 404、无效凭据 401、跨域 403、错误 JSON 400、超限 413，以及失败后原场景保留。
- [ ] 实现有界请求体读取、独立 Bearer 鉴权与一次快照发布；成功返回各会话顺序和 URL。
- [ ] 提供可直接注入的纯合成英文 JSON，至少两个会话，覆盖 Read/Bash/Edit/Write/Agent、主代理与子代理、标题辅助请求、一次工具失败、一次 HTTP 失败与恢复、可读 Pair、可定位轮次和上下文目录。
- [ ] 从 HTTP 注入该素材，逐个读取 sessions、requests、readings、body、turns、summary、summary entries、tool result、context-item、route，断言返回身份与内容相符。
- [ ] 用旧 token 读取换版场景，断言单项和批量端点分别给出 409 与逐项 reading_changed；运行 `bun test tests/demo-scenario-http.test.ts`。

### 任务 4：使用文档与交付

涉及 `prototypes/README.md`、本提案、上述两篇 implemented 记录的事实同步，以及必要的 `docs/acceptance.md` 合成验收条目。

- [ ] 在 Demo README 写精确的启动与 curl 命令，注明本地生成并通过环境传递独立写凭据、保存 JSON 和重开返回 URL；不得在文档里放真实令牌。
- [ ] 在同一份生产页面检查注入后的会话列表、Trace 顺序、Pair 参数和结果、主子代理、轮次与上下文目录。只起当前 worktree 的合成服务。若浏览器验证无法执行，明确记录缺口。
- [ ] 运行 `bun run typecheck` 与 `bun run verify:notes`；已经通过且后续未改动的测试不重复，不跑全量套件。
- [ ] worktree 实现完成后把该 note 移到 implemented，改写为 Decision/Consequences 和实际验证结果，协议与操作说明归 Demo README，避免保留一份过时计划。主检出的 proposed 文件可保留到分支交付被合入为止。
- [ ] 报告 worktree、修改文件、实际执行的测试及浏览器验收、未覆盖事项；给出按仓库归类的英文 commit message。不要自行提交、合并、重启生产服务。

## Alternatives considered

**继续修改明星会话 TypeScript。** 最省入口代码，但素材作者必须理解服务器的多个索引，无法独立调整列表和叙事。本次需要的是外部可调用入口，固定素材文件继续用于默认演示。

**只提供启动时 `--scenario file.json`。** 没有写路由，成本更低；服务运行期间每次换素材都要重启。拍摄 Agent 需要直接提交场景，因此首版选择一个 POST，不再额外做文件加载命令。JSON 可以原样保存并用 curl 重放。

**独立 SQLite 种子库。** 能复用生产查询，但要写正文分块、派生与路由表，放大与存储 schema 的耦合。既有合成读取已经工作，本次没有验证真实存储的目标。

**逐条写请求或提供通用 mock URL 表。** 容易在半份数据期间暴露悬空工具结果，或让每个接口返回不一致的数据。选择校验整个场景后一次替换，HTTP 返回仍由具名读取操作生成。

**直接向生产采集入口灌模拟记录。** 会混入真实会话、用量和派生状态，还需要区分来源与清理数据。本次只服务镜头与交互，隔离内存场景更直接。

## Acceptance criteria

1. 外部脚本只需启动一次 Demo 并 POST JSON，即可得到多个可点击会话；成功响应提供每个会话的稳定拍摄 URL。
2. 会话和请求排列由时间与稳定身份决定；乱序输入、相同时间、跨分页和同 ID 换版均有测试。消息与工具块的数组顺序保留。
3. Trace 中主动输入、助手回复与工具循环完整；Pair 参数、结果、失败标记和跳转定位同属当前场景。
4. 主链、旁路、主代理、子代理和轮次可显式表达；跨会话、跨 actor 工具串配和无效轮次被拒绝。
5. 汇总、工具明细、路径、上下文类别和目录与正文一致；未提供内容不从内置场景借用。
6. 非法输入或超限不会改变当前场景；写入口默认关闭，只接受有独立凭据的回环请求。
7. 换版后旧 reading token 在正文、工具结果、上下文与批量读取中失效，重新打开返回 URL 可读到新场景。
8. 五个内置场景仍可用；现有明星数字测试、最窄新增测试、类型检查和 notes 闸门通过，实际浏览器检查单独记录。
9. 不访问生产数据目录，不修改用户配置，不启动或重启生产采集器，不提交真实请求正文、账号或令牌。

## Risks

静态类型不能替代 JSON 校验。输入中的 `unknown` 正文、回复和工具参数仍需验证消费者必需的结构；否则注入成功后可能在 Pair 或能力列表中崩溃。

现有合成读取有固定场景捷径。只修列表会掩盖详情、技能、类别和目录仍引用旧场景的问题，需要用两个会话及同 ID 换内容做端到端反例。

全场景摘要使无关请求也换 token，代价是替换后必须重新打开页面。这符合拍摄工作流，首版不实现页面在线迁移或增量热更新。

合成样本展示产品行为，不证明真实采集、OTLP、派生或持久化验收。真实素材筛选导出、OTLP 修复、CLI 自动驾驶与生产故障注入留在各自任务。
