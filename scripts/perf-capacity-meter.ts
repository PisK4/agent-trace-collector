/**
 * v14 容量计数显式验收：GiB 级合成载荷、少量大行与稀疏键。
 *
 * 测三件事：
 * 1. 在线准入检查的实际装配（目录量测 + 四行计数）在主线程上的单次耗时与
 *    事件循环最大滞后，检查期间持续有小写入；
 * 2. 相同种子下，带计数触发器与去掉触发器两次摄入的事务 p95/p99、总吞吐与 WAL；
 * 3. 触顶回收、单次 raw 清理（整代际删除）与文件收缩各自作为不可抢占单元的时长。
 *
 * 只用合成载荷；临时库结束即删。显式动作，不进测试套件。
 *
 *   bun scripts/perf-capacity-meter.ts
 *   bun scripts/perf-capacity-meter.ts --raw-mib 896 --runs 200
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import type { Store } from '../src/store';
import { checkCapacityMeter, exactCapacitySums, readCapacityMeter } from '../src/capacity-meter';
import {
  createAdmissionGate, enforceBodyBudget, measureStorage, pruneRaw, shrinkStorage,
} from '../src/retention';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid --${name}`);
  return Math.trunc(value);
}

const rawMiB = arg('raw-mib', 896);
const rawRowMiB = arg('raw-row-mib', 8);
const runs = arg('runs', 200);

const rawRows = Math.floor(rawMiB / rawRowMiB);
const rawRowBytes = rawRowMiB * MiB;
const blockRows = 64;
const blockRowBytes = 2 * MiB;
const requestRows = 1024;
const requestRowBytes = 64 * 1024;
const hookRows = 64;
const hookRowBytes = 1 * MiB;
const totalMiB = rawRows * rawRowMiB + blockRows * 2 + requestRows * 0.0625 + hookRows;

type Tx = { ms: number; bytes: number };

/** 同一份种子给“带触发器”和“去触发器”两个库用，保证对比是同输入。 */
function seed(store: Store, name: string): { tx: Tx[]; bytes: number } {
  const tx: Tx[] = [];
  const payload = 'x'.repeat(rawRowBytes);
  const blockBlob = new Uint8Array(blockRowBytes).fill(0x61);
  const skeletonBlob = new Uint8Array(requestRowBytes).fill(0x62);
  const hookBlob = new Uint8Array(hookRowBytes).fill(0x63);
  const measure = (bytes: number, fn: () => void): void => {
    const started = performance.now();
    store.write(fn);
    tx.push({ ms: performance.now() - started, bytes });
  };

  // 稀疏键与少量大行：byte_offset 按大素数步进，主键仍 (file_generation, byte_offset)。
  for (let start = 0; start < rawRows; start += 4) {
    const end = Math.min(start + 4, rawRows);
    measure((end - start) * rawRowBytes, () => {
      const insert = store.db.prepare(
        `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
          line_type,event_at_ms,payload_json,privacy_version)
         VALUES ('${name}','sealed',?,?,'user',1,?,1)`,
      );
      for (let index = start; index < end; index++) {
        insert.run(index * 1_000_000_007, `session-${index % 16}`, payload);
      }
    });
  }
  for (let start = 0; start < blockRows; start += 8) {
    const end = Math.min(start + 8, blockRows);
    measure((end - start) * blockRowBytes, () => {
      const insert = store.db.prepare('INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)');
      for (let index = start; index < end; index++) {
        insert.run(new Uint8Array([index & 0xff, (index >> 8) & 0xff, 1, 2]), `fp-${index}`, blockBlob, blockRowBytes);
      }
    });
  }
  for (let start = 0; start < requestRows; start += 64) {
    const end = Math.min(start + 64, requestRows);
    measure((end - start) * requestRowBytes, () => {
      const insert = store.db.prepare(
        `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,
          updated_at,skeleton_z) VALUES (?,?,'2026-11-05','hook','available',0,1,1,1,?)`,
      );
      const link = store.db.prepare('INSERT INTO request_block(req_id,ord,role,block) VALUES (?,0,0,?)');
      for (let index = start; index < end; index++) {
        insert.run(index + 1, index, skeletonBlob);
        link.run(index + 1, (index % blockRows) + 1);
      }
    });
  }
  for (let start = 0; start < hookRows; start += 8) {
    const end = Math.min(start + 8, hookRows);
    measure((end - start) * hookRowBytes, () => {
      const insert = store.db.prepare(
        'INSERT INTO raw_hook(hook_id,received_at,parse_state,request_z) VALUES (?,1,?,?)',
      );
      // 建证据关联：带正文的 hook 只有关联到仍有正文的请求才会被到期删除。
      const evidence = store.db.prepare(
        `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
         VALUES (?,'hook',?,'merged',1)`,
      );
      for (let index = start; index < end; index++) {
        insert.run(`hook-${index}`, 'ok', hookBlob);
        evidence.run(index + 1, `hook-${index}`);
      }
    });
  }
  measure(0, () => {
    store.db.run(
      `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,
        fingerprint,last_ok_ms) VALUES (?,?,?,0,'synthetic',1)`,
      [name, 'synthetic.jsonl', 'sealed'],
    );
  });
  return { tx, bytes: tx.reduce((sum, row) => sum + row.bytes, 0) };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function summarize(tx: Tx[], totalMs: number, walBytes: number) {
  const durations = tx.map(row => row.ms);
  const bytes = tx.reduce((sum, row) => sum + row.bytes, 0);
  return {
    transactions: tx.length,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    p99_ms: percentile(durations, 0.99),
    total_ms: totalMs,
    mib: bytes / MiB,
    mib_per_s: bytes / MiB / (totalMs / 1000),
    wal_mib: walBytes / MiB,
  };
}

/** 固定间隔采样，记录最长一次读到主线程被占住的时间。 */
function lagSampler(intervalMs = 5): { stop(): number } {
  const lags: number[] = [];
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + intervalMs;
  }, intervalMs);
  return { stop: () => { clearInterval(timer); return Math.max(0, ...lags); } };
}

function dropCapacityTriggers(store: Store): void {
  const triggers = store.read.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'capacity_meter_%'",
  ).all();
  for (const trigger of triggers) store.db.exec(`DROP TRIGGER ${trigger.name}`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const root = mkdtempSync(join(tmpdir(), 'atc-capacity-meter-perf-'));
const baselineDir = mkdtempSync(join(tmpdir(), 'atc-capacity-meter-base-'));
const report: Record<string, unknown> = {};

try {
  const mainPath = join(root, 'perf.db');
  const store = openStore(mainPath);
  try {
    const seedStarted = performance.now();
    const seeded = seed(store, 'claude_session');
    const seedTotal = performance.now() - seedStarted;
    const walA = statSync(`${mainPath}-wal`).size;
    report.dataset = {
      total_mib: round(totalMiB),
      raw_rows: rawRows, raw_row_mib: rawRowMiB,
      block_rows: blockRows, request_rows: requestRows, hook_rows: hookRows,
      db_mib: round(statSync(mainPath).size / MiB),
    };
    report.ingest_with_triggers = summarize(seeded.tx, seedTotal, walA);

    const meter = readCapacityMeter(store.read);
    const usage = measureStorage(store, root);
    report.meter = {
      body_mib: round(meter.body_bytes / MiB),
      physical_body_mib: round(usage.body_bytes / MiB),
      source_mib: Object.fromEntries(Object.entries(meter.sources)
        .map(([key, value]) => [key, round(value.bytes / MiB)])),
    };

    // 在线检查：实际准入装配 + 持续小写入，采样事件循环最大滞后。
    const gate = createAdmissionGate(store, root, {
      bodyBudget: 10 * GiB, diskLimit: 400 * GiB,
    }, { ttlMs: 0 });
    const checkMs: number[] = [];
    const writeMs: number[] = [];
    let writes = 0;
    const sampler = lagSampler();
    const writer = setInterval(() => {
      const started = performance.now();
      store.write(db => db.run(
        `INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
         VALUES (1,'2026-11-05','hook','pending',0,1,1,1)`,
      ));
      writeMs.push(performance.now() - started);
      writes += 1;
    }, 1);
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      gate.check(0);
      checkMs.push(performance.now() - started);
      await Bun.sleep(1);
    }
    clearInterval(writer);
    const loopMax = sampler.stop();
    report.capacity_check = {
      runs,
      max_ms: round(Math.max(...checkMs)),
      p95_ms: round(percentile(checkMs, 0.95)),
      event_loop_max_ms: round(loopMax),
      concurrent_writes: writes,
      concurrent_write_max_ms: round(Math.max(0, ...writeMs)),
    };

    // raw 清理命中：一次 pruneRaw 删除一个已封口代际与已关联的到期 hook。
    // 先于回收执行：正文淘汰后关联请求的 skeleton_z 会为 NULL，hook 按设计不删。
    const pruneSampler = lagSampler();
    const pruneStarted = performance.now();
    const pruned = pruneRaw(store, 2);
    const pruneMs = performance.now() - pruneStarted;
    await Bun.sleep(1);
    const pruneLoopMax = pruneSampler.stop();
    const shrinkStarted = performance.now();
    const shrink = shrinkStorage(store);
    const shrinkMs = performance.now() - shrinkStarted;
    report.raw_cleanup = {
      prune_raw_ms: round(pruneMs),
      deleted: pruned,
      event_loop_max_ms: round(pruneLoopMax),
      shrink_ms: round(shrinkMs),
      shrink,
    };

    // 触顶回收：单个不可抢占调用，记录时长与主线程最长占用。
    const bodyNow = measureStorage(store, root).body_bytes;
    const evictSampler = lagSampler();
    const evictStarted = performance.now();
    const evicted = enforceBodyBudget(store, root, {
      bodyBudget: Math.max(1, Math.floor(bodyNow / 2 / 0.9)), diskLimit: 400 * GiB,
    }, { invalidate() {} });
    const enforceMs = performance.now() - evictStarted;
    await Bun.sleep(1);
    const evictLoopMax = evictSampler.stop();
    report.saturation = {
      enforce_body_budget_ms: round(enforceMs),
      evicted_requests: evicted,
      event_loop_max_ms: round(evictLoopMax),
    };

    // 全表对账是显式动作，这里只用来证明经历大批删除后计数仍一致。
    const check = checkCapacityMeter(store.read);
    report.integrity = {
      meter_check_ok: check.ok,
      exact: exactCapacitySums(store.read),
      meter: readCapacityMeter(store.read).sources,
    };
  } finally {
    store.close();
  }

  // 基线：同一份种子，先去掉计数触发器。
  const baselinePath = join(baselineDir, 'baseline.db');
  const baseline = openStore(baselinePath);
  try {
    dropCapacityTriggers(baseline);
    const started = performance.now();
    const seeded = seed(baseline, 'claude_session');
    const total = performance.now() - started;
    report.ingest_without_triggers = summarize(
      seeded.tx, total, statSync(`${baselinePath}-wal`).size,
    );
  } finally {
    baseline.close();
  }

  const withTriggers = report.ingest_with_triggers as { mib_per_s: number };
  const withoutTriggers = report.ingest_without_triggers as { mib_per_s: number };
  report.throughput_change_pct = round(
    ((withTriggers.mib_per_s - withoutTriggers.mib_per_s) / withoutTriggers.mib_per_s) * 100,
  );

  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(baselineDir, { recursive: true, force: true });
}
