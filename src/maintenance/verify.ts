/** 只读校验：库完整性与三类容易悄悄积累的结构问题。 */

import { Database } from 'bun:sqlite';
import { queuePendingSql } from '../derive/state';

export type VerifyReport = {
  integrity: string[];
  dangling_blocks: number;
  duplicate_evidence: number;
  pending_derivations: number;
};

/**
 * 代码侧 schema 版本，与 store.ts 的 `SCHEMA_VERSION` 同步；store 升版而这里没跟
 * 时，precheck 在新装库上的 current 断言会先报红。
 */
export const CODE_SCHEMA_VERSION = 13;

export type PrecheckReport = {
  ok: boolean;
  state: 'in_place' | 'rebuild_required' | 'unsupported';
  db_version: number;
  code_version: number;
};

/**
 * 只读校验。integrity 直出 `PRAGMA integrity_check`；
 * 另外查三类最容易悄悄积累的结构问题：没有引用的块、同一 ref_key 的多个 owner、未处理的派生分组。
 */
export function verifyDatabase(path: string): VerifyReport {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = (db.query('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map(row => row.integrity_check);
    const dangling = db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM block b
      WHERE NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=b.id)`).get();
    const duplicates = db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM (
        SELECT source_kind, ref_key FROM request_evidence GROUP BY source_kind, ref_key HAVING COUNT(*) > 1
      )`).get();
    // clean 行是完成记录，不是积压。
    const pending = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM derive_queue WHERE ${queuePendingSql()}`).get();
    return {
      integrity,
      dangling_blocks: dangling?.n ?? 0,
      duplicate_evidence: duplicates?.n ?? 0,
      pending_derivations: pending?.n ?? 0,
    };
  } finally {
    db.close();
  }
}

/**
 * 只读预检：对比库与代码的 schema 版本，回答「这份库能不能被当前代码直接启动」。
 * 判据与 store.ts 的 migrate 对齐：v6 起有原地升级路径，更早版本需重建，
 * v0 带表（schema_unknown）与高于代码的版本不受支持。不做任何迁移写入。
 */
export function precheckDatabase(path: string): PrecheckReport {
  const db = new Database(path, { readonly: true });
  try {
    const version = db.query('PRAGMA user_version').get() as Record<string, number>;
    const dbVersion = Number(Object.values(version)[0]);
    const tables = db.query(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get() as { n: number };
    let state: PrecheckReport['state'];
    if (dbVersion === CODE_SCHEMA_VERSION || (dbVersion >= 6 && dbVersion < CODE_SCHEMA_VERSION)
      || (dbVersion === 0 && tables.n === 0)) {
      // 当前版本、v6 起有升级路径的旧版本、待新建的空库，启动都能直接接手。
      state = 'in_place';
    } else if (dbVersion > 0 && dbVersion < 6) {
      state = 'rebuild_required';
    } else {
      state = 'unsupported';
    }
    return { ok: state === 'in_place', state, db_version: dbVersion, code_version: CODE_SCHEMA_VERSION };
  } finally {
    db.close();
  }
}
