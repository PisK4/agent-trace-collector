import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadReadToken } from '../src/http';
import { DEFAULT_DERIVE_BUDGET, loadBoundSaltTx, loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { fixture } from './fixtures';
import { persistBody } from '../src/body';

// 生产切片保持冻结；实验身份放行不代表读取完整性与容量已验收。
test('在线来源共用摄入入口，自定义账本路径仍沿用固定身份且半行不空转写', async () => {
  const f = fixture();
  const upstream = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ version: '0.1.1294' }),
  });
  let collector: Awaited<ReturnType<typeof startCollector>> | undefined;
  try {
    const ledger = JSON.stringify({
      t: '2026-10-24T00:00:00Z', route_id: 7, session: 'synthetic-session',
      agent: 'demo', model: 'm', in: 10, out: 5,
    });
    writeFileSync(`${f.dir}/custom-ledger.jsonl`, `${ledger}\npartial`);
    mkdirSync(`${f.dir}/routing`);
    const route = JSON.stringify({
      id: 7, time: '2026-10-24T00:00:00Z', session: 'synthetic-session',
      agent: 'demo', model: 'm', provider: 'synthetic', status: 200,
    });
    writeFileSync(`${f.dir}/routing/2026-10-24.jsonl`, `${route}\n`);
    collector = await startCollector({
      ...loadConfig({}), port: 0, dataDir: f.dir,
      ledgerPath: `${f.dir}/custom-ledger.jsonl`, routingDir: `${f.dir}/routing`,
      magpieUrl: `http://127.0.0.1:${upstream.port}`,
      intervals: { ledger: 5, route: 5 },
    });
    const port = collector.port;
    const token = loadReadToken(f.dir);
    const snapshot = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/ingest-metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        jobs: Record<string, { count: number }>;
        writer: { count: number; by_name: Record<string, { count: number }> };
      }>;
    };
    let before = await snapshot();
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((before.jobs.ledger?.count ?? 0) >= 3 && (before.jobs.probe?.count ?? 0) > 0) break;
      await Bun.sleep(5);
      before = await snapshot();
    }
    expect(before.jobs.ledger?.count).toBeGreaterThanOrEqual(3);
    expect(before.jobs.probe?.count).toBeGreaterThan(0);
    expect(f.store.read.query(`SELECT source_kind,source_name,committed_off
      FROM source_cursor ORDER BY source_kind`).all()).toEqual([
      { source_kind: 'ledger', source_name: 'usage.jsonl', committed_off: Buffer.byteLength(ledger) + 1 },
      { source_kind: 'route_file', source_name: '2026-10-24.jsonl', committed_off: Buffer.byteLength(route) + 1 },
    ]);
    expect(before.writer.by_name.ledger?.count).toBe(1);
    expect(before.writer.by_name.route?.count).toBe(1);
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM raw_route').get()).toEqual({ n: 1 });

    let after = before;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((after.jobs.ledger?.count ?? 0) >= before.jobs.ledger!.count + 3) break;
      await Bun.sleep(5);
      after = await snapshot();
    }
    expect(after.jobs.ledger!.count).toBeGreaterThanOrEqual(before.jobs.ledger!.count + 3);
    expect(after.writer.count).toBe(before.writer.count);
  } finally {
    await collector?.stop();
    await upstream.stop(true);
    f.close();
  }
});

describe('startCollector 切片模式启用路径', () => {
  test('设了派生预算且未声明实验身份时拒绝启动', async () => {
    const f = fixture();
    try {
      const config = {
        ...loadConfig({}),
        port: 0,
        dataDir: f.dir,
        ledgerPath: `${f.dir}/missing.jsonl`,
        routingDir: `${f.dir}/missing-routing`,
        deriveBudget: DEFAULT_DERIVE_BUDGET,
      };
      await expect(startCollector(config)).rejects.toThrow('slice_read_unmigrated');
    } finally {
      f.close();
    }
  });

  test('容量实验身份放行切片模式且能正常起停', async () => {
    const f = fixture();
    try {
      const config = {
        ...loadConfig({}),
        port: 0,
        dataDir: f.dir,
        ledgerPath: `${f.dir}/missing.jsonl`,
        routingDir: `${f.dir}/missing-routing`,
        deriveBudget: DEFAULT_DERIVE_BUDGET,
      };
      const collector = await startCollector(config, { capacityExperiment: true });
      const response = await fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
        headers: { origin: `http://127.0.0.1:${collector.port}` },
      });
      expect(response.status).toBe(200);
      await collector.stop();
    } finally {
      f.close();
    }
  });
});

// 启动生命周期：端口、信号与启动任务接线（自 queries.test 迁入，按被测入口归位）。
test('启动拒绝端口冲突且端口由配置决定', async () => {
  const f = fixture();
  const held = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    const config = { ...loadConfig({}), port: held.port ?? 0, dataDir: f.dir };
    await expect(startCollector(config)).rejects.toThrow();
  } finally {
    await held.stop(true);
    f.close();
  }
});

test('SIGTERM停止后不再响应请求', async () => {
  const f = fixture();
  try {
    const config = {
      ...loadConfig({}),
      port: 0,
      dataDir: f.dir,
      ledgerPath: `${f.dir}/missing.jsonl`,
      routingDir: `${f.dir}/missing-routing`,
    };
    const collector = await startCollector(config);
    const response = await fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
      headers: { origin: `http://127.0.0.1:${collector.port}` },
    });
    expect(response.status).toBe(200);
    await collector.stop();
    await expect(fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
      headers: { origin: `http://127.0.0.1:${collector.port}` },
    })).rejects.toThrow();
  } finally {
    f.close();
  }
});

test('启动时逐项运行各任务，回收不受其它任务占锁影响', async () => {
  const f = fixture();
  try {
    // 盐与库的绑定要在空库时建立：有数据之后再生成盐会被拒绝（无法证明历史占位符用的是它）。
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    const config = {
      ...loadConfig({}),
      port: 0,
      dataDir: f.dir,
      ledgerPath: `${f.dir}/missing.jsonl`,
      routingDir: `${f.dir}/missing-routing`,
      // 预算压到 100 字节（这两段重复文本压缩后约 370 B）：启动时那一轮回收必须真的执行，
      // 而不是被前一个 tick 的锁挡住。
      bodyBudget: 100,
      diskLimit: 16_000_000_000,
    };
    for (const id of [1, 2]) {
      f.store.db.run(
        "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (?,?,?,'hook','pending',0,1,1,1)",
        [id, id, '2026-10-20'],
      );
      persistBody(f.store, id, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(4096) + id }] }] },
        reply: { id: `msg_${id}`, content: [] },
        redact_version: 1,
      });
    }
    const collector = await startCollector(config);
    try {
      // 启动那一轮是同步发起的；给事件循环一个机会跑完。
      await new Promise(resolve => setTimeout(resolve, 50));
      const states = f.store.read.query<{ body_state: string }, []>(
        'SELECT body_state FROM request ORDER BY req_id').all();
      expect(states).toEqual([{ body_state: 'evicted' }, { body_state: 'evicted' }]);
    } finally {
      await collector.stop();
    }
  } finally {
    f.close();
  }
});
