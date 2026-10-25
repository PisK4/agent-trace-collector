import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptOtlpLogs, acceptOtlpTraces } from '../src/sources/otlp/ingest';
import { decodeLogsBody, decodeTracesBody } from '../src/sources/otlp/decode';
import type { OtlpLogsPayload } from '../src/sources/otlp/decode';
import { SYNTH, logsProtobuf, tracesProtobuf } from './otlp-fixtures';
import { fixture } from './fixtures';

const NOW = 1_790_000_000_000;
const SALT = new Uint8Array(32);

/** 合成 Messages 调用：一份 CC 形状的 llm_request span + 两份 body 事件载荷。 */
function syntheticCall(dir: string) {
  const requestPath = join(dir, 'req-0001.request.json');
  const responsePath = join(dir, 'req-0001.response.json');
  writeFileSync(requestPath, JSON.stringify({
    model: 'synth-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic prompt' }] }],
  }));
  writeFileSync(responsePath, JSON.stringify({
    id: 'msg_synth_0001',
    content: [{ type: 'text', text: 'synthetic reply' }],
  }));
  const span = {
    traceId: SYNTH.traceB,
    spanId: SYNTH.spanLLM,
    name: 'claude_code.llm_request',
    startNano: SYNTH.msToNano(1100),
    endNano: SYNTH.msToNano(2400),
    attrs: { 'gen_ai.conversation.id': SYNTH.session, 'gen_ai.request.model': 'synth-model' },
  };
  const logs = (requestRef: string = requestPath, responseRef: string = responsePath): OtlpLogsPayload =>
    decodeLogsBody(logsProtobuf([{ resource: { service: 'claude-code' }, records: [
      {
        timeNano: SYNTH.msToNano(1100),
        body: 'claude_code.api_request_body',
        traceId: SYNTH.traceB,
        spanId: SYNTH.spanInteraction,
        attrs: { body_ref: requestRef, request_body_id: 'synth-req-0001' },
      },
      {
        timeNano: SYNTH.msToNano(2400),
        body: 'claude_code.api_response_body',
        traceId: SYNTH.traceB,
        spanId: SYNTH.spanInteraction,
        attrs: {
          body_ref: responseRef,
          request_body_id: 'synth-req-0001',
          'message.id': 'msg_synth_0001',
        },
      },
    ] }]), 'protobuf');
  return { span, logs, requestPath, responsePath };
}

const ingestTraces = (store: ReturnType<typeof fixture>['store'], span: ReturnType<typeof syntheticCall>['span']) =>
  acceptOtlpTraces(store, decodeTracesBody(tracesProtobuf([
    { resource: { service: 'claude-code' }, spans: [span] },
  ]), 'protobuf'), NOW, SALT);

test('traces 先到、logs 后到：双指针齐后接线，body_state 转 available', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    const traces = ingestTraces(f.store, call.span);
    expect(traces.requestsCreated).toBe(1);
    const logs = acceptOtlpLogs(f.store, call.logs(), NOW + 1000, SALT);
    expect(logs).toEqual({ records: 2, duplicates: 0, bodyEvents: 2, bodiesWired: 1 });
    const row = f.store.read.query<{ body_state: string; parse_state: string | null; reply_state: string | null; miss_reason: string | null; msg_count: number | null }, []>(
      'SELECT body_state, parse_state, reply_state, miss_reason, msg_count FROM request').get()!;
    expect(row.body_state).toBe('available');
    expect(row.parse_state).toBe('ok');
    expect(row.msg_count).toBe(1);
    expect(row.miss_reason).toBeNull();
    const ref = f.store.read.query<{ state: string; req_id: number; message_id: string | null }, []>(
      'SELECT state, req_id, message_id FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('wired');
    expect(ref.message_id).toBe('msg_synth_0001');
    // 正文进了块库：一条 user 消息块。
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM request_block').get() as { n: number }).n).toBe(1);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs 先到、traces 后到：pending_span 由 span 行落库时回接', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    const first = acceptOtlpLogs(f.store, call.logs(), NOW, SALT);
    expect(first.bodiesWired).toBe(0);
    let ref = f.store.read.query<{ state: string; req_id: number | null }, []>(
      'SELECT state, req_id FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('pending_span');
    expect(ref.req_id).toBeNull();
    const traces = ingestTraces(f.store, call.span);
    expect(traces.bodiesWired).toBe(1);
    ref = f.store.read.query<{ state: string; req_id: number | null }, []>(
      'SELECT state, req_id FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('wired');
    expect(ref.req_id).not.toBeNull();
    expect((f.store.read.query(
      "SELECT body_state FROM request WHERE body_state='available'").get() as { body_state: string } | null)
      ?.body_state).toBe('available');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一 logs 批次重发：记录判重，接线不重复', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    ingestTraces(f.store, call.span);
    const first = acceptOtlpLogs(f.store, call.logs(), NOW, SALT);
    const second = acceptOtlpLogs(f.store, call.logs(), NOW + 1000, SALT);
    expect(first.bodiesWired).toBe(1);
    expect(second).toEqual({ records: 2, duplicates: 2, bodyEvents: 2, bodiesWired: 0 });
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_log').get() as { n: number }).n).toBe(2);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('response 文件缺失：read_failed，行保持 summary 并记缺失原因', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    rmSync(call.responsePath);
    ingestTraces(f.store, call.span);
    const logs = acceptOtlpLogs(f.store, call.logs(), NOW, SALT);
    expect(logs.bodiesWired).toBe(0);
    const row = f.store.read.query<{ body_state: string; miss_reason: string | null }, []>(
      'SELECT body_state, miss_reason FROM request').get()!;
    expect(row.body_state).toBe('summary');
    expect(row.miss_reason).toBe('body_ref_read_failed');
    const ref = f.store.read.query<{ state: string; detail: string | null }, []>(
      'SELECT state, detail FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('read_failed');
    expect(ref.detail).toContain('not_found');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('指针指向符号链接拒绝读取：按 not_regular 记失败', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    const linked = join(dir, 'linked.response.json');
    symlinkSync(call.responsePath, linked);
    ingestTraces(f.store, call.span);
    acceptOtlpLogs(f.store, call.logs(undefined, linked), NOW, SALT);
    const ref = f.store.read.query<{ state: string; detail: string | null }, []>(
      'SELECT state, detail FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('read_failed');
    expect(ref.detail).toContain('not_regular');
    expect((f.store.read.query(
      "SELECT body_state FROM request").get() as { body_state: string }).body_state).toBe('summary');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一 trace 多个 llm_request span：attempt 不猜，记 span_ambiguous', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    const secondSpan = { ...call.span, spanId: SYNTH.spanTool };
    acceptOtlpTraces(f.store, decodeTracesBody(tracesProtobuf([
      { resource: { service: 'claude-code' }, spans: [call.span, secondSpan] },
    ]), 'protobuf'), NOW, SALT);
    const logs = acceptOtlpLogs(f.store, call.logs(), NOW, SALT);
    expect(logs.bodiesWired).toBe(0);
    const ref = f.store.read.query<{ state: string; detail: string | null }, []>(
      'SELECT state, detail FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('span_ambiguous');
    expect(ref.detail).toBe('candidates=2');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('80% 档停正文：指针保留、状态记 metadata_only，行保持 summary', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    ingestTraces(f.store, call.span);
    const logs = acceptOtlpLogs(f.store, call.logs(), NOW, SALT, {
      admission: () => ({ mode: 'metadata_only', reason: 'disk_80' }),
    });
    expect(logs.bodiesWired).toBe(0);
    const ref = f.store.read.query<{ state: string; detail: string | null; request_ref: string | null }, []>(
      'SELECT state, detail, request_ref FROM otlp_body_ref').get()!;
    expect(ref.state).toBe('metadata_only');
    expect(ref.detail).toBe('disk_80');
    expect(ref.request_ref).not.toBeNull();
    expect((f.store.read.query('SELECT body_state FROM request').get() as { body_state: string }).body_state).toBe('summary');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('暂停档 logs 整批拒绝；OMP run 级记录只落原始层', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'atc-otlp-body-'));
  try {
    const call = syntheticCall(dir);
    expect(() => acceptOtlpLogs(f.store, call.logs(), NOW, SALT, {
      admission: () => ({ mode: 'paused', reason: 'disk_95' }),
    })).toThrow('disk_full');
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_log').get() as { n: number }).n).toBe(0);

    const ompLogs = decodeLogsBody(logsProtobuf([{ resource: { service: 'oh-my-pi' }, records: [
      { timeNano: SYNTH.msToNano(1), severityNumber: 13, severityText: 'WARN',
        body: 'model discovery failed for provider', eventName: 'omp.log' },
    ] }]), 'protobuf');
    const result = acceptOtlpLogs(f.store, ompLogs, NOW, SALT);
    expect(result).toEqual({ records: 1, duplicates: 0, bodyEvents: 0, bodiesWired: 0 });
    const raw = f.store.read.query<{ body: string; service: string | null }, []>(
      'SELECT body, service FROM raw_otlp_log').get()!;
    expect(raw.body).toBe('model discovery failed for provider');
    expect(raw.service).toBe('oh-my-pi');
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
