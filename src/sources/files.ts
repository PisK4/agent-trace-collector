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

export type RouteFile = {
  name: string;
  fingerprint: string;
  lines: string[];
  kind: 'jsonl' | 'gz';
  error: string | null;
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

export async function readRouteFiles(dir: string): Promise<RouteFile[]> {
  const names = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
    .sort();
  const files: RouteFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const compressed = name.endsWith('.gz');
      const bytes = readFileSync(path);
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      let text: string;
      if (compressed) {
        text = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8');
      } else {
        text = bytes.toString('utf8');
      }
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      files.push({ name, fingerprint, lines, kind: compressed ? 'gz' : 'jsonl', error: null });
    } catch {
      let fingerprint = '';
      try {
        fingerprint = createHash('sha256').update(readFileSync(path)).digest('hex');
      } catch {
        // The file may have vanished between readdir and read.
      }
      files.push({
        name,
        fingerprint,
        lines: [],
        kind: name.endsWith('.gz') ? 'gz' : 'jsonl',
        error: 'route_file_unreadable',
      });
    }
  }
  return files;
}
