# ATC 读取架构 Implementation Plan

> **For agentic workers:** 用户当前只授权方案与规则。执行前需取得实施授权，再按本文逐项推进。实现时加载 `ponytail`；跨文件变更使用项目要求的 worktree。步骤用复选框记录，不因本文存在而提交、部署或启用生产切片。

**Goal:** 让新增读取 feature 复用相同的契约、调度、版本和显示机制，并保留未来 macOS 客户端接入位置。

**Architecture:** 在现有 reader-store 内部引入具名读取 Interface、HTTP adapter 和有界调度，保留单一证据所有者。准备流程使用阅读批，显示模型按本地内容修订与依赖复用，DOM 继续键控提交。后端保持单 writer 与独立只读查询，客户端不直接操作 SQLite。

**Tech Stack:** TypeScript、Bun、bun:sqlite、原生 JavaScript；不增加第三方运行依赖，不增加前端编译步骤。

**Spec:** [读取架构提案](../../../.agents/notes/proposed/architecture/2026-11-02-read-architecture-and-client-seams.md)、[读取接入规则草案](../../read-feature-rules.md)。性能证据及建议阈值见[性能评估](2026-11-02-interaction-performance-optimization.md)。

## Global Constraints

- 生产页面只有 HTTP adapter 执行读取 Fetch；feature、store、投影和 DOM 不拼 URL、不识别 Response/status。静态资源由浏览器加载不受此限制。
- 证据缓存只有 reader-store 一个所有者，投影缓存只有显示 module 一个所有者。
- 取消后仍检查 epoch、记录归属、本地修订和 reading token；取消不能替代版本守卫。
- 保留结构连续上界与可信增量两套游标、20 片准备预算、旧投影版本归属、步骤稳定键、焦点和锚点。
- 单组写事务保持原子，写事务不得 await；不启用生产切片，不改变派生语义，不引入第二个 writer。
- 监听仍为 `127.0.0.1`；不放宽 Host、Origin 与认证，不将正文、token、账号和真实配置写入测试或日志。
- 只用合成数据测试，真实流量验收单独记录；运行最窄回归，不重跑输入未变且已通过的检查。
- 本轮不实现 IPC、macOS 打包、自动更新或新的本地数据库，不预选桌面框架。

## 阶段与完成标准

这是同一条读取链路的实施计划。Task 1–3 先建立并接入契约及生命周期，Task 4–5 治理批量读取，Task 6 治理显示计算，Task 7 固化准入与验收。每项产生可运行的提交；Task 1 的 adapter 在类型和独立测试中可用，Task 3 消费它；Task 4 的端点由 Task 5 消费。不保留永久兼容双入口。

后台 derive 大事务、生产切片解冻和虚拟化属于独立子项目，不在本计划伪造完整实现。达到[性能评估](2026-11-02-interaction-performance-optimization.md)的触发条件时必须另出方案；这些未关闭分支不因客户端重构完成而消失。

实施前在仓库上级目录的 `.codex-worktrees/atc-read-architecture` 创建 `feat/read-architecture`。主检出已有未提交材料，按实际依赖复制进 worktree，不夹带前端换肤和宣传片提案。worktree 依赖按项目规则复用主检出 node_modules。提交只落功能分支；合并 master 与生产动作均另按授权执行。

## 文件与职责

| 文件 | 动作与职责 |
| --- | --- |
| `src/read-contract.ts` | 新建，纯类型操作集合、输入/输出和稳定错误；允许 type-only 引用已有 DTO |
| `web/read-http.js` | 新建，唯一 Fetch adapter；URL、HTTP、解析与顶层校验 |
| `web/read-scheduler.js` | 新建，活动/待发上限、公平性、scope 取消、计时 |
| `web/reader-store.js` | 改造为消费 transport；保留证据缓存，新增退出、销毁与读取 facade |
| `web/context-detail.js` | 改造为消费具名目录和条目读取，保留 DOM 与弹窗生命周期 |
| `src/reading.ts` | 新增有界批读取，复用身份与只读快照 |
| `src/protocols.ts` | 拆出内部单次准备供同作用域复用，保留原 getBodyPage 行为 |
| `src/http.ts` | 新静态模块登记与两个显式批端点；沿用访问控制 |
| `web/trace-preparation.js` | 目标优先与批量准备，聚合通知，保留依赖与预算 |
| `web/trace-model.js` | 新建，迁入现有投影保留逻辑，加入修订/依赖复用；无网络与 DOM |
| `web/app.js` | 装配 adapter/store/model，执行选择、宿主 URL、焦点与视图效果 |
| `web/trace-dom.js`、`trace-view.js`、`session-view.js` | 增量模型消费、线性索引与提交结果 |
| `prototypes/synthetic-server.ts` | 维持生产同形路由并补批端点，继续加载生产页面 |
| `tests/helpers/read-transport.ts` | 新建，合成 fixture adapter 与可延迟任务，供 store 行为测试 |
| `tests/read-http.test.ts`、`read-scheduler.test.ts`、`read-contract.test.ts`、`trace-model.test.ts` | 新建，分别测试编码/错误、调度、两种 adapter 行为、投影复用 |
| `tests/reader-types.ts`、store/准备/HTTP/弹窗/投影既有测试 | 更新消费者与保留行为断言，删除只钉旧 URL 的重复断言 |
| `AGENTS.md`、`docs/architecture-design.md`、所属 Agent Notes | 随交付更新现状、部分取代关系与接入入口 |

## Task 1：具名读取契约与 HTTP adapter

**Files:** 新建 `src/read-contract.ts`、`web/read-http.js`、`tests/read-http.test.ts`、`tests/helpers/read-transport.ts`、`tests/read-contract.test.ts`；修改 `src/http.ts` 静态白名单、`tests/http.test.ts`。

**Interfaces:** 产出 `ReadOperations`、`ReadInput<K>`、`ReadOutput<K>`、`ReadTransport`、`ReadErrorCode`，以及 `createHttpReadTransport({fetcher, baseUrl?, headers?}): ReadTransport`。本项不改 store；HTTP adapter 与可执行 fixture adapter 是实际可替换的两个 adapter。

- [ ] **Step 1：定义全操作表，编译期引用既有 DTO，不复制结构。** 操作名与参数如下；`cursor` 明确使用 `null`，不混用缺字段与空字符串。批次 DTO 也在本项定义，避免消费者各自拼结构。

```ts
import type { SessionRow } from './queries/sessions';
import type { RequestRow } from './queries/projection';
import type { Page } from './queries/cursor';
import type { ReadingDetail, ReadingBody, ToolResultReading,
  ContextItemQuery, ContextItemReading } from './reading';
import type { TurnsPage } from './queries/turns';
import type { BgJobRow } from './queries/bg-jobs';
import type { SessionSummary, SummaryEntriesQuery, SummaryEntries } from './queries/session-summary';
import type { Stats } from './queries/stats';
import type { getRoute } from './queries/routes';

export type RangeInput = { id: number; token: string; from: number; to: number };
export type ContextBodyTarget =
  | { operation: 'body'; input: RangeInput }
  | { operation: 'toolResult'; input: {id: number; ord: number; token: string} };
export type ReadingBundle = { detail: ReadingDetail; meta: ReadingBody };
export type BatchItem<T> =
  | { index: number; requested_id: number; state: 'ok'; value: T }
  | { index: number; requested_id: number;
      state: 'not_found' | 'reading_changed' | 'oversized' | 'failed'; reason: string };
export type BatchPage<T> = { items: BatchItem<T>[]; next_index: number | null };
export type ReadOperations = {
  sessions: { input: {limit: number; cursor: string | null}; output: Page<SessionRow> };
  requests: { input: {key: string; limit: number; cursor: string | null;
    direction: 'forward' | 'older'}; output: Page<RequestRow> };
  detail: { input: {id: number}; output: ReadingDetail };
  body: { input: RangeInput; output: ReadingBody };
  toolResult: { input: {id: number; ord: number; token: string}; output: ToolResultReading };
  route: { input: {id: number}; output: ReturnType<typeof getRoute> };
  turns: { input: {key: string; from: number | null}; output: TurnsPage };
  bgJobs: { input: {key: string}; output: BgJobRow[] };
  summary: { input: {key: string}; output: SessionSummary };
  summaryEntries: { input: {key: string; query: SummaryEntriesQuery}; output: SummaryEntries };
  contextItem: { input: {id: number; token: string; query: ContextItemQuery}; output: ContextItemReading };
  stats: { input: Record<string, never>; output: Stats };
  readings: { input: {key: string; ids: number[]}; output: BatchPage<ReadingBundle> };
  bodyRanges: { input: {key: string; ranges: RangeInput[]}; output: BatchPage<ReadingBody> };
};
export type ReadInput<K extends keyof ReadOperations> = ReadOperations[K]['input'];
export type ReadOutput<K extends keyof ReadOperations> = ReadOperations[K]['output'];
export type ReadTransport = {
  execute<K extends keyof ReadOperations>(operation: K, input: ReadInput<K>,
    options: {signal: AbortSignal}): Promise<ReadOutput<K>>;
};
export type ReadErrorCode = 'reading_changed' | 'not_found' | 'invalid_input'
  | 'unavailable' | 'unauthorized' | 'forbidden' | 'unsupported_operation'
  | 'invalid_response' | 'cancelled' | 'queue_full' | 'batch_too_large';
```

`BatchItem.index` 是本次调用输入位置，分页重发后缀后重新从 0 编号。reading token 与 canonical id 在成功 value 内保持原字段，不在外层再复制一份可冲突事实。所有后续任务使用这一版本，不采用性能评估里的早期候选形状。

- [ ] **Step 2：先写编码与错误测试并执行失败。** HTTP 单元测试使用本项注入 fetcher，验证 path/query 与 signal。fixture adapter 提供具体 sessions、requests、detail、body、批次结果及错误注入，不调用真实 HTTP；不支持的操作明确报 unsupported_operation。

```ts
import { expect, test } from 'bun:test';
import { createHttpReadTransport } from '../web/read-http.js';

test('编码会话键并把取消传到 fetcher', async () => {
  const controller = new AbortController();
  const calls: {url: string; signal: AbortSignal | null}[] = [];
  const transport = createHttpReadTransport({fetcher: async (url, init) => {
    calls.push({url: String(url), signal: init?.signal ?? null});
    return new Response(JSON.stringify({items: [], next_cursor: null}));
  }});
  await transport.execute('requests', {key: 'a/b', limit: 30,
    direction: 'forward', cursor: null}, {signal: controller.signal});
  expect(calls[0]!.url).toContain('/api/sessions/a%2Fb/requests?');
  expect(calls[0]!.signal).toBe(controller.signal);
});
```

执行 `bun test tests/read-http.test.ts`，预期新模块缺失或导出缺失失败。补 409→reading_changed、401/403、畸形 JSON、批次错 index、缺项、id/token 不对应和取消后返回的用例。

- [ ] **Step 3：实现显式操作编码与错误映射。** 使用 `URLSearchParams`，不接受调用者提供任意 URL。取消归 cancelled；400 为 invalid_input；404 为 not_found；409 为 reading_changed；非 2xx 保留 status。status 未知映射 unavailable，不把 404 映射为 unsupported_operation。headers 函数每次调用可注入凭证，默认空；不在异常信息输出 headers 或正文。

```js
// read-http.js 内部，execute 先编码输入，再调用本段。
const response = await fetcher(url, { method: 'GET', headers: headers?.(), signal });
if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
if (!response.ok) {
  const code = response.status === 409 ? 'reading_changed'
    : response.status === 404 ? 'not_found'
    : response.status === 400 ? 'invalid_input'
    : response.status === 401 ? 'unauthorized'
    : response.status === 403 ? 'forbidden' : 'unavailable';
  throw Object.assign(new Error(code), { code, status: response.status });
}
```

本段位于 `createHttpReadTransport` 返回的 `execute` 内，`url` 来自显式编码 switch、`fetcher/headers` 来自构造参数、`signal` 来自 execute options。继续 `response.json()`，解析失败报 invalid_response；解析后再次检查 signal，再按操作做顶层与身份校验。不要把此片段作为跳过其余验证的完整实现。

- [ ] **Step 4：运行两 adapter 共用的合成契约用例。** 用同一套 fixture 通过 `createHandler` HTTP adapter 与内存 adapter 读取，比较公开结果。测试不查询全库或真实正文。执行 `bun test tests/read-http.test.ts tests/read-contract.test.ts tests/http.test.ts` 与必要类型检查。
- [ ] **Step 5：登记 `/read-http.js` 静态模块，更新所属 note 的本项交付范围。** 只暂存本项文件，运行 notes 门禁，提交 `refactor(read): define named operations and an HTTP transport adapter`。

## Task 2：有界调度与 owner 取消

**Files:** 新建 `web/read-scheduler.js`、`tests/read-scheduler.test.ts`；修改 `src/http.ts` 静态登记与相关测试。

**Interfaces:** `createReadScheduler(options?)` 返回 `run<T>({scope, priority, signal?}, task: (signal: AbortSignal) => Promise<T>): Promise<T>`、`cancelScope(scope)`、`dispose()`、`stats()`。scope 为对象引用；priority 为 `interactive | background`。stats 只返回活动数、待发数及固定计数，不暴露任务正文。初始上限活动 4、待发 64、后台活动 3、连续交互最多 8；测试可注入更小参数。

- [ ] **Step 1：写活动槽与响应体等待的失败用例。** 用 deferred Promise 控制任务，不靠慢 sleep 制造时序。

```ts
import { expect, test } from 'bun:test';
import { createReadScheduler } from '../web/read-scheduler.js';

test('完整任务结束才释放活动槽', async () => {
  let release!: () => void;
  const body = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  const scheduler = createReadScheduler({activeLimit: 1, backgroundLimit: 1});
  const scope = {};
  const a = scheduler.run({scope, priority: 'interactive'}, async () => {
    started.push(1); await body; return 1;
  });
  const b = scheduler.run({scope, priority: 'interactive'}, async () => {
    started.push(2); return 2;
  });
  await Promise.resolve();
  expect(started).toEqual([1]);
  release();
  expect(await Promise.all([a, b])).toEqual([1, 2]);
  scheduler.dispose();
});
```

执行 `bun test tests/read-scheduler.test.ts`，预期缺模块失败。追加队列满、交互淘汰旧后台、后台保留槽、公平计数、任务抛错释放、待发取消、在途取消、重复 dispose、拒绝新任务等可观察行为。

- [ ] **Step 2：实现有限队列。** 每任务持有一个内部 AbortController，链接外部 signal，捕获一次 resolve/reject。未执行取消立即从队列移除并 settle cancelled；已执行只 signal.abort，task settle 后才释放活动槽。即使外层 Promise 已被取消拒绝，忽略取消的 task 仍计 active，不能提前放下一个造成超并发。

```js
// 调度 module 内部，task 是当前出队项。
active += 1;
if (task.priority === 'background') backgroundActive += 1;
Promise.resolve().then(() => task.execute(task.controller.signal))
  .then(task.resolve, task.reject)
  .finally(() => {
    active -= 1;
    if (task.priority === 'background') backgroundActive -= 1;
    task.cleanup();
    pump();
  });
```

`active/backgroundActive/pump` 属于 scheduler 闭包；内部 task 由 run 创建，含 `priority/execute/controller/resolve/reject/cleanup`，cleanup 移除外部 abort listener。pump 选任务前排除 cancelled；reject-once 保护异常和取消同时到达。空队列不创建 timer。

- [ ] **Step 3：实现明确公平性与满队列策略。** 后台最多占背景活动上限；交互队列连续服务计数到 8 时，在允许后台运行的槽上先取一个后台。队列满且新任务为交互时取消最旧待发后台，否则新任务 queue_full。测试从执行顺序和 Promise 结果查证，不依赖私有队列数组。
- [ ] **Step 4：记录排队与执行时间，stats 只返回聚合计数。** 计时用 monotonic clock，测试注入；错误与取消分计，scope 对象不序列化到日志。执行最窄测试与静态模块覆盖测试。
- [ ] **Step 5：同步 note 与架构事实，运行 notes 门禁，提交 `feat(read): bound scheduling and cancel work by owner scope`。** 调度仅被 store 内部使用，不要求业务调用者手工排队。

## Task 3：迁移所有读取并统一退出生命周期

**Files:** 修改 `web/reader-store.js`、`web/app.js`、`web/context-detail.js`、`tests/reader-store.test.ts`、`tests/context-detail.test.ts`、`tests/reader-types.ts`、`tests/web.test.ts`；完善 `tests/helpers/read-transport.ts`。

**Interfaces:** `createReaderStore(transport, onReadChanged?, options?)` 消费 Task 1 的 ReadTransport，内部创建 Task 2 scheduler。原公开读取/peek 保持结果语义；新增 `leaveSession(): void`、`dispose(): void`、`loadStats(): Promise<Stats>`、`readContextItem(id:number, query:ContextItemQuery, token:string, signal:AbortSignal): Promise<ContextItemReading>`、`readContextBody(target:ContextBodyTarget, signal:AbortSignal): Promise<ReadingBody | ToolResultReading>`。ContextBodyTarget 由 Task 1 定义。弹窗 signal 对应 dialog scope，内部 WeakMap 持有 signal→scope，只在该 dialog 使用，不建立跨 owner 去重。它们通过同一 scheduler 执行，弹窗不直接调用 transport。

- [ ] **Step 1：写纯 transport 的 store 测试。** 把旧 fake Fetch 替换为操作级 fixture adapter；保留现有迟到 409、validate、游标与去重断言，HTTP URL 精确性只归 Task 1 测试。

```ts
import { expect, test } from 'bun:test';
import { createReaderStore } from '../web/reader-store.js';
import { createFixtureReadTransport } from './helpers/read-transport';

test('退出会话清窗口且迟到读取不能复活', async () => {
  const fixture = createFixtureReadTransport();
  const store = createReaderStore(fixture.transport);
  await store.selectSession('synthetic-session');
  fixture.hold('detail');
  const pending = store.readRequest(1);
  await fixture.started('detail');
  store.leaveSession();
  fixture.release('detail');
  await pending.catch(() => {});
  expect(store.getWindow().sessionKey).toBeNull();
  expect(store.getWindow().requests).toEqual([]);
  expect(store.peekRequest(1)).toBeNull();
  store.dispose();
});
```

本项 helper `createFixtureReadTransport()` 固定提供 synthetic-session 与 req 1，返回 `{transport, calls, hold(operation), release(operation), started(operation)}`。started 返回下一次该操作进入 adapter 后完成的 Promise，确保上述测试覆盖在途迟到，而非仅覆盖未发送取消。hold 延迟该操作，release 放行；支持测试晚到结果，不能只依赖 abort 主动拒绝隐藏回写错误。执行该新增用例，预期缺 leaveSession 或旧构造参数导致失败。

- [ ] **Step 2：用具名操作替换 store 中全部 URL。** 删除 `createLanes/getJson`；内部 `execute` helper 在 scheduler 任务内 await transport.execute，保证响应解析在槽内。pageScope、sessionScope 用不同对象，切换时 cancel 旧 session scope 并新建。原 `fetchDetail/readRange` 的回写守卫原样保留，复用到具名结果，不以 transport 成功为缓存可写依据。
- [ ] **Step 3：实现共同清理函数。** 先将 rec.pages 的成功 Promise 缓存拆成区间完成值与在途登记；完成后从在途 Map 移除，复用命中返回完成值，版本作废与退出同时清两者。不得在 finally 删除其他代次的新任务。leaveSession 先推进 epoch，再取消 scope，清每记录 autoTimer、reads、deltaInflight、routes、routeValues、windowRows、游标、turns/bgJobs/summary 与在途登记。selectSession 重用清理但保留新目标加载态；dispose 额外取消 page scope 与 scheduler，之后读取返回 cancelled。旧任务 finally 只清属于自己的登记，不清新任务。
- [ ] **Step 4：迁移统计和弹窗。** app 仅在装配处 `createHttpReadTransport({fetcher: fetch})`，其余网络都调用 store。context-detail 的 URL helper 改成纯 `entryReadTarget(session,entry)`，返回 `contextBody` 判别参数；createContextMenu 接收 `readDirectory/readEntry` 两个 facade 函数，内部创建 dialog AbortController，关闭时 abort。目录身份校验和 DOM 转义不变；不同 owner 的 token 不偷偷替换，严格沿用现有来源校验，无法确认时 reading_changed。

```ts
// 修改 context-detail 的纯目标函数测试，HTTP 路径测试移入 read-http.test.ts。
expect(entryReadTarget({reqId: 7, token: 'r1-' + 'a'.repeat(64)},
  {ord: 3, call_ord: null, owner_req: null})).toEqual({
  operation: 'body', input: {id: 7, token: 'r1-' + 'a'.repeat(64), from: 3, to: 4},
});
```

顶层字段读取仍使用 `[0,40)` 保留当前 body 默认区间语义，不能在纯传输迁移中改成 0/0。toolResult 成功对象当前不含 owner canonical/token 回显，HTTP adapter 只验证其既有结构，不要求服务端凭空新增字段；来源资格由请求参数与弹窗代次守卫保证，批量 detail/meta 的严格身份校验仍执行。工具入口使用 `operation:'toolResult'` 及原 owner/ord/token。弹窗取消的任务不进入全局正文缓存；不取消其他 scope 的共享读取。

- [ ] **Step 5：接通无 session popstate、应用退出和显示清理。** app 在恢复无会话 URL 时调用 store.leaveSession、preparation.reset、mainView.reset，并清 retainedSteps/retainedTail、会话 folds、structureSelected、summaryList、弹窗。pagehide 只做幂等清理；pageshow.persisted 时按 URL 重新恢复，验证返回体验，不把 pagehide 等同关闭采集器。
- [ ] **Step 6：检验全部读取入口。** 执行 `bun test tests/reader-store.test.ts tests/context-detail.test.ts tests/web.test.ts tests/selection.test.ts` 与 `bun run typecheck`。搜索 `web/` 中 Fetch 和 `/api/`：除 read-http 编码和纯说明外，运行代码不得有旁路。补充 page/session/dialog 相互不误取消及 body 解析延迟测试。
- [ ] **Step 7：同步单一缓存及生产阅读缓存 note 的部分变化，运行 notes 门禁，提交 `refactor(reader): route all reads through one lifecycle and scheduler`。** 本阶段保持逐笔读取性能，验证行为后再批量。

## Task 4：后端有界阅读批

**Files:** 修改 `src/reading.ts`、`src/protocols.ts`、`src/http.ts`；新增 `tests/reading-batch.test.ts`；修改 `tests/body-api.test.ts`、`tests/http.test.ts`、`prototypes/synthetic-server.ts`。

**Interfaces:** 导出 `getReadingBatch(store, key, ids, budget?) -> BatchPage<ReadingBundle>`、`getReadingRangeBatch(store, key, ranges, budget?) -> BatchPage<ReadingBody>`。budget 为只在进程内使用的 `{maxBytes:number,maxMs:number,clock:()=>number}`，HTTP 端不允许调用者覆盖。契约消费 Task 1 DTO；HTTP 路径分别 `/api/sessions/:key/readings?ids=<JSON>` 与 `/api/sessions/:key/reading-ranges?items=<JSON>`，参数通过 URLSearchParams 编码。HTTP adapter 同步采用这两条编码。

- [ ] **Step 1：用临时合成 Store 写失败测试。** 复用 reading 测试建库和正文写入方式，分别验证 canonical 别名、跨会话 not_found、同批 current token、单项冲突和非可读正文的说明，断言内容不改变。

```ts
import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { getReadingBatch } from '../src/reading';

test('详情和元信息共用批内阅读身份', () => {
  const f = fixture();
  try {
    const key = 'batch-synthetic';
    const ids = [1, 2].map(n => seedPurposeRequest(f.store, {
      convKey: key, startedMs: n,
      messages: [{role: 'user', content: `synthetic ${n}`}],
      cleanGroup: true, purposePending: 0,
      summaryState: 'recomputed', summaryAlgorithm: 1,
    }));
    const batch = getReadingBatch(f.store, key, ids);
    expect(batch.next_index).toBeNull();
    expect(batch.items.map(item => item.index)).toEqual([0, 1]);
    expect(batch.items.every(item => item.state === 'ok')).toBe(true);
    for (const item of batch.items) {
      if (item.state !== 'ok') throw new Error('expected synthetic success');
      expect(item.value.detail.req_id).toBe(item.value.meta.req_id);
      expect(item.value.detail.reading_token).toBe(item.value.meta.reading_token);
    }
  } finally { f.close(); }
});
```

构造 fixture 时只用合成正文和随机测试盐。执行 `bun test tests/reading-batch.test.ts`，预期新导出缺失失败。

- [ ] **Step 2：复用身份与正文准备。** 在 reading.ts 内将 identity/detail/meta 的单项读取集中成一个内部函数，外层 batch 只读事务只开启一次。protocols.ts 把原 getBodyPage 的状态、骨架、System 与能力准备提取为私有作用域函数，单项和批次共同调用；保留宽松骨架错误语义，不直接换用 body.ts 的严格读取函数。同一请求多个区间共享准备，不跨版本缓存。
- [ ] **Step 3：实现前缀预算与超大项。** HTTP 先校验 URL 16 KiB、id 为正 safe integer、详情最多 32 项、区间最多 64 项、token 格式与每片最多 40 条。0 项显式 invalid_input；同请求不同区间保留，重复完整项可复用计算但响应保留每个 index。每完成项检查 20 ms 软预算和约 1 MiB JSON 字节；字节测量包含外层 envelope 和错误结果，序列化只做一次或复用已生成字符串，不为测量再次解码。

超大首项返回 `{index,requested_id,state:'oversized',reason:'item_too_large'}` 并推进；后续超预算项留给 next_index。所有返回路径满足 `next_index===null` 或 `0<next_index<input.length`，并且已返回项恰好覆盖 `[0,next_index)`。单项解码不可抢占，单项超时计入观测。只读事务内不 await；响应发送不持有事务。
- [ ] **Step 4：逐项错误与 HTTP 验证。** 非法参数整体 400；合法输入 not_found、reading_changed、oversized 单列。内部异常只返回固定 failed 原因，不泄漏 SQL 或正文；事务级失败整体 500。每项先 canonical 解析再检查所属会话，跨会话不返回内容。保持现有 GET/HEAD 读入口与 Host/Origin 检查。
- [ ] **Step 5：补合成服务器同形端点。** 在现有 detailOf/bodyPageOf/readingTokenOf 基础上实现相同参数和逐项结果，不维护第二套 UI。完整生产语义由临时 SQLite 契约测试验证，合成服务器仅负责交互夹具，不把简化逻辑当生产正确性证明。
- [ ] **Step 6：运行 `bun test tests/reading-batch.test.ts tests/reading.test.ts tests/body-api.test.ts tests/http.test.ts`。** 覆盖零进展、预算停首项后、稀疏区间、同 id 多 token、正文回收、结果重排。同步架构查询接口与本项 note，运行 notes 门禁，提交 `feat(reading): add bounded versioned reading batches`。

## Task 5：客户端批量准备与逐项合入

**Files:** 修改 `web/reader-store.js`、`web/trace-preparation.js`、`tests/reader-store.test.ts`、`tests/trace-preparation.test.ts`、`tests/reader-types.ts`、fixture adapter。

**Interfaces:** store 新增 `readRequests(ids:number[]): Promise<RequestRead[]>` 和内部批量区间合入；单项 `readRequest/readRange` 通过同一写入函数。逐项失败写入对应 RequestRead 状态并保留成功项；只有批级传输失败拒绝整个调用，准备流程逐项判断，不因数组返回就把所有项标 ready。准备 Interface 保留 `prepare/prepareWindow/reset/has/forget`，通知改为 `(ids:number[],dependencies:number[])=>void`。结构与增量游标继续由原加载方法拥有，bodyRanges 只是传输方式。

- [ ] **Step 1：写成功项保留与迟到冲突测试。** 同一批包含成功、404、409；仅当前 409 项失效。再构造旧批迟到失败、新单项已完成的情况，断言新记录仍在；构造手动点击与批量同 id 只发一个有效读取任务。

```ts
// 使用 Task 3 fixture.calls 记录 {operation,input}，不记录 HTTP URL。
await store.readRequests([1, 2]);
expect(fixture.calls.filter(call => call.operation === 'readings')).toHaveLength(1);
expect(fixture.calls.filter(call => call.operation === 'detail')).toHaveLength(0);
expect(store.peekRequest(1)?.token).toMatch(/^r1-[0-9a-f]{64}$/);
expect(store.peekRequest(1)?.meta).not.toBeNull();
```

fixture 需扩展为至少两笔已知合成请求，并配置逐项错误。执行新增 reader-store 用例，预期缺 readRequests 失败。

- [ ] **Step 2：合入函数捕获每项读取资格。** 发起前取得 epoch、rec、rev、旧 token；响应先验证整批 index、requested id、成功 canonical/token 与区间是否对应；只在资格仍相等时同步写 detail/meta/messages。批次成功不递增证据身份。响应重排按 index 整理；重复或缺失 index 报 invalid_response，整批不写入。
- [ ] **Step 3：循环后缀与去重在途。** next_index 只能推进未完成输入，下一轮重新捕获资格。一个批次覆盖的记录先登记共享任务，单项消费者等待该任务；单项结束只释放自己的 inflight。重复 id 去重后再映射回调用顺序，别名 canonical 归并沿用原规则，不建立第二份长期记录。

adapter 编码后用 `TextEncoder` 检查完整 URL 是否超过 16 KiB，未发 Fetch 就抛 batch_too_large；store 将该批按输入个数折半，至少一项，使用相同资格重新排队。服务端 414 同样映射 batch_too_large。单项仍超限时报 invalid_input，不无限二分、不自动扩大服务器上限。64 个长 token 区间必须有实际编码长度测试。条数分块与 URL 编码分别由 store 和 adapter 拥有，store 不学习 URL。
- [ ] **Step 4：批量正文区间复用原 delta 打包。** 从 `runDelta` 提取纯区间构造到 body-model 或 reader-store 内部共用函数，仍按连续/稀疏跨度与 PAGE_MAX 规则生成。成功区间先核对所需 ord 全到齐，再推进相应 delta 计数；结构连续上界不因定点或 delta 更新。每请求每轮最多两片、准备总共 20 片保持；任务去重不让两个消费者各推进一次。
- [ ] **Step 5：prepareWindow 保留目标优先。** 先独立准备目标组；其余按最多 32 笔读取块获取 bundle，再通过有界区间块与窗口内依赖批完成。块内准备资格仍逐组判断，完成一块聚合一次 onPrepared。不把所有后继任务预排进有限队列。依赖失败降级与版本变化重新准备继续生效。
- [ ] **Step 6：明确失败策略。** 不支持能力只有显式说明时才走原单项路径；当前同版本生产与合成服务器都支持批次，不新增版本探测重试循环。oversized 项可走旧单项，统计回退次数；503、401、网络断开不展开成单项风暴。失败保留旧显示与现有重试入口。
- [ ] **Step 7：执行 store/准备最窄回归与类型检查，补合成浏览器目标优先、追加中点选、A→B 和取消。** 同步准备与版本守卫 note，运行 notes 门禁，提交 `perf(reader): prepare windows with bounded batch reads`。

## Task 6：依赖感知显示模型与增量提交

**Files:** 新建 `web/trace-model.js`、`tests/trace-model.test.ts`；修改 `web/app.js`、`web/reader-store.js`、`web/trace-view.js`、`web/session-view.js`、`web/trace-dom.js`、`src/http.ts`；修改对应 trace/anchor/web 测试。

**Interfaces:** RequestRead 新增只读 `contentRevision:number`；store 还提供窗口/会话数据修订，作为本地计算失效依据。`createTraceModel({project,projectTail})` 返回 `update({rows,reads,ready,bgJobs,complete,changedIds})`、`get(id)`、`reset()`；project/projectTail 是实际纯投影 adapter，用于已有步骤和尾部投影，测试可注入计数。get 返回现有 `{steps,stale,placeholder}` 与 tail，不携带 DOM/URL。依赖来自真实前驱和工具 owner，不由调用者手写缓存键。

- [ ] **Step 1：写未变化旧组不重复投影的测试。** 使用合成行与读取快照，从项目现有 trace fixture 构造；project 和 projectTail 注入计数函数。

```ts
import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { listRequests } from '../src/queries/requests';
import { getReadingDetail, getReadingBody } from '../src/reading';
import { projectSteps, projectTailReply } from '../web/trace-view.js';
import { createTraceModel } from '../web/trace-model.js';

test('不变输入复用旧组投影', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {convKey: 'model-synthetic',
      messages: [], cleanGroup: true, purposePending: 0});
    const rows = listRequests(f.store, 'model-synthetic').items;
    const snapshot = {
      status: 'fresh', detailError: null, contentRevision: 1,
      token: getReadingDetail(f.store, id)!.reading_token,
      detail: getReadingDetail(f.store, id),
      meta: getReadingBody(f.store, id, 0, 0, null),
      messages: new Map(), entries: [],
      structure: {back: 0, next: 0, total: 0, ords: [], loading: false, error: null},
      delta: {next: 0, done: true, loading: false, error: null, unconfirmed: false},
    } as const;
    let calls = 0;
    const model = createTraceModel({
      project: (...args: Parameters<typeof projectSteps>) => {
        calls += 1; return projectSteps(...args);
      }, projectTail: projectTailReply,
    });
    const input = {rows, reads: new Map([[id, snapshot]]), ready: new Set([id]),
      bgJobs: [], complete: false};
    model.update({...input, changedIds: [id]});
    expect(calls).toBe(1);
    const before = model.get(id);
    model.update({...input, changedIds: []});
    expect(calls).toBe(1);
    expect(model.get(id)).toBe(before);
    model.reset();
  } finally { f.close(); }
});
```

上述快照按现有 RequestRead 契约构造，若类型检查指出新增必填字段，按 store 公开快照补齐，禁止用 `any` 绕过。再验证相同 token 的消息新增必须投影、前驱 System 变更只更新对应后继、工具 owner 变化影响结果组、成本/时间字段变化更新行但不换 token、选择变化不更新证据修订。

- [ ] **Step 2：维护本地内容修订。** mergeMessages 真有新项、detail/meta/状态/结构/delta 变化时推进对应记录 contentRevision；loading 若影响显示也必须记录，单纯 peek 不推进。消息排序按消息集合变化缓存。不要复用仅作废时才变化的 rec.rev，也不以 reading token 代替已加载内容修订。
- [ ] **Step 3：迁移现有保留投影。** 把 stepsOf/tailOf 的三态与 retainedSteps/retainedTail 所有权移入 trace-model，app 不再另持相同缓存。输入 reads 为当前 store 快照，model 只保留最近一次显示版本；读取无变化时重用步骤对象。旧投影引用旧身份，stale 时不回退到新 owner 摘要。
- [ ] **Step 4：建立反向依赖与线性索引。** 每组记录已确认前驱、tool_results resolved owner 与背景作业输入；变更时删除旧边再加新边。窗口变化一次建立 reqId→ordinal 与 Set；tailEligibleIds 改为单次后向扫描并用既有测试对照。会话头时间统计与隐藏项索引仅在输入变化重建。bgJobs 变化可以使相关组或当前窗口全部失效，但仅该事件发生时执行，不每笔准备都重算。
- [ ] **Step 5：减少 HTML 生成和重复提交计划。** app 使用稳定组模型缓存行 HTML，显示数据、依赖摘要与序号变化才重建；selectedStep 不进 HTML 缓存键。trace-dom.commit 返回 `'clean'|'selection'|'structural'`，clean/selection 不执行全栏折叠恢复与布局读取，结构路径只计算一次行计划并使用原同步锚点恢复。相同 token 下来源坐标变化仍更新交互数据，不能只比较可见文字。
- [ ] **Step 6：合并通知但不延迟锚点补偿。** 默认一准备块一次提交；若同 tick 多事件合并，只有一个待执行刷新，退出时取消。选择即时走现有高亮路径；锚点捕获和补偿仍在一次同步 commit 内，不跨 rAF。
- [ ] **Step 7：执行 `bun test tests/trace-model.test.ts tests/trace-view.test.ts tests/trace-commit.test.ts tests/trace-anchor.test.ts tests/trace-preparation.test.ts tests/web.test.ts`。** 合成浏览器验证原节点、焦点、文本选择、下方追加与窄屏锚点；若因迁移新增静态文件，白名单同步。补 note 与架构事实，运行 notes 门禁，提交 `perf(trace): reuse projections by content revision and dependencies`。

## Task 7：接入规则、可观察性与整体验收

**Files:** 修改 `AGENTS.md`、`docs/read-feature-rules.md`、`docs/architecture-design.md`、`docs/acceptance.md`、本提案及部分取代的 note；新增 `scripts/perf-reader.ts` 与 `tests/read-boundaries.test.ts`，必要时复用现有 capacity 脚本。

**Interfaces:** `perf-reader.ts` 只使用合成独立端口与临时目录，输出固定操作名、请求数、排队/执行时间、字节及取消；浏览器指标由真实浏览器采集，不用脚本估计。前端诊断在内存有界汇总，不输出输入参数。

- [ ] **Step 1：建立一个能阻止旁路复发的窄检查。** 使用 Bun 文件读取查 web 运行文件中的原生 fetch 调用；允许列表仅 read-http.js，app 可把 fetch 作为构造注入值，不能调用。注释和字符串不作为证据；使用 TypeScript 现有 parser AST 查直接调用、全局属性和字符串下标调用。生产模块不另定义同名 fetch 函数，避免掩盖检查。测试失败明确指出文件和行。

```ts
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

test('生产读取不绕过 HTTP adapter', () => {
  const violations: string[] = [];
  for (const name of readdirSync('web').filter(name => name.endsWith('.js'))) {
    if (name === 'read-http.js') continue;
    const path = `web/${name}`;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        const direct = ts.isIdentifier(target) && target.text === 'fetch';
        const property = ts.isPropertyAccessExpression(target)
          && ts.isIdentifier(target.expression)
          && ['window', 'globalThis'].includes(target.expression.text)
          && target.name.text === 'fetch';
        const indexed = ts.isElementAccessExpression(target)
          && ts.isIdentifier(target.expression)
          && ['window', 'globalThis'].includes(target.expression.text)
          && ts.isStringLiteral(target.argumentExpression)
          && target.argumentExpression.text === 'fetch';
        if (direct || property || indexed) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${path}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
```

AST 检查只拦截已知直接旁路，不冒充信息流证明。契约测试和 review 继续检查 URL 外泄、第二份证据缓存与无界任务。

- [ ] **Step 2：在项目 AGENTS.md 加一条读取接入入口。** 规则正文只保留 docs/read-feature-rules.md 一个家；待 Task 1–6 交付后移除该文件草案标记，并在架构文档记录已交付 Interface、owner、错误和预算。当前提案只按交付范围转 implemented，未交付的 macOS 宿主与后台分支另留 proposed，不把未来目标写成当前能力。
- [ ] **Step 3：合成验收按规模执行。** 30、364、2,500 笔、单笔超大回复、稀疏增量、多 actor、未知归属、正文回收、纯派生修订、别名合并都用独立合成库。记录首个可读片段、全部加载、用户点选、响应字节、解析、投影、DOM、长任务和堆。额外读数不能高频调用重型 ingest-metrics 扰动实验。
- [ ] **Step 4：核对性能评估的目标与失败分支。** 364 笔争取全过程 Fetch≤30，但不能以超大响应实现；2,500 笔建议完整加载累计≤30秒、GC后峰值与退出残留按评估记录。HTTP p95 与 event loop p99 沿用100ms目标，秒级尖刺另报。原合成容量门禁继续执行其 offered rate 和守恒要求，不降低负载伪装通过。
- [ ] **Step 5：完成 macOS 准备的契约验收。** 在无 document、无 location、无 global fetch 的 Bun 测试中通过内存 adapter 执行 store 与投影；通过 HTTP adapter 的绝对 loopback baseUrl 与 header provider 测试；JSON 序列化往返保持 DTO、null 与未知状态，AbortSignal 不进入载荷。以上证明可替换读取来源，不等于桌面打包、Swift 客户端或 IPC 已验收。
- [ ] **Step 6：真实流量只读复测。** 实施及生产复测另获授权后，使用原报告对应会话和浏览器交互；记录同页切换、无 session 历史、整页导航、pageshow.persisted 与 GC前后引用。另补 summary entries、工具结果页签、费用四态。写入 acceptance，区分合成、真实、失败和未覆盖。
- [ ] **Step 7：运行剩余必要检查并提交。** `bun test tests/read-boundaries.test.ts`、`bun run typecheck`、`bun run verify:notes`；不重复前面输入未变的已通过测试。提交 `docs(read): enforce feature onboarding rules and record architecture acceptance`。若性能分支未达标，标题和验收记录不能宣称整体完成。

## 评审后的执行方式

本计划按 Task 逐项实施，每项保留独立 review 和提交。可以在当前会话顺序完成，也可在获准后每项交给一个执行 Agent；默认顺序执行，不需要为小型步骤展开多 Agent 工作流。执行方式不影响同一完成标准，也不产生额外生产授权。

## 自检覆盖

| 提案要求 | 对应任务 |
| --- | --- |
| 具名读取、可序列化契约与 HTTP/fixture adapter | Task 1 |
| 有界并发、待发、公平性与取消 | Task 2 |
| 所有 feature 入口、统计/弹窗、owner退出 | Task 3 |
| 同快照、有界批次与正文准备复用 | Task 4 |
| 原子合入、迟到守卫、两套游标与目标优先 | Task 5 |
| 内容修订、依赖失效、稳定显示与增量计算 | Task 6 |
| 新 feature 规则、架构检查、诊断与多规模验收 | Task 7 |
| macOS 可复用范围与明确未实现能力 | Task 1、3、6、7及架构提案 |
| 单组阻塞与DOM未达标分支 | 独立性能评估，达到条件后单独方案 |

本文为评审稿，未执行上述复选框、未创建实现 worktree、未运行应用测试、未提交或部署。定义的目标文件和函数是实施目标，不能当作仓库已经提供的 Interface。
