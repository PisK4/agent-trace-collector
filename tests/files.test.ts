import { expect, test } from 'bun:test';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBatch, readRouteFiles } from '../src/sources/files';

test('追加不换代，末尾半行不提交', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":');
    const a = await readBatch(path, null);
    expect(a.lines.map(x => x.text)).toEqual(['{"n":1}']);
    expect(a.committedOff).toBe(Buffer.byteLength('{"n":1}\n'));
    expect(a.observedOff).toBe(Buffer.byteLength('{"n":1}\n{"n":'));
    expect(a.observedOff).toBeGreaterThan(a.committedOff);
    appendFileSync(path, '2}\n');
    const b = await readBatch(path, a);
    expect(b.generation).toBe(a.generation);
    expect(b.lines.map(x => x.text)).toEqual(['{"n":2}']);
  } finally {
    f.close();
  }
});

test('空文件到首行再增长保持同一代且冻结头部基线', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    writeFileSync(path, '');
    const empty = await readBatch(path, null);
    expect(empty.lines).toEqual([]);
    expect(empty.headLen).toBe(0);

    appendFileSync(path, '{"n":1}\n');
    const first = await readBatch(path, empty);
    expect(first.generation).toBe(empty.generation);
    expect(first.lines.map(x => x.text)).toEqual(['{"n":1}']);
    expect(first.headLen).toBe(first.seenSize);

    appendFileSync(path, `${'x'.repeat(70 * 1024)}\n`);
    const grown = await readBatch(path, first);
    expect(grown.generation).toBe(first.generation);
    expect(grown.lines.length).toBe(1);
    expect(grown.headLen).toBe(first.headLen);
  } finally {
    f.close();
  }
});

test('同 inode 原地重写产生新代际并重读', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    writeFileSync(path, '{"id":7,"time":1}\n');
    const a = await readBatch(path, null);
    expect(a.rewriteEpoch).toBe(0);
    writeFileSync(path, '{"id":8,"time":1}\n');
    const b = await readBatch(path, a);
    expect(b.generation).not.toBe(a.generation);
    expect(b.rewriteEpoch).toBe(1);
    expect(b.lines.map(x => x.text)).toEqual(['{"id":8,"time":1}']);
  } finally {
    f.close();
  }
});

test('截断到已提交偏移之前换代并从头读', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    const first = '{"id":7,"time":1}\n';
    const late = '{"id":8,"time":2}\n';
    writeFileSync(path, first + late);
    const a = await readBatch(path, null);
    expect(a.lines.length).toBe(2);
    writeFileSync(path, first);
    const b = await readBatch(path, a);
    expect(b.rewriteEpoch).toBe(a.rewriteEpoch + 1);
    expect(b.generation).not.toBe(a.generation);
    expect(b.lines.map(x => x.text)).toEqual(['{"id":7,"time":1}']);
    expect(b.committedOff).toBe(Buffer.byteLength(first));
  } finally {
    f.close();
  }
});

test('CRLF行去掉尾部回车后解码', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'usage.jsonl');
    writeFileSync(path, '{"n":1}\r\n');
    const batch = await readBatch(path, null);
    expect(batch.lines.map(x => x.text)).toEqual(['{"n":1}']);
  } finally {
    f.close();
  }
});

function routeIds(files: Awaited<ReturnType<typeof readRouteFiles>>): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const file of files) {
    for (const line of file.lines) {
      const record = JSON.parse(line) as { id: number };
      if (!seen.has(record.id)) {
        seen.add(record.id);
        ids.push(record.id);
      }
    }
  }
  return ids.sort((a, b) => a - b);
}

test('路由跨日与gzip替换后证据集合一致', async () => {
  const f = fixture();
  try {
    const dir = f.dir;
    const first = '{"id":7,"time":1}\n';
    const late = '{"id":8,"time":2}\n';
    const jsonl = join(dir, '2026-10-19.jsonl');
    const gz = join(dir, '2026-10-19.jsonl.gz');
    writeFileSync(jsonl, first + late);
    writeFileSync(gz, gzipSync(first));
    expect(routeIds(await readRouteFiles(dir))).toEqual([7, 8]);

    rmSync(jsonl);
    writeFileSync(gz, gzipSync(first + late));
    expect(routeIds(await readRouteFiles(dir))).toEqual([7, 8]);

    writeFileSync(jsonl, '{"id":9,"time":3}\n');
    expect(routeIds(await readRouteFiles(dir))).toEqual([7, 8, 9]);
  } finally {
    f.close();
  }
});

test('损坏的gzip保留文件身份并给出错误', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, '2026-10-18.jsonl.gz');
    writeFileSync(path, Buffer.from('not a gzip member'));
    const files = await readRouteFiles(f.dir);
    expect(files.length).toBe(1);
    expect(files[0]!.name).toBe('2026-10-18.jsonl.gz');
    expect(files[0]!.error).toBe('route_file_unreadable');
    expect(files[0]!.fingerprint.length).toBe(64);
  } finally {
    f.close();
  }
});
