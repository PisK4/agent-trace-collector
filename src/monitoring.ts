/**
 * 诊断日志：结构化单行输出，只保留时间、进程实例、操作名、关联编号、阶段、
 * 耗时与结果码。不做日志框架：同一进程内按 key 限流，重复被抑制的次数随下次
 * 输出一起带上。
 *
 * 输出走调用方给的 sink（生产是 launchd 已接管的 stdout），归档与保留由
 * `scripts/monitor.ts` 的外部任务负责；本模块不打开、不改写、不清理文件。
 */

export type DiagnosticKind = 'lifecycle' | 'error' | 'slow' | 'derive';

export type DiagnosticEntry = {
  ts: string;
  instance: string;
  kind: DiagnosticKind;
  op: string;
  result: string;
  corr?: string;
  phase?: string;
  dur_ms?: number;
  suppressed?: number;
  version?: string;
  /** 只在失败结果上出现；已按固定分类归一。 */
  code?: string;
  /** 派生轮专用：Worker/主线程计算耗时与落库耗时分开记。 */
  compute_ms?: number;
  apply_ms?: number;
};

export type SlowThresholds = { syncMs: number; workerMs: number };

export const DEFAULT_SLOW_THRESHOLDS: SlowThresholds = { syncMs: 100, workerMs: 500 };
/** 同一 key 的重复错误与慢调用在这个窗口内只输出一次。 */
export const DEFAULT_THROTTLE_MS = 60_000;

export type DiagnosticLogOptions = {
  instance: string;
  version?: string;
  thresholds?: SlowThresholds;
  throttleMs?: number;
  sink?: (line: string) => void;
  now?: () => number;
};

export type DiagnosticLog = {
  readonly instance: string;
  readonly version: string;
  lifecycle(op: string, input?: {
    phase?: string; dur_ms?: number; result?: string; version?: string;
  }): void;
  error(op: string, input: {
    code: unknown; phase?: string; dur_ms?: number; corr?: string;
  }): void;
  slow(op: string, input: {
    phase?: string; dur_ms: number; corr?: string; result?: string;
  }, limitMs?: number): void;
  derive(input: {
    corr: string; result: string; phase?: string; dur_ms?: number; code?: unknown;
    compute_ms?: number; apply_ms?: number;
  }): void;
};

/**
 * 错误分类只用固定码。代码里约定用 snake_case 错误码；外部的
 * `ENOENT: no such file …` 这类自由文本一律归到 `unclassified`，
 * 不把路径、SQL 或正文带进日志。
 */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'unclassified';
}

export function createDiagnosticLog(options: DiagnosticLogOptions): DiagnosticLog {
  const thresholds = options.thresholds ?? DEFAULT_SLOW_THRESHOLDS;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = options.now ?? Date.now;
  const sink = options.sink ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const last = new Map<string, { at: number; suppressed: number }>();

  const write = (entry: DiagnosticEntry): void => {
    try {
      sink(JSON.stringify(entry));
    } catch {
      // 日志出口断开（例如 launchd 关闭 stdout）不能反过来打断采集。
    }
  };

  const throttled = (key: string, emit: (suppressed: number) => void): void => {
    const at = now();
    const previous = last.get(key);
    if (previous === undefined) {
      last.set(key, { at, suppressed: 0 });
      emit(0);
      return;
    }
    if (at - previous.at < throttleMs) {
      previous.suppressed += 1;
      return;
    }
    const suppressed = previous.suppressed;
    last.set(key, { at, suppressed: 0 });
    emit(suppressed);
  };

  const base = (kind: DiagnosticKind, op: string, result: string,
    input: { corr?: string; phase?: string; dur_ms?: number; version?: string },
    suppressed?: number): DiagnosticEntry => {
    const entry: DiagnosticEntry = {
      ts: new Date(now()).toISOString(),
      instance: options.instance,
      kind,
      op,
      result,
    };
    if (input.corr !== undefined) entry.corr = input.corr;
    if (input.phase !== undefined) entry.phase = input.phase;
    if (input.dur_ms !== undefined) entry.dur_ms = Math.round(input.dur_ms);
    if (input.version !== undefined) entry.version = input.version;
    if (suppressed !== undefined && suppressed > 0) entry.suppressed = suppressed;
    return entry;
  };

  return {
    instance: options.instance,
    version: options.version ?? 'unknown',
    lifecycle(op, input = {}) {
      write(base('lifecycle', op, input.result ?? 'ok', {
        phase: input.phase, dur_ms: input.dur_ms,
        version: input.version ?? options.version,
      }));
    },
    error(op, input) {
      // 结果码就是错误分类；限流按「操作 + 阶段 + 分类」分组。
      const code = errorCode(input.code);
      throttled(`error|${op}|${input.phase ?? ''}|${code}`, suppressed => {
        write(base('error', op, code, {
          corr: input.corr, phase: input.phase, dur_ms: input.dur_ms,
        }, suppressed));
      });
    },
    slow(op, input, limitMs = thresholds.syncMs) {
      if (!Number.isFinite(input.dur_ms) || input.dur_ms < limitMs) return;
      throttled(`slow|${op}|${input.phase ?? ''}|${input.result ?? 'ok'}`, suppressed => {
        write(base('slow', op, input.result ?? 'ok', input, suppressed));
      });
    },
    derive(input) {
      const entry = base('derive', 'derive.result', input.result, {
        corr: input.corr, phase: input.phase, dur_ms: input.dur_ms,
      });
      if (input.compute_ms !== undefined) entry.compute_ms = Math.round(input.compute_ms);
      if (input.apply_ms !== undefined) entry.apply_ms = Math.round(input.apply_ms);
      if (input.code !== undefined) entry.code = errorCode(input.code);
      write(entry);
    },
  };
}
