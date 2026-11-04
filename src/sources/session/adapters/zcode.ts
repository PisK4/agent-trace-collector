/**
 * Zcode 本地 SQLite 会话适配器。
 *
 * 一个库里有三张相关的表：`session` 是会话树，`message` / `part` 是正文，
 * `model_usage` 是逐次尝试的用量。调用单位是 assistant 消息：同一消息的多次
 * 尝试只取第一笔 completed，行号（rowid）就是游标位置。
 *
 * 请求体从 message/part 重建 Anthropic 形状；时间窗口截止到本批最后一笔
 * assistant 消息，子代理沿 parent_id 折叠到根会话。
 */

import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SourceCursor, SourceRead } from '../../files';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult,
} from '../types';
import { sessionConvKey } from '../types';

type SessionRow = {
  id: string;
  parent_id: string | null;
  directory: string | null;
};

type UsageRow = {
  off: number;
  session_id: string;
  assistant_message_id: string | null;
  started_at: number | null;
  model_id: string | null;
  turn_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};

type MessageRow = {
  id: string;
  time_created: number | null;
  data: string;
};

type PartRow = {
  message_id: string;
  data: string;
};

const BATCH_ROWS = 64;
const MAX_PARENT_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dbPathOf(root: string): string {
  return join(root, 'db.sqlite');
}

function emptyRead(file: SessionFile, cursor: SourceCursor | null, generation: string): SourceRead {
  const off = cursor?.committedOff ?? 0;
  return {
    sourceKind: 'zcode_session',
    name: file.name,
    generation,
    rewriteEpoch: 0,
    committedOff: off,
    observedOff: off,
    seenSize: cursor?.seenSize ?? 0,
    headLen: 0,
    headHash: null,
    fingerprint: null,
    mode: 'appendable',
    state: 'unchanged',
    lines: [],
    issues: [],
    startOff: off,
    error: null,
  };
}

function errorRead(file: SessionFile, cursor: SourceCursor | null, generation: string): SourceRead {
  const off = cursor?.committedOff ?? 0;
  return {
    sourceKind: 'zcode_session',
    name: file.name,
    generation,
    rewriteEpoch: 0,
    committedOff: off,
    observedOff: cursor?.observedOff ?? off,
    seenSize: cursor?.seenSize ?? 0,
    headLen: 0,
    headHash: null,
    fingerprint: null,
    mode: 'appendable',
    state: 'error',
    lines: [],
    issues: [],
    startOff: off,
    error: 'zcode_db_unreadable',
  };
}

/**
 * 一条 message/part 映射成 Anthropic 内容块。
 * user 侧的工具结果与 assistant 侧的工具调用来自同一个 `tool` part。
 */
function blockOf(role: 'user' | 'assistant', data: Record<string, unknown>): unknown | null {
  switch (data.type) {
    case 'text': {
      const text = textOf(data.text);
      return text === null ? null : { type: 'text', text };
    }
    case 'reasoning': {
      if (role !== 'assistant') return null;
      const thinking = textOf(data.text);
      return thinking === null ? null : { type: 'thinking', thinking };
    }
    case 'tool': {
      const callId = textOf(data.callID);
      if (callId === null) return null;
      const state = isRecord(data.state) ? data.state : {};
      if (role === 'assistant') {
        return {
          type: 'tool_use',
          id: callId,
          name: textOf(data.tool) ?? '',
          input: state.input ?? {},
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: callId,
        content: state.output ?? null,
        is_error: state.status === 'error',
      };
    }
    default:
      // step-start / step-finish / timeline / compaction / file 不进请求体。
      return null;
  }
}

function blocksOf(role: 'user' | 'assistant', parts: readonly PartRow[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of parts) {
    const data = parseJson(part.data);
    if (!isRecord(data)) continue;
    const block = blockOf(role, data);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function roleOf(data: string): 'user' | 'assistant' | null {
  const value = parseJson(data);
  if (!isRecord(value)) return null;
  return value.role === 'user' || value.role === 'assistant' ? value.role : null;
}

/** 会话树折叠：沿 parent_id 向上最多 8 层，找不到父行时停在当前 id。 */
function rootSessionOf(db: Database, sessionId: string, cache: Map<string, SessionRow | null>): SessionRow | null {
  let current = sessionId;
  let row = cache.get(current);
  if (row === undefined) {
    row = db.query<SessionRow, [string]>(
      'SELECT id,parent_id,directory FROM session WHERE id=?',
    ).get(current) ?? null;
    cache.set(current, row);
  }
  if (row === null) return null;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parent = textOf(row.parent_id);
    if (parent === null) return row;
    current = parent;
    let next = cache.get(current);
    if (next === undefined) {
      next = db.query<SessionRow, [string]>(
        'SELECT id,parent_id,directory FROM session WHERE id=?',
      ).get(current) ?? null;
      cache.set(current, next);
    }
    if (next === null) return row;
    row = next;
  }
  return row;
}

function sessionIdOfName(name: string): string {
  const at = name.lastIndexOf('#');
  return at < 0 ? name : name.slice(at + 1);
}

export const zcodeAdapter: SessionAdapter = {
  agent: 'zcode',
  sourceKind: 'zcode_session',
  issueKind: 'zcode_session',
  evidenceKind: 'zcode_session_call',
  bodyProtocol: 'anthropic',
  sortSource: 'zcode_session',
  mutable: false,
  replaysState: false,
  // 本地库是物化行，整段请求上下文已在正文层按块去重；原始层再存一份会按
  // 调用重复整段窗口（实测单条约 288 KB），回填几个会话就是 GB 级。
  storesRaw: false,
  batch: { maxFiles: 64, maxBytes: Number.POSITIVE_INFINITY },

  roots(env, home = homedir()) {
    const base = env.ZCODE_HOME?.trim();
    return [join(base !== undefined && base.length > 0 ? base : join(home, '.zcode'), 'cli', 'db')];
  },

  discover(root, cursorFor) {
    const dbPath = dbPathOf(root);
    let stat;
    try {
      stat = statSync(dbPath);
    } catch (error) {
      // 库不存在不是错误：Zcode 没装或还没建库；其余读不出交给引擎记 root_unreadable。
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    if (!stat.isFile()) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      const sessions = db.query<SessionRow, []>(
        'SELECT id,parent_id,directory FROM session WHERE time_deleted IS NULL',
      ).all();
      return sessions.map((session): SessionFile => {
        const max = db.query<{ max_rowid: number }, [string]>(`
          SELECT COALESCE(MAX(rowid),0) AS max_rowid FROM model_usage
          WHERE session_id=? AND status='completed' AND assistant_message_id IS NOT NULL`).get(session.id);
        const maxRowid = max?.max_rowid ?? 0;
        const name = `${dbPath}#${session.id}`;
        const cursor = cursorFor(name);
        const remaining = cursor === null
          ? (maxRowid > 0 ? 1 : 0)
          : Math.max(0, maxRowid - cursor.committedOff);
        return { name, path: dbPath, size: maxRowid, mtimeMs: stat.mtimeMs, remaining };
      });
    } finally {
      db.close();
    }
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    const sessionId = sessionIdOfName(file.name);
    let db: Database | null = null;
    let generation = '';
    try {
      db = new Database(file.path, { readonly: true });
      const stat = statSync(file.path);
      let applied = 0;
      try {
        applied = db.query<{ applied: number | null }, []>(
          'SELECT MAX(time_applied) AS applied FROM schema_migration',
        ).get()?.applied ?? 0;
      } catch {
        // 老库没有 schema_migration：代际只按文件身份。
      }
      generation = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${applied}`;
      const startOff = cursor !== null && cursor.generation === generation
        ? cursor.committedOff
        : 0;

      const calls = db.query<UsageRow, [string, number]>(`
        SELECT * FROM (
          SELECT rowid AS off, *,
            ROW_NUMBER() OVER (PARTITION BY assistant_message_id ORDER BY attempt_index, rowid) AS rn
          FROM model_usage
          WHERE session_id=? AND rowid>? AND status='completed' AND assistant_message_id IS NOT NULL
        ) WHERE rn=1 ORDER BY off LIMIT ${BATCH_ROWS}`).all(sessionId, startOff);

      if (calls.length === 0) {
        const seen = db.query<{ max_rowid: number }, [string]>(
          'SELECT COALESCE(MAX(rowid),0) AS max_rowid FROM model_usage WHERE session_id=?',
        ).get(sessionId)?.max_rowid ?? 0;
        const read = emptyRead(file, cursor, generation);
        read.startOff = startOff;
        read.committedOff = startOff;
        read.observedOff = startOff;
        read.seenSize = seen;
        return Promise.resolve(read);
      }

      // 正文窗口截止到本批最后一笔 assistant 消息；先取各消息的创建时间。
      let cutoff = 0;
      for (const call of calls) {
        if (call.assistant_message_id === null) continue;
        const at = db.query<{ time_created: number | null }, [string]>(
          'SELECT time_created FROM message WHERE id=?',
        ).get(call.assistant_message_id)?.time_created;
        if (at !== null && at !== undefined) cutoff = Math.max(cutoff, at);
      }
      if (cutoff === 0) cutoff = Number.MAX_SAFE_INTEGER;

      // shortcut: 整段窗口一次读入，超大会话需要按需分页，等出现真实卡顿再升级。
      const messages = db.query<MessageRow, [string, number]>(`
        SELECT id,time_created,data FROM message
        WHERE session_id=? AND time_created<=?
        ORDER BY time_created,sequence,rowid`).all(sessionId, cutoff);
      const parts = db.query<PartRow, [string, number]>(`
        SELECT p.message_id AS message_id, p.data AS data
        FROM part p JOIN message m ON m.id=p.message_id
        WHERE p.session_id=? AND m.time_created<=?
        ORDER BY p.time_created,p.sequence,p.rowid`).all(sessionId, cutoff);

      const partsByMessage = new Map<string, PartRow[]>();
      for (const part of parts) {
        const list = partsByMessage.get(part.message_id);
        if (list === undefined) partsByMessage.set(part.message_id, [part]);
        else list.push(part);
      }
      type WindowMessage = { id: string; role: 'user' | 'assistant'; blocks: unknown[] };
      const window: WindowMessage[] = [];
      const windowIndex = new Map<string, number>();
      for (const message of messages) {
        const role = roleOf(message.data);
        if (role === null) continue;
        const blocks = blocksOf(role, partsByMessage.get(message.id) ?? []);
        // 空 content 的消息跳过：请求体里放空块反而会改变上下文形状。
        if (blocks.length === 0) continue;
        windowIndex.set(message.id, window.length);
        window.push({ id: message.id, role, blocks });
      }

      const sessionCache = new Map<string, SessionRow | null>();
      const ownSession = sessionCache.get(sessionId) ?? db.query<SessionRow, [string]>(
        'SELECT id,parent_id,directory FROM session WHERE id=?',
      ).get(sessionId) ?? null;
      sessionCache.set(sessionId, ownSession);
      const root = rootSessionOf(db, sessionId, sessionCache) ?? ownSession;
      const rootId = root?.id ?? sessionId;
      const convKey = sessionConvKey(rootId);
      const ownParent = ownSession === null ? null : textOf(ownSession.parent_id);
      const subagentId = ownParent === null ? null : sessionId;

      const lines: SourceRead['lines'] = [];
      let committedOff = startOff;
      let observedOff = startOff;
      for (const row of calls) {
        committedOff = row.off;
        observedOff = row.off;
        const assistantId = row.assistant_message_id;
        if (assistantId === null) continue;
        const inputTokens = numberOrNull(row.input_tokens);
        const outputTokens = numberOrNull(row.output_tokens);
        const cacheRead = numberOrNull(row.cache_read_input_tokens) ?? 0;
        const cacheWrite = numberOrNull(row.cache_creation_input_tokens) ?? 0;
        const index = windowIndex.get(assistantId);
        const reply = index === undefined ? [] : window[index]!.blocks;
        const requestMessages = (index === undefined ? window : window.slice(0, index))
          .map(message => ({ role: message.role, content: message.blocks }));
        const call: SessionCall = {
          sessionId: rootId,
          subagentId,
          convKey,
          callId: assistantId,
          sortOffset: row.off,
          parentSessionId: ownParent,
          startedMs: numberOrNull(row.started_at) ?? 0,
          model: textOf(row.model_id),
          responseIdNorm: null,
          turnRef: textOf(row.turn_id),
          usage: inputTokens === null || outputTokens === null ? null : {
            input: Math.max(0, inputTokens - cacheRead - cacheWrite),
            output: outputTokens,
            cacheRead,
            cacheWrite,
          },
          reasoning: null,
          requestMessages,
          replyContent: reply,
          cwd: textOf(ownSession?.directory ?? null),
        };
        lines.push({ offset: row.off, end: row.off, text: JSON.stringify({ call }) });
      }

      const seen = db.query<{ max_rowid: number }, [string]>(
        'SELECT COALESCE(MAX(rowid),0) AS max_rowid FROM model_usage WHERE session_id=?',
      ).get(sessionId)?.max_rowid ?? 0;
      return Promise.resolve({
        sourceKind: 'zcode_session',
        name: file.name,
        generation,
        rewriteEpoch: 0,
        committedOff,
        observedOff,
        seenSize: seen,
        headLen: 0,
        headHash: null,
        fingerprint: null,
        mode: 'appendable',
        state: 'decoded',
        lines,
        issues: [],
        startOff,
        error: null,
      });
    } catch {
      return Promise.resolve(errorRead(file, cursor, generation));
    } finally {
      db?.close();
    }
  },

  parse(text: string): SessionParseResult {
    const value = parseJson(text);
    if (!isRecord(value)) return { kind: 'invalid', reason: 'zcode_invalid_payload' };
    const call = value.call;
    if (!isRecord(call)) return { kind: 'invalid', reason: 'zcode_invalid_payload' };
    return {
      kind: 'event',
      lineType: 'call',
      atMs: numberOrNull(call.startedMs),
      sessionId: textOf(call.sessionId),
      offset: 0,
      value: call,
    };
  },

  emptyState(): unknown {
    return {};
  },

  apply(state, event): SessionApplyResult {
    const call = event.value as SessionCall;
    return {
      state,
      calls: [call],
      error: null,
      sessionId: typeof call.sessionId === 'string' ? call.sessionId : null,
    };
  },
};
