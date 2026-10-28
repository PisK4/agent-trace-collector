import { expect, test } from 'bun:test';
import type { BodyPage } from '../src/protocols';
import { renderTurnBand, renderTurnRail, renderTurnRailHead } from '../web/turn-band.js';

/** 最小可用的正文页：默认 available，回复可注入，其余字段按空场景补齐。 */
function pageOf(reply: unknown, extra: Partial<BodyPage> = {}): BodyPage {
  return {
    state: 'available', protocol: 'anthropic', message_location: { key: 'messages', form: 'array' }, parse_state: 'ok',
    reply_state: reply === null ? 'absent' : 'ok',
    from: 0, to: 0, total: 0, messages: [], request_fields: null, reply,
    reason: null, interpretations: [],
    coverage: { from: 0, to: 0, total: 0, complete: true, loaded_complete: true, reason: 'available' },
    capabilities: {
      tools: { state: 'empty', items: [], reason: null },
      skills: { state: 'empty', items: [], reason: null }, agent: null,
      coverage: { complete: true, reason: 'available', from: 0, to: 0, total: 0 },
    },
    ...extra,
  };
}

const inputOf = (text: string) => ({
  state: 'text' as const, kind: 'plain' as const, text, original: text,
  removed: [], agent: null, rule: 'generic' as const,
});

test('轮次带：起点在窗口内的轮进带，窗口外不进，无轮整条不渲染', () => {
  const rows = [
    { req_id: 7, input_preview: '第一条命令' },
    { req_id: 9, input_preview: null },
  ];
  const items = [
    { turn: 1, start_req: 7, ordinals: [2], reply_req: 8 },
    { turn: 2, start_req: 9, ordinals: [3], reply_req: 9 },
    { turn: 3, start_req: 11, ordinals: [2], reply_req: 12 },
  ];
  const html = renderTurnBand(items, 2, rows);
  expect(html).toContain('data-turn="1"');
  expect(html).toContain('data-turn="2"');
  expect(html).not.toContain('data-turn="3"'); // 起点不在窗口：没有滚动目标也没有行摘要
  expect(html).toContain('aria-pressed="true"'); // 选中的轮 2
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('第一条命令');
  // 无摘要的行也有块：预览留空，轮号仍可点。
  expect(html).toContain('data-turn="2"');

  expect(renderTurnBand([], null, rows)).toBe('');
  expect(renderTurnBand([{ turn: 1, start_req: 99, ordinals: [2], reply_req: 99 }], null, rows)).toBe('');
});

test('轮次带：摘要 32 字截断、悬停给全文、内容一律转义', () => {
  const long = '长'.repeat(40);
  const html = renderTurnBand(
    [{ turn: 1, start_req: 1, ordinals: [2], reply_req: 1 }],
    null,
    [{ req_id: 1, input_preview: long }],
  );
  expect(html).toContain(`<b>1</b><span>${'长'.repeat(32)}…</span>`);
  expect(html).toContain(`title="${long}"`);

  const evil = renderTurnBand(
    [{ turn: 1, start_req: 1, ordinals: [2], reply_req: 1 }],
    null,
    [{ req_id: 1, input_preview: '<img src=x onerror=alert(1)>' }],
  );
  expect(evil).not.toContain('<img');
  expect(evil).toContain('&lt;img');
});

test('身份行：只留轮号文本，不带请求号也不是跳转', () => {
  const head = renderTurnRailHead({ turn: 3, start_req: 7, ordinals: [2], reply_req: 9 });
  expect(head).toContain('轮 3');
  expect(head).not.toContain('req');
  expect(head).not.toContain('data-locate');
  expect(head).not.toContain('data-trace');
});

test('轮次态：命令组多条消息按序，解释后的用户文本优先于原始块', () => {
  const turn = { turn: 1, start_req: 7, ordinals: [2, 3], reply_req: 8 };
  const html = renderTurnRail({
    turn,
    startRead: {
      entries: [
        { ord: 2, blocks: [{ kind: 'text', text: '<包装>原始块文本</包装>' }], input: inputOf('第一条命令') },
        { ord: 3, blocks: [{ kind: 'text', text: '第二条命令' }], input: null },
      ],
      meta: pageOf(null),
    },
    replyRead: { entries: [], meta: pageOf({ content: [{ type: 'text', text: '最终答复' }] }) },
    startRow: { body_state: 'available' },
    replyRow: { body_state: 'available', req_id: 8 },
  });
  // 两条命令两个面板，按序：messages[2] 在 messages[3] 之前。
  expect(html.indexOf('messages[2]')).toBeGreaterThanOrEqual(0);
  expect(html.indexOf('messages[2]')).toBeLessThan(html.indexOf('messages[3]'));
  expect(html).toContain('第一条命令');
  expect(html).not.toContain('原始块文本'); // 解释文本优先：包装不进命令面板
  expect(html).toContain('第二条命令'); // 没有解释时回退块文本
  // 回复面板：REPLY 头与全文；折叠键用终点 req_id。
  expect(html).toContain('最终答复');
  expect(html).toContain('REPLY');
  // 复制原文按起点请求读取，不带当前请求的偏见。
  expect(html).toContain('data-copy-owner="7"');
});

test('轮次态：按原始输入形态显示位置，内部序号仍供复制', () => {
  const turn = { turn: 1, start_req: 7, ordinals: [0], reply_req: 7 };
  const entry = { ord: 0, blocks: [{ kind: 'text', text: '合成命令' }], input: inputOf('合成命令') };
  const render = (meta: BodyPage | null) => renderTurnRail({
    turn, startRead: { entries: [entry], meta }, replyRead: null,
    startRow: { body_state: 'available' }, replyRow: null,
  });
  const bare = render(pageOf(null, { protocol: 'responses', message_location: { key: 'input', form: 'string' } }));
  expect(bare).toContain('>input</span>');
  expect(bare).not.toContain('input[0]');
  expect(bare).toContain('data-copy-msg="0" data-copy-owner="7"');
  const array = render(pageOf(null, { protocol: 'responses', message_location: { key: 'input', form: 'array' } }));
  expect(array).toContain('input[0]');
  expect(render(null)).not.toContain('messages[0]');
});

test('轮次态：命令位置缺失时按起点正文状态给出占位', () => {
  const turn = { turn: 1, start_req: 7, ordinals: [], reply_req: 8 };
  const render = (startRow: { body_state: string; miss_reason?: string | null } | null, meta: BodyPage | null) => renderTurnRail({
    turn, startRead: meta === null ? null : { entries: [], meta }, replyRead: null,
    startRow, replyRow: null,
  });
  expect(render({ body_state: 'evicted', miss_reason: '容量回收' }, null)).toContain('正文已回收');
  const unavailable = render({ body_state: 'available' }, pageOf(null));
  expect(unavailable).toContain('命令位置不可用');
  expect(unavailable).not.toContain('正文已回收');
  expect(unavailable).not.toContain('data-copy-msg');
  expect(render(null, null)).toContain('正在读取');
  expect(render({ body_state: 'available' }, null)).toContain('正在读取命令正文');
  expect(render({ body_state: 'partial' }, null)).toContain('正在读取命令正文');
});

test('轮次态：命令文本转义，不把正文当 HTML', () => {
  const html = renderTurnRail({
    turn: { turn: 1, start_req: 7, ordinals: [2], reply_req: 7 },
    startRead: { entries: [{ ord: 2, blocks: [], input: inputOf('<b>注入</b><script>x</script>') }], meta: pageOf(null) },
    replyRead: null,
    startRow: { body_state: 'available' },
    replyRow: null,
  });
  expect(html).not.toContain('<b>注入');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;b&gt;注入');
});

test('轮次态：读取中与回收态分立——正文状态不可读落回收文案，可读未到落读取中', () => {
  const turn = { turn: 1, start_req: 7, ordinals: [2], reply_req: 8 };
  // 两端都在读取：占位是读取中。
  const reading = renderTurnRail({
    turn, startRead: null, replyRead: null,
    startRow: { body_state: 'available' }, replyRow: { body_state: 'available' },
  });
  expect(reading).toContain('正在读取这条消息…');
  expect(reading).toContain('正在读取回复正文…');
  // 起点正文已回收：命令面板落回收态，与轨迹视图保留摘要同一立场。
  const evicted = renderTurnRail({
    turn, startRead: null, replyRead: null,
    startRow: { body_state: 'evicted', miss_reason: '容量回收' },
    replyRow: { body_state: 'available' },
  });
  expect(evicted).toContain('正文已回收');
  expect(evicted).toContain('容量回收');
  expect(evicted).not.toContain('正在读取这条消息…');
  // 回收页可读但消息不在分片里：同样按正文状态落回收态，不冒充已读。
  const recycledPage = renderTurnRail({
    turn,
    startRead: { entries: [], meta: pageOf(null, { state: 'evicted', parse_state: null, reply_state: null, reason: '容量回收' }) },
    replyRead: null,
    startRow: { body_state: 'evicted', miss_reason: '容量回收' },
    replyRow: { body_state: 'available' },
  });
  expect(recycledPage).toContain('正文已回收');
  // 终点正文回收：回复面板落回收态，不拿相邻请求的回复顶替。
  const replyEvicted = renderTurnRail({
    turn, startRead: { entries: [], meta: pageOf(null) },
    replyRead: { entries: [], meta: pageOf(null, { state: 'evicted', parse_state: null, reply_state: null, reason: '容量回收' }) },
    startRow: { body_state: 'available' },
    replyRow: { body_state: 'evicted', miss_reason: '容量回收' },
  });
  expect(replyEvicted).toContain('正文已回收');
});
