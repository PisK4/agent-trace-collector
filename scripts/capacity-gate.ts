/**
 * 容量报告、预算与门槛的共享形状与判定。
 *
 * 负载端写报告、门槛端读报告与预算，两边必须使用同一份字段定义。
 * 预算里的每个上限都带 `basis`：它是代码常量、产品目标、基线包络还是提案值，
 * 读者不必猜这个数字是从哪来的；同时收紧的一条规则是——速率场景的下限取自
 * 计划刻度数，不取自这一轮实际发出多少，采集器跟不上时不能把自己的缺口
 * 冻结成标准。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DurationSummary } from '../src/capacity';

export type { DurationSummary };

export type ThresholdBasis = 'code-constant' | 'product-target' | 'baseline-envelope' | 'proposed';

export type ScenarioBudget = {
  basis: Record<string, ThresholdBasis>;
  max: Record<string, number>;
  min: Record<string, number>;
};

/** 门槛失败项：`check` 是扁平化指标名，`basis` 是该上限的来源。 */
export type GateFailure = {
  scenario: string;
  check: string;
  actual: number;
  limit: number;
  kind: 'max' | 'min';
  basis: string;
};

export type CapacityBudget = {
  schema: 1;
  frozen_at: string;
  source_report: string;
  source_report_sha256: string;
  bun_version: string;
  scenarios: Record<string, ScenarioBudget>;
  /**
   * 冻结时源报告就已经越过的门槛，按场景列失败项。
   * 它让"这份预算里哪些目标当前构型没达到"成为预算自身的事实，
   * 而不是靠读者另找一份实验记录对照。
   */
  unmet: Record<string, GateFailure[]>;
  retention: {
    max: Record<string, number>;
    basis: Record<string, ThresholdBasis>;
  };
  slice?: {
    frozen_at: string;
    source_calibration: string;
    max: Record<string, number>;
    basis: Record<string, ThresholdBasis>;
    derive_budget: {
      max_requests_per_slice: number;
      max_writes_per_slice: number;
      max_candidates_per_call: number;
      max_fingerprints_per_request: number;
      max_slice_ms: number;
      max_generation_bytes: number;
      max_wal_bytes: number;
      retain_generations: number;
    };
  };
};

export type StorageReading = {
  db_bytes: number;
  wal_bytes: number;
  temp_bytes: number;
  body_bytes: number;
  total_bytes: number;
  freelist_count: number;
};

export type ScenarioReport = {
  schema: 1;
  scenario: string;
  mode: 'baseline' | 'optimized' | 'slice';
  started_at: string;
  duration_ms: number;
  seed: number;
  environment: { bun: string; platform: string; arch: string };
  config: Record<string, number | string | boolean | null>;
  client: {
    attempts: number;
    accepted: number;
    duplicates: number;
    retried: number;
    failed: number;
    /** 页面读取轮询的非 2xx 或网络失败次数；非零时报告不能算通过。 */
    query_failed: number;
    /** 按计划发出的请求数（含 burst 的重放）。 */
    launched: number;
    /** 到点的刻度数：计划速率乘实际时长。 */
    ticks_scheduled: number;
    /** 到点却因在途上限已满而没发出的刻度数；非零说明计划速率没被真正施加上去。 */
    ticks_dropped: number;
    /** 在途请求峰值；贴住 `config.concurrency` 说明负载端自己成了瓶颈。 */
    in_flight_peak: number;
    hook_latency: DurationSummary;
    query_latency: DurationSummary;
  };
  collector: {
    started_at_ms: number;
    uptime_ms: number;
    ingest: {
      accepted: number;
      duplicates: number;
      rejected_total: number;
      rejected_by_reason: Record<string, number>;
      accepted_request_bytes: number;
      accepted_reply_bytes: number;
    };
    writer: { count: number; total_ms: number; max_ms: number };
    event_loop: DurationSummary & { interval_ms: number };
    jobs: Record<string, { count: number; total_ms: number; max_ms: number }>;
    route: { polls: number; files_seen: number; decoded: number; unchanged: number; errors: number };
    rss_peak_bytes: number;
    storage_peak: StorageReading;
    storage_end: StorageReading;
    /** 峰值来自几次实际快照；0 表示只有最终快照且采样失败。 */
    peak_samples: number;
    metadata: {
      clean_groups: number;
      source_facts_json_bytes: number;
      projection_meta_json_bytes: number;
      queue_clean_bytes: number;
      result_metadata_bytes: number;
      total_bytes: number;
      per_clean_group_bytes: number | null;
      per_request_bytes: number | null;
    };
    derive_queue: {
      pending_groups: number;
      oldest_dirty_since_ms: number | null; oldest_dirty_age_ms: number | null;
      oldest_request_started_ms: number | null; oldest_request_age_ms: number | null;
    };
  };
  derive: {
    backlog_max_age_ms: number | null;
    drain_ms: number | null;
    drain_polls: number;
    pending_groups_end: number;
    comparisons: number | null;
    decodes: number | null;
    full_incremental_equal: boolean | null;
    result_sha256: string | null;
    published_generations: number | null;
    discarded_generations: number | null;
  };
  conservation: {
    hook_accepted: number;
    raw_hook_rows: number;
    request_rows: number;
    evidence_rows: number;
    route_rows: number;
    /** 停止输入后仍未对账合并的 hook 行数；非零表示请求数还会变。 */
    pending_hooks: number;
    /** 停止后仍未关闭的来源缺口数；非零表示账本还没读完。 */
    open_gaps: number;
    missing: string[];
  };
  notes: string[];
  ok: boolean;
};

/** `all` 的汇总报告：`scenarios` 里每个场景的报告形状与单跑一致。 */
export type ScenarioSummary = {
  schema: 1;
  kind: 'capacity-summary';
  started_at: string;
  duration_ms: number;
  environment: { bun: string; platform: string; arch: string };
  scenarios: Record<string, ScenarioReport>;
  notes: string[];
  ok: boolean;
};

function readText(path: string, missingCode: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missingCode);
    throw error;
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 单场景报告。字段缺失在这里就失败，让后面的判定只处理已校验的输入。 */
export function loadReport(path: string): ScenarioReport {
  const text = readText(path, 'capacity_report_missing');
  let parsed: ScenarioReport;
  try {
    parsed = JSON.parse(text) as ScenarioReport;
  } catch {
    throw new Error('capacity_report_invalid');
  }
  if (parsed.schema !== 1 || typeof parsed.scenario !== 'string' || parsed.derive === undefined) {
    throw new Error('capacity_report_invalid');
  }
  return parsed;
}

/**
 * 汇总报告。`all` 一次跑完全部场景，逐场景的报告都在 `scenarios` 里；
 * 门槛与预算都从这一份文件读，不必拼多份单跑报告。
 */
export function loadSummary(path: string): ScenarioSummary {
  const text = readText(path, 'capacity_report_missing');
  let parsed: ScenarioSummary;
  try {
    parsed = JSON.parse(text) as ScenarioSummary;
  } catch {
    throw new Error('capacity_report_invalid');
  }
  if (parsed.schema !== 1 || parsed.kind !== 'capacity-summary'
      || typeof parsed.scenarios !== 'object' || parsed.scenarios === null) {
    throw new Error('capacity_report_invalid');
  }
  for (const [name, report] of Object.entries(parsed.scenarios)) {
    if (report.scenario !== name || report.derive === undefined) {
      throw new Error('capacity_report_invalid');
    }
  }
  return parsed;
}

/** 报告里的一个场景可能整段缺席；缺席按失败记，不当 0 也不跳过。 */
export function loadScenarioReports(path: string): ScenarioReport[] {
  const text = readText(path, 'capacity_report_missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('capacity_report_invalid');
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === 'capacity-summary') {
    return Object.values(loadSummary(path).scenarios);
  }
  return [loadReport(path)];
}

/** 预算。缺字段与非法数值都在这里拒绝，判定阶段不再做形状检查。 */
export function loadBudget(path: string): CapacityBudget {
  const text = readText(path, 'capacity_budget_missing');
  let parsed: CapacityBudget;
  try {
    parsed = JSON.parse(text) as CapacityBudget;
  } catch {
    throw new Error('capacity_budget_invalid');
  }
  if (parsed.schema !== 1 || typeof parsed.frozen_at !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.source_report_sha256)
      || parsed.scenarios === null || typeof parsed.scenarios !== 'object'
      || parsed.unmet === null || typeof parsed.unmet !== 'object') {
    throw new Error('capacity_budget_invalid');
  }
  for (const scenario of Object.values(parsed.scenarios)) {
    if (scenario.max === null || scenario.min === null || scenario.basis === null) {
      throw new Error('capacity_budget_invalid');
    }
    for (const [key, value] of [...Object.entries(scenario.max), ...Object.entries(scenario.min)]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('capacity_budget_invalid');
      if (scenario.basis[key] === undefined) throw new Error('capacity_budget_invalid');
    }
  }
  return parsed;
}

/**
 * 报告扁平化为"指标名 → 数字或 null"。
 * null 表示这次跑没测到（例如超时后 drain_ms 为 null），判定阶段算失败而不是 0。
 */
export function flattenReport(report: ScenarioReport): Record<string, number | null> {
  const rejected = report.collector.ingest.rejected_by_reason;
  const peak = report.collector.storage_peak;
  return {
    hook_latency_p95_ms: report.client.hook_latency.p95_ms,
    hook_latency_p99_ms: report.client.hook_latency.p99_ms,
    query_latency_p95_ms: report.client.query_latency.p95_ms,
    max_write_tx_ms: report.collector.writer.max_ms,
    event_loop_p99_ms: report.collector.event_loop.p99_ms,
    rss_peak_bytes: report.collector.rss_peak_bytes,
    peak_samples: report.collector.peak_samples,
    /**
     * 积压年龄为空表示整轮都没见过脏组，"最老积压 0"才是它的事实；
     * 与 `drain_ms` 的 null（超时未收敛）不是一回事，不能都当缺失。
     */
    backlog_max_age_ms: report.derive.backlog_max_age_ms ?? 0,
    drain_ms: report.derive.drain_ms,
    pending_groups_end: report.derive.pending_groups_end,
    rejected_total: report.collector.ingest.rejected_total,
    rejected_busy: rejected.busy ?? 0,
    rejected_insufficient_storage: rejected.insufficient_storage ?? 0,
    rejected_writer_failed: rejected.writer_failed ?? 0,
    client_failed: report.client.failed,
    client_query_failed: report.client.query_failed,
    accepted: report.client.accepted,
    launched: report.client.launched,
    ticks_scheduled: report.client.ticks_scheduled,
    ticks_dropped: report.client.ticks_dropped,
    in_flight_peak: report.client.in_flight_peak,
    raw_hook_rows: report.conservation.raw_hook_rows,
    request_rows: report.conservation.request_rows,
    evidence_rows: report.conservation.evidence_rows,
    pending_hooks: report.conservation.pending_hooks,
    open_gaps: report.conservation.open_gaps,
    db_bytes: peak.db_bytes,
    wal_bytes: peak.wal_bytes,
    temp_bytes: peak.temp_bytes,
    db_wal_temp_bytes: peak.db_bytes + peak.wal_bytes + peak.temp_bytes,
    body_bytes_peak: peak.body_bytes,
    metadata_total_bytes: report.collector.metadata.total_bytes,
    metadata_per_clean_group_bytes: report.collector.metadata.per_clean_group_bytes,
    metadata_per_request_bytes: report.collector.metadata.per_request_bytes,
    source_facts_json_bytes: report.collector.metadata.source_facts_json_bytes,
  };
}

const ENVELOPE_MARGIN = 1.25;

function ceilMargin(value: number, margin = ENVELOPE_MARGIN): number {
  return Math.ceil(value * margin) + 1;
}

/**
 * 计划请求数：速率场景取 `ticks_scheduled`，长组取 `config.requests`，
 * 两者都没有（burst）才退回实测接受数。前两者与"这一轮发出多少"无关，
 * 所以采集器跟不上时下限不会跟着降。
 */
function plannedRequests(report: ScenarioReport): { value: number; basis: ThresholdBasis } | null {
  const ticks = report.client.ticks_scheduled;
  if (ticks > 0) return { value: Math.floor(ticks * 0.99), basis: 'product-target' };
  const requests = report.config.requests;
  if (typeof requests === 'number' && requests > 0) return { value: requests, basis: 'product-target' };
  return null;
}

/** 单场景预算。测试与逐场景冻结都走这里，汇总冻结只是把它跑七遍。 */
export function deriveScenarioBudget(report: ScenarioReport): ScenarioBudget {
  const flat = flattenReport(report);
  const max: Record<string, number> = {};
  const min: Record<string, number> = {};
  const basis: Record<string, ThresholdBasis> = {};
  // 只设这次真测到过的上限：没测到就设个 0 门槛会变成"永远失败"，
  // 设个大数值又等于没有门槛，两种都在伪造结论。长组不发 HTTP，时延指标因此不进它的预算。
  //
  // 有目标值的指标直接用目标，不拿单轮包络去收紧：同一个 1 rps 场景两次跑，
  // page 读 p95 是 33 ms 与 153 ms，差出四倍多，比一成半的余量大得多，
  // 用单轮包络当上限只会造出抖动红门。包络只用于单调量（rss、存储字节、拒绝计数）。
  const measuredLimit = (key: string, target: number | null, targetBasis: ThresholdBasis): void => {
    const value = flat[key];
    if (value === null || value === undefined) return;
    if (target === null) {
      max[key] = Math.max(1, ceilMargin(value));
      basis[key] = 'baseline-envelope';
      return;
    }
    max[key] = Math.max(1, target);
    basis[key] = targetBasis;
  };
  const absoluteLimit = (key: string, limit: number, source: ThresholdBasis): void => {
    max[key] = limit;
    basis[key] = source;
  };

  measuredLimit('hook_latency_p95_ms', 2_000, 'product-target');
  measuredLimit('hook_latency_p99_ms', 2_500, 'product-target');
  measuredLimit('query_latency_p95_ms', 100, 'product-target');
  measuredLimit('event_loop_p99_ms', 100, 'product-target');
  // 写事务上限没有产品目标：900 是提案值，"其它连接最多等写锁 1000 ms"说明不了
  // 900 ms 的事务必然提交，所以它只标 proposed。
  measuredLimit('max_write_tx_ms', 900, 'proposed');
  measuredLimit('rss_peak_bytes', null, 'baseline-envelope');
  measuredLimit('db_wal_temp_bytes', null, 'baseline-envelope');
  measuredLimit('body_bytes_peak', null, 'baseline-envelope');
  measuredLimit('rejected_total', null, 'baseline-envelope');
  measuredLimit('rejected_busy', null, 'baseline-envelope');
  // 排空与积压年龄是提案值，还没有证据支持更小的数。
  absoluteLimit('drain_ms', 120_000, 'proposed');
  absoluteLimit('backlog_max_age_ms', 30_000, 'proposed');
  for (const key of [
    'pending_groups_end', 'pending_hooks', 'open_gaps',
    'rejected_insufficient_storage', 'rejected_writer_failed',
    'client_failed', 'client_query_failed',
  ]) {
    absoluteLimit(key, 0, 'code-constant');
  }
  // 计划速率必须真发出去：丢弃的刻度不是"跑得慢"，是这一档根本没测到。
  absoluteLimit('ticks_dropped', 0, 'product-target');

  const planned = plannedRequests(report);
  const ticks = report.client.ticks_scheduled;
  const measuredFloor = (value: number | null): { value: number; basis: ThresholdBasis } => ({
    value: Math.max(0, Math.floor((value ?? 0) * 0.99)),
    basis: 'baseline-envelope',
  });
  // 速率场景必须真把计划的请求发出去，所以 `accepted` 与 `launched` 的下限也钉计划刻度；
  // 长组不发 HTTP，`accepted` 只能按实测，真正的不变式落在 `request_rows` 上。
  const acceptedFloor = ticks > 0 && planned !== null ? planned : measuredFloor(flat.accepted);
  min.accepted = acceptedFloor.value;
  basis.accepted = acceptedFloor.basis;
  min.launched = acceptedFloor.value;
  basis.launched = acceptedFloor.basis;
  const rowsFloor = planned ?? measuredFloor(flat.request_rows);
  min.request_rows = rowsFloor.value;
  basis.request_rows = rowsFloor.basis;
  return { max, min, basis };
}

/** 汇总预算：逐场景生成，并把源报告就已经越过的门槛记进 `unmet`。 */
export function deriveBudget(
  summary: ScenarioSummary,
  input: { sourceReport: string },
): CapacityBudget {
  const scenarios: Record<string, ScenarioBudget> = {};
  const unmet: Record<string, GateFailure[]> = {};
  for (const [name, report] of Object.entries(summary.scenarios)) {
    const budget = deriveScenarioBudget(report);
    scenarios[name] = budget;
    const failures = evaluateScenarioLimits(report, budget);
    if (failures.length > 0) unmet[name] = failures;
  }
  return {
    schema: 1,
    frozen_at: new Date().toISOString(),
    source_report: input.sourceReport,
    source_report_sha256: sha256File(input.sourceReport),
    bun_version: summary.environment.bun,
    scenarios,
    unmet,
    retention: {
      max: {
        retention_max_ms: scenarios['retention']?.max.max_write_tx_ms ?? 900,
        cost_max_ms: scenarios['retention']?.max.max_write_tx_ms ?? 900,
        raw_prune_max_ms: scenarios['retention']?.max.max_write_tx_ms ?? 900,
      },
      basis: {
        retention_max_ms: 'proposed',
        cost_max_ms: 'proposed',
        raw_prune_max_ms: 'proposed',
      },
    },
  };
}

function evaluateScenarioLimits(report: ScenarioReport, limits: ScenarioBudget): GateFailure[] {
  const flat = flattenReport(report);
  const failures: GateFailure[] = [];
  for (const [check, limit] of Object.entries(limits.max)) {
    const actual = flat[check];
    if (actual === null || actual === undefined) {
      failures.push({ scenario: report.scenario, check, actual: -1, limit, kind: 'max', basis: limits.basis[check] ?? 'missing' });
    } else if (actual > limit) {
      failures.push({ scenario: report.scenario, check, actual, limit, kind: 'max', basis: limits.basis[check] ?? 'missing' });
    }
  }
  for (const [check, limit] of Object.entries(limits.min)) {
    const actual = flat[check];
    if (actual === null || actual === undefined || actual < limit) {
      failures.push({
        scenario: report.scenario, check, actual: actual ?? -1, limit, kind: 'min',
        basis: limits.basis[check] ?? 'missing',
      });
    }
  }
  return failures;
}

/** 一份报告对一份预算：报告场景不在预算里就是失败，不当作"没这项门槛"。 */
export function evaluateGate(report: ScenarioReport, budget: CapacityBudget): GateFailure[] {
  const limits = budget.scenarios[report.scenario];
  if (limits === undefined) {
    return [{ scenario: report.scenario, check: 'scenario', actual: -1, limit: 1, kind: 'max', basis: 'schema' }];
  }
  return evaluateScenarioLimits(report, limits);
}

/** 汇总逐场景判：预算里多出来的场景同样记失败，不静默跳过。 */
export function evaluateReports(reports: readonly ScenarioReport[], budget: CapacityBudget): GateFailure[] {
  const failures: GateFailure[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    seen.add(report.scenario);
    failures.push(...evaluateGate(report, budget));
  }
  for (const scenario of Object.keys(budget.scenarios)) {
    if (!seen.has(scenario)) {
      failures.push({ scenario, check: 'scenario', actual: -1, limit: 1, kind: 'max', basis: 'schema' });
    }
  }
  return failures;
}

function required(args: Map<string, string>, flag: string): string {
  const value = args.get(flag);
  if (value === undefined || value.length === 0) throw new Error(`capacity_flag_value_missing:${flag}`);
  return value;
}

/** 只认 `--budget` 与 `--report`；未知标志直接拒绝，避免把参数拼错当成通过。 */
function parseGateArgs(argv: readonly string[]): { budget: string; report: string } {
  if (argv[0] !== 'gate') throw new Error(`capacity_gate_unknown_command:${argv[0] ?? ''}`);
  const args = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]!;
    if (flag !== '--budget' && flag !== '--report') throw new Error(`capacity_unknown_flag:${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`capacity_flag_value_missing:${flag}`);
    args.set(flag, value);
  }
  return { budget: required(args, '--budget'), report: required(args, '--report') };
}

if (import.meta.main) {
  try {
    const { budget: budgetPath, report: reportPath } = parseGateArgs(Bun.argv.slice(2));
    let budget: CapacityBudget;
    let reports: ScenarioReport[];
    try {
      budget = loadBudget(budgetPath);
      reports = loadScenarioReports(reportPath);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'capacity_gate_invalid'}\n`);
      process.exit(2);
    }
    const failures = evaluateReports(reports, budget);
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, scenarios: reports.map(r => r.scenario), failures }, null, 2)}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'capacity_gate_invalid'}\n`);
    process.exit(2);
  }
}