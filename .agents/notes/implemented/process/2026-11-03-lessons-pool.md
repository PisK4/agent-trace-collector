# Agent Note: 工作教训收敛进 Agent Notes

Status: implemented

## Problem

Agent 在本仓库踩过的坑散落在三个地方，改代码前没有一处可扫。决策 note 的正文偶尔带一条教训，例如[方向 A 第 5 步](../feature/2026-11-02-direction-a-step5-tools-pair-page.md)在 Alternatives considered 里记了 `list.param` 当展示文案导致对组永不命中；版本号四处同步的清单只存在个人记忆里，不进 git；验收记录按轮次写，不是检索入口。

决策 note 的格式也不适合承接教训。门禁要求 `## Problem`、`## Decision`、`## Alternatives considered`、`## Consequences`，一条几十行的操作规则没有真实的备选方案，硬套会编造否决记录。每条都写成一篇 note 还会稀释已有决策记录的检索。

## Decision

在 Agent Notes 目录下新增单文件 [LESSONS.md](../../LESSONS.md)，记录 Agent 在本仓库反复踩的工作方式错误。它不是 Agent Note：不参与 proposed/implemented/rejected 生命周期，不进 `{lifecycle}/{class}/` 目录树，不参与归档与文件格式门禁。

- **条目格式**：加粗的祈使句规则、证据（commit、文件与行、日期）、可执行防护（命令、测试或检查项）、Seen 日期列表。格式照 magpie 的 `LESSONS.md`，去掉按时间段的 review 总览与 `reviewed-through` 提交标记。
- **晋升**：同一规则在三个不同日期出现，或防护已变成测试、脚本、根 `AGENTS.md` 的常备约定，就从正文删除并迁入对应家；文件末尾只保留一行迁移指针与证据锚点。
- **读取与写入**：根 `AGENTS.md` 的常备约定要求改代码前读、非平凡任务收尾时回写。按需读取，不做 `@LESSONS.md` 全文导入，文件变长后不占每会话上下文。
- **边界**：设计决策进决策 note，单次缺陷的完整复盘进 bug-fix note，操作经验不写进决策 note 正文。

## Alternatives considered

**仓库根 `LESSONS.md`。** 与 `README.md`、`AGENTS.md`、`GLOSSARY.md` 同级，最接近 magpie 的原样。否决原因是在已有的 note 体系之外增加第四个文档家，读者要在两个目录之间判断一条经验该放哪；放进 `.agents/notes/` 后，两个家在同一目录下，边界由 README 一节写清。

**每条教训写一篇 implemented note。** 完全复用现有门禁与归档，零脚本改动。否决原因是格式成本与语义不符：一条操作规则没有真实的 `## Alternatives considered`，强行写就是编造；短教训大量进入决策树会稀释检索。

**新增 `lessons/` 生命周期目录。** 每条教训一个文件，便于链接与独立演进。否决原因是要改 `agent-note-tree.mjs` 的封闭生命周期集、README 的布局规则与格式门禁的扫描逻辑；更麻烦的是现有顶层目录表示决策状态，`lessons` 不是状态，混进去会让路径语义出现例外。

**只在现有决策 note 里加 `## Lessons` 章节。** 零新增文件。否决原因是教训跨决策，一条规则可能对应多个 note，写好一处后其它 note 不会引用它，改代码前仍然找不到。

## Consequences

教训有了固定的检索入口，改代码前读一个文件即可扫完；决策 note 不再被迫承接操作经验。

维护靠任务收尾自检，没有夜间 review 流水线。Seen 只能靠完成任务的 Agent 自己记录踩过的坑，信号比 magpie 的独立 review 弱，三次晋升发生得更慢。

`verify-change-notes` 不把 `LESSONS.md` 当成变更 note，所以以后只追加教训不受闸门约束；本次引入这套机制是 process 变更，仍有这篇 note。

文件会随条目增长。晋升与删除是唯一的收缩机制，没有按时间段的 review 总览，也不设条目配额。

## Testing

`bun run verify:notes` 通过：`verify-agent-note-format` 只遍历 `proposed/`、`implemented/`、`rejected/` 下的 note，`verify-archived-agent-notes` 只扫 `archived/`，`walkAgentNoteTree` 对 `.agents/notes/` 根目录的文件除 `INDEX.md` 外不检查，`LESSONS.md` 不需要改任何门禁脚本。

三条种子条目都来自仓库内的真实记录：版本号四处同步来自 2026-11-01 的 Hermes 修复，worktree 的 `node_modules` 软链来自 2026-10-25 的 `tsc` 失败，`list.param` 的装配错误来自[方向 A 第 5 步](../feature/2026-11-02-direction-a-step5-tools-pair-page.md)。每条都带日期与文件位置，未编造。