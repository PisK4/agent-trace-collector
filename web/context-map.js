// @ts-check
/**
 * 上下文分布图：把路由侧 prompt 分解（类一层、item 一层）铺成 treemap 与内容列表。
 * 纯函数拼 SVG/HTML 字符串，不读写 DOM；悬停联动由 app.js 按 data-ctx-* 委托。
 * 布局算法（squarify，Bruls et al.）与可读性阈值移植自 magpie Routing 页的上下文卡
 * （internal/gui/assets/context.js），输入是 magpie 派生的白名单标量，不在本仓重算分类。
 *
 * 坐标系是标称布局宽（MAP_W×MAP_H）：输出 SVG 横向用百分比、纵向用像素，
 * tile 边界随右栏实际宽度伸缩、文字字号不变；文字取舍按标称宽判定，
 * 极窄右栏下的溢出由每 tile 的 clipPath 裁掉，不与相邻块重叠。
 * @typedef {import('../src/queries/readings').PromptReading} PromptReading
 * @typedef {import('../src/queries/routes').PromptItem} PromptItem
 */

import { esc } from './html.js';
import { kk, partColor, partLabel, partSlot } from './parts.js';

/** px²：item 面积小于此值不进第二层，整类一块。 */
const TILE_MIN = 1500;
/** 一类最多拆出的 item tile 数，超出并入「另外 N 项」。 */
const TILE_MAX = 12;
/** px²：tile 最小面积，细条无法指认。 */
const TILE_FLOOR = 700;
/** 标称布局宽：右栏可拖区间的内容宽窄档；实际渲染按百分比伸缩。 */
const MAP_W = 340;
/** treemap 固定高：与右栏宽度无关。 */
const MAP_H = 132;

/** item 面积占比换算用：10px 字号下 CJK 记 10px、其余记 5.5px 的粗估。 @param {string} s @param {number} size */
function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.55;
  return w;
}

/** 超宽文本截断加省略号；窄 tile 上宁可短不可重叠。 @param {string} s @param {number} maxPx @param {number} size */
function fitText(s, maxPx, size) {
  if (textWidth(s, size) <= maxPx) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxPx) break;
    out += ch;
  }
  return out + '…';
}

/** 路径类 item 的目录前缀：名字在前、路径在后。 @param {PromptItem} it @param {string} kind */
function itemDir(it, kind) {
  if ((kind !== 'files' && kind !== 'memory') || !it.name.includes('/')) return '';
  return it.name.slice(0, it.name.lastIndexOf('/') + 1);
}

/** magpie 的折叠桶与轮次有固定叫法，其余按原名。 @param {PromptItem} it */
function itemLabel(it) {
  if (it.tag === 'turn') return `第 ${it.name} 轮`;
  if (it.tag === 'turns') return `更早 ${it.n ?? '?'} 轮`;
  if (it.tag === 'more') return `另外 ${it.n ?? '?'} 项`;
  return it.name;
}

/** tag 徽标文案：轮次与折叠桶自带叫法不重复挂徽标，未知 tag 原样显示。 @param {string | null} tag */
function tagText(tag) {
  if (tag === null || tag === '' || tag === 'turn' || tag === 'turns' || tag === 'more') return '';
  return ({ mcp: 'MCP', read: 'read', shell: 'shell', result: 'result', user: 'user', project: 'project', reminder: '提醒', skills: 'skills' })[tag] ?? tag;
}

/** item 的稳定身份：tile 与列表行联动的匹配键。 @param {string} kind @param {PromptItem} it */
const iidOf = (kind, it) => `${kind}\u0001${it.tag ?? ''}\u0001${it.name}`;

/**
 * squarify（Bruls, Huizing & van Wijk）：把 vals 按序铺进矩形，
 * 让各块边长尽量接近。返回铺好的矩形；零值与空矩形直接返回空。
 * @typedef {{v: number, it?: PromptItem, rest?: PromptItem[], x?: unknown}} TileVal
 * @typedef {{a: TileVal, x: number, y: number, w: number, h: number}} Laid
 * @param {TileVal[]} vals
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {Laid[]}
 */
function squarify(vals, x, y, w, h) {
  /** @type {Laid[]} */
  const out = [];
  vals = vals.filter(a => a.v > 0);
  const total = vals.reduce((s, a) => s + a.v, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const k = (w * h) / total;
  const worst = (/** @type {TileVal[]} */ row, /** @type {number} */ side) => {
    let sum = 0, hi = 0, lo = Infinity;
    for (const a of row) { const s = a.v * k; sum += s; hi = Math.max(hi, s); lo = Math.min(lo, s); }
    return Math.max((side * side * hi) / (sum * sum), (sum * sum) / (side * side * lo));
  };
  const lay = (/** @type {TileVal[]} */ row) => {
    const sum = row.reduce((s, a) => s + a.v * k, 0);
    if (w >= h) {
      const cw = sum / h;
      let cy = y;
      for (const a of row) { const ch = (a.v * k) / cw; out.push({ a, x, y: cy, w: cw, h: ch }); cy += ch; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const a of row) { const cw = (a.v * k) / rh; out.push({ a, x: cx, y, w: cw, h: rh }); cx += cw; }
      y += rh; h -= rh;
    }
  };
  /** @type {TileVal[]} */
  let row = [];
  for (const a of vals) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, a], side) <= worst(row, side)) { row.push(a); continue; }
    lay(row);
    row = [a];
  }
  if (row.length) lay(row);
  return out;
}

/**
 * 两层布局：类一层、类内 items 一层；有窗口时已用区与空闲区按 share^0.35 缓动
 * 分区（低占用时已用区仍可读，高占用时接近线性）。类按 parts 数据出现顺序铺，
 * 不依赖前端类别清单。碎项合并为一块；放不下第二层的类整类一块。
 * @param {PromptReading} p
 * @param {number} W @param {number} H
 * @returns {{key: string, kind: string, item: PromptItem | null, its: PromptItem[], name: string | null, tokens: number, x: number, y: number, w: number, h: number, free?: boolean}[]}
 */
export function tilesOf(p, W, H) {
  const win = p.window ?? null;
  const scale = Math.max(win ?? 0, p.tokens ?? 0, 1);
  const across = W >= H;
  const long = across ? W : H;
  let usedLen = long;
  if (win !== null && (p.tokens ?? 0) < scale) {
    usedLen = Math.min(long, Math.max(long * Math.pow((p.tokens ?? 0) / scale, 0.35), Math.min(long, 36)));
  }
  const tiles = [];
  const parts = p.parts.filter(x => x.tokens > 0);
  const ur = across ? [0, 0, usedLen, H] : [0, 0, W, usedLen];
  const floored = (/** @type {{v: number}[]} */ vals, /** @type {number} */ area) => {
    const sum = vals.reduce((s, a) => s + a.v, 0);
    const lo = (sum * TILE_FLOOR) / Math.max(1, area);
    return vals.map(a => ({ ...a, v: Math.max(a.v, lo) }));
  };
  for (const r of squarify(floored(parts.map(part => ({ v: part.tokens, x: part })), ur[2] * ur[3]), ur[0], ur[1], ur[2], ur[3])) {
    const part = /** @type {import('../src/queries/routes').RoutePromptPart} */ (r.a.x);
    const items = [...(part.items ?? [])].filter(it => it.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    const isum = items.reduce((s, it) => s + it.tokens, 0);
    const area = r.w * r.h;
    if (items.length === 0 || area < TILE_MIN * 2) {
      tiles.push({ key: part.kind, kind: part.kind, item: null, its: items, name: null, tokens: part.tokens, x: r.x, y: r.y, w: r.w, h: r.h });
      continue;
    }
    const kept = [], rest = [];
    for (const it of items) {
      if (kept.length < TILE_MAX && (it.tokens / isum) * area >= TILE_MIN) kept.push(it);
      else rest.push(it);
    }
    /** @type {TileVal[]} */
    const vals = kept.map(it => ({ v: it.tokens, it }));
    if (rest.length === 1 && kept.length === 0) vals.push({ v: rest[0].tokens, it: rest[0] });
    else if (rest.length > 0) vals.push({ v: rest.reduce((s, it) => s + it.tokens, 0), rest });
    const laid = squarify(floored(vals, area), r.x, r.y, r.w, r.h);
    if (laid.some(q => Math.min(q.w, q.h) < 13)) {
      tiles.push({ key: part.kind, kind: part.kind, item: null, its: items, name: null, tokens: part.tokens, x: r.x, y: r.y, w: r.w, h: r.h });
      continue;
    }
    for (const q of laid) {
      const it = q.a.it ?? null;
      const its = it !== null ? [it] : q.a.rest ?? [];
      tiles.push({
        key: it !== null ? iidOf(part.kind, it) : `${part.kind}\u0001\u0001#rest`,
        kind: part.kind,
        item: it,
        its,
        name: it !== null ? itemLabel(it) : `另外 ${its.length} 项`,
        tokens: ((it !== null ? it.tokens : its.reduce((s, y) => s + y.tokens, 0)) / isum) * part.tokens,
        x: q.x, y: q.y, w: q.w, h: q.h,
      });
    }
  }
  if (win !== null && (p.tokens ?? 0) < scale) {
    const fr = across ? [usedLen, 0, W - usedLen, H] : [0, usedLen, W, H - usedLen];
    tiles.push({ key: '\u0001free', kind: '', item: null, its: [], name: '空闲', tokens: scale - (p.tokens ?? 0), x: fr[0], y: fr[1], w: fr[2], h: fr[3], free: true });
  }
  return tiles;
}

/** 标称宽到百分比；纵向固定像素。 @param {number} v */
const px = (v) => (v / MAP_W * 100).toFixed(2);

/**
 * treemap SVG。tile 底色用主题槽位变量，文字色按槽位由 CSS 决定（app.css 按主题
 * 写好每个槽位的深/白）；tile 与内容列表行都以 data-ctx-key/data-ctx-its 参与悬停联动。
 * 无正值类别时返回空串，不留空容器。
 * @param {PromptReading} p
 * @param {number} reqId clipPath id 防碰撞的命名空间
 * @returns {string}
 */
export function contextMapHtml(p, reqId) {
  if (p.tokens === null || !p.parts.some(x => x.tokens > 0)) return '';
  const tiles = tilesOf(p, MAP_W, MAP_H);
  const sum = p.parts.reduce((a, x) => a + x.tokens, 0) || 1;
  const gap = 2;
  /** @type {string[]} */
  const defs = [];
  /** @type {string[]} */
  const body = [];
  tiles.forEach((t, i) => {
    const x = t.x + gap / 2, y = t.y + gap / 2;
    const w = Math.max(0, t.w - gap), h = Math.max(0, t.h - gap);
    const rx = px(x), rw = px(w);
    const iids = t.its.map(it => iidOf(t.kind, it)).join('\u0002');
    if (t.free === true) {
      let label = '';
      if (w > 46 && h > 16) {
        label = `<text class="ctx-tl" x="${px(x + w / 2)}" y="${(y + h / 2 + 3.5).toFixed(1)}" text-anchor="middle">空闲 ${kk(t.tokens)}</text>`;
      }
      body.push(`<g class="ctx-tile" data-ctx-key="${esc(t.key)}"><title>空闲 · ${kk(t.tokens)} tokens</title>` +
        `<rect x="${rx}%" y="${y.toFixed(1)}" width="${rw}%" height="${h.toFixed(1)}" rx="3" fill="var(--inset)" stroke="var(--line)" stroke-dasharray="3 3"/>${label}</g>`);
      return;
    }
    defs.push(`<clipPath id="ctxc${reqId}-${i}"><rect x="${rx}%" y="${y.toFixed(1)}" width="${rw}%" height="${h.toFixed(1)}"/></clipPath>`);
    const slot = partSlot(t.kind);
    const dir = t.item !== null ? itemDir(t.item, t.kind) : '';
    // 类级块（没进第二层的整类）与 rest 合并块显示各自的名字；item 块显示 item 名。
    const tileName = t.name ?? partLabel(t.kind);
    let label = '';
    if (w >= 46 && h >= 28) {
      const nm = fitText(tileName, w - 10, 10);
      label = `<text class="ctx-tl" x="${px(x + 5)}" y="${(y + 13).toFixed(1)}">${esc(nm)}</text>`;
      if (dir !== '' && h >= 44 && w >= 76) {
        label += `<text class="ctx-tv" x="${px(x + 5)}" y="${(y + 25).toFixed(1)}" opacity=".72">${esc(fitText(dir, w - 10, 9))}</text>`;
      }
      if (h >= 42) {
        label += `<text class="ctx-tv ctx-num" x="${px(x + 5)}" y="${(y + h - 5).toFixed(1)}">${kk(t.tokens)} · ${Math.round(t.tokens / sum * 100)}%</text>`;
      }
    }
    const title = t.item !== null
      ? `${partLabel(t.kind)} · ${itemLabel(t.item)} · ${kk(t.item.tokens)} tokens · ${Math.round(t.item.tokens / sum * 100)}%`
      : `${partLabel(t.kind)} · ${kk(t.tokens)} tokens · ${Math.round(t.tokens / sum * 100)}%`;
    body.push(`<g class="ctx-tile ck-${slot}" data-ctx-key="${esc(t.key)}"${iids !== '' ? ` data-ctx-its="${esc(iids)}"` : ''}>` +
      `<title>${esc(title)}</title>` +
      `<rect x="${rx}%" y="${y.toFixed(1)}" width="${rw}%" height="${h.toFixed(1)}" rx="3" fill="${partColor(t.kind)}" clip-path="url(#ctxc${reqId}-${i})"/>${label}</g>`);
  });
  return `<div class="ctx-map"><svg height="${MAP_H}" role="img" aria-label="上下文构成：${kk(p.tokens)} tokens，${p.parts.filter(x => x.tokens > 0).length} 类"><defs>${defs.join('')}</defs>${body.join('')}</svg></div>`;
}

/**
 * 内容列表：全部类别的 item 跨类按 token 降序，默认前 8 行，其余折叠在
 * 「显示全部」里（details 的开合走既有 data-fold 恢复机制）。无 item 时返回空串。
 * @param {PromptReading} p
 * @param {number} reqId
 * @returns {string}
 */
export function contextRowsHtml(p, reqId) {
  /** @type {{it: PromptItem, kind: string}[]} */
  const rows = [];
  for (const part of p.parts) {
    for (const it of part.items ?? []) {
      if (it.tokens > 0) rows.push({ it, kind: part.kind });
    }
  }
  if (rows.length === 0) return '';
  rows.sort((a, b) => b.it.tokens - a.it.tokens);
  const most = Math.max(1, ...rows.map(r => r.it.tokens));
  const sum = p.parts.reduce((a, x) => a + x.tokens, 0) || 1;
  /** @param {{it: PromptItem, kind: string}} row */
  const rowHtml = (row) => {
    const { it, kind } = row;
    const dir = itemDir(it, kind);
    const base = it.tag === 'turn' || it.tag === 'turns' || it.tag === 'more' ? itemLabel(it) : it.name.slice(it.name.lastIndexOf('/') + 1);
    const xn = it.n !== null && it.n > 1 && it.tag !== 'turns' && it.tag !== 'more' ? `×${it.n}` : '';
    const tg = tagText(it.tag);
    const title = `${partLabel(kind)} · ${itemLabel(it)} · ${kk(it.tokens)} tokens · ${Math.round(it.tokens / sum * 100)}%`;
    return `<div class="ctx-row" data-ctx-key="${esc(iidOf(kind, it))}" title="${esc(title)}">
      <i class="dot" style="background:${partColor(kind)}"></i>
      <span class="nm"><b>${esc(base)}</b>${dir !== '' ? ` <small>${esc(dir)}</small>` : ''}</span>
      ${xn !== '' ? `<span class="xn">${xn}</span>` : ''}
      ${tg !== '' ? `<span class="tg">${esc(tg)}</span>` : ''}
      <span class="bar"><i style="width:${Math.max(2, it.tokens / most * 100).toFixed(1)}%;background:${partColor(kind)}"></i></span>
      <span class="v">${kk(it.tokens)}</span>
    </div>`;
  };
  const head = rows.slice(0, 8).map(rowHtml).join('');
  const tail = rows.slice(8);
  const more = tail.length > 0
    ? `<details class="ctx-more" data-fold="ctxmore:${reqId}"><summary><span class="when-closed">显示全部 ${rows.length} 项</span><span class="when-open">收起</span></summary><div class="ctx-rows">${tail.map(rowHtml).join('')}</div></details>`
    : '';
  return `<div class="ctx-rows">${head}</div>${more}`;
}
