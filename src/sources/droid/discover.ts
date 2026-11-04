/**
 * Droid 会话文件的发现与单轮取件。
 *
 * 根目录取 `$FACTORY_HOME_OVERRIDE/.factory/sessions`，否则 `~/.factory/sessions`
 * （与 magpie 的 FactoryDir 一致）。只认根目录与一层子目录里的 `.jsonl`；
 * `.settings.json` 不是转录，不在这里发现。单轮按剩余字节从大到小取，
 * 最多 64 个文件或 8 MiB，未读完的文件靠游标在下一轮继续。
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DROID_BATCH_FILES = 64;
export const DROID_BATCH_BYTES = 8 * 1024 * 1024;

export type DroidTranscript = {
  /** 库内来源名：相对 sessions 根的路径，如 `<id>.jsonl` 或 `<cwd>/<id>.jsonl`。 */
  name: string;
  path: string;
  dir: string;
  size: number;
  /** 文件修改时间；共用取件排序用，合成测试可省略。 */
  mtimeMs?: number;
};

export type DroidCursor = { generation: string; committedOff: number } | null;
export type DroidCursorLookup = (name: string) => DroidCursor;

export function droidSessionsRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const override = env.FACTORY_HOME_OVERRIDE?.trim();
  return override !== undefined && override.length > 0
    ? join(override, '.factory', 'sessions')
    : join(home, '.factory', 'sessions');
}

function filesIn(dir: string, prefix: string): DroidTranscript[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: DroidTranscript[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(dir, entry.name);
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    files.push({ name: `${prefix}${entry.name}`, path, dir, size, mtimeMs });
  }
  return files;
}

/** 根目录的直接 `.jsonl` 与一层子目录（按工作目录分目录）里的 `.jsonl`。 */
export function discoverDroidTranscripts(root: string): DroidTranscript[] {
  const files = filesIn(root, '');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(...filesIn(join(root, entry.name), `${entry.name}/`));
  }
  return files;
}

/**
 * 单轮取件：剩余字节大的先读；没有新增字节的文件本轮不取，等它再增长后
 * 由 readBatch 按代际与冻结头部基线识别截断或重写。一个文件即使超过剩余
 * 预算也会被选中，本轮由 readBatch 的 8 MiB 上限截断。
 */
export function selectDroidTranscripts(
  files: readonly DroidTranscript[],
  cursorFor: DroidCursorLookup,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): DroidTranscript[] {
  const maxFiles = limits.maxFiles ?? DROID_BATCH_FILES;
  const maxBytes = limits.maxBytes ?? DROID_BATCH_BYTES;
  const remaining = (file: DroidTranscript): number => {
    const cursor = cursorFor(file.name);
    return cursor === null ? file.size : Math.max(0, file.size - cursor.committedOff);
  };
  const ordered = [...files]
    .map(file => ({ file, remaining: remaining(file) }))
    .filter(item => item.remaining > 0)
    .sort((left, right) => right.remaining - left.remaining || left.file.name.localeCompare(right.file.name));
  const selected: DroidTranscript[] = [];
  let bytes = 0;
  for (const item of ordered) {
    if (selected.length >= maxFiles || bytes >= maxBytes) break;
    selected.push(item.file);
    bytes += Math.min(item.remaining, maxBytes);
  }
  return selected;
}