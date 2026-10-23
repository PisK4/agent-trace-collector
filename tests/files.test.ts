import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
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

test('未变gzip不再解压，追加与替换仍被检出', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const name = '2026-10-22.jsonl.gz';
    const path = join(dir, name);
    const first = gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T00:00:00Z"}\n'));
    writeFileSync(path, first);
    const digest = createHash('sha256').update(first).digest('hex');

    const decoded = await readRouteFiles(dir);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ name, state: 'decoded', error: null });
    expect(decoded[0]!.lines).toHaveLength(1);

    const unchanged = await readRouteFiles(dir, (fileName, fingerprint) =>
      fileName === name && fingerprint === digest);
    expect(unchanged[0]).toMatchObject({ name, state: 'unchanged', error: null });
    expect(unchanged[0]!.lines).toEqual([]);

    const appended = Buffer.concat([gunzipSync(first), Buffer.from('{"id":2,"time":"2026-10-22T00:01:00Z"}\n')]);
    const replaced = gzipSync(appended);
    writeFileSync(path, replaced);
    const changed = await readRouteFiles(dir, (fileName, fingerprint) =>
      fileName === name && fingerprint === digest);
    expect(changed[0]).toMatchObject({ name, state: 'decoded', error: null });
    expect(changed[0]!.lines).toHaveLength(2);
  } finally { f.close(); }
});

test('损坏gzip保留指纹并报告固定错误，替换后恢复', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-10-22.jsonl.gz');
    writeFileSync(path, Buffer.from('not a gzip stream'));
    const broken = await readRouteFiles(dir);
    expect(broken[0]).toMatchObject({ state: 'error', error: 'route_gzip_invalid' });
    expect(broken[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fixed = gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T00:00:00Z"}\n'));
    writeFileSync(path, fixed);
    const recovered = await readRouteFiles(dir, () => false);
    expect(recovered[0]).toMatchObject({ state: 'decoded', error: null });
  } finally { f.close(); }
});

test('跨午夜只解压新增日期文件', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const day1 = '2026-10-22.jsonl.gz';
    const day2 = '2026-10-23.jsonl.gz';
    writeFileSync(join(dir, day1), gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T23:59:00Z"}\n')));
    const known = new Map<string, string>();
    for (const file of await readRouteFiles(dir)) known.set(file.name, file.fingerprint);
    writeFileSync(join(dir, day2), gzipSync(Buffer.from('{"id":2,"time":"2026-10-23T00:00:00Z"}\n')));
    const files = await readRouteFiles(dir, (name, fingerprint) => known.get(name) === fingerprint);
    expect(files.map(file => [file.name, file.state])).toEqual([
      [day1, 'unchanged'],
      [day2, 'decoded'],
    ]);
  } finally { f.close(); }
});

test('损坏的gzip保留文件身份并按解压失败归类', async () => {
  const f = fixture();
  try {
    const path = join(f.dir, '2026-10-18.jsonl.gz');
    writeFileSync(path, Buffer.from('not a gzip member'));
    const files = await readRouteFiles(f.dir);
    expect(files.length).toBe(1);
    expect(files[0]!.name).toBe('2026-10-18.jsonl.gz');
    expect(files[0]!.state).toBe('error');
    expect(files[0]!.error).toBe('route_gzip_invalid');
    expect(files[0]!.fingerprint.length).toBe(64);
  } finally {
    f.close();
  }
});
