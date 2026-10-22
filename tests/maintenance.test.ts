import { expect, test } from 'bun:test';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { openStore } from '../src/store';
import {
  acquireMaintenanceLock,
  lockPath,
  maintenanceLockPresent,
  backupDatabase,
  previewMetadataPurge,
  purgeMetadata,
  runMaintenance,
  verifyDatabase,
} from '../src/maintenance';
import { loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { persistBody } from '../src/body';
import { GROUP_ALGORITHM } from '../src/derive-state';

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
    expect(await runMaintenance(['nope'])).toBe(2);
  } finally {
    f.close();
  }
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
