# Agent Note: 批次 B 侦查后降为不排期，本机没有可读的调用数据

Status: implemented

## Problem

[覆盖矩阵提案](../../proposed/feature/2026-11-04-agent-coverage-matrix.md)把 Qoder 与 CodeBuddy 排成批次 B，前置条件是「先侦查 Qoder 调用数据的真实根目录；侦查没有结论就不写解析器」。提案的 Risks 也写明，若侦查得出「本机没有可读的调用数据」，Qoder 要降为不排期。第一批只读扫描只 stat 了文件数与字节数，看到 `~/.qoder` 有 78 MB 数据就把它排在 Hermes 之前，没有验证这些文件里是否真的有 assistant 回复与逐笔用量。批次 A 交付后要决定下一步，先执行这次侦查。

## Decision

批次 B 不写适配器，Qoder 与 CodeBuddy 降为不排期，条件与六家无数据的 Agent 相同：等本机出现真实会话样本再排。覆盖矩阵保留两者，标出「有根、无调用数据」与恢复排期的判据。

侦查按结构统计，不读正文、账号、令牌与用户配置，也不把真实内容写进记录：

- `~/.qoder` 共 566 文件、78 MB。119 个 jsonl、1,164 行 JSON 全部合法解析，零坏行；按字段名统计，出现的是 `type`、`ts`、`seq`、`level`、`data`、`turn_id` 这类事件字段，`type` 值集中在 `session.phase.started/finished`（526 条）、`hook.started/finished`（456 条）、`session.config.loaded`（80 条）、`cli.route.entered`（80 条）。带 assistant 角色的文件 0 个，带 `usage` 字段的文件 0 个，`role` 值一次都没出现。调用相关只有 1 条 `model.request.started` 与 1 条 `model.request.attempt_failed`，没有任何成对的回复或完成事件。
- `~/.qoder/projects` 只有 1 个 jsonl（21,978 字节、10 行），内容是 workspace-directories、runtime-config、一条用户消息、4 条 attachment 与 active-leaf。Magpie 的 `qoder.go` 注释说这一层与 Claude Code 同形（`user`/`assistant` 加 Anthropic usage），但本机这份数据没有体现；Magpie 的调用解析复用 `ccFiles("qoder", QoderDir("qoder"))`，只是目录定位，不是可核对的调用样本。
- `~/.qoder/logs/runs/*/qodercli.log` 158 个 CLI 运行日志共 139,041 行、22 MB，只有 18 行沾到 `assistant`、`completion`、`model.request`、`input_tokens` 等关键词，命中形态是日志语句，不是可还原的调用记录。其余 195 个 json、162 个 log 与 `qoder-context.log` 用宽关键词扫过，没有逐笔用量或回复结构。
- `~/.codebuddy` 只有 3 个 `cli-memwatch-*.log`（内存与 CPU 采样），加上 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` 一个 4 KB 的 auth 文件；没有 `projects/`、没有会话文件。Magpie 的 `codebuddyFiles()` 与 WorkBuddy 共用 `buddyFiles()` 读 `projects/`，本机这个目录不存在，复用解析器只会读到空列表。
- 生产库 `request` 按 agent 聚合，没有 qoder、qoder-cn 或 codebuddy 任何一行；连网关侧证据都没有，不存在「只经网关可见」的另一条路。

判据来自覆盖矩阵的「每批完成条件」第 3 条：生产部署后要能对上游标、request 行数与 `ref_key` 唯一数对账。本机没有调用数据，这条无论如何过不去；写出来的适配器只能靠合成 fixture 自证，与提案里否决过的「把 19 家全部实现一遍」是同一个失败模式。

## Alternatives considered

**照批次 B 原计划实现两个解析器，真实流量读数标为未覆盖。** Magpie 有 `qoder.go` 与 `codebuddyFiles()`，WorkBuddy 的解析器也现成，代码量不大。否决：Qoder 那条复用 Claude Code 形状，本机 `projects` 只有骨架；CodeBuddy 连根都没有。两者上线后 `discover()` 返回空或只读出元数据，注册表与 `catalog.ts` 标成 `implemented`，却没有任何 request 行可验收，把「已支持」写进了报告。覆盖矩阵的完成条件明确禁止这一条。

**先做 Hermes（批次 C）的去重前置，再接 Hermes。** 这是侦查之后的下一步方向，不是批次 B 的替代实现。Hermes 有 4,778 笔网关侧请求与本地 205,607 个文件，卡点是[多来源同一调用的身份归一](../../proposed/feature/2026-11-04-multi-source-call-identity.md)还没落地。它与「批次 B 有没有数据」是两件事，不因本决定改变。

**把 Qoder 的 `qodercli.log` 当调用来源写一个事件流解析器。** 139,041 行里只有 18 行沾到调用关键词，且没有成对回复、消息 id 与用量；解析出来的是日志语句，不是模型调用。写进去会把噪声落成 request 行，比空适配器更糟。

**只把 Qoder 降为不排期、CodeBuddy 保留批次 B。** CodeBuddy 的复用价值成立的前提是本机出现 `~/.codebuddy/projects` 下的 jsonl；现在连目录都没有，单独为它写分支同样无法真实验收。两家一起等样本。

## Consequences

收益：不写两个只能自证的适配器，注册表与目录不新增虚假覆盖；下一轮的力气可以集中到有真实数据、且前置条件明确的 Hermes。矩阵现在能解释「Qoder 有 78 MB 数据却排在 Hermes 之后」这个看起来反常的顺序。

代价：批次 B 交付为零，19 家里已接入的仍是九家。Qoder 与 CodeBuddy 何时可接取决于本机是否产生可读会话文件，无法排期。若之后 Qoder 换了版本把调用正文写进 `projects/`，或 CodeBuddy 建出 `projects/` 目录，要重新做一次结构侦查再排期；恢复判据是「至少有一个文件同时含 assistant 回复与逐笔用量」，而不是「目录里有 jsonl」。

侦查结论落在[覆盖矩阵](../../../../docs/agent-coverage.md)的读数与分批节；提案 note 的 Risks 里那条预判由本记录收口，判定本身不改提案的决策，不标 rejected。
