import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
  dataDir: string;
  port: number;
  ledgerPath: string;
  routingDir: string;
  magpieUrl: string;
  bodyBudget: number;
  diskLimit: number;
};

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
  };
  if (config.bodyBudget >= config.diskLimit) throw new Error('body_budget_not_below_disk_limit');
  return config;
}

function readLocalSecret(path: string): Uint8Array {
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

export function loadLocalSecret(dataDir: string, fileName: 'redaction.salt' | 'read.token'): Uint8Array {
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
