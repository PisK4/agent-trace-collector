import {
  PURPOSE_VERSION, parseTitleReply, type PurposeDecision, type PurposeView,
} from '../semantics';

/** 命令安全审查器的 system 指纹：判定回复可缺失、措辞可变，不作门槛。 */
const COMMAND_REVIEW = 'security reviewer for an ai coding agent';
/** 会话标题生成器的 system 指纹：缺回复时只有请求侧这一条证据可用。 */
const SESSION_TITLE = 'you name chat sessions';

/**
 * 审查判定词。回复形状只写信号：拿 ESCALATE 一类词当门槛，会在上游改措辞
 * 或回复缺失时把审查器重新算回主链。
 */
const REVIEW_VERDICTS = ['escalate', 'allow', 'deny', 'block', 'pass'] as const;

function hasSystemFingerprint(view: PurposeView, fingerprint: string): boolean {
  return view.systemTexts.some(text => text.toLowerCase().includes(fingerprint));
}

/** 回复首词小写落进已知判定集合才算认得出；其余一律 other，缺回复记 unknown。 */
function reviewVerdict(replyText: string | null): string {
  if (replyText === null) return 'unknown';
  const first = replyText.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? '';
  return (REVIEW_VERDICTS as readonly string[]).includes(first) ? first : 'other';
}

/**
 * 命令安全审查器：每次执行 shell 命令前的短判定请求。
 *
 * 它占着 main 位置会挤掉真正的主链，还会被当成可比较的祖先。请求侧指纹
 * 先判，回复只贡献信号——判定的存在与结果无关。
 */
function commandReviewDecision(view: PurposeView): PurposeDecision | null {
  if (!hasSystemFingerprint(view, COMMAND_REVIEW)) return null;
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'hermes.command-review.v1',
    signals: [
      'command-review.agent.hermes',
      'command-review.system.security-reviewer',
      `command-review.verdict.${reviewVerdict(view.replyText)}`,
    ],
    chain: 'exclude',
    kind: 'command-review',
    modelTitle: null,
  };
}

/**
 * 会话标题生成器：缺回复的孤儿回调无法提供 response ID，只能按请求侧
 * system 指纹识别。回复可读时复用共享的严格标题解析。
 *
 * 缺回复仍排除链；曾有正式标题的行保留旧标题，一次缺回复不撤销已确认的值。
 */
function sessionTitleDecision(view: PurposeView): PurposeDecision | null {
  if (!hasSystemFingerprint(view, SESSION_TITLE)) return null;
  const parsed = parseTitleReply(view.replyText);
  const retained = view.stored.kind === 'title' ? view.stored.modelTitle : null;
  const signals = ['session-title.agent.hermes', 'session-title.system.name-chat-sessions'];
  if (parsed !== null) signals.push(`title.reply.${parsed.shape}`);
  else signals.push(view.replyText === null
    ? 'session-title.reply.absent' : 'session-title.reply.unparsed');
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'hermes.session-title.v1',
    signals,
    chain: 'exclude',
    kind: 'title',
    modelTitle: parsed?.title ?? retained,
  };
}

/**
 * Hermes 的两条旁路指纹：命令审查器先判，标题后判。
 *
 * 两条同时出现时按此次序取胜，与登记处同 agent 多规则按数组次序一致。
 * agent=hermes 的选取在登记处（[purpose](./purpose.ts)），这里不自查标签。
 */
export function hermesDecision(view: PurposeView): PurposeDecision | null {
  return commandReviewDecision(view) ?? sessionTitleDecision(view);
}
