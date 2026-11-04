// @ts-check
/**
 * 右栏页签的唯一登记：次序即页签次序与滑动方向。零 import，url-route.js、
 * selection.js 与 app.js 共同消费，登记模块本身不反向 import 它们。
 *
 * scope 决定轮次态的点击语义：request 页签在轮次态点一下即回请求态，
 * turn 页签保留轮次态。新增一栏只在这里加一行，不再改五处硬编码。
 */

/** @typedef {'request' | 'turn'} TabScope */

/** @type {readonly {id: string; label: string; scope: TabScope}[]} */
export const RAIL_TABS = [
  { id: 'facts', label: '读数', scope: 'request' },
  { id: 'body', label: '正文', scope: 'request' },
  { id: 'tools', label: '工具', scope: 'request' },
  { id: 'route', label: '路由', scope: 'request' },
  { id: 'todo', label: '待办', scope: 'turn' },
];

export const DEFAULT_TAB = 'facts';

/** @param {string} id @returns {boolean} */
export function isTab(id) {
  return RAIL_TABS.some(tab => tab.id === id);
}

/** @param {string} id @returns {TabScope} */
export function scopeOf(id) {
  return RAIL_TABS.find(tab => tab.id === id)?.scope ?? 'request';
}
