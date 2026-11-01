-- ATC schema v8: reverse lookup indexes for hook-merge re-linking. Additive only —
-- existing v7 databases upgrade in place via these statements; no table changes.
-- Executed by openStore() both on fresh databases (after schema.sql + schema-v6.sql
-- + schema-v7.sql) and on upgrade from user_version 6 or 7.
--
-- Every hook merge re-points survivors with `UPDATE request SET prev_req_id=? WHERE
-- prev_req_id=?` and `UPDATE tool_call SET result_req=? WHERE result_req=?`. Both
-- columns are otherwise unindexed, so each merge scanned the whole table. The
-- partial form matches the write path: both updates always bind a non-NULL value,
-- and NULL rows (unlinked calls, chain roots) never participate.

CREATE INDEX IF NOT EXISTS i_req_prev ON request(prev_req_id) WHERE prev_req_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS i_tool_result_req ON tool_call(result_req) WHERE result_req IS NOT NULL;
