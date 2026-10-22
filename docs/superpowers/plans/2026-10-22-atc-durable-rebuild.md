# ATC 长期事实与显式重建实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 技能以执行会话可用列表为准；缺少时按同样测试与复核执行。本文件不授权真实库迁移、服务启动、切换或 push，代码提交按执行会话授权处理。

**Goal:** 用一次显式 v4→v5 迁移保存来源依据、请求与组修订和实际结果版本，使历史修复、恢复与持续摄入使用同一规则。

**Architecture:** 延续 B 的来源投影和 A 的完整同步派生，扩展既有 request、derive_queue、tool_call 与 collector_state。请求修订负责用途失效，持久组记录负责完整产物的发布修订；本批保持同步事务，F 的条件切片另升 v6。

**Tech Stack:** TypeScript、Bun 1.4.0、bun:sqlite、node:crypto、node:fs、node:zlib；无新增运行依赖。

**Spec:** [v2 历史修复](../../architecture-evolution-v2.md#历史修复与迁移)、[请求触发](../../architecture-evolution-v2.md#请求语义独立于会话归属)、[B 来源计划](2026-10-22-atc-source-projection.md)、[A 完整派生](2026-10-22-atc-derive-correctness.md)。本文冻结 v5 存储和恢复契约，D/E/F 消费这些定义。

## Global Constraints

- 单进程、SQLite WAL、同步单 writer、独立只读连接；yield 在事务外。
- 监听固定 127.0.0.1，数据目录在仓库外且 0700，文件 0600；正文统一脱敏并转义。
- 仅合成库、合成盐、独立路径；不运行旧 backfill 的默认真实路径。
- 保留请求 ID、alias、证据 owner、正文引用、费用观测、游标及淘汰墓碑；不清空证据或删库。
- adapter_version、redact_version 保留协议/正文语义；旧 derive_version 原值保存但退出算法覆盖判断。
- 不保存账号、host 的新长期副本，不公开内部 source JSON；不修改 block.fingerprint。
- `.agents/notes/archived/` 冻结；计划复选框不代表已实施。

---

## 基准、依赖与文件职责

文档基准 `00e20a2`，实施先完成 A、B 并重新定位函数。本批新增 `src/derive-state.ts` 管理修订和来源短集合、`src/migrate-v5.ts` 管理显式迁移；不建立通用迁移框架。新增 `scripts/migrate-v5.ts` 只解析显式参数并调用迁移；新增 `tests/migration-v5.test.ts`、`tests/derive-state.test.ts`。`src/store.ts`、`src/schema.sql` 持有结构与启动拒绝，`src/config.ts` 持有盐绑定，`src/maintenance.ts` 持有备份/恢复和报告。B 的 `src/sources/projection.ts` 继续持有字段选择，公共入口为 `projectRequestTx(db: Database, reqId: number, input: { now: number; mappingVersion: number }): RequestProjection`；`collectOwnerEvidenceTx(db: Database, reqId: number): OwnerEvidence` 统一收集 owner 证据。C 在该入口内保存新增长期信息，在线与离线不增加第二个投影包装。hook/body/retention/reconcile 在现有写事务标记输入变化，queries 负责同快照状态投影。

实施 note 新建 `.agents/notes/implemented/architecture/2026-10-22-durable-input-and-explicit-migration.md`，先搜索现有 schema、隐私、保留和来源记录；只部分取代的记录保持活跃并交叉链接。旧 schema note 中与代码一致的路径事实随交付更新，反转理由由新 note 持有。

## 冻结的 v5 存储契约

下面 SQL 是迁移 v4 的精确增量；新库在 schema.sql 原表中加入同样列、替换 derive_queue 定义。`ALTER` 不用于普通 openStore。

```sql
ALTER TABLE request ADD COLUMN model_provider TEXT;
ALTER TABLE request ADD COLUMN source_facts_json TEXT;
ALTER TABLE request ADD COLUMN projection_meta_json TEXT;
ALTER TABLE request ADD COLUMN input_epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE request ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN purpose_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE request ADD COLUMN purpose_target INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request ADD COLUMN purpose_version INTEGER;
ALTER TABLE request ADD COLUMN purpose_pending INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request ADD COLUMN purpose_status TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE request ADD COLUMN purpose_rule TEXT;
ALTER TABLE request ADD COLUMN purpose_signals TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request ADD COLUMN purpose_chain TEXT NOT NULL DEFAULT 'participate'
  CHECK(purpose_chain IN ('participate','exclude'));
ALTER TABLE request ADD COLUMN purpose_retry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN summary_algorithm INTEGER;
ALTER TABLE request ADD COLUMN summary_basis TEXT;
ALTER TABLE request ADD COLUMN summary_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tool_call ADD COLUMN algorithm_version INTEGER;
ALTER TABLE tool_call ADD COLUMN basis_json TEXT;
ALTER TABLE tool_call ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE raw_ledger ADD COLUMN err TEXT;
ALTER TABLE raw_ledger ADD COLUMN mapping_version INTEGER;
ALTER TABLE raw_ledger ADD COLUMN privacy_version INTEGER;
ALTER TABLE raw_route ADD COLUMN mapping_version INTEGER;
ALTER TABLE raw_route ADD COLUMN privacy_version INTEGER;
ALTER TABLE derive_queue ADD COLUMN group_epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE derive_queue ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN published_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE derive_queue ADD COLUMN target_algorithm INTEGER NOT NULL DEFAULT 1;
ALTER TABLE derive_queue ADD COLUMN published_algorithm INTEGER;
ALTER TABLE derive_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'dirty';
ALTER TABLE derive_queue ADD COLUMN dirty_since_ms INTEGER;
CREATE INDEX i_req_purpose_pending ON request(purpose_pending,req_id)
  WHERE purpose_pending=1;
CREATE INDEX i_derive_dirty ON derive_queue(state,conv_key,actor) WHERE state='dirty';
```

每个新请求的 epoch 使用 `randomUUID()`；迁移逐行补值，不使用 SQL 默认空串作为有效身份。合并存活 owner 重置 epoch 并增加 revision，删行后重建的组也必须新 epoch。`purpose_revision` 表示已消费输入修订，即使终态为 retained/missing/error 也记录本次输入；`purpose_version` 只在实际重新解释时更新。判定状态集合为 recognized/unrecognized/missing/retained/unsupported/error。`purpose_chain` 为 participate/exclude，取值由 DDL 的 CHECK 封闭，D 是唯一写入者。

新请求、空迁移epoch、既有dirty组的dirty_since_ms在迁移project阶段按本次now初始化。`dirty_since_ms`只表示首次未完成触发时间，重复dirty保最早值，clean后清NULL；容量积压年龄按它计算，不拿历史started_ms冒充等待时间。

`derive_queue` 从待办集合变为持久组状态；clean 行保留，pending 查询一律 `state<>'clean'`。输入变化增加 input_revision，完成记录 published_revision、published_algorithm；任何事务失败均不能提前改 clean。v5 不出现跨事务 running，也不预建代际表。`from_sort` 仅定位影响起点，A 仍完整重建。

```ts
// 版本常量的家：raw 行的 mapping_version 与 projectRequestTx 的 mappingVersion 是同一条
// raw→事实 映射链，只用 B 在 src/sources/projection.ts 导出的 SOURCE_PROJECTION_VERSION，
// 不另立第二份版本号；隐私变换版本放在 src/privacy.ts，与脱敏实现同居一处。
export const PRIVACY_TRANSFORM_VERSION = 1; // src/privacy.ts
export const GROUP_ALGORITHM = 1; // src/derive-state.ts
export type BoundedValues = {
  values: string[]; overflow: boolean; missing: boolean; invalid: boolean;
};
export type SourceFacts = {
  format: 1;
  orderState: 'provable' | 'unprovable' | 'unknown';
  kinds: { ledger: BoundedValues; route: BoundedValues;
    state: 'single' | 'agree' | 'conflict' | 'missing' | 'invalid' | 'overflow';
    value: string | null };
  hook: { models: BoundedValues; successes: ('success' | 'failure')[] };
  selected: null | { ref: string | null;
    state: 'final' | 'failed' | 'pending_final' | 'retained' | 'missing';
    modelProvider: string | null; served: string | null; effort: string | null;
    tierAsked: string | null; tierSent: string | null; tierServed: string | null;
    error: string | null; errorType: string | null };
};
export type ProjectionMeta = {
  format: 1;
  families: Record<'models' | 'attempts' | 'prompt', {
    actualVersion: number | null;
    state: 'recomputed' | 'retained' | 'missing';
    reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
    basis: string[];
  }>;
};
```

集合每源最多 8 个、每值最多 256 UTF-8 字节，以 `Buffer.compare` 取最小的 8 个，溢出 sticky。缺失、非法和非空值分别保存；缺键不撤销已有值。完整值超过 256 字节不截断后当成有效 kind，记录 invalid+overflow；basis 最多 16 个证据引用、每个 256 字节，超过只保留稳定样本并以 retained/expired_input 表示不足，不将短样本当完整尝试集。短错误摘要脱敏后最多 512 字符，超限截断仅供展示；selected其余字符串最多256 UTF-8字节，超过不截断身份当有效值，置null并降族为retained/invalid_input。

映射版本按事实族记录；完整 raw 才可更新该族 actualVersion。若需从部分输入继续累计却无稳定尝试身份，本轮保留旧合计并报告 limitation，不增不减、不用 MAX。完整证据才重建最终尝试与计费合计。`model_requested` 专指 ledger.req，`model_provider` 专指选定 ledger.model，`model_served` 专指实得 served；独立 hook 报告仅存 hook 集合。旧错误 fallback 无证据可纠正时将对应列置 NULL 并保留 legacy_unknown 状态，不将旧值重新作为可信输入。

route_summary.z 在既有 summary 中升级为 format=2，加入 kind、folder、effort、error 和受支持 prompt；不创建第三份摘要：

```ts
type RetainedPrompt = { tokens: number; counted: boolean; window: number | null;
  held: boolean | null; parts: unknown[] };
type RouteSummaryV2 = {
  format: 2; kind: string | null; folder: string | null; effort: string | null;
  error: string | null; prompt: RetainedPrompt | null;
  order?: unknown; tries?: unknown; affinity?: unknown;
};
```

保留现有 summary 的其它安全字段与 order/tries 读取行为；`prompt` 由 B 的合法形状检查结果构造，缺失和非法为 null。旧 z 未含字段时保持未知，不能把它当完整 raw_route。E 的详情仅返回显式白名单，不返回 source_facts_json、account、host 或任意 payload。

## Task 1：落 v5 结构与未完成启动拒绝

**Files:** Modify `src/schema.sql`、`src/store.ts`；Create `src/conservation.ts`、`src/migrate-v5.ts`、`tests/migration-v5.test.ts`；实施时更新 schema note 与新 note。

**Interfaces:** `openStore(path: string, options?: { allowIncompleteMigration?: boolean }): Store` 只允许显式迁移绕过完成标记，不允许普通低版本自动补列。`initializeV5(db: Database): void` 是迁移内部函数。`collector_state['migration:v5']` 的精确 `MigrationState` 类型由 Task6 定义，包含不可变 baseline 和累计扫描报告；首次新库直接创建 complete=true。第一轮结构升级是全库，按会话范围只用于之后的逻辑 rebuild，不能把半库结构迁移声明完成。

- [ ] **Step 1：写失败回归。** 合成 v4 fixture 从本次提交 `00e20a2:src/schema.sql` 固定为 `tests/fixtures/schema-v4.sql`，保留原始内容；测试不用运行时 git 命令生成。辅助 `legacyFixture` 见下代码，在后续本文件复用。

```ts
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { initializeV5 } from '../src/migrate-v5';
function legacyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-v5-test-'));
  const path = join(dir, 'trace.db');
  const db = new Database(path);
  db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;');
  db.exec(readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA user_version=4');
  let closed=false;
  const closeDb=()=>{if(!closed){db.close();closed=true;}};
  return { dir,path,db,closeDb,
    close(){closeDb();rmSync(dir,{recursive:true,force:true});} };
}
test('v5结构和未完成标记原子提交并拒绝普通打开', () => {
  const f = legacyFixture();
  try {
    initializeV5(f.db);
    expect(f.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(() => openStore(f.path)).toThrow('migration_incomplete');
  } finally { f.close(); }
});
```

- [ ] **Step 2：观察目标失败。** Run `bun test tests/migration-v5.test.ts -t 'v5结构'`；Expected FAIL，迁移函数不存在。实现后必须消除导入/语法错误，再核验未完成拒绝，不将导入失败视为完整行为验证。
- [ ] **Step 3：实现初始化。** 上述 SQL 作为 `V5_DELTA` 固定字符串；函数仅允许 v4，v5 已有标记返回、未知结构拒绝。不要逐列错误吞掉后继续。

```ts
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { conservationDigest } from './conservation';
// V5_DELTA 是本文件顶部的固定字符串常量，内容就是上面那段 SQL。
export function initializeV5(db: Database): void {
  const version = (db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
  if (version === 5) {
    // Task 6 把这段最小校验替换为 readMigrationState(db)。
    const marker = db.query<{value_json:string},[]>(
      "SELECT value_json FROM collector_state WHERE key='migration:v5'").get();
    if (marker === null) throw new Error('migration_marker_missing');
    let saved: unknown;
    try { saved = JSON.parse(marker.value_json); } catch { throw new Error('migration_marker_invalid'); }
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
      || (saved as {format?:unknown}).format !== 1
      || (saved as {target?:unknown}).target !== 5
      || typeof (saved as {complete?:unknown}).complete !== 'boolean')
      throw new Error('migration_marker_invalid');
    return;
  }
  if (version !== 4) throw new Error('migration_source_unsupported');
  db.transaction(() => {
    const baseline=conservationDigest(db);
    db.exec(V5_DELTA);
    // 仅初始化旧队列身份；不扫描或重写正文，不在此完成派生。
    for(const row of db.query<{conv_key:string;actor:string},[]>(
      'SELECT conv_key,actor FROM derive_queue').iterate())
      db.run('UPDATE derive_queue SET group_epoch=?,dirty_since_ms=? WHERE conv_key=? AND actor=?',
        [randomUUID(),Date.now(),row.conv_key,row.actor]);
    db.run(`INSERT INTO collector_state(key,value_json) VALUES ('migration:v5',?)`,
      [JSON.stringify({format:1,target:5,phase:'remap',cursor:null,scope:'all',complete:false,
        baseline,report:{scanned:0,remapped:0,projected:0}})]);
    db.exec('PRAGMA user_version=5');
  }).immediate();
}
```

`PRAGMA user_version` 在同一 SQLite 事务内与 DDL 提交。用 trigger/抛异常回滚断言确认，而非沿用旧脚本关于事务外写版本的注释。store 的 SCHEMA_VERSION 改5；新库建表事务写 `{format:1,target:5,phase:'complete',cursor:null,scope:'all',complete:true,baseline:conservationDigest(db),report:{scanned:0,remapped:0,projected:0}}`；`conservationDigest` 放 `src/conservation.ts`，由 store 与 migrate-v5 共同导入，store 不导入 migrate 形成循环。v5 marker 缺失抛 migration_marker_missing，不完整且未显式 allow 抛 migration_incomplete。openStore 失败时关闭 writer，不能因早退留下连接。

- [ ] **Step 4：补原子失败与新库用例。** 在collector_state创建拒绝marker的trigger后初始化，断言整个DDL及user_version回滚；移除trigger后重跑成功。

```ts
test('v5初始化marker失败回滚全部DDL',()=>{
  const f=legacyFixture();
  try {
    f.db.exec(`CREATE TRIGGER fail_v5_marker BEFORE INSERT ON collector_state
      WHEN NEW.key='migration:v5' BEGIN SELECT RAISE(ABORT,'injected_marker'); END`);
    expect(()=>initializeV5(f.db)).toThrow('injected_marker');
    expect(f.db.query('PRAGMA user_version').get()).toEqual({user_version:4});
    expect((f.db.query('PRAGMA table_info(request)').all() as {name:string}[])
      .some(row=>row.name==='input_epoch')).toBe(false);
    f.db.exec('DROP TRIGGER fail_v5_marker');
    initializeV5(f.db);
    expect(f.db.query('PRAGMA user_version').get()).toEqual({user_version:5});
  }finally{f.close();}
});
test('新空库v5标记完整',()=>{
  const f=fixture();
  try {
    expect(f.store.read.query('PRAGMA user_version').get()).toEqual({user_version:5});
    const row=f.store.read.query<{value_json:string},[]>(
      "SELECT value_json FROM collector_state WHERE key='migration:v5'").get()!;
    expect(JSON.parse(row.value_json)).toMatchObject({target:5,phase:'complete',complete:true});
  }finally{f.close();}
});
```

Run `bun test tests/migration-v5.test.ts tests/store.test.ts`；Expected PASS。
- [ ] **Step 5：记录结构与拒绝理由。** 更新现行架构和新 note，说明普通启动拒绝、显式续跑与原子初始化；有提交授权时提交 `feat(store): add durable v5 state and explicit migration gate`。

## Task 2：让输入变化与完成确认持久且不可复用

**Files:** Create `src/derive-state.ts`、`tests/derive-state.test.ts`；Modify `src/derive.ts`、`src/body.ts`、`src/hook.ts`、`src/reconcile.ts`、`src/retention.ts`、`src/maintenance.ts`。

**Interfaces:** 导出 `markRequestInputTx(db: Database, reqId: number): void`、`markGroupDirtyTx(db: Database, convKey: string, actor: string, fromSort: string): void`、`markRequestGroupsTx(db: Database, reqId: number): void`。调用者传当前 writer，不再嵌套 Store.write。正常新请求插入后调用一次 mark，重复证据提前返回时不调用；同事务多处 mark 可增加多次修订，正确性只依赖单调性，不承诺恰好增1。

- [x] **Step 1：写失效测试。** 在测试中用现有 fixture 和单笔合成 INSERT；断言 input_epoch 非空，正文保存后 input_revision 增长；只改 cost 时不增长。给组写 clean 后再次标记，组 epoch 不变但 input_revision 增长；删除重建组时 epoch 不同。重复同 hook_id 不改变修订，补正文、merge、回收均改变。直接 hook 命中已有 ledger 的回归沿用 A hook fixture，但取消显式 enqueue，改断言 dirty 和 purpose_pending=1。

```ts
import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { markGroupDirtyTx } from '../src/derive-state';
test('组完成后再次触发不复用旧修订', () => {
  const f=fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db,'k','a',''));
    const first=f.store.read.query('SELECT * FROM derive_queue').get() as any;
    f.store.write(db => db.run(`UPDATE derive_queue SET state='clean',
      published_revision=input_revision,published_algorithm=target_algorithm`));
    f.store.write(db => markGroupDirtyTx(db,'k','a',''));
    const next=f.store.read.query('SELECT * FROM derive_queue').get() as any;
    expect(next.group_epoch).toBe(first.group_epoch);
    expect(next.input_revision).toBeGreaterThan(first.input_revision);
    expect(next.state).toBe('dirty');
  } finally { f.close(); }
});
```

- [x] **Step 2：运行目标测试。** Run `bun test tests/derive-state.test.ts`；Expected FAIL，helper未定义或clean组不可再次触发。
- [x] **Step 3：实现共享修订操作。** schema版本迁移期间批量epoch初始化使用randomUUID，非空检查失败拒绝发布。

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
export function markGroupDirtyTx(db: Database, convKey: string, actor: string, fromSort: string): void {
  db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,
    input_revision,published_revision,target_algorithm,state,dirty_since_ms)
    VALUES (?,?,?,?,1,-1,1,'dirty',?) ON CONFLICT(conv_key,actor) DO UPDATE SET
    input_revision=derive_queue.input_revision+1,state='dirty',
    dirty_since_ms=CASE WHEN derive_queue.state='clean' THEN excluded.dirty_since_ms
      ELSE COALESCE(derive_queue.dirty_since_ms,excluded.dirty_since_ms) END,
    from_sort=MIN(derive_queue.from_sort,excluded.from_sort)`,
    [convKey,actor,fromSort,randomUUID(),Date.now()]);
}
export function markRequestGroupsTx(db: Database, reqId: number): void {
  const row=db.query<{conv_key:string|null;actor:string|null;actor_state:string},[number]>(
    'SELECT conv_key,actor,actor_state FROM request WHERE req_id=?').get(reqId);
  if (row?.actor_state==='known' && row.conv_key!==null && row.actor!==null)
    markGroupDirtyTx(db,row.conv_key,row.actor,'');
}
export function markRequestInputTx(db: Database, reqId: number): void {
  db.run(`UPDATE request SET input_epoch=CASE WHEN input_epoch='' THEN ? ELSE input_epoch END,
    input_revision=input_revision+1,purpose_pending=1,purpose_retry=0 WHERE req_id=?`,
    [randomUUID(),reqId]);
  markRequestGroupsTx(db,reqId);
}
```

`enqueueDeriveTx` 委托 markGroupDirtyTx，保留原 known owner守卫；drain选择及remaining仅dirty。组读到 `{group_epoch,input_revision,target_algorithm}` 后，原事务所有阶段完成才CAS更新：

```ts
const changed=db.run(`UPDATE derive_queue SET state='clean',dirty_since_ms=NULL,
  published_revision=?,published_algorithm=? WHERE conv_key=? AND actor=?
  AND group_epoch=? AND input_revision=? AND target_algorithm=?`,
  [group.input_revision,group.target_algorithm,group.conv_key,group.actor,
   group.group_epoch,group.input_revision,group.target_algorithm]).changes;
if(changed!==1) throw new Error('derive_input_changed');
```

`group` 查询类型扩全部字段；scope、limit组数和processed请求数沿用A。迁移A的ack故障trigger为 BEFORE UPDATE OF state WHEN NEW.state='clean'；不要保留只监听DELETE的假覆盖。verifyDatabase与维护pending统计、A测试COUNT均过滤dirty；clean行不是积压。

- [x] **Step 4：接入全部写入者。** persistBodyTx 保存完成时标记；acceptHook在直接命中及插入完成时标记，metadata-only也标记；mergeHookInto 在改owner前标两旧组、改后重置存活request epoch再mark，不能复制clean。reconcile按字段输入投影差异标记，不因费用刷新调用；route kind变化同样标记。evictOldestBodyBatch在删正文的同一事务按候选req_id标记；pruneRaw在证据expired同事务更新projection completeness，不把raw过期当新的缺失kind撤销。元数据purge在删除前标原组，空组同步clean。Run `bun test tests/derive-state.test.ts tests/hook.test.ts tests/retention.test.ts tests/derive.test.ts`；Expected PASS；为上列每个入口沿用现有真实helper构造最窄测试，不能只测共享helper。
- [x] **Step 5：同步契约与note。** 显式保留clean组增长成本交F测量；没有安全GC证据时不自动删状态。有提交授权时提交 `feat(derive): persist input revisions and group completion`。

## Task 3：保存有界来源事实与实际算法依据

**Files:** Modify B来源投影、`src/sources/raw.ts`、`src/privacy.ts`、`src/derive-state.ts`、`src/reconcile.ts`、`src/hook.ts`、`src/derive.ts`、`tests/reconcile.test.ts`、`tests/derive-state.test.ts`。

**Interfaces:** `mergeValues(old: BoundedValues, observed: unknown): BoundedValues`、`mergeSourceFacts(left: SourceFacts, right: SourceFacts): SourceFacts` 为纯函数；投影读写source_facts_json与projection_meta_json仍在原事务。选定尝试由B完整owner证据收集决定；事实JSON不接管身份分配或费用API。

- [ ] **Step 1：落集合顺序及raw过期回归。** 8值上限、重复输入、非法值、缺失输入、两来源冲突都用集合排列测同结果；不将到达时间列计入比较。

```ts
const empty=():BoundedValues=>({values:[],overflow:false,missing:false,invalid:false});
test('有界kind集合不受排列和重复影响',()=>{
  const source=['z','a','b','c','d','e','f','g','h','i'];
  const fold=(values:unknown[])=>values.reduce<BoundedValues>(mergeValues,empty());
  expect(fold(source)).toEqual(fold([...source].reverse().concat(source)));
  expect(fold(source).values).toEqual(['a','b','c','d','e','f','g','h']);
  expect(fold(source).overflow).toBe(true);
  expect(mergeValues(fold(['chat']),undefined).values).toEqual(['chat']);
});
```

在reconcile既有多行ledger fixture上先得合计30，expire一个owner raw再重放另一最终行，断言仍30且attempts retained/expired_input，不得变20或MAX新旧；再按完整raw恢复重算，断言actualVersion=1。hook-only、直接命中、merge和ledger到达排列均保留独立hook模型及success，status不再由success补200。

- [ ] **Step 2：运行。** Run `bun test tests/derive-state.test.ts tests/reconcile.test.ts tests/hook.test.ts`；Expected对应新断言FAIL。
- [ ] **Step 3：实现集合与来源记录。** 共享placeholder幂等用B修复，不在这里再次redact全payload。

```ts
export function mergeValues(old:BoundedValues, observed:unknown):BoundedValues {
  const valid=typeof observed==='string' && observed.trim().length>0;
  const oversized=valid && Buffer.byteLength(observed as string)>256;
  const values=[...new Set([...old.values,...(valid&&!oversized?[observed as string]:[])])]
    .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  return {values:values.slice(0,8),overflow:old.overflow||oversized||values.length>8,
    missing:old.missing||observed==null||observed==='',
    invalid:old.invalid||oversized||(observed!=null&&typeof observed!=='string')};
}
```

mergeSourceFacts 使用以下纯操作。它不接受selected的部分字段更新；右侧selected为一次完整选择或显式retained/missing，原子替换整个对象。

```ts
function unionValues(a:BoundedValues,b:BoundedValues):BoundedValues {
  const merged=b.values.reduce<BoundedValues>(mergeValues,a);
  return {...merged,overflow:merged.overflow||b.overflow,
    missing:merged.missing||b.missing,invalid:merged.invalid||b.invalid};
}
function kindState(ledger:BoundedValues,route:BoundedValues):SourceFacts['kinds'] {
  const all=[...new Set([...ledger.values,...route.values])];
  const state=ledger.overflow||route.overflow?'overflow'
    :ledger.invalid||route.invalid?'invalid':all.length>1?'conflict'
    :all.length===0?'missing':ledger.values.length&&route.values.length?'agree':'single';
  return {ledger,route,state,value:state==='single'||state==='agree'?all[0]??null:null};
}
export function mergeSourceFacts(left:SourceFacts,right:SourceFacts):SourceFacts {
  const ledger=unionValues(left.kinds.ledger,right.kinds.ledger);
  const route=unionValues(left.kinds.route,right.kinds.route);
  return {format:1,kinds:kindState(ledger,route),hook:{
    models:unionValues(left.hook.models,right.hook.models),
    successes:[...new Set([...left.hook.successes,...right.hook.successes])].sort(),
  },selected:right.selected};
}
function projectionFamily(old:ProjectionMeta['families']['models']|undefined,
  family:FamilyProjection,hadValue:boolean):ProjectionMeta['families']['models'] {
  const basis=[...new Set(family.basis)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .filter(ref=>Buffer.byteLength(ref)<=256);
  const bounded=basis.length<=16&&basis.length===new Set(family.basis).size;
  if(family.current&&bounded)return {actualVersion:family.version,
    state:'recomputed',reason:'complete',basis};
  return {actualVersion:old?.actualVersion??null,state:hadValue?'retained':'missing',
    reason:family.state==='invalid'?'invalid_input'
      :family.state==='expired'||family.state==='partial'||!bounded?'expired_input':'legacy_unknown',
    basis:old?.basis??basis.slice(0,16)};
}
```

B 的 `identity.orderState` 是 C 读模型的必须输入：`provable` 才允许把 sort_key/sort_source 当当前顺序依据；`unprovable` 表示 B 已清空排序键，属未知而非 retained；`unknown` 表示证据不完整、旧键被保留，必须按非 current 处理。C 不自行重建顺序证据，也不把清空写成历史保留。缺少该字段的旧投影按 unknown 处理。

在B的projectRequestTx写入前读取旧事实与旧族metadata；B的selected/attempts/prompt分别映射C models/attempts/prompt。`families.selected.current`才确认模型族；kind.current只表示当前来源用途投影，不确认模型。将B hook布尔集合映射为success/failure，kind每来源observed union到旧集合。selected完整时从p.selected整体形成SourceFacts.selected；p.attempts.outcome=pending_final则保存state pending_final且ref/modelProvider/served/effort/tier/error字段全null；证据过期时保持旧selected字段并改retained，缺旧值则null。合并owner后证据不完整且两个旧selected不同，写pending_final全null，不拼字段。以上JSON与request列同事务更新，不回写原payload。

删除hook插入时requested/served/status伪赋值；新值仅进入hook JSON，由投影写ledger三模型列。`raw_ledger.err`独立于`err_type`：B 的`mapLedgerRow`读出`err`，但B的`LEDGER_COLUMNS`不含该列，因为列由C新增。C在同一任务扩展`src/sources/raw.ts`的四个原始行helper，让在线INSERT/UPDATE一并写`err`、`mapping_version=SOURCE_PROJECTION_VERSION`、`privacy_version=PRIVACY_TRANSFORM_VERSION`以及`raw_route`的两列；否则在线新行这三列恒为NULL，只有迁移行带版本，v2要求的来源映射与隐私变换版本只兑现一半。route_summary.z按前述format2写，旧格式解码不补不存在字段。request摘要可比较时 `summary_algorithm=GROUP_ALGORITHM,summary_basis=JSON.stringify({epoch,input_revision,group_epoch,group_revision}),summary_state='recomputed'`；不可比较时保留原算法/basis，summary_state=retained，原无版本仍null。新tool行写算法/basis及recomputed，保留行原metadata不变，仅retention_state=retained；旧derive_version不再累加，也不再读它判断算法目标。C是明确版本迁移点，A的2/8/9兼容断言在此替换为新算法固定值与旧原值保留断言。

短集合、selected、版本和basis须给F报告每请求字节分布，不以SQL TEXT无上限当预算。`source_facts_json`上限16KiB、`projection_meta_json`上限16KiB；序列化超过上限先移除仅展示的error/errorType并标invalid，仍超限则拒绝该投影事务 `source_facts_budget_exceeded`，不截断JSON或清空旧事实。basis超过预算只保存稳定样本并降为retained；不把样本的actualVersion提升到本次版本。

- [ ] **Step 4：让在线原始行写入版本列。** 先写会失败的回归，再按上面的说明改 helper。

```ts
test('在线摄入的原始行带映射与隐私版本',()=>{
  const f=fixture();
  try {
    ingestLedger(f.store,'usage.jsonl',batchOf([{t:'2026-10-20T00:00:00Z',route_id:7,
      err:'synthetic error',err_type:'rate_limit',in:10,out:5}]),1,salt);
    expect(f.store.read.query(`SELECT err,err_type,mapping_version,privacy_version
      FROM raw_ledger`).get()).toEqual({err:'synthetic error',err_type:'rate_limit',
      mapping_version:SOURCE_PROJECTION_VERSION,privacy_version:PRIVACY_TRANSFORM_VERSION});
    ingestRoute(f.store,[{id:7,time:'2026-10-20T00:00:00Z',agent:'demo',session:'s'}],1,salt);
    expect(f.store.read.query(`SELECT mapping_version,privacy_version FROM raw_route`)
      .get()).toEqual({mapping_version:SOURCE_PROJECTION_VERSION,
      privacy_version:PRIVACY_TRANSFORM_VERSION});
  } finally {f.close();}
});
```

在B的`LEDGER_COLUMNS`补`err`，并在`ledgerColumns`与`routeColumns`末尾补三个值与两个版本值；映射本身不改，字段读取仍由B的`mapLedgerRow`/`mapRouteRow`决定。`insertPreparedLedgerTx`、`writePreparedLedgerTx`、`upsertPreparedRouteTx`、`writePreparedRouteTx`四个入口走同一份列清单，不能只改其中一个。`src/sources/raw.ts`从`./projection`导入`SOURCE_PROJECTION_VERSION`、从`./privacy`导入`PRIVACY_TRANSFORM_VERSION`；回归文件同样导入这两个常量，不从测试里写字面量。Run: `bun test tests/reconcile.test.ts`；Expected PASS。

- [ ] **Step 5：验证报告。** maintenance输出 `{target_algorithm, recomputed_requests, retained_requests, legacy_requests, pending_groups, actual_algorithms}`；actual_algorithms按所有实际行分组计数，null归legacy，不能MAX。保留queued/unavailable/reasons兼容字段并说明只表示body状态。在混合可读/回收用例断言recomputed1/retained1/legacy1和旧版本null；重复运行结果稳定。Run上述相关测试与 `bun run typecheck`；Expected PASS。
- [ ] **Step 6：补文档与note。** 版本目标、实际和保留分别描述，有提交授权时提交 `feat(projection): retain bounded source facts and result provenance`。

## Task 4：同一入口完成请求待处理与安全读取

**Files:** Modify `src/derive.ts`、`src/queries.ts`、`src/maintenance.ts`、`tests/derive.test.ts`、`tests/queries.test.ts`。

**Interfaces:** C 的 `LEGACY_PURPOSE_VERSION=1` 仅迁移现有title/chat行为；D替换为版本2，不在C新增classifier。`DrainResult` 在 A 返回值上增加 `purpose_processed:number,purpose_remaining:number`；remaining仍表示dirty组数。提取 `drainDeriveTx(db: Database, options: { limit: number; scope?: DeriveScope; purposeLimit?: number }): DrainResult`，原 `drainDerive(store, limit=100, scope?)` 仅校验参数后 `store.write(db=>drainDeriveTx(db,{limit,scope}))`。这是迁移与在线共用的事务 Seam，不导出链/工具/摘要的单独完成入口。`DeriveScope={convKey:string}` 沿用 A，scope存在时请求待处理筛conv_key，未知actor不被排除。用途阶段 C 内部 `drainLegacyPurposeTx(db:Database,limit:number,scope?:DeriveScope):{processed:number;remaining:number}`；D 用同一事务内的 `drainRequestPurposesTx` 替换该调用，不能同时运行两种分类器。

- [ ] **Step 1：固定actor未知也能完成兼容用途。** 用hook-only fixture存title回复，调用drain一次，断言req_kind=title、purpose_pending=0、purpose_version=1、无actor哨兵组。回收后再次标记，保留title及原version、status=retained且purpose_revision消费当前修订。query在组dirty时前驱/delta/链角色/tool结果不得作为当前确认返回，事实和原文可读。
- [ ] **Step 2：观察FAIL。** Run `bun test tests/derive.test.ts tests/queries.test.ts -t '待处理|dirty|未知归属'`，测试名与新增测试对应；Expected未排请求pending或旧关系仍confirmed。
- [ ] **Step 3：实现兼容请求阶段。** 在drain同一同步writer开始，按req_id取最多100个pending请求；先复用A可比较性及现有replyInfo读取，识别title行为保持。可读按既有title规则写 recognized/title 或 unrecognized/chat，rule为legacy.title/legacy.default；不可读有旧purpose_version保留原值，status retained，否则missing；purpose_chain来自结果，pending清0、revision=input_revision。该阶段不标自己请求输入变化；若用途/chain/model_title实际改变，只标所属组。组阶段选择前先执行请求阶段，组内仍有purpose_pending时跳过保留dirty，不允许完成；main/backfill继续调用drain同一入口，maintenance用purpose_remaining和remaining都为0作排空条件，遇无进度显式错误。

```ts
function drainLegacyPurposeTx(db:Database,limit:number,scope?:DeriveScope):{
  processed:number;remaining:number
} {
  const rows=scope===undefined
    ?db.query<LegacyPurposeRow,[number]>(`SELECT req_id,conv_key,actor,input_revision,
      purpose_version,purpose_chain,req_kind,model_title FROM request
      WHERE purpose_pending=1 ORDER BY req_id LIMIT ?`).all(limit)
    :db.query<LegacyPurposeRow,[string,number]>(`SELECT req_id,conv_key,actor,input_revision,
      purpose_version,purpose_chain,req_kind,model_title FROM request
      WHERE purpose_pending=1 AND conv_key=? ORDER BY req_id LIMIT ?`).all(scope.convKey,limit);
  for(const row of rows) {
    const readable=fingerprintsOf(db,row.req_id)!==null;
    const reply=readable?replyInfoOf(db,row.req_id):null;
    const retained=!readable&&row.purpose_version!==null;
    const isTitle=readable&&(reply?.modelTitle!==null||row.req_kind==='title');
    const status=readable?(isTitle?'recognized':'unrecognized'):(retained?'retained':'missing');
    const actualVersion=readable?LEGACY_PURPOSE_VERSION:row.purpose_version;
    const kind=readable?(isTitle?'title':'chat'):row.req_kind;
    const chain=readable?(isTitle?'exclude':'participate'):row.purpose_chain;
    const modelTitle=readable?(reply?.modelTitle??(isTitle?row.model_title:null)):row.model_title;
    db.run(`UPDATE request SET purpose_pending=0,purpose_retry=0,
      purpose_revision=input_revision,purpose_status=?,purpose_version=?,
      purpose_rule=?,purpose_chain=?,req_kind=?,model_title=? WHERE req_id=?`,
      [status,actualVersion,readable?(isTitle?'legacy.title':'legacy.default'):null,
       chain,kind,modelTitle,row.req_id]);
    if(chain!==row.purpose_chain||kind!==row.req_kind||modelTitle!==row.model_title)
      markRequestGroupsTx(db,row.req_id);
  }
  const remaining=scope===undefined
    ?(db.query('SELECT COUNT(*) n FROM request WHERE purpose_pending=1').get() as {n:number}).n
    :db.query<{n:number},[string]>(
      'SELECT COUNT(*) n FROM request WHERE purpose_pending=1 AND conv_key=?').get(scope.convKey)!.n;
  return {processed:rows.length,remaining};
}
type LegacyPurposeRow={req_id:number;conv_key:string|null;actor:string|null;input_revision:number;
  purpose_version:number|null;purpose_chain:string;req_kind:string;model_title:string|null};
// drainDeriveTx开头调用：
const purpose=drainLegacyPurposeTx(db,options.purposeLimit??100,options.scope);
// 组阶段开始前：
const waiting=db.query<{n:number},[string,string]>(`SELECT COUNT(*) n FROM request
  WHERE conv_key=? AND actor=? AND purpose_pending=1`).get(group.conv_key,group.actor)!.n;
if(waiting>0) continue;
// 原A的DrainResult返回对象附purpose_processed:purpose.processed、purpose_remaining:purpose.remaining。
```

queries.listRequests/getRequestDetail/listSessions等用一次只读transaction读取组状态与结果。当前可用条件为state=clean、input_revision=published_revision、target_algorithm=published_algorithm，且请求purpose_pending=0。prompt事实族只有projection_meta_json.families.prompt.state=recomputed时作为当前值返回；B因非法/缺失新route而保留的旧列在历史详情附retained/invalid_input，不用于当前上下文比例。dirty时关系与delta null，chain_role返回unknown，依赖增量的title/input_preview隐藏并标dirty；保留独立事实、reply正文、可确认model_title和时间兜底。历史详情另返回 `{derived_state:'dirty'|'current'|'retained'|'legacy', historical:...}` 白名单，不把旧关系放在当前字段。未归属请求可展示独立用途和输入，组关系unknown。工具查询同一snapshot按状态屏蔽，不另开异步读取。

C 查询新增安全投影函数，list/detail在各自一次read.transaction内调用。前驱、delta、链角色与tool候选使用同一 `current` 判定；只读事务结束后禁止再异步拼关系。

```ts
export type DerivedState='dirty'|'current'|'retained'|'legacy';
export function derivedStateOf(row:{purpose_pending:number;summary_state:string;
  summary_algorithm:number|null;group_state:string|null;group_input:number|null;
  group_published:number|null;target_algorithm:number|null;published_algorithm:number|null}):DerivedState {
  if(row.purpose_pending!==0||row.group_state!=='clean'||row.group_input!==row.group_published||
    row.target_algorithm!==row.published_algorithm)return 'dirty';
  if(row.summary_state==='retained')return 'retained';
  if(row.summary_algorithm===null)return 'legacy';
  return 'current';
}
// REQUEST_COLUMNS中的组别名由同一SELECT的LEFT JOIN产生，所有列加r./g.前缀以免歧义。
// REQUEST_COLUMNS同时显式加入 r.summary_state、r.summary_algorithm、r.summary_basis。
// detail 的响应白名单保留 request.summary_state；list 不携带它。
const GROUP_READ_JOIN=`LEFT JOIN derive_queue g ON g.conv_key=r.conv_key AND g.actor=r.actor`;
const GROUP_READ_COLUMNS=`g.state AS group_state,g.input_revision AS group_input,
  g.published_revision AS group_published,g.target_algorithm,g.published_algorithm`;
// list/detail的原rows查询在store.read.transaction(()=>{ ... }).deferred()内完成。
// 投影每行：
const state=derivedStateOf(row);
const current=state==='current';
const safe={...row,derived_state:state,
  prev_req_id:current?row.prev_req_id:null,prev_relation:current?row.prev_relation:null,
  delta_ordinals:current?row.delta_ordinals:null,chain_role:current?row.chain_role:'unknown',
  input_preview:current?row.input_preview:null,input_preview_kind:current?row.input_preview_kind:null,
  title:current?row.title:(row.purpose_pending===0&&row.req_kind==='title'?row.model_title:null),
};
```

REQUEST_COLUMNS 同时显式加入 `summary_state`、`summary_algorithm`、`summary_basis`，[E 计划](2026-10-22-atc-input-capability-reading.md) 从 detail 的同一快照读取 `summary_state`，缺列会让 E 收到 undefined 并按 `unavailable` 静默降级；list 不携带这三列。实际响应不spread原SQL内部行。上述safe构造描述白名单字段替换，回归以接口现有白名单为基准，移除source_facts_json、projection_meta_json、组内部列和account/host；只有detail在显式historical键下附原title/preview/relation/delta并标状态，list不携带它们。`derivedStateOf` 的retained/legacy也不被当confirmed；actor未知当前关系视图为dirty，中性用途仍可展示。会话标题的当前性筛选由 [D 计划](2026-10-22-atc-request-purpose.md) 统一替换，C 只提供 `derived_state` 与列；本任务不保留第二份标题 SQL。

- [ ] **Step 4：运行目标回归及类型。** `bun test tests/derive.test.ts tests/queries.test.ts tests/maintenance.test.ts`，Expected PASS。D会替换兼容请求阶段，不能留下两个竞争用途写入者；C组循环移除旧的重新识别并覆盖req_kind分支，消费已存purpose_chain、model_title。query未知ID保持原字符串，不折回chat/main。
- [ ] **Step 5：更新读模型与note。** 有授权时提交 `feat(derive): complete request work before publishing group results`。

## Task 5：显式盐绑定与可恢复备份

**Files:** Modify `src/config.ts`、`src/main.ts`、`src/maintenance.ts`；Test `tests/maintenance.test.ts`、新增 `tests/secrets.test.ts`。

**Interfaces:** `loadBoundSalt(store:Store,dataDir:string,options?:{confirmLegacy?:boolean}):Uint8Array`；`backupBundle(sourceDir:string,destinationDir:string):void`；`restoreBundle(bundleDir:string,destinationDir:string,options?:{allowIncompleteMigration?:boolean}):void`。bundle 的可接受版本集合是唯一权威常量 `RESTORABLE_SCHEMA_VERSIONS: readonly number[] = [5]`（导出）；备份写实际 `PRAGMA user_version`，恢复先查该集合，再与包内数据库自身的 user_version 相等校验。F 的条件 v6 分支只扩展这一个数组，不另写第二份版本规则。绑定存collector_state['privacy:salt'] `{format:1,id:sha256('atc-redaction-salt-v1\0'+salt),confirmedLegacy:boolean}`。不写盐明文到DB/报告。read.token/hook.token独立，不放bundle默认恢复；恢复后显式重新生成认证token。

- [ ] **Step 1：盐测试。** 新增下列可执行用例，复用 `fixture` 和显式合成盐；另外在同一组测试检查旧库有盐无binding默认抛redaction_salt_unbound，只有显式confirmLegacy才绑定并报告无法证明历史身份。不能把显式确认当密码学证明。

```ts
import {expect,test} from 'bun:test';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './fixtures';
import {loadBoundSalt} from '../src/config';
test('已有请求缺盐拒绝且不新建文件',()=>{
  const f=fixture();
  try {
    f.store.write(db=>db.run(`INSERT INTO request(req_id,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at)
      VALUES(1,1,'2026-10-22','hook','pending',0,1,1,1)`));
    expect(()=>loadBoundSalt(f.store,f.dir)).toThrow('redaction_salt_missing');
    expect(existsSync(join(f.dir,'redaction.salt'))).toBe(false);
  }finally{f.close();}
});
test('首次空库生成绑定后拒绝错盐',()=>{
  const f=fixture();
  try {
    const first=loadBoundSalt(f.store,f.dir);
    expect(first.length).toBe(32);
    expect(loadBoundSalt(f.store,f.dir)).toEqual(first);
    writeFileSync(join(f.dir,'redaction.salt'),new Uint8Array(32).fill(7),{mode:0o600});
    expect(()=>loadBoundSalt(f.store,f.dir)).toThrow('redaction_salt_mismatch');
  }finally{f.close();}
});
```
- [ ] **Step 2：运行观察FAIL。** `bun test tests/secrets.test.ts`，Expected缺少loadBoundSalt或旧行为静默生盐。
- [ ] **Step 3：实现绑定。** 导出现有readLocalSecret为只读受限读取；loadLocalSecret增加禁止创建选项供盐使用，认证token原行为保留。

```ts
import { createHash } from 'node:crypto';
function saltId(salt:Uint8Array):string {
  return createHash('sha256').update('atc-redaction-salt-v1\0').update(salt).digest('hex');
}
export function loadBoundSaltTx(db:Database,dataDir:string,
  options:{confirmLegacy?:boolean}={}):Uint8Array {
  const bound=db.query<{value_json:string},[]>(
    "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
  const hasData=(db.query('SELECT EXISTS(SELECT 1 FROM request) n').get() as {n:number}).n!==0;
  const path=join(dataDir,'redaction.salt');
  if(!existsSync(path)&&(hasData||bound!==null))throw new Error('redaction_salt_missing');
  if(bound===null&&hasData&&!options.confirmLegacy)throw new Error('redaction_salt_unbound');
  const salt=loadLocalSecret(dataDir,'redaction.salt');
  if(bound!==null) {
    let saved:unknown;
    try{saved=JSON.parse(bound.value_json);}catch{throw new Error('redaction_salt_binding_invalid');}
    if(saved===null||typeof saved!=='object'||Array.isArray(saved)||
       (saved as {format?:unknown}).format!==1||typeof (saved as {id?:unknown}).id!=='string')
      throw new Error('redaction_salt_binding_invalid');
    if((saved as {id:string}).id!==saltId(salt))throw new Error('redaction_salt_mismatch');
  } else {
    db.run("INSERT INTO collector_state(key,value_json) VALUES('privacy:salt',?)",
      [JSON.stringify({format:1,id:saltId(salt),confirmedLegacy:hasData})]);
  }
  return salt;
}
export function loadBoundSalt(store:Store,dataDir:string,
  options:{confirmLegacy?:boolean}={}):Uint8Array {
  return store.write(db=>loadBoundSaltTx(db,dataDir,options));
}
```

绑定写入与迁移阶段标记同事务。main openStore后在try中loadBoundSalt，失败关闭Store，不先启动定时任务。首次新库可绑定；已有库缺盐不能调用通用生成分支。仅数据库快照通过只读工具读取，不调用采集启动。

- [ ] **Step 4：完成bundle。** destination必须不存在，以同父目录mkdtemp创建0700 staging，持有maintenance锁；沿用backupDatabase的EXCLUSIVE探测与VACUUM复制。先在该排他连接仍打开时完成源盐读取和binding校验，绝不在释放数据库停止约束后读取可能已被替换的盐。source的binding与snapshot binding相等后，写trace.db、redaction.salt与manifest.json(0600)，manifest为format1、schema5、salt_id、数据库SHA256，最后rename整个staging至目标。失败仅清理本次创建staging；恢复先完整校验manifest、hash、salt_id、integrity，再在新staging落文件rename，绝不覆盖已有目录。源停止约束不降级。把backupDatabase原排他复制代码提为维护专用导出的 `withStoppedDatabase<T>(source:string, fn:(db:Database)=>T):T`，backupDatabase和bundle共同复用，资源在finally关闭，不能增加先探测再重新打开的窗口。测试错盐、缺盐、损坏DB、目标存在、半写失败均不留下可用目标；成功恢复继续合成摄入得到同一占位符。核心复制与校验代码如下，权限和源停止检查由withStoppedDatabase与readLocalSecret承担：

```ts
export function withStoppedDatabase<T>(source:string,fn:(db:Database)=>T):T {
  const info=lstatSync(source);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('source_unreadable');
  const db=new Database(source,{create:false});
  try {
    db.query('PRAGMA locking_mode=EXCLUSIVE').get();
    try {
      const journal=db.query('PRAGMA journal_mode').get() as {journal_mode:string};
      if(journal.journal_mode!=='wal')throw new Error('source_not_wal');
      db.query('SELECT COUNT(*) FROM sqlite_schema').get();
    }catch(error){if(isBusy(error))throw new Error('source_must_be_stopped');throw error;}
    return fn(db);
  }finally{db.close();}
}
function requirePrivateDirectory(path:string):void {
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||
    (typeof process.getuid==='function'&&info.uid!==process.getuid()))
    throw new Error('directory_permissions');
}
function publishPrivateDirectory(staging:string,destination:string):void {
  requirePrivateDirectory(dirname(destination));
  try{mkdirSync(destination,{mode:0o700});}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')
    throw new Error('destination_exists');throw error;}
  const reserved=lstatSync(destination);
  try {
    const current=lstatSync(destination);
    if(current.ino!==reserved.ino||current.dev!==reserved.dev)
      throw new Error('destination_changed');
    renameSync(staging,destination);
  }catch(error){
    const current=lstatSync(destination);
    if(current.ino===reserved.ino&&current.dev===reserved.dev) {
      try{rmdirSync(destination);}catch{ /* 只移除自己创建且仍为空的保留目录。 */ }
    }
    throw error;
  }
}
function hashDatabase(path:string):string {
  const hash=createHash('sha256');const buffer=Buffer.alloc(64*1024);
  const fd=openSync(path,'r');
  try { for(;;){const n=readSync(fd,buffer,0,buffer.length,null);
    if(n===0)break;hash.update(buffer.subarray(0,n));} }
  finally {closeSync(fd);}
  return hash.digest('hex');
}
// bundle 的唯一版本白名单：备份与恢复都查这一处，F 的 v6 分支只把 6 加进来。
export const RESTORABLE_SCHEMA_VERSIONS: readonly number[]=[5];
export function backupBundle(sourceDir:string,destinationDir:string):void {
  if(existsSync(destinationDir)) throw new Error('destination_exists');
  const lock=acquireMaintenanceLock(sourceDir,`bundle:${process.pid}`);
  if(lock===null) throw new Error('maintenance_lock_held');
  let staging:string|null=null;
  try {
    requirePrivateDirectory(sourceDir);
    requirePrivateDirectory(dirname(destinationDir));
    const sourceBytes=statSync(join(sourceDir,'trace.db')).size;
    if(defaultFreeBytes(dirname(destinationDir))<Math.ceil(sourceBytes*BACKUP_SPACE_FACTOR)+4096)
      throw new Error('insufficient_space');
    staging=mkdtempSync(join(dirname(destinationDir),'.atc-bundle-'));
    chmodSync(staging,0o700);
    const target=staging;
    withStoppedDatabase(join(sourceDir,'trace.db'),db=>{
      const salt=readLocalSecret(join(sourceDir,'redaction.salt'));
      const raw=db.query<{value_json:string},[]>(
        "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
      if(raw===null||JSON.parse(raw.value_json).id!==saltId(salt))
        throw new Error('redaction_salt_mismatch');
      const schema=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(!RESTORABLE_SCHEMA_VERSIONS.includes(schema))throw new Error('backup_schema_unsupported');
      const path=join(target,'trace.db');
      db.query('VACUUM INTO ?').run(path);
      chmodSync(path,0o600);
      writeFileSync(join(target,'redaction.salt'),salt,{flag:'wx',mode:0o600});
      const hash=hashDatabase(path);
      writeFileSync(join(target,'manifest.json'),JSON.stringify({format:1,
        schema,salt_id:saltId(salt),database_sha256:hash}),{flag:'wx',mode:0o600});
    });
    if(verifyDatabase(join(target,'trace.db')).integrity.join(',')!=='ok')
      throw new Error('backup_integrity_failed');
    publishPrivateDirectory(target,destinationDir);
    staging=null;
  } catch(error) { if(staging!==null)rmSync(staging,{recursive:true,force:true});throw error; }
  finally { lock.release(); }
}
```

数据库hash按64KiB流式读取，盐固定32字节。空闲空间沿用backupDatabase因子检验，staging计入总磁盘。发布先用mkdir原子保留目标，存在即拒绝，然后在受限父目录内以rename替换本进程创建的空保留目录；失败只rmdir该空目录，不递归删除目标。该流程防止独立恢复命令覆盖先出现的目录；受限父目录是前提，不声称能防御拥有同一用户权限且主动置换路径的进程。恢复只复制清单内固定三个文件，拒绝符号链接及额外文件。

```ts
export function restoreBundle(bundleDir:string,destinationDir:string,
  options?:{allowIncompleteMigration?:boolean}):void {
  if(existsSync(destinationDir))throw new Error('destination_exists');
  requirePrivateDirectory(bundleDir);
  requirePrivateDirectory(dirname(destinationDir));
  const names=['trace.db','redaction.salt','manifest.json'];
  if(JSON.stringify(readdirSync(bundleDir).sort())!==JSON.stringify([...names].sort()))
    throw new Error('restore_bundle_invalid');
  for(const name of names) {
    const stat=lstatSync(join(bundleDir,name));
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)
      throw new Error('restore_bundle_permissions');
  }
  const manifestText=readFileSync(join(bundleDir,'manifest.json'),'utf8');
  let manifest:{format:number;schema:number;salt_id:string;database_sha256:string};
  try{manifest=JSON.parse(manifestText);}catch{throw new Error('restore_bundle_invalid');}
  if(manifest===null||typeof manifest!=='object'||Array.isArray(manifest))
    throw new Error('restore_bundle_invalid');
  const salt=readLocalSecret(join(bundleDir,'redaction.salt'));
  if(manifest.format!==1||!RESTORABLE_SCHEMA_VERSIONS.includes(manifest.schema)||
    manifest.salt_id!==saltId(salt)||
    manifest.database_sha256!==hashDatabase(join(bundleDir,'trace.db')))
    throw new Error('restore_bundle_invalid');
  const bytes=statSync(join(bundleDir,'trace.db')).size;
  if(defaultFreeBytes(dirname(destinationDir))<Math.ceil(bytes*BACKUP_SPACE_FACTOR)+4096)
    throw new Error('insufficient_space');
  const staging=mkdtempSync(join(dirname(destinationDir),'.atc-restore-'));
  chmodSync(staging,0o700);
  try {
    for(const name of ['trace.db','redaction.salt','manifest.json']) {
      copyFileSync(join(bundleDir,name),join(staging,name),constants.COPYFILE_EXCL);
      chmodSync(join(staging,name),0o600);
    }
    if(hashDatabase(join(staging,'trace.db'))!==manifest.database_sha256||
       verifyDatabase(join(staging,'trace.db')).integrity.join(',')!=='ok')
      throw new Error('restore_bundle_invalid');
    const snapshot=new Database(join(staging,'trace.db'),{readonly:true});
    try {
      const row=snapshot.query<{value_json:string},[]>(
        "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
      if(row===null||JSON.parse(row.value_json).id!==saltId(salt))
        throw new Error('redaction_salt_mismatch');
      const bundled=(snapshot.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      // manifest 不能只靠自述：包内数据库自身的版本必须与清单一致。
      if(bundled!==manifest.schema)throw new Error('restore_bundle_invalid');
      const marker=snapshot.query<{value_json:string},[]>(
        'SELECT value_json FROM collector_state WHERE key=?').get(`migration:v${bundled}`);
      let saved:unknown;
      try { saved=marker===null?null:JSON.parse(marker.value_json); }
      catch { throw new Error('restore_bundle_invalid'); }
      if(saved===null||typeof saved!=='object'||Array.isArray(saved)
        ||typeof (saved as {complete?:unknown}).complete!=='boolean')
        throw new Error('restore_bundle_invalid');
      if((saved as {complete:boolean}).complete!==true&&options?.allowIncompleteMigration!==true)
        throw new Error('restore_migration_incomplete');
    } finally {snapshot.close();}
    publishPrivateDirectory(staging,destinationDir);
  }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
}
```

恢复不复制认证token，启动时按显式认证重配流程生成。恢复在发布 staging 之前校验包内数据库自身的版本与 manifest.schema 相等，并读取 `migration:v{version}` marker：marker 缺失或非法即 restore_bundle_invalid，complete!==true 且未传 allowIncompleteMigration 抛 restore_migration_incomplete。marker 格式的唯一权威在这里，F 的 v6 分支只扩展 RESTORABLE_SCHEMA_VERSIONS，不复制第二份 marker 解析。manifest缺失、不支持版本和JSON错误映射为restore_bundle_invalid，诊断不输出secret内容。所有新增fs符号从node:fs导入（chmodSync、closeSync、constants、copyFileSync、existsSync、lstatSync、mkdirSync、mkdtempSync、openSync、readFileSync、readdirSync、readSync、renameSync、rmSync、rmdirSync、statSync、writeFileSync），dirname/join/isAbsolute/resolve从node:path导入，pathToFileURL从node:url导入。下面回归在同文件导入loadBoundSalt、backupBundle、restoreBundle以及readFileSync、existsSync。

```ts
// tests/maintenance.test.ts 补入同一合成恢复用例，复用已有fs/path导入：
test('恢复bundle保存原盐且拒绝覆盖目标',()=>{
  const f=fixture();const bundle=join(f.dir,'bundle');const restored=join(f.dir,'restored');
  try {
    const salt=loadBoundSalt(f.store,f.dir);
    f.store.close();
    backupBundle(f.dir,bundle);
    restoreBundle(bundle,restored);
    expect(readFileSync(join(restored,'redaction.salt'))).toEqual(Buffer.from(salt));
    expect(()=>restoreBundle(bundle,restored)).toThrow('destination_exists');
    const store=openStore(join(restored,'trace.db'));
    try{expect(loadBoundSalt(store,restored)).toEqual(salt);}finally{store.close();}
  }finally{f.close();}
});
test('恢复拒绝未完成迁移的bundle',()=>{
  const f=fixture();const bundle=join(f.dir,'bundle');const restored=join(f.dir,'restored');
  try {
    const salt=loadBoundSalt(f.store,f.dir);
    f.store.write(db=>db.run("UPDATE collector_state SET value_json=? WHERE key='migration:v5'",
      [JSON.stringify({format:1,target:5,phase:'groups',cursor:null,scope:'all',
        complete:false,report:{scanned:0,remapped:0,projected:0}})]));
    f.store.close();
    backupBundle(f.dir,bundle);
    expect(()=>restoreBundle(bundle,restored)).toThrow('restore_migration_incomplete');
    expect(existsSync(restored)).toBe(false);
    restoreBundle(bundle,restored,{allowIncompleteMigration:true});
    expect(readFileSync(join(restored,'redaction.salt'))).toEqual(Buffer.from(salt));
    expect(()=>openStore(join(restored,'trace.db'))).toThrow('migration_incomplete');
  }finally{f.close();}
});
```

Run `bun test tests/secrets.test.ts tests/maintenance.test.ts`；Expected PASS。保留数据库-only backup，输出明确not_ingestion_restorable，不宣称替代bundle。
- [ ] **Step 5：更新operations与note。** backup/restore/认证重配命令和限制只在operations维护，有授权时提交 `feat(recovery): bind privacy salt and verify restore bundles`。

## Task 6：实现可续跑的全库迁移和守恒验收

**Files:** Complete `src/migrate-v5.ts`；Create `scripts/migrate-v5.ts`；Modify `tests/migration-v5.test.ts`、`docs/operations.md`、新note。

**Interfaces:** `migrateV5(options:{dbPath:string;dataDir:string;mode:'preview'|'apply';confirmLegacySalt?:boolean;batchSize?:number;stopAfterBatches?:number}):MigrationReport`；`stopAfterBatches`只供合成测试受控中断，不生产CLI公开。`MigrationReport`包含phase/complete、scanned/remapped/projected、retained/missing按family、purpose_pending、pending_groups、conservation。preview只读、无锁文件/secret生成/DDL；apply显式全库、维护锁与EXCLUSIVE源停止检查，禁止缺省dbPath/dataDir。

- [ ] **Step 1：完整合成回归。** 在legacyFixture创建v4对象后，使用以下最小种子固定正文及守恒表；可恢复性排列用同一最小种子分别增加raw/summary，原盐固定合成。第一次apply stopAfterBatches=1应返回complete=false且普通openStore拒绝；再次apply恢复到complete；第三次apply无重复副作用。分别覆盖全raw、部分raw、仅summary、全部缺失和损坏payload。

```ts
import {zstdCompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
function seedLegacy(db:Database,dir:string):void {
  db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
    body_state,derive_version,have,created_at,updated_at,title,title_source)
    VALUES(1,'c','a','known',1000,'2026-10-22','hook','available',9,1,1,1,'old','user_delta'),
          (2,'c','a','known',2000,'2026-10-22','hook','evicted',9,1,1,1,'retained','user_delta')`);
  const message=Buffer.from(JSON.stringify({role:'user',content:'synthetic input'}));
  db.run(`INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES(1,?,'synthetic-fp',?,?)`,
    [createHash('sha256').update(message).digest(),zstdCompressSync(message),message.length]);
  db.run('INSERT INTO request_block(req_id,ord,role,block) VALUES(1,0,0,1)');
  db.run(`UPDATE request SET msg_count=1,skeleton_z=? WHERE req_id=1`,
    [zstdCompressSync(Buffer.from(JSON.stringify({format:1,protocol:'anthropic',
      request_without_messages:{},reply:{content:[]},redact_version:1,has_messages:true})))]);
  db.run(`INSERT INTO request_alias(old_id,new_id) VALUES(99,1)`);
  db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at,
    payload_state) VALUES(1,'hook','synthetic-expired','merged',1,'expired')`);
  db.run(`INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json)
    VALUES('synthetic-cost',1,'synthetic-hash','{}')`);
  db.run(`INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms)
    VALUES('ledger','synthetic','1:2:3:0',10,1)`);
  db.run(`INSERT INTO purged_evidence(source_kind,ref_key,purged_at)
    VALUES('hook','synthetic-purged',1)`);
  writeFileSync(join(dir,'redaction.salt'),new Uint8Array(32).fill(3),{mode:0o600});
}
```

下面迁移恢复测试复用上述种子和legacyFixture。

```ts
const keep=['request_alias','request_evidence','request_block','cost_observation',
  'source_cursor','purged_evidence'] as const;
function conserved(db:Database){
  return Object.fromEntries(keep.map(table=>[table,db.query(`SELECT * FROM ${table}`).all()
    .map(row=>JSON.stringify(row)).sort()]));
}
test('v5迁移中断后恢复且守恒',()=>{
  const f=legacyFixture();
  try {
    seedLegacy(f.db,f.dir);
    const before=conserved(f.db);
    f.closeDb();
    const partial=migrateV5({dbPath:f.path,dataDir:f.dir,mode:'apply',
      confirmLegacySalt:true,batchSize:1,stopAfterBatches:1});
    expect(partial.complete).toBe(false);
    expect(()=>openStore(f.path)).toThrow('migration_incomplete');
    const done=migrateV5({dbPath:f.path,dataDir:f.dir,mode:'apply',confirmLegacySalt:true,batchSize:1});
    expect(done.complete).toBe(true);
    const verified=openStore(f.path);
    try { expect(conserved(verified.read)).toEqual(before); }
    finally { verified.close(); }
    expect(migrateV5({dbPath:f.path,dataDir:f.dir,mode:'apply',confirmLegacySalt:true}).complete)
      .toBe(true);
  }finally{f.close();}
});
```

证据payload_state在迁移中不修改，owner守恒比较可直接逐行；新metadata列单独断言。下面固定每阶段恢复与preview检查；preview先checkpoint关闭fixture连接，再比较文件列表与数据库hash，避免把其它连接的WAL变化归给preview。

```ts
for(const phase of ['remap','project','purpose','groups','verify'] as const) {
  test(`v5在${phase}阶段关闭重开仍收敛`,()=>{
    const f=legacyFixture();
    try {
      seedLegacy(f.db,f.dir);const before=conserved(f.db);f.closeDb();
      let report:MigrationReport;
      do {report=migrateV5({dbPath:f.path,dataDir:f.dir,mode:'apply',confirmLegacySalt:true,
        batchSize:1,stopAfterBatches:1});}while(!report.complete&&report.phase!==phase);
      expect(report.complete).toBe(false);
      const final=migrateV5({dbPath:f.path,dataDir:f.dir,mode:'apply',confirmLegacySalt:true,batchSize:1});
      expect(final.complete).toBe(true);
      const store=openStore(f.path);
      try{expect(conserved(store.read)).toEqual(before);}finally{store.close();}
    }finally{f.close();}
  });
}
test('v5 preview不改文件与内容',()=>{
  const f=legacyFixture();
  try {
    seedLegacy(f.db,f.dir);f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');f.closeDb();
    const beforeFiles=readdirSync(f.dir).sort();const beforeHash=hashDatabase(f.path);
    const report=migrateV5({dbPath:f.path,dataDir:f.dir,mode:'preview'});
    expect(report.complete).toBe(false);
    expect(hashDatabase(f.path)).toBe(beforeHash);
    expect(readdirSync(f.dir).sort()).toEqual(beforeFiles);
  }finally{f.close();}
});
```

测试hashDatabase在tests文件内按Task5的流式64KiB函数定义，不导出生产内部hash供测试。preview要求采集器已停止且源db不存在非空-wal，否则拒绝 `preview_checkpoint_required`；以 `pathToFileURL(dbPath).href+'?immutable=1'` 构造不可变只读URI，不创建shm。计划编写时已用Bun在合成带空格路径验证该URI可以读取，执行时保留同一回归。不可变读取不追踪在线写入，因此停止源是preview的前置条件，不能用于在线一致性诊断。

损坏raw停止当前batch且cursor不前进，修正合成payload后可续跑，不能跳过并complete。

- [ ] **Step 2：运行。** `bun test tests/migration-v5.test.ts`；Expected FAIL，尚无批次与阶段处理。
- [ ] **Step 3：实现固定阶段状态机。** 每批数据更新和cursor同一db.transaction.immediate，between-batch不保持事务。keyset：ledger以(source_kind,file_generation,byte_offset)，route以route_id，project/purpose以req_id；cursor序列化类型和范围检查拒绝未知。完整DDL+phase初始化后依次：

```ts
export type Phase='remap'|'project'|'purpose'|'groups'|'verify'|'complete';
export type MigrationReport={
  phase:Phase;complete:boolean;scanned:number;remapped:number;projected:number;
  purpose_pending:number;pending_groups:number;conservation:string;
  retained:Record<'models'|'attempts'|'prompt',number>;
  missing:Record<'models'|'attempts'|'prompt',number>;
};
type MigrationState={format:1;target:5;phase:Phase;cursor:string|null;scope:'all';
  complete:boolean;baseline:string;report:{scanned:number;remapped:number;projected:number}};
type Batch={finished:boolean;cursor:string|null;scanned:number;remapped:number;projected:number};
const next:Record<Exclude<Phase,'complete'>,Phase>={
  remap:'project',project:'purpose',purpose:'groups',groups:'verify',verify:'complete',
};
function cursorValue(cursor:string|null):unknown {
  if(cursor===null)return null;
  try{return JSON.parse(cursor);}catch{throw new Error('migration_cursor_invalid');}
}
function integerCursor(cursor:string|null):number {
  const value=cursorValue(cursor);
  if(value===null)return -1;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)
    throw new Error('migration_cursor_invalid');
  return value;
}
function pending(db:Database):{purpose_pending:number;pending_groups:number} {
  return {
    purpose_pending:(db.query('SELECT COUNT(*) n FROM request WHERE purpose_pending=1').get() as {n:number}).n,
    pending_groups:(db.query("SELECT COUNT(*) n FROM derive_queue WHERE state<>'clean'").get() as {n:number}).n,
  };
}
function runBatch(db:Database,state:MigrationState,batchSize:number,salt:Uint8Array):Batch {
  const result:Batch={finished:false,cursor:null,scanned:0,remapped:0,projected:0};
  if(state.phase==='remap') {
    const value=cursorValue(state.cursor);
    const c=value===null?{table:'ledger',key:['','',-1]}:value;
    if(c===null||typeof c!=='object'||Array.isArray(c))throw new Error('migration_cursor_invalid');
    const {table,key}=c as {table:unknown;key:unknown};
    if(table==='ledger') {
      if(!Array.isArray(key)||key.length!==3||typeof key[0]!=='string'||typeof key[1]!=='string'||
        typeof key[2]!=='number'||!Number.isSafeInteger(key[2])||key[2]<-1)
        throw new Error('migration_cursor_invalid');
      const rows=db.query<{source_kind:string;file_generation:string;byte_offset:number;
        payload_json:string},[string,string,number,number]>(`SELECT source_kind,file_generation,
        byte_offset,payload_json FROM raw_ledger WHERE (source_kind,file_generation,byte_offset)>(?,?,?)
        ORDER BY source_kind,file_generation,byte_offset LIMIT ?`).all(key[0],key[1],key[2],batchSize);
      for(const row of rows)remapLedgerTx(db,row,salt);
      const last=rows.at(-1);
      result.cursor=JSON.stringify(last===undefined?{table:'route',key:-1}:
        {table:'ledger',key:[last.source_kind,last.file_generation,last.byte_offset]});
      result.scanned=result.remapped=rows.length;
      return result;
    }
    if(table!=='route'||typeof key!=='number'||!Number.isSafeInteger(key)||key<-1)
      throw new Error('migration_cursor_invalid');
    const rows=db.query<{route_id:number;payload_json:string},[number,number]>(
      'SELECT route_id,payload_json FROM raw_route WHERE route_id>? ORDER BY route_id LIMIT ?')
      .all(key,batchSize);
    for(const row of rows)remapRouteTx(db,row,salt);
    result.finished=rows.length<batchSize;
    result.cursor=JSON.stringify({table:'route',key:rows.at(-1)?.route_id??key});
    result.scanned=result.remapped=rows.length;
    return result;
  }
  if(state.phase==='project') {
    const lastId=integerCursor(state.cursor);
    const rows=db.query<{req_id:number},[number,number]>(
      'SELECT req_id FROM request WHERE req_id>? ORDER BY req_id LIMIT ?').all(lastId,batchSize);
    for(const row of rows) {
      projectRequestTx(db,row.req_id,{now:Date.now(),mappingVersion:SOURCE_PROJECTION_VERSION});
      markRequestInputTx(db,row.req_id);
    }
    result.finished=rows.length<batchSize;
    result.cursor=JSON.stringify(rows.at(-1)?.req_id??Math.max(lastId,0));
    result.scanned=result.projected=rows.length;
    return result;
  }
  if(state.phase==='purpose') {
    // 同一完整入口允许已有组提前完成；groups阶段仍枚举全部known组再完整重建。
    drainDeriveTx(db,{limit:1,purposeLimit:batchSize});
    result.finished=pending(db).purpose_pending===0;
    return result;
  }
  if(state.phase==='groups') {
    const value=cursorValue(state.cursor);
    if(value==='drain') {
      const before=pending(db);
      const drained=drainDeriveTx(db,{limit:batchSize,purposeLimit:batchSize});
      const after=pending(db);
      if(after.pending_groups>0&&drained.groups.length===0&&
        after.purpose_pending>=before.purpose_pending)throw new Error('migration_no_progress');
      result.finished=after.pending_groups===0&&after.purpose_pending===0;
      result.cursor=JSON.stringify('drain');
      return result;
    }
    if(value!==null&&(!Array.isArray(value)||value.length!==2||
      typeof value[0]!=='string'||typeof value[1]!=='string'))
      throw new Error('migration_cursor_invalid');
    const rows=value===null
      ?db.query<{conv_key:string;actor:string},[number]>(`SELECT DISTINCT conv_key,actor FROM request
        WHERE actor_state='known' AND conv_key IS NOT NULL AND actor IS NOT NULL
        ORDER BY conv_key,actor LIMIT ?`).all(batchSize)
      :db.query<{conv_key:string;actor:string},[string,string,number]>(`SELECT DISTINCT conv_key,actor
        FROM request WHERE actor_state='known' AND conv_key IS NOT NULL AND actor IS NOT NULL
        AND (conv_key,actor)>(?,?) ORDER BY conv_key,actor LIMIT ?`)
        .all((value as string[])[0]!, (value as string[])[1]!,batchSize);
    for(const row of rows)markGroupDirtyTx(db,row.conv_key,row.actor,'');
    const last=rows.at(-1);
    result.cursor=JSON.stringify(last===undefined?'drain':[last.conv_key,last.actor]);
    return result;
  }
  if(state.phase==='verify') {
    if(conservationDigest(db)!==state.baseline)throw new Error('migration_conservation_failed');
    const p=pending(db);
    if(p.pending_groups!==0||p.purpose_pending!==0)throw new Error('migration_work_remaining');
    if(db.query('PRAGMA foreign_key_check').all().length!==0)throw new Error('migration_foreign_key');
    const integrity=db.query('PRAGMA integrity_check').all() as {integrity_check:string}[];
    if(integrity.length!==1||integrity[0]?.integrity_check!=='ok')throw new Error('migration_integrity');
    const bad=(db.query(`SELECT COUNT(*) n FROM request WHERE input_epoch=''`).get() as {n:number}).n;
    if(bad!==0)throw new Error('migration_epoch_missing');
    result.finished=true;
    return result;
  }
  throw new Error('migration_phase_invalid');
}
```

以下是apply的唯一批循环；每个阶段的数据和检查点同事务，异常时只保留此前已提交的批次。state从collector_state读取后校验format/target/scope/phase/cursor与计数均合法，不能从CLI指定phase跳过工作。

```ts
function readMigrationState(db:Database):MigrationState {
  const row=db.query<{value_json:string},[]>(
    "SELECT value_json FROM collector_state WHERE key='migration:v5'").get();
  if(row===null)throw new Error('migration_marker_missing');
  let value:unknown;
  try{value=JSON.parse(row.value_json);}catch{throw new Error('migration_marker_invalid');}
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('migration_marker_invalid');
  const s=value as MigrationState;
  if(s.format!==1||s.target!==5||s.scope!=='all'||
    !['remap','project','purpose','groups','verify','complete'].includes(s.phase)||
    !(s.cursor===null||typeof s.cursor==='string')||
    s.complete!==(s.phase==='complete')||typeof s.baseline!=='string'||
    !/^[a-f0-9]{64}$/.test(s.baseline)||s.report===null||typeof s.report!=='object'||
    ![s.report.scanned,s.report.remapped,s.report.projected].every(n=>Number.isSafeInteger(n)&&n>=0))
    throw new Error('migration_marker_invalid');
  return s;
}
function applyBatches(db:Database,options:{dataDir:string;batchSize:number;
  confirmLegacySalt?:boolean;stopAfterBatches?:number}):MigrationState {
  initializeV5(db);
  const salt=db.transaction(()=>loadBoundSaltTx(db,options.dataDir,
    {confirmLegacy:options.confirmLegacySalt})).immediate();
  let state=readMigrationState(db),batches=0;
  while(!state.complete) {
    const committed=db.transaction(()=>{
      const batch=runBatch(db,state,options.batchSize,salt);
      const phase=batch.finished?next[state.phase as Exclude<Phase,'complete'>]:state.phase;
      const saved:MigrationState={...state,phase,complete:phase==='complete',
        cursor:batch.finished?null:batch.cursor,report:{
          scanned:state.report.scanned+batch.scanned,
          remapped:state.report.remapped+batch.remapped,
          projected:state.report.projected+batch.projected}};
      db.run("UPDATE collector_state SET value_json=? WHERE key='migration:v5'",[JSON.stringify(saved)]);
      return saved;
    }).immediate();
    state=committed;
    batches++;
    if(options.stopAfterBatches!==undefined&&batches>=options.stopAfterBatches)break;
  }
  return state;
}
```

runBatch按固定阶段调用本文件已定义的remap、B投影和完整drain，不建立通用插件。project为每行补epoch、revision、pending；verify核对初始守恒摘要与实际待处理数，最后一个事务才complete=true。各阶段计数存在state.report，事务失败不递增。范围未知、JSON损坏、binding不明均停止并报短原因，不输出原payload。

迁移外层固定使用下列入口。preview返回只读范围及现有状态，不调用初始化、盐生成或维护锁；apply持有维护锁及同一个排他连接直至批循环结束。`snapshotReport` 只查询白名单计数，不输出source JSON。

若新库的complete marker计数为0，后续正常摄入不会修改它；对已完成v5再次apply只返回实际当前报告，不把初始化baseline作为持续摄入后的全库不变量。baseline只在complete=false的独占迁移期间比较。

```ts
function snapshotReport(db:Database,state:MigrationState|null):MigrationReport {
  const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
  const work=version===5?pending(db):{
    purpose_pending:(db.query('SELECT COUNT(*) n FROM request').get() as {n:number}).n,
    pending_groups:(db.query('SELECT COUNT(*) n FROM derive_queue').get() as {n:number}).n};
  const retained={models:0,attempts:0,prompt:0},missing={models:0,attempts:0,prompt:0};
  if(version===5)for(const row of db.query<{projection_meta_json:string|null},[]>(
    'SELECT projection_meta_json FROM request ORDER BY req_id').iterate()) {
    let parsed:unknown=null;
    try{parsed=row.projection_meta_json===null?null:JSON.parse(row.projection_meta_json);}
    catch{throw new Error('migration_projection_meta_invalid');}
    if(parsed!==null&&(typeof parsed!=='object'||Array.isArray(parsed)||
      (parsed as ProjectionMeta).format!==1||(parsed as ProjectionMeta).families==null))
      throw new Error('migration_projection_meta_invalid');
    const meta=parsed as ProjectionMeta|null;
    for(const key of ['models','attempts','prompt'] as const) {
      if(meta?.families[key]?.state==='retained')retained[key]++;
      if(meta?.families[key]===undefined||meta.families[key].state==='missing')missing[key]++;
    }
  }
  return {phase:state?.phase??'remap',complete:state?.complete??false,
    scanned:state?.report.scanned??0,remapped:state?.report.remapped??0,
    projected:state?.report.projected??0,...work,retained,missing,
    conservation:conservationDigest(db)};
}
export function migrateV5(options:{dbPath:string;dataDir:string;mode:'preview'|'apply';
  confirmLegacySalt?:boolean;batchSize?:number;stopAfterBatches?:number}):MigrationReport {
  if(!isAbsolute(options.dbPath)||!isAbsolute(options.dataDir)||
    resolve(options.dbPath)!==join(resolve(options.dataDir),'trace.db'))
    throw new Error('migration_explicit_paths_required');
  if(options.mode!=='preview'&&options.mode!=='apply')throw new Error('migration_mode_invalid');
  const batchSize=options.batchSize??100;
  if(!Number.isSafeInteger(batchSize)||batchSize<1||
    (options.stopAfterBatches!==undefined&&(!Number.isSafeInteger(options.stopAfterBatches)||
      options.stopAfterBatches<1)))throw new Error('migration_batch_invalid');
  if(options.mode==='preview') {
    if(existsSync(options.dbPath+'-wal')&&statSync(options.dbPath+'-wal').size>0)
      throw new Error('preview_checkpoint_required');
    const db=new Database(pathToFileURL(options.dbPath).href+'?immutable=1',{readonly:true,create:false});
    try {
      const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version!==4&&version!==5)throw new Error('migration_source_unsupported');
      return snapshotReport(db,version===5?readMigrationState(db):null);
    }finally{db.close();}
  }
  const lock=acquireMaintenanceLock(options.dataDir,`migrate-v5:${process.pid}`);
  if(lock===null)throw new Error('maintenance_lock_held');
  try {
    return withStoppedDatabase(options.dbPath,db=>{
      const state=applyBatches(db,{...options,batchSize});
      return snapshotReport(db,state);
    });
  }finally{lock.release();}
}
```

`src/migrate-v5.ts` 从 maintenance 导入 `withStoppedDatabase` 与 `acquireMaintenanceLock`，从 config 导入 `loadBoundSaltTx`；因此 withStoppedDatabase 是维护专用导出，不接受默认路径。maintenance 不反向导入迁移，避免循环依赖。CLI使用上面Interface，参数解析限定db/data-dir/batch/preview/apply/confirm-legacy-salt，不提供phase或complete覆盖参数。

MigrationReport.conservation以计数加有序行SHA256保存；正文引用和请求IDs逐项检验。费用列允许按已验证来源规则变化，但cost_observation表保持原样；attempt合计只在完整输入下纠错。cursor与墓碑不得增删。旧错误模型不可恢复报告missing，不能复用旧值。verify阶段组状态和请求pending均为空，再确认结构/user_version/foreign_key_check/integrity_check。

CLI精确参数：`bun scripts/migrate-v5.ts --db /private/tmp/atc-v5-synthetic/trace.db --data-dir /private/tmp/atc-v5-synthetic --preview`；apply改`--apply`，旧盐确认加`--confirm-legacy-salt`。拒绝同时preview/apply、缺路径、未知flag、batch非正安全整数；退出0完成或preview、1失败、3受控未完成仅测试Interface。不导入旧默认路径脚本。旧backfill增加版本上限守卫，v5及以后立即拒绝并指向当前迁移入口，防止它降写user_version=4。

重映射使用 B 的 `src/sources/raw.ts` 中两个 UPDATE-only Interface，迁移不复制在线 INSERT/owner 关联：

```ts
import { mapLedgerRow, mapRouteRow } from './sources/magpie';
import { writePreparedLedgerTx, writePreparedRouteTx } from './sources/raw';
import { projectRequestTx } from './sources/projection';
function remapLedgerTx(db:Database,row:{source_kind:string;file_generation:string;
  byte_offset:number;payload_json:string},salt:Uint8Array):void {
  if(row.source_kind!=='file') throw new Error('migration_source_unsupported');
  const input=repairStoredPrivacy(JSON.parse(row.payload_json),salt);
  if(input===null||typeof input!=='object'||Array.isArray(input))
    throw new Error('migration_ledger_invalid');
  const fields=mapLedgerRow(input as Record<string,unknown>);
  if(fields===null) throw new Error('migration_ledger_invalid');
  if(!writePreparedLedgerTx(db,{generation:row.file_generation,offset:row.byte_offset},
    fields,JSON.stringify(input))) throw new Error('migration_row_missing');
  // err 与两个版本列由 writePreparedLedgerTx 的同一条 UPDATE 写入，迁移不重复写一遍。
}
function remapRouteTx(db:Database,row:{route_id:number;payload_json:string},salt:Uint8Array):void {
  const input=repairStoredPrivacy(JSON.parse(row.payload_json),salt);
  if(input===null||typeof input!=='object'||Array.isArray(input))
    throw new Error('migration_route_invalid');
  const fields=mapRouteRow(input as Record<string,unknown>);
  if(fields===null||fields.routeId!==row.route_id) throw new Error('migration_route_invalid');
  if(!writePreparedRouteTx(db,row.route_id,fields,JSON.stringify(input)))
    throw new Error('migration_row_missing');
}
```

迁移与在线走同一 helper，所以 `err`、`mapping_version`、`privacy_version` 在重映射行与新摄入行上写同一组常量。verify 阶段据此加一条断言：`source_kind='file'` 的 `raw_ledger` 行与全部 `raw_route` 行不得存在 `mapping_version IS NULL`，出现即抛 `migration_rows_unmapped` 并且不置 `complete`；这条同时验证在线写入者已被扩展，不能只在迁移里补值。

`repairStoredPrivacy` 只修凭据键与账号别名，递归对象/数组时保留其余字符串，不运行全文匹配；敏感键判定和稳定占位符函数从 B 的 privacy 实现导出复用。仅当值不是已有占位符才调用该键的脱敏操作。body.block 与 skeleton 不在本迁移重脱敏范围，历史正文若另有隐私问题须另立范围报告，不能宣称本变换覆盖它们。

```ts
// privacy.ts 导出的窄操作复用原敏感键集合与 credentialValue/placeholder：
export function repairStoredPrivacy(value:unknown,salt:Uint8Array):unknown {
  if(Array.isArray(value)) return value.map(item=>repairStoredPrivacy(item,salt));
  if(value===null||typeof value!=='object') return value;
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[
    key,SENSITIVE_KEYS.has(key.toLowerCase())||key.toLowerCase()==='account'
      ? typeof child==='string'&&PLACEHOLDER.test(child)
        ? child : placeholder('credential',credentialValue(child),salt)
      : repairStoredPrivacy(child,salt),
  ]));
}
```

`remap` 的cursor为 `{table:'ledger'|'route',key:[string,string,number]|number|null}`，其余请求阶段为req_id整数，groups为`[conv_key,actor]`。下面是固定的批处理选择，不用OFFSET；每段都在外层批事务中调用并保存相同cursor：

```ts
// ledger首批，续批添加三元组大于cursor的WHERE；fields按物理主键稳定取。
const rows=db.query<{source_kind:string;file_generation:string;byte_offset:number;
 payload_json:string},[string,string,number,number]>(`SELECT source_kind,file_generation,
 byte_offset,payload_json FROM raw_ledger WHERE (source_kind,file_generation,byte_offset)>(?,?,?)
 ORDER BY source_kind,file_generation,byte_offset LIMIT ?`).all(kind,generation,offset,batchSize);
for(const row of rows) remapLedgerTx(db,row,salt);
// ledger耗尽时cursor切换route；route与project使用单整数keyset。
const routes=db.query<{route_id:number;payload_json:string},[number,number]>(
 'SELECT route_id,payload_json FROM raw_route WHERE route_id>? ORDER BY route_id LIMIT ?')
 .all(lastRouteId,batchSize);
for(const row of routes) remapRouteTx(db,row,salt);
const requests=db.query<{req_id:number},[number,number]>(
 'SELECT req_id FROM request WHERE req_id>? ORDER BY req_id LIMIT ?').all(lastReqId,batchSize);
for(const row of requests) projectRequestTx(db,row.req_id,{now,mappingVersion:SOURCE_PROJECTION_VERSION});
```

首个整数cursor用-1，ledger首cursor用`['','',-1]`；字段shape先检查再绑定。`remap`归零到route之后才进入project。request列表阶段Task2/3的epoch和事实保存挂在统一投影中，project后标purpose_pending；purpose/groups阶段调用完整drain，但由该阶段进度按实际pending数决定finished，不能仅因取组列表为空而跳过actor未知用途。投影的families.selected映射为ProjectionMeta.models，attempts/prompt映射同名；B kind状态merged映射C agree、absent映射missing，其余同名，C自身old值集合union不因B当前raw缺失撤销长期集合。

初始守恒摘要在DDL前只读得到并随migration标记原子保存，resume不得重建baseline。下面是 `src/conservation.ts` 的全部内容（Task 1 创建，store 与 migrate-v5 共同导入；该文件只依赖 `bun:sqlite` 与 `node:crypto`，不导入 store，避免循环）：

```ts
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
const invariantQueries=[
 'SELECT req_id FROM request ORDER BY req_id',
 'SELECT * FROM request_alias ORDER BY old_id',
 'SELECT * FROM request_evidence ORDER BY req_id,source_kind,ref_key',
 'SELECT * FROM request_block ORDER BY req_id,ord',
 'SELECT * FROM cost_observation ORDER BY ref_key,observed_at',
 'SELECT * FROM source_cursor ORDER BY source_kind,source_name',
 'SELECT * FROM purged_evidence ORDER BY source_kind,ref_key',
 'SELECT id,hex(hash) hash,hex(z) z,raw_size,fingerprint FROM block ORDER BY id',
 'SELECT req_id,hex(skeleton_z) skeleton_z,msg_count,body_state,body_bytes FROM request ORDER BY req_id',
] as const;
export function conservationDigest(db:Database):string {
  const hash=createHash('sha256');
  for(const sql of invariantQueries){
    hash.update(sql).update('\n');
    for(const row of db.query(sql).iterate()) hash.update(JSON.stringify(row)).update('\n');
  }
  return hash.digest('hex');
}
```

verify将此digest与初始化值比较，不一致抛migration_conservation_failed并保持complete=false。该摘要只包含schema不变化的守恒表，不将新metadata列或会变化的request派生列当不变量；正文block内容hash按id/hash/z单独流式摘要并计入baseline，确保迁移没有重新编码原文。


- [ ] **Step 4：运行验证。** `bun test tests/migration-v5.test.ts tests/store.test.ts tests/maintenance.test.ts tests/derive-state.test.ts` 与 `bun run typecheck`；Expected PASS。对每phase在第一个批次后中断并关闭重开，完整产物与不中断基准一致；数据库备份恢复后resume同样验收。只在实现改动需要时扩大测试，不运行真实库迁移。
- [ ] **Step 5：交付与报告。** operations记录命令/错误码/恢复、架构记录v5字段权威、新note记录为何显式迁移和局限；A计划已完成项不重写为旧行为，标注C迁移点与实际提交。有授权时提交 `feat(migration): rebuild v5 facts with resumable conservation checks`。Run `git diff --check`、`bun run verify:notes`，有暂存提交时执行staged门禁。

## 规格覆盖与交付边界

| 要求 | 任务与验收 |
| --- | --- |
| 来源长期kind、独立hook、最终尝试完整性 | Task3/6，排列一致、raw过期不缩总量、缺证据保持限制 |
| 保守顺序与来源边界 | Task3，消费 B 的 `orderState`/`families[*].current`，transfer非current不冒充；每列16KiB预算与超长身份置null |
| 请求待处理与组修订、合并/回收失效 | Task2/4，未知actor、直接命中、epoch不复用 |
| 算法目标与实际、历史保留 | Task3/4，混合版本计数、不用MAX |
| 显式结构迁移、未完成拒绝与可续跑 | Task1/6，DDL回滚、每phase中断、重复收敛、preview无文件变更 |
| 隐私盐绑定与恢复 | Task5，缺盐错盐拒绝、旧库确认、bundle恢复连续性 |
| 只读状态与旧结果屏蔽 | Task4，同快照dirty中性与历史详情 |
| 代际、跨事务切片与资源预算 | [F条件分支](2026-10-22-atc-capacity-convergence.md)，v6仅条件满足才执行 |
| 跨批次共享 Seam 不重复实现 | 见[实施总入口的共享 Seam 归属](2026-10-22-atc-evolution-implementation.md#共享-seam-归属) |

执行顺序：Task 1 的结构与 marker 先落地，Task 2 的修订操作供 Task 3/4 使用，Task 6 的迁移依赖前四者，Task 5 的盐绑定独立于迁移进度但必须在 Task 6 的 apply 之前可用。

本批完成只表示合成v5迁移和持续摄入契约成立。真实库另行备份、授权并执行，逐范围报告可重算、保留、缺失和限制。D升级用途规则、E阅读和F容量仍分别验收，不能以C通过宣布全轮完成。
