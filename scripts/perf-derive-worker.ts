/**
 * Worker 隔离验收：合成长组分别跑主线程同步派生与 Worker 派生，
 * 用 10ms 定时器测主线程事件循环 lag，期间做只读查询与小写事务。
 *
 * 四个场景：
 *   sync            主线程同步派生，写探针等待锁（基线，事件循环被占）
 *   worker-readonly Worker 派生，主线程只读
 *   worker-wait     Worker 派生，主线程写探针等待锁（busy_timeout=5000）
 *   worker-nowait   Worker 派生，主线程写探针不等待（busy_timeout=0），忙则立即失败
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
import { drainDeriveGroupTx } from '../src/derive/sync';
import { markGroupDirtyTx } from '../src/derive/state';

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

function startProbes(options: { write: boolean }): { stop: () => Record<string, unknown> } {
  const lags: number[] = [];
  const readCosts: number[] = [];
  const writeCosts: number[] = [];
  let writeFailed = 0;
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
  const writeTimer = options.write
    ? setInterval(() => {
        const t = performance.now();
        try {
          store.write(db => db.run(
            "INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            ['perf-write', String(t)]), 'perf-write');
          writeCosts.push(performance.now() - t);
        } catch {
          writeFailed += 1;
        }
      }, 20)
    : null;
  return {
    stop: () => {
      clearInterval(lagTimer);
      clearInterval(readTimer);
      if (writeTimer !== null) clearInterval(writeTimer);
      return {
        lag: stats(lags), read: stats(readCosts),
        write: options.write ? stats(writeCosts) : null, writeFailed,
      };
    },
  };
}

async function runWorker(label: string, mode: 'readonly' | 'wait' | 'nowait'): Promise<void> {
  store.db.exec(`PRAGMA busy_timeout=${mode === 'nowait' ? 0 : 5000}`);
  store.write(db => markGroupDirtyTx(db, group.convKey, group.actor, ''), 'perf-mark');
  const probes = startProbes({ write: mode !== 'readonly' });
  const worker = new Worker(new URL('./perf-derive-worker-entry.ts', import.meta.url).href);
  const done = new Promise<{ ms: number; steps: number[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker_timeout')), 300_000);
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { kind: string; ms?: number; steps?: number[]; message?: string };
      if (message.kind === 'done') { clearTimeout(timer); resolve({ ms: message.ms ?? 0, steps: message.steps ?? [] }); }
      if (message.kind === 'error') { clearTimeout(timer); reject(new Error(message.message ?? 'worker_error')); }
    };
    worker.onerror = (event) => { clearTimeout(timer); reject(new Error(String(event.message ?? 'worker_onerror'))); };
  });
  worker.postMessage({ kind: 'start', dbPath, convKey: group.convKey, actor: group.actor });
  const result = await done;
  worker.terminate();
  await Bun.sleep(30);
  const probeResult = probes.stop();
  store.db.exec('PRAGMA busy_timeout=5000');
  console.log(`${label}: worker ${result.ms.toFixed(1)} ms，steps=${result.steps.length}，${JSON.stringify(probeResult)}`);
}

// 基线：主线程同步派生，写探针等待锁。
store.db.exec('PRAGMA busy_timeout=5000');
store.write(db => markGroupDirtyTx(db, group.convKey, group.actor, ''), 'perf-mark');
let probes = startProbes({ write: true });
const syncStart = performance.now();
const syncResult = store.write(db => drainDeriveGroupTx(db, group.convKey, group.actor), 'perf-sync');
const syncMs = performance.now() - syncStart;
await Bun.sleep(30);
const syncProbes = probes.stop();
console.log(`sync: ${syncMs.toFixed(1)} ms，processed=${syncResult?.processed ?? 0}，${JSON.stringify(syncProbes)}`);

await runWorker('worker-readonly', 'readonly');
await runWorker('worker-wait', 'wait');
await runWorker('worker-nowait', 'nowait');

const queue = store.read.query<{ state: string }, [string, string]>(
  'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?').get(group.convKey, group.actor);
console.log(`final queue: ${JSON.stringify(queue)}`);

store.close();
rmSync(dir, { recursive: true, force: true });
