// @ts-check
/**
 * 上下文构成视图的共享原语：类别口径（kind→标签、份额档位与路径类判定）、
 * token 缩写与路径类可见名折算。
 * rail-facts 的构成条与图例、context-map 的 treemap 与内容列表共用同一口径；
 * magpie 拆出新类时只在 PARTS 加一行映射，未知 kind 原样显示名字。
 * 视觉口径：类别不再分色（方向 A 第 6 步），构成面积按份额落 --t1..t4 四档单色。
 */

const PARTS = [
  { kind: 'system', label: '系统提示' },
  { kind: 'tools', label: '工具定义' },
  { kind: 'memory', label: '记忆' },
  { kind: 'files', label: '文件引用' },
  { kind: 'results', label: '工具结果' },
  { kind: 'chat', label: '对话内容' },
  { kind: 'skills', label: '技能' },
];

/** 未知 kind 原样显示，不折叠成"其它"。 @param {string} kind */
export function partLabel(kind) {
  return PARTS.find(part => part.kind === kind)?.label ?? String(kind);
}

/**
 * 份额档位：占提示总量的比例落四档单色，份额越大越实。
 * 阈值是示意值（提案 Risk 已预告），用真实会话验证深浅两主题区分度后可调。
 * @param {number} tokens @param {number} sum
 * @returns {string} CSS 变量引用（--t1..t4）
 */
export function partShade(tokens, sum) {
  const share = sum > 0 ? tokens / sum : 0;
  if (share >= 0.15) return 'var(--t1)';
  if (share >= 0.07) return 'var(--t2)';
  if (share >= 0.03) return 'var(--t3)';
  return 'var(--t4)';
}

/** 类别语义次序：已知类别按登记序，未知类别返回登记数（调用方再按数据出现序稳定排序）。 @param {string} kind */
export function partRank(kind) {
  const i = PARTS.findIndex(part => part.kind === kind);
  return i === -1 ? PARTS.length : i;
}

/** token 缩写：1.2M / 74.4k / 980；缺值显示 —，不当作 0。 @param {number | null | undefined} v */
export const kk = (v) => (v == null ? '—' : v >= 1000000 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v));

/** 路径类类别：可见名只留 basename，完整名字由 title 与 aria-label 承担。 */
const PATH_KINDS = new Set(['files', 'memory']);

/** @param {string} kind */
export const isPathKind = (kind) => PATH_KINDS.has(kind);

/** 固定开销类别：与对话无关、每笔请求都要背的部分；其余类别随对话增长。 */
const FIXED_KINDS = new Set(['system', 'tools', 'skills', 'memory']);

/** @param {string} kind */
export const isFixedKind = (kind) => FIXED_KINDS.has(kind);

/** 末段路径：没有目录时原样返回，末尾斜杠不算名字。 @param {string} name */
export const baseNameOf = (name) => {
  const parts = name.split('/').filter(Boolean);
  return parts.length === 0 ? name : parts[parts.length - 1];
};
