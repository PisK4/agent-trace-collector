import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 切换核对：拿 collector 已保存的账本当分母，比较 collector 与 AVA 两边的正文覆盖。
 *
 * 只读。collector 库以 readonly 打开；AVA 库同样只读，先看 `sqlite_master` 与
 * `PRAGMA table_info` 得到真实字段名，再按字段查询——本脚本不猜 AVA 表名。
 * 只抽取 response ID、时间、状态、大小与可用性元数据，不读正文。
 *
 * 报告写到仓库外、权限 0600：里面有真实 response ID 清单，不能进仓库。
 */

export type CoverageRow = {
  response_id: string | null;
  protocol: string | null;
  started_ms: number;
  agent: string | null;
  status: number | null;
  body_state: string;
  request_bytes: number | null;
};

export type Window = { from: number; to: number };

export type Counts = { rows: number; unique_ids: number; duplicates: number };

export type Bucket = { key: string; ledger: number; collector_available: number; ava_available: number };

export type CoverageReport = {
  denominator: number;
  collector_available: number;
  ava_available: number;
  collector_only: string[];
  ava_only: string[];
  missing_both: string[];
  ambiguous_ids: string[];
  null_id_counts: { ledger: number; collector: number; ava: number };
  window: Window;
  /** 守恒分解：denominator = with_body + without_body + undecidable。 */
  counted: { with_body: number; without_body: number; undecidable: number };
  counts: { ledger: Counts; collector: Counts; ava: Counts };
  buckets: { protocol: Bucket[]; status: Bucket[]; size: Bucket[]; miss_reason: Bucket[] };
  filter: { via: string | null; status: number | null };
};

const AVAILABLE = new Set(['available', 'partial']);

function bodyAvailable(state: string): boolean {
  return AVAILABLE.has(state);
}

/** 按 response ID 建索引；同一 ID 出现多次说明规范化碰撞，不能当成一条。 */
function indexById(rows: CoverageRow[]): Map<string, CoverageRow[]> {
  const index = new Map<string, CoverageRow[]>();
  for (const row of rows) {
    if (row.response_id === null) continue;
    const list = index.get(row.response_id) ?? [];
    list.push(row);
    index.set(row.response_id, list);
  }
  return index;
}

function countsOf(rows: CoverageRow[]): Counts {
  const index = indexById(rows);
  let duplicates = 0;
  for (const list of index.values()) duplicates += Math.max(0, list.length - 1);
  return {
    rows: rows.length,
    unique_ids: index.size,
    duplicates,
  };
}

function idOf(row: CoverageRow): string | null {
  return row.response_id;
}

function availableIds(rows: CoverageRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.response_id !== null && bodyAvailable(row.body_state)) ids.add(row.response_id);
  }
  return ids;
}

const SIZE_BANDS: { key: string; max: number | null }[] = [
  { key: 'unknown', max: null },
  { key: 'le_64k', max: 64 * 1024 },
  { key: 'le_1m', max: 1024 * 1024 },
  { key: 'le_8m', max: 8 * 1024 * 1024 },
  { key: 'gt_8m', max: Number.POSITIVE_INFINITY },
];

function sizeBand(bytes: number | null): string {
  // 没有大小的行留在 unknown，不编造“超过某个上限”的原因。
  if (bytes === null) return 'unknown';
  for (const band of SIZE_BANDS) {
    if (band.max !== null && bytes <= band.max) return band.key;
  }
  return 'unknown';
}

function bucketRows(
  ledger: CoverageRow[],
  collectorIds: Set<string>,
  avaIds: Set<string>,
  keyOf: (row: CoverageRow) => string,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const row of ledger) {
    const key = keyOf(row);
    const bucket = buckets.get(key) ?? { key, ledger: 0, collector_available: 0, ava_available: 0 };
    bucket.ledger += 1;
    const id = idOf(row);
    if (id !== null) {
      if (collectorIds.has(id)) bucket.collector_available += 1;
      if (avaIds.has(id)) bucket.ava_available += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function windowOf(ledger: CoverageRow[], collector: CoverageRow[], ava: CoverageRow[]): Window {
  const times = [...ledger, ...collector, ...ava].map(row => row.started_ms);
  if (times.length === 0) return { from: 0, to: 0 };
  return { from: Math.min(...times), to: Math.max(...times) };
}

/**
 * 纯函数：不做 IO。分母是账本行数，守恒关系必须成立：
 * 有正文 + 无正文 + 无法唯一判断 = 分母。NULL ID 与重复 ID 都归入“无法唯一判断”，
 * 不丢掉也不强行合并成一条。
 */
export function compareCoverage(
  ledger: CoverageRow[],
  collector: CoverageRow[],
  ava: CoverageRow[],
  window?: Window,
): CoverageReport {
  const collectorIndex = indexById(collector);
  const avaIndex = indexById(ava);
  const collectorIds = availableIds(collector);
  const avaIds = availableIds(ava);
  const ledgerIndex = indexById(ledger);
  const ledgerIds = new Set(ledgerIndex.keys());

  let withBody = 0;
  let withoutBody = 0;
  let undecidable = 0;
  let nullIds = 0;
  const ambiguous = new Set<string>();
  const missingBoth: string[] = [];

  for (const row of ledger) {
    if (row.response_id === null) {
      nullIds += 1;
      undecidable += 1;
      continue;
    }
    if ((ledgerIndex.get(row.response_id)?.length ?? 0) > 1) {
      ambiguous.add(row.response_id);
      undecidable += 1;
      continue;
    }
    if (collectorIds.has(row.response_id)) {
      withBody += 1;
      continue;
    }
    withoutBody += 1;
    if (!avaIds.has(row.response_id)) missingBoth.push(row.response_id);
  }

  // 只在账本里没出现过的 ID 才算“独有”，否则那是分母内的差异，已经在 missing_both 里。
  const collectorOnly = [...collectorIds].filter(id => !ledgerIds.has(id)).sort();
  const avaOnly = [...avaIds].filter(id => !ledgerIds.has(id)).sort();

  let avaAvailable = 0;
  for (const row of ledger) {
    if (row.response_id === null) continue;
    if ((ledgerIndex.get(row.response_id)?.length ?? 0) > 1) continue;
    if (avaIds.has(row.response_id)) avaAvailable += 1;
  }

  return {
    denominator: ledger.length,
    collector_available: withBody,
    ava_available: avaAvailable,
    collector_only: collectorOnly,
    ava_only: avaOnly,
    missing_both: missingBoth.sort(),
    ambiguous_ids: [...ambiguous].sort(),
    null_id_counts: {
      ledger: ledger.filter(row => row.response_id === null).length,
      collector: collector.filter(row => row.response_id === null).length,
      ava: ava.filter(row => row.response_id === null).length,
    },
    window: window ?? windowOf(ledger, collector, ava),
    counted: { with_body: withBody, without_body: withoutBody, undecidable },
    counts: { ledger: countsOf(ledger), collector: countsOf(collector), ava: countsOf(ava) },
    buckets: {
      protocol: bucketRows(ledger, collectorIds, avaIds, row => row.protocol ?? 'unknown'),
      status: bucketRows(ledger, collectorIds, avaIds, row => row.status === null ? 'unknown' : String(row.status)),
      size: bucketRows(ledger, collectorIds, avaIds, row => sizeBand(row.request_bytes)),
      miss_reason: bucketRows(ledger, collectorIds, avaIds, row => row.body_state),
    },
    filter: { via: 'through', status: null },
  };
}

// ---------------------------------------------------------------- 读取 collector

export type CollectorReadOptions = {
  window: Window; via: string | null; status: number | null;
  /**
   * 'norm' 用规范化后的 ID（collector 的 `response_id_norm`），
   * 'raw' 用原始 ID（`raw_ledger.response_id`）。两份报告各出一份，
   * 规范化碰撞只在 norm 那一份里算歧义。
   */
  id_mode?: 'norm' | 'raw';
};

/** 账本行是分母：collector 已经保存的 raw_ledger，按响应 ID 汇总出正文可用性。 */
export function readCollectorLedger(path: string, options: CollectorReadOptions): CoverageRow[] {
  const db = new Database(path, { readonly: true });
  try {
    const params: (number | string)[] = [options.window.from, options.window.to];
    const idColumn = options.id_mode === 'raw' ? 'l.response_id' : 'l.response_id_norm';
    let sql = `
      SELECT ${idColumn} AS response_id, l.ep AS protocol, l.t_ms AS started_ms,
             l.agent AS agent, l.status AS status, l.ms AS duration_ms,
             CASE WHEN r.has_body = 1 THEN 'available' ELSE 'pending' END AS body_state,
             r.body_bytes AS request_bytes
      FROM raw_ledger l
      LEFT JOIN (
        SELECT response_id_norm AS rid,
               MAX(CASE WHEN body_state IN ('available','partial') THEN 1 ELSE 0 END) AS has_body,
               MAX(body_bytes) AS body_bytes
        FROM request WHERE response_id_norm IS NOT NULL GROUP BY response_id_norm
      ) r ON r.rid = l.response_id_norm
      WHERE l.t_ms >= ? AND l.t_ms < ?`;
    if (options.via !== null) {
      sql += ' AND l.via = ?';
      params.push(options.via);
    }
    if (options.status !== null) {
      sql += ' AND l.status = ?';
      params.push(options.status);
    }
    sql += ` ORDER BY l.t_ms, ${idColumn}`;
    const rows = db.query(sql).all(...params) as {
      response_id: string | null; protocol: string | null; started_ms: number;
      agent: string | null; status: number | null; body_state: string; request_bytes: number | null;
    }[];
    return rows.map(row => ({
      response_id: row.response_id,
      protocol: row.protocol,
      started_ms: Number(row.started_ms),
      agent: row.agent,
      status: row.status === null ? null : Number(row.status),
      body_state: row.body_state,
      request_bytes: row.request_bytes === null ? null : Number(row.request_bytes),
    }));
  } finally {
    db.close();
  }
}

/** collector 自己落了哪些响应 ID、正文是否可读。 */
export function readCollectorRequests(path: string, options: CollectorReadOptions): CoverageRow[] {
  const db = new Database(path, { readonly: true });
  try {
    const params: (number | string)[] = [options.window.from, options.window.to];
    // request 表只存规范化 ID；原始 ID 只有账本有，所以 raw 模式回账本连表取。
    const rawMode = options.id_mode === 'raw';
    let sql = rawMode
      ? `SELECT l.response_id AS response_id, r.via AS protocol, r.started_ms, r.agent, r.status,
                r.body_state, r.body_bytes AS request_bytes
         FROM request r JOIN raw_ledger l ON l.response_id_norm = r.response_id_norm
         WHERE r.started_ms >= ? AND r.started_ms < ? AND l.response_id IS NOT NULL`
      : `SELECT response_id_norm AS response_id, via AS protocol, started_ms, agent, status,
                body_state, body_bytes AS request_bytes
         FROM request
         WHERE started_ms >= ? AND started_ms < ? AND response_id_norm IS NOT NULL`;
    const viaColumn = rawMode ? 'r.via' : 'via';
    const statusColumn = rawMode ? 'r.status' : 'status';
    if (options.via !== null) {
      sql += ` AND ${viaColumn} = ?`;
      params.push(options.via);
    }
    if (options.status !== null) {
      sql += ` AND ${statusColumn} = ?`;
      params.push(options.status);
    }
    const rows = db.query(sql).all(...params) as {
      response_id: string | null; protocol: string | null; started_ms: number;
      agent: string | null; status: number | null; body_state: string; request_bytes: number | null;
    }[];
    return rows.map(row => ({
      response_id: row.response_id,
      protocol: row.protocol,
      started_ms: Number(row.started_ms),
      agent: row.agent,
      status: row.status === null ? null : Number(row.status),
      body_state: row.body_state,
      request_bytes: row.request_bytes === null ? null : Number(row.request_bytes),
    }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------- 读取 AVA

type AvaSchema = { table: string; columns: string[] };

/** 只看结构：表名与字段名。不读任何一行正文。 */
export function describeAvaSchema(path: string): AvaSchema[] {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[];
    return tables.map(({ name }) => {
      const info = db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all() as { name: string }[];
      return { table: name, columns: info.map(column => column.name) };
    });
  } finally {
    db.close();
  }
}

export type AvaMapping = {
  table: string;
  response_id: string;
  started_ms: string;
  status: string | null;
  body: string | null;
  bytes: string | null;
  /** 时间列是秒还是毫秒；秒要在读取时换算，不猜。 */
  time_unit: 'ms' | 's';
};

const ID_PATTERN = /^(response_?id|responseid|resp_?id|request_?id|req_?id|id)$/i;
const TIME_PATTERN = /^(started_?(at|ms)?|start_?(at|ms)?|time_?(ms)?|created_?(at|ms)?|ts|timestamp)$/i;
const STATUS_PATTERN = /^(status|http_?status|status_?code)$/i;
const BODY_PATTERN = /^(body|request_?body|response_?body|body_?z|request_?z|response_?z|has_?body)$/i;
const BYTES_PATTERN = /^(request_?bytes|req_?bytes|body_?bytes|size|request_?size)$/i;

/**
 * 按字段名挑出唯一可用的映射。挑不出来就返回原因，让执行者记录映射后改脚本，
 * 而不是随便猜一个表去读。正文列找不到同样报错：否则会把 AVA 覆盖报成 0。
 */
export function pickAvaMapping(
  schema: AvaSchema[],
  overrides: { table?: string; time_unit?: 'ms' | 's' } = {},
): { mapping: AvaMapping } | { error: string; seen: AvaSchema[] } {
  const candidates = overrides.table === undefined
    ? schema
    : schema.filter(entry => entry.table === overrides.table);
  if (candidates.length === 0) return { error: 'ava_table_not_found', seen: schema };
  const usable: AvaMapping[] = [];
  for (const entry of candidates) {
    const id = entry.columns.find(column => ID_PATTERN.test(column));
    const time = entry.columns.find(column => TIME_PATTERN.test(column));
    if (id === undefined || time === undefined) continue;
    usable.push({
      table: entry.table,
      response_id: id,
      started_ms: time,
      status: entry.columns.find(column => STATUS_PATTERN.test(column)) ?? null,
      body: entry.columns.find(column => BODY_PATTERN.test(column)) ?? null,
      bytes: entry.columns.find(column => BYTES_PATTERN.test(column)) ?? null,
      time_unit: overrides.time_unit ?? 'ms',
    });
  }
  if (usable.length === 0) return { error: 'ava_schema_unrecognized', seen: schema };
  if (usable.length > 1) return { error: 'ava_schema_ambiguous', seen: schema };
  const mapping = usable[0]!;
  if (mapping.body === null) return { error: 'ava_body_column_unknown', seen: schema };
  return { mapping };
}

export function readAvaRows(path: string, mapping: AvaMapping, window: Window): CoverageRow[] {
  const db = new Database(path, { readonly: true });
  try {
    // 时间列可能是秒：先看范围再决定换算，换算规则写进报告，不静默改单位。
    const scale = mapping.time_unit === 's' ? 1000 : 1;
    const from = Math.floor(window.from / scale);
    const to = Math.ceil(window.to / scale);
    const bodyExpr = mapping.body === null ? "''" : `CASE WHEN ${JSON.stringify(mapping.body)} IS NOT NULL THEN 'available' ELSE 'pending' END`;
    const statusExpr = mapping.status === null ? 'NULL' : JSON.stringify(mapping.status);
    const bytesExpr = mapping.bytes === null ? 'NULL' : JSON.stringify(mapping.bytes);
    const sql = `SELECT ${JSON.stringify(mapping.response_id)} AS response_id,
                        ${JSON.stringify(mapping.started_ms)} AS started_ms,
                        ${statusExpr} AS status, ${bodyExpr} AS body_state, ${bytesExpr} AS request_bytes
                 FROM ${JSON.stringify(mapping.table)}
                 WHERE ${JSON.stringify(mapping.started_ms)} >= ? AND ${JSON.stringify(mapping.started_ms)} < ?
                 ORDER BY ${JSON.stringify(mapping.started_ms)}`;
    const rows = db.query(sql).all(from, to) as {
      response_id: string | null; started_ms: number; status: number | null;
      body_state: string; request_bytes: number | null;
    }[];
    return rows.map(row => ({
      response_id: row.response_id === null ? null : String(row.response_id),
      protocol: null,
      started_ms: Number(row.started_ms) * scale,
      agent: null,
      status: row.status === null ? null : Number(row.status),
      body_state: row.body_state,
      request_bytes: row.request_bytes === null ? null : Number(row.request_bytes),
    }));
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------------- CLI

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), true);
    } else {
      flags.set(token.slice(2), next);
      index += 1;
    }
  }
  return flags;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 从当前目录往上找 `.git`；找不到就认为不在仓库里。 */
function repositoryRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 报告里有真实 response ID 清单：只许写到仓库外，权限 0600。 */
function assertOutsideRepository(outPath: string): void {
  const root = repositoryRoot(process.cwd());
  if (root === null) return;
  const resolved = resolve(outPath);
  if (resolved === root || resolved.startsWith(root + sep)) {
    throw new Error('report_inside_repository');
  }
}

const USAGE = `usage:
  verify-cutover --from <epoch-ms> --to <epoch-ms> --collector <db> --ava <readonly-db> --out <report.json>
                 [--status <n>] [--ava-table <name>] [--ava-time-unit ms|s]

报告写在仓库外、权限 0600；仓库里不放真实 ID 清单。`;

function parseEpoch(flags: Map<string, string | true>, name: string): number | null {
  const raw = stringFlag(flags, name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function runVerifyCutover(argv: string[], io: {
  out?: (line: string) => void;
  err?: (line: string) => void;
} = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = parseArgs(argv);
  const from = parseEpoch(flags, 'from');
  const to = parseEpoch(flags, 'to');
  const collectorPath = stringFlag(flags, 'collector');
  const avaPath = stringFlag(flags, 'ava');
  const outPath = stringFlag(flags, 'out');
  if (from === null || to === null || from >= to || collectorPath === null
    || avaPath === null || outPath === null) {
    err(USAGE);
    return 2;
  }

  const statusRaw = stringFlag(flags, 'status');
  const status = statusRaw === null ? null : Number(statusRaw);
  if (status !== null && !Number.isInteger(status)) {
    err('invalid_status');
    return 2;
  }
  const window = { from, to };

  try {
    assertOutsideRepository(outPath);
  } catch (error) {
    err(error instanceof Error ? error.message : 'report_inside_repository');
    return 1;
  }

  const base: CollectorReadOptions = { window, via: 'through', status };
  let norm: { ledger: CoverageRow[]; collector: CoverageRow[] };
  let raw: { ledger: CoverageRow[]; collector: CoverageRow[] };
  let ava: CoverageRow[];
  let mapping: AvaMapping;
  try {
    // 原始 ID 与规范化 ID 各出一份：规范化把不同上游 ID 折叠成一个，碰撞量必须能看见。
    norm = {
      ledger: readCollectorLedger(collectorPath, { ...base, id_mode: 'norm' }),
      collector: readCollectorRequests(collectorPath, { ...base, id_mode: 'norm' }),
    };
    raw = {
      ledger: readCollectorLedger(collectorPath, { ...base, id_mode: 'raw' }),
      collector: readCollectorRequests(collectorPath, { ...base, id_mode: 'raw' }),
    };
    const schema = describeAvaSchema(avaPath);
    const tableOverride = stringFlag(flags, 'ava-table') ?? undefined;
    const unitFlag = stringFlag(flags, 'ava-time-unit');
    if (unitFlag !== null && unitFlag !== 'ms' && unitFlag !== 's') {
      err('invalid_time_unit');
      return 2;
    }
    const picked = pickAvaMapping(schema, {
      table: tableOverride,
      time_unit: unitFlag === null ? undefined : unitFlag,
    });
    if ('error' in picked) {
      // 结构不认识就停下来，把看到的表与字段交给执行者记录映射，不猜着读。
      err(JSON.stringify({ ok: false, error: picked.error, seen: picked.seen }));
      return 1;
    }
    mapping = picked.mapping;
    ava = readAvaRows(avaPath, mapping, window);
  } catch (error) {
    err(`verify_cutover_failed:${error instanceof Error ? error.message : 'unknown'}`);
    return 1;
  }

  const normalized = compareCoverage(norm.ledger, norm.collector, ava, window);
  normalized.filter = { via: 'through', status };
  const rawReport = compareCoverage(raw.ledger, raw.collector, ava, window);
  rawReport.filter = { via: 'through', status };
  // 规范化把多个原始 ID 折成一个：两份报告的歧义数之差就是折叠量。
  const payload = {
    ok: true,
    generated_at: Date.now(),
    collector: collectorPath,
    ava: avaPath,
    ava_mapping: mapping,
    normalized,
    raw: rawReport,
  };
  try {
    mkdirSync(dirname(resolve(outPath)), { recursive: true, mode: 0o700 });
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    chmodSync(outPath, 0o600);
  } catch (error) {
    err(`report_write_failed:${error instanceof Error ? error.message : 'unknown'}`);
    return 1;
  }

  // 终端只给计数：完整 ID 清单在报告文件里，不往日志里抄。
  const conserved = (report: CoverageReport): boolean =>
    report.counted.with_body + report.counted.without_body + report.counted.undecidable
      === report.denominator;
  out(JSON.stringify({
    ok: true,
    report: resolve(outPath),
    bytes: statSync(outPath).size,
    normalized: {
      denominator: normalized.denominator,
      collector_available: normalized.collector_available,
      ava_available: normalized.ava_available,
      missing_both: normalized.missing_both.length,
      ambiguous: normalized.ambiguous_ids.length,
      null_ids: normalized.null_id_counts.ledger,
      conserved: conserved(normalized),
    },
    raw: {
      denominator: rawReport.denominator,
      collector_available: rawReport.collector_available,
      ambiguous: rawReport.ambiguous_ids.length,
      null_ids: rawReport.null_id_counts.ledger,
      conserved: conserved(rawReport),
    },
  }));
  return 0;
}

if (import.meta.main) {
  const code = await runVerifyCutover(process.argv.slice(2));
  process.exit(code);
}
