# ATC 同步派生正确性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行会话缺少上述技能时，逐任务执行相同测试与复核；不虚构技能调用。本文只编排合成回归与同步执行修复，不授权真实库回填、服务切换、push 或提交。每项提交步骤在已获提交授权时执行，否则保留可审阅改动。

**Goal:** 让同一最终请求集合得到一致的链、主链角色、工具关联和摘要，并使队列完成确认与整套同步派生产物一起提交。

**Architecture:** 保留 `drainDerive` 为具体的执行 Interface，在其现有同步 writer 事务内按统一逻辑顺序执行链、角色、工具、摘要和完成确认。工具算法提取为内部事务函数，摘要只消费本次 resolved 关联；实时、维护与指纹回填共用这一入口。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`；不增加依赖、线程或通用任务框架。

**Spec:** [v2 的派生执行](../../architecture-evolution-v2.md#派生执行与调度)、[验收](../../architecture-evolution-v2.md#验收与回退)、[补充评审](../../agent-request-kind-review.md#派生排序与摘要依赖)及[实施总入口](2026-10-22-atc-evolution-implementation.md)。[现行架构](../../architecture-design.md#乱序到达与重算)要求时间优先，当前链计算仅比较裸 sort_key；本批将改变运行时规则及既有派生结果，必须按下文的历史对齐条件验收，不能称为纯迁移。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL 与单 writer、独立只读连接、原生 JavaScript 页面、不增加第三方运行依赖。
- writer 只允许同步事务，yield 必须在事务外；本批完整处理组，不承诺限制长组占用。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。
- 监听地址写死 `127.0.0.1`；数据目录在仓库外，文件权限 0600、目录 0700。
- 保留任意祖先共同前缀规则、已回收正文的旧摘要与工具关系；不修改 `block.fingerprint`。
- 不改 schema、协议解析版本和脱敏版本；保留 `derive_version` 现有写入行为，口径统一留给长期信息迁移，不宣称本批已实现算法版本。
- `limit` 保持按组计数，`processed` 保持按请求计数；页面 keyset 顺序保持时间与 req_id。
- 不执行默认数据路径的 maintenance 或 backfill；所有运行检查使用新建临时库。

---

## 范围、文件与 Interface

编写基准 `b58aee8`，运行时代码等同 `a9df065`。下列行号为定位提示；按函数名定位，不将行号当补丁。此计划覆盖 v2 的排序、摘要和同步完成恢复，以及相关旧测试和调用者；来源字段、直接 hook 触发、请求修订、classifier、版本迁移、盐恢复及性能测量归[总入口](2026-10-22-atc-evolution-implementation.md)的后续批次。

| 文件 | 职责与计划改动 |
| --- | --- |
| `src/derive.ts:138–165,317–325` | 正文可比较性、消息引用完整性与零长度祖先保护 |
| `src/derive.ts:287–301` | 区分时间、同代际偏移证据和仅供遍历的来源身份 |
| `src/derive.ts:395–468` | 结果位置与本次关联驱动的摘要，删除全表 call_id 取首行 |
| `src/derive.ts:573–738` | 一次读取排序；链、角色、工具、摘要、确认依次执行 |
| `src/derive.ts:779–893` | 内部 `pairToolCallsTx`，复用统一排序并返回本次确定关联 |
| `src/main.ts:209–215` | tick 只调用完整 `drainDerive` |
| `src/maintenance.ts:421–443` | rebuild 只排空目标会话，成功前确认其工作完成 |
| `scripts/backfill-fingerprint.ts:82–97` | 保留循环 drain，删除循环外配对 |
| `tests/derive.test.ts` | 正文可比较性、同时间逆序身份、摘要重建、歧义、历史保留、故障与重开 |
| `tests/hook.test.ts` | 命中已知账本后的 body_omitted 与 metadata_only 无骨架形态 |
| `tests/maintenance.test.ts` | 超过一批、其它会话积压及旧结果保留 |
| `docs/architecture-design.md`、`docs/operations.md` | 代码交付时更新顺序、完成语义与维护范围 |
| `.agents/notes/implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md` | 实施时创建，记录统一执行的理由、备选与代价 |

不新增生产文件。`tests/fixtures.ts`、Store 和 schema 沿用当前实现。下述 helper 放在现有 `tests/derive.test.ts`，仅服务本批集成断言。

外部 Interface 保留并扩展一个可选范围，供离线维护避免消费其它会话任务：

```ts
export type DeriveScope = { convKey: string };
export type DrainResult = {
  processed: number;
  remaining: number; // 当前 scope 内未完成组；省略 scope 时是全队列
  groups: { conv_key: string; actor: string }[]; // 全部阶段已提交的组
  recomputed: number; // 本批具有可比较消息序列的请求，包括真实空数组
  retained: number; // 消息序列不可比较、标题/摘要按旧值保留的请求
};
export function drainDerive(store: Store, limit = 100, scope?: DeriveScope): DrainResult;
```

前两个参数含义保持不变。新增 scope 不允许空串；limit 必须为正安全整数，否则抛 `invalid_derive_limit`，非法 scope 抛 `invalid_derive_scope`。实时 tick 不传 scope；维护传目标会话；回填沿用全队列。`pairToolCalls` 在调用者迁完后取消导出，避免形成可跳过摘要的第二个公共完成入口。

## Task 0：区分不可比较正文与合法空消息

**Files:**
- Modify: `src/derive.ts:138–165,317–325`
- Test: `tests/derive.test.ts`
- Test: `tests/hook.test.ts`
- Create on implementation: `.agents/notes/implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md`
- Modify on implementation: `docs/architecture-design.md#新增消息`

**Interfaces:**
- Consumes: 已有 `seedChain(store, sessions)`、`bodyFor(texts)`、`fixture()`、`persistBody`、`matchPredecessor`、`enqueueDerive` 与 `drainDerive`。
- Produces: 内部 `fingerprintsOf(db: Database, reqId: number): string[] | null` 保持签名；null 表示不可比较，[] 仅表示已保存的真实空消息数组。`matchPredecessor` 不从零长度祖先生成父节点。

- [x] **Step 1：添加无骨架主链及合法空序列回归。** 在已有派生测试 helper 后加入以下断言。分别让不可读行位于旧裸键顺序之前与之后，覆盖空祖先和错误主链根；available 无骨架作为防御用例，partial 无骨架对应生产降级形态。

```ts
for (const state of ['partial', 'available'] as const) {
  for (const edge of ['0000', 'zzzz'] as const) {
    test(`${state}无骨架${edge}不充当祖先或主链根`, () => {
      const f = fixture();
      try {
        seedChain(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
        f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,
          actor_state,started_ms,day,via,body_state,derive_version,have,created_at,
          updated_at,sort_source,sort_key) VALUES (99,?,'actor-a','known',
          999,'2026-10-22','hook',?,0,1,1,1,'ledger',?)`,
          [JSON.stringify(['session', 'chain']), state, `ledger|${edge}`]));
        enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
        drainDerive(f.store);
        expect(f.store.read.query(`SELECT prev_relation,prev_req_id FROM request
          WHERE req_id=99`).get()).toEqual({ prev_relation: 'unknown', prev_req_id: null });
        expect(f.store.read.query(`SELECT req_id,chain_role FROM request
          WHERE req_id IN (1,2,3) ORDER BY req_id`).all()).toEqual([
          { req_id: 1, chain_role: 'main' }, { req_id: 2, chain_role: 'main' },
          { req_id: 3, chain_role: 'main' },
        ]);
        expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=3`).get())
          .toEqual({ prev_req_id: 2 });
      } finally { f.close(); }
    });
  }
}
test('合法空messages可读但不证明后续请求的父节点', () => {
  const f = fixture();
  try {
    seedChain(f.store, [[], ['A']]);
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation,delta_ordinals FROM request
      WHERE req_id=1`).get()).toEqual({ prev_relation: 'first', delta_ordinals: '[]' });
    expect(f.store.read.query(`SELECT prev_req_id,prev_relation FROM request
      WHERE req_id=2`).get()).toEqual({ prev_req_id: null, prev_relation: 'branch' });
    expect(matchPredecessor([{ reqId: 1, fingerprints: [] }], ['A']))
      .toEqual({ parent: null, relation: 'branch', delta: null, near: null });
  } finally { f.close(); }
});
```

- [x] **Step 2：观察对应断言失败。** Run: `bun test tests/derive.test.ts -t '无骨架|合法空messages'`。Expected: FAIL，旧代码把无骨架当 []，或从空祖先生成 parent。fixture、语法或 import 错误不计为目标失败。

- [x] **Step 3：修正可比较性和正长度前缀。** 不按 refs 为空一律判不可读；使用已持久化的消息数量区分无消息序列与真实空数组，检查引用数量与 ordinal 连续性，避免缺引用缩成空祖先。此操作不解压全组正文。

```ts
function fingerprintsOf(db: Database, reqId: number): string[] | null {
  const row = db.query<{ body_state: string; skeleton_z: Uint8Array | null;
    msg_count: number | null }, [number]>(`SELECT body_state,skeleton_z,msg_count
    FROM request WHERE req_id=?`).get(reqId);
  if (row === null || !['available', 'partial'].includes(row.body_state) ||
      row.skeleton_z === null || row.msg_count === null ||
      !Number.isSafeInteger(row.msg_count) || row.msg_count < 0) return null;
  const refs = db.query<{ ord: number; fingerprint: string }, [number]>(`
    SELECT rb.ord,b.fingerprint FROM request_block rb JOIN block b ON b.id=rb.block
    WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
  if (refs.length !== row.msg_count || refs.some((ref, i) =>
      ref.ord !== i || ref.fingerprint.length === 0)) return null;
  return refs.map(ref => ref.fingerprint);
}
// matchPredecessor 的完整前缀条件增加 shared > 0：
if (shared > 0 && shared === ancestor.fingerprints.length && shared <= current.length
    && (parent === null || ancestor.fingerprints.length > parent.length)) {
  parent = { reqId: ancestor.reqId, length: ancestor.fingerprints.length };
}
```

合法空请求仍可是第一笔真实请求并占主链根；禁止它成为任意后续请求的已确认父节点属于明确的语义调整。它与无骨架中性处理分别验收，不能为了让后续链变 main 将真实空请求伪装成缺正文。`msg_count=null` 的历史行先保守保留旧摘要，不在此批隐式补数；持久化写入正常时 msg_count 与 skeleton.has_messages 一致，损坏骨架的全面校验不在此批承诺内。

- [x] **Step 4：覆盖无消息序列及实际 hook 降级入口。** 加入下面的无 messages 和缺消息引用用例，区分不完整与合法空数组。

```ts
test('有骨架但无messages不参与消息前驱比较', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['A'], ['A', 'B']]);
    persistBody(f.store, 1, { protocol: 'anthropic', request: { system: 'synthetic' },
      reply: { content: [] }, redact_version: 1 });
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation FROM request WHERE req_id=1`).get())
      .toEqual({ prev_relation: 'unknown' });
    expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=2`).get())
      .toEqual({ prev_req_id: null });
  } finally { f.close(); }
});
test('缺消息引用不能缩成合法空序列', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['A'], ['A', 'B']]);
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1'));
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT prev_relation FROM request WHERE req_id=1`).get())
      .toEqual({ prev_relation: 'unknown' });
    expect(f.store.read.query(`SELECT prev_req_id FROM request WHERE req_id=2`).get())
      .toEqual({ prev_req_id: null });
  } finally { f.close(); }
});
```

在 `tests/hook.test.ts` 补充 `enqueueDerive`、`drainDerive` import，复用该文件的 `envelope()` 与 `salt`。以下用例创建命中已知账本的两种降级输入，再显式入队：

```ts
for (const mode of ['body_omitted', 'metadata_only'] as const) {
  test(`命中账本的${mode}无骨架请求保持不可比较`, () => {
    const f = fixture();
    const key = JSON.stringify(['session', 'synthetic-session']);
    try {
      f.store.write(db => db.run(`INSERT INTO request(req_id,route_id,
        response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
        started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at)
        VALUES (1,101,'synthetic_1','alpha','synthetic-session',?,'session',
        'synthetic-session','known',1700000000000,'2026-10-22','through',200,
        'pending',0,2,1,1)`, [key]));
      const input = envelope({ hook_id: `synthetic-${mode}`,
        body_omitted: mode === 'body_omitted' });
      const accepted = mode === 'metadata_only'
        ? acceptHook(f.store, input, 6, salt, {
          admission: () => ({ mode: 'metadata_only', reason: 'disk_budget' }),
        })
        : acceptHook(f.store, input, 6, salt);
      expect(accepted.req_id).toBe(1);
      enqueueDerive(f.store, key, 'synthetic-session', '');
      drainDerive(f.store);
      expect(f.store.read.query(`SELECT body_state,skeleton_z,prev_relation
        FROM request WHERE req_id=1`).get()).toEqual({
        body_state: 'partial', skeleton_z: null, prev_relation: 'unknown',
      });
    } finally { f.close(); }
  });
}
```

该测试证明后续入队后的可达性，不声称直接 hook 路径已经修复自动触发。Run: `bun test tests/derive.test.ts tests/hook.test.ts`。Expected: PASS，既有 pending/回收中性处理保持。

- [x] **Step 5：记录理由与独立提交。** 先做活跃 note supersession check，再创建上述 bug-fix note，记录缺失与空序列分离、空前缀不作父节点证据及保留旧结果的代价。任意祖先与标题记录仅部分涉及，交叉链接且保持活跃。获提交授权时提交 `fix(derive): distinguish missing bodies from empty message sequences`，包含本任务源码、测试、架构与 note，末尾使用规定 attribution。未获授权保持未暂存；Task 1 复用该 note。

## Task 1：固定统一逻辑顺序

**Files:**
- Modify: `src/derive.ts:287–301,573–628,779–860`
- Test: `tests/derive.test.ts`
- Modify on implementation: Task 0 创建的 `.agents/notes/implemented/bug-fix/2026-10-22-atomic-synchronous-derivation.md`
- Modify on implementation: `docs/architecture-design.md#乱序到达与重算`

**Interfaces:**
- Consumes: `fixture()`、`persistBody(store, reqId, input)`、`enqueueDerive(store, convKey, actor, fromSort)`、现有 `drainDerive` 与暂时保留的 `pairToolCalls`。
- Produces: `compareLogicalOrder(left: LogicalRow, right: LogicalRow): number`、`compareTraversalOrder(left: LogicalRow, right: LogicalRow): number`；前者按时间和来源身份稳定遍历，不含 req_id，也不能单独证明同时间先后；后者仅在时间和身份相同时用 req_id 兜底。关系判断同时消费 `uncertainOrderIds`，仅认可同代际的不同账本偏移。
- Produces（供 [F 的条件切片](2026-10-22-atc-capacity-convergence.md) import，不复制第二份实现）：`type LogicalRow`、`type ResolvedTool`、`uncertainOrderIds`、`fingerprintsOf`、`toolResultPreview`，以及 `src/derive.ts` 既有的 `firstUserPreview`、`tailUserPreview`、`messageAt`、`deriveTitle`、`previewOf`、`replyInfoOf` 一并导出（`modelTimeTitle` 已是 `src/sources/magpie.ts` 的导出，无需改动）。这些符号只暴露既有取值与格式化，不暴露事务步骤；切片路径只 import 它们，不得复刻名称合并、内容兜底、字符截断与兜底标题。

- [x] **Step 1：添加同时间、生产形状键的回归与 helper。** 在测试文件沿用已有 Bun/import，补 `Store` 类型和以下本地 helper。显式 ID 只用于模拟不同摄入顺序，生产写入继续由 SQLite 分配。

```ts
type TestStore = ReturnType<typeof fixture>['store'];
const GROUP = 'synthetic-derive';
const ACTOR = 'actor-synthetic';
function seedRound(store: TestStore, ids: readonly [number, number],
  times: readonly [number, number] = [1000, 1000]): void {
  store.write(db => {
    for (const [i, id] of ids.entries()) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,
        started_ms,day,via,body_state,derive_version,have,created_at,
        updated_at,sort_source,sort_key)
        VALUES (?,?,?,'known',?,'2026-10-22','hook','pending',0,1,1,1,'ledger',?)`,
        [id, GROUP, ACTOR, times[i]!, `1:2:3:0|${String(i * 100).padStart(20, '0')}`]);
    }
  });
  const user = { role: 'user', content: [{ type: 'text', text: 'synthetic input' }] };
  const call = { type: 'tool_use', id: 'synthetic_call', name: 'read_file', input: {} };
  persistBody(store, ids[0], { protocol: 'anthropic',
    request: { messages: [user] }, reply: { content: [call] }, redact_version: 1 });
  persistBody(store, ids[1], { protocol: 'anthropic', request: { messages: [user,
    { role: 'assistant', content: [call] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic_call',
      content: 'synthetic output' }] }] }, reply: { content: [] }, redact_version: 1 });
}
function snapshot(store: TestStore, ids: readonly [number, number]) {
  const [first, second] = ids;
  const requests = ids.map(id => store.read.query<{
    prev_req_id: number | null; prev_relation: string; delta_ordinals: string | null;
    chain_role: string; req_kind: string; title: string | null;
    title_source: string | null; input_preview: string | null;
    input_preview_kind: string | null; reply_preview: string | null;
  }, [number]>(`SELECT prev_req_id,prev_relation,delta_ordinals,chain_role,
    req_kind,title,title_source,input_preview,input_preview_kind,reply_preview
    FROM request WHERE req_id=?`).get(id)!).map(row => ({ ...row,
      prev_req_id: row.prev_req_id === first ? 'first'
        : row.prev_req_id === second ? 'second' : row.prev_req_id,
    }));
  const tools = store.read.query<{
    req_id: number; ord: number; call_id: string; tool_name: string | null;
    result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
  }, [number, number]>(`SELECT req_id,ord,call_id,tool_name,result_req,
    result_ord,result_path,state FROM tool_call WHERE req_id IN (?,?)
    ORDER BY req_id,ord`).all(first, second).map(row => ({ ...row,
      req_id: row.req_id === first ? 'first' : 'second',
      result_req: row.result_req === first ? 'first'
        : row.result_req === second ? 'second' : row.result_req,
    })).sort((a, b) => String(a.req_id).localeCompare(String(b.req_id)) || a.ord - b.ord);
  return { requests, tools };
}
function rebuild(store: TestStore): void {
  enqueueDerive(store, GROUP, ACTOR, '');
  drainDerive(store);
}

test('同毫秒交换摄入ID仍得到相同链角色和工具关系', () => {
  const a = fixture(); const b = fixture();
  try {
    seedRound(a.store, [1, 2]); seedRound(b.store, [2, 1]);
    rebuild(a.store); pairToolCalls(a.store, GROUP, ACTOR);
    rebuild(b.store); pairToolCalls(b.store, GROUP, ACTOR);
    expect(snapshot(a.store, [1, 2])).toEqual(snapshot(b.store, [2, 1]));
    expect(snapshot(b.store, [2, 1]).tools[0]).toMatchObject({
      state: 'resolved', result_req: 'second',
    });
  } finally { a.close(); b.close(); }
});
```

- [x] **Step 2：确认回归失败。** Run: `bun test tests/derive.test.ts -t '同毫秒交换摄入ID'`。Expected: FAIL，逆序 ID 的工具关系为 pending。首次摘要此时允许仍是内容兜底，Task 2 再修依赖。

- [x] **Step 3：集中比较器，三阶段消费同一顺序。** 替换 `sortKeyOf(...).localeCompare(...)`，角色和暂时独立配对使用同一 traversal 比较器。时间不同按时间；同毫秒只有同一账本代际的不同偏移提供本轮采用的来源次序。跨代际身份、route ID 与随机 hook UUID 仅用于确定遍历，不证明先后，不使用来源 rank 推导关系。

```ts
type LogicalRow = {
  req_id: number; started_ms: number;
  sort_source: string | null; sort_key: string | null;
};
function ledgerPosition(row: LogicalRow): { generation: string; offset: bigint } | null {
  if (row.sort_source !== 'ledger' || row.sort_key === null) return null;
  const match = /^(\d+:\d+:\d+:\d+)\|(\d{20})$/.exec(row.sort_key);
  return match === null ? null : { generation: match[1]!, offset: BigInt(match[2]!) };
}
function compareLogicalOrder(a: LogicalRow, b: LogicalRow): number {
  if (a.started_ms !== b.started_ms) return a.started_ms < b.started_ms ? -1 : 1;
  // 此处只确定遍历；同时间的关系判定还必须经过 uncertain 守卫。
  return Buffer.compare(Buffer.from(JSON.stringify([a.sort_source, a.sort_key])),
    Buffer.from(JSON.stringify([b.sort_source, b.sort_key])));
}
function compareTraversalOrder(a: LogicalRow, b: LogicalRow): number {
  return compareLogicalOrder(a, b) || a.req_id - b.req_id;
}
function uncertainOrderIds(rows: readonly LogicalRow[]): Set<number> {
  const buckets = new Map<number, LogicalRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.started_ms) ?? [];
    list.push(row); buckets.set(row.started_ms, list);
  }
  const out = new Set<number>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const positions = bucket.map(ledgerPosition);
    const generation = positions[0]?.generation;
    if (positions.some(position => position === null || position.generation !== generation)) {
      for (const row of bucket) out.add(row.req_id);
      continue;
    }
    const offsets = new Map<bigint, LogicalRow[]>();
    for (const [i, row] of bucket.entries()) {
      const offset = positions[i]!.offset;
      const list = offsets.get(offset) ?? [];
      list.push(row); offsets.set(offset, list);
    }
    for (const list of offsets.values()) if (list.length > 1) {
      for (const row of list) out.add(row.req_id);
    }
  }
  return out;
}
```

同时间桶存在非账本、缺失/非法位置或不同代际时，整桶保守标为顺序未证实；同代际重复偏移仅标记重复集合。它们仍可遍历，但本次关系为 unknown、delta=null，不作为确定祖先或主链根，同时间工具关系不能 resolved。其余请求仍使用原有前缀证据规则，确定顺序也不等于已经证明因果关系。该政策可能减少同毫秒可确认关系，须在 note 记录代价；不同时间的 route/hook 合成行仍可按时间定序，不能概括为这些来源永远不可排序。

工具的唯一候选判断继续保留，不凭相同 call_id 解歧义。把 calls/results 的 index 保留为取 ordered 行的位置，使用以下守卫替换原 `call.index >= result.index`。主链角色查询补 sort_source/sort_key，筛选 unknown 后按同一比较器排序。Task 2 将其改为直接消费统一 ordered 列表，避免重复收集知识。

```ts
// rows 是已经按 compareTraversalOrder 排好的当前组请求。
const callRow = rows[call.index]!;
const resultRow = rows[result.index]!;
if (compareLogicalOrder(callRow, resultRow) >= 0) continue;
if (callRow.started_ms === resultRow.started_ms &&
    (uncertain.has(callRow.req_id) || uncertain.has(resultRow.req_id))) continue;
```

链循环增加下列分支和祖先守卫。`uncertain` 在每组排序后计算；Task 1 的独立工具包装也调用相同函数形成该集合。

```ts
// 放在 isTitleRequest 分支后，current===null 分支前：
else if (uncertain.has(row.req_id)) {
  match = { parent: null, relation: 'unknown', delta: null, near: null };
}
// 替换原 unreadableEarlier 和 ancestors 更新条件：
if (!isTitleRequest && (current === null || uncertain.has(row.req_id))) unreadableEarlier = true;
if (!isTitleRequest && current !== null && !uncertain.has(row.req_id)) {
  ancestors.push({ reqId: row.req_id, fingerprints: current });
}
```

- [x] **Step 4：加入并运行边界断言。** 用 `seedRound` 建独立 fixture，以下各项分别为一个 test；每次修改后 enqueue 再计算。Task 2 完成前暂保留显式 pair；Task 3 迁走。

```ts
test('时间优先于跨代际物理键字典序', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2], [1000, 2000]);
    f.store.write(db => db.run(`UPDATE request SET sort_key=CASE req_id
      WHEN 1 THEN '9:8:7:0|00000000000000000000'
      ELSE '1:2:3:0|00000000000000000100' END`));
    rebuild(f.store); pairToolCalls(f.store, GROUP, ACTOR);
    expect(snapshot(f.store, [1, 2]).requests[1]?.prev_req_id).toBe('first');
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
  } finally { f.close(); }
});
test('同代际重复偏移不能由ID创造确定关系', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => db.run(`UPDATE request
      SET sort_key='1:2:3:0|00000000000000000000'`));
    rebuild(f.store); pairToolCalls(f.store, GROUP, ACTOR);
    expect(snapshot(f.store, [1, 2]).requests.map(r => r.prev_relation))
      .toEqual(['unknown', 'unknown']);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
  } finally { f.close(); }
});
test('缺键同时间桶保守且来源后补可重算', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => db.run('UPDATE request SET sort_source=NULL,sort_key=NULL'));
    rebuild(f.store); pairToolCalls(f.store, GROUP, ACTOR);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('pending');
    f.store.write(db => {
      for (const id of [1, 2]) db.run(`UPDATE request
        SET sort_source='ledger',sort_key=? WHERE req_id=?`,
        [`1:2:3:0|${String((id - 1) * 100).padStart(20, '0')}`, id]);
    });
    rebuild(f.store); pairToolCalls(f.store, GROUP, ACTOR);
    expect(snapshot(f.store, [1, 2]).tools[0]?.state).toBe('resolved');
  } finally { f.close(); }
});
```

再增加下列参数化测试。它验证未来或异常输入下的保守政策，不表示当前生产 known 分组已经包含 route/hook 排序行。每次交换 ID 仍按相同逻辑请求设置来源；同毫秒跨代际、混合来源和随机 UUID 均不得由身份字典序生成确定关系。

```ts
const unsupportedOrders = [
  [['ledger', '1:2:3:0|00000000000000000000'], ['ledger', '9:8:7:0|00000000000000000100']],
  [['ledger', '1:2:3:0|00000000000000000000'], ['route', '00000000000000000002']],
  [['hook', '00000000-0000-4000-8000-000000000001'], ['hook', 'ffffffff-ffff-4fff-8fff-ffffffffffff']],
] as const;
for (const [index, sources] of unsupportedOrders.entries()) {
  test(`无同源位置证据${index}交换ID也不生成确定关系`, () => {
    const a = fixture(); const b = fixture();
    try {
      for (const [f, ids] of [[a, [1, 2]], [b, [2, 1]]] as const) {
        seedRound(f.store, ids);
        f.store.write(db => {
          for (const [i, id] of ids.entries()) db.run(`UPDATE request
            SET sort_source=?,sort_key=? WHERE req_id=?`, [...sources[i]!, id]);
        });
        rebuild(f.store); pairToolCalls(f.store, GROUP, ACTOR);
        expect(snapshot(f.store, ids).requests.map(row => row.prev_relation))
          .toEqual(['unknown', 'unknown']);
        expect(snapshot(f.store, ids).tools[0]?.state).toBe('pending');
      }
      expect(snapshot(a.store, [1, 2])).toEqual(snapshot(b.store, [2, 1]));
    } finally { a.close(); b.close(); }
  });
}
```

Run: `bun test tests/derive.test.ts`，Expected: 既有断言及新增排序断言 PASS。

- [x] **Step 5：同步设计与 note，形成排序修复提交。** 复用 Task 0 创建的 bug-fix note，说明时间优先是对当前链运行时的规则改变，跨代际既有关系可能变化；来源身份不保证先后，同毫秒保守处理可能降低可确认比例。标题/祖先等旧记录仅部分涉及，交叉链接并保持活跃。历史对齐必须按[上线与历史结果对齐](#上线与历史结果对齐)完成，代码合成验收不等于真实库已经重建。Run: `bun run typecheck`；Expected: PASS。获授权时提交 `fix(derive): share deterministic request ordering`，包含本任务源码、测试、架构与 note，附规定 attribution。

## Task 2：在当前事务内完成工具与摘要

**Files:**
- Modify: `src/derive.ts:395–468,573–738,779–893`
- Test: `tests/derive.test.ts`
- Modify on implementation: Task 0 创建的 bug-fix note、`docs/architecture-design.md#工具配对`

**Interfaces:**
- Consumes: Task 1 的比较器、`LogicalRow`、`uncertainOrderIds`；现有 `ChainRow`、`bodyInTx`、`anthropicRequestResults`、`messageAt`。
- Produces: `drainDerive` 完成全部阶段。内部类型和函数如下；不导出事务步骤。

```ts
type Group = { conv_key: string; actor: string };
type PairRow = LogicalRow & { req_kind: string | null;
  prev_relation: string | null; delta_ordinals: string | null };
type ResolvedTool = {
  callReq: number; callOrd: number; callId: string; name: string;
  resultReq: number; resultOrd: number; resultPath: string;
};
type PairResult = { resolved: number; ambiguous: number; pending: number;
  associations: ResolvedTool[] };
function pairToolCallsTx(db: Database, group: Group,
  ordered: readonly PairRow[], uncertain: ReadonlySet<number>): PairResult;
function toolResultPreview(db: Database, reqId: number,
  delta: readonly number[], associations: readonly ResolvedTool[]): string | null;
```

- [x] **Step 1：添加首次即有工具名与重建等价回归。** 复用 Task 1 helper，不再显式 pair，断言 `drainDerive` 返回即是完整结果。

```ts
test('完整派生首次即使用本次工具关联且重建不漂移', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]); rebuild(f.store);
    const first = snapshot(f.store, [1, 2]);
    expect(first.tools[0]).toMatchObject({ state: 'resolved', result_req: 'second' });
    expect(first.requests[1]?.input_preview).toBe('工具结果 · read_file');
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => {
      db.run('DELETE FROM tool_call WHERE req_id IN (1,2)');
      db.run(`UPDATE request SET prev_req_id=NULL,prev_relation=NULL,
        delta_ordinals=NULL,title=NULL,title_source=NULL,input_preview=NULL,
        input_preview_kind=NULL,reply_preview=NULL WHERE req_id IN (1,2)`);
    });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
  } finally { f.close(); }
});

test('其它组同call_id不能污染本次摘要', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (99,'other','other','known',0,'2026-10-22','hook','pending',0,1,1,1)`);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('synthetic_call',99,0,'unrelated_tool','resolved',1)`);
    });
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
  } finally { f.close(); }
});
```

同一文件补充 `import { modelTimeTitle } from '../src/sources/magpie'`，用以下断言锁定可重算标题的行为变化与缺正文保留政策：

```ts
test('可读工具轮次标题不依赖旧值且缺正文标题保留', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`UPDATE request SET title='stale derived title',title_source='user_delta'
        WHERE req_id=2`);
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1,
        'retained title','user_delta')`, [GROUP, ACTOR]);
    });
    rebuild(f.store);
    const first = snapshot(f.store, [1, 2]);
    expect(first.requests[1]).toMatchObject({
      title: modelTimeTitle(null, 1000), title_source: 'model_time',
    });
    expect(first.requests[1]?.title?.startsWith('unknown · ')).toBe(true);
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => db.run(`UPDATE request SET title=NULL,title_source=NULL
      WHERE req_id IN (1,2)`));
    rebuild(f.store);
    expect(snapshot(f.store, [1, 2])).toEqual(first);
    expect(f.store.read.query(`SELECT title,title_source FROM request WHERE req_id=3`).get())
      .toEqual({ title: 'retained title', title_source: 'user_delta' });
  } finally { f.close(); }
});
```

- [x] **Step 2：验证失败。** Run: `bun test tests/derive.test.ts -t '完整派生首次|其它组同call_id|可读工具轮次标题'`。Expected: FAIL，工具未在 drain 完成、摘要内容兜底或串名，或标题仍依赖旧值。记录实际失败，不能把语法或 fixture 失败计作目标缺陷。

- [x] **Step 3：将 pair 算法内移，按依赖拆写入。** 把现有 pair 的 writer 回调体搬到 `pairToolCallsTx`，去掉它内部重新按 SQL 时间/ID排序的读取，函数开头使用 `const rows = ordered`，空组返回下列完整 `PairResult`，传入当前 ordered 请求的最新关系。遍历每笔 body 前增加 `if (row.req_kind === 'title') continue`，使已有标题旁路政策同样覆盖工具候选。仍只删除正文 available/partial 的旧工具行；历史行保留。`associations` 从本次新建且最终 resolved 的 call 行形成，不从全表收集，逐个包含调用位置与最终结果位置。

```ts
const rows = ordered;
if (rows.length === 0) {
  return { resolved: 0, ambiguous: 0, pending: 0, associations: [] };
}
// pair 内先保留当前 calls/results 候选算法；在函数末尾生成本次关联。
const associations: ResolvedTool[] = [];
for (const call of calls) {
  const row = db.query<{
    state: string; result_req: number | null; result_ord: number | null;
    result_path: string | null;
  }, [number, number]>(`SELECT state,result_req,result_ord,result_path
    FROM tool_call WHERE req_id=? AND ord=?`).get(call.req_id, call.ord);
  if (row?.state !== 'resolved' || row.result_req === null ||
      row.result_ord === null || row.result_path === null) continue;
  associations.push({ callReq: call.req_id, callOrd: call.ord,
    callId: call.call_id, name: call.name, resultReq: row.result_req,
    resultOrd: row.result_ord, resultPath: row.result_path });
}
// 在原 :886–890 的位置保留版本写入，不能随外层 writer 包装一起删除。
db.run(`UPDATE tool_call SET derive_version=derive_version+1 WHERE req_id IN (
  SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known')`,
  [group.conv_key, group.actor]);
return { resolved, ambiguous, pending, associations };
```

链循环保留用途识别和前驱匹配，先只更新关系、delta、req_kind、chain_role 默认值、model_title，不增加 derive_version；保存每笔计算的中间输入到本次事务的数组。摘要原有分支提取为以下内部函数，只在工具完成后执行。新增 `import { modelTimeTitle } from './sources/magpie'`，复用现有时间标题，删除不再使用的 clock。正文可比较时从当前模型/时间生成 fallback，避免旧派生 title 污染清空重建；缺正文分支继续保留旧标题，已有 model_title 仍按现有来源规则保留。工具结果轮次的旧标题可能改为时间兜底，缺模型统一显示 unknown；这属于有意的显示行为改变，实施 note 必须记录，并以首次/重复/清空后相等和不可读标题保留断言验收。

```ts
type PresentationInput = {
  row: ChainRow; current: readonly string[] | null;
  replyInfo: ReplyInfo; isTitleRequest: boolean; modelTitle: string | null;
  match: PredecessorMatch;
};
function writePresentationTx(db: Database, input: PresentationInput,
  associations: readonly ResolvedTool[]): void {
  const { row, current, replyInfo, isTitleRequest, modelTitle, match } = input;
  const delta = match.delta;
  const fallback = modelTimeTitle(row.model_served, row.started_ms);
  let title = fallback;
  let source: 'user_delta' | 'model_time' | 'model_title' = 'model_time';
  let inputPreview: string | null = null;
  let inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null = null;
  if (isTitleRequest) {
    title = modelTitle ?? (current === null ? row.title ?? fallback : fallback);
    source = modelTitle !== null ? 'model_title' :
      current === null && row.title_source === 'model_title' ? 'model_title' : 'model_time';
    inputPreview = firstUserPreview(db, row.req_id) ?? '生成会话标题';
    inputKind = 'title';
  } else if (current === null) {
    title = row.title ?? fallback;
    source = row.title_source === 'user_delta' || row.title_source === 'model_time'
      || row.title_source === 'model_title' ? row.title_source : 'model_time';
    inputPreview = row.input_preview;
    inputKind = row.input_preview_kind === 'delta' || row.input_preview_kind === 'tail'
      || row.input_preview_kind === 'tool_result' || row.input_preview_kind === 'title'
      ? row.input_preview_kind : null;
  } else if (delta !== null && delta.length > 0) {
    const messages = delta.map(ord => messageAt(db, row.req_id, ord));
    const derived = deriveTitle(messages, delta.map((_, i) => i), fallback);
    title = derived.title; source = derived.source;
    const fresh = previewOf(messages);
    if (fresh !== null) { inputPreview = fresh; inputKind = 'delta'; }
    else {
      inputPreview = toolResultPreview(db, row.req_id, delta, associations);
      inputKind = inputPreview === null ? null : 'tool_result';
    }
  } else if (delta !== null) {
    inputPreview = '输入是上一轮的工具结果，没有新的用户消息';
    inputKind = 'tool_result';
  } else {
    inputPreview = tailUserPreview(db, row.req_id);
    inputKind = inputPreview === null ? null : 'tail';
  }
  const replyPreview = current === null ? row.reply_preview : replyInfo.preview;
  db.run(`UPDATE request SET title=?,title_source=?,input_preview=?,
    input_preview_kind=?,reply_preview=?,derive_version=derive_version+1
    WHERE req_id=?`, [title, source, inputPreview, inputKind, replyPreview, row.req_id]);
}
```

每组进入链循环前创建 `const presentations: PresentationInput[] = []`。用下列写入替换原有混合 UPDATE，随后照原逻辑追加确定祖先和 processed；Task 1 的顺序不明请求不能追加。完成整个链循环后执行阶段代码，不在每笔请求内提前配对。

```ts
type RoleRow = { req_id: number; prev_req_id: number | null;
  req_kind: string; prev_relation: string | null };
// 链循环前：
const pairRows: PairRow[] = [];
const roleRows: RoleRow[] = [];
// 链循环中的唯一关系写入：
const reqKind = isTitleRequest ? 'title' : 'chat';
db.run(`UPDATE request SET prev_req_id=?,prev_relation=?,delta_ordinals=?,
  req_kind=?,chain_role=?,model_title=? WHERE req_id=?`, [
  match.parent, match.relation, match.delta === null ? null : JSON.stringify(match.delta),
  reqKind, isTitleRequest ? 'aux' : 'main',
  isTitleRequest ? modelTitle : null, row.req_id,
]);
roleRows.push({ req_id: row.req_id, prev_req_id: match.parent,
  req_kind: reqKind, prev_relation: match.relation });
pairRows.push({ ...row, req_kind: reqKind, prev_relation: match.relation,
  delta_ordinals: match.delta === null ? null : JSON.stringify(match.delta) });
presentations.push({ row, current, replyInfo, isTitleRequest, modelTitle, match });

// 完成链循环后，同一 store.write 回调内：
assignChainRoles(db, roleRows);
const paired = pairToolCallsTx(db, group, pairRows, uncertain);
for (const input of presentations) writePresentationTx(db, input, paired.associations);
db.run('DELETE FROM derive_queue WHERE conv_key=? AND actor=?',
  [group.conv_key, group.actor]);
touched.push(group);
```

`assignChainRoles` 改为消费链循环刚产生的有序 RoleRow；工具阶段复用同轮 PairRow，两个阶段都不再逐笔查询关系。事务内不使用 `store.read`，不调用带 `store.write` 的 pair 包装。过渡 public pair 可批量读取当前组关系并使用相同排序；Task 3 删除该包装。

```ts
function assignChainRoles(db: Database, ordered: readonly RoleRow[]): void {
  const rows = ordered.filter(row =>
    row.req_kind === 'chat' && row.prev_relation !== 'unknown');
  if (rows.length === 0) return;
  const ids = new Set(rows.map(row => row.req_id));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const row of rows) {
    if (row.prev_req_id === null || !ids.has(row.prev_req_id)) roots.push(row.req_id);
    else {
      const list = children.get(row.prev_req_id) ?? [];
      list.push(row.req_id); children.set(row.prev_req_id, list);
    }
  }
  const trunk = new Set<number>();
  const stack = [roots[0] ?? rows[0]!.req_id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (trunk.has(id)) continue;
    trunk.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  const update = db.prepare('UPDATE request SET chain_role=? WHERE req_id=?');
  for (const row of rows) update.run(trunk.has(row.req_id) ? 'main' : 'branch', row.req_id);
}
```

摘要删除独立的 `toolResultsOf`，改为复用带完整 path 的 `anthropicRequestResults`，避免两份解析形状。`messageAt` 按 ord 装成原位置数组，只保留本次 delta 的消息；随后沿唯一的本次 resolved 位置读取名称。

```ts
const messages: unknown[] = [];
for (const ordinal of delta) messages[ordinal] = messageAt(db, reqId, ordinal);
for (const result of anthropicRequestResults({ messages })) {
  const matches = associations.filter(link => link.resultReq === reqId &&
    link.resultOrd === result.ord && link.resultPath === result.path &&
    link.callId === result.id);
  if (matches.length === 1 && matches[0]!.name.length > 0) names.push(matches[0]!.name);
  if (content === null) {
    const flat = flattenToolContent(result.value).replace(/\s+/g, ' ').trim();
    if (flat.length > 0) content = flat;
  }
}
```

沿用原名称合并计数、内容兜底和字符截断；不查上一轮表、其它组或不可重算保留行。数组稀疏位会被结果提取跳过，不改 ord。空名、pending、ambiguous 和无法定位结果均使用内容兜底。

- [x] **Step 4：验证歧义与两个协议的结果位置。** 增补同一消息中两个工具结果，第二个与本次唯一调用匹配；断言准确 path 的工具名只计一次。Anthropic path 为 `request.messages[2].content[1]`，chat path 为 `request.messages[2]`。chat 构造使用以下对象，fixture 的两请求关系仍为普通前缀；两者逐项查询 result_ord/result_path 和 input_preview。

```ts
const user = { role: 'user', content: 'synthetic input' };
const call = { id: 'synthetic_call', type: 'function',
  function: { name: 'read_file', arguments: '{}' } };
const assistant = { role: 'assistant', content: null, tool_calls: [call] };
persistBody(f.store, 1, { protocol: 'chat', request: { messages: [user] },
  reply: { choices: [{ message: assistant }] }, redact_version: 1 });
persistBody(f.store, 2, { protocol: 'chat', request: { messages: [user, assistant,
  { role: 'tool', tool_call_id: 'synthetic_call', content: 'synthetic output' }] },
  reply: { choices: [{ message: { role: 'assistant', content: 'done' } }] }, redact_version: 1 });
rebuild(f.store);
expect(snapshot(f.store, [1, 2]).tools[0]).toMatchObject({
  state: 'resolved', result_ord: 2, result_path: 'request.messages[2]',
});
expect(snapshot(f.store, [1, 2]).requests[1]?.input_preview).toBe('工具结果 · read_file');
```

同组重复 call_id 沿用当前 ambiguous 测试，并增加结果内容兜底断言；若其关系为 unknown，只断言摘要不出现调用名，不能要求 delta 分支文案。保留 title 旁路测试，另构造标题请求回复中含工具调用并检查没有该请求的 tool_call。未知前驱沿用 pending 测试，摘要不得取工具名。加入一个被回收调用的旧 resolved 行，用相同 call_id 指向当前结果，断言它本身保留，当前摘要仍只由本次关联决定。Run: `bun test tests/derive.test.ts`，Expected: PASS。清空重建只清可重算请求的结果，缺正文历史值不参与清空。

- [x] **Step 5：更新拥有决策的 note 与架构后提交。** 说明摘要从当前确定关联得名、调用位置与结果 path 均限定、历史保留行不充当本次确认。加以下版本兼容回归，锁定现有 UPDATE 的实际行为，不将其解读为算法版本或可靠累计重建次数。新建可重算工具行每轮先插入 1 再增至 2；被回收的旧工具行仍按旧逻辑递增，[C 批次](2026-10-22-atc-durable-rebuild.md)再修正该口径。

```ts
test('工具版本保持旧写入口径直到显式版本迁移', () => {
  const f = fixture();
  try {
    seedRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1)`, [GROUP, ACTOR]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('old-retained',3,0,'old','resolved',7)`);
    });
    for (const expected of [8, 9]) {
      rebuild(f.store);
      expect(f.store.read.query(`SELECT derive_version FROM tool_call WHERE req_id=1`).get())
        .toEqual({ derive_version: 2 });
      expect(f.store.read.query(`SELECT derive_version FROM tool_call WHERE req_id=3`).get())
        .toEqual({ derive_version: expected });
    }
  } finally { f.close(); }
});
```

Run: `bun test tests/derive.test.ts -t '工具版本保持旧写入口径'` 及 `bun run typecheck`；Expected: PASS。获授权时提交 `fix(derive): derive previews from current tool associations`，仅包含本任务文件及 note，使用规定 attribution。

## Task 3：迁移全部执行调用者与旧测试

**Files:**
- Modify: `src/derive.ts:608–738,779–893`
- Modify: `src/main.ts:209–215`
- Modify: `src/maintenance.ts:421–443`
- Modify: `scripts/backfill-fingerprint.ts:12,82–97`
- Test: `tests/derive.test.ts:200–289,492–609`、`tests/maintenance.test.ts`
- Modify on implementation: `docs/operations.md#rebuild`、所属 bug-fix note

**Interfaces:**
- Consumes: Task 2 的完整 `drainDerive`；`rebuildDerived(store: Store, convKey: string): RebuildReport` 保持原状。
- Produces: 本文开头的 `DeriveScope`、`DrainResult` 与三参数 drain；外部不再导出或调用 `pairToolCalls`。

- [x] **Step 1：增加范围及批量维护回归。** 在 maintenance 测试复用已有 `fixture`、`runMaintenance`、`join`；添加 101 个 actor 的目标会话和一个排序更早的其它会话任务。

```ts
test('维护重建排空目标会话且不消费其它会话积压', async () => {
  const f = fixture();
  try {
    f.store.write(db => {
      for (let i = 0; i < 101; i++) db.run(`INSERT INTO request(
        conv_key,actor,actor_state,started_ms,day,via,body_state,
        derive_version,have,created_at,updated_at)
        VALUES ('zz-target',?,'known',?,'2026-10-22','hook','available',0,1,1,1)`,
        [`actor-${i}`, i]);
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort)
        VALUES ('aa-other','actor-other','')`);
    });
    const lines: string[] = [];
    const code = await runMaintenance(['rebuild','--db',join(f.dir,'trace.db'),
      '--session','zz-target'], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, queue_remaining: 0,
      recomputed_requests: 0, retained_requests: 101 });
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM derive_queue
      WHERE conv_key='zz-target'`).get()).toEqual({ n: 0 });
    expect(f.store.read.query(`SELECT conv_key FROM derive_queue`).all())
      .toEqual([{ conv_key: 'aa-other' }]);
  } finally { f.close(); }
});
```

在同一 Task 的 `tests/maintenance.test.ts` 补充 `persistBody` import，并加入报告与历史标题保留回归：

```ts
test('维护报告分别计入可重算与缺正文保留请求', async () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,
      actor_state,started_ms,day,via,body_state,derive_version,have,created_at,
      updated_at,title,title_source) VALUES
      (1,'mixed','actor','known',1000,'2026-10-22','hook','pending',0,1,1,1,NULL,NULL),
      (2,'mixed','actor','known',2000,'2026-10-22','hook','evicted',0,1,1,1,
       'retained title','user_delta')`));
    persistBody(f.store, 1, { protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: 'synthetic input' }] },
      reply: { content: [] }, redact_version: 1 });
    const lines: string[] = [];
    const code = await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', 'mixed'], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ queue_remaining: 0,
      recomputed_requests: 1, retained_requests: 1 });
    expect(f.store.read.query(`SELECT title,title_source FROM request WHERE req_id=2`).get())
      .toEqual({ title: 'retained title', title_source: 'user_delta' });
  } finally { f.close(); }
});
```

Run: `bun test tests/maintenance.test.ts -t '维护重建排空目标会话|维护报告分别计入'`。Expected: FAIL，旧代码消费其它任务且留下目标组，或没有重算/保留计数。available 无骨架是首个测试刻意构造的防御形态，Task 0 修复后才按不可比较处理；当前未修代码会误当空序列。rebuildDerived 不论 body_state 都会为已知 actor 入队，测试无需假称 available 是入队前提，也不把队列排空称为正文复核成功。

- [x] **Step 2：实现范围与参数校验。** drain 的选组与 remaining 查询使用相同 scope；其它会话任务不影响目标排空。

```ts
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
  throw new Error('invalid_derive_scope');
}
// 位于同一个 store.write 回调内，先选组：
const groups = scope === undefined
  ? db.query<Group, [number]>(`SELECT conv_key,actor FROM derive_queue
      ORDER BY conv_key,actor LIMIT ?`).all(limit)
  : db.query<Group, [string, number]>(`SELECT conv_key,actor FROM derive_queue
      WHERE conv_key=? ORDER BY actor LIMIT ?`).all(scope.convKey, limit);
// 完成本批全部组并删除它们的任务后，再查询 remaining：
const remaining = scope === undefined
  ? (db.query('SELECT COUNT(*) AS n FROM derive_queue').get() as { n: number }).n
  : db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM derive_queue
      WHERE conv_key=?`).get(scope.convKey)!.n;
```

maintenance 替换一次 drain 和后置 pair 为目标循环。drain 在本批循环前初始化 recomputed/retained 为 0，每笔 current 非 null 时 recomputed++，否则 retained++；与 processed 一起随事务返回。统计描述本次执行范围，不表达算法版本，也不保证曾保留的摘要一定非空；空组两者均为 0。

```ts
// drain 的 store.write 回调内，组循环之前：
let recomputed = 0;
let retained = 0;
// drain 当前批次每笔确定 current 后：
if (current === null) retained += 1;
else recomputed += 1;
// drain 返回：
return { processed, remaining, groups: touched, recomputed, retained };
```

维护循环累加并输出 `recomputed_requests`、`retained_requests`。旧 unavailable/reasons 是按 body_state 的补采报告，不能代替上述实际比较状态；旧 derive_version/MAX 字段继续兼容，但明确不用于证明算法覆盖率，[C 批次](2026-10-22-atc-durable-rebuild.md)再迁移目标/实际版本。

```ts
let drained: ReturnType<typeof drainDerive>;
let recomputedRequests = 0;
let retainedRequests = 0;
do {
  drained = drainDerive(store, 100, { convKey: session });
  recomputedRequests += drained.recomputed;
  retainedRequests += drained.retained;
  if (drained.remaining > 0 && drained.groups.length === 0) {
    throw new Error('derive_no_progress');
  }
} while (drained.remaining > 0);
// 替换已有最终 JSON 写入：
out(JSON.stringify({
  ok: true, session, queued: report.queued, unavailable: report.unavailable,
  reasons: report.reasons, derive_version: version?.v ?? 0,
  queue_remaining: drained.remaining,
  recomputed_requests: recomputedRequests, retained_requests: retainedRequests,
}));
```

main 的 derive tick 只调用 `drainDerive(store)`；保留原日志和错误处理，删除配对 for 循环及 import。backfill 保留现有 `drainDerive(store,50)` 循环，删最终 groups 配对及 import；本计划不执行该脚本，也不顺带改其旧迁移行为。

- [x] **Step 3：通过完整 Interface 迁移旧工具测试并取消导出。** 删除所有测试里的后置 pair；原仅调用 pair 的重复 ID 测试先 enqueue 再 drain。原手改 prev_relation 的候选升级测试改为补充真实正文后重算，避免绕过链阶段：

```ts
// pending 初始断言保持。随后替换第二笔实际输入，再统一重算：
persistBody(f.store, 2, { protocol: 'anthropic',
  request: { messages: [
    { role: 'user', content: [{ type: 'text', text: 'q1' }] }, callMsg, resultMsg,
  ] }, reply: { id: 'msg_2', content: [] }, redact_version: 1 });
enqueueDerive(f.store, key, 'actor-a', '');
drainDerive(f.store);
expect(f.store.read.query(`SELECT state,result_req FROM tool_call
  WHERE call_id='toolu_u'`).get()).toEqual({ state: 'resolved', result_req: 2 });
```

删除 :270 的空壳；:200 的有效测试改名为完整组重建关闭重开后保持增量。将 limit=1 的有效契约放到有两个真实组的测试：首组 250 请求，另组一请求，断言第一次 processed=250、remaining=1，再调用得到 processed=1、remaining=0；组名确保首组按字节序先选中。Task 1 helper 的回归也删除显式 pair。最后删除导出的 pair 包装，仅保留内部事务函数。

- [x] **Step 4：补参数与空组断言后验证。** 使用 `fixture`：对 `limit` 为 0、-1、1.5、NaN 分别 `expect(() => drainDerive(f.store, limit)).toThrow('invalid_derive_limit')`；空 scope 字符串抛 `invalid_derive_scope`。直接插空组队列，drain 后 groups 包含该空组、processed=0、remaining=0、recomputed=0、retained=0，避免将其误判无进展。Run: `bun test tests/derive.test.ts tests/maintenance.test.ts` 与 `bun run typecheck`。Expected: PASS。Run: `rg -n 'pairToolCalls' src tests scripts`；Expected: 仅 derive 内部 `pairToolCallsTx` 定义与调用，外部无命中。

补充 `import { runMaintenance } from '../src/maintenance'`，在 `tests/derive.test.ts` 验证合成旧结果经过维护入口后与直接完整入口一致，同时保留费用、证据 owner 与正文引用：

```ts
test('合成旧排序经维护入口对齐且事实守恒', async () => {
  const direct = fixture(); const historical = fixture();
  try {
    for (const f of [direct, historical]) {
      seedRound(f.store, [1, 2], [1000, 2000]);
      f.store.write(db => {
        db.run(`UPDATE request SET cost=0.25,sort_key=CASE req_id
          WHEN 1 THEN '9:8:7:0|00000000000000000000'
          ELSE '1:2:3:0|00000000000000000100' END`);
        db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
          VALUES (1,'hook','synthetic-owner-1','merged',1),
                 (2,'hook','synthetic-owner-2','merged',1)`);
      });
    }
    rebuild(direct.store);
    historical.store.write(db => db.run(`UPDATE request SET
      prev_req_id=NULL,prev_relation='first',delta_ordinals='[0]',
      chain_role='main',title='synthetic old result',title_source='model_time'`));
    const facts = () => ({
      requests: historical.store.read.query(`SELECT req_id,cost,conv_key,actor
        FROM request ORDER BY req_id`).all(),
      owners: historical.store.read.query(`SELECT req_id,source_kind,ref_key,merge_state
        FROM request_evidence ORDER BY req_id,source_kind,ref_key`).all(),
      refs: historical.store.read.query(`SELECT req_id,ord,block
        FROM request_block ORDER BY req_id,ord`).all(),
    });
    const before = facts();
    const lines: string[] = [];
    expect(await runMaintenance(['rebuild', '--db', join(historical.dir, 'trace.db'),
      '--session', GROUP], { out: line => lines.push(line), err: () => {} })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ queue_remaining: 0,
      recomputed_requests: 2, retained_requests: 0 });
    expect(snapshot(historical.store, [1, 2])).toEqual(snapshot(direct.store, [1, 2]));
    expect(facts()).toEqual(before);
  } finally { direct.close(); historical.close(); }
});
```

Run: `bun test tests/derive.test.ts -t '合成旧排序经维护入口'`；Expected: PASS。这里通过 `runMaintenance` 测试 CLI 使用的命令处理入口，未启动真实采集进程。

- [x] **Step 5：同步运维说明并提交。** rebuild 的 queue_remaining 定义为目标会话未完成组；其它会话积压不被维护消费。保留 unavailable/reasons 字段和缺正文历史断言；不把当前 MAX 计数描述成算法覆盖率。获授权时提交 `fix(derive): route all callers through complete group execution`，附所属 note 与 attribution。

## Task 4：用事务故障和重开验证完成恢复

**Files:**
- Test: `tests/derive.test.ts`
- Modify on implementation: 所属 bug-fix note、`docs/architecture-design.md#乱序到达与重算`

**Interfaces:**
- Consumes: 完整 `drainDerive`、`fixture`、`openStore(path)`、Task 1 的 seed/snapshot；使用 SQLite trigger 注入失败，无生产测试开关。
- Produces: 工具插入、摘要更新和队列确认任一阶段失败，都回滚本批产物并保留持久任务；关闭重开可继续。

- [x] **Step 1：加入三个阶段故障的参数化回归。** 测试补 `openStore` 与 `join` import。触发器 SQL 为固定测试常量，不接受任意用户输入。

```ts
const injectedStages = [
  ['tool', `BEFORE INSERT ON tool_call`],
  ['preview', `BEFORE UPDATE OF input_preview ON request`],
  ['ack', `BEFORE DELETE ON derive_queue`],
] as const;
for (const [stage, event] of injectedStages) {
  test(`同步派生${stage}失败保留队列且重开可恢复`, () => {
    const f = fixture();
    let reopened: ReturnType<typeof openStore> | undefined;
    try {
      seedRound(f.store, [1, 2]);
      enqueueDerive(f.store, GROUP, ACTOR, '');
      const before = snapshot(f.store, [1, 2]);
      f.store.write(db => db.exec(`CREATE TRIGGER injected_derive ${event}
        BEGIN SELECT RAISE(ABORT,'injected_derive'); END`));
      expect(() => drainDerive(f.store)).toThrow('injected_derive');
      expect(snapshot(f.store, [1, 2])).toEqual(before);
      expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get())
        .toEqual({ n: 1 });
      f.store.write(db => db.exec('DROP TRIGGER injected_derive'));
      f.store.close();
      reopened = openStore(join(f.dir, 'trace.db'));
      expect(drainDerive(reopened).remaining).toBe(0);
      expect(snapshot(reopened, [1, 2]).tools[0]?.state).toBe('resolved');
      expect(snapshot(reopened, [1, 2]).requests[1]?.input_preview)
        .toBe('工具结果 · read_file');
    } finally { reopened?.close(); f.close(); }
  });
}
```

- [x] **Step 2：运行并解释结果。** Run: `bun test tests/derive.test.ts -t '失败保留队列且重开可恢复'`。Expected: Task 2 后 PASS；若在之前代码上运行，工具触发器不会在 drain 内触发，断言失败。该测试验证 SQLite 事务失败与重开恢复，不冒称执行了 kill/power-loss 实验。

- [x] **Step 3：验证旧结果、整批回滚和读连接可见性。** 第一次完整 rebuild 后记 snapshot；再次入队，在工具阶段失败，断言旧结果完全保留、队列仍在；移除触发器重新排空，snapshot 相同。再用两个组在第二组 ack 触发失败，断言本批两组均回滚，因为现有事务包围本批全部组；不对外宣称逐组独立提交。成功返回后 `store.read` 看到完整工具与摘要，不能看到完成队列已删而工具未写的状态。

```ts
// 两组回滚测试中的固定触发器：
f.store.write(db => db.exec(`CREATE TRIGGER fail_second_ack
  BEFORE DELETE ON derive_queue WHEN OLD.conv_key='zz-second'
  BEGIN SELECT RAISE(ABORT,'injected_second'); END`));
expect(() => drainDerive(f.store)).toThrow('injected_second');
expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 2 });
```

构造第二组时复用 seed 的两笔模式但使用不同 ID、conv_key/actor 与工具 ID；snapshot 分别按身份归一。只有测试创建的可读派生允许清空，缺正文保留断言继续使用 maintenance 已有测试。Run: `bun test tests/derive.test.ts tests/maintenance.test.ts`；Expected: PASS。若 Task 3 已跑过同一源码版本的 typecheck，此处只新增测试时按实际类型改动决定是否重跑，不机械重复。

- [x] **Step 4：完成文档与 note 验收。** 架构明确本批所有组选取在一个同步事务内，异常回滚本批、保留队列；不写成每组一个事务。note 记录合成回滚、重开、重复重建、历史保留的实际检查范围，以及没有切片、算法版本迁移和容量结果。保留统筹 proposed note，不能因 A 完成把整份 v2 标为 implemented。

- [x] **Step 5：检查并形成最终任务提交。** Run: `git diff --check`、`bun run verify:notes`；Expected: PASS。获提交授权时逐文件 stage 本任务，执行 `bun run verify:notes:staged` 后提交 `test(derive): verify transactional completion and restart recovery`，附 attribution；没有授权时报告未执行 staged 检查。不要运行默认路径的回填脚本或维护命令作为测试。

## 上线与历史结果对齐

本批代码测试通过只表示实现可交付。时间优先、空祖先保护、同毫秒证据门槛和可重算标题 fallback 都可能改变旧结果；仅部署代码不会给全部历史会话自动入队。上线范围必须逐会话明确，未重建范围及缺证据保留结果不能宣称已按新规则确认。

真实库操作不在当前授权内。获得单独授权后，在停止采集、取得符合当前恢复要求的备份并校验后，使用本批完成的维护入口逐个重建批准的目标会话；不运行指纹回填脚本代替派生重建，不删除来源或正文。合成库先验证以下报告及守恒：

```sh
# 仅允许替换为独立合成库路径；此处不是当前执行指令。
bun run maintain rebuild --db /private/tmp/atc-synthetic-plan/trace.db --session synthetic-derive
```

验收记录包含代码提交、目标会话清单、逐会话命令退出码、queue_remaining、recomputed_requests、retained_requests 和 unavailable/reasons。queue_remaining=0 只表示目标组执行完毕；retained_requests 必须单列，不把旧 derive_version 的 MAX 当作规则覆盖率。当前计数按请求描述本次执行，不提供逐字段或历史算法证明；[C 批次](2026-10-22-atc-durable-rebuild.md)再交付持久的目标/实际版本及原输入依据。

- [x] Task 3 的混合报告回归通过：recomputed_requests=1、retained_requests=1、queue_remaining=0，旧标题保留；101 个无骨架请求全部计入 retained_requests。
- [x] Task 3 的合成旧排序对齐回归通过：维护命令处理入口与直接完整入口的前驱、角色、工具和摘要一致，费用、owner 与正文引用不变。
- [ ] 部署前确认批准范围已经重建或明确列为未对齐；不以正常持续摄入最终会触发所有旧组为依据。若没有真实库授权，停在代码与合成验收，报告历史对齐未执行。

## 计划自审与最终交付

本计划的规格覆盖分配如下。未列为本批任务的 v2 要求全部在[总入口](2026-10-22-atc-evolution-implementation.md#交付依赖)明确所属批次，不把本批当成完整架构交付。

| 规格要求 | 本批任务与断言 |
| --- | --- |
| 正文缺失、无消息序列、引用不完整与合法空数组分离 | Task 0，无骨架前后位置、缺引用、真实 hook 两种降级、空祖先保护 |
| 统一时间/来源顺序，禁止 ID 制造语义先后 | Task 1，同毫秒换 ID、缺键、同键、混合来源及来源后补 |
| 保留任意祖先、标题旁路与不可读中性 | Task 1/2，既有派生测试继续执行 |
| 当前工具关联先于摘要、跨组不串名 | Task 2，首次/重复/清空可重算后等价，位置、歧义与历史行 |
| 一个完整入口、确认晚于所有阶段 | Task 2/3，取消外部 pair，三条运行调用者迁移 |
| 维护排空且范围准确、旧 limit 不偷换 | Task 3，101 组、其它积压、250 请求完整组契约 |
| 标题由当前可读输入确定、缺正文保持旧标题 | Task 2，旧标题污染、unknown 时间兜底、重复/清空后等价及回收标题保留 |
| 维护重算/保留分别报告、历史范围显式对齐 | Task 3 与上线条件，1/1 混合报告、101 个无骨架保留及合成旧结果重建 |
| 同步失败可恢复、原结果完整保留 | Task 4，三个触发器、重开、第二组失败整批回滚 |
| 版本、历史依据、持久修订与切片 | C/F 批次；本批只保留旧版本写入行为并报告本次执行范围，不提供持久算法覆盖证明 |

执行结束报告实际修改文件、对应失败到通过记录、旧行为保留和剩余限制。不能用本批测试宣布混合负载达标，也不能把临时故障注入称为真实流量验收。代码交付后，将本计划完成项勾选并链接实际提交；本次编写计划时全部保持未勾选。
