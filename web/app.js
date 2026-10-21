// @ts-check
/**
 * 读者前端。所有数据来自 /api/*，没有任何演示常量。
 * @typedef {import('../src/queries').RequestDetail} RequestDetail
 * @typedef {import('../src/queries').RequestRow} RequestRow
 * @typedef {import('../src/queries').SessionRow} SessionRow
 * @typedef {import('../src/queries').CostState} CostState
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {ReturnType<typeof messageEntries>[number]} MessageEntry
 * @typedef {(url: string) => Promise<Response>} ReaderFetch
 * @typedef {{request: RequestDetail | null, requestState: 'loading' | 'error' | 'empty' | 'ready', sessionKey: string | null, error: string | null, sessions: SessionRow[], sessionsCursor: string | null, requests: RequestRow[], requestsCursor: string | null, requestsError: string | null}} ReaderState
 * @typedef {{loadSessions: (cursor?: string) => Promise<void>, loadRequests: (cursor?: string) => Promise<void>, selectSession: (key: string) => Promise<void>, selectRequest: (id: number) => Promise<void>, getState: () => ReaderState, loadBody: (id: number, from: number) => Promise<BodyPage>}} Reader
 * @typedef {{page: BodyPage | null, entries: MessageEntry[], nextFrom: number, total: number | null, exhausted: boolean, error: string | null}} LoadedBody
 */

import {
  bodyNotice, deltaOrdinals, mdToHtml, messageEntries, roleTag,
  renderMessageDetail, renderMessages, renderRaw, renderReply, renderReplyDetail, renderTools,
  replyView, toolEntries,
} from './body-view.js';

/** @param {ReaderFetch} fetcher @returns {Reader} */
export function createReader(fetcher) {
  /** @type {ReaderState} */
  const state = {
    request: null, requestState: 'empty', sessionKey: null, error: null,
    sessions: [], sessionsCursor: null, requests: [], requestsCursor: null, requestsError: null,
  };
  let selectionEpoch = 0;
  let requestEpoch = 0;

  /** @param {string} url */
  async function readJSON(url) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  }

  /** @param {string} [cursor] */
  async function loadSessions(cursor) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page = await readJSON(`/api/sessions${query}`);
    const byKey = new Map((cursor ? state.sessions : []).map(row => [row.conv_key, row]));
    for (const row of page.items) byKey.set(row.conv_key, row);
    state.sessions = [...byKey.values()];
    state.sessionsCursor = page.next_cursor;
  }

  /** @param {string} [cursor] */
  async function loadRequests(cursor) {
    const key = state.sessionKey;
    if (key === null) return;
    const epoch = ++requestEpoch;
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    // 失败要留到 state 里：静默空表会把网络故障读成"这个会话没有请求"。
    // 分页失败时也保留已加载的行，只是不再追加。
    state.requestsError = null;
    try {
      const page = await readJSON(`/api/sessions/${encodeURIComponent(key)}/requests${query}`);
      if (epoch !== requestEpoch || key !== state.sessionKey) return;
      const byId = new Map((cursor ? state.requests : []).map(row => [row.req_id, row]));
      for (const row of page.items) byId.set(row.req_id, row);
      state.requests = [...byId.values()];
      state.requestsCursor = page.next_cursor;
    } catch (error) {
      if (epoch !== requestEpoch || key !== state.sessionKey) return;
      state.requestsError = error instanceof Error ? error.message : 'request_list_failed';
    }
  }

  /** @param {string} key */
  async function selectSession(key) {
    ++selectionEpoch;
    state.sessionKey = key;
    state.request = null;
    state.requestState = 'empty';
    state.error = null;
    state.requests = [];
    state.requestsCursor = null;
    state.requestsError = null;
    await loadRequests();
  }

  /** @param {number} id */
  async function selectRequest(id) {
    const epoch = ++selectionEpoch;
    state.requestState = 'loading';
    state.error = null;
    try {
      const request = await readJSON(`/api/requests/${id}`);
      if (epoch !== selectionEpoch) return;
      state.request = request;
      state.requestState = 'ready';
    } catch (error) {
      if (epoch !== selectionEpoch) return;
      state.requestState = 'error';
      state.error = error instanceof Error ? error.message : 'request_failed';
    }
  }

  /**
   * 正文按区间取：只拉当前要显示的一片，不保存全文。
   * @param {number} id
   * @param {number} from
   * @returns {Promise<BodyPage>}
   */
  async function loadBody(id, from) {
    return await readJSON(`/api/requests/${id}/body?from=${from}&to=${from + 40}`);
  }

  return { loadSessions, loadRequests, selectSession, selectRequest, getState: () => state, loadBody };
}

/* ------------------------------------------------------------------
   以下只在浏览器里执行；测试导入模块不会触碰 DOM。
   ------------------------------------------------------------------ */

/**
 * URL 里的 trace 属于哪种情况。合并过的旧 id 会被服务端解析成 canonical：
 * 若 canonical 就在已加载页里，直接跳过去，不能报"未在已加载页"。
 * @param {{req_id: number}[]} rows
 * @param {number} requested
 * @param {{req_id: number} | null} detail canonical 详情；null 表示库里不存在
 * @returns {{kind: 'in-page' | 'canonical' | 'off-page' | 'missing', reqId: number | null}}
 */
export function resolveTraceTarget(rows, requested, detail) {
  if (rows.some(row => row.req_id === requested)) return { kind: 'in-page', reqId: requested };
  if (detail === null) return { kind: 'missing', reqId: null };
  if (rows.some(row => row.req_id === detail.req_id)) return { kind: 'canonical', reqId: detail.req_id };
  return { kind: 'off-page', reqId: null };
}

if (typeof document !== 'undefined') {
  /** @type {Record<string, string>} */
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** @param {unknown} v */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
  /** @param {number | null | undefined} v */
  const n = (v) => (v == null ? '—' : v.toLocaleString('en-US'));
  /** @param {number | null | undefined} v */
  const kk = (v) => (v == null ? '—' : v >= 1000000 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v));
  /** @param {number | null | undefined} ms */
  const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');
  /** @param {number} ms */
  const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  /** @param {number} ms */
  const dayTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  /** @param {string} v */
  const agentOf = (v) => v.replace(/^magpie-/, 'conv ');

  const PART_NAME = /** @type {Record<string,string>} */ ({ system: '系统提示', tools: '工具定义', history: '历史消息', user: '本轮输入', files: '文件引用', other: '其它' });
  const PARTS_ORDER = ['system', 'tools', 'history', 'user', 'files', 'other'];
  /** @param {string} kind */
  const partColor = (kind) => `var(--p${PARTS_ORDER.indexOf(kind) + 1})`;

  const reader = createReader((url) => fetch(url));
  /** @type {Map<number, RequestDetail>} */
  const details = new Map();
  /** @type {Map<number, {state: string, summary: unknown}>} */
  const routes = new Map();

  const qp = new URLSearchParams(location.search);
  const state = {
    session: qp.get('session'),
    reqId: qp.get('trace') ? Number(qp.get('trace')) : null,
    /** URL 指定的请求在库里不存在（可能被淘汰或从未存在）；界面显示未找到。 */
    missingReqId: /** @type {number | null} */ (null),
    /** URL 指定的请求存在，但落在还没加载的更早页里；它不算缺失，只是不在当前列表。 */
    offPageReqId: /** @type {number | null} */ (null),
    view: qp.get('view') === 'ledger' ? 'ledger' : 'conversation',
    open: new Set(/** @type {number[]} */ ([])),
    selected: /** @type {{req: number, path: string} | null} */ (null),
    railTab: qp.get('tab') === 'body' ? 'body' : 'facts',
    deltaOnly: new Set(/** @type {number[]} */ ([])),
    query: '',
    agent: 'all',
    replyOpen: false,
    busy: false,
    /** 渲染期间又来了新请求；当前这轮结束后再跑一遍。 */
    renderQueued: false,
    /** 正在等哪个会话的请求列表；非空时中栏显示等待说明而不是旧列表。 */
    pendingSession: /** @type {string | null} */ (null),
  };
  let themePref = 'system';
  try { themePref = localStorage.getItem('tc.theme') || 'system'; } catch { /* storage may be blocked */ }

  /** @param {string} key */
  function shortSession(key) {
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length >= 2) return ` ${String(parsed[1])} `;
    } catch { /* key 不是 JSON 时原样显示 */ }
    return ` ${key} `;
  }

  /** @param {string} key */
  function sessionRow(key) {
    return reader.getState().sessions.find(row => row.conv_key === key) ?? null;
  }
  function currentRows() {
    return reader.getState().requests;
  }
  /**
   * 已加载请求按开始时间倒序存放，编号按时间正序给：最早的一笔是 Request 01。
   * 对话视图、账本、面包屑与右栏都用同一个序号，避免同一笔在不同位置换号。
   * @param {number} reqId
   * @returns {number} 1 起的序号；未加载时返回 0
   */
  function ordinalOf(reqId) {
    const rows = currentRows();
    const index = rows.findIndex(row => row.req_id === reqId);
    return index < 0 ? 0 : rows.length - index;
  }
  function currentDetail() {
    const id = state.reqId;
    return id === null ? null : details.get(id) ?? null;
  }

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  function el(id) {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`missing_element:${id}`);
    return element;
  }

  /** @param {unknown} value */
  function raw(value) {
    return value == null ? '—' : JSON.stringify(value, null, 2);
  }

  /** @param {string} text @param {number} max */
  function clipText(text, max) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    const chars = [...flat];
    return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
  }

  /* ---------------- 数据加载 ---------------- */
  async function ensureDetail(/** @type {number} */ id) {
    if (details.has(id)) return details.get(id) ?? null;
    try {
      const response = await fetch(`/api/requests/${id}`);
      if (!response.ok) return null;
      const detail = await response.json();
      details.set(id, detail);
      // 服务端会把合并前的旧 id 解析成 canonical；按 canonical 也存一份，
      // 免得同一笔在列表行（用 canonical id 查）与详情之间拿不到数据。
      if (detail.req_id !== id) details.set(detail.req_id, detail);
      return detail;
    } catch {
      return null;
    }
  }

  async function ensureRoute(/** @type {number} */ id) {
    if (routes.has(id)) return routes.get(id) ?? null;
    try {
      const response = await fetch(`/api/requests/${id}/route`);
      if (!response.ok) return null;
      const route = await response.json();
      routes.set(id, route);
      return route;
    } catch {
      return null;
    }
  }

  /**
   * 正文按请求缓存已加载的消息片。列表切换不会触发任何正文下载：
   * 只有对话视图、账本展开和右栏正文这三个显式阅读动作才调用 ensureBody。
   * @type {Map<number, LoadedBody>}
   */
  const bodies = new Map();
  /** @type {Map<number, Promise<LoadedBody | null>>} */
  const bodyInflight = new Map();

  /**
   * @param {number} id
   * @param {number} from
   * @returns {Promise<LoadedBody | null>}
   */
  function ensureBody(id, from = 0) {
    const cached = bodies.get(id);
    if (cached !== undefined && (cached.exhausted || from < cached.nextFrom)) return Promise.resolve(cached);
    const pending = bodyInflight.get(id);
    if (pending !== undefined) return pending;
    const promise = (async () => {
      try {
        const page = await reader.loadBody(id, from);
        const isFirst = from === 0;
        const entries = isFirst ? messageEntries(page) : [...(bodies.get(id)?.entries ?? []), ...messageEntries(page)];
        const total = page.total;
        const current = bodies.get(id);
        const merged = {
          page: isFirst ? page : { ...page, request_fields: current?.page?.request_fields ?? null, reply: current?.page?.reply ?? null },
          entries,
          nextFrom: from + page.messages.length,
          total,
          // 服务端没有更多消息时结束；区间空返回也必须停下来，否则会无限翻页。
          exhausted: page.messages.length === 0 || (total !== null && from + page.messages.length >= total),
          error: null,
        };
        bodies.set(id, merged);
        return merged;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'body_failed';
        const failed = { page: null, entries: [], nextFrom: from, total: null, exhausted: false, error: message };
        // 失败不覆盖已加载的片，只让调用方看到错误。
        if (!bodies.has(id)) bodies.set(id, failed);
        return bodies.get(id) ?? failed;
      } finally {
        bodyInflight.delete(id);
      }
    })();
    bodyInflight.set(id, promise);
    return promise;
  }

  /** @param {number} id */
  function bodyOf(id) {
    return bodies.get(id) ?? null;
  }

  /** @param {number|null} reqId */
  function relationTextOf(reqId) {
    const detail = reqId === null ? null : details.get(reqId) ?? null;
    if (detail === null) return '';
    if (detail.prev_relation === 'unknown') return '无法确认与上一笔的新增关系';
    if (detail.prev_relation === 'first') return '会话首笔';
    if (detail.prev_relation === 'confirmed') return '增量已确认';
    return '';
  }

  /* ---------------- 顶栏与左栏 ---------------- */
  function renderCrumb() {
    const row = sessionRow(state.session ?? '');
    const idx = ordinalOf(state.reqId ?? -1);
    const here = state.missingReqId !== null ? `Request ${state.missingReqId} 未找到`
      : state.offPageReqId !== null ? `Request ${state.offPageReqId} 未在已加载页`
        : idx > 0 ? `Request ${String(idx).padStart(2, '0')}` : '未选择请求';
    el('crumb').innerHTML =
      `<span>${esc(row ? row.title : '未选择会话')}</span><span class="sep">/</span><b>${esc(here)}</b>`;
  }

  function renderFilters() {
    const agents = new Set(reader.getState().sessions.flatMap(s => s.agents));
    const list = ['all', ...agents].slice(0, 8);
    el('agent-filters').innerHTML = list.map(a =>
      `<button class="chip-btn" data-agent="${esc(a)}" aria-pressed="${state.agent === a}">${a === 'all' ? '全部 Agent' : esc(a)}</button>`,
    ).join('');
  }

  /** @param {SessionRow} s */
  function sessionMatches(s) {
    if (state.agent !== 'all' && !s.agents.includes(state.agent)) return false;
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return [s.title, ...s.agents].join(' ').toLowerCase().includes(q);
  }

  function renderSessions() {
    const list = reader.getState().sessions.filter(sessionMatches);
    el('load-more-sessions').hidden = reader.getState().sessionsCursor === null;
    el('sess-count').textContent = `${list.length} / 已加载 ${reader.getState().sessions.length}`;
    const item = (/** @type {SessionRow} */ s) => {
      const flag = s.flags.includes('failed') ? { color: 'var(--bad)', text: '含失败' }
        : s.flags.includes('unknown') ? { color: 'var(--warn)', text: '待确认' }
          : s.flags.includes('missing_body') ? { color: 'var(--muted)', text: '缺正文' }
            : { color: 'var(--line-strong)', text: '' };
      return `<button class="sess" data-session="${esc(s.conv_key)}" aria-current="${s.conv_key === state.session}">
        <span class="sess-title">${esc(s.title || '（无标题）')}</span>
        <span class="sess-time num">${esc(clock(s.last_ms))}</span>
        <span class="sess-meta">
          <span class="dot" style="background:${flag.color}"></span>
          <span class="who">${esc(s.agents.length > 0 ? s.agents.join(' · ') : '归属未知')}</span><span class="sep">·</span>
          <span>${s.request_count} 笔</span>
          ${flag.text ? `<span class="sep">·</span><span style="color:${flag.color}">${flag.text}</span>` : ''}
        </span>
      </button>`;
    };
    el('sessions-list').innerHTML = list.length
      ? list.map(item).join('')
      : '<p class="sess-empty">当前已加载的会话里没有符合条件的项。搜索与筛选只覆盖已加载范围。</p>';
  }

  /* ---------------- 中栏 ---------------- */
  /** @param {RequestRow} r */
  function statusChip(r) {
    const failed = r.status !== null && r.status >= 400;
    const [cls, text] = failed ? ['bad', `HTTP ${r.status}`]
      : r.status === null ? ['mute', '状态待确认']
        : ['ok', '完成'];
    return `<span class="state-chip ${cls}"><span class="d"></span>${text}</span>`;
  }

  /** @param {RequestRow} r */
  function bodyStateText(r) {
    if (r.body_state === 'available') return '正文可读';
    if (r.body_state === 'pending') return '正文未到';
    if (r.body_state === 'partial') return '正文不完整';
    if (r.body_state === 'evicted') return '正文已回收';
    return '协议暂不支持';
  }

  /** @param {RequestRow} r */
  function viaText(r) {
    if (!(r.have & 2)) return '仅回调，未关联账本';
    if (!(r.have & 1)) return '仅账本，没有回调';
    return '账本 + 回调';
  }

  function sessionHead() {
    const row = sessionRow(state.session ?? '');
    const rows = currentRows();
    // URL 指定了会话、但会话列表里没有它：这不是"未选择"，要分开说，否则读者会以为空库。
    const unknown = state.session !== null && row === null;
    const latest = rows[0] ?? null;
    const first = rows[rows.length - 1] ?? null;
    const totalIn = rows.reduce((a, r) => a + (r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0), 0);
    const totalOut = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
    const priced = rows.filter(r => r.cost_state === 'priced' || r.cost_state === 'zero');
    const totalCost = priced.reduce((a, r) => a + (r.cost ?? 0), 0);
    const hasUsage = rows.some(r => r.in_tok !== null || r.out_tok !== null);
    const missing = rows.filter(r => r.body_state === 'pending' || !(r.have & 1)).length;
    return `<header class="session-head">
      <div class="eyebrow">${state.session !== null && state.session.startsWith('[\"session\"') ? 'Session' : 'Unassigned'}</div>
      <h1>${esc(row ? row.title || '（无标题）' : unknown ? '这个会话不在已加载列表里' : '未选择会话')}</h1>
      <div class="session-facts">
        ${row && row.agents.length > 0 ? row.agents.map(a => `<span><b>${esc(a)}</b></span>`).join('') : '<span class="muted">归属未知</span>'}
        <span class="mono">${esc(state.session ?? '')}</span>
        <span>已加载 <b>${rows.length}</b> 笔 Request</span>
        ${first && latest ? `<span>${esc(dayTime(first.started_ms))}–${esc(clock(latest.started_ms))}</span>` : ''}
        ${hasUsage
          ? `<span class="sum">已加载相加：${kk(totalIn)} 提示 · ${kk(totalOut)} 输出 · $${totalCost.toFixed(4)}${priced.length < rows.length ? ` · ${rows.length - priced.length} 笔未取得费用` : ''}</span>`
          : '<span class="sum muted">这批记录没有报告的用量，合计为空</span>'}
      </div>
      <div class="view-row">
        <div class="seg" role="group" aria-label="会话视图">
          <button data-view="conversation" aria-pressed="${state.view === 'conversation'}">对话</button>
          <button data-view="ledger" aria-pressed="${state.view === 'ledger'}">请求账本</button>
        </div>
        <span class="hint">${state.view === 'conversation'
          ? '按请求分组；只铺已确认新增的消息，正文按需读取。'
          : '每行是一笔客户端请求；展开后读正文、读数与路由。'}</span>
      </div>
      ${unknown ? `<div class="session-note warn"><span>↳</span><span>链接里的会话 key 不在已加载的会话里：可能是已淘汰、从未记录，或者还在后面的会话页。下面没有用别的会话顶替。</span></div>` : ''}
      ${missing > 0 ? `<div class="session-note warn"><span>↳</span><span>已加载请求中有 ${missing} 笔正文未到或没有回调；它们保留身份与读数，不用更早的请求替代。</span></div>` : ''}
      ${state.missingReqId !== null ? `<div class="session-note warn"><span>↳</span><span>链接里的 Request ${state.missingReqId} 在当前库里不存在，也没有别名指向它。下面显示的是本会话的请求，不是那一笔。</span></div>` : ''}
      ${state.offPageReqId !== null ? `<div class="session-note"><span>↳</span><span>链接里的 Request ${state.offPageReqId} 存在，但落在还没加载的更早页里；继续加载请求后可以选到它。</span></div>` : ''}
      ${reader.getState().requestsCursor !== null ? `<div class="session-note"><span>↳</span><span>这里只显示已加载的一页请求；继续加载会追加更早的请求。</span></div>` : ''}
    </header>`;
  }

  /**
   * 对话视图：按请求分组，只铺确定新增的用户消息。
   * 关系未知的请求不给"新增"，而是给出原因和完整正文入口；
   * 正文没加载的请求显示加载入口，不预先下载整条会话。
   * @param {string} emptyText
   */
  function renderConversation(emptyText) {
    const rows = currentRows();
    if (rows.length === 0) return `<div class="conv"><p class="sess-empty">${esc(emptyText)}</p></div>`;
    const ordered = rows.slice().reverse();
    return `<div class="conv">${ordered.map((r) => {
      const detail = details.get(r.req_id) ?? null;
      const loaded = bodyOf(r.req_id);
      const ordinal = String(ordinalOf(r.req_id)).padStart(2, '0');
      const delta = deltaOrdinals(detail);
      const relation = relationTextOf(r.req_id);
      const userBlocks = loaded === null || delta === null
        ? []
        : loaded.entries.filter(entry => delta.has(entry.ord) && entry.isInput);
      const inputNote = loaded === null ? ''
        : userBlocks.length > 0 ? ''
          : delta === null ? `<div class="conv-cont">${esc(relation || '还未派生增量关系')}：不拆分新增消息，右侧可读整笔请求正文。</div>`
            : `<div class="conv-cont">这一笔没有新的用户消息，输入是上一笔的工具结果。</div>`;
      return `<section class="conv-req" data-req="${r.req_id}" data-current="${r.req_id === state.reqId}">
        <div class="conv-gutter"><b>${ordinal}</b><em>${esc(clock(r.started_ms))}</em></div>
        <div class="conv-main">
          ${userBlocks.map(entry => `<div class="conv-user" data-select="${r.req_id}">
            <div class="conv-who">USER</div>
            <div class="conv-user-body">${esc(entry.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n') || entry.preview)}</div>
          </div>`).join('')}
          ${inputNote}${toolDeltaNote(loaded, delta)}
          ${convCard(r, detail, loaded)}
          <button class="conv-jump" data-ledger="${r.req_id}">在账本中查看 Request ${ordinal} →</button>
        </div>
      </section>`;
    }).join('')}</div>`;
  }

  /**
   * 这一笔新增的消息里若只有工具结果，说明输入来自上一轮的工具，不画成空白。
   * @param {LoadedBody | null} loaded
   * @param {Set<number> | null} delta
   */
  function toolDeltaNote(loaded, delta) {
    if (loaded === null || delta === null) return '';
    const fresh = loaded.entries.filter(entry => delta.has(entry.ord));
    if (fresh.length === 0) return '';
    const results = fresh.filter(entry => entry.blocks.some(block => block.kind === 'result'));
    if (results.length === 0) return '';
    return `<div class="conv-cont">这一笔新增 ${results.length} 条工具结果，来自上一轮调用；完整内容可在右侧或账本里读。</div>`;
  }

  /**
   * 对话里的助手卡片：有正文就渲染回复，没有就说明原因并给加载入口。
   * @param {RequestRow} r
   * @param {RequestDetail | null} detail
   * @param {LoadedBody | null} loaded
   */
  function convCard(r, detail, loaded) {
    const failed = r.status !== null && r.status >= 400;
    const head = `<div class="conv-asst-head">
      <span class="conv-who">ASSISTANT</span>
      <span class="mono muted" style="font-size:10px">${esc(r.model_served ?? r.model_requested ?? '模型名未报告')}</span>
      <span class="grow"></span>
      ${statusChip(r)}
    </div>`;
    if (loaded === null || loaded.page === null) {
      const reason = loaded !== null && loaded.error !== null
        ? `正文加载失败：${loaded.error}`
        : bodyLabelText(r);
      return `<div class="conv-asst-card" data-select="${r.req_id}">${head}
        <div class="conv-fail" style="color:var(--muted)"><span>◇</span><span>${esc(reason)}</span></div>
        ${r.body_state === 'available' || r.body_state === 'partial'
          ? `<div class="conv-tools"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}
        ${convStrip(r, detail)}
      </div>`;
    }
    const page = loaded.page;
    const view = replyView(page);
    const tools = toolEntries(detail, page);
    const notice = bodyNotice(page);
    if (failed) {
      return `<div class="conv-asst-card" data-select="${r.req_id}">${head}
        <div class="conv-fail"><span>✕</span><span>这一笔返回 HTTP ${r.status}。失败尝试的用量仍保留在账本里，失败的读数不并入成功请求。</span></div>
        ${convStrip(r, detail)}
      </div>`;
    }
    const body = view.state === 'ok' && view.text.length > 0
      ? `<div class="conv-asst-body">${mdToHtml(view.text)}</div>`
      : view.state === 'ok' && view.calls.length > 0
        // 纯工具调用的回复常常只有推理块：显示出来，别读成"没有内容"。
        ? `${view.thinking.length > 0
          ? `<details class="msg-thinking" style="margin:8px 11px"><summary>推理块 · ${view.thinking.length} 段</summary>
              <pre class="raw" tabindex="0">${esc(view.thinking.join('\n\n'))}</pre></details>`
          : '<div class="conv-fail" style="color:var(--muted)"><span>◇</span><span>本次回复只有工具调用，没有文本。</span></div>'}`
        : view.state === 'ok'
          ? '<div class="conv-fail" style="color:var(--muted)"><span>◇</span><span>回复对象存在，但没有文本内容。</span></div>'
          : `<div class="conv-fail" style="color:var(--muted)"><span>◇</span><span>${esc(notice || '这一笔没有可读的回复。')}</span></div>`;
    return `<div class="conv-asst-card" data-select="${r.req_id}">${head}
      ${notice && view.state === 'ok' ? `<div class="conv-cont note">${esc(notice)}</div>` : ''}
      ${body}
      ${renderTools(tools)}
      ${convStrip(r, detail)}
    </div>`;
  }

  /** @param {RequestRow} r */
  function bodyLabelText(r) {
    if (r.body_state === 'available') return '正文可读，尚未读取；点开后才下载这一片。';
    if (r.body_state === 'pending') return `正文未到${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    if (r.body_state === 'partial') return `正文不完整${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    if (r.body_state === 'evicted') return `正文已回收${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    return '原对象已保存，暂不支持结构化解析。';
  }

  /** @param {RequestRow} r @param {RequestDetail | null} detail */
  function convStrip(r, detail) {
    const parts = [
      detail && detail.ms !== null ? `时长 <b>${secs(detail.ms)}</b>` : null,
      detail && detail.ttft_ms !== null ? `首字 <b>${secs(detail.ttft_ms)}</b>` : null,
      r.in_tok !== null ? `↓ <b>${n(r.in_tok)}</b>` : null,
      r.out_tok !== null ? `↑ <b>${n(r.out_tok)}</b>` : null,
      r.cost_state === 'priced' && r.cost !== null ? `$${r.cost}` : r.cost_state === 'unpriced' ? '未定价' : null,
      detail && detail.attempt_count !== null && detail.attempt_count > 1 ? `<b>${detail.attempt_count}</b> 次尝试` : null,
    ].filter(Boolean);
    return `<div class="conv-strip">${parts.length ? parts.map(p => `<span>${p}</span>`).join('<span class="sep">·</span>') : '<span class="muted">没有可显示的读数</span>'}</div>`;
  }

  /** @param {RequestRow} r */
  function ledgerRow(r) {
    const open = state.open.has(r.req_id);
    const flag = r.status !== null && r.status >= 400 ? '<span class="req-flag bad">失败</span>'
      : !(r.have & 2) ? '<span class="req-flag warn">待关联</span>'
        : r.body_state !== 'available' ? `<span class="req-flag mute">${esc(bodyStateText(r))}</span>`
          : '';
    const status = r.status === null ? 'unknown' : r.status >= 400 ? 'failed' : 'success';
    return `<article class="req" data-req="${r.req_id}" data-status="${status}" data-open="${open}" aria-current="${r.req_id === state.reqId}">
      <button class="req-head" data-toggle="${r.req_id}" aria-expanded="${open}">
        <span class="req-node" aria-hidden="true"></span>
        <span class="req-time num">${esc(clock(r.started_ms))}</span>
        <span class="req-line">
          <span class="req-title">${esc(r.title || '（无标题）')}</span>
          <span class="req-sub">${flag}<span>${esc(viaText(r))} · ${esc(bodyStateText(r))}${r.miss_reason ? ` · ${esc(r.miss_reason)}` : ''}</span></span>
        </span>
        <span class="req-metrics">
          ${r.status !== null ? `<span class="num">HTTP ${r.status}</span>` : ''}
          <span class="num opt">${r.in_tok !== null ? '↓' + kk((r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0)) : '↓ 未报告'}</span>
          ${r.out_tok !== null ? `<span class="num opt">↑ ${kk(r.out_tok)}</span>` : ''}
          <span class="req-open-mark" aria-hidden="true"><svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M3 1.5L7 5l-4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </span>
      </button>
      ${open ? requestBody(r) : ''}
    </article>`;
  }

  /** @param {RequestRow} r */
  function requestBody(r) {
    const detail = details.get(r.req_id) ?? null;
    const route = routes.get(r.req_id) ?? null;
    const loaded = bodyOf(r.req_id);
    const ordinal = ordinalOf(r.req_id);
    const meta = [
      `<span class="id">req ${r.req_id}</span>`,
      `<span class="muted">${esc(viaText(r))}</span>`,
      r.actor ? `<span class="muted">${esc(r.actor)}</span>` : '<span class="muted">归属未知</span>',
      detail && detail.attempt_count !== null ? `<span class="muted">${detail.attempt_count} 次尝试 · ${detail.attempt_billed ?? '—'} 次计费</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="req-body">
      <div class="body-top">
        <span class="num muted" style="font-size:10.5px">Request ${String(ordinal).padStart(2, '0')}</span>
        ${statusChip(r)}
        ${meta}
        <span class="grow"></span>
        ${r.miss_reason ? `<span class="req-flag warn" title="${esc(r.miss_reason)}">${esc(r.miss_reason)}</span>` : ''}
      </div>
      ${ledgerBodySection(r, detail, loaded)}
      <div class="disclosures">
        <details><summary>路由与尝试</summary><div class="d-body">${routeBlock(r, route)}</div></details>
        <details><summary>采集完整性与阅读边界</summary><div class="d-body">${completenessRows(r, detail)}</div></details>
        <details><summary>原始脱敏对象</summary><div class="d-body">${
          loaded !== null && loaded.page !== null
            ? renderRaw(loaded.page)
            : '<p class="note">这一片正文还没读取，展开正文后再看原始对象。</p>'
        }</div></details>
      </div>
    </div>`;
  }

  /**
   * 账本内的正文区：消息列表 + 本次回复，两者分开。
   * 正文未加载时只给加载入口；回收、未到、不支持都写明原因，
   * 不渲染成"没有对话"。
   * @param {RequestRow} r
   * @param {RequestDetail | null} detail
   * @param {LoadedBody | null} loaded
   */
  function ledgerBodySection(r, detail, loaded) {
    if (loaded === null || loaded.page === null) {
      const message = loaded !== null && loaded.error !== null
        ? `正文加载失败：${loaded.error}`
        : bodyLabelText(r);
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      return `<section class="section">
        <div class="section-head"><h3>正文</h3><span class="count">按请求读取，不下载整条会话</span></div>
        <div class="reply-card"><div class="reply-empty">
          <b>${esc(bodyStateText(r))}</b>
          <span>${esc(message)}</span>
          ${canLoad ? `<span><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></span>` : ''}
        </div></div>
      </section>`;
    }
    const page = loaded.page;
    // 回收与未到的正文没有可读区间：只给状态说明，不渲染消息列表、翻页和回复卡，
    // 否则"0 / 9 条消息 + 加载下一片"会假装还有内容可取。
    if (page.state !== 'available' && page.state !== 'partial') {
      return `<section class="section">
        <div class="section-head"><h3>正文</h3><span class="count">${esc(bodyStateText(r))}</span></div>
        <div class="reply-card"><div class="reply-empty">
          <b>${esc(bodyStateText(r))}</b>
          <span>${esc(bodyNotice(page) || '这一笔没有可读的正文。')}</span>
          <span>身份与读数不受影响；这里不生成推测内容，也不用相邻请求代替。</span>
        </div></div>
      </section>`;
    }
    const view = replyView(page);
    const tools = toolEntries(detail, page);
    const delta = deltaOrdinals(detail);
    const relation = relationTextOf(r.req_id);
    const notice = bodyNotice(page);
    const rows = loaded.entries;
    const unread = loaded.total !== null && rows.length < loaded.total;
    const unsupported = page.parse_state === 'unsupported';
    return `<section class="section">
      <div class="section-head">
        <h3>请求结构</h3>
        <span class="count">${unsupported ? '原对象已保存' : loaded.total === null ? `${rows.length} 条消息` : `${rows.length} / ${loaded.total} 条消息`}</span>
        ${delta !== null ? `<span class="count" style="color:var(--accent)">新增 ${delta.size}</span>` : ''}
        <span class="grow"></span>
      </div>
      ${notice ? `<p class="note" style="margin-bottom:8px">${esc(notice)}</p>` : ''}
      ${relation && delta === null ? `<div class="delta-note"><b>${esc(relation)}</b><span>不标记新增消息；下面按原顺序完整列出，避免把旧上下文误读成这一轮输入。</span></div>` : ''}
      ${unsupported
        ? '<p class="note">这个协议的原文已整份保存，但没有逐条消息视图；在下面「原始脱敏对象」里读完整请求与回复。</p>'
        : rows.length > 0
          // 每片只加载 40 条，已加载的就全部铺出来；再截断会让"加载下一片"白点。
          ? renderMessages(rows, { delta, limit: rows.length, selectedOrd: state.selected?.req === r.req_id ? messageOrdOf(state.selected.path) : null })
          : '<p class="note">这一笔没有消息正文。</p>'}
      ${unread ? `<div class="conv-tools"><button class="chip-btn" data-body-more="${r.req_id}">加载下一片（已读 ${rows.length} / ${loaded.total}）</button></div>` : ''}
    </section>
    <section class="section">
      <div class="section-head"><h3>本次回复</h3><span class="count">与请求上下文分开保存</span></div>
      ${renderReply(view, tools)}
    </section>`;
  }

  /** @param {string} path @returns {number | null} */
  function messageOrdOf(path) {
    const match = /^messages\[(\d+)\]$/.exec(path);
    return match === null ? null : Number(match[1]);
  }

  /** @param {RequestRow} r @param {{state: string, summary: unknown} | null} route */
  function routeBlock(r, route) {
    if (route === null) {
      return `<p class="note">${esc(viaText(r))}。路由信息还没加载或不可用。</p>`;
    }
    if (route.state === 'absent') {
      return `<p class="note">这笔记录没有网关路由：它可能没有经过 magpie 路由器，或尚未与路由文件关联。</p>`;
    }
    if (route.state === 'expired') {
      return `<p class="note">原始路由已过期，长期摘要也没有留下。这里不返回空对象冒充已取得。</p>`;
    }
    const s = /** @type {Record<string, unknown>} */ (route.summary);
    const tries = Array.isArray(s.tries) ? s.tries : [];
    const order = Array.isArray(s.order) ? s.order : [];
    return `<dl class="chain">
      <div class="chain-row"><dt>候选顺序</dt><dd class="mono" style="font-size:10px">${order.map(o => esc(raw(o))).join(' → ') || '<span class="muted">未报告</span>'}</dd></div>
      <div class="chain-row"><dt>实际去向</dt><dd>${s.served ? `<code>${esc(s.served)}</code>` : '<span class="muted">未报告</span>'} · <code>${esc(s.provider ?? 'unknown')}</code></dd></div>
      <div class="chain-row"><dt>状态</dt><dd>HTTP ${esc(s.status ?? '—')} · ${secs(/** @type {number|null} */ (s.ms))}</dd></div>
      ${tries.length > 0 ? `<div class="chain-row"><dt>尝试链</dt><dd>${tries.map((t, i) => `<span class="attempt-name">${i + 1}. ${esc(raw(t))}</span>`).join('<br>')}</dd></div>` : ''}
    </dl>
    <p class="note" style="margin-top:8px">只显示已记录的决策与尝试。窗口过滤不保证完整留痕；用量条目数量也不等于尝试次数。</p>`;
  }

  /** @param {RequestRow} r @param {RequestDetail | null} detail */
  function completenessRows(r, detail) {
    const row = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string} */ color) =>
      `<div class="chain-row"><dt>${k}</dt><dd><span style="color:${color}">${v}</span></dd></div>`;
    return `<div class="chain">
      ${row('正文回调', (r.have & 1) ? '已收到' : '未收到', (r.have & 1) ? 'var(--good)' : 'var(--bad)')}
      ${row('用量账本', (r.have & 2) ? '已关联' : '待关联', (r.have & 2) ? 'var(--good)' : 'var(--warn)')}
      ${row('路由历史', (r.have & 4) ? '已关联' : '当前来源不提供', (r.have & 4) ? 'var(--good)' : 'var(--muted)')}
    </div>
    <p class="note" style="margin-top:8px">三条通道各自可能缺失。${detail && detail.prev_relation === 'unknown' ? '本笔与上一笔的增量关系无法确认，未计算新增消息。' : ''}
      ${r.miss_reason ? `缺失原因：${esc(r.miss_reason)}。` : ''}</p>`;
  }

  function renderMain() {
    const main = el('main');
    const keep = main.scrollTop;
    const rows = currentRows();
    const failed = reader.getState().requestsError;
    const unknown = state.session !== null && sessionRow(state.session) === null;
    const emptyText = state.session === null
      ? '库里还没有会话，也就没有可显示的请求。'
      : unknown
        ? '这个会话不在已加载列表里；没有可显示的请求，也没有用别的会话顶替。'
        : '这个会话没有已记录的请求。';
    if (state.pendingSession !== null) {
      // 数据还没到时不渲染头部聚合：那会用上一个会话的行拼出新会话的读数。
      main.innerHTML = `<div class="conv"><p class="sess-empty">正在读取${esc(shortSession(state.pendingSession))}的请求…</p></div>`;
      main.scrollTop = keep;
      el('load-more-requests').hidden = true;
      return;
    }
    main.innerHTML = sessionHead() + (failed !== null
      // 加载失败时不能渲染成"这个会话没有请求"，那会把网络故障读成空库。
      ? `<div class="conv"><p class="sess-empty">请求列表加载失败：${esc(failed)}。点左侧会话可重试。</p></div>`
      : state.view === 'ledger'
        ? `<div class="ledger">${rows.map(r => ledgerRow(r)).join('') || `<p class="sess-empty">${esc(emptyText)}</p>`}</div>`
        : renderConversation(emptyText));
    main.scrollTop = keep;
    el('load-more-requests').hidden = reader.getState().requestsCursor === null;
  }

  /* ---------------- 右栏 ---------------- */
  /** @param {RequestRow} r */
  function bigNumbers(r) {
    const d = currentDetail();
    const speed = d && d.flow_ms && r.out_tok ? r.out_tok / (d.flow_ms / 1000) : null;
    const cells = [
      ['首字', d && d.ttft_ms !== null ? (d.ttft_ms / 1000).toFixed(2) : '—', d && d.ttft_ms !== null ? 's' : '', 'TTFT：到第一个内容'],
      ['时长', d && d.ms !== null ? (d.ms / 1000).toFixed(2) : '—', d && d.ms !== null ? 's' : '', '从请求到回复结束'],
      ['输出速度', speed ? String(Math.round(speed)) : '—', speed ? 'tok/s' : '', '输出 token ÷ 生成耗时'],
    ];
    return `<div class="rail-big">${cells.map(([k, v, u, title]) => `<div title="${esc(title)}">
      <div class="k">${k}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div></div>`).join('')}</div>`;
  }

  function railHead() {
    const r = currentRows().find(row => row.req_id === state.reqId) ?? null;
    if (r === null) return '<div class="rail-id">未选择请求</div>';
    return `<div class="rail-id"><span>req ${r.req_id}</span><span class="muted">·</span><span>${esc(dayTime(r.started_ms))}</span><span class="grow"></span>${statusChip(r)}</div>
      <div class="rail-title">${esc(r.title || '（无标题）')}</div>
      ${bigNumbers(r)}
      <div class="rail-tabs" role="tablist">
        <button role="tab" data-rail="facts" aria-pressed="${state.railTab === 'facts'}">读数</button>
        <button role="tab" data-rail="body" aria-pressed="${state.railTab === 'body'}">正文</button>
      </div>`;
  }

  /** @param {RequestRow} r */
  function usageSection(r) {
    const total = (r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
    const cell = (/** @type {string} */ label, /** @type {number|null} */ val) => `<div class="u-cell"><div class="k">${label}</div>${val == null
      ? '<div class="v miss">未报告</div>'
      : `<div class="v">${n(val)}</div>`}</div>`;
    const hit = r.cache_read !== null && total > 0 ? Math.round(r.cache_read / total * 100) : null;
    const cost = r.cost_state === 'priced' ? `$${r.cost}` : r.cost_state === 'zero' ? '$0' : r.cost_state === 'unpriced' ? '未定价' : '未取得';
    return `<section class="rail-section">
      <h3>用量<span class="grow"></span><span class="hint">上游报告</span></h3>
      <div class="u-grid">
        ${cell('输入（不含缓存）', r.in_tok)}
        ${cell('输出', r.out_tok)}
        ${cell('缓存读取', r.cache_read)}
        ${cell('缓存写入', r.cache_write)}
      </div>
      <div class="u-total"><span>提示总量 <b>${total > 0 ? n(total) : '—'}</b></span><span>费用 <b>${esc(cost)}</b></span></div>
      ${hit !== null ? `<div class="meter" aria-hidden="true"><i style="width:${hit}%"></i></div>
        <div class="u-total"><span>缓存命中 <b>${hit}%</b>（读取 ÷ 提示总量，展示比例，不是计费口径）</span></div>` : ''}
      <p class="rail-note">输入不含缓存读取与写入。缺失保留为「未报告」，不当作 0 参与合计。费用状态：${esc(r.cost_state)}。</p>
    </section>`;
  }

  /** @param {RequestRow} r */
  function timingSection(r) {
    const d = currentDetail();
    if (d === null || d.ms === null) {
      return `<section class="rail-section"><h3>时间构成</h3>
        <p class="rail-note">${(r.have & 2) ? '上游没有报告本笔耗时。' : '这笔记录还没有关联到账本，没有网关计时。'}</p></section>`;
    }
    const waitPct = d.ttft_ms !== null ? Math.min(100, d.ttft_ms / d.ms * 100) : 100;
    const tickPct = d.first_text_ms !== null && d.ms > 0 ? Math.min(100, d.first_text_ms / d.ms * 100) : null;
    const speed = d.flow_ms && r.out_tok ? Math.round(r.out_tok / (d.flow_ms / 1000)) : null;
    const rows = [
      d.ttft_ms !== null
        ? `<span class="k"><i class="sw" style="background:var(--line-strong)"></i>首字前（排队 + 网络 + 首 token）</span><span class="v">${secs(d.ttft_ms)}</span>`
        : `<span class="k"><i class="sw" style="background:var(--line-strong)"></i>首字前</span><span class="v">未报告</span>`,
      d.ttft_ms !== null
        ? `<span class="k"><i class="sw" style="background:var(--accent);opacity:.62"></i>首字后生成</span><span class="v">${secs(d.ms - d.ttft_ms)}</span>`
        : '',
      `<span class="k"><i class="sw" style="background:var(--text);width:2px;height:9px;border-radius:1px"></i>首个文本</span><span class="v">${d.first_text_ms !== null ? secs(d.first_text_ms) : '未报告'}</span>`,
      speed ? `<span class="k">输出速度</span><span class="v">${speed} tok/s</span>` : '',
    ].filter(Boolean).join('');
    return `<section class="rail-section">
      <h3>时间构成</h3>
      <div class="time-wrap">
        <div class="time-bar" aria-hidden="true"><i class="wait" style="width:${waitPct}%"></i><i class="gen" style="width:${100 - waitPct}%"></i>
          ${tickPct !== null ? `<span class="time-tick" style="left:${tickPct}%"></span>` : ''}</div>
        <div class="time-legend">${rows}</div>
      </div>
      <p class="rail-note">首字是到第一个内容；首个文本通常更晚。生成耗时为总时长减去首字；缺值时留空，不按 0 处理。</p>
    </section>`;
  }

  /** @param {RequestRow} r */
  function promptSection(r) {
    const d = currentDetail();
    const parts = d && Array.isArray(d.parts) ? d.parts.filter(p => p && typeof p === 'object') : [];
    if (d === null || d.prompt_tokens === null || parts.length === 0) {
      return `<section class="rail-section"><h3>上下文组成</h3>
        <p class="rail-note">没有路由侧的 prompt 分析。可能是该请求未经网关规则路由，或路由记录已超出保留期。</p></section>`;
    }
    const list = /** @type {{kind:string, tokens:number}[]} */ (parts);
    const sum = list.reduce((a, x) => a + (Number(x.tokens) || 0), 0) || 1;
    const ordered = [...list].sort((a, b) => b.tokens - a.tokens);
    return `<section class="rail-section">
      <h3>上下文组成<span class="grow"></span><span class="hint">${d.prompt_counted ? '总量已校准' : '本地估计'}</span></h3>
      <div class="comp-bar" aria-hidden="true">${list.filter(x => x.tokens > 0).map(x => `<i style="flex:${x.tokens / sum};background:${partColor(String(x.kind))}"></i>`).join('')}</div>
      <div class="comp-legend">${ordered.map(x => `<span class="name"><i class="sw" style="background:${partColor(String(x.kind))}"></i><span>${PART_NAME[String(x.kind)] || esc(String(x.kind))}</span></span>
        <span class="val">${kk(x.tokens)}</span><span class="pct">${Math.round(x.tokens / sum * 100)}%</span>`).join('')}</div>
      <div class="u-total" style="margin-top:8px"><span>提示总量 <b>${n(d.prompt_tokens)}</b></span><span>${d.prompt_window ? `窗口 <b>${kk(d.prompt_window)}</b>` : '窗口未知'}</span></div>
      <p class="rail-note">分类是估计分配，不是逐类精确计数。${d.prompt_window ? '' : ' 分母未知，不显示占用率。'}</p>
    </section>`;
  }

  /** @param {RequestRow} r */
  function routeSection(r) {
    const route = routes.get(r.req_id) ?? null;
    if (route === null || route.state !== 'available') {
      return `<section class="rail-section"><h3>路由</h3><p class="rail-note">${route === null ? '路由尚未加载。' : route.state === 'expired' ? '原始路由与摘要都已不可用。' : '当前来源没有网关路由。'}</p></section>`;
    }
    const s = /** @type {Record<string, unknown>} */ (route.summary);
    const order = Array.isArray(s.order) ? s.order : [];
    return `<section class="rail-section">
      <h3>路由去向</h3>
      <div class="chain">
        <div class="chain-row"><dt>请求模型</dt><dd><code>${esc(r.model_requested ?? '未报告')}</code></dd></div>
        <div class="chain-row"><dt>实际去向</dt><dd><code>${esc(s.served ?? '未报告')}</code></dd></div>
        <div class="chain-row"><dt>候选顺序</dt><dd class="mono" style="font-size:10px">${order.map(o => esc(raw(o))).join(' → ') || '未报告'}</dd></div>
        <div class="chain-row"><dt>亲和性</dt><dd>${s.affinity === null || s.affinity === undefined ? '<span class="muted">未报告</span>' : `<code>${esc(raw(s.affinity))}</code>`}</dd></div>
      </div>
      <p class="rail-note">请求模型、候选顺序与实际去向是三个值，不能挤成一个 Model。</p>
    </section>`;
  }

  /** @param {RequestRow} r */
  function completenessSection(r) {
    return `<section class="rail-section">
      <h3>数据完整性</h3>
      <div class="chain">
        <div class="chain-row"><dt>正文回调</dt><dd><span style="color:${(r.have & 1) ? 'var(--good)' : 'var(--bad)'}">${(r.have & 1) ? '已收到' : '未收到'}</span></dd></div>
        <div class="chain-row"><dt>用量账本</dt><dd><span style="color:${(r.have & 2) ? 'var(--good)' : 'var(--warn)'}">${(r.have & 2) ? '已关联' : '待关联'}</span></dd></div>
        <div class="chain-row"><dt>路由历史</dt><dd><span style="color:${(r.have & 4) ? 'var(--good)' : 'var(--muted)'}">${(r.have & 4) ? '已关联' : '当前来源不提供'}</span></dd></div>
      </div>
      <p class="rail-note">三条通道各自可能缺失。正文状态：${esc(r.body_state)}${r.miss_reason ? ` · ${esc(r.miss_reason)}` : ''}。</p>
    </section>`;
  }

  function railFacts() {
    const r = currentRows().find(row => row.req_id === state.reqId) ?? null;
    if (r === null) return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    return usageSection(r) + timingSection(r) + promptSection(r) + routeSection(r) + completenessSection(r);
  }

  function railBody() {
    const r = currentRows().find(row => row.req_id === state.reqId) ?? null;
    if (r === null) return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    if (state.railTab === 'facts') return railFacts();
    const loaded = bodyOf(r.req_id);
    if (loaded === null || loaded.page === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      const message = loaded !== null && loaded.error !== null ? `正文加载失败：${loaded.error}` : bodyLabelText(r);
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(message)}
        ${canLoad ? `<div style="margin-top:10px"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}</div>`;
    }
    const detail = details.get(r.req_id) ?? null;
    const page = loaded.page;
    if (page.state !== 'available' && page.state !== 'partial') {
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyNotice(page) || '这一笔没有可读的正文。')}</div>`;
    }
    const view = replyView(page);
    const tools = toolEntries(detail, page);
    const notice = bodyNotice(page);
    const selected = state.selected !== null && state.selected.req === r.req_id ? state.selected.path : null;
    const chosen = selected !== null && /^messages\[\d+\]$/.test(selected)
      ? loaded.entries.find(entry => entry.ord === messageOrdOf(selected)) ?? null
      : null;
    const body = chosen !== null
      ? renderMessageDetail(chosen)
      : view.state === 'ok'
        ? renderReplyDetail(view, tools)
        : `<div class="rail-empty"><b>没有可读的回复</b>${esc(notice || '这一笔只有请求。')}</div>`;
    const unread = loaded.total !== null && loaded.entries.length < loaded.total;
    return `${notice && view.state === 'ok' ? `<p class="rail-note" style="margin-bottom:8px">${esc(notice)}</p>` : ''}
      ${body}
      <div class="conv-tools" style="padding:10px 0 0">
        <span class="label">请求消息</span>
        <button class="chip-btn" data-rail-reply="1" aria-pressed="${chosen === null}">本次回复</button>
        ${loaded.entries.length > 0
          ? `<select class="mini-search" data-rail-msg="${r.req_id}" aria-label="选择消息">
              ${loaded.entries.slice(0, 300).map(entry => `<option value="${entry.ord}" ${chosen !== null && chosen.ord === entry.ord ? 'selected' : ''}>#${entry.ord} ${roleTag(entry.role)} · ${esc(clipText(entry.preview, 40))}</option>`).join('')}
            </select>`
          : '<span class="muted" style="font-size:10.5px">这一笔没有消息正文</span>'}
      </div>
      ${unread ? `<div style="margin-top:8px"><button class="chip-btn" data-body-more="${r.req_id}">加载下一片（已读 ${loaded.entries.length} / ${loaded.total}）</button></div>` : ''}`;
  }

  function renderRail() {
    el('rail-head').innerHTML = railHead();
    el('rail-body').innerHTML = railBody();
    el('rail-body').scrollTop = 0;
  }

  /* ---------------- 交互 ---------------- */
  function updateURL() {
    const p = new URLSearchParams();
    if (state.session) p.set('session', state.session);
    // 保留 URL 里那个"不在已加载页"的 id，刷新后还能看到同一条说明。
    const trace = state.reqId ?? state.missingReqId ?? state.offPageReqId;
    if (trace !== null) p.set('trace', String(trace));
    if (state.view === 'ledger') p.set('view', 'ledger');
    if (state.railTab === 'body') p.set('tab', 'body');
    history.replaceState(null, '', '?' + p.toString());
  }

  async function prefetchDetails() {
    const rows = currentRows().slice(0, 30);
    await Promise.all(rows.map(async row => { await ensureDetail(row.req_id); }));
  }

  /**
   * 对话视图只取可见范围内最新的若干笔首片正文，不下全量：
   * 分页加载的请求可能很多，整页一次拉会同时占住内存与连接。
   * 更早的请求保留"读取正文"入口，点开才算。
   * 返回本次真正新加载的笔数；调用方据此决定要不要重绘，已缓存的不会触发循环。
   */
  const BODY_PREFETCH = 30;
  const BODY_CONCURRENCY = 4;
  async function prefetchBodies() {
    const wanted = currentRows().slice(0, BODY_PREFETCH)
      .filter(row => (row.body_state === 'available' || row.body_state === 'partial') && !bodies.has(row.req_id))
      .map(row => row.req_id);
    let loaded = 0;
    for (let index = 0; index < wanted.length; index += BODY_CONCURRENCY) {
      const chunk = wanted.slice(index, index + BODY_CONCURRENCY);
      await Promise.all(chunk.map(async id => { await ensureBody(id); }));
      loaded += chunk.length;
    }
    return loaded;
  }

  /**
   * 渲染后再补正文。只重绘一次，并且只在当前屏幕上的东西真的变了的时候：
   * 否则 prefetch 与 render 会来回触发。
   */
  async function loadVisibleBodies() {
    const loaded = state.view === 'conversation'
      ? await prefetchBodies()
      : await (async () => {
        const openIds = [...state.open].filter(id => currentRows().some(row => row.req_id === id) && !bodies.has(id));
        await Promise.all(openIds.map(async id => { await ensureBody(id); }));
        return openIds.length;
      })();
    if (loaded > 0) {
      renderMain();
      renderRail();
    }
  }

  async function renderAll() {
    // 并发点击会同时触发多次渲染；不丢掉后一次，而是排队再跑一遍，
    // 否则最后一次选择可能因为被守卫挡掉而不落到界面上。
    if (state.busy) {
      state.renderQueued = true;
      return;
    }
    state.busy = true;
    try {
      await renderOnce();
    } finally {
      state.busy = false;
    }
    if (state.renderQueued) {
      state.renderQueued = false;
      await renderAll();
    }
  }

  async function renderOnce() {
    if (state.session === null) {
      const first = reader.getState().sessions[0];
      state.session = first ? first.conv_key : null;
    }
    if (state.session !== null && reader.getState().sessionKey !== state.session) {
      await reader.selectSession(state.session);
    }
    const rows = currentRows();
    if (state.reqId === null) {
      state.reqId = rows[0] ? rows[0].req_id : null;
      state.open = new Set(state.reqId !== null ? [state.reqId] : []);
      state.selected = null;
    } else if (!rows.some(row => row.req_id === state.reqId)) {
      // URL 里的 req id 不在已加载页里：可能已被淘汰、从未存在、落在更早的页，
      // 或者被合并到了另一个 canonical id（此时服务端会解析成后者）。
      // 前两种要显式说明未找到；第三种只在更早的页里；第四种直接跳到 canonical。
      const requested = state.reqId;
      const detail = await ensureDetail(requested);
      const target = resolveTraceTarget(rows, requested, detail);
      if (target.kind === 'canonical' && target.reqId !== null) {
        state.reqId = target.reqId;
        state.open = new Set([target.reqId]);
        state.missingReqId = null;
        state.offPageReqId = null;
        state.selected = null;
        details.set(requested, detail ?? details.get(requested) ?? null);
      } else {
        state.missingReqId = target.kind === 'missing' ? requested : null;
        state.offPageReqId = target.kind === 'off-page' ? requested : null;
        state.reqId = null;
        state.open = new Set();
        state.selected = null;
      }
    } else {
      state.missingReqId = null;
      state.offPageReqId = null;
    }
    if (state.reqId !== null) {
      if (state.open.size === 0) state.open.add(state.reqId);
      await ensureDetail(state.reqId);
      await ensureRoute(state.reqId);
      await prefetchDetails();
      await Promise.all(currentRows().slice(0, 30).map(row => ensureRoute(row.req_id)));
    }
    // 先出界面再补正文：正文是逐个请求的网络往返，不挡住首屏。
    void loadVisibleBodies();
    renderCrumb();
    renderFilters();
    renderSessions();
    renderMain();
    renderRail();
    updateURL();
  }

  async function selectSession(/** @type {string} */ key) {
    state.session = key;
    state.reqId = null;
    state.missingReqId = null;
    state.offPageReqId = null;
    state.open = new Set();
    state.selected = null;
    state.railTab = 'facts';
    state.replyOpen = false;
    state.pendingSession = key;
    renderMain();
    await reader.selectSession(key);
    state.pendingSession = null;
    await renderAll();
    el('main').scrollTop = 0;
  }

  async function selectRequest(/** @type {number} */ id) {
    const same = state.reqId === id;
    state.reqId = id;
    state.missingReqId = null;
    state.offPageReqId = null;
    await ensureDetail(id);
    await ensureRoute(id);
    renderCrumb();
    if (!same) {
      // 换请求时清掉上一笔的消息选择，避免右栏展示另一笔的区间。
      state.selected = null;
      renderMain();
      renderRail();
    }
    updateURL();
  }

  async function jumpToLedger(/** @type {number} */ id) {
    state.view = 'ledger';
    state.reqId = id;
    state.open.add(id);
    state.selected = null;
    await ensureDetail(id);
    await ensureBody(id);
    renderMain();
    renderRail();
    renderCrumb();
    updateURL();
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-req="${CSS.escape(String(id))}"]`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  async function toggleRequest(/** @type {number} */ id) {
    const opening = !state.open.has(id);
    if (state.open.has(id)) state.open.delete(id);
    else state.open.add(id);
    state.reqId = id;
    state.selected = null;
    if (state.railTab === 'body' && !state.open.has(id)) state.railTab = 'facts';
    await ensureDetail(id);
    // 展开账本行等于明确要读正文：只读这一笔的首片。
    if (opening) await ensureBody(id);
    renderMain();
    renderRail();
    renderCrumb();
    updateURL();
  }

  /**
   * 读取正文并重绘。epoch 守卫保证迟到的响应不会覆盖后来选中的请求：
   * 写缓存的是请求自己的数据，界面只在当前选择仍匹配时才应用。
   * @param {number} id
   * @param {number} [from]
   */
  async function readBody(id, from = 0) {
    const epoch = state.reqId;
    await ensureBody(id, from);
    if (state.reqId !== epoch && state.reqId !== id) return;
    renderMain();
    renderRail();
  }

  function applyTheme() {
    if (themePref === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themePref;
    const btn = el('theme-toggle');
    btn.textContent = themePref === 'dark' ? '☾' : themePref === 'light' ? '☀' : '◐';
    btn.title = `主题：${themePref === 'system' ? '跟随系统' : themePref === 'dark' ? '深色' : '浅色'}（点击切换）`;
  }

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    // 折叠区标题与消息折叠按钮自己处理展开，不触发选中。
    if (t.closest('summary')) return;
    const bodyLoad = t.closest('[data-body-load]');
    if (bodyLoad) { void readBody(Number(/** @type {HTMLElement} */ (bodyLoad).dataset.bodyLoad)); return; }
    const bodyMore = t.closest('[data-body-more]');
    if (bodyMore) {
      const id = Number(/** @type {HTMLElement} */ (bodyMore).dataset.bodyMore);
      const loaded = bodyOf(id);
      if (loaded !== null) void readBody(id, loaded.nextFrom);
      return;
    }
    const msg = t.closest('[data-msg]');
    if (msg) {
      const owner = /** @type {HTMLElement} */ (msg).closest('[data-req]');
      const reqId = owner !== null ? Number(/** @type {HTMLElement} */ (owner).dataset.req) : state.reqId;
      if (reqId !== null && Number.isFinite(reqId)) {
        state.selected = { req: reqId, path: `messages[${Number(/** @type {HTMLElement} */ (msg).dataset.msg)}]` };
        state.railTab = 'body';
        renderMain();
        renderRail();
        updateURL();
      }
      return;
    }
    const toolResult = t.closest('[data-tool-result]');
    if (toolResult) {
      const element = /** @type {HTMLElement} */ (toolResult);
      const reqId = Number(element.dataset.toolResult);
      state.selected = { req: reqId, path: `messages[${element.dataset.toolOrd ?? '0'}]` };
      state.railTab = 'body';
      void (async () => {
        await ensureDetail(reqId);
        await ensureBody(reqId);
        state.reqId = reqId;
        renderMain();
        renderRail();
        renderCrumb();
        updateURL();
      })();
      return;
    }
    const railReply = t.closest('[data-rail-reply]');
    if (railReply) { state.selected = null; renderRail(); return; }
    const sess = t.closest('[data-session]');
    if (sess) { void selectSession(/** @type {HTMLElement} */ (sess).dataset.session ?? ''); return; }
    const agent = t.closest('[data-agent]');
    if (agent) { state.agent = /** @type {HTMLElement} */ (agent).dataset.agent ?? 'all'; renderFilters(); renderSessions(); return; }
    const view = t.closest('[data-view]');
    if (view) { state.view = /** @type {HTMLElement} */ (view).dataset.view === 'ledger' ? 'ledger' : 'conversation'; renderMain(); updateURL(); return; }
    const ledger = t.closest('[data-ledger]');
    if (ledger) { void jumpToLedger(Number(/** @type {HTMLElement} */ (ledger).dataset.ledger)); return; }
    const select = t.closest('[data-select]');
    if (select) { void selectRequest(Number(/** @type {HTMLElement} */ (select).dataset.select)); return; }
    const toggle = t.closest('[data-toggle]');
    if (toggle) { void toggleRequest(Number(/** @type {HTMLElement} */ (toggle).dataset.toggle)); return; }
    const rail = t.closest('[data-rail]');
    if (rail) {
      state.railTab = /** @type {HTMLElement} */ (rail).dataset.rail === 'body' ? 'body' : 'facts';
      // 切到正文页签是明确的阅读动作：只取这一笔首片。
      if (state.railTab === 'body' && state.reqId !== null) void ensureBody(state.reqId).then(renderRail);
      else renderRail();
      updateURL();
      return;
    }
    if (t.closest('#load-more-sessions')) {
      void reader.loadSessions(reader.getState().sessionsCursor ?? undefined).then(() => { renderSessions(); });
      return;
    }
    if (t.closest('#load-more-requests')) {
      void reader.loadRequests(reader.getState().requestsCursor ?? undefined)
        .then(prefetchDetails)
        .then(renderAll);
    }
  });

  document.addEventListener('change', (e) => {
    const target = /** @type {HTMLSelectElement} */ (e.target);
    if (target.dataset.railMsg === undefined) return;
    const reqId = Number(target.dataset.railMsg);
    state.reqId = reqId;
    state.selected = { req: reqId, path: `messages[${target.value}]` };
    renderRail();
  });

  document.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    if (target.id === 'sess-search') {
      state.query = target.value;
      renderSessions();
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('input, textarea, summary')) return;
    if (e.key === 'Escape') { state.railTab = 'facts'; renderRail(); }
  });

  el('theme-toggle').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(themePref) + 1) % order.length] ?? 'system';
    try { localStorage.setItem('tc.theme', next); } catch { /* storage may be blocked */ }
    themePref = next;
    applyTheme();
  });

  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    state.session = p.get('session');
    state.reqId = p.get('trace') ? Number(p.get('trace')) : null;
    state.missingReqId = null;
    state.offPageReqId = null;
    state.view = p.get('view') === 'ledger' ? 'ledger' : 'conversation';
    state.railTab = p.get('tab') === 'body' ? 'body' : 'facts';
    void renderAll();
  });

  applyTheme();
  void (async () => {
    try {
      await reader.loadSessions();
    } catch (error) {
      el('sessions-list').innerHTML = `<p class="sess-empty">会话列表加载失败:${esc(error instanceof Error ? error.message : 'unknown')}</p>`;
      return;
    }
    await renderAll();
  })();
}
