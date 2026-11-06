/**
 * pending 与 stats 的显式宽行回归。只建合成临时库，不启动采集器或读取本机来源。
 * BLOB 仅模拟表页载荷，不承担正文可读性验收。实验结束关闭并删除自己的临时目录。
 *
 * bun scripts/perf-pending-stats.ts --rows 8192 --payload-bytes 4096
 * bun scripts/perf-pending-stats.ts --rows 131072 --payload-bytes 16384
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { HOOK_ABSENT_THRESHOLD_MS, markHookAbsent, reconcilePending } from '../src/hook';
import { getStats } from '../src/queries/stats';

const limits = { pendingMs: 500, statsMs: 250 };
const values: Record<string, number> = { '--rows': 8192, '--payload-bytes': 4096 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]!;
  const raw = args[index + 1];
  if (!Object.hasOwn(values, key) || raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    process.stderr.write('usage: perf-pending-stats [--rows N] [--payload-bytes N]\n');
    process.exit(2);
  }
  values[key] = Number(raw);
}
const rows = values['--rows']!;
const payloadBytes = values['--payload-bytes']!;
const bytes = (rows + 201) * payloadBytes;
if (!Number.isSafeInteger(rows) || rows > 262_144 || !Number.isSafeInteger(payloadBytes)
  || payloadBytes > 65_536 || bytes > 3 * 1024 ** 3) {
  process.stderr.write('invalid_size: rows<=262144 payload_bytes<=65536 total<=3GiB\n');
  process.exit(2);
}
const disk = statfsSync(tmpdir());
if (disk.bavail * disk.bsize < bytes * 3) {
  process.stderr.write('insufficient_temp_space\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ phase: 'size', rows, payload_bytes: payloadBytes, bytes }) + '\n');
const dir = mkdtempSync(join(tmpdir(), 'atc-pending-stats-'));
const store = openStore(join(dir, 'trace.db'));
const now = Date.now();
const originalQuery = store.read.query;
const query = originalQuery.bind(store.read);
let absenceSql = '';
let groupSql = '';
store.read.query = ((sql: string) => {
  if (sql.includes('NOT EXISTS') && sql.includes('pending_hook ph')) absenceSql = sql;
  if (sql.includes('GROUP BY body_state')) groupSql = sql;
  return query(sql);
}) as typeof originalQuery;
try {
  const insertSql = `INSERT INTO request(
    req_id,conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
    body_state,derive_version,have,miss_reason,skeleton_z,created_at,updated_at
  ) VALUES (?,'synthetic-perf','session','synthetic-actor','known','synthetic',
    ?,'2026-11-06','through',?,0,?,?,zeroblob(?),1,1)`;
  for (let start = 0; start < rows; start += 1024) {
    store.write(db => {
      const insert = db.query(insertSql);
      for (let i = start; i < Math.min(rows, start + 1024); i++) {
        const pending = i % 10 === 0;
        insert.run(i + 1, now - HOOK_ABSENT_THRESHOLD_MS - rows + i - 1,
          pending ? 'pending' : 'available', pending ? 0 : 1,
          pending ? 'hook_absent' : null, payloadBytes);
      }
    });
  }
  store.write(db => {
    const insert = db.query(`INSERT INTO pending_hook(hook_id,response_id_norm,first_seen)
      VALUES (?,?,?)`);
    for (let i = 0; i < 1579; i++) {
      insert.run(`synthetic-hook-${i}`, i < 7 ? `synthetic-response-${i}` : null,
        now - 86_400_000);
    }
  });
  const pending: { phase: string; ms: number; marked: number }[] = [];
  const runPending = (phase: string): number => {
    const started = performance.now();
    reconcilePending(store, now);
    const marked = markHookAbsent(store, now);
    pending.push({ phase, ms: performance.now() - started, marked });
    return marked;
  };
  for (let i = 0; i < 3; i++) assert.equal(runPending('empty'), 0);
  store.write(db => {
    const insert = db.query(insertSql);
    for (let i = 0; i < 201; i++) {
      insert.run(rows + i + 1, now - HOOK_ABSENT_THRESHOLD_MS - 1,
        'pending', 0, null, payloadBytes);
    }
  });
  assert.equal(runPending('full'), 200);
  assert.equal(runPending('tail'), 1);
  assert.equal(runPending('drained'), 0);

  const statsMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    store.write(db => db.run(`INSERT INTO collector_state(key,value_json) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
    ['synthetic-perf-revision', String(i)]));
    const started = performance.now();
    const stats = getStats(store);
    statsMs.push(performance.now() - started);
    const reference = query(`SELECT body_state AS state,COUNT(*) AS count
      FROM request GROUP BY body_state ORDER BY body_state`).all();
    assert.deepEqual(stats.body_states, reference);
    assert.equal(stats.requests, rows + 201);
  }
  assert.notEqual(absenceSql, '');
  assert.notEqual(groupSql, '');
  const absencePlan = query(`EXPLAIN QUERY PLAN ${absenceSql}`)
    .all(now - HOOK_ABSENT_THRESHOLD_MS, 200) as { detail: string }[];
  const groupPlan = query(`EXPLAIN QUERY PLAN ${groupSql}`).all() as { detail: string }[];
  const result = {
    phase: 'result', bun: Bun.version, rows, payload_bytes: payloadBytes, bytes,
    pending, pending_max_ms: Math.max(...pending.map(row => row.ms)),
    stats_ms: statsMs, stats_max_ms: Math.max(...statsMs),
    absence_plan: absencePlan.map(row => row.detail),
    group_plan: groupPlan.map(row => row.detail), limits,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  assert(result.absence_plan.some(row => row.includes('i_req_body')), 'absence_index');
  assert(result.group_plan.some(row => row.includes('COVERING INDEX i_req_body')), 'stats_index');
  assert(result.pending_max_ms <= limits.pendingMs, 'pending_budget');
  assert(result.stats_max_ms <= limits.statsMs, 'stats_budget');
} finally {
  store.read.query = originalQuery;
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
