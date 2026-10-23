# 单一轨迹生产阅读 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行环境没有上述技能时，逐任务完成相同的测试与复核，不虚构技能调用。本文件是实施计划；本次文档调整轮只修改计划与决策记录，不执行任务。执行会话取得授权后从 Task 0 开始：Task 0 只改原型并完成阅读验证，Task 1–8 才改生产代码。文中的 commit 步骤是建议提交边界，执行会话取得提交授权后才运行；不得包含当前工作区中属于其它任务的改动。

**Goal:** 先修复原型中会误导阅读的状态，用同一合成场景完成三项阅读任务验证；通过后才把已评审的紧凑单行轨迹、按需详情和右栏请求上下文迁入生产阅读界面，支持最近请求窗口与顶部历史分页，并保证新增消息和工具结果来自可验证的读取版本。

**Architecture:** 保留请求作为身份与计量实体，前端把服务端确认的新增消息和实际回复块投影为步骤。复用现有输入解释、能力视图、正文分页及用量/路由展示，补充请求分页方向、派生来源选择、条件正文读取和按调用位置读取工具结果。原型验证只确定信息层次和状态语义，不成为生产依赖；生产步骤投影沿用这些语义，但不复制原型的静态数据、全局结果查找和独立服务。生产继续使用原生 JavaScript 与现有单进程服务；不增加步骤表、schema 版本、采集来源或第三方依赖。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`、`node:crypto`、原生 JavaScript ES Modules、原生 CSS、Bun Test。

**Spec:** [生产阅读提案](../../../.agents/notes/proposed/architecture/2026-10-23-single-timeline-production-reader.md)、[原型交互与验证范围](../../../prototypes/README.md)、[原型右栏与编号决定](../../../.agents/notes/implemented/feature/2026-10-23-prototype-request-context-rail.md)、[现行查询与状态设计](../../architecture-design.md#查询接口)、[服务端输入解释](../../architecture-design.md#输入解释与能力阅读)。生产切换完成后提案移入 implemented，所有入站链接随迁移更新。

## Global Constraints

- TypeScript + Bun 单进程；不引第三方依赖，SQLite 用 `bun:sqlite`，压缩用 `node:zlib`。
- 监听地址写死 `127.0.0.1`，不读环境变量覆盖；数据目录在仓库外，文件权限 0600、目录 0700。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。
- 正文与路由内容在页面一律转义，不直接插 HTML。
- 每个行为变更只跑能对该回归失败的最窄测试；全量套件与平台矩阵留给显式动作。
- 非平凡变更必须在同一提交里带至少一篇 Agent Note。
- 每篇新 note 先做 supersession check；implemented 决策不能原地反转，archived 冻结不编辑。
- 已确认的 36px 单行、默认折叠、按请求编号和计量、原生 JavaScript、无新步骤表或依赖、右栏能力→结构→完整回复顺序，Task 0 与生产任务都不得反转。原型验证只调整信息层次和状态表达。
- Task 0 只改 `prototypes/` 的原型代码与说明；Task 1–8 不改原型读取逻辑，只把 Task 0 验证过的语义迁入生产。原型不成为生产依赖或数据源。
- 架构与存储形状以 [architecture-design.md](../../architecture-design.md) 为准，运维步骤以 [operations.md](../../operations.md) 为准。本文拥有本轮执行步骤，原型说明拥有原型验证范围。
- 本轮不改 schema、采集、派生算法、正文保留策略、运行配置或 magpie；不启用切片模式，不操作真实库，不启动额外 collector，不部署、不 push。
- Task 0 只用合成场景，不读取本机库、不启动 collector、不复制真实会话数据。执行前核对 `prototypes/` 工作区状态；不得把本机服务、真实会话参数或合成 fallback 搬进 `web/` 与 `src/`。

---

## 1. 架构评估与实施决定

评估基准为 `2f25e47`（合并提交 `94623ff` 内容相同）；原型文件在其后未变，执行时以符号定位，不把行号当契约。已运行 `bun test tests/web.test.ts tests/body-view.test.ts`：38 pass、0 fail、140 assertions，只覆盖 `web/body-view.js` 与生产渲染，不覆盖 `prototypes/local-data.js` 或内联原型脚本。合成浏览器操作确认主会话 19 行、每行 36px、400px 无横向溢出、工具原位展开与右栏选择可操作；截图在 `Page.captureScreenshot` 超时，没有 DeepSeek 原图对照。以上结果不覆盖 1.1 列出的原型缺陷、默认选中可见性和三项阅读任务。详细边界见[原型说明](../../../prototypes/README.md#验证范围)。

| 需求 | 现有依据 | 差距与决定 |
| --- | --- | --- |
| 单行用户/助手/工具步骤 | `web/body-view.js:192` 的 messageBlocks、`:241` 的 messageEntries、`:274` 的 deltaOrdinals | 新增纯步骤投影；复用解释，不按角色或内容集合猜新增 |
| 多条新增共享请求数字 | `web/app.js:280` 的 ordinalOf | 数字是已载入请求的正序位置 +1；加载更早记录后可重新编号，内部身份不用数字 |
| 最近窗口和顶部加载 | `src/queries.ts:412` 目前是 ASC 与 `>`；`src/schema.sql:184` 已有会话时间索引 | 原接口增加 `direction=older`，DESC 查询后反转返回；保留默认 forward 行为 |
| 右栏能力、结构、完整回复 | `web/app.js:940` 已有主体区块，`web/body-view.js:624` 提供能力渲染 | 提取可复用的区块组合供右栏和原位请求详情使用，结构首次展开才读 |
| 定点读取增量和结果 | `src/protocols.ts:235` 支持任意不超过40的区间，from=to=0可取元信息 | 将稀疏页缓存与历史连续阅读游标分开；补请求版本校验 |
| 一个工具结果精确到内容块 | 详情已有 result_req/result_ord/result_path；`web/body-view.js:348` 的 ToolEntry 丢弃 path | 按调用所属 req_id+ord 发起服务端结果读取；删除只凭目标 req+消息ord的按钮定位 |
| dirty、retained、legacy | `src/queries.ts:266`、`:339`、`:496` 屏蔽旧关系 | 所有步骤消费该投影；unknown/branch不伪造新增，失败与缺正文保留记录 |
| 发布代读取 | `src/schema-v6.sql:169` 的视图存在，HTTP仍读request/tool_call旧列 | 先修查询接线：会话标题、列表、详情、工具统一整套选来源，不启用切片计算 |
| 缓存时效 | `web/app.js:313` 的详情永久Map缓存，`:356` 的正文按req单一inflight | token与区间参与缓存键，选择/刷新重新验证；409整笔作废，异步结果受会话与读取代次守卫 |
| 布局和交互 | `web/index.html:108` 三列固定，`web/app.js:594` 两种视图 | 迁移折叠、复制、调宽和单一轨迹；保留生产主题和原有事实视图 |
| 原型阅读验证 | 1.1 的四类状态混用、结果入口与默认选中 | 先修原型并完成三项阅读任务；未通过不启动 Task 1，不把缺陷推给生产读取层 |

当前架构足够支持本轮生产功能。需要修改查询和阅读接口，工作量超过纯 CSS 调整；不需要改变数据库数据模型。原型只证明了版式和单一样本的几何可用性，没有证明读者能快速抓住重点与连贯性，也没有证明生产读取成本、最新窗口分页和异步状态完整性。生产迁移以 Task 0 的阅读验证为门槛。

### 1.1 原型缺陷与生产继承

以下缺陷属于当前原型，生产任务不得原样继承；修复与阅读验证在 Task 0，生产语义分别落在 Task 5 和 Task 7。行号按 `2f25e47` 定位。

| 原型位置 | 现状 | 生产继承约束 |
| --- | --- | --- |
| `trace-reader-prototype.html:1290`、`:1311`、`:1325`、`:2057` | 普通工具行只查已缓存结果；已 `resolved` 但正文未加载时显示「结果未记录」「未记录」，关联状态与正文加载状态混用。 | 关联状态（resolved/pending/ambiguous/unpaired/unavailable）与正文加载状态（未读取/读取中/已读/失败）分开；打开结果才按需读取；失败保留原因并可重试；未读取不写成未记录。 |
| `trace-reader-prototype.html:1293`、`:1294` | 先构造请求状态行，随后用 `localSteps` 整体替换；HTTP 失败且已有用户输入时没有失败记录。 | 步骤投影独立保留请求状态记录；失败、缺正文、未知关系在已有步骤时仍可见，不依赖 `!steps.length`、颜色或摘要截断。 |
| `prototypes/local-data.js:59` | 仅按 HTTP 状态生成 `success/failed`；HTTP 200 且 Chat `finish_reason=length` 仍显示完成。 | HTTP 成功与回复完整性分开；复用 `replyView.finish`（Anthropic `stop_reason`、Chat `finish_reason`），只把已确认的长度上限映射为截断；未知停止原因保留原值，不判失败。 |
| `trace-reader-prototype.html:1331` | Schema 只读 `owner.request.tools`；本机请求的 `request` 恒为 null，Schema 始终显示未携带。 | 复用 `page.capabilities.tools`；区分「工具未声明」「能力不可读/不完整」「同名多定义」；同名不任选第一项。 |
| `trace-reader-prototype.html:626`、`:1305` | `.compact-metrics` 固定 215px，非末行渲染同宽空占位；摘要被压缩。 | 工具行先给动作对象和明确结果状态，不把输出开头当结论；异常状态独立可见；正文与计时宽度在原型实测，不预设新固定值；首字/时长/速度仍按请求只显示一次。 |
| `trace-reader-prototype.html:1199`、`:1329` | 工具结果按全局 `call_id` 查找，确定结果入口在结果标签深处；未知、窗口外、不同 actor、辅助请求与分支没有统一标识。 | 只在关系已确认时把「结果见请求 N」前移到工具行；身份用稳定 `req_id`，显示编号只表示当前窗口；窗口外跳转只读目标请求，不扫描全部历史；不按时间邻近猜因果，不把后续成功写成重试成功。 |
| `trace-reader-prototype.html:1419`、`:1938`、`:1947` | 1507×838 下默认选中最新请求，`main` 停在顶部；实测 main 底边 838，选中组顶边 842.5，选中组完全不可见。 | 生产默认选最新后必须让选中请求进入可见区域；URL 明确指定 `trace` 时保留该请求语义，窗口外时读详情并在右栏说明未在窗口，不静默改选最新。该几何问题在原型既有版本已存在，评审不把它归为本提交引入的回归。 |

`prototypes/serve-local.ts` 直接查 request 窗口，只适合评审；生产必须通过统一的安全投影读取。`prototypes/local-data.js` 的多次 GET 没有同一数据库快照，`renderResponse` 通过目标 req+ord 反查调用会混淆同消息内多个结果，用户输入还仅接收 text、遗漏 unrecognized。生产必须消除这些限制；Task 0 只修工具行与工具详情的按调用者读取，不把原型反查路径带进生产。

原型本机路由页显示 detail JSON，生产沿用 `/api/requests/:id/route` 的白名单路由视图。原型合成分支按内容集合算新增、全局按 call_id 找结果、演示费用/上下文比例均不得进入生产。`BodyPage.coverage.loaded_complete`不能据此推断稀疏缓存已经保存全部历史，连续结构阅读单独计算已读范围。

### 1.2 读取边界

每笔请求可以保证单次GET内原子读取，并在下一次正文或结果读取时拒绝过期版本。多个HTTP响应不会形成一个永久冻结的全会话快照，keyset也不保证迟到记录插入已翻过区间后自动出现。页面提供显式刷新；刷新重新建立最近窗口并清掉旧的确定步骤。初版不增加SSE、后台轮询、全会话排名、前端框架或列表虚拟化。

初始请求数取 `Math.min(100, Math.max(30, Math.ceil(viewportHeight / 34)))`，每次向前加载同样数量，DOM按需增长。每笔最多自动读取两片可信delta（每片跨度最多40）；其余显示该请求内的继续读取入口，不能把80条以内已读片段称为完整增量。每个请求的完整回复随元信息读取，可能很大；40条只是消息区间上限，不是总字节或解码时间上限。system能力扫描和骨架解压沿用现行实现，成本在验收中测量，不在本轮预设新的截断或保留政策。

### 1.3 页面规则

- 每个用户消息、非空助手text块、工具调用各一行。回复块按Anthropic原始content顺序；Chat只对单choice结构化处理。thinking保留在详情，不常驻轨迹；未知块给记录入口。多choice显示限制与原对象，不按冲突ord提供工具结果按钮。
- 辅助请求由purpose_chain/chain_role判定，一笔一条辅助记录，不把分类器输入画成用户消息。分支和子代理保持归属标记，不按时间推断父子因果。
- 所有行初始36px、详情折叠；选中和展开是独立按钮。中栏不常驻模型与时刻。请求最后一个已完整投影的步骤右侧显示一次首字、时长、输出速度；增量仍有未读片时暂不显示这组读数，右栏始终可查。紧凑只约束行高和默认折叠，不代替信息优先级。
- 工具行先显示动作对象（命令、路径、查询或工具名）和明确结果状态，结果正文开头只作补充，不当结论。失败、缺正文、未确认、长度上限等异常用独立可见的短状态表达，不放进省略号摘要，也不只靠颜色或 title。
- 数字只代表载入请求的正序位置，允许两个1、两个2。raw messages的#0/#1仍是协议消息下标，二者在文案中分别称请求序号和消息位置。显示编号只对当前载入窗口有效；内部身份、跳转和缓存键用 req_id。
- 失败、缺正文、解析失败、回复截断与关系未知落在对应请求的独立记录行，不再有中栏整行通用缺正文提示。已有用户输入或回复时仍保留这些记录，不以 `!steps.length` 作为唯一条件。左栏去掉笼统待确认文字，具体状态留在选中请求；失败标记保留。
- 已确认的工具结果在工具行给「结果见请求 N」入口；N 是当前窗口展示号，数据属性保存 req_id。未确认、窗口外、不同 actor、辅助请求和分支分别标识，不按时间邻近猜因果，不把后续成功写成已确认重试。
- 右栏读数页先显示请求能力、请求结构、本次回复，再显示用量、计时、上下文组成、身份完整性。结构与能力默认折叠，回复完整显示，通用说明可折叠。正文、工具、路由入口继续可访问；工具选择有概览/参数/结果/Schema和返回所属请求。Schema 读能力视图，不读可能为 null 的请求对象。

## 2. 文件职责与依赖

| 文件 | 职责和本轮操作 |
| --- | --- |
| `prototypes/trace-reader-prototype.html`、`prototypes/local-data.js` | Task 0 的原型缺陷修复、合成阅读场景和三项阅读任务；不进入生产契约 |
| `prototypes/README.md` | 记录 Task 0 的验证范围与结果；Task 1–8 不再改原型读取逻辑 |
| `src/queries.ts` | 修正整套派生来源选择；扩展older分页；保留安全白名单和默认forward行为 |
| `src/reading.ts`（新） | 无持久状态的读取协调：快照身份、token、条件正文、按调用位置读取结果 |
| `src/http.ts` | 参数校验、409错误、静态模块白名单；沿用Host/Origin/认证 |
| `src/protocols.ts` | 保持BodyPage解释和40条区间语义；本轮由reading外层事务调用，无需改协议解析 |
| `web/reader-store.js`（新） | 把网络、区间缓存、inflight、失效与异步代次从DOM闭包移出，供app消费和Bun测试 |
| `web/trace-view.js`（新） | 无DOM、无网络的步骤投影、工具摘要和单行HTML；复用body-view纯函数 |
| `web/body-view.js` | 保留完整工具位置、调用者按钮身份；复用能力、消息和回复渲染，不引入前端包装规则 |
| `web/app.js` | 会话与请求选择、单一轨迹、顶部分页与锚点、右栏组合、布局事件；删除旧重复加载路径和双视图入口 |
| `web/index.html` | 三栏布局变量、分隔线、折叠按钮、36px轨迹、窄屏CSS和可访问属性 |
| `tests/queries.test.ts`、`tests/http.test.ts` | 已发布读取、分页顺序/索引/非法输入、静态模块与原访问限制 |
| `tests/reading.test.ts`（新） | 合成库上的token、条件正文和精确结果读取 |
| `tests/reader-store.test.ts`（新） | 注入fetch的区间去重、失败重试、409作废、会话切换和网络并发 |
| `tests/trace-view.test.ts`（新） | 增量、回复顺序、稳定键、同请求编号、XSS与计量归属 |
| `tests/body-view.test.ts`、`tests/web.test.ts` | 工具按钮位置和原有生产能力回归；移动测试时保留原行为断言 |
| `docs/architecture-design.md`、`README.md`、`docs/README.md` | 实施后更新实际契约、人工验收和文档入口 |
| `.agents/notes/` | Task 0 后提案仍保持 proposed；生产切换完成后按交付事实迁入 implemented，每个实施提交更新对应任务理由和验证 |

执行顺序：Task 0 → Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8。Task 0 是生产迁移的准入门槛，只改原型并完成阅读验证；Task 1–8 不改原型读取逻辑，只把验证过的语义迁入生产。每项有可独立拒绝或接受的交付，不把空模块或纯脚手架单独提交。生产最终切换在 Task 6；Task 1–5 均可用合成测试验证。

## 3. 接口约定

### 3.1 请求窗口

```ts
export type RequestDirection = 'forward' | 'older';
// direction省略时保持最早页及向后追加；older无cursor取最近页。
export function listRequests(
  store: Store, key: string, limit = 100,
  cursor: string | null = null, direction: RequestDirection = 'forward',
): Page<RequestRow>;
```

HTTP：`GET /api/sessions/:key/requests?direction=older&limit=30&cursor=<opaque>`。返回items始终按 `(started_ms,req_id)` 升序。older的next_cursor编码本页最早行，下一页严格 `<`；forward继续编码末行，下一页严格 `>`。新older游标编码 `["older",key,started_ms,req_id]` 并校验会话及方向，禁止把forward游标混用。默认forward旧二元游标保持原语义。未知direction返回400 `invalid_direction`，不能静默忽略。

### 3.2 阅读版本

```ts
export type ReadingDetail = RequestDetail & { reading_token: string };
export type ReadingBody = BodyPage & { req_id: number; reading_token: string };
export class ReadingConflictError extends Error {}
export function getReadingDetail(store: Store, id: number): ReadingDetail | null;
export function getReadingBody(
  store: Store, id: number, from: number, to: number,
  expected: string | null,
): ReadingBody | null;
```

现有detail响应加reading_token。body接受可选 `if_reading=<token>`，生产新前端始终发送，旧调用不传仍可读但没有跨GET校验。服务端在同一只读事务内解析alias、生成当前token、比较expected、读取正文。冲突409 `reading_changed`，不存在404；空token或格式不符400 `invalid_reading_token`。格式固定 `r1-` 加64位小写十六进制。token仅是读取身份，不是认证凭证，不包含正文。

token哈希规范数组，绑定canonical req_id、请求input_epoch/input_revision、conv_key/actor/actor_state、purpose_pending/purpose_revision/purpose_target/purpose_version、body_state/parse_state/reply_state/adapter_version、组group_epoch/input_revision/published_revision/state/target_algorithm/published_algorithm/published_generation/legacy_snapshot、实际派生来源的算法与retention状态。组不存在用固定null槽位，不省略数组位置。同步来源额外绑定summary_state/summary_algorithm/summary_basis；代际来源绑定该请求结果行的input_epoch/input_revision/purpose_revision/algorithm/retention_state/basis_json。费用更新不改变token；它只保证轨迹输入和派生位置一致，不冻结用量价格。

### 3.3 工具结果

```ts
export type ToolResultReading = {
  owner_req: number; call_ord: number; reading_token: string;
  state: 'available' | 'pending' | 'ambiguous' | 'unpaired'
    | 'unavailable' | 'invalid_location';
  target: { req_id: number; ord: number; path: string } | null;
  content: unknown;
  is_error: boolean | null;
  reason: string | null;
};
export function getToolResultReading(
  store: Store, ownerId: number, callOrd: number, expected: string,
): ToolResultReading | null;
```

HTTP：`GET /api/requests/:owner/tools/:ord/result?if_reading=<token>`，必须给token。一次只读事务内校验调用方版本、读取当前来源的工具关联、读取目标消息并提取精确块。结果内容随调用者组输入/发布身份失效；返回保留owner身份，不把当前选择偷偷换成结果请求。

只接受 `derivation.chain_state=current` 且resolved；其它状态返回对应状态、content=null。目标正文不可读为unavailable并带原因。路径只允许 `^request\.messages\[(\d+)\](?:\.content\[(\d+)\])?$`，N必须等于result_ord，目标canonical必须仍等于记录的result_req，actor/conv_key与调用方一致。Anthropic的K块必须为tool_result且tool_use_id匹配call_id；Chat必须为role=tool且tool_call_id匹配。非法或不匹配为invalid_location，不跨请求搜索或回退第一块。不使用eval、通用路径执行或按名称猜配。resolved只代表关联，不代表成功；is_error缺失返回null。

### 3.4 原型验证语义

Task 0 不新增生产类型，只把下列五组状态分开，避免用一句「未记录」覆盖不同事实。生产在 Task 5/7 映射到现有 `TraceStep`、`ToolResultReading` 与 `BodyPage`，不把原型字段带进 `src/` 或 `web/`。

| 状态组 | 取值 | 来源 |
| --- | --- | --- |
| HTTP 状态 | 成功 / 失败 / 未知 | `RequestRow.status` |
| 回复完整性 | complete / truncated / unknown / absent | `replyView.finish`；Chat `finish_reason`、Anthropic `stop_reason` |
| 正文状态 | available / partial / pending / evicted / unsupported | `BodyPage.state` |
| 工具关联 | resolved / pending / ambiguous / unpaired / invalid_location | 详情工具关系与 `ToolResultReading.state` |
| 结果正文加载 | not_loaded / loading / loaded / failed | 页面本地状态，不写入服务端 |

`resolved` 只说明关联已确认；结果正文未读取、读取失败、工具执行报错与工具成功是四件事。回复截断属于成功响应内的完整性状态，不把请求行改成失败。

## Task 0: 修复原型阅读缺陷并完成阅读任务验证

**Files:** Modify `prototypes/trace-reader-prototype.html`、`prototypes/local-data.js`、`prototypes/README.md`。不修改 `src/`、`web/`、`tests/` 或生产配置。

**Interfaces:** Consumes 静态合成入口、现有 `createLocalReader`、`replyView` 与 `capabilityView`。Produces 可供 Task 5/7 继承的已验证状态语义；不新增生产类型，不把原型字段、静态样本或本机服务带进生产。验证结果写入[原型说明](../../../prototypes/README.md#验证范围)。

- [ ] **Step 1: 建立唯一的合成阅读场景和状态口径。** 在静态合成数据中构造一个会话，至少包含：一笔 HTTP 失败但保留用户输入与回复的请求；一笔 HTTP 200、Chat `finish_reason=length` 的请求；一笔 Anthropic `stop_reason=max_tokens` 的请求；一笔正常 `stop`/`end_turn` 的请求；一笔未知停止原因的请求；一笔工具调用在后续请求中 `resolved` 且结果正文未读取；一笔关系 `pending` 或 `ambiguous`；一笔结果请求在最近窗口外；一笔辅助请求和一笔分支请求；能力视图分别覆盖 `present`、`empty`（未声明该工具）、`missing`/`partial`（不可读）以及两个同名工具定义。场景只存在于原型或合成 fixture，不读取本机库、不启动 collector、不复制真实会话正文。按 §3.4 固定状态组，任何位置不得把「未读取」写成「未记录」，也不得把 `resolved` 当成工具成功。

- [ ] **Step 2: 分离工具关联与结果正文加载。** 普通工具行、原位展开和右栏工具概览在结果未读取时显示「结果见请求 N · 待读取」或「关系未确认」；打开结果时才调用现有按调用位置读取，显示读取中、正文或固定原因；读取失败保留重试，不把失败改写成未配对。结果查找以发起请求为边界，同一 `call_id` 出现在两个请求时不能串用。

- [ ] **Step 3: 保留独立请求状态记录。** 重新组织 `renderSteps`：先合并用户、助手、工具与状态记录，再渲染；`localSteps` 不能整体覆盖状态行。HTTP 失败、正文缺失、回复缺失、未知增量、样本截断各自产生一条可见记录，即使该请求已有用户输入或回复。状态文本放在不被省略号裁剪的独立元素，颜色只作辅助。

- [ ] **Step 4: 分开 HTTP 成功与回复完整性。** 核对 `replyView` 对两类协议的现有解析，用合成数据确认 Chat `length`、Anthropic `max_tokens` 显示为「回复因长度上限结束」，请求行仍为 HTTP 成功；`stop`/`end_turn`/`stop_sequence`/`tool_calls`/`tool_use` 按正常停止处理；其它停止原因原样显示并标为未知，不归为失败。缺失回复标为未收到，不标成功完成。

- [ ] **Step 5: Schema 改读能力视图。** 工具 Schema 从当前请求的 `page.capabilities.tools` 取定义：`present` 且无同名项时说明未声明；`empty` 说明请求未携带工具；`missing`/`partial`/`unrecognized` 显示能力不可读或不完整及原因；同名多项逐项列出并说明无法唯一选择。不得回退到 `owner.request.tools` 或任选第一项。

- [ ] **Step 6: 让工具行先给动作和结果状态。** 工具行摘要先写动作对象（命令、路径、查询、工具名），再写结果关系或执行状态；结果正文开头只作补充，不当结论。失败、缺正文、未确认、长度上限用独立短状态，不随摘要截断。对 `.compact-metrics` 的 215px 固定宽度和空占位做原型测量：在 1507×838 与 400px 下记录正文、异常状态和计时读数的实际占用；可以试验空占位不占宽或按内容分配，但不在本计划预设新的固定宽度，也不取消每请求一次的计量。

- [ ] **Step 7: 前移确定结果入口并标明关系范围。** 关系为 `resolved` 时，工具行显示「结果见请求 N」，N 是当前窗口展示号，数据属性保存稳定 `req_id`；点击定位承载结果的请求。目标在窗口外时只读取该请求详情并提示未在窗口，不扫描全部历史。`pending`/`ambiguous`/`unpaired`/不同 actor/辅助请求/分支分别标识；后续请求成功不自动写成前一次失败的重试成功。

- [ ] **Step 8: 让初始选中可见。** 复现 1507×838 下默认选中最新请求但选中组落在 `main` 底边之外的情况；初始渲染后把选中组带入可见区域，同时保留回到列表顶部的路径。URL 明确指定 `trace` 时保留该请求；窗口外时读详情并在右栏说明，不静默改选最新。加载更早记录后，选中组不因重新编号而丢失或跳到别处。

- [ ] **Step 9: 执行三项阅读任务并判定门槛。** 用同一合成场景执行：a 找到最后一条已记录回复并说明当前进展；b 找到失败请求并说明后续发生了什么，不把后续成功写成已确认重试；c 从一次工具调用定位对应结果和承载它的请求。每项记录完成时间、点击/展开次数和回答正确性，答案以同一场景的预写答案为对照；修复前后各跑一次，记录差值，不设未经验证的数值阈值，不把时间或点击数的改善写成用户批准。

  硬条件：Step 2–5、7–8 的合成回归通过；三项阅读任务回答正确且没有伪造因果；36px 行高、默认折叠、400px 无横向溢出保持；每请求计量仍只出现一次。宽度试验只记录，不作为硬条件。任一项失败时不启动 Task 1，在 Task 0 内修复并重跑；修复后仍不能完成阅读任务，则停止迁移，把原型证据和可选方向交回用户，不降低验收、不把缺陷推给生产任务。用户可读性确认未取得时记录为待确认，不写成通过。

- [ ] **Step 10: 记录与提交边界。** 在 `prototypes/README.md` 的验证范围写入实际通过的场景、未覆盖项和测量值；不写真实会话正文。建议提交 `fix(prototype): separate reading states and validate the trace`。Task 0 硬条件通过后才允许开始 Task 1；未经授权不 commit。

## Task 1: 让生产查询整套选择派生来源

**Files:** Modify `src/queries.ts:162`、`:287`、`:404`、`:496`；Test `tests/queries.test.ts`。更新本提案的本项理由与实际验证，行为交付后补架构的发布指针读取说明。

**Interfaces:** Consumes现有request、derive_queue、derive_request_result、derive_tool_result以及GROUP_ALGORITHM。Produces保持RequestRow/RequestDetail响应字段不变的listSessions/listRequests/getRequest，调用方不接触SQL来源。不得从查询调用readEffectiveGroup读整个组。

- [ ] **Step 1: 写发布结果与同步旧值刻意不同的查询回归。** 在queries测试使用fixture和seedPurposeRequest；给组插入合法published generation及结果行，queue指向它，把request.title/input_preview与tool_call的结果改成不同值。测试必须直接调用getRequest/listRequests/listSessions，不能只测视图。

```ts
const detail = getRequest(f.store, id)!;
expect(detail.title).toBe('published title');
expect(listRequests(f.store, 'conv-reading').items[0]?.title).toBe('published title');
expect(listSessions(f.store).items.find(s => s.conv_key === 'conv-reading')?.title)
  .toBe('published title');
expect(detail.tool_calls[0]?.result_path).toBe('request.messages[4].content[1]');
// 再把发布代字段写NULL，同步旧列仍保留诱饵值。
f.store.write(db => db.run(
  'UPDATE derive_request_result SET input_preview=NULL WHERE generation=? AND req_id=?',
  [generation, id],
));
expect(getRequest(f.store, id)?.input_preview).toBeNull();
```

在queries测试文件新增下面的局部seed，字段来自现有代际结构；测试开头 `const {id,generation}=seedPublishedReading(f)`。generation固定合成值，算法与队列修订一致。另构造dirty、published指针无结果、legacy和retained，以及普通同步clean组，锁住屏蔽与回退条件。

```ts
function seedPublishedReading(f: ReturnType<typeof fixture>) {
  const id=seedPurposeRequest(f.store, {
    convKey:'conv-reading',actor:'actor-reading',startedMs:100,
    messages:[{role:'user',content:'synthetic question'}],
    purposePending:0,cleanGroup:true,summaryState:'recomputed',summaryAlgorithm:1,
    title:'synchronous bait',titleSource:'user_delta',
  });
  const generation='gen-reader-published-01';
  f.store.write(db=>{
    db.run(`UPDATE request SET purpose_revision=input_revision WHERE req_id=?`,[id]);
    db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,
      input_revision,algorithm,state,stage,created_at,published_at,request_count)
      SELECT ?,conv_key,actor,group_epoch,input_revision,5,'published','done',1,1,1
      FROM derive_queue WHERE conv_key='conv-reading' AND actor='actor-reading'`,
      [generation]);
    db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,
      input_revision,started_ms,prev_relation,delta_ordinals,chain_role,title,
      title_source,input_preview,purpose_revision,purpose_version,purpose_chain,
      algorithm,retention_state,basis_json)
      SELECT ?,req_id,input_epoch,input_revision,started_ms,'first','[0]','main',
      'published title','user_delta','published input',purpose_revision,
      purpose_version,purpose_chain,5,'recomputed','{}' FROM request WHERE req_id=?`,
      [generation,id]);
    db.run(`UPDATE derive_queue SET published_generation=?,state='clean',
      published_revision=input_revision,target_algorithm=5,published_algorithm=5
      WHERE conv_key='conv-reading' AND actor='actor-reading'`,[generation]);
    db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,
      tool_name,result_req,result_ord,result_path,state,algorithm_version,
      retention_state) VALUES (?,?,0,'call-reading','read',?,4,
      'request.messages[4].content[1]','resolved',5,'recomputed')`,
      [generation,id,id]);
    db.run(`INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,
      result_ord,result_path,state) VALUES (?,0,'call-reading','read',?,0,
      'request.messages[0].content[0]','resolved')`,[id,id]);
  });
  return {id,generation};
}
```

该seed只验证查询选源，工具目标内容有效性由Task 3独立构造和验证。

- [ ] **Step 2: 运行红测。** `bun test tests/queries.test.ts`；预期发布标题/路径断言失败，因为现有HTTP查询读同步旧列。fixture若先因SQL约束失败先修fixture，不能当作有效红测。

- [ ] **Step 3: 统一SQL来源选择。** 保留有界request查询和现有projectRow；在同一个SELECT中LEFT JOIN当前队列和指针结果，派生列全部使用相同的整行来源条件。最小SQL形状如下，列清单必须覆盖DERIVED_COLUMNS、reply_preview、summary状态与依据：

```sql
LEFT JOIN derive_queue g ON g.conv_key=r.conv_key AND g.actor=r.actor
LEFT JOIN derive_request_result d
  ON d.generation=g.published_generation AND d.req_id=r.req_id
```

```ts
// 同一个source条件应用于整组派生列，NULL保持NULL。
const source = `CASE WHEN g.published_generation IS NOT NULL THEN 'generation'
  WHEN g.target_algorithm=${GROUP_ALGORITHM}
    OR g.legacy_snapshot=1 THEN 'synchronous' ELSE 'unavailable' END`;
const selectedTitle = `CASE WHEN g.published_generation IS NOT NULL THEN d.title
  WHEN g.target_algorithm=${GROUP_ALGORITHM}
    OR g.legacy_snapshot=1 THEN r.title ELSE NULL END AS title`;
```

published存在时工具只查derive_tool_result指定generation；同步明确可用时查tool_call；无可用来源时不伪造工具配对。将代际retention_state/algorithm/basis_json映射进已有summary状态与依据字段。current额外要求代际请求epoch/revision及用途消费身份匹配当前请求，缺行时dirty；retained保留旧依据但不给确定delta。会话标题候选必须复用同一整套来源及状态条件，不能只改getRequest。将getRequest的alias解析移到其事务内，避免alias与row跨快照。正常同步模式在无published指针、target_algorithm=GROUP_ALGORITHM时继续整体读取同步列，不要求生产切换legacy标记。

- [ ] **Step 4: 运行回归与类型检查。** `bun test tests/queries.test.ts tests/http.test.ts`；预期同步与发布路径均通过，缺行/dirty不升级为current。`bun run typecheck`用于确认SQL类型投影没有遗漏字段。
- [ ] **Step 5: 提交边界。** 建议 `fix(reader): select published derivation results consistently`；同变更更新本提案的验证事实与架构读取节，附约定署名。未经授权保留工作区，不执行commit。

## Task 2: 增加最近窗口与向前分页

**Files:** Modify `src/queries.ts:412`、`src/http.ts:279`；Test `tests/queries.test.ts`、`tests/http.test.ts`。

**Interfaces:** Consumes Task 1的RequestRow安全投影。Produces §3.1的RequestDirection和listRequests新签名；Page字段保持items/next_cursor。

- [ ] **Step 1: 写同毫秒与分页方向测试。** fixture中seedRequest插入id1..7，started_ms都为1000，conv_key为SEED_GROUP.convKey。正文不必创建，验证列表不读块。

```ts
const first = listRequests(f.store, SEED_GROUP.convKey, 3, null, 'older');
expect(first.items.map(r => r.req_id)).toEqual([5, 6, 7]);
const second = listRequests(f.store, SEED_GROUP.convKey, 3, first.next_cursor, 'older');
expect(second.items.map(r => r.req_id)).toEqual([2, 3, 4]);
const last = listRequests(f.store, SEED_GROUP.convKey, 3, second.next_cursor, 'older');
expect(last.items.map(r => r.req_id)).toEqual([1]);
expect(last.next_cursor).toBeNull();
expect(listRequests(f.store, SEED_GROUP.convKey, 3).items.map(r => r.req_id))
  .toEqual([1, 2, 3]);
```

HTTP直接使用createHandler合成配置，增加未知direction、旧forward游标用于older、其它会话older游标、非法limit、无穷值/非安全整数游标的400断言。保留旧forward分页不漏不重测试。

- [ ] **Step 2: 运行红测。** `bun test tests/queries.test.ts tests/http.test.ts`；新增签名或older方向断言失败。
- [ ] **Step 3: 实现方向查询与绑定游标。** older使用现有会话索引，参数化WHERE，不把用户输入拼接SQL；只在固定两个分支间选择比较符及排序。

```sql
-- 此可执行形状用于EXPLAIN断言；生产SELECT保留Task 1完整安全投影及来源连接。
SELECT r.req_id,r.started_ms
FROM request r
WHERE r.conv_key=? AND (r.started_ms,r.req_id)<(?,?)
ORDER BY r.started_ms DESC,r.req_id DESC LIMIT ?
```

无cursor省略二元组条件。先slice(0,size)，用该DESC页末行生成older游标，再reverse返回正序。HTTP只接受forward/older，缺参数为forward。oldercursor的key、direction与安全整数校验全部通过后执行查询。forward现有二元游标的语义保留。

- [ ] **Step 4: 运行绿测和索引核对。** `bun test tests/queries.test.ts tests/http.test.ts`。沿用现有EXPLAIN测试断言会话查询用 `i_req_session_time`，不得新增表、索引或offset分页。
- [ ] **Step 5: 提交边界。** 建议 `feat(reader): add latest request windows and backward pagination`；接口事实写架构查询节，本提案保留理由和验证。

## Task 3: 增加条件正文读取与精确工具结果读取

**Files:** Create `src/reading.ts`、`tests/reading.test.ts`；Modify `src/http.ts:286`、`:300`；Test `tests/body-api.test.ts`、`tests/http.test.ts`。BodyPage类型仍以src/protocols.ts为准，不把reading身份加进所有内部协议函数。

**Interfaces:** Consumes Task 1的getRequest、resolveRequestId，现有getBodyPage及Store。Produces §3.2/3.3全部类型与函数；`src/reading.ts`依赖queries/protocols，queries不反向import reading，避免循环。

- [ ] **Step 1: 写请求更新使旧token失效的测试。** 测试辅助函数在文件顶部完整定义，使用临时fixture，示例为可执行的最小token回归：

```ts
import {expect, test} from 'bun:test';
import {fixture, seedPurposeRequest} from './fixtures';
import {markRequestInputTx} from '../src/derive-state';
import {getReadingDetail, getReadingBody, ReadingConflictError} from '../src/reading';

test('请求输入修订变化拒绝旧阅读版本', () => {
  const f=fixture();
  try {
    const id=seedPurposeRequest(f.store, {
      convKey:'conv-reading', messages:[{role:'user',content:'synthetic question'}],
      cleanGroup:true,purposePending:0,summaryState:'recomputed',summaryAlgorithm:1,
    });
    const detail=getReadingDetail(f.store,id)!;
    expect(detail.reading_token).toMatch(/^r1-[0-9a-f]{64}$/);
    expect(getReadingBody(f.store,id,0,0,detail.reading_token)?.req_id).toBe(id);
    f.store.write(db=>markRequestInputTx(db,id));
    expect(()=>getReadingBody(f.store,id,0,1,detail.reading_token))
      .toThrow(ReadingConflictError);
  } finally {f.close();}
});
```

再分别固定：只改费用token不变；组dirty而本请求revision不变token变；同请求的新published generation使token变；回收和alias合并拒绝旧token；from0/to0有reply和capabilities但messages=[]；from44/to45拿到真实ord44。HTTP验证409/400/404区分与现有Host/Origin保护。

- [ ] **Step 2: 写同消息第二个工具结果测试并运行红测。** seedPurposeRequest创建同conv/actor两个请求，后一个user.content含两个tool_result，id分别call_a/call_b。组设为同步clean、purposePending=0、summaryAlgorithm=1，在tool_call中插入owner ord1/call_b，result_ord=0，path=request.messages[0].content[1]，state=resolved。断言如下：

```ts
function seedTwoToolResults(f: ReturnType<typeof fixture>) {
  const common={convKey:'tool-reading',actor:'actor-tool',purposePending:0,
    cleanGroup:true,summaryState:'recomputed',summaryAlgorithm:1} as const;
  const owner=seedPurposeRequest(f.store,{
    ...common,startedMs:100,messages:[{role:'user',content:'read two files'}],
    reply:{content:[
      {type:'tool_use',id:'call_a',name:'read',input:{path:'a'}},
      {type:'tool_use',id:'call_b',name:'read',input:{path:'b'}},
    ]},
  });
  const target=seedPurposeRequest(f.store,{
    ...common,startedMs:200,messages:[{role:'user',content:[
      {type:'tool_result',tool_use_id:'call_a',content:'first result'},
      {type:'tool_result',tool_use_id:'call_b',content:'second result',is_error:true},
    ]}],
  });
  f.store.write(db=>{
    db.run(`UPDATE request SET purpose_revision=input_revision
      WHERE req_id IN (?,?)`,[owner,target]);
    db.run(`INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,
      result_ord,result_path,state) VALUES (?,1,'call_b','read',?,0,
      'request.messages[0].content[1]','resolved')`,[owner,target]);
  });
  return {owner,target};
}

const {owner}=seedTwoToolResults(f);
const detail=getReadingDetail(f.store,owner)!;
const result=getToolResultReading(f.store,owner,1,detail.reading_token)!;
expect(result.state).toBe('available');
expect(result.content).toBe('second result');
expect(result.is_error).toBe(true);
expect(result.target?.path).toBe('request.messages[0].content[1]');
```

另测Chat、pending、ambiguous、缺path、错误call_id、跨actor、目标evicted、错误N、目标alias。`bun test tests/reading.test.ts`预期缺模块或函数失败，fixture SQL约束应先正确。

- [ ] **Step 3: 实现版本身份与事务包装。** reading局部SQL只挑§3.2的元数据，token构造用固定顺序数组和SHA-256；不读正文生成token，不用updated_at替代修订，不哈希整个回复。结果身份选择与Task 1相同，不另发明第三套来源。实现核心：

```ts
import {createHash} from 'node:crypto';
const tokenOf=(identity: readonly unknown[]) =>
  'r1-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
export class ReadingConflictError extends Error {}
// expected在HTTP校验格式；这里只执行严格相等比较。
const requireReading=(actual: string, expected: string|null) => {
  if(expected!==null && expected!==actual) throw new ReadingConflictError('reading_changed');
};
```

每个公共读取用 `store.read.transaction(() => { ... })()`，alias、身份、比较及数据读都在其中。getRequest使用Bun嵌套transaction保存点，仍处于同一外层只读快照；不得调用显式BEGIN/COMMIT的readEffectiveGroup。token校验成功后才getBodyPage，409响应无正文。

- [ ] **Step 4: 实现工具结果和HTTP接线。** getToolResultReading在同一事务中读取owner detail+identity，校验token后按ord找工具；调用方非current直接pending，resolved按§3.3验证path、角色、ID、归属，再只读一条目标消息。reason使用固定原因，如body_evicted/location_mismatch/multiple_choices，不回传SQL错误或原始路径执行信息。`content`保留协议值，前端再渲染转义。body可选if_reading，tool必需if_reading，HTTP捕获ReadingConflictError→409，其余QueryInputError→400。现有范围限制先校验，避免无效输入触发解压。
- [ ] **Step 5: 运行绿测。** `bun test tests/reading.test.ts tests/body-api.test.ts tests/http.test.ts`及`bun run typecheck`。新增接口经createHandler测试，无需监听端口或读取本机token。
- [ ] **Step 6: 提交边界。** 建议 `feat(reader): guard body reads and resolve tool results by call position`；架构拥有token/HTTP错误与工具位置约定，本提案记录快照取舍。

## Task 4: 建立可独立测试的生产阅读缓存

**Files:** Create `web/reader-store.js`、`tests/reader-store.test.ts`；Modify `src/http.ts:27`静态白名单、`tests/http.test.ts:125`。生产app接入在Task 6，避免半迁移的双数据源。

**Interfaces:** ConsumesTask 2/3接口及原sessions/route接口。Produces下面的单一reader；沿用原createReader的网络注入方式，页面不直接fetch详情/正文。

```ts
type WindowState = {
  sessionKey: string|null; requests: RequestRow[]; olderCursor: string|null;
  loading: boolean; error: string|null;
};
type RequestRead = {
  detail: ReadingDetail; meta: ReadingBody|null;
  messages: Map<number, ReturnType<typeof messageEntries>[number]>;
  structure: {open:boolean; next:number; total:number|null;
    ords:number[]; selected:number|null; loading:boolean; error:string|null};
  delta: {next:number; done:boolean; loading:boolean; error:string|null};
};
export function createReaderStore(fetcher: (url:string)=>Promise<Response>): {
  getWindow():WindowState;
  getSessions():{items:SessionRow[];cursor:string|null;error:string|null};
  loadSessions(cursor?:string):Promise<void>;
  selectSession(key:string,limit?:number):Promise<void>;
  loadEarlier():Promise<void>;
  readRequest(id:number,validate?:boolean):Promise<RequestRead>;
  readRange(id:number,from:number,to:number):Promise<ReadingBody>;
  loadStructure(id:number):Promise<RequestRead>;
  loadDelta(id:number,pages?:number):Promise<RequestRead>;
  readToolResult(id:number,ord:number):Promise<ToolResultReading>;
  readRoute(id:number):Promise<unknown>;
  invalidate(id:number):void;
};
```

类型写进JS JSDoc，RequestRow/ReadingDetail/ReadingBody/ToolResultReading引用真实TS定义。RequestRead导出JSDoc typedef供trace-view与app导入。delta.next是已消费的可信delta序号数量，structure.next是连续历史区间上界；不能共用。

- [ ] **Step 1: 写fetch序列与可控迟到响应测试。** 使用BunTest与Response.json，JSON对象均为合成。为first请求返回reading_token=r1-加64个a，BodyPage补齐capabilities/coverage/interpretations。测试URLs精确区分from/to和if_reading；detail请求迟到后切换会话，旧响应不能更新新window或触发新会话渲染。相同(id,token,from,to)并发只发一次，不同区间不能错误共用一个Promise。

```ts
const store=createReaderStore(fetcher);
await store.selectSession('synthetic-k',30);
await store.readRequest(1);
await Promise.all([store.readRange(1,44,45),store.readRange(1,44,45)]);
expect(urls.filter(u=>u.includes('/body?from=44&to=45')).length).toBe(1);
await store.loadStructure(1);
expect((await store.readRequest(1)).structure.ords).toEqual(
  Array.from({length:40},(_,i)=>i),
);
// 定点读44不会使历史首片误变为已读45条。
expect((await store.readRequest(1)).structure.next).toBe(40);
```

另测结构40+5分页、同页重复ord去重、503游标不动、空页且total未到时报body_page_empty游标不动、409整笔作废、切换后旧inflight不重新塞缓存。清空后重新读取同id必须产生新网络请求。工具结果另测：未发起读取时没有结果缓存，已 `resolved` 不自动等于已读；同一owner两个call ord分别缓存；读取失败保留失败状态，重试成功后才替换；旧token的迟到结果不能写入当前请求。

- [ ] **Step 2: 运行红测。** `bun test tests/reader-store.test.ts`；模块/接口缺失为红，具体行为测试随后逐项绿。
- [ ] **Step 3: 实现缓存与有限并发。** request缓存以canonical req_id归属、token标识版本。page/inflight键为 `[id,token,from,to]` 的JSON；results键为 `[owner,token,ord]`。共享一个固定4并发的网络队列，失败finally释放；结构与delta有独立loading守卫。换会话递增epoch并释放旧正文Map，晚到响应必须同时匹配epoch与当前请求token才可写入。只缓存已加载窗口和显式选中的一个窗口外请求，窗口外目标结果只存该调用结果，不装载目标整份历史。

```js
const key=JSON.stringify([id,token,from,to]);
const merge=(entries, incoming) => {
  const byOrd=new Map(entries.map(entry=>[entry.ord,entry]));
  for(const entry of incoming) byOrd.set(entry.ord,entry);
  return [...byOrd.values()].sort((a,b)=>a.ord-b.ord);
};
```

结构成功后才推进next到 `Math.min(page.to,page.total ?? page.to)`；不是推进entries.length，也不受其它定点读影响。网络失败保留已有entries/next并记录error。页响应token/id不匹配视为reading_changed，不合并。409不自动无限重试：invalidate、显示请求已变化及重新读取按钮，下一次显式读取重建；继续展示的旧展开文本标为旧读取，旧delta与resolved按钮立刻移除。工具结果的正文加载状态由页面本地保存（未读取/读取中/已读/失败），不与 `ToolResultReading.state` 混写；读取失败可再次触发，直到token失效或用户切换请求。

- [ ] **Step 4: 实现delta片与元信息读取。** readRequest首次detail后读body0/0，后续区间不覆盖meta.reply/request_fields/capabilities。loadDelta只消费deltaOrdinals非null的集合，按升序把跨度小于40的ord合成一片，每轮最多pages=2；过滤额外读到但不在delta中的消息。delta=[]立即done，null显示关系状态且不读消息。readRequest(validate=true)重新GET详情，token变化先清掉旧内容；readRoute只有用户选择路由/展开路由时发起。
- [ ] **Step 5: 运行绿测并发布静态模块。** `bun test tests/reader-store.test.ts tests/http.test.ts`；`/reader-store.js`返回JavaScript与现行CSP，任意路径仍404。`bun run typecheck`核对JSDoc。
- [ ] **Step 6: 提交边界。** 建议 `feat(reader): cache request reading pages by version and range`。更新提案的缓存取舍与实际验证。

## Task 5: 把可信输入与回复投影为单行步骤

**Files:** Create `web/trace-view.js`、`tests/trace-view.test.ts`；Modify `web/body-view.js:17`、`:348`、`:443`；Test `tests/body-view.test.ts`；Modify `src/http.ts`静态白名单。

**Interfaces:** ConsumesTask 4 RequestRead、RequestRow、messageEntries/messageBlocks/replyView/deltaOrdinals。Produces纯函数：

```ts
type TraceStep = {
  key:string; reqId:number; kind:'user'|'assistant'|'tool'|'record'|'aux';
  text:string; messageOrd:number|null; callOrd:number|null;
  raw:unknown; unrecognized:boolean;
  status:'failed'|'missing_body'|'unknown'|'truncated'|null;
  result:{state:'resolved'|'pending'|'ambiguous'|'unpaired'
    |'unavailable'|'invalid_location'; reqId:number|null} | null;
};
export function projectSteps(row:RequestRow, read:RequestRead|null):TraceStep[];
export function toolSummary(name:string,inputText:string):string;
export function renderTraceRows(
  row:RequestRow, steps:TraceStep[], ordinal:number,
  open:ReadonlySet<string>, complete:boolean,
):string;
```

ToolEntry保留调用者req_id和result_path；renderTools按钮改为data-tool-owner/data-call-ord，不再按result_req/result_ord反向寻找调用。read=null时是加载/状态记录，不能把请求级input_preview拆成确定用户步骤。`status` 只表达请求级与回复完整性的可见状态，`result` 只表达工具关联；结果正文是否已读由reader-store的缓存和页面状态决定，不写进投影。

- [ ] **Step 1: 写顺序与增量红测。** 测试中定义current detail、meta和消息解释，至少包含旧ord0、真正新增ord2/3，以及text→tool→text回复。两个新增消息分别为text和unrecognized，确保原型遗漏不进入生产。

```ts
const steps=projectSteps(row,read);
expect(steps.map(s=>s.kind)).toEqual(['user','user','assistant','tool','assistant']);
expect(steps[1]?.unrecognized).toBe(true);
expect(steps.map(s=>s.key)).toEqual([
  '7:message:2','7:message:3','7:reply:text:0','7:call:1','7:reply:text:2',
]);
const html=renderTraceRows(row,steps,4,new Set(),true);
expect(html.match(/data-request-ordinal="4"/g)?.length).toBe(5);
expect(html.match(/class="compact-metrics"/g)?.length).toBe(1);
expect(html).not.toContain('aria-expanded="true"');
expect(html).not.toContain('<time');
```

再测注入/empty/tool_result不是用户、dirty/branch/unknown无确定用户步骤、aux只一个辅助记录、两个不同请求相同call_id键不冲突、纯工具回复、thinking-only、空回复、unsupported、XSS、large参数摘要。状态与关系另测：`row.status=500` 且已有用户与回复步骤时仍有 `status:'failed'` 记录；Chat `finish_reason='length'` 与 Anthropic `stop_reason='max_tokens'` 产生 `truncated`，请求行仍成功；正常停止不产生 `truncated`；未知停止原因产生 `unknown` 并保留原值；工具步骤带关联状态与结果请求 ID，未读取正文不改变关联状态；`toolSummary` 只返回动作对象，不含结果正文。renderTraceRows只含折叠行与详情容器，正文详情由app按key填充。

- [ ] **Step 2: 运行红测。** `bun test tests/trace-view.test.ts tests/body-view.test.ts`。
- [ ] **Step 3: 实现投影与工具摘要。** 从可信delta中挑isInput=true且input.state为text/unrecognized的每个消息；用户原始值保留在消息块，不把多个用户消息拼成一条。aux先返回一条；其它请求保留reply内容块顺序，thinking不生成常驻步骤，未知块产生可展开记录。Chat单choice使用messageBlocks，文本与call用不同key命名空间解决index重复；多choices产生限制记录，不启用冲突工具身份。

```js
export function toolSummary(name,inputText) {
  let args=null;
  try {args=JSON.parse(inputText);} catch { /* 非JSON参数按原文展示 */ }
  const value=args && typeof args==='object'
    ? args.command ?? args.cmd ?? args.file_path ?? args.path ?? args.pattern ?? inputText
    : inputText;
  return `${name || '未命名工具'} · ${typeof value==='string' ? value : JSON.stringify(value)}`;
}
```

摘要只用于显示，不用于工具配对；最终HTML必须esc。读取不完整时增加继续读取记录，complete=false使metrics不显示；全部读完将读数放最后一个步骤。request.status失败、正文状态、回复截断或未知增量在所属记录上可见，不能只依赖颜色或title提示，也不能因为已有用户或回复步骤就省略状态记录。工具行摘要只写动作对象和结果关系，不渲染结果正文开头；关系状态放在不被省略号裁剪的独立元素。回复完整性按§3.4映射，`truncated` 不把请求行改成失败。

- [ ] **Step 4: 修正工具按钮并验证。** toolEntries保留result_path，renderTools用owner+call ord绑定按钮，pending/ambiguous不发读取。关系为resolved时，工具行给出「结果见请求 N」入口；N用当前窗口展示号，数据属性保存稳定req_id。测试两工具都指向目标同message不同content块时按钮仍各有不同call ord，不做html.replace。未读取结果时显示待读取，读取失败保留重试，不写成未记录或未配对。更新原有data-tool-result断言为新的调用者身份断言。
- [ ] **Step 5: 运行绿测。** `bun test tests/trace-view.test.ts tests/body-view.test.ts tests/http.test.ts`，`bun run typecheck`；新静态 `/trace-view.js` 可访问。
- [ ] **Step 6: 提交边界。** 建议 `feat(reader): project confirmed inputs and reply blocks into trace steps`。本文引用的稳定键和计量归属在note记录理由，代码/架构拥有实际接口。

## Task 6: 切换生产中栏与窗口导航

**Files:** Modify `web/app.js:23`、`:223`、`:559`、`:617`、`:792`、`:1058`、`:1316`、`:1535`、`web/index.html:108`、`:609`；Test `tests/web.test.ts`、`tests/reader-store.test.ts`、`tests/trace-view.test.ts`。

**Interfaces:** ConsumescreateReaderStore/projectSteps/renderTraceRows。Produces唯一生产步骤轨迹、选中/展开、顶部loadEarlier、refresh、jumpLatest和URL恢复。保留resolveTraceTarget、purposeLabel、isAuxRow、auxSummary、restoreScroll的有效行为；createReader测试随状态迁移到reader-store，删除旧的网络实现，不能同时留下details/bodies两套权威缓存。

- [ ] **Step 1: 把页面相关状态缩到一个明确对象，并写窗口合并回归。** 选择身份用req_id/step.key/callOrd，不用数字序号。

```js
const state={session:null,reqId:null,selectedStep:null,toolOrd:null,
  stepOpen:new Set(),requestOpen:new Set(),railTab:'facts',
  query:'',agent:'all',pendingSession:null};
```

store测试锁住loadEarlier prepend+去重+排序，失败保留旧rows/cursor；新latest刷新替换窗口并作废旧内容。web测试保留alias canonical、不存在及窗口外请求区分，补充旧view参数被忽略但session/trace仍恢复。默认选最新只设置选择不算完成，首屏渲染后必须让选中组进入main可见区域。URL明确trace时保留该请求语义；窗口外时读取其详情，在右栏可看并提示未在窗口，不静默改选最新，也不扫描全部历史定位。

- [ ] **Step 2: 运行红测。** `bun test tests/web.test.ts tests/reader-store.test.ts tests/trace-view.test.ts`。
- [ ] **Step 3: 接入生产请求窗口与分批读取。** 首屏selectSession使用older与按高度计算limit，默认选最新请求，详情全部折叠，并把选中组带入可见区域。先画列级占位，再按共享4并发加载窗口请求detail+meta+最多两片delta；每批完成仅重绘当前session，不等待所有route。删除prefetchDetails、prefetchBodies、BODY_PREFETCH、ensureDetail/ensureBody及30笔route预取，由store统一承担。中栏采用projectSteps，原位展开继续使用生产路由/完整性/原始对象区块，完整历史按需读取，原始对象标明当前已读范围。工具行在关系已确认时显示「结果见请求 N」入口；目标窗口外只读该请求详情并提示未在窗口，不扫描历史。关联状态与正文加载状态分开显示，未读取不写成未记录。
- [ ] **Step 4: 实现顶部锚点与显式刷新。** 当前滚动容器：main为独立滚动时使用main，窄屏overflow visible时使用document.scrollingElement。记录可见第一条稳定step.key与top，prepend并分批补正文时均按该key补偿；用户主动滚动后不再强制补偿过期锚点。toggle行详情不触发另一选中操作。

```js
const before=anchor.getBoundingClientRect().top;
// await store.loadEarlier(); renderMain(); 然后在下一帧取同一稳定key。
scroller.scrollTop+=sameAnchor.getBoundingClientRect().top-before;
```

空页到起点后隐藏历史按钮。刷新重新读最近窗口、清步骤展开与旧token，显示读取时间；回到最新先刷新最近窗口再定位最后请求，不把已载入旧末尾称最新。历史追加与回到最新相互独立。旧view=ledger/conversation/variant参数读取时忽略，updateURL仅输出session/trace/tab；popstate作废旧会话异步代次。复制/折叠等状态不写入URL。
- [ ] **Step 5: 删除双视图与旧样式。** 删除renderConversation、convCard、ledgerRow/ledgerRows、jumpToLedger和data-view/data-ledger分支；请求详情的正文组合保留供原位/右栏复用。删无引用CSS前搜索生产所有选择器，不能删除renderCapabilities/renderMessages/renderReply仍使用的类。中栏36px行用min-width:0、摘要ellipsis，按钮有aria-expanded、aria-controls及焦点样式。异常状态放在不被ellipsis裁剪的独立元素；摘要与计时的宽度沿用Task 0的实测结果，本任务不预设新的固定宽度。每个请求只在最后完成步骤渲染一组请求读数；费用/token汇总仍按request遍历。
- [ ] **Step 6: 运行绿测与合成浏览器操作。** 代码测试同Step 2及`bun run typecheck`。用临时合成服务检查1560×960首屏至少30行、默认展开0、相同请求共享编号、每行无time和模型；在1507×838复现默认选中最新时的可见性，选中组必须进入main可见区域。顶部加载后锚点偏移≤1px（等布局稳定）。工具行检查已确认结果入口、未读取/读取失败/未确认三种状态，以及窗口外结果不扫描历史。浏览器工具使用前读ego-browser用法，不复用真实collector生成测试样本；截图失败则记录未完成，几何检查不能冒称视觉通过。
- [ ] **Step 7: 提交边界。** 建议 `feat(web): replace conversation and ledger views with a single trace`；本项已改变生产布局，创建新的implemented记录或把本提案分项转成已交付事实，链接原型note。旧固定账本与裁剪note部分取代，保持其仍有效的原因及验证，不提前整篇归档。

## Task 7: 接入右栏请求上下文与工具详情

**Files:** Modify `web/app.js:940`、`:1104`、`:1240`、`:1295`、`:1535`、`web/index.html`右栏CSS；Test `tests/reader-store.test.ts`、`tests/body-view.test.ts`、`tests/web.test.ts`。

**Interfaces:** ConsumesRequestRead.structure、loadStructure/readToolResult/readRoute、renderCapabilities/renderMessages/renderMessageDetail/renderReply、ToolResultReading。Produces右栏facts/body/tools/route，以及工具overview/params/result/schema；同请求展开状态存在该请求UI状态，不从DOM位置猜数据身份。

- [ ] **Step 1: 写结构和右栏组合回归。** body-view组合渲染可以导出无DOM函数供测试。structure的total=45、ords=[]时有数量但没有消息；首次展开40条，下一片5条，点击消息详情再返回仍45条。明确delta=null与[]：前者不标新增并给说明，后者显示新增0。能力missing/partial不显示零技能，正文evicted不出现可加载历史按钮。

```ts
expect(html.indexOf('请求能力')).toBeLessThan(html.indexOf('请求结构'));
expect(html.indexOf('请求结构')).toBeLessThan(html.indexOf('本次回复'));
expect(html).not.toContain('<details open');
expect(html).toContain('45 条消息');
```

工具回归以同消息两个结果为重点：点击owner7/ord1结果显示second result，当前req仍7，旧选中请求的迟到结果不能覆盖当前工具；409清掉已resolved展示并提供重新读取。另测工具关联与正文加载分开：resolved未读取时显示待读取与结果请求入口，读取失败可重试且不改写关联状态，unpaired/pending/ambiguous不显示结果正文。Schema覆盖present/empty/missing/partial/同名多定义，不能把能力不可读写成未声明。

- [ ] **Step 2: 运行红测。** `bun test tests/body-view.test.ts tests/reader-store.test.ts tests/web.test.ts`。
- [ ] **Step 3: 复用区块组合。** 从ledgerBodySection保留能力/结构/回复的纯组合，结构使用独立ords加载列表，不把delta Map全部作为历史。能力details和结构details默认closed，首次展开才loadStructure，loading禁用重复按钮，错误可重试。复制调用messageCopyText，不复制HTML；返回按钮只清structure.selected。同请求重绘保持能力清单、条目Schema、结构开合及selected，换请求右栏回顶部；状态按稳定key存Map，避免按details下标恢复到另一清单。
- [ ] **Step 4: 完整回复与工具详情接线。** facts按§1.3排序，保留生产usageSection/timingSection/promptSection/completenessSection，routeSection延迟到路由tab或展开时加载。renderReply显示全文，thinking默认折叠。回复完整性按§3.4单独显示；HTTP成功且`finish`为长度上限时标截断，请求状态仍成功，缺失回复不标完成。工具点击只用owner/callOrd，概览显示配对状态与正文加载状态，参数展示原始inputText，结果用Task 3接口，Schema从当前meta.capabilities.tools.items按工具名找：0项在capabilities为present/empty时说明未声明，missing/partial/unrecognized说明能力不可读或不完整及原因，多同名项逐项列出并说明无法唯一选择，不任选第一项。结果is_error true为失败、false为上游未标错、null为未报告，不把resolved当成功；未读取结果不写未记录，读取失败保留重试。模型时长明确归属请求，工具执行时长未采集。
- [ ] **Step 5: 浏览器合成验收与绿测。** 操作能力展开、Schema、40+5结构分页、消息详情返回、复制拒绝fallback、工具参数/结果/Schema、右栏返回请求、路由tab、同请求scrollTop保持与换请求归顶。另操作：HTTP成功但回复长度上限时的截断提示与请求成功状态并存；resolved未读取、读取失败重试、未确认三种工具状态；能力不可读与工具未声明的不同文案。响应式400px时全文/JSON在栏内换行或内部滚动，文档无横向溢出。绿测同Step 2，类型检查只在本项代码改变后运行一次。
- [ ] **Step 6: 提交边界。** 建议 `feat(web): add request context and precise tool details to the rail`；交付事实更新架构与本提案生命周期，保留能力声明不等于实际调用的理由。

## Task 8: 完成布局控制、文档和综合验收

**Files:** Modify `web/index.html`、`web/app.js`、`README.md`、`docs/architecture-design.md`、`docs/README.md`、本计划、生产阅读Agent Note；必要时更新旧生产布局note的Related和事实定位，原型代码不改作生产契约。

**Interfaces:** ConsumesTask 6/7页面与store。Produces可折叠会话栏/右栏、可拖动与键盘调整的详情宽度、Session ID复制及可复现验收记录。

- [ ] **Step 1: 实现布局变量和原生控制。** 复用原型对应CSS与事件，但只迁移有效样式。默认sidebar250px、rail380px，rail范围280..640，main至少320px；1000px及以下用堆叠布局隐藏分隔线。用CSS变量维护grid，body类控制折叠，按钮有aria-controls/aria-expanded，右栏分隔线role=separator、tabindex=0、aria-orientation=vertical、aria-valuemin/max/now。

```js
const clampWidth=(wanted,viewport,sidebar) =>
  Math.max(280,Math.min(wanted,640,Math.max(280,viewport-sidebar-6-320)));
```

pointerdown capture，move只在capture时更新，up/cancel释放；双击恢复380，方向键左右每次20px，window resize重新限制。折叠栏要同步隐藏其分隔线和可聚焦后代，不能仅用opacity。
- [ ] **Step 2: Session ID复制和左栏精简。** JSON conv_key解析为session时复制第二项原始ID，conv身份则标复制会话键并复制完整conv_key；不能把JSON数组误称UUID。clipboard成功才显示已复制，拒绝/不可用显示可选中文本和手工复制提示。去掉左栏未知派生的待确认文字与中栏通用缺正文整行；具体异常、失败及历史未读范围仍就地显示。主题localStorage读写继续try/catch，宽度/折叠状态只存在内存。
- [ ] **Step 3: 完成一次合成浏览器验收。** 使用临时目录fixture数据和非默认测试配置启动单独服务，关闭服务后清理临时目录；不得读取默认本机库/账号/令牌。fixture沿用 Task 0 的失败、截断、工具结果、能力五态和窗口外场景，覆盖下方矩阵与阅读任务，保留实际尺寸/错误码/网络请求计数，不保存真实正文。页面几何检查同时检查内部读数子元素边缘，不能只看document.scrollWidth。

| 场景 | 验收标准 |
| --- | --- |
| 1560×960、30+请求、同请求多消息/多工具 | 每行36px，默认详情0，重复请求数字正确，首屏填充且不出现多行请求头 |
| 最新窗口→向前两页 | 正序、请求无重复，步骤不重复历史，锚点偏移≤1px，失败重试不推进游标 |
| 真实空会话、不可读/失败/unsupported | 不混用另会话，具体状态可见，不当成0消息或成功 |
| delta超过80、first含大量历史 | 先显示有限片段与继续读取，未读不冒称完整；继续读取不重复 |
| 两请求相同call_id、同消息两个结果、result_ord>40 | owner/ord/path精确定位，读取单条目标，当前owner不跳走 |
| 快速切换会话/请求，延迟HTTP、503、409 | 旧响应不覆盖新状态，409移除旧确定关系，可显式重读 |
| 能力5态、45条结构、全文和返回 | 不混淆缺失与空，40+5分页无重复，返回保留已读和滚动 |
| 拖动、方向键、双击、左右栏折叠 | main保留宽度，按钮及separator值同步，纯键盘可操作 |
| 400/620/1000/1240/1560px、浅/深/系统主题 | 页面无横向滚动，代码块内部滚动；可见读数子元素不被左侧裁剪 |
| 最大时长131.56s/133.44s、长状态与路径 | 摘要让位，异常仍可见，窄屏移到右栏的读数有明确入口 |
| HTTP失败且已有用户输入/回复 | 独立失败记录仍可见，不被步骤覆盖；摘要截断不影响状态文字 |
| HTTP 200 + Chat length / Anthropic max_tokens | 请求成功与回复截断并列显示，不把请求标成失败；正常停止不标截断 |
| 工具resolved未读取、读取失败、未确认、窗口外 | 待读取、重试、未确认、结果见请求N分明；未读取不写未记录，窗口外不扫描历史 |
| 默认选中最新、1507×838 | 选中组进入main可见区域；URL窗口外trace保留选择并在右栏说明 |
| Schema能力present/empty/missing/partial/同名 | 未声明与不可读分开，同名逐项列出，不任选第一项 |
| URL刷新、canonical别名、窗口外trace、旧view | 保留session/trace和支持tab，别名归一，不自动扫描整会话 |
| 读取成本 | 并发网络≤4；未选中请求不取route，结构折叠不读历史首片；记录元信息/首次步骤完成时延和传输字节 |

三项阅读任务沿用 Task 0 的同一合成场景，在生产页面重复执行。每项记录完成时间、点击/展开次数和回答正确性；时间与点击只作同场景对照，不设未经验证的阈值，不把未实际取得的用户确认写成通过。

| 任务 | 提问 | 回答要点 |
| --- | --- | --- |
| a | 找到最后一条已记录回复，说明当前进展 | 指向正确的请求与回复；能区分回复正文、工具调用和后续请求，不把未读历史当进展 |
| b | 找到失败请求，说明后续发生了什么 | 指向正确的失败请求；说明后续请求存在但不宣称已确认重试；不把后续成功写成重试成功 |
| c | 从一次工具调用定位对应结果和承载它的请求 | 给出结果所在请求与调用位置；结果未读取或窗口外时明确说明，不猜配对 |

时间与字节记录是本轮测量结果，不预设性能达标。若真实规模需要另一轮性能优化，按观察结果提出有界摘要投影或虚拟化，不在此提前实现。

- [ ] **Step 4: 同步文档与决策生命周期。** 架构查询节写入分页方向/token/409/结果接口和读取一致性边界；输入能力节保留原语义。README更新生产阅读操作和本轮合成验收，旧验收中view/56px等失效事实移出当前说明，必要历史链接旧note。docs/README更新本计划入口描述。原型说明保留 Task 0 的验证结果；生产验收结果另记，不用原型样本代替。生产提案迁入implemented，Proposal改Decision，Acceptance/Risks折入Consequences/Testing，引用实际测试结果；修复本计划Spec和所有入站链接。旧固定账本与读数修复note按supersession规则核对，仍保留内部裁剪的防错证据和有效理由，不因移除一个布局就删除所有相关记录。
- [ ] **Step 5: 运行最终必要检查。** 尚未在最后一次代码修改后通过的相关测试统一运行：

```sh
bun test tests/queries.test.ts tests/http.test.ts tests/body-api.test.ts tests/reading.test.ts tests/reader-store.test.ts tests/trace-view.test.ts tests/body-view.test.ts tests/web.test.ts
bun run typecheck
bun run verify:notes
git diff --check
```

已在最终代码状态通过的项目不重复。未运行生产全套、真实数据或截图时如实写未运行；没有新旧writer同时启动，没有调整容量门槛。真实数据只读操作仍须在具体执行会话确认其范围，不属于合成验收。
- [ ] **Step 6: 提交边界与交付。** 建议 `feat(web): finish trace layout controls and document production reading`。逐路径审阅diff，真实正文/配置/令牌不进入提交；未经授权不git add/commit。最终说明实际改动、验证、剩余边界及英文commit message。

## 4. 自检与执行收口

需求映射：原型缺陷修复/阅读任务/默认选中可见→Task 0；单行/折叠/隐藏模型和时间/重复请求数字→Task 5–6；最近窗口/历史加载/锚点/刷新→Task 2、4、6；能力/结构/完整回复/全文返回→Task 7；准确工具结果/Schema→Task 3、5、7；侧栏折叠/Session复制/右栏调宽→Task 8；来源一致性/dirty及保留状态→Task 1、3、4；性能与隐私→Task 4、8。没有将采集改造、schema或运行模式切换作为依赖。

Task 0 是生产落地的先决门槛：四类状态分离与三项阅读任务未通过时，Task 1 不启动，缺陷留在原型内修复或交回用户讨论，不推给生产任务。门槛通过后，三个生产风险项仍需验证：发布代与同步旧列不同值仍能正确读取；409与迟到响应不留下错误的确定步骤；同消息多个工具结果按完整位置取得。视觉密度可以在这些读取条件通过后调整，不反向改变请求身份或计量口径。

本计划完成即代表评估与执行方案已交付。执行选项沿writing-plans技能：可逐任务派发subagent并在任务间复核，或在当前会话按executing-plans逐项执行。用户选择执行方式前，生产实现保持未执行。
