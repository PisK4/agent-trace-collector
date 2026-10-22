import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadBoundSalt, loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { getRequest, getStats, listRequests, listSessions } from '../src/queries';
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
    loadBoundSalt(f.store, f.dir);
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
