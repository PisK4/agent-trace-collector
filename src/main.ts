import { dirname, join } from 'node:path';
import type { Config } from './config';
import { loadBoundSalt, loadLocalSecret } from './config';
import { openStore } from './store';
import { createCapacityMetrics } from './capacity';
import { intervalOf } from './config';
import type { Store } from './store';
import { readBatch, readRouteFiles } from './sources/files';
import type { FileCursor } from './sources/files';
import { ingestLedger, ingestRoute } from './reconcile';
import { probeMagpie, syncCosts } from './sources/magpie';
import { createHandler, loadReadToken } from './http';
import { reconcilePending } from './hook';
import { drainDeriveEntry, recoverSlice } from './derive-slice';
import {
  DISK_METADATA_RATIO,
  EVICT_TARGET_RATIO,
  RAW_TTL_MS,
  createAdmissionGate,
  evictOldestBodyBatch,
  measureBodyBytes,
  measureStorage,
  pruneRaw,
  resumeSourceGaps,
  shrinkStorage,
} from './retention';
import { resumePausedLedger } from './reconcile';
import { maintenanceLockPresent } from './maintenance';

const LEDGER_INTERVAL_MS = 5000;
const ROUTE_INTERVAL_MS = 2000;
const COST_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const DERIVE_INTERVAL_MS = 2000;
const RETENTION_INTERVAL_MS = 30_000;
const RAW_PRUNE_INTERVAL_MS = 60 * 60_000;

function readCursor(store: Store, sourceKind: string, sourceName: string): FileCursor | null {
  const row = store.read.query<{
    file_generation: string; committed_off: number; seen_size: number | null;
    head_len: number | null; head_hash: string | null; rewrite_epoch: number;
  }, [string, string]>(
    'SELECT file_generation, committed_off, seen_size, head_len, head_hash, rewrite_epoch FROM source_cursor WHERE source_kind=? AND source_name=?',
  ).get(sourceKind, sourceName);
  if (row == null) return null;
  const match = /^(.*):(\d+)$/.exec(row.file_generation);
  return {
    generation: row.file_generation,
    rewriteEpoch: row.rewrite_epoch,
    committedOff: row.committed_off,
    seenSize: row.seen_size ?? 0,
    headLen: row.head_len ?? 0,
    headHash: row.head_hash,
  };
}

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
    salt = loadBoundSalt(store, config.dataDir);
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
    const cursor = readCursor(store, 'ledger', 'usage.jsonl');
    const batch = await readBatch(config.ledgerPath, cursor);
    // 暂停时只记缺口、不动游标：下一轮仍从 committed_off 重读，证据不会漏。
    const admission = gate.check(batch.observedOff - batch.committedOff);
    if (admission.mode === 'paused' && batch.observedOff > batch.committedOff) {
      resumePausedLedger(store, 'usage.jsonl', batch, Date.now());
      return;
    }
    if (batch.lines.length === 0 && batch.issues.length === 0 && batch.committedOff === (cursor?.committedOff ?? 0)) {
      if (cursor !== null && batch.observedOff !== cursor.committedOff) {
        store.write(db => db.run(
          'UPDATE source_cursor SET observed_off=? WHERE source_kind=? AND source_name=?',
          [batch.observedOff, 'ledger', 'usage.jsonl'],
        ));
      }
      return;
    }
    const result = ingestLedger(store, 'usage.jsonl', batch, Date.now(), salt);
    if (result.purged_skip > 0) process.stderr.write(`purged_skip:${result.purged_skip}\n`);
  });

  const routeTick = guard('route', async () => {
    // 每轮只读一次已提交指纹：命中就不解压，也不重复 ingest。
    const cursors = new Map(
      store.read.query<{ source_name: string; fingerprint: string | null }, []>(
        "SELECT source_name, fingerprint FROM source_cursor WHERE source_kind IN ('route_file','route_gz')",
      ).all().map(row => [row.source_name, row.fingerprint] as const),
    );
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
      const kind = file.kind === 'gz' ? 'route_gz' : 'route_file';
      const now = Date.now();
      const records: unknown[] = [];
      for (const line of file.lines) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          store.write(db => db.run(
            `INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at) VALUES (?,?,?,?)
             ON CONFLICT DO UPDATE SET observed_at=excluded.observed_at`,
            ['route', JSON.stringify([file.name, file.fingerprint]), 'route_invalid_json', now],
          ));
        }
      }
      ingestRoute(store, records, now, salt);
      const committed = file.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
      store.write(db => db.run(
        `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,fingerprint,last_ok_ms)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_kind,source_name) DO UPDATE SET
           file_generation=excluded.file_generation,committed_off=excluded.committed_off,
           fingerprint=excluded.fingerprint,last_ok_ms=excluded.last_ok_ms`,
        [kind, file.name, file.fingerprint, committed, file.fingerprint, now],
      ));
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
    // 正文到了预算就收到 90%；盘占用到了 80% 也提前回收，不为空着等正文顶满。
    const usage = measureStorage(store, config.dataDir);
    const bodyFull = usage.body_bytes >= config.bodyBudget * EVICT_TARGET_RATIO;
    const diskTight = usage.total_bytes >= config.diskLimit * DISK_METADATA_RATIO;
    if (!bodyFull && !diskTight) return;
    const target = config.bodyBudget * EVICT_TARGET_RATIO;
    let evicted = 0;
    for (let batch = 0; batch < 20; batch++) {
      if (measureBodyBytes(store) <= target && evicted > 0) break;
      const result = evictOldestBodyBatch(store, Date.now());
      if (result.requests === 0) break;
      evicted += result.requests;
    }
    if (evicted > 0) {
      shrinkStorage(store);
      gate.invalidate();
      process.stderr.write(`retention_evicted:${evicted}\n`);
    }
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
