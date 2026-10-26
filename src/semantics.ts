/**
 * 用途视图的共享事实与通用判定：类型、从已解析请求读字段的提取器、标题回复
 * 形状解析，以及跨 Harness 复用的来源 kind、标题兼容与正文不可读保留。Harness
 * 专属强指纹及其编排归 [harness/purpose](./harness/purpose.ts)。
 */
export const PURPOSE_VERSION = 4;

export type PurposeStatus =
  | 'recognized' | 'unrecognized' | 'missing' | 'retained' | 'unsupported' | 'error';
export type PurposeChain = 'participate' | 'exclude';
export type PurposeKindState =
  | 'single' | 'agree' | 'conflict' | 'missing' | 'invalid' | 'overflow';
export type PurposeSource = { state: PurposeKindState; value: string | null };
export type PurposeStored = {
  version: number | null;
  status: PurposeStatus;
  rule: string | null;
  signals: string[];
  chain: PurposeChain;
  kind: string;
  modelTitle: string | null;
};
export type PurposeParse = 'ok' | 'missing' | 'unsupported' | 'invalid';
export type PurposeView = {
  parse: PurposeParse;
  agent: string | null;
  systemTexts: string[];
  stopSequences: string[];
  messageCount: number | null;
  toolCount: number | null;
  replyText: string | null;
  /** user 文本块的块首（每块前若干字符，逐块不拼消息）：旁路强指纹按块首匹配。 */
  userBlockHeads: string[];
  source: PurposeSource;
  stored: PurposeStored;
};
export type PurposeDecision = {
  status: PurposeStatus;
  version: number | null;
  rule: string | null;
  signals: string[];
  chain: PurposeChain;
  kind: string;
  modelTitle: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function textsIn(content: unknown): string[] {
  const out: string[] = [];
  if (typeof content === 'string') {
    const text = textOf(content);
    if (text !== null) out.push(text);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block === 'string') {
      const text = textOf(block);
      if (text !== null) out.push(text);
      continue;
    }
    if (!isRecord(block)) continue;
    const text = textOf(block.text);
    if (text !== null) out.push(text);
  }
  return out;
}

/** system 文本可能来自顶层 `system`、Responses 的顶层 `instructions`，也可能来自 system/developer 角色的消息。 */
export function systemTextsOf(request: unknown): string[] {
  if (!isRecord(request)) return [];
  const out: string[] = [];
  out.push(...textsIn(request.system));
  // Responses 把系统提示放在顶层 instructions，与 system 同源合并：只读 system
  // 会让用途判定看不到技能清单，分类器与技能指纹一起落空。
  const instructions = textOf(request.instructions);
  if (instructions !== null) out.push(instructions);
  const messages = Array.isArray(request.messages) ? request.messages
    : Array.isArray(request.input) ? request.input : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role !== 'system' && message.role !== 'developer') continue;
    out.push(...textsIn(message.content));
  }
  return out;
}

export function stopSequencesOf(request: unknown): string[] {
  if (!isRecord(request)) return [];
  const raw = Array.isArray(request.stop_sequences) ? request.stop_sequences
    : Array.isArray(request.stop) ? request.stop : [];
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** 没有 `tools` 键等于零个工具；键在但类型不对返回 null，不猜成零。 */
export function toolCountOf(request: unknown): number | null {
  if (!isRecord(request)) return null;
  if (request.tools === undefined) return 0;
  return Array.isArray(request.tools) ? request.tools.length : null;
}

/** 回复文本取 Anthropic 的 `content`、OpenAI 的 `choices[].message.content` 与 Responses 的 `output`。 */
export function replyTextsOf(reply: unknown): string[] {
  if (!isRecord(reply)) return [];
  const out = textsIn(reply.content);
  // Responses 的正文在 output 的 message 项 content 里，也可能直接是 output_text 项；
  // 推理与调用项没有正文，统一跳过。
  if (Array.isArray(reply.output)) {
    for (const item of reply.output) {
      if (!isRecord(item)) continue;
      if (item.type === 'message') {
        out.push(...textsIn(item.content));
        continue;
      }
      if (item.type !== 'output_text' && item.type !== 'text') continue;
      const text = textOf(item.text);
      if (text !== null) out.push(text);
    }
  }
  if (Array.isArray(reply.choices)) {
    for (const choice of reply.choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      out.push(...textsIn(choice.message.content));
    }
  }
  return out;
}

const TITLE_TAG_REPLY = /^<title\b[^>]*>([\s\S]*?)<\/title>\s*$/i;

/**
 * 严格的标题回复解析：整段回复要么是一个 `<title>` 标签，要么是只含 `title` 键的 JSON。
 *
 * 只有这两种形状算标题回复。正文里出现 `<title>` 字样、或 JSON 多了别的键，
 * 都不足以排除链——分类错误会让一笔普通对话从主链消失。
 */
export function parseTitleReply(
  text: string | null,
): { title: string; shape: 'title-tag' | 'json-title' } | null {
  if (text === null) return null;
  const trimmed = text.trim();
  const tagged = TITLE_TAG_REPLY.exec(trimmed)?.[1]?.replace(/\s+/g, ' ').trim();
  if (tagged !== undefined && tagged.length > 0) return { title: tagged, shape: 'title-tag' };
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'title' || typeof value.title !== 'string') return null;
    const title = value.title.replace(/\s+/g, ' ').trim();
    return title.length > 0 ? { title, shape: 'json-title' } : null;
  } catch {
    return null;
  }
}

export function titleFromReply(text: string | null): string | null {
  return parseTitleReply(text)?.title ?? null;
}

/**
 * 来源 kind：只有精确的 `title` 才排除链。
 *
 * 其它值保留成 `source:<value>` 并参与链；来源冲突或缺值时这里不出结论，
 * 交给标题兼容兜底，而不是拿一个不可靠的值猜类别。
 */
export function sourceDecision(view: PurposeView): PurposeDecision | null {
  const { state, value } = view.source;
  if (state !== 'single' && state !== 'agree') return null;
  if (value === null || value.trim().length === 0) return null;
  const kindValue = value.trim();
  const signals = [`source.kind.${state}`];
  if (kindValue === 'title') {
    signals.push('source.kind.title');
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'source.kind.v1',
      signals,
      chain: 'exclude',
      kind: 'title',
      modelTitle: titleFromReply(view.replyText),
    };
  }
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'source.kind.v1',
    signals,
    chain: 'participate',
    kind: `source:${kindValue}`,
    modelTitle: null,
  };
}

/**
 * 标题兼容：回复形状优先，已存的 title 在后。
 *
 * 已存 title 的行即使回复不再像标题也继续排除链，并保留旧标题；把一笔曾确认的
 * 标题请求重新算成主链，会让链前驱与摘要随一次上游改形漂移。
 */
export function titleDecision(view: PurposeView): PurposeDecision | null {
  const parsed = parseTitleReply(view.replyText);
  if (view.stored.kind === 'title') {
    const signals = ['title.stored'];
    if (parsed !== null) signals.push(`title.reply.${parsed.shape}`);
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: parsed !== null ? 'title.reply.v1' : 'title.stored.v1',
      signals,
      chain: 'exclude',
      kind: 'title',
      modelTitle: parsed?.title ?? view.stored.modelTitle,
    };
  }
  if (parsed === null) return null;
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'title.reply.v1',
    signals: [`title.reply.${parsed.shape}`],
    chain: 'exclude',
    kind: 'title',
    modelTitle: parsed.title,
  };
}

/**
 * 正文不可读：有旧解释就原样保留，没有就落 missing/unsupported。
 *
 * retained 不更新 version；保留行说明的是它当时按哪一版算出来的。
 */
export function unavailableDecision(view: PurposeView): PurposeDecision {
  if (view.stored.version !== null) {
    return {
      status: 'retained',
      version: view.stored.version,
      rule: view.stored.rule,
      signals: [...new Set([...view.stored.signals, 'purpose.retained'])],
      chain: view.stored.chain,
      kind: view.stored.kind,
      modelTitle: view.stored.modelTitle,
    };
  }
  const unsupported = view.parse === 'unsupported' || view.parse === 'invalid';
  return {
    status: unsupported ? 'unsupported' : 'missing',
    version: null,
    rule: null,
    signals: [`body.${view.parse}`],
    chain: view.stored.chain,
    kind: view.stored.kind,
    modelTitle: null,
  };
}
