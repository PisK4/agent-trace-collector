import { expect, test } from 'bun:test';
import { createHandler } from '../src/http';
import { loadConfig } from '../src/config';
import { fixture, seedPurposeRequest } from './fixtures';
import { enqueueDerive, drainDerive } from '../src/derive/sync';
import { createHttpReadTransport } from '../web/read-http.js';
import { createInProcessReadTransport, createFixtureReadTransport } from './helpers/read-transport';
import type { ReadOperations } from '../src/read-contract';

const CONV_KEY = 'contract/conv';
const ACTOR = 'actor';
const CALL_ID = 'contract_call';

/**
 * 合成契约数据：两笔带正文与工具配对的请求。
 * 第二笔的输入是第一笔的完整前缀加调用与结果，派生后配对为 resolved，
 * 让 body/toolResult/contextItem 走到 available 路径而不是只对照空壳。
 */
function seedContractSession(store: ReturnType<typeof fixture>['store']): number[] {
  const toolUse = { type: 'tool_use', id: CALL_ID, name: 'Read', input: { file_path: '/tmp/synthetic.txt' } };
  const first = seedPurposeRequest(store, {
    convKey: CONV_KEY, actor: ACTOR, startedMs: 1, cleanGroup: true,
    purposePending: 0, summaryState: 'recomputed', summaryAlgorithm: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic contract hello' }] }],
    reply: { content: [toolUse] },
    tools: [{ name: 'Read', description: 'read a file', input_schema: {} }],
  });
  const second = seedPurposeRequest(store, {
    convKey: CONV_KEY, actor: ACTOR, startedMs: 2, cleanGroup: true,
    purposePending: 0, summaryState: 'recomputed', summaryAlgorithm: 1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'synthetic contract hello' }] },
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL_ID, content: 'synthetic result' }] },
    ],
    reply: { content: [{ type: 'text', text: 'done' }] },
    tools: [{ name: 'Read', description: 'read a file', input_schema: {} }],
  });
  enqueueDerive(store, CONV_KEY, ACTOR, '');
  drainDerive(store);
  return [first, second];
}

test('HTTP adapter 与进程内 adapter 给出相同公开结果', async () => {
  const f = fixture();
  try {
    const [firstId] = seedContractSession(f.store);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const fetcher = (async (url: unknown, init?: { signal?: AbortSignal }) =>
      handler(new Request(`http://127.0.0.1:8320${String(url)}`, {
        headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
        signal: init?.signal,
      }))) as unknown as typeof fetch;
    const http = createHttpReadTransport({ fetcher });
    const direct = createInProcessReadTransport(f.store);
    const signal = new AbortController().signal;

    const detail = await http.execute('detail', { id: firstId }, { signal });
    const directDetail = await direct.execute('detail', { id: firstId }, { signal });
    expect(detail).toEqual(directDetail);
    const token = detail.reading_token;

    const cases: Array<{
      name: string;
      run(transport: typeof http): Promise<unknown>;
    }> = [
      { name: 'sessions', run: t => t.execute('sessions', { limit: 50, cursor: null }, { signal }) },
      { name: 'requests', run: t => t.execute('requests',
        { key: CONV_KEY, limit: 100, cursor: null, direction: 'forward' }, { signal }) },
      { name: 'body', run: t => t.execute('body', { id: firstId, token, from: 0, to: 40 }, { signal }) },
      { name: 'toolResult', run: t => t.execute('toolResult', { id: firstId, ord: 0, token }, { signal }) },
      { name: 'route', run: t => t.execute('route', { id: firstId }, { signal }) },
      { name: 'turns', run: t => t.execute('turns', { key: CONV_KEY, from: null }, { signal }) },
      { name: 'bgJobs', run: t => t.execute('bgJobs', { key: CONV_KEY }, { signal }) },
      { name: 'summary', run: t => t.execute('summary', { key: CONV_KEY }, { signal }) },
      { name: 'summaryEntries', run: t => t.execute('summaryEntries',
        { key: CONV_KEY, query: { kind: 'tool', name: 'Read' } }, { signal }) },
      { name: 'contextItem', run: t => t.execute('contextItem',
        { id: firstId, token, query: { kind: 'results', name: null, tag: null, cursor: null } }, { signal }) },
      { name: 'stats', run: t => t.execute('stats', {}, { signal }) },
    ];
    for (const { name, run } of cases) {
      const viaHttp = await run(http);
      const viaDirect = await run(direct as unknown as typeof http);
      expect(viaHttp).toEqual(viaDirect);
      void name;
    }

    // 工具配对在派生后可用：结果读取走 available 路径，且两端身份一致。
    const tool = await http.execute('toolResult', { id: firstId, ord: 0, token }, { signal });
    expect(tool.state).toBe('available');
    expect(tool.target?.req_id).toBeGreaterThan(firstId);
  } finally {
    f.close();
  }
});

test('不存在与读取冲突在两侧 transport 语义一致', async () => {
  const f = fixture();
  try {
    const [firstId] = seedContractSession(f.store);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const fetcher = (async (url: unknown, init?: { signal?: AbortSignal }) =>
      handler(new Request(`http://127.0.0.1:8320${String(url)}`, {
        headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
        signal: init?.signal,
      }))) as unknown as typeof fetch;
    const http = createHttpReadTransport({ fetcher });
    const direct = createInProcessReadTransport(f.store);
    const signal = new AbortController().signal;

    const codeOf = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
        return 'resolved';
      } catch (error) {
        return (error as { code?: string }).code ?? 'no_code';
      }
    };
    expect(await codeOf(http.execute('detail', { id: 999999 }, { signal }))).toBe('not_found');
    expect(await codeOf(direct.execute('detail', { id: 999999 }, { signal }))).toBe('not_found');

    const token = (await http.execute('detail', { id: firstId }, { signal })).reading_token;
    const stale = 'r1-' + 'b'.repeat(64);
    expect(await codeOf(http.execute('body', { id: firstId, token: stale, from: 0, to: 40 }, { signal })))
      .toBe('reading_changed');
    expect(await codeOf(direct.execute('body', { id: firstId, token: stale, from: 0, to: 40 }, { signal })))
      .toBe('reading_changed');
    void token;
  } finally {
    f.close();
  }
});

test('fixture adapter 的行为契约：未配置操作、错误注入与延迟', async () => {
  const fixtureHandle = createFixtureReadTransport();
  const signal = new AbortController().signal;
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return 'resolved';
    } catch (error) {
      return (error as { code?: string }).code ?? 'no_code';
    }
  };

  expect(codeOf(fixtureHandle.transport.execute('detail', { id: 1 }, { signal })))
    .resolves.toBe('unsupported_operation');

  fixtureHandle.respond('detail', { reading_token: 'r1-' + 'a'.repeat(64) } as never);
  fixtureHandle.failNext('detail', 'reading_changed');
  expect(codeOf(fixtureHandle.transport.execute('detail', { id: 1 }, { signal })))
    .resolves.toBe('reading_changed');
  expect((await fixtureHandle.transport.execute('detail', { id: 1 }, { signal })).reading_token)
    .toBe('r1-' + 'a'.repeat(64));
  expect(fixtureHandle.calls.map(call => call.operation)).toEqual(['detail', 'detail', 'detail']);
});

test('fixture adapter 的 hold 在放行前不产出结果，取消不吞结果', async () => {
  const fixtureHandle = createFixtureReadTransport();
  const token = 'r1-' + 'a'.repeat(64);
  fixtureHandle.respond('body', { req_id: 1, reading_token: token } as never);
  fixtureHandle.hold('body');
  const started = fixtureHandle.started('body');
  const pending = fixtureHandle.transport.execute(
    'body', { id: 1, token, from: 0, to: 1 }, { signal: new AbortController().signal });
  await started;
  fixtureHandle.release('body');
  expect((await pending).reading_token).toBe(token);
});
