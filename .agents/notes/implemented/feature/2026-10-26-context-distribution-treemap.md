# Agent Note: 读数页上下文分布 treemap（引入 magpie 上下文窗口特性）

Status: implemented

## Problem

读数页「用量与上下文」折叠行用一根一维构成条回答「上下文里装了什么」：七段颜色加图例，到类为止。类以下的明细——哪个文件吃掉了 8K、Bash 结果占了 27K、第几轮对话膨胀到 74K——已经完整躺在 `request.parts_json` 里（magpie 路由侧 `prompt.parts[]` 原样透传，含每类 items），界面上却没有任何出口。想回答「这次请求为什么这么大」只能去翻正文。

magpie 自 10-24 起在 Routing 页提供对应物：每个请求一张上下文窗口卡，两层 treemap（类一层、item 一层）加明细列表（`internal/gui/assets/context.js`，锚定 magpie@`3173440c`），其全部数据输入 ATC 已在采集。另有一笔口径旧账：前端类别清单硬编码六类，magpie 已拆出第七类 `skills`，本机存量行（六类）与新行（七类）并存。

## Decision

分两步交付。P0 修口径：类别渲染按 `parts` 数据实际出现的 kind 动态进行，`web/parts.js` 持有 kind→标签+色槽的元数据映射（`PARTS/partLabel/partColor/partSlot/kk`），未知 kind 保名落 `--p-unknown`；第七色槽 `--p7` 承载 skills（亮 `#30287e`、暗 `#3d3480`，OKLab CVD 配对距离最差 9.6–12.1，过 ≥8 线），`memory` 标签改「记忆」。六类旧行的 memory 含未拆出的 skills 但行上无标记可区分，接受这一显示精度损失。

P1 交付明细视图。后端把 `safePrompt` 白名单扩到 item 级（`name/tag/n/tokens` 四标量）并带回 `turns`，投影逻辑抽成 `safePromptParts` 供 route_summary 的 `z` 与 request 落列 `parts_json` 共用；`PromptReading` 同步扩展。**详情接口的原始 `parts` 字段移除**——前端与 prototypes 均无消费者，保留只会把非白名单口径继续固化，调用方全走 `prompt.parts`；`parts_json` 列不动，仍是投影落列与 legacy fallback 的输入。

读数页折叠行展开态在构成条之下加 treemap 与内容列表（`web/context-map.js`，纯函数拼 SVG 字符串，不碰 DOM）。布局移植 magpie 的两层 squarify（可读性参数 TILE_MIN 1500 / TILE_MAX 12 / TILE_FLOOR 700）：类一层、item 一层，碎项并「另外 N 项」，有窗口时已用区按 `share^0.35` 缓动分区（低占用时已用区仍可读，高占用时接近线性），空闲块 inset 底色虚线边。SVG 横向用百分比、纵向固定像素（标称 340×132）：tile 边界随右栏宽度伸缩而文字字号不变；文字按像素宽估算截断，每 tile 一个 clipPath 兜底。tooltip 用原生 `<title>`（tile 与列表行都带「类 · 名 · tokens · 占比」），「显示全部」用 `<details data-fold>` 接既有折叠恢复机制。tile 与列表行经 `data-ctx-key` / `data-ctx-its`（成员清单）双向悬停高亮，app.js 文档级 pointerover/pointerout 委托，零新增模块级状态。特殊 tag 固定叫法：`more`→「另外 N 项」、`turns`→「更早 N 轮」、`turn`→「第 N 轮」，`n > 1` 的聚合项显示 ×N。

状态语义沿用「异常才提醒」：`counted = 0` 出「本地估计」pill 贴 u-total——估算行的类占比是估算再缩放，精度区分贴着数字，不留在折叠深处的口径注（原 hint 的 counted 项随之移除）；窗口 NULL 不出占用率与空闲块，treemap 全幅铺已用部分，u-total 显「窗口未知」；占用 ≥75% 出「接近占满」、≥90% 出「占满」warn pill，正常态零状态提示。tile 文字色按 OKLab 相对亮度预计算：亮色主题 p3/p4/p5 槽用深字 `#0d1b24`、其余白字，暗色主题七槽全白字。`web/` 新模块必须同步登记 `src/http.ts` 的 `STATIC_FILES` 静态白名单——白名单是 web/ 目录的唯一发布面，目录覆盖测试在 `tests/http.test.ts` 卡住漏登。

模块依赖不成环：context-map 与 rail-facts 共享的类别口径与 token 缩写抽到 `web/parts.js`，rail-facts 转发既有导出保持既有消费者不破坏；usageFold 集成（rail-facts → context-map）与取色（context-map → 口径原语）都单向。

数据链路不新增采集：magpie 请求期启发式分类（token 估算）→ vendor 回答后按实测等比校准 → `routing/<date>.jsonl` → ATC 路由通道增量读取 → `request` 行 `parts_json`，全程只存名字不存正文。守恒基础（`sum(parts) = tokens` 全量成立、`tokens = in + cache_read + cache_write` 99.6%）见[架构设计](../../../../docs/architecture-design.md)「三通道连接质量」一节。

## Alternatives considered

**ATC 侧从 hook 正文重算分类。** 分类是 magpie 的派生事实，ATC 是只读观测者，重算违背「一个事实一个家」；hook 正文有 partial/truncated 态，会把不完整正文当事实；magpie 启发式仍在周级迭代，自算版本要永久跟跑。落选。

**调 magpie `GET /api/context` 取现成聚合。** 引入对 GUI 进程存活的时序耦合，违背本仓文件采集架构（增量读取协议、游标、代际）。落选。

**前端直接消费详情接口的原始 `parts` 字段，后端零改动。** 绕过「视图按白名单挑标量」原则（架构设计读模型一节），把已记录在案的不一致继续固化。折中为扩白名单；原始字段因无消费者直接移除。

**把 magpie Usage 页 Context tab 的 agent 打分（cache/lean/pace/reliable 四维）一并引入。** 那是多 agent 客户端仪表盘的场景；ATC 是单机会话轨迹阅读器，没有多 agent 对比面。落选；会话纵向构成图（每笔请求一列、类着色的堆叠条，看上下文随会话生长）才是 ATC 对应的差异化视角，落点在会话头汇总，届时另立提案。

**SVG 用 viewBox 等比缩放。** 窄栏（340px 下限）下文字缩到 5–7px 不可读，宽栏又放大到 18px 过大；改为横向百分比坐标 + 纵向固定像素 + 绝对字号。落选。

**自绘 tooltip 浮层。** 与全站原生 `<title>` 口径不一致；tile 与列表行都用原生 title。落选。

**重排 `--p1..--p6` 一并修 CVD 低距对。** 既有六槽是已校验发布物，重排改变所有现存截图与用户认知，且与本特性目标正交。本轮只加槽不动画六色，低距对用 tile 文字、图例名字、tag 徽标等辅助编码补位。落选（独立提案）。

## Consequences

六类旧口径行与七类新口径行在同一会话中并存时各自正确渲染；`memory` 旧行不再标「记忆与技能」，显示精度损失换口径不再漂移。`PromptReading` 扩展后若 magpie 改 items 字段形状仍需跟改——这是吃 magpie 派生事实的固有成本。窄栏下小类压成横条、高占用时空闲块极窄是 squarify 固有形状，靠悬停与图例补位，不为此引入 min-width 撑破右栏预算。item 点击看正文（magpie 有）当时不做：item 名到正文块的映射有同名歧义与跨请求成本；重开条件是正文定位（`request.system`、消息 ordinal）出现稳定需求。该缺口已由上述 drilldown note 以配对表定位交付，同名歧义以范围声明而非唯一映射解决。

部分取代[计时与用量并入「用量与上下文」折叠行](../simplification/2026-10-24-usage-ledger-fold.md)的展开态构成区陈述；该篇的折叠键、收起摘要与「异常才提醒」规则不变，已互相链接。

## Related

[上下文矩阵布局与点击明细](./2026-10-26-context-treemap-drilldown.md)已交付，部分取代本文关于非线性空闲区、面积下限、标称宽布局与暂不提供正文点击的决定：面积改为按真实 token 值铺满绘图区，tile 改为绝对定位 HTML button，内容块与图例项可点开明细弹窗。本文的类别来源、七类颜色身份与只读查询原则继续有效。[中栏按承载请求的 delta 分组](2026-10-28-request-delta-trace-groups.md)把文件与记忆类条目的可见名改为只显示 basename，完整名字进 `title` 与 `aria-label`；类别身份与颜色不受影响。

## Testing

`bun run typecheck` 通过；`bun test` 全量 752 例通过：`tests/context-map.test.ts`（三档宽度 × 四状态守恒断言：tile 界内不重叠、每类有面积、tile 总量等于 parts 和、有窗口必有空闲块；特殊 tag 与布局合并桶断言）、`tests/web.test.ts`（构成区集成与占用 pill 阈值）、`tests/queries.test.ts`（item 白名单）、`tests/body-view.test.ts`（七类槽位）、`tests/http.test.ts`（静态白名单目录覆盖）。真实恢复数据验收（生产库在线快照、临时 collector 独立端口加载、生产采集器未停）见[验收记录](../../../../docs/acceptance.md)：图例、treemap、空闲块与 u-total 数字互证一致；真实数据暴露并修复布局合并桶悬停 title 缺「另外 N 项」的缺陷。视觉截图未取得（ego lite 的 CDP 截图对该页超时），视觉项由 DOM 断言与合成测试覆盖。
