// @ts-check
/**
 * 单行呈现的纯函数：正文状态文案与回复完整性。
 * 无 DOM、无网络，测试直接断言输出；i18n 是本模块唯一的 web 内依赖（纯数据映射）。
 */

import { t } from './i18n.js';

/** @param {{body_state: string}} r @returns {string} */
export function bodyStateText(r) {
  if (r.body_state === 'available') return t('正文可读');
  if (r.body_state === 'pending') return t('正文未到');
  if (r.body_state === 'partial') return t('正文不完整');
  if (r.body_state === 'evicted') return t('正文已回收');
  if (r.body_state === 'summary') return t('OTLP 摘要');
  return t('协议暂不支持');
}

/** @param {{body_state: string, miss_reason?: string | null}} r @returns {string} */
export function bodyLabelText(r) {
  if (r.body_state === 'available') return t('正文可读，尚未读取；点开后才下载这一片。');
  if (r.body_state === 'pending') {
    return r.miss_reason ? t('正文未到：{reason}', { reason: r.miss_reason }) : t('正文未到');
  }
  if (r.body_state === 'partial') {
    return r.miss_reason ? t('正文不完整：{reason}', { reason: r.miss_reason }) : t('正文不完整');
  }
  if (r.body_state === 'evicted') {
    return r.miss_reason ? t('正文已回收：{reason}', { reason: r.miss_reason }) : t('正文已回收');
  }
  // OTLP span 的结构化摘要：有元数据、无权威正文，不冒充「正文可用」。
  if (r.body_state === 'summary') {
    return r.miss_reason ? t('正文来自 OTLP 摘要：{reason}', { reason: r.miss_reason }) : t('正文来自 OTLP 摘要');
  }
  return t('原对象已保存，暂不支持结构化解析。');
}

/** 空回复的完整性标签按状态分开；只有 absent 是「缺失回复」，其余是状态未知。 */
const EMPTY_REPLY_LABELS = /** @type {Record<string, string>} */ ({
  absent: '缺失回复', pending: '回复未到', evicted: '正文已回收',
  unsupported: '回复暂不可读', summary: '摘要无回复', partial: '正文不完整', invalid: '回复无法解析',
});

/**
 * 回复完整性（§3.4 四态）。截断是成功响应内的完整性状态，不推翻请求状态；
 * 缺失回复不标完成；finish 未报告或无法解析都算 unknown。
 * @param {{status: number | null}} row
 * @param {{state: string, finish: string | null} | null} view
 * @returns {{key: 'complete' | 'truncated' | 'unknown' | 'absent', label: string}}
 */
export function replyCompleteness(row, view) {
  void row;
  if (view === null) return { key: 'absent', label: t('缺失回复') };
  if (view.state !== 'ok') {
    return {
      key: view.state === 'absent' ? 'absent' : 'unknown',
      label: t(EMPTY_REPLY_LABELS[view.state] ?? '回复状态未知'),
    };
  }
  const finish = view.finish;
  if (finish === null) return { key: 'unknown', label: t('完整性未报告') };
  if (finish === 'length' || finish === 'max_tokens') return { key: 'truncated', label: t('回复截断') };
  if (['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use'].includes(finish)) {
    return { key: 'complete', label: t('回复完整') };
  }
  return { key: 'unknown', label: t('完整性未知（{finish}）', { finish }) };
}
