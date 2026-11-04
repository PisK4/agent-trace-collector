/**
 * JSONL 会话流的发现与读取：Claude Code、Codex、OMP、Pi 共用。
 *
 * 发现只做目录遍历与 stat，不读正文；单轮 remaining 用文件大小与游标估算，
 * 大小与游标记录的 seenSize 不一致时按「整份重读」计，截断与原地重写才能被
 * 选中。读取本身复用追加文件的 readBatch。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { readBatch, sealedLines } from '../files';
import type { SourceCursor, SourceRead } from '../files';
import type { SessionCursorLookup, SessionFile, SessionKind } from './types';

const SKIP = /(^\.)|(\.lock(\.os|\.tmp)?$)|(\.tmp$)|(\.swp$)/;

export type JsonlDiscovery = {
  maxDepth?: number;
  /** 默认只认 `.jsonl`；Codex 归档还要读整份压缩的 `.jsonl.zst`。 */
  extensions?: readonly string[];
};

export function discoverJsonl(root: string, cursorFor: SessionCursorLookup,
  options: JsonlDiscovery = {}): SessionFile[] {
  const base = resolve(root);
  const maxDepth = options.maxDepth ?? 5;
  const extensions = options.extensions ?? ['.jsonl'];
  let rootStat;
  try {
    rootStat = statSync(base);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];
  const files: SessionFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.some(extension => entry.name.endsWith(extension))) continue;
      let size: number;
      let mtimeMs: number;
      try {
        const stat = statSync(path);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }
      const cursor = cursorFor(path);
      const sealed = entry.name.endsWith('.jsonl.zst');
      // 封口文件按整份指纹识别；发现阶段只能先用压缩后大小判断是否值得再读。
      // shortcut: 同大小原地替换不会被发现，归档文件假定写入后不再改。
      const remaining = cursor === null
        ? size
        : cursor.seenSize === size
          ? sealed ? 0 : Math.max(0, size - cursor.committedOff)
          // 大小变了但比提交位置小（截断）或头部重写：整份重读。
          : size;
      files.push({ name: path, path, size, mtimeMs, remaining });
    }
  };
  walk(base, 0);
  return files;
}

const JSONL_BATCH = { maxFiles: 64, maxBytes: 2 * 1024 * 1024 };

export function jsonlRead(file: SessionFile, cursor: SourceCursor | null,
  kind: SessionKind): Promise<SourceRead> {
  return readBatch(file.path, cursor, { kind, name: file.name });
}

/**
 * 解压整份封口文件。调用方决定坏帧/超限如何记账。
 */
function decodeSealed(bytes: Uint8Array): string {
  return zstdDecompressSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8');
}

/**
 * 读整份封口的 `.jsonl.zst`。
 *
 * 压缩后字节的 SHA-256 就是代际；同一代际不再解压。偏移是解压后文本的字节
 * 位置，只用于批内定位与原始层身份，不参与压缩文件定位。
 */
export function sealedJsonlRead(file: SessionFile, cursor: SourceCursor | null,
  kind: SessionKind): SourceRead {
  const bytes = readFileSync(file.path);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  const base = {
    sourceKind: kind,
    name: file.name,
    mode: 'sealed' as const,
    generation: fingerprint,
    rewriteEpoch: 0,
    seenSize: bytes.length,
    headLen: 0,
    headHash: null,
    fingerprint,
    issues: [],
    startOff: 0,
  };
  if (cursor !== null && cursor.fingerprint === fingerprint) {
    return {
      ...base, state: 'unchanged', committedOff: cursor.committedOff,
      observedOff: cursor.committedOff, lines: [], error: null,
    };
  }
  let text: string;
  try {
    // shortcut: 假定一份归档是单个 zstd frame；多 frame 文件需要逐帧解压。
    text = decodeSealed(bytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...base, state: 'error', committedOff: 0, observedOff: 0, lines: [],
      error: code === 'ERR_BUFFER_TOO_LARGE' ? 'codex_zstd_limit' : 'codex_zstd_invalid',
    };
  }
  const decoded = sealedLines(text);
  return {
    ...base, state: 'decoded', committedOff: decoded.committedOff,
    observedOff: decoded.committedOff, lines: decoded.lines, error: null,
  };
}

export function jsonlBatch(): { maxFiles: number; maxBytes: number } {
  return JSONL_BATCH;
}
