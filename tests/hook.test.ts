import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { createHandler } from '../src/http';
import { acceptHook, bodyOmission, HOOK_ABSENT_THRESHOLD_MS, markHookAbsent, reconcilePending } from '../src/hook';
import type { HookEnvelope } from '../src/hook';
import { drainDerive } from '../src/derive/sync';
import { onRequest, onResponse } from '../plugins/collector.hooks';
import type { HookContext } from '../plugins/collector.hooks';
import { restoreBody } from '../src/body';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';
import { ingestSource } from '../src/reconcile';
import type { SourceRead } from '../src/sources/files';

const salt = new Uint8Array(32).fill(3);

function envelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    hook_id: 'hook-synthetic-1',
    observed_start_ms: 1_700_000_000_000,
    observed_finish_ms: 1_700_000_001_200,
    protocol: 'anthropic',
    path: '/v1/messages',
    agent: 'alpha',
    session: 'synthetic-session',
    cwd: '/synthetic',
    model: 'claude-sonnet-5-5',
    stream: true,
    origin: 'local',
    success: true,
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    reply: { id: 'msg_synthetic_1', content: [{ type: 'text', text: 'hi' }] },
    request_bytes: 80,
    reply_bytes: 60,
    body_omitted: false,
    omit_reason: null,
    ...overrides,
  };
}

function ctx(state: Record<string, unknown> = {}): HookContext {
  return {
    origin: 'local',
    protocol: 'chat',
    path: '/v1/chat/completions',
    state,
    options: { endpoint: 'http://127.0.0.1:8320/hook/ingest', token: 'synthetic-hook-token' },
    signal: new AbortController().signal,
    report: () => {},
  };
}

test('请求期只生成采集身份而不改正文', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const context = ctx();
  expect(onRequest(body, context)).toBeUndefined();
  expect(typeof context.state.hook_id).toBe('string');
  expect(context.state.observed_start_ms).toBeTypeOf('number');
  expect(body).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
});

test('相同envelope重放不增加任何行', () => {
  const f = fixture();
  try {
    const first = acceptHook(f.store, envelope(), 1, salt);
    expect(first.duplicate).toBe(false);
    const counts = () => ({
      requests: (f.store.read.query('SELECT count(*) AS n FROM request').get() as { n: number }).n,
      hook: (f.store.read.query('SELECT count(*) AS n FROM raw_hook').get() as { n: number }).n,
      blocks: (f.store.read.query('SELECT count(*) AS n FROM request_block').get() as { n: number }).n,
      evidence: (f.store.read.query('SELECT count(*) AS n FROM request_evidence').get() as { n: number }).n,
    });
    const before = counts();
    const second = acceptHook(f.store, envelope(), 2, salt);
    expect(second.duplicate).toBe(true);
    expect(second.req_id).toBe(first.req_id);
    expect(counts()).toEqual(before);
  } finally {
    f.close();
  }
});

test('hook正文入库后可还原且凭证已脱敏', () => {
  const f = fixture();
  try {
    const result = acceptHook(f.store, envelope({
      request: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'key sk-synthetic-abcdefgh' }] }],
        headers: { authorization: 'Bearer synthetic-secret-123' },
      },
    }), 1, salt);
    const restored = restoreBody(f.store, result.req_id);
    expect(JSON.stringify(restored)).not.toContain('sk-synthetic-abcdefgh');
    expect(JSON.stringify(restored)).not.toContain('synthetic-secret-123');
    const row = f.store.read.query<{ body_state: string; parse_state: string; reply_state: string; have: number }, [number]>(
      'SELECT body_state, parse_state, reply_state, have FROM request WHERE req_id=?',
    ).get(result.req_id);
    expect(row).toEqual({ body_state: 'available', parse_state: 'ok', reply_state: 'ok', have: 1 });
  } finally {
    f.close();
  }
});

test('超限回调只降级为partial并记录原因', () => {
  const f = fixture();
  try {
    expect(bodyOmission({ request_bytes: 33 * 1024 * 1024, reply_bytes: 1 })).toBe('collector_object_limit');
    expect(bodyOmission({ request_bytes: 32 * 1024 * 1024, reply_bytes: 33 * 1024 * 1024 })).toBe('collector_object_limit');
    // 单体各 32 MiB 以内、合计达到 64 MiB 时按 envelope 级超限处理。
    expect(bodyOmission({ request_bytes: 32 * 1024 * 1024, reply_bytes: 32 * 1024 * 1024 })).toBe('collector_envelope_limit');
    expect(bodyOmission({ request_bytes: 32 * 1024 * 1024, reply_bytes: 32 * 1024 * 1024 + 1 })).toBe('collector_object_limit');
    expect(bodyOmission({ request_bytes: 31 * 1024 * 1024, reply_bytes: 31 * 1024 * 1024 })).toBeNull();
    expect(bodyOmission({ request_bytes: 1024, reply_bytes: 2048 })).toBeNull();
  } finally {
    f.close();
  }
});

test('有账本时hook并入账本请求并迁移正文', () => {
  const f = fixture();
  try {
    // 先造一笔账本请求，response_id_norm 与 hook 回复一致
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
         started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (1,101,'synthetic_1','alpha','synthetic-session',?,'session','synthetic-session','known',
         1700000000000,'2026-10-20','through',200,'pending',0,2,1,1,'ledger title','model_time')`,
      [JSON.stringify(['session', 'synthetic-session'])],
    ));
    const result = acceptHook(f.store, envelope({ reply: { id: 'msg_synthetic_1', content: [] } }), 2, salt);
    expect(result.req_id).toBe(1);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });
    const row = f.store.read.query<{ body_state: string; have: number; actor: string }, [number]>(
      'SELECT body_state, have, actor FROM request WHERE req_id=?',
    ).get(1);
    expect(row).toEqual({ body_state: 'available', have: 3, actor: 'synthetic-session' });
    // 账本标题不被 hook 覆盖
    const title = f.store.read.query<{ title: string }, [number]>('SELECT title FROM request WHERE req_id=?').get(1);
    expect(title?.title).toBe('ledger title');
  } finally {
    f.close();
  }
});

test('hook写事务具名：写统计按 by_name.hook 归属而非 other', () => {
  const f = fixture();
  try {
    acceptHook(f.store, envelope(), 1, salt);
    const named = f.store.writeStats.by_name.hook;
    expect(named).toBeDefined();
    expect(named?.count).toBeGreaterThanOrEqual(1);
  } finally {
    f.close();
  }
});

test('hook先到时账本后到，pending重试完成合并', () => {
  const f = fixture();
  try {
    const result = acceptHook(f.store, envelope(), 1, salt);
    expect(f.store.read.query('SELECT count(*) AS n FROM pending_hook').get()).toEqual({ n: 1 });
    // 账本侧请求到达（同 response id）
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
         started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (2,202,'synthetic_1','alpha','synthetic-session',?,'session','synthetic-session','known',
         1700000000000,'2026-10-20','through',200,'pending',0,2,1,1,'ledger title','model_time')`,
      [JSON.stringify(['session', 'synthetic-session'])],
    ));
    const stats = reconcilePending(f.store, 3);
    expect(stats.merged).toBe(1);
    expect(stats.pending).toBe(0);
    // 合并后 hook 请求被删，别名指向账本请求
    expect(f.store.read.query('SELECT count(*) AS n FROM request WHERE req_id=?').get(result.req_id)).toEqual({ n: 0 });
    const alias = f.store.read.query<{ new_id: number }, [number]>('SELECT new_id FROM request_alias WHERE old_id=?').get(result.req_id);
    expect(alias?.new_id).toBe(2);
    expect(f.store.read.query('SELECT count(*) AS n FROM pending_hook').get()).toEqual({ n: 0 });
    const fk = f.store.read.query('PRAGMA foreign_key_check').all();
    expect(fk).toEqual([]);
    // 旧 ID 仍能解析到正文
    expect(restoreBody(f.store, result.req_id)?.protocol).toBe('anthropic');
  } finally {
    f.close();
  }
});

test('连续合并让别名直接指向最终请求', () => {
  const f = fixture();
  try {
    const a = acceptHook(f.store, envelope({ hook_id: 'h-a' }), 1, salt);
    const b = acceptHook(f.store, envelope({ hook_id: 'h-b', session: 'synthetic-other', reply: { id: 'msg_synthetic_2' } }), 1, salt);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,route_id,response_id_norm,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
         VALUES (10,301,'synthetic_1','synthetic-session','known',1700000000000,'2026-10-20','through','pending',0,2,1,1,'t','model_time'),
                (11,302,'synthetic_2','synthetic-other','known',1700000000000,'2026-10-20','through','pending',0,2,1,1,'t','model_time')`,
      );
    });
    reconcilePending(f.store, 2);
    // a→10, b→11；再把 10 并到 11，所有别名必须直接指向 11
    f.store.write(db => {
      db.run('UPDATE request_alias SET new_id=11 WHERE new_id=10');
      db.run('INSERT OR REPLACE INTO request_alias(old_id,new_id) VALUES (10,11)');
      db.run('UPDATE request_evidence SET req_id=11 WHERE req_id=10');
      db.run('DELETE FROM request WHERE req_id=10');
    });
    const aliases = f.store.read.query<{ old_id: number; new_id: number }, []>(
      'SELECT old_id,new_id FROM request_alias ORDER BY old_id').all();
    expect(aliases).toEqual([
      { old_id: a.req_id, new_id: 11 },
      { old_id: b.req_id, new_id: 11 },
      { old_id: 10, new_id: 11 },
    ].sort((left, right) => left.old_id - right.old_id));
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});

test('同一response_id多个候选时标ambiguous不猜', () => {
  const f = fixture();
  try {
    acceptHook(f.store, envelope(), 1, salt);
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,route_id,response_id_norm,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (20,401,'synthetic_1','a','known',1700000000000,'2026-10-20','through','pending',0,2,1,1,'t','model_time'),
              (21,402,'synthetic_1','a','known',1700000000000,'2026-10-20','through','pending',0,2,1,1,'t','model_time')`,
    ));
    const stats = reconcilePending(f.store, 2);
    expect(stats.ambiguous).toBe(1);
    expect(stats.merged).toBe(0);
    const row = f.store.read.query<{ candidates: string }, []>('SELECT candidates FROM pending_hook').get();
    expect(JSON.parse(row!.candidates)).toEqual([20, 21]);
    const before = f.store.writeStats.count;
    expect(reconcilePending(f.store, 3)).toEqual({ merged: 0, pending: 0, ambiguous: 1 });
    expect(f.store.writeStats.count).toBe(before);
    f.store.write(db => db.run(`INSERT INTO request(req_id,route_id,response_id_norm,
      started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
      VALUES (22,403,'synthetic_1',1700000000000,'2026-10-20','through','pending',0,2,1,1)`));
    reconcilePending(f.store, 4);
    expect(f.store.read.query('SELECT candidates FROM pending_hook').get())
      .toEqual({ candidates: '[20,21,22]' });
    expect(f.store.writeStats.by_name.pending?.count).toBe(2);
  } finally {
    f.close();
  }
});

test('pending合并每轮最多十个，剩余候选下轮继续', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 12; index++) {
      acceptHook(f.store, envelope({ hook_id: `batch-${index}`,
        reply: { id: `msg_batch-${index}`, content: [] } }), 1, salt);
    }
    f.store.write(db => {
      for (let index = 0; index < 12; index++) {
        db.run(`INSERT INTO request(route_id,response_id_norm,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at)
          VALUES (?,?,1700000000000,'2026-10-20','through','pending',0,2,1,1)`,
        [index + 1, `batch-${index}`]);
      }
    });
    expect(reconcilePending(f.store, 2)).toEqual({ merged: 10, pending: 2, ambiguous: 0 });
    expect(reconcilePending(f.store, 3)).toEqual({ merged: 2, pending: 0, ambiguous: 0 });
    expect(f.store.writeStats.by_name.pending?.count).toBe(2);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { f.close(); }
});

test('无response ID的hook长期pending不强行关联', () => {
  const f = fixture();
  try {
    acceptHook(f.store, envelope({ reply: { content: [] } }), 1, salt);
    const stats = reconcilePending(f.store, 2);
    expect(stats.pending).toBe(1);
    expect(f.store.read.query('SELECT candidates FROM pending_hook').get()).toEqual({ candidates: null });
  } finally {
    f.close();
  }
});

/* ---------- hook 缺席老化守卫（markHookAbsent） ---------- */

const NOW = 1_800_000_000_000;
const AGED = NOW - 2 * HOOK_ABSENT_THRESHOLD_MS;

/** 账本请求行种子：route_id 默认非空以参与 response ID 关联。 */
function seedLedgerRow(
  f: ReturnType<typeof fixture>,
  reqId: number,
  responseIdNorm: string | null,
  startedMs: number,
  extra: { missReason?: string | null } = {},
): void {
  f.store.write(db => db.run(
    `INSERT INTO request(req_id,route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
       started_ms,day,via,status,body_state,miss_reason,derive_version,have,created_at,updated_at,title,title_source)
     VALUES (?,?,?,'alpha','synthetic-session',?,'session','synthetic-session','known',
       ?,'2026-10-20','through',200,'pending',?,0,2,1,1,'ledger title','model_time')`,
    [reqId, 900 + reqId, responseIdNorm, JSON.stringify(['session', 'synthetic-session']),
      startedMs, extra.missReason ?? null],
  ));
}

test('超龄无hook证据的行标注hook_absent，body_state保持pending', () => {
  const f = fixture();
  try {
    seedLedgerRow(f, 1, 'aged_1', AGED);
    seedLedgerRow(f, 2, 'young_1', NOW - HOOK_ABSENT_THRESHOLD_MS / 2);
    seedLedgerRow(f, 3, 'paused_1', AGED, { missReason: 'disk_body_paused' });
    expect(markHookAbsent(f.store, NOW)).toBe(1);
    const rowOf = (id: number) => f.store.read.query<{ miss_reason: string | null; body_state: string }, [number]>(
      'SELECT miss_reason, body_state FROM request WHERE req_id=?').get(id);
    expect(rowOf(1)).toEqual({ miss_reason: 'hook_absent', body_state: 'pending' });
    expect(rowOf(2)?.miss_reason).toBeNull();
    // 阈值内不标；已有原因不覆盖；已标注的行不重复标注。
    expect(rowOf(3)?.miss_reason).toBe('disk_body_paused');
    expect(markHookAbsent(f.store, NOW)).toBe(0);
  } finally { f.close(); }
});

test('等待关联队列指向本行时不标注，合并完成后不残留', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 12; index++) {
      acceptHook(f.store, envelope({ hook_id: `absent-${index}`,
        reply: { id: `msg_absent-${index}`, content: [] } }), 1, salt);
    }
    f.store.write(db => {
      for (let index = 0; index < 12; index++) {
        db.run(`INSERT INTO request(route_id,response_id_norm,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at)
          VALUES (?,?,?,'2026-10-20','through','pending',0,2,1,1)`,
        [index + 1, `absent-${index}`, AGED]);
      }
    });
    // 12 行都在等待关联队列里有指向自己的候选：合并随时可能发生，不标注。
    expect(markHookAbsent(f.store, NOW)).toBe(0);
    expect(reconcilePending(f.store, NOW)).toEqual({ merged: 10, pending: 2, ambiguous: 0 });
    // 未合并的两行仍在等待，继续不标注。
    expect(markHookAbsent(f.store, NOW)).toBe(0);
    expect(reconcilePending(f.store, NOW + 1)).toEqual({ merged: 2, pending: 0, ambiguous: 0 });
    const rows = f.store.read.query<{ body_state: string; miss_reason: string | null }, []>(
      'SELECT body_state, miss_reason FROM request ORDER BY req_id').all();
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.body_state).toBe('available');
      expect(row.miss_reason).toBeNull();
    }
    expect(markHookAbsent(f.store, NOW + 2)).toBe(0);
  } finally { f.close(); }
});

test('歧义候选行不标注：待裁决不是缺席', () => {
  const f = fixture();
  try {
    seedLedgerRow(f, 1, 'synthetic_1', AGED);
    seedLedgerRow(f, 2, 'synthetic_1', AGED);
    acceptHook(f.store, envelope({ hook_id: 'ambiguous-absent' }), 1, salt);
    expect(markHookAbsent(f.store, NOW)).toBe(0);
    const reasons = f.store.read.query<{ miss_reason: string | null }, []>(
      'SELECT miss_reason FROM request WHERE req_id IN (1,2) ORDER BY req_id').all();
    expect(reasons).toEqual([{ miss_reason: null }, { miss_reason: null }]);
  } finally { f.close(); }
});

test('response_id_norm为NULL的行仍被标注', () => {
  const f = fixture();
  try {
    // 无 response id 的 hook 长期挂在等待队列且 response_id_norm 为 NULL；
    // NOT IN 口径会让所有行永远漏标，NOT EXISTS 对 NULL 放行。
    acceptHook(f.store, envelope({ hook_id: 'no-reply-id', reply: { content: [] } }), 1, salt);
    f.store.write(db => db.run(
      `INSERT INTO request(route_id,response_id_norm,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at)
       VALUES (901,NULL,?,'2026-10-20','through','pending',0,2,1,1)`, [AGED]));
    expect(markHookAbsent(f.store, NOW)).toBe(1);
    expect(f.store.read.query<{ miss_reason: string | null; body_state: string }, []>(
      "SELECT miss_reason, body_state FROM request WHERE response_id_norm IS NULL AND via='through'"
    ).get()).toEqual({ miss_reason: 'hook_absent', body_state: 'pending' });
  } finally { f.close(); }
});

test('每轮标注有上限，余量下轮继续', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      for (let index = 1; index <= 250; index++) {
        db.run(`INSERT INTO request(req_id,route_id,response_id_norm,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at)
          VALUES (?,?,NULL,?,'2026-10-20','through','pending',0,2,1,1)`,
        [index, index, AGED]);
      }
    });
    expect(markHookAbsent(f.store, NOW)).toBe(200);
    expect(markHookAbsent(f.store, NOW)).toBe(50);
    expect(markHookAbsent(f.store, NOW)).toBe(0);
    expect(f.store.read.query<{ n: number }, []>(
      "SELECT count(*) AS n FROM request WHERE miss_reason='hook_absent'").get()?.n).toBe(250);
  } finally { f.close(); }
});

test('恢复路径一：直接命中落正文清掉hook_absent', () => {
  const f = fixture();
  try {
    seedLedgerRow(f, 1, 'synthetic_1', AGED);
    expect(markHookAbsent(f.store, NOW)).toBe(1);
    const result = acceptHook(f.store, envelope({ hook_id: 'direct-clear' }), NOW, salt);
    expect(result.req_id).toBe(1);
    expect(f.store.read.query<{ body_state: string; miss_reason: string | null; have: number }, [number]>(
      'SELECT body_state, miss_reason, have FROM request WHERE req_id=?').get(1))
      .toEqual({ body_state: 'available', miss_reason: null, have: 3 });
  } finally { f.close(); }
});

/**
 * 后台合并路径的构造：两个同 response id 的超龄账本行先被标注，hook 到达时
 * 两行并存标 ambiguous，清空其中一个候选的响应身份（顺序不可证的既定机制）
 * 让候选唯一，合并随之落到已标注的行上。
 */
function seedMarkedPairThenHook(
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof acceptHook>[1]> = {},
): void {
  seedLedgerRow(f, 1, 'synthetic_1', AGED);
  seedLedgerRow(f, 2, 'synthetic_1', AGED);
  expect(markHookAbsent(f.store, NOW)).toBe(2);
  acceptHook(f.store, envelope({ hook_id: 'merge-recon', ...overrides }), NOW, salt);
  f.store.write(db => db.run('UPDATE request SET response_id_norm=NULL WHERE req_id=2'));
  expect(reconcilePending(f.store, NOW + 1).merged).toBe(1);
}

test('恢复路径二：合并迁移正文后available清空原因', () => {
  const f = fixture();
  try {
    seedMarkedPairThenHook(f);
    expect(f.store.read.query<{ body_state: string; miss_reason: string | null; have: number }, [number]>(
      'SELECT body_state, miss_reason, have FROM request WHERE req_id=?').get(1))
      .toEqual({ body_state: 'available', miss_reason: null, have: 3 });
    // have 位已置：缺席守卫不会重标。
    expect(markHookAbsent(f.store, NOW + 2)).toBe(0);
  } finally { f.close(); }
});

test('恢复路径二：合并取源行降级原因', () => {
  const f = fixture();
  try {
    seedMarkedPairThenHook(f, { body_omitted: true, omit_reason: 'collector_object_limit' });
    // 源行无骨架，正文未迁移：目标保持 pending，降级原因随源行落到本行。
    expect(f.store.read.query<{ body_state: string; miss_reason: string | null }, [number]>(
      'SELECT body_state, miss_reason FROM request WHERE req_id=?').get(1))
      .toEqual({ body_state: 'pending', miss_reason: 'collector_object_limit' });
  } finally { f.close(); }
});

test('恢复路径二：源行无骨架无原因时清空hook_absent且不重标', () => {
  const f = fixture();
  try {
    seedLedgerRow(f, 1, 'synthetic_1', AGED);
    seedLedgerRow(f, 2, 'synthetic_1', AGED);
    expect(markHookAbsent(f.store, NOW)).toBe(2);
    const hook = acceptHook(f.store, envelope({ hook_id: 'merge-evicted' }), NOW, salt);
    // 模拟回收后的源行：骨架已清、正文态 evicted、无缺失原因。
    f.store.write(db => db.run(
      "UPDATE request SET skeleton_z=NULL, body_state='evicted' WHERE req_id=?", [hook.req_id]));
    f.store.write(db => db.run('UPDATE request SET response_id_norm=NULL WHERE req_id=2'));
    expect(reconcilePending(f.store, NOW + 1).merged).toBe(1);
    expect(f.store.read.query<{ body_state: string; miss_reason: string | null }, [number]>(
      'SELECT body_state, miss_reason FROM request WHERE req_id=?').get(1))
      .toEqual({ body_state: 'pending', miss_reason: null });
    // hook 证据已关联，have 位已置：不会重标。
    expect(markHookAbsent(f.store, NOW + 2)).toBe(0);
  } finally { f.close(); }
});

test('hook端点拒绝伪造Host、跨站Origin、错误令牌与非local来源', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-hook-'));
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'read-token', { token: 'hook-token', salt });
    const headers = (overrides: Record<string, string> = {}) => ({
      host: '127.0.0.1:8320',
      authorization: 'Bearer hook-token',
      'content-type': 'application/json',
      ...overrides,
    });
    const send = (body: unknown, override: Record<string, string> = {}) => handler(new Request('http://127.0.0.1:8320/hook/ingest', {
      method: 'POST', headers: headers(override), body: JSON.stringify(body),
    }));

    expect((await send(envelope(), { host: 'evil.example' })).status).toBe(403);
    expect((await send(envelope(), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await send(envelope(), { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await send(envelope({ origin: 'remote' }))).status).toBe(403);
    expect((await send({ ...envelope(), hook_id: '' })).status).toBe(422);
    const ok = await send(envelope());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ req_id: expect.any(Number), duplicate: false });
    const again = await send(envelope());
    expect((await again.json() as { duplicate: boolean }).duplicate).toBe(true);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏JSON被拒且不落半截正文', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'read-token', { token: 'hook-token', salt });
    const response = await handler(new Request('http://127.0.0.1:8320/hook/ingest', {
      method: 'POST',
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer hook-token', 'content-type': 'application/json' },
      body: '{"hook_id": "h1", "request": ',
    }));
    expect(response.status).toBe(400);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('超限envelope以413拒绝且不读进正文', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'read-token', { token: 'hook-token', salt });
    const response = await handler(new Request('http://127.0.0.1:8320/hook/ingest', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8320', authorization: 'Bearer hook-token', 'content-type': 'application/json',
        'content-length': String(65 * 1024 * 1024),
      },
      body: '{}',
    }));
    expect(response.status).toBe(413);
  } finally {
    f.close();
  }
});

test('未配置hook令牌时端点不可用', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'read-token');
    const response = await handler(new Request('http://127.0.0.1:8320/hook/ingest', {
      method: 'POST', headers: { host: '127.0.0.1:8320' }, body: '{}',
    }));
    expect(response.status).toBe(404);
  } finally {
    f.close();
  }
});

test('后回复500会重试一次，4xx不重试', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? new Response('boom', { status: 500 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const state: Record<string, unknown> = {};
    const context = ctx(state);
    onRequest({}, context);
    await onResponse({ id: 'msg_x', content: [] }, context);
    expect(calls).toBe(2);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('nope', { status: 400 });
    }) as unknown as typeof fetch;
    const second = ctx({});
    onRequest({}, second);
    await onResponse({ id: 'msg_y', content: [] }, second);
    expect(calls).toBe(1);
    expect(second.state.collector_code).toBe('collector_http_rejected');
  } finally {
    globalThis.fetch = original;
  }
});

test('正文超32MiB时发metadata envelope', async () => {
  let sent: string | null = null;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const context = ctx({});
    onRequest({}, context);
    context.request = { messages: [{ role: 'user', content: 'x'.repeat(33 * 1024 * 1024) }] };
    await onResponse({ id: 'msg_big', content: [] }, context);
    const envelope = JSON.parse(sent!) as Record<string, unknown>;
    expect(envelope.body_omitted).toBe(true);
    expect(envelope.omit_reason).toBe('collector_object_limit');
    expect(envelope.request).toBeNull();
    expect(envelope.request_bytes).toBeGreaterThan(32 * 1024 * 1024);
    // 未使用时长的其他字段不能混进 envelope
    expect(envelope.report).toBeUndefined();
    expect(envelope.options).toBeUndefined();
  } finally {
    globalThis.fetch = original;
  }
});

test('磁盘暂停时hook拒收并返回507', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'read-token', {
      token: 'hook-token',
      salt,
      admission: () => ({ mode: 'paused', reason: 'disk_budget' }),
    });
    const response = await handler(new Request('http://127.0.0.1:8320/hook/ingest', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8320',
        authorization: 'Bearer hook-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope()),
    }));
    expect(response.status).toBe(507);
    expect(await response.json()).toEqual({ error: 'insufficient_storage' });
    // 拒收不留下半截请求。
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_hook').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('只接元数据时保留证据位并把正文标为暂停原因', () => {
  const f = fixture();
  try {
    const result = acceptHook(f.store, envelope(), 5, salt, {
      admission: () => ({ mode: 'metadata_only', reason: 'disk_budget' }),
    });
    const row = f.store.read.query<{
      body_state: string; miss_reason: string | null; have: number; skeleton_z: Uint8Array | null;
    }, [number]>('SELECT body_state, miss_reason, have, skeleton_z FROM request WHERE req_id=?').get(result.req_id);
    expect(row).toEqual({
      body_state: 'partial', miss_reason: 'disk_body_paused', have: 1, skeleton_z: null,
    });
    // 证据、raw 元数据与 response ID 仍完整，回来补正文时还能关联。
    expect(f.store.read.query("SELECT count(*) AS n FROM request_evidence WHERE source_kind='hook'").get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_hook').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT response_id_norm FROM request WHERE req_id=?', ).get(result.req_id))
      .toEqual({ response_id_norm: 'synthetic_1' });
  } finally {
    f.close();
  }
});

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
      // 直接命中已有账本请求本身就是输入变化：不靠调用方额外 enqueue，
      // 请求要带待处理标记，组要进 dirty。
      expect(f.store.read.query(
        'SELECT input_revision,purpose_pending FROM request WHERE req_id=1').get())
        .toEqual({ input_revision: 1, purpose_pending: 1 });
      expect(f.store.read.query('SELECT state FROM derive_queue').get()).toEqual({ state: 'dirty' });
      drainDerive(f.store);
      expect(f.store.read.query(`SELECT body_state,skeleton_z,prev_relation
        FROM request WHERE req_id=1`).get()).toEqual({
        body_state: 'partial', skeleton_z: null, prev_relation: 'unknown',
      });
    } finally { f.close(); }
  });
}

test('重复hook_id不推进修订，补正文与合并才推进', () => {
  const f = fixture();
  const key = JSON.stringify(['session', 'synthetic-session']);
  try {
    const first = acceptHook(f.store, envelope({ hook_id: 'hook-rev-1' }), 1, salt);
    const revision = () => f.store.read.query<{ input_revision: number; input_epoch: string }, [number]>(
      'SELECT input_revision,input_epoch FROM request WHERE req_id=?').get(first.req_id)!;
    const afterFirst = revision();
    // 同一事务里正文与证据各标一次，修订可以涨多次；只要求非零且单调。
    expect(afterFirst.input_revision).toBeGreaterThan(0);
    expect(afterFirst.input_epoch).not.toBe('');
    // 重复 envelope 提前返回：没有新证据，也没有新输入。
    expect(acceptHook(f.store, envelope({ hook_id: 'hook-rev-1' }), 2, salt).duplicate).toBe(true);
    expect(revision()).toEqual(afterFirst);

    // 同一 response ID 的第二份 hook 证据：新证据进入请求，修订增长、epoch 保留。
    // route_id 是关联前提：没有它这笔请求不参与 response ID 关联。
    f.store.write(db => db.run(
      `UPDATE request SET route_id=101,conv_key=?,conv_source='session',
         actor='synthetic-session',actor_state='known'
       WHERE req_id=?`, [key, first.req_id]));
    acceptHook(f.store, envelope({ hook_id: 'hook-rev-2' }), 3, salt);
    const afterSecond = revision();
    expect(afterSecond.input_epoch).toBe(afterFirst.input_epoch);
    expect(afterSecond.input_revision).toBeGreaterThan(afterFirst.input_revision);
    expect(f.store.read.query('SELECT state FROM derive_queue').get()).toEqual({ state: 'dirty' });
  } finally {
    f.close();
  }
});

test('合并先标源组再换存活请求epoch', () => {
  const f = fixture();
  const sourceKey = JSON.stringify(['session', 'synthetic-source']);
  const targetKey = JSON.stringify(['session', 'synthetic-target']);
  try {
    // 源请求已有确认归属并进过组；目标属于另一组。
    const hook = acceptHook(f.store, envelope({ hook_id: 'hook-merge-rev' }), 1, salt);
    f.store.write(db => db.run(
      `UPDATE request SET conv_key=?,conv_source='session',actor='synthetic-source',actor_state='known'
       WHERE req_id=?`, [sourceKey, hook.req_id]));
    f.store.write(db => db.run(`INSERT INTO request(req_id,route_id,response_id_norm,conv_key,conv_source,
        actor,actor_state,started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at)
       VALUES (2,202,'synthetic_1',?,'session','synthetic-target','known',
         1700000000000,'2026-10-20','through',200,'pending',0,2,1,1)`, [targetKey]));
    const before = f.store.read.query<{ input_epoch: string }, [number]>(
      'SELECT input_epoch FROM request WHERE req_id=?').get(2)!;

    expect(reconcilePending(f.store, 2).merged).toBe(1);
    // 源组在源请求被删前就标脏了：它少了一个成员，链要重算。
    const groups = f.store.read.query<{ conv_key: string; state: string }, []>(
      'SELECT conv_key,state FROM derive_queue ORDER BY conv_key').all();
    expect(groups).toEqual([
      { conv_key: sourceKey, state: 'dirty' },
      { conv_key: targetKey, state: 'dirty' },
    ]);
    // 存活请求的输入集合换成了两笔证据的并集：epoch 必须换新的。
    const after = f.store.read.query<{ input_epoch: string; input_revision: number }, [number]>(
      'SELECT input_epoch,input_revision FROM request WHERE req_id=?').get(2)!;
    expect(after.input_epoch).not.toBe(before.input_epoch);
    expect(after.input_revision).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});

test('只接元数据不覆盖已有正文', () => {
  const f = fixture();
  try {
    const first = acceptHook(f.store, envelope({ hook_id: 'hook-body-1' }), 5, salt);
    expect(restoreBody(f.store, first.req_id)).not.toBeNull();
    // 同一请求再来一次（不同 hook_id、同一 response ID）处在暂停模式：正文仍可还原。
    acceptHook(f.store, envelope({ hook_id: 'hook-body-2' }), 6, salt, {
      admission: () => ({ mode: 'metadata_only', reason: 'disk_budget' }),
    });
    expect(restoreBody(f.store, first.req_id)).not.toBeNull();
  } finally {
    f.close();
  }
});

test('准入恢复后同一请求可以补上正文', () => {
  const f = fixture();
  try {
    // 账本请求先到，正文缺位并留下暂停原因（暂停期间 hook 只落元数据的常态）。
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
         started_ms,day,via,status,body_state,miss_reason,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (1,202,'synthetic_1','alpha','synthetic-session',?,'session','synthetic-session','known',
         1700000000000,'2026-10-20','through',200,'partial','disk_body_paused',0,2,1,1,'t','model_time')`,
      [JSON.stringify(['session', 'synthetic-session'])],
    ));
    // 空间恢复后 hook 带着正文到了：应该并进这笔账本请求并把正文补上。
    const later = acceptHook(f.store, envelope({ hook_id: 'hook-late-2' }), 6, salt, {
      admission: () => ({ mode: 'normal', reason: null }),
    });
    expect(later.req_id).toBe(1);
    const row = f.store.read.query<{ body_state: string; miss_reason: string | null }, []>(
      'SELECT body_state, miss_reason FROM request WHERE req_id=1').get();
    expect(row).toEqual({ body_state: 'available', miss_reason: null });
    expect(restoreBody(f.store, 1)?.protocol).toBe('anthropic');
    expect(f.store.read.query<{ have: number }, []>('SELECT have FROM request WHERE req_id=1').get()).toEqual({ have: 3 });
  } finally {
    f.close();
  }
});

function ledgerBatch(rows: unknown[]): SourceRead {
  let offset = 0;
  const lines = rows.map(row => {
    const text = JSON.stringify(row);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    sourceKind: 'ledger', name: 'usage.jsonl', mode: 'appendable', state: 'decoded',
    generation: '1:2:3:1', rewriteEpoch: 0, lines, committedOff: offset,
    observedOff: offset, seenSize: offset, headLen: 0, headHash: null, fingerprint: null,
    issues: [], startOff: 0, error: null,
  };
}

test('hook-only不合成HTTP状态也不写账本模型列', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 1, salt);
    expect(f.store.read.query(
      'SELECT status,model_requested,model_served FROM request WHERE req_id=?',
    ).get(accepted.req_id)).toEqual({ status: null, model_requested: null, model_served: null });
    expect(f.store.read.query<{ model: string; success: number }, [string]>(
      'SELECT model,success FROM raw_hook WHERE hook_id=?').get('hook-synthetic-1'))
      .toEqual({ model: 'hook-model', success: 1 });
    const projection = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 2, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(projection.hook).toMatchObject({ state: 'present', models: ['hook-model'], successes: [true] });
    expect(projection.selected).toBeNull();
  } finally {
    f.close();
  }
});

test('账本缺req时hook报告独立保留且不写账本模型', () => {
  const f = fixture();
  try {
    ingestSource(f.store, ledgerBatch([{
      t: '2026-10-20T00:00:00Z', route_id: 7, response_id: 'msg_synthetic_1',
      agent: 'demo', session: 'synthetic-session', model: 'provider-model', provider: 'p', status: 200, in: 10,
    }]), salt, 1);
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 2, salt);
    expect(accepted.req_id).toBe(1);
    const projection = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(projection.selected).toMatchObject({ fields: { requested: null, model: 'provider-model' } });
    expect(projection.hook).toMatchObject({ state: 'present', models: ['hook-model'], successes: [true] });
    expect(f.store.read.query('SELECT model_requested,model_served FROM request WHERE req_id=1').get())
      .toEqual({ model_requested: null, model_served: null });
    expect(f.store.read.query<{ model: string }, [string]>('SELECT model FROM raw_hook WHERE hook_id=?').get('hook-synthetic-1'))
      .toEqual({ model: 'hook-model' });
  } finally {
    f.close();
  }
});

test('hook success为false同样不产生失败状态', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: false }), 1, salt);
    expect(f.store.read.query('SELECT status FROM request WHERE req_id=?').get(accepted.req_id))
      .toEqual({ status: null });
  } finally {
    f.close();
  }
});

test('hook证据过期后报告expired且current为false', () => {
  const f = fixture();
  try {
    const accepted = acceptHook(f.store, envelope({ model: 'hook-model', success: true }), 1, salt);
    const before = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 2, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(before.families.hook).toMatchObject({ state: 'complete', current: true });
    f.store.write(db => {
      db.run('DELETE FROM raw_hook WHERE hook_id=?', ['hook-synthetic-1']);
      db.run(`UPDATE request_evidence SET payload_state='expired' WHERE source_kind='hook'`);
    });
    const after = f.store.write(db => projectRequestTx(db, accepted.req_id, {
      now: 3, mappingVersion: SOURCE_PROJECTION_VERSION,
    }));
    expect(after.hook.state).toBe('expired');
    expect(after.families.hook).toMatchObject({ state: 'expired', current: false });
    expect(after.reasons).toContain('hook_expired');
    expect(f.store.read.query('SELECT model_requested,model_served,status FROM request WHERE req_id=?')
      .get(accepted.req_id)).toEqual({ model_requested: null, model_served: null, status: null });
  } finally {
    f.close();
  }
});
