// @ts-check
/**
 * 正文视图：把一页 BodyPage 渲染成 HTML 片段。
 *
 * 这里只做字符串拼接，不碰 DOM，测试可以直接断言输出。
 * 协议正文一律先转义；只有 mdToHtml 识别少数结构，认不出的语法按原文保留，
 * 绝不把消息内容当 HTML 执行。
 *
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('../src/queries').RequestDetail} RequestDetail
 * @typedef {'system' | 'user' | 'assistant' | 'tool' | 'unknown'} Role
 * @typedef {{kind: string, text: string, index: number, raw: unknown}} Block
 * @typedef {{ord: number, role: Role, blocks: Block[], preview: string, isInput: boolean}} Entry
 * @typedef {{id: string, name: string, inputText: string, ord: number}} ToolCallView
 * @typedef {{state: 'ok' | 'absent' | 'invalid', text: string, thinking: string[], calls: ToolCallView[], finish: string | null, model: string | null, raw: unknown}} ReplyView
 * @typedef {{call_id: string, name: string, inputText: string, ord: number, state: string, result_req: number | null, result_ord: number | null}} ToolEntry
 * @typedef {{delta: Set<number> | null, limit?: number, selectedOrd?: number | null}} MessageOptions
 */

const ESCAPES = /** @type {Record<string, string>} */ ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} text @param {number} max */
function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
}

/**
 * 给回复文本用的极简 Markdown。先整体转义，再识别代码块、表格、列表与标题。
 * @param {unknown} text
 */
export function mdToHtml(text) {
  const source = String(text ?? '');
  /** @type {string[]} */
  const blocks = [];
  /** @param {string} html */
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  const body = source.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_all, _lang, code) =>
    keep(`<pre class="md-code" tabindex="0">${esc(String(code).replace(/\n$/, ''))}</pre>`));

  /** @param {string} value */
  function inline(value) {
    return esc(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  const lines = body.split('\n');
  const out = [];
  let i = 0;
  /** @param {string} line */
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  /** @param {string} line */
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) { out.push(''); i += 1; continue; }
    if (/^```/.test(line)) { out.push(''); i += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && isTableSep(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${
        head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\s*[-*•]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      out.push(`<p class="md-head">${inline(line.replace(/^#{1,4}\s+/, ''))}</p>`);
      i += 1;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_all, key) => blocks[Number(key)] ?? '');
}

/**
 * 把任意协议值压成可读文本；不认识的结构转成转义 JSON，不猜语义。
 * @param {unknown} value
 * @returns {string}
 */
export function previewOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(item => (isRecord(item) && typeof item.text === 'string' ? item.text : previewOf(item)))
      .filter(text => text.length > 0)
      .join('\n');
  }
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'thinking', 'message']) {
      const inner = value[key];
      if (typeof inner === 'string') return inner;
    }
    return JSON.stringify(value, null, 2) ?? '';
  }
  return String(value);
}

/** @param {unknown} name @param {unknown} input */
function callLabel(name, input) {
  const head = typeof name === 'string' && name.length > 0 ? name : '（未命名工具）';
  const body = typeof input === 'string' ? input : JSON.stringify(input ?? null) ?? '';
  return `${head}(${body})`;
}

/** @param {Record<string, unknown>} block */
function imageLabel(block) {
  const source = isRecord(block.source) ? block.source : {};
  const media = typeof source.media_type === 'string' ? source.media_type
    : typeof block.media_type === 'string' ? block.media_type : '类型未报告';
  return `图片 · ${media}（原对象保留，不内联数据）`;
}

/**
 * 单个内容块归一化。两种协议的差别在这里收敛成同一组 kind。
 * @param {unknown} block
 * @param {number} index
 * @returns {Block}
 */
function blockView(block, index) {
  if (!isRecord(block)) return { kind: 'other', text: previewOf(block), index, raw: block };
  const type = String(block.type ?? '');
  if (type === 'text') return { kind: 'text', text: previewOf(block.text), index, raw: block };
  if (type === 'thinking') {
    return { kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : previewOf(block), index, raw: block };
  }
  if (type === 'redacted_thinking') {
    return { kind: 'thinking', text: '（推理内容已被上游加密，只保留占位块）', index, raw: block };
  }
  if (type === 'tool_use') return { kind: 'call', text: callLabel(block.name, block.input), index, raw: block };
  if (type === 'tool_result') return { kind: 'result', text: previewOf(block.content), index, raw: block };
  if (type === 'image' || type === 'input_image') return { kind: 'image', text: imageLabel(block), index, raw: block };
  // chat 的函数调用块：{id, type:'function', function:{name, arguments}}
  if (isRecord(block.function)) {
    return { kind: 'call', text: callLabel(block.function.name, block.function.arguments), index, raw: block };
  }
  return { kind: 'other', text: previewOf(block), index, raw: block };
}

/**
 * 一条消息的内容块。chat 的 tool_calls 在消息层，这里提升成 call 块；
 * 索引沿用各自协议里的位置，便于和服务端的 tool_call.ord 对齐。
 * @param {unknown} message
 * @returns {Block[]}
 */
export function messageBlocks(message) {
  if (!isRecord(message)) return [];
  /** @type {Block[]} */
  const out = [];
  const content = message.content;
  if (typeof content === 'string') {
    out.push({ kind: message.role === 'tool' ? 'result' : 'text', text: content, index: 0, raw: content });
  } else if (Array.isArray(content)) {
    for (const [index, block] of content.entries()) out.push(blockView(block, index));
  } else if (isRecord(content)) {
    out.push(blockView(content, 0));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [index, call] of message.tool_calls.entries()) out.push(blockView(call, index));
  }
  return out;
}

/** @param {unknown} message @returns {Role} */
export function roleOf(message) {
  if (!isRecord(message)) return 'unknown';
  const role = String(message.role ?? '');
  if (role === 'developer') return 'system';
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') return role;
  return 'unknown';
}

/** @param {Role} role */
export function roleTag(role) {
  return role.toUpperCase();
}

/** @param {Block[]} blocks */
function messagePreview(blocks) {
  for (const block of blocks) {
    if (block.kind === 'image') return '图片';
    if (block.text.length > 0) return clip(block.text, 140);
  }
  return '（空消息）';
}

/**
 * 把一页正文的消息归一化。page 为空时返回空表，调用方据此显示加载状态。
 * isInput 标记这条消息是否代表"人输入的话"：Anthropic 把 tool_result 放在
 * user 角色的消息里，这类消息在对话视图里是工具结果，不是用户提问。
 * @param {BodyPage | null} page
 * @returns {Entry[]}
 */
export function messageEntries(page) {
  if (page === null || page === undefined) return [];
  return page.messages.map(message => {
    const blocks = messageBlocks(message.value);
    const role = roleOf(message.value);
    const hasText = blocks.some(block => block.kind === 'text' && block.text.length > 0);
    return {
      ord: message.ord,
      role,
      blocks,
      preview: messagePreview(blocks),
      isInput: role === 'user' && hasText,
    };
  });
}

/**
 * 确定可以标记"新增"的消息序号。只有 first/confirmed 可信；
 * unknown 与未派生的请求返回 null，界面据此显示原因而不是拼出假对话。
 * @param {RequestDetail | null} detail
 * @returns {Set<number> | null}
 */
export function deltaOrdinals(detail) {
  if (detail === null) return null;
  if (detail.prev_relation !== 'first' && detail.prev_relation !== 'confirmed') return null;
  if (!Array.isArray(detail.delta_ordinals)) return null;
  return new Set(detail.delta_ordinals);
}

/** @param {unknown} value */
function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 回复归一化。anthropic 读 content 块数组，chat 读 choices[0].message。
 * 空回复与无法结构化分开报，不能都读成"没有内容"。
 * @param {BodyPage | null} page
 * @returns {ReplyView}
 */
export function replyView(page) {
  const reply = page === null || page === undefined ? null : page.reply;
  if (reply === null || reply === undefined) {
    return { state: 'absent', text: '', thinking: [], calls: [], finish: null, model: null, raw: null };
  }
  if (!isRecord(reply)) {
    return { state: 'invalid', text: '', thinking: [], calls: [], finish: null, model: null, raw: reply };
  }
  const model = textOrNull(reply.model);
  /** @param {Block[]} blocks @param {string | null} finish @returns {ReplyView} */
  const fromBlocks = (blocks, finish) => {
    const texts = [];
    const thinking = [];
    /** @type {ToolCallView[]} */
    const calls = [];
    for (const block of blocks) {
      if (block.kind === 'text' && block.text.length > 0) texts.push(block.text);
      if (block.kind === 'thinking' && block.text.length > 0) thinking.push(block.text);
      if (block.kind === 'call') {
        const raw = isRecord(block.raw) ? block.raw : {};
        const fn = isRecord(raw.function) ? raw.function : raw;
        calls.push({
          id: typeof raw.id === 'string' ? raw.id : '',
          name: typeof fn.name === 'string' ? fn.name : '',
          inputText: typeof fn.input === 'string' ? fn.input
            : typeof fn.arguments === 'string' ? fn.arguments
              : JSON.stringify(fn.input ?? fn.arguments ?? null) ?? '',
          ord: block.index,
        });
      }
    }
    return { state: 'ok', text: texts.join('\n\n'), thinking, calls, finish, model, raw: reply };
  };

  if (Array.isArray(reply.content)) {
    const blocks = reply.content.map((block, index) => blockView(block, index));
    return fromBlocks(blocks, textOrNull(reply.stop_reason));
  }
  const choices = Array.isArray(reply.choices) ? reply.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : null;
  const message = first !== null && isRecord(first.message) ? first.message : null;
  if (message !== null) {
    return fromBlocks(messageBlocks(message), first !== null ? textOrNull(first.finish_reason) : null);
  }
  return { state: 'invalid', text: '', thinking: [], calls: [], finish: null, model, raw: reply };
}

/**
 * 工具往返：回复里的调用按 ord 对齐服务端配对结果。
 * 配对表里没有的调用显示"还没有结果"，不按名称或相邻位置猜。
 * @param {RequestDetail | null} detail
 * @param {BodyPage | null} page
 * @returns {ToolEntry[]}
 */
export function toolEntries(detail, page) {
  const reply = replyView(page);
  const pairs = detail === null ? [] : detail.tool_calls;
  return reply.calls.map(call => {
    const pair = pairs.find(entry => entry.ord === call.ord) ?? null;
    return {
      call_id: call.id.length > 0 ? call.id : pair?.call_id ?? '',
      name: call.name,
      inputText: call.inputText,
      ord: call.ord,
      state: pair === null ? 'unpaired' : pair.state,
      result_req: pair === null ? null : pair.result_req,
      result_ord: pair === null ? null : pair.result_ord,
    };
  });
}

/**
 * 正文状态说明。已回收、未到、不支持都带原因，界面上不显示成空对话。
 * @param {BodyPage | null} page
 */
export function bodyNotice(page) {
  if (page === null) return '';
  if (page.state === 'evicted') return `正文已回收：${page.reason ?? '原因未记录'}`;
  if (page.state === 'pending') return page.reason === null ? '正文未到；回调可能稍后到达。' : `正文未到：${page.reason}`;
  if (page.state === 'unsupported') return '原对象已保存，暂不支持结构化解析';
  if (page.state === 'partial') return page.reason === null ? '正文不完整：只有部分内容可用。' : `正文不完整：${page.reason}`;
  if (page.reply_state === 'absent') return '已保存请求，上游未提供可用回复。';
  return '';
}

/**
 * 消息列表。可折叠行都是 button，键盘可达；预览单行截断，不撑破窄屏。
 * @param {Entry[]} entries
 * @param {MessageOptions} options
 */
export function renderMessages(entries, options) {
  const limit = options.limit ?? 40;
  const shown = entries.slice(0, limit);
  const rows = shown.map(entry => {
    const isNew = options.delta !== null && options.delta.has(entry.ord);
    const current = options.selectedOrd === entry.ord ? ' aria-current="true"' : '';
    return `<li class="msg" data-ord="${entry.ord}"${current}>
      <button class="msg-head" data-msg="${entry.ord}" aria-label="查看消息 ${entry.ord}">
        <span class="kind ${roleTag(entry.role)}">${roleTag(entry.role)}</span>
        <span class="msg-ord">#${entry.ord}</span>
        <span class="msg-preview">${esc(entry.preview)}</span>
        ${isNew ? '<span class="msg-new">新增</span>' : ''}
      </button>
    </li>`;
  }).join('');
  const more = entries.length > limit
    ? `<li class="msg-more"><button class="chip-btn" data-body-more-msg="1">还有 ${entries.length - limit} 条未显示</button></li>`
    : '';
  return `<ol class="msg-list">${rows}${more}</ol>`;
}

/**
 * 单条消息的完整内容。用户与工具结果按原文保留换行，助手文本按 Markdown 显示。
 * @param {Entry} entry
 */
export function renderMessageDetail(entry) {
  const blocks = entry.blocks.map(block => {
    if (block.kind === 'text') {
      return entry.role === 'assistant'
        ? `<div class="bp-text">${mdToHtml(block.text)}</div>`
        : `<div class="bp-text bp-plain">${esc(block.text)}</div>`;
    }
    if (block.kind === 'thinking') {
      return `<details class="msg-thinking" open><summary>推理块 · ${[...block.text].length} 字</summary>
        <pre class="raw" tabindex="0">${esc(block.text)}</pre></details>`;
    }
    if (block.kind === 'call' || block.kind === 'result') {
      return `<pre class="raw" tabindex="0">${esc(block.text)}</pre>`;
    }
    return `<pre class="raw" tabindex="0">${esc(JSON.stringify(block.raw, null, 2))}</pre>`;
  }).join('');
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind ${roleTag(entry.role)} bp-kind">${roleTag(entry.role)}</span>
      <span class="bp-path">messages[${entry.ord}]</span>
    </div>
    <div class="bp-meta"><span>${entry.blocks.length} 个内容块</span><span>·</span><span>按协议字段顺序展示</span></div>
    ${blocks.length > 0 ? blocks : '<p class="note">这条消息没有内容块。</p>'}
    <p class="rail-note">内容按脱敏后的原文保存；未知块以转义 JSON 展示，不做语义推测。</p>
  </div>`;
}

/**
 * 工具往返卡片。所有调用与结果都列出来，不只展开第一个。
 * @param {ToolEntry[]} tools
 */
export function renderTools(tools) {
  if (tools.length === 0) return '';
  const rows = tools.map(tool => {
    const state = tool.state === 'resolved' && tool.result_req !== null && tool.result_ord !== null
      ? `<span class="tool-chip res"><span>结果已配对</span></span>
         <button class="chip-btn" data-tool-result="${tool.result_req}" data-tool-ord="${tool.result_ord}">查看结果 · req ${tool.result_req} #${tool.result_ord}</button>`
      : tool.state === 'ambiguous' ? '<span class="tool-chip miss"><span>结果有多个候选，未配对</span></span>'
        : tool.state === 'pending' ? '<span class="tool-chip miss"><span>结果位置未确认</span></span>'
          : '<span class="tool-chip miss"><span>还没有见到结果</span></span>';
    return `<div class="tool-row">
      <span class="tool-chip call" title="${esc(tool.name)}"><span>${esc(tool.name)}(${esc(clip(tool.inputText, 90))})</span></span>
      ${state}
    </div>`;
  }).join('');
  return `<div class="conv-tools"><span class="label">工具往返</span>${rows}</div>`;
}

/**
 * 本次回复卡片（账本内使用）。空回复与无法解析分别说明。
 * @param {ReplyView} view
 * @param {ToolEntry[]} [tools]
 */
export function renderReply(view, tools = []) {
  const head = `<div class="reply-head">
    <span class="who">ASSISTANT</span>
    <span class="mono muted" style="font-size:10px">${esc(view.model ?? '模型名未报告')}</span>
    <span class="grow"></span>
    ${view.finish !== null ? `<span class="mono muted" style="font-size:10px">finish: ${esc(view.finish)}</span>` : ''}
  </div>`;
  if (view.state === 'absent') {
    return `<div class="reply-card">${head}
      <div class="reply-empty"><b>上游没有提供可用回复</b>
        <span>请求正文已保存；这一笔只有请求，没有回复对象，这里不补写内容。</span></div></div>`;
  }
  if (view.state === 'invalid') {
    return `<div class="reply-card">${head}
      <div class="reply-empty"><b>回复对象无法结构化</b>
        <span>原对象仍保存在库里，可在「原始脱敏对象」里查看。</span></div></div>`;
  }
  const thinking = view.thinking.length === 0 ? '' : `<details class="msg-thinking">
    <summary>推理块 · ${view.thinking.length} 段</summary>
    <pre class="raw" tabindex="0">${esc(view.thinking.join('\n\n'))}</pre></details>`;
  const text = view.text.length > 0
    ? `<div class="reply-text">${mdToHtml(view.text)}</div>`
    : view.calls.length === 0 ? '<div class="reply-empty"><span>回复对象存在，但没有文本内容。</span></div>' : '';
  return `<div class="reply-card">${head}${thinking}${text}${renderTools(tools)}</div>`;
}

/**
 * 右栏的回复详情，比账本卡片多给 finish 与工具状态。
 * @param {ReplyView} view
 * @param {ToolEntry[]} [tools]
 */
export function renderReplyDetail(view, tools = []) {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind REPLY bp-kind">REPLY</span>
      <span class="bp-path">reply</span>
    </div>
    <div class="bp-meta">
      <span>${esc(view.model ?? '模型名未报告')}</span>
      ${view.finish !== null ? `<span>·</span><span>finish: ${esc(view.finish)}</span>` : ''}
    </div>
    ${renderReply(view, tools)}
    <p class="rail-note">回复与请求上下文分开保存。工具结果不在本回复里，按 call id 指向后续请求的消息。</p>
  </div>`;
}

/**
 * 原始脱敏对象。只展示这一片实际取到的字段与回复，不合成任何 demo 值。
 * @param {BodyPage} page
 */
export function renderRaw(page) {
  /** @param {string} label @param {unknown} value @param {string} note */
  const group = (label, value, note) => value === null || value === undefined
    ? `<div class="raw-group"><div class="label">${label}</div><p class="note">${note}</p></div>`
    : `<div class="raw-group"><div class="label">${label}</div>
       <pre class="raw" tabindex="0">${esc(JSON.stringify(value, null, 2))}</pre></div>`;
  return group('请求字段（不含 messages）', page.request_fields, '这一片没有读到请求的顶层字段。')
    + group('回复对象', page.reply, '这一笔没有保存到回复对象。')
    + `<p class="note">消息正文按块单独分页读取；这里只展示请求顶层字段与回复。内容在写入前已脱敏，占位符不可逆。</p>`;
}
