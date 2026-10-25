// @ts-check
import { deltaOrdinals, replyView, toolTint } from './body-view.js';

/**
 * 步骤投影：把可信输入与实际回复变成单行轨迹步骤。纯函数、无 DOM、无网络；
 * 状态语义来自 Task 0 验证过的原型口径（§3.4）：
 * 请求级状态（失败/缺正文/缺回复/截断/未知）与工具关联分立，
 * 结果正文是否已读由 reader-store 决定，不写进投影。
 */

/**
 * 步骤来源：请求字段、请求消息内容块或本次回复内容块，path 是实际协议路径。
 * 记录与辅助步骤不落在协议对象上，source 为 null，点击打开该请求读数。
 * @typedef {{side:'request', path:'request.system', messageOrd:null, blockIndex:null}
 *   | {side:'request', path:string, messageOrd:number, blockIndex:number|null}
 *   | {side:'reply', path:string, messageOrd:null, blockIndex:number|null}
 *   | null} StepSource
 */

/**
 * @typedef {Object} TraceStep 单行轨迹的一步。
 * @property {string} key 稳定键：reqId:message:N / reqId:reply:text:N / reqId:call:N / reqId:system 等
 * @property {number} reqId
 * @property {'user'|'assistant'|'tool'|'tool_result'|'system'|'record'|'aux'} kind
 * @property {string} text 行文本（工具行是动作摘要）
 * @property {number|null} messageOrd
 * @property {number|null} callOrd
 * @property {StepSource} source 步骤在协议对象里的位置
 * @property {unknown} raw 原文或原始块
 * @property {boolean} unrecognized
 * @property {'failed'|'missing_body'|'missing_reply'|'unknown'|'truncated'|null} status
 * @property {{state: 'resolved'|'pending'|'ambiguous'|'unpaired', reqId: number|null} | null} result
 * @property {{reqId: number, callOrd: number} | null} pairOwner 结果步骤的反向配对：承载本结果的调用方与调用序号；未确认时为 null
 * @property {string | null} [toolName] 调用步是工具名，结果步是配对索引的 tool_name（缓存外仍可知）；其余步骤缺省
 * @property {string | null} [toolArgs] 调用步的参数段摘要（已按预算截断，不含工具名）；其余步骤缺省
 * @property {string | null} [toolInput] 调用步的完整参数 JSON，供悬停展示；其余步骤缺省
 * @property {boolean | null} [isError] 结果内容块的 is_error：true/false，未报告为 null；其余步骤缺省
 */

/**
 * 顶层 System 上下文：当前请求的 system 文本，以及与同 actor 已确认前驱的比较。
 * changed 为 null 表示没有可比较的前驱（首个已加载、前驱不在窗口或正文不可读）。
 * @typedef {{text: string, changed: boolean | null} | null} SystemContext
 */

/** @param {unknown} value @returns {string} */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (/** @param {string} c */ c) => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c] ?? c
));

const LENGTH_FINISH = new Set(['length', 'max_tokens']);
const NORMAL_FINISH = new Set(['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use']);

/* ---------- 工具行摘要：按工具分派，路径折算成 basename，行区间是显示锚点不是事实 ---------- */

/** 悬停 title 属性的超长护栏：预览文本不按字符截断，属性仍要防大参数撑爆。 */
const TITLE_MAX = 2000;

/** @param {string} text @param {number} [max] */
const clipChars = (text, max = TITLE_MAX) => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
};

/** 路径最后一段：扫读锚点是文件名，完整路径进悬停与右栏。 @param {string} p */
const baseName = (p) => {
  const trimmed = p.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
};

/** @param {unknown} v @returns {string | null} 非空字符串原样返回，其余 null。 */
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** 文件类参数取 basename。 @param {unknown} v */
const fileBase = (v) => {
  const s = nonEmpty(v);
  return s === null ? null : baseName(s);
};

/** @param {unknown} v @returns {number | null} */
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 行数按换行计；缺失或空串为 0 行。 @param {string | null} s */
const lineCount = (s) => (s === null || s === '' ? 0 : s.split('\n').length);

/** 第一个非空行（trim 后）。 @param {string} text */
const firstNonEmptyLine = (text) => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
};

/** content 字节数读数：不足 1KB 显示 B，满 1MB 换 MB，其余 KB 一位小数。 @param {string} text */
const byteSize = (text) => {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

/**
 * 逐工具参数段：核心键齐才分派，缺核心键返回 null 走通用回退链。
 * 区间折算与字节读数只服务扫读，原始键值始终在悬停与右栏。
 * @param {string} name @param {Record<string, unknown>} args @returns {string | null}
 */
function dispatchSummary(name, args) {
  switch (name) {
    case 'Read': {
      const file = fileBase(args.file_path);
      if (file === null) return null;
      const offset = asNum(args.offset);
      const limit = asNum(args.limit);
      const range = offset !== null && limit !== null ? `${offset}–${offset + limit} 行`
        : limit !== null ? `前 ${limit} 行`
          : offset !== null ? `${offset} 行起` : '';
      return range === '' ? file : `${file} · ${range}`;
    }
    case 'Edit': {
      const file = fileBase(args.file_path);
      if (file === null) return null;
      const oldS = typeof args.old_string === 'string' ? args.old_string : null;
      const newS = typeof args.new_string === 'string' ? args.new_string : null;
      const parts = [file];
      if (oldS !== null || newS !== null) parts.push(`${lineCount(oldS)}→${lineCount(newS)} 行`);
      if (args.replace_all === true) parts.push('全部替换');
      return parts.join(' · ');
    }
    case 'Write': {
      const file = fileBase(args.file_path);
      if (file === null) return null;
      const content = typeof args.content === 'string' ? args.content : null;
      return content !== null ? `${file} · ${byteSize(content)}` : file;
    }
    case 'Bash':
    case 'bash': {
      const desc = typeof args.description === 'string' && args.description.trim() !== ''
        ? args.description.trim() : null;
      if (desc !== null) return desc;
      const command = typeof args.command === 'string' ? firstNonEmptyLine(args.command) : '';
      return command !== '' ? command : null;
    }
    case 'Skill': {
      const skill = nonEmpty(args.skill);
      if (skill === null) return null;
      const extra = typeof args.args === 'string' && args.args.trim() !== '' ? ` · ${args.args.trim()}` : '';
      return `${skill}${extra}`;
    }
    case 'Agent': {
      const type = nonEmpty(args.subagent_type);
      if (type === null) return null;
      const desc = typeof args.description === 'string' && args.description.trim() !== ''
        ? ` · ${args.description.trim()}` : '';
      return `${type}${desc}`;
    }
    case 'SendMessage': {
      const summary = typeof args.summary === 'string' && args.summary.trim() !== '' ? args.summary.trim() : null;
      const to = nonEmpty(args.to);
      if (summary === null && to === null) return null;
      const target = to !== null ? `→ ${[...to].slice(0, 8).join('')}` : null;
      return [summary, target].filter(Boolean).join(' ');
    }
    case 'SubagentHandback': {
      const message = typeof args.message === 'string' ? firstNonEmptyLine(args.message) : '';
      return message !== '' ? message : null;
    }
    case 'WebFetch': {
      const url = nonEmpty(args.url);
      return url === null ? null : url.replace(/^https?:\/\//, '');
    }
    case 'ToolSearch': {
      return typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : null;
    }
    default:
      return null;
  }
}

/**
 * 未知工具的回退链：command→cmd→file_path→path→pattern→原文；file_path 与 path 同样 basename 化。
 * @param {unknown} args @param {string} inputText
 */
function fallbackSummary(args, inputText) {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const record = /** @type {Record<string, unknown>} */ (args);
    for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern']) {
      const value = record[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'string') {
        return key === 'file_path' || key === 'path' ? baseName(value) : value;
      }
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) return serialized;
    }
  }
  return inputText;
}

/**
 * 摘要拆成身份与参数段：chip 用工具名，预览用参数段，悬停给完整参数。
 * 参数段不做字符数预截断：超长由中栏列宽的省略号处理，工具名与 basename 不受影响。
 * @param {string} name @param {string} inputText @returns {{label: string, args: string}}
 */
function summaryParts(name, inputText) {
  const label = name !== '' ? name : '未命名工具';
  let args = null;
  try { args = JSON.parse(inputText); } catch { /* 非 JSON 参数按原文展示 */ }
  const dispatched = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? dispatchSummary(name, /** @type {Record<string, unknown>} */ (args))
    : null;
  const raw = dispatched ?? fallbackSummary(args, inputText);
  return { label, args: String(raw ?? '') };
}

/** 工具行动作摘要 `工具名 · 参数段`；结果正文不当结论，原文进悬停与右栏。 @param {string} name @param {string} inputText @returns {string} */
export function toolSummary(name, inputText) {
  const parts = summaryParts(name, inputText);
  return `${parts.label} · ${parts.args}`;
}

/**
 * @param {import('../src/queries/projection').RequestRow} row
 * @param {import('./reader-store.js').RequestRead | null} read
 * @param {SystemContext} [systemContext] 顶层 System 的当前值与比较结果；由装配层按
 * 同 actor 已确认前驱计算，投影不做时间推断，也不持久化比较结果。
 * @returns {TraceStep[]}
 */
export function projectSteps(row, read, systemContext = null) {
  /** @type {TraceStep[]} */
  const steps = [];
  const detail = read?.detail ?? null;
  /** @param {string} key @param {TraceStep['status']} status @param {string} text @param {Partial<TraceStep>} [extra] */
  const record = (key, status, text, extra = {}) => {
    steps.push(/** @type {TraceStep} */ ({
      key: `${row.req_id}:${key}`, reqId: row.req_id, kind: 'record', text,
      messageOrd: null, callOrd: null, source: null, raw: null, unrecognized: false,
      status, result: null, pairOwner: null, ...extra,
    }));
  };
  // 辅助请求一笔一条辅助记录：分类器输入不画成用户消息。
  if (row.purpose_chain === 'exclude' || row.chain_role === 'aux') {
    steps.push({ key:`${row.req_id}:aux`, reqId: row.req_id, kind: 'aux',
      text: `辅助请求 · ${row.req_kind === 'title' ? '标题生成' : row.req_kind}`,
      messageOrd: null, callOrd: null, source: null, raw: null, unrecognized: false,
      status: null, result: null, pairOwner: null });
    return steps;
  }
  // 顶层 System：与已确认前驱同值不重复，变化标明；不可比较时只声明当前上下文。
  if (systemContext !== null && systemContext.text.length > 0 && systemContext.changed !== false) {
    steps.push({
      key: `${row.req_id}:system`, reqId: row.req_id, kind: 'system',
      text: systemContext.changed === true
        ? `System 与已确认前驱不同 · ${systemContext.text}` : systemContext.text,
      messageOrd: null, callOrd: null,
      source: { side: 'request', path: 'request.system', messageOrd: null, blockIndex: null },
      raw: systemContext.text, unrecognized: false, status: null, result: null, pairOwner: null,
    });
  }
  if (row.chain_role === 'branch') {
    record('branch', null, '分支链请求 · 归属来自派生记录，不按时间推断父子');
  }
  // 读取未完成时是加载/状态记录，不能把请求级 input_preview 拆成确定用户步骤。
  // 作废与失败不是读取中：缺口原因来自快照 status，文案如实区分；点击行是
  // 自动重读之外的立即重读入口，仍走普通读取。
  if (read === null || detail === null) {
    const gapText = read !== null && read.status === 'invalidated'
      ? '阅读版本已变化 · 自动重读中，点击立即重读'
      : read !== null && read.status === 'failed'
        ? `详情读取失败 · ${read.detailError ?? '读取失败'}`
        : null;
    record('loading', row.status !== null && row.status >= 400 ? 'failed'
      : row.body_state !== 'available' && row.body_state !== 'partial' ? 'missing_body' : null,
    gapText ?? '读取中');
    return steps;
  }
  // 可信新增：输入解释、System 消息与工具结果都只认 delta；dirty/unknown/branch 不升级。
  const trusted = deltaOrdinals(detail);
  if (trusted === null) {
    record('uncertain', detail.prev_relation === 'unknown' || detail.derived_state !== 'current'
      ? 'unknown' : null,
    `新增输入未确认 · ${detail.prev_relation ?? detail.derived_state}`);
  } else {
    for (const entry of read.entries) {
      if (!trusted.has(entry.ord)) continue;
      const msgBase = `request.messages[${entry.ord}]`;
      // 工具结果块按内容块出独立步骤；混合消息的真实用户文本只产生一次。
      const resultBlocks = entry.blocks.filter(block => block.kind === 'result');
      for (const block of resultBlocks) {
        // Chat 的 role=tool 结果按整条协议消息配对（后端 result_path 到 messages[N] 为止）；
        // Anthropic 的结果块配对到内容块路径。反向配对只认已确认的精确位置。
        const wholeMessage = entry.rawRole === 'tool';
        const path = wholeMessage ? msgBase : `${msgBase}.${block.path}`;
        const indexed = (detail.tool_results ?? []).find(item => item.state === 'resolved'
          && item.result_ord === entry.ord && item.result_path === path) ?? null;
        steps.push({
          key: `${row.req_id}:message:${entry.ord}:result:${block.index}`, reqId: row.req_id,
          kind: 'tool_result',
          text: block.text.length > 0 ? block.text : '（空工具结果）',
          toolName: indexed !== null ? indexed.tool_name : null,
          isError: block.failed === true ? true : block.failed === false ? false : null,
          messageOrd: entry.ord, callOrd: null,
          source: { side: 'request', path, messageOrd: entry.ord, blockIndex: block.index },
          raw: block.raw, unrecognized: false, status: null, result: null,
          pairOwner: indexed === null ? null : { reqId: indexed.owner_req, callOrd: indexed.ord },
        });
      }
      if (entry.role === 'system') {
        steps.push({
          key: `${row.req_id}:message:${entry.ord}`, reqId: row.req_id, kind: 'system',
          text: entry.preview, messageOrd: entry.ord, callOrd: null,
          source: { side: 'request', path: msgBase, messageOrd: entry.ord, blockIndex: null },
          raw: entry.blocks.map(block => block.text).join('\n\n'), unrecognized: false,
          status: null, result: null, pairOwner: null,
        });
        continue;
      }
      if (!entry.isInput) continue;
      if (entry.input?.state === 'text') {
        steps.push({ key:`${row.req_id}:message:${entry.ord}`, reqId: row.req_id, kind: 'user',
          text: entry.input.text, messageOrd: entry.ord, callOrd: null,
          source: { side: 'request', path: msgBase, messageOrd: entry.ord, blockIndex: null },
          raw: entry.input.original ?? entry.input.text, unrecognized: false,
          status: null, result: null, pairOwner: null });
      } else {
        // unrecognized 输入也是新增事实：占一行，原文进详情。
        steps.push({ key:`${row.req_id}:message:${entry.ord}`, reqId: row.req_id, kind: 'user',
          text: entry.input?.text ?? '未识别的用户输入', messageOrd: entry.ord, callOrd: null,
          source: { side: 'request', path: msgBase, messageOrd: entry.ord, blockIndex: null },
          raw: entry.input?.original ?? null, unrecognized: true,
          status: null, result: null, pairOwner: null });
      }
    }
  }
  // 增量读取未完成或失败：一条事件记录显示剩余与失败，点击续读两片；完成时不出现。
  const deltaState = read.delta ?? null;
  if (deltaState !== null && !deltaState.done && trusted !== null) {
    const total = trusted.size;
    record('delta', deltaState.error !== null ? 'unknown' : null, deltaState.error !== null
      ? `新增读取失败 · 已消费 ${Math.min(deltaState.next, total)} / ${total} · ${deltaState.error}`
      : `还有 ${total - deltaState.next} 条新增未读取 · 点击续读`);
  }
  // 回复块只经 replyView 归一化：块序号沿用协议内位置，路径从回复根算起；
  // thinking 不常驻，多 choice 不结构化拆行，只出一条保留原始对象的记录。
  const meta = read?.meta ?? null;
  const view = meta === null ? null : replyView(meta);
  if (view === null || view.state === 'absent') {
    record('reply', 'missing_reply', '未收到回复');
  } else if (view.choiceCount !== null && view.choiceCount > 1) {
    record('choices', null, `多 choice 回复（${view.choiceCount} 项）：保留原始对象，不按冲突序号提供工具定位`);
  } else {
    for (const block of view.blocks) {
      const index = block.index;
      if (block.kind === 'text' && block.text.length > 0) {
        steps.push({ key:`${row.req_id}:reply:text:${index}`, reqId: row.req_id, kind: 'assistant',
          text: block.text, messageOrd: null, callOrd: null,
          source: { side: 'reply', path: block.path, messageOrd: null, blockIndex: index },
          raw: block.text, unrecognized: false, status: null, result: null, pairOwner: null });
      } else if (block.kind === 'call') {
        const call = view.calls.find(item => item.ord === index) ?? null;
        const pair = detail.tool_calls?.find(item => item.ord === index) ?? null;
        const parts = summaryParts(call?.name ?? '', call?.inputText ?? '');
        steps.push({ key: `${row.req_id}:call:${index}`, reqId: row.req_id, kind: 'tool',
          text: `${parts.label} · ${parts.args}`,
          toolName: call?.name ?? null, toolArgs: parts.args, toolInput: call?.inputText ?? '',
          messageOrd: null, callOrd: index,
          source: { side: 'reply', path: block.path, messageOrd: null, blockIndex: index },
          raw: block.raw,
          unrecognized: false, status: null,
          result: pair === null ? null : { state: /** @type {'resolved'|'pending'|'ambiguous'|'unpaired'} */ (pair.state), reqId: pair.result_req },
          pairOwner: null });
      } else if (block.kind !== 'thinking') {
        // 未知块给记录入口，不做语义推测；来源仍指向协议位置，右栏可读转义 JSON。
        steps.push({ key: `${row.req_id}:reply:block:${index}`, reqId: row.req_id, kind: 'record',
          text: `未知回复块 kind=${block.kind}`, messageOrd: null, callOrd: null,
          source: { side: 'reply', path: block.path, messageOrd: null, blockIndex: index },
          raw: block.raw, unrecognized: true, status: null, result: null, pairOwner: null });
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
    record('body', 'missing_body', `正文状态：${row.body_state}${row.miss_reason ? `（${row.miss_reason}）` : ''}`);
  }
  return steps;
}

// 参与角色英文标签 + 内容类型：调用由 Assistant 发出、结果显示在 Tool 上，
// 辅助与记录表达请求用途和事件，不伪装成模型消息。工具身份改由着色 chip 承载，
// 不再使用 Tool call / Tool result 文字小标。
const KIND_LABEL = { user: 'User', assistant: 'Assistant', tool: 'Assistant', tool_result: 'Tool', system: 'System', record: 'Event', aux: 'Aux' };
const KIND_CLASS = { user: 'user', assistant: 'reply', tool: 'reply', tool_result: 'tool', system: 'system', record: 'aux', aux: 'aux' };

/**
 * 工具行的身份 chip 与调用侧参数段。色类只包工具名：参数摘要以普通文本跟随，
 * 不进色类。结果行在调用方可知时给 `参数摘要 → 结果正文`；配对确认但调用方
 * 不在缓存时只给 `→ 结果正文`；未配对保持中性 `Tool result`，不猜归属。
 * @param {TraceStep} step
 * @param {((ownerReq: number, callOrd: number) => {name: string, inputText: string} | null) | null} callOf
 * @returns {{chip: string, args: string, arrow: boolean}}
 */
function toolRowParts(step, callOf) {
  if (step.kind === 'tool') {
    const name = step.toolName ?? '';
    const label = name !== '' ? name : '未命名工具';
    return { chip: `<span class="row-tint ${toolTint(name)}">${esc(label)}</span>`, args: step.toolArgs ?? '', arrow: false };
  }
  if (step.kind === 'tool_result') {
    const owner = step.pairOwner;
    const call = owner !== null && callOf !== null ? callOf(owner.reqId, owner.callOrd) : null;
    if (call === null && (step.toolName ?? '') === '') {
      return { chip: '<span class="row-tint tint-other">Tool result</span>', args: '', arrow: false };
    }
    const name = call !== null ? call.name : /** @type {string} */ (step.toolName);
    const label = name !== '' ? name : '未命名工具';
    const args = call !== null ? summaryParts(call.name, call.inputText).args : '';
    return { chip: `<span class="row-tint ${toolTint(name)}">${esc(label)}</span>`, args, arrow: true };
  }
  return { chip: '', args: '', arrow: false };
}

/**
 * 单行轨迹只显示请求序号、角色、工具身份 chip 与内容，点击行在右栏阅读详情。
 * 工具行的预览不做字符截断：参数摘要与结果正文完整进 DOM，超长由中栏列宽的
 * 省略号处理；其余行仍按 140 字符截断。
 * @param {import('../src/queries/projection').RequestRow} row
 * @param {TraceStep[]} steps
 * @param {number} ordinal 当前窗口展示号（仅显示，身份用 req_id）
 * @param {string|null} selected 当前选中的步骤键
 * @param {((ownerReq: number, callOrd: number) => {name: string, inputText: string} | null) | null} [callOf]
 *   调用方正文在窗口缓存内时由装配层提供；查不到或未传时结果行降级为只工具名。
 * @returns {string}
 */
export function renderTraceRows(row, steps, ordinal, selected, callOf = null) {
  const pieces = [];
  /** @param {string} text @param {number} [max] */
  const clip = (text, max = 140) => [...String(text)].length <= max ? String(text)
    : `${[...String(text)].slice(0, max).join('')}…`;
  for (const step of steps) {
    const label = KIND_LABEL[step.kind] ?? 'Event';
    const { chip, args, arrow } = toolRowParts(step, callOf);
    const isTool = step.kind === 'tool' || step.kind === 'tool_result';
    // 悬停给完整信息：调用行放完整参数 JSON，结果行放调用摘要与完整结果正文；属性按 TITLE_MAX 截断。
    let title = '';
    if (step.kind === 'tool') {
      title = clipChars(step.toolInput ?? '');
    } else if (step.kind === 'tool_result') {
      title = clipChars(args !== '' ? `${args} → ${step.text}` : step.text);
    }
    const titleAttr = title !== '' ? ` title="${esc(title)}"` : '';
    const previewHtml = isTool
      ? `${args !== '' ? `<code>${esc(args)}</code>` : ''}${
        arrow ? '<span class="row-arrow" aria-hidden="true">→</span>' : ''}${
        step.kind === 'tool_result' ? `<code>${esc(step.text)}</code>` : ''}`
      : esc(clip(step.text));
    pieces.push(`<div class="compact-step" data-request-ordinal="${ordinal}" data-req-id="${row.req_id}">
<div class="compact-row${step.isError === true ? ' step-error' : ''}">
  <button class="compact-select" data-step-key="${esc(step.key)}" data-kind="${step.kind}"${step.callOrd === null ? '' : ` data-call-ord="${step.callOrd}"`} aria-current="${step.key === selected}">
    <span class="compact-meta" title="序号表示当前窗口内的请求 · 请求 ${ordinal}"><b>${ordinal}</b></span>
    <span class="row-label ${KIND_CLASS[step.kind] ?? 'aux'}">${label}</span>
    ${chip}
    <span class="compact-preview"${titleAttr}>${previewHtml}</span>
  </button>
</div>
</div>`);
  }
  return pieces.join('');
}
