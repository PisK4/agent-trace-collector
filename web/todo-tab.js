// @ts-check
/** 第五页签：只拼 HTML 字符串，不读写 DOM、不发起读取；测试直接断言输出。 */
import { esc } from './html.js';
import { t } from './i18n.js';

/**
 * @param {{status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries/todo-by-turn').TodoByTurn | null}} reading
 * @returns {string}
 */
export function todoTabHtml(reading) {
  if (reading.status === 'loading' || reading.status === 'idle') {
    return `<div class="rail-empty">${t('读取中')}</div>`;
  }
  if (reading.status === 'absent' || reading.data === null) {
    return `<div class="rail-empty">${t('读取失败')}</div>`;
  }
  const { state, snapshot } = reading.data;
  if (state === 'failed') {
    return `<div class="rail-empty">${t('读取失败')}</div>`;
  }
  if (state === 'unavailable') {
    return `<div class="rail-empty">${t('正文已回收，待办不可读')}</div>`;
  }
  if (state !== 'ready' || snapshot === null) {
    return `<div class="rail-empty">${t('本轮没有待办')}</div>`;
  }
  if (snapshot.items.length === 0) {
    return `<div class="rail-empty">${t('本轮没有待办')}</div>`;
  }
  const rows = snapshot.items.map(item => `<li class="todo-item">
    <span class="todo-status">${esc(item.status)}</span>
    <span class="todo-content">${esc(item.content)}</span>
  </li>`).join('');
  return `<section class="rail-section"><ul class="todo-list">${rows}</ul></section>`;
}
