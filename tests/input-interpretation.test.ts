import { expect, test } from 'bun:test';
import {
  interpretMessage, interpretUserText, isOmpArchiveMessage, ompDroppedCharsOf,
} from '../src/input-interpretation';

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

test('排在用户正文之后的包装块不算输入', () => {
  const view = interpretMessage({
    role: 'user',
    content: [
      { type: 'text', text: '修复登录' },
      { type: 'text', text: '<system-reminder>\n上下文提示\n</system-reminder>' },
    ],
  }, 'claude', 0);
  expect(view.input?.state).toBe('text');
  expect(view.input?.text).toBe('修复登录');
  expect(view.input?.removed).toEqual(['system-reminder']);
});

test('粘贴标记只删标记行，粘贴正文仍是用户输入', () => {
  const view = interpretMessage({
    role: 'user',
    content: [
      { type: 'text', text: '<pasted_content id=7>\n粘贴的日志\n第二行' },
      { type: 'text', text: '请看这段' },
    ],
  }, 'claude', 0);
  expect(view.input?.state).toBe('text');
  expect(view.input?.kind).toBe('wrapped');
  expect(view.input?.text).toBe('粘贴的日志\n第二行\n请看这段');
});

test('作业规格整段丢弃，规格之后的用户的话保留', () => {
  const view = interpretMessage({
    role: 'user',
    content: [{ type: 'text', text: '<job>\ngoal: 重构\nrepo: demo\n</job>\n按上面做' }],
  }, 'omp', 0);
  expect(view.input?.text).toBe('按上面做');
});

test('附件与对话简报不算用户输入，原文仍可复制', () => {
  const file = interpretMessage({
    role: 'user',
    content: [{ type: 'text', text: '<file path="src/a.ts">const a = 1;</file>' }],
  }, 'omp', 0);
  expect(file.input?.state).toBe('injected');
  expect(file.input?.text).toBe('');
  expect(file.input?.original).toContain('<file');
  const chat = interpretMessage({
    role: 'user',
    content: [{ type: 'text', text: '<chat>\ngoal:\n修复登录\n</chat>' }],
  }, 'omp', 1);
  expect(chat.input?.state).toBe('injected');
});

test('跨块的 transcript 仍按拼接后的全文配对剥掉', () => {
  const view = interpretMessage({
    role: 'user',
    content: [
      { type: 'text', text: '<transcript>\n历史' },
      { type: 'text', text: '更多历史' },
      { type: 'text', text: '</transcript>' },
      { type: 'text', text: '继续' },
    ],
  }, 'claude', 0);
  expect(view.input?.state).toBe('text');
  expect(view.input?.text).toBe('继续');
  expect(view.input?.removed).toContain('transcript');
});

test('块内未闭合的已知标签原样保留，不吞掉后面的正文', () => {
  const view = interpretMessage({
    role: 'user',
    content: [
      { type: 'text', text: '看这个' },
      { type: 'text', text: '<session>没有闭合' },
    ],
  }, null, 0);
  expect(view.input?.state).toBe('text');
  expect(view.input?.text).toBe('看这个\n<session>没有闭合');
});

test('user 壳保留内文', () => {
  const view = interpretUserText('<user>你好</user>', 'omp');
  expect(view.text).toBe('你好');
  expect(view.kind).toBe('wrapped');
});

// —— OMP 压缩归档消息：解释为注入、块级归档判定与丢弃量提取 ——

const ARCHIVE_BODY = 'Resume prior conversation. Earlier turns archived under HISTORY. '
  + 'About 12,345 characters of older middle history dropped to fit archive budget. '
  + 'Archived transcript scopes: ¶user: ¶ai:';

test('OMP 压缩归档消息解释为注入，标题与摘要不再消费它', () => {
  // 块 0 是 system-reminder、块 1 才是归档正文：判据剥壳后落在正文块。
  const view = interpretMessage({ role: 'user', content: [
    { type: 'text', text: '<system-reminder>Synthetic date and cwd</system-reminder>' },
    { type: 'text', text: ARCHIVE_BODY },
  ] }, 'omp', 1);
  expect(view.input?.state).toBe('injected');
  expect(view.input?.kind).toBe('omp_history_archive');
  expect(view.input?.text).toBe('');
  // 单块裸归档同样命中。
  const bare = interpretUserText(ARCHIVE_BODY, 'omp');
  expect(bare.state).toBe('injected');
  expect(bare.kind).toBe('omp_history_archive');
  // 普通用户文本不受影响；引用句在块中段也不是归档。
  const plain = interpretUserText('先看看 Resume prior conversation 这句怎么翻译', null);
  expect(plain.state).toBe('text');
  expect(plain.kind).toBe('plain');
});

test('归档判定按任一文本块块首，非 user 角色与中段引用不算', () => {
  expect(isOmpArchiveMessage({ role: 'user', content: [
    { type: 'text', text: '<system-reminder>x</system-reminder>' },
    { type: 'text', text: ARCHIVE_BODY },
  ] })).toBe(true);
  expect(isOmpArchiveMessage({ role: 'user', content: [
    { type: 'text', text: `回顾：${ARCHIVE_BODY}` },
  ] })).toBe(false);
  expect(isOmpArchiveMessage({ role: 'assistant', content: [
    { type: 'text', text: ARCHIVE_BODY },
  ] })).toBe(false);
  expect(isOmpArchiveMessage(null)).toBe(false);
});

test('丢弃量从归档块提取，千分位逗号剥掉，没写就是 null', () => {
  expect(ompDroppedCharsOf({ role: 'user', content: [
    { type: 'text', text: '<system-reminder>x</system-reminder>' },
    { type: 'text', text: ARCHIVE_BODY },
  ] })).toBe(12345);
  expect(ompDroppedCharsOf({ role: 'user', content: [
    { type: 'text', text: 'Resume prior conversation. Earlier turns archived under HISTORY. 无丢弃说明' },
  ] })).toBe(null);
  expect(ompDroppedCharsOf({ role: 'user', content: '别的消息' })).toBe(null);
});
