/**
 * 请求输入的纯解释：把 harness 包装与注入文本从用户真正说的话里分开。
 *
 * 模块不读数据库、不解压正文，也不改写原始消息；调用方传入已读出的消息对象，
 * 得到状态、类别与可展示文本。原文保留在 `original`，供页面与复制使用。
 *
 * 包装按内容块出现，不只在消息开头：一条用户消息常由多个文本块拼成，
 * system-reminder、命令回显与附件各自成块，也可能排在用户正文之后。
 * 所以先逐块清洗再拼接，整段规则只处理剩下的开头包装。
 */
export type InputState = 'text' | 'empty' | 'injected' | 'unrecognized';
export type InputKind = 'plain' | 'wrapped' | 'midturn' | 'title_request'
  | 'command_echo' | 'skill_injection' | 'system_notice';

export type UserInputView = {
  state: InputState;
  kind: InputKind;
  text: string;
  original: string;
  removed: string[];
  agent: string | null;
  rule: 'generic';
};

export type MessageView = {
  ord: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  role_state: 'known' | 'unknown';
  input: UserInputView | null;
};

/** 套着用户正文的壳：剥壳留内容。 */
const UNWRAP_TAGS = new Set(['session', 'user']);
/**
 * 注入内容：不是用户说的话，整段丢弃。
 *
 * `job` 是 omp 的作业规格，后面才跟用户自己的话；`file` 是附件正文；
 * `chat` 是命令注入的对话简报。三者都不该占用户气泡，也不该当标题来源。
 */
const DROP_TAGS = new Set([
  'system-reminder', 'transcript', 'local-command-stdout', 'local-command-caveat',
  'command-name', 'command-message', 'command-args', 'system-notice', 'recap',
  'job', 'file', 'chat',
]);
/** 粘贴标记：`<pasted_content id=…>` 独立成行，粘贴正文紧跟其后。 */
const PASTE_MARKER = /^\s*<pasted_content(?:\s[^>]*)?>[ \t]*(?:\r?\n)?/i;
/** 粘贴的闭合标签：常落在后续消息里，标签后可能还跟着用户自己的话。 */
const PASTE_CLOSE = /<\/pasted_content[^>]*>/gi;
const MIDTURN_PREFIX = /^The user sent a new message while you were working:\s*/i;
const MIDTURN_NOTICE = /This is how Claude Code surfaces messages[\s\S]*$/i;
const CWD_PREFIX = /^\s*(?:工作目录|working directory|cwd)[:：][^\n]*\n?/i;
const SKILL_INJECTION = /^Base directory for this skill:/i;
const STEPPED_AWAY = /^The user stepped away and is coming back\b/i;

type StripResult = { text: string; tag: string | null; malformed: boolean };

function knownWrapper(tag: string): boolean {
  return UNWRAP_TAGS.has(tag) || DROP_TAGS.has(tag) || /^command-[a-z-]+$/.test(tag);
}

/**
 * 剥掉开头一个已知配对标签。
 *
 * 只有请求开头才是包装的位置；正文中间出现的同名标签属于用户内容，原样保留。
 * 嵌套同名标签按深度扫描，未闭合返回 malformed，由调用方保留原文。
 */
function stripLeadingTag(text: string): StripResult {
  const opening = /^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.exec(text);
  if (opening === null) return { text, tag: null, malformed: false };
  const tag = (opening[1] ?? '').toLowerCase();
  if (!knownWrapper(tag)) return { text, tag: null, malformed: false };
  let depth = 1;
  let cursor = opening[0].length;
  const scanner = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}>`, 'gi');
  scanner.lastIndex = cursor;
  for (;;) {
    const hit = scanner.exec(text);
    if (hit === null) return { text, tag, malformed: true };
    depth += hit[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      const inner = text.slice(cursor, hit.index);
      const rest = text.slice(hit.index + hit[0].length);
      return {
        text: UNWRAP_TAGS.has(tag) ? `${inner}${rest}` : rest,
        tag,
        malformed: false,
      };
    }
    cursor = scanner.lastIndex;
  }
}

/**
 * 单个文本块的清洗：剥掉块开头的包装，返回剩下的正文。
 *
 * 认不出的标签与未闭合的已知标签原样保留。跨块的 `<transcript>` 在块内看是
 * 未闭合的，这里不动，交给整段规则按拼接后的全文配对。
 */
function cleanBlock(block: string, removed: string[]): string {
  // 闭合标签可能单独成块，也可能贴在正文末尾或用户的话之前；它只是粘贴的边界。
  const withoutClose = block.replace(PASTE_CLOSE, '');
  if (withoutClose !== block) removed.push('pasted_content');
  let current = withoutClose.trim();
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (;;) {
      const paste = PASTE_MARKER.exec(current);
      if (paste !== null) {
        current = current.slice(paste[0].length);
        removed.push('pasted_content');
        changed = true;
        continue;
      }
      const result = stripLeadingTag(current);
      if (result.tag === null || result.malformed) break;
      current = result.text;
      removed.push(result.tag);
      changed = true;
    }
    current = current.trim();
    if (!changed) break;
  }
  return current;
}

function textBlocks(message: unknown): string[] {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
      out.push(record.text);
    }
  }
  return out;
}

/** 消息里的文本块拼接；没有文本块（例如纯工具结果）返回 null。 */
export function messageText(message: unknown): string | null {
  const parts = textBlocks(message);
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * 拼接后的整段规则：先剥开头包装与插话前缀，再判断整段是否只剩注入内容。
 *
 * `initial` 是块级清洗已经剥掉的标签，跟着这次解释一起记录。剥完为空且有
 * 删除记录时是 injected（命令回显或系统通知），否则 empty；识别不了的包装
 * 整段保留并标 unrecognized，不丢用户正文。未知 agent 同样走通用规则。
 */
function finalize(
  original: string,
  agent: string | null,
  initial: readonly string[],
  text: string,
): UserInputView {
  let current = text.trim();
  const removed = [...initial];
  const base = { original, agent, rule: 'generic' as const };
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (;;) {
      const result = stripLeadingTag(current);
      if (result.malformed) {
        return { ...base, state: 'unrecognized', kind: 'wrapped', text: original, removed };
      }
      if (result.tag === null) break;
      current = result.text;
      removed.push(result.tag);
      changed = true;
    }
    if (MIDTURN_PREFIX.test(current)) {
      current = current.replace(MIDTURN_PREFIX, '');
      removed.push('midturn-prefix');
      changed = true;
    }
    if (MIDTURN_NOTICE.test(current)) {
      current = current.replace(MIDTURN_NOTICE, '');
      removed.push('midturn-notice');
      changed = true;
    }
    if (CWD_PREFIX.test(current)) {
      current = current.replace(CWD_PREFIX, '');
      removed.push('cwd-prefix');
      changed = true;
    }
    current = current.trim();
    if (!changed) break;
  }
  if (current.startsWith('<title-request>')) {
    return { ...base, state: 'injected', kind: 'title_request', text: '', removed };
  }
  if (SKILL_INJECTION.test(current)) {
    return { ...base, state: 'injected', kind: 'skill_injection', text: '', removed };
  }
  if (STEPPED_AWAY.test(current)) {
    return { ...base, state: 'injected', kind: 'system_notice', text: '', removed };
  }
  if (current.length === 0) {
    const onlyCommands = removed.length > 0 && removed.every(tag => tag.startsWith('command-'));
    return {
      ...base,
      state: removed.length > 0 ? 'injected' : 'empty',
      kind: removed.length > 0 ? (onlyCommands ? 'command_echo' : 'system_notice') : 'plain',
      text: '',
      removed,
    };
  }
  return {
    ...base,
    state: 'text',
    kind: removed.some(value => value === 'midturn-prefix') ? 'midturn'
      : removed.length > 0 ? 'wrapped' : 'plain',
    text: current,
    removed,
  };
}

/** 整段文本的解释；单块调用的入口，块级清洗留给 `interpretUserMessage`。 */
export function interpretUserText(text: string, agent: string | null): UserInputView {
  return finalize(text, agent, [], text);
}

/**
 * 一条用户消息的解释结果；没有文本块时返回 null（例如纯工具结果）。
 *
 * 逐块清洗后再拼接：只剥整段开头会让排在用户正文之后的 system-reminder、
 * 命令回显与附件混进可见输入，标题与折叠行摘要跟着取错。
 */
function interpretUserMessage(message: unknown, agent: string | null): UserInputView | null {
  const blocks = textBlocks(message);
  if (blocks.length === 0) return null;
  const removed: string[] = [];
  const parts: string[] = [];
  for (const block of blocks) {
    const cleaned = cleanBlock(block, removed);
    if (cleaned.length > 0) parts.push(cleaned);
  }
  return finalize(blocks.join('\n'), agent, removed, parts.join('\n'));
}

/** 消息角色与用户输入解释；非用户角色不产生 input。未知角色原样标 unknown。 */
export function interpretMessage(message: unknown, agent: string | null, ord: number): MessageView {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ord, role: 'unknown', role_state: 'unknown', input: null };
  }
  const rawRole = (message as Record<string, unknown>).role;
  const role: MessageView['role'] = typeof rawRole === 'string'
    ? rawRole === 'developer' ? 'system'
      : rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' || rawRole === 'tool'
        ? rawRole as 'user' | 'assistant' | 'system' | 'tool' : 'unknown'
    : 'unknown';
  return {
    ord,
    role,
    role_state: role === 'unknown' ? 'unknown' : 'known',
    input: role === 'user' ? interpretUserMessage(message, agent) : null,
  };
}
