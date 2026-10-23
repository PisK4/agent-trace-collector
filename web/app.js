// @ts-check
/**
 * 读者前端：单一轨迹视图。窗口、正文区间、结构与工具结果都经 reader-store
 * 读取（带阅读版本）；步骤投影用 trace-view 的纯函数，这里只做装配与交互。
 * @typedef {import('../src/queries').RequestDetail} RequestDetail
 * @typedef {import('../src/queries').RequestRow} RequestRow
 * @typedef {import('../src/queries').SessionRow} SessionRow
 * @typedef {import('./reader-store.js').RequestRead} RequestRead
 * @typedef {import('../src/reading').ToolResultReading} ToolResultReading
 */

import {
  bodyNotice, deltaOrdinals, mdToHtml, messageCopyText, partColor, partLabel, roleTag,
  renderAttemptChain, renderCapabilities, renderMessageDetail, renderMessages, renderRaw, renderReply,
  renderReplyDetail, replyView, toolEntries,
} from './body-view.js';
import { createReaderStore } from './reader-store.js';
import { projectSteps, renderTraceRows, toolSummary } from './trace-view.js';

/**
 * URL 里的 trace 属于哪种情况。合并过的旧 id 会被服务端解析成 canonical：
 * 若 canonical 就在已加载窗口里，直接跳过去，不能报"未在窗口"。
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

/** 用途标签；未知类别原样显示，不猜成对话。 @param {string|null|undefined} kind */
export function purposeLabel(kind) {
  if (kind === 'title') return '标题生成';
  if (kind === 'auto-mode-classifier') return '自动模式分类';
  if (kind === 'chat') return '对话';
  return kind ?? '未知用途';
}

/**
 * 辅助行只由派生用途决定：排除用途，或组阶段给出的 aux 角色。
 * 摘要文本里的任何字样都不参与判断。
 * @param {{purpose_chain?: string|null, chain_role?: string|null, [key: string]: unknown}} row
 * @returns {boolean}
 */
export function isAuxRow(row) {
  return row.purpose_chain === 'exclude' || row.chain_role === 'aux';
}

/** @param {{req_kind?: string|null, reply_preview?: string|null, model_title?: string|null}} row @returns {string} */
export function auxSummary(row) {
  const label = purposeLabel(row.req_kind);
  if (reqKindOf(row) === 'auto-mode-classifier') {
    const match = /<block>\s*(yes|no)\s*(?:<\/block>)?/i.exec(row.reply_preview ?? '');
    const verdict = match?.[1]?.toLowerCase();
    if (verdict === 'no') return `${label} · 放行`;
    if (verdict === 'yes') return `${label} · 拦截`;
    return `${label} · 判定未知`;
  }
  if (reqKindOf(row) === 'title') {
    return row.model_title === null || row.model_title === undefined
      ? label : `${label} · ${row.model_title}`;
  }
  return label;
}
/** @param {{req_kind?: string|null}} row @returns {string|null} */
const reqKindOf = (row) => row.req_kind ?? null;

/**
 * 重绘后把滚动位置放回去。内容变短时夹到新的可滚动上限内。
 * @param {{scrollHeight?: number, clientHeight?: number, scrollTop: number}} element
 * @param {number} previous
 * @returns {number}
 */
export function restoreScroll(element, previous) {
  const max = Math.max(0, (element.scrollHeight ?? 0) - (element.clientHeight ?? 0));
  element.scrollTop = Math.min(Math.max(0, previous), max);
  return element.scrollTop;
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
  const AGENT_LABELS = /** @type {Record<string, string>} */ ({ claude: 'Claude Code', omp: 'OMP' });
  /** @param {string} v */
  const agentLabel = (v) => AGENT_LABELS[v] ?? v;

  /** @param {string} key */
  function sessionKeyLabel(key) {
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        const value = String(parsed[1]);
        return parsed[0] === 'session' ? `session ${value.slice(0, 8)}…` : `${String(parsed[0])} ${value}`;
      }
    } catch { /* 不是 JSON 时原样显示 */ }
    return key;
  }

  const store = createReaderStore((/** @type {string} */ url) => fetch(url));
  /** @type {Map<number, RequestRead>} 窗口内请求的已读取内容；随会话切换清空。 */
  const reads = new Map();
  /** @type {Map<string, ToolResultReading>} 工具结果按 `${owner}:${ord}` 缓存展示层副本。 */
  const toolReadings = new Map();
  /** @type {Map<number, {state: string, summary: unknown}>} 路由只在展开时读取。 */
  const routes = new Map();

  const qp = new URLSearchParams(location.search);
  const state = {
    session: qp.get('session'),
    reqId: qp.get('trace') ? Number(qp.get('trace')) : null,
    /** URL 指定的请求在库里不存在。 */
    missingReqId: /** @type {number | null} */ (null),
    /** URL 指定的请求存在，但落在当前窗口外（更早的历史）。 */
    offPageReqId: /** @type {number | null} */ (null),
    selectedStep: /** @type {string | null} */ (null),
    toolOrd: /** @type {number | null} */ (null),
    stepOpen: new Set(/** @type {string[]} */ ([])),
    requestOpen: new Set(/** @type {number[]} */ ([])),
    railTab: ['body', 'tools', 'route'].includes(qp.get('tab') ?? '') ? qp.get('tab') : 'facts',
    query: '',
    agent: 'all',
    pendingSession: /** @type {string | null} */ (null),
    /** 最近一次显式刷新时间；刷新会重建最近窗口并清掉旧阅读版本。 */
    refreshedAt: /** @type {number | null} */ (null),
    /** 用户主动滚动后不再强制补偿过期锚点。 */
    userScrolled: false,
    /** 首载批次是否已把选中组带入可见区；加载更早不再重复居中。 */
    revealed: false,
  };
  /** 载入窗口详情的轮次：换会话或刷新时自增，作废在跑的批次。 */
  let loadEpoch = 0;
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

  /** @param {string} key @returns {SessionRow | null} */
  function sessionRow(key) {
    return /** @type {SessionRow | null} */ (store.getSessions().items.find(
      (/** @type {{conv_key: string}} */ row) => row.conv_key === key) ?? null);
  }
  function currentRows() {
    return store.getWindow().requests;
  }
  /**
   * 请求序号是当前载入窗口内的正序位置：加载更早记录后重新编号，
   * 内部身份、跳转与缓存键都用 req_id，不用数字。
   * @param {number} reqId
   */
  function ordinalOf(reqId) {
    const rows = currentRows();
    const index = rows.findIndex(row => row.req_id === reqId);
    return index < 0 ? 0 : index + 1;
  }
  function currentRow() {
    return currentRows().find(row => row.req_id === state.reqId) ?? null;
  }
  function currentRead() {
    return state.reqId === null ? null : reads.get(state.reqId) ?? null;
  }
  function currentDetail() {
    return currentRead()?.detail ?? null;
  }
  /** @param {string} id */
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
  /** @param {string} value */
  function shortId(value) {
    return value.length > 12 ? `${value.slice(0, 8)}…` : value;
  }
  /** 初始窗口大小按视口高度估算：至少 30 行，行高 34 计，上限 100。 */
  function windowLimit() {
    return Math.min(100, Math.max(30, Math.ceil(window.innerHeight / 34)));
  }

  /** 批量载入窗口内请求的详情、元信息与最多两片可信增量；每批完成重绘一次。 */
  async function loadWindowReads() {
    const epoch = ++loadEpoch;
    const wanted = currentRows().filter(row => !reads.has(row.req_id));
    for (let index = 0; index < wanted.length; index += 4) {
      if (epoch !== loadEpoch) return;
      const chunk = wanted.slice(index, index + 4);
      await Promise.all(chunk.map(async row => {
        try {
          const read = await store.readRequest(row.req_id);
          reads.set(row.req_id, read);
          if (!read.delta.done) await store.loadDelta(row.req_id, 2).then(next => reads.set(row.req_id, next));
        } catch { /* 单笔失败保留占位记录；刷新可重试 */ }
      }));
      if (epoch !== loadEpoch) return;
      renderMain();
      // 首载批次会让选中组下移：初始载入期间保持它可见；加载更早不重复居中。
      if (!state.userScrolled && !state.revealed) ensureSelectedVisible();
    }
    if (epoch === loadEpoch) state.revealed = true;
  }

  /* ---------------- 顶栏与左栏 ---------------- */
  function renderCrumb() {
    const row = state.session === null ? null : sessionRow(state.session);
    const idx = ordinalOf(state.reqId ?? -1);
    const here = state.missingReqId !== null ? `Request ${state.missingReqId} 未找到`
      : state.offPageReqId !== null ? `Request ${state.offPageReqId} 未在当前窗口`
        : idx > 0 ? `Request ${String(idx).padStart(2, '0')}` : '未选择请求';
    el('crumb').innerHTML =
      `<span>${esc(row ? row.title : '未选择会话')}</span><span class="sep">/</span><b>${esc(here)}</b>`;
    document.title = row ? `${here === '未选择请求' ? row.title : `${here} · ${row.title}`} — Trace Collector`
      : 'Trace Collector';
  }

  function renderFilters() {
    const counts = new Map();
    for (const s of /** @type {SessionRow[]} */ (store.getSessions().items)) {
      for (const agent of s.agents) counts.set(agent, (counts.get(agent) ?? 0) + s.request_count);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .filter(([agent, count]) => count >= 50 || agent === state.agent)
      .map(([agent]) => agent)
      .slice(0, 7);
    el('agent-filters').innerHTML = ['all', ...ranked].map(a =>
      `<button class="chip-btn" data-agent="${esc(a)}" aria-pressed="${state.agent === a}" title="${esc(a)}">${a === 'all' ? '全部 Agent' : esc(agentLabel(a))}</button>`,
    ).join('');
  }

  /** @param {SessionRow} s */
  function sessionMatches(s) {
    if (state.agent !== 'all' && !s.agents.includes(state.agent)) return false;
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return [s.title, ...s.agents, ...s.agents.map(agentLabel)].join(' ').toLowerCase().includes(q);
  }

  function renderSessions() {
    const list = /** @type {SessionRow[]} */ (store.getSessions().items.filter(sessionMatches));
    el('load-more-sessions').hidden = store.getSessions().cursor === null;
    el('sess-count').textContent = `${list.length} / 已加载 ${store.getSessions().items.length}`;
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
          <span class="who">${esc(s.agents.length > 0 ? s.agents.map(agentLabel).join(' · ') : '归属未知')}</span><span class="sep">·</span>
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
  function statusOf(r) {
    if (r.status === null) return { cls: 'mute', label: '状态待确认', title: '上游没有报告状态码' };
    if (r.status >= 400) return { cls: 'bad', label: `HTTP ${r.status}`, title: `HTTP ${r.status}` };
    return { cls: 'ok', label: '', title: `HTTP ${r.status}` };
  }
  /** @param {RequestRow} r */
  function statusDot(r) {
    const status = statusOf(r);
    return `<span class="status-dot ${status.cls}" title="${esc(status.title)}"></span>`;
  }
  /** @param {RequestRow} r */
  function statusChip(r) {
    const status = statusOf(r);
    return status.label === ''
      ? ''
      : `<span class="state-chip ${status.cls}"><span class="d"></span>${status.label}</span>`;
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
  /** @param {RequestRow} r */
  function bodyLabelText(r) {
    if (r.body_state === 'available') return '正文可读，尚未读取；点开后才下载这一片。';
    if (r.body_state === 'pending') return `正文未到${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    if (r.body_state === 'partial') return `正文不完整${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    if (r.body_state === 'evicted') return `正文已回收${r.miss_reason ? `：${r.miss_reason}` : ''}`;
    return '原对象已保存，暂不支持结构化解析。';
  }
  /** @param {RequestRow[]} rows */
  function timingSummary(rows) {
    const ttfts = rows.map(r => r.ttft_ms).filter(v => v !== null).sort((a, b) => a - b);
    const durations = rows.map(r => r.ms).filter(v => v !== null);
    const median = ttfts.length === 0 ? null : ttfts[Math.floor(ttfts.length / 2)] ?? null;
    const average = durations.length === 0 ? null : durations.reduce((a, v) => a + v, 0) / durations.length;
    const genMs = rows.reduce((a, r) => {
      if (r.flow_ms !== null) return a + r.flow_ms;
      if (r.ms !== null && r.ttft_ms !== null) return a + Math.max(0, r.ms - r.ttft_ms);
      return a;
    }, 0);
    const outTok = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
    return {
      median, average,
      speed: genMs > 0 && outTok > 0 ? Math.round(outTok / (genMs / 1000)) : null,
    };
  }
  /** @param {number|null} reqId */
  function relationTextOf(reqId) {
    const detail = reqId === null ? null : reads.get(reqId)?.detail ?? null;
    if (detail === null) return '';
    if (detail.derivation === undefined || detail.derivation.chain_state !== 'current') {
      return '关系待重建或为旧结果，不标记新增';
    }
    if (detail.purpose_chain === 'exclude' || detail.chain_role === 'aux') return '辅助请求，不在主链上';
    if (detail.prev_relation === 'first') return '会话首笔';
    if (detail.prev_relation === 'confirmed') return '续自上一笔';
    if (detail.prev_relation === 'branch') return '另起一支';
    if (detail.prev_relation === 'unknown') return '前驱正文不可读，无法比对';
    return '';
  }

  function sessionHead() {
    const row = state.session === null ? null : sessionRow(state.session);
    const rows = currentRows();
    const unknown = state.session !== null && row === null;
    const first = rows[0] ?? null;
    const latest = rows[rows.length - 1] ?? null;
    const totalIn = rows.reduce((a, r) => a + (r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0), 0);
    const totalOut = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
    const priced = rows.filter(r => r.cost_state === 'priced' || r.cost_state === 'zero');
    const totalCost = priced.reduce((a, r) => a + (r.cost ?? 0), 0);
    const hasUsage = rows.some(r => r.in_tok !== null || r.out_tok !== null);
    const missing = rows.filter(r => r.body_state === 'pending' || !(r.have & 1)).length;
    const failures = rows.filter(r => r.status !== null && r.status >= 400).length;
    const timing = timingSummary(rows);
    const timingParts = [
      timing.median !== null ? `首字 p50 ${secs(timing.median)}` : null,
      timing.average !== null ? `平均时长 ${secs(timing.average)}` : null,
      timing.speed !== null ? `输出 ${timing.speed} tok/s` : null,
    ].filter(Boolean);
    const window = store.getWindow();
    return `<header class="session-head">
      <div class="eyebrow">${state.session !== null && state.session.startsWith('["session"') ? 'Session' : 'Unassigned'}</div>
      <h1>${esc(row ? row.title || '（无标题）' : unknown ? '这个会话不在已加载列表里' : '未选择会话')}</h1>
      <div class="session-facts">
        ${row && row.agents.length > 0 ? row.agents.map((/** @type {string} */ a) => `<span><b title="${esc(a)}">${esc(agentLabel(a))}</b></span>`).join('') : '<span class="muted">归属未知</span>'}
        <span class="mono" title="${esc(state.session ?? '')}">${esc(state.session === null ? '' : sessionKeyLabel(state.session))}</span>
        <span>已加载 <b>${rows.length}</b> 笔 Request</span>
        ${first && latest ? `<span>${esc(dayTime(first.started_ms))}–${esc(clock(latest.started_ms))}</span>` : ''}
        ${timingParts.length > 0 ? `<span class="sum">${timingParts.join(' · ')}</span>` : ''}
        ${failures > 0 ? `<span style="color:var(--bad)">${failures} 笔失败</span>` : ''}
        ${hasUsage
        ? `<span class="sum">已加载相加：${kk(totalIn)} 提示 · ${kk(totalOut)} 输出 · $${totalCost.toFixed(4)}${priced.length < rows.length ? ` · ${rows.length - priced.length} 笔未取得费用` : ''}</span>`
        : '<span class="sum muted">这批记录没有报告的用量，合计为空</span>'}
      </div>
      <div class="view-row">
        <span class="timeline-tab">步骤轨迹</span>
        <span class="hint">单行步骤 · 详情默认折叠 · 数字表示当前窗口内的请求</span>
        <span class="grow"></span>
        ${state.refreshedAt !== null ? `<span class="hint">刷新于 ${esc(clock(state.refreshedAt))}</span>` : ''}
        <button class="chip-btn" id="refresh-window" title="重新读取最近窗口；输入变化会换发阅读版本">刷新</button>
        <button class="chip-btn" id="jump-latest">回到最新 ↓</button>
      </div>
      ${unknown ? `<div class="session-note warn"><span>↳</span><span>链接里的会话 key 不在已加载的会话里：可能是已淘汰、从未记录，或者还在后面的会话页。下面没有用别的会话顶替。</span></div>` : ''}
      ${missing > 0 ? `<div class="session-note warn"><span>↳</span><span>已加载请求中有 ${missing} 笔正文未到或没有回调；它们保留身份与读数，不用另一笔的正文替代。</span></div>` : ''}
      ${state.missingReqId !== null ? `<div class="session-note warn"><span>↳</span><span>链接里的 Request ${state.missingReqId} 在当前库里不存在，也没有别名指向它。下面显示的是本会话的请求，不是那一笔。</span></div>` : ''}
      ${state.offPageReqId !== null ? `<div class="session-note"><span>↳</span><span>链接里的 Request ${state.offPageReqId} 存在，但不在当前载入窗口（可能在更早的历史里）；从顶部加载更早记录后可以选到它，右栏已显示它的详情。不自动扫描全部历史。</span></div>` : ''}
      ${window.error !== null ? `<div class="session-note warn"><span>↳</span><span>请求窗口读取失败：${esc(window.error)}。已加载内容保持不变，可重试。</span></div>` : ''}
    </header>`;
  }

  /**
   * 步骤详情：按投影种类渲染。工具步骤触发按调用位置的结果读取；
   * 每个详情附「请求详情」折叠区（结构、路由与原始对象按需读取）。
   * @param {RequestRow} row
   * @param {RequestRead|null} read
   * @param {{key:string, kind:string, text:string, raw:unknown, callOrd:number|null, unrecognized?: boolean}} step
   */
  function stepDetailHtml(row, read, step) {
    let body = '';
    if (step.kind === 'user') {
      body = `<div class="detail-label">用户输入${step.unrecognized ? ' · 包装未识别，按原文保留' : ''}</div>
        <div class="trace-prose">${esc(typeof step.raw === 'string' ? step.raw : step.text)}</div>`;
    } else if (step.kind === 'assistant') {
      body = `<div class="detail-label">回复原文</div><div class="trace-prose">${mdToHtml(String(step.raw ?? step.text))}</div>`;
    } else if (step.kind === 'tool') {
      const detail = read?.detail ?? null;
      const pair = detail?.tool_calls.find((/** @type {{ord: number}} */ item) => item.ord === step.callOrd) ?? null;
      const view = read !== null && read.meta !== null ? replyView(read.meta) : null;
      const call = view?.calls.find(item => item.ord === step.callOrd) ?? null;
      const inputText = call?.inputText ?? (pair?.tool_name !== undefined ? JSON.stringify({ name: pair.tool_name }) : '');
      const reading = toolReadings.get(`${row.req_id}:${step.callOrd}`) ?? null;
      body = `<div class="inline-tool">
        <div><div class="detail-label">调用参数 · ${esc(toolSummary(call?.name ?? pair?.tool_name ?? '', inputText))}</div>
          <pre class="raw">${esc(inputText)}</pre></div>
        <div><div class="detail-label">结果关联 ${esc(pair?.state ?? 'unpaired')} · 正文加载 ${reading === null ? '未读取' : reading.state}</div>${toolResultHtml(row.req_id, step.callOrd ?? 0, reading)}</div>
      </div>`;
      // 打开即读取：按调用位置读取当前来源的结果。
      void readToolResult(row.req_id, step.callOrd ?? 0);
    } else {
      body = `<div class="detail-label">记录</div><div class="trace-prose">${esc(step.text)}</div>
        ${step.raw !== null && step.raw !== undefined ? `<pre class="raw">${esc(raw(step.raw))}</pre>` : ''}`;
    }
    return `${body}<details class="trace-context"><summary>请求详情 · 结构、路由与原始对象</summary>${requestDetailSection(row, read)}</details>`;
  }

  /**
   * 工具结果块：关联与正文加载分立；未读取不写未记录，失败保留重试。
   * @param {number} ownerId @param {number} callOrd @param {ToolResultReading|null} reading
   */
  function toolResultHtml(ownerId, callOrd, reading) {
    if (reading === null) {
      return '<p class="note">结果未读取；打开详情时按调用位置读取。</p>';
    }
    if (reading.state === 'available') {
      return `<pre class="raw">${esc(typeof reading.content === 'string' ? reading.content : raw(reading.content))}</pre>
        ${reading.is_error === true ? '<p class="note warn">结果标记 is_error：工具执行失败；与关联已确认是两回事。</p>' : ''}
        <button class="chip-btn" data-locate="${reading.target?.req_id ?? ''}">查看承载结果的请求 ${reading.target?.req_id ?? ''} →</button>`;
    }
    if (reading.state === 'pending') return '<p class="note">结果位置待定：派生还没算完，不猜配对。</p>';
    if (reading.state === 'ambiguous') return '<p class="note">结果有多个候选，未配对。</p>';
    if (reading.state === 'unpaired') return '<p class="note">还没有见到这一调用的结果。</p>';
    if (reading.state === 'invalid_location') return `<p class="note warn">结果位置无效（${esc(reading.reason ?? '')}），不跨请求搜索或回退第一块。</p>`;
    return `<p class="note warn">结果正文不可读（${esc(reading.reason ?? '')}）。</p>`;
  }

  /** @param {number} ownerId @param {number} callOrd */
  async function readToolResult(ownerId, callOrd) {
    const key = `${ownerId}:${callOrd}`;
    if (toolReadings.has(key)) return toolReadings.get(key) ?? null;
    try {
      const reading = await store.readToolResult(ownerId, callOrd);
      toolReadings.set(key, reading);
    } catch (error) {
      toolReadings.set(key, /** @type {ToolResultReading} */ ({
        owner_req: ownerId, call_ord: callOrd, reading_token: '',
        state: 'unavailable', target: null, content: null, is_error: null,
        reason: error instanceof Error ? error.message : 'read_failed',
      }));
    }
    renderMain();
    renderRail();
    return toolReadings.get(key) ?? null;
  }

  /**
   * 原位请求详情：结构按片读取、路由按需、原始对象标明当前已读范围。
   * @param {RequestRow} row @param {RequestRead|null} read
   */
  function requestDetailSection(row, read) {
    const detail = read?.detail ?? null;
    const structure = read?.structure ?? null;
    const route = routes.get(row.req_id) ?? null;
    const delta = detail === null ? null : deltaOrdinals(detail);
    const relation = relationTextOf(row.req_id);
    const entries = read?.entries ?? [];
    const unread = structure !== null && structure.total !== null && structure.next < structure.total;
    return `<div class="req-body">
      <div class="body-top">
        <span class="id">req ${row.req_id}</span>
        ${statusDot(row)}${statusChip(row)}
        <span class="muted">${esc(viaText(row))}</span>
        ${row.actor ? `<span class="muted" title="会话 / 子代理：${esc(row.actor)}">actor ${esc(shortId(row.actor))}</span>` : '<span class="muted">会话身份未知</span>'}
        <span class="grow"></span>
      </div>
      ${read !== null && read.meta !== null ? renderCapabilities(read.meta) : ''}
      <section class="section">
        <div class="section-head">
          <h3>请求结构</h3>
          <span class="count">${structure === null || structure.total === null ? `${entries.length} 条消息` : `${structure.next} / ${structure.total} 条消息`}</span>
          ${delta !== null ? `<span class="count" style="color:var(--accent)">新增 ${delta.size}</span>` : ''}
        </div>
        ${read !== null && read.meta !== null && bodyNotice(read.meta) ? `<p class="note">${esc(bodyNotice(read.meta))}</p>` : ''}
        ${relation && delta === null ? `<p class="note">${esc(relation)}：不标记新增消息，按原顺序列出。</p>` : ''}
        ${entries.length > 0
        ? renderMessages(entries, { delta, limit: entries.length, selectedOrd: null })
        : `<p class="note">${read === null ? '尚未读取这一笔的正文。' : esc(bodyLabelText(row))}</p>`}
        ${(read !== null && (row.body_state === 'available' || row.body_state === 'partial'))
        ? `<div class="conv-tools"><button class="chip-btn" data-structure-more="${row.req_id}" ${structure?.loading ? 'disabled' : ''}>${structure?.error ? '重试读取' : `加载下一片（已读 ${structure?.next ?? 0}${structure?.total === null || structure?.total === undefined ? '' : ` / ${structure.total}`}）`}</button></div>`
        : ''}
      </section>
      ${read !== null && read.meta !== null ? `<section class="section"><div class="section-head"><h3>本次回复</h3><span class="count">与请求上下文分开保存</span></div>${renderReply(replyView(read.meta), detail === null ? [] : toolEntries(detail, read.meta))}</section>` : ''}
      <div class="disclosures">
        <details><summary>路由与尝试</summary><div class="d-body">${routeBlock(row, route)}</div></details>
        <details><summary>采集完整性与阅读边界</summary><div class="d-body">${completenessRows(row, detail)}</div></details>
        <details><summary>原始脱敏对象（当前已读范围）</summary><div class="d-body">${
          read !== null && read.meta !== null
            ? renderRaw({ ...read.meta, messages: [], coverage: { ...read.meta.coverage, from: structure?.next ?? 0 } })
            : '<p class="note">这一片正文还没读取，展开后再看原始对象。</p>'
        }</div></details>
      </div>
    </div>`;
  }

  /** @param {RequestRow} r @param {{state: string, summary: unknown} | null} route */
  function routeBlock(r, route) {
    if (route === null) {
      void store.readRoute(r.req_id).then(loaded => {
        routes.set(r.req_id, /** @type {{state: string, summary: unknown}} */ (loaded));
        renderMain();
        renderRail();
      }).catch(() => {});
      return `<p class="note">${esc(viaText(r))}。正在读取路由信息…</p>`;
    }
    if (route.state === 'absent') {
      return '<p class="note">这笔记录没有网关路由：它可能没有经过 magpie 路由器，或尚未与路由文件关联。</p>';
    }
    if (route.state === 'expired') {
      return '<p class="note">原始路由已过期，长期摘要也没有留下。这里不返回空对象冒充已取得。</p>';
    }
    const s = /** @type {Record<string, unknown>} */ (route.summary);
    const order = Array.isArray(s.order) ? s.order : [];
    const attempts = /** @type {import('../src/queries').AttemptChain | null} */ (s.attempts ?? null);
    return `<dl class="chain">
      <div class="chain-row"><dt>候选顺序</dt><dd class="mono" style="font-size:10px">${order.map(o => esc(raw(o))).join(' → ') || '<span class="muted">未报告</span>'}</dd></div>
      <div class="chain-row"><dt>实际去向</dt><dd>${s.served ? `<code>${esc(s.served)}</code>` : '<span class="muted">未报告</span>'} · <code>${esc(s.provider ?? 'unknown')}</code></dd></div>
      <div class="chain-row"><dt>状态</dt><dd>HTTP ${esc(s.status ?? '—')} · ${secs(/** @type {number|null} */ (s.ms))}</dd></div>
      ${attempts !== null && attempts.state !== 'empty' ? `<div class="chain-row"><dt>尝试链</dt><dd>${renderAttemptChain(attempts)}</dd></div>` : ''}
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

  /** 单一轨迹：每请求一个组，步骤行 + 展开详情；顶部历史入口与状态说明。 */
  function traceHtml() {
    const window = store.getWindow();
    const rows = currentRows();
    let html = `<div class="step-list"><div class="history-loader">`;
    if (window.loading) {
      html += '<span class="history-start">正在读取更早记录…</span>';
    } else if (window.olderCursor !== null) {
      html += '<button id="load-earlier" class="history-button">↑ 加载更早记录</button>';
    } else if (rows.length > 0) {
      html += '<span class="history-start">已到会话起点</span>';
    }
    html += '<span class="history-range">序号表示当前窗口内的请求 · 时间从上往下 · 详情默认折叠</span></div>';
    for (const r of rows) {
      const read = reads.get(r.req_id) ?? null;
      const steps = projectSteps(r, read);
      const openKeys = new Set([...state.stepOpen].filter(key => key.startsWith(`${r.req_id}:`)));
      const ordinal = ordinalOf(r.req_id);
      html += `<section class="trace-group" data-req="${r.req_id}" data-status="${r.status === null ? 'unknown' : r.status >= 400 ? 'failed' : 'success'}" aria-current="${r.req_id === state.reqId}">`;
      html += renderTraceRows(r, steps, ordinal, openKeys, read !== null && read.delta.done);
      // 展开的步骤由 app 按键填充详情；renderTraceRows 只给折叠行。
      for (const step of steps) {
        if (!state.stepOpen.has(step.key)) continue;
        html += `<div class="trace-step-detail" data-step-detail="${esc(step.key)}">${stepDetailHtml(r, read, step)}</div>`;
      }
      html += '</section>';
    }
    if (rows.length === 0) {
      html += `<p class="sess-empty">${state.pendingSession !== null ? '正在读取请求…' : '这个会话没有已记录的请求。'}</p>`;
    }
    return html + `<div class="timeline-end"><span></span> 已是最新记录</div></div>`;
  }

  function renderMain() {
    const main = el('main');
    const keep = main.scrollTop;
    if (state.pendingSession !== null) {
      main.innerHTML = `<p class="sess-empty" style="padding:24px">正在读取${esc(shortSession(state.pendingSession))}的请求…</p>`;
      restoreScroll(main, keep);
      return;
    }
    main.innerHTML = sessionHead() + traceHtml();
    restoreScroll(main, keep);
  }

  /* ---------------- 右栏 ---------------- */
  /** @param {RequestRow} r */
  function bigNumbers(r) {
    const d = currentDetail();
    const ttft = d?.ttft_ms ?? r.ttft_ms;
    const ms = d?.ms ?? r.ms;
    const flow = d?.flow_ms ?? r.flow_ms
      ?? (ms !== null && ttft !== null ? Math.max(0, ms - ttft) : null);
    const speed = flow && r.out_tok ? r.out_tok / (flow / 1000) : null;
    const cells = [
      ['首字', ttft !== null ? (ttft / 1000).toFixed(2) : '—', ttft !== null ? 's' : '', 'TTFT：到第一个内容'],
      ['时长', ms !== null ? (ms / 1000).toFixed(2) : '—', ms !== null ? 's' : '', '从请求到回复结束'],
      ['输出速度', speed ? String(Math.round(speed)) : '—', speed ? 'tok/s' : '', '输出 token ÷ 生成耗时'],
    ];
    return `<div class="rail-big">${cells.map(([k, v, u, title]) => `<div title="${esc(title)}">
      <div class="k">${k}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div></div>`).join('')}</div>`;
  }

  function railHead() {
    const r = currentRow();
    if (r === null) {
      if (state.offPageReqId !== null) {
        return `<div class="rail-id"><span>req ${state.offPageReqId} · 未在当前窗口</span></div>`;
      }
      return '<div class="rail-id">未选择请求</div>';
    }
    return `<div class="rail-id"><span>req ${r.req_id}</span><span class="muted">·</span><span>${esc(dayTime(r.started_ms))}</span>
      ${r.agent === null ? '' : `<span class="muted">·</span><span>${esc(agentLabel(r.agent))}</span>`}
      <span class="grow"></span>${statusDot(r)}${statusChip(r)}</div>
      <div class="rail-title">${esc(r.title || '（无标题）')}</div>
      ${bigNumbers(r)}
      <div class="rail-tabs" role="tablist">
        <button role="tab" data-rail="facts" aria-pressed="${state.railTab === 'facts'}">读数</button>
        <button role="tab" data-rail="body" aria-pressed="${state.railTab === 'body'}">正文</button>
        <button role="tab" data-rail="route" aria-pressed="${state.railTab === 'route'}">路由</button>
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
    const ms = d?.ms ?? r.ms;
    const ttft = d?.ttft_ms ?? r.ttft_ms;
    if (ms === null) {
      return `<section class="rail-section"><h3>时间构成</h3>
        <p class="rail-note">${(r.have & 2) ? '上游没有报告本笔耗时。' : '这笔记录还没有关联到账本，没有网关计时。'}</p></section>`;
    }
    const waitPct = ttft !== null ? Math.min(100, ttft / ms * 100) : 100;
    const tickPct = d?.first_text_ms != null && ms > 0 ? Math.min(100, d.first_text_ms / ms * 100) : null;
    const flow = d?.flow_ms ?? r.flow_ms ?? (ttft !== null ? Math.max(0, ms - ttft) : null);
    const speed = flow && r.out_tok ? Math.round(r.out_tok / (flow / 1000)) : null;
    const rows = [
      ttft !== null
        ? `<span class="k"><i class="sw" style="background:var(--line-strong)"></i>首字前（排队 + 网络 + 首 token）</span><span class="v">${secs(ttft)}</span>`
        : `<span class="k"><i class="sw" style="background:var(--line-strong)"></i>首字前</span><span class="v">未报告</span>`,
      ttft !== null
        ? `<span class="k"><i class="sw" style="background:var(--accent);opacity:.62"></i>首字后生成</span><span class="v">${secs(ms - ttft)}</span>`
        : '',
      `<span class="k"><i class="sw" style="background:var(--text);width:2px;height:9px;border-radius:1px"></i>首个文本</span><span class="v">${d?.first_text_ms != null ? secs(d.first_text_ms) : '未报告'}</span>`,
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
    const p = d?.prompt ?? null;
    const list = /** @type {{kind: string, tokens: number}[]} */ (p?.parts ?? []);
    if (p === null || (p.tokens === null && list.length === 0)) {
      return `<section class="rail-section"><h3>上下文组成</h3>
        <p class="rail-note">${esc(p?.note ?? '没有路由侧的 prompt 分析。可能是该请求未经网关规则路由，或路由记录已超出保留期。')}</p></section>`;
    }
    const sum = list.reduce((a, x) => a + x.tokens, 0) || 1;
    const ordered = [...list].sort((a, b) => b.tokens - a.tokens);
    /** @type {Record<string,string>} */
    const stateText = { recomputed: '当前结果', retained: '旧结果', missing: '缺失' };
    const hint = `${stateText[p.state] ?? p.state} · ${p.counted === true ? '总量已校准' : '本地估计'}`;
    const usage = p.ratio !== null
      ? `<div class="usage-bar" aria-hidden="true"><i style="width:${Math.min(100, p.ratio * 100)}%;background:var(--accent)"></i></div>`
      : '';
    const ratioText = p.ratio !== null
      ? `<span>占用 <b>${(p.ratio * 100).toFixed(1)}%</b></span>`
      : '';
    const note = p.note ?? (p.window === null ? '没有可用分母，不显示占用率。' : '分类是估计分配，不是逐类精确计数。');
    return `<section class="rail-section">
      <h3>上下文组成<span class="grow"></span><span class="hint">${esc(hint)}</span></h3>
      ${usage}
      <div class="comp-bar" aria-hidden="true">${list.filter(x => x.tokens > 0).map(x => `<i style="flex:${x.tokens / sum};background:${partColor(String(x.kind))}"></i>`).join('')}</div>
      <div class="comp-legend">${ordered.map(x => `<span class="name"><i class="sw" style="background:${partColor(String(x.kind))}"></i><span>${esc(partLabel(String(x.kind)))}</span></span>
        <span class="val">${kk(x.tokens)}</span><span class="pct">${Math.round(x.tokens / sum * 100)}%</span>`).join('')}</div>
      <div class="u-total" style="margin-top:8px"><span>提示总量 <b>${n(p.tokens ?? 0)}</b></span><span>${p.window ? `窗口 <b>${kk(p.window)}</b>` : '窗口未知'}</span>${ratioText}</div>
      <p class="rail-note">${esc(note)}</p>
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
    const r = currentRow();
    if (r === null) return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    return usageSection(r) + timingSection(r) + promptSection(r) + completenessSection(r);
  }

  /** @param {string} path @returns {number | null} */
  function messageOrdOf(path) {
    const match = /^messages\[(\d+)\]$/.exec(path);
    return match === null ? null : Number(match[1]);
  }

  function railBody() {
    const r = currentRow();
    if (r === null) {
      if (state.offPageReqId !== null) {
        const read = reads.get(state.offPageReqId) ?? null;
        return `<section class="rail-section"><h3>窗口外请求</h3><p class="rail-note">Request ${state.offPageReqId} · ${esc(read?.detail?.title ?? '详情见读取结果')} 不在当前载入窗口（可能在更早的历史里）。这里只读了它的详情；需要完整轨迹请从顶部加载更早记录，不自动扫描全部历史。</p></section>${read?.detail ? usageSection(read.detail) + timingSection(read.detail) : ''}`;
      }
      return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    }
    if (state.railTab === 'facts') return railFacts();
    if (state.railTab === 'route') {
      const route = routes.get(r.req_id) ?? null;
      return `<section class="rail-section"><h3>路由与尝试</h3>${routeBlock(r, route)}</section>`;
    }
    const read = reads.get(r.req_id) ?? null;
    if (read === null || read.meta === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyLabelText(r))}
        ${canLoad ? `<div style="margin-top:10px"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}</div>`;
    }
    const page = read.meta;
    if (page.state !== 'available' && page.state !== 'partial') {
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyNotice(page) || '这一笔没有可读的正文。')}</div>`;
    }
    const view = replyView(page);
    const detail = read.detail ?? null;
    const tools = detail === null ? [] : toolEntries(detail, page);
    const selected = state.selectedStep !== null && state.toolOrd === null
      && state.selectedStep.startsWith(`${r.req_id}:message:`)
      ? Number(state.selectedStep.split(':').pop() ?? NaN)
      : NaN;
    const chosen = Number.isFinite(selected)
      ? read.entries.find((/** @type {{ord: number}} */ entry) => entry.ord === selected) ?? null
      : null;
    const body = chosen !== null
      ? renderMessageDetail(chosen)
      : view.state === 'ok'
        ? renderReplyDetail(view, tools)
        : `<div class="rail-empty"><b>没有可读的回复</b>${esc(bodyNotice(page) || '这一笔只有请求。')}</div>`;
    const structure = read.structure;
    const unread = structure.total !== null && structure.next < structure.total;
    return `${bodyNotice(page) ? `<p class="rail-note" style="margin-bottom:8px">${esc(bodyNotice(page))}</p>` : ''}
      ${body}
      <div class="conv-tools" style="padding:10px 0 0">
        <span class="label">请求消息</span>
        <button class="chip-btn" data-rail-reply="1" aria-pressed="${chosen === null}">本次回复</button>
        ${read.entries.length > 0
        ? `<select class="mini-search" data-rail-msg="${r.req_id}" aria-label="选择消息">
              ${read.entries.slice(0, 300).map((/** @type {{ord: number, role: 'user'|'assistant'|'system'|'tool'|'unknown', preview: string}} */ entry) => `<option value="${entry.ord}" ${chosen !== null && chosen.ord === entry.ord ? 'selected' : ''}>#${entry.ord} ${roleTag(entry.role)} · ${esc(clipText(entry.preview, 40))}</option>`).join('')}
            </select>`
        : '<span class="muted" style="font-size:10.5px">这一笔没有消息正文</span>'}
      </div>
      ${unread ? `<div style="margin-top:8px"><button class="chip-btn" data-structure-more="${r.req_id}">加载下一片（已读 ${structure.next} / ${structure.total}）</button></div>` : ''}`;
  }

  /** @type {number | null} */
  let lastRailReq = null;
  function renderRail() {
    el('rail-head').innerHTML = railHead();
    const rail = el('rail-body');
    const keep = state.reqId !== null && state.reqId === lastRailReq ? rail.scrollTop : 0;
    rail.innerHTML = railBody();
    restoreScroll(rail, keep);
    lastRailReq = state.reqId;
  }

  function renderAll() {
    renderCrumb();
    renderFilters();
    renderSessions();
    renderMain();
    renderRail();
    updateURL();
  }

  /* ---------------- 窗口导航 ---------------- */
  /** 当前滚动容器：main 独立滚动时用 main，窄屏文档流用 scrollingElement。 */
  function scroller() {
    const main = el('main');
    return getComputedStyle(main).overflowY === 'visible' ? document.scrollingElement : main;
  }
  /** 记录当前可见的第一条稳定步骤键与其视口位置，作为 prepend 的锚点。 */
  function anchorSnapshot() {
    const step = /** @type {HTMLElement | null} */ (document.querySelector('.compact-step'));
    if (step === null) return null;
    const expand = /** @type {HTMLElement | null} */ (step.querySelector('.step-expand'));
    return { key: expand?.dataset.stepExpand ?? null, top: step.getBoundingClientRect().top };
  }
  /** @param {ReturnType<typeof anchorSnapshot>} before */
  function compensateAnchor(before) {
    if (before === null || before.key === null || state.userScrolled) return;
    const key = before.key;
    const expected = before.top;
    // 两帧各校一次：首帧布局未稳的亚像素漂移在第二帧补齐。
    /** @param {number} pass */
    const adjust = (pass) => {
      const restored = document.querySelector(`.step-expand[data-step-expand="${CSS.escape(key)}"]`);
      if (restored === null) return;
      const sc = scroller();
      if (sc !== null) sc.scrollTop += restored.getBoundingClientRect().top - expected;
      if (pass < 1) requestAnimationFrame(() => adjust(pass + 1));
    };
    requestAnimationFrame(() => adjust(0));
  }

  async function loadEarlier() {
    const button = document.getElementById('load-earlier');
    if (button !== null) (/** @type {HTMLButtonElement} */ (button)).disabled = true;
    const before = anchorSnapshot();
    await store.loadEarlier();
    renderMain();
    renderSessions();
    compensateAnchor(before);
    // 新载入请求的批次会让上方行高增长：批次结束后再补一次锚点。
    void loadWindowReads().then(() => compensateAnchor(before));
  }

  /** 显式刷新：重建最近窗口、清掉旧展开与旧阅读版本，记录读取时间。 */
  async function refreshWindow() {
    if (state.session === null) return;
    state.stepOpen = new Set();
    state.requestOpen = new Set();
    reads.clear();
    toolReadings.clear();
    state.refreshedAt = Date.now();
    state.revealed = false;
    state.missingReqId = null;
    state.offPageReqId = null;
    await store.selectSession(state.session, windowLimit());
    const rows = currentRows();
    state.reqId = rows[rows.length - 1]?.req_id ?? null;
    state.selectedStep = null;
    state.toolOrd = null;
    renderAll();
    void loadWindowReads();
    void ensureSelectedVisible();
  }

  async function jumpLatest() {
    await refreshWindow();
    locateRequest(currentRows()[currentRows().length - 1]?.req_id ?? -1);
  }

  /** 定位窗口内请求：选中并滚动进入可见区域。 @param {number} id */
  function locateRequest(id) {
    const rows = currentRows();
    if (!rows.some(row => row.req_id === id)) return;
    state.reqId = id;
    state.selectedStep = null;
    state.toolOrd = null;
    state.missingReqId = null;
    state.offPageReqId = null;
    renderMain();
    renderRail();
    renderCrumb();
    updateURL();
    requestAnimationFrame(() => {
      document.querySelector(`.trace-group[data-req="${CSS.escape(String(id))}"]`)
        ?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    void ensureRead(state.reqId);
  }

  /** 默认选最新后必须让选中组进入可见区域。 */
  function ensureSelectedVisible() {
    requestAnimationFrame(() => {
      const selected = document.querySelector('.trace-group[aria-current="true"]');
      selected?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  }

  /** 确保某请求的读取与右栏数据在手。 @param {number} id */
  async function ensureRead(id) {
    try {
      const read = await store.readRequest(id);
      reads.set(id, read);
    } catch { /* 失败保留记录行 */ }
    renderMain();
    renderRail();
  }

  /** @param {number} id */
  async function selectRequest(id) {
    const same = state.reqId === id && state.toolOrd === null;
    state.reqId = id;
    state.missingReqId = null;
    state.offPageReqId = null;
    if (!same) {
      state.selectedStep = null;
      state.toolOrd = null;
      await ensureRead(id);
      renderCrumb();
    }
    updateURL();
  }

  /** @param {string} key */
  async function toggleStep(key) {
    if (state.stepOpen.has(key)) state.stepOpen.delete(key);
    else state.stepOpen.add(key);
    // 工具步骤展开即按调用位置读取结果。
    const callMatch = /^(\d+):call:(\d+)$/.exec(key);
    if (callMatch !== null && state.stepOpen.has(key)) {
      await readToolResult(Number(callMatch[1]), Number(callMatch[2]));
      return;
    }
    renderMain();
    renderRail();
  }

  /** @param {number} id */
  async function loadStructure(id) {
    try {
      const read = await store.loadStructure(id);
      reads.set(id, read);
    } catch { /* 结构失败保留 error 状态 */ }
    renderMain();
    renderRail();
  }

  function updateURL() {
    const p = new URLSearchParams();
    if (state.session) p.set('session', state.session);
    // 保留 URL 里那个"不在当前窗口"的 id，刷新后还能看到同一条说明。
    const trace = state.reqId ?? state.missingReqId ?? state.offPageReqId;
    if (trace !== null) p.set('trace', String(trace));
    const tab = state.railTab ?? '';
    if (['body', 'tools', 'route'].includes(tab)) p.set('tab', tab);
    history.replaceState(null, '', '?' + p.toString());
  }

  /** 处理 URL trace：窗口内选中；canonical 跳转；窗口外读详情；不存在说明。 */
  async function resolveInitialTrace() {
    if (state.reqId === null) return;
    const rows = currentRows();
    if (rows.some(row => row.req_id === state.reqId)) return;
    let detail = null;
    try {
      const read = await store.readRequest(state.reqId);
      reads.set(state.reqId, read);
      detail = read.detail;
    } catch { /* 读取失败按未找到处理 */ }
    const target = resolveTraceTarget(rows, state.reqId, detail);
    if (target.kind === 'canonical' && target.reqId !== null) {
      state.reqId = target.reqId;
    } else if (target.kind === 'off-page') {
      state.offPageReqId = state.reqId;
      state.reqId = null;
    } else if (target.kind === 'missing') {
      state.missingReqId = state.reqId;
      state.reqId = null;
    }
  }

  /**
   * @param {string} key
   * @param {number | null} [wantedTrace] URL 指定的 trace；会话内重选时为空
   */
  async function selectSession(key, wantedTrace = null) {
    state.session = key;
    state.reqId = wantedTrace;
    state.missingReqId = null;
    state.offPageReqId = null;
    state.selectedStep = null;
    state.toolOrd = null;
    state.stepOpen = new Set();
    state.requestOpen = new Set();
    state.railTab = 'facts';
    state.pendingSession = key;
    state.userScrolled = false;
    state.revealed = false;
    reads.clear();
    toolReadings.clear();
    renderMain();
    await store.selectSession(key, windowLimit());
    state.pendingSession = null;
    await resolveInitialTrace();
    if (state.reqId === null && state.offPageReqId === null) {
      // 默认选最新一笔；窗口外 trace 保留其语义，不用最新顶替。
      const rows = currentRows();
      state.reqId = rows[rows.length - 1]?.req_id ?? null;
    }
    renderAll();
    void loadWindowReads();
    if (state.offPageReqId !== null) {
      // 窗口外 trace：详情已在右栏说明，主列表停在最前面。
      el('main').scrollTop = 0;
    } else {
      ensureSelectedVisible();
    }
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
    if (t.closest('summary')) return;
    if (t.closest('#load-earlier')) { void loadEarlier(); return; }
    if (t.closest('#refresh-window')) { void refreshWindow(); return; }
    if (t.closest('#jump-latest')) { void jumpLatest(); return; }
    const structureMore = /** @type {HTMLElement | null} */ (t.closest('[data-structure-more]'));
    if (structureMore !== null) { void loadStructure(Number(structureMore.dataset.structureMore)); return; }
    const bodyLoad = /** @type {HTMLElement | null} */ (t.closest('[data-body-load]'));
    if (bodyLoad !== null) { void ensureRead(Number(bodyLoad.dataset.bodyLoad)); return; }
    const railReply = t.closest('[data-rail-reply]');
    if (railReply !== null) { state.selectedStep = null; renderRail(); return; }
    // 轨迹行里的结果入口：先读取，再定位承载请求。
    const resultEntry = /** @type {HTMLElement | null} */ (t.closest('[data-result-owner]'));
    if (resultEntry !== null) {
      const owner = Number(resultEntry.dataset.resultOwner);
      const ord = Number(resultEntry.dataset.callOrd);
      void (async () => {
        await readToolResult(owner, ord);
        const target = toolReadings.get(`${owner}:${ord}`)?.target?.req_id ?? null;
        if (target !== null && currentRows().some(row => row.req_id === target)) locateRequest(target);
      })();
      return;
    }
    const locate = /** @type {HTMLElement | null} */ (t.closest('[data-locate]'));
    if (locate !== null) { locateRequest(Number(locate.dataset.locate)); return; }
    const copyMsg = /** @type {HTMLElement | null} */ (t.closest('[data-copy-msg]'));
    if (copyMsg !== null) {
      const ord = Number(copyMsg.dataset.copyMsg);
      const read = state.reqId === null ? null : reads.get(state.reqId) ?? null;
      const entry = read === null ? null : read.entries.find((/** @type {{ord: number}} */ item) => item.ord === ord) ?? null;
      if (entry !== null && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(messageCopyText(entry)).then(() => {
          /** @type {HTMLElement} */ (copyMsg).textContent = '已复制';
        }).catch(() => {});
      }
      return;
    }
    const stepExpand = /** @type {HTMLElement | null} */ (t.closest('[data-step-expand]'));
    if (stepExpand !== null) { void toggleStep(/** @type {HTMLElement} */ (stepExpand).dataset.stepExpand ?? ''); return; }
    const sess = /** @type {HTMLElement | null} */ (t.closest('[data-session]'));
    if (sess) { void selectSession(sess.dataset.session ?? ''); return; }
    const agent = /** @type {HTMLElement | null} */ (t.closest('[data-agent]'));
    if (agent) { state.agent = agent.dataset.agent ?? 'all'; renderFilters(); renderSessions(); return; }
    const select = /** @type {HTMLElement | null} */ (t.closest('[data-step-key]'));
    if (select !== null) {
      const group = /** @type {HTMLElement | null} */ (select.closest('.trace-group'));
      const id = group !== null ? Number(group.dataset.req) : state.reqId;
      if (id !== null && Number.isFinite(id)) {
        state.selectedStep = select.dataset.stepKey ?? null;
        void selectRequest(id);
      }
      return;
    }
    const rail = /** @type {HTMLElement | null} */ (t.closest('[data-rail]'));
    if (rail) {
      state.railTab = rail.dataset.rail === 'facts' ? 'facts' : rail.dataset.rail === 'route' ? 'route' : 'body';
      // 切到路由页签是明确的阅读动作；正文页签用的结构在 body 渲染时按需取。
      renderRail();
      updateURL();
      return;
    }
    if (t.closest('#load-more-sessions')) {
      void store.loadSessions(store.getSessions().cursor ?? undefined).then(() => { renderSessions(); renderFilters(); });
    }
  });

  document.addEventListener('change', (e) => {
    const target = /** @type {HTMLSelectElement} */ (e.target);
    if (target.dataset.railMsg === undefined) return;
    const reqId = Number(target.dataset.railMsg);
    state.reqId = reqId;
    state.selectedStep = `${reqId}:message:${target.value}`;
    state.toolOrd = null;
    renderRail();
    updateURL();
  });

  document.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    if (target.id === 'sess-search') {
      state.query = target.value;
      renderSessions();
    }
  });

  // 用户主动滚动后，prepend 不再强行补偿旧锚点。
  el('main').addEventListener('wheel', () => { state.userScrolled = true; }, { passive: true });
  el('main').addEventListener('touchmove', () => { state.userScrolled = true; }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('input, textarea, summary')) return;
    if (e.key === 'Escape') { state.railTab = 'facts'; state.toolOrd = null; renderRail(); updateURL(); }
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
    state.railTab = ['body', 'tools', 'route'].includes(p.get('tab') ?? '') ? p.get('tab') : 'facts';
    state.toolOrd = null;
    if (state.session !== null) {
      const trace = p.get('trace');
      void selectSession(state.session, trace === null ? null : Number(trace));
    }
  });

  applyTheme();
  void (async () => {
    try {
      await store.loadSessions();
    } catch (error) {
      el('sessions-list').innerHTML = `<p class="sess-empty">会话列表加载失败:${esc(error instanceof Error ? error.message : 'unknown')}</p>`;
      return;
    }
    if (state.session === null) {
      const first = /** @type {SessionRow | undefined} */ (store.getSessions().items[0]);
      state.session = first ? first.conv_key : null;
    }
    if (state.session !== null) await selectSession(state.session, qp.get('trace') !== null ? Number(qp.get('trace')) : null);
    else renderAll();
  })();
}
