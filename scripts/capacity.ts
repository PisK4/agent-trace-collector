/**
 * 容量负载驱动。
 *
 * 每个场景都只使用 `mkdtempSync(join(tmpdir(), 'atc-capacity-'))` 创建的新根、
 * 回环端口与合成正文；采集器在子进程里启动，负载端与它不共享事件循环。
 * 报告只写观测值与固定原因码，不写请求正文、令牌或真实路径。
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCapacityMetrics, queueSnapshot, summarizeDurations } from '../src/capacity';
import type { CapacityMetrics, DurationSummary } from '../src/capacity';
import { persistBodyTx } from '../src/body';
import type { Config } from '../src/config';
import { drainDeriveTx, enqueueDeriveTx, rebuildDerived } from '../src/derive';
import { drainDeriveEntry } from '../src/derive-slice';
import type { SliceRuntime } from '../src/derive-slice';
import { PAGE_MAX } from '../src/protocols';
import type { StorageUsage } from '../src/retention';
import { openStore } from '../src/store';
import type { Store } from '../src/store';
import {
  createFakeUpstream, makeHookEnvelope, makeLedgerLine, makeMessages, makeReply,
  makeRouteLine, waitForCollector,
} from './capacity-support';
import {
  deriveBudget, loadSliceBudget, loadSummary, sha256File,
} from './capacity-gate';
import type {
  CapacityBudget, ScenarioReport, ScenarioSummary, SliceBudgetReading, StorageReading,
} from './capacity-gate';

export type ScenarioName =
  | 'smoke' | 'baseline-1rps' | 'baseline-5rps' | 'burst'
  | 'long' | 'long-10000-slice' | 'route' | 'retention' | 'all' | 'budget' | 'calibrate';

export type PlanOptions = {
  full: boolean; requests?: number; acknowledgeLongRun?: boolean;
  durationMs?: number; rps?: number;
};

export type ScenarioPlan = {
  durationMs: number; rps: number; bodyMix: readonly number[];
  concurrency: number; requestBytes: number; replyBytes: number[];
  sessions: number; readerIntervalMs: number; requests?: number;
};

/**
 * 场景参数矩阵。默认 10 秒；只有 `--full` 才启用 600 秒，且必须显式确认长跑。
 * 所有入口都从这里取参数，测试不需要启动负载。
 */
export function scenarioPlan(name: ScenarioName, options: PlanOptions): ScenarioPlan {
  const long = options.full ? 600_000 : 10_000;
  if (options.full && options.acknowledgeLongRun !== true) {
    throw new Error('capacity_long_run_not_acknowledged');
  }
  switch (name) {
    case 'smoke':
      return { durationMs: options.durationMs ?? 5_000, rps: options.rps ?? 2, bodyMix: [64 * 1024], concurrency: 1, requestBytes: 64 * 1024, replyBytes: [1024], sessions: 2, readerIntervalMs: 500 };
    case 'baseline-1rps':
      return { durationMs: options.durationMs ?? long, rps: 1, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024, 64 * 1024], sessions: 20, readerIntervalMs: 500 };
    case 'baseline-5rps':
      return { durationMs: options.durationMs ?? long, rps: 5, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 4, requestBytes: 0, replyBytes: [1024, 64 * 1024], sessions: 20, readerIntervalMs: 500 };
    case 'burst':
      return { durationMs: options.durationMs ?? 30_000, rps: 0, bodyMix: [4 * 1024 * 1024], concurrency: 10, requestBytes: 4 * 1024 * 1024, replyBytes: [1024, 64 * 1024, 512 * 1024, 2 * 1024 * 1024], sessions: 4, readerIntervalMs: 500 };
    case 'long': {
      const requests = options.requests ?? 2_000;
      // 10,000 笔是本轮最重的单进程场景，和 10 分钟基线一样要显式确认。
      if (requests >= LONG_REQUESTS && options.acknowledgeLongRun !== true) {
        throw new Error('capacity_long_run_not_acknowledged');
      }
      return { durationMs: 0, rps: 0, bodyMix: [], concurrency: 1, requestBytes: 0, replyBytes: [256], sessions: 1, readerIntervalMs: 0, requests };
    }
    case 'long-10000-slice':
      // 输入与 `long-10000` 逐字相同：同一个单会话、同一批 10,000 笔；差别只在排空入口。
      // 笔数固定，`--requests` 给别的数就直接拒绝——换掉输入就不是同一次对比了。
      if (options.requests !== undefined && options.requests !== LONG_REQUESTS) {
        throw new Error('capacity_invalid_requests');
      }
      return scenarioPlan('long', { ...options, requests: LONG_REQUESTS });
    case 'route':
      return { durationMs: options.durationMs ?? 30_000, rps: 1, bodyMix: [64 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024], sessions: 2, readerIntervalMs: 500 };
    case 'retention':
      return { durationMs: options.durationMs ?? 120_000, rps: options.rps ?? 1, bodyMix: [2 * 1024 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024], sessions: 4, readerIntervalMs: 500 };
    default:
      throw new Error('capacity_scenario_requires_subcommand');
  }
}

/**
 * 计划在 `durationMs` 里到点的刻度数。负载端按这个数发请求，
 * 少发的部分必须出现在报告里，不能被"等响应再睡"悄悄吞掉。
 */
export function scheduledTicks(durationMs: number, rps: number): number {
  if (!(durationMs > 0) || !(rps > 0)) return 0;
  return Math.ceil((durationMs * rps) / 1_000);
}

/** 计划速率没被真正发出去时的缺口标记：守恒为真只说明发出去的那部分收敛了。 */
export function offeredShortfall(client: {
  launched: number; ticks_scheduled: number; ticks_dropped: number;
}): string[] {
  return client.ticks_dropped > 0
    ? [`offered:${client.launched}<${client.ticks_scheduled}`]
    : [];
}

/**
 * 收敛读数与终值快照必须互相印证。收敛判定要求连续静默一个窗口，
 * 快照里却仍有脏组，说明停输入之后又插进了请求：那一刻的请求行数还会变，
 * 报告不能按"已收敛"记，否则冻结出来的阈值建在一个会动的数上。
 */
export function finalQueueMissing(snapshot: { derive_queue: { pending_groups: number } }): string[] {
  const pending = snapshot.derive_queue.pending_groups;
  return pending === 0 ? [] : [`pending_groups_final:${pending}!=0`];
}

export type Args = {
  scenario: ScenarioName;
  full: boolean;
  acknowledgeLongRun: boolean;
  durationMs?: number;
  rps?: number;
  requests?: number;
  seed: number;
  report: string;
  /** `budget` 子命令的落盘位置；其余场景只写 `--report`。 */
  out?: string;
  bodyBudget: number;
  /** 用户显式给出 `--body-budget` 时，场景不能再用自己的默认值覆盖。 */
  bodyBudgetExplicit: boolean;
  diskLimit: number;
  /** 切片场景的预算文件；只有 `long-10000-slice` 接受它，缺了就是缺切片预算。 */
  sliceBudget?: string;
};

const SCENARIOS: readonly ScenarioName[] = [
  'smoke', 'baseline-1rps', 'baseline-5rps', 'burst',
  'long', 'long-10000-slice', 'route', 'retention', 'all', 'budget', 'calibrate',
];

const MIB = 1024 * 1024;
const MAX_DURATION_MS = 600_000;
const LONG_REQUESTS = 10_000;
const MAX_RPS = 50;
const MAX_REQUESTS = 20_000;

function integerFlag(
  name: string, raw: string | undefined, fallback: number, min: number, max: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`capacity_invalid_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`capacity_invalid_${name}`);
  }
  return value;
}

function stringFlag(raw: string | undefined, flag: string): string {
  if (raw === undefined || raw.length === 0) throw new Error(`capacity_flag_value_missing:${flag}`);
  return raw;
}

/** 只接受计划里列出的标志；数值都有上界，避免把真实流量参数误带进实验。 */
export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let scenario: ScenarioName | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      if (!SCENARIOS.includes(arg as ScenarioName)) throw new Error(`capacity_unknown_scenario:${arg}`);
      scenario = arg as ScenarioName;
      continue;
    }
    const readValue = (): string => {
      index += 1;
      return stringFlag(argv[index], arg);
    };
    switch (arg) {
      case '--full':
        flags.add('full');
        break;
      case '--acknowledge-long-run':
        flags.add('acknowledge');
        break;
      case '--scenario': {
        const value = readValue();
        if (!SCENARIOS.includes(value as ScenarioName)) {
          throw new Error(`capacity_unknown_scenario:${value}`);
        }
        scenario = value as ScenarioName;
        break;
      }
      case '--duration-ms':
        values.set('duration', readValue());
        break;
      case '--rps':
        values.set('rps', readValue());
        break;
      case '--requests':
        values.set('requests', readValue());
        break;
      case '--seed':
        values.set('seed', readValue());
        break;
      case '--report':
        values.set('report', readValue());
        break;
      case '--out':
        values.set('out', readValue());
        break;
      case '--body-budget':
        values.set('bodyBudget', readValue());
        break;
      case '--disk-limit':
        values.set('diskLimit', readValue());
        break;
      case '--slice-budget':
        values.set('sliceBudget', readValue());
        break;
      default:
        throw new Error(`capacity_unknown_flag:${arg}`);
    }
  }
  if (scenario === null) throw new Error('capacity_scenario_required');
  const bodyBudget = integerFlag('body_budget', values.get('bodyBudget'), 64 * MIB, 1, 16 * 1024 * MIB);
  const diskLimit = integerFlag('disk_limit', values.get('diskLimit'), 512 * MIB, 2, 64 * 1024 * MIB);
  if (bodyBudget >= diskLimit) throw new Error('capacity_budget_order');
  return {
    scenario,
    full: flags.has('full'),
    acknowledgeLongRun: flags.has('acknowledge'),
    durationMs: values.has('duration')
      ? integerFlag('duration_ms', values.get('duration'), 0, 1, MAX_DURATION_MS)
      : undefined,
    rps: values.has('rps') ? integerFlag('rps', values.get('rps'), 0, 1, MAX_RPS) : undefined,
    requests: values.has('requests')
      ? integerFlag('requests', values.get('requests'), 0, 1, MAX_REQUESTS)
      : undefined,
    seed: integerFlag('seed', values.get('seed'), 1, 0, Number.MAX_SAFE_INTEGER),
    report: values.get('report') ?? join(tmpdir(), `atc-capacity-${scenario}.json`),
    /** `budget` 子命令的落盘位置；其余场景只写 `--report`。 */
    out: values.get('out'),
    bodyBudget,
    bodyBudgetExplicit: values.has('bodyBudget'),
    diskLimit,
    sliceBudget: values.get('sliceBudget'),
  };
}

/** 10 分钟、全场景、10,000 笔长组与切片长组都必须显式确认；其余短场景保持快速可跑。 */
export function requiresLongRunAck(args: Args): boolean {
  return args.full
    || args.scenario === 'all'
    || args.scenario === 'long-10000-slice'
    || (args.durationMs ?? 0) >= MAX_DURATION_MS
    || (args.scenario === 'long' && (args.requests ?? 2_000) >= LONG_REQUESTS);
}

class DurationRecorder {
  private readonly values: number[] = [];
  record(ms: number): void { this.values.push(ms); }
  summary(): DurationSummary { return summarizeDurations(this.values); }
}

/**
 * 峰值只统计实际取到的快照，不把 0 当样本。HTTP 场景按固定间隔采样，
 * burst 与 long 在阶段边界取值；采样次数随报告一起提交，读者能判断精度。
 */
export type PeakTracker = {
  samples: number;
  rss_bytes: number;
  storage: StorageReading;
  observe(snapshot: Snapshot): void;
};

export function createPeakTracker(): PeakTracker {
  const peak: PeakTracker = {
    samples: 0,
    rss_bytes: 0,
    storage: { db_bytes: 0, wal_bytes: 0, temp_bytes: 0, body_bytes: 0, total_bytes: 0, freelist_count: 0 },
    observe(snapshot) {
      peak.samples += 1;
      peak.rss_bytes = Math.max(peak.rss_bytes, snapshot.rss_bytes);
      peak.storage.db_bytes = Math.max(peak.storage.db_bytes, snapshot.storage.db_bytes);
      peak.storage.wal_bytes = Math.max(peak.storage.wal_bytes, snapshot.storage.wal_bytes);
      peak.storage.temp_bytes = Math.max(peak.storage.temp_bytes, snapshot.storage.temp_bytes);
      peak.storage.body_bytes = Math.max(peak.storage.body_bytes, snapshot.storage.body_bytes);
      peak.storage.total_bytes = Math.max(peak.storage.total_bytes, snapshot.storage.total_bytes);
      peak.storage.freelist_count = Math.max(peak.storage.freelist_count, snapshot.storage.freelist_count);
    },
  };
  return peak;
}

type ClientCounters = {
  attempts: number; accepted: number; duplicates: number; retried: number;
  failed: number; query_failed: number;
  /** 按计划发出的请求数（含 burst 的重放）。 */
  launched: number;
  /** 到点的刻度数：计划速率乘实际时长。 */
  ticks_scheduled: number;
  /** 到点却因在途上限已满而没发出的刻度数。 */
  ticks_dropped: number;
  /** 在途请求峰值；贴住上限说明负载端自己成了瓶颈。 */
  in_flight_peak: number;
};

function newClientCounters(): ClientCounters {
  return {
    attempts: 0, accepted: 0, duplicates: 0, retried: 0, failed: 0, query_failed: 0,
    launched: 0, ticks_scheduled: 0, ticks_dropped: 0, in_flight_peak: 0,
  };
}

type RequestBody = string | (() => string | ReadableStream<Uint8Array>);

/**
 * 发一个 hook。429/503 最多重试 8 次，退避 10/20/40/80/160/320/640/1280 ms；
 * 总窗口约 2.55 秒，覆盖十笔 4 MiB 并发在单线程采集器上的串行排空。
 * 每次尝试都计入时延；失败只保留状态码与服务端固定 error 码，不记录响应正文。
 */
async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: RequestBody,
  client: ClientCounters,
  recorder: DurationRecorder,
): Promise<unknown | null> {
  const delays = [0, 10, 20, 40, 80, 160, 320, 640, 1_280];
  let lastError: string | null = null;
  for (const [index, delay] of delays.entries()) {
    if (delay > 0) {
      client.retried += 1;
      await Bun.sleep(delay);
    }
    client.attempts += 1;
    const started = performance.now();
    let response: Response;
    try {
      const payload = typeof body === 'string' ? body : body();
      response = await fetch(url, { method: 'POST', headers, body: payload });
    } catch {
      lastError = 'network_error';
      continue;
    } finally {
      recorder.record(performance.now() - started);
    }
    const payload = await response.json().catch(() => ({})) as { error?: string; duplicate?: boolean };
    if (response.status === 200) {
      client.accepted += 1;
      if (payload.duplicate === true) client.duplicates += 1;
      return payload;
    }
    lastError = payload.error ?? `http_${response.status}`;
    if (response.status === 429 || response.status === 503) continue;
    // 不可重试的状态码立即算最终失败，不能只在最后一次尝试时才计数。
    client.failed += 1;
    process.stderr.write(`capacity_hook_failed:${lastError}\n`);
    return null;
  }
  client.failed += 1;
  process.stderr.write(`capacity_hook_failed:${lastError ?? 'unknown'}\n`);
  return null;
}

async function fetchSnapshot(url: string, headers: Record<string, string>): Promise<Snapshot> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`capacity_metrics_http_${response.status}`);
  return await response.json() as Snapshot;
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<number | null> {
  if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
  return child.exitCode;
}

function countRows(db: Database, sql: string, params: readonly (string | number)[] = []): number {
  const row = db.query<{ n: number }, never[]>(sql).get(...(params as never[]));
  return row === null ? 0 : Number(row.n);
}

/**
 * 采集器停止后的守恒核对。evidence 按请求去重：账本与 hook 各留一行证据，
 * 同一个请求上出现两行是正常关联结果，不代表多收了一笔。
 */
function countConservation(
  dbPath: string, hookAccepted: number,
): Omit<ScenarioReport['conservation'], 'pending_hooks' | 'open_gaps'> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rawHook = countRows(db, 'SELECT COUNT(*) AS n FROM raw_hook');
    const requests = countRows(db, 'SELECT COUNT(*) AS n FROM request');
    const evidence = countRows(db, 'SELECT COUNT(DISTINCT req_id) AS n FROM request_evidence');
    const route = countRows(db, 'SELECT COUNT(*) AS n FROM route_summary');
    const missing: string[] = [];
    if (rawHook !== hookAccepted) missing.push(`raw_hook:${rawHook}!=${hookAccepted}`);
    if (requests !== hookAccepted) missing.push(`request:${requests}!=${hookAccepted}`);
    if (evidence !== hookAccepted) missing.push(`request_evidence:${evidence}!=${hookAccepted}`);
    return {
      hook_accepted: hookAccepted,
      raw_hook_rows: rawHook,
      request_rows: requests,
      evidence_rows: evidence,
      route_rows: route,
      missing,
    };
  } finally {
    db.close();
  }
}

type Snapshot = {
  started_at_ms: number;
  uptime_ms: number;
  ingest: ScenarioReport['collector']['ingest'] & { started_at_ms: number; uptime_ms: number };
  writer: ScenarioReport['collector']['writer'];
  event_loop: ScenarioReport['collector']['event_loop'];
  jobs: ScenarioReport['collector']['jobs'];
  route: ScenarioReport['collector']['route'];
  rss_bytes: number;
  storage: StorageUsage;
  metadata: ScenarioReport['collector']['metadata'];
  derive_queue: ScenarioReport['collector']['derive_queue'];
};

type DrainPoll = {
  drain_ms: number | null;
  polls: number;
  max_age_ms: number | null;
  pending: number;
  /** 未收敛的 hook：等账本/路由证据到达后由 pending 对账合并。 */
  pending_hooks: number;
  /** 未关闭的来源缺口；非零表示有账本区间还没读进来。 */
  open_gaps: number;
};

function buildReport(input: {
  plan: ScenarioPlan & { scenario: string; mode: 'baseline' | 'optimized' | 'slice'; seed: number };
  args: Args;
  root: string;
  client: ClientCounters;
  hookLatency: DurationRecorder;
  queryLatency: DurationRecorder;
  snapshot: Snapshot;
  peaks: PeakTracker;
  final: DrainPoll;
  conservation: ScenarioReport['conservation'];
  derive: {
    comparisons: number | null; decodes: number | null;
    full_incremental_equal: boolean | null; result_sha256: string | null;
    published_generations: number | null; discarded_generations: number | null;
    slice_budget_source: string | null;
  };
  startedAt: number; stopAt: number; notes: string[];
}): ScenarioReport {
  const ingest = input.snapshot.ingest;
  const storage = input.snapshot.storage;
  return {
    schema: 1,
    scenario: input.plan.scenario,
    mode: input.plan.mode,
    started_at: new Date(input.startedAt).toISOString(),
    duration_ms: input.stopAt - input.startedAt,
    seed: input.plan.seed,
    environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
    config: {
      rps: input.plan.rps, sessions: input.plan.sessions, requests: input.plan.requests ?? 0,
      concurrency: input.plan.concurrency,
      body_budget: input.args.bodyBudget, disk_limit: input.args.diskLimit,
      dataDir: input.root,
    },
    client: {
      ...input.client,
      hook_latency: input.hookLatency.summary(),
      query_latency: input.queryLatency.summary(),
    },
    collector: {
      started_at_ms: ingest.started_at_ms,
      uptime_ms: ingest.uptime_ms,
      ingest: {
        accepted: ingest.accepted, duplicates: ingest.duplicates,
        rejected_total: ingest.rejected_total, rejected_by_reason: ingest.rejected_by_reason,
        accepted_request_bytes: ingest.accepted_request_bytes,
        accepted_reply_bytes: ingest.accepted_reply_bytes,
      },
      writer: input.snapshot.writer,
      event_loop: input.snapshot.event_loop,
      jobs: input.snapshot.jobs,
      route: input.snapshot.route,
      rss_peak_bytes: input.peaks.rss_bytes,
      storage_peak: { ...input.peaks.storage },
      storage_end: {
        db_bytes: storage.db_bytes, wal_bytes: storage.wal_bytes,
        temp_bytes: storage.temp_bytes, body_bytes: storage.body_bytes,
        total_bytes: storage.total_bytes, freelist_count: storage.freelist_count,
      },
      peak_samples: input.peaks.samples,
      metadata: input.snapshot.metadata,
      derive_queue: input.snapshot.derive_queue,
    },
    derive: {
      backlog_max_age_ms: input.final.max_age_ms,
      drain_ms: input.final.drain_ms,
      drain_polls: input.final.polls,
      pending_groups_end: input.final.pending,
      comparisons: input.derive.comparisons,
      decodes: input.derive.decodes,
      full_incremental_equal: input.derive.full_incremental_equal,
      result_sha256: input.derive.result_sha256,
      published_generations: input.derive.published_generations,
      discarded_generations: input.derive.discarded_generations,
      slice_budget_source: input.derive.slice_budget_source,
    },
    conservation: input.conservation,
    notes: input.notes,
    ok: input.conservation.missing.length === 0 && input.client.failed === 0
      && input.client.query_failed === 0
      && input.final.drain_ms !== null && input.final.pending === 0,
  };
}

/**
 * 读一轮页面接口：会话列表、首个会话的请求列表、首条请求的正文页。
 * 任何非 2xx 都算读取失败；把 401/404 的 JSON 当数据会让样本掩盖认证或路由错误。
 */
async function readOnce(port: number, headers: Record<string, string>): Promise<number> {
  const started = performance.now();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string): Promise<Response> => {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`capacity_read_http_${response.status}`);
    return response;
  };
  const sessions = await get('/api/sessions?limit=50').then(response => response.json()) as {
    items?: { conv_key?: unknown }[];
  };
  const key = sessions.items?.[0]?.conv_key;
  if (typeof key === 'string') {
    const requests = await get(
      `/api/sessions/${encodeURIComponent(key)}/requests?limit=100`,
    ).then(response => response.json()) as { items?: { req_id?: unknown }[] };
    const id = requests.items?.[0]?.req_id;
    if (typeof id === 'number') {
      await get(`/api/requests/${id}/body?from=0&to=${PAGE_MAX}`);
    }
  }
  return performance.now() - started;
}

/**
 * 停止输入后每 100 ms 读一次队列，直到未发布组为 0 或超时。
 * 积压年龄优先用 dirty_since_ms；最老请求年龄只作回退观测。
 *
 * 三个计数同时为 0 只说明"这一刻没有积压"，不等于"已经安顿"：账本与路由读取、
 * hook 对账都在自己的间隔上跑，停输入后仍可能再插进请求并把组标脏，于是
 * 收敛读数与随后的终值快照会互相矛盾。所以要连续 `SETTLE_STABLE_MS` 保持干净才收工，
 * 这个窗口长于采集器最慢的来源间隔（对账 5 秒）。
 */
const SETTLE_STABLE_MS = 5_000;

async function pollDrain(
  url: string, statsUrl: string, headers: Record<string, string>,
  stopAtMs: number, timeoutMs = 120_000,
): Promise<DrainPoll> {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let maxAge: number | null = null;
  let pendingHooks = 0;
  let openGaps = 0;
  let settledSince: number | null = null;
  for (;;) {
    polls += 1;
    const snapshot = await fetch(url, { headers }).then(response => response.json()) as Snapshot;
    try {
      const stats = await fetch(statsUrl, { headers }).then(response => response.json()) as {
        pending_hooks: number; open_gaps: number;
      };
      pendingHooks = stats.pending_hooks;
      openGaps = stats.open_gaps;
    } catch {
      // 统计入口短暂失败不当作收敛；下一次轮询再读。
    }
    const queue = snapshot.derive_queue;
    const age = queue.oldest_dirty_age_ms ?? queue.oldest_request_age_ms;
    if (age !== null) maxAge = Math.max(maxAge ?? 0, age);
    // 队列排空还不够：hook 要等账本/路由证据对账，账本区间要读完，否则请求行数会对不上。
    const quiet = queue.pending_groups === 0 && pendingHooks === 0 && openGaps === 0;
    settledSince = quiet ? (settledSince ?? Date.now()) : null;
    if (settledSince !== null && Date.now() - settledSince >= SETTLE_STABLE_MS) {
      return {
        drain_ms: Date.now() - stopAtMs, polls, max_age_ms: maxAge,
        pending: 0, pending_hooks: 0, open_gaps: 0,
      };
    }
    if (Date.now() > deadline) {
      return {
        drain_ms: null, polls, max_age_ms: maxAge,
        pending: queue.pending_groups, pending_hooks: pendingHooks, open_gaps: openGaps,
      };
    }
    await Bun.sleep(100);
  }
}

function calendarDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 追加一条合成路由行；文件按本地日期命名，与真实路由目录一致。 */
function appendRouteLine(root: string, routeId: number, session: string, startedMs: number): void {
  const path = join(root, 'sources', 'routing', `${calendarDay(startedMs)}.jsonl`);
  appendFileSync(path, makeRouteLine({ routeId, session, startedMs }));
}

type CollectorHandle = {
  root: string;
  dataDir: string;
  dbPath: string;
  baseUrl: string;
  port: number;
  upstream: ReturnType<typeof createFakeUpstream>;
  child: ReturnType<typeof Bun.spawn>;
  readHeaders: Record<string, string>;
  hookHeaders: Record<string, string>;
  stop(): Promise<number | null>;
  dispose(): void;
};

/**
 * 建临时根、写配置、起假上游与采集器子进程，等它打印监听端口。
 * 任何一步失败都先杀掉子进程并删根，不把半启动的采集器留给下一个场景。
 */
async function openScenarioCollector(input: {
  args: Args;
  intervals?: Config['intervals'];
  prepare?: (root: string) => void;
}): Promise<CollectorHandle> {
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-'));
  let upstream: ReturnType<typeof createFakeUpstream> | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
    writeFileSync(join(root, 'sources', 'usage.jsonl'), '');
    input.prepare?.(root);
    const createdUpstream = createFakeUpstream();
    upstream = createdUpstream;
    const configPath = join(root, 'collector.json');
    writeFileSync(configPath, JSON.stringify({
      root,
      upstream_port: createdUpstream.port,
      body_budget: input.args.bodyBudget,
      disk_limit: input.args.diskLimit,
      intervals: input.intervals,
    }));
    child = Bun.spawn(['bun', join(import.meta.dir, 'capacity-collector.ts'), configPath], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const port = await waitForCollector(child);
    const readToken = readFileSync(join(root, 'data', 'read.token'));
    const hookToken = readFileSync(join(root, 'data', 'hook.token'));
    const baseUrl = `http://127.0.0.1:${port}`;
    const readHeaders = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${Buffer.from(readToken).toString('base64url')}`,
    };
    const hookHeaders = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${Buffer.from(hookToken).toString('base64url')}`,
      'content-type': 'application/json',
    };
    let stopped = false;
    const handle: CollectorHandle = {
      root,
      dataDir: join(root, 'data'),
      dbPath: join(root, 'data', 'trace.db'),
      baseUrl,
      port,
      upstream: createdUpstream,
      child,
      readHeaders,
      hookHeaders,
      async stop() {
        if (stopped) return child!.exitCode;
        stopped = true;
        const code = await stopChild(child!);
        // 正常路径由子进程自己的 SIGTERM 处理器关库；超过等待上限才强杀，
        // 避免守恒核对读到一个仍在写入的库。
        if (child!.exitCode === null) {
          child!.kill('SIGKILL');
          await Bun.sleep(100);
        }
        return code;
      },
      dispose() {
        createdUpstream.stop();
        if (child!.exitCode === null) child!.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      },
    };
    return handle;
  } catch (error) {
    if (child !== null) await stopChild(child);
    upstream?.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

type LoadResult = {
  client: ClientCounters;
  hookLatency: DurationRecorder;
  queryLatency: DurationRecorder;
  peaks: PeakTracker;
  startedAt: number;
  stopAt: number;
};

const PEAK_INTERVAL_MS = 1_000;

/**
 * 按固定速率发合成 hook；账本与路由行先落盘，hook 后到。
 * 页面读取与峰值采样各用一个定时器，失败只计数，不打断负载。
 *
 * 刻度按绝对时间推进：落后不补也不顺延，所以"计划发多少"与"实际发多少"
 * 可以分开记账。等响应再睡（一次只在途一笔）会把速率悄悄降到采集器能承受的水平，
 * 于是任何档位都"通过"。在途上限取 `plan.concurrency`：宽到负载端自己不是瓶颈，
 * 又有限到不会把几千个 1 MiB 正文压在内存里；贴住上限会体现在 `ticks_dropped` 上。
 */
async function runPeriodicLoad(
  handle: CollectorHandle, plan: ScenarioPlan, seed: number,
): Promise<LoadResult> {
  const hookLatency = new DurationRecorder();
  const queryLatency = new DurationRecorder();
  const peaks = createPeakTracker();
  const client = newClientCounters();
  const metricsUrl = `${handle.baseUrl}/api/ingest-metrics`;
  const startedAt = Date.now();
  const tickMs = plan.rps > 0 ? 1_000 / plan.rps : 0;
  const limit = Math.max(1, plan.concurrency);
  const inFlight = new Set<Promise<void>>();
  const readerTimer = plan.readerIntervalMs > 0
    ? setInterval(() => {
      void readOnce(handle.port, handle.readHeaders)
        .then(ms => queryLatency.record(ms))
        .catch(() => { client.query_failed += 1; });
    }, plan.readerIntervalMs)
    : null;
  const peakTimer = setInterval(() => {
    void fetchSnapshot(metricsUrl, handle.readHeaders)
      .then(snapshot => peaks.observe(snapshot))
      .catch(() => {});
  }, PEAK_INTERVAL_MS);
  const launch = (tick: number): void => {
    const bodyBytes = plan.bodyMix[tick % plan.bodyMix.length] ?? plan.requestBytes;
    const session = `session-${tick % plan.sessions}`;
    const routeId = tick + 1;
    // 由种子与序号生成，重放同一场景时 hook_id 与账本关联可复现。
    const hookId = `cap-${seed}-${routeId}`;
    const startedMs = Date.now();
    const envelope = makeHookEnvelope({
      hookId, session, routeId, requestBytes: bodyBytes,
      replyBytes: plan.replyBytes[tick % plan.replyBytes.length]!,
      bodyOmitted: false, omitReason: null, model: 'synthetic-model', startedMs,
    });
    appendFileSync(join(handle.root, 'sources', 'usage.jsonl'), makeLedgerLine({
      routeId, session, responseId: hookId, startedMs,
    }));
    appendRouteLine(handle.root, routeId, session, startedMs);
    client.launched += 1;
    client.in_flight_peak = Math.max(client.in_flight_peak, inFlight.size + 1);
    const done = postWithRetry(
      `${handle.baseUrl}/hook/ingest`, handle.hookHeaders,
      () => JSON.stringify(envelope), client, hookLatency,
    ).then(() => {}).finally(() => { inFlight.delete(done); });
    inFlight.add(done);
  };
  try {
    for (let tick = 0; tick < scheduledTicks(plan.durationMs, plan.rps); tick += 1) {
      const tickAt = startedAt + tick * tickMs;
      const now = Date.now();
      if (now < tickAt) await Bun.sleep(tickAt - now);
      client.ticks_scheduled += 1;
      if (inFlight.size >= limit) client.ticks_dropped += 1;
      else launch(tick);
    }
    // 停止投递后等在途响应落定，接受数与时延分布才算完整。
    await Promise.all([...inFlight]);
  } finally {
    if (readerTimer !== null) clearInterval(readerTimer);
    clearInterval(peakTimer);
  }
  return { client, hookLatency, queryLatency, peaks, startedAt, stopAt: Date.now() };
}

type HttpScenarioName = 'smoke' | 'baseline-1rps' | 'baseline-5rps' | 'route' | 'retention';

/** 周期负载的完整顺序：发 hook → 停输入 → 排空 → 快照 → 停子进程 → 守恒 → 报告。 */
async function runHttpScenario(
  name: HttpScenarioName,
  args: Args,
  options: {
    intervals?: Config['intervals'];
    prepare?: (root: string) => void;
    routeMutations?: boolean;
    inspect?: (dbPath: string) => string[];
  } = {},
): Promise<ScenarioReport> {
  const plan = scenarioPlan(name, args);
  const handle = await openScenarioCollector({
    args, intervals: options.intervals, prepare: options.prepare,
  });
  let routeTimer: ReturnType<typeof setInterval> | null = null;
  try {
    if (options.routeMutations === true) routeTimer = startRouteMutations(handle.root);
    const load = await runPeriodicLoad(handle, plan, args.seed);
    if (routeTimer !== null) clearInterval(routeTimer);
    routeTimer = null;
    const metricsUrl = `${handle.baseUrl}/api/ingest-metrics`;
    const final = await pollDrain(
      metricsUrl, `${handle.baseUrl}/api/stats`, handle.readHeaders,
      load.stopAt, plan.durationMs + 120_000,
    );
    const snapshot = await fetchSnapshot(metricsUrl, handle.readHeaders);
    load.peaks.observe(snapshot);
    await handle.stop();
    const uniqueAccepted = load.client.accepted - load.client.duplicates;
    const conservation = {
      ...countConservation(handle.dbPath, uniqueAccepted),
      pending_hooks: final.pending_hooks,
      open_gaps: final.open_gaps,
    };
    if (final.pending_hooks !== 0) {
      conservation.missing.push(`pending_hooks:${final.pending_hooks}!=0`);
    }
    if (final.open_gaps !== 0) {
      conservation.missing.push(`open_gaps:${final.open_gaps}!=0`);
    }
    conservation.missing.push(...offeredShortfall(load.client));
    conservation.missing.push(...finalQueueMissing(snapshot));
    const report = buildReport({
      plan: { ...plan, scenario: name, mode: 'baseline', seed: args.seed },
      args, root: handle.root,
      client: load.client, hookLatency: load.hookLatency, queryLatency: load.queryLatency,
      snapshot, peaks: load.peaks, final, conservation,
      derive: {
        comparisons: null, decodes: null, full_incremental_equal: null,
        result_sha256: null, published_generations: null, discarded_generations: null,
        slice_budget_source: null,
      },
      startedAt: load.startedAt, stopAt: load.stopAt,
      notes: [`rss 与存储峰值按 ${PEAK_INTERVAL_MS} ms 采样，共 ${load.peaks.samples} 次（含最终快照）。`],
    });
    if (load.client.ticks_dropped > 0) {
      report.notes.push(
        `计划 ${plan.rps}/s 共 ${load.client.ticks_scheduled} 个刻度，`
        + `${load.client.ticks_dropped} 个因在途请求已满未发出（在途峰值 ${load.client.in_flight_peak}）；`
        + '这份报告测的是实际投递速率下的行为，不是计划速率。',
      );
    }
    if (options.inspect !== undefined) report.notes.push(...options.inspect(handle.dbPath));
    return report;
  } finally {
    if (routeTimer !== null) clearInterval(routeTimer);
    await handle.stop();
    handle.dispose();
  }
}

/** 1 rps 与 5 rps 基线共用同一条周期负载流程。 */
async function runBaseline(
  name: 'baseline-1rps' | 'baseline-5rps', args: Args,
): Promise<ScenarioReport> {
  return await runHttpScenario(name, args);
}

/** 路由场景的目录变更：追加、替换成 gzip、损坏后修复、增加跨午夜文件。 */
function startRouteMutations(root: string): ReturnType<typeof setInterval> {
  const routing = join(root, 'sources', 'routing');
  let phase = 0;
  let nextId = 10_000;
  const readExisting = (path: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  return setInterval(() => {
    const now = Date.now();
    const day = calendarDay(now);
    const tomorrow = calendarDay(now + 24 * 60 * 60 * 1000);
    phase += 1;
    const line = makeRouteLine({ routeId: nextId, session: 'route-synthetic', startedMs: now });
    nextId += 1;
    appendFileSync(join(routing, `${day}.jsonl`), line);
    if (phase === 2) {
      // 替换：把当日 jsonl 整体压成 gz 并删掉原文件，验证按文件名换游标。
      const lines = readExisting(join(routing, `${day}.jsonl`));
      writeFileSync(join(routing, `${day}.jsonl.gz`), gzipSync(Buffer.from(lines, 'utf8')));
      rmSync(join(routing, `${day}.jsonl`), { force: true });
    }
    if (phase === 4) {
      // 损坏 gzip：采集器记录 route_file_error，游标不前进。
      writeFileSync(join(routing, `${tomorrow}.jsonl.gz`), 'not-a-gzip');
    }
    if (phase === 6) {
      // 修复后下一轮重新解压；跨午夜文件用次日时间戳。
      const fixed = makeRouteLine({
        routeId: nextId, session: 'route-synthetic',
        startedMs: now + 24 * 60 * 60 * 1000,
      });
      nextId += 1;
      writeFileSync(join(routing, `${tomorrow}.jsonl.gz`), gzipSync(Buffer.from(fixed, 'utf8')));
    }
  }, 3_000);
}

/** 突发场景：10 个并发、第一个请求体分块流延迟 50 ms，再重放第一个 hook_id。 */
async function runBurst(args: Args): Promise<ScenarioReport> {
  const plan = scenarioPlan('burst', args);
  const handle = await openScenarioCollector({ args });
  const hookLatency = new DurationRecorder();
  const queryLatency = new DurationRecorder();
  const peaks = createPeakTracker();
  const client = newClientCounters();
  const startedAt = Date.now();
  let active = 0;
  let concurrencyPeak = 0;
  try {
    const url = `${handle.baseUrl}/hook/ingest`;
    const envelopes = Array.from({ length: plan.concurrency }, (_, index) => {
      const startedMs = Date.now();
      return makeHookEnvelope({
        hookId: `cap-burst-${args.seed}-${index}`,
        session: `burst-session-${index % plan.sessions}`,
        routeId: index + 1,
        requestBytes: plan.requestBytes,
        replyBytes: plan.replyBytes[index % plan.replyBytes.length]!,
        bodyOmitted: false, omitReason: null, model: 'synthetic-model', startedMs,
      });
    });
    // 账本与路由行先落盘，和周期场景一样让 hook 有可对账的对象；
    // 否则每个 hook 都会留下一条永不收敛的 pending_hook。
    for (const [index, envelope] of envelopes.entries()) {
      const session = envelope.session ?? `burst-session-${index}`;
      appendFileSync(join(handle.root, 'sources', 'usage.jsonl'), makeLedgerLine({
        routeId: index + 1, session, responseId: envelope.hook_id, startedMs: envelope.observed_start_ms,
      }));
      appendRouteLine(handle.root, index + 1, session, envelope.observed_start_ms);
    }
    const bodies: RequestBody[] = envelopes.map((envelope, index) => {
      const json = JSON.stringify(envelope);
      return index === 0 ? delayedBody(json, 50) : json;
    });
    await Promise.all(bodies.map(async body => {
      active += 1;
      concurrencyPeak = Math.max(concurrencyPeak, active);
      client.launched += 1;
      client.in_flight_peak = Math.max(client.in_flight_peak, active);
      try {
        return await postWithRetry(url, handle.hookHeaders, body, client, hookLatency);
      } finally {
        active -= 1;
      }
    }));
    // 重放第一个 hook_id：服务端应返回 duplicate，唯一计数不增加。
    client.launched += 1;
    await postWithRetry(url, handle.hookHeaders, JSON.stringify(envelopes[0]!), client, hookLatency);
    const stopAt = Date.now();
    const metricsUrl = `${handle.baseUrl}/api/ingest-metrics`;
    peaks.observe(await fetchSnapshot(metricsUrl, handle.readHeaders));
    const final = await pollDrain(
      metricsUrl, `${handle.baseUrl}/api/stats`, handle.readHeaders,
      stopAt, plan.durationMs + 120_000,
    );
    const snapshot = await fetchSnapshot(metricsUrl, handle.readHeaders);
    peaks.observe(snapshot);
    await handle.stop();
    const uniqueAccepted = client.accepted - client.duplicates;
    const conservation = {
      ...countConservation(handle.dbPath, uniqueAccepted),
      pending_hooks: final.pending_hooks,
      open_gaps: final.open_gaps,
    };
    if (final.pending_hooks !== 0) {
      conservation.missing.push(`pending_hooks:${final.pending_hooks}!=0`);
    }
    if (final.open_gaps !== 0) {
      conservation.missing.push(`open_gaps:${final.open_gaps}!=0`);
    }
    conservation.missing.push(...offeredShortfall(client));
    const report = buildReport({
      plan: { ...plan, scenario: 'burst', mode: 'baseline', seed: args.seed },
      args, root: handle.root,
      client, hookLatency, queryLatency, snapshot, peaks, final, conservation,
      derive: {
        comparisons: null, decodes: null, full_incremental_equal: null,
        result_sha256: null, published_generations: null, discarded_generations: null,
        slice_budget_source: null,
      },
      startedAt, stopAt,
      notes: ['rss 与存储峰值取自并发结束与排空后的两次快照。'],
    });
    if (concurrencyPeak < plan.concurrency) {
      report.notes.push(`burst 并发峰值 ${concurrencyPeak} 低于 ${plan.concurrency}，不能声称已观测满并发。`);
    }
    if ((report.collector.ingest.rejected_by_reason.busy ?? 0) === 0) {
      report.notes.push('burst 未观测到 busy，不能声称已观测背压。');
    }
    return report;
  } finally {
    await handle.stop();
    handle.dispose();
  }
}

/** 用可重复消费的工厂包一层分块流；重试时不会复用已读过的流。 */
function delayedBody(text: string, delayMs: number): () => ReadableStream<Uint8Array> {
  return () => {
    const bytes = new TextEncoder().encode(text);
    const cut = Math.max(1, Math.floor(bytes.length / 2));
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        await Bun.sleep(delayMs);
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
  };
}

/**
 * 长组场景直接建库，不走 HTTP：先写全部正文与队列，再按批次排空。
 *
 * 给了切片预算就是切片长组：输入与 `long-10000` 逐字相同，只有排空入口与读数不同，
 * 两个场景的 `result_sha256` 才能放在一起比。
 */
async function runLong(args: Args, slice?: SliceBudgetReading): Promise<ScenarioReport> {
  const plan = scenarioPlan(slice === undefined ? 'long' : 'long-10000-slice', args);
  const requests = plan.requests ?? 2_000;
  const scenario = slice === undefined ? `long-${requests}` : 'long-10000-slice';
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-'));
  const dataDir = join(root, 'data');
  const runtime: SliceRuntime | undefined = slice === undefined ? undefined : {
    budget: slice.budget, dataDir, dbPath: join(dataDir, 'trace.db'),
  };
  let store: Store | null = null;
  let metrics: CapacityMetrics | null = null;
  try {
    mkdirSync(dataDir, { recursive: true });
    const opened = openStore(join(dataDir, 'trace.db'));
    store = opened;
    // 模式在任何派生任务进来之前定下来，运行期不再切——与 startCollector 同一处事实。
    if (runtime !== undefined) opened.deriveRuntime = runtime;
    const openedMetrics = createCapacityMetrics(opened, dataDir, Date.now());
    metrics = openedMetrics;
    openedMetrics.eventLoop.start();
    const startedAt = Date.now();
    const convKey = JSON.stringify(['session', 'long-synthetic']);
    const actor = 'long-synthetic';
    const baseMs = startedAt;
    const now = Date.now();
    const peaks = createPeakTracker();

    opened.write(db => {
      const insert = db.query(`INSERT INTO request(
        conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,
        derive_version,have,created_at,updated_at,sort_source,sort_key,agent
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (let index = 0; index < requests; index++) {
        const startedMs = baseMs + index;
        const hookId = `long-${index}`;
        const result = insert.run(
          convKey, 'session', actor, 'known', startedMs, calendarDay(startedMs), 'hook',
          'pending', 0, 1, now, now, 'hook', hookId, 'claude',
        );
        const reqId = Number(result.lastInsertRowid);
        const envelopeInput = {
          hookId, session: 'long-synthetic', routeId: index,
          requestBytes: 256, replyBytes: 256,
          bodyOmitted: false, omitReason: null,
          model: 'synthetic-model', startedMs,
        };
        persistBodyTx(db, reqId, {
          protocol: 'anthropic',
          request: {
            model: 'synthetic-model',
            messages: makeMessages(envelopeInput),
            max_tokens: 128,
          },
          reply: makeReply(envelopeInput),
          redact_version: 1,
        });
        // 每写一笔就入队，dirty_since 留在首笔时间；积压年龄覆盖整个写入阶段，
        // 而不是等全部写完才从 0 开始。
        enqueueDeriveTx(db, convKey, actor, '');
      }
    });

    peaks.observe(openedMetrics.snapshot(opened, dataDir) as unknown as Snapshot);
    const backlogMaxAge = queueSnapshot(opened).oldest_dirty_age_ms;
    // 排空按运行模式走各自的入口：同步入口一次一批，切片入口一次推进一步。
    // 切片丢弃的代在整个场景里累计——重排阶段丢的代同样是容量问题，不是另一回事。
    let discardedGenerations = 0;
    const drainAll = (stuckCode: string): number => {
      let polls = 0;
      for (;;) {
        polls += 1;
        if (runtime === undefined) {
          const result = opened.write(db => drainDeriveTx(db, { limit: 100 }));
          if (result.remaining === 0) return polls;
          if (result.processed === 0) throw new Error(stuckCode);
          continue;
        }
        const result = drainDeriveEntry(opened, 1);
        discardedGenerations += result.discarded;
        if (result.remaining === 0) return polls;
        // 切片入口一次只推进一个阶段步：既没推进也没丢代就是卡住，不能原地空转。
        if (result.processed === 0 && result.discarded === 0) throw new Error(stuckCode);
      }
    };
    const drainStarted = performance.now();
    const drainPolls = drainAll('capacity_long_drain_stuck');
    const drainMs = performance.now() - drainStarted;
    const incrementalHash = runtime === undefined
      ? derivedHash(opened, convKey)
      : derivedHashSlice(opened, convKey, actor);
    // 已发布代在增量排空之后、重排之前读：重排会换掉发布指针，那时读到的已经是新代。
    const publishedGenerations = runtime === undefined
      ? null
      : countPublishedGenerations(opened, convKey, actor);
    peaks.observe(openedMetrics.snapshot(opened, dataDir) as unknown as Snapshot);

    // 全量重算是各自的 oracle：重排整组后结果必须与增量排空逐字段一致。
    rebuildDerived(opened, convKey);
    drainAll('capacity_long_rebuild_stuck');
    const fullHash = runtime === undefined
      ? derivedHash(opened, convKey)
      : derivedHashSlice(opened, convKey, actor);
    const stopAt = Date.now();
    const queue = queueSnapshot(opened);
    const snapshot = openedMetrics.snapshot(opened, dataDir) as unknown as Snapshot;
    peaks.observe(snapshot);
    const decodes = runtime !== undefined ? null : countRows(opened.read,
      "SELECT COUNT(*) AS n FROM request WHERE conv_key=? AND skeleton_z IS NOT NULL AND body_state IN ('available','partial')",
      [convKey]);
    const requestRows = countRows(opened.read,
      'SELECT COUNT(*) AS n FROM request WHERE conv_key=?', [convKey]);
    const missing: string[] = [];
    if (requestRows !== requests) missing.push(`request:${requestRows}!=${requests}`);
    if (queue.pending_groups !== 0) missing.push(`pending_groups:${queue.pending_groups}!=0`);
    const notes = [
      'long 场景直接写临时库，不经 HTTP 或子进程采集器；client 计数为 0。',
      'comparisons 按单组前缀比较数 n(n-1)/2 计。',
      'rss 与存储峰值取自写入完成、增量排空后与全量重排后的三次快照。',
    ];
    const sliceBudgetSource = slice?.source ?? null;
    if (sliceBudgetSource === null) {
      notes.push('decodes 按可解码正文行数计，指纹取自请求行上的派生列。');
    } else {
      notes.push(`切片预算来自 ${sliceBudgetSource}；published_generations 取该组 state=published 的代际数，`
        + 'discarded_generations 是整个场景（含重排阶段）累计丢弃的未发布代数。');
      // 切片路径不落 `skeleton_z`（正文只解到 delta_ordinals 为止），这个读数没有对应物，
      // 报 null 而不是 0：0 会被读成"一条正文都没解开"。
      notes.push('切片路径不落 skeleton_z，decodes 报 null；指纹取自该组已发布的 result 行，列集与同步路径相同。');
    }
    const report = buildReport({
      plan: { ...plan, scenario, mode: runtime === undefined ? 'baseline' : 'slice', seed: args.seed },
      args, root,
      client: newClientCounters(),
      hookLatency: new DurationRecorder(),
      queryLatency: new DurationRecorder(),
      snapshot,
      peaks,
      final: {
        drain_ms: drainMs, polls: drainPolls,
        max_age_ms: backlogMaxAge, pending: queue.pending_groups,
        pending_hooks: 0, open_gaps: 0,
      },
      conservation: {
        hook_accepted: 0, raw_hook_rows: 0, request_rows: requestRows,
        evidence_rows: 0, route_rows: 0, pending_hooks: 0, open_gaps: 0, missing,
      },
      derive: {
        // 单组前缀比较的迭代次数：0+1+…+(n-1)，是本场景要压的派生成本。
        comparisons: requests < 2 ? 0 : (requests * (requests - 1)) / 2,
        decodes,
        full_incremental_equal: incrementalHash === fullHash,
        result_sha256: incrementalHash,
        published_generations: publishedGenerations,
        discarded_generations: runtime === undefined ? null : discardedGenerations,
        slice_budget_source: sliceBudgetSource,
      },
      startedAt, stopAt, notes,
    });
    if (incrementalHash !== fullHash) report.ok = false;
    // 切片的结构不变量：一次收敛至少发布一代，且一代都不许丢。丢代说明预算或校验
    // 把"算得对不对"换成了"跑得完跑不完"，那正是本任务要压的东西。
    if (runtime !== undefined && (discardedGenerations > 0 || (publishedGenerations ?? 0) < 1)) {
      report.ok = false;
    }
    return report;
  } finally {
    metrics?.eventLoop.stop();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 派生结果的确定性指纹：只读请求行上的派生列，按 req_id 排序。 */
function derivedHash(store: Store, convKey: string): string {
  const rows = store.read.query(`SELECT req_id,prev_req_id,prev_relation,delta_ordinals,
    chain_role,title,title_source,input_preview,input_preview_kind,reply_preview,
    model_title,req_kind,purpose_chain
    FROM request WHERE conv_key=? ORDER BY req_id`).all(convKey);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * 切片结果的指纹：同一列集、同一顺序，只是派生列取自该组**已发布**的 result 行。
 *
 * `model_title` 与 `req_kind` 是请求行上的事实（不是派生产物），因此 join 回来——
 * 少两列或换一处取值，`long-10000` 与 `long-10000-slice` 的 `result_sha256` 就没法比了。
 * 发布指针只有一个，所以这里读到的永远是当前那一代。
 */
export function derivedHashSlice(store: Store, convKey: string, actor: string): string {
  const rows = store.read.query(`SELECT r.req_id AS req_id, d.prev_req_id AS prev_req_id,
    d.prev_relation AS prev_relation, d.delta_ordinals AS delta_ordinals,
    d.chain_role AS chain_role, d.title AS title, d.title_source AS title_source,
    d.input_preview AS input_preview, d.input_preview_kind AS input_preview_kind,
    d.reply_preview AS reply_preview, r.model_title AS model_title, r.req_kind AS req_kind,
    d.purpose_chain AS purpose_chain
    FROM derive_queue q
    JOIN derive_request_result d ON d.generation=q.published_generation
    JOIN request r ON r.req_id=d.req_id
    WHERE q.conv_key=? AND q.actor=? ORDER BY r.req_id`).all(convKey, actor);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * 该组当前发布的代数。发布指针是唯一索引，所以正常收敛下它是 1，
 * 0 说明这一轮没发布任何东西（未发布代不计入——它们还只是暂存行）。
 */
export function countPublishedGenerations(store: Store, convKey: string, actor: string): number {
  return countRows(store.read,
    "SELECT COUNT(*) AS n FROM derive_generation WHERE conv_key=? AND actor=? AND state='published'",
    [convKey, actor]);
}

const RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 回收场景开跑前预置 8 天前的 raw 行；采集器启动后由周期任务清理。 */
function prepareRetention(root: string): void {
  mkdirSync(join(root, 'data'), { recursive: true });
  const store = openStore(join(root, 'data', 'trace.db'));
  try {
    const old = Date.now() - RAW_TTL_MS - 24 * 60 * 60 * 1000;
    store.write(db => {
      for (let index = 0; index < 10; index++) {
        db.run(`INSERT INTO raw_ledger(
          source_kind,file_generation,byte_offset,route_id,t_text,t_ms,source,payload_json
        ) VALUES (?,?,?,?,?,?,?,?)`, [
          'file', 'synthetic-old', index, 9_000 + index,
          new Date(old).toISOString(), old, 'synthetic', '{}',
        ]);
        db.run('INSERT INTO raw_route(route_id,time_ms,day,payload_json) VALUES (?,?,?,?)', [
          9_000 + index, old, calendarDay(old), '{}',
        ]);
      }
      for (let index = 0; index < 5; index++) {
        db.run('INSERT INTO raw_hook(hook_id,received_at,parse_state) VALUES (?,?,?)', [
          `old-hook-${index}`, old, 'ok',
        ]);
      }
    });
  } finally {
    store.close();
  }
}

/**
 * 回收场景要把正文预算压到会触发驱逐的量级；`all` 里其余场景仍用调用方预算。
 * 用户显式给出时尊重用户值，只在报告里说明回收是否真的发生。
 */
function retentionArgs(args: Args): Args {
  if (args.bodyBudgetExplicit) return args;
  return {
    ...args,
    bodyBudget: Math.max(1, Math.min(4 * 1024, Math.floor(args.diskLimit / 2))),
  };
}

async function runRetention(inputArgs: Args): Promise<ScenarioReport> {
  const args = retentionArgs(inputArgs);
  let residual = 0;
  const report = await runHttpScenario('retention', args, {
    intervals: { retention: 5_000, rawPrune: 5_000, cost: 10_000, derive: 1_000 },
    prepare: prepareRetention,
    inspect(dbPath) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const ledger = countRows(db, "SELECT COUNT(*) AS n FROM raw_ledger WHERE file_generation='synthetic-old'");
        const route = countRows(db, 'SELECT COUNT(*) AS n FROM raw_route WHERE route_id BETWEEN 9000 AND 9009');
        const hook = countRows(db, "SELECT COUNT(*) AS n FROM raw_hook WHERE hook_id LIKE 'old-hook-%'");
        residual = ledger + route + hook;
        return [`回收核对：预置 raw 行剩余 ledger=${ledger} route=${route} hook=${hook}，要求为 0。`];
      } finally {
        db.close();
      }
    },
  });
  const budgetFloor = args.bodyBudget * 0.9;
  if (report.collector.storage_peak.body_bytes < budgetFloor) {
    report.notes.push(
      `正文回收未触发：峰值 ${report.collector.storage_peak.body_bytes} 低于预算 90% (${Math.floor(budgetFloor)})。`,
    );
  }
  if (residual !== 0) report.ok = false;
  return report;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** 汇总按顺序重跑全部场景；单个场景失败只记录阶段并继续，不删报告重跑掩盖。 */
async function runAll(args: Args): Promise<ScenarioSummary> {
  const startedAt = Date.now();
  const scenarios: Record<string, ScenarioReport> = {};
  const notes: string[] = [];
  const steps: { name: string; run: () => Promise<ScenarioReport> }[] = [
    { name: 'smoke', run: () => runHttpScenario('smoke', args) },
    { name: 'baseline-1rps', run: () => runBaseline('baseline-1rps', args) },
    { name: 'baseline-5rps', run: () => runBaseline('baseline-5rps', args) },
    { name: 'burst', run: () => runBurst(args) },
    { name: 'long-2000', run: () => runLong({ ...args, requests: 2_000 }) },
    { name: 'long-10000', run: () => runLong({ ...args, requests: 10_000 }) },
    { name: 'route', run: () => runHttpScenario('route', args, {
      intervals: { route: 1_000 }, routeMutations: true,
    }) },
    { name: 'retention', run: () => runRetention(args) },
  ];
  for (const step of steps) {
    try {
      scenarios[step.name] = await step.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      notes.push(`scenario_failed:${step.name}:${message}`);
      continue;
    }
  }
  return {
    schema: 1,
    kind: 'capacity-summary',
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
    scenarios,
    notes,
    ok: Object.keys(scenarios).length === steps.length
      && Object.values(scenarios).every(report => report.ok),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'capacity_args_invalid'}\n`);
    process.exitCode = 2;
    return;
  }
  if (requiresLongRunAck(args) && !args.acknowledgeLongRun) {
    process.stderr.write('capacity_long_run_not_acknowledged\n');
    process.exitCode = 2;
    return;
  }
  // `--slice-budget` 只属于切片场景。别的场景给它是把场景和预算配错，
  // 一律拒绝：静默丢掉这份预算，报告看起来像跑过切片，实际没有。
  if (args.sliceBudget !== undefined && args.scenario !== 'long-10000-slice') {
    process.stderr.write('capacity_slice_scenario_required\n');
    process.exitCode = 2;
    return;
  }
  // 切片场景的笔数固定为 10,000：换掉输入就不是与 `long-10000` 的同一次对比了。
  // 参数不合在跑之前退出 2，不留一份"跑了才发现换个输入"的报告。
  if (args.scenario === 'long-10000-slice'
      && args.requests !== undefined && args.requests !== LONG_REQUESTS) {
    process.stderr.write('capacity_invalid_requests\n');
    process.exitCode = 2;
    return;
  }
  switch (args.scenario) {
    case 'budget': {
      // 预算只能从 `all` 汇总生成：单场景报告生成不了"全部场景"的预算，
      // 用它冒充全部会把没跑到的场景静默漏掉。
      const out = args.out;
      if (out === undefined || out.length === 0) {
        process.stderr.write('capacity_budget_out_required\n');
        process.exitCode = 2;
        return;
      }
      let budget: CapacityBudget;
      try {
        budget = deriveBudget(loadSummary(args.report), { sourceReport: args.report });
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'capacity_budget_invalid'}\n`);
        process.exitCode = 2;
        return;
      }
      writeJson(out, budget);
      const unmet = Object.keys(budget.unmet);
      process.stdout.write(`${JSON.stringify({
        out, sha256: sha256File(out), scenarios: Object.keys(budget.scenarios), unmet,
      }, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }
    case 'calibrate':
      process.stderr.write('capacity_calibrate_not_implemented\n');
      process.exitCode = 2;
      return;
    case 'all': {
      const summary = await runAll(args);
      writeJson(args.report, summary);
      process.exitCode = summary.ok ? 0 : 1;
      return;
    }
    case 'burst': {
      const report = await runBurst(args);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'long': {
      const report = await runLong(args);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'long-10000-slice': {
      // 预算在跑之前读：缺切片预算、文件缺切片节、字段对不上，都在启动前退出 2，
      // 不留一份"跑了一半才发现没预算"的报告。
      const budgetPath = args.sliceBudget;
      if (budgetPath === undefined) {
        process.stderr.write('capacity_slice_budget_missing\n');
        process.exitCode = 2;
        return;
      }
      let reading: SliceBudgetReading;
      try {
        reading = loadSliceBudget(budgetPath);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'capacity_slice_budget_missing'}\n`);
        process.exitCode = 2;
        return;
      }
      const report = await runLong(args, reading);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'retention': {
      const report = await runRetention(args);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'smoke': {
      const report = await runHttpScenario('smoke', args);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'baseline-1rps':
    case 'baseline-5rps': {
      const report = await runBaseline(args.scenario, args);
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'route': {
      const report = await runHttpScenario('route', args, {
        intervals: { route: 1_000 }, routeMutations: true,
      });
      writeJson(args.report, report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'capacity_failed'}\n`);
    process.exit(1);
  });
}
