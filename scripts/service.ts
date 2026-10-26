/**
 * 采集器运维入口：status / restart / stop / start。
 *
 * 生产采集器由 launchd（`KeepAlive`）托管，所以这四个动作都不自己起停进程：
 * 直接 `kill` 会在一秒级内被重新拉起，再手动起一个就撞端口；停服务要走
 * `launchctl bootout`，让它不再重启，启动走 `bootstrap`。
 *
 * 判定「可用」不看 launchd 命令的退出码，看端口在听且 `/api/stats` 答得出来。
 * 用法：`bun run service <子命令>`；退出码 0 成功，1 失败，2 用法错误。
 */
import { dirname } from 'node:path';
import { loadConfig } from '../src/config';
import { maintenanceLockPresent } from '../src/maintenance/lock';
import type { Stats } from '../src/queries/stats';
import {
  READY_PROBE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  findServiceEntry,
  formatDuration,
  listeningPort,
  probeStats,
  processStartedAt,
  readServiceState,
  readToken,
  serviceTarget,
  tailLines,
} from './service-support';
import type { ServiceEntry, ServiceState } from './service-support';

const repository = dirname(import.meta.dir);
/**
 * 只有 `src/` 需要重启才生效：进程启动时把这些模块读进内存，之后不再重读。
 * `web/` 每次请求现读文件（改内容立即生效），新增页面文件要改 `src/http.ts` 的
 * 静态白名单，那本身是 `src/` 改动；`plugins/` 由 magpie 侧加载，重启采集器不影响它。
 */
const RUNTIME_PATHS = ['src'];
/** 日志尾部读这么多行再折叠连续重复：单看最后几行，实际全是同一条周期噪声。 */
const LOG_TAIL_LINES = 200;
const LOG_TAIL_GROUPS = 5;
const POLL_MS = 250;

const USAGE = `usage:
  service status    只看状态，不改动
  service restart   重启并等到可用
  service stop      停服务（launchctl bootout），维护命令之前用
  service start     启动并等到可用
`;

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function git(args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args]);
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function field(label: string, body: string): void {
  out(`${label}  ${body}`);
}

/** 进程启动时刻与最后一次 `src/` 改动的先后，加上工作区未提交改动的存在与否。 */
function runtimeFacts(startedAt: number | null): string {
  const parts: string[] = [];
  if (startedAt !== null) parts.push(`进程启动 ${clockOf(startedAt)}`);
  const head = git(['log', '-1', '--format=%ct%x09%h', '--', ...RUNTIME_PATHS])?.trim();
  if (head !== undefined && head.length > 0) {
    const [seconds, hash] = head.split('\t');
    const committedAt = Number(seconds) * 1000;
    if (Number.isFinite(committedAt)) {
      parts.push(`最后一次 src 改动 ${clockOf(committedAt)}（${hash}）`);
      if (startedAt !== null) parts.push(committedAt > startedAt ? '落后，需重启' : '未落后');
    }
  }
  const dirty = (git(['status', '--porcelain', '--', ...RUNTIME_PATHS]) ?? '')
    .split('\n').filter(row => row.trim().length > 0).length;
  if (dirty > 0) parts.push(`工作区另有 ${dirty} 处未提交改动，需确认`);
  return parts.length === 0 ? '不在 git 检出内，判断不了' : parts.join(' · ');
}

/** 折叠成「行 ×N」，保留首次出现顺序；采集器按周期重复写同一行，原样打出来只有噪声。 */
function collapse(lines: string[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!counts.has(line)) order.push(line);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return order.map(line => {
    const count = counts.get(line) ?? 1;
    return count === 1 ? line : `${line} ×${count}`;
  });
}

function jobLine(state: ServiceState): string {
  const startedAt = state.pid === null ? null : processStartedAt(state.pid);
  const uptime = startedAt === null ? null : formatDuration(Date.now() - startedAt);
  return [
    state.state ?? 'unknown',
    state.pid === null ? '无 pid' : `pid ${state.pid}`,
    uptime === null ? null : `已运行 ${uptime}`,
    state.runs === null ? null : `runs ${state.runs}`,
    state.lastExitCode === null ? null : `上次退出 ${state.lastExitCode}`,
  ].filter(part => part !== null).join(' · ');
}

function bodyStates(stats: Stats): string {
  if (stats.body_states.length === 0) return '无请求';
  return stats.body_states.map(row => `${row.state} ${row.count}`).join(' · ');
}

function backlog(stats: Stats): string {
  const issues = stats.issues.reduce((sum, row) => sum + row.count, 0);
  return [
    `待处理 hook ${stats.pending_hooks}`,
    `未闭合缺口 ${stats.open_gaps}`,
    `采集问题 ${issues}`,
  ].join(' · ');
}

function lagging(stats: Stats): string {
  const behind = stats.cursors.filter(cursor => cursor.observed_off > cursor.committed_off);
  if (behind.length === 0) return '全部追平';
  return behind
    .map(cursor => `${cursor.source_name} 落后 ${cursor.observed_off - cursor.committed_off} 字节`)
    .join(' · ');
}

/** 服务实际那一份配置：launchd 不继承 shell 环境，按调用者环境读会读错数据目录。 */
function configOf(entry: ServiceEntry): { dataDir: string; token: string | null } {
  const config = loadConfig(entry.env);
  return { dataDir: config.dataDir, token: readToken(config.dataDir) };
}

/**
 * 等新进程可用。必须等到与 `previousPid` 不同的 pid：`kickstart` 返回时旧进程
 * 可能还没退出，此时探到的是它，会误报重启成功。
 */
async function waitReady(entry: ServiceEntry, previousPid: number | null): Promise<ServiceState | null> {
  const { token } = configOf(entry);
  if (token === null) return null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readServiceState(entry.label);
    const pid = current?.pid ?? null;
    if (pid !== null && pid !== previousPid) {
      const port = listeningPort(pid);
      if (port !== null && (await probeStats(port, token, READY_PROBE_TIMEOUT_MS)).state === 'ok') {
        return current;
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

/**
 * 起停之前先把能提前发现的失败挡住，否则只是一次起不来的起停。
 * 错误码前缀按命令区分：`restart_failed` 与 `start_failed` 指向不同的排查方向。
 */
function preflight(entry: ServiceEntry, command: 'restart' | 'start'): boolean {
  const { dataDir, token } = configOf(entry);
  const lock = maintenanceLockPresent(dataDir);
  if (lock !== null) {
    err(`${command}_failed:maintenance_lock_present:${lock}`);
    err('维护命令正在跑，或留下了陈旧锁；确认后删除该文件再操作。');
    return false;
  }
  if (token === null) {
    err(`${command}_failed:read_token_unavailable`);
    err(`读不到 ${dataDir}/read.token；没有它无法确认进程可用。`);
    return false;
  }
  return true;
}

function reportFailure(entry: ServiceEntry, reason: string): void {
  const last = readServiceState(entry.label);
  err(`${reason}:state_${last?.state ?? 'not_loaded'}:pid_${last?.pid ?? 'none'}`
    + `:runs_${last?.runs ?? 'unknown'}:last_exit_${last?.lastExitCode ?? 'unknown'}`);
  for (const row of logTail(entry)) err(`  ${row}`);
}

/** 日志尾部的连续重复折叠掉：采集器按周期重复写同一行，原样打出来只有噪声。 */
function logTail(entry: ServiceEntry): string[] {
  if (entry.stderrPath === null) return [];
  return collapse(tailLines(entry.stderrPath, LOG_TAIL_LINES)).slice(-LOG_TAIL_GROUPS);
}

async function commandStatus(entry: ServiceEntry): Promise<number> {
  field('服务', [entry.label, entry.plist].join(' · '));
  const healthy = await reportService(entry);
  const tail = logTail(entry);
  if (tail.length > 0) {
    field('日志', `${entry.stderrPath} 尾部`);
    for (const row of tail) out(`      ${row}`);
  }
  return healthy ? 0 : 1;
}

/** 打印作业、代码、端口与统计；返回是否满足「在跑且可读」。 */
async function reportService(entry: ServiceEntry): Promise<boolean> {
  const state = readServiceState(entry.label);
  if (state === null) {
    field('作业', '未加载（launchctl 找不到这个 label）');
    field('用法', '`bun run service start` 启动');
    return false;
  }
  const startedAt = state.pid === null ? null : processStartedAt(state.pid);
  field('作业', jobLine(state));
  field('代码', runtimeFacts(startedAt));

  const port = state.pid === null ? null : listeningPort(state.pid);
  if (port === null) {
    field('端口', '未监听');
    return false;
  }
  const { token } = configOf(entry);
  if (token === null) {
    field('端口', `127.0.0.1:${port} · 读不到 read.token，无法探 /api/stats`);
    return false;
  }
  const probe = await probeStats(port, token);
  if (probe.state !== 'ok') {
    field('端口', `127.0.0.1:${port} · /api/stats ${probe.detail}（${probe.elapsedMs} 毫秒）`);
    return false;
  }
  field('端口', `127.0.0.1:${port} · /api/stats 可读（${probe.elapsedMs} 毫秒）`);
  const stats = probe.stats;
  field('请求', `${stats.requests} 笔`);
  field('正文', bodyStates(stats));
  field('积压', backlog(stats));
  field('游标', lagging(stats));
  if (stats.issues.length > 0) {
    field('问题', stats.issues.map(row => `${row.source_kind}/${row.reason} ${row.count}`).join(' · '));
  }
  return true;
}

async function commandRestart(entry: ServiceEntry): Promise<number> {
  const before = readServiceState(entry.label);
  // 已 bootout 的作业 kickstart 不起来，报清楚该用 start，别让 kickstart 的错误码糊过去。
  if (before === null) {
    err('restart_failed:not_loaded');
    err('作业不在 launchd 里；启动用 `bun run service start`。');
    return 1;
  }
  if (!preflight(entry, 'restart')) return 1;
  const startedAt = performance.now();
  const kick = Bun.spawnSync(['launchctl', 'kickstart', '-k', serviceTarget(entry.label)]);
  if (kick.exitCode !== 0) {
    err(`restart_failed:kickstart:${kick.stderr.toString().trim() || `exit_${kick.exitCode}`}`);
    return 1;
  }
  const ready = await waitReady(entry, before.pid ?? null);
  if (ready === null) {
    reportFailure(entry, `restart_failed:not_ready_after_${Math.round(READY_TIMEOUT_MS / 1000)}s`);
    return 1;
  }
  const port = listeningPort(ready.pid!);
  out(`${entry.label} 已重启：pid ${ready.pid}，端口 ${port}，`
    + `用时 ${formatDuration(performance.now() - startedAt)}`);
  return 0;
}

async function commandStop(entry: ServiceEntry): Promise<number> {
  const before = readServiceState(entry.label);
  if (before === null) {
    out(`${entry.label} 未加载，本来就是停的`);
    return 0;
  }
  const bootout = Bun.spawnSync(['launchctl', 'bootout', serviceTarget(entry.label)]);
  // bootout 只负责发信号：作业在进程退出前仍可查到，端口也还占着。
  // 所以必须轮询到「作业消失 + 端口释放」都成立，才叫停了。
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const loaded = readServiceState(entry.label) !== null;
    const listening = before.pid !== null && listeningPort(before.pid) !== null;
    if (!loaded && !listening) {
      out(`${entry.label} 已停止：原 pid ${before.pid ?? '无'}`);
      return 0;
    }
    await sleep(POLL_MS);
  }
  const last = readServiceState(entry.label);
  err(`stop_failed:still_${last === null ? 'listening' : 'loaded'}`
    + `:pid_${before.pid ?? 'none'}:bootout_exit_${bootout.exitCode}`
    + `:${bootout.stderr.toString().trim() || 'no_stderr'}`);
  return 1;
}

async function commandStart(entry: ServiceEntry): Promise<number> {
  const before = readServiceState(entry.label);
  if (before !== null) {
    err(`start_failed:already_loaded:pid_${before.pid ?? 'none'}`);
    err('已经在跑；要换代码用 `bun run service restart`。');
    return 1;
  }
  if (!preflight(entry, 'start')) return 1;
  const startedAt = performance.now();
  const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 0}`, entry.plist]);
  if (bootstrap.exitCode !== 0) {
    err(`start_failed:bootstrap:${bootstrap.stderr.toString().trim() || `exit_${bootstrap.exitCode}`}`);
    return 1;
  }
  const ready = await waitReady(entry, null);
  if (ready === null) {
    reportFailure(entry, `start_failed:not_ready_after_${Math.round(READY_TIMEOUT_MS / 1000)}s`);
    return 1;
  }
  const port = listeningPort(ready.pid!);
  out(`${entry.label} 已启动：pid ${ready.pid}，端口 ${port}，`
    + `用时 ${formatDuration(performance.now() - startedAt)}`);
  return 0;
}

export async function runService(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined) {
    err(USAGE.trimEnd());
    return 2;
  }
  const entry = findServiceEntry(repository);
  if (entry === null) {
    err('service_not_managed');
    err('没有 launchd 条目跑本检出的 src/main.ts；手动启动用 `bun run start`，不要 kill。');
    return 1;
  }
  if (command === 'status') return await commandStatus(entry);
  if (command === 'restart') return await commandRestart(entry);
  if (command === 'stop') return await commandStop(entry);
  if (command === 'start') return await commandStart(entry);
  err(USAGE.trimEnd());
  return 2;
}

if (import.meta.main) process.exit(await runService(process.argv.slice(2)));
