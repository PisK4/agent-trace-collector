# Agent Note: 采集器在系统界面显示为自己的名字

Status: implemented

## Problem

launchd 直接以 bun 二进制启动 `src/main.ts`。macOS 的活动监视器与「登录项与扩展」按可执行文件名显示进程，采集器因此在系统界面显示为 `bun`，跟本机其他 bun 进程混在一起，看不出这一条是采集器。

要在运行时改正这个名字试过三条路，都不生效：`process.title` 只改 Node/Bun 自己记录的字符串，`ps` 与 `proc_name` 读到仍是 `bun`；`bun --title=` 只进命令行参数；符号链接会被内核解析回真实路径 `bun.exe`。

## Decision

plist 的 `ProgramArguments[0]` 指向 `~/.local/libexec/agent-trace-collector`，一份 bun 二进制的硬链接。进程名取自被执行文件的最后一段路径；硬链接与源文件共享 inode，不占额外空间。

launcher 放在数据目录之外：删数据目录重建库是文档化的操作，启动器留在一个会被整体删除的目录里，`KeepAlive` 会陷入起不来的循环。不放进 PATH，避免手动敲到一个第二实例撞端口。

服务条目识别不受影响：`scripts/service-support.ts` 按 `ProgramArguments` 里有没有本检出的 `src/main.ts` 认服务，`[0]` 换成什么路径都可以。

重建链接的命令写在[运维手册](../../../../docs/operations.md#起停与状态)。

## Alternatives considered

**复制一份 63MB 的 bun 并改名。** 效果相同，但占一份完整空间，而且同样要在 bun 升级后手动替换，硬链接没有更差的维护代价。

**`bun build --compile` 编译成独立二进制。** 名字最干净，也不需要 bun 保持存在。实测编译后 `import.meta.url` 变成 `$bunfs/root/...`，[http.ts](../../../../src/http.ts) 的 `web/` 静态文件与 [store.ts](../../../../src/store.ts) 的 `schema.sql` 都读不到，要么把资源全部内嵌（页面就失去「改文件立即生效」），要么接受运行时找不到文件。为一个显示名付出这个代价不值得。

**`process.title` 或 `bun --title=`。** 两者都只改进程内部或命令行里的一串字符，不改变内核记录的可执行文件。

**符号链接。** 内核按真实路径取名，链接名看不出来。

**保持现状，接受 `bun`。** 这是运行时名，等同 node 项目显示 `node`。改名唯一能换到的是活动监视器里一眼可辨，而代价是 bun 升级后要记得重建链接；留存这份记录，是为了下次有人再问时不必重做上面的实验。

## Consequences

bun 升级会换掉 node_modules 里的原文件，硬链接仍指向升级前的 inode，采集器继续跑旧 bun，而 `bun --version` 显示的是新版本。升级后按运维手册重建链接，服务重启后生效。这一条不自动检测：`service status` 报的是作业与接口状态，不比对启动器指向的版本。

启动器不随 nvm 的 node 版本目录走：删掉某个 node 版本时，plist 指向的路径仍然存在，`KeepAlive` 不会因为路径消失而空转。

进程名只影响系统界面的显示，`launchctl` 里仍是 label `local.agent-trace-collector`，`bun run service` 的四个子命令行为不变。

## Testing

本机实测（2026-10-27，生产采集器）：

- 改 plist 前 `proc_name` 返回 `bun.exe`，改后返回 `agent-trace-collector`。
- `bun run service stop` → `start` 成功，新 pid 在端口 8320 答 `/api/stats`。
- 后台项数据库（`/var/db/com.apple.backgroundtaskmanagement/`）里该条目的可执行文件路径随之更新。
