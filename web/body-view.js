// @ts-check
/**
 * 正文视图：把一页 BodyPage 渲染成 HTML 片段。
 *
 * 这里只做字符串拼接，不碰 DOM，测试可以直接断言输出。
 * 协议正文一律先转义；只有 mdToHtml 识别少数结构，认不出的语法按原文保留，
 * 绝不把消息内容当 HTML 执行。
 *
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {'system' | 'user' | 'assistant' | 'tool' | 'unknown'} Role
 * @typedef {{kind: string, text: string, index: number, raw: unknown, path: string, failed?: boolean}} Block
 * @typedef {import('../src/input-interpretation').UserInputView} UserInputView
 * @typedef {{ord: number, role: Role, rawRole: string | null, blocks: Block[], preview: string, input: UserInputView | null, isInput: boolean}} Entry
 * @typedef {{id: string, name: string, inputText: string, ord: number, path: string}} ToolCallView
 * @typedef {{state: 'ok' | 'absent' | 'invalid', text: string, thinking: string[], calls: ToolCallView[], blocks: Block[], choiceCount: number | null, finish: string | null, model: string | null, raw: unknown}} ReplyView
 * @typedef {{call_id: string, name: string, inputText: string, ord: number, path: string, state: string, owner: number | null, result_req: number | null, result_ord: number | null, result_path: string | null, result_label?: string | null}} ToolEntry
 * @typedef {{delta: Set<number> | null, limit?: number, selectedOrd?: number | null, gaps?: {from: number, to: number}[]}} MessageOptions
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
 * @param {string} path 块在所属消息内的协议位置（content[i] / tool_calls[i]），由调用方给出
 * @returns {Block}
 */
function blockView(block, index, path) {
  if (!isRecord(block)) return { kind: 'other', text: previewOf(block), index, raw: block, path };
  const type = String(block.type ?? '');
  if (type === 'text') return { kind: 'text', text: previewOf(block.text), index, raw: block, path };
  if (type === 'thinking') {
    return { kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : previewOf(block), index, raw: block, path };
  }
  if (type === 'redacted_thinking') {
    return { kind: 'thinking', text: '（推理内容已被上游加密，只保留占位块）', index, raw: block, path };
  }
  if (type === 'tool_use') return { kind: 'call', text: callLabel(block.name, block.input), index, raw: block, path };
  if (type === 'tool_result') {
    // is_error 只在正文里按需读取；缺失保持未报告，不等于成功。
    const failed = typeof block.is_error === 'boolean' ? block.is_error : undefined;
    return { kind: 'result', text: previewOf(block.content), index, raw: block, path, failed };
  }
  if (type === 'image' || type === 'input_image') return { kind: 'image', text: imageLabel(block), index, raw: block, path };
  // chat 的函数调用块：{id, type:'function', function:{name, arguments}}
  if (isRecord(block.function)) {
    return { kind: 'call', text: callLabel(block.function.name, block.function.arguments), index, raw: block, path };
  }
  return { kind: 'other', text: previewOf(block), index, raw: block, path };
}

/**
 * 单条消息的内容块。chat 的 tool_calls 在消息层，这里提升成 call 块；
 * 索引沿用各自协议里的位置，便于和服务端的 tool_call.ord 对齐。
 * path 是块在消息内的实际协议位置（content[i] / tool_calls[i]），供步骤来源拼接。
 * @param {unknown} message
 * @returns {Block[]}
 */
export function messageBlocks(message) {
  if (!isRecord(message)) return [];
  /** @type {Block[]} */
  const out = [];
  const content = message.content;
  if (typeof content === 'string') {
    out.push({ kind: message.role === 'tool' ? 'result' : 'text', text: content, index: 0, raw: content, path: 'content' });
  } else if (Array.isArray(content)) {
    for (const [index, block] of content.entries()) {
      out.push(blockView(block, index, `content[${index}]`));
    }
  } else if (isRecord(content)) {
    out.push(blockView(content, 0, 'content'));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [index, call] of message.tool_calls.entries()) {
      out.push(blockView(call, index, `tool_calls[${index}]`));
    }
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
 * 消息级主角色：纯工具结果消息显示 Tool，混合消息保留协议角色、逐块解释，
 * 不把整条 user 消息改成 Tool。纯调用的助手消息仍是 Assistant。
 * @param {Entry} entry
 * @returns {Role}
 */
export function displayRoleOf(entry) {
  if (entry.blocks.length > 0 && entry.blocks.every(block => block.kind === 'result')) return 'tool';
  return entry.role;
}

/**
 * 顶层 system 字段的文本。Chat 与 Anthropic 都保存在 request_fields.system：
 * 字符串直读，块数组取 text 块拼接。缺失或为空返回 null，不从相邻字段补猜。
 * @param {BodyPage | null | undefined} page
 * @returns {string | null}
 */
export function topSystemText(page) {
  const fields = page === null || page === undefined ? null : page.request_fields;
  const system = fields !== null && typeof fields === 'object' && !Array.isArray(fields)
    ? /** @type {Record<string, unknown>} */ (fields).system ?? null : null;
  if (typeof system === 'string') return system.length > 0 ? system : null;
  if (Array.isArray(system)) {
    const texts = system
      .map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .filter(text => text.length > 0);
    return texts.length > 0 ? texts.join('\n\n') : null;
  }
  return null;
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
 * 输入解释只认服务端 `interpretations`：Anthropic 把 tool_result 放在 user
 * 角色的消息里，这类消息在对话视图里不是用户提问；包装是否算用户输入也由
 * 服务端同一套规则判定，页面不再按角色与文本自行猜测。
 * @param {BodyPage | null} page
 * @returns {Entry[]}
 */
export function messageEntries(page) {
  if (page === null || page === undefined) return [];
  const byOrd = new Map((page.interpretations ?? []).map(item => [item.ord, item]));
  return page.messages.map(message => {
    const blocks = messageBlocks(message.value);
    const role = roleOf(message.value);
    const interpretation = byOrd.get(message.ord) ?? null;
    return {
      ord: message.ord,
      role,
      rawRole: isRecord(message.value) && typeof message.value.role === 'string' ? message.value.role : null,
      blocks,
      preview: messagePreview(blocks),
      input: interpretation === null ? null : interpretation.input,
      isInput: interpretation !== null && interpretation.is_input === true,
    };
  });
}

/**
 * 复制用的原文。取消息块里的原始文本，不做 HTML 转义，也不替换成解释后的文本；
 * 页面展示路径仍然逐块转义，两条路径分开。
 * @param {Entry} entry
 */
export function messageCopyText(entry) {
  return entry.blocks.map(block => block.text).filter(text => text.length > 0).join('\n\n');
}

/**
 * 确定可以标记"新增"的消息序号。只有 first/confirmed 可信；
 * unknown 与未派生的请求返回 null，界面据此显示原因而不是拼出假对话。
 * @param {RequestDetail | null} detail
 * @returns {Set<number> | null}
 */
export function deltaOrdinals(detail) {
  if (detail === null) return null;
  // 链结果不是当前结论时，增量是上一次完成时的产物，不能当成这一轮新增。
  if (detail.derivation === undefined || detail.derivation.chain_state !== 'current') return null;
  if (detail.prev_relation !== 'first' && detail.prev_relation !== 'confirmed') return null;
  if (!Array.isArray(detail.delta_ordinals)) return null;
  return new Set(detail.delta_ordinals);
}

/** @param {unknown} value */
function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 回复归一化，是回复协议形状的唯一拆分点。anthropic 读 content 块数组，chat 读
 * choices[0].message。blocks 按协议原始顺序给出，路径从回复根算起
 * （reply.content[i] / reply.choices[0].message.*），序号沿用协议内位置。
 * 多 choice 不在拆分点隐瞒：choiceCount 声明原始项数，调用方自行决定是否拆行。
 * 空回复与无法结构化分开报，不能都读成"没有内容"。
 * @param {BodyPage | null} page
 * @returns {ReplyView}
 */
export function replyView(page) {
  const reply = page === null || page === undefined ? null : page.reply;
  if (reply === null || reply === undefined) {
    return { state: 'absent', text: '', thinking: [], calls: [], blocks: [], choiceCount: null, finish: null, model: null, raw: null };
  }
  if (!isRecord(reply)) {
    return { state: 'invalid', text: '', thinking: [], calls: [], blocks: [], choiceCount: null, finish: null, model: null, raw: reply };
  }
  const model = textOrNull(reply.model);
  const choiceCount = Array.isArray(reply.choices) ? reply.choices.length : null;
  /**
   * @param {Block[]} blocks 块内路径相对所属消息（content[i] / tool_calls[i]）
   * @param {string} base 回复根到所属消息的前缀（reply / reply.choices[0].message）
   * @param {string | null} finish
   * @returns {ReplyView}
   */
  const fromBlocks = (blocks, base, finish) => {
    const texts = [];
    const thinking = [];
    /** @type {ToolCallView[]} */
    const calls = [];
    const full = blocks.map(block => ({ ...block, path: `${base}.${block.path}` }));
    for (const block of full) {
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
          path: block.path,
        });
      }
    }
    return { state: 'ok', text: texts.join('\n\n'), thinking, calls, blocks: full, choiceCount, finish, model, raw: reply };
  };

  if (Array.isArray(reply.content)) {
    const blocks = reply.content.map((block, index) => blockView(block, index, `content[${index}]`));
    return fromBlocks(blocks, 'reply', textOrNull(reply.stop_reason));
  }
  const choices = Array.isArray(reply.choices) ? reply.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : null;
  const message = first !== null && isRecord(first.message) ? first.message : null;
  if (message !== null) {
    return fromBlocks(messageBlocks(message), 'reply.choices[0].message',
      first !== null ? textOrNull(first.finish_reason) : null);
  }
  return { state: 'invalid', text: '', thinking: [], calls: [], blocks: [], choiceCount, finish: null, model, raw: reply };
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
      path: call.path,
      state: pair === null ? 'unpaired' : pair.state,
      // 按钮身份用调用者 owner + 调用序号；不再按 result_req/result_ord 反查调用。
      owner: detail === null ? null : detail.req_id,
      result_req: pair === null ? null : pair.result_req,
      result_ord: pair === null ? null : pair.result_ord,
      result_path: pair === null ? null : pair.result_path,
    };
  });
}

/**
 * 正文状态说明。已回收、未到、不支持都带原因，界面上不显示成空对话。
 * 保存覆盖（state）与协议解释（parse_state）分开：原文完整但协议未适配时
 * 保留原对象阅读，不显示成空消息或零技能。
 * @param {BodyPage | null} page
 */
export function bodyNotice(page) {
  if (page === null) return '';
  if (page.state === 'evicted') return `正文已回收：${page.reason ?? '原因未记录'}`;
  if (page.state === 'pending') return page.reason === null ? '正文未到；回调可能稍后到达。' : `正文未到：${page.reason}`;
  if (page.state === 'unsupported') return '原对象已保存，暂不支持结构化解析';
  if (page.state === 'partial') return page.reason === null ? '正文不完整：只有部分内容可用。' : `正文不完整：${page.reason}`;
  if (page.parse_state === 'unsupported') return '协议未适配：原对象已保存，可按原文阅读请求字段与回复，消息结构不按已知协议解释。';
  if (page.reply_state === 'absent') return '已保存请求，上游未提供可用回复。';
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
  const gapRow = gap => `<li class="msg-gap"><span>#${gap.from}${gap.to > gap.from ? `–#${gap.to}` : ''} 未读取</span></li>`;
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
    const typePrefix = entry.blocks.length > 0 && entry.blocks.every(block => block.kind === 'result') ? 'Tool result · '
      : entry.blocks.length > 0 && entry.blocks.every(block => block.kind === 'call') ? 'Tool call · ' : '';
    rows.push(`<li class="msg" data-ord="${entry.ord}"${current}>
      <button class="msg-head" data-msg="${entry.ord}" aria-label="查看消息 ${entry.ord}">
        <span class="kind ${roleClass(displayRole)}">${roleTag(displayRole)}</span>
        <span class="msg-ord">#${entry.ord}</span>
        <span class="msg-preview">${esc(typePrefix + entry.preview)}</span>
        ${isNew ? '<span class="msg-new">新增</span>' : ''}
      </button>
    </li>`);
  });
  const more = entries.length > limit
    ? `<li class="msg-more"><button class="chip-btn" data-body-more-msg="1">还有 ${entries.length - limit} 条未显示</button></li>`
    : '';
  return `<ol class="msg-list">${rows.join('')}${more}</ol>`;
}

/**
 * 单条消息的完整内容。用户与工具结果按原文保留换行，助手文本按 Markdown 显示。
 * @param {Entry} entry
 */
export function renderMessageDetail(entry) {
  const displayRole = displayRoleOf(entry);
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
      const failed = block.kind === 'result' && block.failed === true
        ? '<span class="tool-chip miss"><span>工具结果失败</span></span>' : '';
      return `${failed}<pre class="raw" tabindex="0" data-block-path="${esc(block.path)}">${esc(block.text)}</pre>`;
    }
    return `<pre class="raw" tabindex="0" data-block-path="${esc(block.path)}">${esc(JSON.stringify(block.raw, null, 2))}</pre>`;
  }).join('');
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind ${roleClass(displayRole)} bp-kind">${roleTag(displayRole)}</span>
      <span class="bp-path">messages[${entry.ord}]</span>
      <button class="chip-btn" data-copy-msg="${entry.ord}">复制原文</button>
    </div>
    <div class="bp-meta"><span>role=${esc(entry.rawRole ?? displayRole)}</span><span>·</span><span>${entry.blocks.length} 个内容块</span></div>
    ${blocks.length > 0 ? blocks : '<p class="note">这条消息没有内容块。</p>'}
  </div>`;
}

/**
 * 顶层 System 的右栏详情：全文转义展示，路径固定 request.system。
 * @param {string} text
 */
export function renderSystemDetail(text) {
  return `<div class="body-panel">
    <div class="bp-head">
      <span class="kind system bp-kind">System</span>
      <span class="bp-path">request.system</span>
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
    <p class="rail-note">这一块没有已适配的协议解释；原对象按脱敏后的 JSON 展示。</p>
  </div>`;
}

/**
 * 工具往返折叠行。每次调用都提供右栏内打开配对页的入口，阅读就地完成；
 * 没有配对信息就不显示状态，只有异常（多候选）才提示。
 * @param {ToolEntry[]} tools
 * @param {string} [foldKey] 折叠持久化键前缀（req id）；空串不持久化
 */
export function renderTools(tools, foldKey = '') {
  if (tools.length === 0) return '';
  const rows = tools.map(tool => {
    const open = `<button class="chip-btn" data-tool-owner="${tool.owner}" data-call-ord="${tool.ord}">配对两端 ▸</button>`;
    const warn = tool.state === 'ambiguous'
      ? '<span class="tool-chip miss"><span>结果有多个候选，未配对</span></span>' : '';
    return `<div class="tool-row">
      <span class="tool-chip call ${toolTint(tool.name)}" title="${esc(tool.name)}"><span>${esc(tool.name)}(${esc(clip(tool.inputText, 90))})</span></span>
      ${open}${warn}
    </div>`;
  }).join('');
  const foldAttr = foldKey === '' ? '' : ` data-fold="round:${esc(foldKey)}"`;
  return `<details class="rail-fold sub"${foldAttr} open>
    <summary>工具往返<span class="fold-count">${tools.length} 次</span></summary>
    <div class="fold-body">${rows}</div>
  </details>`;
}

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
  if (view.state === 'absent') {
    return `<div class="reply-empty"><b>上游没有提供可用回复</b>
      <span>请求正文已保存；这一笔只有请求，没有回复对象，这里不补写内容。</span></div>`;
  }
  if (view.state === 'invalid') {
    return `<div class="reply-empty"><b>回复对象无法结构化</b>
      <span>原对象仍保存在库里。</span></div>`;
  }
  const thinking = view.thinking.length === 0 ? '' : subFold('think',
    `<summary>推理块<span class="fold-count">${view.thinking.length} 段</span></summary>
     <div class="fold-body"><pre class="raw" tabindex="0">${esc(view.thinking.join('\n\n'))}</pre></div>`);
  const text = view.text.length > 0
    ? `<div class="reply-text">${mdToHtml(view.text)}</div>`
    : view.calls.length === 0 ? '<div class="reply-empty"><span>回复对象存在，但没有文本内容。</span></div>' : '';
  return `${thinking}${text}${renderTools(tools, foldKey)}`;
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
    <p class="rail-note">工具结果不在本回复里，按 call id 指向后续请求的消息。</p>
  </div>`;
}

// —— 上下文组成：已知六类与未知类别 ——

export const PARTS = [
  { kind: 'system', label: '系统提示' },
  { kind: 'tools', label: '工具定义' },
  { kind: 'memory', label: '记忆与技能' },
  { kind: 'files', label: '文件引用' },
  { kind: 'results', label: '工具结果' },
  { kind: 'chat', label: '对话内容' },
];

/** 未知 kind 原样显示，不折叠成"其它"。 @param {string} kind */
export function partLabel(kind) {
  return PARTS.find(part => part.kind === kind)?.label ?? String(kind);
}

/** 未知 kind 使用独立颜色变量，避免落到某个已知类别上。 @param {string} kind */
export function partColor(kind) {
  const index = PARTS.findIndex(part => part.kind === kind);
  return index < 0 ? 'var(--p-unknown)' : `var(--p${index + 1})`;
}

// —— 工具身份强调色：六个核心工具各一色相，其余统一中性 ——

/**
 * 工具名 → 色类。行内 chip、面板头 bp-kind 与正文 tool-chip 共用这一套类名，
 * 颜色只承载工具身份一个语义；新工具（含 MCP）落中性色，无需改代码。
 * @param {string} name
 */
export function toolTint(name) {
  switch (name) {
    case 'Read': return 'tint-read';
    case 'Edit': return 'tint-edit';
    case 'Write': return 'tint-write';
    case 'Bash':
    case 'bash': return 'tint-bash';
    case 'Skill': return 'tint-skill';
    case 'Agent': return 'tint-agent';
    default: return 'tint-other';
  }
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
 * 尝试链。每一行只用服务端白名单字段；未知 fail 原样转义。
 * 缺开始时间时只附说明，不计算任何相邻尝试的时间差。
 * @param {import('../src/queries/routes').AttemptChain | null | undefined} chain
 * @returns {string}
 */
export function renderAttemptChain(chain) {
  if (chain === null || chain === undefined || chain.state !== 'present') {
    return '<p class="note">没有可读取的尝试记录。</p>';
  }
  const rows = chain.items.map(item => {
    const bits = [item.model ?? '模型未报告'];
    if (item.served !== null && item.served !== item.model) bits.push(`served ${item.served}`);
    if (item.status !== null) bits.push(`HTTP ${item.status}`);
    if (item.fail !== null) bits.push(`fail ${item.fail}`);
    if (item.effort !== null) bits.push(`effort ${item.effort}`);
    if (item.tier_served !== null) bits.push(`tier ${item.tier_served}`);
    if (item.reasoning_hidden === true) bits.push('推理隐藏');
    if (item.done === false) bits.push('未结束');
    if (item.start_ms !== null) {
      const started = new Date(item.start_ms);
      if (!Number.isNaN(started.getTime())) bits.push(started.toISOString());
    }
    if (item.ms !== null) bits.push(`${item.ms} ms`);
    if (item.ttft_ms !== null) bits.push(`首 token ${item.ttft_ms} ms`);
    if (item.first_reasoning_ms !== null) bits.push(`首个推理 ${item.first_reasoning_ms} ms`);
    if (item.first_text_ms !== null) bits.push(`首个文本 ${item.first_text_ms} ms`);
    if (item.queued_ms !== null) bits.push(`排队 ${item.queued_ms} ms`);
    return `<span class="attempt-name">${item.index + 1}. ${bits.map(esc).join(' · ')}</span>`;
  }).join('<br>');
  const note = chain.timing.state === 'partial'
    ? `<p class="note">${esc(chain.timing.note)}</p>` : '';
  return `${rows}${note}`;
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
      ? '协议未适配：保存的原文可读，但无法按已知协议判定这一笔携带的工具与技能。'
      : text[result.state] ?? result.state;
    const chip = result.reason === 'protocol_unsupported' ? '协议未适配' : text[result.state] ?? result.state;
    return `<details class="rail-fold" data-fold="${key}">
      <summary>${label}<span class="fold-count warn">${esc(chip)}</span></summary>
      <div class="fold-body"><p class="note">${esc(note)}</p></div>
    </details>`;
  };
  return row(view.tools, '工具清单', 'cap:tools',
      `<ol class="cap-list">${view.tools.items.map(renderToolItem).join('')}</ol>`, TOOL_STATE_TEXT)
    + row(view.skills, '技能清单', 'cap:skills',
      `<ul class="cap-list">${view.skills.items.map(renderSkillItem).join('')}</ul>`, SKILL_STATE_TEXT);
}
