# Agent Note: 服务端输入解释与能力阅读

Status: implemented

## Problem

服务端派生与页面各有一套 harness 包装清洗；标题、摘要和对话视图对同一段输入可能给出不同文本，插话与 caveat 的差异也无法用同一组回归固定。能力区块在页面按已加载消息猜测技能，首片没读到 system 文本时会显示成零技能。路由尝试与上下文比例缺少统一的安全投影：旧比例被当成当前分母，未知 fail 与未知类别被折叠成已知值。

## Decision

输入解释集中到 `src/input-interpretation.ts`，能力提取集中到 `src/capabilities.ts`。正文分页返回消息级解释、覆盖状态与能力视图；页面只渲染服务端结果，不再按角色与文本猜哪些消息是用户输入。解释不修改原文、块哈希或语义指纹，派生只复用解释结果。

输入解释只剥开头的已知包装，按嵌套深度扫描配对标签；未闭合的包装保留原文并标 `unrecognized`。`injected` 与 `empty` 不产生用户气泡。技能与工具由能力视图分开报告，五种状态可区分，正文不完整时不显示为零技能。

路由与详情的展示字段走白名单：`route_summary.z` 只读 format 2 的安全字段，尝试链保留未知 fail 原值、缺开始时间不推算间隔；上下文比例只在 prompt 族为 `recomputed` 且窗口为正时计算。链关系与新增消息只在链结果为 `current` 时标为确定，`dirty`、`retained`、`legacy` 与未知状态各自说明原因。

与[标题生成与主链](2026-10-21-title-generator-and-main-chain.md)的分工不变：用途阶段仍决定请求类别与链归属，本决策只统一"这段输入是什么"的展示解释。请求类别的注册表仍由[请求类别注册表](../../proposed/architecture/2026-10-22-agent-request-kind-registry.md)推进；本文不改变 `SESSION_TITLE_SQL`。

## Alternatives considered

**继续维护两份正则。** 前后端规则会继续漂移，同一条消息在标题、摘要与对话视图里可能得到不同文本；回归只能分别写两份，无法固定同一契约。

**引入前端构建复用 TypeScript。** 生产页面是无构建原生 JavaScript；为一次展示引入构建会扩大部署面，收益不足。

**把技能与工具 schema 长期复制到派生列。** 会绕过正文保留预算，正文回收后仍要维护第二份内容，还会让 schema 变化与派生版本纠缠。

**让页面继续按 `role` 与文本猜输入。** Anthropic 把 `tool_result` 放在 user 角色下，插话与技能注入也没有稳定标签；按角色猜会把工具结果画成用户提问。服务端已有会话身份与解释规则，展示应复用同一份。

## Consequences

- 正文分页响应变大，但只增加短文本与计数，不复制完整工具 schema。
- 能力提取只解压 role=2 的系统块，不扫描全部消息；正文 partial 时只能报 partial。
- 旧路由行没有 format 2 与 projection_meta 时显示缺失或旧结果，不从原始 JSON 补猜。
- 未知类别、角色、part 与 fail 保持原值，页面不再按命名推断用途或颜色。
- 解释规则收紧会改变标题与折叠行摘要；任何规则调整都要同时跑派生回归，不能只改展示测试。

## Testing

`bun test tests/input-interpretation.test.ts tests/capabilities.test.ts tests/protocols.test.ts tests/body-api.test.ts tests/body-view.test.ts tests/queries.test.ts tests/reconcile.test.ts tests/web.test.ts tests/derive.test.ts`，以及 `bun run typecheck`。合成用例覆盖嵌套畸形包装、多条用户消息、未知 agent、能力五种状态、route z 白名单、未知 fail、缺时间、retained 比例、未知 part 颜色、未知类别与 flags、复制原文与滚动恢复。
