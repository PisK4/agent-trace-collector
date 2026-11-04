import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fixture } from './fixtures';
import { codexAdapter } from '../src/sources/session/adapters/codex';
import { discoverSessionFiles, ingestSessionBatch, ingestSessionFiles } from '../src/sources/session/ingest';
import { discoverJsonl, sealedJsonlRead } from '../src/sources/session/read';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const json = (value: unknown): string => JSON.stringify(value);

function row(timestamp: string, type: string, payload: unknown): string {
  return json({ timestamp, type, payload });
}

function meta(): string {
  return row(new Date(T0).toISOString(), 'session_meta', {
    id: SESSION_ID, session_id: SESSION_ID, cwd: '/work/synthetic',
  });
}

function turn(turnId: string, timestamp: number): string {
  return row(new Date(timestamp).toISOString(), 'turn_context', {
    turn_id: turnId, model: 'gpt-synthetic', cwd: '/work/synthetic',
  });
}

function item(timestamp: number, payload: Record<string, unknown>): string {
  return row(new Date(timestamp).toISOString(), 'response_item', payload);
}

function usage(timestamp: number, responseId: string, turnId: string): string {
  return row(new Date(timestamp).toISOString(), 'token_usage_record', {
    response_id: responseId, turn_id: turnId,
    usage: {
      input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 10,
      output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 165,
    },
  });
}

function writeZst(root: string, lines: string[]): string {
  const path = join(root, 'rollout-chunk.jsonl.zst');
  writeFileSync(path, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)));
  return path;
}

test('封口会话按解压分块读取，发现阶段从 observed_off 算剩余', () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-sealed-chunk-'));
  try {
    const lines = Array.from({ length: 300 }, (_, index) =>
      JSON.stringify({ index, text: 'x'.repeat(4096) }));
    const path = writeZst(root, lines);
    const files = discoverJsonl(root, () => null, { extensions: ['.jsonl.zst'] });
    expect(files).toHaveLength(1);

    const first = sealedJsonlRead(files[0]!, null, 'codex_session');
    expect(first.state).toBe('decoded');
    expect(first.startOff).toBe(0);
    expect(first.observedOff).toBeGreaterThan(first.committedOff);
    expect(first.committedOff - first.startOff).toBeLessThanOrEqual(512 * 1024 + 4096);

    const partial = discoverJsonl(root, () => ({
      generation: first.generation, committedOff: first.committedOff,
      observedOff: first.observedOff, seenSize: first.seenSize,
    }), { extensions: ['.jsonl.zst'] });
    expect(partial[0]!.remaining).toBe(first.observedOff - first.committedOff);

    const seen = [...first.lines];
    let read = first;
    let batches = 1;
    while (read.state === 'decoded' && read.committedOff < read.observedOff) {
      batches += 1;
      expect(batches).toBeLessThan(20);
      const next = sealedJsonlRead(files[0]!, read, 'codex_session');
      expect(next.state).toBe('decoded');
      expect(next.startOff).toBe(read.committedOff);
      seen.push(...next.lines);
      read = next;
    }
    expect(batches).toBeGreaterThan(1);
    expect(read.committedOff).toBe(read.observedOff);
    expect(seen.map(line => line.text)).toEqual(lines);

    const complete = discoverJsonl(root, () => ({
      generation: read.generation, committedOff: read.committedOff,
      observedOff: read.observedOff, seenSize: read.seenSize,
    }), { extensions: ['.jsonl.zst'] });
    expect(complete[0]!.remaining).toBe(0);
    expect(path.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('封口会话跨分块摄入会补齐状态，游标最终到整份末尾', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-sealed-ingest-'));
  const f = fixture();
  try {
    const turns = 80;
    const lines = [meta()];
    for (let index = 0; index < turns; index += 1) {
      const timestamp = T0 + index * 1_000;
      const turnId = `turn-chunk-${index}`;
      lines.push(turn(turnId, timestamp));
      lines.push(item(timestamp + 100, {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `question ${index} ${'x'.repeat(2048)}` }],
      }));
      lines.push(item(timestamp + 200, {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'synthetic reply' }],
      }));
      lines.push(usage(timestamp + 300, `resp-chunk-${index}`, turnId));
    }
    const path = writeZst(root, lines);

    let calls = 0;
    let duplicates = 0;
    let batches = 0;
    // 预算压到 1 字节，强制每次只提交一个分块，验证跨事务重放。
    while (batches < 200) {
      const files = await discoverSessionFiles(f.store, codexAdapter, [root], T0);
      const result = await ingestSessionFiles(f.store, codexAdapter, files, SALT, T0,
        { maxFiles: 1, maxBytes: 1 });
      if (result.files === 0) break;
      calls += result.calls;
      duplicates += result.duplicates;
      batches += 1;
      expect(result.duplicates).toBe(0);
    }

    expect(batches).toBeGreaterThan(1);
    expect(calls).toBe(turns);
    expect(duplicates).toBe(0);
    // 已到末尾：默认预算的一批不再选中任何文件。
    const rest = await ingestSessionBatch(f.store, codexAdapter, [root], SALT, T0);
    expect(rest.files).toBe(0);
    const cursor = f.store.read.query<{
      committed_off: number; observed_off: number;
    }, [string, string]>(
      'SELECT committed_off,observed_off FROM source_cursor WHERE source_kind=? AND source_name=?',
    ).get('codex_session', path)!;
    expect(cursor.committed_off).toBe(cursor.observed_off);
    const requests = f.store.read.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM request').get()!;
    const evidence = f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM request_evidence WHERE source_kind='codex_session_call'",
    ).get()!;
    const issues = f.store.read.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM ingest_issue WHERE source_kind='codex_session'",
    ).get()!;
    expect(requests.n).toBe(turns);
    expect(evidence.n).toBe(turns);
    expect(issues.n).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.close();
  }
});