/**
 * Worker 计算段验收：合成长组分别跑主线程同步派生与「Worker 计算 + 主线程落库」，
 * 用 10ms 定时器测主线程事件循环 lag，期间做只读查询与小写事务。
 *
 * 两个场景：
 *   sync    主线程同步派生（基线，事件循环被读与计算占住）
 *   worker  Worker 只读计算，计划交回主线程用短写事务落库
 *
 * 只打印计数与毫秒，不打印正文。这是显式动作，不进测试套件。
 *
 *   bun scripts/perf-derive-worker.ts --requests 800
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { seedChain } from '../tests/fixtures';
import { applyDeriveGroup, drainDeriveGroupTx } from '../src/derive/sync';
import { claimGroupTx, markGroupDirtyTx } from '../src/derive/state';
import { createDeriveWorker } from '../src/derive/worker';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid --${name}`);
  return Math.trunc(value);
}

function stats(values: number[]): { n: number; p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { n: sorted.length, p50: Number(at(0.5).toFixed(1)), p95: Number(at(0.95).toFixed(1)), max: Number(at(1).toFixed(1)) };
}

const requests = arg('requests', 800);
const group = { convKey: 'perf-worker', actor: 'actor-perf' };
const dir = mkdtempSync(join(tmpdir(), 'atc-perf-worker-'));
const dbPath = join(dir, 'perf.db');
const store = openStore(dbPath);

const texts: string[] = [];
const seedStart = performance.now();
seedChain(store, Array.from({ length: requests }, (_, index) => {
  texts.push(`消息 ${index}`);
  return { texts: [...texts] };
}), group);
console.log(`seed: ${requests} 笔累积链，${Math.round(performance.now() - seedStart)} ms`);

function startProbes(): { stop: () => Record<string, unknown> } {
  const lags: number[] = [];
  const readCosts: number[] = [];
  const writeCosts: number[] = [];
  let last = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 10);
    last = now;
  }, 10);
  const readTimer = setInterval(() => {
    const t = performance.now();
    store.read.query('SELECT COUNT(*) AS n FROM request').get();
    readCosts.push(performance.now() - t);
  }, 5);
  const writeTimer = setInterval(() => {
    const t = performance.now();
    store.write(db => db.run(
      "INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      ['perf-write', String(t)]), 'perf-write');
    writeCosts.push(performance.now() - t);
  }, 20);
  return {
    stop: () => {
      clearInterval(lagTimer);
      clearInterval(readTimer);
      clearInterval(writeTimer);
      return { lag: stats(lags), read: stats(readCosts), write: stats(writeCosts) };
    },
  };
}

// 基线：主线程同步派生，一个事务读、算、写。
store.db.exec('PRAGMA busy_timeout=5000');
store.write(db => markGroupDirtyTx(db, group.convKey, group.actor, ''), 'perf-mark');
const syncProbes = startProbes();
const syncStart = performance.now();
const syncResult = store.write(db => drainDeriveGroupTx(db, group.convKey, group.actor), 'perf-sync');
const syncMs = performance.now() - syncStart;
await Bun.sleep(30);
console.log(`sync: ${syncMs.toFixed(1)} ms，processed=${syncResult?.processed ?? 0}，${JSON.stringify(syncProbes.stop())}`);

// Worker：只读连接算计划，主线程一次一个短事务落库。
store.write(db => markGroupDirtyTx(db, group.convKey, group.actor, ''), 'perf-mark');
const worker = createDeriveWorker(dbPath);
const workerProbes = startProbes();
const workerStart = performance.now();
let workerGroups = 0;
for (;;) {
  store.write(db => claimGroupTx(db, group.convKey, group.actor), 'derive-claim');
  const round = await worker.compute(group.convKey, group.actor);
  if (round === null) break;
  store.write(db => applyDeriveGroup(db, round), 'derive');
  workerGroups += 1;
}
const workerMs = performance.now() - workerStart;
await Bun.sleep(30);
console.log(`worker: ${workerMs.toFixed(1)} ms，groups=${workerGroups}，${JSON.stringify(workerProbes.stop())}`);
worker.close();

const queue = store.read.query<{ state: string }, [string, string]>(
  'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?').get(group.convKey, group.actor);
console.log(`final queue: ${JSON.stringify(queue)}`);

store.close();
rmSync(dir, { recursive: true, force: true });
