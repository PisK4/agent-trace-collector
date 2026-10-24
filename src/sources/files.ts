import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { basename, join } from 'node:path';

/** 来源在库里的标识：账本、可追加的当日路由文件、封口的 gz 路由文件。 */
export type SourceKind = 'ledger' | 'route_file' | 'route_gz';

/** 文件形态：可以按偏移续读的追加流，或整份替换、只能按指纹识别的封口文件。 */
export type SourceMode = 'appendable' | 'sealed';

export type SourceState = 'decoded' | 'unchanged' | 'error';

/**
 * 一个来源的游标。
 *
 * 两种文件形态共用这个形状。可追加文件用 generation、committedOff 与冻结的
 * 头部基线定位；封口 gz 用 fingerprint 识别，偏移字段只记录解压后的长度，
 * 不参与定位。字段平铺在 {@link SourceRead} 上，读出的对象可以直接交回读取器。
 */
export type SourceCursor = {
  sourceKind: SourceKind;
  name: string;
  generation: string;
  rewriteEpoch: number;
  committedOff: number;
  observedOff: number;
  seenSize: number;
  headLen: number;
  headHash: string | null;
  fingerprint: string | null;
};

export type SourceIssue = { offset: number; end: number; reason: 'line_too_large' };

/**
 * 一行完整内容。
 *
 * 可追加文件的 offset 是文件字节位置，也是物理记录身份的一部分；封口 gz 的
 * offset 是解压后文本里的位置，只用于批次内定位，不写进物理身份。
 */
export type SourceLine = { offset: number; end: number; text: string };

/**
 * 一次读取的结果。游标字段与行、坏行平铺在一起，读取结果本身就是下一轮的游标。
 *
 * `unchanged` 与 `error` 也返回完整的来源标识，调用方据此决定是否落库；只有
 * `decoded` 才能交给摄入入口。
 */
export type SourceRead = SourceCursor & {
  mode: SourceMode;
  state: SourceState;
  lines: SourceLine[];
  issues: SourceIssue[];
  /** 本批从哪个字节开始读；坏行引用键用它把同一文件的不同批次分开。 */
  startOff: number;
  error: string | null;
};

/** 旧摄入入口使用的账本批次形状；SourceRead 与测试构造的批次都满足它。 */
export type FileBatch = Pick<SourceRead,
  'generation' | 'rewriteEpoch' | 'lines' | 'committedOff' | 'observedOff' |
  'seenSize' | 'headLen' | 'headHash' | 'issues'>;

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

/**
 * 读一个可追加文件的一批完整行。
 *
 * 半行不前移，代际按 dev + inode + birthtime 判定，原地重写与截断都从偏移 0
 * 重读。source 显式固定库内来源身份；省略时按游标或路径推断。
 */
export async function readBatch(
  path: string,
  cursor: SourceCursor | null,
  source: { kind: 'ledger' | 'route_file'; name: string } = {
    kind: cursor?.sourceKind === 'route_file' ? 'route_file' : 'ledger',
    name: cursor?.name ?? basename(path),
  },
): Promise<SourceRead> {
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
    const lines: SourceLine[] = [];
    const issues: SourceIssue[] = [];

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
      sourceKind: source.kind,
      name: source.name,
      mode: 'appendable',
      state: 'decoded',
      generation: `${base}:${epoch}`,
      rewriteEpoch: epoch,
      committedOff,
      observedOff,
      seenSize: size,
      headLen,
      headHash,
      fingerprint: null,
      lines,
      issues,
      startOff: start,
      error: null,
    };
  } finally {
    closeSync(fd);
  }
}

/** 解压后的文本切成完整行，并算出已提交的解压字节数。 */
function sealedLines(text: string): { lines: SourceLine[]; committedOff: number } {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  let offset = 0;
  const lines = parts.map(line => {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    return { offset: start, end: offset, text: line };
  });
  return { lines, committedOff: offset };
}

/** 封口来源的读取结果：身份是整份指纹，偏移只记解压后长度。 */
function sealedRead(
  name: string,
  state: SourceState,
  fingerprint: string,
  seenSize: number,
  committedOff: number,
  lines: SourceLine[],
  error: string | null,
): SourceRead {
  return {
    sourceKind: 'route_gz',
    name,
    mode: 'sealed',
    state,
    generation: fingerprint,
    rewriteEpoch: 0,
    committedOff,
    observedOff: committedOff,
    seenSize,
    headLen: 0,
    headHash: null,
    fingerprint,
    lines,
    issues: [],
    startOff: 0,
    error,
  };
}

/** 读取失败的来源。指纹可能已经算出；只有 decoded 才能进摄入。 */
function failedRead(kind: 'route_file' | 'route_gz', name: string, error: string): SourceRead {
  return {
    sourceKind: kind,
    name,
    mode: kind === 'route_gz' ? 'sealed' : 'appendable',
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
 * 读一个目录里所有路由来源。
 *
 * 当日 `.jsonl` 走可追加读取器；`.gz` 按整份字节的 SHA-256 判未变，变了整份
 * 解压重读。两种形态返回同一个 SourceRead，游标字段直接来自读取结果。
 */
export async function readRouteFiles(
  dir: string,
  cursors: Map<string, SourceCursor> = new Map(),
): Promise<SourceRead[]> {
  const names = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
    .sort();
  const files: SourceRead[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith('.gz')) {
      let bytes: Buffer;
      try {
        if (!statSync(path).isFile()) continue;
        bytes = readFileSync(path);
      } catch {
        files.push(failedRead('route_gz', name, 'route_file_unreadable'));
        continue;
      }
      // 指纹先于解压：同一份字节只解一次，替换检测也以这次读取的快照为准。
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      const previous = cursors.get(name);
      if (previous !== undefined && previous.sourceKind === 'route_gz'
        && previous.fingerprint === fingerprint) {
        files.push(sealedRead(name, 'unchanged', fingerprint, bytes.length,
          previous.committedOff, [], null));
        continue;
      }
      let text: string;
      try {
        text = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8');
      } catch (error) {
        // 读取成功但解压失败：指纹照留，调用方据此不推进 cursor，下一轮同指纹重试。
        const code = (error as NodeJS.ErrnoException).code;
        files.push(sealedRead(name, 'error', fingerprint, bytes.length, 0, [],
          code === 'ERR_BUFFER_TOO_LARGE' ? 'route_gzip_limit' : 'route_gzip_invalid'));
        continue;
      }
      const decoded = sealedLines(text);
      files.push(sealedRead(name, 'decoded', fingerprint, bytes.length,
        decoded.committedOff, decoded.lines, null));
      continue;
    }

    // 当日文件持续追加：走账本同一套行读取器，只消费已经写完的完整行。
    const previous = cursors.get(name) ?? null;
    let read: SourceRead;
    try {
      if (!statSync(path).isFile()) continue;
      read = await readBatch(path, previous, { kind: 'route_file', name });
    } catch {
      files.push(failedRead('route_file', name, 'route_file_unreadable'));
      continue;
    }
    files.push(read.lines.length === 0 && read.issues.length === 0
      ? { ...read, state: 'unchanged' }
      : read);
  }
  return files;
}
