import { expect, test } from 'bun:test';
import { auxSummary, createReader, isAuxRow, purposeLabel, resolveTraceTarget } from '../web/app.js';

test('较慢的旧详情不覆盖新选择', async () => {
  let finishFirst!: (response: Response) => void;
  const fetcher = async (url: string): Promise<Response> => {
    if (url.endsWith('/1')) return new Promise<Response>(resolve => { finishFirst = resolve; });
    return Response.json({ req_id: 2, title: 'second', body_state: 'pending', have: 2 });
  };
  const reader = createReader(fetcher);
  const first = reader.selectRequest(1);
  await reader.selectRequest(2);
  finishFirst(Response.json({ req_id: 1, title: 'first', body_state: 'pending', have: 2 }));
  await first;
  const request = reader.getState().request;
  if (request === null) throw new Error('missing_request');
  expect(request.req_id).toBe(2);
});

test('旧会话的请求页不覆盖新会话', async () => {
  let finishOld!: (response: Response) => void;
  const fetcher = async (url: string): Promise<Response> => {
    if (url.includes('old')) return new Promise<Response>(resolve => { finishOld = resolve; });
    return Response.json({ items: [{ req_id: 9, conv_key: 'new', title: 'n' }], next_cursor: null });
  };
  const reader = createReader(fetcher);
  const oldLoad = reader.selectSession('old');
  await reader.selectSession('new');
  finishOld(Response.json({ items: [{ req_id: 1, conv_key: 'old', title: 'o' }], next_cursor: null }));
  await oldLoad;
  const state = reader.getState();
  expect(state.sessionKey).toBe('new');
  expect(state.requests.map(row => row.req_id)).toEqual([9]);
});

test('分页追加去重并保留已加载行', async () => {
  let page = 0;
  const fetcher = async (): Promise<Response> => {
    page += 1;
    return Response.json(page === 1
      ? { items: [{ req_id: 1, conv_key: 'k', title: 'a' }], next_cursor: 'c1' }
      : { items: [{ req_id: 1, conv_key: 'k', title: 'a' }, { req_id: 2, conv_key: 'k', title: 'b' }], next_cursor: null });
  };
  const reader = createReader(fetcher);
  await reader.selectSession('k');
  await reader.loadRequests('c1');
  expect(reader.getState().requests.map(row => row.req_id)).toEqual([1, 2]);
  expect(reader.getState().requestsCursor).toBeNull();
});

test('请求失败时进入error状态不用旧详情冒充', async () => {
  let call = 0;
  const fetcher = async (): Promise<Response> => {
    call += 1;
    if (call === 1) return Response.json({ req_id: 5, title: 'ok', body_state: 'pending', have: 2 });
    return new Response('boom', { status: 500 });
  };
  const reader = createReader(fetcher);
  await reader.selectRequest(5);
  await reader.selectRequest(6);
  const state = reader.getState();
  expect(state.requestState).toBe('error');
  expect(state.error).toBe('http_500');
  expect(state.request?.req_id).toBe(5);
});

test('未选择会话时加载请求不发网络请求', async () => {
  let calls = 0;
  const fetcher = async (): Promise<Response> => {
    calls += 1;
    return Response.json({ items: [], next_cursor: null });
  };
  const reader = createReader(fetcher);
  await reader.loadRequests();
  expect(calls).toBe(0);
});

test('请求列表失败留下可见错误而不是空表', async () => {
  const fetcher = async (): Promise<Response> => new Response('boom', { status: 500 });
  const reader = createReader(fetcher);
  await reader.selectSession('k');
  expect(reader.getState().requestsError).toBe('http_500');
  expect(reader.getState().requests).toEqual([]);
});

test('分页失败保留已加载行并记录错误', async () => {
  let page = 0;
  const fetcher = async (): Promise<Response> => {
    page += 1;
    if (page === 1) return Response.json({ items: [{ req_id: 1, conv_key: 'k', title: 'a' }], next_cursor: 'c1' });
    return new Response('boom', { status: 503 });
  };
  const reader = createReader(fetcher);
  await reader.selectSession('k');
  await reader.loadRequests('c1');
  const state = reader.getState();
  expect(state.requests.map(row => row.req_id)).toEqual([1]);
  expect(state.requestsError).toBe('http_503');
  expect(state.requestsCursor).toBe('c1');
});

test('已回收正文显示原因而不是空对话', async () => {
  const fake = async (url: string): Promise<Response> => Response.json(url.includes('/body')
    ? {
      state: 'evicted', parse_state: 'ok', reply_state: 'ok', from: 0, to: 0, total: 80,
      messages: [], request_fields: null, reply: null, reason: 'budget',
    }
    : { req_id: 1, title: 'history', body_state: 'evicted', have: 7 });
  const reader = createReader(fake);
  await reader.selectRequest(1);
  const page = await reader.loadBody(1, 0);
  expect(page.state).toBe('evicted');
  expect(page.reason).toBe('budget');
});

test('loadBody按40条请求区间且不改动当前选择', async () => {
  const urls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url.includes('/body')) {
      return Response.json({
        state: 'available', parse_state: 'ok', reply_state: 'ok', from: 40, to: 80,
        total: 90, messages: [{ ord: 40, value: { role: 'user', content: 'm40' } }],
        request_fields: null, reply: null, reason: null,
      });
    }
    return Response.json({ req_id: 1, title: 't', body_state: 'available', have: 7 });
  };
  const reader = createReader(fetcher);
  await reader.selectRequest(1);
  const page = await reader.loadBody(1, 40);
  expect(page.messages.map(m => m.ord)).toEqual([40]);
  expect(urls).toContain('/api/requests/1/body?from=40&to=80');
  // 正文只有显式调用才下载：选中会话与请求本身都不触发正文请求。
  urls.length = 0;
  await reader.selectSession('k');
  await reader.selectRequest(2);
  expect(urls.some(url => url.includes('/body'))).toBe(false);
});

test('换会话后清掉上一个会话的错误', async () => {
  const fetcher = async (url: string): Promise<Response> =>
    url.includes('bad') ? new Response('boom', { status: 500 })
      : Response.json({ items: [{ req_id: 7, conv_key: 'good', title: 'g' }], next_cursor: null });
  const reader = createReader(fetcher);
  await reader.selectSession('bad');
  expect(reader.getState().requestsError).toBe('http_500');
  await reader.selectSession('good');
  expect(reader.getState().requestsError).toBeNull();
  expect(reader.getState().requests.map(row => row.req_id)).toEqual([7]);
});

test('合并后的旧 id 跳到 canonical 而不是报未在已加载页', async () => {
  const rows = [{ req_id: 5 }, { req_id: 9 }];
  expect(resolveTraceTarget(rows, 9, { req_id: 9 })).toEqual({ kind: 'in-page', reqId: 9 });
  // 旧 id 7 已合并到 9，且 9 就在已加载页里。
  expect(resolveTraceTarget(rows, 7, { req_id: 9 })).toEqual({ kind: 'canonical', reqId: 9 });
  // canonical 落在更早的页里：仍然只能提示继续加载。
  expect(resolveTraceTarget(rows, 7, { req_id: 3 })).toEqual({ kind: 'off-page', reqId: null });
  // 库里没有：未找到。
  expect(resolveTraceTarget(rows, 7, null)).toEqual({ kind: 'missing', reqId: null });
});

test('辅助行只由派生用途决定', () => {
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main' })).toBe(false);
  expect(isAuxRow({ purpose_chain: 'exclude', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({
    purpose_chain: 'participate', chain_role: 'main',
    req_kind: 'chat', reply_preview: '标题 · 普通内容',
  })).toBe(false);
});

test('未知用途保留原始 ID', () => {
  expect(purposeLabel('source:compaction')).toBe('source:compaction');
  expect(purposeLabel('title')).toBe('标题生成');
  expect(purposeLabel('auto-mode-classifier')).toBe('自动模式分类');
});

test('分类器摘要显示判定', () => {
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<block>no',
  })).toBe('自动模式分类 · 放行');
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<block>yes',
  })).toBe('自动模式分类 · 拦截');
  expect(auxSummary({
    req_kind: 'auto-mode-classifier', reply_preview: '<transcript>',
  })).toBe('自动模式分类 · 判定未知');
});
