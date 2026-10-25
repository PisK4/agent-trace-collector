import { expect, spyOn, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { loadLocalSecret } from '../src/config';
import { assertCostPagePeriod, costState, syncCosts, validateCostPeriod } from '../src/sources/magpie/costs';
import { classifyLedger, mapLedgerRow, mapRouteRow } from '../src/sources/magpie/mapping';
import { probeMagpie } from '../src/sources/magpie/probe';
import { getStats } from '../src/queries/stats';

const salt = new Uint8Array(32).fill(7);

test('账本来源字段按req与cost读取并给出类型状态', () => {
  const fields = mapLedgerRow({
    t: '2026-10-20T00:00:00Z', req: 'synthetic-req', model: 'synthetic-provider',
    served: 'synthetic-served', cost: 0, err: 'synthetic error',
    err_type: 'rate_limit', kind: 'compact', account: 'synthetic-account',
  })!;
  expect({
    requested: fields.requested, model: fields.model, served: fields.served,
    ownCost: fields.ownCost, err: fields.err, errType: fields.errType,
    kind: fields.kind, account: fields.account, shape: fields.shape,
  }).toEqual({
    requested: 'synthetic-req', model: 'synthetic-provider', served: 'synthetic-served',
    ownCost: 0, err: 'synthetic error', errType: 'rate_limit', kind: 'compact',
    account: 'synthetic-account',
    shape: {
      req: 'reported', model: 'reported', served: 'reported', cost: 'reported',
      err: 'reported', errType: 'reported', kind: 'reported',
    },
  });
});

test('账本旧键、空串与非法类型分开记录且都不当新值', () => {
  const legacy = mapLedgerRow({ t: '2026-10-20T00:00:00Z', requested: 'legacy', own_cost: 3, ownCost: 4 })!;
  expect([legacy.requested, legacy.ownCost, legacy.shape.req, legacy.shape.cost])
    .toEqual([null, null, 'absent', 'absent']);
  const invalid = mapLedgerRow({
    t: '2026-10-20T00:00:00Z', req: 42, model: {}, served: [], cost: '0', err: [], err_type: true, kind: 7,
  })!;
  expect([invalid.requested, invalid.model, invalid.served, invalid.ownCost, invalid.err, invalid.errType, invalid.kind])
    .toEqual([null, null, null, null, null, null, null]);
  expect(invalid.shape).toEqual({
    req: 'invalid', model: 'invalid', served: 'invalid', cost: 'invalid',
    err: 'invalid', errType: 'invalid', kind: 'invalid',
  });
  const empty = mapLedgerRow({ t: '2026-10-20T00:00:00Z', req: '', kind: '' })!;
  expect([empty.requested, empty.kind, empty.shape.req, empty.shape.kind])
    .toEqual([null, null, 'empty', 'empty']);
});

test('路由Prompt只在校准布尔与tokens合法时给出counted', () => {
  const trueRow = mapRouteRow({ id: 1, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: true } })!;
  expect([trueRow.promptTokens, trueRow.promptCounted, trueRow.shape.promptCounted])
    .toEqual([100, 1, 'true']);
  const falseRow = mapRouteRow({ id: 2, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: false } })!;
  expect([falseRow.promptCounted, falseRow.shape.promptCounted]).toEqual([0, 'false']);
  const omitted = mapRouteRow({ id: 3, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100 } })!;
  expect([omitted.promptCounted, omitted.shape.promptCounted]).toEqual([0, 'absent']);
  const invalid = mapRouteRow({ id: 4, time: '2026-10-20T00:00:00Z', prompt: { tokens: 100, counted: 'yes' } })!;
  expect([invalid.promptCounted, invalid.shape.promptCounted]).toEqual([null, 'invalid']);
  const noTokens = mapRouteRow({ id: 5, time: '2026-10-20T00:00:00Z', prompt: { counted: true } })!;
  expect([noTokens.promptTokens, noTokens.promptCounted, noTokens.shape.prompt]).toEqual([null, null, 'invalid']);
  const missing = mapRouteRow({ id: 6, time: '2026-10-20T00:00:00Z' })!;
  expect([missing.promptCounted, missing.shape.prompt, missing.shape.promptCounted])
    .toEqual([null, 'absent', 'absent']);
});

test('路由首字时间按 firstText 读取，旧键名不兜底', () => {
  const real = mapRouteRow({ id: 1, time: '2026-10-20T00:00:00Z', firstText: 2603 })!;
  expect(real.firstText).toBe(2603);
  const legacy = mapRouteRow({ id: 2, time: '2026-10-20T00:00:00Z', first_text: 2603 })!;
  expect(legacy.firstText).toBeNull();
});

test('费用窗口只接受真实日历范围', () => {
  for (const period of [
    '2026-02-30..2026-03-01', '2026-10-21..2026-10-20', '2026-10-20',
    '2026-10-20T00:00:00Z..2026-10-21T00:00:00Z', '30d',
  ]) {
    expect(() => validateCostPeriod(period)).toThrow('cost_period_invalid');
  }
  validateCostPeriod('2024-02-29..2024-03-01');
  validateCostPeriod('2026-12-31..2027-01-01');
  validateCostPeriod('2026-10-20..2026-10-20');
  validateCostPeriod('2026-01-01..2026-12-31');
  assertCostPagePeriod({ period: '2026-12-31..2027-01-01' }, '2026-12-31..2027-01-01');
  expect(() => assertCostPagePeriod({ period: '30d' }, '2026-12-31..2027-01-01')).toThrow('cost_api_period_mismatch');
});

test('非法窗口在任何请求前被拒绝', async () => {
  const f = fixture();
  const mock = spyOn(globalThis, 'fetch');
  try {
    await expect(syncCosts(f.store, '30d', 'http://127.0.0.1:1', 1, salt)).rejects.toThrow('cost_period_invalid');
    expect(mock).toHaveBeenCalledTimes(0);
  } finally {
    mock.mockRestore();
    f.close();
  }
});

test('错窗费用响应不落盘且不推进页进度', async () => {
  const period = '2026-10-20..2026-10-20';
  for (const echo of [undefined, '30d', '2026-10-19..2026-10-19']) {
    const f = fixture();
    const key = JSON.stringify(['cost-window', period]);
    f.store.write(db => db.run('INSERT INTO collector_state VALUES (?,?)',
      [key, JSON.stringify({ run_id: 'synthetic-run', next_offset: 0 })]));
    const mock = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ period: echo, rows: [{ priced: true, cost: 1 }], offset: 0, total: 1 }));
    try {
      await expect(syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt))
        .rejects.toThrow('cost_api_period_mismatch');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(f.store.read.query('SELECT count(*) AS n FROM cost_observation').get()).toEqual({ n: 0 });
      const state = f.store.read.query<{ value_json: string }, [string]>(
        'SELECT value_json FROM collector_state WHERE key=?').get(key);
      expect(JSON.parse(state!.value_json).next_offset).toBe(0);
    } finally {
      mock.mockRestore();
      f.close();
    }
  }
});

test('费用前页提交后错窗不能推进下一页', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  const key = JSON.stringify(['cost-window', period]);
  const rows = Array.from({ length: 500 }, (_, i) => ({
    t: '2026-10-20T00:00:00Z', route_id: i + 1, agent: 'synthetic',
    provider: 'synthetic', model: 'm', status: 200, priced: true, cost: 1,
  }));
  const mock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ period, rows, offset: 0, total: 501 }))
    .mockResolvedValueOnce(Response.json({ period: '30d', rows: [rows[0]], offset: 500, total: 501 }));
  try {
    await expect(syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt))
      .rejects.toThrow('cost_api_period_mismatch');
    expect(mock).toHaveBeenCalledTimes(2);
    const state = f.store.read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(key);
    expect(JSON.parse(state!.value_json).next_offset).toBe(500);
    expect(f.store.read.query('SELECT count(*) AS n FROM cost_observation').get()).toEqual({ n: 500 });
  } finally {
    mock.mockRestore();
    f.close();
  }
});

test('费用只去重最新投影且时间冲突不能覆盖历史', () => {
  const f = fixture();
  try {
    const observe = (at: number, hash: string) => f.store.write(db => {
      const latest = db.query<{ observed_at: number; projection_hash: string }, [string]>(
        'SELECT observed_at,projection_hash FROM cost_observation WHERE ref_key=? ORDER BY observed_at DESC LIMIT 1',
      ).get('synthetic-evidence');
      if (latest?.projection_hash === hash) return false;
      if (latest && at <= latest.observed_at) throw new Error('cost_observation_conflict');
      db.run('INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json) VALUES (?,?,?,?)',
        ['synthetic-evidence', at, hash, '{}']);
      return true;
    });
    expect(observe(100, 'A')).toBe(true);
    expect(observe(101, 'A')).toBe(false);
    expect(observe(102, 'B')).toBe(true);
    expect(observe(103, 'A')).toBe(true);
    expect(() => observe(103, 'C')).toThrow('cost_observation_conflict');
    expect(() => observe(99, 'C')).toThrow('cost_observation_conflict');
    expect(f.store.read.query('SELECT observed_at,projection_hash FROM cost_observation ORDER BY observed_at').all()).toEqual([
      { observed_at: 100, projection_hash: 'A' },
      { observed_at: 102, projection_hash: 'B' },
      { observed_at: 103, projection_hash: 'A' },
    ]);
  } finally {
    f.close();
  }
});

test('精确证据键取最新观测且查询计划走主键', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run("INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json) VALUES ('synthetic-evidence',19542,'6','{}')");
      db.run("INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json) VALUES ('synthetic-evidence',20542,'5','{}')");
      db.run("INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json) VALUES ('synthetic-evidence-extra',30000,'7','{}')");
    });
    const latest = f.store.read.query(
      'SELECT observed_at,projection_hash FROM cost_observation WHERE ref_key=? ORDER BY observed_at DESC LIMIT 1',
    ).get('synthetic-evidence');
    expect(latest).toEqual({ observed_at: 20542, projection_hash: '5' });
    const plan = f.store.read.query(
      'EXPLAIN QUERY PLAN SELECT observed_at,projection_hash FROM cost_observation WHERE ref_key=? ORDER BY observed_at DESC LIMIT 1',
    ).all('synthetic-evidence') as { detail: string }[];
    const details = plan.map(row => row.detail).join(' ');
    expect(details).toContain('PRIMARY KEY');
    expect(details).not.toContain('TEMP B-TREE');
  } finally {
    f.close();
  }
});

test('501行分两页且请求URL不带route参数', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  const total = 501;
  const urls: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const count = Math.min(500, total - offset);
    const rows = Array.from({ length: count }, (_, i) => ({
      route_id: 100000 + offset + i, priced: false, cost: 0,
    }));
    return Response.json({ period, rows, offset, total });
  }) as unknown as typeof fetch);
  try {
    const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
    expect(result).toEqual({ pages: 2, observations: 501, matched: 0, ambiguous: 0 });
    expect(urls.length).toBe(2);
    expect(urls.some(url => url.includes('route='))).toBe(false);
    const state = f.store.read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(JSON.stringify(['cost-window', period]));
    expect(JSON.parse(state!.value_json)).toMatchObject({ next_offset: 0, done: true });
  } finally {
    mock.mockRestore();
    f.close();
  }
});

test('21196行按43页收敛', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  const total = 21196;
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input)).searchParams.get('offset'));
    const count = Math.min(500, total - offset);
    const rows = Array.from({ length: count }, (_, i) => ({ route_id: 200000 + offset + i, priced: true, cost: 0 }));
    return Response.json({ period, rows, offset, total });
  }) as unknown as typeof fetch);
  try {
    const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
    expect(result.pages).toBe(43);
    expect(result.observations).toBe(total);
  } finally {
    mock.mockRestore();
    f.close();
  }
});

test('空页结束窗口且不产生观测', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  const mock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ period, rows: [], offset: 0, total: 0 }));
  try {
    const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
    expect(result).toEqual({ pages: 1, observations: 0, matched: 0, ambiguous: 0 });
  } finally {
    mock.mockRestore();
    f.close();
  }
});

test('错误offset拒绝本页且保留前页进度', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  const rows = Array.from({ length: 500 }, (_, i) => ({ route_id: 300000 + i, priced: false }));
  const mock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ period, rows, offset: 0, total: 600 }))
    .mockResolvedValueOnce(Response.json({ period, rows: [{ route_id: 1 }], offset: 0, total: 600 }));
  try {
    await expect(syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt))
      .rejects.toThrow('cost_api_offset_mismatch');
    const state = f.store.read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(JSON.stringify(['cost-window', period]));
    expect(JSON.parse(state!.value_json).next_offset).toBe(500);
    expect(f.store.read.query('SELECT count(*) AS n FROM cost_observation').get()).toEqual({ n: 500 });
  } finally {
    mock.mockRestore();
    f.close();
  }
});

function insertRouteRequest(f: ReturnType<typeof fixture>, routeId: number, inTok: number | null): number {
  return f.store.write(db => {
    const result = db.run(
      `INSERT INTO request(route_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,in_tok,cost_state)
       VALUES (?,?,?,'through','pending',0,2,1,1,?,'absent')`,
      [routeId, Date.parse('2026-10-20T00:00:00Z'), '2026-10-20', inTok],
    );
    const reqId = Number(result.lastInsertRowid);
    db.run(
      'INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,?)',
      [reqId, 'ledger', `synthetic-ledger-${routeId}-${reqId}`, 'merged', 1],
    );
    return reqId;
  });
}

test('费用补价保留文件token的NULL且A到B到A保留三次观测', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  try {
    insertRouteRequest(f, 7, 10);
    for (const cost of [1, 2, 1]) {      const mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
        period,
        rows: [{ t: '2026-10-20T00:00:00Z', route_id: 7, status: 200, in: 10, priced: true, cost }],
        offset: 0,
        total: 1,
        pricing_version: 'pricing-v1',
      }));
      try {
        const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
        expect(result.matched).toBe(1);
      } finally {
        mock.mockRestore();
      }
      await Bun.sleep(3);
    }
    const observations = f.store.read.query(
      'SELECT observed_at,projection_hash FROM cost_observation ORDER BY observed_at',
    ).all();
    expect(observations.length).toBe(3);
    expect(f.store.read.query('SELECT cost,cost_state,in_tok,pricing_version FROM request').get()).toEqual({
      cost: 1, cost_state: 'priced', in_tok: 10, pricing_version: 'pricing-v1',
    });
    const latest = f.store.read.query<{ payload_json: string }, [string]>(
      'SELECT payload_json FROM cost_observation WHERE ref_key=? ORDER BY observed_at DESC LIMIT 1',
    ).get('synthetic-ledger-7-1');
    expect(JSON.parse(latest!.payload_json)).toMatchObject({ priced: true, cost: 1 });
  } finally {
    f.close();
  }
});

test('同route两条候选标为歧义且不复制费用', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  try {
    insertRouteRequest(f, 21, 10);
    insertRouteRequest(f, 21, 10);
    const mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      period,
      rows: [{ route_id: 21, status: 200, in: 10, priced: true, cost: 2 }],
      offset: 0,
      total: 1,
    }));
    try {
      const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
      expect(result.ambiguous).toBe(1);
      expect(result.matched).toBe(0);
      expect(f.store.read.query('SELECT cost,cost_state,cost_reason FROM request ORDER BY req_id').all()).toEqual([
        { cost: null, cost_state: 'absent', cost_reason: 'ambiguous_cost' },
        { cost: null, cost_state: 'absent', cost_reason: 'ambiguous_cost' },
      ]);
      const ref = f.store.read.query<{ ref_key: string }, []>(
        'SELECT ref_key FROM cost_observation LIMIT 1').get()!;
      expect(ref.ref_key).toContain('cost-run');
    } finally {
      mock.mockRestore();
    }
  } finally {
    f.close();
  }
});

test('rejected请求不被through费用匹配', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(route_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,cost_reason,cost_state)
         VALUES (7,1,'2026-10-20','rejected','pending',0,2,1,1,'not_applicable','absent')`,
      );
    });
    const mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      period,
      rows: [{ route_id: 7, status: 200, priced: true, cost: 2 }],
      offset: 0,
      total: 1,
    }));
    try {
      const result = await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
      expect(result.matched).toBe(0);
      expect(result.ambiguous).toBe(0);
      expect(f.store.read.query('SELECT cost,cost_state,cost_reason FROM request').get()).toEqual({
        cost: null, cost_state: 'absent', cost_reason: 'not_applicable',
      });
    } finally {
      mock.mockRestore();
    }
  } finally {
    f.close();
  }
});

test('版本探针以HTTP为准并标记未验证区间', async () => {
  const f = fixture();
  const versionFile = join(f.dir, 'last-version');
  try {
    writeFileSync(versionFile, '0.1.1296\n');
    const good = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ version: '0.1.1296' }));
    try {
      expect(await probeMagpie('http://127.0.0.1:3425', versionFile)).toEqual({
        version: '0.1.1296', verified: true, reason: null,
      });
    } finally {
      good.mockRestore();
    }
    const bad = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ version: '0.2.0' }));
    try {
      expect(await probeMagpie('http://127.0.0.1:3425', versionFile)).toEqual({
        version: '0.2.0', verified: false, reason: 'version_out_of_range',
      });
    } finally {
      bad.mockRestore();
    }
    const down = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      expect(await probeMagpie('http://127.0.0.1:3425', versionFile)).toEqual({
        version: '0.1.1296', verified: true, reason: 'http_unavailable',
      });
    } finally {
      down.mockRestore();
    }
  } finally {
    f.close();
  }
});

test('本地salt首次创建、重启复用并拒绝过宽权限', () => {
  const f = fixture();
  const dataDir = join(f.dir, 'data');
  try {
    const first = loadLocalSecret(dataDir, 'redaction.salt');
    expect(first.length).toBe(32);
    const path = join(dataDir, 'redaction.salt');
    const info = lstatSync(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(loadLocalSecret(dataDir, 'redaction.salt')).toEqual(first);

    chmodSync(path, 0o644);
    expect(() => loadLocalSecret(dataDir, 'redaction.salt')).toThrow('local_secret_permissions');
    chmodSync(path, 0o600);

    writeFileSync(path, Buffer.alloc(31));
    chmodSync(path, 0o600);
    expect(() => loadLocalSecret(dataDir, 'redaction.salt')).toThrow('local_secret_length');

    writeFileSync(path, Buffer.alloc(32));
    chmodSync(path, 0o600);
    const target = join(f.dir, 'target-secret');
    writeFileSync(target, crypto.getRandomValues(new Uint8Array(32)));
    chmodSync(target, 0o600);
    const linkDir = join(f.dir, 'link-data');
    mkdirSync(linkDir, { recursive: true, mode: 0o700 });
    const linkPath = join(linkDir, 'read.token');
    symlinkSync(target, linkPath);
    expect(() => loadLocalSecret(linkDir, 'read.token')).toThrow('local_secret_invalid_file');
  } finally {
    f.close();
  }
});

test('classifyLedger与四态费用判定', () => {
  expect(classifyLedger({ kind: 'web_search', provider: 'p', status: 200 })).toBe('through');
  expect(classifyLedger({ rejected: true, provider: 'p', status: 200 })).toBe('rejected');
  expect(classifyLedger({ provider: '', status: 400 })).toBe('rejected');
  expect(costState({ priced: true, cost: 1.5 })).toBe('priced');
  expect(costState({ priced: true, cost: 0 })).toBe('zero');
  expect(costState({ priced: false, cost: 0 })).toBe('unpriced');
  expect(costState({ priced: true })).toBe('absent');
  expect(costState(null)).toBe('absent');
});

test('时钟回退时整页回滚并记录冲突计数与阻塞时点', async () => {
  const f = fixture();
  const period = '2026-10-20..2026-10-20';
  try {
    insertRouteRequest(f, 55, 10);
    const page = (cost: number) => Response.json({
      period, rows: [{ route_id: 55, status: 200, in: 10, priced: true, cost }], offset: 0, total: 1,
      pricing_version: 'pricing-v1',
    });
    let mock = spyOn(globalThis, 'fetch').mockResolvedValue(page(1));
    try {
      await syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt);
    } finally {
      mock.mockRestore();
    }
    await Bun.sleep(3);
    const latest = f.store.read.query<{ observed_at: number }, []>(
      'SELECT observed_at FROM cost_observation ORDER BY observed_at DESC LIMIT 1').get()!;

    // 把观测时点推到未来，下一次不同的投影必然撞上“时间不大于最新观测”。
    const clockMock = spyOn(Date, 'now').mockReturnValue(latest.observed_at);
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(page(2));
    try {
      await expect(syncCosts(f.store, period, 'http://127.0.0.1:8317', 1, salt))
        .rejects.toThrow('cost_observation_conflict');
    } finally {
      fetchMock.mockRestore();
      clockMock.mockRestore();
    }
    // 整页回滚：只留着第一次观测，进度仍指向本页起点。
    expect(f.store.read.query('SELECT count(*) AS n FROM cost_observation').get()).toEqual({ n: 1 });
    const health = f.store.read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(JSON.stringify(['cost', 'clock_conflict']));
    expect(JSON.parse(health!.value_json)).toMatchObject({
      count: 1, blocked_at: latest.observed_at, period, ref_key: 'synthetic-ledger-55-1',
    });
    expect(getStats(f.store).cost_health).toMatchObject({ count: 1 });
  } finally {
    f.close();
  }
});
