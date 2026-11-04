/**
 * 两行请求合为一行：迁移别名、证据、正文引用与工具链接，删除源行。
 *
 * 只处理行级事实。来源特有的队列与证据状态（例如 `pending_hook`）由调用方
 * 在调用前后处理。目标已有的事实不被源行覆盖，空字段才由源行补上。
 */

import type { Database } from 'bun:sqlite';
import {
  markGroupDirtyTx,
  markRequestInputTx,
  requestGroupTx,
  requestPositionTx,
  resetRequestInputEpochTx,
} from './derive/state';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from './sources/projection';

type SourceRow = {
  skeleton_z: Uint8Array | null;
  body_state: string;
  parse_state: string | null;
  reply_state: string | null;
  adapter_version: number | null;
  msg_count: number | null;
  miss_reason: string | null;
  source_facts_json: string | null;
  have: number;
  response_id_norm: string | null;
  session: string | null;
  conv_key: string | null;
  conv_source: string | null;
  actor: string | null;
  subagent: string | null;
  parent_agent: string | null;
  turn_ref: string | null;
  model_requested: string | null;
  in_tok: number | null;
  out_tok: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: string | null;
  title: string | null;
  sort_source: string | null;
  sort_key: string | null;
};

export type MergeOptions = {
  /**
   * 合并全部身份字段（会话、actor、模型、用量、标题与来源事实）。
   * hook 合并只补账本缺失的 response/conv 身份；其它来源跨行修复需要整组身份。
   */
  fillIdentity?: boolean;
};

export function mergeRequestTx(
  db: Database,
  sourceId: number,
  targetId: number,
  now: number,
  options: MergeOptions = {},
): void {
  if (sourceId === targetId) return;
  // 合并前先记下两笔各自的组：源请求稍后被删，它原来那一组也少了一个成员，
  // 必须在删行前标记，否则那一组的产物会一直停在旧结果上。
  const sourceGroup = requestGroupTx(db, sourceId);
  const targetGroupBefore = requestGroupTx(db, targetId);

  // 1) 先把别的别名改指目标，再登记本次映射；顺序反了会短暂指向已删除的行。
  db.run('UPDATE request_alias SET new_id=? WHERE new_id=?', [targetId, sourceId]);
  db.run('INSERT OR REPLACE INTO request_alias(old_id,new_id) VALUES (?,?)', [sourceId, targetId]);

  // 2) 证据、正文引用、工具链接与前驱引用。
  db.run('UPDATE request_evidence SET req_id=? WHERE req_id=?', [targetId, sourceId]);
  db.run(
    `UPDATE request_block SET req_id=? WHERE req_id=? AND ord NOT IN (SELECT ord FROM request_block WHERE req_id=?)`,
    [targetId, sourceId, targetId],
  );
  db.run('DELETE FROM request_block WHERE req_id=?', [sourceId]);
  db.run('UPDATE tool_call SET req_id=? WHERE req_id=?', [targetId, sourceId]);
  db.run('UPDATE tool_call SET result_req=? WHERE result_req=?', [targetId, sourceId]);
  db.run('UPDATE request SET prev_req_id=? WHERE prev_req_id=?', [targetId, sourceId]);

  const source = db.query<SourceRow, [number]>(`
    SELECT skeleton_z,body_state,parse_state,reply_state,adapter_version,msg_count,miss_reason,
      source_facts_json,have,response_id_norm,session,conv_key,conv_source,actor,subagent,
      parent_agent,turn_ref,model_requested,in_tok,out_tok,cache_read,cache_write,reasoning,
      title,sort_source,sort_key
    FROM request WHERE req_id=?`).get(sourceId);
  if (source === null) return;

  // 3) 目标缺正文而源有正文时搬过去；adapter_version 一并搬，漏掉它会让按版本
  //    筛选的回填跳过有正文的行。
  const targetBody = db.query<{ body_state: string }, [number]>(
    'SELECT body_state FROM request WHERE req_id=?').get(targetId);
  let bodyState = targetBody?.body_state ?? null;
  if (targetBody?.body_state !== 'available' && source.skeleton_z !== null) {
    db.run(
      `UPDATE request SET skeleton_z=?, body_state=?, parse_state=COALESCE(parse_state,?),
         reply_state=COALESCE(reply_state,?), adapter_version=COALESCE(adapter_version,?),
         msg_count=COALESCE(msg_count,?) WHERE req_id=?`,
      [source.skeleton_z, source.body_state, source.parse_state, source.reply_state,
        source.adapter_version, source.msg_count, targetId],
    );
    bodyState = source.body_state;
  }
  db.run('UPDATE request SET miss_reason=? WHERE req_id=?',
    [bodyState === 'available' ? null : source.miss_reason, targetId]);

  // 4) 身份与用量按字段补空；源行的 have 位并入目标。
  if (options.fillIdentity === true) {
    db.run(
      `UPDATE request SET
         response_id_norm=COALESCE(response_id_norm,?), session=COALESCE(session,?),
         conv_key=COALESCE(conv_key,?), conv_source=COALESCE(conv_source,?),
         actor=COALESCE(actor,?),
         actor_state=CASE WHEN actor_state='known' THEN 'known' WHEN actor IS NULL THEN 'known' ELSE actor_state END,
         subagent=COALESCE(subagent,?), parent_agent=COALESCE(parent_agent,?),
         turn_ref=COALESCE(turn_ref,?), model_requested=COALESCE(model_requested,?),
         in_tok=COALESCE(in_tok,?), out_tok=COALESCE(out_tok,?),
         cache_read=COALESCE(cache_read,?), cache_write=COALESCE(cache_write,?),
         reasoning=COALESCE(reasoning,?),
         title=COALESCE(title,?), sort_source=COALESCE(sort_source,?),
         sort_key=COALESCE(sort_key,?), source_facts_json=COALESCE(source_facts_json,?),
         have=have|?, updated_at=?
       WHERE req_id=?`,
      [source.response_id_norm, source.session, source.conv_key, source.conv_source,
        source.actor, source.subagent, source.parent_agent, source.turn_ref, source.model_requested,
        source.in_tok, source.out_tok, source.cache_read, source.cache_write, source.reasoning,
        source.title, source.sort_source, source.sort_key, source.source_facts_json,
        source.have, now, targetId],
    );
  } else {
    // hook 阶段只确认 response/conv 身份；账本已写好的事实不动。
    db.run(
      `UPDATE request SET
         response_id_norm=COALESCE(response_id_norm,?), conv_key=COALESCE(conv_key,?),
         conv_source=COALESCE(conv_source,?), have=have|?, updated_at=?
       WHERE req_id=?`,
      [source.response_id_norm, source.conv_key, source.conv_source, source.have, now, targetId],
    );
  }

  // 5) 证据已迁到目标，按完整证据重算目标的行级事实与 Prompt 族。
  projectRequestTx(db, targetId, { now, mappingVersion: SOURCE_PROJECTION_VERSION });

  // 6) 源请求即将消失：它原来那一组少了一个成员，必须在删行前标脏。
  if (sourceGroup !== null) {
    markGroupDirtyTx(db, sourceGroup.convKey, sourceGroup.actor, requestPositionTx(db, sourceId));
  }
  db.run('DELETE FROM request WHERE req_id=?', [sourceId]);

  // 7) 目标的输入集合换成了两笔证据的并集：旧 epoch 下的用途结论不能复用。
  resetRequestInputEpochTx(db, targetId);
  const targetGroupAfter = requestGroupTx(db, targetId);
  const moved = targetGroupBefore !== null &&
    (targetGroupAfter === null ||
      targetGroupAfter.convKey !== targetGroupBefore.convKey || targetGroupAfter.actor !== targetGroupBefore.actor);
  if (moved && targetGroupBefore !== null) {
    markGroupDirtyTx(db, targetGroupBefore.convKey, targetGroupBefore.actor,
      requestPositionTx(db, targetId));
  }
  markRequestInputTx(db, targetId);
}
