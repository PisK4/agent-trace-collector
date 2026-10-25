import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import type { Store } from '../src/store';
import { persistBody, persistBodyTx } from '../src/body';
import { PURPOSE_VERSION } from '../src/semantics';
import { enqueueDerive, drainDerive } from '../src/derive/sync';

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
    input.purposeTarget ?? PURPOSE_VERSION,
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

// —— 派生同步路径的行为测试辅助：多种子、单轮快照与整组重算 ——

export type TestStore = ReturnType<typeof fixture>['store'];
export const DERIVE_GROUP = 'synthetic-derive';
export const DERIVE_ACTOR = 'actor-synthetic';

export function seedDeriveRound(store: TestStore, ids: readonly [number, number],
  times: readonly [number, number] = [1000, 1000]): void {
  store.write(db => {
    for (const [i, id] of ids.entries()) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,
        started_ms,day,via,body_state,derive_version,have,created_at,
        updated_at,sort_source,sort_key)
        VALUES (?,?,?,'known',?,'2026-10-22','hook','pending',0,1,1,1,'ledger',?)`,
        [id, DERIVE_GROUP, DERIVE_ACTOR, times[i]!, `1:2:3:0|${String(i * 100).padStart(20, '0')}`]);
    }
  });
  const user = { role: 'user', content: [{ type: 'text', text: 'synthetic input' }] };
  const call = { type: 'tool_use', id: 'synthetic_call', name: 'read_file', input: {} };
  persistBody(store, ids[0], { protocol: 'anthropic',
    request: { messages: [user] }, reply: { content: [call] }, redact_version: 1 });
  persistBody(store, ids[1], { protocol: 'anthropic', request: { messages: [user,
    { role: 'assistant', content: [call] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic_call',
      content: 'synthetic output' }] }] }, reply: { content: [] }, redact_version: 1 });
}

export function deriveSnapshot(store: TestStore, ids: readonly [number, number]) {
  const [first, second] = ids;
  const requests = ids.map(id => store.read.query<{
    prev_req_id: number | null; prev_relation: string; delta_ordinals: string | null;
    chain_role: string; req_kind: string; title: string | null;
    title_source: string | null; input_preview: string | null;
    input_preview_kind: string | null; reply_preview: string | null;
  }, [number]>(`SELECT prev_req_id,prev_relation,delta_ordinals,chain_role,
    req_kind,title,title_source,input_preview,input_preview_kind,reply_preview
    FROM request WHERE req_id=?`).get(id)!).map(row => ({ ...row,
      prev_req_id: row.prev_req_id === first ? 'first'
        : row.prev_req_id === second ? 'second' : row.prev_req_id,
    }));
  const tools = store.read.query<{
    req_id: number; ord: number; call_id: string; tool_name: string | null;
    result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
  }, [number, number]>(`SELECT req_id,ord,call_id,tool_name,result_req,
    result_ord,result_path,state FROM tool_call WHERE req_id IN (?,?)
    ORDER BY req_id,ord`).all(first, second).map(row => ({ ...row,
      req_id: row.req_id === first ? 'first' : 'second',
      result_req: row.result_req === first ? 'first'
        : row.result_req === second ? 'second' : row.result_req,
    })).sort((a, b) => String(a.req_id).localeCompare(String(b.req_id)) || a.ord - b.ord);
  return { requests, tools };
}

export function rebuildDeriveGroup(store: TestStore): void {
  enqueueDerive(store, DERIVE_GROUP, DERIVE_ACTOR, '');
  drainDerive(store);
}

export function seedTextChain(store: ReturnType<typeof fixture>['store'], sessions: string[][]): number[] {
  // sessions 是每笔请求的完整消息文本序列；返回 req_id 列表。
  const ids: number[] = [];
  store.write(db => {
    for (const [index, texts] of sessions.entries()) {
      const reqId = index + 1;
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (?,?,?,'actor-a','known',?,'2026-10-20','hook','pending',0,1,1,1,'seed','model_time','ledger',?)`,
        [reqId, JSON.stringify(['session', 'chain']), 'session', 1000 + index, `ledger|${String(index).padStart(4, '0')}`],
      );
      persistBody(store, reqId, {
        protocol: 'anthropic',
        request: { messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })) },
        reply: { id: `msg_${reqId}`, content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
      ids.push(reqId);
    }
  });
  return ids;
}
