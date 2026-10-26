# Agent Note: 采集器起停走 `bun run service`

Status: implemented

## Problem

采集器在生产由 launchd 托管，plist 里 `KeepAlive=true`、`ThrottleInterval=10`。这套配置下没有安全的「停一下」：`kill` 掉进程，launchd 会在 10 秒内把它拉起来，任何在中间窗口执行的维护命令都会撞上写连接；再手动起一个 `bun run start` 会撞端口，两个进程里失败的那个还会在 err 日志里留下一条看不出成因的记录。

运维手册写着维护命令要求采集器已停止，却只写了「停服务：`SIGTERM` 或 `SIGINT`」。这两句话放在 `KeepAlive` 下互相矛盾：照手册做，`kill` 之后服务会自己回来。

另有一处判断长期靠人肉完成：改完 `src/` 之后要知道进程有没有落后，只能看日志里最后一条 `collector_listening` 的时间，再去比提交时间。

## Decision

新增 `bun run service <子命令>`，入口是 [scripts/service.ts](../../../../scripts/service.ts)，探测逻辑在 [scripts/service-support.ts](../../../../scripts/service-support.ts)。四个子命令：

| 子命令 | launchd 动作 | 等到什么才算成功 |
| --- | --- | --- |
| `status` | 无 | 只读，不改变任何状态 |
| `restart` | `kickstart -k` | 新 pid 的端口在听，且 `/api/stats` 答得出来 |
| `stop` | `bootout` | 作业消失且原 pid 的监听端口释放 |
| `start` | `bootstrap` | 新 pid 的端口在听，且 `/api/stats` 答得出来 |

退出码沿用维护 CLI 的约定：0 成功，1 失败，2 用法错误。失败时 stderr 写 `<命令>_failed:<原因码>`，并带上作业状态与 err 日志尾部。

几处不能省的判据：

- **服务条目不按 label 猜。** 扫 `~/Library/LaunchAgents` 下的 plist，认 `ProgramArguments` 里跑本检出 `src/main.ts` 的那一个。在 worktree 里跑脚本时，找到的是主检出那份，或找不到，不会静默操作另一份检出的服务。
- **`restart` 必须等到与旧进程不同的 pid。** `kickstart` 返回时旧进程可能还没退出，此时端口仍在听、`/api/stats` 也还答得出来，探到的是旧进程。
- **`stop` 必须轮询。** `bootout` 只负责发信号，作业在进程退出前仍可查到。即时检查会把一次成功的停止报成失败。
- **探活超时不等于没起来。** 派生与费用作业和摄入共用同一个事件循环，单次任务可占用数秒（`/api/ingest-metrics` 的 `event_loop.max_ms` 实测到 6941 毫秒）。超时、连不上、HTTP 错分成三种结果分别报出，不合并成一个「无响应」。
- **读服务实际那份配置。** launchd 不继承交互 shell 的环境，脚本按 plist 的 `EnvironmentVariables` 调 `loadConfig`，不按调用者的环境猜数据目录。
- **起停前先挡住能提前发现的失败。** 维护锁在盘上、或读不到 `read.token` 时直接失败，不去杀进程换一次起不来的起停。

`status` 报四组事实：作业状态与 pid、进程启动时刻对最后一次 `src/` 改动的先后、端口与 `/api/stats` 耗时、游标与积压。判断「落后」只看 `src/`：`web/` 每次请求现读文件，`plugins/` 由 magpie 侧加载，两者改完都不需要重启采集器。

## Alternatives considered

**加 Makefile 包一层。** `package.json` 的 scripts 已经是任务入口，Makefile 会在它上面再叠一层同义的名字；`verify-change-notes` 的触发路径也不含 Makefile，等于绕开变更闸门。这套动作需要读 launchd 状态、轮询端口、解析日志，用 shell 写出来比 TypeScript 长。

**`bun run stop` 与 `bun run restart` 两个平级脚本。** `stop` 和 `start` 是配对的：停服务让维护命令可用，维护完还要能起来。四个子命令放在一个入口里，`status` 与起停共用同一套探测，不必各写一份。

**`kill` 加 `launchctl` 兜底。** `KeepAlive` 下 `kill` 与重启之间有一个 10 秒窗口，维护命令正好可能落进去。`kickstart -k` 把终止与启动交给 launchd 一次完成，没有这个窗口。

**按 `launchctl list` 的文本输出解析 pid。** 它是 plist 风格的 `{ "PID" = 47398; }`，`plutil -convert json` 读不了。`launchctl print` 的顶层键各占一行、正好一个制表符缩进，嵌套块缩进更深，按行首匹配可以稳定区分；嵌套块里也有 `state = active`，不区分缩进会把作业状态读成端点状态。

**用 `ps -o etimes=` 算运行时长。** macOS 的 `ps` 没有这个关键字。改用 `lstart` 时要注意它的输出随 locale 变（中文环境是 `一 10月/26 20:49:12 2026`），必须固定 `LC_ALL=C` 才让 `Date.parse` 认得。

**`status` 同时报 `web/` 改动。** 页面文件每次请求现读，改完立即生效；算进「落后」会给出误导性的「需重启」。

## Consequences

- 停服务、起服务、换代码各有唯一动作，`KeepAlive` 不再与手册冲突。
- 起停要等到接口可读才返回，`restart` 的耗时包含事件循环被启动任务占用的窗口，实测 0.5 秒到 14 秒。慢不等于失败，失败会带日志尾部。
- 服务条目按 `ProgramArguments` 认本检出。把 plist 的 `ProgramArguments` 改成别的路径，脚本就认不出这个服务，会报 `service_not_managed` 并提示手动启动。
- `status` 读 `read.token` 只读不建：令牌缺失时报出来，不顺手生成一份新的。
- 脚本新增了 `lsof`、`launchctl`、`plutil`、`ps` 四个系统命令的依赖，都是 macOS 自带，不引入第三方包。
- 变更闸门把 `scripts/` 算作触发路径，这个入口本身受同一套 note 规则约束。

## Testing

真实环境逐条验证（2026-10-26，生产库，采集器由 launchd 托管）：

- 裸调用与未知子命令都打印 usage 并退出 2。
- `status` 在运行、已停、作业未加载三种状态下分别报出对应事实，退出码随「在跑且可读」变化。
- `restart` 成功换 pid（47398 → 9688）；再次 `restart` 在服务已 bootout 时报 `restart_failed:not_loaded` 并提示用 `start`。
- `stop` 轮询到作业消失与端口释放，退出 0；重复 `stop` 报「未加载，本来就是停的」并退出 0。
- `start` 成功起服务；重复 `start` 报 `start_failed:already_loaded` 并退出 1。
- 手工在数据目录放一把 `maintenance.lock`，`restart` 与 `start` 都以 `maintenance_lock_present` 拒绝，删掉锁后 `start` 成功。
- 用一个一次性的 `/bin/sleep` 作业验证 `bootstrap`、`kickstart -k`、`bootout` 的语义与 `launchctl print` 的退出码（存在为 0，不存在为 113），验证后已移除。

`restart` 期间实测到一次 `/api/stats` 响应耗时 3983 毫秒，与仓库里[派生正文重复解压](../../proposed/bug-fix/2026-10-26-derive-body-decompression-amplification.md)记录的同一事件循环阻塞同源，不是这套脚本引入的。
