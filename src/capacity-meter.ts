import type { Database } from 'bun:sqlite';

/**
 * 四张来源表的逻辑载荷计数。
 *
 * 在线路径只读这几个整数；全表求和只属于迁移初始化与显式对账。计数与来源行
 * 在同一个事务里由触发器维护，回滚一起回滚，不允许应用层各自加减。
 *
 * 计量口径（必须与 schema-v14.sql 的触发器逐字一致）：
 * - BLOB 用 `length()`；TEXT 先 `CAST(... AS BLOB)` 取 UTF-8 字节，不用字符数；
 * - 可空列各自 `IFNULL` 后再相加，不把一侧 NULL 当成另一侧也不存在；
 * - `block` 一行代表一个共享块，只计一次；`request` 行数表示请求行数。
 */

export const CAPACITY_METER_VERSION = 1;
export const CAPACITY_METER_STATE_KEY = 'capacity.meter';

export const CAPACITY_SOURCES = ['block', 'request', 'raw_hook', 'raw_session_event'] as const;
export type CapacitySource = typeof CAPACITY_SOURCES[number];

export const CAPACITY_METER_TRIGGERS = CAPACITY_SOURCES.flatMap(source =>
  ['insert', 'update', 'delete'].map(event => `capacity_meter_${source}_${event}`));

type SourceStats = { bytes: number; row_count: number };

export type CapacityMeterReading = {
  version: number;
  source_count: number;
  body_bytes: number;
  sources: Record<CapacitySource, SourceStats>;
};

export type CapacityMeterStatus = ({ ok: true } & CapacityMeterReading) | { ok: false; error: string };

export type CapacitySourceDrift = {
  source: CapacitySource;
  meter_bytes: number; exact_bytes: number;
  meter_rows: number; exact_rows: number;
  byte_delta: number; row_delta: number;
};

export type CapacityMeterCheck = {
  ok: boolean;
  error: string | null;
  version: number | null;
  sources: CapacitySourceDrift[];
};

/** 精确口径；只给迁移初始化与显式对账用，不是在线读取路径。 */
export const CAPACITY_EXACT_EXPRESSIONS: Record<CapacitySource, string> = {
  block: 'IFNULL(SUM(length(z)),0)',
  request: 'IFNULL(SUM(IFNULL(length(CAST(skeleton_z AS BLOB)),0)),0)',
  raw_hook: 'IFNULL(SUM(IFNULL(length(CAST(request_z AS BLOB)),0)'
    + ' + IFNULL(length(CAST(response_z AS BLOB)),0)),0)',
  raw_session_event: 'IFNULL(SUM(length(CAST(payload_json AS BLOB))),0)',
};

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  // SQLite 的缺表报错带自由文本；转成固定码，报告里不出现原始错误。
  if (message.includes('no such table') && message.includes('capacity_meter')) {
    return 'capacity_meter_missing';
  }
  const code = message.split(':', 1)[0] ?? '';
  return code.startsWith('capacity_meter_') ? code : 'capacity_meter_invalid';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 读计数并校验结构：来源必须恰好是四个、值必须是非负整数、版本必须匹配。
 *
 * 缺行、多行与坏值都抛固定错误码，不补零；调用方要么让服务拒绝启动，要么
 * 在报告里显式写出错误。
 */
export function readCapacityMeter(db: Database): CapacityMeterReading {
  let rows: { source: string; bytes: unknown; row_count: unknown }[];
  try {
    rows = db.query<{ source: string; bytes: unknown; row_count: unknown }, []>(
      'SELECT source, bytes, row_count FROM capacity_meter ORDER BY source',
    ).all();
  } catch (error) {
    throw new Error(errorCode(error));
  }
  const sources = {} as Record<CapacitySource, SourceStats>;
  for (const row of rows) {
    if (!(CAPACITY_SOURCES as readonly string[]).includes(row.source)) {
      throw new Error(`capacity_meter_unknown_source:${row.source}`);
    }
    const source = row.source as CapacitySource;
    if (source in sources) throw new Error(`capacity_meter_duplicate_source:${source}`);
    if (!isCount(row.bytes) || !isCount(row.row_count)) throw new Error(`capacity_meter_invalid:${source}`);
    sources[source] = { bytes: row.bytes, row_count: row.row_count };
  }
  for (const source of CAPACITY_SOURCES) {
    if (!(source in sources)) throw new Error(`capacity_meter_source_missing:${source}`);
  }
  const state = db.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(CAPACITY_METER_STATE_KEY);
  if (state == null) throw new Error('capacity_meter_version_missing');
  let version: unknown;
  try {
    version = (JSON.parse(state.value_json) as { version?: unknown }).version;
  } catch {
    throw new Error('capacity_meter_version_invalid');
  }
  if (!isCount(version)) throw new Error('capacity_meter_version_invalid');
  if (version !== CAPACITY_METER_VERSION) {
    throw new Error(`capacity_meter_version_unsupported:${version}`);
  }
  const bodyBytes = CAPACITY_SOURCES.reduce((sum, source) => sum + sources[source].bytes, 0);
  return { version, source_count: rows.length, body_bytes: bodyBytes, sources };
}

/** 只读总量：在线路径用这一句，不校验结构（openStore 启动时已经校验过）。 */
export function capacityMeterBodyBytes(db: Database): number {
  return db.query<{ n: number }, []>(
    'SELECT IFNULL(SUM(bytes),0) AS n FROM capacity_meter',
  ).get()?.n ?? 0;
}

/**
 * 正文淘汰实际能回收的逻辑载荷：共享块与请求骨架。
 *
 * `raw_hook` 与 `raw_session_event` 由各自的保留路径清理，淘汰正文不会释放它们；
 * 磁盘压力判断必须用这个上界，不能拿四源总量当成可回收量。
 */
export function capacityMeterEvictableBytes(db: Database): number {
  return db.query<{ n: number }, []>(
    "SELECT IFNULL(SUM(bytes),0) AS n FROM capacity_meter WHERE source IN ('block','request')",
  ).get()?.n ?? 0;
}

/** 报告用状态：缺表、缺来源、坏值与版本不符都按固定错误码返回，不抛错。 */
export function capacityMeterStatus(db: Database): CapacityMeterStatus {
  try {
    return { ok: true, ...readCapacityMeter(db) };
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
}

/** 启动校验：计数结构与触发器都必须在位；正常重启不重扫历史。 */
export function assertCapacityMeter(db: Database): void {
  readCapacityMeter(db);
  const present = new Set((db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'capacity_meter_%'",
  ).all()).map(row => row.name));
  for (const trigger of CAPACITY_METER_TRIGGERS) {
    if (!present.has(trigger)) throw new Error(`capacity_meter_trigger_missing:${trigger}`);
  }
}

/** 四个来源的全表求和与行数；迁移初始化与对账命令共用这一份口径。 */
export function exactCapacitySums(db: Database): Record<CapacitySource, { bytes: number; rows: number }> {
  const result = {} as Record<CapacitySource, { bytes: number; rows: number }>;
  for (const source of CAPACITY_SOURCES) {
    const row = db.query<{ bytes: number; row_count: number }, []>(
      `SELECT ${CAPACITY_EXACT_EXPRESSIONS[source]} AS bytes, COUNT(*) AS row_count FROM ${source}`,
    ).get();
    result[source] = { bytes: row?.bytes ?? 0, rows: row?.row_count ?? 0 };
  }
  return result;
}

/**
 * 迁移事务内的初始化：触发器已建好后写一份与源表一致的计数。
 * 已有计数时只做核对，不覆盖——半迁移或人为改过的库必须显式暴露。
 */
export function ensureCapacityMeter(db: Database): void {
  const existing = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM capacity_meter').get()?.n ?? 0;
  if (existing === 0) {
    const exact = exactCapacitySums(db);
    for (const source of CAPACITY_SOURCES) {
      db.run('INSERT INTO capacity_meter(source,bytes,row_count) VALUES (?,?,?)',
        [source, exact[source].bytes, exact[source].rows]);
    }
    db.run(
      `INSERT INTO collector_state(key,value_json) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
      [CAPACITY_METER_STATE_KEY, JSON.stringify({ version: CAPACITY_METER_VERSION })],
    );
  }
  const check = checkCapacityMeter(db);
  if (!check.ok) throw new Error(`capacity_meter_backfill_mismatch:${check.error ?? 'drift'}`);
}

/** 对账：计数与全表求和逐来源比较；默认只报告差异。 */
export function checkCapacityMeter(db: Database): CapacityMeterCheck {
  let meter: CapacityMeterReading;
  try {
    meter = readCapacityMeter(db);
  } catch (error) {
    return { ok: false, error: errorCode(error), version: null, sources: [] };
  }
  const exact = exactCapacitySums(db);
  const sources = CAPACITY_SOURCES.map(source => {
    const row: CapacitySourceDrift = {
      source,
      meter_bytes: meter.sources[source].bytes,
      exact_bytes: exact[source].bytes,
      meter_rows: meter.sources[source].row_count,
      exact_rows: exact[source].rows,
      byte_delta: meter.sources[source].bytes - exact[source].bytes,
      row_delta: meter.sources[source].row_count - exact[source].rows,
    };
    return row;
  });
  const ok = sources.every(row => row.byte_delta === 0 && row.row_delta === 0);
  return { ok, error: null, version: meter.version, sources };
}

/**
 * 离线修正计数：必须在采集器停止、维护锁生效时调用。
 * 先把四个来源的精确值写回，再核对一次；版本不匹配或结构缺失时拒绝，
 * 不在线自动修复。
 */
export function recountCapacityMeterTx(db: Database): { before: CapacityMeterCheck; after: CapacityMeterCheck } {
  const before = checkCapacityMeter(db);
  if (before.error !== null) throw new Error(before.error);
  const exact = exactCapacitySums(db);
  for (const source of CAPACITY_SOURCES) {
    db.run('UPDATE capacity_meter SET bytes=?, row_count=? WHERE source=?',
      [exact[source].bytes, exact[source].rows, source]);
  }
  const after = checkCapacityMeter(db);
  if (!after.ok) throw new Error('capacity_meter_recount_mismatch');
  return { before, after };
}
