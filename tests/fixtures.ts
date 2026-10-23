import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import type { Store } from '../src/store';
import { persistBody, persistBodyTx } from '../src/body';

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  const store = openStore(join(dir, 'trace.db'));
  return {
    dir,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 用途测试的请求种子。
 *
 * `purpose_*` 在正文写入之后覆盖：`persistBodyTx` 会按输入变化把请求重新标成
 * 待判定，先写正文再设用途才能构造"已结算的旧解释"这类历史行。
 */
export type PurposeSeed = {
  convKey?: string;
  actor?: string | null;
  actorState?: 'known' | 'unknown';
  agent?: string | null;
  protocol?: string;
  bodyState?: 'evicted' | 'available';
  startedMs?: number;
  system?: string | null;
  stop?: string[] | null;
  tools?: unknown[] | null;
  messages?: unknown[];
  reply?: unknown;
  sourceKind?: string | null;
  purposeTarget?: number;
  purposeVersion?: number | null;
  purposeStatus?: string;
  purposeRule?: string | null;
  purposeChain?: 'participate' | 'exclude';
  purposePending?: number;
  purposeSignals?: string[];
  reqKind?: string;
  modelTitle?: string | null;
  title?: string;
  titleSource?: string;
  chainRole?: string;
  summaryState?: string;
  summaryAlgorithm?: number | null;
  cleanGroup?: boolean;
};

export function seedPurposeRequest(store: Store, input: PurposeSeed = {}): number {
  const convKey = input.convKey ?? 'conv-purpose';
  const actor = input.actor === undefined ? 'actor' : input.actor;
  const actorState = input.actorState ?? 'known';
  const protocol = input.protocol ?? 'anthropic';
  const bodyState = input.bodyState ?? 'available';
  const reqId = store.write(db => Number(db.run(`
    INSERT INTO request(conv_key, actor, actor_state, agent, started_ms, day, via,
      body_state, derive_version, have, created_at, updated_at)
    VALUES (?,?,?,?,?,'2026-10-22','hook',?,0,1,1,1)`,
  [convKey, actor, actorState, input.agent === undefined ? 'claude' : input.agent,
    input.startedMs ?? 1, bodyState]).lastInsertRowid));
  if (bodyState === 'available') {
    store.write(db => persistBodyTx(db, reqId, {
      protocol,
      request: {
        ...(input.system === undefined || input.system === null ? {} : { system: input.system }),
        messages: input.messages ?? [],
        ...(input.stop === undefined || input.stop === null ? {} : { stop_sequences: input.stop }),
        ...(input.tools === undefined || input.tools === null ? {} : { tools: input.tools }),
      },
      reply: input.reply ?? { content: [{ type: 'text', text: 'plain reply' }] },
      redact_version: 1,
    }));
  }
  if (input.sourceKind !== undefined && input.sourceKind !== null) {
    store.write(db => db.run('UPDATE request SET source_facts_json=? WHERE req_id=?', [
      JSON.stringify({
        format: 1,
        kinds: {
          ledger: { values: [input.sourceKind], overflow: false, missing: false, invalid: false },
          route: { values: [], overflow: false, missing: true, invalid: false },
          state: 'single',
          value: input.sourceKind,
        },
        hook: { models: { values: [], overflow: false, missing: true, invalid: false }, successes: [] },
        selected: null,
      }),
      reqId,
    ]));
  }
  store.write(db => db.run(`
    UPDATE request SET purpose_target=?, purpose_version=?, purpose_status=?, purpose_rule=?,
      purpose_chain=?, purpose_pending=?, purpose_signals=?, req_kind=?, model_title=?,
      title=?, title_source=?, chain_role=?, summary_state=?, summary_algorithm=?
    WHERE req_id=?`, [
    input.purposeTarget ?? 2,
    input.purposeVersion ?? null,
    input.purposeStatus ?? 'missing',
    input.purposeRule ?? null,
    input.purposeChain ?? 'participate',
    input.purposePending ?? 1,
    JSON.stringify(input.purposeSignals ?? []),
    input.reqKind ?? 'chat',
    input.modelTitle ?? null,
    input.title ?? '',
    input.titleSource ?? null,
    input.chainRole ?? 'main',
    input.summaryState ?? 'legacy',
    input.summaryAlgorithm ?? null,
    reqId,
  ]));
  if (input.cleanGroup === true && actor !== null && actorState === 'known') {
    store.write(db => {
      const existing = db.query<{ group_epoch: string }, [string, string]>(
        'SELECT group_epoch FROM derive_queue WHERE conv_key=? AND actor=?').get(convKey, actor);
      db.run(`
        INSERT INTO derive_queue(conv_key, actor, from_sort, group_epoch, input_revision,
          published_revision, target_algorithm, published_algorithm, state)
        VALUES (?,?,'',?,0,0,1,1,'clean')
        ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean',
          published_revision=input_revision, published_algorithm=target_algorithm`,
      [convKey, actor, existing?.group_epoch ?? 'seed-epoch']);
    });
  }
  return reqId;
}

/**
 * 只建请求行的切片种子：正文与用途都留给调用方按用例自己写。
 *
 * `conv_key` 与 `conv_source` 的形状跟真实摄入一致（会话身份写成 JSON 数组），
 * 这样队列行、请求行与代际拿到的是同一个组键，不会因为种子写了个短名字
 * 而让整组永远匹配不上。
 */
export type RequestSeedRow = {
  req_id: number;
  started_ms: number;
  sort_source: string | null;
  sort_key: string | null;
};

export const SEED_GROUP = { convKey: JSON.stringify(['session', 'chain']), actor: 'a' };

export function seedRequest(
  store: Store,
  rows: readonly RequestSeedRow[],
  group: { convKey: string; actor: string } = SEED_GROUP,
): number[] {
  store.write(db => {
    for (const row of rows) {
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,
        sort_source,sort_key,input_epoch,input_revision,purpose_revision,
        purpose_version,purpose_chain,req_kind)
        VALUES (?,?,'session',?,'known',?,'2026-10-22','hook','pending',0,1,1,1,
        ?,?,'e1',0,0,1,'participate','chat')`,
      [row.req_id, group.convKey, group.actor, row.started_ms, row.sort_source, row.sort_key]);
    }
  });
  return rows.map(row => row.req_id);
}

export type ChainSeed = {
  texts: string[];
  startedMs?: number;
  purposeChain?: 'participate' | 'exclude';
};

/**
 * 一条可比消息链的会话种子。
 *
 * 用途一并冻结（`purpose_pending=0`）：链与角色阶段只消费已经定下来的用途，
 * 而 `seedChain` 的调用方要的正是"这组请求的用途就是这些"，不让用途阶段重判
 * 覆盖掉种下的值。
 */
export function seedChain(
  store: Store,
  sessions: readonly ChainSeed[],
  group: { convKey: string; actor: string } = SEED_GROUP,
): number[] {
  const ids: number[] = [];
  for (const [index, session] of sessions.entries()) {
    const reqId = index + 1;
    seedRequest(store, [{
      req_id: reqId,
      started_ms: session.startedMs ?? 1000 + index,
      sort_source: 'ledger',
      sort_key: `ledger|${String(index).padStart(4, '0')}`,
    }], group);
    persistBody(store, reqId, {
      protocol: 'anthropic',
      request: {
        messages: session.texts.map(text => ({
          role: 'user', content: [{ type: 'text', text }],
        })),
      },
      reply: { id: `msg_${reqId}`, content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
    store.write(db => db.run(
      'UPDATE request SET purpose_chain=?,purpose_pending=0 WHERE req_id=?',
      [session.purposeChain ?? 'participate', reqId]));
    ids.push(reqId);
  }
  return ids;
}
