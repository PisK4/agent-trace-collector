/**
 * Grok 本地会话适配器。
 *
 * 一次会话是一个目录：`<cwd>/<session-uuid>/` 下 `chat_history.jsonl` 是可追加
 * 的消息流，其余文件（summary.json、usage.json、events.jsonl 等）是旁路快照。
 * 发现只认 chat_history，一个目录一条流；会话 id 取目录名，因为流里的行既没有
 * session id 也没有时间戳与逐笔用量。
 *
 * 一条 assistant 行算一笔调用，callId 用它的物理行偏移（追加不变、跨会话唯一）。
 * 消息窗口按行序重建：system/user/tool_result/assistant 进请求体，reasoning 挂到
 * 下一笔 assistant 的回执，不认识的行型只跳过，不判坏。
 *
 * 用量口径：四段累计值只在 usage.json 的会话级快照里，逐笔没有。单笔 usage 留
 * null，不摊、不拿 0 冒充；累计值由 afterFile 写 session_usage。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { readBatch } from '../../files';
import type { SourceCursor, SourceRead } from '../../files';
import { recordIssue } from '../../../reconcile';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult,
} from '../types';
import { canonicalSessionId, sessionConvKey } from '../types';

const HISTORY = 'chat_history.jsonl';
const USAGE = 'usage.json';
const SUMMARY = 'summary.json';
const EVIDENCE_KIND = 'grok_session_call';
const ISSUE_KIND = 'grok_session';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 只认有限数；usage.json 的计数偶尔会是字符串或 null，不猜。 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function timestampOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 会话根：<cwd>/<session-uuid>/；chat_history 的父目录就是会话目录。 */
function sessionIdOf(file: SessionFile): string {
  return canonicalSessionId(basename(dirname(file.path)));
}

type GrokState = {
  sessionId: string;
  convKey: string;
  cwd: string | null;
  model: string | null;
  /** chat_history 行没有时间：会话起点取自 summary.json，按调用序号递增。 */
  startedMs: number;
  callSeq: number;
  /** 截至当前 assistant 行之前的完整消息窗口，形状按 chat 协议解释。 */
  messages: unknown[];
  /** 最近一条 reasoning 行的可读摘要，作为下一笔 assistant 回复的首块。 */
  pendingReasoning: string | null;
};

function sessionUsagePath(file: SessionFile): string {
  return join(dirname(file.path), USAGE);
}

function usageValues(db: Database, sessionId: string, path: string, now: number): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // 新会话或短会话可能还没写 usage.json；文件消失不删旧行。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordIssue(db, ISSUE_KIND, `${sessionId}/usage`, 'grok_usage_unreadable', now, null);
    }
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    recordIssue(db, ISSUE_KIND, `${sessionId}/usage`, 'grok_usage_invalid_json', now,
      Buffer.byteLength(text));
    return 0;
  }
  if (!isRecord(parsed) || !isRecord(parsed.session)) {
    recordIssue(db, ISSUE_KIND, `${sessionId}/usage`, 'grok_usage_invalid_shape', now,
      Buffer.byteLength(text));
    return 0;
  }
  const session = parsed.session;
  const hash = createHash('sha256').update(text).digest('hex');
  const existing = db.query<{ source_hash: string }, [string, string]>(
    'SELECT source_hash FROM session_usage WHERE agent=? AND session=?',
  ).get('grok', sessionId);
  if (existing !== null && existing !== undefined && existing.source_hash === hash) return 0;
  // magpie 口径：input 不含缓存读写；usage.json 的 inputTokens 含缓存。
  const input = numberOrNull(session.inputTokens);
  const output = numberOrNull(session.outputTokens);
  const cacheRead = numberOrNull(session.cachedReadTokens);
  const cacheWrite = numberOrNull(session.cacheCreationTokens);
  const thinking = numberOrNull(session.reasoningTokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null
    && thinking === null && textOf(session.primaryModelId) === null) return 0;
  const costTicks = numberOrNull(session.costUsdTicks);
  db.run(
    `INSERT INTO session_usage(
       agent,session,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
       thinking_tokens,factory_credits,source_path,source_hash,observed_at)
     VALUES ('grok',?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(agent,session) DO UPDATE SET
       model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
       cache_creation_tokens=excluded.cache_creation_tokens,cache_read_tokens=excluded.cache_read_tokens,
       thinking_tokens=excluded.thinking_tokens,factory_credits=excluded.factory_credits,
       source_path=excluded.source_path,source_hash=excluded.source_hash,observed_at=excluded.observed_at
     WHERE session_usage.source_hash<>excluded.source_hash`,
    [
      sessionId, textOf(session.primaryModelId),
      input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
      output, cacheWrite, cacheRead, thinking,
      costTicks === null ? null : costTicks / 1e8,
      path, hash, now,
    ],
  );
  return 1;
}

/** 会话起点与 cwd/模型来自 summary.json；缺字段时退回文件 mtime 与 null。 */
function summaryOf(file: SessionFile): { startedMs: number; cwd: string | null; model: string | null } {
  const fallback = { startedMs: file.mtimeMs, cwd: null, model: null };
  let text: string;
  try {
    text = readFileSync(join(dirname(file.path), SUMMARY), 'utf8');
  } catch {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const info = isRecord(parsed.info) ? parsed.info : null;
  return {
    startedMs: timestampOf(parsed.created_at) ?? fallback.startedMs,
    cwd: textOf(info?.cwd),
    model: textOf(parsed.current_model_id),
  };
}

/** 把 chat_history 的一行映射成重建正文里的一条消息；不认识的形状跳过。 */
function messageOf(line: Record<string, unknown>): unknown | null {
  const type = textOf(line.type);
  if (type === 'system') {
    const content = textOf(line.content);
    return content === null ? null : { role: 'system', content };
  }
  if (type === 'user') {
    // user.content 是 [{type:'text', text}] 数组，原样保留。
    return Array.isArray(line.content) ? { role: 'user', content: line.content } : null;
  }
  if (type === 'tool_result') {
    const id = textOf(line.tool_call_id);
    return { role: 'tool', tool_call_id: id, content: line.content ?? null };
  }
  if (type === 'assistant') {
    const blocks: unknown[] = [];
    const content = textOf(line.content);
    if (content !== null) blocks.push({ type: 'text', text: content });
    if (Array.isArray(line.tool_calls)) {
      for (const raw of line.tool_calls) {
        if (!isRecord(raw)) continue;
        const id = textOf(raw.id);
        if (id === null) continue;
        blocks.push({
          type: 'tool_use', id, name: textOf(raw.name) ?? '',
          input: raw.arguments ?? {},
        });
      }
    }
    return { role: 'assistant', content: blocks };
  }
  return null;
}

function callOf(state: GrokState, event: SessionParseResult & { kind: 'event' },
  line: Record<string, unknown>): SessionCall {
  const startedMs = state.startedMs + state.callSeq * 1_000;
  state.callSeq += 1;
  const blocks: unknown[] = [];
  // reasoning 行的可读摘要进回复正文；request.reasoning 是 token 数列，留 null。
  if (state.pendingReasoning !== null) {
    blocks.push({ type: 'thinking', thinking: state.pendingReasoning });
  }
  const content = textOf(line.content);
  if (content !== null) blocks.push({ type: 'text', text: content });
  if (Array.isArray(line.tool_calls)) {
    for (const raw of line.tool_calls) {
      if (!isRecord(raw)) continue;
      const id = textOf(raw.id);
      if (id === null) continue;
      blocks.push({
        type: 'tool_use', id, name: textOf(raw.name) ?? '',
        input: raw.arguments ?? {},
      });
    }
  }
  return {
    sessionId: state.sessionId,
    subagentId: null,
    convKey: state.convKey,
    callId: `off:${event.offset}`,
    sortOffset: event.offset,
    parentSessionId: null,
    startedMs,
    model: textOf(line.model_id) ?? state.model,
    responseIdNorm: null,
    turnRef: null,
    usage: null,
    // 没有逐笔 reasoning token；文本摘要进 replyContent 的 thinking 块。
    reasoning: null,
    requestMessages: [...state.messages],
    replyContent: blocks,
    cwd: state.cwd,
  };
}

export const grokAdapter: SessionAdapter = {
  agent: 'grok',
  sourceKind: 'grok_session',
  issueKind: ISSUE_KIND,
  evidenceKind: EVIDENCE_KIND,
  bodyProtocol: 'chat',
  sortSource: 'grok_session',
  mutable: false,
  replaysState: true,
  batch: { maxFiles: 64, maxBytes: 2 * 1024 * 1024 },

  roots(env, home = homedir()) {
    // magpie 的 GrokDir：GROK_HOME 优先，否则 ~/.grok。
    const base = env.GROK_HOME?.trim();
    return [join(base !== undefined && base.length > 0 ? base : join(home, '.grok'), 'sessions')];
  },

  discover(root, cursorFor) {
    let cwdDirs;
    try {
      cwdDirs = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: SessionFile[] = [];
    for (const cwdDir of cwdDirs) {
      if (!cwdDir.isDirectory()) continue;
      const cwdPath = join(root, cwdDir.name);
      let sessions;
      try {
        sessions = readdirSync(cwdPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const path = join(cwdPath, session.name, HISTORY);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          // 会话目录没有 chat_history.jsonl：还没写入或已被回收，不建流。
          continue;
        }
        if (!stat.isFile()) continue;
        const cursor = cursorFor(path);
        const remaining = cursor === null
          ? stat.size
          : cursor.seenSize === stat.size
            ? Math.max(0, stat.size - cursor.committedOff)
            // 截断或原地重写：整份重读，与 JSONL 适配器一致。
            : stat.size;
        files.push({ name: path, path, size: stat.size, mtimeMs: stat.mtimeMs, remaining });
      }
    }
    return files;
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return readBatch(file.path, cursor, { kind: 'grok_session', name: file.name });
  },

  parse(text: string): SessionParseResult {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // 坏行（含半写的尾部）停游标，由共用摄入记 issue。
      return { kind: 'invalid', reason: 'grok_invalid_json' };
    }
    if (!isRecord(value)) return { kind: 'invalid', reason: 'grok_invalid_object' };
    // 行里没有时间：atMs 留 null，startedMs 由会话起点与序号合成。
    const type = textOf(value.type) ?? 'other';
    if (type !== 'system' && type !== 'user' && type !== 'assistant'
      && type !== 'reasoning' && type !== 'tool_result'
      && type !== 'text' && type !== 'summary_text') return { kind: 'ignore' };
    return {
      kind: 'event', lineType: type, atMs: null, sessionId: null, offset: 0, value,
    };
  },

  emptyState(file?: SessionFile): GrokState {
    if (file === undefined) {
      return {
        sessionId: '', convKey: '', cwd: null, model: null, startedMs: 0,
        callSeq: 0, messages: [], pendingReasoning: null,
      };
    }
    const meta = summaryOf(file);
    const sessionId = sessionIdOf(file);
    return {
      sessionId,
      convKey: sessionConvKey(sessionId),
      cwd: meta.cwd,
      model: meta.model,
      startedMs: meta.startedMs,
      callSeq: 0,
      messages: [],
      pendingReasoning: null,
    };
  },

  apply(state, event): SessionApplyResult {
    const current = state as GrokState;
    const line = event.value;
    if (!isRecord(line)) {
      return { state, calls: [], error: 'grok_line_invalid', sessionId: current.sessionId };
    }
    const type = textOf(line.type) ?? 'other';
    // reasoning 是下一笔 assistant 的思考文本；summary 是数组里的一段段摘要。
    if (type === 'reasoning') {
      const summary = line.summary;
      const text = Array.isArray(summary)
        ? summary.map(part => isRecord(part) ? textOf(part.text) ?? '' : '').join('')
        : null;
      current.pendingReasoning = text !== null && text.length > 0 ? text : null;
      return { state, calls: [], error: null, sessionId: current.sessionId };
    }
    if (type === 'text' || type === 'summary_text') {
      // 与调用边界无关的正文片段：只落原始层，不进窗口，不判坏。
      return { state, calls: [], error: null, sessionId: current.sessionId };
    }
    const message = messageOf(line);
    if (message === null) {
      return { state, calls: [], error: null, sessionId: current.sessionId };
    }
    if (type === 'assistant') {
      const call = callOf(current, event, line);
      current.pendingReasoning = null;
      current.messages = [...current.messages, message];
      return { state, calls: [call], error: null, sessionId: current.sessionId };
    }
    current.messages = [...current.messages, message];
    return { state, calls: [], error: null, sessionId: current.sessionId };
  },

  afterFile(db, state, file, now) {
    const current = state as GrokState;
    if (current.sessionId.length === 0) return 0;
    return usageValues(db, current.sessionId, sessionUsagePath(file), now);
  },
};
