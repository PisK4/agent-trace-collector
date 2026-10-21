import { expect, test } from 'bun:test';
import { createReader } from '../web/app.js';

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
