import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { claudeAdapter } from '../src/sources/session/adapters/claude';
import { codexAdapter } from '../src/sources/session/adapters/codex';
import { runSessionScheduler } from '../src/sources/session/scheduler';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const SALT = new Uint8Array(32);
const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

test('会话调度：活跃源走 live，积压源同轮轮转回填', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-session-scheduler-'));
  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  const f = fixture();
  try {
    const claudePath = join(claudeRoot, 'session.jsonl');
    writeFileSync(claudePath, `${[
      json({
        type: 'user', sessionId: 'claude-session', timestamp: iso(T0),
        cwd: '/work/synthetic', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
      json({
        type: 'assistant', sessionId: 'claude-session', timestamp: iso(T0 + 2_000),
        cwd: '/work/synthetic',
        message: {
          id: 'msg_claude-scheduler-1', model: 'claude-synthetic', role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join('\n')}\n`);

    const codexPath = join(codexRoot, 'rollout.jsonl');
    const sessionId = 'codex-session';
    writeFileSync(codexPath, `${[
      json({ timestamp: iso(T0), type: 'session_meta', payload: { id: sessionId, cwd: '/work/synthetic' } }),
      json({ timestamp: iso(T0), type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-synthetic' } }),
      json({
        timestamp: iso(T0 + 100), type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      }),
      json({
        timestamp: iso(T0 + 1_000), type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'world' }] },
      }),
      json({
        timestamp: iso(T0 + 2_000), type: 'token_usage_record',
        payload: {
          response_id: 'resp_codex-scheduler-1', turn_id: 'turn-1',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join('\n')}\n`);

    const now = Date.now();
    // Claude 在活跃窗口外，只走回填；Codex 是最近写入，先走 live。
    utimesSync(claudePath, new Date(now - 20 * 60_000), new Date(now - 20 * 60_000));
    utimesSync(codexPath, new Date(now), new Date(now));

    const state = { backfillCursor: 0 };
    const result = await runSessionScheduler(
      f.store,
      [claudeAdapter, codexAdapter],
      adapter => (adapter === claudeAdapter ? [claudeRoot] : [codexRoot]),
      SALT,
      now,
      state,
      { liveWindowMs: 10 * 60_000, maxLiveAdapters: 1, liveBatch: { maxFiles: 1, maxBytes: 1024 * 1024 } },
    );

    expect(result).toMatchObject({ live: 1, backfill: 1, files: 2, calls: 2 });
    expect(f.store.read.query(
      'SELECT agent FROM request ORDER BY agent').all())
      .toEqual([{ agent: 'claude' }, { agent: 'codex' }]);
    expect(state.backfillCursor).toBe(1);

    // 第二轮回填从下一家开始；两家都已读完，不再产生调用。
    const second = await runSessionScheduler(
      f.store, [claudeAdapter, codexAdapter],
      adapter => (adapter === claudeAdapter ? [claudeRoot] : [codexRoot]),
      SALT, now + 1_000, state,
      { liveWindowMs: 10 * 60_000, maxLiveAdapters: 1, liveBatch: { maxFiles: 1, maxBytes: 1024 * 1024 } },
    );
    expect(second).toMatchObject({ live: 0, backfill: 0, files: 0, calls: 0 });
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
