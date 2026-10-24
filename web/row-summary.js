// @ts-check
/**
 * 单行呈现的纯函数：用途标签、辅助行摘要、正文状态文案与回复完整性。
 * 无 DOM、无网络，测试直接断言输出。
 */

/** 用途标签；未知类别原样显示，不猜成对话。 @param {string|null|undefined} kind */
export function purposeLabel(kind) {
  if (kind === 'title') return '标题生成';
  if (kind === 'auto-mode-classifier') return '自动模式分类';
  if (kind === 'chat') return '对话';
  return kind ?? '未知用途';
}

/**
 * 辅助行只由派生用途决定：排除用途，或组阶段给出的 aux 角色。
 * 摘要文本里的任何字样都不参与判断。
 * @param {{purpose_chain?: string|null, chain_role?: string|null, [key: string]: unknown}} row
 * @returns {boolean}
 */
export function isAuxRow(row) {
  return row.purpose_chain === 'exclude' || row.chain_role === 'aux';
}

/** @param {{req_kind?: string|null, reply_preview?: string|null, model_title?: string|null}} row @returns {string} */
export function auxSummary(row) {
  const label = purposeLabel(row.req_kind);
  if (reqKindOf(row) === 'auto-mode-classifier') {
    const match = /<block>\s*(yes|no)\s*(?:<\/block>)?/i.exec(row.reply_preview ?? '');
    const verdict = match?.[1]?.toLowerCase();
    if (verdict === 'no') return `${label} · 放行`;
    if (verdict === 'yes') return `${label} · 拦截`;
    return `${label} · 判定未知`;
  }
  if (reqKindOf(row) === 'title') {
    return row.model_title === null || row.model_title === undefined
      ? label : `${label} · ${row.model_title}`;
  }
  return label;
}
/** @param {{req_kind?: string|null}} row @returns {string|null} */
const reqKindOf = (row) => row.req_kind ?? null;

/** @param {{body_state: string}} r @returns {string} */
export function bodyStateText(r) {
  if (r.body_state === 'available') return '正文可读';
  if (r.body_state === 'pending') return '正文未到';
  if (r.body_state === 'partial') return '正文不完整';
  if (r.body_state === 'evicted') return '正文已回收';
  return '协议暂不支持';
}

/** @param {{body_state: string, miss_reason?: string | null}} r @returns {string} */
export function bodyLabelText(r) {
  if (r.body_state === 'available') return '正文可读，尚未读取；点开后才下载这一片。';
  if (r.body_state === 'pending') return `正文未到${r.miss_reason ? `：${r.miss_reason}` : ''}`;
  if (r.body_state === 'partial') return `正文不完整${r.miss_reason ? `：${r.miss_reason}` : ''}`;
  if (r.body_state === 'evicted') return `正文已回收${r.miss_reason ? `：${r.miss_reason}` : ''}`;
  return '原对象已保存，暂不支持结构化解析。';
}

/**
 * 回复完整性（§3.4 四态）。截断是成功响应内的完整性状态，不推翻请求状态；
 * 缺失回复不标完成；finish 未报告或无法解析都算 unknown。
 * @param {{status: number | null}} row
 * @param {{state: string, finish: string | null} | null} view
 * @returns {{key: 'complete' | 'truncated' | 'unknown' | 'absent', label: string}}
 */
export function replyCompleteness(row, view) {
  void row;
  if (view === null || view.state === 'absent') return { key: 'absent', label: '缺失回复' };
  if (view.state === 'invalid') return { key: 'unknown', label: '回复无法解析' };
  const finish = view.finish;
  if (finish === null) return { key: 'unknown', label: '完整性未报告' };
  if (finish === 'length' || finish === 'max_tokens') return { key: 'truncated', label: '回复截断' };
  if (['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use'].includes(finish)) {
    return { key: 'complete', label: '回复完整' };
  }
  return { key: 'unknown', label: `完整性未知（${finish}）` };
}
