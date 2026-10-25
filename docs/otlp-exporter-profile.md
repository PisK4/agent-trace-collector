# OTLP exporter 接入 profile

本文写给 Agent harness 的作者：想让 ATC 读到你的 harness，导出按这份 profile 来，再登记一个稳定的 `service.name`。规范全部站在 OTLP 与 OTel GenAI 语义约定之上，不发明私有键。

## 传输与认证

- OTLP/HTTP，`application/x-protobuf` 与 `application/json` 都收。
- 端点 `POST /v1/traces` 与 `POST /v1/logs`；endpoint 配到根（`http://127.0.0.1:8320`），SDK 自己拼路径。
- 认证是 Bearer 令牌。令牌取值方法、错误码表（401/403/413/415/429/503/507）与磁盘档位行为归[运维手册](operations.md)的 OTLP 接入一节，本文不重复。

## 属性 profile

每个 LLM 调用一个 span，带齐下面的键就能建行，全部是 GenAI semconv 现有键：

| 属性 | 用途 |
| --- | --- |
| `gen_ai.operation.name` | 选取判据，建议 `chat` 或 `llm_call` |
| `gen_ai.conversation.id` | 会话归属，行进会话时间线 |
| `gen_ai.request.model` | 请求模型 |
| `gen_ai.response.model` | 实际服务的模型，缺席保持空 |
| `gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens` | 用量 |
| `gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_creation.input_tokens` | 缓存用量 |
| `gen_ai.response.finish_reasons` | 终止原因 |
| `gen_ai.input.messages`、`gen_ai.output.messages` | 逐笔正文（结构化摘要级） |

正文捕获开关用 semconv 标准变量 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`。不开时行只有读数，ATC 不把缺正文标成采集失败。表外的属性照落原始层，不进读模型列；本文只承诺今天能解析的键集。

## 登记

登记的全部成本是一个稳定的 `service.name`，加本仓 `src/sources/otlp/mapping.ts` 里一行选取规则。已登记的服务：

| service.name | harness | 选取规则 |
| --- | --- | --- |
| `claude-code` | Claude Code | span 名 `claude_code.llm_request` |
| `oh-my-pi` | OMP | `gen_ai.operation.name='chat'` |
| `codex_cli_rs` | Codex CLI | span 名 `session_task.turn` |

已登记的三家用各自的原生键族（Claude Code 是平铺 `input_tokens` 一族，OMP 用 `gen_ai.usage.*`，Codex 用 `codex.turn.token_usage.*`），登记按实际导出形状写规则，不要求改成上面的 profile。未登记的服务不建行：span 全量落原始层不丢，并按服务与日聚合记一行 `service_not_registered` issue——exporter 指过来就会被看见，补一行规则即建行。

## 版本承诺

profile 的语义变更随代码里的 `OTLP_MAPPING_VERSION` 走，改动在本仓的 Agent Note 里记录，不静默改。

## 双发不冲突

同一份导出双发给观测平台是常态；本文只约束发给 ATC 的这一路，不影响另一路。
