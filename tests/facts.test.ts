import { expect, test } from 'bun:test';
import {
  MAX_FACTS_BYTES,
  MAX_VALUE_BYTES,
  buildProjectionMeta,
  buildSourceFacts,
  emptySourceFacts,
  emptyValues,
  foldValues,
  kindState,
  mergeSourceFacts,
  mergeValues,
  readProjectionMeta,
  readSourceFacts,
  serializeFacts,
  serializeMeta,
} from '../src/sources/facts';
import type { FamilyProjection, RequestProjection } from '../src/sources/projection';
import { SOURCE_PROJECTION_VERSION } from '../src/sources/projection';

test('有界kind集合不受排列与重复影响', () => {
  const source = ['z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  expect(foldValues(source)).toEqual(foldValues([...source].reverse().concat(source)));
  expect(foldValues(source).values).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  expect(foldValues(source).overflow).toBe(true);
  expect(mergeValues(foldValues(['chat']), undefined).values).toEqual(['chat']);
  expect(mergeValues(foldValues(['chat']), undefined).missing).toBe(true);
});

test('非法值与超长值不进入集合但留下标记', () => {
  const oversized = 'x'.repeat(MAX_VALUE_BYTES + 1);
  const merged = foldValues(['chat', 7, '', oversized, null]);
  expect(merged.values).toEqual(['chat']);
  expect(merged.overflow).toBe(true);
  expect(merged.invalid).toBe(true);
  expect(merged.missing).toBe(true);
  // 恰好到上限的值仍然接受。
  expect(foldValues(['y'.repeat(MAX_VALUE_BYTES)]).values).toHaveLength(1);
});

test('两个来源一致才agree，缺失不构成确认', () => {
  expect(kindState(foldValues(['chat']), foldValues(['chat'])).state).toBe('agree');
  expect(kindState(foldValues(['chat']), emptyValues()).state).toBe('single');
  expect(kindState(foldValues(['chat']), foldValues(['compact'])).state).toBe('conflict');
  expect(kindState(emptyValues(), emptyValues()).state).toBe('missing');
  expect(kindState(foldValues(['chat']), foldValues(['chat'])).value).toBe('chat');
  expect(kindState(foldValues(['chat']), foldValues(['compact'])).value).toBeNull();
  expect(kindState(foldValues(['chat', 3] as unknown[]), emptyValues()).state).toBe('invalid');
});

function family(overrides: Partial<FamilyProjection> = {}): FamilyProjection {
  return {
    state: 'complete', current: true, version: SOURCE_PROJECTION_VERSION,
    basis: ['ledger-a'], reasons: [], ...overrides,
  };
}

function projection(overrides: Partial<RequestProjection> = {}): RequestProjection {
  const base = {
    reqId: 1, version: SOURCE_PROJECTION_VERSION, state: 'complete' as const,
    selected: {
      refKey: 'ledger-a', tMs: 1000, outcome: 'succeeded' as const,
      fields: {
        provider: 'p', model: 'm', served: 's', effort: 'high', tierServed: 'tier',
        err: null, errType: null, refKey: 'ledger-a',
      },
    },
    attempts: {
      state: 'complete' as const, billed: 1, inTok: 1, outTok: 1, cacheRead: 0, cacheWrite: 0,
      reasoning: 0, count: 1, startMs: 1000, outcome: 'succeeded' as const,
    },
    prompt: { state: 'complete' as const, tokens: 1, counted: 1 as const, window: 1, turns: 1, partsJson: null },
    kind: { state: 'single' as const, values: ['chat'], merged: 'chat', ledger: ['chat'], route: [] },
    hook: { state: 'absent' as const, models: [], successes: [], basis: [] },
    identity: {
      state: 'complete' as const, orderState: 'provable' as const, session: 's', nativeSession: null,
      agent: 'a', subagent: null, parentAgent: null, responseIdNorm: null, startedMs: 1000, sortKey: 'k',
    },
    families: {
      selected: family(), attempts: family(), prompt: family(),
      kind: family(), hook: family(), identity: family(),
    },
    reasons: [],
  };
  return { ...base, ...overrides } as unknown as RequestProjection;
}

test('来源事实合并只增集合，selected整对象替换', () => {
  const left = buildSourceFacts(projection({ kind: { state: 'single', values: ['chat'], merged: 'chat', ledger: ['chat'], route: [] } }), null);
  const right = buildSourceFacts(projection({ kind: { state: 'single', values: ['compact'], merged: 'compact', ledger: [], route: ['compact'] } }), null);
  const merged = mergeSourceFacts(left, right);
  expect(merged.kinds.ledger.values).toEqual(['chat']);
  expect(merged.kinds.route.values).toEqual(['compact']);
  expect(merged.kinds.state).toBe('conflict');
  // 右侧的 selected 整对象替换，不拼字段。
  expect(merged.selected).toEqual(right.selected);
});

test('raw过期不撤销长期kind集合，selected转retained', () => {
  const before = buildSourceFacts(projection(), null);
  expect(before.kinds.ledger.values).toEqual(['chat']);
  const expired = projection({
    kind: { state: 'absent', values: [], merged: null, ledger: [], route: [] },
    selected: null,
    attempts: { ...projection().attempts, state: 'expired', outcome: null },
    families: {
      ...projection().families,
      selected: family({ state: 'expired', current: false }),
      attempts: family({ state: 'expired', current: false }),
    },
  });
  const after = buildSourceFacts(expired, before);
  // 集合保留旧值：raw 缺失是本次证据缺失，不是"从没观测过"。
  expect(after.kinds.ledger.values).toEqual(['chat']);
  expect(after.kinds.state).toBe('single');
  expect(after.selected?.state).toBe('retained');
  expect(after.selected?.served).toBe('s');
});

test('顺序不可证时不发布任何尝试字段', () => {
  const pending = projection({
    selected: null,
    attempts: { ...projection().attempts, outcome: 'pending_final' },
    identity: { ...projection().identity, orderState: 'unprovable' },
    families: { ...projection().families, selected: family({ state: 'conflict', current: false }) },
  });
  const facts = buildSourceFacts(pending, buildSourceFacts(projection(), null));
  expect(facts.selected).toEqual({
    state: 'pending_final', ref: null, modelProvider: null, served: null,
    effort: null, tier: null, error: null, errorType: null,
  });
});

test('投影元数据区分实际版本、保留与缺失', () => {
  const meta = buildProjectionMeta(projection(), null);
  expect(meta.order).toBe('provable');
  expect(meta.families.models).toEqual({
    actualVersion: SOURCE_PROJECTION_VERSION, state: 'recomputed', reason: 'complete', basis: ['ledger-a'],
  });

  const retained = buildProjectionMeta(projection({
    families: {
      ...projection().families,
      selected: family({ state: 'expired', current: false }),
      prompt: family({ state: 'absent', current: false, basis: [] }),
    },
  }), meta);
  // 保留行不把本次版本冒充成实际版本，但保留原实际版本。
  expect(retained.families.models).toMatchObject({
    actualVersion: SOURCE_PROJECTION_VERSION, state: 'retained', reason: 'expired_input',
  });
  // 从没观测过的族标 missing，没有实际版本可继承。
  const never = buildProjectionMeta(projection({
    families: { ...projection().families, prompt: family({ state: 'absent', current: false, basis: [] }) },
  }), null);
  expect(never.families.prompt).toMatchObject({ actualVersion: null, state: 'missing' });

  const invalid = buildProjectionMeta(projection({
    families: { ...projection().families, prompt: family({ state: 'invalid', current: false }) },
  }), meta);
  expect(invalid.families.prompt.reason).toBe('invalid_input');
});

test('事实JSON超过预算先丢展示字段再拒绝，不截断', () => {
  const facts = emptySourceFacts();
  expect(readSourceFacts(serializeFacts(facts))).toEqual(facts);
  const huge = {
    ...facts,
    selected: {
      state: 'selected' as const, ref: 'r', modelProvider: 'm', served: 's', effort: null, tier: null,
      error: 'e'.repeat(20 * 1024), errorType: null,
    },
  };
  // error 只是展示字段：去掉后仍能落地，且 selected 其余字段不变。
  const text = serializeFacts(huge);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_FACTS_BYTES);
  expect(JSON.parse(text).selected.error).toBeNull();
  expect(JSON.parse(text).selected.served).toBe('s');

  // 有界集合本身就能把 JSON 控制在预算内；这里直接构造越界对象，
  // 锁的是"越界就拒绝、不截断也不清空"这条兜底，防止以后加无界字段。
  const oversized = {
    ...facts,
    hook: {
      models: {
        values: Array.from({ length: 200 }, (_, i) => `m${i}`.padEnd(MAX_VALUE_BYTES, 'z')),
        overflow: false, missing: false, invalid: false,
      },
      successes: [],
    },
  };
  expect(() => serializeFacts(oversized)).toThrow('source_facts_budget_exceeded');
  expect(() => serializeMeta(buildProjectionMeta(projection(), null))).not.toThrow();
});

test('损坏或形状不符的事实JSON按缺失处理', () => {
  expect(readSourceFacts('{')).toBeNull();
  expect(readSourceFacts(JSON.stringify({ format: 2 }))).toBeNull();
  expect(readProjectionMeta(JSON.stringify({ format: 1, families: {} }))).toBeNull();
  expect(readSourceFacts(null)).toBeNull();
});

test('空事实与重复合并幂等', () => {
  const empty = emptySourceFacts();
  expect(mergeSourceFacts(empty, empty)).toEqual(empty);
  const once = buildSourceFacts(projection(), null);
  expect(mergeSourceFacts(once, buildSourceFacts(projection(), once))).toEqual(once);
});
