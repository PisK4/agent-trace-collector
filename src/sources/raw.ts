import type { Database } from 'bun:sqlite';
import type { LedgerFields, RouteFields } from './magpie';
import { SOURCE_PROJECTION_VERSION } from './projection';
import { PRIVACY_TRANSFORM_VERSION } from '../privacy';

export type LedgerPhysicalRef = { generation: string; offset: number };

function ledgerColumns(fields: LedgerFields, payloadJson: string): (string | number | null)[] {
  return [
    fields.routeId, fields.tText, fields.tMs, fields.source, fields.handedOn, fields.kind,
    fields.agent, fields.provider, fields.host, fields.account, fields.model, fields.requested, fields.served,
    fields.inTok, fields.outTok, fields.cacheRead, fields.cacheWrite, fields.reasoning, fields.effort,
    fields.ms, fields.status, fields.stop, fields.responseId, fields.responseIdNorm, fields.rid, fields.ep,
    fields.session, fields.nativeSession, fields.subagent, fields.parentAgent,
    fields.ttftMs, fields.flowMs, fields.firstTextMs, fields.sentMs, fields.retriedMs, fields.queuedMs,
    fields.ownMs, fields.reasoningHidden, fields.tierAsked, fields.tierSent, fields.tierServed,
    fields.errType, fields.computer, fields.via, fields.archive, fields.tries, fields.credits,
    fields.ownCost, fields.magpieVersion, payloadJson,
    // 三个版本值与 payload 同源：它们描述的是这一行按哪套规则映射与脱敏，
    // 缺了它们，读模型只能假设所有行同口径。
    fields.err, SOURCE_PROJECTION_VERSION, PRIVACY_TRANSFORM_VERSION,
  ];
}

const LEDGER_COLUMNS = `route_id,t_text,t_ms,source,handed_on,kind,agent,provider,host,account,model,requested,served,
  in_tok,out_tok,cache_read,cache_write,reasoning,effort,ms,status,stop,response_id,response_id_norm,rid,ep,
  session,native_session,subagent,parent_agent,ttft_ms,flow_ms,first_text_ms,sent_ms,retried_ms,queued_ms,
  own_ms,reasoning_hidden,tier_asked,tier_sent,tier_served,err_type,computer,via,archive,tries,credits,
  own_cost,magpie_version,payload_json,err,mapping_version,privacy_version`;

export function insertPreparedLedgerTx(
  db: Database, ref: LedgerPhysicalRef, fields: LedgerFields, payloadJson: string,
): boolean {
  const placeholders = LEDGER_COLUMNS.split(',').map(() => '?').join(',');
  return db.run(
    `INSERT OR IGNORE INTO raw_ledger(source_kind,file_generation,byte_offset,${LEDGER_COLUMNS})
     VALUES ('file',?,?,${placeholders})`,
    [ref.generation, ref.offset, ...ledgerColumns(fields, payloadJson)],
  ).changes > 0;
}

export function writePreparedLedgerTx(
  db: Database, ref: LedgerPhysicalRef, fields: LedgerFields, payloadJson: string,
): boolean {
  const assignments = LEDGER_COLUMNS.split(',').map(column => `${column}=?`).join(',');
  return db.run(
    `UPDATE raw_ledger SET ${assignments}
     WHERE source_kind='file' AND file_generation=? AND byte_offset=?`,
    [...ledgerColumns(fields, payloadJson), ref.generation, ref.offset],
  ).changes > 0;
}

function routeColumns(route: RouteFields, payloadJson: string): (string | number | null)[] {
  return [
    route.routeId, route.timeMs, route.day, route.agent, route.session, route.conv, route.folder,
    route.subagentId, route.kind, route.forJson, route.model, route.provider, route.served, route.effort,
    route.status, route.error, route.done, route.ms, route.ttft, route.firstText, route.flow,
    route.tokens, route.outTok, route.reasoning, payloadJson, route.magpieVersion,
    SOURCE_PROJECTION_VERSION, PRIVACY_TRANSFORM_VERSION,
  ];
}

const ROUTE_COLUMNS = `route_id,time_ms,day,agent,session,conv,folder,subagent_id,kind,for_json,model,provider,served,effort,
  status,error,done,ms,ttft,first_text,flow,tokens,out_tok,reasoning,payload_json,magpie_version,
  mapping_version,privacy_version`;

export function upsertPreparedRouteTx(db: Database, route: RouteFields, payloadJson: string): void {
  const placeholders = ROUTE_COLUMNS.split(',').map(() => '?').join(',');
  db.run(
    `INSERT INTO raw_route(${ROUTE_COLUMNS}) VALUES (${placeholders})
     ON CONFLICT(route_id) DO UPDATE SET
       time_ms=excluded.time_ms,day=excluded.day,agent=excluded.agent,session=excluded.session,conv=excluded.conv,
       folder=excluded.folder,subagent_id=excluded.subagent_id,kind=excluded.kind,for_json=excluded.for_json,
       model=excluded.model,provider=excluded.provider,served=excluded.served,effort=excluded.effort,
       status=excluded.status,error=excluded.error,done=excluded.done,ms=excluded.ms,ttft=excluded.ttft,
       first_text=excluded.first_text,flow=excluded.flow,tokens=excluded.tokens,out_tok=excluded.out_tok,
       reasoning=excluded.reasoning,payload_json=excluded.payload_json,magpie_version=excluded.magpie_version,
       mapping_version=excluded.mapping_version,privacy_version=excluded.privacy_version`,
    routeColumns(route, payloadJson),
  );
}

/**
 * 只改既有 raw route 行：不 INSERT、不碰 request_evidence、不调用 redact。
 * 迁移批次复用同一列清单，不复制 SQL。
 */
export function writePreparedRouteTx(
  db: Database, routeId: number, route: RouteFields, payloadJson: string,
): boolean {
  const assignments = ROUTE_COLUMNS.split(',').filter(column => column !== 'route_id')
    .map(column => `${column}=?`).join(',');
  const values = routeColumns(route, payloadJson).slice(1);
  return db.run(
    `UPDATE raw_route SET ${assignments} WHERE route_id=?`,
    [...values, routeId],
  ).changes > 0;
}
