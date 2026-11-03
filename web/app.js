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
  roleTag,
} from './body-view.js';
import {
  deltaOrdinals, messageCopyText, messagePairIndexOf, messagePathOf, replyView, toolEntries,
} from './body-model.js';
import { agentLogoHtml, setAgentLogoFetcher } from './agent-logos.js';
import { backendStateHtml } from './backend-state.js';
import { esc } from './html.js';
import { icon } from './icons.js';
import { partLabel } from './parts.js';
import { createReaderStore } from './reader-store.js';
import { createHttpReadTransport } from './read-http.js';
import { initLayout, openRail } from './layout.js';
import { fillContextMap, iidOf, itemLabel } from './context-map.js';
import { createContextMenu, iidParse } from './context-detail.js';
import {
  evidenceFoldHtml, kk, ledgerRowsHtml, railFactsHtml, readingChangedNote, renderAttemptChain,
  resolveSelectedSource, structureFoldHtml, structureMoreParts, structureUnread, systemContextOf, toolOverviewHtml,
  toolSchemaSection, usageFoldHtml,
} from './rail-facts.js';
import { compact, EXEC_MS_HINT, secs } from './duration.js';
import { summaryParts } from './tool-summary.js';
import { bodyLabelText, bodyStateText, replyCompleteness } from './row-summary.js';
import {
  agentLabel, clock, createLivePartition, dayTime, liveTimeCell,
  railSummaryListHtml as railSummaryListView,
  sessionHead as sessionHeadView,
  sessionsGroupLabel, sessionsListFoldHtml,
} from './session-view.js';
import { applyIntent } from './selection.js';
import { createMainView } from './trace-dom.js';
import { createTracePreparation } from './trace-preparation.js';
import { createTraceModel } from './trace-model.js';
import { renderTracePair } from './trace-pair.js';
import { isEmptyGroup, projectSteps, projectTailReply, renderTraceRow } from './trace-view.js';
import { renderTurnBand, renderTurnRail, renderTurnRailHead } from './turn-band.js';
import { demoFromParam, expandFromParam, railTabFromParam, railTabParam, resolveTraceTarget, summaryKindFromParam, traceIdFromParam } from './url-route.js';

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

/* ---------------- 空状态插画：B1 吊丝蜘蛛 ---------------- */

/**
 * 空状态里的 B1 蜘蛛。几何来自重绘稿 `rail-fix/spider-rail.svg`（画布 261×424，剪影 IoU 0.958）；
 * 画布左移 -20.95 只为给 ±2° 摆动留边（θ=-2° 右侧越界 8.1px、θ=+2° 左侧越界 5.1px），几何点未动。
 * 只保留一份几何：动效版由 `spiderInner(true)` 在静态版骨架上补回 animateTransform，
 * 静态版（reduced-motion）走 `spiderInner(false)`，不靠冻住动效副本。
 *
 * 动效沿用重绘稿：钟摆 ±2°/3s（丝滞后 241ms、珠 182ms，靠 beginElementAt 的负偏移还原）、
 * 呼吸 3.02%/4.5s、眨眼每 9s 一次。全部 `begin="indefinite"`，未启动时渲染的是完整静态首帧，
 * 由 armSpider 在空状态持续 500ms 后统一启动。
 *
 * 颜色全部走主题变量（身体 --spider-body、眼 --spider-accent、丝 --spider-thread），
 * 重绘稿里的局部 <style> 色值已删除；没有腮红与瞳内高光，也没有背景。
 */
/** 身体剪影路径（原始坐标，与重绘稿逐点一致；viewBox 只平移了左边界，点未缩放）。 */
const SPIDER_BODY_PATH = 'M116 193Q121 192 127 195Q132 198 136 203Q140 207 143 211Q145 217 148 222Q152 226 156 229Q160 233 163 238Q166 243 169 248Q171 253 172 258Q174 264 174 270Q174 276 172 281Q171 286 169 291Q166 296 164 301Q165 308 169 310Q172 308 177 303Q182 301 188 301Q194 301 199 303Q204 306 206 311Q206 317 202 321Q198 324 192 324Q186 322 181 321Q178 324 179 329Q181 331 187 332Q192 333 198 334Q203 336 207 339Q211 344 212 349Q211 355 206 358Q201 360 195 358Q190 355 186 352Q182 352 180 355Q180 358 183 363Q187 366 192 370Q195 374 196 380Q197 386 196 391Q194 397 189 399Q184 400 179 397Q175 393 174 387Q174 379 174 376Q171 378 165 384Q161 387 156 390Q151 393 146 395Q141 397 136 399Q131 401 125 402Q120 403 114 404Q108 404 102 404Q96 404 90 404Q84 403 79 402Q73 401 68 400Q62 398 58 396Q54 395 53 398Q54 402 54 409Q52 415 48 419Q42 422 37 419Q34 415 33 409Q32 404 34 398Q36 393 39 388Q42 384 42 380Q40 375 35 374Q33 377 30 383Q26 388 20 389Q14 390 10 386Q8 381 9 375Q11 370 15 366Q20 362 25 360Q31 359 35 356Q38 350 37 345Q34 345 28 348Q23 351 18 352Q12 352 9 348Q6 343 7 337Q10 332 15 329Q20 326 25 326Q31 326 36 327Q41 328 45 326Q50 322 50 317Q48 312 43 308Q39 304 36 299Q33 294 32 289Q30 283 30 277Q30 271 31 266Q33 260 35 255Q37 250 39 245Q41 240 43 235Q45 230 47 225Q49 220 52 215Q55 210 59 207Q65 204 70 204Q73 207 74 212Q75 215 77 218Q81 222 82 227Q80 232 75 236Q70 239 65 241Q60 244 57 248Q54 252 53 258Q51 263 49 269Q48 274 48 280Q49 286 52 291Q55 298 59 300Q63 300 68 295Q72 291 77 288Q81 286 86 284Q91 282 97 280Q102 278 108 278Q114 278 119 279Q125 280 130 282Q135 284 140 287Q146 291 150 292Q154 290 155 284Q156 279 156 273Q156 267 155 261Q154 256 151 251Q149 246 145 242Q141 237 136 233Q132 230 127 228Q121 227 116 225Q110 222 109 217Q112 214 115 210Q113 206 111 201Q112 196 116 193Z';

/**
 * @param {boolean} animated 动效版补回 animateTransform；静态版保持同一骨架
 * @returns {string}
 */
function spiderInner(animated) {
  const swing = 'attributeName="transform" type="rotate" values="-2 93.5 0;2 93.5 0;-2 93.5 0"'
    + ' keyTimes="0;.5;1" keySplines=".42 0 .58 1;.42 0 .58 1" calcMode="spline" dur="3s"'
    + ' begin="indefinite" repeatCount="indefinite"';
  return '<g class="atc-spider">'
    + '<g class="atc-body">'
    + (animated ? `<animateTransform ${swing}/>` : '')
    + '<g transform="translate(109 340)"><g>'
    + (animated
      ? '<animateTransform attributeName="transform" type="scale" values="1 1;1.012 1.03;1 1"'
        + ' keyTimes="0;.5;1" keySplines=".42 0 .58 1;.42 0 .58 1" calcMode="spline" dur="4.5s"'
        + ' begin="indefinite" repeatCount="indefinite"/>'
      : '')
    + '<g transform="translate(-109 -340)">'
    + `<path fill="var(--spider-body)" d="${SPIDER_BODY_PATH}"/>`
    + '<g transform="translate(108 353)"><g class="atc-eyes">'
    + (animated
      ? '<animateTransform attributeName="transform" type="scale" values="1 1;1 .1;1 1"'
        + ' keyTimes="0;.7;.722" calcMode="discrete" dur="9s" begin="indefinite" repeatCount="indefinite"/>'
      : '')
    + '<g transform="translate(-108 -353)">'
    + '<ellipse cx="93.9" cy="355.7" rx="7.5" ry="7.5" fill="var(--spider-accent)"/>'
    + '<ellipse cx="123" cy="351" rx="7.5" ry="7.5" fill="var(--spider-accent)"/>'
    + '</g></g></g>'
    + '<path fill="none" stroke="var(--spider-accent)" stroke-width="3" stroke-linecap="round"'
    + ' d="M102.8 368.3 Q111.8 373 116.3 366.4"/>'
    + '</g></g></g></g>'
    + '<g class="atc-silk">'
    + (animated ? `<animateTransform ${swing} data-lag="-2.76"/>` : '')
    + '<line x1="93.5" y1="0" x2="94" y2="214" stroke="var(--spider-thread)" stroke-width="12" stroke-linecap="round"/>'
    + '</g>'
    + '<g class="atc-bead">'
    + (animated ? `<animateTransform ${swing} data-lag="-2.82"/>` : '')
    + '<ellipse cx="94.5" cy="214" rx="19.5" ry="18" fill="var(--spider-thread)"/>'
    + '</g></g>';
}

const reducedMotion = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {number} size 渲染边长（属性初值；实际尺寸由 CSS 决定，窄容器会降级）
 * @returns {string}
 */
function spiderArt(size) {
  const animated = reducedMotion === null || !reducedMotion.matches;
  return `<svg class="spider-art" width="${size}" height="${size}" viewBox="-20.9528 0 261 424"`
    + ` preserveAspectRatio="xMidYMid meet" data-motion="${animated ? 'idle' : 'static'}"`
    + ' aria-hidden="true" focusable="false">'
    + spiderInner(animated)
    + '</svg>';
}

/** 空状态插画不抢首屏：节点自己出现满 500ms 才启动 SMIL；后续重绘不重置这个计时。 */
let spiderTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
/** @type {WeakMap<SVGSVGElement, number>} */
const spiderArmedAt = new WeakMap();

/** @param {SVGSVGElement} art */
function startSpider(art) {
  for (const node of art.querySelectorAll('animate, animateTransform')) {
    const animation = /** @type {SVGAnimationElement} */ (node);
    // 丝与珠比身体慢 241ms / 182ms：负偏移把 start 点推回过去，还原重绘稿的相位差。
    const lag = Number(animation.dataset.lag ?? 0);
    animation.beginElementAt(lag < 0 ? lag : 0);
  }
  art.dataset.motion = 'running';
}

/**
 * 0.35s 淡入：隔一帧再加 `is-in`，让首帧的 opacity:0 先落一次，过渡才有起点。
 * @param {SVGSVGElement} art
 */
function fadeInSpider(art) {
  if (typeof requestAnimationFrame !== 'function') { art.classList.add('is-in'); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => art.classList.add('is-in')));
}

function armSpider() {
  const idle = [...document.querySelectorAll('.spider-art[data-motion="idle"]')]
    .map(node => /** @type {SVGSVGElement} */ (node));
  if (idle.length === 0) {
    if (spiderTimer !== null) { clearTimeout(spiderTimer); spiderTimer = null; }
    return;
  }
  if (reducedMotion !== null && reducedMotion.matches) {
    for (const art of idle) art.dataset.motion = 'static';
    if (spiderTimer !== null) { clearTimeout(spiderTimer); spiderTimer = null; }
    return;
  }
  const now = performance.now();
  for (const art of idle) {
    if (!spiderArmedAt.has(art)) {
      spiderArmedAt.set(art, now);
      fadeInSpider(art);
    }
    // 计时期间被选中：节点离开文档，计时随 WeakMap 一起失效，不必显式清理。
    if (now - (spiderArmedAt.get(art) ?? now) >= 500) {
      startSpider(art);
      spiderArmedAt.delete(art);
    }
  }
  const waiting = idle.filter(art => art.dataset.motion === 'idle');
  if (waiting.length === 0) {
    if (spiderTimer !== null) { clearTimeout(spiderTimer); spiderTimer = null; }
    return;
  }
  if (spiderTimer !== null) return;
  const due = Math.min(...waiting.map(art => (spiderArmedAt.get(art) ?? now) + 500 - now));
  spiderTimer = setTimeout(() => { spiderTimer = null; armSpider(); }, Math.max(0, due));
}

reducedMotion?.addEventListener('change', () => {
  if (reducedMotion === null || !reducedMotion.matches) return;
  // 中途切到 reduce：直接换成品，不用 animation:none 去冻一个带动效的副本。
  for (const node of document.querySelectorAll('.spider-art')) {
    const art = /** @type {SVGSVGElement} */ (node);
    const size = Number(art.getAttribute('width')) || 160;
    const host = document.createElement('template');
    host.innerHTML = spiderArt(size);
    const next = /** @type {SVGSVGElement} */ (host.content.firstElementChild);
    art.replaceWith(next);
  }
});


if (typeof document !== 'undefined') {
  // store 是唯一的读取缓存：页面同步渲染经 peek* 消费，副本不作第二份真相。
  // 读取经具名契约的 HTTP adapter 走 store 内部调度；store 是唯一可 Fetch 的读取方。
  // 同一 fetcher 交给 logo 懒加载，装配点以外不接触全局 fetch。
  const fetcher = fetch;
  setAgentLogoFetcher(fetcher);
  const store = createReaderStore(createHttpReadTransport({ fetcher }),
    // 记录快照异步变化（409 作废、自动重读换新或失败）按影响面响应；迟到响应不进来。
    (/** @type {number} */ id) => { onStoreChange(id); },
    // 轮次快照与会话汇总落地（出现/消失、折叠区就绪）同样重绘两栏。
    { onTurnsChanged: () => { consumePendingTurn(); renderMain(); renderRail(); },
      onSummaryChanged: () => { consumePendingSummary(); renderMain(); renderRail(); } });
  /** @type {Map<string, boolean>} 折叠开合按稳定键保存（键含 req id），重绘后恢复。 */
  const folds = new Map();
  /** @type {Map<number, number>} 结构折叠内选中的消息 ord 按 req id 保存：UI 选择留在页面，不进 store。 */
  const structureSelected = new Map();
  /**
   * 中栏点中的结构消息：右栏下一次渲染把列表滚到这一条，让「打开所在结构」
   * 落在消息本身而不是列表末尾。行还没进列表（读取中）时保留，换请求即作废。
   * @type {{reqId: number, ord: number} | null}
   */
  let structureReveal = null;
  /**
   * 依赖感知显示模型：组与尾组投影按内容修订与依赖边重算，读取无变化时
   * 重用上一次的对象；三态（当前/保留/占位）与末尾组资格都在 model 内。
   * changedReads 收集本轮 contentRevision 变化的组，渲染时一次喂给 model。
   */
  const changedReads = new Set();
  const traceModel = createTraceModel({
    project: (r, read) => projectSteps(r, read, systemContextOf(r, id => store.peekRequest(id)),
      store.peekBgJobs().items, prevInfoOf),
    projectTail: (r, read) => projectTailReply(r, read),
    preparing: preparingStep,
  });
  /**
   * 上下文明细弹窗：tile、图例与列表行共用的选择动作。读取经注入的具名操作
   * facade 走 store 的统一调度，代次捕获在模块内，晚到响应不进已切换的弹窗，
   * 关闭即取消在途读取。
   */
  const contextMenu = createContextMenu({
    readDirectory: (selection, cursor, signal) => store.readContextItem(
      selection.reqId,
      { kind: selection.kind, name: selection.name, tag: selection.tag, cursor: cursor ?? null },
      selection.token, signal),
    readEntry: (target, signal) => store.readContextBody(target, signal),
  });
  /** @type {{kind: string, param: string, label: string, loading: boolean, error: string | null, data: import('../src/queries/session-summary').SummaryEntries | null} | null} 会话汇总条目列表：点开条目后右栏的支撑记录清单。 */
  let summaryList = null;
  /** 中栏键控提交：节点身份、选择高亮与滚动锚点都在视图内维护，装配层只给模型。 */
  const mainView = createMainView(el('main'));

  const qp = new URLSearchParams(location.search);
  // 拍摄直达参数：demo 静默、cue-board 展开、summary 组清单与轮锚点都只消费一次；
  // trace 与 turn 同时给出时 trace 优先，turn 不再改写选中请求。
  const demoMode = demoFromParam(qp.get('demo'));
  const expandSummary = expandFromParam(qp.get('expand')) === 'summary';
  let pendingSummaryKind = summaryKindFromParam(qp.get('summary'));
  let pendingTurn = qp.get('trace') === null ? traceIdFromParam(qp.get('turn')) : null;
  if (demoMode) store.setDemoSilent(true);
  const state = {
    session: qp.get('session'),
    reqId: traceIdFromParam(qp.get('trace')),
    /** URL 指定的请求在库里不存在。 */
    missingReqId: /** @type {number | null} */ (null),
    /** URL 指定的请求存在，但落在当前载入窗口之外。 */
    offPageReqId: /** @type {number | null} */ (null),
    /**
     * 当前窗口锚点：start 从会话最早一页起载入（默认阅读方向），latest 取
     * 最新一页（「回到最新」的追尾模式）。刷新按当前锚点重建，换会话复位。
     */
    windowAnchor: /** @type {'start' | 'latest'} */ ('start'),
    /** 窗口切换在跑：按钮落禁用态，避免重复点击把自己排成两轮重建。 */
    windowJumping: false,
    /** 选中的轮次（会话内已结算轮序号）；null 表示请求态。 */
    turn: /** @type {number | null} */ (null),
    selectedStep: /** @type {string | null} */ (null),
    toolOrd: /** @type {number | null} */ (null),
    /** 配对页描述的调用属于哪笔请求：从结果步骤进入时可能与当前请求不同；null 表示当前请求。 */
    toolOwner: /** @type {number | null} */ (null),
    /** 工具详情四页的当前页：overview / params / pair / schema。 */
    toolPage: 'pair',
    /** 探针记录与旁路会话折叠的展开开关：折叠是默认态，展开只影响渲染不改任何派生。 */
    showFolded: false,
    railTab: railTabFromParam(qp.get('tab')),
    query: '',
    agent: 'all',
    pendingSession: /** @type {string | null} */ (null),
    /** 最近一次显式刷新时间；刷新会按当前锚点重建窗口并清掉旧阅读版本。 */
    refreshedAt: /** @type {number | null} */ (null),
    /** 首载窗口是否已准备完成：完成后提交不再以选中组为锚，加载后续不重复居中。 */
    revealed: false,
  };
  /** 导航代次与用户选择代次分别守卫异步导航的收尾。 */
  let navEpoch = 0;
  let selectionEpoch = 0;
  const preparation = createTracePreparation(store, (ids, dependencies) => {
    for (const id of ids) {
      if (state.selectedStep === `${id}:preparing`) dispatch({ kind: 'clear-step' });
    }
    // 一准备块一次重绘：批量落地的组在下一个微任务合并提交。
    scheduleRenderMain();
    if (dependencies.some(affectsRail) || ids.some(affectsRail)) renderRail();
  });

  /* ---------------- 选择状态：唯一写者与效果执行器 ---------------- */
  const SELECTION_KEYS = ['session', 'reqId', 'selectedStep', 'toolOrd', 'toolOwner', 'toolPage', 'railTab', 'missingReqId', 'offPageReqId', 'turn'];
  /**
   * 发意图经纯转换改写选择元组并执行效果：所有选择写入都走这里，
   * 渲染函数不再改 state；规则与效果清单在 selection.js。
   * @param {import('./selection.js').Intent} intent
   */
  function dispatch(intent) {
    if (intent.kind === 'select-step' || intent.kind === 'select-message' || intent.kind === 'select-delta'
      || intent.kind === 'select-turn' || intent.kind === 'select-tab' || intent.kind === 'select-tool-page'
      || intent.kind === 'open-tool' || intent.kind === 'open-pair' || intent.kind === 'open-offpage'
      || intent.kind === 'close-tool' || intent.kind === 'locate') selectionEpoch += 1;
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
        case 'scroll-group': {
          const nav = navEpoch, selection = selectionEpoch;
          const viewport = scroller(), top = viewport.scrollTop;
          requestAnimationFrame(() => {
            if (nav !== navEpoch || selection !== selectionEpoch || viewport !== scroller() || viewport.scrollTop !== top) return;
            // 同号可能相邻出现末尾回复组，按组键定位承载组。
            document.querySelector(`.trace-group[data-group-key="req:${CSS.escape(String(fx.reqId))}"]`)
              ?.scrollIntoView({ block: 'center', behavior: state.revealed && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
          });
          break;
        }
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
   * 请求序号是当前载入窗口内的正序位置：窗口只向尾部追加（加载后续记录），
   * 已载入行的序号不变；内部身份、跳转与缓存键都用 req_id，不用数字。
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
  /**
   * 窗口里第一笔或最后一笔有内容的请求：默认锚点与「回到开头/最新」跳过空组。
   * 准备未完成时判不出空组，会先落在首行，备齐后由 settleAnchor 再挪。
   * @param {'first' | 'last'} side
   */
  function contentAnchorId(side) {
    const rows = currentRows();
    const ordered = side === 'first' ? rows : [...rows].reverse();
    return ordered.find(row => !isEmptyGroup(stepsOf(row)))?.req_id ?? null;
  }
  /**
   * 锚点落在空组上时，等准备完成再挪到有内容的一笔：默认选中发生在准备之前。
   * 读者中途换了选择或点了步骤就不动。
   * @param {number | null} anchor 锚点意图实际写入的请求
   */
  function settleAnchor(anchor) {
    if (anchor === null || state.reqId !== anchor || state.selectedStep !== null) return;
    const row = currentRows().find(item => item.req_id === anchor);
    if (row === undefined || !isEmptyGroup(stepsOf(row))) return;
    const visible = contentAnchorId(state.windowAnchor === 'latest' ? 'last' : 'first');
    if (state.windowAnchor === 'latest') dispatch({ kind: 'select-latest', latestReqId: visible });
    else dispatch({ kind: 'select-first', firstReqId: visible });
    // 锚点意图本身不渲染（调用方原本在同步流程里补），异步挪动要自己补一次。
    renderAll();
    dispatch({ kind: 'nav-settled' });
    ensureSelectedVisible();
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

  /* ---------------- 窗口准备：先备齐再提交 ---------------- */

  /** 窗口内请求：只有窗口内的组参与准备与提交。 @param {number} id */
  function inWindow(id) {
    return currentRows().some(row => row.req_id === id);
  }

  /**
   * 准备中的组先示一条记录行：证据未齐不画半份投影，本组在窗口中的位置由它占住。
   * 行高与正常步骤一致，备齐替换时组顶不移位。
   * @param {RequestRow} r
   * @returns {import('./trace-view.js').TraceStep}
   */
  function preparingStep(r) {
    return {
      key: `${r.req_id}:preparing`, reqId: r.req_id, kind: 'record', text: '正在读取请求…',
      messageOrd: null, callOrd: null, source: null, raw: null, unrecognized: false,
      status: r.status !== null && r.status >= 400 ? 'failed'
        : r.body_state !== 'available' && r.body_state !== 'partial' ? 'missing_body' : null,
      result: null, pairOwner: null,
    };
  }

  /** 首载目标先准备；其他组按窗口顺序批量准备。 */
  async function prepareWindow() {
    if (await preparation.prepareWindow(state.revealed ? null : state.reqId)) state.revealed = true;
  }

  /** 换会话与显式刷新清空准备结论、保留投影与末尾回复缓存。 */
  function resetReading() {
    preparation.reset();
    traceModel.reset();
    changedReads.clear();
  }

  /**
   * 一笔读取落地是否影响右栏：当前请求、工具配对调用方、选中轮次两端与当前请求的
   * 已确认前驱之外的组，准备完成只提交中栏，右栏不随批次重建。前驱参与读数页的
   * 消息配对入口，换版后必须重绘，不能拿旧前驱的调用表继续给入口。
   * @param {number} id
   */
  function affectsRail(id) {
    if (id === state.reqId || id === state.toolOwner) return true;
    const detail = currentRead()?.detail ?? null;
    if (detail !== null && detail.prev_relation === 'confirmed' && id === detail.prev_req_id) return true;
    if (state.turn !== null) {
      const turn = turnOf(state.turn);
      if (turn !== null && (id === turn.start_req || id === turn.reply_req)) return true;
    }
    return false;
  }

  /**
   * 记录快照异步变化（作废、自动重读换新或失败）的页面响应：作废撤下提交资格，
   * 组回到保留投影；自动重读把详情换新后在窗口内接着备齐，已提交的组不自动扩量。
   * @param {number} id
   */
  /** 读落地的刷新合并：同一 tick 内多笔读取只排一次微任务重绘；锚点捕获
   *  与补偿仍在一次同步 commit 内完成，不跨帧。选择走 dispatch 的同步路径。 */
  let renderQueued = false;
  function scheduleRenderMain() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderMain();
    });
  }

  /** @param {number} id */
  function onStoreChange(id) {
    const read = store.peekRequest(id);
    changedReads.add(id);
    if (read !== null && read.detail !== null) {
      if (!preparation.has(id) && inWindow(id)) void preparation.prepare(id);
    } else {
      preparation.forget(id);
    }
    scheduleRenderMain();
    if (affectsRail(id)) renderRail();
  }

  /* ---------------- 顶栏与左栏 ---------------- */
  function renderCrumb() {
    const row = state.session === null ? null : sessionRow(state.session);
    const idx = ordinalOf(state.reqId ?? -1);
    const here = state.missingReqId !== null ? `Request ${state.missingReqId} 未找到`
      : state.offPageReqId !== null ? `Request ${state.offPageReqId} 未在当前窗口`
        : idx > 0 ? `Request ${String(idx).padStart(2, '0')}` : '';
    // 面包屑先给请求位置，再跟会话标题；长标题只截断自己，不挤掉「我在哪」。
    el('crumb').innerHTML = row === null ? (here === '' ? '' : `<b>${esc(here)}</b>`)
      : `${here === '' ? '' : `<b>${esc(here)}</b><span class="sep">·</span>`}<span class="crumb-title">${esc(row.title)}</span>`;
    document.title = row ? `${here === '' ? row.title : `${here} · ${row.title}`} — Tracery`
      : 'Tracery';
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

  /** 分区状态跨渲染保留：保留期与「上一帧因最近活跃进区」的集合都在这里。 */
  const livePartition = createLivePartition();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let liveExpiryTimer = null;
  let liveExpiryAt = Infinity;

  /**
   * 活跃集合变化时不轮询：只在下一个沉降提交点重排一次。
   * 提交点由 liveCommitAt 给出（过期 + 保留期，再对齐到整 30 秒），主线程只做
   * 一次 O(可见行) 的过滤。
   * @param {number | null} next @param {number} now
   */
  function scheduleLiveSettle(next, now) {
    if (next === liveExpiryAt) return;
    if (liveExpiryTimer !== null) clearTimeout(liveExpiryTimer);
    liveExpiryTimer = null;
    liveExpiryAt = next ?? Infinity;
    if (next === null) return;
    liveExpiryTimer = setTimeout(() => {
      liveExpiryTimer = null;
      liveExpiryAt = Infinity;
      const list = el('sessions-list');
      const top = list.scrollTop;
      const active = document.activeElement;
      const focusedKey = active && typeof active.closest === 'function'
        ? (active.closest('[data-session]')?.getAttribute('data-session') ?? null)
        : null;
      renderSessions();
      list.scrollTop = top;
      if (focusedKey !== null) {
        for (const node of list.querySelectorAll('[data-session]')) {
          if (node.getAttribute('data-session') === focusedKey) {
            /** @type {HTMLElement} */ (node).focus();
            break;
          }
        }
      }
    }, Math.max(0, next - now) + 1);
  }

  function renderSessions() {
    const items = store.getSessions().items;
    const all = /** @type {SessionRow[]} */ (items.filter(sessionMatches));
    // 探针记录、旁路会话与工具子事件默认折叠：渲染层过滤，分页仍按全量，折叠
    // 计数只覆盖已加载页。选中的行临时留下，否则 URL 打开后既高亮不了也找不到它。
    const folded = (/** @type {SessionRow} */ s) => s.flags.includes('probe') || s.flags.includes('bypass')
      || s.flags.includes('background') || s.flags.includes('tool_event');
    const list = state.showFolded ? all : all.filter(s => !folded(s) || s.conv_key === state.session);
    const foldable = all.filter(s => folded(s) && s.conv_key !== state.session);
    // 列表被搜索或筛选收窄时才给分母；默认只报已加载数量，不伪造全库总数。
    el('sess-count').textContent = all.length === items.length ? `已加载 ${items.length}` : `${all.length} / ${items.length}`;
    const now = Date.now();
    const { live, rest, nextCommitAt } = livePartition.partition(list, now);
    const item = (/** @type {SessionRow} */ s) => {
      // 身份用第一个 agent 的品牌 logo；多 Agent 行其余仍走文字。
      const firstAgent = s.agents.length > 0 ? s.agents[0] : null;
      // 失败与缺正文不再只靠颜色：8px 实心 X / 空心圆，挪到笔数之后做后缀；
      // 正常行不再画中性点，把行首让给 logo。
      const failed = s.flags.includes('failed');
      const missing = !failed && s.flags.includes('missing_body');
      const markColor = failed ? 'var(--bad)' : 'var(--muted)';
      const mark = failed || missing
        ? `<span class="dot flagmark" role="img" aria-label="${failed ? '含失败' : '缺正文'}" title="${failed ? '含失败' : '缺正文'}" style="color:${markColor}">${icon(failed ? 'fail-solid' : 'missing-body', 8)}</span>`
        : '';
      // 多 Agent 行只画第一个的名字，其余用 +N 明说还剩几个未显示。
      const who = s.agents.length > 0
        ? `${agentLabel(s.agents[0])}${s.agents.length > 1 ? ` +${s.agents.length - 1}` : ''}`
        : '归属未知';
      const time = liveTimeCell(s, clock);
      return `<button class="sess" data-session="${esc(s.conv_key)}" aria-current="${s.conv_key === state.session}">
        <span class="sess-title">${esc(s.title || '（无标题）')}</span>
        <span class="sess-meta">
          ${agentLogoHtml(firstAgent)}
          <span class="who">${esc(who)}</span>
          <span class="sess-count">· ${s.request_count} 笔</span>
          ${mark}
          <span class="sess-time ${time.cls}">${esc(time.text)}</span>
        </span>
      </button>`;
    };
    const rowsHtml = (/** @type {SessionRow[]} */ rows) => rows.map(item).join('');
    const foldHtml = sessionsListFoldHtml(foldable, state.showFolded);
    // 活跃区在半空时不占位：没有活跃行就退回原来的平铺列表，不常驻空标题。
    const body = list.length
      ? (live.length > 0
        ? sessionsGroupLabel('活跃', live.length) + rowsHtml(live)
          + (rest.length > 0 ? sessionsGroupLabel('全部会话', rest.length) + rowsHtml(rest) : '')
        : rowsHtml(rest)) + foldHtml
      : (foldHtml !== ''
        ? foldHtml
        : `<p class="sess-empty">${icon('empty-tray', 24)}当前已加载的会话里没有符合条件的项。搜索与筛选只覆盖已加载范围。</p>`);
    // 加载更多是列表尾部入口：保留 id 与分页游标条件，错误时可再次点击重试。
    const last = store.getSessions();
    const more = last.cursor === null
      ? '' : `<div class="sess-more"><button class="chip-btn ghost ico" id="load-more-sessions" aria-label="加载更多会话" title="加载更多会话">${icon('load-more', 20)}</button></div>`;
    const error = last.error === null ? ''
      : `<p class="sess-empty">${icon('empty-broken', 24)}会话列表读取失败：${esc(last.error)}。可再次点击加载更多重试。</p>`;
    el('sessions-list').innerHTML = body + more + error;
    scheduleLiveSettle(nextCommitAt, now);
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
    const chainState = detail.derivation === undefined ? null : detail.derivation.chain_state;
    if (chainState !== 'current' && chainState !== 'prefix') {
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

  /** 会话头装配：store 与选择状态在此读齐，纯展示在 session-view。
   *  @param {import('../src/queries/projection').RequestRow[]} hiddenRows 默认时间线省略的空组 */
  function sessionHead(hiddenRows) {
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
      summaryStatus: summary?.status ?? 'idle',
      hiddenRows,
      hiddenFoldOpen: folds.get(`hidden:${state.session ?? ''}`) === true,
      windowAnchor: state.windowAnchor,
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
   * 产出请求（已确认前驱）的推理读数与调用表：承载 delta 里的调用行按 call id
   * 对齐配对状态与执行读数，assistant 文本行按唯一消息取推理段。前驱不在窗口
   * 或未读到时返回 null，调用行留空，不猜归属。
   * @param {number} prevId
   */
  function prevInfoOf(prevId) {
    const prev = store.peekRequest(prevId);
    const detail = prev?.detail ?? null;
    if (detail === null) return null;
    return { reasoningMs: detail.reasoning_span_ms, calls: detail.tool_calls };
  }

  /**
   * 一笔请求的步骤投影：三态（当前/保留/占位）与重投影判据都在显示模型内，
   * 这里只取最近一次显示版本。
   * @param {RequestRow} r
   * @returns {{steps: import('./trace-view.js').TraceStep[], stale: 'reading' | 'failed' | null,
   *   placeholder: boolean}}
   */
  function stepsOf(r) {
    return traceModel.get(r.req_id)
      ?? { steps: [preparingStep(r)], stale: null, placeholder: true };
  }

  /**
   * 末尾回复组：没有后继承载的链末回复单独成组。归属与缓存由显示模型持有。
   * @param {RequestRow} r
   * @returns {{steps: import('./trace-view.js').TraceStep[], stale: 'reading' | 'failed' | null} | null}
   */
  function tailOf(r) {
    return traceModel.get(r.req_id)?.tail ?? null;
  }

  /**
   * 中栏模型：会话头、轮次带与步骤列表一次读齐，交给 trace-dom 键控提交。
   * 步骤行的 HTML 不含选择（默认 false），选择由视图单独写回高亮；
   * 请求组容器自身的可见结果为空串，内容按稳定步骤键逐行比较。
   * 组按行顺序输出「承载组、末尾组、承载组、末尾组……」；末尾组与承载组同号相邻。
   * @returns {import('./trace-dom.js').MainModel}
   */
  /**
   * 结果行的调用方摘要：同组调用行优先（结果与调用同在承载 delta 里），其次
   * 回退产出请求缓存；两处都没有时降级为只工具名。保留投影不回退：旧结果行
   * 不能借用依赖换版后的新调用表，否则会把新调用的名字与参数配到旧结果上。
   * @param {import('./trace-view.js').TraceStep[]} steps
   * @param {boolean} fallback 本组是否使用当前读取投影
   */
  const callOfFor = (steps, fallback) => (/** @type {number} */ ownerReq, /** @type {number} */ callOrd) => {
    const same = steps.find(step => step.kind === 'tool' && step.callOwner !== undefined
      && step.callOwner !== null && step.callOwner.reqId === ownerReq && step.callOwner.callOrd === callOrd);
    if (same !== undefined) return { name: same.toolName ?? '', inputText: same.toolInput ?? '' };
    if (!fallback) return null;
    const ownerRead = store.peekRequest(ownerReq);
    if (ownerRead === null || ownerRead.meta === null) return null;
    const call = replyView(ownerRead.meta).calls.find(item => item.ord === callOrd) ?? null;
    return call === null ? null : { name: call.name, inputText: call.inputText };
  };

  /** 行 HTML 缓存：显示模型重用未变的 steps 数组时按引用复用，不逐帧重生成。
   *  键是步骤数组引用，序号与投影资格（callOf 的回退语义）变化才重建；
   *  selectedStep 不进键——选择由提交后单独写回高亮。行对象引用只在窗口
   *  重建时更换，而重建必先清模型与缓存。 */
  const rowHtmlCache = new WeakMap();
  /** @param {RequestRow} r @param {import('./trace-view.js').TraceStep[]} steps
   *  @param {number} ordinal @param {boolean} fallback @returns {string[]} */
  function rowHtmls(r, steps, ordinal, fallback) {
    const cached = rowHtmlCache.get(steps);
    if (cached !== undefined && cached.ordinal === ordinal && cached.fallback === fallback) return cached.htmls;
    const callOf = callOfFor(steps, fallback);
    const htmls = steps.map(step => renderTraceRow(r, step, ordinal, callOf));
    rowHtmlCache.set(steps, { ordinal, fallback, htmls });
    return htmls;
  }

  function mainModel() {
    const window = store.getWindow();
    const rows = currentRows();
    // 显示更新一次喂齐：读取快照、提交资格与失效集，model 决定哪些组重投影。
    const reads = new Map();
    for (const row of rows) reads.set(row.req_id, store.peekRequest(row.req_id));
    const ready = new Set();
    for (const row of rows) if (preparation.has(row.req_id)) ready.add(row.req_id);
    traceModel.update({
      rows, reads, ready,
      bgJobs: store.peekBgJobs().items,
      complete: window.newerCursor === null && !window.loading,
      changedIds: [...changedReads],
    });
    changedReads.clear();
    const band = turnBandHtml();
    // 序号槽宽的位数取窗口最大序号：初始加载受 windowLimit 限制，加载后续
    // 记录后 rows.length 累计，重绘时重算，不按首次加载上限截断。
    const ordDigits = Math.max(1, String(rows.length).length);
    // 后续入口在列表尾部，只在有更晚记录或正在读取时出现；序号口径在数字本身的悬停说明里。
    const loaderHtml = window.loading
      ? '<div class="history-loader"><span class="history-start">正在读取后续记录…</span></div>'
      : window.newerCursor !== null
        ? `<div class="history-loader"><button id="load-later" class="history-button ico" aria-label="加载后续记录" title="加载后续记录">${icon('load-more', 20)}</button></div>`
        : '';
    const tails = traceModel.tailEligibleIds();
    // 轮次带点得到被省略的起点时，中栏也要有这一行：选中态之外再放行轮次起点。
    const turnStart = state.turn === null ? null : turnOf(state.turn)?.start_req ?? null;
    /** 没有可读正文的请求：请求记录入口在会话头，选中时这一组临时显示也不移出列表。
     *  @type {import('../src/queries/projection').RequestRow[]} */
    const hiddenRows = [];
    /** @type {import('./trace-dom.js').GroupModel[]} */
    const groups = [];
    for (const r of rows) {
      const projection = stepsOf(r);
      const { steps, stale, placeholder } = projection;
      const ordinal = ordinalOf(r.req_id);
      const callOf = callOfFor(steps, stale === null);
      const status = r.status === null ? 'unknown' : r.status >= 400 ? 'failed' : 'success';
      const empty = isEmptyGroup(projection);
      if (empty) hiddenRows.push(r);
      // 空组不占默认时间线；显式选中的请求与轮次起点临时留下状态行，选择不悬空。
      const hidden = empty && r.req_id !== state.reqId && r.req_id !== turnStart;
      /** @type {import('./trace-dom.js').CommitItem[]} */
      const items = [];
      if (!hidden) {
        const htmls = rowHtmls(r, steps, ordinal, stale === null);
        for (let index = 0; index < steps.length; index += 1) {
          items.push({ key: steps[index].key, html: htmls[index] });
        }
        groups.push({
          key: `req:${r.req_id}`,
          reqId: r.req_id,
          status,
          current: r.req_id === state.reqId,
          stale,
          placeholder,
          rows: items,
        });
      }
      // 末尾组不挂请求级 aria-current：它是同一请求的回复，不是第二笔请求。
      const tail = tails.has(r.req_id) ? tailOf(r) : null;
      if (tail === null) continue;
      const tailHtmls = rowHtmls(r, tail.steps, ordinal, stale === null);
      groups.push({
        key: `tail:${r.req_id}`,
        reqId: r.req_id,
        status,
        current: false,
        stale: tail.stale,
        placeholder: false,
        rows: tail.steps.map((step, index) => ({ key: step.key, html: tailHtmls[index] })),
      });
    }
    // 没有已记录请求时给的是插画居中的空列；读取中仍是紧凑单行，不给插画。
    const noRequests = rows.length === 0 && state.pendingSession === null;
    return {
      headHtml: sessionHead(hiddenRows),
      bandHtml: band,
      listClass: `step-list${band !== '' ? ' band-above' : ''}${noRequests ? ' art-empty' : ''}`,
      ordDigits,
      loaderHtml,
      emptyHtml: rows.length === 0
        ? (state.pendingSession !== null
          ? '<p class="sess-empty">正在读取请求…</p>'
          : `<p class="sess-empty sess-empty-art">${spiderArt(200)}<span>这个会话没有已记录的请求。</span></p>`)
        : groups.length === 0
          ? `<p class="sess-empty">${icon('empty-page', 24)}当前窗口的请求都没有可读正文，不在对话时间线里；请求记录在会话头。</p>`
          : '',
      // 「已是最新记录」只在后续游标耗尽后出现：还有更晚记录时不冒充结尾。
      endHtml: window.loading || window.newerCursor !== null ? ''
        : '<div class="timeline-end"><span></span> 已是最新记录</div>',
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
    // 头部单行分组板在清单展开时恢复换行；开合类必须跟 folds 一起恢复，
    // 否则刷新后 open 属性是对的，行仍按单行裁掉清单。
    for (const cue of root.querySelectorAll('.cue-data')) {
      cue.classList.toggle('open-wrap', cue.querySelector('details[open]') !== null);
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

  /** 轮次带吸顶位置贴 session-head 下沿：头部高度由内容决定，重绘与视口变化后同步。
   *  头与带的实际高度同时写进 --head-h / --band-h，滚动定位的 scroll-margin 随之走。
   *  字体就绪、清单展开这类不经过重绘的高度变化由 ResizeObserver 覆盖；头部节点
   *  在内容变化时会被整体替换，观察对象跟随当前节点重挂。 */
  let headResizeObserver = /** @type {ResizeObserver | null} */ (null);
  let observedHead = /** @type {Element | null} */ (null);
  function syncBandTop() {
    const band = document.getElementById('turn-band');
    const head = /** @type {HTMLElement | null} */ (document.querySelector('.session-head'));
    if (head !== null) {
      if (headResizeObserver === null) headResizeObserver = new ResizeObserver(() => syncBandTop());
      if (observedHead !== head) {
        if (observedHead !== null) headResizeObserver.unobserve(observedHead);
        headResizeObserver.observe(head);
        observedHead = head;
      }
      document.documentElement.style.setProperty('--head-h', `${head.offsetHeight}px`);
    }
    if (band === null || head === null) return;
    band.style.top = `${head.offsetHeight}px`;
    document.documentElement.style.setProperty('--band-h', `${band.offsetHeight}px`);
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
      armSpider();
      return;
    }
    // 首载窗口准备完成前以选中组为锚，其余组提交不把它挤出视口；准备完成后
    // 改锚首条可见步骤，阅读位置不再被选中组牵走。
    const preferred = state.revealed ? null : state.reqId;
    const verdict = mainView.commit(mainModel(), scroller(), preferred);
    // 结构提交才需要折叠恢复与带定位；clean/selection 跳过这两项布局读取。
    // 选中块回视野自带视野判断，保留在快路径里给轮次点选即时反馈。
    if (verdict === 'structural') {
      restoreFolds(main);
      // 拍摄直达 ?expand=summary：每次重建后展开 cue-board 的折叠组（工具与路径的 +N）。
      if (expandSummary) {
        for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll('details.path-more'))) details.open = true;
      }
      syncBandTop();
    }
    revealSelectedChip();
    armSpider();
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
  /**
   * 产出请求（已确认前驱）的详情：承载 delta 里的调用行与消息详情按 call_id 对齐
   * 配对坐标与执行读数。前驱不在窗口、未读到或关系未确认时返回 null，留空不猜。
   * @param {RequestDetail | null} detail
   */
  function prevDetailOf(detail) {
    if (detail === null || detail.prev_relation !== 'confirmed' || typeof detail.prev_req_id !== 'number') return null;
    return store.peekRequest(detail.prev_req_id)?.detail ?? null;
  }

  /** 右栏三处「未选择请求」共用同一段标记：B1 吊丝插画 + 原文案（文案不动）。 */
  function railEmptySelect() {
    return `<div class="rail-empty rail-empty-art">${spiderArt(160)}<b>未选择请求</b>在中间选择一个 Request。</div>`;
  }

  function railFacts() {
    const r = currentRow();
    if (r === null) return railEmptySelect();
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
          ${canLoad ? `<div class="conv-tools"><button class="chip-btn ico" data-body-load="${r.req_id}" aria-label="读取正文" title="读取正文">${icon('read', 20)}</button></div>` : ''}</div>
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
    // 选中消息行时结构折叠展开，列表里高亮这条消息；详情只由结构列表内的点击
    // 打开（structureSelected），中栏点击不落进详情。用户之后仍可收起（folds 的
    // 显式 false 优先于自动展开）。请求级行与无选择保持用户自己的开合状态。
    const selectedStep = currentSelectedStep(r);
    const source = resolveSelectedSource(selectedStep, state.selectedStep, read);
    // 选中空组时中栏只有一条状态行：读者还没有步骤可点，右栏直接给四路证据。
    const emptySelected = selectedStep === null && isEmptyGroup(stepsOf(r));
    const messageOrd = source.side === 'request' && source.target === 'message' ? source.messageOrd : null;
    const foldKey = `structure:${r.req_id}`;
    const foldState = folds.get(foldKey);
    const structureHtml = structureFoldHtml({
      reqId: r.req_id, row: r, meta,
      entries: read?.entries ?? [],
      structure: read?.structure ?? { back: 0, next: 0, total: null, ords: [], loading: false, error: null },
      open: foldState ?? (messageOrd !== null),
      selected: structureSelected.get(r.req_id) ?? null,
      highlight: messageOrd,
      delta: detail === null ? null : deltaOrdinals(detail),
      deltaState: read?.delta ?? null,
      parseState: meta?.parse_state ?? null,
      relation: relationTextOf(r.req_id),
      pairOf: messagePairIndexOf(detail, prevDetailOf(detail)),
    });
    return railFactsHtml({
      // 选中组级状态行时，四路证据排在读数页最前：读者点它就是为了问「缺什么」。
      evidenceHtml: source.side === 'evidence' || emptySelected ? evidenceFoldHtml(r, detail, meta) : '',
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
    if (r === null) return railEmptySelect();
    const read = currentRead();
    if (read === null || read.meta === null) {
      const canLoad = r.body_state === 'available' || r.body_state === 'partial';
      return `<div class="rail-empty">${icon('empty-page', 24)}<b>${esc(bodyStateText(r))}</b>${esc(bodyLabelText(r))}
        ${read !== null && read.status === 'invalidated' ? readingChangedNote(r.req_id) : ''}
        ${canLoad ? `<div class="conv-tools"><button class="chip-btn ico" data-body-load="${r.req_id}" aria-label="读取正文" title="读取正文">${icon('read', 20)}</button></div>` : ''}</div>`;
    }
    const detail = read.detail;
    if (state.toolOrd === null) {
      const tools = toolEntries(detail, read.meta);
      if (tools.length === 0) {
        return `<div class="rail-empty">${icon('empty-tray', 24)}<b>没有工具调用</b>这一笔已读回复里没有工具调用；更早分片读取后可再查。</div>`;
      }
      const rows = tools.map(tool => {
        // 正常态（已配对、正文未读已读）不挂 chip；异常（多候选）才提示，详情页给完整状态。
        const warn = tool.state === 'ambiguous'
          ? '<span class="tool-chip miss"><span>多个候选</span></span>' : '';
        // 执行窗口取调用索引里已有的读数；缺值留空，不拿请求耗时替代。
        const exec = detail?.tool_calls.find(call => call.ord === tool.ord)?.exec_ms ?? null;
        const dur = exec === null ? ''
          : `<span class="dur" title="${esc(EXEC_MS_HINT)}">${esc(compact(exec))}</span>`;
        return `<button class="tool-row tool-link" data-tool-select="${tool.ord}">
          <span class="tool-chip call" title="${esc(tool.name)}"><span class="nm">${esc(tool.name)}(${esc(clipText(tool.inputText, 60))})</span></span>
          ${warn}${dur}
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
        <div class="conv-tools"><button class="chip-btn ico" data-copy-tool="${tool.ord}" aria-label="复制参数原文" title="复制参数原文">${icon('copy', 16)}</button></div>`
      : state.toolPage === 'pair'
        ? renderTracePair({
          owner, ownerLabel: windowLabel(owner), call: tool, pair, reading,
          carrierLabel: pair !== null && pair.state === 'resolved' && pair.result_req !== null
            ? windowLabel(pair.result_req) : null,
        })
        : state.toolPage === 'schema'
          ? toolSchemaSection(ownerPage.capabilities, tool.name)
          : toolOverviewHtml(owner, pair, reading);
    const exec = pair === null ? null : pair.exec_ms;
    return `<section class="rail-section">
      <div class="tool-page-head">
        <button class="chip-btn ghost ico" data-tool-back="1" aria-label="返回请求" title="返回请求">${icon('back', 20)}</button>
        <span class="mono">${esc(tool.name)} · 调用 #${tool.ord}</span>
        ${exec === null ? '' : `<span class="cnt mono" title="${esc(EXEC_MS_HINT)}">${esc(compact(exec))}</span>`}
      </div>
      <div class="tool-page-tabs">${pages.map(([key, label]) => `<button data-tool-page="${key}" aria-pressed="${state.toolPage === key}">${label}</button>`).join('')}</div>
      ${pageBody}
    </section>`;
  }

  /** 当前请求的选中步骤对象；无选择或选中的是别的请求时返回 null。 @param {RequestRow} r */
  function currentSelectedStep(r) {
    if (state.selectedStep === null || !state.selectedStep.startsWith(`${r.req_id}:`)) return null;
    const key = state.selectedStep;
    const projected = stepsOf(r);
    if (projected.stale !== null) return null;
    const direct = projected.steps.find(item => item.key === key);
    if (direct !== undefined) return direct;
    // 末尾组只有当前版本的投影能解析来源。
    if (!key.startsWith(`${r.req_id}:reply:`) && !key.startsWith(`${r.req_id}:call:`)) return null;
    const tail = tailOf(r);
    return tail !== null && tail.stale === null ? tail.steps.find(item => item.key === key) ?? null : null;
  }

  function railBody() {
    // 会话汇总条目列表：会话级阅读态，优先于轮次与请求态；点击条目后清掉。
    // 页头计数与失败数从首页汇总的分组计数取；工具名是列表筛选依据时不再逐行重复。
    if (summaryList !== null) {
      const list = summaryList;
      const summary = store.peekSummary();
      const data = summary.status === 'ready' && summary.data !== null ? summary.data : null;
      // 页头计数与失败数按组取自首页汇总：工具组带失败数，Skill、路径与中断组只有次数。
      let groupCount = null;
      let groupErrors = 0;
      if (data !== null) {
        if (list.kind === 'tool') {
          const group = data.tools.find(tool => tool.name === list.param) ?? null;
          if (group !== null) { groupCount = group.count; groupErrors = group.errors; }
        } else if (list.kind === 'skill') {
          const group = data.skills.find(skill => skill.name === list.param) ?? null;
          if (group !== null) groupCount = group.count;
        } else if (list.kind === 'read' || list.kind === 'written') {
          const group = data.paths[list.kind].find(path => path.path === list.param) ?? null;
          if (group !== null) groupCount = group.count;
        } else if (list.kind === 'interrupts') {
          groupCount = data.interrupts.count;
        }
      }
      const items = list.data !== null && 'items' in list.data ? list.data.items : null;
      const meta = {
        count: groupCount ?? (items !== null ? items.length : null),
        errors: groupErrors,
      };
      // 条目自带摘要优先；缺摘要时只同步复用已缓存的 detail/meta。同一请求的
      // toolEntries 在一次目录渲染内复用，避免每行重建同一份解析结果。
      /** @type {Map<number, import('./body-model.js').ToolEntry[] | null>} */
      const toolEntriesByReq = new Map();
      return railSummaryListView(list, id => {
        const text = requestLabel(id);
        return { text, dim: text.includes('（未在窗口）') };
      }, meta, item => {
        if (typeof item.summary === 'string' && item.summary !== '') return item.summary;
        if (!toolEntriesByReq.has(item.req_id)) {
          const read = store.peekRequest(item.req_id);
          toolEntriesByReq.set(item.req_id,
            read === null || read.detail === null || read.meta === null
              ? null : toolEntries(read.detail, read.meta));
        }
        const entries = toolEntriesByReq.get(item.req_id) ?? [];
        const tool = entries.find(entry => entry.ord === item.ord);
        if (tool === undefined) return null;
        const parts = summaryParts(tool.name, tool.inputText);
        const text = parts.args === '' ? parts.label : `${parts.label} · ${parts.args}`;
        return text === '' ? null : text;
      });
    }
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
      return '<div class="rail-empty">' + icon('empty-select', 24) + '<b>轮次不可用</b>重新结算后这一轮不在列表里；点击轨迹任意行返回请求态。</div>';
    }
    const r = currentRow();
    if (r === null) {
      if (state.offPageReqId !== null) {
        const read = store.peekRequest(state.offPageReqId);
        return `<section class="rail-section"><h3>窗口外请求</h3><p class="rail-note">Request ${state.offPageReqId} · ${esc(read?.detail?.title ?? '详情见读取结果')} 不在当前载入窗口。这里只读了它的详情；需要完整轨迹请调整窗口（会话头有切窗按钮），不自动扫描全部历史。</p></section>${read?.detail ? ledgerRowsHtml(read.detail, read.detail) : ''}`;
      }
      return railEmptySelect();
    }
    const owner = state.railTab === 'tools' && state.toolOrd !== null ? state.toolOwner ?? r.req_id : null;
    const ownerRow = owner === null ? null : currentRows().find(row => row.req_id === owner) ?? null;
    const stale = stepsOf(r).stale;
    const staleOwner = ownerRow === null ? null : stepsOf(ownerRow).stale;
    if (state.railTab !== 'route' && (stale !== null || staleOwner !== null)) {
      const failed = stale === 'failed' || staleOwner === 'failed';
      const retryId = stale === 'failed' || staleOwner === null ? r.req_id : ownerRow?.req_id ?? r.req_id;
      const status = failed ? '当前版本读取失败，可重试。' : '正在准备当前版本，请稍候。';
      return `<div class="rail-empty">${failed ? icon('empty-broken', 24) : ''}<b>阅读版本已变化</b>${status}
        <div style="margin-top:10px"><button class="chip-btn ico" data-body-load="${retryId}" aria-label="立即重读" title="立即重读">${icon('read', 20)}</button></div></div>`;
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
      return `<div class="rail-empty">${icon('empty-page', 24)}<b>${esc(bodyStateText(r))}</b>${esc(bodyLabelText(r))}
        ${read !== null && read.status === 'invalidated' ? readingChangedNote(r.req_id) : ''}
        ${canLoad ? `<div class="conv-tools"><button class="chip-btn ico" data-body-load="${r.req_id}" aria-label="读取正文" title="读取正文">${icon('read', 20)}</button></div>` : ''}</div>`;
    }
    const page = read.meta;
    if (page.state !== 'available' && page.state !== 'partial') {
      return `<div class="rail-empty">${icon('empty-page', 24)}<b>${esc(bodyStateText(r))}</b>${esc(bodyNotice(page) || '这一笔没有可读的正文。')}</div>`;
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
    const selected = currentSelectedStep(r);
    const source = resolveSelectedSource(selected, stepsOf(r).stale === null ? state.selectedStep : null, read);
    /** @type {string} */
    let body;
    if (source.side === 'request' && source.target === 'system') {
      body = renderSystemDetail(source.text, source.path);
    } else if (source.side === 'request') {
      const chosen = read.entries.find((/** @type {{ord: number}} */ entry) => entry.ord === source.messageOrd) ?? null;
      const path = messagePathOf(page, source.messageOrd);
      body = chosen !== null ? renderMessageDetail(chosen, path, messagePairIndexOf(detail, prevDetailOf(detail)))
        : `<div class="rail-empty">${icon('empty-page', 24)}<b>消息未读取</b>${path === '' ? `消息 #${source.messageOrd}` : esc(path.replace(/^request\./, ''))} 不在已加载的分片里；读取完成后回到这一步。</div>`;
    } else if (source.side === 'reply' && source.target === 'text') {
      body = `${truncNote}${renderReplyBlockDetail(source.path, source.text)}`;
    } else if (source.side === 'reply' && source.target === 'block') {
      body = renderUnknownBlockDetail(source.path, source.raw);
    } else if (view.state === 'ok') {
      body = `${truncNote}${renderReplyDetail(view, tools, String(r.req_id))}`;
    } else {
      body = `<div class="rail-empty">${icon('empty-tray', 24)}<b>没有可读的回复</b>${esc(bodyNotice(page) || '这一笔只有请求。')}</div>`;
    }
    const structure = read.structure;
    // 结构总数未读时用元信息页的 total 判断；未读口径与读数页折叠共用一份。
    const knownTotal = structure.total ?? (page.total ?? null);
    const unread = structureUnread(structure, knownTotal);
    const { button: moreButton, note: structureError } = structureMoreParts(structure, r.req_id, knownTotal);
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
      ${unread ? `<div style="margin-top:8px">${moreButton}</div>${structureError}` : ''}`;
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
    // 来源与调用方都换新后再判断选定工具是否消失，渲染函数不改 state。
    // 调用方读取未就绪（meta 为空）不算消失，保留选择显示「正在读取」。
    if (state.toolOrd !== null) {
      const owner = state.toolOwner ?? state.reqId;
      const ownerRead = owner !== null ? store.peekRequest(owner) : null;
      const ownerRow = owner === null ? null : currentRows().find(row => row.req_id === owner) ?? null;
      const selectedRow = currentRow();
      if ((selectedRow === null || stepsOf(selectedRow).stale === null)
        && (ownerRow === null || stepsOf(ownerRow).stale === null)
        && ownerRead !== null && ownerRead.meta !== null
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
    const sameRail = key === lastRailKey;
    const keep = sameRail ? rail.scrollTop : 0;
    const listAnchor = sameRail ? captureMsgAnchor(rail) : null;
    rail.innerHTML = railBody();
    restoreFolds(rail);
    // 结构列表是独立滚动区：重绘按首条可见消息归位，首次到达落到最新一条。
    restoreMsgList(rail, listAnchor);
    restoreScroll(rail, keep);
    lastRailKey = key;
    wireContextMap();
    armSpider();
  }

  /**
   * 结构列表的滚动锚点：右栏重绘会重建内层列表，scrollTop 不保留。记下当前
   * 可见的首条消息序号与相对偏移，重绘后按它归位；没有锚点时交给恢复方落底。
   * @param {HTMLElement} rail
   * @returns {{ord: number, offset: number} | null}
   */
  function captureMsgAnchor(rail) {
    const list = /** @type {HTMLElement | null} */ (rail.querySelector('.rail-fold .msg-list'));
    if (list === null) return null;
    const box = list.getBoundingClientRect();
    for (const node of list.querySelectorAll('li[data-ord]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= box.top) continue;
      return { ord: Number(/** @type {HTMLElement} */ (node).dataset.ord), offset: rect.top - box.top };
    }
    return null;
  }

  /**
   * 结构列表的滚动恢复：中栏刚点过的消息优先滚到它（居中，留出前后邻居）；
   * 否则锚点还在就按序号与偏移归位（「加载更早」前插不把读者拉回顶部）；
   * 锚点不在（首读、换请求或列表刚出现）时落到最新一条——读取方向是尾片优先。
   * @param {HTMLElement} rail
   * @param {{ord: number, offset: number} | null} anchor
   */
  function restoreMsgList(rail, anchor) {
    const list = /** @type {HTMLElement | null} */ (rail.querySelector('.rail-fold .msg-list'));
    if (list === null) return;
    if (structureReveal !== null && structureReveal.reqId !== state.reqId) structureReveal = null;
    // 折叠收起时列表不可见：待定位保留到展开后的渲染，不在这里消耗。
    if (structureReveal !== null && list.clientHeight > 0) {
      const item = list.querySelector(`li[data-ord="${structureReveal.ord}"]`);
      if (item !== null) {
        structureReveal = null;
        const offset = item.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += offset - (list.clientHeight - item.clientHeight) / 2;
        return;
      }
      // 行还没进列表（读取中或不在已读分片）：保留待定位，这次按锚点或落底。
    }
    if (anchor !== null) {
      const item = list.querySelector(`li[data-ord="${anchor.ord}"]`);
      if (item !== null) {
        const offset = item.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += offset - anchor.offset;
        return;
      }
    }
    list.scrollTop = list.scrollHeight;
  }

  function renderAll() {
    renderCrumb();
    renderFilters();
    renderSessions();
    renderMain();
    renderRail();
    updateURL();
  }

  /** 顶栏只在降级时出标签；正常与未知模式不占位置。 @param {import('./backend-state.js').Admission | null} admission */
  function applyBackendState(admission) {
    const slot = document.getElementById('backend-slot');
    if (slot === null) return;
    slot.innerHTML = backendStateHtml(admission);
  }

  /** 启动、显式刷新与点按降级标签时各读一次；不做轮询，读取失败保留上一次显示。 */
  async function refreshBackendState() {
    try {
      const stats = await store.loadStats();
      applyBackendState(stats.admission ?? null);
    } catch { /* 状态未知不冒充正常，也不清掉已知降级 */ }
  }

  /* ---------------- 窗口导航 ---------------- */
  /** 当前滚动容器：main 独立滚动时用 main，窄屏文档流用滚动根；根元素缺失时退回 main。 */
  function scroller() {
    const main = el('main');
    return getComputedStyle(main).overflowY === 'visible' ? (document.scrollingElement ?? main) : main;
  }

  async function loadLater() {
    // 加载态由渲染输入表达：store 起跑后 window.loading 已为真，入口换成
    // 「正在读取后续记录…」。就地改 disabled 会被键控提交原地保留（同款 HTML
    // 不换节点），加载完成后按钮就永远点不动了。
    const pending = store.loadLater();
    renderMain();
    await pending;
    // append 不动既有内容，位置由每次提交自带的锚点补偿保持，不再手接快照。
    renderMain();
    renderSessions();
    void prepareWindow();
  }

  /** 显式刷新：按当前窗口锚点重建、清掉旧展开，记录读取时间；记录缓存随窗口重建。 */
  async function refreshWindow() {
    if (state.session === null) return;
    const myNav = ++navEpoch;
    const mySelection = selectionEpoch;
    state.refreshedAt = Date.now();
    state.revealed = false;
    // 显式刷新顺带重读后端状态；降级标签只在启动、刷新与点按时更新。
    void refreshBackendState();
    // 显式刷新按用户要求换新：准备结论与旧版本显示一并清掉，不从上一版接着画。
    resetReading();
    dispatch({ kind: 'refresh-start' });
    await store.selectSession(state.session, windowLimit(), state.windowAnchor);
    if (myNav !== navEpoch) return;
    const rows = currentRows();
    /** @type {number | null} 锚点意图写入的请求；准备完成后确认它有没有内容 */
    let anchor = null;
    if (mySelection === selectionEpoch) {
      if (state.windowAnchor === 'latest') {
        anchor = contentAnchorId('last');
        dispatch({ kind: 'select-latest', latestReqId: anchor });
      } else {
        anchor = contentAnchorId('first');
        dispatch({ kind: 'select-first', firstReqId: anchor });
      }
    } else if (state.reqId !== null && !rows.some(row => row.req_id === state.reqId)) {
      dispatch({ kind: 'open-offpage', reqId: state.reqId });
    }
    renderAll();
    // 导航完成：路由页随重建后的选中请求读取（效果经 nav-settled 统一发出）。
    dispatch({ kind: 'nav-settled' });
    void prepareWindow().then(() => { if (mySelection === selectionEpoch) settleAnchor(anchor); });
    if (mySelection === selectionEpoch) ensureSelectedVisible();
  }

  /** 「回到最新」：切到尾锚点重建窗口，选中并居中最新一笔。 @returns {Promise<void>} */
  function jumpLatest() {
    state.windowAnchor = 'latest';
    return refreshWindow();
  }

  /** 「回到开头」：切回头锚点重建窗口，选中第一笔。 @returns {Promise<void>} */
  function jumpStart() {
    state.windowAnchor = 'start';
    return refreshWindow();
  }

  /**
   * 窗口外提示里的切窗动作：换到对面锚点重建。目标进入新窗口就定位到它，
   * 仍在窗口外（超长会话的中段）就恢复窗口外说明，不假装已到达。
   * @param {number | null} target
   */
  async function switchWindowFor(target) {
    if (target === null) return;
    const selection = selectionEpoch;
    const pending = state.windowAnchor === 'latest' ? jumpStart() : jumpLatest();
    const nav = navEpoch;
    await pending;
    if (nav !== navEpoch || selection !== selectionEpoch) return;
    if (currentRows().some(row => row.req_id === target)) locateRequest(target);
    else dispatch({ kind: 'open-offpage', reqId: target });
  }

  /** 定位窗口内请求：选中并滚动进入可见区域（路由随导航完成读取、定点补读都走效果）。 @param {number} id */
  function locateRequest(id) {
    const rows = currentRows();
    if (!rows.some(row => row.req_id === id)) return;
    dispatch({ kind: 'locate', reqId: id });
  }

  /** 默认选中后必须让选中组进入可见区域；头锚点下第一组居中即停在顶部。 */
  function ensureSelectedVisible() {
    const nav = navEpoch, selection = selectionEpoch;
    const viewport = scroller(), top = viewport.scrollTop;
    requestAnimationFrame(() => {
      if (nav !== navEpoch || selection !== selectionEpoch || viewport !== scroller() || viewport.scrollTop !== top) return;
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

  /**
   * 确保某请求的读取与右栏数据在手。窗口内走准备流水线（详情、依赖与增量
   * 一次备齐再提交），已提交的组不因点击重新扩量；窗口外只读详情、元信息与
   * 两片增量。重读成功后取得新 detail/meta 并按当前选中来源补读所需块。
   * @param {number} id
   */
  async function ensureRead(id) {
    if (inWindow(id)) {
      const read = store.peekRequest(id);
      // 增量剩余交回组内「点击续读」的显式入口；这里只保证组本身备齐。
      if (!(preparation.has(id) && read !== null && read.detail !== null)) await preparation.prepare(id);
    } else {
      try {
        let read = await store.readRequest(id);
        if (!read.delta.done) {
          try { read = await store.loadDelta(id, 2); } catch { /* 失败保留增量事件行，可再次续读 */ }
        }
      } catch {
        /* reading_changed 的作废与自动重读由 store 负责；失败态由快照如实渲染 */
        renderMain();
        renderRail();
        return;
      }
    }
    const selected = state.selectedStep;
    // 结果步骤键是 message:N:result:M，序号取 message: 后的第一段，不能用最后一段。
    const ordMatch = selected !== null ? new RegExp(`^${id}:message:(\\d+)`).exec(selected) : null;
    const row = currentRows().find(item => item.req_id === id);
    if (ordMatch !== null && row !== undefined && stepsOf(row).stale === null) {
      const ord = Number(ordMatch[1]);
      if (Number.isFinite(ord)) await ensureMessageOrd(id, ord);
    }
    // 自动展开的结构折叠不经过 toggle 事件：展开本该触发的尾片读取在这里补上，
    // 否则列表里只有定点读到的这一条，也没有「更早」可加载。
    const after = store.peekRequest(id);
    if (after !== null && (folds.get(`structure:${id}`) ?? ordMatch !== null)
      && after.structure.total === null && !after.structure.loading) {
      await loadStructure(id);
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

  /** 轮锚点消费：轮次快照就绪后把 ?turn 翻译成该轮起点请求并点亮轮次带。 */
  function consumePendingTurn() {
    if (pendingTurn === null) return;
    const row = turnOf(pendingTurn);
    pendingTurn = null;
    if (row === null) return;
    dispatch({ kind: 'locate', reqId: row.start_req });
    dispatch({ kind: 'select-turn', row });
  }

  /** summary 组清单消费：快照就绪后打开 count 最大的那一组（直达拍摄用）。 */
  function consumePendingSummary() {
    if (pendingSummaryKind === null) return;
    const snap = store.peekSummary();
    if (snap?.status !== 'ready' || snap.data === null) return;
    const kind = pendingSummaryKind;
    pendingSummaryKind = null;
    const d = snap.data;
    const byCount = (/** @type {{count: number}} */ a, /** @type {{count: number}} */ b) => b.count - a.count;
    if (kind === 'tool') {
      const group = [...d.tools].sort(byCount)[0] ?? null;
      if (group !== null) void openSummaryList({ kind: 'tool', name: group.name }, `${group.name} 的调用`);
    } else if (kind === 'read') {
      const group = [...d.paths.read].sort(byCount)[0] ?? null;
      if (group !== null) void openSummaryList({ kind: 'read', path: group.path }, `读取请求 · ${group.path.split('/').pop() ?? group.path}`);
    } else if (kind === 'written') {
      const group = [...d.paths.written].sort(byCount)[0] ?? null;
      if (group !== null) void openSummaryList({ kind: 'written', path: group.path }, `写入尝试 · ${group.path.split('/').pop() ?? group.path}`);
    } else if (kind === 'skill') {
      const group = [...d.skills].sort(byCount)[0] ?? null;
      if (group !== null) void openSummaryList({ kind: 'skill', name: group.name }, `Skill ${group.name}`);
    } else {
      void openSummaryList({ kind: 'interrupts' }, '中断的请求');
    }
  }

  /**
   * 打开条目列表：按组现查，不缓存；换目标时旧响应作废。
   * @param {import('../src/queries/session-summary').SummaryEntriesQuery} query
   * @param {string} label
   */
  async function openSummaryList(query, label) {
    // param 是分组键本身（工具名、路径、Skill 名），页头计数靠它与首页汇总对组；label 才是展示文案。
    summaryList = {
      kind: query.kind,
      param: 'name' in query ? query.name : 'path' in query ? query.path : '',
      label, loading: true, error: null, data: null,
    };
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
    if (key === `${id}:unassigned-more`) {
      if (stepsOf(row).stale === null) await loadStructure(id);
      else await ensureRead(id);
      return;
    }
    if (key === `${id}:body-metadata`) {
      preparation.forget(id);
      await ensureRead(id);
      return;
    }
    // 增量事件行是续读入口：打开读数页并再消费两片，不当作步骤选择。
    if (key === `${id}:delta`) {
      dispatch({ kind: 'select-delta', reqId: id });
      return;
    }
    // 旧投影仅供显示；消息选择只从当前版本取得来源。
    const projected = stepsOf(row);
    const step = projected.stale === null ? projected.steps.find(item => item.key === key) ?? null : null;
    // 消息行把读数页的结构折到这条消息：展开折叠，在列表里高亮并滚到它。
    // 详情只在结构列表里再点一次才展开；请求级行只换选择，不动折叠状态。
    // 点另一条消息行时关掉结构里开着的详情：否则右栏留在上一条的正文，中栏却已
    // 指向新的一条，读者只能先按「返回消息列表」再找新行。
    const source = step?.source ?? null;
    if (source !== null && source.side === 'request' && typeof source.messageOrd === 'number') {
      folds.set(`structure:${id}`, true);
      structureReveal = { reqId: id, ord: source.messageOrd };
      structureSelected.delete(id);
    }
    dispatch({ kind: 'select-step', reqId: id, stepKey: String(key) });
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
    const reqId = state.reqId;
    if (reqId === null) return;
    const rows = currentRows();
    if (rows.some(row => row.req_id === reqId)) return;
    const nav = navEpoch, selection = selectionEpoch;
    let detail = null;
    try {
      const read = await store.readRequest(reqId);
      detail = read.detail;
    } catch { /* 读取失败按未找到处理 */ }
    if (nav !== navEpoch || selection !== selectionEpoch || state.reqId !== reqId) return;
    const target = resolveTraceTarget(rows, reqId, detail);
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
    // 换会话回默认头锚点：进入会话即从头阅读，追尾模式不跨会话继承。
    state.windowAnchor = 'start';
    // 换会话不复用上一场的准备结论与保留投影：它们只服务当场阅读。
    resetReading();
    renderMain();
    await store.selectSession(key, windowLimit());
    if (myNav !== navEpoch) return;
    state.pendingSession = null;
    await resolveInitialTrace();
    if (myNav !== navEpoch) return;
    // 默认选第一笔有内容的请求；窗口外 trace 保留其语义，不用第一笔顶替。
    const rows = currentRows();
    const before = state.reqId;
    dispatch({ kind: 'session-default', firstReqId: contentAnchorId('first') });
    // 准备完成前判不出空组：锚点落在空组上时，备齐后再挪到有内容的一笔。
    const anchor = state.reqId !== before ? state.reqId : null;
    renderAll();
    void prepareWindow().then(() => settleAnchor(anchor));
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
    // 降级标签本身是重新读取入口，标签随读取重建，统一走委托。
    if (t.closest('#backend-state')) { void refreshBackendState(); return; }
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
    if (t.closest('summary')) return;
    if (t.closest('#load-later')) { void loadLater(); return; }
    if (t.closest('#refresh-window')) { void refreshWindow(); return; }
    if (t.closest('#jump-opposite')) {
      const button = /** @type {HTMLButtonElement} */ (t.closest('#jump-opposite'));
      if (state.windowJumping) return;
      state.windowJumping = true;
      button.disabled = true;
      button.textContent = '正在重建窗口…';
      void (state.windowAnchor === 'latest' ? jumpStart() : jumpLatest())
        .finally(() => { state.windowJumping = false; renderAll(); });
      return;
    }
    if (t.closest('#switch-window')) { void switchWindowFor(state.offPageReqId); return; }
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
      // 返回列表只清结构自己的选择。步骤选择不再把折叠钉在详情上（它只给列表
      // 里的这一行高亮），所以不必连带清掉中栏选择。
      structureSelected.delete(Number(structureBack.dataset.structureBack));
      renderRail();
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
          copyTool.innerHTML = icon('check', 16);
          setTimeout(() => { copyTool.innerHTML = icon('copy', 16); }, 300);
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
          copyMsg.innerHTML = icon('check', 16);
          setTimeout(() => { copyMsg.innerHTML = icon('copy', 16); }, 300);
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
    if (t.closest('[data-fold-toggle]')) {
      state.showFolded = !state.showFolded;
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
    // 单行分组板：清单开合时该行临时恢复换行，收起即回单行。
    const cueData = t.closest('.cue-data');
    if (cueData !== null) cueData.classList.toggle('open-wrap', t.open);
    // 会话头里的清单开合改变头部高度：轮次带吸顶位置与滚动让位随后同步。
    if (t.closest('.session-head') !== null) syncBandTop();
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
    dispatch({
      kind: 'restore-url', session: p.get('session'),
      trace: traceIdFromParam(p.get('trace')), tab: railTabFromParam(p.get('tab')),
    });
    if (state.session !== null) { void selectSession(state.session, state.reqId); return; }
    // URL 无会话：离开当前会话——窗口与请求级读取全部取消并清空，页面回到无会话落点。
    resetReading();
    store.leaveSession();
    folds.clear();
    structureSelected.clear();
    summaryList = null;
    contextMenu.close();
    mainView.reset();
    renderAll();
  });

  // 统一退出生命周期：页面进入 bfcache 前取消全部读取并停掉调度；从 bfcache
  // 恢复时 store 已失效，整页按 URL 重载恢复现场。
  window.addEventListener('pagehide', () => { store.dispose(); });
  window.addEventListener('pageshow', (/** @type {PageTransitionEvent} */ e) => {
    if (e.persisted) location.reload();
  });

  initLayout();
  void (async () => {
    let listError = null;
    try {
      await store.loadSessions();
    } catch (error) {
      listError = error;
    }
    // 统计读取排在列表之后：不再与 /api/sessions 竞争首屏的服务端时间窗。
    void refreshBackendState();
    if (listError !== null) {
      el('sessions-list').innerHTML = `<p class="sess-empty">会话列表加载失败:${esc(listError instanceof Error ? listError.message : 'unknown')}</p>`;
      return;
    }
    if (state.session === null) {
      // 默认落点跳过折叠行：打开页面就进一个列表里看不到的探针组，等于没折叠。
      const first = /** @type {SessionRow | undefined} */ (store.getSessions().items
        .find(s => !s.flags.includes('probe') && !s.flags.includes('bypass')));
      if (first) dispatch({ kind: 'open-session', sessionKey: first.conv_key, wantedTrace: null });
    }
    // 列表（与默认选中意图）到手先提交左栏：请求窗口是另一个请求，可能等很久；
    // 会话列表可独立使用，不等正文。此后 renderAll 会按窗口结果重画全部区块。
    renderSessions();
    renderFilters();
    if (state.session !== null) await selectSession(state.session, traceIdFromParam(qp.get('trace')));
    else renderAll();
  })();
}
