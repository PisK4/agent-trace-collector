# Agent Note: 变更闸门检查提交是否带 Agent Note

Status: implemented

## Problem

Agent Notes 体系接入后，`verify:notes` 只校验已有 note 的格式与归档封印，不检查本次改动是否需要 note。漏写 note 时闸门仍然是绿的：接入 kit 之后有六个提交改了派生、schema、回填脚本与界面，没有一篇 note，闸门没有报错。规则本身写得清楚，缺的是机械发现「这次没写」的手段。

## Decision

`scripts/verify-change-notes.mjs` 增加变更检查，接进 `package.json` 的 `verify:notes`，同时跑暂存区与未推送提交两个范围。它按路径保守判定「需要 note」：改动落在下列任一路径，就必须在同一暂存集或同一提交里新增或修改一篇 `.agents/notes/.../yyyy-mm-dd-topic.md`。

- 代码与工具目录：`src/`、`web/`、`plugins/`、`scripts/`、`tests/`
- 工程配置：`package.json`、`bun.lock`、`tsconfig.json`、根 `AGENTS.md`

纯机械或局部编辑走显式豁免：提交信息里写 `Agent-Note: none — <reason>`；`--staged` 阶段还没有提交信息，用 `ATC_NOTE_EXEMPT=<reason>` 放行，并把同一理由写进提交信息供 range 模式核对。`--range` 逐提交检查，并跳过本脚本首次进入历史之前的提交，避免追溯旧账。

触发路径与豁免语法以 [scripts/verify-change-notes.mjs](../../../../scripts/verify-change-notes.mjs) 为准；命令入口见 [package.json](../../../../package.json)。

## Alternatives considered

**继续靠规则和记忆。** 这正是失败的方式：规则在，闸门绿，note 没写。格式检查无法发现「没有 note」。

**装本地 git hook。** 接入 kit 的 note 明确不装本地 hook：配置不进仓库，换机器要重设。变更检查接在已有的显式 `verify:notes` 上，不改变那个决定。

**对所有路径都要求 note。** 文档、验收记录与纯机械编辑会被大量误报，最后所有人都会习惯性加豁免，闸门失去信号。

**用语义判断「是否非平凡」。** 机械上不可判定；按路径的保守集合加显式豁免，是能稳定执行的最小代理。

**只检查一个范围。** 只看暂存区会漏掉「忘了跑」的提交；只看未推送范围则发现问题太晚。两个范围都跑，提交时和 push 前各有一次拦截。

## Consequences

- 纯机械的代码改动需要 `Agent-Note: none — <reason>`；理由进入提交历史，range 模式会核对。
- 只改 `docs/` 或 `README.md` 的提交不在触发范围内。规则仍然要求非平凡文档决策写 note，但闸门只是代码与工具路径的后盾，不覆盖全部语义。
- `--range` 跳过本脚本首次进入历史之前的提交；首次接入前遗留的缺口由本次补写 note 的提交处理，不追溯改写。
- `verify:notes` 变严格：暂存代码但还没写提交信息时，要么先写 note，要么用 `ATC_NOTE_EXEMPT` 放行并记得把理由写进提交信息。
- 没有新增依赖，也没有本地 hook；检查仍是 `package.json` 里的显式脚本。

## Testing

在临时仓库里验证：只暂存 `src/` 改动时检查失败；同一暂存集加入 note 后通过；提交信息带 `Agent-Note: none — …` 时 range 模式通过。接入提交本身过 `bun run verify:notes`。
