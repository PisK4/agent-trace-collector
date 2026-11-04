/**
 * OMP 与 Pi 共用的 JSONL 会话适配器。
 *
 * 两种文件同形：`session` 行只给身份，`message` 行给消息；一条 assistant 消息
 * 就是一次模型调用，请求体是截至该消息之前的窗口。toolResult 转成 user 侧的
 * `tool_result` 块，保持 anthropic 协议形状。
 *
 * 会话 id 优先取 `session.id`；OMP 的 session 行常常没有 id，退回文件名里的
 * UUID。调用身份优先取 `responseId`，没有时用物理行偏移，保证跨批次稳定。
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { normalizeResponseId } from '../../magpie/mapping';
import { discoverJsonl, jsonlBatch, jsonlRead } from '../read';
import type { SourceCursor, SourceRead } from '../../files';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionKind,
  SessionParseResult,
} from '../types';
import { canonicalSessionId, sessionConvKey } from '../types';

type JsonlSessionKind = Extract<SessionKind, 'omp_session' | 'pi_session'>;

export type JsonlSessionSpec = {
  key: 'omp' | 'pi';
  sourceKind: JsonlSessionKind;
  /** 自定义根的环境变量名。 */
  homeEnv: string;
  /** 环境变量缺失时的默认根目录名。 */
  homeDir: string;
};

type WindowMessage = { role: string; content: unknown[] };

type JsonlState = {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  messages: WindowMessage[];
  lastUserMs: number | null;
};

const FILE_UUID = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

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

/** 会话文件名 `<timestamp>_<uuid>.jsonl` 里的 UUID；没有就返回 null。 */
function sessionIdFromFile(name: string): string | null {
  const match = basename(name).match(FILE_UUID);
  return match === null ? null : match[1]!;
}

function contentOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return null;
}

/** assistant 块换成 anthropic 形状；thinking 的签名不进入正文。 */
function mapAssistantBlocks(blocks: unknown[]): unknown[] {
  const mapped: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = textOf(block.type);
    if (type === 'thinking') {
      const thinking = textOf(block.thinking);
      if (thinking !== null) mapped.push({ type: 'thinking', thinking });
    } else if (type === 'text') {
      const text = textOf(block.text);
      if (text !== null) mapped.push({ type: 'text', text });
    } else if (type === 'toolCall') {
      const id = textOf(block.id);
      const name = textOf(block.name);
      if (id !== null && name !== null) {
        mapped.push({ type: 'tool_use', id, name, input: block.arguments ?? {} });
      }
    }
  }
  return mapped;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? block.text : '')
    .join('');
}

function usageOf(usage: Record<string, unknown> | null): SessionCall['usage'] {
  if (usage === null) return null;
  const input = numberOrNull(usage.input);
  const output = numberOrNull(usage.output);
  if (input === null || output === null) return null;
  // Pi 的 totalTokens 含 cacheRead；magpie 口径的 input 不含缓存，直接用 input。
  return {
    input,
    output,
    cacheRead: numberOrNull(usage.cacheRead) ?? 0,
    cacheWrite: numberOrNull(usage.cacheWrite) ?? 0,
  };
}

/** 调用开始时间：消息自带时间优先，否则由完成时间减去取整后的 duration 推回。 */
function startedMsOf(message: Record<string, unknown>, lineAtMs: number | null): number | null {
  const own = timestampOf(message.timestamp);
  if (own !== null) return own;
  const completedAt = timestampOf(message.completedAt);
  const duration = typeof message.duration === 'number' && Number.isFinite(message.duration)
    ? Math.round(message.duration) : null;
  if (completedAt !== null && duration !== null) return completedAt - duration;
  return lineAtMs;
}

function errorResult(state: JsonlState, reason: string): SessionApplyResult {
  return { state, calls: [], error: reason, sessionId: state.sessionId };
}

function applyEvent(
  spec: JsonlSessionSpec,
  state: JsonlState,
  event: SessionParseResult & { kind: 'event' },
): SessionApplyResult {
  const record = event.value;
  if (!isRecord(record)) return errorResult(state, `${spec.key}_line_invalid`);
  const type = textOf(record.type);
  const lineAtMs = timestampOf(record.timestamp);

  if (type === 'session') {
    const id = textOf(record.id);
    if (id !== null) state.sessionId = canonicalSessionId(id);
    const cwd = textOf(record.cwd);
    if (cwd !== null) state.cwd = cwd;
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }
  if (type !== 'message') {
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }

  const message = isRecord(record.message) ? record.message : null;
  if (message === null) return errorResult(state, `${spec.key}_message_body_missing`);
  const role = textOf(message.role);
  if (role === null) return errorResult(state, `${spec.key}_message_role_missing`);
  const content = contentOf(message.content);
  if (content === null) return errorResult(state, `${spec.key}_message_content_invalid`);
  const messageAtMs = timestampOf(message.timestamp) ?? lineAtMs;

  if (role === 'user') {
    state.messages = [...state.messages, { role: 'user', content }];
    state.lastUserMs = messageAtMs ?? state.lastUserMs;
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }

  if (role === 'toolResult') {
    const toolCallId = textOf(message.toolCallId);
    if (toolCallId === null) return errorResult(state, `${spec.key}_tool_result_id_missing`);
    const block: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: toolResultText(message.content),
    };
    if (message.isError === true) block.is_error = true;
    state.messages = [...state.messages, { role: 'user', content: [block] }];
    state.lastUserMs = messageAtMs ?? state.lastUserMs;
    return { state, calls: [], error: null, sessionId: state.sessionId };
  }

  if (role !== 'assistant') return errorResult(state, `${spec.key}_message_role_invalid`);

  const sessionId = state.sessionId;
  if (sessionId === null) return errorResult(state, `${spec.key}_session_missing`);
  const startedMs = startedMsOf(message, lineAtMs);
  if (startedMs === null) return errorResult(state, `${spec.key}_message_time_missing`);

  const model = textOf(message.model) ?? state.model;
  const responseId = textOf(message.responseId);
  const reply = mapAssistantBlocks(content);
  const call: SessionCall = {
    sessionId,
    subagentId: null,
    convKey: sessionConvKey(sessionId),
    callId: responseId ?? String(event.offset),
    sortOffset: event.offset,
    parentSessionId: null,
    startedMs,
    model,
    responseIdNorm: normalizeResponseId(responseId),
    turnRef: null,
    usage: usageOf(isRecord(message.usage) ? message.usage : null),
    reasoning: null,
    requestMessages: [...state.messages],
    replyContent: reply,
    cwd: state.cwd,
  };
  // 助手消息在结算后进窗口，供下一笔调用作为上下文。
  state.messages = [...state.messages, { role: 'assistant', content: reply }];
  state.model = model;
  return { state, calls: [call], error: null, sessionId };
}

export function createJsonlSessionAdapter(spec: JsonlSessionSpec): SessionAdapter {
  return {
    agent: spec.key,
    sourceKind: spec.sourceKind,
    issueKind: `${spec.key}_session`,
    evidenceKind: `${spec.key}_session_call`,
    bodyProtocol: 'anthropic',
    sortSource: `${spec.key}_session`,
    mutable: false,
    replaysState: true,
    batch: jsonlBatch(),

    roots(env, home = homedir()) {
      const base = env[spec.homeEnv]?.trim();
      const root = base !== undefined && base.length > 0 ? base : join(home, spec.homeDir);
      return [join(root, 'agent', 'sessions')];
    },

    discover(root, cursorFor) {
      return discoverJsonl(root, cursorFor);
    },

    read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
      return jsonlRead(file, cursor, spec.sourceKind);
    },

    parse(text: string): SessionParseResult {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { kind: 'invalid', reason: `${spec.key}_invalid_json` };
      }
      if (!isRecord(value)) return { kind: 'invalid', reason: `${spec.key}_invalid_object` };
      const type = textOf(value.type) ?? 'other';
      if (type !== 'session' && type !== 'message') return { kind: 'ignore' };
      return {
        kind: 'event',
        lineType: type,
        atMs: timestampOf(value.timestamp),
        sessionId: textOf(value.id),
        offset: 0,
        value,
      };
    },

    emptyState(file?: SessionFile): JsonlState {
      const id = file === undefined ? null : sessionIdFromFile(file.name);
      return {
        sessionId: id === null ? null : canonicalSessionId(id),
        cwd: null,
        model: null,
        messages: [],
        lastUserMs: null,
      };
    },

    apply(state, event) {
      return applyEvent(spec, state as JsonlState, event);
    },
  };
}
