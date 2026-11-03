import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { createCapacityMetrics } from '../src/capacity';
import { createHandler } from '../src/http';
import { createDiagnosticLog } from '../src/monitoring';
import type { StorageUsage } from '../src/retention';

const usage: StorageUsage = {
  body_bytes: 10, db_bytes: 20, wal_bytes: 0, temp_bytes: 0, other_bytes: 3,
  total_bytes: 33, free_bytes: 1_000, page_count: 10, freelist_count: 0,
};

test('轻量快照不量存储、不求和元数据，存储值取闸门最近量测', () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 1_000, {
      instance: 'proc-a',
      admission: () => ({ mode: 'normal', reason: null, usage, at_ms: 2_000 }),
    });
    const light = metrics.lightSnapshot();
    expect(light.instance).toBe('proc-a');
    expect(light.storage).toMatchObject({ body_bytes: 10, total_bytes: 33 });
    expect(light.storage_measured_at_ms).toBe(2_000);
    expect(light).not.toHaveProperty('metadata');
    expect(light.derive_queue).toMatchObject({ pending_groups: 0 });
    // 轻量端点不能触发全表求和：量测计数保持 0。
    expect((light.storage_measure as { count: number }).count).toBe(0);

    // 没有量测时不编造存储值。
    const unknown = createCapacityMetrics(f.store, f.dir, 1_000, {
      instance: 'proc-a',
      admission: () => ({ mode: 'normal', reason: null, usage: null, at_ms: null }),
    }).lightSnapshot();
    expect(unknown.storage).toBeNull();
    expect(unknown.storage_measured_at_ms).toBeNull();
  } finally {
    f.close();
  }
});

test('/api/metrics 返回轻量指标且需要读取令牌', async () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 1_000, {
      instance: 'proc-a',
      admission: () => ({ mode: 'normal', reason: null, usage, at_ms: 2_000 }),
    });
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token', undefined, metrics);
    const request = (headers: Record<string, string>) =>
      new Request('http://127.0.0.1:8320/api/metrics', { headers: { host: '127.0.0.1:8320', ...headers } });
    expect((await handler(request({}))).status).toBe(401);
    const response = await handler(request({ authorization: 'Bearer synthetic-read-token' }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.instance).toBe('proc-a');
    expect(body).not.toHaveProperty('metadata');
    expect((body.storage_measure as { count: number }).count).toBe(0);
  } finally {
    f.close();
  }
});

test('快速读取不写慢日志，超过阈值才写一条带路由模板的记录', async () => {
  const f = fixture();
  const lines: string[] = [];
  try {
    const fast = createDiagnosticLog({
      instance: 'proc-a', sink: line => lines.push(line),
    });
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token',
      undefined, undefined, undefined, fast);
    const request = () => new Request('http://127.0.0.1:8320/api/stats', {
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer synthetic-read-token' },
    });
    expect((await handler(request())).status).toBe(200);
    expect(lines).toHaveLength(0);

    const slow = createDiagnosticLog({
      instance: 'proc-a', thresholds: { syncMs: 0, workerMs: 500 }, sink: line => lines.push(line),
    });
    const slowHandler = createHandler(f.store, loadConfig({}), 'synthetic-read-token',
      undefined, undefined, undefined, slow);
    expect((await slowHandler(request())).status).toBe(200);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.op).toBe('http.read');
    expect(entry.phase).toBe('/api/stats');
    expect(JSON.stringify(entry)).not.toContain('synthetic-read-token');
  } finally {
    f.close();
  }
});
