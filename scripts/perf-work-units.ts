import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore } from '../src/store';
import { persistBodyTx } from '../src/body';
import { makeHookEnvelope, waitForCollector } from './capacity/capacity-support';

// 只使用独立子进程、合成正文和新临时根，负载端不占用采集器事件循环。
const repository = dirname(import.meta.dir);
const root = mkdtempSync(join(tmpdir(), 'atc-capacity-perf-units-'));
let child: ReturnType<typeof Bun.spawn> | undefined;
const upstream = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/v1') return Response.json({ version: '0.1.1296' });
    return Response.json({ period: url.searchParams.get('period'), offset: 0, rows: [] });
  },
});
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
try {
  mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
  writeFileSync(join(root, 'sources', 'usage.jsonl'), '');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ root, upstream_port: upstream.port,
    body_budget: 1_000_000_000, disk_limit: 2_000_000_000 }));
  child = Bun.spawn([process.execPath, join(repository, 'scripts/capacity/capacity-collector.ts'), configPath],
    { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
  const port = await waitForCollector(child);
  const readToken = readFileSync(join(root, 'data', 'read.token')).toString('base64url');
  const hookToken = readFileSync(join(root, 'data', 'hook.token')).toString('base64url');
  const metrics = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest-metrics`,
      { headers: { authorization: `Bearer ${readToken}` } });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  // 让首个费用窗口在测量前完成，120 s 窗口只包含稳态轮询。
  for (let index = 0; index < 200; index++) {
    const snapshot = await metrics();
    if ((snapshot.jobs.cost?.count ?? 0) > 0) break;
    await delay(500);
  }
  const before = await metrics();
  assert.ok((before.jobs.cost?.count ?? 0) > 0, 'cost warmup timed out');
  await delay(120_000);
  const after = await metrics();
  const idleWrites = after.writer.count - before.writer.count;
  assert.equal(idleWrites, 0, 'idle window opened writer transactions');

  // 启动后种独立组积压；不把另一进程的写入混入采集器 writer 统计。
  const seed = openStore(join(root, 'data', 'trace.db'));
  try {
    seed.write(db => {
      for (let group = 0; group < 100; group++) {
        for (let request = 0; request < 8; request++) {
          const conv = `synthetic-${group}`;
          const id = Number(db.run(`INSERT INTO request(conv_key,actor,actor_state,started_ms,
            day,via,body_state,derive_version,have,created_at,updated_at)
            VALUES (?,?,'known',?,'2026-10-24','hook','available',0,1,1,1)`,
          [conv, conv, request + 1]).lastInsertRowid);
          persistBodyTx(db, id, { protocol: 'anthropic',
            request: { messages: Array.from({ length: request + 1 }, (_, index) => ({
              role: 'user', content: `synthetic-${group}-${index}`, })) },
            reply: { content: [{ type: 'text', text: 'synthetic reply' }] }, redact_version: 1 });
        }
      }
    });
  } finally { seed.close(); }
  const requests: Promise<{ status: number; ms: number }>[] = [];
  for (let index = 0; index < 80; index++) {
    const envelope = makeHookEnvelope({ hookId: `perf-${index}`, session: `hook-${index}`,
      routeId: index, requestBytes: 1024, replyBytes: 128, bodyOmitted: false,
      omitReason: null, model: 'synthetic', startedMs: Date.now() });
    const started = performance.now();
    requests.push(fetch(`http://127.0.0.1:${port}/hook/ingest`, { method: 'POST',
      headers: { authorization: `Bearer ${hookToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(envelope), signal: AbortSignal.timeout(600),
    }).then(response => ({ status: response.status, ms: performance.now() - started })));
    await delay(50);
  }
  const responses = await Promise.all(requests);
  assert.ok(responses.every(response => response.status === 200), 'hook delivery failed');
  for (let index = 0; index < 100; index++) {
    if ((await metrics()).derive_queue.pending_groups === 0) break;
    await delay(100);
  }
  const final = await metrics();
  assert.equal(final.derive_queue.pending_groups, 0, 'derive backlog did not drain');
  process.stdout.write(JSON.stringify({ synthetic: true, idle_window_ms: 120_000,
    idle_writes: idleWrites, baseline_writer: before.writer, idle_writer: after.writer,
    hooks: { total: responses.length, success: responses.filter(row => row.status === 200).length,
      max_ms: Math.max(...responses.map(row => row.ms)) },
    final_writer: final.writer, derive_job: final.jobs.derive, event_loop: final.event_loop }, null, 2) + '\n');
} finally {
  if (child !== undefined) { child.kill('SIGTERM'); await child.exited; }
  await upstream.stop(true);
  rmSync(root, { recursive: true, force: true });
}
