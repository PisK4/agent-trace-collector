import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { createLiveActivity } from '../src/activity';
import { listSessions } from '../src/queries/sessions';
import { ingestSource } from '../src/reconcile';
import type { SourceRead } from '../src/sources/files';

const SALT = new Uint8Array(32).fill(7);
const NOW = 1_700_000_100_000;

/** 与 queries.test 的种子保持一致：只写列表聚合需要的列，不碰正文。 */
function seedSession(
  store: ReturnType<typeof fixture>['store'],
  convKey: string,
  startedMs: number,
  routeId: number | null = null,
): number {
  return store.write(db => Number(db.run(
    `INSERT INTO request(route_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,cost_state,ms,ttft_ms,flow_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      routeId, convKey, 'session', 'actor-a', 'claude', 'known', startedMs, '2026-11-03',
      'through', 'pending', 0, 3, 1, 1, `t-${convKey}`, 200, 'absent', 1000, 100, 900,
    ],
  ).lastInsertRowid));
}

function seedRoute(
  store: ReturnType<typeof fixture>['store'],
  routeId: number,
  done: number | null,
  timeMs: number,
): void {
  store.write(db => {
    db.run(
      'INSERT INTO raw_route(route_id,time_ms,day,payload_json,done) VALUES (?,?,?,?,?)',
      [routeId, timeMs, '2026-11-03', '{}', done],
    );
  });
}

test('活跃判定：60 秒内更新或在途，两个条件都不满足就不进活跃区', () => {
  const f = fixture();
  try {
    const recent = JSON.stringify(['session', 'recent']);
    const cold = JSON.stringify(['session', 'cold']);
    const inflight = JSON.stringify(['session', 'inflight']);
    seedSession(f.store, recent, NOW - 30_000);
    seedSession(f.store, cold, NOW - 90_000);
    seedSession(f.store, inflight, NOW - 120_000);
    const page = listSessions(f.store, 10, null, {
      now: NOW,
      inflight: key => key.includes('inflight'),
    });
    const byKey = new Map(page.items.map(row => [row.conv_key, row]));
    expect(byKey.get(recent)).toMatchObject({
      live: true, inflight: false, live_until: NOW - 30_000 + 60_000,
    });
    expect(byKey.get(cold)).toMatchObject({ live: false, inflight: false, live_until: null });
    expect(byKey.get(inflight)).toMatchObject({ live: true, inflight: true, live_until: null });
    // 旧调用方不传活跃快照时，返回形状与改动前完全一致。
    expect('live' in listSessions(f.store, 10).items[0]!).toBe(false);
  } finally {
    f.close();
  }
});

test('在途跟踪：完成记录到达后从集合撤下', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 'tracked']);
    seedRoute(f.store, 1, 0, NOW - 5_000);
    const reqId = seedSession(f.store, conv, NOW - 5_000, 1);
    const activity = createLiveActivity();
    activity.observe(f.store, [reqId]);
    expect(activity.inflight(conv)).toBe(true);
    f.store.write(db => db.run('UPDATE raw_route SET done=1 WHERE route_id=1'));
    activity.observe(f.store, [reqId]);
    expect(activity.inflight(conv)).toBe(false);
  } finally {
    f.close();
  }
});

test('归属升级时在途标记跟着 req_id 走，不在请求级会话里残留', () => {
  const f = fixture();
  try {
    const requestConv = JSON.stringify(['request', 'r1']);
    const sessionConv = JSON.stringify(['session', 's1']);
    seedRoute(f.store, 1, 0, NOW - 1_000);
    const reqId = seedSession(f.store, requestConv, NOW - 1_000, 1);
    const activity = createLiveActivity();
    activity.observe(f.store, [reqId]);
    expect(activity.inflight(requestConv)).toBe(true);
    f.store.write(db => db.run('UPDATE request SET conv_key=? WHERE req_id=?', [sessionConv, reqId]));
    activity.observe(f.store, [reqId]);
    expect(activity.inflight(requestConv)).toBe(false);
    expect(activity.inflight(sessionConv)).toBe(true);
  } finally {
    f.close();
  }
});

test('启动恢复只认 60 秒窗口：窗口外在途不再宣称请求中', () => {
  const f = fixture();
  try {
    const recent = JSON.stringify(['session', 'boot-recent']);
    const stale = JSON.stringify(['session', 'boot-stale']);
    seedRoute(f.store, 1, 0, NOW - 10_000);
    seedRoute(f.store, 2, 0, NOW - 120_000);
    seedRoute(f.store, 3, 1, NOW - 10_000);
    seedSession(f.store, recent, NOW - 10_000, 1);
    seedSession(f.store, stale, NOW - 120_000, 2);
    seedSession(f.store, JSON.stringify(['session', 'boot-done']), NOW - 10_000, 3);
    const activity = createLiveActivity();
    activity.bootstrap(f.store, NOW);
    expect(activity.inflight(recent)).toBe(true);
    expect(activity.inflight(stale)).toBe(false);
    expect(activity.inflight(JSON.stringify(['session', 'boot-done']))).toBe(false);
  } finally {
    f.close();
  }
});

function batchOf(rows: unknown[], generation = 'g:0', startOffset = 0): SourceRead {
  let offset = startOffset;
  const lines = rows.map(row => {
    const text = JSON.stringify(row);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    sourceKind: 'ledger', name: 'usage.jsonl', mode: 'appendable', state: 'decoded',
    generation, rewriteEpoch: 0, lines, committedOff: offset, observedOff: offset,
    seenSize: offset, headLen: 0, headHash: null, fingerprint: null, issues: [],
    startOff: startOffset, error: null,
  };
}

function routeReadOf(records: unknown[]): SourceRead {
  let offset = 0;
  const lines = records.map(record => {
    const text = JSON.stringify(record);
    const start = offset;
    offset += Buffer.byteLength(text) + 1;
    return { offset: start, end: offset, text };
  });
  return {
    sourceKind: 'route_file', name: '2026-11-03.jsonl', mode: 'appendable', state: 'decoded',
    generation: 'route-gen', rewriteEpoch: 0, lines, committedOff: offset, observedOff: offset,
    seenSize: offset, headLen: 0, headHash: null, fingerprint: null, issues: [],
    startOff: 0, error: null,
  };
}

test('摄入回调只在提交后交付改动的请求，路由完成把会话移出在途', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 's']);
    const activity = createLiveActivity();
    const observe = (ids: readonly number[]) => activity.observe(f.store, ids);
    // 路由先到、账本后到：账本提交把请求挂上 done=0 的路由，回调交付 req_id。
    ingestSource(f.store, routeReadOf([{
      id: 7, time: '2026-11-03T00:00:00Z', agent: 'demo', session: 's', conv: 'c',
      model: 'm', provider: 'p', status: 200, done: 0,
    }]), SALT, NOW, observe);
    expect(activity.inflight(conv)).toBe(false);
    ingestSource(f.store, batchOf([{
      t: '2026-11-03T00:00:01Z', route_id: 7, agent: 'demo', session: 's',
      model: 'm', provider: 'p', status: 200, in: 1,
    }]), SALT, NOW + 1, observe);
    expect(activity.inflight(conv)).toBe(true);
    // 同一条路由补上 done=1：只回查这一个 req_id，会话从在途集合撤下。
    ingestSource(f.store, routeReadOf([{
      id: 7, time: '2026-11-03T00:00:03Z', agent: 'demo', session: 's', conv: 'c',
      model: 'm', provider: 'p', status: 200, done: 1,
    }]), SALT, NOW + 2, observe);
    expect(activity.inflight(conv)).toBe(false);
  } finally {
    f.close();
  }
});
