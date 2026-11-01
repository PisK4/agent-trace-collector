# Agent Note: 宣传片友好的合成 Prototype 八项——明星会话与拍摄直达

Status: implemented

提案：[宣传片友好 Prototype 八项](../../proposed/feature/2026-11-02-promo-friendly-prototype.md)。合成服务器补一个可直接拍摄的明星会话（「给 CLI 工具加 --json 输出模式」），并给页面加四个直达参数。所有关键数字（主链 44、提示 208k、缓存 93.2%、费用 $0.42、工具分布、失败弧线、treemap 八类占比）以提案的关键数字表为唯一口径，实现从表生成并有测试钉住。

## Problem

宣传片需要一段「好看的会话」：真实会话的数字与叙事不可控，现有合成池（reading/window/hook/turns 四池）没有长链路、失败弧线与 OMP 对照，也没有把页面带进指定状态的入口——拍摄每一步都要手工点。

## Decision

- **明星会话独立文件**：`prototypes/star-session.ts` 只放数据（51 笔显式脚本 + 生成器），类型从 `synthetic-types.ts` 抽出共享（SynthCall/SynthMessage/SynthRequest + 新增 `promptPlan`、`agent` 两个可选覆盖）。`synthetic-server.ts` 接线第五池：`byId`/`POOLS`/`SESSION_SUMMARIES`/`TURNS_BY_SESSION` 各加一员，`startOf` 的 800 段偏移抬高到 60 分钟起保证列表置顶。条目数据源（文件→首调用映射、承接消息序号）在 StarData 上，目录构建逻辑留在服务器。
- **调用参数随回复正文走**：anthropic 调用笔回复内嵌 `tool_use` 块、chat 调用笔走 `choices[].message.tool_calls`（arguments 为字符串）——配对页与中栏的参数链（`body-model.toolCallOfBlock`）从正文块读取，SynthCall 本身不加 `input` 字段。参数在生成调用计划时一次定案（PlannedCall），回复块与结果文本共用同一份，不写反向推算。
- **用量闭合用「基线公式 + 逐笔均摊」**：`usageOf` 给自然序列（read 按 13.706 倍派生使缓存比落在 93.2%），`spreadGap` 按累计取整把余差均摊（总量 208000、输出 17400、费用 0.42 精确闭合）；峰值笔 `ms` 从 out 反推（恒 118 tok/s），不硬编毫秒。
- **轮次带 9 个、轮首显式标注**：spec 加 `newTurn` 字段，生成时不猜——「userInput 且无承接调用」不是轮首判据（重试笔自成轮、「（继续）」笔无承接也不开轮，实测 10 轮错表）。
- **context-item 端点照抄生产语义**：`if_reading` 缺失或格式错 400、不匹配 409、`harness` 白名单外返回 `unsupported/unknown_kind`（生产 CONTEXT_KINDS 七类如此，照抄不扩展）。条目按类别定位：tools/system 定顶层字段、chat 定消息、files 定承载调用的结果端点、results 定 `toolResultsOf`；entries 超 80 截断并记 note。cursor 不支持翻页，`next_cursor` 恒 null（单笔条目远小于生产分页压力）。
- **四个直达参数只消费一次**：`?demo=1` 打开 reader-store 静默（作废不排自动重读）；`?expand=summary` 在 renderMain 尾部重开 cue-board 折叠组（放 renderAll 会被 prepareWindow 的后续重绘冲掉，实测 0/3）；`?summary=<kind>` 在 summary 快照就绪后打开 count 最大组；`?turn=<n>` 在轮次快照就绪后翻译成 `locate(start_req)` + `select-turn`。trace 与 turn 同给时 trace 优先。
- **treemap harness 类**：parts.js PARTS 末尾加 `{kind:'harness', label:'Harness'}` 一行即可——方向 A 第 6 步后类别无色槽，份额走 `partShade` 四档，提案 Risk 里「给 harness 分配色槽」的顾虑已随单色化过时。

## Alternatives considered

- **明星数据塞进 synthetic-server 的 REQUESTS 数组**：51 笔显式脚本混进已有 400+ 行的池文件，且数字表校验没法独立 import；独立文件让 `tests/star-session.test.ts` 直接断言表值（7 测试 426 断言），改动半径反而小。
- **`?turn` 直接初始化 `state.turn`**：`session-default` 意图会清 `turn`（reqId 被顶替时），且 turns 快照在 selectSession 返回时未必就绪；改成 onTurnsChanged 里消费 `locate`+`select-turn`，两个既有意图都不用改。
- **context-item 从 PART_ITEMS 模板编条目**：模板是 treemap 示意（「另外 9 项」），编不出可读正文；改从真实生成数据构建条目，正文与结果端点全链可读。
- **demo 静默同时盖轮询与批处理**：实测合成数据下触发面只有 auto-reread 一处（静置 15 秒零请求），只盖调度点；多盖的面没有证据支撑。

## Testing

- `bun run typecheck` 通过；`tests/star-session.test.ts` 新建 7 用例（主链 44、协议 31:13、工具分布对表、失败 2 笔全 Bash、用量四项闭合、缓存比 93.15–93.25、峰值 118、轮次 9、调用全配对、八类合计 100 含 harness、summary 形状）；`tests/url-route.test.ts` 加 demo/expand/summary 三解析；`tests/body-view.test.ts` 加 harness 登记断言（label、次序在 skills 后、份额落档）。三项全过。
- 合成页目测（`/tmp/atc-promo/shot-*.png`）：明星会话置顶、头部「提示 208.0k / 输出 17.4k / 费用 $0.4200 / 缓存 93% / 主链 44 / 旁路 7 / 峰值 87%」、Bash chip「2 失败」红字、treemap 八类图例（Harness 319·9%，Claude Code/OMP 块可见，浅深两主题）；配对页调用参数 `{"path":"src/cli.ts"}` 与结果定位 `请求 02·messages[4]` 链路完整；`?turn=5` 定位 Request 26 且轮带 aria-pressed 高亮；`?summary=tool` 打开「Read 的调用」；`?expand=summary` 3/3 全开；`?demo=1` 静置 15 秒 fetch 计数 0。
- curl 冒烟：409（token 不符）、400（缺 if_reading）、`harness`→`unsupported/unknown_kind`、files/results/chat/skills 条目形状与定位逐个核对。

## Consequences

- **轮带只显示窗口内轮次**：`?turn=8/9` 指向的轮在已加载 30 笔窗口外，轮带 7 个 chip、定位落在窗口外详情；窗口分页是生产同构语义，不为拍摄特判。
- **非明星请求的 files/results/memory 目录是空集**（available 态「没有该范围的片段」）：只有明星会话有目录数据源；其余池的 context-item 主要语义（409/400/unsupported/tools/system/chat）仍可验证。
- **results 类条目无翻页**：单笔结果块最多约 7 条，远小于生产 CONTEXT_ENTRY_MAX=80；若将来造更大的合成会话，需要补 cursor 形状。
- **直达参数不回写 URL**：`updateURL` 只维护 session/trace/tab，拍摄脚本自行携带完整参数；刷新后直达态不保留，属入口快捷方式的既有语义。
