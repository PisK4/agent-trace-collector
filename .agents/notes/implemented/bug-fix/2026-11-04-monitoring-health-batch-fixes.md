# Agent Note: 监控体检缺陷的当晚批次修复

Status: implemented

## Problem

[后台监控核查记录](../../proposed/bug-fix/2026-11-03-monitoring-health-check-findings.md)（F01–F32）盘出三类必须当晚处理的问题：告警通道本身不可信（F08/F09/F10/F22 阈值常亮、误恢复、退出码恒 0）、性能放大器（F26 已修后的 F27 零并发保护、F29 前端布尔闸门、F06 重端点全量求和）、通道断裂（F28 title 指纹取不到、F02 首轮派生锁冲突、F04 孤儿队列无界）。另有巡检闭环缺口（F14 受限环境栈崩、F16 轮转未实测、F17 巡检无执行记录）与文档语义缺口（F25 重启 ≠ 生效）。

本文持有本批的修复决策与取舍；逐条证据、读数与复现命令在核查记录。纯观察项（F03/F05/F07/F15/F19/F30）不改代码，F32（unknown-actor 组不派生）按原计划另立批次。

## Decision

分支 `fix/monitor-health-checks`（worktree `atc-monitor-health`）七个单元提交，`--no-ff` 合并 master。

**监控判据整体校准（fix(monitor)）。** 五个决定一起落，因为它们共享同一组测试与阈值对象：

- `check` 退出码对作业层交代采样证据（`sampleEvidenceOk`：有样本、成功、在存活阈值内）。plist 的 `sample; check` 串行语义不变，sample 的失败由 check 补报成非零。
- p99 阈值 100 → 330 ms、持续 10 → 30 分钟。330 是核查记录 F22 里 p75+1.5×IQR（327）与 p95×1.15（338）两个独立估计的落点；100 ms 在本机 91/91 样本常亮，没有区分力。
- 新增 `event_loop.max_ms > 2 s` 的立即通道抓 F07 类单次停顿：p99 对单点尖峰不敏感（8192 样本环里一个离群不动分位），max 通道补这个盲区，环形窗口（约 7 分钟）自身限制存续。
- 恢复窗口 15 分钟：条件消失后连续无命中这么久才写 `recovered`；`stale` 期间不计时也不推进——缺数据不判恢复。重新命中清掉恢复计时。
- 截断语义拆分：告警持续窗口的连续性容差改用 `MISSING_SAMPLE_MS`（11 分钟），一个漏采样本与 9 分钟断档都不清窗口；`maxGapMs`（7.5 分钟）只留给新的 `sample_gap` 判据与报告统计。`sample_gap` 在 `stale` 短路之前评估——采样自身停摆正是它要抓的现象。

**巡检落盘（fix(monitor)）。** 新增 `monitor.ts inspect`：把采样新鲜度、活跃告警数、当日告警/提醒/恢复计数、24 小时采样断档数、诊断日志 24 小时错误计数（读不到返回 null，与 0 分开）、作业 last exit code 追加成一行 JSON 到 `monitor/checks/<day>.jsonl`，成功也写。诊断错误按 `kind:"error"` 行解析当前 live 日志，归档不计（如实记录口径）。

**spawnSync 容错（fix(monitor)）。** `service-support.ts` 的 plutil/launchctl/lsof/ps 四处同步调用统一走 `spawnText`：非零退出或无法执行（受限环境 EACCES）返回 null，探测面宁可少一项读数不在巡检里栈崩。

**title 指纹提取（fix(purpose)）。** 共享解释层新增导出 `titlePromptText`：`User prompt:` 标记保留原语义（标记之后的原文）；否则取首个 `<session>` 壳内的文本，经 `interpretUserText` 同一套清洗后返回——与参与链「首条有效用户文本」的指纹同一口径，壳内的 system-reminder 等注入按同规则剥掉。判据不认 harness 品牌，未知与空标签同样生效。`purposeUserFingerprintTx` 的 title 分支改调它，两个形状都不命中返回 null 不猜。

**store 两处（fix(store)）。** `schema_rebuild_required` / `schema_version_unsupported` 的错误信息带上 db 与 code 的版本号——launchd 反复拉起时 stderr 直接说明差在哪，不用再开库核对。写连接 `busy_timeout` 1 s → 5 s：进程内各写者共用一条写连接，锁冲突只发生在 launchd KeepAlive 重叠拉起等外部场景，5 s 等锁把「首轮派生整轮丢弃」换成短暂等待；只读连接维持 1 s。

**孤儿回调淘汰（fix(hook)）。** `reconcilePending` 顺手清理无 `response_id` 且 `first_seen` 超过 14 天的 `pending_hook` 行——没有 response id 就永远不可能有候选，保留只会让队列无界增长。带 response_id 的行一律保留，迟到的账本请求仍可关联。返回形状不变。

**读路径提速（perf(stats)）。** 两个决定：

- `getStats` 按写世代缓存，世代变化立即重算；同世代还受 5 秒 TTL 约束，避免进程外写入长期不可见。正文状态聚合的读取成本与实例报告缺失标识的处理见[首页查询扫描修复](2026-11-06-homepage-timeout-query-scans.md)。
- `/api/ingest-metrics` 的存储改用准入闸门最近一次量测（与轻量端点同源），无闸门的容量实验环境退回现算；响应新增 `storage_measured_at_ms` 标新鲜度。全量求和每次 111–190 ms，是探针按需拉本端点时事件循环长尾的直接来源。

**派生失败进结构化诊断（fix(derive)）。** 轮失败的错误码在 derive 边界归一：SQLite 锁冲突映射 `database_locked` / `table_locked`，其余走通用分类；`onRound` 的 failure 事件同时写 `kind:"error"`、`op:"derive.run"`（按 op+code 限流），巡检按错误计数找 Worker 失败不再漏掉整轮丢弃。

**F26 后续：跨组子查询定死 title 侧驱动（fix(sessions)，同日追加）。** 部署后复采发现会话列表仍慢（原始 SQL 75 ms），归因到候选①的风险预言成真：参与链指纹随流量增长，短路守卫对每个真实会话组都放行，而跨组子查询由 qt（全部 current 组，1,310 个）驱动、按组反查 title 行——成本是 O(current 组数) × 页内指纹会话数，页内 4 组指纹即 47 ms 增量，模拟页内 50 组指纹 367 ms。修法用 SQLite 的 `CROSS JOIN`（唯一能定死连接次序的内连接写法）让 t 侧先驱动：指纹部分索引只有 161 行非空、title 行是少数，qt 退为主键回查。同状态 75 → 14.7 ms，模拟态 367 → 6.9 ms，1,310 个会话标题与 flags 逐条差异 0；成本不再随指纹覆盖增长。

**会话列表并发（fix(http) + fix(web)）。** 服务端同 key（`limit`+`cursor` 的 search 串）单飞：迟来的请求 `await` 同一个在途 Promise，只付一次聚合；Promise 永不 reject——参数错误也走共享 rejection、由各请求的外层错误映射出 400，等待者不挂起；响应完成立即出表，不做跨请求缓存，live 字段（60 秒活跃窗）每次执行现算。前端 `reader-store` 的 `sessionsLoading` 布尔闸门改成 `sessionsInflight` Promise 共享：同 tab 并发调用等待同一结果而不是被静默丢弃。跨 tab 的放大只能靠服务端单飞兜住，这与核查记录 F29 的判断一致。

## Alternatives considered

**plist 把 `;` 改成 `&&`。** 会让失败的 sample 直接跳过 check，告警事件断流；保留 `;`、由 check 退出码补报，作业层可见且告警链不断。

**轮转改成「写新文件 + 符号链接切换」。** 需要同步改 launchd plist 的 StandardOutPath，实现与部署耦合；实测（见 Testing）launchd 打开 StandardOutPath 用 O_APPEND，`copyFileSync + truncateSync` 无丢行，不改。

**pending_hook 全表按保留期淘汰。** 会删掉「迟到但会到」的带 response_id 行；只淘汰从未有候选资格的孤儿。

**getStats 用短 TTL 缓存。** 探针每 5 分钟一次，TTL 内必过期，冷页成本照样付；世代缓存零陈旧且安静期免费。

**F26 候选③（批量预取）随本批一起做。** 标题优先级链与游标语义要逐条对齐，回归风险高于已落地的候选①，不顺手改。

**F27 的 B/C/D/E（TTL 结果缓存、Worker 化、分段响应、并发降级）。** F26 修回后单发毫秒级，3 标签页约 120 ms，不构成主线程阻塞；A（单飞）二十余行解决排队层。重评条件照核查记录：单发回到 >50 ms、需要 10+ 并发客户端、或冷页成本修后仍 >1 s。

**F11 在 guard 层改错误码。** guard 是通用任务包装，不知道派生语义；错误码在 derive 边界归一后才进得了固定分类。

## Consequences

- 告警语义变化：p99 330 ms/30 min 会放过 100–330 ms 的持续抬升（本机常态水平），由 max 2 s 立即通道、`sample_gap` 与巡检兜底；恢复比以前晚 15 分钟，触发与恢复成对且无单样本抖动。
- 写冲突从「整轮丢弃」变「最长 5 秒等锁」：冲突只发生在进程重叠或外部写者场景，常态无影响；若未来出现写连接被长期占用，5 秒等待会表现为事件循环卡顿，先查 `write|*` 慢日志。
- `getStats` 同世代返回同一对象引用，调用方不得原地修改（当前消费只有序列化）。
- `/api/ingest-metrics` 的 `storage_measure` 计数在有闸门时不再随调用增长，存储新鲜度看 `storage_measured_at_ms`。
- 14 天后 `pending_hooks` 计数会出现一次性下降（存量孤儿出队），不是丢证据：`miss_reason='hook_absent'` 已落在 request 行上。
- single-flight 让同 key 并发共享同一快照，毫秒级差异不可见；错误响应各自生成但内容一致。
- F24/F23 的执行层（四条 Codex 会话显式 rebuild、停服 bundle 备份、重启）随本次回归窗口执行，部署顺序固化在 [operations.md 的部署顺序一节](../../../../docs/operations.md#部署顺序重启只完成迁移不回填存量)。

## Testing

### 生产回归（2026-11-04 凌晨，三次重启窗口：初版部署 / 跨组修复 / rebuild）

F23 顺序执行：停服 → `maintain bundle`（3.92 GB 快照，manifest schema 10、盐与哈希齐备）→ 启动 → 只读核对 `user_version=10`、`integrity_check=ok`。备份在生产验证通过后按用户指示删除（2026-11-04 凌晨）；最终部署实例 2892 加载 `beced71`，验证后（热采样、监控 sample/check 退出码 0、活跃告警清零、F24 状态保持）确认无再启动需求。

- **F21 复采**（跨组修复后，15 轮 × 三端点）：metrics p50 2.1 ms、stats p50 **0.9 ms**（世代缓存生效，重启前 p50 262 ms）、sessions p50 **39.9 ms** / p95 83.7 ms；事件循环 p99 268–488 ms，主线程停顿仍在（F07 观察项保留）。
- **F26 验收**：sessions limit=50 预热中位 39.9 ms ≤ 40 ms；原始 SQL 14.7 ms；EXPLAIN 断言钉死 t 驱动。
- **F24**：四条 Codex 会话显式 rebuild 全成功（72 笔用途升级到当前版，b4ae 的 499 行按设计 retained/participate）。主卡标题收敛为「重绘 ATC 矩阵 IP」，`b4ae` 带 `background`，`b46a` 是 `bypass` 标题线程，`d007` `bypass+background` 折叠——**跨组标题绑定在生产端到端首次命中**：主卡借到标题线程的模型标题。
- **F28**：`req_kind='title'` 指纹从 0 → 1（rebuild 后 title 行可提取）；参与链指纹 161 → 217 随流量增长；`turn_ref` 从 0 → 68（OTLP 通道在写，待查项有了部分答案）。
- **F27-A**：5 并发同 key 墙钟 188 ms、响应一致、无错误。同 tick 合并只在测试的单任务形态成立；同步查询跨宏任务不合并（见 LESSONS），冷页慢查询在途时才有跨请求合并效果。
- **F30**：冷 83.7 ms vs 预热 39.6 ms——冷加成约 44 ms，2.4 s 的旧上界是 F26 退化期的伪象，观察项关闭。
- **F08**：受控验证退出码 0（健康）→ 1（死端口采样）→ 1（check 看到失败证据 + `service_unreadable` alert）→ 0（恢复采样）。
- **F10**：旧阈值时代遗留的 `event_loop_p99` 告警在恢复窗口后 01:27:31 正常写 `recovered`；停机重启引发的 `service_unreadable` 同样按窗口收敛。
- **F17**：`inspect` 落盘 `monitor/checks/2026-11-04.jsonl`（含活跃告警数、24 h 断档、诊断错误计数、作业退出码）。
- **F04**：1,354 条孤儿（最老 2026-10-24，11 天）未达 14 天 TTL，计数稳定；清理从 11-07 起生效。
- **F06 残余**：`/api/stats` p50 0.9 ms；`/api/ingest-metrics` 仍 1.7–2.0 s——metadata 全量求和未动，属该端点的独立成本，另记观察。

- 全量 `bun test` 1151 通过（含 89 个文件），`tsc --noEmit` 绿。
- 新增/改写：monitor 6 条（阈值校准、断档不清窗、sample_gap、恢复窗口与再命中清计时、采样证据退出码、巡检落盘与诊断错误计数）；`titlePromptText` 1 条（两形状 + 壳内清洗 + 未闭合不猜）；Claude 标题指纹 1 条（主会话与标题请求指纹一致）；pending_hook TTL 1 条（孤儿清理、带 id 保留）；stats 世代缓存 1 条；ingest-metrics 量测复用 1 条（有闸门不计measure、无闸门现算）；single-flight 1 条（5 并发同 key 只执行一次聚合、错误广播 400、完成后出表可见新写入）；reader-store 并发共享 1 条；store 迁移错误断言收紧到含版本号。守门测试「结算代码不出现 harness 品牌字面」抓到过 request-purpose 注释里的品牌词，已改写为形状描述。
- **F16 实测（launchd fd 语义）**：临时 launchd 探针作业（KeepAlive + StandardOutPath 指向临时文件）运行后外部 truncate，写入从下一条无缝继续、文件无稀疏洞——launchd 打开 StandardOutPath 用 O_APPEND，copy+truncate 轮转对 launchd 持有的 fd 安全。对照组：Bun `FileSink`（非 append 语义）在副本上复现稀疏洞（轮转后归档恰好等于「洞 + 数据」两倍体积），那是 Bun 写入器行为，不是 launchd 的。探针作业已删除。
- 跨组驱动修复的 A/B 与语义等价在同一份 bundle 快照与可写副本上完成：抹指纹 54 → 6.7 ms 定位增量来源；EXPLAIN 对比确认 qt 覆盖索引驱动改 t 的 `i_request_user_fingerprint` 驱动；等价性用新旧码翻完全部 1,310 个会话对比 title+flags（差异 0）。测试计划断言同步收紧：qt 行必须是主键回查，t 行必须是 `i_request_user_fingerprint`。
- 生产回归（重启后）：F21 同脚本复采、F26 会话列表延迟、F28 新流量指纹增长、F24 显式 rebuild 后四条 Codex 会话收敛、F04 计数走势、F08 退出码、F17 inspect 落盘、F30 冷页复测——结果回填核查记录对应条目。
