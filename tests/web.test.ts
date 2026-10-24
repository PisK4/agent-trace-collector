import { expect, test } from 'bun:test';
import {
  auxSummary, isErrorText, isAuxRow, purposeLabel, railFactsHtml, replyCompleteness, resolveTraceTarget,
  restoreScroll, structureFoldHtml, toolOverviewHtml, toolResultPanel, toolSchemaSection,
} from '../web/app.js';

test('resolveTraceTarget 区分窗口内、canonical、窗口外与不存在', () => {
  const rows = [{ req_id: 1 }, { req_id: 2 }];
  expect(resolveTraceTarget(rows, 2, null)).toEqual({ kind: 'in-page', reqId: 2 });
  // 合并后的旧 id 解析成 canonical：canonical 在窗口里就直接跳过去。
  expect(resolveTraceTarget(rows, 9, { req_id: 1 })).toEqual({ kind: 'canonical', reqId: 1 });
  // canonical 不在窗口里：它存在，只是更早，不判缺失。
  expect(resolveTraceTarget(rows, 9, { req_id: 40 })).toEqual({ kind: 'off-page', reqId: null });
  expect(resolveTraceTarget(rows, 9, null)).toEqual({ kind: 'missing', reqId: null });
});

test('辅助行只由派生用途决定', () => {
  expect(isAuxRow({ purpose_chain: 'exclude', chain_role: 'main' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main' })).toBe(false);
  // 摘要文本里的字样不参与判断。
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main', reply_preview: '辅助请求' })).toBe(false);
});

test('未知用途保留原始 ID', () => {
  expect(purposeLabel('synthetic_probe')).toBe('synthetic_probe');
  expect(purposeLabel(null)).toBe('未知用途');
  expect(purposeLabel('title')).toBe('标题生成');
});

test('分类器摘要显示判定', () => {
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: '<block>no</block>' })).toContain('放行');
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: '<block>yes</block>' })).toContain('拦截');
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: 'garbage' })).toContain('判定未知');
  expect(auxSummary({ req_kind: 'title', model_title: '空状态排查' })).toContain('空状态排查');
});

test('滚动恢复夹在可滚动范围内', () => {
  const element = { scrollHeight: 200, clientHeight: 100, scrollTop: 0 };
  expect(restoreScroll(element, 150)).toBe(100);
  expect(restoreScroll(element, -5)).toBe(0);
  expect(restoreScroll(element, 80)).toBe(80);
});

// —— Task 7：右栏读数页组合、结构折叠、回复完整性与工具详情 ——

/** @type {Record<string, unknown>} 可读正文的最小行数据 */
const factsRow = { body_state: 'available', miss_reason: null };
const emptyStructure = { open: false, next: 0, total: 45, ords: [], selected: null, loading: false, error: null };
/** @param {{state: string, items: {name: string, description?: string, schema: unknown, source?: string}[], reason: string | null}} tools */
const capsOf = (tools: { state: string; items: { name: string; description?: string; schema: unknown; source?: string }[]; reason: string | null }) => ({
  tools, skills: { state: 'present', items: [], reason: null },
  coverage: { complete: true, reason: 'available', from: 0, to: 0, total: null }, agent: null,
});
/** @param {string} state @param {Record<string, unknown>} extra */
const pairOf = (state: string, extra: Record<string, unknown> = {}) => ({
  call_id: 'c1', ord: 1, tool_name: 'Bash', result_req: null, result_ord: null, result_path: null, state, ...extra,
});
/** @param {'available' | 'pending' | 'ambiguous' | 'unpaired' | 'unavailable' | 'invalid_location'} state @param {Record<string, unknown>} extra */
const readingOf = (state: 'available' | 'pending' | 'ambiguous' | 'unpaired' | 'unavailable' | 'invalid_location', extra: Record<string, unknown> = {}) => ({
  owner_req: 7, call_ord: 1, reading_token: 'r1-' + 'a'.repeat(64),
  state, target: null, content: null, is_error: null, reason: null, ...extra,
});
/** @param {number} ord @param {string} text */
const entryOf = (ord: number, text: string) => ({
  ord, role: 'user' as const, blocks: [{ kind: 'text', text, index: 0, raw: text }],
  preview: text, input: null, isInput: false,
});

function factsHtml(structureHtml: string) {
  return railFactsHtml({
    capabilitiesHtml: '<details class="rail-fold" data-fold="cap:tools"><summary>工具清单</summary></details>',
    structureHtml,
    replyHtml: '<details class="rail-fold" data-fold="reply:1" open><summary>本次回复</summary></details>',
    promptHtml: '<details class="rail-fold" data-fold="prompt:1"><summary>上下文组成</summary></details>',
    completenessHtml: '<section class="rail-section"><h3>身份完整性</h3></section>',
  });
}

test('读数页按回复→结构→能力→上下文→身份完整排序；用量与计时在头部读数条，不进读数页', () => {
  const html = factsHtml(structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [],
    structure: emptyStructure, delta: new Set<number>(), relation: '会话首笔',
  }));
  expect(html.indexOf('本次回复')).toBeLessThan(html.indexOf('请求结构'));
  expect(html.indexOf('请求结构')).toBeLessThan(html.indexOf('工具清单'));
  expect(html.indexOf('工具清单')).toBeLessThan(html.indexOf('上下文组成'));
  expect(html.indexOf('上下文组成')).toBeLessThan(html.indexOf('身份完整性'));
  expect(html).not.toContain('用量');
  expect(html).not.toContain('时间构成');
  // 回复默认展开；结构与能力默认折叠。
  expect(html).toContain('<details class="rail-fold" data-fold="reply:1" open>');
});

test('结构折叠：total=45、ords=[] 时有数量没有消息；正文回收不给加载按钮', () => {
  const closed = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [],
    structure: emptyStructure, delta: new Set<number>(), relation: '',
  });
  expect(closed).toContain('45 条消息');
  expect(closed).not.toContain('msg-list');
  expect(closed).toContain('data-structure-more="1"');
  // 未读取也给出说明，不给空消息列表冒充。
  expect(closed).toContain('尚未读取');
  // open 状态来自 structure.open，由重绘保持。
  const open = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [],
    structure: { ...emptyStructure, open: true }, delta: new Set<number>(), relation: '',
  });
  expect(open).toContain(' open>');
  const evicted = structureFoldHtml({
    reqId: 1, row: { body_state: 'evicted', miss_reason: 'budget' }, meta: null, entries: [],
    structure: { ...emptyStructure, total: null }, delta: null, relation: '',
  });
  expect(evicted).not.toContain('data-structure-more');
  expect(evicted).toContain('正文已回收');
});

test('delta=null 给关系说明不标新增，delta=[] 显示新增 0', () => {
  const base = {
    reqId: 1, row: factsRow, meta: { total: 1 },
    structure: { ...emptyStructure, total: 1, next: 1, ords: [0] },
    entries: [entryOf(0, '开场')],
  };
  const unknown = structureFoldHtml({ ...base, delta: null, relation: '前驱正文不可读，无法比对' });
  expect(unknown).toContain('不标记新增消息');
  expect(unknown).not.toContain('新增 0');
  expect(unknown).not.toContain('msg-new');
  const empty = structureFoldHtml({ ...base, delta: new Set<number>(), relation: '' });
  expect(empty).toContain('新增 0');
});

test('结构内点开消息详情可返回，消息总数不变', () => {
  const entries = [entryOf(0, '问'), entryOf(1, '答')];
  const structure = { ...emptyStructure, total: 45, next: 2, ords: [0, 1], selected: 1 };
  const detail = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries, structure, delta: null, relation: '',
  });
  expect(detail).toContain('45 条消息');
  expect(detail).toContain('data-structure-back="1"');
  expect(detail).toContain('messages[1]');
  expect(detail).not.toContain('data-msg=');
  const back = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries,
    structure: { ...structure, selected: null }, delta: null, relation: '',
  });
  expect(back).toContain('data-msg="1"');
  expect(back).toContain('45 条消息');
});

test('回复完整性四态：截断不推翻请求成功，缺失不标完成', () => {
  const view = (state: string, finish: string | null) => ({ state, text: '', thinking: [], calls: [], finish, model: null, raw: null });
  expect(replyCompleteness({ status: 200 }, view('ok', 'length'))).toEqual({ key: 'truncated', label: '回复截断' });
  expect(replyCompleteness({ status: 200 }, view('ok', 'max_tokens')).key).toBe('truncated');
  expect(replyCompleteness({ status: 200 }, view('ok', 'end_turn')).key).toBe('complete');
  expect(replyCompleteness({ status: 200 }, view('ok', 'tool_use')).key).toBe('complete');
  expect(replyCompleteness({ status: 200 }, view('ok', 'tool_calls')).key).toBe('complete');
  expect(replyCompleteness({ status: 200 }, view('ok', null)).key).toBe('unknown');
  expect(replyCompleteness({ status: 200 }, view('invalid', null)).key).toBe('unknown');
  expect(replyCompleteness({ status: 200 }, view('absent', null)).key).toBe('absent');
  expect(replyCompleteness({ status: 500 }, view('absent', null)).key).toBe('absent');
});

test('Schema 五态分开：正常、未声明、未携带、缺失、未读完', () => {
  const present = toolSchemaSection(capsOf({ state: 'present', items: [{ name: 'Bash', description: '', schema: { type: 'object' }, source: 'tools' }], reason: null }), 'Bash');
  expect(present).toContain('&quot;type&quot;: &quot;object&quot;');
  // 0 项但能力可读：本请求未声明，不写成不可读。
  expect(toolSchemaSection(capsOf({ state: 'present', items: [], reason: null }), 'Bash')).toContain('未声明');
  expect(toolSchemaSection(capsOf({ state: 'empty', items: [], reason: 'no_tools_field' }), 'Bash')).toContain('没有携带工具定义');
  expect(toolSchemaSection(capsOf({ state: 'missing', items: [], reason: 'body_unavailable' }), 'Bash')).toContain('工具定义缺失');
  expect(toolSchemaSection(capsOf({ state: 'partial', items: [], reason: 'body_partial' }), 'Bash')).toContain('未读完');
  expect(toolSchemaSection(capsOf({ state: 'unrecognized', items: [], reason: 'format' }), 'Bash')).toContain('未识别');
  expect(toolSchemaSection(null, 'Bash')).toContain('能力视图不可读');
});

test('同名工具逐项列出，不任选第一项', () => {
  const html = toolSchemaSection(capsOf({
    state: 'present', reason: null, items: [
      { name: 'Bash', description: '', schema: { v: 1 }, source: 'tools' },
      { name: 'Bash', description: '', schema: { v: 2 }, source: 'mcp' },
    ],
  }), 'Bash');
  expect(html).toContain('同名');
  expect(html).toContain('&quot;v&quot;: 1');
  expect(html).toContain('&quot;v&quot;: 2');
});

test('同消息两个结果按调用序号取到各自正文，调用方请求不变', () => {
  const first = toolResultPanel(7, 0,
    pairOf('resolved', { result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[0]' }),
    readingOf('available', { content: 'first result', target: { req_id: 9, ord: 2, path: 'request.messages[2].content[0]' } }),
     { target: '09' });
  expect(first).toContain('first result');
  const second = toolResultPanel(7, 1,
    pairOf('resolved', { result_req: 9, result_ord: 2, result_path: 'request.messages[2].content[1]' }),
    readingOf('available', { content: 'second result', target: { req_id: 9, ord: 2, path: 'request.messages[2].content[1]' } }),
     { target: '09' });
  expect(second).toContain('second result');
  expect(second).not.toContain('first result');
  expect(second).toContain('请求 7');
});

test('关联与正文加载分开：未读取给待读取与入口，失败可重试，未确认不显示正文', () => {
  const unloaded = toolResultPanel(7, 1, pairOf('resolved', { result_req: 9, result_ord: 2 }), null,  { target: '09' });
  expect(unloaded).toContain('待读取');
  expect(unloaded).toContain('data-tool-read="7"');
  expect(unloaded).toContain('data-result-owner="7"');
  const failed = toolResultPanel(7, 1, pairOf('resolved', { result_req: 9, result_ord: 2 }),
    readingOf('unavailable', { reason: 'body_evicted' }),  { target: '09' });
  expect(failed).toContain('重试');
  expect(failed).toContain('data-tool-retry="7"');
  // 加载失败不改写关联状态。
  expect(failed).toContain('已确认配对');
  for (const state of ['pending', 'ambiguous', 'unpaired']) {
    const html = toolResultPanel(7, 1, pairOf(state), null,  { target: null });
    expect(html).not.toContain('data-tool-read');
    expect(html).not.toContain('<pre');
  }
});

test('is_error 三态分开，resolved 不写成成功', () => {
  expect(toolResultPanel(7, 1, pairOf('resolved'), readingOf('available', { content: 'x', is_error: false }),  { target: null }))
    .toContain('上游未标记错误');
  expect(toolResultPanel(7, 1, pairOf('resolved'), readingOf('available', { content: 'x', is_error: true }),  { target: null }))
    .toContain('工具执行失败');
  expect(toolResultPanel(7, 1, pairOf('resolved'), readingOf('available', { content: 'x', is_error: null }),  { target: null }))
    .toContain('未报告');
  expect(isErrorText(null)).toContain('未报告');
});

test('工具概览显示配对与正文加载两种状态，时长归属说明保留', () => {
  expect(toolOverviewHtml(7, pairOf('resolved', { result_req: 9, result_ord: 2 }), null)).toContain('待读取');
  expect(toolOverviewHtml(7, pairOf('resolved', { result_req: 9, result_ord: 2 }), readingOf('available'))).toContain('已读取');
  expect(toolOverviewHtml(7, pairOf('pending'), null)).toContain('结果位置待定');
  expect(toolOverviewHtml(7, pairOf('ambiguous'), null)).toContain('多个候选');
  expect(toolOverviewHtml(7, null, null)).toContain('还没有见到结果');
  expect(toolOverviewHtml(7, pairOf('resolved'), null)).toContain('工具执行时长未采集');
});
