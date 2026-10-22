import type { AttemptOutcome, FamilyProjection, ProjectionReason, RequestProjection } from './projection';

/**
 * 有界来源事实。
 *
 * 这些 JSON 列不是"把 payload 再存一遍"：它们只保留长期需要、且无法从原始层
 * 重新推导的结论——来源种类集合、hook 的独立报告、选定尝试。原始行到期删除后，
 * 这些值仍然成立；raw 还在时重算会得到同样的集合（集合运算满足交换与幂等）。
 *
 * 上限是显式的：集合按字节序去重后截断，溢出不等于丢掉事实，而是标 overflow，
 * 让读模型知道"这里不完整"，而不是悄悄少几个值。
 */

export type BoundedValues = {
  values: string[];
  overflow: boolean;
  missing: boolean;
  invalid: boolean;
};

export type SourceKindState = 'overflow' | 'invalid' | 'conflict' | 'missing' | 'agree' | 'single';

export type SourceKinds = {
  ledger: BoundedValues;
  route: BoundedValues;
  state: SourceKindState;
  value: string | null;
};

export type SelectedState = 'selected' | 'pending_final' | 'retained' | 'missing';

export type SelectedFacts = {
  state: SelectedState;
  ref: string | null;
  modelProvider: string | null;
  served: string | null;
  effort: string | null;
  tier: string | null;
  error: string | null;
  errorType: string | null;
};

export type SourceFacts = {
  format: 1;
  kinds: SourceKinds;
  hook: { models: BoundedValues; successes: boolean[] };
  selected: SelectedFacts | null;
};

export type FamilyMetaState = 'recomputed' | 'retained' | 'missing';
export type FamilyMetaReason = 'complete' | 'invalid_input' | 'expired_input' | 'legacy_unknown';

export type FamilyMeta = {
  actualVersion: number | null;
  state: FamilyMetaState;
  reason: FamilyMetaReason;
  basis: string[];
};

export type ProjectionMeta = {
  format: 1;
  order: 'provable' | 'unprovable' | 'unknown';
  families: { models: FamilyMeta; attempts: FamilyMeta; prompt: FamilyMeta };
};

/** 单个值上限与每来源集合上限；超限只影响该值/该集合，不影响其他事实。 */
export const MAX_VALUE_BYTES = 256;
export const MAX_KIND_VALUES = 8;
export const MAX_BASIS_VALUES = 16;
export const MAX_FACTS_BYTES = 16 * 1024;

export function emptyValues(): BoundedValues {
  return { values: [], overflow: false, missing: false, invalid: false };
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * 把一个观测并入有界集合。
 *
 * 纯函数，与观测顺序无关：去重、排序、截断都在同一处完成，所以
 * `fold(排列)` 与 `fold(逆序)` 必须得到同一个结果。
 */
export function mergeValues(old: BoundedValues, observed: unknown): BoundedValues {
  const valid = typeof observed === 'string' && observed.trim().length > 0;
  const oversized = valid && Buffer.byteLength(observed as string, 'utf8') > MAX_VALUE_BYTES;
  const values = [...new Set([
    ...old.values,
    ...(valid && !oversized ? [observed as string] : []),
  ])].sort(compareBytes);
  return {
    values: values.slice(0, MAX_KIND_VALUES),
    overflow: old.overflow || oversized || values.length > MAX_KIND_VALUES,
    missing: old.missing || observed === null || observed === undefined || observed === '',
    invalid: old.invalid || oversized || (observed !== null && observed !== undefined && typeof observed !== 'string'),
  };
}

export function foldValues(observed: readonly unknown[], base: BoundedValues = emptyValues()): BoundedValues {
  return observed.reduce<BoundedValues>(mergeValues, base);
}

function unionValues(left: BoundedValues, right: BoundedValues): BoundedValues {
  const merged = right.values.reduce<BoundedValues>(mergeValues, left);
  return {
    values: merged.values,
    overflow: merged.overflow || right.overflow,
    missing: merged.missing || right.missing,
    invalid: merged.invalid || right.invalid,
  };
}

/**
 * 两个来源合起来是同一个用途，还是各说一套。
 *
 * `agree` 要求两边各自有值且集合完全相同；一边有值另一边缺失是 `single`，
 * 不是 agree——缺失本身不构成确认。
 */
export function kindState(ledger: BoundedValues, route: BoundedValues): SourceKinds {
  const all = [...new Set([...ledger.values, ...route.values])].sort(compareBytes);
  const state: SourceKindState = ledger.overflow || route.overflow
    ? 'overflow'
    : ledger.invalid || route.invalid
      ? 'invalid'
      : all.length > 1
        ? 'conflict'
        : all.length === 0
          ? 'missing'
          : ledger.values.length > 0 && route.values.length > 0 ? 'agree' : 'single';
  return { ledger, route, state, value: state === 'single' || state === 'agree' ? all[0] ?? null : null };
}

/**
 * 合并两版事实。`right.selected` 是整对象替换，不做字段级拼接：
 * 拼字段会把两笔不同请求的模型、供应商与错误混成一条不存在的记录。
 */
export function mergeSourceFacts(left: SourceFacts, right: SourceFacts): SourceFacts {
  const ledger = unionValues(left.kinds.ledger, right.kinds.ledger);
  const route = unionValues(left.kinds.route, right.kinds.route);
  return {
    format: 1,
    kinds: kindState(ledger, route),
    hook: {
      models: unionValues(left.hook.models, right.hook.models),
      successes: [...new Set([...left.hook.successes, ...right.hook.successes])]
        .sort((a, b) => Number(a) - Number(b)),
    },
    selected: right.selected,
  };
}

export function emptySourceFacts(): SourceFacts {
  return {
    format: 1,
    kinds: kindState(emptyValues(), emptyValues()),
    hook: { models: emptyValues(), successes: [] },
    selected: null,
  };
}

function selectedFactsOf(projection: RequestProjection, old: SelectedFacts | null): SelectedFacts | null {
  const outcome: AttemptOutcome | null = projection.attempts.outcome;
  if (projection.selected !== null && projection.families.selected.current) {
    const fields = projection.selected.fields;
    return {
      state: 'selected',
      ref: projection.selected.refKey,
      modelProvider: fields.provider ?? fields.model ?? null,
      served: fields.served ?? null,
      effort: fields.effort ?? null,
      tier: fields.tierServed ?? fields.tierSent ?? null,
      error: fields.err ?? null,
      errorType: fields.errType ?? null,
    };
  }
  if (outcome === 'pending_final') {
    // 顺序不可证或最终行未定：不发布任何一条尝试的字段，也不沿用旧值假装知道。
    return { state: 'pending_final', ref: null, modelProvider: null, served: null, effort: null, tier: null, error: null, errorType: null };
  }
  if (old !== null && old.state !== 'missing') {
    return { ...old, state: 'retained' };
  }
  return { state: 'missing', ref: null, modelProvider: null, served: null, effort: null, tier: null, error: null, errorType: null };
}

function observedKinds(projection: RequestProjection): { ledger: BoundedValues; route: BoundedValues } {
  return {
    ledger: foldValues(projection.kind.ledger),
    route: foldValues(projection.kind.route),
  };
}

/**
 * 本次投影能确定的事实。只读投影，不写列。
 *
 * `old` 是写入前的旧事实：它提供两个来源各自的历史集合（集合只增不减，
 * 不因这一次 raw 缺失而撤销）与 retained 时的字段值。
 */
export function buildSourceFacts(projection: RequestProjection, old: SourceFacts | null): SourceFacts {
  const observed = observedKinds(projection);
  const kinds = kindState(
    unionValues(old?.kinds.ledger ?? emptyValues(), observed.ledger),
    unionValues(old?.kinds.route ?? emptyValues(), observed.route),
  );
  const successes = projection.hook.successes;
  const hook = {
    models: foldValues(projection.hook.models, old?.hook.models ?? emptyValues()),
    successes: [...new Set([...(old?.hook.successes ?? []), ...successes])].sort((a, b) => Number(a) - Number(b)),
  };
  return {
    format: 1,
    kinds,
    hook,
    selected: selectedFactsOf(projection, old?.selected ?? null),
  };
}

function familyMeta(
  old: FamilyMeta | undefined,
  family: FamilyProjection,
  hadValue: boolean,
): FamilyMeta {
  const unique = [...new Set(family.basis)].sort(compareBytes);
  const basis = unique.filter(ref => Buffer.byteLength(ref, 'utf8') <= MAX_VALUE_BYTES);
  const bounded = basis.length === unique.length && basis.length <= MAX_BASIS_VALUES;
  if (family.current && bounded) {
    return { actualVersion: family.version, state: 'recomputed', reason: 'complete', basis };
  }
  return {
    // 保留行不能把本次版本冒充成实际版本：它说明的是这一行按哪版算出来的。
    actualVersion: old?.actualVersion ?? null,
    state: hadValue ? 'retained' : 'missing',
    reason: family.state === 'invalid' ? 'invalid_input'
      : family.state === 'expired' || family.state === 'partial' || !bounded ? 'expired_input'
        : 'legacy_unknown',
    basis: old?.basis ?? basis.slice(0, MAX_BASIS_VALUES),
  };
}

export function buildProjectionMeta(projection: RequestProjection, old: ProjectionMeta | null): ProjectionMeta {
  return {
    format: 1,
    // B 的 orderState 是读模型的必需输入：只有 provable 才允许把排序键当成当前顺序依据。
    order: projection.identity.orderState,
    families: {
      models: familyMeta(old?.families.models, projection.families.selected, projection.families.selected.basis.length > 0),
      attempts: familyMeta(old?.families.attempts, projection.families.attempts, projection.families.attempts.basis.length > 0),
      prompt: familyMeta(old?.families.prompt, projection.families.prompt, projection.families.prompt.basis.length > 0),
    },
  };
}

function parseJson<T>(text: string | null, accept: (value: unknown) => value is T): T | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return accept(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isBoundedValues(value: unknown): value is BoundedValues {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.values) && record.values.every(item => typeof item === 'string')
    && typeof record.overflow === 'boolean' && typeof record.missing === 'boolean'
    && typeof record.invalid === 'boolean';
}

function isSourceFacts(value: unknown): value is SourceFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const kinds = record.kinds;
  if (kinds === null || typeof kinds !== 'object') return false;
  const hook = record.hook;
  if (hook === null || typeof hook !== 'object') return false;
  const hookRecord = hook as Record<string, unknown>;
  const kindRecord = kinds as Record<string, unknown>;
  return record.format === 1 && isBoundedValues(kindRecord.ledger) && isBoundedValues(kindRecord.route)
    && typeof kindRecord.state === 'string'
    && isBoundedValues(hookRecord.models) && Array.isArray(hookRecord.successes);
}

function isProjectionMeta(value: unknown): value is ProjectionMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const families = record.families;
  if (families === null || typeof families !== 'object') return false;
  const familyRecord = families as Record<string, unknown>;
  const valid = (entry: unknown): boolean => entry !== null && typeof entry === 'object'
    && Array.isArray((entry as Record<string, unknown>).basis)
    && typeof (entry as Record<string, unknown>).state === 'string';
  return record.format === 1 && valid(familyRecord.models) && valid(familyRecord.attempts)
    && valid(familyRecord.prompt);
}

export function readSourceFacts(text: string | null): SourceFacts | null {
  return parseJson(text, isSourceFacts);
}

export function readProjectionMeta(text: string | null): ProjectionMeta | null {
  return parseJson(text, isProjectionMeta);
}

/**
 * 序列化并守住字节上限。
 *
 * 超限先只去掉纯展示用的 error/errorType（它们不是判定依据），仍超限就抛错让
 * 整个投影事务回滚——截断 JSON 会留下半个对象，清空旧事实等于假装从没观测到。
 */
export function serializeFacts(facts: SourceFacts): string {
  let text = JSON.stringify(facts);
  if (Buffer.byteLength(text, 'utf8') <= MAX_FACTS_BYTES) return text;
  const stripped: SourceFacts = facts.selected === null ? facts : {
    ...facts,
    selected: { ...facts.selected, error: null, errorType: null },
  };
  text = JSON.stringify(stripped);
  if (Buffer.byteLength(text, 'utf8') <= MAX_FACTS_BYTES) return text;
  throw new Error('source_facts_budget_exceeded');
}

export function serializeMeta(meta: ProjectionMeta): string {
  const text = JSON.stringify(meta);
  if (Buffer.byteLength(text, 'utf8') > MAX_FACTS_BYTES) throw new Error('projection_meta_budget_exceeded');
  return text;
}
