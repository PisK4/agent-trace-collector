import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { ingestDroidBatch } from '../src/sources/droid/ingest';

/**
 * 合成验收：主会话、fork 与子代理放在同一根目录，断言 assistant 消息数与
 * request 行数守恒（fork 复制段不建行），并核对子代理归属与会话累计只记主会话。
 */

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const SALT = new Uint8Array(32);
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

type Turn = { user: string; assistant: string; at: number };

function turns(count: number, session: string, start: number): { lines: string[]; turnCount: number } {
  const lines: string[] = [];
  let at = start;
  for (let index = 1; index <= count; index++) {
    lines.push(json({
      type: 'message', id: `${session}-u${index}`, timestamp: iso(at),
      message: { role: 'user', content: [{ type: 'text', text: `prompt ${index}` }] },
    }));
    at += 1_000;
    lines.push(json({
      type: 'message', id: `${session}-a${index}`, timestamp: iso(at),
      message: {
        role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }],
        modelId: 'synth-model', openaiMessageId: `${session}-response-${index}`,
      },
    }));
    at += 2_000;
  }
  return { lines, turnCount: count };
}

test('合成验收：消息守恒、fork 复制段零建行、子代理归属与会话累计口径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-droid-acceptance-'));
  const f = fixture();
  try {
    const main = turns(4, 'main', T0);
    const child = turns(2, 'child', T0 + 40_000);
    // fork 的复制段保留源会话消息与 id，锚点之后才用新会话自己的 id。
    const forkCopied = main.lines.slice(0, 4);
    const forkAt = T0 + 30_000;
    const forkNew = [
      json({
        type: 'message', id: 'fork-u1', timestamp: iso(forkAt),
        message: { role: 'user', content: [{ type: 'text', text: 'fork prompt' }] },
      }),
      json({
        type: 'message', id: 'fork-a1', timestamp: iso(forkAt + 1_000),
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'fork reply' }],
          modelId: 'synth-model', openaiMessageId: 'fork-response-1',
        },
      }),
    ];

    writeFileSync(join(root, 'main.jsonl'), [
      json({ type: 'session_start', id: 'main', cwd: '/work/main', version: 2 }),
      ...main.lines,
    ].join('\n') + '\n');
    writeFileSync(join(root, 'fork.jsonl'), [
      json({ type: 'session_start', id: 'fork', cwd: '/work/fork', forkedAtMessageId: 'main-a2', version: 2 }),
      ...forkCopied, ...forkNew,
    ].join('\n') + '\n');
    writeFileSync(join(root, 'child.jsonl'), [
      json({ type: 'session_start', id: 'child', cwd: '/work/child', callingSessionId: 'main', version: 2 }),
      ...child.lines,
      json({ type: 'agent_turn_outcome', turnId: 'child-turn', resultKind: 'completed' }),
    ].join('\n') + '\n');
    writeFileSync(join(root, 'main.settings.json'), json({
      tokenUsage: {
        inputTokens: 4000, outputTokens: 900, cacheCreationTokens: 100,
        cacheReadTokens: 2500, thinkingTokens: 120, factoryCredits: 2.5,
      },
      model: 'synth-model',
    }));
    // 子代理的 settings 存在也不计入：子代理用量已在调用它的会话里。
    writeFileSync(join(root, 'child.settings.json'), json({
      tokenUsage: { inputTokens: 999, outputTokens: 999 },
      model: 'synth-model',
    }));

    const result = await ingestDroidBatch(f.store, root, SALT, 1);
    // 2 条 fork 复制段 assistant 不建行：4 + (3-2) + 2 = 7。
    expect(result).toMatchObject({ files: 3, calls: 7, merged: 0, duplicates: 0, invalid: 0 });

    expect(f.store.read.query(`
      SELECT session, COUNT(*) AS n, MIN(subagent) AS subagent, MIN(parent_agent) AS parent_agent
      FROM request GROUP BY session ORDER BY session`).all()).toEqual([
      { session: 'child', n: 2, subagent: 'child', parent_agent: 'main' },
      { session: 'fork', n: 1, subagent: null, parent_agent: null },
      { session: 'main', n: 4, subagent: null, parent_agent: null },
    ]);
    // 总 assistant 行 9 条，减掉 fork 复制段 2 条，正好等于 request 行数。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 7 });
    // 会话累计只来自主会话的 settings；子代理文件被忽略。
    expect(f.store.read.query('SELECT agent, session, input_tokens FROM session_usage').all())
      .toEqual([{ agent: 'droid', session: 'main', input_tokens: 4000 }]);
    // 原始层不因 fork 复制段或未知行类型丢数据：主 9 + fork 7 + 子 6 = 22 行。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM raw_droid_event').get()).toEqual({ n: 22 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});