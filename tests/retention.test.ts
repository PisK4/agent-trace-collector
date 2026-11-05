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
  measureBodyBytes,
  measureStorage,
  pruneRaw,
  pruneRawBounded,
  recordPausedBatch,
  resumeSourceGaps,
  shrinkStorage,
} from '../src/retention';
import type { StorageUsage } from '../src/retention';
import { exactCapacitySums } from '../src/capacity-meter';
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
    page_size: 4096, page_count: 0, freelist_count: 0,
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

test('在线正文量测只读计数行，与全表求和一致且不随规模变慢', () => {
  const f = fixture();
  const blockRows = 88_000;
  const requestRows = 52_000;
  const hookRows = 500;
  const blockBlob = new Uint8Array(64).fill(0x61);
  const skeletonBlob = new Uint8Array(32).fill(0x62);
  try {
    f.store.write(db => {
      const insertBlock = db.prepare('INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)');
      for (let i = 0; i < blockRows; i++) {
        insertBlock.run(
          new Uint8Array([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff]),
          `fp-${i}`, blockBlob, blockBlob.length,
        );
      }
      const insertRequest = db.prepare(
        `INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at,skeleton_z)
         VALUES (?, '2026-11-03', 'hook', 'pending', 0, 1, ?, ?, ?)`,
      );
      for (let i = 0; i < requestRows; i++) insertRequest.run(i, i, i, skeletonBlob);
      const insertHook = db.prepare(
        'INSERT INTO raw_hook(hook_id,received_at,parse_state,request_z,response_z) VALUES (?,?,?,?,?)',
      );
      for (let i = 0; i < hookRows; i++) insertHook.run(`h-${i}`, i, 'ok', blockBlob, blockBlob);
    });

    const exact = exactCapacitySums(f.store.read);
    const exactTotal = exact.block.bytes + exact.request.bytes
      + exact.raw_hook.bytes + exact.raw_session_event.bytes;
    const started = performance.now();
    expect(measureBodyBytes(f.store)).toBe(exactTotal);
    // 目标上限；四行读取不随上面的 14 万行增长。
    expect(performance.now() - started).toBeLessThanOrEqual(5);
    expect(measureStorage(f.store, f.dir).body_bytes).toBe(exactTotal);
  } finally {
    f.close();
  }
});

test('计数在同一写事务提交，读连接立刻看到增量', () => {
  const f = fixture();
  const blob = new Uint8Array(64).fill(1);
  try {
    f.store.write(db => {
      const insert = db.prepare('INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)');
      for (let i = 0; i < 4000; i++) {
        insert.run(new Uint8Array([i & 0xff, (i >> 8) & 0xff]), `fp-${i}`, blob, blob.length);
      }
    });
    const before = measureBodyBytes(f.store);
    const extraBytes = 4096;
    f.store.write(db => db.run(
      'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)',
      [new Uint8Array([9, 9, 9]), 'fp-late', new Uint8Array(extraBytes).fill(7), extraBytes],
    ));
    expect(measureBodyBytes(f.store)).toBe(before + extraBytes);
    expect(exactCapacitySums(f.store.read).block.bytes).toBe(before + extraBytes);
  } finally {
    f.close();
  }
});

test('回收后准入读数直接收敛，invalidate只丢缓存', () => {
  const f = fixture();
  const blob = new Uint8Array(4096).fill(3);
  try {
    f.store.write(db => {
      const insert = db.prepare('INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)');
      insert.run(new Uint8Array([1]), 'fp-a', blob, blob.length);
      insert.run(new Uint8Array([2]), 'fp-b', blob, blob.length);
    });
    expect(measureBodyBytes(f.store)).toBe(8192);
    const gate = createAdmissionGate(f.store, f.dir, { bodyBudget: 10 * MiB, diskLimit: 100 * MiB }, {
      ttlMs: 0, clock: () => 1000,
    });
    gate.check(0);
    f.store.write(db => db.run('DELETE FROM block WHERE hash=?', [new Uint8Array([1])]));
    gate.invalidate();
    expect(gate.check(0).mode).toBe('normal');
    expect(gate.last().usage?.body_bytes).toBe(4096);
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
    expect(pruned).toEqual({
      ledger: 1, route: 1, hook: 1, otlpSpan: 0, otlpLog: 0, session: 0,
    });
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

    expect(pruneRaw(f.store, 100, 100)).toEqual({
      ledger: 1, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 0,
    });
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
    expect(pruned).toEqual({
      ledger: 0, route: 0, hook: 0, otlpSpan: 1, otlpLog: 1, session: 0,
    });
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

test('原始层 TTL：孤儿代际与封口代际可清，追加代际保留重放', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
        line_type,event_at_ms,payload_json,privacy_version)
        VALUES ('claude_session','gen-orphan',0,'s','user',10,'{"a":1}',1),
               ('claude_session','gen-sealed',0,'s','user',10,'{"b":2}',1),
               ('claude_session','gen-live',0,'s','user',10,'{"c":3}',1)`);
      db.run(`INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,
        seen_size,head_len,head_hash,fingerprint,last_ok_ms,rewrite_epoch,observed_off)
        VALUES ('claude_session','/sealed.jsonl.zst','gen-sealed',1,1,0,NULL,'fp-sealed',10,0,1),
               ('claude_session','/live.jsonl','gen-live',1,1,0,NULL,NULL,10,0,1)`);
    });
    expect(pruneRaw(f.store, 100, 100)).toEqual({
      ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 2,
    });
    expect(f.store.read.query(
      'SELECT file_generation FROM raw_session_event ORDER BY file_generation').all())
      .toEqual([{ file_generation: 'gen-live' }]);
    // 追加代际的游标保留，下一批仍能从头重放；封口代际的游标保留，避免重复解压。
    expect(f.store.read.query(
      'SELECT source_kind,source_name,file_generation FROM source_cursor ORDER BY source_name').all())
      .toEqual([
        { source_kind: 'claude_session', source_name: '/live.jsonl', file_generation: 'gen-live' },
        { source_kind: 'claude_session', source_name: '/sealed.jsonl.zst', file_generation: 'gen-sealed' },
      ]);
    const before = f.store.writeStats.count;
    expect(pruneRaw(f.store, 100, 100)).toEqual({
      ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 0,
    });
    expect(f.store.writeStats.count).toBe(before);
  } finally {
    f.close();
  }
});

test('有界清理分批独立提交、批间让出，连续调用收敛到零', async () => {
  const f = fixture();
  try {
    const rows = 620;
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO raw_otlp_span(trace_id,span_id,received_at,service,name,start_ms,attributes_json,mapping_version,privacy_version)
         VALUES (?,?,?,?,?,?,?,1,1)`);
      for (let i = 0; i < rows; i++) {
        const spanId = new Uint8Array(8);
        new DataView(spanId.buffer).setUint32(0, i);
        insert.run(new Uint8Array(16).fill(0xab), spanId, 10, 'oh-my-pi', 'chat synth', 10, '{}');
      }
    });
    const expired = () => f.store.read.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM raw_otlp_span WHERE received_at<100').get()!.n;

    // 单次调用有批数上限：两批 × 每批各表 100 行，停在中途而不是一次清空。
    const first = await pruneRawBounded(f.store, 100, { maxBatches: 2, wallMs: 60_000 });
    expect(first.otlpSpan).toBe(200);
    expect(expired()).toBe(rows - 200);
    // 两批就是两次独立提交的 raw_prune 小事务，不是一个长写事务。
    expect(f.store.writeStats.by_name.raw_prune?.count).toBe(2);

    // 批间让出事件循环：清理期间 setImmediate 链必须获得执行机会。
    let turns = 0;
    let spinning = true;
    (function spin(): void {
      if (!spinning) return;
      turns += 1;
      setImmediate(spin);
    })();
    const second = await pruneRawBounded(f.store, 100, { maxBatches: 2, wallMs: 60_000 });
    spinning = false;
    expect(second.otlpSpan).toBe(200);
    expect(turns).toBeGreaterThanOrEqual(2);

    // 连续调用持续下降直至归零：累计删除等于种子行数。
    let total = first.otlpSpan + second.otlpSpan;
    let last = second.otlpSpan;
    while (last > 0) {
      const next = await pruneRawBounded(f.store, 100, { maxBatches: 2, wallMs: 60_000 });
      total += next.otlpSpan;
      last = next.otlpSpan;
    }
    expect(total).toBe(rows);
    expect(expired()).toBe(0);
    // 620 行 / 每调用 200 行 = 4 次调用；最后一次多一轮空查确认但不落写事务，
    // 共 7 个 raw_prune 写事务。
    expect(f.store.writeStats.by_name.raw_prune?.count).toBe(7);
  } finally {
    f.close();
  }
});

test('单个死代际按行限批清理，不再整代际一次删完', () => {
  const f = fixture();
  try {
    const rows = 250;
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
          line_type,event_at_ms,payload_json,privacy_version)
         VALUES ('claude_session','gen-orphan',?,'s','user',10,? ,1)`);
      for (let i = 0; i < rows; i++) insert.run(i, JSON.stringify({ i }));
    });
    const remaining = () => f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM raw_session_event WHERE file_generation='gen-orphan'").get()!.n;

    const pruned = pruneRaw(f.store, 100, 100);
    expect(pruned.session).toBe(100);
    expect(remaining()).toBe(rows - 100);
  } finally {
    f.close();
  }
});

test('跨调用续取同一死代际，不因代际轮转跳过剩余行', async () => {
  const f = fixture();
  try {
    const rows = 250;
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
          line_type,event_at_ms,payload_json,privacy_version)
         VALUES ('claude_session','gen-orphan',?,'s','user',10,'{}',1)`);
      for (let i = 0; i < rows; i++) insert.run(i);
    });
    const remaining = () => f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM raw_session_event WHERE file_generation='gen-orphan'").get()!.n;

    expect(pruneRaw(f.store, 100, 100).session).toBe(100);
    expect(remaining()).toBe(150);
    expect(await pruneRawBounded(f.store, 100, { maxBatches: 2, wallMs: 60_000 })).toMatchObject({ session: 150 });
    expect(remaining()).toBe(0);
  } finally {
    f.close();
  }
});

test('单个 raw 表按载荷预算截断，不把整批大 payload 一次删完', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
          line_type,event_at_ms,payload_json,privacy_version)
         VALUES ('claude_session','gen-budget',?,'s','user',10,? ,1)`);
      // JSON 字符串长度 42 字节；100 字节预算只容下两行。
      for (let i = 0; i < 10; i++) insert.run(i, 'x'.repeat(40));
    });
    const remaining = () => f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM raw_session_event WHERE file_generation='gen-budget'").get()!.n;

    const pruned = pruneRaw(f.store, 100, 100, 100);
    expect(pruned.session).toBe(2);
    expect(remaining()).toBe(8);
  } finally {
    f.close();
  }
});

function seedOneAvailableBody(f: ReturnType<typeof fixture>): void {
  f.store.write(db => {
    db.run(
      "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,1,'2026-10-19','hook','pending',0,1,1,1)",
    );
    persistBodyTx(db, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'keep synthetic body' }] }] },
      reply: { id: 'msg_keep', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
  });
}

test('磁盘目标不可达时仍独立执行已超限的正文预算', () => {
  const f = fixture();
  try {
    seedOneAvailableBody(f);
    expect(enforceBodyBudget(f.store, f.dir, { bodyBudget: 1, diskLimit: 1 },
      { invalidate: () => {} })).toBe(1);
    expect(f.store.read.query('SELECT body_state FROM request WHERE req_id=1').get())
      .toEqual({ body_state: 'evicted' });
  } finally { f.close(); }
});

test('磁盘触顶先回收空闲页，回到阈值下就不淘汰正文', () => {
  const f = fixture();
  try {
    seedOneAvailableBody(f);
    f.store.write(db => {
      db.exec('CREATE TABLE shrink_seed(z BLOB)');
      const insert = db.prepare('INSERT INTO shrink_seed(z) VALUES (?)');
      for (let i = 0; i < 256; i++) insert.run(crypto.getRandomValues(new Uint8Array(32768)));
    });
    f.store.write(db => db.exec('DROP TABLE shrink_seed'));
    const before = measureStorage(f.store, f.dir);
    expect(before.freelist_count).toBeGreaterThan(0);

    // 触顶但回收空闲页后能回到 80% 以下：不应为磁盘压力删正文。
    const diskLimit = Math.ceil(before.total_bytes / 0.85);
    let invalidated = 0;
    const evicted = enforceBodyBudget(f.store, f.dir,
      { bodyBudget: 1_000_000_000, diskLimit },
      { invalidate: () => { invalidated += 1; } });

    expect(evicted).toBe(0);
    expect(f.store.read.query<{ body_state: string }, []>(
      'SELECT body_state FROM request WHERE req_id=1').get()).toEqual({ body_state: 'available' });
    expect(measureStorage(f.store, f.dir).freelist_count).toBeLessThan(before.freelist_count);
    expect(invalidated).toBe(1);
  } finally {
    f.close();
  }
});

test('磁盘压力用独立目标，按可回收上界继续淘汰而不是每轮只删一批', () => {
  const f = fixture();
  try {
    const requests = 500;
    f.store.write(db => {
      const insert = db.prepare(
        "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (?,?,'2026-10-19','hook','pending',0,1,1,1)");
      for (let i = 1; i <= requests; i++) insert.run(i, i);
      for (let i = 1; i <= requests; i++) {
        // 随机内容保证压缩后仍有约 4 KiB，正文逻辑量能覆盖磁盘缺口。
        const text = `synthetic body ${i} ${Buffer.from(crypto.getRandomValues(new Uint8Array(4096))).toString('base64')}`;
        persistBodyTx(db, i, {
          protocol: 'anthropic',
          request: { messages: [{ role: 'user', content: [{ type: 'text', text }] }] },
          reply: { id: `msg_${i}`, content: [{ type: 'text', text: 'ok' }] },
          redact_version: 1,
        });
      }
    });
    // 撑到约 12 MiB 盘占用：磁盘目标与当前占用差约 1.5 MiB，正文逻辑量约 2 MiB，
    // 旧实现只删一批 100 笔就因子句退出，新实现应继续淘汰到磁盘目标。
    // 先截断 WAL 再定预算：回收循环开头的 checkpoint 会清掉 WAL，否则测到的比例会回落。
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = measureStorage(f.store, f.dir);
    const targetTotal = 12 * MiB;
    if (before.total_bytes < targetTotal) {
      writeFileSync(join(f.dir, 'padding.bin'), Buffer.alloc(targetTotal - before.total_bytes, 1));
    }
    const total = measureStorage(f.store, f.dir);
    const diskLimit = Math.ceil(total.total_bytes / 0.85);
    const evicted = enforceBodyBudget(f.store, f.dir,
      { bodyBudget: 1_000_000_000, diskLimit },
      { invalidate: () => {} });

    expect(evicted).toBeGreaterThan(100);
    expect(f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM request WHERE body_state='available'").get()!.n)
      .toBeLessThan(requests - 100);
  } finally {
    f.close();
  }
});

test('回收统计包含独占块字节，不计仍被引用的共享块', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,skeleton_z)
         VALUES (1,1,'2026-10-19','hook','pending',0,1,1,1,?),
                (2,2,'2026-10-20','hook','pending',0,1,1,1,?)`,
        [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
      );
      db.run(
        `INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES
           (10,?,'fp-shared',?,10),
           (11,?,'fp-only',?,20)`,
        [new Uint8Array([1]), new Uint8Array(10).fill(7), new Uint8Array([2]), new Uint8Array(20).fill(8)],
      );
      db.run('INSERT INTO request_block(req_id,ord,role,block) VALUES (1,0,0,10),(1,1,1,11),(2,0,0,10)');
    });
    const result = evictOldestBodyBatch(f.store, 1000, 1);
    // req 1 的独占块 20 B + 骨架 3 B；共享块仍被 req 2 引用，不计入释放量。
    expect(result).toMatchObject({ requests: 1, blocks: 1, releasedLogicalBytes: 23 });
    expect(f.store.read.query('SELECT id FROM block ORDER BY id').all()).toEqual([{ id: 10 }]);
  } finally {
    f.close();
  }
});

test('准备阶段超出墙钟预算时仍至少提交一批，避免每个 tick 空转', async () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO raw_otlp_span(trace_id,span_id,received_at,service,name,start_ms,attributes_json,mapping_version,privacy_version)
         VALUES (?,?,10,'oh-my-pi','chat synth',10,'{}',1,1)`);
      for (let i = 0; i < 200; i++) {
        const spanId = new Uint8Array(8);
        new DataView(spanId.buffer).setUint32(0, i);
        insert.run(new Uint8Array(16).fill(0xab), spanId);
      }
    });
    // wallMs=0 模拟准备阶段已经耗尽预算：首批仍须执行，否则永远不推进。
    const result = await pruneRawBounded(f.store, 100, { maxBatches: 2, wallMs: 0 });
    expect(result.otlpSpan).toBe(100);
    expect(f.store.writeStats.by_name.raw_prune?.count).toBe(1);
  } finally {
    f.close();
  }
});

test('body 计量纳入会话原始层 payload，按 UTF-8 字节计', () => {
  const f = fixture();
  try {
    const before = measureBodyBytes(f.store);
    const payload = '中'.repeat(1024);
    f.store.write(db => {
      db.run(
        `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
          line_type,event_at_ms,payload_json,privacy_version)
         VALUES ('claude_session','g-f12',0,'s','user',10,?,1)`,
        [payload],
      );
    });
    // TEXT 按字节而不是字符数：1024 个汉字是 3072 字节。
    expect(measureBodyBytes(f.store) - before).toBe(payload.length * 3);
    expect(exactCapacitySums(f.store.read).raw_session_event.bytes).toBe(measureBodyBytes(f.store));
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
    expect(pruneRaw(f.store, 100, 100)).toEqual({
      ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 0,
    });
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

test('准入闸门按TTL缓存量测，invalidate后排一轮后台刷新', () => {
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
