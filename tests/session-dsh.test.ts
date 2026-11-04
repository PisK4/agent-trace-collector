import { expect, test } from 'bun:test';
import {
  appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { dshAdapter } from '../src/sources/session/adapters/dsh';
import { discoverDsh, dshZstdRead } from '../src/sources/session/adapters/dsh-read';
import { ingestSessionBatch } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const PARENT = 'dsh-synthetic-parent';
const CHILD = 'dsh-synthetic-child';
const json = (value: unknown): string => JSON.stringify(value);

function makeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'atc-dsh-')), 'sessions');
}

function sessionDir(root: string, id: string): string {
  const dir = join(root, 'project-synthetic', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function head(id: string, extra: Record<string, unknown> = {}): string {
  return json({
    type: 'session', version: 4, id, createdAt: T0, cwd: '/work/synthetic',
    isSeeded: false, delegationDepth: 0, ...extra,
  });
}

function user(seq: number, text: string): string {
  return json({
    type: 'user/message', seq, time: T0 + seq * 1_000,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
  });
}

function assistant(seq: number, text: string,
  usage: Record<string, unknown> = {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10,
  }): string {
  return json({
    type: 'assistant/message', seq, time: T0 + seq * 1_000,
    data: {
      content: [{ type: 'text', text }],
      message: { source: { model: 'deepseek-synthetic', provider: 'synthetic' } },
      usage,
    },
  });
}

function endSeed(seq: number): string {
  return json({ type: 'session/end-seed', seq, time: T0 + seq * 1_000, data: {} });
}

function frame(lines: string[]): Buffer {
  return zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`));
}

function writeFrames(dir: string, name: string, batches: string[][]): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(batches.map(frame)));
  return path;
}

test('DSH 发现：每个会话目录只取版本最高的一份', () => {
  const root = makeRoot();
  try {
    const dir = sessionDir(root, PARENT);
    const old = join(dir, 'session.v3.jsonl.zstd');
    const latest = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(old, frame([head(PARENT)]));
    writeFileSync(latest, frame([head(PARENT), user(0, 'synthetic prompt')]));
    // 版本低但 mtime 更新，仍应被版本号淘汰。
    utimesSync(old, new Date(T0 + 10_000), new Date(T0 + 10_000));
    utimesSync(latest, new Date(T0), new Date(T0));

    const files = discoverDsh(root, () => null);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(latest);
    expect(files[0]!.remaining).toBe(statSync(latest).size);

    const partial = discoverDsh(root, () => ({
      generation: 'synthetic',
      committedOff: 10,
      observedOff: 0,
      seenSize: statSync(latest).size,
    }));
    expect(partial[0]!.remaining).toBe(statSync(latest).size - 10);
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('DSH 多 frame：半写 frame 不提交，补齐后从上一 frame 继续', () => {
  const root = makeRoot();
  try {
    const dir = sessionDir(root, PARENT);
    const path = join(dir, 'session.v4.jsonl.zstd');
    const first = frame([head(PARENT), user(0, 'synthetic prompt'), assistant(1, 'synthetic reply')]);
    const second = frame([user(2, 'second prompt'), assistant(3, 'second reply')]);
    writeFileSync(path, Buffer.concat([first, second.subarray(0, 5)]));

    const file = discoverDsh(root, () => null)[0]!;
    const read = dshZstdRead(file, null, 'dsh_session');
    expect(read.state).toBe('decoded');
    expect(read.lines.map(line => line.text)).toEqual([head(PARENT), user(0, 'synthetic prompt'),
      assistant(1, 'synthetic reply')]);
    expect(read.committedOff).toBe(first.length);
    expect(read.observedOff).toBe(first.length + 5);

    appendFileSync(path, second.subarray(5));
    const grown = {
      ...file, size: statSync(path).size, remaining: statSync(path).size - read.committedOff,
    };
    const next = dshZstdRead(grown, read, 'dsh_session');
    expect(next.state).toBe('decoded');
    expect(next.startOff).toBe(first.length);
    expect(next.lines.map(line => line.text)).toEqual([user(2, 'second prompt'), assistant(3, 'second reply')]);
    expect(next.committedOff).toBe(statSync(path).size);
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('DSH 摄入：父会话调用、分叉 seed 不重复、结束标记后才计自己的调用', async () => {
  const f = fixture();
  const root = makeRoot();
  try {
    const parentDir = sessionDir(root, PARENT);
    writeFrames(parentDir, 'session.v4.jsonl.zstd', [
      [head(PARENT)],
      [user(0, 'parent prompt'), assistant(1, 'parent reply')],
    ]);

    const childDir = sessionDir(root, CHILD);
    writeFrames(childDir, 'session.v4.jsonl.zstd', [
      [head(CHILD, {
        isSeeded: true, parentSession: PARENT, delegationDepth: 1,
      })],
      [user(0, 'seed prompt'), assistant(1, 'seed reply')],
    ]);

    const first = await ingestSessionBatch(f.store, dshAdapter, [root], SALT, T0);
    expect(first.calls).toBe(1);
    expect(first.duplicates).toBe(0);

    const childPath = join(childDir, 'session.v4.jsonl.zstd');
    appendFileSync(childPath, Buffer.concat([
      frame([endSeed(2), user(3, 'child prompt'), assistant(4, 'child reply',
        { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })]),
    ]));

    let calls = 0;
    for (let round = 0; round < 5; round += 1) {
      const result = await ingestSessionBatch(f.store, dshAdapter, [root], SALT, T0);
      if (result.files === 0) break;
      calls += result.calls;
      expect(result.duplicates).toBe(0);
    }
    expect(calls).toBe(1);

    const rows = f.store.read.query(`
      SELECT session, actor, subagent, parent_agent, model_requested, in_tok, out_tok,
        cache_read, cache_write, started_ms
      FROM request ORDER BY req_id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      session: PARENT, actor: PARENT, subagent: null, parent_agent: null,
      model_requested: 'deepseek-synthetic', in_tok: 100, out_tok: 20,
      cache_read: 30, cache_write: 10, started_ms: T0 + 1_000,
    });
    expect(rows[1]).toMatchObject({
      session: PARENT, actor: CHILD, subagent: CHILD, parent_agent: PARENT,
      model_requested: 'deepseek-synthetic', in_tok: 50, out_tok: 10,
      cache_read: 0, cache_write: 0, started_ms: T0 + 4_000,
    });

    const evidence = f.store.read.query(
      'SELECT source_kind, ref_key FROM request_evidence ORDER BY req_id').all();
    expect(evidence).toEqual([
      { source_kind: 'dsh_session_call', ref_key: `${PARENT}/seq:1` },
      { source_kind: 'dsh_session_call', ref_key: `${PARENT}/${CHILD}/seq:4` },
    ]);

    const parentBody = readBodyWithMessagesTx(f.store.read, 1)!;
    expect(parentBody.body.protocol).toBe('chat');
    expect(parentBody.body.request).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'parent prompt' }] }],
    });
    expect(parentBody.body.reply).toEqual({
      choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'parent reply' }] } }],
    });

    const cursors = f.store.read.query<{
      source_name: string; committed_off: number; observed_off: number;
    }, []>('SELECT source_name, committed_off, observed_off FROM source_cursor ORDER BY source_name').all();
    expect(cursors).toHaveLength(2);
    for (const cursor of cursors) expect(cursor.committed_off).toBe(cursor.observed_off);
    const issues = f.store.read.query('SELECT COUNT(*) AS n FROM ingest_issue').get() as { n: number };
    expect(issues.n).toBe(0);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('DSH 格式 1：seedLength 之前的事件只进窗口，不建调用', async () => {
  const f = fixture();
  const root = makeRoot();
  try {
    const dir = sessionDir(root, PARENT);
    writeFrames(dir, 'session.jsonl.zstd', [[
      head(PARENT, { version: 1, isSeeded: true, seedLength: 2 }),
      user(0, 'seed prompt'),
      assistant(1, 'seed reply'),
      user(2, 'own prompt'),
      assistant(3, 'own reply', { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 }),
    ]]);

    const result = await ingestSessionBatch(f.store, dshAdapter, [root], SALT, T0);
    expect(result.calls).toBe(1);
    const rowValue = f.store.read.query(`
      SELECT started_ms, in_tok, out_tok, msg_count FROM request`).get();
    expect(rowValue).toEqual({ started_ms: T0 + 3_000, in_tok: 7, out_tok: 3, msg_count: 3 });
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('DSH 子代理：同父的两个子代理都能建行，seq 不互相挤掉', async () => {
  const f = fixture();
  const root = makeRoot();
  const first = 'dsh-synthetic-child-a';
  const second = 'dsh-synthetic-child-b';
  try {
    for (const id of [first, second]) {
      writeFrames(sessionDir(root, id), 'session.v4.jsonl.zstd', [
        [head(id, { parentSession: PARENT, delegationDepth: 1 })],
        [user(0, 'synthetic prompt'), assistant(1, 'synthetic reply')],
      ]);
    }

    const result = await ingestSessionBatch(f.store, dshAdapter, [root], SALT, T0);
    expect(result.calls).toBe(2);
    expect(result.duplicates).toBe(0);
    const rows = f.store.read.query(
      'SELECT session, actor, subagent, parent_agent FROM request ORDER BY actor').all();
    expect(rows).toEqual([
      { session: PARENT, actor: first, subagent: first, parent_agent: PARENT },
      { session: PARENT, actor: second, subagent: second, parent_agent: PARENT },
    ]);
    const evidence = f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY ref_key').all();
    expect(evidence).toEqual([
      { ref_key: `${PARENT}/${first}/seq:1` },
      { ref_key: `${PARENT}/${second}/seq:1` },
    ]);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});
