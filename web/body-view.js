// @ts-check
/**
 * 正文视图：把读取模型（body-model）的归一化结果渲染成 HTML 片段。
 *
 * 这里只做字符串拼接，不碰 DOM，测试可以直接断言输出；正文一律经 html.js 转义。
 *
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('./body-model.js').Role} Role
 * @typedef {import('./body-model.js').Block} Block
 * @typedef {import('./body-model.js').Entry} Entry
 * @typedef {import('./body-model.js').ReplyView} ReplyView
 * @typedef {import('./body-model.js').ToolEntry} ToolEntry
 * @typedef {{delta: Set<number> | null, limit?: number, selectedOrd?: number | null, gaps?: {from: number, to: number}[]}} MessageOptions
 */

import { esc, mdToHtml } from './html.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { clip, displayRoleOf } from './body-model.js';
import { clipChars, summaryParts } from './tool-summary.js';

/** 参与角色标签统一用英文；tag 只管显示文本，CSS 类名走 roleClass。 @param {Role} role */
export function roleTag(role) {
  return ROLE_TAGS[role] ?? 'Unknown';
}

/** CSS 类名用稳定的角色小写名，不随显示文本变化。 @param {Role} role */
export function roleClass(role) {
  return ROLE_TAGS[role] !== undefined ? role : 'unknown';
}

const ROLE_TAGS = /** @type {Record<Role, string>} */ ({
  system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool', unknown: 'Unknown',
});

/**
 * 正文状态说明。已回收、未到、不支持都带原因，界面上不显示成空对话。
 * 保存覆盖（state）与协议解释（parse_state）分开：原文完整但协议未适配时
 * 保留原对象阅读，不显示成空消息或零技能。
 * @param {BodyPage | null} page
 */
export function bodyNotice(page) {
  if (page === null) return '';
  if (page.state === 'evicted') return t('正文已回收：{reason}', { reason: page.reason ?? t('原因未记录') });
  if (page.state === 'pending') return page.reason === null ? t('正文未到；回调可能稍后到达。') : t('正文未到：{reason}', { reason: page.reason });
  if (page.state === 'unsupported') return t('原对象已保存，暂不支持结构化解析');
  if (page.state === 'partial') return page.reason === null ? t('正文不完整：只有部分内容可用。') : t('正文不完整：{reason}', { reason: page.reason });
  if (page.parse_state === 'unsupported') return t('协议未适配：原对象已保存，可按原文阅读请求字段与回复，消息结构不按已知协议解释。');
  if (page.reply_state === 'absent') return t('已保存请求，上游未提供可用回复。');
  return '';
}

/**
 * 消息列表。可折叠行都是 button，键盘可达；预览单行截断，不撑破窄屏。
 * gaps 是相邻已缓存序号之间的未读区间，按位置插进列表，不冒充已读。
 * @param {Entry[]} entries
 * @param {MessageOptions} options
 */
export function renderMessages(entries, options) {
  const limit = options.limit ?? 40;
  const shown = entries.slice(0, limit);
  const gaps = options.gaps ?? [];
  /** @param {{from: number, to: number}} gap */
  const gapRow = gap => `<li class="msg-gap"><span>${t('{ord} 未读取', { ord: `#${gap.from}${gap.to > gap.from ? `–#${gap.to}` : ''}` })}</span></li>`;
  /** @type {string[]} */
  const rows = [];
  let gapIndex = 0;
  shown.forEach(entry => {
    while (gapIndex < gaps.length && gaps[gapIndex] !== undefined && gaps[gapIndex].to < entry.ord) {
      rows.push(gapRow(/** @type {{from: number, to: number}} */ (gaps[gapIndex])));
      gapIndex += 1;
    }
    const isNew = options.delta !== null && options.delta.has(entry.ord);
    const current = options.selectedOrd === entry.ord ? ' aria-current="true"' : '';
    const displayRole = displayRoleOf(entry);
    // 消息级列表用主角色加内容类型：纯结果与纯调用在预览前标明类型。
    const toolResultOnly = entry.blocks.length > 0 && entry.blocks.every(block => block.kind === 'result');
    const typePrefix = toolResultOnly ? 'Tool result · '
      : entry.blocks.length > 0 && entry.blocks.every(block => block.kind === 'call') ? 'Tool call · ' : '';
    rows.push(`<li class="msg${isNew ? ' msg-new' : ''}" data-ord="${entry.ord}"${current}>
      <button class="msg-head" data-msg="${entry.ord}" aria-label="${t('查看消息 {ord}{tail}', { ord: entry.ord, tail: isNew ? t('，新增消息') : '' })}">
        <span class="msg-ord">#${entry.ord}</span>
        <span class="kind ${roleClass(displayRole)}">${roleTag(displayRole)}</span>
        <span class="msg-preview${toolResultOnly ? ' result' : ''}">${esc(typePrefix + entry.preview)}</span>
      </button>
    </li>`);
  });
  const more = entries.length > limit
    ? `<li class="msg-more"><button class="chip-btn" data-body-more-msg="1">${t('还有 {n} 条未显示', { n: entries.length - limit })}</button></li>`
    : '';
  return `<ol class="msg-list">${rows.join('')}${more}</ol>`;
}

/**
 * 单条消息的完整内容。用户与工具结果按原文保留换行，助手文本按 Markdown 显示。
 * `path` 是原始请求对象里的消息位置；未知时不显示位置。
 * 调用与结果块在 call_id 与原始路径都能确认两端时给显式配对入口，不按块序号猜。
 * @param {Entry} entry
 * @param {string} [path]
 * @param {((block: Block, path: string) => {owner: number, callOrd: number} | null) | null} [pairOf]
 */
export function renderMessageDetail(entry, path = '', pairOf = null) {
  const displayRole = displayRoleOf(entry);
  const blocks = entry.blocks.map(block => {
    // 块位置按正文骨架拼；Chat 的 role=tool 结果配对到整条消息，与后端 result_path 同口径。
    const blockPath = path === '' || entry.rawRole === 'tool' || block.path === ''
      ? path : `${path}.${block.path}`;
    if (block.kind === 'text') {
      return entry.role === 'assistant'
        ? `<div class="bp-text">${mdToHtml(block.text)}</div>`
        : `<div class="bp-text bp-plain">${esc(block.text)}</div>`;
    }
    if (block.kind === 'thinking') {
      return `<details class="msg-thinking" open><summary>${t('推理块 · {n} 字', { n: [...block.text].length })}</summary>
        <pre class="raw" tabindex="0">${esc(block.text)}</pre></details>`;
    }
    if (block.kind === 'call' || block.kind === 'result') {
      const failed = block.kind === 'result' && block.failed === true
        ? `<span class="tool-chip miss"><span>${t('工具结果失败')}</span></span>` : '';
      const pair = pairOf === null ? null : pairOf(block, blockPath);
      const open = pair === null ? ''
        : `<div class="conv-tools"><button class="chip-btn ico" data-tool-owner="${pair.owner}" data-call-ord="${pair.callOrd}" aria-label="${t('配对两端')}" title="${t('查看配对的调用与结果')}">${icon('pair', 20)}</button></div>`;
      return `${failed}${open}<pre class="raw" tabindex="0" data-block-path="${esc(block.path)}">${esc(block.text)}</pre>`;
    }
    return `<pre class="raw" tabindex="0" data-block-path="${esc(block.path)}">${esc(JSON.stringify(block.raw, null, 2))}</pre>`;
  }).join('');
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind ${roleClass(displayRole)} bp-kind">${roleTag(displayRole)}</span>
      ${path === '' ? '' : `<span class="bp-path">${esc(path.replace(/^request\./, ''))}</span>`}
      <button class="chip-btn ico" data-copy-msg="${entry.ord}" aria-label="${t('复制原文')}" title="${t('复制原文')}">${icon('copy', 16)}</button>
    </div>
    <div class="bp-meta"><span>role=${esc(entry.rawRole ?? displayRole)}</span><span>·</span><span>${t('{n} 个内容块', { n: entry.blocks.length })}</span></div>
    ${blocks.length > 0 ? blocks : `<p class="note">${t('这条消息没有内容块。')}</p>`}
  </div>`;
}

/**
 * 顶层 System 的右栏详情：全文转义展示，路径随协议（request.system / request.instructions）。
 * @param {string} text
 * @param {string} [path]
 */
export function renderSystemDetail(text, path = 'request.system') {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind system bp-kind">System</span>
      <span class="bp-path">${esc(path)}</span>
    </div>
    <div class="bp-text bp-plain">${esc(text)}</div>
  </div>`;
}

/**
 * 选中回复文本块的独立详情：只渲染这一块，不回退整份回复。
 * @param {string} path 实际协议路径，如 reply.content[2]
 * @param {string} text 块文本
 */
export function renderReplyBlockDetail(path, text) {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind assistant bp-kind">Assistant</span>
      <span class="bp-path">${esc(path)}</span>
    </div>
    <div class="bp-text">${mdToHtml(text)}</div>
  </div>`;
}

/**
 * 未知回复块的右栏详情：转义 JSON，不做语义推测。
 * @param {string} path 实际协议路径
 * @param {unknown} raw 原始块
 */
export function renderUnknownBlockDetail(path, raw) {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind unknown bp-kind">Unknown</span>
      <span class="bp-path">${esc(path)}</span>
    </div>
    <pre class="raw" tabindex="0">${esc(JSON.stringify(raw, null, 2))}</pre>
    <p class="rail-note">${t('这一块没有已适配的协议解释；原对象按脱敏后的 JSON 展示。')}</p>
  </div>`;
}

/**
 * 工具往返：一次调用一行，不套折叠壳。每次调用都提供右栏内打开配对页的入口，
 * 阅读就地完成；没有配对信息就不显示状态，只有异常（多候选）才提示。
 * 行内摘要与中栏调用行同源（tool-summary 叶子模块）：工具名加参数段，
 * 完整 inputText 只在悬停里。
 * @param {ToolEntry[]} tools
 */
export function renderTools(tools) {
  if (tools.length === 0) return '';
  const rows = tools.map(tool => {
    const open = `<button class="chip-btn ico" data-tool-owner="${tool.owner}" data-call-ord="${tool.ord}" aria-label="${t('配对两端')}" title="${t('查看配对的调用与结果')}">${icon('pair', 20)}</button>`;
    const warn = tool.state === 'ambiguous'
      ? `<span class="tool-chip miss"><span>${t('结果有多个候选，未配对')}</span></span>` : '';
    const parts = summaryParts(tool.name, tool.inputText);
    const text = parts.args === '' ? parts.label : `${parts.label} · ${parts.args}`;
    return `<div class="tool-row">
      <span class="tool-chip call" title="${esc(clipChars(tool.inputText))}"><span>${esc(text)}</span></span>
      ${open}${warn}
    </div>`;
  }).join('');
  return `<div class="tool-rows">${rows}</div>`;
}

/** 空回复的文案按正文状态分开：未到可等，回收与摘要不可等，缺失才是真的没有。 */
const EMPTY_REPLY = /** @type {Record<'absent' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial', [string, string]>} */ ({
  absent: ['上游没有提供可用回复', '请求正文已保存；这一笔只有请求，没有回复对象，这里不补写内容。'],
  pending: ['回复还没到', '正文未到（hook 尚未回调）；这一笔可能稍后补上，不是没有回复。'],
  evicted: ['回复随正文一起回收', '正文已回收，回复不再可读；原因见正文状态。'],
  unsupported: ['回复暂不可读', '原对象已保存，暂不支持结构化解析。'],
  summary: ['回复不在摘要里', '正文来自 OTLP 摘要，没有保存完整回复对象，这里不补写内容。'],
  partial: ['回复不在已保存的部分里', '正文不完整；已保存的部分没有回复对象，原因见正文状态。'],
});

/**
 * 本次回复内容。ASSISTANT 头与模型名不再重复：读数条只显示一次 model_served，
 * finish 移到折叠行摘要（见读数页）。空回复与无法解析分别说明。
 * @param {ReplyView} view
 * @param {ToolEntry[]} [tools]
 * @param {string} [foldKey] 折叠持久化键前缀（req id）；空串不持久化
 */
export function renderReply(view, tools = [], foldKey = '') {
  const keySuffix = foldKey === '' ? '' : `:${esc(foldKey)}`;
  const subFold = (/** @type {string} */ key, /** @type {string} */ inner) => {
    const attr = keySuffix === '' ? '' : ` data-fold="${key}${keySuffix}"`;
    return `<details class="rail-fold sub"${attr}>${inner}</details>`;
  };
  if (view.state !== 'ok' && view.state !== 'invalid') {
    const [head, body] = EMPTY_REPLY[view.state].map(/** @param {string} v */ v => t(v));
    return `<div class="reply-empty"><b>${head}</b><span>${body}</span></div>`;
  }
  if (view.state === 'invalid') {
    return `<div class="reply-empty"><b>${t('回复对象无法结构化')}</b>
      <span>${t('原对象仍保存在库里。')}</span></div>`;
  }
  const thinking = view.thinking.length === 0 ? '' : subFold('think',
    `<summary>${t('推理块')}<span class="fold-count">${t('{n} 段', { n: view.thinking.length })}</span></summary>
     <div class="fold-body"><pre class="raw" tabindex="0">${esc(view.thinking.join('\n\n'))}</pre></div>`);
  const text = view.text.length > 0
    ? `<div class="reply-text">${mdToHtml(view.text)}</div>`
    : view.calls.length === 0 ? `<div class="reply-empty"><span>${t('回复对象存在，但没有文本内容。')}</span></div>` : '';
  return `${thinking}${text}${renderTools(tools)}`;
}

/**
 * 右栏的回复详情，比账本卡片多给 finish 与工具状态。
 * 模型名不在这里重复，只有头部读数条显示一次。
 * @param {ReplyView} view
 * @param {ToolEntry[]} [tools]
 * @param {string} [foldKey] 折叠持久化键前缀（req id）；空串不持久化
 */
export function renderReplyDetail(view, tools = [], foldKey = '') {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind REPLY bp-kind">REPLY</span>
      <span class="bp-path">reply</span>
    </div>
    <div class="bp-meta">
      ${view.finish !== null ? `<span>finish: ${esc(view.finish)}</span>` : ''}
    </div>
    ${renderReply(view, tools, foldKey)}
    <p class="rail-note">${t('工具结果不在本回复里，按 call id 指向后续请求的消息。')}</p>
  </div>`;
}

// —— 请求能力：工具清单与技能清单 ——

const TOOL_STATE_TEXT = {
  present: '',
  empty: '这一笔请求没有携带工具定义',
  unrecognized: '工具字段存在，但格式未识别',
  missing: '工具定义缺失',
  partial: '工具定义未读完',
};
const SKILL_STATE_TEXT = {
  present: '',
  empty: '没有可解析的技能清单',
  unrecognized: '有技能标记，但格式未识别',
  missing: '技能声明缺失',
  partial: '技能清单未读完',
};

/** @param {{name: string, description: string, schema: unknown}} tool */
function renderToolItem(tool) {
  const schema = tool.schema === null || tool.schema === undefined
    ? ''
    : `<pre class="raw" tabindex="0">${esc(JSON.stringify(tool.schema, null, 2))}</pre>`;
  return `<li class="cap-item">
    <details data-fold="cap:tool:${esc(tool.name)}">
      <summary><code class="cap-name">${esc(tool.name)}</code><span class="cap-desc">${esc(clip(tool.description, 120))}</span></summary>
      ${schema}
    </details>
  </li>`;
}

/** @param {{name: string, description: string}} skill */
function renderSkillItem(skill) {
  return `<li class="cap-item"><code class="cap-name">${esc(skill.name)}</code><span class="cap-desc">${esc(clip(skill.description, 120))}</span></li>`;
}

/**
 * 请求能力折叠行（工具清单 / 技能清单各一行）。
 * present 显示数量；empty 与 present 但零项都不渲染（没有就不显示）；
 * 其余状态是异常，显示原因。没有可输出的行时返回空串。
 * @param {BodyPage | null | undefined} page
 * @returns {string}
 */
export function renderCapabilities(page) {
  const view = page === null || page === undefined ? null : page.capabilities;
  if (view === null || view === undefined) return '';
  /**
   * @param {{state: string, items: {name: string}[], reason: string | null}} result
   * @param {string} label @param {string} key @param {string} listHtml @param {Record<string, string>} text
   */
  const row = (result, label, key, listHtml, text) => {
    if (result.state === 'present' && result.items.length > 0) {
      return `<details class="rail-fold" data-fold="${key}">
        <summary>${label}<span class="fold-count">${result.items.length}</span></summary>
        <div class="fold-body">${listHtml}</div>
      </details>`;
    }
    if (result.state === 'present' || result.state === 'empty') return '';
    // 协议未适配是解释边界，不是数据缺失：完整保存也不能推导出零技能。
    const note = result.reason === 'protocol_unsupported'
      ? t('协议未适配：保存的原文可读，但无法按已知协议判定这一笔携带的工具与技能。')
      : t(text[result.state] ?? result.state);
    const chip = result.reason === 'protocol_unsupported' ? t('协议未适配') : t(text[result.state] ?? result.state);
    return `<details class="rail-fold" data-fold="${key}">
      <summary>${label}<span class="fold-count warn">${esc(chip)}</span></summary>
      <div class="fold-body"><p class="note">${esc(note)}</p></div>
    </details>`;
  };
  return row(view.tools, t('工具清单'), 'cap:tools',
      `<ol class="cap-list">${view.tools.items.map(renderToolItem).join('')}</ol>`, TOOL_STATE_TEXT)
    + row(view.skills, t('技能清单'), 'cap:skills',
      `<ul class="cap-list">${view.skills.items.map(renderSkillItem).join('')}</ul>`, SKILL_STATE_TEXT);
}
