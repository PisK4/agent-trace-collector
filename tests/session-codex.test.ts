import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { codexAdapter } from '../src/sources/session/adapters/codex';
import { ingestSessionBatch, ingestSessionFile } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = '11111111-aaaa-bbbb-cccc-222222222222';
const PARENT_ID = '33333333-dddd-eeee-ffff-444444444444';
const CHILD_ID = '55555555-6666-7777-8888-999999999999';
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atc-codex-session-'));
}

/** Codex 每行的外壳；payload 才是适配器关心的对象。 */
function row(timestamp: string, type: string, payload: unknown): string {
  return json({ timestamp, type, payload });
}

function meta(id: string, extra: Record<string, unknown> = {}): string {
  return row(iso(T0), 'session_meta', { id, session_id: id, cwd: '/work/synthetic', ...extra });
}

function turn(turnId: string, timestamp = T0): string {
  return row(iso(timestamp), 'turn_context', {
    turn_id: turnId, model: 'gpt-synthetic', cwd: '/work/synthetic',
  });
}

function item(timestamp: number, payload: Record<string, unknown>): string {
  return row(iso(timestamp), 'response_item', payload);
}

function usage(timestamp: number, responseId: string | null, turnId: string,
  value: Record<string, unknown> = {
    input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 10,
    output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 165,
  }): string {
  return row(iso(timestamp), 'token_usage_record', {
    ...(responseId === null ? {} : { response_id: responseId }),
    turn_id: turnId, usage: value,
  });
}

function tokenCount(timestamp: number, lastUsage: Record<string, unknown>): string {
  return row(iso(timestamp), 'event_msg', {
    type: 'token_count', info: { last_token_usage: lastUsage, total_token_usage: lastUsage },
  });
}

function writeSession(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function writeSessionZst(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)));
  return path;
}

const developerItem = {
  type: 'message', role: 'developer',
  content: [{ type: 'input_text', text: 'synthetic developer instructions' }],
};
const userItem = {
  type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'synthetic first prompt' }],
};
const assistantItem = {
  type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'synthetic reply' }],
};
const toolCallItem = {
  type: 'custom_tool_call', call_id: 'call-synth-1', name: 'shell', input: 'echo synthetic',
};

test('Codex 会话：用量行结算一笔调用，请求窗口与回复项按 Responses 形状保存', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `rollout-synthetic.jsonl`, [
      meta(SESSION_ID),
      turn('turn-1'),
      item(T0 + 100, developerItem),
      item(T0 + 200, userItem),
      item(T0 + 1_000, assistantItem),
      item(T0 + 1_100, toolCallItem),
      // 与调用无关的事件不落原始层。
      row(iso(T0 + 1_200), 'world_state', { any: 'ignored' }),
      usage(T0 + 2_000, 'resp_synth-1', 'turn-1'),
    ]);

    const result = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 1, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const rows = f.store.read.query(`
      SELECT req_id, via, agent, session, conv_key, conv_source, actor, subagent, parent_agent,
        started_ms, model_requested, response_id_norm, turn_ref,
        in_tok, out_tok, cache_read, cache_write, have, body_state, msg_count, sort_source,
        source_facts_json
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'codex', session: SESSION_ID,
      conv_key: json(['session', SESSION_ID]), conv_source: 'codex-session',
      actor: SESSION_ID, subagent: null, parent_agent: null,
      started_ms: T0 + 200, model_requested: 'gpt-synthetic',
      response_id_norm: 'synth-1', turn_ref: 'turn-1',
      in_tok: 60, out_tok: 20, cache_read: 30, cache_write: 10,
      have: 16, body_state: 'available', msg_count: 2, sort_source: 'codex_session',
    });
    const facts = JSON.parse(rows[0]!.source_facts_json as string) as {
      session: { usageScope: string; reasoningEffort: string | null; cwd: string | null };
    };
    expect(facts.session).toEqual({ usageScope: 'session', reasoningEffort: null, cwd: '/work/synthetic' });

    const first = readBodyWithMessagesTx(f.store.read, 1);
    expect(first!.body.protocol).toBe('responses');
    expect(first!.body.request).toEqual({ input: [developerItem, userItem] });
    expect(first!.body.reply).toEqual({ output: [assistantItem, toolCallItem] });

    expect(f.store.read.query(
      'SELECT source_kind, ref_key, match_rule FROM request_evidence ORDER BY req_id').all(),
    ).toEqual([
      {
        source_kind: 'codex_session_call', ref_key: `${SESSION_ID}/resp_synth-1`,
        match_rule: 'match_absent',
      },
    ]);
    // 7 条相关行落原始层；world_state 被忽略。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 7 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 老会话：token_count 兜底，用量取 last_token_usage 且没有 response id', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `rollout-old.jsonl`, [
      meta(SESSION_ID),
      turn('turn-old'),
      item(T0 + 300, userItem),
      item(T0 + 1_000, assistantItem),
      tokenCount(T0 + 2_000, {
        input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0,
        output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 55,
      }),
    ]);

    const result = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(result.calls).toBe(1);
    const rowValue = f.store.read.query(`
      SELECT started_ms, response_id_norm, in_tok, out_tok, cache_read, cache_write
      FROM request`).get() as Record<string, unknown>;
    expect(rowValue).toEqual({
      started_ms: T0 + 300, response_id_norm: null, in_tok: 40, out_tok: 5,
      cache_read: 10, cache_write: 0,
    });
    // 没有 response_id 时，调用身份由 turn 与物理偏移组成，跨批次稳定。
    const evidence = f.store.read.query(
      'SELECT ref_key FROM request_evidence').get() as { ref_key: string };
    expect(evidence.ref_key.startsWith(`${SESSION_ID}/turn-old/`)).toBe(true);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 子代理：会话折叠到父会话，actor 与 subagent 记子会话', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `rollout-child.jsonl`, [
      meta(CHILD_ID, { parent_thread_id: PARENT_ID }),
      turn('turn-child'),
      item(T0 + 100, userItem),
      item(T0 + 1_000, assistantItem),
      usage(T0 + 2_000, 'resp_child-1', 'turn-child'),
    ]);

    const result = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(result.calls).toBe(1);
    const rowValue = f.store.read.query(`
      SELECT session, actor, subagent, parent_agent, conv_key FROM request`).get();
    expect(rowValue).toEqual({
      session: PARENT_ID, actor: CHILD_ID, subagent: CHILD_ID, parent_agent: PARENT_ID,
      conv_key: json(['session', PARENT_ID]),
    });
    expect(f.store.read.query('SELECT ref_key FROM request_evidence').get())
      .toEqual({ ref_key: `${PARENT_ID}/resp_child-1` });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 坏行停游标：坏行前的调用已落库，坏行记 codex_ issue', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `rollout-bad.jsonl`, [
      meta(SESSION_ID),
      turn('turn-1'),
      item(T0 + 100, userItem),
      item(T0 + 1_000, assistantItem),
      usage(T0 + 2_000, 'resp_before-1', 'turn-1'),
      '{"type":"token_usage_record", broken',
      item(T0 + 3_000, userItem),
      item(T0 + 4_000, assistantItem),
      usage(T0 + 5_000, 'resp_after-1', 'turn-1'),
    ]);

    const result = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='codex_session'").get())
      .toEqual({ reason: 'codex_invalid_json' });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='codex_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBeLessThan(cursor.seen_size);

    // 直接按文件摄入一次，确认同一份文件不会越过坏行补出第二笔调用。
    const file = {
      name: join(root, 'rollout-bad.jsonl'), path: join(root, 'rollout-bad.jsonl'),
      size: 0, mtimeMs: 0, remaining: 1,
    };
    const again = await ingestSessionFile(f.store, codexAdapter, file, SALT, Date.now());
    expect(again.calls).toBe(0);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 压缩转录：.jsonl.zst 按整份指纹摄入，未变不再解压', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSessionZst(root, 'rollout-archive.jsonl.zst', [
      meta(SESSION_ID),
      turn('turn-1'),
      item(T0 + 100, developerItem),
      item(T0 + 200, userItem),
      item(T0 + 1_000, assistantItem),
      usage(T0 + 2_000, 'resp_archive-1', 'turn-1'),
    ]);

    const first = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(first).toMatchObject({ files: 1, calls: 1, invalid: 0, blocked: 0 });
    expect(f.store.read.query(
      'SELECT session, response_id_norm, started_ms FROM request').get())
      .toEqual({ session: SESSION_ID, response_id_norm: 'archive-1', started_ms: T0 + 200 });

    const cursor = f.store.read.query(`
      SELECT file_generation, fingerprint, committed_off, seen_size
      FROM source_cursor WHERE source_kind='codex_session'`).get() as {
      file_generation: string; fingerprint: string; committed_off: number; seen_size: number;
    };
    expect(cursor.file_generation).toMatch(/^[0-9a-f]{64}$/);
    expect(cursor.fingerprint).toBe(cursor.file_generation);
    expect(cursor.committed_off).toBeGreaterThan(0);

    // 同一份压缩字节：发现阶段 remaining=0，不再进读取器。
    const second = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(second.files).toBe(0);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 压缩转录损坏：记固定 issue，不建调用也不推进游标', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = join(root, 'rollout-broken.jsonl.zst');
    writeFileSync(path, Buffer.from('not a zstd frame'));
    const result = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 0, invalid: 0, blocked: 0 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='codex_session'").get())
      .toEqual({ reason: 'codex_zstd_invalid' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 0 });
    expect(f.store.read.query(
      "SELECT COUNT(*) AS n FROM source_cursor WHERE source_kind='codex_session'").get())
      .toEqual({ n: 0 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
