/** 维护 CLI：参数解析、锁获取与命令分派。所有命令要求 collector 已停止。 */

import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { localDay } from '../format';
import { openStore } from '../store';
import type { Store } from '../store';
import { backupBundle, backupDatabase, restoreBundle, withStoppedDatabase } from './backup';
import { previewBodyConsistency, reclassifyBodyConsistency,
  previewBodyBytesBackfill, backfillBodyBytes } from './body-consistency';
import { assertWindow, hookDeliveryReport } from './delivery';
import { previewCapacityMeter, recountCapacityMeter } from './capacity';
import { acquireMaintenanceLock, type LockHandle } from './lock';
import { previewHookIdentityMigration, migrateHookIdentity } from './identity';
import { previewAgentPurge, previewMetadataPurge, previewSourceReset, purgeAgent, purgeMetadata, resetSource } from './purge';
import { dedupeSessionDuplicates, previewSessionDedupe } from './dedupe';
import { rebuildSession } from './rebuild';
import { reparseProtocol } from './reparse';
import { normalizeStoredResponseIds, previewResponseIdNormalization } from './response-ids';
import { verifyDatabase, precheckDatabase } from './verify';

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

/** 日期简写按本地日零点解析：day 列与页面是本地日语义，Date.parse 的纯日期按 UTC 会偏一个时区。 */
function localMidnight(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day).getTime();
}

/** 窗口端点接受 epoch 毫秒、ISO 8601 或日期简写；解析失败返回 null，由调用方按用法错误退出。 */
function momentFlag(flags: Map<string, string | true>, name: string): number | null {
  const value = stringFlag(flags, name);
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  // 简写显式走本地构造，与 day 列同口径；非法日历（会被 Date 静默滚月）不猜。
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isCalendarDay(value) ? localMidnight(value) : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `YYYY-MM-DD` 的日历校验：真日期才通过；字段校验走 UTC 口径，与本地时区无关。 */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const USAGE = `usage:
  maintain verify --db <path>
  maintain precheck --db <path>
  maintain capacity-check --db <path>
  maintain capacity-recount --db <path> [--apply --approval-id <id>]
  maintain body-consistency --db <path> [--apply --approval-id <id> --expected-candidates <n>]
  maintain body-bytes-backfill --db <path> [--apply --approval-id <id> --expected-candidates <n>]
  maintain hook-delivery --db <path> --since <ISO|ms> --until <ISO|ms>
  maintain backup --db <path> --out <new-path>
  maintain bundle --dir <dataDir> --out <new-dir>
  maintain restore --bundle <bundleDir> --out <new-dir>
  maintain rebuild --db <path> --session <conv_key>
  maintain reparse --db <path> --protocol <name>
  maintain migrate-hook-identity --db <path> [--apply --approval-id <id>]
  maintain normalize-response-ids --db <path> [--apply --approval-id <id>]
  maintain dedupe-sessions --db <path> [--apply --approval-id <id>]
  maintain reset-source --db <path> --source <source_kind> [--apply --approval-id <id>]
  maintain purge-metadata --db <path> --before <YYYY-MM-DD> [--apply --allow-all --approval-id <id>]
  maintain purge-agent --db <path> --agent <name> [--apply --approval-id <id>]
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

  if (command === 'precheck') {
    // 只读预检：换机、回滚或指向旧数据目录时，把 schema 不兼容的发现时机提前到部署前。
    try {
      const report = precheckDatabase(dbPath);
      out(JSON.stringify(report));
      return report.ok ? 0 : 1;
    } catch (error) {
      err(`precheck_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    }
  }

  if (command === 'capacity-check') {
    // 只读对账：显式读事务固定快照，可以在服务运行时用，不取维护锁。
    try {
      const report = previewCapacityMeter(dbPath);
      out(JSON.stringify(report));
      return report.ok ? 0 : 1;
    } catch (error) {
      err(`capacity-check_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    }
  }

  if (command === 'capacity-recount') {
    let lock: LockHandle | null = null;
    try {
      const preview = previewCapacityMeter(dbPath);
      if (flags.get('apply') !== true) {
        out(JSON.stringify({ applied: false, ...preview }));
        return preview.ok ? 0 : 1;
      }
      const approvalId = stringFlag(flags, 'approval-id');
      if (approvalId === null) {
        out(JSON.stringify({ applied: false, ...preview, ok: false, error: 'approval_id_required' }));
        return 1;
      }
      lock = acquireMaintenanceLock(dirname(dbPath), `capacity-recount:${process.pid}`);
      if (lock === null) {
        err('maintenance_lock_held');
        return 1;
      }
      const result = recountCapacityMeter(dbPath);
      out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...result }));
      return 0;
    } catch (error) {
      err(`capacity-recount_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally {
      lock?.release();
    }
  }

  if (command === 'body-consistency' || command === 'body-bytes-backfill') {
    let lock: LockHandle | null = null;
    const preview = command === 'body-consistency' ? previewBodyConsistency : previewBodyBytesBackfill;
    const apply = command === 'body-consistency' ? reclassifyBodyConsistency : backfillBodyBytes;
    try {
      if (flags.get('apply') !== true) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const report = db.transaction(() => preview(db))();
          out(JSON.stringify({ ok: true, applied: false, ...report }));
        } finally { db.close(); }
        return 0;
      }
      const approvalId = stringFlag(flags, 'approval-id');
      if (approvalId === null || approvalId.trim().length === 0) throw new Error('approval_id_required');
      const expected = stringFlag(flags, 'expected-candidates');
      if (expected === null || !/^\d+$/.test(expected) || !Number.isSafeInteger(Number(expected))) {
        throw new Error('expected_candidates_required');
      }
      lock = acquireMaintenanceLock(dirname(dbPath), `${command}:${process.pid}`);
      if (lock === null) throw new Error('maintenance_lock_held');
      const report = withStoppedDatabase(dbPath, db => apply(db, {
        approvalId, expectedCandidates: Number(expected),
      }));
      out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...report }));
      return 0;
    } catch (error) {
      err(`${command}_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally { lock?.release(); }
  }

  if (command === 'verify' || command === 'purge-metadata' || command === 'purge-agent'
    || command === 'rebuild' || command === 'reparse' || command === 'migrate-hook-identity'
    || command === 'normalize-response-ids' || command === 'dedupe-sessions'
    || command === 'reset-source') {
    // verify 只读，不需要锁；其余命令写库，必须有。
    let store: Store | null = null;
    let lock: LockHandle | null = null;
    try {
      if (command === 'verify') {
        const report = verifyDatabase(dbPath);
        // 健康结论与报告字段分开：pending_derivations 是信息字段，停机前有积压是正常的。
        const ok = report.integrity.length === 1 && report.integrity[0] === 'ok'
          && report.dangling_blocks === 0 && report.duplicate_evidence === 0;
        out(JSON.stringify({ ok, ...report }));
        return ok ? 0 : 1;
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
          const report = await rebuildSession(store, argument);
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
      if (command === 'normalize-response-ids') {
        lock = acquireMaintenanceLock(dirname(dbPath), `normalize-response-ids:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const preview = previewResponseIdNormalization(store);
        if (flags.get('apply') !== true) {
          out(JSON.stringify({ ok: true, applied: false, ...preview }));
          return 0;
        }
        const approvalId = stringFlag(flags, 'approval-id');
        if (approvalId === null) {
          out(JSON.stringify({ ok: false, error: 'approval_id_required', ...preview }));
          return 1;
        }
        const report = normalizeStoredResponseIds(store);
        out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...report }));
        return 0;
      }
      if (command === 'dedupe-sessions') {
        lock = acquireMaintenanceLock(dirname(dbPath), `dedupe-sessions:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const preview = previewSessionDedupe(store);
        if (flags.get('apply') !== true) {
          out(JSON.stringify({ ok: true, applied: false, ...preview }));
          return 0;
        }
        const approvalId = stringFlag(flags, 'approval-id');
        if (approvalId === null) {
          out(JSON.stringify({ ok: false, error: 'approval_id_required', ...preview }));
          return 1;
        }
        const report = dedupeSessionDuplicates(store, Date.now());
        out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...report }));
        return 0;
      }
      if (command === 'reset-source') {
        const sourceKind = stringFlag(flags, 'source');
        if (sourceKind === null) {
          err(USAGE.trimEnd());
          return 2;
        }
        lock = acquireMaintenanceLock(dirname(dbPath), `reset-source:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const preview = previewSourceReset(store, sourceKind);
        if (flags.get('apply') !== true) {
          out(JSON.stringify({ ok: true, applied: false, ...preview }));
          return 0;
        }
        const approvalId = stringFlag(flags, 'approval-id');
        if (approvalId === null) {
          out(JSON.stringify({ ok: false, error: 'approval_id_required', ...preview }));
          return 1;
        }
        const result = resetSource(store, sourceKind, approvalId);
        out(JSON.stringify({ ok: true, applied: true, approval_id: approvalId, ...result }));
        return 0;
      }
      if (command === 'purge-agent') {
        const agent = stringFlag(flags, 'agent');
        if (agent === null) {
          err(USAGE.trimEnd());
          return 2;
        }
        lock = acquireMaintenanceLock(dirname(dbPath), `purge-agent:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const preview = previewAgentPurge(store, agent);
        if (flags.get('apply') !== true) {
          out(JSON.stringify({ ok: true, applied: false, ...preview }));
          return 0;
        }
        const approvalId = stringFlag(flags, 'approval-id');
        if (approvalId === null) {
          out(JSON.stringify({ ok: false, error: 'approval_id_required', ...preview }));
          return 1;
        }
        const result = purgeAgent(store, agent, approvalId);
        out(JSON.stringify({ ok: true, applied: true, agent, approval_id: approvalId, ...result }));
        return 0;
      }
      const before = stringFlag(flags, 'before');
      // 字符串比较是删除谓词（day < ?），所以上界必须先是合法日历，再不许晚于今天：
      // 未来日或非法日会整库命中，预览挡不住赶时间的 --apply。
      if (before === null || !isCalendarDay(before)) {
        err(`invalid_before:${before ?? ''}`);
        err(USAGE.trimEnd());
        return 2;
      }
      if (before > localDay(Date.now())) {
        err(`before_after_today:${before}`);
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
      // 命中全库的删除必须显式放行；拒绝时带出预览计数，操作员据此改日期或加 --allow-all。
      const total = store.read.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM request').get()?.n ?? 0;
      if (preview.requests > 0 && preview.requests === total && flags.get('allow-all') !== true) {
        out(JSON.stringify({ ok: false, error: 'allow_all_required', before, ...preview }));
        return 1;
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
