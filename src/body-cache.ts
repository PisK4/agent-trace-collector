import { zstdDecompressSync } from 'node:zlib';

/**
 * 一次派生作用域内的消息块解码复用。
 *
 * 块按内容哈希缓存，不按 `block.id`：id 只是当前库里的代理键，删除后可能被
 * 复用，不能当跨请求或跨库的内容身份。哈希由写入端按完整消息字节计算，
 * 块内容不可变，所以同哈希即同一份消息。
 *
 * 缓存只复用解压与 JSON 解析结果，不改变读取路径的状态检查。调用方仍先读
 * `body_state`、骨架和引用顺序；命中不会绕过回收、缺块或 ord 校验。
 *
 * 共享对象按只读约定使用。缓存条目在写入时递归冻结，消费者原地修改会在
 * 严格模式下抛错，避免一个请求把内容污染给后续请求。
 */

/** 读取消息块所需的列；`hash` 是 `hex(block.hash)`，不是代理键。 */
export type BlockMessageRow = {
  id: number;
  hash: string;
  z: Uint8Array;
  raw_size: number;
};

export type BodyReadStats = {
  /** 消息块命中次数。 */
  message_hits: number;
  /** 消息块未命中次数，含成功解码与解码失败。 */
  message_misses: number;
  /** 实际执行解压与 JSON 解析的次数。 */
  message_decodes: number;
  /** 因单块超过上限或预算不足而没有进入缓存的次数。 */
  message_oversize: number;
  /** 缺少内容身份、无法安全复用而没有进入缓存的次数。 */
  message_skipped: number;
  /** 解压或 JSON 解析失败次数；失败结果不缓存。 */
  message_unreadable: number;
  /** 为腾出预算淘汰的条目数。 */
  message_evictions: number;
};

export type BodyReadSnapshot = BodyReadStats & {
  cached_entries: number;
  cached_bytes: number;
  budget_bytes: number;
  max_block_bytes: number;
};

export type BodyReadCache = {
  /** 解码一条块引用；`undefined` 表示解压或解析失败，不是合法消息值。 */
  message(row: BlockMessageRow): unknown | undefined;
  /** 当前作用域的计数与占用；返回副本，调用方只读。 */
  snapshot(): BodyReadSnapshot;
};

/**
 * 单次组派生默认最多保留 64 MiB 解码消息。最大实测组去重后的原始消息在
 * 数十 MiB 量级，64 MiB 足以覆盖一轮组内共享；超出的作用域按 LRU 淘汰，
 * 正确性不依赖预算命中。
 */
export const DEFAULT_BODY_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
/** 单个消息块超过 8 MiB 时不入缓存，避免一个大工具结果挤掉整组共享块。 */
export const DEFAULT_BODY_CACHE_MAX_BLOCK_BYTES = 8 * 1024 * 1024;
/** Map 条目、字符串键与解码对象头的粗估；预算按可核算的近似值计。 */
const ENTRY_OVERHEAD_BYTES = 256;

export function emptyBodyReadStats(): BodyReadStats {
  return {
    message_hits: 0,
    message_misses: 0,
    message_decodes: 0,
    message_oversize: 0,
    message_skipped: 0,
    message_unreadable: 0,
    message_evictions: 0,
  };
}

/** 把一次作用域的计数累加进汇总；占用是瞬时值，不参与累加。 */
export function addBodyReadStats(target: BodyReadStats, source: BodyReadStats): void {
  target.message_hits += source.message_hits;
  target.message_misses += source.message_misses;
  target.message_decodes += source.message_decodes;
  target.message_oversize += source.message_oversize;
  target.message_skipped += source.message_skipped;
  target.message_unreadable += source.message_unreadable;
  target.message_evictions += source.message_evictions;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(name);
  return value;
}

/** 解码后的消息只读共享；JSON 没有环，递归冻结不会死循环。 */
function freezeMessage(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeMessage(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeMessage(item);
  }
  return value;
}

export function createBodyReadCache(options: {
  budgetBytes?: number;
  maxBlockBytes?: number;
} = {}): BodyReadCache {
  const budgetBytes = positiveInteger(
    options.budgetBytes ?? DEFAULT_BODY_CACHE_BUDGET_BYTES, 'invalid_body_cache_budget');
  const maxBlockBytes = positiveInteger(
    options.maxBlockBytes ?? DEFAULT_BODY_CACHE_MAX_BLOCK_BYTES, 'invalid_body_cache_max_block');
  const entries = new Map<string, { value: unknown; bytes: number }>();
  const stats = emptyBodyReadStats();
  let cachedBytes = 0;

  return {
    message(row) {
      const cached = entries.get(row.hash);
      if (cached !== undefined) {
        stats.message_hits += 1;
        // 命中即最近使用：Map 的插入序就是淘汰序，先删后插把它移到末尾。
        entries.delete(row.hash);
        entries.set(row.hash, cached);
        return cached.value;
      }

      stats.message_misses += 1;
      stats.message_decodes += 1;
      let value: unknown;
      try {
        value = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
      } catch {
        // 坏块不缓存：同一作用域内再次读到仍按坏块处理，不留下永久成功或失败。
        stats.message_unreadable += 1;
        return undefined;
      }

      if (row.hash.length === 0) {
        stats.message_skipped += 1;
        return value;
      }
      const rawBytes = Number.isSafeInteger(row.raw_size) && row.raw_size >= 0
        ? row.raw_size : row.z.length;
      const bytes = rawBytes + ENTRY_OVERHEAD_BYTES;
      if (rawBytes > maxBlockBytes || bytes > budgetBytes) {
        stats.message_oversize += 1;
        return value;
      }

      while (cachedBytes + bytes > budgetBytes && entries.size > 0) {
        const oldest = entries.keys().next().value as string;
        const removed = entries.get(oldest)!;
        entries.delete(oldest);
        cachedBytes -= removed.bytes;
        stats.message_evictions += 1;
      }
      const frozen = freezeMessage(value);
      entries.set(row.hash, { value: frozen, bytes });
      cachedBytes += bytes;
      return frozen;
    },
    snapshot() {
      return {
        ...stats,
        cached_entries: entries.size,
        cached_bytes: cachedBytes,
        budget_bytes: budgetBytes,
        max_block_bytes: maxBlockBytes,
      };
    },
  };
}

/** 无缓存路径：与旧实现相同的单次解压与解析。 */
export function decodeBlockMessage(row: BlockMessageRow): unknown | undefined {
  try {
    return JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 有作用域缓存就走缓存，否则按单次读取；两条路径的失败语义相同。 */
export function messageOfBlock(row: BlockMessageRow, cache?: BodyReadCache): unknown | undefined {
  return cache === undefined ? decodeBlockMessage(row) : cache.message(row);
}

/** 从快照取出可累加的计数，丢掉瞬时占用。 */
export function bodyReadCounters(snapshot: BodyReadSnapshot): BodyReadStats {
  const {
    cached_entries: _entries, cached_bytes: _bytes, budget_bytes: _budget,
    max_block_bytes: _max, ...counters
  } = snapshot;
  return counters;
}
