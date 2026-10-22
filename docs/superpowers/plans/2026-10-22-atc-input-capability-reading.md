# ATC 输入解释与能力阅读实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行会话缺少上述技能时，逐任务执行相同测试与复核；不虚构技能调用。本文只编排 E 批的合成回归、服务端读模型与原生页面改造，不授权真实库回填、服务切换、push 或提交。每项提交步骤只在已获提交授权时执行，否则保留可审阅改动。

**Goal:** 把 harness 包装解释、消息级展示解释、工具与技能能力提取集中到服务端，让原生页面只消费结果；同时补齐尝试链、上下文占用、未知类别与角色的中性显示、分页方向、flags、滚动保持和复制。

**Architecture:** 新增两个纯 TypeScript Module：`src/input-interpretation.ts` 负责用户输入与消息角色的展示解释，`src/capabilities.ts` 负责协议工具定义与 Agent 技能声明。`src/protocols.ts` 在正文分页结果中附带服务端解释与能力视图，`src/queries.ts` 只读安全投影 `route_summary.z`、`source_facts_json` 与派生状态。原生 JavaScript 删除重复清洗和解析，只渲染服务端结果；不引入构建步骤。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`、原生 JavaScript；不增加第三方运行依赖。

**Spec:** [架构演进 v2 的正文与阅读](../../architecture-evolution-v2.md#正文与阅读)、[请求语义独立于会话归属](../../architecture-evolution-v2.md#请求语义独立于会话归属)、[联合评审的页面纠错与阅读增强](../../agent-request-kind-review.md#页面纠错阅读增强与新来源分别验收)、[能力提取迁移](../../agent-request-kind-review.md#能力提取的迁移不要求长期复制全文)、[包装迁移不能同时改写指纹](../../agent-request-kind-review.md#包装迁移不能同时改写指纹)及[实施总入口](2026-10-22-atc-evolution-implementation.md)。C 批预期见 [长期信息与显式重建](2026-10-22-atc-durable-rebuild.md)，D 批预期见 [请求用途](2026-10-22-atc-request-purpose.md)。本计划不重写 C 的写入路径、D 的语义规则、B 的来源映射或 F 的容量实验。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL 与单 writer、独立只读连接、原生 JavaScript 页面，不增加第三方运行依赖。
- 监听地址写死 `127.0.0.1`；数据目录在仓库外，文件权限 0600、目录 0700。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。
- 正文与路由内容在页面一律转义；复制走纯文本，不把 HTML 字符串写进剪贴板。
- 不修改 `block.fingerprint`、`src/fingerprint.ts` 的算法、`ADAPTER_VERSION` 或 `REDACT_VERSION`；展示清洗只影响显示，不参与内容等价。
- 不新增长期复制技能描述或工具 schema 的表；能力视图按正文读取即时计算，正文回收后返回缺失状态。
- `route_summary.z` 只读消费 C 的 format 2；E 不写 format 2，不建第三份路由摘要，不读取 `raw_route.payload_json` 或 `source_facts_json` 的任意键。
- 详情接口只返回安全挑选字段，不返回 account、host、`who`、`id`、原始 `source_facts_json` 或完整任意 JSON。
- 未知 `req_kind`、`chain_role`、协议角色、part kind、fail 码原样保留；未知值使用中性标签与有效颜色，不从命名推断行为。
- 派生状态不是 `clean` 且链结果不是 `current` 时，不显示 confirmed 关系，不标记新增消息，不把旧摘要冒充当前结果。
- 所有测试命令在 ATC 仓库根执行；运行检查使用新建临时库，不触碰默认数据路径。
- 每个提交步骤都把本计划所属 Agent Note 放进同一提交；Task 1 在 `.agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md` 创建 proposed 版本，后续任务更新同一文件，Task 12 再移动到 `.agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md` 并改为 implemented。proposed 文件只使用 `## Problem`、`## Proposal`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks`，不提前写 implemented 章节。未获提交授权时不执行提交。

---

## 范围、依赖与文件

编写基准 `00e20a2`。下表行号只作定位提示，执行时按函数名定位。E 覆盖 v2 阶段 4 的输入解释、能力阅读、消息级展示、尝试链、上下文提示、滚动与复制；不覆盖 B 的来源字段、C 的迁移与保留、D 的用途分类、F 的容量测量。

| 文件 | 职责与计划改动 |
| --- | --- |
| `src/input-interpretation.ts` | 新增：用户文本与消息角色的纯展示解释；保留原文；不碰指纹 |
| `src/capabilities.ts` | 新增：工具定义与技能声明的纯提取；区分 present/empty/unrecognized/missing/partial |
| `src/derive.ts` | 标题、摘要与首末用户文本改用输入解释；不改变派生结果语义 |
| `src/protocols.ts` | `BodyPage` 增加消息解释、覆盖状态与能力视图；只解压 system 块做能力提取 |
| `src/queries.ts` | 安全投影 route z、source_facts、派生状态、尝试链、上下文阅读；flags 聚合；未知类别与角色不再折叠 |
| `web/body-view.js` | 删除重复清洗与能力解析；消费服务端解释；part 标签与颜色；复制文本 |
| `web/app.js` | 消费服务端解释；尝试链与上下文阅读；未知类别中性显示；滚动保持；分页方向文案 |
| `web/index.html` | 加载更晚请求的按钮文案；part 未知颜色变量 |
| `tests/input-interpretation.test.ts` | 新增：包装、插话、嵌套畸形、多条用户消息、未知 agent |
| `tests/capabilities.test.ts` | 新增：工具两种协议形状、技能四种状态、未知 agent、XSS 数据 |
| `tests/protocols.test.ts`、`tests/body-api.test.ts` | 消息解释、原文保留、覆盖状态 |
| `tests/body-view.test.ts`、`tests/web.test.ts` | 能力渲染、未知类别、part 颜色、复制、滚动恢复 |
| `tests/queries.test.ts` | route z 安全投影、source_facts、尝试链、上下文、flags、未知类别 |
| `tests/derive.test.ts` | 标题行为保持、多条用户消息、未知 agent、指纹不变 |
| `docs/architecture-design.md` | 代码交付时补输入解释与能力阅读的现行契约 |
| `.agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md` | 实施时创建，记录集中到服务端的提案、验收与风险 |
| `.agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md` | Task 12 将同一 note 移入 implemented 并改写为交付后的决策与代价 |

### 与 B/C/D/F 的边界

B 负责来源字段读取、模型写入路径和脱敏顺序；E 不修 `src/sources/magpie.ts`、`src/reconcile.ts` 的映射，也不补历史字段。C 负责 `route_summary.z` format 2、`request.model_provider`、`source_facts_json`、`projection_meta`、请求修订与历史保留；E 只读这些结果，缺列时停在对应任务，不自行加列。D 负责 `src/semantics.ts`、`req_kind`、`chain_role`、`model_title`、用途规则与链参与策略；E 不实现分类器，不从文本推断用途。F 负责容量基线；E 只报告新增读取量，不宣称吞吐改善。

### 与 D 共享的最小协议输入

D 的 `src/semantics.ts` 与 E 的两个 Module 共用 `src/protocols.ts` 已有的协议视图，不建全能 Profile。E 需要的输入只有：

```ts
export type ProtocolInput = {
  protocol: string;
  request: unknown;
  reply: unknown;
  messages: readonly unknown[];
  agent: string | null;
};
```

`messages` 来自已解码正文或调用方已有的骨架；`agent` 只作为规则标签，不参与身份判定。D 的用途分类可以只读 `request.system`、`request.stop_sequences` 与末条消息；E 的输入解释只读单条消息文本；E 的能力提取只读 `request.tools`、`request.functions`、`request.system` 与 role=system 的消息。三方都不接受数据库句柄、网络或写库能力。

### 发给 C 的 route_summary.z format 2 字段

C 在现有 summary 对象上新增 `format: 2` 与下列字段，保留 `order`、`tries`、`affinity` 和已脱敏 `error`。E 只读这些字段，不要求新增第三份摘要：

```ts
type RouteSummaryZ = {
  format: 2;
  route_id: number;
  time_ms: number;
  model: string | null;
  served: string | null;
  provider: string | null;
  status: number | null;
  ms: number | null;
  ttft: number | null;
  flow: number | null;
  first_text: number | null;
  kind: string | null;
  folder: string | null;
  effort: string | null;
  prompt: {
    tokens: number;
    counted: boolean;
    window: number | null;
    held: boolean | null;
    parts: unknown[];
  } | null;
  error: string | null;
  order: unknown | null;
  tries: unknown[] | null;
  affinity: unknown | null;
  saved_at: number;
};
```

E 对 `order`、`tries`、`affinity` 再做安全挑选，去掉 `who`、`id`、account、host 与任意嵌套对象。旧行没有 `format` 时按 format 1 处理，`kind`、`folder`、`effort`、`prompt` 返回 null，不从 `raw_route.payload_json` 补。

### 发给 C 的 source_facts_json 与 projection_meta_json

C 写两列：`source_facts_json` 只放来源事实，`projection_meta_json` 只放投影状态。两者都不放组状态。`selected.state` 只允许 `final`、`failed`、`pending_final`、`retained`、`missing`。`hook.models` 是有界值对象，`hook.successes` 是 `success` 与 `failure` 的字符串集合。`families.prompt.state` 只有 `recomputed`、`retained`、`missing`；`invalid_input` 是 `reason`，不是 state：

```ts
type BoundedValues<T> = {
  values: T[];
  overflow: number;
  missing: number;
  invalid: number;
};

type SourceFactsJson = {
  selected: {
    ref: string | null;
    state: 'final' | 'failed' | 'pending_final' | 'retained' | 'missing';
    modelProvider: string | null;
    served: string | null;
    effort: string | null;
    tierAsked: string | null;
    tierSent: string | null;
    tierServed: string | null;
    error: string | null;
    errorType: string | null;
  } | null;
  hook: {
    models: BoundedValues<string>;
    successes: ('success' | 'failure')[];
  } | null;
};

type ProjectionMetaJson = {
  families: {
    prompt: {
      actualVersion: number | null;
      state: 'recomputed' | 'retained' | 'missing';
      reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
      basis: string | null;
    };
  };
};
```

`request.model_provider TEXT`、`request.source_facts_json`、`request.projection_meta_json` 都由 C 增加，E 只读。C 是前置依赖：缺任一列就停在 Task 7，不跳过集成断言，也不从旧列猜一份替代状态。E 的详情接口返回挑选后的 `source_facts`、`projection_meta`、`derivation` 和 `prompt`，不返回原始 JSON。`account`、`host`、`who`、`id`、任意未知键都不得进入详情响应。

### 组状态消费 C 的 derived_state

C 的查询投影在同一只读快照里给出 `derived_state: 'dirty' | 'current' | 'retained' | 'legacy'` 与 `summary_state: 'recomputed' | 'retained' | 'legacy'`。E 不读 `derive_queue`，不读任何持久组字段，也不自己判定 revision 与 algorithm。C 已保证 `current` 只在组 clean、`input_revision=published_revision`、`target_algorithm=published_algorithm` 且 `purpose_pending=0` 时返回。

`derivationOf` 只做值域映射，不查库：

```ts
type DerivationReading = {
  state: 'clean' | 'dirty' | 'retained' | 'legacy' | 'unknown';
  chain_state: 'current' | 'retained' | 'unavailable';
  summary_state: 'current' | 'retained' | 'unavailable';
  reason: string | null;
};

function derivationOf(input: {
  derived_state: string | null;
  summary_state: string | null;
}): DerivationReading {
  if (input.derived_state === 'current') {
    return {
      state: 'clean',
      chain_state: 'current',
      summary_state: input.summary_state === 'recomputed' ? 'current'
        : input.summary_state === null ? 'unavailable' : 'retained',
      reason: null,
    };
  }
  if (input.derived_state === 'dirty') {
    return { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' };
  }
  if (input.derived_state === 'retained') {
    return { state: 'retained', chain_state: 'retained', summary_state: 'retained', reason: 'derived_retained' };
  }
  if (input.derived_state === 'legacy') {
    return { state: 'legacy', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_legacy' };
  }
  return { state: 'unknown', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_state_unknown' };
}
```

### 派生状态的使用规则

E 只认一个门：`derivation.state === 'clean' && derivation.chain_state === 'current'` 时，链关系与新增消息才可显示为当前结果。`dirty` 显示重建中，`retained` 显示历史保留，`legacy` 显示旧算法结果，`unknown` 显示状态未知。任何非当前状态都不显示 confirmed、续自上一笔或新增标记，也不把旧 `chain_role` 当作已确认主链。摘要同理：只有 `summary_state === 'current'` 才按当前结果展示，否则附旧结果标签。

---

## Task 1：建立输入解释 Module

**Files:**
- Create: `src/input-interpretation.ts`
- Create: `.agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md`
- Test: `tests/input-interpretation.test.ts`

**Interfaces:**
- Consumes: 无。纯函数，不读数据库、不解压正文。
- Produces:
  - `interpretUserText(text: string, agent: string | null): UserInputView`
  - `interpretMessage(message: unknown, agent: string | null, ord: number): MessageView`
  - `messageText(message: unknown): string | null`
  - 类型 `InputState`、`InputKind`、`UserInputView`、`MessageView`

- [ ] **Step 1：写失败测试，覆盖包装、插话、嵌套畸形、多条用户消息与未知 agent。**

```ts
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
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/input-interpretation.test.ts`。Expected: FAIL，报找不到 `../src/input-interpretation`。语法或 import 拼写错误不计为目标失败。

- [ ] **Step 3：实现纯解释 Module。** 只剥请求开头的已知包装；正文中间的标签原样保留。配对标签用深度扫描，嵌套可剥，未闭合返回 `unrecognized` 并保留原文。未知 agent 使用通用规则，不推断客户端。

```ts
export type InputState = 'text' | 'empty' | 'injected' | 'unrecognized';
export type InputKind = 'plain' | 'wrapped' | 'midturn' | 'title_request'
  | 'command_echo' | 'skill_injection' | 'system_notice';

export type UserInputView = {
  state: InputState;
  kind: InputKind;
  text: string;
  original: string;
  removed: string[];
  agent: string | null;
  rule: 'generic';
};

export type MessageView = {
  ord: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  role_state: 'known' | 'unknown';
  input: UserInputView | null;
};

const UNWRAP_TAGS = new Set(['session']);
const DROP_TAGS = new Set([
  'system-reminder', 'transcript', 'local-command-stdout', 'local-command-caveat',
  'command-name', 'command-message', 'command-args', 'system-notice', 'recap',
]);
const MIDTURN_PREFIX = /^The user sent a new message while you were working:\s*/i;
const MIDTURN_NOTICE = /This is how Claude Code surfaces messages[\s\S]*$/i;
const CWD_PREFIX = /^\s*(?:工作目录|working directory|cwd)[:：][^\n]*\n?/i;
const SKILL_INJECTION = /^Base directory for this skill:/i;
const STEPPED_AWAY = /^The user stepped away and is coming back\b/i;

type StripResult = { text: string; tag: string | null; malformed: boolean };

function knownWrapper(tag: string): boolean {
  return UNWRAP_TAGS.has(tag) || DROP_TAGS.has(tag) || /^command-[a-z-]+$/.test(tag);
}

function stripLeadingTag(text: string): StripResult {
  const opening = /^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.exec(text);
  if (opening === null) return { text, tag: null, malformed: false };
  const tag = (opening[1] ?? '').toLowerCase();
  if (!knownWrapper(tag)) return { text, tag: null, malformed: false };
  let depth = 1;
  let cursor = opening[0].length;
  const scanner = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}>`, 'gi');
  scanner.lastIndex = cursor;
  for (;;) {
    const hit = scanner.exec(text);
    if (hit === null) return { text, tag, malformed: true };
    depth += hit[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      const inner = text.slice(cursor, hit.index);
      const rest = text.slice(hit.index + hit[0].length);
      return {
        text: UNWRAP_TAGS.has(tag) ? `${inner}${rest}` : rest,
        tag,
        malformed: false,
      };
    }
    cursor = scanner.lastIndex;
  }
}

function textBlocks(message: unknown): string[] {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
      out.push(record.text);
    }
  }
  return out;
}

export function messageText(message: unknown): string | null {
  const parts = textBlocks(message);
  return parts.length === 0 ? null : parts.join('\n');
}

export function interpretUserText(text: string, agent: string | null): UserInputView {
  const original = text;
  let current = text.trim();
  const removed: string[] = [];
  const base = { original, agent, rule: 'generic' as const };
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (;;) {
      const result = stripLeadingTag(current);
      if (result.malformed) {
        return { ...base, state: 'unrecognized', kind: 'wrapped', text: original, removed };
      }
      if (result.tag === null) break;
      current = result.text;
      removed.push(result.tag);
      changed = true;
    }
    if (MIDTURN_PREFIX.test(current)) {
      current = current.replace(MIDTURN_PREFIX, '');
      removed.push('midturn-prefix');
      changed = true;
    }
    if (MIDTURN_NOTICE.test(current)) {
      current = current.replace(MIDTURN_NOTICE, '');
      removed.push('midturn-notice');
      changed = true;
    }
    if (CWD_PREFIX.test(current)) {
      current = current.replace(CWD_PREFIX, '');
      removed.push('cwd-prefix');
      changed = true;
    }
    current = current.trim();
    if (!changed) break;
  }
  if (current.startsWith('<title-request>')) {
    return { ...base, state: 'injected', kind: 'title_request', text: '', removed };
  }
  if (SKILL_INJECTION.test(current)) {
    return { ...base, state: 'injected', kind: 'skill_injection', text: '', removed };
  }
  if (STEPPED_AWAY.test(current)) {
    return { ...base, state: 'injected', kind: 'system_notice', text: '', removed };
  }
  if (current.length === 0) {
    const onlyCommands = removed.length > 0 && removed.every(tag => tag.startsWith('command-'));
    return {
      ...base,
      state: removed.length > 0 ? 'injected' : 'empty',
      kind: removed.length > 0 ? (onlyCommands ? 'command_echo' : 'system_notice') : 'plain',
      text: '',
      removed,
    };
  }
  return {
    ...base,
    state: 'text',
    kind: removed.some(value => value === 'midturn-prefix') ? 'midturn'
      : removed.length > 0 ? 'wrapped' : 'plain',
    text: current,
    removed,
  };
}

export function interpretMessage(message: unknown, agent: string | null, ord: number): MessageView {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ord, role: 'unknown', role_state: 'unknown', input: null };
  }
  const rawRole = (message as Record<string, unknown>).role;
  const role: MessageView['role'] = typeof rawRole === 'string'
    ? rawRole === 'developer' ? 'system'
      : rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' || rawRole === 'tool'
        ? rawRole as 'user' | 'assistant' | 'system' | 'tool' : 'unknown'
    : 'unknown';
  const text = role === 'user' ? messageText(message) : null;
  return {
    ord,
    role,
    role_state: role === 'unknown' ? 'unknown' : 'known',
    input: text === null ? null : interpretUserText(text, agent),
  };
}
```

- [ ] **Step 4：运行测试确认通过。** Run: `bun test tests/input-interpretation.test.ts`。Expected: PASS，9 个测试全过。

- [ ] **Step 5：创建 Agent Note 的 proposed 版本。**

```markdown
# Agent Note: 服务端输入解释与能力阅读

Status: proposed

## Problem

服务端派生与页面各有一套 harness 包装清洗；标题、摘要和对话视图对同一段输入可能给出不同文本。能力区块在页面按已加载消息猜测技能，首片没读到 system 文本时会显示成零技能。

## Proposal

输入解释集中到 `src/input-interpretation.ts`，能力提取集中到 `src/capabilities.ts`。正文分页返回消息级解释、覆盖状态与能力视图；页面只渲染服务端结果。解释不修改原文、块哈希或语义指纹。派生只复用解释结果，不改变标题、摘要和链算法的选择规则。

## Alternatives considered

**继续维护两份正则。** 前后端规则会继续漂移，插话与 caveat 的差异无法用同一组回归固定。

**引入前端构建复用 TypeScript。** 生产页面是无构建原生 JavaScript；为一次展示引入构建会扩大部署面，收益不足。

**把技能与工具 schema 长期复制到派生列。** 会绕过正文保留预算，且正文回收后仍要维护第二份内容。

## Acceptance criteria

- 正文分页返回 `interpretations`、`coverage` 与 `capabilities`，页面不再维护包装清洗和技能解析。
- 原文与 `block.fingerprint` 不变；畸形包装保留原文并标未识别。
- 能力五种状态可区分，partial 与 missing 不显示为零技能。
- route z、source_facts 与 projection_meta 只返回白名单字段；未知 fail、未知 part、未知类别保持原值。
- 上下文比例只在 recomputed 且窗口为正时显示；派生状态非 clean/current 时不显示 confirmed。
- 分页方向、flags、滚动与复制有合成回归。

## Risks

- 正文分页响应变大，但只增加短文本与计数，不复制完整工具 schema。
- 能力提取只解压 role=system 的块，不扫描全部消息；正文 partial 时只能报 partial。
- 旧请求没有 format 2 与 projection_meta 时显示缺失或旧结果，不从原始 JSON 补猜。
- C 的列或派生状态值域未落地时，Task 7 必须停止，不能用旧列补一份替代状态。

## Testing

`bun test tests/input-interpretation.test.ts` 起步；后续任务扩展合成用例，覆盖嵌套畸形包装、多条用户消息、未知 agent、能力状态、route z 白名单、未知 fail、retained 比例、未知 part 颜色、flags 与滚动恢复。
```

- [ ] **Step 6：提交（仅在获得提交授权时）。**

```bash
git add src/input-interpretation.ts tests/input-interpretation.test.ts .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): centralize harness input interpretation on the server"
```

## Task 2：让派生复用输入解释且保持标题行为

**Files:**
- Modify: `src/derive.ts`（`deriveTitle`、`previewOf`、`tailUserPreview`、`firstUserPreview`、`stripHarnessWrappers` 的调用点）
- Test: `tests/derive.test.ts`
- Test: `tests/input-interpretation.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `interpretMessage`、`interpretUserText`、`messageText`。
- Produces: `deriveTitle(messages, delta, fallback, agent?: string | null)`；其余导出签名不变。`ChainRow` 增加 `agent` 字段用于解释规则标签，不改变链算法。

- [ ] **Step 1：加回归测试，锁定现有标题行为与多条用户消息。**

```ts
import { interpretMessage } from '../src/input-interpretation';
import { messageFingerprint } from '../src/fingerprint';

test('同一请求的多条新增用户消息逐条保留，标题取首条', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n第一条' }] },
    { role: 'user', content: [{ type: 'text', text: '第二条' }] },
  ];
  expect(deriveTitle(messages, [0, 1], 'fallback')).toEqual({ title: '第一条', source: 'user_delta' });
  expect(interpretMessage(messages[1], null, 1).input?.text).toBe('第二条');
});

test('未知 agent 不改变既有标题清洗', () => {
  expect(deriveTitle(
    [{ role: 'user', content: '<session>旧规则仍生效</session>' }],
    [0],
    'fallback',
    null,
  )).toEqual({ title: '旧规则仍生效', source: 'user_delta' });
});

test('展示解释不改写消息对象与指纹', () => {
  const message = { role: 'user', content: '<session>原文</session>' };
  const before = messageFingerprint(message);
  expect(interpretMessage(message, 'claude', 0).input?.text).toBe('原文');
  expect(messageFingerprint(message)).toBe(before);
  expect(message).toEqual({ role: 'user', content: '<session>原文</session>' });
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/derive.test.ts -t '多条新增用户消息|未知 agent 不改变|展示解释不改写'`。Expected: FAIL，`deriveTitle` 不接受第四个参数或仍把包装文本当标题。

- [ ] **Step 3：替换内部清洗调用。** `deriveTitle` 的第四个参数默认 null；只接受 `input.state === 'text'` 的视图；首行与 60 字截断逻辑保留。`previewOf`、`tailUserPreview`、`firstUserPreview` 同样改用 `interpretMessage`，不复制规则。删除 `stripHarnessWrappers`、`SYSTEM_TAG`、`CWD_WRAPPER`、`MIDTURN_PREFIX`、`MIDTURN_NOTICE`、`UNWRAP_WRAPPERS`、`DROP_WRAPPERS` 与只服务这些调用点的 `userText`，避免第二份规则。

```ts
export function deriveTitle(
  messages: readonly unknown[],
  delta: readonly number[] | null,
  fallback: string,
  agent: string | null = null,
): { title: string; source: 'user_delta' | 'model_time' } {
  if (delta === null) return { title: fallback, source: 'model_time' };
  for (const ordinal of delta) {
    const view = interpretMessage(messages[ordinal], agent, ordinal);
    if (view.input === null || view.input.state !== 'text') continue;
    const cleaned = view.input.text.split('\n')[0]?.replace(/\s+/g, ' ').trim();
    if (cleaned === undefined || cleaned.length === 0) continue;
    return { title: [...cleaned].slice(0, TITLE_UNICODE_LIMIT).join(''), source: 'user_delta' };
  }
  return { title: fallback, source: 'model_time' };
}
```

`previewOf` 改为遍历消息并取 `interpretMessage(message, agent, ordinal).input`；`tailUserPreview` 与 `firstUserPreview` 从请求行读取 `agent` 后传入。`ChainRow` 的 SELECT 增加 `agent`，`row.agent` 只作为规则标签。调用点必须一起改签名，不能留下旧的 `previewOf(messages)`：

```ts
function previewOf(messages: readonly (unknown | null)[], agent: string | null): string | null {
  for (const [ordinal, message] of messages.entries()) {
    const input = interpretMessage(message, agent, ordinal).input;
    if (input === null || input.state !== 'text') continue;
    const cleaned = input.text.trim();
    if (cleaned.length > 0) return clip(cleaned);
  }
  return null;
}

function tailUserPreview(db: Database, reqId: number): string | null {
  const agent = db.query<{ agent: string | null }, [number]>(
    'SELECT agent FROM request WHERE req_id=?',
  ).get(reqId)?.agent ?? null;
  const rows = db.query<{ ord: number; z: Uint8Array }, [number]>(`
    SELECT rb.ord AS ord, b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord DESC LIMIT 5`).all(reqId);
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    const input = interpretMessage(message, agent, row.ord).input;
    if (input !== null && input.state === 'text' && input.text.trim().length > 0) {
      return clip(input.text.trim());
    }
  }
  return null;
}
```

`firstUserPreview` 同样读取 `agent`，把 SELECT 改为 `rb.ord AS ord, b.z AS z` 并调用 `interpretMessage(message, agent, row.ord)`；`deriveTitle(messages, delta, fallback, row.agent)` 与 `previewOf(messages, row.agent)` 在派生循环中一起传参。

- [ ] **Step 4：运行派生与解释测试确认通过。** Run: `bun test tests/derive.test.ts tests/input-interpretation.test.ts`。Expected: PASS；既有标题、插话、caveat、会话外壳用例全部保持。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/derive.ts tests/derive.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "refactor(derive): reuse server-side input interpretation for titles and previews"
```

## Task 3：正文分页返回消息级解释与覆盖状态

**Files:**
- Modify: `src/protocols.ts`（`BodyPage`、`getBodyPage`）
- Test: `tests/protocols.test.ts`
- Test: `tests/body-api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `interpretMessage`；`Store` 与现有 `request_block`。
- Produces:
  - `BodyPage.interpretations: MessageInterpretation[]`
  - `BodyPage.coverage: BodyCoverage`
  - `MessageInterpretation = { ord: number; role: MessageView['role']; role_state: MessageView['role_state']; input: UserInputView | null; is_input: boolean }`
  - `BodyCoverage = { from: number; to: number; total: number | null; complete: boolean; loaded_complete: boolean; reason: 'available' | 'body_partial' | 'body_unavailable' }`

- [ ] **Step 1：写失败测试，覆盖原文保留、包装清洗、畸形保留与回收状态。**

```ts
test('正文页返回服务端消息解释且原文不变', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, {
      protocol: 'anthropic',
      request: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n真实输入' }] },
          { role: 'user', content: [{ type: 'text', text: '第二条' }] },
        ],
      },
      reply: { id: 'msg_1', content: [] },
      redact_version: 1,
    });
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    const interpretations = page.interpretations as { ord: number; input: { text: string } | null }[];
    expect(interpretations.map(item => item.input?.text)).toEqual(['真实输入', '第二条']);
    const messages = page.messages as { value: { content: { text: string }[] } }[];
    expect(messages[0]?.value.content[0]?.text).toContain('<system-reminder>');
    expect((page.coverage as { complete: boolean }).complete).toBe(true);
  } finally {
    f.close();
  }
});

test('畸形包装保留原文并标未识别', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: '<session>没有闭合' }] },
      reply: { id: 'msg_1', content: [] },
      redact_version: 1,
    });
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    const interpretation = (page.interpretations as {
      input: { state: string; text: string } | null; is_input: boolean;
    }[])[0];
    expect(interpretation?.input?.state).toBe('unrecognized');
    expect(interpretation?.input?.text).toBe('<session>没有闭合');
    expect(interpretation?.is_input).toBe(true);
  } finally {
    f.close();
  }
});

test('回收正文返回空解释与不可用覆盖，不伪造空对话', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(2));
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted', body_evict_reason='budget', skeleton_z=NULL WHERE req_id=1",
    ));
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    expect(page.state).toBe('evicted');
    expect(page.interpretations).toEqual([]);
    expect((page.coverage as { complete: boolean; reason: string }).complete).toBe(false);
    expect((page.coverage as { reason: string }).reason).toBe('body_unavailable');
  } finally {
    f.close();
  }
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/body-api.test.ts -t '消息解释|畸形包装|回收正文返回空解释'`。Expected: FAIL，`interpretations` 与 `coverage` 为 undefined。

- [ ] **Step 3：扩展 `BodyPage` 与 `getBodyPage`。** `src/protocols.ts` 顶部增加 `import { interpretMessage, type MessageView, type UserInputView } from './input-interpretation';`。读取 request 行的 `agent` 一起返回；只对当前页消息做解释；回收与未到正文返回空数组与 `body_unavailable`；`partial` 正文标 `body_partial`。

```ts
export type MessageInterpretation = {
  ord: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  role_state: 'known' | 'unknown';
  input: UserInputView | null;
  is_input: boolean;
};

export type BodyCoverage = {
  from: number;
  to: number;
  total: number | null;
  complete: boolean;
  loaded_complete: boolean;
  reason: 'available' | 'body_partial' | 'body_unavailable';
};

export type BodyPage = {
  state: BodyState;
  parse_state: string | null;
  reply_state: string | null;
  from: number;
  to: number;
  total: number | null;
  messages: { ord: number; value: unknown }[];
  request_fields: unknown;
  reply: unknown;
  reason: string | null;
  interpretations: MessageInterpretation[];
  coverage: BodyCoverage;
};
```

`stateRow` 的查询改为 `SELECT body_state, parse_state, reply_state, msg_count, miss_reason, body_evict_reason, skeleton_z, agent FROM request WHERE req_id=?`，该查询的泛型类型同时增加 `agent: string | null`。构造 `page` 时先放入空解释与覆盖状态，读完当前页后再填解释；回收与未到正文保持空数组。

```ts
const page: BodyPage = {
  state,
  parse_state: stateRow.parse_state,
  reply_state: stateRow.reply_state,
  from,
  to,
  total: readable ? stateRow.msg_count : null,
  messages: [],
  request_fields: null,
  reply: null,
  reason: state === 'evicted' ? stateRow.body_evict_reason : stateRow.miss_reason,
  interpretations: [],
  coverage: {
    from,
    to,
    total: readable ? stateRow.msg_count : null,
    complete: state === 'available',
    loaded_complete: readable && stateRow.msg_count !== null && to >= stateRow.msg_count,
    reason: readable ? (state === 'available' ? 'available' : 'body_partial') : 'body_unavailable',
  },
};
if (!readable) return page;
if (stateRow.skeleton_z == null) return page;

const cache = new Map<number, unknown>();
if (from === 0) {
  const skeleton = JSON.parse(zstdDecompressSync(stateRow.skeleton_z).toString('utf8')) as {
    request_without_messages?: unknown; reply?: unknown; has_messages?: boolean;
  };
  page.request_fields = skeleton.request_without_messages ?? null;
  page.reply = skeleton.reply ?? null;
}
if (from === to) return page;

const rows = store.read.query<{ ord: number; block: number }, [number, number, number]>(`
  SELECT ord, block FROM request_block WHERE req_id=? AND ord >= ? AND ord < ? ORDER BY ord`)
  .all(id, from, to);
page.messages = rows.map(row => ({ ord: row.ord, value: decompressBlock(store, row.block, cache) }));
page.interpretations = page.messages.map(message => {
  const view = interpretMessage(message.value, stateRow.agent, message.ord);
  // unrecognized 仍是用户消息：保留原文并标未识别，不能因为清洗失败就吞掉。
  // injected 与 empty 不是用户可见输入，页面据此不铺气泡。
  return {
    ...view,
    is_input: view.input !== null && (view.input.state === 'text' || view.input.state === 'unrecognized'),
  };
});
return page;
```

`decompressBlock` 与 `stateRow` 查询保持现有实现；上面这段就是 `getBodyPage` 从骨架读取到返回的完整路径，可直接替换同名区间。`from === to` 的空区间仍返回解释数组为空，不伪造消息。

- [ ] **Step 4：更新旧测试的 BodyPage 夹具并运行。** 在 `tests/body-view.test.ts` 的 `page()` helper 补 `interpretations: []`、`coverage: { from: 0, to: 0, total: 2, complete: true, loaded_complete: false, reason: 'available' }`。Run: `bun test tests/body-api.test.ts tests/protocols.test.ts tests/body-view.test.ts`。Expected: PASS。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/protocols.ts tests/body-api.test.ts tests/protocols.test.ts tests/body-view.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(body): return server-side message interpretation with each page"
```

## Task 4：建立能力提取 Module

**Files:**
- Create: `src/capabilities.ts`
- Test: `tests/capabilities.test.ts`

**Interfaces:**
- Consumes: 无数据库；输入为协议名、请求顶层字段、system 文本与覆盖状态。
- Produces:
  - `extractTools(protocol: string, request: unknown): ToolCapabilityResult`
  - `extractSkills(systemTexts: readonly string[], coverage: CapabilityCoverage, systemPresent: boolean, agent: string | null): SkillCapabilityResult`
  - `capabilityView(input: CapabilityInput): CapabilityView`
  - 类型 `CapabilityState = 'present' | 'empty' | 'unrecognized' | 'missing' | 'partial'`

- [ ] **Step 1：写失败测试，覆盖两种协议工具、四种技能状态、未知 agent 与转义数据。**

```ts
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
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/capabilities.test.ts`。Expected: FAIL，找不到 `../src/capabilities`。

- [ ] **Step 3：实现能力提取。** 工具只读 `request.tools` 与 `request.functions`；技能只读 system 文本。未知 kind 不丢弃；技能按 name 去重，先出现的描述优先。`missing` 只在正文不可读或协议不支持时返回；`partial` 只在正文不完整时返回；有技能标记但零行返回 `unrecognized`。

```ts
export type CapabilityState = 'present' | 'empty' | 'unrecognized' | 'missing' | 'partial';

export type ToolCapability = { name: string; description: string; schema: unknown; source: 'tools' | 'functions' };
export type SkillCapability = { name: string; description: string; format: 'tagged' | 'claude-heading' };

export type CapabilityCoverage = {
  complete: boolean;
  reason: 'available' | 'body_partial' | 'body_unavailable';
  from: number;
  to: number;
  total: number | null;
};

export type CapabilityResult<T> = {
  state: CapabilityState;
  items: T[];
  reason: string | null;
};

export type CapabilityView = {
  tools: CapabilityResult<ToolCapability>;
  skills: CapabilityResult<SkillCapability>;
  coverage: CapabilityCoverage;
  agent: string | null;
};

const SKILL_LINE = /^\s*-\s*([^:：]+)[:：]\s*(.*)$/;
const CLAUDE_HEAD = 'The following skills are available for use with the Skill tool:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function extractTools(protocol: string, request: unknown): CapabilityResult<ToolCapability> {
  if (protocol !== 'anthropic' && protocol !== 'chat') {
    return { state: 'missing', items: [], reason: 'protocol_unsupported' };
  }
  if (!isRecord(request)) return { state: 'missing', items: [], reason: 'request_unavailable' };
  if (!('tools' in request) && !('functions' in request)) {
    return { state: 'missing', items: [], reason: 'no_tools_field' };
  }
  const list = Array.isArray(request.tools) ? request.tools
    : Array.isArray(request.functions) ? request.functions : null;
  if (list === null) return { state: 'unrecognized', items: [], reason: 'tools_not_array' };
  if (list.length === 0) return { state: 'empty', items: [], reason: 'no_tools_declared' };
  const items: ToolCapability[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : null;
    const name = textOf(fn === null ? entry.name : fn.name);
    if (name === null) continue;
    const description = fn !== null && typeof fn.description === 'string' ? fn.description
      : typeof entry.description === 'string' ? entry.description : '';
    const schema = entry.input_schema ?? entry.parameters ?? (fn === null ? null : fn.parameters) ?? null;
    items.push({
      name,
      description,
      schema,
      source: Array.isArray(request.tools) ? 'tools' : 'functions',
    });
  }
  if (items.length === 0) return { state: 'unrecognized', items: [], reason: 'tool_items_invalid' };
  return { state: 'present', items, reason: null };
}

function skillRows(text: string, format: SkillCapability['format']): SkillCapability[] {
  const rows: SkillCapability[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SKILL_LINE.exec(line);
    if (match === null) continue;
    const name = (match[1] ?? '').trim();
    if (name.length === 0) continue;
    rows.push({ name, description: (match[2] ?? '').trim(), format });
  }
  return rows;
}

function taggedRows(text: string, tag: string): SkillCapability[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const rows: SkillCapability[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    rows.push(...skillRows(text.slice(start + open.length, end), 'tagged'));
    from = end + close.length;
  }
  return rows;
}

function claudeRows(text: string): SkillCapability[] {
  const lines = text.split(/\r?\n/);
  const rows: SkillCapability[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes(CLAUDE_HEAD)) continue;
    let cursor = index + 1;
    while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') cursor += 1;
    while (cursor < lines.length) {
      const match = SKILL_LINE.exec(lines[cursor] ?? '');
      if (match === null) break;
      const name = (match[1] ?? '').trim();
      if (name.length > 0) rows.push({ name, description: (match[2] ?? '').trim(), format: 'claude-heading' });
      cursor += 1;
    }
  }
  return rows;
}

function hasSkillMarker(texts: readonly string[]): boolean {
  return texts.some(text => /<skills[\s>]/i.test(text)
    || /<available_skills[\s>]/i.test(text)
    || text.includes(CLAUDE_HEAD));
}

export function extractSkills(
  systemTexts: readonly string[],
  coverage: CapabilityCoverage,
  systemPresent: boolean,
  agent: string | null,
): CapabilityResult<SkillCapability> {
  if (coverage.reason === 'body_unavailable') {
    return { state: 'missing', items: [], reason: 'body_unavailable' };
  }
  if (!coverage.complete) return { state: 'partial', items: [], reason: 'body_partial' };
  const rows = systemTexts.flatMap(text => [
    ...taggedRows(text, 'skills'),
    ...taggedRows(text, 'available_skills'),
    ...claudeRows(text),
  ]);
  const seen = new Set<string>();
  const items = rows.filter(row => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
  if (items.length > 0) return { state: 'present', items, reason: null };
  if (!systemPresent) return { state: 'empty', items: [], reason: 'no_system_field' };
  if (hasSkillMarker(systemTexts)) return { state: 'unrecognized', items: [], reason: 'skill_format_unknown' };
  return { state: 'empty', items: [], reason: 'no_skill_declaration' };
}

export function capabilityView(input: {
  protocol: string;
  request: unknown;
  systemTexts: readonly string[];
  coverage: CapabilityCoverage;
  systemPresent: boolean;
  agent: string | null;
}): CapabilityView {
  return {
    tools: extractTools(input.protocol, input.request),
    skills: extractSkills(input.systemTexts, input.coverage, input.systemPresent, input.agent),
    coverage: input.coverage,
    agent: input.agent,
  };
}
```

- [ ] **Step 4：运行测试确认通过。** Run: `bun test tests/capabilities.test.ts`。Expected: PASS，6 个测试全过。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/capabilities.ts tests/capabilities.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(capabilities): extract protocol tools and agent skill declarations"
```

## Task 5：正文页附带能力视图，页面删除重复解析

**Files:**
- Modify: `src/protocols.ts`（`BodyPage.capabilities`、`getBodyPage`）
- Modify: `web/body-view.js`（`capabilitySummary`、`renderCapabilities`、`contextInfo` 的调用方）
- Modify: `web/app.js`（`contextInfo`、`ledgerBodySection`）
- Test: `tests/body-view.test.ts`
- Test: `tests/body-api.test.ts`
- Test: `tests/capabilities.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `capabilityView`、`CapabilityView`、`CapabilityCoverage`。
- Produces: `BodyPage.capabilities: CapabilityView`；`renderCapabilities(page: BodyPage | null): string` 只渲染服务端结果；`contextInfo(loaded)` 只读 `page.capabilities`。

- [ ] **Step 1：写失败测试，锁定 partial 与 missing 不显示零技能。**

```ts
import type { CapabilityView } from '../src/capabilities';

const partialView: CapabilityView = {
  tools: { state: 'empty', items: [], reason: 'no_tools_field' },
  skills: { state: 'partial', items: [], reason: 'body_partial' },
  coverage: { complete: false, reason: 'body_partial', from: 0, to: 40, total: 90 },
  agent: 'claude',
};

test('能力区块消费服务端状态，partial 不显示零技能', () => {
  const html = renderCapabilities(page({ capabilities: partialView }));
  expect(html).toContain('技能清单未读完');
  expect(html).not.toContain('0 技能');
  expect(html).toContain('0 工具');
});

test('能力区块区分 missing 与 empty', () => {
  const missing = renderCapabilities(page({
    capabilities: {
      ...partialView,
      skills: { state: 'missing', items: [], reason: 'body_unavailable' },
      coverage: { complete: false, reason: 'body_unavailable', from: 0, to: 0, total: null },
    },
  }));
  expect(missing).toContain('技能声明缺失');
  const empty = renderCapabilities(page({
    capabilities: {
      ...partialView,
      skills: { state: 'empty', items: [], reason: 'no_skill_declaration' },
      coverage: { complete: true, reason: 'available', from: 0, to: 2, total: 2 },
    },
  }));
  expect(empty).toContain('没有可解析的技能清单');
});

test('能力区块的动态内容只作为文本转义', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const html = renderCapabilities(page({
    capabilities: {
      ...partialView,
      tools: { state: 'present', items: [{ name: payload, description: payload, schema: null, source: 'tools' }], reason: null },
      skills: { state: 'present', items: [{ name: payload, description: payload, format: 'tagged' }], reason: null },
      coverage: { complete: true, reason: 'available', from: 0, to: 2, total: 2 },
    },
  }));
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/body-view.test.ts -t '能力区块'`。Expected: FAIL，`renderCapabilities` 仍自己解析 `request_fields` 且不认识 `page.capabilities`。

- [ ] **Step 3：服务端计算能力视图。** `src/protocols.ts` 增加 `import { capabilityView, type CapabilityCoverage, type CapabilityView } from './capabilities';` 与 `import { messageText } from './input-interpretation';`。`getBodyPage` 从骨架读取 `request_without_messages`，取 `system`；再查询该请求所有 `role=2` 的 system 块并只解压这些块。能力覆盖按正文状态：`available` 为 complete，`partial` 为 body_partial，其余为 body_unavailable。不要为能力提取解压全部消息。

`BodyPage` 新增必填的 `capabilities` 后，Task 3 的 `page` 字面量必须先放一个缺失视图再进入任何早退；否则 `!readable`、`skeleton_z === null` 与 `from === to` 的路径会漏字段，页面也会读到 `undefined`：

```ts
const missingCapabilities: CapabilityView = {
  tools: { state: 'missing', items: [], reason: 'body_unavailable' },
  skills: { state: 'missing', items: [], reason: 'body_unavailable' },
  coverage: { complete: false, reason: 'body_unavailable', from, to, total: null },
  agent: stateRow.agent,
};
// page 字面量增加 capabilities: missingCapabilities，之后再用下面的实际视图覆盖。
page.capabilities = missingCapabilities;
```

可读正文覆盖为：

```ts
const skeleton = stateRow.skeleton_z === null ? null
  : JSON.parse(zstdDecompressSync(stateRow.skeleton_z).toString('utf8')) as {
    protocol?: string;
    request_without_messages?: unknown;
  };
const fields = skeleton !== null && isRecord(skeleton.request_without_messages)
  ? skeleton.request_without_messages : null;
const protocol = skeleton !== null && typeof skeleton.protocol === 'string' && skeleton.protocol.length > 0
  ? skeleton.protocol : 'unknown';
const systemTexts: string[] = [];
const system = fields === null ? undefined : fields.system;
if (typeof system === 'string' && system.length > 0) systemTexts.push(system);
if (Array.isArray(system)) {
  for (const block of system) {
    if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) systemTexts.push(block.text);
  }
}
const systemRows = store.read.query<{ z: Uint8Array }, [number]>(`
  SELECT b.z AS z FROM request_block rb JOIN block b ON b.id=rb.block
  WHERE rb.req_id=? AND rb.role=2 ORDER BY rb.ord`).all(id);
for (const row of systemRows) {
  const message: unknown = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
  const text = messageText(message);
  if (text !== null) systemTexts.push(text);
}
const usable = readable && skeleton !== null;
const coverage: CapabilityCoverage = {
  complete: usable && state === 'available',
  reason: usable ? (state === 'available' ? 'available' : 'body_partial') : 'body_unavailable',
  from,
  to,
  total: usable ? stateRow.msg_count : null,
};
page.capabilities = capabilityView({
  protocol,
  request: fields,
  systemTexts,
  coverage,
  systemPresent: fields !== null && ('system' in fields || systemRows.length > 0),
  agent: stateRow.agent,
});
```

骨架已保存 `protocol`，不要另查请求表或 raw 表。把 Task 3 中只在 `from === 0` 解压骨架的代码移到可读正文分支的开头，让能力提取每片都能复用同一个对象；`request_fields` 与 `reply` 仍只在首片赋值。能力视图每片都返回。

- [ ] **Step 4：删除前端重复解析。** `web/body-view.js` 删除 `SKILL_LINE`、`SKILL_TOOL_HEAD`、`systemTexts`、`skillRows`、`taggedSkillRows`、`claudeSkillRows`、`capabilitySummary`；`renderCapabilities` 只读 `page.capabilities`。`tests/body-view.test.ts` 的 `page()` helper 补 `capabilities: missingCapabilities` 默认值，避免每个旧用例手工重复。状态文案固定如下：

```js
const TOOL_STATE_TEXT = {
  present: '',
  empty: '这一笔请求没有携带工具定义',
  unrecognized: '工具字段存在，但格式未识别',
  missing: '工具定义缺失',
  partial: '工具定义未读完',
};
const SKILL_STATE_TEXT = {
  present: '',
  empty: '没有可解析的技能清单',
  unrecognized: '有技能标记，但格式未识别',
  missing: '技能声明缺失',
  partial: '技能清单未读完',
};

export function renderCapabilities(page) {
  const view = page === null || page === undefined ? null : page.capabilities;
  if (view === null) {
    return '<section class="section cap-section"><div class="section-head"><h3>请求能力</h3></div>'
      + '<p class="note">这一片没有能力视图；正文未读或协议不支持。</p></section>';
  }
  const tools = view.tools;
  const skills = view.skills;
  const toolCount = tools.state === 'present' || tools.state === 'empty'
    ? `${tools.items.length} 工具` : '工具状态待确认';
  const skillCount = skills.state === 'present' || skills.state === 'empty'
    ? `${skills.items.length} 技能` : '技能状态待确认';
  const head = `<div class="section-head"><h3>请求能力</h3><span class="count">${toolCount} · ${skillCount}</span></div>`;
  const note = (result, text) => result.state === 'present'
    ? '' : `<p class="note">${esc(text[result.state] ?? result.state)}</p>`;
  const toolBlock = tools.items.length === 0 ? '' : `<details class="cap-block">
    <summary>工具清单 · ${tools.items.length}</summary>
    <ol class="cap-list">${tools.items.map(renderToolItem).join('')}</ol></details>`;
  const skillBlock = skills.items.length === 0 ? '' : `<details class="cap-block">
    <summary>技能清单 · ${skills.items.length}</summary>
    <ul class="cap-list">${skills.items.map(renderSkillItem).join('')}</ul></details>`;
  return `<section class="section cap-section">${head}${note(tools, TOOL_STATE_TEXT)}${note(skills, SKILL_STATE_TEXT)}${toolBlock}${skillBlock}</section>`;
}
```

`web/app.js` 的 `contextInfo` 改为 `const capability = loaded.page?.capabilities ?? null`，不再调用 `capabilitySummary`；账本详情里的 `renderCapabilities(page, rows)` 也改成 `renderCapabilities(page)`。`skills.state` 为 `present` 或 `empty` 时才显示数量，其余显示状态文案，避免把 partial 读成零技能。`tests/body-view.test.ts` 同时删除 `capabilitySummary` 的 import 与两段旧字段解析断言，改用 `capabilities` fixture 调用单参数 `renderCapabilities(page)`；语义断言留在 Task 4 的 `tests/capabilities.test.ts`。

- [ ] **Step 5：运行相关测试确认通过。** Run: `bun test tests/capabilities.test.ts tests/body-view.test.ts tests/body-api.test.ts`。Expected: PASS；旧的能力解析断言已迁到 `tests/capabilities.test.ts`，页面测试只保留渲染与转义。

- [ ] **Step 6：提交（仅在获得提交授权时）。**

```bash
git add src/protocols.ts web/body-view.js web/app.js tests/body-view.test.ts tests/body-api.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): serve capability views and remove browser-side parsing"
```

## Task 6：只读消费 route_summary.z format 2 并安全挑选

**Files:**
- Modify: `src/queries.ts`（`getRoute`、新增 `routeSummaryReading`、`attemptChainOf`、`safeOrder`、`safeAffinity`）
- Modify: `src/reconcile.ts`（`saveRouteSummary` 按 C 的 format 2 约定写 `kind`、`folder`、`effort` 与 `prompt`；实施时发现 C 的写入未落地，本 Task 一并补上）
- Test: `tests/queries.test.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Consumes: C 写入的 `route_summary.z` format 2；旧行 format 1 与现有列。
- Produces:
  - `routeSummaryReading(raw: unknown, columns: RouteColumns): RouteSummaryReading`
  - `attemptChainOf(tries: unknown): AttemptChain`
  - `getRoute` 返回 `summary.format`、`summary.kind`、`summary.folder`、`summary.effort`、`summary.error`、`summary.prompt`、`summary.order`、`summary.attempts`、`summary.affinity`
  - 类型 `RouteSummaryReading`、`RouteColumns`、`RoutePrompt`、`AttemptChain`、`AttemptItem`

- [ ] **Step 1：写失败测试，锁定 format 2 字段与 account/host 不泄露。**

```ts
import { zstdCompressSync } from 'node:zlib';
import { attemptChainOf, getRoute, routeSummaryReading } from '../src/queries';

const columns = {
  route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
  status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
  order_json: null, tries_json: null, affinity_json: null,
};

test('format 2 读取 kind、folder、effort、prompt 与 error', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: 'chat', folder: '/tmp/project', effort: 'high',
    prompt: { tokens: 100, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 60 }] },
    error: 'synthetic error', order: [], tries: [], affinity: null, saved_at: 1,
  }, columns);
  expect(reading.format).toBe(2);
  expect(reading.kind).toBe('chat');
  expect(reading.folder).toBe('/tmp/project');
  expect(reading.effort).toBe('high');
  expect(reading.prompt).toEqual({ tokens: 100, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 60 }] });
  expect(reading.error).toBe('synthetic error');
});

test('安全挑选去掉 account、host、who 与 id', () => {
  const reading = routeSummaryReading({
    format: 2, route_id: 100, time_ms: 1000, model: 'm', served: 's', provider: 'p',
    status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3,
    kind: 'chat', folder: null, effort: null, prompt: null, error: null,
    order: [
      { provider: 'p', name: 'n', model: 'm', who: 'secret-account', id: 'secret-id', host: 'secret-host' },
      { provider: 'p2', name: { host: 'secret-host' }, model: 'm2', plan: { account: 'secret-account' } },
    ],
    tries: [{ model: 'm', status: 500, fail: 'synthetic_new_gate', who: 'secret-account' }],
    affinity: { mode: 'session', why: 'kept', turn: { account: 'secret-account' }, last: 'secret-account', host: 'secret-host' },
    saved_at: 1,
  }, columns);
  const text = JSON.stringify(reading);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-id');
  expect(reading.order).toEqual([
    { provider: 'p', name: 'n', model: 'm' },
    { provider: 'p2', model: 'm2' },
  ]);
  expect(reading.attempts.items[0]?.fail).toBe('synthetic_new_gate');
  expect(reading.affinity).toEqual({ mode: 'session', why: 'kept' });
});

test('旧 format 1 不补 kind、folder、effort 与 prompt', () => {
  const reading = routeSummaryReading({ route_id: 100, order: [], tries: [] }, columns);
  expect(reading.format).toBe(1);
  expect(reading.kind).toBeNull();
  expect(reading.folder).toBeNull();
  expect(reading.effort).toBeNull();
  expect(reading.prompt).toBeNull();
});

test('getRoute 从 z 读取并保留列回退', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,route_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (1,100,1,'2026-10-22','through','pending',0,1,1,1)`);
      const z = zstdCompressSync(Buffer.from(JSON.stringify({
        format: 2, route_id: 100, time_ms: 1, model: 'm', served: 's', provider: 'p',
        status: 200, ms: 10, ttft: 2, flow: 8, first_text: 3, kind: 'chat',
        folder: null, effort: null, prompt: null, error: null, order: [], tries: [], affinity: null, saved_at: 1,
      })));
      db.run(`INSERT INTO route_summary(route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,z)
        VALUES (100,1,'m','s','p',200,10,2,8,3,?)`, [z]);
    });
    const route = getRoute(f.store, 1);
    expect(route.state).toBe('available');
    expect((route.summary as { format: number }).format).toBe(2);
    expect((route.summary as { kind: string }).kind).toBe('chat');
  } finally {
    f.close();
  }
});

test('尝试链保留未知 fail 码与已记录时间', () => {
  const chain = attemptChainOf([
    { model: 'm1', provider: 'p1', status: 500, fail: 'synthetic_new_gate', start: '2026-10-22T00:00:00Z', ms: 100 },
    { model: 'm2', provider: 'p2', status: 200, start: '2026-10-22T00:00:01Z', ms: 200 },
  ]);
  expect(chain.state).toBe('present');
  expect(chain.items.map(item => item.fail)).toEqual(['synthetic_new_gate', null]);
  expect(chain.timing.state).toBe('recorded');
});

test('缺时间证据时不补造重试间隔', () => {
  const chain = attemptChainOf([
    { model: 'm1', status: 500, fail: 'rate_limit' },
    { model: 'm2', status: 200 },
  ]);
  expect(chain.items.map(item => item.start_ms)).toEqual([null, null]);
  expect(chain.timing.state).toBe('partial');
  const text = JSON.stringify(chain);
  expect(text).not.toContain('again_ms');
  expect(text).not.toContain('interval');
});

test('空尝试与非法输入分开', () => {
  expect(attemptChainOf([]).state).toBe('empty');
  expect(attemptChainOf(null).state).toBe('unavailable');
  expect(attemptChainOf('oops').state).toBe('unavailable');
  expect(attemptChainOf([null]).state).toBe('unavailable');
  expect(attemptChainOf([null]).timing.state).toBe('absent');
});

test('尝试项只保留白名单字段', () => {
  const chain = attemptChainOf([{
    id: 'secret-id', model: 'm', provider: 'p', status: 500, fail: 'x',
    who: 'secret-account', account: 'secret-account', host: 'secret-host', rest: { who: 'secret-account' },
  }]);
  const text = JSON.stringify(chain);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-id');
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/queries.test.ts -t 'format 2|安全挑选|旧 format 1|getRoute 从 z|尝试链|重试间隔|空尝试|尝试项'`。Expected: FAIL，`routeSummaryReading` 或 `attemptChainOf` 未导出，`getRoute` 仍返回原始 tries。

- [ ] **Step 3：实现安全投影。** `src/queries.ts` 顶部增加 `import { zstdDecompressSync } from 'node:zlib';`。`getRoute` 的查询增加 `z`，读取后解压；解析失败时退回列与 format 1。`order` 只保留 `provider`、`name`、`model`、`kind`、`agent`、`plan`、`used`、`limit`、`unit`、`fast`、`fallback`、`shared`；`affinity` 只保留 `mode`、`why`、`turn`、`within`、`kept`、`cache_read`、`cache_write`。白名单键的值也只接受字符串、有限数字、布尔或 null，嵌套对象与数组一律丢弃；任何未知键不进入响应。尝试链在本任务一起实现，`start_ms` 只从合法 `start` 解析，缺值保持 null，不生成任何相邻差值。

```ts
export type RoutePrompt = {
  tokens: number;
  counted: boolean;
  window: number | null;
  held: boolean | null;
  parts: { kind: string; tokens: number }[];
};

export type RouteColumns = {
  route_id: number;
  time_ms: number;
  model: string | null;
  served: string | null;
  provider: string | null;
  status: number | null;
  ms: number | null;
  ttft: number | null;
  flow: number | null;
  first_text: number | null;
  order_json: string | null;
  tries_json: string | null;
  affinity_json: string | null;
};

export type AttemptItem = {
  index: number;
  model: string | null;
  provider: string | null;
  effort: string | null;
  status: number | null;
  fail: string | null;
  error: string | null;
  start_ms: number | null;
  ms: number | null;
  ttft_ms: number | null;
  flow_ms: number | null;
  served: string | null;
  queued_ms: number | null;
  replan: number | null;
  gone: boolean;
  earlier: boolean;
};

export type AttemptChain = {
  state: 'present' | 'empty' | 'unavailable';
  items: AttemptItem[];
  timing: { state: 'recorded' | 'partial' | 'absent'; note: string };
};

export type RouteSummaryReading = {
  format: 1 | 2;
  route_id: number;
  time_ms: number;
  model: string | null;
  served: string | null;
  provider: string | null;
  status: number | null;
  ms: number | null;
  ttft: number | null;
  flow: number | null;
  first_text: number | null;
  kind: string | null;
  folder: string | null;
  effort: string | null;
  prompt: RoutePrompt | null;
  error: string | null;
  order: Record<string, unknown>[];
  attempts: AttemptChain;
  affinity: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function simpleValue(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null) return null;
  return undefined;
}

function safeOrder(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const picked: Record<string, unknown> = {};
    for (const key of ['provider', 'name', 'model', 'kind', 'agent', 'plan', 'used', 'limit', 'unit', 'fast', 'fallback', 'shared']) {
      const scalar = simpleValue(item[key]);
      if (scalar !== undefined) picked[key] = scalar;
    }
    out.push(picked);
  }
  return out;
}

function safeAffinity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const picked: Record<string, unknown> = {};
  for (const key of ['mode', 'why', 'turn', 'within', 'kept', 'cache_read', 'cache_write']) {
    const scalar = simpleValue(value[key]);
    if (scalar !== undefined) picked[key] = scalar;
  }
  return Object.keys(picked).length === 0 ? null : picked;
}

function safePrompt(value: unknown): RoutePrompt | null {
  if (!isRecord(value)) return null;
  const tokens = finite(value.tokens);
  if (tokens === null) return null;
  const parts: { kind: string; tokens: number }[] = [];
  if (Array.isArray(value.parts)) {
    for (const part of value.parts) {
      if (!isRecord(part) || typeof part.kind !== 'string') continue;
      const count = finite(part.tokens);
      if (count === null) continue;
      parts.push({ kind: part.kind, tokens: count });
    }
  }
  return {
    tokens,
    counted: value.counted === true,
    window: finite(value.window),
    held: typeof value.held === 'boolean' ? value.held : null,
    parts,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function attemptChainOf(tries: unknown): AttemptChain {
  if (tries === null || tries === undefined) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '没有尝试数组' } };
  }
  if (!Array.isArray(tries)) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '尝试字段不是数组' } };
  }
  if (tries.length === 0) {
    return { state: 'empty', items: [], timing: { state: 'absent', note: '没有记录尝试' } };
  }
  const items: AttemptItem[] = [];
  for (const [index, entry] of tries.entries()) {
    if (!isRecord(entry)) continue;
    items.push({
      index,
      model: stringOrNull(entry.model),
      provider: stringOrNull(entry.provider),
      effort: stringOrNull(entry.effort),
      status: finite(entry.status),
      fail: stringOrNull(entry.fail),
      error: stringOrNull(entry.error),
      start_ms: timeMs(entry.start),
      ms: finite(entry.ms),
      ttft_ms: finite(entry.ttft),
      flow_ms: finite(entry.flow),
      served: stringOrNull(entry.served),
      queued_ms: finite(entry.queued),
      replan: finite(entry.replan),
      gone: entry.gone === true,
      earlier: entry.earlier === true,
    });
  }
  if (items.length === 0) {
    return { state: 'unavailable', items: [], timing: { state: 'absent', note: '尝试项不是对象' } };
  }
  const complete = items.every(item => item.start_ms !== null);
  return {
    state: 'present',
    items,
    timing: {
      state: complete ? 'recorded' : 'partial',
      note: complete ? '时间来自各次尝试的开始时间' : '部分尝试没有开始时间，不推算间隔',
    },
  };
}

export function routeSummaryReading(raw: unknown, columns: RouteColumns): RouteSummaryReading {
  const record = isRecord(raw) ? raw : null;
  const format = record?.format === 2 ? 2 : 1;
  const tries = record !== null && Array.isArray(record.tries)
    ? record.tries
    : parseJsonOrNull(columns.tries_json);
  const order = record !== null && Array.isArray(record.order)
    ? record.order
    : parseJsonOrNull(columns.order_json);
  const affinity = record !== null && record.affinity !== undefined
    ? record.affinity
    : parseJsonOrNull(columns.affinity_json);
  return {
    format,
    route_id: columns.route_id,
    time_ms: columns.time_ms,
    model: columns.model ?? (typeof record?.model === 'string' ? record.model : null),
    served: columns.served ?? (typeof record?.served === 'string' ? record.served : null),
    provider: columns.provider ?? (typeof record?.provider === 'string' ? record.provider : null),
    status: columns.status ?? finite(record?.status),
    ms: columns.ms ?? finite(record?.ms),
    ttft: columns.ttft ?? finite(record?.ttft),
    flow: columns.flow ?? finite(record?.flow),
    first_text: columns.first_text ?? finite(record?.first_text),
    kind: format === 2 && typeof record?.kind === 'string' ? record.kind : null,
    folder: format === 2 && typeof record?.folder === 'string' ? record.folder : null,
    effort: format === 2 && typeof record?.effort === 'string' ? record.effort : null,
    prompt: format === 2 ? safePrompt(record?.prompt) : null,
    error: typeof record?.error === 'string' ? record.error : null,
    order: safeOrder(order),
    attempts: attemptChainOf(tries),
    affinity: safeAffinity(affinity),
  };
}
```

`getRoute` 的 `summary` 改为 `routeSummaryReading(parsed, row)`，删除原来直接返回 `order_json`、`tries_json`、`affinity_json` 的代码。`route_id`、`time_ms` 等仍以列为准，避免 z 与列不一致时显示错行。

- [ ] **Step 4：运行查询测试确认通过。** Run: `bun test tests/queries.test.ts -t 'format 2|安全挑选|旧 format 1|getRoute 从 z'`。Expected: PASS。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/queries.ts tests/queries.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(route): read format 2 summaries through a safe projection"
```

## Task 7：安全投影 source_facts 与派生状态

**Files:**
- Modify: `src/queries.ts`（新增 `sourceFactsReading`、`projectionMetaReading`、`derivationOf`；`RequestDetail` 增加 `model_provider`、`source_facts`、`projection_meta`、`derivation`）
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: C 的 `request.model_provider`、`request.source_facts_json`、`request.projection_meta_json`，以及 C 查询投影在同一只读快照给出的 `derived_state` 与 `summary_state`。
- Produces:
  - `sourceFactsReading(raw: unknown): SourceFactsReading`
  - `projectionMetaReading(raw: unknown): ProjectionMetaReading`
  - `derivationOf(input: { derived_state: string | null; summary_state: string | null }): DerivationReading`
  - `RequestDetail.model_provider`、`RequestDetail.source_facts`、`RequestDetail.projection_meta`、`RequestDetail.derivation`

- [ ] **Step 1：写失败测试，锁定安全字段与非法 JSON 的降级。**

```ts
import { derivationOf, projectionMetaReading, sourceFactsReading } from '../src/queries';

test('source_facts 只挑白名单字段，hook 用字符串集合与有界值', () => {
  const reading = sourceFactsReading({
    selected: {
      ref: 'ledger:1', state: 'final', modelProvider: 'p', served: 's', effort: 'high',
      tierAsked: 'a', tierSent: 'b', tierServed: 'c', error: 'boom', errorType: 'rate_limit',
      account: 'secret-account', host: 'secret-host', raw: { any: 'secret-raw' },
    },
    hook: {
      models: { values: ['m1', 'm2'], overflow: 2, missing: 1, invalid: 3 },
      successes: ['success', 'success', 'failure'],
      account: 'secret-account',
    },
    projection_meta: { families: { prompt: { state: 'retained', reason: 'expired_input' } } },
    account: 'secret-account',
  });
  expect(reading.selected?.state).toBe('final');
  expect(reading.selected?.errorType).toBe('rate_limit');
  expect(reading.hook?.models).toEqual({ values: ['m1', 'm2'], overflow: 2, missing: 1, invalid: 3 });
  expect(reading.hook?.successes).toEqual(['success', 'failure']);
  const text = JSON.stringify(reading);
  expect(text).not.toContain('secret-account');
  expect(text).not.toContain('secret-host');
  expect(text).not.toContain('secret-raw');
  expect(text).not.toContain('projection_meta');
});

test('非法 source_facts 降级为缺失而不是猜测', () => {
  const reading = sourceFactsReading('not-an-object');
  expect(reading.selected).toBeNull();
  expect(reading.hook).toBeNull();
});

test('projection_meta 只读 prompt family，state 三态与 reason 分开', () => {
  const fresh = projectionMetaReading({
    families: { prompt: { actualVersion: 3, state: 'recomputed', reason: 'complete', basis: 'req:1' } },
  });
  expect(fresh.prompt.state).toBe('recomputed');
  expect(fresh.prompt.reason).toBe('complete');
  const retained = projectionMetaReading({
    families: { prompt: { actualVersion: 2, state: 'retained', reason: 'invalid_input', basis: null } },
  });
  expect(retained.prompt.state).toBe('retained');
  expect(retained.prompt.reason).toBe('invalid_input');
  const missing = projectionMetaReading({});
  expect(missing.prompt.state).toBe('missing');
  expect(missing.prompt.reason).toBe('legacy_unknown');
});

test('组状态从 C 的 derived_state 与 summary_state 映射', () => {
  expect(derivationOf({ derived_state: 'current', summary_state: 'recomputed' }))
    .toEqual({ state: 'clean', chain_state: 'current', summary_state: 'current', reason: null });
  expect(derivationOf({ derived_state: 'current', summary_state: 'retained' }))
    .toEqual({ state: 'clean', chain_state: 'current', summary_state: 'retained', reason: null });
  expect(derivationOf({ derived_state: 'dirty', summary_state: 'recomputed' }))
    .toEqual({ state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' });
  expect(derivationOf({ derived_state: 'retained', summary_state: 'retained' }))
    .toEqual({ state: 'retained', chain_state: 'retained', summary_state: 'retained', reason: 'derived_retained' });
  expect(derivationOf({ derived_state: 'legacy', summary_state: 'legacy' }))
    .toEqual({ state: 'legacy', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_legacy' });
  expect(derivationOf({ derived_state: 'synthetic_state', summary_state: null }))
    .toEqual({ state: 'unknown', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_state_unknown' });
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/queries.test.ts -t 'source_facts|projection_meta|组状态'`。Expected: FAIL，三个纯函数未导出。

- [ ] **Step 3：实现白名单挑选与状态归一。** `source_facts_json` 与 `projection_meta_json` 分开读，不互相嵌套。`selected` 每个字段单独校验；`hook.models` 只保留值的数组与三个计数；`hook.successes` 只保留 `success` 与 `failure`；prompt family 的 `state` 三态、`reason` 四值分别校验。非法值降级为 `missing` 与 `legacy_unknown`。组状态不落库，由 C 的 `derived_state` 与 `summary_state` 映射。

```ts
export type BoundedValues = {
  values: string[];
  overflow: number;
  missing: number;
  invalid: number;
};

export type SourceFactsReading = {
  selected: {
    ref: string | null;
    state: 'final' | 'failed' | 'pending_final' | 'retained' | 'missing';
    modelProvider: string | null;
    served: string | null;
    effort: string | null;
    tierAsked: string | null;
    tierSent: string | null;
    tierServed: string | null;
    error: string | null;
    errorType: string | null;
  } | null;
  hook: {
    models: BoundedValues;
    successes: ('success' | 'failure')[];
  } | null;
};

export type ProjectionMetaReading = {
  prompt: {
    actualVersion: number | null;
    state: 'recomputed' | 'retained' | 'missing';
    reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
    basis: string | null;
  };
};

export type DerivationReading = {
  state: 'clean' | 'dirty' | 'retained' | 'legacy' | 'unknown';
  chain_state: 'current' | 'retained' | 'unavailable';
  summary_state: 'current' | 'retained' | 'unavailable';
  reason: string | null;
};

const SELECTED_STATES = new Set(['final', 'failed', 'pending_final', 'retained', 'missing']);
const PROMPT_STATES = new Set(['recomputed', 'retained', 'missing']);
const PROMPT_REASONS = new Set(['complete', 'expired_input', 'invalid_input', 'legacy_unknown']);

function boundedValues(value: unknown, limit = 8): BoundedValues {
  const record = isRecord(value) ? value : {};
  const rawValues = Array.isArray(record.values) ? record.values : [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of rawValues) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    values.push(item);
    if (values.length >= limit) break;
  }
  return {
    values,
    overflow: finite(record.overflow) ?? 0,
    missing: finite(record.missing) ?? 0,
    invalid: finite(record.invalid) ?? 0,
  };
}

function successValues(value: unknown): ('success' | 'failure')[] {
  if (!Array.isArray(value)) return [];
  const out: ('success' | 'failure')[] = [];
  for (const item of value) {
    if ((item === 'success' || item === 'failure') && !out.includes(item)) out.push(item);
  }
  return out;
}

function selectedState(value: unknown): 'final' | 'failed' | 'pending_final' | 'retained' | 'missing' {
  return typeof value === 'string' && SELECTED_STATES.has(value)
    ? value as 'final' | 'failed' | 'pending_final' | 'retained' | 'missing'
    : 'missing';
}

export function sourceFactsReading(raw: unknown): SourceFactsReading {
  const record = isRecord(raw) ? raw : {};
  const selectedRaw = isRecord(record.selected) ? record.selected : null;
  const selected = selectedRaw === null ? null : {
    ref: stringOrNull(selectedRaw.ref),
    state: selectedState(selectedRaw.state),
    modelProvider: stringOrNull(selectedRaw.modelProvider),
    served: stringOrNull(selectedRaw.served),
    effort: stringOrNull(selectedRaw.effort),
    tierAsked: stringOrNull(selectedRaw.tierAsked),
    tierSent: stringOrNull(selectedRaw.tierSent),
    tierServed: stringOrNull(selectedRaw.tierServed),
    error: stringOrNull(selectedRaw.error),
    errorType: stringOrNull(selectedRaw.errorType),
  };
  const hookRaw = isRecord(record.hook) ? record.hook : null;
  const hook = hookRaw === null ? null : {
    models: boundedValues(hookRaw.models),
    successes: successValues(hookRaw.successes),
  };
  return { selected, hook };
}

export function projectionMetaReading(raw: unknown): ProjectionMetaReading {
  const record = isRecord(raw) ? raw : {};
  const families = isRecord(record.families) ? record.families : {};
  const promptRaw = isRecord(families.prompt) ? families.prompt : {};
  return {
    prompt: {
      actualVersion: finite(promptRaw.actualVersion),
      state: typeof promptRaw.state === 'string' && PROMPT_STATES.has(promptRaw.state)
        ? promptRaw.state as 'recomputed' | 'retained' | 'missing' : 'missing',
      reason: typeof promptRaw.reason === 'string' && PROMPT_REASONS.has(promptRaw.reason)
        ? promptRaw.reason as 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown'
        : 'legacy_unknown',
      basis: stringOrNull(promptRaw.basis),
    },
  };
}

export function derivationOf(input: {
  derived_state: string | null;
  summary_state: string | null;
}): DerivationReading {
  if (input.derived_state === 'current') {
    return {
      state: 'clean',
      chain_state: 'current',
      summary_state: input.summary_state === 'recomputed' ? 'current'
        : input.summary_state === null ? 'unavailable' : 'retained',
      reason: null,
    };
  }
  if (input.derived_state === 'dirty') {
    return { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' };
  }
  if (input.derived_state === 'retained') {
    return { state: 'retained', chain_state: 'retained', summary_state: 'retained', reason: 'derived_retained' };
  }
  if (input.derived_state === 'legacy') {
    return { state: 'legacy', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_legacy' };
  }
  return { state: 'unknown', chain_state: 'unavailable', summary_state: 'retained', reason: 'derived_state_unknown' };
}
```

`RequestDetail` 增加 `model_provider: string | null`、`source_facts: SourceFactsReading`、`projection_meta: ProjectionMetaReading`、`derivation: DerivationReading`。`DetailDbRow` 增加 `model_provider: string | null`、`source_facts_json: string | null`、`projection_meta_json: string | null`、`derived_state: string | null`、`summary_state: string | null`，其中后两列来自 C 的查询投影。`getRequest` 的 `SELECT req.*` 已带前三列；把 C 的两列以别名加进同一 SELECT，保证同一只读快照：

```ts
const row = store.read.query<DetailDbRow, [number]>(`
  SELECT req.*,
         (SELECT 1 FROM route_summary s WHERE s.route_id = req.route_id) AS summary_exists,
         req.derived_state AS derived_state,
         req.summary_state AS summary_state
  FROM request req WHERE req.req_id = ?`).get(canonical) as DetailDbRow | null;
```

C 的投影列名不同时只改这两个别名，不改 `derivationOf`。返回对象增加：

```ts
model_provider: row.model_provider,
source_facts: sourceFactsReading(parseJsonOrNull(row.source_facts_json)),
projection_meta: projectionMetaReading(parseJsonOrNull(row.projection_meta_json)),
derivation: derivationOf({
  derived_state: row.derived_state ?? null,
  summary_state: row.summary_state ?? null,
}),
```

不要另查 `derive_queue`。C 是前置依赖：缺任一列或 C 的 `derived_state` 投影未落地，就停止本任务并报告，不跳过集成断言，不从旧列补一份替代状态。详情响应只返回挑选后的对象，不返回原始 JSON。

- [ ] **Step 4：运行测试确认通过。** Run: `bun test tests/queries.test.ts -t 'source_facts|projection_meta|组状态'`。Expected: PASS。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/queries.ts tests/queries.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): project source facts and derivation state safely"
```

## Task 8：尝试链页面消费，未知 fail 原样保留且不补间隔

**Files:**
- Modify: `web/body-view.js`（新增 `renderAttemptChain`）
- Modify: `web/app.js`（`routeBlock` 消费 `attempts`）
- Test: `tests/body-view.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `AttemptChain`、`AttemptItem`。
- Produces: `renderAttemptChain(chain: AttemptChain): string`；只显示已记录字段，不生成 `again_ms`、`interval_ms` 或任何等待差值。

- [ ] **Step 1：写失败测试，锁定未知 fail 与缺时间说明。**

```ts
import { renderAttemptChain } from '../web/body-view.js';
import type { AttemptChain } from '../src/queries';

test('尝试链渲染未知 fail 码与已记录时间', () => {
  const chain: AttemptChain = {
    state: 'present',
    items: [
      {
        index: 0, model: 'm1', provider: 'p1', effort: 'high', status: 500,
        fail: 'synthetic_new_gate', error: null, start_ms: 1761091200000,
        ms: 100, ttft_ms: null, flow_ms: null, served: null,
        queued_ms: null, replan: null, gone: false, earlier: false,
      },
      {
        index: 1, model: 'm2', provider: 'p2', effort: null, status: 200,
        fail: null, error: null, start_ms: 1761091201000,
        ms: 200, ttft_ms: null, flow_ms: null, served: 's',
        queued_ms: null, replan: null, gone: false, earlier: false,
      },
    ],
    timing: { state: 'recorded', note: '时间来自各次尝试的开始时间' },
  };
  const html = renderAttemptChain(chain);
  expect(html).toContain('synthetic_new_gate');
  expect(html).toContain('m1');
  expect(html).toContain('m2');
});

test('缺时间时只显示说明，不补造间隔', () => {
  const html = renderAttemptChain({
    state: 'present',
    items: [{
      index: 0, model: 'm1', provider: null, effort: null, status: 500,
      fail: 'rate_limit', error: null, start_ms: null, ms: null,
      ttft_ms: null, flow_ms: null, served: null, queued_ms: null,
      replan: null, gone: false, earlier: false,
    }],
    timing: { state: 'partial', note: '部分尝试没有开始时间，不推算间隔' },
  });
  expect(html).toContain('不推算间隔');
  expect(html).not.toContain('等待');
  expect(html).not.toContain('间隔 ');
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/body-view.test.ts -t '尝试链渲染|缺时间时'`。Expected: FAIL，`renderAttemptChain` 未导出。

- [ ] **Step 3：实现纯渲染。** 每一行只用 `AttemptItem` 已有字段；未知 fail 原样转义；`timing.state === 'partial'` 时附说明，不计算相邻尝试的时间差。

```js
export function renderAttemptChain(chain) {
  if (chain === null || chain === undefined || chain.state !== 'present') {
    return '<p class="note">没有可读取的尝试记录。</p>';
  }
  const rows = chain.items.map(item => {
    const bits = [item.model ?? '模型未报告'];
    if (item.provider !== null) bits.push(item.provider);
    if (item.status !== null) bits.push(`HTTP ${item.status}`);
    if (item.fail !== null) bits.push(`fail ${item.fail}`);
    if (item.effort !== null) bits.push(`effort ${item.effort}`);
    if (item.start_ms !== null) {
      const started = new Date(item.start_ms);
      if (!Number.isNaN(started.getTime())) bits.push(started.toISOString());
    }
    if (item.ms !== null) bits.push(`${item.ms} ms`);
    return `<span class="attempt-name">${item.index + 1}. ${bits.map(esc).join(' · ')}</span>`;
  }).join('<br>');
  const note = chain.timing.state === 'partial'
    ? `<p class="note">${esc(chain.timing.note)}</p>` : '';
  return `${rows}${note}`;
}
```

`web/app.js` 的 `routeBlock` 删除 `tries.map(t => esc(raw(t)))`，改为 `renderAttemptChain(s.attempts)`；`order` 仍用安全挑选后的对象，不直接打印原始 JSON。

- [ ] **Step 4：运行测试确认通过。** Run: `bun test tests/body-view.test.ts -t '尝试链渲染|缺时间时'`。Expected: PASS。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add web/body-view.js web/app.js tests/body-view.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): render attempt chains without inventing intervals"
```

## Task 9：上下文阅读只在 recomputed 时显示比例

**Files:**
- Modify: `src/queries.ts`（新增 `promptReadingOf`、`PromptReading`；`getRequest` 读取 route prompt）
- Modify: `web/app.js`（`promptSection` 消费 `detail.prompt`）
- Modify: `web/body-view.js`（part 标签与颜色）
- Test: `tests/queries.test.ts`
- Test: `tests/body-view.test.ts`

**Interfaces:**
- Consumes: `route_summary.z` 的 `prompt`、Task 7 的 `ProjectionMetaReading.prompt`、旧列 `parts_json` 与 `prompt_tokens`。
- Produces: `promptReadingOf(prompt, projection, legacyParts, legacyTokens): PromptReading`；`RequestDetail.prompt`；`partLabel(kind)`、`partColor(kind)`。

- [ ] **Step 1：写失败测试，锁定 retained/invalid_input 不显示比例与未知 part 颜色。**

```ts
import { promptReadingOf } from '../src/queries';
import type { ProjectionMetaReading } from '../src/queries';
import { partColor, partLabel } from '../web/body-view.js';

const prompt = { tokens: 500, counted: true, window: 1000, held: false, parts: [{ kind: 'chat', tokens: 300 }] };
const freshPrompt = { prompt: { actualVersion: 3, state: 'recomputed', reason: 'complete', basis: 'req:1' } } as ProjectionMetaReading;
const retainedPrompt = { prompt: { actualVersion: 2, state: 'retained', reason: 'expired_input', basis: null } } as ProjectionMetaReading;
const invalidPrompt = { prompt: { actualVersion: 2, state: 'retained', reason: 'invalid_input', basis: null } } as ProjectionMetaReading;
const missingPrompt = { prompt: { actualVersion: null, state: 'missing', reason: 'legacy_unknown', basis: null } } as ProjectionMetaReading;

test('只有 recomputed 才计算占用比例', () => {
  const fresh = promptReadingOf(prompt, freshPrompt.prompt, null, null);
  expect(fresh.state).toBe('recomputed');
  expect(fresh.ratio).toBe(0.5);
  const retained = promptReadingOf(prompt, retainedPrompt.prompt, null, null);
  expect(retained.state).toBe('retained');
  expect(retained.tokens).toBe(500);
  expect(retained.ratio).toBeNull();
  expect(retained.note).toContain('旧结果');
});

test('缺分母、invalid_input 与 missing 都不显示比例', () => {
  expect(promptReadingOf({ ...prompt, window: null }, freshPrompt.prompt, null, null).ratio).toBeNull();
  const invalid = promptReadingOf(prompt, invalidPrompt.prompt, null, null);
  expect(invalid.state).toBe('retained');
  expect(invalid.reason).toBe('invalid_input');
  expect(invalid.ratio).toBeNull();
  expect(invalid.note).toContain('无法复核');
  expect(promptReadingOf(null, missingPrompt.prompt, [{ kind: 'chat', tokens: 10 }], 10).ratio).toBeNull();
  expect(promptReadingOf(null, missingPrompt.prompt, [{ kind: 'chat', tokens: 10 }], null).tokens).toBeNull();
  expect(promptReadingOf(null, missingPrompt.prompt, null, null).state).toBe('missing');
});

test('未知 part kind 保留名称并使用有效颜色', () => {
  const reading = promptReadingOf({
    ...prompt,
    parts: [{ kind: 'synthetic_part', tokens: 10 }],
  }, freshPrompt.prompt, null, null);
  expect(reading.parts[0]?.kind).toBe('synthetic_part');
  expect(partLabel('synthetic_part')).toBe('synthetic_part');
  expect(partColor('synthetic_part')).toBe('var(--p-unknown)');
  expect(partColor('chat')).toBe('var(--p6)');
  expect(partLabel('<img src=x>')).toBe('<img src=x>');
});

test('六类已知 part 各有颜色与标签', () => {
  expect(['system', 'tools', 'memory', 'files', 'results', 'chat'].map(partColor))
    .toEqual(['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)', 'var(--p5)', 'var(--p6)']);
  expect(partLabel('memory')).toBe('记忆与技能');
  expect(partLabel('history')).toBe('history');
  expect(partColor('history')).toBe('var(--p-unknown)');
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/queries.test.ts -t '占用比例|缺分母|未知 part|六类'`。Expected: FAIL，`promptReadingOf` 未导出，`partColor` 仍用旧四类顺序。

- [ ] **Step 3：实现上下文阅读。** `state` 只取 `ProjectionMetaReading.prompt.state` 的 `recomputed`、`retained`、`missing`；`invalid_input` 保留在 `reason`，不升级成 state。`recomputed` 且 `window > 0` 才计算 `tokens / window`；`retained` 与 `missing` 即使有旧值也不计算比例。旧列只在非 recomputed 时作为历史值附带，附 `legacy: true` 说明；旧列只有 `tokens` 没有 `parts` 时仍然可读，但 `ratio` 保持 null。

```ts
export type PromptReading = {
  state: 'recomputed' | 'retained' | 'missing';
  reason: 'complete' | 'expired_input' | 'invalid_input' | 'legacy_unknown';
  actual_version: number | null;
  tokens: number | null;
  counted: boolean | null;
  window: number | null;
  held: boolean | null;
  parts: { kind: string; tokens: number }[];
  ratio: number | null;
  legacy: boolean;
  note: string | null;
};

function legacyPrompt(parts: unknown, tokens: number | null): (Omit<RoutePrompt, 'tokens'> & { tokens: number | null }) | null {
  if (!Array.isArray(parts) && tokens === null) return null;
  const picked: { kind: string; tokens: number }[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part) || typeof part.kind !== 'string') continue;
      const count = finite(part.tokens);
      if (count === null) continue;
      picked.push({ kind: part.kind, tokens: count });
    }
  }
  return {
    tokens,
    counted: false,
    window: null,
    held: null,
    parts: picked,
  };
}

export function promptReadingOf(
  prompt: unknown,
  projection: ProjectionMetaReading['prompt'],
  legacyParts: unknown,
  legacyTokens: number | null,
): PromptReading {
  const normalized = projection.state;
  const current = safePrompt(prompt);
  const legacy = legacyPrompt(legacyParts, legacyTokens);
  const use = normalized === 'recomputed' ? current : current ?? legacy;
  const ratio = normalized === 'recomputed' && use !== null
    && use.window !== null && use.window > 0 ? use.tokens / use.window : null;
  return {
    state: normalized,
    reason: projection.reason,
    actual_version: projection.actualVersion,
    tokens: use?.tokens ?? null,
    counted: use?.counted ?? null,
    window: use?.window ?? null,
    held: use?.held ?? null,
    parts: use?.parts ?? [],
    ratio,
    legacy: normalized !== 'recomputed' && use !== null && current === null,
    note: normalized === 'recomputed' ? null
      : projection.reason === 'invalid_input' ? '输入无法复核，不显示比例'
        : normalized === 'retained' ? '旧结果，不按当前输入计算比例'
          : '没有可用的上下文分析',
  };
}
```

`getRequest` 的查询增加 `(SELECT z FROM route_summary s WHERE s.route_id=req.route_id) AS summary_z`，`DetailDbRow` 同步增加 `summary_z: Uint8Array | null`，解压后取 `prompt`，与 `projection_meta.prompt`、旧列 `parts_json` 与 `prompt_tokens` 一起调用 `promptReadingOf`。`RequestDetail` 增加 `prompt: PromptReading`。`web/app.js` 的 `promptSection` 改为消费 `detail.prompt`：

- `detail.prompt.ratio !== null` 才画占用条，百分比用 `ratio`，分母用 `window`。
- `ratio === null` 时显示 `detail.prompt.note ?? '没有可用分母，不显示占用率'`，不画条。
- 总量用 `detail.prompt.tokens`，窗口用 `detail.prompt.window`；`counted === true` 才标 `总量已校准`。
- 75% 与 90% 只作为阅读提示色，不写压缩预测。

- [ ] **Step 4：更新 part 表与页面。** `web/body-view.js` 导出六类 part 与未知颜色；`web/index.html` 在根变量、`prefers-color-scheme: dark` 与 `data-theme="dark"` 三处都增加 `--p-unknown`，否则深色主题下未知 part 的色条没有变量。`web/app.js` 的 `promptSection` 使用上面三步的门与文案，删除本地 `PART_NAME`、`PARTS_ORDER`、`partColor`，改从 `body-view.js` 导入 `partLabel`、`partColor`。

```js
export const PARTS = [
  { kind: 'system', label: '系统提示' },
  { kind: 'tools', label: '工具定义' },
  { kind: 'memory', label: '记忆与技能' },
  { kind: 'files', label: '文件引用' },
  { kind: 'results', label: '工具结果' },
  { kind: 'chat', label: '对话内容' },
];

export function partLabel(kind) {
  return PARTS.find(part => part.kind === kind)?.label ?? String(kind);
}

export function partColor(kind) {
  const index = PARTS.findIndex(part => part.kind === kind);
  return index < 0 ? 'var(--p-unknown)' : `var(--p${index + 1})`;
}
```

- [ ] **Step 5：运行测试确认通过。** Run: `bun test tests/queries.test.ts -t '占用比例|缺分母|未知 part|六类' tests/body-view.test.ts`。Expected: PASS。

- [ ] **Step 6：提交（仅在获得提交授权时）。**

```bash
git add src/queries.ts web/app.js web/body-view.js web/index.html tests/queries.test.ts tests/body-view.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): gate context ratios on recomputed prompt analysis"
```

## Task 10：未知类别与角色中性显示，flags 从确定状态聚合

**Files:**
- Modify: `src/queries.ts`（`RequestRow`、`RequestDetail`、`getRequest`、`listSessions` 的 flags）
- Modify: `web/app.js`（`ledgerRow`、`relationTextOf`、`sessionHead` 的 flags 文案）
- Modify: `web/body-view.js`（`deltaOrdinals` 的派生状态门）
- Test: `tests/queries.test.ts`
- Test: `tests/body-view.test.ts`

**Interfaces:**
- Consumes: D 保存的 `req_kind`、`chain_role`、`model_title`；Task 7 的 `derivation`。
- Produces: `RequestRow.req_kind: string`、`RequestRow.chain_role: string` 不再折叠；`SessionRow.flags` 按 `failed`、`unknown`、`missing_body` 顺序聚合；`deltaOrdinals` 在链结果非 current 时返回 null。

- [ ] **Step 1：写失败测试，锁定未知值保留、flags 顺序与不显示 confirmed。**

```ts
test('未知 req_kind 与 chain_role 原样返回，不折叠成 chat 或 main', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`
      INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,req_kind,chain_role)
      VALUES (1,?,'session','actor-a','claude','known',1000,'2026-10-22','through','available',1,7,1,1,'t','user_delta','synthetic_probe','synthetic_role')`,
      [JSON.stringify(['session', 'unknown-kind'])]));
    const detail = getRequest(f.store, 1);
    expect(detail?.req_kind).toBe('synthetic_probe');
    expect(detail?.chain_role).toBe('synthetic_role');
  } finally {
    f.close();
  }
});

test('会话 flags 按确定状态聚合且顺序固定', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'flags']);
    f.store.write(db => {
      const insert = db.prepare(`INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,status,prev_relation)
        VALUES (?,?,'session','actor-a','claude',?,?,'2026-10-22','through',?,1,?,1,1,'t','user_delta',?,?)`);
      insert.run(1, key, 'known', 1000, 'available', 7, 500, 'confirmed');
      insert.run(2, key, 'unknown', 2000, 'pending', 0, 200, 'unknown');
      insert.run(3, key, 'known', 3000, 'available', 7, 200, 'confirmed');
    });
    const session = listSessions(f.store, 10, null).items.find(row => row.conv_key === key);
    expect(session?.flags).toEqual(['failed', 'unknown', 'missing_body']);
  } finally {
    f.close();
  }
});

test('链结果非 current 时不标记新增与 confirmed', () => {
  const dirty = {
    prev_relation: 'confirmed',
    delta_ordinals: [3],
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  } as unknown as RequestDetail;
  expect(deltaOrdinals(dirty)).toBeNull();
  const current = {
    ...dirty,
    derivation: { state: 'clean', chain_state: 'current', summary_state: 'current', reason: null },
  } as RequestDetail;
  expect([...(deltaOrdinals(current) ?? [])]).toEqual([3]);
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/queries.test.ts tests/body-view.test.ts -t '未知 req_kind|flags|非 current'`。Expected: FAIL，`getRequest` 仍把未知类别折叠成 `chat`，`flags` 仍为空，`deltaOrdinals` 仍只看 `prev_relation`。

- [ ] **Step 3：保留未知值并聚合 flags。** `RequestRow` 与 `RequestDetail` 的 `req_kind`、`chain_role` 改为 `string`；`getRequest` 不再写 `row.req_kind === 'title' ? 'title' : 'chat'`。`listSessions` 的 SQL 增加三个聚合列，按固定顺序生成 flags。

```sql
MAX(CASE WHEN status IS NOT NULL AND status >= 400 THEN 1 ELSE 0 END) AS has_failed,
MAX(CASE WHEN actor_state = 'unknown' OR prev_relation = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
MAX(CASE WHEN body_state <> 'available' OR (have & 1) = 0 THEN 1 ELSE 0 END) AS has_missing
```

两个 `listSessions` 分支都要改：非游标查询直接把三列放进 `SELECT`；游标查询的内层聚合查询带三列，外层 `SELECT conv_key, last_ms, request_count, title, agents, has_failed, has_unknown, has_missing` 也要带出。`SessionDbRow` 增加这三个数字字段，`items` 映射统一调用下面的 flags 组装。

```ts
const flags: string[] = [];
if (row.has_failed === 1) flags.push('failed');
if (row.has_unknown === 1) flags.push('unknown');
if (row.has_missing === 1) flags.push('missing_body');
```

`getRequest` 返回 `req_kind: row.req_kind ?? 'unknown'`、`chain_role: row.chain_role ?? 'unknown'`、`model_title: row.model_title`，已知字符串原样保留，空值与未知字符串走中性显示；不得把空值补成 `chat` 或 `main`。`deltaOrdinals` 增加门：

```js
export function deltaOrdinals(detail) {
  if (detail === null) return null;
  if (detail.derivation === undefined || detail.derivation.chain_state !== 'current') return null;
  if (detail.prev_relation !== 'first' && detail.prev_relation !== 'confirmed') return null;
  if (!Array.isArray(detail.delta_ordinals)) return null;
  return new Set(detail.delta_ordinals);
}
```

`tests/body-view.test.ts` 原有的 `deltaOrdinals` 与 `renderMessages` 夹具没有 `derivation`，必须先补上 `{ state: 'clean', chain_state: 'current', summary_state: 'current', reason: null }`，否则新增的 gate 会把旧断言从新增改成无新增，全量测试会失败。

`web/app.js` 的 `relationTextOf` 同样先检查 `detail.derivation.chain_state === 'current'`；否则返回 `关系待重建或为旧结果，不标记新增`。`ledgerRow` 只在 `chain_role === 'branch'` 且链结果 current 时显示分支；`aux` 只在 `req_kind === 'title'` 时显示标题请求；未知值显示中性 `请求` 与 `角色未知`，不套 `aux` 样式。

- [ ] **Step 4：运行测试确认通过。** Run: `bun test tests/queries.test.ts tests/body-view.test.ts -t '未知 req_kind|flags|非 current'`。Expected: PASS。

- [ ] **Step 5：提交（仅在获得提交授权时）。**

```bash
git add src/queries.ts web/app.js web/body-view.js tests/queries.test.ts tests/body-view.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(reading): keep unknown request kinds neutral and aggregate session flags"
```

## Task 11：分页方向、滚动保持、复制与页面收口

**Files:**
- Modify: `web/app.js`（`renderConversation`、`renderMain`、`renderRail`、`routeBlock`、`promptSection`、复制事件）
- Modify: `web/body-view.js`（`messageEntries`、`messageCopyText`、`renderMessageDetail`）
- Modify: `web/index.html`（按钮文案）
- Test: `tests/web.test.ts`
- Test: `tests/body-view.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `interpretations`、Task 5 的 `capabilities`、Task 6 的 `AttemptChain`、Task 9 的 `prompt`、Task 10 的 `derivation`。
- Produces:
  - `messageCopyText(entry): string`
  - `restoreScroll(element, previous): number`
  - 页面只使用服务端解释，不再有 `HARNESS_BLOCKS`、`cleanUserText`、`isAuxTitleRequest`。`titleOfReplyText` 只解析标题请求的回复文本，不参与输入清洗，保留原实现。

- [ ] **Step 1：写失败测试，锁定复制原文与滚动恢复。**

```ts
import { messageCopyText, messageEntries, renderMessageDetail } from '../web/body-view.js';
import { restoreScroll } from '../web/app.js';

test('复制文本保留原文，不做 HTML 转义', () => {
  const payload = '<script>alert(1)</script>';
  const entries = messageEntries(page({
    messages: [{ ord: 0, value: { role: 'user', content: payload } }],
    interpretations: [{
      ord: 0,
      role: 'user',
      role_state: 'known',
      input: {
        state: 'text', kind: 'plain', text: payload,
        original: payload, removed: [], agent: null, rule: 'generic',
      },
      is_input: true,
    }],
  }));
  expect(messageCopyText(entries[0]!)).toBe(payload);
  // 详情渲染仍转义；复制路径与 HTML 路径分开。
  expect(renderMessageDetail(entries[0]!)).toContain('&lt;script&gt;');
});

test('滚动恢复夹在可滚动范围内', () => {
  expect(restoreScroll({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 700)).toBe(700);
  expect(restoreScroll({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 900)).toBe(800);
  expect(restoreScroll({ scrollHeight: 100, clientHeight: 200, scrollTop: 0 }, 50)).toBe(0);
});
```

- [ ] **Step 2：运行测试确认失败。** Run: `bun test tests/web.test.ts tests/body-view.test.ts -t '复制文本|滚动恢复'`。Expected: FAIL，`messageCopyText` 与 `restoreScroll` 未导出。

- [ ] **Step 3：页面消费服务端解释。** `messageEntries` 用 `page.interpretations` 按 ord 建表，`Entry.input` 直接取服务端结果；`isInput` 只认 `interpretation.is_input`，不再按 `role === 'user' && hasText` 猜一份。`renderConversation` 渲染 `entry.isInput` 的消息，多条用户消息逐条成气泡；`input.state === 'text'` 显示 `input.text`，`unrecognized` 显示原文并标 `包装未识别`；请求内没有可见输入时显示 `这一笔没有新的用户可见消息`。删除 `isAuxTitleRequest`、`HARNESS_BLOCKS`、`cleanUserText`；`titleOfReplyText` 保留，标题请求的回复仍按 `<title>` 标签或单键 `title` JSON 提取标题文本。`req_kind === 'title'` 才显示 `生成会话标题`。

`messageEntries` 改完后，`tests/body-view.test.ts` 里凡是没有 `interpretations` 的旧用例都会得到 `isInput: false`。其中只断言块形状、预览、转义或条数的用例可以保留；涉及 `isInput`、`renderMessages` 新增标记或 `deltaOrdinals` 的用例必须补解释。下面替换工具结果消息不算用户输入用例：

```ts
const entries = messageEntries(page({
  messages: [
    { ord: 0, value: { role: 'user', content: [{ type: 'text', text: '读一下文件' }] } },
    { ord: 1, value: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }] } },
    { ord: 2, value: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
  ],
  interpretations: [
    {
      ord: 0, role: 'user', role_state: 'known', is_input: true,
      input: { state: 'text', kind: 'plain', text: '读一下文件', original: '读一下文件', removed: [], agent: null, rule: 'generic' },
    },
    { ord: 1, role: 'assistant', role_state: 'known', input: null, is_input: false },
    { ord: 2, role: 'user', role_state: 'known', input: null, is_input: false },
  ],
}));
expect(entries.map(entry => entry.isInput)).toEqual([true, false, false]);
```

```js
export function messageEntries(page) {
  if (page === null || page === undefined) return [];
  const byOrd = new Map((page.interpretations ?? []).map(item => [item.ord, item]));
  return page.messages.map(message => {
    const blocks = messageBlocks(message.value);
    const role = roleOf(message.value);
    const interpretation = byOrd.get(message.ord) ?? null;
    return {
      ord: message.ord,
      role,
      blocks,
      preview: messagePreview(blocks),
      input: interpretation === null ? null : interpretation.input,
      isInput: interpretation !== null && interpretation.is_input === true,
    };
  });
}

export function messageCopyText(entry) {
  return entry.blocks.map(block => block.text).filter(text => text.length > 0).join('\n\n');
}

export function restoreScroll(element, previous) {
  const max = Math.max(0, (element.scrollHeight ?? 0) - (element.clientHeight ?? 0));
  element.scrollTop = Math.min(Math.max(0, previous), max);
  return element.scrollTop;
}
```

`restoreScroll` 定义在 `if (typeof document !== 'undefined')` 之前并导出；测试导入 `web/app.js` 不会执行 DOM 初始化。

`ensureBody` 合并后续页时还要保留首片的 `capabilities`、`interpretations` 与 `coverage`；后续页的能力视图本来就每片重算，但解释只覆盖当前页，不能把前几片的解释丢掉：

```js
const page = await reader.loadBody(id, from);
const isFirst = from === 0;
const previous = bodies.get(id);
const interpretations = isFirst
  ? page.interpretations
  : [...(previous?.page?.interpretations ?? []), ...page.interpretations];
const entries = isFirst ? messageEntries(page) : [...(previous?.entries ?? []), ...messageEntries(page)];
const mergedPage = isFirst ? page : {
  ...page,
  request_fields: previous?.page?.request_fields ?? null,
  reply: previous?.page?.reply ?? null,
  capabilities: page.capabilities,
  interpretations,
  coverage: { ...page.coverage, from: 0 },
};
```

`ensureBody` 返回的完整对象如下，`page` 用 `mergedPage`，其余字段照抄：

```js
return {
  page: mergedPage,
  entries,
  nextFrom: from + page.messages.length,
  total,
  exhausted: page.messages.length === 0 || (total !== null && from + page.messages.length >= total),
  error: null,
};
```

`renderMessageDetail` 增加 `复制原文` 按钮，事件处理器调用 `navigator.clipboard.writeText(messageCopyText(entry))`；不把 HTML 片段写入剪贴板。`renderMain` 用 `restoreScroll(main, keep)` 替换直接赋值；`renderRail` 记录 `lastRailReq`，同一请求重绘保留 `rail-body` 滚动，换请求才回到顶部。

- [ ] **Step 4：修正分页方向与路由/上下文展示。** `web/index.html` 的 `load-more-requests` 改为 `加载更晚请求`；`web/app.js` 中 `更早的请求`、`更早页` 改为 `更晚请求`、`更晚页`，`ordinalOf` 注释同步改成更晚方向。`web/app.js` 从 `body-view.js` 导入 `renderAttemptChain, partColor, partLabel`，`routeBlock` 改为 `renderAttemptChain(s.attempts)`；`promptSection` 用 `detail.prompt`，`ratio === null` 时不画占用率，并删除本地 `PART_NAME`、`PARTS_ORDER`、`partColor`。

- [ ] **Step 5：运行测试与文案检查。** Run: `bun test tests/web.test.ts tests/body-view.test.ts`。Expected: PASS。再运行：

```bash
grep -q '加载更晚请求' web/index.html
! grep -q '更早的请求' web/app.js
! grep -Eq 'cleanUserText|HARNESS_BLOCKS|isAuxTitleRequest' web/app.js
```

Expected: 三条命令都成功，退出码 0。

- [ ] **Step 6：提交（仅在获得提交授权时）。**

```bash
git add web/app.js web/body-view.js web/index.html tests/web.test.ts tests/body-view.test.ts
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "feat(web): consume server interpretations and fix reading interactions"
```

## Task 12：文档、决策记录与整体验收

**Files:**
- Modify: `docs/architecture-design.md`（`## 派生字段` 下新增 `### 输入解释与能力阅读`；`### 路由摘要长期层` 补 format 2 的只读消费；`## 查询接口` 补安全字段）
- Move: `.agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md` → `.agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md`（内容改为 implemented 格式）
- Test: 全部相关测试

**Interfaces:**
- Consumes: Task 1 至 Task 11 的实现与测试。
- Produces: 现行文档与决策记录；不改变运行时接口。

- [ ] **Step 1：先做 supersession check。** Run:

```bash
grep -RIn '输入解释\|包装\|技能清单\|capability\|input interpretation' .agents/notes/implemented .agents/notes/proposed
```

Expected: 找到 `2026-10-21-title-generator-and-main-chain.md` 与 `2026-10-22-agent-request-kind-registry.md`。前者只部分涉及标题清洗，保留活跃并交叉链接；后者是 proposed，不归档。若发现完全取代同一决策的 implemented note，按 `.agents/notes/README.md` 归档并在新 note 里链接。

- [ ] **Step 2：写现行文档。** 新增一节，写清服务端解释、原文保留、能力五种状态、route z format 2 的只读字段、详情白名单与派生状态门。不要写变更史，不复制完整类型定义。

```markdown
### 输入解释与能力阅读

正文分页在服务端附带消息级展示解释与能力视图。解释只影响显示，原始脱敏消息、块哈希与语义指纹保持原值；页面不再维护第二套包装规则。

输入解释区分普通文本、包装后文本、插话、标题请求、命令回显与技能注入；未闭合或无法识别的包装保留原文并标未识别。同一请求的多条用户消息逐条解释，不合并成一条。

能力视图把协议工具定义与 Agent 技能声明分开。工具缺失、为空、格式未识别与协议不支持分别报告；技能在正文不完整时为 partial，正文不可读时为 missing，不把未读到解释成零技能。能力按正文读取即时计算，不长期复制技能描述或工具 schema。

路由详情只读 `route_summary.z` 的 format 2 安全字段与现有列，详情接口不返回 account、host、`who`、`id` 或任意原始 JSON。尝试链保留未知 fail 原值，缺少开始时间时不推算间隔。上下文比例只在 prompt family 的 state 为 recomputed 且有正窗口时显示；retained 与 reason 为 invalid_input 的值只作历史展示。

链关系与新增消息只在派生状态为 clean 且链结果为 current 时标为当前。dirty、retained、legacy 与 unknown 分别显示重建中、历史保留、旧算法与状态未知，不显示 confirmed。
```

- [ ] **Step 3：把 Task 1 的 Agent Note 移入 implemented。** 先执行 `git mv .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md .agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md`；proposed 生命周期不能留在 implemented 目录。再改写为 implemented 格式，记录为什么集中到服务端、放弃了什么、代价是什么，不复制字段表。必须包含 `Status: implemented`、`## Problem`、`## Decision`、`## Alternatives considered`、`## Consequences`、`## Testing`，不得保留 `## Proposal`、`## Acceptance criteria` 或 `## Risks`。

```markdown
# Agent Note: 服务端输入解释与能力阅读

Status: implemented

## Problem

服务端派生与页面各有一套 harness 包装清洗；标题、摘要和对话视图对同一段输入可能给出不同文本。能力区块在页面按已加载消息猜测技能，首片没读到 system 文本时会显示成零技能。路由尝试与上下文比例也缺少统一的安全投影。

## Decision

输入解释集中到 `src/input-interpretation.ts`，能力提取集中到 `src/capabilities.ts`。正文分页返回消息级解释、覆盖状态与能力视图；页面只渲染服务端结果。解释不修改原文、块哈希或语义指纹。

## Alternatives considered

**继续维护两份正则。** 前后端规则会继续漂移，插话与 caveat 的差异无法用同一组回归固定。

**引入前端构建复用 TypeScript。** 生产页面是无构建原生 JavaScript；为一次展示引入构建会扩大部署面，收益不足。

**把技能与工具 schema 长期复制到派生列。** 会绕过正文保留预算，且正文回收后仍要维护第二份内容。

## Consequences

- 正文分页响应变大，但只增加短文本与计数，不复制完整工具 schema。
- 能力提取只解压 role=system 的块，不扫描全部消息；正文 partial 时只能报 partial。
- 旧请求没有 format 2 与 projection_meta 时显示缺失或旧结果，不从原始 JSON 补猜。
- 未知类别、角色、part 与 fail 保持原值，页面不再按命名推断用途。

## Testing

`bun test tests/input-interpretation.test.ts tests/capabilities.test.ts tests/protocols.test.ts tests/body-api.test.ts tests/body-view.test.ts tests/queries.test.ts tests/web.test.ts tests/derive.test.ts`，以及 `bun run typecheck`。合成用例覆盖嵌套畸形包装、多条用户消息、未知 agent、能力五种状态、route z 白名单、未知 fail、缺时间、retained 比例、未知 part 颜色、flags 与滚动恢复。
```

- [ ] **Step 4：运行整体验收。** Run:

```bash
bun test tests/input-interpretation.test.ts tests/capabilities.test.ts tests/protocols.test.ts tests/body-api.test.ts tests/body-view.test.ts tests/queries.test.ts tests/web.test.ts tests/derive.test.ts
bun run typecheck
```

Expected: 全部 PASS；`tsc --noEmit` 无错误。`tests/reader-types.ts` 只断言 `BodyPage.state` 与 `reason`，新增字段不改变这两个类型。

- [ ] **Step 5：检查文档与 note 格式。** Run: `bun run verify:notes:staged`。Expected: PASS。若尚未 stage，改用 `node scripts/verify-agent-note-format.mjs` 与 `node scripts/verify-archived-agent-notes.mjs` 检查格式；不虚构 staged 检查结果。

- [ ] **Step 6：提交（仅在获得提交授权时）。**

```bash
git add docs/architecture-design.md
git add .agents/notes/proposed/feature/2026-10-22-server-side-input-interpretation.md
git add .agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md
git commit -m "docs(reading): document server-side input interpretation and capability states"
```

---

## 验收清单

- [ ] 服务端解释覆盖普通文本、包装、插话、标题请求、命令回显、技能注入；嵌套与畸形标签保留原文。
- [ ] 同一请求的多条用户消息逐条展示，不合并；未知 agent 不推断身份。
- [ ] `block.fingerprint`、消息对象与 `src/fingerprint.ts` 未改变；测试证明展示解释前后指纹一致。
- [ ] 正文分页返回 `interpretations` 与 `coverage`；回收、未到、partial 不伪造空对话。
- [ ] 能力视图区分 present、empty、unrecognized、missing、partial；partial 与 missing 不显示零技能。
- [ ] 工具定义按 anthropic/chat 两种协议读取；技能按标签与 Claude 标题两种格式读取；未知 agent 仍解析共享格式。
- [ ] `route_summary.z` 只读 format 2；旧行按 format 1 降级；详情不含 account、host、`who`、`id` 与原始 JSON。
- [ ] 尝试链保留未知 fail 原值；缺开始时间时不生成间隔字段。
- [ ] 上下文比例只在 recomputed 且窗口为正时显示；retained、reason 为 invalid_input、missing 不显示比例。
- [ ] 六类 part 有固定标签与颜色；未知 part 使用 `--p-unknown` 且保留原名。
- [ ] 未知 `req_kind`、`chain_role` 原样保留并中性显示；不从类别名推断 aux。
- [ ] 派生状态非 clean/current 时不显示 confirmed、不标记新增。
- [ ] 会话 flags 按 failed、unknown、missing_body 顺序从确定状态聚合。
- [ ] 请求分页按钮与说明写更晚方向；正文分片仍按 ord 递增，后续页合并后 `interpretations` 覆盖全部已加载 ord。
- [ ] 滚动在重绘后保持；复制使用纯文本，原文不被 HTML 转义。
- [ ] 文档与 Agent Note 写现行契约，不写变更史；note 通过格式检查。

## 风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| C 的 `model_provider`、`source_facts_json` 或 `projection_meta_json` 尚未落地 | Task 7 不能开始 | C 是前置依赖；停止并报告，不跳过集成断言，不自行加列或从旧列补状态 |
| C 的 `derived_state` 或 `summary_state` 值域与本文不同 | 派生状态门无法接通 | 只改 `derivationOf` 一个纯函数；其余代码只认 `DerivationReading`，不另读组表 |
| 能力提取解压全部 system 块 | 超长 system 增加单次正文请求成本 | 只解压 role=2 的块，不扫描全部消息；F 的容量测量记录增量，不在本批宣称吞吐 |
| 旧 route z 没有 format 2 | 上下文与 kind/folder/effort 缺失 | 按 format 1 降级，不从 `raw_route.payload_json` 补 |
| 标题与摘要行为受解释规则影响 | 既有标题可能变化 | Task 2 保留原有回归；任何规则收紧另立用例，不混入本批 |
| 未知类别被 D 的标题 SQL 排除 | 未知类别请求可能没有会话标题 | 由 D 的链参与策略处理；E 只做中性显示，不改 `SESSION_TITLE_SQL` |
| 页面滚动在窄屏与右栏行为不同 | 重绘后位置跳变 | `restoreScroll` 统一夹取；浏览器手工核对会话切换与消息翻页 |
| 正文分页逐片解释导致合并遗漏 | 后续页覆盖前页解释，消息被误判为非输入 | `ensureBody` 合并 `interpretations`；`isInput` 只读服务端结果，不在页面重猜 |
| proposed note 留在 implemented 目录 | note 格式门禁失败 | Task 12 用 `git mv` 移到 `implemented/`，并去掉提案期章节 |
| 详情响应字段增加 | 响应体积变大 | 只返回短字符串、计数与安全数组；不返回 schema 全文或原始 JSON |
