import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDiagnosticLog, errorCode } from '../src/monitoring';
import { codeVersion } from '../src/main';

function capture() {
  const lines: string[] = [];
  const log = createDiagnosticLog({
    instance: 'proc-a', version: 'abc123',
    sink: line => lines.push(line),
  });
  return { lines, log, parse: (index = 0) => JSON.parse(lines[index]!) as Record<string, unknown> };
}

test('结构化日志只带共同字段且版本来自启动', () => {
  const { lines, log, parse } = capture();
  log.lifecycle('service.start', { phase: 'boot' });
  expect(lines).toHaveLength(1);
  const entry = parse();
  expect(entry.kind).toBe('lifecycle');
  expect(entry.instance).toBe('proc-a');
  expect(entry.version).toBe('abc123');
  expect(entry.phase).toBe('boot');
  // 时间是可对齐的 ISO 时间，不是仅本地化的字符串。
  expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
});

test('自由错误文本归一成固定分类，不进日志', () => {
  const sensitive = 'ENOENT: /Users/me/.local/state/trace.db?token=secret';
  expect(errorCode(new Error(sensitive))).toBe('unclassified');
  expect(errorCode(new Error('derive_worker_error'))).toBe('derive_worker_error');
  const { lines, log } = capture();
  log.error('route', { code: new Error(sensitive), phase: 'decode' });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('token=secret');
  expect(lines[0]).toContain('"result":"unclassified"');
});

test('限流保留被抑制的次数，窗口过后再输出一条', () => {
  let now = 1_000;
  const lines: string[] = [];
  const log = createDiagnosticLog({
    instance: 'proc-a', throttleMs: 60_000, now: () => now, sink: line => lines.push(line),
  });
  log.error('ledger', { code: new Error('database_locked') });
  for (let index = 0; index < 4; index += 1) {
    now += 1_000;
    log.error('ledger', { code: new Error('database_locked') });
  }
  expect(lines).toHaveLength(1);
  now += 60_000;
  log.error('ledger', { code: new Error('database_locked') });
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!).suppressed).toBe(4);
});

test('慢调用低于阈值不写，超过阈值写一次；Worker 阈值独立', () => {
  const lines: string[] = [];
  const log = createDiagnosticLog({
    instance: 'proc-a', thresholds: { syncMs: 100, workerMs: 500 },
    sink: line => lines.push(line),
  });
  log.slow('http.read', { phase: '/api/sessions', dur_ms: 40 });
  expect(lines).toHaveLength(0);
  log.slow('http.read', { phase: '/api/sessions', dur_ms: 120 });
  expect(lines).toHaveLength(1);
  // 同一个 120 ms 对 Worker 阈值仍属正常，不写。
  log.slow('derive.compute', { phase: 'compute', corr: 'round-1', dur_ms: 120 }, 500);
  expect(lines).toHaveLength(1);
  log.slow('derive.compute', { phase: 'compute', corr: 'round-1', dur_ms: 700 }, 500);
  expect(lines).toHaveLength(2);
});

test('派生结果把计算与落库耗时分开记，共用关联编号', () => {
  const { lines, log, parse } = capture();
  log.derive({ corr: 'round-1', result: 'whole', compute_ms: 12, apply_ms: 3 });
  log.derive({ corr: 'round-2', result: 'prefix', compute_ms: 4, apply_ms: 2 });
  log.derive({ corr: 'round-3', result: 'discard' });
  log.derive({ corr: 'round-4', result: 'failure', code: new Error('derive_input_changed') });
  expect(lines).toHaveLength(4);
  expect(parse(0)).toMatchObject({ op: 'derive.result', result: 'whole', compute_ms: 12, apply_ms: 3 });
  expect(parse(3)).toMatchObject({ result: 'failure', code: 'derive_input_changed' });
});

test('重启前后追加到同一文件时旧记录仍在且实例不同', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-log-'));
  const path = join(dir, 'collector.log');
  const modulePath = join(import.meta.dir, '..', 'src', 'monitoring.ts');
  const script = `
    import { appendFileSync } from 'node:fs';
    import { createDiagnosticLog } from ${JSON.stringify(modulePath)};
    const log = createDiagnosticLog({
      instance: process.env.INSTANCE, version: 'abc123',
      sink: line => appendFileSync(process.env.LOG_PATH, line + '\\n'),
    });
    log.lifecycle('service.start', { phase: 'boot' });
  `;
  try {
    for (const instance of ['proc-before', 'proc-after']) {
      const result = Bun.spawnSync(['bun', '-e', script], {
        env: { ...process.env, INSTANCE: instance, LOG_PATH: path },
      });
      expect(result.exitCode).toBe(0);
    }
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).instance).toBe('proc-before');
    expect(JSON.parse(lines[1]!).instance).toBe('proc-after');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('启动版本号取自本检出，不受上层检出影响', () => {
  const root = dirname(import.meta.dir);
  const head = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--short', 'HEAD']);
  if (head.exitCode !== 0) return;
  expect(codeVersion()).toBe(head.stdout.toString().trim());
});
