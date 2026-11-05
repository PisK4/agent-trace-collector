/**
 * 本地 Agent 会话适配器的共同契约。
 *
 * 适配器只负责三件事：找到会话流、把一行原文解析成事件、把事件归约成一笔
 * 可证明的模型调用。游标、原始层、证据、正文与去重由 `ingest.ts` 统一处理。
 *
 * 四条硬约束（与提案一致）：
 * - `discover` 只 stat 与读目录，不读正文；根缺失返回空，根存在但读不出由
 *   `read` 报 `unreadable`，不能折成空。
 * - 同一会话多副本由适配器按根优先级与 mtime 裁决，引擎只认适配器给出的流。
 * - 坏行停游标：跳过一条消息会让后续每轮请求体缺一条。
 * - 用量一律归一到 magpie 口径：`input` 不含 cache read/write。
 */

import type { Database } from 'bun:sqlite';
import type { SourceKind } from '../files';
import { canonicalSessionId } from '../../evidence';

export type SessionKind = Extract<SourceKind,
  'claude_session' | 'codex_session' | 'dsh_session' | 'grok_session'
  | 'hermes_session' | 'omp_session' | 'pi_session' | 'workbuddy_session' | 'zcode_session'
  | 'droid_transcript'>;

/** magpie 口径的四段用量；缺任一段的调用记 null，不用 0 冒充。 */
export type SessionUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** 一笔会话内可证明的模型调用。适配器只填它能证明的字段。 */
export type SessionCall = {
  /** 阅读单位的会话 id：子代理折叠到根会话。 */
  sessionId: string;
  /** 子代理自己的会话 id；非子代理为 null。 */
  subagentId: string | null;
  /** `['session', sessionId]` 的 JSON 串；由适配器归一后给出。 */
  convKey: string;
  /** 适配器内稳定的调用身份，与 sessionId 一起构成证据 ref_key。 */
  callId: string;
  /** 调用第一行的物理起点；延迟发调用时引擎用它写 sort_key。 */
  sortOffset?: number;
  /** 子代理的父会话；与 subagentId 同源，供 parent_agent 列使用。 */
  parentSessionId: string | null;
  /** 调用开始时间（不是完成时间）；网关与本地对齐用这个基准。 */
  startedMs: number;
  /**
   * 调用完成时间；来源只读得到消息落库时刻时填它，owner 用它跟网关
   * `started_ms + ms` 做 ±2 秒的完成时间对齐。缺省为 null。
   */
  endedMs?: number | null;
  model: string | null;
  responseIdNorm: string | null;
  /** Codex thread turn 身份；没有就 null。 */
  turnRef: string | null;
  usage: SessionUsage | null;
  reasoning: string | null;
  /** 来源记录的思考档位；只进 source_facts，不写 reasoning 列。 */
  reasoningEffort?: string | null;
  /** 调用发生前的完整上下文，形状按 bodyProtocol 解释。 */
  requestMessages: unknown[];
  replyContent: unknown[];
  cwd: string | null;
};

/** 适配器发现的一条会话流。文件适配器是文件，Zcode 是「库 + 会话」。 */
export type SessionFile = {
  /** source_cursor.source_name：文件适配器用绝对路径，Zcode 用 `<db>#<session>`。 */
  name: string;
  path: string;
  /** 物理大小或库内近似量；只用于取件排序，不参与解析。 */
  size: number;
  mtimeMs: number;
  /** 距游标还剩多少可取：文件是剩余字节，Zcode 是待读行数。 */
  remaining: number;
};

/** 游标快照；适配器用它在发现阶段估算 remaining，不读正文。 */
export type SessionCursorLookup = (name: string) =>
  { generation: string; committedOff: number; observedOff: number; seenSize: number } | null;

export type SessionParseResult =
  | {
    kind: 'event'; lineType: string; atMs: number | null; sessionId: string | null;
    /** 物理行起点（文件字节或库内 rowid）；适配器延迟发调用时用它排序。 */
    offset: number;
    /** 本事件来自原始层重放；延迟发调用的适配器据此避免每批重复补发。 */
    replay?: boolean;
    value: unknown;
  }
  /** 与调用无关的行：游标照常前进，但不落原始层、不进状态。 */
  | { kind: 'ignore' }
  | { kind: 'invalid'; reason: string };

export type SessionApplyResult = {
  state: unknown;
  calls: SessionCall[];
  error: string | null;
  /** 归约后能确认的会话身份；写入 raw 行便于审计。 */
  sessionId: string | null;
};

export type SessionAdapter = {
  /** request.agent 的取值。 */
  agent: string;
  sourceKind: SessionKind;
  /** ingest_issue.source_kind。 */
  issueKind: string;
  /** 读取失败时的 issue reason；默认 'session_source_unreadable'。 */
  unreadableReason?: string;
  /** request_evidence.source_kind；同来源相邻调用靠它排除认领。 */
  evidenceKind: string;
  bodyProtocol: 'anthropic' | 'chat' | 'responses' | 'droid-session';
  /** request.sort_source。 */
  sortSource: string;
  /** request.attempt_state 初值；默认 'known'。转录没有 attempt 语义时用 'not_applicable'。 */
  attemptState?: 'known' | 'not_applicable';
  /** 行可原地更新（SQLite 物化行）时为 true：同一 ref 的新 payload 刷新既有行。 */
  mutable: boolean;
  /** 延迟发调用的适配器在批末可能补发同一 ref：重复证据也要刷新正文。 */
  refreshOnDuplicate?: boolean;
  /** 需要从本代际原始层重放解析状态（追加文件）时为 true。 */
  replaysState: boolean;
  /**
   * 是否把每条解析事件落 `raw_session_event`。默认 true；物化行来源
   * （如 Zcode 的 SQLite）行本身可重读，落原始层只会把整段上下文再存一份。
   */
  storesRaw?: boolean;
  /**
   * 行偏移就是游标位置时逐行推进游标，默认 true。容器读取（DSH 的 zstd
   * frame）的行偏移只是身份，游标由读取层的整批 `committedOff` 决定。
   */
  lineCommit?: boolean;
  /** 单轮取件预算；Zcode 按会话计，不受字节预算约束。 */
  batch: { maxFiles: number; maxBytes: number; order?: 'mtime' | 'remaining' };
  roots(env: Record<string, string | undefined>, home: string): string[];
  discover(root: string, cursorFor: SessionCursorLookup): SessionFile[] | Promise<SessionFile[]>;
  /** 发现后的副本裁决；要比较内容时用异步读，不阻塞事件循环。 */
  select?(files: readonly SessionFile[]): SessionFile[] | Promise<SessionFile[]>;
  read(file: SessionFile, cursor: import('../files').SourceCursor | null): Promise<import('../files').SourceRead>;
  /** 解析已脱敏的 payload 文本；坏行只报原因，不抛异常。 */
  parse(text: string): SessionParseResult;
  emptyState(file?: SessionFile): unknown;
  apply(state: unknown, event: SessionParseResult & { kind: 'event' }): SessionApplyResult;
  /** 批末补发仍挂起的调用；只有延迟发调用的适配器需要。 */
  flush?(state: unknown): SessionApplyResult;
  /** 批内来源私有副作用（如 droid 的 settings 用量）；写事务内调用，返回变更数。 */
  afterFile?(db: Database, state: unknown, file: SessionFile, now: number): number;
};

/** 会话键的唯一形状：与账本、OTLP 的 sessionRef 逐字相同。 */
export function sessionConvKey(sessionId: string): string {
  return JSON.stringify(['session', sessionId]);
}

/** 常见前缀去壳后的裸会话 id；不认识的前缀原样保留，不猜。 */
export { canonicalSessionId };