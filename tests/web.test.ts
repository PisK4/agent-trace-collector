import { expect, test } from 'bun:test';
import { restoreScroll } from '../web/app.js';
import { backendStateHtml, backendStateText } from '../web/backend-state.js';
import { replyCompleteness } from '../web/row-summary.js';
import {
  cacheHitOf, contextStatsHtml,
  ledgerParts, ledgerRowsHtml, railFactsHtml, readingChangedNote,
  structureFoldHtml, structureMoreParts, structureUnread, systemContextOf, toolOverviewHtml, toolSchemaSection,
  usageFoldHtml,
} from '../web/rail-facts.js';
import {
  railTabFromParam, railTabParam, resolveTraceTarget, routeReadTarget,
} from '../web/url-route.js';
import { agentLabel, railSummaryListHtml, sessionHead, sessionHiddenFold, sessionsListFoldHtml } from '../web/session-view.js';

test('后端降级只出两种标签，正常与未知模式不占顶栏', () => {
  expect(backendStateText(null)).toBeNull();
  expect(backendStateText({ mode: 'normal', reason: null, at_ms: 1 })).toBeNull();
  expect(backendStateText({ mode: 'future_mode', reason: null, at_ms: 1 })).toBeNull();
  const meta = backendStateText({ mode: 'metadata_only', reason: 'disk_budget', at_ms: 1 });
  expect(meta).toMatchObject({ level: 'warn', label: '存储降级 · 正文暂停' });
  expect(meta?.detail).toContain('磁盘预算已满');
  expect(backendStateText({ mode: 'metadata_only', reason: 'body_budget', at_ms: 1 })?.detail)
    .toContain('正文预算已满');
  const paused = backendStateText({ mode: 'paused', reason: 'disk_free', at_ms: 1 });
  expect(paused).toMatchObject({ level: 'bad', label: '存储降级 · 采集暂停' });
  expect(paused?.detail).toContain('磁盘剩余空间不足');
  // 正常态不渲染节点：顶栏不为正常状态留空位。
  expect(backendStateHtml(null)).toBe('');
  expect(backendStateHtml({ mode: 'normal', reason: null, at_ms: 1 })).toBe('');
  const html = backendStateHtml({ mode: 'metadata_only', reason: 'disk_budget', at_ms: 1 });
  expect(html).toContain('id="backend-state"');
  expect(html).toContain('class="backend-chip warn"');
  expect(html).toContain('存储降级 · 正文暂停');
  expect(html).toContain('磁盘预算已满');
});

test('请求记录入口只列被省略的请求，按窗口序号定位', () => {
  const rows = [
    { req_id: 4, body_state: 'available' }, { req_id: 7, body_state: 'evicted' }, { req_id: 9, body_state: 'pending' },
  ] as never[];
  // 没有省略就不出入口。
  expect(sessionHiddenFold(rows, [], 'k', false)).toBe('');
  const html = sessionHiddenFold(rows, rows.slice(1), 'k', false);
  expect(html).toContain('data-fold="hidden:k"');
  expect(html).toContain('data-summary-req="7"');
  expect(html).toContain('data-summary-req="9"');
  // 序号是窗口内位置，不是请求号；正文状态原样说出缺口类型。
  expect(html).toContain('<span class="mono">02</span>');
  expect(html).toContain('正文已回收');
  expect(html).toContain('正文未到');
  expect(html).not.toContain('data-summary-req="4"');
});

test('折叠行：探针与旁路各自计数，展开与收起如实标注', () => {
  const row = (flags: string[]) => ({
    conv_key: 'k', title: 't', last_ms: 1, request_count: 1, agents: [], flags,
  });
  expect(sessionsListFoldHtml([row([]), row([])], false)).toBe('');
  expect(sessionsListFoldHtml([row(['probe']), row(['probe']), row(['bypass']), row([])], false))
    .toContain('已折叠 2 条探针记录 · 1 条旁路会话（已加载页）');
  expect(sessionsListFoldHtml([row(['bypass'])], false)).toContain('已折叠 1 条旁路会话（已加载页）');
  expect(sessionsListFoldHtml([row(['probe']), row(['probe'])], true)).toContain('收起 2 条探针记录');
});

test('会话汇总配对列表的调用 chip 带工具身份色', () => {
  const list = {
    kind: 'pair', param: 'Bash', label: 'Bash 调用', loading: false, error: null,
    data: {
      items: [
        { req_id: 7, ord: 1, tool_name: 'Bash', state: 'resolved' },
        { req_id: 8, ord: 2, tool_name: null, state: 'resolved' },
      ],
      truncated: false,
    },
  };
  const html = railSummaryListHtml(list, id => `#${id}`);
  // 调用 chip 中性化：不再携带工具身份色类。
  expect(html).toContain('<span class="tool-chip call" title="Bash">');
  // 名字缺失时不冒充已知工具：文本照旧写 unknown。
  expect(html).toContain('tool-chip call" title="">');
  expect(html).toContain('unknown · 调用 #2');
});

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
const emptyStructure = { back: 0, next: 0, total: 45, ords: [], loading: false, error: null };
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
  // 首读由展开触发，之前没有「加载更早」；未读取也给出说明，不给空消息列表冒充。
  expect(closed).not.toContain('data-structure-more');
  expect(closed).toContain('尚未读取');
  expect(closed).toContain('从末尾读取最近 40 条');
  // 尾片已读、前面还有更早的消息：按钮在列表上方，文案说明已读窗口。
  const tail = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [entryOf(5, 'm5')],
    structure: { ...emptyStructure, back: 5, next: 45, ords: [5] },
    open: true, delta: new Set<number>(), relation: '',
  });
  expect(tail).toContain('data-structure-more="1"');
  expect(tail).toContain('加载更早（已读 5–45 / 45）');
  expect(tail.indexOf('加载更早')).toBeLessThan(tail.indexOf('msg-list'));
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

test('结构从未读过时按总数判断未读：给从末尾读取的入口，不写「已读 0–0」', () => {
  const html = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries: [entryOf(5, 'm5')],
    structure: { back: 0, next: 0, total: null, ords: [], loading: false, error: null },
    open: true, delta: new Set<number>(), relation: '',
  });
  expect(html).toContain('data-structure-more="1"');
  expect(html).toContain('从末尾读取（共 45 条）');
  expect(html).not.toContain('已读 0–0');
  expect(structureUnread({ back: 0, next: 0, total: null, loading: false, error: null }, 45)).toBe(true);
  expect(structureUnread({ back: 0, next: 0, total: null, loading: false, error: null }, null)).toBe(false);
  expect(structureUnread({ back: 0, next: 0, total: 45, loading: false, error: null }, 45)).toBe(false);
  expect(structureUnread({ back: 3, next: 45, total: 45, loading: false, error: null }, 45)).toBe(true);
  expect(structureUnread({ back: 0, next: 0, total: null, loading: false, error: 'body_page_gap' }, null)).toBe(true);
});

test('中栏选中的消息在结构列表里高亮，不展开详情', () => {
  const entries = [entryOf(0, '问'), entryOf(1, '答')];
  const structure = { ...emptyStructure, total: 45, next: 2, ords: [0, 1] };
  const html = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries, structure, highlight: 1, delta: null, relation: '',
  });
  expect(html).toContain('data-msg="1"');
  expect(html).toContain('<li class="msg" data-ord="1" aria-current="true">');
  expect(html).not.toContain('data-structure-back');
  // 结构列表里点开的那条才替换成详情，返回按钮回到列表。
  const detail = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 45 }, entries, structure, selected: 1, highlight: 1, delta: null, relation: '',
  });
  expect(detail).toContain('data-structure-back="1"');
  expect(detail).not.toContain('data-msg=');
  // 返回入口排在详情之前：长正文把页脚推出视口时，返回不能跟着沉底。
  expect(detail.indexOf('data-structure-back')).toBeLessThan(detail.indexOf('body-panel'));
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
    reqId: 1, row: factsRow, meta: { total: 45, message_location: { key: 'messages', form: 'array' } }, entries, structure, selected: 1, delta: null, relation: '',
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

test('结构消息详情按骨架形态显示原始位置', () => {
  const base = {
    reqId: 1, row: factsRow, entries: [entryOf(0, '合成命令')],
    structure: { ...emptyStructure, total: 1, next: 1, ords: [0] },
    selected: 0, delta: null, relation: '',
  };
  const bare = structureFoldHtml({ ...base, meta: { total: 1, message_location: { key: 'input', form: 'string' } } });
  expect(bare).toContain('>input</span>');
  expect(bare).not.toContain('input[0]');
  expect(bare).toContain('data-copy-msg="0"');
  const array = structureFoldHtml({ ...base, meta: { total: 1, message_location: { key: 'input', form: 'array' } } });
  expect(array).toContain('input[0]');
  const unknown = structureFoldHtml({ ...base, meta: { total: 1 } });
  expect(unknown).not.toContain('bp-path');
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

test('结构并集：稀疏已读的 99 可见，40–98 标未读，已读窗口不被缓存尾部改写', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entryOf(i, `m${i}`));
  entries.push({ ...entryOf(99, 'm99'), input: null, isInput: false });
  const html = structureFoldHtml({
    reqId: 1, row: factsRow, meta: { total: 100 },
    entries,
    structure: {
      back: 60, next: 100, total: 100,
      ords: Array.from({ length: 40 }, (_, i) => i), loading: false, error: null,
    },
    open: true,
    delta: new Set([99]),
    deltaState: { next: 1, done: true, loading: false, error: null },
    relation: '',
  });
  // 缓存尾部的稀疏消息不被游标过滤掉。
  expect(html).toContain('data-msg="99"');
  // 相邻序号之间的空洞标明未读；已读窗口仍是尾片。
  expect(html).toContain('#40–#98 未读取');
  expect(html).toContain('data-structure-more="1"');
  expect(html).toContain('已读 60–100 / 100');
  // 已完成的增量只显示数量，不给续读按钮。
  expect(html).not.toContain('data-delta-more');
});

test('增量未完成给续读入口，失败给重试并保留未读位置', () => {
  const base = {
    reqId: 1, row: factsRow, meta: { total: 3 },
    entries: [entryOf(0, 'a'), entryOf(1, 'b'), entryOf(2, 'c')],
    structure: { ...emptyStructure, total: 3, back: 0, next: 3, ords: [0, 1, 2] },
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
  expect(toolOverviewHtml(7, pairOf('resolved'), null)).toContain('执行段按结果请求开始减调用请求结束推算');
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

test('用量两列：缺值显示 —，全缺不渲染，缓存读数悬停指向构成区与会话头', () => {
  const p = ledgerParts(ledgerRow() as never, null);
  expect(p.usage).toContain('<dl class="chain ledger-chain">');
  expect(p.usage).toContain('>入<');
  expect(p.usage).toContain('$0.0034');
  // 用量两列不设请求级命中行：请求级命中在构成区「提示词缓存」，
  // 会话级命中在会话头合计行，缓读行的悬停两处都指过去。
  expect(p.usage).not.toContain('>命中<');
  expect(p.usage).toContain('请求级命中见构成区「提示词缓存」，会话级命中见会话头合计行');
  // 基础字段缺值保留槽位显示 —。
  const missing = ledgerParts(ledgerRow({ out_tok: null }) as never, null);
  expect(missing.usage.match(/class="miss"/g)?.length).toBe(1);
  const allMissing = ledgerParts(ledgerRow({ in_tok: null, out_tok: null, cache_read: null, cache_write: null }) as never, null);
  expect(allMissing.usage).toBe('');
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
  // 零值类别不进图例；固定开销的悬停说明里出现类别名不算图例。
  expect(fold).not.toContain('data-ctx-kind="tools"');
  expect(fold).not.toContain('data-ctx-kind="memory"');
  expect(fold).toContain('已用上下文');
  expect(fold).toContain('33.5k');
  // 窗口与已用比例降为副行；缓存读数不再与命中率重复，缓读/新入收进用量明细。
  expect(fold).toContain('总 200.0k · 已用 17%');
  expect(fold).not.toContain('/ 总上下文');
  expect(fold).not.toContain('窗口进度');
  expect(fold).toContain('固定开销');
  expect(fold).toContain('占已用 95%');
  expect(fold).toContain('提示词缓存');
  expect(fold).toContain('53%');
  expect(fold).not.toContain('缓读 10.0k · 新入 9.0k');
  // 计时四行合成一个耗时指标，副行保留首 token、首个文本与速度。
  expect(fold).toContain('耗时');
  expect(fold).toContain('<b>2.10</b><span>s</span>');
  expect(fold).toContain('首 token 0.42 s · 首个文本 0.48 s · 71 tok/s');
  // 用量明细是二级折叠，默认收起，开合按 data-fold 恢复。
  expect(fold).toContain('<details class="usage-more" data-fold="usage:7">');
  expect(fold).not.toContain('<details class="usage-more" data-fold="usage:7" open>');
  expect(fold).toContain('>入<');
  expect(fold).toContain('$0.0034');
  // 折叠行摘要不再挂「总 · 出」：总在耗时里，出在明细里。
  expect(fold).not.toContain('class="fold-count"');
  const zeroFold = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: {
      state: 'recomputed', reason: 'complete', actual_version: 1, tokens: 0, counted: false,
      window: null, held: false, ratio: null, legacy: false, note: null,
      parts: [{ kind: 'system', tokens: 0 }, { kind: 'chat', tokens: 0 }],
    },
  } as never);
  expect(zeroFold).not.toContain('class="ctx-map"');
  expect(zeroFold).not.toContain('comp-legend');
  expect(zeroFold).toContain('已用上下文');
  expect(zeroFold).toContain('模型的窗口大小未知');
  expect(zeroFold).toContain('没有可用分母');
  // 没有路由侧的 prompt 分析时指标仍然渲染，四格各自说明缺什么。
  const noPrompt = usageFoldHtml(ledgerRow() as never, { ...ledgerRow(), prompt: null } as never);
  expect(noPrompt).toContain('用量与上下文');
  expect(noPrompt).toContain('class="ctx-stats"');
  expect(noPrompt).toContain('没有路由侧的 prompt 分析');
  expect(noPrompt).toContain('没有构成分类');
});

test('构成区集成：treemap 与内容列表进折叠行，本地估计贴构成区，占用 pill 按阈值出现', () => {
  const sevenKinds = {
    state: 'recomputed', reason: 'complete', actual_version: 1, tokens: 185300, counted: true,
    window: 200000, held: null, turns: 2, ratio: 0.9265, legacy: false, note: null,
    parts: [
      { kind: 'system', tokens: 4820, items: [{ name: '系统提示', tag: null, n: null, tokens: 4820 }] },
      {
        kind: 'files', tokens: 47380,
        items: [
          { name: 'src/http.ts', tag: 'read', n: null, tokens: 8460 },
          { name: 'src/queries/requests.ts', tag: 'read', n: null, tokens: 6210 },
          { name: '另外 7 项', tag: 'more', n: 7, tokens: 4700 },
        ],
      },
      {
        kind: 'results', tokens: 29760,
        items: [{ name: 'Bash', tag: 'result', n: 62, tokens: 26680 }],
      },
      { kind: 'skills', tokens: 3810, items: [{ name: 'skills', tag: 'skills', n: null, tokens: 3810 }] },
      { kind: 'chat', tokens: 79770, items: [{ name: '2', tag: 'turn', n: null, tokens: 79770 }] },
    ],
  };
  // 校准行、占用 ≥90%：treemap、图例、列表、四指标都在，pill 出「占满」。
  const full = usageFoldHtml(ledgerRow() as never, { ...ledgerRow(), prompt: sevenKinds } as never);
  expect(full).toContain('class="ctx-map"');
  expect(full).toContain('class="ctx-rows"');
  expect(full).toContain('>Bash<');
  expect(full).toContain('×62');
  expect(full).toContain('已用上下文');
  expect(full).toContain('185.3k');
  expect(full).toContain('总 200.0k · 已用 93%');
  expect(full).toContain('固定开销');
  expect(full).toContain('8.6k');
  expect(full).toContain('占已用 5%');
  expect(full).toContain('提示词缓存');
  expect(full).toContain('class="u-pill warn">占满</span>');
  expect(full).not.toContain('本地估计');
  // 占用 75%–90%：出「接近占满」；<75% 正常态零状态提示。
  const near = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: { ...sevenKinds, tokens: 160000, ratio: 0.8 },
  } as never);
  expect(near).toContain('class="u-pill warn">接近占满</span>');
  const calm = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: { ...sevenKinds, tokens: 60000, ratio: 0.3 },
  } as never);
  expect(calm).not.toContain('u-pill warn');
  expect(calm).not.toContain('接近占满');
  // 估算行（counted=false）：「本地估计」pill 贴在已用上下文标签，不藏在折叠深处的说明段。
  const est = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: { ...sevenKinds, counted: false },
  } as never);
  expect(est).toContain('已用上下文<span class="u-pill" title="分类按请求正文估算，未经本次回复的实测 token 校准">本地估计</span>');
  expect(est).not.toContain('<p class="note">本地估计');
  // 窗口未知：副行说明缺窗口，不给分母与比例，treemap 全幅铺已用部分。
  const nowin = usageFoldHtml(ledgerRow() as never, {
    ...ledgerRow(),
    prompt: { ...sevenKinds, window: null, ratio: null },
  } as never);
  expect(nowin).toContain('模型的窗口大小未知');
  // 固定开销的分母是已用上下文，窗口未知不影响它。
  expect(nowin).toContain('占已用 5%');
  expect(nowin).not.toContain('总 200.0k');
  expect(nowin).not.toContain('93%');
  expect(nowin).not.toContain('stroke-dasharray');
});

test('上下文四指标：已用、固定开销、请求级缓存与耗时按缺失态各自留白', () => {
  const prompt = (extra: Record<string, unknown> = {}) => ({
    state: 'recomputed', reason: 'complete', actual_version: 1, tokens: 22200, counted: true,
    window: 128000, held: false, ratio: 0.1734, legacy: false, note: null,
    parts: [
      { kind: 'system', tokens: 12000 }, { kind: 'tools', tokens: 3000 }, { kind: 'chat', tokens: 7200 },
    ], ...extra,
  });
  const stats = contextStatsHtml(ledgerRow() as never, prompt() as never);
  expect(stats).toContain('已用上下文');
  expect(stats).toContain('22.2k');
  // 窗口与进度合成副行一句，不再另起一列。
  expect(stats).toContain('总 128.0k · 已用 17%');
  expect(stats).not.toContain('窗口进度');
  expect(stats).toContain('固定开销');
  expect(stats).toContain('15.0k');
  expect(stats).toContain('占已用 68%');
  expect(stats).toContain('提示词缓存');
  expect(stats).toContain('53%');
  // 缓存不再画条，也不复述缓读与新入：明细在「用量明细」。
  expect(stats).not.toContain('class="ctx-bar"');
  expect(stats).not.toContain('缓读');
  // 耗时是整笔时长，副行写首 token 与速度；首个文本只从详情取，未读正文时副行没有这一项。
  expect(stats).toContain('耗时');
  expect(stats).toContain('<b>2.10</b><span>s</span>');
  expect(stats).toContain('首 token 0.42 s · 71 tok/s');
  expect(stats).not.toContain('首个文本 0.48 s');
  const withDetail = contextStatsHtml(ledgerRow() as never, prompt() as never,
    { ttft_ms: 420, ms: 2100, first_text_ms: 480, flow_ms: null } as never);
  expect(withDetail).toContain('首 token 0.42 s · 首个文本 0.48 s · 71 tok/s');
  // 窗口未知：不给分母、不给比例，固定开销与缓存照常。
  const nowin = contextStatsHtml(ledgerRow() as never, prompt({ window: null, ratio: null }) as never);
  expect(nowin).toContain('模型的窗口大小未知');
  expect(nowin).not.toContain('已用 17%');
  expect(nowin).not.toContain('没有可用分母');
  expect(nowin).toContain('占已用 68%');
  expect(nowin).toContain('53%');
  // 旧结果不按旧输入算比例，副行只留总上下文。
  const retained = contextStatsHtml(ledgerRow() as never, prompt({ state: 'retained', ratio: null }) as never);
  expect(retained).toContain('总 128.0k · 不计算进度');
  expect(retained).not.toContain('17%');
  // 缺缓存读数：— 与说明。
  const nocache = contextStatsHtml(ledgerRow({ in_tok: null }) as never, prompt() as never);
  expect(nocache).toContain('缓存读数未上报');
  // 合法 0 照常显示，不当作缺失。
  const zero = contextStatsHtml(ledgerRow({ cache_read: 0 }) as never, prompt() as never);
  expect(zero).toContain('0%');
  // 没有构成分类不给数；分类内全为 0 是真实读数，照常给 0 与占比。
  const noParts = contextStatsHtml(ledgerRow() as never, prompt({ parts: [] }) as never);
  expect(noParts).toContain('没有构成分类');
  expect(noParts).not.toContain('占已用');
  const zeroFixed = contextStatsHtml(ledgerRow() as never, prompt({ parts: [{ kind: 'chat', tokens: 22200 }] }) as never);
  expect(zeroFixed).toContain('占已用 0%');
  // 没有 prompt 分析：四格留白并各自说明缺什么，不整块隐藏。
  const noPrompt = contextStatsHtml(ledgerRow() as never, null);
  expect(noPrompt).toContain('没有路由侧的 prompt 分析');
  expect(noPrompt).toContain('没有构成分类');
  expect(noPrompt).toContain('耗时');
});

test('缓存命中与会话头同口径：缺一读数或分母为 0 不给数，0 命中照常给 0', () => {
  expect(cacheHitOf(ledgerRow() as never)).toEqual({ hit: 10000 / 19000, read: 10000, fresh: 9000 });
  expect(cacheHitOf(ledgerRow({ in_tok: null }) as never).hit).toBeNull();
  expect(cacheHitOf(ledgerRow({ cache_read: null }) as never).hit).toBeNull();
  expect(cacheHitOf(ledgerRow({ in_tok: 0, cache_read: 0 }) as never).hit).toBeNull();
  expect(cacheHitOf(ledgerRow({ cache_read: 0 }) as never).hit).toBe(0);
});

test('effort 读数：request_fields 有值才显示该行，缺字段或未读正文不显示', () => {
  const withEffort = usageFoldHtml(ledgerRow() as never, null, {
    state: 'available', request_fields: { reasoning_effort: 'high' },
  } as never);
  expect(withEffort).toContain('<dt>effort</dt>');
  expect(withEffort).toContain('>high<');
  const withoutField = usageFoldHtml(ledgerRow() as never, null, {
    state: 'available', request_fields: {},
  } as never);
  expect(withoutField).not.toContain('<dt>effort</dt>');
  const noMeta = usageFoldHtml(ledgerRow() as never, null);
  expect(noMeta).not.toContain('<dt>effort</dt>');
  // 非字符串值不显示，不冒充有读数。
  const badValue = usageFoldHtml(ledgerRow() as never, null, {
    state: 'available', request_fields: { reasoning_effort: 3 },
  } as never);
  expect(badValue).not.toContain('<dt>effort</dt>');
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

test('agent 标签覆盖三条通道的已知来源，未知来源原样透出', () => {
  expect(agentLabel('claude')).toBe('Claude Code');
  expect(agentLabel('omp')).toBe('OMP');
  expect(agentLabel('codex')).toBe('Codex');
  expect(agentLabel('hermes')).toBe('Hermes');
  expect(agentLabel('someone-new')).toBe('someone-new');
});

test('结构续读按钮：读取中禁用，失败时改重试并给出原因', () => {
  const loading = structureMoreParts({ back: 4, next: 44, loading: true, error: null }, 7, 44);
  expect(loading.button).toContain('disabled');
  expect(loading.button).toContain('加载更早（已读 4–44 / 44）');
  expect(loading.note).toBe('');
  const failed = structureMoreParts({ back: 3, next: 44, loading: false, error: 'body_page_gap' }, 7, 44);
  expect(failed.button).toContain('重试读取');
  expect(failed.button).not.toContain('disabled');
  expect(failed.note).toContain('结构读取失败：body_page_gap');
});

// 会话头双列分组的合成夹具：行、身份与一份覆盖各分组事实的汇总快照。
const requestRow = (over: Record<string, unknown> = {}) => ({
  req_id: 1, started_ms: 1, in_tok: null, out_tok: null, cache_read: null, cache_write: null,
  cost: null, cost_state: 'absent', ms: null, ttft_ms: null, flow_ms: null, ...over,
});
const headBase = {
  sessionKey: 'k',
  row: { conv_key: 'k', title: 't', last_ms: 1, request_count: 2, agents: [], flags: [] },
  refreshedAt: null, missingReqId: null, offPageReqId: null, windowError: null,
  summary: null, windowAnchor: 'start' as const,
};
const summaryFixture = (over: Record<string, unknown> = {}) => ({
  tools: [{ name: 'Bash', count: 3, paired: 3, error_known: 3, errors: 1 }],
  paths: { written: [{ path: 'src/a.ts', count: 2 }], read: [{ path: 'docs/r.md', count: 1 }] },
  skills: [{ name: 'ponytail', count: 2 }],
  interrupts: { count: 0, requests: [], unknown: 0 },
  totals: { in_tok: 100, out_tok: 50, cost: 0.5, cost_absent: 0, cache_hit: 0.5 },
  structure: {
    requests_total: 5, main: 4, bypass: 1, subagent_actors: 0, subagent_requests: 0,
    retries: 0, context_peak_pct: 30, models: [{ name: 'm', count: 5 }],
  },
  coverage: { calls_total: 3, calls_paired: 3, calls_error_known: 3, calls_fact_known: 3 },
  failures: [], failures_truncated: false, dirty: false,
  ...over,
});

test('会话头输出速度只统计计时与输出都在的行', () => {
  // 只有输出、没有任何计时：没有分母，不给速度。
  const untimed = requestRow({ req_id: 1, out_tok: 4 });
  const noTiming = sessionHead({ ...headBase, rows: [untimed] as never });
  expect(noTiming).not.toContain('tok/s');
  // 一行无计时、一行有计时：分母只算有计时的那行，分子也必须只算同一行。
  const timed = requestRow({ req_id: 2, out_tok: 100, ms: 2000, ttft_ms: 500, flow_ms: 1500 });
  const mixed = sessionHead({ ...headBase, rows: [untimed, timed] as never });
  expect(mixed).toContain('<b>67</b> tok/s');
  expect(mixed).toContain('首字 <b>0.50 s</b>');
});

test('会话头汇总状态：资源回退可见标明已加载窗口，读取中与不可用分开说', () => {
  const row = requestRow({ req_id: 1, out_tok: 3 });
  const loading = sessionHead({ ...headBase, rows: [row] as never, summaryStatus: 'loading' });
  // 回退口径可见标明，不只在悬停里换范围；读取中不冒充不可用。
  expect(loading).toContain('scope-tag">已加载窗口</span>');
  expect(loading).toContain('汇总快照读取中');
  expect(loading).not.toContain('汇总快照不可用');
  const absent = sessionHead({ ...headBase, rows: [row] as never, summaryStatus: 'absent' });
  expect(absent).toContain('scope-tag">已加载窗口</span>');
  expect(absent).toContain('汇总快照不可用');
  expect(absent).not.toContain('汇总快照读取中');
  // 窗口没有任何用量读数时资源组不渲染：不给 0，也不给替代文字。
  const empty = sessionHead({ ...headBase, rows: [], summaryStatus: 'loading' });
  expect(empty).not.toContain('已加载窗口');
  expect(empty).not.toContain('cue-board');
});

test('会话头双列：左右分组、副标题删除与身份行', () => {
  const html = sessionHead({
    ...headBase, rows: [requestRow({ req_id: 2, in_tok: 10, out_tok: 5, ms: 2000, ttft_ms: 500 })] as never,
    summary: summaryFixture() as never, summaryStatus: 'ready',
  });
  // 左右两列与七个分组各就各位。
  expect(html).toContain('cue-account');
  expect(html).toContain('cue-activity');
  for (const label of ['资源', '结构', '性能', '工具', 'Skill', '写入尝试', '读取请求']) {
    expect(html).toContain(`<strong>${label}</strong>`);
  }
  // 七处常驻副标题不再出现，也没有换成同类副标题。
  expect(html).not.toContain('<small');
  expect(html).not.toContain('会话合计');
  expect(html).not.toContain('次工具');
  // 统计范围与总数改为按需说明，键盘可达（tabindex + data-desc）。
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('data-desc="整个会话：调用 3 次');
  // 身份行保留已加载请求数；路径条目可定位。
  expect(html).toContain('已加载 <b>1</b> 笔 Request');
  expect(html).toContain('data-summary-path="src/a.ts"');
});

test('空集合的分组整组隐藏，右列全空不留空列', () => {
  const noSkill = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ skills: [] }) as never, summaryStatus: 'ready',
  });
  expect(noSkill).not.toContain('<strong>Skill</strong>');
  expect(noSkill).not.toContain('data-summary-skill');
  const rightEmpty = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ tools: [], paths: { written: [], read: [] }, skills: [] }) as never,
    summaryStatus: 'ready',
  });
  expect(rightEmpty).not.toContain('cue-activity');
  expect(rightEmpty).toContain('cue-board solo');
  expect(rightEmpty).toContain('<strong>资源</strong>');
});

test('工具组的失败入口与中断计数按非零出现', () => {
  const withIssues = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ interrupts: { count: 2, requests: [], unknown: 1 } }) as never,
    summaryStatus: 'ready',
  });
  expect(withIssues).toContain('data-summary-failures');
  expect(withIssues).toContain('⚠ 1 失败');
  expect(withIssues).toContain('已识别用户中断 <b>2</b>');
  expect(withIssues).toContain('1 笔请求的中断判定缺失');
  const clean = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({
      tools: [{ name: 'Bash', count: 3, paired: 3, error_known: 3, errors: 0 }],
    }) as never,
    summaryStatus: 'ready',
  });
  expect(clean).not.toContain('data-summary-failures');
  expect(clean).not.toContain('已识别用户中断');
  // 未判定的结果在 chip 悬停里如实说明，不冒充失败。
  const unknownResult = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({
      tools: [{ name: 'Bash', count: 3, paired: 3, error_known: 2, errors: 0 }],
    }) as never,
    summaryStatus: 'ready',
  });
  expect(unknownResult).not.toContain('data-summary-failures');
  expect(unknownResult).toContain('1 次结果未判定（不计入失败）');
});

test('费用缺值不给 0，缺值笔数进按需说明', () => {
  const html = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({
      totals: { in_tok: 100, out_tok: 50, cost: null, cost_absent: 2, cache_hit: null },
    }) as never,
    summaryStatus: 'ready',
  });
  expect(html).toContain('提示 <b>');
  expect(html).not.toContain('费用 <b>');
  expect(html).not.toContain('$');
  expect(html).toContain('2 笔未取得费用');
  expect(html).toContain('本次没有可用分母，不给数');
});

test('结构组条件字段非零才出现', () => {
  const html = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({
      structure: {
        requests_total: 5, main: 4, bypass: 1, subagent_actors: 2, subagent_requests: 5,
        retries: 3, context_peak_pct: 41, models: [{ name: 'a', count: 3 }, { name: 'b', count: 2 }],
      },
    }) as never,
    summaryStatus: 'ready',
  });
  expect(html).toContain('主链 <b>4</b> · 旁路 <b>1</b>');
  expect(html).toContain('峰值 <b>41%</b>');
  expect(html).toContain('子代理 <b>2</b> 个 · <b>5</b> 笔');
  expect(html).toContain('重试 <b>3</b> 笔');
  expect(html).toContain('模型 <b>2</b>');
  const quiet = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({
      structure: {
        requests_total: 5, main: 4, bypass: 1, subagent_actors: 0, subagent_requests: 0,
        retries: 0, context_peak_pct: 41, models: [{ name: 'a', count: 5 }],
      },
    }) as never,
    summaryStatus: 'ready',
  });
  // 「子代理」一词也出现在资源组的口径说明里；这里断言的是结构组的读数槽。
  expect(quiet).not.toContain('子代理 <b>');
  expect(quiet).not.toContain('重试 <b>');
  expect(quiet).not.toContain('模型 <b>');
});

test('汇总过期出现可见警示，正常态不出现', () => {
  const stale = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ dirty: true }) as never, summaryStatus: 'ready',
  });
  expect(stale).toContain('派生还没追上输入');
  const fresh = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture() as never, summaryStatus: 'ready',
  });
  expect(fresh).not.toContain('派生还没追上输入');
});

test('无正文请求入口落在性能组，展开清单可定位', () => {
  const hidden = [{ req_id: 7, body_state: 'evicted' }, { req_id: 9, body_state: 'pending' }];
  const html = sessionHead({
    ...headBase, rows: [requestRow({ req_id: 1 })] as never, hiddenRows: hidden as never,
    summary: null, summaryStatus: 'absent',
  });
  expect(html).toContain('hidden-more');
  expect(html).toContain('data-fold="hidden:k"');
  expect(html).toContain('无正文 <b>2</b> 笔');
  expect(html).toContain('<strong>性能</strong>');
  expect(html).toContain('data-summary-req="7"');
});

test('工具组前三直接可见，其余进 +N 展开', () => {
  const five = ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch'].map((name, i) => ({
    name, count: 5 - i, paired: 5 - i, error_known: 5 - i, errors: 0,
  }));
  const capped = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ tools: five }) as never, summaryStatus: 'ready',
  });
  expect(capped).toContain('path-more t');
  expect(capped).toContain('<summary title="工具共 5 把">+2</summary>');
  expect(capped).toContain('data-summary-tool="Bash"');
  expect(capped).toContain('data-summary-tool="Write"');
  expect(capped).toContain('data-summary-tool="ToolSearch"');
  const three = sessionHead({
    ...headBase, rows: [requestRow()] as never,
    summary: summaryFixture({ tools: five.slice(0, 3) }) as never, summaryStatus: 'ready',
  });
  expect(three).not.toContain('path-more t');
  expect(three).toContain('data-summary-tool="Edit"');
});

test('会话标题转义后进入头部', () => {
  const html = sessionHead({
    ...headBase,
    row: { conv_key: 'k', title: '<img src=x onerror=alert(1)>', last_ms: 1, request_count: 1, agents: [], flags: [] },
    rows: [requestRow()] as never,
    summary: summaryFixture() as never, summaryStatus: 'ready',
  });
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
});
