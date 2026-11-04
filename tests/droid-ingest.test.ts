import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { ingestDroidBatch } from '../src/sources/droid/ingest';

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const SALT = new Uint8Array(32);
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

const SESSION = json({
  type: 'session_start', id: 's1', title: 'synth', cwd: '/work/a', lastCwd: '/work/b', version: 2,
});
const USER_A = json({
  type: 'message', id: 'm-u1', timestamp: iso(T0),
  message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
});
const ASSISTANT_1 = json({
  type: 'message', id: 'm-a1', timestamp: iso(T0 + 2_000),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'first reply' }],
    modelId: 'synth-model', openaiMessageId: 'gen-1779000000000-abc', reasoningEffort: 'high',
  },
});
const TOOL_RESULT = json({
  type: 'message', id: 'm-u2', timestamp: iso(T0 + 3_000),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
});
const ASSISTANT_2 = json({
  type: 'message', id: 'm-a2', timestamp: iso(T0 + 5_000),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'second reply' }],
    modelId: 'synth-model', openaiMessageId: '1779000000000abc',
  },
});
const OUTCOME = json({ type: 'agent_turn_outcome', turnId: 't1', resultKind: 'completed' });
const SETTINGS = json({
  tokenUsage: {
    inputTokens: 1200, outputTokens: 340, cacheCreationTokens: 50,
    cacheReadTokens: 900, thinkingTokens: 40, factoryCredits: 1.25,
  },
  model: 'synth-model', reasoningEffort: 'high',
});

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atc-droid-ingest-'));
}

function writeSession(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('普通会话落库：逐 assistant 建行、正文可读、证据/原始层/会话用量齐全', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeSession(root, 's1.jsonl', [SESSION, USER_A, ASSISTANT_1, TOOL_RESULT, ASSISTANT_2, OUTCOME]);
    writeFileSync(join(root, 's1.settings.json'), SETTINGS);
    const result = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 2, duplicates: 0, invalid: 0, blocked: 0, settingsChanged: 1 });

    const rows = f.store.read.query(`
      SELECT req_id, via, agent, session, conv_key, conv_source, actor, actor_state, subagent,
        parent_agent, started_ms, model_requested, model_served, response_id_norm, in_tok, out_tok,
        have, body_state, parse_state, reply_state, msg_count, sort_source, source_facts_json
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'droid', session: 's1', conv_key: json(['session', 's1']),
      conv_source: 'droid-session', actor: 's1', actor_state: 'known', subagent: null,
      parent_agent: null, started_ms: T0, model_requested: 'synth-model', model_served: null,
      response_id_norm: 'gen-1779000000000-abc', have: 16, body_state: 'available',
      parse_state: 'ok', reply_state: 'ok', msg_count: 1, sort_source: 'droid_session',
    });
    expect(rows[0]!.in_tok).toBeNull();
    expect(rows[0]!.out_tok).toBeNull();
    expect(rows[1]).toMatchObject({ started_ms: T0 + 3_000, msg_count: 3 });
    const facts = JSON.parse(rows[0]!.source_facts_json as string) as {
      session: { usageScope: string; reasoningEffort: string | null; cwd: string | null };
    };
    expect(facts.session).toEqual({ usageScope: 'session', reasoningEffort: 'high', cwd: '/work/a' });

    const evidence = f.store.read.query(
      'SELECT req_id, source_kind, ref_key, merge_state, match_rule FROM request_evidence ORDER BY req_id').all();
    expect(evidence).toEqual([
      { req_id: 1, source_kind: 'session_call', ref_key: 's1/m-a1', merge_state: 'merged', match_rule: 'match_absent' },
      { req_id: 2, source_kind: 'session_call', ref_key: 's1/m-a2', merge_state: 'merged', match_rule: 'match_absent' },
    ]);

    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_droid_event').get()).toEqual({ n: 6 });
    const usage = f.store.read.query(
      'SELECT agent, session, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, thinking_tokens, factory_credits FROM session_usage').get();
    expect(usage).toEqual({
      agent: 'droid', session: 's1', model: 'synth-model', input_tokens: 1200,
      output_tokens: 340, cache_creation_tokens: 50, cache_read_tokens: 900,
      thinking_tokens: 40, factory_credits: 1.25,
    });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='droid_transcript' AND source_name='s1.jsonl'")
      .get() as { committed_off: number; seen_size: number };
    expect(cursor.committed_off).toBe(cursor.seen_size);

    // 正文重建：第二笔的请求体是截至该行之前的 3 条消息，回复是 assistant content。
    const second = readBodyWithMessagesTx(f.store.read, 2);
    expect(second).not.toBeNull();
    expect(second!.messages).toHaveLength(3);
    expect(second!.body.protocol).toBe('droid-session');
    expect(second!.body.reply).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'second reply' }] });

    // 归属确认后进入派生组。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get(json(['session', 's1'])))
      .toEqual({ n: 1 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('重复摄入幂等：游标移除后重放不建新行，全部计重复', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, 's1.jsonl', [SESSION, USER_A, ASSISTANT_1]);
    await ingestDroidBatch(f.store, root, SALT, Date.now());
    f.store.write(db => db.run("DELETE FROM source_cursor WHERE source_kind='droid_transcript'"));
    const replay = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(replay).toMatchObject({ files: 1, calls: 0, duplicates: 1, invalid: 0, blocked: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏行停在原地：游标不越过坏行，修复后继续摄入后续调用', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeSession(root, 's1.jsonl', [SESSION, USER_A, ASSISTANT_1, '{broken', ASSISTANT_2]);
    const first = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(first).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    const cursor = f.store.read.query(
      "SELECT committed_off FROM source_cursor WHERE source_kind='droid_transcript'").get() as { committed_off: number };
    const brokenOffset = Buffer.byteLength([SESSION, USER_A, ASSISTANT_1].join('\n') + '\n');
    expect(cursor.committed_off).toBe(brokenOffset);
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='droid_session'").all())
      .toEqual([{ reason: 'droid_invalid_json' }]);

    // 原地把坏行改成合法 assistant 行（同一文件身份与头部），下一轮从坏行继续。
    writeFileSync(path, `${SESSION}\n${USER_A}\n${ASSISTANT_1}\n${ASSISTANT_2}\n`);
    const second = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(second.calls).toBe(1);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 2 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('截断文件：无换行的末行等下轮，补全后才建行', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const complete = `${SESSION}\n${USER_A}\n${ASSISTANT_1}`;
    writeFileSync(join(root, 's1.jsonl'), `${complete.slice(0, -10)}`);
    const first = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(first.calls).toBe(0);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 0 });

    writeFileSync(join(root, 's1.jsonl'), `${complete}\n`);
    const second = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(second.calls).toBe(1);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fork 与子代理：fork 复制段零建行，子代理归属取自身与调用者', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const fork = json({
      type: 'session_start', id: 's-fork', cwd: '/work/fork', forkedAtMessageId: 'm-a1', version: 2,
    });
    const after = json({
      type: 'message', id: 'm-a2', timestamp: iso(T0 + 8_000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'fork reply' }] },
    });
    writeSession(root, 's-fork.jsonl', [fork, USER_A, ASSISTANT_1, after]);

    const child = json({
      type: 'session_start', id: 's-child', cwd: '/work/child', callingSessionId: 's-parent', version: 2,
    });
    writeSession(root, 's-child.jsonl', [child, USER_A, ASSISTANT_1]);
    const result = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(result.calls).toBe(2);

    const rows = f.store.read.query(`
      SELECT session, conv_key, actor, subagent, parent_agent, started_ms, msg_count
      FROM request ORDER BY req_id`).all();
    expect(rows).toEqual([
      { session: 's-fork', conv_key: json(['session', 's-fork']), actor: 's-fork', subagent: null, parent_agent: null, started_ms: T0 + 2_000, msg_count: 2 },
      { session: 's-child', conv_key: json(['session', 's-child']), actor: 's-child', subagent: 's-child', parent_agent: 's-parent', started_ms: T0, msg_count: 1 },
    ]);
    // 子代理没有 settings，不写会话用量；fork 主会话缺 settings 也不写。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM session_usage').get()).toEqual({ n: 0 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings 缺失与 assistant 缺 modelId：不猜、不补，也不报错', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const noModel = json({
      type: 'message', id: 'm-a1', timestamp: iso(T0 + 2_000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'no model' }] },
    });
    writeSession(root, 's1.jsonl', [SESSION, USER_A, noModel]);
    const result = await ingestDroidBatch(f.store, root, SALT, Date.now());
    expect(result).toMatchObject({ calls: 1, settingsChanged: 0, invalid: 0 });
    const row = f.store.read.query('SELECT model_requested, response_id_norm FROM request').get();
    expect(row).toEqual({ model_requested: null, response_id_norm: null });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM session_usage').get()).toEqual({ n: 0 });
    expect(f.store.read.query(
      "SELECT COUNT(*) AS n FROM ingest_issue WHERE source_kind='droid_session'").get()).toEqual({ n: 0 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings 覆盖写按哈希判变化；追加消息后读到新累计', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, 's1.jsonl', [SESSION, USER_A, ASSISTANT_1]);
    writeFileSync(join(root, 's1.settings.json'), SETTINGS);
    expect((await ingestDroidBatch(f.store, root, SALT, Date.now())).settingsChanged).toBe(1);

    appendFileSync(join(root, 's1.jsonl'), `${TOOL_RESULT}\n${ASSISTANT_2}\n`);
    const before = f.store.read.query('SELECT input_tokens FROM session_usage').get();
    expect(before).toEqual({ input_tokens: 1200 });
    writeFileSync(join(root, 's1.settings.json'), JSON.stringify({
      tokenUsage: { inputTokens: 2000, outputTokens: 500, cacheCreationTokens: 60, cacheReadTokens: 1500, thinkingTokens: 70, factoryCredits: 2.5 },
      model: 'synth-model',
    }));
    expect((await ingestDroidBatch(f.store, root, SALT, Date.now())).settingsChanged).toBe(1);
    expect(f.store.read.query('SELECT input_tokens, output_tokens FROM session_usage').get())
      .toEqual({ input_tokens: 2000, output_tokens: 500 });

    // 内容没变的覆盖写不重复记变化。
    expect((await ingestDroidBatch(f.store, root, SALT, Date.now())).settingsChanged).toBe(0);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('原始层脱敏：敏感片段不进 raw_droid_event 与正文块', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const secret = 'sk-synthsecret1234567890';
    const user = json({
      type: 'message', id: 'm-u1', timestamp: iso(T0),
      message: { role: 'user', content: [{ type: 'text', text: `use ${secret}` }] },
    });
    writeSession(root, 's1.jsonl', [SESSION, user, ASSISTANT_1]);
    await ingestDroidBatch(f.store, root, SALT, Date.now());
    const raw = f.store.read.query('SELECT payload_json FROM raw_droid_event').all() as { payload_json: string }[];
    expect(raw.some(row => row.payload_json.includes(secret))).toBe(false);
    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(JSON.stringify(body!.messages)).not.toContain(secret);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});