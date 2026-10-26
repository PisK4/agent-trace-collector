/**
 * launchd 托管服务的探测面：定位本检出的服务条目、读进程状态、取监听端口与健康统计。
 *
 * 服务条目不按固定 label 猜：扫 `~/Library/LaunchAgents` 下的 plist，认 ProgramArguments
 * 里跑本检出 `src/main.ts` 的那一个。在 worktree 里跑、或者换了 label，都落到「本检出
 * 没有托管条目」，不会静默命中另一份检出的服务。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLocalSecret } from '../src/config';
import type { Stats } from '../src/queries/stats';

export type ServiceEntry = {
  label: string;
  plist: string;
  stdoutPath: string | null;
  stderrPath: string | null;
  /** plist 里的 EnvironmentVariables：运维脚本要按服务实际那份配置读令牌，不读调用者的 shell。 */
  env: Record<string, string>;
};

export type ServiceState = {
  label: string;
  /** launchd 报的作业状态，running / exited 等；读不到时为空。 */
  state: string | null;
  pid: number | null;
  runs: number | null;
  lastExitCode: number | null;
};

export const READY_TIMEOUT_MS = 30_000;
/** 启动时就绪探测用较短超时：新进程刚起来还没有长任务，慢就是没起来。 */
export const READY_PROBE_TIMEOUT_MS = 4000;

/** 顶层键在 `launchctl print` 里各占一行、正好一个制表符缩进；嵌套块的缩进更深。 */
function topLevel(name: string): RegExp {
  return new RegExp(`^\\t${name} = (.+)$`, 'm');
}

export function serviceTarget(label: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}/${label}`;
}

export function agentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

function readEntry(plist: string, mainPath: string): ServiceEntry | null {
  // plist 是二进制或 XML 都可能，交给 plutil 转成 JSON，不在脚本里写第二个解析器。
  const result = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', plist]);
  if (result.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const label = record.Label;
  const programArguments = record.ProgramArguments;
  if (typeof label !== 'string' || !Array.isArray(programArguments)) return null;
  if (!programArguments.includes(mainPath)) return null;
  const rawEnv = record.EnvironmentVariables;
  const env: Record<string, string> = {};
  if (rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return {
    label,
    plist,
    stdoutPath: typeof record.StandardOutPath === 'string' ? record.StandardOutPath : null,
    stderrPath: typeof record.StandardErrorPath === 'string' ? record.StandardErrorPath : null,
    env,
  };
}

/** 找跑本检出 `src/main.ts` 的 launchd 条目；没有就返回 null，不去猜别的服务。 */
export function findServiceEntry(repoRoot: string, directory = agentsDir()): ServiceEntry | null {
  const mainPath = join(repoRoot, 'src', 'main.ts');
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.plist')) continue;
    const entry = readEntry(join(directory, name), mainPath);
    if (entry !== null) return entry;
  }
  return null;
}

/**
 * 解析 `launchctl print` 的输出。条目没加载时 `launchctl` 以非零退出，调用方据此返回 null。
 *
 * 只认顶层缩进：嵌套块里也有 `state = active`，按行首匹配会把作业状态读成端点状态。
 */
export function parseServicePrint(text: string, label: string): ServiceState {
  const read = (pattern: RegExp): string | null => {
    const found = pattern.exec(text);
    return found === null ? null : found[1]!.trim();
  };
  const number = (name: string): number | null => {
    const raw = read(topLevel(name));
    return raw === null || !/^-?\d+$/.test(raw) ? null : Number(raw);
  };
  return {
    label,
    state: read(topLevel('state')),
    pid: number('pid'),
    runs: number('runs'),
    lastExitCode: number('last exit code'),
  };
}

/** 读作业状态；条目没加载（或 label 不存在）时返回 null。 */
export function readServiceState(label: string): ServiceState | null {
  const result = Bun.spawnSync(['launchctl', 'print', serviceTarget(label)]);
  if (result.exitCode !== 0) return null;
  return parseServicePrint(result.stdout.toString(), label);
}

/** 从进程实际持有的监听套接字取端口；进程还没开始监听时返回 null。 */
export function listeningPort(pid: number): number | null {
  const result = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
  if (result.exitCode !== 0) return null;
  const found = /:(\d+) \(LISTEN\)/.exec(result.stdout.toString());
  return found === null ? null : Number(found[1]);
}

/**
 * 进程启动时刻。`ps -o lstart=` 的输出随 locale 变（中文环境是 `一 10月/26 …`），
 * 固定 `LC_ALL=C` 才有 `Date.parse` 认得的英文月份。
 */
export function processStartedAt(pid: number): number | null {
  const result = Bun.spawnSync({
    cmd: ['ps', '-o', 'lstart=', '-p', String(pid)],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.exitCode !== 0) return null;
  const ms = Date.parse(result.stdout.toString().trim());
  return Number.isNaN(ms) ? null : ms;
}

/** 读页面读取令牌；文件缺失或权限不符时返回 null，不顺手生成新令牌。 */
export function readToken(dataDir: string): string | null {
  try {
    return Buffer.from(readLocalSecret(join(dataDir, 'read.token'))).toString('base64url');
  } catch {
    return null;
  }
}

export type ProbeResult =
  | { state: 'ok'; stats: Stats; elapsedMs: number }
  | { state: 'timeout' | 'unreachable' | 'http_error'; detail: string; elapsedMs: number };

/**
 * 探 `/api/stats`，并把失败分类与耗时带出来。
 *
 * 超时不是「没起来」：派生与费用作业在同一个事件循环里同步跑，单次任务可占用数秒，
 * 这时端口连得上、响应要到几秒后才回来。把超时和连不上分成两种结果，调用方才不会
 * 把一个忙着的采集器报成挂了。
 */
export async function probeStats(port: number, token: string,
  timeoutMs = 15_000): Promise<ProbeResult> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      state: timedOut ? 'timeout' : 'unreachable',
      detail: timedOut
        ? `超过 ${timeoutMs} 毫秒没有响应`
        : (error instanceof Error ? error.message : 'unknown'),
      elapsedMs: elapsed(),
    };
  }
  if (!response.ok) {
    return { state: 'http_error', detail: `http ${response.status}`, elapsedMs: elapsed() };
  }
  try {
    return { state: 'ok', stats: await response.json() as Stats, elapsedMs: elapsed() };
  } catch (error) {
    return {
      state: 'http_error',
      detail: error instanceof Error ? error.message : 'invalid_json',
      elapsedMs: elapsed(),
    };
  }
}

/** 取日志尾部若干非空行；文件不存在时返回空数组。 */
export function tailLines(path: string, count: number): string[] {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim().length > 0);
    return lines.slice(-count);
  } catch {
    return [];
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
