# Agent Note: pretty-trace——中栏工具行摘要、结果前缀与工具强调色

Status: proposed

显示层提案，不涉后端、schema 与派生。承接三篇既有记录：[单行步骤投影 trace-view](../../implemented/feature/2026-10-24-trace-step-projection.md) 拥有 `toolSummary` 与行内标签的现状（本文部分改写其显示事实，落地时同批同步该记录并保持交叉链接），[Trace Pair 配对页与右栏就地阅读](../../implemented/feature/2026-10-24-trace-pair-rail-page.md) 拥有配对页布局，[中栏只呈现内容，详情集中右栏](../../implemented/simplification/2026-10-24-trace-content-only-and-wide-rail.md) 定了行内取舍边界。四项格式决策已与用户对齐（2026-10-24），见「已对齐的决策」。

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

## 已对齐的决策（2026-10-24，用户确认）

| 决策点 | 选择 |
| --- | --- |
| Read 参数显示 | 行区间折算（`1400–1530 行`），不显示键值对 |
| Bash 主显示 | description 优先，缺失回落命令首行 |
| 结果行前缀 | 工具名加参数摘要；调用方不在窗口缓存时降级为只工具名 |
| 强调色 | 六色独立（Read/Edit/Write/Bash/Skill/Agent 各一色相），其他工具统一中性强调色 |

## Proposal

### 一行摘要：toolSummary 重写为按工具分派

函数签名不变（`toolSummary(name, inputText)`），仍是 `web/trace-view.js` 的纯函数。文件类参数一律 basename（取路径最后一段），完整路径与参数进悬停 title 与右栏。逐工具格式：

| 工具 | 行内格式 | 规则 |
| --- | --- | --- |
| Read | `Read · queries.ts · 1400–1530 行` | offset+limit 折算区间；只有 limit → `前 130 行`；只有 offset → `1400 行起`；都没有 → 只文件名 |
| Edit | `Edit · derive.ts · 42→18 行` | old_string 与 new_string 的行数对比；`replace_all=true` 追加 `· 全部替换` |
| Write | `Write · memory.md · 1.2 KB` | content 字节数，KB 一位小数，满 1 MB 用 MB |
| Bash / bash | `Bash · 重跑全量测试` | description 优先；缺失取 command 第一个非空行 |
| Skill | `Skill · ponytail · 打开本地页面截图` | skill 名必有；args 存在时追加截断 |
| Agent | `Agent · general-purpose · 核对派生方案` | subagent_type 加 description |
| SendMessage | `SendMessage · 收束结论 → ab12cd34` | summary 加收件方 id 前 8 位 |
| SubagentHandback | `SubagentHandback · 消息首行` | message 首行 |
| WebFetch | `WebFetch · github.com/owner/repo` | host 加 path 截断 |
| ToolSearch | `ToolSearch · select:SendMessage` | query 原样 |
| 其他 / 未识别 / MCP | 现有回退链保留 | command→cmd→file_path→path→pattern→原文；file_path 与 path 同样 basename 化 |

行区间是显示折算不是事实断言：offset 的基数语义因客户端而异，区间只作扫读锚点，悬停与右栏仍给原始键值。140 字符总截断保留，截断只作用于参数段，工具名与 basename 不截。

### 结果行带调用方前缀

后端数据已给齐，零改动：`RequestDetail.tool_results` 的 SQL 本身携带 `tool_name`（`src/queries.ts` 的 `toolResultsFromSync`）。前缀分三级：

1. **配对确认且调用方在窗口缓存**（reader-store 已持有该请求的正文页）：按 `pairOwner.reqId + callOrd` 找调用块，chip 显示与 call 行同款摘要，结果正文紧随其后，chip 与正文间用 muted 的 `→` 分隔。
2. **配对确认但调用方不在缓存**：chip 只显示工具名。
3. **未配对**：中性 chip 显示 `Tool result`（现状文案），不猜归属。

### 工具强调色

- 新增 `--tool-read / -edit / -write / -bash / -skill / -agent / -other` 七个色对（前景加背景，亮暗两套），背景沿用现有 `--k-*` 的 0.10–0.13 透明度模式。色相方向：Read 蓝、Edit 橙、Write 紫、Bash 红、Skill 黄、Agent 绿、其他青灰；具体色值实现时按现有调色板校验可读性后定。
- 不复用 `--p1..p6`：那是上下文组成条的固定槽位，两套语义不混。
- 应用位置：中栏行内 chip（取代 `Tool call` / `Tool result` 文字小标 `row-kind`）、右栏配对页 Call 与 Result 面板头（`bp-kind`）、正文页 `tool-chip.call`。配对 result 沿用 call 的颜色，未配对用 `--tool-other`。
- 角色标签 `User` / `Assistant` / `Tool` / `System` 的文案与配色不动。颜色只承载工具身份一个语义：正常态无装饰，异常才着色。

### 伴随项

- **失败异常态**：结果块 `is_error=true` 时，中栏行与配对页 Result 面板给 warn 软色（`--warn-soft` 家族），符合「异常才出现标签」的既有界面立场。
- **悬停完整信息**：中栏行 `title` 放完整参数 JSON（或完整路径、完整命令），零组件成本。
- **配对页 Edit 对照渲染**：Call 面板对 Edit 把 `old_string` 与 `new_string` 各渲染成一个着色块（红绿 soft 背景、等宽字体），其余键维持缩进 JSON；原始 JSON 折叠保留。纯显示层。

## Alternatives considered

**Read 参数键值对原样显示（`offset 1400 · limit 130`）。** 用户选了行区间：键名是协议细节，扫读要的是范围；精确键值已在悬停与右栏。

**Bash 显示命令首行。** 更客观，但命令常带管道与转义，一行装不下；description 是 agent 自述意图且 ZCode 侧 100% 携带。omp 的 bash 无 description，回落路径保留命令首行。

**结果行只带工具名。** 后端零成本，但看不出是哪个文件的结果；调用方在缓存内时摘要成本同样为零，降级路径明确，收益大于复杂度。

**文件类同色系（Read/Edit/Write 共用色相不同明度）。** 更克制，但读、改、建恰是扫读时最需要区分的三类动作；六色独立是用户选择。

**摘要进派生层（tool_call 持久化 input_summary 列）。** 否决：显示字符串入库会把展示格式绑进派生版本；「解释只影响显示」是既定边界（正文分页的 interpretations 同一立场），前端按窗口现算，成本可忽略。

**相对 cwd 显示路径。** 读模型未暴露 cwd（`raw_hook` 有列但不在 request 详情），且 cwd 覆盖不完整（zcode 侧实测全空，见[zcode 支持提案](2026-10-24-zcode-agent-support.md)边界外）；basename 加悬停全路径不依赖它。

**MCP 工具逐个配色。** 否决：开放式集合逐个配色永远追不完；统一中性色即可辨识为「其他工具」。

## Acceptance criteria

合成数据（不碰真实正文）：

1. 摘要断言逐工具覆盖上表：Read 的 offset 与 limit 四种组合、Edit 含与不含 replace_all、Bash 有与无 description、Skill 有与无 args、非 JSON 参数回退原文、未知工具回退链。
2. 结果行三级前缀各有用例：缓存命中给摘要、缓存外只工具名、未配对中性 chip。
3. chip 颜色类映射：六个核心工具各自色类、其他工具统一色类、配对 result 与 call 同色。
4. `is_error=true` 的行带异常态类；正常行无新增状态元素。
5. 转义不回退：参数文本含 HTML 字符仍转义（既有断言保持）。
6. `bun test`（相关测试文件）、`bun run typecheck`、`bun run verify:notes` 通过。

人工验收（真实数据不进测试）：本机近期会话中栏扫读——Read/Edit/Bash 行一眼可辨、连续 call 与 result 行成对、配对页 Edit 对照块可读。

文档同步：`docs/architecture-design.md` 轨迹阅读布局段落改为现状描述（工具名 chip、彩色规则、结果行前缀）；[单行步骤投影 trace-view](../../implemented/feature/2026-10-24-trace-step-projection.md) 同批更新其显示事实（`toolSummary` 摘要形态与行内标签描述）。

## Risks

- **区间折算的语义近似。** offset 的基数语义（0 起或 1 起）因客户端而异，区间只作锚点；悬停给原始键值，右栏给完整参数。若发现客户端间基数不一致，回落为只显示起点不含终点。
- **着色元素变多。** 行内同时有角色标签与工具 chip 两个着色元素，违反克制原则的风险真实存在：chip 沿用 row-label 的尺寸与低饱和背景，不加图标。
- **description 失真。** agent 自述可能空泛或不准；它是显示优先级不是事实来源，命令全文始终在悬停与右栏。
- **降级路径的观感不一致。** 跨窗口或正文已回收时结果行只有工具名，与同屏其他行不同；可接受，显示层降级不影响配对事实。
- **核心工具清单是开放决定。** 新工具（尤其 MCP）落入「其他」无需改代码；增删色相是后续 note 的事。

## 边界外

- 会话列表 `input_preview` / `reply_preview` 是服务端派生列，本提案不动派生层。
- Bash 长输出的结果摘要策略（首行还是行数）、连续同文件分页 Read 的视觉成组：待本提案落地后按实际阅读体验另议。
- 工具用量统计、按工具过滤会话：未讨论，不预建。
