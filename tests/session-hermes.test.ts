import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { convDigestOf } from '../src/conv-digest';
import { hermesAdapter } from '../src/sources/session/adapters/hermes';
import { ingestSessionBatch } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const ROOT = 'synthetic-root';
const CWD = '/work/synthetic';
const json = (value: unknown): string => JSON.stringify(value);

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'atc-hermes-session-'));
}

/** 只建适配器真正读取的列；合成数据，不含真实会话内容。 */
function openHermes(home: string): { dbPath: string; db: Database } {
  const dbPath = join(home, 'state.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, parent_session_id TEXT, model TEXT, cwd TEXT, started_at REAL
    );
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
      tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, display_order INTEGER,
      display_metadata TEXT, active INTEGER, compacted INTEGER, timestamp REAL,
      reasoning TEXT, reasoning_content TEXT, message_uid TEXT
    );
    CREATE TABLE session_model_usage(
      session_id TEXT, model TEXT, api_call_count INTEGER, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER
    );
    CREATE TABLE schema_version(version INTEGER);
  `);
  db.run('INSERT INTO schema_version(version) VALUES (32)');
  return { dbPath, db };
}

function addSession(db: Database, id: string = ROOT, options: {
  parentId?: string | null; model?: string | null; startedAt?: number;
} = {}): void {
  db.run(
    'INSERT INTO sessions(id,parent_session_id,model,cwd,started_at) VALUES (?,?,?,?,?)',
    [id, options.parentId ?? null, options.model ?? 'hermes-synthetic', CWD,
      (options.startedAt ?? T0) / 1000],
  );
}

type RowInput = {
  id?: number; sessionId?: string; role: string; content?: string | null;
  displayOrder: number; active?: number; compacted?: number; timestamp?: number;
  toolCalls?: unknown; toolCallId?: string | null; toolName?: string | null;
  displayMetadata?: unknown; reasoning?: string | null; reasoningContent?: string | null;
  messageUid?: string | null;
};

function addRow(db: Database, input: RowInput): number {
  const row = db.run(`
    INSERT INTO messages(session_id,role,content,tool_calls,tool_call_id,tool_name,
      display_order,display_metadata,active,compacted,timestamp,reasoning,reasoning_content,
      message_uid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    input.sessionId ?? ROOT, input.role, input.content ?? null,
    input.toolCalls === undefined ? null : json(input.toolCalls),
    input.toolCallId ?? null, input.toolName ?? null,
    input.displayOrder, input.displayMetadata === undefined ? null : json(input.displayMetadata),
    input.active ?? 1, input.compacted ?? 0, (input.timestamp ?? T0 + 1_000) / 1000,
    input.reasoning ?? null, input.reasoningContent ?? null, input.messageUid ?? null,
  ]);
  return Number(row.lastInsertRowid);
}

function requestRows(store: ReturnType<typeof fixture>['store']): Record<string, unknown>[] {
  return store.read.query(`
    SELECT req_id, agent, session, conv_key, conv_source, actor, subagent, parent_agent,
      started_ms, model_requested, in_tok, out_tok, body_state, sort_key
    FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
}

function expectedConvKey(content: string): string {
  return convDigestOf({ messages: [{ role: 'user', content }] })!.key;
}

test('Hermes 会话：按 display_order 还原顺序，插入序与展示序不同也成立', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbPath, db } = openHermes(home);
    addSession(db);
    // 先插入 assistant，再插入 user：id 序与 display_order 序相反。
    const assistantId = addRow(db, { role: 'assistant', content: 'answer one', displayOrder: 20 });
    addRow(db, { role: 'user', content: 'first prompt', displayOrder: 10 });
    db.close();

    // 活跃时间取会话最后一条消息，不是整个 state.db 的文件 mtime。
    const discovered = await hermesAdapter.discover(home, () => null);
    expect(discovered[0]!.mtimeMs).toBe(T0 + 1_000);

    const result = await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 1, merged: 0, invalid: 0, blocked: 0 });

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'hermes', session: ROOT,
      conv_key: expectedConvKey('first prompt'), conv_source: 'hermes-session',
      actor: ROOT, subagent: null, parent_agent: null,
      model_requested: 'hermes-synthetic', in_tok: null, out_tok: null, body_state: 'available',
    });
    expect(rows[0]!.sort_key).toEndWith(String(20).padStart(20, '0'));

    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.body.protocol).toBe('chat');
    // 请求窗口按槽位取，assistant 前面是 user，不是空数组。
    expect(body!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    ]);
    expect(body!.body.reply).toEqual({ choices: [{ message: {
      role: 'assistant', content: [{ type: 'text', text: 'answer one' }],
    } }] });

    expect(f.store.read.query(
      'SELECT source_kind, ref_key FROM request_evidence').all(),
    ).toEqual([{ source_kind: 'hermes_session_call', ref_key: `${ROOT}/${assistantId}` }]);
    // 物化行可重读，原始层不重复存整段上下文。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 0 });
    expect(f.store.read.query(`
      SELECT source_name, committed_off FROM source_cursor
      WHERE source_kind='hermes_session'`).get()).toEqual({
      source_name: `${dbPath}#${ROOT}`, committed_off: assistantId,
    });
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 展示过滤：rewind 行与同槽副本不产调用，压缩归档行保留', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { db } = openHermes(home);
    addSession(db);
    addRow(db, { role: 'user', content: 'prompt', displayOrder: 10 });
    const kept = addRow(db, { role: 'assistant', content: 'kept', displayOrder: 20 });
    // 同槽副本：active=0, compacted=1，id 更晚但不是代表行。
    addRow(db, { role: 'assistant', content: 'copy', displayOrder: 20, active: 0, compacted: 1 });
    // rewind 丢弃行：active=0, compacted=0，Hermes 不展示。
    addRow(db, { role: 'assistant', content: 'rewound', displayOrder: 30, active: 0, compacted: 0 });
    // 压缩归档行：仍在展示集里。
    const archived = addRow(db, { role: 'assistant', content: 'archived', displayOrder: 40, active: 0, compacted: 1 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.session)).toEqual([ROOT, ROOT]);
    expect(f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY ref_key').all()).toEqual([
      { ref_key: `${ROOT}/${kept}` },
      { ref_key: `${ROOT}/${archived}` },
    ]);
    // 归档行的请求窗口包含前一条 user 与现役 assistant，不含同槽副本与 rewind 行。
    const body = readBodyWithMessagesTx(f.store.read, 2);
    expect(body!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
    ]);
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 展示过滤：模型专用行与后出现的工具副本不进窗口', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { db } = openHermes(home);
    addSession(db);
    addRow(db, { role: 'user', content: 'real prompt', displayOrder: 10 });
    addRow(db, { role: 'user', content: 'model only', displayOrder: 15,
      displayMetadata: { model_only: true } });
    // 归档工具行（更早槽位）与后来的重复投递：后者应被过滤。
    addRow(db, { role: 'tool', content: 'tool output', displayOrder: 20,
      active: 0, compacted: 1, toolCallId: 'call-1', toolName: 'read',
      messageUid: 'uid-tool', timestamp: T0 + 5_000 });
    addRow(db, { role: 'tool', content: 'tool output', displayOrder: 25,
      active: 1, compacted: 0, toolCallId: 'call-1', toolName: 'read',
      messageUid: 'uid-tool', timestamp: T0 + 5_000 });
    addRow(db, { role: 'assistant', content: 'done', displayOrder: 30 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'real prompt' }] },
      { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: 'tool output' }] },
    ]);
    // 摘要取展示集首条 user，不是 model_only 行。
    expect(requestRows(f.store)[0]!.conv_key).toBe(expectedConvKey('real prompt'));
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 摘要碰撞：同 prompt 的会话退回本地 session 键，不合并成一条', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { db } = openHermes(home);
    addSession(db, 'session-a');
    addSession(db, 'session-b');
    addRow(db, { sessionId: 'session-a', role: 'user', content: 'same prompt', displayOrder: 10 });
    addRow(db, { sessionId: 'session-a', role: 'assistant', content: 'a', displayOrder: 20 });
    addRow(db, { sessionId: 'session-b', role: 'user', content: 'same prompt', displayOrder: 30 });
    addRow(db, { sessionId: 'session-b', role: 'assistant', content: 'b', displayOrder: 40 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.conv_key)).toEqual([
      json(['session', 'session-a']),
      json(['session', 'session-b']),
    ]);
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 子代理：折叠到根会话的坐标与摘要，自己留 subagent', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { db } = openHermes(home);
    addSession(db, 'root-session');
    addSession(db, 'child-session', { parentId: 'root-session' });
    addRow(db, { sessionId: 'root-session', role: 'user', content: 'root prompt', displayOrder: 10 });
    addRow(db, { sessionId: 'root-session', role: 'assistant', content: 'root reply', displayOrder: 20 });
    addRow(db, { sessionId: 'child-session', role: 'user', content: 'child prompt', displayOrder: 30 });
    addRow(db, { sessionId: 'child-session', role: 'assistant', content: 'child reply', displayOrder: 40 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(2);
    // 取件顺序按剩余量排，不能按 req_id 猜哪行是子代理。
    const child = rows.find(row => row.subagent === 'child-session');
    expect(child).toMatchObject({
      session: 'root-session', actor: 'child-session',
      subagent: 'child-session', parent_agent: 'root-session',
      conv_key: expectedConvKey('root prompt'),
    });
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 增量：追加的 assistant 行单独成行，游标越过非调用行', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbPath, db } = openHermes(home);
    addSession(db);
    addRow(db, { role: 'user', content: 'prompt', displayOrder: 10 });
    addRow(db, { role: 'assistant', content: 'first', displayOrder: 20 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const append = new Database(dbPath);
    addRow(append, { role: 'tool', content: 'tool result', displayOrder: 25,
      toolCallId: 'call-1', toolName: 'read' });
    addRow(append, { role: 'assistant', content: 'second', displayOrder: 30,
      toolCalls: [{ id: 'call-2', type: 'function',
        function: { name: 'write', arguments: { path: 'b.txt' } } }] });
    append.close();

    const second = await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());
    expect(second).toMatchObject({ files: 1, calls: 1, duplicates: 0, merged: 0 });

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(2);
    const body = readBodyWithMessagesTx(f.store.read, 2);
    expect(body!.body.reply).toEqual({ choices: [{ message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'second' },
        {
          type: 'tool_use', id: 'call-2', name: 'write', input: { path: 'b.txt' },
        },
      ],
    } }] });
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes 会话累计用量：按会话汇总写 session_usage，子代理不覆盖父会话', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { db } = openHermes(home);
    addSession(db, 'root-session');
    addSession(db, 'child-session', { parentId: 'root-session' });
    db.run(`INSERT INTO session_model_usage VALUES
      ('root-session','model-a',3,100,20,10,5,2),
      ('root-session','model-b',7,200,40,0,0,0),
      ('child-session','model-a',5,999,99,0,0,0)`);
    addRow(db, { sessionId: 'root-session', role: 'user', content: 'prompt', displayOrder: 10 });
    addRow(db, { sessionId: 'root-session', role: 'assistant', content: 'reply', displayOrder: 20 });
    addRow(db, { sessionId: 'child-session', role: 'user', content: 'child', displayOrder: 30 });
    addRow(db, { sessionId: 'child-session', role: 'assistant', content: 'child reply', displayOrder: 40 });
    db.close();

    await ingestSessionBatch(f.store, hermesAdapter, [home], SALT, Date.now());

    const usage = f.store.read.query(`
      SELECT agent, session, model, input_tokens, output_tokens, cache_creation_tokens,
        cache_read_tokens, thinking_tokens FROM session_usage ORDER BY session`).all();
    expect(usage).toEqual([{
      agent: 'hermes', session: 'root-session', model: 'model-b',
      input_tokens: 300, output_tokens: 60, cache_creation_tokens: 5,
      cache_read_tokens: 10, thinking_tokens: 2,
    }]);
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});
