import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/** 组派生算法版本；与请求修订一起决定一次完成是否还能复用。 */
export const GROUP_ALGORITHM = 1;

/**
 * 把一组标成待派生。
 *
 * `group_epoch` 标识组的世代：组被删除后重建会拿到新 epoch，旧完成记录因此
 * 不能复用到新组上。`input_revision` 只增不减，`published_revision` 记的是
 * 完成时消费的那一版；两者相等且 `state='clean'` 才表示产物是最新的。
 *
 * `dirty_since_ms` 只表示首次未完成触发时间：重复 dirty 保留最早值，
 * clean 之后重新 dirty 才换成本次时间。容量积压年龄按它计算，
 * 不能拿请求的 `started_ms` 冒充等待时间。
 */
export function markGroupDirtyTx(db: Database, convKey: string, actor: string, fromSort: string): void {
  db.run(
    `INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,
       input_revision,published_revision,target_algorithm,state,dirty_since_ms)
     VALUES (?,?,?,?,1,-1,?,'dirty',?) ON CONFLICT(conv_key,actor) DO UPDATE SET
       input_revision=derive_queue.input_revision+1,state='dirty',
       dirty_since_ms=CASE WHEN derive_queue.state='clean' THEN excluded.dirty_since_ms
         ELSE COALESCE(derive_queue.dirty_since_ms,excluded.dirty_since_ms) END,
       from_sort=MIN(derive_queue.from_sort,excluded.from_sort)`,
    [convKey, actor, fromSort, randomUUID(), GROUP_ALGORITHM, Date.now()],
  );
}

/** 请求当前归属的组；未知归属返回 null（不进队列）。 */
export type RequestGroup = { convKey: string; actor: string };

export function requestGroupTx(db: Database, reqId: number): RequestGroup | null {
  const row = db.query<{ conv_key: string | null; actor: string | null; actor_state: string }, [number]>(
    'SELECT conv_key,actor,actor_state FROM request WHERE req_id=?').get(reqId);
  if (row == null || row.actor_state !== 'known' || row.conv_key === null || row.actor === null) return null;
  return { convKey: row.conv_key, actor: row.actor };
}

/** 只标记已确认归属的组；未知归属的请求不产生派生任务。 */
export function markRequestGroupsTx(db: Database, reqId: number): void {
  const group = requestGroupTx(db, reqId);
  if (group !== null) markGroupDirtyTx(db, group.convKey, group.actor, '');
}

/**
 * 归属变了：旧组少了一个成员，新组多了一个成员，两边都要重算。
 *
 * 只改归属也算输入变化，因此同样推进修订；修订与组标记都只增不减，
 * 同一事务里重复调用只会多涨几次修订，不会让产物错误复用。
 */
export function markOwnershipChangeTx(db: Database, reqId: number, before: RequestGroup | null): void {
  const after = requestGroupTx(db, reqId);
  if (before?.convKey === after?.convKey && before?.actor === after?.actor) return;
  if (before !== null) markGroupDirtyTx(db, before.convKey, before.actor, '');
  markRequestInputTx(db, reqId);
}

/**
 * 合并后存活请求的输入集合整体换了身份：旧 epoch 下的用途结论不能复用到新集合上。
 *
 * 只在合并这类"同一行换了输入来源"的场合调用；普通增量保留 epoch，靠修订区分。
 */
export function resetRequestInputEpochTx(db: Database, reqId: number): void {
  db.run('UPDATE request SET input_epoch=? WHERE req_id=?', [randomUUID(), reqId]);
}

/**
 * 请求输入变了：正文、回复、归属或证据发生了变化。
 *
 * 修订与待处理标记在同一个 UPDATE 里写，避免出现"修订涨了但没排期"的中间态。
 * 费用变化不走这里：它不改变用途判定，也不改变派生结果。
 */
export function markRequestInputTx(db: Database, reqId: number): void {
  db.run(
    `UPDATE request SET input_epoch=CASE WHEN input_epoch='' THEN ? ELSE input_epoch END,
       input_revision=input_revision+1,purpose_pending=1,purpose_retry=0 WHERE req_id=?`,
    [randomUUID(), reqId],
  );
  markRequestGroupsTx(db, reqId);
}
