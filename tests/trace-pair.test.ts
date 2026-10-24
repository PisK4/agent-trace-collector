import { expect, test } from 'bun:test';
import { isErrorText, prettyJson, renderTracePair } from '../web/trace-pair.js';

const TOKEN = 'r1-' + 'a'.repeat(64);

/** @param {Record<string, unknown>} extra */
const callOf = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'read_file', inputText: '{"path":"a.txt"}', ord: 1,
  path: 'reply.content[1]', ...extra,
});
/** @param {string} state @param {Record<string, unknown>} extra */
const pairOf = (state: string, extra: Record<string, unknown> = {}) => ({
  call_id: 'c1', ord: 1, tool_name: 'read_file', result_req: null, result_ord: null,
  result_path: null, state, ...extra,
});
/** @param {'available'|'pending'|'ambiguous'|'unpaired'|'unavailable'|'invalid_location'} state @param {Record<string, unknown>} extra */
const readingOf = (
  state: 'available' | 'pending' | 'ambiguous' | 'unpaired' | 'unavailable' | 'invalid_location',
  extra: Record<string, unknown> = {},
) => ({
  owner_req: 7, call_ord: 1, reading_token: TOKEN, state,
  target: null, content: null, is_error: null, raw: null, reason: null, ...extra,
});

test('配对页两端同屏：Call 在上、Result 在下，身份是文本不是跳转按钮', () => {
  const html = renderTracePair({
    owner: 7, ownerLabel: '03', call: callOf(),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[0]' }),
    reading: readingOf('available', {
      content: 'first result',
      target: { req_id: 9, ord: 2, path: 'request.messages[2].content[0]' },
    }),
    carrierLabel: '09',
  });
  expect(html.indexOf('Tool call')).toBeLessThan(html.indexOf('Tool result'));
  // 两端同一套 pre.raw 缩进样式；调用参数按格式化 JSON 显示。
  expect(html).toContain('&quot;path&quot;: &quot;a.txt&quot;');
  expect(html).toContain('first result');
  // 身份行：调用方与承载请求都以文本出现。
  expect(html).toContain('请求 03');
  expect(html).toContain('请求 09');
  expect(html).toContain('request.messages[2].content[0]');
  // 就地阅读：不出现跳转类按钮属性。
  expect(html).not.toContain('data-result-owner');
  expect(html).not.toContain('data-locate');
});

test('未读取给待读取与读取入口；失败保留重试；未确认不给正文与读取入口', () => {
  const unloaded = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf(),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }), reading: null, carrierLabel: '09',
  });
  expect(unloaded).toContain('待读取');
  expect(unloaded).toContain('data-tool-read="7"');
  const failed = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf(),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('unavailable', { reason: 'body_evicted' }), carrierLabel: '09',
  });
  expect(failed).toContain('重试');
  expect(failed).toContain('data-tool-retry="7"');
  // 加载失败不改写关联状态。
  expect(failed).toContain('已确认配对');
  for (const state of ['pending', 'ambiguous', 'unpaired']) {
    const html = renderTracePair({
      owner: 7, ownerLabel: '07', call: callOf(), pair: pairOf(state), reading: null, carrierLabel: null,
    });
    expect(html).not.toContain('data-tool-read');
    expect(html).not.toContain('data-tool-retry');
  }
});

test('同消息两个结果按调用序号各取各的正文，调用方身份不变', () => {
  const first = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf({ inputText: '{"i":0}', ord: 0 }),
    pair: pairOf('resolved', { ord: 0, result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[0]' }),
    reading: readingOf('available', {
      owner_req: 7, call_ord: 0, content: 'first result',
      target: { req_id: 9, ord: 2, path: 'request.messages[2].content[0]' },
    }),
    carrierLabel: '09',
  });
  const second = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf({ inputText: '{"i":1}', ord: 1 }),
    pair: pairOf('resolved', { ord: 1, result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[1]' }),
    reading: readingOf('available', {
      owner_req: 7, call_ord: 1, content: 'second result',
      target: { req_id: 9, ord: 2, path: 'request.messages[2].content[1]' },
    }),
    carrierLabel: '09',
  });
  expect(first).toContain('first result');
  expect(second).toContain('second result');
  expect(second).not.toContain('first result');
  expect(second).toContain('请求 07');
});

test('is_error 三态分开，resolved 不写成成功', () => {
  const of = (isError: boolean | null) => renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf(), pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('available', { content: 'x', is_error: isError }), carrierLabel: '09',
  });
  expect(of(false)).toContain('上游未标记错误');
  expect(of(true)).toContain('工具执行失败');
  expect(of(null)).toContain('未报告');
  expect(isErrorText(null)).toContain('未报告');
});

test('正文与工具名转义；非 JSON 参数按原文展示', () => {
  const html = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf({ name: '<script>alert(1)</script>', inputText: 'plain args' }),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('available', {
      content: '<img src=x onerror=alert(1)>',
      target: { req_id: 9, ord: 2, path: 'request.messages[2].content[0]' },
    }),
    carrierLabel: '09',
  });
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('&lt;img src=x');
  expect(html).toContain('plain args');
  expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(prettyJson('not json')).toBe('not json');
});
