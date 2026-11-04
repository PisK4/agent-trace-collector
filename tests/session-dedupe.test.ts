import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import type { Store } from '../src/store';
import { dedupeSessionDuplicates, previewSessionDedupe } from '../src/maintenance/dedupe';

const CONV = JSON.stringify(['session', 'synthetic-session']);
const USAGE = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 };

function seedRequest(store: Store, input: {
  via: string;
  evidence: string;
  ref: string;
  evidenceCount?: number;
  startedMs: number;
  usage?: typeof USAGE;
  model: string;
  agent?: string;
}): number {
  return store.write(db => {
    const reqId = Number(db.run(`
      INSERT INTO request(agent,session,conv_key,conv_source,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,model_requested,
        in_tok,out_tok,cache_read,cache_write)
      VALUES (?,?,'["session","synthetic-session"]','claude-session',?,'known',?,'2026-11-04',?,
        'pending',0,16,1,1,?,?,?,?,?)`,
    [
      input.agent ?? 'zcode', 'synthetic-session', 'synthetic-session', input.startedMs,
      input.via, input.model,
      input.usage?.input ?? null, input.usage?.output ?? null,
      input.usage?.cacheRead ?? null, input.usage?.cacheWrite ?? null,
    ]).lastInsertRowid);
    db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
      VALUES (?,?,?,'merged',1)`, [reqId, input.evidence, input.ref]);
    for (let index = 1; index < (input.evidenceCount ?? 1); index += 1) {
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
        VALUES (?,?,?,'merged',1)`, [reqId, `other_${index}`, `${input.ref}/other-${index}`]);
    }
    return reqId;
  });
}

test('模型名不同导致的历史重复行按指纹并回网关行', () => {
  const f = fixture();
  try {
    const target = seedRequest(f.store, {
      via: 'through', evidence: 'ledger', ref: 'ledger-1', startedMs: 10_000,
      usage: USAGE, model: 'group/auto-deepseek-v4-1-flash',
    });
    const source = seedRequest(f.store, {
      via: 'session', evidence: 'zcode_session_call', ref: 'session-1', startedMs: 10_050,
      usage: USAGE, model: 'auto/deepseek-v4.1-flash',
    });

    expect(previewSessionDedupe(f.store)).toMatchObject({
      scanned: 1, candidates: 1, merged: 0, by_source: {},
    });
    expect(dedupeSessionDuplicates(f.store, 2_000)).toMatchObject({
      scanned: 1, candidates: 1, merged: 1, by_source: { zcode_session_call: 1 },
    });

    const rows = f.store.read.query<{ req_id: number }, []>(
      "SELECT req_id FROM request WHERE agent='zcode' ORDER BY req_id").all();
    expect(rows.map(row => row.req_id)).toEqual([target]);
    const alias = f.store.read.query<{ old_id: number; new_id: number }, []>(
      'SELECT old_id,new_id FROM request_alias').all();
    expect(alias).toEqual([{ old_id: source, new_id: target }]);
    const evidence = f.store.read.query<{ source_kind: string }, [number]>(
      'SELECT source_kind FROM request_evidence WHERE req_id=? ORDER BY source_kind').all(target);
    expect(evidence.map(row => row.source_kind)).toEqual(['ledger', 'zcode_session_call']);
  } finally {
    f.close();
  }
});

test('只有弱时间窗能配上的行不修', () => {
  const f = fixture();
  try {
    seedRequest(f.store, {
      via: 'through', evidence: 'ledger', ref: 'ledger-1', startedMs: 10_000,
      usage: { ...USAGE, input: 101 }, model: 'group/auto-deepseek-v4-1-flash',
    });
    seedRequest(f.store, {
      via: 'session', evidence: 'zcode_session_call', ref: 'session-1', startedMs: 10_000,
      usage: USAGE, model: 'auto/deepseek-v4.1-flash',
    });
    expect(previewSessionDedupe(f.store)).toMatchObject({
      scanned: 1, candidates: 0, weak_only: 1, merged: 0,
    });
    expect(dedupeSessionDuplicates(f.store, 2_000).merged).toBe(0);
  } finally {
    f.close();
  }
});

test('已并入其它来源证据的会话行不参与修复', () => {
  const f = fixture();
  try {
    seedRequest(f.store, {
      via: 'through', evidence: 'ledger', ref: 'ledger-1', startedMs: 10_000,
      usage: USAGE, model: 'group/auto-deepseek-v4-1-flash',
    });
    seedRequest(f.store, {
      via: 'session', evidence: 'zcode_session_call', ref: 'session-1',
      evidenceCount: 2, startedMs: 10_000, usage: USAGE, model: 'auto/deepseek-v4.1-flash',
    });
    expect(previewSessionDedupe(f.store)).toMatchObject({ scanned: 0, candidates: 0 });
  } finally {
    f.close();
  }
});
