/**
 * Hermes Agent 本地 SQLite 会话适配器。
 *
 * `~/.hermes/state.db` 的 `messages` 是物化行，展示顺序不是插入序：Hermes
 * 自己按 `display_order` 取槽位，同槽按 `active DESC, id DESC` 选一行，只
 * 展示 `active = 1` 或 `compacted = 1` 的行（rewind 丢弃的行是 `0/0`，不进
 * 展示）。本适配器照抄这组规则：顺序用 `display_order`，调用身份用
 * `messages.id`，逐笔用量不可得，累计值由 `afterFile` 写 `session_usage`。
 *
 * 会话坐标优先用首条 user 消息的 magpie 摘要（与 `src/hook.ts` 的
 * `convDigestOf` 同口径）；摘要在本库不唯一（同 prompt 的 oneshot 会话会
 * 撞）或算不出时，退回本地会话 id，不猜时间近邻。
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
import { convDigestOf } from '../../../conv-digest';

const BATCH_CALLS = 64;
const MAX_PARENT_DEPTH = 8;
const DB_FILE = 'state.db';

type SessionRow = {
  id: string;
  parent_session_id: string | null;
  model: string | null;
  cwd: string | null;
  started_at: number | null;
};

type MessageRow = {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  display_order: number;
  display_metadata: string | null;
  active: number;
  compacted: number;
  timestamp: number | null;
  reasoning: string | null;
  reasoning_content: string | null;
  message_uid: string | null;
};

type UsageRow = {
  model: string | null;
  api_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
};

const MESSAGE_COLUMNS = `id,role,content,tool_calls,tool_call_id,tool_name,display_order,
  display_metadata,active,compacted,timestamp,reasoning,reasoning_content,message_uid`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  return join(root, DB_FILE);
}

function sessionIdOfName(name: string): string {
  const at = name.lastIndexOf('#');
  return at < 0 ? name : name.slice(at + 1);
}

/** 展示可见性：模型专用行不进展示（`DISPLAY_VISIBLE_SQL` 的 Python 孪生）。 */
function isModelOnly(row: MessageRow): boolean {
  if (row.display_metadata === null) return false;
  const metadata = parseJson(row.display_metadata);
  return isRecord(metadata) && Boolean(metadata.model_only);
}

/**
 * 后出现的工具副本不进展示：同 `(message_uid, timestamp)` 已有一条更早槽位的
 * 归档工具行时，后来的副本是重复投递。照抄 Hermes 的展示投影：可见行按槽位
 * 分组，同槽取 active DESC, id DESC。
 */
function displayRowsOf(rows: readonly MessageRow[]): MessageRow[] {
  const originalKeys = new Map<string, number>();
  for (const row of rows) {
    if (row.role !== 'tool' || row.message_uid === null) continue;
    if (row.active !== 0 || row.compacted !== 1 || isModelOnly(row)) continue;
    const key = `${row.message_uid}\u0000${row.timestamp ?? ''}`;
    const previous = originalKeys.get(key);
    if (previous === undefined || row.display_order < previous) originalKeys.set(key, row.display_order);
  }
  const bySlot = new Map<number, MessageRow>();
  for (const row of rows) {
    if (row.active !== 1 && row.compacted !== 1) continue;
    if (isModelOnly(row)) continue;
    if (row.role === 'tool' && row.message_uid !== null) {
      const earlier = originalKeys.get(`${row.message_uid}\u0000${row.timestamp ?? ''}`);
      if (earlier !== undefined && earlier < row.display_order) continue;
    }
    const current = bySlot.get(row.display_order);
    if (current === undefined || row.active > current.active
      || (row.active === current.active && row.id > current.id)) {
      bySlot.set(row.display_order, row);
    }
  }
  return [...bySlot.values()].sort((a, b) => a.display_order - b.display_order);
}

/** Hermes 存的是 chat 形状：content 文本 + assistant 的 tool_calls。 */
function blocksOf(row: MessageRow): unknown[] {
  const blocks: unknown[] = [];
  if (row.content !== null && row.content.length > 0) {
    blocks.push({ type: 'text', text: row.content });
  }
  if (row.role !== 'assistant' || row.tool_calls === null || row.tool_calls.length === 0) {
    return blocks;
  }
  const calls = parseJson(row.tool_calls);
  if (!Array.isArray(calls)) return blocks;
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : null;
    const id = textOf(call.id) ?? textOf(call.call_id);
    if (id === null) continue;
    blocks.push({
      type: 'tool_use',
      id,
      name: textOf(fn?.name) ?? '',
      input: fn?.arguments ?? {},
    });
  }
  return blocks;
}

function windowMessage(row: MessageRow): Record<string, unknown> | null {
  const blocks = blocksOf(row);
  if (blocks.length === 0) return null;
  if (row.role === 'tool') {
    return { role: 'tool', tool_call_id: row.tool_call_id, content: blocks };
  }
  return { role: row.role, content: blocks };
}

/** 沿 parent_session_id 折叠到根会话；找不到父行时停在当前。 */
function rootSessionOf(db: Database, session: SessionRow): SessionRow {
  let current = session;
  const seen = new Set([session.id]);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parentId = textOf(current.parent_session_id);
    if (parentId === null || seen.has(parentId)) return current;
    const parent = db.query<SessionRow, [string]>(
      'SELECT id,parent_session_id,model,cwd,started_at FROM sessions WHERE id=?',
    ).get(parentId);
    if (parent === null) return current;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

/** 展示集里的首条 user：与 Hermes 的时间线投影同一组过滤与同槽裁决。 */
function firstUserOf(db: Database, sessionId: string): string | null {
  const row = db.query<{ content: string | null }, [string]>(`
    SELECT content FROM messages
    WHERE session_id=? AND role='user' AND (active=1 OR compacted=1)
      AND COALESCE(json_extract(display_metadata,'$.model_only'),0)=0
    ORDER BY display_order, active DESC, id DESC LIMIT 1`).get(sessionId);
  return row?.content ?? null;
}

/**
 * 会话坐标：首条 user 消息的摘要只有在全库唯一时才可用。同一 prompt 的
 * oneshot 会话会算出同一个摘要，那时退回本地会话 id，避免把不同会话并成一条。
 *
 * shortcut: 每次读取扫描全部会话的首条 user 行（本机 159 行），会话量级变大
 * 后再加按库指纹失效的缓存。
 */
function convKeyOf(db: Database, root: SessionRow): string {
  const content = firstUserOf(db, root.id);
  if (content !== null) {
    const target = convDigestOf({ messages: [{ role: 'user', content }] });
    if (target !== null) {
      const firsts = db.query<{ session_id: string; content: string | null }, []>(`
        SELECT session_id, content FROM (
          SELECT m.session_id, m.content,
            ROW_NUMBER() OVER (
              PARTITION BY m.session_id ORDER BY m.display_order, m.active DESC, m.id DESC) rn
          FROM messages m
          WHERE m.role='user' AND (m.active=1 OR m.compacted=1)
            AND COALESCE(json_extract(m.display_metadata,'$.model_only'),0)=0
        ) WHERE rn=1`).all();
      let occurrences = 0;
      for (const first of firsts) {
        if (first.content === null) continue;
        const candidate = convDigestOf({ messages: [{ role: 'user', content: first.content }] });
        if (candidate !== null && candidate.key === target.key) occurrences += 1;
      }
      if (occurrences === 1) return target.key;
    }
  }
  return sessionConvKey(root.id);
}

function modelOf(db: Database, session: SessionRow): string | null {
  if (session.model !== null && session.model.length > 0) return session.model;
  const row = db.query<{ model: string | null }, [string]>(
    'SELECT model FROM session_model_usage WHERE session_id=? ORDER BY api_call_count DESC LIMIT 1',
  ).get(session.id);
  return row?.model ?? null;
}

function emptyRead(file: SessionFile, cursor: SourceCursor | null, generation: string): SourceRead {
  const off = cursor?.committedOff ?? 0;
  return {
    sourceKind: 'hermes_session',
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
    sourceKind: 'hermes_session',
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
    error: 'hermes_db_unreadable',
  };
}

/** 会话累计用量：逐笔没有，只有 (session, model) 聚合行，按键求和。 */
function writeSessionUsage(db: Database, file: SessionFile, now: number): number {
  const sessionId = sessionIdOfName(file.name);
  let source: Database | null = null;
  try {
    source = new Database(file.path, { readonly: true });
    const session = source.query<SessionRow, [string]>(
      'SELECT id,parent_session_id,model,cwd,started_at FROM sessions WHERE id=?',
    ).get(sessionId);
    if (session === null) return 0;
    const root = rootSessionOf(source, session);
    // 子代理的用量留在自己的会话里：主键 (agent, session) 会被子代理覆盖父会话，
    // 而 request 行的 session 已折叠到根，写进去会把两份累计值相加成一份。
    if (root.id !== session.id) return 0;
    const rows = source.query<UsageRow, [string]>(
      `SELECT model,api_call_count,input_tokens,output_tokens,cache_read_tokens,
              cache_write_tokens,reasoning_tokens
       FROM session_model_usage WHERE session_id=?`,
    ).all(sessionId);
    if (rows.length === 0) return 0;
    let calls = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let thinking = 0;
    let model: string | null = null;
    let bestCalls = -1;
    for (const row of rows) {
      calls += row.api_call_count ?? 0;
      input += row.input_tokens ?? 0;
      output += row.output_tokens ?? 0;
      cacheRead += row.cache_read_tokens ?? 0;
      cacheWrite += row.cache_write_tokens ?? 0;
      thinking += row.reasoning_tokens ?? 0;
      if ((row.api_call_count ?? 0) > bestCalls && row.model !== null) {
        bestCalls = row.api_call_count ?? 0;
        model = row.model;
      }
    }
    const hash = createHashOf([model, calls, input, output, cacheRead, cacheWrite, thinking]);
    const existing = db.query<{ source_hash: string }, [string, string]>(
      'SELECT source_hash FROM session_usage WHERE agent=? AND session=?',
    ).get('hermes', root.id);
    if (existing !== null && existing !== undefined && existing.source_hash === hash) return 0;
    db.run(
      `INSERT INTO session_usage(
         agent,session,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
         thinking_tokens,factory_credits,source_path,source_hash,observed_at)
       VALUES ('hermes',?,?,?,?,?,?,?,NULL,?,?,?)
       ON CONFLICT(agent,session) DO UPDATE SET
         model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
         cache_creation_tokens=excluded.cache_creation_tokens,cache_read_tokens=excluded.cache_read_tokens,
         thinking_tokens=excluded.thinking_tokens,source_path=excluded.source_path,
         source_hash=excluded.source_hash,observed_at=excluded.observed_at
       WHERE session_usage.source_hash<>excluded.source_hash`,
      [root.id, model, input, output, cacheWrite, cacheRead, thinking, file.path, hash, now],
    );
    return 1;
  } catch {
    return 0;
  } finally {
    source?.close();
  }
}

function createHashOf(values: readonly unknown[]): string {
  // 聚合值本身就是哈希输入；不需要源文件哈希，值变才刷新同一行。
  const text = JSON.stringify(values);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export const hermesAdapter: SessionAdapter = {
  agent: 'hermes',
  sourceKind: 'hermes_session',
  issueKind: 'hermes_session',
  evidenceKind: 'hermes_session_call',
  bodyProtocol: 'chat',
  sortSource: 'hermes_session',
  attemptState: 'not_applicable',
  mutable: false,
  replaysState: false,
  // 物化行可重读，整段上下文再存一份会按调用重复整段窗口。
  storesRaw: false,
  batch: { maxFiles: 64, maxBytes: Number.POSITIVE_INFINITY },

  roots(env, home = homedir()) {
    const base = env.HERMES_HOME?.trim();
    return [base !== undefined && base.length > 0 ? base : join(home, '.hermes')];
  },

  discover(root, cursorFor) {
    const dbPath = dbPathOf(root);
    let stat;
    try {
      stat = statSync(dbPath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    if (!stat.isFile()) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      const sessions = db.query<{ id: string; max_id: number }, []>(`
        SELECT s.id, COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.session_id=s.id), 0) max_id
        FROM sessions s`).all();
      return sessions.map((session): SessionFile => {
        const name = `${dbPath}#${session.id}`;
        const cursor = cursorFor(name);
        const remaining = cursor === null
          ? (session.max_id > 0 ? 1 : 0)
          : Math.max(0, session.max_id - cursor.committedOff);
        return { name, path: dbPath, size: session.max_id, mtimeMs: stat.mtimeMs, remaining };
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
      let schema = 0;
      try {
        schema = db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get()?.version ?? 0;
      } catch {
        // 没有 schema_version 的旧库：代际只按文件身份。
      }
      generation = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${schema}`;
      const startOff = cursor !== null && cursor.generation === generation
        ? cursor.committedOff
        : 0;

      const session = db.query<SessionRow, [string]>(
        'SELECT id,parent_session_id,model,cwd,started_at FROM sessions WHERE id=?',
      ).get(sessionId);
      if (session === null) {
        const read = emptyRead(file, cursor, generation);
        read.startOff = startOff;
        return Promise.resolve(read);
      }

      const rows = db.query<MessageRow, [string]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id=? ORDER BY display_order,active DESC,id`,
      ).all(sessionId);
      const display = displayRowsOf(rows);
      const maxId = rows.reduce((max, row) => Math.max(max, row.id), 0);

      // 一批只发 BATCH_CALLS 笔；游标覆盖本批最后一行，非调用行不占批次。
      const pending = display.filter(row => row.id > startOff && row.role === 'assistant');
      const batch = pending.slice(0, BATCH_CALLS);
      const lastRow = batch.length === 0 ? null : batch[batch.length - 1]!;
      const committedOff = batch.length < BATCH_CALLS ? Math.max(startOff, maxId) : (lastRow?.id ?? startOff);

      if (batch.length === 0) {
        const read = emptyRead(file, cursor, generation);
        read.startOff = startOff;
        read.committedOff = committedOff;
        read.observedOff = maxId;
        read.seenSize = maxId;
        return Promise.resolve(read);
      }

      const root = rootSessionOf(db, session);
      const convKey = convKeyOf(db, root);
      const model = modelOf(db, session);
      const ownParent = textOf(session.parent_session_id);
      const subagentId = ownParent === null ? null : sessionId;
      const startedAtMs = numberOrNull(session.started_at) === null
        ? 0
        : numberOrNull(session.started_at)! * 1000;
      const cwd = textOf(session.cwd);

      const window = new Map<number, Record<string, unknown>>();
      const order: number[] = [];
      for (const row of display) {
        const message = windowMessage(row);
        if (message === null) continue;
        window.set(row.display_order, message);
        order.push(row.display_order);
      }

      const lines: SourceRead['lines'] = [];
      for (const row of batch) {
        const index = order.indexOf(row.display_order);
        const requestMessages: unknown[] = [];
        for (let i = 0; i < index; i += 1) {
          const message = window.get(order[i]!);
          if (message !== undefined) requestMessages.push(message);
        }
        const reply = blocksOf(row);
        const call: SessionCall = {
          sessionId: root.id,
          subagentId,
          convKey,
          callId: String(row.id),
          sortOffset: row.display_order,
          parentSessionId: ownParent,
          startedMs: numberOrNull(row.timestamp) === null
            ? startedAtMs
            : numberOrNull(row.timestamp)! * 1000,
          model,
          responseIdNorm: null,
          turnRef: null,
          usage: null,
          reasoning: textOf(row.reasoning) ?? textOf(row.reasoning_content),
          requestMessages,
          replyContent: reply,
          cwd,
        };
        lines.push({ offset: row.id, end: row.id, text: JSON.stringify({ call }) });
      }

      return Promise.resolve({
        sourceKind: 'hermes_session',
        name: file.name,
        generation,
        rewriteEpoch: 0,
        committedOff,
        observedOff: maxId,
        seenSize: maxId,
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
    if (!isRecord(value)) return { kind: 'invalid', reason: 'hermes_invalid_payload' };
    const call = value.call;
    if (!isRecord(call)) return { kind: 'invalid', reason: 'hermes_invalid_payload' };
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

  afterFile(db, state, file, now) {
    return writeSessionUsage(db, file, now);
  },
};
