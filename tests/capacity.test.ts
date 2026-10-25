import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REJECT_REASONS, assertCapacityIsolation, createCapacityMetrics, createIngestMetrics,
  metadataSnapshot, summarizeDurations,
} from '../src/capacity';
import { intervalOf, loadConfig, type Config } from '../src/config';
import {
  createPeakTracker, finalQueueMissing, offeredShortfall, requiresLongRunAck, scenarioPlan, scheduledTicks,
} from '../scripts/capacity/capacity';
import type { Args } from '../scripts/capacity/capacity';
import { buildCapacityConfig, makeHookEnvelope, makeLedgerLine, mulberry32 } from '../scripts/capacity/capacity-support';
import { fixture } from './fixtures';

test('最近秩分位与空样本', () => {
  expect(summarizeDurations([])).toEqual({ count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null });
  expect(summarizeDurations([1, 2, 3, 4])).toEqual({
    count: 4, p50_ms: 2, p95_ms: 4, p99_ms: 4, max_ms: 4,
  });
});

test('拒绝计数只接受固定原因且不保留原因文本', () => {
  const metrics = createIngestMetrics(1000);
  for (const reason of REJECT_REASONS) metrics.reject(reason);
  metrics.reject('busy');
  metrics.accept({ duplicate: false, requestBytes: 10, replyBytes: 5 });
  const snapshot = metrics.snapshot(2000);
  expect(snapshot.rejected_total).toBe(REJECT_REASONS.length + 1);
  expect(snapshot.rejected_by_reason.busy).toBe(2);
  expect(snapshot.accepted).toBe(1);
  expect(snapshot.uptime_ms).toBe(1000);
  expect(() => (metrics as unknown as { reject(value: string): void })
    .reject('user supplied text')).toThrow('invalid_reject_reason');
});

test('容量快照包含写统计、事件循环、队列年龄与存储', () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 100);
    metrics.jobs.record('derive', 12);
    metrics.jobs.record('derive', 7);
    f.store.write(db => db.run(
      "INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'c','a','known',100,'2026-10-22','hook','pending',0,1,1,1)"));
    f.store.write(db => db.run("INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES ('c','a','')"));
    const snapshot = metrics.snapshot(f.store, f.dir) as any;
    expect(snapshot.writer.count).toBeGreaterThanOrEqual(2);
    expect(snapshot.jobs.derive).toEqual({ count: 2, total_ms: 19, max_ms: 12 });
    expect(snapshot.derive_queue.pending_groups).toBe(1);
    expect(snapshot.derive_queue.oldest_request_started_ms).toBe(100);
    expect(snapshot.storage.db_bytes).toBeGreaterThan(0);
    expect(snapshot.ingest.rejected_total).toBe(0);
    expect(snapshot.metadata).toMatchObject({ clean_groups: 0 });
  } finally { f.close(); }
});

test('元数据快照按 clean 组与来源 JSON 计长', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const requestColumns = (db.query('PRAGMA table_info(request)').all() as { name: string }[])
        .map(row => row.name);
      const source = requestColumns.includes('source_facts_json')
        ? ',source_facts_json' : '';
      const sourceValue = requestColumns.includes('source_facts_json') ? ",'{\"k\":1}'" : '';
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at${source})
        VALUES (1,'c1','a','known',100,'2026-10-22','hook','pending',0,1,1,1${sourceValue})`);
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at${source})
        VALUES (2,'c2','a','known',100,'2026-10-22','hook','pending',0,1,1,1${sourceValue})`);
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,state,dirty_since_ms)
        VALUES ('c1','a','','g1',1,0,5,'clean',NULL),
               ('c2','a','','g1',1,0,5,'dirty',50)`);
    });
    const snapshot = metadataSnapshot(f.store);
    expect(snapshot.clean_groups).toBe(1);
    expect(snapshot.queue_clean_bytes).toBeGreaterThan(0);
    expect(snapshot.total_bytes).toBeGreaterThanOrEqual(snapshot.queue_clean_bytes);
    expect(snapshot.per_clean_group_bytes).toBe(snapshot.total_bytes);
    expect(snapshot.per_request_bytes).toBe(snapshot.total_bytes / 2);
  } finally { f.close(); }
});

test('隔离断言拒绝默认配置与真实上游端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-test-'));
  try {
    mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
    const base = loadConfig({});
    expect(() => assertCapacityIsolation({ root, config: base, upstreamPort: 40123 }))
      .toThrow('capacity_dataDir_mismatch');
    const isolated = {
      ...base,
      dataDir: join(root, 'data'),
      ledgerPath: join(root, 'sources', 'usage.jsonl'),
      routingDir: join(root, 'sources', 'routing'),
      magpieUrl: 'http://127.0.0.1:3425',
      bodyBudget: 1_000,
      diskLimit: 2_000,
    };
    expect(() => assertCapacityIsolation({ root, config: isolated, upstreamPort: 3425 }))
      .toThrow('capacity_upstream_is_real_magpie');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('容量间隔只由显式 Config 注入，缺省保持常量', () => {
  const base = {} as Pick<Config, 'intervals'>;
  expect(intervalOf(base, 'retention', 3_600_000)).toBe(3_600_000);
  const configured = { intervals: { retention: 5_000, rawPrune: 5_000 } };
  expect(intervalOf(configured, 'retention', 3_600_000)).toBe(5_000);
  expect(intervalOf(configured, 'derive', 1_000)).toBe(1_000);
  expect(() => intervalOf({ intervals: { retention: 0 } }, 'retention', 1))
    .toThrow('invalid_capacity_interval');
});

test('合成负载固定种子可复现', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test('合成配置只落在临时根内', () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-config-'));
  try {
    mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
    const config = buildCapacityConfig({ root, upstreamPort: 40123, bodyBudget: 1_000_000, diskLimit: 2_000_000 });
    expect(config.dataDir).toBe(join(root, 'data'));
    expect(config.ledgerPath).toBe(join(root, 'sources', 'usage.jsonl'));
    expect(config.routingDir).toBe(join(root, 'sources', 'routing'));
    expect(config.magpieUrl).toBe('http://127.0.0.1:40123');
    expect(config.port).toBe(0);
    expect(() => assertCapacityIsolation({ root, config, upstreamPort: 40124 }))
      .toThrow('capacity_upstream_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('合成 hook 与账本行形状可被真实解析器接受', () => {
  const envelope = makeHookEnvelope({
    hookId: 'hook-1', session: 'session-1', routeId: 7,
    requestBytes: 4096, replyBytes: 512, bodyOmitted: false, omitReason: null,
    model: 'synthetic-model', startedMs: 1_700_000_000_000,
  });
  expect(envelope.origin).toBe('local');
  expect(envelope.request_bytes).toBeGreaterThanOrEqual(4096);
  expect(envelope.reply_bytes).toBeGreaterThanOrEqual(512);
  expect(JSON.stringify(envelope.request)).toContain('synthetic');
  const line = makeLedgerLine({ routeId: 7, session: 'session-1', responseId: envelope.hook_id, startedMs: 1_700_000_000_000 });
  expect(JSON.parse(line)).toMatchObject({ route_id: 7, session: 'session-1', response_id: envelope.hook_id });
});

test('场景矩阵固定请求速率、时长与正文混合', () => {
  // 任何 full=true 都要求显式确认；闸门的否定分支由最后两条断言覆盖。
  expect(scenarioPlan('baseline-1rps', { full: true, acknowledgeLongRun: true })).toMatchObject({
    durationMs: 600_000, rps: 1, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 1,
  });
  expect(scenarioPlan('baseline-5rps', { full: true, acknowledgeLongRun: true })).toMatchObject({
    durationMs: 600_000, rps: 5, concurrency: 4,
  });
  expect(scenarioPlan('burst', { full: false })).toMatchObject({ concurrency: 10, requestBytes: 4 * 1024 * 1024 });
  expect(scenarioPlan('long', { full: false, requests: 2_000 })).toMatchObject({ requests: 2_000 });
  expect(scenarioPlan('long', { full: false, requests: 10_000, acknowledgeLongRun: true }))
    .toMatchObject({ requests: 10_000 });
  expect(() => scenarioPlan('long', { full: false, requests: 10_000 }))
    .toThrow('capacity_long_run_not_acknowledged');
  expect(() => scenarioPlan('baseline-5rps', { full: true, acknowledgeLongRun: false }))
    .toThrow('capacity_long_run_not_acknowledged');
});

test('长跑确认覆盖全场景、10 分钟与 10,000 笔长组', () => {
  const base: Args = {
    scenario: 'smoke', full: false, acknowledgeLongRun: false,
    seed: 1, report: '/tmp/report.json',
    bodyBudget: 1, bodyBudgetExplicit: false, diskLimit: 2,
  };
  expect(requiresLongRunAck(base)).toBe(false);
  expect(requiresLongRunAck({ ...base, scenario: 'all' })).toBe(true);
  expect(requiresLongRunAck({ ...base, durationMs: 600_000 })).toBe(true);
  expect(requiresLongRunAck({ ...base, scenario: 'long', requests: 10_000 })).toBe(true);
  expect(requiresLongRunAck({ ...base, scenario: 'long', requests: 2_000 })).toBe(false);
  expect(requiresLongRunAck({ ...base, full: true })).toBe(true);
});

test('计划速率按绝对刻度记账，少发的刻度进报告缺口', () => {
  // 10 分钟 5 rps 是 3000 个刻度；等响应再睡的写法到不了这个数，只会记下实际发出去的。
  expect(scheduledTicks(600_000, 5)).toBe(3_000);
  expect(scheduledTicks(600_000, 1)).toBe(600);
  expect(scheduledTicks(0, 5)).toBe(0);
  expect(scheduledTicks(600_000, 0)).toBe(0);
  expect(offeredShortfall({ launched: 3_000, ticks_scheduled: 3_000, ticks_dropped: 0 })).toEqual([]);
  expect(offeredShortfall({ launched: 1_703, ticks_scheduled: 3_000, ticks_dropped: 1_297 }))
    .toEqual(['offered:1703<3000']);
  // 收敛读数说 0、终值快照还有脏组：请求行数会变，不能让报告按已收敛记。
  expect(finalQueueMissing({ derive_queue: { pending_groups: 0 } })).toEqual([]);
  expect(finalQueueMissing({ derive_queue: { pending_groups: 4 } }))
    .toEqual(['pending_groups_final:4!=0']);
});

test('峰值追踪只取实际观测到的快照', () => {
  const peaks = createPeakTracker();
  const snapshot = (rss: number, db: number, body: number, total: number) => ({
    rss_bytes: rss,
    storage: {
      db_bytes: db, wal_bytes: 1, temp_bytes: 0,
      body_bytes: body, total_bytes: total, freelist_count: 0,
    },
  }) as never;
  peaks.observe(snapshot(100, 10, 5, 11));
  peaks.observe(snapshot(90, 20, 4, 21));
  expect(peaks.samples).toBe(2);
  expect(peaks.rss_bytes).toBe(100);
  expect(peaks.storage.db_bytes).toBe(20);
  expect(peaks.storage.body_bytes).toBe(5);
  expect(peaks.storage.total_bytes).toBe(21);
});
