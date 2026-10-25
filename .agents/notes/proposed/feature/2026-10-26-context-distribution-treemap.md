# Agent Note: 读数页上下文分布 treemap（引入 magpie 上下文窗口特性）

Status: proposed

## Problem

读数页「用量与上下文」折叠行（[计时与用量并入「用量与上下文」折叠行](../../implemented/simplification/2026-10-24-usage-ledger-fold.md)）目前用一根一维构成条回答「上下文里装了什么」：七段颜色加图例，到类为止。但类以下的明细——哪个文件吃掉了 8K、Bash 结果占了 27K、第几轮对话膨胀到 74K——已经完整躺在 `request.parts_json` 里（magpie 路由侧 `prompt.parts[]` 原样透传，含每类 `items: [{name, tag, n, tokens}]`），界面上却没有任何出口。想回答「这次请求为什么这么大」只能去翻正文。

magpie 自 10-24 起在其 Routing 页提供了成熟的对应物：每个请求一张上下文窗口卡，两层 treemap（类一层、item 一层）加明细列表（`internal/gui/assets/context.js`，本仓调研锚定 magpie@`3173440c`）。它证明了这个视图的形态可行，且其全部数据输入 ATC 已在采集。本提案把这张卡引入读数页，同时收掉一个口径旧账：前端类别清单硬编码六类，magpie 已拆出第七类 `skills`，未来类别还会变。

## Proposal

分两步交付，另有一个不做进本次的展望：

- **P0（口径修复）**：前端类别渲染从硬编码六类改为按 `parts` 数据实际出现的 kind 动态渲染；新增第七色槽 `--p7` 承载 `skills`；`memory` 标签从「记忆与技能」改回「记忆」。
- **P1（treemap 卡片）**：`safePrompt` 白名单扩展出 item 级明细；「用量与上下文」折叠行展开态在构成条之下新增 treemap 与内容列表，折叠态维持现状不动。
- **P2（展望，不在本提案范围）**：会话纵向构成图（每笔请求一列、类着色的堆叠条，看上下文随会话生长）。落点在会话头汇总（[会话信息汇总](../../implemented/feature/2026-10-25-session-trace-summary.md)），届时另立提案。

## 数据链路与证据

数据不需要新增采集，链路每一环都已存在并通过守恒验证：

- magpie 网关在请求期用启发式把请求正文分进七类（`system/tools/skills/memory/files/results/chat`，`internal/gateway/prompt.go:31-41`），token 为估算（ASCII 4 字符、CJK 1 字符计 1，图片固定 1600）；vendor 回答后按实测 `in + cache_read + cache_write` 等比校准（`calibrate`，同文件 :308），并记录模型窗口。每类保留至多 24 个 item，超限合并为 `other`，对话的较早轮次合并为 `earlier`（:74,:216-237）。**只存名字，不存正文。**
- 校准后的完整 `Route`（含 `prompt` 字段）追加落盘到 `~/.config/magpie/routing/<date>.jsonl`（`internal/gateway/history.go:82-108`，30 天滚动），ATC 路由通道已在增量读取（jsonl 游标 + gz 指纹）。
- ATC 侧：`mapRouteRow` 把 `prompt.parts` 整树透传（`src/sources/magpie/mapping.ts:352`）；投影取 `time_ms` 唯一最大的 route、同毫秒并列写 `conflict` 不更新（`src/sources/projection.ts:472-490`）；`request` 表已有 `prompt_tokens/prompt_counted/prompt_window/prompt_turns/parts_json` 五列（`src/schema.sql`）。原始路由 7 天过期不影响已落列的分解。
- 守恒验证（架构设计「三通道连接质量」）：`sum(parts[].tokens) = prompt.tokens` 为 4,287/4,287；`prompt.tokens = in + cache_read + cache_write` 为 99.60%（17 条偏差里 16 条是 499 客户端取消）。
- **口径漂移是既成事实**：本机存量 14,679 行 parts 全部是六类（skills 当时归 memory）；magpie `83234fe9`（10-24）拆出第七类后，新行七类、旧行六类并存。动态渲染是必需项而非优化项。
- `prompt_counted = 0` 的行（vendor 未答或请求取消）parts 是未校准估算，展示须与校准行区分精度。

## P0：动态类别渲染与第七色槽

改动文件：

- `web/rail-facts.js:21-28`：`PARTS` 常量降级为「已知 kind 的元数据映射」（label + 色槽），不再是渲染依据。渲染循环遍历 parts 数据实际出现的类别；未知 kind 原样显示 kind 名、颜色落 `--p-unknown`（此兜底 9518e14 已建立，保留）。映射补 `skills: 技能`，`memory` 标签改「记忆」。
- `web/app.css`（亮色 `:root`、暗色 media、暗色 `[data-theme]` 三处，:26-27/:51-52/:67-68）与 `web/index.html` 内联变量处：新增 `--p7`。亮 `#30287e`、暗 `#3d3480`（同属靛色族，亮暗是成对表面）。
- `tests/body-view.test.ts:524-535`：断言更新为三条——七类各得正确槽位（含 `skills → var(--p7)`）、六类旧数据（无 skills）照常渲染、未知 kind 保名加灰变。

`--p7` 的取值依据（OKLab ΔE×100，Machado 2019 三类色盲模拟下与既有六槽加 unknown 的**全部配对**取最小值）：亮 `#30287e` 最差对 12.1（vs `--p6` 深绿），暗 `#3d3480` 最差对 9.6（vs `--p5` 粉），均过 ≥8 线。最初候选紫 `#7c4dc4`/`#a78bea` 与蓝槽 `--p1` 最小距离仅 5.9/3.8，弃。

已知且有意不在本提案处理的旧账：既有 `--p1..--p6` 全配对校验下存在多个 CVD 距离 <8 的对（橙 `--p2` 与绿/金/粉/深绿最低 2.7，暗色更多）。本提案用辅助编码补位（tile 文字标签、图例名字、tag 徽标），颜色不是唯一通道；彻底重排六色是独立的一笔，见 Risks。

## P1：safePrompt 明细白名单与 treemap 组件

**后端（唯一改动点）**：`src/queries/routes.ts:113-133` 的 `safePrompt` 目前把 `parts[].items` 与 `turns/held` 剥掉（`docs/atc-real-format-research.md:216` 记录在案的已知损失），前端因此只能从详情接口的原始 `parts` 字段（`src/queries/requests.ts:288`，`parseJsonOrNull(parts_json)` 原样透出）拿明细。本提案把 `PromptReading.parts[]` 白名单扩为：

```ts
{ kind: string; tokens: number; items?: { name: string; tag?: string; n?: number; tokens: number }[] }
```

仍是纯标量白名单，延续「视图按白名单挑标量、不返回原始 JSON」的既定原则；同时带回 `turns`。`promptReadingOf` 与 `PromptReading` 类型（`src/queries/readings.ts:39-51`）同步扩展。详情接口的原始 `parts` 字段去留在实现时决定（见 Acceptance criteria 第 6 条）。

**前端**：新模块 `web/context-map.js`，纯函数拼 SVG 字符串（与 `rail-facts.js` 同一模式，不碰 DOM、可直接断言输出）。`usageFoldHtml` 展开态在构成条与图例之下插入 treemap 与内容列表，折叠态摘要维持现状。

布局算法从 magpie `internal/gui/assets/context.js:264-371` 移植（squarify，Bruls et al.）并适配 SVG 输出：

- 第一层按类、第二层按类内 items 两次 squarify；item 面积占比小于阈值不进第二层，整类一块。
- 可读性参数沿用 magpie：`TILE_MIN 1500 / TILE_MAX 12 / TILE_FLOOR 700`（px² 语义），碎项合并为「另外 N 项」一块。
- 有窗口时已用区与空闲区按 `share^0.35` 缓动分区（低占用时已用区仍可读，高占用时接近线性），空闲块用 inset 底色加虚线边，太窄不落文字。
- tile 间 2px 表面缝；文字色按底色相对亮度取深/白；放不下文字的块只靠图例与悬停。
- 悬停联动：tile 与内容列表行双向高亮，tooltip 给类名、item 名与 token 占比。
- 特殊 tag 渲染：`more` → 「另外 N 项」、`turns` → 「更早 N 轮」、`turn` → 「第 N 轮」；`n > 1` 的聚合项（MCP server、×N 工具结果）显示 ×N。

状态语义（沿用[计时与用量并入「用量与上下文」折叠行](../../implemented/simplification/2026-10-24-usage-ledger-fold.md)的规则一：异常才提醒）：

- `counted = 0`：构成区加一行「本地估计」注记，不渲染「已校准」类常驻标签。
- 窗口未知（`prompt_window` 为 NULL）：不出占用率、不出空闲块，treemap 全幅铺已用部分，u-total 显「窗口未知」。
- 占用 ≥75% 出「接近占满」、≥90% 出「占满」warn 软色 pill；正常态零状态提示。

## 设计原型

交互原型（自包含单文件 HTML，四种数据状态与两档栏宽可切换）在父知识库：`Agent知识库/Agent工具/agent-trace-collector/2026-10-26-context-map-demo.html`。仓库外参考物，不是交付物；其 `squarify/tilesOf` 与四种状态的合成数据可直接作为移植底稿。原型发布前已用 node 对布局函数跑过守恒断言（三档宽度 × 四状态：tile 界内、每类有面积、有窗口必有空闲块、`sum(parts) = tokens`，全部通过）。

## 交付记录

- 2026-10-26 P0 已交付：`web/rail-facts.js` 的 `PARTS` 降级为 kind→标签+色槽的元数据映射（`partColor` 按槽位名取色，不再按数组下标），`skills` 补入映射落 `--p7`，`memory` 标签改「记忆」；`web/app.css` 三处主题块加 `--p7`（亮 `#30287e`、暗 `#3d3480`）。构成条与图例本就遍历 parts 数据渲染，六类旧行与七类新行自此同屏各自正确。实现时确认 `web/index.html` 并无内联调色板变量（方案写作时的笔误），`--p7` 只落在 app.css 三处。

## Alternatives considered

**移植 magpie `promptOf` 在 ATC 侧从 hook 正文重算分类。** 数据上可行（hook 通道存有完整请求正文与协议），但分类是 magpie 的派生事实，ATC 是只读观测者，重算违背「一个事实一个家」；hook 正文有 `partial/truncated` 态，重算会把不完整正文当事实；magpie 的启发式仍在周级迭代（10-24、10-25 连续改动），自算版本要永久跟跑。落选。

**调用 magpie `GET /api/context` 取现成聚合。** 引入对 GUI 进程存活的时序耦合，违背本仓文件采集架构（增量读取协议、游标、代际）。落选。

**前端直接消费详情接口已有的原始 `parts` 字段，后端零改动。** 零成本但绕过「视图按白名单挑标量」原则（架构设计读模型一节），把一个已记录在案的不一致继续固化。折中为：P1 扩白名单，原始字段去留给实现时决断。部分采纳（见 Acceptance criteria 第 6 条）。

**把 magpie Usage 页 Context tab 的 agent 打分（cache/lean/pace/reliable 四维）一并引入。** 那是多 agent 客户端仪表盘的场景；ATC 是单机会话轨迹阅读器，没有多 agent 对比面。落选；会话纵向图（P2）才是 ATC 对应的差异化视角。

**重排或微调 `--p1..--p6` 一并修 CVD 低距对。** 既有六槽是已校验发布物，重排会改变所有现存截图与用户认知，且与本特性目标正交。本提案只加槽不动画六色，低距对用辅助编码补位，重排留独立提案。落选（本轮）。

## Acceptance criteria

1. 六类旧口径行与七类新口径行在同一会话中并存时，各自正确渲染：后者 `skills` 得「技能」标签与 `--p7` 色。`memory` 标签统一显「记忆」——六类旧行的 memory 里含未拆出的 skills，但行上无标记可区分，不再对旧行显示「记忆与技能」，接受这一显示精度损失。
2. 构造含 `other`/`earlier` 折叠桶与 `n > 1` 聚合项的合成 parts，treemap 与列表的渲染符合「特殊 tag 渲染」约定。
3. `counted = 0` 行出现「本地估计」注记；窗口 NULL 行无占用率、无空闲块；占用 ≥75% 出 pill，<75% 正常态零状态提示。
4. treemap 布局守恒断言进测试：tile 界内、每类有面积、`sum(parts) = tokens`、有窗口必有空闲块（多档宽度）。
5. `safePrompt` 扩展后 `PromptReading.parts[]` 携带 items 白名单字段，typecheck 通过，现有读数测试更新后全绿。
6. 实现时决断并记录：详情接口原始 `parts` 字段是保留（标注为非白名单口径）还是移除（调用方全走 `prompt.parts`）；决断写进本 note 的 implemented 版本。
7. `bun run verify:notes`、`bun run typecheck`、相关测试文件全绿；真实恢复数据浏览器验收一次（构成条与 treemap 数字与 u-total 互证一致）。

## Risks

- **magpie 继续改分类口径**：第八类、item 折叠规则变化都会再来一次。动态渲染把每次变化的代价压到「加一行标签映射」，但白名单扩展后的 `PromptReading` 若 magpie 改 items 字段形状仍需跟改——这是吃 magpie 派生事实的固有成本，接受。
- **估算行的展示误导**：`counted = 0` 行的类占比是按正文估算再缩放的，「本地估计」注记是唯一的精度区分，若渲染上与校准行过于同质，读者会当成精确值。注记必须贴着构成区而非藏在折叠深处。
- **既有六槽的 CVD 低距对**：本提案不修，treemap 里橙与绿、金与粉在色觉障碍下靠文字标签区分。若后续审计认为不够，重排六色是独立变更。
- **窄栏可读性**：340px 下限宽度处小类压成横条、高占用时空闲块极窄，是 squarify 固有形状（原型已验证），靠悬停与图例补位；不接受为此引入 min-width 撑破右栏预算。
- **item 点击看正文**（magpie 有，本提案不做）：item 名字到正文块的映射有同名歧义与跨请求成本，P1 只到名字与占比。放弃的能力记录于此，重开条件是正文定位（`request.system`、消息 ordinal）出现稳定需求。
