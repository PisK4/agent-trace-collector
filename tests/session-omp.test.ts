import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { ompAdapter } from '../src/sources/session/adapters/omp';
import { piAdapter } from '../src/sources/session/adapters/pi';
import { ingestSessionBatch } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const OMP_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PI_FILE_SESSION = 'ffffffff-0000-4000-8000-111111111111';
const PI_SESSION = 'pi-synth-session';
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atc-jsonl-session-'));
}

function writeSession(root: string, name: string, lines: unknown[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.map(line => typeof line === 'string' ? line : json(line)).join('\n')}\n`);
  return path;
}

function sessionLine(timestamp: number, extra: Record<string, unknown> = {}): unknown {
  return { type: 'session', timestamp: iso(timestamp), ...extra };
}

function messageLine(timestamp: number, message: Record<string, unknown>): unknown {
  return { type: 'message', timestamp: iso(timestamp), message };
}

test('OMP 会话：无 session.id 时用文件名 UUID，逐 assistant 消息结算调用', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `2026-09-01T10-00-00.000Z_${OMP_SESSION}.jsonl`, [
      // OMP 的 session 行可以没有 id；只给标题与更新时间。
      sessionLine(T0, { v: 3, title: 'synthetic omp', source: 'synthetic', pad: 'x' }),
      messageLine(T0, {
        role: 'user', content: [{ type: 'text', text: 'first prompt' }],
      }),
      messageLine(T0 + 1_500, {
        role: 'assistant',
        // 行时间与消息时间不同：调用开始时间取消息自己的 timestamp。
        timestamp: iso(T0 + 2_000),
        model: 'omp-synthetic',
        content: [
          { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig' },
          { type: 'text', text: 'first reply' },
          { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/work/synthetic/a.txt' } },
        ],
        usage: {
          input: 100, output: 20, cacheRead: 50, cacheWrite: 10,
          totalTokens: 170, reasoningTokens: 5, cost: 0.1,
        },
        responseId: 'resp_synth-omp-1',
        duration: 1_234.6,
        completedAt: iso(T0 + 3_234),
      }),
      messageLine(T0 + 3_000, {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'read_file',
        isError: false, content: [{ type: 'text', text: 'file body' }],
      }),
      // 无 message.timestamp：由 completedAt - round(duration) 推回开始时间。
      messageLine(T0 + 4_000, {
        role: 'assistant',
        model: 'omp-synthetic',
        content: [{ type: 'text', text: 'second reply' }],
        usage: { input: 160, output: 30, cacheRead: 80, cacheWrite: 0, totalTokens: 270 },
        responseId: 'resp_synth-omp-2',
        duration: 1_234.6,
        completedAt: iso(T0 + 5_000),
      }),
    ]);

    const result = await ingestSessionBatch(f.store, ompAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 2, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const rows = f.store.read.query(`
      SELECT req_id, via, agent, session, conv_key, started_ms, model_requested,
        response_id_norm, in_tok, out_tok, cache_read, cache_write, msg_count,
        sort_source, source_facts_json
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      via: 'session', agent: 'omp', session: OMP_SESSION,
      conv_key: json(['session', OMP_SESSION]),
      started_ms: T0 + 2_000, model_requested: 'omp-synthetic',
      response_id_norm: 'synth-omp-1',
      in_tok: 100, out_tok: 20, cache_read: 50, cache_write: 10,
      msg_count: 1, sort_source: 'omp_session',
    });
    expect(rows[1]).toMatchObject({
      started_ms: T0 + 3_765, response_id_norm: 'synth-omp-2',
      in_tok: 160, out_tok: 30, cache_read: 80, cache_write: 0, msg_count: 3,
    });

    const first = readBodyWithMessagesTx(f.store.read, 1);
    expect(first!.body.protocol).toBe('anthropic');
    expect(first!.messages).toHaveLength(1);
    expect(first!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'first reply' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: '/work/synthetic/a.txt' } },
    ] });

    const second = readBodyWithMessagesTx(f.store.read, 2);
    expect(second!.messages).toHaveLength(3);
    expect(second!.messages![2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body' }],
    });

    expect(f.store.read.query(`
      SELECT source_kind, ref_key FROM request_evidence ORDER BY req_id`).all(),
    ).toEqual([
      { source_kind: 'omp_session_call', ref_key: `${OMP_SESSION}/resp_synth-omp-1` },
      { source_kind: 'omp_session_call', ref_key: `${OMP_SESSION}/resp_synth-omp-2` },
    ]);

    const facts = JSON.parse(rows[0]!.source_facts_json as string) as {
      session: { usageScope: string; reasoningEffort: string | null; cwd: string | null };
    };
    expect(facts.session).toEqual({ usageScope: 'session', reasoningEffort: null, cwd: null });

    const cursor = f.store.read.query(`
      SELECT committed_off, seen_size FROM source_cursor
      WHERE source_kind='omp_session'`).get() as { committed_off: number; seen_size: number };
    expect(cursor.committed_off).toBe(cursor.seen_size);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi 会话：session.id 覆盖文件名 UUID，usage 缺失缓存字段按 0', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `2026-09-01T10-00-00.000Z_${PI_FILE_SESSION}.jsonl`, [
      sessionLine(T0, { id: PI_SESSION, cwd: '/work/synthetic', version: '1.0.0' }),
      messageLine(T0, {
        role: 'user', content: [{ type: 'text', text: 'pi prompt' }],
      }),
      messageLine(T0 + 1_000, {
        role: 'assistant',
        timestamp: iso(T0 + 1_000),
        model: 'pi-synthetic',
        content: [{ type: 'text', text: 'pi reply' }],
        // Pi 的 totalTokens = input + output + cacheRead；没有 responseId。
        usage: { input: 40, output: 8, totalTokens: 48 },
      }),
    ]);

    const result = await ingestSessionBatch(f.store, piAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ files: 1, calls: 1, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const row = f.store.read.query(`
      SELECT agent, session, conv_key, started_ms, model_requested, response_id_norm,
        in_tok, out_tok, cache_read, cache_write, sort_source
      FROM request`).get() as Record<string, unknown>;
    expect(row).toEqual({
      agent: 'pi', session: PI_SESSION, conv_key: json(['session', PI_SESSION]),
      started_ms: T0 + 1_000, model_requested: 'pi-synthetic', response_id_norm: null,
      in_tok: 40, out_tok: 8, cache_read: 0, cache_write: 0, sort_source: 'pi_session',
    });

    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.body.protocol).toBe('anthropic');
    expect(body!.messages).toHaveLength(1);
    expect(body!.body.reply).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'pi reply' },
    ] });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('OMP/Pi 坏行停游标：坏行前的调用已落库，坏行记为 issue', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeSession(root, `2026-09-01T10-00-00.000Z_${OMP_SESSION}.jsonl`, [
      sessionLine(T0, { title: 'synthetic omp' }),
      messageLine(T0, { role: 'user', content: [{ type: 'text', text: 'prompt' }] }),
      messageLine(T0 + 1_000, {
        role: 'assistant', model: 'omp-synthetic', responseId: 'resp_bad-1',
        content: [{ type: 'text', text: 'reply' }],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
      '{"type":"message", broken',
      messageLine(T0 + 2_000, { role: 'user', content: [{ type: 'text', text: 'later' }] }),
    ]);

    const result = await ingestSessionBatch(f.store, ompAdapter, [root], SALT, Date.now());
    expect(result).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='omp_session'").get())
      .toEqual({ reason: 'omp_invalid_json' });

    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='omp_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBeLessThan(cursor.seen_size);

    // Pi 的坏行原因使用自己的前缀。
    expect(piAdapter.parse('{"type":"message", broken')).toEqual({
      kind: 'invalid', reason: 'pi_invalid_json',
    });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
