import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { insertPreparedLedgerTx } from '../src/sources/raw';
import type { LedgerFields } from '../src/sources/magpie';
import { SOURCE_PROJECTION_VERSION } from '../src/sources/projection';
import { PRIVACY_TRANSFORM_VERSION } from '../src/privacy';

// [raw_ledger 列名, 值来源] 契约表。LEDGER_COLUMNS 与 ledgerColumns 两份清单
// 各自重排时参数个数仍然对得上，运行时不会报错；只有按名读回能发现错位。
// 'payload' 表示值来自独立的 payloadJson 参数；'mappingVersion'/'privacyVersion'
// 表示值来自版本常量，其余键是 LedgerFields 的属性名。
const LEDGER_VALUE_BY_COLUMN: Record<string, string> = {
  route_id: 'routeId', t_text: 'tText', t_ms: 'tMs', source: 'source', handed_on: 'handedOn',
  kind: 'kind', agent: 'agent', provider: 'provider', host: 'host', account: 'account',
  model: 'model', requested: 'requested', served: 'served', in_tok: 'inTok', out_tok: 'outTok',
  cache_read: 'cacheRead', cache_write: 'cacheWrite', reasoning: 'reasoning', effort: 'effort',
  ms: 'ms', status: 'status', stop: 'stop', response_id: 'responseId', response_id_norm: 'responseIdNorm',
  rid: 'rid', ep: 'ep', session: 'session', native_session: 'nativeSession', subagent: 'subagent',
  parent_agent: 'parentAgent', ttft_ms: 'ttftMs', flow_ms: 'flowMs', first_text_ms: 'firstTextMs',
  sent_ms: 'sentMs', retried_ms: 'retriedMs', queued_ms: 'queuedMs', own_ms: 'ownMs',
  reasoning_hidden: 'reasoningHidden', tier_asked: 'tierAsked', tier_sent: 'tierSent',
  tier_served: 'tierServed', err_type: 'errType', computer: 'computer', via: 'via',
  archive: 'archive', tries: 'tries', credits: 'credits', own_cost: 'ownCost',
  magpie_version: 'magpieVersion', payload_json: 'payload', err: 'err',
  mapping_version: 'mappingVersion', privacy_version: 'privacyVersion',
};

test('raw_ledger 列序：LEDGER_COLUMNS 与 ledgerColumns 按名对齐', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      // schema 的 raw_ledger 去掉物理键后，列集合必须与契约表完全一致。
      const info = db.query('PRAGMA table_info(raw_ledger)').all() as Array<{ name: string }>;
      const columns = info.map(c => c.name)
        .filter(name => name !== 'source_kind' && name !== 'file_generation' && name !== 'byte_offset');
      expect(Object.keys(LEDGER_VALUE_BY_COLUMN).sort()).toEqual([...columns].sort());

      // 哨兵：fields 每个键填自己的键名，任何错位都会让按名读回对不上。
      const fields = Object.fromEntries(
        Object.values(LEDGER_VALUE_BY_COLUMN)
          .filter(key => key !== 'payload' && key !== 'mappingVersion' && key !== 'privacyVersion')
          .map(key => [key, `s:${key}`]),
      ) as unknown as LedgerFields;
      const inserted = insertPreparedLedgerTx(db, { generation: 'g1', offset: 0 }, fields, 's:payload');
      expect(inserted).toBe(true);

      const row = db.query('SELECT * FROM raw_ledger WHERE file_generation=? AND byte_offset=?')
        .get('g1', 0) as Record<string, unknown>;
      const expected: Record<string, unknown> = { source_kind: 'file', file_generation: 'g1', byte_offset: 0 };
      for (const [column, key] of Object.entries(LEDGER_VALUE_BY_COLUMN)) {
        if (key === 'payload') expected[column] = 's:payload';
        else if (key === 'mappingVersion') expected[column] = SOURCE_PROJECTION_VERSION;
        else if (key === 'privacyVersion') expected[column] = PRIVACY_TRANSFORM_VERSION;
        else expected[column] = `s:${key}`;
      }
      expect(row).toEqual(expected);
    }, 'raw-column-order');
  } finally {
    f.close();
  }
});
