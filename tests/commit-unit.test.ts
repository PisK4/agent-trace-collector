import { expect, test } from 'bun:test';
import { createDeriveUnit } from '../src/derive/unit';
import { reconcilePending } from '../src/hook';
import { pruneRaw, resumeSourceGaps } from '../src/retention';
import { syncCosts } from '../src/sources/magpie/costs';
import { saveProbe } from '../src/sources/magpie/probe';
import { createCapacityMetrics } from '../src/capacity';
import { fixture } from './fixtures';

const salt = new Uint8Array(32).fill(7);
const period = '2026-10-24..2026-10-24';
const emptyCosts: typeof fetch = Object.assign(
  async () => Response.json({ period, rows: [], offset: 0 }), { preconnect: fetch.preconnect });

test('重复空闲轮询不增加事务，指标快照保留具名计数', async () => {
  const f = fixture();
  try {
    const unit = createDeriveUnit(f.store);
    const probe = { version: '0.1.1296', verified: true, reason: null };
    saveProbe(f.store, probe, 1);
    await syncCosts(f.store, period, 'http://127.0.0.1:1', 1, salt, emptyCosts);
    const metrics = createCapacityMetrics(f.store, f.dir);
    const before = metrics.snapshot(f.store, f.dir) as any;
    expect(before.writer.by_name.probe.count).toBe(1);
    expect(before.writer.by_name.cost.count).toBe(1);
    for (let tick = 0; tick < 10; tick++) {
      unit.run({ budgetMs: 400 });
      saveProbe(f.store, probe, tick + 2);
      reconcilePending(f.store, tick + 2);
      resumeSourceGaps(f.store, 'usage.jsonl');
      pruneRaw(f.store, 100);
      await syncCosts(f.store, period, 'http://127.0.0.1:1', 1, salt, emptyCosts);
    }
    expect(f.store.writeStats.count).toBe(before.writer.count);
    saveProbe(f.store, { ...probe, reason: 'synthetic-change' }, 20);
    expect(f.store.writeStats.by_name.probe?.count).toBe(2);
    expect(before.writer.by_name.probe.count).toBe(1);
  } finally { f.close(); }
});

test('费用请求或校验失败前不重置已完成窗口', async () => {
  const f = fixture();
  try {
    await syncCosts(f.store, period, 'http://127.0.0.1:1', 1, salt, emptyCosts);
    const before = f.store.writeStats.count;
    for (const response of [new Response('', { status: 503 }),
      Response.json({ period: 'wrong', offset: 0, rows: [] })]) {
      const fetcher = Object.assign(async () => response, { preconnect: fetch.preconnect });
      await expect(syncCosts(f.store, period, 'http://127.0.0.1:1', 1, salt, fetcher)).rejects.toThrow();
    }
    expect(f.store.writeStats.count).toBe(before);
    const row = f.store.read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(JSON.stringify(['cost-window', period]))!;
    expect(JSON.parse(row.value_json).done).toBe(true);
  } finally { f.close(); }
});

test('缺口已可恢复与已记录的未关联正文不再空转提交', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms)
        VALUES ('ledger','usage.jsonl','g',0,1)`);
      db.run(`INSERT INTO source_gap(source_kind,source_name,file_generation,from_off,to_off,reason,state,updated_at)
        VALUES ('ledger','usage.jsonl','g',0,10,'disk_paused','open',1)`);
      db.run(`INSERT INTO raw_hook(hook_id,received_at,parse_state,request_z)
        VALUES ('unlinked',1,'unsupported',?)`, [new Uint8Array([1])]);
    });
    resumeSourceGaps(f.store, 'usage.jsonl');
    pruneRaw(f.store, 100);
    const before = f.store.writeStats.count;
    expect(resumeSourceGaps(f.store, 'usage.jsonl')).toEqual({ recoverable: 1, unrecoverable: 0 });
    expect(pruneRaw(f.store, 100)).toEqual({ ledger: 0, route: 0, hook: 0 });
    expect(f.store.writeStats.count).toBe(before);
  } finally { f.close(); }
});
