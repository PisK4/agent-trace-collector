# 运维手册

采集器把账本、路由、hook 与 OTLP 四路证据写进同一个 SQLite 库。在线读取走独立只读连接，写入全部走单写者事务。下面这些操作都在**采集器已停止**的前提下进行。

## 数据目录

默认 `~/Library/Application Support/agent-trace-collector`，用 `ATC_DATA_DIR` 覆盖。目录权限 0700，里面的数据库、WAL、日志与三个令牌文件都是 0600。

| 文件 | 用途 |
| --- | --- |
| `trace.db` | 主库，WAL 模式，`auto_vacuum=INCREMENTAL` |
| `read.token` | 页面读取令牌，首次启动生成 |
| `hook.token` | 插件投递令牌，首次启动生成；插件只拿这一个 |
| `otlp.token` | OTLP 端点令牌，首次启动生成；harness exporter 只拿这一个 |
| `redaction.salt` | 脱敏用的本地盐；与库里的绑定标识配对，不能单独替换 |
| `maintenance.lock` | 维护命令的独占锁，只在维护期间存在 |

`redaction.salt` 与库必须配对。库里的 `collector_state['privacy:salt']` 记这份盐的标识（加域前缀的 SHA-256，不含盐明文）；有数据却没有绑定、盘上没有盐文件、或盐与标识不符时，采集器拒绝启动，分别报 `redaction_salt_unbound`、`redaction_salt_missing`、`redaction_salt_mismatch`。启动路径不会顺手生成新盐：换盐会让库里已有的占位符再也解释不了。有盐文件却没有绑定同样拒绝启动（`redaction_salt_unbound`）：无法证明历史占位符是这份盐算的，也没有确认绕过的入口，旧库删除后重建。

停服务：`SIGTERM` 或 `SIGINT`。收到信号后先清定时器、停 HTTP 服务、再关库；`SIGKILL` 不会走这套流程，库本身仍然一致（WAL + `synchronous=NORMAL`），只是 WAL 里可能留着未回放的已提交页，下次打开自动回放。

## 维护命令

这些命令都在 `src/maintenance/cli.ts`，通过 `bun run maintain` 调用。退出码：`0` 成功，`1` 失败，`2` 用法错误。失败时 stderr 写 `<命令>_failed:<原因码>`。

```bash
# 只读校验：完整性与三类容易悄悄积累的结构问题
bun run maintain verify --db '<dataDir>/trace.db'

# 离线备份到不存在的目标（只含数据库，不能恢复占位符连续性）
bun run maintain backup --db '<dataDir>/trace.db' --out '<新路径>/backup-2026-10-21.db'

# 可恢复快照：数据库、脱敏盐与清单一起发布到不存在的目录
bun run maintain bundle --dir '<dataDir>' --out '<新路径>/bundle-2026-10-21'

# 从 bundle 恢复到新目录，绝不覆盖已有目录
bun run maintain restore --bundle '<新路径>/bundle-2026-10-21' --out '<新路径>/restored'

# 整链重排某个会话的派生结果
bun run maintain rebuild --db '<dataDir>/trace.db' --session '<conv_key>'

# 长期元数据淘汰，默认只预览
bun run maintain purge-metadata --db '<dataDir>/trace.db' --before 2026-09-01
bun run maintain purge-metadata --db '<dataDir>/trace.db' --before 2026-09-01 --apply --approval-id '<你的审批标识>'
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
- `derive_version`：重排后该会话的最大派生版本。它不表示算法覆盖率。
- `queue_remaining`：目标会话重排后队列剩余量，正常为 0；其它会话的积压不计入。
- `recomputed_requests`：本次真正按可比较消息序列重算的请求数。
- `retained_requests`：本次消息序列不可比较、标题与摘要按旧值保留的请求数。
- `purpose_upgraded`：本次置为待判的历史用途行数。
- `purpose_processed`：本次结算的用途数。
- `purpose_remaining`：目标会话排空后仍未判用途的请求数，正常为 0。

`unavailable` 与 `reasons` 按正文状态统计，`recomputed_requests` 与 `retained_requests` 按实际比较结果统计，两者不能互相替代：正文状态为 `partial` 但没有骨架的请求计入后者，而不是重算。

`derive_no_progress` 表示用途与组阶段连续一轮都没有推进。先查用途落成 `error` 的行与它们正文的可读性：一笔读不出的请求重试三次后会消费修订并记 `error`，不应继续卡住排空；若仍无进展，按正文不可读处理，而不是反复重建同一会话。

正文已回收的请求不会因为重建而丢掉旧标题与已确认的工具配对：没有正文可读时，派生层保留原值，不把它们改写成时间兜底或空。

### purge-metadata

默认只预览，输出 `requests`、`first_day`、`last_day`、`estimated_bytes`，不改任何东西。加 `--apply` 必须同时给 `--approval-id`，否则退出码 1 且错误码 `approval_id_required`。

一个批次在一个事务里完成，顺序是：固定本批目标（临时表）→ 按目标证据删 `cost_observation` → 写 `retention_event` 与逐证据墓碑 `purged_evidence` → 删工具链接 → 删块引用与随之没有引用的块 → 删证据 → 清指向目标的 `prev_req_id` → 按 `new_id` 删别名 → 删请求 → 清没有其他引用的 `route_summary`。外键是 `NO ACTION`，顺序错了会直接失败而不是留下悬空引用，整个批次回滚。

墓碑按**证据键**记录，不按日期整日跳过：同一天里只淘汰了一部分请求时，剩下的仍然可以继续采。来源再回放命中墓碑时计 `purged_skip`，不复活。

墓碑本身也会增长。这一版不做墓碑压缩；真的到了需要压缩的规模，按可证明连续的物理偏移区间另做迁移，不要就地删墓碑。

## 恢复流程

恢复始终在**新目录**里验证，不就地覆盖当前 `trace.db`。

1. 停服务。
2. `verify` 当前库，确认问题不是磁盘或权限。
3. `bundle` 到数据目录外的一个新目录；只有数据库的 `backup` 不能恢复占位符连续性。
4. `restore` 到另一个新目录，按 `restore` 的校验顺序确认清单、哈希、盐绑定与结构版本都通过。
5. 用 `ATC_DATA_DIR` 指向恢复目录启动：首次启动会重新生成 `read.token`、`hook.token` 与 `otlp.token`，插件与 exporter 要用新令牌重新注册。
6. 先让合成来源跑一遍分页、正文与路由，确认占位符与备份前一致。
7. 确认无误后再停服务、切换配置。

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

回收在单个事务里删引用、删孤儿块、清骨架、改状态，`have` 与历史读数不动，`body_prev_state` 保留原状态。raw 层保留 7 天，到期只删原文、给证据标 `payload_state=expired`；仍带正文又没完成关联的 hook 原文不按到期删，只在 `ingest_issue` 记 `raw_hook_body_unlinked`。

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

## 切换核对与 AVA 下线

`scripts/verify-cutover.ts` 只读比较 collector 与 AVA 的正文覆盖，用来判断能不能停 AVA。

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

以下步骤需要**明确授权**；写在这里不等于已经执行。每一步先读实际目标，注册是合并条目，不能整份覆盖 `plugins.json`，也不能移除其他插件。

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

4. 生成 launchd plist（`~/Library/LaunchAgents`，label `local.agent-trace-collector`），设 `WorkingDirectory`、`ProgramArguments`、`KeepAlive` 与受限日志路径，先 `plutil -lint`。
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
sqlite3 "$HOME/Library/Application Support/agent-trace-collector/trace.db" \
  "SELECT service, COUNT(*) AS spans, MAX(received_at) AS last_seen FROM raw_otlp_span GROUP BY service ORDER BY service"
```

## schema 版本

当前 `user_version=7`。空数据目录首次启动直接建到 v7；v6 库打开时在单个事务里原地升到 v7（纯新增，不动旧行），更早版本报 `schema_rebuild_required`，高版本报 `schema_version_unsupported`。可恢复 bundle 的结构版本白名单是 v6 与 v7，v6 包恢复后首次打开同样原地升级。

首版发布前的破坏式替换只对 v6 之前的库：升级代码前先停采集器，把旧数据目录整体移走或删除，再让新版本建新库；旧库里的正文与派生结果一起丢弃，没有"结构已升级、数据未迁移"的中间态。重建后的历史只有元数据：账本与路由的重放不产生正文，正文只能从 hook 或 OTLP 的 body_ref 拿到，所以重建前的正文、预览与工具配对都补不回来。要留住正文就在升级前导出：正文落在旧库的 `block.z` 与 `request.skeleton_z`，`raw_hook` 里的原文在完成关联后通常已经清空，不是可靠的导出源。`scripts/backfill-fingerprint.ts` 补的是 v3/v4 时代的派生列，不是到 v7 的路径——它把 `user_version` 写成 4，v7 的代码打不开它。不要手改 `user_version`。
