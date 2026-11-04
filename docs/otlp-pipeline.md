# OTLP 摄入链路现状

OTLP 是 magpie 三路证据之外的第四条摄入通道：harness 侧 exporter 直接把 span 与 log 推到 `/v1/traces`、`/v1/logs`。这条链路的框架已经完整落地——接收、解码、原始层落盘、分类、建行、正文接线的代码都在生产上运行——但后半段没有调通：分类把绝大多数 span 判成 `skipped` 后直接丢弃，不计数也不写 issue，原始层与归属层之间差着五个数量级。本文写给来完善这条链路的人，把各环归属、分类分岔、落差量级与下手入口集中一处。设计权威归[架构设计](architecture-design.md)，对外接入规范归 [OTLP exporter 接入 profile](otlp-exporter-profile.md)，范围与层间取舍的决策记录见 [OTLP 接收器提案](../.agents/notes/implemented/feature/2026-10-25-otlp-receiver.md)。

## 链路各环与代码归属

| 环节 | 归属 | 职责 |
| --- | --- | --- |
| HTTP 接收 | [http.ts](../src/http.ts) `handleOtlpIngest` | Bearer 鉴权（独立 `otlp.token`）、content-type 白名单、单飞守卫、整批限长；端点契约见[架构设计](architecture-design.md#系统边界与进程模型) |
| 解码 | [decode.ts](../src/sources/otlp/decode.ts) `decodeTracesBody` / `decodeLogsBody` | 手写 protobuf wire 走读与 OTLP/JSON 归一，两个信号解成同一平面形状；失败抛 `OtlpDecodeError`，HTTP 层回 400 带原因码 |
| 原始层落盘 | [ingest.ts](../src/sources/otlp/ingest.ts) `acceptOtlpTraces` / `acceptOtlpLogs` | 脱敏先于落盘；span 按 `(trace_id, span_id)` 判重，log 记录按内容哈希判重 |
| 分类 | [mapping.ts](../src/sources/otlp/mapping.ts) `classifySpan` | 三出口 `llm` / `unknown` / `skipped`，判定依据见下节 |
| owner 认领 | [ingest.ts](../src/sources/otlp/ingest.ts) `magpieTurnRequestTx` | 同一 turn 已有 magpie 行时只写证据不另建行：主键 `turn_ref` + agent，退化按同会话 ±60 秒窗与模型匹配 |
| 建行与证据 | [ingest.ts](../src/sources/otlp/ingest.ts) | `request` 行 `via='otlp'`、`have` 位图第 4 位；写 `otlp_span` 证据；span 带会话 id 才进派生组，不带就不猜归属 |
| 正文接线 | [ingest.ts](../src/sources/otlp/ingest.ts) `attemptBodyWireTx` | logs 侧 body 事件把文件指针落进 `otlp_body_ref`，双指针齐后读文件走既有正文管线；状态机见[架构设计](architecture-design.md#存储模型) |
| 保留 | [retention.ts](../src/retention.ts) `pruneRaw` | 7 天 TTL 分支覆盖 span 与 log；删 span 时把对应 `otlp_span` 证据标 `expired` |

这条通道的设计意图：OTLP 行不参与三路加法合并，独立建行、独立判缺正文；跨来源认领是单向的——OTLP 先到时占行，hook 按唯一 turn 复用占位行，账本迟到按[统一 owner 规则](architecture-design.md#证据身份与收敛)认领，账本先到时 OTLP 仍独立建行。

## 分类判定：skipped 与 unknown 的分岔

`classifySpan` 依次判三步。服务不在规则表（`SPAN_RULES`）里，直接 `skipped`；服务注册且 span 匹配该服务的选取规则，判 `llm`；服务注册但规则不匹配时看形状——span 带着声明自己是 LLM 调用的属性键（`LLM_SHAPE_KEYS`）判 `unknown`，否则 `skipped`。注册服务与各家选取规则的现行清单以[架构设计](architecture-design.md#系统边界与进程模型)与 [接入 profile](otlp-exporter-profile.md) 为准，本文不抄第二份。

三个出口的可见性完全不同。`llm` 走认领或建行；`unknown` 逐 span 写一条 `span_shape_unknown` issue 并计入结果字段 `unknownShape`；`skipped` 什么都不做——`acceptOtlpTraces` 里是一个不带计数的 `continue`，结果类型 `AcceptOtlpTracesResult` 的六个字段（spans、spanDuplicates、requestsCreated、unknownShape、unknownServices、bodiesWired）里没有 skipped 的位置。

未注册服务的 span 也不是无声的：span 先落原始层，再按服务与接收日聚合写一条 `service_not_registered` issue（主键去重，一个服务一天最多一行）。真正静默的只有一种情形——服务在白名单里、span 不匹配选取规则也不带 LLM 形状键，这是 skipped 分岔里唯一既无计数也无 issue 的路径。

生产落差正是从这里来的。2026-11-04 系统巡查实测（[清单 F37](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md)）：`raw_otlp_span` 的绝对大头是注册服务 `codex-app-server`（187,416 行），span 名以 `fs.get_metadata`、`receiving`、`handle_responses`、`fs.read_file` 这类工具与内部 span 为主，形状判定也认不出 LLM 键——它们全部走进这条静默路径。`ingest_issue` 里 OTLP 相关的只有 7 条 `service_not_registered` 加 1 条 `span_shape_unknown`，与 18.8 万行原始层完全不成比例。

## 身份映射现状

turn 身份的映射是单边的：三条规则里只有 Codex 规则配了 `turn` 键（`turn.id`），Claude Code 与 OMP 规则的 `turn` 键列表为空，映射出的 `turn_ref` 保持 NULL。键名与选取规则收在规则表里，改动要同步升 `OTLP_MAPPING_VERSION`（当前为 4），raw 行上存了写入时的版本；profile 的版本承诺见[接入 profile](otlp-exporter-profile.md)。

`turn_ref` 也不是 OTLP 一家在写：hook envelope 从请求体提取 turn 身份后按只补空写回，OTLP 先到时 hook 按唯一 turn 复用 OTLP 占位行；本地会话适配器在落行与合并时写；purpose 结算同样只补空。统一 owner 查找把它当作 response_id 之后的第二条认领线索。跨来源身份要按 OTLP、hook、会话文件三个通道各自写了什么、谁能认领谁来理解；覆盖面与写入条件是 [清单 F05](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md) 的待查项，本文不替它下结论。

## 生产实测落差

以下数字均为 2026-11-04 系统巡查实测（[清单 F37](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md)），不是恒定值。`raw_otlp_span` 188,099 行；`request_evidence` 里 `source_kind='otlp_span'` 1 行；`request` 里 `via='otlp'` 1 行；`otlp_body_ref` 0 行。11-03 单日 span 增量 150,603 行（见 [F11](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md)），即每天新进原始层的量级在十万行，而建行出口几乎没有流量通过。

16 条 LLM 形状 span（`session_task.turn` 与 `claude_code.llm_request` 合计）只对应 1 条证据，是同 span 重投被去重还是规则未命中，巡查没有逐条核对——这是接手后第一笔回放要回答的问题。

观测面同样收窄。HTTP 成功响应固定回 `{"partialSuccess":{}}`，OTLP 规范允许在 partialSuccess 里带拒收计数，这里没有用；调用方与运维从响应上既看不出收到了多少，也看不出分类丢了多少，静默 skipped 与服务根本没发过来在现有信号里无法区分。logs 侧 `raw_otlp_log` 有行，但 `otlp_body_ref` 0 行：正文接线路径从未在生产执行过。

## 与保留层和容量预算的关系

原始层的两处口径要一起看。`raw_otlp_span` 与 `raw_otlp_log` 在 7 天 TTL 的保留承诺里，`pruneRaw` 有对应分支，但清理吞吐小于日增量，超期存量持续累积，量级见 [F11](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md)。同时 `raw_otlp_span` 不在 `measureBodyBytes` 的求和范围内，正文预算看不到这部分字节，预算口径的缺口见 [F38](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md)。后续完善这条链路的落盘与采样策略时，两处要放在同一轮容量评估里考虑。

## 完善入口

以下是接手时的锚点清单，全部是待办方向，不是当前已交付行为；本轮只留了这份文档，没有改任何代码。采样、不入 raw、保留策略的取舍归 [F37](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md) 清单裁决，动手前先读它的建议方向与验收段。

1. 补 skipped 计数（最小第一步）：`acceptOtlpTraces` 的 skipped 分支加计数，`AcceptOtlpTracesResult` 加字段，HTTP 响应用 `partialSuccess.rejectedSpans` 回真实数。F37 的口径是先补计数再谈采样，否则只是把静默丢弃换成静默少收。
2. 回放一条真实 LLM span：用生产抓到的 `session_task.turn` 或 `claude_code.llm_request` span 喂给 `acceptOtlpTraces`，确认 16 条到 1 条证据的落差出在重投去重、turn 认领合并还是更早的环节；测试夹具基础在 [tests/otlp-fixtures.ts](../tests/otlp-fixtures.ts)。
3. 只读统计 skipped 量：按服务 × span 名 × 日聚合原始层行数，为 F37 的采样或弃收决策供数。
4. 核对正文接线的上游：`raw_otlp_log` 里是否出现过 `claude_code.api_request_body` / `api_response_body` 事件、三个必需属性（`request_body_id`、`body_ref`、trace_id）齐不齐——不齐会记 `body_event_incomplete` issue，据此区分 exporter 侧没配 `OTEL_LOG_RAW_API_BODIES` 与事件属性缺失两种情形。
5. 容量联动：落盘策略改动与 [F11](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md) 的 TTL 吞吐、[F38](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md) 的预算口径同批评审，不单独立项。
6. turn 身份核查：[F05](../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md) 的三个只读核查项（agent × 日覆盖、写入条件、存量是否回填）先于任何按 `turn_ref` 做的验收。
