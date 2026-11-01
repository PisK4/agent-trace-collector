/**
 * 读取架构的合成性能验收：临时库 + 真 HTTP 往返 + 真实客户端读取链
 * （reader-store → trace-preparation → trace-model → 投影），统计「打开会话
 * 并准备整个窗口」的请求数、响应字节与耗时，以及中途取消的读取量。
 *
 * 无 DOM、无 location、无全局 fetch 依赖：Bun 进程内完成，fetch 由脚本
 * 注入 transport。这是显式动作，不进测试套件；输出供验收记录引用。
 *
 *   bun scripts/perf-reader.ts --requests 30
 *   bun scripts/perf-reader.ts --requests 364 --reps 2
 *   bun scripts/perf-reader.ts --requests 2500 --messages 6
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store';
import { createHandler } from '../src/http';
import { seedChain } from '../tests/fixtures';
import { createHttpReadTransport } from '../web/read-http.js';
import { createReaderStore } from '../web/reader-store.js';
import { createTracePreparation } from '../web/trace-preparation.js';
import { createTraceModel } from '../web/trace-model.js';
import { projectSteps, projectTailReply } from '../web/trace-view.js';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid --${name}`);
  return Math.trunc(value);
}

const requests = arg('requests', 364);
const messages = arg('messages', 8);
const reps = arg('reps', 2);

const dir = mkdtempSync(join(tmpdir(), 'atc-perf-reader-'));
const store = openStore(join(dir, 'perf.db'));
const seedStarted = performance.now();
seedChain(store, Array.from({ length: requests }, (_, index) => ({
  texts: Array.from({ length: messages }, (_, m) => `合成消息 ${index}/${m}`),
})), { convKey: 'perf-reader', actor: 'actor-perf' });
console.log(`seed: ${requests} requests × ${messages} messages, ${Math.round(performance.now() - seedStarted)} ms`);

/** fetch 包装：统计次数与响应字节，不落正文。 */
let fetchCount = 0;
let bytes = 0;
const byteFetcher = async (url: string, init?: RequestInit) => {
  fetchCount += 1;
  const response = await fetch(url, init);
  const body = await response.arrayBuffer();
  bytes += body.byteLength;
  return new Response(body, { status: response.status, headers: response.headers });
};

const config = {
  dataDir: dir, port: 0, ledgerPath: join(dir, 'ledger'), routingDir: join(dir, 'routes'),
  magpieUrl: 'http://127.0.0.1:9', bodyBudget: 1 << 20, diskLimit: 1 << 30, gatewayTimeoutMs: 5_000,
};
// 端口在 serve 后才知道：handler 闭包读 config.port，先占位再回填。
const handler = createHandler(store, config as never, 'perf-token');
const server = Bun.serve({ port: 0, fetch: req => handler(req) });
config.port = server.port as number;
const baseUrl = `http://127.0.0.1:${server.port}`;

/** 一轮「打开会话并准备整个窗口」：真实客户端链路，统计请求数、字节与耗时。 */
async function runOnce(label: string): Promise<void> {
  fetchCount = 0;
  bytes = 0;
  const transport = createHttpReadTransport({
    fetcher: byteFetcher,
    baseUrl,
    headers: () => ({ origin: baseUrl }),
  });
  const reader = createReaderStore(transport, () => {}, {});
  const preparation = createTracePreparation(reader, () => {});
  const traceModel = createTraceModel({
    project: (row, read) => projectSteps(row, read),
    projectTail: (row, read) => projectTailReply(row, read),
    preparing: row => ({
      key: `${row.req_id}:preparing`, reqId: row.req_id, kind: 'record', text: '正在读取请求…',
    }) as never,
  });
  const started = performance.now();
  await reader.selectSession('perf-reader');
  const afterWindow = performance.now();
  const ok = await preparation.prepareWindow(null);
  const afterPrepare = performance.now();
  const rows = reader.getWindow().requests;
  const reads = new Map();
  const ready = new Set<number>();
  for (const row of rows) {
    reads.set(row.req_id, reader.peekRequest(row.req_id));
    if (preparation.has(row.req_id)) ready.add(row.req_id);
  }
  traceModel.update({ rows, reads, ready, bgJobs: [], complete: true, changedIds: [...ready] });
  const afterModel = performance.now();
  const projected = rows.filter(row => {
    const view = traceModel.get(row.req_id);
    return view !== null && !view.placeholder && view.stale === null;
  }).length;
  const fallbacks = reader.batchFallbackCount();
  console.log(`${label}: ok=${ok} window=${rows.length} projected=${projected}`
    + ` fetches=${fetchCount} bytes=${bytes}`
    + ` total=${Math.round(afterPrepare - started)}ms`
    + ` windowLoad=${Math.round(afterWindow - started)}ms prepare=${Math.round(afterPrepare - afterWindow)}ms`
    + ` model=${Math.round(afterModel - afterPrepare)}ms oversizedFallbacks=${fallbacks}`);
  reader.dispose();
}

for (let rep = 1; rep <= reps; rep += 1) {
  await runOnce(`rep${rep}`);
}

/** 取消：窗口准备发起后同步 dispose。本机回环太快，抓不到在途——
 *  fetcher 注入固定延迟模拟真实网络，验证取消截断后续读取。 */
{
  fetchCount = 0;
  const slowFetcher = async (url: string, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
    });
    return byteFetcher(url, init);
  };
  const transport = createHttpReadTransport({
    fetcher: slowFetcher, baseUrl, headers: () => ({ origin: baseUrl }),
  });
  const reader = createReaderStore(transport, () => {}, {});
  const preparation = createTracePreparation(reader, () => {});
  await reader.selectSession('perf-reader');
  const pending = preparation.prepareWindow(null);
  reader.dispose();
  const outcome = await pending.then(() => 'completed', () => 'cancelled');
  console.log(`cancel: outcome=${outcome} fetchesBeforeCancel=${fetchCount}`);
}

/** 完整加载：连续 loadLater 耗尽游标，统计累计请求数与总耗时（2500 笔验收口径）。 */
{
  fetchCount = 0;
  bytes = 0;
  const transport = createHttpReadTransport({
    fetcher: byteFetcher, baseUrl, headers: () => ({ origin: baseUrl }),
  });
  const reader = createReaderStore(transport, () => {}, {});
  const preparation = createTracePreparation(reader, () => {});
  const traceModel = createTraceModel({
    project: (row, read) => projectSteps(row, read),
    projectTail: (row, read) => projectTailReply(row, read),
    preparing: row => ({
      key: `${row.req_id}:preparing`, reqId: row.req_id, kind: 'record', text: '正在读取请求…',
    }) as never,
  });
  const started = performance.now();
  await reader.selectSession('perf-reader');
  let rounds = 0;
  for (;;) {
    const window = reader.getWindow();
    const rows = window.requests;
    const reads = new Map();
    const ready = new Set<number>();
    for (const row of rows) {
      reads.set(row.req_id, reader.peekRequest(row.req_id));
      if (preparation.has(row.req_id)) ready.add(row.req_id);
    }
    traceModel.update({ rows, reads, ready, bgJobs: [], complete: window.newerCursor === null, changedIds: [] });
    if (window.newerCursor === null || window.loading) break;
    await reader.loadLater();
    await preparation.prepareWindow(null);
    rounds += 1;
  }
  const total = performance.now() - started;
  console.log(`fullLoad: rows=${reader.getWindow().requests.length} rounds=${rounds}`
    + ` fetches=${fetchCount} bytes=${bytes} total=${Math.round(total)}ms`);
  reader.dispose();
}

server.stop(true);
store.close();
rmSync(dir, { recursive: true, force: true });
