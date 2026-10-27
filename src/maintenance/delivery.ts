/**
 * hook 投递的只读窗口诊断。
 *
 * 回答的是"哪个阶段没有接上"，不是"回调从来没发生"：ATC 只能看到已到达的
 * 证据与仍缺证据的行。窗口按 `started_ms`（请求）与 `received_at`（hook）切，
 * 等待阈值的判定以窗口右端为观察时点，前后两个窗口用同一条件即可比较。
 *
 * 只做聚合：不落正文、令牌或账号；未知 agent、缺 response ID 与无法关联的
 * 回调单列，不按时间邻近归并。
 */

import type { Database } from 'bun:sqlite';
import { HAVE_BODY, HAVE_LEDGER, HAVE_OTLP, HAVE_ROUTE } from '../evidence';
import { HOOK_ABSENT_THRESHOLD_MS } from '../hook';

export type HookDeliveryWindow = { sinceMs: number; untilMs: number };

export type HookDeliveryReport = {
  window: { since_ms: number; until_ms: number; settled_before_ms: number };
  requests: {
    total: number;
    with_hook: number;
    missing_hook: number;
    /** 过了等待阈值仍无 hook 证据：可以按缺口读的行。 */
    settled_missing: number;
    /** 仍在等待阈值内：可能只是回调还没到。 */
    young_missing: number;
    /** 缺 hook 证据、但已有账本、路由或 OTLP：说明回调阶段没接上。 */
    missing_with_sources: number;
    /** 缺 hook 证据且没有 response ID：即使回调到达也无法按 ID 关联。 */
    missing_without_response_id: number;
    /** 等待队列里已有指向本行的回调：差一次合并，不是投递缺失。 */
    awaiting_candidate: number;
    by_agent: { agent: string | null; total: number; missing: number }[];
    by_status: { status: number | null; missing: number }[];
    by_kind: { kind: string; missing: number }[];
    by_prompt_tokens: { bucket: string; missing: number }[];
    miss_reasons: { reason: string; n: number }[];
  };
  raw_hooks: {
    received: number;
    reply_absent: number;
    body_omitted: number;
    by_agent: { agent: string | null; n: number }[];
  };
  pending_hooks: { total: number; without_response_id: number };
  issues: { source_kind: string; reason: string; n: number }[];
};

type RequestRow = {
  req_id: number; agent: string | null; status: number | null; req_kind: string | null;
  prompt_tokens: number | null; have: number; miss_reason: string | null;
  response_id_norm: string | null; started_ms: number;
};

const PROMPT_BUCKETS: [number, string][] = [
  [10_000, 'lt_10k'],
  [100_000, '10k_to_100k'],
  [Number.POSITIVE_INFINITY, 'gte_100k'],
];

function promptBucket(tokens: number | null): string {
  if (tokens === null) return 'unknown';
  for (const [limit, name] of PROMPT_BUCKETS) if (tokens < limit) return name;
  return 'gte_100k';
}

function tally<T extends string | number | null, K>(rows: T[], key: (value: T) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

function byLabel<K>(counts: Map<K, number>, label: (key: K) => string): [K, number][] {
  return [...counts].sort((a, b) => label(a[0]).localeCompare(label(b[0])));
}

/**
 * 汇总一个窗口。`untilMs` 同时是观察时点：早于它一个等待阈值的缺证据行
 * 才算 settled，刚进窗口的行单独计 young。
 */
export function hookDeliveryReport(db: Database, window: HookDeliveryWindow): HookDeliveryReport {
  const { sinceMs, untilMs } = window;
  const settledBefore = untilMs - HOOK_ABSENT_THRESHOLD_MS;
  const requests = db.query<RequestRow, [number, number]>(`
    SELECT req_id, agent, status, req_kind, prompt_tokens, have, miss_reason,
           response_id_norm, started_ms
    FROM request WHERE started_ms >= ? AND started_ms < ?
    ORDER BY req_id`).all(sinceMs, untilMs);
  const missing = requests.filter(row => (row.have & HAVE_BODY) === 0);
  const settled = missing.filter(row => row.started_ms < settledBefore);
  const withSources = missing.filter(row => (row.have & (HAVE_LEDGER | HAVE_ROUTE | HAVE_OTLP)) !== 0);
  const awaiting = db.query<{ n: number }, [number, number]>(`
    SELECT COUNT(DISTINCT request.req_id) AS n FROM request
    WHERE request.started_ms >= ? AND request.started_ms < ?
      AND (request.have & ${HAVE_BODY}) = 0
      AND request.response_id_norm IS NOT NULL
      AND EXISTS (SELECT 1 FROM pending_hook ph WHERE ph.response_id_norm = request.response_id_norm)`)
    .get(sinceMs, untilMs);

  const byAgent = new Map<string | null, { total: number; missing: number }>();
  for (const row of requests) {
    const entry = byAgent.get(row.agent) ?? { total: 0, missing: 0 };
    entry.total += 1;
    if ((row.have & HAVE_BODY) === 0) entry.missing += 1;
    byAgent.set(row.agent, entry);
  }
  const missingKinds = tally(missing.map(row => row.req_kind ?? 'chat'), kind => kind);
  const missingPrompts = tally(missing.map(row => promptBucket(row.prompt_tokens)), bucket => bucket);
  const missingStatuses = tally(missing.map(row => row.status), status => status);
  const missReasons = tally(missing.map(row => row.miss_reason ?? 'none'), reason => reason);

  const hooks = db.query<{
    agent: string | null; reply_state: string | null; miss_reason: string | null;
  }, [number, number]>(`
    SELECT agent, reply_state, miss_reason FROM raw_hook
    WHERE received_at >= ? AND received_at < ?`).all(sinceMs, untilMs);
  const hookAgents = tally(hooks.map(row => row.agent), agent => agent);

  const pending = db.query<{ total: number; without_id: number }, [number]>(`
    SELECT COUNT(*) AS total,
           IFNULL(SUM(CASE WHEN response_id_norm IS NULL THEN 1 ELSE 0 END), 0) AS without_id
    FROM pending_hook WHERE first_seen < ?`).get(untilMs);
  const issues = db.query<{ source_kind: string; reason: string; n: number }, [number, number]>(`
    SELECT source_kind, reason, COUNT(*) AS n FROM ingest_issue
    WHERE observed_at >= ? AND observed_at < ?
    GROUP BY source_kind, reason ORDER BY source_kind, reason`).all(sinceMs, untilMs);

  return {
    window: { since_ms: sinceMs, until_ms: untilMs, settled_before_ms: settledBefore },
    requests: {
      total: requests.length,
      with_hook: requests.length - missing.length,
      missing_hook: missing.length,
      settled_missing: settled.length,
      young_missing: missing.length - settled.length,
      missing_with_sources: withSources.length,
      missing_without_response_id: missing.filter(row => row.response_id_norm === null).length,
      awaiting_candidate: awaiting?.n ?? 0,
      by_agent: [...byAgent].map(([agent, counts]) => ({ agent, ...counts }))
        .sort((a, b) => b.total - a.total || String(a.agent ?? '').localeCompare(String(b.agent ?? ''))),
      by_status: byLabel(missingStatuses, status => String(status ?? -1).padStart(8, '0'))
        .map(([status, n]) => ({ status, missing: n })),
      by_kind: byLabel(missingKinds, kind => kind).map(([kind, n]) => ({ kind, missing: n })),
      by_prompt_tokens: byLabel(missingPrompts, bucket => bucket)
        .map(([bucket, n]) => ({ bucket, missing: n })),
      miss_reasons: byLabel(missReasons, reason => reason).map(([reason, n]) => ({ reason, n })),
    },
    raw_hooks: {
      received: hooks.length,
      reply_absent: hooks.filter(row => row.reply_state === 'absent').length,
      body_omitted: hooks.filter(row => row.miss_reason !== null).length,
      by_agent: [...hookAgents].map(([agent, n]) => ({ agent, n }))
        .sort((a, b) => b.n - a.n || String(a.agent ?? '').localeCompare(String(b.agent ?? ''))),
    },
    pending_hooks: {
      total: pending?.total ?? 0,
      without_response_id: pending?.without_id ?? 0,
    },
    issues,
  };
}

/** 诊断不写库；窗口端点必须完整，缺一端就不是同一条件的比较。 */
export function assertWindow(window: HookDeliveryWindow): void {
  if (!Number.isFinite(window.sinceMs) || !Number.isFinite(window.untilMs) || window.sinceMs >= window.untilMs) {
    throw new Error('invalid_window');
  }
}
