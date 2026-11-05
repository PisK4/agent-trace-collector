import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { HAVE_BODY } from '../src/evidence';
import {
  backfillBodyBytes,
  previewBodyBytesBackfill,
  previewBodyConsistency,
  reclassifyBodyConsistency,
} from '../src/maintenance/body-consistency';
import type { Store } from '../src/store';

type Seed = {
  bodyState: string;
  have: number;
  missReason?: string | null;
  skeleton?: Uint8Array | null;
  bodyBytes?: number | null;
  redactVersion?: number | null;
  msgCount?: number | null;
  agent?: string;
  day?: string;
  startedMs?: number;
};

function seedRequest(store: Store, reqId: number, seed: Seed): void {
  store.write(db => {
    db.run(`
      INSERT INTO request(req_id,agent,started_ms,day,via,body_state,miss_reason,skeleton_z,
        body_bytes,redact_version,msg_count,derive_version,have,created_at,updated_at)
      VALUES (?,?,?,?,'through',?,?,?,?,?,?,0,?,1,1)`,
    [
      reqId, seed.agent ?? 'alpha', seed.startedMs ?? 1_000 + reqId, seed.day ?? '2026-10-31',
      seed.bodyState, seed.missReason ?? null, seed.skeleton ?? null,
      seed.bodyBytes ?? null, seed.redactVersion ?? null, seed.msgCount ?? null, seed.have,
    ]);
  });
}

function rowOf(store: Store, reqId: number) {
  return store.read.query<{
    body_state: string; miss_reason: string | null; skeleton_z: Uint8Array | null;
    body_bytes: number | null; redact_version: number | null; have: number;
    input_epoch: string; input_revision: number;
  }, [number]>(`
    SELECT body_state,miss_reason,skeleton_z,body_bytes,redact_version,have,
      input_epoch,input_revision
    FROM request WHERE req_id=?`).get(reqId) ?? null;
}

function seedBlock(store: Store, id: number, bytes: number): void {
  store.write(db => {
    db.run('INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES (?,?,?,?,?)', [
      id, new Uint8Array([id]), `fingerprint-${id}`, new Uint8Array(bytes).fill(id), bytes * 10,
    ]);
  });
}

function seedRef(store: Store, reqId: number, ord: number, blockId: number): void {
  store.write(db => db.run(
    'INSERT INTO request_block(req_id,ord,role,block) VALUES (?,?,0,?)',
    [reqId, ord, blockId],
  ));
}

/* ------------------------------- F09 ------------------------------- */

test('F09 预览只挑可证明不可恢复的组合，其他 pending 不动', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    seedRequest(f.store, 2, {
      bodyState: 'pending', have: 0, missReason: 'disk_body_paused',
    });
    seedRequest(f.store, 3, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'hook_absent',
    });
    seedRequest(f.store, 4, {
      bodyState: 'pending', have: HAVE_BODY, missReason: null,
    });
    seedRequest(f.store, 5, {
      bodyState: 'partial', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    seedRequest(f.store, 6, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
      skeleton: new Uint8Array([1, 2]),
    });

    const preview = previewBodyConsistency(f.store.read);
    expect(preview.scope.miss_reasons).toEqual(['disk_body_paused']);
    expect(preview.candidates).toBe(1);
    expect(preview.by_agent).toEqual([{ agent: 'alpha', n: 1 }]);
    expect(preview.by_reason).toEqual([{ miss_reason: 'disk_body_paused', n: 1 }]);
    expect(preview.sample_req_ids).toEqual([1]);
    expect(preview.first_day).toBe('2026-10-31');
    expect(preview.last_day).toBe('2026-10-31');
    // 有正文证据但原因未知/不是可证明集合：保持 pending。
    expect(preview.unproven_pending).toBe(2);
    // 预览只读。
    expect(rowOf(f.store, 1)).toMatchObject({ body_state: 'pending' });
  } finally {
    f.close();
  }
});

test('F09 应用只把可证明组合改成 partial，保留原因与证据位', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    seedRequest(f.store, 2, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'hook_absent',
    });
    const preview = previewBodyConsistency(f.store.read);
    const report = f.store.write(db => reclassifyBodyConsistency(db, {
      approvalId: 'synthetic-f09',
      expectedCandidates: preview.candidates,
      now: 123,
    }));

    expect(report).toMatchObject({
      changed: 1, changed_req_ids: [1], remaining: 0, first_day: '2026-10-31', last_day: '2026-10-31',
    });
    expect(rowOf(f.store, 1)).toMatchObject({
      body_state: 'partial', miss_reason: 'disk_body_paused', skeleton_z: null,
      body_bytes: null, redact_version: null, have: HAVE_BODY,
    });
    // body_state 是派生输入：应用必须推进修订，重启后不能复用 pending 时代的组结论。
    const changed = rowOf(f.store, 1)!;
    expect(changed.input_epoch.length).toBeGreaterThan(0);
    expect(changed.input_revision).toBe(1);
    // 不是正文恢复：骨架、正文位与不可读事实都不变。
    expect(rowOf(f.store, 2)).toMatchObject({ body_state: 'pending', miss_reason: 'hook_absent' });
    expect(rowOf(f.store, 2)!.input_revision).toBe(0);
  } finally {
    f.close();
  }
});

test('F09 预览计数变化时整批拒绝，不写半批', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    expect(() => f.store.write(db => reclassifyBodyConsistency(db, {
      approvalId: 'synthetic-f09', expectedCandidates: 2,
    }))).toThrow('body_consistency_scope_changed');
    expect(rowOf(f.store, 1)).toMatchObject({ body_state: 'pending' });
  } finally {
    f.close();
  }
});

test('F09 更新失败时事务整体回滚', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    seedRequest(f.store, 2, {
      bodyState: 'pending', have: HAVE_BODY, missReason: 'disk_body_paused',
    });
    f.store.write(db => db.run(`
      CREATE TRIGGER synthetic_f09_fail BEFORE UPDATE OF body_state ON request
      WHEN NEW.req_id=2 BEGIN SELECT RAISE(ABORT, 'synthetic_fail'); END`));
    expect(() => f.store.write(db => reclassifyBodyConsistency(db, {
      approvalId: 'synthetic-f09', expectedCandidates: 2,
    }))).toThrow();
    expect(rowOf(f.store, 1)).toMatchObject({ body_state: 'pending' });
    expect(rowOf(f.store, 2)).toMatchObject({ body_state: 'pending' });
  } finally {
    f.close();
  }
});

/* ------------------------------- F24 ------------------------------- */

function seedBodyBytesRows(store: Store): void {
  seedBlock(store, 1, 10);
  seedBlock(store, 2, 20);
  // 1) 两块：骨架 3 + 10 + 20 = 33。
  seedRequest(store, 1, {
    bodyState: 'available', have: 1, skeleton: new Uint8Array([1, 2, 3]), msgCount: 2,
  });
  seedRef(store, 1, 0, 1);
  seedRef(store, 1, 1, 2);
  // 2) 与 1 共享块 1：骨架 1 + 10 = 11，共享块按请求只计一次。
  seedRequest(store, 2, {
    bodyState: 'available', have: 1, skeleton: new Uint8Array([4]), msgCount: 1,
    agent: 'beta', day: '2026-11-01',
  });
  seedRef(store, 2, 0, 1);
  // 3) 引用数与 msg_count 不一致：无法明确重算，保持 NULL。
  seedRequest(store, 3, {
    bodyState: 'available', have: 1, skeleton: new Uint8Array([5, 6]), msgCount: 1,
  });
  seedRef(store, 3, 0, 1);
  seedRef(store, 3, 1, 2);
  // 4) 已有 body_bytes：不在范围内。
  seedRequest(store, 4, {
    bodyState: 'available', have: 1, skeleton: new Uint8Array([7]), msgCount: 1, bodyBytes: 5,
  });
  seedRef(store, 4, 0, 1);
  // 5) 非 available：不在范围内。
  seedRequest(store, 5, {
    bodyState: 'pending', have: 1, skeleton: new Uint8Array([8]), msgCount: 1,
  });
  seedRef(store, 5, 0, 1);
  // 6) 无骨架：不在范围内。
  seedRequest(store, 6, { bodyState: 'available', have: 1, msgCount: 0 });
  // 7) 消息数为 0：骨架长度即字节数。
  seedRequest(store, 7, {
    bodyState: 'available', have: 1, skeleton: new Uint8Array([9]), msgCount: 0,
    day: '2026-11-02',
  });
}

test('F24 预览按骨架与块长度重算，不解压也不改库', () => {
  const f = fixture();
  try {
    seedBodyBytesRows(f.store);
    const preview = previewBodyBytesBackfill(f.store.read);
    expect(preview.scope).toEqual({
      body_state: 'available',
      require_skeleton: true,
      require_null_body_bytes: true,
      require_consistent_refs: true,
    });
    expect(preview.candidates).toBe(3);
    expect(preview.recomputed_bytes).toBe(45);
    expect(preview.by_agent).toEqual([
      { agent: 'alpha', n: 2, bytes: 34 },
      { agent: 'beta', n: 1, bytes: 11 },
    ]);
    expect(preview.first_day).toBe('2026-10-31');
    expect(preview.last_day).toBe('2026-11-02');
    expect(preview.sample_req_ids).toEqual([1, 2, 7]);
    // 引用不完整的那一行只报告，不参与重算。
    expect(preview.uncomputable).toBe(1);
    expect(preview.missing_redact_version).toBe(3);
    expect(f.store.read.query(
      'SELECT COUNT(*) AS n FROM request WHERE body_bytes IS NOT NULL').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('F24 应用只补 body_bytes，引用不完整的行保持 NULL，redact_version 不猜', () => {
  const f = fixture();
  try {
    seedBodyBytesRows(f.store);
    const preview = previewBodyBytesBackfill(f.store.read);
    const report = f.store.write(db => backfillBodyBytes(db, {
      approvalId: 'synthetic-f24',
      expectedCandidates: preview.candidates,
      now: 123,
    }));
    expect(report).toMatchObject({
      changed: 3, changed_req_ids: [1, 2, 7], recomputed_bytes: 45, remaining: 0,
      first_day: '2026-10-31', last_day: '2026-11-02',
    });
    expect(f.store.read.query<{ req_id: number; body_bytes: number | null; redact_version: number | null }, []>(
      'SELECT req_id,body_bytes,redact_version FROM request ORDER BY req_id').all()).toEqual([
      { req_id: 1, body_bytes: 33, redact_version: null },
      { req_id: 2, body_bytes: 11, redact_version: null },
      { req_id: 3, body_bytes: null, redact_version: null },
      { req_id: 4, body_bytes: 5, redact_version: null },
      { req_id: 5, body_bytes: null, redact_version: null },
      { req_id: 6, body_bytes: null, redact_version: null },
      { req_id: 7, body_bytes: 1, redact_version: null },
    ]);
  } finally {
    f.close();
  }
});

test('F24 预览计数变化时整批拒绝，不写半批', () => {
  const f = fixture();
  try {
    seedBodyBytesRows(f.store);
    expect(() => f.store.write(db => backfillBodyBytes(db, {
      approvalId: 'synthetic-f24', expectedCandidates: 2,
    }))).toThrow('body_bytes_scope_changed');
    expect(f.store.read.query(
      'SELECT COUNT(*) AS n FROM request WHERE body_bytes IS NOT NULL').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('F24 更新失败时事务整体回滚', () => {
  const f = fixture();
  try {
    seedBlock(f.store, 1, 10);
    seedRequest(f.store, 1, {
      bodyState: 'available', have: 1, skeleton: new Uint8Array([1]), msgCount: 1,
    });
    seedRef(f.store, 1, 0, 1);
    seedRequest(f.store, 2, {
      bodyState: 'available', have: 1, skeleton: new Uint8Array([2]), msgCount: 1,
    });
    seedRef(f.store, 2, 0, 1);
    f.store.write(db => db.run(`
      CREATE TRIGGER synthetic_f24_fail BEFORE UPDATE OF body_bytes ON request
      WHEN NEW.req_id=2 BEGIN SELECT RAISE(ABORT, 'synthetic_fail'); END`));
    expect(() => f.store.write(db => backfillBodyBytes(db, {
      approvalId: 'synthetic-f24', expectedCandidates: 2,
    }))).toThrow();
    expect(f.store.read.query<{ req_id: number; body_bytes: number | null }, []>(
      'SELECT req_id,body_bytes FROM request ORDER BY req_id').all()).toEqual([
      { req_id: 1, body_bytes: null },
      { req_id: 2, body_bytes: null },
    ]);
  } finally {
    f.close();
  }
});
