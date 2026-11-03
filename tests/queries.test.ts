import { expect, test } from 'bun:test';
import { fixture, SEED_GROUP, seedPurposeRequest } from './fixtures';
import { loadBoundSaltTx, loadConfig } from '../src/config';
import { zstdCompressSync } from 'node:zlib';
import { attemptChainOf, getRoute, routeSummaryReading } from '../src/queries/routes';
import { derivationOf, projectionMetaReading, promptReadingOf, sourceFactsReading } from '../src/queries/readings';
import type { ProjectionMetaReading } from '../src/queries/readings';
import { getRequest, listRequests } from '../src/queries/requests';
import { getStats } from '../src/queries/stats';
import { listSessions, titleBindingOf } from '../src/queries/sessions';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { markGroupDirtyTx } from '../src/derive/state';

function insertRequests(store: ReturnType<typeof fixture>['store'], convKey: string, count: number, sameMs: boolean): void {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,cost_state,ms,ttft_ms,flow_ms)
       VALUES (?,?,?,?,?,?,?,'through','pending',0,3,1,1,?,?,'absent',?,?,?)`,
    );
    for (let i = 0; i < count; i++) {
      insert.run(
        convKey, 'session', 'actor-a', 'claude', 'known',
        sameMs ? 1_700_000_000_000 : 1_700_000_000_000 + i, '2026-10-20', `t-${i}`, 200,
        1000 + i, 100 + i, 900 + i,
      );
    }
  });
}

test('键集分页在大量同毫秒请求下不漏不重', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'synthetic-keyset']);
    insertRequests(f.store, key, 1825, true);
    const seen = new Set<number>();
    let cursor: string | null = null;
    do {
      const page = listRequests(f.store, key, 200, cursor);
      for (const row of page.items) seen.add(row.req_id);
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen.size).toBe(1825);
  } finally {
    f.close();
  }
});

test('会话聚合按最后时间倒序且请求数正确', () => {
  const f = fixture();
  try {
    insertRequests(f.store, JSON.stringify(['session', 'a']), 4, false);
    insertRequests(f.store, JSON.stringify(['session', 'b']), 2, false);
    const page = listSessions(f.store, 50, null);
    expect(page.items.map(row => row.request_count)).toEqual([4, 2]);
    expect(page.items.every(row => row.agents.includes('claude'))).toBe(true);
    // agents 是 magpie 的客户端标签，不能拿 actor（会话 UUID）冒充。
    expect(page.items.some(row => row.agents.includes('actor-a'))).toBe(false);
    expect(page.next_cursor).toBeNull();
  } finally {
    f.close();
  }
});

test('请求列表暴露真实agent与耗时字段', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'fields']);
    insertRequests(f.store, key, 2, false);
    const page = listRequests(f.store, key, 10, null);
    expect(page.items.map(row => ({
      agent: row.agent, ms: row.ms, ttft_ms: row.ttft_ms, flow_ms: row.flow_ms,
    }))).toEqual([
      { agent: 'claude', ms: 1000, ttft_ms: 100, flow_ms: 900 },
      { agent: 'claude', ms: 1001, ttft_ms: 101, flow_ms: 901 },
    ]);
  } finally {
    f.close();
  }
});

test('stats暴露游标、issue与正文状态分布', () => {
  const f = fixture();
  try {
    insertRequests(f.store, JSON.stringify(['session', 's']), 2, false);
    f.store.write(db => {
      db.run("INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at) VALUES ('ledger','r1','ledger_invalid_json',1)");
      db.run("INSERT INTO source_gap(source_kind,source_name,file_generation,from_off,to_off,reason,state,updated_at) VALUES ('ledger','usage.jsonl','g:0',10,20,'disk_paused','unrecoverable',1)");
      db.run('INSERT INTO collector_state(key,value_json) VALUES (?,?)', [
        JSON.stringify(['retention', 'admission']),
        JSON.stringify({ mode: 'metadata_only', reason: 'disk_budget', at_ms: 7 }),
      ]);
    });
    const stats = getStats(f.store);
    expect(stats.requests).toBe(2);
    expect(stats.issues).toEqual([{ source_kind: 'ledger', reason: 'ledger_invalid_json', count: 1 }]);
    expect(stats.gaps.length).toBe(1);
    expect(stats.body_states).toEqual([{ state: 'pending', count: 2 }]);
    // 那条 unrecoverable 缺口不算未了，未了缺口单独计数。
    expect(stats.open_gaps).toBe(0);
    // 准入记录原样读出：界面据此只在降级时出标签。
    expect(stats.admission).toEqual({ mode: 'metadata_only', reason: 'disk_budget', at_ms: 7 });
  } finally {
    f.close();
  }
});

test('请求列表查询计划命中会话时间索引', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'plan']);
    insertRequests(f.store, key, 30, false);
    const plan = f.store.read.query(
      `EXPLAIN QUERY PLAN SELECT req_id, started_ms FROM request
       WHERE conv_key = ? AND (started_ms, req_id) < (?, ?)
       ORDER BY started_ms DESC, req_id DESC LIMIT 100`,
    ).all(key, 1_800_000_000_000, 99999) as { detail: string }[];
    const details = plan.map(row => row.detail).join(' | ');
    expect(details).toContain('i_req_session_time');
    expect(details).not.toContain('TEMP B-TREE');
  } finally {
    f.close();
  }
});

const GROUP_KEY = JSON.stringify(['session', 'synthetic-derived']);

/**
 * 一个已完成的组：两笔请求、正文可读、用途已判。
 * 返回两笔的 req_id，便于之后把组标回 dirty。
 */
function seedSettledGroup(store: ReturnType<typeof fixture>['store']): [number, number] {
  const ids: [number, number] = [1, 2];
  store.write(db => {
    for (const id of ids) {
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
        VALUES (?,?,'session','actor-a','known',?,'2026-10-20','hook','pending',0,1,1,1,'ledger',?)`,
        [id, GROUP_KEY, 1000 + id, `ledger|${String(id).padStart(4, '0')}`]);
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
  enqueueDerive(store, GROUP_KEY, 'actor-a', '');
  drainDerive(store);
  return ids;
}

test('已完成的组在列表与详情里都是current', () => {
  const f = fixture();
  try {
    seedSettledGroup(f.store);
    const page = listRequests(f.store, GROUP_KEY, 10, null);
    expect(page.items.map(row => row.derived_state)).toEqual(['current', 'current']);
    expect(page.items.map(row => row.chain_role)).toEqual(['main', 'main']);
    expect(page.items.map(row => row.input_preview)).toEqual([
      'synthetic input', '工具结果 · read_file',
    ]);
    const detail = getRequest(f.store, 2)!;
    expect(detail.derived_state).toBe('current');
    expect(detail.prev_relation).toBe('confirmed');
    expect(detail.delta_ordinals).toEqual([1, 2]);
    // 工具行挂在发起调用的那一笔上，配对结果指向第二笔；执行段是调用侧读数，
    // 反向索引只有位置事实，两者只差这一列。
    const caller = getRequest(f.store, 1)!;
    expect(caller.tool_calls[0]?.state).toBe('resolved');
    expect(caller.tool_calls[0]?.result_req).toBe(2);
    const { exec_ms: _callExec, ...callFacts } = caller.tool_calls[0]!;
    expect(detail.tool_results).toEqual([{ owner_req: 1, ...callFacts }]);
    // 当前行不需要 historical：当前值已经在顶层。
    expect(detail.historical).toBeNull();
  } finally { f.close(); }
});

test('组dirty时关系与增量不作为当前值返回', () => {
  const f = fixture();
  try {
    const ids = seedSettledGroup(f.store);
    // 输入变了但还没重算：上一次的结论还在库里，却已经不是当前值。
    f.store.write(db => markGroupDirtyTx(db, GROUP_KEY, 'actor-a', ''));
    const page = listRequests(f.store, GROUP_KEY, 10, null);
    for (const row of page.items) {
      expect(row.derived_state).toBe('dirty');
      expect(row.chain_role).toBe('unknown');
      expect(row.input_preview).toBeNull();
      expect(row.input_preview_kind).toBeNull();
    }
    const detail = getRequest(f.store, ids[1])!;
    expect(detail.derived_state).toBe('dirty');
    expect(detail.prev_req_id).toBeNull();
    expect(detail.prev_relation).toBeNull();
    expect(detail.delta_ordinals).toBeNull();
    expect(detail.tool_results).toEqual([]);
    expect(detail.chain_role).toBe('unknown');
    // 工具候选同样是组结果：调用身份保留，结果位置不外露。
    // state 退回 pending——"结果位置未确认"正是组没算完时的实情。
    const caller = getRequest(f.store, ids[0])!;
    expect(caller.tool_calls[0]).toMatchObject({
      call_id: 'synthetic_call', state: 'pending', result_req: null, result_ord: null,
    });
    // 独立事实照常可读：正文状态、耗时与回复摘要都不依赖组完成。
    expect(detail.body_state).toBe('available');
    expect(caller.reply_preview).toBe('工具调用 · read_file');
    // 旧结论只在 historical 下出现，并且标明它不是当前值。
    expect(detail.historical).toMatchObject({
      derived_state: 'dirty', prev_relation: 'confirmed', chain_role: 'main',
      input_preview: '工具结果 · read_file',
    });
  } finally { f.close(); }
});

test('正文保留的组标retained且不冒充当前', () => {
  const f = fixture();
  try {
    const ids = seedSettledGroup(f.store);
    // 回收正文后再排一次：摘要按旧值保留，状态是 retained 而不是 current。
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted',skeleton_z=NULL,msg_count=NULL
       WHERE req_id=?`, [ids[0]]));
    f.store.write(db => markGroupDirtyTx(db, GROUP_KEY, 'actor-a', ''));
    drainDerive(f.store);
    const row = listRequests(f.store, GROUP_KEY, 10, null).items[0]!;
    expect(row.derived_state).toBe('retained');
    expect(row.chain_role).toBe('unknown');
    expect(row.input_preview).toBeNull();
    const detail = getRequest(f.store, ids[0])!;
    expect(detail.summary_state).toBe('retained');
    expect(detail.historical?.derived_state).toBe('retained');
  } finally { f.close(); }
});

test('未归属请求的组关系为unknown但用途与输入可读', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (7,'k',NULL,'unknown',1000,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    persistBody(f.store, 7, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] },
      reply: { content: [{ type: 'text', text: 'ok' }] }, redact_version: 1,
    });
    drainDerive(f.store);
    const detail = getRequest(f.store, 7)!;
    // 没有组可加入，就没有可确认的关系；但它自己的用途已经判完了。
    expect(detail.derived_state).toBe('dirty');
    expect(detail.chain_role).toBe('unknown');
    expect(detail.req_kind).toBe('chat');
    expect(detail.historical).not.toBeNull();
  } finally { f.close(); }
});

test('会话标题只取排除用途的模型标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'exclude',
      reqKind: 'title', modelTitle: '正式标题', title: 'x',
      titleSource: 'model_title', purposeStatus: 'recognized', purposeVersion: 2,
      startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'participate',
      reqKind: 'source:compaction', title: '噪声标题',
      titleSource: 'user_delta', startedMs: 2, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'title-priority', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: '用户首句', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 3, cleanGroup: true,
    });
    expect(listSessions(f.store, 10).items[0]?.title).toBe('正式标题');
  } finally { f.close(); }
});

test('参与链的未知来源类别也能提供用户标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'neutral-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'source:compaction', title: '来源标题',
      titleSource: 'user_delta', startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'neutral-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: '用户首句', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 2, cleanGroup: true,
    });
    // 不再按 req_kind='chat' 硬编码：更早的参与链用户标题优先，来源类别原样保留。
    expect(listSessions(f.store, 10).items[0]?.title).toBe('来源标题');
  } finally { f.close(); }
});

test('组未 current 或用途未结算时都不返回旧标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'pending-title', purposePending: 1, purposeChain: 'participate',
      reqKind: 'chat', title: '待结算旧标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'dirty-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: 'dirty旧标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 2,
    });
    f.store.write(db => db.run(`
      UPDATE derive_queue SET input_revision=2, published_revision=1,
        target_algorithm=2, published_algorithm=2, state='dirty'
      WHERE conv_key='dirty-title'`));
    const titles = listSessions(f.store, 10).items.map(item => item.title);
    expect(titles).not.toContain('待结算旧标题');
    expect(titles).not.toContain('dirty旧标题');
  } finally { f.close(); }
});

test('未知用途与链角色原样返回', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'raw-kind', purposePending: 0, purposeChain: 'exclude',
      reqKind: 'auto-mode-classifier', chainRole: 'aux',
      purposeStatus: 'recognized', purposeVersion: 2,
      purposeRule: 'claude.auto-mode-classifier.v1',
      purposeSignals: ['classifier.agent.claude'],
      summaryState: 'recomputed', summaryAlgorithm: 1,
      cleanGroup: true,
    });
    expect(getRequest(f.store, id)).toMatchObject({
      req_kind: 'auto-mode-classifier', chain_role: 'aux',
      purpose_status: 'recognized', purpose_version: 2,
      purpose_rule: 'claude.auto-mode-classifier.v1', purpose_chain: 'exclude',
    });
    const unknown = seedPurposeRequest(f.store, {
      convKey: 'raw-kind-2', purposePending: 0, purposeChain: 'participate',
      reqKind: 'future-kind', chainRole: 'mystery',
      summaryState: 'recomputed', summaryAlgorithm: 1, cleanGroup: true,
    });
    expect(getRequest(f.store, unknown)).toMatchObject({
      req_kind: 'future-kind', chain_role: 'mystery',
    });
  } finally { f.close(); }
});

const routeColumns = {
  route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
  status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
  order_json: null, tries_json: null, affinity_json: null,
};

test('format 2 读取 kind、folder、effort、prompt 与 error', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: 'chat', folder: '/tmp/project', effort: 'high',
    prompt: { tokens: 100, counted: true, window: 1000, held: false, turns: 4, parts: [{ kind: 'chat', tokens: 60 }] },
    error: 'synthetic error', order: [], tries: [], affinity: null, saved_at: 1,
  }, routeColumns);
  expect(reading.format).toBe(2);
  expect(reading.kind).toBe('chat');
  expect(reading.folder).toBe('/tmp/project');
  expect(reading.effort).toBe('high');
  expect(reading.prompt).toEqual({
    tokens: 100, counted: true, window: 1000, held: false, turns: 4, parts: [{ kind: 'chat', tokens: 60 }],
  });
  expect(reading.error).toBe('synthetic error');
});

test('prompt parts 白名单携带 item 标量，非法项剔除、未知键不透出', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: null, folder: null, effort: null,
    prompt: {
      tokens: 900, counted: false, window: 1000, held: null, turns: null,
      parts: [
        {
          kind: 'files', tokens: 400,
          items: [
            { name: 'src/http.ts', tag: 'read', n: 1, tokens: 300, content: '正文不进白名单' },
            { name: 'fixture.json', tag: 'shell', n: 3, tokens: 100 },
            { name: 'bad-item', tag: 'read', tokens: null },
            { tokens: 50 },
            'not-a-record',
          ],
        },
        { kind: 'chat', tokens: 500, items: [{ name: '1', tag: 'turn', tokens: 500 }] },
        { kind: 'bogus', tokens: null },
      ],
    },
    error: null, order: [], tries: [], affinity: null, saved_at: 1,
  }, routeColumns);
  expect(reading.prompt?.parts).toEqual([
    {
      kind: 'files', tokens: 400,
      items: [
        { name: 'src/http.ts', tag: 'read', n: 1, tokens: 300 },
        { name: 'fixture.json', tag: 'shell', n: 3, tokens: 100 },
      ],
    },
    { kind: 'chat', tokens: 500, items: [{ name: '1', tag: 'turn', n: null, tokens: 500 }] },
  ]);
  const text = JSON.stringify(reading.prompt);
  expect(text).not.toContain('正文不进白名单');
  expect(text).not.toContain('bad-item');
  expect(text).not.toContain('bogus');
});

test('安全挑选去掉 account、host、who 与 id', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: 'chat', folder: null, effort: null, prompt: null, error: null,
    order: [
      { provider: 'p', name: 'n', model: 'm', who: 'secret-account', id: 'secret-id', host: 'secret-host' },
      { provider: 'p2', name: { host: 'secret-host' }, model: 'm2', plan: { account: 'secret-account' } },
    ],
    tries: [{ model: 'm', status: 500, fail: 'synthetic_new_gate', who: 'secret-account' }],
    affinity: { mode: 'session', why: 'kept', turn: { account: 'secret-account' }, last: 'secret-account', host: 'secret-host' },
    saved_at: 1,
  }, routeColumns);
  const text = JSON.stringify(reading);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-id');
  expect(reading.order).toEqual([
    { provider: 'p', name: 'n', model: 'm' },
    { provider: 'p2', model: 'm2' },
  ]);
  expect(reading.attempts.items[0]?.fail).toBe('synthetic_new_gate');
  expect(reading.affinity).toEqual({ mode: 'session', why: 'kept' });
});

test('affinity 按真实 camelCase 键挑选且不透出身份键', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: 'chat', folder: null, effort: null, prompt: null, error: null,
    order: [], tries: [],
    affinity: {
      mode: '', why: 'turn', turn: 2, at: '2026-10-21T00:16:24.666553+08:00',
      lastTurn: 3, last: 'synthetic-account', kept: true,
      cacheRead: 9024, within: true, cacheWrite: 175,
      // 旧蛇形键名从未在真实 affinity 里出现，不能当后备读取。
      cache_read: 1, cache_write: 2,
    },
    saved_at: 1,
  }, routeColumns);
  expect(reading.affinity).toEqual({
    mode: '', why: 'turn', turn: 2, at: '2026-10-21T00:16:24.666553+08:00',
    lastTurn: 3, kept: true, cacheRead: 9024, within: true, cacheWrite: 175,
  });
  expect(JSON.stringify(reading)).not.toContain('synthetic-account');
});

test('旧 format 1 不补 kind、folder、effort 与 prompt', () => {
  const reading = routeSummaryReading({ route_id: 100, order: [], tries: [] }, routeColumns);
  expect(reading.format).toBe(1);
  expect(reading.kind).toBeNull();
  expect(reading.folder).toBeNull();
  expect(reading.effort).toBeNull();
  expect(reading.prompt).toBeNull();
});

test('getRoute 从 z 读取并保留列回退', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,route_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (1,100,1,'2026-10-22','through','pending',0,1,1,1)`);
      const z = zstdCompressSync(Buffer.from(JSON.stringify({
        format: 2, route_id: 100, time_ms: 1, model: 'm', served: 's', provider: 'p',
        status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3, kind: 'chat',
        folder: null, effort: null, prompt: null, error: null, order: [], tries: [], affinity: null, saved_at: 1,
      })));
      db.run(`INSERT INTO route_summary(route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,z)
        VALUES (100,1,'m','s','p',200,10,2,8,3,?)`, [z]);
    });
    const route = getRoute(f.store, 1);
    expect(route.state).toBe('available');
    expect((route.summary as { format: number }).format).toBe(2);
    expect((route.summary as { kind: string }).kind).toBe('chat');
  } finally {
    f.close();
  }
});

test('尝试链保留未知 fail 码与已记录时间', () => {
  const chain = attemptChainOf([
    { model: 'm1', provider: 'p1', status: 500, fail: 'synthetic_new_gate', start: '2026-10-22T00:00:00Z', ms: 100 },
    { model: 'm2', provider: 'p2', status: 200, start: '2026-10-22T00:00:01Z', ms: 200 },
  ]);
  expect(chain.state).toBe('present');
  expect(chain.items.map(item => item.fail)).toEqual(['synthetic_new_gate', null]);
  expect(chain.timing.state).toBe('recorded');
});

test('缺时间证据时不补造重试间隔', () => {
  const chain = attemptChainOf([
    { model: 'm1', status: 500, fail: 'rate_limit' },
    { model: 'm2', status: 200 },
  ]);
  expect(chain.items.map(item => item.start_ms)).toEqual([null, null]);
  expect(chain.timing.state).toBe('partial');
  const text = JSON.stringify(chain);
  expect(text).not.toContain('again_ms');
  expect(text).not.toContain('interval');
});

test('空尝试与非法输入分开', () => {
  expect(attemptChainOf([]).state).toBe('empty');
  expect(attemptChainOf(null).state).toBe('unavailable');
  expect(attemptChainOf('oops').state).toBe('unavailable');
  expect(attemptChainOf([null]).state).toBe('unavailable');
  expect(attemptChainOf([null]).timing.state).toBe('absent');
});

test('尝试项只保留白名单字段', () => {
  const chain = attemptChainOf([{
    id: 'secret-id', model: 'm', provider: 'p', status: 500, fail: 'x',
    who: 'secret-account', account: 'secret-account', host: 'secret-host', rest: { who: 'secret-account' },
  }]);
  const text = JSON.stringify(chain);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-id');
});

test('尝试链按真实键读取并丢掉读不到的键', () => {
  const chain = attemptChainOf([{
    status: 200, start: '2026-10-21T00:16:19.764961+08:00', ms: 3176, model: 'step-5-preview',
    id: 'synthetic-account', done: true, served: 'step-5-preview', effort: 'high',
    ttft: 1555, flow: 670, firstReasoning: 1555, tierServed: 'default', fixed: 'high',
    firstText: 2603, reasoningHidden: true, fail: null, error: null,
    queued: 188, again: 1000,
    net: { own: 8.5, reused: true, wait: 1313.6, head: 5702.7 },
    rest: { why: 'other', key: 'synthetic-account' },
    provider: 'synthetic-provider', replan: 1, gone: true, earlier: true,
  }]);
  expect(chain.items[0]).toMatchObject({
    status: 200, ms: 3176, model: 'step-5-preview', done: true,
    served: 'step-5-preview', effort: 'high', ttft_ms: 1555, flow_ms: 670,
    first_reasoning_ms: 1555, tier_served: 'default', first_text_ms: 2603,
    reasoning_hidden: true, fail: null, error: null,
  });
  expect(chain.items[0]?.start_ms).not.toBeNull();
  // 排队量本地网关从不上报，渲染与读模型都不再保留它。
  expect(chain.items[0]).not.toHaveProperty('queued_ms');
  expect(chain.items[0]).not.toHaveProperty('provider');
  expect(chain.items[0]).not.toHaveProperty('replan');
  expect(chain.items[0]).not.toHaveProperty('gone');
  expect(chain.items[0]).not.toHaveProperty('earlier');
  const text = JSON.stringify(chain);
  expect(text).not.toContain('synthetic-account');
  expect(text).not.toContain('synthetic-provider');
  expect(text).not.toContain('"net"');
  expect(text).not.toContain('"rest"');
});

test('source_facts 只挑白名单字段，hook 用有界值与成功分类', () => {
  const reading = sourceFactsReading({
    selected: {
      ref: 'ledger:1', state: 'selected', modelProvider: 'p', served: 's', effort: 'high',
      tier: 'pro', error: 'boom', errorType: 'rate_limit',
      account: 'secret-account', host: 'secret-host', raw: { any: 'secret-raw' },
    },
    hook: {
      models: { values: ['m1', 'm2'], overflow: true, missing: false, invalid: false },
      successes: [true, true, false],
      account: 'secret-account',
    },
    projection_meta: { families: { prompt: { state: 'retained', reason: 'expired_input' } } },
    account: 'secret-account',
  });
  expect(reading.selected?.state).toBe('selected');
  expect(reading.selected?.tier).toBe('pro');
  expect(reading.selected?.errorType).toBe('rate_limit');
  expect(reading.hook?.models).toEqual({ values: ['m1', 'm2'], overflow: true, missing: false, invalid: false });
  expect(reading.hook?.successes).toEqual(['success', 'failure']);
  const text = JSON.stringify(reading);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-raw');
  expect(text).not.toContain('projection_meta');
});

test('非法 source_facts 降级为缺失而不是猜测', () => {
  const reading = sourceFactsReading('not-an-object');
  expect(reading.selected).toBeNull();
  expect(reading.hook).toBeNull();
});

test('projection_meta 只读 prompt family，state 三态与 reason 分开', () => {
  const fresh = projectionMetaReading({
    families: { prompt: { actualVersion: 3, state: 'recomputed', reason: 'complete', basis: ['req:1'] } },
  });
  expect(fresh.prompt.state).toBe('recomputed');
  expect(fresh.prompt.reason).toBe('complete');
  expect(fresh.prompt.basis).toEqual(['req:1']);
  const retained = projectionMetaReading({
    families: { prompt: { actualVersion: 2, state: 'retained', reason: 'invalid_input', basis: [1, 'req:2'] } },
  });
  expect(retained.prompt.state).toBe('retained');
  expect(retained.prompt.reason).toBe('invalid_input');
  expect(retained.prompt.basis).toEqual(['req:2']);
  const missing = projectionMetaReading({});
  expect(missing.prompt.state).toBe('missing');
  expect(missing.prompt.reason).toBe('legacy_unknown');
});

test('组状态从 C 的 derived_state 与 summary_state 映射', () => {
  expect(derivationOf({ derived_state: 'current', summary_state: 'recomputed' }))
    .toEqual({ state: 'clean', chain_state: 'current', summary_state: 'current', reason: null });
  expect(derivationOf({ derived_state: 'current', summary_state: 'retained' }))
    .toEqual({ state: 'clean', chain_state: 'current', summary_state: 'retained', reason: null });
  expect(derivationOf({ derived_state: 'dirty', summary_state: 'recomputed' }))
    .toEqual({ state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' });
  expect(derivationOf({ derived_state: 'retained', summary_state: 'retained' }))
    .toEqual({ state: 'retained', chain_state: 'retained', summary_state: 'retained', reason: 'derived_retained' });
  expect(derivationOf({ derived_state: 'legacy', summary_state: 'legacy' }))
    .toEqual({ state: 'legacy', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_legacy' });
  expect(derivationOf({ derived_state: 'synthetic_state', summary_state: null }))
    .toEqual({ state: 'unknown', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_state_unknown' });
});

test('详情在同一个快照里带出安全来源事实与派生状态', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'detail-facts', agent: 'claude', purposePending: 0, purposeChain: 'participate',
      summaryState: 'recomputed', summaryAlgorithm: 1, cleanGroup: true,
    });
    f.store.write(db => db.run(
      `UPDATE request SET model_provider='provider-x',
        source_facts_json='{"selected":{"state":"selected","modelProvider":"p","tier":"pro"},"hook":{"models":{"values":["m1"],"overflow":false,"missing":false,"invalid":false},"successes":[true]}}',
        projection_meta_json='{"families":{"prompt":{"actualVersion":2,"state":"recomputed","reason":"complete","basis":["req:1"]}}}'
       WHERE req_id=?`, [id],
    ));
    const detail = getRequest(f.store, id)!;
    expect(detail.model_provider).toBe('provider-x');
    expect(detail.source_facts.selected?.state).toBe('selected');
    expect(detail.source_facts.selected?.tier).toBe('pro');
    expect(detail.source_facts.hook?.successes).toEqual(['success']);
    expect(detail.projection_meta.prompt).toEqual({
      actualVersion: 2, state: 'recomputed', reason: 'complete', basis: ['req:1'],
    });
    expect(detail.derivation).toEqual({
      state: 'clean', chain_state: 'current', summary_state: 'current', reason: null,
    });
    expect(detail.derived_state).toBe('current');
  } finally {
    f.close();
  }
});

const prompt = { tokens: 500, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 300 }] };
const freshPrompt: ProjectionMetaReading['prompt'] = { actualVersion: 3, state: 'recomputed', reason: 'complete', basis: ['req:1'] };
const retainedPrompt: ProjectionMetaReading['prompt'] = { actualVersion: 2, state: 'retained', reason: 'expired_input', basis: [] };
const invalidPrompt: ProjectionMetaReading['prompt'] = { actualVersion: 2, state: 'retained', reason: 'invalid_input', basis: [] };
const missingPrompt: ProjectionMetaReading['prompt'] = { actualVersion: null, state: 'missing', reason: 'legacy_unknown', basis: [] };

test('只有 recomputed 才计算占用比例', () => {
  const fresh = promptReadingOf(prompt, freshPrompt, null, null);
  expect(fresh.state).toBe('recomputed');
  expect(fresh.ratio).toBe(0.5);
  const retained = promptReadingOf(prompt, retainedPrompt, null, null);
  expect(retained.state).toBe('retained');
  expect(retained.tokens).toBe(500);
  expect(retained.ratio).toBeNull();
  expect(retained.note).toContain('旧结果');
});

test('缺分母、invalid_input 与 missing 都不显示比例', () => {
  expect(promptReadingOf({ ...prompt, window: null }, freshPrompt, null, null).ratio).toBeNull();
  const invalid = promptReadingOf(prompt, invalidPrompt, null, null);
  expect(invalid.state).toBe('retained');
  expect(invalid.reason).toBe('invalid_input');
  expect(invalid.ratio).toBeNull();
  expect(invalid.note).toContain('无法复核');
  expect(promptReadingOf(null, missingPrompt, [{ kind: 'chat', tokens: 10 }], 10).ratio).toBeNull();
  expect(promptReadingOf(null, missingPrompt, [{ kind: 'chat', tokens: 10 }], null).tokens).toBeNull();
  expect(promptReadingOf(null, missingPrompt, null, null).state).toBe('missing');
});

test('未知 req_kind 与 chain_role 原样返回，不折叠成 chat 或 main', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'unknown-kind']);
    f.store.write(db => {
      db.run(`
        INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,req_kind,chain_role)
        VALUES (1,?,'session','actor-a','claude','known',1000,'2026-10-22','through','available',1,7,1,1,'t','user_delta','synthetic_probe','synthetic_role')`,
      [key]);
      // 让这一笔成为当前结果：用途已结算、组干净、摘要按当前算法算过。
      db.run(`UPDATE request SET purpose_pending=0, summary_state='recomputed', summary_algorithm=3 WHERE req_id=1`);
      db.run(`
        INSERT INTO derive_queue(conv_key,actor,from_sort,input_revision,published_revision,target_algorithm,published_algorithm,state)
        VALUES (?,'actor-a','',1,1,3,3,'clean')`, [key]);
    });
    const detail = getRequest(f.store, 1);
    expect(detail?.derived_state).toBe('current');
    expect(detail?.req_kind).toBe('synthetic_probe');
    expect(detail?.chain_role).toBe('synthetic_role');
  } finally {
    f.close();
  }
});

test('会话 flags 按确定状态聚合且顺序固定', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'flags']);
    f.store.write(db => {
      const insert = db.prepare(`INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,status,prev_relation)
        VALUES (?,?,'session','actor-a','claude',?,?,'2026-10-22','through',?,1,?,1,1,'t','user_delta',?,?)`);
      insert.run(1, key, 'known', 1000, 'available', 7, 500, 'confirmed');
      insert.run(2, key, 'unknown', 2000, 'pending', 0, 200, 'unknown');
      insert.run(3, key, 'known', 3000, 'available', 7, 200, 'confirmed');
    });
    const session = listSessions(f.store, 10, null).items.find(row => row.conv_key === key);
    expect(session?.flags).toEqual(['failed', 'unknown', 'missing_body']);
  } finally {
    f.close();
  }
});

test('全员 exclude 的会话标 bypass，混入一笔参与链就不标', () => {
  const f = fixture();
  try {
    const bypassKey = JSON.stringify(['session', 'bypass-only']);
    const mixedKey = JSON.stringify(['session', 'bypass-mixed']);
    f.store.write(db => {
      const insert = db.prepare(`INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,purpose_chain)
        VALUES (?,?,'session','actor-a','omp','known',?,'2026-10-25','through','available',1,7,1,1,?)`);
      insert.run(11, bypassKey, 1000, 'exclude');
      insert.run(12, bypassKey, 2000, 'exclude');
      insert.run(13, mixedKey, 3000, 'exclude');
      insert.run(14, mixedKey, 4000, 'participate');
    });
    const items = listSessions(f.store, 10, null).items;
    expect(items.find(row => row.conv_key === bypassKey)?.flags).toEqual(['bypass']);
    expect(items.find(row => row.conv_key === mixedKey)?.flags).toEqual([]);
  } finally {
    f.close();
  }
});

test('无正文、零用量、无归属的探针组标 probe，任一条件不满足都不标', () => {
  const f = fixture();
  try {
    const probeKey = JSON.stringify(['request', 'probe-only']);
    const usageKey = JSON.stringify(['request', 'probe-usage']);
    const costKey = JSON.stringify(['request', 'probe-cost']);
    const bodyKey = JSON.stringify(['request', 'probe-body']);
    const actorKey = JSON.stringify(['request', 'probe-actor']);
    const mixedKey = JSON.stringify(['request', 'probe-mixed']);
    const visionKey = JSON.stringify(['request', 'vision-only']);
    f.store.write(db => {
      const insert = db.prepare(`INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,req_kind,in_tok,out_tok,cost)
        VALUES (?,?,'request',?,'magpie','known',?,'2026-11-01','through',?,1,?,1,1,?,?,?,?)`);
      insert.run(21, probeKey, null, 1000, 'pending', 2, 'source:model_list', 0, 0, null);
      insert.run(22, usageKey, null, 2000, 'pending', 2, 'source:provider_test', 5, 0, null);
      insert.run(23, costKey, null, 3000, 'pending', 2, 'source:model_list', 0, 0, 0.0001);
      insert.run(24, bodyKey, null, 4000, 'available', 7, 'source:api_detect', 0, 0, null);
      insert.run(25, actorKey, 'actor-b', 5000, 'pending', 2, 'source:model_list', 0, 0, null);
      insert.run(26, mixedKey, null, 6000, 'pending', 2, 'source:model_list', 0, 0, null);
      insert.run(27, mixedKey, null, 7000, 'pending', 2, 'chat', 0, 0, null);
      insert.run(28, visionKey, null, 8000, 'pending', 2, 'source:vision', 0, 0, null);
    });
    const items = listSessions(f.store, 10, null).items;
    const flags = (key: string) => items.find(row => row.conv_key === key)?.flags;
    expect(flags(probeKey)).toEqual(['missing_body', 'probe']);
    expect(flags(usageKey)).toEqual(['missing_body']);
    expect(flags(costKey)).toEqual(['missing_body']);
    expect(flags(bodyKey)).toEqual([]);
    expect(flags(actorKey)).toEqual(['missing_body']);
    expect(flags(mixedKey)).toEqual(['missing_body']);
    expect(flags(visionKey)).toEqual(['missing_body']);
  } finally {
    f.close();
  }
});

test('无会话归属的 WebSearch 检索组标 tool_event，混入有归属或其它 kind 都不标', () => {
  const f = fixture();
  try {
    const reqKey = JSON.stringify(['request', 'websearch-req']);
    const convKey = JSON.stringify(['conv', 'magpie-websearch']);
    const ownedKey = JSON.stringify(['request', 'websearch-owned']);
    const chatKey = JSON.stringify(['request', 'websearch-chat']);
    f.store.write(db => {
      const insert = db.prepare(`INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,req_kind,cost)
        VALUES (?,?,?,'actor-x','claude','known',?,'2026-11-03','through','pending',1,2,1,1,?,?)`);
      insert.run(31, reqKey, 'request', 1000, 'source:web_search', null);
      insert.run(32, convKey, 'conv', 2000, 'source:web_search', 0.0628);
      insert.run(33, ownedKey, 'request', 3000, 'source:web_search', null);
      insert.run(34, chatKey, 'request', 4000, 'source:chat', 0.01);
      db.run(`UPDATE request SET session='synthetic-owned' WHERE req_id=33`);
    });
    const items = listSessions(f.store, 10, null).items;
    const flags = (key: string) => items.find(row => row.conv_key === key)?.flags;
    expect(flags(reqKey)).toEqual(['missing_body', 'tool_event']);
    expect(flags(convKey)).toEqual(['missing_body', 'tool_event']);
    expect(items.find(row => row.conv_key === convKey)?.cost_usd).toBeCloseTo(0.0628);
    expect(flags(ownedKey)).toEqual(['missing_body']);
    expect(flags(chatKey)).toEqual(['missing_body']);
  } finally {
    f.close();
  }
});

/** Task 1 红测种子：发布代结果与同步旧列刻意不同值，锁住整套选源。 */
function seedPublishedReading(f: ReturnType<typeof fixture>) {
  const id = seedPurposeRequest(f.store, {
    convKey:'conv-reading', actor:'actor-reading', startedMs:100,
    messages:[{role:'user', content:'synthetic question'}],
    purposePending:0, cleanGroup:true, summaryState:'recomputed', summaryAlgorithm:1,
    title:'synchronous bait', titleSource:'user_delta',
  });
  const generation = 'gen-reader-published-01';
  f.store.write(db => {
    db.run(`UPDATE request SET purpose_revision=input_revision WHERE req_id=?`, [id]);
    db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,
      input_revision,algorithm,state,stage,created_at,published_at,request_count)
      SELECT ?,conv_key,actor,group_epoch,input_revision,5,'published','done',1,1,1
      FROM derive_queue WHERE conv_key='conv-reading' AND actor='actor-reading'`,
      [generation]);
    db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,
      input_revision,started_ms,prev_relation,delta_ordinals,chain_role,title,
      title_source,input_preview,purpose_revision,purpose_version,purpose_chain,
      algorithm,retention_state,basis_json)
      SELECT ?,req_id,input_epoch,input_revision,started_ms,'first','[1]','main',
      'published title','user_delta','published input',purpose_revision,
      purpose_version,purpose_chain,5,'recomputed','{"why":"synthetic"}' FROM request WHERE req_id=?`,
      [generation, id]);
    db.run(`UPDATE derive_queue SET published_generation=?,state='clean',
      published_revision=input_revision,target_algorithm=5,published_algorithm=5
      WHERE conv_key='conv-reading' AND actor='actor-reading'`, [generation]);
    db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,
      tool_name,result_req,result_ord,result_path,state,algorithm_version,
      retention_state) VALUES (?,?,0,'call-reading','read',?,4,
      'request.messages[4].content[1]','resolved',5,'recomputed')`,
      [generation, id, id]);
    db.run(`INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,
      result_ord,result_path,state) VALUES (?,0,'call-reading','read',?,0,
      'request.messages[0].content[0]','resolved')`, [id, id]);
  });
  return {id, generation};
}

test('发布代存在时整套读取发布结果，标题列表详情工具同源', () => {
  const f = fixture();
  try {
    const {id} = seedPublishedReading(f);
    const detail = getRequest(f.store, id)!;
    expect(detail.title).toBe('published title');
    expect(detail.input_preview).toBe('published input');
    expect(detail.delta_ordinals).toEqual([1]);
    expect(detail.summary_state).toBe('recomputed');
    expect(detail.summary_basis).toBe('{"why":"synthetic"}');
    expect(detail.tool_calls[0]?.result_path).toBe('request.messages[4].content[1]');
    const { exec_ms: _publishedExec, ...publishedCallFacts } = detail.tool_calls[0]!;
    expect(detail.tool_results).toEqual([{ owner_req: id, ...publishedCallFacts }]);
    expect(listRequests(f.store, 'conv-reading').items[0]?.title).toBe('published title');
    expect(listSessions(f.store).items.find(s => s.conv_key === 'conv-reading')?.title)
      .toBe('published title');
    // 发布代行缺失时不再回退同步诱饵值：NULL 保持 NULL。
    f.store.write(db => db.run(
      'UPDATE derive_request_result SET input_preview=NULL WHERE req_id=?', [id],
    ));
    expect(getRequest(f.store, id)?.input_preview).toBeNull();
  } finally { f.close(); }
});

test('发布代不 current 或保留时屏蔽为旧结论，不冒充当前', () => {
  const f = fixture();
  try {
    const {id, generation} = seedPublishedReading(f);
    // 组 dirty：即使指针还在，发布代不能当当前结论读。
    f.store.write(db => db.run(
      `UPDATE derive_request_result SET title='retained bait',input_preview='retained input',
       retention_state='retained' WHERE req_id=?`, [id]));
    let detail = getRequest(f.store, id)!;
    expect(detail.derived_state).toBe('retained');
    expect(detail.input_preview).toBeNull();
    expect(detail.historical?.title).toBe('retained bait');
    expect(detail.tool_calls[0]?.result_path).toBeNull();
    expect(detail.tool_results).toEqual([]);
    f.store.write(db => markGroupDirtyTx(db, 'conv-reading', 'actor-reading', ''));
    detail = getRequest(f.store, id)!;
    expect(detail.derived_state).toBe('dirty');
    expect(detail.title).not.toBe('published title');
    expect(detail.tool_calls[0]?.state).toBe('pending');
    expect(detail.tool_results).toEqual([]);
    // 指针指向没有结果行的代：不回退同步诱饵。
    f.store.write(db => db.run(
      `UPDATE derive_queue SET published_generation='gen-missing' WHERE conv_key='conv-reading'`, []));
    const after = getRequest(f.store, id)!;
    expect(after.input_preview).toBeNull();
    expect(after.tool_calls[0]?.state).toBe('pending');
    expect(generation).toBe('gen-reader-published-01');
  } finally { f.close(); }
});

test('older 方向从最近窗口向前翻，同毫秒不漏不重', () => {
  const f = fixture();
  try {
    insertRequests(f.store, SEED_GROUP.convKey, 7, true);
    const first = listRequests(f.store, SEED_GROUP.convKey, 3, null, 'older');
    expect(first.items.map(r => r.req_id)).toEqual([5, 6, 7]);
    const second = listRequests(f.store, SEED_GROUP.convKey, 3, first.next_cursor, 'older');
    expect(second.items.map(r => r.req_id)).toEqual([2, 3, 4]);
    const last = listRequests(f.store, SEED_GROUP.convKey, 3, second.next_cursor, 'older');
    expect(last.items.map(r => r.req_id)).toEqual([1]);
    expect(last.next_cursor).toBeNull();
    // 默认 forward 行为保持：无游标取最早页。
    expect(listRequests(f.store, SEED_GROUP.convKey, 3).items.map(r => r.req_id))
      .toEqual([1, 2, 3]);
  } finally { f.close(); }
});

test('older 方向查询计划沿用会话时间索引', () => {
  const f = fixture();
  try {
    const details = f.store.read.query<unknown, [string, number, number, number]>(`
      EXPLAIN QUERY PLAN
      SELECT r.req_id, r.started_ms
      FROM request r
      WHERE r.conv_key = ? AND (r.started_ms, r.req_id) < (?, ?)
      ORDER BY r.started_ms DESC, r.req_id DESC LIMIT ?`)
      .all(SEED_GROUP.convKey, 1_700_000_000_000, 5, 30);
    expect(JSON.stringify(details)).toContain('i_req_session_time');
    expect(JSON.stringify(details)).not.toContain('SCAN request');
  } finally { f.close(); }
});

test('推理段只认末次尝试的首个推理，缺守卫、非法 JSON 与缺摘要都留空', () => {
  const f = fixture();
  try {
    seedSettledGroup(f.store);
    f.store.write(db => {
      db.run('UPDATE request SET route_id=100, ttft_ms=1000, first_text_ms=3100 WHERE req_id=1');
      db.run('UPDATE request SET route_id=101, ttft_ms=1000, first_text_ms=3100 WHERE req_id=2');
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,route_id,ttft_ms,first_text_ms)
        VALUES (3,?,'session','actor-a','known',3000,'2026-10-20','through','pending',0,1,1,1,102,1000,3100)`,
        [GROUP_KEY]);
      const summary = db.prepare('INSERT INTO route_summary(route_id,time_ms,tries_json) VALUES (?,1,?)');
      // 末次尝试报告了首个推理，差值才是思考时间。
      summary.run(100, JSON.stringify([{ model: 'm1' }, { model: 'm2', firstReasoning: 1400 }]));
      // 末次尝试没有 firstReasoning：首个内容可能直接是文本或工具调用。
      summary.run(101, JSON.stringify([{ model: 'm1', firstReasoning: 1400 }, { model: 'm2' }]));
      // 非法 JSON 由 json_valid 短路成 NULL，不让读列表抛错。
      summary.run(102, 'not json');
    });
    const page = listRequests(f.store, GROUP_KEY, 10, null);
    expect(page.items.map(r => r.req_id)).toEqual([1, 2, 3]);
    expect(page.items.map(r => r.reasoning_span_ms)).toEqual([2100, null, null]);
    // 详情与列表同一口径。
    expect(getRequest(f.store, 1)!.reasoning_span_ms).toBe(2100);
  } finally { f.close(); }
});

test('执行段取结果请求开始减调用请求结束，负值与未结算留空', () => {
  const f = fixture();
  try {
    seedSettledGroup(f.store);
    f.store.write(db => {
      db.run('UPDATE request SET ms=1200 WHERE req_id=1');
      db.run('UPDATE request SET started_ms=6000 WHERE req_id=2');
    });
    // 调用请求 1001 开始 + 1200 结束 = 2201；结果请求 6000 开始。
    expect(getRequest(f.store, 1)!.tool_calls.map(c => c.exec_ms)).toEqual([3799]);
    // 结果先于调用结束：时钟或结算异常，留空而不是画负数。
    f.store.write(db => db.run('UPDATE request SET started_ms=1100 WHERE req_id=2'));
    expect(getRequest(f.store, 1)!.tool_calls.map(c => c.exec_ms)).toEqual([null]);
    // 组不再当前时配对与执行段一起收起，旧读数不外露。
    f.store.write(db => markGroupDirtyTx(db, GROUP_KEY, 'actor-a', ''));
    const stale = getRequest(f.store, 1)!;
    expect(stale.derived_state).not.toBe('current');
    expect(stale.tool_calls.map(c => c.exec_ms)).toEqual([null]);
  } finally { f.close(); }
});

/** 会话列表第二轮：两阶段同快照查询的范围、计划与等价性。 */

import type { Database } from 'bun:sqlite';

import { LEGACY_LIST_WIDE, legacyListSessions } from './session-list-oracle';

/** 按指定基数插入请求，供同毫秒、迟到旧请求等场景控制时间分布。 */
function insertRequestsAt(store: ReturnType<typeof fixture>['store'], convKey: string, count: number, baseMs: number): void {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,cost_state,ms,ttft_ms,flow_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,?,200,'absent',?,?,?)`,
    );
    for (let i = 0; i < count; i++) {
      insert.run(
        convKey, 'session', 'actor-a', 'claude', 'known',
        baseMs + i, '2026-10-20', 'through', 'pending', 0,
        `t-${i}`, 1000 + i, 100 + i, 900 + i,
      );
    }
  });
}

function captureReadQueries(store: ReturnType<typeof fixture>['store']): {
  captured: { sql: string; params: unknown[] }[];
  restore(): void;
} {
  const original = store.read.query;
  const captured: { sql: string; params: unknown[] }[] = [];
  const patched = (sql: string, ...rest: unknown[]) => {
    captured.push({ sql, params: rest });
    return (original as unknown as (...args: unknown[]) => unknown).apply(store.read, [sql, ...rest]);
  };
  (store.read as unknown as { query: unknown }).query = patched;
  return {
    captured,
    restore: () => {
      (store.read as unknown as { query: unknown }).query = original;
    },
  };
}

function explainPlan(read: Database, sql: string, params: unknown[]): string {
  return (read.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[])
    .map(row => row.detail).join(' | ');
}

test('新旧会话列表实现逐页等价：翻页全序、标题、迟到旧请求与NULL键', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'oracle-title', purposePending: 0, purposeChain: 'exclude',
      reqKind: 'title', modelTitle: '正式标题', title: 'x',
      titleSource: 'model_title', purposeStatus: 'recognized', purposeVersion: 2,
      startedMs: 1_700_000_020_000, cleanGroup: true,
    });
    insertRequestsAt(f.store, JSON.stringify(['session', 'oracle-a']), 4, 1_700_000_000_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'oracle-b']), 2, 1_699_999_999_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'oracle-c']), 3, 1_700_000_010_000);
    // 迟到旧请求：last_ms 取组内最大值，计数包含它。
    insertRequestsAt(f.store, JSON.stringify(['session', 'oracle-c']), 1, 1_699_000_000_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'oracle-d']), 30, 1_698_000_000_000);
    // 无会话键的行不进任何会话，也不影响排序。
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO request(conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
         VALUES ('session','actor-a','known',1700000030000,'2026-10-20','hook','pending',0,1,1,1)`,
      );
      insert.run();
      insert.run();
    });

    // 旧实现排序：title > c > a > b > d。两个实现各走一遍翻页全序，逐页比较完整返回值。
    const walk = (run: (limit: number, cursor: string | null) => ReturnType<typeof listSessions>) => {
      const pages: ReturnType<typeof listSessions>[] = [];
      for (const limit of [3, 2]) {
        let cursor: string | null = null;
        do {
          const page = run(limit, cursor);
          pages.push(page);
          cursor = page.next_cursor;
        } while (cursor !== null);
      }
      return pages;
    };
    const legacyPages = walk((limit, cursor) => legacyListSessions(f.store, limit, cursor) as ReturnType<typeof listSessions>);
    const freshPages = walk((limit, cursor) => listSessions(f.store, limit, cursor));
    expect(freshPages).toEqual(legacyPages);
    expect(legacyPages.length).toBe(5);
    const flat = legacyPages.flatMap(page => page.items);
    // 两个 limit 档各走完整翻页序：3+2 与 2+2+1，同一全序出现两遍。
    expect(flat.map(row => row.conv_key)).toEqual([
      'oracle-title',
      JSON.stringify(['session', 'oracle-c']),
      JSON.stringify(['session', 'oracle-a']),
      JSON.stringify(['session', 'oracle-b']),
      JSON.stringify(['session', 'oracle-d']),
      'oracle-title',
      JSON.stringify(['session', 'oracle-c']),
      JSON.stringify(['session', 'oracle-a']),
      JSON.stringify(['session', 'oracle-b']),
      JSON.stringify(['session', 'oracle-d']),
    ]);
    expect(flat.length).toBe(10);
    // 页内宽聚合覆盖组内全部历史：迟到旧请求计入计数，正式标题来自标题子查询。
    expect(flat[0]!.title).toBe('正式标题');
    expect(flat[1]!.request_count).toBe(4);
  } finally { f.close(); }
});

/**
 * 脏组首页的标题求值：组当前性闸门要先判一次组，脏组直接落空。
 * 精确计时不好断言的场合用同一条 SQL 去掉标题列做差，把聚合的固定成本抵消掉。
 */
function dirtyWideSession(store: ReturnType<typeof fixture>['store'], convKey: string, rows: number): void {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,title,title_source,status,
        purpose_pending,purpose_chain,chain_role,req_kind,cost_state,ms,ttft_ms,flow_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,200,0,'participate','main','chat','absent',?,?,?)`,
    );
    for (let i = 0; i < rows; i++) {
      // 宽标题让「逐行证明没有标题」的扫描成本在旧实现下显著增长。
      insert.run(convKey, 'session', 'actor-a', 'claude', 'known', 1_700_000_000_000 + i,
        '2026-11-01', 'through', 'pending', 0, `标题-${i}`.repeat(200), 'user_delta',
        1000 + i, 100 + i, 900 + i);
    }
    // 组脏：输入修订领先已发布修订，四个标题候选全部落空。
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,input_revision,published_revision,
      target_algorithm,published_algorithm,state) VALUES (?,'actor-a','',3,2,1,1,'dirty')`, [convKey]);
  });
}

/** 第二轮宽聚合去掉标题列后的耗时；与整条查询的差就是标题求值成本。 */
function titleCostMs(store: ReturnType<typeof fixture>['store'], convKey: string): number {
  const hook = captureReadQueries(store);
  try {
    listSessions(store, 1, null);
  } finally {
    hook.restore();
  }
  const sql = hook.captured.find(c => c.sql.includes('AS title,'));
  if (sql === undefined) throw new Error('title_query_not_captured');
  const start = sql.sql.indexOf('CASE WHEN EXISTS');
  const end = sql.sql.indexOf('END AS title,');
  if (start === -1 || end === -1) throw new Error('title_guard_not_found');
  const blank = store.read.query(`${sql.sql.slice(0, start)}NULL AS title,${
    sql.sql.slice(end + 'END AS title,'.length)}`);
  const timed = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const full: number[] = [];
  const bare: number[] = [];
  for (let i = 0; i < 9; i++) {
    full.push(timed(() => listSessions(store, 1, null)));
    bare.push(timed(() => blank.all(convKey)));
  }
  const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[4]!;
  return median(full) - median(bare);
}

test('脏热组的标题求值不随会话行数线性增长', () => {
  const small = fixture();
  const large = fixture();
  try {
    const key = JSON.stringify(['session', 'dirty-hot']);
    dirtyWideSession(small.store, key, 1_000);
    dirtyWideSession(large.store, key, 8_000);
    // 标题为空是语义要求；闸门只是让它不再付整组扫描的代价。
    expect(listSessions(large.store, 1).items[0]?.title).toBe('');
    const smallCost = titleCostMs(small.store, key);
    const largeCost = titleCostMs(large.store, key);
    // 旧实现 8 千行约 27 ms，且随行数线性增长；闸门后两者都与行数脱钩。
    expect(largeCost).toBeLessThan(5);
    expect(largeCost - smallCost).toBeLessThan(3);
  } finally {
    small.close();
    large.close();
  }
});

test('组在两次读取之间切换 clean/dirty，标题随之出现与消失', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'toggle-title', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: '用户首句', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 1, cleanGroup: true,
    });
    const titleOf = (): string => listSessions(f.store, 10).items[0]?.title ?? '';
    expect(titleOf()).toBe('用户首句');
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=input_revision+1
      WHERE conv_key='toggle-title'`));
    expect(titleOf()).toBe('');
    f.store.write(db => db.run(`UPDATE derive_queue SET published_revision=input_revision
      WHERE conv_key='toggle-title'`));
    expect(titleOf()).toBe('用户首句');
  } finally { f.close(); }
});

test('多 actor 会话：一个组 clean 就放行，标题仍只取 current 组的行', () => {
  const f = fixture();
  try {
    // actor-a 已结算并有标题；actor-b 的组还脏。
    seedPurposeRequest(f.store, {
      convKey: 'multi-actor', actor: 'actor-a', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: 'a 的标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 1, cleanGroup: true,
    });
    seedPurposeRequest(f.store, {
      convKey: 'multi-actor', actor: 'actor-b', purposePending: 0, purposeChain: 'participate',
      reqKind: 'chat', title: 'b 的标题', titleSource: 'user_delta',
      chainRole: 'main', startedMs: 2,
    });
    expect(listSessions(f.store, 10).items[0]?.title).toBe('a 的标题');
  } finally { f.close(); }
});

test('两阶段查询计划：候选走覆盖索引，宽聚合只搜索页内键，旧查询全表扫描', () => {
  const f = fixture();
  try {
    insertRequestsAt(f.store, JSON.stringify(['session', 'plan-a']), 3, 1_700_000_000_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'plan-b']), 2, 1_700_000_000_100);
    const hook = captureReadQueries(f.store);
    try {
      listSessions(f.store, 2, null);
      // plan-b 比 plan-a 新：游标从 plan-b 之后走，下一候选 plan-a 非空，宽聚合才执行。
      const legacyCursor = Buffer.from(
        JSON.stringify([1_700_000_000_102, JSON.stringify(['session', 'plan-b'])]), 'utf8',
      ).toString('base64url');
      listSessions(f.store, 2, legacyCursor);
    } finally {
      hook.restore();
    }
    const firstPhase = hook.captured.filter(c => c.sql.includes('MAX(started_ms)') && !c.sql.includes('COUNT(*)'));
    expect(firstPhase.length).toBe(2);
    for (const { sql, params } of firstPhase) {
      // 首页是覆盖索引全扫，游标页是索引区间搜索：两者都必须留在覆盖索引上，不回表。
      expect(explainPlan(f.store.read, sql, params)).toContain('COVERING INDEX i_req_session_time');
    }
    const secondPhase = hook.captured.filter(c => c.sql.includes('COUNT(*)') && c.sql.includes('IN ('));
    expect(secondPhase.length).toBe(2);
    for (const { sql, params } of secondPhase) {
      const detail = explainPlan(f.store.read, sql, params);
      // 外层逐键等值搜索；标题子查询自己的 conv_key=? 不参与区分，只看首行。
      const outer = detail.split(' | ')[0]!;
      expect(outer).toContain('SEARCH request');
      expect(outer).toContain('(conv_key=?)');
      expect(outer).not.toContain('(conv_key>?)');
      // 标题前的组当前性闸门只按键查队列主键，每组一行，不进请求行。
      expect(detail).toContain('SEARCH g USING PRIMARY KEY (conv_key=?)');
    }
    // 同库旧查询的外层对全部会话键做区间扫描：范围断言能失败，新实现的通过才有意义。
    const legacyDetail = explainPlan(f.store.read, `${LEGACY_LIST_WIDE} ORDER BY last_ms DESC, conv_key DESC LIMIT ?`, [3]);
    expect(legacyDetail.split(' | ')[0]).toContain('(conv_key>?)');
  } finally { f.close(); }
});

test('两阶段之间提交的会话不进入当前页，下一次调用可见', () => {
  const f = fixture();
  try {
    insertRequestsAt(f.store, JSON.stringify(['session', 'first']), 2, 1_700_000_000_000);
    const original = f.store.read.query;
    let calls = 0;
    (f.store.read as unknown as { query: unknown }).query = (sql: string, ...rest: unknown[]) => {
      calls += 1;
      // 第二条语句准备前插入：阶段一已执行、WAL 快照已固定，宽聚合必须仍读旧快照。
      if (calls === 2) insertRequestsAt(f.store, JSON.stringify(['session', 'late']), 1, 1_700_000_040_000);
      return (original as unknown as (...args: unknown[]) => unknown).apply(f.store.read, [sql, ...rest]);
    };
    let page: ReturnType<typeof listSessions>;
    try {
      page = listSessions(f.store, 10, null);
    } finally {
      (f.store.read as unknown as { query: unknown }).query = original;
    }
    expect(page.items.map(row => row.conv_key)).toEqual([JSON.stringify(['session', 'first'])]);
    const next = listSessions(f.store, 10, null);
    expect(next.items.map(row => row.conv_key)).toEqual([
      JSON.stringify(['session', 'late']),
      JSON.stringify(['session', 'first']),
    ]);
  } finally { f.close(); }
});

test('空库、无会话键与同毫秒并列的翻页边界', () => {
  const f = fixture();
  try {
    expect(listSessions(f.store, 10)).toEqual({ items: [], next_cursor: null });
    f.store.write(db => {
      const insert = db.prepare(
        `INSERT INTO request(conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
         VALUES ('session','actor-a','known',1700000000000,'2026-10-20','hook','pending',0,1,1,1)`,
      );
      insert.run();
    });
    expect(listSessions(f.store, 10)).toEqual({ items: [], next_cursor: null });

    // 同毫秒的两个会话按键倒序；游标页从 (ms, key) 之后继续，不漏不重。
    insertRequestsAt(f.store, JSON.stringify(['session', 'zzz']), 1, 1_700_000_000_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'aaa']), 1, 1_700_000_000_000);
    insertRequestsAt(f.store, JSON.stringify(['session', 'mmm']), 1, 1_700_000_000_000);
    const first = listSessions(f.store, 2, null);
    expect(first.items.map(row => row.conv_key)).toEqual([
      JSON.stringify(['session', 'zzz']),
      JSON.stringify(['session', 'mmm']),
    ]);
    expect(first.next_cursor).not.toBeNull();
    const second = listSessions(f.store, 2, first.next_cursor!);
    expect(second.items.map(row => row.conv_key)).toEqual([JSON.stringify(['session', 'aaa'])]);
    expect(second.next_cursor).toBeNull();
  } finally { f.close(); }
});

function setUserFingerprint(store: ReturnType<typeof fixture>['store'], reqId: number, fingerprint: string): void {
  store.write(db => db.run('UPDATE request SET user_fingerprint=? WHERE req_id=?', [fingerprint, reqId]));
}

function codexSession(store: ReturnType<typeof fixture>['store'], key: string, options: {
  startedMs: number; fingerprint: string; title?: string; modelTitle?: string | null;
  kind?: string; chain?: 'participate' | 'exclude'; status?: string; pending?: number;
}): number {
  const reqId = seedPurposeRequest(store, {
    convKey: JSON.stringify(['session', key]),
    agent: 'codex',
    startedMs: options.startedMs,
    purposeStatus: options.status ?? 'recognized',
    purposePending: options.pending ?? 0,
    purposeChain: options.chain ?? 'participate',
    reqKind: options.kind ?? 'chat',
    modelTitle: options.modelTitle ?? null,
    title: options.title ?? '',
    cleanGroup: true,
  });
  setUserFingerprint(store, reqId, options.fingerprint);
  return reqId;
}

test('跨组标题：标题请求与主会话指纹唯一命中时才借模型标题', () => {
  const f = fixture();
  try {
    codexSession(f.store, 'main', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-redraw', title: '用户首句',
    });
    codexSession(f.store, 'title-card', {
      startedMs: 1_700_000_000_500, fingerprint: 'fp-redraw',
      kind: 'title', chain: 'exclude', modelTitle: '重绘 ATC 矩阵 IP',
    });

    const mainKey = JSON.stringify(['session', 'main']);
    const mainRow = listSessions(f.store, 10).items.find(row => row.conv_key === mainKey);
    expect(mainRow?.title).toBe('重绘 ATC 矩阵 IP');
    expect(titleBindingOf(f.store, mainKey)).toEqual({
      status: 'bound', title: '重绘 ATC 矩阵 IP', title_matches: 1, session_matches: 1,
    });

    const titleKey = JSON.stringify(['session', 'title-card']);
    const titleRow = listSessions(f.store, 10).items.find(row => row.conv_key === titleKey);
    // 标题请求自身仍是旁路卡（前端折叠），不参与主链。
    expect(titleRow?.flags).toContain('bypass');
  } finally { f.close(); }
});

test('跨组标题：零命中不绑，退回用户标题', () => {
  const f = fixture();
  try {
    const mainKey = JSON.stringify(['session', 'main-zero']);
    codexSession(f.store, 'main-zero', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-main-zero', title: '用户首句',
    });
    codexSession(f.store, 'title-zero', {
      startedMs: 1_700_000_000_500, fingerprint: 'fp-other',
      kind: 'title', chain: 'exclude', modelTitle: '不该出现的标题',
    });
    const mainRow = listSessions(f.store, 10).items.find(row => row.conv_key === mainKey);
    expect(mainRow?.title).not.toBe('不该出现的标题');
    expect(titleBindingOf(f.store, mainKey)).toEqual({
      status: 'unbound', title: null, title_matches: 0, session_matches: 0,
    });
  } finally { f.close(); }
});

test('跨组标题：多标题或多会话命中都明确不绑', () => {
  const f = fixture();
  try {
    const mainKey = JSON.stringify(['session', 'main-multi']);
    codexSession(f.store, 'main-multi', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-multi', title: '用户首句',
    });
    codexSession(f.store, 'title-multi-a', {
      startedMs: 1_700_000_000_400, fingerprint: 'fp-multi',
      kind: 'title', chain: 'exclude', modelTitle: '标题 A',
    });
    codexSession(f.store, 'title-multi-b', {
      startedMs: 1_700_000_000_500, fingerprint: 'fp-multi',
      kind: 'title', chain: 'exclude', modelTitle: '标题 B',
    });
    const mainRow = listSessions(f.store, 10).items.find(row => row.conv_key === mainKey);
    expect(mainRow?.title).not.toBe('标题 A');
    expect(titleBindingOf(f.store, mainKey)).toMatchObject({
      status: 'ambiguous', title: null, title_matches: 2,
    });

    // 同一指纹命中两个主会话：即使标题唯一，也不能把标题同时挂到两张卡上。
    const f2 = fixture();
    try {
      const a = JSON.stringify(['session', 'main-a']);
      codexSession(f2.store, 'main-a', { startedMs: 1_700_000_000_000, fingerprint: 'fp-two' });
      codexSession(f2.store, 'main-b', { startedMs: 1_700_000_000_100, fingerprint: 'fp-two' });
      codexSession(f2.store, 'title-one', {
        startedMs: 1_700_000_000_500, fingerprint: 'fp-two',
        kind: 'title', chain: 'exclude', modelTitle: '唯一标题',
      });
      expect(titleBindingOf(f2.store, a)).toMatchObject({
        status: 'ambiguous', title: null, session_matches: 2,
      });
      const aRow = listSessions(f2.store, 10).items.find(row => row.conv_key === a);
      expect(aRow?.title).not.toBe('唯一标题');
    } finally { f2.close(); }
  } finally { f.close(); }
});

test('跨组标题短路：有指纹时绑定语义不变，闸门先于相关子查询求值', () => {
  const f = fixture();
  try {
    const mainKey = JSON.stringify(['session', 'short-main']);
    codexSession(f.store, 'short-main', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-short', title: '用户首句',
    });
    codexSession(f.store, 'short-title', {
      startedMs: 1_700_000_000_500, fingerprint: 'fp-short',
      kind: 'title', chain: 'exclude', modelTitle: '重绘 ATC 矩阵 IP',
    });

    // 唯一命中：短路放行后照旧借到模型标题。
    expect(listSessions(f.store, 10).items.find(row => row.conv_key === mainKey)?.title)
      .toBe('重绘 ATC 矩阵 IP');

    // 零命中：另一指纹的标题不绑。
    codexSession(f.store, 'short-zero', {
      startedMs: 1_700_000_001_000, fingerprint: 'fp-main-zero', title: '零命中',
    });
    codexSession(f.store, 'short-zero-title', {
      startedMs: 1_700_000_001_500, fingerprint: 'fp-other',
      kind: 'title', chain: 'exclude', modelTitle: '不该出现的标题',
    });
    expect(listSessions(f.store, 10).items
      .find(row => row.conv_key === JSON.stringify(['session', 'short-zero']))?.title)
      .not.toBe('不该出现的标题');

    // 多命中：同一指纹出现第二条标题后转为歧义，不绑。
    codexSession(f.store, 'short-title-2', {
      startedMs: 1_700_000_000_600, fingerprint: 'fp-short',
      kind: 'title', chain: 'exclude', modelTitle: '标题 B',
    });
    const mainRow = listSessions(f.store, 10).items.find(row => row.conv_key === mainKey);
    expect(mainRow?.title).not.toBe('重绘 ATC 矩阵 IP');
    expect(mainRow?.title).not.toBe('标题 B');
    expect(titleBindingOf(f.store, mainKey)).toMatchObject({
      status: 'ambiguous', title: null, title_matches: 2,
    });

    // 计划：闸门只走单会话时间索引，且排在跨组子查询之前。
    const hook = captureReadQueries(f.store);
    try {
      listSessions(f.store, 10, null);
    } finally {
      hook.restore();
    }
    const detail = hook.captured.find(c => c.sql.includes('AS title,'));
    if (detail === undefined) throw new Error('title_query_not_captured');
    const plan = explainPlan(f.store.read, detail.sql, detail.params);
    expect(plan).toContain('SEARCH x USING INDEX i_req_session_time');
    expect(plan.indexOf('SEARCH x USING INDEX i_req_session_time'))
      .toBeLessThan(plan.indexOf('i_derive_queue_dirty'));
  } finally { f.close(); }
});

test('后台组标记：ambient 混入未知参与链仍是 background，出现已识别主链则解除', () => {
  const f = fixture();
  try {
    const ambientKey = JSON.stringify(['session', 'ambient']);
    codexSession(f.store, 'ambient', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-ambient',
      kind: 'source:ambient_suggestions', chain: 'exclude',
    });
    codexSession(f.store, 'ambient', {
      startedMs: 1_700_000_000_100, fingerprint: 'fp-ambient-unknown',
      status: 'missing', pending: 0,
    });
    const ambient = listSessions(f.store, 10).items.find(row => row.conv_key === ambientKey);
    expect(ambient?.flags).toContain('background');
    expect(ambient?.flags).not.toContain('bypass');

    const mixedKey = JSON.stringify(['session', 'mixed']);
    codexSession(f.store, 'mixed', {
      startedMs: 1_700_000_000_000, fingerprint: 'fp-mixed',
      kind: 'source:ambient_suggestions', chain: 'exclude',
    });
    codexSession(f.store, 'mixed', {
      startedMs: 1_700_000_000_100, fingerprint: 'fp-mixed-main',
    });
    const mixed = listSessions(f.store, 10).items.find(row => row.conv_key === mixedKey);
    expect(mixed?.flags).not.toContain('background');
  } finally { f.close(); }
});

test('getStats 复用同写世代的缓存，写入后重算（F06）', () => {
  const f = fixture();
  try {
    insertRequests(f.store, JSON.stringify(['session', 's-cache']), 1, false);
    const first = getStats(f.store);
    // 世代未变：返回同一份结果，不再付一次全表聚合。
    expect(getStats(f.store)).toBe(first);
    insertRequests(f.store, JSON.stringify(['session', 's-cache']), 1, false);
    const second = getStats(f.store);
    expect(second).not.toBe(first);
    expect(second.requests).toBe(first.requests + 1);
  } finally { f.close(); }
});
