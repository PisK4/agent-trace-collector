/** 元数据淘汰与按 agent 拆除：范围预览与带墓碑的单事务删除。 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { markGroupDirtyTx } from '../derive/state';
import type { Store } from '../store';

export type PurgePreview = {
  requests: number;
  first_day: string | null;
  last_day: string | null;
  estimated_bytes: number;
};

export type PublishResult = { deleted: number; event_id: number };

/** 按 agent 拆除的范围预览：请求侧、证据与来源层的可删行数。 */
export type AgentPurgePreview = {
  agent: string;
  requests: number;
  conv_keys: number;
  shared_conv_keys: number;
  groups: number;
  groups_with_remaining: number;
  first_day: string | null;
  last_day: string | null;
  estimated_bytes: number;
  evidence: { ledger: number; route: number; hook: number };
  raw: {
    ledger: number;
    route: number;
    hook: number;
    pending_hook: number;
    route_summary: number;
  };
};

type PurgeEvent = { action: string; reason: string; approvalId: string };

function requireApproval(approvalId: string): void {
  if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
    throw new Error('approval_id_required');
  }
}

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
 * 按 agent 拆除的范围预览。计数与实际删除用同一组守卫：
 * 被存活请求共享的证据键、路由与摘要保留；`shared_conv_keys` 是被别的 agent
 * 同时使用的会话桶数量，删完后这些组按剩余成员重算而不是整体消失。
 */
export function previewAgentPurge(store: Store, agent: string): AgentPurgePreview {
  const targets = store.read.query<{
    n: number; keys: number; first_day: string | null; last_day: string | null;
  }, [string]>(`
    SELECT COUNT(*) AS n, COUNT(DISTINCT conv_key) AS keys,
           MIN(day) AS first_day, MAX(day) AS last_day
    FROM request WHERE agent = ?`).get(agent);
  const shared = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM (
      SELECT conv_key FROM request WHERE conv_key IS NOT NULL GROUP BY conv_key
      HAVING SUM(agent = ?1) > 0 AND SUM(IFNULL(agent,'') <> ?1) > 0)`).get(agent);
  const groups = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM request
      WHERE agent = ? AND conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'
      GROUP BY conv_key, actor)`).get(agent);
  const remaining = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM request
      WHERE conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'
      GROUP BY conv_key, actor
      HAVING SUM(agent = ?1) > 0 AND SUM(IFNULL(agent,'') <> ?1) > 0)`).get(agent);
  const evidence = store.read.query<{ kind: string; n: number }, [string]>(`
    SELECT source_kind AS kind, COUNT(*) AS n FROM request_evidence
    WHERE req_id IN (SELECT req_id FROM request WHERE agent = ?)
    GROUP BY source_kind`).all(agent);
  const rawLedger = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM raw_ledger l WHERE l.agent = ?1
      AND NOT EXISTS (SELECT 1 FROM request_evidence e
        WHERE e.source_kind='ledger'
          AND e.ref_key = json_array('file', l.file_generation, l.byte_offset)
          AND e.req_id NOT IN (SELECT req_id FROM request WHERE agent = ?1))`).get(agent);
  const rawRoute = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM raw_route rt WHERE rt.route_id IN (
      SELECT route_id FROM request WHERE agent = ?1 AND route_id IS NOT NULL
      UNION SELECT route_id FROM raw_ledger WHERE agent = ?1 AND route_id IS NOT NULL
      UNION SELECT route_id FROM raw_route WHERE agent = ?1)
      AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id = rt.route_id
        AND IFNULL(l.agent,'') <> ?1)
      AND NOT EXISTS (SELECT 1 FROM request r WHERE r.route_id = rt.route_id
        AND IFNULL(r.agent,'') <> ?1)`).get(agent);
  const rawHook = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM raw_hook h WHERE h.agent = ?1
      AND NOT EXISTS (SELECT 1 FROM request_evidence e
        WHERE e.source_kind='hook' AND e.ref_key = h.hook_id
          AND e.req_id NOT IN (SELECT req_id FROM request WHERE agent = ?1))`).get(agent);
  const pendingHook = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM pending_hook WHERE hook_id IN (
      SELECT hook_id FROM raw_hook WHERE agent = ?1
      UNION SELECT ref_key FROM request_evidence WHERE source_kind='hook'
        AND req_id IN (SELECT req_id FROM request WHERE agent = ?1))`).get(agent);
  const summaries = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM route_summary s WHERE s.route_id IN (
      SELECT route_id FROM request WHERE agent = ?1 AND route_id IS NOT NULL
      UNION SELECT route_id FROM raw_ledger WHERE agent = ?1 AND route_id IS NOT NULL
      UNION SELECT route_id FROM raw_route WHERE agent = ?1)
      AND NOT EXISTS (SELECT 1 FROM request r WHERE r.route_id = s.route_id
        AND IFNULL(r.agent,'') <> ?1)
      AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id = s.route_id
        AND IFNULL(l.agent,'') <> ?1)`).get(agent);
  const bytes = store.read.query<{ n: number }, [string]>(`
    SELECT
      (SELECT IFNULL(SUM(IFNULL(body_bytes,0) + IFNULL(length(skeleton_z),0)),0)
         FROM request WHERE agent = ?1)
    + (SELECT IFNULL(SUM(length(CAST(payload_json AS BLOB))),0)
         FROM raw_ledger WHERE agent = ?1)
    + (SELECT IFNULL(SUM(length(CAST(payload_json AS BLOB))),0)
         FROM raw_route WHERE agent = ?1)
    + (SELECT IFNULL(SUM(IFNULL(length(request_z),0) + IFNULL(length(response_z),0)),0)
         FROM raw_hook WHERE agent = ?1)
    + (SELECT IFNULL(SUM(length(z)),0) FROM route_summary s WHERE s.route_id IN (
         SELECT route_id FROM request WHERE agent = ?1 AND route_id IS NOT NULL
         UNION SELECT route_id FROM raw_ledger WHERE agent = ?1 AND route_id IS NOT NULL
         UNION SELECT route_id FROM raw_route WHERE agent = ?1)
       AND NOT EXISTS (SELECT 1 FROM request r WHERE r.route_id = s.route_id
         AND IFNULL(r.agent,'') <> ?1)
       AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id = s.route_id
         AND IFNULL(l.agent,'') <> ?1)) AS n`).get(agent);
  const byKind = new Map(evidence.map(row => [row.kind, row.n]));
  return {
    agent,
    requests: targets?.n ?? 0,
    conv_keys: targets?.keys ?? 0,
    shared_conv_keys: shared?.n ?? 0,
    groups: groups?.n ?? 0,
    groups_with_remaining: remaining?.n ?? 0,
    first_day: targets?.first_day ?? null,
    last_day: targets?.last_day ?? null,
    estimated_bytes: bytes?.n ?? 0,
    evidence: {
      ledger: byKind.get('ledger') ?? 0,
      route: byKind.get('route') ?? 0,
      hook: byKind.get('hook') ?? 0,
    },
    raw: {
      ledger: rawLedger?.n ?? 0,
      route: rawRoute?.n ?? 0,
      hook: rawHook?.n ?? 0,
      pending_hook: pendingHook?.n ?? 0,
      route_summary: summaries?.n ?? 0,
    },
  };
}

/**
 * 主动淘汰长期元数据。只有在 CLI 显式 `--apply --approval-id` 时才会被调用，
 * 不挂后台定时器。
 */
export function purgeMetadata(store: Store, beforeDay: string, approvalId: string): PublishResult {
  requireApproval(approvalId);
  return purgeTargetsTx(
    store,
    { action: 'purge_metadata', reason: 'metadata_retention', approvalId },
    db => {
      db.run(
        'INSERT INTO purge_requests(req_id) SELECT req_id FROM request WHERE day < ?',
        [beforeDay],
      );
      db.run(`INSERT INTO purge_routes(route_id)
              SELECT DISTINCT route_id FROM request
              WHERE req_id IN (SELECT req_id FROM purge_requests) AND route_id IS NOT NULL`);
    },
  );
}

/**
 * 按 agent 拆除一次对话来源的全部落库痕迹。除了请求侧级联，还清来源层的
 * raw_ledger、raw_route、raw_hook、route_summary 与等待队列里的 hook：
 * 只删请求行会留下仍可读出会话归属的原始记录。
 *
 * 共享守卫：证据键、路由或摘要还被别的 agent 引用时保留。账本墓碑让同一代际的
 * 重放计 purged_skip；文件换代后的旧墓碑不匹配，这是既有淘汰路径共有的边界。
 */
export function purgeAgent(store: Store, agent: string, approvalId: string): PublishResult {
  requireApproval(approvalId);
  if (typeof agent !== 'string' || agent.trim().length === 0) throw new Error('agent_required');
  return purgeTargetsTx(
    store,
    { action: 'purge_agent', reason: `agent_removal:${agent}`, approvalId },
    db => {
      db.run('INSERT INTO purge_requests(req_id) SELECT req_id FROM request WHERE agent = ?', [agent]);
      db.run(`INSERT INTO purge_routes(route_id)
              SELECT route_id FROM request
              WHERE req_id IN (SELECT req_id FROM purge_requests) AND route_id IS NOT NULL
              UNION SELECT route_id FROM raw_ledger WHERE agent = ? AND route_id IS NOT NULL
              UNION SELECT route_id FROM raw_route WHERE agent = ?`, [agent, agent]);
    },
    db => purgeAgentRawLayer(db, agent),
  );
}

/** 来源层清理：只删归属于目标、且没有被存活请求共享的原始行。 */
function purgeAgentRawLayer(db: Database, agent: string): void {
  db.run(`DELETE FROM pending_hook WHERE hook_id IN (
            SELECT hook_id FROM raw_hook WHERE agent = ?
            UNION SELECT ref_key FROM request_evidence
            WHERE source_kind='hook' AND req_id IN (SELECT req_id FROM purge_requests))`,
  [agent]);
  db.run(`DELETE FROM raw_ledger WHERE agent = ?
            AND NOT EXISTS (SELECT 1 FROM request_evidence e
              WHERE e.source_kind='ledger'
                AND e.ref_key = json_array('file', raw_ledger.file_generation, raw_ledger.byte_offset)
                AND e.req_id NOT IN (SELECT req_id FROM purge_requests))`, [agent]);
  db.run(`DELETE FROM raw_hook WHERE agent = ?
            AND NOT EXISTS (SELECT 1 FROM request_evidence e
              WHERE e.source_kind='hook' AND e.ref_key = raw_hook.hook_id
                AND e.req_id NOT IN (SELECT req_id FROM purge_requests))`, [agent]);
  db.run(`DELETE FROM raw_route WHERE route_id IN (SELECT route_id FROM purge_routes)
            AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id = raw_route.route_id)
            AND NOT EXISTS (SELECT 1 FROM request r WHERE r.route_id = raw_route.route_id
              AND r.req_id NOT IN (SELECT req_id FROM purge_requests))`);
  db.run(`DELETE FROM bg_job WHERE spawn_req IN (SELECT req_id FROM purge_requests)
            OR notice_req IN (SELECT req_id FROM purge_requests)`);
  db.run('DELETE FROM otlp_body_ref WHERE req_id IN (SELECT req_id FROM purge_requests)');
  // 派生快照里属于目标的逐行结果：被删请求的标题与预览不留在库里。
  for (const table of ['derive_request_result', 'derive_chain_work', 'derive_role_work',
    'derive_tool_result', 'derive_call_work', 'derive_result_work']) {
    db.run(`DELETE FROM ${table} WHERE req_id IN (SELECT req_id FROM purge_requests)`);
  }
}

/**
 * 目标集合固定后的删除主干，按 purge_requests 与 purge_routes 两张临时表工作。
 * `fill` 填目标集合，可以另建自己的临时表；`beforeDelete` 在行级级联之前执行，
 * 供按 agent 拆除清理来源层。整个批次在一个事务里完成，任何一步失败整体回滚。
 *
 * 顺序有约束：费用观测按证据键定位，证据行删掉就再也找不回来；别名是
 * NO ACTION 外键，必须按 new_id 先删；route_summary 只在请求与账本引用都摘掉后才清。
 */
function purgeTargetsTx(
  store: Store,
  event: PurgeEvent,
  fill: (db: Database) => void,
  beforeDelete?: (db: Database) => void,
): PublishResult {
  return store.write(db => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_requests(req_id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_routes(route_id INTEGER PRIMARY KEY)');
    db.run('DELETE FROM purge_requests');
    db.run('DELETE FROM purge_routes');
    fill(db);

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
    const event_id = db.run(
      `INSERT INTO retention_event(at_ms,action,first_day,last_day,request_count,reason,approval_id)
       VALUES (?,?,?,?,?,?,?)`,
      [now, event.action, targets?.first_day ?? null, targets?.last_day ?? null, count,
        event.reason, event.approvalId],
    );
    // 3) 其他引用先清掉，再删别名与请求。
    //    删行前先记下受影响的组：这些请求消失后，同组剩下的成员要重算链与增量。
    const affected = db.query<{ conv_key: string; actor: string }, []>(`
      SELECT DISTINCT conv_key, actor FROM request
      WHERE req_id IN (SELECT req_id FROM purge_requests)
        AND conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'`).all();
    beforeDelete?.(db);
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
    return { deleted: count, event_id: Number(event_id.lastInsertRowid) };
  }, event.action);
}
