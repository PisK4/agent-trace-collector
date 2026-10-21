import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { Store } from '../store';
import { redact } from '../privacy';

export type ProbeResult = { version: string | null; verified: boolean; reason: string | null };

export type CostSyncResult = { pages: number; observations: number; matched: number; ambiguous: number };

export type LedgerFields = {
  routeId: number | null;
  tText: string;
  tMs: number;
  source: 'through' | 'rejected';
  via: string | null;
  handedOn: number;
  kind: string | null;
  agent: string | null;
  provider: string | null;
  host: string | null;
  account: string | null;
  model: string | null;
  requested: string | null;
  served: string | null;
  inTok: number | null;
  outTok: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  effort: string | null;
  ms: number | null;
  status: number | null;
  stop: string | null;
  responseId: string | null;
  responseIdNorm: string | null;
  rid: string | null;
  ep: string | null;
  session: string | null;
  nativeSession: string | null;
  subagent: string | null;
  parentAgent: string | null;
  ttftMs: number | null;
  flowMs: number | null;
  firstTextMs: number | null;
  sentMs: number | null;
  retriedMs: number | null;
  queuedMs: number | null;
  ownMs: number | null;
  reasoningHidden: number | null;
  tierAsked: string | null;
  tierSent: string | null;
  tierServed: string | null;
  errType: string | null;
  computer: string | null;
  archive: string | null;
  tries: number | null;
  credits: number | null;
  ownCost: number | null;
  magpieVersion: string | null;
};

export type RouteFields = {
  routeId: number;
  timeMs: number;
  day: string;
  agent: string | null;
  session: string | null;
  conv: string | null;
  folder: string | null;
  subagentId: string | null;
  kind: string | null;
  forJson: string | null;
  model: string | null;
  provider: string | null;
  served: string | null;
  effort: string | null;
  status: number | null;
  error: string | null;
  done: number | null;
  ms: number | null;
  ttft: number | null;
  firstText: number | null;
  flow: number | null;
  tokens: number | null;
  outTok: number | null;
  reasoning: number | null;
  order: unknown[] | null;
  tries: unknown[] | null;
  affinity: unknown;
  promptTokens: number | null;
  promptCounted: number | null;
  promptWindow: number | null;
  promptTurns: number | null;
  promptParts: unknown;
  magpieVersion: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  return Object.hasOwn(row, key) && typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : null;
}

export function optionalString(row: Record<string, unknown>, key: string): string | null {
  return Object.hasOwn(row, key) && typeof row[key] === 'string' && row[key].length > 0 ? row[key] : null;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function modelTimeTitle(model: string | null, ms: number): string {
  const date = new Date(ms);
  return `${model ?? 'unknown'} · ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const RESPONSE_PREFIXES = ['chatcmpl-', 'msg_resp_', 'msg_', 'resp_'];

export function normalizeResponseId(id: string | null): string | null {
  if (id === null || id.length === 0) return null;
  for (const prefix of RESPONSE_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return id;
}

export function classifyLedger(row: Record<string, unknown>): 'through' | 'rejected' {
  return row.rejected === true ||
    ((row.provider == null || row.provider === '') && Number(row.status) >= 400)
    ? 'rejected'
    : 'through';
}

export function mapLedgerRow(row: Record<string, unknown>): LedgerFields | null {
  const tMs = parseTimestamp(row.t ?? row.time);
  if (tMs === null) return null;
  const responseId = optionalString(row, 'response_id') ?? optionalString(row, 'responseId');
  const source = classifyLedger(row);
  const prompt = isRecord(row.prompt) ? row.prompt : null;
  return {
    routeId: optionalNumber(row, 'route_id') ?? optionalNumber(row, 'routeId'),
    tText: typeof row.t === 'string' ? row.t : String(row.t ?? tMs),
    tMs,
    source,
    via: optionalString(row, 'via'),
    handedOn: row.handed_on === true || row.handed_on === 1 ? 1 : 0,
    kind: optionalString(row, 'kind'),
    agent: optionalString(row, 'agent'),
    provider: optionalString(row, 'provider'),
    host: optionalString(row, 'host'),
    account: optionalString(row, 'account') ?? optionalString(row, 'providerAccount'),
    model: optionalString(row, 'model'),
    requested: optionalString(row, 'requested'),
    served: optionalString(row, 'served'),
    inTok: optionalNumber(row, 'in') ?? optionalNumber(row, 'input_tokens'),
    outTok: optionalNumber(row, 'out') ?? optionalNumber(row, 'output_tokens'),
    cacheRead: optionalNumber(row, 'cache_read'),
    cacheWrite: optionalNumber(row, 'cache_write'),
    reasoning: optionalNumber(row, 'reasoning'),
    effort: optionalString(row, 'effort'),
    ms: optionalNumber(row, 'ms'),
    status: optionalNumber(row, 'status'),
    stop: optionalString(row, 'stop'),
    responseId,
    responseIdNorm: normalizeResponseId(responseId),
    rid: optionalString(row, 'rid'),
    ep: optionalString(row, 'ep'),
    session: optionalString(row, 'session'),
    nativeSession: optionalString(row, 'native_session'),
    subagent: optionalString(row, 'subagent'),
    parentAgent: optionalString(row, 'parent_agent'),
    ttftMs: optionalNumber(row, 'ttft_ms'),
    flowMs: optionalNumber(row, 'flow_ms'),
    firstTextMs: optionalNumber(row, 'first_text_ms'),
    sentMs: optionalNumber(row, 'sent_ms'),
    retriedMs: optionalNumber(row, 'retried_ms'),
    queuedMs: optionalNumber(row, 'queued_ms'),
    ownMs: optionalNumber(row, 'own_ms'),
    reasoningHidden: optionalNumber(row, 'reasoning_hidden'),
    tierAsked: optionalString(row, 'tier_asked'),
    tierSent: optionalString(row, 'tier_sent'),
    tierServed: optionalString(row, 'tier_served'),
    errType: optionalString(row, 'err_type'),
    computer: optionalString(row, 'computer'),
    archive: optionalString(row, 'archive'),
    tries: optionalNumber(row, 'tries') ?? (prompt === null ? null : optionalNumber(prompt, 'tries')),
    credits: optionalNumber(row, 'credits'),
    ownCost: optionalNumber(row, 'own_cost') ?? optionalNumber(row, 'ownCost'),
    magpieVersion: optionalString(row, 'magpie_version') ?? optionalString(row, 'version'),
  };
}

export function mapRouteRow(record: Record<string, unknown>): RouteFields | null {
  const routeId = optionalNumber(record, 'id') ?? optionalNumber(record, 'route_id');
  const timeMs = parseTimestamp(record.time);
  if (routeId === null || timeMs === null) return null;
  const prompt = isRecord(record.prompt) ? record.prompt : null;
  return {
    routeId,
    timeMs,
    day: localDay(timeMs),
    agent: optionalString(record, 'agent'),
    session: optionalString(record, 'session'),
    conv: optionalString(record, 'conv'),
    folder: optionalString(record, 'folder'),
    subagentId: optionalString(record, 'subagent_id') ?? optionalString(record, 'subagentId'),
    kind: optionalString(record, 'kind'),
    forJson: record.for === undefined ? null : JSON.stringify(record.for),
    model: optionalString(record, 'model'),
    provider: optionalString(record, 'provider'),
    served: optionalString(record, 'served'),
    effort: optionalString(record, 'effort'),
    status: optionalNumber(record, 'status'),
    error: optionalString(record, 'error'),
    done: typeof record.done === 'boolean' ? (record.done ? 1 : 0) : optionalNumber(record, 'done'),
    ms: optionalNumber(record, 'ms'),
    ttft: optionalNumber(record, 'ttft'),
    firstText: optionalNumber(record, 'first_text'),
    flow: optionalNumber(record, 'flow'),
    tokens: prompt === null ? optionalNumber(record, 'tokens') : optionalNumber(prompt, 'tokens'),
    outTok: optionalNumber(record, 'out') ?? optionalNumber(record, 'out_tok'),
    reasoning: optionalNumber(record, 'reasoning'),
    order: Array.isArray(record.order) ? record.order : null,
    tries: Array.isArray(record.tries) ? record.tries : null,
    affinity: record.affinity ?? null,
    promptTokens: prompt === null ? null : optionalNumber(prompt, 'tokens'),
    promptCounted: prompt === null ? null : optionalNumber(prompt, 'counted'),
    promptWindow: prompt === null ? null : optionalNumber(prompt, 'window'),
    promptTurns: prompt === null ? null : optionalNumber(prompt, 'turns'),
    promptParts: prompt === null ? null : prompt.parts ?? null,
    magpieVersion: optionalString(record, 'magpie_version') ?? optionalString(record, 'version'),
  };
}

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

function versionVerified(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== 0) return false;
  if (minor > 1) return false;
  return minor === 1 && patch >= 1294;
}

export async function probeMagpie(
  baseUrl: string,
  versionFile: string,
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  let fileVersion: string | null = null;
  try {
    const text = readFileSync(versionFile, 'utf8').trim();
    fileVersion = text.length > 0 ? text : null;
  } catch {
    fileVersion = null;
  }
  let httpVersion: string | null = null;
  let httpOk = false;
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1`);
    if (response.ok) {
      const body = await response.json() as unknown;
      if (isRecord(body) && typeof body.version === 'string' && body.version.length > 0) {
        httpVersion = body.version;
        httpOk = true;
      }
    }
  } catch {
    httpOk = false;
  }
  const version = httpVersion ?? fileVersion;
  if (version === null) return { version: null, verified: false, reason: 'version_unavailable' };
  const verified = versionVerified(version);
  if (!verified) return { version, verified, reason: 'version_out_of_range' };
  return { version, verified, reason: httpOk ? null : 'http_unavailable' };
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
  ));
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

function probeVersion(store: Store): string | null {
  const row = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['magpie', 'probe']));
  if (row == null) return null;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
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
  store.write(db => saveCostWindow(db, period, state!));

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
      });
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
