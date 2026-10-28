import { PURPOSE_VERSION, type PurposeDecision, type PurposeView } from '../semantics';

const SECURITY_MONITOR = 'security monitor for autonomous ai coding agents';
const BLOCK_STOP = '</block>';
const BLOCK_VERDICT = /<block>\s*(yes|no)\s*(?:<\/block>)?/gi;

/** 分类器裁决：回复里最后一个 `<block>` 决定 pass/block，没有就记 unknown。 */
function verdictOf(replyText: string | null): 'pass' | 'block' | 'unknown' {
  if (replyText === null) return 'unknown';
  const matches = [...replyText.matchAll(BLOCK_VERDICT)];
  const last = matches[matches.length - 1]?.[1]?.toLowerCase();
  if (last === 'no') return 'pass';
  if (last === 'yes') return 'block';
  return 'unknown';
}

/**
 * Claude auto mode 分类器的强指纹。
 *
 * system 文本与 stop_sequences 缺一不可；消息数与工具数只写信号，不作为门槛
 * ——上游改形状时仍应认出这是分类器，而不是退回普通对话。agent=claude 的
 * 选取在登记处（[purpose](./purpose.ts)），这里不自查标签。
 */
export function classifierDecision(view: PurposeView): PurposeDecision | null {
  if (!view.systemTexts.some(text => text.toLowerCase().includes(SECURITY_MONITOR))) return null;
  if (!view.stopSequences.includes(BLOCK_STOP)) return null;
  const signals = [
    'classifier.agent.claude',
    'classifier.system.security-monitor',
    'classifier.stop.block',
  ];
  if (view.messageCount === 2) signals.push('classifier.shape.messages2');
  if (view.toolCount === 0) signals.push('classifier.shape.tools0');
  signals.push(`classifier.verdict.${verdictOf(view.replyText)}`);
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

const REVIEW_CLAUDE_MD = "The following is the user's CLAUDE.md configuration.";
const REVIEW_INSTRUCTION = 'Review the classification process and follow it carefully';

/**
 * 权限审查分类器的新形状：没有 system 与 stop_sequences，首条 user 消息是一份
 * 用户 CLAUDE.md 上下文，末条 user 消息是一段 transcript 加审查指令，回复仍是
 * `<block>yes|no</block>`。与旧分类器同一功能，两条模板缺一不可；消息数与
 * 工具数只写信号，不作为门槛。
 */
export function classifierReviewDecision(view: PurposeView): PurposeDecision | null {
  if (!view.userBlockHeads.some(head => head.startsWith(REVIEW_CLAUDE_MD))) return null;
  if (!view.tailUserBlockHeads.some(head => head.startsWith(REVIEW_INSTRUCTION))) return null;
  const signals = [
    'classifier.agent.claude',
    'classifier.context.user-claude-md',
    'classifier.tail.review-instruction',
  ];
  if (view.messageCount === 2) signals.push('classifier.shape.messages2');
  if (view.toolCount === 0) signals.push('classifier.shape.tools0');
  signals.push(`classifier.verdict.${verdictOf(view.replyText)}`);
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'claude.auto-mode-classifier.v2',
    signals,
    chain: 'exclude',
    kind: 'auto-mode-classifier',
    modelTitle: null,
  };
}

const SUGGESTION_MODE = '[SUGGESTION MODE:';
const COMPACTION = 'CRITICAL: Respond with TEXT ONLY';

/**
 * Claude Code 的 suggestion 生成请求。指纹写在最后一条 user 消息的块首，
 * 只看末尾块首；命中即认，不拿消息数或工具数当门槛。
 */
export function suggestionDecision(view: PurposeView): PurposeDecision | null {
  if (!view.tailUserBlockHeads.some(head => head.startsWith(SUGGESTION_MODE))) return null;
  return {
    status: 'recognized', version: PURPOSE_VERSION, rule: 'claude.suggestion-mode.v1',
    signals: ['suggestion.agent.claude', 'suggestion.tail-block-head'],
    chain: 'exclude', kind: 'suggestion_mode', modelTitle: null,
  };
}

/**
 * Claude Code 的上下文压缩请求（回复以 `<analysis>` 开头）。与 suggestion
 * 同样写在末尾块首；两族互斥，登记次序只保证分类器先判。
 */
export function compactionDecision(view: PurposeView): PurposeDecision | null {
  if (!view.tailUserBlockHeads.some(head => head.startsWith(COMPACTION))) return null;
  return {
    status: 'recognized', version: PURPOSE_VERSION, rule: 'claude.compaction.v1',
    signals: ['compaction.agent.claude', 'compaction.tail-block-head'],
    chain: 'exclude', kind: 'context_compaction', modelTitle: null,
  };
}

/**
 * 末尾模板族的旁路登记：模板字面量 → 规则与 kind。
 *
 * 这些都是 harness 写进末尾 user 消息的固定文本，不是用户输入：状态栏的动作
 * 描述、暂离后的 recap、运行中状态、WebSearch 的内部检索、工具装载通知。
 * 命中即认，不拿消息数或工具数当门槛；表内前缀互不重叠，次序只决定归属。
 */
const TAIL_TEMPLATES: readonly { prefix: string; rule: string; kind: string }[] = [
  { prefix: 'Describe your most recent action in 3-5 words', rule: 'claude.action-description.v1', kind: 'action_description' },
  { prefix: 'The user stepped away and is coming back.', rule: 'claude.recap.v1', kind: 'recap' },
  { prefix: 'Current state: working (for ', rule: 'claude.status-line.v1', kind: 'status_line' },
  { prefix: 'Perform a web search for the query: ', rule: 'claude.web-search.v1', kind: 'web_search' },
  { prefix: 'Tool loaded.', rule: 'claude.tool-loaded.v1', kind: 'tool_loaded' },
];

export function tailTemplateDecision(view: PurposeView): PurposeDecision | null {
  for (const entry of TAIL_TEMPLATES) {
    if (!view.tailUserBlockHeads.some(head => head.startsWith(entry.prefix))) continue;
    return {
      status: 'recognized', version: PURPOSE_VERSION, rule: entry.rule,
      signals: ['template.agent.claude', `template.tail-block-head.${entry.kind}`],
      chain: 'exclude', kind: entry.kind, modelTitle: null,
    };
  }
  return null;
}
