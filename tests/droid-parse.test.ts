import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDroidLine, emptyDroidState, parseDroidLine, parseDroidSettings,
} from '../src/sources/droid/parse';
import type { DroidParserState } from '../src/sources/droid/parse';
import {
  discoverDroidTranscripts, droidSessionsRoot, selectDroidTranscripts,
} from '../src/sources/droid/discover';

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function line(value: unknown): string {
  return JSON.stringify(value);
}

function reduceAll(texts: string[]): { state: DroidParserState; calls: ReturnType<typeof applyDroidLine>['call'][] } {
  let state = emptyDroidState();
  const calls: ReturnType<typeof applyDroidLine>['call'][] = [];
  for (const text of texts) {
    const step = applyDroidLine(state, parseDroidLine(text));
    expect(step.error).toBeNull();
    state = step.state;
    if (step.call !== null) calls.push(step.call);
  }
  return { state, calls };
}

const SESSION = line({
  type: 'session_start', id: 'session-synth-1', title: 'synth title', cwd: '/work/synth-a',
  lastCwd: '/work/synth-b', parent: null, version: 2,
});
const USER_A = line({
  type: 'message', id: 'msg-u1', timestamp: iso(T0),
  message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
});
const ASSISTANT_A = line({
  type: 'message', id: 'msg-a1', timestamp: iso(T0 + 2_000),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'reply one' }],
    modelId: 'synth-model', openaiMessageId: 'gen-1790000000000-abcdef', reasoningEffort: 'high',
  },
});
const USER_B = line({
  type: 'message', id: 'msg-u2', timestamp: iso(T0 + 5_000),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
});
const ASSISTANT_B = line({
  type: 'message', id: 'msg-a2', timestamp: iso(T0 + 6_500),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'reply two' }],
    modelId: 'synth-model', openaiMessageId: '1790000000000abc',
  },
});

test('普通会话：assistant 消息逐条建调用，请求体是截至该行之前的消息', () => {
  const { state, calls } = reduceAll([SESSION, USER_A, ASSISTANT_A, USER_B, ASSISTANT_B]);
  expect(calls).toHaveLength(2);
  expect(state.messages.map(message => message.id)).toEqual(['msg-u1', 'msg-a1', 'msg-u2', 'msg-a2']);
  const [first, second] = calls;
  expect(first).toMatchObject({
    sessionId: 'session-synth-1', messageId: 'msg-a1', isSubagent: false, parentSessionId: null,
    cwd: '/work/synth-a', modelRequested: 'synth-model',
    responseId: 'gen-1790000000000-abcdef', responseIdNorm: 'gen-1790000000000-abcdef',
    reasoningEffort: 'high',
  });
  expect(first!.requestMessages.map(message => message.role)).toEqual(['user']);
  expect(second!.requestMessages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
  // started_ms 取该 assistant 行之前最近一条消息的时间，不取 assistant 自身时间。
  expect(second!.requestMessages[2]).toEqual({
    role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
  });
  expect(calls[0]!.replyContent).toEqual([{ type: 'text', text: 'reply one' }]);
});

test('started_ms 取前一条消息时间；assistant 自身时间不顶替', () => {
  const { calls } = reduceAll([SESSION, USER_A, ASSISTANT_A]);
  expect(calls[0]!.startedMs).toBe(T0);
  const state = applyDroidLine(emptyDroidState(), parseDroidLine(SESSION)).state;
  expect(state.lastMessageMs).toBeNull();
  const withUser = applyDroidLine(state, parseDroidLine(USER_A));
  expect(withUser.state.lastMessageMs).toBe(T0);
});

test('缺 modelId 仍建调用，模型留空；缺时间且无前一条消息记坏行', () => {
  const noModel = line({
    type: 'message', id: 'msg-a3', timestamp: iso(T0 + 9_000),
    message: { role: 'assistant', content: [{ type: 'text', text: 'no model' }] },
  });
  const { calls } = reduceAll([SESSION, USER_A, noModel]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.modelRequested).toBeNull();
  expect(calls[0]!.responseIdNorm).toBeNull();

  const noTime = line({
    type: 'message', id: 'msg-a4',
    message: { role: 'assistant', content: [{ type: 'text', text: 'no time' }] },
  });
  const step = applyDroidLine(emptyDroidState(), parseDroidLine(SESSION));
  expect(applyDroidLine(step.state, parseDroidLine(noTime)).error).toBe('droid_message_time_missing');
});

test('fork：复制段进消息窗口但零建行，锚点之后的 assistant 才建行', () => {
  const forked = line({
    type: 'session_start', id: 'session-fork-1', cwd: '/work/synth-a',
    forkedAtMessageId: 'msg-a1', callingSessionId: null, version: 2,
  });
  const assistantAfter = line({
    type: 'message', id: 'msg-a2', timestamp: iso(T0 + 7_000),
    message: { role: 'assistant', content: [{ type: 'text', text: 'fork reply' }], modelId: 'synth-model' },
  });
  const { state, calls } = reduceAll([forked, USER_A, ASSISTANT_A, assistantAfter]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.messageId).toBe('msg-a2');
  // 复制段的三条消息都是 fork 上下文。
  expect(calls[0]!.requestMessages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(state.forkReached).toBe(true);
});

test('子代理：actor/session 取自身 id，parent_agent 取 callingSessionId', () => {
  const child = line({
    type: 'session_start', id: 'session-child-1', cwd: '/work/synth-a',
    callingSessionId: 'session-parent-1', version: 2,
  });
  const { calls } = reduceAll([child, USER_A, ASSISTANT_A]);
  expect(calls[0]).toMatchObject({
    sessionId: 'session-child-1', isSubagent: true, parentSessionId: 'session-parent-1',
  });
});

test('bad line / 未知类型：坏行给原因，未知类型原样跳过', () => {
  expect(parseDroidLine('{nope')).toMatchObject({ kind: 'invalid', reason: 'droid_invalid_json' });
  expect(parseDroidLine(line({ type: 'message', id: 'm', message: { role: 'user' } })))
    .toMatchObject({ kind: 'invalid', reason: 'droid_message_content_invalid' });
  expect(parseDroidLine(line({ type: 'todo_state', items: [] })))
    .toMatchObject({ kind: 'other', lineType: 'todo_state' });
  // 先有 message 没有 session_start：不猜会话，报语义坏行。
  const step = applyDroidLine(emptyDroidState(), parseDroidLine(USER_A));
  expect(step.error).toBe('droid_session_missing');
});

test('settings：tokenUsage 累计读数、缺键留空、坏 JSON 报错', () => {
  const parsed = parseDroidSettings(JSON.stringify({
    tokenUsage: {
      inputTokens: 1200, outputTokens: 340, cacheCreationTokens: 50, cacheReadTokens: 900,
      thinkingTokens: 40, factoryCredits: 1.25,
    },
    model: 'synth-model', reasoningEffort: 'medium',
  }));
  expect(parsed).toEqual({
    ok: true,
    value: {
      model: 'synth-model', inputTokens: 1200, outputTokens: 340,
      cacheCreationTokens: 50, cacheReadTokens: 900, thinkingTokens: 40,
      factoryCredits: 1.25, reasoningEffort: 'medium',
    },
  });
  expect(parseDroidSettings('{}')).toMatchObject({
    ok: true, value: { model: null, inputTokens: null, outputTokens: null },
  });
  expect(parseDroidSettings('not json')).toMatchObject({ ok: false, reason: 'droid_settings_invalid_json' });
});

test('发现：根目录与一层子目录的 jsonl，忽略 settings 与其他扩展名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-droid-discover-'));
  try {
    mkdirSync(join(dir, 'work-a'));
    writeFileSync(join(dir, 'root-session.jsonl'), '{}\n');
    writeFileSync(join(dir, 'root-session.settings.json'), '{}');
    writeFileSync(join(dir, 'work-a', 'child-session.jsonl'), '{}\n');
    writeFileSync(join(dir, 'work-a', 'notes.txt'), 'x');
    const files = discoverDroidTranscripts(dir);
    expect(files.map(file => file.name).sort()).toEqual(['root-session.jsonl', 'work-a/child-session.jsonl']);
    const selected = selectDroidTranscripts(files, () => null);
    expect(selected.map(file => file.name).sort()).toEqual(['root-session.jsonl', 'work-a/child-session.jsonl']);
    // 已读尽为 0 的文件不取；未读尽按剩余字节排序。
    const ranged = selectDroidTranscripts(files, name => name === 'root-session.jsonl'
      ? { generation: 'g', committedOff: 3 } : null);
    expect(ranged.map(file => file.name)).toEqual(['work-a/child-session.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取件上限：文件数与字节预算截断，超出预算的大文件仍取一个', () => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    name: `${index}.jsonl`, path: `/tmp/${index}.jsonl`, dir: '/tmp', size: (index + 1) * 100,
  }));
  expect(selectDroidTranscripts(files, () => null, { maxFiles: 2 }).map(file => file.name))
    .toEqual(['2.jsonl', '1.jsonl']);
  expect(selectDroidTranscripts(files, () => null, { maxBytes: 1 }).map(file => file.name))
    .toEqual(['2.jsonl']);
});

test('sessions 根目录：FACTORY_HOME_OVERRIDE 优先，否则 ~/.factory/sessions', () => {
  expect(droidSessionsRoot({ FACTORY_HOME_OVERRIDE: '/custom/factory' }, '/home/synth'))
    .toBe('/custom/factory/.factory/sessions');
  expect(droidSessionsRoot({}, '/home/synth')).toBe('/home/synth/.factory/sessions');
});