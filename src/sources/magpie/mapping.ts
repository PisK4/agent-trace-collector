/** magpie 记录的字段映射：字段读取原语、时间与响应 ID 规范化、账本与路由映射。 */

import { localDay } from '../../format';

/**
 * 来源字段的读取状态。
 *
 * `reported` 是读到了值；`empty` 是上游写了空串，`absent` 是上游没有这个键；
 * 两者都不是值，也都不是撤销。`invalid` 是键在但类型不对：值保持 null，
 * 不猜、不转、不抛错。
 */
export type FieldState = 'reported' | 'empty' | 'absent' | 'invalid';

/** `prompt.counted` 是布尔三态；省略等于未校准，不等于 false。 */
export type CountedState = 'true' | 'false' | 'absent' | 'invalid';

export type LedgerShape = {
  req: FieldState;
  model: FieldState;
  served: FieldState;
  cost: FieldState;
  err: FieldState;
  errType: FieldState;
  kind: FieldState;
};

export type RouteShape = {
  kind: FieldState;
  model: FieldState;
  served: FieldState;
  error: FieldState;
  prompt: 'reported' | 'absent' | 'invalid';
  promptCounted: CountedState;
};

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
  err: string | null;
  errType: string | null;
  computer: string | null;
  archive: string | null;
  tries: number | null;
  credits: number | null;
  ownCost: number | null;
  magpieVersion: string | null;
  shape: LedgerShape;
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
  shape: RouteShape;
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

/**
 * 读取一个字符串字段并给出状态。
 *
 * 上游把"没有这个键"、"写了空串"和"写了别的类型"表达成三件不同的事，
 * 合并成 null 会让"没报"与"报了个空值"看起来一样。
 */
function stringField(row: Record<string, unknown>, key: string): { value: string | null; state: FieldState } {
  if (!Object.hasOwn(row, key)) return { value: null, state: 'absent' };
  const value = row[key];
  if (value === null || value === undefined) return { value: null, state: 'absent' };
  if (typeof value !== 'string') return { value: null, state: 'invalid' };
  if (value.length === 0) return { value: null, state: 'empty' };
  return { value, state: 'reported' };
}

function numberField(row: Record<string, unknown>, key: string): { value: number | null; state: FieldState } {
  if (!Object.hasOwn(row, key)) return { value: null, state: 'absent' };
  const value = row[key];
  if (value === null || value === undefined) return { value: null, state: 'absent' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { value: null, state: 'invalid' };
  return { value, state: 'reported' };
}

type PromptFields = {
  state: 'reported' | 'absent' | 'invalid';
  tokens: number | null;
  counted: 0 | 1 | null;
  countedState: CountedState;
  window: number | null;
  turns: number | null;
  parts: unknown;
};

/**
 * 路由行的 prompt 家族。tokens 不是合法非负数时整组记 `invalid`：
 * 没有分母的窗口与轮数不能单独拿出去当事实。
 */
function promptFields(record: Record<string, unknown>): PromptFields {
  const absent: PromptFields = {
    state: 'absent', tokens: null, counted: null, countedState: 'absent',
    window: null, turns: null, parts: null,
  };
  if (!Object.hasOwn(record, 'prompt') || record.prompt === null) return absent;
  if (!isRecord(record.prompt)) return { ...absent, state: 'invalid', countedState: 'invalid' };
  const prompt = record.prompt;
  const tokens = numberField(prompt, 'tokens');
  if (tokens.value === null || tokens.value < 0) {
    return { ...absent, state: 'invalid', countedState: 'invalid' };
  }
  let counted: 0 | 1 | null;
  let countedState: CountedState;
  if (!Object.hasOwn(prompt, 'counted')) {
    counted = 0;
    countedState = 'absent';
  } else if (prompt.counted === true) {
    counted = 1;
    countedState = 'true';
  } else if (prompt.counted === false) {
    counted = 0;
    countedState = 'false';
  } else {
    counted = null;
    countedState = 'invalid';
  }
  return {
    state: 'reported', tokens: tokens.value, counted, countedState,
    window: optionalNumber(prompt, 'window'), turns: optionalNumber(prompt, 'turns'),
    parts: prompt.parts ?? null,
  };
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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
  // 模型三列各读自己的上游键，不互相顶替：`model` 是 provider 侧的模型 id，
  // `req` 是 agent 请求的模型（别名、路由组或 provider/model），`served` 是
  // 厂商回复里说它答了哪个。账本里没有 `requested` 这个键。
  const requested = stringField(row, 'req');
  const model = stringField(row, 'model');
  const served = stringField(row, 'served');
  // 客户自报费用在上游是 `cost`，不是 `own_cost`；后者只存在于早期账本。
  const cost = numberField(row, 'cost');
  const err = stringField(row, 'err');
  const errType = stringField(row, 'err_type');
  const kind = stringField(row, 'kind');
  const account = stringField(row, 'account');
  const providerAccount = stringField(row, 'providerAccount');
  return {
    routeId: optionalNumber(row, 'route_id') ?? optionalNumber(row, 'routeId'),
    tText: typeof row.t === 'string' ? row.t : String(row.t ?? tMs),
    tMs,
    source,
    via: optionalString(row, 'via'),
    handedOn: row.handed_on === true || row.handed_on === 1 ? 1 : 0,
    kind: kind.value,
    agent: optionalString(row, 'agent'),
    provider: optionalString(row, 'provider'),
    host: optionalString(row, 'host'),
    account: account.value ?? providerAccount.value,
    model: model.value,
    requested: requested.value,
    served: served.value,
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
    err: err.value,
    errType: errType.value,
    computer: optionalString(row, 'computer'),
    archive: optionalString(row, 'archive'),
    tries: optionalNumber(row, 'tries') ?? (prompt === null ? null : optionalNumber(prompt, 'tries')),
    credits: optionalNumber(row, 'credits'),
    ownCost: cost.value,
    magpieVersion: optionalString(row, 'magpie_version') ?? optionalString(row, 'version'),
    shape: {
      req: requested.state, model: model.state, served: served.state, cost: cost.state,
      err: err.state, errType: errType.state, kind: kind.state,
    },
  };
}

export function mapRouteRow(record: Record<string, unknown>): RouteFields | null {
  const routeId = optionalNumber(record, 'id') ?? optionalNumber(record, 'route_id');
  const timeMs = parseTimestamp(record.time);
  if (routeId === null || timeMs === null) return null;
  const prompt = promptFields(record);
  const kind = stringField(record, 'kind');
  const model = stringField(record, 'model');
  const served = stringField(record, 'served');
  const error = stringField(record, 'error');
  return {
    routeId,
    timeMs,
    day: localDay(timeMs),
    agent: optionalString(record, 'agent'),
    session: optionalString(record, 'session'),
    conv: optionalString(record, 'conv'),
    folder: optionalString(record, 'folder'),
    subagentId: optionalString(record, 'subagent_id') ?? optionalString(record, 'subagentId'),
    kind: kind.value,
    forJson: record.for === undefined ? null : JSON.stringify(record.for),
    model: model.value,
    provider: optionalString(record, 'provider'),
    served: served.value,
    effort: optionalString(record, 'effort'),
    status: optionalNumber(record, 'status'),
    error: error.value,
    done: typeof record.done === 'boolean' ? (record.done ? 1 : 0) : optionalNumber(record, 'done'),
    ms: optionalNumber(record, 'ms'),
    ttft: optionalNumber(record, 'ttft'),
    firstText: optionalNumber(record, 'firstText'),
    flow: optionalNumber(record, 'flow'),
    tokens: prompt.state === 'reported' ? prompt.tokens : optionalNumber(record, 'tokens'),
    outTok: optionalNumber(record, 'out') ?? optionalNumber(record, 'out_tok'),
    reasoning: optionalNumber(record, 'reasoning'),
    order: Array.isArray(record.order) ? record.order : null,
    tries: Array.isArray(record.tries) ? record.tries : null,
    affinity: record.affinity ?? null,
    promptTokens: prompt.state === 'reported' ? prompt.tokens : null,
    promptCounted: prompt.state === 'reported' ? prompt.counted : null,
    promptWindow: prompt.state === 'reported' ? prompt.window : null,
    promptTurns: prompt.state === 'reported' ? prompt.turns : null,
    promptParts: prompt.state === 'reported' ? prompt.parts : null,
    magpieVersion: optionalString(record, 'magpie_version') ?? optionalString(record, 'version'),
    shape: {
      kind: kind.state, model: model.state, served: served.state, error: error.state,
      prompt: prompt.state, promptCounted: prompt.countedState,
    },
  };
}
