import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/**
 * 守恒摘要：只覆盖迁移不得改变的表。
 *
 * 新增长期列与派生结果会变，所以不进摘要；正文块按 id/hash/z 单独流式计入，
 * 确保迁移没有重新编码原文。
 */
const INVARIANT_QUERIES = [
  'SELECT req_id FROM request ORDER BY req_id',
  'SELECT * FROM request_alias ORDER BY old_id',
  'SELECT * FROM request_evidence ORDER BY req_id,source_kind,ref_key',
  'SELECT * FROM request_block ORDER BY req_id,ord',
  'SELECT * FROM cost_observation ORDER BY ref_key,observed_at',
  'SELECT * FROM source_cursor ORDER BY source_kind,source_name',
  'SELECT * FROM purged_evidence ORDER BY source_kind,ref_key',
  'SELECT id,hex(hash) hash,hex(z) z,raw_size,fingerprint FROM block ORDER BY id',
  'SELECT req_id,hex(skeleton_z) skeleton_z,msg_count,body_state,body_bytes FROM request ORDER BY req_id',
] as const;

export function conservationDigest(db: Database): string {
  const hash = createHash('sha256');
  for (const sql of INVARIANT_QUERIES) {
    hash.update(sql).update('\n');
    for (const row of db.query(sql).iterate()) hash.update(JSON.stringify(row)).update('\n');
  }
  return hash.digest('hex');
}
