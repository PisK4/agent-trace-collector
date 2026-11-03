/**
 * 会话列表两阶段查询的合成性能对照：旧单条聚合（冻结快照）与新实现交替计时。
 *
 * 只验证新旧实现返回等价，不设绝对毫秒阈值；结果打印到 stdout，
 * 供验收记录引用。这是显式动作，不进测试套件：
 *
 *   bun scripts/perf-session-list.ts --requests 40000 --sessions 400 --reps 5
 *   bun scripts/perf-session-list.ts --requests 400000 --sessions 4000 --reps 3
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store';
import { listSessions } from '../src/queries/sessions';
import { legacyListSessions } from '../tests/session-list-oracle';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid --${name}`);
  return Math.trunc(value);
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index + 1 >= process.argv.length ? null : process.argv[index + 1]!;
}

const requests = arg('requests', 40_000);
const sessions = arg('sessions', 400);
const page = arg('page', 20);
const reps = arg('reps', 5);
const existingDb = stringArg('db');
const withLive = process.argv.includes('--live');
if (existingDb === null && requests < sessions) throw new Error('requests must be >= sessions');

/** 确定性伪随机：同一参数重复运行得到同一分布，测量差异只来自查询本身。 */
let seedState = 0x2545f491;
const nextRandom = (mod: number): number => {
  seedState = (seedState * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seedState % mod;
};

const dir = mkdtempSync(join(tmpdir(), 'atc-perf-session-list-'));
const store = openStore(existingDb ?? join(dir, 'perf.db'));
try {
  const seedStarted = performance.now();
  if (existingDb !== null) {
    const counts = store.read.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM request').get() as { n: number };
    const keys = store.read.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM (SELECT conv_key FROM request WHERE conv_key IS NOT NULL GROUP BY conv_key)',
    ).get() as { n: number };
    console.log(`existing db: ${counts.n} requests, ${keys.n} sessions`);
  } else {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,cost_state,ms,ttft_ms,flow_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,3,1,1,?,200,'absent',?,?,?)`,
    );
    // 长尾分布：20% 的会话吃掉约 70% 的请求，模拟少数活跃长会话。
    const longSessions = Math.max(1, Math.trunc(sessions * 0.2));
    const longShare = Math.trunc(requests * 0.7);
    const perSession: number[] = new Array(sessions).fill(0);
    for (let i = 0; i < longShare; i++) perSession[nextRandom(longSessions)] += 1;
    const shortShare = requests - longShare;
    for (let i = 0; i < shortShare; i++) perSession[longSessions + nextRandom(sessions - longSessions)] += 1;

    let ms = 1_700_000_000_000;
    for (let s = 0; s < sessions; s++) {
      const convKey = JSON.stringify(['session', `perf-${s}`]);
      for (let r = 0; r < perSession[s]; r++) {
        ms += 1 + nextRandom(5_000);
        // 宽字段非平凡：标题 80-160 字符，聚合行不再全是短串。
        const title = '标题'.repeat(40 + nextRandom(40));
        insert.run(
          convKey, 'session', 'actor-a', 'claude', 'known', ms, '2026-11-01',
          'through', 'pending', 0, title, 1_000 + r, 100 + r, 900 + r,
        );
      }
    }
  });
  const counts = store.read.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM request').get() as { n: number };
  const distribution = (store.read.query<{ n: number }, [number]>(
    'SELECT COUNT(*) AS n FROM (SELECT conv_key FROM request GROUP BY conv_key HAVING COUNT(*) >= ?)',
  ).get(100) as { n: number }).n;
  const perKey = store.read.query<{ c: number }, []>(
    'SELECT COUNT(*) AS c FROM request GROUP BY conv_key ORDER BY c DESC LIMIT 1',
  ).get() as { c: number };
  console.log(`seed: ${counts.n} requests, ${sessions} sessions, max per session ${perKey.c}, sessions>=100 requests: ${distribution}, ${Math.round(performance.now() - seedStarted)} ms`);
  }
  void seedStarted;

  const timed = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  // 等价断言：新旧实现的首页与游标页完整返回值必须逐字段一致。
  const firstLegacy = legacyListSessions(store, page, null);
  const firstFresh = listSessions(store, page, null);
  const cursor = firstFresh.next_cursor;
  if (JSON.stringify(firstLegacy) !== JSON.stringify(firstFresh)) {
    console.error('equivalence FAILED on first page');
    process.exitCode = 1;
  } else if (cursor !== null
    && JSON.stringify(legacyListSessions(store, page, cursor)) !== JSON.stringify(listSessions(store, page, cursor))) {
    console.error('equivalence FAILED on cursor page');
    process.exitCode = 1;
  } else {
    const pageRequests = firstFresh.items.reduce((sum, row) => sum + row.request_count, 0);
    const avgTitle = Math.round(firstFresh.items.reduce((sum, row) => sum + row.title.length, 0) / firstFresh.items.length);
    console.log(`equivalence OK; page ${firstFresh.items.length} sessions, ${pageRequests} requests in page, avg title ${avgTitle} chars, cursor ${cursor === null ? 'none' : 'present'}`);
  }

  const walk = (label: string, samples: number[]): void => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)]!;
    const median = sorted[Math.trunc(sorted.length / 2)] ?? sorted[0]!;
    console.log(`${label}: first ${samples[0]!.toFixed(1)} ms, min ${sorted[0]!.toFixed(1)}, p50 ${median.toFixed(1)}, p95 ${at(0.95).toFixed(1)}, p99 ${at(0.99).toFixed(1)}, max ${sorted[sorted.length - 1]!.toFixed(1)} (${samples.length} runs)`);
  };

  // 严格交替：旧、新、旧、新……首遍各自单列，重复样本仍是交替顺序，
  // 后测不比前测多占一轮缓存优势。
  const legacyFirst: number[] = [];
  const freshFirst: number[] = [];
  const liveFirst: number[] = [];
  const legacyCursor: number[] = [];
  const freshCursor: number[] = [];
  const liveCursor: number[] = [];
  // 生产路径每次请求都带同一个快照形状；in-flight 只做 Map 命中，不额外查库。
  const live = withLive
    ? { now: Date.now(), inflight: (key: string) => key.endsWith('7"]') }
    : null;
  for (let i = 0; i < reps; i++) {
    legacyFirst.push(timed(() => legacyListSessions(store, page, null)));
    freshFirst.push(timed(() => listSessions(store, page, null)));
    if (live !== null) liveFirst.push(timed(() => listSessions(store, page, null, live)));
    if (cursor !== null) {
      legacyCursor.push(timed(() => legacyListSessions(store, page, cursor)));
      freshCursor.push(timed(() => listSessions(store, page, cursor)));
      if (live !== null) liveCursor.push(timed(() => listSessions(store, page, cursor, live)));
    }
  }
  walk('legacy first page', legacyFirst);
  walk('fresh  first page', freshFirst);
  if (live !== null) {
    walk('live   first page (production)', liveFirst);
    if (liveCursor.length > 0) walk('live   cursor page (production)', liveCursor);
  }
  if (cursor !== null) {
    walk('legacy cursor page', legacyCursor);
    walk('fresh  cursor page', freshCursor);
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
