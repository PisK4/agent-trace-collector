import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { readBodyMetaTx } from './body';
import { markGroupDirtyTx } from './derive-state';
import { parseProtocol } from './protocols';
import { readSourceFacts } from './sources/facts';
import {
  PURPOSE_VERSION,
  classifyPurpose,
  replyTextsOf,
  stopSequencesOf,
  systemTextsOf,
  toolCountOf,
  type PurposeChain,
  type PurposeDecision,
  type PurposeKindState,
  type PurposeParse,
  type PurposeSource,
  type PurposeStatus,
  type PurposeStored,
  type PurposeView,
} from './semantics';

/**
 * 请求用途的单笔读取与结算。
 *
 * 用途是派生阶段最先定下来的事实：组阶段只消费已经写回的结论，查询与页面
 * 也只读这些列。写入用 CAS 绑定 `req_id + input_epoch + input_revision +
 * purpose_target + purpose_pending`——读到视图之后输入又变了，旧结论必须作废，
 * 不能覆盖新一轮待判定的请求。
 */

/** 一笔用途最多尝试的次数；到顶后按 error 终态消费当前修订。 */
export const MAX_PURPOSE_RETRIES = 3;

const PURPOSE_STATUSES = new Set<PurposeStatus>([
  'recognized', 'unrecognized', 'missing', 'retained', 'unsupported', 'error',
]);
const SOURCE_STATES = new Set<PurposeKindState>([
  'single', 'agree', 'conflict', 'missing', 'invalid', 'overflow',
]);

export type PurposeIdentity = {
  reqId: number;
  convKey: string | null;
  actor: string | null;
  actorState: string;
  agent: string | null;
  epoch: string;
  inputRevision: number;
  target: number;
  retry: number;
  stored: PurposeStored;
  source: PurposeSource;
};

export type PurposeTask = PurposeIdentity & { view: PurposeView };

export type PurposeDrainResult = {
  processed: number;
  applied: number;
  stale: number;
  retained: number;
  failed: number;
  remaining: number;
};

export type PurposeApplyResult = { result: 'applied' | 'stale'; terminal: boolean };

export type PurposeScope = { convKey: string };

type PurposeDbRow = {
  req_id: number; conv_key: string | null; actor: string | null; actor_state: string;
  agent: string | null;
  input_epoch: string; input_revision: number; purpose_target: number;
  purpose_retry: number; purpose_version: number | null; purpose_status: string;
  purpose_rule: string | null; purpose_chain: string; purpose_signals: string;
  req_kind: string | null; model_title: string | null; source_facts_json: string | null;
};

function parseSignals(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 来源 kind 只从长期来源事实里取；事实列损坏或缺失不能猜成某个类别。
 *
 * `state` 决定是否可信：只有 single/agree 带着确定值，冲突、缺失、溢出与
 * 非法都交给纯解释模块回落到标题兼容。
 */
function parseSource(raw: string | null): PurposeSource {
  if (raw === null) return { state: 'missing', value: null };
  const facts = readSourceFacts(raw);
  if (facts === null) return { state: 'invalid', value: null };
  const state = facts.kinds.state;
  if (!SOURCE_STATES.has(state)) return { state: 'invalid', value: null };
  const value = typeof facts.kinds.value === 'string' && facts.kinds.value.length > 0
    ? facts.kinds.value : null;
  return { state, value };
}

/** 只读请求行本身；正文与来源事实分别由视图读取补齐。 */
export function readPurposeIdentityTx(db: Database, reqId: number): PurposeIdentity | null {
  const row = db.query<PurposeDbRow, [number]>(`
    SELECT req_id, conv_key, actor, actor_state, agent, input_epoch, input_revision,
      purpose_target, purpose_retry, purpose_version, purpose_status, purpose_rule,
      purpose_chain, purpose_signals, req_kind, model_title, source_facts_json
    FROM request WHERE req_id=?`).get(reqId);
  if (row === null) return null;
  const status = PURPOSE_STATUSES.has(row.purpose_status as PurposeStatus)
    ? row.purpose_status as PurposeStatus : 'missing';
  const chain: PurposeChain = row.purpose_chain === 'exclude' ? 'exclude' : 'participate';
  return {
    reqId: row.req_id,
    convKey: row.conv_key,
    actor: row.actor,
    actorState: row.actor_state === 'known' ? 'known' : 'unknown',
    agent: row.agent,
    epoch: row.input_epoch,
    inputRevision: row.input_revision,
    target: row.purpose_target,
    retry: row.purpose_retry,
    stored: {
      version: row.purpose_version,
      status,
      rule: row.purpose_rule,
      signals: parseSignals(row.purpose_signals),
      chain,
      kind: row.req_kind ?? 'chat',
      modelTitle: row.model_title,
    },
    source: parseSource(row.source_facts_json),
  };
}

/** 正文不可读或协议不支持时的视图：只保留来源与已存解释，不猜内容。 */
function emptyView(identity: PurposeIdentity, parse: PurposeParse, reply: unknown): PurposeView {
  return {
    parse,
    agent: identity.agent,
    systemTexts: [],
    stopSequences: [],
    messageCount: null,
    toolCount: null,
    replyText: reply === null || reply === undefined
      ? null : (replyTextsOf(reply).join('\n') || null),
    source: identity.source,
    stored: identity.stored,
  };
}

/**
 * 用途取数只解骨架与 role=2 的 System/developer 消息块。
 *
 * 顶层 system 已在骨架里；消息级 System（Chat 的 system、developer 与 Anthropic
 * 的 system 消息）按引用解压读取。损坏的 System 块向上抛错，交给用途失败路径，
 * 不静默宣称没有 System——分类器指纹缺失会把分类器请求算进主链。普通
 * User/Assistant 块不解压，取数成本不随正文体积增长。
 */
function purposeSystemTextsTx(db: Database, reqId: number, request: unknown): string[] {
  const rows = db.query<{ z: Uint8Array }, [number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=2 ORDER BY rb.ord`).all(reqId);
  const systemMessages = rows.map(row => {
    try {
      return JSON.parse(zstdDecompressSync(row.z).toString('utf8')) as unknown;
    } catch (error) {
      throw new Error('purpose_system_block_unreadable', { cause: error });
    }
  });
  return [
    ...systemTextsOf(request),
    ...systemTextsOf({ messages: systemMessages }),
  ];
}

/**
 * 一笔请求的用途视图。只解骨架、引用索引与 System 消息块，不解压普通消息块：
 * 分类器需要的 system、stop 与回复都在骨架或 System 块里，正文条数来自 request 行。
 */
export function readPurposeViewTx(db: Database, identity: PurposeIdentity): PurposeView {
  const body = readBodyMetaTx(db, identity.reqId);
  if (body === null) return emptyView(identity, 'missing', null);
  const parsed = parseProtocol(body.protocol, body.request, body.reply);
  const parse: PurposeParse = parsed.parse_state === 'ok' ? 'ok'
    : parsed.parse_state === 'unsupported' ? 'unsupported' : 'invalid';
  if (parse !== 'ok') return emptyView(identity, parse, body.reply);
  return {
    parse,
    agent: identity.agent,
    systemTexts: purposeSystemTextsTx(db, identity.reqId, body.request),
    stopSequences: stopSequencesOf(body.request),
    messageCount: body.messageCount,
    toolCount: toolCountOf(body.request),
    replyText: replyTextsOf(body.reply).join('\n') || null,
    source: identity.source,
    stored: identity.stored,
  };
}

export function readPurposeTaskTx(db: Database, reqId: number): PurposeTask | null {
  const identity = readPurposeIdentityTx(db, reqId);
  if (identity === null) return null;
  return { ...identity, view: readPurposeViewTx(db, identity) };
}

/** 只有已确认归属的组才需要重算；未知归属的用途仍是该请求自己的事实。 */
function markKnownGroup(db: Database, identity: PurposeIdentity): void {
  if (identity.actorState !== 'known'
    || identity.convKey === null || identity.actor === null) return;
  markGroupDirtyTx(db, identity.convKey, identity.actor, '');
}

/**
 * 把一笔判定写回请求行。CAS 不命中说明读到视图之后输入又变了（新正文、
 * 新修订或显式升级），返回 stale 让调用方保留 pending 重来。
 *
 * 用途只影响组派生的链归属与标题列；结论没变时不动队列，避免每轮结算
 * 都把整组标脏。
 */
export function applyPurposeDecisionTx(
  db: Database, identity: PurposeIdentity, decision: PurposeDecision,
): 'applied' | 'stale' {
  const changed = db.run(`
    UPDATE request SET purpose_pending=0, purpose_retry=0,
      purpose_revision=input_revision, purpose_target=?,
      purpose_status=?, purpose_version=?, purpose_rule=?, purpose_signals=?,
      purpose_chain=?, req_kind=?, model_title=?
    WHERE req_id=? AND input_epoch=? AND input_revision=? AND purpose_target=? AND purpose_pending=1`,
  [PURPOSE_VERSION, decision.status, decision.version, decision.rule,
    JSON.stringify(decision.signals), decision.chain, decision.kind, decision.modelTitle,
    identity.reqId, identity.epoch, identity.inputRevision, identity.target]).changes;
  if (changed !== 1) return 'stale';
  if (decision.kind !== identity.stored.kind
    || decision.chain !== identity.stored.chain
    || decision.modelTitle !== identity.stored.modelTitle) {
    markKnownGroup(db, identity);
  }
  return 'applied';
}

/**
 * 记一次用途错误。前两次保留 pending 留待重试；第三次落 error 终态并消费
 * 当前修订——无限重试会让一个永远读不出来的请求把整组卡在 dirty。
 */
export function applyPurposeErrorTx(
  db: Database, identity: PurposeIdentity,
): PurposeApplyResult {
  const retry = Math.min(identity.retry + 1, MAX_PURPOSE_RETRIES);
  const terminal = retry >= MAX_PURPOSE_RETRIES;
  const signals = [...new Set([...identity.stored.signals, 'purpose.error'])];
  const changed = db.run(`
    UPDATE request SET purpose_pending=?, purpose_retry=?, purpose_target=?,
      purpose_status='error', purpose_signals=?
      ${terminal ? ', purpose_revision=input_revision' : ''}
    WHERE req_id=? AND input_epoch=? AND input_revision=? AND purpose_target=? AND purpose_pending=1`,
  [terminal ? 0 : 1, retry, PURPOSE_VERSION, JSON.stringify(signals),
    identity.reqId, identity.epoch, identity.inputRevision, identity.target]).changes;
  return {
    result: changed === 1 ? 'applied' as const : 'stale' as const,
    terminal,
  };
}

/**
 * 结算一批待判定用途。每笔都在自己的 CAS 里完成，一笔失败不影响同批其它
 * 请求；返回 processed/applied/stale/retained/failed 与本作用域剩余量，
 * 让调用方区分"做完"与"这批没进展"。
 */
export function drainRequestPurposesTx(
  db: Database, limit: number, scope?: PurposeScope,
): PurposeDrainResult {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid_purpose_limit');
  if (scope !== undefined
    && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_purpose_scope');
  }
  const ids = scope === undefined
    ? db.query<{ req_id: number }, [number]>(
      'SELECT req_id FROM request WHERE purpose_pending=1 ORDER BY req_id LIMIT ?').all(limit)
    : db.query<{ req_id: number }, [string, number]>(
      'SELECT req_id FROM request WHERE purpose_pending=1 AND conv_key=? ORDER BY req_id LIMIT ?')
      .all(scope.convKey, limit);
  let processed = 0;
  let applied = 0;
  let stale = 0;
  let retained = 0;
  let failed = 0;
  for (const { req_id } of ids) {
    const identity = readPurposeIdentityTx(db, req_id);
    if (identity === null) continue;
    processed += 1;
    let decision: PurposeDecision;
    try {
      decision = classifyPurpose(readPurposeViewTx(db, identity));
    } catch {
      const outcome = applyPurposeErrorTx(db, identity);
      if (outcome.result === 'applied') failed += 1;
      else stale += 1;
      continue;
    }
    const outcome = applyPurposeDecisionTx(db, identity, decision);
    if (outcome === 'stale') {
      stale += 1;
      continue;
    }
    applied += 1;
    if (decision.status === 'retained') retained += 1;
  }
  const remaining = scope === undefined
    ? db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM request WHERE purpose_pending=1').get()!.n
    : db.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM request WHERE purpose_pending=1 AND conv_key=?')
      .get(scope.convKey)!.n;
  return { processed, applied, stale, retained, failed, remaining };
}

/**
 * 显式升级一个会话的用途目标：只动该 `conv_key` 下旧目标值的请求，
 * 保留旧解释列直到重新判定完成，并只标脏已确认归属的组。
 */
export function upgradePurposeTargetTx(db: Database, convKey: string): number {
  if (typeof convKey !== 'string' || convKey.length === 0) {
    throw new Error('invalid_purpose_scope');
  }
  const groups = db.query<{ actor: string }, [string, number]>(`
    SELECT DISTINCT actor FROM request
    WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known' AND purpose_target<?`)
    .all(convKey, PURPOSE_VERSION);
  const changed = db.run(`
    UPDATE request SET purpose_target=?, purpose_pending=1, purpose_retry=0
    WHERE conv_key=? AND purpose_target<?`,
  [PURPOSE_VERSION, convKey, PURPOSE_VERSION]).changes;
  for (const group of groups) markGroupDirtyTx(db, convKey, group.actor, '');
  return changed;
}
