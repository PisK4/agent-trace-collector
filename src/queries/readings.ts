/** 来源事实展示：source_facts、projection_meta、上下文与派生状态的阅读视图。 */

import { finite, isRecord, stringOrNull } from './projection';
import { safePrompt } from './routes';

export type BoundedReading = {
  values: string[];
  overflow: boolean;
  missing: boolean;
  invalid: boolean;
};

export type SourceFactsReading = {
  selected: {
    ref: string | null;
    state: 'selected' | 'pending_final' | 'retained' | 'missing';
    modelProvider: string | null;
    served: string | null;
    effort: string | null;
    tier: string | null;
    error: string | null;
    errorType: string | null;
  } | null;
  hook: {
    models: BoundedReading;
    successes: ('success' | 'failure')[];
  } | null;
};

export type ProjectionMetaReading = {
  prompt: {
    actualVersion: number | null;
    state: 'recomputed' | 'retained' | 'missing';
    reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
    basis: string[];
  };
};

export type PromptReading = {
  state: 'recomputed' | 'retained' | 'missing';
  reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
  actual_version: number | null;
  tokens: number | null;
  counted: boolean | null;
  window: number | null;
  held: boolean | null;
  parts: { kind: string; tokens: number }[];
  ratio: number | null;
  legacy: boolean;
  note: string | null;
};

export type DerivationReading = {
  state: 'clean' | 'dirty' | 'retained' | 'legacy' | 'unknown';
  chain_state: 'current' | 'retained' | 'unavailable';
  summary_state: 'current' | 'retained' | 'unavailable';
  reason: string | null;
};

const SELECTED_STATES = new Set(['selected', 'pending_final', 'retained', 'missing']);
const PROMPT_STATES = new Set(['recomputed', 'retained', 'missing']);
const PROMPT_REASONS = new Set(['complete', 'expired_input', 'invalid_input', 'legacy_unknown']);

function boundedReading(value: unknown, limit = 8): BoundedReading {
  const record = isRecord(value) ? value : {};
  const values: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.values)) {
    for (const item of record.values) {
      if (typeof item !== 'string' || seen.has(item)) continue;
      seen.add(item);
      values.push(item);
      if (values.length >= limit) break;
    }
  }
  return {
    values,
    overflow: record.overflow === true,
    missing: record.missing === true,
    invalid: record.invalid === true,
  };
}

function successReading(value: unknown): ('success' | 'failure')[] {
  if (!Array.isArray(value)) return [];
  const out: ('success' | 'failure')[] = [];
  if (value.some(item => item === true)) out.push('success');
  if (value.some(item => item === false)) out.push('failure');
  return out;
}

function selectedState(value: unknown): 'selected' | 'pending_final' | 'retained' | 'missing' {
  return typeof value === 'string' && SELECTED_STATES.has(value)
    ? value as 'selected' | 'pending_final' | 'retained' | 'missing'
    : 'missing';
}

/**
 * `source_facts_json` 的白名单读取。
 *
 * 只返回来源事实，不把 projection_meta 或任意未知键带出去；account、host、
 * who 与原始 payload 从不在这里出现。非法 JSON 或非对象输入按缺失处理。
 */
export function sourceFactsReading(raw: unknown): SourceFactsReading {
  const record = isRecord(raw) ? raw : {};
  const selectedRaw = isRecord(record.selected) ? record.selected : null;
  const selected = selectedRaw === null ? null : {
    ref: stringOrNull(selectedRaw.ref),
    state: selectedState(selectedRaw.state),
    modelProvider: stringOrNull(selectedRaw.modelProvider),
    served: stringOrNull(selectedRaw.served),
    effort: stringOrNull(selectedRaw.effort),
    tier: stringOrNull(selectedRaw.tier),
    error: stringOrNull(selectedRaw.error),
    errorType: stringOrNull(selectedRaw.errorType),
  };
  const hookRaw = isRecord(record.hook) ? record.hook : null;
  const hook = hookRaw === null ? null : {
    models: boundedReading(hookRaw.models),
    successes: successReading(hookRaw.successes),
  };
  return { selected, hook };
}

/** `projection_meta_json` 只读 prompt family；缺值或非法值降级为 legacy_unknown。 */
export function projectionMetaReading(raw: unknown): ProjectionMetaReading {
  const record = isRecord(raw) ? raw : {};
  const families = isRecord(record.families) ? record.families : {};
  const promptRaw = isRecord(families.prompt) ? families.prompt : {};
  const basis = Array.isArray(promptRaw.basis)
    ? promptRaw.basis.filter((item): item is string => typeof item === 'string').slice(0, 16)
    : [];
  return {
    prompt: {
      actualVersion: finite(promptRaw.actualVersion),
      state: typeof promptRaw.state === 'string' && PROMPT_STATES.has(promptRaw.state)
        ? promptRaw.state as 'recomputed' | 'retained' | 'missing' : 'missing',
      reason: typeof promptRaw.reason === 'string' && PROMPT_REASONS.has(promptRaw.reason)
        ? promptRaw.reason as 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown'
        : 'legacy_unknown',
      basis,
    },
  };
}

/** 组状态来自查询投影的 `derived_state` 与摘要状态，不另查 `derive_queue`。 */
export function derivationOf(input: {
  derived_state: string | null;
  summary_state: string | null;
}): DerivationReading {
  if (input.derived_state === 'current') {
    return {
      state: 'clean',
      chain_state: 'current',
      summary_state: input.summary_state === 'recomputed' ? 'current'
        : input.summary_state === null ? 'unavailable' : 'retained',
      reason: null,
    };
  }
  if (input.derived_state === 'dirty') {
    return { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' };
  }
  if (input.derived_state === 'retained') {
    return { state: 'retained', chain_state: 'retained', summary_state: 'retained', reason: 'derived_retained' };
  }
  if (input.derived_state === 'legacy') {
    return { state: 'legacy', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_legacy' };
  }
  return { state: 'unknown', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_state_unknown' };
}

type PromptUse = {
  tokens: number | null;
  counted: boolean;
  window: number | null;
  held: boolean | null;
  parts: { kind: string; tokens: number }[];
};

function legacyPrompt(parts: unknown, tokens: number | null): PromptUse | null {
  if (!Array.isArray(parts) && tokens === null) return null;
  const picked: { kind: string; tokens: number }[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part) || typeof part.kind !== 'string') continue;
      const count = finite(part.tokens);
      if (count === null) continue;
      picked.push({ kind: part.kind, tokens: count });
    }
  }
  return { tokens, counted: false, window: null, held: null, parts: picked };
}

/**
 * 上下文阅读。只有 `recomputed` 且窗口为正才计算占用比例；
 * retained/missing 即使带旧值也只作为历史展示，不冒充当前分母。
 */
export function promptReadingOf(
  prompt: unknown,
  projection: ProjectionMetaReading['prompt'],
  legacyParts: unknown,
  legacyTokens: number | null,
): PromptReading {
  const normalized = projection.state;
  const current = safePrompt(prompt);
  const fallback = legacyPrompt(legacyParts, legacyTokens);
  const use = normalized === 'recomputed' ? current : current ?? fallback;
  const ratio = normalized === 'recomputed' && use !== null && use.tokens !== null
    && use.window !== null && use.window > 0 ? use.tokens / use.window : null;
  return {
    state: normalized,
    reason: projection.reason,
    actual_version: projection.actualVersion,
    tokens: use?.tokens ?? null,
    counted: use?.counted ?? null,
    window: use?.window ?? null,
    held: use?.held ?? null,
    parts: use?.parts ?? [],
    ratio,
    legacy: normalized !== 'recomputed' && use !== null && current === null,
    note: normalized === 'recomputed' ? null
      : projection.reason === 'invalid_input' ? '输入无法复核，不显示比例'
        : normalized === 'retained' ? '旧结果，不按当前输入计算比例'
          : '没有可用的上下文分析',
  };
}
