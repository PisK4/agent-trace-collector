import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { readBodyWithMessagesTx } from '../src/body';
import { workbuddyAdapter } from '../src/sources/session/adapters/workbuddy';
import { ingestSessionBatch } from '../src/sources/session/ingest';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const json = (value: unknown): string => JSON.stringify(value);

/** 合成项目根：<root>/projects/<SESSION_ID>.jsonl 与子目录里的子代理文件。 */
function makeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'atc-workbuddy-')), 'projects');
}

function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true });
}

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `gen-${Math.random().toString(36).slice(2)}`,
    timestamp: T0, type: 'message', sessionId: SESSION_ID,
    cwd: '/work/synthetic', ...extra,
  };
}

/** providerData 是 WorkBuddy 放 messageId、model 与逐笔用量的地方。 */
function provider(messageId: string | null, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    messageId: messageId ?? undefined,
    model: 'hy4-synthetic', requestModelId: 'hy4-synthetic',
    ...(usage === undefined ? {} : { usage }),
  };
}

const USAGE = {
  requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
  inputTokensDetails: [{ cached_tokens: 30 }],
  outputTokensDetails: [{ reasoning_tokens: 5 }],
};

function user(atMs: number, text: string): string {
  return json(base({
    timestamp: atMs, role: 'user',
    content: [{ type: 'input_text', text }],
    providerData: provider(null),
  }));
}

function assistant(atMs: number, messageId: string, text: string, usage?: Record<string, unknown>): string {
  return json(base({
    timestamp: atMs, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
    providerData: provider(messageId, usage),
  }));
}

function reasoning(atMs: number, messageId: string, text: string): string {
  return json(base({
    timestamp: atMs, type: 'reasoning',
    content: [{ type: 'reasoning_text', text }],
    providerData: provider(messageId),
  }));
}

function functionCall(atMs: number, messageId: string, name: string, usage?: Record<string, unknown>): string {
  return json(base({
    timestamp: atMs, type: 'function_call', callId: `call-${messageId}`,
    name, arguments: { q: 'synthetic' }, parentId: 'gen-parent',
    providerData: provider(messageId, usage),
  }));
}

function functionResult(atMs: number, messageId: string, name: string): string {
  return json(base({
    timestamp: atMs, type: 'function_call_result', callId: `call-${messageId}`,
    name, output: 'synthetic output', status: 'completed', parentId: 'gen-parent',
    providerData: provider(messageId),
  }));
}

function snapshot(atMs: number): string {
  return json(base({
    timestamp: atMs, type: 'file-history-snapshot', snapshot: { files: ['x'.repeat(200)] },
  }));
}

function writeFile(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function writeMain(root: string, lines: string[]): string {
  ensureRoot(root);
  const path = join(root, `${SESSION_ID}.jsonl`);
  writeFile(path, lines);
  return path;
}

/** 子代理文件：父会话目录是 <root>/<parent-id>/，会话 id 写在行的 sessionId。 */
function writeSubagent(root: string, file: string, subagentId: string, lines: string[]): string {
  const dir = join(root, SESSION_ID, 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFile(path, lines.map(line => line.replaceAll(SESSION_ID, subagentId)));
  return path;
}

function subLine(kind: 'user' | 'assistant' | 'call', messageId: string,
  usage?: Record<string, unknown>): string {
  if (kind === 'user') return user(T0, 'subagent prompt');
  if (kind === 'assistant') return assistant(T0 + 1_000, messageId, 'subagent reply', usage);
  return functionCall(T0 + 1_000, messageId, 'synthetic_tool', usage);
}

test('WorkBuddy 首次摄入：按 messageId 归约一笔调用，用量扣缓存、正文与证据齐全', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeMain(root, [
      user(T0, 'first prompt'),
      reasoning(T0 + 1_000, 'gen-reply-1', 'plan'),
      functionCall(T0 + 2_000, 'gen-reply-1', 'synthetic_tool', USAGE),
      functionResult(T0 + 3_000, 'gen-reply-1', 'synthetic_tool'),
      assistant(T0 + 4_000, 'gen-reply-1', 'first reply'),
      // 快照行带大块元数据，既不进状态也不落原始层。
      snapshot(T0 + 5_000),
    ]);

    const result = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ files: 1, calls: 1, merged: 0, duplicates: 0, invalid: 0, blocked: 0 });

    const row = f.store.read.query(`
      SELECT session, conv_key, agent, via, actor, subagent, parent_agent, started_ms,
        model_requested, in_tok, out_tok, cache_read, cache_write, have, body_state,
        sort_source, source_facts_json
      FROM request`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      session: SESSION_ID, conv_key: json(['session', SESSION_ID]), agent: 'workbuddy',
      via: 'session', actor: SESSION_ID, subagent: null, parent_agent: null,
      started_ms: T0 + 1_000, model_requested: 'hy4-synthetic',
      in_tok: 70, out_tok: 20, cache_read: 30, cache_write: 0,
      have: 16, body_state: 'available', sort_source: 'workbuddy_session',
    });
    const facts = JSON.parse(row.source_facts_json as string) as {
      session: { usageScope: string; reasoningEffort: string | null; cwd: string | null };
    };
    expect(facts.session).toEqual({ usageScope: 'session', reasoningEffort: null, cwd: '/work/synthetic' });

    const body = readBodyWithMessagesTx(f.store.read, 1)!;
    expect(body.body.protocol).toBe('chat');
    expect(body.body.request).toEqual({
      messages: [{ role: 'user', content: [{ type: 'input_text', text: 'first prompt' }] }],
    });
    expect(body.body.reply).toEqual({
      choices: [{ message: { role: 'assistant', content: [
        { type: 'reasoning_text', text: 'plan' },
        { type: 'tool_use', id: 'call-gen-reply-1', name: 'synthetic_tool', input: { q: 'synthetic' } },
        { type: 'tool_result', tool_use_id: 'call-gen-reply-1', content: 'synthetic output', status: 'completed' },
        { type: 'output_text', text: 'first reply' },
      ] } }],
    });

    expect(f.store.read.query(
      'SELECT source_kind, ref_key, match_rule FROM request_evidence').all(),
    ).toEqual([{
      source_kind: 'workbuddy_session_call',
      ref_key: `${SESSION_ID}/gen-reply-1`,
      match_rule: 'match_absent',
    }]);
    // 快照行被忽略，其余五行进原始层。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_session_event').get()).toEqual({ n: 5 });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='workbuddy_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBe(cursor.seen_size);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM ingest_issue').get()).toEqual({ n: 0 });
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('WorkBuddy 追加读取：新回复补建一行，跨批次补齐同 reply 的行刷新正文', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeMain(root, [
      user(T0, 'first prompt'),
      reasoning(T0 + 1_000, 'gen-append-1', 'plan'),
      assistant(T0 + 2_000, 'gen-append-1', 'first reply', USAGE),
    ]);
    const first = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(first).toMatchObject({ calls: 1, duplicates: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });

    // 同一 reply 的 function_call 分批到达：重放后以同一 ref 补发，正文刷新。
    appendFileSync(path, `${functionCall(T0 + 3_000, 'gen-append-1', 'synthetic_tool')}\n`);
    const grown = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(grown).toMatchObject({ calls: 0, duplicates: 1, refreshed: 1 });
    const body = readBodyWithMessagesTx(f.store.read, 1)!;
    const reply = (body.body.reply as { choices: { message: { content: unknown[] } }[] })
      .choices[0]!.message.content;
    expect(reply).toContainEqual({
      type: 'tool_use', id: 'call-gen-append-1', name: 'synthetic_tool', input: { q: 'synthetic' },
    });

    // 下一个 messageId 开一笔新调用。
    appendFileSync(path, `${[
      user(T0 + 4_000, 'second prompt'),
      assistant(T0 + 5_000, 'gen-append-2', 'second reply', USAGE),
    ].join('\n')}\n`);
    const third = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(third).toMatchObject({ calls: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 2 });
    // 重放恢复了首笔回复，第二笔的请求窗口带着前一轮的上下文。
    // 同 reply 的 function_call 下一批才到，刷新时按重放顺序追加在末尾。
    const secondBody = readBodyWithMessagesTx(f.store.read, 2)!;
    expect(secondBody.messages).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'first prompt' }] },
      { role: 'assistant', content: expect.arrayContaining([
        { type: 'reasoning_text', text: 'plan' },
        { type: 'tool_use', id: 'call-gen-append-1', name: 'synthetic_tool', input: { q: 'synthetic' } },
        { type: 'output_text', text: 'first reply' },
      ]) },
      { role: 'user', content: [{ type: 'input_text', text: 'second prompt' }] },
    ]);
    const refs = f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY req_id').all();
    expect(refs).toEqual([
      { ref_key: `${SESSION_ID}/gen-append-1` },
      { ref_key: `${SESSION_ID}/gen-append-2` },
    ]);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('WorkBuddy 坏行停游标：坏行前的调用已落库，坏行被记为 issue', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    const path = writeMain(root, [
      user(T0, 'first prompt'),
      assistant(T0 + 1_000, 'gen-bad-1', 'first reply', USAGE),
      '{"type":"message", broken',
      user(T0 + 2_000, 'later prompt'),
      assistant(T0 + 3_000, 'gen-bad-2', 'later reply', USAGE),
    ]);
    const result = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ calls: 1, invalid: 1, blocked: 1 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 1 });
    expect(f.store.read.query(
      "SELECT reason FROM ingest_issue WHERE source_kind='workbuddy_session'").get())
      .toEqual({ reason: 'workbuddy_invalid_json' });
    const cursor = f.store.read.query(
      "SELECT committed_off, seen_size FROM source_cursor WHERE source_kind='workbuddy_session'").get() as {
      committed_off: number; seen_size: number;
    };
    expect(cursor.committed_off).toBeLessThan(cursor.seen_size);
    expect(statSync(path).size).toBe(cursor.seen_size);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('WorkBuddy 子代理折叠：session 归父、subagent 归己，证据带子代理身份', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    writeMain(root, [
      user(T0, 'parent prompt'),
      assistant(T0 + 1_000, 'gen-parent-1', 'parent reply', USAGE),
    ]);
    writeSubagent(root, 'agent-a.jsonl', 'subagent-a', [
      subLine('user', 'unused'),
      subLine('call', 'gen-child-1', USAGE),
      subLine('assistant', 'gen-child-1'),
    ]);

    const result = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ files: 2, calls: 2, duplicates: 0 });
    const rows = f.store.read.query(
      'SELECT session, actor, subagent, parent_agent FROM request ORDER BY subagent').all();
    expect(rows).toEqual([
      { session: SESSION_ID, actor: SESSION_ID, subagent: null, parent_agent: null },
      { session: SESSION_ID, actor: 'subagent-a', subagent: 'subagent-a', parent_agent: SESSION_ID },
    ]);
    const evidence = f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY ref_key').all();
    expect(evidence).toEqual([
      { ref_key: `${SESSION_ID}/gen-parent-1` },
      { ref_key: `${SESSION_ID}/subagent-a/gen-child-1` },
    ]);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('WorkBuddy 两个子代理同序号各建一行，ref_key 唯一', async () => {
  const root = makeRoot();
  const f = fixture();
  try {
    // 两个子代理文件里用完全相同的 messageId（模拟各自文件内同序号）。
    for (const file of ['agent-a.jsonl', 'agent-b.jsonl']) {
      const subId = file === 'agent-a.jsonl' ? 'subagent-a' : 'subagent-b';
      writeSubagent(root, file, subId, [
        subLine('user', 'unused'),
        subLine('assistant', 'gen-same-1', USAGE),
      ]);
    }

    const result = await ingestSessionBatch(f.store, workbuddyAdapter, [root], SALT, T0);
    expect(result).toMatchObject({ calls: 2, duplicates: 0 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 2 });
    const evidence = f.store.read.query(
      'SELECT ref_key FROM request_evidence ORDER BY ref_key').all();
    expect(evidence).toEqual([
      { ref_key: `${SESSION_ID}/subagent-a/gen-same-1` },
      { ref_key: `${SESSION_ID}/subagent-b/gen-same-1` },
    ]);
    const distinct = f.store.read.query(
      'SELECT COUNT(DISTINCT ref_key) AS n FROM request_evidence').get() as { n: number };
    expect(distinct.n).toBe(2);
    const issues = f.store.read.query('SELECT COUNT(*) AS n FROM ingest_issue').get() as { n: number };
    expect(issues.n).toBe(0);
  } finally {
    f.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});
