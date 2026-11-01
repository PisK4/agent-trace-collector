import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

test('生产读取不绕过 HTTP adapter', () => {
  const violations: string[] = [];
  for (const name of readdirSync('web').filter(name => name.endsWith('.js'))) {
    if (name === 'read-http.js') continue;
    const path = `web/${name}`;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    // app.js 作为组装点允许把全局 fetch 作为构造注入值传给 adapter
    //（fetcher 属性的值闭包内），其余 fetch 调用一律违规。
    function visit(node: ts.Node, inFetcherValue: boolean) {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        const direct = ts.isIdentifier(target) && target.text === 'fetch';
        const property = ts.isPropertyAccessExpression(target)
          && ts.isIdentifier(target.expression)
          && ['window', 'globalThis'].includes(target.expression.text)
          && target.name.text === 'fetch';
        const indexed = ts.isElementAccessExpression(target)
          && ts.isIdentifier(target.expression)
          && ['window', 'globalThis'].includes(target.expression.text)
          && ts.isStringLiteral(target.argumentExpression)
          && target.argumentExpression.text === 'fetch';
        if ((direct || property || indexed) && !inFetcherValue) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${path}:${line}`);
        }
      }
      const entersFetcher = ts.isPropertyAccessExpression(node) && node.name.text === 'fetcher'
        || ts.isPropertyAssignment(node) && node.name.getText(source) === 'fetcher';
      ts.forEachChild(node, child => visit(child, inFetcherValue || entersFetcher));
    }
    visit(source, false);
  }
  expect(violations).toEqual([]);
});

test('生产模块不自定义同名 fetch 掩盖检查', () => {
  const violations: string[] = [];
  for (const name of readdirSync('web').filter(name => name.endsWith('.js'))) {
    if (name === 'read-http.js') continue;
    const path = `web/${name}`;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      // 函数声明/变量声明以 fetch 命名即算：同名函数会让直接调用检查落空。
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'fetch') {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(`${path}:${line}`);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fetch') {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(`${path}:${line}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
