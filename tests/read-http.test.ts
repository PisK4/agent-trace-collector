import { expect, test } from 'bun:test';
import { createHttpReadTransport } from '../web/read-http.js';

/** 注入式 fetcher：记录 URL 与 signal，按队列回放响应或异常。 */
function scriptedFetch(
  script: Array<{ url?: string; status?: number; body?: unknown; raw?: string; throw?: Error }>,
): { fetcher: typeof fetch; calls: { url: string; signal: AbortSignal | null; headers: Record<string, string> }[] } {
  const calls: { url: string; signal: AbortSignal | null; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: unknown, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
    const step = script[calls.length] ?? {};
    calls.push({
      url: String(url),
      signal: init?.signal ?? null,
      headers: init?.headers ?? {},
    });
    if (step.throw !== undefined) throw step.throw;
    if (step.url !== undefined) expect(String(url)).toBe(step.url);
    const text = step.raw
      ?? JSON.stringify(step.body === undefined ? { items: [], next_cursor: null } : step.body);
    return new Response(text, { status: step.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('编码会话键并把取消传到 fetcher', async () => {
  const controller = new AbortController();
  const { fetcher, calls } = scriptedFetch([{}]);
  const transport = createHttpReadTransport({ fetcher });
  await transport.execute('requests', { key: 'a/b', limit: 30,
    direction: 'forward', cursor: null }, { signal: controller.signal });
  expect(calls[0]!.url).toBe('/api/sessions/a%2Fb/requests?direction=forward&limit=30');
  expect(calls[0]!.signal).toBe(controller.signal);
});

test('游标与会话键一起编码，null 参数不进 URL', async () => {
  const { fetcher, calls } = scriptedFetch([{}]);
  const transport = createHttpReadTransport({ fetcher });
  await transport.execute('sessions', { limit: 20, cursor: 'x+y/z' }, { signal: new AbortController().signal });
  expect(calls[0]!.url).toBe('/api/sessions?limit=20&cursor=x%2By%2Fz');
  await transport.execute('turns', { key: 'k', from: null }, { signal: new AbortController().signal });
  expect(calls[1]!.url).toBe('/api/sessions/k/turns');
  await transport.execute('turns', { key: 'k', from: 7 }, { signal: new AbortController().signal });
  expect(calls[2]!.url).toBe('/api/sessions/k/turns?from=7');
});

test('批次输入编码为 JSON 查询参数', async () => {
  const token = 'r1-' + 'a'.repeat(64);
  const bundle = (id: number) => ({
    detail: { req_id: id, reading_token: token },
    meta: { req_id: id, reading_token: token },
  });
  const { fetcher, calls } = scriptedFetch([
    { body: { items: [
      { index: 0, requested_id: 1, state: 'ok', value: bundle(1) },
      { index: 1, requested_id: 2, state: 'ok', value: bundle(2) },
    ], next_index: null } },
    { body: { items: [{ index: 0, requested_id: 3, state: 'ok',
      value: { req_id: 3, reading_token: token } }], next_index: null } },
  ]);
  const transport = createHttpReadTransport({ fetcher });
  await transport.execute('readings', { key: 'k', ids: [1, 2] }, { signal: new AbortController().signal });
  await transport.execute('bodyRanges', { key: 'k',
    ranges: [{ id: 3, token, from: 0, to: 40 }] },
  { signal: new AbortController().signal });
  expect(calls[0]!.url).toBe(`/api/sessions/k/readings?ids=${encodeURIComponent('[1,2]')}`);
  expect(calls[1]!.url).toBe(`/api/sessions/k/reading-ranges?items=${
    encodeURIComponent(JSON.stringify([{ id: 3, token, from: 0, to: 40 }]))}`);
});

test('汇总条目按判别 kind 编码', async () => {
  const { fetcher, calls } = scriptedFetch([{}, {}, {}]);
  const transport = createHttpReadTransport({ fetcher });
  await transport.execute('summaryEntries', { key: 'k', query: { kind: 'tool', name: 'Bash' } },
    { signal: new AbortController().signal });
  await transport.execute('summaryEntries', { key: 'k', query: { kind: 'read', path: '/a/b' } },
    { signal: new AbortController().signal });
  await transport.execute('summaryEntries', { key: 'k', query: { kind: 'interrupts' } },
    { signal: new AbortController().signal });
  expect(calls[0]!.url).toBe('/api/sessions/k/summary/entries?kind=tool&name=Bash');
  expect(calls[1]!.url).toBe('/api/sessions/k/summary/entries?kind=read&path=%2Fa%2Fb');
  expect(calls[2]!.url).toBe('/api/sessions/k/summary/entries?kind=interrupts');
});

test('正文与工具结果携带阅读 token，上下文目录带 kind 查询', async () => {
  const token = 'r1-' + 'a'.repeat(64);
  const { fetcher, calls } = scriptedFetch([
    { body: { req_id: 9, reading_token: token } },
    { body: { owner_req: 9, call_ord: 2, reading_token: token, state: 'available' } },
    { body: { req_id: 9, reading_token: token, entries: [] } },
  ]);
  const transport = createHttpReadTransport({ fetcher });
  await transport.execute('body', { id: 9, token, from: 0, to: 40 }, { signal: new AbortController().signal });
  await transport.execute('toolResult', { id: 9, ord: 2, token }, { signal: new AbortController().signal });
  await transport.execute('contextItem', { id: 9, token, query: { kind: 'files', name: '/x', tag: null, cursor: null } },
    { signal: new AbortController().signal });
  expect(calls[0]!.url).toBe(`/api/requests/9/body?from=0&to=40&if_reading=${token}`);
  expect(calls[1]!.url).toBe(`/api/requests/9/tools/2/result?if_reading=${token}`);
  expect(calls[2]!.url).toBe(`/api/requests/9/context-item?kind=files&name=%2Fx&if_reading=${token}`);
});

test('headers 提供函数每次调用注入凭证', async () => {
  let round = 0;
  const { fetcher, calls } = scriptedFetch([{}, {}]);
  const transport = createHttpReadTransport({
    fetcher,
    baseUrl: 'http://127.0.0.1:8320',
    headers: () => ({ authorization: `Bearer t${round += 1}` }),
  });
  const signal = new AbortController().signal;
  await transport.execute('stats', {}, { signal });
  await transport.execute('stats', {}, { signal });
  expect(calls[0]!.url).toBe('http://127.0.0.1:8320/api/stats');
  expect(calls[0]!.headers).toEqual({ authorization: 'Bearer t1' });
  expect(calls[1]!.headers).toEqual({ authorization: 'Bearer t2' });
});

test('HTTP 状态映射为稳定错误码并保留 status', async () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 400, code: 'invalid_input' },
    { status: 401, code: 'unauthorized' },
    { status: 403, code: 'forbidden' },
    { status: 404, code: 'not_found' },
    { status: 409, code: 'reading_changed' },
    { status: 500, code: 'unavailable' },
    { status: 503, code: 'unavailable' },
  ];
  for (const { status, code } of cases) {
    const { fetcher } = scriptedFetch([{ body: { error: 'x' }, status }]);
    const transport = createHttpReadTransport({ fetcher });
    try {
      await transport.execute('detail', { id: 1 }, { signal: new AbortController().signal });
      throw new Error(`status ${status} 应当拒绝`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
      expect((error as { status?: number }).status).toBe(status);
      expect((error as Error).message).not.toContain('x');
    }
  }
});

test('网络失败映射 unavailable，畸形 JSON 映射 invalid_response', async () => {
  const network = scriptedFetch([{ throw: new TypeError('load failed') }]);
  const transport = createHttpReadTransport({ fetcher: network.fetcher });
  try {
    await transport.execute('stats', {}, { signal: new AbortController().signal });
    throw new Error('网络失败应当拒绝');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('unavailable');
  }

  const broken = scriptedFetch([{ raw: '{not json' }]);
  const brokenTransport = createHttpReadTransport({ fetcher: broken.fetcher });
  try {
    await brokenTransport.execute('stats', {}, { signal: new AbortController().signal });
    throw new Error('畸形 JSON 应当拒绝');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('invalid_response');
  }
});

test('fetcher 返回但信号已取消时拒绝 cancelled', async () => {
  const controller = new AbortController();
  const { fetcher } = scriptedFetch([{ body: { items: [] } }]);
  const transport = createHttpReadTransport({ fetcher });
  const pending = transport.execute('sessions', { limit: 1, cursor: null }, { signal: controller.signal });
  controller.abort();
  try {
    await pending;
    throw new Error('取消后应当拒绝');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('cancelled');
  }
});

test('批次响应校验 index 对应、身份一致与覆盖完整性', async () => {
  const token = 'r1-' + 'a'.repeat(64);
  const okBundle = {
    detail: { req_id: 1, reading_token: token },
    meta: { req_id: 1, reading_token: token },
  };
  const cases: unknown[] = [
    // index 越界
    { items: [{ index: 5, requested_id: 1, state: 'ok', value: okBundle }], next_index: null },
    // requested_id 与输入不对应
    { items: [{ index: 0, requested_id: 9, state: 'ok', value: okBundle }], next_index: null },
    // index 重复
    { items: [
      { index: 0, requested_id: 1, state: 'ok', value: okBundle },
      { index: 0, requested_id: 2, state: 'ok', value: okBundle },
    ], next_index: null },
    // 成功项 detail/meta 身份不一致
    { items: [{ index: 0, requested_id: 1, state: 'ok', value: {
      detail: { req_id: 1, reading_token: token },
      meta: { req_id: 2, reading_token: token },
    } }], next_index: null },
    // 失败项缺 reason
    { items: [{ index: 0, requested_id: 1, state: 'not_found' }], next_index: null },
    // next_index=null 但缺项
    { items: [{ index: 0, requested_id: 1, state: 'ok', value: okBundle }], next_index: null },
    // next_index 覆盖范围之外出现项
    { items: [
      { index: 0, requested_id: 1, state: 'ok', value: okBundle },
      { index: 1, requested_id: 2, state: 'ok', value: okBundle },
    ], next_index: 1 },
  ];
  for (const body of cases) {
    const { fetcher } = scriptedFetch([{ body }]);
    const transport = createHttpReadTransport({ fetcher });
    try {
      await transport.execute('readings', { key: 'k', ids: [1, 2] },
        { signal: new AbortController().signal });
      throw new Error(`批次响应 ${JSON.stringify(body)} 应当拒绝`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid_response');
    }
  }
});

test('合法批次与区间批次通过校验原样返回', async () => {
  const token = 'r1-' + 'a'.repeat(64);
  const bundle = {
    detail: { req_id: 1, reading_token: token },
    meta: { req_id: 1, reading_token: token },
  };
  const readings = {
    items: [
      { index: 0, requested_id: 1, state: 'ok', value: bundle },
      { index: 1, requested_id: 2, state: 'not_found', reason: 'missing' },
    ],
    next_index: null,
  };
  const { fetcher, calls } = scriptedFetch([{ body: readings }, {
    body: { items: [{ index: 0, requested_id: 3, state: 'ok',
      value: { req_id: 3, reading_token: token } }], next_index: null },
  }]);
  const transport = createHttpReadTransport({ fetcher });
  const page = await transport.execute('readings', { key: 'k', ids: [1, 2] },
    { signal: new AbortController().signal });
  expect(page as object).toEqual(readings);
  const ranges = await transport.execute('bodyRanges', { key: 'k',
    ranges: [{ id: 3, token, from: 0, to: 40 }] }, { signal: new AbortController().signal });
  expect(ranges.items[0]!.state === 'ok' && ranges.items[0]!.value.reading_token).toBe(token);
  expect(calls).toHaveLength(2);
});

test('页面与目录响应的顶层形状校验', async () => {
  const token = 'r1-' + 'a'.repeat(64);
  const signal = () => new AbortController().signal;
  type HttpTransport = ReturnType<typeof createHttpReadTransport>;
  const cases: Array<{ run: (t: HttpTransport) => Promise<unknown>; body: unknown }> = [
    { body: { items: 'no' },
      run: t => t.execute('sessions', { limit: 1, cursor: null }, { signal: signal() }) },
    { body: { length: 0 },
      run: t => t.execute('bgJobs', { key: 'k' }, { signal: signal() }) },
    { body: null,
      run: t => t.execute('detail', { id: 1 }, { signal: signal() }) },
    { body: { req_id: 1 },
      run: t => t.execute('body', { id: 1, token, from: 0, to: 40 }, { signal: signal() }) },
    { body: { state: 'available' },
      run: t => t.execute('toolResult', { id: 1, ord: 0, token }, { signal: signal() }) },
    { body: [],
      run: t => t.execute('route', { id: 1 }, { signal: signal() }) },
    { body: { req_id: 1, reading_token: token, entries: null },
      run: t => t.execute('contextItem', { id: 1, token,
        query: { kind: 'files', name: null, tag: null, cursor: null } }, { signal: signal() }) },
  ];
  for (const { run, body } of cases) {
    const { fetcher } = scriptedFetch([{ body }]);
    const transport = createHttpReadTransport({ fetcher });
    try {
      await run(transport);
      throw new Error(`畸形响应 ${JSON.stringify(body)} 应当拒绝`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid_response');
    }
  }
});

test('合法页面与读取结果原样返回', async () => {
  const { fetcher } = scriptedFetch([{
    body: {
      items: [{ conv_key: 'k', title: 't', last_ms: 1, request_count: 1, agents: [], flags: [] }],
      next_cursor: null,
    },
  }]);
  const transport = createHttpReadTransport({ fetcher });
  const page = await transport.execute('sessions', { limit: 1, cursor: null },
    { signal: new AbortController().signal });
  expect(page.items).toHaveLength(1);
});
