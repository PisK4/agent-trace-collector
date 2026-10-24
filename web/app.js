// @ts-check
/**
 * 读者前端：单一轨迹视图。窗口、正文区间、结构与工具结果都经 reader-store
 * 读取（带阅读版本）；步骤投影用 trace-view 的纯函数，行级文案在 row-summary、
 * 右栏组合在 rail-facts、URL 目标在 url-route，这里只做装配与交互。
 * @typedef {import('../src/queries').RequestDetail} RequestDetail
 * @typedef {import('../src/queries').RequestRow} RequestRow
 * @typedef {import('../src/queries').SessionRow} SessionRow
 */

import {
  bodyNotice, deltaOrdinals, esc, messageCopyText, partColor, partLabel, roleTag,
  renderAttemptChain, renderCapabilities, renderMessageDetail, renderReply,
  renderReplyBlockDetail, renderReplyDetail, renderSystemDetail, renderUnknownBlockDetail,
  replyView, toolEntries, toolTint,
} from './body-view.js';
import { createReaderStore } from './reader-store.js';
import {
  kk, ledgerRowsHtml, railFactsHtml, readingChangedNote, resolveSelectedSource, secs,
  structureFoldHtml, systemContextOf, toolOverviewHtml, toolSchemaSection, usageFoldHtml,
} from './rail-facts.js';
import { bodyLabelText, bodyStateText, replyCompleteness } from './row-summary.js';
import { renderTracePair } from './trace-pair.js';
import { projectSteps, renderTraceRows } from './trace-view.js';
import { railTabFromParam, railTabParam, resolveTraceTarget, routeReadTarget } from './url-route.js';

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

  // store 是唯一的读取缓存：页面同步渲染经 peek* 消费，副本不作第二份真相。
  const store = createReaderStore((/** @type {string} */ url) => fetch(url),
    // store 真正作废当前记录时只标待重读；迟到响应与旧回调不进来。
    id => { state.readingChanged.add(id); });
  /** @type {Map<string, boolean>} 折叠开合按稳定键保存（键含 req id），重绘后恢复。 */
  const folds = new Map();
  /** @type {Map<number, number>} 结构折叠内选中的消息 ord 按 req id 保存：UI 选择留在页面，不进 store。 */
  const structureSelected = new Map();

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
    /** 配对页描述的调用属于哪笔请求：从结果步骤进入时可能与当前请求不同；null 表示当前请求。 */
    toolOwner: /** @type {number | null} */ (null),
    /** 工具详情四页的当前页：overview / params / pair / schema。 */
    toolPage: 'pair',
    requestOpen: new Set(/** @type {number[]} */ ([])),
    railTab: railTabFromParam(qp.get('tab')),
    query: '',
    agent: 'all',
    pendingSession: /** @type {string | null} */ (null),
    /** 最近一次显式刷新时间；刷新会重建最近窗口并清掉旧阅读版本。 */
    refreshedAt: /** @type {number | null} */ (null),
    /** 阅读版本已作废、等待显式重读的请求；重读成功后移除。 */
    readingChanged: new Set(/** @type {number[]} */ ([])),
    /** 用户主动滚动后不再强制补偿过期锚点。 */
    userScrolled: false,
    /** 首载批次是否已把选中组带入可见区；加载更早不再重复居中。 */
    revealed: false,
  };
  /** 载入窗口详情的轮次：换会话或刷新时自增，作废在跑的批次。 */
  let loadEpoch = 0;
  /** 导航代次：换会话或显式刷新时自增，旧导航的 await 后续不再覆盖当前选择。 */
  let navEpoch = 0;
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
    return state.reqId === null ? null : store.peekRequest(state.reqId);
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
  // have 位义与 src/evidence.ts 一致：1 正文回调、2 账本用量、4 路由历史。
  const HAVE_BODY = 1, HAVE_LEDGER = 2, HAVE_ROUTE = 4;
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
    const wanted = currentRows().filter(row => store.peekRequest(row.req_id) === null);
    for (let index = 0; index < wanted.length; index += 4) {
      if (epoch !== loadEpoch) return;
      const chunk = wanted.slice(index, index + 4);
      await Promise.all(chunk.map(async row => {
        try {
          const read = await store.readRequest(row.req_id);
          if (!read.delta.done) await store.loadDelta(row.req_id, 2);
        } catch {
          /* reading_changed 的副本清理由 store 作废通知负责；其余单笔失败保留占位记录，刷新可重试 */
        }
      }));
      if (epoch !== loadEpoch) return;
      renderMain();
      // 读数页的数量与计数也依赖这些读取：每批同步刷新右栏。
      renderRail();
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
      // 左栏只保留具体事实标记；未知派生不再给笼统「待确认」，状态留在选中请求。
      const flag = s.flags.includes('failed') ? { color: 'var(--bad)', text: '含失败' }
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
  function viaText(r) {
    if (!(r.have & HAVE_LEDGER)) return '仅回调，未关联账本';
    if (!(r.have & HAVE_BODY)) return '仅账本，没有回调';
    return '账本 + 回调';
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
    const detail = reqId === null ? null : store.peekRequest(reqId)?.detail ?? null;
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
        <span class="hint">单行步骤 · 点击行查看详情 · 数字表示当前窗口内的请求</span>
        <span class="grow"></span>
        ${state.refreshedAt !== null ? `<span class="hint">刷新于 ${esc(clock(state.refreshedAt))}</span>` : ''}
        <button class="chip-btn" id="refresh-window" title="重新读取最近窗口；输入变化会换发阅读版本">刷新</button>
        <button class="chip-btn" id="jump-latest">回到最新 ↓</button>
      </div>
      ${unknown ? `<div class="session-note warn"><span>↳</span><span>链接里的会话 key 不在已加载的会话里：可能是已淘汰、从未记录，或者还在后面的会话页。下面没有用别的会话顶替。</span></div>` : ''}
      ${state.missingReqId !== null ? `<div class="session-note warn"><span>↳</span><span>链接里的 Request ${state.missingReqId} 在当前库里不存在，也没有别名指向它。下面显示的是本会话的请求，不是那一笔。</span></div>` : ''}
      ${state.offPageReqId !== null ? `<div class="session-note"><span>↳</span><span>链接里的 Request ${state.offPageReqId} 存在，但不在当前载入窗口（可能在更早的历史里）；从顶部加载更早记录后可以选到它，右栏已显示它的详情。不自动扫描全部历史。</span></div>` : ''}
      ${window.error !== null ? `<div class="session-note warn"><span>↳</span><span>请求窗口读取失败：${esc(window.error)}。已加载内容保持不变，可重试。</span></div>` : ''}
    </header>`;
  }

  /**
   * 按调用位置读取结果。force 用于重试：store 的失败任务已释放，重发走网络。
   * 409 的作废与副本清理由 store 通知负责；迟到 409 保留现有快照，这里只刷新展示。
   * @param {number} ownerId @param {number} callOrd @param {boolean} [force]
   */
  async function readToolResult(ownerId, callOrd, force = false) {
    const cached = store.peekToolResult(ownerId, callOrd);
    if (!force && cached !== null) return cached;
    try {
      await store.readToolResult(ownerId, callOrd);
    } catch (error) {
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
        renderMain();
        renderRail();
        return null;
      }
    }
    renderMain();
    renderRail();
    return store.peekToolResult(ownerId, callOrd);
  }

  /** 展开路由折叠区或切到路由页签时才读取；失败保持未读，重新展开可重试。 @param {number} id */
  async function ensureRoute(id) {
    if (store.peekRoute(id) !== null) return;
    try {
      await store.readRoute(id);
    } catch { return; }
    renderMain();
    renderRail();
  }

  /** @param {RequestRow} r @param {{state: string, summary: unknown} | null} route */
  function routeBlock(r, route) {
    if (route === null) {
      // 路由页签在导航完成处自动读取：这里只剩读取中或上次失败两种状态，
      // 不冒充「无路由」；再次进入页签可重试。
      return `<p class="note">${esc(viaText(r))}。路由信息尚未读到：正在读取或上次读取失败；再次进入路由页签可重试。</p>`;
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
    const canonical = canonicalModel(r);
    // 头部已显示模型；去向行只在与头部不同（错路由、换模型）时才重复 served。
    const served = typeof s.served === 'string' ? s.served : null;
    const servedShown = served !== null && (canonical === null || served !== canonical);
    // 单次干净尝试不显示尝试链；重试、失败、未结束才是异常。
    const attemptsAbnormal = attempts !== null && attempts.state === 'present'
      && (attempts.items.length > 1 || attempts.items.some(item =>
        item.fail !== null || item.done === false || (item.status !== null && item.status >= 400)));
    return `<dl class="chain">
      ${order.length > 1 ? `<div class="chain-row"><dt>候选顺序</dt><dd class="mono" style="font-size:10px">${order.map(o => esc(raw(o))).join(' → ')}</dd></div>` : ''}
      <div class="chain-row"><dt>去向</dt><dd><code>${esc(s.provider ?? 'unknown')}</code>${servedShown ? ` · <code title="实际服务模型与头部显示的不一致">${esc(served)}</code>` : ''}</dd></div>
      <div class="chain-row"><dt>状态</dt><dd>HTTP ${esc(s.status ?? '—')} · ${secs(/** @type {number|null} */ (s.ms))}</dd></div>
      ${attemptsAbnormal ? `<div class="chain-row"><dt>尝试链</dt><dd>${renderAttemptChain(attempts)}</dd></div>` : ''}
    </dl>
    <p class="note" style="margin-top:8px">只显示已记录的决策与尝试。窗口过滤不保证完整留痕；用量条目数量也不等于尝试次数。</p>`;
  }

  /** @param {RequestRow} r @param {RequestDetail | null} detail */
  function completenessRows(r, detail) {
    const row = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string} */ color) =>
      `<div class="chain-row"><dt>${k}</dt><dd><span style="color:${color}">${v}</span></dd></div>`;
    return `<div class="chain">
      ${row('正文回调', (r.have & HAVE_BODY) ? '已收到' : '未收到', (r.have & HAVE_BODY) ? 'var(--good)' : 'var(--bad)')}
      ${row('用量账本', (r.have & HAVE_LEDGER) ? '已关联' : '待关联', (r.have & HAVE_LEDGER) ? 'var(--good)' : 'var(--warn)')}
      ${row('路由历史', (r.have & HAVE_ROUTE) ? '已关联' : '当前来源不提供', (r.have & HAVE_ROUTE) ? 'var(--good)' : 'var(--muted)')}
    </div>
    <p class="note" style="margin-top:8px">三条通道各自可能缺失。${detail && detail.prev_relation === 'unknown' ? '本笔与上一笔的增量关系无法确认，未计算新增消息。' : ''}
      ${r.miss_reason ? `缺失原因：${esc(r.miss_reason)}。` : ''}</p>`;
  }

  /** 单一轨迹：每请求一个组，点击步骤在右栏阅读；顶部提供历史入口。 */
  function traceHtml() {
    const window = store.getWindow();
    const rows = currentRows();
    // 序号槽宽的位数取窗口最大序号：初始加载受 windowLimit 限制，加载更早
    // 记录后 rows.length 累计，重绘时重算，不按首次加载上限截断。
    const ordDigits = Math.max(1, String(rows.length).length);
    // 结果行的调用方前缀：调用方正文在窗口缓存内时给同款摘要，缓存外降级只工具名。
    const callOf = (/** @type {number} */ ownerReq, /** @type {number} */ callOrd) => {
      const ownerRead = store.peekRequest(ownerReq);
      if (ownerRead === null || ownerRead.meta === null) return null;
      const call = replyView(ownerRead.meta).calls.find(item => item.ord === callOrd) ?? null;
      return call === null ? null : { name: call.name, inputText: call.inputText };
    };
    let html = `<div class="step-list" style="--ord-digits:${ordDigits}"><div class="history-loader">`;
    if (window.loading) {
      html += '<span class="history-start">正在读取更早记录…</span>';
    } else if (window.olderCursor !== null) {
      html += '<button id="load-earlier" class="history-button">↑ 加载更早记录</button>';
    }
    html += '<span class="history-range">序号表示当前窗口内的请求 · 时间从上往下 · 点击行查看详情</span></div>';
    for (const r of rows) {
      const read = store.peekRequest(r.req_id);
      const steps = projectSteps(r, read, systemContextOf(r, id => store.peekRequest(id)));
      const ordinal = ordinalOf(r.req_id);
      html += `<section class="trace-group" data-req="${r.req_id}" data-status="${r.status === null ? 'unknown' : r.status >= 400 ? 'failed' : 'success'}" aria-current="${r.req_id === state.reqId}">`;
      html += renderTraceRows(r, steps, ordinal, state.selectedStep, callOf);
      html += '</section>';
    }
    if (rows.length === 0) {
      html += `<p class="sess-empty">${state.pendingSession !== null ? '正在读取请求…' : '这个会话没有已记录的请求。'}</p>`;
    }
    return html + `<div class="timeline-end"><span></span> 已是最新记录</div></div>`;
  }

  /**
   * 重绘后恢复折叠开合：所有 data-fold 折叠以 folds 表为准。
   * body-view 的能力折叠不带 open 属性，这里统一恢复，避免重绘把用户展开的清单收回去。
   * @param {ParentNode} root
   */
  function restoreFolds(root) {
    for (const d of root.querySelectorAll('details[data-fold]')) {
      const details = /** @type {HTMLDetailsElement} */ (d);
      const key = details.dataset.fold;
      if (key === undefined) continue;
      const open = folds.get(key);
      if (open !== undefined) details.open = open;
    }
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
    restoreFolds(main);
    restoreScroll(main, keep);
  }

  /* ---------------- 右栏 ---------------- */
  /** 模型只在头部身份行显示一次：优先实际服务模型，未关联账本时回退请求模型。 @param {RequestRow} r */
  function canonicalModel(r) {
    return r.model_served ?? r.model_requested;
  }

  /** 标题只渲染内容标题；model_time 兜底标题不再显示（模型与时间已在读数条里）。 @param {RequestRow} r */
  function contentTitle(r) {
    if (r.title_source === 'model_time') return '';
    return `<div class="rail-title">${esc(r.title || '（无标题）')}</div>`;
  }

  function railHead() {
    const r = currentRow();
    if (r === null) {
      if (state.offPageReqId !== null) {
        return `<div class="rail-id"><span>req ${state.offPageReqId} · 未在当前窗口</span></div>`;
      }
      return '<div class="rail-id">未选择请求</div>';
    }
    const model = canonicalModel(r);
    return `<div class="rail-id"><span>req ${r.req_id}</span><span class="muted">·</span><span>${esc(dayTime(r.started_ms))}</span>
      ${r.agent === null ? '' : `<span class="muted">·</span><span>${esc(agentLabel(r.agent))}</span>`}
      ${model !== null ? `<span class="muted">·</span><span class="strip-model" title="实际服务模型（model_served；未关联账本时为请求模型）">${esc(model)}</span>` : ''}
      <span class="grow"></span>${statusDot(r)}${statusChip(r)}</div>
      ${contentTitle(r)}
      <div class="rail-tabs" role="tablist">
        <button role="tab" data-rail="facts" aria-pressed="${state.railTab === 'facts'}">读数</button>
        <button role="tab" data-rail="body" aria-pressed="${state.railTab === 'body'}">正文</button>
        <button role="tab" data-rail="tools" aria-pressed="${state.railTab === 'tools'}">工具</button>
        <button role="tab" data-rail="route" aria-pressed="${state.railTab === 'route'}">路由</button>
      </div>`;
  }

  /**
   * 身份完整性只在有异常通道时渲染；三条全正常整节不出现（头部圆点已覆盖整体状态）。
   * 路由历史未关联是当前来源的常态，不算异常，不在此提示。
   * @param {RequestRow} r
   */
  function completenessSection(r) {
    const rows = [
      !(r.have & HAVE_BODY) ? ['正文回调', '未收到', 'var(--bad)'] : '',
      !(r.have & HAVE_LEDGER) ? ['用量账本', '待关联', 'var(--warn)'] : '',
    ].filter(Boolean);
    if (rows.length === 0) return '';
    return `<section class="rail-section">
      <h3 title="路由历史未关联是当前来源的常态，不在此提示；需要路由详情看「路由」页签。">身份完整性</h3>
      <div class="chain">${rows.map(([k, v, color]) =>
        `<div class="chain-row"><dt>${k}</dt><dd><span style="color:${color}">${v}</span></dd></div>`).join('')}</div>
      ${r.miss_reason ? `<p class="rail-note">缺失原因：${esc(r.miss_reason)}。</p>` : ''}
    </section>`;
  }

  /**
   * 读数页：本次回复（默认展开）→ 请求结构 → 能力清单 → 用量与上下文（默认展开，末位）→ 身份完整性（异常时）。
   * 能力与结构默认折叠；正常态不带状态标签（异常才出现）。
   */
  function railFacts() {
    const r = currentRow();
    if (r === null) return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    const read = currentRead();
    const meta = read?.meta ?? null;
    const detail = read?.detail ?? null;
    const view = meta !== null ? replyView(meta) : null;
    const completeness = replyCompleteness(r, view);
    const tools = detail === null ? [] : toolEntries(detail, meta).map(tool => ({
      ...tool,
      result_label: tool.result_req !== null ? windowLabel(tool.result_req) : null,
    }));
    /** @type {string} */
    let replyHtml;
    if (view === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      replyHtml = `<details class="rail-fold" data-fold="reply:${r.req_id}">
        <summary>本次回复<span class="fold-count">${esc(canLoad ? '正文未读取' : bodyStateText(r))}</span></summary>
        <div class="fold-body"><p class="note">${esc(bodyLabelText(r))}</p>
          ${state.readingChanged.has(r.req_id) ? readingChangedNote(r.req_id) : ''}
          ${canLoad ? `<div class="conv-tools"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}</div>
      </details>`;
    } else {
      const cls = completeness.key === 'absent' ? 'bad' : 'warn';
      const right = completeness.key !== 'complete'
        ? `<span class="fold-count ${cls}">${esc(completeness.label)}</span>`
        : view.finish !== null ? `<span class="fold-count">finish: ${esc(view.finish)}</span>` : '';
      const truncNote = completeness.key === 'truncated'
        ? `<p class="rail-note">回复在长度上限被截断（finish=${esc(view.finish ?? '')}）。这是成功响应内的完整性状态，请求本身仍算成功。</p>`
        : '';
      replyHtml = `<details class="rail-fold" data-fold="reply:${r.req_id}" open>
        <summary>本次回复${right}</summary>
        <div class="fold-body">${renderReply(view, tools, String(r.req_id))}${truncNote}</div>
      </details>`;
    }
    const structureHtml = structureFoldHtml({
      reqId: r.req_id, row: r, meta,
      entries: read?.entries ?? [],
      structure: read?.structure ?? { next: 0, total: null, ords: [], loading: false, error: null },
      open: folds.get(`structure:${r.req_id}`) === true,
      selected: structureSelected.get(r.req_id) ?? null,
      delta: detail === null ? null : deltaOrdinals(detail),
      deltaState: read?.delta ?? null,
      parseState: meta?.parse_state ?? null,
      relation: relationTextOf(r.req_id),
    });
    return railFactsHtml({
      replyHtml, structureHtml,
      capabilitiesHtml: meta !== null ? renderCapabilities(meta) : '',
      usageHtml: usageFoldHtml(r, detail),
      completenessHtml: completenessSection(r),
    });
  }

  /** @param {string} path @returns {number | null} */
  function messageOrdOf(path) {
    const match = /^messages\[(\d+)\]$/.exec(path);
    return match === null ? null : Number(match[1]);
  }

  /** 窗口内用请求序号称呼，窗口外保留稳定 req_id 并标注。 @param {number} id */
  function windowLabel(id) {
    const rows = currentRows();
    const index = rows.findIndex(row => row.req_id === id);
    return index >= 0 ? String(index + 1).padStart(2, '0') : `req ${id}（未在窗口）`;
  }

  /**
   * 工具页：未选中调用时列出全部调用（配对与正文加载分立）；
   * 选中后描述的是 owner 请求的那次调用（可能与当前请求不同），四页共用 owner 的读取，
   * 第三页「配对」同屏阅读两端，其余三页沿用既有四页口径。
   */
  function railTools() {
    const r = currentRow();
    if (r === null) return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    const read = currentRead();
    if (read === null || read.meta === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyLabelText(r))}
        ${state.readingChanged.has(r.req_id) ? readingChangedNote(r.req_id) : ''}
        ${canLoad ? `<div style="margin-top:10px"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}</div>`;
    }
    const detail = read.detail;
    if (state.toolOrd === null) {
      const tools = toolEntries(detail, read.meta);
      if (tools.length === 0) {
        return '<div class="rail-empty"><b>没有工具调用</b>这一笔已读回复里没有工具调用；更早分片读取后可再查。</div>';
      }
      const rows = tools.map(tool => {
        // 正常态（已配对、正文未读已读）不挂 chip；异常（多候选）才提示，详情页给完整状态。
        const warn = tool.state === 'ambiguous'
          ? '<span class="tool-chip miss"><span>多个候选</span></span>' : '';
        return `<button class="tool-row tool-link" data-tool-select="${tool.ord}">
          <span class="tool-chip call ${toolTint(tool.name)}" title="${esc(tool.name)}"><span>${esc(tool.name)}(${esc(clipText(tool.inputText, 60))})</span></span>
          ${warn}
        </button>`;
      });
      return `<section class="rail-section"><h3>工具调用<span class="grow"></span><span class="hint">${tools.length} 次调用 · 点开在右栏同屏配对阅读</span></h3>${rows.join('')}</section>`;
    }
    const owner = state.toolOwner ?? r.req_id;
    const ownerRead = owner === r.req_id ? read : store.peekRequest(owner);
    if (ownerRead === null || ownerRead.meta === null) {
      // 调用方读取未就绪：配对需要它的回复与配对状态；409 作废时给显式重读入口。
      return `<div class="rail-empty"><b>正在读取调用方请求…</b>配对需要调用方的回复与配对状态，读取完成后自动展示两端。</div>
        ${state.readingChanged.has(owner) ? readingChangedNote(owner) : ''}`;
    }
    const ownerDetail = ownerRead.detail;
    const ownerPage = ownerRead.meta;
    const tools = toolEntries(ownerDetail, ownerPage);
    const tool = tools.find(item => item.ord === state.toolOrd) ?? null;
    if (tool === null) {
      state.toolOrd = null;
      state.toolOwner = null;
      return railTools();
    }
    const pair = ownerDetail === null ? null : ownerDetail.tool_calls.find(item => item.ord === tool.ord) ?? null;
    const reading = store.peekToolResult(owner, tool.ord);
    const pages = [['overview', '概览'], ['params', '参数'], ['pair', '配对'], ['schema', 'Schema']];
    const pageBody = state.toolPage === 'params'
      ? `<pre class="raw" tabindex="0">${esc(tool.inputText)}</pre>
        <div class="conv-tools"><button class="chip-btn" data-copy-tool="${tool.ord}">复制参数原文</button></div>`
      : state.toolPage === 'pair'
        ? renderTracePair({
          owner, ownerLabel: windowLabel(owner), call: tool, pair, reading,
          carrierLabel: pair !== null && pair.state === 'resolved' && pair.result_req !== null
            ? windowLabel(pair.result_req) : null,
        })
        : state.toolPage === 'schema'
          ? toolSchemaSection(ownerPage.capabilities, tool.name)
          : toolOverviewHtml(owner, pair, reading);
    return `<section class="rail-section">
      <div class="tool-page-head">
        <button class="chip-btn" data-tool-back="1">← 返回请求</button>
        <span class="mono">${esc(tool.name)} · 调用 #${tool.ord}</span>
      </div>
      <div class="tool-page-tabs">${pages.map(([key, label]) => `<button data-tool-page="${key}" aria-pressed="${state.toolPage === key}">${label}</button>`).join('')}</div>
      ${pageBody}
    </section>`;
  }

  /** 当前请求的选中步骤对象；无选择或选中的是别的请求时返回 null。 @param {RequestRow} r */
  function currentSelectedStep(r) {
    if (state.selectedStep === null || !state.selectedStep.startsWith(`${r.req_id}:`)) return null;
    const read = store.peekRequest(r.req_id);
    return projectSteps(r, read, systemContextOf(r, id => store.peekRequest(id)))
      .find(item => item.key === state.selectedStep) ?? null;
  }

  function railBody() {
    const r = currentRow();
    if (r === null) {
      if (state.offPageReqId !== null) {
        const read = store.peekRequest(state.offPageReqId);
        return `<section class="rail-section"><h3>窗口外请求</h3><p class="rail-note">Request ${state.offPageReqId} · ${esc(read?.detail?.title ?? '详情见读取结果')} 不在当前载入窗口（可能在更早的历史里）。这里只读了它的详情；需要完整轨迹请从顶部加载更早记录，不自动扫描全部历史。</p></section>${read?.detail ? ledgerRowsHtml(read.detail, read.detail) : ''}`;
      }
      return '<div class="rail-empty"><b>未选择请求</b>在中间选择一个 Request。</div>';
    }
    if (state.railTab === 'tools') return railTools();
    if (state.railTab === 'facts') return railFacts();
    if (state.railTab === 'route') {
      const route = store.peekRoute(r.req_id);
      return `<section class="rail-section"><h3>路由与尝试</h3>${routeBlock(r, route)}</section>`;
    }
    const read = store.peekRequest(r.req_id);
    if (read === null || read.meta === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyLabelText(r))}
        ${state.readingChanged.has(r.req_id) ? readingChangedNote(r.req_id) : ''}
        ${canLoad ? `<div style="margin-top:10px"><button class="chip-btn" data-body-load="${r.req_id}">读取正文</button></div>` : ''}</div>`;
    }
    const page = read.meta;
    if (page.state !== 'available' && page.state !== 'partial') {
      return `<div class="rail-empty"><b>${esc(bodyStateText(r))}</b>${esc(bodyNotice(page) || '这一笔没有可读的正文。')}</div>`;
    }
    const view = replyView(page);
    const detail = read.detail ?? null;
    const tools = detail === null ? [] : toolEntries(detail, page).map(tool => ({
      ...tool,
      result_label: tool.result_req !== null ? windowLabel(tool.result_req) : null,
    }));
    const completeness = replyCompleteness(r, view);
    const truncNote = completeness.key === 'truncated'
      ? `<p class="rail-note">回复在长度上限被截断（finish=${esc(view.finish ?? '')}）；请求本身仍是成功状态。</p>` : '';
    // 选中来源是右栏的唯一导航依据：System、输入消息、回复块各自定位，不回退整份回复。
    const source = resolveSelectedSource(currentSelectedStep(r));
    /** @type {string} */
    let body;
    if (source.side === 'request' && source.target === 'system') {
      body = renderSystemDetail(source.text);
    } else if (source.side === 'request') {
      const chosen = read.entries.find((/** @type {{ord: number}} */ entry) => entry.ord === source.messageOrd) ?? null;
      body = chosen !== null ? renderMessageDetail(chosen)
        : `<div class="rail-empty"><b>消息未读取</b>messages[${source.messageOrd}] 不在已加载的分片里；读取完成后回到这一步。</div>`;
    } else if (source.side === 'reply' && source.target === 'text') {
      body = `${truncNote}${renderReplyBlockDetail(source.path, source.text)}`;
    } else if (source.side === 'reply' && source.target === 'block') {
      body = renderUnknownBlockDetail(source.path, source.raw);
    } else if (view.state === 'ok') {
      body = `${truncNote}${renderReplyDetail(view, tools, String(r.req_id))}`;
    } else {
      body = `<div class="rail-empty"><b>没有可读的回复</b>${esc(bodyNotice(page) || '这一笔只有请求。')}</div>`;
    }
    const structure = read.structure;
    // 结构总数未读时用元信息页的 total 判断：正文页签也能发起首次结构读取。
    const knownTotal = structure.total ?? (page.total ?? null);
    const unread = knownTotal !== null && knownTotal !== undefined && structure.next < knownTotal;
    return `${bodyNotice(page) ? `<p class="rail-note" style="margin-bottom:8px">${esc(bodyNotice(page))}</p>` : ''}
      ${body}
      <div class="conv-tools" style="padding:10px 0 0">
        <span class="label">请求消息</span>
        <button class="chip-btn" data-rail-reply="1" aria-pressed="${source.side === 'none'}">本次回复</button>
        ${read.entries.length > 0
        ? `<select class="mini-search" data-rail-msg="${r.req_id}" aria-label="选择消息">
              ${read.entries.slice(0, 300).map((/** @type {{ord: number, role: 'user'|'assistant'|'system'|'tool'|'unknown', preview: string}} */ entry) => `<option value="${entry.ord}" ${source.side === 'request' && source.target === 'message' && source.messageOrd === entry.ord ? 'selected' : ''}>#${entry.ord} ${roleTag(entry.role)} · ${esc(clipText(entry.preview, 40))}</option>`).join('')}
            </select>`
        : '<span class="muted" style="font-size:10.5px">这一笔没有消息正文</span>'}
      </div>
      ${unread ? `<div style="margin-top:8px"><button class="chip-btn" data-structure-more="${r.req_id}">加载下一片（已读 ${structure.next} / ${knownTotal}）</button></div>` : ''}`;
  }

  /** @type {string | null} */
  let lastRailKey = null;
  function renderRail() {
    el('rail-head').innerHTML = railHead();
    const rail = el('rail-body');
    // 滚动只在「同请求同页签的重绘」里保持；页签切换与换请求都回到顶部，行为可预期。
    const key = `${state.reqId}:${state.railTab}`;
    const keep = key === lastRailKey ? rail.scrollTop : 0;
    rail.innerHTML = railBody();
    restoreFolds(rail);
    restoreScroll(rail, keep);
    lastRailKey = key;
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
    const select = /** @type {HTMLElement | null} */ (step.querySelector('[data-step-key]'));
    return { key: select?.dataset.stepKey ?? null, top: step.getBoundingClientRect().top };
  }
  /** @param {ReturnType<typeof anchorSnapshot>} before */
  function compensateAnchor(before) {
    if (before === null || before.key === null || state.userScrolled) return;
    const key = before.key;
    const expected = before.top;
    // 两帧各校一次：首帧布局未稳的亚像素漂移在第二帧补齐。
    /** @param {number} pass */
    const adjust = (pass) => {
      const restored = document.querySelector(`[data-step-key="${CSS.escape(key)}"]`)?.closest('.compact-step');
      if (restored == null) return;
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

  /** 显式刷新：重建最近窗口、清掉旧展开与待重读标记，记录读取时间。 */
  async function refreshWindow() {
    if (state.session === null) return;
    const myNav = ++navEpoch;
    state.requestOpen = new Set();
    state.readingChanged.clear();
    state.refreshedAt = Date.now();
    state.revealed = false;
    state.missingReqId = null;
    state.offPageReqId = null;
    await store.selectSession(state.session, windowLimit());
    if (myNav !== navEpoch) return;
    const rows = currentRows();
    state.reqId = rows[rows.length - 1]?.req_id ?? null;
    state.selectedStep = null;
    state.toolOrd = null;
    state.toolOwner = null;
    renderAll();
    // 保留路由页的刷新路径：重建窗口后仍自动读取当前请求的路由。
    const routeTarget = routeReadTarget(state.railTab, state.reqId);
    if (routeTarget !== null) void ensureRoute(routeTarget);
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
    state.toolOwner = null;
    state.missingReqId = null;
    state.offPageReqId = null;
    renderMain();
    renderRail();
    renderCrumb();
    updateURL();
    // 定位（回到最新等）也是导航完成处：保留路由页时随选中请求读取。
    const routeTarget = routeReadTarget(state.railTab, state.reqId);
    if (routeTarget !== null) void ensureRoute(routeTarget);
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

  /** 选中的输入消息未在缓存里时定点补读一条，保留当前选择。 @param {number} id @param {number} ord */
  async function ensureMessageOrd(id, ord) {
    const read = store.peekRequest(id);
    if (read === null || read.entries.some((/** @type {{ord: number}} */ e) => e.ord === ord)) return;
    try {
      await store.readRange(id, ord, ord + 1);
    } catch { /* 补读失败保留现有内容，可再次触发 */ }
  }

  /** 确保某请求的读取与右栏数据在手；重读成功后取得新 detail/meta 并按当前选中来源补读所需块。 @param {number} id */
  async function ensureRead(id) {
    try {
      await store.readRequest(id);
      state.readingChanged.delete(id);
    } catch {
      /* reading_changed 的副本清理由 store 作废通知负责 */
      renderMain();
      renderRail();
      return;
    }
    const selected = state.selectedStep;
    // 结果步骤键是 message:N:result:M，序号取 message: 后的第一段，不能用最后一段。
    const ordMatch = selected !== null ? new RegExp(`^${id}:message:(\\d+)`).exec(selected) : null;
    if (ordMatch !== null) {
      const ord = Number(ordMatch[1]);
      if (Number.isFinite(ord)) await ensureMessageOrd(id, ord);
    }
    renderMain();
    renderRail();
  }

  /**
   * 配对页两端就绪：调用方读取完成后，按配对状态自动发起一次结果读取；
   * 重复进入不重复读取（store 已登记该工具结果即跳过），失败保留显式重试。
   * @param {number} ownerId @param {number} callOrd
   */
  async function ensurePair(ownerId, callOrd) {
    await ensureRead(ownerId);
    const pair = store.peekRequest(ownerId)?.detail?.tool_calls.find(call => call.ord === callOrd) ?? null;
    if (pair !== null && pair.state === 'resolved' && pair.result_req !== null
      && store.peekToolResult(ownerId, callOrd) === null) {
      void readToolResult(ownerId, callOrd);
    }
  }

  /** @param {number} id @param {string|null} key */
  async function selectRequest(id, key) {
    const row = currentRows().find(row => row.req_id === id);
    if (row === undefined) return;
    // 增量事件行是续读入口：打开读数页并再消费两片，不当作步骤选择。
    if (key === `${id}:delta`) {
      state.reqId = id;
      state.selectedStep = null;
      state.toolOrd = null;
      state.toolOwner = null;
      state.toolPage = 'pair';
      state.railTab = 'facts';
      state.missingReqId = null;
      state.offPageReqId = null;
      document.body.classList.remove('rail-collapsed');
      syncPanelButtons();
      renderMain();
      renderRail();
      renderCrumb();
      updateURL();
      void resumeDelta(id);
      return;
    }
    const step = projectSteps(row, store.peekRequest(id), systemContextOf(row, x => store.peekRequest(x)))
      .find(item => item.key === key) ?? null;
    const source = resolveSelectedSource(step);
    // 调用步骤与已配对的结果步骤都进入配对页，右栏同屏阅读两端；
    // 未配对的结果步骤保留正文定位，记录步骤打开请求读数。
    const pairSource = source.side === 'pair' ? source
      : source.side === 'reply' && source.target === 'call' ? source : null;
    state.reqId = id;
    state.selectedStep = key;
    state.toolOrd = pairSource !== null ? pairSource.callOrd : null;
    state.toolOwner = pairSource !== null ? pairSource.ownerReq : null;
    state.toolPage = 'pair';
    state.railTab = pairSource !== null ? 'tools'
      : source.side === 'request' || source.side === 'reply' ? 'body' : 'facts';
    state.missingReqId = null;
    state.offPageReqId = null;
    document.body.classList.remove('rail-collapsed');
    syncPanelButtons();
    renderMain();
    renderRail();
    renderCrumb();
    updateURL();
    // 重绘会替换 DOM：把焦点放回当前步骤，键盘导航不中断。
    requestAnimationFrame(() => {
      const current = /** @type {HTMLElement | null} */ (document.querySelector('.compact-select[aria-current="true"]'));
      if (current !== null && document.activeElement === document.body) current.focus();
    });
    await ensureRead(id);
    if (pairSource !== null) await ensurePair(pairSource.ownerReq, pairSource.callOrd);
  }

  /** @param {number} id */
  async function loadStructure(id) {
    try {
      await store.loadStructure(id);
    } catch {
      /* reading_changed 的副本清理由 store 作废通知负责；其余结构失败保留 error 状态 */
    }
    renderMain();
    renderRail();
  }

  /** 显式续读可信增量：每轮两片，经原 4 并发队列；失败保留未消费位置可重试。 @param {number} id */
  async function resumeDelta(id) {
    try {
      await store.loadDelta(id, 2);
    } catch {
      /* reading_changed 的副本清理由 store 作废通知负责；其余失败保留未消费位置可重试 */
    }
    renderMain();
    renderRail();
  }

  function updateURL() {
    const p = new URLSearchParams();
    if (state.session) p.set('session', state.session);
    // 保留 URL 里那个"不在当前窗口"的 id，刷新后还能看到同一条说明。
    const trace = state.reqId ?? state.missingReqId ?? state.offPageReqId;
    if (trace !== null) p.set('trace', String(trace));
    // 只把显式内容页签写回 URL；读数是缺省，不落参数。
    const tab = railTabParam(state.railTab);
    if (tab !== null) p.set('tab', tab);
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
    const myNav = ++navEpoch;
    state.session = key;
    state.reqId = wantedTrace;
    state.missingReqId = null;
    state.offPageReqId = null;
    state.selectedStep = null;
    state.toolOrd = null;
    state.toolOwner = null;
    state.requestOpen = new Set();
    // 页签是显式声明或用户偏好：URL 直达、popstate 与手动切会话都保留当前
    // 顶层页签；请求内的步骤与工具选择仍清除。
    state.pendingSession = key;
    state.userScrolled = false;
    state.revealed = false;
    state.readingChanged.clear();
    renderMain();
    await store.selectSession(key, windowLimit());
    if (myNav !== navEpoch) return;
    state.pendingSession = null;
    await resolveInitialTrace();
    if (myNav !== navEpoch) return;
    if (state.reqId === null && state.offPageReqId === null) {
      // 默认选最新一笔；窗口外 trace 保留其语义，不用最新顶替。
      const rows = currentRows();
      state.reqId = rows[rows.length - 1]?.req_id ?? null;
    }
    renderAll();
    void loadWindowReads();
    // 导航完成处补路由读取：URL 直达与切会话后路由页不要求再点一次页签。
    const routeTarget = routeReadTarget(state.railTab, state.reqId);
    if (routeTarget !== null) void ensureRoute(routeTarget);
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
    const deltaMore = /** @type {HTMLElement | null} */ (t.closest('[data-delta-more]'));
    if (deltaMore !== null) { void resumeDelta(Number(deltaMore.dataset.deltaMore)); return; }
    const structureBack = /** @type {HTMLElement | null} */ (t.closest('[data-structure-back]'));
    if (structureBack !== null) {
      if (structureSelected.delete(Number(structureBack.dataset.structureBack))) renderRail();
      return;
    }
    const bodyLoad = /** @type {HTMLElement | null} */ (t.closest('[data-body-load]'));
    if (bodyLoad !== null) { void ensureRead(Number(bodyLoad.dataset.bodyLoad)); return; }
    // 工具四页导航：所有身份都只用 owner/callOrd；选中同步到调用步骤，中栏高亮一致。
    const toolSelect = /** @type {HTMLElement | null} */ (t.closest('[data-tool-select]'));
    if (toolSelect !== null) {
      state.toolOrd = Number(toolSelect.dataset.toolSelect);
      state.toolOwner = state.reqId;
      state.toolPage = 'pair';
      if (state.reqId !== null) state.selectedStep = `${state.reqId}:call:${state.toolOrd}`;
      renderMain();
      renderRail();
      updateURL();
      if (state.reqId !== null) void ensurePair(state.reqId, state.toolOrd);
      return;
    }
    if (t.closest('[data-tool-back]') !== null) {
      state.toolOrd = null;
      state.toolOwner = null;
      renderRail();
      updateURL();
      return;
    }
    const toolPageBtn = /** @type {HTMLElement | null} */ (t.closest('[data-tool-page]'));
    if (toolPageBtn !== null) { state.toolPage = toolPageBtn.dataset.toolPage ?? 'overview'; renderRail(); return; }
    // 工具往返行的配对入口：在右栏打开配对页就地阅读，不跳转中栏选择。
    const toolOwnerBtn = /** @type {HTMLElement | null} */ (t.closest('[data-tool-owner]'));
    if (toolOwnerBtn !== null) {
      const owner = Number(toolOwnerBtn.dataset.toolOwner);
      state.toolOrd = Number(toolOwnerBtn.dataset.callOrd);
      state.toolOwner = owner;
      state.toolPage = 'pair';
      state.railTab = 'tools';
      state.selectedStep = `${owner}:call:${state.toolOrd}`;
      renderMain();
      renderRail();
      updateURL();
      void ensurePair(owner, state.toolOrd);
      return;
    }
    const toolRead = /** @type {HTMLElement | null} */ (t.closest('[data-tool-read]'));
    if (toolRead !== null) { void readToolResult(Number(toolRead.dataset.toolRead), Number(toolRead.dataset.callOrd)); return; }
    const toolRetry = /** @type {HTMLElement | null} */ (t.closest('[data-tool-retry]'));
    if (toolRetry !== null) {
      void readToolResult(Number(toolRetry.dataset.toolRetry), Number(toolRetry.dataset.callOrd), true);
      return;
    }
    const copyTool = /** @type {HTMLElement | null} */ (t.closest('[data-copy-tool]'));
    if (copyTool !== null) {
      // 参数页可能与配对页一样描述窗口外 owner 的调用：复制走 owner 的读取。
      const ownerOfTool = state.toolOwner ?? state.reqId;
      const read = ownerOfTool !== null ? store.peekRequest(ownerOfTool) : null;
      const tool = read !== null && read.meta !== null
        ? toolEntries(read.detail, read.meta).find(item => item.ord === Number(copyTool.dataset.copyTool)) ?? null
        : null;
      // 参数只复制原文，不走 HTML 展示路径。
      if (tool !== null && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(tool.inputText).then(() => {
          copyTool.textContent = '已复制';
        }).catch(() => {});
      }
      return;
    }
    const railReply = t.closest('[data-rail-reply]');
    if (railReply !== null) { state.selectedStep = null; renderRail(); return; }
    const copyMsg = /** @type {HTMLElement | null} */ (t.closest('[data-copy-msg]'));
    if (copyMsg !== null) {
      const ord = Number(copyMsg.dataset.copyMsg);
      const read = state.reqId === null ? null : store.peekRequest(state.reqId);
      const entry = read === null ? null : read.entries.find((/** @type {{ord: number}} */ item) => item.ord === ord) ?? null;
      if (entry !== null && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(messageCopyText(entry)).then(() => {
          /** @type {HTMLElement} */ (copyMsg).textContent = '已复制';
        }).catch(() => {});
      }
      return;
    }
    // 消息行有两个语境：右栏结构折叠里只改该请求的选中消息（structureSelected）；
    // 主栏内联清单里选中消息并在右栏正文页打开。
    const msg = /** @type {HTMLElement | null} */ (t.closest('[data-msg]'));
    if (msg !== null) {
      const fold = msg.closest('[data-structure-fold]');
      if (fold !== null) {
        const reqId = Number(/** @type {HTMLElement} */ (fold).dataset.structureFold);
        if (store.peekRequest(reqId) !== null) {
          structureSelected.set(reqId, Number(msg.dataset.msg));
          // 结构内再选消息同步当前选择；中栏高亮与右栏正文一致。
          state.reqId = reqId;
          state.selectedStep = `${reqId}:message:${msg.dataset.msg}`;
          state.toolOrd = null;
          state.toolOwner = null;
          renderMain();
          renderRail();
          updateURL();
        }
        return;
      }
      const group = msg.closest('.trace-group');
      const id = group !== null ? Number(/** @type {HTMLElement} */ (group).dataset.req) : state.reqId;
      if (id !== null && Number.isFinite(id)) {
        state.reqId = id;
        state.selectedStep = `${id}:message:${msg.dataset.msg}`;
        state.toolOrd = null;
        state.toolOwner = null;
        state.railTab = 'body';
        renderMain();
        renderRail();
        updateURL();
      }
      return;
    }
    const sess = /** @type {HTMLElement | null} */ (t.closest('[data-session]'));
    if (sess) { void selectSession(sess.dataset.session ?? ''); return; }
    const agent = /** @type {HTMLElement | null} */ (t.closest('[data-agent]'));
    if (agent) { state.agent = agent.dataset.agent ?? 'all'; renderFilters(); renderSessions(); return; }
    const select = /** @type {HTMLElement | null} */ (t.closest('[data-step-key]'));
    if (select !== null) {
      const group = /** @type {HTMLElement | null} */ (select.closest('.trace-group'));
      const id = group !== null ? Number(group.dataset.req) : state.reqId;
      if (id !== null && Number.isFinite(id)) {
        void selectRequest(id, select.dataset.stepKey ?? null);
      }
      return;
    }
    const rail = /** @type {HTMLElement | null} */ (t.closest('[data-rail]'));
    if (rail) {
      state.railTab = rail.dataset.rail === 'facts' ? 'facts' : rail.dataset.rail === 'route' ? 'route' : rail.dataset.rail === 'tools' ? 'tools' : 'body';
      // 页签点击是明确的阅读动作：按需读取一次，失败保留未读，再次点击可重试。
      const routeTarget = routeReadTarget(state.railTab, state.reqId);
      if (routeTarget !== null) void ensureRoute(routeTarget);
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
    state.toolOwner = null;
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

  // toggle 不冒泡，用捕获阶段收；开合按稳定键保存，重绘后由 open 属性恢复。
  document.addEventListener('toggle', (e) => {
    const t = /** @type {HTMLDetailsElement} */ (e.target);
    if (!(t instanceof HTMLDetailsElement)) return;
    const key = t.dataset.fold;
    if (key !== undefined) folds.set(key, t.open);
    if (!t.open) return;
    if (t.dataset.structureFold !== undefined) {
      const id = Number(t.dataset.structureFold);
      const read = store.peekRequest(id);
      // 首次展开才读取结构；已读或不完整读取中不重复发起。
      if (read !== null && read.structure.total === null && !read.structure.loading) void loadStructure(id);
    }
    if (key !== undefined && key.startsWith('route:')) void ensureRoute(Number(key.slice(6)));
  }, true);

  // 用户主动滚动后，prepend 不再强行补偿旧锚点。
  el('main').addEventListener('wheel', () => { state.userScrolled = true; }, { passive: true });
  el('main').addEventListener('touchmove', () => { state.userScrolled = true; }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('input, textarea, summary')) return;
    if (e.key === 'Escape') { state.railTab = 'facts'; state.toolOrd = null; state.toolOwner = null; renderRail(); updateURL(); }
  });

  el('theme-toggle').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(themePref) + 1) % order.length] ?? 'system';
    try { localStorage.setItem('tc.theme', next); } catch { /* storage may be blocked */ }
    themePref = next;
    applyTheme();
  });

  /* ---------------- 布局控制：折叠与详情栏调宽 ---------------- */
  const RAIL_MIN = 280, RAIL_MAX = 640, MAIN_MIN = 320;
  /**
   * 详情栏宽度夹取：范围 280..640，且给中栏保留至少 320px。
   * @param {number} wanted @param {number} viewport @param {number} sidebar
   */
  const clampWidth = (wanted, viewport, sidebar) =>
    Math.max(RAIL_MIN, Math.min(wanted, RAIL_MAX, Math.max(RAIL_MIN, viewport - sidebar - 6 - MAIN_MIN)));
  /** 折叠中的会话栏宽度按 0 计。 */
  function sidebarWidth() {
    if (document.body.classList.contains('sidebar-collapsed')) return 0;
    return document.querySelector('.col-sessions')?.getBoundingClientRect().width ?? 0;
  }
  const resizer = el('rail-resize');
  /** @type {number | null} 按住中的 pointerId；move 只在按住时生效。 */
  let draggingPointer = null;
  /** @param {number} wanted */
  function resizeRail(wanted) {
    const limit = Math.round(clampWidth(RAIL_MAX, window.innerWidth, sidebarWidth()));
    const value = Math.round(clampWidth(wanted, window.innerWidth, sidebarWidth()));
    document.documentElement.style.setProperty('--rail-width', `${value}px`);
    resizer.setAttribute('aria-valuenow', String(value));
    resizer.setAttribute('aria-valuemax', String(limit));
  }
  resizer.addEventListener('pointerdown', e => {
    draggingPointer = e.pointerId;
    try { resizer.setPointerCapture(e.pointerId); } catch { /* 合成指针没有 capture；按住标记已生效 */ }
  });
  resizer.addEventListener('pointermove', e => {
    if (draggingPointer === e.pointerId) {
      preferredRailWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, window.innerWidth - e.clientX));
      fitRail();
    }
  });
  /** @param {PointerEvent} e */
  const releasePointer = e => {
    if (draggingPointer === e.pointerId) draggingPointer = null;
    try { if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  };
  resizer.addEventListener('pointerup', releasePointer);
  resizer.addEventListener('pointercancel', releasePointer);
  let preferredRailWidth = RAIL_MAX;
  function fitRail() {
    if (window.innerWidth > 1000) resizeRail(preferredRailWidth);
  }
  fitRail();
  resizer.addEventListener('dblclick', () => {
    preferredRailWidth = RAIL_MAX;
    fitRail();
  });
  resizer.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const current = document.querySelector('.col-rail')?.getBoundingClientRect().width ?? RAIL_MAX;
      preferredRailWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, current + (e.key === 'ArrowLeft' ? 20 : -20)));
      fitRail();
    }
  });
  window.addEventListener('resize', fitRail);
  /** 折叠按钮的 aria 状态与 body 类同步。 */
  function syncPanelButtons() {
    for (const [id, cls, name] of [['sidebar-toggle', 'sidebar-collapsed', '会话栏'], ['rail-toggle', 'rail-collapsed', '详情栏']]) {
      const button = el(id);
      const closed = document.body.classList.contains(cls);
      button.setAttribute('aria-expanded', String(!closed));
      button.setAttribute('aria-label', `${closed ? '展开' : '收起'}${name}`);
      button.title = button.getAttribute('aria-label') ?? '';
    }
  }
  el('sidebar-toggle').addEventListener('click', () => { document.body.classList.toggle('sidebar-collapsed'); syncPanelButtons(); fitRail(); });
  el('rail-toggle').addEventListener('click', () => { document.body.classList.toggle('rail-collapsed'); syncPanelButtons(); });

  /* ---------------- Session ID 复制 ---------------- */
  /** @param {string} text */
  function toast(text) {
    const chip = document.createElement('div');
    chip.className = 'toast';
    chip.textContent = text;
    document.body.append(chip);
    setTimeout(() => chip.remove(), 2400);
  }
  /**
   * 复制当前会话身份：JSON 数组的 session 复制第二项原始 ID，conv 身份复制完整 conv_key；
   * 不把 JSON 数组误称 UUID。剪贴板拒绝或不可用时给出可选中文本降级。
   */
  async function copySessionId() {
    const key = state.session;
    if (key === null) { toast('当前没有选中的会话'); return; }
    let text = key;
    let label = '会话键';
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length >= 2 && parsed[0] === 'session') {
        text = String(parsed[1]);
        label = 'Session ID';
      }
    } catch { /* conv 身份：复制完整 conv_key */ }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`);
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.top = '-1000px';
      document.body.append(field);
      field.focus();
      field.select();
      toast(`复制受限：已选中${label}，按 ⌘C / Ctrl+C 复制`);
      field.addEventListener('blur', () => field.remove(), { once: true });
    }
  }
  el('copy-session').addEventListener('click', () => { void copySessionId(); });

  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    state.session = p.get('session');
    state.reqId = p.get('trace') ? Number(p.get('trace')) : null;
    state.missingReqId = null;
    state.offPageReqId = null;
    state.railTab = railTabFromParam(p.get('tab'));
    state.toolOrd = null;
    state.toolOwner = null;
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
