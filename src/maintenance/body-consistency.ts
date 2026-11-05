/**
 * 正文一致性维护：F09 历史状态纠正与 F24 正文元数据重算。
 *
 * F09：把可证明不可恢复的 pending 行重判为 partial。只处理特定历史组合：
 * `body_state='pending'`、已登记 `HAVE_BODY` 证据、`skeleton_z IS NULL`，
 * 且原因固定为 `disk_body_paused`。这组事实说明 hook 回调已经到过、正文当时
 * 没有落盘，目标行不应继续显示为"还在等正文"。
 * 不是正文恢复：不生成骨架、不写块引用、不改 `have` 与 `miss_reason`，
 * 只把状态从 pending 改成 partial。其他 pending 行（原因未知、`hook_absent`、
 * 尚无正文证据）保持不动，它们可能仍在等待。
 *
 * F24：只对能由现有结构无解压重算的 `body_bytes` 补写。候选必须
 * `body_state='available'`、骨架存在、`body_bytes IS NULL`、`msg_count` 与
 * 块引用数量/序号完全一致，且没有悬空块；字节数按 persistBodyTx 的同一口径
 * 计算：骨架长度加该请求去重后各块压缩长度之和。这里不读正文内容、不猜旧值，
 * 也不把逐请求逻辑字节当成删行时的物理释放量。`redact_version` 需要解压骨架
 * 才能还原，本函数不碰它，只在预览里报出仍为 NULL 的数量。
 */

import type { Database } from 'bun:sqlite';
import { markRequestInputTx } from '../derive/state';
import { HAVE_BODY } from '../evidence';

/** 可证明正文已不可恢复的缺失原因，固定为暂停落盘，不接受外部扩展。 */
export const RECLASSIFIABLE_BODY_REASONS = ['disk_body_paused'] as const;

export type BodyConsistencyPreview = {
  scope: {
    body_state: 'pending';
    require_have_body: true;
    require_missing_skeleton: true;
    miss_reasons: string[];
  };
  candidates: number;
  by_agent: { agent: string | null; n: number }[];
  by_reason: { miss_reason: string; n: number }[];
  first_day: string | null;
  last_day: string | null;
  first_started_ms: number | null;
  last_started_ms: number | null;
  sample_req_ids: number[];
  /** 同形但原因不在可证明集合里的 pending 行：保持不动。 */
  unproven_pending: number;
};

export type BodyConsistencyApplyOptions = {
  approvalId: string;
  /** 必须等于刚跑出的预览计数；集合变了就拒绝，整批不写。 */
  expectedCandidates: number;
  now?: number;
};

export type BodyConsistencyReport = {
  changed: number;
  changed_req_ids: number[];
  remaining: number;
  first_day: string | null;
  last_day: string | null;
};

/** F24 重算范围：只收引用完整、能按写入时同一口径算出字节的 available 行。 */
export type BodyBytesBackfillPreview = {
  scope: {
    body_state: 'available';
    require_skeleton: true;
    require_null_body_bytes: true;
    require_consistent_refs: true;
  };
  candidates: number;
  /** 逻辑正文字节合计，不是物理释放量。 */
  recomputed_bytes: number;
  by_agent: { agent: string | null; n: number; bytes: number }[];
  first_day: string | null;
  last_day: string | null;
  sample_req_ids: number[];
  /** 同形但引用与 msg_count 不一致、无法明确重算的行：保持不动。 */
  uncomputable: number;
  /** 候选里 redact_version 仍为 NULL 的行；本函数不解压骨架，不补这一列。 */
  missing_redact_version: number;
};

export type BodyBytesBackfillReport = {
  changed: number;
  changed_req_ids: number[];
  /** 逻辑正文字节合计，不是物理释放量。 */
  recomputed_bytes: number;
  remaining: number;
  first_day: string | null;
  last_day: string | null;
};

function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** 可重判的精确谓词；应用与预览共用，防止两边范围漂移。 */
function candidateSql(): string {
  return `body_state='pending' AND (have & ${HAVE_BODY}) <> 0
    AND skeleton_z IS NULL AND miss_reason IN (${marks(RECLASSIFIABLE_BODY_REASONS.length)})`;
}

function unprovenSql(): string {
  return `body_state='pending' AND (have & ${HAVE_BODY}) <> 0
    AND skeleton_z IS NULL
    AND (miss_reason IS NULL OR miss_reason NOT IN (${marks(RECLASSIFIABLE_BODY_REASONS.length)}))`;
}

/** 与 persistBodyTx 相同：骨架压缩长度 + 本请求去重后各块压缩长度。 */
const BODY_BYTES_EXPR = `length(r.skeleton_z) + IFNULL((
  SELECT SUM(length(b.z)) FROM (
    SELECT DISTINCT rb.block AS block FROM request_block rb WHERE rb.req_id=r.req_id
  ) rf JOIN block b ON b.id=rf.block
),0)`;

/**
 * 只认引用完整的目标：引用数等于 msg_count、ord 从 0 连续、没有悬空块。
 * 引用不完整的行算不出可靠字节，宁可留空也不猜。
 */
const BODY_BYTES_PREDICATE = `r.body_state='available' AND r.skeleton_z IS NOT NULL
  AND r.body_bytes IS NULL AND r.msg_count IS NOT NULL
  AND (SELECT COUNT(*) FROM request_block rb WHERE rb.req_id=r.req_id)=r.msg_count
  AND NOT EXISTS (
    SELECT 1 FROM request_block rb LEFT JOIN block b ON b.id=rb.block
    WHERE rb.req_id=r.req_id AND b.id IS NULL)
  AND (r.msg_count=0 OR (
    (SELECT MIN(ord) FROM request_block rb WHERE rb.req_id=r.req_id)=0
    AND (SELECT MAX(ord) FROM request_block rb WHERE rb.req_id=r.req_id)=r.msg_count-1))`;

const BODY_BYTES_CTE = `WITH candidates AS (
  SELECT r.req_id, r.agent, r.day, ${BODY_BYTES_EXPR} AS bytes
  FROM request r WHERE ${BODY_BYTES_PREDICATE}
)`;


function previewFrom(db: Database): BodyConsistencyPreview {
  const where = candidateSql();
  const reasons = RECLASSIFIABLE_BODY_REASONS;
  const total = db.query<{
    n: number; first_day: string | null; last_day: string | null;
    first_started_ms: number | null; last_started_ms: number | null;
  }, string[]>(`
    SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day,
      MIN(started_ms) AS first_started_ms, MAX(started_ms) AS last_started_ms
    FROM request WHERE ${where}`).get(...reasons)!;
  const byAgent = db.query<{ agent: string | null; n: number }, string[]>(`
    SELECT agent, COUNT(*) AS n FROM request WHERE ${where}
    GROUP BY agent ORDER BY n DESC, agent`).all(...reasons);
  const byReason = db.query<{ miss_reason: string; n: number }, string[]>(`
    SELECT miss_reason, COUNT(*) AS n FROM request WHERE ${where}
    GROUP BY miss_reason ORDER BY n DESC, miss_reason`).all(...reasons);
  const sample = db.query<{ req_id: number }, string[]>(`
    SELECT req_id FROM request WHERE ${where} ORDER BY req_id LIMIT 20`).all(...reasons);
  const unproven = db.query<{ n: number }, string[]>(`
    SELECT COUNT(*) AS n FROM request WHERE ${unprovenSql()}`).get(...reasons)!.n;
  return {
    scope: {
      body_state: 'pending',
      require_have_body: true,
      require_missing_skeleton: true,
      miss_reasons: [...reasons],
    },
    candidates: total.n,
    by_agent: byAgent,
    by_reason: byReason,
    first_day: total.first_day,
    last_day: total.last_day,
    first_started_ms: total.first_started_ms,
    last_started_ms: total.last_started_ms,
    sample_req_ids: sample.map(row => row.req_id),
    unproven_pending: unproven,
  };
}

/** 只读预览：范围、计数与分布；不打开写事务，不改任何行。传只读连接即可。 */
export function previewBodyConsistency(db: Database): BodyConsistencyPreview {
  return previewFrom(db);
}

/**
 * 应用重判。必须带刚跑出的预览计数；集合在预览之后发生变化时抛
 * `body_consistency_scope_changed`，整批不写。整个更新在一个写事务里，
 * 中途失败同样整体回滚，不留下半批 partial。
 *
 * 变更只把 `body_state` 改为 `partial` 并推进 `updated_at`；`miss_reason`
 * 与 `have` 原样保留，便于审计与人工回退。`body_state` 是派生输入（正文指纹、
 * 工具重建范围直接读它），所以每行再走 `markRequestInputTx` 推进修订，避免
 * 重启后复用 pending 时代算出的组结论。返回的 `changed_req_ids` 是本批实际
 * 改动的行，可用于对照预览。
 */
export function reclassifyBodyConsistency(
  db: Database,
  options: BodyConsistencyApplyOptions,
): BodyConsistencyReport {
  if (typeof options.approvalId !== 'string' || options.approvalId.trim().length === 0) {
    throw new Error('approval_id_required');
  }
  if (!Number.isSafeInteger(options.expectedCandidates) || options.expectedCandidates < 0) {
    throw new Error('expected_candidates_required');
  }
  const reasons = RECLASSIFIABLE_BODY_REASONS;
  const now = options.now ?? Date.now();
  // 调用方的独占连接由 withStoppedDatabase 持有；这里只包住这一批写入。
  return db.transaction(() => {
    const targets = db.query<{ req_id: number }, string[]>(`
      SELECT req_id FROM request WHERE ${candidateSql()} ORDER BY req_id`).all(...reasons);
    if (targets.length !== options.expectedCandidates) {
      throw new Error('body_consistency_scope_changed');
    }
    if (targets.length === 0) {
      return { changed: 0, changed_req_ids: [], remaining: 0, first_day: null, last_day: null };
    }
    const range = db.query<{ first_day: string | null; last_day: string | null }, string[]>(`
      SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM request WHERE ${candidateSql()}`,
    ).get(...reasons)!;
    const updated = db.run(
      `UPDATE request SET body_state='partial', updated_at=? WHERE ${candidateSql()}`,
      [now, ...reasons],
    );
    if (updated.changes !== targets.length) throw new Error('body_consistency_update_mismatch');
    for (const row of targets) markRequestInputTx(db, row.req_id);
    return {
      changed: updated.changes,
      changed_req_ids: targets.map(row => row.req_id),
      remaining: previewFrom(db).candidates,
      first_day: range.first_day,
      last_day: range.last_day,
    };
  }).immediate();
}

function previewBodyBytesFrom(db: Database): BodyBytesBackfillPreview {
  const total = db.query<{
    n: number; bytes: number; first_day: string | null; last_day: string | null;
  }, []>(`
    ${BODY_BYTES_CTE}
    SELECT COUNT(*) AS n, IFNULL(SUM(bytes),0) AS bytes,
      MIN(day) AS first_day, MAX(day) AS last_day
    FROM candidates`).get()!;
  const byAgent = db.query<{ agent: string | null; n: number; bytes: number }, []>(`
    ${BODY_BYTES_CTE}
    SELECT agent, COUNT(*) AS n, IFNULL(SUM(bytes),0) AS bytes
    FROM candidates GROUP BY agent ORDER BY n DESC, agent`).all();
  const sample = db.query<{ req_id: number }, []>(`
    ${BODY_BYTES_CTE}
    SELECT req_id FROM candidates ORDER BY req_id LIMIT 20`).all();
  // 宽口径只用于报告未重算的行，不参与写入。
  const broad = db.query<{ n: number }, []>(`
    SELECT COUNT(*) AS n FROM request r
    WHERE r.body_state='available' AND r.skeleton_z IS NOT NULL AND r.body_bytes IS NULL`).get()!.n;
  const missingRedact = db.query<{ n: number }, []>(`
    ${BODY_BYTES_CTE}
    SELECT COUNT(*) AS n FROM candidates
    JOIN request r ON r.req_id=candidates.req_id WHERE r.redact_version IS NULL`).get()!.n;
  return {
    scope: {
      body_state: 'available',
      require_skeleton: true,
      require_null_body_bytes: true,
      require_consistent_refs: true,
    },
    candidates: total.n,
    recomputed_bytes: total.bytes,
    by_agent: byAgent,
    first_day: total.first_day,
    last_day: total.last_day,
    sample_req_ids: sample.map(row => row.req_id),
    uncomputable: Math.max(0, broad - total.n),
    missing_redact_version: missingRedact,
  };
}

/**
 * 只读预览 F24 可重算范围：按骨架与块长度计算，不解压正文、不写库。
 * `recomputed_bytes` 是逐请求逻辑字节合计，不能当作物理释放量。
 */
export function previewBodyBytesBackfill(db: Database): BodyBytesBackfillPreview {
  return previewBodyBytesFrom(db);
}

/**
 * 应用 F24 元数据重算。必须带预览计数；候选集合变化时抛
 * `body_bytes_scope_changed`，整批不写。更新在单个写事务里，中途失败整体回滚。
 *
 * 只写 `body_bytes` 与 `updated_at`；`redact_version` 需要解压骨架才能还原，
 * 本函数不猜、不写。引用与 `msg_count` 不一致的行保持 NULL，留给人工核对。
 */
export function backfillBodyBytes(
  db: Database,
  options: { approvalId: string; expectedCandidates: number; now?: number },
): BodyBytesBackfillReport {
  if (typeof options.approvalId !== 'string' || options.approvalId.trim().length === 0) {
    throw new Error('approval_id_required');
  }
  if (!Number.isSafeInteger(options.expectedCandidates) || options.expectedCandidates < 0) {
    throw new Error('expected_candidates_required');
  }
  const now = options.now ?? Date.now();
  // 与 reclassify 相同：调用方持有独占连接，这里只包住本批写入。
  return db.transaction(() => {
    const targets = db.query<{ req_id: number; bytes: number }, []>(`
      ${BODY_BYTES_CTE}
      SELECT req_id, bytes FROM candidates ORDER BY req_id`).all();
    if (targets.length !== options.expectedCandidates) {
      throw new Error('body_bytes_scope_changed');
    }
    if (targets.length === 0) {
      return {
        changed: 0, changed_req_ids: [], recomputed_bytes: 0, remaining: 0,
        first_day: null, last_day: null,
      };
    }
    const range = db.query<{ first_day: string | null; last_day: string | null }, []>(`
      ${BODY_BYTES_CTE}
      SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM candidates`).get()!;
    const updated = db.run(
      `UPDATE request AS r SET body_bytes=${BODY_BYTES_EXPR}, updated_at=?
       WHERE ${BODY_BYTES_PREDICATE}`,
      [now],
    );
    if (updated.changes !== targets.length) throw new Error('body_bytes_update_mismatch');
    return {
      changed: updated.changes,
      changed_req_ids: targets.map(row => row.req_id),
      recomputed_bytes: targets.reduce((sum, row) => sum + row.bytes, 0),
      remaining: previewBodyBytesFrom(db).candidates,
      first_day: range.first_day,
      last_day: range.last_day,
    };
  }).immediate();
}
