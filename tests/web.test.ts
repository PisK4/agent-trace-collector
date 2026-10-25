import { expect, test } from 'bun:test';
import { restoreScroll } from '../web/app.js';
import { replyCompleteness } from '../web/row-summary.js';
import {
  ledgerParts, ledgerRowsHtml, railFactsHtml, readingChangedNote,
  structureFoldHtml, systemContextOf, toolOverviewHtml, toolSchemaSection, usageFoldHtml,
} from '../web/rail-facts.js';
import {
  railTabFromParam, railTabParam, resolveTraceTarget, routeReadTarget,
} from '../web/url-route.js';

test('resolveTraceTarget 区分窗口内、canonical、窗口外与不存在', () => {
  const rows = [{ req_id: 1 }, { req_id: 2 }];
  expect(resolveTraceTarget(rows, 2, null)).toEqual({ kind: 'in-page', reqId: 2 });
  // 合并后的旧 id 解析成 canonical：canonical 在窗口里就直接跳过去。
  expect(resolveTraceTarget(rows, 9, { req_id: 1 })).toEqual({ kind: 'canonical', reqId: 1 });
  // canonical 不在窗口里：它存在，只是更早，不判缺失。
  expect(resolveTraceTarget(rows, 9, { req_id: 40 })).toEqual({ kind: 'off-page', reqId: null });
  expect(resolveTraceTarget(rows, 9, null)).toEqual({ kind: 'missing', reqId: null });
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
const emptyStructure = { next: 0, total: 45, ords: [], loading: false, error: null };
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
  state, target: null, content: null, is_error: null, raw: null, reason: null, ...extra,
});
/** @param {number} ord @param {string} text */
const entryOf = (ord: number, text: string) => ({
  ord, role: 'user' as const, rawRole: 'user', blocks: [{ kind: 'text', text, index: 0, raw: text, path: 'content[0]' }],
  preview: text, input: null, isInput: false,
});

function factsHtml(structureHtml: string) {
  return railFactsHtml({
    capabilitiesHtml: '<details class="rail-fold" data-fold="cap:tools"><summary>工具清单</summary></details>',
    structureHtml,
    replyHtml: '<details class="rail-fold" data-fold="reply:1" open><summary>本次回复</summary></details>',
    usageHtml: '<details class="rail-fold" data-fold="prompt:1" open><summary>用量与上下文</summary></details>',
    completenessHtml: '<section class="rail-section"><h3>身份完整性</h3></section>',
  });
}

test('读数页按回复→结构→能力→用量与上下文→身份完整排序；计时与用量在末位折叠行，头部只留身份行', () => {
  const html = factsHtml(structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [],
    structure: emptyStructure, delta: new Set<number>(), relation: '会话首笔',
  }));
  expect(html.indexOf('本次回复')).toBeLessThan(html.indexOf('请求结构'));
  expect(html.indexOf('请求结构')).toBeLessThan(html.indexOf('工具清单'));
  expect(html.indexOf('工具清单')).toBeLessThan(html.indexOf('用量与上下文'));
  expect(html.indexOf('用量与上下文')).toBeLessThan(html.indexOf('身份完整性'));
  expect(html).not.toContain('时间构成');
  // 回复与用量折叠行默认展开；结构与能力默认折叠。
  expect(html).toContain('<details class="rail-fold" data-fold="reply:1" open>');
  expect(html).toContain('<details class="rail-fold" data-fold="prompt:1" open>');
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
  // open 状态由调用方传入（页面来自 folds 表），由重绘保持。
  const open = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [],
    structure: emptyStructure, open: true, delta: new Set<number>(), relation: '',
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
  const structure = { ...emptyStructure, total: 45, next: 2, ords: [0, 1] };
  const detail = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries, structure, selected: 1, delta: null, relation: '',
  });
  expect(detail).toContain('45 条消息');
  expect(detail).toContain('data-structure-back="1"');
  expect(detail).toContain('messages[1]');
  expect(detail).not.toContain('data-msg=');
  const back = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries, structure, delta: null, relation: '',
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

test('阅读版本变化说明保留立即重读入口，自动重读在 store 内调度', () => {
  const note = readingChangedNote(7);
  expect(note).toContain('data-body-load="7"');
  expect(note).toContain('阅读版本已变化');
  expect(note).toContain('自动重读');
  // 页面里没有静默重建的脚本入口：重读走 store 与既有按钮。
  expect(note).not.toContain('script');
});

test('System 上下文按已确认前驱比较，前驱不可读只声明当前', () => {
  const row = { req_id: 7 };
  const same = (id: number) => ({
    detail: { prev_req_id: id === 7 ? 6 : null, prev_relation: id === 7 ? 'confirmed' : 'first' },
    meta: { request_fields: { system: 'v2' } },
  });
  expect(systemContextOf(row as never, (same as never))).toEqual({ text: 'v2', changed: false });
  // 前驱不在窗口或未读：只声明当前上下文，不宣称未变化。
  const unreadablePrev = (id: number) => id === 7
    ? { detail: { prev_req_id: 6, prev_relation: 'confirmed' }, meta: { request_fields: { system: 'v2' } } }
    : null;
  expect(systemContextOf(row as never, (unreadablePrev as never))).toEqual({ text: 'v2', changed: null });
  const changed = (id: number) => ({
    detail: { prev_req_id: 6, prev_relation: 'confirmed' },
    meta: { request_fields: { system: id === 7 ? 'v2' : 'v1' } },
  });
  expect(systemContextOf(row as never, (changed as never))).toEqual({ text: 'v2', changed: true });
  // first 或 relation 未确认：只声明当前。
  const firstRow = { req_id: 7 };
  const first = () => ({ detail: { prev_req_id: null, prev_relation: 'first' }, meta: { request_fields: { system: 'v1' } } });
  expect(systemContextOf(firstRow as never, (first as never))).toEqual({ text: 'v1', changed: null });
  // 没有 system 字段就没有上下文步骤，不伪造。
  const noSystem = () => ({ detail: null, meta: { request_fields: null } });
  expect(systemContextOf(row as never, (noSystem as never))).toBeNull();
});

test('结构并集：稀疏已读的 99 可见，40–98 标未读，游标仍为 40', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entryOf(i, `m${i}`));
  entries.push({ ...entryOf(99, 'm99'), input: null, isInput: false });
  const html = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 100 },
    entries,
    structure: {
      next: 40, total: 100,
      ords: Array.from({ length: 40 }, (_, i) => i), loading: false, error: null,
    },
    open: true,
    delta: new Set([99]),
    deltaState: { next: 1, done: true, loading: false, error: null },
    relation: '',
  });
  // 缓存尾部的稀疏消息不被游标过滤掉。
  expect(html).toContain('data-msg="99"');
  // 相邻序号之间的空洞标明未读；连续游标语义不变。
  expect(html).toContain('#40–#98 未读取');
  expect(html).toContain('data-structure-more="1"');
  expect(html).toContain('已读 40 / 100');
  // 已完成的增量只显示数量，不给续读按钮。
  expect(html).not.toContain('data-delta-more');
});

test('增量未完成给续读入口，失败给重试并保留未读位置', () => {
  const base = {
    reqId: 1, row: factsRow, meta: { total: 3 },
    entries: [entryOf(0, 'a'), entryOf(1, 'b'), entryOf(2, 'c')],
    structure: { ...emptyStructure, total: 3, next: 3, ords: [0, 1, 2] },
    delta: new Set([0, 1, 2]),
    relation: '',
  };
  const pending = structureFoldHtml({
    ...base, deltaState: { next: 2, done: false, loading: false, error: null },
  });
  expect(pending).toContain('data-delta-more="1"');
  expect(pending).toContain('已消费 2 / 3');
  const failed = structureFoldHtml({
    ...base, deltaState: { next: 0, done: false, loading: false, error: 'delta_gap' },
  });
  expect(failed).toContain('新增读取失败');
  expect(failed).toContain('delta_gap');
  expect(failed).toContain('data-delta-more="1"');
  expect(failed).toContain('已消费 0 / 3');
  // 无 deltaState 的旧调用形状保持原有数量说明。
  expect(structureFoldHtml({ ...base, deltaState: null })).toContain('新增 3 条消息');
});

test('工具概览显示配对与正文加载两种状态，时长归属说明保留', () => {
  expect(toolOverviewHtml(7, pairOf('resolved', { result_req: 9, result_ord: 2 }), null)).toContain('待读取');
  expect(toolOverviewHtml(7, pairOf('resolved', { result_req: 9, result_ord: 2 }), readingOf('available'))).toContain('已读取');
  expect(toolOverviewHtml(7, pairOf('pending'), null)).toContain('结果位置待定');
  expect(toolOverviewHtml(7, pairOf('ambiguous'), null)).toContain('多个候选');
  expect(toolOverviewHtml(7, null, null)).toContain('还没有见到结果');
  expect(toolOverviewHtml(7, pairOf('resolved'), null)).toContain('工具执行时长未采集');
});

test('协议未适配时结构折叠说明边界，不邀请顺序读取', () => {
  const html = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: null },
    entries: [],
    structure: { ...emptyStructure, total: null },
    delta: null,
    parseState: 'unsupported',
    relation: '',
  });
  expect(html).toContain('协议未适配');
  expect(html).not.toContain('data-structure-more');
  expect(html).not.toContain('尚未读取');
});

// —— 用量读数两列：计时与用量按标签和值成行，缺值与 0 的口径 ——

/** @param {Record<string, unknown>} extra */
const ledgerRow = (extra: Record<string, unknown> = {}) => ({
  req_id: 7, in_tok: 9000, out_tok: 120, cache_read: 10000, cache_write: 700,
  cost: 0.0034, cost_state: 'priced', ms: 2100, ttft_ms: 420, flow_ms: null, ...extra,
});

test('计时两列：首 token 与首个文本分立成行，60ms 差异可见，速度分母用 总 − 首 token', () => {
  const p = ledgerParts(ledgerRow() as never, { ttft_ms: 420, ms: 2100, first_text_ms: 480, flow_ms: null } as never);
  expect(p.timing).toContain('<dl class="chain ledger-chain">');
  expect(p.timing).toContain('首 token');
  expect(p.timing).toContain('0.42 s');
  expect(p.timing).toContain('首个文本');
  expect(p.timing).toContain('0.48 s');
  expect(p.timing).toContain('71 tok/s');
  // 读数组内不再有 · 分隔符；速度口径解释跟随新标签。
  expect(p.timing).not.toContain('·');
  expect(p.timing).toContain('总 − 首 token');
  // 两项相等也分别展示：数值接近不能作为合并依据。
  const equal = ledgerParts(ledgerRow() as never, { ttft_ms: 7636, ms: 9000, first_text_ms: 7636, flow_ms: null } as never);
  expect(equal.timing.match(/7\.64 s/g)?.length).toBe(2);
});

test('计时缺值：仅一项有值只展示一项，全缺不渲染，0 按有值展示', () => {
  const onlyFirst = ledgerParts(ledgerRow({ ttft_ms: 420, ms: null }) as never,
    { ttft_ms: 420, ms: null, first_text_ms: null, flow_ms: null } as never);
  expect(onlyFirst.timing).toContain('首 token');
  expect(onlyFirst.timing).not.toContain('>总<');
  expect(onlyFirst.timing).not.toContain('首个文本');
  const zero = ledgerParts(ledgerRow({ ttft_ms: 0 }) as never,
    { ttft_ms: 0, ms: 2100, first_text_ms: null, flow_ms: null } as never);
  expect(zero.timing).toContain('0.00 s');
  const none = ledgerParts(ledgerRow({ ttft_ms: null, ms: null }) as never,
    { ttft_ms: null, ms: null, first_text_ms: null, flow_ms: null } as never);
  expect(none.timing).toBe('');
  // 缺首 token 时速度分母退回账本 flow_ms。
  const flow = ledgerParts(ledgerRow({ ttft_ms: null, flow_ms: 2000 }) as never,
    { ttft_ms: null, ms: null, first_text_ms: null, flow_ms: 2000 } as never);
  expect(flow.timing).toContain('60 tok/s');
});

test('用量两列：缺值显示 —，全缺不渲染，命中与费用口径不变', () => {
  const p = ledgerParts(ledgerRow() as never, null);
  expect(p.usage).toContain('<dl class="chain ledger-chain">');
  expect(p.usage).toContain('>入<');
  expect(p.usage).toContain('51%');
  expect(p.usage).toContain('$0.0034');
  expect(p.headline).toBe('总 2.10s · 出 120 · 命中 51%');
  // 基础字段缺值保留槽位显示 —；派生行（命中）只在可计算时出现。
  const missing = ledgerParts(ledgerRow({ out_tok: null }) as never, null);
  expect(missing.usage.match(/class="miss"/g)?.length).toBe(1);
  expect(missing.headline).toBe('总 2.10s · 命中 51%');
  const allMissing = ledgerParts(ledgerRow({ in_tok: null, out_tok: null, cache_read: null, cache_write: null }) as never, null);
  expect(allMissing.usage).toBe('');
  expect(allMissing.headline).toBe('');
});

test('窗口外请求传入详情保留首个文本；fold 图例只列正值类别，全零不留空容器', () => {
  const offPage = { ...ledgerRow(), first_text_ms: 480 } as never;
  const rows = ledgerRowsHtml(offPage, offPage);
  expect(rows).toContain('首个文本');
  expect(rows).toContain('0.48 s');
  expect(rows).toContain('9,000');
  const fold = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(), first_text_ms: 480,
    prompt: {
      state: 'recomputed', reason: 'complete', actual_version: 1, tokens: 33500, counted: false,
      window: 200000, held: false, ratio: 0.1675, legacy: false, note: null,
      parts: [
        { kind: 'system', tokens: 31900 }, { kind: 'chat', tokens: 1600 },
        { kind: 'tools', tokens: 0 }, { kind: 'memory', tokens: 0 },
      ],
    },
  } as never);
  expect(fold).toContain('data-fold="prompt:7"');
  expect(fold).toContain('系统提示');
  expect(fold).toContain('对话内容');
  expect(fold).not.toContain('工具定义');
  expect(fold).not.toContain('记忆与技能');
  expect(fold).toContain('提示总量');
  expect(fold).toContain('占用');
  const zeroFold = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: {
      state: 'recomputed', reason: 'complete', actual_version: 1, tokens: 0, counted: false,
      window: null, held: false, ratio: null, legacy: false, note: null,
      parts: [{ kind: 'system', tokens: 0 }, { kind: 'chat', tokens: 0 }],
    },
  } as never);
  expect(zeroFold).not.toContain('comp-bar');
  expect(zeroFold).not.toContain('comp-legend');
  expect(zeroFold).toContain('提示总量');
  expect(zeroFold).toContain('窗口未知');
  const noPrompt = usageFoldHtml(ledgerRow() as never, { ...ledgerRow(), prompt: null } as never);
  expect(noPrompt).toContain('用量与上下文');
  expect(noPrompt).not.toContain('comp-bar');
});

test('URL 页签声明：合法内容页签原样解析与写回，无效或缺省回读数', () => {
  expect(railTabFromParam('body')).toBe('body');
  expect(railTabFromParam('tools')).toBe('tools');
  expect(railTabFromParam('route')).toBe('route');
  expect(railTabFromParam(null)).toBe('facts');
  expect(railTabFromParam('bogus')).toBe('facts');
  expect(railTabParam('facts')).toBeNull();
  expect(railTabParam('body')).toBe('body');
  expect(railTabParam('tools')).toBe('tools');
  expect(railTabParam('route')).toBe('route');
  // 往返一致：解析结果写回 URL 后仍解析出同一页签。
  for (const tab of ['body', 'tools', 'route'] as const) {
    expect(railTabFromParam(railTabParam(tab))).toBe(tab);
  }
});

test('路由读取目标：路由页签且请求已定才读取，其余页签与无请求不触发', () => {
  expect(routeReadTarget('route', 7)).toBe(7);
  expect(routeReadTarget('route', null)).toBeNull();
  expect(routeReadTarget('facts', 7)).toBeNull();
  expect(routeReadTarget('body', 7)).toBeNull();
  expect(routeReadTarget('tools', 7)).toBeNull();
});
