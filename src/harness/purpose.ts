/**
 * Harness 专属用途判定的静态登记与编排。通用判定（来源 kind、标题兼容、正文
 * 不可读保留）由 [semantics](../semantics.ts) 持有并在此按固定次序编排；调用
 * 者是用途结算（request-purpose.ts），只传已读出的视图、拿回结论，不承担任何
 * Harness 名称。
 */
import { classifierDecision } from './claude';
import { skillHintDecision } from './omp';
import {
  PURPOSE_VERSION,
  sourceDecision,
  titleDecision,
  unavailableDecision,
  type PurposeDecision,
  type PurposeView,
} from '../semantics';

/**
 * 一条 Harness 专属规则：绑定一个已知 agent 标签与一个判定函数。
 *
 * 标签与请求的 agent 相等才会尝试；函数返回 null 表示这条规则弃权，落回后面
 * 的通用判定。agent 是上游标签不是身份凭证，未知与空标签不命中任何登记项。
 */
export type HarnessPurposeRule = {
  agent: string;
  decide(view: PurposeView): PurposeDecision | null;
};

/** 生产登记：次序即同 agent 多条规则时的优先级，新增 Harness 在此加一行。 */
export const PURPOSE_RULES: readonly HarnessPurposeRule[] = [
  { agent: 'claude', decide: classifierDecision },
  { agent: 'omp', decide: skillHintDecision },
];

/**
 * 一条请求的用途判定。
 *
 * 规则优先级固定为：Harness 专属强指纹（登记次序）> 来源 kind > 标题兼容 >
 * 兜底。正文不可读时先保留旧解释，来源 kind 只对没有旧解释的行生效；否则
 * 正文回收后，一条普通来源 kind 会覆盖此前识别出的分类器或标题。
 */
export function classifyPurpose(view: PurposeView): PurposeDecision {
  return classifyPurposeWithRules(PURPOSE_RULES, view);
}

/** 窄测试 seam：合成登记项走与生产同一份编排，不进生产登记。 */
export function classifyPurposeWithRules(
  rules: readonly HarnessPurposeRule[],
  view: PurposeView,
): PurposeDecision {
  if (view.parse !== 'ok' && view.stored.version !== null) {
    return unavailableDecision(view);
  }
  if (view.parse === 'ok') {
    for (const rule of rules) {
      if (rule.agent !== view.agent) continue;
      const decision = rule.decide(view);
      if (decision !== null) return decision;
    }
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
