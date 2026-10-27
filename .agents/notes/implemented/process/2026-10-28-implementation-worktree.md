# Agent Note: 落地方案在 worktree 分支里做

Status: implemented

## Problem

主检出就是生产。launchd 跑的是这份检出的 `src/main.ts`，`web/` 的文件每次请求现读（见[采集器起停走 `bun run service`](2026-10-26-service-lifecycle-commands.md)）。多步实现直接落在主检出时，改到一半的页面与接口对生产可见，回滚只能靠 revert。

本仓早有 worktree：`creator-intelligence/.codex-worktrees/atc-*` 下七个，分支按 `feat/`、`fix/` 命名。但没有一条规则写明何时建、怎么合、何时清。七个分支全部已并入 `master` 且工作区干净，目录一个没删。

并行实现也缺隔离。未完成的改动混在主检出，`bun run service status` 用进程启动时刻对比最后一次 `src/` 改动来判断落后，分不清改动的来路。

## Decision

软规则，只写进根 `AGENTS.md` 的常备约定，不加闸门、不改 `verify:notes`。依据 Agent Note、`docs/superpowers/plans/` 计划或用户直接指定的实现，改动跨文件或需要多步验证时，在 worktree 分支里做；文档、Agent Note 与单文件修正留在主检出。

- **位置与命名。** `creator-intelligence/.codex-worktrees/atc-<topic>`，分支 `feat/<topic>` 或 `fix/<topic>`，基线 `master`。上层 `.gitignore` 已忽略 `.codex-worktrees/`。
- **依赖。** 符号链接主检出的 `node_modules`，不重复 `bun install`。
- **验证隔离。** worktree 里起采集器必须给 `ATC_DATA_DIR` 临时根与 `ATC_PORT`；默认数据目录指向生产库（[配置入口](../../../../src/config.ts)）。
- **服务归属。** `bun run service` 按 plist 的 `ProgramArguments` 认跑本检出 `src/main.ts` 的条目（[探测](../../../../scripts/service-support.ts)），worktree 里的实例归主检出，重启在合并后的主检出执行。
- **合并与清理。** 验证通过后 `git merge --no-ff` 进 `master`；改动触及 `src/` 才需要 `bun run service restart`；随后 `git worktree remove` 与 `git branch -d`。

```sh
cd ../../                                                # creator-intelligence
git -C repos/agent-trace-collector worktree add "$PWD/.codex-worktrees/atc-<topic>" -b feat/<topic> master
ln -s "$PWD/repos/agent-trace-collector/node_modules" .codex-worktrees/atc-<topic>/node_modules

cd .codex-worktrees/atc-<topic>                          # 在此实现与提交
ATC_DATA_DIR=$(mktemp -d) ATC_PORT=8399 bun run start

cd ../../repos/agent-trace-collector                     # 验证通过后回主检出
git merge --no-ff feat/<topic> -m "merge: <主题>"
bun run service restart                                  # 仅当改动触及 src/
git worktree remove ../../.codex-worktrees/atc-<topic> && git branch -d feat/<topic>
```

## Alternatives considered

**直接提交 `master`。** 路径最短，但 `web/` 每次请求现读，改到一半就已经对生产生效，没有隔离可言。

**主检出上切分支或 stash。** 不需要第二个目录，但未完成的改动与生产检出混在一起，stash 还要额外的恢复动作；切分支期间主检出停在不代表生产的提交上。

**每个任务 clone 一份。** 隔离最彻底，代价是对象库与依赖重复，清理成本比 worktree 高。

**沿用 `.claude/worktrees/agent-*`。** `ata` 仓库里由子代理自动生成的目录，路径与命名由工具决定，从目录名看不出在做什么。

**写成硬闸门。** 只能拦「提交发生在哪个分支」，拦不住「该建 worktree 而没建」，判断本身在 Agent 这边。加一个挡不住真实错误的闸门，只增加一次同步负担。

## Consequences

生产生效点是合并与重启两件事，合并前 worktree 的改动不外泄。`web/` 合完即生效，`src/` 要等到 `bun run service restart`。

多一步合并与清理。已合并的 worktree 需要显式移除，规则把这一步并进合并动作；漏掉的不会自动消失，会一直留在 `.codex-worktrees/` 里。

软规则不拦人。忘记建 worktree 不会报错，只在事后表现为主检出带着半成品。

worktree 里 `bun run service` 找不到本检出的服务条目，验证只能靠 `ATC_PORT` 隔离的实例与测试；真实数据的验收仍在主检出做，并先停服务。

## Testing

命名、基线与清理判据按现有七个 worktree 的实际状态核对：全部合并进 `master`、工作区干净、`node_modules` 为符号链接。软规则没有运行时行为，判定由本期改动不触发自身（文档与单文件修正留在主检出）来体现。
