import { expect, test } from 'bun:test';
import { interpretMessage, interpretUserText } from '../src/input-interpretation';

test('会话外壳与系统提醒被剥掉，用户正文保留', () => {
  const view = interpretUserText(
    '<session>\n<system-reminder>noise</system-reminder>\n修复登录\n</session>',
    'claude',
  );
  expect(view.state).toBe('text');
  expect(view.kind).toBe('wrapped');
  expect(view.text).toBe('修复登录');
  expect(view.original).toContain('<session>');
  expect(view.rule).toBe('generic');
  const cwd = interpretUserText('工作目录: /tmp/project\n修复登录', null);
  expect(cwd.text).toBe('修复登录');
  expect(cwd.kind).toBe('wrapped');
});

test('嵌套与畸形标签不丢正文', () => {
  const nested = interpretUserText(
    '<session><system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>真实输入</session>',
    null,
  );
  expect(nested.text).toBe('真实输入');
  const malformed = interpretUserText('<session>没有闭合的用户输入', null);
  expect(malformed.state).toBe('unrecognized');
  expect(malformed.text).toBe('<session>没有闭合的用户输入');
});

test('插话前缀只剥提示，保留用户新消息', () => {
  const view = interpretUserText(
    'The user sent a new message while you were working: 另外看下分页\n\n'
    + 'This is how Claude Code surfaces messages the user sends mid-turn.',
    'claude',
  );
  expect(view.kind).toBe('midturn');
  expect(view.text).toBe('另外看下分页');
});

test('技能注入与标题请求不进入用户气泡，原文仍在', () => {
  const skill = interpretUserText('Base directory for this skill: /x\n\n# 正文', 'claude');
  expect(skill.state).toBe('injected');
  expect(skill.kind).toBe('skill_injection');
  expect(skill.original).toContain('Base directory');
  const title = interpretUserText('<title-request>生成标题</title-request>', 'claude');
  expect(title.kind).toBe('title_request');
  expect(title.text).toBe('');
});

test('纯系统提醒与命令回显分开标记', () => {
  const notice = interpretUserText('<system-reminder>现在没有用户正文</system-reminder>', null);
  expect(notice.state).toBe('injected');
  expect(notice.kind).toBe('system_notice');
  const command = interpretUserText('<command-name>/clear</command-name>', null);
  expect(command.state).toBe('injected');
  expect(command.kind).toBe('command_echo');
});

test('正文中间的标签不是包装，合法用户文本原样保留', () => {
  const text = '请解释 <session> 和 <skills> 标签的语义';
  const view = interpretUserText(text, 'omp');
  expect(view.state).toBe('text');
  expect(view.kind).toBe('plain');
  expect(view.text).toBe(text);
});

test('未知 agent 沿用通用规则，不推断客户端身份', () => {
  const view = interpretUserText('<session>你好</session>', null);
  expect(view.text).toBe('你好');
  expect(view.rule).toBe('generic');
  expect(view.agent).toBeNull();
});

test('多条用户消息逐条解释，工具结果不算用户输入', () => {
  const first = interpretMessage({ role: 'user', content: [{ type: 'text', text: '第一条' }] }, null, 0);
  const second = interpretMessage({ role: 'user', content: [{ type: 'text', text: '第二条' }] }, null, 1);
  const tool = interpretMessage(
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    null,
    2,
  );
  expect(first.input?.text).toBe('第一条');
  expect(second.input?.text).toBe('第二条');
  expect(tool.input).toBeNull();
  expect(tool.role).toBe('user');
});

test('未知角色中性保留，不猜成 user 或 assistant', () => {
  const view = interpretMessage({ role: 'synthetic_role', content: 'x' }, null, 0);
  expect(view.role).toBe('unknown');
  expect(view.role_state).toBe('unknown');
  expect(view.input).toBeNull();
});
