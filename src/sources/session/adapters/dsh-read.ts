/**
 * DSH 会话流的发现与读取。
 *
 * DSH 把一次会话放进 `<DSH_HOME>/sessions/<project>/<session>/`，文件名是
 * `session[.vN].jsonl[.zstd]`；同一目录只读版本最高、同版本最后写入的一份。
 * `.zstd` 是追加式 zstd frame 序列，一个 frame 是一批整行。压缩文件无法用
 * 解压后字节定位，所以读取按 frame 边界提交，行偏移用 `frame 起点 * stride +
 * 行号` 编码——原始层只需要稳定、可排序的行身份，不需要真实的解压偏移。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { SourceCursor, SourceLine, SourceRead } from '../../files';
import type { SessionCursorLookup, SessionFile, SessionKind } from '../types';

const DSH_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
const READ_BYTES = 2 * 1024 * 1024;
const READ_FRAMES = 256;
const HEAD_LIMIT = 64 * 1024;
const FRAME_LIMIT = 256 * 1024 * 1024;
/** 一行的合成偏移 = frame 起点 * STRIDE + 行号；stride 远大于单 frame 行数。 */
const LINE_STRIDE = 1_000_000;

type StatLike = {
  dev: bigint;
  ino: bigint;
  birthtimeMs: number | bigint;
  birthtimeNs?: bigint;
};

function identityOf(stat: StatLike): string {
  const birth = typeof stat.birthtimeNs === 'bigint'
    ? stat.birthtimeNs
    : BigInt(Math.round(Number(stat.birthtimeMs) * 1_000_000));
  return `${stat.dev}:${stat.ino}:${birth}`;
}

function hashPrefix(buf: Buffer, length: number): string {
  return createHash('sha256')
    .update(buf.subarray(0, Math.min(buf.length, length)))
    .digest('hex');
}

function headHash(buf: Buffer): string {
  return hashPrefix(buf, HEAD_LIMIT);
}

/**
 * 读 DSH 会话目录。
 *
 * 只 stat 与读目录；一代会话可能同时留有 `.jsonl` 与 `.jsonl.zstd`，取版本
 * 最高的一份，同版本取 mtime 更新的一份。
 */
export function discoverDsh(root: string, cursorFor: SessionCursorLookup): SessionFile[] {
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let sessions;
    try {
      sessions = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(projectPath, session.name);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let chosen: { path: string; size: number; mtimeMs: number; version: number } | null = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = DSH_NAME.exec(entry.name);
        if (match === null) continue;
        const path = join(dir, entry.name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const version = Number(match[1] ?? 0);
        if (chosen === null || version > chosen.version
          || (version === chosen.version && stat.mtimeMs > chosen.mtimeMs)) {
          chosen = { path, size: stat.size, mtimeMs: stat.mtimeMs, version };
        }
      }
      if (chosen === null) continue;
      const cursor = cursorFor(chosen.path);
      // 大小变化可能只是追加；remaining 只用于挑选，实际读取从游标继续。
      const remaining = cursor === null
        ? chosen.size
        : cursor.seenSize === chosen.size
          ? Math.max(0, chosen.size - cursor.committedOff)
          : chosen.size;
      files.push({
        name: chosen.path,
        path: chosen.path,
        size: chosen.size,
        mtimeMs: chosen.mtimeMs,
        remaining,
      });
    }
  }
  return files;
}

/**
 * 一个 zstd frame 的长度；0 表示文件还没写完这个 frame，-1 表示不是合法 frame。
 *
 * 只读 frame 头与 block 头，不解压。skippable frame 一并返回长度，调用方跳过。
 */
function frameLength(buf: Buffer, off: number): number {
  if (off + 4 > buf.length) return 0;
  const magic = buf.readUInt32LE(off);
  if ((magic & 0xFFFFFFF0) === 0x184D2A50) {
    if (off + 8 > buf.length) return 0;
    const length = 8 + buf.readUInt32LE(off + 4);
    return off + length <= buf.length ? length : 0;
  }
  if (magic !== 0xFD2FB528) return -1;
  if (off + 5 > buf.length) return 0;
  const descriptor = buf[off + 4]!;
  const single = (descriptor >> 5) & 1;
  let at = off + 5;
  if (single === 0) at += 1; // window descriptor
  at += [0, 1, 2, 4][descriptor & 3]!;
  const sizeFlag = descriptor >> 6;
  at += sizeFlag === 0 ? (single === 1 ? 1 : 0)
    : sizeFlag === 1 ? 2 : sizeFlag === 2 ? 4 : 8;
  if (at > buf.length) return 0;
  for (;;) {
    if (at + 3 > buf.length) return 0;
    const header = buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16);
    at += 3;
    const type = (header >> 1) & 3;
    if (type === 3) return -1;
    const size = type === 1 ? 1 : header >> 3;
    if (at + size > buf.length) return 0;
    at += size;
    if ((header & 1) === 1) break;
  }
  if (((descriptor >> 2) & 1) === 1) {
    if (at + 4 > buf.length) return 0;
    at += 4;
  }
  return at - off;
}

function readError(kind: SessionKind, name: string, error: string): SourceRead {
  return {
    sourceKind: kind,
    name,
    mode: 'sealed',
    state: 'error',
    generation: '',
    rewriteEpoch: 0,
    committedOff: 0,
    observedOff: 0,
    seenSize: 0,
    headLen: 0,
    headHash: null,
    fingerprint: null,
    lines: [],
    issues: [],
    startOff: 0,
    error,
  };
}

/**
 * 读 `.jsonl.zstd` 的一批完整 frame。
 *
 * `committed_off` 是最后一个完整 frame 之后的压缩偏移；只有整段文本以换行结尾
 * 的 frame 才能提交，跨 frame 的半行留到下一轮。`observed_off` 是压缩文件长度，
 * 供引擎算剩余。
 */
export function dshZstdRead(
  file: SessionFile,
  cursor: SourceCursor | null,
  kind: SessionKind,
): SourceRead {
  let buf: Buffer;
  let stat;
  try {
    buf = readFileSync(file.path);
    stat = statSync(file.path, { bigint: true });
  } catch {
    return readError(kind, file.name, 'dsh_source_unreadable');
  }
  const size = buf.length;
  const identity = identityOf(stat);
  let headLen = Math.min(size, HEAD_LIMIT);
  let head = headHash(buf);
  let epoch = 0;
  let start = 0;
  if (cursor !== null && cursor.generation === `${identity}:${cursor.rewriteEpoch}`) {
    epoch = cursor.rewriteEpoch;
    start = cursor.committedOff;
    if (cursor.headLen > 0) {
      const prior = hashPrefix(buf, cursor.headLen);
      if (size < start || prior !== cursor.headHash) {
        epoch += 1;
        start = 0;
      } else {
        headLen = cursor.headLen;
        head = prior;
      }
    } else if (size < start) {
      epoch += 1;
      start = 0;
    }
  }
  const base = {
    sourceKind: kind,
    name: file.name,
    mode: 'sealed' as const,
    generation: `${identity}:${epoch}`,
    rewriteEpoch: epoch,
    observedOff: size,
    seenSize: size,
    headLen,
    headHash: head,
    fingerprint: null,
    issues: [],
    startOff: start,
  };
  if (start >= size) {
    return { ...base, state: 'unchanged', committedOff: start, lines: [], error: null };
  }

  let at = start;
  let frames = 0;
  let decoded = 0;
  let committed = start;
  let pending = '';
  let pendingStart = start;
  const chunks: { text: string; frameStart: number }[] = [];
  while (at < size && frames < READ_FRAMES && decoded < READ_BYTES) {
    const length = frameLength(buf, at);
    if (length === 0) break;
    if (length < 0) {
      // 已读完整的 frame 先提交；坏 frame 留在下一轮从它开始报 issue。
      if (committed > start) break;
      return { ...base, state: 'error', committedOff: start, lines: [], error: 'dsh_zstd_invalid' };
    }
    frames += 1;
    if ((buf.readUInt32LE(at) & 0xFFFFFFF0) !== 0x184D2A50) {
      let text: string;
      try {
        text = zstdDecompressSync(buf.subarray(at, at + length), { maxOutputLength: FRAME_LIMIT })
          .toString('utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (committed > start) break;
        return {
          ...base, state: 'error', committedOff: start, lines: [],
          error: code === 'ERR_BUFFER_TOO_LARGE' ? 'dsh_zstd_limit' : 'dsh_zstd_invalid',
        };
      }
      decoded += Buffer.byteLength(text);
      pending += text;
      if (pending.endsWith('\n')) {
        committed = at + length;
        chunks.push({ text: pending, frameStart: pendingStart });
        pending = '';
        pendingStart = at + length;
      }
    } else if (pending.length === 0) {
      // skippable frame 不含行；前一段行完整时可以越过。
      committed = at + length;
      pendingStart = at + length;
    }
    at += length;
  }

  const lines: SourceLine[] = [];
  let index = 0;
  for (const chunk of chunks) {
    const parts = chunk.text.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    for (const text of parts) {
      if (text.trim() === '') continue;
      const offset = start * LINE_STRIDE + index;
      // offset 只是原始层身份；坏行重读回到它所在 frame 的起点。
      lines.push({
        offset, end: offset + Buffer.byteLength(text) + 1, text, restartOff: chunk.frameStart,
      });
      index += 1;
    }
  }
  return {
    ...base,
    state: committed === start ? 'unchanged' : 'decoded',
    committedOff: committed,
    lines,
    error: null,
  };
}
