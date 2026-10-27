import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { acceptHook } from '../src/hook';
import type { HookEnvelope } from '../src/hook';
import { reconcilePending } from '../src/hook';
import { EMPTY_SESSION_KEY, migrateHookIdentity, previewHookIdentityMigration } from '../src/maintenance/identity';
import { runMaintenance } from '../src/maintenance/cli';
import { fixture } from './fixtures';

/**
 * 空 session 身份：新请求在 hook 身份入口按缺失处理；已存的空桶行
 * 只能由显式迁移拆回各自的 hook 回退身份。原始证据保留上游空值。
 */

const salt = new Uint8Array(32).fill(5);

function envelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    hook_id: 'hook-identity-1',
    observed_start_ms: 1_700_000_000_000,
    observed_finish_ms: 1_700_000_001_200,
    protocol: 'anthropic',
    path: '/v1/messages',
    agent: 'synthetic-agent',
    session: '',
    cwd: '/synthetic',
    model: 'claude-sonnet-5-5',
    stream: true,
    origin: 'local',
    success: true,
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    reply: { id: 'msg_identity_1', content: [{ type: 'text', text: 'hi' }] },
    request_bytes: 80,
    reply_bytes: 60,
    body_omitted: false,
    omit_reason: null,
    ...overrides,
  };
}

type SeededRow = {
  req_id: number;
  /** 省略时写空桶键与 'session' 来源。 */
  convKey?: string;
  convSource?: string;
  via?: string;
  session?: string | null;
  actor?: string | null;
  actorState?: string;
  have?: number;
};

function seedRow(store: ReturnType<typeof fixture>['store'], row: SeededRow): void {
  store.write(db => db.run(`
    INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,agent,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,input_revision,purpose_chain)
    VALUES (?,?,?,?,?,'synthetic-agent',1000,'2026-10-27',?,'available',0,?,1,1,0,'participate')`,
  [row.req_id, row.convKey ?? EMPTY_SESSION_KEY, row.convSource ?? 'session',
    row.actor === undefined ? '' : row.actor, row.actorState ?? 'unknown',
    row.via ?? 'hook', row.have ?? 1]));
}

function seedHookEvidence(
  store: ReturnType<typeof fixture>['store'],
  reqId: number,
  hookId: string,
  rawSession: string | null,
  mergeState = 'pending',
): void {
  store.write(db => {
    db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at)
      VALUES (?,'hook',?,?, 'response_id_norm.v1',1)`, [reqId, hookId, mergeState]);
    db.run(`INSERT INTO raw_hook(hook_id,received_at,agent,session,parse_state,reply_state)
      VALUES (?,1,'synthetic-agent',?,'ok','ok')`, [hookId, rawSession]);
  });
}

test('新请求把空 session 当缺失，原始空值只留在 raw_hook', () => {
  const f = fixture();
  try {
    const result = acceptHook(f.store, envelope(), 1000, salt);
    const request = f.store.read.query<{
      conv_key: string; conv_source: string; session: string | null;
      actor: string | null; actor_state: string;
    }, [number]>('SELECT conv_key,conv_source,session,actor,actor_state FROM request WHERE req_id=?')
      .get(result.req_id);
    expect(request).toEqual({
      conv_key: JSON.stringify(['hook', 'hook-identity-1']),
      conv_source: 'hook', session: null, actor: null, actor_state: 'unknown',
    });
    expect(f.store.read.query<{ session: string | null }, [string]>(
      'SELECT session FROM raw_hook WHERE hook_id=?').get('hook-identity-1'))
      .toEqual({ session: '' });
    // 空 session 行不进组：没有派生队列行。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('非空 session 的 hook 行保持原身份', () => {
  const f = fixture();
  try {
    const result = acceptHook(f.store, envelope({ session: 'synthetic-session' }), 1000, salt);
    expect(f.store.read.query<{
      conv_key: string; conv_source: string; session: string | null; actor: string | null;
    }, [number]>('SELECT conv_key,conv_source,session,actor FROM request WHERE req_id=?').get(result.req_id))
      .toEqual({
        conv_key: JSON.stringify(['session', 'synthetic-session']),
        conv_source: 'session', session: 'synthetic-session', actor: 'synthetic-session',
      });
  } finally {
    f.close();
  }
});

test('预览列出空桶候选与拒绝原因，不写库', () => {
  const f = fixture();
  try {
    seedRow(f.store, { req_id: 1 });
    seedHookEvidence(f.store, 1, 'hook-a', '');
    // 已关联账本：不套用 hook 回退。
    seedRow(f.store, { req_id: 2, have: 3 });
    seedHookEvidence(f.store, 2, 'hook-b', '');
    f.store.write(db => db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
      VALUES (2,'ledger','ledger-2','merged',1)`));
    // 多份 hook 证据：无法确定唯一回退身份。
    seedRow(f.store, { req_id: 3 });
    seedHookEvidence(f.store, 3, 'hook-c1', '');
    seedHookEvidence(f.store, 3, 'hook-c2', '');
    // 上游原始 session 非空：来源与请求身份冲突。
    seedRow(f.store, { req_id: 4 });
    seedHookEvidence(f.store, 4, 'hook-d', 'real-session');
    // raw_hook 已不存在：无法证明来源。
    seedRow(f.store, { req_id: 5 });
    f.store.write(db => db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
      VALUES (5,'hook','hook-e','pending',1)`));

    const preview = previewHookIdentityMigration(f.store);
    expect(preview.scanned).toBe(5);
    expect(preview.candidates).toEqual([{ req_id: 1, agent: 'synthetic-agent', hook_id: 'hook-a' }]);
    expect(preview.rejected).toEqual([
      { req_id: 2, reason: 'ownership_attached' },
      { req_id: 3, reason: 'hook_evidence_ambiguous' },
      { req_id: 4, reason: 'hook_session_present' },
      { req_id: 5, reason: 'hook_source_missing' },
    ]);
    expect(preview.agents).toEqual([{ agent: 'synthetic-agent', n: 5 }]);
    // 预览无副作用。
    expect(f.store.read.query<{ conv_key: string }, []>(
      'SELECT conv_key FROM request WHERE req_id=1').get())
      .toEqual({ conv_key: EMPTY_SESSION_KEY });
  } finally {
    f.close();
  }
});

test('显式迁移拆分空桶孤儿，重复执行不再迁移', async () => {
  const f = fixture();
  try {
    seedRow(f.store, { req_id: 1 });
    seedHookEvidence(f.store, 1, 'hook-a', '');
    seedRow(f.store, { req_id: 2, have: 3 });
    seedHookEvidence(f.store, 2, 'hook-b', '');
    const dbPath = join(f.dir, 'trace.db');
    const lines: string[] = [];
    const err: string[] = [];

    // 预览：只有候选 1，不写库。
    let code = await runMaintenance(['migrate-hook-identity', '--db', dbPath],
      { out: line => lines.push(line), err: line => err.push(line) });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: true, applied: false, scanned: 2,
      candidates: [{ req_id: 1, agent: 'synthetic-agent', hook_id: 'hook-a' }],
      rejected: [{ req_id: 2, reason: 'ownership_attached' }],
    });
    expect(f.store.read.query<{ conv_key: string }, []>(
      'SELECT conv_key FROM request WHERE req_id=1').get())
      .toEqual({ conv_key: EMPTY_SESSION_KEY });

    // 执行必须带审批标识。
    code = await runMaintenance(['migrate-hook-identity', '--db', dbPath, '--apply'],
      { out: line => lines.push(line), err: line => err.push(line) });
    expect(code).toBe(1);
    expect(JSON.parse(lines[1]!)).toMatchObject({ ok: false, error: 'approval_id_required' });

    const before = f.store.read.query<{ n: number | null }, []>(
      'SELECT SUM(input_revision) AS n FROM request').get();
    code = await runMaintenance(
      ['migrate-hook-identity', '--db', dbPath, '--apply', '--approval-id', 'synthetic-approval'],
      { out: line => lines.push(line), err: line => err.push(line) });
    expect(code).toBe(0);
    expect(JSON.parse(lines[2]!)).toMatchObject({
      ok: true, applied: true, approval_id: 'synthetic-approval',
      scanned: 2, migrated: 1, skipped: 0, remaining: 1,
      conservation: { conserved: true },
    });
    // 迁移后的行：hook 回退身份，session 与 actor 都归 null，actor 仍未知。
    expect(f.store.read.query<{
      conv_key: string; conv_source: string; session: string | null;
      actor: string | null; actor_state: string; have: number;
    }, []>('SELECT conv_key,conv_source,session,actor,actor_state,have FROM request WHERE req_id=1').get())
      .toEqual({
        conv_key: JSON.stringify(['hook', 'hook-a']), conv_source: 'hook',
        session: null, actor: null, actor_state: 'unknown', have: 1,
      });
    // 输入修订推进；未知 actor 不凭空建组。
    const after = f.store.read.query<{ n: number | null }, []>(
      'SELECT SUM(input_revision) AS n FROM request').get();
    expect(after!.n).toBe((before!.n ?? 0) + 1);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
    // 原始证据保留空值。
    expect(f.store.read.query<{ session: string | null }, [string]>(
      'SELECT session FROM raw_hook WHERE hook_id=?').get('hook-a')).toEqual({ session: '' });

    // 重复执行：桶里只剩被拒绝的行，不再迁移、不推进修订。
    const secondBefore = f.store.read.query<{ n: number | null }, []>(
      'SELECT SUM(input_revision) AS n FROM request').get();
    code = await runMaintenance(
      ['migrate-hook-identity', '--db', dbPath, '--apply', '--approval-id', 'synthetic-approval-2'],
      { out: line => lines.push(line), err: line => err.push(line) });
    expect(code).toBe(0);
    expect(JSON.parse(lines[3]!)).toMatchObject({ migrated: 0, skipped: 0, remaining: 1 });
    expect(f.store.read.query<{ n: number | null }, []>(
      'SELECT SUM(input_revision) AS n FROM request').get()).toEqual(secondBefore);
  } finally {
    f.close();
  }
});

test('迁移后的孤儿仍能按唯一 response ID 并入账本目标', () => {
  const f = fixture();
  try {
    seedRow(f.store, { req_id: 1 });
    seedHookEvidence(f.store, 1, 'hook-a', '');
    expect(migrateHookIdentity(f.store).migrated).toBe(1);

    // 账本目标与等待队列就位：唯一候选按 response ID 合并。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,response_id_norm,route_id,conv_key,conv_source,actor,
        actor_state,agent,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (2,'msg_target',9,?,'session','actor-real','known','synthetic-agent',
        2000,'2026-10-27','through','available',0,6,1,1)`,
      [JSON.stringify(['session', 'real-session'])]);
      db.run(`INSERT INTO pending_hook(hook_id,response_id,response_id_norm,first_seen)
        VALUES ('hook-a','msg_target','msg_target',1)`);
    });
    expect(reconcilePending(f.store, 3000)).toMatchObject({ merged: 1 });
    // 源行已删除，证据与别名落在账本目标；目标身份不被 hook 回退覆盖。
    expect(f.store.read.query<{ req_id: number }, []>('SELECT req_id FROM request ORDER BY req_id').all())
      .toEqual([{ req_id: 2 }]);
    expect(f.store.read.query<{ req_id: number; merge_state: string }, []>(
      "SELECT req_id,merge_state FROM request_evidence WHERE source_kind='hook'").all())
      .toEqual([{ req_id: 2, merge_state: 'merged' }]);
    expect(f.store.read.query<{ new_id: number }, []>(
      'SELECT new_id FROM request_alias WHERE old_id=1').get()).toEqual({ new_id: 2 });
    expect(f.store.read.query<{ conv_key: string; actor: string | null }, []>(
      'SELECT conv_key,actor FROM request WHERE req_id=2').get())
      .toEqual({ conv_key: JSON.stringify(['session', 'real-session']), actor: 'actor-real' });
  } finally {
    f.close();
  }
});
