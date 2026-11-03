# Agent Note: 迁移失败即停机：自动重建的边界设计（F23）

Status: proposed

## Problem

当前 `openStore` 在启动路径里同步迁移，迁移抛错就关闭连接、异常继续上抛；[main.ts](../../../../src/main.ts) 顶层没有 catch，进程以非零码退出。生产由 launchd `KeepAlive=true`、`ThrottleInterval=10` 托管（[operations.md:22](../../../../docs/operations.md)），于是失败不是「停一次」，而是每 10 秒重来一次：每次都重新扫描全表建索引，2026-10-21～10-24 累计 13 次连续启动失败，最后靠删库建库恢复（F01）。同时启动路径没有任何备份调用，运维在深夜没有「回到旧库」的现成退路。

这条不是「加个 try/catch」就能收尾的缺陷：真正的风险是**自动重建会删数据**，而删数据的判断一旦写错，损失比停机大一个量级。所以本提案只定边界、状态机与验收，不承诺顺手能修。

## 现状证据（全部为只读实测与代码取证）

| 事实 | 数值 / 出处 | 用途 |
|---|---|---|
| v9→v10 迁移（3.91 GB 副本，热缓存） | `openStore` 2,043.6 ms；`i_request_user_fingerprint` 2,047.3 ms、两个 ALTER 0.6 ms、`i_request_turn_ref` 35.5 ms | 失败重试的单次成本约 2 s |
| 已迁移副本再开 | 11.1 ms | 正常启动不受影响 |
| 冷缓存外推 | 约 8 s | 重启窗口预估 |
| `VACUUM INTO` 快照 | 4.35 s → 3,913,723,904 B | 备用备份口径 |
| 生产库 | 4,030,124,032 B；1.1 倍需 4,433,136,435 B | 空间门槛 |
| v8 索引升级（3.1 GB） | 约 6.2 s（[operations.md:549](../../../../docs/operations.md)） | 重建/校验的耗时参照 |
| 备份实现 | `backupDatabase` 要求源库无连接（`source_must_be_stopped`）、目标不存在、剩余空间 ≥1.1 倍（[backup.ts:91-143](../../../../src/maintenance/backup.ts)）；`backupBundle` 还要求 `user_version ∈ [6,10]`（[backup.ts:152](../../../../src/maintenance/backup.ts)） | **关键约束：需要重建的旧库都 <6，bundle 拒绝备份** |
| 迁移分支 | v6/7/8/9 原地加列；`version < 6` 抛 `schema_rebuild_required`（[store.ts:240-242](../../../../src/store.ts)）；`version > 10` 抛 `schema_version_unsupported`（[store.ts:208](../../../../src/store.ts)）；0 且有表抛 `schema_unknown`（[store.ts:207](../../../../src/store.ts)） | 自动重建只能绑定 `schema_rebuild_required` |
| 失败清理 | 迁移在单事务内，失败整体回滚，`user_version` 停在旧值（[store.ts:236-239](../../../../src/store.ts)、[operations.md:549](../../../../docs/operations.md)） | 停机不会留下半迁移库，重试是可行路径 |
| 既有决策 | 「在 `openStore` 里自动重建」曾被明确否决：隐式破坏、无法区分「想重建」与「路径写错」（[destructive-schema-replacement](../../../implemented/architecture/2026-10-23-destructive-schema-replacement.md)） | 默认路径必须延续该决策 |

## 先把「重建」拆成两个词，否则后面所有结论都会错

- **R1 结构重建**：删除/移走旧库，按当前 schema 建一个空库。这是 `schema_rebuild_required` 现在隐含的动作，**全部 request、block、正文、派生结果一起消失**，只保留备份文件。
- **R2 派生重建**：`maintain rebuild --session <conv_key>`，在**已有行**上重算用途与派生（[rebuild.ts:36-52](../../../../src/maintenance/rebuild.ts)），不删数据，最大会话实测 1.76 s。

三套策略里的「回填」只有在 R1 之后才有意义，而 R1 之后库里一行 request 都没有，`maintain rebuild` 连 `conv_key` 都找不到。**所以「自动重建 + 自动回填」在没有旧库导入器的前提下不可实现**；这不是排期问题，是语义问题。本提案不新增导入器。

## Proposal

**推荐：默认走 A；只有显式开关才允许 C；B 不实现。** 即「默认快速失败 + 可执行自救指令」，「`--auto-rebuild` 且命中唯一允许的错误码时，先做零拷贝安全副本再重建空库，并明确标记数据已丢失、不回填」。

### 三套策略对比

| 维度 | A 快速失败 + 自救 | B 自动备份 + 重建 + 回填 | C 备份 + 重建、不回填 |
|---|---|---|---|
| 默认行为 | 停机，打印命令，非零退出 | 自动删库重建后自愈 | 同 B 的重建部分，但显式标注未回填 |
| 数据后果 | 不丢数据；服务不可用 | 旧库进备份；新库为空，「回填」无数据可填，属于伪能力 | 旧库进备份；新库为空，状态可见 |
| 无人值守 | 仍会每 10 s 重拉，但每次都失败在同一处，需防风暴 | 会自愈，但可能在错误原因（磁盘满、锁）上误删 | 同 B，但不会被误认为「已恢复」 |
| 误判风险 | 高：用户第二天才发现 | **最高**：看起来恢复了，实际历史全空 | 中：状态明确 |
| 与既有决策 | 一致 | 与「不在 openStore 自动重建」冲突 | 可兼容，前提是显式开关 |
| 实现成本 | 低（约 1 人日） | 高，且回填做不到 | 中 |

结论：A 是默认语义，C 是 A 之上的**显式逃生门**，B 因「回填」不成立而否决。

### 1. 不可逆性：旧库必须还在，回滚靠改名而不是复制

**始终保留旧库。** 自动重建只允许一种落盘顺序，全部在同一文件系统内用 `rename`：

```
$DATA_DIR/
  trace.db                     # 当前库（重建后是空 v10）
  trace.db-wal / -shm          # 只在旧库存在时成组移动
  store/
    state.json                 # 启动后写，停机时也能读
    startup-guard.json         # 失败次数
    startup-blocked.json       # 熔断标记
    rebuild-in-progress.json   # 换库阶段标记
  backups/
    pre-rebuild-20261103T220101Z-v5to10/
      trace.db
      trace.db-wal             # 存在才移
      trace.db-shm             # 存在才移
      manifest.json
```

- **备份方式默认是「改名」，不是 `VACUUM INTO`**：把 `trace.db`、`trace.db-wal`、`trace.db-shm` 成组 `rename` 进 `backups/pre-rebuild-<UTC>-v<old>to10/`。同一卷内改名是毫秒级、零额外空间，且能规避「磁盘满时备份本身失败」——磁盘满恰恰是最常见的迁移失败原因。
- **要跨卷留档**时设 `ATC_REBUILD_BACKUP_DIR`：此时必须走 `backupDatabase` 复制，门槛是剩余空间 ≥1.1 倍 + 64 MiB；空间不足直接拒绝，**不会为了腾空间删除旧备份**。注意该副本只能用于取证/手工恢复，CLI 的 `restore` 只接受 bundle，且 bundle 白名单从 v6 起，<6 的库进不去。
- **命名唯一且不可覆盖**：目录名带 UTC 时间戳与 `v<old>to<new>`，创建用 `mkdir`（已存在即失败），绝不覆盖。
- **校验清单**（`manifest.json`，0600）：`format`、`created_at_ms`、`code_version`、`source_bytes`、`source_user_version`、`target_version`、`request_rows`、`block_rows`、`request_evidence_rows`、`integrity: "ok"`、`salt_id`、`mode: "rename" | "copy"`。
  - 校验四件事：文件大小与源 `stat` 一致；`PRAGMA user_version` 等于记录的旧版本；`PRAGMA integrity_check` 恰为一条 `ok`（复用 [verify.ts:17-41](../../../../src/maintenance/verify.ts)）；三张核心表行数与重建前只读计数一致。
  - 4 GB 库的 `integrity_check` 是秒级成本，只在显式开启的重建路径上付一次，不进正常启动。
- **原子换库**：先在 `$DATA_DIR/.rebuild-new-<ts>/` 用 `openStore` 建出 v10 空库并校验（`user_version=10`、`integrity_check=ok`、`request=0`），关闭后确认没有残留 `-wal/-shm`，再按顺序：`rename(old → backups/…/trace.db)` → `rename(new → trace.db)`。两步之间崩溃由 `rebuild-in-progress.json` 的 `stage` 决定下一次启动是「继续换」还是「换回去」，任何时刻都不允许出现「没有 trace.db 且备份不可用」。
- **回滚**：新增 `maintain restore-store --from <backupDir>`，要求服务已停（复用维护锁），把三件套成组移回 `$DATA_DIR`，拒绝覆盖已存在的 `trace.db`。手工命令也写进文档，验收必须覆盖这条路径。

### 2. 什么时候允许自动重建

四道闸门全开才允许，缺一即退回 A：

1. **显式开关**：`--auto-rebuild`（`service start` 透传或 plist 参数）或 `ATC_AUTO_REBUILD=1`。默认关闭，文档与 plist 都不预置。
2. **错误码白名单只有一项**：`schema_rebuild_required`。以下一律拒绝：`schema_version_unsupported`（新库被旧代码打开，重建等于删掉未来数据）、`schema_unknown`、`auto_vacuum_requires_migration`、`maintenance_lock_present`、以及任何 `SQLITE_FULL` / `SQLITE_BUSY` / `SQLITE_IOERR` / `SQLITE_CORRUPT` / 未分类错误。**磁盘满、锁冲突、权限问题的正确动作是修因重试，不是删库。**
3. **只读预检**：`trace.db` 是普通文件、非符号链接；`user_version ∈ [1,5]`（也就是当前唯一会走到 `schema_rebuild_required` 的区间）；`tableNames()` 非空。预检必须先于 `openStore`，否则拿不到版本号就已经抛错。
4. **规模门槛**：`request` 行数 > 0 时备份是强制项，备份失败即拒绝；库 > 8 GiB 或 `request` > 1,000,000 行时只认 `--auto-rebuild=force`（第二把钥匙），因为校验与复制会把启动窗口拉到分钟级，属于「应当在维护窗口里人工做」的规模。空库（0 行）不需要备份，但仍然走改名保留，保留名为 `empty-<ts>`。

版本差距不作为门槛：`<6` 全部会命中同一分支，差距大小只影响数据损失量，不影响是否允许；真正决定风险的是行数与库大小。

### 3. 与 F25 的关系：重建后不可能回填，必须把「空」说清楚

- R1 之后 `request` 为 0，`user_fingerprint` / `turn_ref` 自然全空，`derive_queue` 为空，`maintain rebuild` 无 `conv_key` 可跑。**「重启了但集成没生效」会变成「根本没有数据」**，这是更响的信号，不能被当成正常启动。
- 因此重建成功必须同时满足：启动日志 `store.rebuild.swapped`（含 `data_lost:true`、`backup_dir`）、`/api/metrics.store = {state:"rebuilt_empty", data_lost:true, schema_version:10}`、磁盘 `store/state.json` 同样内容；缺任何一项视为验收失败。
- **回填不串进同一次启动**。即便未来做了保行的 R2，也必须服务先起来、再以有界的 `maintain rebuild` 分批跑：单会话 4,433 行已要 1.76 s，全库 1,134 组会把 `openStore`→listen 的窗口拉到分钟级，违背启动契约。回填失败时服务保持可用，状态降为 `backfill_partial`，不回滚、不阻塞。
- v9→v10 的失败**永远不进入重建**：它只是加列失败，重试即可；重建会把 53,057 行真实请求清空。F25 的部署顺序（重启 → rebuild → 验证）保持不变。

### 4. 无人值守：launchd 会一直拉，但每次都必须便宜且不再写盘

- `startup-guard.json` 记录最近 10 次失败的 `{at_ms, code}`。30 分钟内 3 次 `schema_rebuild_required`（或任何同一错误码）→ 写 `startup-blocked.json`，后续启动**先读它**，直接以 78 退出，不打开库、不做预检、不建备份，单次耗时目标 <200 ms。launchd 仍会每 10 s 拉起，但不再有 2 s 的索引扫描，也不会写爆备份目录。
- 重建本身只允许**每次进程一次**；重建失败立即写 `rebuild_failed` 并熔断，绝不在同一进程内重试。
- 熔断与「换库中」是两个文件：前者阻止新尝试，后者保证崩溃可续。解除熔断必须人工：打印出 `rm "$ATC_DATA_DIR/store/startup-blocked.json"` 与建议的 `maintain restore-store` 命令，然后重启；不提供自动解除。
- 退出码约定：`0` 正常；`65` 数据/结构错误（含 `schema_rebuild_required` 未开开关）；`78` 已被熔断。现有顶层异常路径是 1，需在 `main.ts` 显式映射，避免与普通崩溃混淆。

### 5. 观测：一眼看出「跑的是旧库还是新库」

- 结构化事件（沿用现有诊断日志的 JSON 行，字段走 [monitoring.ts:45-61](../../../../src/monitoring.ts) 的类型扩展）：`store.inspect`、`store.migrate.fail`、`store.rebuild.refused`、`store.backup.done`、`store.rebuild.built`、`store.rebuild.swapped`、`store.rebuild.fail`、`store.state`。
- 每次至少带：`schema_version`、`target_version`、`code`、`stage`、`sqlite_code`（有则带）、`dur_ms`、`source_bytes`、`backup_dir`、`backup_bytes`、`free_bytes`、`request_rows`、`attempt`、`hint`、`data_lost`。
- 可查询状态：`/api/metrics` 顶层新增 `store`：
  `{ state, schema_version, target_version, data_lost, backup_dir, backup_at_ms, rebuilt_at_ms, startup_attempts, blocked }`。
  其中 `state ∈ {created, normal, migrated, rebuilt_empty, blocked, failed}`；值为启动时缓存，不在请求路径查库。
- 停机期间可读：`$DATA_DIR/store/state.json`，用临时文件 + `rename` 原子写。运维判断口径固定为：`trace.db` 的 `user_version` + `store.state` + `data_lost` 三者一起看。
- 关键区分：`migrated`（v6～v9 原地升级）与 `rebuilt_empty`（R1）必须是两个状态，不能都叫「已升级」。

### 6. 清理

- 落点 `$DATA_DIR/backups/`（可用 `ATC_REBUILD_BACKUP_DIR` 覆盖），目录 0700、文件 0600，与库同级权限。
- 保留策略：自动快照最多 **2 份**；总占用上限取 `min(2 × 源库, 8 GiB)`；只删除 `pre-rebuild-*` / `empty-*` 且不是最新两份的目录。人工 `maintain backup` / `bundle` 的产物永不参与删除。
- 清理只在**一次成功启动之后**执行，失败/熔断路径绝不清理，避免把证据删掉后进入循环。
- 不做压缩、不做远端上传、不进仓库目录。

### 启动状态机

```
boot
  └─ maintenance lock? ── 有 ──> 退出（沿用现有报错）
  └─ startup-blocked? ── 有 ──> exit 78（<200 ms，不碰库）
  └─ rebuild-in-progress? ── 有 ──> 按 stage 续做或回滚 ──> 成功后继续
  └─ 只读 inspect
       ├─ 目录空 ─────────────> 建 v10 ──> state=created ──> listen
       ├─ v=10 ───────────────> 直接开 ──> state=normal ──> listen
       ├─ v=6..9 ─────────────> 原地迁移 ──> state=migrated ──> listen
       ├─ v<6 ────────────────> 记录失败
       │     ├─ 开关关闭 ────> 打印 hint，exit 65
       │     └─ 开关打开 ────> 规模/空间闸门
       │           ├─ 拒绝 ──> store.rebuild.refused，exit 65
       │           └─ 通过 ──> 改名备份 ──> 校验
       │                 ├─ 失败 ──> 换回，exit 65
       │                 └─ 成功 ──> 建空 v10 ──> 校验 ──> 原子换库
       │                       └─ 换库后 ──> state=rebuilt_empty ──> listen
       └─ v>10 / v=0+表 / SQLite 错误 / 锁
             └─ 一律不重建 ──> 结构化日志，exit 65，重试前先修因
```

### 改动面

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `src/store.ts` | 抛出带 `code` 的 `StoreOpenError`（保持消息不变）；新增只读 `inspectStore()`；`openStore` 迁移逻辑不动 | 40 |
| `src/store-startup.ts`（新） | 预检、开关、闸门、guard、备份改名/复制、manifest、原子换库、续做标记、状态文件 | 200 |
| `src/maintenance/backup.ts` | 复用 `backupDatabase` 的复制模式；导出校验/清单所需的内部件（不扩 bundle 白名单） | 30 |
| `src/maintenance/verify.ts` | 支持期望版本与核心表行数校验 | 20 |
| `src/maintenance/cli.ts` + `restore.ts`（新） | `maintain restore-store --from <dir>` | 40 |
| `src/main.ts` | 启动改为 inspect → decide → open；listen 前写 `store/state.json`；退出码映射 | 15 |
| `src/monitoring.ts` | 诊断输入类型补字段（`detail`） | 15 |
| `src/http.ts` | `/api/metrics` 增加 `store` 块 | 10 |
| `src/config.ts` | 开关、`ATC_REBUILD_BACKUP_DIR`、阈值常量 | 15 |
| `docs/operations.md` | 部署顺序、退出码、熔断解除、回滚命令 | 50 |
| `tests/store-startup.test.ts`（新） | 见验收 | 180 |

合计约 370 行实现、180 行测试、50 行文档。

### 明确不做的事

- 不把自动重建设为默认行为；不在 plist 预置开关。
- 不为 `schema_version_unsupported`、磁盘满、锁冲突、损坏库执行重建。
- 不实现旧库 → 新库的数据导入器，也不承诺 R1 之后的「回填」。
- 不扩展 `backupBundle` 的版本白名单（那会让「恢复」接受一个当前代码打不开的库）。
- 不改 v6～v10 的原地迁移路径与 `schema.sql`。
- 不在同一次启动里跑全量 `maintain rebuild`。
- 不在失败路径上清理备份；不做自动解除熔断。
- 不修改任何生产库、不重启生产、不执行 rebuild；本轮只出设计。

## Alternatives considered

**A：快速失败 + 自救指令（作为唯一策略）。** 实现小、与既有决策一致，但无人值守时仍然「服务起不来直到人发现」，F01 的第二天才发现问题原样保留。只作为默认路径，不作为全部。

**B：自动备份 + 自动重建 + 自动回填。** 否决。`schema_rebuild_required` 的库没有保行结构重建能力，R1 之后 request 为 0，`maintain rebuild` 无法执行；所谓回填只能靠一份不存在的导入器。若强行加导入器，就要为 v3/v4/v5 分别维护旧读口径与守恒校验，成本与风险都高于它保护的数据（该判断在 [destructive-schema-replacement](../../../implemented/architecture/2026-10-23-destructive-schema-replacement.md) 里已经成立过一次）。

**C：备份 + 重建、但不回填（作为唯一默认）。** 否决为默认：它把「删库」变成无需人确认的隐式动作，恰好违反既有决策；且在磁盘满/锁冲突这类可修复故障上会做出最坏的响应。保留为显式开关下的逃生门。

**D：在 `openStore` 内捕获 `schema_rebuild_required` 后自动删库。** 否决。无法区分「用户想重建」与「数据目录指错」，错误路径下会把正确的库删掉；历史决策已明确。

**E：只加启动前自动备份，不允许重建。** 安全，但备份本身也要求源库可独占打开、空间 ≥1.1 倍；磁盘满是常见失败原因，这种备份在最需要它的时候大概率失败，而且仍然不解决停机。因此作为 C 的一部分，而不是独立策略。

**F：把迁移挪出启动路径，改为显式 `maintain upgrade`。** 方向正确但改变运维契约（服务不再自升级），影响所有版本升级节奏，超出 F23 的止损范围；本提案用 A 先把失败语义做对，升级路径的迁移另开提案。

## Acceptance criteria

每条都给出「旧代码必须红」的判定点；仅作为回归护栏的条目单独标注。

1. **默认不重建**：v5 库、3 行 request、不带开关启动 → 退出码 65；日志恰好一条 `store.migrate.fail{code:"schema_rebuild_required", hint:"…", data_lost:false}`；`store.state=failed`；`trace.db` 字节数与 mtime 不变；`backups/` 不存在。**旧代码红**：退出码是 1，且没有结构化事件与状态文件。
2. **显式重建闭环**：同库带 `--auto-rebuild` → `backups/pre-rebuild-*-v5to10/` 含 `trace.db`、`manifest.json`；清单行数 3、`integrity:"ok"`、`user_version=5`；新 `trace.db` 为 v10、`request=0`；`/api/metrics.store.state=rebuilt_empty`、`data_lost=true`；日志含 `store.rebuild.swapped{backup_dir, dur_ms}`。**旧代码红**：开关被忽略，进程直接退出。
3. **备份失败即拒绝**：把 `backups/` 设为不可写（或注入 `integrity_check` 失败）→ 退出 65，`store.rebuild.refused{reason}`，`trace.db` 未被改名或替换，`rebuild-in-progress.json` 不存在。**旧代码红**：不存在拒绝路径。
4. **错误码白名单**：v11 库 + 开关 → 拒绝重建，字节不变，`state=failed`；注入 `SQLITE_FULL`（只读卷或满盘）→ 迁移回滚、`user_version` 仍为 9、不重建，腾出空间后重试成功。**部分为回归护栏**：拒绝 v11 在旧代码上也成立，但新代码多出结构化事件与「不进入重建」的显式断言。
5. **崩溃续做**：在 `rename(old)` 之后、`rename(new)` 之前终止进程（用测试预置两段文件状态模拟）→ 下次启动收敛到恰好一个可用 `trace.db`，备份目录完整，校验清单可读。**旧代码红**：没有 `rebuild-in-progress.json`，旧代码会把「缺库」当成空目录新建，直接丢数据。
6. **熔断**：30 分钟内 3 次同一错误码失败 → 第 4 次启动 <200 ms 退出 78；此后 24 小时内不再新增备份目录、`trace.db` mtime 不变。**旧代码红**：无 guard 文件，每次都会重跑迁移。
7. **v9→v10 不回归**：正常 v9 库启动 → `state=migrated`、`user_version=10`、无 `backups/` 新增、`/api/metrics` 的 `store` 块存在；`/api/stats` 与 `/api/metrics` 的 p50 与 F21 基线同量级。**旧代码红**：`store` 块不存在。
8. **保留策略**：连续产生 3 份自动快照并各成功启动一次 → 只剩最新 2 份；人工 `maintain backup` 产物不受影响；总量上限触发时从最老删起。**旧代码红**：无自动快照，用例无法建立前置。
9. **回滚命令**：`maintain restore-store --from <backupDir>` 在服务停止时可用，恢复后 `user_version=5`、行数 3；服务在跑时拒绝（`maintenance_lock_held`）。**旧代码红**：命令不存在。

## Risks

- **数据损失是本提案唯一的一级风险**：任何闸门写错都会把「可修复故障」当成「该删库」。缓解：错误码白名单只有一项、开关默认关、备份用同卷改名（不依赖剩余空间）、换库全程有标记、熔断后必须人工解除。风险等级 P0，剩余风险不可接受的唯一情形是「开关被默认打开」——因此 plist 与文档都禁止预置。
- **启动时长不可控**：4 GB 库的 `integrity_check` 是秒级，8 GiB 以上可能到十几秒；`--auto-rebuild=force` 之外的规模门槛就是为了不让 launchd 的 10 秒节拍与重建撞车。若超时，launchd 只会在下一次拉起时看到 `rebuild-in-progress` 并续做，不会重复备份。
- **跨卷模式的空间假设**：`ATC_REBUILD_BACKUP_DIR` 指向另一卷时必须 ≥1.1 倍剩余空间；磁盘满时该模式必然失败，此时退回同卷改名，但改名后就没有异地副本。这是有意取舍：先保证「不丢」，再谈「异地」。
- **bundle 白名单的语义边界**：<6 的库无法进入 `backupBundle`，因此本提案的备份不是可恢复 bundle。`restore-store` 只做文件级回搬；若未来要支持 bundle 恢复旧库，必须同时扩展 `RESTORABLE_SCHEMA_VERSIONS` 与恢复校验，属独立决策，不在本轮。
- **观测仍依赖 stdout**：`store` 事件走 launchd 日志，夜间无人看；熔断文件本身可被监控任务巡检，但接线不在本提案内。若要做「失败即通知」，属于监控提案的范围。
- **工时与发布**：预计 3～4 人日（实现 2～2.5、测试 0.8、文档与演练 0.5）。它是 P0，但**不阻塞**当前 v10 已迁移的运行态；上线需要一次停服窗口演练 `restore-store`，演练本身会短暂停服。
