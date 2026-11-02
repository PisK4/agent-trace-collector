# Agent Note: 方向 A 第 5 步——工具列表页与配对页

Status: implemented

后续：[方向 A 对齐修正](../bug-fix/2026-11-02-direction-a-alignment-audit.md)补充列表失败色、执行窗口与可用摘要；本记录的角色标、分段控件和证据定位继续有效。

## Problem

[方向 A 重制提案](../../proposed/feature/2026-11-02-frontend-direction-a-restyle.md)第 5 步：工具列表页逐行带一枚彩色工具名 chip，同一名字在页头、每行重复 N 次；页头没有总数与失败数，要数行才知道规模。配对页两个片段靠彩色 chip 区分角色，中间一行大号「↓ 上一条请求的返回」占据视觉主线；概览/参数/配对/Schema 四个标签是松散文字按钮。

## Decision

- **列表页删逐行工具名 chip**：工具名只在页头出现一次（「read_file 的调用」）；行内改为 `调用 #N`（mono 强调）+ 右侧来源标签（`requestLabel`，mono 弱化）。未配对的行保留状态标（`tool-chip miss`，pairStateText），它是这条行独有的信息，不属于重复。
- **页头补计数与失败数**：`.cnt` 从首页汇总对组取数——工具组带 `errors`（红字由 `.cnt` 内失败段承担），Skill/路径/中断组只有次数；对不上组时回退条目数。取数键 `param` 是分组键本身（工具名、路径、Skill 名），展示文案 `label` 单独存。
- **窗口外整行弱一档**：`labelOf` 返回 `{text, dim}`，dim 判定是窗口内标签函数给出的「（未在窗口）」后缀；`.tool-row.dim` opacity .55。列表页不隐藏窗口外条目——它们仍是这个组的支撑记录，只是当前窗口读不到正文。
- **配对页角色标与连接语**：两个片段的头部从彩色 chip 换成 `.frole` 角色标（「调用」「结果」加粗 + 来源路径与请求号 mono 弱化）；中间连接语换 `.pair-arrow`（10.5px 弱灰，仅在已确认配对且结果承载已知时出现）。结果面板头在 is_error=true 时仍整块 `pair-error` 软色。
- **tool-page-tabs 分段控件化**：概览/参数/配对/Schema 改 inset 槽内浮起选中，与第 3 步筛选器同一语言。
- **合成服务器补 `/summary/entries` 路由**：tool 从池内 `toolCalls` 派生（天然带 pending/unpaired 状态），interrupts 取合成汇总，written/read/skill 返回静态条目——此前列表页永远「读取失败： http_404」，第 5 步无法目测。

## Deviation from proposal

提案写行内可放「首段参数摘要」，实际 `tool_call` 表没有 input_text 列，`SummaryEntry` 不携带参数文本。决定不动数据层：行内放调用序号，参数摘要在配对页读。列表行因此更轻，但「不点开分辨不了两次同名调用」的代价存在，靠右侧请求标签缓解。此取舍已由[汇总条目补执行段与已有参数摘要](../bug-fix/2026-11-02-summary-entry-exec-and-arg.md)部分取代：条目现在带已提取的 `arg_path`/`arg_skill` 摘要与 `exec_ms`，仍不读正文。

## Alternatives considered

- **行内也显示文件路径**（read/written 列表）：路径组页头已是路径本身，行内再放路径是同一事实第二遍；调用序号 + 请求号足够定位。
- **group 取数继续用 `list.param` 存展示标签**：本次实现里第一版把 `param` 传成了 `${name} 的调用`，对组永不命中、失败数恒 0，且真实后端同样中招（合成数据 curl 对比抓到）；修复即 decision 第二条的「param 是分组键」。教训是测试直接传 meta 测不到这条装配路径，对组正确性靠合成页面目测补位。

## Testing

- `bun run typecheck` 通过；`tests/trace-pair.test.ts`（frole 单次出现、pending 不出连接语、转义）、`tests/web.test.ts`（调用序号、miss 标、dim 行、cnt 文案）共 52 用例全过。
- 合成服务器目测（`/tmp/atc-restyle/step5-{list,pair}.png`）：列表页工具名只出现一次、页头「3 次 · 1 次失败」与首页 chip 一致、两行未配对状态标可见；配对页角色标、弱化连接语、分段控件、错误软色可见。
- dim 行在合成池无样本（五笔全在窗口内），由 web.test.ts 的 dim 断言覆盖。

## Consequences

- **列表页信息密度下降**：扫一眼分辨两次同名调用要靠请求号，不能靠参数；对单工具调用多的会话（读同一文件多次）定位成本略升，配对页兜底。
- **`param` 语义收紧为分组键**：后续给 summaryList 加消费点时按 kind 分流取组，不再从展示文案反解。
- **entries 静态条目（written/read/skill）是手写 ord**：点进配对页若无对应调用由 `railTools()` 兜底回列表，不阻塞验收。
