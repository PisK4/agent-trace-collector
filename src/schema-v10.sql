-- ATC schema v10：内容身份与跨源去重键，纯加列。
--
-- user_fingerprint：请求首条有效 user 文本的内容指纹（只容忍尾部空白），用于
-- 标题请求与主会话的跨组绑定；标题请求存 `User prompt:` 之后的正文。turn_ref：
-- 上游 turn 身份（Codex 请求体 turn_id 或 OTLP turn.id），用于 OTLP 行与
-- magpie 行去重。
ALTER TABLE request ADD COLUMN user_fingerprint TEXT;
ALTER TABLE request ADD COLUMN turn_ref TEXT;
