// @ts-check
/**
 * 动效统一入口：页面所有 JS 驱动的动画都经这里，reduced-motion 或浏览器
 * 缺 WAAPI 时短路返回 null，调用方按 null 跳过等待。CSS 侧的 transition 与
 * keyframes 由 app.css 动效区的 media blanket 统一关闭，两边口径一致。
 * 时长单位是秒；easing 默认取 app.css --ease-out 同一条 bezier。
 */
import { animate } from './motion.vendor.js';

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = [0, 0, 0.2, 1];

/**
 * @param {Element} el
 * @param {Record<string, (string | number)[]>} keyframes 属性 → 关键帧数组（Motion 原生形状）
 * @param {number} [duration] 秒，默认 0.15
 * @returns {{ finished: Promise<unknown>, cancel: () => void } | null}
 */
export function motion(el, keyframes, duration = 0.15) {
  if (REDUCE.matches || typeof el.animate !== 'function') return null;
  return animate(el, keyframes, { duration, easing: EASE });
}
