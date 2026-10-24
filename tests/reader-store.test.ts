import { expect, test } from 'bun:test';
import { createReaderStore } from '../web/reader-store.js';

const TOKEN = 'r1-' + 'a'.repeat(64);
const TOKEN2 = 'r1-' + 'b'.repeat(64);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function bodyPage(from: number, to: number, total: number | null, extra: Record<string, unknown> = {}) {
  const messages = [];
  for (let ord = from; ord < Math.min(to, total ?? to); ord += 1) {
    messages.push({ ord, value: { role: 'user', content: `m${ord}` } });
  }
  return {
    state: 'available', parse_state: 'parsed', reply_state: 'parsed',
    from, to, total, messages,
    request_fields: from === 0 ? { model: 'synth' } : null,
    reply: from === 0 ? { content: [{ type: 'text', text: 'reply' }] } : null,
    reason: null,
    interpretations: messages.map(m => ({ ord: m.ord, role: 'user', role_state: 'known', input: null, is_input: false })),
    coverage: { from, to, total, complete: true, loaded_complete: false, reason: 'available' },
    capabilities: { tools: { state: 'empty', items: [], reason: null }, skills: { state: 'present', items: [], reason: null }, coverage: { complete: true, reason: 'available', from, to, total }, agent: null },
    ...extra,
  };
}

function detail(id: number, extra: Record<string, unknown> = {}) {
  return {
    req_id: id, conv_key: 'k', actor: 'a', agent: null, actor_state: 'known', started_ms: id,
    title: `t${id}`, title_source: null, status: 200, model_requested: null, model_served: 'm',
    in_tok: 1, out_tok: 1, cache_read: null, cache_write: null, cost: null, cost_state: 'absent', have: 7,
    ms: 1, ttft_ms: 1, flow_ms: 1, body_state: 'available', miss_reason: null,
    input_preview: null, input_preview_kind: null, reply_preview: null,
    req_kind: 'chat', chain_role: 'main', model_title: null,
    purpose_status: 'selected', purpose_version: 1, purpose_rule: null, purpose_chain: 'participate',
    derived_state: 'current', reading_token: TOKEN,
    prev_req_id: null, prev_relation: 'first', delta_ordinals: null,
    parse_state: 'parsed', reply_state: 'parsed',
    first_text_ms: null, reasoning: null, prompt_tokens: null, prompt_counted: null,
    prompt_window: null, prompt_turns: null, parts: null,
    attempt_count: null, attempt_billed: null, attempt_in: null, attempt_out: null,
    attempt_cache_read: null, attempt_cache_write: null, attempt_reasoning: null,
    attempt_cost: null, attempt_cost_state: 'absent',
    summary_state: 'recomputed', summary_algorithm: 1, summary_basis: null,
    derive_version: 1, archive: null, route_state: 'absent', model_provider: null,
    source_facts: {}, projection_meta: {}, prompt: {},
    derivation: { state: 'clean', chain_state: 'current', summary_state: 'current', reason: null },
    tool_calls: [], historical: null,
    ...extra,
  };
}

type Handler = (url: string, count: number) => Response | Promise<Response>;

/** 注入 fetch：记录 URL、可按需延迟，并统计最大并发。 */
function harness(handler: Handler) {
  const urls: string[] = [];
  const counts = new Map<string, number>();
  let inflight = 0;
  let maxInflight = 0;
  const fetcher = async (url: string): Promise<Response> => {
    const key = url.replace(/([?&])if_reading=[^&]*/, '$1if_reading=T');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    urls.push(url);
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      return await handler(url, counts.get(key)!);
    } finally {
      inflight -= 1;
    }
  };
  return { fetcher, urls, count: (needle: string) => urls.filter(u => u.includes(needle)).length, maxInflight: () => maxInflight };
}

const respond = (value: unknown, status = 200) => Response.json(value, { status });

test('窗口选择、元信息读取与并发去重的 fetch 序列', async () => {
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) {
      return respond({ items: [1, 2, 3].map(id => ({ req_id: id, started_ms: id })), next_cursor: 'c1' });
    }
    if (url.endsWith('/api/requests/1')) return respond(detail(1));
    if (url.includes('/api/requests/1/body?from=0&to=0')) return respond(bodyPage(0, 0, 45));
    if (url.includes('/api/requests/1/body?from=0&to=40')) return respond(bodyPage(0, 40, 45));
    if (url.includes('/api/requests/1/body?from=40&to=45')) return respond(bodyPage(40, 45, 45));
    if (url.includes('/api/requests/1/body?from=44&to=45')) return respond(bodyPage(44, 45, 45));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  const window = store.getWindow();
  expect(window.requests.map(r => r.req_id)).toEqual([1, 2, 3]);
  expect(window.olderCursor).toBe('c1');
  // 详情 + 元信息各一次。
  const read = await store.readRequest(1);
  expect(read.detail?.req_id).toBe(1);
  expect(read.meta?.reply).not.toBeNull();
  expect(h.urls.filter(u => u.endsWith('/api/requests/1')).length).toBe(1);
  expect(h.count('/body?from=0&to=0')).toBe(1);
  // 相同 (id,token,from,to) 并发只发一次；URL 精确区分区间与版本。
  await Promise.all([store.readRange(1, 44, 45), store.readRange(1, 44, 45)]);
  expect(h.urls.filter(u => u.includes('/body?from=44&to=45')).length).toBe(1);
  expect(h.urls.find(u => u.includes('/body?from=44&to=45'))).toContain('if_reading=' + TOKEN);
  // 结构 40+5 分页；定点读 44 不推进连续历史上界。
  await store.loadStructure(1);
  await store.loadStructure(1);
  const after = await store.readRequest(1);
  expect(after.structure.ords).toEqual(Array.from({ length: 45 }, (_, i) => i));
  expect(after.structure.next).toBe(45);
  expect(h.count('/body?from=0&to=40')).toBe(1);
  expect(h.count('/body?from=40&to=45')).toBe(1);
});

test('503 与空页时旧窗口、游标与已读内容保留', async () => {
  let earlierFails = true;
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) {
      if (!url.includes('cursor=')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: 'c1' });
      return earlierFails ? respond({ error: 'unavailable' }, 503) : respond({ items: [{ req_id: 0, started_ms: 0 }], next_cursor: null });
    }
    if (url.endsWith('/api/requests/1')) return respond(detail(1));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 5));
    if (url.includes('/body?from=0&to=40')) return respond(bodyPage(0, 40, 5));
    if (url.includes('/body?from=0&to=1')) return respond(bodyPage(0, 1, 5));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  await store.loadEarlier();
  const failed = store.getWindow();
  expect(failed.requests.map(r => r.req_id)).toEqual([1]);
  expect(failed.olderCursor).toBe('c1');
  expect(failed.error).toBe('http_503');
  // 恢复后重试成功，去重排序。
  earlierFails = false;
  await store.loadEarlier();
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([0, 1]);
  expect(store.getWindow().error).toBeNull();
});

test('409 整笔作废后普通读取走网络重建，并重取回复元信息', async () => {
  let bodyStatus = 200;
  let detailToken = TOKEN;
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) {
      return respond({ items: url.includes('%22k%22') || url.includes('/k/requests') || url.includes("'k'")
        ? [{ req_id: 1, started_ms: 1 }] : [{ req_id: 9, started_ms: 9 }], next_cursor: null });
    }
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: detailToken }));
    if (url.includes('/api/requests/1/body')) {
      return bodyStatus === 409 ? respond({ error: 'reading_changed' }, 409) : respond(bodyPage(0, 0, 3));
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  bodyStatus = 409;
  await expect(store.readRange(1, 1, 2)).rejects.toThrow('reading_changed');
  // 整笔已作废：普通读取（不带 validate）也要重新走详情，并重取 0/0 元信息。
  bodyStatus = 200;
  detailToken = TOKEN2;
  const rebuilt = await store.readRequest(1);
  expect(rebuilt.token).toBe(TOKEN2);
  expect(h.urls.filter(u => u.endsWith('/api/requests/1')).length).toBe(2);
  expect(h.count('/body?from=0&to=0')).toBe(2);
});

test('token变化重新读取回复元信息', async () => {
  let token = TOKEN;
  const h = harness(url => {
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: token }));
    return respond(bodyPage(0, 0, 0, {
      request_fields: { system: token === TOKEN ? 'old-system' : 'new-system' },
      reply: { content: [{ type: 'text', text: token === TOKEN ? 'old' : 'new' }] },
    }));
  });
  const store = createReaderStore(h.fetcher);
  await store.readRequest(1);
  token = TOKEN2;
  const next = await store.readRequest(1, true);
  expect(next.meta?.request_fields).toEqual({ system: 'new-system' });
  expect(next.meta?.reply).toEqual({ content: [{ type: 'text', text: 'new' }] });
  expect(h.count('/body?from=0&to=0')).toBe(2);
});

test('旧请求的迟到409不能清除已重建的新缓存', async () => {
  let token = TOKEN;
  let rangeCalls = 0;
  let release409: (value: Response) => void = () => {};
  const gated409 = new Promise<Response>(resolve => { release409 = resolve; });
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: token }));
    if (url.includes('/body?from=1&to=2')) {
      rangeCalls += 1;
      return rangeCalls === 1 ? gated409 : respond(bodyPage(1, 2, 3));
    }
    if (url.includes('/body?from=0&to=0')) {
      return respond(bodyPage(0, 0, 3, { request_fields: { system: token === TOKEN ? 'old' : 'new' } }));
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const stale = store.readRange(1, 1, 2);
  await delay(5);
  // 旧请求还挂着时版本重建：新缓存来自 validate 读取。
  token = TOKEN2;
  await store.readRequest(1, true);
  release409(respond({ error: 'reading_changed' }, 409));
  await expect(stale).rejects.toThrow('reading_changed');
  // 旧 409 已迟到：新缓存原样保留，普通读取不再走网络。
  const kept = await store.readRequest(1);
  expect(kept.meta?.request_fields).toEqual({ system: 'new' });
  expect(h.urls.filter(u => u.endsWith('/api/requests/1')).length).toBe(2);
});

test('invalidate 后迟到的详情响应不作为可用快照返回', async () => {
  let detailCalls = 0;
  let release: (value: Response) => void = () => {};
  const gated = new Promise<Response>(resolve => { release = resolve; });
  const h = harness(url => {
    if (url.endsWith('/api/requests/1')) {
      detailCalls += 1;
      return detailCalls === 1 ? gated : respond(detail(1));
    }
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  const pending = store.readRequest(1);
  await delay(5);
  store.invalidate(1);
  release(respond(detail(1)));
  await expect(pending).rejects.toThrow('reading_changed');
  // 之后普通读取重新走网络并成功。
  const next = await store.readRequest(1);
  expect(next.detail?.req_id).toBe(1);
  expect(h.urls.filter(u => u.endsWith('/api/requests/1')).length).toBe(2);
});

test('validate 等待在跑的详情读取完成后再拉一次', async () => {
  let detailCalls = 0;
  let release: (value: Response) => void = () => {};
  const gated = new Promise<Response>(resolve => { release = resolve; });
  let token = TOKEN;
  const h = harness(url => {
    if (url.endsWith('/api/requests/1')) {
      detailCalls += 1;
      if (detailCalls === 1) return gated;
      return respond(detail(1, { reading_token: token }));
    }
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  const first = store.readRequest(1);
  await delay(5);
  const second = store.readRequest(1, true);
  await delay(5);
  release(respond(detail(1, { reading_token: TOKEN })));
  // 第二次详情请求在旧读取结束后立刻发出：换版本要在释放前生效。
  token = TOKEN2;
  // 旧 plain 读取的元信息响应晚于版本切换：回写校验拒绝，不把旧片写进新版本。
  await expect(first).rejects.toThrow('reading_changed');
  const validated = await second;
  expect(validated.token).toBe(TOKEN2);
  expect(h.urls.filter(u => u.endsWith('/api/requests/1')).length).toBe(2);
});

test('迟到详情不更新新窗口，旧 token 的迟到结果不写入', async () => {
  const releaseDetail = (() => { let resolve: (v: Response) => void = () => {}; const p = new Promise<Response>(r => { resolve = r; }); return { promise: p, resolve }; })();
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) {
      const key = decodeURIComponent(url.split('/api/sessions/')[1]?.split('/requests')[0] ?? '');
      return respond({ items: key === 'old' ? [{ req_id: 1, started_ms: 1 }] : [{ req_id: 7, started_ms: 7 }], next_cursor: null });
    }
    if (url.endsWith('/api/requests/1')) return releaseDetail.promise;
    if (url.endsWith('/api/requests/7')) return respond(detail(7));
    if (url.includes('/api/requests/7/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  const pending = store.selectSession('old', 30);
  await delay(10);
  await store.selectSession('new', 30);
  releaseDetail.resolve(respond(detail(1)));
  await pending;
  // 旧会话迟到响应不能改写新窗口。
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([7]);
  expect(store.getWindow().sessionKey).toBe('new');
});

test('工具结果按 owner 与调用序号分别缓存，失败保留到重试成功', async () => {
  let ord1Fails = true;
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) {
      return respond(detail(1, { tool_calls: [
        { call_id: 'a', ord: 0, tool_name: 'read', result_req: 2, result_ord: 1, result_path: 'request.messages[1].content[0]', state: 'resolved' },
        { call_id: 'b', ord: 1, tool_name: 'read', result_req: 2, result_ord: 1, result_path: 'request.messages[1].content[1]', state: 'resolved' },
      ] }));
    }
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    if (url.includes('/tools/0/result')) return respond({ owner_req: 1, call_ord: 0, state: 'available', target: { req_id: 2, ord: 1, path: 'p0' }, content: 'first', is_error: null, reason: null, reading_token: TOKEN });
    if (url.includes('/tools/1/result')) {
      if (ord1Fails) return respond({ error: 'unavailable' }, 503);
      return respond({ owner_req: 1, call_ord: 1, state: 'available', target: { req_id: 2, ord: 1, path: 'p1' }, content: 'second', is_error: true, reason: null, reading_token: TOKEN });
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  // resolved 不等于已读：未发起读取前没有结果网络请求。
  expect(h.count('/tools/')).toBe(0);
  const first = await store.readToolResult(1, 0);
  expect(first.content).toBe('first');
  // 再次读取同一调用命中缓存。
  await store.readToolResult(1, 0);
  expect(h.count('/tools/0/result')).toBe(1);
  // 失败保留，重试成功后替换。
  await expect(store.readToolResult(1, 1)).rejects.toThrow();
  expect(h.count('/tools/1/result')).toBe(1);
  ord1Fails = false;
  const retried = await store.readToolResult(1, 1);
  expect(retried.content).toBe('second');
  expect(retried.is_error).toBe(true);
  expect(h.count('/tools/1/result')).toBe(2);
});

test('工具结果 409 后整笔作废，重建读取换新 token 重取', async () => {
  let toolStatus = 200;
  let token = TOKEN;
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: token }));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    if (url.includes('/tools/0/result')) {
      return toolStatus === 409
        ? respond({ error: 'reading_changed' }, 409)
        : respond({ owner_req: 1, call_ord: 0, state: 'available', target: { req_id: 2, ord: 1, path: 'p' }, content: 'ok', is_error: null, reason: null, reading_token: token });
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  toolStatus = 409;
  await expect(store.readToolResult(1, 0)).rejects.toThrow('reading_changed');
  // 409 已整笔作废：普通读取重建详情并换新 token，再读工具结果走网络。
  toolStatus = 200;
  token = TOKEN2;
  await store.readRequest(1);
  const again = await store.readToolResult(1, 0);
  expect(again.content).toBe('ok');
  expect(h.count('/tools/0/result')).toBe(2);
  const secondUrl = h.urls.filter(u => u.includes('/tools/0/result'))[1];
  expect(secondUrl).toContain('if_reading=' + TOKEN2);
});

test('迟到的工具结果不写入已换版本的请求', async () => {
  let toolCalls = 0;
  let release: ((value: Response) => void) | null = null;
  const gated = new Promise<Response>(resolve => { release = resolve; });
  let token = TOKEN;
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: token }));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 1));
    if (url.includes('/tools/0/result')) {
      toolCalls += 1;
      return toolCalls === 1 ? gated : respond({ owner_req: 1, call_ord: 0, state: 'available', target: null, content: 'fresh', is_error: null, reason: null, reading_token: token });
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const stale = store.readToolResult(1, 0);
  await delay(5);
  // 请求换版本后再次读取：新 cache 键，立即发第二个请求。
  token = TOKEN2;
  await store.readRequest(1, true);
  const fresh = store.readToolResult(1, 0);
  await delay(5);
  release!(respond({ owner_req: 1, call_ord: 0, state: 'available', target: null, content: 'stale', is_error: null, reason: null, reading_token: TOKEN }));
  await expect(stale).rejects.toThrow('reading_changed');
  const ok = await fresh;
  expect(ok.content).toBe('fresh');
  expect(toolCalls).toBe(2);
});

test('delta 分片消费与未确认关系不读消息', async () => {
  const h = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { delta_ordinals: [0, 1, 2, 80, 81] }));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 82));
    if (url.includes('/body?from=0&to=3')) return respond(bodyPage(0, 3, 82));
    if (url.includes('/body?from=80&to=82')) return respond(bodyPage(80, 82, 82));
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const read = await store.loadDelta(1, 2);
  expect(read.delta.next).toBe(5);
  expect(read.delta.done).toBe(true);
  expect(h.count('/body?from=0&to=3')).toBe(1);
  expect(h.count('/body?from=80&to=82')).toBe(1);
  // delta = []：立即完成，不读消息。
  const h2 = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 2, started_ms: 2 }], next_cursor: null });
    if (url.endsWith('/api/requests/2')) return respond(detail(2, { delta_ordinals: [] }));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 3));
    return respond({ error: 'not_found' }, 404);
  });
  const store2 = createReaderStore(h2.fetcher);
  await store2.selectSession('k', 30);
  await store2.readRequest(2);
  const read2 = await store2.loadDelta(2);
  expect(read2.delta.done).toBe(true);
  expect(read2.delta.unconfirmed).toBeFalsy();
  expect(h2.urls.filter(u => u.includes('/body?from=')).length).toBe(1);
  // delta = null：未确认，不读消息。
  const h3 = harness(url => {
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 3, started_ms: 3 }], next_cursor: null });
    if (url.endsWith('/api/requests/3')) return respond(detail(3, { delta_ordinals: null, prev_relation: 'unknown' }));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 3));
    return respond({ error: 'not_found' }, 404);
  });
  const store3 = createReaderStore(h3.fetcher);
  await store3.selectSession('k', 30);
  await store3.readRequest(3);
  const read3 = await store3.loadDelta(3);
  expect(read3.delta.unconfirmed).toBe(true);
  expect(read3.delta.done).toBe(true);
  expect(h3.urls.filter(u => u.includes('/body?from=') && !u.includes('to=0')).length).toBe(0);
});

test('共享网络队列并发不超过 4', async () => {
  const h = harness(async url => {
    await delay(15);
    if (url.includes('/requests?direction=older')) return respond({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null });
    if (url.endsWith('/api/requests/1')) return respond(detail(1));
    if (url.includes('/body?from=0&to=0')) return respond(bodyPage(0, 0, 60));
    if (/\/body\?from=\d+&to=\d+/.test(url)) {
      const from = Number(/from=(\d+)/.exec(url)![1]);
      const to = Number(/to=(\d+)/.exec(url)![1]);
      return respond(bodyPage(from, to, 60));
    }
    return respond({ error: 'not_found' }, 404);
  });
  const store = createReaderStore(h.fetcher);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.readRange(1, i * 5 + 1, i * 5 + 6)));
  expect(h.maxInflight()).toBeLessThanOrEqual(4);
});
