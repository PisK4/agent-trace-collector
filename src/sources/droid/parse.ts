/**
 * Droid 转录的纯解析：一行 JSON 变成会话开始、消息或忽略项；再把消息归约成逐轮调用。
 *
 * 调用单位是 assistant `message` 行（一条消息一次模型调用）。请求体是截至该行
 * 之前的全部消息；fork 复制段只进消息窗口、不建调用。这里不含文件系统与数据库，
 * 坏行由调用方记 issue 并停在原地——跳过一条消息会让后续每轮请求体缺一条。
 */

import { normalizeResponseId } from '../magpie/mapping';

export type DroidSessionStart = {
  id: string;
  title: string | null;
  cwd: string | null;
  lastCwd: string | null;
  parent: string | null;
  forkedAtMessageId: string | null;
  callingSessionId: string | null;
  version: number | null;
};

export type DroidMessage = {
  id: string;
  timestampMs: number | null;
  role: string;
  content: unknown[];
  modelId: string | null;
  openaiMessageId: string | null;
  reasoningEffort: string | null;
};

export type DroidParsedLine =
  | { kind: 'session_start'; lineType: 'session_start'; atMs: number | null; value: DroidSessionStart }
  | { kind: 'message'; lineType: 'message'; atMs: number | null; value: DroidMessage }
  | { kind: 'other'; lineType: string; atMs: number | null }
  | { kind: 'invalid'; lineType: 'invalid'; atMs: null; reason: string };

export type DroidWindowMessage = { id: string; role: string; content: unknown[] };

export type DroidParserState = {
  session: DroidSessionStart | null;
  messages: DroidWindowMessage[];
  /** fork 会话是否已经走到 forkedAtMessageId；非 fork 会话一开始就是 true。 */
  forkReached: boolean;
  /** 最近一条带 timestamp 的 message；调用开始时间取它。 */
  lastMessageMs: number | null;
};

export type DroidCall = {
  sessionId: string;
  messageId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
  cwd: string | null;
  /** 该 assistant 行之前最近一条消息的时间（缺失时退回自身时间）。 */
  startedMs: number;
  modelRequested: string | null;
  responseId: string | null;
  responseIdNorm: string | null;
  reasoningEffort: string | null;
  /** 截至本行之前的消息数组；调用发生前的完整上下文。 */
  requestMessages: { role: string; content: unknown[] }[];
  replyContent: unknown[];
};

export function droidTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 缺键或空串都按"没有"处理；不强造值。 */
function optionalText(record: Record<string, unknown>, key: string): string | null {
  return textOf(record[key]);
}

function sessionStartOf(record: Record<string, unknown>, atMs: number | null): DroidParsedLine {
  const id = optionalText(record, 'id');
  if (id === null) return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_session_id_missing' };
  return {
    kind: 'session_start', lineType: 'session_start', atMs,
    value: {
      id,
      title: optionalText(record, 'title'),
      cwd: optionalText(record, 'cwd'),
      lastCwd: optionalText(record, 'lastCwd'),
      parent: optionalText(record, 'parent'),
      forkedAtMessageId: optionalText(record, 'forkedAtMessageId'),
      callingSessionId: optionalText(record, 'callingSessionId'),
      version: typeof record.version === 'number' && Number.isFinite(record.version)
        ? Math.trunc(record.version) : null,
    },
  };
}

function messageOf(record: Record<string, unknown>, atMs: number | null): DroidParsedLine {
  const id = optionalText(record, 'id');
  if (id === null) return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_message_id_missing' };
  const message = isRecord(record.message) ? record.message : null;
  if (message === null) {
    return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_message_body_missing' };
  }
  const role = optionalText(message, 'role');
  if (role === null) {
    return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_message_role_missing' };
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_message_content_invalid' };
  }
  return {
    kind: 'message', lineType: 'message', atMs,
    value: {
      id,
      timestampMs: droidTimestamp(record.timestamp),
      role,
      content,
      modelId: optionalText(message, 'modelId'),
      openaiMessageId: optionalText(message, 'openaiMessageId'),
      reasoningEffort: optionalText(message, 'reasoningEffort'),
    },
  };
}

/**
 * 一行转录。未知 type 与字段形状不认识的行不判坏（保留原始层即可）；
 * 只有 JSON 不成立、session_start 缺 id、message 缺 id/role/content 才算坏行。
 */
export function parseDroidLine(text: string): DroidParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_invalid_json' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid', lineType: 'invalid', atMs: null, reason: 'droid_invalid_object' };
  }
  const type = textOf(parsed.type);
  const atMs = droidTimestamp(parsed.timestamp);
  if (type === 'session_start') return sessionStartOf(parsed, atMs);
  if (type === 'message') return messageOf(parsed, atMs);
  return { kind: 'other', lineType: type ?? 'other', atMs };
}

export function emptyDroidState(session: DroidSessionStart | null = null): DroidParserState {
  return {
    session,
    messages: [],
    forkReached: session === null || session.forkedAtMessageId === null,
    lastMessageMs: null,
  };
}

/**
 * 归约一行。返回新状态；`call` 是本行新建的调用（只有 assistant 消息且已越过
 * fork 复制段时才有），`error` 是语义坏行原因，调用方据此记 issue 并停在原地。
 */
export function applyDroidLine(
  state: DroidParserState,
  line: DroidParsedLine,
): { state: DroidParserState; call: DroidCall | null; error: string | null } {
  if (line.kind === 'invalid') return { state, call: null, error: line.reason };
  if (line.kind === 'session_start') {
    // 重复的 session_start 不覆盖第一条：同一文件只有开头那一条是身份。
    if (state.session !== null) return { state, call: null, error: null };
    const session = line.value;
    return { state: { ...state, session, forkReached: session.forkedAtMessageId === null }, call: null, error: null };
  }
  if (line.kind === 'other') return { state, call: null, error: null };

  const session = state.session;
  if (session === null) return { state, call: null, error: 'droid_session_missing' };
  const message = line.value;
  const lastMessageMs = message.timestampMs ?? state.lastMessageMs;

  if (!state.forkReached) {
    // fork 复制段：消息进窗口，但不建调用；看到锚点消息即视为复制段结束。
    const reached = message.id === session.forkedAtMessageId;
    return {
      state: {
        ...state,
        messages: [...state.messages, { id: message.id, role: message.role, content: message.content }],
        forkReached: reached,
        lastMessageMs,
      },
      call: null,
      error: null,
    };
  }

  if (message.role !== 'assistant') {
    return {
      state: {
        ...state,
        messages: [...state.messages, { id: message.id, role: message.role, content: message.content }],
        lastMessageMs,
      },
      call: null,
      error: null,
    };
  }

  const startedMs = state.lastMessageMs ?? message.timestampMs;
  if (startedMs === null) return { state, call: null, error: 'droid_message_time_missing' };
  const isSubagent = session.callingSessionId !== null;
  const call: DroidCall = {
    sessionId: session.id,
    messageId: message.id,
    isSubagent,
    parentSessionId: isSubagent ? session.callingSessionId : null,
    cwd: session.cwd ?? session.lastCwd,
    startedMs,
    modelRequested: message.modelId,
    responseId: message.openaiMessageId,
    responseIdNorm: normalizeResponseId(message.openaiMessageId),
    reasoningEffort: message.reasoningEffort,
    requestMessages: state.messages.map(item => ({ role: item.role, content: item.content })),
    replyContent: message.content,
  };
  return {
    state: {
      ...state,
      messages: [...state.messages, { id: message.id, role: message.role, content: message.content }],
      lastMessageMs,
    },
    call,
    error: null,
  };
}

export type DroidSettings = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  thinkingTokens: number | null;
  factoryCredits: number | null;
  reasoningEffort: string | null;
};

function tokenNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * settings 的会话累计用量。`tokenUsage` 是当前口径；缺失时退回
 * `inclusiveTokenUsage`（本机样本两者相等），两者都没有就全是 NULL，不猜。
 */
export function parseDroidSettings(text: string): { ok: true; value: DroidSettings } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'droid_settings_invalid_json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'droid_settings_invalid_object' };
  const usage = isRecord(parsed.tokenUsage) ? parsed.tokenUsage
    : isRecord(parsed.inclusiveTokenUsage) ? parsed.inclusiveTokenUsage : null;
  return {
    ok: true,
    value: {
      model: optionalText(parsed, 'model'),
      inputTokens: usage === null ? null : tokenNumber(usage.inputTokens),
      outputTokens: usage === null ? null : tokenNumber(usage.outputTokens),
      cacheCreationTokens: usage === null ? null : tokenNumber(usage.cacheCreationTokens),
      cacheReadTokens: usage === null ? null : tokenNumber(usage.cacheReadTokens),
      thinkingTokens: usage === null ? null : tokenNumber(usage.thinkingTokens),
      factoryCredits: usage === null || typeof usage.factoryCredits !== 'number'
        || !Number.isFinite(usage.factoryCredits) ? null : usage.factoryCredits,
      reasoningEffort: optionalText(parsed, 'reasoningEffort'),
    },
  };
}