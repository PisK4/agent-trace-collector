-- ATC schema v13: session_usage 按 session 查询的补充索引。Additive only ——
-- v12 库单事务原地升级。
--
-- 主键 (agent, session) 以 agent 开头，会话摘要按 session 取累计用量
-- （WHERE session=? ORDER BY agent LIMIT 2）绕不过前缀，随会话数线性变差。
-- 索引按读侧查询形状建在 (session, agent) 上，按 agent 前缀的写路径仍走主键。
-- 建索引在迁移事务里完成，不回填数据；行数小，停顿毫秒级。

CREATE INDEX IF NOT EXISTS i_session_usage_session
  ON session_usage(session, agent);
