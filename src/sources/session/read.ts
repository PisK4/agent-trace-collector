/**
 * JSONL 会话流的发现与读取：Claude Code、Codex、OMP、Pi 共用。
 *
 * 发现只做目录遍历与 stat，不读正文；单轮 remaining 用文件大小与游标估算，
 * 大小与游标记录的 seenSize 不一致时按「整份重读」计，截断与原地重写才能被
 * 选中。读取本身复用追加文件的 readBatch。
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readBatch } from '../files';
import type { SourceCursor, SourceRead } from '../files';
import type { SessionCursorLookup, SessionFile, SessionKind } from './types';

const SKIP = /(^\.)|(\.lock(\.os|\.tmp)?$)|(\.tmp$)|(\.swp$)/;

export function discoverJsonl(root: string, cursorFor: SessionCursorLookup, maxDepth = 5): SessionFile[] {
  const base = resolve(root);
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
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
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
      const remaining = cursor === null
        ? size
        : cursor.seenSize === size
          ? Math.max(0, size - cursor.committedOff)
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

export function jsonlBatch(): { maxFiles: number; maxBytes: number } {
  return JSONL_BATCH;
}