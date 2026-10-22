# Agent Note: 服务端输入解释与能力阅读

Status: proposed

## Problem

服务端派生与页面各有一套 harness 包装清洗；标题、摘要和对话视图对同一段输入可能给出不同文本。能力区块在页面按已加载消息猜测技能，首片没读到 system 文本时会显示成零技能。

## Proposal

输入解释集中到 `src/input-interpretation.ts`，能力提取集中到 `src/capabilities.ts`。正文分页返回消息级解释、覆盖状态与能力视图；页面只渲染服务端结果。解释不修改原文、块哈希或语义指纹。派生只复用解释结果，不改变标题、摘要和链算法的选择规则。

## Alternatives considered

**继续维护两份正则。** 前后端规则会继续漂移，插话与 caveat 的差异无法用同一组回归固定。

**引入前端构建复用 TypeScript。** 生产页面是无构建原生 JavaScript；为一次展示引入构建会扩大部署面，收益不足。

**把技能与工具 schema 长期复制到派生列。** 会绕过正文保留预算，且正文回收后仍要维护第二份内容。

## Acceptance criteria

- 正文分页返回 `interpretations`、`coverage` 与 `capabilities`，页面不再维护包装清洗和技能解析。
- 原文与 `block.fingerprint` 不变；畸形包装保留原文并标未识别。
- 能力五种状态可区分，partial 与 missing 不显示为零技能。
- route z、source_facts 与 projection_meta 只返回白名单字段；未知 fail、未知 part、未知类别保持原值。
- 上下文比例只在 recomputed 且窗口为正时显示；派生状态非 clean/current 时不显示 confirmed。
- 分页方向、flags、滚动与复制有合成回归。

## Risks

- 正文分页响应变大，但只增加短文本与计数，不复制完整工具 schema。
- 能力提取只解压 role=system 的块，不扫描全部消息；正文 partial 时只能报 partial。
- 旧请求没有 format 2 与 projection_meta 时显示缺失或旧结果，不从原始 JSON 补猜。
- C 的列或派生状态值域未落地时，Task 7 必须停止，不能用旧列补一份替代状态。

## Testing

`bun test tests/input-interpretation.test.ts` 起步；`tests/derive.test.ts` 固定标题与折叠行摘要复用同一解释、且消息对象与指纹不被改写；`tests/body-api.test.ts` 固定正文页只解释当前页消息、原文保留，畸形包装与回收正文分别给出 `unrecognized` 与空解释；`tests/capabilities.test.ts` 固定两种协议的工具形状、五种技能状态、Claude 标题列表边界与未转义原文；`tests/body-view.test.ts` 只验证服务端能力视图的渲染与转义，partial/missing 不显示为零技能。`tests/queries.test.ts` 固定 route format 2 的白名单挑选、旧 format 1 不补字段、未知 fail 与缺时间不推算；`tests/reconcile.test.ts` 固定写入端确实产出 format 2。后续任务扩展合成用例，覆盖嵌套畸形包装、多条用户消息、未知 agent、能力状态、route z 白名单、未知 fail、retained 比例、未知 part 颜色、flags 与滚动恢复。
