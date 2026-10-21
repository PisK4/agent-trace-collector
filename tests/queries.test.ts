import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { getStats, listRequests, listSessions } from '../src/queries';

function insertRequests(store: ReturnType<typeof fixture>['store'], convKey: string, count: number, sameMs: boolean): void {
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,cost_state)
       VALUES (?,?,?,?,?,?,'through','pending',0,3,1,1,?,?,'absent')`,
    );
    for (let i = 0; i < count; i++) {
      insert.run(convKey, 'session', 'actor-a', 'known', sameMs ? 1_700_000_000_000 : 1_700_000_000_000 + i, '2026-10-20', `t-${i}`, 200);
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
    expect(page.items.every(row => row.agents.includes('actor-a'))).toBe(true);
    expect(page.next_cursor).toBeNull();
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
