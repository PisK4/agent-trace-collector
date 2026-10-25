import { expect, test } from 'bun:test';
import { fixture, SEED_GROUP, seedPurposeRequest } from './fixtures';
import { loadBoundSaltTx, loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { zstdCompressSync } from 'node:zlib';
import { attemptChainOf, getRoute, routeSummaryReading } from '../src/queries/routes';
import { derivationOf, projectionMetaReading, promptReadingOf, sourceFactsReading } from '../src/queries/readings';
import type { ProjectionMetaReading } from '../src/queries/readings';
import { getRequest, listRequests } from '../src/queries/requests';
import { getStats } from '../src/queries/stats';
import { listSessions } from '../src/queries/sessions';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive';
import { markGroupDirtyTx } from '../src/derive-state';

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
    });
    const stats = getStats(f.store);
    expect(stats.requests).toBe(2);
    expect(stats.issues).toEqual([{ source_kind: 'ledger', reason: 'ledger_invalid_json', count: 1 }]);
    expect(stats.gaps.length).toBe(1);
    expect(stats.body_states).toEqual([{ state: 'pending', count: 2 }]);
    // 那条 unrecoverable 缺口不算未了，未了缺口单独计数。
    expect(stats.open_gaps).toBe(0);
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
    // 工具行挂在发起调用的那一笔上，配对结果指向第二笔。
    const caller = getRequest(f.store, 1)!;
    expect(caller.tool_calls[0]?.state).toBe('resolved');
    expect(caller.tool_calls[0]?.result_req).toBe(2);
    expect(detail.tool_results).toEqual([{ owner_req: 1, ...caller.tool_calls[0] }]);
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

test('启动拒绝端口冲突且端口由配置决定', async () => {
  const f = fixture();
  const held = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    const config = { ...loadConfig({}), port: held.port ?? 0, dataDir: f.dir };
    await expect(startCollector(config)).rejects.toThrow();
  } finally {
    await held.stop(true);
    f.close();
  }
});

test('SIGTERM停止后不再响应请求', async () => {
  const f = fixture();
  try {
    const config = {
      ...loadConfig({}),
      port: 0,
      dataDir: f.dir,
      ledgerPath: `${f.dir}/missing.jsonl`,
      routingDir: `${f.dir}/missing-routing`,
    };
    const collector = await startCollector(config);
    const response = await fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
      headers: { origin: `http://127.0.0.1:${collector.port}` },
    });
    expect(response.status).toBe(200);
    await collector.stop();
    await expect(fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
      headers: { origin: `http://127.0.0.1:${collector.port}` },
    })).rejects.toThrow();
  } finally {
    f.close();
  }
});

test('启动时逐项运行各任务，回收不受其它任务占锁影响', async () => {
  const f = fixture();
  try {
    // 盐与库的绑定要在空库时建立：有数据之后再生成盐会被拒绝（无法证明历史占位符用的是它）。
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    const config = {
      ...loadConfig({}),
      port: 0,
      dataDir: f.dir,
      ledgerPath: `${f.dir}/missing.jsonl`,
      routingDir: `${f.dir}/missing-routing`,
      // 预算压到 100 字节（这两段重复文本压缩后约 370 B）：启动时那一轮回收必须真的执行，
      // 而不是被前一个 tick 的锁挡住。
      bodyBudget: 100,
      diskLimit: 16_000_000_000,
    };
    for (const id of [1, 2]) {
      f.store.db.run(
        "INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (?,?,?,'hook','pending',0,1,1,1)",
        [id, id, '2026-10-20'],
      );
      persistBody(f.store, id, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(4096) + id }] }] },
        reply: { id: `msg_${id}`, content: [] },
        redact_version: 1,
      });
    }
    const collector = await startCollector(config);
    try {
      // 启动那一轮是同步发起的；给事件循环一个机会跑完。
      await new Promise(resolve => setTimeout(resolve, 50));
      const states = f.store.read.query<{ body_state: string }, []>(
        'SELECT body_state FROM request ORDER BY req_id').all();
      expect(states).toEqual([{ body_state: 'evicted' }, { body_state: 'evicted' }]);
    } finally {
      await collector.stop();
    }
  } finally {
    f.close();
  }
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
    prompt: { tokens: 100, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 60 }] },
    error: 'synthetic error', order: [], tries: [], affinity: null, saved_at: 1,
  }, routeColumns);
  expect(reading.format).toBe(2);
  expect(reading.kind).toBe('chat');
  expect(reading.folder).toBe('/tmp/project');
  expect(reading.effort).toBe('high');
  expect(reading.prompt).toEqual({ tokens: 100, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 60 }] });
  expect(reading.error).toBe('synthetic error');
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
    reasoning_hidden: true, queued_ms: 188, fail: null, error: null,
  });
  expect(chain.items[0]?.start_ms).not.toBeNull();
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
    expect(detail.tool_results).toEqual([{ owner_req: id, ...detail.tool_calls[0] }]);
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
