import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { createHandler, loadReadToken } from '../src/http';
import { getRequest, getRoute, listRequests, listSessions } from '../src/queries';
import { createCapacityMetrics } from '../src/capacity';

function seedRequests(store: ReturnType<typeof fixture>['store'], convKey: string, count: number, sameMs = false): number[] {
  const ids: number[] = [];
  store.write(db => {
    const insert = db.prepare(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,status,in_tok,cost_state)
       VALUES (?,?,?,?,?,?,'through','pending',0,3,1,1,?,?,?,'absent')`,
    );
    for (let i = 0; i < count; i++) {
      const started = sameMs ? 1_700_000_000_000 : 1_700_000_000_000 + i;
      const result = insert.run(convKey, 'session', 'actor-a', 'known', started, '2026-10-20', `title-${i}`, 200, i);
      ids.push(Number(result.lastInsertRowid));
    }
  });
  return ids;
}

test('伪造Host和null Origin被拒绝', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const foreign = new Request('http://127.0.0.1:8320/api/sessions', { headers: { host: 'evil.example', origin: 'http://evil.example' } });
    const opaque = new Request('http://127.0.0.1:8320/api/sessions', { headers: { host: '127.0.0.1:8320', origin: 'null' } });
    expect((await handler(foreign)).status).toBe(403);
    expect((await handler(opaque)).status).toBe(403);
  } finally {
    f.close();
  }
});

test('访问矩阵覆盖同源、读取令牌与对抗情形', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const make = (headers: Record<string, string>) =>
      new Request('http://127.0.0.1:8320/api/sessions', { headers: { host: '127.0.0.1:8320', ...headers } });

    expect((await handler(make({ origin: 'http://127.0.0.1:8320' }))).status).toBe(200);
    expect((await handler(make({ 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
    expect((await handler(make({ authorization: 'Bearer synthetic-read-token' }))).status).toBe(200);
    expect((await handler(make({}))).status).toBe(401);
    expect((await handler(make({ authorization: 'Bearer wrong-token' }))).status).toBe(401);
    expect((await handler(make({ 'sec-fetch-site': 'cross-site' }))).status).toBe(401);
    expect((await handler(make({ origin: 'http://localhost:8320' }))).status).toBe(403);
    expect((await handler(make({ origin: 'http://127.0.0.1:9999' }))).status).toBe(403);
    expect((await handler(new Request('http://127.0.0.1:8320/api/sessions', { headers: { origin: 'http://127.0.0.1:8320' } }))).status).toBe(403);

    const injected = make({ origin: 'http://127.0.0.1:8320' });
    const url = new URL(injected.url);
    url.searchParams.set('cursor', "'; DROP TABLE request; --");
    const injectedRequest = new Request(url, { headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' } });
    expect((await handler(injectedRequest)).status).toBe(400);

    const bigLimit = new URL('http://127.0.0.1:8320/api/sessions?limit=100000');
    const big = new Request(bigLimit, { headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' } });
    expect((await handler(big)).status).toBe(400);

    const options = await handler(new Request('http://127.0.0.1:8320/api/sessions', {
      method: 'OPTIONS',
      headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
    }));
    expect(options.status).toBe(405);

    const missing = await handler(new Request('http://127.0.0.1:8320/api/requests/999', {
      headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
    }));
    expect(missing.status).toBe(404);
  } finally {
    f.close();
  }
});

test('响应头包含no-store与nosniff且无CORS', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const response = await handler(new Request('http://127.0.0.1:8320/api/stats', {
      headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = await response.json() as Record<string, unknown>;
    // open_gaps 单独给出未了缺口数：gaps 是明细，前端统计不必自己数状态。
    // cost_health 是费用时钟冲突的计数与阻塞时点，正常时为 null。
    expect(Object.keys(body).sort()).toEqual([
      'body_states', 'cost_health', 'cursors', 'gaps', 'issues', 'open_gaps', 'pending_hooks', 'probe', 'requests',
    ]);
  } finally {
    f.close();
  }
});

test('页面CSP放行内联样式但仍禁止内联脚本', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const response = await handler(new Request('http://127.0.0.1:8320/', {
      headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
    }));
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    const styleSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('style-src')) ?? '';
    // 页面用内联 <style> 与内联 style 属性；script-src 不能因此放宽。
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  } finally {
    f.close();
  }
});

test('页面模块白名单能取到阅读器依赖的脚本', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    // /app.js 会 import /body-view.js；它不在白名单里时页面会整块加载失败。
    for (const [path, type] of [['/app.js', 'text/javascript'], ['/body-view.js', 'text/javascript'], ['/reader-store.js', 'text/javascript']]) {
      const response = await handler(new Request(`http://127.0.0.1:8320${path}`, {
        headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  } finally {
    f.close();
  }
});

test('非白名单静态路径返回404', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    for (const path of ['/etc/passwd', '/../package.json', '/app.js.map', '/index.html', '/src/http.ts']) {
      const response = await handler(new Request(`http://127.0.0.1:8320${path}`, {
        headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
      }));
      expect(response.status).toBe(404);
    }
  } finally {
    f.close();
  }
});

test('读取令牌重启复用且与hook令牌分离', async () => {
  const f = fixture();
  try {
    const first = loadReadToken(f.dir);
    expect(first.length).toBe(43);
    expect(loadReadToken(f.dir)).toBe(first);
    const handler = createHandler(f.store, loadConfig({}), first);
    const hookAttempt = await handler(new Request('http://127.0.0.1:8320/api/sessions', {
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer synthetic-hook-token' },
    }));
    expect(hookAttempt.status).toBe(401);
  } finally {
    f.close();
  }
});

test('1825笔同会话分页无漏重', () => {
  const f = fixture();
  try {
    const convKey = JSON.stringify(['session', 'synthetic-large']);
    seedRequests(f.store, convKey, 1825, true);
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = listRequests(f.store, convKey, 100, cursor);
      for (const row of page.items) {
        expect(seen.has(row.req_id)).toBe(false);
        seen.add(row.req_id);
      }
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null);
    expect(seen.size).toBe(1825);
    expect(pages).toBe(19);
  } finally {
    f.close();
  }
});

test('分页期间新增请求不会让旧页重复', async () => {
  const f = fixture();
  try {
    const convKey = JSON.stringify(['session', 'synthetic-growing']);
    seedRequests(f.store, convKey, 250);
    const first = listRequests(f.store, convKey, 100, null);
    expect(first.items.length).toBe(100);
    seedRequests(f.store, convKey, 5);
    const second = listRequests(f.store, convKey, 100, first.next_cursor);
    const overlap = second.items.filter(row => first.items.some(prev => prev.req_id === row.req_id));
    expect(overlap).toEqual([]);
    expect(new Set([...first.items, ...second.items].map(row => row.req_id)).size).toBe(200);
  } finally {
    f.close();
  }
});

test('会话列表按最后时间倒序且分页稳定', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) {
      seedRequests(f.store, JSON.stringify(['session', `conv-${i}`]), 3);
    }
    const page = listSessions(f.store, 3, null);
    expect(page.items.length).toBe(3);
    expect(page.items.every(row => row.request_count === 3)).toBe(true);
    const next = listSessions(f.store, 3, page.next_cursor);
    const keys = new Set([...page.items, ...next.items].map(row => row.conv_key));
    expect(keys.size).toBe(5);
  } finally {
    f.close();
  }
});

test('非法limit、坏cursor与缺实体分别返回400与404', () => {
  const f = fixture();
  try {
    expect(() => listRequests(f.store, 'k', 0, null)).toThrow('invalid_limit');
    expect(() => listRequests(f.store, 'k', 500, null)).toThrow('invalid_limit');
    expect(() => listRequests(f.store, 'k', 10, '!!!not-base64')).toThrow('invalid_cursor');
    expect(() => listSessions(f.store, 10, Buffer.from('[1]', 'utf8').toString('base64url'))).toThrow('invalid_cursor');
    expect(getRequest(f.store, 12345)).toBeNull();
    expect(getRoute(f.store, 12345)).toEqual({ state: 'absent', summary: null });
  } finally {
    f.close();
  }
});

test('详情不返回账户字段也不返回骨架', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,agent,provider,title_source,prev_relation)
         VALUES (1,'k',1,'2026-10-20','through','available',0,3,1,1,'t','demo','p','model_time','first')`,
      );
      db.run("INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json,account) VALUES ('file','g:0',0,'t',1,'through','{\"account\":\"synthetic\"}','synthetic')");
    });
    const detail = getRequest(f.store, 1);
    expect(detail).not.toBeNull();
    const keys = Object.keys(detail!);
    for (const forbidden of ['account', 'host', 'providerKeyId', 'skeleton_z', 'skeleton', 'provider']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(detail!.derived_state).toBe('dirty');
    // 未完成的行不把旧关系当当前值：当前字段为 null，旧值只在 historical 里。
    expect(detail!.prev_relation).toBeNull();
    expect(detail!.historical).toMatchObject({ derived_state: 'dirty', prev_relation: 'first' });
  } finally {
    f.close();
  }
});

test('会话分页命中时序索引且无临时排序', () => {
  const f = fixture();
  try {
    const convKey = JSON.stringify(['session', 'synthetic-plan']);
    seedRequests(f.store, convKey, 50);
    const plan = f.store.read.query(
      `EXPLAIN QUERY PLAN SELECT req_id, started_ms FROM request
       WHERE conv_key = ? AND (started_ms, req_id) < (?, ?)
       ORDER BY started_ms DESC, req_id DESC LIMIT 100`,
    ).all(convKey, 2_000_000_000_000, 999999) as { detail: string }[];
    const details = plan.map(row => row.detail).join(' | ');
    expect(details).toContain('i_req_session_time');
    expect(details).not.toContain('TEMP B-TREE');
  } finally {
    f.close();
  }
});

test('别名旧ID解析到canonical请求', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
         VALUES (10,'k',1,'2026-10-20','through','pending',0,3,1,1,'t','model_time')`,
      );
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (9,10)');
    });
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
         VALUES (11,'k',1,'2026-10-20','through','pending',0,3,1,1,'t2','model_time')`,
      );
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (8,11)');
    });
    expect(getRequest(f.store, 8)?.req_id).toBe(11);
    expect(getRequest(f.store, 9)?.req_id).toBe(10);
    expect(getRequest(f.store, 7)).toBeNull();
    expect(() => f.store.write(db => db.run('INSERT INTO request_alias(old_id,new_id) VALUES (5,9)'))).toThrow();
  } finally {
    f.close();
  }
});

test('暖查询100行本机目标低于100ms', () => {
  const f = fixture();
  try {
    const convKey = JSON.stringify(['session', 'synthetic-perf']);
    seedRequests(f.store, convKey, 1825, true);
    listRequests(f.store, convKey, 100, null);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      listRequests(f.store, convKey, 100, null);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p50).toBeLessThan(100);
    expect(p95).toBeLessThan(100);
  } finally {
    f.close();
  }
});

test('hook 拒绝按固定原因计数且不保留正文', async () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 1000);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token', {
      token: 'synthetic-hook-token', salt: new Uint8Array(32),
    }, metrics);
    const make = (body: string, headers: Record<string, string>) =>
      new Request('http://127.0.0.1:8320/hook/ingest', {
        method: 'POST', headers: { host: '127.0.0.1:8320', ...headers }, body,
      });
    const marker = 'REJECTED_BODY_MARKER';
    // 未认证最先拒绝，正文甚至不必是合法 JSON。
    expect((await handler(make(`{"marker":"${marker}"`, {
      authorization: 'Bearer wrong',
    }))).status).toBe(401);
    // 认证和来源通过后，语法错误才是 invalid_json。
    expect((await handler(make(`{"marker":"${marker}"`, {
      authorization: 'Bearer synthetic-hook-token',
    }))).status).toBe(400);
    // 合法 JSON、缺 hook_id：必须走 422，而不是被当成语法错误。
    expect((await handler(make(JSON.stringify({ marker, origin: 'local' }), {
      authorization: 'Bearer synthetic-hook-token',
    }))).status).toBe(422);
    expect((await handler(make(JSON.stringify({ marker, hook_id: 'h1', origin: 'local' }), {
      authorization: 'Bearer synthetic-hook-token', origin: 'http://evil.example',
    }))).status).toBe(403);
    const snapshot = metrics.ingest.snapshot(2000);
    expect(snapshot.rejected_by_reason.unauthorized).toBe(1);
    expect(snapshot.rejected_by_reason.invalid_json).toBe(1);
    expect(snapshot.rejected_by_reason.missing_hook_id).toBe(1);
    expect(snapshot.rejected_by_reason.origin).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('REJECTED_BODY_MARKER');
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('认证统计入口返回计数与启动时间，未认证返回 401', async () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 5000);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token', undefined, metrics);
    metrics.ingest.reject('busy');
    metrics.eventLoop.start();
    const denied = await handler(new Request('http://127.0.0.1:8320/api/ingest-metrics', {
      headers: { host: '127.0.0.1:8320' },
    }));
    expect(denied.status).toBe(401);
    const response = await handler(new Request('http://127.0.0.1:8320/api/ingest-metrics', {
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer synthetic-read-token' },
    }));
    metrics.eventLoop.stop();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.started_at_ms).toBe(5000);
    expect(body.ingest.rejected_by_reason.busy).toBe(1);
    expect(Object.keys(body).sort()).toContain('writer');
    expect(Object.keys(body).sort()).toContain('event_loop');
  } finally { f.close(); }
});

test('older 分页方向经 HTTP 校验，未知方向与游标混用返回 400', async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const key = encodeURIComponent(JSON.stringify(['session', 'older-http']));
    seedRequests(f.store, JSON.stringify(['session', 'older-http']), 4, true);
    const make = (query: string) => new Request(
      `http://127.0.0.1:8320/api/sessions/${key}/requests${query}`,
      { headers: { host: '127.0.0.1:8320', 'sec-fetch-site': 'same-origin' } });
    // 最近窗口：无游标 older 取最近一页，返回正序。
    const first = await handler(make('?direction=older&limit=3'));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.items.map((r: { req_id: number }) => r.req_id)).toEqual([2, 3, 4]);
    expect(body.next_cursor).toBeTruthy();
    // 未知方向不静默忽略。
    const bad = await handler(make('?direction=newest'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_direction' });
    // forward 旧二元游标不能混用于 older。
    const forwardCursor = Buffer.from(JSON.stringify([1_700_000_000_000, 2]), 'utf8').toString('base64url');
    const mixed = await handler(make('?direction=older&cursor=' + encodeURIComponent(forwardCursor)));
    expect(mixed.status).toBe(400);
    // 其它会话的 older 游标拒绝。
    const otherSession = await handler(make('?direction=older&limit=2'));
    const otherCursor = (await otherSession.json()).next_cursor as string;
    const otherKey = encodeURIComponent(JSON.stringify(['session', 'another']));
    const stolen = await handler(new Request(
      `http://127.0.0.1:8320/api/sessions/${otherKey}/requests?direction=older&cursor=${encodeURIComponent(otherCursor)}`,
      { headers: { host: '127.0.0.1:8320', 'sec-fetch-site': 'same-origin' } }));
    expect(stolen.status).toBe(400);
    // 非法 limit 与非安全整数游标。
    expect((await handler(make('?direction=older&limit=0'))).status).toBe(400);
    const badCursor = Buffer.from(JSON.stringify(['older', JSON.stringify(['session', 'older-http']), 1.5, 1]), 'utf8').toString('base64url');
    expect((await handler(make('?direction=older&cursor=' + encodeURIComponent(badCursor)))).status).toBe(400);
  } finally { f.close(); }
});
