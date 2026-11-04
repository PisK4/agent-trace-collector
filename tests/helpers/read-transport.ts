/**
 * 读取 transport 的测试替身。
 *
 * `createFixtureReadTransport` 是合成 fixture adapter：不调用真实 HTTP，操作响应
 * 由测试配置，支持延迟（hold/release/started）、错误注入与显式
 * unsupported_operation，供 store 与调度行为测试使用。它不是返回空成功的空壳。
 *
 * `createInProcessReadTransport` 直调真实查询函数，作为 HTTP adapter 的对照实现：
 * 同一份数据两种 transport 必须给出相同的公开结果。
 */
import type {
  ReadErrorCode, ReadInput, ReadOperations, ReadOutput, ReadTransport,
} from '../../src/read-contract';
import type { Store } from '../../src/store';
import { listSessions } from '../../src/queries/sessions';
import { listRequests } from '../../src/queries/requests';
import {
  getContextItemReading, getReadingBatch, getReadingBody, getReadingDetail,
  getReadingRangeBatch, getToolResultReading,
} from '../../src/reading';
import { ReadingConflictError } from '../../src/reading';
import { getRoute } from '../../src/queries/routes';
import { listTurns } from '../../src/queries/turns';
import { listBgJobs } from '../../src/queries/bg-jobs';
import { getTodoByTurn } from '../../src/queries/todo-by-turn';
import { getSessionSummary, getSummaryEntries } from '../../src/queries/session-summary';
import { getStats } from '../../src/queries/stats';

export type FixtureCall = { operation: keyof ReadOperations; input: unknown };

/** 构造稳定错误码错误：respond 的输入函数 throw 它即可注入持久失败。 */
export function readError(code: ReadErrorCode): Error {
  return Object.assign(new Error(code), { code });
}

export type FixtureReadTransport = {
  transport: ReadTransport;
  /** 已进入 adapter 的调用序列，按执行顺序记录操作与输入。 */
  calls: FixtureCall[];
  /** 当前停在 adapter 内（进入未返回）的执行数，供并发上界断言。 */
  inflight(): number;
  /** adapter 内并发的历史峰值。 */
  maxInflight(): number;
  /** 按操作与输入谓词统计调用次数；无谓词时统计全部。 */
  count(operation: keyof ReadOperations, match?: (input: any) => boolean): number;
  /** 延迟下一次该操作的执行：任务进入 adapter 后停在 hold 点。 */
  hold(operation: keyof ReadOperations): void;
  /** 放行当前停在 hold 点的该操作执行。 */
  release(operation: keyof ReadOperations): void;
  /** 等待该操作下一次进入 adapter（hold 点触发时 resolve）。 */
  started(operation: keyof ReadOperations): Promise<void>;
  /** 下一次该操作抛稳定错误，不产生结果。 */
  failNext(operation: keyof ReadOperations, code: ReadErrorCode): void;
  /** 配置操作响应；值或输入函数均可。未配置的操作报 unsupported_operation。
   *  行为测试允许只给最小形状（缓存、守卫、取消的语义断言不需要完整 DTO）；
   *  DTO 完整性由 read-contract 契约测试对照真实查询函数保证。输入函数经首个
   *  重载获得签名级的参数上下文，lambda 不需要显式标注。 */
  respond(operation: keyof ReadOperations, value: (input: any) => unknown): void;
  respond(operation: keyof ReadOperations, value: unknown): void;
};

export function createFixtureReadTransport(): FixtureReadTransport {
  const codeError = (code: ReadErrorCode): Error =>
    Object.assign(new Error(code), { code });
  /** 每操作的响应配置、错误注入、hold 点与到达等待者。 */
  const handlers = new Map<keyof ReadOperations, ((input: unknown) => unknown) | unknown>();
  const failures = new Map<keyof ReadOperations, ReadErrorCode>();
  const gates = new Map<keyof ReadOperations, Promise<void>>();
  const releases = new Map<keyof ReadOperations, () => void>();
  const arrivals = new Map<keyof ReadOperations, Array<() => void>>();
  const calls: FixtureCall[] = [];
  let active = 0;
  let maxActive = 0;

  const transport: ReadTransport = {
    async execute<K extends keyof ReadOperations>(
      operation: K, input: ReadInput<K>, { signal }: { signal: AbortSignal },
    ): Promise<ReadOutput<K>> {
      calls.push({ operation, input });
      active += 1;
      if (active > maxActive) maxActive = active;
      try {
        if (signal.aborted) throw codeError('cancelled');
        const arrival = arrivals.get(operation);
        if (arrival !== undefined) {
          for (const resolve of arrival.splice(0)) resolve();
        }
        const gate = gates.get(operation);
        if (gate !== undefined) {
          // hold 点感知取消：被 abort 的执行不等到放行，立即以 cancelled 退出，
          // 与真实 transport 的 fetch 中断行为对齐。
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort);
              gates.delete(operation);
              releases.delete(operation);
              reject(codeError('cancelled'));
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
            gate.then(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            });
          });
          gates.delete(operation);
          releases.delete(operation);
        }
        if (signal.aborted) throw codeError('cancelled');
        const failure = failures.get(operation);
        if (failure !== undefined) {
          failures.delete(operation);
          throw codeError(failure);
        }
        const handler = handlers.get(operation);
        if (handler === undefined) throw codeError('unsupported_operation');
        const value = typeof handler === 'function' ? (handler as (input: unknown) => unknown)(input) : handler;
        if (signal.aborted) throw codeError('cancelled');
        return value as ReadOutput<K>;
      } finally {
        active -= 1;
      }
    },
  };

  return {
    transport,
    calls,
    inflight: () => active,
    maxInflight: () => maxActive,
    count(operation, match) {
      return calls.filter(call =>
        call.operation === operation
        && (match === undefined || match(call.input as never))).length;
    },
    hold(operation) {
      let release!: () => void;
      gates.set(operation, new Promise<void>(resolve => { release = resolve; }));
      releases.set(operation, release);
    },
    release(operation) {
      const release = releases.get(operation);
      if (release === undefined) throw new Error(`fixture: operation ${String(operation)} 未在 hold 中`);
      release();
    },
    started(operation) {
      return new Promise<void>(resolve => {
        const list = arrivals.get(operation);
        if (list === undefined) arrivals.set(operation, [resolve]);
        else list.push(resolve);
      });
    },
    failNext(operation, code) {
      failures.set(operation, code);
    },
    respond(operation, value) {
      handlers.set(operation, value);
    },
  };
}

/**
 * 真实查询的进程内 adapter：与 src/http.ts 的读路径调用同一批函数，
 * 契约测试用它对照 HTTP 往返。查询返回 null 的 not_found 语义映射为稳定错误，
 * 与 HTTP adapter 的 404 映射一致；批次端点交付后在此接入。
 */
const codeError = (code: ReadErrorCode): Error =>
  Object.assign(new Error(code), { code });

const requireValue = <T>(value: T | null): T => {
  if (value === null) throw codeError('not_found');
  return value;
};

/** 直调真实查询；返回 null 的 not_found 与 ReadingConflictError 在此映射为稳定错误。 */
async function dispatchQuery(store: Store, operation: keyof ReadOperations,
  rawInput: unknown): Promise<unknown> {
  switch (operation) {
    case 'sessions': {
      const input = rawInput as ReadInput<'sessions'>;
      return listSessions(store, input.limit, input.cursor);
    }
    case 'requests': {
      const input = rawInput as ReadInput<'requests'>;
      return listRequests(store, input.key, input.limit, input.cursor, input.direction);
    }
    case 'detail': {
      const input = rawInput as ReadInput<'detail'>;
      return requireValue(getReadingDetail(store, input.id));
    }
    case 'body': {
      const input = rawInput as ReadInput<'body'>;
      return requireValue(getReadingBody(store, input.id, input.from, input.to, input.token));
    }
    case 'toolResult': {
      const input = rawInput as ReadInput<'toolResult'>;
      return requireValue(getToolResultReading(store, input.id, input.ord, input.token));
    }
    case 'route': {
      const input = rawInput as ReadInput<'route'>;
      return getRoute(store, input.id);
    }
    case 'turns': {
      const input = rawInput as ReadInput<'turns'>;
      return listTurns(store, input.key, input.from);
    }
    case 'bgJobs': {
      const input = rawInput as ReadInput<'bgJobs'>;
      return listBgJobs(store, input.key);
    }
    case 'todoByTurn': {
      const input = rawInput as ReadInput<'todoByTurn'>;
      return getTodoByTurn(store, input.key, input.actor, input.turn);
    }
    case 'summary': {
      const input = rawInput as ReadInput<'summary'>;
      return getSessionSummary(store, input.key);
    }
    case 'summaryEntries': {
      const input = rawInput as ReadInput<'summaryEntries'>;
      return getSummaryEntries(store, input.key, input.query);
    }
    case 'contextItem': {
      const input = rawInput as ReadInput<'contextItem'>;
      return requireValue(getContextItemReading(store, input.id, input.query, input.token));
    }
    case 'readings': {
      const input = rawInput as ReadInput<'readings'>;
      return getReadingBatch(store, input.key, input.ids);
    }
    case 'bodyRanges': {
      const input = rawInput as ReadInput<'bodyRanges'>;
      return getReadingRangeBatch(store, input.key, input.ranges);
    }
    case 'stats':
      return getStats(store);
    default:
      throw codeError('unsupported_operation');
  }
}

export function createInProcessReadTransport(store: Store): ReadTransport {
  return {
    async execute<K extends keyof ReadOperations>(
      operation: K, input: ReadInput<K>, { signal }: { signal: AbortSignal },
    ): Promise<ReadOutput<K>> {
      if (signal.aborted) throw codeError('cancelled');
      try {
        return await dispatchQuery(store, operation, input) as ReadOutput<K>;
      } catch (error) {
        // 阅读身份冲突在查询层是异常、在契约上是稳定错误码，与 HTTP 409 对齐。
        if (error instanceof ReadingConflictError) throw codeError('reading_changed');
        throw error;
      }
    },
  };
}
