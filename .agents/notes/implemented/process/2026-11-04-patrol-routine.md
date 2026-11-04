# Agent Note: 巡查程序落在 docs/patrol.md 与 scripts/patrol.ts

Status: implemented

## Problem

六轮巡查留下的可用结论散在一篇 proposed 的 process note 里。维护人员的自然路径是 `docs/` 索引、运维手册与根 `AGENTS.md`，三处都到不了 `.agents/notes/proposed/`；而 proposed 目录会随 note 落地或归档而移动，把 `AGENTS.md` 链过去等于没有固定的家。另一方面，巡检的判定大量依赖 SQL 与阈值，只写成文档就不会有人执行。

## Decision

巡查的正文只放在 [docs/patrol.md](../../../../docs/patrol.md)：三条核心、四层节奏、判定口径、误报边界、执行人与产出。可计算的检查放进 [scripts/patrol.ts](../../../../scripts/patrol.ts)，`bun run patrol weekly` 出容量、证据链、摄入产出比与会话扇出的读数，`bun run patrol smoke` 出 HTTP 契约冒烟；阈值只在脚本的 `PATROL_THRESHOLDS`，文档不复述数字。根 [AGENTS.md](../../../../AGENTS.md) 的「一个事实一个家」条目里加了一个指向 `docs/patrol.md` 的落点，`docs/README.md` 与 `docs/AGENTS.md` 的分层表各补一行。

巡查与后台监控各有一个家：进程内指标、采样与告警阈值归 `scripts/monitor.ts` 与[运维手册](../../../../docs/operations.md#后台监控)，巡查只补数据质量与容量，`/api/stats` 的手工读取不构成第二套阈值。本 note 只记录落点与代价，不承载程序正文、SQL 或阈值。

## Alternatives considered

- **整篇晋升 LESSONS.md**：四条准入过不去。巡查程序对应的失败事件是产品缺陷而不是 agent 的做事方式；单条需要五到二十行 SQL 与阈值，压不成一句祈使句；Seen 的语义是「同一个坑再次踩」，每周成功执行无法计数；十二条塞进教训池会稀释提交前扫 LESSONS 的可执行性。
- **留在 `.agents/notes/proposed/process/`**：自然路径到不了，且 proposed 会移动，`AGENTS.md` 不能链。
- **写进 `docs/operations.md`**：运维手册按命令组织，已有 580 行；巡查是节奏加阈值，插进去会把命令手册撑成两类文体，也会和「后台监控」一节的口径混在一起。
- **只建文档、不做脚本**：SQL 与阈值没人执行，随容量策略漂移后必然腐烂。
- **新增 `LESSONS.md` 条目而不是并入既有预览条目**：临时实例隔离会话源与「生产库副本起预览」是同一条规则，单独立条会产生第二个家。

## Consequences

- 多了一个 `docs/` 文件与一个 `scripts/patrol.ts` 入口，阈值变更要同步检查文档里对检查项的称呼是否还对得上；数字不在文档里，不存在两份阈值的漂移。
- 周环比仍靠人工把 `weekly` 输出贴进周报，脚本不写历史、不落盘。
- F20、F41 未修前，`smoke` 把畸形百分号编码与区间上界记作已知基线，不报失败；两条修好后会自动转成 400 的通过项。
- 巡查覆盖不到安全威胁模型与合并规则；通过巡查不等于这些面安全。
