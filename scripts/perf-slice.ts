/**
 * 切片派生的长组容量验收：合成线性链上对比同步单事务与切片分步。
 *
 * 构造累积链：第 n 笔请求携带前 n 条消息，与真实会话的历史前缀形态一致。
 * 输出同步事务耗时、切片每步耗时（最大、p95）、步数与预算命中情况，供
 * 验收记录引用。只打印计数与毫秒，不打印正文。这是显式动作，不进测试套件。
 *
 *   bun scripts/perf-slice.ts --requests 300
 *   bun scripts/perf-slice.ts --requests 800 --budget 250
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { seedChain } from '../tests/fixtures';
import { drainDeriveGroupTx } from '../src/derive/sync';
import { drainDeriveEntry } from '../src/derive/unit';
import { markGroupDirtyTx } from '../src/derive/state';
import { DEFAULT_DERIVE_BUDGET } from '../src/config';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid --${name}`);
  return Math.trunc(value);
}

const requests = arg('requests', 300);
const budgetMs = arg('budget', 250);
const group = { convKey: 'perf-slice', actor: 'actor-perf' };

const dir = mkdtempSync(join(tmpdir(), 'atc-perf-slice-'));
const store = openStore(join(dir, 'perf.db'));
try {
  const texts: string[] = [];
  const seedStart = performance.now();
  seedChain(store, Array.from({ length: requests }, (_, index) => {
    texts.push(`合成消息 ${index}`);
    return { texts: [...texts] };
  }), group);
  console.log(`seed: ${requests} 笔累积链，${texts.length} 条消息，${Math.round(performance.now() - seedStart)} ms`);

  const syncStart = performance.now();
  const sync = store.write(db => drainDeriveGroupTx(db, group.convKey, group.actor), 'perf-sync');
  const syncMs = performance.now() - syncStart;
  console.log(`sync: ${syncMs.toFixed(1)} ms，结果 ${JSON.stringify(sync)}`);

  store.deriveRuntime = {
    budget: { ...DEFAULT_DERIVE_BUDGET, maxStageBatchMs: budgetMs },
    dataDir: dir,
    dbPath: join(dir, 'perf.db'),
  };
  store.write(db => markGroupDirtyTx(db, group.convKey, group.actor, ''), 'perf-mark');
  const sliceStart = performance.now();
  const steps: number[] = [];
  for (let call = 0; call < 20000; call++) {
    const started = performance.now();
    const result = await drainDeriveEntry(store, 1, { convKey: group.convKey });
    steps.push(performance.now() - started);
    if (result.processed + result.discarded === 0 && result.groups.length === 0 && call > 0) break;
    const queue = store.read.query<{ state: string }, [string, string]>(
      'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?')
      .get(group.convKey, group.actor);
    if (queue?.state === 'clean') break;
  }
  const sliceMs = performance.now() - sliceStart;
  const sorted = [...steps].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const overBudget = steps.filter(ms => ms > budgetMs).length;
  console.log(`slice: 总 ${sliceMs.toFixed(1)} ms，${steps.length} 步，max ${max.toFixed(1)} ms，p95 ${p95.toFixed(1)} ms，超预算 ${overBudget} 步`);
  console.log(`ratio: 切片总耗时 / 同步事务 = ${(sliceMs / Math.max(syncMs, 0.001)).toFixed(2)}`);
  const queue = store.read.query<{ state: string; input_revision: number; published_revision: number }, [string, string]>(
    'SELECT state,input_revision,published_revision FROM derive_queue WHERE conv_key=? AND actor=?')
    .get(group.convKey, group.actor);
  console.log(`final queue: ${JSON.stringify(queue)}`);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
