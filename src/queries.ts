import type { Store } from './store';

export type Page<T> = { items: T[]; next_cursor: string | null };
export type CostState = 'priced' | 'zero' | 'unpriced' | 'absent';
export type BodyState = 'pending' | 'available' | 'partial' | 'evicted' | 'unsupported';

export type RequestRow = {
  req_id: number; conv_key: string; actor: string | null;
  actor_state: 'known' | 'unknown'; started_ms: number;
  title: string; status: number | null; model_requested: string | null;
  model_served: string | null; in_tok: number | null; out_tok: number | null;
  cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: CostState; have: number;
  body_state: BodyState; miss_reason: string | null;
};

export type SessionRow = {
  conv_key: string; title: string; last_ms: number; request_count: number;
  agents: string[]; flags: string[];
};

export type ToolCallRow = {
  call_id: string; ord: number; tool_name: string | null;
  result_req: number | null; result_ord: number | null;
  result_path: string | null; state: string;
};

export type RequestDetail = RequestRow & {
  prev_req_id: number | null;
  prev_relation: 'confirmed' | 'unknown' | 'first' | null;
  delta_ordinals: number[] | null;
  parse_state: string | null;
  reply_state: string | null;
  ms: number | null;
  ttft_ms: number | null;
  flow_ms: number | null;
  first_text_ms: number | null;
  reasoning: number | null;
  prompt_tokens: number | null;
  prompt_counted: number | null;
  prompt_window: number | null;
  prompt_turns: number | null;
  parts: unknown;
  attempt_count: number | null;
  attempt_billed: number | null;
  attempt_in: number | null;
  attempt_out: number | null;
  attempt_cache_read: number | null;
  attempt_cache_write: number | null;
  attempt_reasoning: number | null;
  attempt_cost: number | null;
  attempt_cost_state: CostState;
  title_source: string;
  derive_version: number;
  archive: string | null;
  route_state: string;
  tool_calls: ToolCallRow[];
};

export class QueryInputError extends Error {}

function encodeCursor(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string, check: (value: unknown) => T | null): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new QueryInputError('invalid_cursor');
  }
  const checked = check(parsed);
  if (checked === null) throw new QueryInputError('invalid_cursor');
  return checked;
}

function checkLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new QueryInputError('invalid_limit');
  return limit;
}

type SessionDbRow = {
  conv_key: string; last_ms: number; request_count: number; title: string | null; agents: string | null;
};

export function listSessions(store: Store, limit = 50, cursor: string | null = null): Page<SessionRow> {
  const size = checkLimit(limit, 100);
  const bound = cursor === null
    ? null
    : decodeCursor(cursor, value => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [lastMs, convKey] = value;
      if (typeof lastMs !== 'number' || !Number.isFinite(lastMs) || typeof convKey !== 'string') return null;
      return { lastMs, convKey };
    });
  const rows = (bound === null
    ? store.read.query<SessionDbRow, [number]>(`
        SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
               MAX(title) AS title, GROUP_CONCAT(DISTINCT actor) AS agents
        FROM request
        WHERE conv_key IS NOT NULL
        GROUP BY conv_key
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(size + 1)
    : store.read.query<SessionDbRow, [number, string, number]>(`
        SELECT conv_key, last_ms, request_count, title, agents FROM (
          SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
                 MAX(title) AS title, GROUP_CONCAT(DISTINCT actor) AS agents
          FROM request
          WHERE conv_key IS NOT NULL
          GROUP BY conv_key
        ) GROUPED
        WHERE (last_ms, conv_key) < (?, ?)
        ORDER BY last_ms DESC, conv_key DESC
        LIMIT ?`)
      .all(bound.lastMs, bound.convKey, size + 1)) as SessionDbRow[];

  const page = rows.slice(0, size);
  const items: SessionRow[] = page.map(row => ({
    conv_key: row.conv_key,
    title: row.title ?? '',
    last_ms: row.last_ms,
    request_count: row.request_count,
    agents: row.agents === null ? [] : row.agents.split(',').filter(value => value.length > 0),
    flags: [],
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > size && last !== undefined
    ? encodeCursor([last.last_ms, last.conv_key])
    : null;
  return { items, next_cursor: nextCursor };
}

type RequestDbRow = Omit<RequestRow, 'conv_key'> & { conv_key: string | null };

const REQUEST_COLUMNS = `req_id, conv_key, actor, actor_state, started_ms, title, status, model_requested,
  model_served, in_tok, out_tok, cache_read, cache_write, cost, cost_state, have, body_state, miss_reason`;

export function listRequests(store: Store, key: string, limit = 100, cursor: string | null = null): Page<RequestRow> {
  const size = checkLimit(limit, 200);
  const bound = cursor === null
    ? null
    : decodeCursor(cursor, value => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [startedMs, reqId] = value;
      if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || !Number.isInteger(reqId)) return null;
      return { startedMs, reqId };
    });
  const rows = (bound === null
    ? store.read.query<RequestDbRow, [string, number]>(`
        SELECT ${REQUEST_COLUMNS} FROM request
        WHERE conv_key = ?
        ORDER BY started_ms DESC, req_id DESC
        LIMIT ?`)
      .all(key, size + 1)
    : store.read.query<RequestDbRow, [string, number, number, number]>(`
        SELECT ${REQUEST_COLUMNS} FROM request
        WHERE conv_key = ? AND (started_ms, req_id) < (?, ?)
        ORDER BY started_ms DESC, req_id DESC
        LIMIT ?`)
      .all(key, bound.startedMs, bound.reqId, size + 1)) as RequestDbRow[];

  const page = rows.slice(0, size);
  const items = page.map(row => ({ ...row, conv_key: row.conv_key ?? key }) as RequestRow);
  const last = page[page.length - 1];
  const nextCursor = rows.length > size && last !== undefined
    ? encodeCursor([last.started_ms, last.req_id])
    : null;
  return { items, next_cursor: nextCursor };
}

type DetailDbRow = {
  req_id: number; conv_key: string | null; actor: string | null; actor_state: string;
  started_ms: number; title: string | null; status: number | null;
  model_requested: string | null; model_served: string | null;
  in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: string | null; have: number; body_state: string;
  miss_reason: string | null; prev_req_id: number | null; prev_relation: string | null;
  delta_ordinals: string | null; parse_state: string | null; reply_state: string | null;
  ms: number | null; ttft_ms: number | null; flow_ms: number | null; first_text_ms: number | null;
  reasoning: number | null; prompt_tokens: number | null; prompt_counted: number | null;
  prompt_window: number | null; prompt_turns: number | null; parts_json: string | null;
  attempt_count: number | null; attempt_billed: number | null; attempt_in: number | null;
  attempt_out: number | null; attempt_cache_read: number | null; attempt_cache_write: number | null;
  attempt_reasoning: number | null; attempt_cost: number | null; attempt_cost_state: string | null;
  title_source: string | null; derive_version: number; archive: string | null;
  route_id: number | null; summary_exists: number | null;
};

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function resolveRequestId(store: Store, id: number): number | null {
  const seen = new Set<number>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const alias = store.read.query<{ new_id: number }, [number]>(
      'SELECT new_id FROM request_alias WHERE old_id=?',
    ).get(current);
    if (alias != null) {
      current = alias.new_id;
      continue;
    }
    const exists = store.read.query<{ req_id: number }, [number]>(
      'SELECT req_id FROM request WHERE req_id=?',
    ).get(current);
    return exists != null ? current : null;
  }
}

export function getRequest(store: Store, id: number): RequestDetail | null {
  const canonical = resolveRequestId(store, id);
  if (canonical === null) return null;
  const row = store.read.query<DetailDbRow, [number]>(`
    SELECT req.*, (SELECT 1 FROM route_summary s WHERE s.route_id = req.route_id) AS summary_exists
    FROM request req WHERE req.req_id = ?`).get(canonical) as DetailDbRow | null;
  if (row == null) return null;
  const toolCalls = store.read.query<ToolCallRow, [number]>(`
    SELECT call_id, ord, tool_name, result_req, result_ord, result_path, state
    FROM tool_call WHERE req_id = ? ORDER BY ord`).all(canonical);
  const routeState = row.route_id === null
    ? 'absent'
    : row.summary_exists === null ? 'expired' : 'available';
  return {
    req_id: row.req_id,
    conv_key: row.conv_key ?? '',
    actor: row.actor,
    actor_state: row.actor_state === 'known' ? 'known' : 'unknown',
    started_ms: row.started_ms,
    title: row.title ?? '',
    status: row.status,
    model_requested: row.model_requested,
    model_served: row.model_served,
    in_tok: row.in_tok,
    out_tok: row.out_tok,
    cache_read: row.cache_read,
    cache_write: row.cache_write,
    cost: row.cost,
    cost_state: (row.cost_state ?? 'absent') as CostState,
    have: row.have,
    body_state: row.body_state as BodyState,
    miss_reason: row.miss_reason,
    prev_req_id: row.prev_req_id,
    prev_relation: row.prev_relation as RequestDetail['prev_relation'],
    delta_ordinals: Array.isArray(parseJsonOrNull(row.delta_ordinals)) ? parseJsonOrNull(row.delta_ordinals) as number[] : null,
    parse_state: row.parse_state,
    reply_state: row.reply_state,
    ms: row.ms,
    ttft_ms: row.ttft_ms,
    flow_ms: row.flow_ms,
    first_text_ms: row.first_text_ms,
    reasoning: row.reasoning,
    prompt_tokens: row.prompt_tokens,
    prompt_counted: row.prompt_counted,
    prompt_window: row.prompt_window,
    prompt_turns: row.prompt_turns,
    parts: parseJsonOrNull(row.parts_json),
    attempt_count: row.attempt_count,
    attempt_billed: row.attempt_billed,
    attempt_in: row.attempt_in,
    attempt_out: row.attempt_out,
    attempt_cache_read: row.attempt_cache_read,
    attempt_cache_write: row.attempt_cache_write,
    attempt_reasoning: row.attempt_reasoning,
    attempt_cost: row.attempt_cost,
    attempt_cost_state: (row.attempt_cost_state ?? 'absent') as CostState,
    title_source: row.title_source ?? 'model_time',
    derive_version: row.derive_version,
    archive: row.archive,
    route_state: routeState,
    tool_calls: toolCalls,
  };
}

export function getRoute(store: Store, id: number): { state: 'available' | 'absent' | 'expired'; summary: unknown } {
  const canonical = resolveRequestId(store, id);
  if (canonical === null) return { state: 'absent', summary: null };
  const request = store.read.query<{ route_id: number | null }, [number]>(
    'SELECT route_id FROM request WHERE req_id=?',
  ).get(canonical);
  if (request == null || request.route_id === null) return { state: 'absent', summary: null };
  const summary = store.read.query<{
    route_id: number; time_ms: number; model: string | null; served: string | null; provider: string | null;
    status: number | null; ms: number | null; ttft: number | null; flow: number | null; first_text: number | null;
    order_json: string | null; tries_json: string | null; affinity_json: string | null;
  }, [number]>(`
    SELECT route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,order_json,tries_json,affinity_json
    FROM route_summary WHERE route_id=?`).get(request.route_id);
  if (summary == null) return { state: 'expired', summary: null };
  return {
    state: 'available',
    summary: {
      route_id: summary.route_id,
      time_ms: summary.time_ms,
      model: summary.model,
      served: summary.served,
      provider: summary.provider,
      status: summary.status,
      ms: summary.ms,
      ttft: summary.ttft,
      flow: summary.flow,
      first_text: summary.first_text,
      order: parseJsonOrNull(summary.order_json),
      tries: parseJsonOrNull(summary.tries_json),
      affinity: parseJsonOrNull(summary.affinity_json),
    },
  };
}

export type Stats = {
  cursors: {
    source_kind: string; source_name: string; file_generation: string;
    committed_off: number; observed_off: number; last_ok_ms: number;
  }[];
  issues: { source_kind: string; reason: string; count: number }[];
  gaps: { source_kind: string; source_name: string; state: string; from_off: number; to_off: number }[];
  pending_hooks: number;
  requests: number;
  body_states: { state: string; count: number }[];
  open_gaps: number;
  /** 费用扫描因系统时钟回退停住时的计数与阻塞时点；正常时为 null。 */
  cost_health: unknown;
  probe: unknown;
};

export function getStats(store: Store): Stats {
  const cursors = store.read.query(`
    SELECT source_kind, source_name, file_generation, committed_off, observed_off, last_ok_ms
    FROM source_cursor ORDER BY source_kind, source_name`).all() as Stats['cursors'];
  const issues = store.read.query(`
    SELECT source_kind, reason, COUNT(*) AS count FROM ingest_issue
    GROUP BY source_kind, reason ORDER BY source_kind, reason`).all() as Stats['issues'];
  const gaps = store.read.query(`
    SELECT source_kind, source_name, state, from_off, to_off FROM source_gap
    ORDER BY source_kind, source_name, from_off`).all() as Stats['gaps'];
  const pending = store.read.query('SELECT COUNT(*) AS n FROM pending_hook').get() as { n: number };
  const requests = store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number };
  const bodyStates = store.read.query(`
    SELECT body_state AS state, COUNT(*) AS count FROM request GROUP BY body_state ORDER BY body_state`)
    .all() as Stats['body_states'];
  const openGaps = store.read.query(
    "SELECT COUNT(*) AS n FROM source_gap WHERE state IN ('open','resumable')").get() as { n: number };
  const probe = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['magpie', 'probe']));
  const costHealth = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['cost', 'clock_conflict']));
  return {
    cursors,
    issues,
    gaps,
    pending_hooks: pending.n,
    requests: requests.n,
    body_states: bodyStates,
    open_gaps: openGaps.n,
    cost_health: costHealth == null ? null : parseJsonOrNull(costHealth.value_json),
    probe: probe == null ? null : parseJsonOrNull(probe.value_json),
  };
}
