import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailLines } from '../scripts/service-support';

test('tailLines 取非空尾部行，读失败与空日志可区分', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-tail-'));
  try {
    const path = join(dir, 'stderr.log');
    // 空日志：可读、0 行、无错误。
    writeFileSync(path, '\n \n');
    expect(tailLines(path, 5)).toEqual({ lines: [], error: null });
    // 只留非空行，按 count 截尾。
    writeFileSync(path, 'a\n\nb\nc\n');
    expect(tailLines(path, 2)).toEqual({ lines: ['b', 'c'], error: null });
    // 读失败：lines 为空但 error 带原因，不再与「日志为空」同形。
    const missing = tailLines(join(dir, 'absent.log'), 5);
    expect(missing.lines).toEqual([]);
    expect(missing.error).toContain('no such file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
