# 正文与关联派生实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存可还原的脱敏协议对象，让真实页面按请求和对话阅读正文，并在迟到、重复和父子代理交错时收敛。

**Architecture:** 薄 hook 在请求期生成交换 ID，在完成期向 collector 投递；collector 事务内保存正文块、骨架和证据后确认。response ID 只做可核验关联，派生按同会话同 actor 稳定排序，未知归属不猜。

**Tech Stack:** Bun 1.4.0、TypeScript、`bun:sqlite`、`node:crypto`、`node:zlib`、原生 JavaScript。

**Spec:** [architecture-design.md](../../architecture-design.md) 第 2 步；[实施总入口](2026-10-20-collector-implementation.md)；前置完成 [A 阶段](2026-10-20-collector-foundation.md)。

## Global Constraints

- envelope `64 MiB`，request/reply 分别 `32 MiB`；尺寸按 UTF-8 字节，不按字符串字符数。
- 脱敏先于持久化和哈希；完整消息字节 sha256，不剥 `cache_control`。
- zstd level 3 用 `{params:{[constants.ZSTD_c_compressionLevel]:3}}`；不用无效的 `{level:3}`。
- `raw_hook` 正文副本在块与骨架成功提交的同一事务清空；所有存活副本计入正文预算。
- `anthropic/chat` 解析；`responses/gemini` 保存原对象并标 unsupported。
- hook 只接受本地独立令牌，认证后检查 `origin=local`；不接受时间近邻关联。
- AVA 保持并行，collector `gatewayTimeoutMs` 不超过 2000；接生产 hook 前须满足 C 的容量保护前置门槛。
- 不导入 AVA 历史，不改上游，不发起模型请求来伪装验证。

---

## B1：稳定脱敏与可还原内容库

**Files:** Create `src/body.ts`, `tests/body.test.ts`, `tests/privacy.test.ts`; Modify `src/privacy.ts`, `src/config.ts`。

**Interfaces:**
- Consumes: A1 `Store`、A3 `redact(value,salt,rules)`。
- `persistBody(store:Store, reqId:number, body:BodyInput): void`。
- `restoreBody(store:Store, reqId:number): BodyInput | null`。
- `BodyInput = { protocol:string; request:unknown; reply:unknown; redact_version:number }`。
- `redact` 同值同类凭证在同一个 salt 下生成相同占位符；规则版本固定为数字 1，后续修改必须升版。

- [ ] **步骤 1：写凭证不残留且字段不误伤的检查。**

```ts
import { expect, test } from 'bun:test';
import { redact } from '../src/privacy';
test('脱敏工具参数字符串并保留 token 计数和关联 ID', () => {
  const input = {
    usage: { input_tokens:123, output_tokens:45 },
    tool_call_id:'call_demo', tools:[{name:'lookup',input_schema:{type:'object',properties:{token:{type:'string'}}}}],
    arguments: JSON.stringify({headers:{authorization:'Bearer synthetic-secret-123'}})
  };
  const salt = new Uint8Array(32).fill(7);
  const a = redact(input,salt) as typeof input;
  expect(JSON.stringify(a)).not.toContain('synthetic-secret-123');
  expect(a).toEqual(redact(input,salt));
  expect(a.usage).toEqual(input.usage);
  expect(a.tool_call_id).toBe('call_demo');
  expect(a.tools).toEqual(input.tools);
});
```

上例断言仅用于已知形状的合成fixture，随后的字段断言验证结构未改变；生产入口仍以unknown接收并逐字段校验，不把模块设为any。

- [ ] **步骤 2：运行 `bun test tests/privacy.test.ts tests/body.test.ts`，缺少字符串 JSON 脱敏或内容还原时应失败。**

- [ ] **步骤 3：实现稳定占位符、消息块和骨架。** 数据目录 salt 32 随机字节，首次 `open` 使用 `wx`、0600，已存在读取复用，禁止每次启动重建。占位符格式 `[redacted:<class>:<hmac-prefix>]`，HMAC 输入包含凭证类别和值。递归遍历结构，同时尝试解析工具参数内的 JSON 字符串；解析失败时只做字符串模式替换，不能丢整段参数。ID 路径先保留，敏感路径显式列出；已脱敏占位符再次处理必须不变。

```ts
import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
const compress = (bytes: Uint8Array) => zstdCompressSync(bytes, {
  params: { [constants.ZSTD_c_compressionLevel]: 3 }
});
const serializeMessage = (message: unknown) => Buffer.from(JSON.stringify(message));
const hashMessage = (message: unknown) => createHash('sha256').update(serializeMessage(message)).digest();
```

骨架用显式字段 `{format:1,protocol,request_without_messages,reply,redact_version,has_messages}`，不在用户对象里塞可碰撞的占位键。request.messages 存在且是数组时逐消息入 block；字符串 content、不认识的多模态块均保留。Anthropic 顶层 system/tools 和 reply 原对象保留骨架，Chat messages 中 system/tool 按原序存块。无 messages 的 unsupported 请求整份存骨架。

`request_block.role` 是阅读辅助枚举；Chat `developer` 映射 system，但块内原角色不改；未知角色保留原值并映射独立 unknown 枚举 4，不能伪装 user。块 sha256 唯一冲突时复用整数 id，引用以 `(req_id,ord)` 幂等；同一消息重复出现两次必须有两条引用。

`persistBody` 在调用方 writer 事务中运行，或自己开启唯一外层事务；统一选择前者时导出一个 `persistBodyTx(db,reqId,body)` 内部函数，公共包装只用于测试/独立维护。正文、引用、骨架和 raw 副本清空一起提交，不能让网络 200 越过提交点。

- [ ] **步骤 4：补深度还原、去重、unsupported 与回滚检查。**

```ts
// tests/body.test.ts：A3 fixture 先建立 req_id=1、2。
const body = {protocol:'anthropic',request:{system:[{type:'text',text:'system'}],messages:[{role:'user',content:[{type:'text',text:'A',cache_control:{type:'ephemeral'}}]},{role:'user',content:[{type:'text',text:'A',cache_control:{type:'ephemeral'}}]}]},reply:{id:'msg_demo',content:[{type:'thinking',thinking:'synthetic'},{type:'text',text:'B'}]},redact_version:1};
persistBody(store,1,body);
persistBody(store,2,body);
expect(restoreBody(store,1)).toEqual(body);
expect(store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({n:1});
expect(store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({n:4});
```

建立请求的 SQL 使用 A1 `request` 必需列：`req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at`，值分别为测试 id、1、`2026-10-20`、`hook`、`pending`、0、1、1、1。另测试同内容但不同 cache_control 产生不同块；Responses/Gemini 原对象无损还原；中途 throw 不留下孤儿块或错误 available。检查 SQLite 文件/WAL 的可解压内容和 API 输出不含合成凭证，不能只检查内存函数结果。

- [ ] **步骤 5：运行 `bun test tests/privacy.test.ts tests/body.test.ts && bun run typecheck` 后提交。**

```bash
git add src/body.ts src/privacy.ts src/config.ts tests/body.test.ts tests/privacy.test.ts
git commit -m "feat(body): persist redacted protocol objects with deduplicated message blocks" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## B2：协议适配与分页正文 API

**Files:** Create `src/protocols.ts`, `tests/protocols.test.ts`; Modify `src/body.ts`, `src/queries.ts`, `src/http.ts`, `tests/http.test.ts`。

**Interfaces:**
- `parseProtocol(protocol:string, request:unknown, reply:unknown): ParsedBody`。
- `ParsedBody = { parse_state:'ok'|'unsupported'|'invalid'; reply_state:'ok'|'absent'|'unsupported'|'invalid'; message_count:number|null; calls:ToolCallView[]; results:ToolResultView[]; response_id:string|null }`。
- `ToolCallView = {id:string; name:string; ord:number; path:string; input:unknown}`；`ToolResultView = {id:string; ord:number; path:string; value:unknown}`。ord 对调用是回复内容中的稳定下标，对结果是请求消息下标，path 区分同消息多个块。
- `getBodyPage(store:Store,id:number,from:number,to:number): BodyPage`。
- `BodyPage = {state:BodyState; parse_state:string|null; reply_state:string|null; from:number; to:number; total:number|null; messages:{ord:number;value:unknown}[]; request_fields:unknown; reply:unknown; reason:string|null}`。
- `body?from=0&to=40` 的区间左闭右开，最大 40 条；默认40，参数非法400，实体不存在404。回收和 pending 返回带 state 的200，不用空数组冒充完整正文。

- [ ] **步骤 1：写 Anthropic 请求有效但回复为空的测试。**

```ts
import { expect, test } from 'bun:test';
import { parseProtocol } from '../src/protocols';
test('请求有效而回复缺失仍可阅读请求', () => {
  const parsed = parseProtocol('anthropic', {messages:[{role:'user',content:[{type:'text',text:'hello'}]}]}, null);
  expect(parsed.parse_state).toBe('ok');
  expect(parsed.reply_state).toBe('absent');
  expect(parsed.message_count).toBe(1);
});
test('未知协议保存能力不被解释成零消息', () => {
  const parsed = parseProtocol('responses', {input:'hello'}, {id:'resp_x',output:[]});
  expect(parsed.parse_state).toBe('unsupported');
  expect(parsed.message_count).toBeNull();
});
```

- [ ] **步骤 2：运行 `bun test tests/protocols.test.ts`，确认缺适配器失败。**

- [ ] **步骤 3：按客户端协议提取辅助视图。** Anthropic 文本、thinking、tool_use、tool_result、顶层 system；Chat 字符串/数组 content、reasoning_content、tool_calls、role=tool 与 system/developer。未知 content type 不解析但保留原对象，显示其 JSON。结构校验失败写 invalid 和明确路径，原合法 JSON 仍可保存；不能因适配器无法识别把完整正文切断。

```ts
const responseId = (protocol: string, reply: unknown): string | null => {
  if (!reply || typeof reply !== 'object') return null;
  const object = reply as Record<string,unknown>;
  const value = protocol === 'gemini' ? object.responseId : object.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
};
```

请求/回复分别判断，不用 `success=false` 覆盖请求状态。unknown 协议的 ID 只能提取已知字段，不能发明。所有 parsed 结果含适配版本，写入 request 长期列。

正文 API 一次只解压目标 ord 的块，单次请求 Map 缓存共享 block；骨架只解压一次。`request_fields` 与 reply 在首片返回，后续片仅消息。协议原文视图按分页重组完整脱敏对象，加载完前标部分加载；没有保存过的响应不能用 DTO 合成。

- [ ] **步骤 4：补两协议工具/多模态/无效对象与性能检查。** 用 526 个块、合计约14.2 MB 的合成请求测完整重建目标 <50 ms；40 条消息分页检查只访问对应 block id，不每次还原全体 messages。检查 0/40、40/80、末页、越界、evicted、unsupported、reply absent，以及同消息内多个 tool_result 的 path。

```ts
const parsed = parseProtocol('chat', {messages:[{role:'tool',tool_call_id:'call_x',content:'done'}]}, {id:'chatcmpl_x',choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_y',type:'function',function:{name:'read',arguments:'{"path":"demo"}'}}]}}]});
expect(parsed.results[0].id).toBe('call_x');
expect(parsed.calls[0].id).toBe('call_y');
expect(parsed.calls[0].input).toBe('{"path":"demo"}');
```

- [ ] **步骤 5：运行 `bun test tests/protocols.test.ts tests/body.test.ts tests/http.test.ts && bun run typecheck` 后提交。**

```bash
git add src/protocols.ts src/body.ts src/queries.ts src/http.ts tests/protocols.test.ts tests/http.test.ts
git commit -m "feat(protocol): parse Anthropic and Chat bodies with paginated reads" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## B3：薄 hook、事务确认与证据关联

**Files:** Create `plugins/collector.hooks.ts`, `src/hook.ts`, `tests/hook.test.ts`; Modify `src/http.ts`, `src/reconcile.ts`, `src/schema.sql`, `package.json`。

**Interfaces:**
- 插件 `onRequest(body:unknown,ctx:HookContext): void`、`onResponse(reply:unknown,ctx:HookContext): Promise<void>`。
- `HookContext = {origin:string;protocol:string;path:string;agent?:string;session?:string;cwd?:string;model?:string;stream?:boolean;request?:unknown;success?:boolean;state:Record<string,unknown>;options:{endpoint:string;token:string;gatewayTimeoutMs?:number};signal:AbortSignal}`；未使用的宿主字段不复制进 envelope。
- `HookEnvelope = {hook_id:string;observed_start_ms:number;observed_finish_ms:number;protocol:string;path:string;agent:string|null;session:string|null;cwd:string|null;model:string|null;stream:boolean;origin:string;success:boolean;request:unknown;reply:unknown;request_bytes:number;reply_bytes:number;body_omitted:boolean;omit_reason:string|null;magpie_version?:string}`。
- `acceptHook(store:Store,envelope:HookEnvelope,now:number): {req_id:number;duplicate:boolean}`；只在已认证和有容量配额后调用。
- `reconcilePending(store:Store,now:number): {merged:number;pending:number;ambiguous:number}`。

- [ ] **步骤 1：写稳定投递 ID 与重复 POST 用例。**

```ts
import { expect, test } from 'bun:test';
import { onRequest } from '../plugins/collector.hooks';
test('请求期只生成采集身份而不改正文', () => {
  const body = {messages:[{role:'user',content:'hello'}]};
  const ctx = {origin:'local',protocol:'chat',path:'/v1/chat/completions',state:{},options:{endpoint:'http://127.0.0.1:8320/hook/ingest',token:'synthetic'},signal:new AbortController().signal};
  expect(onRequest(body,ctx)).toBeUndefined();
  expect(typeof ctx.state.hook_id).toBe('string');
  expect(body).toEqual({messages:[{role:'user',content:'hello'}]});
});
```

测试 ctx 用显式 `HookContext` 标注，避免 `{}` 无索引类型。另将相同 envelope 调用 acceptHook 两次，request/raw_hook/request_block 数量均不增加。

- [ ] **步骤 2：运行 `bun test tests/hook.test.ts`，确认缺 plugin/endpoint 失败。**

- [ ] **步骤 3：实现正确的异步插件入口和有界 POST。** 入口文件必须带 `.hooks.ts` 或 package 的 `magpie.hooks` 指向它，不能用同步 middleware。注册片段只作为文档，不在本任务安装到用户配置。

```ts
export function onRequest(_body: unknown, ctx: HookContext): void {
  ctx.state.hook_id = crypto.randomUUID();
  ctx.state.observed_start_ms = Date.now();
}
// onResponse 读取 ctx.request 和 reply；每次网络重试复用 hook_id。
```

onResponse 记录 finish、序列化 UTF-8 字节数，任一对象超32 MiB或 envelope 超64 MiB则发送完整 metadata envelope：request/reply=null、body_omitted=true、原始大小与 `collector_object_limit|collector_envelope_limit`。绝不字符串截断 JSON。POST endpoint 仅允许配置的 loopback collector `/hook/ingest`；认证头 `Authorization: Bearer <hook-token>`，不写日志。

总投递截止 1500 ms，每次 fetch 上限600 ms，最多2次，第二次仅针对网络失败、408、429、5xx，间隔50 ms；共享总截止及 ctx.signal，剩余时间不足不重试。拒绝4xx不循环。宿主 `gatewayTimeoutMs=2000`，AVA 默认1000并行总预算3000 ms。回调丢失仍 best-effort，不能声称可恢复补投。

HTTP handler 先精确 Host/Origin 与常量时间令牌比较，再 origin 过滤，再流式计 envelope 字节，超过64 MiB取消读取并413；限制同时读取中的 envelope 为1，额外请求429，避免多份大 JSON 占满内存。合法 JSON 内部再校验request/reply大小。坏 JSON400、缺ID422、认证401/403、磁盘拒收507、writer失败503；成功提交200，重放相同ID200+duplicate。

持久化时同事务生成 hook 请求、保存 raw_hook 头、脱敏分块、写证据和 pending；已有关联 ledger 时复用请求。body_omitted 标 partial 和真实原因，have 仍含 hook 位。raw 副本清空后用长期 reply_state 判定缺回复。

- [ ] **步骤 4：实现 response ID 候选关联与原子迁移。**

```ts
const prefixes: Record<string,string[]> = {
  anthropic:['msg_resp_','msg_','resp_','chatcmpl-'],
  chat:['chatcmpl-','msg_resp_','msg_','resp_'],
  responses:['msg_resp_','resp_','msg_','chatcmpl-'],
  gemini:[]
};
// 单次剥离最长匹配前缀；原始 ID 精确匹配优先，规则版本=1。
```

保留原始 ID 与规范化 ID；同原始ID/规范ID多候选标 ambiguous，不按近邻时间强合并；没有ID长期 pending。字段冲突记录候选和原因。hook 暂存 actor=unknown，到账本/路由后才确认。两条 request 合并时以账本请求为保留对象，同事务迁移 evidence、request_block、tool_call、prev引用及 derive_queue，清理临时 hook 请求；原请求URL可通过 `request_alias(old_id PRIMARY KEY,new_id)` 返回重定向标记，页面跟随 canonical id。

测试两个证据顺序、重复 envelope、提交后响应丢失重试、规范ID碰撞、无ID、late ledger，以及 6 MiB request+3 MiB reply、合法4 MiB JSON、超64 MiB、null reply、非local、伪造origin但无token。合并前后守恒：hook证据总数不变、逻辑请求减少1、块引用按同笔正文去重而不丢消息位置。

- [ ] **步骤 5：运行 `bun test tests/hook.test.ts tests/reconcile.test.ts tests/privacy.test.ts && bun run typecheck` 后提交。**

```bash
git add plugins/collector.hooks.ts src/hook.ts src/http.ts src/reconcile.ts src/schema.sql package.json tests/hook.test.ts
git commit -m "feat(hook): ingest authenticated callbacks and reconcile stable evidence" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## B4：前驱、增量、标题与工具往返

**Files:** Create `src/derive.ts`, `tests/derive.test.ts`; Modify `src/reconcile.ts`, `src/hook.ts`, `src/schema.sql`, `src/main.ts`, `src/queries.ts`。

**Interfaces:**
- `compareSequence(previous: readonly number[]|null,current:readonly number[],hasPredecessor:boolean): {relation:'first'|'confirmed'|'unknown';delta:number[]|null}`。
- `enqueueDerive(store:Store,convKey:string,actor:string,fromSort:string):void`。
- `drainDerive(store:Store,limit?:number): {processed:number;remaining:number}`，默认100。
- `deriveTitle(messages:unknown[],delta:number[]|null,fallback:string): {title:string;source:'user_delta'|'model_time'}`。
- `rebuildDerived(store:Store,convKey:string): {queued:number;unavailable:number}`，C2 CLI 复用。

- [ ] **步骤 1：写重复消息与未知前驱测试。**

```ts
import { expect, test } from 'bun:test';
import { compareSequence } from '../src/derive';
test('重复消息仍按位置计新增', () => {
  expect(compareSequence([1,2],[1,2,1],true)).toEqual({relation:'confirmed',delta:[2]});
  expect(compareSequence([1,2],[2,1],true)).toEqual({relation:'unknown',delta:null});
  expect(compareSequence(null,[1,2],true)).toEqual({relation:'unknown',delta:null});
  expect(compareSequence(null,[1,2],false)).toEqual({relation:'first',delta:[0,1]});
});
```

- [ ] **步骤 2：运行 `bun test tests/derive.test.ts`，确认缺序列比较失败。**

- [ ] **步骤 3：实现前缀判定、可恢复批次和标题。**

```ts
export function compareSequence(previous: readonly number[]|null,current:readonly number[],hasPredecessor:boolean) {
  if (!hasPredecessor) return {relation:'first' as const,delta:current.map((_,i)=>i)};
  if (previous === null || previous.length > current.length || previous.some((id,i)=>id !== current[i])) {
    return {relation:'unknown' as const,delta:null};
  }
  return {relation:'confirmed' as const,delta:current.slice(previous.length).map((_,i)=>i+previous.length)};
}
```

按总入口稳定顺序与 `(conv_key,actor)` 找前驱；unknown actor 不串到父代理。当前或前驱正文不可用、unsupported、分支/裁剪或结构指令变化无法确认时标 unknown，不能伪造新增。插入、关联、正文到达、归属改变后，把原组与新组受影响起点加入 derive_queue；每批100笔，提交派生与队列检查点同事务，进程中断后继续。不能以一批上限停止整条链。

标题取第一个确定新增 USER 文本的首行，去 system-reminder/command标签、工作目录包装，再压空白取60 Unicode字符；无可用用户增量时用模型与本地HH:MM，并保存 title_source。日期按配置固定时区（默认机器当前 IANA 时区，在库创建时保存），不能重启后因系统时区变化静默改历史day。

工具调用从回复提取，结果来自后续请求；`call_id` 只在同conv/actor范围比较。重复上下文中相同结果不是新工具结果，优先限定已确认delta中的 ord；unknown delta则仅建立候选，不标 resolved。重复 call_id 对多个发起请求保持 ambiguous，不挑最近一个。

`tool_call` 增加 `result_path TEXT`，因为同消息可有多个 tool_result；增加 `derive_version INTEGER NOT NULL DEFAULT 1`。反向到达的结果通过读取持久化正文重新派生，无需再建一套独立工具事件日志。raw过期不影响仍存的正文重算；正文回收后不删除既有工具关系。

- [ ] **步骤 4：写顺序无关与队列恢复测试。** 合成A→B→C与A→C→B、迟到hook、归属变化得到同样的稳定键/标题/增量/工具链接（比较稳定证据键，不能比较自增req_id）。构造父P、子S1、子S2共享session且均使用call_x，结果只能在各actor内配对；hook未关联前不能先配父工具。构造250笔链，处理100后关闭重开，最后queue为空且250笔版本一致。

```ts
// 三个输入序列的预期结果，与到达顺序无关。
const sequences = [[1,2],[1,2,3],[1,2,3,4]];
expect(compareSequence(sequences[0],sequences[1],true).delta).toEqual([2]);
expect(compareSequence(sequences[1],sequences[2],true).delta).toEqual([3]);
// 集成测试分别按 [0,1,2]、[0,2,1] 摄入并排空 derive_queue，比较上述结果。
```

- [ ] **步骤 5：运行 `bun test tests/derive.test.ts tests/hook.test.ts tests/protocols.test.ts && bun run typecheck` 后提交。**

```bash
git add src/derive.ts src/reconcile.ts src/hook.ts src/schema.sql src/main.ts src/queries.ts tests/derive.test.ts
git commit -m "feat(derive): converge actor-scoped deltas and tool relationships" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## B5：正文阅读与真实对话视图

**Files:** Modify `web/app.js`, `web/index.html`, `src/queries.ts`, `tests/web.test.ts`; Create `tests/body-api.test.ts`。

**Interfaces:**
- Consumes: B2 `BodyPage`、A4 `RequestDetail`（增加工具配对数组 `tool_calls: {call_id:string;ord:number;result_req:number|null;result_ord:number|null;result_path:string|null;state:string}[]`）。
- Produces: `loadBody(id:number,from:number):Promise<BodyPage>`；页面可按40条继续加载，详情和正文请求分别缓存。

- [ ] **步骤 1：写回收/未支持状态不显示空对话测试。**

```js
const fake = async url => Response.json(String(url).includes('/body')
  ? {state:'evicted',parse_state:'ok',reply_state:'ok',from:0,to:0,total:80,messages:[],request_fields:null,reply:null,reason:'budget'}
  : {req_id:1,title:'history',body_state:'evicted',have:7});
const reader = createReader(fake);
await reader.selectRequest(1);
const page = await reader.loadBody(1,0);
expect(page.state).toBe('evicted');
expect(page.reason).toBe('budget');
```

在 `createReader` 的返回类型补 `loadBody`；列表切换不能触发全部正文下载。

- [ ] **步骤 2：运行 `bun test tests/web.test.ts tests/body-api.test.ts`，确认正文加载尚未接入。**

- [ ] **步骤 3：替换原型派生和协议假设。** 删除生产代码中的 `hashMsg/previousOf/newSet` 和fixture `newMsgs`依赖，消费服务端 `prev_relation/delta_ordinals`。confirmed/first才展示确定新增；unknown显示完整请求入口和原因，不拼出假对话。按可见请求加载正文首片，点击工具结果再加载对应请求/消息区间，不为1,825笔一次下载全量。

```js
function usageLabel(value) { return value === null ? '未报告' : String(value); }
function relationLabel(relation) {
  return relation === 'unknown' ? '无法确认与上一笔的新增关系' : '';
}
function bodyLabel(page) {
  if (page.state === 'evicted') return `正文已回收：${page.reason}`;
  if (page.state === 'unsupported') return '原对象已保存，暂不支持结构化解析';
  if (page.reply_state === 'absent') return '已保存请求，上游未提供可用回复';
  return '';
}
```

`requestBody/replyBlock/rawBlock/items` 支持 Anthropic块数组与Chat形状；保留协议路径。工具卡遍历所有call与result，不只展开第一个结果。unknown多模态/推理块以转义JSON展示。请求字段和reply保持脱敏原文，不能生成`demo-response-*`。所有可折叠行使用button、键盘可操作、aria-expanded，窄屏不溢出。

- [ ] **步骤 4：合成浏览器验收。** Anthropic与Chat各覆盖：纯文本、工具往返、多工具、thinking/reasoning、空reply、partial、unsupported、unknown前驱、父子代理、body evicted。快速切换请求与加载下一片，迟到网络响应不能覆盖当前详情。刷新URL保持选择，合并后的旧req id能跳到canonical id。检查XSS载荷、40条分页、超大单条消息和400px布局。

```bash
bun test tests/web.test.ts tests/body-api.test.ts tests/derive.test.ts
bun build web/app.js --target browser --outfile /tmp/collector-app-check.js
bun test
bun run typecheck
```

- [ ] **步骤 5：通过后提交。**

```bash
git add web/app.js web/index.html src/queries.ts tests/web.test.ts tests/body-api.test.ts
git commit -m "feat(reader): render real protocol bodies and converged conversation views" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## B 阶段验收与生产接入前置

- [ ] 合成链路中，hook接受、脱敏、分块、关联、派生、查询和页面全部贯通；稳定ID重复投递无副作用。
- [ ] 6 MiB请求+3 MiB回复合法，超限明确降级或拒绝，坏JSON不落半截正文。
- [ ] 两协议、unsupported、null回复各自准确；raw副本清空不改变reply_state。
- [ ] 重复消息、乱序、迟到结果、父子代理、250笔派生批次恢复全部通过。
- [ ] 526块完整重建本机目标 <50 ms，报告样本大小、p50/p95和峰值RSS；大envelope并发拒绝可观测。
- [ ] 生产hook上线前先完成C1的写前容量保护及C2的备份/恢复演练，避免第一天真实正文无预算保护。
- [ ] 用户已明确推理正文保留策略。若选择不保留，先在redact之后、分块之前移除协议对应推理正文并记录`reasoning_body_omitted=policy`；token计数仍保留，原对象视图注明策略删减。选择保留则继续使用本计划无损对象语义。
- [ ] 然后按C3注册collector，与AVA并行观察；本阶段不下线AVA。

## 上游契约依据

沿用总入口的 `开源源码@magpie-2374ffe`。关键位置：`internal/plugin/gateway.go:77`、`internal/plugin/host.js:1315` 与 `:1357` 定义ctx和完成回调，ctx没有route_id、统一时间戳或宿主稳定ID；`internal/plugin/host.js:1224` 与 `docs/subsystems/gateway-request-hooks.md:22` 定义`.hooks.ts`入口与必须存在的onRequest。`internal/gateway/gateway_hooks.go:39`负责合并回复，回复ID不能承诺所有场景都与账本一致。

所有本地观察时间只表示collector观察时间，不伪装网关时间；hook的ctx.request是异步hook链接受后的客户端对象，后续middleware与上游转换仍可修改。
