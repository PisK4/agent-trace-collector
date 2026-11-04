import { expect, test } from 'bun:test';
import {
  appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { grokAdapter } from '../src/sources/session/adapters/grok';
import { ingestSessionBatch, ingestSessionFile } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const json = (value: unknown): string => JSON.stringify(value);

/** 会话根：sessions/<url-encoded-cwd>/<uuid>/，与本机形状一致。 */
function makeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'atc-grok-session-')), 'sessions');
}

function sessionDir(root: string, id: string = SESSION_ID): string {
  const dir = join(root, '%2Fwork%2Fsynthetic', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function history(dir: string, lines: string[]): string {
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function summary(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'summary.json'), json({
    info: { id: SESSION_ID, cwd: '/work/synthetic' },
    created_at: new Date(T0).toISOString(),
    current_model_id: 'grok-synthetic',
    num_messages: 6,
    ...extra,
  }));
}

function usage(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'usage.json'), json({
    sessionId: SESSION_ID,
    updatedAt: new Date(T0 + 5_000).toISOString(),
    session: {
      inputTokens: 1000, outputTokens: 200, cachedReadTokens: 300,
      cacheCreationTokens: 50, reasoningTokens: 40, totalTokens: 1200,
      modelCalls: 1, turnCount: 1, primaryModelId: 'grok-synthetic',
      modelUsage: {},
      ...extra,
    },
    turns: [],
  }));
}

function system(): string {
  return json({ type: 'system', content: 'synthetic system prompt' });
}

function user(text: string): string {
  return json({
    type: 'user', prompt_index: 0, synthetic_reason: '',
    content: [{ type: 'text', text }],
  });
}

function reasoning(text: string): string {
  return json({
    type: 'reasoning', id: 'rs-synthetic', status: 'completed',
    summary: [{ type: 'summary_text', text }], encrypted_content: 'opaque',
  });
}

function assistant(text: string, model: string = 'grok-synthetic',
  toolCalls: unknown[] = []): string {
  return json({
    type: 'assistant', content: text, tool_calls: toolCalls,
    model_id: model, model_fingerprint: 'fp-synthetic',
  });
}

function toolResult(id: string, content: string): string {
  return json({ type: 'tool_result', tool_call_id: id, content });
}

test('Grok 首次摄入：会话目录一条流，逐 assistant 建行、正文与证据齐全', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const dir = sessionDir(root);
    summary(dir);
    usage(dir, { modelCalls: 2 });
    history(dir, [
      system(), user('first prompt'), reasoning('plan'), assistant('first reply'),
      toolResult('call-1', 'tool output'), reasoning('next'), assistant('second reply'),
    ]);

    const result = await ingestSessionBatch(f.store, grokAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ files: 1, calls: 2, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const rows = f.store.read.query(`
      SELECT req_id, via, agent, session, conv_key, conv_source, actor, subagent, parent_agent,
        started_ms, model_requested, response_id_norm, in_tok, out_tok, cache_read, cache_write,
        reasoning, have, body_state, parse_state, reply_state, sort_source
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'grok', session: SESSION_ID,
      conv_key: json(['session', SESSION_ID]), conv_source: 'grok-session',
      actor: SESSION_ID, subagent: null, parent_agent: null,
      started_ms: T0, model_requested: 'grok-synthetic', response_id_norm: null,
      in_tok: null, out_tok: null, cache_read: null, cache_write: null,
      reasoning: null,
      have: 16, body_state: 'available', parse_state: 'ok', reply_state: 'ok',
      sort_source: 'grok_session',
    });
    expect(rows[1]).toMatchObject({ started_ms: T0 + 1_000 });

    const evidence = f.store.read.query(
      'SELECT source_kind, ref_key FROM request_evidence ORDER BY ref_key').all();
    expect(evidence.map(row => (row as { source_kind: string }).source_kind))
      .toEqual(['grok_session_call', 'grok_session_call']);
    const refKeys = evidence.map(row => (row as { ref_key: string }).ref_key);
    expect(new Set(refKeys).size).toBe(2);
    for (const key of refKeys) expect(key.startsWith(`${SESSION_ID}/off:`)).toBe(true);

    // 第一笔的窗口是 system + user，回复带 reasoning 文本块。
    const first = readBodyWithMessagesTx(f.store.read, 1);
    expect(first!.body.protocol).toBe('chat');
    expect(first!.messages).toEqual([
      { role: 'system', content: 'synthetic system prompt' },
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    ]);
    expect(first!.body.reply).toEqual({ choices: [{ message: {
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'first reply' },
      ],
    } }] });
    // 第二笔的窗口含上一笔回复与工具结果（重放恢复的消息序列）。
    const second = readBodyWithMessagesTx(f.store.read, 2);
    expect(second!.messages).toHaveLength(4);

    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='grok_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBe(cursor.seen_size);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('Grok 追加读取：窗口含历史消息，只新增一笔调用', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const dir = sessionDir(root);
    summary(dir);
    usage(dir);
    const path = history(dir, [
      system(), user('first prompt'), assistant('first reply'),
    ]);
    const file = { name: path, path, size: 0, mtimeMs: 0, remaining: 1 };
    const first = await ingestSessionFile(f.store, grokAdapter, file, SALT, T0);
    expect(first).toMatchObject({ calls: 1, duplicates: 0 });

    appendFileSync(path, `${[
      user('second prompt'), assistant('second reply'),
    ].join('\n')}\n`);
    const second = await ingestSessionFile(f.store, grokAdapter, file, SALT, T0);
    expect(second).toMatchObject({ calls: 1, duplicates: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 2 });
    const body = readBodyWithMessagesTx(f.store.read, 2);
    expect(body!.messages).toEqual([
      { role: 'system', content: 'synthetic system prompt' },
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
    ]);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('Grok 坏行停游标：坏行前的调用已落库，坏行被记为 issue', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const dir = sessionDir(root);
    summary(dir);
    usage(dir);
    history(dir, [
      system(), user('prompt'), assistant('reply'),
      '{"type":"assistant", broken',
      user('later'), assistant('never reached'),
    ]);
    const result = await ingestSessionBatch(f.store, grokAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='grok_session'").get())
      .toEqual({ reason: 'grok_invalid_json' });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='grok_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBeLessThan(cursor.seen_size);
    // 坏行阻挡时 afterFile 不执行，不写累计值。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM session_usage').get()).toEqual({ n: 0 });
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('Grok 会话目录多个文件：旁路文件不建游标，usage 留 null、累计进 session_usage', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const dir = sessionDir(root);
    summary(dir);
    usage(dir, {
      inputTokens: 1000, outputTokens: 200, cachedReadTokens: 300,
      cacheCreationTokens: 50, reasoningTokens: 40, modelCalls: 1,
    });
    history(dir, [system(), user('prompt'), assistant('reply')]);
    // 一个会话由多个文件组成；其余文件不该各自建一条流或一条游标。
    writeFileSync(join(dir, 'events.jsonl'), `${json({ ts: new Date(T0).toISOString(), type: 'session_start' })}\n`);
    writeFileSync(join(dir, 'rewind_points.jsonl'), `${json({ prompt_index: 0, created_at: new Date(T0).toISOString() })}\n`);
    writeFileSync(join(dir, 'tool_definitions.json'), json({ tools: [] }));
    writeFileSync(join(dir, 'signals.json'), json({ signals: [] }));

    const result = await ingestSessionBatch(f.store, grokAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ files: 1, calls: 1, duplicates: 0, sideEffects: 1 });
    const cursors = f.store.read.query(
      "SELECT source_name FROM source_cursor WHERE source_kind='grok_session'").all() as {
      source_name: string;
    }[];
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.source_name).toBe(join(dir, 'chat_history.jsonl'));

    const row = f.store.read.query(
      'SELECT in_tok, out_tok, cache_read, cache_write, reasoning FROM request').get();
    expect(row).toEqual({
      in_tok: null, out_tok: null, cache_read: null, cache_write: null, reasoning: null,
    });
    const sessionUsage = f.store.read.query(
      'SELECT agent, session, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, thinking_tokens, source_path, source_hash FROM session_usage').get() as Record<string, unknown>;
    expect(sessionUsage).toMatchObject({
      agent: 'grok', session: SESSION_ID, model: 'grok-synthetic',
      // magpie 口径：input 不含缓存读写，1000 - 300 - 50 = 650。
      input_tokens: 650, output_tokens: 200,
      cache_creation_tokens: 50, cache_read_tokens: 300, thinking_tokens: 40,
      source_path: join(dir, 'usage.json'),
    });
    expect(sessionUsage.source_hash).toBeTruthy();
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('Grok 累计值按内容哈希覆盖：usage.json 改写后随下一次推进刷新', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const dir = sessionDir(root);
    summary(dir);
    usage(dir);
    const path = history(dir, [system(), user('prompt'), assistant('reply')]);
    const file = { name: path, path, size: 0, mtimeMs: 0, remaining: 1 };
    const first = await ingestSessionFile(f.store, grokAdapter, file, SALT, T0);
    expect(first.sideEffects).toBe(1);

    // usage.json 是覆盖写；累计值随 chat_history 下一次推进时的 afterFile 刷新。
    usage(dir, { outputTokens: 999 });
    appendFileSync(path, `${[
      user('second prompt'), assistant('second reply'),
    ].join('\n')}\n`);
    const refreshed = await ingestSessionFile(f.store, grokAdapter, file, SALT, T0);
    expect(refreshed.sideEffects).toBe(1);
    expect(f.store.read.query('SELECT output_tokens FROM session_usage').get())
      .toEqual({ output_tokens: 999 });

    // 内容哈希没变：再推进一行也不重复写累计值。
    appendFileSync(path, `${[
      user('third prompt'), assistant('third reply'),
    ].join('\n')}\n`);
    const unchanged = await ingestSessionFile(f.store, grokAdapter, file, SALT, T0);
    expect(unchanged.sideEffects).toBe(0);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('Grok 不认识的行型只跳过，不判坏；多个会话证据键不相撞', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    for (const id of [a, b]) {
      const dir = sessionDir(root, id);
      summary(dir);
      history(dir, [
        system(), user('prompt'),
        json({ type: 'future_kind', payload: 'unknown' }),
        json({ type: 'text', content: 'stream chunk' }),
        assistant('reply'),
      ]);
    }
    const result = await ingestSessionBatch(f.store, grokAdapter, [root], SALT, T0);
    // 两家各一条 assistant：ref_key 带各自会话 id，不相撞。
    expect(result).toMatchObject({ files: 2, calls: 2, duplicates: 0, invalid: 0, blocked: 0 });
    const evidence = f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY ref_key').all() as { ref_key: string }[];
    expect(new Set(evidence.map(row => row.ref_key)).size).toBe(2);
    expect(evidence[0]!.ref_key.startsWith(`${a}/`)).toBe(true);
    expect(evidence[1]!.ref_key.startsWith(`${b}/`)).toBe(true);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});
