import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { zcodeAdapter } from '../src/sources/session/adapters/zcode';
import { ingestSessionBatch, ingestSessionFile } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = 'zcode-root';
const CWD = '/work/synthetic';
const json = (value: unknown): string => JSON.stringify(value);

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'atc-zcode-session-'));
}

/** 只建适配器真正读取的列；合成数据，不含真实会话内容。 */
function openZcode(home: string): { dbDir: string; dbPath: string; db: Database } {
  const dbDir = join(home, 'cli', 'db');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_deleted INTEGER
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER,
      data TEXT, sequence INTEGER
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT, sequence INTEGER
    );
    CREATE TABLE model_usage(
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT,
      turn_id TEXT, assistant_message_id TEXT, parent_user_message_id TEXT,
      provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER,
      completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER
    );
    CREATE TABLE schema_migration(time_applied INTEGER);
  `);
  return { dbDir, dbPath, db };
}

function addSession(db: Database, id: string, parentId: string | null = null,
  directory = CWD): void {
  db.run(`
    INSERT INTO session(id,parent_id,directory,title,time_created,time_updated,time_deleted)
    VALUES (?,?,?,'synthetic',?,?,NULL)`, [id, parentId, directory, T0, T0]);
}

function addMessage(db: Database, id: string, sessionId: string, at: number, sequence: number,
  role: string, model?: string): void {
  db.run(`
    INSERT INTO message(id,session_id,time_created,time_updated,data,sequence)
    VALUES (?,?,?,?,?,?)`, [id, sessionId, at, at, json({
    role,
    ...(model === undefined ? {} : { modelID: model }),
    time: { created: at, completed: at },
  }), sequence]);
}

function addPart(db: Database, id: string, messageId: string, sessionId: string,
  at: number, sequence: number, data: unknown): void {
  db.run(`
    INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence)
    VALUES (?,?,?,?,?,?,?)`, [id, messageId, sessionId, at, at, json(data), sequence]);
}

type UsageInput = {
  assistantMessageId: string;
  sessionId?: string;
  startedAt?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  status?: string;
  attempt?: number;
  turnId?: string;
  model?: string;
};

function addUsage(db: Database, input: UsageInput): number {
  const row = db.run(`
    INSERT INTO model_usage(id,logical_request_id,attempt_index,session_id,turn_id,
      assistant_message_id,parent_user_message_id,provider_id,model_id,status,started_at,
      completed_at,duration_ms,time_to_first_token_ms,input_tokens,output_tokens,
      reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens)
    VALUES (?,?,?,?,?,?,NULL,'synthetic',?,?,?,?,NULL,NULL,?,?,NULL,?,?)`, [
    `usage-${input.assistantMessageId}`, `logical-${input.assistantMessageId}`,
    input.attempt ?? 0, input.sessionId ?? SESSION_ID, input.turnId ?? `turn-${input.assistantMessageId}`,
    input.assistantMessageId, input.model ?? 'zcode-synthetic', input.status ?? 'completed',
    input.startedAt ?? T0 + 900, input.startedAt ?? T0 + 900,
    input.input ?? 100, input.output ?? 20, input.cacheWrite ?? 10, input.cacheRead ?? 50,
  ]);
  return Number(row.lastInsertRowid);
}

function seedFirstTurn(db: Database, sessionId = SESSION_ID): { usageRowid: number } {
  addMessage(db, 'm-user', sessionId, T0, 1, 'user');
  addPart(db, 'p-user', 'm-user', sessionId, T0, 1, { type: 'text', text: 'prompt' });
  addMessage(db, 'm-assistant-1', sessionId, T0 + 1_000, 2, 'assistant', 'zcode-synthetic');
  addPart(db, 'p-think', 'm-assistant-1', sessionId, T0 + 1_000, 1,
    { type: 'reasoning', text: 'plan', metadata: {} });
  addPart(db, 'p-text', 'm-assistant-1', sessionId, T0 + 1_100, 2,
    { type: 'text', text: 'first reply' });
  addPart(db, 'p-tool', 'm-assistant-1', sessionId, T0 + 1_200, 3, {
    type: 'tool', callID: 'call-1', tool: 'read_file',
    state: { status: 'completed', input: { path: 'a.txt' }, output: 'contents' },
  });
  const usageRowid = addUsage(db, {
    assistantMessageId: 'm-assistant-1', sessionId, startedAt: T0 + 900,
  });
  return { usageRowid };
}

function requestRows(store: ReturnType<typeof fixture>['store']): Record<string, unknown>[] {
  return store.read.query(`
    SELECT req_id, via, agent, session, conv_key, conv_source, actor, subagent, parent_agent,
      started_ms, model_requested, response_id_norm, in_tok, out_tok, cache_read, cache_write,
      have, body_state
    FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
}

test('Zcode 会话：completed 调用建行，用量按 magpie 口径归一，正文与证据齐全', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbDir, dbPath, db } = openZcode(home);
    addSession(db, SESSION_ID);
    const { usageRowid } = seedFirstTurn(db);
    db.close();

    const result = await ingestSessionBatch(f.store, zcodeAdapter, [dbDir], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 1, merged: 0, invalid: 0, blocked: 0 });

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'zcode', session: SESSION_ID,
      conv_key: json(['session', SESSION_ID]), conv_source: 'zcode-session',
      actor: SESSION_ID, subagent: null, parent_agent: null,
      started_ms: T0 + 900, model_requested: 'zcode-synthetic', response_id_norm: null,
      // input_tokens 含 cache：100 - 50 - 10。
      in_tok: 40, out_tok: 20, cache_read: 50, cache_write: 10, body_state: 'available',
    });

    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.body.protocol).toBe('anthropic');
    expect(body!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }]);
    expect(body!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'first reply' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } },
    ] });

    expect(f.store.read.query(
      'SELECT source_kind, ref_key, merge_state, match_rule FROM request_evidence').all(),
    ).toEqual([{
      source_kind: 'zcode_session_call', ref_key: `${SESSION_ID}/m-assistant-1`,
      merge_state: 'merged', match_rule: 'match_absent',
    }]);
    // 物化行落库可重读，原始层不重复存整段上下文。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 0 });

    const cursor = f.store.read.query(`
      SELECT source_name, committed_off, seen_size FROM source_cursor
      WHERE source_kind='zcode_session'`).get();
    expect(cursor).toEqual({
      source_name: `${dbPath}#${SESSION_ID}`,
      committed_off: usageRowid,
      seen_size: usageRowid,
    });
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Zcode 追加：第二笔调用建行，请求窗口包含上一笔 assistant 消息', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbDir, dbPath, db } = openZcode(home);
    addSession(db, SESSION_ID);
    seedFirstTurn(db);
    db.close();

    await ingestSessionBatch(f.store, zcodeAdapter, [dbDir], SALT, Date.now());

    const append = new Database(dbPath);
    addMessage(append, 'm-assistant-2', SESSION_ID, T0 + 3_000, 3, 'assistant', 'zcode-synthetic');
    addPart(append, 'p-text-2', 'm-assistant-2', SESSION_ID, T0 + 3_000, 1,
      { type: 'text', text: 'second reply' });
    addUsage(append, { assistantMessageId: 'm-assistant-2', startedAt: T0 + 2_900,
      input: 160, output: 30, cacheRead: 80, cacheWrite: 0 });
    append.close();

    const second = await ingestSessionBatch(f.store, zcodeAdapter, [dbDir], SALT, Date.now());
    expect(second).toMatchObject({ files: 1, calls: 1, duplicates: 0, merged: 0 });

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ in_tok: 80, out_tok: 30, cache_read: 80, cache_write: 0 });

    const body = readBodyWithMessagesTx(f.store.read, 2);
    expect(body!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'first reply' },
        { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } },
      ] },
    ]);
    expect(body!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] });
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Zcode 跨来源去重：用量指纹认领网关行，不新建请求', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbDir, db } = openZcode(home);
    addSession(db, SESSION_ID);
    seedFirstTurn(db);
    db.close();

    const gatewayId = f.store.write(db => Number(db.run(`
      INSERT INTO request(agent,session,conv_key,conv_source,actor,actor_state,started_ms,day,
        via,model_requested,in_tok,out_tok,cache_read,cache_write,body_state,derive_version,
        have,created_at,updated_at)
      VALUES ('zcode',?,?,'gateway',?,'known',?,'2026-09-01','through','zcode-synthetic',
        40,20,50,10,'pending',0,2,1,1)`,
    [SESSION_ID, json(['session', SESSION_ID]), SESSION_ID, T0 + 900]).lastInsertRowid));

    const result = await ingestSessionBatch(f.store, zcodeAdapter, [dbDir], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 0, merged: 1 });

    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(`
      SELECT req_id, via, in_tok, out_tok, cache_read, cache_write, have
      FROM request`).get()).toEqual({
      req_id: gatewayId, via: 'through', in_tok: 40, out_tok: 20,
      cache_read: 50, cache_write: 10, have: 18,
    });
    expect(f.store.read.query(`
      SELECT source_kind, ref_key, merge_state, match_rule FROM request_evidence`).all(),
    ).toEqual([{
      source_kind: 'zcode_session_call', ref_key: `${SESSION_ID}/m-assistant-1`,
      merge_state: 'merged', match_rule: 'usage_fingerprint.v1',
    }]);
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Zcode 子代理：会话折叠到根，subagent 与 parent_agent 记子会话', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbDir, db } = openZcode(home);
    addSession(db, 'zcode-parent', null, '/work/synthetic/parent');
    addSession(db, 'zcode-child', 'zcode-parent', '/work/synthetic/child');
    seedFirstTurn(db, 'zcode-child');
    db.close();

    const result = await ingestSessionBatch(f.store, zcodeAdapter, [dbDir], SALT, Date.now());
    expect(result.calls).toBe(1);

    const rows = requestRows(f.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'zcode-parent',
      subagent: 'zcode-child',
      parent_agent: 'zcode-parent',
      conv_key: json(['session', 'zcode-parent']),
      actor: 'zcode-child',
    });
    const facts = JSON.parse(f.store.read.query<{ source_facts_json: string | null }, []>(
      'SELECT source_facts_json FROM request').get()!.source_facts_json as string) as {
      session: { cwd: string | null };
    };
    expect(facts.session.cwd).toBe('/work/synthetic/child');
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Zcode 未完成调用：running 行被忽略，不建请求且游标不越过它', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const { dbDir, dbPath, db } = openZcode(home);
    addSession(db, SESSION_ID);
    addMessage(db, 'm-user', SESSION_ID, T0, 1, 'user');
    addPart(db, 'p-user', 'm-user', SESSION_ID, T0, 1, { type: 'text', text: 'prompt' });
    addMessage(db, 'm-assistant-1', SESSION_ID, T0 + 1_000, 2, 'assistant', 'zcode-synthetic');
    addPart(db, 'p-text', 'm-assistant-1', SESSION_ID, T0 + 1_000, 1,
      { type: 'text', text: 'still running' });
    const usageRowid = addUsage(db, { assistantMessageId: 'm-assistant-1', status: 'running' });
    db.close();

    const result = await ingestSessionFile(f.store, zcodeAdapter, {
      name: `${dbPath}#${SESSION_ID}`, path: dbPath, size: usageRowid, mtimeMs: 0, remaining: 1,
    }, SALT, Date.now());

    expect(result).toMatchObject({ calls: 0, merged: 0, invalid: 0, blocked: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 0 });
    const cursor = f.store.read.query<{
      committed_off: number; observed_off: number; seen_size: number;
    }, []>(`
      SELECT committed_off, observed_off, seen_size FROM source_cursor
      WHERE source_kind='zcode_session'`).get();
    expect(cursor).toEqual({ committed_off: 0, observed_off: 0, seen_size: usageRowid });
    expect(cursor!.committed_off).toBeLessThan(usageRowid);
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});
