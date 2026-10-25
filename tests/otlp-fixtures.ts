/**
 * OTLP 测试夹具：手写 protobuf 编码器 + 两个 harness 形状的合成载荷构造器。
 *
 * 只产合成数据：会话 id、span id、响应 id 都是本文件自造的值，
 * 不引用任何真实抓样内容。protobuf 编码器只实现 wire 需要的子集
 * （varint、fixed64、length-delimited），与生产解码器互为镜像。
 */

export function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

export function tag(no: number, wt: 0 | 1 | 2 | 5): number[] {
  return varint(BigInt(no) << 3n | BigInt(wt));
}

export function lenDelim(no: number, payload: number[] | Uint8Array | string): number[] {
  const bytes = typeof payload === 'string' ? [...Buffer.from(payload, 'utf8')] : [...payload];
  return [...tag(no, 2), ...varint(bytes.length), ...bytes];
}

export function fixed64Field(no: number, value: bigint): number[] {
  const out = [...tag(no, 1)];
  let v = value;
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

export function varintField(no: number, value: number | bigint): number[] {
  return [...tag(no, 0), ...varint(value)];
}

// ——— AnyValue / KeyValue ———————————————————————————————————

export type FixtureAttrValue =
  | string | number | boolean | bigint
  | { str: string } | { int: number | bigint } | { dbl: number } | { bool: boolean }
  | { arr: FixtureAttrValue[] } | { kv: Record<string, FixtureAttrValue> };

function encodeAnyValue(value: FixtureAttrValue): number[] {
  // AnyValue 的标量字段不是 length-delimited：bool/int 是 varint，double 是裸 fixed64。
  if (typeof value === 'string') return lenDelim(1, value);
  if (typeof value === 'boolean') return varintField(2, value ? 1 : 0);
  if (typeof value === 'bigint') return varintField(3, value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(value, 0);
      return [...tag(4, 1), ...new Uint8Array(buf)];
    }
    return varintField(3, value);
  }
  if ('str' in value) return lenDelim(1, value.str);
  if ('int' in value) return varintField(3, value.int);
  if ('bool' in value) return varintField(2, value.bool ? 1 : 0);
  if ('dbl' in value) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value.dbl, 0);
    return [...tag(4, 1), ...new Uint8Array(buf)];
  }
  if ('arr' in value) {
    return lenDelim(5, value.arr.flatMap(item => lenDelim(1, encodeAnyValue(item))));
  }
  return lenDelim(6, Object.entries(value.kv).flatMap(([key, item]) => encodeKeyValue(key, item)));
}

/** 无标签的 KeyValue 消息体；各消息类型按自己的字段号现场包 tag。 */
export function keyValueMsg(key: string, value: FixtureAttrValue): number[] {
  return [...lenDelim(1, key), ...lenDelim(2, encodeAnyValue(value))];
}

export function encodeKeyValue(key: string, value: FixtureAttrValue, fieldNo = 1): number[] {
  return lenDelim(fieldNo, keyValueMsg(key, value));
}

// ——— traces 载荷 ———————————————————————————————————————————

export type FixtureSpan = {
  traceId: Uint8Array;
  spanId: Uint8Array;
  name: string;
  kind?: number;
  startNano: bigint;
  endNano?: bigint;
  attrs?: Record<string, FixtureAttrValue>;
  statusCode?: number;
};

function encodeSpan(span: FixtureSpan): number[] {
  // span 属性是 field 9 的 repeated KeyValue。
  const attrs = Object.entries(span.attrs ?? {}).flatMap(([key, value]) => encodeKeyValue(key, value, 9));
  const status = span.statusCode === undefined ? [] : lenDelim(15, varintField(1, span.statusCode));
  return [
    ...lenDelim(1, span.traceId),
    ...lenDelim(2, span.spanId),
    ...lenDelim(5, span.name),
    ...(span.kind !== undefined ? varintField(6, span.kind) : []),
    ...(span.startNano !== undefined ? fixed64Field(7, span.startNano) : []),
    ...(span.endNano !== undefined ? fixed64Field(8, span.endNano) : []),
    ...attrs,
    ...status,
  ];
}

export type FixtureResource = { service: string; attrs?: Record<string, FixtureAttrValue> };

export function tracesProtobuf(
  resources: { resource: FixtureResource; spans: FixtureSpan[] }[],
): Uint8Array {
  const body = resources.flatMap(({ resource, spans }) => {
    const resourceAttrs = Object.entries({ 'service.name': resource.service, ...(resource.attrs ?? {}) })
      .flatMap(([key, value]) => encodeKeyValue(key, value));
    return lenDelim(1, [
      ...lenDelim(1, resourceAttrs),
      // ScopeSpans 消息体就是 repeated span 字段，不再包一层。
      ...lenDelim(2, spans.flatMap(span => lenDelim(2, encodeSpan(span)))),
    ]);
  });
  // 顶层是 repeated ResourceSpans：每份各自 field 1，不再整体包一层消息。
  return new Uint8Array(body);
}

// ——— logs 载荷 ————————————————————————————————————————————

export type FixtureLogRecord = {
  timeNano?: bigint;
  severityNumber?: number;
  severityText?: string;
  eventName?: string;
  body?: string;
  attrs?: Record<string, FixtureAttrValue>;
  traceId?: Uint8Array;
  spanId?: Uint8Array;
};

export function logsProtobuf(
  resources: { resource: FixtureResource; records: FixtureLogRecord[] }[],
): Uint8Array {
  const body = resources.flatMap(({ resource, records }) => {
    const resourceAttrs = Object.entries({ 'service.name': resource.service, ...(resource.attrs ?? {}) })
      .flatMap(([key, value]) => encodeKeyValue(key, value));
    const encoded = records.flatMap(record => {
      // log record 属性是 field 6 的 repeated KeyValue。
      const attrs = Object.entries(record.attrs ?? {}).flatMap(([key, value]) => encodeKeyValue(key, value, 6));
      return lenDelim(2, [
        ...(record.timeNano !== undefined ? fixed64Field(1, record.timeNano) : []),
        ...(record.severityNumber !== undefined ? varintField(2, record.severityNumber) : []),
        ...(record.severityText !== undefined ? lenDelim(3, record.severityText) : []),
        ...(record.body !== undefined ? lenDelim(5, lenDelim(1, record.body)) : []),
        ...attrs,
        ...(record.traceId !== undefined ? lenDelim(9, record.traceId) : []),
        ...(record.spanId !== undefined ? lenDelim(10, record.spanId) : []),
        ...(record.eventName !== undefined ? lenDelim(12, record.eventName) : []),
      ]);
    });
    return lenDelim(1, [...lenDelim(1, resourceAttrs), ...lenDelim(2, encoded)]);
  });
  return new Uint8Array(body);
}

// ——— JSON 载荷（与 protobuf 夹具同一批合成值） ——————————————————

export function jsonAttrValue(value: FixtureAttrValue): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (typeof value === 'bigint') return { intValue: value.toString() };
  if ('str' in value) return { stringValue: value.str };
  if ('int' in value) return { intValue: Number(value.int) };
  if ('bool' in value) return { boolValue: value.bool };
  if ('dbl' in value) return { doubleValue: value.dbl };
  if ('arr' in value) return { arrayValue: { values: value.arr.map(jsonAttrValue) } };
  return { kvlistValue: { values: Object.entries(value.kv).map(([key, item]) => ({ key, value: jsonAttrValue(item) })) } };
}

export function tracesJson(resources: { resource: FixtureResource; spans: FixtureSpan[] }[]): unknown {
  return {
    resourceSpans: resources.map(({ resource, spans }) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: resource.service } },
          ...Object.entries(resource.attrs ?? {}).map(([key, value]) => ({ key, value: jsonAttrValue(value) })),
        ],
      },
      scopeSpans: [{
        spans: spans.map(span => ({
          traceId: Buffer.from(span.traceId).toString('hex'),
          spanId: Buffer.from(span.spanId).toString('hex'),
          name: span.name,
          ...(span.kind !== undefined ? { kind: span.kind } : {}),
          startTimeUnixNano: span.startNano.toString(),
          ...(span.endNano !== undefined ? { endTimeUnixNano: span.endNano.toString() } : {}),
          attributes: Object.entries(span.attrs ?? {}).map(([key, value]) => ({ key, value: jsonAttrValue(value) })),
          ...(span.statusCode !== undefined ? { status: { code: span.statusCode } } : {}),
        })),
      }],
    })),
  };
}

export function logsJson(resources: { resource: FixtureResource; records: FixtureLogRecord[] }[]): unknown {
  return {
    resourceLogs: resources.map(({ resource, records }) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: resource.service } },
          ...Object.entries(resource.attrs ?? {}).map(([key, value]) => ({ key, value: jsonAttrValue(value) })),
        ],
      },
      scopeLogs: [{
        logRecords: records.map(record => ({
          ...(record.timeNano !== undefined ? { timeUnixNano: record.timeNano.toString() } : {}),
          ...(record.severityNumber !== undefined ? { severityNumber: record.severityNumber } : {}),
          ...(record.severityText !== undefined ? { severityText: record.severityText } : {}),
          ...(record.body !== undefined ? { body: { stringValue: record.body } } : {}),
          attributes: Object.entries(record.attrs ?? {}).map(([key, value]) => ({ key, value: jsonAttrValue(value) })),
          ...(record.traceId !== undefined ? { traceId: Buffer.from(record.traceId).toString('hex') } : {}),
          ...(record.spanId !== undefined ? { spanId: Buffer.from(record.spanId).toString('hex') } : {}),
          ...(record.eventName !== undefined ? { eventName: record.eventName } : {}),
        })),
      }],
    })),
  };
}

/** 常用合成值：与真实抓样同形状、不同值。 */
export const SYNTH = {
  traceA: new Uint8Array(Buffer.from('10a4b7c2d5e8f3a91b6c0d2e4f5a6b7c', 'hex')),
  traceB: new Uint8Array(Buffer.from('ff00ee11dd22cc33bb44aa5569778899', 'hex')),
  spanLLM: new Uint8Array(Buffer.from('0102030405060708', 'hex')),
  spanInteraction: new Uint8Array(Buffer.from('0a0b0c0d0e0f0102', 'hex')),
  spanTool: new Uint8Array(Buffer.from('f0e0d0c0b0a09080', 'hex')),
  session: '5f6e7a8b-9c0d-4e1f-8a2b-3c4d5e6f7081',
  responseId: 'chatcmpl-synth-0001abcdef0123456789',
  msToNano: (ms: number): bigint => BigInt(ms) * 1_000_000n,
};
