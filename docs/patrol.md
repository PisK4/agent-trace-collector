# 巡查程序

本文件是巡查的唯一正文：节奏、判定口径、误报边界、执行人与产出。可计算的检查在[巡查脚本](../scripts/patrol.ts)，阈值只在脚本的 `PATROL_THRESHOLDS`，本文不复述数字；阈值随容量策略调整时改脚本，不动本文。缺陷与证据按 F 编号引用（F01–F44），原始记录在 `.agents/notes` 的缺陷清单，那份文件随 note 生命周期移动，这里不链过去。

巡查全程只读：数据库用只读连接，接口只发 GET；不写生产库、不改 schema、不重启或杀死生产进程、不读真实请求正文与令牌明文。

## 三条核心

1. **容量与增长**（`weekly` 的 `body_ratio`、`growth`、`freelist`、`wal`、`free_space`）。它抓到 F38（正文预算只覆盖文件的一部分）与 F39（`diskTight` 用错停止条件），也是提前看到「多久撞容量线」的唯一路径。
2. **hook→ledger 证据链**（`weekly` 的 `evidence_gap`、`pending_hook`、`hook_absent`）。它抓到 F09（三路证据齐全但正文永久 pending）、F13（同时间槽重复请求）与 F16（并发 hook 被拒且无重试队列），是数据完整性的主入口。`pairs` 与 `over_5m` 是两个稳定分母，误报只来自重启窗口。
3. **摄入产出比**（`weekly` 的 `otlp_yield`、`otlp_issues`）。它抓到 F37（大量 OTLP span 只产出 1 条证据、0 条 body ref）。只比较两张表的计数，不依赖日志，是发现静默丢数据的唯一入口。

其余路径要么只产 P3，要么必须结合具体改动才有意义，见[不该进 routine 的路径](#不该进-routine-的路径)。

## 节奏

| 节奏 | 谁跑 | 何时 | 产出 |
| --- | --- | --- | --- |
| A 每次迭代 | 改代码的 agent | 每次提交前 | 只报告：命令、结果、是否越界；不落 note |
| B 每周 | 值班 agent | 每周固定时段，建议周一上午 | 写进周报或 issue 评论；只有新异常才立 finding |
| C 触发式 | PR 作者 | 改到对应模块时 | 落 note：新增 F 编号或更新既有条目 |
| D 一次性 | 人 | 相关变更时 | 不跑；按 C 的验收覆盖 |

立 finding 的门槛：有实测数字或文件:行号，且不是既有 F 的重复。达不到就只写一行「阴性基线」。

## A. 每次迭代（分钟级，零成本，不起临时实例）

**A1 门禁**（阴性基线）。命令以根 [AGENTS.md 的命令一节](../AGENTS.md#命令)为准：类型检查、测试与 note 两项门禁；本文不再抄一遍，避免出现第二个命令清单。任一项非 0 就停。三项全过只说明「没退化」，不说明「没缺陷」：第 1 轮 F14 的 i18n 缺 key 与第 4 轮 F34 的 `maintain verify` 恒 `ok:true` 都穿过了门禁。工作区没有暂存 note 时 note 门禁会空跑通过，只跑部分测试也会通过。

**A2 契约冒烟**。改动 `src/http.ts`、`src/protocols.ts`、`src/queries/` 之后必跑，其余迭代可隔次跑。

```bash
bun run patrol smoke                 # 默认端口 8320
bun run patrol smoke --port 8396     # 临时实例
```

判定：`limit` 与 `direction` 应为 400（`direction` 只在会话请求路由上校验）；畸形百分号编码当前返回 500，是 F20 未修前的已知基线，修好后应转 400；`body?from=1e20` 同理，F41 未修时返回 200。`limit=201` 若产品改成截断会合法返回 200，以响应体的 `error` 字段为准。脚本把 F20、F41 这两条已知基线记作 info，其余非 400 记作 over。证据：第 5 轮 F41、第 2 轮 F20。成本 10 秒。

**A3 健康抽检**（手工，非权威）。进程内指标与阈值告警归 `scripts/monitor.ts`：`bun scripts/monitor.ts inspect` 这套监控巡检的规则与落盘的 `checks/<day>.jsonl` 才是权威口径，`/api/stats` 的手工读取只用于当次确认，不构成第二套阈值。要看的是 `admission` 是否长时间非 `normal`、`probe` 是否非 `ok`、`open_gaps` 是否持续增长；批量导入、重启与维护窗口会让 `admission` 短暂变化，单次探针尖峰不算异常（F02）。`/api/stats` 的缓存陈旧（F33）靠这条命令发现不了，属于代码核查项。

## B. 每周（十几分钟，只读，不起临时实例）

```bash
bun run patrol weekly                                   # 生产数据目录
bun run patrol weekly --data-dir /path                  # 副本
bun run patrol weekly --state-dir /path/to/state        # 历史落到别处
```

输出逐行给出读数、当前阈值与 `ok / over / info`；有越界项时退出码 1。`weekly` 会把本期快照写进状态目录，并自动与上一期比较，周环比不再需要人算，见下面的「历史与周环比」。整段输出仍然建议贴进周报，方便人看趋势。

**B1 容量与增长**（核心 1）。`body_ratio` 低于下限、`freelist` 与 `wal` 超上限、可用空间低于下限即越界；日增与周增由 `growth_delta` 与上一期快照比较，越过阈值才算越界。证据：第 5 轮 F38、F39；第 1 轮 F11（raw 层 7 天 TTL 未生效）、F12（`raw_droid_event` 不在预算内）。

**B2 证据链**（核心 2）。`evidence_gap` 超比例、`pending_hook` 今日新增超过前 7 日均值的倍数、`hook_absent` 最近完整一天超过阈值且超过均值的倍数即越界。`hook_absent` 还要再看 agent 分布：claude 未装 hook 时持续增长是 F01 的已知行为，先排除它再定性；重启或升级窗口会临时抬高 gap；批量回填会让 `pairs` 一次跳增，不能直接做周环比。证据：第 1 轮 F09、F13、F16。

**B3 摄入产出比**（核心 3）。`otlp_yield` 在 span 数达到门槛且证据比过低、或 span 存在但 `body_ref` 为 0 时越界；`otlp_issues` 按近 7 日单条理由计数。上游只发内部 span 或本就该采样时比例天然低，先用 `service`、`name` 分布确认有没有 LLM 形状的 span 再定性。证据：第 5 轮 F37。

**B4 会话扇出**。`conversation_size` 只在单个会话超过上限时报越界；`>200` 的会话数只在 `conversation_delta` 里与上一期比较。长跑采集与自动化任务天然产生大会话，真正要看的是翻页契约（F40）是否已修。证据：第 5 轮 F40；第 3 轮 F29。

**历史与周环比**

- 落点：`$HOME/Library/Application Support/tracery/patrol/history.json`，与 `monitor/` 同级，不在库里、不在仓库工作区；`ATC_PATROL_STATE_DIR` 或 `--state-dir` 可以改路径；默认位置不跟随 `--data-dir`，跑副本时若要分开历史，显式指到别处。
- 一期：ISO 周（如 `2026-W45`）。同一周重跑只覆盖本期，不会每次运行各留一条；期号之外还记 `takenAt`，跨天比较时用它算日均。
- 内容：采集时间、文件与正文体积、成对证据、span 与证据数、会话数、`>200` 会话数、当次每条检查的状态。
- 比较：取严格早于本期的最近一期，输出 `growth_delta`（增量、占上期百分比、日均，以及是否越过日增/周增阈值）与 `conversation_delta`（`>200` 会话数与最大请求的变化）。没有更早期时只打印 `无上期可比`。
- 期数：只保留最近 12 期，写入时按周号从旧到新裁掉；状态目录因此不会无限增长。
- 损坏：文件缺失、JSON 解析失败或形状不符时退化为「无上期可比」，打印 `[info] history: 历史不可读（<path>）…`，退出码语义不变（0/1/2）。下次写入会用本期重建，坏内容被覆盖，不做恢复。
- 写入先落临时文件再改名，半写不会留下坏文件；`smoke` 不写历史。

## C. 触发式（只在动到对应代码时跑）

**C1 动 schema、迁移、备份、启动路径**

```bash
bun run verify-cutover
bun run maintain verify
```

再把备份产物解到临时目录，起临时实例验证「可服务」而不只是「能打开」：

```bash
TMP=/tmp/atc-restore-$(date +%s); mkdir -p "$TMP/routing"
# 用 bun run maintain backup 的产物解到 $TMP，然后：
ATC_DATA_DIR="$TMP" ATC_PORT=8396 ATC_LEDGER_PATH="$TMP/usage.jsonl" ATC_ROUTING_DIR="$TMP/routing" bun run start &
PID=$!; sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8396/api/stats
kill -TERM $PID; wait $PID 2>/dev/null; rm -rf "$TMP"
```

判定：旧库能迁移、`/api/stats` 返回 200、`PRAGMA integrity_check` 为 ok；只改版本号的恢复测试不算通过。临时实例默认会扫真实会话目录，必须把 `ATC_ROUTING_DIR` 与会话源指到临时目录，否则会把生产数据再写一遍；只在临时目录跑，绝不指向生产数据目录。证据：第 3 轮 F30、第 4 轮 F34、第 6 轮 F43。

**C2 动保留层、容量策略、准入闸门**

先跑一次 `weekly` 记录改动前基线；改动后在临时镜像里做小规模写失败验证。

```bash
IMG=/tmp/atc-cap.sparseimage; MNT=/tmp/atc-cap
hdiutil create -size 120m -fs HFS+ -volname ATC-CAP -type SPARSE "$IMG"
mkdir -p "$MNT"; hdiutil attach -nobrowse -mountpoint "$MNT" "$IMG"
# 只在 "$MNT" 内启动临时实例并写满；禁止对真实盘做 dd，脚本与产物放在挂载点之外
hdiutil detach "$MNT"; rm -rf "$MNT" "$IMG"
mount | grep atc-cap || echo 'no temp mount'
```

判定：写满后 hook 应为显式 5xx，读接口仍 200，错误码符合 F44 的验收口径；`retentionTick` 的淘汰目标应符合 F39 的磁盘目标。镜像剩余空间小于写入门槛时准入会直接 paused，看到 507 是预期而不是 ENOSPC；要测真实 `SQLITE_FULL` 只能在准入通过之后、提交之前把空间吃掉，属窄窗口。镜像总大小不超过 300 MB，结束必须卸载删除。证据：第 6 轮 F44、F42；第 5 轮 F38、F39。

**C3 动摄入：hook、OTLP、各 agent 源适配器**

改动前后各跑 `weekly`；再跑相关测试。判定：`pairs` 不下降、`evidence_gap` 不上升、OTLP 产出比不下降、`ingest_issue` 不新增 reason。新适配器上线初期 `hook_absent` 会升高；重投会改变 `raw_*` 计数但不改变去重后的证据数。证据：第 5 轮 F37；第 1 轮 F09、F13、F16。

**C4 动查询、分页、时间窗口**

先跑 `bun run patrol smoke`，再加跨会话游标探测：

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

判定：跨会话复用游标应为 4xx（当前 200，F40 未修的已知基线）；同一会话翻页不出现漏行或重复；`limit` 越界返回 400。游标为空时命令会退回首页并返回 200，先确认 `CUR` 非空；会话被合并或改写 `started_ms` 时会天然出现跨页错位，属 F40 本体。证据：第 5 轮 F40、F41；第 1 轮 F15（改动查询时用 `EXPLAIN QUERY PLAN` 复验 `session_usage`）。

**C5 动生命周期、关闭路径**

只在临时实例上做：

```bash
TMP=/tmp/atc-life-$(date +%s); mkdir -p "$TMP/routing"
ATC_DATA_DIR="$TMP" ATC_PORT=8397 ATC_LEDGER_PATH="$TMP/usage.jsonl" ATC_ROUTING_DIR="$TMP/routing" bun run start &
PID=$!; sleep 3
kill -TERM $PID; T0=$(date +%s); while kill -0 $PID 2>/dev/null; do sleep 0.1; done; echo "stop_s=$(( $(date +%s) - T0 ))"
ls -l "$TMP"/trace.db-wal
rm -rf "$TMP"
```

判定：SIGTERM 后不超过 30 秒退出；正常退出后 `-wal` 为 0 B；重启后 `PRAGMA integrity_check` 为 ok、hook 证据无重复。空闲实例停止很快，不能代表派生正在运行时的行为；要测「派生中停止」得先制造 dirty 组，只在改关闭路径时做。证据：第 6 轮 F42、F43。

## 一次性与已饱和

- **安全威胁模型**（F18 读接口绕过、F19 日志权限）：需要人判断威胁模型，只在认证或日志代码变更时评审。
- **合并与身份不变量**（F25–F28）：应写成不变量测试，当前 0 例，定期跑没有新信息。
- **前端极端数据**（F29）：一次性浏览器复现，成本高于收益。
- **时间语义**（F32 CLI 日期按 UTC）：一次性确认，之后由测试守住。
- **CLI 失败路径**（F34–F36）：一次性审计，在 `maintain verify` 与 backfill 循环的修复验收里覆盖。
- **性能深挖**（F02、F07、F10、F23）：症状驱动，需要插桩与真实流量，不适合固定巡检。
- **崩溃与 ENOSPC 基线**（F42–F44）：第 6 轮已做完，只在 C2、C5 对应的代码变更时重跑。
- **真实旧 schema 迁移**：v6–v11 的实际路径随 F30 的备份验收做，不是周期性任务。
- **依赖与供应链审计**：由依赖更新流程负责，不是采集器运行时巡检。

## 不该进 routine 的路径

- **只产重复 P3**：F40 的游标语义、F41 的区间边界、F32 的时区口径、F33 的 stats 缓存，每次重跑都会得到同一条结论，除非契约或缓存实现发生变化。
- **情报价值低**：F14 的 i18n 缺 key、F17 的状态脚本静默、F19 的日志权限、F29 的前端 `+N`，都是一次性事实。
- **成本远高于收益**：对大库跑全量 `PRAGMA integrity_check`（分钟级 IO）、每周做 ENOSPC 镜像、每周 SIGKILL、每天跑 `dbstat`，都会挤占生产 IO 而不产生新信息；`dbstat` 每周一次足够。
- **需要人判断**：F18 的威胁模型、F25、F26 的合并规则、F30 的备份策略，不是阈值能判定的。
- **已有更合适的载体**：进程内指标与阈值告警归 `scripts/monitor.ts` 与[运维手册的后台监控](operations.md#后台监控)；巡查只补数据质量与容量，不重复做采样。

## 边界

- `dbstat` 对大库有 IO 成本，放在低峰跑；它统计分配页（含空闲页），只比趋势不比绝对值。
- 状态目录是巡查唯一的写点，只写 JSON 快照；数据库始终只读。状态目录与数据目录相互独立，删掉它只会丢周环比，不影响采集。
- `sqlite3 -readonly` 在 `-shm` 缺失时可能打不开 WAL 库；生产有 `-shm`，副本要注意。
- `weekly` 的今日读数只覆盖部分天，`pending_hook` 的今日新增会被低估；`hook_absent` 因此固定取最近一个完整日。
- 任何 grep 到的日志都可能含绝对路径或令牌；周报只写计数与结论，不贴原文。
- 三条核心不覆盖安全与合并规则，routine 通过不等于这些面安全。

## 可直接粘贴的 checklist

```text
前置：只读。生产库 $HOME/Library/Application Support/tracery/trace.db；不写、不重启、不 kill 生产进程；不读真实请求正文与令牌明文。

1. 门禁：按根 AGENTS.md「命令」一节跑类型检查、测试、note 两项；任一非 0 立即停。
2. 跑 bun run patrol smoke；limit=0/201/1.5、direction=sideways、body?from=1e20、%ZZ 路径逐项看状态码；越界项记录，F41 的 200 记作已知基线。
3. 跑 bun run patrol weekly；它会写入本期快照并自动与上一期比较（首次显示「无上期可比」）；把整段输出贴进周报。
4. 需要进程内指标时跑 bun scripts/monitor.ts inspect；它的规则是权威口径，不要用本文或记忆里的数字另立标准。
5. 动到 schema、保留层、摄入、查询、生命周期时，按 C1–C5 对应项加跑；临时目录或 ≤300 MB 镜像，结束卸载并 rm，确认 mount 无残留。
6. 收尾：把命令、关键数字、判定写成三行以内；越界项按「触发式」定位；没有越界就写「阴性」。
```
