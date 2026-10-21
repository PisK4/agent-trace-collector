import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareCoverage,
  describeAvaSchema,
  pickAvaMapping,
  readAvaRows,
  readCollectorLedger,
  readCollectorRequests,
  runVerifyCutover,
} from '../scripts/verify-cutover';
import type { CoverageRow } from '../scripts/verify-cutover';
import { fixture } from './fixtures';

function row(
  responseId: string | null,
  bodyState: string,
  extra: Partial<CoverageRow> = {},
): CoverageRow {
  return {
    response_id: responseId,
    protocol: 'chat',
    started_ms: 100,
    agent: 'demo',
    status: 200,
    body_state: bodyState,
    request_bytes: 10,
    ...extra,
  };
}

test('两边都缺失不能藏在集合交集中', () => {
  const report = compareCoverage(
    [row('chatcmpl_a', 'pending'), row('chatcmpl_b', 'pending')],
    [row('chatcmpl_a', 'available')],
    [row('chatcmpl_a', 'available')],
  );
  expect(report.denominator).toBe(2);
  expect(report.missing_both).toEqual(['chatcmpl_b']);
  expect(report.collector_available).toBe(1);
});

test('守恒关系成立且空窗口不生成Infinity', () => {
  const report = compareCoverage([], [], []);
  expect(report.denominator).toBe(0);
  expect(report.counted).toEqual({ with_body: 0, without_body: 0, undecidable: 0 });
  expect(report.window).toEqual({ from: 0, to: 0 });
  expect(Number.isFinite(report.window.from)).toBe(true);
  expect(Number.isFinite(report.window.to)).toBe(true);
});

test('NULL ID与重复ID单列，不丢弃也不强行合并', () => {
  const ledger = [
    row(null, 'pending'),
    row('dup', 'pending'),
    row('dup', 'pending'),
    row('solo', 'pending'),
  ];
  const report = compareCoverage(ledger, [row('solo', 'available')], [row('solo', 'available')]);
  expect(report.denominator).toBe(4);
  // 无法唯一判断：NULL ID 一条 + 重复 ID 两条。
  expect(report.counted.undecidable).toBe(3);
  expect(report.counted.with_body).toBe(1);
  expect(report.counted.without_body).toBe(0);
  expect(report.null_id_counts.ledger).toBe(1);
  expect(report.ambiguous_ids).toEqual(['dup']);
  // 守恒：有正文 + 无正文 + 无法唯一判断 = 分母。
  expect(report.counted.with_body + report.counted.without_body + report.counted.undecidable)
    .toBe(report.denominator);
  // 重复 ID 不被算成一条“已覆盖”。
  expect(report.collector_available).toBe(1);
  // 三条带 ID 的行里，'dup' 出现两次，重复候选一条。
  expect(report.counts.ledger).toEqual({ rows: 4, unique_ids: 2, duplicates: 1 });
});

test('只在一边出现的ID单列且不算进分母差异', () => {
  const report = compareCoverage(
    [row('shared', 'pending')],
    [row('shared', 'available'), row('collector_extra', 'available')],
    [row('ava_extra', 'available')],
  );
  expect(report.collector_only).toEqual(['collector_extra']);
  expect(report.ava_only).toEqual(['ava_extra']);
  expect(report.missing_both).toEqual([]);
  expect(report.denominator).toBe(1);
});

test('分桶按协议、状态、大小与正文状态给出覆盖数', () => {
  const ledger = [
    row('a', 'pending', { protocol: 'chat', status: 200, request_bytes: 1024 }),
    row('b', 'pending', { protocol: 'anthropic', status: 200, request_bytes: null }),
    row('c', 'pending', { protocol: 'chat', status: 500, request_bytes: 9 * 1024 * 1024 }),
  ];
  const report = compareCoverage(ledger, [row('a', 'available')], [row('a', 'available'), row('c', 'available')]);
  expect(report.buckets.protocol).toEqual([
    { key: 'anthropic', ledger: 1, collector_available: 0, ava_available: 0 },
    { key: 'chat', ledger: 2, collector_available: 1, ava_available: 2 },
  ]);
  expect(report.buckets.status).toEqual([
    { key: '200', ledger: 2, collector_available: 1, ava_available: 1 },
    { key: '500', ledger: 1, collector_available: 0, ava_available: 1 },
  ]);
  // 没有大小的行留在 unknown，不编造超过上限的原因。
  expect(report.buckets.size).toEqual([
    { key: 'gt_8m', ledger: 1, collector_available: 0, ava_available: 1 },
    { key: 'le_64k', ledger: 1, collector_available: 1, ava_available: 1 },
    { key: 'unknown', ledger: 1, collector_available: 0, ava_available: 0 },
  ]);
  expect(report.buckets.miss_reason.map(bucket => bucket.key)).toEqual(['pending']);
});

test('AVA结构不认识时停下来报告看到的表与字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-ava-'));
  try {
    const path = join(dir, 'ava.db');
    const db = new Database(path, { create: true });
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, payload TEXT)');
    db.close();

    const schema = describeAvaSchema(path);
    expect(schema).toEqual([{ table: 'sessions', columns: ['id', 'payload'] }]);
    const picked = pickAvaMapping(schema);
    expect('error' in picked && picked.error).toBe('ava_schema_unrecognized');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AVA表能唯一确定时按字段读取，秒级时间换算成毫秒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-ava-'));
  try {
    const path = join(dir, 'ava.db');
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE requests(response_id TEXT, started_at INTEGER, status INTEGER,
                                   request_body TEXT, request_bytes INTEGER)`);
    db.run('INSERT INTO requests VALUES (?,?,?,?,?)', ['resp_1', 100, 200, 'synthetic', 42]);
    db.run('INSERT INTO requests VALUES (?,?,?,?,?)', ['resp_2', 200, 200, null, null]);
    db.close();

    const schema = describeAvaSchema(path);
    const picked = pickAvaMapping(schema, { time_unit: 's' });
    if ('error' in picked) throw new Error(picked.error);
    expect(picked.mapping).toEqual({
      table: 'requests', response_id: 'response_id', started_ms: 'started_at',
      status: 'status', body: 'request_body', bytes: 'request_bytes', time_unit: 's',
    });
    const rows = readAvaRows(path, picked.mapping, { from: 100_000, to: 150_000 });
    expect(rows).toEqual([{
      response_id: 'resp_1', protocol: null, started_ms: 100_000, agent: null,
      status: 200, body_state: 'available', request_bytes: 42,
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('找不到正文列时不把AVA覆盖报成0', () => {
  const picked = pickAvaMapping([
    { table: 'requests', columns: ['response_id', 'started_at', 'status'] },
  ]);
  expect('error' in picked && picked.error).toBe('ava_body_column_unknown');
});

function seedCollector(f: ReturnType<typeof fixture>): void {
  f.store.write(db => {
    db.run(`INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,route_id,t_text,t_ms,source,
              via,response_id_norm,status,agent,payload_json)
            VALUES ('file','g:0',0,1,'',1000,'ledger','through','resp_a',200,'demo','{}'),
                   ('file','g:0',10,2,'',2000,'ledger','through','resp_b',200,'demo','{}'),
                   ('file','g:0',20,3,'',3000,'ledger','through','resp_missing',200,'demo','{}')`);
    db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
              response_id_norm,status,agent,body_bytes)
            VALUES (1,1000,'2026-10-20','through','available',1,1,1,1,'resp_a',200,'demo',10),
                   (2,2000,'2026-10-20','through','pending',1,1,1,1,'resp_b',200,'demo',10)`);
  });
}

test('CLI按窗口只读比较并把报告写在仓库外', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'cutover-out-'));
  const reportPath = join(dir, 'report.json');
  const avaPath = join(dir, 'ava.db');
  try {
    seedCollector(f);
    const ava = new Database(avaPath, { create: true });
    ava.exec('CREATE TABLE requests(response_id TEXT, started_at INTEGER, status INTEGER, request_body TEXT)');
    ava.run('INSERT INTO requests VALUES (?,?,?,?)', ['resp_a', 1000, 200, 'synthetic']);
    ava.run('INSERT INTO requests VALUES (?,?,?,?)', ['resp_b', 2000, 200, 'synthetic']);
    ava.close();

    const lines: string[] = [];
    const code = await runVerifyCutover([
      '--from', '0', '--to', '4000',
      '--collector', join(f.dir, 'trace.db'),
      '--ava', avaPath,
      '--out', reportPath,
    ], { out: line => lines.push(line), err: () => {} });
    expect(code).toBe(0);
    const summary = JSON.parse(lines[0]!);
    expect(summary.normalized.denominator).toBe(3);
    expect(summary.normalized.collector_available).toBe(1);
    expect(summary.normalized.ava_available).toBe(2);
    expect(summary.normalized.missing_both).toBe(1);
    expect(summary.normalized.conserved).toBe(true);
    // 原始 ID 与规范化 ID 各一份报告，两份都要守恒。
    expect(summary.raw.denominator).toBe(3);
    expect(summary.raw.conserved).toBe(true);

    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    const report = JSON.parse(await Bun.file(reportPath).text());
    expect(report.normalized.missing_both).toEqual(['resp_missing']);
    expect(report.normalized.window).toEqual({ from: 0, to: 4000 });
    expect(report.normalized.filter).toEqual({ via: 'through', status: null });
    expect(report.raw.window).toEqual({ from: 0, to: 4000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    f.close();
  }
});

test('CLI拒绝把报告写进仓库', async () => {
  const f = fixture();
  try {
    const errs: string[] = [];
    const code = await runVerifyCutover([
      '--from', '0', '--to', '4000',
      '--collector', join(f.dir, 'trace.db'),
      '--ava', join(f.dir, 'trace.db'),
      '--out', join(process.cwd(), 'synthetic-report.json'),
    ], { out: () => {}, err: line => errs.push(line) });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('report_inside_repository');
  } finally {
    f.close();
  }
});

test('CLI参数不全时返回用法错误', async () => {
  const errs: string[] = [];
  expect(await runVerifyCutover(['--from', '0'], { out: () => {}, err: line => errs.push(line) })).toBe(2);
  expect(errs.join('')).toContain('usage:');
});

test('collector导出按窗口与through筛选', () => {
  const f = fixture();
  try {
    seedCollector(f);
    f.store.write(db => {
      db.run(`INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,route_id,t_text,t_ms,source,
                via,response_id_norm,status,agent,payload_json)
              VALUES ('file','g:0',30,4,'',9000,'ledger','direct','resp_direct',200,'demo','{}')`);
    });
    const ledger = readCollectorLedger(join(f.dir, 'trace.db'), {
      window: { from: 0, to: 4000 }, via: 'through', status: null,
    });
    expect(ledger.map(row => row.response_id)).toEqual(['resp_a', 'resp_b', 'resp_missing']);
    const requests = readCollectorRequests(join(f.dir, 'trace.db'), {
      window: { from: 0, to: 4000 }, via: 'through', status: null,
    });
    // 按 started_ms 排序，与账本一致；不是按 req_id。
    expect(requests.map(row => [row.response_id, row.body_state])).toEqual([
      ['resp_b', 'pending'], ['resp_a', 'available'],
    ]);
  } finally {
    f.close();
  }
});

test('原始ID与规范化ID各出一份报告且各自守恒', () => {
  const f = fixture();
  try {
    // 两个不同的原始 ID 规范化后折成同一个：norm 那份要把它算成歧义，raw 那份是两条独立行。
    f.store.write(db => {
      db.run(`INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,route_id,t_text,t_ms,source,
                via,response_id,response_id_norm,status,agent,payload_json)
              VALUES ('file','g:0',0,1,'',1000,'ledger','through','raw_A','same',200,'demo','{}'),
                     ('file','g:0',10,2,'',2000,'ledger','through','raw_B','same',200,'demo','{}')`);
      db.run(`INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
                response_id_norm,status,agent,body_bytes)
              VALUES (1,1000,'2026-10-20','through','available',1,1,1,1,'same',200,'demo',10)`);
    });
    const options = { window: { from: 0, to: 4000 }, via: 'through', status: null };
    const normLedger = readCollectorLedger(join(f.dir, 'trace.db'), { ...options, id_mode: 'norm' });
    const rawLedger = readCollectorLedger(join(f.dir, 'trace.db'), { ...options, id_mode: 'raw' });
    expect(normLedger.map(row => row.response_id)).toEqual(['same', 'same']);
    expect(rawLedger.map(row => row.response_id)).toEqual(['raw_A', 'raw_B']);

    const norm = compareCoverage(normLedger, readCollectorRequests(join(f.dir, 'trace.db'), { ...options, id_mode: 'norm' }), []);
    expect(norm.ambiguous_ids).toEqual(['same']);
    expect(norm.counted.undecidable).toBe(2);
    expect(norm.counted.with_body + norm.counted.without_body + norm.counted.undecidable)
      .toBe(norm.denominator);

    const raw = compareCoverage(rawLedger, readCollectorRequests(join(f.dir, 'trace.db'), { ...options, id_mode: 'raw' }), []);
    // 原始 ID 下两个 ID 各自唯一，没有折叠出来的歧义。
    expect(raw.ambiguous_ids).toEqual([]);
    expect(raw.counted.with_body + raw.counted.without_body + raw.counted.undecidable)
      .toBe(raw.denominator);
  } finally {
    f.close();
  }
});
