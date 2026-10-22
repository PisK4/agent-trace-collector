# ATC 来源投影与字段保真实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行会话缺少上述技能时，逐任务执行相同测试与复核；不虚构技能调用。本文只编排合成回归与来源投影修复，不授权真实库回填、服务切换、push 或提交。每项提交步骤在已获提交授权时执行，否则保留可审阅改动。本文尚未实施任何运行时代码。

**Goal:** 让账本、路由与 hook 三路证据在同一来源投影入口下解释字段、判断完整性并选择事实，使 req、provider model、served 不再互相冒充，部分证据不缩小尝试合计，hook 报告不写成账本语义。

**Architecture:** 新增 `src/sources/raw.ts` 承载原始行写入，新增 `src/sources/projection.ts` 承载 owner 证据收集、完整性判断与事实选择。在线账本、路由、hook 与离线迁移都调用同一个 `projectRequestTx(db, reqId, { now, mappingVersion })`；长期 kind、hook 报告、映射版本、请求修订与历史迁移归 C 批次。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`；不增加第三方运行依赖。

**Spec:** [v2 的来源与在线投影](../../architecture-evolution-v2.md#投影输入完整性与来源冲突)、[投影需要集中回答的问题](../../architecture-evolution-v2.md#来源解释与请求投影)、[联合评审的字段修复范围](../../agent-request-kind-review.md#字段修复必须同时覆盖收敛与历史回填)、[来源完整性反例](../../agent-request-kind-review.md#来源完整性与隐私一致性)、[实施总入口的 B 准入](2026-10-22-atc-evolution-implementation.md#b来源投影)。长期信息、历史迁移与版本报告的落点见 [C 长期信息与重建计划](2026-10-22-atc-durable-rebuild.md)。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL 与单 writer、独立只读连接、原生 JavaScript 页面、不增加第三方运行依赖。
- writer 只允许同步事务，yield 必须在事务外；本批不引入 worker、通用队列或第二套采集链。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。所有验证只连新建临时库与合成对象。
- 监听地址写死 `127.0.0.1`，不读环境变量覆盖；数据目录在仓库外，文件权限 0600、目录 0700。
- 不新增 schema 列；B 只写现有 request、raw_ledger、raw_route、raw_hook 列。长期列、迁移脚本与版本列由 C 交付。
- 不改 `req_kind`、`chain_role`、`derive_version`、`adapter_version`、`redact_version`、`match_version` 与 `attempt_derive_version` 的现有语义。
- 不删除 request_evidence，不重写不可重算结果，不为迁移清空证据或正文。
- 固定上游结构只引用已锁定的 magpie 检出 `开源源码@magpie-2374ffe`；不 fetch、不扩大接入面、不把 magpie 网关策略搬进 ATC。
- 不执行真实数据路径的 maintenance、backfill 或服务启动；不读取真实配置与数据库。

---

## 范围、文件与 Interface

编写基准为 ATC `00e20a2`。下列行号是定位提示；按函数名定位，不把行号当补丁。

| 文件 | 职责与计划改动 |
| --- | --- |
| `src/sources/magpie.ts` | 来源 Adapter：按上游真实键读取，保留字段状态与非法类型；区分 req、provider model、served；Prompt counted 三态 |
| `src/privacy.ts` | 统一隐私对象：account 与 providerAccount 共享稳定占位符，已占位符不重复散列 |
| `src/sources/raw.ts` | 新建：原始行写入与迁移用的 UPDATE helper；在线 INSERT/UPSERT 与离线 UPDATE 共用列清单 |
| `src/sources/projection.ts` | 新建：owner 证据收集、完整性判断、最终尝试与尝试合计、prompt、kind 报告、hook 报告的深 Module |
| `src/reconcile.ts` | 在线账本与路由的全部写入者改穿同一投影入口；删除分散的模型、费用、尝试合计写入 |
| `src/hook.ts` | hook 只落证据与正文，不再把 hook model 写进账本模型列或由 success 合成 HTTP 状态 |
| `tests/magpie.test.ts` | 来源键、类型状态、Prompt counted 的合成正反例 |
| `tests/privacy.test.ts` | account 别名、占位符幂等 |
| `tests/projection.test.ts` | 新建：完整、部分、过期、重复、冲突、hook 独立与离线重放 |
| `tests/reconcile.test.ts` | 在线账本与路由写入路径、到达顺序、脱敏同源、尝试合计保留 |
| `tests/hook.test.ts` | hook 不写账本模型与状态、报告独立、合并后保留账本值 |
| `docs/architecture-design.md` | 代码交付时同步来源读取、模型语义、隐私形态、完整性判断与投影入口 |
| `.agents/notes/implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md` | 实施时创建，记录统一投影的理由、遗留的 C 缺口与代价 |

不新增其它文件。`src/store.ts`、`src/schema.sql`、`src/derive.ts`、`src/queries.ts` 与 `web/` 不在本批范围；长期与迁移改动见 [C 计划](2026-10-22-atc-durable-rebuild.md)。

### 公共 Interface（B 冻结，C 复用）

`src/sources/projection.ts` 导出 `SOURCE_PROJECTION_VERSION`、`ProjectionFamily`、`ProjectionState`、`AttemptOutcome`、`ProjectionReason`、`FamilyProjection`、`SelectedAttempt`、`AttemptProjection`、`PromptProjection`、`SourceKindProjection`、`HookProjection`、`LedgerIdentityProjection`、`RequestProjection`、`PreparedLedgerEvidence`、`PreparedRouteEvidence`、`PreparedHookEvidence`、`PreparedEvidence`、`OwnerEvidence`，以及 `collectOwnerEvidenceTx(db, reqId)` 与 `projectRequestTx(db, reqId, { now, mappingVersion })`。C 的离线迁移只调用同一个入口，不复制选择逻辑；字段与签名的唯一权威定义见 [Task 2 Step 3](#task-2来源投影-module-与-owner-完整性判断)，本文不在别处保留类型副本。

`FamilyProjection.current` 是保留标记。状态不是 complete 时列里是上一次写定的历史值，报告必须把该族标成非 current，读模型不得把旧数当成本次事实；C 的 `projection_meta` retained 状态消费这一标记。顺序不可证时写出的 NULL 是未知，不是 retained，C 不得把这种 NULL 记成历史保留。

`src/sources/raw.ts` 导出 `LedgerPhysicalRef = { generation: string; offset: number }`、`insertPreparedLedgerTx`、`writePreparedLedgerTx`、`upsertPreparedRouteTx`、`writePreparedRouteTx`，payload 参数是字符串。唯一权威签名见 [Task 3 Step 3](#task-3新建原始行-helper-并让账本写入者走投影)；C 只用两个 UPDATE 版本，不 INSERT、不碰 request_evidence、不调用 redact。

### 写入者清单与 C 扩展同一入口的方式

| 写入者 | 当前动作 | B 改动 | C 扩展 |
| --- | --- | --- | --- |
| `reconcile.insertRequest` | 直接写 status、model_requested、model_served、token | 只写身份与初始标题；事实列留 NULL，随后由 `projectRequestTx` 写 | 无需另开入口；C 的历史重建对每个 reqId 调用同一函数 |
| `reconcile.mergeLedgerRow` | 逐行写模型、汇总、尝试合计 | 插入证据后调用 `projectRequestTx`；删除 `applySingleLedger` 与 `applyLedgerAggregate` 的事实选择 | 同一函数；C 另写 families 的长期元信息 |
| `reconcile.ingestRoute` 与 `reconcile.linkRouteIfPresent` | 直接写 prompt 与摘要 | 只挂 route 证据与归属；prompt 由 `projectRequestTx` 写 | 同一函数；C 扩展 route_summary 的长期字段 |
| `hook.insertHookRequest` | 写 model_requested、model_served、由 success 合成 status | 模型列与 status 留 NULL；`raw_hook` 保存 model、success | C 增加 hook 独立长期报告，并对旧行做迁移 |
| `hook.mergeHookInto` | 迁移证据与正文，不迁移模型 | 合并后对目标调用 `projectRequestTx` 刷新 hook 报告 | C 迁移旧账本模型列里的 hook 伪值 |
| 离线迁移 | 当前没有来源重映射入口 | B 提供 `writePreparedLedgerTx`、`writePreparedRouteTx`、`projectRequestTx`，测试直接调用证明在线离线同路 | C 在 `src/migrate-v5.ts` 读脱敏 payload、调用 B mapper 与 UPDATE helper、再调用 `projectRequestTx` |
| 费用同步 | `syncCosts` 写 cost、priced、attempt_cost | 不改；客户端自报 `cost` 只作为 raw 字段映射，不覆盖 API 定价 | C 按实际消费者决定长期字段 |

---

## Task 0：来源 Adapter 读取真实键、类型状态与 Prompt counted

**Files:**
- Modify: `src/sources/magpie.ts:11–61,63–97,99–244`
- Test: `tests/magpie.test.ts`
- Create on implementation: `.agents/notes/implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md`

**Interfaces:**
- Consumes: 现有 `isRecord`、`optionalNumber`、`parseTimestamp`、`localDay`、`normalizeResponseId`。
- Produces: `FieldState`、`CountedState`、`LedgerShape`、`RouteShape`；`LedgerFields` 新增 `err` 与 `shape`；`RouteFields` 新增 `shape`；`mapLedgerRow` 与 `mapRouteRow` 签名不变。

- [ ] **Step 1：添加来源键与类型状态回归。**

```ts
import { mapLedgerRow, mapRouteRow } from '../src/sources/magpie';

test('账本来源字段按req与cost读取并给出类型状态', () => {
  const fields = mapLedgerRow({
    t: '2026-10-20T00:00:00Z', req: 'synthetic-req', model: 'synthetic-provider',
    served: 'synthetic-served', cost: 0, err: 'synthetic error',
    err_type: 'rate_limit', kind: 'compact', account: 'synthetic-account',
  })!;
  expect({
    requested: fields.requested, model: fields.model, served: fields.served,
    ownCost: fields.ownCost, err: fields.err, errType: fields.errType,
    kind: fields.kind, account: fields.account, shape: fields.shape,
  }).toEqual({
    requested: 'synthetic-req', model: 'synthetic-provider', served: 'synthetic-served',
    ownCost: 0, err: 'synthetic error', errType: 'rate_limit', kind: 'compact',
    account: 'synthetic-account',
    shape: {
      req: 'reported', model: 'reported', served: 'reported', cost: 'reported',
      err: 'reported', errType: 'reported', kind: 'reported',
    },
  });
});

test('账本旧键、空串与非法类型分开记录且都不当新值', () => {
  const legacy = mapLedgerRow({ t: '2026-10-20T00:00:00Z', requested: 'legacy', own_cost: 3, ownCost: 4 })!;
  expect([legacy.requested, legacy.ownCost, legacy.shape.req, legacy.shape.cost])
    .toEqual([null, null, 'absent', 'absent']);
  const invalid = mapLedgerRow({
    t: '2026-10-20T00:00:00Z', req: 42, model: {}, served: [], cost: '0', err: [], err_type: true, kind: 7,
  })!;
  expect([invalid.requested, invalid.model, invalid.served, invalid.ownCost, invalid.err, invalid.errType, invalid.kind])
    .toEqual([null, null, null, null, null, null, null]);
  expect(invalid.shape).toEqual({
    req: 'invalid', model: 'invalid', served: 'invalid', cost: 'invalid',
    err: 'invalid', errType: 'invalid', kind: 'invalid',
  });
  const empty = mapLedgerRow({ t: '2026-10-20T00:00:00Z', req: '', kind: '' })!;
  expect([empty.requested, empty.kind, empty.shape.req, empty.shape.kind])
    .toEqual([null, null, 'empty', 'empty']);
});

test('路由Prompt只在校准布尔与tokens合法时给出counted', () => {
  const trueRow = mapRouteRow({ id: 1, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: true } })!;
  expect([trueRow.promptTokens, trueRow.promptCounted, trueRow.shape.promptCounted])
    .toEqual([100, 1, 'true']);
  const falseRow = mapRouteRow({ id: 2, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: false } })!;
  expect([falseRow.promptCounted, falseRow.shape.promptCounted]).toEqual([0, 'false']);
  const omitted = mapRouteRow({ id: 3, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100 } })!;
  expect([omitted.promptCounted, omitted.shape.promptCounted]).toEqual([0, 'absent']);
  const invalid = mapRouteRow({ id: 4, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: 'yes' } })!;
  expect([invalid.promptCounted, invalid.shape.promptCounted]).toEqual([null, 'invalid']);
  const noTokens = mapRouteRow({ id: 5, time: '2026-10-20T00:00:00Z', prompt: { counted: true } })!;
  expect([noTokens.promptTokens, noTokens.promptCounted, noTokens.shape.prompt]).toEqual([null, null, 'invalid']);
  const missing = mapRouteRow({ id: 6, time: '2026-10-20T00:00:00Z' })!;
  expect([missing.promptCounted, missing.shape.prompt, missing.shape.promptCounted])
    .toEqual([null, 'absent', 'absent']);
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/magpie.test.ts -t '账本来源字段|账本旧键|路由Prompt'`。Expected: FAIL，当前 `req`、`cost`、`err` 恒为 null，`shape` 未定义，`counted: true` 被 `optionalNumber` 读成 null。

- [ ] **Step 3：实现字段状态与映射。**

```ts
export type FieldState = 'reported' | 'empty' | 'absent' | 'invalid';
export type CountedState = 'true' | 'false' | 'absent' | 'invalid';

export type LedgerShape = {
  req: FieldState;
  model: FieldState;
  served: FieldState;
  cost: FieldState;
  err: FieldState;
  errType: FieldState;
  kind: FieldState;
};

export type RouteShape = {
  kind: FieldState;
  model: FieldState;
  served: FieldState;
  error: FieldState;
  prompt: 'reported' | 'absent' | 'invalid';
  promptCounted: CountedState;
};

function stringField(row: Record<string, unknown>, key: string): { value: string | null; state: FieldState } {
  if (!Object.hasOwn(row, key)) return { value: null, state: 'absent' };
  const value = row[key];
  if (value === null || value === undefined) return { value: null, state: 'absent' };
  if (typeof value !== 'string') return { value: null, state: 'invalid' };
  if (value.length === 0) return { value: null, state: 'empty' };
  return { value, state: 'reported' };
}

function numberField(row: Record<string, unknown>, key: string): { value: number | null; state: FieldState } {
  if (!Object.hasOwn(row, key)) return { value: null, state: 'absent' };
  const value = row[key];
  if (value === null || value === undefined) return { value: null, state: 'absent' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { value: null, state: 'invalid' };
  return { value, state: 'reported' };
}

type PromptFields = {
  state: 'reported' | 'absent' | 'invalid';
  tokens: number | null;
  counted: 0 | 1 | null;
  countedState: CountedState;
  window: number | null;
  turns: number | null;
  parts: unknown;
};

function promptFields(record: Record<string, unknown>): PromptFields {
  if (!Object.hasOwn(record, 'prompt') || record.prompt === null) {
    return { state: 'absent', tokens: null, counted: null, countedState: 'absent', window: null, turns: null, parts: null };
  }
  if (!isRecord(record.prompt)) {
    return { state: 'invalid', tokens: null, counted: null, countedState: 'invalid', window: null, turns: null, parts: null };
  }
  const prompt = record.prompt;
  const tokens = numberField(prompt, 'tokens');
  if (tokens.value === null || tokens.value < 0) {
    return { state: 'invalid', tokens: null, counted: null, countedState: 'invalid', window: null, turns: null, parts: null };
  }
  let counted: 0 | 1 | null;
  let countedState: CountedState;
  if (!Object.hasOwn(prompt, 'counted')) {
    counted = 0;
    countedState = 'absent';
  } else if (prompt.counted === true) {
    counted = 1;
    countedState = 'true';
  } else if (prompt.counted === false) {
    counted = 0;
    countedState = 'false';
  } else {
    counted = null;
    countedState = 'invalid';
  }
  return {
    state: 'reported', tokens: tokens.value, counted, countedState,
    window: optionalNumber(prompt, 'window'), turns: optionalNumber(prompt, 'turns'), parts: prompt.parts ?? null,
  };
}
```

`LedgerFields` 增加 `err: string | null;` 与 `shape: LedgerShape;`；`mapLedgerRow` 用下列片段替换对应的 `optionalString` 读取：

```ts
const req = stringField(row, 'req');
const model = stringField(row, 'model');
const served = stringField(row, 'served');
const cost = numberField(row, 'cost');
const err = stringField(row, 'err');
const errType = stringField(row, 'err_type');
const kind = stringField(row, 'kind');
const account = stringField(row, 'account');
const providerAccount = stringField(row, 'providerAccount');
// 返回对象中：
requested: req.value,
model: model.value,
served: served.value,
ownCost: cost.value,
err: err.value,
errType: errType.value,
kind: kind.value,
account: account.value ?? providerAccount.value,
shape: {
  req: req.state, model: model.state, served: served.state, cost: cost.state,
  err: err.state, errType: errType.state, kind: kind.state,
},
```

`RouteFields` 增加 `shape: RouteShape;`；`mapRouteRow` 用下列片段替换 `kind`、`model`、`served`、`error` 与 `prompt` 家族的读取：

```ts
const kind = stringField(record, 'kind');
const model = stringField(record, 'model');
const served = stringField(record, 'served');
const error = stringField(record, 'error');
const prompt = promptFields(record);
// 返回对象中：
kind: kind.value,
model: model.value,
served: served.value,
error: error.value,
tokens: prompt.state === 'reported' ? prompt.tokens : optionalNumber(record, 'tokens'),
promptTokens: prompt.state === 'reported' ? prompt.tokens : null,
promptCounted: prompt.state === 'reported' ? prompt.counted : null,
promptWindow: prompt.state === 'reported' ? prompt.window : null,
promptTurns: prompt.state === 'reported' ? prompt.turns : null,
promptParts: prompt.state === 'reported' ? prompt.parts : null,
shape: {
  kind: kind.state, model: model.state, served: served.state, error: error.state,
  prompt: prompt.state, promptCounted: prompt.countedState,
},
```

非法类型不抛错，只把状态记为 `invalid` 并让值保持 null。空串状态是 `empty`，它既不是值也不是撤销。`req` 只读上游 `req`，`cost` 只读上游 `cost`；旧键 `requested`、`own_cost`、`ownCost` 不再作为来源。Provider model 的 `model` 保留在 `LedgerFields.model`，不进入 `requested` 或 `served`。

- [ ] **Step 4：跑最窄测试与类型检查。**

Run: `bun test tests/magpie.test.ts -t '账本来源字段|账本旧键|路由Prompt'`。Expected: PASS。
Run: `bun run typecheck`。Expected: PASS，新增字段后所有消费方仍编译；若旧测试对 `LedgerFields` 做穷尽对象比较，按实际字段补断言，不改生产行为。

- [ ] **Step 5：做 supersession check 并创建 note。** 在 `.agents/notes/implemented/` 与 `proposed/` 搜索覆盖同一决策的旧记录。[proposed 的字段保真提案](../../../.agents/notes/proposed/architecture/2026-10-22-magpie-parity-and-field-fidelity.md) 只记录提案，不是已交付权威；[既有隐私边界](../../../.agents/notes/implemented/architecture/2026-10-20-privacy-and-local-access-boundary.md) 与[账本读数溢出](../../../.agents/notes/implemented/bug-fix/2026-10-21-ledger-readings-overflow.md) 只部分涉及，保持活跃并交叉链接。创建 `2026-10-22-source-projection-and-field-fidelity.md`，`Status: implemented`，正文写：req、provider model、served 三者各自的来源与缺失语义；字段状态不是撤销；counted 的合法省略等于未校准；长期 kind、hook 报告与映射版本交 C，链接 [C 计划](2026-10-22-atc-durable-rebuild.md)；否决的备选是继续用 `optionalString` 合并缺失与非法。获提交授权时提交 `fix(sources): read magpie field keys and shape states`，包含本任务源码、测试与 note，末尾使用规定 attribution。未获授权时保持未暂存；Task 1 起复用同一 note。

## Task 1：统一隐私形态与 account 别名

**Files:**
- Modify: `src/privacy.ts:17–20,52–94,96–105`
- Test: `tests/privacy.test.ts`
- Modify on implementation: Task 0 创建的 note

**Interfaces:**
- Consumes: 现有 `PLACEHOLDER`、`SENSITIVE_KEYS`、`placeholder`、`credentialValue`、`redact`。
- Produces: `placeholder(kind, value, salt)` 对已是稳定占位符的字符串原样返回；`account` 与 `providerAccount` 都按敏感键处理并得到同一稳定占位符。

- [ ] **Step 1：添加别名与幂等回归。**

```ts
test('account别名共享占位符且已脱敏值不再散列', () => {
  const input = { account: 'synthetic-account', providerAccount: 'synthetic-account' };
  const first = redact(input, salt) as Record<string, string>;
  expect(first.account).toMatch(/^\[redacted:credential:[0-9a-f]{16}\]$/);
  expect(first.account).toBe(first.providerAccount);
  expect(redact(first, salt)).toEqual(first);

  const existing = '[redacted:credential:0123456789abcdef]';
  expect(redact({
    account: existing,
    providerAccount: existing,
    headers: { authorization: existing },
  }, salt)).toEqual({
    account: existing,
    providerAccount: existing,
    headers: { authorization: existing },
  });
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/privacy.test.ts -t 'account别名'`。Expected: FAIL，当前 `account` 保持明文，且敏感键分支把已有占位符再散列成另一个 digest。

- [ ] **Step 3：让占位符幂等并归一 account。**

```ts
const SENSITIVE_KEYS = new Set([
  'authorization', 'x-api-key', 'api-key', 'api_key', 'apikey', 'cookie', 'set-cookie',
  'password', 'passwd', 'client_secret', 'secret_key', 'access_token', 'refresh_token',
  'id_token', 'aws_secret_access_key', 'private_key', 'account', 'provideraccount', 'providerkeyid',
]);

function placeholder(kind: string, value: string, salt: Uint8Array): string {
  if (PLACEHOLDER.test(value)) return value;
  const digest = createHmac('sha256', salt).update(kind).update('\0').update(value).digest('hex');
  return `[redacted:${kind}:${digest.slice(0, 16)}]`;
}
```

`account` 与 `providerAccount` 的别名归一不在这里做字符串替换，而是让两者都得到同一 `credential` 占位符；来源 Adapter 在脱敏后的对象上继续用 `account ?? providerAccount` 选择显示值。占位符幂等同时覆盖敏感键分支、请求头分支与普通字符串分支，因为三处都调用同一个 `placeholder`。

- [ ] **Step 4：跑隐私与既有脱敏测试。**

Run: `bun test tests/privacy.test.ts`。Expected: PASS，已有同类同值、白名单头、凭证形态断言保持。
Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 5：更新 note 并提交。** 在 Task 0 的 note 补记：account 与 providerAccount 两个入口使用同一稳定占位符；已脱敏值不二次散列；历史明文修复与变换版本交 C。获授权时提交 `fix(privacy): make account aliases share stable placeholders`，包含本任务文件与 note，使用规定 attribution。

## Task 2：来源投影 Module 与 owner 完整性判断

**Files:**
- Create: `src/sources/projection.ts`
- Test: `tests/projection.test.ts`
- Modify on implementation: Task 0 创建的 note

**Interfaces:**
- Consumes: `LedgerFields`、`RouteFields`、`mapLedgerRow`、`mapRouteRow`、`isRecord`、`localDay`。
- Produces: 本文开头列出的 `projectRequestTx`、`collectOwnerEvidenceTx`、`ProjectionFamily`、`FamilyProjection`、`SelectedAttempt`、`AttemptProjection`、`PromptProjection`、`SourceKindProjection`、`HookProjection`、`LedgerIdentityProjection`、`RequestProjection`、`PreparedEvidence`、`OwnerEvidence`。

- [ ] **Step 1：添加完整、部分、重复、顺序不可证与 hook 独立的投影回归。**

```ts
import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { fixture } from './fixtures';
import {
  SOURCE_PROJECTION_VERSION,
  collectOwnerEvidenceTx,
  projectRequestTx,
} from '../src/sources/projection';
import type { RequestProjection } from '../src/sources/projection';

type TestStore = ReturnType<typeof fixture>['store'];
// 合成代际用真实形状 dev:ino:birthtimeNs:epoch，和 A 的 /^(\d+:\d+:\d+:\d+)\|(\d{20})$/ 一致
const GENERATION = '1:2:3:0';

function seedRequest(store: TestStore, reqId = 1): void {
  // 5 个问号依次绑定 req_id、conv_key、actor、started_ms、day；其余列写字面量或用默认值
  store.write(db => db.run(
    `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
       derive_version,have,created_at,updated_at,req_kind)
     VALUES (?,?,?,'known',?,?, 'through','pending',0,0,1,1,'chat')`,
    [reqId, JSON.stringify(['session', 'synthetic-session']), 'synthetic-actor', 1000, '2026-10-22'],
  ));
}

function addLedgerAt(
  store: TestStore, reqId: number, generation: string, offset: number, row: Record<string, unknown>,
): void {
  const text = typeof row.t === 'string' ? row.t : '2026-10-22T00:00:00Z';
  store.write(db => {
    db.run(
      `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json)
       VALUES ('file',?,?,?,?,'through',?)`,
      [generation, offset, text, Date.parse(text), JSON.stringify(row)],
    );
    // 4 个问号依次是 req_id、source_kind、ref_key、merge_state
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'ledger', JSON.stringify(['file', generation, offset]), 'merged'],
    );
  });
}

function addLedger(store: TestStore, reqId: number, offset: number, row: Record<string, unknown>): void {
  addLedgerAt(store, reqId, GENERATION, offset, row);
}

function addRoute(store: TestStore, reqId: number, routeId: number, row: Record<string, unknown>): void {
  store.write(db => {
    db.run(
      `INSERT INTO raw_route(route_id,time_ms,day,payload_json) VALUES (?,?,?,?)`,
      [routeId, Date.parse(String(row.time)), '2026-10-22', JSON.stringify(row)],
    );
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'route', String(routeId), 'merged'],
    );
  });
}

function addHook(store: TestStore, reqId: number, hookId: string, model: string, success: boolean): void {
  store.write(db => {
    db.run(
      `INSERT INTO raw_hook(hook_id,received_at,protocol,origin,model,success,parse_state)
       VALUES (?,1,'anthropic','local',?,?,'ok')`,
      [hookId, model, success ? 1 : 0],
    );
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'hook', hookId, 'merged'],
    );
  });
}

function project(store: TestStore, reqId: number): RequestProjection {
  return store.write(db => projectRequestTx(db, reqId, { now: 10, mappingVersion: SOURCE_PROJECTION_VERSION }));
}

function facts(store: TestStore, reqId: number) {
  return store.read.query<{
    status: number | null; model_requested: string | null; model_served: string | null;
    in_tok: number | null; attempt_in: number | null; attempt_billed: number | null;
    prompt_tokens: number | null; prompt_counted: number | null; attempt_state: string;
  }, [number]>(`SELECT status,model_requested,model_served,in_tok,attempt_in,attempt_billed,
      prompt_tokens,prompt_counted,attempt_state FROM request WHERE req_id=?`).get(reqId)!;
}
```

```ts
test('完整账本选择最终尝试并分开req与served', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, {
      t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, model: 'provider-a',
      req: 'req-a', in: 10, out: 1, cost: 0.5, err: 'rate limited', err_type: 'rate_limit',
    });
    addLedger(f.store, 1, 100, {
      t: '2026-10-22T00:00:01Z', status: 200, model: 'provider-b',
      req: 'req-b', served: 'served-b', provider: 'p', in: 20, out: 5, cost: 0,
    });
    const p = project(f.store, 1);
    expect(p.attempts).toMatchObject({
      state: 'complete', billed: 2, inTok: 30, outTok: 6, outcome: 'succeeded',
      startMs: Date.parse('2026-10-22T00:00:00Z'),
    });
    expect(p.selected).toMatchObject({
      outcome: 'succeeded',
      fields: { requested: 'req-b', model: 'provider-b', served: 'served-b', ownCost: 0, status: 200 },
    });
    expect(facts(f.store, 1)).toMatchObject({
      status: 200, model_requested: 'req-b', model_served: 'served-b',
      in_tok: 20, attempt_in: 30, attempt_billed: 2, attempt_state: 'known',
    });
  } finally { f.close(); }
});

test('最后一行handed_on为1时保持pending_final且不回头取更早行', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', handed_on: true, status: 429, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toBeNull();
    expect(p.attempts.outcome).toBe('pending_final');
    expect(facts(f.store, 1)).toMatchObject({ status: null, model_requested: null, attempt_state: 'pending_final' });
  } finally { f.close(); }
});

test('最终行失败时selected保留该行并写失败状态', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', status: 500, model: 'provider-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ outcome: 'failed', fields: { status: 500 } });
    expect(facts(f.store, 1)).toMatchObject({ status: 500, attempt_state: 'known' });
  } finally { f.close(); }
});

test('同毫秒同代际按offset证明先后', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:00Z', status: 500, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ outcome: 'failed', fields: { status: 500, requested: 'req-b' } });
    expect(p.attempts.outcome).toBe('failed');
    expect(p.identity.orderState).toBe('provable');
    expect(facts(f.store, 1)).toMatchObject({ status: 500, model_requested: 'req-b', attempt_in: 30 });
  } finally { f.close(); }
});

test('同毫秒跨代际不证明顺序时不发布final且保留合计', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(
      `UPDATE request SET status=200,model_requested='old-req',attempt_in=99,attempt_billed=7 WHERE req_id=1`));
    addLedgerAt(f.store, 1, '1:2:3:0', 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedgerAt(f.store, 1, '1:2:3:1', 0, { t: '2026-10-22T00:00:00Z', status: 500, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toBeNull();
    expect(p.families.selected).toMatchObject({ state: 'conflict', current: false });
    expect(p.reasons).toContain('attempt_order_unprovable');
    expect(p.attempts.outcome).toBe('pending_final');
    // 合计与顺序无关，可以发布；行级最终事实、排序键与响应身份不发布
    expect(facts(f.store, 1)).toMatchObject({
      status: null, model_requested: null, attempt_in: 30, attempt_billed: 2, attempt_state: 'pending_final',
    });
    expect(p.identity.sortKey).toBeNull();
    expect(p.identity.orderState).toBe('unprovable');
    expect(p.identity.responseIdNorm).toBeNull();
  } finally { f.close(); }
});

test('缺req时请求模型为NULL而provider与served各自保留', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, model: 'provider-only', served: 'served-only', in: 5 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ fields: { requested: null, model: 'provider-only', served: 'served-only' } });
    expect(facts(f.store, 1)).toMatchObject({ model_requested: null, model_served: 'served-only' });
  } finally { f.close(); }
});

test('部分raw过期保留旧尝试合计且不缩小不MAX', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(
      `UPDATE request SET attempt_in=30,attempt_billed=2,status=200,model_requested='old-req',
       model_served='old-served',in_tok=20 WHERE req_id=1`));
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', status: 200, req: 'req-b', in: 20 });
    f.store.write(db => {
      db.run(`DELETE FROM raw_ledger WHERE file_generation='1:2:3:0' AND byte_offset=100`);
      db.run(
        `UPDATE request_evidence SET payload_state='expired' WHERE source_kind='ledger' AND ref_key=?`,
        [JSON.stringify(['file', '1:2:3:0', 100])],
      );
    });
    const p = project(f.store, 1);
    expect(p.attempts.state).toBe('partial');
    expect(p.families.attempts.reasons).toContain('ledger_partial');
    // 证据不完整：保留旧键，只有完整但顺序不可证时才清空
    expect(p.identity.orderState).toBe('unknown');
    expect(facts(f.store, 1)).toMatchObject({
      status: 200, model_requested: 'old-req', model_served: 'old-served',
      in_tok: 20, attempt_in: 30, attempt_billed: 2,
    });
  } finally { f.close(); }
});

test('重复尝试嫌疑保留旧值而不翻倍也不MAX', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(`UPDATE request SET attempt_in=30,attempt_billed=2 WHERE req_id=1`));
    const duplicate = { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 30, out: 5 };
    addLedger(f.store, 1, 0, duplicate);
    addLedger(f.store, 1, 100, duplicate);
    const p = project(f.store, 1);
    expect(p.attempts.state).toBe('duplicate');
    expect(p.reasons).toContain('attempt_duplicate_suspect');
    expect(facts(f.store, 1)).toMatchObject({ attempt_in: 30, attempt_billed: 2 });
  } finally { f.close(); }
});

test('后到非法counted保留旧列但报告非current', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, {
      id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact',
      prompt: { tokens: 100, counted: true, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
    });
    let p = project(f.store, 1);
    expect(p.prompt).toMatchObject({ state: 'complete', tokens: 100, counted: 1, window: 200000, turns: 2 });
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    f.store.write(db => db.run(
      `UPDATE request SET prompt_tokens=50,prompt_counted=1,parts_json='[{"kind":"old","tokens":1}]' WHERE req_id=1`));
    f.store.write(db => db.run(
      `UPDATE raw_route SET payload_json=? WHERE route_id=7`,
      [JSON.stringify({ id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact', prompt: { tokens: 100, counted: 'yes' } })],
    ));
    p = project(f.store, 1);
    // 旧列是历史保留，不是本次投影的新事实
    expect(p.prompt.state).toBe('invalid');
    expect(p.families.prompt).toMatchObject({ state: 'invalid', current: false });
    expect(p.reasons).toContain('prompt_retained');
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 50, prompt_counted: 1 });
  } finally { f.close(); }
});

test('当前完整合法route缺Prompt时旧族不再报告complete', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: true } });
    let p = project(f.store, 1);
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    addRoute(f.store, 1, 8, { id: 8, time: '2026-10-22T00:00:05Z', kind: 'compact' });
    p = project(f.store, 1);
    expect(p.families.prompt.state).not.toBe('complete');
    expect(p.families.prompt).toMatchObject({ state: 'absent', current: false });
    expect(p.reasons).toContain('prompt_retained');
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });
  } finally { f.close(); }
});

test('同毫秒的两条route不证明哪条是当前Prompt', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: true } });
    let p = project(f.store, 1);
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    addRoute(f.store, 1, 8, { id: 8, time: '2026-10-22T00:00:00Z', prompt: { tokens: 200, counted: true } });
    p = project(f.store, 1);
    expect(p.prompt.state).toBe('conflict');
    expect(p.families.prompt).toMatchObject({ state: 'conflict', current: false });
    expect(p.reasons).toContain('prompt_order_unprovable');
    // 旧值保留，但不是当前事实
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });
  } finally { f.close(); }
});

test('kind冲突与溢出只给报告且不改req_kind', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 1, kind: 'compact' });
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', kind: 'review' });
    const p = project(f.store, 1);
    expect(p.kind).toMatchObject({ state: 'conflict', merged: null, ledger: ['compact'], route: ['review'] });
    expect(f.store.read.query(`SELECT req_kind FROM request WHERE req_id=1`).get()).toEqual({ req_kind: 'chat' });
  } finally { f.close(); }
});

test('hook报告独立于账本且多模型冲突', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addHook(f.store, 1, 'hook-a', 'hook-model-a', true);
    let p = project(f.store, 1);
    expect(p.hook).toMatchObject({ state: 'present', models: ['hook-model-a'], successes: [true] });
    expect(p.selected).toBeNull();
    expect(facts(f.store, 1)).toMatchObject({ model_requested: null, model_served: null, status: null });

    addHook(f.store, 1, 'hook-b', 'hook-model-b', false);
    p = project(f.store, 1);
    expect(p.hook.state).toBe('conflict');
    expect(p.hook.models).toEqual(['hook-model-a', 'hook-model-b']);
  } finally { f.close(); }
});

test('在线投影重复调用得到相同事实且owner证据完整收集', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', served: 'served-a', in: 10, out: 2 });
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: false } });
    project(f.store, 1);
    const before = facts(f.store, 1);
    f.store.write(db => db.run(`UPDATE request SET status=NULL,model_requested='wrong',prompt_counted=NULL WHERE req_id=1`));
    const again = project(f.store, 1);
    expect(facts(f.store, 1)).toEqual(before);
    expect(again.prompt.counted).toBe(0);
    expect(collectOwnerEvidenceTx(f.store.read, 1).evidence.length).toBe(2);
  } finally { f.close(); }
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/projection.test.ts`。Expected: FAIL，模块尚不存在，import 报错；这是目标失败，fixture 或时区错误不计。

- [ ] **Step 3：实现 Module。** 新建 `src/sources/projection.ts`，完整内容如下。所有 helper 在本文件内定义，不依赖未实现符号。

```ts
import type { Database } from 'bun:sqlite';
import {
  isRecord,
  localDay,
  mapLedgerRow,
  mapRouteRow,
} from './magpie';
import type { LedgerFields, RouteFields } from './magpie';

export const SOURCE_PROJECTION_VERSION = 1;
const MAX_KIND_VALUES_PER_SOURCE = 8;
const MAX_KIND_REPORT_VALUES = 16;
const MAX_HOOK_VALUES = 8;
const MAX_HOOK_BASIS = 16;

export type ProjectionFamily = 'selected' | 'attempts' | 'prompt' | 'kind' | 'hook' | 'identity';
export type ProjectionState = 'complete' | 'partial' | 'expired' | 'absent' | 'invalid' | 'conflict' | 'duplicate';
export type AttemptOutcome = 'succeeded' | 'failed' | 'pending_final';
export type ProjectionReason =
  | 'ledger_present' | 'ledger_partial' | 'ledger_expired' | 'ledger_invalid'
  | 'route_present' | 'route_summary_only' | 'route_absent' | 'route_expired' | 'route_invalid'
  | 'hook_present' | 'hook_expired' | 'hook_conflict'
  | 'kind_conflict' | 'kind_overflow' | 'kind_empty' | 'kind_invalid'
  | 'attempt_final_missing' | 'attempt_duplicate_suspect'
  | 'attempt_order_unprovable' | 'prompt_order_unprovable'
  | 'prompt_absent' | 'prompt_invalid' | 'prompt_retained'
  | 'identity_conflict' | 'identity_partial'
  | 'unsupported_source';

export type FamilyProjection = {
  state: ProjectionState;
  current: boolean;
  version: number;
  basis: string[];
  reasons: ProjectionReason[];
};

export type SelectedAttempt = {
  refKey: string;
  tMs: number;
  outcome: AttemptOutcome;
  fields: LedgerFields;
};

export type AttemptProjection = {
  state: ProjectionState;
  billed: number | null;
  inTok: number | null;
  outTok: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  count: number | null;
  startMs: number | null;
  outcome: AttemptOutcome | null;
};

export type PromptProjection = {
  state: ProjectionState;
  tokens: number | null;
  counted: 0 | 1 | null;
  window: number | null;
  turns: number | null;
  partsJson: string | null;
};

export type SourceKindProjection = {
  state: 'absent' | 'single' | 'merged' | 'conflict' | 'overflow';
  values: string[];
  merged: string | null;
  ledger: string[];
  route: string[];
};

export type HookProjection = {
  state: 'absent' | 'present' | 'expired' | 'conflict';
  models: string[];
  successes: boolean[];
  basis: string[];
};

export type LedgerIdentityProjection = {
  state: ProjectionState;
  // 尝试顺序是否可证：provable 才写排序键，unprovable 时清空排序键，unknown 表示证据不完整
  orderState: 'provable' | 'unprovable' | 'unknown';
  session: string | null;
  nativeSession: string | null;
  agent: string | null;
  subagent: string | null;
  parentAgent: string | null;
  responseIdNorm: string | null;
  startedMs: number | null;
  sortKey: string | null;
};

export type RequestProjection = {
  reqId: number;
  version: number;
  state: ProjectionState;
  selected: SelectedAttempt | null;
  attempts: AttemptProjection;
  prompt: PromptProjection;
  kind: SourceKindProjection;
  hook: HookProjection;
  identity: LedgerIdentityProjection;
  families: Record<ProjectionFamily, FamilyProjection>;
  reasons: ProjectionReason[];
};

export type PreparedLedgerEvidence = {
  kind: 'ledger';
  refKey: string;
  state: 'present' | 'expired' | 'invalid';
  fields: LedgerFields | null;
  tMs: number | null;
  generation: string | null;
  offset: number | null;
};

export type PreparedRouteEvidence = {
  kind: 'route';
  refKey: string;
  state: 'present' | 'expired' | 'invalid';
  fields: RouteFields | null;
  summaryOnly: boolean;
  triesCount: number | null;
};

export type PreparedHookEvidence = {
  kind: 'hook';
  refKey: string;
  state: 'present' | 'expired';
  model: string | null;
  success: boolean | null;
};

export type PreparedEvidence = PreparedLedgerEvidence | PreparedRouteEvidence | PreparedHookEvidence;

export type OwnerEvidence = {
  reqId: number;
  evidence: PreparedEvidence[];
  unsupported: string[];
};

type EvidenceRow = { source_kind: string; ref_key: string; payload_state: string };

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareBytes);
}

function family(
  state: ProjectionState,
  current: boolean,
  version: number,
  basis: string[],
  reasons: ProjectionReason[],
): FamilyProjection {
  return { state, current, version, basis: [...basis].sort(compareBytes), reasons };
}

function familyCurrent(state: ProjectionState): boolean {
  return state === 'complete';
}

function parseLedgerRef(refKey: string): { generation: string; offset: number } | null {
  try {
    const value = JSON.parse(refKey) as unknown;
    if (!Array.isArray(value) || value[0] !== 'file' || typeof value[1] !== 'string' ||
        !Number.isSafeInteger(value[2]) || (value[2] as number) < 0) return null;
    return { generation: value[1], offset: value[2] as number };
  } catch {
    return null;
  }
}

function parseTriesCount(json: string | null): number | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.length : null;
  } catch {
    return null;
  }
}

function invalidLedger(refKey: string, generation: string | null, offset: number | null): PreparedLedgerEvidence {
  return { kind: 'ledger', refKey, state: 'invalid', fields: null, tMs: null, generation, offset };
}

function readLedgerEvidence(db: Database, row: EvidenceRow): PreparedLedgerEvidence {
  const ref = parseLedgerRef(row.ref_key);
  if (ref === null) return invalidLedger(row.ref_key, null, null);
  const raw = db.query<{ payload_json: string }, [string, number]>(
    `SELECT payload_json FROM raw_ledger WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
  ).get(ref.generation, ref.offset);
  if (raw === null) {
    return {
      kind: 'ledger', refKey: row.ref_key,
      state: row.payload_state === 'expired' ? 'expired' : 'invalid',
      fields: null, tMs: null, generation: ref.generation, offset: ref.offset,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.payload_json);
  } catch {
    return invalidLedger(row.ref_key, ref.generation, ref.offset);
  }
  if (!isRecord(parsed)) return invalidLedger(row.ref_key, ref.generation, ref.offset);
  const fields = mapLedgerRow(parsed);
  if (fields === null) return invalidLedger(row.ref_key, ref.generation, ref.offset);
  return {
    kind: 'ledger', refKey: row.ref_key, state: 'present', fields,
    tMs: fields.tMs, generation: ref.generation, offset: ref.offset,
  };
}

function readRouteEvidence(db: Database, row: EvidenceRow): PreparedRouteEvidence {
  const routeId = Number(row.ref_key);
  if (!Number.isSafeInteger(routeId) || routeId < 0) {
    return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
  }
  const raw = db.query<{ payload_json: string }, [number]>(
    `SELECT payload_json FROM raw_route WHERE route_id=?`,
  ).get(routeId);
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.payload_json);
    } catch {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    if (!isRecord(parsed)) {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    const fields = mapRouteRow(parsed);
    if (fields === null) {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    const summary = db.query<{ tries_json: string | null }, [number]>(
      `SELECT tries_json FROM route_summary WHERE route_id=?`,
    ).get(routeId);
    return {
      kind: 'route', refKey: row.ref_key, state: 'present', fields, summaryOnly: false,
      triesCount: fields.tries === null ? parseTriesCount(summary?.tries_json ?? null) : fields.tries.length,
    };
  }
  const summary = db.query<{ tries_json: string | null }, [number]>(
    `SELECT tries_json FROM route_summary WHERE route_id=?`,
  ).get(routeId);
  if (summary !== null) {
    return {
      kind: 'route', refKey: row.ref_key, state: 'present', fields: null,
      summaryOnly: true, triesCount: parseTriesCount(summary.tries_json),
    };
  }
  return {
    kind: 'route', refKey: row.ref_key,
    state: row.payload_state === 'expired' ? 'expired' : 'invalid',
    fields: null, summaryOnly: false, triesCount: null,
  };
}

function readHookEvidence(db: Database, row: EvidenceRow): PreparedHookEvidence {
  const raw = db.query<{ model: string | null; success: number | null }, [string]>(
    `SELECT model,success FROM raw_hook WHERE hook_id=?`,
  ).get(row.ref_key);
  if (raw === null) return { kind: 'hook', refKey: row.ref_key, state: 'expired', model: null, success: null };
  return {
    kind: 'hook', refKey: row.ref_key, state: 'present',
    model: raw.model, success: raw.success === null ? null : raw.success !== 0,
  };
}

export function collectOwnerEvidenceTx(db: Database, reqId: number): OwnerEvidence {
  const rows = db.query<EvidenceRow, [number]>(
    `SELECT source_kind,ref_key,payload_state FROM request_evidence WHERE req_id=? ORDER BY source_kind,ref_key`,
  ).all(reqId);
  const evidence: PreparedEvidence[] = [];
  const unsupported: string[] = [];
  for (const row of rows) {
    if (row.source_kind === 'ledger') evidence.push(readLedgerEvidence(db, row));
    else if (row.source_kind === 'route') evidence.push(readRouteEvidence(db, row));
    else if (row.source_kind === 'hook') evidence.push(readHookEvidence(db, row));
    else unsupported.push(row.source_kind);
  }
  return { reqId, evidence, unsupported };
}

function isLedger(evidence: PreparedEvidence): evidence is PreparedLedgerEvidence {
  return evidence.kind === 'ledger';
}

function isRoute(evidence: PreparedEvidence): evidence is PreparedRouteEvidence {
  return evidence.kind === 'route';
}

function isHook(evidence: PreparedEvidence): evidence is PreparedHookEvidence {
  return evidence.kind === 'hook';
}

function attemptFingerprint(fields: LedgerFields): string {
  return JSON.stringify([
    fields.tMs, fields.responseIdNorm, fields.handedOn, fields.status, fields.stop,
    fields.inTok, fields.outTok, fields.cacheRead, fields.cacheWrite, fields.reasoning,
    fields.model, fields.served, fields.provider, fields.errType, fields.err,
  ]);
}

function duplicateAttempts(rows: LedgerFields[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = attemptFingerprint(row);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function ledgerStateOf(ledgers: PreparedLedgerEvidence[]): ProjectionState {
  if (ledgers.length === 0) return 'absent';
  if (ledgers.some(row => row.state === 'invalid')) return 'invalid';
  const present = ledgers.filter(row => row.state === 'present' && row.fields !== null);
  if (present.length === 0) return 'expired';
  if (present.length < ledgers.length) return 'partial';
  if (duplicateAttempts(present.map(row => row.fields!))) return 'duplicate';
  return 'complete';
}

function compareLedgerEvidence(left: PreparedLedgerEvidence, right: PreparedLedgerEvidence): number {
  return (left.tMs ?? 0) - (right.tMs ?? 0) ||
    compareBytes(left.generation ?? '', right.generation ?? '') ||
    (left.offset ?? 0) - (right.offset ?? 0);
}

type NumericField = 'inTok' | 'outTok' | 'cacheRead' | 'cacheWrite' | 'reasoning';

function sumField(rows: LedgerFields[], key: NumericField): number | null {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

function attemptOutcome(row: LedgerFields): AttemptOutcome {
  if (row.handedOn !== 0) return 'pending_final';
  if (row.status === null) return 'pending_final';
  return row.status >= 400 ? 'failed' : 'succeeded';
}

// 同毫秒只在同一账本代际内用偏移证明先后；跨代际的同毫秒、route_id、hook UUID 都不证明尝试顺序。
function finalCandidate(ledgers: PreparedLedgerEvidence[]): {
  row: PreparedLedgerEvidence | null;
  unprovable: boolean;
} {
  const rows = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence);
  if (rows.length === 0) return { row: null, unprovable: false };
  const latestMs = rows[rows.length - 1]!.tMs;
  const tied = rows.filter(row => row.tMs === latestMs);
  if (tied.length === 1) return { row: tied[0]!, unprovable: false };
  const generation = tied[0]!.generation;
  if (generation === null || tied.some(row => row.generation !== generation)) {
    return { row: null, unprovable: true };
  }
  // 同一代际内偏移单调，最后偏移就是最后追加；tMs 相同不再提供次序。
  return { row: tied[tied.length - 1]!, unprovable: false };
}

function attemptProjection(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
  count: number | null,
): AttemptProjection {
  const empty: AttemptProjection = {
    state, billed: null, inTok: null, outTok: null, cacheRead: null, cacheWrite: null,
    reasoning: null, count, startMs: null, outcome: null,
  };
  if (state !== 'complete') return empty;
  const fields = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence)
    .map(row => row.fields!);
  if (fields.length === 0) return { ...empty, state: 'absent' };
  const final = finalCandidate(ledgers);
  return {
    state, billed: fields.length,
    inTok: sumField(fields, 'inTok'), outTok: sumField(fields, 'outTok'),
    cacheRead: sumField(fields, 'cacheRead'), cacheWrite: sumField(fields, 'cacheWrite'),
    reasoning: sumField(fields, 'reasoning'),
    count, startMs: Math.min(...fields.map(row => row.tMs)),
    // 合计不依赖顺序，仍可发布；顺序不可证时按 pending_final 处理，不发布最终尝试
    outcome: final.row === null ? 'pending_final' : attemptOutcome(final.row.fields!),
  };
}

function selectedAttempt(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
): { attempt: SelectedAttempt | null; unprovable: boolean } {
  if (state !== 'complete') return { attempt: null, unprovable: false };
  const final = finalCandidate(ledgers);
  if (final.unprovable) return { attempt: null, unprovable: true };
  if (final.row === null || final.row.fields!.handedOn !== 0) return { attempt: null, unprovable: false };
  const fields = final.row.fields!;
  return {
    attempt: { refKey: final.row.refKey, tMs: fields.tMs, outcome: attemptOutcome(fields), fields },
    unprovable: false,
  };
}

function uniqueString(values: (string | null)[]): { value: string | null; conflict: boolean } {
  const set = new Set(values.filter((value): value is string => value !== null));
  return { value: set.size === 1 ? [...set][0]! : null, conflict: set.size > 1 };
}

function identityProjection(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
  selected: SelectedAttempt | null,
  orderUnprovable: boolean,
): { projection: LedgerIdentityProjection; conflict: boolean } {
  const empty: LedgerIdentityProjection = {
    state, orderState: 'unknown', session: null, nativeSession: null, agent: null, subagent: null,
    parentAgent: null, responseIdNorm: null, startedMs: null, sortKey: null,
  };
  if (state !== 'complete') return { projection: empty, conflict: false };
  const rows = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence);
  if (rows.length === 0) return { projection: empty, conflict: false };
  const fields = rows.map(row => row.fields!);
  const session = uniqueString(fields.map(row => row.session));
  const agent = uniqueString(fields.map(row => row.agent));
  const subagent = uniqueString(fields.map(row => row.subagent));
  const parentAgent = uniqueString(fields.map(row => row.parentAgent));
  const nativeSession = uniqueString(fields.map(row => row.nativeSession));
  const last = rows[rows.length - 1]!;
  const conflict = session.conflict || agent.conflict || subagent.conflict || parentAgent.conflict || nativeSession.conflict;
  return {
    projection: {
      state: conflict ? 'conflict' : 'complete',
      orderState: orderUnprovable ? 'unprovable' : 'provable',
      session: session.value, nativeSession: nativeSession.value, agent: agent.value,
      subagent: subagent.value, parentAgent: parentAgent.value,
      // session 与 agent 只做集合唯一性判断，和尝试顺序无关；排序键与响应身份依赖最终行，顺序不可证时留空。
      responseIdNorm: orderUnprovable ? null : selected?.fields.responseIdNorm ?? null,
      startedMs: Math.min(...fields.map(row => row.tMs)),
      sortKey: orderUnprovable ? null : `${last.generation ?? ''}|${String(last.offset ?? 0).padStart(20, '0')}`,
    },
    conflict,
  };
}

function promptProjection(routes: PreparedRouteEvidence[]): PromptProjection {
  const empty: PromptProjection = { state: 'absent', tokens: null, counted: null, window: null, turns: null, partsJson: null };
  const present = routes.filter(row => row.state === 'present' && row.fields !== null);
  if (present.length > 0) {
    const latestMs = Math.max(...present.map(row => row.fields!.timeMs));
    const tied = present.filter(row => row.fields!.timeMs === latestMs);
    // 同毫秒的两条 route 无法证明哪条是当前尝试；route_id 只用于遍历，不是先后证据。
    if (tied.length > 1) return { ...empty, state: 'conflict' };
    const fields = tied[0]!.fields!;
    if (fields.shape.prompt === 'reported' && fields.shape.promptCounted !== 'invalid') {
      return {
        state: 'complete', tokens: fields.promptTokens, counted: fields.promptCounted,
        window: fields.promptWindow, turns: fields.promptTurns,
        partsJson: fields.promptParts === null ? null : JSON.stringify(fields.promptParts),
      };
    }
    return { ...empty, state: fields.shape.prompt === 'invalid' ? 'invalid' : 'absent' };
  }
  if (routes.some(row => row.summaryOnly)) return { ...empty, state: 'partial' };
  if (routes.some(row => row.state === 'invalid')) return { ...empty, state: 'invalid' };
  if (routes.some(row => row.state === 'expired')) return { ...empty, state: 'expired' };
  return empty;
}

function kindProjection(
  ledgers: PreparedLedgerEvidence[],
  routes: PreparedRouteEvidence[],
  unsupported: string[],
): { report: SourceKindProjection; reasons: ProjectionReason[] } {
  const ledgerValues = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .map(row => row.fields!.kind)
    .filter((value): value is string => value !== null);
  const routeValues = routes
    .filter(row => row.state === 'present' && row.fields !== null)
    .map(row => row.fields!.kind)
    .filter((value): value is string => value !== null);
  const ledgerAll = uniqueSorted(ledgerValues);
  const routeAll = uniqueSorted(routeValues);
  const ledger = ledgerAll.slice(0, MAX_KIND_VALUES_PER_SOURCE);
  const route = routeAll.slice(0, MAX_KIND_VALUES_PER_SOURCE);
  const values = uniqueSorted([...ledger, ...route]).slice(0, MAX_KIND_REPORT_VALUES);
  const overflow = ledgerAll.length > MAX_KIND_VALUES_PER_SOURCE || routeAll.length > MAX_KIND_VALUES_PER_SOURCE;
  let state: SourceKindProjection['state'];
  if (ledgerAll.length === 0 && routeAll.length === 0) state = 'absent';
  else if (overflow) state = 'overflow';
  else if (ledgerAll.length > 1 || routeAll.length > 1 ||
    (ledgerAll.length === 1 && routeAll.length === 1 && ledgerAll[0] !== routeAll[0])) state = 'conflict';
  else if (ledgerAll.length === 1 && routeAll.length === 1) state = 'merged';
  else state = 'single';
  const merged = state === 'single' || state === 'merged' ? values[0]! : null;
  const reasons: ProjectionReason[] = [];
  if (ledgers.some(row => row.fields !== null && row.fields.shape.kind === 'empty')) reasons.push('kind_empty');
  if (ledgers.some(row => row.fields !== null && row.fields.shape.kind === 'invalid') ||
      routes.some(row => row.fields !== null && row.fields.shape.kind === 'invalid')) reasons.push('kind_invalid');
  if (overflow) reasons.push('kind_overflow');
  if (state === 'conflict') reasons.push('kind_conflict');
  if (unsupported.length > 0) reasons.push('unsupported_source');
  return { report: { state, values, merged, ledger, route }, reasons };
}

function hookProjection(hooks: PreparedHookEvidence[]): { report: HookProjection; reasons: ProjectionReason[] } {
  const present = hooks.filter(row => row.state === 'present');
  const basisAll = uniqueSorted(hooks.map(row => row.refKey));
  const basis = basisAll.slice(0, MAX_HOOK_BASIS);
  if (present.length === 0) {
    return {
      report: { state: hooks.length === 0 ? 'absent' : 'expired', models: [], successes: [], basis },
      reasons: hooks.length === 0 ? [] : ['hook_expired'],
    };
  }
  const modelsAll = uniqueSorted(present.map(row => row.model).filter((value): value is string => value !== null));
  const successesAll = [...new Set(present.map(row => row.success).filter((value): value is boolean => value !== null))]
    .sort((left, right) => Number(left) - Number(right));
  const conflict = modelsAll.length > MAX_HOOK_VALUES || successesAll.length > 2 ||
    basisAll.length > MAX_HOOK_BASIS || modelsAll.length > 1 || successesAll.length > 1;
  return {
    report: {
      state: conflict ? 'conflict' : 'present',
      models: modelsAll.slice(0, MAX_HOOK_VALUES), successes: successesAll.slice(0, 2), basis,
    },
    reasons: conflict ? ['hook_conflict'] : ['hook_present'],
  };
}

function familyReasons(state: ProjectionState): ProjectionReason[] {
  if (state === 'complete') return ['ledger_present'];
  if (state === 'partial') return ['ledger_partial'];
  if (state === 'expired') return ['ledger_expired'];
  if (state === 'invalid') return ['ledger_invalid'];
  if (state === 'duplicate') return ['attempt_duplicate_suspect'];
  return [];
}

function promptReasons(state: ProjectionState, hasRouteEvidence: boolean): ProjectionReason[] {
  if (state === 'complete') return ['route_present'];
  const reasons: ProjectionReason[] = [];
  if (state === 'partial') reasons.push('route_summary_only');
  if (state === 'expired') reasons.push('route_expired');
  if (state === 'invalid') reasons.push('route_invalid', 'prompt_invalid');
  if (state === 'conflict') reasons.push('prompt_order_unprovable');
  if (state === 'absent') reasons.push(hasRouteEvidence ? 'route_present' : 'route_absent', 'prompt_absent');
  if (hasRouteEvidence) reasons.push('prompt_retained');
  return reasons;
}

function buildProjection(db: Database, reqId: number, version: number): RequestProjection {
  const owner = collectOwnerEvidenceTx(db, reqId);
  const ledgers = owner.evidence.filter(isLedger);
  const routes = owner.evidence.filter(isRoute);
  const hooks = owner.evidence.filter(isHook);
  const ledgerBasis = ledgers.map(row => row.refKey);
  const routeBasis = routes.map(row => row.refKey);
  const hookBasis = hooks.map(row => row.refKey);
  const ledgerState = ledgerStateOf(ledgers);
  const final = selectedAttempt(ledgers, ledgerState);
  const selected = final.attempt;
  const attempts = attemptProjection(
    ledgers, ledgerState,
    routes.map(row => row.triesCount).find((value): value is number => value !== null) ?? null,
  );
  const prompt = promptProjection(routes);
  const kind = kindProjection(ledgers, routes, owner.unsupported);
  const hook = hookProjection(hooks);
  const identity = identityProjection(ledgers, ledgerState, selected, final.unprovable);
  const selectedState: ProjectionState = ledgerState === 'complete'
    ? (final.unprovable ? 'conflict' : selected === null ? 'absent' : 'complete')
    : ledgerState;
  const selectedReasons = familyReasons(ledgerState);
  if (final.unprovable) selectedReasons.push('attempt_order_unprovable');
  else if (selected === null) selectedReasons.push('attempt_final_missing');
  const identityReasons: ProjectionReason[] = identity.conflict
    ? ['identity_conflict']
    : identity.projection.state === 'complete' ? [] : ['identity_partial'];
  const kindFamilyState: ProjectionState =
    kind.report.state === 'conflict' || kind.report.state === 'overflow' ? 'conflict'
      : kind.report.state === 'absent' ? 'absent' : 'complete';
  const hookFamilyState: ProjectionState =
    hook.report.state === 'conflict' ? 'conflict'
      : hook.report.state === 'present' ? 'complete'
        : hook.report.state;
  const families: Record<ProjectionFamily, FamilyProjection> = {
    selected: family(selectedState, familyCurrent(selectedState), version, ledgerBasis, selectedReasons),
    attempts: family(attempts.state, familyCurrent(attempts.state), version, ledgerBasis, familyReasons(attempts.state)),
    prompt: family(
      prompt.state, prompt.state === 'complete', version, routeBasis,
      promptReasons(prompt.state, routes.length > 0),
    ),
    kind: family(kindFamilyState, familyCurrent(kindFamilyState), version, [...ledgerBasis, ...routeBasis], kind.reasons),
    hook: family(hookFamilyState, familyCurrent(hookFamilyState), version, hookBasis, hook.reasons),
    identity: family(identity.projection.state, familyCurrent(identity.projection.state), version, ledgerBasis, identityReasons),
  };
  const state: ProjectionState = final.unprovable
    ? 'conflict'
    : ledgerState !== 'absent'
      ? ledgerState
      : prompt.state !== 'absent' ? prompt.state : hook.report.state;
  const reasons = [...new Set(Object.values(families).flatMap(row => row.reasons))];
  return {
    reqId, version, state, selected, attempts, prompt,
    kind: kind.report, hook: hook.report, identity: identity.projection, families, reasons,
  };
}

function writeProjectionTx(db: Database, reqId: number, projection: RequestProjection, now: number): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (projection.families.attempts.basis.length > 0) sets.push('have=have|2');
  if (projection.attempts.state === 'complete') {
    const fields = projection.selected?.fields ?? null;
    sets.push(
      'status=?', 'stop=?', 'model_requested=?', 'model_served=?', 'provider=?', 'response_id_norm=?',
      'in_tok=?', 'out_tok=?', 'cache_read=?', 'cache_write=?', 'reasoning=?',
      'ms=?', 'ttft_ms=?', 'flow_ms=?', 'first_text_ms=?', 'started_ms=?', 'day=?',
      'attempt_billed=?', 'attempt_in=?', 'attempt_out=?', 'attempt_cache_read=?',
      'attempt_cache_write=?', 'attempt_reasoning=?',
      "attempt_state=CASE WHEN ?='pending_final' THEN 'pending_final' WHEN attempt_state='not_applicable' THEN attempt_state ELSE 'known' END",
      'magpie_version=COALESCE(?,magpie_version)',
    );
    params.push(
      fields?.status ?? null, fields?.stop ?? null, fields?.requested ?? null, fields?.served ?? null,
      fields?.provider ?? null, fields?.responseIdNorm ?? null,
      fields?.inTok ?? null, fields?.outTok ?? null, fields?.cacheRead ?? null,
      fields?.cacheWrite ?? null, fields?.reasoning ?? null,
      fields?.ms ?? null, fields?.ttftMs ?? null, fields?.flowMs ?? null, fields?.firstTextMs ?? null,
      projection.identity.startedMs!, localDay(projection.identity.startedMs!),
      projection.attempts.billed!, projection.attempts.inTok, projection.attempts.outTok,
      projection.attempts.cacheRead, projection.attempts.cacheWrite, projection.attempts.reasoning,
      projection.attempts.outcome ?? 'pending_final', fields?.magpieVersion ?? null,
    );
  }
  if (projection.attempts.count !== null) {
    sets.push('attempt_count=COALESCE(?,attempt_count)');
    params.push(projection.attempts.count);
  }
  if (projection.families.prompt.current) {
    sets.push('prompt_tokens=?', 'prompt_counted=?', 'prompt_window=?', 'prompt_turns=?', 'parts_json=?');
    params.push(
      projection.prompt.tokens, projection.prompt.counted,
      projection.prompt.window, projection.prompt.turns, projection.prompt.partsJson,
    );
  }
  if (sets.length === 0) return;
  sets.push('updated_at=?');
  params.push(now, reqId);
  db.run(`UPDATE request SET ${sets.join(',')} WHERE req_id=?`, params);
}

export function projectRequestTx(
  db: Database,
  reqId: number,
  input: { now: number; mappingVersion: number },
): RequestProjection {
  const projection = buildProjection(db, reqId, input.mappingVersion);
  writeProjectionTx(db, reqId, projection, input.now);
  return projection;
}
```

语义要点：

- `collectOwnerEvidenceTx` 读 `request_evidence` 的每一行，包括 `payload_state='present'` 与 `expired`，不只看存活 raw。账本按物理 ref 重读 redacted payload 并重新映射；route 允许只有 `route_summary` 的 summaryOnly；hook 从 `raw_hook` 读 model 与 success。
- 账本状态：全 present 且无重复嫌疑才是 complete；有 expired 为 partial；全过期为 expired；任一 ref 非法为 invalid；同物理证据出现相同尝试指纹为 duplicate。duplicate 与 partial 都不重算最终值或尝试合计。
- 最终尝试先解顺序再解终态。按 `(t_ms, generation 字节序, offset)` 排序只为稳定遍历；最大 `t_ms` 唯一时，它就是时间上的最后一次尝试。最大 `t_ms` 有多行时，只有同一 generation 内的不同 offset 能证明先后，跨 generation 的同毫秒一律不可证：selected 为 null、selected 族状态 conflict、原因带 `attempt_order_unprovable`，attempts 只发布与顺序无关的合计，outcome 写 pending_final，不发布 final，行级最终事实写 NULL 且 `orderState` 为 unprovable，写者据此清空 sort_source 与 sort_key。route_id 与 hook UUID 只用于遍历，不证明尝试顺序。顺序可证时，最后一行 handed_on=1 为 pending_final，不回头取更早的非 handed_on 行；最终行 status 缺失也是 pending_final，status>=400 是 failed，2xx/3xx 是 succeeded。
- prompt 只由最大 `time_ms` 唯一的那条 present 原始 route 决定，与到达顺序无关。该 route 的 Prompt 合法且有合法 counted（true、false、省略）才 complete：true 写 1，false 与合法省略写 0，并且整族直接覆盖旧列。多条 present route 共享同一最大 `time_ms` 时无法证明哪条是当前尝试，族状态 conflict、原因带 `prompt_order_unprovable`，旧整族保留不重写且 current=false；route_id 只用于遍历，不是先后证据。该 route 的 Prompt 缺失、非法或 counted 非法时，族状态是 absent 或 invalid，旧整族作为历史保留不重写，`families.prompt.current` 为 false，原因里带 `prompt_retained`。只有 summary 的 route 是 partial，过期是 expired；这些都不写列。
- `FamilyProjection.current` 表示这一族的列是否由本次投影的完整当前证据写定。selected、attempts、prompt、identity 的 current 等于族状态为 complete；hook 的 current 等于 `present`；kind 的 current 表示来源用途报告可用（single 或 merged），它只说明来源用途，不确认模型族，模型事实只来自 selected 完整时的投影。任何后到的 invalid、absent、expired、partial、conflict、duplicate 都保持旧列但把 current 置 false，读模型因此不会把历史保留值当成新事实。C 用这一标记落 `projection_meta` 的 retained 状态。
- kind 每来源独立稳定去重并各截 8 个；整体报告最多 16 个。任一来源超过 8 个即 overflow 且 merged 为 null；多值或两源不同为 conflict；空串与非法类型只记原因，不作为值也不当撤销。
- hook 报告只包含 `raw_hook` 的 model 与 success 去重集合；不选单条、不按到达或时间覆盖；多值或超界为 conflict。
- identity 只在账本完整时更新：session、agent、subagent、parentAgent、nativeSession 对全部 present 行取非空唯一值，出现不同值即 conflict 并保留旧值（这些集合事实与尝试顺序无关）；startedMs 取最小 tMs；`orderState` 记录顺序是否可证，只有 `provable` 才写 sort_source/sort_key 与 responseIdNorm，`unprovable` 时清空 sort_source/sort_key，`unknown`（证据不完整）时保留旧键并由 C 标成非 current。partial 与 duplicate 不写这些字段。
- `projectRequestTx` 只写现有 request 列；kind、hook、families、identity 的 nativeSession 只返回，不落库。B 不写 request.req_kind，不写任何长期版本列。

- [ ] **Step 4：跑来源投影测试。**

Run: `bun test tests/projection.test.ts`。Expected: PASS，全部断言包含完整、partial、duplicate、pending_final、failed、kind 冲突、hook 冲突、prompt 非法保留与重复调用一致。
Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 5：更新 note 并提交。** note 补记完整投影与部分投影的分界、重复尝试指纹、pending_final 与 failed 的差别、hook 报告的集合语义，以及后到 invalid 或 absent 时保留旧列但一律 `current=false` 并带 retained 原因的历史保留政策。获授权时提交 `feat(sources): add owner-complete request projection`，包含本任务源码、测试与 note，使用规定 attribution。

## Task 3：新建原始行 helper 并让账本写入者走投影

**Files:**
- Create: `src/sources/raw.ts`
- Modify: `src/reconcile.ts:23–607`
- Test: `tests/reconcile.test.ts`
- Modify on implementation: Task 0 创建的 note

**Interfaces:**
- Consumes: Task 2 的 `projectRequestTx`、`SOURCE_PROJECTION_VERSION`；现有 `FileBatch`、`Store`、`redact`。
- Produces: 本文开头列出的 `insertPreparedLedgerTx`、`writePreparedLedgerTx`、`upsertPreparedRouteTx`、`writePreparedRouteTx`、`LedgerPhysicalRef`；`reconcile` 内部 `projectLedgerRequestTx`、`applyLedgerOwnershipTx`。

- [ ] **Step 1：添加在线写入路径回归。**

```ts
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';

test('账本req与served分别落列而provider model不冒充请求模型', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', session: 'sess-a',
      req: 'req-model', model: 'provider-model', served: 'served-model',
      provider: 'p', status: 200, in: 10, out: 5,
    }]), 1, salt);
    expect(f.store.read.query(
      'SELECT status,model_requested,model_served,in_tok,attempt_in,attempt_billed FROM request',
    ).get()).toEqual({
      status: 200, model_requested: 'req-model', model_served: 'served-model',
      in_tok: 10, attempt_in: 10, attempt_billed: 1,
    });
    expect(f.store.read.query('SELECT model FROM raw_ledger').get()).toEqual({ model: 'provider-model' });
  } finally {
    f.close();
  }
});

test('缺req保持NULL且不拿provider model补齐', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 8, agent: 'demo', session: 'sess-a',
      model: 'provider-only', provider: 'p', status: 200, in: 4,
    }]), 1, salt);
    expect(f.store.read.query('SELECT model_requested,model_served FROM request').get())
      .toEqual({ model_requested: null, model_served: null });
  } finally {
    f.close();
  }
});

test('账本行与payload来自同一脱敏对象且未知键保留', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 9, agent: 'demo', session: 'sess-a',
      account: 'synthetic-account', providerAccount: 'synthetic-account',
      future_field: { note: 'Bearer synthetic-secret-123' },
      future_nested: { authorization: 'synthetic-secret-456' },
      model: 'm', provider: 'p', status: 200, in: 1,
    }]), 1, salt);
    const row = f.store.read.query<{ account: string; payload_json: string }>(
      'SELECT account,payload_json FROM raw_ledger').get()!;
    expect(row.account).toMatch(/^\[redacted:credential:[0-9a-f]{16}\]$/);
    expect(row.payload_json).not.toContain('synthetic-secret-123');
    expect(row.payload_json).not.toContain('synthetic-secret-456');
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload.account).toBe(row.account);
    expect(payload.providerAccount).toBe(row.account);
    expect(JSON.stringify(payload)).toContain('future_field');
    expect(JSON.stringify(payload)).toContain('future_nested');
    // 普通字符串里的令牌走形态规则，敏感键走 credential 占位符
    expect(JSON.stringify(payload)).toContain('[redacted:bearer:');
    expect(JSON.stringify(payload)).toContain('[redacted:credential:');
  } finally {
    f.close();
  }
});

test('部分raw过期后旧尝试合计不缩小', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 10, agent: 'demo', session: 's', handed_on: true, status: 429, model: 'm', provider: 'p', in: 10 },
      { t: '2026-10-20T00:00:01Z', route_id: 10, agent: 'demo', session: 's', status: 200, model: 'm', provider: 'p', in: 20 },
    ]), 1, salt);
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 30, attempt_billed: 2 });
    f.store.write(db => {
      db.run(`DELETE FROM raw_ledger WHERE file_generation='1:2:3:0' AND byte_offset=100`);
      db.run(
        `UPDATE request_evidence SET payload_state='expired' WHERE source_kind='ledger' AND ref_key=?`,
        [JSON.stringify(['file', '1:2:3:0', 100])],
      );
      const projection = projectRequestTx(db, 1, { now: 3, mappingVersion: SOURCE_PROJECTION_VERSION });
      expect(projection.attempts.state).toBe('partial');
      expect(projection.families.attempts).toMatchObject({ state: 'partial', current: false });
      expect(projection.reasons).toContain('ledger_partial');
    });
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 30, attempt_billed: 2 });
  } finally {
    f.close();
  }
});

test('后到非法账本行保留旧尝试合计并报告非current', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200, in: 10,
    }]), 1, salt);
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 10, attempt_billed: 1 });
    f.store.write(db => {
      db.run(
        `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json)
         VALUES ('file','1:2:3:0',500,'not-a-time',0,'through','{}')`,
      );
      db.run(
        `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (1,'ledger',?,'merged',1)`,
        [JSON.stringify(['file', '1:2:3:0', 500])],
      );
      const projection = projectRequestTx(db, 1, { now: 4, mappingVersion: SOURCE_PROJECTION_VERSION });
      expect(projection.attempts.state).toBe('invalid');
      expect(projection.families.attempts).toMatchObject({ state: 'invalid', current: false });
      expect(projection.reasons).toContain('ledger_invalid');
    });
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 10, attempt_billed: 1 });
  } finally {
    f.close();
  }
});

test('同毫秒跨代际不证明顺序时清空排序键', () => {
  const f = fixture();
  try {
    const row = (status: number, inTok: number) => ({
      t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', session: 's',
      model: 'm', provider: 'p', status, in: inTok,
    });
    ingestLedger(f.store, 'usage.jsonl', batchOf([row(200, 10)], '1:2:3:0'), 1, salt);
    expect(f.store.read.query('SELECT sort_source,sort_key,attempt_in FROM request').get())
      .toEqual({ sort_source: 'ledger', sort_key: '1:2:3:0|00000000000000000000', attempt_in: 10 });
    ingestLedger(f.store, 'usage-2.jsonl', batchOf([row(500, 20)], '1:2:3:1'), 2, salt);
    // 两行同毫秒且跨代际：不发布 final，清空排序键，避免 A 只看一把 key 就当成可证顺序
    expect(f.store.read.query(
      'SELECT status,model_requested,sort_source,sort_key,attempt_in,attempt_billed,attempt_state FROM request',
    ).get()).toEqual({
      status: null, model_requested: null, sort_source: null, sort_key: null,
      attempt_in: 30, attempt_billed: 2, attempt_state: 'pending_final',
    });
  } finally {
    f.close();
  }
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/reconcile.test.ts -t '账本req与served|缺req保持NULL|同一脱敏对象|部分raw过期|后到非法账本行|清空排序键'`。Expected: FAIL，当前 `model_requested` 取 model、`served` 回退 model、`req` 与 `account` 未读、聚合在 raw 缺失时用部分行重算、排序键永远写 ledger 位置。

- [ ] **Step 3：新建 raw helper。**

```ts
import type { Database } from 'bun:sqlite';
import type { LedgerFields, RouteFields } from './magpie';

export type LedgerPhysicalRef = { generation: string; offset: number };

function ledgerColumns(fields: LedgerFields, payloadJson: string): (string | number | null)[] {
  return [
    fields.routeId, fields.tText, fields.tMs, fields.source, fields.handedOn, fields.kind,
    fields.agent, fields.provider, fields.host, fields.account, fields.model, fields.requested, fields.served,
    fields.inTok, fields.outTok, fields.cacheRead, fields.cacheWrite, fields.reasoning, fields.effort,
    fields.ms, fields.status, fields.stop, fields.responseId, fields.responseIdNorm, fields.rid, fields.ep,
    fields.session, fields.nativeSession, fields.subagent, fields.parentAgent,
    fields.ttftMs, fields.flowMs, fields.firstTextMs, fields.sentMs, fields.retriedMs, fields.queuedMs,
    fields.ownMs, fields.reasoningHidden, fields.tierAsked, fields.tierSent, fields.tierServed,
    fields.errType, fields.computer, fields.via, fields.archive, fields.tries, fields.credits,
    fields.ownCost, fields.magpieVersion, payloadJson,
  ];
}

const LEDGER_COLUMNS = `route_id,t_text,t_ms,source,handed_on,kind,agent,provider,host,account,model,requested,served,
  in_tok,out_tok,cache_read,cache_write,reasoning,effort,ms,status,stop,response_id,response_id_norm,rid,ep,
  session,native_session,subagent,parent_agent,ttft_ms,flow_ms,first_text_ms,sent_ms,retried_ms,queued_ms,
  own_ms,reasoning_hidden,tier_asked,tier_sent,tier_served,err_type,computer,via,archive,tries,credits,
  own_cost,magpie_version,payload_json`;

export function insertPreparedLedgerTx(
  db: Database, ref: LedgerPhysicalRef, fields: LedgerFields, payloadJson: string,
): boolean {
  const placeholders = LEDGER_COLUMNS.split(',').map(() => '?').join(',');
  return db.run(
    `INSERT OR IGNORE INTO raw_ledger(source_kind,file_generation,byte_offset,${LEDGER_COLUMNS})
     VALUES ('file',?,?,${placeholders})`,
    ['file', ref.generation, ref.offset, ...ledgerColumns(fields, payloadJson)],
  ).changes > 0;
}

export function writePreparedLedgerTx(
  db: Database, ref: LedgerPhysicalRef, fields: LedgerFields, payloadJson: string,
): boolean {
  const assignments = LEDGER_COLUMNS.split(',').map(column => `${column}=?`).join(',');
  return db.run(
    `UPDATE raw_ledger SET ${assignments}
     WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
    [...ledgerColumns(fields, payloadJson), ref.generation, ref.offset],
  ).changes > 0;
}

function routeColumns(route: RouteFields, payloadJson: string): (string | number | null)[] {
  return [
    route.routeId, route.timeMs, route.day, route.agent, route.session, route.conv, route.folder,
    route.subagentId, route.kind, route.forJson, route.model, route.provider, route.served, route.effort,
    route.status, route.error, route.done, route.ms, route.ttft, route.firstText, route.flow,
    route.tokens, route.outTok, route.reasoning, payloadJson, route.magpieVersion,
  ];
}

const ROUTE_COLUMNS = `route_id,time_ms,day,agent,session,conv,folder,subagent_id,kind,for_json,model,provider,served,effort,
  status,error,done,ms,ttft,first_text,flow,tokens,out_tok,reasoning,payload_json,magpie_version`;

export function upsertPreparedRouteTx(db: Database, route: RouteFields, payloadJson: string): void {
  const placeholders = ROUTE_COLUMNS.split(',').map(() => '?').join(',');
  db.run(
    `INSERT INTO raw_route(${ROUTE_COLUMNS}) VALUES (${placeholders})
     ON CONFLICT(route_id) DO UPDATE SET
       time_ms=excluded.time_ms,day=excluded.day,agent=excluded.agent,session=excluded.session,conv=excluded.conv,
       folder=excluded.folder,subagent_id=excluded.subagent_id,kind=excluded.kind,for_json=excluded.for_json,
       model=excluded.model,provider=excluded.provider,served=excluded.served,effort=excluded.effort,
       status=excluded.status,error=excluded.error,done=excluded.done,ms=excluded.ms,ttft=excluded.ttft,
       first_text=excluded.first_text,flow=excluded.flow,tokens=excluded.tokens,out_tok=excluded.out_tok,
       reasoning=excluded.reasoning,payload_json=excluded.payload_json,magpie_version=excluded.magpie_version`,
    routeColumns(route, payloadJson),
  );
}

export function writePreparedRouteTx(
  db: Database, routeId: number, route: RouteFields, payloadJson: string,
): boolean {
  const assignments = ROUTE_COLUMNS.split(',').filter(column => column !== 'route_id')
    .map(column => `${column}=?`).join(',');
  const values = routeColumns(route, payloadJson).slice(1);
  return db.run(
    `UPDATE raw_route SET ${assignments} WHERE route_id=?`,
    [...values, routeId],
  ).changes > 0;
}
```

`writePreparedLedgerTx` 与 `writePreparedRouteTx` 只 UPDATE 既有行，不 INSERT、不碰 `request_evidence`、不调用 `redact`，因此 C 的迁移可以复用同一列清单而不复制 SQL。

- [ ] **Step 4：让账本写入者调用投影。**

`src/reconcile.ts` 删除 `RAW_LEDGER_INSERT`、`sumOrNull`、`applySingleLedger` 与 `applyLedgerAggregate`，改用以下结构与函数。

```ts
import {
  insertPreparedLedgerTx,
  upsertPreparedRouteTx,
  type LedgerPhysicalRef,
} from './sources/raw';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from './sources/projection';
import type { RequestProjection } from './sources/projection';

function projectLedgerRequestTx(db: Database, reqId: number, now: number): RequestProjection {
  return projectRequestTx(db, reqId, { now, mappingVersion: SOURCE_PROJECTION_VERSION });
}

function applyLedgerOwnershipTx(
  db: Database,
  reqId: number,
  fields: LedgerFields,
  projection: RequestProjection,
  now: number,
): void {
  const current = currentRequest(db, reqId);
  const identity = projection.identity;
  const session = identity.state === 'complete' ? identity.session : null;
  const subagent = identity.state === 'complete' ? identity.subagent : null;
  const actor = subagent ?? session ?? null;
  const conv = session !== null && (current.conv_source === 'request' || current.conv_source === null)
    ? { key: JSON.stringify(['session', session]), source: 'session' }
    : null;
  const started = identity.startedMs ?? fields.tMs;
  // 完整证据但顺序不可证：清空排序键，否则 A 只看一把 key，会把别的代际尝试误当可证顺序。
  // 证据不完整（orderState='unknown'）时保留旧键；那一组由 C 的读模型标成非 current 并保守处理。
  const clearSort = identity.orderState === 'unprovable';
  const setSort = identity.orderState === 'provable' && identity.sortKey !== null;
  const titleModel = projection.selected?.fields.model ?? projection.selected?.fields.served
    ?? fields.model ?? fields.served;
  const title = current.title === null || current.title_source === 'model_time'
    ? modelTimeTitle(titleModel, started)
    : current.title;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), agent=COALESCE(agent,?), subagent=COALESCE(subagent,?), parent_agent=COALESCE(parent_agent,?),
       conv_key=COALESCE(?,conv_key), conv_source=COALESCE(?,conv_source),
       actor=CASE WHEN actor_state='known' THEN actor ELSE ? END,
       actor_state=CASE WHEN actor_state='known' THEN actor_state ELSE ? END,
       sort_source=CASE WHEN ?=1 THEN NULL WHEN ?=1 THEN 'ledger' ELSE sort_source END,
       sort_key=CASE WHEN ?=1 THEN NULL WHEN ?=1 THEN ? ELSE sort_key END,
       title=?, title_source=?, updated_at=?, have=have|2
     WHERE req_id=?`,
    [
      session, identity.agent, subagent, identity.parentAgent,
      conv?.key ?? null, conv?.source ?? null,
      actor, actor === null ? 'unknown' : 'known',
      clearSort ? 1 : 0, setSort ? 1 : 0, clearSort ? 1 : 0, setSort ? 1 : 0, identity.sortKey,
      title, current.title_source ?? 'model_time', now, reqId,
    ],
  );
  // 身份确认后，这一组要重算前驱、增量与标题；未知归属不入队。
  const settled = db.query<{ conv_key: string | null; actor: string | null; actor_state: string }, [number]>(
    'SELECT conv_key, actor, actor_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (settled?.conv_key != null && settled.actor !== null && settled.actor_state === 'known') {
    enqueueDeriveTx(db, settled.conv_key, settled.actor, '');
  }
}
```

`insertRequest` 的身份与必填列保持原样，但把 `status`、`stop`、`model_requested`、`model_served`、`provider`、`in_tok`、`out_tok`、`cache_read`、`cache_write`、`reasoning`、`ms`、`ttft_ms`、`flow_ms`、`first_text_ms` 改传 `null`，由紧随其后的投影写入。`attempt_state` 仍传 `'known'`（末次尝试不是终行时投影再改成 `pending_final`），`cost_reason` 仍按 `via === 'rejected' ? 'not_applicable' : null` 传入。`insertRequest` 也不再接收 `sortKey`（`mergeLedgerRow` 一并去掉该参数）：INSERT 时 `sort_source` 与 `sort_key` 留 NULL，排序键只在投影顺序可证时由 `applyLedgerOwnershipTx` 写入，顺序不可证时由它清空，避免用任意一行的物理位置冒充分组次序。

`mergeLedgerRow` 改为：插入请求（如需）与账本证据后，先调用 `linkRouteIfPresent` 挂 route 证据，再调用 `projectLedgerRequestTx`，最后调用 `applyLedgerOwnershipTx` 与原有 `enqueueDeriveTx`；`sortKey` 不再由调用方拼好传入，排序键只由投影在顺序可证时给出。`linkRouteIfPresent` 与 `mergeLedgerRow` 各调用一次投影，投影幂等，重复调用不改变结果。`ingestLedger` 改为先 `redact(parsed, salt)` 并把结果保留为 `payloadJson` 的对象，再 `mapLedgerRow(redacted)`；raw 列、payload 与投影都只来自这个 redacted 对象。`insertPreparedLedgerTx` 的 `ref` 取 `{ generation: batch.generation, offset: line.offset }`。

```ts
const redacted = redact(parsed, salt);
if (!isRecord(redacted)) {
  recordIssue(db, 'ledger', refKey, 'ledger_invalid_redaction', now, line.end - line.offset);
  invalid += 1;
  continue;
}
const fields = mapLedgerRow(redacted);
if (fields === null) {
  recordIssue(db, 'ledger', refKey, 'ledger_invalid_time', now, line.end - line.offset);
  invalid += 1;
  continue;
}
const payloadJson = JSON.stringify(redacted);
const inserted = insertPreparedLedgerTx(db, { generation: batch.generation, offset: line.offset }, fields, payloadJson);
if (!inserted) { duplicate += 1; continue; }
mergeLedgerRow(db, fields, refKey, now);
accepted += 1;
```

- [ ] **Step 5：跑账本路径与类型检查。**

Run: `bun test tests/reconcile.test.ts`。Expected: PASS，既有两条计费行、乱序、暂停缺口、淘汰墓碑断言保持；新增 req、served、缺 req、同源脱敏与部分过期断言通过。
Run: `bun run typecheck`。Expected: PASS。
Run: `rg -n 'applySingleLedger|applyLedgerAggregate|sumOrNull|RAW_LEDGER_INSERT' src tests`。Expected: 无命中。

获授权时提交 `refactor(reconcile): project ledger facts through one entry`，包含本任务文件与 note，使用规定 attribution。

## Task 4：路由写入、长期摘要与到达顺序统一

**Files:**
- Modify: `src/reconcile.ts:314–357,495–579`
- Test: `tests/reconcile.test.ts`
- Modify on implementation: Task 0 创建的 note

**Interfaces:**
- Consumes: Task 3 的 `upsertPreparedRouteTx`、`writePreparedRouteTx`、`projectLedgerRequestTx`；Task 2 的 `projectRequestTx`。
- Produces: `reconcile` 内部 `attachRouteEvidenceTx`、`applyRouteOwnershipTx`；`saveRouteSummary(db, route: RouteFields, now: number): void`（不再接收 `redactedError`）。

- [ ] **Step 1：添加路由字段、脱敏同源与到达顺序回归。**

```ts
import { zstdDecompressSync } from 'node:zlib';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';

function routeSummaryText(f: ReturnType<typeof fixture>, routeId: number): string {
  const row = f.store.read.query<{ z: Uint8Array }, [number]>(
    'SELECT z FROM route_summary WHERE route_id=?').get(routeId)!;
  return zstdDecompressSync(row.z).toString('utf8');
}

test('路由列、payload与长期摘要来自同一脱敏对象', () => {
  const f = fixture();
  try {
    ingestRoute(f.store, [{
      id: 7, time: '2026-10-20T00:00:00Z', agent: 'demo', session: 's', model: 'm', provider: 'p',
      status: 200, error: 'failed sk-synthetic-abcdefgh',
      tries: [{ provider: 'p', model: 'm', error: 'Bearer synthetic-secret-123' }],
      prompt: { tokens: 100, counted: true, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
    }], 1, salt);
    const raw = f.store.read.query<{ error: string; payload_json: string }>(
      'SELECT error,payload_json FROM raw_route WHERE route_id=7').get()!;
    expect(raw.error).toContain('[redacted:api_key:');
    expect(raw.payload_json).not.toContain('sk-synthetic-abcdefgh');
    const text = routeSummaryText(f, 7);
    expect(text).not.toContain('sk-synthetic-abcdefgh');
    expect(text).not.toContain('synthetic-secret-123');
    expect(JSON.parse(text)).toMatchObject({ error: raw.error });
  } finally {
    f.close();
  }
});

test('counted布尔与合法省略映射为且仅为0或1', () => {
  for (const [counted, expected] of [[true, 1], [false, 0], [undefined, 0]] as const) {
    const f = fixture();
    try {
      ingestRoute(f.store, [{
        id: 7, time: '2026-10-20T00:00:00Z', agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200,
        prompt: { tokens: 100, ...(counted === undefined ? {} : { counted }) },
      }], 1, salt);
      ingestLedger(f.store, 'usage.jsonl', batchOf([{
        t: '2026-10-20T00:00:01Z', route_id: 7, agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200, in: 1,
      }]), 2, salt);
      expect(f.store.read.query('SELECT prompt_tokens,prompt_counted FROM request').get())
        .toEqual({ prompt_tokens: 100, prompt_counted: expected });
    } finally {
      f.close();
    }
  }
});

test('非法counted不写prompt族且保留旧值并报告非current', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200, in: 1,
    }]), 1, salt);
    f.store.write(db => db.run(
      `UPDATE request SET prompt_tokens=50,prompt_counted=1,parts_json='[{"kind":"old","tokens":1}]'`));
    ingestRoute(f.store, [{
      id: 7, time: '2026-10-20T00:00:00Z', agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200,
      prompt: { tokens: 100, counted: 'yes' },
    }], 2, salt);
    const projection = f.store.write(db => projectRequestTx(db, 1, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(projection.prompt.state).toBe('invalid');
    expect(projection.families.prompt).toMatchObject({ state: 'invalid', current: false });
    expect(projection.reasons).toContain('prompt_retained');
    expect(f.store.read.query('SELECT prompt_tokens,prompt_counted,parts_json FROM request').get())
      .toEqual({ prompt_tokens: 50, prompt_counted: 1, parts_json: '[{"kind":"old","tokens":1}]' });
  } finally {
    f.close();
  }
});

test('到达顺序不改变请求事实与隐私形态', () => {
  const ledger = {
    t: '2026-10-20T00:00:02Z', route_id: 7, agent: 'demo', session: 's', model: 'm', provider: 'p',
    status: 200, in: 10, req: 'req-model', served: 'served-model',
    account: 'synthetic-account', providerAccount: 'synthetic-account',
  };
  const route = {
    id: 7, time: '2026-10-20T00:00:00Z', agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200,
    error: 'failed sk-synthetic-abcdefgh',
    prompt: { tokens: 100, counted: false, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
  };
  const build = (ledgerFirst: boolean) => {
    const f = fixture();
    try {
      if (ledgerFirst) {
        ingestLedger(f.store, 'usage.jsonl', batchOf([ledger]), 1, salt);
        ingestRoute(f.store, [route], 2, salt);
      } else {
        ingestRoute(f.store, [route], 1, salt);
        ingestLedger(f.store, 'usage.jsonl', batchOf([ledger]), 2, salt);
      }
      const request = f.store.read.query(
        'SELECT status,model_requested,model_served,prompt_tokens,prompt_counted,conv_key,actor FROM request').get();
      const rawLedger = f.store.read.query<{ account: string; payload_json: string }>(
        'SELECT account,payload_json FROM raw_ledger').get()!;
      const rawRoute = f.store.read.query<{ payload_json: string }>(
        'SELECT payload_json FROM raw_route WHERE route_id=7').get()!;
      return {
        request, account: rawLedger.account, ledgerPayload: rawLedger.payload_json,
        routePayload: rawRoute.payload_json, summary: routeSummaryText(f, 7),
      };
    } finally {
      f.close();
    }
  };
  expect(build(true)).toEqual(build(false));
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/reconcile.test.ts -t '同一脱敏对象|counted布尔|非法counted|到达顺序'`。Expected: FAIL，当前 route 在脱敏前映射、`counted: true` 丢失、非法 counted 不保留旧值，到达顺序会改变 prompt 形态。

- [ ] **Step 3：路由只挂证据与归属，prompt 走投影。**

```ts
function attachRouteEvidenceTx(db: Database, reqId: number, routeId: number, now: number): void {
  db.run(
    'INSERT OR IGNORE INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at) VALUES (?,?,?,?,?,?)',
    [reqId, 'route', String(routeId), 'merged', null, now],
  );
}

function applyRouteOwnershipTx(db: Database, reqId: number, route: RouteFields, now: number): void {
  const current = currentRequest(db, reqId);
  const conv = route.session !== null
    ? { key: JSON.stringify(['session', route.session]), source: 'session' }
    : route.conv !== null
      ? { key: JSON.stringify(['conv', route.conv]), source: 'conv' }
      : null;
  const convUpdate = conv !== null && (
    current.conv_source === 'request' || current.conv_source === null ||
    (current.conv_source === 'conv' && route.session !== null)
  );
  const actor = route.subagentId ?? route.session ?? route.conv ?? null;
  const title = current.title === null ? modelTimeTitle(route.model ?? route.served, route.timeMs) : current.title;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), agent=COALESCE(agent,?),
       conv_key=?, conv_source=?,
       actor=CASE WHEN actor_state='known' THEN actor ELSE ? END,
       actor_state=CASE WHEN actor_state='known' THEN actor_state ELSE ? END,
       sort_source=COALESCE(sort_source,'route'), sort_key=COALESCE(sort_key,?),
       title=?, have=have|4, updated_at=?
     WHERE req_id=?`,
    [
      route.session, route.agent,
      convUpdate ? conv!.key : current.conv_key, convUpdate ? conv!.source : current.conv_source,
      actor, actor === null ? 'unknown' : 'known',
      String(route.routeId).padStart(20, '0'), title, now, reqId,
    ],
  );
}

function applyRouteToRequest(db: Database, reqId: number, route: RouteFields, now: number): void {
  attachRouteEvidenceTx(db, reqId, route.routeId, now);
  applyRouteOwnershipTx(db, reqId, route, now);
  projectLedgerRequestTx(db, reqId, now);
}
```

`linkRouteIfPresent` 改为：读 `raw_route.payload_json`（已是脱敏副本），`mapRouteRow` 后调用 `applyRouteToRequest`。`ingestRoute` 改为先 `redact(record, salt)`、再 `mapRouteRow(redacted)`，然后 `upsertPreparedRouteTx(db, route, payloadJson)`、`saveRouteSummary(db, route, now)`；若已有同 route 的请求，再调用 `applyRouteToRequest`。`saveRouteSummary` 删除 `redactedError` 参数，`error: route.error` 直接进 zstd 摘要。

```ts
const redacted = redact(record, salt);
if (!isRecord(redacted)) {
  recordIssue(db, 'route', JSON.stringify(['route-invalid', index]), 'route_invalid_redaction', now, null);
  continue;
}
const route = mapRouteRow(redacted);
if (route === null) {
  const id = optionalNumber(redacted, 'id') ?? optionalNumber(redacted, 'route_id');
  recordIssue(db, 'route', JSON.stringify(['route-invalid', id ?? index]), 'route_invalid_identity', now, null);
  continue;
}
upsertPreparedRouteTx(db, route, JSON.stringify(redacted));
saveRouteSummary(db, route, now);
```

- [ ] **Step 4：跑路由测试。**

Run: `bun test tests/reconcile.test.ts`。Expected: PASS。
Run: `bun test tests/magpie.test.ts tests/reconcile.test.ts tests/projection.test.ts`。Expected: PASS。
Run: `bun run typecheck`。Expected: PASS。

获授权时提交 `refactor(reconcile): project route facts from redacted evidence`，包含本任务文件与 note，使用规定 attribution。

## Task 5：hook 证据独立，不写账本模型与合成状态

**Files:**
- Modify: `src/hook.ts:113–141,175–276,284–380`
- Test: `tests/hook.test.ts`
- Modify on implementation: Task 0 创建的 note

**Interfaces:**
- Consumes: Task 2 的 `projectRequestTx`、`SOURCE_PROJECTION_VERSION`；现有 `HookEnvelope`、`acceptHook`、`mergeHookInto`、`reconcilePending`。
- Produces: `insertHookRequest` 保持 `status`、`model_requested`、`model_served` 为 NULL；`acceptHook` 与 `mergeHookInto` 末尾对目标 reqId 调用投影；`HookProjection` 从 `raw_hook` 提供独立报告。

- [ ] **Step 1：添加 hook 独立报告回归。**

```ts
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';
import { ingestLedger } from '../src/reconcile';
import type { FileBatch } from '../src/sources/files';

function ledgerBatch(rows: unknown[]): FileBatch {
  let offset = 0;
  const lines = rows.map(row => {
    const text = JSON.stringify(row);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    generation: '1:2:3:1', rewriteEpoch: 0, lines, committedOff: offset,
    observedOff: offset, seenSize: offset, headLen: 0, headHash: null, issues: [],
  };
}

test('hook-only不合成HTTP状态也不写账本模型列', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 1, salt);
    expect(f.store.read.query(
      'SELECT status,model_requested,model_served FROM request WHERE req_id=?',
    ).get(accepted.req_id)).toEqual({ status: null, model_requested: null, model_served: null });
    expect(f.store.read.query<{ model: string; success: number }>(
      'SELECT model,success FROM raw_hook WHERE hook_id=?').get('hook-synthetic-1'))
      .toEqual({ model: 'hook-model', success: 1 });
    const projection = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 2, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(projection.hook).toMatchObject({ state: 'present', models: ['hook-model'], successes: [true] });
    expect(projection.selected).toBeNull();
  } finally {
    f.close();
  }
});

test('账本缺req时hook报告独立保留且不写账本模型', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', ledgerBatch([{
      t: '2026-10-20T00:00:00Z', route_id: 7, response_id: 'msg_synthetic_1',
      agent: 'demo', session: 'synthetic-session', model: 'provider-model', provider: 'p', status: 200, in: 10,
    }]), 1, salt);
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 2, salt);
    expect(accepted.req_id).toBe(1);
    const projection = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(projection.selected).toMatchObject({ fields: { requested: null, model: 'provider-model' } });
    expect(projection.hook).toMatchObject({ state: 'present', models: ['hook-model'], successes: [true] });
    expect(f.store.read.query('SELECT model_requested,model_served FROM request WHERE req_id=1').get())
      .toEqual({ model_requested: null, model_served: null });
    expect(f.store.read.query<{ model: string }>('SELECT model FROM raw_hook WHERE hook_id=?').get('hook-synthetic-1'))
      .toEqual({ model: 'hook-model' });
  } finally {
    f.close();
  }
});

test('hook success为false同样不产生失败状态', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: false }), 1, salt);
    expect(f.store.read.query('SELECT status FROM request WHERE req_id=?').get(accepted.req_id))
      .toEqual({ status: null });
  } finally {
    f.close();
  }
});

test('hook证据过期后报告expired且current为false', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 1, salt);
    const before = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 2, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(before.families.hook).toMatchObject({ state: 'complete', current: true });
    f.store.write(db => {
      db.run('DELETE FROM raw_hook WHERE hook_id=?', ['hook-synthetic-1']);
      db.run(`UPDATE request_evidence SET payload_state='expired' WHERE source_kind='hook'`);
    });
    const after = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(after.hook.state).toBe('expired');
    expect(after.families.hook).toMatchObject({ state: 'expired', current: false });
    expect(after.reasons).toContain('hook_expired');
    expect(f.store.read.query('SELECT model_requested,model_served,status FROM request WHERE req_id=?')
      .get(accepted.req_id)).toEqual({ model_requested: null, model_served: null, status: null });
  } finally {
    f.close();
  }
});
```

- [ ] **Step 2：观察失败。** Run: `bun test tests/hook.test.ts -t 'hook-only不合成|缺req时hook报告|success为false'`。Expected: FAIL，当前 `insertHookRequest` 把 model 写入 model_requested 与 model_served，success 为 true 时 status 合成为 200。

- [ ] **Step 3：改 hook 写入并调用投影。**

`insertHookRequest` 的 INSERT 列表保持原样，但 `status`、`model_requested`、`model_served` 三个值改为 `null`；`raw_hook.model` 与 `raw_hook.success` 继续保存。

```ts
const result = db.run(
  `INSERT INTO request(
     response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
     started_ms,day,via,status,model_requested,model_served,
     body_state,derive_version,have,created_at,updated_at,title,title_source,
     cost_state,attempt_state,sort_source,sort_key,magpie_version,parse_state,reply_state
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [
    responseIdNorm, envelope.agent, envelope.session, conv.key, conv.source,
    actor, 'unknown',
    started, localDay(started), 'hook', null, null, null,
    envelope.body_omitted ? 'partial' : 'pending', 0, 1, now, now, title, 'model_time',
    'absent', 'known', 'hook', envelope.hook_id, envelope.magpie_version ?? null, null, null,
  ],
);
```

`acceptHook` 在写入 `raw_hook`、证据、pending 与 `have=have|1` 之后，以同一事务调用投影：

```ts
db.run('UPDATE request SET have=have|1, updated_at=? WHERE req_id=?', [now, reqId]);
projectRequestTx(db, reqId, { now, mappingVersion: SOURCE_PROJECTION_VERSION });
return { req_id: reqId, duplicate: false };
```

`mergeHookInto` 在迁移证据、正文与归属之后、清理临时请求之前调用 `projectRequestTx(db, targetId, { now, mappingVersion: SOURCE_PROJECTION_VERSION })`。合并仍不迁移 hook 的 model 或 success；目标的 ledger 事实由投影按完整证据重算，hook 报告由 `raw_hook` 提供。

- [ ] **Step 4：跑 hook 与账本联合测试。**

Run: `bun test tests/hook.test.ts tests/reconcile.test.ts tests/projection.test.ts`。Expected: PASS，既有重放不增行、命中合并、pending 调和、metadata_only 用例保持。
Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 5：更新 note 并提交。** note 补记：hook 只提供证据与独立报告；HTTP 状态只来自上游实得；旧 hook 行里写进 model_requested/model_served 的伪值由 C 迁移，B 不代它决定新存储。获授权时提交 `fix(hook): keep hook reports out of ledger facts`，包含本任务源码、测试与 note，使用规定 attribution。

## Task 6：离线复用证明、文档同步与最终验收

**Files:**
- Test: `tests/projection.test.ts`
- Modify on implementation: `docs/architecture-design.md`（`### 原始层`、`### 读模型`、`### 合并规则`、`### 安全边界`、`### 版本与形状漂移`、`### 证据缺失`）
- Modify on implementation: `.agents/notes/implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md`
- Modify on implementation: 本计划文末勾选与链接（仅在执行完成后）

**Interfaces:**
- Consumes: Task 0–5 的全部入口与 helper。
- Produces: 离线迁移的复用证明；架构文档的现行行为描述；C 的明确接缝说明。

- [ ] **Step 1：添加离线同路回归。**

```ts
test('清空请求事实后同一入口重建出相同结果', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, {
      t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, model: 'provider-a',
      req: 'req-a', in: 10, cost: 0.25, err: 'rate limited', err_type: 'rate_limit',
    });
    addLedger(f.store, 1, 100, {
      t: '2026-10-22T00:00:01Z', status: 200, model: 'provider-b',
      req: 'req-b', served: 'served-b', provider: 'p', in: 20, out: 5, cost: 0,
    });
    addRoute(f.store, 1, 7, {
      id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact',
      prompt: { tokens: 100, counted: true, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
    });
    project(f.store, 1);
    const first = {
      facts: facts(f.store, 1),
      request: f.store.read.query('SELECT req_id,cost FROM request ORDER BY req_id').all(),
      owners: f.store.read.query('SELECT req_id,source_kind,ref_key FROM request_evidence ORDER BY req_id,source_kind,ref_key').all(),
      raw: f.store.read.query('SELECT source_kind,file_generation,byte_offset FROM raw_ledger ORDER BY byte_offset').all(),
    };
    f.store.write(db => db.run(
      `UPDATE request SET status=NULL,model_requested=NULL,model_served=NULL,in_tok=NULL,
       attempt_in=NULL,attempt_billed=NULL,prompt_tokens=NULL,prompt_counted=NULL,parts_json=NULL WHERE req_id=1`));
    const again = project(f.store, 1);
    expect(facts(f.store, 1)).toEqual(first.facts);
    expect(again.selected?.fields.errType).toBeNull();
    expect(again.kind).toMatchObject({ state: 'single', values: ['compact'] });
    expect({
      request: f.store.read.query('SELECT req_id,cost FROM request ORDER BY req_id').all(),
      owners: f.store.read.query('SELECT req_id,source_kind,ref_key FROM request_evidence ORDER BY req_id,source_kind,ref_key').all(),
      raw: f.store.read.query('SELECT source_kind,file_generation,byte_offset FROM raw_ledger ORDER BY byte_offset').all(),
    }).toEqual({ request: first.request, owners: first.owners, raw: first.raw });
  } finally {
    f.close();
  }
});
```

- [ ] **Step 2：跑离线复用与全量最窄集合。**

Run: `bun test tests/projection.test.ts -t '清空请求事实'`。Expected: PASS。
Run: `bun test tests/magpie.test.ts tests/privacy.test.ts tests/projection.test.ts tests/reconcile.test.ts tests/hook.test.ts`。Expected: PASS。
Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 3：同步架构文档。** 更新下列小节，只写现状，不写变更史。

- `### 原始层`：结构化列、payload 与长期摘要都来自同一脱敏对象；未知字段继续留在 payload；`req`、`cost`、`err` 的读取位置。
- `### 读模型`：`model_requested` 存上游 req，`model_served` 存回复声明 served，provider model 留在 raw 与 route；缺失保持未知；尝试合计只在账本 owner 证据完整时重算，同毫秒无法证明顺序时不发布最终尝试；prompt 数以最大 `time_ms` 唯一的那条 route 为准，同毫秒并列或该 route 的 Prompt 缺失、非法时旧值只是历史保留，读模型不得当成本次事实（长期落列与隐藏由 C 交付）。
- `### 合并规则`：字段级来源优先级改为 req、provider model、served 三种事实；hook 报告独立，不写账本模型列，不由 success 合成 HTTP 状态。
- `### 安全边界`：account 与 providerAccount 共享稳定占位符；已脱敏值保持原值。
- `### 版本与形状漂移`：来源 Adapter 记录必要键、合法省略、非法类型与未知键的状态；非法类型不降级整批。
- `### 证据缺失`：部分 raw 或过期证据保留旧的最终尝试、开始时间、排序键与尝试合计；完整证据但同毫秒跨代际不可证时清空排序键、不发布最终尝试；重复尝试嫌疑保留旧值，不用 MAX 保住合计。

- [ ] **Step 4：检查 note 与文档链接。** 确认 note 的 supersession check 已完成、交叉链接指向 still-active 记录、对 C 的链接指向 [C 长期信息与重建计划](2026-10-22-atc-durable-rebuild.md)。Run: `git diff --check`；Expected: PASS。Run: `bun run verify:notes:staged`（仅在已 stage 本任务文件且有提交授权时）；Expected: PASS。未获授权时报告未执行 staged 检查，不伪造结果。

- [ ] **Step 5：完成 B 批次验收记录。** 执行结束后报告实际修改文件、逐任务失败到通过记录、旧行为保留与剩余限制；把本计划文末的执行记录按实际提交勾选并链接提交。获授权时提交 `docs(architecture): describe unified source projection`，包含文档、note 与计划勾选，使用规定 attribution。

## C 接缝与未交付项

下列内容不在 B 交付，由 [C 长期信息与重建计划](2026-10-22-atc-durable-rebuild.md) 定义 schema、迁移与版本；B 只提供同一入口与返回报告。

- 长期 kind 报告、hook 独立 report、selected attempt identity、tier/err 与 family actualVersion 的持久列与迁移。
- B 的 `families[*].current=false` 与 `prompt_retained` 只表明列里是历史保留值；把这些 retained 状态落成 `projection_meta` 的 prompt `retained: invalid_input`，并让读模型隐藏非 current 的旧 prompt 数，由 C 交付。顺序不可证时 B 写出的 NULL 是未知而非 retained：C 可以另存历史 metadata，但不得把清空当成保留。C 不改变 B 的投影结果，只消费这些标记。
- `raw_ledger` 的 `err`、`mapping_version`、`privacy_version` 与 `raw_route` 的对应版本列；`route_summary` 的最小 kind、prompt、effort、folder、error 扩展。
- `request` 的 `model_provider`、请求输入修订、待处理状态、用途结果与版本、分组派生修订；`derive_queue` 的持久 clean/dirty 修订。
- 旧 hook 行里 `model_requested`、`model_served`、由 success 合成的 status 的历史语义修复；旧明文 account 的显式隐私变换。
- 真实库回填、服务切换、历史结果对齐与容量验收；B 不授权也不执行这些动作。

C 迁移的复用方式：读已脱敏 payload，调用 B 的 `mapLedgerRow` 或 `mapRouteRow`，再调用 `writePreparedLedgerTx` 或 `writePreparedRouteTx` 只更新既有原始行，随后调用 `projectRequestTx(db, reqId, { now, mappingVersion })`，最后写 C 自己的版本列与长期报告。迁移不得 INSERT 新证据、不得替换证据 owner、不得对 payload 再次运行脱敏器、不得删除 request_evidence 绕过幂等。

已核对的真实签名（C 照此写，不要揣测额外参数）：

- `mapLedgerRow(row: Record<string, unknown>): LedgerFields | null`，单参数；要求 `t`（或 `time`）是字符串或有限数字，`route_id` 可选；缺时间返回 null。
- `mapRouteRow(record: Record<string, unknown>): RouteFields | null`，单参数，不需要另传 time 或 id；身份取 `id` 再 `route_id`，时间取 `time`，两者缺一返回 null。
- `insertPreparedLedgerTx(db, ref: { generation: string; offset: number }, fields: LedgerFields, payloadJson: string): boolean`
- `writePreparedLedgerTx(db, ref: { generation: string; offset: number }, fields: LedgerFields, payloadJson: string): boolean`
- `upsertPreparedRouteTx(db, route: RouteFields, payloadJson: string): void`
- `writePreparedRouteTx(db, routeId: number, route: RouteFields, payloadJson: string): boolean`
- `projectRequestTx(db: Database, reqId: number, input: { now: number; mappingVersion: number }): RequestProjection`，`SOURCE_PROJECTION_VERSION = 1`。

payload 参数是字符串，不是对象：调用方要传 `JSON.stringify(input)`，其中 `input` 是解析出来的脱敏对象。`raw_ledger.payload_json` 与 `raw_route.payload_json` 存的就是这个对象的 JSON，因此迁移可以解析后原样重序列化，不需要也不允许再跑一次 `redact`。

Task 0 之后 `LedgerFields` 多出 `err: string | null` 与 `shape: LedgerShape`，`RouteFields` 多出 `shape: RouteShape`；`FieldState`、`CountedState`、`LedgerShape`、`RouteShape` 都由 `src/sources/magpie.ts` 导出，C 只把它们原样透传，不自己构造。

```ts
// C 的 src/migrate-v5.ts 片段：读已脱敏 payload、复用 B 的 mapper 与 UPDATE-only helper
function remapOneLedger(db: Database, generation: string, offset: number, now: number): number | null {
  const raw = db.query<{ payload_json: string; route_id: number | null }, [string, number]>(
    `SELECT payload_json,route_id FROM raw_ledger WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
  ).get(generation, offset);
  if (raw === null) return null;
  const input = JSON.parse(raw.payload_json) as Record<string, unknown>;
  const fields = mapLedgerRow(input);
  if (fields === null) return null;
  writePreparedLedgerTx(db, { generation, offset }, fields, JSON.stringify(input));
  db.run(
    `UPDATE raw_ledger SET err=?, mapping_version=?, privacy_version=?
     WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
    [fields.err, SOURCE_PROJECTION_VERSION, 1, generation, offset],
  );
  return fields.routeId;
}

function remapOneRoute(db: Database, routeId: number): void {
  const raw = db.query<{ payload_json: string }, [number]>(
    `SELECT payload_json FROM raw_route WHERE route_id=?`,
  ).get(routeId);
  if (raw === null) return;
  const input = JSON.parse(raw.payload_json) as Record<string, unknown>;
  const fields = mapRouteRow(input);
  if (fields === null) return;
  writePreparedRouteTx(db, routeId, fields, JSON.stringify(input));
}
```

迁移在同一批里对涉及的 reqId 调用 `projectRequestTx(db, reqId, { now, mappingVersion: SOURCE_PROJECTION_VERSION })`；C 的 kind 长期事实取 B 的 `projection.kind` 作为来源用途报告，不能当成模型族确认：kind 只在 `families.kind.current` 为 true（报告状态 single 或 merged）时有可用值，conflict 与 overflow 时 merged 为 null，不得拿 values 顶替；模型事实只消费 selected 在账本完整且顺序可证时给出的字段。

## 计划自审

| B 准入要求 | 本批任务与断言 |
| --- | --- |
| req、provider model、served 各异与缺 req | Task 0 来源键；Task 2 完整投影；Task 3 在线列；Task 5 hook 不覆盖 |
| 零费用、err 与 err_type、Prompt counted 布尔与省略非法 | Task 0；Task 2 prompt 族；Task 4 counted 与旧值保留 |
| 所有保存路径从统一处理后对象形成列、payload 与摘要 | Task 3 账本；Task 4 路由；Task 5 hook；同一 redacted 对象 |
| account 别名与已占位符不重复散列 | Task 1；Task 3 在线列与 payload 一致 |
| owner 收集与完整性判断由投影 Module 持有，在线离线共享 | Task 2 `collectOwnerEvidenceTx` 与 `projectRequestTx`；Task 6 清空重建 |
| 重复证据与不完整聚合分别检查 | Task 2 duplicate 指纹与 partial 状态；Task 3 部分过期不缩小 |
| raw 过期不缩小合计、不用 MAX 掩盖 | Task 2 partial/duplicate 保留旧值；Task 3 断言 |
| hook 模型与 success 独立保存；不写 ledger.req、served 或合成状态 | Task 5；Task 2 HookProjection |
| 后到 invalid 或 absent 保留旧列但不冒充 current | Task 2 prompt 保留与 `families[*].current`；Task 3 partial；Task 4 非法 counted；Task 5 hook 过期 |
| 同毫秒与跨代际不伪造尝试顺序 | Task 2 `finalCandidate`（同代际 offset 才可证、跨代际 conflict、不发布 final）、`orderState` 与 `prompt_order_unprovable`；Task 3 清空排序键断言；Task 2 两条同毫秒 route 断言 |
| 长期 kind、hook 报告、映射版本与历史迁移 | 交 [C 计划](2026-10-22-atc-durable-rebuild.md)，B 只返回报告与同一入口 |

最终检查：已检查占位步骤与未定义 helper；每个任务有 Files、Consumes/Produces、失败断言、最小实现、FAIL/PASS 命令与提交信息；所有勾选保持未勾选。

## 执行与验收记录

- [ ] Task 0：来源 Adapter 字段状态与真实键通过。
- [ ] Task 1：account 别名与占位符幂等通过。
- [ ] Task 2：来源投影 Module 的完整、部分、重复、冲突、顺序不可证、hook 独立与重复调用断言通过。
- [ ] Task 3：新建 raw helper，账本在线路径全部走投影，部分过期不缩小合计。
- [ ] Task 4：路由列、payload、摘要同源脱敏，到达顺序一致，counted 三态正确。
- [ ] Task 5：hook 不写账本模型与合成状态，报告独立且合并后保持账本值。
- [ ] Task 6：离线复用、文档同步、note 与最终最窄测试集合通过。
- [ ] C 接缝：schema、长期字段、历史迁移与真实库动作按 [C 计划](2026-10-22-atc-durable-rebuild.md) 单独验收，未执行前不得声称长期信息已迁移。