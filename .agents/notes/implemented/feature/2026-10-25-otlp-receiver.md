# Agent Note: OTLP 接收端——把 ATC 从 magpie 的证据阅读器扩成 harness 无关的会话阅读器

Status: implemented

## Problem

ATC 现在只有一个输入源：magpie。这个约束在 [项目定位](../../../../docs/project-overview.md) 里是明确的取舍——「不设计通用的 trace 摄入协议，不预留接别的网关的适配层」。它带来的是三路证据能互相补缺、能守恒对账；代价是没装 magpie 的人一条数据都收不到。

这个代价在过去一年变得更重，因为 Agent harness 这一侧已经自己长出了标准出口。2026-10-25 查到的两个：

- **Claude Code** 官方导出 OTLP，三个信号都有：metrics 与 logs 稳定，traces 是 beta（要 `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`）。`claude_code.llm_request` span 带 `gen_ai.response.id`（等于 API 的 `request_id`）、`agent_id`、`parent_agent_id`、`attempt`、`stop_reason`、`query_source_safe`；工具 span 带 `tool_use_id`（等于 `gen_ai.tool.call.id`）。`file_path` 要开 `OTEL_LOG_TOOL_DETAILS=1` 才发，默认关。`OTEL_LOG_RAW_API_BODIES=file:<dir>` 能把**完整未截断**的 Anthropic Messages API 请求与响应 JSON 写到磁盘，事件里只留 `body_ref` 指针。出处见 [Monitoring - Claude Code Docs](https://code.claude.com/docs/en/monitoring-usage)。2026-10-26 本机实测补充：经网关路由的样本里 span 不带 `gen_ai.response.id`，跨通道锚点改由 logs 事件的 `message.id` 提供，见文末[实测记录](#实测记录2026-10-26-抓样)。
- **OMP（oh-my-pi）** 在 `packages/agent/src/telemetry.ts` 与 `packages/coding-agent/src/telemetry-export-otlp.ts` 里实现了一套 GenAI 语义约定导出，锚定 `33cc6b9a04`（2026-08-28）。span 层级是 `invoke_agent` → `chat` / `execute_tool`，属性覆盖 `gen_ai.conversation.id`、`gen_ai.response.id`、`gen_ai.tool.call.id`、`gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result`。`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=full` 时消息走完整序列化（`serializeFullInputMessagesForTelemetry`，`telemetry.ts:887`），不套 240 字摘要上限。

OTLP 本身是稳定标准：规范到 1.11.1，trace / metric / log 三个信号都是 Stable（[OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)）。GenAI 语义约定还在 Development——截至 2026-08 的 63 个 `gen_ai.*` 键没有一个标 Stable——但两个 harness 用的正是这一套，字段名在实际流量里已经收敛。

于是问题变成：ATC 继续只做 magpie 的配套工具，还是承认「按会话读 Agent 执行过程」这件事本身不依赖 magpie，把输入面打开。前者受众上限是 magpie 用户；后者要和 Langfuse 这类平台在同一个池子里被挑选。

这个提案选后者，但把范围压到最小：只接收，不替代，不改三路证据的既有语义。

## Decision

第四通道与三路证据平行，不并入、不覆盖、不参与三路合并。

```text
原来：  agent ──> magpie ──> hook / 账本 / 路由 ──> ATC
现在：  agent ──────────────────── OTLP ──────> ATC
```

分三层落地，每层单独验收：

1. **协议层**：`POST /v1/traces` 与 `POST /v1/logs`，解 OTLP/HTTP protobuf，同时接受 `application/json` 的等价载荷。两个端点都要求 Bearer 令牌，边界见[端点认证、脱敏与资源边界](#端点认证脱敏与资源边界)。
2. **证据层**：OTLP 行以 `(trace_id, span_id)` 为物理身份落库，登记为独立的证据通道，`have` 位图新增第 4 位（值 `8`），`via` 新增取值 `otlp`。不与 hook / 账本 / 路由自动合并。
3. **映射层**：第一批只写与既有列语义严格一致的映射（见「与 magpie 通路的关系」第 2 条）；映射不进既有列的 OTLP 独有事实留在原始层，进读模型列另评（见 Deferred）。

第一条约束写在最前面：**OTLP 通道不提供正文的权威来源**。正文仍以 hook 或 harness 自己的 `body_ref` 文件为准。OTLP span 里的 `gen_ai.input.messages` 是**结构化摘要**，用于补元数据与工具时序，不用于建块库。唯一的例外是 `body_ref` 文件本身：它按指针读取后走既有正文管线，见「正文的两种形态」。

### 传输层必须做 protobuf

这是本 note 最大的工程成本，也是范围判断的关键。

两个 harness 支持的协议不一样：

| harness | 支持的协议 | 出处 |
| --- | --- | --- |
| Claude Code | `grpc`、`http/json`、`http/protobuf` | `OTEL_EXPORTER_OTLP_PROTOCOL` 三个取值 |
| OMP | **只有 `http/protobuf`** | `telemetry-export.ts:13` 明写「`grpc` 或 `http/json` 会 decline 而不是错误路由 protobuf」 |

只做 `http/json` 就等于放弃 OMP。而 OMP 是用户的主力 harness 之一（见 [OMP harness 集成](2026-10-25-omp-harness-integration.md) 的生产实况一节），放弃它这个通道就只剩 Claude Code 一个来源，撑不起「harness 无关」的说法。

仓库约定是不引第三方依赖。所以 protobuf 解码要手写。这件事的规模比听起来小：OTLP 的 wire 格式只用到 varint 与 length-delimited 两种编码，我们只需按字段号走一遍，提取白名单里的字段，其余整段跳过。OMP 自己的探针测试就是手写 `readVarint` 做的（`packages/coding-agent/test/otel-signals-probe.ts`），可作为实现参照。

不做的部分：不生成 `.proto`、不建完整消息树、不校验未知字段。解码器只回答「第 N 个字段的 bytes 是什么」，语义解析归映射层。

### 证据身份

两条通路之间存在**精确锚点**，2026-10-26 抓样已在两个 harness 上各命中一次（细节见文末[实测记录](#实测记录2026-10-26-抓样)）。OMP chat span 的 `gen_ai.response.id`（`chatcmpl-…`）与 Claude Code logs 事件的 `message.id`（`msg_…`）都落在 magpie 账本 `response_id` 的值空间。经既有前缀归一化后，两者与账本行精确相等——与 hook↔账本现用的 `response_id_norm` 关联是同一机制。

所以第一批**不合并是范围取舍，不是无锚点的被迫**。合并要处理重复合并、字段优先级与派生组迁移，值得单独立项；锚点已在，记录在案不急于这一批用掉。按时间与模型配对仍然禁止——锚点是 ID 相等，不是时间窗。

物理身份取 `(trace_id, span_id)`：这两个值由发送端生成，同一次导出重发时不变，跨进程重启也不变（Claude Code 的 `interaction` span 每次新开，但已发出的 span ID 稳定）。它满足幂等重放的要求，也不需要推断任何上游语义。

不采用 `(route_id)` 或 `(t_ms, model, tokens)` 这类组合键。前者在 OTLP 里根本不存在，后者会在一秒内多次调用同一模型时撞键。

**span 到 request 行的选取**。一次导出里的 span 是一棵树（OMP `invoke_agent` → `chat` / `execute_tool`；Claude Code `interaction` → `claude_code.llm_request` → 工具 span），不是每个 span 都等价于一笔请求。只有 LLM 调用 span 建 `request` 行，选取键是 `(service.name, 选取规则)`，随 `mapping_version` 一起版本化：

- OMP 的 span 名拼了模型名（实测 `chat auto/deepseek-v4.1-flash`），按 span 名会漏，按 `gen_ai.operation.name='chat'` 选（service.name `oh-my-pi`）
- Claude Code 的 span 名带稳定前缀，按名 `claude_code.llm_request` 选（service.name `claude-code`）

白名单外的 span（agent 层、工具层）不建行，留在原始层作元数据——工具 span 建行会把请求列表淹成工具清单，幂等判定也失去确定对象。span 名不在白名单、属性形状却像 LLM 调用的不猜：记入未知桶，等映射层下一版处理，不按属性形状兜底建行。

### 端点认证、脱敏与资源边界

第四通道新增两个写端点，安全基线与 hook 对齐，四件事逐一落实：

**认证。** 两个端点要求 Bearer 令牌，常量时间比较，未带或不匹配返回 401。令牌是数据目录里独立的 `otlp.token`（0600，与 hook 令牌同一生成机制但不共用——一份密钥不进两份上游配置）。两个 harness 都不用改代码：Claude Code 与 OTel SDK 都认标准 `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <token>`。令牌透传已实测：两个 harness 配 `OTEL_EXPORTER_OTLP_HEADERS` 后 Authorization 原样到达接收端。本机任意进程不该能写库，这是 hook 已经达到的线，第四通道不降。

**浏览器侧防线是三件事的组合，不靠碰巧。** `application/x-protobuf` 与 `application/json` 都不是 CORS safelisted content-type，跨站 fetch 会先触发预检并失败；Host 校验只放 `127.0.0.1` 与 `localhost`，挡 DNS rebinding；端点对其它 content-type（如 `text/plain` 这类能发简单请求的形态）一律拒绝。三条同时成立才构成边界，缺一条都要靠另一条默默补位。

**脱敏。** 第四通道的两条正文通路（`body_ref` 文件、OMP full 模式 span 属性）都是脱敏前的完整协议对象，与 hook 拿到的正文同级。现有铁律照搬：脱敏在分块之前、在原始层落盘之前；OTLP 原始行记 `mapping_version` 与 `privacy_version`；span 属性里的字符串同样过字符串内 JSON 检查（工具参数常以字符串携带 JSON）。脱敏实现以 `src/privacy.ts` 的既有规则为唯一入口，不在 OTLP 侧另写一份。

**`body_ref` 文件的读取边界。** 只读事件里 `body_ref` 指到的那个路径，不扫描目录、不读 harness 写的其它文件。文件由 harness 拥有，保留与清理不归 ATC 管；读不到时记缺失原因，不当解析失败。这是「只读 magpie 自己写的来源」之后第一次读 harness 写的文件，边界收窄到逐文件按指针读取，先例记在这里。

**资源边界。** envelope 上限沿用 64 MiB，超限整批 413——OTLP 规范允许 `partialSuccess`，第一批不做部分入库。同时只收一份大 envelope 的守卫与 hook 共用机制。磁盘水位阶梯对第四通道同等生效：总盘 80% 停正文（含 `body_ref` 进块库），95% 停证据行，OTLP 摄入在 95% 档位明确拒收并回错误码，不静默丢弃。

### 正文的两种形态，都不完整

这一点决定 OTLP 不能替代 hook。

**Claude Code** 有两条路：span 属性与 `OTEL_LOG_RAW_API_BODIES=file:<dir>` 落盘。前者受 `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` 约束，默认 60 KB；截断标记 `_truncated` 与 `_original_length` 在文档里限定于 tool 事件侧，raw body 用的是 `body_truncated`。后者完整不截断、落盘，事件带 `body_ref`；其形态就是 Anthropic Messages API 的原始 JSON，现有 `anthropic` 适配器可直接解析。形态已实测：request 文件顶层就是 `model/messages/system/tools/thinking/stream` 的请求体原样，response 文件是裸 Message 对象；`body_ref` 指针在 `claude_code.api_response_body` 事件里，目录另有 `index.jsonl` 记 session 与 message id 对照。

**OMP** 在 `full` 模式下把完整消息序列化成 OTel 属性，但仍有上限：

- 单次 `gen_ai.input.messages` 保留全部消息（`serializeFullInputMessagesForTelemetry` 不切片）
- 工具调用数组限 64 条（`MAX_TELEMETRY_ARRAY_ITEMS`）
- 对象深度 3 层、键 12 个（`MAX_TELEMETRY_OBJECT_DEPTH` / `MAX_TELEMETRY_OBJECT_KEYS`）

而且 OMP 没有落盘通路——超限就是丢。

所以设计上要分开：**Claude Code 的 `body_ref` 文件可以进块库，OMP 的 span 属性只能补元数据**。`body_state` 为此新增取值 `summary`——有结构化摘要、无权威正文；`body_ref` 读入、解析成功且脱敏后走既有 `available` 语义。这个差异必须记录在每一行的来源上：页面按 `summary` 显示「正文来自 OTLP 摘要」而不是「正文可用」，不能让下游误以为两者同等。

### 与 magpie 通路的关系

四条关系，都要明确：

1. **不合并**。OTLP 行与 magpie 行各自建 `request`，即使它们其实是同一笔调用。合并的锚点已实测存在（见「证据身份」），但合并策略与字段优先级单独评审，第一批不做。强行按时间与模型配对会把两笔不同请求拼成一条不存在的记录——这正是 [架构设计](../../../../docs/architecture-design.md) 里否决过的那类错误。并存的形态分两种：不同 session id 是两套记录分开显示；**同一个 session id** 会落进同一个 `conv_key`——会话列表不翻倍，但会话时间线里每笔调用出现两次，一次 magpie 行一次 OTLP 行。Claude Code 同时开 magpie 与 OTLP 时，`gen_ai.conversation.id` 与 magpie 侧 session 实测就是同一个值，两个 harness 均命中。第一批接受这种并存，行上来源可区分；会话内按来源过滤的展示另评（见 Deferred），不在第一批假装解决。
2. **不抢字段**。OTLP 行只写与既有列语义严格一致的映射：`started_ms`（span 起始）、`model_requested` / `model_served`、`stop`、`in_tok` / `out_tok` / `cache_read` / `cache_write`（取 `gen_ai.usage.*`）、`agent` 标签。写不进既有列的 OTLP 独有事实全部留原始层：

   - `query_source_safe`（无列）
   - Claude Code 的 `attempt`——`attempt_count` 是 magpie tries 的计费语义，不同物，不能顶替
   - `agent_id` / `parent_agent_id`——UUID 身份，不是 magpie `subagent` 那样的名称标签，写进 `actor` / `subagent` 会拆派生组
   - 工具 span 的精确起止（无列）

   它们进读模型需要单独评审。有 magpie 时，状态、用量、费用仍以 magpie 账本为准。
3. **magpie 自己的 OTLP 优先级最低**。它的导出器是为 Langfuse 定制的白名单，不含 `response_id`、`conv`、`subagent`、`archive`，正文默认截 256 KiB。同样一条信息，账本与路由已经给了更完整的版本；接它只增加一条降级副本，不增加事实。**不为 magpie 的 OTLP 做适配**，仅在实现上兼容它的 `http/json` 载荷，不投入额外工作。
4. **缺失判定按期望位图算**。`through` 期望 `1|2|4`、`rejected` 期望 `2`、`otlp` 期望 `8`；会话列表的缺正文标志按「期望位缺失」计算，OTLP 行不因没有 hook 位被标成采集失败。`has_missing`（`src/queries/sessions.ts`）已按此改写，`web/app.js` 的位义注释同步扩到 8。

### 落到哪一层

OTLP 通道的行**不参与**派生组的 `conv_key` 归组，除非 span 里带 `gen_ai.conversation.id` 或 `session.id`。带上时按现有 `sessionRef` 归组，`conv_source` 记 `otlp-session`，`actor` 取会话本身（`agent_id` 不进 `actor`，理由见上）；没带时该行不进 `derive_queue`，只作为独立记录可查。

理由与「未知归属的请求也要完成用途」那条一致：归属是这一行自己的事实，但推不出时不猜。

派生层的 `purpose` / 链 / 工具配对**不在本 note 范围**。第一批只做摄入与查询可见，派生接入单独评估——工具配对能不能用 span 的 `tool_use_id` 替代正文推断，需要先看真实数据里的配对成功率。

## Supersession 与既有提案的关系

按 note 规则做过 supersession check。本 note **部分取代**以下现行表述，实施同一变更里同步改，proposed 期间不动文档：

| 现行表述 | 位置 | 改法 |
| --- | --- | --- |
| 「真实数据依赖 magpie 网关：没有它，一条请求都收不到」 | README 首屏（[readme-product-intro](../../implemented/process/2026-10-25-readme-product-intro-and-trace-format.md)） | 受众边界从「必须装 magpie」改为「magpie 或任一已适配 harness」 |
| 「ATC 必须先有 magpie……受众边界」 | README 与观测平台的分工一节 | 同上 |
| 「不做跨 harness 的通用摄入协议」 | README 边界与非目标 | OTLP 成为唯一一条受控的通用入口，其余通用协议仍不做 |
| 「不设计通用的 trace 摄入协议，不预留接别的网关的适配层」 | [项目定位](../../../../docs/project-overview.md) | 同上改写 |
| 三路证据模型（`have` 位义 1/2/4、合并规则、系统边界图） | [架构设计](../../../../docs/architecture-design.md) | 扩为四通道，位义 1/2/4/8，OTLP 通道不参与合并 |

**不被取代、但要补一句区分的**：README 数据来源节与 [trace 格式](../../../../docs/trace-format.md) 证据节记录的「magpie OTLP 不能当第四路」针对 magpie 自己的导出器，本 note「与 magpie 通路的关系」第 3 条与之同向。实施时补一句说明本提案接的是 harness 侧 OTLP，避免读者把两句读成矛盾。

[OMP harness 集成](2026-10-25-omp-harness-integration.md) 的「wire-first」原则把 OTel 列为边界外的新证据源，其边界外清单里的「OTel 旁路采集」决策项由本 note 作答。两文互链、不冲突：那份提案用现有三路证据派生 OMP 的 feature 语义，本提案打开一条新的输入面。OMP 的 `session_id` 归组问题在那份提案里被定性为「上游证据形状，接受不处理」；OTLP 的 `gen_ai.conversation.id` 可能改变这个结论，但需要实测确认 OMP 是否真把它写进 span。

## 实测记录（2026-10-26 抓样）

方法：一次性探针接收器（`127.0.0.1:8431`，只收报文落盘、返回规范 200，不解析不入库），本机自产合成会话三轮：

- Claude Code 2.1.310：traces 走 `http/protobuf`；traces 加 logs 走 `http/json` 并开 `OTEL_LOG_RAW_API_BODIES=file`
- OMP 18.12.6 无头模式（`omp -p`）：traces 加 logs 走 `http/protobuf`

载荷全部是自产合成数据，可直接当 fixture 素材；探针脚本与样本留在仓库外。边界同 OMP 调研先例：一次性抓样，不读 harness 本地文件。

开工前三问的答案：

1. **会话 id 在 span 里，两个 harness 都在。** Claude Code 的 `claude_code.llm_request` 与 `claude_code.interaction` 都带 `gen_ai.conversation.id` 与 `session.id`（同值，即 CC 会话 UUID）。OMP 的 chat 与 `invoke_agent` span 都带 `gen_ai.conversation.id`，值与 magpie 侧 session 同值（账本行 9775 命中）。归组路径成立，conv_key 撞键（同会话双通道并存）是常态而非假设。
2. **跨通道精确锚点存在，且已命中。** OMP chat span 的 `gen_ai.response.id`（`chatcmpl-bc46…`）归一化后等于账本行 9775 的 `response_id_norm`；Claude Code logs 的 `claude_code.api_response_body` 事件 `message.id`（`msg_43d90c…`）等于账本行 9748 的 `response_id_norm`。ID 相等就是锚点，与 hook↔账本现有关联同一机制。
3. **`body_ref` 文件就是裸协议对象。** request 是 Messages API 请求体原样，response 是裸 Message 对象，`anthropic` 适配器可直接解析（见「正文的两种形态」的实测注）。

其余实测事实：

- `OTEL_EXPORTER_OTLP_HEADERS` 的 Authorization 在两个 harness 都原样到达
- OMP span 名拼模型名，选取键定为 `(service.name, gen_ai.operation.name)`
- OTLP/JSON 里 `traceId`/`spanId` 是十六进制串、键名驼峰；protobuf 路径是原始字节，映射层统一到原始字节
- Claude Code span 的 `gen_ai.response.id` 在经网关路由的样本里缺席（文档声明的 `req_` 形态属直连），映射按缺失保持 NULL
- `user_prompt` 默认 `<REDACTED>`
- OMP logs 只有 run 级汇总计数（`omp.agent.*`），无逐笔事件，印证 logs 端点第一批只做接收与 `body_ref` 关联
- CC 一次调用两个 span（`interaction` 为 `llm_request` 的 parent），白名单不建 interaction 行

harness 面的文档级扫描（同日）：

- Codex 原生三信号 OTLP，默认关、`config.toml` 配置（[codex-rs/otel](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md)）
- Cursor 企业版 OTLP 只导 metrics 与 logs 且 CLI 不导正文，对本通道无增量（[Cursor 文档](https://prod.cursor.com/docs/enterprise/opentelemetry-export)）
- OpenCode 无原生出口，社区插件与 env 约定存在、原生请求状态待查（[issue #14697](https://github.com/anomalyco/opencode/issues/14697)）

结论：标准出口论题在主力 harness 上成立，协议层按两个已实测 harness 落，Codex 列为下一个候选，不为它做预调研。

## 交付记录

- 2026-10-26 协议层已交付（`src/sources/otlp/decode.ts`）。手写 wire 走读器只认 varint、fixed64/32 与 length-delimited，group 编码直接判非法。traces 与 logs 两种 ExportRequest 解成平面形状（span 身份为原始字节、时间为 bigint 纳秒）。OTLP/JSON 路径同形状归一：十六进制 id 转字节、驼峰键吸收、`intValue` 兼容字符串形态。整数属性超 2^53 保十进制字符串不假装精度还在；数组空位以 null 保位；未知字段整段跳过。破坏输入有封闭原因码（`otlp_wire_*` / `otlp_json_*` / `otlp_span_identity`），HTTP 层据此回 4xx。测试夹具 `tests/otlp-fixtures.ts` 是同子集的手写编码器，与生产解码器互为镜像，全部合成数据。
- 2026-10-26 证据层与映射层（traces）已交付。`have` 第 4 位（8）、`via='otlp'`、`body_state='summary'` 落地；span 物理身份 `(trace_id, span_id)` 进 `request_evidence`（source_kind `otlp_span`，ref_key 是 hex(trace)/hex(span)），重发幂等零副作用。原始层新表 `raw_otlp_span`（schema v7，纯新增；v6 库打开时原地升级，备份白名单随之收 6/7 两版）。选取键 `(service.name, 规则)`：CC 按名 `claude_code.llm_request`、OMP 按 `gen_ai.operation.name='chat'`；键名按实测不走语义约定文档（CC 用量是平铺 `input_tokens` 一族）。agent 标签用 magpie 同值域（`claude-code`→`claude`、`oh-my-pi`→`omp`）。白名单外的 span 只落原始层；LLM 形状但规则没认的进 `ingest_issue` 未知桶不兜底建行。带会话 id 才进派生组（组键与 `sessionRef` 逐字相同、`conv_source='otlp-session'`），没带不进 `derive_queue`。第一批不写 `response_id_norm`——锚点留 Deferred。脱敏先于原始层落盘，`paused` 档整批拒绝。
- 2026-10-26 logs 接收与 `body_ref` 接线已交付。logs 第一批只接收（`raw_otlp_log` 按记录内容哈希判重，重发幂等）与 body_ref 关联。`claude_code.api_request_body`/`api_response_body` 事件按 `request_body_id` 聚进 `otlp_body_ref` 状态机：pending_span → 关联 span → 双指针齐 → 读文件 → wired。logs 先到或 traces 先到都能收敛，span 行落库时回接 pending 指针。接线判据是事件自带的 traceId 找同 trace 的唯一 llm_request 行；同 trace 多 attempt span 撞出多候选时记 `span_ambiguous` 不猜。指针读取边界：只读事件指到的单个文件，非普通文件/符号链接/超 32 MiB 拒读；读不到记 `body_ref_read_failed`（行保持 summary），与解析失败分开。读取成功→脱敏→既有 `persistBodyTx`，`body_state` 转 `available`。80% 档停正文：状态记 `metadata_only`、指针保留。原始层 TTL 对两张新表同等生效（span 删除时证据转 expired，行身份在 sort_key 里不依赖 raw）。
- 2026-10-26 HTTP 端点已交付。`POST /v1/traces` 与 `POST /v1/logs`：Host/Origin 边界与 hook 共用同一段，Bearer 用独立 `otlp.token`（`loadLocalSecret` 同一机制、常量时间比较），content-type 只收 `application/x-protobuf` 与 `application/json`（`text/plain` 等简单请求形态 415——浏览器防线三件套的第三条落地）。其余拒绝路径各自就位：方法错 405，单飞守卫与 hook 共用（429），64 MiB 整批 413，解码失败 400 带原因码，95% 档 507。成功回 OTLP 规范的 `{"partialSuccess":{}}`。二进制载荷走 `readBoundedBytes`（新增字节形态，原 `readBounded` 变其 UTF-8 包装）。拒绝原因码进容量观测（`otlp_unavailable`/`unsupported_media_type`/`invalid_otlp` 三个新值）。
- 2026-10-26 读模型与页面已交付。`via` 进列表与详情投影（`RequestRow` 新增、详情 `r.*` 自然带出），行摘要按通道标「OTLP 通道」；`body_state='summary'` 的文案明示「OTLP 摘要」，不冒充正文可读。会话 `missing_body` 改按期望位图算：through 期望三路齐、rejected 只期望账本、otlp 只期望第 4 位——OTLP 行不因缺 magpie 证据被标成采集失败，通过/拒绝通道的现行语义不变。合成服务器（prototypes）的行构造同步补 `via='through'`。
- 2026-10-26 文档收口已交付，本文迁入 implemented。按 Supersession 表同步上位文档：README 受众边界改为「magpie 或已适配 harness」、数据来源表补第四行并写明与 magpie 自带导出器的区分；项目定位改写「不做通用摄入协议」为「OTLP 是唯一受控通用入口」；架构设计扩为四通道（位义 1/2/4/8、`via='otlp'`、`body_state='summary'`、OTLP 三表 DDL、端点安全行、容量梯度行为、schema v7 与 v6 原地升级）；trace 格式与 CONTEXT 的通道、via、body_state 条目同步；运维手册补 `otlp.token`、OTLP 接入一节与 95% 档拒收。
- 2026-10-26 README 接入路径重写。接真实流量一节按两条进路重构：公共启动与令牌生成（补 `otlp.token`）置顶，「走 magpie 三路证据」与「走 OTLP 不装 magpie」各自成小节。OTLP 小节给外部用户可照抄的最短路径：
  - base64url 令牌取值（裸二进制直接 `cat` 会判畸形请求，重启实测踩到后写明成因）
  - 两个标准环境变量
  - 按 harness 的差异（Claude Code 加 `OTEL_LOG_RAW_API_BODIES=file` 得逐笔正文、OMP 只到摘要）
  - 双通道并存两行的提示

  错误码表与磁盘档位仍以运维手册为家。

## Alternatives considered

**只支持 `http/json`，放弃 OMP。** 工程成本最低——Bun 原生解析 JSON，不需要写 protobuf。落选原因：只剩 Claude Code 一个来源，无法支撑「harness 无关」的定位，而 OMP 是主力 harness。如果实测发现 OMP 用户占比很低，这个选项可以重新考虑。

**引入 protobuf 运行时库。** 落选原因：仓库约定零第三方依赖，且 OTLP 的 wire 格式只用两种编码，手写解码器的规模小于维护一个新依赖的成本。反例是 OMP 自己踩过的坑——它把 exporter 锁在 0.218/2.7 家族，因为 1.x 在 Bun 下 `req.on("close")` 会死锁（`telemetry-export-otlp.ts` 文件头注释）。引入依赖就继承这类风险。

**端点不设认证，只靠回环绑定与 Host 校验。** 落选原因：架构设计的安全边界一节已论证只绑回环不够，本机任意进程都该被挡在写入口外；而令牌经标准 `OTEL_EXPORTER_OTLP_HEADERS` 下发，对两个 harness 都是零代码改动的配置项，成本只有一次接入说明。

**用 OTel Collector 中转，ATC 只读 Collector 的输出。** 落选原因：要求用户额外部署一个进程。ATC 现在的形态是单进程加 SQLite，加一层 Collector 会把「装一下就能用」变成「先配一条管道」。Collector 的能力（采样、脱敏、路由）对单机场景是过剩的。

**只做 magpie，不接 OTLP。** 落选原因：这就是现状，受众锁死在 magpie 用户。如果最终判断 ATC 的定位就是配套工具，这个选项是正确答案——本提案的价值判断依赖于「要不要打开受众」这个前置决策，它不是纯技术选择。

**把 OTLP 行与 magpie 行自动合并。** 落选原因：没有可信锚点。`gen_ai.response.id` 与 `response_id` 是两套 ID；按时间与模型配对会在一秒多次调用时出错。合并错误的代价高于并存带来的重复行。

## Testing

合成数据锁定以下行为，测试全在 `tests/otlp-*.test.ts`：

1. 端点矩阵（`tests/otlp-http.test.ts`）：protobuf 与 JSON 两种载荷在两个端点都回 200 与 `{"partialSuccess":{}}`；401（令牌缺失/不匹配）、403（Host）、405、415（`text/plain` 等）、413（超 64 MiB）、400 带原因码（非法载荷）、429（单飞）、507（95% 档）各自就位，不静默丢弃。
2. 解码器（`tests/otlp-decode.test.ts`）：未知字段跳过、group 编码判非法、十六进制 id 归一到字节、整数超 2^53 保十进制字符串、数组空位保 null；夹具是与解码器互为镜像的手写编码器，全部合成数据。
3. 摄入与映射（`tests/otlp-ingest.test.ts`）：白名单 span 建 `via='otlp'` 行、白名单外只落原始层、LLM 形状但规则没认的进未知桶；同批重发第二次零新行；载荷含凭证形态时原始层与块库都不留明文。
4. body_ref 接线（`tests/otlp-logs.test.ts`）：traces 先到与 logs 先到都收敛到 wired；文件缺失、符号链接、超 32 MiB、非 JSON 对象分别记因；多候选记 `span_ambiguous`；80% 档记 `metadata_only`；暂停档整批拒绝。
5. 读模型（`tests/otlp-read.test.ts`）：`have` 第 4 位只在 OTLP 证据写入时为 1；会话缺正文按期望位图计算，OTLP 行不标；列表带 `via`；`summary` 文案明示摘要来源。
6. schema 与保留：v6 库原地升 v7、v6 bundle 恢复后升级（`tests/store.test.ts`、`tests/maintenance.test.ts`）；OTLP 原始层 TTL 与 magpie 同等（`tests/retention.test.ts`）。
7. 零依赖不破：`package.json` 的 dependencies 保持为空。

真实流量验收未跑：上线后按[运维手册](../../../../docs/operations.md)的 OTLP 接入一节配置两个 harness，各跑一轮真实会话再对白名单选取、重发幂等与双通道并存做真实验收，结果记[验收记录](../../../../docs/acceptance.md)。在此之前，本页只有合成验收。

## Consequences

收益：受众从「装 magpie 的人」放宽到「装 magpie 或用已适配 harness 的人」；Claude Code 用户不经网关也能有逐笔正文（body_ref 文件是完整未截断的协议对象，比 hook 的回复捕获上限更宽）。代价与残留风险如下。

**traces 是 beta。** Claude Code 的 span 明确写着「不是稳定 span schema」，属性可能改名或消失。应对：映射表集中在 `src/sources/otlp/mapping.ts` 一处，带 `mapping_version`；属性缺失时保持 NULL，不拿相邻字段顶替。logs 信号稳定，可作为兜底来源。

**GenAI 语义约定未定稿。** 63 个 `gen_ai.*` 键全是 Development。应对：优先读 `claude_code.*` / `pi.gen_ai.*` 这些厂商自有命名空间，它们比通用约定稳定；`gen_ai.*` 只取已经实际收敛的那几个（`response.id`、`usage.*`、`tool.call.id`）。

**属性是条件可得，不是默认可得。** `file_path` 要 `OTEL_LOG_TOOL_DETAILS=1`、正文类内容默认关、`query_source_safe` 要 Claude Code v2.1.268 起。映射按缺失保持 NULL 的既有纪律处理；接入说明要把这些开关列全，否则「接上了但字段全空」会被误读成映射坏了。

**正文形态不一致会造成下游误判。** Claude Code 的 `body_ref` 可进块库，OMP 的 span 属性不能。应对：来源记在行上，`body_state`（新增 `summary`）与 `have` 分开表达，页面显示「正文来自 OTLP 摘要」而不是「正文可用」。

**重复行有两种形态。** 不同 session id 的人看到两套记录；同一 session id（Claude Code 用户同时开 magpie 与 OTLP 的常态）是在同一会话时间线里每笔调用出现两次。应对：接受重复，行上来源分组可区分，不做自动合并；会话内过滤属 Deferred。代价是阅读时要在心里减一遍重复。

**受众判断错了。** 如果 ATC 的用户实际上都是 magpie 用户，这条通道就是纯成本。应对：分两层交付，协议层先上（可独立验证），映射层与派生接入等真实使用信号再决定。

**遥测可关，覆盖率不是总量。** traces 默认关，开发者可把 exporter selector 设为 `none` 关掉任一信号（除非托管设置锁定）。因此 OTLP 通道的覆盖率不能当请求总量，这与 hook 的 best-effort 是同一类问题，报告口径要一致。

## Deferred

- OTLP 独有事实进读模型列：`query_source_safe`、Claude Code 的 `attempt`、`agent_id` / `parent_agent_id` 结构化子代理关系、工具 span 的精确起止。
- 会话内按来源过滤或并排展示双通道重复行。
- 跨通道按 `response_id_norm` 精确去重：锚点已实测（OMP span 属性、Claude Code logs 事件），判重机制与 hook↔账本现有关联同构，合并策略与字段优先级需单独设计。
- 其他 harness 的接入：Codex 已交付（见交付记录，决策与对外 profile 归[两步走提案](../../proposed/feature/2026-10-26-otlp-exporter-profile-and-codex.md)）；goose 与 Gemini CLI 缓接，固定提交考察在父知识库；Cursor 企业版只导 metrics/logs 且明确不含 CLI 正文，对本通道无会话阅读增量，不接；OpenCode 无原生出口，社区插件不追。逐个按 `(service.name, 选取规则)` 白名单加。
- 派生层接入（用途判定、工具配对、前驱链）。
- metrics 信号。第一批只做 traces 与 logs；`gen_ai.client.token.usage` 这类直方图对会话阅读没有增量。
- magpie OTLP 的专门适配。
