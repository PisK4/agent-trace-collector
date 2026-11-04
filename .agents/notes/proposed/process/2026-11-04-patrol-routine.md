# Agent Note: 六轮巡查固化为分层 routine

Status: proposed

## Problem

2026-11-04 的六轮巡查在 [缺陷清单](../bug-fix/2026-11-04-open-bug-findings.md) 里留下 F01–F44。真正抓到 P0–P2 的路径只有少数几条，多数面在重复同一批 P3；每轮重新决定查什么，成本高，结论也不可复用。需要把有效的检查按节奏固化，同时明确哪些面已经饱和、以后不该再查。

现状基线（2026-11-04 只读取样）：生产库文件 4.97 GiB，`page_count` 1,272,596，`freelist` 12，WAL 1.6 MB；hook+ledger 成对证据 50,099 组，其中 gap >5 min 仅 1 组；`pending_hook` 1,404，`hook_absent` 7,550；`raw_otlp_span` 188,708 行只对应 1 条 `otlp_span` 证据、0 条 `otlp_body_ref`；1,656 个会话，最大 4,433 条请求。

本提案只覆盖当前单机、单用户、一个采集器的生产路径。所有命令只读（`sqlite3 -readonly`、`GET /api/*`），不新增脚本，不改 schema，不写生产库，不重启或杀死生产进程。

## Proposal

分四层：每次迭代、每周、触发式、一次性。每条路径写清何时跑、命令、判定、误报边界、成本和它抓到过哪条 finding。最后给一段可直接粘进 agent prompt 的 checklist。

### 如果只能留三条

1. **每周容量与增长快照**。它抓到 F38（正文预算只覆盖文件 37%）和 F39（`diskTight` 用错停止条件），是唯一能提前看到「多久撞容量线」的路径。命令只读、成本 1–2 分钟，阈值可以按日增/周增直接比较。
2. **hook→ledger 证据链**。它抓到 F09（三路证据齐全但正文永久 pending）、F13（同时间槽重复请求）和 F16（并发 hook 被 429 拒绝且无重试队列），是数据完整性的主入口。`pairs` 与 `over_5m` 是两个稳定分母，误报只来自重启窗口。
3. **摄入产出比**。它抓到 F37（188,099 条 OTLP span 只产出 1 条证据）。这是唯一能发现「静默丢数据」的路径，且只要比较两张表的计数就能判断，不依赖日志。

理由：这三条都抓到过 P1/P2 的数据或容量问题，都能用只读 SQL 复现，阈值不随代码细节漂移。其余路径要么只产 P3，要么必须结合具体改动才有意义。

### A. 每次迭代（≤2 分钟，零成本，不要临时实例）

**A1 类型、测试与笔记门禁**（阴性基线）

- 何时：每次准备提交前。
- 命令：

```bash
bun run typecheck && bun test
node scripts/verify-agent-note-format.mjs
node scripts/verify-change-notes.mjs --staged
```

- 判定：任一项非 0 就停。三项全过只说明「没退化」，不说明「没缺陷」。
- 误报与边界：工作区没有暂存 note 时，`--staged` 会空跑通过；只跑了部分测试也会通过。这条不能替代下面任何数据检查。
- 成本：40–120 秒。
- 证据：第 1 轮 F14 是 5 个 i18n key 缺失，覆盖率测试没有挡住；第 4 轮 F34 是 `maintain verify` 恒 `ok:true`。两条都说明门禁只能防回归，不能当发现器。

**A2 HTTP 契约冒烟**

- 何时：每次改动 `src/http.ts`、`src/protocols.ts`、`src/queries/` 之后；其余迭代可隔次跑。
- 命令：

```bash
BASE=http://127.0.0.1:8320
T=$(node -e "process.stdout.write(require('fs').readFileSync(process.env.HOME+'/Library/Application Support/tracery/read.token').toString('base64url'))")
for q in 'limit=0' 'limit=201' 'limit=1.5' 'direction=sideways'; do
  curl -s -o /dev/null -w "$q %{http_code}\n" -H "Authorization: Bearer $T" "$BASE/api/sessions?$q"
done
ID=$(sqlite3 -readonly "$HOME/Library/Application Support/tracery/trace.db" 'SELECT MAX(req_id) FROM request')
curl -s -o /dev/null -w "body_1e20 %{http_code}\n" -H "Authorization: Bearer $T" "$BASE/api/requests/$ID/body?from=99999999999999999999"
curl -s -o /dev/null -w "bad_pct %{http_code}\n" -H "Authorization: Bearer $T" "$BASE/api/sessions/%ZZ/requests"
```

- 判定：前四行应为 400（`invalid_limit` / `invalid_direction`）；`body_1e20` 应为 400 `invalid_body_range`（F41 未修时返回 200，已知基线，不重复立条）；`bad_pct` 应为 400，不应是 500。
- 误报与边界：`limit=201` 如果产品后来改成截断，会合法返回 200，以响应体的 `error` 字段为准；`%ZZ` 的路径解码行为和运行时分不清，改动 `decodeURIComponent` 后必须重跑。
- 成本：10 秒。
- 证据：第 5 轮 F41（`from=1e20` 返回零宽完整页）；第 2 轮 F20（畸形百分号编码兜成 500）。

**A3 服务健康快照**（阴性基线）

- 何时：每次迭代结束时。
- 命令：

```bash
BASE=http://127.0.0.1:8320
T=$(node -e "process.stdout.write(require('fs').readFileSync(process.env.HOME+'/Library/Application Support/tracery/read.token').toString('base64url'))")
curl -s -H "Authorization: Bearer $T" "$BASE/api/stats" \
  | jq '{admission, open_gaps, pending_hooks, body_states, issues, probe}'
```

- 判定：`admission.mode` 不是 `normal` 且持续超过 10 分钟；`probe.state != "ok"`；`open_gaps` 比上次多 50 以上；`body_states` 中 `pending` 只增不减。
- 误报与边界：批量导入、重启、维护窗口会让 `admission` 短暂变成 paused；探针本身出现过 5,066 ms 尖峰（F02），单次尖峰不算异常。单次读取发现不了 `/api/stats` 的缓存陈旧（F33），那条要靠外部写库或重启验证。
- 成本：5 秒。
- 证据：阴性基线，第 2 轮 F02 说明探针尖峰不是持续性故障；第 4 轮 F33 是代码核查发现，不能靠这条命令发现。

### B. 每周（10–15 分钟，只读，不需要临时实例）

**B1 容量与增长快照**（核心 1）

- 何时：每周固定一次，建议在同一时段（例如周一上午），便于比较周环比。
- 命令：

```bash
DB="$HOME/Library/Application Support/tracery/trace.db"
sqlite3 -readonly "$DB" "SELECT page_size, page_count, freelist_count, ROUND(page_size*page_count/1048576.0,1) AS file_mb FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count();"
sqlite3 -readonly "$DB" "SELECT name, ROUND(SUM(pgsize)/1048576.0,1) AS mb FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT 12;"
sqlite3 -readonly "$DB" "SELECT ROUND((SELECT IFNULL(SUM(length(z)),0) FROM block)/1048576.0,1) AS block_mb, ROUND((SELECT IFNULL(SUM(length(skeleton_z)),0) FROM request)/1048576.0,1) AS skeleton_mb, ROUND((SELECT IFNULL(SUM(length(request_z)+length(response_z)),0) FROM raw_hook)/1048576.0,1) AS raw_hook_mb;"
ls -l "$DB"-wal
df -h "$HOME/Library/Application Support/tracery"
```

- 判定：日增 >500 MB 或周增 >2.5 GB；正文（block + skeleton + raw_hook）占文件 <45%，或一周下降超过 5 个百分点；`freelist` >200 页且 30 秒后不下降；WAL >32 MB；可用空间 <20%。
- 误报与边界：回填、合并、批量导入会让 `dbstat` 单个表跳变；`dbstat` 统计的是分配页（含空闲页），只比趋势不比绝对值；`freelist` 12 是增量回收的常态；正文占比下降本身可能是淘汰在起作用，要看它是否同时压住了文件增长。
- 成本：1–2 分钟，无临时实例。
- 证据：第 5 轮 F38（正文只覆盖 1.76 GiB / 4.70 GiB）、F39（`diskTight` 以正文 9 GB 为停止条件）；第 1 轮 F11（raw 层 7 天 TTL 未生效）、F12（`raw_droid_event` 不在预算内）。

**B2 hook→ledger 证据链**（核心 2）

- 何时：每周一次；如果有 hook/OTLP/源适配器改动，改动前后各一次。
- 命令：

```bash
DB="$HOME/Library/Application Support/tracery/trace.db"
sqlite3 -readonly "$DB" "WITH h AS (SELECT req_id, MIN(added_at) t FROM request_evidence WHERE source_kind='hook' GROUP BY req_id), l AS (SELECT req_id, MIN(added_at) t FROM request_evidence WHERE source_kind='ledger' GROUP BY req_id) SELECT COUNT(*) AS pairs, SUM(CASE WHEN l.t-h.t>300000 THEN 1 ELSE 0 END) AS over_5m FROM h JOIN l USING(req_id);"
sqlite3 -readonly "$DB" "SELECT (SELECT COUNT(*) FROM pending_hook) AS pending_hook, (SELECT COUNT(*) FROM request WHERE miss_reason='hook_absent') AS hook_absent;"
sqlite3 -readonly "$DB" "SELECT agent, COUNT(*) AS n FROM request WHERE miss_reason='hook_absent' GROUP BY agent ORDER BY n DESC LIMIT 5;"
```

- 判定：`over_5m / pairs > 0.5%`；`pending_hook` 超过 7 日均值的 2 倍；`hook_absent` 日增 >500，且新增集中在单一 agent。
- 误报与边界：重启或升级窗口会临时抬高 gap；claude 未装 hook 时 `hook_absent` 会持续增长，这是 F01 的已知行为，先看 agent 分布再判断是不是新问题；批量回填会让 `pairs` 一次跳增，不能直接和周环比。
- 成本：20 秒。
- 证据：第 1 轮 F09（三路证据齐全但正文永久 pending）、F13（83 组 170 行同时间槽重复）、F16（并发 hook 被 busy 429 拒绝且服务端无重试队列）；F01 为承继项，不重新立条。

**B3 摄入产出比**（核心 3）

- 何时：每周一次；OTLP 或 `src/sources/` 改动后加跑。
- 命令：

```bash
DB="$HOME/Library/Application Support/tracery/trace.db"
sqlite3 -readonly "$DB" "SELECT (SELECT COUNT(*) FROM raw_otlp_span) AS spans, (SELECT COUNT(*) FROM request_evidence WHERE source_kind='otlp_span') AS span_evidence, (SELECT COUNT(*) FROM otlp_body_ref) AS body_refs; SELECT source_kind, reason, COUNT(*) AS n FROM ingest_issue GROUP BY 1,2 ORDER BY n DESC;"
```

- 判定：`spans > 10,000` 且 `span_evidence / spans < 0.1%`，或 `body_refs = 0`；任一 `ingest_issue.reason` 本周新增 >100。
- 误报与边界：上游只发内部 span、或按规则本来就该采样时，比例天然低；先按 `service` 和 `name` 分布确认有没有 LLM 形状的 span，再定性。`raw_otlp_span` 去重后计数，重投不会让分子变大。
- 成本：30 秒。
- 证据：第 5 轮 F37（188,099 行 span → 1 条证据、0 条 body ref）；第 1 轮 F13/F16 是同一条摄入链上的重复与拒绝问题。

**B4 会话扇出与分页压力**

- 何时：每周一次，和 B1 一起跑。
- 命令：

```bash
DB="$HOME/Library/Application Support/tracery/trace.db"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS convs, MAX(c) AS max_req FROM (SELECT COUNT(*) AS c FROM request GROUP BY conv_key);"
sqlite3 -readonly "$DB" "SELECT conv_key, COUNT(*) AS c FROM request GROUP BY conv_key ORDER BY c DESC LIMIT 5;"
```

- 判定：`max_req > 200` 的会话数比上周增加，或出现 `>10,000` 的会话；`>200` 当前有 94 个，最大 4,433。
- 误报与边界：长跑采集、自动化任务会天然产生大会话；真正要看的是翻页契约是否已修（F40），契约未修时超过 200 就是风险面，不是异常本身。
- 成本：20 秒。
- 证据：第 5 轮 F40（keyset 排序键可变、forward 游标不绑定会话）；第 3 轮 F29（前端 `+N` 超过 500 全表清空）。

### C. 触发式（只在动到对应代码时跑）

**C1 动 schema、迁移、备份、启动路径**

- 何时：修改 `src/store.ts` 的迁移、`src/maintenance/backup*`、`scripts/verify-cutover.ts`，或新增 schema 版本时。
- 命令：

```bash
bun run verify-cutover
bun run maintain verify
```

再把备份产物解到临时目录，起一个临时实例验证「可服务」，而不只是「能打开」：

```bash
TMP=/tmp/atc-restore-$(date +%s); mkdir -p "$TMP"
# 用 bun run maintain backup 的产物解到 $TMP，然后：
ATC_DATA_DIR="$TMP" ATC_PORT=8396 ATC_LEDGER_PATH="$TMP/usage.jsonl" ATC_ROUTING_DIR="$TMP/routing" bun run start &
PID=$!; sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8396/api/stats
kill -TERM $PID; wait $PID 2>/dev/null; rm -rf "$TMP"
```

- 判定：旧库能迁移、`/api/stats` 返回 200、`PRAGMA integrity_check` 为 ok；只改版本号的恢复测试不算通过。
- 误报与边界：临时实例默认会扫真实会话目录，必须显式设置 `ATC_ROUTING_DIR`/会话源环境变量到临时目录，否则会把生产数据再写一遍；只在临时目录跑，绝不指向生产数据目录。
- 成本：10–15 分钟。
- 证据：第 3 轮 F30（恢复成功不等于可服务）、第 4 轮 F34（`maintain verify` 恒 `ok:true`）、第 6 轮 F43（只读目录启动失败）。

**C2 动保留层、容量策略、准入闸门**

- 何时：修改 `src/retention.ts`、`src/config.ts` 的 `bodyBudget`/`diskLimit`、`src/http.ts` 的准入映射时。
- 命令：先跑 B1 记录改动前基线；改动后在临时镜像里做小规模写失败验证。

```bash
IMG=/tmp/atc-cap.sparseimage; MNT=/tmp/atc-cap
hdiutil create -size 120m -fs HFS+ -volname ATC-CAP -type SPARSE "$IMG"
mkdir -p "$MNT"; hdiutil attach -nobrowse -mountpoint "$MNT" "$IMG"
# 只在 "$MNT" 内启动临时实例并写满；禁止对真实盘做 dd
# 结束必须：
hdiutil detach "$MNT"; rm -rf "$MNT" "$IMG"
mount | grep atc-cap || echo 'no temp mount'
```

- 判定：写满后 hook 应为显式 5xx（不是 200），读接口仍 200；错误码应符合 F44 的验收口径；`retentionTick` 的淘汰目标应符合 F39 的新磁盘目标。
- 误报与边界：镜像 120 MB 时剩余空间永远小于 `MIN_WRITE_MARGIN=256 MiB`，准入会直接 paused，看到 507 是预期而不是 ENOSPC；要测真实 `SQLITE_FULL` 只能在「准入通过之后、提交之前」把空间吃掉，属窄窗口。镜像总大小不超过 300 MB，结束必须卸载删除。
- 成本：10 分钟，含创建/卸载镜像。
- 证据：第 6 轮 F44（SQLITE_FULL 落到 503）、F42（停止路径）；第 5 轮 F38/F39。

**C3 动摄入：hook、OTLP、各 agent 源适配器**

- 何时：修改 `src/hook.ts`、`src/sources/otlp/*`、`src/sources/*` 的解析/映射时。
- 命令：改动前后各跑 B2、B3；再跑相关测试 `bun test`。
- 判定：`pairs` 不下降、`over_5m` 不上升；OTLP 的 `span_evidence / spans` 不下降；`ingest_issue` 不新增 reason。
- 误报与边界：新适配器上线初期 `hook_absent` 会升高；重投会改变 `raw_*` 计数但不改变去重后的证据数。
- 成本：10 分钟。
- 证据：第 5 轮 F37（静默 skip）；第 1 轮 F13/F16；第 1 轮 F09。

**C4 动查询、分页、时间窗口**

- 何时：修改 `src/queries/`、`src/http.ts` 的分页参数、`src/protocols.ts` 的区间校验时。
- 命令：A2 全跑，再加跨会话游标探测。

```bash
BASE=http://127.0.0.1:8320
DB="$HOME/Library/Application Support/tracery/trace.db"
T=$(node -e "process.stdout.write(require('fs').readFileSync(process.env.HOME+'/Library/Application Support/tracery/read.token').toString('base64url'))")
A=$(sqlite3 -readonly "$DB" "SELECT conv_key FROM request GROUP BY conv_key ORDER BY COUNT(*) DESC LIMIT 1")
B=$(sqlite3 -readonly "$DB" "SELECT conv_key FROM request GROUP BY conv_key ORDER BY COUNT(*) DESC LIMIT 1 OFFSET 1")
EA=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$A")
EB=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$B")
CUR=$(curl -s -H "Authorization: Bearer $T" "$BASE/api/sessions/$EA/requests?limit=1&direction=forward" | jq -r '.next_cursor // empty')
curl -s -o /dev/null -w 'cross_conv %{http_code}\n' -G -H "Authorization: Bearer $T" \
  --data-urlencode "cursor=$CUR" --data "limit=1" --data "direction=forward" "$BASE/api/sessions/$EB/requests"
```

- 判定：跨会话复用游标应为 4xx（当前 200，F40 未修的已知基线）；同一会话翻页不出现漏行/重复；`limit` 越界返回 400。
- 误报与边界：游标为空时这条命令会请求不带 cursor 的首页并返回 200，先确认 `CUR` 非空；会话被合并/改写 `started_ms` 时会天然出现跨页错位，属 F40 本体，不是新问题。
- 成本：5 分钟。
- 证据：第 5 轮 F40（keyset 可变、forward 不绑定 `conv_key`）、F41（区间安全整数）；第 1 轮 F15（`session_usage` 全表扫描，改动查询时用 `EXPLAIN QUERY PLAN` 复验）。

**C5 动生命周期、关闭路径**

- 何时：修改 `src/main.ts` 的信号处理、`store.close()`、启动诊断时。
- 命令（只在临时实例上做）：

```bash
TMP=/tmp/atc-life-$(date +%s); mkdir -p "$TMP/routing"
ATC_DATA_DIR="$TMP" ATC_PORT=8397 ATC_LEDGER_PATH="$TMP/usage.jsonl" ATC_ROUTING_DIR="$TMP/routing" bun run start &
PID=$!; sleep 3
kill -TERM $PID; T0=$(date +%s); while kill -0 $PID 2>/dev/null; do sleep 0.1; done; echo "stop_s=$(( $(date +%s) - T0 ))"
ls -l "$TMP"/trace.db-wal
rm -rf "$TMP"
```

- 判定：SIGTERM 后 ≤30 秒退出；正常退出后 `-wal` 为 0 B；重启后 `PRAGMA integrity_check` 为 ok、hook 证据无重复。
- 误报与边界：空闲实例停止很快（实测 127 ms），不能代表派生正在运行时的行为；要测「派生中停止」得先制造 dirty 组，成本高，只在改关闭路径时做。
- 成本：5 分钟。
- 证据：第 6 轮 F42（停止无上限、无 catch，WAL 未截断）、F43（只读启动失败）。

### D. 一次性 / 已饱和，不进 routine

- **安全威胁模型**（F18 读接口绕过、F19 日志权限）：需要人判断威胁模型，不是周期扫描；只在认证或日志代码变更时评审。
- **合并与身份不变量**（F25–F28）：数据依赖，当前 0 例；应写成不变量测试，定期跑没有新信息。
- **前端极端数据**（F29 `moreTargets > 500`）：一次性浏览器复现，成本高于收益。
- **时间语义**（F32 CLI 日期按 UTC）：一次性确认，之后由测试守住。
- **CLI 失败路径**（F34–F36）：一次性审计，`maintain verify` 和 backfill 循环的修复验收里覆盖。
- **性能深挖**（F02/F07/F10/F23）：症状驱动，需要插桩和真实流量，不适合作为固定巡检。
- **崩溃与 ENOSPC 基线**（F42–F44）：已在第 6 轮做完；只在 C2/C5 对应的代码变更时重跑。
- **真实旧 schema 迁移**：v6–v11 的实际迁移路径今天没有跑，属于一次性任务，随 F30 的备份验收做；不属于周期巡查。
- **依赖与供应链审计**：lockfile 与 `npm audit` 应由依赖更新流程负责，不是采集器运行时巡检。

### 不该进 routine 的路径与理由

- **只产重复 P3**：F40 的游标语义、F41 的区间边界、F32 的时区口径、F33 的 stats 缓存，每次重跑都会得到同一条结论，除非契约或缓存实现发生变化。
- **情报价值低**：F14 的 i18n 缺 key、F17 的状态脚本静默、F19 的日志权限、F29 的前端 `+N`，都是一次性事实，重复检查只是在确认旧结论。
- **成本远高于收益**：对大库跑全量 `PRAGMA integrity_check`（分钟级 IO）、每周做 ENOSPC 镜像、每周 SIGKILL、每天跑 `dbstat`，都会挤占生产 IO 而不产生新信息；`dbstat` 每周一次足够。
- **需要人判断**：F18 的威胁模型、F25/F26 的合并规则、F30 的备份策略，不是阈值能判定的。
- **已有更合适的载体**：进程内指标与阈值告警由 [后台监控](../process/2026-11-03-background-monitoring.md) 负责；本 routine 只补数据质量与容量 SQL，不重复做采样。

### 执行节奏、责任人与产出

| 节奏 | 谁跑 | 何时 | 产出 |
| --- | --- | --- | --- |
| A | 改代码的 agent | 每次提交前 | 只报告：命令、结果、是否越界；不落 note |
| B | 值班 agent | 每周固定时段 | 写进周报/issue 评论；只有新异常才立 finding |
| C | PR 作者 | 改到对应模块时 | 落 note：新增 F 编号或更新既有条目 |
| D | 人 | 相关变更时 | 不跑；按 C 的验收覆盖 |

立 finding 的门槛：有实测数字或文件:行号，且不是既有 F 的重复。达不到就只写一行「阴性基线」。

### 可直接粘贴的 checklist

```text
巡检前置：只读。生产库 $HOME/Library/Application Support/tracery/trace.db；不写、不重启、不 kill 生产进程；不读真实请求正文与令牌明文。

1. 跑 bun run typecheck && bun test；再跑 node scripts/verify-agent-note-format.mjs 与 node scripts/verify-change-notes.mjs --staged。任一非 0 立即停。
2. 用 read.token 请求 GET /api/stats，用 jq 取 admission/open_gaps/pending_hooks/body_states/issues/probe。admission 非 normal 超过 10 分钟、probe 非 ok、open_gaps 增长 >50 时记录。
3. 跑 A2：limit=0/201/1.5、direction=sideways 应 400；body?from=99999999999999999999 应 400；/api/sessions/%ZZ/requests 应 400 不是 500。
4. 跑 B1：pragma_page_count/page_size/freelist、dbstat Top12、block+skeleton+raw_hook 字节、-wal 大小、df。日增 >500 MB、周增 >2.5 GB、正文占比 <45%、freelist >200 页、WAL >32 MB、可用 <20% 时记录。
5. 跑 B2：hook+ledger 的 pairs 与 over_5m、pending_hook、hook_absent 及 agent 分布。over_5m/pairs >0.5%、pending_hook >2× 周均值、hook_absent 日增 >500 时记录。
6. 跑 B3：raw_otlp_span / otlp_span 证据 / otlp_body_ref / ingest_issue。spans >10,000 且证据比 <0.1%、或 body_refs=0 时记录。
7. 跑 B4：会话数、max_req、Top5 大会话。max_req >200 的会话数增加或出现 >10,000 时记录。
8. 动到 schema/保留层/摄入/查询/生命周期时，按 C1–C5 对应项加跑；用临时目录或 ≤300 MB 镜像，结束卸载并 rm，确认 mount 无残留。
9. 收尾：把本次命令、关键数字、判定写成三行以内；越界项按「触发式」定位；没有越界就写「阴性」。
```

## Alternatives considered

- **一份大清单，每次全跑**：会被跳过，且多数检查在无改动时没有信息量。落选，按节奏分层。
- **做成 launchd/cron 自动任务**：需要新增脚本、阈值存储和告警路由，超出「不改代码」的边界；与已有的后台监控职责重叠。落选，先人工按节奏跑，稳定后再自动化。
- **继续按轮次临时巡查**：第六轮已经证明后半程只产重复 P3。落选，明确停查面。
- **只依赖 `scripts/monitor.ts` 的采样**：它看的是进程与阈值，不看证据链、OTLP 产出比和预算覆盖率。落选，两者互补。

## Acceptance criteria

- 连续 4 周按 B 执行，三条核心路径每周都有记录；A 在最近 5 次代码提交前都执行过。
- 每次记录包含：命令、关键数字、判定、是否越界；没有越界时明确写「阴性」。
- C 的触发映射被遵守：改动 schema、保留层、摄入、查询、生命周期时，对应项至少跑一次。
- 全程 0 次生产写入、0 次生产重启、0 次真实磁盘填满；临时镜像与目录 100% 卸载删除。
- 新增 finding 编号连续、不与既有 F 重复；只登记不定性的项要标注未证实点。

## Risks

- **阈值过松或过紧**：日增 500 MB 是按当前 330–360 MB/日推的，突发回填会越线；先连续跑 4 周再调整，不要一周就改阈值。
- **误报导致弃用**：`hook_absent`、`dbstat` 跳变、会话扇出都有合理解释；判定要求同时看两个指标，避免单指标报警。
- **只读查询也会争用**：`dbstat` 对大库有 IO 成本，应放在低峰；`sqlite3 -readonly` 在 `-shm` 缺失时可能打不开 WAL 库，生产有 `-shm`，临时副本要注意。
- **日志与输出泄漏**：任何 grep 到的日志都可能含绝对路径或令牌；周报只写计数与结论，不贴原文。
- **三条核心的盲区**：容量与摄入之外，安全和合并规则仍靠人工评审；routine 通过不等于这些面安全。
