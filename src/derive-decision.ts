import { modelTimeTitle } from './format';
import { interpretMessage, isUserInterruptMessage } from './input-interpretation';

/**
 * 派生判定内核：两条派生路径共用的「怎么判」。
 *
 * 同步路径（derive.ts）与切片路径（derive-slice.ts）的差别只在读哪张表、写哪张表、
 * 分不分页；判定本身——前驱关系、主链 trunk、工具配对阶梯、标题与折叠行摘要——
 * 各只有一份实现，住在这里。两个写 adapter 把各自的行数据整理成这里的输入形状，
 * 再把判定结果写回各自的表。判定要改，只改这一个模块；两条路径的一致性由
 * 结构保证，parity 测试降级为回归网。
 *
 * 输入形状是纯数据：db 相关的读取由调用方完成（或经 ports 回调），这里不做 IO。
 */

// ---------------------------------------------------------------------------
// 协议抽取：什么算一次工具调用、什么算一次工具结果。两种协议结构都认。
// ---------------------------------------------------------------------------

/** 一次调用携带的参数事实：两个键之外的东西不提取。 */
export type CallArgs = {
  /** Edit/Write/Read 的 `file_path`；键缺失、非字符串或空串为 null。 */
  argPath: string | null;
  /** Skill 的 `skill`；键缺失、非字符串或空串为 null。 */
  argSkill: string | null;
};

/** 调用提取的行形状：id 与 name 供配对，arg 供会话汇总，ord 是回复内容块位置。 */
export type ReplyCall = { id: string; name: string; ord: number } & CallArgs;

/** 参数对象的统一读法：chat 的 arguments 是 JSON 字符串，anthropic 的 input 是对象。 */
function argsObjectOf(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** 单键提取：只认字符串且非空，不猜近邻键。 */
function argKeyOf(args: Record<string, unknown> | null, key: string): string | null {
  const value = args === null ? undefined : args[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function argsOf(rawInput: unknown): CallArgs {
  const args = argsObjectOf(rawInput);
  return { argPath: argKeyOf(args, 'file_path'), argSkill: argKeyOf(args, 'skill') };
}

/** 从回复里取工具调用。导出理由：候选抽取只有这一处，切片与同步不能各有一套判据。 */
export function anthropicReplyCalls(reply: unknown): ReplyCall[] {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return [];
  const content = (reply as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    // chat 形状：choices[0].message.tool_calls。多 choice 的 ord 在 choice 内
    // 各自从 0 计数，发布确定位置会撞主键或指错 choice，只认单 choice。
    const choices = (reply as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length !== 1) return [];
    const out: ReplyCall[] = [];
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>).message;
      if (message === null || typeof message !== 'object') continue;
      const calls = (message as Record<string, unknown>).tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const [index, call] of calls.entries()) {
        if (call === null || typeof call !== 'object') continue;
        const record = call as Record<string, unknown>;
        const id = record.id;
        const fn = record.function;
        if (typeof id !== 'string' || fn === null || typeof fn !== 'object') continue;
        out.push({
          id, name: String((fn as Record<string, unknown>).name ?? ''), ord: index,
          ...argsOf((fn as Record<string, unknown>).arguments),
        });
      }
    }
    return out;
  }
  const out: ReplyCall[] = [];
  for (const [ord, block] of content.entries()) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use' || typeof record.id !== 'string') continue;
    out.push({ id: record.id, name: String(record.name ?? ''), ord, ...argsOf(record.input) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 回复形状：轮次结算的收尾判定，三态。
// ---------------------------------------------------------------------------

/** 回复形状三态。只有 `final` 能当轮次终点；`tools` 是识别到有效调用；其余一律 `unknown`。 */
export type ReplyShape = 'final' | 'tools' | 'unknown';

/** 正常收尾的停止原因：无工具调用且停止原因在此，回复才算完整收尾。 */
const REPLY_FINISH_FINAL = new Set(['end_turn', 'stop_sequence', 'stop']);
/** 截断类停止原因：半截话不是收尾，也不因带调用就改判 tools。 */
const REPLY_FINISH_TRUNCATED = new Set(['length', 'max_tokens']);

/**
 * 形状不识别的回复里，被调用抽取跳过的工具块：缺 ID 的 tool_use、缺 function
 * 的 chat tool_calls。存在即说明回复形状介于可识别与损坏之间，不能下结论。
 */
function hasRejectedToolBlock(reply: Record<string, unknown>): boolean {
  const content = reply.content;
  if (Array.isArray(content)) {
    return content.some(block => {
      if (block === null || typeof block !== 'object') return false;
      const record = block as Record<string, unknown>;
      return record.type === 'tool_use' && typeof record.id !== 'string';
    });
  }
  const choices = reply.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return false;
  const choice = choices[0];
  if (choice === null || typeof choice !== 'object') return false;
  const message = (choice as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') return false;
  const calls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls)) return false;
  return calls.some(call => {
    if (call === null || typeof call !== 'object') return true;
    const record = call as Record<string, unknown>;
    return typeof record.id !== 'string' || record.function === null
      || typeof record.function !== 'object';
  });
}

/**
 * 回复形状判定，轮次结算收尾信号的唯一实现。
 *
 * 零工具计数不等于收尾：缺失回复、不识别的形状、多 choice、缺 ID 的工具块、
 * 截断的回复在这里全部落 `unknown`，不冒充最终答复。调用抽取与配对共用
 * `anthropicReplyCalls` 一份判据；被它跳过的工具块单独侦测，不让损坏形状
 * 混进 `final`。
 */
export function replyShapeOf(reply: unknown): ReplyShape {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return 'unknown';
  const record = reply as Record<string, unknown>;
  // 多 choice 无法确定哪一份是回复；choices 形状异常同理。
  if (Array.isArray(record.choices) && record.choices.length !== 1) return 'unknown';
  // 消息块两种落点：anthropic 的 content 数组；chat 单 choice 的 message。
  const hasBlocks = Array.isArray(record.content)
    || (Array.isArray(record.choices) && record.choices.length === 1
      && record.choices[0] !== null && typeof record.choices[0] === 'object'
      && (record.choices[0] as Record<string, unknown>).message !== null
      && typeof (record.choices[0] as Record<string, unknown>).message === 'object');
  if (!hasBlocks) return 'unknown';
  const finishValue = Array.isArray(record.choices)
    ? record.choices.length === 1 && record.choices[0] !== null && typeof record.choices[0] === 'object'
      ? (record.choices[0] as Record<string, unknown>).finish_reason
      : null
    : record.stop_reason;
  const finish = typeof finishValue === 'string' && finishValue !== '' ? finishValue : null;
  if (hasRejectedToolBlock(record)) return 'unknown';
  const calls = anthropicReplyCalls(reply);
  if (calls.length > 0) {
    // 调用本身是工具循环的证据，停止原因未报告也判 tools；截断的半截调用除外。
    return finish !== null && REPLY_FINISH_TRUNCATED.has(finish) ? 'unknown' : 'tools';
  }
  if (finish === null) return 'unknown';
  if (REPLY_FINISH_TRUNCATED.has(finish)) return 'unknown';
  return REPLY_FINISH_FINAL.has(finish) ? 'final' : 'unknown';
}

/** 从请求里取工具结果；Anthropic 的 tool_result 与 chat 的 role=tool。 */
export function anthropicRequestResults(request: unknown): {
  id: string; ord: number; path: string; value: unknown; isError: number;
}[] {  if (request === null || typeof request !== 'object' || Array.isArray(request)) return [];
  const messages = (request as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  const out: { id: string; ord: number; path: string; value: unknown; isError: number }[] = [];
  for (const [ord, message] of messages.entries()) {
    if (message === null || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role === 'tool' && typeof record.tool_call_id === 'string') {
      // chat 协议没有失败通道：结果送达即非失败，与缺席按缺省读的口径一致。
      out.push({ id: record.tool_call_id, ord, path: `request.messages[${ord}]`, value: record.content ?? null, isError: 0 });
      continue;
    }
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if (block === null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type !== 'tool_result' || typeof entry.tool_use_id !== 'string') continue;
      // 失败位按协议缺省读：显式 true 才是失败，false 与缺席都是非失败。
      out.push({
        id: entry.tool_use_id, ord,
        path: `request.messages[${ord}].content[${index}]`,
        value: entry.content ?? null,
        isError: entry.is_error === true ? 1 : 0,
      });
    }
  }
  return out;
}

/** 工具结果内容压平；数组形状里只取 text 块。结果正文怎么压平是一条判据。 */
export function flattenToolContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (block === null || typeof block !== 'object') continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
    return parts.join(' ');
  }
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 关系判定：前驱匹配与结算。
// ---------------------------------------------------------------------------

export type SequenceRelation = 'first' | 'confirmed' | 'unknown' | 'branch' | 'aux';

/** 两条序列的公共前缀长度。祖先比对的判据只有这一处实现。 */
export function commonPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export type PredecessorMatch = {
  /** 完整前缀匹配到的祖先；null 表示本笔另起一支。 */
  parent: number | null;
  relation: SequenceRelation;
  delta: number[] | null;
  /** 找到的最长部分前缀祖先与它的公共长度，用于说明"最接近的一支"。 */
  near: { reqId: number; shared: number } | null;
};

/**
 * 在链上所有已知祖先里找本笔的前驱。
 *
 * 只看立即前驱不够：一个会话里会并行开出子代理、重放历史、从更早的上下文
 * 分叉。本笔的上下文完整包含了某笔祖先时，那才是真正的前驱，哪怕中间还
 * 夹着别的请求。判据仍然严格：只有"祖先序列是本笔的完整前缀"才算确认。
 *
 * @param ancestors 已按时间正序处理过的请求，携带各自的指纹序列
 * @param current 本笔的指纹序列
 * @param hasEarlier 本笔之前还有参与请求（哪怕它的正文不可读）
 * @param unreadableEarlier 更早的请求里有不可比的（正文不可读或顺序未证实）
 */
export function matchPredecessor(
  ancestors: readonly { reqId: number; fingerprints: readonly string[] }[],
  current: readonly string[],
  hasEarlier = ancestors.length > 0,
  unreadableEarlier = false,
): PredecessorMatch {
  let best: { reqId: number; shared: number } | null = null;
  let parent: { reqId: number; length: number } | null = null;

  for (const ancestor of ancestors) {
    const shared = commonPrefix(ancestor.fingerprints, current);
    if (shared > 0 && (best === null || shared > best.shared)) {
      best = { reqId: ancestor.reqId, shared };
    }
    // 完整前缀：祖先整条都在本笔里，取最长的那条，即最深的祖先。
    // shared > 0 排除零长度祖先：空序列是任何序列的前缀，认它当父节点等于
    // 用"这一笔没有消息"证明"本笔续自它"，那是没有证据的边。
    if (shared > 0 && shared === ancestor.fingerprints.length
      && (parent === null || ancestor.fingerprints.length > parent.length)) {
      parent = { reqId: ancestor.reqId, length: ancestor.fingerprints.length };
    }
  }

  return {
    ...settleRelation({ current, parent, sawEarlier: hasEarlier, unreadableEarlier }),
    near: best,
  };
}

/**
 * 关系结算：扫描状态到「关系、父节点、增量」的唯一出口。
 *
 * 同步路径在内存里一次扫完全部祖先，切片路径把扫描状态记进工作表分页推进；
 * 两边最终都把「最长完整前缀祖先、前面有没有参与请求、有没有不可比祖先」交给
 * 这里，得到同一个结论。零长度祖先不构成证据的排除发生在各自的扫描侧，
 * 共享长度为 0 的祖先进不了 parent 位。
 */
export function settleRelation(input: {
  current: readonly string[];
  parent: { reqId: number; length: number } | null;
  sawEarlier: boolean;
  unreadableEarlier: boolean;
}): { parent: number | null; relation: SequenceRelation; delta: number[] | null } {
  const parent = input.parent;
  if (parent !== null) {
    return {
      parent: parent.reqId,
      relation: 'confirmed',
      delta: input.current.slice(parent.length).map((_, offset) => offset + parent.length),
    };
  }
  // 本组第一笔：没有更早的参与请求可比，整笔都是新增。
  if (!input.sawEarlier) {
    return { parent: null, relation: 'first', delta: input.current.map((_, index) => index) };
  }
  // 有更早的请求但对不上：另起一支；链是断的（有不可比祖先）时不能断言成
  // 分支——不可读的祖先可能就是真正的父节点，把缺失当成结论是越权。
  return { parent: null, relation: input.unreadableEarlier ? 'unknown' : 'branch', delta: null };
}

/**
 * 「哪些结果位置落在本轮确定新增的增量里」的唯一判据。
 *
 * `first` 整笔都是新增；`confirmed` 只看增量的 ord；关系未知、分支与排除用途
 * 都不构成"本轮新增"。同步路径在配对待选结果时逐条问，切片路径在结算时逐行
 * 写 `confirmed` 位，两条路径共用这一份。
 */
export function confirmedDeltaOf(
  relation: SequenceRelation | string | null,
  delta: readonly number[] | null,
): { all: boolean; ords: readonly number[] } {
  if (relation === 'first') return { all: true, ords: [] };
  if (relation === 'confirmed' && delta !== null) return { all: false, ords: delta };
  return { all: false, ords: [] };
}

/**
 * 确定增量里的已识别用户中断计数。
 *
 * 只数 delta 指向的消息：中断标记随上下文延续出现在后续每笔请求里，按 delta
 * 归属让同一条标记只在首次出现的那笔计 1。增量之外的请求（分支、未知关系、
 * 排除用途）没有"新增"可言，调用方传 null，计数为 0；正文不可读时同样不数，
 * 调用方保留旧值。
 */
export function interruptCountOf(
  messages: readonly unknown[],
  delta: readonly number[] | null,
): number {
  if (delta === null) return 0;
  let count = 0;
  for (const ordinal of delta) {
    const message = messages[ordinal];
    if (message !== undefined && isUserInterruptMessage(message)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 主链 trunk：哪个根是主线，主线覆盖哪些请求。
// ---------------------------------------------------------------------------

/** 森林里的一个节点；只含 trunk 判定需要的两个字段。 */
export type ChainRoleNode = { reqId: number; parentReqId: number | null };

/**
 * 主链根：按遍历序第一个「没有父节点、或父节点不是可比参与请求」的节点。
 *
 * 传入的列表必须已按遍历序排好。根的存在性由森林结构保证（有限森林必有根）；
 * 返回 null 只在空列表时出现。切片路径早先只按 started_ms/req_id 取根，
 * 会把父节点是不可比行的那一笔漏掉，两边的 trunk 因此分叉——判据收进来后
 * 这个坑只有一个位置。
 */
export function chainTrunkRoot(ordered: readonly ChainRoleNode[]): number | null {
  const ids = new Set(ordered.map(node => node.reqId));
  for (const node of ordered) {
    if (node.parentReqId === null || !ids.has(node.parentReqId)) return node.reqId;
  }
  return null;
}

/** 主链 trunk：根的可达集。分支是相对"从第一笔开始的主线"而言。 */
export function chainTrunk(ordered: readonly ChainRoleNode[], rootReqId: number | null): Set<number> {
  const trunk = new Set<number>();
  if (rootReqId === null) return trunk;
  const ids = new Set(ordered.map(node => node.reqId));
  const children = new Map<number, number[]>();
  for (const node of ordered) {
    if (node.parentReqId === null || !ids.has(node.parentReqId)) continue;
    const list = children.get(node.parentReqId);
    if (list === undefined) children.set(node.parentReqId, [node.reqId]);
    else list.push(node.reqId);
  }
  const stack = [rootReqId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (trunk.has(id)) continue;
    trunk.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return trunk;
}

// ---------------------------------------------------------------------------
// 文本判定：标题与折叠行摘要。
// ---------------------------------------------------------------------------

/** 标题长度按 Unicode 字符算，避免把中文截成半个字。 */
const TITLE_UNICODE_LIMIT = 60;
/** 摘要长度按 Unicode 字符算。 */
const PREVIEW_UNICODE_LIMIT = 90;
/** 工具结果只取开头一小段：折叠行只需要提示这一笔在回传什么。 */
const TOOL_RESULT_PREVIEW_LIMIT = 100;

/** 摘要共用截断：压空白后按 Unicode 字符截断。 */
export function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= PREVIEW_UNICODE_LIMIT ? flat : `${chars.slice(0, PREVIEW_UNICODE_LIMIT).join('')}…`;
}

/** 取第一个确定新增 USER 文本的首行；没有可用增量时回落到模型时间。 */
export function deriveTitle(
  messages: readonly unknown[],
  delta: readonly number[] | null,
  fallback: string,
  agent: string | null = null,
): { title: string; source: 'user_delta' | 'model_time' } {
  if (delta === null) return { title: fallback, source: 'model_time' };
  for (const ordinal of delta) {
    const view = interpretMessage(messages[ordinal], agent, ordinal);
    if (view.input === null || view.input.state !== 'text') continue;
    // 解释已经剥掉外层包装，这里只取首行并压空白。
    const cleaned = view.input.text.split('\n')[0]?.replace(/\s+/g, ' ').trim();
    if (cleaned === undefined || cleaned.length === 0) continue;
    return { title: [...cleaned].slice(0, TITLE_UNICODE_LIMIT).join(''), source: 'user_delta' };
  }
  return { title: fallback, source: 'model_time' };
}

/**
 * 折叠行摘要：本轮新增的用户输入，剥掉 harness 包装后取首段。
 *
 * 剥包装与取首段是一条判据，两套实现会让同一份正文在两条路径上得到不同的摘要。
 */
export function previewOf(messages: readonly (unknown | null)[], agent: string | null): string | null {
  for (const [ordinal, message] of messages.entries()) {
    const input = interpretMessage(message, agent, ordinal).input;
    if (input === null || input.state !== 'text') continue;
    const cleaned = input.text.trim();
    if (cleaned.length > 0) return clip(cleaned);
  }
  return null;
}

/** 回复没有文本时的兜底：这一笔发起的工具调用名，按出现顺序列出。 */
export function replyToolSummary(reply: unknown): string | null {
  const calls = anthropicReplyCalls(reply);
  if (calls.length === 0) return null;
  const names = calls.map(call => call.name.length > 0 ? call.name : 'unknown');
  return `工具调用 · ${names.join(', ')}`;
}

// ---------------------------------------------------------------------------
// 工具配对阶梯。
// ---------------------------------------------------------------------------

/** 本次确定下来的一个工具往返：调用位置与结果位置都精确到 ord 与 path。 */
export type ResolvedTool = {
  callReq: number; callOrd: number; callId: string; name: string;
  resultReq: number; resultOrd: number; resultPath: string;
};

/** 候选行首次落库时的状态：同 call_id 多于一笔即 ambiguous。 */
export function initialPairState(candidateCount: number): 'ambiguous' | 'pending' {
  return candidateCount > 1 ? 'ambiguous' : 'pending';
}

export type PairOutcome = 'ambiguous' | 'skip' | 'pending' | 'resolved';

/**
 * 一个结果落到一个调用上的配对阶梯，两条路径共用的顺序：
 * 多候选先判（结果位置照样记下，便于人工核对）→ 结果必须晚于调用 →
 * 同毫秒且顺序未证实不算证据 → 已确认的配对是终态（后续请求会重发整段历史，
 * 重发样本只可能把它降级成 pending，因此直接跳过）→ 未确认的增量只建立
 * pending 候选且只记首次见到的位置 → 其余 resolved。
 */
export function pairOutcome(input: {
  candidateCount: number;
  /** compareLogicalOrder(call, result) < 0。 */
  resultLater: boolean;
  /** 不同毫秒，或同毫秒且两侧都没有被标顺序未证实。 */
  orderCertain: boolean;
  alreadyResolved: boolean;
  alreadyPending: boolean;
  resultConfirmed: boolean;
}): PairOutcome {
  if (input.candidateCount > 1) return 'ambiguous';
  if (!input.resultLater || !input.orderCertain) return 'skip';
  if (input.alreadyResolved) return 'skip';
  if (!input.resultConfirmed) return input.alreadyPending ? 'skip' : 'pending';
  return 'resolved';
}

/**
 * 增量里没有用户文本时的输入摘要：这一笔回传的工具结果。
 *
 * 名字只从本次配对确定下来的关联取，按调用位置与结果 path 精确定位；
 * 不查上一轮表、其它组或不可重算的保留行。顺序按消息出现顺序，同名合并计数。
 * `messages` 按 delta 的原始 ord 稀疏存放（调用方构造）：结果提取要按原位置
 * 对上 path。关联先按 `reqId` 筛到本笔，再按 ord 与 path 对位。
 */
export function toolResultPreviewOf(messages: readonly unknown[], reqId: number,
  associations: readonly ResolvedTool[]): string | null {
  const names: string[] = [];
  let content: string | null = null;
  for (const result of anthropicRequestResults({ messages })) {
    const matches = associations.filter(link => link.resultReq === reqId
      && link.resultOrd === result.ord && link.resultPath === result.path
      && link.callId === result.id);
    if (matches.length === 1 && matches[0]!.name.length > 0) names.push(matches[0]!.name);
    if (content !== null) continue;
    const flat = flattenToolContent(result.value).replace(/\s+/g, ' ').trim();
    if (flat.length > 0) content = flat;
  }
  if (names.length > 0) {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const parts = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
    return clip(`工具结果 · ${parts.join(', ')}`);
  }
  if (content === null) return null;
  const chars = [...content];
  const truncated = chars.length <= TOOL_RESULT_PREVIEW_LIMIT
    ? content
    : `${chars.slice(0, TOOL_RESULT_PREVIEW_LIMIT).join('')}…`;
  return `工具结果 · ${truncated}`;
}

// ---------------------------------------------------------------------------
// 展示判定：标题、输入摘要与回复摘要的分支阶梯。
// ---------------------------------------------------------------------------

/** 摘要阶段需要的正文读取；两条路径用同一个 db 适配实现。 */
export type PresentationPorts = {
  /** 标题生成请求输入里第一段可读的用户文本。 */
  firstUserPreview(reqId: number): string | null;
  /** 按消息位置取一行正文消息；缺失或解压失败返回 null。 */
  messageAt(reqId: number, ordinal: number): unknown;
  /** 增量里没有用户文本时，这一笔回传的工具结果摘要。 */
  toolResultPreview(reqId: number, delta: readonly number[],
    associations: readonly ResolvedTool[]): string | null;
  /** 正文里最后一条用户文本（末轮输入兜底）。 */
  tailUserPreview(reqId: number): string | null;
};

/** 正文不可读时保留的旧展示值；白名单之外的取值按 null 处理。 */
export type RetainedPresentation = {
  title: string | null;
  titleSource: string | null;
  inputPreview: string | null;
  inputPreviewKind: string | null;
};

export type PresentationFacts = {
  reqId: number;
  agent: string | null;
  modelServed: string | null;
  startedMs: number;
  /** 排除用途（旁路）：不把用户增量变成标题。 */
  isAux: boolean;
  isTitle: boolean;
  modelTitle: string | null;
  /** 本笔可读的指纹序列；null 表示正文不可读。 */
  current: readonly string[] | null;
  /** 关系结算的确定增量；null 表示关系未知、分支或排除用途。 */
  delta: readonly number[] | null;
  /** 正文不可读时保留的旧值；可读时为 null。 */
  retained: RetainedPresentation | null;
  /** 回复摘要：可读时是本次重算值，不可读时是保留值。 */
  replyPreview: string | null;
};

export type PresentationDecision = {
  title: string;
  titleSource: 'user_delta' | 'model_time' | 'model_title';
  inputPreview: string | null;
  inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null;
  replyPreview: string | null;
};

/**
 * 展示分支的唯一实现。分支顺序有意义：标题请求先判（不可读的标题请求也要走
 * 标题分支），其次正文不可读（旧值原样保留），然后按增量取值；排除用途的
 * 标题覆盖在增量分支**之前**——排除用途的行常常连关系都判不出来（`delta` 为空），
 * 兜底不能只在有增量时才生效，否则同一个模型标题会随"判不判得出关系"变成两种结果。
 */
export function presentationDecision(ports: PresentationPorts, facts: PresentationFacts,
  associations: readonly ResolvedTool[]): PresentationDecision {
  const fallback = modelTimeTitle(facts.modelServed, facts.startedMs);
  const retained = facts.retained;
  let title = fallback;
  let titleSource: 'user_delta' | 'model_time' | 'model_title' = 'model_time';
  let inputPreview: string | null = null;
  let inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null = null;
  if (facts.isTitle) {
    // 标题请求不产生用户标题；它的正式标题只来自用途阶段写下的 model_title。
    title = facts.modelTitle ?? (facts.current === null ? retained?.title ?? fallback : fallback);
    titleSource = facts.modelTitle !== null ? 'model_title'
      : facts.current === null && retained?.titleSource === 'model_title' ? 'model_title' : 'model_time';
    inputPreview = ports.firstUserPreview(facts.reqId) ?? '生成会话标题';
    inputKind = 'title';
  } else if (facts.current === null) {
    // 正文已回收：旧标题与旧摘要都是当时按正文算出来的，原样保留。
    title = retained?.title ?? fallback;
    titleSource = retained !== null && (retained.titleSource === 'user_delta'
      || retained.titleSource === 'model_time' || retained.titleSource === 'model_title')
      ? retained.titleSource : 'model_time';
    inputPreview = retained?.inputPreview ?? null;
    inputKind = retained !== null && (retained.inputPreviewKind === 'delta'
      || retained.inputPreviewKind === 'tail' || retained.inputPreviewKind === 'tool_result'
      || retained.inputPreviewKind === 'title') ? retained.inputPreviewKind : null;
  } else {
    // 排除用途但不是标题请求：不把用户增量变成标题，只用已存的模型标题或时间兜底。
    // 输入摘要仍按同一套关系取值，不为 aux 另写一份规则。
    if (facts.isAux) {
      title = facts.modelTitle ?? fallback;
      titleSource = facts.modelTitle !== null ? 'model_title' : 'model_time';
    }
    const delta = facts.delta;
    if (delta !== null && delta.length > 0) {
      // delta 里存的是本笔的 ord；取出对应消息后按 0..n-1 重新编号给 deriveTitle。
      const messages = delta.map(ordinal => ports.messageAt(facts.reqId, ordinal));
      if (!facts.isAux) {
        const derived = deriveTitle(messages, delta.map((_, index) => index), fallback, facts.agent);
        title = derived.title;
        titleSource = derived.source;
      }
      // 增量里常常只有工具结果或系统消息，没有用户文本。
      // 有用户文本才标成"新增"；否则照实说这一轮回传了什么工具结果。
      // 不要回退到"末轮输入"——那会把同一句旧用户消息重复到每一笔请求上。
      const fresh = previewOf(messages, facts.agent);
      if (fresh !== null) {
        inputPreview = fresh;
        inputKind = 'delta';
      } else {
        inputPreview = ports.toolResultPreview(facts.reqId, delta, associations);
        inputKind = inputPreview === null ? null : 'tool_result';
      }
    } else if (delta !== null) {
      // 这一笔没有新增消息：输入就是上一轮的工具结果，摘要照实说。
      inputPreview = '输入是上一轮的工具结果，没有新的用户消息';
      inputKind = 'tool_result';
    } else {
      // 关系未知、另起一支或排除用途：没有"新增"可言，但折叠行仍要有东西可读。
      // 取正文里最后一条用户消息，界面会把它标成"末轮输入"而不是"新增"。
      inputPreview = ports.tailUserPreview(facts.reqId);
      inputKind = inputPreview === null ? null : 'tail';
    }
  }
  return { title, titleSource, inputPreview, inputKind, replyPreview: facts.replyPreview };
}
