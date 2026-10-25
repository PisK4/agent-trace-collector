# Agent Note: OTLP 第四通道扩展三个 harness 的白名单

Status: proposed

调研物证在父知识库三份固定提交考察档案里：[Gemini CLI](../../../../Agent知识库/Agent研究/gemini-cli/OTLP导出考察.md)、[Codex](../../../../Agent知识库/Agent研究/codex/OTLP导出考察.md)、[goose](../../../../Agent知识库/Agent研究/goose/OTLP导出考察.md)。本文只记决策材料：接谁、规则长什么样、正文口径到哪一档，不复述源码取证。

## Problem

第四通道现在只有两条选取规则（Claude Code、OMP），README 的受众边界相应写死在两个已适配 harness 上。调研确认三个候选都能走 OTLP/HTTP 直连本机端点，但三家的判定键、用量字段族与正文通路各不相同：Codex 用自有键族且无正文；goose 与 OMP 属性同构且正文无截断内联；Gemini CLI 属性受默认关闭的门控且正文截断到 10000 字符。要决定的是白名单加哪三条、每家第一版承诺到哪一档，以及不接谁。

## Proposal

### 排序与规则草案

实施顺序 **Codex → goose → Gemini CLI**。Codex 第一：本机当前实际在用的 harness（2026-10-26 仍有活跃使用痕迹），行级有会话、模型与七项用量，读数立刻有延续价值；正文缺席是接受的成本。goose 第二：属性与 OMP 现行规则一比一对应，接入成本最低，正文通路三家最好。Gemini CLI 第三：默认导出形态没有用量也没有正文，要开两个开关才有行级读数，收益来得最晚。

`SPAN_RULES` 加三条（形状沿用 [mapping.ts](../../../../src/sources/otlp/mapping.ts)，改表升 `OTLP_MAPPING_VERSION=2`）：

```ts
{ service: 'codex_cli_rs', agent: 'codex', ruleId: 'span_name',
  matches: span => span.name === 'session_task.turn',
  keys: { session: ['thread.id'], modelRequested: ['model'], modelServed: [],
    stop: [], inTok: ['codex.turn.token_usage.input_tokens'],
    outTok: ['codex.turn.token_usage.output_tokens'],
    cacheRead: ['codex.turn.token_usage.cached_input_tokens'],
    cacheWrite: ['codex.turn.token_usage.cache_write_input_tokens'] } },
{ service: 'goose', agent: 'goose', ruleId: 'gen_ai_operation',
  matches: span => span.attrs['gen_ai.operation.name'] === 'chat',
  /* keys 与 oh-my-pi 条目相同：session 双键、request/response 模型、
     finish_reasons、四项 gen_ai.usage.* */ },
{ service: 'gemini-cli', agent: 'gemini', ruleId: 'gen_ai_operation',
  matches: span => span.attrs['gen_ai.operation.name'] === 'llm_call',
  keys: { session: ['gen_ai.conversation.id'], modelRequested: ['gen_ai.request.model'],
    modelServed: [], stop: [], inTok: ['gen_ai.usage.input_tokens'],
    outTok: ['gen_ai.usage.output_tokens'], cacheRead: [], cacheWrite: [] } },
```

三家都走既有 unknown 桶形状判据，不在本提案里改分类逻辑。Codex 的 `session_task.compact` / `review` / `user_shell` 第一版不建行，旁路语义留给派生层。

### 正文口径

第一版只到摘要与元数据两档，不开新正文通路：goose 与 Gemini CLI 的 `gen_ai.input/output.messages` span 属性按 OMP 同款摘要口径映射（`body_state='summary'`，页面标 OTLP 摘要），原文留在 `raw_otlp_span`，逐笔全文档案位另立提案；Codex 行无正文，`body_state` 走无正文状态，不标缺正文（otlp 期望只看 have 位 8）。goose 正文无截断、开启捕获后导出体量大，摘要口径同时规避接收预算与磁盘档位的放大效应。

### 配置与文档

`operations.md` 的 OTLP 接入节为三家各加一段可照抄的配置（内容取自三份考察档案，含 Gemini 的协议键陷阱与 goose 的捕获开关）；README 的已适配清单与运维手册同步。页面 `AGENT_LABELS` 补 codex、goose、gemini 三个标签。

## Alternatives considered

**拆掉白名单做通用 OTLP 摄入。** 否决。README 边界明说唯一通用入口就是这两条端点接 harness 自己的 exporter；判定键差异（Codex 自有键族、两家 semconv）靠表驱动吸收，不需要放宽摄入面。

**等三家都对齐 GenAI semconv 再统一接。** 否决。键族差异是现状不是过渡，mapping 表本来就是为差异生的；等齐会无限期推迟在用 harness 的覆盖。

**按属性完整度排序，goose 先做。** 否决先后对调。读数只有落在实际使用的 harness 上才有延续价值；Codex 本机在用，goose 一个月未动。三家都会接，先后是唯一差别。

**本轮一并接 Copilot CLI。** 推迟。证据只到官方公告档，端点管理方式未核，不够写规则。

**zcode 走 OTLP 接入。** 不成立。没有它具备导出能力的证据；它的流量缺口在 direct 行摄入，归[字段保真与 magpie 对标](../architecture/2026-10-22-magpie-parity-and-field-fidelity.md)那条线。

**每家各出一篇提案 note。** 否决。三条规则共享同一 seam、同一验收形状，合篇足够；各家的证据与边界在知识库档案里各有其家。

## Acceptance criteria

合成数据（不碰真实正文）：

1. 命中：三家的代表性 span（取自考察档案字段清单构造）各建一行，`via='otlp'`、`have` 含位 8、agent/model/session/用量按各自键族落位；goose 条目的用量四键与非空缓存断言。
2. 反例一：`service.name` 在白名单外的同形 span 不建行；Codex 的 `session_task.compact` span 不建行。
3. 反例二：`gen_ai.operation.name='invoke_agent'` 的 goose 外壳 span 不命中 chat 规则，落入 unknown 或 skipped 的既有行为保持。
4. 缺省形态：Gemini CLI 默认 span（无用量属性）建行、用量列为 NULL，会话列表不因此标缺正文。
5. 版本：`OTLP_MAPPING_VERSION` 升 2，旧行为按既有版本化语义处理。
6. 页面：三个 agent 标签显示正常，OTLP 行来源可区分。

`bun test` 跑 otlp 相关窄集，`bun run typecheck` 通过。真实流量验收（本机配三家 exporter 实跑）单独一轮，与合成验收分开记录。

## Risks

- **schema 漂移**：三家 telemetry 都在活跃演进区。`OTLP_MAPPING_VERSION` 与 unknown 桶让漂移可见，但发现要靠真实流量回来对账，第一周值得盯。
- **Codex originator 变体不命中**：白名单钉 `codex_cli_rs`，IDE 等入口的导出收不到，这是有意的边界，文档写明。
- **goose 正文体量**：捕获开关常开时导出会放大，摘要口径第一版挡住；放开全文档位前要重估接收预算与磁盘档位。
- **Gemini 双开关陷阱**：`telemetry.traces` 不开则行无量，配置段必须整段照抄进文档，不能只给标准 OTel 变量。
- **Codex 用量回填语义未实测**：重试与多候选下七个字段怎么计，静态读不出，真实流量验收时核对。

## 边界外

- metrics 通道不收（Codex 用量最富的通道是 metrics，本提案不引入第三条端点）。
- span 属性正文的逐笔全文档案位（goose 无截断通路值得做，但另立提案）。
- Copilot CLI 与其他 2026 年新增 OTel 导出的 harness，等证据到源码档再评估。
