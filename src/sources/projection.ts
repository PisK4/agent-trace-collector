import type { Database } from 'bun:sqlite';
import {
  isRecord,
  localDay,
  mapLedgerRow,
  mapRouteRow,
} from './magpie';
import type { LedgerFields, RouteFields } from './magpie';
import { HAVE_LEDGER } from '../evidence';
import {
  buildProjectionMeta,
  buildSourceFacts,
  readProjectionMeta,
  readSourceFacts,
  serializeFacts,
  serializeMeta,
} from './facts';

export const SOURCE_PROJECTION_VERSION = 1;
const MAX_KIND_VALUES_PER_SOURCE = 8;
const MAX_KIND_REPORT_VALUES = 16;
const MAX_HOOK_VALUES = 8;
const MAX_HOOK_BASIS = 16;

export type ProjectionFamily = 'selected' | 'attempts' | 'prompt' | 'kind' | 'hook' | 'identity';
export type ProjectionState = 'complete' | 'partial' | 'expired' | 'absent' | 'invalid' | 'conflict' | 'duplicate';
export type AttemptOutcome = 'succeeded' | 'failed' | 'pending_final';
export type ProjectionReason =
  | 'ledger_present' | 'ledger_partial' | 'ledger_expired' | 'ledger_invalid'
  | 'route_present' | 'route_summary_only' | 'route_absent' | 'route_expired' | 'route_invalid'
  | 'hook_present' | 'hook_expired' | 'hook_conflict'
  | 'kind_conflict' | 'kind_overflow' | 'kind_empty' | 'kind_invalid'
  | 'attempt_final_missing' | 'attempt_duplicate_suspect'
  | 'attempt_order_unprovable' | 'prompt_order_unprovable'
  | 'prompt_absent' | 'prompt_invalid' | 'prompt_retained'
  | 'identity_conflict' | 'identity_partial'
  | 'unsupported_source';

export type FamilyProjection = {
  state: ProjectionState;
  current: boolean;
  version: number;
  basis: string[];
  reasons: ProjectionReason[];
};

export type SelectedAttempt = {
  refKey: string;
  tMs: number;
  outcome: AttemptOutcome;
  fields: LedgerFields;
};

export type AttemptProjection = {
  state: ProjectionState;
  billed: number | null;
  inTok: number | null;
  outTok: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  count: number | null;
  startMs: number | null;
  outcome: AttemptOutcome | null;
};

export type PromptProjection = {
  state: ProjectionState;
  tokens: number | null;
  counted: 0 | 1 | null;
  window: number | null;
  turns: number | null;
  partsJson: string | null;
};

export type SourceKindProjection = {
  state: 'absent' | 'single' | 'merged' | 'conflict' | 'overflow';
  values: string[];
  merged: string | null;
  ledger: string[];
  route: string[];
};

export type HookProjection = {
  state: 'absent' | 'present' | 'expired' | 'conflict';
  models: string[];
  successes: boolean[];
  basis: string[];
};

export type LedgerIdentityProjection = {
  state: ProjectionState;
  // 尝试顺序是否可证：provable 才写排序键，unprovable 时清空排序键，unknown 表示证据不完整
  orderState: 'provable' | 'unprovable' | 'unknown';
  session: string | null;
  nativeSession: string | null;
  agent: string | null;
  subagent: string | null;
  parentAgent: string | null;
  responseIdNorm: string | null;
  startedMs: number | null;
  sortKey: string | null;
};

export type RequestProjection = {
  reqId: number;
  version: number;
  state: ProjectionState;
  selected: SelectedAttempt | null;
  attempts: AttemptProjection;
  prompt: PromptProjection;
  kind: SourceKindProjection;
  hook: HookProjection;
  identity: LedgerIdentityProjection;
  families: Record<ProjectionFamily, FamilyProjection>;
  reasons: ProjectionReason[];
};

export type PreparedLedgerEvidence = {
  kind: 'ledger';
  refKey: string;
  state: 'present' | 'expired' | 'invalid';
  fields: LedgerFields | null;
  tMs: number | null;
  generation: string | null;
  offset: number | null;
};

export type PreparedRouteEvidence = {
  kind: 'route';
  refKey: string;
  state: 'present' | 'expired' | 'invalid';
  fields: RouteFields | null;
  summaryOnly: boolean;
  triesCount: number | null;
};

export type PreparedHookEvidence = {
  kind: 'hook';
  refKey: string;
  state: 'present' | 'expired';
  model: string | null;
  success: boolean | null;
};

export type PreparedEvidence = PreparedLedgerEvidence | PreparedRouteEvidence | PreparedHookEvidence;

export type OwnerEvidence = {
  reqId: number;
  evidence: PreparedEvidence[];
  unsupported: string[];
};

type EvidenceRow = { source_kind: string; ref_key: string; payload_state: string };

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareBytes);
}

function family(
  state: ProjectionState,
  current: boolean,
  version: number,
  basis: string[],
  reasons: ProjectionReason[],
): FamilyProjection {
  return { state, current, version, basis: [...basis].sort(compareBytes), reasons };
}

function familyCurrent(state: ProjectionState): boolean {
  return state === 'complete';
}

function parseLedgerRef(refKey: string): { generation: string; offset: number } | null {
  try {
    const value = JSON.parse(refKey) as unknown;
    if (!Array.isArray(value) || value[0] !== 'file' || typeof value[1] !== 'string' ||
        !Number.isSafeInteger(value[2]) || (value[2] as number) < 0) return null;
    return { generation: value[1], offset: value[2] as number };
  } catch {
    return null;
  }
}

function parseTriesCount(json: string | null): number | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.length : null;
  } catch {
    return null;
  }
}

function invalidLedger(refKey: string, generation: string | null, offset: number | null): PreparedLedgerEvidence {
  return { kind: 'ledger', refKey, state: 'invalid', fields: null, tMs: null, generation, offset };
}

function readLedgerEvidence(db: Database, row: EvidenceRow): PreparedLedgerEvidence {
  const ref = parseLedgerRef(row.ref_key);
  if (ref === null) return invalidLedger(row.ref_key, null, null);
  const raw = db.query<{ payload_json: string }, [string, number]>(
    `SELECT payload_json FROM raw_ledger WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
  ).get(ref.generation, ref.offset);
  if (raw === null) {
    return {
      kind: 'ledger', refKey: row.ref_key,
      state: row.payload_state === 'expired' ? 'expired' : 'invalid',
      fields: null, tMs: null, generation: ref.generation, offset: ref.offset,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.payload_json);
  } catch {
    return invalidLedger(row.ref_key, ref.generation, ref.offset);
  }
  if (!isRecord(parsed)) return invalidLedger(row.ref_key, ref.generation, ref.offset);
  const fields = mapLedgerRow(parsed);
  if (fields === null) return invalidLedger(row.ref_key, ref.generation, ref.offset);
  return {
    kind: 'ledger', refKey: row.ref_key, state: 'present', fields,
    tMs: fields.tMs, generation: ref.generation, offset: ref.offset,
  };
}

function readRouteEvidence(db: Database, row: EvidenceRow): PreparedRouteEvidence {
  const routeId = Number(row.ref_key);
  if (!Number.isSafeInteger(routeId) || routeId < 0) {
    return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
  }
  const raw = db.query<{ payload_json: string }, [number]>(
    `SELECT payload_json FROM raw_route WHERE route_id=?`,
  ).get(routeId);
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.payload_json);
    } catch {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    if (!isRecord(parsed)) {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    const fields = mapRouteRow(parsed);
    if (fields === null) {
      return { kind: 'route', refKey: row.ref_key, state: 'invalid', fields: null, summaryOnly: false, triesCount: null };
    }
    const summary = db.query<{ tries_json: string | null }, [number]>(
      `SELECT tries_json FROM route_summary WHERE route_id=?`,
    ).get(routeId);
    return {
      kind: 'route', refKey: row.ref_key, state: 'present', fields, summaryOnly: false,
      triesCount: fields.tries === null ? parseTriesCount(summary?.tries_json ?? null) : fields.tries.length,
    };
  }
  const summary = db.query<{ tries_json: string | null }, [number]>(
    `SELECT tries_json FROM route_summary WHERE route_id=?`,
  ).get(routeId);
  if (summary !== null) {
    return {
      kind: 'route', refKey: row.ref_key, state: 'present', fields: null,
      summaryOnly: true, triesCount: parseTriesCount(summary.tries_json),
    };
  }
  return {
    kind: 'route', refKey: row.ref_key,
    state: row.payload_state === 'expired' ? 'expired' : 'invalid',
    fields: null, summaryOnly: false, triesCount: null,
  };
}

function readHookEvidence(db: Database, row: EvidenceRow): PreparedHookEvidence {
  const raw = db.query<{ model: string | null; success: number | null }, [string]>(
    `SELECT model,success FROM raw_hook WHERE hook_id=?`,
  ).get(row.ref_key);
  if (raw === null) return { kind: 'hook', refKey: row.ref_key, state: 'expired', model: null, success: null };
  return {
    kind: 'hook', refKey: row.ref_key, state: 'present',
    model: raw.model, success: raw.success === null ? null : raw.success !== 0,
  };
}

export function collectOwnerEvidenceTx(db: Database, reqId: number): OwnerEvidence {
  const rows = db.query<EvidenceRow, [number]>(
    `SELECT source_kind,ref_key,payload_state FROM request_evidence WHERE req_id=? ORDER BY source_kind,ref_key`,
  ).all(reqId);
  const evidence: PreparedEvidence[] = [];
  const unsupported: string[] = [];
  for (const row of rows) {
    if (row.source_kind === 'ledger') evidence.push(readLedgerEvidence(db, row));
    else if (row.source_kind === 'route') evidence.push(readRouteEvidence(db, row));
    else if (row.source_kind === 'hook') evidence.push(readHookEvidence(db, row));
    else unsupported.push(row.source_kind);
  }
  return { reqId, evidence, unsupported };
}

function isLedger(evidence: PreparedEvidence): evidence is PreparedLedgerEvidence {
  return evidence.kind === 'ledger';
}

function isRoute(evidence: PreparedEvidence): evidence is PreparedRouteEvidence {
  return evidence.kind === 'route';
}

function isHook(evidence: PreparedEvidence): evidence is PreparedHookEvidence {
  return evidence.kind === 'hook';
}

function attemptFingerprint(fields: LedgerFields): string {
  return JSON.stringify([
    fields.tMs, fields.responseIdNorm, fields.handedOn, fields.status, fields.stop,
    fields.inTok, fields.outTok, fields.cacheRead, fields.cacheWrite, fields.reasoning,
    fields.model, fields.served, fields.provider, fields.errType, fields.err,
  ]);
}

function duplicateAttempts(rows: LedgerFields[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = attemptFingerprint(row);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function ledgerStateOf(ledgers: PreparedLedgerEvidence[]): ProjectionState {
  if (ledgers.length === 0) return 'absent';
  if (ledgers.some(row => row.state === 'invalid')) return 'invalid';
  const present = ledgers.filter(row => row.state === 'present' && row.fields !== null);
  if (present.length === 0) return 'expired';
  if (present.length < ledgers.length) return 'partial';
  if (duplicateAttempts(present.map(row => row.fields!))) return 'duplicate';
  return 'complete';
}

function compareLedgerEvidence(left: PreparedLedgerEvidence, right: PreparedLedgerEvidence): number {
  return (left.tMs ?? 0) - (right.tMs ?? 0) ||
    compareBytes(left.generation ?? '', right.generation ?? '') ||
    (left.offset ?? 0) - (right.offset ?? 0);
}

type NumericField = 'inTok' | 'outTok' | 'cacheRead' | 'cacheWrite' | 'reasoning';

function sumField(rows: LedgerFields[], key: NumericField): number | null {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

function attemptOutcome(row: LedgerFields): AttemptOutcome {
  if (row.handedOn !== 0) return 'pending_final';
  if (row.status === null) return 'pending_final';
  return row.status >= 400 ? 'failed' : 'succeeded';
}

// 同毫秒只在同一账本代际内用偏移证明先后；跨代际的同毫秒、route_id、hook UUID 都不证明尝试顺序。
function finalCandidate(ledgers: PreparedLedgerEvidence[]): {
  row: PreparedLedgerEvidence | null;
  unprovable: boolean;
} {
  const rows = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence);
  if (rows.length === 0) return { row: null, unprovable: false };
  const latestMs = rows[rows.length - 1]!.tMs;
  const tied = rows.filter(row => row.tMs === latestMs);
  if (tied.length === 1) return { row: tied[0]!, unprovable: false };
  const generation = tied[0]!.generation;
  if (generation === null || tied.some(row => row.generation !== generation)) {
    return { row: null, unprovable: true };
  }
  // 同一代际内偏移单调，最后偏移就是最后追加；tMs 相同不再提供次序。
  return { row: tied[tied.length - 1]!, unprovable: false };
}

function attemptProjection(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
  count: number | null,
): AttemptProjection {
  const empty: AttemptProjection = {
    state, billed: null, inTok: null, outTok: null, cacheRead: null, cacheWrite: null,
    reasoning: null, count, startMs: null, outcome: null,
  };
  if (state !== 'complete') return empty;
  const fields = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence)
    .map(row => row.fields!);
  if (fields.length === 0) return { ...empty, state: 'absent' };
  const final = finalCandidate(ledgers);
  return {
    state, billed: fields.length,
    inTok: sumField(fields, 'inTok'), outTok: sumField(fields, 'outTok'),
    cacheRead: sumField(fields, 'cacheRead'), cacheWrite: sumField(fields, 'cacheWrite'),
    reasoning: sumField(fields, 'reasoning'),
    count, startMs: Math.min(...fields.map(row => row.tMs)),
    // 合计不依赖顺序，仍可发布；顺序不可证时按 pending_final 处理，不发布最终尝试
    outcome: final.row === null ? 'pending_final' : attemptOutcome(final.row.fields!),
  };
}

function selectedAttempt(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
): { attempt: SelectedAttempt | null; unprovable: boolean } {
  if (state !== 'complete') return { attempt: null, unprovable: false };
  const final = finalCandidate(ledgers);
  if (final.unprovable) return { attempt: null, unprovable: true };
  if (final.row === null || final.row.fields!.handedOn !== 0) return { attempt: null, unprovable: false };
  const fields = final.row.fields!;
  return {
    attempt: { refKey: final.row.refKey, tMs: fields.tMs, outcome: attemptOutcome(fields), fields },
    unprovable: false,
  };
}

function uniqueString(values: (string | null)[]): { value: string | null; conflict: boolean } {
  const set = new Set(values.filter((value): value is string => value !== null));
  return { value: set.size === 1 ? [...set][0]! : null, conflict: set.size > 1 };
}

function identityProjection(
  ledgers: PreparedLedgerEvidence[],
  state: ProjectionState,
  selected: SelectedAttempt | null,
  orderUnprovable: boolean,
): { projection: LedgerIdentityProjection; conflict: boolean } {
  const empty: LedgerIdentityProjection = {
    state, orderState: 'unknown', session: null, nativeSession: null, agent: null, subagent: null,
    parentAgent: null, responseIdNorm: null, startedMs: null, sortKey: null,
  };
  if (state !== 'complete') return { projection: empty, conflict: false };
  const rows = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .sort(compareLedgerEvidence);
  if (rows.length === 0) return { projection: empty, conflict: false };
  const fields = rows.map(row => row.fields!);
  const session = uniqueString(fields.map(row => row.session));
  const agent = uniqueString(fields.map(row => row.agent));
  const subagent = uniqueString(fields.map(row => row.subagent));
  const parentAgent = uniqueString(fields.map(row => row.parentAgent));
  const nativeSession = uniqueString(fields.map(row => row.nativeSession));
  const last = rows[rows.length - 1]!;
  const conflict = session.conflict || agent.conflict || subagent.conflict || parentAgent.conflict || nativeSession.conflict;
  return {
    projection: {
      state: conflict ? 'conflict' : 'complete',
      orderState: orderUnprovable ? 'unprovable' : 'provable',
      session: session.value, nativeSession: nativeSession.value, agent: agent.value,
      subagent: subagent.value, parentAgent: parentAgent.value,
      // session 与 agent 只做集合唯一性判断，和尝试顺序无关；排序键与响应身份依赖最终行，顺序不可证时留空。
      responseIdNorm: orderUnprovable ? null : selected?.fields.responseIdNorm ?? null,
      startedMs: Math.min(...fields.map(row => row.tMs)),
      sortKey: orderUnprovable ? null : `${last.generation ?? ''}|${String(last.offset ?? 0).padStart(20, '0')}`,
    },
    conflict,
  };
}

function promptProjection(routes: PreparedRouteEvidence[]): PromptProjection {
  const empty: PromptProjection = { state: 'absent', tokens: null, counted: null, window: null, turns: null, partsJson: null };
  const present = routes.filter(row => row.state === 'present' && row.fields !== null);
  if (present.length > 0) {
    const latestMs = Math.max(...present.map(row => row.fields!.timeMs));
    const tied = present.filter(row => row.fields!.timeMs === latestMs);
    // 同毫秒的两条 route 无法证明哪条是当前尝试；route_id 只用于遍历，不是先后证据。
    if (tied.length > 1) return { ...empty, state: 'conflict' };
    const fields = tied[0]!.fields!;
    if (fields.shape.prompt === 'reported' && fields.shape.promptCounted !== 'invalid') {
      const counted = fields.promptCounted;
      return {
        state: 'complete', tokens: fields.promptTokens,
        counted: counted === 1 ? 1 : counted === 0 ? 0 : null,
        window: fields.promptWindow, turns: fields.promptTurns,
        partsJson: fields.promptParts === null ? null : JSON.stringify(fields.promptParts),
      };
    }
    // counted 非法与 Prompt 非法同属"读不懂"，缺失才是 absent；两者都不写列，旧值作为历史保留。
    const invalid = fields.shape.prompt === 'invalid' || fields.shape.promptCounted === 'invalid';
    return { ...empty, state: invalid ? 'invalid' : 'absent' };
  }
  if (routes.some(row => row.summaryOnly)) return { ...empty, state: 'partial' };
  if (routes.some(row => row.state === 'invalid')) return { ...empty, state: 'invalid' };
  if (routes.some(row => row.state === 'expired')) return { ...empty, state: 'expired' };
  return empty;
}

function kindProjection(
  ledgers: PreparedLedgerEvidence[],
  routes: PreparedRouteEvidence[],
  unsupported: string[],
): { report: SourceKindProjection; reasons: ProjectionReason[] } {
  const ledgerValues = ledgers
    .filter(row => row.state === 'present' && row.fields !== null)
    .map(row => row.fields!.kind)
    .filter((value): value is string => value !== null);
  const routeValues = routes
    .filter(row => row.state === 'present' && row.fields !== null)
    .map(row => row.fields!.kind)
    .filter((value): value is string => value !== null);
  const ledgerAll = uniqueSorted(ledgerValues);
  const routeAll = uniqueSorted(routeValues);
  const ledger = ledgerAll.slice(0, MAX_KIND_VALUES_PER_SOURCE);
  const route = routeAll.slice(0, MAX_KIND_VALUES_PER_SOURCE);
  const values = uniqueSorted([...ledger, ...route]).slice(0, MAX_KIND_REPORT_VALUES);
  const overflow = ledgerAll.length > MAX_KIND_VALUES_PER_SOURCE || routeAll.length > MAX_KIND_VALUES_PER_SOURCE;
  let state: SourceKindProjection['state'];
  if (ledgerAll.length === 0 && routeAll.length === 0) state = 'absent';
  else if (overflow) state = 'overflow';
  else if (ledgerAll.length > 1 || routeAll.length > 1 ||
    (ledgerAll.length === 1 && routeAll.length === 1 && ledgerAll[0] !== routeAll[0])) state = 'conflict';
  else if (ledgerAll.length === 1 && routeAll.length === 1) state = 'merged';
  else state = 'single';
  const merged = state === 'single' || state === 'merged' ? values[0]! : null;
  const reasons: ProjectionReason[] = [];
  if (ledgers.some(row => row.fields !== null && row.fields.shape.kind === 'empty')) reasons.push('kind_empty');
  if (ledgers.some(row => row.fields !== null && row.fields.shape.kind === 'invalid') ||
      routes.some(row => row.fields !== null && row.fields.shape.kind === 'invalid')) reasons.push('kind_invalid');
  if (overflow) reasons.push('kind_overflow');
  if (state === 'conflict') reasons.push('kind_conflict');
  if (unsupported.length > 0) reasons.push('unsupported_source');
  return { report: { state, values, merged, ledger, route }, reasons };
}

function hookProjection(hooks: PreparedHookEvidence[]): { report: HookProjection; reasons: ProjectionReason[] } {
  const present = hooks.filter(row => row.state === 'present');
  const basisAll = uniqueSorted(hooks.map(row => row.refKey));
  const basis = basisAll.slice(0, MAX_HOOK_BASIS);
  if (present.length === 0) {
    return {
      report: { state: hooks.length === 0 ? 'absent' : 'expired', models: [], successes: [], basis },
      reasons: hooks.length === 0 ? [] : ['hook_expired'],
    };
  }
  const modelsAll = uniqueSorted(present.map(row => row.model).filter((value): value is string => value !== null));
  const successesAll = [...new Set(present.map(row => row.success).filter((value): value is boolean => value !== null))]
    .sort((left, right) => Number(left) - Number(right));
  const conflict = modelsAll.length > MAX_HOOK_VALUES || successesAll.length > 2 ||
    basisAll.length > MAX_HOOK_BASIS || modelsAll.length > 1 || successesAll.length > 1;
  return {
    report: {
      state: conflict ? 'conflict' : 'present',
      models: modelsAll.slice(0, MAX_HOOK_VALUES), successes: successesAll.slice(0, 2), basis,
    },
    reasons: conflict ? ['hook_conflict'] : ['hook_present'],
  };
}

function familyReasons(state: ProjectionState): ProjectionReason[] {
  if (state === 'complete') return ['ledger_present'];
  if (state === 'partial') return ['ledger_partial'];
  if (state === 'expired') return ['ledger_expired'];
  if (state === 'invalid') return ['ledger_invalid'];
  if (state === 'duplicate') return ['attempt_duplicate_suspect'];
  return [];
}

function promptReasons(state: ProjectionState, hasRouteEvidence: boolean): ProjectionReason[] {
  if (state === 'complete') return ['route_present'];
  const reasons: ProjectionReason[] = [];
  if (state === 'partial') reasons.push('route_summary_only');
  if (state === 'expired') reasons.push('route_expired');
  if (state === 'invalid') reasons.push('route_invalid', 'prompt_invalid');
  if (state === 'conflict') reasons.push('prompt_order_unprovable');
  if (state === 'absent') reasons.push(hasRouteEvidence ? 'route_present' : 'route_absent', 'prompt_absent');
  if (hasRouteEvidence) reasons.push('prompt_retained');
  return reasons;
}

function buildProjection(db: Database, reqId: number, version: number): RequestProjection {
  const owner = collectOwnerEvidenceTx(db, reqId);
  const ledgers = owner.evidence.filter(isLedger);
  const routes = owner.evidence.filter(isRoute);
  const hooks = owner.evidence.filter(isHook);
  const ledgerBasis = ledgers.map(row => row.refKey);
  const routeBasis = routes.map(row => row.refKey);
  const hookBasis = hooks.map(row => row.refKey);
  const ledgerState = ledgerStateOf(ledgers);
  const final = selectedAttempt(ledgers, ledgerState);
  const selected = final.attempt;
  const attempts = attemptProjection(
    ledgers, ledgerState,
    routes.map(row => row.triesCount).find((value): value is number => value !== null) ?? null,
  );
  const prompt = promptProjection(routes);
  const kind = kindProjection(ledgers, routes, owner.unsupported);
  const hook = hookProjection(hooks);
  const identity = identityProjection(ledgers, ledgerState, selected, final.unprovable);
  const selectedState: ProjectionState = ledgerState === 'complete'
    ? (final.unprovable ? 'conflict' : selected === null ? 'absent' : 'complete')
    : ledgerState;
  const selectedReasons = familyReasons(ledgerState);
  if (final.unprovable) selectedReasons.push('attempt_order_unprovable');
  else if (selected === null) selectedReasons.push('attempt_final_missing');
  const identityReasons: ProjectionReason[] = identity.conflict
    ? ['identity_conflict']
    : identity.projection.state === 'complete' ? [] : ['identity_partial'];
  const kindFamilyState: ProjectionState =
    kind.report.state === 'conflict' || kind.report.state === 'overflow' ? 'conflict'
      : kind.report.state === 'absent' ? 'absent' : 'complete';
  const hookFamilyState: ProjectionState =
    hook.report.state === 'conflict' ? 'conflict'
      : hook.report.state === 'present' ? 'complete'
        : hook.report.state === 'expired' ? 'expired' : 'absent';
  const families: Record<ProjectionFamily, FamilyProjection> = {
    selected: family(selectedState, familyCurrent(selectedState), version, ledgerBasis, selectedReasons),
    attempts: family(attempts.state, familyCurrent(attempts.state), version, ledgerBasis, familyReasons(attempts.state)),
    prompt: family(
      prompt.state, prompt.state === 'complete', version, routeBasis,
      promptReasons(prompt.state, routes.length > 0),
    ),
    kind: family(kindFamilyState, familyCurrent(kindFamilyState), version, [...ledgerBasis, ...routeBasis], kind.reasons),
    hook: family(hookFamilyState, familyCurrent(hookFamilyState), version, hookBasis, hook.reasons),
    identity: family(identity.projection.state, familyCurrent(identity.projection.state), version, ledgerBasis, identityReasons),
  };
  const state: ProjectionState = final.unprovable
    ? 'conflict'
    : ledgerState !== 'absent'
      ? ledgerState
      : prompt.state !== 'absent' ? prompt.state : hookFamilyState;
  const reasons = [...new Set(Object.values(families).flatMap(row => row.reasons))];
  return {
    reqId, version, state, selected, attempts, prompt,
    kind: kind.report, hook: hook.report, identity: identity.projection, families, reasons,
  };
}

function writeProjectionTx(db: Database, reqId: number, projection: RequestProjection, now: number): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (projection.families.attempts.basis.length > 0) sets.push(`have=have|${HAVE_LEDGER}`);
  if (projection.attempts.state === 'complete') {
    const fields = projection.selected?.fields ?? null;
    sets.push(
      'status=?', 'stop=?', 'model_requested=?', 'model_served=?', 'provider=?', 'response_id_norm=?',
      'in_tok=?', 'out_tok=?', 'cache_read=?', 'cache_write=?', 'reasoning=?',
      'ms=?', 'ttft_ms=?', 'flow_ms=?', 'first_text_ms=?', 'started_ms=?', 'day=?',
      'attempt_billed=?', 'attempt_in=?', 'attempt_out=?', 'attempt_cache_read=?',
      'attempt_cache_write=?', 'attempt_reasoning=?',
      "attempt_state=CASE WHEN ?='pending_final' THEN 'pending_final' WHEN attempt_state='not_applicable' THEN attempt_state ELSE 'known' END",
      'magpie_version=COALESCE(?,magpie_version)',
    );
    params.push(
      fields?.status ?? null, fields?.stop ?? null, fields?.requested ?? null, fields?.served ?? null,
      fields?.provider ?? null, fields?.responseIdNorm ?? null,
      fields?.inTok ?? null, fields?.outTok ?? null, fields?.cacheRead ?? null,
      fields?.cacheWrite ?? null, fields?.reasoning ?? null,
      fields?.ms ?? null, fields?.ttftMs ?? null, fields?.flowMs ?? null, fields?.firstTextMs ?? null,
      projection.identity.startedMs!, localDay(projection.identity.startedMs!),
      projection.attempts.billed!, projection.attempts.inTok, projection.attempts.outTok,
      projection.attempts.cacheRead, projection.attempts.cacheWrite, projection.attempts.reasoning,
      projection.attempts.outcome ?? 'pending_final', fields?.magpieVersion ?? null,
    );
  }
  if (projection.attempts.count !== null) {
    sets.push('attempt_count=COALESCE(?,attempt_count)');
    params.push(projection.attempts.count);
  }
  if (projection.families.prompt.current) {
    sets.push('prompt_tokens=?', 'prompt_counted=?', 'prompt_window=?', 'prompt_turns=?', 'parts_json=?');
    params.push(
      projection.prompt.tokens, projection.prompt.counted,
      projection.prompt.window, projection.prompt.turns, projection.prompt.partsJson,
    );
  }
  if (sets.length === 0) return;
  sets.push('updated_at=?');
  params.push(now, reqId);
  db.run(`UPDATE request SET ${sets.join(',')} WHERE req_id=?`, params);
}

export function projectRequestTx(
  db: Database,
  reqId: number,
  input: { now: number; mappingVersion: number },
): RequestProjection {
  const projection = buildProjection(db, reqId, input.mappingVersion);
  writeProjectionTx(db, reqId, projection, input.now);
  // 事实层与行级事实同一事务：原始行到期删除后，集合与选定尝试仍要读得到。
  // 旧值在写入前读，集合因此只增不减，raw 缺失不会被当成"从没观测过"。
  const old = db.query<{ source_facts_json: string | null; projection_meta_json: string | null }, [number]>(
    'SELECT source_facts_json,projection_meta_json FROM request WHERE req_id=?',
  ).get(reqId);
  const facts = buildSourceFacts(projection, readSourceFacts(old?.source_facts_json ?? null));
  const meta = buildProjectionMeta(projection, readProjectionMeta(old?.projection_meta_json ?? null));
  db.run('UPDATE request SET source_facts_json=?,projection_meta_json=? WHERE req_id=?', [
    serializeFacts(facts), serializeMeta(meta), reqId,
  ]);
  return projection;
}

/**
 * 只读构建：写入前取差异基线用，不写任何列。
 *
 * 调用方拿它与写入后的投影签名比较，只有派生输入真的变了才标脏；
 * 同一 route 的重复摘要刷新不应触发整组重算。
 */
export function readProjectionTx(db: Database, reqId: number, version: number): RequestProjection {
  return buildProjection(db, reqId, version);
}

/**
 * 投影事实的稳定签名，只用于判断"这次写入是否改变了派生输入"。
 *
 * 字段顺序由字面量固定，数组在投影内已排序，所以同一输入必然得到同一串。
 * 它不是持久字段：投影元数据落在 Task 3 的 projection_meta_json。
 */
export function projectionSignature(projection: RequestProjection): string {
  return JSON.stringify({
    state: projection.state,
    selected: projection.selected,
    attempts: projection.attempts,
    prompt: projection.prompt,
    kind: projection.kind,
    hook: projection.hook,
    identity: projection.identity,
    families: projection.families,
    reasons: projection.reasons,
  });
}
