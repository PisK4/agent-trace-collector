import { expect, test } from 'bun:test';
import {
  OtlpDecodeError, decodeLogsBody, decodeTracesBody, idHex, nanoToMs,
} from '../src/sources/otlp/decode';
import {
  SYNTH, lenDelim, logsProtobuf, tracesJson, tracesProtobuf, logsJson,
} from './otlp-fixtures';

const OMP_CHAT_SPAN = {
  traceId: SYNTH.traceA,
  spanId: SYNTH.spanLLM,
  name: 'chat synth-model-lite',
  kind: 3,
  startNano: SYNTH.msToNano(1792945426098),
  endNano: SYNTH.msToNano(1792945428830),
  attrs: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'synth-model-lite',
    'gen_ai.response.id': SYNTH.responseId,
    'gen_ai.conversation.id': SYNTH.session,
    'gen_ai.usage.input_tokens': { int: 8233 },
    'gen_ai.usage.output_tokens': { int: 3 },
    'omp.gen_ai.cost.estimated_usd': { dbl: 0.000311 },
    'gen_ai.response.finish_reasons': { arr: ['stop'] },
    'gen_ai.request.stream': { bool: true },
  },
  statusCode: 1,
};

test('protobuf traces：OMP 形状 span 解出全部白名单属性与身份', () => {
  const payload = tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT_SPAN] }]);
  const decoded = decodeTracesBody(payload, 'protobuf');
  expect(decoded.resourceSpans).toHaveLength(1);
  const scope = decoded.resourceSpans[0]!;
  expect(scope.service).toBe('oh-my-pi');
  expect(scope.items).toHaveLength(1);
  const span = scope.items[0]!;
  expect(idHex(span.traceId)).toBe(Buffer.from(SYNTH.traceA).toString('hex'));
  expect(span.name).toBe('chat synth-model-lite');
  expect(span.kind).toBe(3);
  expect(nanoToMs(span.startNano)).toBe(1792945426098);
  expect(nanoToMs(span.endNano!)).toBe(1792945428830);
  expect(span.attrs['gen_ai.operation.name']).toBe('chat');
  expect(span.attrs['gen_ai.usage.input_tokens']).toBe(8233);
  expect(span.attrs['omp.gen_ai.cost.estimated_usd']).toBeCloseTo(0.000311, 9);
  expect(span.attrs['gen_ai.response.finish_reasons']).toEqual(['stop']);
  expect(span.attrs['gen_ai.request.stream']).toBe(true);
  expect(span.statusCode).toBe(1);
});

test('protobuf traces：未知字段整段跳过，不判非法', () => {
  // field 99 未知 varint + 未知 length-delimited，解码器必须忽略。
  const base = tracesProtobuf([{ resource: { service: 'x' }, spans: [] }]);
  const withUnknown = new Uint8Array([...lenDelim(99, 'unknown'), ...base]);
  const decoded = decodeTracesBody(withUnknown, 'protobuf');
  expect(decoded.resourceSpans).toHaveLength(1);
});

test('JSON traces：驼峰键与十六进制 id 归一到与 protobuf 同一形状', () => {
  const decoded = decodeTracesBody(
    Buffer.from(JSON.stringify(tracesJson([{ resource: { service: 'claude-code' }, spans: [
      {
        traceId: SYNTH.traceA,
        spanId: SYNTH.spanLLM,
        name: 'claude_code.llm_request',
        startNano: SYNTH.msToNano(1792945089318),
        endNano: SYNTH.msToNano(1792945183112),
        attrs: {
          input_tokens: { int: 4888 },
          cache_read_tokens: { int: 8192 },
          stop_reason: 'end_turn',
          'gen_ai.conversation.id': SYNTH.session,
        },
      },
    ] }]))),
    'json',
  );
  const span = decoded.resourceSpans[0]!.items[0]!;
  expect(span.name).toBe('claude_code.llm_request');
  expect(span.traceId).toEqual(SYNTH.traceA);
  expect(span.spanId).toEqual(SYNTH.spanLLM);
  expect(span.attrs['input_tokens']).toBe(4888);
  expect(span.attrs['stop_reason']).toBe('end_turn');
});

test('JSON 与 protobuf 双路径对同一合成 span 解出相同身份与时间', () => {
  const spans = [{
    traceId: SYNTH.traceB, spanId: SYNTH.spanTool, name: 'execute_tool read',
    startNano: SYNTH.msToNano(1000), endNano: SYNTH.msToNano(1500),
    attrs: { 'gen_ai.tool.call.id': 'call-synth-1' },
  }];
  const fromProtobuf = decodeTracesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans }]), 'protobuf');
  const fromJson = decodeTracesBody(
    Buffer.from(JSON.stringify(tracesJson([{ resource: { service: 'oh-my-pi' }, spans }]))), 'json');
  expect(fromJson.resourceSpans[0]!.items[0]).toEqual(fromProtobuf.resourceSpans[0]!.items[0]);
});

test('破坏输入各自得到明确原因码：截断、group 编码、身份缺失、坏 JSON、坏 hex', () => {
  const full = tracesProtobuf([{ resource: { service: 'x' }, spans: [OMP_CHAT_SPAN] }]);
  expect(() => decodeTracesBody(full.subarray(0, full.length - 3), 'protobuf')).toThrow(OtlpDecodeError);
  // wire type 3（group）在 OTLP 载荷里非法：tag = field 1 | wt 3。
  expect(() => decodeTracesBody(new Uint8Array([0x0b]), 'protobuf')).toThrow(OtlpDecodeError);
  // span 缺 start time：身份不全拒绝整份。
  const noStart = tracesProtobuf([{ resource: { service: 'x' }, spans: [{
    traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 's', startNano: undefined as unknown as bigint,
  }] }]);
  expect(() => decodeTracesBody(noStart, 'protobuf')).toThrow(new OtlpDecodeError('otlp_span_identity'));
  expect(() => decodeTracesBody(Buffer.from('not json'), 'json')).toThrow(OtlpDecodeError);
  expect(() => decodeTracesBody(
    Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'zz', spanId: 'ab', name: 'n', startTimeUnixNano: '1' }] }] }] })),
    'json',
  )).toThrow(new OtlpDecodeError('otlp_json_trace_id'));
});

test('超过 2^53 的整数属性保十进制字符串，不丢精度也不静默截断', () => {
  const payload = tracesProtobuf([{ resource: { service: 'x' }, spans: [{
    traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 's', startNano: 1n,
    attrs: { 'huge.counter': { int: 2n ** 60n + 123n } },
  }] }]);
  const span = decodeTracesBody(payload, 'protobuf').resourceSpans[0]!.items[0]!;
  expect(span.attrs['huge.counter']).toBe((2n ** 60n + 123n).toString());
});

test('protobuf logs：OMP 汇总事件与 CC body 事件的字段号落位', () => {
  const payload = logsProtobuf([
    {
      resource: { service: 'oh-my-pi' },
      records: [{
        timeNano: SYNTH.msToNano(1792945426098),
        severityNumber: 13,
        severityText: 'WARN',
        body: 'model discovery failed for provider',
        eventName: 'omp.log',
        attrs: { 'process.pid': { int: 4242 } },
      }],
    },
    {
      resource: { service: 'claude-code' },
      records: [{
        timeNano: SYNTH.msToNano(1792945089321),
        body: 'claude_code.api_request_body',
        traceId: SYNTH.traceA,
        spanId: SYNTH.spanInteraction,
        attrs: {
          body_ref: '/tmp/synth-bodies/req-0001.request.json',
          request_body_id: 'req-synth-0001',
          'session.id': SYNTH.session,
        },
      }],
    },
  ]);
  const decoded = decodeLogsBody(payload, 'protobuf');
  const [omp, cc] = decoded.resourceLogs;
  expect(omp!.service).toBe('oh-my-pi');
  expect(omp!.items[0]!.severityNumber).toBe(13);
  expect(omp!.items[0]!.body).toBe('model discovery failed for provider');
  expect(omp!.items[0]!.eventName).toBe('omp.log');
  expect(cc!.items[0]!.traceId).toEqual(SYNTH.traceA);
  expect(cc!.items[0]!.spanId).toEqual(SYNTH.spanInteraction);
  expect(cc!.items[0]!.attrs['body_ref']).toBe('/tmp/synth-bodies/req-0001.request.json');
});

test('JSON logs 路径与 protobuf 同形状', () => {
  const resources = [{
    resource: { service: 'claude-code' },
    records: [{
      timeNano: SYNTH.msToNano(5),
      body: 'claude_code.api_response_body',
      traceId: SYNTH.traceA,
      spanId: SYNTH.spanInteraction,
      attrs: { 'message.id': 'msg_synth_0001', body_ref: '/tmp/synth-bodies/req-0001.response.json' },
    }],
  }];
  const fromJson = decodeLogsBody(Buffer.from(JSON.stringify(logsJson(resources))), 'json');
  const fromProtobuf = decodeLogsBody(logsProtobuf(resources), 'protobuf');
  expect(fromJson.resourceLogs[0]!.items[0]).toEqual(fromProtobuf.resourceLogs[0]!.items[0]);
});

test('kvlist 属性解成对象，数组属性保序', () => {
  const payload = tracesProtobuf([{ resource: { service: 'x' }, spans: [{
    traceId: SYNTH.traceA, spanId: SYNTH.spanLLM, name: 's', startNano: 1n,
    attrs: {
      'nested.shape': { kv: { depth: { int: 3 }, keys: { int: 12 } } },
      'ordered.list': { arr: ['c', 'a', 'b'] },
    },
  }] }]);
  const span = decodeTracesBody(payload, 'protobuf').resourceSpans[0]!.items[0]!;
  expect(span.attrs['nested.shape']).toEqual({ depth: 3, keys: 12 });
  expect(span.attrs['ordered.list']).toEqual(['c', 'a', 'b']);
});
