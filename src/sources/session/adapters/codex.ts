/**
 * Codex 本地会话适配器。
 *
 * Codex 把一行原文包成 `{timestamp, type, payload}`。调用单位是
 * `token_usage_record`（首选）或老会话的 `event_msg/token_count`（兜底），
 * 二者都在用量到达时才结算：此前的 user/developer 消息与工具结果组成请求窗口，
 * assistant 消息、reasoning 与工具调用组成这一笔的回复。
 *
 * 同一份 Responses input 既能证明调用前的上下文，也能作为下一笔调用的历史；
 * 结算时把回复项追加进窗口，避免请求体在轮次之间断裂。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeResponseId } from '../../magpie/mapping';
import { discoverJsonl, jsonlBatch, jsonlRead, sealedJsonlRead } from '../read';
import type { SourceCursor, SourceRead } from '../../files';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult, SessionUsage,
} from '../types';
import { canonicalSessionId, sessionConvKey } from '../types';

type CodexState = {
  /** 阅读单位：子代理折叠到根会话。 */
  sessionId: string | null;
  subagentId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  model: string | null;
  turnRef: string | null;
  /** 截至当前调用的 Responses input items。 */
  messages: unknown[];
  /** 本次调用尚未结算的回复项。 */
  output: unknown[];
  /** 最近一条输入项的时间；结算后清空，缺输入时退回上一笔调用时间。 */
  lastInputMs: number | null;
  lastUsageMs: number | null;
  /** 本笔调用首个上下文项的物理偏移；sort_key 用它而不是用量行。 */
  startOffset: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function timestampOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 用量归一到 magpie 口径：input 不含 cache read/write。 */
function usageOf(usage: Record<string, unknown>): SessionUsage | null {
  const input = numberOrNull(usage.input_tokens);
  const output = numberOrNull(usage.output_tokens);
  if (input === null || output === null) return null;
  const cacheRead = numberOrNull(usage.cached_input_tokens) ?? 0;
  const cacheWrite = numberOrNull(usage.cache_write_input_tokens) ?? 0;
  return {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
  };
}

function applyMeta(state: CodexState, payload: Record<string, unknown>): SessionApplyResult {
  const own = textOf(payload.id) ?? textOf(payload.session_id);
  const parent = textOf(payload.parent_thread_id);
  if (own !== null) {
    const ownId = canonicalSessionId(own);
    if (parent !== null) {
      // 子代理文件折叠到根会话：阅读、认领与 evidence ref 都用根 id。
      const parentId = canonicalSessionId(parent);
      state.sessionId = parentId;
      state.subagentId = ownId;
      state.parentSessionId = parentId;
    } else {
      state.sessionId = ownId;
      state.subagentId = null;
      state.parentSessionId = null;
    }
  }
  const cwd = textOf(payload.cwd);
  if (cwd !== null) state.cwd = cwd;
  return { state, calls: [], error: null, sessionId: state.sessionId };
}

function applyTurnContext(state: CodexState, payload: Record<string, unknown>): SessionApplyResult {
  state.turnRef = textOf(payload.turn_id) ?? state.turnRef;
  state.model = textOf(payload.model) ?? state.model;
  const cwd = textOf(payload.cwd);
  if (cwd !== null) state.cwd = cwd;
  return { state, calls: [], error: null, sessionId: state.sessionId };
}

/** Responses item：输入项进窗口，回复项进 output。 */
function applyItem(state: CodexState, item: Record<string, unknown>, atMs: number | null,
  offset: number): SessionApplyResult {
  const touch = (): void => {
    if (state.startOffset === null) state.startOffset = offset;
  };
  const type = textOf(item.type);
  if (type === 'message') {
    const role = textOf(item.role);
    if (role === 'assistant') {
      touch();
      state.output = [...state.output, item];
    } else if (role === 'user' || role === 'developer') {
      touch();
      state.messages = [...state.messages, item];
      state.lastInputMs = atMs ?? state.lastInputMs;
    }
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    touch();
    state.messages = [...state.messages, item];
    state.lastInputMs = atMs ?? state.lastInputMs;
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }
  if (type === 'reasoning' || type === 'function_call' || type === 'custom_tool_call') {
    touch();
    state.output = [...state.output, item];
  }
  return { state, calls: [], error: null, sessionId: state.sessionId };
}

/** 用量行到达才结算：之前积累的 input 是请求，output 是回复。 */
function settle(
  state: CodexState,
  usageRecord: Record<string, unknown> | null,
  responseId: string | null,
  turnId: string | null,
  atMs: number | null,
  offset: number,
): SessionApplyResult {
  const session = state.sessionId;
  if (session === null) {
    return { state, calls: [], error: 'codex_session_missing', sessionId: null };
  }
  const turnRef = turnId ?? state.turnRef;
  if (turnId !== null) state.turnRef = turnId;

  const startedMs = state.lastInputMs ?? state.lastUsageMs ?? atMs ?? 0;
  const sortOffset = state.startOffset ?? offset;
  const requestMessages = [...state.messages];
  const replyContent = [...state.output];
  // 这一笔的回复进入下一笔的上下文；用量行本身不是输入，不参与窗口。
  state.messages = [...state.messages, ...state.output];
  state.output = [];
  state.lastInputMs = null;
  state.lastUsageMs = atMs ?? state.lastUsageMs;
  state.startOffset = null;

  const callId = responseId ?? `${turnRef ?? session}/${offset}`;
  const call: SessionCall = {
    sessionId: session,
    subagentId: state.subagentId,
    convKey: sessionConvKey(session),
    callId,
    sortOffset,
    parentSessionId: state.parentSessionId,
    startedMs,
    model: state.model,
    responseIdNorm: normalizeResponseId(responseId),
    turnRef: turnRef ?? null,
    usage: usageRecord === null ? null : usageOf(usageRecord),
    reasoning: null,
    requestMessages,
    replyContent,
    cwd: state.cwd,
  };
  return { state, calls: [call], error: null, sessionId: session };
}

function applyEvent(state: CodexState, event: SessionParseResult & { kind: 'event' }): SessionApplyResult {
  const payload = event.value;
  if (!isRecord(payload)) {
    return { state, calls: [], error: 'codex_payload_invalid', sessionId: state.sessionId };
  }
  switch (event.lineType) {
    case 'session_meta':
      return applyMeta(state, payload);
    case 'turn_context':
      return applyTurnContext(state, payload);
    case 'response_item':
      return applyItem(state, payload, event.atMs, event.offset);
    case 'token_usage_record':
      return settle(state, isRecord(payload.usage) ? payload.usage : null,
        textOf(payload.response_id), textOf(payload.turn_id), event.atMs, event.offset);
    case 'event_msg': {
      if (textOf(payload.type) !== 'token_count') {
        return { state, calls: [], error: null, sessionId: state.sessionId };
      }
      const info = isRecord(payload.info) ? payload.info : null;
      const lastUsage = info !== null && isRecord(info.last_token_usage)
        ? info.last_token_usage : null;
      return settle(state, lastUsage, null, null, event.atMs, event.offset);
    }
    default:
      return { state, calls: [], error: null, sessionId: state.sessionId };
  }
}

export const codexAdapter: SessionAdapter = {
  agent: 'codex',
  sourceKind: 'codex_session',
  issueKind: 'codex_session',
  evidenceKind: 'codex_session_call',
  bodyProtocol: 'responses',
  sortSource: 'codex_session',
  mutable: false,
  replaysState: true,
  batch: jsonlBatch(),

  roots(env, home = homedir()) {
    const base = env.CODEX_HOME?.trim();
    const root = base !== undefined && base.length > 0 ? base : join(home, '.codex');
    // 归档会话与活动会话同一形状；根缺失由 discover 返回空。
    return [join(root, 'sessions'), join(root, 'archived_sessions')];
  },

  discover(root, cursorFor) {
    return discoverJsonl(root, cursorFor, { extensions: ['.jsonl', '.jsonl.zst'] });
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return file.path.endsWith('.jsonl.zst')
      ? Promise.resolve(sealedJsonlRead(file, cursor, 'codex_session'))
      : jsonlRead(file, cursor, 'codex_session');
  },

  parse(text: string): SessionParseResult {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'codex_invalid_json' };
    }
    if (!isRecord(value)) return { kind: 'invalid', reason: 'codex_invalid_object' };
    const type = textOf(value.type) ?? 'other';
    const payload = value.payload;
    const relevant = type === 'session_meta' || type === 'turn_context'
      || type === 'response_item' || type === 'token_usage_record'
      || (type === 'event_msg' && isRecord(payload) && textOf(payload.type) === 'token_count');
    // world_state、compacted、非 token_count 的 event_msg 等不进原始层。
    if (!relevant) return { kind: 'ignore' };
    const sessionId = type === 'session_meta' && isRecord(payload)
      ? textOf(payload.id) ?? textOf(payload.session_id) : null;
    return {
      kind: 'event',
      lineType: type,
      atMs: timestampOf(value.timestamp),
      sessionId,
      offset: 0,
      value: payload,
    };
  },

  emptyState(): CodexState {
    return {
      sessionId: null, subagentId: null, parentSessionId: null, cwd: null,
      model: null, turnRef: null, messages: [], output: [],
      lastInputMs: null, lastUsageMs: null, startOffset: null,
    };
  },

  apply(state, event) {
    return applyEvent(state as CodexState, event);
  },
};
