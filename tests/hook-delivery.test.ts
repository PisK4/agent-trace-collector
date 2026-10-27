import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { hookDeliveryReport } from '../src/maintenance/delivery';
import { HOOK_ABSENT_THRESHOLD_MS } from '../src/hook';
import { HAVE_BODY, HAVE_LEDGER, HAVE_ROUTE } from '../src/evidence';
import { runMaintenance } from '../src/maintenance/cli';
import { fixture } from './fixtures';

/**
 * 投递诊断只读窗口聚合：请求侧按是否已有 hook 证据切，hook 侧按到达时间切；
 * 缺口以窗口右端为观察时点、过一个等待阈值才算 settled。未知 agent 与
 * 缺 response ID 的回调单列，不按时间邻近配对。
 */

const DAY = '2026-10-27';
const HOUR = 60 * 60_000;

type Seed = {
  req_id: number;
  agent?: string | null;
  status?: number | null;
  req_kind?: string;
  prompt_tokens?: number | null;
  have?: number;
  miss_reason?: string | null;
  response_id_norm?: string | null;
  started_ms: number;
};

function seedRequests(store: ReturnType<typeof fixture>['store'], rows: Seed[]): void {
  store.write(db => {
    for (const row of rows) {
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,agent,status,
        req_kind,prompt_tokens,started_ms,day,via,body_state,derive_version,have,
        created_at,updated_at,miss_reason,response_id_norm)
        VALUES (?,?,'session','actor','known',?,?,?,?,?,?,'through',?,0,?,1,1,?,?)`, [
        row.req_id, `conv-${row.req_id}`, row.agent === undefined ? 'synthetic-agent' : row.agent,
        row.status === undefined ? 200 : row.status, row.req_kind ?? 'chat',
        row.prompt_tokens === undefined ? null : row.prompt_tokens, row.started_ms, DAY,
        (row.have ?? HAVE_BODY) === 0 ? 'pending' : 'available', row.have ?? HAVE_BODY,
        row.miss_reason === undefined ? null : row.miss_reason,
        row.response_id_norm === undefined ? null : row.response_id_norm,
      ]);
    }
  });
}

function seedHook(
  store: ReturnType<typeof fixture>['store'],
  hookId: string,
  receivedAt: number,
  fields: { agent?: string | null; reply_state?: string | null; miss_reason?: string | null } = {},
): void {
  store.write(db => db.run(`INSERT INTO raw_hook(hook_id,received_at,agent,reply_state,miss_reason,parse_state)
    VALUES (?,?,?,?,?,'ok')`, [
    hookId, receivedAt, fields.agent === undefined ? 'synthetic-agent' : fields.agent,
    fields.reply_state === undefined ? 'ok' : fields.reply_state,
    fields.miss_reason === undefined ? null : fields.miss_reason,
  ]));
}

test('窗口按请求开始时间切分，缺口以窗口右端过一个等待阈值才算 settled', () => {
  const f = fixture();
  try {
    const until = 10 * HOUR;
    seedRequests(f.store, [
      // 窗口内、过了阈值仍缺 hook。
      { req_id: 1, started_ms: until - 2 * HOUR, have: HAVE_LEDGER | HAVE_ROUTE, miss_reason: 'hook_absent' },
      // 窗口内、仍在等待阈值内。
      { req_id: 2, started_ms: until - 10 * 60_000, have: HAVE_LEDGER | HAVE_ROUTE },
      // 窗口内、已有 hook。
      { req_id: 3, started_ms: until - HOUR, have: HAVE_BODY | HAVE_LEDGER },
      // 窗口外：早于起点，不参与。
      { req_id: 4, started_ms: until - 5 * HOUR, have: HAVE_LEDGER },
    ]);
    // 修正 4 号到窗口外。
    f.store.write(db => db.run('UPDATE request SET started_ms=? WHERE req_id=4', [until - 11 * HOUR]));

    const report = hookDeliveryReport(f.store.read, { sinceMs: until - 4 * HOUR, untilMs: until });
    expect(report.window).toEqual({
      since_ms: until - 4 * HOUR, until_ms: until, settled_before_ms: until - HOUR,
    });
    expect(report.requests).toMatchObject({
      total: 3, with_hook: 1, missing_hook: 2, settled_missing: 1, young_missing: 1,
      missing_with_sources: 2, missing_without_response_id: 2, awaiting_candidate: 0,
    });
    expect(report.requests.by_agent).toEqual([{ agent: 'synthetic-agent', total: 3, missing: 2 }]);
    expect(report.requests.miss_reasons).toEqual([
      { reason: 'hook_absent', n: 1 },
      { reason: 'none', n: 1 },
    ]);
  } finally {
    f.close();
  }
});

test('按状态码、请求类别与体积分档计数，未知值单列', () => {
  const f = fixture();
  try {
    const until = 10 * HOUR;
    seedRequests(f.store, [
      { req_id: 1, started_ms: until - 2 * HOUR, have: 0, status: 200, req_kind: 'chat', prompt_tokens: 500 },
      { req_id: 2, started_ms: until - 2 * HOUR, have: 0, status: 200, req_kind: 'title', prompt_tokens: 20_000 },
      { req_id: 3, started_ms: until - 2 * HOUR, have: 0, status: 429, req_kind: 'chat', prompt_tokens: 200_000 },
      { req_id: 4, started_ms: until - 2 * HOUR, have: 0, status: null, req_kind: 'command-review', prompt_tokens: null },
    ]);
    const report = hookDeliveryReport(f.store.read, { sinceMs: until - 4 * HOUR, untilMs: until });
    expect(report.requests.by_status).toEqual([
      { status: null, missing: 1 },
      { status: 200, missing: 2 },
      { status: 429, missing: 1 },
    ]);
    expect(report.requests.by_kind).toEqual([
      { kind: 'chat', missing: 2 },
      { kind: 'command-review', missing: 1 },
      { kind: 'title', missing: 1 },
    ]);
    expect(report.requests.by_prompt_tokens).toEqual([
      { bucket: '10k_to_100k', missing: 1 },
      { bucket: 'gte_100k', missing: 1 },
      { bucket: 'lt_10k', missing: 1 },
      { bucket: 'unknown', missing: 1 },
    ]);
  } finally {
    f.close();
  }
});

test('等待队列指向本行的回调计为待合并，不算投递缺失', () => {
  const f = fixture();
  try {
    const until = 10 * HOUR;
    seedRequests(f.store, [
      { req_id: 1, started_ms: until - 2 * HOUR, have: 0, response_id_norm: 'msg_waiting' },
      { req_id: 2, started_ms: until - 2 * HOUR, have: 0, response_id_norm: 'msg_absent' },
      { req_id: 3, started_ms: until - 2 * HOUR, have: 0 },
    ]);
    f.store.write(db => {
      db.run(`INSERT INTO pending_hook(hook_id,response_id,response_id_norm,first_seen)
        VALUES ('hook-waiting','msg_waiting','msg_waiting',?)`, [until - 2 * HOUR]);
      db.run(`INSERT INTO pending_hook(hook_id,response_id,response_id_norm,first_seen)
        VALUES ('hook-no-id',NULL,NULL,?)`, [until - 2 * HOUR]);
    });
    const report = hookDeliveryReport(f.store.read, { sinceMs: until - 4 * HOUR, untilMs: until });
    expect(report.requests.awaiting_candidate).toBe(1);
    expect(report.requests.missing_without_response_id).toBe(1);
    expect(report.pending_hooks).toEqual({ total: 2, without_response_id: 1 });
  } finally {
    f.close();
  }
});

test('hook 到达侧按收到时间切分，回复缺失与正文降级分开计数', () => {
  const f = fixture();
  try {
    const until = 10 * HOUR;
    seedHook(f.store, 'hook-ok', until - HOUR, { agent: 'hermes' });
    seedHook(f.store, 'hook-noreply', until - HOUR, { agent: 'hermes', reply_state: 'absent' });
    seedHook(f.store, 'hook-omitted', until - HOUR, { agent: null, miss_reason: 'collector_object_limit' });
    seedHook(f.store, 'hook-old', until - 10 * HOUR, { agent: 'hermes' });

    const report = hookDeliveryReport(f.store.read, { sinceMs: until - 4 * HOUR, untilMs: until });
    expect(report.raw_hooks).toEqual({
      received: 3,
      reply_absent: 1,
      body_omitted: 1,
      by_agent: [{ agent: 'hermes', n: 2 }, { agent: null, n: 1 }],
    });
  } finally {
    f.close();
  }
});

test('ingest_issue 按观察时间与原因聚合', () => {
  const f = fixture();
  try {
    const until = 10 * HOUR;
    f.store.write(db => {
      db.run(`INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length)
        VALUES ('hook','hook-a','raw_hook_body_unlinked',?,NULL)`, [until - HOUR]);
      db.run(`INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length)
        VALUES ('hook','hook-b','raw_hook_body_unlinked',?,NULL)`, [until - HOUR]);
      db.run(`INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length)
        VALUES ('ledger','ledger-a','invalid_json',?,NULL)`, [until - HOUR]);
      db.run(`INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length)
        VALUES ('hook','hook-old','raw_hook_body_unlinked',?,NULL)`, [until - 9 * HOUR]);
    });
    const report = hookDeliveryReport(f.store.read, { sinceMs: until - 4 * HOUR, untilMs: until });
    expect(report.issues).toEqual([
      { source_kind: 'hook', reason: 'raw_hook_body_unlinked', n: 2 },
      { source_kind: 'ledger', reason: 'invalid_json', n: 1 },
    ]);
  } finally {
    f.close();
  }
});

test('命令要求完整窗口，非法端点退出 2，非法区间退出 1', async () => {
  const f = fixture();
  const dbPath = join(f.dir, 'trace.db');
  try {
    const lines: string[] = [];
    const errs: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => errs.push(line) };

    expect(await runMaintenance(['hook-delivery', '--db', dbPath, '--since', '2026-10-27T00:00:00Z'], io))
      .toBe(2);
    expect(await runMaintenance(['hook-delivery', '--db', dbPath, '--since', 'nonsense', '--until', '1'], io))
      .toBe(2);
    expect(await runMaintenance(['hook-delivery', '--db', dbPath,
      '--since', '2026-10-27T02:00:00Z', '--until', '2026-10-27T01:00:00Z'], io)).toBe(1);
    expect(errs.at(-1)).toBe('hook-delivery_failed:invalid_window');

    expect(await runMaintenance(['hook-delivery', '--db', dbPath,
      '--since', '2026-10-27T00:00:00Z', '--until', '2026-10-27T01:00:00Z'], io)).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: true,
      window: { until_ms: Date.parse('2026-10-27T01:00:00Z') },
      requests: { total: 0, missing_hook: 0 },
    });
  } finally {
    f.close();
  }
});

test('等待阈值常量与诊断口径取自同一处', () => {
  // 缺口判定使用 hook 缺席老化的阈值；两边改成不同值会让报告与 miss_reason 对不上。
  expect(HOOK_ABSENT_THRESHOLD_MS).toBe(HOUR);
});
