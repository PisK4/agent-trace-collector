# Agent Note: 统一改名为 Tracery

Status: implemented

## Problem

产品名一直是 Tracery，但外部可标识的位置仍带着旧仓库名 `agent-trace-collector`：GitHub 仓库路径、两条 launchd 作业的 label、诊断日志文件名、运行时入口 `~/.local/libexec/agent-trace-collector`、数据目录。开源后读者点进 GitHub 看到的名字与 README 标题不一致；作者本机看 `launchctl list` 与日志目录也是两套命名。

之前刻意不改数据目录，理由是「改名会让已有数据的用户找不到自己的库」。这条在存在真实库（4.1 GB、五万多笔请求）时成立：不能靠改默认值让老库失联。

## Decision

一次性改名，用「停 → 移 → 起」的显式迁移把代价关在窗口内：

**GitHub 仓库**改为 `PisK4/tracery`。旧 URL 由 GitHub 做 301，仓库内引用同步改：README 两版的徽章与 CI 链接、`package.json` 的 `repository`/`homepage`/`bugs`、两个 issue 模板里的安全政策链接。

**launchd 作业**改为 `local.tracery` 与 `local.tracery-monitor`，plist 重装，日志改到 `~/Library/Logs/tracery.log` 与 `tracery.err.log`。运行时入口 `~/.local/libexec/agent-trace-collector` 改名为 `tracery`（同名硬链接改名，不改变 bun 本体）。旧 plist 从 `~/Library/LaunchAgents` 移出并备份到 `~/atc-rename-backup-20261104`，不留副本：`bun run service` 按 `ProgramArguments` 里是否含本检出的 `src/main.ts` 认条目，留着旧 plist 会让它认到两条。

**数据目录**改为 `~/Library/Application Support/tracery`，用 `mv` 在同卷内整体移动，库、WAL、四个令牌与 `monitor/` 一起搬过去。

**代码**里 `defaultDataDir` 的目录名常量改为 `tracery`，平台分支不变。默认位置变了，所以迁移必须与代码同时生效，不能分两次发布。

**不改**：本地检出目录仍叫 `repos/agent-trace-collector`。它连着五个 worktree 的 `.git` 指针、父仓的 gitlink 与两条 plist 的路径，改名收益只是目录名好看；数据目录名与目录名不再是同一个东西，这一点由本记录承接。

## Alternatives considered

- **只改 GitHub 仓库名。** 成本最低，但本机仍是两套命名，日志与 `launchctl list` 里继续看到旧名。既然要停机一次，顺手把本机也统一。
- **改数据目录但不改 launchd label。** 中间态：目录叫 tracery、作业叫 agent-trace-collector，看作业列表时更迷惑。
- **同时改本地检出目录。** 取舍见上：收益是命名一致，代价是一个并行会话正在使用的工作树、五个 worktree 的指针与父仓 gitlink。否决。
- **保留旧数据目录并新建软链接。** 能免掉迁移，但会在数据目录旁边留一个指向自己的符号链接；库的 `lstat` 校验与备份脚本都要额外处理符号链接，不如移一次干净。

## Consequences

- **迁移窗口内不可采集。** 采集器与监控都停过，窗口内到达的 magpie hook 与 OTLP 上报丢失。本次窗口约数十秒，代价是几十笔请求不再被记录。
- **令牌与盐没变。** 移动前后的四个文件 sha256 一致，说明没有触发重新生成；旧备份与历史日志里的令牌仍然有效，不需要重新分发 `hook.token` 与 `otlp.token`。
- **旧日志留在原地。** `~/Library/Logs/agent-trace-collector*.log` 不迁移，作为历史；新日志从 `tracery.log` 起算。
- **旧 URL 依赖重定向。** GitHub 的 301 不是永久保证；仓库内引用已全部指向新路径，外部引用（笔记、书签）会经过一次跳转。
- **历史记录不改写。** `.agents/notes/` 与 `docs/superpowers/` 里的旧名保留原样：它们记录的是当时的事实，改掉会让记录与提交历史对不上。

## Testing

- 迁移后 `/api/stats` 可读，请求数从停机前的 54,761 继续增长到 54,833，说明同一份库被接上，不是新建的空库。
- 四个令牌与盐的 sha256 与迁移前逐条一致。
- `bun run service status` 认到 `local.tracery`，无「落后」告警；日志首屏出现新的启动横幅与 `collector_listening:8320`。
- `scripts/monitor.ts check` 手跑退出码 0；监控样本写入新的数据目录。
- `bun test` 全量通过；`bun run typecheck` 无错。
