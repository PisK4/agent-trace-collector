# 运维手册

采集器把账本、路由、hook、OTLP 与本地 Agent 会话文件（droid、Claude Code、Codex、DSH、Zcode、OMP、Pi）五路证据写进同一个 SQLite 库。在线读取走独立只读连接，写入全部走单写者事务。下面这些操作都在**采集器已停止**的前提下进行，停服务用 `bun run service stop`，见[起停与状态](#起停与状态)。

## 数据目录

默认按平台惯例：macOS 为 `~/Library/Application Support/tracery`，其他平台为 `${XDG_DATA_HOME:-~/.local/share}/tracery`，用 `ATC_DATA_DIR` 覆盖。目录权限 0700，里面的数据库、WAL、日志与三个令牌文件都是 0600。

| 文件 | 用途 |
| --- | --- |
| `trace.db` | 主库，WAL 模式，`auto_vacuum=INCREMENTAL` |
| `read.token` | 页面读取令牌，首次启动生成 |
| `hook.token` | 插件投递令牌，首次启动生成；插件只拿这一个 |
| `otlp.token` | OTLP 端点令牌，首次启动生成；harness exporter 只拿这一个 |
| `redaction.salt` | 脱敏用的本地盐；与库里的绑定标识配对，不能单独替换 |
| `maintenance.lock` | 维护命令的独占锁，只在维护期间存在 |

`redaction.salt` 与库必须配对。库里的 `collector_state['privacy:salt']` 记这份盐的标识（加域前缀的 SHA-256，不含盐明文）；有数据却没有绑定、盘上没有盐文件、或盐与标识不符时，采集器拒绝启动，分别报 `redaction_salt_unbound`、`redaction_salt_missing`、`redaction_salt_mismatch`。启动路径不会顺手生成新盐：换盐会让库里已有的占位符再也解释不了。有盐文件却没有绑定同样拒绝启动（`redaction_salt_unbound`）：无法证明历史占位符是这份盐算的，也没有确认绕过的入口，旧库删除后重建。

## 起停与状态

生产采集器由 launchd 托管（label `local.tracery`，`KeepAlive=true`、`ThrottleInterval=10`）。这套配置下 `kill` 不安全：进程退出后 10 秒内会被重新拉起，维护命令正好可能落进那个窗口，再手动起一个还会撞端口。起停统一走 `bun run service`：

```sh
bun run service status     # 只读：作业、pid、代码是否落后、端口、游标与积压
bun run service stop       # bootout，等到作业消失且端口释放
bun run service start      # bootstrap，等到 /api/stats 可读
bun run service restart    # kickstart -k，等到新 pid 可用
```

退出码 `0` 成功，`1` 失败，`2` 用法错误。失败时 stderr 写 `<命令>_failed:<原因码>` 并带上 err 日志尾部。四者都等到接口答得出来才返回，所以 `restart` 的耗时包含启动任务占用事件循环的窗口，实测从 0.5 秒到 14 秒；慢不等于失败。

服务条目按 plist 的 `ProgramArguments` 认本检出的 `src/main.ts`，不按 label 猜。在 worktree 里跑时找不到就报 `service_not_managed`，不会操作另一份检出的服务。脚本读 plist 的 `EnvironmentVariables` 决定数据目录，不读调用者的 shell 环境。

plist 的 `ProgramArguments[0]` 指向 `~/.local/libexec/tracery`，一份 bun 二进制的硬链接；系统界面按可执行文件名显示进程。链接与源文件共享 inode，不占额外空间。bun 升级换掉源文件后链接仍指向旧版本，升级之后重建：

```sh
ln -f "$(realpath "$(command -v bun)")" ~/.local/libexec/tracery
```

为什么不用别的改名方式，见 [launcher 显示名](../.agents/notes/implemented/process/2026-10-27-launchd-launcher-name.md)。

`stop` 之后采集器不接收新证据，magpie 与 harness 的请求照常走完，只是这段时间没有新记录。手工起停（不走 launchd）时 `SIGTERM` 或 `SIGINT` 仍然可用：收到信号后先清定时器，等在飞的那一轮派生把当前组落盘，再终止计算线程、停 HTTP 服务、关库。`SIGKILL` 不会走这套流程，库本身仍然一致（WAL + `synchronous=NORMAL`），只是 WAL 里可能留着未回放的已提交页，下次打开自动回放；在飞组保持 dirty，重启后重算。

计算线程崩溃（例如计算中抛错退出）只让在飞的那一组失败：这一轮不写库，组保持 dirty，下一次 tick 新建线程重算；已经提交的组不受影响，不会出现半发布。被拒绝的计算不动队列，重试代价就是重算这一组。

## 后台监控

监控是独立于采集器 launchd 任务的第二个作业，label `local.tracery-monitor`，每 300 秒执行一次采样与检查。它只读接口和本地文件，不改库，也不重启采集器。

```sh
bun scripts/monitor.ts sample     # 取一次 /api/metrics 与 /api/stats，写样本并轮转日志
bun scripts/monitor.ts check      # 读最近样本、按阈值判定、写告警并通知
bun scripts/monitor.ts report --days 1   # 按日报告；7 天用 --days 7
bun scripts/monitor.ts inspect    # 巡检：判据结果落盘 checks/<day>.jsonl，成功也写
```

`sample` 的退出码：`0` 采样成功，`1` 采样失败（超时、连不上、HTTP 错误或没有令牌）。失败样本照实写入，不填 0。`check` 的退出码对作业层交代采样证据：最新样本缺失、失败或超出存活阈值时返回 `1`——launchd 作业是 `sample; check`，shell 取末条退出码，sample 的失败由 check 补报。`inspect` 在采样证据新鲜时返回 `0`，否则 `1`。

样本与告警路径（数据目录默认 `~/Library/Application Support/tracery`）：

| 路径 | 内容 | 权限与保留 |
| --- | --- | --- |
| `monitor/samples/YYYY-MM-DD.jsonl` | 每次采样的允许列表字段 | 目录 0700、文件 0600，保留 14 天 |
| `monitor/alerts/YYYY-MM-DD.jsonl` | 告警、提醒与恢复事件 | 同上 |
| `monitor/checks/YYYY-MM-DD.jsonl` | 每次巡检的判据结果（成功也写） | 同上 |
| `monitor/alert-state.json` | 当前活跃规则与上次通知时间 | 0600，重启后沿用 |
| `monitor/logs/` | 诊断日志归档 | 0700；归档保留 14 天、总量 512 MiB |
| `monitor/monitor.log` | 监控任务自身的一行输出 | 0600，随采样轮转 |

采集器的诊断日志仍在 launchd plist 的 `StandardOutPath` / `StandardErrorPath`。live 文件达到 64 MiB 时，监控任务先复制到 `monitor/logs/` 再清空 live 文件；不删除、不改名，因为 launchd 还握着原文件描述符。

安装（先确认采集器 plist 的路径与运行时入口。运行时写绝对路径，本机是 `$HOME/.local/libexec/tracery`；不要写 `bun` 命令名，launchd 的 PATH 不含 nvm 目录）：

```sh
cat > ~/Library/LaunchAgents/local.tracery-monitor.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.tracery-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd /绝对路径/tracery &amp;&amp; /绝对路径/libexec/tracery scripts/monitor.ts sample; /绝对路径/libexec/tracery scripts/monitor.ts check</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/绝对数据目录/monitor/monitor.log</string>
  <key>StandardErrorPath</key><string>/绝对数据目录/monitor/monitor.log</string>
</dict>
</plist>
PLIST
mkdir -p "/绝对数据目录/monitor"
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/local.tracery-monitor.plist
```

`sample` 失败不影响随后的 `check` 执行（命令用 `;` 连接），失败本身会成为一条样本并参与 `service_unreadable` 判定。

卸载：

```sh
launchctl bootout gui/$UID/local.tracery-monitor
rm ~/Library/LaunchAgents/local.tracery-monitor.plist
```

`bootout` 只停监控作业，采集器不受影响。`monitor/` 下的历史数据不会自动删除，需要清空时手动处理。手工验证时先跑 `sample` 再跑 `check`；`check` 依赖最新样本，单独跑不会凭空产生告警。

本节讲每 300 秒的采样、判定与告警。数据质量、容量与证据链的周期性巡查（每次迭代、每周与触发式）见[巡查程序](patrol.md)；两套阈值分属两个家，`inspect` 的判据以 `scripts/monitor.ts` 为准，巡查的判据以 `scripts/patrol.ts` 为准。

## 维护命令

这些命令都在 `src/maintenance/cli.ts`，通过 `bun run maintain` 调用。退出码：`0` 成功，`1` 失败，`2` 用法错误。失败时 stderr 写 `<命令>_failed:<原因码>`。

```bash
# 只读校验：完整性与三类容易悄悄积累的结构问题
bun run maintain verify --db '<dataDir>/trace.db'

# hook 投递的只读窗口诊断：缺口、等待队列与已到达回调
bun run maintain hook-delivery --db '<dataDir>/trace.db' --since '2026-10-26T00:00:00Z' --until '2026-10-27T00:00:00Z'

# 离线备份到不存在的目标（只含数据库，不能恢复占位符连续性）
bun run maintain backup --db '<dataDir>/trace.db' --out '<新路径>/backup-2026-10-21.db'

# 可恢复快照：数据库、脱敏盐与清单一起发布到不存在的目录
bun run maintain bundle --dir '<dataDir>' --out '<新路径>/bundle-2026-10-21'

# 从 bundle 恢复到新目录，绝不覆盖已有目录
bun run maintain restore --bundle '<新路径>/bundle-2026-10-21' --out '<新路径>/restored'

# 整链重排某个会话的派生结果
bun run maintain rebuild --db '<dataDir>/trace.db' --session '<conv_key>'

# 把某个协议的历史正文按当前适配器重写
bun run maintain reparse --db '<dataDir>/trace.db' --protocol responses

# 空 session 身份迁移，默认只预览
bun run maintain migrate-hook-identity --db '<dataDir>/trace.db'
bun run maintain migrate-hook-identity --db '<dataDir>/trace.db' --apply --approval-id '<你的审批标识>'

# response id 前缀重算与等待队列重试，默认只预览
bun run maintain normalize-response-ids --db '<dataDir>/trace.db'
bun run maintain normalize-response-ids --db '<dataDir>/trace.db' --apply --approval-id '<你的审批标识>'

# 历史会话重复行并入既有网关/账本行，默认只预览
bun run maintain dedupe-sessions --db '<dataDir>/trace.db'
bun run maintain dedupe-sessions --db '<dataDir>/trace.db' --apply --approval-id '<你的审批标识>'

# 长期元数据淘汰，默认只预览
bun run maintain purge-metadata --db '<dataDir>/trace.db' --before 2026-09-01
bun run maintain purge-metadata --db '<dataDir>/trace.db' --before 2026-09-01 --apply --approval-id '<你的审批标识>'

# 按 agent 拆除一次来源的全部落库痕迹，默认只预览
bun run maintain purge-agent --db '<dataDir>/trace.db' --agent hermes
bun run maintain purge-agent --db '<dataDir>/trace.db' --agent hermes --apply --approval-id '<你的审批标识>'
```

路径与会话键都是示意，执行前换成已检查过的目标。不要把真实账号、令牌或正文写进命令历史、截图和工单。

### verify

`integrity_check` 直出，另查三类问题：

| 字段 | 含义 | 出现时怎么办 |
| --- | --- | --- |
| `dangling_blocks` | 没有任何 `request_block` 引用的正文块 | 正常维护后会归零；持续增长说明回收事务中途失败过 |
| `duplicate_evidence` | 同一 `(source_kind, ref_key)` 有多个 owner | 唯一索引本应拦住；不为 0 说明索引被绕过，先备份再查 |
| `pending_derivations` | `derive_queue` 里的分组数 | 采集器启动后会自行清空；停服务时看到的数字只说明停机前有积压 |

`integrity` 只有一项 `ok` 才算通过。损坏的库会直接抛错，不会被当成合格备份。

### hook-delivery

只读窗口诊断，用独立只读连接，不取维护锁、不停采集器。`--since` 与 `--until` 都要给，接受 epoch 毫秒或 ISO 8601；`--until` 同时是观察时点。

请求侧按 `started_ms` 落窗，`raw_hook` 与 `ingest_issue` 按到达与观察时间落窗。输出分四组：

| 组 | 字段 | 读法 |
| --- | --- | --- |
| `requests` | `total`、`with_hook`、`missing_hook` | 缺 hook 证据的行数，不等于回调没送达 |
| | `settled_missing`、`young_missing` | 以窗口右端退一个等待阈值（1 小时）为界；`young_missing` 只是还没等到 |
| | `missing_with_sources` | 已有账本、路由或 OTLP 的行也缺 hook：回调阶段没接上，不是请求没发生 |
| | `missing_without_response_id` | 回调即使到达也按 ID 对不上，只能留在未知 |
| | `awaiting_candidate` | 等待队列里已有指向本行的回调，差一次合并，不是投递缺失 |
| | `by_agent`、`by_status`、`by_kind`、`by_prompt_tokens`、`miss_reasons` | 缺口的分组计数；未知值单列，不归并进已知档 |
| `raw_hooks` | `received`、`reply_absent`、`body_omitted`、`by_agent` | 已到达的回调：回复缺失与正文降级分开计数 |
| `pending_hooks` | `total`、`without_response_id` | `first_seen` 早于窗口右端的等待项，含历史累积 |
| `issues` | 按来源与原因的计数 | `raw_hook_body_unlinked` 一类保留问题 |

前后窗口用同一组参数才有可比性。报告回答的是「哪个阶段没接上」，不能写成「回调从未发生」：`missing_hook` 只说明本行没有已关联的 hook 证据。

插件侧的失败码在 `ctx.state.collector_code`，只有宿主内存里的插件状态能看到，ATC 不读：`collector_delivered` 成功；`collector_attempt_timeout` 单次 fetch 超过 600 ms 被自己的计时器中止（接收方可能稍后才处理完，仍记失败）；`collector_host_abort` 宿主的 `ctx.signal` 被中止，不重试；`collector_network_error` 连接失败，重试一次；`collector_http_rejected` 收到非 2xx，`collector_status` 带状态码，4xx 不重试；`collector_deadline` 总预算 1500 ms 用尽。调大宿主 `gatewayTimeoutMs` 只影响 `collector_host_abort` 一种，不能据此排除其余原因。

### backup

顺序是：目标不存在 → 源库存在 → 目标目录可写 → 目标目录剩余空间够源库的 1.1 倍 → 独占探测 → `VACUUM INTO ?` → 权限 0600 → 对备份跑一次完整校验。

独占探测用 `PRAGMA locking_mode=EXCLUSIVE`：独占模式下第一次读要向 WAL 索引申请排他，别的连接还开着就拿到 `SQLITE_BUSY`，此时报 `source_must_be_stopped`。探测与 `VACUUM INTO` 走同一个连接，中间没有“确认之后又被人打开”的窗口。

常见错误码：

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `source_must_be_stopped` | 采集器或别的进程还开着这个库 | 停服务后重试，别删锁文件了事 |
| `destination_exists` | 目标已存在 | 换一个新文件名；不覆盖是刻意的 |
| `insufficient_space` | 目标目录余量不足源库的 1.1 倍 | 换目录或先腾空间 |
| `destination_unreadable` | 目标目录不存在或不可写 | 建目录后重试 |
| `source_unreadable` | 源库打不开或不是 SQLite 库 | 确认路径；先跑 `verify` |
| `source_not_wal` | 源库不是 WAL 模式 | 不是本采集器建的库，别当作备份源 |
| `backup_integrity_failed` | 备份校验不过 | 备份已删除；检查源库与磁盘 |

不要用 `cp` 拷裸数据库：WAL 里已提交但还没回放的页会丢。

### bundle

`backup` 只含数据库，不含脱敏盐，恢复后解释不了已有占位符。要能恢复采集连续性，用 `bundle`：源数据目录必须已停、权限 0700，目标目录必须不存在，且它与目标的父目录都得是 0700。

一个包恰好三样东西，权限都是 0600：

| 文件 | 内容 |
| --- | --- |
| `trace.db` | `VACUUM INTO` 生成的一致快照 |
| `redaction.salt` | 与库绑定的那份盐 |
| `manifest.json` | `format`、`schema`、`salt_id`、`database_sha256` |

顺序是：取维护锁 → 目录权限 → 空间余量（源库 1.1 倍 + 4 KiB）→ 同父目录建 0700 staging → 独占探测与 `VACUUM INTO` → **在独占连接仍然打开时**读盐并核对 `collector_state['privacy:salt']` → 写盐与清单 → 完整性校验 → `rename` 整个 staging 到目标。盐在释放独占约束之后才读的话，中间可能已被替换。

源库的绑定与盘上的盐不符报 `redaction_salt_mismatch`，盐文件缺失报 `redaction_salt_missing`（不会顺手生成新盐），结构版本不在 `RESTORABLE_SCHEMA_VERSIONS` 里报 `backup_schema_unsupported`。失败时只清理本次创建的 staging，目标不会留下半套目录。

### restore

`restore` 只认清单里的三个文件，多一个少一个都报 `restore_bundle_invalid`。校验顺序：

1. bundle 目录与三个文件都是 0600 / 0700、不是符号链接。
2. 清单可解析，`format=1`，`schema` 在白名单里，`salt_id` 与包内盐一致，`database_sha256` 与包内库一致。
3. 复制到目标父目录下的 0700 staging，再校验一次哈希与 `integrity_check`。
4. 以只读连接查包内数据库自身：盐绑定一致、`PRAGMA user_version` 与清单相等。
5. `mkdir` 原子保留目标名后再 `rename`；目标已存在报 `destination_exists`。

恢复不包含 `read.token`、`hook.token` 与 `otlp.token`。启动时这三个文件按首次启动规则重新生成，插件与 harness exporter 要拿新令牌重新注册——恢复盐连续性不等于恢复认证身份。

常见错误码：

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `source_must_be_stopped` | 采集器或别的进程还开着源库 | 停服务后重试 |
| `maintenance_lock_held` | 另一个维护进程持有锁 | 等它结束，别删锁文件 |
| `directory_permissions` | 源、目标父目录或 bundle 目录不是 0700 / 属主不符 | 收紧目录权限后重试 |
| `destination_exists` | 目标目录已存在 | 换一个新目录；不覆盖是刻意的 |
| `redaction_salt_missing` | 源目录没有盐文件 | 先在原目录恢复盐，或从可用的 bundle 恢复 |
| `redaction_salt_mismatch` | 库里的绑定与盐不是一对 | 不要继续；先查清哪份盐才对 |
| `redaction_salt_binding_invalid` | 绑定记录损坏 | 不要按缺失重建；先确认原盐 |
| `backup_schema_unsupported` | 库结构版本不在可恢复白名单 | 用对应版本的代码备份，不要跨版本恢复 |
| `restore_bundle_invalid` | 清单、哈希、版本或内容集合对不上 | 包已损坏或被改过，换一份备份 |
| `insufficient_space` | 目标目录余量不足 | 换目录或先腾空间 |

### rebuild

整链重排一个会话的派生结果，只重算正文仍可读（`available` / `partial`）的请求。它先把目标会话里 `purpose_target<2` 的行置为待判，再排空用途、重排组；普通 tick 不升级 clean 的历史行，历史用途只在显式重建时换代。只排空目标会话的任务；其它会话的积压留给它自己的维护窗口。输出包含：

- `queued`：处理的分组数（按 `conv_key` + `actor` 拆）。
- `unavailable`：正文不可用的请求数；它们保持原样。
- `reasons`：不可用的原因分类。`body_evicted_raw_present` 表示正文已回收但 raw 层还有原文，可以按物理身份重放后再重建；`body_evicted_raw_expired` 表示两边都没了，重算不出任何东西。
- `derive_version`：重排后该会话的最大内容变化次数。它不表示算法覆盖率。
- `queue_remaining`：目标会话重排后队列剩余量，正常为 0；其它会话的积压不计入。
- `recomputed_requests`：本次真正按可比较消息序列重算的请求数。
- `retained_requests`：本次消息序列不可比较、标题与摘要按旧值保留的请求数。
- `purpose_upgraded`：本次置为待判的历史用途行数。
- `purpose_processed`：本次结算的用途数。
- `purpose_remaining`：目标会话排空后仍未判用途的请求数，正常为 0。

`unavailable` 与 `reasons` 按正文状态统计，`recomputed_requests` 与 `retained_requests` 按实际比较结果统计，两者不能互相替代：正文状态为 `partial` 但没有骨架的请求计入后者，而不是重算。

`derive_no_progress` 表示用途与组阶段连续一轮都没有推进。先查用途落成 `error` 的行与它们正文的可读性：一笔读不出的请求重试三次后会消费修订并记 `error`，不应继续卡住排空；若仍无进展，按正文不可读处理，而不是反复重建同一会话。

正文已回收的请求不会因为重建而丢掉旧标题与已确认的工具配对：没有正文可读时，派生层保留原值，不把它们改写成时间兜底或空。

### reparse

把某个协议的历史正文按当前适配器重写。适配器升级后，旧行仍按写入时的布局保存；重解析把它们改成当前布局，逐条消息视图、分页与块级去重才会生效。

候选是 `adapter_version` 落后于当前版本、且仍有骨架的请求行；协议从骨架的长期字段读取，不看 `raw_hook`。每行一个独立事务：单行失败只记在报告里，其它行照常处理。两种旧布局都先完整恢复成原对象再重写：`has_messages=false` 的整段请求在骨架里，`has_messages=true` 的先从块还原。

拒绝重写的行原样保留，`adapter_version`、`body_state` 与原因都不动：

- `body_partial`：正文不完整，重写会丢掉没读到的部分。
- `skeleton_invalid`：骨架不符合写入契约；严格校验不通过时不做宽松解释。
- `body_unreadable`：块引用不完整，读不出原文。

输出字段：

- `scanned`：版本落后且有骨架的行数，含其它协议。
- `matched`：骨架协议等于 `--protocol` 的行数。
- `rewritten`：本次重写的行数。
- `rejected` / `failed`：拒绝与失败的行及原因。失败是单行事务抛错，不影响其它行。
- `unattributed_skeleton`：骨架读不出协议名的行；无法归属，原样保留。
- `remaining`：目标协议里仍版本落后的行数；被拒绝的行会留在这里。

重复执行不再处理已经升版的行：第二次运行 `scanned` 为 0，不新增块，也不推进 `input_revision`。重写会推进输入修订并标脏所在分组，派生结论在采集器下一次排空后才按新解释生效；要立刻重算，对受影响的会话再跑一次 `rebuild`。

### migrate-hook-identity

把 `["session",""]` 空桶里的 hook 孤儿行拆回各自的 hook 回退身份 `["hook", hook_id]`。新请求已在身份入口把空 session 当缺失，这个命令只处理旧行；`raw_hook.session` 保留上游空值，不改原始证据。

默认只预览：输出 `bucket`、`scanned`（桶内请求数）、`candidates`（可迁移行，含 `req_id`、`agent`、`hook_id`）、`agents`（桶内按 agent 分布）与 `rejected`（不可迁移行与原因）。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`。

拒绝原因：

- `ownership_attached`：已有账本、路由或 OTLP 证据，或 `have` 位图带账本/路由位；已关联行不套用 hook 回退，单列核查。
- `not_hook_born`：不是 hook 初建的行（`via<>'hook'`）。
- `actor_known` / `actor_present`：归属已经确认或存在有效 actor，不回退。
- `session_present`：请求行自己带着有效 session，与空桶矛盾。
- `hook_evidence_missing` / `hook_evidence_ambiguous`：没有 hook 证据或多份 hook 证据，无法确定唯一回退身份，不取首条猜测。
- `hook_evidence_merged`：hook 证据已并入别的目标。
- `hook_source_missing` / `hook_session_present`：`raw_hook` 不存在，或原始 session 非空，来源与空桶矛盾。
- `identity_changed`：执行期间身份已变化。

每行一个独立事务，事务内重新校验；迁移只改 `conv_key`、`conv_source`、`session`、`actor` 与 `updated_at`，随后按现有归属规则处理旧组并推进输入修订。`actor_state` 仍是 `unknown`，未知归属行不凭空建派生组。报告里的 `conservation` 对账请求、证据、块、别名、工具链接的行数与费用合计，`conserved` 必须为真。

重复执行时桶里只剩被拒绝的行：`migrated` 为 0，不推进修订。迁移不改变后续关联：hook 证据与等待队列不动，唯一 response ID 到达时仍按 `mergeHookInto` 并入账本目标。

### normalize-response-ids

按当前的 `normalizeResponseId` 重算存量 `response_id_norm`，让同一响应在 hook 与账本两侧落在同一个匹配键上，然后重试等待队列里的 hook。旧规则只剥一层前缀：OMP 的 hook 回执是 `chatcmpl-msg_<hash>`，账本是 `msg_<hash>`，两个键不相等，同一笔调用被拆成两行。

默认只预览：`requests`、`pending_hooks`、`raw_ledger` 是三个存量列里会改动的行数；`merges` 是重算后能唯一命中路由行的等待项数；`ambiguous` 是多候选、会留在队列里的数量；`without_id` 是没有 response id、无法按 id 关联的等待项。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`。

应用时先在一个写事务里重算三个列的存量键（`raw_ledger.response_id` 原始列不动），再循环调用 `reconcilePending`。唯一候选按 `mergeHookInto` 合并，正文迁到路由行，重复行删除，多候选保持 pending。只改派生键与等待队列，不动正文、不改 schema。重复执行时三个存量计数都是 0，已合并的等待项不再出现。

这条命令用于修幂等规范化之前的存量；新到的 hook 已经按新规则剥到裸键，不需要再跑。`without_id` 的等待项不会因为这条命令合并，它们没有可用于 join 的响应键。

### dedupe-sessions

修复本地会话来源的历史重复行：早期匹配规则要求模型名跨来源严格相等，网关的 `group/auto-…` 与本地 `auto/…` 对不上，同一笔调用会在 `request` 表里各留一行。默认只预览，输出 `scanned`、`candidates`、`merged`、`ambiguous`、`weak_only`、`already_owned` 与按来源的 `by_source`。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`。

只处理当前只有一条会话证据的请求：已经并入 hook 或账本证据的行是正式 owner，不会再被并走。身份判断复用 `findRequestOwnerTx`，只认 response id、turn ref 与四段用量指纹；只能被 ±60 秒弱时间窗配上的行只增加 `weak_only`，不在事后改行。命中后把源行的证据、正文引用、工具链接、别名与身份字段迁到目标，删除源行，重算两边的派生组；目标已有的正文与事实不覆盖。

重复执行时 `candidates` 与 `merged` 为 0。修复不重置采集游标，也不重新解析会话文件；后续轮转按修正后的规则直接合并。

### purge-metadata

默认只预览，输出 `requests`、`first_day`、`last_day`、`estimated_bytes`，不改任何东西。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`。

一个批次在一个事务里完成，顺序是：固定本批目标（临时表）→ 按目标证据删 `cost_observation` → 写 `retention_event` 与逐证据墓碑 `purged_evidence` → 删工具链接 → 删块引用与随之没有引用的块 → 删证据 → 清指向目标的 `prev_req_id` → 按 `new_id` 删别名 → 删请求 → 清没有其他引用的 `route_summary`。外键是 `NO ACTION`，顺序错了会直接失败而不是留下悬空引用，整个批次回滚。

墓碑按**证据键**记录，不按日期整日跳过：同一天里只淘汰了一部分请求时，剩下的仍然可以继续采。来源再回放命中墓碑时计 `purged_skip`，不复活。墓碑绑定文件代际：上游重写或收缩导致代际变化后旧键不再匹配，重放按新证据处理，请求与原始行都可能重新落库。

墓碑本身也会增长。这一版不做墓碑压缩；真的到了需要压缩的规模，按可证明连续的物理偏移区间另做迁移，不要就地删墓碑。

### purge-agent

按 `agent` 拆除一次对话来源的全部落库痕迹，默认只预览，不改任何东西。预览输出 `requests`、`conv_keys`、`shared_conv_keys`、`groups`、`groups_with_remaining`、`first_day`、`last_day`、`estimated_bytes`，以及 `evidence` 与 `raw` 两组可删行数。`estimated_bytes` 计入请求正文、骨架、原始行与可删的路由摘要，共享正文块按引用去重后不计。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`；缺 `--agent` 是用法错误，退出码 2。

请求侧与 `purge-metadata` 共用同一套删除主干：固定目标 → 按证据键删 `cost_observation` → 写 `retention_event`（`action=purge_agent`，`reason=agent_removal:<agent>`）与墓碑 → 删工具链接、块引用与孤儿块 → 删证据 → 清 `prev_req_id` → 按 `new_id` 删别名 → 删请求 → 清没有其他引用的 `route_summary`。之外还清来源层：`raw_ledger`、`raw_route`、`raw_hook`、等待队列里对应的 `pending_hook`、指向被删请求的 `bg_job` 与 `otlp_body_ref`，以及派生快照里属于这些请求的逐行结果。

共享守卫按证据键判断：原始行、路由或摘要仍被删除集合之外的请求引用时保留。`shared_conv_keys` 是被别的 agent 同时使用的会话桶数量；这些桶里剩下的成员在同一事务里按剩余请求重算派生组，空掉的组同步成 clean。

墓碑语义与 `purge-metadata` 相同。route 重放只把路由应用到已存在的请求，不为删除的请求建行；hook 被上游重投时按新请求落库，因为 hook 摄入不查墓碑。`ingest_issue` 与 `source_gap` 是诊断记录，不随拆除删除。

## 恢复流程

恢复始终在**新目录**里验证，不就地覆盖当前 `trace.db`。

1. 停服务：`bun run service stop`。
2. `verify` 当前库，确认问题不是磁盘或权限。
3. `bundle` 到数据目录外的一个新目录；只有数据库的 `backup` 不能恢复占位符连续性。
4. `restore` 到另一个新目录，按 `restore` 的校验顺序确认清单、哈希、盐绑定与结构版本都通过。
5. 用 `ATC_DATA_DIR` 指向恢复目录启动：首次启动会重新生成 `read.token`、`hook.token` 与 `otlp.token`，插件与 exporter 要用新令牌重新注册。
6. 先让合成来源跑一遍分页、正文与路由，确认占位符与备份前一致。
7. 确认无误后再停服务、切换配置，然后起回原服务。

游标可能落后于上游：重放按物理身份进行（文件代际 + 偏移），hook 的 best-effort 缺口仍然保留。**不要**把恢复库当成“补回了停机期间的正文”——停机期间没被投递的 hook 就是没投递，缺口表里会一直显示。

## 维护锁

维护命令先取 `<dataDir>/maintenance.lock`（`wx` 原子创建，内容记 pid 与持有者标识）。取不到就退出，不猜是不是自己上次留下的。

- 同一持有者重入：沿用原锁。
- 不同持有者、且记录里的 pid 已不存在：按注入的 `pidAlive` 确认后才清理并记 `recovered`。
- 其余一律拒绝，退出码 1，错误码 `maintenance_lock_held`。

采集器启动时也会检查这把锁：存在就抛 `maintenance_lock_present:<路径>` 并拒绝启动。**陈旧锁不自动覆盖**——`SIGKILL` 掉维护进程后会留下它，操作者确认进程已不在、看清路径后再手动删除。

## 掉电与 NORMAL 边界

`synchronous=NORMAL` 在 WAL 模式下能保证进程崩溃不丢已提交事务；掉电时最后几个已提交事务可能丢，但库不会损坏。可以接受的范围是：账本与路由会从上游重放回来，正文可能少几笔，缺口表如实反映。如果要求零丢失，把 `synchronous` 调到 `FULL`，代价是每次提交多一次 fsync。

## 费用时钟冲突

费用观测的 `observed_at` 取实际收到响应的时间。同一证据的新投影如果时间**不大于**已有最新观测（同毫秒或系统时钟回退），整页回滚、进度不动，并记 `cost_observation_conflict`；不覆盖旧值、不伪造递增时间、不用 `INSERT OR IGNORE` 吞掉冲突。

诊断顺序：

1. 看 `/api/stats` 的 `cost_health`（或 `collector_state` 里键为 `["cost","clock_conflict"]` 的记录）：`count` 是累计冲突次数，`blocked_at` 是阻塞的那条证据最新观测时点，`ref_key` 是证据键，`period` 是扫描窗口。
2. 核对系统时钟。实际时间再次超过 `blocked_at` 之后，下一次扫描会自动恢复。
3. 校时后按当日窗口重扫（采集器每小时自动跑一次当日窗口，也可以重启服务立即触发）。
4. **不要**靠删除旧观测或伪造递增时间“修好”它。冲突期间账本与正文摄入照常进行，只有费用前进停住，这个停住在 `cost_health` 里是明示的。

## 容量与回收

正文预算 10 GB、总盘 16 GB（十进制），用 `ATC_BODY_BUDGET`、`ATC_DISK_LIMIT` 覆盖。三道门槛带滞回，模式变化才写 `collector_state`：

| 触发 | 效果 | 恢复条件 |
| --- | --- | --- |
| 正文 ≥ 预算 | 回收最旧正文到 90% 预算 | 回到 90% 以下 |
| 总盘 ≥ 80% | 只接元数据，正文标 `partial` / `disk_body_paused`；OTLP span 照收，body_ref 停读文件、记 `metadata_only` | 跌回 75% 以下 |
| 总盘 ≥ 95% | hook 一律 507，什么都不写；OTLP 端点同样整批 507 | 跌回 90% 以下 |
| 剩余空间 < `max(256 MiB, 2 × 本批上界)` | 暂停 | 余量回到门槛以上 |

总盘量的是数据目录下所有普通文件之和（深度 3），目录里的备份、导出与临时文件同样计入。占用卡在 75–80% 滞回带里迟迟不恢复时，先看目录里有没有这类文件，不要只量库本身。

页面顶栏在降级时显示标签：`metadata_only` 出「存储降级 · 正文暂停」，`paused` 出「存储降级 · 采集暂停」，正常态不占位。标签在启动、显式刷新与点按时各读一次 `/api/stats` 的 `admission`，不轮询，所以切换后可能滞后，点按即重新读取。标签只说明当前准入与原因；哪些正文没保存，看每笔记录的 `miss_reason`。

回收在单个事务里删引用、删孤儿块、清骨架、改状态，`have` 与历史读数不动，`body_prev_state` 保留原状态。raw 层保留 7 天，到期只删原文、给证据标 `payload_state=expired`；仍带正文又没完成关联的 hook 原文不按到期删，只在 `ingest_issue` 记 `raw_hook_body_unlinked`。会话原始层同样按 7 天 TTL，只清没有游标引用的孤儿代际与已封口且 7 天没有成功摄入的代际；追加文件的当前代际保留，供批次间重放。全量 `/api/ingest-metrics` 的 `raw_session_rows` 与 `raw_session_bytes` 是这两类增长的观察口径。

## 派生切片与代际

普通启动（`bun run start`）不设切片预算，派生走同步组阶段：一次调用算完一批组，结果写回 `request` 行。切片模式由容量实验的两个入口注入预算：`long-10000-slice` 场景（`--slice-budget <预算文件>`，进程内建库）与容量实验的子进程采集器（`--slice --slice-budget <文件>`）。两者都只从预算文件的 `slice.derive_budget` 读，缺了以 `capacity_slice_budget_missing` 退出 2，不落回默认预算——那会把一条常量冒充成校准结果。运维入口的模式开关留到切片正式上线时再补。默认预算常量在 `src/config.ts` 的 `DEFAULT_DERIVE_BUDGET`，七项含义与超限时的行为：

| 项 | 默认 | 超限时 |
| --- | --- | --- |
| `maxRequestMs` | 10 ms | 丢弃整代（`slice_request_budget` 等阶段预算失败） |
| `maxStageBatchMs` | 250 ms | 本阶段批次到此为止，下一批继续 |
| `maxCandidatesPerBatch` | 100 | 单笔请求的候选超过它就是丢弃整代（候选按请求整笔算） |
| `maxWritesPerBatch` | 500 | 页写到上限即提交，下一批继续 |
| `maxStagedBytes` | 64 MiB | 丢弃整代（`slice_disk_budget`，暂存行按行数估算） |
| `maxWalGrowthBytes` | 32 MiB | 丢弃整代（同一个 `slice_disk_budget`；WAL 是真实字节，检查在事务外做 `PASSIVE` checkpoint） |
| `maxRetiredGenerations` | 2 | 更旧的退役代连结果行一起删 |

WAL 闸门量的是整库增长，不只是这一代：别的写入把 WAL 抬高时，这一组也拿不到发布资格，会在队列上保持 dirty 反复重建。停机时看到的 dirty 组数与队列行上的 `last_error` 是这两个预算的可见后果。

启动时无论哪种模式都跑一次 `recoverSlice`：把队列上仍指向 `building`／`ready` 代的未发布代丢弃（`reopened_unpublished`），队列行保持 dirty 等下一轮重建。上一轮没发布完的半套结果因此不会被续跑成一代正式结果。

丢弃的记录留在库里，不静默：`derive_generation.state='discarded'` 是这一代被否掉的结论，`derive_queue.last_error` 是原因码（阶段预算、修订变化、覆盖不全、磁盘预算）。`pending_derivations` 只数未完成组数，不数被丢弃的代；判断"是不是一直在丢"要按 `discarded` 与 `last_error` 看。

切片模式目前未启用。10,000 笔单链的实测排空是 878,696 ms（同步同输入 1,959 ms），`drain_ms` 的 120,000 ms 上限未过，门槛判 `slice_not_converged`，采集器继续走同步派生；同一轮的代际结构不变量（发布 1 代、丢弃 0 代、增量与全量逐字一致）全部成立，慢在切片入口的事务开销。跑法、逐项读数与预算出处记在[容量基线记录](superpowers/capacity/2026-10-22-atc-capacity-baseline.md#切片长组实测)。

## 与旧采集器并行核对（可选）

AVA 是作者的私有前身采集器，不在本仓库。这一节只在你需要从另一个已有的采集器迁移时才有意义：`scripts/verify-cutover.ts` 只读比较 collector 与那个采集器的正文覆盖，用来判断能不能停掉旧的。

```bash
bun run verify-cutover --from <epoch-ms> --to <epoch-ms> \
  --collector '<dataDir>/trace.db' --ava '<AVA 库路径>' --out '<仓库外路径>/report.json'
```

分母是 collector 已保存的账本（`raw_ledger`，固定 `via=through`），窗口左闭右开。两边用同一窗口、同一筛选，`--status` 可再收窄。报告分两份：`normalized` 用规范化后的 ID（`request.response_id_norm`），`raw` 用原始 ID（`raw_ledger.response_id`）。规范化会把不同上游 ID 折成一个，两份报告的歧义数之差就是折叠量。两份各自都要满足守恒关系：

```
分母 = 有正文 + 无正文 + 无法唯一判断
```

`无法唯一判断` 包括 NULL response ID 与规范化后重复的 ID；它们单列在 `null_id_counts` 与 `ambiguous_ids` 里，不丢弃、也不把多条真实请求压成一条计数。`missing_both` 是两边都没有正文的 ID——这类差异不能靠“集合交集”藏起来。

AVA 的表名不猜：脚本先读 `sqlite_master` 与 `PRAGMA table_info`，按字段名挑唯一可用的映射。挑不出来时报 `ava_schema_unrecognized` / `ava_schema_ambiguous` / `ava_body_column_unknown`，并把看到的表与字段打印出来；此时**先记录映射再改脚本**，不要随便指一张表去读。时间列是秒还是毫秒必须显式给 `--ava-time-unit s`，脚本不猜。

只抽取 response ID、时间、状态、大小与可用性元数据，不读正文。报告里有真实 ID 清单，因此强制写在仓库外、权限 0600；写进仓库会以 `report_inside_repository` 退出。终端只打印计数，不打印清单。

分桶给出 `protocol`、`status`、`size`、`miss_reason` 四组覆盖数。没有请求大小的行留在 `unknown`，不编造“超过某个上限”的原因。覆盖率按运行窗口看，不沿用旧样本里某个固定条数。

### 安装 collector 插件

每一步先读实际目标：注册是合并条目，不能整份覆盖 `plugins.json`，也不能移除其他插件。

1. 记录现状：magpie 插件文件路径、AVA 的服务定义（label、启动命令、工作目录、端口）。备份到本地受限目录，备份内容不打印到终端、不进仓库。
2. 令牌：32 随机字节，写本机 0600 配置文件。hook 令牌不能复用 `<dataDir>/read.token`，脱敏盐也不能当令牌用。
3. 生成注册片段供核对，结构如下（`spec` 用绝对路径，collector 用固定 Bun 绝对路径启动，不依赖交互 shell 的 PATH）：

```json
{
  "spec": "/absolute/collector/plugins/collector.hooks.ts",
  "options": {
    "endpoint": "http://127.0.0.1:8320/hook/ingest",
    "token": "<本机生成的 hook 令牌>",
    "gatewayTimeoutMs": 2000
  }
}
```

4. 生成 launchd plist（`~/Library/LaunchAgents`，label `local.tracery`），设 `WorkingDirectory`、`ProgramArguments`、`KeepAlive` 与受限日志路径，先 `plutil -lint`。
5. 启动 collector，确认健康接口带 Host 保护、`/api/stats` 可读。
6. 按 magpie 官方入口 `magpie plugin add <本地 hook 路径>` 添加，核对生成的配置只多了这一条。
7. **保持 AVA 继续运行**，用自然发生的流量观察至少 24 小时。观察窗口必须覆盖一次 collector 重启和一个带大请求的会话；达不到就延长，不人为发大模型请求补样本。

### 上线门槛

| 项目 | 必须有的结果 |
| --- | --- |
| 来源追赶 | ledger/route 追平；没有未解释的解析失败或长时间 pending 堆积 |
| 正文覆盖 | 同窗口集合差已逐类解释；不低于 AVA 的可解释范围；额外缺口有明确原因 |
| 请求守恒 | 尝试不增顶层请求；重复投递不增引用与费用；歧义没被强合并 |
| 压力 | 大 envelope 与真实峰值下 hook 确认延迟有余量；95% 暂停可观察 |
| 回收 | 幸存正文可还原、共享块不误删、历史元数据不变、DB/WAL 确实收缩 |
| 恢复 | `SIGKILL`、备份恢复、缺口补采测试通过；掉电边界已写明 |
| 回滚 | AVA 实际启动命令、插件条目、launchd label 与备份都可用 |

### 停 AVA 与回滚

先停 AVA 服务，再从 `plugins.json` 移除 AVA 条目，撤掉它的常驻与开机启动，**保留 AVA 库只读**。每一步之后确认 collector 仍在采到新的自然请求，ledger/route 游标继续前移。

回滚：重新启用备份里的 AVA 条目与原服务，再停用 collector 的 hook。collector 库保留供排查，不删除、不覆盖。配置回滚按条目合并，不能拿整份旧 `plugins.json` 覆盖并行窗口里别人新增的配置。

完成演练后恢复最终选定状态，把起止时间、任何正文缺口与最终服务状态记进本地报告。真实运行需要等待，不能用合成测试结果替代 24 小时观察。

## OTLP 接入

采集器自带 OTLP 接收端点：`POST /v1/traces` 与 `POST /v1/logs`，Bearer 认证用数据目录里的 `otlp.token`。令牌文件是 32 字节裸二进制，请求头里要放它的 base64url 形式（`read.token`、`hook.token` 同一约定，见 `src/main.ts` 的装载处）——直接 `cat` 文件会把非 ASCII 字节塞进请求头，请求在 HTTP 层就被判畸形，收到空的 400。取值用命令替换，不落进 shell 历史：

```sh
ATC_TOKEN=$(base64 -i '<dataDir>/otlp.token' | tr '+/' '-_' | tr -d '\n=')
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8320
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $ATC_TOKEN"
```

Claude Code 与 OMP 按 OTel 标准环境变量配置，endpoint 给到根、SDK 自己拼 `/v1/traces`。Claude Code 要正文文件指针时再开 `OTEL_LOG_RAW_API_BODIES=file`（logs 走 `http/json`，事件里带 `body_ref` 路径，采集器按指针读文件落正文）；OMP 的 logs 只有 run 级汇总，开了也不产逐笔正文。协议按 harness 各自支持的选择：`application/x-protobuf` 与 `application/json` 两种都收。

Codex 不读 OTel 标准变量，配置在 `~/.codex/config.toml`——三个 exporter 各管一个信号，traces 是 `trace_exporter`，默认关；端点是信号各自的完整 URL。`protocol` 的取值是 `binary` 或 `json`（不是 `protobuf`，写错会在加载配置时直接报 `unknown variant`）：

```toml
[otel.trace_exporter.otlp-http]
endpoint = "http://127.0.0.1:8320/v1/traces"
protocol = "binary"

[otel.trace_exporter.otlp-http.headers]
authorization = "Bearer $ATC_TOKEN"
```

turn span（`session_task.turn`）落成请求行，带会话（`thread.id`）、模型与七项用量里的四项。`service.name` 取 originator，随入口变化（`codex exec` 是 `codex_exec`，交互 CLI 是 `codex_cli_rs`），`OTEL_SERVICE_NAME` 覆盖无效，白名单按这一族取值收。Codex 的导出不带逐笔正文（logs 的用户提示默认 REDACTED，没有任何事件携带模型回复），正文读数仍由 magpie 路承担。

验证（空载荷也应回 200）：

```sh
curl -s --noproxy '*' -X POST http://127.0.0.1:8320/v1/traces \
  -H "authorization: Bearer $ATC_TOKEN" \
  -H 'content-type: application/json' -d '{"resourceSpans":[]}'
# {"partialSuccess":{}}
```

| 状态 | 原因 |
| --- | --- |
| 400 `invalid_otlp` | 载荷解码失败，响应带原因码（`otlp_wire_*` / `otlp_json_*`） |
| 401 | Bearer 令牌不对 |
| 403 | Host 头不是 `127.0.0.1` / `localhost` |
| 405 | 不是 POST |
| 413 | 整批超过 64 MiB |
| 415 | content-type 不在白名单；浏览器跨站写不进来 |
| 429 | 与 hook 共用的单飞守卫，稍后重试 |
| 503 | 写库失败（`writer_failed`），exporter 按 OTLP 语义重发 |
| 507 | 95% 磁盘档整批拒收，腾空间后自动恢复 |

未登记 `service.name` 的导出不建行：span 全量落原始层，并按服务与日聚合记一行 `service_not_registered` issue（健康接口的 issues 列表可见）——新 harness 把 exporter 指过来这件事在列表上看得见。查有哪些服务敲过门、各落了多少 span：

```sh
sqlite3 "$HOME/Library/Application Support/tracery/trace.db" \
  "SELECT service, COUNT(*) AS spans, MAX(received_at) AS last_seen FROM raw_otlp_span GROUP BY service ORDER BY service"
```

## schema 版本

当前 `user_version=12`。空数据目录首次启动直接建到 v12；v6 到 v11 库打开时在单个事务里原地升到 v12，更早版本报 `schema_rebuild_required`（错误信息带 db 与 code 的版本号），高版本报 `schema_version_unsupported`。可恢复 bundle 的结构版本白名单是 v6 到 v12，旧版本包恢复后首次打开同样原地升级。

v12 把 v11 的 `raw_droid_event` 原地改名为 `raw_session_event` 并加 `source_kind` 列，五个本地 Agent 适配器与 droid 共用一张原始层。旧行保留并补 `droid_transcript` 默认值，索引重建为 `(source_kind, session_id)`；新装库若因旧脚本同时存在两张表，旧表行先并入再删除。升级不扫描正文，停顿是毫秒级。升级后 `sessions` 定时器从偏移 0 开始按每家 64 个文件或 2 MiB 追历史；当前调度改为 live/backfill 两档，见[架构设计](architecture-design.md)。页面上 `via='session'` 的行按 `agent` 区分来源。

v11 在 v10 之上新增 `raw_droid_event` 与 `session_usage` 两张表及一条索引，建表与索引全是 `IF NOT EXISTS`，不扫描存量、不回填，升级停顿是毫秒级。升级后的第一轮 droid 扫描从各转录的偏移 0 开始，按每轮 64 个文件或 8 MiB 分批摄入历史；已有行由统一 owner 规则认领，不重复建行。

v10 在 v9 之上给 `request` 加 `user_fingerprint` 与 `turn_ref` 两列（内容指纹与 turn 身份）和两条按非空值的部分索引。索引要在存量全表上扫描：本机 4.03 GB 库热缓存实测约 2.0 s，冷缓存按 8 s 规划重启窗口。迁移只加列不回填——存量行两列为 NULL，派生队列没有待办，启动路径不做任何重算。

v9 在 v8 之上给 `derive_queue` 加一列 `claim_from_sort`（写侧认领边界），是 `ALTER TABLE ADD COLUMN` 加常量默认值，不重写表、不建索引，存量行取空串。加列脚本自带列存在性判断：SQLite 的 `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，没有这层判断时一次失败的启动会让下次重试报 `duplicate column`，库卡在打不开的状态。

v8 在 v7 之上加的两条部分索引（`i_req_prev`、`i_tool_result_req`）要在存量数据上扫描建索引。升级在启动路径里执行，属一次性成本：本机 3.1 GB 库实测约 6.2 s（扫描 `request` 全表，骨架 BLOB 使表页散布在大文件里，冷缓存占大头），同一次启动内其余步骤毫秒级。之后启动只查 `sqlite_schema` 即短路，不再扫描。接受一次秒级启动停顿换来零新增维护机制；存量规模再涨一个量级、停顿不可接受时，改为先停采集器、显式执行升级再启动，那个决定属于运维契约变更，要改这一节。建索引在单个事务里，中断即整体回滚，`user_version` 停在旧版本，索引不存在，下次启动从头重跑；升级失败时库保持原版本可打开状态，先看启动日志里的 SQLite 错误再重试。

首版发布前的破坏式替换只对 v6 之前的库：升级代码前先停采集器，把旧数据目录整体移走或删除，再让新版本建新库；旧库里的正文与派生结果一起丢弃，没有"结构已升级、数据未迁移"的中间态。重建后的历史只有元数据：账本与路由的重放不产生正文，正文只能从 hook 或 OTLP 的 body_ref 拿到，所以重建前的正文、预览与工具配对都补不回来。要留住正文就在升级前导出：正文落在旧库的 `block.z` 与 `request.skeleton_z`，`raw_hook` 里的原文在完成关联后通常已经清空，不是可靠的导出源。`scripts/backfill-fingerprint.ts` 补的是 v3/v4 时代的派生列，不是到当前版本的路径——它把 `user_version` 写成 4，当前代码打不开它。不要手改 `user_version`。

### 部署顺序：重启只完成迁移，不回填存量

带 schema 变更或判据变更的发布，顺序固定是**备份 → 重启 → 显式 rebuild → 验证**，不是"重启完就生效"：

1. **备份**：`maintain bundle` 要求源库已停，所以先 `bun run service stop`，bundle 到数据目录之外，再启动新代码。失败时保留库与 WAL 文件，按错误码处理后在低峰重试。
2. **重启**：`openStore` 在启动路径里完成原地迁移（一次性索引扫描停顿，见上）。重启后先只读核对：`PRAGMA user_version` 到目标版本、`integrity_check` 为 ok。
3. **显式 rebuild**：迁移只加表、列或索引，不回填存量；需要让存量会话按新判据收敛时，逐会话（或分批）跑 `bun run maintain rebuild --session '<conv_key>'`。不要在重启窗口顺手跑全量 rebuild——大会话的升级在秒级，会占主线程。
4. **验证**：区分「迁移成功」与「回填完成」。迁移成功的只读自检是本批新增表或列随新流量开始出现行（例如 v12 的 `raw_session_event.source_kind` 与各 `*_session` 游标）；回填完成的验收是 `GET /api/sessions` 的标题、flags 与 request_count 符合新规则预期。重启后立刻看会话列表，看到旧行为是「还没 rebuild」，不是「功能没生效」。
