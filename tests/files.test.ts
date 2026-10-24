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
      const record = JSON.parse(line.text) as { id: number };
      if (!seen.has(record.id)) {
        seen.add(record.id);
        ids.push(record.id);
      }
    }
  }
  return ids.sort((a, b) => a - b);
}

/** 已解码的读取结果本身就是下一轮的游标，直接按文件名收集。 */
function routeCursors(files: Awaited<ReturnType<typeof readRouteFiles>>) {
  return new Map(files
    .filter(file => file.state === 'decoded')
    .map(file => [file.name, file] as const));
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

test('路由jsonl只读追加的完整行并推进偏移', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const name = '2026-10-24.jsonl';
    const path = join(dir, name);
    const first = '{"id":1,"time":1}\n';
    writeFileSync(path, `${first}{"id":2,"time":`);

    const decoded = await readRouteFiles(dir);
    expect(decoded[0]).toMatchObject({ name, state: 'decoded', startOff: 0 });
    expect(decoded[0]!.lines.map(line => line.text)).toEqual(['{"id":1,"time":1}']);
    const cursors = routeCursors(decoded);
    expect(cursors.get(name)!.committedOff).toBe(Buffer.byteLength(first));

    // 半行仍未写完：不推进偏移，也不产生新行。
    const waiting = await readRouteFiles(dir, cursors);
    expect(waiting[0]).toMatchObject({ state: 'unchanged', lines: [] });

    appendFileSync(path, '2}\n');
    const appended = await readRouteFiles(dir, cursors);
    expect(appended[0]!.state).toBe('decoded');
    expect(appended[0]!.lines.map(line => line.text)).toEqual(['{"id":2,"time":2}']);
    expect(appended[0]!.startOff).toBe(Buffer.byteLength(first));
    expect(appended[0]!.committedOff)
      .toBe(Buffer.byteLength(`${first}{"id":2,"time":2}\n`));
  } finally {
    f.close();
  }
});

test('路由jsonl原地重写与截断都换代并从头读', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-10-24.jsonl');
    writeFileSync(path, '{"id":7,"time":1}\n');
    const first = await readRouteFiles(dir);

    // 同 inode 原地重写：头部基线不符，按新代际从头读。
    writeFileSync(path, '{"id":8,"time":1}\n');
    const rewritten = await readRouteFiles(dir, routeCursors(first));
    expect(rewritten[0]!.state).toBe('decoded');
    expect(rewritten[0]!.lines.map(line => line.text)).toEqual(['{"id":8,"time":1}']);
    expect(rewritten[0]!.startOff).toBe(0);

    writeFileSync(path, '{"id":8,"time":1}\n{"id":9,"time":2}\n');
    const grown = await readRouteFiles(dir, routeCursors(rewritten));
    expect(grown[0]!.lines.map(line => line.text)).toEqual(['{"id":9,"time":2}']);
    expect(grown[0]!.startOff).toBe(Buffer.byteLength('{"id":8,"time":1}\n'));

    // 截断到已提交偏移之前：偏移归零重读，不丢行。
    writeFileSync(path, '{"id":8,"time":1}\n');
    const truncated = await readRouteFiles(dir, routeCursors(grown));
    expect(truncated[0]!.state).toBe('decoded');
    expect(truncated[0]!.lines.map(line => line.text)).toEqual(['{"id":8,"time":1}']);
    expect(truncated[0]!.startOff).toBe(0);
  } finally {
    f.close();
  }
});

test('路由jsonl首次出现空文件不写游标，首行到达后才提交', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-10-24.jsonl');
    writeFileSync(path, '');
    const empty = await readRouteFiles(dir);
    expect(empty[0]).toMatchObject({ state: 'unchanged', lines: [], issues: [] });

    writeFileSync(path, '{"id":1,"time":1}\n');
    const first = await readRouteFiles(dir);
    expect(first[0]!.state).toBe('decoded');
    expect(first[0]!.lines.map(line => line.text)).toEqual(['{"id":1,"time":1}']);
    expect(first[0]!.committedOff).toBe(Buffer.byteLength('{"id":1,"time":1}\n'));
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
    const known = routeCursors(decoded);
    expect(known.get(name)?.fingerprint).toBe(digest);

    const unchanged = await readRouteFiles(dir, known);
    expect(unchanged[0]).toMatchObject({ name, state: 'unchanged', error: null });
    expect(unchanged[0]!.lines).toEqual([]);

    const appended = Buffer.concat([gunzipSync(first), Buffer.from('{"id":2,"time":"2026-10-22T00:01:00Z"}\n')]);
    const replaced = gzipSync(appended);
    writeFileSync(path, replaced);
    const changed = await readRouteFiles(dir, known);
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
    const recovered = await readRouteFiles(dir);
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
    const known = routeCursors(await readRouteFiles(dir));
    writeFileSync(join(dir, day2), gzipSync(Buffer.from('{"id":2,"time":"2026-10-23T00:00:00Z"}\n')));
    const files = await readRouteFiles(dir, known);
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
    expect(files[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    f.close();
  }
});

test('jsonl与gz返回同一游标形状，身份字段各按文件形态取值', async () => {
  const f = fixture();
  try {
    const jsonl = join(f.dir, '2026-10-24.jsonl');
    writeFileSync(jsonl, '{"id":1,"time":1}\n');
    const appendable = await readBatch(jsonl, null, {
      kind: 'route_file', name: '2026-10-24.jsonl',
    });
    expect(appendable).toMatchObject({
      mode: 'appendable', sourceKind: 'route_file', state: 'decoded',
      fingerprint: null, rewriteEpoch: 0,
    });
    expect(appendable.generation).toMatch(/^[^:]+:[^:]+:[^:]+:0$/);
    expect(appendable.headLen).toBeGreaterThan(0);
    expect(appendable.headHash).toMatch(/^[0-9a-f]{64}$/);

    // 读出的对象本身就是下一轮游标，直接交回读取器。
    const appended = await readBatch(jsonl, appendable, {
      kind: 'route_file', name: '2026-10-24.jsonl',
    });
    expect(appended.lines).toEqual([]);
    expect(appended.generation).toBe(appendable.generation);

    const gz = join(f.dir, '2026-10-22.jsonl.gz');
    const text = '{"id":2,"time":2}\n';
    writeFileSync(gz, gzipSync(Buffer.from(text)));
    const files = await readRouteFiles(f.dir);
    const sealed = files.find(file => file.sourceKind === 'route_gz')!;
    expect(sealed).toMatchObject({
      mode: 'sealed', sourceKind: 'route_gz', state: 'decoded',
      rewriteEpoch: 0, headLen: 0, headHash: null,
    });
    expect(sealed.generation).toBe(sealed.fingerprint!);
    expect(sealed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.committedOff).toBe(Buffer.byteLength(text));
  } finally {
    f.close();
  }
});
