import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export type FileCursor = {
  generation: string;
  rewriteEpoch: number;
  committedOff: number;
  seenSize: number;
  headLen: number;
  headHash: string | null;
};

export type FileIssue = { offset: number; end: number; reason: 'line_too_large' };

export type FileBatch = {
  generation: string;
  lines: { offset: number; end: number; text: string }[];
  committedOff: number;
  observedOff: number;
  seenSize: number;
  headLen: number;
  headHash: string | null;
  rewriteEpoch: number;
  issues: FileIssue[];
};

/** 路由文件的三态：读到新内容、没有新内容、读取或解压失败。 */
export type RouteState = 'decoded' | 'unchanged' | 'error';

/**
 * 一个路由来源的游标。
 *
 * `.jsonl` 用文件身份 + 已提交偏移 + 冻结的头部基线增量读取；`.gz` 用整份
 * 字节的 `fingerprint` 识别，偏移对它没有意义。
 */
export type RouteCursor = {
  sourceKind: 'route_file' | 'route_gz';
  generation: string;
  committedOff: number;
  observedOff: number;
  seenSize: number;
  headLen: number;
  headHash: string | null;
  rewriteEpoch: number;
  fingerprint: string | null;
};

export type RouteFile = {
  name: string;
  fingerprint: string;
  kind: 'jsonl' | 'gz';
  state: RouteState;
  lines: string[];
  error: string | null;
  /** 本轮要写回的游标；`unchanged` 与 `error` 为 null。 */
  cursor: RouteCursor | null;
  /** 本批行在文件中的起始字节，用于让坏行引用键跨批次唯一。 */
  startOff: number;
  issues: FileIssue[];
};

const MAX_LINES = 128;
const BATCH_BYTES = 8 * 1024 * 1024;
const LINE_LIMIT = 64 * 1024 * 1024;
const HEAD_LIMIT = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function hashHead(fd: number, length: number): string {
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(fd, buffer, 0, length, 0);
  return createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
}

function fileIdentity(stat: ReturnType<typeof fstatSync> & { dev: bigint; ino: bigint }): string {
  const birthtimeNs = 'birthtimeNs' in stat && typeof stat.birthtimeNs === 'bigint'
    ? stat.birthtimeNs
    : BigInt(Math.round(Number((stat as { birthtimeMs: number }).birthtimeMs) * 1_000_000));
  return `${stat.dev}:${stat.ino}:${birthtimeNs}`;
}

export async function readBatch(path: string, cursor: FileCursor | null): Promise<FileBatch> {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const size = Number(stat.size);
    const base = fileIdentity(stat);

    let epoch = 0;
    let start = 0;
    let headLen = 0;
    let headHash: string | null = null;

    const sameBase = cursor !== null && cursor.generation === `${base}:${cursor.rewriteEpoch}`;
    if (cursor !== null && sameBase) {
      epoch = cursor.rewriteEpoch;
      start = cursor.committedOff;
      headLen = cursor.headLen;
      headHash = cursor.headHash;
      if (size < cursor.committedOff) {
        epoch += 1;
        start = 0;
        headLen = 0;
        headHash = null;
      } else if (headLen > 0) {
        const current = hashHead(fd, Math.min(headLen, size));
        if (current !== headHash) {
          epoch += 1;
          start = 0;
          headLen = 0;
          headHash = null;
        }
      }
    }

    let pos = start;
    let observedOff = start;
    let lineStart = start;
    let completeBytes = 0;
    let current: Buffer[] = [];
    let currentLen = 0;
    let discarding = false;
    const lines: FileBatch['lines'] = [];
    const issues: FileIssue[] = [];

    while (pos < size) {
      const want = Math.min(CHUNK_BYTES, size - pos);
      const chunk = Buffer.allocUnsafe(want);
      const read = readSync(fd, chunk, 0, want, pos);
      if (read <= 0) break;
      const chunkStart = pos;
      pos += read;
      observedOff = pos;

      let index = 0;
      while (index < read) {
        const newline = chunk.indexOf(0x0a, index);
        const segmentEnd = newline === -1 ? read : newline;
        const segmentLen = segmentEnd - index;
        if (!discarding) {
          if (currentLen + segmentLen > LINE_LIMIT) {
            discarding = true;
            current = [];
            currentLen = LINE_LIMIT + 1;
          } else {
            current.push(chunk.subarray(index, segmentEnd));
            currentLen += segmentLen;
          }
        }
        if (newline === -1) break;

        const lineEnd = chunkStart + newline + 1;
        if (discarding) {
          issues.push({ offset: lineStart, end: lineEnd, reason: 'line_too_large' });
        } else {
          let bytes = current.length === 1 ? current[0]! : Buffer.concat(current, currentLen);
          if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          lines.push({ offset: lineStart, end: lineEnd, text: bytes.toString('utf8') });
        }
        completeBytes = lineEnd - start;
        lineStart = lineEnd;
        current = [];
        currentLen = 0;
        discarding = false;
        index = newline + 1;

        if (lines.length >= MAX_LINES || completeBytes >= BATCH_BYTES) {
          pos = size;
          break;
        }
      }
    }

    const committedOff = start + completeBytes;
    if (headLen === 0 && size > 0 && completeBytes > 0) {
      headLen = Math.min(size, HEAD_LIMIT);
      headHash = hashHead(fd, headLen);
    }

    return {
      generation: `${base}:${epoch}`,
      lines,
      committedOff,
      observedOff,
      seenSize: size,
      headLen,
      headHash,
      rewriteEpoch: epoch,
      issues,
    };
  } finally {
    closeSync(fd);
  }
}

function fileCursorOf(cursor: RouteCursor | undefined): FileCursor | null {
  if (cursor === undefined || cursor.sourceKind !== 'route_file') return null;
  return {
    generation: cursor.generation,
    rewriteEpoch: cursor.rewriteEpoch,
    committedOff: cursor.committedOff,
    seenSize: cursor.seenSize,
    headLen: cursor.headLen,
    headHash: cursor.headHash,
  };
}

function routeCursorOf(batch: FileBatch): RouteCursor {
  return {
    sourceKind: 'route_file',
    generation: batch.generation,
    committedOff: batch.committedOff,
    observedOff: batch.observedOff,
    seenSize: batch.seenSize,
    headLen: batch.headLen,
    headHash: batch.headHash,
    rewriteEpoch: batch.rewriteEpoch,
    fingerprint: null,
  };
}

export async function readRouteFiles(
  dir: string,
  cursors: Map<string, RouteCursor> = new Map(),
): Promise<RouteFile[]> {
  const names = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
    .sort();
  const files: RouteFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const kind = name.endsWith('.gz') ? 'gz' as const : 'jsonl' as const;
    if (kind === 'jsonl') {
      // 当日文件持续追加：走账本同一套行读取器，只消费已经写完的完整行。
      const previous = fileCursorOf(cursors.get(name));
      let batch: FileBatch;
      try {
        if (!statSync(path).isFile()) continue;
        batch = await readBatch(path, previous);
      } catch {
        files.push({
          name, fingerprint: '', kind, state: 'error', lines: [], error: 'route_file_unreadable',
          cursor: null, startOff: 0, issues: [],
        });
        continue;
      }
      const startOff = previous !== null && batch.generation === previous.generation
        ? previous.committedOff
        : 0;
      if (batch.lines.length === 0 && batch.issues.length === 0) {
        files.push({
          name, fingerprint: '', kind, state: 'unchanged', lines: [], error: null,
          cursor: null, startOff, issues: [],
        });
        continue;
      }
      files.push({
        name, fingerprint: '', kind, state: 'decoded',
        lines: batch.lines.map(line => line.text), error: null,
        cursor: routeCursorOf(batch), startOff, issues: batch.issues,
      });
      continue;
    }
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) continue;
      bytes = readFileSync(path);
    } catch {
      files.push({
        name, fingerprint: '', kind, state: 'error', lines: [], error: 'route_file_unreadable',
        cursor: null, startOff: 0, issues: [],
      });
      continue;
    }
    // 指纹先于解压：同一份字节只解一次，替换检测也以这次读取的快照为准。
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const previous = cursors.get(name);
    if (previous !== undefined && previous.sourceKind === 'route_gz'
      && previous.fingerprint === fingerprint) {
      files.push({
        name, fingerprint, kind, state: 'unchanged', lines: [], error: null,
        cursor: null, startOff: 0, issues: [],
      });
      continue;
    }
    let text: string;
    try {
      text = kind === 'gz'
        ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')
        : bytes.toString('utf8');
    } catch (error) {
      // 读取成功但解压失败：指纹照留，调用方据此不推进 cursor，下一轮同指纹重试。
      const code = (error as NodeJS.ErrnoException).code;
      files.push({
        name, fingerprint, kind, state: 'error', lines: [], error:
          code === 'ERR_BUFFER_TOO_LARGE' ? 'route_gzip_limit' : 'route_gzip_invalid',
        cursor: null, startOff: 0, issues: [],
      });
      continue;
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const committed = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    files.push({
      name, fingerprint, kind, state: 'decoded', lines, error: null,
      cursor: {
        sourceKind: 'route_gz', generation: fingerprint, committedOff: committed,
        observedOff: committed, seenSize: bytes.length, headLen: 0, headHash: null,
        rewriteEpoch: 0, fingerprint,
      },
      startOff: 0, issues: [],
    });
  }
  return files;
}
