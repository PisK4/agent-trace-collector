/**
 * 空 session 身份迁移：把 hook 初建时误用 `["session",""]` 的孤儿行
 * 拆回各自的 hook 回退身份。
 *
 * 触发权只在显式命令手里。新请求已在 hook 身份入口把空 session 当缺失；
 * 已存行仍带着空桶，重复投递会走幂等路径，不会重写身份。候选必须由
 * hook 证据证明上游没有有效 session，且尚未获得账本或路由归属；多份
 * hook 证据无法确定唯一回退身份时拒绝，不取首条猜测。每行一个事务，
 * 事务内重新校验；重复执行不再迁移。
 */

import type { Database } from 'bun:sqlite';
import { markOwnershipChangeTx, markRequestInputTx, requestGroupTx } from '../derive/state';
import { HAVE_LEDGER, HAVE_ROUTE, sessionIdentity } from '../evidence';
import type { Store } from '../store';

/** 空串 session 生成的组键；迁移只处理这个桶里的行。 */
export const EMPTY_SESSION_KEY = JSON.stringify(['session', '']);

export type IdentityRejection = { req_id: number; reason: string };
export type IdentityAgentCount = { agent: string | null; n: number };
export type IdentityCandidate = { req_id: number; agent: string | null; hook_id: string };

type BucketRow = {
  req_id: number; agent: string | null; via: string; session: string | null;
  actor: string | null; actor_state: string; have: number; conv_key: string; conv_source: string;
};

/** 迁移前后的一致性对账：请求、证据、块、别名与工具链接的行数，费用合计不变。 */
export type IdentityConservation = {
  requests: number;
  evidence: number;
  blocks: number;
  aliases: number;
  tool_calls: number;
  cost: number;
};

type ConservationCounts = IdentityConservation;

export type IdentityPreview = {
  bucket: string;
  scanned: number;
  candidates: IdentityCandidate[];
  agents: IdentityAgentCount[];
  rejected: IdentityRejection[];
};

export type IdentityReport = {
  scanned: number;
  migrated: number;
  skipped: number;
  rejected: IdentityRejection[];
  failed: IdentityRejection[];
  agents: IdentityAgentCount[];
  remaining: number;
  conservation: ConservationCounts & { conserved: boolean };
};

type Classification = { hook_id: string } | { reason: string };

const BUCKET_SQL = `SELECT req_id, agent, via, session, actor, actor_state, have, conv_key, conv_source
  FROM request WHERE conv_key=? ORDER BY req_id`;

function bucketRows(db: Database): BucketRow[] {
  return db.query<BucketRow, [string]>(BUCKET_SQL).all(EMPTY_SESSION_KEY);
}

/**
 * 判定一行能否迁移。判据只认证据：
 *
 * - 行仍由 hook 初建，session 与 actor 都没有有效值；
 * - 没有账本、路由或 OTLP 证据，actor_state 仍是 unknown；
 * - 恰好一条 hook 证据，且尚未并入账本目标；
 * - raw_hook 的 session 同样为空，证明上游确实没给会话身份。
 */
function classify(db: Database, row: BucketRow): Classification {
  if (row.conv_source !== 'session') return { reason: 'identity_changed' };
  if (row.via !== 'hook') return { reason: 'not_hook_born' };
  if (row.actor_state !== 'unknown') return { reason: 'actor_known' };
  if (sessionIdentity(row.actor) !== null) return { reason: 'actor_present' };
  if ((row.have & (HAVE_LEDGER | HAVE_ROUTE)) !== 0) return { reason: 'ownership_attached' };
  if (sessionIdentity(row.session) !== null) return { reason: 'session_present' };
  const owned = db.query<{ hit: number }, [number]>(`
    SELECT 1 AS hit FROM request_evidence
    WHERE req_id=? AND source_kind IN ('ledger','route','otlp_span') LIMIT 1`).get(row.req_id);
  if (owned !== null) return { reason: 'ownership_attached' };
  const hooks = db.query<{ ref_key: string; merge_state: string }, [number]>(`
    SELECT ref_key, merge_state FROM request_evidence
    WHERE req_id=? AND source_kind='hook' ORDER BY ref_key`).all(row.req_id);
  if (hooks.length === 0) return { reason: 'hook_evidence_missing' };
  if (hooks.length > 1) return { reason: 'hook_evidence_ambiguous' };
  const hook = hooks[0]!;
  if (hook.merge_state !== 'pending') return { reason: 'hook_evidence_merged' };
  if (hook.ref_key.length === 0) return { reason: 'hook_id_missing' };
  const raw = db.query<{ session: string | null }, [string]>(
    'SELECT session FROM raw_hook WHERE hook_id=?').get(hook.ref_key);
  if (raw === null) return { reason: 'hook_source_missing' };
  if (sessionIdentity(raw.session) !== null) return { reason: 'hook_session_present' };
  return { hook_id: hook.ref_key };
}

function agentCounts(rows: BucketRow[]): IdentityAgentCount[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
  return [...counts].map(([agent, n]) => ({ agent, n })).sort((a, b) => b.n - a.n
    || String(a.agent ?? '').localeCompare(String(b.agent ?? '')));
}

function previewFrom(db: Database): IdentityPreview {
  const rows = bucketRows(db);
  const candidates: IdentityCandidate[] = [];
  const rejected: IdentityRejection[] = [];
  for (const row of rows) {
    const verdict = classify(db, row);
    if ('hook_id' in verdict) {
      candidates.push({ req_id: row.req_id, agent: row.agent, hook_id: verdict.hook_id });
    } else {
      rejected.push({ req_id: row.req_id, reason: verdict.reason });
    }
  }
  return {
    bucket: EMPTY_SESSION_KEY,
    scanned: rows.length,
    candidates,
    agents: agentCounts(rows),
    rejected,
  };
}

/** 只读预览：候选清单、按 agent 的桶内分布与拒绝原因，不改任何行。 */
export function previewHookIdentityMigration(store: Store): IdentityPreview {
  return previewFrom(store.read);
}

function conservationOf(db: Database): ConservationCounts {
  const count = (table: string): number => (db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM ${table}`).get())?.n ?? 0;
  const cost = db.query<{ total: number | null }, []>(
    'SELECT SUM(cost) AS total FROM request').get()?.total ?? 0;
  return {
    requests: count('request'),
    evidence: count('request_evidence'),
    blocks: count('request_block'),
    aliases: count('request_alias'),
    tool_calls: count('tool_call'),
    cost,
  };
}

function sameConservation(a: ConservationCounts, b: ConservationCounts): boolean {
  return a.requests === b.requests && a.evidence === b.evidence && a.blocks === b.blocks
    && a.aliases === b.aliases && a.tool_calls === b.tool_calls && a.cost === b.cost;
}

/** 迁移一行；事务内重新读行与证据，拒绝执行前已变化的行。 */
function migrateRow(store: Store, reqId: number, now: number):
  { ok: true } | { ok: false; reason: string } {
  return store.write(db => {
    const row = db.query<BucketRow, [number]>(`
      SELECT req_id, agent, via, session, actor, actor_state, have, conv_key, conv_source
      FROM request WHERE req_id=?`).get(reqId);
    if (row === null) return { ok: false as const, reason: 'row_missing' };
    const verdict = classify(db, row);
    if ('reason' in verdict) return { ok: false as const, reason: verdict.reason };
    const before = requestGroupTx(db, reqId);
    const updated = db.run(
      `UPDATE request SET conv_key=?, conv_source='hook', session=NULL,
         actor=CASE WHEN actor='' THEN NULL ELSE actor END, updated_at=?
       WHERE req_id=? AND conv_key=?`,
      [JSON.stringify(['hook', verdict.hook_id]), now, reqId, EMPTY_SESSION_KEY],
    );
    if (updated.changes !== 1) return { ok: false as const, reason: 'identity_changed' };
    // 归属没变（仍是未知 actor），但身份变了：旧组按既有规则处理，
    // 输入修订照常推进；未知 actor 不凭空建派生组。
    markOwnershipChangeTx(db, reqId, before);
    markRequestInputTx(db, reqId);
    return { ok: true as const };
  });
}

/**
 * 执行迁移。只用显式命令调用；逐行独立事务，单行失败不影响其它行。
 * 重复执行时桶里只剩被拒绝的行，不再迁移、不推进修订。
 */
export function migrateHookIdentity(store: Store, now = Date.now()): IdentityReport {
  const before = conservationOf(store.read);
  const preview = previewFrom(store.read);
  const rejected = [...preview.rejected];
  const failed: IdentityRejection[] = [];
  let migrated = 0;
  let skipped = 0;
  for (const candidate of preview.candidates) {
    try {
      const result = migrateRow(store, candidate.req_id, now);
      if (result.ok) migrated += 1;
      else {
        skipped += 1;
        rejected.push({ req_id: candidate.req_id, reason: result.reason });
      }
    } catch (error) {
      failed.push({
        req_id: candidate.req_id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  const after = conservationOf(store.read);
  const remaining = bucketRows(store.read).length;
  return {
    scanned: preview.scanned,
    migrated,
    skipped,
    rejected,
    failed,
    agents: preview.agents,
    remaining,
    conservation: { ...after, conserved: sameConservation(before, after) },
  };
}
