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
