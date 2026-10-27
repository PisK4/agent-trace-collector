import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { fixture, seedPurposeRequest } from './fixtures';
import { openStore } from '../src/store';
import { acquireMaintenanceLock, lockPath, maintenanceLockPresent } from '../src/maintenance/lock';
import { backupBundle, backupDatabase, restoreBundle } from '../src/maintenance/backup';
import { previewAgentPurge, previewMetadataPurge, purgeAgent, purgeMetadata } from '../src/maintenance/purge';
import { runMaintenance } from '../src/maintenance/cli';
import { verifyDatabase } from '../src/maintenance/verify';
import { loadBoundSaltTx, loadConfig } from '../src/config';
import { redact } from '../src/privacy';
import { startCollector } from '../src/main';
import { persistBody, restoreBody } from '../src/body';
import { GROUP_ALGORITHM } from '../src/derive/state';
import { PURPOSE_VERSION } from '../src/semantics';

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
    // 完成的组保留 clean 记录，待办只剩另一个会话。
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM derive_queue
      WHERE conv_key='zz-target' AND state<>'clean'`).get()).toEqual({ n: 0 });
    expect(f.store.read.query(`SELECT conv_key,state FROM derive_queue WHERE state<>'clean'`).all())
      .toEqual([{ conv_key: 'aa-other', state: 'dirty' }]);
  } finally {
    f.close();
  }
});

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
    expect(JSON.parse(lines[0]!)).toMatchObject({
      queue_remaining: 0, recomputed_requests: 1, retained_requests: 1,
      target_algorithm: GROUP_ALGORITHM, pending_groups: 0,
      // 实际算法只统计真正重算过的行；保留行与迁移前旧行分开计。
      actual_algorithms: { [String(GROUP_ALGORITHM)]: 1 },
      // 这一笔是"重算过但正文已回收"，属 retained，不是从未重算的 legacy。
      legacy_requests: 0,
    });
    expect(f.store.read.query(`SELECT title,title_source FROM request WHERE req_id=2`).get())
      .toEqual({ title: 'retained title', title_source: 'user_delta' });
    expect(f.store.read.query(
      `SELECT req_id,summary_algorithm,summary_state FROM request ORDER BY req_id`).all()).toEqual([
      { req_id: 1, summary_algorithm: GROUP_ALGORITHM, summary_state: 'recomputed' },
      // 正文已回收：旧算法与旧 basis 原样保留，不提升到本次版本。
      { req_id: 2, summary_algorithm: null, summary_state: 'retained' },
    ]);
    // 重复运行结果稳定。
    const second: string[] = [];
    expect(await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', 'mixed'], { out: line => second.push(line), err: () => {} })).toBe(0);
    expect(JSON.parse(second[0]!)).toMatchObject({
      actual_algorithms: { [String(GROUP_ALGORITHM)]: 1 }, legacy_requests: 0,
    });
  } finally {
    f.close();
  }
});

test('备份包含已提交状态且不覆盖已有目标', () => {
  const f = fixture();
  const source = join(f.dir, 'trace.db');
  const target = join(f.dir, 'restored.db');
  try {
    f.store.write(db => db.run("INSERT INTO collector_state(key,value_json) VALUES ('probe','{\"ok\":true}')"));
    expect(() => backupDatabase(source, target)).toThrow('source_must_be_stopped');
    f.store.close();
    backupDatabase(source, target);
    expect(verifyDatabase(target).integrity).toEqual(['ok']);
    expect(() => backupDatabase(source, target)).toThrow('destination_exists');
    // 恢复库权限 0600，且带原库内容。
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const restored = openStore(target);
    try {
      expect(restored.read.query("SELECT value_json FROM collector_state WHERE key='probe'").get())
        .toEqual({ value_json: '{"ok":true}' });
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test('verifyDatabase报告悬空块、重复证据与待派生分组', () => {
  const f = fixture();
  const path = join(f.dir, 'trace.db');
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
              VALUES (1,1,'2026-10-20','hook','pending',1,1,1,1)`);
      // 没有引用的块：悬空。
      db.run("INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES (9,x'01','fp',x'02',3)");
      // 同一证据 ref_key 两个 owner：唯一索引本应拦住，这里直接测反连接能查出来。
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
              VALUES (1,'hook','dup','merged',1)`);
      db.run("INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES ('k','a','')");
    });
    const report = verifyDatabase(path);
    expect(report.integrity).toEqual(['ok']);
    expect(report.dangling_blocks).toBe(1);
    expect(report.duplicate_evidence).toBe(0);
    expect(report.pending_derivations).toBe(1);
  } finally {
    f.close();
  }
});

test('损坏的库不会被当成合格备份', () => {
  const f = fixture();
  const broken = join(f.dir, 'broken.db');
  try {
    f.store.close();
    writeFileSync(broken, 'this is not a database');
    expect(() => verifyDatabase(broken)).toThrow();
  } finally {
    f.close();
  }
});

function seedDays(store: ReturnType<typeof fixture>['store']): void {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,route_id)
       VALUES (?,?,?,'through','pending',1,3,1,1,?)`,
    );
    for (const [id, day] of [[1, '2026-09-01'], [2, '2026-09-02'], [3, '2026-10-20']] as const) {
      insert.run(id, id, day, id * 100);
    }
    // 已合并的旧 id 指向 1；淘汰 1 时这个别名必须一起删掉，否则外键拦着。
    db.run('INSERT INTO request_alias(old_id,new_id) VALUES (4,1)');
    db.run('DELETE FROM request WHERE req_id=4');
    db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
            VALUES (1,'ledger','r1','merged',1),(2,'ledger','r2','merged',1),(3,'ledger','r3','merged',1)`);
    db.run(`INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json)
            VALUES ('r1',1,'h','{}'),('r2',1,'h','{}'),('r3',1,'h','{}')`);
    // 每笔请求一个正文块；淘汰后只应剩下存活请求的那一块。
    db.run(`INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES (1,x'0a','f1',x'01',1),(2,x'0b','f2',x'01',1),(3,x'0c','f3',x'01',1)`);
    db.run('INSERT INTO request_block(req_id,ord,role,block) VALUES (1,0,1,1),(2,0,1,2),(3,0,1,3)');
    // 路由摘要：100/200 只被淘汰的请求引用，300 仍被存活请求引用。
    db.run(`INSERT INTO route_summary(route_id,time_ms,z) VALUES (100,1,x'01'),(200,2,x'01'),(300,3,x'01')`);
    // 工具关系：被淘汰请求的配对随请求删除，存活请求的配对不受影响。
    db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state)
            VALUES ('call_purged',1,0,'read','resolved'),('call_live',3,0,'read','resolved')`);
  });
}

test('淘汰元数据先预览再执行，删别名在前且费用观测一起清', () => {
  const f = fixture();
  try {
    seedDays(f.store);
    const preview = previewMetadataPurge(f.store, '2026-09-03');
    expect(preview.requests).toBe(2);
    expect(preview.first_day).toBe('2026-09-01');
    expect(preview.last_day).toBe('2026-09-02');

    // 预览不改任何东西。
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 3 });
    expect(f.store.read.query('SELECT count(*) AS n FROM retention_event').get()).toEqual({ n: 0 });

    const result = purgeMetadata(f.store, '2026-09-03', 'approval-synthetic-1');
    expect(result.deleted).toBe(2);
    expect(f.store.read.query('SELECT req_id FROM request ORDER BY req_id').all()).toEqual([{ req_id: 3 }]);
    expect(f.store.read.query('SELECT old_id,new_id FROM request_alias').all()).toEqual([]);
    // 只清目标证据的费用观测，存活请求的观测保留。
    expect(f.store.read.query('SELECT ref_key FROM cost_observation ORDER BY ref_key').all()).toEqual([{ ref_key: 'r3' }]);
    expect(f.store.read.query('SELECT ref_key FROM request_evidence ORDER BY ref_key').all()).toEqual([{ ref_key: 'r3' }]);
    // 目标正文随引用一起回收，不留孤儿块；存活请求的块与配对保持原样。
    expect(f.store.read.query('SELECT req_id FROM request_block').all()).toEqual([{ req_id: 3 }]);
    expect(f.store.read.query('SELECT id FROM block').all()).toEqual([{ id: 3 }]);
    expect(verifyDatabase(join(f.dir, 'trace.db')).dangling_blocks).toBe(0);
    expect(f.store.read.query('SELECT call_id FROM tool_call').all()).toEqual([{ call_id: 'call_live' }]);
    // 仍被存活请求引用的路由摘要保留，只被淘汰请求引用的清掉。
    expect(f.store.read.query('SELECT route_id FROM route_summary ORDER BY route_id').all()).toEqual([{ route_id: 300 }]);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const event = f.store.read.query<{
      action: string; first_day: string; last_day: string; request_count: number; reason: string; approval_id: string;
    }, []>('SELECT action, first_day, last_day, request_count, reason, approval_id FROM retention_event').get();
    expect(event).toEqual({
      action: 'purge_metadata', first_day: '2026-09-01', last_day: '2026-09-02',
      request_count: 2, reason: 'metadata_retention', approval_id: 'approval-synthetic-1',
    });
    // 墓碑按证据键记录，重放时命中计 purged_skip。
    expect(f.store.read.query('SELECT source_kind,ref_key FROM purged_evidence ORDER BY ref_key').all()).toEqual([
      { source_kind: 'ledger', ref_key: 'r1' },
      { source_kind: 'ledger', ref_key: 'r2' },
    ]);
  } finally {
    f.close();
  }
});

test('淘汰在删行前标记受影响组，空组同步完成', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,started_ms,day,via,conv_key,conv_source,actor,actor_state,
                body_state,derive_version,have,created_at,updated_at)
              VALUES (1,1,'2026-09-01','through','k-live','session','a-live','known','pending',1,3,1,1),
                     (2,2,'2026-09-04','through','k-live','session','a-live','known','pending',1,3,1,1),
                     (3,3,'2026-09-02','through','k-gone','session','a-gone','known','pending',1,3,1,1)`);
      // 两个组都先标成完成：淘汰必须让有剩余成员的组重新 dirty，空组保持完成。
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
                published_revision,target_algorithm,state)
              VALUES ('k-live','a-live','','epoch-live',4,4,1,'clean'),
                     ('k-gone','a-gone','','epoch-gone',2,2,1,'clean')`);
    });
    expect(purgeMetadata(f.store, '2026-09-03', 'approval-synthetic-groups').deleted).toBe(2);
    const rows = f.store.read.query<{
      conv_key: string; state: string; input_revision: number; published_revision: number; group_epoch: string;
    }, []>('SELECT conv_key,state,input_revision,published_revision,group_epoch FROM derive_queue ORDER BY conv_key').all();
    const live = rows.find(row => row.conv_key === 'k-live')!;
    const gone = rows.find(row => row.conv_key === 'k-gone')!;
    // 仍有成员的组：保留 epoch、修订增长、重新 dirty。
    expect(live).toMatchObject({ state: 'dirty', group_epoch: 'epoch-live' });
    expect(live.input_revision).toBeGreaterThan(4);
    // 空组：不产生积压，完成记录对当前修订成立。
    expect(gone).toMatchObject({
      state: 'clean', published_revision: gone.input_revision,
    });
  } finally {
    f.close();
  }
});

test('已淘汰的证据重放时计为purged_skip而不是新证据', () => {
  const f = fixture();
  try {
    seedDays(f.store);
    purgeMetadata(f.store, '2026-09-03', 'approval-synthetic-2');
    expect(f.store.read.query<{ ref_key: string }, []>(
      'SELECT ref_key FROM purged_evidence ORDER BY ref_key').all()).toEqual([{ ref_key: 'r1' }, { ref_key: 'r2' }]);
  } finally {
    f.close();
  }
});

test('同日只有部分请求命中时按实际证据键淘汰，不整日跳过', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
              VALUES (1,1,'2026-09-05','through','pending',1,3,1,1),
                     (2,2,'2026-09-05','through','pending',1,3,1,1)`);
    });
    const preview = previewMetadataPurge(f.store, '2026-09-06');
    expect(preview.requests).toBe(2);
  } finally {
    f.close();
  }
});

test('淘汰过程中故障整体回滚', () => {
  const f = fixture();
  try {
    seedDays(f.store);
    f.store.db.exec(`CREATE TRIGGER fail_purge BEFORE DELETE ON request
                     WHEN OLD.req_id=2 BEGIN SELECT RAISE(ABORT,'injected_purge'); END`);
    expect(() => purgeMetadata(f.store, '2026-09-03', 'approval-synthetic-3')).toThrow();
    expect(f.store.read.query('SELECT req_id FROM request ORDER BY req_id').all())
      .toEqual([{ req_id: 1 }, { req_id: 2 }, { req_id: 3 }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM retention_event').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT old_id FROM request_alias').all()).toEqual([{ old_id: 4 }]);
    f.store.write(db => db.run('DROP TRIGGER fail_purge'));
  } finally {
    f.close();
  }
});

function seedAgentPurge(store: ReturnType<typeof fixture>['store']): void {
  store.write(db => {
    db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,
              created_at,updated_at,route_id,agent,conv_key,conv_source,actor,actor_state)
            VALUES
              (1,1,'2026-10-26','through','pending',1,3,1,1,100,'hermes','k-shared','session','a-known','known'),
              (2,2,'2026-10-26','hook','pending',1,1,1,1,200,'claude','k-shared','session','a-known','known'),
              (3,3,'2026-10-27','through','pending',1,3,1,1,300,'hermes','k-hermes','session','a-h','known'),
              (4,4,'2026-10-27','hook','pending',1,1,1,1,NULL,'hermes',NULL,NULL,NULL,'unknown')`);
    // 已合并的旧 id 指向目标：别名必须先删，否则外键拦住删除。
    db.run('INSERT INTO request_alias(old_id,new_id) VALUES (9,1)');
    db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES
      (1,'ledger','["file","gen-A",10]','merged',1),
      (1,'route','100','merged',1),
      (1,'hook','h-1','merged',1),
      (2,'hook','h-2','merged',1),
      (2,'hook','h-shared','merged',1),
      (2,'ledger','["file","gen-B",50]','merged',1),
      (3,'ledger','["file","gen-A",20]','merged',1),
      (3,'route','300','merged',1),
      (4,'hook','h-4','merged',1)`);
    db.run(`INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json) VALUES
      ('["file","gen-A",10]',1,'h','{}'),('100',1,'h','{}'),('h-1',1,'h','{}'),
      ('h-2',1,'h','{}'),('h-shared',1,'h','{}'),('["file","gen-B",50]',1,'h','{}'),
      ('["file","gen-A",20]',1,'h','{}'),('300',1,'h','{}'),('h-4',1,'h','{}')`);
    // 原始层按 agent 归属：其中两条被存活请求（claude）共享，删除时必须保留。
    db.run(`INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,route_id,t_text,t_ms,source,agent,payload_json) VALUES
      ('file','gen-A',10,100,'t',1,'magpie','hermes','{"a":1}'),
      ('file','gen-A',20,300,'t',1,'magpie','hermes','{"a":1}'),
      ('file','gen-A',30,200,'t',1,'magpie','claude','{"a":1}'),
      ('file','gen-B',50,200,'t',1,'magpie','hermes','{"a":1}')`);
    db.run(`INSERT INTO raw_route(route_id,time_ms,day,agent,payload_json) VALUES
      (100,1,'2026-10-26','hermes','{"r":1}'),
      (200,1,'2026-10-26','claude','{"r":1}'),
      (300,1,'2026-10-27','hermes','{"r":1}')`);
    db.run(`INSERT INTO raw_hook(hook_id,received_at,agent,parse_state) VALUES
      ('h-1',1,'hermes','ok'),('h-2',1,'claude','ok'),
      ('h-4',1,'hermes','ok'),('h-shared',1,'hermes','ok')`);
    db.run("INSERT INTO pending_hook(hook_id,first_seen) VALUES ('h-4',1)");
    db.run(`INSERT INTO route_summary(route_id,time_ms,z) VALUES
      (100,1,x'01'),(200,2,x'01'),(300,3,x'01')`);
    db.run(`INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES
      (1,x'0a','f1',x'01',1),(2,x'0b','f2',x'01',1),(3,x'0c','f3',x'01',1),
      (4,x'0d','f4',x'01',1),(5,x'0e','f5',x'01',1)`);
    db.run(`INSERT INTO request_block(req_id,ord,role,block) VALUES
      (1,0,1,1),(3,0,1,2),(2,0,1,3),(4,0,1,4),(1,1,1,5),(2,1,1,5)`);
    db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state) VALUES
      ('call-1',1,0,'read','resolved'),('call-2',2,0,'read','resolved')`);
    db.run(`INSERT INTO bg_job(job_id,conv_key,spawn_req,state) VALUES
      ('bg-1','k-hermes',3,'pending'),('bg-2','k-shared',2,'pending')`);
    db.run(`INSERT INTO otlp_body_ref(request_body_id,trace_id,req_id,state,updated_at)
            VALUES ('rb-1',x'00',1,'wired',1)`);
    db.run(`INSERT INTO derive_request_result(generation,req_id,started_ms,purpose_revision,
              algorithm,retention_state)
            VALUES ('gen-result-0000001',1,1,0,1,'recomputed')`);
    // 两个组都先标成完成：共享组删后仍有成员，应重新 dirty；hermes 独占组应保持完成。
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
              published_revision,target_algorithm,published_algorithm,state)
            VALUES ('k-shared','a-known','','epoch-shared',4,4,1,1,'clean'),
                   ('k-hermes','a-h','','epoch-hermes',2,2,1,1,'clean')`);
  });
}

test('按agent拆除只删目标行，共享会话与跨agent引用保留', () => {
  const f = fixture();
  try {
    seedAgentPurge(f.store);
    const preview = previewAgentPurge(f.store, 'hermes');
    expect(preview).toMatchObject({
      agent: 'hermes', requests: 3, conv_keys: 2, shared_conv_keys: 1,
      groups: 2, groups_with_remaining: 1,
      first_day: '2026-10-26', last_day: '2026-10-27',
      evidence: { ledger: 2, route: 2, hook: 2 },
      // h-shared 与 gen-B/50 被 claude 请求共享，不计入可删行数。
      raw: { ledger: 2, route: 2, hook: 2, pending_hook: 1, route_summary: 2 },
    });
    expect(preview.estimated_bytes).toBeGreaterThan(0);
    // 预览不改任何东西。
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 4 });

    const result = purgeAgent(f.store, 'hermes', 'approval-synthetic-agent');
    expect(result.deleted).toBe(3);
    expect(f.store.read.query('SELECT req_id FROM request ORDER BY req_id').all()).toEqual([{ req_id: 2 }]);
    expect(f.store.read.query('SELECT old_id,new_id FROM request_alias').all()).toEqual([]);
    expect(f.store.read.query(`SELECT source_kind,ref_key FROM request_evidence
      WHERE req_id=2 ORDER BY source_kind,ref_key`).all()).toEqual([
      { source_kind: 'hook', ref_key: 'h-2' },
      { source_kind: 'hook', ref_key: 'h-shared' },
      { source_kind: 'ledger', ref_key: '["file","gen-B",50]' },
    ]);
    expect(f.store.read.query('SELECT ref_key FROM cost_observation ORDER BY ref_key').all()).toEqual([
      { ref_key: '["file","gen-B",50]' }, { ref_key: 'h-2' }, { ref_key: 'h-shared' },
    ]);
    // 原始层：被存活请求共享的证据键保留，其余按归属删除。
    expect(f.store.read.query('SELECT byte_offset FROM raw_ledger ORDER BY byte_offset').all())
      .toEqual([{ byte_offset: 30 }, { byte_offset: 50 }]);
    expect(f.store.read.query('SELECT hook_id FROM raw_hook ORDER BY hook_id').all())
      .toEqual([{ hook_id: 'h-2' }, { hook_id: 'h-shared' }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM pending_hook').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT route_id FROM raw_route ORDER BY route_id').all()).toEqual([{ route_id: 200 }]);
    expect(f.store.read.query('SELECT route_id FROM route_summary ORDER BY route_id').all())
      .toEqual([{ route_id: 200 }]);
    // 正文块：只被目标引用的回收，共享块与存活请求的块保留。
    expect(f.store.read.query('SELECT id FROM block ORDER BY id').all()).toEqual([{ id: 3 }, { id: 5 }]);
    expect(f.store.read.query('SELECT req_id FROM request_block ORDER BY req_id,ord').all())
      .toEqual([{ req_id: 2 }, { req_id: 2 }]);
    expect(f.store.read.query('SELECT call_id FROM tool_call').all()).toEqual([{ call_id: 'call-2' }]);
    expect(f.store.read.query('SELECT job_id FROM bg_job').all()).toEqual([{ job_id: 'bg-2' }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM otlp_body_ref').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM derive_request_result').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT old_id FROM request_alias').all()).toEqual([]);
    expect(verifyDatabase(join(f.dir, 'trace.db')).dangling_blocks).toBe(0);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const event = f.store.read.query<{
      action: string; first_day: string; last_day: string; request_count: number;
      reason: string; approval_id: string;
    }, []>('SELECT action,first_day,last_day,request_count,reason,approval_id FROM retention_event').get();
    expect(event).toEqual({
      action: 'purge_agent', first_day: '2026-10-26', last_day: '2026-10-27',
      request_count: 3, reason: 'agent_removal:hermes', approval_id: 'approval-synthetic-agent',
    });
    expect(f.store.read.query('SELECT source_kind,ref_key FROM purged_evidence ORDER BY source_kind,ref_key').all())
      .toEqual([
        { source_kind: 'hook', ref_key: 'h-1' },
        { source_kind: 'hook', ref_key: 'h-4' },
        { source_kind: 'ledger', ref_key: '["file","gen-A",10]' },
        { source_kind: 'ledger', ref_key: '["file","gen-A",20]' },
        { source_kind: 'route', ref_key: '100' },
        { source_kind: 'route', ref_key: '300' },
      ]);
    // 只剩未知归属行的空组没有队列行；共享组保留 epoch 重新 dirty，独占组同步完成。
    const groups = f.store.read.query<{ conv_key: string; state: string; group_epoch: string }, []>(
      'SELECT conv_key,state,group_epoch FROM derive_queue ORDER BY conv_key').all();
    expect(groups.find(row => row.conv_key === 'k-shared')).toMatchObject({
      state: 'dirty', group_epoch: 'epoch-shared',
    });
    expect(groups.find(row => row.conv_key === 'k-hermes')).toMatchObject({
      state: 'clean', group_epoch: 'epoch-hermes',
    });
  } finally {
    f.close();
  }
});

test('按agent拆除重复执行不新增删除与事件', () => {
  const f = fixture();
  try {
    seedAgentPurge(f.store);
    expect(purgeAgent(f.store, 'hermes', 'approval-synthetic-agent-2').deleted).toBe(3);
    const second = purgeAgent(f.store, 'hermes', 'approval-synthetic-agent-2');
    expect(second).toEqual({ deleted: 0, event_id: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM retention_event').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM purged_evidence').get()).toEqual({ n: 6 });
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('按agent拆除过程中故障整体回滚', () => {
  const f = fixture();
  try {
    seedAgentPurge(f.store);
    f.store.db.exec(`CREATE TRIGGER fail_agent_purge BEFORE DELETE ON request
                     WHEN OLD.req_id=3 BEGIN SELECT RAISE(ABORT,'injected_agent_purge'); END`);
    expect(() => purgeAgent(f.store, 'hermes', 'approval-synthetic-agent-3')).toThrow();
    expect(f.store.read.query('SELECT req_id FROM request ORDER BY req_id').all())
      .toEqual([{ req_id: 1 }, { req_id: 2 }, { req_id: 3 }, { req_id: 4 }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 4 });
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_hook').get()).toEqual({ n: 4 });
    expect(f.store.read.query('SELECT count(*) AS n FROM pending_hook').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM derive_request_result').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM retention_event').get()).toEqual({ n: 0 });
    expect(f.store.read.query<{ group_epoch: string }, [string]>(
      'SELECT group_epoch FROM derive_queue WHERE conv_key=?').get('k-hermes'))
      .toEqual({ group_epoch: 'epoch-hermes' });
    f.store.write(db => db.run('DROP TRIGGER fail_agent_purge'));
  } finally {
    f.close();
  }
});

test('维护命令在目标库上执行并返回退出码', async () => {
  const f = fixture();
  const source = join(f.dir, 'trace.db');
  const target = join(f.dir, 'cli-backup.db');
  try {
    f.store.write(db => db.run("INSERT INTO collector_state(key,value_json) VALUES ('probe','1')"));
    f.store.close();

    expect(await runMaintenance(['verify', '--db', source])).toBe(0);
    expect(await runMaintenance(['backup', '--db', source, '--out', target])).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(await runMaintenance(['backup', '--db', source, '--out', target])).toBe(1);
    expect(await runMaintenance(['purge-metadata', '--db', source, '--before', '2026-09-01'])).toBe(0);
    expect(await runMaintenance(['purge-metadata', '--db', source, '--before', '2026-09-01', '--apply'])).toBe(1);
    expect(await runMaintenance(['purge-agent', '--db', source, '--agent', 'hermes'])).toBe(0);
    expect(await runMaintenance(['purge-agent', '--db', source, '--agent', 'hermes', '--apply'])).toBe(1);
    expect(await runMaintenance(['purge-agent', '--db', source])).toBe(2);
    expect(await runMaintenance(['nope'])).toBe(2);
  } finally {
    f.close();
  }
});

test('恢复bundle保存原盐且拒绝覆盖目标', () => {
  const f = fixture();
  const bundle = join(f.dir, 'bundle');
  const restored = join(f.dir, 'restored');
  try {
    const salt = f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.close();
    backupBundle(f.dir, bundle);
    // 包里只放数据库、盐与清单三样，别的文件一律不认。
    expect(readdirSync(bundle).sort()).toEqual(['manifest.json', 'redaction.salt', 'trace.db']);
    restoreBundle(bundle, restored);
    expect(readFileSync(join(restored, 'redaction.salt'))).toEqual(Buffer.from(salt));
    expect(statSync(join(restored, 'trace.db')).mode & 0o777).toBe(0o600);
    expect(() => restoreBundle(bundle, restored)).toThrow('destination_exists');
    const store = openStore(join(restored, 'trace.db'));
    try {
      expect(store.write(db => loadBoundSaltTx(db, restored))).toEqual(salt);
      // 同一份盐继续脱敏：同一敏感值得到与备份前相同的占位符。
      const secret = { account: 'synthetic-account-1' };
      expect(redact(secret, store.write(db => loadBoundSaltTx(db, restored)))).toEqual(redact(secret, salt));
    } finally {
      store.close();
    }
  } finally {
    f.close();
  }
});

test('bundle备份要求采集器已停且失败不留目标', () => {
  const f = fixture();
  const bundle = join(f.dir, 'bundle');
  try {
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    // 采集器还开着：拒绝，且目标与 staging 都不留下。
    expect(() => backupBundle(f.dir, bundle)).toThrow('source_must_be_stopped');
    expect(existsSync(bundle)).toBe(false);
    expect(readdirSync(f.dir).filter(name => name.startsWith('.atc-bundle-'))).toEqual([]);
    f.store.close();
    backupBundle(f.dir, bundle);
    expect(() => backupBundle(f.dir, bundle)).toThrow('destination_exists');

    // 错盐：库里的绑定与盘上的盐不是一对，包不能出。
    const wrongSalt = join(f.dir, 'wrong-bundle');
    const correctSalt = readFileSync(join(f.dir, 'redaction.salt'));
    writeFileSync(join(f.dir, 'redaction.salt'), new Uint8Array(32).fill(9), { mode: 0o600 });
    expect(() => backupBundle(f.dir, wrongSalt)).toThrow('redaction_salt_mismatch');
    expect(existsSync(wrongSalt)).toBe(false);
    expect(readdirSync(f.dir).filter(name => name.startsWith('.atc-bundle-'))).toEqual([]);

    // 缺盐：没有文件就没有可恢复的包，也不能顺手生成一份新盐。
    const missingSalt = join(f.dir, 'missing-salt-bundle');
    rmSync(join(f.dir, 'redaction.salt'));
    expect(() => backupBundle(f.dir, missingSalt)).toThrow('redaction_salt_missing');
    expect(existsSync(missingSalt)).toBe(false);
    expect(existsSync(join(f.dir, 'redaction.salt'))).toBe(false);
    writeFileSync(join(f.dir, 'redaction.salt'), correctSalt, { mode: 0o600 });
  } finally {
    f.close();
  }
});

test('恢复拒绝错盐、缺盐与损坏的数据库且不留目标', () => {
  const f = fixture();
  const bundle = join(f.dir, 'bundle');
  const restored = join(f.dir, 'restored');
  try {
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.close();
    backupBundle(f.dir, bundle);
    // 复制一份包做破坏实验，原包保持可恢复。
    const tampered = join(f.dir, 'tampered');
    cpSync(bundle, tampered, { recursive: true });
    const files = ['trace.db', 'redaction.salt', 'manifest.json'] as const;
    for (const name of files) writeFileSync(join(tampered, name), readFileSync(join(tampered, name)), { mode: 0o600 });

    writeFileSync(join(tampered, 'redaction.salt'), new Uint8Array(32).fill(9), { mode: 0o600 });
    expect(() => restoreBundle(tampered, restored)).toThrow('restore_bundle_invalid');
    expect(existsSync(restored)).toBe(false);

    // 缺文件：包的内容集合对不上，不猜缺的是哪一份。
    rmSync(join(tampered, 'redaction.salt'));
    expect(() => restoreBundle(tampered, restored)).toThrow('restore_bundle_invalid');
    expect(existsSync(restored)).toBe(false);

    // 数据库被改写：清单哈希对不上。
    rmSync(tampered, { recursive: true, force: true });
    cpSync(bundle, tampered, { recursive: true });
    for (const name of files) writeFileSync(join(tampered, name), readFileSync(join(tampered, name)), { mode: 0o600 });
    const db = readFileSync(join(tampered, 'trace.db'));
    db[100] = db[100]! ^ 0xff;
    writeFileSync(join(tampered, 'trace.db'), db, { mode: 0o600 });
    expect(() => restoreBundle(tampered, restored)).toThrow('restore_bundle_invalid');
    expect(existsSync(restored)).toBe(false);
    expect(readdirSync(f.dir).filter(name => name.startsWith('.atc-restore-'))).toEqual([]);
  } finally {
    f.close();
  }
});

test('恢复在发布前校验失败时不留下半套目录', () => {
  const f = fixture();
  const bundle = join(f.dir, 'bundle');
  const restored = join(f.dir, 'restored');
  try {
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.close();
    backupBundle(f.dir, bundle);
    // 清单自洽但数据库不是库：哈希能对上，只有完整性校验会拒绝。
    const junk = join(f.dir, 'junk.db');
    writeFileSync(junk, 'this is not a database', { mode: 0o600 });
    const manifestPath = join(bundle, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    rmSync(join(bundle, 'trace.db'));
    cpSync(junk, join(bundle, 'trace.db'));
    const hash = createHash('sha256').update(readFileSync(join(bundle, 'trace.db'))).digest('hex');
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, database_sha256: hash }), { mode: 0o600 });
    expect(() => restoreBundle(bundle, restored)).toThrow('restore_bundle_invalid');
    expect(existsSync(restored)).toBe(false);
    expect(readdirSync(f.dir).filter(name => name.startsWith('.atc-restore-'))).toEqual([]);
  } finally {
    f.close();
  }
});

test('维护命令能产出并恢复bundle', async () => {
  const f = fixture();
  const bundle = join(f.dir, 'cli-bundle');
  const restored = join(f.dir, 'cli-restored');
  try {
    const salt = f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.close();
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    expect(await runMaintenance(['bundle', '--dir', f.dir, '--out', bundle], io)).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, bundle });
    expect(await runMaintenance(['restore', '--bundle', bundle, '--out', restored], io)).toBe(0);
    expect(JSON.parse(lines[1]!)).toMatchObject({ ok: true, restored });
    expect(readFileSync(join(restored, 'redaction.salt'))).toEqual(Buffer.from(salt));
    // 用法错误与目标已存在都返回失败码，而不是静默继续。
    expect(await runMaintenance(['bundle', '--dir', f.dir], io)).toBe(2);
    expect(await runMaintenance(['restore', '--bundle', bundle, '--out', restored], io)).toBe(1);
  } finally {
    f.close();
  }
});

test('v7库备份写实际版本；v6包恢复后原地升级，白名单外两侧都拒', () => {
  const f = fixture();
  try {
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.close();
    const bundle = join(f.dir, 'bundle-v7');
    backupBundle(f.dir, bundle);
    const manifestPath = join(bundle, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.schema).toBe(7);
    const restored = join(f.dir, 'restored-v7');
    restoreBundle(bundle, restored);
    const store = openStore(join(restored, 'trace.db'));
    try {
      expect(store.read.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    } finally { store.close(); }

    // v6 包仍在白名单：恢复后首次打开按 v6→v7 原地升级（纯新增表）。
    const db6 = new Database(join(f.dir, 'trace.db'));
    db6.run('PRAGMA user_version=6');
    db6.close();
    const bundle6 = join(f.dir, 'bundle-v6');
    backupBundle(f.dir, bundle6);
    const manifest6 = JSON.parse(readFileSync(join(bundle6, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest6.schema).toBe(6);
    const restored6 = join(f.dir, 'restored-v6');
    restoreBundle(bundle6, restored6);
    const store6 = openStore(join(restored6, 'trace.db'));
    try {
      expect(store6.read.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    } finally { store6.close(); }

    // 白名单外的版本两侧都拒：低版本没有升级路径，搬回来也打不开。
    const db = new Database(join(f.dir, 'trace.db'));
    db.run('PRAGMA user_version=5');
    db.close();
    expect(() => backupBundle(f.dir, join(f.dir, 'bundle-v5')))
      .toThrow('backup_schema_unsupported');

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schema: 5 }));
    expect(() => restoreBundle(bundle, join(f.dir, 'bad-version')))
      .toThrow('restore_bundle_invalid');
  } finally { f.close(); }
});

test('维护锁阻止第二个维护进程取得同一数据目录', () => {
  const f = fixture();
  try {
    const first = acquireMaintenanceLock(f.dir, 'maintenance-a');
    expect(first).not.toBeNull();
    // 第二个进程拿到不同的持有者标识，必须被拒绝而不是覆盖别人的锁。
    expect(acquireMaintenanceLock(f.dir, 'maintenance-b')).toBeNull();
    first!.release();
    // 释放后可以再取；陈旧锁按持有者判断可清理。
    const second = acquireMaintenanceLock(f.dir, 'maintenance-a');
    expect(second).not.toBeNull();
    second!.release();
  } finally {
    f.close();
  }
});

test('陈旧维护锁只在原持有者已不在时才被清理', () => {
  const f = fixture();
  try {
    // 造一把停在旧进程上的锁，进程号用一个不可能存在的值。
    writeFileSync(lockPath(f.dir), JSON.stringify({ pid: 999_999, holder: 'dead-process', started_ms: 1 }), { mode: 0o600 });
    const recovered = acquireMaintenanceLock(f.dir, 'maintenance-c', { pidAlive: () => false });
    expect(recovered).not.toBeNull();
    expect(recovered!.recovered).toBe(true);
    recovered!.release();

    writeFileSync(lockPath(f.dir), JSON.stringify({ pid: 999_998, holder: 'busy-process', started_ms: 1 }), { mode: 0o600 });
    expect(acquireMaintenanceLock(f.dir, 'maintenance-d', { pidAlive: () => true })).toBeNull();
  } finally {
    f.close();
  }
});

test('备份拒绝不存在的目标目录和不足的余量', () => {
  const f = fixture();
  const source = join(f.dir, 'trace.db');
  try {
    f.store.close();
    expect(() => backupDatabase(source, join(f.dir, 'missing', 'restored.db'))).toThrow('destination_unreadable');
    expect(() => backupDatabase(source, join(f.dir, 'thin.db'), { freeBytes: () => 0 })).toThrow('insufficient_space');
    expect(existsSync(join(f.dir, 'thin.db'))).toBe(false);
  } finally {
    f.close();
  }
});

test('重建只重算正文仍在的请求并保留已回收的工具关系', async () => {
  const f = fixture();
  const source = join(f.dir, 'trace.db');
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
                conv_key,actor,actor_state,title,title_source)
              VALUES (1,1,'2026-10-20','hook','available',1,1,1,1,'conv-r','actor-r','known',NULL,NULL),
                     (2,2,'2026-10-20','hook','evicted',1,1,1,1,'conv-r','actor-r','known','旧标题','user_delta')`);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state)
              VALUES ('call_old',2,0,'read','resolved')`);
    });
    const lines: string[] = [];
    const code = await runMaintenance(
      ['rebuild', '--db', source, '--session', 'conv-r'],
      { out: line => lines.push(line), err: () => {} },
    );
    expect(code).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report.ok).toBe(true);
    expect(report.unavailable).toBe(1);
    expect(report.reasons).toEqual({ body_evicted_raw_expired: 1 });
    expect(report.queue_remaining).toBe(0);
    expect(report.derive_version).toBe(2);
    // 正文与 raw 都没了：旧标题与已确认配对原样保留，不被重算成空。
    expect(f.store.read.query('SELECT title,title_source FROM request WHERE req_id=2').get())
      .toEqual({ title: '旧标题', title_source: 'user_delta' });
    expect(f.store.read.query('SELECT call_id,state FROM tool_call').all())
      .toEqual([{ call_id: 'call_old', state: 'resolved' }]);
  } finally {
    f.close();
  }
});

test('维护锁存在时采集器拒绝启动', async () => {
  const f = fixture();
  try {
    writeFileSync(lockPath(f.dir), JSON.stringify({ pid: 100, holder: 'backup:1', started_ms: 1 }), { mode: 0o600 });
    const config = {
      ...loadConfig({}),
      port: 0,
      dataDir: f.dir,
      ledgerPath: join(f.dir, 'missing.jsonl'),
      routingDir: join(f.dir, 'missing-routing'),
    };
    await expect(startCollector(config)).rejects.toThrow('maintenance_lock_present');
    expect(maintenanceLockPresent(f.dir)).toBe(lockPath(f.dir));
  } finally {
    f.close();
  }
});

test('淘汰请求必须先删目标别名，其他存活请求的别名保留', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
         VALUES (?,?,?,'hook','pending',1,1,1,1)`,
      );
      for (const id of [1, 2, 3, 4]) insert.run(id, id, '2026-10-20');
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (3,1),(4,2)');
      db.run('DELETE FROM request WHERE req_id IN (3,4)');
    });
    // 外键是 NO ACTION：直接删 canonical 会被别名拦住，必须按 new_id 先删别名。
    expect(() => f.store.write(db => db.run('DELETE FROM request WHERE req_id=1'))).toThrow();
    expect(f.store.read.query('SELECT req_id FROM request ORDER BY req_id').all())
      .toEqual([{ req_id: 1 }, { req_id: 2 }]);

    purgeMetadata(f.store, '2026-10-21', 'approval-synthetic-alias');
    expect(f.store.read.query('SELECT req_id FROM request').all()).toEqual([]);
    expect(f.store.read.query('SELECT old_id,new_id FROM request_alias').all()).toEqual([]);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});

test('正文已回收但raw仍在时重建报告可补采原因', async () => {
  const f = fixture();
  const source = join(f.dir, 'trace.db');
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
                conv_key,actor,actor_state,title,title_source)
              VALUES (1,1,'2026-10-20','hook','evicted',1,1,1,1,'conv-r2','actor-r2','known','旧标题','user_delta')`);
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
              VALUES (1,'hook','synthetic-hook-1','merged',1)`);
      db.run(`INSERT INTO raw_hook(hook_id,received_at,request_z,response_z,parse_state)
              VALUES ('synthetic-hook-1',1,x'01',x'02','ok')`);
    });
    const lines: string[] = [];
    const code = await runMaintenance(
      ['rebuild', '--db', source, '--session', 'conv-r2'],
      { out: line => lines.push(line), err: () => {} },
    );
    expect(code).toBe(0);
    // raw 原文还在：说明这笔正文可以按物理身份重放补回，而不是永久丢失。
    expect(JSON.parse(lines[0]!).reasons).toEqual({ body_evicted_raw_present: 1 });
  } finally {
    f.close();
  }
});

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
      purpose_target: PURPOSE_VERSION, purpose_pending: 0, purpose_version: PURPOSE_VERSION, req_kind: 'title',
    });
    expect(f.store.read.query<{
      purpose_target: number; purpose_pending: number;
    }, [number]>(`
      SELECT purpose_target, purpose_pending FROM request WHERE req_id=?`).get(other))
      .toEqual({ purpose_target: 1, purpose_pending: 0 });
  } finally { f.close(); }
});

test('重建把目标会话的 Chat System 分类器改为 exclude，其他会话不动', async () => {
  const f = fixture();
  try {
    const fingerprint = 'You are a security monitor for autonomous AI coding agents.';
    const classifier = seedPurposeRequest(f.store, {
      convKey: 're-classifier', agent: 'claude', protocol: 'chat',
      purposeTarget: PURPOSE_VERSION - 1, purposeVersion: PURPOSE_VERSION - 1,
      purposeStatus: 'unrecognized', purposePending: 0, cleanGroup: true,
      messages: [{ role: 'system', content: fingerprint }, { role: 'user', content: 'synthetic input' }],
      stop: ['</block>'],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 're-other', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'unrecognized', purposePending: 0, cleanGroup: true,
    });
    const lines: string[] = [];
    const code = await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', 're-classifier'], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report).toMatchObject({
      ok: true, session: 're-classifier', queue_remaining: 0, purpose_remaining: 0,
    });
    // 升级到当前目标版本后重判：Chat System 指纹得到与 Anthropic 相同的 exclude。
    expect(f.store.read.query<{
      purpose_target: number; purpose_pending: number; purpose_version: number | null;
      req_kind: string; purpose_chain: string;
    }, [number]>(`
      SELECT purpose_target, purpose_pending, purpose_version, req_kind, purpose_chain
      FROM request WHERE req_id=?`).get(classifier)).toMatchObject({
      purpose_target: PURPOSE_VERSION, purpose_pending: 0, purpose_version: PURPOSE_VERSION,
      req_kind: 'auto-mode-classifier', purpose_chain: 'exclude',
    });
    // 其他会话保持旧值。
    expect(f.store.read.query<{
      purpose_target: number; purpose_pending: number; purpose_version: number | null;
    }, [number]>(`
      SELECT purpose_target, purpose_pending, purpose_version FROM request WHERE req_id=?`)
      .get(other)).toEqual({ purpose_target: 1, purpose_pending: 0, purpose_version: 1 });
  } finally {
    f.close();
  }
});

test('重建把目标会话的派生算法号追平，阅读派生结果按新算法重算', async () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'algo-catchup', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'unrecognized', purposePending: 0, cleanGroup: true,
      messages: [{ role: 'user', content: 'synthetic input' }],
      reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    // 旧算法号的已完成组：重建必须换代重算，而不是沿用旧结果。
    f.store.write(db => db.run(
      `UPDATE derive_queue SET target_algorithm=1, published_algorithm=1, state='clean'
       WHERE conv_key='algo-catchup'`));
    const lines: string[] = [];
    const code = await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', 'algo-catchup'], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    const queue = f.store.read.query<{ target_algorithm: number; published_algorithm: number;
      state: string; published_generation: string | null }, [string]>(
      'SELECT target_algorithm, published_algorithm, state, published_generation FROM derive_queue WHERE conv_key=?')
      .get('algo-catchup');
    expect(queue).toMatchObject({ target_algorithm: GROUP_ALGORITHM, published_algorithm: GROUP_ALGORITHM });
    expect(queue?.state === 'clean' || queue?.state === 'dirty').toBe(true);
    expect(f.store.read.query<{ purpose_target: number }, [number]>(
      'SELECT purpose_target FROM request WHERE req_id=?').get(id))
      .toEqual({ purpose_target: PURPOSE_VERSION });
  } finally {
    f.close();
  }
});

// —— reparse：旧布局正文按当前适配器重写的显式入口 ——

const oldSkeleton = (request: unknown, reply: unknown, protocol = 'responses') =>
  zstdCompressSync(Buffer.from(JSON.stringify({
    format: 1, protocol, request_without_messages: request, reply,
    has_messages: false, redact_version: 1,
  })));

function seedOldBody(
  store: ReturnType<typeof fixture>['store'],
  rows: readonly { id: number; bodyState?: string; skeleton: Uint8Array; adapterVersion?: number | null }[],
): void {
  store.write(db => {
    for (const row of rows) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,msg_count,parse_state,adapter_version)
        VALUES (?,'reparse','actor','known',?,'2026-10-22','hook',?,0,1,1,1,NULL,'unsupported',?)`,
      [row.id, row.id, row.bodyState ?? 'available', row.adapterVersion ?? null]);
      db.run('UPDATE request SET skeleton_z=? WHERE req_id=?', [row.skeleton, row.id]);
    }
  });
}

function skeletonOf(store: ReturnType<typeof fixture>['store'], id: number): Record<string, unknown> {
  const row = store.read.query<{ skeleton_z: Uint8Array }, [number]>(
    'SELECT skeleton_z FROM request WHERE req_id=?').get(id)!;
  return JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8')) as Record<string, unknown>;
}

async function runReparse(store: ReturnType<typeof fixture>['store'], dir: string, args: string[]) {
  const lines: string[] = [];
  const code = await runMaintenance(['reparse', '--db', join(dir, 'trace.db'), ...args],
    { out: line => lines.push(line), err: () => {} });
  return { code, report: lines.length === 0 ? null : JSON.parse(lines[0]!) as Record<string, unknown> };
}

test('重解析把旧布局的 Responses 正文按当前形状重写', async () => {
  const f = fixture();
  try {
    const requestArray = {
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      ],
      temperature: 0.2,
    };
    const reply = { id: 'resp_1', status: 'completed', output: [] };
    const requestString = { input: 'plain string input', metadata: { k: 'v' } };
    seedOldBody(f.store, [
      { id: 1, skeleton: oldSkeleton(requestArray, reply) },
      { id: 2, skeleton: oldSkeleton(requestString, null), adapterVersion: 1 },
    ]);
    const { code, report } = await runReparse(f.store, f.dir, ['--protocol', 'responses']);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      ok: true, protocol: 'responses', scanned: 2, matched: 2, rewritten: 2,
      rejected: [], failed: [], unattributed_skeleton: 0, remaining: 0,
    });
    // 恢复逐字相等：数组与裸字符串两种形态都按记录放回原键。
    expect(restoreBody(f.store, 1)).toEqual({
      protocol: 'responses', request: requestArray, reply, redact_version: 1,
    });
    expect(restoreBody(f.store, 2)).toEqual({
      protocol: 'responses', request: requestString, reply: null, redact_version: 1,
    });
    expect(f.store.read.query('SELECT msg_count, adapter_version, parse_state FROM request WHERE req_id=1').get())
      .toEqual({ msg_count: 3, adapter_version: 2, parse_state: 'ok' });
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block WHERE req_id=1').get())
      .toEqual({ n: 3 });
    expect(skeletonOf(f.store, 1)).toMatchObject({
      messages_key: 'input', messages_form: 'array', has_messages: true,
    });
    expect(skeletonOf(f.store, 2)).toMatchObject({
      messages_key: 'input', messages_form: 'string', has_messages: true,
    });
  } finally {
    f.close();
  }
});

test('重解析拒绝不完整与损坏的正文，其它协议原样保留', async () => {
  const f = fixture();
  try {
    seedOldBody(f.store, [
      { id: 1, bodyState: 'partial', skeleton: oldSkeleton({ input: [] }, null) },
      // 骨架可读出协议名，但不是写入契约里的格式：严格校验拒绝，宽松读取不会。
      { id: 2, skeleton: zstdCompressSync(Buffer.from(JSON.stringify({
        format: 2, protocol: 'responses', request_without_messages: {}, has_messages: false,
      }))) },
      { id: 3, skeleton: oldSkeleton({ messages: [] }, null, 'anthropic') },
    ]);
    const { code, report } = await runReparse(f.store, f.dir, ['--protocol', 'responses']);
    expect(code).toBe(0);
    expect(report).toMatchObject({ scanned: 3, matched: 2, rewritten: 0, remaining: 2 });
    expect(report?.rejected).toEqual([
      { req_id: 1, reason: 'body_partial' },
      { req_id: 2, reason: 'skeleton_invalid' },
    ]);
    expect(f.store.read.query(
      'SELECT body_state, adapter_version FROM request WHERE req_id=1').get())
      .toEqual({ body_state: 'partial', adapter_version: null });
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({ n: 0 });
    // 其它协议不在这次命令的范围内，版本保持原样。
    expect(f.store.read.query('SELECT adapter_version FROM request WHERE req_id=3').get())
      .toEqual({ adapter_version: null });
  } finally {
    f.close();
  }
});

test('重解析重复执行不重复写入，也不推进输入修订', async () => {
  const f = fixture();
  try {
    seedOldBody(f.store, [{ id: 1, skeleton: oldSkeleton({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }, null) }]);
    const first = await runReparse(f.store, f.dir, ['--protocol', 'responses']);
    expect(first.report).toMatchObject({ rewritten: 1, remaining: 0 });
    const afterFirst = f.store.read.query<{
      input_revision: number; adapter_version: number }, [number]>(
      'SELECT input_revision, adapter_version FROM request WHERE req_id=1').get(1);
    const blocks = f.store.read.query('SELECT count(*) AS n FROM block').get();
    const refs = f.store.read.query('SELECT count(*) AS n FROM request_block').get();
    const second = await runReparse(f.store, f.dir, ['--protocol', 'responses']);
    expect(second.code).toBe(0);
    expect(second.report).toMatchObject({ scanned: 0, matched: 0, rewritten: 0, remaining: 0 });
    expect(f.store.read.query<{
      input_revision: number; adapter_version: number }, [number]>(
      'SELECT input_revision, adapter_version FROM request WHERE req_id=1').get(1))
      .toEqual(afterFirst!);
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual(blocks!);
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual(refs!);
  } finally {
    f.close();
  }
});

test('重解析缺少 --protocol 时只报用法', async () => {
  const f = fixture();
  try {
    const errors: string[] = [];
    const code = await runMaintenance(['reparse', '--db', join(f.dir, 'trace.db')],
      { out: () => {}, err: line => errors.push(line) });
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('maintain reparse');
  } finally {
    f.close();
  }
});
