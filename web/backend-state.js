// @ts-check
/**
 * 后端存储准入的单行呈现。只在降级时给出标签与说明；normal、未记录与未知模式
 * 都不占顶栏。文案只陈述准入模式与原因，不推断哪些数据已经丢失。
 */
import { esc } from './html.js';

/**
 * @typedef {{mode: string, reason: string | null, at_ms: number | null}} Admission
 * @param {Admission | null | undefined} admission
 * @returns {{level: 'warn' | 'bad', label: string, detail: string} | null}
 */
export function backendStateText(admission) {
  if (admission === null || admission === undefined) return null;
  if (admission.mode === 'metadata_only') {
    const why = admission.reason === 'body_budget' ? '正文预算已满' : '磁盘预算已满';
    return {
      level: 'warn',
      label: '存储降级 · 正文暂停',
      detail: `${why}：只收元数据，新请求的正文不再保存；账本、路由与请求元数据仍在接收。点按重新读取。`,
    };
  }
  if (admission.mode === 'paused') {
    const why = admission.reason === 'disk_free' ? '磁盘剩余空间不足' : '磁盘预算已满';
    return {
      level: 'bad',
      label: '存储降级 · 采集暂停',
      detail: `${why}：写入被拒绝，新的请求证据不会入库。点按重新读取。`,
    };
  }
  return null;
}

/**
 * 顶栏降级标签：正常态返回空串，不占位置。按钮本身就是重新读取入口，
 * 展开的说明给出原因与影响范围。
 * @param {Admission | null | undefined} admission
 * @returns {string}
 */
export function backendStateHtml(admission) {
  const state = backendStateText(admission);
  if (state === null) return '';
  return `<button class="backend-chip ${state.level}" id="backend-state" title="${esc(state.detail)}">`
    + `<span class="d" aria-hidden="true"></span>${esc(state.label)}</button>`;
}
