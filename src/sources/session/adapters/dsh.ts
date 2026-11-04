/**
 * DSH（DeepSeek Harness）本地会话适配器。
 *
 * 一次会话一个目录，文件是 `session[.vN].jsonl[.zstd]`。首行是会话头，
 * 之后每个事件一行：`{type, seq, time, data}`。一条 `assistant/message`
 * 就是一次模型调用；它是用量与回复的落点，此前的 user/assistant 消息组成
 * 请求窗口。压缩文件由 `dsh-read.ts` 按 frame 边界续读。
 *
 * 分叉会话（`isSeeded`）在 `session/end-seed` 之前携带父会话的事件副本：
 * 这些事件进入请求窗口，但不重复建调用。格式 2 之前没有结束标记，用
 * 头的 `seedLength` 跳过前 N 个带 seq 的 assistant 事件。
 *
 * 子代理（`delegationDepth > 0`）折叠到直接父会话；父链再往上不追，避免
 * 发现阶段为确定根会话去读每个文件的头。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { jsonlBatch, jsonlRead } from '../read';
import type { SourceCursor, SourceRead } from '../../files';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult, SessionUsage,
} from '../types';
import { canonicalSessionId, sessionConvKey } from '../types';
import { expandHome } from './pi-jsonl';
import { discoverDsh, dshZstdRead } from './dsh-read';

type DshMessage = { role: 'user' | 'assistant'; content: unknown[] };

type DshState = {
  sessionId: string | null;
  subagentId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  model: string | null;
  version: number;
  isSeeded: boolean;
  seedLength: number;
  seeding: boolean;
  seedDone: boolean;
  messages: DshMessage[];
};

type DshLine = { seq: number | null; data: Record<string, unknown> };

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

/** 事件内容是字符串时包成 text 块；数组原样保留。 */
function contentOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return [];
}

/** DSH 的 inputTokens 已不含 cache read/write，直接就是 magpie 口径。 */
function usageOf(value: unknown): SessionUsage | null {
  if (!isRecord(value)) return null;
  const input = numberOrNull(value.inputTokens);
  const output = numberOrNull(value.outputTokens);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: numberOrNull(value.cacheReadTokens) ?? 0,
    cacheWrite: numberOrNull(value.cacheWriteTokens) ?? 0,
  };
}

function applyResult(state: DshState, calls: SessionCall[] = [],
  error: string | null = null): SessionApplyResult {
  return { state, calls, error, sessionId: state.sessionId };
}

function applyHeader(state: DshState, header: Record<string, unknown>): SessionApplyResult {
  const ownId = textOf(header.id);
  if (ownId === null) return applyResult(state, [], 'dsh_session_missing');
  const own = canonicalSessionId(ownId);
  const depth = numberOrNull(header.delegationDepth) ?? 0;
  const parentRaw = textOf(header.parentSession);
  const parent = parentRaw === null ? null : canonicalSessionId(parentRaw);
  if (depth > 0) {
    state.subagentId = own;
    state.parentSessionId = parent;
    state.sessionId = parent ?? own;
  } else {
    state.subagentId = null;
    state.parentSessionId = null;
    state.sessionId = own;
  }
  state.cwd = textOf(header.cwd) ?? state.cwd;
  state.version = numberOrNull(header.version) ?? 0;
  state.seedLength = numberOrNull(header.seedLength) ?? 0;
  state.isSeeded = header.isSeeded === true;
  state.seeding = state.version >= 2 && state.isSeeded;
  state.seedDone = !state.seeding;
  return applyResult(state);
}

function applyAssistant(
  state: DshState,
  event: SessionParseResult & { kind: 'event' },
  data: Record<string, unknown>,
  seq: number | null,
): SessionApplyResult {
  const message = isRecord(data.message) ? data.message : null;
  const source = message !== null && isRecord(message.source) ? message.source : null;
  const model = source === null ? null : textOf(source.model);
  const reply = contentOf(data.content ?? (message === null ? undefined : message.content));
  const inherited = (state.seeding && !state.seedDone)
    || (state.version < 2 && seq !== null && seq < state.seedLength);

  if (inherited) {
    state.messages = [...state.messages, { role: 'assistant', content: reply }];
    if (model !== null) state.model = model;
    return applyResult(state);
  }

  const session = state.sessionId;
  if (session === null) return applyResult(state, [], 'dsh_session_missing');
  if (event.atMs === null) return applyResult(state, [], 'dsh_time_missing');
  const call: SessionCall = {
    sessionId: session,
    subagentId: state.subagentId,
    convKey: sessionConvKey(session),
    callId: seq === null ? `off:${event.offset}` : `seq:${seq}`,
    sortOffset: event.offset,
    parentSessionId: state.parentSessionId,
    startedMs: event.atMs,
    model: model ?? state.model,
    responseIdNorm: null,
    turnRef: null,
    usage: usageOf(data.usage),
    reasoning: null,
    requestMessages: [...state.messages],
    replyContent: reply,
    cwd: state.cwd,
  };
  state.messages = [...state.messages, { role: 'assistant', content: reply }];
  if (model !== null) state.model = model;
  return applyResult(state, [call]);
}

function applyEvent(
  state: DshState,
  event: SessionParseResult & { kind: 'event' },
): SessionApplyResult {
  const line = event.value as DshLine;
  if (!isRecord(line) || !isRecord(line.data)) {
    return applyResult(state, [], 'dsh_payload_invalid');
  }
  switch (event.lineType) {
    case 'session':
      return applyHeader(state, line.data);
    case 'user': {
      const content = contentOf(line.data.content);
      state.messages = [...state.messages, { role: 'user', content }];
      return applyResult(state);
    }
    case 'assistant':
      return applyAssistant(state, event, line.data, line.seq);
    case 'end-seed':
      // 分叉的前缀到此为止；窗口保留，后续自己的调用仍需要这段上下文。
      if (state.seeding && line.data.inherited === true) state.seedDone = true;
      return applyResult(state);
    default:
      return applyResult(state);
  }
}

export const dshAdapter: SessionAdapter = {
  agent: 'dsh',
  sourceKind: 'dsh_session',
  issueKind: 'dsh_session',
  evidenceKind: 'dsh_session_call',
  bodyProtocol: 'chat',
  sortSource: 'dsh_session',
  mutable: false,
  replaysState: true,
  lineCommit: false,
  batch: jsonlBatch(),

  roots(env, home = homedir()) {
    const base = env.DSH_HOME?.trim();
    const root = base !== undefined && base.length > 0 ? expandHome(base, home) : join(home, '.dsh');
    return [join(root, 'sessions')];
  },

  discover(root, cursorFor) {
    return discoverDsh(root, cursorFor);
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return file.path.endsWith('.zstd')
      ? Promise.resolve(dshZstdRead(file, cursor, 'dsh_session'))
      : jsonlRead(file, cursor, 'dsh_session');
  },

  parse(text: string): SessionParseResult {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'dsh_invalid_json' };
    }
    if (!isRecord(value)) return { kind: 'invalid', reason: 'dsh_invalid_object' };
    const type = textOf(value.type);
    if (type === null) return { kind: 'invalid', reason: 'dsh_invalid_type' };
    if (type === 'session') {
      return {
        kind: 'event',
        lineType: 'session',
        atMs: timestampOf(value.createdAt),
        sessionId: textOf(value.id),
        offset: 0,
        value: { seq: null, data: value } satisfies DshLine,
      };
    }
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'session/end-seed') {
      return { kind: 'ignore' };
    }
    const data = isRecord(value.data) ? value.data : null;
    if (data === null) return { kind: 'invalid', reason: 'dsh_payload_invalid' };
    const lineType = type === 'user/message' ? 'user'
      : type === 'assistant/message' ? 'assistant' : 'end-seed';
    return {
      kind: 'event',
      lineType,
      atMs: timestampOf(value.time),
      sessionId: null,
      offset: 0,
      value: { seq: numberOrNull(value.seq), data } satisfies DshLine,
    };
  },

  emptyState(): DshState {
    return {
      sessionId: null, subagentId: null, parentSessionId: null, cwd: null, model: null,
      version: 0, isSeeded: false, seedLength: 0, seeding: false, seedDone: true, messages: [],
    };
  },

  apply(state, event) {
    return applyEvent(state as DshState, event);
  },
};
