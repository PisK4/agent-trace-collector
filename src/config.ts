import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 切片派生的预算。
 *
 * 每一项都是切片路径的一个闸门：批的事务边界、暂存字节与 WAL 增长的上界、
 * 退役代际的保留数。预算文件（capacity-gate）与 `Config.deriveBudget` 共用
 * 这一形状，键名映射由类型推导，两侧不会各自漂移。
 */
export type DeriveBudget = {
  maxRequestMs: number;
  maxStageBatchMs: number;
  maxCandidatesPerBatch: number;
  maxWritesPerBatch: number;
  maxStagedBytes: number;
  maxWalGrowthBytes: number;
  maxRetiredGenerations: number;
};

export const DEFAULT_DERIVE_BUDGET: DeriveBudget = {
  maxRequestMs: 10,
  maxStageBatchMs: 250,
  maxCandidatesPerBatch: 100,
  maxWritesPerBatch: 500,
  maxStagedBytes: 64 * 1024 * 1024,
  maxWalGrowthBytes: 32 * 1024 * 1024,
  maxRetiredGenerations: 2,
};

/** 切片入口的运行期配置：预算、数据目录与库路径。 */
export type SliceRuntime = { budget: DeriveBudget; dataDir: string; dbPath: string };

export type Config = {
  dataDir: string;
  port: number;
  ledgerPath: string;
  routingDir: string;
  magpieUrl: string;
  bodyBudget: number;
  diskLimit: number;
  /** hook 回调的总投递预算；上限来自计划，不随环境放大。 */
  gatewayTimeoutMs: number;
  /** 容量实验用的作业间隔；生产配置不设置，缺省沿用各作业常量。 */
  intervals?: Partial<Record<IntervalKey, number>>;
  /**
   * 派生预算。设了就说明这个进程按切片路径派生；生产 `loadConfig` 不设置它，
   * 只有容量实验与显式启用切片的入口注入。
   */
  deriveBudget?: DeriveBudget;
};

const INTERVAL_KEYS = ['ledger', 'route', 'cost', 'probe', 'pending', 'derive', 'retention', 'rawPrune', 'gap'] as const;
export type IntervalKey = typeof INTERVAL_KEYS[number];

/**
 * 作业间隔的唯一读取点。只接受显式注入的正安全整数；生产 `loadConfig`
 * 不解析环境变量，缺省返回调用点的现有常量。
 */
export function intervalOf(
  config: Pick<Config, 'intervals'>,
  key: IntervalKey,
  fallback: number,
): number {
  const value = config.intervals?.[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_capacity_interval');
  return value;
}

export const GB = 1_000_000_000;
export const MiB = 1024 * 1024;
export const DEFAULT_PORT = 8320;

function parseSize(name: string, raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(GB|MB|MiB|B)?$/i.exec(raw.trim());
  if (!match) throw new Error(`invalid_${name}`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_${name}`);
  const unit = (match[2] ?? 'B').toUpperCase();
  const multiplier = unit === 'GB' ? GB : unit === 'MB' ? 1_000_000 : unit === 'MIB' ? MiB : 1;
  const bytes = Math.round(value * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`invalid_${name}`);
  return bytes;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error('invalid_port');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  return port;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = homedir();
  const config: Config = {
    dataDir: env.ATC_DATA_DIR?.trim() || join(home, 'Library', 'Application Support', 'agent-trace-collector'),
    port: env.ATC_PORT === undefined ? DEFAULT_PORT : parsePort(env.ATC_PORT),
    ledgerPath: env.ATC_LEDGER_PATH?.trim() || join(home, '.config', 'magpie', 'usage.jsonl'),
    routingDir: env.ATC_ROUTING_DIR?.trim() || join(home, '.config', 'magpie', 'routing'),
    magpieUrl: env.ATC_MAGPIE_URL?.trim() || 'http://127.0.0.1:3425',
    bodyBudget: env.ATC_BODY_BUDGET === undefined ? 10 * GB : parseSize('body_budget', env.ATC_BODY_BUDGET),
    diskLimit: env.ATC_DISK_LIMIT === undefined ? 16 * GB : parseSize('disk_limit', env.ATC_DISK_LIMIT),
    gatewayTimeoutMs: 2000,
  };
  if (config.bodyBudget >= config.diskLimit) throw new Error('body_budget_not_below_disk_limit');
  return config;
}

/**
 * 只读读取一份本地密钥文件，不生成、不修改。
 *
 * 备份与恢复要在"已经确认源库停止"之后立刻读盐，中间不能经过会创建文件的路径；
 * 权限与所有者校验与生成路径共用同一份实现。
 */
export function readLocalSecret(path: string): Uint8Array {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('local_secret_invalid_file');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('local_secret_owner_mismatch');
  }
  if ((info.mode & 0o077) !== 0) throw new Error('local_secret_permissions');
  if (info.size !== 32) throw new Error('local_secret_length');
  const bytes = readFileSync(path);
  if (bytes.length !== 32) throw new Error('local_secret_length');
  return new Uint8Array(bytes);
}

export type LocalSecretName = 'redaction.salt' | 'read.token' | 'hook.token';

export function loadLocalSecret(dataDir: string, fileName: LocalSecretName): Uint8Array {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, fileName);
  try {
    return readLocalSecret(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32);
  try {
    writeFileSync(path, generated, { flag: 'wx', mode: 0o600 });
    return new Uint8Array(generated);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readLocalSecret(path);
    throw error;
  }
}

/**
 * 盐的绑定标识。
 *
 * 存进库里的是这份标识而不是盐本身：数据库被单独拷走时，盐仍在文件系统上，
 * 库与盐是否配对则由标识判断。加域前缀是为了让这个哈希不能当作"盐"的通用指纹复用。
 */
export function saltId(salt: Uint8Array): string {
  return createHash('sha256').update('atc-redaction-salt-v1\0').update(salt).digest('hex');
}

export type SaltBinding = { format: 1; id: string };

/**
 * 读取并校验脱敏盐与库的绑定。
 *
 * 三种情况分开处理，都不允许悄悄生成新盐：
 * - 空库首次启动：生成盐并写入绑定。
 * - 有数据但没有绑定：拒绝（`redaction_salt_unbound`）。无法证明历史占位符是这份盐算的，
 *   也没有确认绕过的入口；旧库按破坏式替换处理，删除后重建。
 * - 有绑定但文件缺失或标识不符：拒绝（`redaction_salt_missing` / `redaction_salt_mismatch`）。
 */
export function loadBoundSaltTx(db: Database, dataDir: string): Uint8Array {
  const bound = db.query<{ value_json: string }, []>(
    "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
  const hasData = (db.query<{ n: number }, []>('SELECT EXISTS(SELECT 1 FROM request) AS n').get()?.n ?? 0) !== 0;
  const path = join(dataDir, 'redaction.salt');
  const exists = existsSync(path);
  // 库里有数据、或已经写过绑定，盐文件就是必须存在的：此时缺文件不是"首次启动"。
  if (!exists && (hasData || bound !== null)) throw new Error('redaction_salt_missing');
  if (bound === null && hasData) throw new Error('redaction_salt_unbound');
  const salt = exists
    ? readLocalSecret(path)
    : loadLocalSecret(dataDir, 'redaction.salt');
  if (bound !== null) {
    let saved: unknown;
    try {
      saved = JSON.parse(bound.value_json);
    } catch {
      throw new Error('redaction_salt_binding_invalid');
    }
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
      || (saved as { format?: unknown }).format !== 1
      || typeof (saved as { id?: unknown }).id !== 'string') {
      throw new Error('redaction_salt_binding_invalid');
    }
    if ((saved as { id: string }).id !== saltId(salt)) throw new Error('redaction_salt_mismatch');
    return salt;
  }
  const binding: SaltBinding = { format: 1, id: saltId(salt) };
  db.run("INSERT INTO collector_state(key,value_json) VALUES('privacy:salt',?)",
    [JSON.stringify(binding)]);
  return salt;
}
