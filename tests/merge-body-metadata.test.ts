import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { mergeRequestTx } from '../src/merge';
import { HAVE_BODY, HAVE_LEDGER } from '../src/evidence';
import type { Store } from '../src/store';

type Seed = {
  bodyState: string;
  have: number;
  skeleton?: Uint8Array | null;
  bodyBytes?: number | null;
  redactVersion?: number | null;
  parseState?: string | null;
  replyState?: string | null;
  adapterVersion?: number | null;
  msgCount?: number | null;
  missReason?: string | null;
};

function seedRequest(store: Store, reqId: number, via: 'through' | 'hook', seed: Seed): void {
  store.write(db => {
    db.run(`
      INSERT INTO request(req_id,agent,conv_key,conv_source,session,actor,actor_state,started_ms,day,via,
        body_state,skeleton_z,body_bytes,redact_version,parse_state,reply_state,adapter_version,msg_count,
        miss_reason,derive_version,have,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'2026-10-31',?,?,?,?,?,?,?,?,?,?,0,?,1,1)`,
    [
      reqId, 'synthetic-agent', JSON.stringify(['session', 'synthetic-session']), 'session',
      'synthetic-session', 'synthetic-session', 'known', 1_000 + reqId, via,
      seed.bodyState, seed.skeleton ?? null, seed.bodyBytes ?? null, seed.redactVersion ?? null,
      seed.parseState ?? null, seed.replyState ?? null, seed.adapterVersion ?? null,
      seed.msgCount ?? null, seed.missReason ?? null, seed.have,
    ]);
  });
}

function rowOf(store: Store, reqId: number) {
  return store.read.query<{
    body_state: string; skeleton_z: Uint8Array | null; body_bytes: number | null;
    redact_version: number | null; parse_state: string | null; reply_state: string | null;
    adapter_version: number | null; msg_count: number | null; miss_reason: string | null; have: number;
  }, [number]>(`
    SELECT body_state,skeleton_z,body_bytes,redact_version,parse_state,reply_state,
      adapter_version,msg_count,miss_reason,have
    FROM request WHERE req_id=?`).get(reqId) ?? null;
}

test('合并搬正文时一并搬 body_bytes 与 redact_version 等正文元数据', () => {
  const f = fixture();
  try {
    const skeleton = new Uint8Array([1, 2, 3, 4]);
    seedRequest(f.store, 1, 'through', { bodyState: 'pending', have: HAVE_LEDGER });
    seedRequest(f.store, 2, 'hook', {
      bodyState: 'available', have: HAVE_BODY, skeleton, bodyBytes: 4096, redactVersion: 1,
      parseState: 'ok', replyState: 'ok', adapterVersion: 7, msgCount: 3,
    });

    f.store.write(db => mergeRequestTx(db, 2, 1, 100));

    const row = rowOf(f.store, 1)!;
    expect({
      body_state: row.body_state,
      body_bytes: row.body_bytes,
      redact_version: row.redact_version,
      parse_state: row.parse_state,
      reply_state: row.reply_state,
      adapter_version: row.adapter_version,
      msg_count: row.msg_count,
      miss_reason: row.miss_reason,
    }).toEqual({
      body_state: 'available',
      body_bytes: 4096,
      redact_version: 1,
      parse_state: 'ok',
      reply_state: 'ok',
      adapter_version: 7,
      msg_count: 3,
      miss_reason: null,
    });
    expect(Buffer.from(row.skeleton_z!).equals(Buffer.from(skeleton))).toBe(true);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request WHERE req_id=2').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('目标已有正文时保持目标正文与元数据，不被源行覆盖', () => {
  const f = fixture();
  try {
    const targetBody = new Uint8Array([9, 9]);
    const sourceBody = new Uint8Array([1, 2, 3]);
    seedRequest(f.store, 1, 'through', {
      bodyState: 'available', have: HAVE_BODY, skeleton: targetBody, bodyBytes: 111,
      redactVersion: 9, parseState: 'ok', replyState: 'ok', adapterVersion: 5, msgCount: 2,
    });
    seedRequest(f.store, 2, 'hook', {
      bodyState: 'available', have: HAVE_BODY, skeleton: sourceBody, bodyBytes: 4096, redactVersion: 1,
      parseState: 'ok', replyState: 'ok', adapterVersion: 7, msgCount: 3,
    });

    f.store.write(db => mergeRequestTx(db, 2, 1, 100));

    const row = rowOf(f.store, 1)!;
    expect(row.body_bytes).toBe(111);
    expect(row.redact_version).toBe(9);
    expect(row.adapter_version).toBe(5);
    expect(row.msg_count).toBe(2);
    expect(Buffer.from(row.skeleton_z!).equals(Buffer.from(targetBody))).toBe(true);
  } finally {
    f.close();
  }
});

test('源行有正文证据但无骨架时目标不再停留在 pending', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, 'through', { bodyState: 'pending', have: HAVE_LEDGER });
    seedRequest(f.store, 2, 'hook', {
      bodyState: 'partial', have: HAVE_BODY, skeleton: null, missReason: 'disk_body_paused',
    });

    f.store.write(db => mergeRequestTx(db, 2, 1, 100));

    // 正文仍不可读：没有骨架的事实不变，只把状态与原因纠正为 partial。
    expect(rowOf(f.store, 1)).toMatchObject({
      body_state: 'partial',
      skeleton_z: null,
      body_bytes: null,
      miss_reason: 'disk_body_paused',
      have: HAVE_LEDGER | HAVE_BODY,
    });
  } finally {
    f.close();
  }
});

test('合并失败时整个调用方事务回滚，源行与目标行保持原状', () => {
  const f = fixture();
  try {
    const sourceBody = new Uint8Array([7, 7]);
    seedRequest(f.store, 1, 'through', { bodyState: 'pending', have: HAVE_LEDGER });
    seedRequest(f.store, 2, 'hook', {
      bodyState: 'available', have: HAVE_BODY, skeleton: sourceBody, bodyBytes: 512, redactVersion: 1,
    });

    expect(() => f.store.write(db => {
      mergeRequestTx(db, 2, 1, 100);
      throw new Error('synthetic_rollback');
    })).toThrow('synthetic_rollback');

    expect(rowOf(f.store, 1)).toMatchObject({
      body_state: 'pending', skeleton_z: null, body_bytes: null, redact_version: null, have: HAVE_LEDGER,
    });
    expect(rowOf(f.store, 2)).toMatchObject({
      body_state: 'available', body_bytes: 512, redact_version: 1, have: HAVE_BODY,
    });
  } finally {
    f.close();
  }
});
