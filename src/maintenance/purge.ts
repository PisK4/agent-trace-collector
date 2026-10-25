/** 元数据淘汰：范围预览与带墓碑的单事务淘汰。 */

import { randomUUID } from 'node:crypto';
import { markGroupDirtyTx } from '../derive/state';
import type { Store } from '../store';

export type PurgePreview = {
  requests: number;
  first_day: string | null;
  last_day: string | null;
  estimated_bytes: number;
};

export type PublishResult = { deleted: number; event_id: number };

/** 淘汰范围预览：默认路径不带副作用，先把要删的东西数清楚。 */
export function previewMetadataPurge(store: Store, beforeDay: string): PurgePreview {
  const row = store.read.query<{
    n: number; first_day: string | null; last_day: string | null; bytes: number | null;
  }, [string]>(`
    SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day,
           IFNULL(SUM(IFNULL(body_bytes,0) + IFNULL(length(skeleton_z),0)),0) AS bytes
    FROM request WHERE day < ?`).get(beforeDay);
  return {
    requests: row?.n ?? 0,
    first_day: row?.first_day ?? null,
    last_day: row?.last_day ?? null,
    estimated_bytes: row?.bytes ?? 0,
  };
}

/**
 * 主动淘汰长期元数据。只有在 CLI 显式 `--apply --approval-id` 时才会被调用，
 * 不挂后台定时器。整个批次在一个事务里完成：
 *
 * 1. 先按目标证据删掉费用观测——证据行一旦删掉就再也定位不到这些观测；
 * 2. 记墓碑（事件 + 逐证据键），来源重放命中时计 purged_skip；
 * 3. 删指向目标的别名（按 new_id 选，不能按 old_id 猜范围）；
 * 4. 删 request；route_summary 只在没有别的请求引用时清。
 *
 * 外键是 NO ACTION，所以顺序错了会直接失败，不会静默留下悬空引用。
 */
export function purgeMetadata(store: Store, beforeDay: string, approvalId: string): PublishResult {
  if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
    throw new Error('approval_id_required');
  }
  return store.write(db => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_requests(req_id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_routes(route_id INTEGER PRIMARY KEY)');
    db.run('DELETE FROM purge_requests');
    db.run('DELETE FROM purge_routes');
    db.run(
      'INSERT INTO purge_requests(req_id) SELECT req_id FROM request WHERE day < ?',
      [beforeDay],
    );
    db.run(`INSERT INTO purge_routes(route_id)
            SELECT DISTINCT route_id FROM request
            WHERE req_id IN (SELECT req_id FROM purge_requests) AND route_id IS NOT NULL`);

    const targets = db.query<{ n: number; first_day: string | null; last_day: string | null }, []>(
      'SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM request WHERE req_id IN (SELECT req_id FROM purge_requests)',
    ).get();
    const count = targets?.n ?? 0;
    if (count === 0) {
      db.run('DELETE FROM purge_requests');
      db.run('DELETE FROM purge_routes');
      return { deleted: 0, event_id: 0 };
    }
    const now = Date.now();

    // 1) 费用观测按目标证据的 ref_key 精确删除。
    db.run(`DELETE FROM cost_observation WHERE ref_key IN (
              SELECT ref_key FROM request_evidence WHERE req_id IN (SELECT req_id FROM purge_requests))`);
    // 2) 墓碑：重放时按证据键跳过。
    db.run(`INSERT OR IGNORE INTO purged_evidence(source_kind,ref_key,purged_at)
            SELECT source_kind, ref_key, ? FROM request_evidence
            WHERE req_id IN (SELECT req_id FROM purge_requests)`, [now]);
    const event = db.run(
      `INSERT INTO retention_event(at_ms,action,first_day,last_day,request_count,reason,approval_id)
       VALUES (?,'purge_metadata',?,?,?,'metadata_retention',?)`,
      [now, targets?.first_day ?? null, targets?.last_day ?? null, count, approvalId],
    );
    // 3) 其他引用先清掉，再删别名与请求。
    //    删行前先记下受影响的组：这些请求消失后，同组剩下的成员要重算链与增量。
    const affected = db.query<{ conv_key: string; actor: string }, []>(`
      SELECT DISTINCT conv_key, actor FROM request
      WHERE req_id IN (SELECT req_id FROM purge_requests)
        AND conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'`).all();
    db.run('DELETE FROM tool_call WHERE req_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM tool_call WHERE result_req IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request_block WHERE req_id IN (SELECT req_id FROM purge_requests)');
    // 引用删掉后同步回收正文块：不留下没有引用的孤儿，也不把回收推给下一轮维护。
    db.run(`DELETE FROM block WHERE NOT EXISTS (
              SELECT 1 FROM request_block rb WHERE rb.block=block.id)`);
    db.run('DELETE FROM request_evidence WHERE req_id IN (SELECT req_id FROM purge_requests)');
    db.run('UPDATE request SET prev_req_id=NULL WHERE prev_req_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request_alias WHERE new_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request WHERE req_id IN (SELECT req_id FROM purge_requests)');
    // 4) 只清没有其他请求引用的路由摘要与原始路由。
    db.run(`DELETE FROM route_summary WHERE route_id IN (
              SELECT route_id FROM purge_routes
              WHERE NOT EXISTS (SELECT 1 FROM request q WHERE q.route_id=route_summary.route_id)
                AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id=route_summary.route_id))`);
    db.run('DELETE FROM purge_requests');
    db.run('DELETE FROM purge_routes');
    // 5) 被删请求所在的组少成员，链与增量要重算；已经空掉的组没有产物可算，直接完成。
    for (const group of affected) {
      const remaining = db.query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM request
         WHERE conv_key=? AND actor=? AND actor_state='known'`).get(group.conv_key, group.actor)?.n ?? 0;
      if (remaining === 0) {
        // 空组同步成 clean：保留完成记录，不把它算成积压。
        db.run(
          `INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
             published_revision,target_algorithm,state,dirty_since_ms)
           VALUES (?,?,'',?,0,0,1,'clean',NULL)
           ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean',dirty_since_ms=NULL,
             published_revision=input_revision,published_algorithm=target_algorithm`,
          [group.conv_key, group.actor, randomUUID()],
        );
      } else {
        markGroupDirtyTx(db, group.conv_key, group.actor, '');
      }
    }
    return { deleted: count, event_id: Number(event.lastInsertRowid) };
  });
}

export type PurgedCheck = { skip: boolean };
