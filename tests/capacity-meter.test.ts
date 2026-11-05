import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import {
  CAPACITY_SOURCES, exactCapacitySums, readCapacityMeter,
} from '../src/capacity-meter';
import { createAdmissionGate, measureBodyBytes } from '../src/retention';
import type { Store } from '../src/store';

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

function one(f: ReturnType<typeof fixture>, sql: string, params: unknown[] = []): void {
  f.store.write(db => db.run(sql, params as never));
}

test('四源计数逐来源等于全表求和：TEXT按字节、单边正文与共享块都不漏计', () => {
  const f = fixture();
  try {
    const chinese = '中文🙂';
    const payload = JSON.stringify({ text: chinese });
    const blockBlob = new Uint8Array(64).fill(1);
    one(f, 'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)',
      [new Uint8Array([1]), 'fp-1', blockBlob, blockBlob.length]);
    // 同一共享块重复插入被唯一键忽略，计数不能跟着翻倍。
    one(f, 'INSERT OR IGNORE INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)',
      [new Uint8Array([1]), 'fp-1', blockBlob, blockBlob.length]);
    one(f, 'INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at,skeleton_z) '
      + "VALUES (1,'2026-11-05','hook','pending',0,1,1,1,?)", [chinese]);
    one(f, 'INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at,in_tok) '
      + "VALUES (2,'2026-11-05','hook','pending',0,1,1,1,3)");
    one(f, 'INSERT INTO raw_hook(hook_id,received_at,parse_state,request_z) VALUES (?,?,?,?)',
      ['hook-req', 1, 'ok', new Uint8Array(10).fill(2)]);
    one(f, 'INSERT INTO raw_hook(hook_id,received_at,parse_state,response_z) VALUES (?,?,?,?)',
      ['hook-reply', 2, 'ok', new Uint8Array(20).fill(3)]);
    one(f, `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
      line_type,event_at_ms,payload_json,privacy_version)
      VALUES ('claude_session','g',0,'s','user',1,?,1)`, [payload]);

    const meter = readCapacityMeter(f.store.read);
    const exact = exactCapacitySums(f.store.read);
    expect(meter.source_count).toBe(4);
    for (const source of CAPACITY_SOURCES) {
      expect({ source, bytes: meter.sources[source].bytes, rows: meter.sources[source].row_count })
        .toEqual({ source, bytes: exact[source].bytes, rows: exact[source].rows });
    }
    expect(meter.sources.block).toEqual({ bytes: 64, row_count: 1 });
    expect(meter.sources.request).toEqual({ bytes: encoder.encode(chinese).length, row_count: 2 });
    expect(meter.sources.raw_hook).toEqual({ bytes: 30, row_count: 2 });
    expect(meter.sources.raw_session_event.bytes).toBe(encoder.encode(payload).length);
    expect(meter.body_bytes).toBe(64 + encoder.encode(chinese).length + 30 + encoder.encode(payload).length);
  } finally {
    f.close();
  }
});

test('upsert、REPLACE、删除与事务回滚都保持计数一致', () => {
  const f = fixture();
  try {
    const insert = 'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)';
    one(f, insert, [new Uint8Array([7]), 'fp', new Uint8Array(10).fill(1), 10]);
    expect(measureBodyBytes(f.store)).toBe(10);

    // ON CONFLICT 的 UPDATE 只按新旧长度差调整，不新增行数。
    one(f, 'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?) '
      + 'ON CONFLICT(hash) DO UPDATE SET z=excluded.z, raw_size=excluded.raw_size',
    [new Uint8Array([7]), 'fp', new Uint8Array(25).fill(2), 25]);
    expect(measureBodyBytes(f.store)).toBe(25);
    expect(readCapacityMeter(f.store.read).sources.block.row_count).toBe(1);

    // REPLACE 隐式删除 + 插入：recursive_triggers 打开后两条路径都要算到。
    one(f, 'INSERT OR REPLACE INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)',
      [new Uint8Array([7]), 'fp', new Uint8Array(4).fill(3), 4]);
    expect(measureBodyBytes(f.store)).toBe(4);
    expect(readCapacityMeter(f.store.read).sources.block.row_count).toBe(1);

    expect(() => f.store.write(db => {
      db.run(insert, [new Uint8Array([8]), 'fp-rollback', new Uint8Array(100).fill(4), 100]);
      throw new Error('injected');
    })).toThrow('injected');
    expect(measureBodyBytes(f.store)).toBe(4);

    one(f, 'DELETE FROM block WHERE hash=?', [new Uint8Array([7])]);
    expect(measureBodyBytes(f.store)).toBe(0);
    expect(readCapacityMeter(f.store.read).sources.block.row_count).toBe(0);
    expect(exactCapacitySums(f.store.read).block.bytes).toBe(0);
  } finally {
    f.close();
  }
});

test('在线装配只读四行计数，不扫来源表', () => {
  const f = fixture();
  try {
    one(f, 'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)',
      [new Uint8Array([1]), 'fp', new Uint8Array(128).fill(1), 128]);
    for (let index = 0; index < 50; index++) {
      one(f, `INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
        VALUES (?, '2026-11-05','hook','pending',0,1,1,1)`, [index]);
    }

    const statements: string[] = [];
    const measured: number[] = [];
    const read = new Proxy(f.store.read, {
      get(target, property, receiver) {
        if (property === 'query') {
          return (sql: string) => {
            statements.push(sql);
            return target.query(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    // 走真实装配：准入闸门 → measureStorage → 计数，不是直接调计数函数。
    const gate = createAdmissionGate(
      { ...f.store, read } as Store,
      f.dir,
      { bodyBudget: 10 * MiB, diskLimit: 100 * MiB },
      { ttlMs: 0, clock: () => 1000, onMeasure: ms => measured.push(ms) },
    );
    expect(gate.check(0).mode).toBe('normal');
    expect(statements.some(sql => sql.includes('capacity_meter'))).toBe(true);
    expect(statements.some(sql => /\bFROM\s+(block|request|raw_hook|raw_session_event)\b/i.test(sql))).toBe(false);
    expect(measured).toHaveLength(1);
    expect(measured[0]).toBeLessThanOrEqual(5);
  } finally {
    f.close();
  }
});
