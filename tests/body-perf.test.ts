import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { persistBody, restoreBody } from '../src/body';
import { getBodyPage } from '../src/protocols';
import type { BodyInput } from '../src/body';

/**
 * 计划里的规模门槛：526 块、约 14 MB 的请求。
 * 这里用合成文本凑到量级，不引入真实正文；阈值按本机噪声放宽到 400 ms，
 * 计划写的 50 ms 是参考值，真正要守的是"不随总块数线性解压"。
 */
function bigBody(count: number, bytesPerMessage: number): BodyInput {
  const text = 'x'.repeat(bytesPerMessage);
  return {
    protocol: 'anthropic',
    request: {
      system: [{ type: 'text', text: 'system' }],
      messages: Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `${i}:${text}` }],
      })),
    },
    reply: { id: 'msg_big', content: [{ type: 'text', text }] },
    redact_version: 1,
  };
}

test('526块正文完整还原与单页读取的时间量级', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
       VALUES (1,1,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    const body = bigBody(526, 26_000);
    persistBody(f.store, 1, body);

    const stored = f.store.read.query<{ bytes: number; n: number }, []>(`
      SELECT COALESCE(SUM(raw_size),0) AS bytes, COUNT(*) AS n FROM block`).get();
    expect(stored?.n).toBe(526);
    expect(stored!.bytes).toBeGreaterThan(13_000_000);

    const fullStart = performance.now();
    const restored = restoreBody(f.store, 1);
    const fullMs = performance.now() - fullStart;
    expect(restored).toEqual(body);

    const pageStart = performance.now();
    const page = getBodyPage(f.store, 1, 400, 440);
    const pageMs = performance.now() - pageStart;
    expect(page?.messages.length).toBe(40);
    expect(page?.messages[0]?.ord).toBe(400);

    // 单页只解 40 块，必须明显快于整份还原。
    expect(pageMs).toBeLessThan(fullMs);
    expect(pageMs).toBeLessThan(400);
    // 只作观测，不作硬门槛。
    console.log(`restore_all_ms=${fullMs.toFixed(1)} page_40_ms=${pageMs.toFixed(1)} bytes=${stored?.bytes ?? 0}`);
  } finally {
    f.close();
  }
});
