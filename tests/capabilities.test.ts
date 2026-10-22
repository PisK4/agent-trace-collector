import { expect, test } from 'bun:test';
import { capabilityView, extractSkills, extractTools } from '../src/capabilities';

const complete = {
  complete: true,
  reason: 'available' as const,
  from: 0,
  to: 2,
  total: 2,
};

test('工具定义按协议读取两种形状', () => {
  const anthropic = extractTools('anthropic', {
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
  });
  expect(anthropic.state).toBe('present');
  expect(anthropic.items[0]?.name).toBe('Bash');
  expect(anthropic.items[0]?.schema).toEqual({ type: 'object' });

  const chat = extractTools('chat', {
    functions: [{ name: 'read_file', parameters: { type: 'object' } }],
  });
  expect(chat.state).toBe('present');
  expect(chat.items[0]?.name).toBe('read_file');
});

test('工具缺失、空、未识别与协议缺失分开', () => {
  expect(extractTools('anthropic', {}).state).toBe('missing');
  expect(extractTools('anthropic', { tools: [] }).state).toBe('empty');
  expect(extractTools('anthropic', { tools: 'oops' }).state).toBe('unrecognized');
  expect(extractTools('responses', {}).state).toBe('missing');
});

test('技能区分 present、empty、unrecognized、missing 与 partial', () => {
  expect(extractSkills([], complete, true, null).state).toBe('empty');
  expect(extractSkills([], { ...complete, complete: false, reason: 'body_partial' }, true, null).state)
    .toBe('partial');
  expect(extractSkills([], { ...complete, complete: false, reason: 'body_unavailable' }, false, null).state)
    .toBe('missing');
  expect(extractSkills(['<skills>坏行没有冒号</skills>'], complete, true, null).state)
    .toBe('unrecognized');
  const present = extractSkills(['<skills>\n- anysearch: 实时搜索\n</skills>'], complete, true, null);
  expect(present.state).toBe('present');
  expect(present.items).toEqual([{ name: 'anysearch', description: '实时搜索', format: 'tagged' }]);
});

test('未知 agent 仍解析共享格式，不从标签推断身份', () => {
  const view = capabilityView({
    protocol: 'anthropic',
    request: { system: '<skills>\n- archify: 画图\n</skills>' },
    systemTexts: ['<skills>\n- archify: 画图\n</skills>'],
    coverage: complete,
    systemPresent: true,
    agent: null,
  });
  expect(view.skills.items.map(item => item.name)).toEqual(['archify']);
  expect(view.agent).toBeNull();
});

test('Claude Code 标题后只吃连续列表行，空行结束', () => {
  const text = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- anysearch: Real-time search',
    '- archify: Diagrams',
    '',
    '- 空行之后不算',
  ].join('\n');
  const result = extractSkills([text], complete, true, 'claude');
  expect(result.items.map(item => item.name)).toEqual(['anysearch', 'archify']);
});

test('能力数据保留原文，不执行也不转义为 HTML', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const view = capabilityView({
    protocol: 'anthropic',
    request: { tools: [{ name: payload, description: payload }] },
    systemTexts: [`<skills>\n- ${payload}: ${payload}\n</skills>`],
    coverage: complete,
    systemPresent: true,
    agent: null,
  });
  expect(view.tools.items[0]?.name).toBe(payload);
  expect(view.skills.items[0]?.name).toBe(payload);
});
