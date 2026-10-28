# ATC 前端走读修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 2026-10-28 生产前端走读报告里经核实成立的缺陷，按「状态不撒谎 → 轮次与旁路 → 交互与口径」三批发版，每批带最窄回归测试与可回滚的验收。

**Architecture:** 前端是无构建的原生 ES module，静态文件按请求读盘，改完刷新即生效；后端是 Bun 单进程，改完必须经 `bun run service restart|stop|start` 才生效。轮次判据与用途判定属于派生层，代码改动只对新派生生效，历史行必须按会话 `maintain rebuild` 换代；这批写操作独立成一个部署窗口，先备份、先停服务。

**Tech Stack:** TypeScript + Bun、`bun:sqlite`、原生 JS 前端、zstd 正文块。

**Spec:** `/tmp/atc-review-20261028/report-zcode-2026-10-28.md`（输入报告，未进仓）；`/tmp/atc-fix-handoff-2026-10-28.md`（上一轮交接）；`docs/architecture-design.md`（设计权威）；`.agents/notes/implemented/feature/2026-10-25-turn-pair-reading.md` 与 `.agents/notes/implemented/bug-fix/2026-10-27-chain-role-uncertainty-propagation.md`（轮次与链角色的既有决策）。

## 全局约束

- 非平凡变更同一提交带至少一篇 Agent Note，提交前跑 `bun run verify:notes`；纯机械改动提交信息写 `Agent-Note: none — <reason>`。
- 跨文件实现走 worktree：`../../.codex-worktrees/atc-<topic>` 建 `fix/` 分支，提交只落分支，`master` 只以 `--no-ff` 合并；文档与单文件修正在主检出做。
- 测试只用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。
- 生产服务由 launchd 托管，起停只走 `bun run service stop|start|restart`，不 `kill`。
- 维护命令（`maintain rebuild`、`maintain backup`、`--apply` 类）一律在服务已停的前提下执行；先备份，再写库。
- schema 变更必须带可执行 backfill 或明确的拒绝路径。本计划不新增列，只新增 `input_preview_kind` 的取值，无 DDL。
- 报告忠实：合成数据验收与真实流量验收分开写，不把跳过、未执行说成通过。

## 0. 先修正报告的三处偏差

报告有三处结论与当前 master（`cb2cdff`）的事实不符，执行前必须先纠正，否则会按错误方向改代码。

| 报告结论 | 实测事实 | 处置 |
| --- | --- | --- |
| P0-3 根因是 `isStart` 只认 `unknown + prev_relation='unknown'`，「用户新命令行是 unknown + confirmed」 | 最大会话 `0a950369` 的命令行是 `unknown + prev_relation='unknown'`，被 `isCommand`（只认 `input_preview_kind='delta'`）挡掉，不是被 `isStart` 挡掉。按 v5 链角色近似模拟：当前 64 个会话 / 163 轮；只放宽 `isStart` 得 78 / 296；只用「末条消息是用户文本」代理放宽 `isCommand` 得 81 / 494 | P0-3 拆成两步：先放宽 `isStart`，再补「末条消息是用户主动文本」的派生位让 `tail` 行可判。两步都做才覆盖 `0a950369` |
| P0-4 的 suggestion/压缩请求「只修 P0-3 会变成轮起点」 | 82 条指纹行全部是 `delta + confirmed + final`；其中 43 条 `chain_role='main'`，今天已经是轮起点，正在把注入模板当用户命令渲染 | P0-4 是现存缺陷，不是 P0-3 引入的。先修 P0-4，再放宽 P0-3，部署窗口内先重建再起服务 |
| P1-1「加载更早」丢阅读位置 | 当前 `loadLater` 只在列表尾部追加，没有 prepend 路径；`3c0da9a` 已把窗口改成锚定会话开头。「加载更早」按钮不存在，`reader-store.js:110` 只剩一条过期注释 | 在当前 master 上重测；立项前不写代码。P2-7 同属「先重测」：`renderAll()` 每次都会调 `updateURL()`，`tab=bogus` 很可能已被清掉 |
| P1-4 方向键与拖拽语义相反 | 分隔线在右栏左沿：右拖变窄；`ArrowRight` 也是变窄。两者同向，物理正确 | 误报，不修 |

另有两处属于文档与决策错位，不按缺陷修：

- P2-1 轮次身份行只标「轮 N」是 2026-10-25 的有意裁剪（`.agents/notes/implemented/simplification/2026-10-25-turn-head-and-topbar-slimming.md`）。过时的是 `docs/architecture-design.md:924`，改文档。
- P2-8 `offset` 不在 `GET /api/sessions` 的接口表里，分页契约是 keyset + `cursor`。静默忽略未知参数的处置需要定口径，见 §5。

## 1. 批次与部署窗口

| 批次 | 内容 | 生效方式 | 需要授权 |
| --- | --- | --- | --- |
| A 状态不撒谎 | P0-1、P0-2、P2-6 | 刷新页面即生效 | 否 |
| B 轮次与旁路 | P0-4、P0-3A、P0-3B | 重启服务 + 按会话重建 | 是（停服务、备份、写库） |
| C 交互与口径 | P1-2、P1-3、P1-5、P1-6、B15、P2-3、P2-4、P2-10 | 刷新页面即生效 | 否 |
| D 文档 | P2-1 | 无运行时影响 | 否 |

批次 A 与 C 都是 `web/` 下的改动，可以并行开发、合并后一起刷新验收。批次 B 必须先于 A/C 之外的任何「轮次判据放宽」上线，且重建与重启在同一个窗口完成。

## 2. Task 1：空回复继承正文状态（P0-1、P0-2、P2-6）

报告把这三项拆成两个 P0，根因是同一处：`replyView()` 丢掉 `page.state`。三个症状分别是读数页文案、中栏 Event 行、OTLP summary 文案。一个提交收掉。

**Files:**
- Modify: `web/body-model.js:13,367-371`
- Modify: `web/body-view.js:205-212`
- Modify: `web/row-summary.js:36-42`
- Modify: `web/trace-view.js:517-528,577`
- Test: `tests/body-view.test.ts`
- Test: `tests/trace-view.test.ts`

**Interfaces:**
- Produces: `ReplyView.state` 的联合从 `'ok' | 'absent' | 'invalid'` 扩到再加 `'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial'`。
- Consumes: `BodyPage.state` 与 `BodyPage.reply_state`。

- [ ] **Step 1: 写失败的测试**

在 `tests/body-view.test.ts` 追加：

```ts
test('空回复继承正文状态：未到、回收、摘要与部分正文分开报', () => {
  expect(replyView(page({ state: 'pending', reply: null })).state).toBe('pending');
  expect(replyView(page({ state: 'evicted', reply: null })).state).toBe('evicted');
  expect(replyView(page({ state: 'summary', reply: null })).state).toBe('summary');
  expect(replyView(page({ state: 'partial', reply: null })).state).toBe('partial');
  expect(replyView(page({ state: 'unsupported', reply: null })).state).toBe('unsupported');
  // 正文可读却确实没有回复对象，才落到 absent。
  expect(replyView(page({ state: 'available', reply_state: 'absent', reply: null })).state).toBe('absent');

  const pending = replyView(page({ state: 'pending', reply: null }));
  expect(renderReply(pending)).toContain('回复还没到');
  expect(renderReply(pending)).not.toContain('上游没有提供可用回复');
  expect(replyCompleteness({ status: 200 }, pending)).toEqual({ key: 'unknown', label: '回复未到' });
  const evicted = replyView(page({ state: 'evicted', reply: null }));
  expect(renderReply(evicted)).toContain('正文已回收');
  expect(replyCompleteness({ status: 200 }, evicted)).toEqual({ key: 'unknown', label: '正文已回收' });
});
```

`replyCompleteness` 从 `../web/row-summary.js` 导入。

在 `tests/trace-view.test.ts` 增加一条：pending 正文的步骤里没有文本为「未收到回复」的 Event，只有 `正文状态：pending` 的记录行。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/body-view.test.ts tests/trace-view.test.ts`
Expected: 新增用例失败，`replyView(pending).state` 仍为 `'absent'`。

- [ ] **Step 3: 改 `web/body-model.js`**

第 13 行的 typedef 改为：

```js
 * @typedef {{state: 'ok' | 'absent' | 'invalid' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial', text: string, thinking: string[], calls: ToolCallView[], blocks: Block[], choiceCount: number | null, finish: string | null, model: string | null, raw: unknown}} ReplyView
```

在 `replyView` 前加：

```js
/**
 * 没有回复对象时继承正文状态。正文未到（pending）不等于上游没有提供回复，
 * 已回收、未适配与摘要也不是同一件事；正文可读时才用 reply_state 解释，
 * 那是服务端对回复本身的判定。只有读得到正文且服务端明说没有回复，才是 absent。
 * @param {BodyPage | null} page
 * @returns {'absent' | 'invalid' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial'}
 */
function emptyReplyState(page) {
  if (page === null || page === undefined) return 'absent';
  if (page.state === 'pending' || page.state === 'evicted' || page.state === 'unsupported'
    || page.state === 'summary' || page.state === 'partial') return page.state;
  if (page.reply_state === 'invalid') return 'invalid';
  if (page.reply_state === 'unsupported') return 'unsupported';
  return 'absent';
}
```

`replyView` 的空回复分支改成：

```js
  if (reply === null || reply === undefined) {
    return { state: emptyReplyState(page), text: '', thinking: [], calls: [], blocks: [], choiceCount: null, finish: null, model: null, raw: null };
  }
```

- [ ] **Step 4: 改 `web/body-view.js`**

在 `renderReply` 前加一张文案表，并把 `absent` 分支换成按状态取文案：

```js
/** 空回复的文案按正文状态分开：未到可等，回收与摘要不可等，缺失才是真的没有。 */
const EMPTY_REPLY = /** @type {Record<'absent' | 'pending' | 'evicted' | 'unsupported' | 'summary' | 'partial', [string, string]>} */ ({
  absent: ['上游没有提供可用回复', '请求正文已保存；这一笔只有请求，没有回复对象，这里不补写内容。'],
  pending: ['回复还没到', '正文未到（hook 尚未回调）；这一笔可能稍后补上，不是没有回复。'],
  evicted: ['回复随正文一起回收', '正文已回收，回复不再可读；原因见正文状态。'],
  unsupported: ['回复暂不可读', '原对象已保存，暂不支持结构化解析。'],
  summary: ['回复不在摘要里', '正文来自 OTLP 摘要，没有保存完整回复对象，这里不补写内容。'],
  partial: ['回复不在已保存的部分里', '正文不完整；已保存的部分没有回复对象，原因见正文状态。'],
});
```

```js
  if (view.state !== 'ok' && view.state !== 'invalid') {
    const [head, body] = EMPTY_REPLY[view.state];
    return `<div class="reply-empty"><b>${head}</b><span>${body}</span></div>`;
  }
```

`invalid` 分支保持原样。

- [ ] **Step 5: 改 `web/row-summary.js`**

`replyCompleteness` 的 `absent` 判定改成：

```js
const EMPTY_REPLY_LABELS = /** @type {Record<string, string>} */ ({
  absent: '缺失回复', pending: '回复未到', evicted: '正文已回收',
  unsupported: '回复暂不可读', summary: '摘要无回复', partial: '正文不完整', invalid: '回复无法解析',
});

export function replyCompleteness(row, view) {
  void row;
  if (view === null) return { key: 'absent', label: '缺失回复' };
  if (view.state !== 'ok') {
    return { key: view.state === 'absent' ? 'absent' : 'unknown', label: EMPTY_REPLY_LABELS[view.state] ?? '回复状态未知' };
  }
  const finish = view.finish;
  // ...以下不变
}
```

- [ ] **Step 6: 改 `web/trace-view.js`**

回复事件的分支改成：

```js
  } else if (view === null || view.state === 'absent') {
    record('reply', 'missing_reply', '未收到回复');
  } else if (view.state === 'partial') {
    record('reply', 'unknown', '回复不在已保存的部分里 · 正文不完整');
  } else if (view.state !== 'ok') {
    // pending / evicted / unsupported / summary / invalid：正文状态行已经说明状态，
    // 这里不再补一条「未收到回复」，避免同屏两句话互相打架。
  } else if (view.choiceCount !== null && view.choiceCount > 1) {
```

第 577 行的收尾检查改成 `if (view !== null && view.state === 'ok') {`。

- [ ] **Step 7: 跑测试**

Run: `bun test tests/body-view.test.ts tests/trace-view.test.ts`
Expected: PASS。

- [ ] **Step 8: 全量类型检查与提交**

Run: `bun run typecheck`
Expected: 无错误。

提交信息：

```text
fix(web): keep the body state when a reply is missing

replyView collapsed every empty reply into "absent", so a pending hook was
reported as "upstream provided no reply". Carry pending, evicted,
unsupported, summary and partial through ReplyView, and let the rail and
trace rows print the matching copy.

Agent-Note: .agents/notes/implemented/bug-fix/2026-10-28-reply-state-inherits-body-state.md
```

## 3. Task 2：登记 Claude 的 suggestion 与压缩旁路（P0-4）

两族指纹都写在**最后一条 user 消息**的块首，而现有 `userBlockHeads` 只取前 5 条 user 消息，照抄 OMP 的写法会 0 命中。需要给 `PurposeView` 增加末尾块首取数。

**Files:**
- Modify: `src/semantics.ts:6,29-34`
- Modify: `src/request-purpose.ts:37-39,150-165,180-210,250-256`
- Modify: `src/harness/claude.ts`
- Modify: `src/harness/purpose.ts:25-29`
- Test: `tests/semantics.test.ts`
- Test: `tests/harness-purpose.test.ts`
- Test: `tests/request-purpose.test.ts`

**Interfaces:**
- Produces: `PurposeView.tailUserBlockHeads: string[]`（末尾 2 条 user 消息的文本块块首，按消息顺序）。
- Produces: `suggestionDecision(view)`、`compactionDecision(view)`，两者返回 `chain: 'exclude'`，kind 分别为 `suggestion_mode`、`context_compaction`。
- Produces: `PURPOSE_VERSION = 6`。

- [ ] **Step 1: 写失败的测试**

`tests/semantics.test.ts` 的 `view()` 助手补 `tailUserBlockHeads: []`，并追加：

```ts
test('claude suggestion 与上下文压缩按尾部块首识别为旁路', () => {
  expect(classifyPurpose(view({
    agent: 'claude',
    tailUserBlockHeads: ['[SUGGESTION MODE: continue the conversation'],
  }))).toMatchObject({ chain: 'exclude', kind: 'suggestion_mode', rule: 'claude.suggestion-mode.v1' });

  expect(classifyPurpose(view({
    agent: 'claude',
    tailUserBlockHeads: ['CRITICAL: Respond with TEXT ONLY. Do not call tools.'],
  }))).toMatchObject({ chain: 'exclude', kind: 'context_compaction', rule: 'claude.compaction.v1' });

  // 指纹在前几条 user 消息里不算：那是历史上下文，不是本次旁路模板。
  expect(classifyPurpose(view({
    agent: 'claude',
    userBlockHeads: ['[SUGGESTION MODE: old'],
    tailUserBlockHeads: ['普通用户消息'],
  }))).toMatchObject({ chain: 'participate' });
});
```

`tests/request-purpose.test.ts` 追加一条：一笔正文末尾带 suggestion 模板的请求，`task.view.tailUserBlockHeads` 含该前缀，且前 5 条之外的模板也能取到。复用文件里现有的 `seedBody` / `runPurpose` 脚手架。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/semantics.test.ts tests/harness-purpose.test.ts tests/request-purpose.test.ts`
Expected: 新增断言失败，`tailUserBlockHeads` 不存在或规则不命中。

- [ ] **Step 3: 改 `src/semantics.ts`**

`PURPOSE_VERSION` 改为 `6`。`PurposeView` 增加字段：

```ts
  /** user 文本块的块首（前 5 条）：旁路强指纹按块首匹配。 */
  userBlockHeads: string[];
  /** 末尾 2 条 user 消息的文本块块首：suggestion 与压缩模板跟随本次输入写在末尾。 */
  tailUserBlockHeads: string[];
```

- [ ] **Step 4: 改 `src/request-purpose.ts`**

在 `PURPOSE_USER_MESSAGES` 旁加：

```ts
/** 末尾 user 消息条数：suggestion 与上下文压缩的模板总是贴在本次输入的最后。 */
const PURPOSE_TAIL_MESSAGES = 2;
```

新增取数函数（与 `purposeUserBlockHeadsTx` 同形，DESC 取完再反转）：

```ts
/**
 * 末尾若干条 user 消息的文本块块首。旁路模板（suggestion、上下文压缩）
 * 写在本次输入的最后一条 user 消息里，只取前几条会全部漏检；条数与块首
 * 长度沿用同一组限额，成本不随正文体积增长。
 */
function purposeTailUserBlockHeadsTx(db: Database, reqId: number): string[] {
  const rows = db.query<{ z: Uint8Array }, [number, number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord DESC LIMIT ?`).all(reqId, PURPOSE_TAIL_MESSAGES);
  const heads: string[] = [];
  for (const row of rows.reverse()) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    for (const text of userTextBlocks(message)) {
      heads.push(text.trimStart().slice(0, PURPOSE_HEAD_CHARS));
    }
  }
  return heads;
}
```

两处 `PurposeView` 字面量都补字段：`request-purpose.ts:158` 的 `tailUserBlockHeads: []`，`:254` 的 `tailUserBlockHeads: purposeTailUserBlockHeadsTx(db, identity.reqId)`。

- [ ] **Step 5: 改 `src/harness/claude.ts`**

```ts
const SUGGESTION_MODE = '[SUGGESTION MODE:';
const COMPACTION = 'CRITICAL: Respond with TEXT ONLY';

/**
 * Claude Code 的 suggestion 生成请求。指纹写在最后一条 user 消息的块首，
 * 只看末尾块首；命中即认，不拿消息数或工具数当门槛。
 */
export function suggestionDecision(view: PurposeView): PurposeDecision | null {
  if (!view.tailUserBlockHeads.some(head => head.startsWith(SUGGESTION_MODE))) return null;
  return {
    status: 'recognized', version: PURPOSE_VERSION, rule: 'claude.suggestion-mode.v1',
    signals: ['suggestion.agent.claude', 'suggestion.tail-block-head'],
    chain: 'exclude', kind: 'suggestion_mode', modelTitle: null,
  };
}

/**
 * Claude Code 的上下文压缩请求（回复以 `<analysis>` 开头）。与 suggestion
 * 同样写在末尾块首；两族互斥，登记次序只保证分类器先判。
 */
export function compactionDecision(view: PurposeView): PurposeDecision | null {
  if (!view.tailUserBlockHeads.some(head => head.startsWith(COMPACTION))) return null;
  return {
    status: 'recognized', version: PURPOSE_VERSION, rule: 'claude.compaction.v1',
    signals: ['compaction.agent.claude', 'compaction.tail-block-head'],
    chain: 'exclude', kind: 'context_compaction', modelTitle: null,
  };
}
```

- [ ] **Step 6: 改 `src/harness/purpose.ts`**

```ts
import { classifierDecision, compactionDecision, suggestionDecision } from './claude';
```

```ts
export const PURPOSE_RULES: readonly HarnessPurposeRule[] = [
  { agent: 'claude', decide: classifierDecision },
  { agent: 'claude', decide: suggestionDecision },
  { agent: 'claude', decide: compactionDecision },
  { agent: 'hermes', decide: hermesDecision },
  { agent: 'omp', decide: skillHintDecision },
];
```

- [ ] **Step 7: 跑测试与类型检查**

Run: `bun test tests/semantics.test.ts tests/harness-purpose.test.ts tests/request-purpose.test.ts`
Run: `bun run typecheck`
Expected: PASS，无类型错误。

- [ ] **Step 8: 提交**

```text
fix(purpose): register claude suggestion and compaction bypasses

Both templates sit in the last user message, so the first-five block heads
never saw them. Read the tail block heads and register two exclusion rules
under the claude agent; bump PURPOSE_VERSION so a rebuild re-evaluates the
stored rows.

Agent-Note: .agents/notes/implemented/bug-fix/2026-10-28-claude-tail-bypasses.md
```

## 4. Task 3：让不确定闭包里的确定增量成为轮起点（P0-3A）

`isStart` 多一个条件。这一条不需要新的派生位，改完立刻对现有数据生效；正因为如此，它必须排在 P0-4 的重建之后上线。

**Files:**
- Modify: `src/queries/turns.ts:112-119`
- Test: `tests/turn-settlement.test.ts`

**Interfaces:**
- Consumes: `chain_role='unknown'` 与 `input_preview_kind='delta'`。
- Produces: 无新签名。

- [ ] **Step 1: 写失败的测试**

在 `tests/turn-settlement.test.ts` 追加：

```ts
test('轮次结算：不确定闭包里相对可读前驱的新增命令照常成起点', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('命令一')], reply: FINAL },
      { delta: [U('命令二')], reply: FINAL },
      { delta: [U('命令三')], reply: FINAL },
      { delta: [U('命令四')], reply: FINAL },
    ]);
    derive(f);
    // 回收 req1：req2 关系 unknown 且 delta 不可算（kind=tail），req3/req4 的前驱可读，
    // delta 成立但被不确定闭包标成 unknown。
    expect(evictOldestBodyBatch(f.store, 5000, 1).requests).toBe(1);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items.map(item => item.start_req)).toEqual([1, 3, 4]);
  } finally { f.close(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/turn-settlement.test.ts`
Expected: 实际为 `[1]`，新增用例失败。

- [ ] **Step 3: 改 `src/queries/turns.ts`**

```ts
    const isCommand = (row: TurnRow): boolean => row.input_preview_kind === 'delta';
    // 起点资格：已证明主链上的行，或链角色落 unknown 的行。unknown 覆盖两种
    // 情况：正文回收的起点（自身关系 unknown），以及不确定闭包里的后继
    // （confirmed）。后者的 delta 相对可读前驱成立，是用户命令的直接证据，
    // 不因归属不能证明就排除。branch 仍然不进带：它能被证明与主链不相接。
    const isStart = (row: TurnRow): boolean => row.chain_role === 'main'
      || row.chain_role === 'unknown';
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `bun test tests/turn-settlement.test.ts`
Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```text
fix(turns): let a proven delta inside the uncertain closure start a turn

A chain_role of unknown says the request's place in the chain cannot be
proven, not that it added no user text. When the predecessor is readable the
delta is proven, so keep the start qualification; branch stays excluded.

Agent-Note: .agents/notes/implemented/bug-fix/2026-10-28-turn-start-uncertain-closure.md
```

## 5. Task 4：补「末条消息是用户主动文本」派生位（P0-3B）

`0a950369` 的命令行落在 `tail`：前驱不可读，delta 算不出来。唯一可靠的证据是本笔输入以用户主动文本收尾。新增 `input_preview_kind='tail_command'`，不新增列、不改表结构，靠按会话重建回填。

**Files:**
- Modify: `src/derive/decision.ts:583-594,651-660,694-698`
- Modify: `src/derive/read.ts:155-160,270-280`
- Modify: `src/queries/turns.ts:112`
- Modify: `src/queries/projection.ts:41`
- Modify: `src/schema.sql:139-143`（只改注释）
- Test: `tests/turn-settlement.test.ts`
- Test: `tests/derive-presentation.test.ts`

**Interfaces:**
- Produces: `PresentationPorts.lastUserMessageIsCommand(reqId: number): boolean`。
- Produces: `input_preview_kind` 取值加 `tail_command`。

- [ ] **Step 1: 写失败的测试**

先在 Task 3 的用例上把期望改成 `[1, 2, 3, 4]`。既有用例「正文回收的起点照常进带」的期望从 `[1]` 改成 `[1, 2]`，注释里「后一轮消失」这句随新判据改写：req2 的末条消息是用户主动文本，仍照常成起点。

再加一条反例：

```ts
test('轮次结算：末尾是工具回传的 tail 不算命令', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('命令一')], reply: FINAL },
      { delta: [R('t1')], reply: FINAL },
    ]);
    derive(f);
    expect(evictOldestBodyBatch(f.store, 5000, 1).requests).toBe(1);
    derive(f);
    // req2 的末条消息是 tool_result：末轮输入不是用户主动文本，不进带。
    expect(listTurns(f.store, SEED_GROUP.convKey).items.map(item => item.start_req)).toEqual([1]);
  } finally { f.close(); }
});
```

`tests/derive-presentation.test.ts` 追加一条纯函数用例：`presentationDecision` 在 `delta === null`、`lastUserMessageIsCommand` 返回 true 时产出 `inputKind='tail_command'`，返回 false 时仍是 `tail`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/turn-settlement.test.ts tests/derive-presentation.test.ts`
Expected: 新增用例失败。

- [ ] **Step 3: 加派生端口**

`src/derive/decision.ts` 的 `PresentationPorts` 加：

```ts
  /** 本笔输入的最后一条用户消息是主动文本（含 wrapped 与 midturn，不含注入与工具结果）。 */
  lastUserMessageIsCommand(reqId: number): boolean;
```

`presentationDecision` 的 `tail` 分支：

```ts
    } else {
      // 关系未知、另起一支或排除用途：没有"新增"可言，但折叠行仍要有东西可读。
      // 末条消息是用户主动文本时，这一笔还带「用户刚发过话」的结构证据，轮次
      // 起点用它把 tail 与「只是回传工具结果」分开。
      inputPreview = ports.tailUserPreview(facts.reqId);
      inputKind = inputPreview === null ? null
        : ports.lastUserMessageIsCommand(facts.reqId) ? 'tail_command' : 'tail';
    }
```

`inputKind` 的三处类型都加 `'tail_command'`：`PresentationDecision.inputKind`（`decision.ts:626`）、函数内的局部变量（`:643`）、retained 白名单（`:658-660`）。

```ts
  let inputKind: 'delta' | 'tail' | 'tail_command' | 'tool_result' | 'title' | null = null;
```

```ts
    inputKind = retained !== null && (retained.inputPreviewKind === 'delta'
      || retained.inputPreviewKind === 'tail' || retained.inputPreviewKind === 'tail_command'
      || retained.inputPreviewKind === 'tool_result'
      || retained.inputPreviewKind === 'title') ? retained.inputPreviewKind : null;
```

- [ ] **Step 4: 实现取数**

`src/derive/read.ts` 新增：

```ts
/**
 * 本笔输入是否以用户主动文本收尾。
 *
 * 从末尾往前跳过 system 消息与注入型 user 消息（归档、技能注入、系统提醒
 * 都是壳），遇到工具结果或 assistant 消息即停。判据与 `interpretMessage`
 * 同一套：只有 state='text' 算用户主动文本。最多看 5 条，与 tailUserPreview
 * 的取数窗口一致。
 */
export function lastUserMessageIsCommand(db: Database, reqId: number,
  cache?: BodyReadCache): boolean {
  const meta = db.query<{ agent: string | null }, [number]>(
    'SELECT agent FROM request WHERE req_id=?').get(reqId);
  const rows = db.query<{ ord: number } & BlockMessageRow, [number]>(`
    SELECT rb.ord AS ord, b.id AS id, hex(b.hash) AS hash, b.z AS z, b.raw_size AS raw_size
    FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? ORDER BY rb.ord DESC LIMIT 6`).all(reqId);
  for (const row of rows) {
    const message = messageOfBlock(row, cache);
    if (message === undefined) continue;
    const view = interpretMessage(message, meta?.agent ?? null, row.ord);
    if (view.role === 'system') continue;
    if (view.role !== 'user' || view.input === null) return false;
    if (view.input.state === 'injected') continue;
    return view.input.state === 'text';
  }
  return false;
}
```

`presentationPortsOf` 加一行：

```ts
    lastUserMessageIsCommand: reqId => lastUserMessageIsCommand(db, reqId, cache),
```

- [ ] **Step 5: 轮次判据认新值**

`src/queries/turns.ts`：

```ts
    const isCommand = (row: TurnRow): boolean =>
      row.input_preview_kind === 'delta' || row.input_preview_kind === 'tail_command';
```

`src/queries/projection.ts:41` 的联合类型加 `'tail_command'`。`src/schema.sql` 的注释补一句：

```sql
  -- kind 说明摘要是什么：delta（本轮新增）/ tail（末轮输入，非新增）/
  -- tail_command（末尾是用户主动文本，关系无法证明新增）/
  -- tool_result（本轮没有用户消息，输入是工具结果）/ title（标题生成请求）。
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `bun test tests/turn-settlement.test.ts tests/derive-presentation.test.ts tests/derive-unit.test.ts`
Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```text
feat(turns): record whether the input ends with a user command

When the predecessor body is unreadable the delta cannot be computed, so a
real command line degraded to tail and left the turn band. Record the end
shape at derivation time and let the turn reader accept tail_command; a
trailing tool result stays excluded.

Agent-Note: .agents/notes/implemented/architecture/2026-10-28-tail-command-shape.md
```

## 6. Task 5：生产重建与换版（需要授权）

这是本计划唯一的生产写操作。执行前先向用户确认停服务窗口，再把下面的命令逐条跑完；任何一步失败就停下，用备份回滚，不继续。

**前置：**

```sh
cd /Users/pis/workspace_intelligence/creator-intelligence/repos/agent-trace-collector
bun run service status
```

- [ ] **Step 1: 停服务**

```sh
bun run service stop
```

- [ ] **Step 2: 备份数据库**

```sh
bun run maintain backup --db "$HOME/Library/Application Support/agent-trace-collector/trace.db" \
  --out "$HOME/atc-backup-2026-10-28.db"
```

目标必须不存在。确认输出 `integrity: ok` 与 0600 权限。

- [ ] **Step 3: 生成重建清单**

只需要重建两类会话：`tail_command` 可能翻成轮起点的（参与链、`prev_relation='unknown'`、`input_preview_kind='tail'`），以及含 suggestion/压缩指纹、用途需要换代的。两类合起来实测 57 个会话；不含正文、只输出 `conv_key`。把下面脚本写到 `/tmp/atc-rebuild-keys.mjs` 再跑：

```js
import { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
const db = new Database(process.env.HOME + '/Library/Application Support/agent-trace-collector/trace.db', { readonly: true });
const all = (sql, ...p) => db.query(sql).all(...p);

const keys = new Set();
// 1) tail_command 可能翻成命令行的会话：参与链、前驱未知、当前 kind=tail。
for (const row of all(`SELECT DISTINCT conv_key FROM request
  WHERE conv_key IS NOT NULL AND purpose_chain='participate'
    AND prev_relation='unknown' AND input_preview_kind='tail'`)) keys.add(row.conv_key);
// 2) 含 suggestion / 压缩指纹的会话：用途换代后这些行应转 exclude。
const FP = ['[SUGGESTION MODE:', 'CRITICAL: Respond with TEXT ONLY'];
function lastUserHead(reqId, msgCount) {
  const blk = all(`SELECT b.z AS z FROM request_block rb JOIN block b ON b.id=rb.block
    WHERE rb.req_id=? AND rb.ord=?`, reqId, msgCount - 1)[0];
  if (!blk) return null;
  try {
    const m = JSON.parse(zstdDecompressSync(blk.z).toString('utf8'));
    if (m?.role !== 'user') return null;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return null;
    for (const b of c) {
      if (typeof b === 'string') return b;
      if (b && typeof b.text === 'string') return b.text;
    }
    return null;
  } catch { return null; }
}
for (const row of all(`SELECT req_id, conv_key, msg_count FROM request
  WHERE conv_key IS NOT NULL AND agent='claude'
    AND body_state IN ('available','partial') AND msg_count > 0`)) {
  const head = lastUserHead(row.req_id, row.msg_count);
  if (head === null) continue;
  if (FP.some(f => head.trimStart().startsWith(f))) keys.add(row.conv_key);
}
for (const key of [...keys].sort()) console.log(key);
db.close();
```

```sh
bun /tmp/atc-rebuild-keys.mjs > /tmp/atc-rebuild-keys.txt
wc -l /tmp/atc-rebuild-keys.txt
```

规划期实测为 57 行。执行当天数量会随采集增长，以实际输出为准，并如实写进验收记录。

- [ ] **Step 4: 先试跑一个会话并计时**

```sh
time bun run maintain rebuild --db "$HOME/Library/Application Support/agent-trace-collector/trace.db" \
  --session '<从清单挑一个中小会话>'
```

确认输出 `queue_remaining: 0` 与 `purpose_remaining: 0`，记下耗时。

- [ ] **Step 5: 批量重建**

```sh
while IFS= read -r key; do
  [ -z "$key" ] && continue
  bun run maintain rebuild --db "$HOME/Library/Application Support/agent-trace-collector/trace.db" \
    --session "$key" || { echo "FAILED: $key"; break; }
done < /tmp/atc-rebuild-keys.txt
```

- [ ] **Step 6: 起服务**

```sh
bun run service start
```

- [ ] **Step 7: 真实流量验收**

只读核验，结果写进 `docs/acceptance.md`，与合成验收分开：

```sh
curl -s -H 'Sec-Fetch-Site: same-origin' 'http://127.0.0.1:8320/api/sessions/0a950369.../turns?from=0' | head -c 400
curl -s -H 'Sec-Fetch-Site: same-origin' 'http://127.0.0.1:8320/api/sessions/95be5905.../turns?from=0' | head -c 400
```

判据：

- 两个会话的轮次数从 0 变为正数；同屏轮号连续。
- 指纹行不再出现在轮次带：重建后 `purpose_chain='participate'` 的 suggestion/压缩行数为 0。
- 抽查至少 5 轮，起点命令文本是用户原话，不含 `[SUGGESTION MODE`、`CRITICAL: Respond with TEXT ONLY`。
- 正文未到（pending）的请求，读数页显示「回复还没到」，中栏不再出现「未收到回复」。

- [ ] **Step 8: 回滚路径**

如果验收失败：`bun run service stop`，把备份库换回 `trace.db`（同目录、0600，保留 `redaction.salt`），`bun run service start`，再用旧代码核对。回滚后把失败样本与原因记进 note，不重复执行同一批重建。

## 7. Task 6：会话列表去重与防重入（P1-2）

**Files:**
- Modify: `web/reader-store.js:221-232`
- Test: `tests/reader-store.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `tests/reader-store.test.ts` 用现有 fetch 桩让两页返回同一个 `conv_key`，断言 `store.getSessions().items` 只有一条；再让 `loadSessions` 在第一次未完成时被调用两次，断言只发一次请求。

- [ ] **Step 2: 实现**

```js
  /** @type {boolean} */
  let sessionsLoading = false;

  /** @param {string | undefined} cursor */
  async function loadSessions(cursor) {
    if (sessionsLoading) return;
    sessionsLoading = true;
    try {
      const page = await getJson(`/api/sessions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      // 同 tick 的两次点击已经由上面的闸门挡住；分页边界仍可能把同一会话
      // 返回两次（末条时间相同），按 conv_key 去重，保留先出现的一条。
      /** @type {Map<string, import('../src/queries/sessions').SessionRow>} */
      const seen = new Map();
      for (const item of [...(cursor ? sessions.items : []), ...page.items]) {
        if (!seen.has(item.conv_key)) seen.set(item.conv_key, item);
      }
      sessions.items = [...seen.values()];
      sessions.cursor = page.next_cursor;
      sessions.error = null;
    } catch (error) {
      sessions.error = error instanceof Error ? error.message : 'load_failed';
    } finally {
      sessionsLoading = false;
    }
  }
```

- [ ] **Step 3: 跑测试**

Run: `bun test tests/reader-store.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```text
fix(web): dedupe sessions and guard concurrent loads

Two clicks in the same tick fetched the same cursor twice and concatenated
the page into visible duplicates. Add a load guard and dedupe by conv_key.

Agent-Note: none — front-end list guard and dedupe, covered by reader-store tests.
```

## 8. Task 7：正文分片按钮补禁用与重试（P1-3）

**Files:**
- Modify: `web/app.js:1041`
- Test: `tests/web.test.ts`

- [ ] **Step 1: 改按钮**

把 `app.js:1041` 的 `unread` 分支替换为：

```js
      ${unread ? `<div style="margin-top:8px"><button class="chip-btn" data-structure-more="${r.req_id}"${structure.loading ? ' disabled' : ''}>${structure.error ? '重试读取' : `加载下一片（已读 ${structure.next} / ${knownTotal}）`}</button></div>
        ${structure.error ? `<p class="note warn">结构读取失败：${esc(structure.error)}</p>` : ''}` : ''}`;
```

- [ ] **Step 2: 加断言**

在 `tests/web.test.ts` 里对 `structure: { next: 0, total: 44, loading: true, error: null, ords: [] }` 的正文页断言按钮带 `disabled`；`loading: false, error: 'body_page_gap'` 时断言出现「重试读取」。

- [ ] **Step 3: 跑测试与提交**

Run: `bun test tests/web.test.ts`

```text
fix(web): show loading and retry states on the body page slice button

Agent-Note: none — copies the rail-facts button states into the body tab.
```

## 9. Task 8：非法 trace 参数不再漏 NaN（P1-5、B19）

**Files:**
- Modify: `web/url-route.js`
- Modify: `web/app.js:88`
- Test: `tests/url-route.test.ts`（新建）

- [ ] **Step 1: 写失败的测试**

```ts
import { expect, test } from 'bun:test';
import { traceIdFromParam } from '../web/url-route.js';

test('trace 参数只接受十进制正整数', () => {
  expect(traceIdFromParam('12')).toBe(12);
  expect(traceIdFromParam('0')).toBeNull();
  expect(traceIdFromParam('-3')).toBeNull();
  expect(traceIdFromParam('1.5')).toBeNull();
  expect(traceIdFromParam('abc')).toBeNull();
  expect(traceIdFromParam('')).toBeNull();
  expect(traceIdFromParam(null)).toBeNull();
  expect(traceIdFromParam('999999999999999999999')).toBeNull();
});
```

- [ ] **Step 2: 实现**

`web/url-route.js` 加：

```js
/**
 * URL 的 trace 参数解析成请求号：只接受十进制正整数。非法值按未指定处理，
 * 不产生 NaN，也不进入「未找到」分支——那不是一条可以核对的请求号。
 * @param {string | null} value
 * @returns {number | null}
 */
export function traceIdFromParam(value) {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
```

`web/app.js:88` 改成：

```js
    reqId: traceIdFromParam(qp.get('trace')),
```

导入处补 `traceIdFromParam`。

- [ ] **Step 3: 跑测试与提交**

Run: `bun test tests/url-route.test.ts tests/selection.test.ts`

```text
fix(web): reject non-numeric trace parameters instead of showing NaN

Agent-Note: none — a pure URL parser with a unit test.
```

## 10. Task 9：会话头 tok/s 的分母与分子同口径（P1-6）

**Files:**
- Modify: `web/session-view.js:52-67`
- Test: `tests/web.test.ts`

- [ ] **Step 1: 实现**

```js
function timingSummary(rows) {
  const ttfts = rows.map(r => r.ttft_ms).filter(v => v !== null).sort((a, b) => a - b);
  const durations = rows.map(r => r.ms).filter(v => v !== null);
  const median = ttfts.length === 0 ? null : ttfts[Math.floor(ttfts.length / 2)] ?? null;
  const average = durations.length === 0 ? null : durations.reduce((a, v) => a + v, 0) / durations.length;
  // 速度只统计计时与输出都在的行：分母漏一行、分子照加，会把 OTLP 行放大成
  // 8000 tok/s。没有计时行时不给速度。
  const timed = rows.filter(r => r.out_tok !== null
    && (r.flow_ms !== null || (r.ms !== null && r.ttft_ms !== null)));
  const genMs = timed.reduce((a, r) => {
    if (r.flow_ms !== null) return a + r.flow_ms;
    return a + Math.max(0, (r.ms ?? 0) - (r.ttft_ms ?? 0));
  }, 0);
  const outTok = timed.reduce((a, r) => a + (r.out_tok ?? 0), 0);
  return {
    median, average,
    speed: genMs > 0 && outTok > 0 ? Math.round(outTok / (genMs / 1000)) : null,
  };
}
```

- [ ] **Step 2: 加断言**

在 `tests/web.test.ts` 用 `sessionHeadView` 构造一行有 `out_tok=4`、`ms/ttft_ms/flow_ms` 全为 null 的请求，断言输出不含「tok/s」；再加一行有计时与输出的请求，断言速度等于该行自己的比值。

- [ ] **Step 3: 跑测试与提交**

Run: `bun test tests/web.test.ts`

```text
fix(web): count only timed rows in the session output speed

Agent-Note: none — one denominator fix with a unit test.
```

## 11. Task 10：上下文明细的顶层字段不再拼 NaN 区间（B15）

**Files:**
- Modify: `web/context-detail.js:259-261`
- Test: `tests/context-detail.test.ts`

- [ ] **Step 1: 实现**

```js
    // 顶层字段条目没有消息序号，走正文根读取；拼 from=null&to=NaN 会被服务端 400。
    const url = isResult
      ? `/api/requests/${entry.owner_req}/tools/${entry.call_ord}/result?if_reading=${encodeURIComponent(s.s.token)}`
      : entry.ord === null
        ? `/api/requests/${s.s.reqId}/body?if_reading=${encodeURIComponent(s.s.token)}`
        : `/api/requests/${s.s.reqId}/body?from=${entry.ord}&to=${Number(entry.ord) + 1}&if_reading=${encodeURIComponent(s.s.token)}`;
```

- [ ] **Step 2: 加断言**

`tests/context-detail.test.ts` 增加：`entry.ord === null` 且 `call_ord === null` 时，请求 URL 不含 `from=` 与 `NaN`。

- [ ] **Step 3: 跑测试与提交**

Run: `bun test tests/context-detail.test.ts`

```text
fix(web): read top-level context fields without a message range

Agent-Note: none — URL construction fix with a unit test.
```

## 12. Task 11：汇总状态、不可恢复的重试与跳转反馈（P2-3、P2-4、P2-10）

三项都是小修，合一个提交。

**Files:**
- Modify: `web/app.js:522-528,1469,1548-1555`
- Modify: `web/session-view.js:198-233`
- Modify: `web/trace-pair.js:153-157`
- Test: `tests/web.test.ts`
- Test: `tests/trace-pair.test.ts`

- [ ] **Step 1: 汇总状态区分加载与不可用（P2-3）**

`sessionHeadView` 的入参加 `summaryStatus: 'idle' | 'loading' | 'ready' | 'absent'`。`app.js:527` 传 `summary?.status ?? 'idle'`。`session-view.js` 的合计行改成：

```js
      ${summary !== null ? sessionTotalsHtml(summary)
      : summaryStatus === 'loading'
        ? '<span class="sum muted">汇总快照读取中…</span>'
        : hasUsage
          ? `<span class="sum" title="汇总快照不可用；这是已加载窗口的相加，不是会话口径">已加载相加：${kk(totalIn)} 提示 · ${kk(totalOut)} 输出 · $${totalCost.toFixed(4)}${priced.length < rows.length ? ` · ${rows.length - priced.length} 笔未取得费用` : ''}</span>`
          : '<span class="sum muted">这批记录没有报告的用量，合计为空</span>'}
```

`idle` 与 `absent` 都落已加载相加，但悬停文案说清「不可用」，不再说「读取中」。

- [ ] **Step 2: 不可恢复的工具结果不给重试（P2-4）**

`trace-pair.js` 的 `else` 分支：

```js
  } else {
    // body_evicted 与 message_missing 是终态：重试不会让正文回来，只给说明。
    const retryable = reading.reason !== 'body_evicted' && reading.reason !== 'message_missing';
    resultBody = `<p class="note warn">结果正文不可读（${esc(reading.reason ?? '')}）。</p>
      ${retryable ? `<div class="conv-tools">
        <button class="chip-btn" data-tool-retry="${input.owner}" data-call-ord="${input.call.ord}">重试读取</button>
      </div>` : ''}`;
  }
```

- [ ] **Step 3: 窗口跳转给中间态（P2-10）**

`app.js` 的点击分支：

```js
    if (t.closest('#jump-opposite')) {
      const button = /** @type {HTMLButtonElement} */ (t.closest('#jump-opposite'));
      if (state.windowJumping) return;
      state.windowJumping = true;
      button.disabled = true;
      button.textContent = '正在重建窗口…';
      void (state.windowAnchor === 'latest' ? jumpStart() : jumpLatest())
        .finally(() => { state.windowJumping = false; renderAll(); });
      return;
    }
```

`state` 里加 `windowJumping: false`。

- [ ] **Step 4: 跑测试与提交**

Run: `bun test tests/web.test.ts tests/trace-pair.test.ts`
Run: `bun run typecheck`

```text
fix(web): distinguish summary states and permanent read failures

The session head called every non-ready summary "loading", the pair page
offered retry for evicted bodies, and the window jump button looked inert
for seconds. Give each state its own copy and a busy label.

Agent-Note: none — three independent copy and state fixes with tests.
```

## 13. Task 12：轮次身份行的文档口径（P2-1）

只改文档。`web/turn-band.js:49-56` 只渲染「轮 N」是 2026-10-25 的决策，代码不动。

**Files:**
- Modify: `docs/architecture-design.md:924`
- Test: 无（运行 `bun run verify:notes`）

- [ ] **Step 1: 改一句话**

把「身份行只标「轮 N · 命令 req X · 回复 req Y」，页签行隐藏」改成：

```text
身份行只标「轮 N」，页签行隐藏；两端请求号从阅读路径移除，定位靠轮次带与点轨迹行。
```

- [ ] **Step 2: 提交**

```text
docs: align the turn identity line with the shipped design

Agent-Note: none — the code already implements the 2026-10-25 decision; the design doc was stale.
```

## 14. 重测项（不写代码）

这两项在规划期无法靠源码判定，必须在当前 master 的页面上重测；复现了再单独立项。

- **P1-1 加载位置**：当前 `loadLater()` 只在尾部追加，`reader-store.js:110` 的「加载更早」注释已经过期。用 60 笔窗口打开一个长会话，滚到中部点「↓ 加载后续记录」，记录视口首步的 key 与 top；追加不应移动视口。若稳定，关闭该项并把过期注释删掉（`Agent-Note: none`）。
- **P2-7 非法 tab 不回写**：`renderAll()` 每次都调 `updateURL()`，`railTabParam('bogus')` 返回 null，URL 应被重写成不带 `tab`。打开 `?tab=bogus&trace=<存在的请求>`，确认地址栏被清理；若复现，在 `resolveInitialTrace` 完成后补一次 `updateURL()`。

## 15. 需要拍板的产品口径

以下四项不是纯 bug，改法会影响现有信息量或接口契约。本计划不预设实现，拍板后各自单独立项。

| 项 | 现状 | 选项 | 建议 |
| --- | --- | --- | --- |
| P2-2 会话「缺正文」标记 | 任一行缺正文即整会话标记；实测缺笔比例 2%–21% | A 保持；B 只在全部缺或首笔缺时标记；C 标成「部分缺」并带比例 | C：后端在 `SESSION_FLAG_COLUMNS` 增加 `missing_count`，前端按比例显示「缺正文 N/M」，标记恢复信息量 |
| P2-5 路由候选顺序 | 300+ 字符 JSON 直出 | A 保持；B 按 provider / status 渲染成行；C 折叠成一行摘要，展开看原文 | B：字段已白名单，渲染形态不涉及敏感信息 |
| P2-8 `offset` 静默忽略 | 接口只承诺 `limit` + `cursor` | A 保持并写进接口说明；B 对 `offset` 返回 400 `offset_not_supported`；C 支持 offset | B：静默忽略会让调用方以为翻页成功；400 是明确拒绝，不算破坏契约 |
| P2-9 窄屏首屏被会话列表占满 | ≤1000px 三栏堆叠，会话栏 1193px 高 | A 保持；B 窄屏默认折叠会话栏为一行摘要；C 窄屏把会话列表放到轨迹之后 | B：只改首屏排布，不删功能；需要一张 900px 的视觉稿再动手 |

## 16. 自检

- 报告 P0 四项都有任务承接：P0-1/P0-2/P2-6 → Task 1，P0-3 → Task 3 + Task 4，P0-4 → Task 2。
- 报告 P1 六项：P1-2 → Task 6，P1-3 → Task 7，P1-5 → Task 8，P1-6 → Task 9，P1-1 → §14 重测，P1-4 → §0 误报。
- 报告 P2 十项：P2-1 → Task 12，P2-3/P2-4/P2-10 → Task 11，P2-6 → Task 1，P2-7 → §14 重测，P2-2/P2-5/P2-8/P2-9 → §15 待拍板。
- 交接文档的 B15 → Task 10；B19 → Task 8。
- 每个代码任务都写了最窄测试命令与提交信息；生产写操作集中在 Task 5，带备份与回滚路径。

## 17. 验收口径

合成验收与真实流量验收分开记录，写进 `docs/acceptance.md`。

- 合成验收：Task 1–4、6–12 的单测与 `bun run typecheck` 全过；`bun run verify:notes` 通过。
- 真实流量验收：Task 5 Step 7 的四条判据；两个大会话的轮次数、指纹行清零、至少 5 轮人工抽查。
- 前端真机验收：用 ego-browser 打开生产页，抽查 `0a950369` 的 pending 行、轮次带、`?trace=abc`、正文页分片按钮的禁用态与重试态。
- 不接受的口径：把「重建未跑」写成「已修复」；把合成数据的轮次结果当成生产轮次数；把重启后没验证的项标为通过。
