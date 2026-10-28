import { expect, test } from 'bun:test';
import {
  contentTextOf, contextDetailHtml, directoryStatusHtml, entryBodyUrl, entryContentHtml, iidParse,
} from '../web/context-detail.js';

test('iid 解析：tag 可空、名字段允许含分隔符、无分隔非法', () => {
  expect(iidParse('files\u0001read\u0001src/a.ts')).toEqual({ kind: 'files', tag: 'read', name: 'src/a.ts' });
  expect(iidParse('chat\u0001\u00012')).toEqual({ kind: 'chat', tag: null, name: '2' });
  expect(iidParse('files\u0001\u0001a\u0001b.ts')).toEqual({ kind: 'files', tag: null, name: 'a\u0001b.ts' });
  expect(iidParse('no-separator')).toBeNull();
});

test('正文文本抽取：文本块拼接，图片与密封推理按事实标注', () => {
  expect(contentTextOf('plain')).toBe('plain');
  expect(contentTextOf([
    { type: 'text', text: 'first' },
    { type: 'image', source: {} },
    { type: 'thinking', thinking: 'sealed' },
  ])).toBe('first\n[图片块：不以文本呈现]\n[推理内容：密封不可读]');
  expect(contentTextOf({ output: 'tool output' })).toBe('tool output');
  expect(contentTextOf({ type: 'tool_result', content: 42 })).toBeNull();
  expect(contentTextOf(null)).toBeNull();
});

test('目录状态行：可读无行，缺口带原因，notes 原文呈现', () => {
  expect(directoryStatusHtml({ state: 'available', reason: null, notes: [], entries: [], next_cursor: null })).toBe('');
  const evicted = directoryStatusHtml({
    state: 'evicted', reason: 'evicted', notes: ['目录未扫完，用继续位置取余下条目'], entries: [], next_cursor: null,
  });
  expect(evicted).toContain('正文已按保留策略回收');
  expect(evicted).toContain('目录未扫完');
  // 状态与 reason 相同时不重复括号。
  expect(evicted).not.toContain('（evicted）');
});

test('弹窗 HTML：头部范围与 token，单项默认展开，集合块列成员', () => {
  const one = contextDetailHtml({
    reqId: 7, kind: 'files', name: 'src/a.ts', tag: 'read', label: 'src/a.ts', tokens: 8460, token: 'r1-x',
  }, {
    phase: 'ready',
    data: { state: 'available', reason: null, notes: [], entries: [
      { req_id: 7, ord: 1, path: 'request.messages[1].content[0]', precision: 'located',
        tool_name: 'Read', call_ord: 0, owner_req: 6, role: 'tool' },
    ], next_cursor: null },
  });
  expect(one).toContain('src/a.ts');
  // 路径类名字只显示 basename，完整名字在 title 里。
  expect(one).toContain('<b title="src/a.ts">a.ts</b>');
  expect(one).toContain('8.5k tokens');
  expect(one).toMatch(/ctx-d-entry" open data-ctx-entry="0"/);
  expect(one).toContain('调用 0 · 结果在 req 6');
  expect(one).not.toContain('data-ctx-more');

  const rest = contextDetailHtml({
    reqId: 7, kind: 'files', name: null, tag: null, label: '其余文件引用 30 项', tokens: 9000, token: 'r1-x',
    members: ['files\u0001read\u0001m1.ts', 'files\u0001read\u0001m2.ts'],
  }, {
    phase: 'ready',
    data: { state: 'available', reason: null, notes: [], entries: [
      { req_id: 7, ord: 2, path: 'request.messages[2]', precision: 'carrier',
        tool_name: null, call_ord: null, owner_req: null, role: 'user' },
    ], next_cursor: 'abc' },
  });
  expect(rest).toContain('成员：m1.ts、m2.ts');
  expect(rest).toContain('承载块');
  expect(rest).toContain('data-ctx-more');
  // 类级目录条目不默认展开。
  expect(rest).not.toContain('data-ctx-entry="0" open');
});

test('弹窗头与成员名单：路径类只显示 basename，完整名字进 title', () => {
  const ready = { phase: 'ready', data: { state: 'available', reason: null, notes: [], entries: [], next_cursor: null } };
  const item = contextDetailHtml({
    reqId: 7, kind: 'memory', name: '/pis/.claude/AGENTS.md', tag: 'user',
    label: '/pis/.claude/AGENTS.md', tokens: 1980, token: 'r1-x',
  }, ready);
  expect(item).toContain('<b title="/pis/.claude/AGENTS.md">AGENTS.md</b>');
  // 非路径类范围名不折算，也不挂多余的 title。
  const category = contextDetailHtml({
    reqId: 7, kind: 'files', name: null, tag: null, label: '文件引用', tokens: 900, token: 'r1-x',
  }, ready);
  expect(category).toContain('<b>文件引用</b>');

  const rest = contextDetailHtml({
    reqId: 7, kind: 'files', name: null, tag: null, label: '其余文件引用 2 项', tokens: 900, token: 'r1-x',
    members: ['files\u0001read\u0001src/queries/m1.ts', 'files\u0001read\u0001m2.ts'],
  }, ready);
  expect(rest).toContain('成员：<span title="src/queries/m1.ts">m1.ts</span>、m2.ts');
  // 轮次等非路径类成员保持原名。
  const chat = contextDetailHtml({
    reqId: 7, kind: 'chat', name: null, tag: null, label: '对话内容', tokens: 900, token: 'r1-x',
    members: ['chat\u0001turn\u00012'],
  }, ready);
  expect(chat).toContain('成员：2');
});

test('弹窗 HTML：缺口状态与读取失败如实呈现，不渲染条目列表', () => {
  const evicted = contextDetailHtml({
    reqId: 7, kind: 'results', name: null, tag: null, label: '工具结果', tokens: 1000, token: 'r1-x',
  }, { phase: 'ready', data: { state: 'evicted', reason: 'evicted', notes: [], entries: [], next_cursor: null } });
  expect(evicted).toContain('正文已按保留策略回收');
  expect(evicted).not.toContain('ctx-d-entry');
  const failed = contextDetailHtml({
    reqId: 7, kind: 'results', name: null, tag: null, label: '工具结果', tokens: null, token: 'r1-x',
  }, { phase: 'error', error: 'reading_changed' });
  expect(failed).toContain('阅读依据已变化');
  expect(failed).toContain('关闭后重新打开');
  expect(contextDetailHtml({
    reqId: 7, kind: 'chat', name: null, tag: null, label: '对话内容', tokens: null, token: 'r1-x',
  }, { phase: 'loading' })).toContain('读取目录…');
});

test('条目正文：文本、失败标记、不可读状态与原始对象折叠', () => {
  const entry = { ord: 1, path: 'request.messages[1].content[0]', precision: 'located' };
  expect(entryContentHtml(entry, { content: 'file body', is_error: false }))
    .toContain('<pre class="ctx-d-text">file body</pre>');
  expect(entryContentHtml(entry, { content: 'boom', is_error: true })).toContain('is_error');
  // 正文页形状：messages[0].value。
  expect(entryContentHtml({ ord: 0, path: 'request.messages[0]', precision: 'carrier' },
    { state: 'available', messages: [{ ord: 0, value: { role: 'user', content: 'hi' } }] }))
    .toContain('原始对象');
  expect(entryContentHtml(entry, { state: 'evicted', reason: 'budget' })).toContain('budget');
});

test('正文 URL：顶层字段条目没有消息序号，按正文根读取', () => {
  const session = { reqId: 7, token: 'r1-x' };
  const top = entryBodyUrl(session, { ord: null, call_ord: null, owner_req: null });
  expect(top).toBe('/api/requests/7/body?if_reading=r1-x');
  expect(top).not.toContain('NaN');
  expect(top).not.toContain('from=');
  // 有消息序号的条目仍按区间读；工具结果走配对端点，不看自己有没有序号。
  expect(entryBodyUrl(session, { ord: 3, call_ord: null, owner_req: null }))
    .toBe('/api/requests/7/body?from=3&to=4&if_reading=r1-x');
  expect(entryBodyUrl(session, { ord: 5, call_ord: 1, owner_req: 9 }))
    .toBe('/api/requests/9/tools/1/result?if_reading=r1-x');
});
