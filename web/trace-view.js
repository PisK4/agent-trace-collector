// @ts-check
import { deltaOrdinals, messageBlocks, replyView } from './body-view.js';

/**
 * 步骤投影：把可信输入与实际回复变成单行轨迹步骤。纯函数、无 DOM、无网络；
 * 状态语义来自 Task 0 验证过的原型口径（§3.4）：
 * 请求级状态（失败/缺正文/缺回复/截断/未知）与工具关联分立，
 * 结果正文是否已读由 reader-store 决定，不写进投影。
 */

/**
 * @typedef {Object} TraceStep 单行轨迹的一步。
 * @property {string} key 稳定键：reqId:message:N / reqId:reply:text:N / reqId:call:N 等
 * @property {number} reqId
 * @property {'user'|'assistant'|'tool'|'record'|'aux'} kind
 * @property {string} text 行文本（工具行是动作摘要）
 * @property {number|null} messageOrd
 * @property {number|null} callOrd
 * @property {unknown} raw 原文或原始块
 * @property {boolean} unrecognized
 * @property {'failed'|'missing_body'|'missing_reply'|'unknown'|'truncated'|null} status
 * @property {{state: 'resolved'|'pending'|'ambiguous'|'unpaired', reqId: number|null} | null} result
 */

/** @param {unknown} value @returns {string} */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (/** @param {string} c */ c) => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c] ?? c
));

const LENGTH_FINISH = new Set(['length', 'max_tokens']);
const NORMAL_FINISH = new Set(['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use']);

/** 工具行动作对象：命令、路径或查询优先，结果正文不当结论。 @param {string} name @param {string} inputText @returns {string} */
export function toolSummary(name, inputText) {
  let args = null;
  try { args = JSON.parse(inputText); } catch { /* 非 JSON 参数按原文展示 */ }
  const value = args !== null && typeof args === 'object'
    ? args.command ?? args.cmd ?? args.file_path ?? args.path ?? args.pattern ?? inputText
    : inputText;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // 摘要只用于显示：超长动作对象截断，原文进详情。
  const clipped = [...text].length <= 140 ? text : `${[...text].slice(0, 140).join('')}…`;
  return `${name || '未命名工具'} · ${clipped}`;
}

/**
 * @param {import('../src/queries').RequestRow} row
 * @param {import('./reader-store.js').RequestRead | null} read
 * @returns {TraceStep[]}
 */
export function projectSteps(row, read) {
  /** @type {TraceStep[]} */
  const steps = [];
  const detail = read?.detail ?? null;
  /** @param {string} key @param {TraceStep['status']} status @param {string} text @param {Partial<TraceStep>} [extra] */
  const record = (key, status, text, extra = {}) => {
    steps.push(/** @type {TraceStep} */ ({
      key: `${row.req_id}:${key}`, reqId: row.req_id, kind: 'record', text,
      messageOrd: null, callOrd: null, raw: null, unrecognized: false,
      status, result: null, ...extra,
    }));
  };
  // 辅助请求一笔一条辅助记录：分类器输入不画成用户消息。
  if (row.purpose_chain === 'exclude' || row.chain_role === 'aux') {
    steps.push({ key:`${row.req_id}:aux`, reqId: row.req_id, kind: 'aux',
      text: `辅助请求 · ${row.req_kind === 'title' ? '标题生成' : row.req_kind}`,
      messageOrd: null, callOrd: null, raw: null, unrecognized: false,
      status: null, result: null });
    return steps;
  }
  if (row.chain_role === 'branch') {
    record('branch', null, '分支链请求 · 归属来自派生记录，不按时间推断父子');
  }
  // 读取未完成时是加载/状态记录，不能把请求级 input_preview 拆成确定用户步骤。
  if (read === null || detail === null) {
    record('loading', row.status !== null && row.status >= 400 ? 'failed'
      : row.body_state !== 'available' && row.body_state !== 'partial' ? 'missing_body' : null,
    read === null ? '读取中' : '请求详情不可用');
    return steps;
  }
  // 可信新增：只认 delta 里的输入解释；dirty/unknown/branch 的 delta 不升级。
  const trusted = deltaOrdinals(detail);
  if (trusted === null) {
    record('uncertain', detail.prev_relation === 'unknown' || detail.derived_state !== 'current'
      ? 'unknown' : null,
    `新增输入未确认 · ${detail.prev_relation ?? detail.derived_state}`);
  } else {
    for (const entry of read.entries) {
      if (!trusted.has(entry.ord) || !entry.isInput) continue;
      if (entry.input?.state === 'text') {
        steps.push({ key:`${row.req_id}:message:${entry.ord}`, reqId: row.req_id, kind: 'user',
          text: entry.input.text, messageOrd: entry.ord, callOrd: null,
          raw: entry.input.original ?? entry.input.text, unrecognized: false,
          status: null, result: null });
      } else {
        // unrecognized 输入也是新增事实：占一行，原文进详情。
        steps.push({ key:`${row.req_id}:message:${entry.ord}`, reqId: row.req_id, kind: 'user',
          text: entry.input?.text ?? '未识别的用户输入', messageOrd: entry.ord, callOrd: null,
          raw: entry.input?.original ?? null, unrecognized: true,
          status: null, result: null });
      }
    }
  }
  // 回复块按协议原始顺序；thinking 不常驻，多 choice 不结构化拆行。
  const meta = read?.meta ?? null;
  const view = meta === null ? null : replyView(meta);
  if (view === null || view.state === 'absent') {
    record('reply', 'missing_reply', '未收到回复');
  } else if (meta !== null) {
    const reply = /** @type {{content?: unknown, choices?: {message: unknown}[]} | null} */ (meta.reply ?? null);
    const choices = Array.isArray(reply?.choices) ? reply.choices : null;
    const multi = choices !== null && choices.length > 1;
    if (multi) {
      record('choices', null, `多 choice 回复（${choices.length} 项）：保留原始对象，不按冲突序号提供工具定位`);
    } else {
      // 两类协议统一经 messageBlocks 归一化：Anthropic 读 content 数组，
      // Chat 的 tool_calls 在消息层，提升为 call 块；块序号沿用协议内位置。
      const blocks = reply !== null && Array.isArray(reply.content)
        ? messageBlocks({ role: 'assistant', content: reply.content })
        : choices !== null && choices.length === 1
          ? messageBlocks(choices[0]?.message ?? {})
          : [];
      for (const block of blocks) {
        const index = block.index;
        if (block.kind === 'text' && block.text.length > 0) {
          steps.push({ key:`${row.req_id}:reply:text:${index}`, reqId: row.req_id, kind: 'assistant',
            text: block.text, messageOrd: null, callOrd: null, raw: block.text,
            unrecognized: false, status: null, result: null });
        } else if (block.kind === 'call') {
          const call = view.calls.find(item => item.ord === index) ?? null;
          const pair = detail.tool_calls?.find(item => item.ord === index) ?? null;
          steps.push({ key:`${row.req_id}:call:${index}`, reqId: row.req_id, kind: 'tool',
            text: toolSummary(call?.name ?? '', call?.inputText ?? ''),
            messageOrd: null, callOrd: index, raw: block.raw,
            unrecognized: false, status: null,
            result: pair === null ? null : { state: /** @type {'resolved'|'pending'|'ambiguous'|'unpaired'} */ (pair.state), reqId: pair.result_req } });
        } else if (block.kind !== 'thinking') {
          // 未知块给记录入口，不做语义推测。
          steps.push({ key:`${row.req_id}:reply:block:${index}`, reqId: row.req_id, kind: 'record',
            text: `未知回复块 kind=${block.kind}`, messageOrd: null, callOrd: null,
            raw: block.raw, unrecognized: true, status: null, result: null });
        }
      }
      if (blocks.length === 0 && view.text.length > 0) {
        steps.push({ key:`${row.req_id}:reply:text:0`, reqId: row.req_id, kind: 'assistant',
          text: view.text, messageOrd: null, callOrd: null, raw: view.text,
          unrecognized: false, status: null, result: null });
      }
    }
  }
  // 请求级记录：已有内容步骤也保留，不用 !steps.length 当唯一条件。
  if (row.status !== null && row.status >= 400) {
    record('http', 'failed', `请求失败 · HTTP ${row.status}；已收到的输入与回复仍保留在步骤里`);
  } else if (row.status === null) {
    record('http', 'unknown', 'HTTP 状态未知');
  }
  if (view !== null && view.state !== 'absent') {
    if (LENGTH_FINISH.has(view.finish ?? '')) {
      record('truncated', 'truncated', `回复因长度上限结束（finish=${view.finish}）；请求仍为 HTTP 成功`);
    } else if (view.finish !== null && !NORMAL_FINISH.has(view.finish)) {
      record('finish', 'unknown', `停止原因未知 · ${view.finish}（按原值显示，不判失败）`);
    }
  }
  if (row.body_state !== 'available' && row.body_state !== 'partial') {
    record('body', 'missing_body', `正文状态：${row.body_state}`);
  }
  return steps;
}

const KIND_LABEL = { user: '用户', assistant: '助手', tool: '工具', record: '记录', aux: '辅助' };
const KIND_CLASS = { user: 'user', assistant: 'reply', tool: 'tool', record: 'aux', aux: 'aux' };

/**
 * 单行轨迹只显示请求序号、类型与内容，点击行在右栏阅读详情。
 * @param {import('../src/queries').RequestRow} row
 * @param {TraceStep[]} steps
 * @param {number} ordinal 当前窗口展示号（仅显示，身份用 req_id）
 * @param {string|null} selected 当前选中的步骤键
 * @returns {string}
 */
export function renderTraceRows(row, steps, ordinal, selected) {
  const pieces = [];
  /** @param {string} text @param {number} [max] */
  const clip = (text, max = 140) => [...String(text)].length <= max ? String(text)
    : `${[...String(text)].slice(0, max).join('')}…`;
  for (const step of steps) {
    const label = KIND_LABEL[step.kind] ?? '记录';
    pieces.push(`<div class="compact-step" data-request-ordinal="${ordinal}" data-req-id="${row.req_id}">
<div class="compact-row">
  <button class="compact-select" data-step-key="${esc(step.key)}" data-kind="${step.kind}"${step.callOrd === null ? '' : ` data-call-ord="${step.callOrd}"`} aria-current="${step.key === selected}">
    <span class="compact-meta" title="请求 ${ordinal}"><b>${ordinal}</b></span>
    <span class="row-label ${KIND_CLASS[step.kind] ?? 'aux'}">${label}</span>
    <span class="compact-preview">${step.kind === 'tool' ? `<code>${esc(clip(step.text))}</code>` : esc(clip(step.text))}</span>
  </button>
</div>
</div>`);
  }
  return pieces.join('');
}
