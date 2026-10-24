# Agent Note: pretty-trace——中栏工具行摘要、结果前缀与工具强调色

Status: implemented

显示层决策，不涉后端、schema 与派生。承接三篇既有记录：[单行步骤投影 trace-view](2026-10-24-trace-step-projection.md) 拥有 `toolSummary` 与行内标签的现状（本文改写其显示事实，两记录保持交叉链接），[Trace Pair 配对页与右栏就地阅读](2026-10-24-trace-pair-rail-page.md) 拥有配对页布局，[中栏只呈现内容，详情集中右栏](../simplification/2026-10-24-trace-content-only-and-wide-rail.md) 定了行内取舍边界。行内表达遵守[前端降噪常备规则](../process/2026-10-24-frontend-denoise-standing-rule.md)：chip 取代 `Tool call`/`Tool result` 文字小标，正常态不新增装饰元素，异常才着色。四项格式决策已与用户对齐（2026-10-24）。

## Problem

中栏工具行的信息密度与可扫读性有三个短板，量级依据来自本机库实测（`tool_call` 表 2026-10-24 快照，共 2,780 次调用；参数形状按工具各抽最新 400 条）：

1. **路径吃掉摘要预算。** `toolSummary` 取 `command ?? cmd ?? file_path ?? path ?? pattern` 的首个命中直接展示：Read 行显示完整绝对路径，140 字符截断预算大半耗在 `/Users/…` 前缀上，而扫读锚点其实是文件名。参数（offset/limit、replace_all、skill 名）完全不出现。
2. **工具身份没有视觉锚点。** 所有调用行共用 `Assistant` 角色标加 `Tool call` 内容小标，所有结果行共用 `Tool` 加 `Tool result`；扫一眼分不清这行是 Read 还是 Bash，也看不出结果行对应哪次调用。
3. **失败不可见。** 结果块的 `is_error=true` 只在右栏正文页有一个小 chip，中栏行与配对页没有异常表示。

工具分布与参数形状（抽样实测）：

| 工具 | 次数 | 参数键（键:出现率） |
| --- | --- | --- |
| Bash | 1,485 | command 100% · description 100% · timeout 3% |
| Read | 592 | file_path 100% · limit 59% · offset 55% |
| Edit | 540 | file_path / old_string / new_string 100% · replace_all 31% |
| Write | 53 | file_path / content 100% |
| Skill | 34 | skill 100% · args 24% |
| bash（omp，小写） | 19 | command / timeout / i，无 description |
| SendMessage | 19 | summary / message / to 100% |
| SubagentHandback | 14 | message 100% |
| Agent | 10 | subagent_type / description / prompt 100% |
| ToolSearch / ListAgents | 5 / 5 | query+max_results / 空对象 |
| WebFetch / TaskStop / SendFeedback / AskUserQuestion | 各 1 | 各自形状 |

用户点名的「Subagent」在数据里是 `Agent`，与 `SendMessage`、`SubagentHandback` 同属子代理协作族。MCP 工具（`mcp__server__method` 形态）本库尚未出现，按开放集合处理。

## Decision

### 一行摘要：toolSummary 按工具分派

`toolSummary(name, inputText)` 仍是 `web/trace-view.js` 的纯函数，签名不变；内部拆成 `summaryParts`（身份 + 参数段），chip 与预览各取一段。文件类参数一律 basename（取路径最后一段），完整路径与参数进悬停 title 与右栏。逐工具格式：

| 工具 | 行内格式 | 规则 |
| --- | --- | --- |
| Read | `Read · queries.ts · 1400–1530 行` | offset+limit 折算区间；只有 limit → `前 130 行`；只有 offset → `1400 行起`；都没有 → 只文件名 |
| Edit | `Edit · derive.ts · 42→18 行` | old_string 与 new_string 的行数对比（按换行计，空串 0 行）；`replace_all=true` 追加 `· 全部替换` |
| Write | `Write · memory.md · 1.2 KB` | content 字节数，不足 1KB 显示 B，其余 KB 一位小数，满 1 MB 用 MB |
| Bash / bash | `Bash · 重跑全量测试` | description 优先；缺失取 command 第一个非空行 |
| Skill | `Skill · ponytail · 打开本地页面截图` | skill 名必有；args 非空时追加（共享 140 预算） |
| Agent | `Agent · general-purpose · 核对派生方案` | subagent_type 加 description |
| SendMessage | `SendMessage · 收束结论 → ab12cd34` | summary 加收件方 id 前 8 位 |
| SubagentHandback | `SubagentHandback · 消息首行` | message 首行 |
| WebFetch | `WebFetch · github.com/owner/repo` | url 去协议前缀 |
| ToolSearch | `ToolSearch · select:SendMessage` | query 原样 |
| 其他 / 未识别 / MCP | 回退链保留 | command→cmd→file_path→path→pattern→原文；file_path 与 path 同样 basename 化 |

核心键缺失的已知工具（如 Read 无 file_path）回落回退链，不冒充文件摘要。140 字符截断保留，只作用于参数段，工具名与 basename 不截；悬停 title 放完整参数 JSON（超 2000 字符截断，避免大参数撑爆属性）。行区间是显示折算不是事实断言：offset 的基数语义因客户端而异，区间只作扫读锚点，悬停与右栏仍给原始键值。

### 结果行带调用方前缀

后端零改动：`RequestDetail.tool_results` 本身携带 `tool_name`，结果步骤把配对索引里的 `tool_name` 带上（`TraceStep.toolName`），缓存外仍可知工具名。前缀分三级：

1. **配对确认且调用方在窗口缓存**（装配层以 `store.peekRequest` 提供调用方摘要查询）：chip 显示与调用行同款的 `工具名 · 参数段` 摘要，结果正文紧随其后，chip 与正文间用 muted 的 `→` 分隔。
2. **配对确认但调用方不在缓存**：chip 只显示工具名，颜色仍按该工具。
3. **未配对**：中性 chip 显示 `Tool result`（现状文案），不猜归属。

### 工具强调色

- `web/body-view.js` 新增 `toolTint(name)`：与 `partColor` 同属共享显示原语。映射 `tint-read / -edit / -write / -bash / -skill / -agent / -other` 七个色类；`index.html` 对应 `--tool-*` 七个色对（前景加背景，亮暗两套），背景沿用 `--k-*` 的 0.11–0.14 透明度模式。色相：Read 蓝、Edit 橙、Write 紫、Bash 红、Skill 黄、Agent 绿、其他青灰。
- 不复用 `--p1..p6`：那是上下文组成条的固定槽位，两套语义不混。
- 中栏应用位：调用行 chip 显示工具名、结果行按三级前缀，取代 `Tool call` / `Tool result` 文字小标（`row-kind` 类删除）。配对 result 沿用 call 的颜色，未配对用 `--tool-other`。
- 右栏应用位：配对页 Call 与 Result 面板头（`bp-kind`）与正文页 `tool-chip.call`（工具往返折叠行、工具页列表）换用同款色类，配对页 Call 面板头的工具名不再在 `bp-meta` 重复；Result 面板头配对确认后显示工具名并沿用 call 色类，未确认保持中性 `Tool result`。
- 角色标签 `User` / `Assistant` / `Tool` / `System` 的文案与配色不动。颜色只承载工具身份一个语义：正常态无装饰，异常才着色。

### 失败异常态、Edit 对照与悬停

- 结果块 `is_error=true` 时中栏结果行整行给 warn 软色（`--warn-soft`），配对页 Result 面板整块同样给 warn 软色，符合「异常才出现标签」的既有界面立场；正常行与正常面板不新增状态元素。
- 配对页 Call 面板对 Edit 调用把 `old_string` 与 `new_string` 各渲染成一个着色块（红绿 soft 背景、等宽字体，块上小标签写协议键名；空串不渲染），其余键维持缩进 JSON，原始参数 JSON 按调用身份折叠保留；非 Edit 或参数不可解析回退整段缩进 JSON。纯显示层。
- 中栏行悬停给完整信息：调用行 title 放完整参数 JSON，结果行 title 放完整结果正文。

## Alternatives considered

**Read 参数键值对原样显示（`offset 1400 · limit 130`）。** 用户选了行区间：键名是协议细节，扫读要的是范围；精确键值已在悬停与右栏。

**Bash 显示命令首行。** 更客观，但命令常带管道与转义，一行装不下；description 是 agent 自述意图且 ZCode 侧 100% 携带。omp 的 bash 无 description，回落路径保留命令首行。

**结果行只带工具名。** 后端零成本，但看不出是哪个文件的结果；调用方在缓存内时摘要成本同样为零，降级路径明确，收益大于复杂度。

**文件类同色系（Read/Edit/Write 共用色相不同明度）。** 更克制，但读、改、建恰是扫读时最需要区分的三类动作；六色独立是用户选择。

**摘要进派生层（tool_call 持久化 input_summary 列）。** 否决：显示字符串入库会把展示格式绑进派生版本；「解释只影响显示」是既定边界（正文分页的 interpretations 同一立场），前端按窗口现算，成本可忽略。

**相对 cwd 显示路径。** 读模型未暴露 cwd（`raw_hook` 有列但不在 request 详情），且 cwd 覆盖不完整（zcode 侧实测全空，见[zcode 支持提案](../../proposed/feature/2026-10-24-zcode-agent-support.md)边界外）；basename 加悬停全路径不依赖它。

**MCP 工具逐个配色。** 否决：开放式集合逐个配色永远追不完；统一中性色即可辨识为「其他工具」。

## Consequences

中栏扫读时 Read/Edit/Bash 行一眼可辨，连续 call 与 result 行按摘要成对；代价：跨窗口或正文已回收时结果行只有工具名，与同屏其他行观感不同（显示层降级不影响配对事实）；行内同时有角色标签与工具 chip 两个着色元素，chip 沿用 row-label 的尺寸与低饱和背景、不加图标来压制风险。description 是显示优先级不是事实来源，命令全文始终在悬停与右栏。区间折算若发现客户端间基数不一致，回落为只显示起点不含终点。核心工具清单是开放决定：新工具（尤其 MCP）落入「其他」无需改代码，增删色相是后续 note 的事。

## Testing

`bun test tests/trace-view.test.ts tests/trace-pair.test.ts tests/body-view.test.ts`（79 项）与 `bun run typecheck` 通过（2026-10-25）。覆盖：逐工具摘要断言（Read offset/limit 四种组合、Edit 含与不含 replace_all、Bash 有与无 description、Skill 有与无 args、协作与查询工具、非 JSON 参数回退原文、未知工具回退链、截断只作用参数段）；结果行三级前缀各有用例（缓存命中给摘要带箭头、缓存外只工具名、未配对中性 chip）；chip 色类映射（六核心工具、bash 小写、其他统一，配对面板头配对后与 call 同色）；`is_error=true` 的中栏行与 Result 面板带异常态类而正常态没有；Edit 对照块、其余键缩进 JSON 与原始 JSON 折叠键；调用行悬停放完整参数 JSON；参数文本含 HTML 字符仍转义（既有断言保持）。
