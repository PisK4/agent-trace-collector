# 运维手册

采集器把账本、路由与 hook 三路证据写进同一个 SQLite 库。在线读取走独立只读连接，写入全部走单写者事务。下面这些操作都在**采集器已停止**的前提下进行。

## 数据目录

默认 `~/Library/Application Support/agent-trace-collector`，用 `ATC_DATA_DIR` 覆盖。目录权限 0700，里面的数据库、WAL、日志与两个令牌文件都是 0600。

| 文件 | 用途 |
| --- | --- |
| `trace.db` | 主库，WAL 模式，`auto_vacuum=INCREMENTAL` |
| `read.token` | 页面读取令牌，首次启动生成 |
| `hook.token` | 插件投递令牌，首次启动生成；插件只拿这一个 |
| `redaction.salt` | 脱敏用的本地盐 |
| `maintenance.lock` | 维护命令的独占锁，只在维护期间存在 |

停服务：`SIGTERM` 或 `SIGINT`。收到信号后先清定时器、停 HTTP 服务、再关库；`SIGKILL` 不会走这套流程，库本身仍然一致（WAL + `synchronous=NORMAL`），只是 WAL 里可能留着未回放的已提交页，下次打开自动回放。

## 维护命令

四条命令都在 `src/maintenance.ts`，通过 `bun run maintain` 调用。退出码：`0` 成功，`1` 失败，`2` 用法错误。失败时 stderr 写 `<命令>_failed:<原因码>`。

```bash
# 只读校验：完整性与三类容易悄悄积累的结构问题
bun run maintain verify --db '<dataDir>/trace.db'

# 离线备份到不存在的目标
bun run maintain backup --db '<dataDir>/trace.db' --out '<新路径>/backup-2026-10-21.db'

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

### rebuild

整链重排一个会话的派生结果，只重算正文仍可读（`available` / `partial`）的请求。输出包含：

- `queued`：处理的分组数（按 `conv_key` + `actor` 拆）。
- `unavailable`：正文不可用的请求数；它们保持原样。
- `reasons`：不可用的原因分类。`body_evicted_raw_present` 表示正文已回收但 raw 层还有原文，可以按物理身份重放后再重建；`body_evicted_raw_expired` 表示两边都没了，重算不出任何东西。
- `derive_version`：重排后该会话的最大派生版本。
- `queue_remaining`：重排后队列剩余量，正常为 0。

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
3. `backup` 到一个新路径。
4. 在新目录里打开备份：`verify` 通过、权限 0600、`collector_state` 里的探针值与备份时一致。
5. 用 `ATC_DATA_DIR` 指向新目录启动，先让合成来源跑一遍分页、正文与路由。
6. 确认无误后再停服务、切换配置。

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
| 总盘 ≥ 80% | 只接元数据，正文标 `partial` / `disk_body_paused` | 跌回 75% 以下 |
| 总盘 ≥ 95% | hook 一律 507，什么都不写 | 跌回 90% 以下 |
| 剩余空间 < `max(256 MiB, 2 × 本批上界)` | 暂停 | 余量回到门槛以上 |

回收在单个事务里删引用、删孤儿块、清骨架、改状态，`have` 与历史读数不动，`body_prev_state` 保留原状态。raw 层保留 7 天，到期只删原文、给证据标 `payload_state=expired`；仍带正文又没完成关联的 hook 原文不按到期删，只在 `ingest_issue` 记 `raw_hook_body_unlinked`。

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

## schema 版本

当前 `user_version=4`。v1→v2 是就地加两张表（`retention_event`、`purged_evidence`），v3 与 v4 都是派生列变更，用 `scripts/backfill-fingerprint.ts` 补齐并重跑派生。更高的未知版本直接拒绝打开（`schema_version_unsupported`），不猜兼容性；先备份再降级代码，不要手改 `user_version`。
