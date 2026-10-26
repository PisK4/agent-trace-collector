// @ts-check
/**
 * 上下文分布图：把路由侧 prompt 分解（类一层、item 一层）铺成 treemap 与内容列表。
 * 布局纯函数：面积按真实值逐层守恒分配、铺满全部绘图区，空闲容量不进图——
 * 窗口与占用由读数行表达。渲染为绝对定位的 HTML button：名称与数值走正常
 * 文本布局、单行省略，溢出由容器裁剪；文字取舍按实测尺寸判定，不做像素级
 * 字宽估算。容器尺寸观察（ResizeObserver）与悬停联动由 app.js 负责，本模块
 * 只提供测量后的填充入口。布局算法（squarify，Bruls et al.）移植自 magpie
 * Routing 页的上下文卡（internal/gui/assets/context.js），输入是 magpie 派生的
 * 白名单标量，不在本仓重算分类。
 * @typedef {import('../src/queries/readings').PromptReading} PromptReading
 * @typedef {import('../src/queries/routes').PromptItem} PromptItem
 * @typedef {import('../src/queries/routes').RoutePromptPart} RoutePromptPart
 */

import { esc } from './html.js';
import { kk, partColor, partLabel, partRank } from './parts.js';

/** px²：item 布局面积低于此值并入成员集合（≥2 块才并；并完一类无保留块时整类一块）。 */
const MERGE_AREA = 950;
/** px：类别矩形最短边低于此值不拆 item 层，整类一块。 */
const SPLIT_MIN_EDGE = 24;
/** 绘制间隙（px）：布局坐标不含间隙，绘制时从每块四周各扣一半。 */
export const MAP_GAP = 2;
/** 文字可见阈值：宽度或高度低于行高需求时依次隐藏数值行与全部文字。 */
const NAME_MIN_H = 24;
const BOTH_MIN_H = 44;
const BOTH_MIN_W = 47;

/** item 的稳定身份：tile、列表行与点击明细共用的匹配键。 @param {string} kind @param {PromptItem} it */
export const iidOf = (kind, it) => `${kind}\u0001${it.tag ?? ''}\u0001${it.name}`;

/** magpie 的折叠桶与轮次有固定叫法；轮次明确标注是上游上下文轮，不是本仓结算轮。 @param {PromptItem} it */
export function itemLabel(it) {
  if (it.tag === 'turn') return `上下文第 ${it.name} 轮`;
  if (it.tag === 'turns') return `更早上下文 ${it.n ?? '?'} 轮`;
  if (it.tag === 'more') return `另外 ${it.n ?? '?'} 项`;
  return it.name;
}

/** tag 徽标文案：轮次与折叠桶自带叫法不重复挂徽标，未知 tag 原样显示。 @param {string | null} tag */
function tagText(tag) {
  if (tag === null || tag === '' || tag === 'turn' || tag === 'turns' || tag === 'more') return '';
  return ({ mcp: 'MCP', read: 'read', shell: 'shell', result: 'result', user: 'user', project: 'project', reminder: '提醒', skills: 'skills' })[tag] ?? tag;
}

/** 路径类 item 的目录前缀：名字在前、路径在后。 @param {PromptItem} it @param {string} kind */
function itemDir(it, kind) {
  if ((kind !== 'files' && kind !== 'memory') || !it.name.includes('/')) return '';
  return it.name.slice(0, it.name.lastIndexOf('/') + 1);
}

/**
 * squarify（Bruls, Huizing & van Wijk）：把 vals 按序铺进矩形，
 * 让各块边长尽量接近。返回铺好的矩形；零值与空矩形直接返回空。
 * @typedef {{v: number, item?: PromptItem, rest?: PromptItem[], part?: RoutePromptPart}} TileVal
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

/** item 排序：tokens 降序，同值按完整名与 tag 定序（稳定身份，不按下标）。 @param {PromptItem} a @param {PromptItem} b */
function cmpItems(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return String(a.tag ?? '').localeCompare(String(b.tag ?? ''));
}

/** 正值类别按语义次序排列：已知类别按登记序，未知类别保持数据出现顺序缀后。 @param {PromptReading} p */
function positiveParts(p) {
  return p.parts
    .map((part, index) => ({ part, index }))
    .filter(x => x.part.tokens > 0)
    .sort((a, b) => partRank(a.part.kind) - partRank(b.part.kind) || a.index - b.index)
    .map(x => x.part);
}

/**
 * 两层布局：类一层、类内 items 一层，全部按真实值分配、占满 W×H。
 * 类矩形太窄、太扁或面积不足两块下限时不拆 item 层，整类一块；
 * 布局后面积低于 MERGE_AREA 的碎项（≥2 块）并入一个成员集合再重排一次。
 * item 清单不覆盖类总量时，差额作为未逐项余量块如实占面积，不抬高各 item
 * 份额；不产生空闲块，不做数值抬升，分解之和与报告总量的差异不进几何。
 * @typedef {{key: string, kind: string, scope: 'item' | 'rest' | 'category', item: PromptItem | null, its: PromptItem[], name: string, tokens: number, x: number, y: number, w: number, h: number}} Tile
 * @param {PromptReading} p
 * @param {number} W @param {number} H
 * @returns {Tile[]}
 */
export function tilesOf(p, W, H) {
  /** @type {Tile[]} */
  const tiles = [];
  if (!(W > 0) || !(H > 0)) return tiles;
  const categoryTiles = squarify(positiveParts(p).map(part => ({ v: part.tokens, part })), 0, 0, W, H);
  for (const r of categoryTiles) {
    const part = /** @type {NonNullable<TileVal['part']>} */ (r.a.part);
    const categoryTile = () => tiles.push({
      key: part.kind, kind: part.kind, scope: 'category', item: null, its: [],
      name: partLabel(part.kind), tokens: part.tokens, x: r.x, y: r.y, w: r.w, h: r.h,
    });
    const items = [...(part.items ?? [])].filter(it => it.tokens > 0).sort((a, b) => b.tokens - a.tokens || cmpItems(a, b));
    if (items.length === 0 || Math.min(r.w, r.h) < SPLIT_MIN_EDGE || r.w * r.h < MERGE_AREA * 2) {
      categoryTile();
      continue;
    }
    const firstPass = squarify(items.map(it => ({ v: it.tokens, item: it })), r.x, r.y, r.w, r.h);
    const tiny = firstPass.filter(q => q.w * q.h < MERGE_AREA);
    const merge = tiny.length >= 2 && tiny.length < firstPass.length;
    const vals = merge
      ? firstPass.filter(q => q.w * q.h >= MERGE_AREA).map(q => q.a)
      : firstPass.map(q => q.a);
    // item 清单不覆盖类总量时（magpie 只逐项列出大头），未逐项的余量作为
    // 显式余量块参与布局，不抬高各 item 的面积份额；清单完整时没有这一块。
    const residual = Math.max(0, part.tokens - items.reduce((s, it) => s + it.tokens, 0));
    if (merge) {
      vals.push({ v: tiny.reduce((s, q) => s + (q.a.item?.tokens ?? 0), 0), rest: tiny.map(q => q.a.item).filter(it => it !== undefined) });
    }
    if (residual > 0) vals.push({ v: residual, rest: [] });
    const laid = merge || residual > 0 ? squarify(vals, r.x, r.y, r.w, r.h) : firstPass;
    for (const q of laid) {
      const it = q.a.item ?? null;
      if (it !== null) {
        tiles.push({ key: iidOf(part.kind, it), kind: part.kind, scope: 'item', item: it, its: [it], name: itemLabel(it), tokens: it.tokens, x: q.x, y: q.y, w: q.w, h: q.h });
      } else {
        const its = q.a.rest ?? [];
        const unitemized = its.length === 0;
        tiles.push({
          key: `${part.kind}\u0001\u0001${unitemized ? '#unitemized' : '#rest'}`, kind: part.kind, scope: 'rest', item: null, its,
          name: unitemized ? `${partLabel(part.kind)}其余部分` : `其余${partLabel(part.kind)} ${its.length} 项`,
          tokens: unitemized ? q.a.v : its.reduce((s, y) => s + y.tokens, 0),
          x: q.x, y: q.y, w: q.w, h: q.h,
        });
      }
    }
  }
  return tiles;
}

/**
 * 给定实测容器尺寸渲染 tile 层（无外壳）。tile 是 button：绝对定位占满布局矩形
 * 扣去四周间隙后的区域，名称与数值各占一行、单行省略；尺寸不足时依次只留
 * 名称、全部隐藏（信息由同页列表承担）。悬停与点击由 app.js 按 data-ctx-* 委托。
 * @param {PromptReading} p
 * @param {number} W @param {number} H @param {number} reqId
 * @returns {string}
 */
export function contextMapInnerHtml(p, W, H, reqId) {
  const tiles = tilesOf(p, W, H);
  if (tiles.length === 0) return '';
  const sum = p.parts.reduce((a, x) => a + Math.max(0, x.tokens), 0) || 1;
  const half = MAP_GAP / 2;
  const fmt = (/** @type {number} */ v) => v.toLocaleString('en-US');
  return tiles.map(t => {
    const x = t.x + half, y = t.y + half;
    const w = Math.max(0, t.w - MAP_GAP), h = Math.max(0, t.h - MAP_GAP);
    const bare = w < BOTH_MIN_W || h < NAME_MIN_H;
    const low = !bare && h < BOTH_MIN_H;
    const its = t.its.map(it => iidOf(t.kind, it)).join('\u0002');
    const label = t.item !== null
      ? `${partLabel(t.kind)} · ${itemLabel(t.item)}`
      : t.name;
    const aria = `${label}，${fmt(t.tokens)} tokens，占提示总量 ${Math.round(t.tokens / sum * 100)}%，打开明细`;
    return `<button type="button" class="ctx-tile${bare ? ' bare' : low ? ' low' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--c:${partColor(t.kind)}" data-ctx-key="${esc(t.key)}" data-ctx-kind="${esc(t.kind)}" data-ctx-its="${esc(its)}" data-ctx-scope="${t.scope}" data-ctx-req="${reqId}" aria-label="${esc(aria)}">` +
      `<span class="ctx-tname">${esc(t.name)}</span>` +
      `<span class="ctx-tval">${kk(t.tokens)} · ${Math.round(t.tokens / sum * 100)}%</span>` +
      `</button>`;
  }).join('');
}

/**
 * 矩阵外壳：容器尺寸由 CSS aspect-ratio 与 min/max-height 决定
 * （clamp(160px, 宽/2.4, 240px)），tile 由 app.js 测量后填充。
 * 无正值类别时返回空串，不留空容器。
 * @param {PromptReading} p @param {number} reqId
 */
export function contextMapShellHtml(p, reqId) {
  if (!p.parts.some(x => x.tokens > 0)) return '';
  const n = p.parts.filter(x => x.tokens > 0).length;
  return `<div class="ctx-map" data-ctx-map="${reqId}" role="group" aria-label="上下文构成：${kk(p.tokens)} tokens，${n} 类，面积按已用比例分配，块可点开明细"></div>`;
}

/**
 * 测量容器并填充 tile 层；宽高无效（折叠、离屏）时不写，等尺寸观察触发补算。
 * @param {HTMLElement} container @param {PromptReading} p @param {number} reqId
 */
export function fillContextMap(container, p, reqId) {
  const w = container.clientWidth, h = container.clientHeight;
  if (!(w > 0) || !(h > 0)) return;
  container.innerHTML = contextMapInnerHtml(p, w, h, reqId);
}

/**
 * 内容列表：全部类别的 item 跨类按 token 降序，默认前 8 行，其余折叠在
 * 「显示全部」里（details 的开合走既有 data-fold 恢复机制）。行是已保存条目，
 * 数量词写明条目口径，不冒充原始文件或调用总数。无 item 时返回空串。
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
  rows.sort((a, b) => b.it.tokens - a.it.tokens || cmpItems(a.it, b.it));
  const most = Math.max(1, ...rows.map(r => r.it.tokens));
  const sum = p.parts.reduce((a, x) => a + Math.max(0, x.tokens), 0) || 1;
  /** @param {{it: PromptItem, kind: string}} row */
  const rowHtml = (row) => {
    const { it, kind } = row;
    const dir = itemDir(it, kind);
    const base = it.tag === 'turn' || it.tag === 'turns' || it.tag === 'more' ? itemLabel(it) : it.name.slice(it.name.lastIndexOf('/') + 1);
    const xn = it.n !== null && it.n > 1 && it.tag !== 'turns' && it.tag !== 'more' ? `×${it.n}` : '';
    const tg = tagText(it.tag);
    const title = `${partLabel(kind)} · ${itemLabel(it)} · ${kk(it.tokens)} tokens · ${Math.round(it.tokens / sum * 100)}%`;
    return `<button type="button" class="ctx-row" data-ctx-key="${esc(iidOf(kind, it))}" data-ctx-kind="${esc(kind)}" data-ctx-req="${reqId}" aria-label="${esc(title)}，打开明细" title="${esc(title)}">
      <i class="dot" style="background:${partColor(kind)}"></i>
      <span class="nm"><b>${esc(base)}</b>${dir !== '' ? ` <small>${esc(dir)}</small>` : ''}</span>
      ${xn !== '' ? `<span class="xn">${xn}</span>` : ''}
      ${tg !== '' ? `<span class="tg">${esc(tg)}</span>` : ''}
      <span class="bar"><i style="width:${Math.max(2, it.tokens / most * 100).toFixed(1)}%;background:${partColor(kind)}"></i></span>
      <span class="v">${kk(it.tokens)}</span>
    </button>`;
  };
  const head = rows.slice(0, 8).map(rowHtml).join('');
  const tail = rows.slice(8);
  const more = tail.length > 0
    ? `<details class="ctx-more" data-fold="ctxmore:${reqId}"><summary><span class="when-closed">显示全部 ${rows.length} 个已保存条目</span><span class="when-open">收起</span></summary><div class="ctx-rows">${tail.map(rowHtml).join('')}</div></details>`
    : '';
  return `<div class="ctx-rows">${head}</div>${more}`;
}
