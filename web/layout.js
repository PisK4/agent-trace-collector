// @ts-check
/**
 * 布局控制：主题偏好、侧栏与详情栏折叠、详情栏宽度拖拽与键盘调宽、面板按钮
 * aria 同步。主题偏好、首选宽度与拖拽指针由本模块持有；轨迹锚点、选中步骤
 * 焦点与轮次带定位仍归控制器。
 */

/** @param {string} id */
function el(id) {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing_element:${id}`);
  return element;
}

let themePref = 'system';
try { themePref = localStorage.getItem('tc.theme') || 'system'; } catch { /* storage may be blocked */ }

export function applyTheme() {
  if (themePref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = themePref;
  const btn = el('theme-toggle');
  btn.textContent = themePref === 'dark' ? '☾' : themePref === 'light' ? '☀' : '◐';
  btn.title = `主题：${themePref === 'system' ? '跟随系统' : themePref === 'dark' ? '深色' : '浅色'}（点击切换）`;
}

/** 折叠按钮的 aria 状态与 body 类同步。 */
export function syncPanelButtons() {
  for (const [id, cls, name] of [['sidebar-toggle', 'sidebar-collapsed', '会话栏'], ['rail-toggle', 'rail-collapsed', '详情栏']]) {
    const button = el(id);
    const closed = document.body.classList.contains(cls);
    button.setAttribute('aria-expanded', String(!closed));
    button.setAttribute('aria-label', `${closed ? '展开' : '收起'}${name}`);
    button.title = button.getAttribute('aria-label') ?? '';
  }
}

/** 展开详情栏：选择转换的 open-rail 效果与会话条目打开共用这一处。 */
export function openRail() {
  document.body.classList.remove('rail-collapsed');
  syncPanelButtons();
}

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
let preferredRailWidth = RAIL_MAX;
/** @type {number | null} 按住中的 pointerId；move 只在按住时生效。 */
let draggingPointer = null;

/** @param {number} wanted */
function resizeRail(wanted) {
  const resizer = el('rail-resize');
  const limit = Math.round(clampWidth(RAIL_MAX, window.innerWidth, sidebarWidth()));
  const value = Math.round(clampWidth(wanted, window.innerWidth, sidebarWidth()));
  document.documentElement.style.setProperty('--rail-width', `${value}px`);
  resizer.setAttribute('aria-valuenow', String(value));
  resizer.setAttribute('aria-valuemax', String(limit));
}

function fitRail() {
  if (window.innerWidth > 1000) resizeRail(preferredRailWidth);
}

/** 装配布局交互：主题按钮、面板折叠、详情栏拖拽与键盘调宽。启动时调用一次。 */
export function initLayout() {
  el('theme-toggle').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(themePref) + 1) % order.length] ?? 'system';
    try { localStorage.setItem('tc.theme', next); } catch { /* storage may be blocked */ }
    themePref = next;
    applyTheme();
  });

  const resizer = el('rail-resize');
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

  el('sidebar-toggle').addEventListener('click', () => { document.body.classList.toggle('sidebar-collapsed'); syncPanelButtons(); fitRail(); });
  el('rail-toggle').addEventListener('click', () => { document.body.classList.toggle('rail-collapsed'); syncPanelButtons(); });

  applyTheme();
}
