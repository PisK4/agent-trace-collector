import { expect, test } from 'bun:test';
import { editCompareHtml, isErrorText, prettyJson, renderTracePair } from '../web/trace-pair.js';

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
  // 两段各带一个角色标：调用在上、结果在下，来源路径 mono 弱化。
  const callFrole = html.indexOf('<b>调用</b>');
  expect(callFrole).toBeGreaterThanOrEqual(0);
  expect(html.indexOf('<b>结果</b>')).toBeGreaterThan(callFrole);
  expect(html.indexOf('first result')).toBeGreaterThan(callFrole);
  // 已确认配对给弱化连接语交代因果。
  expect(html).toContain('下一条请求带回结果');
  // 两端同一套 pre.raw 缩进样式；调用参数按格式化 JSON 显示。
  expect(html).toContain('&quot;path&quot;: &quot;a.txt&quot;');
  // 身份行：调用方与承载请求都以文本出现。
  expect(html).toContain('请求 03');
  expect(html).toContain('请求 09');
  expect(html).toContain('request.messages[2].content[0]');
  // 就地阅读：不出现跳转类按钮属性。
  expect(html).not.toContain('data-result-owner');
  expect(html).not.toContain('data-locate');
});

test('两段角色标固定，连接语只在已确认配对出现', () => {
  const read = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf({ name: 'Read', inputText: '{"file_path":"a.txt"}' }),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('available', { content: 'x' }), carrierLabel: '09',
  });
  // 角色标各出现一次；工具名只在页头，配对片段内不再重复。
  expect(read.match(/<b>调用<\/b>/g)?.length).toBe(1);
  expect(read.match(/<b>结果<\/b>/g)?.length).toBe(1);
  expect(read).not.toContain('Read</');
  const pending = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf({ name: 'Read', inputText: '{"file_path":"a.txt"}' }),
    pair: pairOf('pending'), reading: null, carrierLabel: null,
  });
  // 未确认不给连接语，因果由顶部状态行说明。
  expect(pending).not.toContain('下一条请求带回结果');
  expect(pending).toContain('<b>结果</b>');
});

test('未读取给待读取与读取入口；终态不给重试；未确认不给正文与读取入口', () => {
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
  // body_evicted 是终态：重试不会让正文回来，状态行也不再说「可重试」。
  expect(failed).not.toContain('data-tool-retry');
  expect(failed).toContain('body_evicted');
  expect(failed).toContain('正文加载 正文已回收');
  expect(failed).not.toContain('读取失败，可重试');
  expect(failed).toContain('已确认配对');
  // 非终态的不可读仍保留重试入口。
  const retryable = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf(),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('unavailable', { reason: 'read_failed' }), carrierLabel: '09',
  });
  expect(retryable).toContain('重试读取');
  expect(retryable).toContain('data-tool-retry="7"');
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
  // is_error=false 是上游明确给出的正常态：静默即与未报告区分，不挂标签。
  expect(of(false)).not.toContain('上游未标记错误');
  expect(of(false)).not.toContain('pair-error');
  expect(of(true)).toContain('工具执行失败');
  // is_error=true 的 Result 面板整块 warn 软色。
  expect(of(true)).toContain('body-panel pair-error');
  expect(of(null)).toContain('未报告');
  expect(isErrorText(null)).toContain('未报告');
});

test('Edit 调用渲染红绿对照块，其余键维持缩进 JSON，原始 JSON 折叠保留', () => {
  const html = renderTracePair({
    owner: 7, ownerLabel: '07',
    call: callOf({ name: 'Edit', inputText: JSON.stringify({ file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'x', replace_all: true }) }),
    pair: pairOf('resolved', { result_req: 9, result_ord: 2 }),
    reading: readingOf('available', { content: 'done' }), carrierLabel: '09',
  });
  expect(html).toContain('edit-block old');
  expect(html).toContain('edit-block new');
  expect(html).toContain('>old_string</span>');
  expect(html).toContain('>new_string</span>');
  // 其余键维持缩进 JSON。
  expect(html).toContain('&quot;file_path&quot;: &quot;src/a.ts&quot;');
  expect(html).toContain('&quot;replace_all&quot;: true');
  // 原始参数 JSON 折叠保留，键按 owner + 调用序号稳定。
  expect(html).toContain('data-fold="edit:7:1"');
  expect(html).toContain('原始参数 JSON');
  // 非 Edit 与不可解析参数回退整段缩进 JSON。
  const plain = renderTracePair({
    owner: 7, ownerLabel: '07', call: callOf(), pair: pairOf('resolved', { result_req: 9 }),
    reading: readingOf('available', { content: 'x' }), carrierLabel: '09',
  });
  expect(plain).not.toContain('edit-block');
  expect(editCompareHtml('Edit', 'not json', 'k')).toBeNull();
  expect(editCompareHtml('Read', '{"file_path":"a"}', 'k')).toBeNull();
});

test('正文转义；非 JSON 参数按原文展示；工具名不渲染进页面', () => {
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
  // 工具名不再渲染进配对页（只在页头），原始与转义形态都不出现。
  expect(html).not.toContain('&lt;script&gt;');
  expect(html).toContain('&lt;img src=x');
  expect(html).toContain('plain args');
  expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(prettyJson('not json')).toBe('not json');
});
