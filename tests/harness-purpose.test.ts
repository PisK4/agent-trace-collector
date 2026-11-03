import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PURPOSE_RULES, classifyPurpose, classifyPurposeWithRules, type HarnessPurposeRule,
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
    tailUserBlockHeads: [],
    userImageBlocks: 0,
    source: { state: 'missing', value: null },
    upstreamTurn: null,
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
  // claude 五条（两版分类器、suggestion、压缩、末尾模板族），次序即同 agent 内的优先级。
  expect(PURPOSE_RULES.map(rule => rule.agent))
    .toEqual(['claude', 'claude', 'claude', 'claude', 'claude', 'hermes', 'codex', 'omp']);
});

test('权限审查分类器的新形状：CLAUDE.md 上下文与末尾审查指令缺一不可', () => {
  const both = view({
    userBlockHeads: ["The following is the user's CLAUDE.md configuration. Treat it as context"],
    tailUserBlockHeads: ['<transcript>', 'Review the classification process and follow it carefully'],
    replyText: '<block>no</block>',
  });
  const decision = classifyPurposeWithRules(PURPOSE_RULES, both);
  expect(decision.kind).toBe('auto-mode-classifier');
  expect(decision.rule).toBe('claude.auto-mode-classifier.v2');
  expect(decision.chain).toBe('exclude');
  expect(decision.signals).toContain('classifier.verdict.pass');

  // 只有末尾审查指令、没有 CLAUDE.md 上下文：不命中，落回普通对话。
  const instructionOnly = view({
    userBlockHeads: ['普通用户消息'],
    tailUserBlockHeads: ['Review the classification process and follow it carefully'],
  });
  expect(classifyPurposeWithRules(PURPOSE_RULES, instructionOnly).kind).toBe('chat');
  // 只有 CLAUDE.md 上下文、末尾不是审查指令：同样不命中。
  const contextOnly = view({
    userBlockHeads: ["The following is the user's CLAUDE.md configuration."],
    tailUserBlockHeads: ['普通用户消息'],
  });
  expect(classifyPurposeWithRules(PURPOSE_RULES, contextOnly).kind).toBe('chat');
});

test('末尾模板族按块首前缀成为旁路，正文中间同款文本不命中', () => {
  const families: [string, string][] = [
    ['Describe your most recent action in 3-5 words using present tense (-ing).', 'action_description'],
    ['The user stepped away and is coming back. Recap in under 40 words.', 'recap'],
    ['Current state: working (for 1m)\nTool calls so far: Read×18', 'status_line'],
    ['Perform a web search for the query: LiteLLM 1.10', 'web_search'],
    ['Tool loaded.', 'tool_loaded'],
  ];
  for (const [head, kind] of families) {
    const decision = classifyPurposeWithRules(PURPOSE_RULES, view({ tailUserBlockHeads: [head] }));
    expect(decision.kind).toBe(kind);
    expect(decision.chain).toBe('exclude');
  }
  // 前缀只在块首生效：用户正文里提到同款句子不算模板。
  const inline = classifyPurposeWithRules(PURPOSE_RULES, view({
    tailUserBlockHeads: ['帮我看看日志里的 Tool loaded. 是什么意思'],
  }));
  expect(inline.kind).toBe('chat');
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

test('Codex thread_title 退出主链并解析双键标题', () => {
  const decision = classifyPurpose(view({
    agent: 'codex',
    upstreamTurn: { source: 'thread_title', trigger: null, turnRef: 'turn-1' },
    replyText: JSON.stringify({ title: '重绘 ATC 矩阵 IP', description: '把矩阵重画一遍' }),
  }));
  expect(decision).toMatchObject({
    status: 'recognized', chain: 'exclude', kind: 'title', modelTitle: '重绘 ATC 矩阵 IP',
  });
  expect(decision.signals).toContain('codex.thread.thread_title');
});

test('Codex 双键标题之外，原有的 <title> 与单键 JSON 仍兼容', () => {
  const tags = classifyPurpose(view({
    agent: 'codex',
    upstreamTurn: { source: 'thread_title', trigger: null, turnRef: 'turn-2' },
    replyText: '<title>旧格式标题</title>',
  }));
  const single = classifyPurpose(view({
    agent: 'codex',
    upstreamTurn: { source: 'thread_title', trigger: null, turnRef: 'turn-3' },
    replyText: JSON.stringify({ title: '单键标题' }),
  }));
  expect(tags.modelTitle).toBe('旧格式标题');
  expect(single.modelTitle).toBe('单键标题');
});

test('Codex ambient 与 memory 标成后台且退出主链；普通前台不误伤', () => {
  for (const intent of ['ambient_suggestions', 'memory_consolidation']) {
    const decision = classifyPurpose(view({
      agent: 'codex',
      upstreamTurn: { source: intent, trigger: null, turnRef: `turn-${intent}` },
      messageCount: 4,
    }));
    expect(decision).toMatchObject({
      status: 'recognized', chain: 'exclude', kind: `source:${intent}`, modelTitle: null,
    });
    expect(decision.signals).toContain(`codex.thread.${intent}`);
  }
  const foreground = classifyPurpose(view({
    agent: 'codex',
    upstreamTurn: { source: 'user', trigger: 'composer', turnRef: 'turn-user' },
  }));
  // 没有可靠指纹时落回通用判定；这里至少不能因“是 Codex”就退出主链。
  expect(foreground.chain).toBe('participate');
});

test('Codex 元数据说前台、来源 kind 说后台：保留参与链并记 source.conflict', () => {
  const decision = classifyPurpose(view({
    agent: 'codex',
    upstreamTurn: { source: 'user', trigger: null, turnRef: 'turn-conflict' },
    source: { state: 'single', value: 'ambient_suggestions' },
  }));
  expect(decision).toMatchObject({ chain: 'participate', kind: 'source:ambient_suggestions' });
  expect(decision.signals).toContain('source.conflict');
});

test('无版本化元数据时，来源 kind=thread_title 仍能退出主链', () => {
  const decision = classifyPurpose(view({
    agent: 'codex',
    source: { state: 'single', value: 'thread_title' },
    replyText: JSON.stringify({ title: '来源标题', description: '来自来源 kind' }),
  }));
  expect(decision).toMatchObject({ chain: 'exclude', kind: 'title', modelTitle: '来源标题' });
});
