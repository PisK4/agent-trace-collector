import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Config } from './config';
import { loadBoundSaltTx, loadLocalSecret } from './config';
import { openStore } from './store';
import { createCapacityMetrics } from './capacity';
import { createDiagnosticLog, DEFAULT_SLOW_THRESHOLDS } from './monitoring';
import type { DiagnosticLog } from './monitoring';
import { intervalOf } from './config';
import type { Store } from './store';
import { readBatch, readRouteFiles } from './sources/files';
import {
  ingestSource, observeSourceOffset, readFileCursor, readRouteCursors, resumePausedLedger,
} from './reconcile';
import { syncCosts } from './sources/magpie/costs';
import { probeMagpie, saveProbe } from './sources/magpie/probe';
import { ingestDroidBatch } from './sources/droid/ingest';
import { droidSessionsRoot } from './sources/droid/discover';
import { runSessionScheduler, type SessionSchedulerState } from './sources/session/scheduler';
import { SESSION_ADAPTERS } from './sources/session/registry';
import type { SessionAdapter } from './sources/session/types';
import { createHandler, loadReadToken } from './http';
import { createLiveActivity } from './activity';
import { markHookAbsent, reconcilePending } from './hook';
import { createDeriveUnit, type DeriveCompute } from './derive/unit';
import { createDeriveWorker } from './derive/worker';
import { deriveRetryBackoffMs } from './derive/state';
import {
  RAW_TTL_MS,
  createAdmissionGate,
  type AdmissionGate,
  enforceBodyBudget,
  pruneRawBounded,
  resumeSourceGaps,
  shrinkStorage,
} from './retention';
import { maintenanceLockPresent } from './maintenance/lock';

const LEDGER_INTERVAL_MS = 5000;
const ROUTE_INTERVAL_MS = 2000;
const DROID_INTERVAL_MS = 60_000;
const SESSIONS_INTERVAL_MS = 60_000;
const COST_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const DERIVE_INTERVAL_MS = 2000;
const RETENTION_INTERVAL_MS = 30_000;
const RAW_PRUNE_INTERVAL_MS = 60 * 60_000;
/** 停止时等在飞派生落库的上限；与 `bun run service stop` 的 30 s 轮询对齐。 */
const STOP_DERIVE_WAIT_MS = 30_000;

/**
 * 切片只供显式容量实验使用。查询已接入发布代，生产启用仍等待长组容量收敛、
 * 实际切片发布后的完整读侧验收与算法切换核验；错误码保留 slice_read_unmigrated。
 *
 * `deriveComputeInWorker: false` 是任务 6 的回退开关：计算退回主线程，行为与
 * 隔离前一致，只失去事件循环的让出。
 */
export type CollectorOptions = {
  capacityExperiment?: boolean;
  deriveComputeInWorker?: boolean;
  /** 测试注入的派生计算替换；给了就优先于 Worker 或内联计算。 */
  deriveCompute?: DeriveCompute;
  /** 测试注入的停止等待上限；缺省 30 s，与 `bun run service stop` 的轮询对齐。 */
  stopDeriveWaitMs?: number;
  /** 测试注入的日志出口；缺省按启动时刻建一个写 stdout 的实例。 */
  diagnostics?: DiagnosticLog;
  /**
   * 测试注入的会话适配器与根解析。缺省用注册表与各适配器自己的环境变量：
   * 单测不能读真实主目录，注入空数组即关闭这一路。
   */
  sessionAdapters?: readonly SessionAdapter[];
  sessionRoots?: (adapter: SessionAdapter) => string[];
};

/** 当前检出的代码版本；读不到 git 时退回环境变量，再退回 unknown（不编造版本）。 */
export function codeVersion(): string {
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const result = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--short', 'HEAD']);
    if (result.exitCode === 0) {
      const version = result.stdout.toString().trim();
      if (version.length > 0) return version;
    }
  } catch {
    // 没有 git 或不在检出里：继续用环境变量兜底。
  }
  return process.env.ATC_CODE_VERSION?.trim() || 'unknown';
}

export async function startCollector(
  config: Config,
  options?: CollectorOptions,
): Promise<{ port: number; stop(): Promise<void> }> {
  const startedAt = Date.now();
  const diagnostics = options?.diagnostics ?? createDiagnosticLog({
    instance: `${process.pid}-${startedAt.toString(36)}`,
    version: codeVersion(),
  });
  diagnostics.lifecycle('service.start', { phase: 'boot' });
  // 维护命令运行时不允许采集器起来：两边同时写会得到自相矛盾的快照。
  // 陈旧锁不在这里自动清：把路径原样报出来，由操作者确认后删除。
  const heldLock = maintenanceLockPresent(config.dataDir);
  if (heldLock !== null) throw new Error(`maintenance_lock_present:${heldLock}`);
  if (config.deriveBudget !== undefined && options?.capacityExperiment !== true) {
    throw new Error('slice_read_unmigrated');
  }
  const dbPath = join(config.dataDir, 'trace.db');
  const store = openStore(dbPath, {
    // 具名写事务的耗时由调用方定阈值；这里只负责把名字与毫秒交出去。
    onWrite: (name, ms) => diagnostics.slow('write', { phase: name, dur_ms: ms }),
  });
  // 计算线程要等库的 WAL 文件落下来才打得开只读连接；openStore 已经做过那一步。
  const deriveWorker = options?.deriveComputeInWorker === false ? null
    : createDeriveWorker(store.path, {
      onFailure: code => diagnostics.error('derive.worker', { code }),
    });
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
  // OTLP 令牌与 hook 令牌各自独立：一份密钥不进两份上游配置。
  const otlpToken = Buffer.from(loadLocalSecret(config.dataDir, 'otlp.token')).toString('base64url');
  // 观测只依赖进程：拒绝计数、写事务、事件循环样本与派生读取计数都从启动时刻重新开始。
  let gate: AdmissionGate;
  const metrics = createCapacityMetrics(store, config.dataDir, startedAt, {
    instance: diagnostics.instance,
    // 轻量指标里的存储值直接复用闸门最近一次量测，避免每次采样都全表求和。
    admission: () => gate.last(),
  });
  metrics.eventLoop.start();
  const deriveUnit = createDeriveUnit(store, {
    onBodyRead: stats => metrics.bodyRead.record(stats),
    // 计算段交给 Worker：主线程只跑落库段，事件循环不再被长组的读与计算占住。
    compute: options?.deriveCompute ?? (deriveWorker === null ? undefined : deriveWorker.compute),
    // 计算与落库用同一个关联编号；空闲 tick 不进这里。
    onRound: event => {
      diagnostics.derive({
        corr: event.corr, result: event.result, phase: event.phase, dur_ms: event.stage_ms,
        compute_ms: event.compute_ms, apply_ms: event.apply_ms, code: event.code,
      });
      // 轮失败同时进 kind:"error"：巡检按错误计数找 Worker 失败，只翻 derive
      // 结果流会漏掉整轮被丢弃的事实（F11）。
      if (event.result === 'failure' && event.code !== undefined) {
        diagnostics.error('derive.run', { code: event.code, corr: event.corr });
      }
      if (event.compute_ms !== undefined) {
        diagnostics.slow('derive.compute', {
          corr: event.corr, phase: 'compute', dur_ms: event.compute_ms,
        }, DEFAULT_SLOW_THRESHOLDS.workerMs);
      }
    },
  });
  // 准入闸门在每个写入点共用：模式变了才落库，量测按 TTL 缓存。
  gate = createAdmissionGate(store, config.dataDir, {
    bodyBudget: config.bodyBudget,
    diskLimit: config.diskLimit,
  }, {
    onMeasure: ms => {
      metrics.storage.measure.record(ms);
      diagnostics.slow('storage.measure', { dur_ms: ms });
    },
  });
  // 在途请求的内存态：启动时只恢复最近 60 秒有界窗口，之后靠摄入回调增量更新。
  const live = createLiveActivity();
  live.bootstrap(store);
  let handler: (req: Request) => Promise<Response> = () => Promise.resolve(new Response('starting', { status: 503 }));

  const timers: ReturnType<typeof setInterval>[] = [];
  let deriveTimer: ReturnType<typeof setTimeout> | undefined;
  let deriveFailureStreak = 0;
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
      diagnostics.error(name, { code: error, phase: 'task', dur_ms: performance.now() - started });
    } finally {
      metrics.jobs.record(name, performance.now() - started);
      running.delete(name);
    }
  };

  const ledgerTick = guard('ledger', async () => {
    const cursor = readFileCursor(store, 'ledger', 'usage.jsonl');
    const batch = await readBatch(config.ledgerPath, cursor, { kind: 'ledger', name: 'usage.jsonl' });
    // 暂停时只记缺口、不动游标：下一轮仍从 committed_off 重读，证据不会漏。
    const admission = gate.check(batch.observedOff - batch.committedOff);
    if (admission.mode === 'paused' && batch.observedOff > batch.committedOff) {
      resumePausedLedger(store, 'usage.jsonl', batch, Date.now());
      return;
    }
    if (batch.lines.length === 0 && batch.issues.length === 0 && batch.committedOff === (cursor?.committedOff ?? 0)) {
      if (cursor !== null && batch.generation === cursor.generation && batch.observedOff > cursor.observedOff) {
        observeSourceOffset(store, 'ledger', 'usage.jsonl', batch.observedOff);
      }
      return;
    }
    const result = ingestSource(store, batch, salt, Date.now(), ids => live.observe(store, ids));
    if (result.purged_skip > 0) process.stderr.write(`purged_skip:${result.purged_skip}\n`);
  });

  const routeTick = guard('route', async () => {
    // 每轮只读一次游标：`.gz` 命中指纹就跳过解压，`.jsonl` 从已提交偏移继续。
    const cursors = readRouteCursors(store);
    const files = await readRouteFiles(config.routingDir, cursors);
    metrics.route.record({
      files: files.length,
      decoded: files.filter(file => file.state === 'decoded').length,
      unchanged: files.filter(file => file.state === 'unchanged').length,
      errors: files.filter(file => file.state === 'error').length,
    });
    for (const file of files) {
      if (file.state !== 'decoded') {
        if (file.state === 'error') diagnostics.error('route.file', { code: 'route_file_error', phase: 'decode' });
        continue;
      }
      ingestSource(store, file, salt, Date.now(), ids => live.observe(store, ids));
    }
  });

  // droid 转录是追加文件：每轮按剩余字节取一批，未读完的下一轮继续。
  const droidRoot = droidSessionsRoot();
  const droidTick = guard('droid', async () => {
    await ingestDroidBatch(store, droidRoot, salt, Date.now());
  });

  // 所有适配器每分钟发现一次；活跃文件走 live 小预算，历史积压轮转回填。
  const sessionAdapters = options?.sessionAdapters ?? SESSION_ADAPTERS;
  const sessionState: SessionSchedulerState = { backfillCursor: 0 };
  const sessionsTick = guard('sessions', async () => {
    await runSessionScheduler(
      store,
      sessionAdapters,
      adapter => options?.sessionRoots?.(adapter) ?? adapter.roots(process.env, homedir()),
      salt,
      Date.now(),
      sessionState,
    );
  });

  const costTick = guard('cost', async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await syncCosts(store, `${day}..${day}`, config.magpieUrl, Date.now(), salt);
  });

  const probeTick = guard('probe', async () => {
    const versionFile = join(dirname(config.ledgerPath), 'last-version');
    const result = await probeMagpie(config.magpieUrl, versionFile);
    saveProbe(store, result, Date.now());
  });

  const pendingTick = guard('pending', () => {
    const now = Date.now();
    reconcilePending(store, now);
    const marked = markHookAbsent(store, now);
    if (marked > 0) process.stderr.write(`hook_absent_marked:${marked}\n`);
  });

  const retentionTick = guard('retention', () => {
    const evicted = enforceBodyBudget(store, config.dataDir, {
      bodyBudget: config.bodyBudget,
      diskLimit: config.diskLimit,
    }, { invalidate: () => gate.invalidate() });
    if (evicted > 0) process.stderr.write(`retention_evicted:${evicted}\n`);
  });

  const rawPruneTick = guard('raw_prune', async () => {
    const now = Date.now();
    const pruned = await pruneRawBounded(store, now - RAW_TTL_MS);
    if (pruned.ledger + pruned.route + pruned.hook + pruned.otlpSpan + pruned.otlpLog
      + pruned.session > 0) shrinkStorage(store);
  });

  const gapTick = guard('gap', () => {
    const result = resumeSourceGaps(store, 'usage.jsonl');
    if (result.unrecoverable > 0) process.stderr.write(`source_gap_unrecoverable:${result.unrecoverable}\n`);
  });

  // 停止要等当前组落盘：计算在 Worker 里，落库在 await 之后，中间是一个让出点。
  let deriveLanded: Promise<void> | null = null;
  const deriveTick = guard('derive', async () => {
    let nextDueMs = intervalOf(config, 'derive', DERIVE_INTERVAL_MS);
    try {
      const result = await deriveUnit.run({ budgetMs: 400 });
      deriveFailureStreak = 0;
      if (result.nextDueMs === 0) nextDueMs = 0;
    } catch (error) {
      // 整轮失败按指数退避再试（2s 起步、60s 封顶），永久失败的组不再每 2 秒
      // 空转；失败原因在 derive_queue.last_error，丢弃判据见 derive/state.ts。
      deriveFailureStreak += 1;
      nextDueMs = Math.max(nextDueMs, deriveRetryBackoffMs(deriveFailureStreak));
      throw error;
    } finally {
      if (!stopped) deriveTimer = setTimeout(trackedDeriveTick, nextDueMs);
    }
  });
  function trackedDeriveTick(): Promise<void> {
    const pending = deriveTick();
    deriveLanded = pending;
    return pending;
  }

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
  }, metrics, {
    token: otlpToken,
    salt,
    admission: () => gate.check(0),
  }, diagnostics, live);

  timers.push(setInterval(ledgerTick, intervalOf(config, 'ledger', LEDGER_INTERVAL_MS)));
  timers.push(setInterval(routeTick, intervalOf(config, 'route', ROUTE_INTERVAL_MS)));
  timers.push(setInterval(droidTick, intervalOf(config, 'droid', DROID_INTERVAL_MS)));
  timers.push(setInterval(sessionsTick, intervalOf(config, 'sessions', SESSIONS_INTERVAL_MS)));
  timers.push(setInterval(costTick, intervalOf(config, 'cost', COST_INTERVAL_MS)));
  timers.push(setInterval(probeTick, intervalOf(config, 'probe', PROBE_INTERVAL_MS)));
  timers.push(setInterval(pendingTick, intervalOf(config, 'pending', LEDGER_INTERVAL_MS)));
  timers.push(setInterval(retentionTick, intervalOf(config, 'retention', RETENTION_INTERVAL_MS)));
  timers.push(setInterval(rawPruneTick, intervalOf(config, 'rawPrune', RAW_PRUNE_INTERVAL_MS)));
  timers.push(setInterval(gapTick, intervalOf(config, 'gap', LEDGER_INTERVAL_MS)));
  void ledgerTick();
  void routeTick();
  void probeTick();
  void pendingTick();
  void trackedDeriveTick();
  void gapTick();
  // 启动时就评估一次：上一个进程可能是在暂停状态下退出的，不必等一个周期。
  void retentionTick();
  // 监听已起来，第一轮会话扫描异步跑，不挡页面读已有库。
  void sessionsTick();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const stopStarted = performance.now();
    for (const timer of timers) clearInterval(timer);
    clearTimeout(deriveTimer);
    metrics.eventLoop.stop();
    // 等在飞的那一轮派生走完落库段再关：计算在 Worker 里，此时也只是拒绝新请求。
    // 上限只包这里的等待，不砍 deriveUnit.run 的计算预算：正常大组派生可能超过
    // 30 s，超时只是不再等、不取消在飞的计算。上限与 service stop 的 30 s 轮询
    // 对齐，超出后进程仍会自己退出，不再依赖 launchd 补 SIGKILL。
    const waitCapMs = options?.stopDeriveWaitMs ?? STOP_DERIVE_WAIT_MS;
    if (deriveLanded !== null) {
      let cap: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        deriveLanded,
        new Promise<void>(resolve => { cap = setTimeout(resolve, waitCapMs); }),
      ]).finally(() => clearTimeout(cap));
    }
    // 计算线程随后终止，再关库：不留 Worker 在库关掉后继续读。
    deriveWorker?.close();
    await server.stop(true);
    store.close();
    diagnostics.lifecycle('service.stop', {
      phase: 'shutdown', dur_ms: performance.now() - stopStarted,
    });
  };

  const onSignal = () => {
    // 停止失败也要退出：停在半关状态会让 launchd 以为服务还在，直到 SIGKILL。
    void stop().then(() => process.exit(0)).catch(error => {
      process.stderr.write(`${JSON.stringify({ op: 'service.stop', phase: 'error', code: String(error) })}\n`);
      process.exit(1);
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { port: boundPort, stop };
}

if (import.meta.main) {
  const { loadConfig } = await import('./config');
  const { startupBanner } = await import('./banner');
  const config = loadConfig();
  const collector = await startCollector(config);
  // 横幅只上屏，不碰 `collector_listening`：容量脚本按这一行解析端口。
  process.stdout.write(startupBanner({ ...config, port: collector.port }, process.stdout.isTTY === true));
  process.stdout.write(`collector_listening:${collector.port}\n`);
}
