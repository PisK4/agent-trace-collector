# ATC 请求用途与主链语义实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 技能以执行会话可用列表为准；缺少时按同样测试与复核执行。本文件只定义实施顺序，不授权真实库迁移、服务切换、push 或提交。复选框全部未勾选，勾选只表示执行者完成了该步。

**Goal:** 把请求用途做成版本 2 的显式派生结果，让分类器、来源类别、标题兼容和未知用途共用一套状态、CAS 写入和主链语义，派生、查询与页面不再各自猜。

**Architecture:** 纯函数模块 `src/semantics.ts` 只解释一笔已读出的请求视图；`src/request-purpose.ts` 提供 `drainRequestPurposesTx`，在 C 的 `drainDeriveTx` 同一同步写事务内选择 pending、读取正文、按 epoch/revision/target 做单笔 CAS，并在用途实际改变时标脏所属组。Store 版本 `drainDerive` 只做唯一 write wrapper，组内有 pending 用途时保持 dirty 不发布；derive、queries、web 只消费已存的 `purpose_*`、`req_kind`、`model_title`。

**Tech Stack:** TypeScript、Bun 1.4.0、bun:sqlite、node:zlib、node:crypto；无新增运行依赖。

**Spec:** [架构演进 v2](../../architecture-evolution-v2.md)、[请求类别联合评审](../../agent-request-kind-review.md)、[auto mode 分类器研究](../../auto-mode-classifier-research.md)、[A 完整派生](2026-10-22-atc-derive-correctness.md)、[C 长期事实与显式重建](2026-10-22-atc-durable-rebuild.md)。

## Global Constraints

- 单进程、SQLite WAL、同步单 writer；用途阶段与组阶段共用 `drainDeriveTx` 的同步写事务，Store 版本 `drainDerive` 是唯一 write wrapper，不新增旁路写入入口。
- 监听固定 127.0.0.1；数据目录在仓库外且 0700，文件 0600；正文先脱敏再保存。
- 测试只用合成库、合成身份、临时目录；不写入真实请求体、账号、token、host 或用户配置。
- 不新增第三方运行依赖；不修改 `.agents/notes/archived/`。
- D 不新增 schema 列、不写迁移、不改 `block.fingerprint`；所有 `purpose_*`、`input_*`、`derive_queue` 列由 C 的 v5 契约提供。
- D 不建立第二个用途写入者；C Task 4 的兼容用途阶段由本计划整体替换。
- 未归属 actor 仍要完成用途，但不创建组、不写 actor 哨兵。
- 未知 `req_kind`、`chain_role` 原样保留；没有命中规则的用途默认参与链。
- 旧 `purpose_version=1` 的 clean 行不因普通 tick 被改写；只有显式 `rebuild --session` 才把该会话的 target 升到 2。

---

## 基准、依赖与前置检查

文档基准 `00e20a2`。A 与 C 是本计划的实施前提：A 提供统一同步 `drainDerive`、`DeriveScope` 与 `DrainResult`；C 提供 v5 存储、`drainDeriveTx` 事务 seam、`drainLegacyPurposeTx` 兼容阶段、`markRequestInputTx`、`markGroupDirtyTx`、`markRequestGroupsTx` 和查询 `derived_state`。文档提交时 HEAD 仍是派生改造前的代码，因此执行者先做下列检查，缺一即停，不要按不存在的签名写代码。

```bash
cd /Users/pis/workspace_intelligence/creator-intelligence/repos/agent-trace-collector
grep -n "export type DeriveScope" src/derive.ts
grep -n "purpose_target" src/schema.sql
grep -n "export function markRequestInputTx" src/derive-state.ts
grep -n "export function markGroupDirtyTx" src/derive-state.ts
grep -n "export function markRequestGroupsTx" src/derive-state.ts
grep -n "export function drainDeriveTx" src/derive.ts
grep -n "drainLegacyPurposeTx" src/derive.ts
bun test
bun run typecheck
```

Expected: 前七条都能命中；测试与类型检查通过。缺少 A 或 C 时先完成对应计划，再回到本文件。D 的测试失败若来自缺列或缺 helper，属于前置未完成，不是 D 的实现问题。

## C 的共享契约（D 只消费）

D 使用的 request 列，全部来自 C 的 v5 增量，不再定义同名或近似字段：

```sql
input_epoch TEXT NOT NULL DEFAULT ''
input_revision INTEGER NOT NULL DEFAULT 0
purpose_revision INTEGER NOT NULL DEFAULT -1
purpose_target INTEGER NOT NULL DEFAULT 1
purpose_version INTEGER
purpose_pending INTEGER NOT NULL DEFAULT 1
purpose_status TEXT NOT NULL DEFAULT 'missing'
purpose_rule TEXT
purpose_signals TEXT NOT NULL DEFAULT '[]'
purpose_chain TEXT NOT NULL DEFAULT 'participate'
purpose_retry INTEGER NOT NULL DEFAULT 0
req_kind TEXT
model_title TEXT
source_facts_json TEXT
```

C 的 helper 签名冻结为：

```ts
export function markRequestInputTx(db: Database, reqId: number): void;
export function markGroupDirtyTx(db: Database, convKey: string, actor: string, fromSort: string): void;
export function markRequestGroupsTx(db: Database, reqId: number): void;
export type DeriveScope = { convKey: string };
export type DeriveTxOptions = { limit: number; scope?: DeriveScope; purposeLimit?: number };
export function drainDeriveTx(db: Database, options: DeriveTxOptions): DrainResult;
export function drainDerive(store: Store, limit?: number, scope?: DeriveScope): DrainResult;
```

`markRequestInputTx` 增加 `input_revision`、重置 `purpose_pending=1` 与 `purpose_retry=0`，并按 owner 标脏组。D 不再实现第二份修订逻辑。`drainDeriveTx` 是唯一同步写事务 seam，`drainDerive` 只做参数验证并包一层 `store.write`；C 的兼容阶段 `drainLegacyPurposeTx(db, limit, scope?)` 由 D 以同位置、同 scope 形状的 `drainRequestPurposesTx(db, limit, scope?)` 替换，迁移的 `purpose` 阶段与最终 `stage=drain` 循环都调用同一入口，未知 actor 的用途因此不会被组枚举漏掉。scope 始终是 `DeriveScope` 对象，不写成字符串。替换后的 `drainRequestPurposesTx` 返回 `PurposeDrainResult`，C 的 `drainDeriveTx` 与迁移 `purpose` 阶段用 `.processed` 表示本批尝试数、`.remaining` 表示该 scope 内仍 pending 的请求数，不把返回值当单个数字。`drainDerive` 在 A 的 `DrainResult` 上增加：

```ts
purpose_processed: number; // 本批尝试结算的 pending 请求数，含失败尝试
purpose_remaining: number; // 当前 scope 内仍 pending 的请求数
```

`remaining` 仍是 dirty 组数。查询侧 `derived_state` 取 `current | dirty | retained | legacy`，由 C 计算；D 只把用途字段加入读模型，不重写 dirty 判定。

D 只读 `source_facts_json.kinds` 的 `{state, value}`，不解析 `ledger`、`route` 的完整集合。`state` 为 `single` 或 `agree` 且 `value` 非空时才作为用途信号；`conflict`、`missing`、`invalid`、`overflow` 只记录信号，不排除链。D 不在 `SourceFacts` 上增加字段。

C Task 4 的兼容用途阶段（legacy title/chat 写入）在本计划 Task 3 删除，保留它的组跳过语义与 `purpose_processed/purpose_remaining` 返回字段，不保留第二个写入者。

## D 的冻结语义

### 状态

| 情况 | status | version | chain | kind | rule |
| --- | --- | --- | --- | --- | --- |
| Claude 分类器强指纹 | recognized | 2 | exclude | auto-mode-classifier | claude.auto-mode-classifier.v1 |
| 来源 kind 为 title | recognized | 2 | exclude | title | source.kind.v1 |
| 来源 kind 为其它非空值 | recognized | 2 | participate | source:<value> | source.kind.v1 |
| 标题回复或已存 title | recognized | 2 | exclude | title | title.reply.v1 或 title.stored.v1 |
| 正文可读且无规则 | unrecognized | 2 | participate | chat | null |
| 正文不可读且有旧解释 | retained | 旧值 | 旧值 | 旧值 | 旧值 |
| 正文不可读且无旧解释 | missing | null | 旧 chain 或 participate | 旧 kind 或 chat | null |
| 协议不支持或请求形状非法且无旧解释 | unsupported | null | 旧 chain 或 participate | 旧 kind 或 chat | null |
| 读取或解释抛错，重试未达上限 | error | 不变 | 不变 | 不变 | 不变 |
| 抛错达到 3 次 | error | 不变 | 不变 | 不变 | 不变，pending 清零并消费当前修订 |

规则优先级固定为：分类器强指纹 > 来源 kind > 标题兼容 > 兜底。分类器必须同时满足 `agent='claude'`、system 文本包含 `security monitor for autonomous AI coding agents`、`stop_sequences` 包含 `</block>`；消息数 2、工具数 0 只写形状信号，不作为门槛。普通对话恰好回复 `<block>no` 不分类，OMP 或未知 agent 即使文本相同也不分类。

来源 kind 只承认精确值 `title` 为标题别名，其它值一律变成 `source:<value>` 并参与链，不因来源值任意排除链。来源冲突或缺失时回落到标题兼容。标题兼容先看回复形状，再看已存 `req_kind='title'`；已存 title 在回复不再是标题形状时继续保留旧 `model_title`。正文不可读时先保留旧解释，来源 kind 只用于没有旧解释的行；否则正文回收后的分类器会被一条普通来源 kind 覆盖。

`purpose_signals` 使用下列稳定代码，顺序为判定顺序：

- `classifier.agent.claude`
- `classifier.system.security-monitor`
- `classifier.stop.block`
- `classifier.shape.messages2`
- `classifier.shape.tools0`
- `classifier.verdict.pass`、`classifier.verdict.block`、`classifier.verdict.unknown`
- `source.kind.single`、`source.kind.agree`、`source.kind.title`
- `title.stored`、`title.reply.title-tag`、`title.reply.json-title`
- `body.missing`、`body.unsupported`、`body.invalid`
- `purpose.retained`、`purpose.error`

### 版本与目标

`PURPOSE_VERSION=2`。tick 处理的所有 pending 行直接按版本 2 解释，并在成功或终态错误写回时把 `purpose_target` 设为 2。历史 clean 行保持 `purpose_target=1` 与旧 `purpose_version`，查询继续可读，但无法声称已按 2 复核。显式 `rebuild --session <key>` 先把该会话 `purpose_target<2` 的行改为 `pending=1,retry=0,target=2`，再排空；不改 version/status/rule/kind/chain/model_title。

`purpose_revision` 在每个终态写回时消费当前 `input_revision`，包括 retained、missing、unsupported、unrecognized 和终态 error。非终态 error 不消费修订，保持 pending。`purpose_version` 只在实际重新解释时更新；retained 保留旧版本。

### 失败与重试

`MAX_PURPOSE_RETRIES=3`。读取正文、解压 skeleton、解析 JSON、纯解释任一抛错，走错误写回：`purpose_status='error'`，`purpose_retry+1`，保留旧 version/rule/chain/kind/model_title。前两次失败保持 `purpose_pending=1`；第三次失败把 pending 清零、消费当前修订、target 设 2。之后 C 的 `markRequestInputTx` 把 pending 重新置 1、retry 置 0，新证据可以再次触发。

### 组

用途阶段在组事务之前执行，最多处理 `limit` 笔请求。组阶段选中组后先数该组 `purpose_pending=1` 的请求，大于 0 就跳过该组，组保持 dirty，不能写 clean，也不更新 published revision。用途改变 `kind`、`chain` 或 `modelTitle` 时，在同一写事务内 `markGroupDirtyTx`；没有实际改变时不额外标脏。actor 未知时只完成用途，不建组。

---

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `src/semantics.ts` | 新建。版本、状态、信号、标题解析、来源与分类器纯解释，不读数据库 |
| `src/request-purpose.ts` | 新建。读一笔身份与正文、CAS 写回、错误重试、drain 用途、显式 target 升级 |
| `src/body.ts` | 新增 `readBodyMetaTx`（skeleton 与引用索引，不解压消息）与严格 `readBodyTx`（完整 `{protocol, request, reply}`）；用途用前者，derive 与 `restoreBody` 用后者 |
| `src/protocols.ts` | 导出 `assistantText`，供 derive 预览与用途读取共用 |
| `src/derive.ts` | 在 `drainDeriveTx` 内用 `drainRequestPurposesTx` 替换 legacy 用途阶段；组跳过；消费 `purpose_chain`、`model_title`；链角色与工具配对排除 aux |
| `src/queries.ts` | 会话标题按 purpose_chain 取值；用途字段入读模型；未知 req_kind/chain_role 原样返回 |
| `web/app.js` | 用途标签、辅助行摘要；删除从摘要字符串和 `<title>` 猜测请求类别的分支 |
| `src/maintenance.ts` | 重建前显式升级目标会话；排空 purpose_remaining 与 remaining；报告用途计数 |
| `tests/fixtures.ts` | 新增 `seedPurposeRequest` 合成种子；只写合成库 |
| `tests/semantics.test.ts` | 新建。纯函数规则表 |
| `tests/request-purpose.test.ts` | 新建。CAS、重试、retained、来源、目标升级 |
| `tests/derive.test.ts`、`tests/queries.test.ts`、`tests/web.test.ts`、`tests/maintenance.test.ts` | 消费侧回归 |
| `docs/architecture-design.md`、`docs/operations.md` | 交付时更新当前事实 |
| `.agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md` | Task 2 新建，Task 8 补齐；记录规则取舍、代价与消费边界 |

---

## Task 1：纯用途解释

**Files:**
- Create: `src/semantics.ts`
- Test: `tests/semantics.test.ts`

**Interfaces:**
- Consumes: 无数据库、无 Store；只接收已读出的请求视图。
- Produces: `PURPOSE_VERSION`、`PurposeStatus`、`PurposeChain`、`PurposeKindState`、`PurposeSource`、`PurposeStored`、`PurposeParse`、`PurposeView`、`PurposeDecision`、`parseTitleReply(text)`、`titleFromReply(text)`、`systemTextsOf(request)`、`stopSequencesOf(request)`、`messageCountOf(request)`、`toolCountOf(request)`、`replyTextsOf(reply)`、`classifyPurpose(view)`。

- [ ] **Step 1：写失败测试。** 新建 `tests/semantics.test.ts`，覆盖规则优先级、agent 门控、普通 block 回复、标题形状、来源别名与冲突、retained/missing/unsupported。

```ts
import { expect, test } from 'bun:test';
import {
  PURPOSE_VERSION, classifyPurpose, parseTitleReply, titleFromReply,
  type PurposeView,
} from '../src/semantics';

function view(over: Partial<PurposeView> = {}): PurposeView {
  return {
    parse: 'ok',
    agent: 'claude',
    systemTexts: [],
    stopSequences: [],
    messageCount: 2,
    toolCount: 0,
    replyText: '<block>no',
    source: { state: 'missing', value: null },
    stored: {
      version: null, status: 'missing', rule: null, signals: [],
      chain: 'participate', kind: 'chat', modelTitle: null,
    },
    ...over,
  };
}

test('分类器强指纹优先于来源与标题', () => {
  const decision = classifyPurpose(view({
    systemTexts: ['You are a security monitor for autonomous AI coding agents.'],
    stopSequences: ['</block>'],
    source: { state: 'single', value: 'title' },
    stored: { ...view().stored, kind: 'title', modelTitle: '旧标题' },
  }));
  expect(decision).toMatchObject({
    status: 'recognized', version: PURPOSE_VERSION, kind: 'auto-mode-classifier',
    chain: 'exclude', rule: 'claude.auto-mode-classifier.v1',
  });
  expect(decision.signals).toContain('classifier.verdict.pass');
});

test('普通 block 回复没有指纹时不分类', () => {
  const decision = classifyPurpose(view({ systemTexts: ['ordinary'] }));
  expect(decision).toMatchObject({
    status: 'unrecognized', kind: 'chat', chain: 'participate', version: PURPOSE_VERSION,
  });
});

test('同一指纹在非 claude agent 上不分类', () => {
  const decision = classifyPurpose(view({
    agent: 'omp',
    systemTexts: ['You are a security monitor for autonomous AI coding agents.'],
    stopSequences: ['</block>'],
  }));
  expect(decision.kind).toBe('chat');
});

test('分类器缺少回复仍识别，判定未知', () => {
  const decision = classifyPurpose(view({
    systemTexts: ['security monitor for autonomous AI coding agents'],
    stopSequences: ['</block>'], replyText: null,
  }));
  expect(decision.kind).toBe('auto-mode-classifier');
  expect(decision.signals).toContain('classifier.verdict.unknown');
});

test('标题回复两种形状都识别', () => {
  expect(titleFromReply('<title lang="zh">  修复 登录  </title>')).toBe('修复 登录');
  expect(titleFromReply('{"title":"修复登录"}')).toBe('修复登录');
  expect(parseTitleReply('{"title":"x"}')?.shape).toBe('json-title');
  const decision = classifyPurpose(view({ replyText: '<title>修复登录</title>' }));
  expect(decision).toMatchObject({
    kind: 'title', chain: 'exclude', modelTitle: '修复登录', rule: 'title.reply.v1',
  });
});

test('已存 title 在回复不再是标题时保持兼容', () => {
  const decision = classifyPurpose(view({
    replyText: 'ordinary answer',
    stored: {
      version: 1, status: 'recognized', rule: 'legacy.title',
      signals: ['title.stored'], chain: 'exclude', kind: 'title', modelTitle: '旧标题',
    },
  }));
  expect(decision).toMatchObject({
    status: 'recognized', kind: 'title', chain: 'exclude',
    modelTitle: '旧标题', rule: 'title.stored.v1',
  });
});

test('来源 kind 只对 title 别名排除，其它值保持参与', () => {
  const title = classifyPurpose(view({
    replyText: null, source: { state: 'single', value: 'title' },
  }));
  expect(title).toMatchObject({ kind: 'title', chain: 'exclude' });
  const other = classifyPurpose(view({
    source: { state: 'agree', value: 'compaction' },
  }));
  expect(other).toMatchObject({
    kind: 'source:compaction', chain: 'participate', status: 'recognized',
  });
});

test('来源冲突不参与判定，回落到标题兼容', () => {
  const decision = classifyPurpose(view({
    replyText: '<title>标题</title>',
    source: { state: 'conflict', value: null },
  }));
  expect(decision.kind).toBe('title');
  expect(decision.signals).toContain('title.reply.title-tag');
});

test('正文不可读时保留旧解释，没有旧解释则记缺失', () => {
  const retained = classifyPurpose(view({
    parse: 'missing', replyText: null,
    stored: {
      version: 1, status: 'recognized', rule: 'legacy.title',
      signals: ['title.stored'], chain: 'exclude', kind: 'title', modelTitle: '旧标题',
    },
  }));
  expect(retained).toMatchObject({
    status: 'retained', version: 1, kind: 'title', chain: 'exclude',
    modelTitle: '旧标题', rule: 'legacy.title',
  });
  const missing = classifyPurpose(view({ parse: 'missing', replyText: null }));
  expect(missing).toMatchObject({
    status: 'missing', version: null, kind: 'chat', chain: 'participate',
  });
});

test('正文不可读时来源 kind 不覆盖已存分类器', () => {
  const retained = classifyPurpose(view({
    parse: 'missing', replyText: null,
    source: { state: 'single', value: 'chat' },
    stored: {
      version: 2, status: 'recognized', rule: 'claude.auto-mode-classifier.v1',
      signals: ['classifier.agent.claude'], chain: 'exclude',
      kind: 'auto-mode-classifier', modelTitle: null,
    },
  }));
  expect(retained).toMatchObject({
    status: 'retained', kind: 'auto-mode-classifier',
    chain: 'exclude', version: 2,
  });
});

test('不支持的协议没有旧解释时记 unsupported', () => {
  const decision = classifyPurpose(view({ parse: 'unsupported', replyText: null }));
  expect(decision).toMatchObject({ status: 'unsupported', version: null });
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/semantics.test.ts -t '分类器强指纹'`

Expected: FAIL，`Cannot find module '../src/semantics'`。

- [ ] **Step 3：实现 `src/semantics.ts`。**

```ts
export const PURPOSE_VERSION = 2;

export type PurposeStatus =
  | 'recognized' | 'unrecognized' | 'missing' | 'retained' | 'unsupported' | 'error';
export type PurposeChain = 'participate' | 'exclude';
export type PurposeKindState =
  | 'single' | 'agree' | 'conflict' | 'missing' | 'invalid' | 'overflow';
export type PurposeSource = { state: PurposeKindState; value: string | null };
export type PurposeStored = {
  version: number | null;
  status: PurposeStatus;
  rule: string | null;
  signals: string[];
  chain: PurposeChain;
  kind: string;
  modelTitle: string | null;
};
export type PurposeParse = 'ok' | 'missing' | 'unsupported' | 'invalid';
export type PurposeView = {
  parse: PurposeParse;
  agent: string | null;
  systemTexts: string[];
  stopSequences: string[];
  messageCount: number | null;
  toolCount: number | null;
  replyText: string | null;
  source: PurposeSource;
  stored: PurposeStored;
};
export type PurposeDecision = {
  status: PurposeStatus;
  version: number | null;
  rule: string | null;
  signals: string[];
  chain: PurposeChain;
  kind: string;
  modelTitle: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function textsIn(content: unknown): string[] {
  const out: string[] = [];
  if (typeof content === 'string') {
    const text = textOf(content);
    if (text !== null) out.push(text);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block === 'string') {
      const text = textOf(block);
      if (text !== null) out.push(text);
      continue;
    }
    if (!isRecord(block)) continue;
    const text = textOf(block.text);
    if (text !== null) out.push(text);
  }
  return out;
}

export function systemTextsOf(request: unknown): string[] {
  if (!isRecord(request)) return [];
  const out: string[] = [];
  out.push(...textsIn(request.system));
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role !== 'system' && message.role !== 'developer') continue;
    out.push(...textsIn(message.content));
  }
  return out;
}

export function stopSequencesOf(request: unknown): string[] {
  if (!isRecord(request)) return [];
  const raw = Array.isArray(request.stop_sequences) ? request.stop_sequences
    : Array.isArray(request.stop) ? request.stop : [];
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function messageCountOf(request: unknown): number | null {
  if (!isRecord(request)) return null;
  return Array.isArray(request.messages) ? request.messages.length : null;
}

export function toolCountOf(request: unknown): number | null {
  if (!isRecord(request)) return null;
  if (request.tools === undefined) return 0;
  return Array.isArray(request.tools) ? request.tools.length : null;
}

export function replyTextsOf(reply: unknown): string[] {
  if (!isRecord(reply)) return [];
  const out = textsIn(reply.content);
  if (Array.isArray(reply.choices)) {
    for (const choice of reply.choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      out.push(...textsIn(choice.message.content));
    }
  }
  return out;
}

const TITLE_TAG_REPLY = /^<title\b[^>]*>([\s\S]*?)<\/title>\s*$/i;

export function parseTitleReply(
  text: string | null,
): { title: string; shape: 'title-tag' | 'json-title' } | null {
  if (text === null) return null;
  const trimmed = text.trim();
  const tagged = TITLE_TAG_REPLY.exec(trimmed)?.[1]?.replace(/\s+/g, ' ').trim();
  if (tagged !== undefined && tagged.length > 0) return { title: tagged, shape: 'title-tag' };
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'title' || typeof value.title !== 'string') return null;
    const title = value.title.replace(/\s+/g, ' ').trim();
    return title.length > 0 ? { title, shape: 'json-title' } : null;
  } catch {
    return null;
  }
}

export function titleFromReply(text: string | null): string | null {
  return parseTitleReply(text)?.title ?? null;
}

const SECURITY_MONITOR = 'security monitor for autonomous ai coding agents';
const BLOCK_STOP = '</block>';
const BLOCK_VERDICT = /<block>\s*(yes|no)\s*(?:<\/block>)?/gi;

function classifierDecision(view: PurposeView): PurposeDecision | null {
  if (view.agent !== 'claude') return null;
  if (!view.systemTexts.some(text => text.toLowerCase().includes(SECURITY_MONITOR))) return null;
  if (!view.stopSequences.includes(BLOCK_STOP)) return null;
  const signals = [
    'classifier.agent.claude',
    'classifier.system.security-monitor',
    'classifier.stop.block',
  ];
  if (view.messageCount === 2) signals.push('classifier.shape.messages2');
  if (view.toolCount === 0) signals.push('classifier.shape.tools0');
  let verdict: 'pass' | 'block' | 'unknown' = 'unknown';
  if (view.replyText !== null) {
    const matches = [...view.replyText.matchAll(BLOCK_VERDICT)];
    const last = matches[matches.length - 1]?.[1]?.toLowerCase();
    if (last === 'no') verdict = 'pass';
    else if (last === 'yes') verdict = 'block';
  }
  signals.push(`classifier.verdict.${verdict}`);
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'claude.auto-mode-classifier.v1',
    signals,
    chain: 'exclude',
    kind: 'auto-mode-classifier',
    modelTitle: null,
  };
}

function sourceDecision(view: PurposeView): PurposeDecision | null {
  const { state, value } = view.source;
  if (state !== 'single' && state !== 'agree') return null;
  if (value === null || value.trim().length === 0) return null;
  const kindValue = value.trim();
  const signals = [`source.kind.${state}`];
  if (kindValue === 'title') {
    signals.push('source.kind.title');
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'source.kind.v1',
      signals,
      chain: 'exclude',
      kind: 'title',
      modelTitle: titleFromReply(view.replyText),
    };
  }
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'source.kind.v1',
    signals,
    chain: 'participate',
    kind: `source:${kindValue}`,
    modelTitle: null,
  };
}

function titleDecision(view: PurposeView): PurposeDecision | null {
  const parsed = parseTitleReply(view.replyText);
  if (view.stored.kind === 'title') {
    const signals = ['title.stored'];
    if (parsed !== null) signals.push(`title.reply.${parsed.shape}`);
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: parsed !== null ? 'title.reply.v1' : 'title.stored.v1',
      signals,
      chain: 'exclude',
      kind: 'title',
      modelTitle: parsed?.title ?? view.stored.modelTitle,
    };
  }
  if (parsed === null) return null;
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'title.reply.v1',
    signals: [`title.reply.${parsed.shape}`],
    chain: 'exclude',
    kind: 'title',
    modelTitle: parsed.title,
  };
}

function unavailableDecision(view: PurposeView): PurposeDecision {
  if (view.stored.version !== null) {
    return {
      status: 'retained',
      version: view.stored.version,
      rule: view.stored.rule,
      signals: [...new Set([...view.stored.signals, 'purpose.retained'])],
      chain: view.stored.chain,
      kind: view.stored.kind,
      modelTitle: view.stored.modelTitle,
    };
  }
  const unsupported = view.parse === 'unsupported' || view.parse === 'invalid';
  return {
    status: unsupported ? 'unsupported' : 'missing',
    version: null,
    rule: null,
    signals: [`body.${view.parse}`],
    chain: view.stored.chain,
    kind: view.stored.kind,
    modelTitle: null,
  };
}

export function classifyPurpose(view: PurposeView): PurposeDecision {
  if (view.parse !== 'ok' && view.stored.version !== null) {
    return unavailableDecision(view);
  }
  if (view.parse === 'ok') {
    const classifier = classifierDecision(view);
    if (classifier !== null) return classifier;
  }
  const source = sourceDecision(view);
  if (source !== null) return source;
  if (view.parse === 'ok') {
    const title = titleDecision(view);
    if (title !== null) return title;
    return {
      status: 'unrecognized',
      version: PURPOSE_VERSION,
      rule: null,
      signals: [],
      chain: 'participate',
      kind: 'chat',
      modelTitle: null,
    };
  }
  return unavailableDecision(view);
}
```

- [ ] **Step 4：运行确认通过。**

Run: `bun test tests/semantics.test.ts`；Expected: PASS。再跑 `bun run typecheck`；Expected: PASS。

- [ ] **Step 5：提交。**

有提交授权时：`git add src/semantics.ts tests/semantics.test.ts`，提交 `feat(purpose): add versioned request purpose semantics`。

---

## Task 2：单笔读取、CAS 与有界重试

**Files:**
- Modify: `src/body.ts`
- Modify: `src/protocols.ts`
- Create: `src/request-purpose.ts`
- Modify: `tests/fixtures.ts`
- Test: `tests/request-purpose.test.ts`
- Test: `tests/body.test.ts`
- Create: `.agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md`（最小实现 note，Task 8 补齐）

**Interfaces:**
- Consumes: Task 1 的 `classifyPurpose` 与视图类型；C 的 v5 列、`markRequestInputTx`、`markGroupDirtyTx` 与 `drainDeriveTx` seam；`readBodyTx(db, reqId)`。
- Produces: `MAX_PURPOSE_RETRIES=3`、`PurposeIdentity`、`PurposeTask`、`PurposeDrainResult`、`readPurposeIdentityTx(db,reqId)`、`readPurposeViewTx(db,identity)`、`readPurposeTaskTx(db,reqId)`、`applyPurposeDecisionTx(db,identity,decision)`、`applyPurposeErrorTx(db,identity)`、`drainRequestPurposesTx(db,limit,scope?:PurposeScope)`、`PurposeScope={convKey:string}`、`upgradePurposeTargetTx(db,convKey)`；`readBodyTx(db,reqId)` 与 `assistantText(reply)`；测试 helper `seedPurposeRequest(store,input)`。生产代码不导出 Store 版本用途入口。

- [ ] **Step 1：写失败测试。** 新建 `tests/request-purpose.test.ts`。

```ts
import { expect, test } from 'bun:test';
import type { Store } from '../src/store';
import { markRequestInputTx } from '../src/derive-state';
import {
  applyPurposeDecisionTx, applyPurposeErrorTx, drainRequestPurposesTx,
  readPurposeTaskTx, upgradePurposeTargetTx,
  type PurposeDrainResult, type PurposeTask,
} from '../src/request-purpose';
import { classifyPurpose, type PurposeDecision } from '../src/semantics';
import { fixture, seedPurposeRequest } from './fixtures';

function drainPurposes(store: Store, limit = 100): PurposeDrainResult {
  return store.write(db => drainRequestPurposesTx(db, limit));
}

function readTask(store: Store, id: number): PurposeTask | null {
  return readPurposeTaskTx(store.read, id);
}

function applyDecision(
  store: Store, task: PurposeTask, decision: PurposeDecision,
): 'applied' | 'stale' {
  return store.write(db => applyPurposeDecisionTx(db, task, decision));
}

function applyError(store: Store, task: PurposeTask) {
  return store.write(db => applyPurposeErrorTx(db, task));
}

function upgrade(store: Store, convKey: string): number {
  return store.write(db => upgradePurposeTargetTx(db, convKey));
}

type PurposeRow = {
  purpose_status: string; purpose_version: number | null; purpose_rule: string | null;
  purpose_chain: string; purpose_pending: number; purpose_revision: number;
  purpose_target: number; purpose_retry: number; purpose_signals: string;
  req_kind: string; model_title: string | null; input_revision: number;
};

function purposeRow(store: Store, id: number): PurposeRow {
  return store.read.query<PurposeRow, [number]>(`
    SELECT purpose_status, purpose_version, purpose_rule, purpose_chain, purpose_pending,
      purpose_revision, purpose_target, purpose_retry, purpose_signals, req_kind,
      model_title, input_revision
    FROM request WHERE req_id=?`).get(id)!;
}

test('分类器指纹在写入时按 CAS 结算用途并标脏所属组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'classifier',
      system: 'You are a security monitor for autonomous AI coding agents.',
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
      cleanGroup: true,
      purposeTarget: 1,
    });
    const result = drainPurposes(f.store);
    expect(result).toMatchObject({ processed: 1, applied: 1, remaining: 0 });
    const row = purposeRow(f.store, id);
    expect(row).toMatchObject({
      purpose_status: 'recognized', purpose_version: 2, purpose_chain: 'exclude',
      purpose_pending: 0, purpose_target: 2, req_kind: 'auto-mode-classifier',
    });
    expect(JSON.parse(row.purpose_signals)).toContain('classifier.verdict.pass');
    expect(f.store.read.query<{ state: string }, [string, string]>(
      'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?').get('classifier', 'actor'))
      .toEqual({ state: 'dirty' });
  } finally { f.close(); }
});

test('输入修订变化后旧解释写回是 stale', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'stale',
      reply: { content: [{ type: 'text', text: 'plain' }] },
    });
    const task = readTask(f.store, id)!;
    f.store.write(db => db.run(
      'UPDATE request SET input_revision=input_revision+1 WHERE req_id=?', [id]));
    expect(applyDecision(f.store, task, classifyPurpose(task.view))).toBe('stale');
    expect(purposeRow(f.store, id).purpose_pending).toBe(1);
  } finally { f.close(); }
});

test('用途错误最多重试三次，终态消费当前修订', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'retry' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const task = readTask(f.store, id)!;
      expect(applyError(f.store, task)).toEqual({
        result: 'applied', terminal: attempt === 3,
      });
    }
    const terminal = purposeRow(f.store, id);
    expect(terminal).toMatchObject({
      purpose_status: 'error', purpose_pending: 0, purpose_retry: 3, purpose_target: 2,
    });
    expect(terminal.purpose_revision).toBe(terminal.input_revision);
    f.store.write(db => markRequestInputTx(db, id));
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_pending: 1, purpose_retry: 0,
    });
  } finally { f.close(); }
});

test('正文回收后新修订保留旧用途', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'retained',
      reply: { content: [{ type: 'text', text: '<title>旧标题</title>' }] },
    });
    drainPurposes(f.store);
    f.store.write(db => {
      db.run(`UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE req_id=?`, [id]);
      markRequestInputTx(db, id);
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'retained', purpose_version: 2, purpose_chain: 'exclude',
      req_kind: 'title', model_title: '旧标题',
    });
  } finally { f.close(); }
});

test('末条消息块缺失时不把 partial 当完整用途', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'partial',
      messages: [{ role: 'user', content: 'one' }],
      reply: { content: [{ type: 'text', text: '<title>不应识别</title>' }] },
    });
    f.store.write(db => {
      db.run('DELETE FROM request_block WHERE req_id=?', [id]);
      markRequestInputTx(db, id);
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'missing', req_kind: 'chat', purpose_pending: 0,
    });
  } finally { f.close(); }
});

test('来源 title 别名在正文不可读时仍能识别', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'source', bodyState: 'evicted', sourceKind: 'title',
    });
    expect(drainPurposes(f.store).applied).toBe(1);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'recognized', purpose_version: 2,
      req_kind: 'title', purpose_chain: 'exclude', model_title: null,
    });
  } finally { f.close(); }
});

test('普通对话记为 unrecognized，不支持的协议记为 unsupported', () => {
  const f = fixture();
  try {
    const chat = seedPurposeRequest(f.store, {
      convKey: 'plain', reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 'unsupported', protocol: 'gemini',
      reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, chat)).toMatchObject({
      purpose_status: 'unrecognized', purpose_version: 2,
      req_kind: 'chat', purpose_chain: 'participate',
    });
    expect(purposeRow(f.store, other)).toMatchObject({
      purpose_status: 'unsupported', purpose_version: null,
    });
  } finally { f.close(); }
});

test('目标升级只改显式会话并保留旧解释', () => {
  const f = fixture();
  try {
    const target = seedPurposeRequest(f.store, {
      convKey: 'target', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposeRule: 'legacy.title',
      purposeChain: 'exclude', reqKind: 'title', modelTitle: '旧',
      purposePending: 0, cleanGroup: true,
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 'other', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposePending: 0, cleanGroup: true,
    });
    expect(upgrade(f.store, 'target')).toBe(1);
    expect(purposeRow(f.store, target)).toMatchObject({
      purpose_target: 2, purpose_pending: 1, purpose_version: 1,
      purpose_status: 'recognized', req_kind: 'title', model_title: '旧',
    });
    expect(purposeRow(f.store, other)).toMatchObject({
      purpose_target: 1, purpose_pending: 0, purpose_version: 1,
    });
    expect(f.store.read.query<{ state: string }, [string]>(
      'SELECT state FROM derive_queue WHERE conv_key=?').get('target'))
      .toEqual({ state: 'dirty' });
  } finally { f.close(); }
});
```

在 `tests/body.test.ts` 末尾加入，固定共享读取器的严格性；`twoRepeats` 有两条消息，删掉最后一条引用后 `msg_count` 与引用数不一致：

```ts
test('末条块引用缺失时正文不可还原', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    persistBody(f.store, 1, twoRepeats);
    f.store.write(db => db.run(
      'DELETE FROM request_block WHERE req_id=1 AND ord=1'));
    expect(restoreBody(f.store, 1)).toBeNull();
  } finally { f.close(); }
});
```

- [ ] **Step 2：运行确认失败。**

Run:

```bash
bun test tests/request-purpose.test.ts -t '分类器指纹在写入时'
bun test tests/body.test.ts -t '末条块引用缺失'
```

Expected: 第一条 FAIL，`Cannot find module '../src/request-purpose'` 或 `seedPurposeRequest` 未导出；第二条 FAIL，`restoreBody` 仍返回只有一条消息的正文。

- [ ] **Step 3：把正文读取与回复文本抽成共享 helper。** `request` 表没有 `protocol` 列，协议只来自 skeleton；消息条数反过来只存在 `request.msg_count`，骨架里没有也不该再抄一份。`readSkeletonTx` 严格检查 `format=1`、非空 `protocol`、布尔 `has_messages`、整数 `redact_version`，并按 `has_messages` 核对 `request` 行的整数 `msg_count`；`readBodyMetaTx` 用 `LEFT JOIN` 检查引用数、ord 连续和块存在，但**不解压消息块**，供用途读取；`readBodyTx` 在 meta 通过后解压全部消息，供 derive 与 `restoreBody` 使用。任何结构不一致返回 null，不抛错：derive 保持"不可读"，用途走 retained/missing，不能把 partial 当完整分类。`src/body.ts` 已导入 `Database` 与 `zstdDecompressSync`，不需要新增 import。

```ts
export type BodyMeta = {
  protocol: string;
  request: unknown;
  reply: unknown;
  hasMessages: boolean;
  messageCount: number;
  redact_version: number;
};
export type StoredBody = {
  protocol: string;
  request: unknown;
  reply: unknown;
  redact_version: number;
};

type SkeletonFields = {
  format?: unknown; protocol?: unknown; request_without_messages?: unknown;
  reply?: unknown; has_messages?: unknown; redact_version?: unknown;
};

function readSkeletonTx(db: Database, reqId: number): {
  protocol: string; request: unknown; reply: unknown;
  hasMessages: boolean; messageCount: number; redactVersion: number;
} | null {
  const row = db.query<{
    skeleton_z: Uint8Array | null; body_state: string; msg_count: number | null;
  }, [number]>(
    'SELECT skeleton_z, body_state, msg_count FROM request WHERE req_id=?').get(reqId);
  if (row == null || row.skeleton_z == null) return null;
  if (row.body_state !== 'available' && row.body_state !== 'partial') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const skeleton = parsed as SkeletonFields;
  if (skeleton.format !== 1) return null;
  if (typeof skeleton.protocol !== 'string' || skeleton.protocol.length === 0) return null;
  if (typeof skeleton.has_messages !== 'boolean') return null;
  if (typeof skeleton.redact_version !== 'number'
    || !Number.isInteger(skeleton.redact_version) || skeleton.redact_version < 1) return null;
  let messageCount = 0;
  if (skeleton.has_messages) {
    if (typeof row.msg_count !== 'number'
      || !Number.isInteger(row.msg_count) || row.msg_count < 0) return null;
    messageCount = row.msg_count;
  } else if (row.msg_count !== null && row.msg_count !== 0) {
    return null;
  }
  return {
    protocol: skeleton.protocol,
    request: skeleton.request_without_messages ?? null,
    reply: skeleton.reply ?? null,
    hasMessages: skeleton.has_messages,
    messageCount,
    redactVersion: skeleton.redact_version,
  };
}

function bodyRefsValid(db: Database, reqId: number, messageCount: number): boolean {
  const refs = db.query<{ ord: number; block: number | null }, [number]>(`
    SELECT rb.ord AS ord, b.id AS block FROM request_block rb
    LEFT JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
  if (refs.length !== messageCount) return false;
  for (let index = 0; index < refs.length; index += 1) {
    if (refs[index]!.ord !== index || refs[index]!.block === null) return false;
  }
  return true;
}

export function readBodyMetaTx(db: Database, reqId: number): BodyMeta | null {
  const skeleton = readSkeletonTx(db, reqId);
  if (skeleton === null) return null;
  if (!bodyRefsValid(db, reqId, skeleton.messageCount)) return null;
  return {
    protocol: skeleton.protocol,
    request: skeleton.request,
    reply: skeleton.reply,
    hasMessages: skeleton.hasMessages,
    messageCount: skeleton.messageCount,
    redact_version: skeleton.redactVersion,
  };
}

export function readBodyTx(db: Database, reqId: number): StoredBody | null {
  const meta = readBodyMetaTx(db, reqId);
  if (meta === null) return null;
  if (!meta.hasMessages) {
    return {
      protocol: meta.protocol,
      request: meta.request,
      reply: meta.reply,
      redact_version: meta.redact_version,
    };
  }
  // 带消息时骨架必须原本就是对象，否则无法无损合并 messages。
  if (meta.request === null || typeof meta.request !== 'object' || Array.isArray(meta.request)) {
    return null;
  }
  let messages: unknown[] = [];
  if (meta.messageCount > 0) {
    const refs = db.query<{ z: Uint8Array }, [number]>(`
      SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
      WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
    if (refs.length !== meta.messageCount) return null;
    try {
      messages = refs.map(ref => JSON.parse(zstdDecompressSync(ref.z).toString('utf8')));
    } catch {
      return null;
    }
  }
  return {
    protocol: meta.protocol,
    request: { ...(meta.request as Record<string, unknown>), messages },
    reply: meta.reply,
    redact_version: meta.redact_version,
  };
}
```

用途读取只用 `readBodyMetaTx`：解压 skeleton、检查引用索引，不解压任何消息块；分类器需要的 system/stop 与回复都在 skeleton 的 `request_without_messages` 与 `reply` 里。F 只需测量 skeleton 解压与引用索引的固定成本，不把全消息解压计入用途路径。`readBodyTx` 的全量解压只服务 derive 与 `restoreBody`。

把现有 `restoreBody` 的实现替换为同一读取路径，保留 Store 包装与 alias 解析：

```ts
export function restoreBody(store: Store, id: number): BodyInput | null {
  const reqId = resolveRequestId(store, id);
  if (reqId === null) return null;
  const body = readBodyTx(store.read, reqId);
  return body === null ? null : { ...body };
}
```

在 `src/protocols.ts` 末尾加入，签名与 derive 现有实现一致：

```ts
export function assistantText(reply: unknown): string | null {
  if (!isRecord(reply)) return null;
  const fromBlocks = (blocks: unknown): string | null => {
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const value = block.text;
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
  };
  const direct = fromBlocks(reply.content);
  if (direct !== null) return direct;
  const choices = reply.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  const message = isRecord(first) ? first.message : null;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  return fromBlocks(content);
}
```

- [ ] **Step 4：实现 `src/request-purpose.ts`。**

```ts
import type { Database } from 'bun:sqlite';
import { readBodyMetaTx } from './body';
import { markGroupDirtyTx } from './derive-state';
import { parseProtocol } from './protocols';
import {
  PURPOSE_VERSION,
  classifyPurpose,
  replyTextsOf,
  stopSequencesOf,
  systemTextsOf,
  toolCountOf,
  type PurposeChain,
  type PurposeDecision,
  type PurposeKindState,
  type PurposeParse,
  type PurposeSource,
  type PurposeStatus,
  type PurposeStored,
  type PurposeView,
} from './semantics';

export const MAX_PURPOSE_RETRIES = 3;

const PURPOSE_STATUSES = new Set<PurposeStatus>([
  'recognized', 'unrecognized', 'missing', 'retained', 'unsupported', 'error',
]);
const SOURCE_STATES = new Set<PurposeKindState>([
  'single', 'agree', 'conflict', 'missing', 'invalid', 'overflow',
]);

export type PurposeIdentity = {
  reqId: number;
  convKey: string | null;
  actor: string | null;
  actorState: string;
  agent: string | null;
  epoch: string;
  inputRevision: number;
  target: number;
  retry: number;
  stored: PurposeStored;
  source: PurposeSource;
};

export type PurposeTask = PurposeIdentity & { view: PurposeView };

export type PurposeDrainResult = {
  processed: number;
  applied: number;
  stale: number;
  retained: number;
  failed: number;
  remaining: number;
};

export type PurposeApplyResult = { result: 'applied' | 'stale'; terminal: boolean };

export type PurposeScope = { convKey: string };

type PurposeDbRow = {
  req_id: number; conv_key: string | null; actor: string | null; actor_state: string;
  agent: string | null;
  input_epoch: string; input_revision: number; purpose_target: number;
  purpose_retry: number; purpose_version: number | null; purpose_status: string;
  purpose_rule: string | null; purpose_chain: string; purpose_signals: string;
  req_kind: string | null; model_title: string | null; source_facts_json: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSignals(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseSource(raw: string | null): PurposeSource {
  if (raw === null) return { state: 'missing', value: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value.kinds)) return { state: 'invalid', value: null };
    const state = value.kinds.state;
    const kindValue = value.kinds.value;
    if (typeof state !== 'string' || !SOURCE_STATES.has(state as PurposeKindState)) {
      return { state: 'invalid', value: null };
    }
    return {
      state: state as PurposeKindState,
      value: typeof kindValue === 'string' && kindValue.length > 0 ? kindValue : null,
    };
  } catch {
    return { state: 'invalid', value: null };
  }
}

export function readPurposeIdentityTx(db: Database, reqId: number): PurposeIdentity | null {
  const row = db.query<PurposeDbRow, [number]>(`
    SELECT req_id, conv_key, actor, actor_state, agent, input_epoch, input_revision,
      purpose_target, purpose_retry, purpose_version, purpose_status, purpose_rule,
      purpose_chain, purpose_signals, req_kind, model_title, source_facts_json
    FROM request WHERE req_id=?`).get(reqId);
  if (row === null) return null;
  const status = PURPOSE_STATUSES.has(row.purpose_status as PurposeStatus)
    ? row.purpose_status as PurposeStatus : 'missing';
  const chain: PurposeChain = row.purpose_chain === 'exclude' ? 'exclude' : 'participate';
  return {
    reqId: row.req_id,
    convKey: row.conv_key,
    actor: row.actor,
    actorState: row.actor_state === 'known' ? 'known' : 'unknown',
    agent: row.agent,
    epoch: row.input_epoch,
    inputRevision: row.input_revision,
    target: row.purpose_target,
    retry: row.purpose_retry,
    stored: {
      version: row.purpose_version,
      status,
      rule: row.purpose_rule,
      signals: parseSignals(row.purpose_signals),
      chain,
      kind: row.req_kind ?? 'chat',
      modelTitle: row.model_title,
    },
    source: parseSource(row.source_facts_json),
  };
}

function emptyView(identity: PurposeIdentity, parse: PurposeParse, reply: unknown): PurposeView {
  return {
    parse,
    agent: identity.agent,
    systemTexts: [],
    stopSequences: [],
    messageCount: null,
    toolCount: null,
    replyText: reply === null || reply === undefined
      ? null : (replyTextsOf(reply).join('\n') || null),
    source: identity.source,
    stored: identity.stored,
  };
}

export function readPurposeViewTx(db: Database, identity: PurposeIdentity): PurposeView {
  const body = readBodyMetaTx(db, identity.reqId);
  if (body === null) return emptyView(identity, 'missing', null);
  const parsed = parseProtocol(body.protocol, body.request, body.reply);
  const parse: PurposeParse = parsed.parse_state === 'ok' ? 'ok'
    : parsed.parse_state === 'unsupported' ? 'unsupported' : 'invalid';
  if (parse !== 'ok') return emptyView(identity, parse, body.reply);
  return {
    parse,
    agent: identity.agent,
    systemTexts: systemTextsOf(body.request),
    stopSequences: stopSequencesOf(body.request),
    messageCount: body.messageCount,
    toolCount: toolCountOf(body.request),
    replyText: replyTextsOf(body.reply).join('\n') || null,
    source: identity.source,
    stored: identity.stored,
  };
}

export function readPurposeTaskTx(db: Database, reqId: number): PurposeTask | null {
  const identity = readPurposeIdentityTx(db, reqId);
  if (identity === null) return null;
  return { ...identity, view: readPurposeViewTx(db, identity) };
}

function markKnownGroup(db: Database, identity: PurposeIdentity): void {
  if (identity.actorState !== 'known'
    || identity.convKey === null || identity.actor === null) return;
  markGroupDirtyTx(db, identity.convKey, identity.actor, '');
}

export function applyPurposeDecisionTx(
  db: Database, identity: PurposeIdentity, decision: PurposeDecision,
): 'applied' | 'stale' {
  const changed = db.run(`
    UPDATE request SET purpose_pending=0, purpose_retry=0,
      purpose_revision=input_revision, purpose_target=?,
      purpose_status=?, purpose_version=?, purpose_rule=?, purpose_signals=?,
      purpose_chain=?, req_kind=?, model_title=?
    WHERE req_id=? AND input_epoch=? AND input_revision=? AND purpose_target=? AND purpose_pending=1`,
    [PURPOSE_VERSION, decision.status, decision.version, decision.rule,
     JSON.stringify(decision.signals), decision.chain, decision.kind, decision.modelTitle,
     identity.reqId, identity.epoch, identity.inputRevision, identity.target]).changes;
  if (changed !== 1) return 'stale';
  if (decision.kind !== identity.stored.kind
    || decision.chain !== identity.stored.chain
    || decision.modelTitle !== identity.stored.modelTitle) {
    markKnownGroup(db, identity);
  }
  return 'applied';
}

export function applyPurposeErrorTx(
  db: Database, identity: PurposeIdentity,
): PurposeApplyResult {
  const retry = Math.min(identity.retry + 1, MAX_PURPOSE_RETRIES);
  const terminal = retry >= MAX_PURPOSE_RETRIES;
  const signals = [...new Set([...identity.stored.signals, 'purpose.error'])];
  const changed = db.run(`
    UPDATE request SET purpose_pending=?, purpose_retry=?, purpose_target=?,
      purpose_status='error', purpose_signals=?
      ${terminal ? ', purpose_revision=input_revision' : ''}
    WHERE req_id=? AND input_epoch=? AND input_revision=? AND purpose_target=? AND purpose_pending=1`,
    [terminal ? 0 : 1, retry, PURPOSE_VERSION, JSON.stringify(signals),
     identity.reqId, identity.epoch, identity.inputRevision, identity.target]).changes;
  return {
    result: changed === 1 ? 'applied' as const : 'stale' as const,
    terminal,
  };
}

export function drainRequestPurposesTx(
  db: Database, limit: number, scope?: PurposeScope,
): PurposeDrainResult {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid_purpose_limit');
  if (scope !== undefined
    && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_purpose_scope');
  }
  const ids = scope === undefined
    ? db.query<{ req_id: number }, [number]>(
      'SELECT req_id FROM request WHERE purpose_pending=1 ORDER BY req_id LIMIT ?').all(limit)
    : db.query<{ req_id: number }, [string, number]>(
      'SELECT req_id FROM request WHERE purpose_pending=1 AND conv_key=? ORDER BY req_id LIMIT ?')
      .all(scope.convKey, limit);
  let processed = 0;
  let applied = 0;
  let stale = 0;
  let retained = 0;
  let failed = 0;
  for (const { req_id } of ids) {
    const identity = readPurposeIdentityTx(db, req_id);
    if (identity === null) continue;
    processed += 1;
    let decision: PurposeDecision;
    try {
      decision = classifyPurpose(readPurposeViewTx(db, identity));
    } catch {
      const outcome = applyPurposeErrorTx(db, identity);
      if (outcome.result === 'applied') failed += 1;
      else stale += 1;
      continue;
    }
    const outcome = applyPurposeDecisionTx(db, identity, decision);
    if (outcome === 'stale') {
      stale += 1;
      continue;
    }
    applied += 1;
    if (decision.status === 'retained') retained += 1;
  }
  const remaining = scope === undefined
    ? db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM request WHERE purpose_pending=1').get()!.n
    : db.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM request WHERE purpose_pending=1 AND conv_key=?')
      .get(scope.convKey)!.n;
  return { processed, applied, stale, retained, failed, remaining };
}

export function upgradePurposeTargetTx(db: Database, convKey: string): number {
  if (typeof convKey !== 'string' || convKey.length === 0) {
    throw new Error('invalid_purpose_scope');
  }
  const groups = db.query<{ actor: string }, [string, number]>(`
    SELECT DISTINCT actor FROM request
    WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known' AND purpose_target<?`)
    .all(convKey, PURPOSE_VERSION);
  const changed = db.run(`
    UPDATE request SET purpose_target=?, purpose_pending=1, purpose_retry=0
    WHERE conv_key=? AND purpose_target<?`,
    [PURPOSE_VERSION, convKey, PURPOSE_VERSION]).changes;
  for (const group of groups) markGroupDirtyTx(db, convKey, group.actor, '');
  return changed;
}
```

- [ ] **Step 5：在 `tests/fixtures.ts` 增加合成种子。** 只写临时库；`purpose_*` 在正文保存之后覆盖，保证历史 clean 行不会被 `persistBodyTx` 的输入标记重置。

```ts
import type { Store } from '../src/store';
import { persistBodyTx } from '../src/body';

export type PurposeSeed = {
  convKey?: string;
  actor?: string | null;
  actorState?: 'known' | 'unknown';
  agent?: string | null;
  protocol?: string;
  bodyState?: 'evicted' | 'available';
  startedMs?: number;
  system?: string | null;
  stop?: string[] | null;
  tools?: unknown[] | null;
  messages?: unknown[];
  reply?: unknown;
  sourceKind?: string | null;
  purposeTarget?: number;
  purposeVersion?: number | null;
  purposeStatus?: string;
  purposeRule?: string | null;
  purposeChain?: 'participate' | 'exclude';
  purposePending?: number;
  purposeSignals?: string[];
  reqKind?: string;
  modelTitle?: string | null;
  title?: string;
  titleSource?: string;
  chainRole?: string;
  summaryState?: string;
  summaryAlgorithm?: number | null;
  cleanGroup?: boolean;
};

export function seedPurposeRequest(store: Store, input: PurposeSeed = {}): number {
  const convKey = input.convKey ?? 'conv-purpose';
  const actor = input.actor === undefined ? 'actor' : input.actor;
  const actorState = input.actorState ?? 'known';
  const protocol = input.protocol ?? 'anthropic';
  const bodyState = input.bodyState ?? 'available';
  const reqId = store.write(db => Number(db.run(`
    INSERT INTO request(conv_key, actor, actor_state, agent, started_ms, day, via,
      body_state, derive_version, have, created_at, updated_at)
    VALUES (?,?,?,?,?,'2026-10-22','hook',?,0,1,1,1)`,
    [convKey, actor, actorState, input.agent === undefined ? 'claude' : input.agent,
     input.startedMs ?? 1, bodyState]).lastInsertRowid));
  if (bodyState === 'available') {
    store.write(db => persistBodyTx(db, reqId, {
      protocol,
      request: {
        ...(input.system === undefined || input.system === null ? {} : { system: input.system }),
        messages: input.messages ?? [],
        ...(input.stop === undefined || input.stop === null ? {} : { stop_sequences: input.stop }),
        ...(input.tools === undefined || input.tools === null ? {} : { tools: input.tools }),
      },
      reply: input.reply ?? { content: [{ type: 'text', text: 'plain reply' }] },
      redact_version: 1,
    }));
  }
  if (input.sourceKind !== undefined && input.sourceKind !== null) {
    store.write(db => db.run('UPDATE request SET source_facts_json=? WHERE req_id=?', [
      JSON.stringify({
        format: 1,
        kinds: {
          ledger: { values: [input.sourceKind], overflow: false, missing: false, invalid: false },
          route: { values: [], overflow: false, missing: true, invalid: false },
          state: 'single',
          value: input.sourceKind,
        },
        hook: { models: { values: [], overflow: false, missing: true, invalid: false }, successes: [] },
        selected: null,
      }),
      reqId,
    ]));
  }
  store.write(db => db.run(`
    UPDATE request SET purpose_target=?, purpose_version=?, purpose_status=?, purpose_rule=?,
      purpose_chain=?, purpose_pending=?, purpose_signals=?, req_kind=?, model_title=?,
      title=?, title_source=?, chain_role=?, summary_state=?, summary_algorithm=?
    WHERE req_id=?`, [
    input.purposeTarget ?? 2,
    input.purposeVersion ?? null,
    input.purposeStatus ?? 'missing',
    input.purposeRule ?? null,
    input.purposeChain ?? 'participate',
    input.purposePending ?? 1,
    JSON.stringify(input.purposeSignals ?? []),
    input.reqKind ?? 'chat',
    input.modelTitle ?? null,
    input.title ?? '',
    input.titleSource ?? null,
    input.chainRole ?? 'main',
    input.summaryState ?? 'legacy',
    input.summaryAlgorithm ?? null,
    reqId,
  ]));
  if (input.cleanGroup === true && actor !== null && actorState === 'known') {
    store.write(db => {
      const existing = db.query<{ group_epoch: string }, [string, string]>(
        'SELECT group_epoch FROM derive_queue WHERE conv_key=? AND actor=?').get(convKey, actor);
      db.run(`
        INSERT INTO derive_queue(conv_key, actor, from_sort, group_epoch, input_revision,
          published_revision, target_algorithm, published_algorithm, state)
        VALUES (?,?,'',?,0,0,1,1,'clean')
        ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean',
          published_revision=input_revision, published_algorithm=target_algorithm`,
      [convKey, actor, existing?.group_epoch ?? 'seed-epoch']);
    });
  }
  return reqId;
}
```

- [ ] **Step 6：新建最小实现 note。** 先建 note 骨架，保证同一提交能过 `verify:notes`；Task 8 再补齐消费方式与取舍细节。

```markdown
# Agent Note: 请求用途与主链语义

Status: implemented

## Problem

标题、分类器与来源类别此前在 derive、查询和页面各猜一次，正文回收后无法解释，链与工具配对也会把辅助请求算进来。

## Decision

用途是版本 2 的显式派生结果：`src/semantics.ts` 只解释已读出的视图，`src/request-purpose.ts` 提供单笔读取、按 `req_id + input_epoch + input_revision + purpose_target + purpose_pending` 的 CAS 写回，以及有界重试。规则优先级为分类器强指纹 > 来源 kind > 标题兼容；来源 kind 只在精确值 `title` 时排除链，其它值记为 `source:<value>` 并参与链。正文读取走 skeleton：协议来自 `skeleton.protocol`，严格校验 format、骨架字段、`request` 行的 `msg_count`、连续 ord 与块存在；用途只解骨架与引用索引，不解压消息。正文不可读时保留旧解释为 retained，没有旧解释为 missing；协议不支持为 unsupported。错误最多重试 3 次，终态清 pending 并消费当前修订。

## Alternatives considered

**继续在 derive、查询、页面各猜一次。** 三处规则会漂移，正文回收后没有共同事实，无法解释同一请求为什么在不同视图里类别不同。

**把来源 kind 当作链排除依据。** ledger/route 的 kind 只是信号，不是完整分类；任意值都排除会把普通来源误移出主链，只保留精确 `title` 别名。

**用途单独开一个写入口。** 会与组阶段形成两个 writer 和两套修订，CAS 也无法和组发布共用同一事务；因此替换 C 的 legacy 阶段，而不是并排新增。

## Consequences

- 部分正文或结构损坏一律视为不可读，宁可 retained/missing，也不把 partial 当完整分类。
- 用途只解骨架，容量成本固定；全消息解压仍在 derive/restoreBody 路径。
- 本提交只落地模块与单笔语义；接入 `drainDeriveTx`、查询/页面消费和显式 target 升级由后续提交补齐。
```

- [ ] **Step 7：运行确认通过。**

Run: `bun test tests/request-purpose.test.ts tests/semantics.test.ts tests/body.test.ts`；Expected: PASS。再跑 `bun run typecheck`；Expected: PASS。

- [ ] **Step 8：提交。**

有提交授权时：`git add src/body.ts src/protocols.ts src/request-purpose.ts tests/fixtures.ts tests/request-purpose.test.ts tests/body.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `feat(body): validate stored bodies and settle request purpose`。note 先写本批已实现的事实：skeleton 严格读取、协议来自 skeleton、单笔 CAS、重试与 retained；Task 8 再补 derive/query/web/维护。

---

## Task 3：接入统一 drain，替换 legacy 用途阶段

**Files:**
- Modify: `src/derive.ts`
- Test: `tests/derive.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `drainRequestPurposesTx(db, limit, scope?)`，其中 scope 是 `{convKey:string}`；C 的 `drainDeriveTx(db,{limit,scope?,purposeLimit?})`、`DrainResult` 扩展字段与 Store wrapper 参数校验。
- Produces: `drainDeriveTx` 返回 `purpose_processed`、`purpose_remaining`；组阶段在组内仍有 pending 用途时跳过；`drainLegacyPurposeTx` 函数与调用一起删除，不双跑。

- [ ] **Step 1：写失败测试。** 在 `tests/derive.test.ts` 末尾加入。把顶部的 `import { fixture } from './fixtures';` 改成 `import { fixture, seedPurposeRequest } from './fixtures';`，加入 `import type { Store } from '../src/store';`；`drainDerive`、`enqueueDerive` 已在顶部导入，不重复写。

```ts
function queueState(store: Store, convKey: string): string | null {
  return store.read.query<{ state: string }, [string]>(
    'SELECT state FROM derive_queue WHERE conv_key=?').get(convKey)?.state ?? null;
}

test('派生先结算用途再发布组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'purpose-group',
      system: 'You are a security monitor for autonomous AI coding agents.',
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
    });
    enqueueDerive(f.store, 'purpose-group', 'actor', '');
    const result = drainDerive(f.store, 100);
    // 本 Task 只断言用途先结算、组再发布；链角色与工具配对由 Task 4 消费后断言。
    expect(result).toMatchObject({
      purpose_processed: 1, purpose_remaining: 0, processed: 1,
    });
    expect(f.store.read.query<{
      purpose_status: string; purpose_pending: number; req_kind: string;
    }, [number]>(`
      SELECT purpose_status, purpose_pending, req_kind FROM request WHERE req_id=?`)
      .get(id)).toEqual({
      purpose_status: 'recognized', purpose_pending: 0, req_kind: 'auto-mode-classifier',
    });
    expect(queueState(f.store, 'purpose-group')).toBe('clean');
  } finally { f.close(); }
});

test('用途分批结算不延迟同组发布', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'one' }] } });
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'two' }] } });
    enqueueDerive(f.store, 'defer', 'actor', '');
    // limit 按组计数：即使每批只判一笔用途，同一调用也要把组内成员判完再发布。
    const result = drainDerive(f.store, 1);
    expect(result.purpose_processed).toBe(2);
    expect(result.purpose_remaining).toBe(0);
    expect(result.processed).toBe(2);
    expect(queueState(f.store, 'defer')).toBe('clean');
  } finally { f.close(); }
});

test('未知 actor 仍完成用途且不产生哨兵组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'solo', actor: null, actorState: 'unknown',
      reply: { content: [{ type: 'text', text: 'plain' }] },
    });
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(id))
      .toEqual({ purpose_pending: 0 });
    expect(f.store.read.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get('solo'))
      .toEqual({ n: 0 });
  } finally { f.close(); }
});

test('范围派生只处理目标会话的待定用途', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'scope-a' });
    const other = seedPurposeRequest(f.store, { convKey: 'scope-b' });
    const result = drainDerive(f.store, 100, { convKey: 'scope-a' });
    expect(result.purpose_processed).toBe(1);
    expect(result.purpose_remaining).toBe(0);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(other))
      .toEqual({ purpose_pending: 1 });
  } finally { f.close(); }
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/derive.test.ts -t '派生先结算用途'`

Expected: FAIL，`purpose_processed` 为 undefined，或目标请求的 `purpose_pending` 仍为 1。

- [ ] **Step 3：在 C 的同一 seam 替换用途阶段。** 删除 `drainLegacyPurposeTx` 函数本身与它在 `drainDeriveTx` 里的调用，不能保留旧函数再额外跑新函数。`drainDeriveTx` 已由 C 抽出，D 只改用途调用和返回字段。

```ts
export function drainDeriveTx(db: Database, options: DeriveTxOptions): DrainResult {
  // limit 按组计数，组完成要求组内没有 pending：同一调用必须推进用途到排空，
  // 否则一个大组会被切成多轮、迟迟不能发布。purposeLimit 只是每批大小。
  const purposeLimit = options.purposeLimit ?? 100;
  let purposeProcessed = 0;
  let purposeRemaining = 0;
  for (;;) {
    const batch = drainRequestPurposesTx(db, purposeLimit, options.scope);
    purposeProcessed += batch.processed;
    purposeRemaining = batch.remaining;
    if (batch.remaining === 0 || batch.processed === 0) break;
  }
  // C 的组选择、全量重建、assignChainRoles、pairToolCallsTx、组 CAS 原样保留。
  // 每轮组开始前保留 existing pending 检查。
  return {
    processed, remaining, groups: touched, recomputed, retained,
    purpose_processed: purposeProcessed,
    purpose_remaining: purposeRemaining,
  };
}
```

Store wrapper 保持 C 的形状，D 不改签名：

```ts
export function drainDerive(store: Store, limit = 100, scope?: DeriveScope): DrainResult {
  // C 的 limit/scope 校验原样保留
  return store.write(db => drainDeriveTx(db, { limit, scope }));
}
```

迁移的 `purpose` 阶段和最终 `stage=drain` 都调用 `drainDeriveTx` 或 `drainRequestPurposesTx`，不会出现旧阶段与新阶段同时消费同一批 pending 行。

组循环内、读取请求行之前插入：

```ts
const waiting = db.query<{ n: number }, [string, string]>(`
  SELECT COUNT(*) AS n FROM request
  WHERE conv_key=? AND actor=? AND purpose_pending=1`)
  .get(group.conv_key, group.actor)!.n;
if (waiting > 0) continue;
```

`remaining` 仍用 C 的 dirty 组计数；不要在用途阶段把组直接标 clean，也不要在这里调用 `markRequestInputTx`。

- [ ] **Step 4：运行确认通过。**

Run: `bun test tests/derive.test.ts tests/request-purpose.test.ts tests/semantics.test.ts -t '用途|派生'`

Expected: PASS。再跑 `bun test tests/derive.test.ts`；Expected: PASS。

- [ ] **Step 5：提交。** 在 note 的 `## Consequences` 追加一句本批事实（用途阶段与组阶段共用 `drainDeriveTx`，组内有 pending 时保持 dirty），同批提交 note。

有提交授权时：`git add src/derive.ts tests/derive.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `feat(derive): settle purposes before publishing groups`。

---

## Task 4：derive 只消费已存用途

**Files:**
- Modify: `src/derive.ts`
- Test: `tests/derive.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `readBodyTx`、`assistantText`；request 行上的 `purpose_chain`、`req_kind`、`model_title`。
- Produces: 链与工具配对按 `purpose_chain` 判定；标题模型标题只来自 `model_title`；derive 不再写 `req_kind` 与 `model_title`。

- [ ] **Step 1：写失败测试。** 追加到 `tests/derive.test.ts`，沿用 Task 3 已合并的 `seedPurposeRequest` 导入。

```ts
test('排除用途不进入主链也不写工具配对', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'excluded-tools', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier',
      purposeChain: 'exclude', purposeRule: 'claude.auto-mode-classifier.v1',
      reply: { content: [
        { type: 'tool_use', id: 'tool-excluded', name: 'Bash', input: { command: 'ls' } },
      ] },
    });
    enqueueDerive(f.store, 'excluded-tools', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ n: number }, [number]>(
      'SELECT COUNT(*) AS n FROM tool_call WHERE req_id=?').get(id)).toEqual({ n: 0 });
    expect(f.store.read.query<{ chain_role: string }, [number]>(
      'SELECT chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ chain_role: 'aux' });
  } finally { f.close(); }
});

test('非标题的排除用途不从用户增量取标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'chat', purposeChain: 'participate',
      messages: [{ role: 'user', content: [{ type: 'text', text: '第一轮' }] }],
    });
    const aux = seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2, startedMs: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier', purposeChain: 'exclude',
      purposeRule: 'claude.auto-mode-classifier.v1', modelTitle: '分类器标题',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
        { role: 'user', content: [{ type: 'text', text: '这段文本不应成为标题' }] },
      ],
    });
    enqueueDerive(f.store, 'aux-delta', 'actor', '');
    drainDerive(f.store, 100);
    // aux 与主链没有可比关系，输入摘要按末轮输入展示；标题只来自用途列。
    expect(f.store.read.query<{ title: string; title_source: string;
      input_preview_kind: string | null }, [number]>(
      'SELECT title,title_source,input_preview_kind FROM request WHERE req_id=?').get(aux))
      .toEqual({ title: '分类器标题', title_source: 'model_title',
        input_preview_kind: 'tail' });
  } finally { f.close(); }
});

test('标题由用途列驱动而不是回复形状', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'title-source', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'title', purposeChain: 'exclude',
      modelTitle: '存储标题',
      reply: { content: [{ type: 'text', text: '<title>回复标题</title>' }] },
    });
    enqueueDerive(f.store, 'title-source', 'actor', '');
    drainDerive(f.store, 100);
    const row = f.store.read.query<{
      model_title: string | null; title: string; reply_preview: string | null;
    }, [number]>(
      'SELECT model_title, title, reply_preview FROM request WHERE req_id=?').get(id)!;
    expect(row.model_title).toBe('存储标题');
    expect(row.title).toBe('存储标题');
    expect(row.reply_preview?.startsWith('标题 · ')).toBe(false);
  } finally { f.close(); }
});

test('来源类别保持原始 req_kind 并参与链', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'neutral', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'source:compaction',
      purposeChain: 'participate', purposeRule: 'source.kind.v1',
    });
    enqueueDerive(f.store, 'neutral', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ req_kind: string; chain_role: string }, [number]>(
      'SELECT req_kind, chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'source:compaction', chain_role: 'main' });
  } finally { f.close(); }
});

test('派生不再从回复形状识别标题', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'no-redetect', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'unrecognized', reqKind: 'chat', purposeChain: 'participate',
      reply: { content: [{ type: 'text', text: '<title>不应成为标题</title>' }] },
    });
    enqueueDerive(f.store, 'no-redetect', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{
      req_kind: string; chain_role: string; model_title: string | null;
    }, [number]>(
      'SELECT req_kind, chain_role, model_title FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'chat', chain_role: 'main', model_title: null });
  } finally { f.close(); }
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/derive.test.ts -t '排除用途不进入主链'`

Expected: FAIL，`tool_call` 出现 `tool-excluded`，或 `chain_role` 不是 aux；`派生不再从回复形状识别标题` 在回复含 `<title>` 时仍把 `chain_role` 写成 aux；`非标题的排除用途不从用户增量取标题` 当前会把第二段用户文本写成标题。

- [ ] **Step 3：改 derive 的读取与写入。**

组内请求查询增加 `purpose_chain`，链循环变量改为：

```ts
const isAux = row.purpose_chain === 'exclude';
const isTitle = row.req_kind === 'title';
const modelTitle = row.model_title;
```

`replyPreview` 仍在 A 的 `writePresentationTx` 内按 `current === null ? row.reply_preview : replyInfo.preview` 计算，不额外搬出。`replyInfoOf` 不再解析标题，改为：

```ts
type ReplyInfo = { preview: string | null };

function replyInfoOf(db: Database, reqId: number): ReplyInfo {
  const body = readBodyTx(db, reqId);
  if (body === null) return { preview: null };
  const text = assistantText(body.reply) ?? replyToolSummary(body.reply);
  return { preview: text === null ? null : clip(text) };
}
```

删除 `TITLE_TAG_REPLY`、`titleOfReply`、本地 `assistantText`、本地 `bodyInTx`；导入改为 `import { readBodyTx } from './body';` 与 `import { assistantText } from './protocols';`。更新语句删除 `req_kind=?` 与 `model_title=?`：

```ts
db.run(`UPDATE request SET prev_req_id=?, prev_relation=?, delta_ordinals=?, title=?, title_source=?,
  chain_role=?, input_preview=?, input_preview_kind=?, reply_preview=?,
  derive_version=derive_version+1 WHERE req_id=?`, [
  match.parent, relation,
  delta === null ? null : JSON.stringify(delta),
  title, source,
  isAux ? 'aux' : 'main',
  inputPreview, inputKind, replyPreview, row.req_id,
]);
```

链循环、摘要写回和工具配对都要按用途改，不能只改一处 SQL：

- `ChainRow`、`RoleRow`、`PairRow` 都增加 `purpose_chain: string`。`roleRows.push` 与 `pairRows.push` 带上 `purpose_chain: row.purpose_chain`；`presentations.push` 把 `isTitleRequest` 改成 `isAux`，`modelTitle` 取自行。
- `isAux` 控制链与主链身份：前驱匹配的 aux 分支、`sawEarlier`/`ancestors` 跳过、`chain_role` 取值。
- `isAux` 另控制标题的来源：aux 行不得从用户增量取标题。`PresentationInput` 同时带 `isAux` 与 `isTitle`，`isTitle` 用 `const isTitle = row.req_kind === 'title';`，不要把 `isAux` 当标题判据。三处取值如下：
  - `isTitle`：保留原分支，`title = modelTitle ?? (current === null ? row.title ?? fallback : fallback)`、`model_title` 来源提升、`生成会话标题` 输入摘要与 `inputKind='title'`。
  - `isAux && !isTitle` 且正文可比较、delta 非空：`title = modelTitle ?? fallback`，`source = modelTitle !== null ? 'model_title' : 'model_time'`，即保持模型标题或时间兜底，不调 `deriveTitle`；输入摘要与 `input_kind` 仍走同一 delta 分支的 `previewOf`/`toolResultPreview` 取值，不显示成标题请求。
  - `isAux && !isTitle` 且 `current === null`：与其它行一样保留库里旧标题与旧来源，不因 aux 改写。
- 因此 `writePresentationTx` 在可比较分支里先按 `isAux` 决定标题来源，再走原有的 delta/末轮摘要取值；正常 aux 流程 `delta` 为 null，落末轮输入分支（`tail`）；「aux 且 delta 非空」只做防御性标题取值，输入摘要仍按 delta 取。
- 现有用例「标题请求的回复只留标题文本」同步改为断言预览保留回复原文、正式标题由用途列提供：预览不再解析 `<title>`。
- 正常流程里 aux 行由链匹配的 aux 分支给出 `{parent:null,relation:'aux',delta:null}`，所以「aux 且 delta 非空」在管线里不可达，这条判据是防御性的：它把「排除用途不从用户增量取标题」钉在选标题的那一处，而不是依赖链匹配的非局部不变量。回归用直写一次暂存行的定向用例覆盖，不要求执行者去找可达路径。
- `assignChainRoles` 已由 A 改为消费 `roleRows`，过滤条件从 `row.req_kind === 'chat'` 改成 `row.purpose_chain === 'participate'`。
- `pairToolCallsTx` 的 `rows` 就是传入的 `pairRows`；把 `if (row.req_kind === 'title') continue` 改成 `if (row.purpose_chain === 'exclude') continue`，不要保留第二套 title 判断。旧 `pairToolCalls` 包装已由 A 取消，不新增 SQL 扫描。

- [ ] **Step 4：运行确认通过。**

Run: `bun test tests/derive.test.ts -t '排除用途|标题由用途|非标题的排除用途|来源类别|派生不再从回复形状'`

Expected: PASS。再跑 `bun test tests/derive.test.ts`；Expected: PASS。

- [ ] **Step 5：提交。** 在 note 的 `## Consequences` 追加一句本批事实（derive 不再写 `req_kind`/`model_title`，链与工具配对只读 `purpose_chain`），同批提交 note。

有提交授权时：`git add src/derive.ts tests/derive.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `refactor(derive): consume stored purpose for chain and titles`。

---

## Task 5：查询层读用途与保留未知值

**Files:**
- Modify: `src/queries.ts`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: C 的 `derived_state` 投影；request 的 `purpose_status`、`purpose_version`、`purpose_rule`、`purpose_chain`、`purpose_pending`、`model_title`；`derive_queue` 的 `state`、`input_revision`、`published_revision`、`target_algorithm`、`published_algorithm`。
- Produces: `RequestRow` 与 `RequestDetail` 暴露上述字段；`SESSION_TITLE_SQL` 只从 current 组里、用途已结算的行取标题：排除用途提供模型标题，参与链提供用户标题；未知 `req_kind`、`chain_role` 不再折叠。

- [ ] **Step 1：写失败测试。** 追加到 `tests/queries.test.ts`。把顶部的 `import { fixture } from './fixtures';` 改为 `import { fixture, seedPurposeRequest } from './fixtures';`，并把 `getRequest` 加入 `../src/queries` 的导入；`listSessions` 已有。

```ts
test('会话标题只取排除用途的模型标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'exclude',
      reqKind: 'title', modelTitle: '正式标题', title: 'x',
      titleSource: 'model_title', purposeStatus: 'recognized', purposeVersion: 2,
      startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'participate',
      reqKind: 'source:compaction', title: '噪声标题',
      titleSource: 'user_delta', startedMs: 2, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: '用户首句', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 3, cleanGroup: true,
    });
    expect(listSessions(f.store, 10).items[0]?.title).toBe('正式标题');
  } finally { f.close(); }
});

test('参与链的未知来源类别也能提供用户标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'neutral-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'source:compaction', title: '来源标题',
      titleSource: 'user_delta', startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'neutral-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: '用户首句', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 2, cleanGroup: true,
    });
    // 不再按 req_kind='chat' 硬编码：更早的参与链用户标题优先，来源类别原样保留。
    expect(listSessions(f.store, 10).items[0]?.title).toBe('来源标题');
  } finally { f.close(); }
});

test('组未 current 或用途未结算时都不返回旧标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'pending-title', purposePending: 1, purposeChain: 'participate',
      reqKind: 'chat', title: '待结算旧标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'dirty-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: 'dirty旧标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 2,
    });
    f.store.write(db => db.run(`
      UPDATE derive_queue SET input_revision=2, published_revision=1,
        target_algorithm=2, published_algorithm=2, state='dirty'
      WHERE conv_key='dirty-title'`));
    const titles = listSessions(f.store, 10).items.map(item => item.title);
    expect(titles).not.toContain('待结算旧标题');
    expect(titles).not.toContain('dirty旧标题');
  } finally { f.close(); }
});

test('未知用途与链角色原样返回', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'raw-kind', purposePending: 0, purposeChain: 'exclude',
      reqKind: 'auto-mode-classifier', chainRole: 'aux',
      purposeStatus: 'recognized', purposeVersion: 2,
      purposeRule: 'claude.auto-mode-classifier.v1',
      purposeSignals: ['classifier.agent.claude'],
      summaryState: 'recomputed', summaryAlgorithm: 1,
      cleanGroup: true,
    });
    expect(getRequest(f.store, id)).toMatchObject({
      req_kind: 'auto-mode-classifier', chain_role: 'aux',
      purpose_status: 'recognized', purpose_version: 2,
      purpose_rule: 'claude.auto-mode-classifier.v1', purpose_chain: 'exclude',
    });
    const unknown = seedPurposeRequest(f.store, {
      convKey: 'raw-kind-2', purposePending: 0, purposeChain: 'participate',
      reqKind: 'future-kind', chainRole: 'mystery',
      summaryState: 'recomputed', summaryAlgorithm: 1, cleanGroup: true,
    });
    expect(getRequest(f.store, unknown)).toMatchObject({
      req_kind: 'future-kind', chain_role: 'mystery',
    });
  } finally { f.close(); }
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/queries.test.ts -t '会话标题只取排除用途'`

Expected: FAIL，标题取到 `噪声标题`，或 dirty 组/未结算用途的旧标题仍被返回；未知 kind 被折成 chat。

- [ ] **Step 3：改查询。**

`RequestRow` 的类型改为：

```ts
req_kind: string;
chain_role: string;
model_title: string | null;
purpose_status: string;
purpose_version: number | null;
purpose_rule: string | null;
purpose_chain: string;
derived_state: 'current' | 'dirty' | 'retained' | 'legacy';
```

`REQUEST_COLUMNS` 在 `req_kind, chain_role` 后加入：

```sql
model_title, purpose_status, purpose_version, purpose_rule, purpose_chain
```

`derived_state` 由 C 的读投影提供，D 不重复计算。`SESSION_TITLE_SQL` 整体替换为下面这版：四个候选都 JOIN 自己的 `derive_queue` 行，条件与 C 的 `derived_state='current'` 一致（`state='clean'`、`published_revision=input_revision`、`published_algorithm=target_algorithm`、请求 `purpose_pending=0`），dirty 组或未结算用途的行不会把旧标题当当前标题返回。用户标题候选删掉 `req_kind='chat'` 硬编码，改由 `purpose_chain` 判定：未知 `source:<kind>` 只要参与链就可以提供用户标题，`req_kind` 只用于展示。`request` 表在 v5 没有 `protocol` 列，查询不选择也不按 `protocol` 过滤；协议只从 `skeleton` 读取。

```ts
const SESSION_TITLE_SQL = `COALESCE(
  (SELECT r1.model_title FROM request r1
   JOIN derive_queue q1 ON q1.conv_key = r1.conv_key AND q1.actor = r1.actor
   WHERE r1.conv_key = request.conv_key AND r1.purpose_chain = 'exclude'
     AND r1.model_title IS NOT NULL AND r1.purpose_pending = 0
     AND q1.state = 'clean' AND q1.published_revision = q1.input_revision
     AND q1.published_algorithm = q1.target_algorithm
   ORDER BY r1.started_ms DESC, r1.req_id DESC LIMIT 1),
  (SELECT r2.title FROM request r2
   JOIN derive_queue q2 ON q2.conv_key = r2.conv_key AND q2.actor = r2.actor
   WHERE r2.conv_key = request.conv_key AND r2.title_source = 'user_delta'
     AND r2.purpose_chain = 'participate' AND r2.chain_role = 'main'
     AND r2.title IS NOT NULL AND r2.purpose_pending = 0
     AND q2.state = 'clean' AND q2.published_revision = q2.input_revision
     AND q2.published_algorithm = q2.target_algorithm
   ORDER BY r2.started_ms ASC, r2.req_id ASC LIMIT 1),
  (SELECT r3.title FROM request r3
   JOIN derive_queue q3 ON q3.conv_key = r3.conv_key AND q3.actor = r3.actor
   WHERE r3.conv_key = request.conv_key AND r3.title_source = 'user_delta'
     AND r3.purpose_chain = 'participate' AND r3.title IS NOT NULL
     AND r3.purpose_pending = 0
     AND q3.state = 'clean' AND q3.published_revision = q3.input_revision
     AND q3.published_algorithm = q3.target_algorithm
   ORDER BY r3.started_ms ASC, r3.req_id ASC LIMIT 1),
  (SELECT r4.title FROM request r4
   JOIN derive_queue q4 ON q4.conv_key = r4.conv_key AND q4.actor = r4.actor
   WHERE r4.conv_key = request.conv_key AND r4.purpose_chain = 'participate'
     AND r4.title IS NOT NULL AND r4.purpose_pending = 0
     AND q4.state = 'clean' AND q4.published_revision = q4.input_revision
     AND q4.published_algorithm = q4.target_algorithm
   ORDER BY r4.started_ms ASC, r4.req_id ASC LIMIT 1)
)`;
```

`ProjectableRow` 加入 `purpose_status`、`purpose_version`、`purpose_rule`、`purpose_chain`（`DetailDbRow` 继承它，`r.*` 已带这些列）；`projectRow` 原样映射，并把未知 `req_kind`/`chain_role` 与 `model_title` 一起返回：

```ts
req_kind: row.req_kind ?? 'chat',
chain_role: current ? (row.chain_role ?? 'main') : 'unknown',
model_title: row.model_title,
purpose_status: row.purpose_status,
purpose_version: row.purpose_version,
purpose_rule: row.purpose_rule,
purpose_chain: row.purpose_chain,
```

- [ ] **Step 4：运行确认通过。**

Run: `bun test tests/queries.test.ts -t '会话标题|参与链的未知来源|组未 current|未知用途'`

Expected: PASS。再跑 `bun test tests/queries.test.ts`；Expected: PASS。

- [ ] **Step 5：提交。** 在 note 的 `## Consequences` 追加一句本批事实（查询会原样返回未知 `req_kind`/`chain_role`，会话标题只取排除用途的 `model_title`），同批提交 note。

有提交授权时：`git add src/queries.ts tests/queries.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `feat(queries): project purpose and preserve unknown kinds`。note 里写明标题候选只取 current 组且 `purpose_pending=0`，用户标题不再按 `req_kind='chat'` 过滤；旧标题在组 dirty 时不作为当前值返回。

---

## Task 6：页面只展示派生用途

**Files:**
- Modify: `web/app.js`
- Modify: `web/index.html`（新增 `.type-tag.aux` 配色）
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `RequestRow.purpose_chain`、`req_kind`、`model_title`、`chain_role`。
- Produces: 顶层导出 `purposeLabel(kind)`、`isAuxRow(row)`、`auxSummary(row)`；删除 `isAuxTitleRequest`、`TITLE_REPLY`、`titleOfReplyText`、`reply_preview.startsWith('标题 · ')`。

- [ ] **Step 1：写失败测试。** 追加到 `tests/web.test.ts`。

```ts
import { auxSummary, isAuxRow, purposeLabel } from '../web/app.js';

test('辅助行只由派生用途决定', () => {
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main' })).toBe(false);
  expect(isAuxRow({ purpose_chain: 'exclude', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({
    purpose_chain: 'participate', chain_role: 'main',
    req_kind: 'chat', reply_preview: '标题 · 普通内容',
  })).toBe(false);
});

test('未知用途保留原始 ID', () => {
  expect(purposeLabel('source:compaction')).toBe('source:compaction');
  expect(purposeLabel('title')).toBe('标题生成');
  expect(purposeLabel('auto-mode-classifier')).toBe('自动模式分类');
});

test('分类器摘要显示判定', () => {
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<block>no',
  })).toBe('自动模式分类 · 放行');
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<block>yes',
  })).toBe('自动模式分类 · 拦截');
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<transcript>',
  })).toBe('自动模式分类 · 判定未知');
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/web.test.ts -t '辅助行只由派生用途'`

Expected: FAIL，`isAuxRow` 未导出。

- [ ] **Step 3：在 `web/app.js` 顶层、`if (typeof document !== 'undefined')` 之前加入纯函数。**

```js
/** @param {string|null|undefined} kind */
export function purposeLabel(kind) {
  if (kind === 'title') return '标题生成';
  if (kind === 'auto-mode-classifier') return '自动模式分类';
  if (kind === 'chat') return '对话';
  return kind ?? '未知用途';
}

/** @param {{purpose_chain?: string|null, chain_role?: string|null, req_kind?: string|null, reply_preview?: string|null}} row */
export function isAuxRow(row) {
  return row.purpose_chain === 'exclude' || row.chain_role === 'aux';
}

/** @param {{req_kind?: string|null, reply_preview?: string|null, model_title?: string|null}} row */
export function auxSummary(row) {
  const label = purposeLabel(row.req_kind);
  if (row.req_kind === 'auto-mode-classifier') {
    const match = /<block>\s*(yes|no)\s*(?:<\/block>)?/i.exec(row.reply_preview ?? '');
    const verdict = match?.[1]?.toLowerCase();
    if (verdict === 'no') return `${label} · 放行`;
    if (verdict === 'yes') return `${label} · 拦截`;
    return `${label} · 判定未知`;
  }
  if (row.req_kind === 'title') {
    return row.model_title === null || row.model_title === undefined
      ? label : `${label} · ${row.model_title}`;
  }
  return label;
}
```

- [ ] **Step 4：替换页面里的猜测分支。**

`relationTextOf` 在 `prev_relation` 判断之前加：

```js
if (detail.purpose_chain === 'exclude' || detail.chain_role === 'aux') {
  return '辅助请求，不在主链上';
}
```

`renderConversation` 中删除 `auxReply` 与 `auxPreview`，改为 `const aux = isAuxRow(r);`。`rawUserBlocks`、`previewTag`、`inputNote` 的标题分支全部改用 `aux` 与 `auxSummary(r)`。用户气泡映射不再判断标题：

```js
${userTexts.map(text => `<div class="conv-user" data-select="${r.req_id}">
  <div class="conv-who">USER</div>
  <div class="conv-user-body">${esc(text)}</div>
</div>`).join('')}
```

`ledgerRow` 的 `isTitle` 改为 `isAux = isAuxRow(r)`；`kind` 用 `isAux ? 'aux'`，标签用 `辅助`，主文本用 `auxSummary(r)`，`web/index.html` 补 `.type-tag.aux` 配色。`convCard` 删除标题特判，直接按 `view.text` 渲染（`web/body-view.js` 的 `renderReply` 本来就没有标题分支）。删除 `isAuxTitleRequest`、`TITLE_REPLY`、`titleOfReplyText` 及所有 `startsWith('标题 · ')`。

- [ ] **Step 5：运行确认通过。**

Run: `bun test tests/web.test.ts`；Expected: PASS。再跑 `bun run typecheck`；Expected: PASS。

- [ ] **Step 6：提交。** 在 note 的 `## Consequences` 追加一句本批事实（页面辅助行只读 `purpose_chain`/`chain_role`，不再从摘要字符串猜类别），同批提交 note。

有提交授权时：`git add web/app.js tests/web.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `feat(web): label aux requests from stored purpose`。

---

## Task 7：维护重建的显式目标升级与排空

**Files:**
- Modify: `src/maintenance.ts`
- Test: `tests/maintenance.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `upgradePurposeTargetTx(db,convKey)`；Task 3 的两个 remaining 字段。
- Produces: `rebuild --session` 在维护自己的写事务里升级该会话目标，再循环 `drainDerive(store,100,{convKey})` 直到 `purpose_remaining` 与 `remaining` 都为 0；报告加入 `purpose_upgraded`、`purpose_processed`、`purpose_remaining`。

- [ ] **Step 1：写失败测试。** 追加到 `tests/maintenance.test.ts`。把顶部的 `import { fixture } from './fixtures';` 改为 `import { fixture, seedPurposeRequest } from './fixtures';`；`runMaintenance`、`join` 已有。

```ts
test('重建只升级目标会话的用途目标并排空两类工作', async () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 's-target', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposeRule: 'legacy.title',
      purposeChain: 'exclude', reqKind: 'title', modelTitle: '旧标题',
      purposePending: 0, cleanGroup: true,
      reply: { content: [{ type: 'text', text: '<title>旧标题</title>' }] },
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 's-other', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposePending: 0, cleanGroup: true,
    });
    const lines: string[] = [];
    const code = await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', 's-target'], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report).toMatchObject({
      ok: true, session: 's-target', queue_remaining: 0, purpose_remaining: 0,
    });
    expect(report.purpose_upgraded).toBeGreaterThanOrEqual(1);
    expect(f.store.read.query<{
      purpose_target: number; purpose_pending: number; purpose_version: number | null;
      req_kind: string;
    }, [number]>(`
      SELECT purpose_target, purpose_pending, purpose_version, req_kind
      FROM request WHERE req_id=?`).get(id)).toMatchObject({
      purpose_target: 2, purpose_pending: 0, purpose_version: 2, req_kind: 'title',
    });
    expect(f.store.read.query<{
      purpose_target: number; purpose_pending: number;
    }, [number]>(`
      SELECT purpose_target, purpose_pending FROM request WHERE req_id=?`).get(other))
      .toEqual({ purpose_target: 1, purpose_pending: 0 });
  } finally { f.close(); }
});
```

- [ ] **Step 2：运行确认失败。**

Run: `bun test tests/maintenance.test.ts -t '重建只升级目标会话'`

Expected: FAIL，报告缺 `purpose_upgraded`，或目标会话的 `purpose_target` 仍为 1。

- [ ] **Step 3：改 maintenance 的 rebuild 分支。**

在 `rebuildDerived` 之前升级目标会话，并把单次 drain 改成循环：

```ts
const upgraded = store.write(db => upgradePurposeTargetTx(db, session));
const report = rebuildDerived(store, session);
let purposeProcessed = 0;
let drained = drainDerive(store, 100, { convKey: session });
for (;;) {
  purposeProcessed += drained.purpose_processed;
  if (drained.purpose_remaining === 0 && drained.remaining === 0) break;
  if (drained.purpose_processed + drained.processed === 0) {
    throw new Error('derive_no_progress');
  }
  drained = drainDerive(store, 100, { convKey: session });
}
```

报告改为：

```ts
out(JSON.stringify({
  ok: true,
  session,
  queued: report.queued,
  unavailable: report.unavailable,
  reasons: report.reasons,
  derive_version: version?.v ?? 0,
  queue_remaining: drained.remaining,
  purpose_upgraded: upgraded,
  purpose_processed: purposeProcessed,
  purpose_remaining: drained.purpose_remaining,
}));
```

导入改为 `import { drainDerive, rebuildDerived } from './derive';` 与 `import { upgradePurposeTargetTx } from './request-purpose';`；A 已移除的 `pairToolCalls` 不再导入或调用。全量 rebuild 若仍无 `--session` 分支，本 Task 不改；没有目标会话时不得升级全库。

- [ ] **Step 4：运行确认通过。**

Run: `bun test tests/maintenance.test.ts -t '重建只升级目标会话'`

Expected: PASS。再跑 `bun test tests/maintenance.test.ts tests/derive.test.ts`；Expected: PASS。

- [ ] **Step 5：提交。** 在 note 的 `## Consequences` 追加一句本批事实（只有显式 `rebuild --session` 升级目标并排空用途），同批提交 note。

有提交授权时：`git add src/maintenance.ts tests/maintenance.test.ts .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `feat(maintenance): upgrade purpose target inside scoped rebuild`。

---

## Task 8：同步文档、note 与全量验证

**Files:**
- Modify: `docs/architecture-design.md`
- Modify: `docs/operations.md`
- Modify: `.agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md`（Task 2 已建）

**Interfaces:**
- Consumes: Task 1-7 的最终行为；Task 2 的 note 骨架。
- Produces: 文档只描述当前事实；note 补齐为什么把来源 kind 当信号、为什么未知用途参与链、为什么历史 v1 必须显式升级，以及 derive/query/web/维护的最终消费方式。

- [ ] **Step 1：更新架构文档。** 在 `docs/architecture-design.md` 的派生字段/请求语义章节写明：用途状态集合；`PURPOSE_VERSION=2`；规则优先级；分类器三信号门槛；来源 kind 只对 `title` 别名排除；未知用途参与链；组 pending 时不发布；会话标题候选与 C 的 `derived_state='current'` 同条件，dirty 组不返回旧标题。
- [ ] **Step 2：更新运维文档。** 在 `docs/operations.md#rebuild` 写明：`rebuild --session <key>` 会先把该会话 `purpose_target<2` 的行置为 pending 再排空；普通 tick 不升级 clean 历史行；报告字段 `purpose_upgraded`、`purpose_processed`、`purpose_remaining`；遇到 `derive_no_progress` 先查用途错误读取日志与正文可读性。
- [ ] **Step 3：补齐 note。** 更新 Task 2 新建的 `.agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md`，保持 `Status: implemented`，删掉 Task 2 临时写下的那句本提交只落地模块与单笔语义、接入与消费由后续提交补齐的说明，补齐：问题（三处各自猜标题/类别）；决定（纯解释 + 单笔 CAS + `drainDeriveTx` 内的用途阶段）；来源 kind 只作信号的取舍；未知 actor 仍完成用途的理由；历史 v1 显式升级的代价；derive/query/web/维护只消费已存用途；在线 tick 与显式重建共用排空入口（显式迁移已随破坏式结构替换移除，没有 `stage=drain`）；被部分取代的旧 note 链接。
- [ ] **Step 4：全量验证。**

Run:

```bash
bun test
bun run typecheck
bun run verify:notes
```

Expected: 全部 PASS。另做一次人工核对：

```bash
grep -R "isAuxTitleRequest\|标题 · \|titleOfReplyText" web/app.js
grep -n "LEGACY_PURPOSE_VERSION" src/derive.ts src/request-purpose.ts
grep -n "purpose_kind\|purpose_target_v" src/schema.sql
grep -rn "request\.protocol" src/
```

Expected: 前三条无输出；第四条无输出，说明没有任何查询把 `protocol` 当成 request 列。出现任何一条都说明还有第二套用途语义、自造字段或 v5 不存在的列。

- [ ] **Step 5：提交。**

有提交授权时：`git add docs/architecture-design.md docs/operations.md .agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md && bun run verify:notes`，通过后提交 `docs(purpose): describe versioned request purpose and scoped upgrade`。

---

## 验收清单

- [ ] `semantics.test.ts` 覆盖分类器、普通 block、OMP 门控、缺回复、标题两种形状、已存 title、来源别名/冲突、retained/missing/unsupported。
- [ ] pending 行按版本 2 解释，target 写 2；历史 clean v1 只有显式 `rebuild --session` 才升级。
- [ ] CAS 条件包含 `req_id`、`input_epoch`、`input_revision`、`purpose_target`、`purpose_pending=1`；旧快照写回返回 stale。
- [ ] 抛错重试 3 次；终态 error 清 pending 并消费修订；`markRequestInputTx` 能重新触发。
- [ ] `drainDeriveTx` 内只有一次 `drainRequestPurposesTx` 调用；`drainLegacyPurposeTx` 已删除，迁移与 tick 不双跑。
- [ ] 组内仍有 pending 用途时不发布、不写 clean；用途实际改变才标脏组。
- [ ] derive 不再写 `req_kind` 与 `model_title`，不再从回复形状识别标题；链与工具配对按 `purpose_chain`。
- [ ] 查询保留未知 `req_kind`/`chain_role`；会话标题只取 current 组且用途已结算的行，参与链的未知来源类别同样可以提供用户标题。
- [ ] 页面辅助行只读 `purpose_chain`/`chain_role`，分类器显示判定，未知 kind 显示原始 ID。
- [ ] `bun test`、`bun run typecheck`、`bun run verify:notes` 通过；全程只用合成库。
