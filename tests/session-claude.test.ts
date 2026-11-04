import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { claudeAdapter } from '../src/sources/session/adapters/claude';
import { ingestSessionBatch, ingestSessionFile } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atc-claude-session-'));
}

function line(type: string, timestamp: string, message: unknown, extra: Record<string, unknown> = {}): string {
  return json({
    type, sessionId: SESSION_ID, session_id: SESSION_ID, timestamp,
    uuid: `uuid-${type}-${timestamp}`, userType: 'external', entrypoint: 'cli',
    cwd: '/work/synthetic', version: '9.9.9', message, ...extra,
  });
}

function user(timestamp: string, blocks: unknown[]): string {
  return line('user', timestamp, { role: 'user', content: blocks });
}

function assistant(timestamp: string, id: string, blocks: unknown[],
  usage: Record<string, number> = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
): string {
  return line('assistant', timestamp, {
    id, model: 'claude-synthetic', role: 'assistant', type: 'message',
    content: blocks, usage,
  }, { requestRef: 'req-synthetic' });
}

function writeSession(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('Claude 会话：按 message.id 合并内容块，逐调用建行、正文与证据齐全', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeSession(root, `${SESSION_ID}.jsonl`, [
      user(iso(T0), [{ type: 'text', text: 'first prompt' }]),
      assistant(iso(T0 + 2_000), 'msg_synth-1', [{ type: 'thinking', thinking: 'plan' }]),
      assistant(iso(T0 + 2_000), 'msg_synth-1', [{ type: 'text', text: 'first reply' }]),
      // 与调用无关的大块不落原始层。
      json({ type: 'api-request-blob', sessionId: SESSION_ID, blob: 'x'.repeat(500) }),
      user(iso(T0 + 3_000), [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }]),
      assistant(iso(T0 + 5_000), 'msg_synth-2', [{ type: 'text', text: 'second reply' }],
        { input_tokens: 140, output_tokens: 30, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 }),
    ]);

    const result = await ingestSessionBatch(f.store, claudeAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 2, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const rows = f.store.read.query(`
      SELECT req_id, via, agent, session, conv_key, conv_source, actor, subagent, parent_agent,
        started_ms, model_requested, response_id_norm, in_tok, out_tok, cache_read, cache_write,
        have, body_state, parse_state, reply_state, msg_count, sort_source, source_facts_json
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'claude', session: SESSION_ID,
      conv_key: json(['session', SESSION_ID]), conv_source: 'claude-session',
      actor: SESSION_ID, subagent: null, parent_agent: null,
      started_ms: T0, model_requested: 'claude-synthetic', response_id_norm: 'synth-1',
      in_tok: 100, out_tok: 20, cache_read: 50, cache_write: 10,
      have: 16, body_state: 'available', parse_state: 'ok', reply_state: 'ok',
      msg_count: 1, sort_source: 'claude_session',
    });
    expect(rows[1]).toMatchObject({
      started_ms: T0 + 3_000, response_id_norm: 'synth-2', in_tok: 140, out_tok: 30,
      cache_read: 60, cache_write: 0, msg_count: 3,
    });
    const facts = JSON.parse(rows[0]!.source_facts_json as string) as {
      session: { usageScope: string; reasoningEffort: string | null; cwd: string | null };
    };
    expect(facts.session).toEqual({ usageScope: 'session', reasoningEffort: null, cwd: '/work/synthetic' });

    const first = readBodyWithMessagesTx(f.store.read, 1);
    expect(first!.body.protocol).toBe('anthropic');
    expect(first!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'first reply' },
    ] });
    expect(first!.messages).toHaveLength(1);

    expect(f.store.read.query(
      'SELECT source_kind, ref_key, match_rule FROM request_evidence ORDER BY req_id').all(),
    ).toEqual([
      { source_kind: 'claude_session_call', ref_key: `${SESSION_ID}/msg_synth-1`, match_rule: 'match_absent' },
      { source_kind: 'claude_session_call', ref_key: `${SESSION_ID}/msg_synth-2`, match_rule: 'match_absent' },
    ]);
    // 只存 user/assistant 五行；api-request-blob 不进原始层。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 5 });
    const cursor = f.store.read.query(`
      SELECT committed_off, seen_size FROM source_cursor
      WHERE source_kind='claude_session' AND source_name=?`).get(path) as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBe(cursor.seen_size);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude 批次边界：后到的内容块刷新同一笔正文，不新建行', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeSession(root, `${SESSION_ID}.jsonl`, [
      user(iso(T0), [{ type: 'text', text: 'prompt' }]),
      assistant(iso(T0 + 1_000), 'msg_split-1', [{ type: 'thinking', thinking: 'plan' }]),
    ]);
    const file = {
      name: path, path, size: 0, mtimeMs: 0, remaining: 1,
    };
    const first = await ingestSessionFile(f.store, claudeAdapter, file, SALT, Date.now());
    expect(first).toMatchObject({ calls: 1, refreshed: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });

    appendFileSync(path, `${assistant(iso(T0 + 1_000), 'msg_split-1', [{ type: 'text', text: 'reply' }])}\n`);
    const second = await ingestSessionFile(f.store, claudeAdapter, file, SALT, Date.now());
    expect(second).toMatchObject({ duplicates: 1, refreshed: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'reply' },
    ] });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude 坏行停游标：坏行前的调用已落库，坏行被记为 issue', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `${SESSION_ID}.jsonl`, [
      user(iso(T0), [{ type: 'text', text: 'prompt' }]),
      assistant(iso(T0 + 1_000), 'msg_bad-1', [{ type: 'text', text: 'reply' }]),
      '{"type":"assistant", broken',
      user(iso(T0 + 2_000), [{ type: 'text', text: 'later' }]),
    ]);
    const result = await ingestSessionBatch(f.store, claudeAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='claude_session'").get())
      .toEqual({ reason: 'claude_invalid_json' });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='claude_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBeLessThan(cursor.seen_size);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude 原地重写：代际变化后整份重读，旧会话行保留', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeSession(root, `${SESSION_ID}.jsonl`, [
      user(iso(T0), [{ type: 'text', text: 'first session' }]),
      assistant(iso(T0 + 1_000), 'msg_rewrite-1', [{ type: 'text', text: 'reply' }]),
    ]);
    await ingestSessionBatch(f.store, claudeAdapter, [root], SALT, Date.now());
    writeFileSync(path, `${[
      user(iso(T0 + 10_000), [{ type: 'text', text: 'second session' }]),
      assistant(iso(T0 + 11_000), 'msg_rewrite-2', [{ type: 'text', text: 'second reply' }]),
    ].join('\n')}\n`);
    const second = await ingestSessionBatch(f.store, claudeAdapter, [root], SALT, Date.now());
    expect(second.calls).toBe(1);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 2 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 4 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude 脱敏：敏感片段不进原始层与正文块', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const secret = 'sk-synthclaudesecret123456';
    writeSession(root, `${SESSION_ID}.jsonl`, [
      user(iso(T0), [{ type: 'text', text: `use ${secret}` }]),
      assistant(iso(T0 + 1_000), 'msg_secret-1', [{ type: 'text', text: 'ok' }]),
    ]);
    await ingestSessionBatch(f.store, claudeAdapter, [root], SALT, Date.now());
    const raw = f.store.read.query('SELECT payload_json FROM raw_session_event').all() as {
      payload_json: string;
    }[];
    expect(raw.some(row => row.payload_json.includes(secret))).toBe(false);
    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(JSON.stringify(body!.messages)).not.toContain(secret);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});