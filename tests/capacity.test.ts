import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REJECT_REASONS, assertCapacityIsolation, createCapacityMetrics, createIngestMetrics,
  metadataSnapshot, summarizeDurations,
} from '../src/capacity';
import { intervalOf, loadConfig, type Config } from '../src/config';
import { buildCapacityConfig, makeHookEnvelope, makeLedgerLine, mulberry32 } from '../scripts/capacity-support';
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
