/**
 * OTLP/HTTP 载荷解码：protobuf wire 走读 + OTLP/JSON 归一。
 *
 * 范围刻意收窄（见提案 note）：不建完整消息树、不校验未知字段，只把
 * traces 与 logs 两种 ExportRequest 解成映射层要用的平面形状。
 * wire 格式只出现 varint 与 length-delimited 两种编码（fixed64/32 也读，
 * 时间戳用它），其余 wire type 直接判非法——OTLP 不产 group 编码。
 *
 * JSON 与 protobuf 归一到同一形状：traceId/spanId 统一为原始字节
 * （JSON 侧是十六进制串），键名差异（camelCase）在 JSON 侧吸收。
 */

export class OtlpDecodeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** AnyValue 归一后的值域；bytes 用带标记的对象承载，避免与真字符串混淆。 */
export type OtlpAttrValue =
  | string | number | boolean | null
  | { $bytes: string }
  | OtlpAttrValue[]
  | { [key: string]: OtlpAttrValue | undefined };
export type OtlpAttrs = Record<string, OtlpAttrValue | undefined>;

export type OtlpSpan = {
  traceId: Uint8Array;
  spanId: Uint8Array;
  name: string;
  kind: number;
  startNano: bigint;
  endNano: bigint | null;
  attrs: OtlpAttrs;
  statusCode: number | null;
};

export type OtlpScopePayload<T> = {
  service: string | null;
  resourceAttrs: OtlpAttrs;
  scopeName: string | null;
  items: T[];
};

export type OtlpLogRecord = {
  timeNano: bigint | null;
  severityNumber: number | null;
  severityText: string | null;
  eventName: string | null;
  body: string | null;
  attrs: OtlpAttrs;
  traceId: Uint8Array | null;
  spanId: Uint8Array | null;
};

export type OtlpTracesPayload = { resourceSpans: OtlpScopePayload<OtlpSpan>[] };
export type OtlpLogsPayload = { resourceLogs: OtlpScopePayload<OtlpLogRecord>[] };

// —— wire 读取层 ——————————————————————————————————————————————

const MAX_DEPTH = 32;

type WireField =
  | { wt: 0; no: number; varint: bigint }
  | { wt: 1; no: number; fixed64: bigint; bytes: Uint8Array }
  | { wt: 5; no: number; fixed32: number }
  | { wt: 2; no: number; bytes: Uint8Array };

class Cursor {
  constructor(public buf: Uint8Array, public pos: number) {}
  get remaining(): number { return this.buf.length - this.pos; }
  byte(): number {
    if (this.pos >= this.buf.length) throw new OtlpDecodeError('otlp_wire_truncated');
    return this.buf[this.pos++]!;
  }
  take(count: number): Uint8Array {
    if (count < 0 || this.remaining < count) throw new OtlpDecodeError('otlp_wire_truncated');
    const seg = this.buf.subarray(this.pos, this.pos + count);
    this.pos += count;
    return seg;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new OtlpDecodeError('otlp_wire_varint');
    }
  }
  fixed64(): { value: bigint; bytes: Uint8Array } {
    const seg = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(seg[i]!);
    return { value, bytes: seg };
  }
  fixed32(): number {
    const seg = this.take(4);
    let value = 0;
    for (let i = 3; i >= 0; i--) value = value * 256 + seg[i]!;
    return value;
  }
}

/** 走读一条消息的字段序列；wire type 3/4（group）在 OTLP 里非法。 */
function readFields(buf: Uint8Array): WireField[] {
  const cursor = new Cursor(buf, 0);
  const fields: WireField[] = [];
  while (cursor.remaining > 0) {
    const tag = cursor.varint();
    const no = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (no === 0) throw new OtlpDecodeError('otlp_wire_field_number');
    if (wt === 0) fields.push({ wt, no, varint: cursor.varint() });
    else if (wt === 1) {
      const fixed = cursor.fixed64();
      fields.push({ wt, no, fixed64: fixed.value, bytes: fixed.bytes });
    }
    else if (wt === 5) fields.push({ wt, no, fixed32: cursor.fixed32() });
    else if (wt === 2) {
      const len = Number(cursor.varint());
      fields.push({ wt, no, bytes: cursor.take(len) });
    } else throw new OtlpDecodeError('otlp_wire_type');
  }
  return fields;
}

function nested(field: WireField | undefined, depth: number): WireField[] {
  if (field === undefined || field.wt !== 2) return [];
  if (depth > MAX_DEPTH) throw new OtlpDecodeError('otlp_wire_depth');
  return readFields(field.bytes);
}

function strField(fields: WireField[], no: number): string | null {
  const field = fields.find(f => f.no === no);
  return field !== undefined && field.wt === 2 ? Buffer.from(field.bytes).toString('utf8') : null;
}

function varintField(fields: WireField[], no: number): bigint | null {
  const field = fields.find(f => f.no === no);
  return field !== undefined && field.wt === 0 ? field.varint : null;
}

/** 按 (字段号, wire 类型) 取子消息/字节；类型不符按缺失处理。 */
function bytesOf(fields: WireField[], no: number): Uint8Array | null {
  const field = fields.find(f => f.no === no);
  return field !== undefined && field.wt === 2 ? field.bytes : null;
}

function fixed64Of(fields: WireField[], no: number): bigint | null {
  const field = fields.find(f => f.no === no);
  return field !== undefined && field.wt === 1 ? field.fixed64 : null;
}

// ——— AnyValue / KeyValue ———————————————————————————————————

/** varint 转 JSON 安全数：超 2^53 的整数保留十进制字符串，不假装精度还在。 */
function safeInt(value: bigint): number | string {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value.toString();
}

function decodeAny(field: WireField | undefined, depth: number): OtlpAttrValue | undefined {
  if (field === undefined) return undefined;
  if (field.wt !== 2) throw new OtlpDecodeError('otlp_wire_anyvalue');
  const fields = nested(field, depth);
  if (fields.length !== 1) throw new OtlpDecodeError('otlp_wire_anyvalue');
  const inner = fields[0]!;
  switch (inner.no) {
    case 1: return inner.wt === 2 ? Buffer.from(inner.bytes).toString('utf8') : undefined;
    case 2: return inner.wt === 0 ? inner.varint !== 0n : undefined;
    case 3: return inner.wt === 0 ? safeInt(inner.varint) : undefined;
    case 4: {
      // double_value 是 wire type 1 的裸 8 字节 IEEE-754，不是 length-delimited。
      if (inner.wt !== 1) return undefined;
      return Buffer.from(inner.bytes).readDoubleLE(0);
    }
    case 5: {
      // ArrayValue { repeated AnyValue values = 1; }
      const values = nested(inner, depth + 1).filter(f => f.no === 1)
        .map(f => decodeAny(f, depth + 2));
      // 空值以 null 保位：数组位置是事实，缺值不是塌缩的理由。
      return values.map(value => value ?? null);
    }
    case 6: {
      // KeyValueList { repeated KeyValue values = 1; }
      const out: Record<string, OtlpAttrValue | undefined> = {};
      for (const kv of nested(inner, depth + 1).filter(f => f.no === 1)) {
        decodeKeyValueInto(kv, out, depth + 2);
      }
      return out;
    }
    case 7: return { $bytes: Buffer.from(inner.wt === 2 ? inner.bytes : new Uint8Array(0)).toString('base64') };
    default: return undefined;
  }
}

function decodeKeyValueInto(field: WireField, out: Record<string, OtlpAttrValue | undefined>, depth: number): void {
  if (field.wt !== 2) throw new OtlpDecodeError('otlp_wire_keyvalue');
  const fields = nested(field, depth);
  const key = strField(fields, 1);
  if (key === null || key.length === 0) throw new OtlpDecodeError('otlp_wire_keyvalue');
  out[key] = decodeAny(fields.find(f => f.no === 2), depth + 1);
}

function decodeAttrs(fields: WireField[], no: number, depth: number): OtlpAttrs {
  const attrs: OtlpAttrs = {};
  for (const field of fields.filter(f => f.no === no)) decodeKeyValueInto(field, attrs, depth);
  return attrs;
}

// ——— traces / logs 的 protobuf 路径 ——————————————————————————

// Scope 消息（InstrumentationScope）里的 name = field 1。
function scopeNameOf(scope: WireField[], depth: number): string | null {
  const field = scope.find(f => f.no === 1 && f.wt === 2);
  if (field === undefined) return null;
  return strField(nested(field, depth), 1);
}

function decodeScopeShared(msg: WireField[], depth: number): {
  resource: WireField[]; scopes: WireField[][];
} {
  const resourceField = msg.find(f => f.no === 1);
  const resource = resourceField !== undefined && resourceField.wt === 2 ? nested(resourceField, depth) : [];
  const scopes = msg.filter(f => f.no === 2 && f.wt === 2).map(f => nested(f, depth));
  return { resource, scopes };
}

function decodeSpan(field: WireField, depth: number): OtlpSpan {
  const fields = nested(field, depth);
  const traceId = bytesOf(fields, 1);
  const spanId = bytesOf(fields, 2);
  const name = strField(fields, 5);
  const start = fixed64Of(fields, 7);
  if (traceId === null || spanId === null || name === null || start === null) {
    throw new OtlpDecodeError('otlp_span_identity');
  }
  const end = fixed64Of(fields, 8);
  const statusField = fields.find(f => f.no === 15 && f.wt === 2);
  const statusCode = statusField === undefined
    ? null
    : Number(varintField(nested(statusField, depth + 1), 1) ?? 0n);
  return {
    traceId, spanId, name,
    kind: Number(varintField(fields, 6) ?? 0n),
    startNano: start,
    endNano: end,
    attrs: decodeAttrs(fields, 9, depth + 1),
    statusCode,
  };
}

export function decodeTracesProtobuf(buf: Uint8Array): OtlpTracesPayload {
  const resourceSpans: OtlpScopePayload<OtlpSpan>[] = [];
  for (const rs of readFields(buf).filter(f => f.no === 1 && f.wt === 2)) {
    const { resource, scopes } = decodeScopeShared(nested(rs, 1), 2);
    for (const scope of scopes) {
      resourceSpans.push({
        service: decodeAttrs(resource, 1, 3)['service.name'] as string | null ?? null,
        resourceAttrs: decodeAttrs(resource, 1, 3),
        scopeName: scopeNameOf(scope, 3),
        items: scope.filter(f => f.no === 2 && f.wt === 2).map(f => decodeSpan(f, 3)),
      });
    }
  }
  return { resourceSpans };
}

function decodeLogRecord(field: WireField, depth: number): OtlpLogRecord {
  const fields = nested(field, depth);
  const traceId = bytesOf(fields, 9);
  const spanId = bytesOf(fields, 10);
  const bodyField = fields.find(f => f.no === 5);
  const bodyValue = bodyField === undefined ? undefined : decodeAny(bodyField, depth + 1);
  if (bodyValue !== undefined && typeof bodyValue !== 'string') {
    throw new OtlpDecodeError('otlp_log_body');
  }
  return {
    timeNano: fixed64Of(fields, 1),
    severityNumber: varintField(fields, 2) === null ? null : Number(varintField(fields, 2)),
    severityText: strField(fields, 3),
    eventName: strField(fields, 12),
    body: bodyValue ?? null,
    attrs: decodeAttrs(fields, 6, depth + 1),
    traceId, spanId,
  };
}

export function decodeLogsProtobuf(buf: Uint8Array): OtlpLogsPayload {
  const resourceLogs: OtlpScopePayload<OtlpLogRecord>[] = [];
  for (const rl of readFields(buf).filter(f => f.no === 1 && f.wt === 2)) {
    const { resource, scopes } = decodeScopeShared(nested(rl, 1), 2);
    for (const scope of scopes) {
      resourceLogs.push({
        service: decodeAttrs(resource, 1, 3)['service.name'] as string | null ?? null,
        resourceAttrs: decodeAttrs(resource, 1, 3),
        scopeName: scopeNameOf(scope, 3),
        items: scope.filter(f => f.no === 2 && f.wt === 2).map(f => decodeLogRecord(f, 3)),
      });
    }
  }
  return { resourceLogs };
}

// ——— OTLP/JSON 路径 ————————————————————————————————————————

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonAny(value: unknown): OtlpAttrValue | undefined {
  if (!isRecord(value)) return undefined;
  if ('stringValue' in value) return typeof value.stringValue === 'string' ? value.stringValue : undefined;
  if ('boolValue' in value) return typeof value.boolValue === 'boolean' ? value.boolValue : undefined;
  if ('intValue' in value) {
    if (typeof value.intValue === 'number' && Number.isSafeInteger(value.intValue)) return value.intValue;
    if (typeof value.intValue === 'string' && /^-?\d+$/.test(value.intValue)) return safeInt(BigInt(value.intValue));
    return undefined;
  }
  if ('doubleValue' in value) return typeof value.doubleValue === 'number' ? value.doubleValue : undefined;
  if ('arrayValue' in value && isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(item => jsonAny(item) ?? null);
  }
  if ('kvlistValue' in value && isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
    const out: Record<string, OtlpAttrValue | undefined> = {};
    for (const item of value.kvlistValue.values) if (isRecord(item)) jsonKeyValueInto(item, out);
    return out;
  }
  if ('bytesValue' in value) {
    return typeof value.bytesValue === 'string' ? { $bytes: value.bytesValue } : undefined;
  }
  return undefined;
}

function jsonKeyValueInto(item: Record<string, unknown>, out: Record<string, OtlpAttrValue | undefined>): void {
  const key = item.key;
  if (typeof key !== 'string' || key.length === 0) throw new OtlpDecodeError('otlp_json_keyvalue');
  out[key] = jsonAny(item.value);
}

function jsonAttrs(value: unknown): OtlpAttrs {
  const attrs: OtlpAttrs = {};
  if (value === undefined || value === null) return attrs;
  if (!Array.isArray(value)) throw new OtlpDecodeError('otlp_json_attributes');
  for (const item of value) {
    if (!isRecord(item)) throw new OtlpDecodeError('otlp_json_attributes');
    jsonKeyValueInto(item, attrs);
  }
  return attrs;
}

/** JSON 的 traceId/spanId 是十六进制串；归一到与 protobuf 相同的原始字节。 */
function jsonId(value: unknown, what: string): Uint8Array | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new OtlpDecodeError(`otlp_json_${what}`);
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function jsonNano(value: unknown, what: string): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new OtlpDecodeError(`otlp_json_${what}`);
  return BigInt(value);
}

function jsonScopes<T>(envelope: Record<string, unknown>, resourceKey: string, scopeKey: string,
  mapScope: (resource: Record<string, unknown> | null, scope: Record<string, unknown>) => OtlpScopePayload<T> | null,
): OtlpScopePayload<T>[] {
  const groups = envelope[resourceKey];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new OtlpDecodeError('otlp_json_envelope');
  const out: OtlpScopePayload<T>[] = [];
  for (const group of groups) {
    if (!isRecord(group)) throw new OtlpDecodeError('otlp_json_envelope');
    const resource = isRecord(group.resource) ? group.resource : null;
    const scopes = group[scopeKey];
    if (scopes === undefined) continue;
    if (!Array.isArray(scopes)) throw new OtlpDecodeError('otlp_json_envelope');
    for (const scope of scopes) {
      if (!isRecord(scope)) throw new OtlpDecodeError('otlp_json_envelope');
      const mapped = mapScope(resource, scope);
      if (mapped !== null) out.push(mapped);
    }
  }
  return out;
}

function resourceService(resource: Record<string, unknown> | null): { service: string | null; attrs: OtlpAttrs } {
  const attrs = jsonAttrs(resource?.attributes);
  const service = attrs['service.name'];
  return { service: typeof service === 'string' ? service : null, attrs };
}

export function parseTracesJson(value: unknown): OtlpTracesPayload {
  if (!isRecord(value)) throw new OtlpDecodeError('otlp_json_invalid');
  const resourceSpans = jsonScopes(value, 'resourceSpans', 'scopeSpans', (resource, scope) => {
    const spans = scope.spans;
    if (spans === undefined) return null;
    if (!Array.isArray(spans)) throw new OtlpDecodeError('otlp_json_spans');
    const { service, attrs } = resourceService(resource);
    return {
      service,
      resourceAttrs: attrs,
      scopeName: isRecord(scope.scope) && typeof scope.scope.name === 'string' ? scope.scope.name : null,
      items: spans.map((span): OtlpSpan => {
        if (!isRecord(span)) throw new OtlpDecodeError('otlp_json_span');
        const traceId = jsonId(span.traceId, 'trace_id');
        const spanId = jsonId(span.spanId, 'span_id');
        const name = span.name;
        const start = jsonNano(span.startTimeUnixNano, 'start_time');
        if (traceId === null || spanId === null || typeof name !== 'string' || start === null) {
          throw new OtlpDecodeError('otlp_span_identity');
        }
        const statusCode = isRecord(span.status) && typeof span.status.code === 'number' ? span.status.code : null;
        return {
          traceId, spanId, name,
          kind: typeof span.kind === 'number' ? span.kind : 0,
          startNano: start,
          endNano: jsonNano(span.endTimeUnixNano, 'end_time'),
          attrs: jsonAttrs(span.attributes),
          statusCode,
        };
      }),
    };
  });
  return { resourceSpans };
}

export function parseLogsJson(value: unknown): OtlpLogsPayload {
  if (!isRecord(value)) throw new OtlpDecodeError('otlp_json_invalid');
  const resourceLogs = jsonScopes(value, 'resourceLogs', 'scopeLogs', (resource, scope) => {
    const records = scope.logRecords;
    if (records === undefined) return null;
    if (!Array.isArray(records)) throw new OtlpDecodeError('otlp_json_log_records');
    const { service, attrs } = resourceService(resource);
    return {
      service,
      resourceAttrs: attrs,
      scopeName: isRecord(scope.scope) && typeof scope.scope.name === 'string' ? scope.scope.name : null,
      items: records.map((record): OtlpLogRecord => {
        if (!isRecord(record)) throw new OtlpDecodeError('otlp_json_log_record');
        const bodyValue = record.body === undefined ? undefined : jsonAny(record.body);
        if (bodyValue !== undefined && bodyValue !== null && typeof bodyValue !== 'string') {
          throw new OtlpDecodeError('otlp_log_body');
        }
        const severity = record.severityNumber;
        return {
          timeNano: jsonNano(record.timeUnixNano, 'time'),
          severityNumber: typeof severity === 'number' ? severity : null,
          severityText: typeof record.severityText === 'string' ? record.severityText : null,
          eventName: typeof record.eventName === 'string' ? record.eventName : null,
          body: bodyValue ?? null,
          attrs: jsonAttrs(record.attributes),
          traceId: jsonId(record.traceId, 'trace_id'),
          spanId: jsonId(record.spanId, 'span_id'),
        };
      }),
    };
  });
  return { resourceLogs };
}

/** content-type 分派：protobuf 走 wire 解码，json 先 JSON.parse 再归一。 */
export function decodeTracesBody(body: Uint8Array, kind: 'protobuf' | 'json'): OtlpTracesPayload {
  if (kind === 'protobuf') return decodeTracesProtobuf(body);
  try {
    return parseTracesJson(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch (error) {
    if (error instanceof OtlpDecodeError) throw error;
    throw new OtlpDecodeError('otlp_json_invalid');
  }
}

export function decodeLogsBody(body: Uint8Array, kind: 'protobuf' | 'json'): OtlpLogsPayload {
  if (kind === 'protobuf') return decodeLogsProtobuf(body);
  try {
    return parseLogsJson(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch (error) {
    if (error instanceof OtlpDecodeError) throw error;
    throw new OtlpDecodeError('otlp_json_invalid');
  }
}

/** 时间戳纳秒 → 毫秒；只在这里做除法，入库列全部是毫秒。 */
export function nanoToMs(nano: bigint): number {
  return Number(nano / 1_000_000n);
}

/** 身份键的十六进制展示：ref_key、日志与排错都用这一种拼写。 */
export function idHex(id: Uint8Array): string {
  return Buffer.from(id).toString('hex');
}
