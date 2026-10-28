import { PURPOSE_VERSION, type PurposeDecision, type PurposeView } from '../semantics';

const SECURITY_MONITOR = 'security monitor for autonomous ai coding agents';
const BLOCK_STOP = '</block>';
const BLOCK_VERDICT = /<block>\s*(yes|no)\s*(?:<\/block>)?/gi;

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
