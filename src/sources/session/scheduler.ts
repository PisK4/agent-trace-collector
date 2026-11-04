/**
 * 会话适配器的两档调度。
 *
 * 所有适配器每分钟都做一次只读发现，最近活跃的文件走 live 小预算；历史积压
 * 每轮只轮一家走适配器自己的大预算。这样新增 Agent 不会把活跃会话的延迟拉长
 * 到 N 分钟，也不会让某一家长期占满一轮。
 */

import type { Store } from '../../store';
import { discoverSessionFiles, ingestSessionFiles } from './ingest';
import type { SessionIngestResult } from './ingest';
import type { SessionAdapter, SessionFile } from './types';

export type SessionSchedulerConfig = {
  /** 文件 mtime 在这个窗口内算活跃。 */
  liveWindowMs: number;
  /** 每轮最多处理几家活跃来源，避免所有适配器同时读大文件。 */
  maxLiveAdapters: number;
  /** live 档单家预算；新文件优先，只取一小批。 */
  liveBatch: { maxFiles: number; maxBytes: number };
};

export const DEFAULT_SESSION_SCHEDULER: SessionSchedulerConfig = {
  liveWindowMs: 10 * 60_000,
  maxLiveAdapters: 4,
  liveBatch: { maxFiles: 2, maxBytes: 256 * 1024 },
};

export type SessionSchedulerState = { backfillCursor: number };

export type SessionSchedulerResult = {
  live: number;
  backfill: number;
  files: number;
  calls: number;
  bytes: number;
};

function add(total: SessionSchedulerResult, result: SessionIngestResult): void {
  total.files += result.files;
  total.calls += result.calls;
  total.bytes += result.bytes;
}

function newestMtime(files: readonly SessionFile[]): number {
  return files.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0);
}

export async function runSessionScheduler(
  store: Store,
  adapters: readonly SessionAdapter[],
  rootsFor: (adapter: SessionAdapter) => readonly string[],
  salt: Uint8Array,
  now: number,
  state: SessionSchedulerState,
  config: SessionSchedulerConfig = DEFAULT_SESSION_SCHEDULER,
): Promise<SessionSchedulerResult> {
  const total: SessionSchedulerResult = { live: 0, backfill: 0, files: 0, calls: 0, bytes: 0 };
  if (adapters.length === 0) return total;

  const discovered: { adapter: SessionAdapter; files: SessionFile[] }[] = [];
  for (const adapter of adapters) {
    const files = await discoverSessionFiles(store, adapter, rootsFor(adapter), now);
    discovered.push({ adapter, files });
  }

  const live = discovered
    .map(entry => ({
      ...entry,
      active: entry.files.filter(file =>
        file.remaining > 0 && file.mtimeMs >= now - config.liveWindowMs),
    }))
    .filter(entry => entry.active.length > 0)
    .sort((left, right) => newestMtime(right.active) - newestMtime(left.active))
    .slice(0, config.maxLiveAdapters);
  for (const entry of live) {
    add(total, await ingestSessionFiles(store, entry.adapter, entry.active, salt, now, config.liveBatch));
    total.live += 1;
  }

  // 回填轮转跳过空来源；找到一家后重新发现，避免重复读取 live 刚提交的文件。
  for (let offset = 0; offset < adapters.length; offset += 1) {
    const index = (state.backfillCursor + offset) % adapters.length;
    const entry = discovered[index]!;
    if (!entry.files.some(file => file.remaining > 0)) continue;
    state.backfillCursor = (index + 1) % adapters.length;
    const files = await discoverSessionFiles(store, entry.adapter, rootsFor(entry.adapter), now);
    add(total, await ingestSessionFiles(store, entry.adapter, files, salt, now, entry.adapter.batch));
    total.backfill += 1;
    break;
  }
  return total;
}
