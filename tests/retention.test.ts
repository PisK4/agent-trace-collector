import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { openStore } from '../src/store';
import { persistBody, persistBodyTx, restoreBody } from '../src/body';
import {
  EVICT_TARGET_RATIO,
  admission,
  createAdmissionGate,
  closeSourceGapsTx,
  enforceBodyBudget,
  evictOldestBodyBatch,
  measureStorage,
  pruneRaw,
  recordPausedBatch,
  resumeSourceGaps,
  shrinkStorage,
} from '../src/retention';
import type { StorageUsage } from '../src/retention';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';

const MiB = 1024 * 1024;

test('回收旧请求保留共享块和历史读数', () => {
  const f = fixture();
  try {
    for (const [id, day] of [[1, '2026-10-19'], [2, '2026-10-20']] as const) {
      f.store.db.run(
        "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,in_tok) VALUES (?,?,?,'through','pending',1,7,1,1,10)",
        [id, id, day],
      );
    }
    const body = {
      protocol: 'chat',
      request: { messages: [{ role: 'user', content: 'shared' }] },
      reply: { id: 'chatcmpl_demo', choices: [] },
      redact_version: 1,
    };
    persistBody(f.store, 1, body);
    persistBody(f.store, 2, body);
    const result = evictOldestBodyBatch(f.store, 1000, 1);
    expect(result.requests).toBe(1);
    expect(result.day).toBe('2026-10-19');
    expect(f.store.read.query('SELECT req_id,have,in_tok,body_state FROM request ORDER BY req_id').all()).toEqual([
      { req_id: 1, have: 7, in_tok: 10, body_state: 'evicted' },
      { req_id: 2, have: 7, in_tok: 10, body_state: 'available' },
    ]);
    expect(restoreBody(f.store, 2)).toEqual(body);
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('回收不动没有正文的pending请求且记录原状态', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
         VALUES (1,1,'2026-10-18','hook','pending',0,1,1,1),
                (2,2,'2026-10-19','hook','pending',0,1,1,1)`,
      );
      persistBodyTx(db, 2, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
        reply: { id: 'msg_keep', content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
    });
    const result = evictOldestBodyBatch(f.store, 2000, 10);
    expect(result).toEqual({ requests: 1, blocks: 1, releasedLogicalBytes: expect.any(Number), day: '2026-10-19' });
    const rows = f.store.read.query<{ req_id: number; body_state: string; body_prev_state: string | null }, []>(
      'SELECT req_id, body_state, body_prev_state FROM request ORDER BY req_id').all();
    expect(rows).toEqual([
      { req_id: 1, body_state: 'pending', body_prev_state: null },
      { req_id: 2, body_state: 'evicted', body_prev_state: 'available' },
    ]);
    // 再回收一次不覆盖原状态。
    evictOldestBodyBatch(f.store, 3000, 10);
    expect(f.store.read.query('SELECT body_prev_state FROM request WHERE req_id=2').get()).toEqual({
      body_prev_state: 'available',
    });
  } finally {
    f.close();
  }
});

test('回收批按天与请求号从旧到新且块反连接走索引', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const insert = db.prepare(
        "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (?,?,?,'hook','pending',0,1,1,1)",
      );
      for (const [id, started, day] of [[1, 5, '2026-10-20'], [2, 9, '2026-10-19'], [3, 7, '2026-10-19']] as const) {
        insert.run(id, started, day);
      }
      for (const id of [1, 2, 3]) {
        persistBodyTx(db, id, {
          protocol: 'anthropic',
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: `q${id}` }] }] },
          reply: { id: `msg_${id}`, content: [] },
          redact_version: 1,
        });
      }
    });
    // 同一天里按 started_ms 排，不按插入顺序：req 3 虽然后插入，时间更早。
    evictOldestBodyBatch(f.store, 4000, 1);
    const evicted = f.store.read.query<{ req_id: number }, []>(
      "SELECT req_id FROM request WHERE body_state='evicted' ORDER BY req_id").all();
    expect(evicted).toEqual([{ req_id: 3 }]);

    f.store.db.exec('CREATE TEMP TABLE IF NOT EXISTS evict_blocks(block_id INTEGER PRIMARY KEY)');
    const plan = f.store.db.query(
      `EXPLAIN QUERY PLAN
       SELECT IFNULL(SUM(length(z)),0) FROM block
       WHERE id IN (SELECT block_id FROM evict_blocks)
         AND NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=block.id)`,
    ).all() as { detail: string }[];
    const details = plan.map(row => row.detail).join(' | ');
    expect(details).toContain('i_rb_block');
  } finally {
    f.close();
  }
});

function usageAt(ratio: number, overrides: Partial<StorageUsage> = {}): StorageUsage {
  return {
    body_bytes: 0, db_bytes: 0, wal_bytes: 0, temp_bytes: 0, other_bytes: 0,
    total_bytes: Math.round(16_000_000_000 * ratio), free_bytes: 500_000_000_000,
    page_count: 0, freelist_count: 0,
    ...overrides,
  };
}

test('预算门槛带滞回：80%只接元数据、95%暂停、回落到75/90才恢复', () => {
  const limits = { bodyBudget: 10_000_000_000, diskLimit: 16_000_000_000 };
  expect(admission(usageAt(0.79), limits, 0, 'normal')).toEqual({ mode: 'normal', reason: null });
  expect(admission(usageAt(0.80), limits, 0, 'normal')).toEqual({ mode: 'metadata_only', reason: 'disk_budget' });
  expect(admission(usageAt(0.94), limits, 0, 'normal')).toEqual({ mode: 'metadata_only', reason: 'disk_budget' });
  expect(admission(usageAt(0.95), limits, 0, 'normal')).toEqual({ mode: 'paused', reason: 'disk_budget' });
  // 从暂停回落：90% 仍暂停，89% 放到只接元数据，75% 以下恢复正常。
  expect(admission(usageAt(0.90), limits, 0, 'paused')).toEqual({ mode: 'paused', reason: 'disk_budget' });
  expect(admission(usageAt(0.89), limits, 0, 'paused')).toEqual({ mode: 'metadata_only', reason: 'disk_budget' });
  expect(admission(usageAt(0.74), limits, 0, 'paused')).toEqual({ mode: 'normal', reason: null });
  // 元数据模式自己也有滞回，不会在 75%~80% 之间来回跳。
  expect(admission(usageAt(0.76), limits, 0, 'metadata_only')).toEqual({ mode: 'metadata_only', reason: 'disk_budget' });
  expect(admission(usageAt(0.74), limits, 0, 'metadata_only')).toEqual({ mode: 'normal', reason: null });
});

test('正文预算与写前余量也参与admission', () => {
  const limits = { bodyBudget: 10_000_000_000, diskLimit: 16_000_000_000 };
  const atBodyLimit = usageAt(0.3, { body_bytes: 9_900_000_000 });
  expect(admission(atBodyLimit, limits, 200_000_000, 'normal')).toEqual({
    mode: 'metadata_only', reason: 'body_budget',
  });
  // 从正文预算回落时留 10% 余量。
  const bodyFreed = usageAt(0.3, { body_bytes: 9_100_000_000 });
  expect(admission(bodyFreed, limits, 0, 'metadata_only')).toEqual({ mode: 'metadata_only', reason: 'body_budget' });
  expect(admission(usageAt(0.3, { body_bytes: 8_900_000_000 }), limits, 0, 'metadata_only')).toEqual({
    mode: 'normal', reason: null,
  });

  // 本批上界越大，要求的写前余量越大：256 MiB 是下限，2 倍批次上界会顶上来。
  const tight = usageAt(0.2, { free_bytes: 300 * MiB });
  expect(admission(tight, limits, 0, 'normal').mode).toBe('normal');
  // 2 × 200 MiB = 400 MiB 越过 256 MiB 下限，这一批就不该收了。
  expect(admission(tight, limits, 200 * MiB, 'normal')).toEqual({ mode: 'paused', reason: 'disk_free' });
});

test('回收后物理文件确实收缩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-shrink-'));
  const store = openStore(join(dir, 'trace.db'));
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = measureStorage(store, dir);
    store.write(db => {
      db.run('CREATE TABLE shrink_probe(id INTEGER PRIMARY KEY,z BLOB)');
      const insert = db.prepare('INSERT INTO shrink_probe(z) VALUES (?)');
      for (let i = 0; i < 256; i++) insert.run(crypto.getRandomValues(new Uint8Array(32768)));
    });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const full = measureStorage(store, dir);
    store.write(db => db.run('DROP TABLE shrink_probe'));
    for (let i = 0; i < 128; i++) {
      const row = store.db.query('PRAGMA freelist_count').get() as { freelist_count: number };
      if (row.freelist_count === 0) break;
      store.db.exec('PRAGMA incremental_vacuum(256)');
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = measureStorage(store, dir);
    expect(full.db_bytes).toBeGreaterThan(before.db_bytes);
    expect(after.total_bytes).toBeLessThan(full.total_bytes);
    expect(EVICT_TARGET_RATIO).toBeLessThan(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('物理计量只算数据目录里的普通文件，不跟随符号链接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-measure-'));
  const outside = mkdtempSync(join(tmpdir(), 'collector-outside-'));
  const store = openStore(join(dir, 'trace.db'));
  try {
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'collector.log'), 'x'.repeat(4096));
    const before = measureStorage(store, dir);
    expect(before.other_bytes).toBeGreaterThanOrEqual(4096);
    expect(before.db_bytes).toBeGreaterThan(0);
    expect(before.total_bytes).toBe(before.db_bytes + before.wal_bytes + before.temp_bytes + before.other_bytes);
    expect(before.free_bytes).toBeGreaterThan(0);

    writeFileSync(join(outside, 'huge.bin'), 'y'.repeat(100_000));
    symlinkSync(join(outside, 'huge.bin'), join(dir, 'huge.bin'));
    const after = measureStorage(store, dir);
    expect(after.other_bytes).toBe(before.other_bytes);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('shrinkStorage在无可回收页时也不报错', () => {
  const f = fixture();
  try {
    expect(() => shrinkStorage(f.store)).not.toThrow();
    expect(measureStorage(f.store, f.dir).page_count).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});

test('原始层过期先标证据再删原文，长期读数不动', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,attempt_in,attempt_out,attempt_billed)
         VALUES (1,1,'2026-10-01','through','pending',1,7,1,1,11,22,1),
                (2,2,'2026-10-20','through','pending',1,7,1,1,33,44,1)`,
      );
      const ledger = db.prepare(
        `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json,route_id)
         VALUES ('file','g:0',?,?,?,'through','{}',7)`,
      );
      ledger.run(0, '2026-10-01T00:00:00Z', 10);
      ledger.run(5, '2026-10-20T00:00:00Z', 1000);
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
              VALUES (1,'ledger',?,'merged',1)`, [JSON.stringify(['file', 'g:0', 0])]);
      db.run(`INSERT INTO raw_route(route_id,time_ms,day,payload_json) VALUES (7,10,'2026-10-01','{}'),(8,1000,'2026-10-20','{}')`);
      db.run(`INSERT INTO raw_hook(hook_id,received_at,parse_state) VALUES ('hook-old',10,'ok'),('hook-new',1000,'ok')`);
    });
    const pruned = pruneRaw(f.store, 100, 100);
    expect(pruned).toEqual({ ledger: 1, route: 1, hook: 1, otlpSpan: 0, otlpLog: 0 });
    expect(f.store.read.query('SELECT route_id FROM raw_ledger ORDER BY route_id').all()).toEqual([{ route_id: 7 }]);
    expect(f.store.read.query('SELECT route_id FROM raw_route ORDER BY route_id').all()).toEqual([{ route_id: 8 }]);
    expect(f.store.read.query('SELECT hook_id FROM raw_hook ORDER BY hook_id').all()).toEqual([{ hook_id: 'hook-new' }]);
    expect(f.store.read.query('SELECT ref_key,payload_state FROM request_evidence').all()).toEqual([
      { ref_key: JSON.stringify(['file', 'g:0', 0]), payload_state: 'expired' },
    ]);
    // 长期读数、正文可用性与解析状态不因原始层过期而改写。
    expect(f.store.read.query('SELECT req_id,attempt_in,attempt_out,attempt_billed,have,body_state FROM request ORDER BY req_id').all())
      .toEqual([
        { req_id: 1, attempt_in: 11, attempt_out: 22, attempt_billed: 1, have: 7, body_state: 'pending' },
        { req_id: 2, attempt_in: 33, attempt_out: 44, attempt_billed: 1, have: 7, body_state: 'pending' },
      ]);
  } finally {
    f.close();
  }
});

test('原始层过期在同一事务推进修订，证据族转expired', () => {
  const f = fixture();
  const key = JSON.stringify(['session', 'synthetic-session']);
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,started_ms,day,via,conv_key,conv_source,actor,actor_state,
           body_state,derive_version,have,created_at,updated_at)
         VALUES (1,1,'2026-10-01','through',?,'session','synthetic-session','known','pending',1,7,1,1)`,
        [key],
      );
      db.run(`INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json,route_id,kind)
              VALUES ('file','g:0',0,'2026-10-01T00:00:00Z',10,'through',?,7,'compact')`,
        [JSON.stringify({ t: '2026-10-01T00:00:00Z', route_id: 7, kind: 'compact', status: 200, in: 11 })]);
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
              VALUES (1,'ledger',?,'merged',1)`, [JSON.stringify(['file', 'g:0', 0])]);
    });
    const before = f.store.write(db => projectRequestTx(db, 1, {
      now: 2, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(before.families.selected).toMatchObject({ state: 'complete', current: true });
    const revision = () => f.store.read.query<{ input_revision: number; purpose_pending: number }, []>(
      'SELECT input_revision,purpose_pending FROM request WHERE req_id=1').get()!;
    const beforeRevision = revision();
    // 先把请求的待处理标记清掉：过期本身必须重新把它置位。
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0'));

    expect(pruneRaw(f.store, 100, 100)).toEqual({ ledger: 1, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0 });
    const after = f.store.write(db => projectRequestTx(db, 1, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    // raw 过期不是新的缺失 kind：证据仍在，只是内容读不到，族状态标 expired 且不再 current。
    expect(after.families.selected).toMatchObject({ state: 'expired', current: false });
    expect(after.reasons).toContain('ledger_expired');
    expect(revision()).toEqual({ input_revision: beforeRevision.input_revision + 1, purpose_pending: 1 });
  } finally {
    f.close();
  }
});

test('OTLP 原始层同受 TTL：span 证据转 expired，log 直接删，请求行不动', () => {
  const f = fixture();
  try {
    const traceId = new Uint8Array(16).fill(0xab);
    const spanId = new Uint8Array(8).fill(0xcd);
    const refKey = `${Buffer.from(traceId).toString('hex')}/${Buffer.from(spanId).toString('hex')}`;
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
         VALUES (1,10,'2026-10-01','otlp','summary',0,8,10,10,'otlp_span',?)`,
        [refKey],
      );
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
              VALUES (1,'otlp_span',?,'merged',10)`, [refKey]);
      db.run(
        `INSERT INTO raw_otlp_span(trace_id,span_id,received_at,service,name,start_ms,attributes_json,mapping_version,privacy_version)
         VALUES (?,?,10,'oh-my-pi','chat synth',10,'{}',1,1)`,
        [traceId, spanId],
      );
      db.run(
        `INSERT INTO raw_otlp_log(record_hash,received_at,service,time_ms,body,attributes_json,privacy_version)
         VALUES (?,?,?,?,?,?,1)`,
        [new Uint8Array(32).fill(0x11), 10, 'oh-my-pi', 10, 'omp.log', '{}'],
      );
    });
    const pruned = pruneRaw(f.store, 100, 100);
    expect(pruned).toEqual({ ledger: 0, route: 0, hook: 0, otlpSpan: 1, otlpLog: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_span').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_log').get()).toEqual({ n: 0 });
    // 证据行保留但转 expired；请求行身份（sort_key）与 have 不因原文删除改写。
    expect(f.store.read.query('SELECT ref_key,payload_state FROM request_evidence').all())
      .toEqual([{ ref_key: refKey, payload_state: 'expired' }]);
    expect(f.store.read.query('SELECT via,have,body_state,sort_key FROM request').get())
      .toEqual({ via: 'otlp', have: 8, body_state: 'summary', sort_key: refKey });
  } finally {
    f.close();
  }
});

test('带正文且无法迁移的hook原文不被过期规则删掉', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO raw_hook(hook_id,received_at,parse_state,request_z) VALUES ('hook-body',10,'unsupported',?)`, [
        new Uint8Array([1, 2, 3]),
      ]);
    });
    expect(pruneRaw(f.store, 100, 100)).toEqual({ ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0 });
    expect(f.store.read.query("SELECT hook_id FROM raw_hook WHERE hook_id='hook-body'").get()).toEqual({ hook_id: 'hook-body' });
    expect(f.store.read.query('SELECT reason FROM ingest_issue').all()).toEqual([{ reason: 'raw_hook_body_unlinked' }]);
    // 再跑一次不重复记录。
    pruneRaw(f.store, 100, 100);
    expect(f.store.read.query('SELECT count(*) AS n FROM ingest_issue').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('暂停区间合并成一条缺口，恢复补采后标记补齐', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms,observed_off)
       VALUES ('ledger','usage.jsonl','g:0',100,1,100)`,
    ));
    recordPausedBatch(f.store, {
      source_kind: 'ledger', source_name: 'usage.jsonl', generation: 'g:0', from_off: 100, to_off: 150,
    }, 2);
    recordPausedBatch(f.store, {
      source_kind: 'ledger', source_name: 'usage.jsonl', generation: 'g:0', from_off: 100, to_off: 220,
    }, 3);
    expect(f.store.read.query('SELECT from_off,to_off,state,reason FROM source_gap').all()).toEqual([
      { from_off: 100, to_off: 220, state: 'open', reason: 'disk_paused' },
    ]);
    expect(f.store.read.query('SELECT committed_off,observed_off FROM source_cursor').get()).toEqual({
      committed_off: 100, observed_off: 220,
    });

    expect(resumeSourceGaps(f.store, 'usage.jsonl')).toEqual({ recoverable: 1, unrecoverable: 0 });
    expect(f.store.read.query('SELECT state FROM source_gap').get()).toEqual({ state: 'resumable' });

    f.store.write(db => closeSourceGapsTx(db, 'ledger', 'usage.jsonl', 'g:0', 100, 220, 4));
    expect(f.store.read.query('SELECT state FROM source_gap').get()).toEqual({ state: 'filled' });
  } finally {
    f.close();
  }
});

test('换代后无法补采的缺口保持永久可见', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms,observed_off)
       VALUES ('ledger','usage.jsonl','g:0',100,1,100)`,
    ));
    recordPausedBatch(f.store, {
      source_kind: 'ledger', source_name: 'usage.jsonl', generation: 'g:0', from_off: 100, to_off: 150,
    }, 2);
    f.store.write(db => db.run("UPDATE source_cursor SET file_generation='g:1' WHERE source_name='usage.jsonl'"));
    expect(resumeSourceGaps(f.store, 'usage.jsonl')).toEqual({ recoverable: 0, unrecoverable: 1 });
    expect(f.store.read.query('SELECT state,from_off,to_off FROM source_gap').get()).toEqual({
      state: 'unrecoverable', from_off: 100, to_off: 150,
    });
    // 永久缺口不会被后来的补齐逻辑抹掉。
    f.store.write(db => closeSourceGapsTx(db, 'ledger', 'usage.jsonl', 'g:1', 0, 999, 5));
    expect(f.store.read.query('SELECT state FROM source_gap').get()).toEqual({ state: 'unrecoverable' });
  } finally {
    f.close();
  }
});

test('准入闸门把模式落库，重开后按落库模式继续滞回', () => {
  const f = fixture();
  try {
    const tight = createAdmissionGate(f.store, f.dir, { bodyBudget: 1_000, diskLimit: 200_000 }, {
      ttlMs: 0, clock: () => 1000,
    });
    // 空库本身已超过 200 KB 的 diskLimit：第一次检查就是暂停。
    expect(tight.check(0).mode).toBe('paused');
    expect(f.store.read.query("SELECT value_json FROM collector_state WHERE key LIKE '%retention%'").get())
      .toEqual({ value_json: expect.stringContaining('"mode":"paused"') });

    // 新闸门先从落库的 paused 起算；空间充足时一次越过 75% 恢复线，直接回 normal。
    const roomy = createAdmissionGate(f.store, f.dir, { bodyBudget: 10_000_000_000, diskLimit: 100_000_000_000 }, {
      ttlMs: 0, clock: () => 2000,
    });
    expect(roomy.check(0)).toEqual({ mode: 'normal', reason: null });
  } finally {
    f.close();
  }
});

test('准入闸门按TTL缓存量测，回收后invalidate立刻重算', () => {
  const f = fixture();
  try {
    let now = 1000;
    const gate = createAdmissionGate(f.store, f.dir, { bodyBudget: 10_000_000_000, diskLimit: 100_000_000_000 }, {
      ttlMs: 5000, clock: () => now,
    });
    gate.check(0);
    const first = gate.last();
    expect(first.usage?.page_count).toBeGreaterThan(0);

    // TTL 内复用同一份量测对象：新一轮目录扫描会造出不同对象。
    now += 100;
    gate.check(0);
    gate.check(0);
    expect(gate.last().usage).toBe(first.usage);

    now += 6000;
    gate.check(0);
    expect(gate.last().usage).not.toBe(first.usage);

    const beforeInvalidate = gate.last().usage;
    gate.invalidate();
    gate.check(0);
    expect(gate.last().usage).not.toBe(beforeInvalidate);
  } finally {
    f.close();
  }
});

test('回收正文在同一事务推进修订并标脏所属组', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'synthetic-session']);
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,started_ms,day,via,conv_key,conv_source,actor,actor_state,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,1,'2026-10-18','hook',?,'session','synthetic-session','known','pending',0,1,1,1)`,
      [key],
    ));
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] },
      reply: null,
      redact_version: 1,
    });
    const before = f.store.read.query<{ input_revision: number }, []>(
      'SELECT input_revision FROM request WHERE req_id=1').get()!;
    // 先把组标成 clean：回收必须让它重新 dirty，而不是沿用旧完成记录。
    f.store.write(db => {
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,state,published_revision,published_algorithm)
              VALUES (?,'synthetic-session','','clean',0,1)
              ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean'`, [key]);
    });
    evictOldestBodyBatch(f.store, 1000, 10);
    expect(f.store.read.query<{ body_state: string }, []>(
      'SELECT body_state FROM request WHERE req_id=1').get()).toEqual({ body_state: 'evicted' });
    const after = f.store.read.query<{ input_revision: number }, []>(
      'SELECT input_revision FROM request WHERE req_id=1').get()!;
    expect(after.input_revision).toBeGreaterThan(before.input_revision);
    expect(f.store.read.query<{ state: string }, [string]>(
      'SELECT state FROM derive_queue WHERE conv_key=?').get(key)).toEqual({ state: 'dirty' });
  } finally {
    f.close();
  }
});

test('回收中途失败整体回滚，不留删了引用没标状态的中间态', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      for (const [id, day] of [[1, '2026-10-18'], [2, '2026-10-19']] as const) {
        db.run(
          "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (?,?,?,'hook','pending',0,1,1,1)",
          [id, id, day],
        );
        persistBodyTx(db, id, {
          protocol: 'anthropic',
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: `q${id}` }] }] },
          reply: { id: `msg_${id}`, content: [] },
          redact_version: 1,
        });
      }
      // 触发器在删块之后、改状态之前打断回收。
      db.exec(`CREATE TRIGGER fail_evict BEFORE UPDATE OF body_state ON request
               WHEN NEW.body_state='evicted' BEGIN SELECT RAISE(ABORT,'injected_evict'); END`);
    });
    expect(() => evictOldestBodyBatch(f.store, 5000, 10)).toThrow();
    // 引用与块都还在，状态没变。
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({ n: 2 });
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 2 });
    expect(f.store.read.query("SELECT count(*) AS n FROM request WHERE body_state='evicted'").get()).toEqual({ n: 0 });
    expect(restoreBody(f.store, 1)).not.toBeNull();

    f.store.write(db => db.run('DROP TRIGGER fail_evict'));
    // 回滚后重试应当正常完成，说明事务没留下坏状态。
    expect(evictOldestBodyBatch(f.store, 6000, 10).requests).toBe(2);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});

test('预算触顶按批回收并失效准入缓存', () => {
  const f = fixture();
  try {
    let invalidated = 0;
    // 未触顶：不回收、不动闸门。
    expect(enforceBodyBudget(f.store, f.dir,
      { bodyBudget: 10 * MiB, diskLimit: 100 * MiB },
      { invalidate: () => { invalidated += 1; } })).toBe(0);
    expect(invalidated).toBe(0);
    f.store.db.run(
      "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,in_tok) VALUES (1,1,'2026-10-19','through','pending',1,7,1,1,10)",
    );
    persistBody(f.store, 1, {
      protocol: 'chat',
      request: { messages: [{ role: 'user', content: 'over budget payload' }] },
      reply: { id: 'chatcmpl_demo', choices: [] },
      redact_version: 1,
    });
    expect(enforceBodyBudget(f.store, f.dir, { bodyBudget: 10, diskLimit: 100 * MiB },
      { invalidate: () => { invalidated += 1; } })).toBe(1);
    expect(invalidated).toBe(1);
    expect(f.store.read.query<{ body_state: string }, []>(
      'SELECT body_state FROM request WHERE req_id=1').get()?.body_state).toBe('evicted');
  } finally {
    f.close();
  }
});
