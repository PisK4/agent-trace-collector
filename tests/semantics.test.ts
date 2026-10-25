import { expect, test } from 'bun:test';
import { classifyPurpose } from '../src/harness/purpose';
import {
  PURPOSE_VERSION, parseTitleReply, titleFromReply,
  type PurposeView,
} from '../src/semantics';

function view(over: Partial<PurposeView> = {}): PurposeView {
  return {
    parse: 'ok',
    agent: 'claude',
    systemTexts: [],
    stopSequences: [],
    messageCount: 2,
    toolCount: 0,
    replyText: '<block>no',
    userBlockHeads: [],
    source: { state: 'missing', value: null },
    stored: {
      version: null, status: 'missing', rule: null, signals: [],
      chain: 'participate', kind: 'chat', modelTitle: null,
    },
    ...over,
  };
}

test('分类器强指纹优先于来源与标题', () => {
  const decision = classifyPurpose(view({
    systemTexts: ['You are a security monitor for autonomous AI coding agents.'],
    stopSequences: ['</block>'],
    source: { state: 'single', value: 'title' },
    stored: { ...view().stored, kind: 'title', modelTitle: '旧标题' },
  }));
  expect(decision).toMatchObject({
    status: 'recognized', version: PURPOSE_VERSION, kind: 'auto-mode-classifier',
    chain: 'exclude', rule: 'claude.auto-mode-classifier.v1',
  });
  expect(decision.signals).toContain('classifier.verdict.pass');
});

test('普通 block 回复没有指纹时不分类', () => {
  const decision = classifyPurpose(view({ systemTexts: ['ordinary'] }));
  expect(decision).toMatchObject({
    status: 'unrecognized', kind: 'chat', chain: 'participate', version: PURPOSE_VERSION,
  });
});

test('同一指纹在非 claude agent 上不分类', () => {
  const decision = classifyPurpose(view({
    agent: 'omp',
    systemTexts: ['You are a security monitor for autonomous AI coding agents.'],
    stopSequences: ['</block>'],
  }));
  expect(decision.kind).toBe('chat');
});

test('分类器缺少回复仍识别，判定未知', () => {
  const decision = classifyPurpose(view({
    systemTexts: ['security monitor for autonomous AI coding agents'],
    stopSequences: ['</block>'], replyText: null,
  }));
  expect(decision.kind).toBe('auto-mode-classifier');
  expect(decision.signals).toContain('classifier.verdict.unknown');
});

test('标题回复两种形状都识别', () => {
  expect(titleFromReply('<title lang="zh">  修复 登录  </title>')).toBe('修复 登录');
  expect(titleFromReply('{"title":"修复登录"}')).toBe('修复登录');
  expect(parseTitleReply('{"title":"x"}')?.shape).toBe('json-title');
  const decision = classifyPurpose(view({ replyText: '<title>修复登录</title>' }));
  expect(decision).toMatchObject({
    kind: 'title', chain: 'exclude', modelTitle: '修复登录', rule: 'title.reply.v1',
  });
});

test('已存 title 在回复不再是标题时保持兼容', () => {
  const decision = classifyPurpose(view({
    replyText: 'ordinary answer',
    stored: {
      version: 1, status: 'recognized', rule: 'legacy.title',
      signals: ['title.stored'], chain: 'exclude', kind: 'title', modelTitle: '旧标题',
    },
  }));
  expect(decision).toMatchObject({
    status: 'recognized', kind: 'title', chain: 'exclude',
    modelTitle: '旧标题', rule: 'title.stored.v1',
  });
});

test('来源 kind 只对 title 别名排除，其它值保持参与', () => {
  const title = classifyPurpose(view({
    replyText: null, source: { state: 'single', value: 'title' },
  }));
  expect(title).toMatchObject({ kind: 'title', chain: 'exclude' });
  const other = classifyPurpose(view({
    source: { state: 'agree', value: 'compaction' },
  }));
  expect(other).toMatchObject({
    kind: 'source:compaction', chain: 'participate', status: 'recognized',
  });
});

test('来源冲突不参与判定，回落到标题兼容', () => {
  const decision = classifyPurpose(view({
    replyText: '<title>标题</title>',
    source: { state: 'conflict', value: null },
  }));
  expect(decision.kind).toBe('title');
  expect(decision.signals).toContain('title.reply.title-tag');
});

test('正文不可读时保留旧解释，没有旧解释则记缺失', () => {
  const retained = classifyPurpose(view({
    parse: 'missing', replyText: null,
    stored: {
      version: 1, status: 'recognized', rule: 'legacy.title',
      signals: ['title.stored'], chain: 'exclude', kind: 'title', modelTitle: '旧标题',
    },
  }));
  expect(retained).toMatchObject({
    status: 'retained', version: 1, kind: 'title', chain: 'exclude',
    modelTitle: '旧标题', rule: 'legacy.title',
  });
  const missing = classifyPurpose(view({ parse: 'missing', replyText: null }));
  expect(missing).toMatchObject({
    status: 'missing', version: null, kind: 'chat', chain: 'participate',
  });
});

test('正文不可读时来源 kind 不覆盖已存分类器', () => {
  const retained = classifyPurpose(view({
    parse: 'missing', replyText: null,
    source: { state: 'single', value: 'chat' },
    stored: {
      version: 2, status: 'recognized', rule: 'claude.auto-mode-classifier.v1',
      signals: ['classifier.agent.claude'], chain: 'exclude',
      kind: 'auto-mode-classifier', modelTitle: null,
    },
  }));
  expect(retained).toMatchObject({
    status: 'retained', kind: 'auto-mode-classifier',
    chain: 'exclude', version: 2,
  });
});

test('不支持的协议没有旧解释时记 unsupported', () => {
  const decision = classifyPurpose(view({ parse: 'unsupported', replyText: null }));
  expect(decision).toMatchObject({ status: 'unsupported', version: null });
});

test('OMP skill 描述压缩指纹：任一 user 块块首命中即旁路，锚点失配不误判', () => {
  const decision = classifyPurpose(view({
    agent: 'omp',
    replyText: null,
    userBlockHeads: [
      '<system-reminder>Synthetic session context</system-reminder>',
      'Compress into one routing hint of at most 12 words: The agent is reading the trace collector schema docs.',
    ],
  }));
  expect(decision).toMatchObject({
    status: 'recognized', version: PURPOSE_VERSION, kind: 'skill_hint',
    chain: 'exclude', rule: 'omp.skill-hint.v1', modelTitle: null,
  });
  expect(decision.signals).toContain('skill-hint.agent.omp');
  // 锚点在块中段：不是块首，不命中。
  const midBlock = classifyPurpose(view({
    agent: 'omp',
    userBlockHeads: ['先看别的内容。 Compress into one routing hint of at most 12 words: x'],
  }));
  expect(midBlock.chain).toBe('participate');
  // 同指纹在非 omp agent 上不命中。
  const otherAgent = classifyPurpose(view({
    agent: 'claude',
    userBlockHeads: ['Compress into one routing hint of at most 12 words: x'],
  }));
  expect(otherAgent.chain).toBe('participate');
  // 模板措辞漂移静默退化。
  const drifted = classifyPurpose(view({
    agent: 'omp',
    userBlockHeads: ['Summarize into one routing hint: x'],
  }));
  expect(drifted.chain).toBe('participate');
});
