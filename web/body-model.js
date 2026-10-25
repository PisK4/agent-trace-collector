// @ts-check
/**
 * 正文读取模型：两种协议的消息与回复归一化、块视图与工具条目。
 * 只做数据转换，不产生 HTML；展示路径在 body-view，转义策略在 html。
 *
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {import('../src/input-interpretation').UserInputView} UserInputView
 * @typedef {'system' | 'user' | 'assistant' | 'tool' | 'unknown'} Role
 * @typedef {{kind: string, text: string, index: number, raw: unknown, path: string, failed?: boolean}} Block
 * @typedef {{ord: number, role: Role, rawRole: string | null, blocks: Block[], preview: string, input: UserInputView | null, isInput: boolean}} Entry
 * @typedef {{id: string, name: string, inputText: string, ord: number, path: string}} ToolCallView
 * @typedef {{state: 'ok' | 'absent' | 'invalid', text: string, thinking: string[], calls: ToolCallView[], blocks: Block[], choiceCount: number | null, finish: string | null, model: string | null, raw: unknown}} ReplyView
 * @typedef {{call_id: string, name: string, inputText: string, ord: number, path: string, state: string, owner: number | null, result_req: number | null, result_ord: number | null, result_path: string | null, result_label?: string | null}} ToolEntry
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} text @param {number} max */
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
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
