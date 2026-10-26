# Agent Note: OTLP 第四通道的两步走——Codex 先行与对外接入 profile

Status: implemented

## Problem

背景要从第四通道上线那天说起。[OTLP 接收端](../../implemented/feature/2026-10-25-otlp-receiver.md)交付时白名单只有两条规则：Claude Code 与 OMP，README 的受众边界随之写死在「装 magpie，或用已适配 harness」。2026-10-26 的调研（父知识库三份固定提交考察：[Codex](../../../../../../Agent知识库/Agent研究/codex/OTLP导出考察.md)、[goose](../../../../../../Agent知识库/Agent研究/goose/OTLP导出考察.md)、[Gemini CLI](../../../../../../Agent知识库/Agent研究/gemini-cli/OTLP导出考察.md)）核实三家都能走 OTLP/HTTP 直连本机端点，同时确认语义层是巴别塔：用量键四家四种写法（平铺 `input_tokens`、`gen_ai.usage.*`、`codex.turn.token_usage.*`、受门控默认不落），会话键三种，LLM span 判定键无一相同。接收方的价值全在读模型，读模型必须逐方言登记——这是[旧扩展提案](../../rejected/feature/2026-10-26-otlp-harness-expansion.md)论证过的立场，本文承接。

同一场讨论还定了两件新事。其一，白名单外的服务原来是静默 skip：新 harness 把 exporter 指过来，数据全量落在 raw 层但一行不建，采集器毫无感知——发现新方言的入口是盲的。其二，ATC 按开源项目定位对外，接入面需要有给外部 harness 作者看的东西，而不只是本仓内部的登记表。

由此得出本轮的需求，四条：

1. **覆盖权威且本机在用的 harness**：Codex（OpenAI 官方开源，本机 2026-10-26 仍活跃使用），让 OTLP 行先落进真实读数。
2. **外部 harness 开发者拿到可照做的对接说明**，把未来的登记成本压到一格 service.name。
3. **新 harness 指向端点这件事可被发现**，规范发布后有门铃。
4. **范围克制**：goose 与 Gemini CLI 缓接，调研成本已付，档案在库。

一个接受的代价要写明：Codex 是三个候选里唯一没有回复正文的（logs 的用户提示默认 REDACTED，没有任何事件携带模型回复），OTLP 行只有会话、模型与七项用量里四项的读数；逐笔正文仍由 magpie 路承担。权威与在用优先，正文深度让位。

## Decision

两步走，一步对内、一步对外，外加一块配套。三块都已交付，实施顺序是 Codex 条目、门铃、profile 文档——profile 最后落，因为它要描述包含门铃在内的完整登记行为。

### 对内：Codex 白名单条目

`SPAN_RULES`（[mapping.ts](../../../../src/sources/otlp/mapping.ts)）加 Codex 条目，`OTLP_MAPPING_VERSION=3`：按 span 名 `session_task.turn` 选取，session 取 `thread.id`、模型取 `model`（无回复侧模型与终止原因字段，保持 NULL）、四项用量取 `codex.turn.token_usage.*`；`non_cached` / `reasoning` / `total` 三项留原始层。`service` 是一族取值而不是单值：Codex 的 `service.name` 取 originator，随入口变化（`codex exec` 为 `codex_exec`，交互 CLI 为 `codex_cli_rs`），`OTEL_SERVICE_NAME` 覆盖实测无效，所以 `SpanRule.service` 支持字符串数组、匹配走 `ruleOwnsService`。`session_task.compact` / `review` / `user_shell` 不建行，旁路语义留给派生层；分类逻辑、unknown 桶与不猜归属行为不动。页面 `AGENT_LABELS` 带 `codex`；[运维手册](../../../../docs/operations.md)的 OTLP 接入一节带可照抄的 TOML 配置（三个 exporter 独立配、`otlp-http` 外标签枚举、`/v1/traces` 端点、Bearer 头），README 接入段同步。键集对齐父知识库的固定提交源码考察，未抓样实测；本机真实流量验收单独一轮（`~/.codex/config.toml` 配 `[otel.trace_exporter.otlp-http]` 指向 127.0.0.1:8320，跑真实会话核对行落位与重试、多候选下的用量回填语义），与合成验收分开记录。

### 对外：接入 profile 文档

[otlp-exporter-profile.md](../../../../docs/otlp-exporter-profile.md) 是对外规范的正本，README 对外节只留入口。规范全部站在现有标准上，不发明任何键：

- **传输与认证**：OTLP/HTTP（protobuf 或 json）、`POST /v1/traces`、Bearer 令牌；错误码与磁盘档位行为引运维手册，不重复。
- **属性 profile**：`gen_ai.operation.name`（建议 chat 或 llm_call）、`gen_ai.conversation.id`、`gen_ai.request.model` 与 `gen_ai.response.model`、`gen_ai.usage` 四键、`gen_ai.response.finish_reasons`、`gen_ai.input/output.messages`（捕获开关用 semconv 标准变量 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`）。
- **登记要求**：一个稳定的 `service.name`，向本仓加一行 `SPAN_RULES`——这是全部登记成本。
- **版本承诺**：profile 语义变更随 `OTLP_MAPPING_VERSION` 走，不静默改。
- **双发不冲突**：同一 exporter 一份双发给观测平台是常态，profile 只约束发给 ATC 的这路。

一个事实一个家：规范正文归 profile 文档，README 只留入口；profile 的属性清单与 `SPAN_RULES` 键集一致是评审核对项。

### 配套：未知服务可见性

ingest 接收结果带 `unknownServices` 计数；未登记 `service.name` 的服务按服务与接收日聚合记一行 `service_not_registered` issue（不逐 span 记，防刷表），健康接口的 issues 列表可见；[运维手册](../../../../docs/operations.md)带查 `raw_otlp_span` 按 service 分组的 SQL。这是规范发布后的门铃：有新方言敲门，列表上看得见。

### Supersession

[旧扩展提案](../../rejected/feature/2026-10-26-otlp-harness-expansion.md)转 rejected 冻结：三家的规则草案、排序论证与验收断言留在那篇里作底，本文承接决策并把实施范围收敛为 Codex 先行加对外 profile。goose 与 Gemini CLI 缓接不拒接，届时按三份考察档案照抄即可。证据层始终在父知识库，本文不复制字段清单。

## Alternatives considered

**发明私有规范（自己的键名与传输）。** 否决。外部开发者没有理由为一个本机工具兼容私有方言；OTel GenAI semconv 是明确收敛方向且已覆盖我们需要的全部语义位（含捕获开关的标准变量）。profile 是在标准之上圈定子集，不是新造协议——差这一步，规范就从「可照做」变成「不会有人做」。

**按旧提案三家全接。** 否决，缓接。goose 与 Gemini CLI 本机已休眠一个月，读数落在无人使用的 harness 上没有延续价值；开源项目的第一步先钉权威与在用。登记成本已压到一行，想接随时补。

**通用 semconv 规则，不钉 service.name，形状即收。** 否决。那是通用摄入，README 边界一节明说不做；没有点名登记就没有可归因的版本与漂移面，门控差异（Gemini 默认形态不带用量）会被读成零值——造数据。这条边界将来要变，是显式的另一次决策。

**只发规范，不接 Codex。** 否决。规范没有第一个真实消费者就是纸面文章；Codex 本机在用，行落真数据，规范第一版的对照物就是它。

**等 GenAI semconv 全稳定再动。** 否决。Codex 用自有键族，等齐等不来；profile 恰是对非收敛期的对冲——方言越乱，一本写清「照这个说我就能懂」的说明越值钱。

## Testing

合成验收进 `bun test` 窄集（`tests/otlp-ingest.test.ts`、`tests/web.test.ts`），`bun run typecheck` 通过，锁定以下行为：

1. Codex span（按真实流量字段清单构造）命中建行：`via='otlp'`、`have` 含位 8、`agent='codex'`、`session` 取 `thread.id`、模型与四项用量落位，未映射的三项用量留原始层；originator 家族各取值都命中同一规则，家族外取值仍走门铃。
2. `session_task.compact` 与 `session_task.user_shell` span 不建行、不进未知桶。
3. 白名单外服务不建行：span 落原始层，按服务与日聚合记 `service_not_registered` issue（同日重发不新增，跨日新记一行）与 `unknownServices` 计数；无会话的 span 保持独立记录，不猜归属。
4. `OTLP_MAPPING_VERSION` 为 3。
5. 页面 codex 标签就位，未知来源原样透出。

profile 文档的属性清单与 `SPAN_RULES` 键集一致、README 链接可达，是评审核对项。

真实流量验收已跑（2026-10-26，本机 `codex-cli 0.162.0-alpha.17.2`，`codex exec` 直连采集器）：turn span 建行，用量与 span 原始值逐项相等（input 17234、cached 17152、output 4，total 17238 = 17234 + 4）。这一轮推翻了三处源码考察的读法，全部按实测改写：`protocol` 取 `binary` / `json`（`protobuf` 会在加载配置时被拒），`service.name` 是 `codex_exec` 而非 `codex_cli_rs`，`OTEL_SERVICE_NAME` 覆盖无效。`session_task.compact` 与 `user_shell` 本轮未触发，旁路断言仍只有合成证据。结果记[验收记录](../../../../docs/acceptance.md)。

## Consequences

收益：OTLP 行落进本机在用的权威 harness；外部 harness 作者有可照做的对接说明，登记成本压到一格 service.name 加一行规则；新 harness 指向端点可被发现。代价与残留风险：

- **Codex schema 漂移**：Aug 到 Oct 之间 turn span 的实现位置已迁移过一次；本机实测又推翻了三处源码读法（协议枚举值、originator 取值、`OTEL_SERVICE_NAME` 覆盖）。源码考察不能替代真实流量核对，这条已在两轮之间付过一次代价。漂移兜底靠 unknown 桶与版本号；真实流量第一周值得盯。
- **originator 边界**：白名单钉 `codex_cli_rs`，IDE 等入口的导出不命中。有意边界，profile 文档与接入文档写明。
- **无正文行被误读为缺口**：otlp 期望只看 have 位 8、不标缺正文（既有测试锁定），profile 与接入文档各写一句，防止外部读者拿 Langfuse 的口径来对表。
- **profile 的承诺成本**：文档对外后，语义改动按版本承诺走。第一版只承诺今天真能解析的键集，不写愿景键。
- **issue 噪声**：未知服务按服务加日聚合，防高频导出刷爆 issue 表。

## 边界外

- metrics 通道不收（Codex 用量最富的通道是 metrics，不为此开第三条端点）。
- 免登记的通用 semconv 规则：未来显式边界变更，不在本决策。
- goose 与 Gemini CLI 的实施、span 属性正文的逐笔全文档案位：缓接，底稿在 rejected 旧案与三份考察。
- zcode 的 direct 流量缺口：归 magpie 对标提案那条线。
