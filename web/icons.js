// @ts-check
/**
 * 界面图标：一份 16 网格几何，`stroke-width` 恒定 1.5，按控件尺寸整枚缩放
 * （16→1.5、20→1.875、24→2.25），光学密度不随档位变化。
 *
 * 约束：单枚 ≤4 段路径、相邻笔画净空 ≥2 网格、不画同心双轮廓、不在图形里放字。
 * 深色下由调用方的 `--text-2` / 角色色决定对比度，图形本身只用 currentColor。
 *
 * SVG 一律 `aria-hidden`：可访问名由外层的 `aria-label` / 可见文字承担。
 */

/** @type {Record<string, string>} */
const BODY = {
  /* 顶栏：面板折叠与主题 */
  'panel-left': '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M6.2 3.4v9.2"/>',
  'panel-right': '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M9.8 3.4v9.2"/>',
  sun: '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"/>',
  moon: '<path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53Z" fill="currentColor" stroke="none"/>',

  /* 中栏读数：推理段 / 执行段 */
  reason: '<circle cx="4" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.25" fill="currentColor" stroke="none"/>',
  exec: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M5 6.2l1.8 1.8-1.8 1.8M8.6 10.2h2.6"/>',

  /* 状态：失败 X / 缺口三角（同一族，只换轮廓） */
  failure: '<path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4"/>',
  gap: '<path d="M8 2.6l5.4 10H2.6L8 2.6Z"/>',

  /* 控件：整块重取（闭环圆环 + 切向箭头） / 只重来这一笔（圆点 + 开口回钩） */
  refresh: '<path d="M11.7 3.9a5.2 5.2 0 1 0 1.7 5.4"/><path d="M13.4 2.2v3h-3"/>',
  retry: '<circle cx="5.4" cy="11.2" r="1.5" fill="currentColor" stroke="none"/><path d="M12.8 4.3c.5 3.6-.5 5.9-2.3 6.7-1.2.5-2.7.5-3.6.2"/><path d="M9.4 9.9L7.3 11.2l1.6 1.8"/>',

  /* 控件：复制、读取、关闭、加载更多 */
  copy: '<rect x="2.6" y="4.8" width="8.8" height="8.8" rx="1.6"/><path d="M5.2 4.8V3.4a1.2 1.2 0 0 1 1.2-1.2h6a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2h-1.4"/>',
  read: '<rect x="3.4" y="2.4" width="9.2" height="11.2" rx="1.6"/><path d="M8 5.6v4.4M5.9 8l2.1 2.1 2.1-2.1"/>',
  close: '<path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4"/>',
  'load-more': '<path d="M8 3.4v6.8M5.4 7.6L8 10.2l2.6-2.6M3.8 12.6h8.4"/>',

  /* 折叠：单 chevron */
  'caret-down': '<path d="M4.6 6.2L8 9.6l3.4-3.4"/>',
  'caret-up': '<path d="M4.6 9.8L8 6.4l3.4 3.4"/>',

  /* 跳转：首尾、返回、配对 */
  'jump-start': '<path d="M4.4 7.6l3.6-3.6 3.6 3.6M4.4 11.6l3.6-3.6 3.6 3.6"/>',
  'jump-end': '<path d="M4.4 4.4l3.6 3.6 3.6-3.6M4.4 8.4l3.6 3.6 3.6-3.6"/>',
  back: '<path d="M12.6 8H3.6M6.8 4.8L3.6 8l3.2 3.2"/>',
  pair: '<rect x="8.8" y="3.2" width="4.8" height="9.6" rx="1.4"/><path d="M2.6 8h5.4M5.6 5.4L8 8l-2.4 2.6"/>',

  /* 证据三态 */
  check: '<path d="M3.2 8.4l3 3 6.6-6.8"/>',
  question: '<path d="M5.4 6.1a2.6 2.6 0 1 1 3.7 2.5c-.7.3-1.1.8-1.1 1.7"/><circle cx="8" cy="12.4" r=".9" fill="currentColor" stroke="none"/>',

  /* 角色（六种 pill 全部图标化，共享同一栅格） */
  'role-user': '<circle cx="8" cy="5.4" r="2"/><path d="M3.6 12.4c0-2.4 1.9-3.9 4.4-3.9s4.4 1.5 4.4 3.9"/>',
  'role-assistant': '<rect x="2.6" y="3.3" width="10.8" height="9.4" rx="2.8"/><circle cx="6" cy="8" r=".95" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".95" fill="currentColor" stroke="none"/>',
  'role-tool': '<path d="M12.3 4.1v4.5a2.2 2.2 0 0 1-2.2 2.2H4.3"/><path d="M6.9 8.3L4.3 10.8l2.6 2.5"/>',
  'role-system': '<rect x="2.6" y="6" width="10.8" height="7.4" rx="1.4"/><path d="M4.6 6V4.2A1.2 1.2 0 0 1 5.8 3h4.4a1.2 1.2 0 0 1 1.2 1.2V6"/>',
  'role-aux': '<path d="M8 13.2V8M8 8l-3.4-3.4M8 8l3.4-3.4"/><circle cx="4.6" cy="4.6" r="1" fill="currentColor" stroke="none"/><circle cx="11.4" cy="4.6" r="1" fill="currentColor" stroke="none"/>',
  'role-event': '<path d="M2.6 8h2.8l1.6-3.6 2.4 7.2 1.4-3.6h2.6"/>',

  /* 指标标识：只替换标签，数值不动 */
  stopwatch: '<circle cx="8" cy="8.8" r="4.8"/><path d="M8 1.6v1.8M6.6 1.6h2.8M8 8.8V5.8"/>',

  /* 空状态：4 枚成套，24px，只描边不填色 */
  'empty-select': '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.6"/><path d="M9.4 8H4.6M6.6 6l-2 2 2 2"/>',
  'empty-tray': '<path d="M2.8 9.2h2.8l1.1 1.8h2.6l1.1-1.8h2.8"/><path d="M2.8 9.2V12a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V9.2"/>',
  'empty-page': '<path d="M4.2 2.4h5.2l3.4 3.4v7.4a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 13.2V3.6A1.2 1.2 0 0 1 4.2 2.4Z"/><path d="M9.2 2.6v3.4h3.4"/>',
  'empty-broken': '<path d="M6.2 4.6H5.1a3.2 3.2 0 0 0 0 6.4h1.1M9.8 4.6h1.1a3.2 3.2 0 0 1 0 6.4h-1.1"/><path d="M8 6.2v1.2M8 9v1.2"/>',

  /* 搜索 */
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3 3"/>',
};

/** 8px 网格的两枚特例：按 8px 实际渲染给线宽，不套 16px 的 1.5。 */
const TINY = {
  'fail-solid': '<path d="M2 2l4 4M6 2L2 6" stroke-width="1.7"/>',
  'missing-body': '<circle cx="4" cy="4" r="2.5" stroke-width="1.4"/>',
};

/** @type {Record<string, string>} */
const VIEWBOX = { 'fail-solid': '0 0 8 8', 'missing-body': '0 0 8 8' };

/**
 * @param {string} name 图标名
 * @param {number} [size] 渲染边长：16 行内 / 20 控件 / 24 空状态
 * @param {string} [cls] 附加类名
 * @returns {string}
 */
export function icon(name, size = 16, cls = '') {
  const body = BODY[name] ?? TINY[name];
  if (body === undefined) throw new Error(`unknown_icon:${name}`);
  const viewBox = VIEWBOX[name] ?? '0 0 16 16';
  const stroke = name in TINY ? '' : ' stroke-width="1.5"';
  return `<svg class="ico${cls === '' ? '' : ` ${cls}`}" width="${size}" height="${size}" viewBox="${viewBox}"`
    + ` fill="none" stroke="currentColor"${stroke} stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * 角色 pill：可见部分只有图形，原名留给 `title`（原生悬停）与 `aria-label`（读屏）。
 * 不在这里附加任何解释性文案——悬浮只为不丢信息。
 * @param {string} name 原角色名（User / Assistant / Tool / System / Aux / Event）
 * @param {string} cls 角色色类
 * @returns {string}
 */
export function rolePill(name, cls) {
  const map = {
    User: 'role-user', Assistant: 'role-assistant', Tool: 'role-tool',
    System: 'role-system', Aux: 'role-aux', Event: 'role-event',
  };
  const art = map[name] ?? 'role-aux';
  return `<span class="row-label ico ${cls}" role="img" aria-label="${name}" title="${name}">${icon(art)}</span>`;
}
