# 持久化与真实页面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先证明文件摄入与 SQLite 恢复正确，再用账本、路由和费用 API 支撑真实请求页面。

**Architecture:** 一个 writer 事务提交证据、读模型和游标，文件读取与 HTTP 放在事务外。生产页面从原型迁移，消费独立只读连接提供的分页 API；这一阶段没有 hook 正文。

**Tech Stack:** Bun 1.4.0、TypeScript、`bun:sqlite`、Node 标准库、原生浏览器 JavaScript。

**Spec:** [architecture-design.md](../../architecture-design.md) 的阶段 0、第 1 步；[实施总入口](2026-10-20-collector-implementation.md) 的共同契约、文件职责、类型与决策边界也全部适用。

## Global Constraints

- `127.0.0.1`、SQLite WAL、单 writer、`synchronous=NORMAL`、建表前 `auto_vacuum=INCREMENTAL`。
- 默认数据库 `~/Library/Application Support/agent-trace-collector/trace.db`；运行数据不进仓库。
- 账本 5 秒、路由 2 秒、reconciler 1 秒；`>=0.1.1294 <0.2.0` 外降级启动。
- 账本物理身份保留多计费行；route 不是账本主键；direct 关闭。
- through 费用由 API 补齐，文件缺失字段保持 NULL；四种金额状态不可混合。
- 无第三方生产依赖，不扫描 Agent 会话，不改 magpie，不停 AVA。
- 每个代码步骤的片段定义关键契约，SQL 基础列从指定架构 DDL 逐项迁入；不能自行删减长期字段。

---

## A1：可恢复的 SQLite 存储

**Files:**
- Create: `package.json`, `tsconfig.json`, `README.md`, `src/config.ts`, `src/schema.sql`, `src/store.ts`
- Create: `tests/store.test.ts`, `tests/fixtures.ts`, `tests/worker.ts`
- Modify: `.gitignore`（当前仅 `.DS_Store`）

**Interfaces:**
- Consumes: Bun `Database`、总入口的 `Store` 类型。
- Produces: `openStore(path: string): Store`；`loadConfig(env: Record<string,string|undefined>): Config`。
- Produces: `fixture(): { dir: string; store: Store; close(): void }`，供后续测试建立和删除临时目录。
- `Config = { dataDir: string; port: number; ledgerPath: string; routingDir: string; magpieUrl: string; bodyBudget: number; diskLimit: number }`，默认端口 8320；端口占用直接失败，不自动换端口。

- [ ] **步骤 1：建立工程入口并写事务不变量测试。**

```json
{
  "name": "agent-trace-collector", "private": true, "type": "module",
  "scripts": {
    "start": "bun src/main.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.9.3" }
}
```

安装时将实际解析的 `@types/bun` 版本改为精确版本并提交 `bun.lock`；生产依赖为空。`tsconfig.json` 使用 `strict:true`、`target:ESNext`、`module:Preserve`、`moduleResolution:Bundler`、`noEmit:true`、`types:[bun]`，检查 `src/tests/plugins/scripts`。前端 JS 由 Bun 语法构建与浏览器检查。

```ts
// tests/fixtures.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  const store = openStore(join(dir, 'trace.db'));
  return { dir, store, close() { store.close(); rmSync(dir, { recursive: true }); } };
}
```

```ts
// tests/store.test.ts
import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
test('事务失败不留下证据或游标', () => {
  const f = fixture();
  try {
    expect(() => f.store.write(db => {
      db.run("INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms) VALUES ('ledger','usage.jsonl','g:0',100,1)");
      throw new Error('injected');
    })).toThrow('injected');
    expect(f.store.read.query('SELECT count(*) AS n FROM source_cursor').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});
```

- [ ] **步骤 2：运行 `bun install`，再运行 `bun test tests/store.test.ts`。** 预期因 `src/store` 尚未导出实现失败，记录失败点；依赖安装失败先解决环境，不把它当功能红灯。

- [ ] **步骤 3：迁入 DDL 并实现存储。** 从架构的 `source_cursor/raw_ledger/raw_route/raw_hook/route_summary/request/request_evidence/pending_hook/block/request_block/tool_call` SQL 块原样建立基础列与索引，追加以下迁移补充；`schema_version` 用 `PRAGMA user_version`，新库为 1。已有未知高版本拒绝写入，已有 auto_vacuum=0 库要求离线迁移，不在启动时自动 VACUUM。

```sql
ALTER TABLE source_cursor ADD COLUMN rewrite_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_cursor ADD COLUMN observed_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN sort_source TEXT;
ALTER TABLE request ADD COLUMN sort_key TEXT;
ALTER TABLE request ADD COLUMN actor_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE request ADD COLUMN parse_state TEXT;
ALTER TABLE request ADD COLUMN reply_state TEXT;
ALTER TABLE request ADD COLUMN redact_version INTEGER;
ALTER TABLE request ADD COLUMN match_version INTEGER;
ALTER TABLE request ADD COLUMN pricing_version TEXT;
ALTER TABLE request ADD COLUMN cost_reason TEXT;
ALTER TABLE request ADD COLUMN attempt_state TEXT NOT NULL DEFAULT 'known';
ALTER TABLE request ADD COLUMN instance_key TEXT NOT NULL DEFAULT 'local';
ALTER TABLE request_evidence ADD COLUMN payload_state TEXT NOT NULL DEFAULT 'present';
CREATE UNIQUE INDEX i_evidence_owner ON request_evidence(source_kind, ref_key);
CREATE TABLE derive_queue (
  conv_key TEXT NOT NULL, actor TEXT NOT NULL, from_sort TEXT NOT NULL,
  PRIMARY KEY(conv_key, actor)
) WITHOUT ROWID;
CREATE TABLE ingest_issue (
  source_kind TEXT NOT NULL, ref_key TEXT NOT NULL, reason TEXT NOT NULL,
  observed_at INTEGER NOT NULL, byte_length INTEGER,
  PRIMARY KEY(source_kind, ref_key, reason)
) WITHOUT ROWID;
CREATE TABLE source_gap (
  source_kind TEXT NOT NULL, source_name TEXT NOT NULL, file_generation TEXT NOT NULL,
  from_off INTEGER NOT NULL, to_off INTEGER NOT NULL, reason TEXT NOT NULL,
  state TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_kind, source_name, file_generation, from_off)
) WITHOUT ROWID;
CREATE TABLE cost_observation (
  ref_key TEXT NOT NULL, observed_at INTEGER NOT NULL, payload_json TEXT NOT NULL,
  magpie_version TEXT, pricing_version TEXT,
  PRIMARY KEY(ref_key, observed_at)
) WITHOUT ROWID;
```

事务核心采用同步闭包，不在事务里 await：

```ts
const write = <T>(fn: (db: Database) => T): T => db.transaction(() => {
  const result = fn(db);
  if (result instanceof Promise) throw new TypeError('async writer');
  return result;
}).immediate();
```

`openStore` 先建数据目录（0700），打开写库（文件 0600），空库建表前设置 `auto_vacuum=INCREMENTAL`，再设 `journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=1000`；迁移成功后开独立 `readonly:true` 连接并 `query_only=ON`。检查 PRAGMA 的实际返回值。端口不能覆盖绑定地址；GB 按十进制解析，预算正数且正文预算小于总上限。

`.gitignore` 加 `node_modules/`、`*.db`、`*.db-wal`、`*.db-shm`、`*.log`、`.env*`、`coverage/`，文档说明默认库在仓库外。日志只记固定错误码、计数和非敏感来源名称。

- [ ] **步骤 4：补同 route 多行与子进程崩溃检查。** `tests/worker.ts` 接收 DB 路径和 `before-commit|after-commit`，写两条 route=7 的账本物理行与游标，在指定点输出固定 `READY` 并等待 IPC；父测试收到 READY 后 `SIGKILL`，重开数据库。前者无新行且偏移未动，后者两行都在且偏移=完整行末尾，再回放行数仍为 2。另验证写事务内只读连接只能看到旧快照。

```ts
// worker 的注入点只由测试参数启用，不读生产环境变量。
const commit = db.transaction(() => {
  db.run("INSERT OR IGNORE INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json,route_id) VALUES ('file','g:0',0,'2026-10-20T00:00:00Z',1,'through','{}',7)");
  if (mode === 'before-commit') { process.stdout.write('READY\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
});
commit();
if (mode === 'after-commit') { process.stdout.write('READY\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
```

正式测试将两行及游标放入上述事务，测试超时 5 秒就终止子进程并报错；不能用固定 sleep 猜测崩溃位置。此检查证明进程崩溃恢复，不证明断电耐久。

- [ ] **步骤 5：运行 `bun test tests/store.test.ts && bun run typecheck`，通过后提交。**

```bash
git add package.json bun.lock tsconfig.json .gitignore README.md src/config.ts src/schema.sql src/store.ts tests/fixtures.ts tests/store.test.ts tests/worker.ts
git commit -m "feat(store): add transactional SQLite foundation and crash recovery checks" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## A2：完整行、文件代际与路由归档

**Files:** Create `src/sources/files.ts`, `tests/files.test.ts`; Modify `tests/fixtures.ts`（添加合成文件工具）。

**Interfaces:**
- Consumes: `Store`、A1 游标表。
- Produces: `readBatch(path: string, cursor: FileCursor | null): Promise<FileBatch>`。
- `FileCursor = { generation: string; rewriteEpoch: number; committedOff: number; seenSize: number; headLen: number; headHash: string | null }`。
- `FileBatch = { generation: string; lines: { offset: number; end: number; text: string }[]; committedOff: number; seenSize: number; headLen: number; headHash: string | null; rewriteEpoch: number }`。
- Produces: `readRouteFiles(dir: string): Promise<{name:string; fingerprint:string; lines:string[]; kind:'jsonl'|'gz'}[]>`；gzip 可以分批返回解压行，不能把未完成摘要写成已成功。

- [ ] **步骤 1：写追加与半行用例。**

```ts
import { expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBatch } from '../src/sources/files';
test('追加不换代，末尾半行不提交', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":');
    const a = await readBatch(path, null);
    expect(a.lines.map(x => x.text)).toEqual(['{"n":1}']);
    appendFileSync(path, '2}\n');
    const b = await readBatch(path, a);
    expect(b.generation).toBe(a.generation);
    expect(b.lines.map(x => x.text)).toEqual(['{"n":2}']);
  } finally { f.close(); }
});
```

- [ ] **步骤 2：运行 `bun test tests/files.test.ts`，确认缺模块失败。**

- [ ] **步骤 3：实现 fd 读取和完整行切分。** 以 Buffer 的 `0x0a` 切行、计算原始字节偏移，去除尾部 CR 后才解码 UTF-8；多字节中文不能用字符串长度推进。每批最多 128 行或 8 MiB，较大单行独占一批；以 64 MiB 为来源行保护上限，超限完整行只记录 `line_too_large`、位置与长度，不落原文。未换行的超限行分块扫描到换行或 EOF，不累积无限 Buffer。

```ts
const end = bytes.lastIndexOf(0x0a);
const complete = end < 0 ? Buffer.alloc(0) : bytes.subarray(0, end + 1);
// 输出 end 必须等于该行换行后的文件字节位置。
const generation = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${rewriteEpoch}`;
```

文件 fd 的 `fstat` 与实际读使用同一对象；BigInt 转字符串，不先转 Number。头部 hash 长度冻结，非空初始文件小于 64 KiB 时取当时字节数。缩短和基线变化按总入口递增 epoch；普通追加不变。`readBatch` 不写数据库，由 A3 在证据事务内提交 cursor。

路由扫描所有匹配 `YYYY-MM-DD.jsonl`、`YYYY-MM-DD.jsonl.gz` 的文件，不按今日过滤；忽略临时文件。gzip 用 `gunzipSync` 或 Bun 支持的标准流解压，验证串联 gzip member；解压上限分批控制，不把多日压缩库整体装入内存。损坏 gzip 记失败并保留原 fingerprint，下一轮重试。

- [ ] **步骤 4：写覆盖同 inode 重写、跨午夜与 gzip 替换的用例。**

```ts
// tests/files.test.ts 的独立用例数据
const first = '{"id":7,"time":1}\n';
const late = '{"id":8,"time":2}\n';
// 用 gzipSync(first) 建昨日 .gz，同时建昨日 .jsonl=first+late；
// 合并后 route id 为 [7,8]。再把 .gz 原子替换为 gzipSync(first+late)，
// 并删除 .jsonl，仍为 [7,8]。最后重新创建昨日 .jsonl 写 id=9，得到 [7,8,9]。
```

测试以 `writeFileSync(path, newContent)` 复现同 inode 重写，新内容同偏移必须产生新 generation。空文件→首行→超过 64 KiB 的正常追加始终保持同代；改变已冻结区域触发新代。物理观察集合验证与路由逻辑集合验证分开，不把相同内容等同重复账本。

- [ ] **步骤 5：运行 `bun test tests/files.test.ts tests/store.test.ts && bun run typecheck`，通过后提交。**

```bash
git add src/sources/files.ts tests/files.test.ts tests/fixtures.ts
git commit -m "feat(ingest): track complete lines and rewritten source generations" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## A3：账本、路由与费用收敛

**Files:** Create `src/sources/magpie.ts`, `src/reconcile.ts`, `src/privacy.ts`, `tests/reconcile.test.ts`, `tests/magpie.test.ts`; Modify `src/schema.sql`（仅在尚未发布迁移时整理 v1）。

**Interfaces:**
- `redact(value: unknown, salt: Uint8Array, rules?: {path:string; pattern:string}[]): unknown`，B1 扩充测试，不改变签名。
- `ingestLedger(store: Store, sourceName: string, batch: FileBatch, now: number): {accepted:number; invalid:number; duplicate:number}`。
- `ingestRoute(store: Store, records: unknown[], now: number): void`。
- `enrichCosts(store: Store, routeId: number, baseUrl: string, now: number, fetcher?: typeof fetch): Promise<void>`。
- `probeMagpie(baseUrl:string, versionFile:string, fetcher?:typeof fetch): Promise<{version:string|null; verified:boolean; reason:string|null}>`。
- `classifyLedger(row: Record<string,unknown>): 'through'|'rejected'`；文件不推断 direct。

- [ ] **步骤 1：写多尝试、合法 kind、rejected 和字段缺失测试。**

```ts
import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { ingestLedger } from '../src/reconcile';
test('两条计费行只生成一个请求且保留 kind', () => {
  const f = fixture();
  try {
    const rows = [
      { t:'2026-10-20T00:00:00Z', route_id:7, agent:'demo', model:'m', provider:'p', status:429, in:10, out:0, handed_on:true },
      { t:'2026-10-20T00:00:01Z', route_id:7, agent:'demo', model:'m', provider:'p', status:200, in:20, out:5, kind:'web_search', session:'s' }
    ];
    let offset = 0;
    const lines = rows.map(row => { const text=JSON.stringify(row); const start=offset; offset+=Buffer.byteLength(text)+1; return {offset:start,end:offset,text}; });
    const batch = {generation:'g:0',rewriteEpoch:0,lines,committedOff:offset,seenSize:offset,headLen:0,headHash:null};
    ingestLedger(f.store, 'usage.jsonl', batch, 1);
    ingestLedger(f.store, 'usage.jsonl', batch, 2);
    expect(f.store.read.query('SELECT status,attempt_in,attempt_billed,cache_write FROM request').all()).toEqual([{status:200,attempt_in:30,attempt_billed:2,cache_write:null}]);
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({n:2});
  } finally { f.close(); }
});
```

- [ ] **步骤 2：运行 `bun test tests/reconcile.test.ts tests/magpie.test.ts`，确认行为未实现。**

- [ ] **步骤 3：实现映射与同事务合并。** 字段映射集中 `magpie.ts`，SQL 入参全部绑定。原始 JSON 保留未知字段但先脱敏；记录 `t_text` 与合法解析后的 `t_ms`。时间无法解析的行进入 `ingest_issue`，不伪造时间；坏完整行记录 issue 后可推进游标，半行不能。

```ts
export function classifyLedger(row: Record<string, unknown>) {
  return row.rejected === true ||
    ((row.provider == null || row.provider === '') && Number(row.status) >= 400)
    ? 'rejected' : 'through';
}
const optionalNumber = (row: Record<string, unknown>, key: string) =>
  Object.hasOwn(row, key) && typeof row[key] === 'number' ? row[key] : null;
const evidenceKey = (generation: string, offset: number) =>
  JSON.stringify(['file', generation, offset]);
```

有 route 的非 rejected 证据关联现存 route 请求；无 route、rejected 均可按各自物理身份建立独立请求，不按空 route 合并。最终状态取同 route 内 `(t_ms, file_generation, byte_offset)` 最后一条非 handed_on；仅有 handed_on 时标尚未见最终结果。attempt 用量对实际提供的列求和，缺值传播为未知或另标部分汇总；同代重复重放不能再相加。路由 tries 数组长度为 attempt_count，账本计费行数为 attempt_billed，两者分开。

`request_evidence` 的唯一 owner 处理原始层已过期的重放。路由同步写 `route_summary`，保留 order 的 provider/model/who、tries 的状态/时间/用量/费用状态、affinity；prompt 总量与 parts 写 request，完整 raw_route 仅短期保留。无账本的路由先存原始和摘要，暂不增加顶层请求数，后续账本到达再关联。

将版本、形状探针结果保存到小型 `collector_state(key TEXT PRIMARY KEY,value_json TEXT)` 表：文件版本与 `/v1` 不同以 HTTP 为准；HTTP 暂不可用保留最后已知值并记录过期。必需字段按来源和记录类型分组，个别缺失不是整批漂移；新版本伴随整批必需字段缺失时降级保留可解析原始证据。每分钟重探版本，每批持续检查形状。

脱敏先覆盖头白名单、路径凭证、Bearer/sk-/AKIA/JWT/私钥以及字符串中的 JSON。schema 中 token 数值、工具 ID、工具 schema 必须保留；无法处理的自定义正则使配置启动失败，不静默忽略。stdout 只写 issue code 与计数。

- [ ] **步骤 4：实现按 route 补费用并验证四态。** 先请求 `GET /v1/magpie/usage/requests?period=all&via=through&computer=this&route=<id>&offset=0&limit=500`。只读取普通 loopback；认证失败记录 `cost_api_denied`，不退到 LAN 或读取用户密钥。返回数组字段为 `rows`，下一 offset 为响应 `offset+rows.length`，空页停止；有 500 行时继续，route 已限制范围但仍按观测匹配幂等。

```ts
const costState = (row: { priced?: boolean; cost?: number } | null) => {
  if (!row) return 'absent';
  if (row.priced === false) return 'unpriced';
  if (row.priced !== true || !Number.isFinite(row.cost) || row.cost! < 0) return 'absent';
  return row.cost === 0 ? 'zero' : 'priced';
};
```

测试 mock 返回 `priced=true,cost=0`、`priced=false,cost=0`、正金额、401、同 route 两条可区分尝试、两条不可区分候选、后来改价；保持原 token NULL，不把 cost API 的补零拷进 request。通过 `cost_observation` 保留取值时点与原始观测，定价版本未提供则 NULL。rejected 被 `via=through` 排除，保持 `absent/not_applicable` 原因，不额外拉 direct。

费用队列每秒最多一个 route，未完成集合从 request.cost_state 与重试状态恢复；失败退避 5s、30s、300s，上限 300s。不以大量历史请求阻塞 ingest，不为查询每次刷新重新抓全量历史价格。

- [ ] **步骤 5：运行 `bun test tests/reconcile.test.ts tests/magpie.test.ts tests/files.test.ts && bun run typecheck` 后提交。** 增补乱序文件、route 先到、缺 route、显式 rejected/status=200、坏行之后正常行和 7 天 raw 删除后重放用例。

```bash
git add src/sources/magpie.ts src/reconcile.ts src/privacy.ts src/schema.sql tests/reconcile.test.ts tests/magpie.test.ts
git commit -m "feat(reconcile): merge ledger and route evidence with sourced cost states" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## A4：受保护的查询 API 与进程生命周期

**Files:** Create `src/http.ts`, `src/queries.ts`, `src/main.ts`, `tests/http.test.ts`, `tests/queries.test.ts`。

**Interfaces:**
- `createHandler(store:Store, config:Config, readToken:string): (req:Request)=>Promise<Response>`。
- `startCollector(config:Config): Promise<{port:number; stop():Promise<void>}>`。
- `listSessions(store:Store, limit:number, cursor:string|null): Page<SessionRow>`。
- `listRequests(store:Store, key:string, limit:number, cursor:string|null): Page<RequestRow>`。
- `getRequest(store:Store, id:number): RequestDetail|null`；`getRoute(store:Store,id:number): {state:'available'|'absent'|'expired'; summary:unknown}`。
- `RequestDetail = RequestRow & { prev_req_id:number|null; prev_relation:'confirmed'|'unknown'|'first'|null; delta_ordinals:number[]|null; parse_state:string|null; reply_state:string|null; ms:number|null; ttft_ms:number|null; flow_ms:number|null; first_text_ms:number|null; reasoning:number|null; prompt_tokens:number|null; prompt_counted:number|null; prompt_window:number|null; prompt_turns:number|null; parts:unknown; attempt_count:number|null; attempt_billed:number|null; attempt_in:number|null; attempt_out:number|null; attempt_cache_read:number|null; attempt_cache_write:number|null; attempt_reasoning:number|null; attempt_cost:number|null; attempt_cost_state:CostState; title_source:string; derive_version:number; archive:string|null; route_state:string }`。

- [ ] **步骤 1：写浏览器访问边界测试。**

```ts
import { expect, test } from 'bun:test';
import { createHandler } from '../src/http';
import { loadConfig } from '../src/config';
import { fixture } from './fixtures';
test('伪造 Host 和 null Origin 被拒绝', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const foreign = new Request('http://127.0.0.1:8320/api/sessions', {headers:{host:'evil.example',origin:'http://evil.example'}});
    const opaque = new Request('http://127.0.0.1:8320/api/sessions', {headers:{host:'127.0.0.1:8320',origin:'null'}});
    expect((await handler(foreign)).status).toBe(403);
    expect((await handler(opaque)).status).toBe(403);
  } finally { f.close(); }
});
```

- [ ] **步骤 2：运行 `bun test tests/http.test.ts tests/queries.test.ts`，确认缺实现失败。**

- [ ] **步骤 3：实现参数化查询和精确访问规则。** 会话 limit 默认50、最大100，请求默认100、最大200；非法 limit/id/cursor 返回400，缺实体404。cursor 是 base64url 编码 JSON，校验值类型后绑定 SQL，不能拼接 SQL。请求分页 `(started_ms,req_id)` 倒序，会话 `(last_ms,conv_key)` 倒序。

```sql
SELECT req_id, started_ms, title, status, model_requested, model_served,
       in_tok, out_tok, cache_read, cache_write, cost, cost_state, have, body_state
FROM request
WHERE conv_key = ? AND (started_ms < ? OR (started_ms = ? AND req_id < ?))
ORDER BY started_ms DESC, req_id DESC LIMIT ?;
```

查询 `limit+1` 条生成 next_cursor；列表 SELECT 禁止 `*`。API 不返回原始 payload/account/host/providerKeyId 或 skeleton。会话通过 GROUP BY 聚合，不建聚合表；NULL 用量显示部分汇总。活跃会话 last_ms 变动会让列表排序变化，页面按 conv_key 去重并支持刷新，不承诺跨页冻结快照。

统一 `Cache-Control:no-store`、`X-Content-Type-Options:nosniff`，不发跨域 CORS。HTML 加 `frame-ancestors 'none'` 的 CSP，生产 JS 外置以允许 `script-src 'self'`。首页导航和 API 无 Origin 规则按总入口；静态文件只按允许的 `/`、`/app.js` 路径返回，其他路径404，不做任意路径读取。

`/api/stats` 此阶段输出各来源游标、最后成功、解析失败、版本/形状、追赶中、pending 数；C 扩展磁盘。启动先迁移，再开 HTTP，再逐批追历史；轮询不得重入，用运行中标记和 finally 释放。SIGTERM 停止新轮询、停止接受写入、完成当前同步事务、关闭连接，未提交来源下一次重读。若另一进程已占端口启动失败；维护命令先检查服务停用，不与在线 writer 并行。

- [ ] **步骤 4：补 1,825 笔与访问矩阵测试。** 合成会话插入 1,825 笔，其中多个相同 started_ms，遍历分页得到恰好 1,825 个唯一 ID；跨页期间加入更新请求，旧分页不重复。验证同源、合法 read token、无认证 curl、跨站 Fetch Metadata、OPTIONS、缺 Host、Origin 端口不符、SQL 注入 cursor、超大 limit、账户字段不可见。暖查询 100 行本机目标 <100 ms，报告 p50/p95，不做跨机器绝对保证。

```ts
const seen = new Set<number>();
let cursor: string | null = null;
do {
  const page = listRequests(store, key, 100, cursor);
  for (const row of page.items) {
    expect(seen.has(row.req_id)).toBe(false);
    seen.add(row.req_id);
  }
  cursor = page.next_cursor;
} while (cursor);
expect(seen.size).toBe(1825);
```

- [ ] **步骤 5：运行 `bun test tests/http.test.ts tests/queries.test.ts && bun run typecheck` 后提交。**

```bash
git add src/http.ts src/queries.ts src/main.ts tests/http.test.ts tests/queries.test.ts
git commit -m "feat(api): serve protected keyset queries and collector health" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## A5：原型接入真实分页数据

**Files:** Create `web/index.html`, `web/app.js`, `tests/web.test.ts`; Modify `src/http.ts`, `README.md`, `docs/README.md`。

**Interfaces:**
- Consumes: A4 全部接口及 DTO。
- Produces: `createReader(fetcher: typeof fetch): { loadSessions(cursor?:string):Promise<void>; selectSession(key:string):Promise<void>; selectRequest(id:number):Promise<void>; getState():ReaderState }`，从 `web/app.js` 导出供合成网络测试。
- `ReaderState = { request: RequestDetail|null; requestState:'loading'|'error'|'empty'|'ready'; sessionKey:string|null; error:string|null }`；前端以 JSDoc 标注，测试访问 request 前先断言非空。DOM 初始化置于 `if (typeof document !== 'undefined')` 内，纯 reader 导入不会操作浏览器。

- [ ] **步骤 1：从原型复制 HTML/CSS，剥离合成数据并写异步竞争测试。** 保留布局、主题、URL 键与事件委托。`TIMELINE/REQUESTS/EXTRA/SESSIONS` 演示常量不进入生产 JS；用 Map 缓存已加载请求，以 `loading/error/empty/ready` 区分网络状态和正文状态。

```js
// tests/web.test.ts 的可控 fetch：慢的第一笔不能覆盖快的第二笔。
let finishFirst;
const fetcher = async url => {
  if (String(url).endsWith('/1')) return await new Promise(resolve => { finishFirst = resolve; });
  return Response.json({ req_id:2, title:'second', body_state:'pending', have:2 });
};
const reader = createReader(fetcher);
const first = reader.selectRequest(1);
await reader.selectRequest(2);
finishFirst(Response.json({req_id:1,title:'first',body_state:'pending',have:2}));
await first;
expect(reader.getState().request.req_id).toBe(2);
```

- [ ] **步骤 2：运行 `bun test tests/web.test.ts`，确认缺 reader 导出失败。**

- [ ] **步骤 3：实现请求序号防止旧结果覆盖，并逐处替换同步假设。**

```js
let selectionEpoch = 0;
async function selectRequest(id) {
  const epoch = ++selectionEpoch;
  const response = await fetcher(`/api/requests/${id}`);
  if (!response.ok) throw new Error(`request_http_${response.status}`);
  const request = await response.json();
  if (epoch !== selectionEpoch) return;
  state.request = request;
  state.requestState = 'ready';
}
```

实际 reader 内包含上述 state 和 fetcher。导航失败保留明确 error，不回退演示值。空库不能读 `SESSIONS[0].key`；URL 中过期 req id 显示未找到。统一 `deltaOnly` 为 Set，不在 `ensureSelection()` 中设 false。

按原型入口迁移：`renderSessions/selectSession/selectRequest/popstate` 改用分页缓存；`sessionHead/usageSection` 不把缺失值 `||0`；`routeSection` 从实际尝试与账本取去向，不用候选 order 的最后一项；`rawBlock` 移除 `demo-response-*`，此阶段正文显示尚未接入或未收到。右栏请求参数按 A4 DTO 渲染，route 从 `/api/requests/:id/route` 取长期摘要。

搜索限定已加载会话/请求并显示范围说明，Agent 筛选同样标明当前已加载范围；不宣称全库搜索。生产界面移除 DEMO 字样和合成完成率。内容写入 DOM 前使用原型的转义函数或 textContent，不插入未经转义的 route.error、title、tool 文本。

- [ ] **步骤 4：执行空库与合成库浏览器验收。** `bun run start` 以临时 dataDir 和合成来源启动；用当时可用的 `ego-browser` 技能检查 1500px、900px、400px，浅/深主题，会话分页、请求分页、快速切换、后退/刷新、404、API 500、加载中。无生产正文的空白必须解释原因。合成 `<img src=x onerror=...>` 作为标题和 route error 时只显示文本，不能执行。

```bash
bun test tests/web.test.ts tests/http.test.ts tests/queries.test.ts
bun build web/app.js --target browser --outfile /tmp/collector-app-check.js
bun test
bun run typecheck
```

`/tmp/collector-app-check.js` 仅为语法检查产物，不提交；浏览器验收记录写 README，区分合成验收与真实流量观察。随后只读连接真实账本/路由，确认首次追赶状态、请求数守恒、费用来源与时间范围；不保存真实正文截图。

- [ ] **步骤 5：通过后提交并进入阶段门槛。**

```bash
git add web/index.html web/app.js tests/web.test.ts src/http.ts README.md docs/README.md
git commit -m "feat(web): connect the trace reader to real paginated metadata" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## A 阶段验收

- [ ] 已证明同 route 多物理账本行、重复回放、事务中断、半行、跨午夜、gzip 替换与同 inode 重写。
- [ ] `accepted + duplicate + invalid = 已读取完整物理行数`；raw 删除后的重放仍不重复计费。
- [ ] 顶层请求计数与尝试计数分开，未归属请求各自独立，route-only 记录不额外增请求。
- [ ] 费用四态与来源可解释，未拿到 API 或无法一对一匹配时明确缺失。
- [ ] Host/Origin/read-token 边界和敏感 DTO 排除测试通过，真实文件只读。
- [ ] 1,825 笔合成会话分页无漏重，100 行暖查询本机目标 <100 ms。
- [ ] 阶段 0 的物理收缩验证提前运行 C1 指定的临时库实验；未证明收缩前不把 A 标为持久化验证完成。
- [ ] 页面可以查看真实元数据与路由，正文为空且原因准确；AVA 和 magpie 配置未变。

证据范围继承总入口；`route` API 参数、rejected 分类和 hook 缺 route ID 的源码依据均属于 `开源源码@magpie-2374ffe`，运行版仍以接入探针为准。
