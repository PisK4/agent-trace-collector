-- ATC schema v14: 四源逻辑载荷计数与触发器。Additive only —— v13 库单事务
-- 原地升级：建表、建触发器、从四张来源表初始化，核对后推进 user_version。
--
-- 为什么在 schema 里维护：正文保存、合并、回收、原始层清理与应用层维护命令都
-- 直接写这些表；把不变量放在表上，新增适配器复用同一路径时自然生效。
-- 计数只代表逻辑载荷，不代表页分配、索引、WAL 或文件回收。
--
-- 口径必须与 src/capacity-meter.ts 的 CAPACITY_EXACT_EXPRESSIONS 一致：
-- TEXT 按 UTF-8 字节计（CAST AS BLOB），可空列分别 IFNULL 后相加。

CREATE TABLE IF NOT EXISTS capacity_meter (
  source    TEXT PRIMARY KEY,
  bytes     INTEGER NOT NULL CHECK (bytes >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
) WITHOUT ROWID;

-- block.z：共享块每行只计一次。
CREATE TRIGGER IF NOT EXISTS capacity_meter_block_insert AFTER INSERT ON block
BEGIN
  UPDATE capacity_meter SET bytes = bytes + length(NEW.z), row_count = row_count + 1
  WHERE source = 'block';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_block_update AFTER UPDATE OF z ON block
BEGIN
  UPDATE capacity_meter SET bytes = bytes - length(OLD.z) + length(NEW.z)
  WHERE source = 'block';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_block_delete AFTER DELETE ON block
BEGIN
  UPDATE capacity_meter SET bytes = bytes - length(OLD.z), row_count = row_count - 1
  WHERE source = 'block';
END;

-- request.skeleton_z：行数表示请求行数（含没有骨架的行）。
CREATE TRIGGER IF NOT EXISTS capacity_meter_request_insert AFTER INSERT ON request
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes + IFNULL(length(CAST(NEW.skeleton_z AS BLOB)),0), row_count = row_count + 1
  WHERE source = 'request';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_request_update AFTER UPDATE OF skeleton_z ON request
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes - IFNULL(length(CAST(OLD.skeleton_z AS BLOB)),0)
    + IFNULL(length(CAST(NEW.skeleton_z AS BLOB)),0)
  WHERE source = 'request';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_request_delete AFTER DELETE ON request
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes - IFNULL(length(CAST(OLD.skeleton_z AS BLOB)),0), row_count = row_count - 1
  WHERE source = 'request';
END;

-- raw_hook 的单边正文：request_z / response_z 各自可空，分别计长后相加。
CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_hook_insert AFTER INSERT ON raw_hook
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes + IFNULL(length(CAST(NEW.request_z AS BLOB)),0)
    + IFNULL(length(CAST(NEW.response_z AS BLOB)),0),
    row_count = row_count + 1
  WHERE source = 'raw_hook';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_hook_update
AFTER UPDATE OF request_z, response_z ON raw_hook
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes
    - IFNULL(length(CAST(OLD.request_z AS BLOB)),0) - IFNULL(length(CAST(OLD.response_z AS BLOB)),0)
    + IFNULL(length(CAST(NEW.request_z AS BLOB)),0) + IFNULL(length(CAST(NEW.response_z AS BLOB)),0)
  WHERE source = 'raw_hook';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_hook_delete AFTER DELETE ON raw_hook
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes - IFNULL(length(CAST(OLD.request_z AS BLOB)),0)
    - IFNULL(length(CAST(OLD.response_z AS BLOB)),0),
    row_count = row_count - 1
  WHERE source = 'raw_hook';
END;

-- raw_session_event.payload_json 是 TEXT：必须按 UTF-8 字节计，length() 是字符数。
CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_session_event_insert AFTER INSERT ON raw_session_event
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes + length(CAST(NEW.payload_json AS BLOB)), row_count = row_count + 1
  WHERE source = 'raw_session_event';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_session_event_update
AFTER UPDATE OF payload_json ON raw_session_event
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes - length(CAST(OLD.payload_json AS BLOB)) + length(CAST(NEW.payload_json AS BLOB))
  WHERE source = 'raw_session_event';
END;

CREATE TRIGGER IF NOT EXISTS capacity_meter_raw_session_event_delete AFTER DELETE ON raw_session_event
BEGIN
  UPDATE capacity_meter
  SET bytes = bytes - length(CAST(OLD.payload_json AS BLOB)), row_count = row_count - 1
  WHERE source = 'raw_session_event';
END;
