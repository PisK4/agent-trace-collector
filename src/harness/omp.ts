import { PURPOSE_VERSION, type PurposeDecision, type PurposeView } from '../semantics';

/** OMP skill 描述压缩管线的旁路指纹：一次性的模板调用，块首命中即认。 */
const OMP_SKILL_HINT = 'Compress into one routing hint of at most 12 words:';

/**
 * OMP skill 描述压缩调用的强指纹。
 *
 * 生产实测这类请求各自带着随机 session id 成会话（20:59:56 一秒四个），消息
 * 是 harness 生成的压缩模板；判据是任一 user 文本块块首命中模板前缀。按块首
 * 不按消息首行：归档类消息的块 0 常是 system-reminder，正文在后面的块。锚点
 * 失配时规则静默不命中，退回 participate——降噪失效只是回到现状。agent=omp
 * 的选取在登记处（[purpose](./purpose.ts)），这里不自查标签。
 */
export function skillHintDecision(view: PurposeView): PurposeDecision | null {
  if (!view.userBlockHeads.some(head => head.startsWith(OMP_SKILL_HINT))) return null;
  const signals = ['skill-hint.agent.omp', 'skill-hint.block-head'];
  return {
    status: 'recognized',
    version: PURPOSE_VERSION,
    rule: 'omp.skill-hint.v1',
    signals,
    chain: 'exclude',
    kind: 'skill_hint',
    modelTitle: null,
  };
}
