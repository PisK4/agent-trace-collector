/** 容量计数对账：只读报告与停服务修正。 */

import { Database } from 'bun:sqlite';
import { checkCapacityMeter, recountCapacityMeterTx } from '../capacity-meter';
import type { CapacityMeterCheck } from '../capacity-meter';
import { withStoppedDatabase } from './backup';

/**
 * 只读对账。显式读事务固定一个快照，避免并发写入让计数与全表求和来自
 * 不同时刻；不取维护锁，也不改库。
 */
export function previewCapacityMeter(dbPath: string): CapacityMeterCheck {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN');
    try {
      return checkCapacityMeter(db);
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

/**
 * 停服务修正：独占打开库，重算四源计数并在同一事务里复核。
 * 采集器仍在运行或计数结构缺失时直接失败，不做在线覆盖。
 */
export function recountCapacityMeter(dbPath: string): {
  before: CapacityMeterCheck; after: CapacityMeterCheck;
} {
  // 四行写回与复核同属一个事务：中途失败不会留下只修了一半的计数。
  return withStoppedDatabase(dbPath, db => db.transaction(() => recountCapacityMeterTx(db)).immediate());
}
