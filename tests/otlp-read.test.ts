import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { listSessions } from '../src/queries/sessions';
import { listRequests } from '../src/queries/requests';
import { acceptOtlpTraces } from '../src/sources/otlp/ingest';
import { decodeTracesBody } from '../src/sources/otlp/decode';
import { SYNTH, tracesProtobuf } from './otlp-fixtures';
import { bodyLabelText, bodyStateText } from '../web/row-summary.js';

const NOW = 1_790_000_000_000;
const SALT = new Uint8Array(32);

function seedRequest(store: ReturnType<typeof fixture>['store'], values: {
  reqId: number; key: string; via: string; have: number; bodyState: string;
}): void {
  store.write(db => db.run(`
    INSERT INTO request(req_id,conv_key,conv_source,actor,agent,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
    VALUES (?,?,'session','actor-a','claude','known',1000,'2026-10-26',?,?,1,?,1,1,'t','model_time')`,
    [values.reqId, values.key, values.via, values.bodyState, values.have]));
}

test('缺正文按期望位图计算：otlp 不标、rejected 不标、through 缺位标', () => {
  const f = fixture();
  try {
    const otlpOnly = JSON.stringify(['session', 'otlp-only']);
    const rejected = JSON.stringify(['session', 'rejected-only']);
    const throughPartial = JSON.stringify(['session', 'through-partial']);
    seedRequest(f.store, { reqId: 1, key: otlpOnly, via: 'otlp', have: 8, bodyState: 'summary' });
    seedRequest(f.store, { reqId: 2, key: rejected, via: 'rejected', have: 2, bodyState: 'pending' });
    seedRequest(f.store, { reqId: 3, key: throughPartial, via: 'through', have: 3, bodyState: 'available' });
    const items = listSessions(f.store, 10, null).items;
    const flagsOf = (key: string): string[] => items.find(row => row.conv_key === key)?.flags ?? [];
    // OTLP 行只有摘要正文，不因缺 magpie 三路证据被标采集失败。
    expect(flagsOf(otlpOnly)).toEqual([]);
    // rejected 期望位只有账本；正文本来就不该有。
    expect(flagsOf(rejected)).toEqual([]);
    // through 缺路由与回调位：期望位缺失，标。
    expect(flagsOf(throughPartial)).toEqual(['missing_body']);
  } finally {
    f.close();
  }
});

test('请求列表带 via：OTLP 行与 magpie 行在读模型可区分', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', SYNTH.session]);
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [{
      traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 'chat synth-model-lite',
      startNano: SYNTH.msToNano(1000),
      attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.conversation.id': SYNTH.session },
    }] }]), 'protobuf');
    acceptOtlpTraces(f.store, decoded, NOW, SALT);
    seedRequest(f.store, { reqId: 900, key, via: 'through', have: 2, bodyState: 'pending' });
    const rows = listRequests(f.store, key, 10).items;
    const vias = rows.map(row => row.via).sort();
    expect(vias).toEqual(['otlp', 'through']);
    const otlpRow = rows.find(row => row.via === 'otlp')!;
    expect(otlpRow.body_state).toBe('summary');
    expect(otlpRow.agent).toBe('omp');
  } finally {
    f.close();
  }
});

test('summary 正文文案：明示来自 OTLP 摘要，不冒充正文可用', () => {
  expect(bodyStateText({ body_state: 'summary' })).toBe('OTLP 摘要');
  expect(bodyLabelText({ body_state: 'summary', miss_reason: null }))
    .toBe('正文来自 OTLP 摘要');
  expect(bodyLabelText({ body_state: 'summary', miss_reason: 'body_ref_read_failed' }))
    .toBe('正文来自 OTLP 摘要：body_ref_read_failed');
});
