/** 维护 CLI：参数解析、锁获取与命令分派。所有命令要求 collector 已停止。 */

import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { openStore } from '../store';
import type { Store } from '../store';
import { backupBundle, backupDatabase, restoreBundle } from './backup';
import { assertWindow, hookDeliveryReport } from './delivery';
import { acquireMaintenanceLock, type LockHandle } from './lock';
import { previewHookIdentityMigration, migrateHookIdentity } from './identity';
import { previewMetadataPurge, purgeMetadata } from './purge';
import { rebuildSession } from './rebuild';
import { reparseProtocol } from './reparse';
import { verifyDatabase } from './verify';

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), true);
    } else {
      flags.set(token.slice(2), next);
      index += 1;
    }
  }
  return flags;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 窗口端点接受 epoch 毫秒或 ISO 8601；解析失败返回 null，由调用方按用法错误退出。 */
function momentFlag(flags: Map<string, string | true>, name: string): number | null {
  const value = stringFlag(flags, name);
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const USAGE = `usage:
  maintain verify --db <path>
  maintain hook-delivery --db <path> --since <ISO|ms> --until <ISO|ms>
  maintain backup --db <path> --out <new-path>
  maintain bundle --dir <dataDir> --out <new-dir>
  maintain restore --bundle <bundleDir> --out <new-dir>
  maintain rebuild --db <path> --session <conv_key>
  maintain reparse --db <path> --protocol <name>
  maintain migrate-hook-identity --db <path> [--apply --approval-id <id>]
  maintain purge-metadata --db <path> --before <YYYY-MM-DD> [--apply --approval-id <id>]
`;

/**
 * CLI 入口。退出码：0 成功，1 失败，2 用法错误。
 * 所有命令先取维护锁；取不到就退出，不猜是不是自己上一次留下的。
 */
export async function runMaintenance(argv: string[], io: {
  out?: (line: string) => void;
  err?: (line: string) => void;
} = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);

  // bundle 与 restore 的路径参数是数据目录，不是库文件；单独解析，避免把 --db 的语义混进来。
  if (command === 'bundle' || command === 'restore') {
    const source = stringFlag(flags, command === 'bundle' ? 'dir' : 'bundle');
    const destination = stringFlag(flags, 'out');
    if (source === null || destination === null) {
      err(USAGE.trimEnd());
      return 2;
    }
    try {
      if (command === 'bundle') {
        backupBundle(source, destination);
        out(JSON.stringify({ ok: true, bundle: destination }));
      } else {
        restoreBundle(source, destination);
        out(JSON.stringify({ ok: true, restored: destination }));
      }
      return 0;
    } catch (error) {
      err(`${command}_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    }
  }

  const dbPath = stringFlag(flags, 'db');
  if (command === undefined || dbPath === null) {
    err(USAGE.trimEnd());
    return 2;
  }

  if (command === 'backup') {
    const destination = stringFlag(flags, 'out');
    if (destination === null) {
      err(USAGE.trimEnd());
      return 2;
    }
    const lock = acquireMaintenanceLock(dirname(dbPath), `backup:${process.pid}`);
    if (lock === null) {
      err('maintenance_lock_held');
      return 1;
    }
    try {
      const result = backupDatabase(dbPath, destination);
      // 只含数据库：没有盐，恢复不了占位符连续性。别让调用方把这个结果当成可恢复快照。
      out(JSON.stringify({ ok: true, ...result, ingestion_restorable: false }));
      return 0;
    } catch (error) {
      err(`backup_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally {
      lock.release();
    }
  }

  if (command === 'hook-delivery') {
    const sinceMs = momentFlag(flags, 'since');
    const untilMs = momentFlag(flags, 'until');
    if (sinceMs === null || untilMs === null) {
      err(USAGE.trimEnd());
      return 2;
    }
    try {
      assertWindow({ sinceMs, untilMs });
      // 只读诊断：独立只读连接，不取维护锁，不停采集器。
      const db = new Database(dbPath, { readonly: true });
      try {
        out(JSON.stringify({ ok: true, ...hookDeliveryReport(db, { sinceMs, untilMs }) }));
      } finally {
        db.close();
      }
      return 0;
    } catch (error) {
      err(`hook-delivery_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    }
  }

  if (command === 'verify' || command === 'purge-metadata' || command === 'rebuild'
    || command === 'reparse' || command === 'migrate-hook-identity') {
    // verify 只读，不需要锁；其余命令写库，必须有。
    let store: Store | null = null;
    let lock: LockHandle | null = null;
    try {
      if (command === 'verify') {
        out(JSON.stringify({ ok: true, ...verifyDatabase(dbPath) }));
        return 0;
      }
      if (command === 'rebuild' || command === 'reparse') {
        const argument = stringFlag(flags, command === 'rebuild' ? 'session' : 'protocol');
        if (argument === null) {
          err(USAGE.trimEnd());
          return 2;
        }
        lock = acquireMaintenanceLock(dirname(dbPath), `${command}:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        if (command === 'rebuild') {
          const report = rebuildSession(store, argument);
          out(JSON.stringify({ ok: true, session: argument, ...report }));
        } else {
          // 被拒绝与单独失败的行都进报告：原样保留，不把跳过写成通过。
          const report = reparseProtocol(store, argument);
          out(JSON.stringify({ ok: true, ...report }));
        }
        return 0;
      }
      if (command === 'migrate-hook-identity') {
        lock = acquireMaintenanceLock(dirname(dbPath), `migrate-hook-identity:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const preview = previewHookIdentityMigration(store);
        if (flags.get('apply') !== true) {
          out(JSON.stringify({ ok: true, applied: false, ...preview }));
          return 0;
        }
        const approvalId = stringFlag(flags, 'approval-id');
        if (approvalId === null) {
          out(JSON.stringify({ ok: false, error: 'approval_id_required', ...preview }));
          return 1;
        }
        const report = migrateHookIdentity(store);
        out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...report }));
        return 0;
      }
      const before = stringFlag(flags, 'before');
      if (before === null || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
        err(USAGE.trimEnd());
        return 2;
      }
      lock = acquireMaintenanceLock(dirname(dbPath), `purge:${process.pid}`);
      if (lock === null) {
        err('maintenance_lock_held');
        return 1;
      }
      // 维护期间 collector 必须已停：写连接拿不到才说明没有别的进程在写。
      store = openStore(dbPath);
      const preview = previewMetadataPurge(store, before);
      if (flags.get('apply') !== true) {
        out(JSON.stringify({ ok: true, applied: false, before, ...preview }));
        return 0;
      }
      const approvalId = stringFlag(flags, 'approval-id');
      if (approvalId === null) {
        out(JSON.stringify({ ok: false, error: 'approval_id_required', before, ...preview }));
        return 1;
      }
      const result = purgeMetadata(store, before, approvalId);
      out(JSON.stringify({ ok: true, applied: true, before, approval_id: approvalId, ...result }));
      return 0;
    } catch (error) {
      err(`${command}_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally {
      store?.close();
      lock?.release();
    }
  }

  err(USAGE.trimEnd());
  return 2;
}

if (import.meta.main) {
  const code = await runMaintenance(process.argv.slice(2));
  process.exit(code);
}
