import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import type { FileBatch } from '../src/sources/files';
import { ingestLedger, ingestRoute, resumePausedLedger } from '../src/reconcile';
import { purgeMetadata } from '../src/maintenance';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from '../src/sources/projection';

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
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 1, salt)).toEqual({ accepted: 2, invalid: 0, duplicate: 0, purged_skip: 0 });
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 2, salt)).toEqual({ accepted: 0, invalid: 0, duplicate: 2, purged_skip: 0 });
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
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 1, salt)).toEqual({ accepted: 1, invalid: 1, duplicate: 0, purged_skip: 0 });
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
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 2, salt)).toEqual({ accepted: 0, invalid: 0, duplicate: 1, purged_skip: 0 });
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

test('已主动淘汰的证据在来源回放时计purged_skip而不复活', () => {
  const f = fixture();
  try {
    const batch = batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', model: 'm', provider: 'p',
      status: 200, session: 'synthetic-replay', in: 10, out: 5,
    }]);
    expect(ingestLedger(f.store, 'usage.jsonl', batch, 1, salt).accepted).toBe(1);
    expect(purgeMetadata(f.store, '2026-10-21', 'approval-synthetic-replay').deleted).toBe(1);

    const replay = ingestLedger(f.store, 'usage.jsonl', batch, 2, salt);
    expect(replay.accepted).toBe(0);
    expect(replay.purged_skip).toBe(1);
    // 证据、请求都不回来；墓碑本身保留。
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM request_evidence').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT count(*) AS n FROM purged_evidence').get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test('账本req与served分别落列而provider model不冒充请求模型', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 7, agent: 'demo', session: 'sess-a',
      req: 'req-model', model: 'provider-model', served: 'served-model',
      provider: 'p', status: 200, in: 10, out: 5,
    }]), 1, salt);
    expect(f.store.read.query(
      'SELECT status,model_requested,model_served,in_tok,attempt_in,attempt_billed FROM request',
    ).get()).toEqual({
      status: 200, model_requested: 'req-model', model_served: 'served-model',
      in_tok: 10, attempt_in: 10, attempt_billed: 1,
    });
    expect(f.store.read.query('SELECT model FROM raw_ledger').get()).toEqual({ model: 'provider-model' });
  } finally {
    f.close();
  }
});

test('缺req保持NULL且不拿provider model补齐', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 8, agent: 'demo', session: 'sess-a',
      model: 'provider-only', provider: 'p', status: 200, in: 4,
    }]), 1, salt);
    expect(f.store.read.query('SELECT model_requested,model_served FROM request').get())
      .toEqual({ model_requested: null, model_served: null });
  } finally {
    f.close();
  }
});

test('账本行与payload来自同一脱敏对象且未知键保留', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 9, agent: 'demo', session: 'sess-a',
      account: 'synthetic-account', providerAccount: 'synthetic-account',
      future_field: { note: 'Bearer synthetic-secret-123' },
      future_nested: { authorization: 'synthetic-secret-456' },
      model: 'm', provider: 'p', status: 200, in: 1,
    }]), 1, salt);
    const row = f.store.read.query<{ account: string; payload_json: string }, []>(
      'SELECT account,payload_json FROM raw_ledger').get()!;
    expect(row.account).toMatch(/^\[redacted:credential:[0-9a-f]{16}\]$/);
    expect(row.payload_json).not.toContain('synthetic-secret-123');
    expect(row.payload_json).not.toContain('synthetic-secret-456');
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload.account).toBe(row.account);
    expect(payload.providerAccount).toBe(row.account);
    expect(JSON.stringify(payload)).toContain('future_field');
    expect(JSON.stringify(payload)).toContain('future_nested');
    // 普通字符串里的令牌走形态规则，敏感键走 credential 占位符
    expect(JSON.stringify(payload)).toContain('[redacted:bearer:');
    expect(JSON.stringify(payload)).toContain('[redacted:credential:');
  } finally {
    f.close();
  }
});

test('部分raw过期后旧尝试合计不缩小', () => {
  const f = fixture();
  try {
    const batch = batchOf([
      { t: '2026-10-20T00:00:00Z', route_id: 10, agent: 'demo', session: 's', handed_on: true, status: 429, model: 'm', provider: 'p', in: 10 },
      { t: '2026-10-20T00:00:01Z', route_id: 10, agent: 'demo', session: 's', status: 200, model: 'm', provider: 'p', in: 20 },
    ]);
    ingestLedger(f.store, 'usage.jsonl', batch, 1, salt);
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 30, attempt_billed: 2 });
    const second = batch.lines[1]!.offset;
    f.store.write(db => {
      db.run('DELETE FROM raw_ledger WHERE file_generation=? AND byte_offset=?', [batch.generation, second]);
      db.run(
        `UPDATE request_evidence SET payload_state='expired' WHERE source_kind='ledger' AND ref_key=?`,
        [JSON.stringify(['file', batch.generation, second])],
      );
      const projection = projectRequestTx(db, 1, { now: 3, mappingVersion: SOURCE_PROJECTION_VERSION });
      expect(projection.attempts.state).toBe('partial');
      expect(projection.families.attempts).toMatchObject({ state: 'partial', current: false });
      expect(projection.reasons).toContain('ledger_partial');
    });
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 30, attempt_billed: 2 });
  } finally {
    f.close();
  }
});

test('后到非法账本行保留旧尝试合计并报告非current', () => {
  const f = fixture();
  try {
    ingestLedger(f.store, 'usage.jsonl', batchOf([{
      t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', session: 's', model: 'm', provider: 'p', status: 200, in: 10,
    }]), 1, salt);
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 10, attempt_billed: 1 });
    f.store.write(db => {
      db.run(
        `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json)
         VALUES ('file','g:0',500,'not-a-time',0,'through','{}')`,
      );
      db.run(
        `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (1,'ledger',?,'merged',1)`,
        [JSON.stringify(['file', 'g:0', 500])],
      );
      const projection = projectRequestTx(db, 1, { now: 4, mappingVersion: SOURCE_PROJECTION_VERSION });
      expect(projection.attempts.state).toBe('invalid');
      expect(projection.families.attempts).toMatchObject({ state: 'invalid', current: false });
      expect(projection.reasons).toContain('ledger_invalid');
    });
    expect(f.store.read.query('SELECT attempt_in,attempt_billed FROM request').get())
      .toEqual({ attempt_in: 10, attempt_billed: 1 });
  } finally {
    f.close();
  }
});

test('同毫秒跨代际不证明顺序时清空排序键', () => {
  const f = fixture();
  try {
    const row = (status: number, inTok: number) => ({
      t: '2026-10-20T00:00:00Z', route_id: 11, agent: 'demo', session: 's',
      model: 'm', provider: 'p', status, in: inTok,
    });
    ingestLedger(f.store, 'usage.jsonl', batchOf([row(200, 10)], '1:2:3:0'), 1, salt);
    expect(f.store.read.query('SELECT sort_source,sort_key,attempt_in FROM request').get())
      .toEqual({ sort_source: 'ledger', sort_key: '1:2:3:0|00000000000000000000', attempt_in: 10 });
    ingestLedger(f.store, 'usage-2.jsonl', batchOf([row(500, 20)], '1:2:3:1'), 2, salt);
    // 两行同毫秒且跨代际：不发布 final，清空排序键，避免 A 只看一把 key 就当成可证顺序
    expect(f.store.read.query(
      'SELECT status,model_requested,sort_source,sort_key,attempt_in,attempt_billed,attempt_state FROM request',
    ).get()).toEqual({
      status: null, model_requested: null, sort_source: null, sort_key: null,
      attempt_in: 30, attempt_billed: 2, attempt_state: 'pending_final',
    });
  } finally {
    f.close();
  }
});
