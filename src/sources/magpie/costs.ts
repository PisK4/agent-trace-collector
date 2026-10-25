/** magpie 费用同步：费用周期校验、费用状态、带持久进度的分页任务与冲突记录。 */

import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Store } from '../../store';
import { redact } from '../../privacy';
import { isRecord, normalizeResponseId, optionalNumber, optionalString, parseTimestamp } from './mapping';
import { probeVersion } from './probe';

export type CostSyncResult = { pages: number; observations: number; matched: number; ambiguous: number };

export function validateCostPeriod(period: string): void {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (!match || match[0] !== period) throw new Error('cost_period_invalid');
  const [, from, to] = match;
  for (const day of [from!, to!]) {
    const date = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
      throw new Error('cost_period_invalid');
    }
  }
  if (from! > to!) throw new Error('cost_period_invalid');
}

export function assertCostPagePeriod(page: unknown, expectedPeriod: string): void {
  if (page === null || typeof page !== 'object' ||
      !('period' in page) || (page as Record<string, unknown>).period !== expectedPeriod) {
    throw new Error('cost_api_period_mismatch');
  }
}

export function costState(row: Record<string, unknown> | null): 'priced' | 'zero' | 'unpriced' | 'absent' {
  if (row === null) return 'absent';
  if (row.priced === false) return 'unpriced';
  if (row.priced !== true || typeof row.cost !== 'number' || !Number.isFinite(row.cost) || row.cost < 0) return 'absent';
  return row.cost === 0 ? 'zero' : 'priced';
}

export function costWindowKey(period: string): string {
  return JSON.stringify(['cost-window', period]);
}

type CostWindowState = { run_id: string; next_offset: number; done: boolean };

/** 费用时钟冲突的健康状态：计数与最新阻塞时点，读出来就知道扫描停在哪儿。 */
export const COST_HEALTH_KEY = JSON.stringify(['cost', 'clock_conflict']);

type CostHealth = { count: number; blocked_at: number; ref_key: string; period: string };

function readCostHealth(store: Store): CostHealth | null {
  const row = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(COST_HEALTH_KEY);
  if (row == null) return null;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return isRecord(parsed) && typeof parsed.count === 'number' ? parsed as CostHealth : null;
  } catch {
    return null;
  }
}

function recordCostConflict(
  store: Store,
  period: string,
  refKey: string,
  blockedAt: number,
  now: number,
): void {
  // 冲突会让整页回滚，所以这条记录单独写：它必须活下来，否则下次还是看不出为什么停住。
  const previous = readCostHealth(store);
  store.write(db => db.run(
    'INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
    [COST_HEALTH_KEY, JSON.stringify({
      count: (previous?.count ?? 0) + 1, blocked_at: blockedAt, ref_key: refKey, period, at: now,
    })],
  ), 'cost');
}

function readCostWindow(store: Store, period: string): CostWindowState | null {
  const row = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(costWindowKey(period));
  if (row == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    throw new Error('cost_window_state_invalid');
  }
  if (!isRecord(parsed) || typeof parsed.run_id !== 'string' || typeof parsed.next_offset !== 'number' || !Number.isInteger(parsed.next_offset) || parsed.next_offset < 0) {
    throw new Error('cost_window_state_invalid');
  }
  return { run_id: parsed.run_id, next_offset: parsed.next_offset, done: parsed.done === true };
}

function saveCostWindow(db: Database, period: string, state: CostWindowState): void {
  db.run(
    'INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
    [costWindowKey(period), JSON.stringify(state)],
  );
}

function projectionHash(row: Record<string, unknown>, pricingVersion: string | null): string {
  const priced = row.priced === true ? '1' : row.priced === false ? '0' : 'x';
  const cost = typeof row.cost === 'number' && Number.isFinite(row.cost) ? String(row.cost) : 'x';
  return createHash('sha256').update(`${priced}|${cost}|${pricingVersion ?? ''}`).digest('hex');
}

function appendObservation(
  db: Database,
  refKey: string,
  observedAt: number,
  projection: string,
  payloadJson: string,
  magpieVersion: string | null,
  pricingVersion: string | null,
): boolean {
  const latest = db.query<{ observed_at: number; projection_hash: string }, [string]>(
    'SELECT observed_at, projection_hash FROM cost_observation WHERE ref_key=? ORDER BY observed_at DESC LIMIT 1',
  ).get(refKey);
  if (latest != null && latest.projection_hash === projection) return false;
  if (latest != null && observedAt <= latest.observed_at) {
    // 带上证据键与最新时点：调用方要能记下“停在哪条证据、等哪个时刻过去”。
    const error = new Error('cost_observation_conflict') as Error & {
      ref_key?: string; blocked_at?: number;
    };
    error.ref_key = refKey;
    error.blocked_at = latest.observed_at;
    throw error;
  }
  db.run(
    'INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json,magpie_version,pricing_version) VALUES (?,?,?,?,?,?)',
    [refKey, observedAt, projection, payloadJson, magpieVersion, pricingVersion],
  );
  return true;
}

type CostMatch = { reqId: number; refKey: string } | 'ambiguous' | null;

function matchCostRow(db: Database, row: Record<string, unknown>, routeId: number): CostMatch {
  const requests = db.query<{ req_id: number; status: number | null; response_id_norm: string | null; in_tok: number | null; out_tok: number | null; started_ms: number }, [number]>(
    "SELECT req_id,status,response_id_norm,in_tok,out_tok,started_ms FROM request WHERE route_id=? AND via!='rejected'",
  ).all(routeId);
  if (requests.length === 0) return null;
  if (requests.length > 1) return 'ambiguous';
  const request = requests[0]!;
  if (row.handed_on === true) return 'ambiguous';
  const status = optionalNumber(row, 'status');
  if (status !== null && request.status !== null && status !== request.status) return 'ambiguous';
  const responseId = optionalString(row, 'response_id') ?? optionalString(row, 'responseId');
  const normalized = normalizeResponseId(responseId);
  if (normalized !== null && request.response_id_norm !== null && normalized !== request.response_id_norm) return 'ambiguous';
  const time = parseTimestamp(row.t ?? row.time);
  if (time !== null && Math.abs(time - request.started_ms) > 10 * 60 * 1000) return 'ambiguous';
  const inTok = optionalNumber(row, 'in');
  if (inTok !== null && request.in_tok !== null && inTok !== request.in_tok) return 'ambiguous';
  const outTok = optionalNumber(row, 'out');
  if (outTok !== null && request.out_tok !== null && outTok !== request.out_tok) return 'ambiguous';
  const evidence = db.query<{ ref_key: string }, [number]>(
    "SELECT ref_key FROM request_evidence WHERE req_id=? AND source_kind='ledger' ORDER BY ref_key LIMIT 2",
  ).all(request.req_id);
  if (evidence.length !== 1) return 'ambiguous';
  return { reqId: request.req_id, refKey: evidence[0]!.ref_key };
}

function applyRequestCost(
  db: Database,
  reqId: number,
  row: Record<string, unknown>,
  observedAt: number,
  pricingVersion: string | null,
): void {
  const state = costState(row);
  const cost = state === 'priced' || state === 'zero' ? Number(row.cost) : null;
  const reason = state === 'unpriced' ? 'unpriced'
    : state === 'absent' ? 'cost_api_absent'
    : pricingVersion === null ? 'pricing_version_unknown'
    : null;
  db.run(
    `UPDATE request SET cost=?, cost_state=?, cost_at=?, pricing_version=COALESCE(?,pricing_version),
       cost_reason=?, attempt_cost=?, attempt_cost_state=?, updated_at=? WHERE req_id=?`,
    [cost, state, observedAt, pricingVersion, reason, cost, state, observedAt, reqId],
  );
}

export async function syncCosts(
  store: Store,
  period: string,
  baseUrl: string,
  now: number,
  salt: Uint8Array,
  fetcher: typeof fetch = fetch,
): Promise<CostSyncResult> {
  validateCostPeriod(period);
  void now;
  let state = readCostWindow(store, period);
  if (state === null) state = { run_id: randomUUID(), next_offset: 0, done: false };
  else if (state.done) state = { run_id: state.run_id, next_offset: 0, done: false };

  const base = baseUrl.replace(/\/$/, '');
  const result: CostSyncResult = { pages: 0, observations: 0, matched: 0, ambiguous: 0 };
  const magpieVersion = probeVersion(store);

  for (;;) {
    const offset: number = state.next_offset;
    const url = `${base}/v1/magpie/usage/requests?period=${encodeURIComponent(period)}&via=through&computer=this&offset=${offset}&limit=500`;
    const response = await fetcher(url);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('cost_api_denied');
      throw new Error('cost_api_failed');
    }
    const page = await response.json() as unknown;
    assertCostPagePeriod(page, period);
    if (!isRecord(page) || !Array.isArray(page.rows) || typeof page.offset !== 'number') {
      throw new Error('cost_api_invalid_page');
    }
    if (page.offset !== offset) throw new Error('cost_api_offset_mismatch');
    const rows = page.rows;
    const saved = readCostWindow(store, period);
    if (rows.length === 0 && offset === 0 && saved?.done === true) {
      result.pages += 1;
      break;
    }
    const observedAt = Date.now();
    const pricingVersion = optionalString(page, 'pricing_version');
    const pageCounts = new Map<number, number>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const routeId = optionalNumber(row, 'route_id');
      if (routeId !== null) pageCounts.set(routeId, (pageCounts.get(routeId) ?? 0) + 1);
    }

    let pageResult: { observations: number; matched: number; ambiguous: number; done: boolean };
    try {
      pageResult = store.write(db => {
        let observations = 0;
        let matched = 0;
        let ambiguous = 0;
        for (let index = 0; index < rows.length; index++) {
          const raw = rows[index];
          const row = isRecord(raw) ? raw : {};
          const routeId = optionalNumber(row, 'route_id');
          const match = routeId === null || pageCounts.get(routeId) !== 1
            ? (routeId !== null && (pageCounts.get(routeId) ?? 0) > 1 ? 'ambiguous' as const : null)
            : matchCostRow(db, row, routeId);
          const refKey = typeof match === 'object' && match !== null
            ? match.refKey
            : JSON.stringify(['cost-run', state!.run_id, offset, index]);
          const projection = projectionHash(row, pricingVersion);
          const inserted = appendObservation(
            db,
            refKey,
            observedAt,
            projection,
            JSON.stringify(redact(row, salt)),
            magpieVersion,
            pricingVersion,
          );
          if (inserted) observations += 1;
          if (typeof match === 'object' && match !== null) {
            applyRequestCost(db, match.reqId, row, observedAt, pricingVersion);
            matched += 1;
          } else if (match === 'ambiguous') {
            ambiguous += 1;
            if (routeId !== null) {
              const candidates = db.query<{ req_id: number }, [number]>(
                "SELECT req_id FROM request WHERE route_id=? AND via!='rejected'",
              ).all(routeId);
              for (const candidate of candidates) {
                db.run(
                  "UPDATE request SET cost_reason=CASE WHEN cost_state='absent' THEN 'ambiguous_cost' ELSE cost_reason END WHERE req_id=?",
                  [candidate.req_id],
                );
              }
            }
          }
        }
        const done = rows.length === 0 || rows.length < 500;
        saveCostWindow(db, period, {
          run_id: state!.run_id,
          next_offset: done ? 0 : offset + rows.length,
          done,
        });
        return { observations, matched, ambiguous, done };
      }, 'cost');
    } catch (error) {
      if (error instanceof Error && error.message === 'cost_observation_conflict') {
        // 整页已回滚，进度没动；把冲突记下来再抛出，采集侧据此显示费用停滞。
        const conflict = error as Error & { ref_key?: string; blocked_at?: number };
        recordCostConflict(store, period, conflict.ref_key ?? '', conflict.blocked_at ?? 0, Date.now());
        throw error;
      }
      throw error;
    }

    result.pages += 1;
    result.observations += pageResult.observations;
    result.matched += pageResult.matched;
    result.ambiguous += pageResult.ambiguous;
    state = { run_id: state.run_id, next_offset: pageResult.done ? 0 : offset + rows.length, done: pageResult.done };
    if (pageResult.done) break;
  }
  return result;
}
