import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dict } from '../web/i18n-en.js';

/**
 * 覆盖闸门：web 模块里出现的中文引号字符串必须是 t() 的 key、是 en 字典的
 * key（key-map 经 t() 间接消费）、或进了白名单。防止后续文案绕过 i18n。
 *
 * 已知边界：反引号模板不扫描——模板内的中文要么是 t('...') 的 key、要么是
 * 插值消息的组合部分，行级静态分析分不清；新增纯模板文案时靠走查兜底。
 */

// 语言切换钮的图形是目标语言自称（EN/中文），不是待翻译文案。
const ALLOWED: Array<[file: string, needle: string]> = [
  ['layout.js', `'中文'`],
];

const ZH = /[\u4e00-\u9fff]/;
const EXCLUDED = new Set(['i18n.js', 'i18n-en.js', 'motion.vendor.js']);

function stripComments(source: string): string {
  // 引号内的 //（如 URL）不是注释：行注释要求 // 前不是 : ' " \
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function quotedStrings(line: string): Array<{ value: string, before: string }> {
  const out: Array<{ value: string, before: string }> = [];
  for (const m of line.matchAll(/'([^'\n]*)'/g)) {
    out.push({ value: m[1] ?? '', before: line.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0) });
  }
  for (const m of line.matchAll(/"([^"\n]*)"/g)) {
    const value = m[1] ?? '';
    // 模板内 HTML 属性（aria-label="${t('…')}") 的引号不是字符串字面量
    if (value.includes('${')) continue;
    out.push({ value, before: line.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0) });
  }
  return out;
}

describe('i18n 覆盖闸门', () => {
  const webDir = join(import.meta.dir, '..', 'web');

  test('web 模块没有绕过 t() 的 UI 中文文案', () => {
    const violations: string[] = [];
    for (const name of readdirSync(webDir)) {
      if (!name.endsWith('.js') || EXCLUDED.has(name)) continue;
      const source = readFileSync(join(webDir, name), 'utf8');
      const lines = stripComments(source).split('\n');
      for (const [index, line] of lines.entries()) {
        for (const { value, before } of quotedStrings(line)) {
          if (!ZH.test(value)) continue;
          if (/\bt\(\s*$/.test(before)) continue;
          if (value in dict) continue;
          if (ALLOWED.some(([file, needle]) => file === name && line.includes(needle))) continue;
          violations.push(`${name}:${index + 1} ${value.slice(0, 40)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
