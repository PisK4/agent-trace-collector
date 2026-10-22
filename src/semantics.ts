export const PURPOSE_VERSION = 2;

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

/** system 文本可能来自顶层 `system`，也可能来自 system/developer 角色的消息。 */
export function systemTextsOf(request: unknown): string[] {
  if (!isRecord(request)) return [];
  const out: string[] = [];
  out.push(...textsIn(request.system));
  const messages = Array.isArray(request.messages) ? request.messages : [];
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

export function messageCountOf(request: unknown): number | null {
  if (!isRecord(request)) return null;
  return Array.isArray(request.messages) ? request.messages.length : null;
}

/** 没有 `tools` 键等于零个工具；键在但类型不对返回 null，不猜成零。 */
export function toolCountOf(request: unknown): number | null {
  if (!isRecord(request)) return null;
  if (request.tools === undefined) return 0;
  return Array.isArray(request.tools) ? request.tools.length : null;
}

/** 回复文本取 Anthropic 的 `content` 与 OpenAI 的 `choices[].message.content`。 */
export function replyTextsOf(reply: unknown): string[] {
  if (!isRecord(reply)) return [];
  const out = textsIn(reply.content);
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

const SECURITY_MONITOR = 'security monitor for autonomous ai coding agents';
const BLOCK_STOP = '</block>';
const BLOCK_VERDICT = /<block>\s*(yes|no)\s*(?:<\/block>)?/gi;

/**
 * Claude auto mode 分类器的强指纹。
 *
 * agent、system 文本与 stop_sequences 三者缺一不可；消息数与工具数只写信号，
 * 不作为门槛——上游改形状时仍应认出这是分类器，而不是退回普通对话。
 */
function classifierDecision(view: PurposeView): PurposeDecision | null {
  if (view.agent !== 'claude') return null;
  if (!view.systemTexts.some(text => text.toLowerCase().includes(SECURITY_MONITOR))) return null;
  if (!view.stopSequences.includes(BLOCK_STOP)) return null;
  const signals = [
    'classifier.agent.claude',
    'classifier.system.security-monitor',
    'classifier.stop.block',
  ];
  if (view.messageCount === 2) signals.push('classifier.shape.messages2');
  if (view.toolCount === 0) signals.push('classifier.shape.tools0');
  let verdict: 'pass' | 'block' | 'unknown' = 'unknown';
  if (view.replyText !== null) {
    const matches = [...view.replyText.matchAll(BLOCK_VERDICT)];
    const last = matches[matches.length - 1]?.[1]?.toLowerCase();
    if (last === 'no') verdict = 'pass';
    else if (last === 'yes') verdict = 'block';
  }
  signals.push(`classifier.verdict.${verdict}`);
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'claude.auto-mode-classifier.v1',
    signals,
    chain: 'exclude',
    kind: 'auto-mode-classifier',
    modelTitle: null,
  };
}

/**
 * 来源 kind：只有精确的 `title` 才排除链。
 *
 * 其它值保留成 `source:<value>` 并参与链；来源冲突或缺值时这里不出结论，
 * 交给标题兼容兜底，而不是拿一个不可靠的值猜类别。
 */
function sourceDecision(view: PurposeView): PurposeDecision | null {
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
function titleDecision(view: PurposeView): PurposeDecision | null {
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
function unavailableDecision(view: PurposeView): PurposeDecision {
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

/**
 * 一条请求的用途判定。
 *
 * 规则优先级固定为：分类器强指纹 > 来源 kind > 标题兼容 > 兜底。
 * 正文不可读时先保留旧解释，来源 kind 只对没有旧解释的行生效；否则正文回收后，
 * 一条普通来源 kind 会覆盖此前识别出的分类器或标题。
 */
export function classifyPurpose(view: PurposeView): PurposeDecision {
  if (view.parse !== 'ok' && view.stored.version !== null) {
    return unavailableDecision(view);
  }
  if (view.parse === 'ok') {
    const classifier = classifierDecision(view);
    if (classifier !== null) return classifier;
  }
  const source = sourceDecision(view);
  if (source !== null) return source;
  if (view.parse === 'ok') {
    const title = titleDecision(view);
    if (title !== null) return title;
    return {
      status: 'unrecognized',
      version: PURPOSE_VERSION,
      rule: null,
      signals: [],
      chain: 'participate',
      kind: 'chat',
      modelTitle: null,
    };
  }
  return unavailableDecision(view);
}
