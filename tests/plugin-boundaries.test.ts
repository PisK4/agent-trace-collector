import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { validateTodoSnapshot } from '../src/plugins/todo/dto';

const PLUGINS_DIR = join(import.meta.dir, '..', 'src', 'plugins');

/** src/plugins/ 下全部源码文件，含子目录；测试自身不在此列。 */
function pluginSources(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
  }
  walk(PLUGINS_DIR);
  return out;
}

/** Parser 只交 DTO：不 import 核心、不 fetch、不产出 HTML。 */
test('plugin 模块不 import 核心、不 fetch、不产出 HTML', () => {
  const violations: string[] = [];
  for (const path of pluginSources()) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = path.slice(PLUGINS_DIR.length + 1);

    source.forEachChild(node => {
      // 相对 import 解析后必须仍落在 src/plugins/ 内；跨出去就是 import 核心。
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          const resolved = resolve(path, '..', spec);
          if (!resolved.startsWith(PLUGINS_DIR)) violations.push(`${rel}: import ${spec}`);
        } else if (!spec.startsWith('bun:') && !spec.startsWith('node:')) {
          violations.push(`${rel}: import ${spec}`);
        }
      }
    });

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        const direct = ts.isIdentifier(target) && target.text === 'fetch';
        const property = ts.isPropertyAccessExpression(target)
          && ts.isIdentifier(target.expression)
          && ['window', 'globalThis', 'self'].includes(target.expression.text)
          && target.name.text === 'fetch';
        if (direct || property) {
          violations.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: fetch`);
        }
      }
      // 模板或字符串里出现标签即视为产出 HTML 的迹象。
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (/<\/?[a-z][^>]*>/i.test(node.text)) {
          violations.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: html literal`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});

/** 畸形 DTO 收口在校验入口：核心拿到 null 只隐藏该页签，不抛异常。 */
test('畸形 DTO 一律判 null，不写成空列表', () => {
  const malformed: unknown[] = [
    null, undefined, 0, 'x', {},
    { seq: -1, items: [] },
    { seq: 1.5, items: [] },
    { seq: '1', items: [] },
    { seq: 1, items: 'x' },
    { seq: 1, items: [null] },
    { seq: 1, items: [{ content: 1, status: 'pending' }] },
    { seq: 1, items: [{ content: 'x' }] },
    { seq: 1, items: [{ content: 'x', status: 2 }] },
  ];
  for (const value of malformed) expect(validateTodoSnapshot(value)).toBeNull();
});

test('合法 DTO 原样保留，不解释状态词', () => {
  const value = { seq: 2, items: [{ content: 'ship', status: 'in_progress' }] };
  expect(validateTodoSnapshot(value)).toEqual(value);
});
