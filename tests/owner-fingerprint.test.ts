import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { findRequestOwnerTx } from '../src/owner';
import type { Store } from '../src/store';

const CONV = JSON.stringify(['session', 'synthetic-session']);
const USAGE = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 };

function seedCall(store: Store, input: {
  startedMs: number;
  usage?: typeof USAGE;
  evidence?: string;
  model?: string | null;
  agent?: string;
}): number {
  return store.write(db => {
    const reqId = Number(db.run(`
      INSERT INTO request(agent,conv_key,conv_source,session,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,model_requested,
        in_tok,out_tok,cache_read,cache_write)
      VALUES (?,?,'claude-session','synthetic-session','synthetic-session','known',?,'2026-11-04',
        'through','pending',0,16,1,1,?,?,?,?,?)`,
    [
      input.agent ?? 'claude', CONV, input.startedMs, input.model === undefined ? 'claude-synthetic' : input.model,
      input.usage?.input ?? null, input.usage?.output ?? null,
      input.usage?.cacheRead ?? null, input.usage?.cacheWrite ?? null,
    ]).lastInsertRowid);
    if (input.evidence !== undefined) {
      db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
        VALUES (?,?,?,'merged',1)`, [reqId, input.evidence, `synthetic/${reqId}`]);
    }
    return reqId;
  });
}

function find(store: Store, overrides: Partial<Parameters<typeof findRequestOwnerTx>[1]> = {}) {
  return store.write(db => findRequestOwnerTx(db, {
    responseIdNorm: null,
    turnRef: null,
    convKey: CONV,
    agent: 'claude',
    startedMs: 10_000,
    model: 'claude-synthetic',
    usage: USAGE,
    excludeSourceKind: 'ledger',
    ...overrides,
  }));
}

test('用量指纹唯一命中：本地先到、网关后到也能认领同一笔', () => {
  const f = fixture();
  try {
    const reqId = seedCall(f.store, { startedMs: 10_000, usage: USAGE });
    expect(find(f.store)).toEqual({ reqId, outcome: 'matched', rule: 'usage_fingerprint.v1' });
  } finally {
    f.close();
  }
});

test('模型写法跨来源不同仍按四段用量认领', () => {
  const f = fixture();
  try {
    const reqId = seedCall(f.store, {
      startedMs: 10_000, usage: USAGE, model: 'group/auto-deepseek-v4-1-flash',
    });
    expect(find(f.store, { model: 'auto/deepseek-v4.1-flash' }))
      .toEqual({ reqId, outcome: 'matched', rule: 'usage_fingerprint.v1' });
  } finally {
    f.close();
  }
});

test('用量指纹多候选不合并', () => {
  const f = fixture();
  try {
    seedCall(f.store, { startedMs: 9_999, usage: USAGE });
    seedCall(f.store, { startedMs: 10_001, usage: USAGE });
    expect(find(f.store)).toEqual({ reqId: null, outcome: 'ambiguous', rule: 'usage_fingerprint.v1' });
  } finally {
    f.close();
  }
});

test('时间窗按归一后的模型名认领', () => {
  const f = fixture();
  try {
    const reqId = seedCall(f.store, {
      startedMs: 10_000, usage: { ...USAGE, input: 101 }, model: 'group/auto-glm-5-3-flash',
    });
    expect(find(f.store, { model: 'auto/GLM-5.3-Flash' }))
      .toEqual({ reqId, outcome: 'matched', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});

test('时间窗模型名不同但候选唯一时仍然认领', () => {
  const f = fixture();
  try {
    const reqId = seedCall(f.store, {
      startedMs: 10_000, usage: { ...USAGE, input: 101 }, model: 'sn-deepseek-v4-1-flash-1017',
    });
    expect(find(f.store, { model: 'auto/deepseek-v4.1-flash' }))
      .toEqual({ reqId, outcome: 'matched', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});

test('时间窗多候选中只认归一后模型相等的那一笔', () => {
  const f = fixture();
  try {
    seedCall(f.store, {
      startedMs: 10_001, usage: { ...USAGE, input: 101 }, model: 'other-model-family',
    });
    const reqId = seedCall(f.store, {
      startedMs: 10_000, usage: { ...USAGE, input: 102 }, model: 'group/auto-glm-5-3-flash',
    });
    expect(find(f.store, { model: 'auto/GLM-5.3-Flash' }))
      .toEqual({ reqId, outcome: 'matched', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});

test('时间窗多候选且无模型线索时不合并', () => {
  const f = fixture();
  try {
    seedCall(f.store, { startedMs: 9_999, usage: { ...USAGE, input: 101 }, model: 'one-model' });
    seedCall(f.store, { startedMs: 10_001, usage: { ...USAGE, input: 102 }, model: 'other-model' });
    expect(f.store.write(db => findRequestOwnerTx(db, {
      responseIdNorm: null, turnRef: null, convKey: CONV, agent: 'claude',
      startedMs: 10_000, model: null, usage: null, excludeSourceKind: 'ledger',
    }))).toEqual({ reqId: null, outcome: 'ambiguous', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});

test('用量不同且一方缺模型时由唯一弱时间窗候选兜底', () => {
  const f = fixture();
  try {
    const reqId = seedCall(f.store, { startedMs: 10_000, usage: { ...USAGE, input: 101 } });
    expect(find(f.store, { model: null }))
      .toEqual({ reqId, outcome: 'matched', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});

test('指纹窗口只有 ±2 秒，超出后不再按用量认领', () => {
  const f = fixture();
  try {
    seedCall(f.store, { startedMs: 70_001, usage: USAGE });
    expect(find(f.store, { model: null })).toEqual({ reqId: null, outcome: 'absent', rule: null });
  } finally {
    f.close();
  }
});

test('同一来源已有证据的行不被指纹认领', () => {
  const f = fixture();
  try {
    seedCall(f.store, { startedMs: 10_000, usage: USAGE, evidence: 'claude_session_call' });
    expect(find(f.store, { excludeSourceKind: 'claude_session_call', model: null }))
      .toEqual({ reqId: null, outcome: 'absent', rule: null });
  } finally {
    f.close();
  }
});

test('指纹缺任一段用量时跳过，不按 0 猜', () => {
  const f = fixture();
  try {
    seedCall(f.store, { startedMs: 10_000, usage: USAGE });
    expect(find(f.store, { usage: null })).toMatchObject({ outcome: 'matched', rule: 'conv_time_model.v1' });
  } finally {
    f.close();
  }
});