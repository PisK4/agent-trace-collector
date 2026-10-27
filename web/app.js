// @ts-check
/**
 * 读者前端：单一轨迹视图。窗口、正文区间、结构与工具结果都经 reader-store
 * 读取（带阅读版本）；步骤投影用 trace-view 的纯函数，行级文案在 row-summary、
 * 右栏组合在 rail-facts、URL 目标在 url-route，这里只做装配与交互。
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/sessions').SessionRow} SessionRow
 */

import {
  bodyNotice, renderCapabilities, renderMessageDetail, renderReply,
  renderReplyBlockDetail, renderReplyDetail, renderSystemDetail, renderUnknownBlockDetail,
  roleTag, toolTint,
} from './body-view.js';
import {
  deltaOrdinals, messageCopyText, messagesKeyOf, replyView, toolEntries,
} from './body-model.js';
import { esc } from './html.js';
import { partLabel } from './parts.js';
import { createReaderStore } from './reader-store.js';
import { initLayout, openRail } from './layout.js';
import { fillContextMap, iidOf, itemLabel } from './context-map.js';
import { createContextMenu, iidParse } from './context-detail.js';
import {
  kk, ledgerRowsHtml, railFactsHtml, readingChangedNote, renderAttemptChain,
  resolveSelectedSource, secs, structureFoldHtml, systemContextOf, toolOverviewHtml,
  toolSchemaSection, usageFoldHtml,
} from './rail-facts.js';
import { bodyLabelText, bodyStateText, replyCompleteness } from './row-summary.js';
import {
  agentLabel, clock, dayTime,
  railSummaryListHtml as railSummaryListView,
  sessionHead as sessionHeadView,
  sessionsListBypassHtml,
} from './session-view.js';
import { applyIntent } from './selection.js';
import { createMainView } from './trace-dom.js';
import { renderTracePair } from './trace-pair.js';
import { projectSteps, renderTraceRow } from './trace-view.js';
import { renderTurnBand, renderTurnRail, renderTurnRailHead } from './turn-band.js';
import { railTabFromParam, railTabParam, resolveTraceTarget } from './url-route.js';

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
  // store 是唯一的读取缓存：页面同步渲染经 peek* 消费，副本不作第二份真相。
  const store = createReaderStore((/** @type {string} */ url) => fetch(url),
    // 记录快照异步变化（409 作废、自动重读换新或失败）时重绘两栏；迟到响应不进来。
    () => { renderMain(); renderRail(); },
    // 轮次快照与会话汇总落地（出现/消失、折叠区就绪）同样重绘两栏。
    { onTurnsChanged: () => { renderMain(); renderRail(); },
      onSummaryChanged: () => { renderMain(); renderRail(); } });
  /** @type {Map<string, boolean>} 折叠开合按稳定键保存（键含 req id），重绘后恢复。 */
  const folds = new Map();
  /** @type {Map<number, number>} 结构折叠内选中的消息 ord 按 req id 保存：UI 选择留在页面，不进 store。 */
  const structureSelected = new Map();
  /**
   * 上下文明细弹窗：tile、图例与列表行共用的选择动作。读取走注入的同一 fetcher，
   * 代次捕获在模块内，晚到响应不进已切换的弹窗。
   */
  const contextMenu = createContextMenu({ fetcher: (/** @type {string} */ url) => fetch(url) });
  /** @type {{kind: string, param: string, label: string, loading: boolean, error: string | null, data: import('../src/queries/session-summary').SummaryEntries | null} | null} 会话汇总条目列表：点开条目后右栏的支撑记录清单。 */
  let summaryList = null;
  /** 中栏键控提交：节点身份、选择高亮与滚动锚点都在视图内维护，装配层只给模型。 */
  const mainView = createMainView(el('main'));

  const qp = new URLSearchParams(location.search);
  const state = {
    session: qp.get('session'),
    reqId: qp.get('trace') ? Number(qp.get('trace')) : null,
    /** URL 指定的请求在库里不存在。 */
    missingReqId: /** @type {number | null} */ (null),
    /** URL 指定的请求存在，但落在当前窗口外（更早的历史）。 */
    offPageReqId: /** @type {number | null} */ (null),
    /** 选中的轮次（会话内已结算轮序号）；null 表示请求态。 */
    turn: /** @type {number | null} */ (null),
    selectedStep: /** @type {string | null} */ (null),
    toolOrd: /** @type {number | null} */ (null),
    /** 配对页描述的调用属于哪笔请求：从结果步骤进入时可能与当前请求不同；null 表示当前请求。 */
    toolOwner: /** @type {number | null} */ (null),
    /** 工具详情四页的当前页：overview / params / pair / schema。 */
    toolPage: 'pair',
    /** 旁路会话折叠的展开开关：折叠是默认态，展开只影响渲染不改任何派生。 */
    showBypass: false,
    railTab: railTabFromParam(qp.get('tab')),
    query: '',
    agent: 'all',
    pendingSession: /** @type {string | null} */ (null),
    /** 最近一次显式刷新时间；刷新会重建最近窗口并清掉旧阅读版本。 */
    refreshedAt: /** @type {number | null} */ (null),
    /** 首载批次是否已把选中组带入可见区；加载更早不再重复居中。 */
    revealed: false,
  };
  /** 载入窗口详情的轮次：换会话或刷新时自增，作废在跑的批次。 */
  let loadEpoch = 0;
  /** 导航代次：换会话或显式刷新时自增，旧导航的 await 后续不再覆盖当前选择。 */
  let navEpoch = 0;

  /* ---------------- 选择状态：唯一写者与效果执行器 ---------------- */
  const SELECTION_KEYS = ['session', 'reqId', 'selectedStep', 'toolOrd', 'toolOwner', 'toolPage', 'railTab', 'missingReqId', 'offPageReqId', 'turn'];
  /**
   * 发意图经纯转换改写选择元组并执行效果：所有选择写入都走这里，
   * 渲染函数不再改 state；规则与效果清单在 selection.js。
   * @param {import('./selection.js').Intent} intent
   */
  function dispatch(intent) {
    const view = /** @type {Record<string, unknown>} */ (state);
    /** @type {Record<string, unknown>} */
    const before = {};
    for (const key of SELECTION_KEYS) before[key] = view[key];
    const applied = applyIntent(/** @type {import('./selection.js').SelectionState} */ (before), intent);
    const next = /** @type {Record<string, unknown>} */ (applied.state);
    for (const key of SELECTION_KEYS) view[key] = next[key];
    runEffects(applied.effects);
  }
  /** @param {import('./selection.js').Effect[]} effects */
  function runEffects(effects) {
    for (const fx of effects) {
      switch (fx.kind) {
        case 'open-rail': openRail(); break;
        case 'render-crumb': renderCrumb(); break;
        case 'render-main': renderMain(); break;
        case 'render-rail': renderRail(); break;
        case 'update-url': updateURL(); break;
        case 'focus-step':
          // 重绘会替换 DOM：把焦点放回当前步骤，键盘导航不中断。
          requestAnimationFrame(() => {
            const current = /** @type {HTMLElement | null} */ (document.querySelector('.compact-select[aria-current="true"]'));
            if (current !== null && document.activeElement === document.body) current.focus();
          });
          break;
        case 'scroll-group':
          requestAnimationFrame(() => {
            document.querySelector(`.trace-group[data-req="${CSS.escape(String(fx.reqId))}"]`)
              ?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
          });
          break;
        case 'ensure-read': void ensureRead(Number(fx.reqId)); break;
        case 'ensure-pair': void ensurePair(Number(fx.owner), Number(fx.callOrd)); break;
        case 'ensure-turn': void ensureTurnReads(Number(fx.startReq), Number(fx.replyReq), fx.ords ?? []); break;
        case 'resume-delta': void resumeDelta(Number(fx.reqId)); break;
        case 'read-route': void ensureRoute(Number(fx.reqId)); break;
      }
    }
  }
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
  // have 位义与 src/evidence.ts 一致：1 正文回调、2 账本用量、4 路由历史、8 OTLP span。
  const HAVE_BODY = 1, HAVE_LEDGER = 2;
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
    // 作废项归 store 的自动重读管，批次不重复发起；失败项随批次重试（瞬时故障可自愈）。
    const wanted = currentRows().filter(row => {
      const read = store.peekRequest(row.req_id);
      return read === null || read.status === 'failed';
    });
    for (let index = 0; index < wanted.length; index += 4) {
      if (epoch !== loadEpoch) return;
      const chunk = wanted.slice(index, index + 4);
      await Promise.all(chunk.map(async row => {
        try {
          const read = await store.readRequest(row.req_id);
          if (!read.delta.done) await store.loadDelta(row.req_id, 2);
        } catch {
          /* reading_changed 的作废与自动重读由 store 负责；其余单笔失败保留占位记录，刷新可重试 */
        }
      }));
      if (epoch !== loadEpoch) return;
      renderMain();
      // 读数页的数量与计数也依赖这些读取：每批同步刷新右栏。
      renderRail();
    }
    if (epoch === loadEpoch) state.revealed = true;
  }

  /* ---------------- 顶栏与左栏 ---------------- */
  function renderCrumb() {
    const row = state.session === null ? null : sessionRow(state.session);
    const idx = ordinalOf(state.reqId ?? -1);
    const here = state.missingReqId !== null ? `Request ${state.missingReqId} 未找到`
      : state.offPageReqId !== null ? `Request ${state.offPageReqId} 未在当前窗口`
        : idx > 0 ? `Request ${String(idx).padStart(2, '0')}` : '';
    // 会话标题由中栏 sticky h1 常驻可见，crumb 只承担请求定位。
    el('crumb').innerHTML = here === '' ? '' : `<b>${esc(here)}</b>`;
    document.title = row ? `${here === '' ? row.title : `${here} · ${row.title}`} — Trace Collector`
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
    const all = /** @type {SessionRow[]} */ (store.getSessions().items.filter(sessionMatches));
    // 旁路会话（全请求 exclude）默认折叠：渲染层过滤，分页仍按全量，折叠计数
    // 只覆盖已加载页。任一笔参与链请求都不折叠。
    const list = state.showBypass ? all : all.filter(s => !s.flags.includes('bypass'));
    el('load-more-sessions').hidden = store.getSessions().cursor === null;
    // 列表被搜索或筛选收窄时才计数；与已加载数一致时数字不承载信息。
    el('sess-count').textContent = list.length === store.getSessions().items.length
      ? '' : `${list.length} / ${store.getSessions().items.length}`;
    const item = (/** @type {SessionRow} */ s) => {
      // 左栏只保留具体事实标记；失败由红点承载，字眼进悬停；缺正文的点刻意低
      // 对比，与正常点的差别不可辨，文字仍是唯一载体，保留。
      const flag = s.flags.includes('failed') ? { color: 'var(--bad)', text: '', title: '含失败' }
        : s.flags.includes('missing_body') ? { color: 'var(--muted)', text: '缺正文', title: '缺正文' }
          : { color: 'var(--line-strong)', text: '', title: '' };
      return `<button class="sess" data-session="${esc(s.conv_key)}" aria-current="${s.conv_key === state.session}">
        <span class="sess-title">${esc(s.title || '（无标题）')}</span>
        <span class="sess-time num">${esc(clock(s.last_ms))}</span>
        <span class="sess-meta">
          <span class="dot" style="background:${flag.color}"${flag.title ? ` title="${flag.title}"` : ''}></span>
          <span class="who">${esc(s.agents.length > 0 ? s.agents.map(agentLabel).join(' · ') : '归属未知')}</span><span class="sep">·</span>
          <span>${s.request_count} 笔</span>
          ${flag.text ? `<span class="sep">·</span><span style="color:${flag.color}">${flag.text}</span>` : ''}
        </span>
      </button>`;
    };
    const foldHtml = sessionsListBypassHtml(all, state.showBypass);
    el('sessions-list').innerHTML = list.length
      ? list.map(item).join('') + foldHtml
      : (foldHtml !== ''
        ? foldHtml
        : '<p class="sess-empty">当前已加载的会话里没有符合条件的项。搜索与筛选只覆盖已加载范围。</p>');
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
    if (r.via === 'otlp') return 'OTLP 通道';
    if (!(r.have & HAVE_LEDGER)) return '仅回调，未关联账本';
    if (!(r.have & HAVE_BODY)) return '仅账本，没有回调';
    return '账本 + 回调';
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
    if (detail.prev_relation === 'branch') {
      return detail.context_event === 'omp_compaction'
        ? '另起一支 · 压缩归档改写了上下文前缀' : '另起一支';
    }
    if (detail.prev_relation === 'unknown') return '前驱正文不可读，无法比对';
    return '';
  }

  /** 会话头装配：store 与选择状态在此读齐，纯展示在 session-view。 */
  function sessionHead() {
    const summary = store.peekSummary();
    return sessionHeadView({
      sessionKey: state.session,
      row: state.session === null ? null : sessionRow(state.session),
      rows: currentRows(),
      refreshedAt: state.refreshedAt,
      missingReqId: state.missingReqId,
      offPageReqId: state.offPageReqId,
      windowError: store.getWindow().error,
      summary: summary?.status === 'ready' ? summary.data : null,
      summaryFoldOpen: folds.get(`summary:${state.session ?? ''}`) === true,
    });
  }

  /**
   * 按调用位置读取结果。force 用于重试：store 的失败任务已释放，重发走网络。
   * 409 的作废与自动重读由 store 负责；迟到 409 保留现有快照，这里只刷新展示。
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
    const attempts = /** @type {import('../src/queries/routes').AttemptChain | null} */ (s.attempts ?? null);
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

  /**
   * 中栏模型：会话头、轮次带与步骤列表一次读齐，交给 trace-dom 键控提交。
   * 步骤行的 HTML 不含选择（默认 false），选择由视图单独写回高亮；
   * 请求组容器自身的可见结果为空串，内容按稳定步骤键逐行比较。
   * @returns {import('./trace-dom.js').MainModel}
   */
  function mainModel() {
    const window = store.getWindow();
    const rows = currentRows();
    const band = turnBandHtml();
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
    // 历史入口只在有更早记录或正在读取时出现；序号口径在数字本身的悬停说明里。
    const loaderHtml = window.loading
      ? '<div class="history-loader"><span class="history-start">正在读取更早记录…</span></div>'
      : window.olderCursor !== null
        ? '<div class="history-loader"><button id="load-earlier" class="history-button">↑ 加载更早记录</button></div>'
        : '';
    const groups = rows.map(r => {
      const read = store.peekRequest(r.req_id);
      const steps = projectSteps(r, read, systemContextOf(r, id => store.peekRequest(id)),
        store.peekBgJobs().items);
      const ordinal = ordinalOf(r.req_id);
      /** @type {import('./trace-dom.js').CommitItem[]} */
      const items = [];
      // 自动重读换新后的组级「已更新」：点进组里即清除，正常态不出现。
      if (read !== null && read.updatedSinceSeen) {
        items.push({ key: 'flag', html: '<div class="group-flag"><span class="state-chip warn"><span class="d"></span>已更新 · 自动重读换新</span></div>' });
      }
      for (const step of steps) {
        items.push({ key: step.key, html: renderTraceRow(r, step, ordinal, callOf) });
      }
      return {
        reqId: r.req_id,
        status: r.status === null ? 'unknown' : r.status >= 400 ? 'failed' : 'success',
        current: r.req_id === state.reqId,
        rows: items,
      };
    });
    return {
      headHtml: sessionHead(),
      bandHtml: band,
      listClass: `step-list${band !== '' ? ' band-above' : ''}`,
      ordDigits,
      loaderHtml,
      emptyHtml: rows.length === 0
        ? `<p class="sess-empty">${state.pendingSession !== null ? '正在读取请求…' : '这个会话没有已记录的请求。'}</p>`
        : '',
      endHtml: '<div class="timeline-end"><span></span> 已是最新记录</div>',
      groups,
      selectedStep: state.selectedStep,
    };
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

  /** 选中轮次的轮次行；列表未就绪或该轮已不在时为 null。 @param {number} n */
  function turnOf(n) {
    return store.peekTurns().items.find(item => item.turn === n) ?? null;
  }

  /** 轮次带：会话头与轨迹之间的一条目录层；无就绪轮次整条不渲染。 */
  function turnBandHtml() {
    const turns = store.peekTurns();
    if (turns.status !== 'ready') return '';
    return renderTurnBand(turns.items, state.turn, currentRows());
  }

  /** 轮次带吸顶位置贴 session-head 下沿：头部高度由内容决定，重绘与视口变化后同步。 */
  function syncBandTop() {
    const band = document.getElementById('turn-band');
    const head = /** @type {HTMLElement | null} */ (document.querySelector('.session-head'));
    if (band === null || head === null) return;
    band.style.top = `${head.offsetHeight}px`;
  }

  /**
   * 选中的块要带内可见：点靠后的轮、或重绘重建了带（横滚位置归零）之后，
   * 把选中块滚回视野。已在视野内不动，不跟用户的横向浏览抢滚动。
   */
  function revealSelectedChip() {
    const chip = /** @type {HTMLElement | null} */ (document.querySelector('.turn-chip[aria-pressed="true"]'));
    const band = document.getElementById('turn-band');
    if (chip === null || band === null) return;
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < band.scrollLeft || right > band.scrollLeft + band.clientWidth) {
      chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderMain() {
    const main = el('main');
    if (state.pendingSession !== null) {
      mainView.reset();
      main.innerHTML = `<p class="sess-empty" style="padding:24px">正在读取${esc(shortSession(state.pendingSession))}的请求…</p>`;
      return;
    }
    // 首载未定位完成时以选中组为锚，避免补读把它挤出视口；用户主动滚动后
    // 改锚首条可见步骤，阅读位置不再被选中组牵走。
    const preferred = state.revealed ? null : state.reqId;
    mainView.commit(mainModel(), scroller(), preferred);
    restoreFolds(main);
    syncBandTop();
    revealSelectedChip();
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
    // 轮次态：身份行换成轮次身份，页签行隐藏——页签是请求作用域。
    if (state.turn !== null) {
      const turn = turnOf(state.turn);
      if (turn !== null) return renderTurnRailHead(turn);
    }
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
        <summary>本次回复${canLoad ? '' : `<span class="fold-count">${esc(bodyStateText(r))}</span>`}</summary>
        <div class="fold-body"><p class="note">${esc(bodyLabelText(r))}</p>
          ${read !== null && read.status === 'invalidated' ? readingChangedNote(r.req_id) : ''}
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
      usageHtml: usageFoldHtml(r, detail, meta),
      completenessHtml: completenessSection(r),
    });
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
        ${read !== null && read.status === 'invalidated' ? readingChangedNote(r.req_id) : ''}
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
      return `<section class="rail-section"><h3>工具调用<span class="grow"></span><span class="hint">${tools.length} 次调用</span></h3>${rows.join('')}</section>`;
    }
    const owner = state.toolOwner ?? r.req_id;
    const ownerRead = owner === r.req_id ? read : store.peekRequest(owner);
    if (ownerRead === null || ownerRead.meta === null) {
      // 调用方读取未就绪：配对需要它的回复与配对状态；作废时自动重读在途，仍给立即重读入口。
      return `<div class="rail-empty"><b>正在读取调用方请求…</b>配对需要调用方的回复与配对状态，读取完成后自动展示两端。</div>
        ${ownerRead !== null && ownerRead.status === 'invalidated' ? readingChangedNote(owner) : ''}`;
    }
    const ownerDetail = ownerRead.detail;
    const ownerPage = ownerRead.meta;
    const tools = toolEntries(ownerDetail, ownerPage);
    const tool = tools.find(item => item.ord === state.toolOrd) ?? null;
    if (tool === null) {
      // 选择清理已在 renderRail 入口经 tool-gone 意图完成；此处不应到达。
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
    // 会话汇总条目列表：会话级阅读态，优先于轮次与请求态；点击条目后清掉。
    if (summaryList !== null) return railSummaryListView(summaryList, requestLabel);
    // 轮次态：命令组与最终回复两个面板，两端默认展开；点轨迹任意行经选择转换回请求态。
    if (state.turn !== null) {
      const turn = turnOf(state.turn);
      if (turn !== null) {
        return renderTurnRail({
          turn,
          startRead: store.peekRequest(turn.start_req),
          replyRead: store.peekRequest(turn.reply_req),
          startRow: currentRows().find(row => row.req_id === turn.start_req) ?? null,
          replyRow: currentRows().find(row => row.req_id === turn.reply_req) ?? null,
        });
      }
      return '<div class="rail-empty"><b>轮次不可用</b>重新结算后这一轮不在列表里；点击轨迹任意行返回请求态。</div>';
    }
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
        ${read !== null && read.status === 'invalidated' ? readingChangedNote(r.req_id) : ''}
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
      body = renderSystemDetail(source.text, source.path);
    } else if (source.side === 'request') {
      const chosen = read.entries.find((/** @type {{ord: number}} */ entry) => entry.ord === source.messageOrd) ?? null;
      body = chosen !== null ? renderMessageDetail(chosen, messagesKeyOf(page))
        : `<div class="rail-empty"><b>消息未读取</b>${messagesKeyOf(page)}[${source.messageOrd}] 不在已加载的分片里；读取完成后回到这一步。</div>`;
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
  /* 上下文矩阵：读数页渲染外壳，这里测量容器填充 tile，并按尺寸变化重排。
     通知经 rAF 合并，只在有效尺寸变化后重绘，不触发任何正文读取；
     重绘替换容器后先解除旧观察再观察新容器，避免残留观察离屏节点。 */
  let ctxMapSize = { w: 0, h: 0 };
  let ctxMapQueued = false;
  const ctxMapObserver = new ResizeObserver(() => {
    if (ctxMapQueued) return;
    ctxMapQueued = true;
    requestAnimationFrame(() => { ctxMapQueued = false; refreshContextMap(); });
  });
  function refreshContextMap() {
    const container = /** @type {HTMLElement | null} */ (document.querySelector('[data-ctx-map]'));
    if (container === null) { ctxMapSize = { w: 0, h: 0 }; return; }
    const detail = currentRead()?.detail ?? null;
    const p = detail?.prompt ?? null;
    if (p === null || !p.parts.some(x => x.tokens > 0)) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (w === ctxMapSize.w && h === ctxMapSize.h && container.childElementCount > 0) return;
    fillContextMap(container, p, Number(container.dataset.ctxMap));
    ctxMapSize = { w, h };
  }
  /** 读数页重绘后调用：替换容器即换观察对象，旧观察一并解除。 */
  function wireContextMap() {
    ctxMapObserver.disconnect();
    refreshContextMap();
    const container = document.querySelector('[data-ctx-map]');
    if (container !== null) ctxMapObserver.observe(container);
  }
  function renderRail() {
    // 选定的工具在调用方读取里已不存在时先清选择再渲染：渲染函数不改 state。
    // 调用方读取未就绪（meta 为空）不算消失，保留选择显示「正在读取」。
    if (state.toolOrd !== null) {
      const owner = state.toolOwner ?? state.reqId;
      const ownerRead = owner !== null ? store.peekRequest(owner) : null;
      if (ownerRead !== null && ownerRead.meta !== null
        && !toolEntries(ownerRead.detail, ownerRead.meta).some(tool => tool.ord === state.toolOrd)) {
        dispatch({ kind: 'tool-gone' });
      }
    }
    // 轮次列表重算后选中的轮不在了：先清再渲染，同 tool-gone 的立场。
    if (state.turn !== null && turnOf(state.turn) === null) dispatch({ kind: 'turn-gone' });
    // 弹窗身份绑定请求：换请求或清空选择的重绘把它关掉，同请求重绘不受影响。
    contextMenu.closeIfFor(state.reqId ?? -1);
    el('rail-head').innerHTML = railHead();
    const rail = el('rail-body');
    // 滚动只在「同请求同页签的重绘」里保持；页签切换与换请求都回到顶部，行为可预期。
    // 轮次态的键带轮号：逐轮翻阅时滚动回顶，不把上一轮的阅读位置带过去。
    const key = `${state.turn ?? ''}:${state.reqId}:${state.railTab}`;
    const keep = key === lastRailKey ? rail.scrollTop : 0;
    rail.innerHTML = railBody();
    restoreFolds(rail);
    restoreScroll(rail, keep);
    lastRailKey = key;
    wireContextMap();
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
  /** 当前滚动容器：main 独立滚动时用 main，窄屏文档流用滚动根；根元素缺失时退回 main。 */
  function scroller() {
    const main = el('main');
    return getComputedStyle(main).overflowY === 'visible' ? (document.scrollingElement ?? main) : main;
  }

  async function loadEarlier() {
    const button = document.getElementById('load-earlier');
    if (button !== null) (/** @type {HTMLButtonElement} */ (button)).disabled = true;
    await store.loadEarlier();
    // prepend 的位置由每次提交自带的锚点补偿保持，不再手接快照。
    renderMain();
    renderSessions();
    void loadWindowReads();
  }

  /** 显式刷新：重建最近窗口、清掉旧展开，记录读取时间；记录缓存随窗口重建。 */
  async function refreshWindow() {
    if (state.session === null) return;
    const myNav = ++navEpoch;
    state.refreshedAt = Date.now();
    state.revealed = false;
    dispatch({ kind: 'refresh-start' });
    await store.selectSession(state.session, windowLimit());
    if (myNav !== navEpoch) return;
    const rows = currentRows();
    dispatch({ kind: 'select-latest', latestReqId: rows[rows.length - 1]?.req_id ?? null });
    renderAll();
    // 导航完成：路由页随重建后的选中请求读取（效果经 nav-settled 统一发出）。
    dispatch({ kind: 'nav-settled' });
    void loadWindowReads();
    void ensureSelectedVisible();
  }

  async function jumpLatest() {
    await refreshWindow();
    locateRequest(currentRows()[currentRows().length - 1]?.req_id ?? -1);
  }

  /** 定位窗口内请求：选中并滚动进入可见区域（路由随导航完成读取、定点补读都走效果）。 @param {number} id */
  function locateRequest(id) {
    const rows = currentRows();
    if (!rows.some(row => row.req_id === id)) return;
    dispatch({ kind: 'locate', reqId: id });
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
    let read;
    try {
      read = await store.readRequest(id);
    } catch {
      /* reading_changed 的作废与自动重读由 store 负责；失败态由快照如实渲染 */
      renderMain();
      renderRail();
      return;
    }
    // 重读与初始装载同深：详情到手后补最多两片可信增量；
    // 409 作废塌掉的组由 store 自动重读恢复，这里只补选择所需的定点块。
    if (!read.delta.done) {
      try { read = await store.loadDelta(id, 2); } catch { /* 失败保留增量事件行，可再次续读 */ }
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

  /**
   * 轮次两端就绪：起点与终点请求各做一次与手动选中同深的读取，命令组里
   * 分片未到的消息按 ord 定点补读，不为此扩量读整条增量。
   * @param {number} startReq @param {number} replyReq @param {number[]} ords
   */
  async function ensureTurnReads(startReq, replyReq, ords) {
    await Promise.all([ensureRead(startReq), ensureRead(replyReq)]);
    const read = store.peekRequest(startReq);
    for (const ord of ords) {
      if (read !== null && !read.entries.some(entry => entry.ord === ord)) {
        await ensureMessageOrd(startReq, ord);
      }
    }
    renderMain();
    renderRail();
  }

  /** 窗口内请求显示序号，窗口外保留稳定身份。 @param {number} id */
  function requestLabel(id) {
    const label = windowLabel(id);
    return label.startsWith('req ') ? label : `req ${label}`;
  }

  /**
   * 打开条目列表：按组现查，不缓存；换目标时旧响应作废。
   * @param {import('../src/queries/session-summary').SummaryEntriesQuery} query
   * @param {string} label
   */
  async function openSummaryList(query, label) {
    summaryList = { kind: query.kind, param: label, label, loading: true, error: null, data: null };
    openRail();
    renderRail();
    try {
      const data = await store.loadSummaryEntries(query);
      if (summaryList === null || summaryList.label !== label) return;
      summaryList = { ...summaryList, loading: false, data };
    } catch (error) {
      if (summaryList === null || summaryList.label !== label) return;
      summaryList = {
        ...summaryList, loading: false,
        error: error instanceof Error ? error.message : 'entries_failed',
      };
    }
    renderRail();
  }

  /** @param {number} id @param {string|null} key */
  async function selectRequest(id, key) {
    const row = currentRows().find(row => row.req_id === id);
    if (row === undefined) return;
    // 增量事件行是续读入口：打开读数页并再消费两片，不当作步骤选择。
    if (key === `${id}:delta`) {
      dispatch({ kind: 'select-delta', reqId: id });
      return;
    }
    const step = projectSteps(row, store.peekRequest(id), systemContextOf(row, x => store.peekRequest(x)))
      .find(item => item.key === key) ?? null;
    const source = resolveSelectedSource(step);
    // 配对判定与页签映射在选择转换里：这里只解析步骤来源。
    dispatch({ kind: 'select-step', reqId: id, stepKey: String(key), source });
  }

  /** @param {number} id */
  async function loadStructure(id) {
    try {
      await store.loadStructure(id);
    } catch {
      /* reading_changed 的作废与自动重读由 store 负责；其余结构失败保留 error 状态 */
    }
    renderMain();
    renderRail();
  }

  /** 显式续读可信增量：每轮两片，经原 4 并发队列；失败保留未消费位置可重试。 @param {number} id */
  async function resumeDelta(id) {
    try {
      await store.loadDelta(id, 2);
    } catch {
      /* reading_changed 的作废与自动重读由 store 负责；其余失败保留未消费位置可重试 */
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
    dispatch({ kind: 'trace-resolved', result: target.kind, reqId: target.reqId });
  }

  /**
   * @param {string} key
   * @param {number | null} [wantedTrace] URL 指定的 trace；会话内重选时为空
   */
  async function selectSession(key, wantedTrace = null) {
    const myNav = ++navEpoch;
    // 页签是显式声明或用户偏好：URL 直达、popstate 与手动切会话都保留当前
    // 顶层页签；请求内的步骤与工具选择仍清除。
    dispatch({ kind: 'open-session', sessionKey: key, wantedTrace });
    state.pendingSession = key;
    state.revealed = false;
    renderMain();
    await store.selectSession(key, windowLimit());
    if (myNav !== navEpoch) return;
    state.pendingSession = null;
    await resolveInitialTrace();
    if (myNav !== navEpoch) return;
    // 默认选最新一笔；窗口外 trace 保留其语义，不用最新顶替。
    const rows = currentRows();
    dispatch({ kind: 'session-default', latestReqId: rows[rows.length - 1]?.req_id ?? null });
    renderAll();
    void loadWindowReads();
    // 导航完成处补路由读取：URL 直达与切会话后路由页不要求再点一次页签。
    dispatch({ kind: 'nav-settled' });
    if (state.offPageReqId !== null) {
      // 窗口外 trace：详情已在右栏说明，主列表停在最前面。
      el('main').scrollTop = 0;
    } else {
      ensureSelectedVisible();
    }
  }

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    // 上下文明细：tile、图例与列表行带同一组 data-ctx-*，统一从这里解析范围。
    // 范围以统计为准（kind + item 身份），集合块与整类按类别取目录。
    const ctxSource = /** @type {HTMLElement | null} */ (t.closest('[data-ctx-kind]'));
    if (ctxSource !== null) {
      const detail = currentRead()?.detail ?? null;
      // reading_token 在 ReadingDetail 上；页面侧按未知字段读取，缺 token 不响应。
      const token = /** @type {{reading_token?: unknown} | null} */ (detail)?.reading_token;
      if (detail !== null && typeof token === 'string') {
        const kind = ctxSource.getAttribute('data-ctx-kind') ?? '';
        const key = ctxSource.getAttribute('data-ctx-key');
        const scope = ctxSource.getAttribute('data-ctx-scope');
        const reqId = Number(ctxSource.getAttribute('data-ctx-req') ?? state.reqId);
        const part = (detail.prompt?.parts ?? []).find(p => p.kind === kind) ?? null;
        const parsed = key !== null && key !== '' ? iidParse(key) : null;
        /** @type {{name: string | null, tag: string | null, label: string, tokens: number | null, members?: string[]}} */
        let sel = { name: null, tag: null, label: partLabel(kind), tokens: part?.tokens ?? null };
        const itemOfKey = () => (part?.items ?? []).find(x => iidOf(kind, x) === key) ?? null;
        if (scope === 'item' && parsed !== null) {
          const it = itemOfKey();
          sel = { name: parsed.name, tag: parsed.tag,
            label: it !== null ? itemLabel(it) : parsed.name, tokens: it?.tokens ?? null };
        } else if (scope === 'rest' || scope === 'category') {
          // 集合块与整类：目录按类别范围取，成员身份只在弹窗里标注。
          const its = (ctxSource.getAttribute('data-ctx-its') ?? '').split('\u0002').filter(s => s !== '');
          sel = { name: null, tag: null,
            label: ctxSource.querySelector('.ctx-tname')?.textContent ?? partLabel(kind),
            tokens: part?.tokens ?? null, ...(its.length > 0 ? { members: its } : {}) };
        } else if (ctxSource.classList.contains('ctx-row') && parsed !== null) {
          const it = itemOfKey();
          sel = { name: parsed.name, tag: parsed.tag,
            label: it !== null ? itemLabel(it) : parsed.name, tokens: it?.tokens ?? null };
        }
        contextMenu.openDetail({
          reqId, kind, name: sel.name, tag: sel.tag, label: sel.label,
          tokens: sel.tokens, token,
          ...(sel.members !== undefined ? { members: sel.members } : {}),
        }, ctxSource);
      }
      return;
    }
    // 会话 ID 复制钮在会话头 facts 行里，随重绘重建，走委托。
    if (t.closest('#copy-session')) { void copySessionId(); return; }
    // 收起行里的失败数在 <summary> 内：先于 summary 早退处理，阻止折叠开合，
    // 直接打开失败调用列表（集合随汇总首屏返回，不用再查）。
    const failuresBtn = /** @type {HTMLElement | null} */ (t.closest('[data-summary-failures]'));
    if (failuresBtn !== null) {
      e.preventDefault();
      const summary = store.peekSummary();
      const failures = summary !== null && summary.status === 'ready' && summary.data !== null
        ? summary.data.failures : [];
      summaryList = {
        kind: 'failures', param: '', label: `失败调用 · ${failures.length}`,
        loading: false, error: null,
        data: { items: failures.map(f => ({ ...f, state: 'resolved' })), truncated: false },
      };
      openRail();
      renderRail();
      return;
    }
    if (t.closest('summary')) return;
    // 组级「已更新」标记：点进组里即视为已看到，随后的选择处理照常重绘。
    const flaggedGroup = /** @type {HTMLElement | null} */ (t.closest('.trace-group'));
    if (flaggedGroup !== null) {
      const flaggedId = Number(flaggedGroup.dataset.req);
      if (store.peekRequest(flaggedId)?.updatedSinceSeen === true) {
        store.clearUpdated(flaggedId);
        renderMain();
      }
    }
    if (t.closest('#load-earlier')) { void loadEarlier(); return; }
    if (t.closest('#refresh-window')) { void refreshWindow(); return; }
    if (t.closest('#jump-latest')) { void jumpLatest(); return; }
    // 轮次带点选：轮次行随意图带入，转换层不做查找。
    const turnChip = /** @type {HTMLElement | null} */ (t.closest('[data-turn]'));
    if (turnChip !== null) {
      const turn = turnOf(Number(turnChip.dataset.turn));
      if (turn !== null) dispatch({ kind: 'select-turn', row: turn });
      return;
    }
    const structureMore = /** @type {HTMLElement | null} */ (t.closest('[data-structure-more]'));
    if (structureMore !== null) { void loadStructure(Number(structureMore.dataset.structureMore)); return; }
    const deltaMore = /** @type {HTMLElement | null} */ (t.closest('[data-delta-more]'));
    if (deltaMore !== null) { void resumeDelta(Number(deltaMore.dataset.deltaMore)); return; }
    const structureBack = /** @type {HTMLElement | null} */ (t.closest('[data-structure-back]'));
    if (structureBack !== null) {
      if (structureSelected.delete(Number(structureBack.dataset.structureBack))) renderRail();
      return;
    }
    // 会话汇总折叠区的条目点击：先开右栏条目列表，逐项跳配对页或定位请求。
    const summaryTool = /** @type {HTMLElement | null} */ (t.closest('[data-summary-tool]'));
    if (summaryTool !== null) {
      const name = summaryTool.dataset.summaryTool ?? '';
      void openSummaryList({ kind: 'tool', name }, `${name} 的调用`);
      return;
    }
    const summaryPath = /** @type {HTMLElement | null} */ (t.closest('[data-summary-path]'));
    if (summaryPath !== null) {
      const path = summaryPath.dataset.summaryPath ?? '';
      const side = summaryPath.dataset.summarySide === 'r' ? 'read' : 'written';
      void openSummaryList({ kind: side, path }, `${side === 'read' ? '读取请求' : '写入尝试'} · ${path.split('/').pop() ?? path}`);
      return;
    }
    const summarySkill = /** @type {HTMLElement | null} */ (t.closest('[data-summary-skill]'));
    if (summarySkill !== null) {
      const name = summarySkill.dataset.summarySkill ?? '';
      void openSummaryList({ kind: 'skill', name }, `Skill ${name}`);
      return;
    }
    if (t.closest('[data-summary-back]') !== null) { summaryList = null; renderRail(); return; }
    const summaryPair = /** @type {HTMLElement | null} */ (t.closest('[data-summary-pair]'));
    if (summaryPair !== null) {
      summaryList = null;
      dispatch({
        kind: 'open-pair',
        owner: Number(summaryPair.dataset.owner),
        callOrd: Number(summaryPair.dataset.ord),
      });
      return;
    }
    const summaryReq = /** @type {HTMLElement | null} */ (t.closest('[data-summary-req]'));
    if (summaryReq !== null) {
      summaryList = null;
      const id = Number(summaryReq.dataset.summaryReq);
      const inWindow = currentRows().some(row => row.req_id === id);
      dispatch(inWindow ? { kind: 'locate', reqId: id } : { kind: 'open-offpage', reqId: id });
      return;
    }
    const bodyLoad = /** @type {HTMLElement | null} */ (t.closest('[data-body-load]'));
    if (bodyLoad !== null) { void ensureRead(Number(bodyLoad.dataset.bodyLoad)); return; }
    // 工具四页导航：所有身份都只用 owner/callOrd；选中同步到调用步骤，中栏高亮一致。
    const toolSelect = /** @type {HTMLElement | null} */ (t.closest('[data-tool-select]'));
    if (toolSelect !== null) {
      if (state.reqId !== null) {
        dispatch({ kind: 'open-tool', reqId: state.reqId, callOrd: Number(toolSelect.dataset.toolSelect) });
      }
      return;
    }
    if (t.closest('[data-tool-back]') !== null) {
      dispatch({ kind: 'close-tool', andTab: false });
      return;
    }
    const toolPageBtn = /** @type {HTMLElement | null} */ (t.closest('[data-tool-page]'));
    if (toolPageBtn !== null) { dispatch({ kind: 'select-tool-page', page: toolPageBtn.dataset.toolPage ?? 'pair' }); return; }
    // 工具往返行的配对入口：在右栏打开配对页就地阅读，不跳转中栏选择。
    const toolOwnerBtn = /** @type {HTMLElement | null} */ (t.closest('[data-tool-owner]'));
    if (toolOwnerBtn !== null) {
      dispatch({ kind: 'open-pair', owner: Number(toolOwnerBtn.dataset.toolOwner), callOrd: Number(toolOwnerBtn.dataset.callOrd) });
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
    if (railReply !== null) { dispatch({ kind: 'clear-step' }); return; }
    const copyMsg = /** @type {HTMLElement | null} */ (t.closest('[data-copy-msg]'));
    if (copyMsg !== null) {
      const ord = Number(copyMsg.dataset.copyMsg);
      // 轮次态的命令面板带 owner：复制走起点请求的读取，不用当前选中请求。
      const owner = copyMsg.dataset.copyOwner !== undefined ? Number(copyMsg.dataset.copyOwner) : state.reqId;
      const read = owner === null ? null : store.peekRequest(owner);
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
          dispatch({ kind: 'select-message', reqId, stepKey: `${reqId}:message:${msg.dataset.msg}`, bodyTab: false });
        }
        return;
      }
      const group = msg.closest('.trace-group');
      const id = group !== null ? Number(/** @type {HTMLElement} */ (group).dataset.req) : state.reqId;
      if (id !== null && Number.isFinite(id)) {
        dispatch({ kind: 'select-message', reqId: id, stepKey: `${id}:message:${msg.dataset.msg}`, bodyTab: true });
      }
      return;
    }
    const sess = /** @type {HTMLElement | null} */ (t.closest('[data-session]'));
    if (sess) { void selectSession(sess.dataset.session ?? ''); return; }
    if (t.closest('[data-bypass-toggle]')) {
      state.showBypass = !state.showBypass;
      renderSessions();
      return;
    }
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
      // 页签点击是明确的阅读动作：路由读取经转换统一发出，失败保留未读可重试。
      dispatch({ kind: 'select-tab', tab: String(rail.dataset.rail ?? '') });
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
    dispatch({ kind: 'select-message', reqId, stepKey: `${reqId}:message:${target.value}`, bodyTab: false });
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
  }, true);

  // treemap tile 与内容列表行双向高亮：tile 的 data-ctx-its 列出它代表的 item 身份（iid），
  // 行的 data-ctx-key 就是 iid；悬停一方，另一方按成员关系点亮。读数页重绘重建节点，
  // 监听留在文档级；pointerover 在进入任何非联动元素时清掉旧高亮。
  /** @type {Element | null} */
  let ctxLit = null;
  const unlitCtx = () => {
    for (const el of document.querySelectorAll('.ctx-hl')) el.classList.remove('ctx-hl');
    ctxLit = null;
  };
  document.addEventListener('pointerover', (e) => {
    if (!(e.target instanceof Element)) return;
    const t = /** @type {HTMLElement | null} */ (e.target.closest('[data-ctx-key]'));
    if (t === ctxLit) return;
    unlitCtx();
    if (t === null) return;
    ctxLit = t;
    const key = t.getAttribute('data-ctx-key') ?? '';
    const its = (t.getAttribute('data-ctx-its') ?? '').split('\u0002').filter(s => s !== '');
    t.classList.add('ctx-hl');
    for (const el of document.querySelectorAll('[data-ctx-key]')) {
      if (el === t) continue;
      if (el.classList.contains('ctx-row')) {
        // 行被点亮：悬停的是 tile，且 tile 的成员身份里有这一行。
        if (its.includes(el.getAttribute('data-ctx-key') ?? '')) el.classList.add('ctx-hl');
      } else if ((el.getAttribute('data-ctx-its') ?? '').split('\u0002').includes(key)) {
        // tile 被点亮：悬停的是行，且该 tile 的成员身份里有这个 item。
        el.classList.add('ctx-hl');
      }
    }
  });
  document.addEventListener('pointerout', (e) => {
    if (ctxLit === null) return;
    const to = e.relatedTarget;
    if (to instanceof Element && to.closest('[data-ctx-key]') !== null) return;
    unlitCtx();
  });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('input, textarea, summary')) return;
    if (e.key === 'Escape') {
      // 明细弹窗先于一切页面内退出：它是覆盖层，Esc 语义最直接。
      if (contextMenu.isOpen()) { contextMenu.close(); return; }
      // 条目列表先于工具页退出：它是从折叠区临时打开的会话级视图。
      if (summaryList !== null) { summaryList = null; renderRail(); return; }
      dispatch({ kind: 'close-tool', andTab: true });
    }
  });

  // 品牌回主页即整页重载：落地到无参数初始态（重读会话列表、选最新会话），
  // 比在页面里重置全部选择字段与在途导航更直接，「刷新」语义也是字面义。
  el('brand-home').addEventListener('click', () => { location.href = location.pathname; });

  // 视口宽度变化会改变会话头的换行高度：吸顶的轮次带跟着重贴。
  window.addEventListener('resize', syncBandTop);

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
  // 按钮随会话头重绘重建：点击走文档级委托，不在启动时绑死元素。

  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const trace = p.get('trace');
    dispatch({
      kind: 'restore-url', session: p.get('session'),
      trace: trace ? Number(trace) : null, tab: railTabFromParam(p.get('tab')),
    });
    if (state.session !== null) void selectSession(state.session, state.reqId);
  });

  initLayout();
  void (async () => {
    try {
      await store.loadSessions();
    } catch (error) {
      el('sessions-list').innerHTML = `<p class="sess-empty">会话列表加载失败:${esc(error instanceof Error ? error.message : 'unknown')}</p>`;
      return;
    }
    if (state.session === null) {
      const first = /** @type {SessionRow | undefined} */ (store.getSessions().items[0]);
      if (first) dispatch({ kind: 'open-session', sessionKey: first.conv_key, wantedTrace: null });
    }
    if (state.session !== null) await selectSession(state.session, qp.get('trace') !== null ? Number(qp.get('trace')) : null);
    else renderAll();
  })();
}
