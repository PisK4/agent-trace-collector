/**
 * OTLP span → request 行的选取与映射（映射层）。
 *
 * 选取键是 `(service.name, 选取规则)`：OMP 的 span 名拼了模型名，按名会漏，
 * 按 `gen_ai.operation.name='chat'` 选；Claude Code 与 Codex 的 span 名是稳定
 * 任务名，按名选。白名单外的 span 不建行；服务在白名单、形状却像 LLM 调用的
 * 不猜，进未知桶。
 *
 * 键名以抓样实测或固定提交源码考察为准，不以语义约定文档为准：Claude Code 的
 * 用量键是平铺的 `input_tokens` 一族（不是 `gen_ai.usage.*`，实测），OMP 用
 * `gen_ai.usage.*`（实测），Codex 用自有 `codex.turn.token_usage.*`（源码
 * 考察，真实流量验收单独一轮）。方言差异全部收在这张表里，改表即升
 * OTLP_MAPPING_VERSION。
 */

import type { OtlpAttrs, OtlpSpan } from './decode';

export const OTLP_MAPPING_VERSION = 2;

/** 属性键按序回退取值；空数组表示该列本版不映射（保持 NULL）。 */
type AttrKeys = {
  session: readonly string[];
  modelRequested: readonly string[];
  modelServed: readonly string[];
  stop: readonly string[];
  inTok: readonly string[];
  outTok: readonly string[];
  cacheRead: readonly string[];
  cacheWrite: readonly string[];
};

export type SpanRule = {
  /** service.name 精确匹配；白名单外的服务不建行。 */
  service: string;
  /** request.agent 标签（claude-code→claude、oh-my-pi→omp、codex_cli_rs→codex）。 */
  agent: string;
  /** 选取规则名，随 OTLP_MAPPING_VERSION 一起版本化。 */
  ruleId: string;
  matches(span: OtlpSpan): boolean;
  keys: AttrKeys;
};

export const SPAN_RULES: readonly SpanRule[] = [
  {
    service: 'claude-code',
    agent: 'claude',
    ruleId: 'span_name',
    matches: span => span.name === 'claude_code.llm_request',
    keys: {
      session: ['gen_ai.conversation.id', 'session.id'],
      modelRequested: ['gen_ai.request.model'],
      modelServed: [],
      stop: ['stop_reason'],
      inTok: ['input_tokens'],
      outTok: ['output_tokens'],
      cacheRead: ['cache_read_tokens'],
      cacheWrite: ['cache_creation_tokens'],
    },
  },
  {
    service: 'oh-my-pi',
    agent: 'omp',
    ruleId: 'gen_ai_operation',
    matches: span => span.attrs['gen_ai.operation.name'] === 'chat',
    keys: {
      session: ['gen_ai.conversation.id'],
      modelRequested: ['gen_ai.request.model'],
      modelServed: ['gen_ai.response.model'],
      stop: ['gen_ai.response.finish_reasons'],
      inTok: ['gen_ai.usage.input_tokens'],
      outTok: ['gen_ai.usage.output_tokens'],
      cacheRead: ['gen_ai.usage.cache_read.input_tokens'],
      cacheWrite: ['gen_ai.usage.cache_creation.input_tokens'],
    },
  },
  {
    service: 'codex_cli_rs',
    agent: 'codex',
    ruleId: 'span_name',
    matches: span => span.name === 'session_task.turn',
    keys: {
      session: ['thread.id'],
      modelRequested: ['model'],
      // Codex 无回复侧模型与终止原因字段；七项用量里 non_cached/reasoning/total
      // 三项不进既有列，留原始层。
      modelServed: [],
      stop: [],
      inTok: ['codex.turn.token_usage.input_tokens'],
      outTok: ['codex.turn.token_usage.output_tokens'],
      cacheRead: ['codex.turn.token_usage.cached_input_tokens'],
      cacheWrite: ['codex.turn.token_usage.cache_write_input_tokens'],
    },
  },
];

export type SpanClassification =
  | { kind: 'llm'; rule: SpanRule }
  | { kind: 'skipped' }
  | { kind: 'unknown' };

/** 形状判据：这些键在场说明 span 自称一次 LLM 调用，但选取规则没认它。 */
const LLM_SHAPE_KEYS = ['gen_ai.usage.input_tokens', 'input_tokens', 'gen_ai.request.model'];

export function classifySpan(service: string | null, span: OtlpSpan): SpanClassification {
  const rule = SPAN_RULES.find(entry => entry.service === service);
  if (rule === undefined) return { kind: 'skipped' };
  if (rule.matches(span)) return { kind: 'llm', rule };
  const shapeLikeLlm = LLM_SHAPE_KEYS.some(key => span.attrs[key] !== undefined);
  return shapeLikeLlm ? { kind: 'unknown' } : { kind: 'skipped' };
}

function firstString(attrs: OtlpAttrs, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** stop 键的值可能是字符串，也可能是字符串数组（finish_reasons）——都取第一个。 */
function stopOf(attrs: OtlpAttrs, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  }
  return null;
}

/** 只收安全整数；超 2^53 的值（解码层已转十进制字符串）对用量列无意义，保持 NULL。 */
function firstCount(attrs: OtlpAttrs, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

export type SpanMapping = {
  agent: string;
  session: string | null;
  modelRequested: string | null;
  modelServed: string | null;
  stop: string | null;
  inTok: number | null;
  outTok: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
};

/**
 * 只写与既有列语义严格一致的映射；映射不进既有列的 OTLP 独有事实
 * （attempt、agent_id、query_source_safe、工具 span 起止）留在原始层。
 */
export function mapSpan(rule: SpanRule, span: OtlpSpan): SpanMapping {
  const keys = rule.keys;
  return {
    agent: rule.agent,
    session: firstString(span.attrs, keys.session),
    modelRequested: firstString(span.attrs, keys.modelRequested),
    modelServed: firstString(span.attrs, keys.modelServed),
    stop: stopOf(span.attrs, keys.stop),
    inTok: firstCount(span.attrs, keys.inTok),
    outTok: firstCount(span.attrs, keys.outTok),
    cacheRead: firstCount(span.attrs, keys.cacheRead),
    cacheWrite: firstCount(span.attrs, keys.cacheWrite),
  };
}
