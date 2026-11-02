/**
 * 派生计算线程的入口：打开同一份库的只读连接，跑 `computeDeriveGroup`，
 * 把计划交回主线程落库。
 *
 * 不开写连接：计算段不写库，主线程因此仍是唯一 writer，不需要跨线程写锁策略。
 * 只读连接要等主线程的 `openStore` 落过 WAL 文件才打得开，Worker 在第一条
 * 消息里才打开，那时库已经就绪。
 */
import { Database } from 'bun:sqlite';
import { computeDeriveGroup } from './sync';

type ComputeMessage = {
  kind: 'compute'; id: number; dbPath: string; convKey: string; actor: string;
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

let db: Database | null = null;
let openPath: string | null = null;

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as ComputeMessage;
  if (message.kind !== 'compute') return;
  try {
    if (db === null || openPath !== message.dbPath) {
      db?.close();
      db = new Database(message.dbPath, { readonly: true });
      db.exec('PRAGMA query_only=ON');
      db.exec('PRAGMA busy_timeout=1000');
      openPath = message.dbPath;
    }
    // 结果只有普通对象与数组：计划与读数都是可结构化克隆的值，不携带语句或连接。
    const round = computeDeriveGroup(db, message.convKey, message.actor);
    scope.postMessage({ kind: 'result', id: message.id, round });
  } catch (error) {
    scope.postMessage({
      kind: 'error', id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
