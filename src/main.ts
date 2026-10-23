import { dirname, join } from 'node:path';
import type { Config } from './config';
import { loadBoundSaltTx, loadLocalSecret } from './config';
import { openStore } from './store';
import { createCapacityMetrics } from './capacity';
import { intervalOf } from './config';
import type { Store } from './store';
import { readBatch, readRouteFiles } from './sources/files';
import { ingestLedger, resumePausedLedger } from './reconcile';
import {
  committedRouteFingerprints, ingestDecodedRouteFile, observeSourceOffset, readFileCursor,
} from './reconcile';
import { probeMagpie, syncCosts } from './sources/magpie';
import { createHandler, loadReadToken } from './http';
import { reconcilePending } from './hook';
import { drainDeriveEntry, recoverSlice } from './derive-slice';
import {
  RAW_TTL_MS,
  createAdmissionGate,
  enforceBodyBudget,
  pruneRaw,
  resumeSourceGaps,
  shrinkStorage,
} from './retention';
import { maintenanceLockPresent } from './maintenance';

const LEDGER_INTERVAL_MS = 5000;
const ROUTE_INTERVAL_MS = 2000;
const COST_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const DERIVE_INTERVAL_MS = 2000;
const RETENTION_INTERVAL_MS = 30_000;
const RAW_PRUNE_INTERVAL_MS = 60 * 60_000;

export async function startCollector(config: Config): Promise<{ port: number; stop(): Promise<void> }> {
  // 维护命令运行时不允许采集器起来：两边同时写会得到自相矛盾的快照。
  // 陈旧锁不在这里自动清：把路径原样报出来，由操作者确认后删除。
  const heldLock = maintenanceLockPresent(config.dataDir);
  if (heldLock !== null) throw new Error(`maintenance_lock_present:${heldLock}`);
  const dbPath = join(config.dataDir, 'trace.db');
  const store = openStore(dbPath);
  // 派生路径按配置定下来，定时器之前就设好：一旦有派生任务进来，模式和预算都
  // 必须是已确定的，不能"先按同步跑一会儿再切"。
  if (config.deriveBudget !== undefined) {
    store.deriveRuntime = {
      budget: config.deriveBudget,
      dataDir: config.dataDir,
      dbPath: store.path,
    };
  }
  // 盐与库必须配对：有数据却没有绑定、或盐文件与绑定不符时，采集器不能起来。
  // 失败要在这里关掉库，否则调用方重试会撞上一个已打开的写连接。
  let salt: Uint8Array;
  try {
    salt = store.write(db => loadBoundSaltTx(db, config.dataDir));
  } catch (error) {
    store.close();
    throw error;
  }
  const readToken = loadReadToken(config.dataDir);
  const hookToken = Buffer.from(loadLocalSecret(config.dataDir, 'hook.token')).toString('base64url');
  // 上一轮没发布完的派生代没有读者：在起定时器和 handler 之前丢弃它们，
  // 否则下一次认领会把半套结果当成可续跑的目标。
  recoverSlice(store.db, Date.now());
  // 观测只依赖进程：拒绝计数、写事务与事件循环样本都从启动时刻重新开始。
  const metrics = createCapacityMetrics(store, config.dataDir, Date.now());
  metrics.eventLoop.start();
  // 准入闸门在每个写入点共用：模式变了才落库，量测按 TTL 缓存。
  const gate = createAdmissionGate(store, config.dataDir, {
    bodyBudget: config.bodyBudget,
    diskLimit: config.diskLimit,
  });
  let handler: (req: Request) => Promise<Response> = () => Promise.resolve(new Response('starting', { status: 503 }));

  const timers: ReturnType<typeof setInterval>[] = [];
  const running = new Set<string>();
  let stopped = false;

  /**
   * 每个任务各自防重入，不用一个全局锁。
   *
   * 全局锁会让启动时连续调用的几个 tick 只有第一个真正执行，其余被静默跳过；
   * 而写操作都在同步的 store.write 事务里完成，不会真正并行，按任务名加锁就够了。
   */
  const guard = (name: string, task: () => Promise<void> | void) => async () => {
    if (stopped || running.has(name)) return;
    running.add(name);
    const started = performance.now();
    try {
      await task();
    } catch (error) {
      // 停止过程中关闭数据库会让在途的异步任务失败；那不是采集故障，不该写进日志。
      if (stopped) return;
      const code = error instanceof Error ? error.message : 'unknown';
      process.stderr.write(`${name}_failed:${code}\n`);
    } finally {
      metrics.jobs.record(name, performance.now() - started);
      running.delete(name);
    }
  };

  const ledgerTick = guard('ledger', async () => {
    const cursor = readFileCursor(store, 'ledger', 'usage.jsonl');
    const batch = await readBatch(config.ledgerPath, cursor);
    // 暂停时只记缺口、不动游标：下一轮仍从 committed_off 重读，证据不会漏。
    const admission = gate.check(batch.observedOff - batch.committedOff);
    if (admission.mode === 'paused' && batch.observedOff > batch.committedOff) {
      resumePausedLedger(store, 'usage.jsonl', batch, Date.now());
      return;
    }
    if (batch.lines.length === 0 && batch.issues.length === 0 && batch.committedOff === (cursor?.committedOff ?? 0)) {
      if (cursor !== null && batch.observedOff !== cursor.committedOff) {
        observeSourceOffset(store, 'ledger', 'usage.jsonl', batch.observedOff);
      }
      return;
    }
    const result = ingestLedger(store, 'usage.jsonl', batch, Date.now(), salt);
    if (result.purged_skip > 0) process.stderr.write(`purged_skip:${result.purged_skip}\n`);
  });

  const routeTick = guard('route', async () => {
    // 每轮只读一次已提交指纹：命中就不解压，也不重复 ingest。
    const cursors = committedRouteFingerprints(store);
    const files = await readRouteFiles(
      config.routingDir,
      (name, fingerprint) => cursors.get(name) === fingerprint,
    );
    metrics.route.record({
      files: files.length,
      decoded: files.filter(file => file.state === 'decoded').length,
      unchanged: files.filter(file => file.state === 'unchanged').length,
      errors: files.filter(file => file.state === 'error').length,
    });
    for (const file of files) {
      if (file.state !== 'decoded') {
        if (file.state === 'error') process.stderr.write(`route_file_error:${file.name}:${file.error}\n`);
        continue;
      }
      ingestDecodedRouteFile(store, file, salt, Date.now());
    }
  });

  const costTick = guard('cost', async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await syncCosts(store, `${day}..${day}`, config.magpieUrl, Date.now(), salt);
  });

  const probeTick = guard('probe', async () => {
    const versionFile = join(dirname(config.ledgerPath), 'last-version');
    const result = await probeMagpie(config.magpieUrl, versionFile);
    store.write(db => db.run(
      'INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
      [JSON.stringify(['magpie', 'probe']), JSON.stringify({ ...result, at: Date.now() })],
    ));
  });

  const pendingTick = guard('pending', () => {
    reconcilePending(store, Date.now());
  });

  const retentionTick = guard('retention', () => {
    const evicted = enforceBodyBudget(store, config.dataDir, {
      bodyBudget: config.bodyBudget,
      diskLimit: config.diskLimit,
    }, { invalidate: () => gate.invalidate() });
    if (evicted > 0) process.stderr.write(`retention_evicted:${evicted}\n`);
  });

  const rawPruneTick = guard('raw_prune', () => {
    const now = Date.now();
    const pruned = pruneRaw(store, now - RAW_TTL_MS);
    if (pruned.ledger + pruned.route + pruned.hook > 0) shrinkStorage(store);
  });

  const gapTick = guard('gap', () => {
    const result = resumeSourceGaps(store, 'usage.jsonl');
    if (result.unrecoverable > 0) process.stderr.write(`source_gap_unrecoverable:${result.unrecoverable}\n`);
  });

  const deriveTick = guard('derive', () => {
    drainDeriveEntry(store);
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    fetch: (req: Request) => handler(req),
  });
  const boundPort = server.port ?? config.port;
  handler = createHandler(store, { ...config, port: boundPort }, readToken, {
    token: hookToken,
    salt,
    admission: () => gate.check(0),
  }, metrics);

  timers.push(setInterval(ledgerTick, intervalOf(config, 'ledger', LEDGER_INTERVAL_MS)));
  timers.push(setInterval(routeTick, intervalOf(config, 'route', ROUTE_INTERVAL_MS)));
  timers.push(setInterval(costTick, intervalOf(config, 'cost', COST_INTERVAL_MS)));
  timers.push(setInterval(probeTick, intervalOf(config, 'probe', PROBE_INTERVAL_MS)));
  timers.push(setInterval(pendingTick, intervalOf(config, 'pending', LEDGER_INTERVAL_MS)));
  timers.push(setInterval(deriveTick, intervalOf(config, 'derive', DERIVE_INTERVAL_MS)));
  timers.push(setInterval(retentionTick, intervalOf(config, 'retention', RETENTION_INTERVAL_MS)));
  timers.push(setInterval(rawPruneTick, intervalOf(config, 'rawPrune', RAW_PRUNE_INTERVAL_MS)));
  timers.push(setInterval(gapTick, intervalOf(config, 'gap', LEDGER_INTERVAL_MS)));
  void ledgerTick();
  void routeTick();
  void probeTick();
  void pendingTick();
  void deriveTick();
  void gapTick();
  // 启动时就评估一次：上一个进程可能是在暂停状态下退出的，不必等一个周期。
  void retentionTick();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    metrics.eventLoop.stop();
    await server.stop(true);
    store.close();
  };

  const onSignal = () => {
    void stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { port: boundPort, stop };
}

if (import.meta.main) {
  const { loadConfig } = await import('./config');
  const config = loadConfig();
  const collector = await startCollector(config);
  process.stdout.write(`collector_listening:${collector.port}\n`);
}
