import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/** 组派生算法版本；与请求修订一起决定一次完成是否还能复用。 */
export const GROUP_ALGORITHM = 4;

/** 切片派生的算法号。与同步组的 `GROUP_ALGORITHM` 分开：两者算出的结果不能互相复用。 */
export const DERIVE_ALGORITHM = 8;

/**
 * 队列待办判定的 SQL 片段。待办查询一律用它拼条件，不再各处手写；
 * 语义（`clean` 行是持久完成记录，不是积压）由 durable-input note 持有。
 */
export function queuePendingSql(alias = ''): string {
  const q = alias === '' ? '' : `${alias}.`;
  return `${q}state<>'clean'`;
}

/**
 * 组产物「当前」判定的 SQL 片段：clean 且修订与算法都追上。
 *
 * 三个条件列都是 `derive_queue` 独有，但 `request` 行也有自己的
 * `input_revision`，所以拼进 join 时必须带队列别名，不能裸内插。
 * 修订语义由 group-publish note 持有，这里只固定判定的唯一写法。
 */
export function groupCurrentSql(alias: string): string {
  const q = `${alias}.`;
  return `${q}state='clean' AND ${q}published_revision=${q}input_revision`
    + ` AND ${q}published_algorithm=${q}target_algorithm`;
}

/** `groupCurrentSql` 的行形态；输入是队列行的原始列名。 */
export function groupIsCurrent(row: {
  state: string | null;
  input_revision: number | null;
  published_revision: number | null;
  target_algorithm: number | null;
  published_algorithm: number | null;
}): boolean {
  return row.state === 'clean' && row.input_revision === row.published_revision
    && row.target_algorithm === row.published_algorithm;
}

/**
 * 队列与发布代结果行的一对 join；发布代按队列指针取，不跨代。
 * 行读取与读取身份共用这一对 join：选哪张表、判不判 current 由调用方的
 * 查询决定，join 的形状只在这里写一遍。
 */
export function deriveJoinSql(g: string, d: string, r: string): string {
  return `LEFT JOIN derive_queue ${g} ON ${g}.conv_key=${r}.conv_key AND ${g}.actor=${r}.actor
  LEFT JOIN derive_request_result ${d} ON ${d}.generation=${g}.published_generation AND ${d}.req_id=${r}.req_id`;
}

/**
 * 派生列的取值来源：发布代行优先，否则同步旧列。
 * 这里只决定列从哪张表读——同步列同时是「上一次完成值」的家，dirty 组的
 * historical 仍要从它取旧值；当前与否的屏蔽闸门在 queries 的 `projectRow`。
 * 同步可用性判据唯一落在 `groupCurrentSql`，不在查询里另立第二套口径。
 */
export function derivedColSql(g: string, d: string, r: string, col: string): string {
  return `CASE WHEN ${g}.published_generation IS NOT NULL THEN ${d}.${col} ELSE ${r}.${col} END`;
}

/**
 * 组内还有未判定用途的成员：`request` 行应满足的谓词片段。
 *
 * 两条派生路径共用一个判据：切片选组时用它做外层过滤（NOT EXISTS），
 * 同步路径认领后再查一次（TOCTOU 复查，选组之后可能有新请求挂进来）。
 * 片段相同、查询角色各自保留。
 */
export function purposePendingSql(alias = ''): string {
  const q = alias === '' ? '' : `${alias}.`;
  return `${q}actor_state='known' AND ${q}purpose_pending=1`;
}

/**
 * 认领前把队列行的目标算法归一到本模式的算法号：组变脏时旧行保留旧号，
 * 直接完成等于宣称产物是新算法算的。算法号是参数——同步的 `GROUP_ALGORITHM`
 * 与切片的 `DERIVE_ALGORITHM` 各自保留，产物不能互相复用。
 *
 * 只改未完成的行：clean 行有已发布产物，改号等于伪造它的出处。
 */
export function normalizeTargetAlgorithmTx(
  db: Database, convKey: string, actor: string, algorithm: number,
): void {
  db.run(`UPDATE derive_queue SET target_algorithm=? WHERE conv_key=? AND actor=?
    AND ${queuePendingSql()} AND target_algorithm<>?`,
  [algorithm, convKey, actor, algorithm]);
}

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
