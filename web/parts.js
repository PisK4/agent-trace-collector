// @ts-check
/**
 * 上下文构成视图的共享原语：类别口径（kind→标签与色槽）与 token 缩写。
 * rail-facts 的构成条与图例、context-map 的 treemap 与内容列表共用同一口径；
 * magpie 拆出新类时只在 PARTS 加一行映射，未知 kind 原样显示名字、落灰槽。
 */

const PARTS = [
  { kind: 'system', label: '系统提示', slot: 'p1' },
  { kind: 'tools', label: '工具定义', slot: 'p2' },
  { kind: 'memory', label: '记忆', slot: 'p3' },
  { kind: 'files', label: '文件引用', slot: 'p4' },
  { kind: 'results', label: '工具结果', slot: 'p5' },
  { kind: 'chat', label: '对话内容', slot: 'p6' },
  { kind: 'skills', label: '技能', slot: 'p7' },
];

/** 未知 kind 原样显示，不折叠成"其它"。 @param {string} kind */
export function partLabel(kind) {
  return PARTS.find(part => part.kind === kind)?.label ?? String(kind);
}

/** 色槽名（p1..p7 / p-unknown），treemap 的文字色类同用。 @param {string} kind */
export function partSlot(kind) {
  return PARTS.find(part => part.kind === kind)?.slot ?? 'p-unknown';
}

/** 类别语义次序：已知类别按登记序，未知类别返回登记数（调用方再按数据出现序稳定排序）。 @param {string} kind */
export function partRank(kind) {
  const i = PARTS.findIndex(part => part.kind === kind);
  return i === -1 ? PARTS.length : i;
}

/** 未知 kind 使用独立颜色变量，避免落到某个已知类别上。 @param {string} kind */
export function partColor(kind) {
  return `var(--${partSlot(kind)})`;
}

/** token 缩写：1.2M / 74.4k / 980；缺值显示 —，不当作 0。 @param {number | null | undefined} v */
export const kk = (v) => (v == null ? '—' : v >= 1000000 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v));
