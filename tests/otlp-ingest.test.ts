import { expect, test } from 'bun:test';
import { acceptOtlpTraces } from '../src/sources/otlp/ingest';
import { decodeTracesBody } from '../src/sources/otlp/decode';
import { SYNTH, tracesProtobuf } from './otlp-fixtures';
import { fixture } from './fixtures';

const NOW = 1_790_000_000_000;
/** 与真实 OMP chat span 同形状、不同值的合成 span。 */
const OMP_CHAT = {
  traceId: SYNTH.traceA,
  spanId: SYNTH.spanLLM,
  name: 'chat synth-model-lite',
  kind: 3,
  startNano: SYNTH.msToNano(1_792_945_426_098),
  endNano: SYNTH.msToNano(1_792_945_428_830),
  attrs: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'synth-model-lite',
    'gen_ai.response.model': 'synth-model-lite-served',
    'gen_ai.response.id': SYNTH.responseId,
    'gen_ai.conversation.id': SYNTH.session,
    'gen_ai.response.finish_reasons': { arr: ['stop'] },
    'gen_ai.usage.input_tokens': { int: 8233 },
    'gen_ai.usage.output_tokens': { int: 3 },
    'gen_ai.usage.cache_read.input_tokens': { int: 128 },
    'gen_ai.usage.cache_creation.input_tokens': { int: 256 },
  },
};

function ingestOmp(payload: { resource: { service: string }; spans: typeof OMP_CHAT[] }[],
  salt = new Uint8Array(32)) {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf(payload), 'protobuf');
    const result = acceptOtlpTraces(store.store, decoded, NOW, salt);
    return { store, result };
  } catch (error) {
    store.close();
    throw error;
  }
}

test('OMP chat span 落库：via=otlp、have=8、白名单列映射、conv 与 magpie 同组键', () => {
  const { store, result } = ingestOmp([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT] }]);
  try {
    expect(result).toEqual({ spans: 1, spanDuplicates: 0, requestsCreated: 1, unknownShape: 0, bodiesWired: 0 });
    const row = store.store.read.query(`
      SELECT via, have, body_state, agent, session, conv_key, conv_source, actor, actor_state,
        started_ms, stop, model_requested, model_served, in_tok, out_tok, cache_read, cache_write,
        response_id_norm, sort_source, sort_key, cost_state
      FROM request`).get() as Record<string, unknown>;
    expect(row.via).toBe('otlp');
    expect(row.have).toBe(8);
    expect(row.body_state).toBe('summary');
    expect(row.agent).toBe('omp');
    expect(row.session).toBe(SYNTH.session);
    // 组键与 sessionRef 逐字相同：同会话双通道并存落同一派生组。
    expect(row.conv_key).toBe(JSON.stringify(['session', SYNTH.session]));
    expect(row.conv_source).toBe('otlp-session');
    expect(row.actor).toBe(SYNTH.session);
    expect(row.actor_state).toBe('known');
    expect(row.started_ms).toBe(1_792_945_426_098);
    expect(row.stop).toBe('stop');
    expect(row.model_requested).toBe('synth-model-lite');
    expect(row.model_served).toBe('synth-model-lite-served');
    expect(row.in_tok).toBe(8233);
    expect(row.out_tok).toBe(3);
    expect(row.cache_read).toBe(128);
    expect(row.cache_write).toBe(256);
    // 第一批不写锚点列：跨通道去重是 Deferred，不提前用掉。
    expect(row.response_id_norm).toBeNull();
    expect(row.sort_source).toBe('otlp_span');
    expect(row.cost_state).toBe('absent');
    const evidence = store.store.read.query(
      'SELECT req_id, source_kind, ref_key, merge_state, match_rule FROM request_evidence').all();
    expect(evidence).toEqual([{
      req_id: 1, source_kind: 'otlp_span',
      ref_key: `${Buffer.from(SYNTH.traceA).toString('hex')}/${Buffer.from(SYNTH.spanLLM).toString('hex')}`,
      merge_state: 'merged', match_rule: 'trace_span.v1',
    }]);
    // 有会话 id 的行进派生队列。
    const queued = store.store.read.query(
      'SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get(SYNTH.session ? JSON.stringify(['session', SYNTH.session]) : '');
    expect((queued as { n: number }).n).toBe(1);
    const raw = store.store.read.query(
      'SELECT service, name, start_ms, end_ms, mapping_version FROM raw_otlp_span').all();
    expect(raw).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('同一批次重发两次：第二次全为重复，不产生新行', () => {
  const store = fixture();
  try {
    const payload = () => decodeTracesBody(
      tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT] }]), 'protobuf');
    const salt = new Uint8Array(32);
    const first = acceptOtlpTraces(store.store, payload(), NOW, salt);
    const second = acceptOtlpTraces(store.store, payload(), NOW + 1000, salt);
    expect(first.requestsCreated).toBe(1);
    expect(second).toEqual({ spans: 1, spanDuplicates: 1, requestsCreated: 0, unknownShape: 0, bodiesWired: 0 });
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(1);
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_span').get() as { n: number }).n).toBe(1);
  } finally {
    store.close();
  }
});

test('CC 一棵 span 树只建 llm_request 行：interaction 不出现在请求列表', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([
      { resource: { service: 'claude-code' }, spans: [
        {
          traceId: SYNTH.traceB, spanId: SYNTH.spanInteraction, name: 'claude_code.interaction',
          startNano: SYNTH.msToNano(1000), endNano: SYNTH.msToNano(2500),
          attrs: { 'gen_ai.conversation.id': SYNTH.session, 'session.id': SYNTH.session, 'gen_ai.operation.name': 'invoke_agent' },
        },
        {
          traceId: SYNTH.traceB, spanId: SYNTH.spanLLM, name: 'claude_code.llm_request',
          startNano: SYNTH.msToNano(1100), endNano: SYNTH.msToNano(2400),
          attrs: {
            'gen_ai.conversation.id': SYNTH.session,
            'gen_ai.request.model': 'synth-cc-model',
            stop_reason: 'end_turn',
            input_tokens: { int: 4888 },
            output_tokens: { int: 3 },
            cache_read_tokens: { int: 8192 },
            cache_creation_tokens: { int: 0 },
          },
        },
        {
          traceId: SYNTH.traceB, spanId: SYNTH.spanTool, name: 'claude_code.tool_use',
          startNano: SYNTH.msToNano(1200), endNano: SYNTH.msToNano(1300),
          attrs: { 'gen_ai.tool.call.id': 'toolu_synthetic_1' },
        },
      ] },
    ]), 'protobuf');
    const result = acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32));
    expect(result.spans).toBe(3);
    expect(result.requestsCreated).toBe(1);
    expect(result.unknownShape).toBe(0);
    // 白名单外的两份 span 留在原始层作元数据。
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_span').get() as { n: number }).n).toBe(3);
    const row = store.store.read.query(
      'SELECT agent, stop, in_tok, cache_read, model_served FROM request').get() as Record<string, unknown>;
    expect(row.agent).toBe('claude');
    expect(row.stop).toBe('end_turn');
    expect(row.in_tok).toBe(4888);
    expect(row.cache_read).toBe(8192);
    // CC 抓样里没有 gen_ai.response.model：按缺失保持 NULL。
    expect(row.model_served).toBeNull();
  } finally {
    store.close();
  }
});

test('span 不带会话 id：行可查但没有 conv_key，也不进派生队列', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [{
      traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 'chat synth-model-lite',
      startNano: SYNTH.msToNano(1), attrs: { 'gen_ai.operation.name': 'chat' },
    }] }]), 'protobuf');
    acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32));
    const row = store.store.read.query(
      'SELECT conv_key, conv_source, actor, actor_state FROM request').get() as Record<string, unknown>;
    expect(row.conv_key).toBeNull();
    expect(row.conv_source).toBeNull();
    expect(row.actor).toBeNull();
    expect(row.actor_state).toBe('unknown');
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get() as { n: number }).n).toBe(0);
  } finally {
    store.close();
  }
});

test('LLM 形状但选取规则没认的 span 进未知桶，不按形状兜底建行', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [{
      traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 'chat-stream synth-model',
      startNano: SYNTH.msToNano(1),
      attrs: {
        'gen_ai.operation.name': 'chat_stream',
        'gen_ai.usage.input_tokens': { int: 10 },
      },
    }] }]), 'protobuf');
    const result = acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32));
    expect(result).toEqual({ spans: 1, spanDuplicates: 0, requestsCreated: 0, unknownShape: 1, bodiesWired: 0 });
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(0);
    const issues = store.store.read.query<{ reason: string }, [string]>(
      'SELECT reason FROM ingest_issue WHERE source_kind=?').all('otlp_span');
    expect(issues).toEqual([{ reason: 'span_shape_unknown' }]);
  } finally {
    store.close();
  }
});

test('白名单外的服务不建行也不记未知桶', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'some-other-harness' }, spans: [
      { ...OMP_CHAT, name: 'chat whatever' },
    ] }]), 'protobuf');
    const result = acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32));
    expect(result).toEqual({ spans: 1, spanDuplicates: 0, requestsCreated: 0, unknownShape: 0, bodiesWired: 0 });
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(0);
  } finally {
    store.close();
  }
});

test('凭证形态属性脱敏后才进原始层；映射列不受影响', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [{
      ...OMP_CHAT,
      attrs: {
        ...OMP_CHAT.attrs,
        'gen_ai.input.messages': {
          arr: [
            { kv: { role: 'user' } },
            { kv: { content: 'token sk-synthcredential000000 Abbott' } },
          ],
        },
      },
    }] }]), 'protobuf');
    acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32));
    const raw = store.store.read.query<{ attributes_json: string }, []>(
      'SELECT attributes_json FROM raw_otlp_span').get()!;
    expect(raw.attributes_json).not.toContain('sk-synthcredential000000');
    expect(raw.attributes_json).toContain('[redacted:api_key:');
    // 白名单映射列取自解码值，不含凭证。
    const row = store.store.read.query('SELECT in_tok, model_requested FROM request').get() as Record<string, unknown>;
    expect(row.in_tok).toBe(8233);
  } finally {
    store.close();
  }
});

test('暂停档整批拒绝：不写任何行', () => {
  const store = fixture();
  try {
    const decoded = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT] }]), 'protobuf');
    expect(() => acceptOtlpTraces(store.store, decoded, NOW, new Uint8Array(32), {
      admission: () => ({ mode: 'paused', reason: 'disk_95' }),
    })).toThrow('disk_full');
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(0);
    expect((store.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_span').get() as { n: number }).n).toBe(0);
  } finally {
    store.close();
  }
});
