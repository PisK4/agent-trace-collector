// @ts-check
/**
 * 正文读取模型：两种协议的消息与回复归一化、块视图与工具条目。
 * 只做数据转换，不产生 HTML；展示路径在 body-view，转义策略在 html。
 *
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {import('../src/input-interpretation').UserInputView} UserInputView
 * @typedef {'system' | 'user' | 'assistant' | 'tool' | 'unknown'} Role
 * @typedef {{kind: string, text: string, index: number, raw: unknown, path: string, failed?: boolean, callId?: string}} Block
 * @typedef {{ord: number, role: Role, rawRole: string | null, blocks: Block[], preview: string, input: UserInputView | null, isInput: boolean}} Entry
 * @typedef {{id: string, name: string, inputText: string, ord: number, path: string}} ToolCallView
 * @typedef {{state: 'ok' | 'absent' | 'invalid' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial', text: string, thinking: string[], calls: ToolCallView[], blocks: Block[], choiceCount: number | null, finish: string | null, model: string | null, raw: unknown}} ReplyView
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
  // Responses 的文本块叫 input_text / output_text；消息项与回复项共用这一条。
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return { kind: 'text', text: previewOf(block.text), index, raw: block, path };
  }
  if (type === 'thinking') {
    return { kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : previewOf(block), index, raw: block, path };
  }
  if (type === 'redacted_thinking') {
    return { kind: 'thinking', text: '（推理内容已被上游加密，只保留占位块）', index, raw: block, path };
  }
  // Responses 的推理项只有摘要，正文不落明文；摘要缺失时如实说明。
  if (type === 'reasoning') {
    const summary = previewOf(block.summary);
    const text = summary.length > 0 ? summary : '（上游未返回推理摘要）';
    return { kind: 'thinking', text, index, raw: block, path };
  }
  if (type === 'tool_use') return { kind: 'call', text: callLabel(block.name, block.input), index, raw: block, path };
  // Responses 的调用项：参数键分 input（custom）与 arguments（function），身份是 call_id。
  if (type === 'function_call' || type === 'custom_tool_call') {
    return { kind: 'call', text: callLabel(block.name, block.input ?? block.arguments), index, raw: block, path };
  }
  if (type === 'tool_result') {
    // is_error 只在正文里按需读取；缺失保持未报告，不等于成功。
    const failed = typeof block.is_error === 'boolean' ? block.is_error : undefined;
    return { kind: 'result', text: previewOf(block.content), index, raw: block, path, failed };
  }
  // Responses 的结果项没有独立失败位：错误写在 output 里，不在这里猜。
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    return { kind: 'result', text: previewOf(block.output), index, raw: block, path };
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
    // chat 的工具结果写成 role=tool 的整条消息，身份在消息顶层的 tool_call_id 上；
    // 块里没有这个字段，归一化时带上，供按 call_id 查找两端。
    const callId = message.role === 'tool' && typeof message.tool_call_id === 'string'
      ? message.tool_call_id : undefined;
    out.push({ kind: message.role === 'tool' ? 'result' : 'text', text: content, index: 0, raw: content, path: 'content', callId });
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
  // Responses 的顶层项本身就是一段：调用、结果与推理没有 content。
  // 只有无 role 的项走这条，带 role 的空消息仍显示为空消息。
  if (out.length === 0 && typeof message.role !== 'string' && typeof message.type === 'string') {
    out.push(blockView(message, 0, ''));
  }
  return out;
}

/**
 * 调用块的身份与参数：Anthropic 用 id/name/input，Chat 用 function.name/arguments，
 * Responses 用 call_id 与 input/arguments。回复视图与请求消息的调用行共用这一份
 * 提取，不按消息方向另写协议分叉。
 * @param {Block} block 调用块（kind='call'）
 * @returns {{id: string, name: string, inputText: string}}
 */
export function toolCallOfBlock(block) {
  const raw = isRecord(block.raw) ? block.raw : {};
  const fn = isRecord(raw.function) ? raw.function : raw;
  return {
    id: typeof raw.id === 'string' ? raw.id
      : typeof raw.call_id === 'string' ? raw.call_id : '',
    name: typeof fn.name === 'string' ? fn.name : '',
    inputText: typeof fn.input === 'string' ? fn.input
      : typeof fn.arguments === 'string' ? fn.arguments
        : JSON.stringify(fn.input ?? fn.arguments ?? null) ?? '',
  };
}

/**
 * 结果块指向的调用身份：Anthropic 用 tool_use_id，Responses 用 call_id，chat 的
 * tool_call_id 落在整条消息上，由 messageBlocks 归一化到块上。读不到返回空串，
 * 不按块序号猜。
 * @param {Block} block 结果块（kind='result'）
 * @returns {string}
 */
export function toolResultCallIdOf(block) {
  if (typeof block.callId === 'string' && block.callId !== '') return block.callId;
  const raw = isRecord(block.raw) ? block.raw : {};
  return typeof raw.tool_use_id === 'string' ? raw.tool_use_id
    : typeof raw.call_id === 'string' ? raw.call_id : '';
}

/**
 * 消息详情里的配对入口坐标：call_id 能确认两端才给，读不到返回 null。
 * 结果块的调用方取本请求的反向配对索引；调用块的调用方是产出请求（已确认前驱），
 * 按 call_id 在它的调用表里找序号。前驱不在窗口、未读或 call_id 对不上时不给，
 * 不按块序号猜。
 * @param {RequestDetail | null} detail
 * @param {RequestDetail | null} prevDetail
 * @returns {(block: Block) => {owner: number, callOrd: number} | null}
 */
export function messagePairIndexOf(detail, prevDetail) {
  return (block) => {
    if (block.kind === 'result') {
      const id = toolResultCallIdOf(block);
      if (id === '') return null;
      const row = detail?.tool_results.find(item => item.call_id === id) ?? null;
      return row === null || row.state !== 'resolved' ? null : { owner: row.owner_req, callOrd: row.ord };
    }
    if (block.kind === 'call') {
      const id = toolCallOfBlock(block).id;
      if (id === '' || prevDetail === null) return null;
      const row = prevDetail.tool_calls.find(item => item.call_id === id) ?? null;
      return row === null ? null : { owner: prevDetail.req_id, callOrd: row.ord };
    }
    return null;
  };
}

/** @param {unknown} message @returns {Role} */
export function roleOf(message) {
  if (!isRecord(message)) return 'unknown';
  const role = String(message.role ?? '');
  if (role === 'developer') return 'system';
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') return role;
  if (role.length > 0) return 'unknown';
  // Responses 的顶层项没有 role，按 type 推断，与服务端 roleNameOfItem 同一份规则。
  const type = message.type;
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'reasoning') return 'assistant';
  if (type === 'function_call_output' || type === 'custom_tool_call_output') return 'tool';
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
 * 顶层 system 字段的文本。Anthropic 与 Chat 保存在 `request_fields.system`，
 * Responses 在 `instructions`：字符串直读，块数组取 text 块拼接。两者都存在时
 * 按 system 在前合并，与服务端 `systemTextsOf` 的顺序一致。缺失或为空返回 null。
 * @param {BodyPage | null | undefined} page
 * @returns {string | null}
 */
export function topSystemText(page) {
  const fields = page === null || page === undefined ? null : page.request_fields;
  const source = fields !== null && typeof fields === 'object' && !Array.isArray(fields)
    ? /** @type {Record<string, unknown>} */ (fields) : null;
  const parts = [fieldsText(source === null ? null : source.system),
    fieldsText(source === null ? null : source.instructions)]
    .filter(text => text !== null && text.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * 单个系统提示字段的文本：字符串直读，块数组取 text 块拼接。
 * @param {unknown} value
 * @returns {string | null}
 */
function fieldsText(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const texts = value
      .map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .filter(text => text.length > 0);
    return texts.length > 0 ? texts.join('\n\n') : null;
  }
  return null;
}

/**
 * 消息数组在原始请求对象里的键：Responses 用 `input`，其余协议用 `messages`。
 * 浏览器不打包 `protocol-shape`，协议名从 `BodyPage.protocol` 取；正文页还没读到
 * 时协议未知，按 `messages` 拼路径，与读取端旧布局的缺省一致。
 * @param {BodyPage | null | undefined} page
 * @returns {'messages' | 'input'}
 */
export function messagesKeyOf(page) {
  const protocol = page === null || page === undefined ? null : page.protocol;
  return protocol === 'responses' ? 'input' : 'messages';
}

/**
 * 消息在原始请求对象里的路径前缀，如 `request.messages[3]` 或 `request.input[3]`。
 * 轨迹与配对页都用它拼与后端 `result_path` 比对的位置。
 * @param {BodyPage | null | undefined} page
 * @param {number} ord
 * @returns {string}
 */
export function messagePathOf(page, ord) {
  return `request.${messagesKeyOf(page)}[${ord}]`;
}

/**
 * 从已有协议路径认消息数组键：`request.input[3]` → `input`，其余按 `messages`。
 * 只认路径前缀，不看内容。
 * @param {string | null | undefined} path
 * @returns {'messages' | 'input'}
 */
export function messagesKeyOfPath(path) {
  return typeof path === 'string' && path.startsWith('request.input[') ? 'input' : 'messages';
}

/**
 * 顶层系统提示在原始对象里的路径：Responses 是 `request.instructions`，
 * 其余协议是 `request.system`。轨迹步骤与右栏详情共用这一份。
 * @param {BodyPage | null | undefined} page
 * @returns {'request.system' | 'request.instructions'}
 */
export function systemPathOf(page) {
  const protocol = page === null || page === undefined ? null : page.protocol;
  return protocol === 'responses' ? 'request.instructions' : 'request.system';
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
 * Responses 的回复块：`output` 每一项是一段。`message` 项展开 content，
 * 其余项（调用、推理）整项即块。路径从回复根算起（reply.output[i]），
 * 序号取项在 output 里的位置，与服务端 tool_call.ord 同源。
 * @param {Record<string, unknown>} reply
 * @returns {Block[]}
 */
function outputBlocks(reply) {
  const output = Array.isArray(reply.output) ? reply.output : [];
  /** @type {Block[]} */
  const out = [];
  for (const [index, item] of output.entries()) {
    if (isRecord(item) && item.type === 'message') {
      for (const block of messageBlocks(item)) {
        // 无 content 的 message 项退回整项一块，块路径就是项本身。
        const path = block.path === ''
          ? `reply.output[${index}]` : `reply.output[${index}].${block.path}`;
        out.push({ ...block, index, path });
      }
      continue;
    }
    out.push(blockView(item, index, `reply.output[${index}]`));
  }
  return out;
}

/**
 * Responses 的完成状态：`status` 与 Anthropic 的 `stop_reason` 不是同一套词表。
 * `incomplete` 的原因（max_output_tokens / content_filter）抬到 finish，
 * 免得页面把已知的截断显示成未知停止。
 * @param {Record<string, unknown>} reply
 * @returns {string | null}
 */
function responsesFinish(reply) {
  const status = textOrNull(reply.status);
  if (status !== 'incomplete') return status;
  const details = isRecord(reply.incomplete_details) ? reply.incomplete_details : null;
  return details === null ? status : textOrNull(details.reason) ?? status;
}

/**
 * 没有回复对象时继承正文状态。正文未到（pending）不等于上游没有提供回复，
 * 已回收、未适配与摘要也不是同一件事；正文可读时才用 reply_state 解释，
 * 那是服务端对回复本身的判定。只有读得到正文且服务端明说没有回复，才是 absent。
 * @param {BodyPage | null} page
 * @returns {'absent' | 'invalid' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial'}
 */
function emptyReplyState(page) {
  if (page === null || page === undefined) return 'absent';
  if (page.state === 'pending' || page.state === 'evicted' || page.state === 'unsupported'
    || page.state === 'summary' || page.state === 'partial') return page.state;
  if (page.reply_state === 'invalid') return 'invalid';
  if (page.reply_state === 'unsupported') return 'unsupported';
  return 'absent';
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
    return { state: emptyReplyState(page), text: '', thinking: [], calls: [], blocks: [], choiceCount: null, finish: null, model: null, raw: null };
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
    // Responses 的块路径已从回复根算起，base 为空时不再拼前缀。
    const full = blocks.map(block => ({
      ...block, path: base === '' ? block.path : `${base}.${block.path}`,
    }));
    for (const block of full) {
      if (block.kind === 'text' && block.text.length > 0) texts.push(block.text);
      if (block.kind === 'thinking' && block.text.length > 0) thinking.push(block.text);
      if (block.kind === 'call') {
        calls.push({ ...toolCallOfBlock(block), ord: block.index, path: block.path });
      }
    }
    return { state: 'ok', text: texts.join('\n\n'), thinking, calls, blocks: full, choiceCount, finish, model, raw: reply };
  };

  if (Array.isArray(reply.content)) {
    const blocks = reply.content.map((block, index) => blockView(block, index, `content[${index}]`));
    return fromBlocks(blocks, 'reply', textOrNull(reply.stop_reason));
  }
  if (Array.isArray(reply.output)) {
    return fromBlocks(outputBlocks(reply), '', responsesFinish(reply));
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
