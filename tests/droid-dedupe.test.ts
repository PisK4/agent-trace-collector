import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import type { SourceRead } from '../src/sources/files';
import { ingestSource } from '../src/reconcile';
import { readBodyWithMessagesTx } from '../src/body';
import { ingestDroidBatch } from '../src/sources/droid/ingest';

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const SALT = new Uint8Array(32);
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);
const CONV = json(['session', 's1']);

const SESSION = json({ type: 'session_start', id: 's1', cwd: '/work/synth', version: 2 });
const USER = json({
  type: 'message', id: 'm-u1', timestamp: iso(T0),
  message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
});

function droidAssistant(messageId: string, responseId: string | null, model: string | null, at: number): string {
  return json({
    type: 'message', id: messageId, timestamp: iso(at),
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'reply' }],
      ...(model === null ? {} : { modelId: model }),
      ...(responseId === null ? {} : { openaiMessageId: responseId }),
    },
  });
}

function writeTranscript(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'atc-droid-dedupe-'));
  writeFileSync(join(root, 's1.jsonl'), `${lines.join('\n')}\n`);
  return root;
}

function ledgerBatch(rows: unknown[], generation: string): SourceRead {
  let offset = 0;
  const lines = rows.map(row => {
    const text = JSON.stringify(row);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    sourceKind: 'ledger',
    name: 'usage.jsonl',
    mode: 'appendable',
    state: 'decoded',
    generation,
    rewriteEpoch: 0,
    lines,
    committedOff: offset,
    observedOff: offset,
    seenSize: offset,
    headLen: 0,
    headHash: null,
    fingerprint: null,
    issues: [],
    startOff: 0,
    error: null,
  };
}

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: iso(T0), agent: 'droid', provider: 'synth', status: 200, session: 's1',
    model: 'synth-model', req: 'synth-model', in: 10, out: 5,
    ...overrides,
  };
}

test('账本先到、droid 晚到：按 response id 认领同一行，只补空字段与正文', async () => {
  const f = fixture();
  const root = writeTranscript([
    SESSION, USER, droidAssistant('m-a1', 'gen-1779000000000-abc', 'synth-model', T0 + 2_000),
  ]);
  try {
    ingestSource(f.store, ledgerBatch([ledgerRow({ response_id: 'gen-1779000000000-abc' })], 'ledger-g1'), SALT, 1);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });

    const result = await ingestDroidBatch(f.store, root, SALT, 2);
    expect(result).toMatchObject({ calls: 0, merged: 1, duplicates: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    const row = f.store.read.query(`
      SELECT via, agent, session, conv_key, response_id_norm, model_requested, have,
        body_state, parse_state, msg_count
      FROM request`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      via: 'through', agent: 'droid', session: 's1', conv_key: CONV,
      response_id_norm: 'gen-1779000000000-abc', have: 18, body_state: 'available',
      parse_state: 'ok', msg_count: 1,
    });
    const evidence = f.store.read.query(
      "SELECT source_kind, ref_key, match_rule FROM request_evidence ORDER BY source_kind").all();
    expect(evidence).toEqual([
      { source_kind: 'ledger', ref_key: json(['file', 'ledger-g1', 0]), match_rule: 'match_absent' },
      { source_kind: 'session_call', ref_key: 's1/m-a1', match_rule: 'response_id_norm.v1' },
    ]);
    const body = readBodyWithMessagesTx(f.store.read, 1);
    expect(body!.body.protocol).toBe('droid-session');
    expect(body!.messages).toHaveLength(1);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejected 账本行不是认领对象：droid 另建一行', async () => {
  const f = fixture();
  const root = writeTranscript([
    SESSION, USER, droidAssistant('m-a1', 'gen-1779000000000-abc', 'synth-model', T0 + 2_000),
  ]);
  try {
    ingestSource(f.store, ledgerBatch([
      ledgerRow({ response_id: 'gen-1779000000000-abc', status: 400, provider: '' }),
    ], 'ledger-g1'), SALT, 1);
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM request WHERE via='rejected'").get())
      .toEqual({ n: 1 });

    const result = await ingestDroidBatch(f.store, root, SALT, 2);
    expect(result).toMatchObject({ calls: 1, merged: 0 });
    expect(f.store.read.query('SELECT via, agent FROM request ORDER BY req_id').all()).toEqual([
      { via: 'rejected', agent: 'droid' },
      { via: 'session', agent: 'droid' },
    ]);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('droid 先到、账本晚到：账本认领 droid 行，证据位齐全且不覆盖已有正文', async () => {
  const f = fixture();
  const root = writeTranscript([
    SESSION, USER, droidAssistant('m-a1', 'gen-1779000000000-abc', 'synth-model', T0 + 2_000),
  ]);
  try {
    expect((await ingestDroidBatch(f.store, root, SALT, 1)).calls).toBe(1);
    ingestSource(f.store, ledgerBatch([ledgerRow({ response_id: 'gen-1779000000000-abc' })], 'ledger-g1'), SALT, 2);

    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    const row = f.store.read.query(
      'SELECT via, response_id_norm, model_requested, in_tok, have, body_state, sort_source FROM request').get();
    expect(row).toEqual({
      via: 'session', response_id_norm: 'gen-1779000000000-abc', model_requested: 'synth-model',
      in_tok: 10, have: 18, body_state: 'available', sort_source: 'ledger',
    });
    const evidence = f.store.read.query(
      "SELECT match_rule FROM request_evidence WHERE source_kind='ledger'").get();
    expect(evidence).toEqual({ match_rule: 'response_id_norm.v1' });
    // 已有正文保留，不被账本行清空或重建。
    expect(readBodyWithMessagesTx(f.store.read, 1)!.body.protocol).toBe('droid-session');
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('无 response id 时按同会话 ±60 秒认领；模型名不同不是拒绝理由', async () => {
  for (const model of ['synth-model', 'other-model']) {
    const f = fixture();
    const root = writeTranscript([SESSION, USER, droidAssistant('m-a1', null, 'synth-model', T0 + 2_000)]);
    try {
      expect((await ingestDroidBatch(f.store, root, SALT, 1)).calls).toBe(1);
      ingestSource(f.store, ledgerBatch([ledgerRow({ req: model, model })], 'ledger-g1'), SALT, 2);
      const rows = f.store.read.query('SELECT via FROM request ORDER BY req_id').all();
      expect(rows).toEqual([{ via: 'session' }]);
      expect(f.store.read.query(
        "SELECT match_rule FROM request_evidence WHERE source_kind='ledger'").get())
        .toEqual({ match_rule: 'conv_time_model.v1' });
    } finally {
      f.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('同窗同模型有两个候选：不合并，droid 独立成行并记 match_ambiguous', async () => {
  const f = fixture();
  const root = writeTranscript([SESSION, USER, droidAssistant('m-a1', null, 'synth-model', T0 + 2_000)]);
  try {
    for (const offset of [-1_000, 1_000]) {
      f.store.write(db => db.run(`
        INSERT INTO request(agent,session,conv_key,conv_source,actor,actor_state,
          started_ms,day,via,model_requested,body_state,derive_version,have,created_at,updated_at)
        VALUES ('droid','s1',?,'session','s1','known',?,'2026-08-24','hook','synth-model',
          'missing',0,1,?,?)`,
      [CONV, T0 + offset, 1, 1]));
    }
    const result = await ingestDroidBatch(f.store, root, SALT, 2);
    expect(result).toMatchObject({ calls: 1, merged: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 3 });
    expect(f.store.read.query(
      "SELECT match_rule FROM request_evidence WHERE source_kind='session_call'").get())
      .toEqual({ match_rule: 'match_ambiguous' });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});