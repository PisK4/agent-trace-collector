# 保留恢复与切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 限制正文和物理磁盘增长，保留可解释的历史与采集缺口，完成恢复验证后用 collector 替换 AVA 的采集入口。

**Architecture:** 预算控制、回收和原始层清理共用现有 writer，正文删除与状态更新同事务。磁盘暂停保留提交偏移，恢复时补采；维护命令在停服务后运行。并行验证只比较相同窗口和范围中的证据集合，切换和回滚均有明确操作记录。

**Tech Stack:** Bun 1.4.0、`bun:sqlite`、Node 文件系统接口、macOS launchd；不增加服务或依赖。

**Spec:** [architecture-design.md](../../architecture-design.md) 的容量、保留与 AVA 下线；[实施总入口](2026-10-20-collector-implementation.md)；前置 [A](2026-10-20-collector-foundation.md)、[B](2026-10-20-collector-body.md)。C1 的空库物理收缩实验须在 A 阶段提前完成；C1 写前保护和 C2 恢复验证须在生产 hook 注册前完成。

## Global Constraints

- 正文 `10 GB`、总磁盘 `16 GB`；GB 为十进制字节，MiB 为二进制字节。
- 80% 停新正文、95% 停新证据；恢复阈值分别75%、90%。写前余量至少 `max(256 MiB, 2 × 本批上界)`。
- 回收覆盖 available/partial/unsupported 与其他仍有正文的记录；pending 且无正文不入候选。
- 正文回收不删 request、route_summary、request_evidence，不清 have；`body_prev_state` 保留原状态。
- raw_ledger/raw_route/raw_hook 保留7天，长期摘要及attempt字段不依赖原始层仍在。
- 引用删除、孤儿清理、骨架清空、回收状态同事务；不维护引用计数。
- `auto_vacuum=INCREMENTAL` 建表前设置；回收后分批 incremental_vacuum，再 checkpoint。
- `synchronous=NORMAL` 不承诺掉电后的逐笔确认耐久；恢复报告必须注明边界。
- 默认不自动淘汰长期元数据。淘汰须先预览范围、再明确执行；不以文档里的命令视作本次已经获得上线或删除授权。

---

## C1：预算、回收和缺口补采

**Files:** Create `src/retention.ts`, `tests/retention.test.ts`; Modify `src/store.ts`, `src/schema.sql`, `src/main.ts`, `src/hook.ts`, `src/reconcile.ts`, `src/queries.ts`, `tests/files.test.ts`。

**Interfaces:**
- `measureStorage(store:Store,dataDir:string): StorageUsage`。
- `StorageUsage = {body_bytes:number;db_bytes:number;wal_bytes:number;temp_bytes:number;other_bytes:number;total_bytes:number;free_bytes:number;page_count:number;freelist_count:number}`。
- `admission(usage:StorageUsage,limits:{bodyBudget:number;diskLimit:number},batchUpperBytes:number,previous:'normal'|'metadata_only'|'paused'): {mode:'normal'|'metadata_only'|'paused';reason:string|null}`。
- `evictOldestBodyBatch(store:Store,now:number,limit?:number): {requests:number;blocks:number;releasedLogicalBytes:number;day:string|null}`，默认最多100笔，单批正文引用不超过10,000条；超大单请求单独处理。
- `pruneRaw(store:Store,beforeMs:number,limit?:number): {ledger:number;route:number;hook:number}`，默认每表最多100行。
- `resumeSourceGaps(store:Store,sourceName:string): {recoverable:number;unrecoverable:number}`。

- [ ] **步骤 1：写共享块不误删、元数据不变的测试。**

```ts
import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { persistBody, restoreBody } from '../src/body';
import { evictOldestBodyBatch } from '../src/retention';
test('回收旧请求保留共享块和历史读数', () => {
  const f = fixture();
  try {
    for (const [id,day] of [[1,'2026-10-19'],[2,'2026-10-20']] as const) {
      f.store.db.run('INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,in_tok) VALUES (?,?,?,\'through\',\'pending\',1,7,1,1,10)', [id,id,day]);
    }
    const body = {protocol:'chat',request:{messages:[{role:'user',content:'shared'}]},reply:{id:'chatcmpl_demo',choices:[]},redact_version:1};
    persistBody(f.store,1,body);
    persistBody(f.store,2,body);
    evictOldestBodyBatch(f.store,1000,1);
    expect(f.store.read.query('SELECT req_id,have,in_tok,body_state FROM request ORDER BY req_id').all()).toEqual([
      {req_id:1,have:7,in_tok:10,body_state:'evicted'},
      {req_id:2,have:7,in_tok:10,body_state:'available'}
    ]);
    expect(restoreBody(f.store,2)).toEqual(body);
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({n:1});
  } finally { f.close(); }
});
```

- [ ] **步骤 2：运行 `bun test tests/retention.test.ts`，确认缺回收行为失败。**

- [ ] **步骤 3：实现候选集事务和逻辑/物理双计量。** 候选优先最旧day，再按started_ms/req_id；状态与非空骨架、raw残留正文联合判断。先取候选req对应block id，再删引用，再对候选block反连接删除，无全库扫描。事务内清skeleton、raw副本、更新body_prev_state/evicted_at/reason；已evicted不覆盖原状态。

```sql
-- 候选请求和候选块使用 TEMP 表；每批清空，ID用绑定参数插入。
DELETE FROM request_block WHERE req_id IN (SELECT req_id FROM evict_requests);
DELETE FROM block
WHERE id IN (SELECT block_id FROM evict_blocks)
  AND NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=block.id);
UPDATE request SET skeleton_z=NULL,
  body_prev_state=CASE WHEN body_state='evicted' THEN body_prev_state ELSE body_state END,
  body_state='evicted',body_evicted_at=?,body_evict_reason='budget',updated_at=?
WHERE req_id IN (SELECT req_id FROM evict_requests);
```

`i_rb_block` 必须存在，用 `EXPLAIN QUERY PLAN` 验证 SEARCH 而非逐候选全表SCAN。大日按100笔切批，事务间让出事件循环；单请求超过引用上限允许独占一批并记录耗时，不切半笔事务。

逻辑预算求和 `length(block.z)+length(request.skeleton_z)+raw_hook未清空正文`；共享块只计一次。物理预算逐项 stat 数据目录内DB/WAL/临时文件/日志/备份等受管理产物，禁跟随符号链接扫目录外文件；文件系统剩余字节也参与admission。默认不在数据目录内保留无限日志、备份或dump，日志轮转总量上限16 MiB，维护产物提前计入预算。

达到正文预算先回收至90%正文预算；80%总盘只接元数据，并将收到却没存的正文写 `body_state=partial,miss_reason=disk_body_paused`。95%或物理剩余不足时拒hook（507），暂停文件证据写入。source_cursor.committed_off不变，只将A2 `FileBatch.observedOff` 写入observed_off；seenSize另记stat长度，不代替读取进度。source_gap按来源和代际合并连续区间，不能每轮新增一行。空间不足连诊断都写不下时保留内存健康错误，接口503且stderr只写固定错误码；恢复后补写诊断，不返回成功确认。

写前保护覆盖ingest、费用观测、派生、备份和维护；释放空间的回收事务保留专用余量，不因普通admission暂停而永远不能执行。B的单对象32 MiB及envelope64 MiB只是接收限制，writer还须根据实际序列化大小和引用数估算本批空间；不确定时按未压缩字节保守计量。

每批后 `PRAGMA incremental_vacuum(256)`；低负载且读事务结束后 `PRAGMA wal_checkpoint(TRUNCATE)`。checkpoint返回busy时退出本轮、计入健康并再试，不紧循环。不要在线执行全库VACUUM。原始清理先标evidence payload_state=expired，再删raw；长期sort/parse/reply/attempt字段与summary先已保存。没有完成关联的hook原文仍须迁到骨架，不能按7天到期直接丢失仍标unsupported的正文。

- [ ] **步骤 4：运行 A 阶段也需要的物理收缩实验与预算测试。**

```ts
// 独立测试库：建表前 INCREMENTAL，再 WAL。
const before = measureStorage(store,dir);
store.write(db => {
  db.run('CREATE TABLE shrink_probe(id INTEGER PRIMARY KEY,z BLOB)');
  const insert = db.prepare('INSERT INTO shrink_probe(z) VALUES (?)');
  for (let i=0;i<256;i++) insert.run(crypto.getRandomValues(new Uint8Array(32768)));
});
store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const full = measureStorage(store,dir);
store.write(db => db.run('DROP TABLE shrink_probe'));
for (let i=0;i<128;i++) {
  const row = store.db.query('PRAGMA freelist_count').get() as {freelist_count:number};
  if (row.freelist_count===0) break;
  store.db.exec('PRAGMA incremental_vacuum(256)');
}
store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const after = measureStorage(store,dir);
expect(full.db_bytes).toBeGreaterThan(before.db_bytes);
expect(after.total_bytes).toBeLessThan(full.total_bytes);
```

A 阶段可把这段实验放 `tests/store.test.ts`，C1创建后迁到retention测试；不必为提前实验先实现生产retention。另用可注入的StorageUsage模拟79%、80%、94%、95%和回落，确定滞回；真实小预算压测须使用大于固定维护余量的diskLimit，不能用2 MiB上限与256 MiB余量互相矛盾。用重复正文、唯一正文和raw副本混合填充，记录DB/WAL/temp实际峰值、事件循环延迟和admission拒收次数。

注入回收中断，在删引用后、标状态前SIGKILL，重开后应整体回滚。正常提交后检查：悬空引用0、幸存正文可还原、历史请求数和用量不变、没有已evicted却残留可回收副本。模拟暂停后文件追加、进程重启、恢复补采、上游文件消失；前三者最终集合一致，最后者永久缺口可查询。

- [ ] **步骤 5：运行 `bun test tests/retention.test.ts tests/files.test.ts tests/hook.test.ts && bun run typecheck` 后提交。**

```bash
git add src/retention.ts src/store.ts src/schema.sql src/main.ts src/hook.ts src/reconcile.ts src/queries.ts tests/retention.test.ts tests/files.test.ts
git commit -m "feat(retention): enforce storage budgets and preserve replayable source gaps" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C2：维护命令、备份与恢复

**Files:** Create `src/maintenance.ts`, `tests/maintenance.test.ts`, `docs/operations.md`; Modify `package.json`, `src/derive.ts`, `src/schema.sql`, `src/store.ts`。

**Interfaces:**
- `backupDatabase(source:string,destination:string): {bytes:number;schema_version:number}`，只在collector已停且源库通过检查时运行。
- `verifyDatabase(path:string): {integrity:string[];dangling_blocks:number;duplicate_evidence:number;pending_derivations:number}`。
- `previewMetadataPurge(store:Store,beforeDay:string): {requests:number;first_day:string|null;last_day:string|null;estimated_bytes:number}`。
- `purgeMetadata(store:Store,beforeDay:string,approvalId:string): {deleted:number}`，仅CLI显式`--apply --approval-id`调用，不挂后台定时器。
- `runMaintenance(args:string[]): Promise<number>`，命令 `verify|backup|rebuild|purge-metadata`。

- [ ] **步骤 1：写备份保留原库且恢复库可读测试。**

```ts
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { backupDatabase, verifyDatabase } from '../src/maintenance';
test('备份包含已提交状态且不覆盖已有目标', () => {
  const f = fixture();
  const source = join(f.dir,'trace.db');
  const target = join(f.dir,'restored.db');
  f.store.write(db => db.run("INSERT INTO collector_state(key,value_json) VALUES ('probe','{\"ok\":true}')"));
  f.store.close();
  try {
    backupDatabase(source,target);
    expect(verifyDatabase(target).integrity).toEqual(['ok']);
    expect(() => backupDatabase(source,target)).toThrow('destination_exists');
  } finally {
    // fixture.close须幂等关闭连接，随后清理临时目录。
    f.close();
  }
});
```

A1 `Store.close()` 实现为幂等，重复调用不报错；`collector_state`由A1的明确DDL创建，本例补充打开恢复库检查collector_state.probe为原值。

- [ ] **步骤 2：运行 `bun test tests/maintenance.test.ts`，确认缺命令失败。**

- [ ] **步骤 3：实现离线维护与恢复验证。** CLI 先确认常驻服务未运行、端口未被collector持有，再取得独占维护锁（数据目录下文件用`wx`，内容为pid与启动标识）。生产启动也检查该锁；陈旧锁只能在确认原pid不存在且用户看到具体路径后移除，不能自动覆盖未知活动锁。`backup`先校验目标不存在和余量，使用SQLite `VACUUM INTO`到新路径，参数通过SQL绑定传递；不复制一个正在变化的裸DB而漏WAL。

```ts
const result = db.query('PRAGMA integrity_check').all() as {integrity_check:string}[];
if (result.some(row => row.integrity_check !== 'ok')) throw new Error('integrity_failed');
db.query('VACUUM INTO ?').run(destination);
```

确认本机Bun SQLite对该语句的绑定支持；若不支持，用Bun SQLite的备份接口并验证一致性，禁止用字符串拼接绕过路径转义。备份目标权限0600，成功后运行integrity_check、foreign_key_check、悬空block反连接、evidence唯一owner、派生queue计数，返回结构报告。

恢复操作始终在新目录检查备份，启动合成来源验证分页、正文和路由；不就地覆盖当前trace.db。检查完成后停服务，保留原目录，使用配置切到恢复库启动。游标可能落后于上游时按物理身份重放，hook best-effort缺口仍保留；不以恢复数据库宣称补回停机期间的正文。

`rebuild --session <key>` 调用B4重建，只在有足够长期资料时重算；raw/正文均过期时返回unavailable数量和原因，不把旧标题/工具关系覆盖为空。记录算法版本及队列剩余量。

`purge-metadata --before YYYY-MM-DD`默认只预览。显式apply必须先回收该范围正文，再删除相关工具链接/aliases/evidence/raw/request/无其他引用的route_summary，整个批次同事务。删行前将精确日期区间、数量、原因、approvalId写入长期`retention_event`；后续来源回放不能悄悄恢复已明确淘汰范围，单独保留按来源代际/偏移的purged范围，命中时计为purged_skip而非新证据。两个同日请求一个已淘汰一个未淘汰不能仅凭day整日跳过，范围按实际证据键记录。

```sql
CREATE TABLE retention_event (
  id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, action TEXT NOT NULL,
  first_day TEXT, last_day TEXT, request_count INTEGER NOT NULL,
  reason TEXT NOT NULL, approval_id TEXT
);
CREATE TABLE purged_evidence (
  source_kind TEXT NOT NULL, ref_key TEXT NOT NULL, purged_at INTEGER NOT NULL,
  PRIMARY KEY(source_kind,ref_key)
) WITHOUT ROWID;
```

默认每证据保留小型tombstone，安全优先；记录它本身仍增长，不能据此声称长期元数据能永远停在固定体积。若达到需要压缩tombstone的规模，按可证明连续的物理偏移区间另做迁移，不在第一版加通用归档系统。

- [ ] **步骤 4：写维护失败矩阵并记录操作命令。** 测试目标已存在、磁盘余量不足、活动writer、损坏备份、未知schema高版本、raw过期但正文仍在、正文也已回收、purge默认无副作用、apply后重放不复活、共享route保留。恢复原理和以下命令写`docs/operations.md`：

```bash
bun run maintain verify --db '/path/to/stopped/trace.db'
bun run maintain backup --db '/path/to/stopped/trace.db' --out '/path/to/new/backup.db'
bun run maintain rebuild --db '/path/to/stopped/trace.db' --session '<conv_key>'
bun run maintain purge-metadata --db '/path/to/stopped/trace.db' --before 2026-09-01
```

路径和会话键是CLI参数示意，执行者必须换成已检查的目标；文档不包含真实账号/凭证。`package.json`增加`"maintain":"bun src/maintenance.ts"`。启动与维护锁释放在finally中，SIGKILL留下的锁有明确恢复操作。

- [ ] **步骤 5：运行 `bun test tests/maintenance.test.ts tests/retention.test.ts tests/derive.test.ts && bun run typecheck` 后提交。**

```bash
git add src/maintenance.ts tests/maintenance.test.ts docs/operations.md package.json src/derive.ts src/schema.sql src/store.ts
git commit -m "feat(maintenance): verify backups and make recovery and retention explicit" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C3：并行观察、AVA 切换与回滚

**Files:** Create `scripts/verify-cutover.ts`, `tests/cutover.test.ts`; Modify `docs/operations.md`, `README.md`, `docs/README.md`, `package.json`。

**Interfaces:**
- `compareCoverage(ledger:CoverageRow[],collector:CoverageRow[],ava:CoverageRow[]): CoverageReport`，纯函数供测试。
- `CoverageRow = {response_id:string|null; protocol:string|null; started_ms:number; agent:string|null; status:number|null; body_state:string; request_bytes:number|null}`。CLI先按参数窗口过滤三组数组，再传入纯函数；空数组的window由CLI覆盖为请求窗口，不能以Infinity生成报告。
- `CoverageReport = {denominator:number;collector_available:number;ava_available:number;collector_only:string[];ava_only:string[];missing_both:string[];ambiguous_ids:string[];null_id_counts:{ledger:number;collector:number;ava:number};window:{from:number;to:number}}`。
- CLI `bun run verify-cutover --from <epoch-ms> --to <epoch-ms> --collector <db> --ava <readonly-db> --out <local-report.json>`。

- [ ] **步骤 1：写窗口、NULL ID与歧义计数测试。**

```ts
import { expect, test } from 'bun:test';
import { compareCoverage } from '../scripts/verify-cutover';
test('两边都缺失不能藏在集合交集中', () => {
  const row = (id:string|null,body_state:string) => ({response_id:id,protocol:'chat',started_ms:100,agent:'demo',status:200,body_state,request_bytes:10});
  const report = compareCoverage([row('chatcmpl_a','pending'),row('chatcmpl_b','pending')],[row('chatcmpl_a','available')],[row('chatcmpl_a','available')]);
  expect(report.denominator).toBe(2);
  expect(report.missing_both).toEqual(['chatcmpl_b']);
  expect(report.collector_available).toBe(1);
});
```

- [ ] **步骤 2：运行 `bun test tests/cutover.test.ts`，确认缺核对逻辑失败。**

- [ ] **步骤 3：实现只读导出与守恒报告。** 使用collector已保存的ledger作为分母；窗口以epoch毫秒左闭右开，固定through/agent/status筛选，两边完全相同。原始ID集合和版本1规范ID集合各出一份报告；规范化碰撞单列ambiguous，不将多条真实请求合成1条计数。NULL ID单列，不能丢掉后宣称100%覆盖。计数保留行数、唯一ID数与重复候选数，满足：分母=有正文+无正文+无法唯一判断（在定义的筛选范围内）。

AVA schema在执行时只读检查`sqlite_master`和`PRAGMA table_info`，按实际字段写本地查询；本计划不猜AVA表名。若表字段与历史研究不同，先记录映射再修改脚本，不读取正文做全库dump。脚本只抽取response ID、时间、状态、大小和可用性元数据，SQLite以readonly打开，日志不写正文/账号/cwd。报告在仓库外、0600权限，不提交真实ID清单；仓库只留合成报告示例。

性能、覆盖率与稳定性使用运行窗口报告，不要求比AVA固定多98笔；98是旧样本。分桶包括ep/protocol、status、大小区间、duration、miss_reason。hook拿不到request大小的缺失行分到unknown，不编造超过32MiB原因。

- [ ] **步骤 4：准备可审阅的安装与回滚操作，再进入真实并行。** 先列出当前magpie插件与AVA实际服务定义，记录其文件路径/label/启动命令/工作目录/端口；在本地受限目录备份配置和权限，不把备份内容打印到终端或写进仓库。安装前生成collector注册片段和launchd plist，供执行者核对。示例仅表达结构：

```json
{
  "spec": "/absolute/collector/plugins/collector.hooks.ts",
  "options": {
    "endpoint": "http://127.0.0.1:8320/hook/ingest",
    "token": "<local-generated-token>",
    "gatewayTimeoutMs": 2000
  }
}
```

令牌由32随机字节生成，写本机0600配置，不放仓库、前端或命令行参数。hook令牌不能复用A4的 `<dataDir>/read.token`；后者仅供无Origin本地脚本读取API，A3的salt也不作为认证令牌。collector用固定Bun绝对路径启动，不依赖launchd读取交互shell PATH；plist放用户LaunchAgents，服务label采用`local.agent-trace-collector`。设置WorkingDirectory、ProgramArguments、KeepAlive、受限日志路径，先用`plutil -lint`检查。生产接入必须已经满足B末尾的推理策略决策、C1容量保护与C2恢复验证。

实际接入顺序：启动collector并确认Host受保护的健康接口；按magpie官方入口`magpie plugin add <本地hook路径>`添加collector并核对生成配置；保持AVA；用自然发生的流量观察至少24小时，并在窗口中覆盖一次collector重启和一个有大请求的会话。24小时是本计划建议的最小观察窗，达不到场景就延长，不人为发大模型请求补样本。每次操作前读取实际目标，注册不能覆盖整份plugins.json或移除其他插件。

本次写计划不等于授权执行这些外部配置变更。进入实施会话后，若用户已明确授权上线/切换则按范围推进；否则在配置差异、验证报告、回滚命令均准备好后集中请求一次确认。

- [ ] **步骤 5：通过上线门槛后停AVA，并实际验证回滚。** 上线门槛如下：

| 项目 | 必须有的结果 |
| --- | --- |
| 来源追赶 | ledger/route追平；无未解释的解析失败或长时间pending堆积 |
| 正文覆盖 | 相同窗口集合差已逐类解释；不低于AVA的可解释范围，额外缺口有明确原因或阻止切换 |
| 请求守恒 | 尝试不增顶层请求，重复投递不增引用/费用，歧义未被强合并 |
| 压力 | 大envelope、真实峰值期间hook确认延迟和总预算有余量；95%暂停可观察 |
| 回收 | 幸存正文可还原、共享块不误删、历史元数据不变、DB/WAL确实收缩 |
| 恢复 | 进程SIGKILL、备份恢复、缺口补采测试通过，NORMAL掉电边界写明 |
| 回滚 | AVA实际启动命令、插件条目、launchd label与备份可用 |

先停AVA服务，再从plugins.json移除AVA条目，撤其常驻和开机启动；保留AVA库只读。每步确认collector仍采到新自然请求、ledger/route继续前移。回滚时重新启用已备份的AVA插件条目与原服务，再停用collector hook；保留collector库供排查，不删除或覆盖。配置回滚按条目合并，不能用整份旧plugins.json覆盖并行窗口中别人新增的配置。

完成回滚演练后恢复最终选定状态，记录起止时间、任何正文缺口与最终服务状态到本地报告。`docs/operations.md`只保存通用步骤和无敏感汇总。真实运行涉及等待，不可用合成测试结果替代24小时观察，更不能在本次文档交付中勾选通过。

- [ ] **步骤 6：运行 `bun test tests/cutover.test.ts && bun run typecheck`，文档检查通过后提交。** `package.json`增加`"verify-cutover":"bun scripts/verify-cutover.ts"`。脚本用`if (import.meta.main)`保护CLI入口，测试import不会访问真实库。

```bash
git add scripts/verify-cutover.ts tests/cutover.test.ts docs/operations.md README.md docs/README.md package.json
git commit -m "feat(operations): add cutover verification and reversible AVA migration" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## 最终交付验收

- [ ] A/B/C 所有合成测试和类型检查通过，临时文件清理完成。
- [ ] collector可在本机重启恢复，运行数据、salt、令牌、日志均在仓库外且权限正确。
- [ ] 页面可分页查看真实会话、请求、路由与正文，缺失/未支持/回收/待关联分别显示。
- [ ] 正文与磁盘预算生效；采集暂停期间提交偏移不越过未入库证据；无法补回的缺口永久可见。
- [ ] raw过期后历史attempt读数、路由摘要、解析状态与正文可用性不失真。
- [ ] 并行观察与恢复报告满足门槛，AVA最终状态与用户选择一致，原库保留只读。
- [ ] README和docs索引更新为实际完成状态，附运行命令、配置项、恢复入口和已知限制。

本计划完成不代表以上上线验收已经执行。阶段报告须分别写清合成测试、真实只读观察、生产变更及未完成项目。
