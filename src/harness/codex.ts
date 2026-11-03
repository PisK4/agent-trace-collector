/**
 * Codex 的 Harness 专属用途判定。
 *
 * Codex 在请求体的 `client_metadata['x-codex-turn-metadata']` 里自报这次 turn 的
 * 来源与触发方式：`thread_title` 是标题生成，`ambient_suggestions` 与
 * `memory_consolidation` 是后台任务。`user`/`composer` 等前台取值不改变通用判定。
 *
 * 标题回复是 `{title, description}` 双键 JSON，比通用标题形状多一个键。放宽只
 * 发生在这个适配器里：通用 `parseTitleReply` 继续要求单键，避免普通对话回复
 * 因为带一个 description 就从主链消失。
 */
import {
  parseTitleReply, PURPOSE_VERSION,
  type PurposeDecision, type PurposeView,
} from '../semantics';

export type UpstreamTurnFacts = {
  source: string | null;
  trigger: string | null;
  turnRef: string | null;
};

const TURN_METADATA_KEY = 'x-codex-turn-metadata';
const TITLE_INTENT = 'thread_title';
const BACKGROUND_INTENTS = new Set(['ambient_suggestions', 'memory_consolidation']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 从请求体取 Codex 的 turn 事实；没有版本化元数据或三个字段都缺时返回 null。
 *
 * `turn_id` 也出现在 `client_metadata` 顶层，两层都认。来源与触发方式冲突、
 * 且至少有一个是已知旁路取值时不据此分类——冲突的元数据不足以让一笔请求
 * 退出主链。
 */
export function codexTurnFactsOf(request: unknown): UpstreamTurnFacts | null {
  if (!isRecord(request)) return null;
  const metadata = request.client_metadata;
  if (!isRecord(metadata)) return null;
  const raw = metadata[TURN_METADATA_KEY];
  let turn: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) turn = value;
    } catch {
      turn = null;
    }
  } else if (isRecord(raw)) {
    turn = raw;
  }
  const source = nonEmpty(turn?.thread_source);
  const trigger = nonEmpty(turn?.turn_trigger);
  const turnRef = nonEmpty(turn?.turn_id) ?? nonEmpty(metadata.turn_id);
  if (source === null && trigger === null && turnRef === null) return null;
  if (source !== null && trigger !== null && source !== trigger
    && (source === TITLE_INTENT || BACKGROUND_INTENTS.has(source)
      || trigger === TITLE_INTENT || BACKGROUND_INTENTS.has(trigger))) {
    return null;
  }
  return { source, trigger, turnRef };
}

/**
 * Codex 标题回复：先走通用形状，再接受 `{title, description}` 双键 JSON。
 *
 * 双键要求两个值都是字符串、且没有别的键；title 按通用规则压空白。
 */
export function codexTitleFromReply(text: string | null): string | null {
  const shared = parseTitleReply(text);
  if (shared !== null) return shared.title;
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'description' || keys[1] !== 'title') return null;
  if (typeof value.title !== 'string' || typeof value.description !== 'string') return null;
  const title = value.title.replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : null;
}

export function codexDecision(view: PurposeView): PurposeDecision | null {
  const turn = view.upstreamTurn;
  const declared = turn === null ? null : (turn.trigger ?? turn.source);
  const sourceValue = view.source.state === 'single' || view.source.state === 'agree'
    ? view.source.value?.trim() ?? null : null;
  const sourceIntent = sourceValue === TITLE_INTENT || (sourceValue !== null && BACKGROUND_INTENTS.has(sourceValue))
    ? sourceValue : null;
  const conflict = sourceIntent !== null && declared !== null && declared !== sourceIntent;
  const signals = (base: string[]): string[] =>
    conflict ? [...base, 'source.conflict'] : base;

  if (declared === TITLE_INTENT) {
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'codex.thread.v1',
      signals: signals(['codex.thread.thread_title']),
      chain: 'exclude',
      kind: 'title',
      modelTitle: codexTitleFromReply(view.replyText)
        ?? (view.stored.kind === 'title' ? view.stored.modelTitle : null),
    };
  }
  if (declared !== null && BACKGROUND_INTENTS.has(declared)) {
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'codex.thread.v1',
      signals: signals([`codex.thread.${declared}`]),
      chain: 'exclude',
      kind: `source:${declared}`,
      modelTitle: null,
    };
  }
  // 上游元数据说前台、来源 kind 却说标题/后台：冲突不足以让请求退出主链。
  // 保留来源 kind 作为参与链类别，并留下可检索的冲突信号。
  if (declared !== null && sourceIntent !== null) {
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'codex.thread.v1',
      signals: ['source.conflict', `codex.thread.${sourceIntent}`],
      chain: 'participate',
      kind: `source:${sourceIntent}`,
      modelTitle: null,
    };
  }
  // 没有版本化元数据的旧请求：来源 kind 仍能证明 title/后台，前提是值精确。
  if (turn === null && sourceIntent !== null) {
    const title = sourceIntent === TITLE_INTENT;
    return {
      status: 'recognized',
      version: PURPOSE_VERSION,
      rule: 'codex.thread.v1',
      signals: [`codex.thread.${sourceIntent}`],
      chain: 'exclude',
      kind: title ? 'title' : `source:${sourceIntent}`,
      modelTitle: title ? codexTitleFromReply(view.replyText) : null,
    };
  }
  return null;
}
