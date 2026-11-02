-- ATC schema v9: 写侧认领边界。Additive only —— v8 库原地升级。
--
-- from_sort 是读侧边界：已发布到哪儿。它只在整组发布时清成 '~'，其余时间取
-- 「上次发布以来」最早受影响位置的最小值，因此组长期算不完时会冻住。
-- claim_from_sort 是写侧边界：本轮认领以来最早受影响位置。每轮认领把它重置为
-- '~'，落库段按它写前缀，并把 from_sort 推进到它。两列同形：'' 未知、'~' 无待处理、
-- 16 位补零的 started_ms 边界。空串是既有行的默认值，表示「还没认领过」。

ALTER TABLE derive_queue ADD COLUMN claim_from_sort TEXT NOT NULL DEFAULT '';
