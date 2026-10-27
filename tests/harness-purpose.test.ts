import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PURPOSE_RULES, classifyPurposeWithRules, type HarnessPurposeRule,
} from '../src/harness/purpose';
import { PURPOSE_VERSION, type PurposeView } from '../src/semantics';

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

/** 合成登记项：无条件按给定 kind 认定；弃权场景直接内联 `decide: () => null`。 */
function syntheticRule(agent: string, kind: string): HarnessPurposeRule {
  return {
    agent,
    decide: () => ({
      status: 'recognized', version: PURPOSE_VERSION, rule: `synthetic.${kind}.v1`,
      signals: [], chain: 'exclude', kind, modelTitle: null,
    }),
  };
}

test('登记次序即优先级：同 agent 的规则按数组先后取胜', () => {
  const first = syntheticRule('synthetic', 'first');
  const second = syntheticRule('synthetic', 'second');
  const decision = classifyPurposeWithRules([first, second], view({ agent: 'synthetic' }));
  expect(decision.kind).toBe('first');
});

test('合成规则只命中自家标签，既有登记与通用回退不受扰动', () => {
  const rules = [...PURPOSE_RULES, syntheticRule('synthetic', 'synthetic_kind')];
  // 自家标签命中合成规则。
  expect(classifyPurposeWithRules(rules, view({ agent: 'synthetic' })).kind)
    .toBe('synthetic_kind');
  // claude 指纹仍走 claude 分类器，合成规则不插队。
  const classifier = classifyPurposeWithRules(rules, view({
    systemTexts: ['You are a security monitor for autonomous AI coding agents.'],
    stopSequences: ['</block>'],
  }));
  expect(classifier.kind).toBe('auto-mode-classifier');
  // 未知标签不命中任何登记项，落回通用来源判定。
  const generic = classifyPurposeWithRules(rules, view({
    agent: 'unknown-harness',
    source: { state: 'single', value: 'title' },
  }));
  expect(generic.kind).toBe('title');
});

test('规则弃权返回 null，落回通用判定', () => {
  const abstain: HarnessPurposeRule = { agent: 'synthetic', decide: () => null };
  const decision = classifyPurposeWithRules([abstain], view({
    agent: 'synthetic',
    replyText: '<title>标题</title>',
  }));
  expect(decision.kind).toBe('title');
  expect(decision.rule).toBe('title.reply.v1');
});

test('生产登记只含已知品牌标签', () => {
  expect(PURPOSE_RULES.map(rule => rule.agent)).toEqual(['claude', 'hermes', 'omp']);
});

/**
 * 品牌字面不回流共享文件：通用判定与结算是无 Harness 知识的，专属指纹只在
 * src/harness/ 与登记处。按整词匹配，compaction 这类域名词不误伤；命中时把
 * 规则写进 adapter 并登记，而不是在此放行。
 */
test('semantics 与 request-purpose 源码不出现 claude/hermes/omp 品牌字面', () => {
  for (const file of ['../src/semantics.ts', '../src/request-purpose.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(/\b(claude|hermes|omp)\b/i.test(source)).toBe(false);
  }
});
