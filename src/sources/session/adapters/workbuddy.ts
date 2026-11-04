/**
 * WorkBuddy 本地会话适配器。
 *
 * 一行是 OpenAI Agents SDK 的一条 item：`message` / `reasoning` /
 * `function_call` / `function_call_result` 等。同一笔模型回复的若干行靠
 * `providerData.messageId` 串起来，`providerData.usage` 只落在其中一行
 * （本机样本里多在 function_call 或 assistant message），`inputTokens` 含
 * 缓存读写，要减掉才是 magpie 口径的 input。旧历史没有 messageId，一行即
 * 一笔调用，用量用蛇形字段名。
 *
 * 调用单位是 messageId：窗口按行顺序累积消息，遇到下一个 messageId、用户
 * 消息或批末就把挂起的回复结算成一笔 SessionCall。子代理文件在
 * `<父会话 uuid>/subagents/agent-*.jsonl`，折叠到父会话；同父的多个子代理
 * 行内 id 会相撞，所以 callId 与证据 ref_key 都带上子代理身份。
 */

import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { discoverJsonl, jsonlBatch, jsonlRead } from '../read';
import type { SourceCursor, SourceRead } from '../../files';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult, SessionUsage,
} from '../types';
import { canonicalSessionId, sessionConvKey } from '../types';
import { expandHome } from './pi-jsonl';

type WorkbuddyMessage = { role: string; content: unknown[] };

type Pending = {
  messageId: string;
  startedMs: number;
  model: string | null;
  usage: SessionUsage | null;
  /** 回复侧内容块：assistant message 的 content 与 function_call / 摘要。 */
  reply: unknown[];
  /** 结算前的完整上下文窗口。 */
  requestMessages: WorkbuddyMessage[];
  sortOffset: number;
};

type WorkbuddyState = {
  sessionId: string | null;
  subagentId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  model: string | null;
  messages: WorkbuddyMessage[];
  /** 上一笔回复的时间；下一笔缺时间时兜底。 */
  lastReplyMs: number | null;
  pending: Pending | null;
  liveDirty: boolean;
};

/** parse 后的形状；只带归约要用的字段，整行原文由 ingest.ts 脱敏后落原始层。 */
type WorkbuddyLine = {
  type: string | null;
  role: string | null;
  lineId: string | null;
  callId: string | null;
  sessionId: string | null;
  cwd: string | null;
  atMs: number | null;
  content: unknown[];
  messageId: string | null;
  model: string | null;
  usage: SessionUsage | null;
  hasUsage: boolean;
  callName: string | null;
  callArgs: unknown;
  callOutput: unknown;
  status: string | null;
};

/** 不进状态、不落原始层的元数据行；快照行带大块 snapshot，落库没有意义。 */
const IGNORED = new Set([
  'file-history-snapshot', 'ai-title', 'custom-title', 'resend-fork-notice',
]);

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
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function contentOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'input_text', text: value }];
  return [];
}

/** inputTokensDetails 可能是数组或单个对象，cached_tokens 求和。 */
function cachedOf(value: unknown): number {
  const parts = Array.isArray(value) ? value : [value];
  let sum = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    sum += numberOrNull(part.cached_tokens) ?? 0;
  }
  return sum;
}

/** 归一到 magpie 口径：input 不含 cache read/write；兼容旧历史的蛇形字段。 */
function usageOf(usage: Record<string, unknown>): SessionUsage {
  const input = numberOrNull(usage.inputTokens) ?? numberOrNull(usage.input_tokens) ?? 0;
  const output = numberOrNull(usage.outputTokens) ?? numberOrNull(usage.output_tokens) ?? 0;
  const cacheRead = cachedOf(usage.inputTokensDetails) + cachedOf(usage.input_tokens_details);
  const cacheWrite = numberOrNull(usage.cacheCreationTokens)
    ?? numberOrNull(usage.cache_creation_input_tokens) ?? 0;
  return {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
  };
}

/** 子代理文件路径含 `subagents` 段时，父会话 id 是它前面那一段目录名。 */
function subagentParent(file: SessionFile): string | null {
  const parts = dirname(file.path).split(sep);
  const at = parts.lastIndexOf('subagents');
  if (at <= 0) return null;
  return canonicalSessionId(parts[at - 1]!);
}

function result(state: WorkbuddyState, calls: SessionCall[] = [],
  error: string | null = null): SessionApplyResult {
  return { state, calls, error, sessionId: state.sessionId };
}

/** 把挂起的回复结算成一笔调用；没有 usage 的组也建行，用量记 null。 */
function finalize(state: WorkbuddyState): SessionCall | null {
  const pending = state.pending;
  if (pending === null) return null;
  state.pending = null;
  const sessionId = state.sessionId;
  if (sessionId === null) return null;
  state.messages = [...state.messages, { role: 'assistant', content: pending.reply }];
  state.lastReplyMs = pending.startedMs;
  return {
    sessionId,
    subagentId: state.subagentId,
    convKey: sessionConvKey(sessionId),
    callId: state.subagentId === null ? pending.messageId
      : `${state.subagentId}/${pending.messageId}`,
    sortOffset: pending.sortOffset,
    parentSessionId: state.parentSessionId,
    startedMs: pending.startedMs,
    model: pending.model ?? state.model,
    responseIdNorm: null,
    turnRef: null,
    usage: pending.usage,
    reasoning: null,
    requestMessages: pending.requestMessages,
    replyContent: pending.reply,
    cwd: state.cwd,
  };
}

/** function_call 与结果行转成可读的工具块；callId 优先，退回行 id。 */
function callBlock(line: WorkbuddyLine): Record<string, unknown> {
  const id = line.callId ?? line.lineId;
  if (line.type === 'function_call') {
    return { type: 'tool_use', id, name: line.callName, input: line.callArgs };
  }
  return {
    type: 'tool_result', tool_use_id: id,
    content: line.callOutput, status: line.status,
  };
}

function applyEvent(
  state: WorkbuddyState,
  event: SessionParseResult & { kind: 'event' },
): SessionApplyResult {
  if (!isRecord(event.value)) return result(state, [], 'workbuddy_line_invalid');
  const line = event.value as unknown as WorkbuddyLine;

  const lineSession = line.sessionId === null ? null : canonicalSessionId(line.sessionId);
  if (lineSession !== null) {
    // 子代理文件的 sessionId 是子代理自己的 id，阅读单位固定为父会话；
    // 主文件没有 parentSessionId，sessionId 直接取文件内的值。
    if (state.parentSessionId !== null) state.subagentId = lineSession;
    else state.sessionId = lineSession;
  }
  if (line.cwd !== null) state.cwd = line.cwd;
  if (line.model !== null) state.model = line.model;

  const calls: SessionCall[] = [];
  const type = line.type;

  // 用户消息是一轮新输入，先结算上一笔挂起的回复，再进窗口。
  if (type === 'message' && line.role === 'user') {
    const settled = finalize(state);
    if (settled !== null) calls.push(settled);
    state.messages = [...state.messages, { role: 'user', content: line.content }];
    return result(state, calls);
  }

  // 旧历史的一行没有 messageId；带 usage 时按行偏移给它一个稳定的调用身份。
  const replyId = line.messageId
    ?? (line.hasUsage ? `off:${event.offset}` : null);
  if (replyId === null) {
    if (line.content.length > 0) {
      state.messages = [...state.messages, {
        role: type === 'function_call_result' ? 'user' : 'assistant',
        content: [callBlock(line)],
      }];
    }
    return result(state);
  }

  // 换 replyId 表示上一笔回复结束；同 id 的行继续累积。
  if (state.pending !== null && state.pending.messageId !== replyId) {
    const settled = finalize(state);
    if (settled !== null) calls.push(settled);
  }

  if (state.pending === null) {
    const startedMs = line.atMs ?? state.lastReplyMs;
    if (startedMs === null) return result(state, calls, 'workbuddy_time_missing');
    if (state.sessionId === null) return result(state, calls, 'workbuddy_session_missing');
    state.pending = {
      messageId: replyId,
      startedMs,
      model: line.model,
      usage: null,
      reply: [],
      requestMessages: [...state.messages],
      sortOffset: event.offset,
    };
  }
  const pending = state.pending;
  if (line.model !== null) pending.model = line.model;
  // 同回复的后续行可能带更晚的完整 usage；覆盖前一行。
  if (line.hasUsage && line.usage !== null) pending.usage = line.usage;

  if (type === 'message' && line.role === 'assistant') {
    pending.reply = [...pending.reply, ...line.content];
  } else if (type === 'function_call' || type === 'function_call_result') {
    pending.reply = [...pending.reply, callBlock(line)];
  } else if (type === 'reasoning' && line.content.length > 0) {
    pending.reply = [...pending.reply, ...line.content];
  }
  if (event.replay !== true) state.liveDirty = true;
  return result(state, calls);
}

export const workbuddyAdapter: SessionAdapter = {
  agent: 'workbuddy',
  sourceKind: 'workbuddy_session',
  issueKind: 'workbuddy_session',
  evidenceKind: 'workbuddy_session_call',
  bodyProtocol: 'chat',
  sortSource: 'workbuddy_session',
  mutable: true,
  refreshOnDuplicate: true,
  replaysState: true,
  batch: jsonlBatch(),

  roots(env, home = homedir()) {
    const base = env.WORKBUDDY_CONFIG_DIR?.trim();
    const dir = base !== undefined && base.length > 0
      ? expandHome(base, home) : join(home, '.workbuddy');
    return [join(dir, 'projects')];
  },

  discover(root, cursorFor) {
    // subagents 子目录在主文件之下两层；默认深度 5 足够覆盖。
    return discoverJsonl(root, cursorFor);
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return jsonlRead(file, cursor, 'workbuddy_session');
  },

  parse(text: string): SessionParseResult {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'workbuddy_invalid_json' };
    }
    if (!isRecord(raw)) return { kind: 'invalid', reason: 'workbuddy_invalid_object' };
    const type = textOf(raw.type);
    if (type !== null && IGNORED.has(type)) return { kind: 'ignore' };
    const providerData = isRecord(raw.providerData) ? raw.providerData : null;
    const usage = providerData !== null && isRecord(providerData.usage)
      ? usageOf(providerData.usage) : null;
    const line: WorkbuddyLine = {
      type,
      role: textOf(raw.role),
      lineId: textOf(raw.id),
      callId: textOf(raw.callId),
      sessionId: textOf(raw.sessionId),
      cwd: textOf(raw.cwd),
      atMs: timestampOf(raw.timestamp),
      content: contentOf(raw.content),
      messageId: providerData === null ? null : textOf(providerData.messageId),
      model: providerData === null ? null
        : textOf(providerData.model) ?? textOf(providerData.requestModelId),
      usage,
      hasUsage: usage !== null,
      callName: textOf(raw.name),
      callArgs: raw.arguments ?? null,
      callOutput: raw.output ?? null,
      status: textOf(raw.status),
    };
    return {
      kind: 'event',
      lineType: type ?? 'other',
      atMs: line.atMs,
      sessionId: line.sessionId,
      offset: 0,
      value: line,
    };
  },

  emptyState(file?: SessionFile): WorkbuddyState {
    const parent = file === undefined ? null : subagentParent(file);
    return {
      sessionId: parent,
      subagentId: null,
      parentSessionId: parent,
      cwd: null,
      model: null,
      messages: [],
      lastReplyMs: null,
      pending: null,
      liveDirty: false,
    };
  },

  apply(state, event) {
    return applyEvent(state as WorkbuddyState, event);
  },

  flush(state) {
    const current = state as WorkbuddyState;
    if (!current.liveDirty || current.pending === null) {
      return { state, calls: [], error: null, sessionId: current.sessionId };
    }
    const call = finalize(current);
    current.liveDirty = false;
    return { state, calls: call === null ? [] : [call], error: null, sessionId: current.sessionId };
  },
};
