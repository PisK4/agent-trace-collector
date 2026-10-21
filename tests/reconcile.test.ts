import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import type { FileBatch } from '../src/sources/files';
import { ingestLedger, ingestRoute, resumePausedLedger } from '../src/reconcile';

function batchOf(rows: unknown[], generation = 'g:0', startOffset = 0): FileBatch {
  let offset = startOffset;
  const lines = rows.map(row => {
    const text = typeof row === 'string' ? row : JSON.stringify(row);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    generation,
    rewriteEpoch: 0,
    lines,
    committedOff: offset,
    observedOff: offset,
    seenSize: offset,
    headLen: 0,
    headHash: null,
    issues: [],
  };
}

const salt = new Uint8Array(32).fill(7);

test('已确认归属的账本请求进入派生队列', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'synthetic-sess', in: 10, out: 5 },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    expect(f.store.read.query('SELECT conv_key, actor FROM derive_queue').all()).toEqual([
      { conv_key: JSON.stringify(['session', 'synthetic-sess']), actor: 'synthetic-sess' },
    ]);
  } finally {
    f.close();
  }
});

test('无会话身份的账本请求不入派生队列', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', agent: 'demo', model: 'm', provider: 'p', status: 400, rejected: true },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('两条计费行只生成一个请求且保留 kind', () => {
  const f = fixture();
  try {
    const rows = [
      { t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 429, in: 10, out: 0, handed_on: true },
      { t: '2026-10-20T00:00:01Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 200, in: 20, out: 5, kind: 'web_search', session: 's' },
    ];
    const batch = batchOf(rows);
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 1, salt)).toEqual({ accepted: 2, invalid: 0, duplicate: 0 });
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 2, salt)).toEqual({ accepted: 0, invalid: 0, duplicate: 2 });
    expect(f.store.read.query('SELECT status,attempt_in,attempt_billed,cache_write FROM request').all()).toEqual([
      { status: 200, attempt_in: 30, attempt_billed: 2, cache_write: null },
    ]);
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 2 });
    expect(f.store.read.query('SELECT count(*) AS n FROM request_evidence').get()).toEqual({ n: 2 });
    expect(f.store.read.query('SELECT kind FROM raw_ledger ORDER BY byte_offset').all()).toEqual([
      { kind: null }, { kind: 'web_search' },
    ]);
  } finally {
    f.close();
  }
});

test('路由先到不增请求，账本到达后补齐摘要', () => {
  const f = fixture();
  try {
    ingestRoute(f.store, [{
      id: 7,
      time: '2026-10-20T00:00:00Z',
      agent: 'demo',
      session: 's',
      conv: 'c',
      model: 'm',
      provider: 'p',
      status: 200,
      tries: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
      prompt: { tokens: 100, counted: 90, window: 200000, turns: 4, parts: [{ tokens: 10 }] },
      order: [{ provider: 'p', model: 'm' }],
    }], 1, salt);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM route_summary').get()).toEqual({ n: 1 });

    ingestLedger(f.store, 'usage.jsonl', batchOf([
      { t: '2026-10-20T00:00:02Z', route_id: 7, agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200, in: 10, out: 5 },
    ]), 2, salt);
    expect(f.store.read.query(
      'SELECT conv_key,conv_source,have,prompt_tokens,attempt_count,attempt_billed,actor,actor_state FROM request',
    ).all()).toEqual([{
      conv_key: JSON.stringify(['session', 's']),
      conv_source: 'session',
      have: 6,
      prompt_tokens: 100,
      attempt_count: 2,
      attempt_billed: 1,
      actor: 's',
      actor_state: 'known',
    }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM request_evidence').get()).toEqual({ n: 2 });
  } finally {
    f.close();
  }
});

test('无route的账本行各自建立独立请求', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', agent: 'demo', model: 'm', provider: 'p', status: 200, in: 1 },
      { t: '2026-10-20T00:00:01Z', agent: 'demo', model: 'm', provider: 'p', status: 200, in: 2 },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    const rows = f.store.read.query('SELECT route_id,attempt_billed,status FROM request ORDER BY req_id').all();
    expect(rows).toEqual([
      { route_id: null, attempt_billed: 1, status: 200 },
      { route_id: null, attempt_billed: 1, status: 200 },
    ]);
  } finally {
    f.close();
  }
});

test('rejected行不按空route合并且费用标注不适用', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', rejected: true, status: 400, provider: '', in: 5, out: 0 },
      { t: '2026-10-20T00:00:01Z', rejected: true, status: 401, provider: '', in: 6, out: 0 },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    expect(f.store.read.query('SELECT via,cost_state,cost_reason,status FROM request ORDER BY req_id').all()).toEqual([
      { via: 'rejected', cost_state: 'absent', cost_reason: 'not_applicable', status: 400 },
      { via: 'rejected', cost_state: 'absent', cost_reason: 'not_applicable', status: 401 },
    ]);
  } finally {
    f.close();
  }
});

test('坏完整行记录issue并推进游标，后续正常行入库', () => {
  const f = fixture();
  try {
    const batch = batchOf(['not json', { t: '2026-10-20T00:00:00Z', route_id: 9, agent: 'demo', model: 'm', provider: 'p', status: 200, in: 1 }]);
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 1, salt)).toEqual({ accepted: 1, invalid: 1, duplicate: 0 });
    expect(f.store.read.query('SELECT committed_off FROM source_cursor').get()).toEqual({ committed_off: batch.committedOff });
    expect(f.store.read.query('SELECT reason FROM ingest_issue').all()).toEqual([{ reason: 'ledger_invalid_json' }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('原始层删除后的重放不重复计费', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', model: 'm', provider: 'p', status: 200, in: 12, out: 3 },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    f.store.write(db => db.run('DELETE FROM raw_ledger'));
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 2, salt)).toEqual({ accepted: 0, invalid: 0, duplicate: 1 });
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get()).toEqual({ attempt_in: 12, attempt_billed: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('乱序到达按时间收敛且起始时间取最早', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([
      { t: '2026-10-20T00:00:02Z', route_id: 12, agent: 'demo', model: 'm', provider: 'p', status: 200, in: 2 },
    ], 'g:1'), 2, salt);
    ingestLedger(f.store, 'usage.jsonl', batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 12, agent: 'demo', model: 'm', provider: 'p', status: 500, in: 1 },
    ], 'g:0'), 3, salt);
    expect(f.store.read.query('SELECT status,attempt_in,attempt_billed,started_ms FROM request').get())
      .toEqual({ status: 200, attempt_in: 3, attempt_billed: 2, started_ms: Date.parse('2026-10-20T00:00:00Z') });
  } finally {
    f.close();
  }
});

test('缺字段保持NULL而不是补零', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 13, agent: 'demo', model: 'm', provider: 'p', status: 200, in: 7 },
    ]), 1, salt);
    expect(f.store.read.query('SELECT cache_read,cache_write,reasoning,cost,cost_state FROM request').get())
      .toEqual({ cache_read: null, cache_write: null, reasoning: null, cost: null, cost_state: 'absent' });
  } finally {
    f.close();
  }
});

test('暂停时只记缺口与observed_off，游标停在原处', () => {
  const f = fixture();
  try {
    const first = batchOf([{ t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 10, out: 5 }]);
    ingestLedger(f.store, 'usage.jsonl', first, 1, salt);
    const committed = f.store.read.query<{ committed_off: number }, []>('SELECT committed_off FROM source_cursor').get();
    expect(committed?.committed_off).toBe(first.committedOff);

    // 新一批到了但准入暂停：不写证据，只把看到的区间记成缺口。
    const paused = batchOf(
      [{ t: '2026-10-20T00:00:01Z', route_id: 8, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 1, out: 1 }],
      first.generation,
      first.committedOff,
    );
    resumePausedLedger(f.store, 'usage.jsonl', paused, 2);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT committed_off, observed_off FROM source_cursor').get()).toEqual({
      committed_off: first.committedOff, observed_off: paused.observedOff,
    });
    expect(f.store.read.query('SELECT from_off,to_off,state FROM source_gap').all()).toEqual([
      { from_off: first.committedOff, to_off: paused.observedOff, state: 'open' },
    ]);

    // 恢复后重读同一区间：证据入库，缺口关闭。
    const resumed = batchOf(
      [{ t: '2026-10-20T00:00:01Z', route_id: 8, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 1, out: 1 }],
      first.generation,
      first.committedOff,
    );
    ingestLedger(f.store, 'usage.jsonl', resumed, 3, salt);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 2 });
    expect(f.store.read.query('SELECT from_off, state FROM source_gap').all()).toEqual([
      { from_off: first.committedOff, state: 'filled' },
    ]);
    expect(f.store.read.query('SELECT observed_off FROM source_cursor').get()).toEqual({ observed_off: resumed.observedOff });
  } finally {
    f.close();
  }
});

test('换代后暂停缺口标unrecoverable且不被后续读取改写', () => {
  const f = fixture();
  try {
    const first = batchOf([{ t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 10, out: 5 }]);
    ingestLedger(f.store, 'usage.jsonl', first, 1, salt);
    const paused = batchOf([], first.generation, first.committedOff);
    paused.observedOff = first.committedOff + 40;
    resumePausedLedger(f.store, 'usage.jsonl', paused, 2);

    // 文件被原地重写：游标换代，旧区间无法再按偏移重读。
    const rewritten = batchOf([{ t: '2026-10-20T00:00:09Z', route_id: 9, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-b', in: 1, out: 1 }], 'g:1', 0);
    ingestLedger(f.store, 'usage.jsonl', rewritten, 3, salt);
    expect(f.store.read.query('SELECT state FROM source_gap').all()).toEqual([{ state: 'unrecoverable' }]);
  } finally {
    f.close();
  }
});

test('暂停后文件继续追加，重启恢复得到与从未暂停一致的集合', () => {
  const f = fixture();
  try {
    const base = batchOf([{ t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 10, out: 5 }]);
    ingestLedger(f.store, 'usage.jsonl', base, 1, salt);

    // 暂停期间上游又写了两行：只记缺口。
    const paused = batchOf([
      { t: '2026-10-20T00:00:01Z', route_id: 8, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 1, out: 1 },
      { t: '2026-10-20T00:00:02Z', route_id: 9, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 2, out: 2 },
    ], base.generation, base.committedOff);
    resumePausedLedger(f.store, 'usage.jsonl', paused, 2);
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 1 });

    // 重启后重读同一游标：两行都补上，缺口关闭，结果与从未暂停相同。
    const resumed = batchOf([
      { t: '2026-10-20T00:00:01Z', route_id: 8, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 1, out: 1 },
      { t: '2026-10-20T00:00:02Z', route_id: 9, agent: 'demo', model: 'm', provider: 'p', status: 200, session: 'sess-a', in: 2, out: 2 },
    ], base.generation, base.committedOff);
    const result = ingestLedger(f.store, 'usage.jsonl', resumed, 3, salt);
    expect(result.accepted).toBe(2);
    expect(f.store.read.query('SELECT route_id FROM request ORDER BY route_id').all()).toEqual([
      { route_id: 7 }, { route_id: 8 }, { route_id: 9 },
    ]);
    expect(f.store.read.query('SELECT state FROM source_gap').all()).toEqual([{ state: 'filled' }]);
  } finally {
    f.close();
  }
});
