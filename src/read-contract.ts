/**
 * 具名读取契约：页面全部读取操作的输入、输出与稳定错误。
 *
 * 只包含类型，不生成运行代码；DTO 以 type-only 引用既有查询与阅读模块，不复制
 * 结构。URL 拼接、HTTP 状态与 Response 只属于 web/read-http.js；store 与 feature
 * 只消费这里的操作名、ReadInput/ReadOutput 与 ReadErrorCode。批次端点的服务端
 * 实现归 reading 批读取（Task 4），本契约先固定它的对外形状。
 */
import type { SessionRow } from './queries/sessions';
import type { RequestRow } from './queries/projection';
import type { Page } from './queries/cursor';
import type {
  ReadingDetail, ReadingBody, ToolResultReading,
  ContextItemQuery, ContextItemReading,
} from './reading';
import type { TurnsPage } from './queries/turns';
import type { BgJobRow } from './queries/bg-jobs';
import type { TodoByTurn } from './queries/todo-by-turn';
import type { SessionSummary, SummaryEntriesQuery, SummaryEntries } from './queries/session-summary';
import type { Stats } from './queries/stats';
import type { getRoute } from './queries/routes';

/** 单笔正文区间读取的输入；token 是 owner 当时的阅读身份（if_reading）。 */
export type RangeInput = { id: number; token: string; from: number; to: number };

/**
 * 弹窗条目正文的两个落点：普通消息区间走 body，配对工具结果走 toolResult。
 * 条目正文读取用判别参数声明，不各自拼 URL。
 */
export type ContextBodyTarget =
  | { operation: 'body'; input: RangeInput }
  | { operation: 'toolResult'; input: { id: number; ord: number; token: string } };

/** 详情与元信息共用一次阅读身份；批次内同快照，detail.req_id 与 meta.req_id 相等。 */
export type ReadingBundle = { detail: ReadingDetail; meta: ReadingBody };

/**
 * 批次单项。index 是本次调用的输入位置：分页重发后缀时后缀重新从 0 编号。
 * requested_id 是调用者请求的 id，服务端 canonical 后不回写外层；成功项的身份
 * 字段（reading_token、req_id）在 value 内保持原字段，不复制一份可冲突事实。
 */
export type BatchItem<T> =
  | { index: number; requested_id: number; state: 'ok'; value: T }
  | { index: number; requested_id: number;
      state: 'not_found' | 'reading_changed' | 'oversized' | 'failed'; reason: string };

/** 批次响应：next_index 非 null 时已返回项恰好覆盖 [0, next_index)。 */
export type BatchPage<T> = { items: BatchItem<T>[]; next_index: number | null };

/**
 * 全部读取操作。名称是明确的读取用途，不是通用执行器；操作集合不自动生成
 * 服务端路由，HTTP 层继续显式解析与校验。
 */
export type ReadOperations = {
  sessions: { input: { limit: number; cursor: string | null }; output: Page<SessionRow> };
  requests: { input: { key: string; limit: number; cursor: string | null;
    direction: 'forward' | 'older' }; output: Page<RequestRow> };
  detail: { input: { id: number }; output: ReadingDetail };
  body: { input: RangeInput; output: ReadingBody };
  toolResult: { input: { id: number; ord: number; token: string }; output: ToolResultReading };
  route: { input: { id: number }; output: ReturnType<typeof getRoute> };
  turns: { input: { key: string; from: number | null }; output: TurnsPage };
  bgJobs: { input: { key: string }; output: BgJobRow[] };
  todoByTurn: { input: { key: string; actor: string; turn: number }; output: TodoByTurn };
  summary: { input: { key: string }; output: SessionSummary };
  summaryEntries: { input: { key: string; query: SummaryEntriesQuery }; output: SummaryEntries };
  contextItem: { input: { id: number; token: string; query: ContextItemQuery };
    output: ContextItemReading };
  stats: { input: Record<string, never>; output: Stats };
  readings: { input: { key: string; ids: number[] }; output: BatchPage<ReadingBundle> };
  bodyRanges: { input: { key: string; ranges: RangeInput[] }; output: BatchPage<ReadingBody> };
};

export type ReadInput<K extends keyof ReadOperations> = ReadOperations[K]['input'];
export type ReadOutput<K extends keyof ReadOperations> = ReadOperations[K]['output'];

/**
 * 读取传输 seam：HTTP adapter 与测试 adapter 是它的两个实际实现。
 * 实现持续到响应体读完、解析与顶层校验完成；AbortSignal 只作执行控制，不进载荷。
 */
export type ReadTransport = {
  execute<K extends keyof ReadOperations>(
    operation: K, input: ReadInput<K>, options: { signal: AbortSignal },
  ): Promise<ReadOutput<K>>;
};

/** 稳定错误码；HTTP adapter 保留 status 供诊断，消费方只认错误码。 */
export type ReadErrorCode = 'reading_changed' | 'not_found' | 'invalid_input'
  | 'unavailable' | 'unauthorized' | 'forbidden' | 'unsupported_operation'
  | 'invalid_response' | 'cancelled' | 'queue_full' | 'batch_too_large';
