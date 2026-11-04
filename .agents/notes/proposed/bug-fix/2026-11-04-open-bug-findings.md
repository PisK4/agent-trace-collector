# Agent Note: 2026-11-04 起仍未关闭的缺陷清单（持续记账）

Status: proposed

## Problem

本篇只收 **2026-11-04 当天及之后仍未关闭**的问题；11-03 那批已关闭的条目不再重复列出。11-03 的 33 条（F01–F32 加当日晚补记的长派生项）与其关闭依据保留在 [2026-11-03-monitoring-health-check-findings.md](./2026-11-03-monitoring-health-check-findings.md)。

2026-11-04 按条目状态行、修复记录与提交历史重新核实的结论是：11-03 那批 **26 条已判关闭、1 条部分关闭（F28 仅 title 通道）、6 条仍未关闭**。已关闭的 26 条是 F01/F02/F04/F05/F06/F08/F09/F10/F11/F12/F13/F14/F16/F17/F18/F20/F21/F22/F23/F24/F25/F26/F27/F29/F30/F31；未关闭的是 F03/F07/F15/F19/F32 与 F28 的 `turn_ref` 子项。这些未关闭项全部承继到本篇，另有一条 11-03 遗留的 F01 残余项（`verify-cutover` 只读预检）一并承继。

11-03 篇里的长派生调查（原文编号 F33）本身是 **2026-11-04** 的取证，不是 11-03 的体检结果，已完整移入本篇 **F07**。它是本篇成文时唯一的新发现；此后系统巡查又补入 **F09–F31**（均标「11-04 新发现（系统巡查）」；第一轮 F09–F17、第二轮 F18–F24、第三轮 F25–F31），F01–F08 的既有结论未因此改写；只在 F06/F09/F11/F12/F16 上追加了第二轮证据、在 F07/F22 上追加第三轮交叉印证与实测，结论不变。

编号从 F01 重新开始，每条在标题上注明「承继自 2026-11-03 #Fxx」或「11-04 新发现」。正文引用旧编号时一律写成「旧编号 Fxx」并给出旧篇链接，避免两套 F 号混用。全部证据来自只读检查与 `VACUUM INTO` 副本；未改生产库、未重启服务、未 push。

## 汇总（F01–F31）

| 编号 | 来源 | 严重度 | 一句话现象 | 证据等级 | 状态 | 修复依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | 承继 11-03 #F03 | P2 | `hook_absent_marked` 5,114 批次 / 7,420 行，claude 占 84% | 实测+推断 | 待修 | 与 F06 的孤儿队列同一排查线 |
| F02 | 承继 11-03 #F07 | P1 | 探针 5,066 ms 尖峰；17:20–17:24 的 7.8–10.8 s 停顿未被捕获 | 实测+推断 | 待修（观察） | 分段计时未做；可与 F07-a 的组标识同批观测 |
| F03 | 承继 11-03 #F15 | P2 | `storage=null` 被当 0 参与容量比较（复核未复现） | 复核未复现 | 未证实（疑似误报） | 无；找到新的消费端证据再改 |
| F04 | 承继 11-03 #F19 | P1 | 活跃会话的已知偏离（排序、活跃区、降级文案、完成时间） | 待查（未重新取证） | 待补证据 | 先读 `src/queries` 与活跃区实现 |
| F05 | 承继 11-03 #F28 子项 | P0 | `turn_ref` 存量仍近空；回归期已有 0→68 的部分证据 | 实测 | 待查来源与覆盖 | 独立只读，不阻塞写窗口 |
| F06 | 承继 11-03 #F32 | P0 | unknown-actor 的 `["request",…]` 组从不进派生队列，标题恒空 | 实测+代码 | 待修（另立批次） | 展示已由 `tool_event` 折叠兜住 |
| F07 | 承继 11-03 篇的 #F33（11-04 取证） | P1 | 长派生单轮 18.6 s：同组正文被反复物化（行 7.3×、blob 约 50×），不是算法慢 | 实测 | 待修 | 无；但 A 与 D 分开 |
| F08 | 承继 11-03 #F01 残余项 | P2 | `verify-cutover` 没有只读预检，装完监控才发现 schema 不兼容 | 代码核查 | 待做 | 无 |
| F09 | 11-04 新发现（系统巡查） | P1 | 三路证据齐全但正文永久 pending，1,386 条不可恢复 | 实测 | 待修（等统一修复窗口） | 独立迁移脚本；排在性能波之前 |
| F10 | 11-04 新发现（系统巡查） | P1 | summary / turns 读接口 p50 0.44–0.68 s，SQL 只占 0.11–0.16 s | 实测 | 待修（等统一修复窗口） | 先分段插桩；与 F07 同属读接口 |
| F11 | 11-04 新发现（系统巡查） | P2 | raw 层 7 天 TTL 未生效，每表每天最多清 2,400 行 | 实测 | 待修（等统一修复窗口） | 与 F12 同批（保留层） |
| F12 | 11-04 新发现（系统巡查） | P2 | `raw_droid_event` 不在保留与 body 预算内 | 实测+未证实 | 待修（等统一修复窗口） | 与 F11 同批 |
| F13 | 11-04 新发现（系统巡查） | P2 | 83 组 170 行同时间槽重复请求，无 alias | 实测（同源未证实） | 待修（等统一修复窗口） | 独立；先只读统计 |
| F14 | 11-04 新发现（系统巡查） | P2 | 5 个 i18n key 字典缺失，覆盖率测试未挡住 | 实测 | 待修（等统一修复窗口） | 属门禁，单独小笔 |
| F15 | 11-04 新发现（系统巡查） | P2 | `session_usage` 按 `session` 查询走全表扫描 | 实测 | 待修（等统一修复窗口） | 独立小笔 |
| F16 | 11-04 新发现（系统巡查） | P2 | 并发 hook 被 `busy` 429 拒绝，服务端无重试队列 | 实测+未证实 | 待修（等统一修复窗口） | 独立小笔；先确认客户端重试 |
| F17 | 11-04 新发现（系统巡查） | P2 | 状态脚本日志读取失败静默为空 | 代码核查 | 待修（等统一修复窗口） | 独立小笔 |
| F18 | 11-04 新发现（系统巡查，第二轮） | P0 | 读 API 可用可伪造的 `Sec-Fetch-Site: same-origin` 绕过读令牌 | 实测 | 待修（等统一修复窗口） | **威胁模型判定前不动手** |
| F19 | 11-04 新发现（系统巡查，第二轮） | P1 | 日志含绝对路径与源码栈，权限 0644，文档写 0600 | 实测 | 待修（等统一修复窗口） | **独立小笔，需先决定旧日志是否删除** |
| F20 | 11-04 新发现（系统巡查，第二轮） | P2 | 畸形百分号编码被兜成 500 | 实测 | 待修（等统一修复窗口） | 归入「HTTP 契约小修」 |
| F21 | 11-04 新发现（系统巡查，第二轮） | P2 | `writer_failed` 回传内部错误文本（未触发） | 代码核查 | 待修（等统一修复窗口） | 归入「HTTP 契约小修」 |
| F22 | 11-04 新发现（系统巡查，第二轮） | P2 | 单块最大 12.6 MB（原文 16.85 MB），无入库上限 | 实测（渲染已补测，浏览器与派生未测） | 待修（等统一修复窗口）；单列观察 | 单列观察，不动代码 |
| F23 | 11-04 新发现（系统巡查，第二轮） | P2 | 派生同步失败无 attempts/last_error、无重试上限 | 实测+代码核查 | 待修（等统一修复窗口） | 归入派生可观测性 |
| F24 | 11-04 新发现（系统巡查，第二轮） | P2 | `body_bytes` 在 merge 路径漏写，`maintain purge` 低估可回收量 | 实测+代码核查 | 待修（等统一修复窗口） | 归入 `maintain purge` 估算修正 |
| F25 | 11-04 新发现（系统巡查，第三轮） | P2 | 与派生无关的会话合并弱规则：同 conv+agent ±60 s 唯一候选即并，不校验模型 | 实测+代码核查 | 待修（等统一修复窗口） | 与 F26 同批「身份/合并不变量」；先补正反例 |
| F26 | 11-04 新发现（系统巡查，第三轮） | P3 | `conv_key`/身份字段只 `COALESCE`，不按来源优先级提升，合并可能保留弱键 | 代码核查 | 待修（等统一修复窗口） | 与 F25 同批；当前 0 例，先写不变量测试 |
| F27 | 11-04 新发现（系统巡查，第三轮） | P3 | `normalize-response-ids` 裸 UPDATE 可能把两行改成同一个 `response_id_norm` 而不合并 | 代码核查 | 待修（等统一修复窗口） | 独立小笔；修前先扫重复键 |
| F28 | 11-04 新发现（系统巡查，第三轮） | P3 | `session_` 前缀只对 UUID 归一，`session_`+32 hex 保持原前缀，存在拆分隐患 | 实测+代码核查 | 待修（等统一修复窗口） | 独立小笔；先确认上游是否会写裸 32 hex |
| F29 | 11-04 新发现（系统巡查，第三轮） | P2 | 前端 `moreTargets` 超过 500 全表清空，旧 `+N` 弹层静默失效 | 实测+代码核查 | 待修（等统一修复窗口） | 独立前端小笔；先在最长会话复现 |
| F30 | 11-04 新发现（系统巡查，第三轮） | P2 | 备份「恢复成功」不等于「可服务」：白名单测试只改版本号，无迁移 smoke check | 代码核查 | 待修（等统一修复窗口） | 独立小笔；先定 smoke 命令与旧库样本 |
| F31 | 11-04 新发现（系统巡查，第三轮） | P3 | 备份注释三处口径矛盾；DB-only `backup` 无白名单/无盐，仅以 `ingestion_restorable:false` 提示 | 代码核查 | 待修（等统一修复窗口） | 独立文档小笔，与 F30 同批评审 |

## 承继映射（2026-11-03 → 2026-11-04）

| 新编号 | 旧编号 | 旧篇状态 | 本篇处理 |
| --- | --- | --- | --- |
| F01 | F03 | 待修 | 完整重写 |
| F02 | F07 | 待修 | 完整重写，补 11-04 已上线的 `max_ms>2 s` 通道 |
| F03 | F15 | 未证实（疑似误报） | 完整重写，保留观察项口径 |
| F04 | F19 | 待查 | 完整重写，保留「本次未重新取证」 |
| F05 | F28 子项 | title 通道已修，`turn_ref` 待查 | 只重写 `turn_ref` 子项，title 通道不再列 |
| F06 | F32 | 待修（P2） | 完整重写 |
| F07 | 旧篇 F33 | 待修 | 完整搬运（11-04 取证，保留全部表格与候选） |
| F08 | F01 残余 | 条目已修，预检未做 | 只重写残余项 |

## Findings

### F01 `hook_absent_marked` 5,114 批次 / 7,420 行（承继自 2026-11-03 #F03）

- **现象**：stderr 每隔 5 秒就可能打印一次 `hook_absent_marked:<n>`，到 2026-11-03 累计 5,114 行；库内 `miss_reason='hook_absent'` 共 7,420 条。
- **证据**：`hook.ts` 的 [src/hook.ts L480](../../../../src/hook.ts#L480) = 1 小时，[src/hook.ts L495-520](../../../../src/hook.ts#L495-L520) 每轮把「等满 1 小时仍无正文、且等待队列没有指向本行」的 request 标成 `miss_reason='hook_absent'`，每轮上限 200。5,114 是**批次数**不是行数：17 种批次大小，绝大多数是 1，最大一批 81。
- **规模与分布**：7,420 条按 agent 分布为 claude 6,269、hermes 639、magpie 344、omp 113、zcode 37、curl 5、codex 5、Python-urllib 4、AsyncOpenAI 3、OpenAI 1；11-03 当天新增约 91 条。
- **影响**：正文缺失的请求被明确标注，属数据完整性问题，不是监控噪音；claude 占 84%，说明回调大面积没有送达或无法关联。
- **可能根因**（推断）：设计内的兜底标注 + claude 侧 hook 未安装/未回调（或 `response_id` 缺失导致无法关联）。不是监控代码 bug。
- **建议修法**：不改标注逻辑；排查 claude 侧 hook 安装与 `response_id` 回传（与 F06 的孤儿队列同一排查线），并把该标记做成结构化诊断计数而不是 stderr 噪音。
- **严重度**：P2。**是否阻塞其它工作**：否。
- **状态**：待修（2026-11-04 未动手，`git log` 无相关修复提交）。

### F02 探针 5,066 ms 尖峰与 7.8–10.8 s 未被捕获的停顿（承继自 2026-11-03 #F07）

- **现象**：2026-11-03 17:19:42 那条样本 `elapsed_ms=5066`，是 43 条里唯一 >1 s 的探针，`state` 仍 `ok`；17:20–17:24 之间还有一次 ~7.8–10.8 s 的主线程停顿，没有被任何探针捕获。
- **证据**：同一采样点 `event_loop.max_ms=3589.9`、`jobs.pending.max_ms=3552`、`jobs.derive.max_ms=3758`、`jobs.retention.max_ms=3144`；前后两条探针为 157/204 ms。**它不是 7792/7816 那次停顿**：17:19 样本的累计最大值还是 3552/3758，7792/7816 在 17:24:43 才出现，且同一时刻 `event_loop.max_ms=10855`（17:24 的探针本身只有 204 ms，没抓到）。17:14:36 已有 2946/2826/2319 的前兆。
- **影响**：探针会被并发重任务拖慢，但离 15 s 上限还远（34%）；更值得记的是 17:20–17:24 之间有一次 ~7.8–10.8 s 的停顿，没有被任何探针捕获。
- **可能根因**（推断，未证实）：`pending`（5 s）、`derive`（2 s）、`retention`（30 s）在同一时刻堆叠，同步落盘占满主线程。需要看 17:20–17:24 的结构化日志才能确认具体是哪一轮。
- **11-04 进展**：11-03 批次已给监控加 `event_loop.max_ms > 2 s` 的立即通道（`maxLoopMs=2000`），能抓这一类单次停顿；但**探针自身的分段计时与 7.8–10.8 s 那次的具体轮次仍未查**。`derive` 已在 Worker，`pending`/`retention` 的同步写未复核。
- **建议修法**：把长事务移出主线程（先复核 `pending`/`retention` 的同步写）；给探针加分段计时，避免两个端点串行累加；用 F07-a 的组标识把长派生轮次与停顿窗口对齐。
- **严重度**：P1（性能问题，可能影响摄取延迟）。**是否阻塞其它工作**：否。
- **状态**：待修/观察（立即通道已上线，根因与分段计时未做）。

### F03 `storage=null` 的消费端行为（承继自 2026-11-03 #F15；未证实）

- **现象**：`lightSnapshot` 在从未量测时返回 `storage:null`。原判断是「下游规则把 null 当 0 比较」，11-03 复核未能复现。
- **证据**：`src/capacity.ts:372-400` 只负责返回 null；唯一的下游容量规则在 `scripts/monitor.ts:358-359`，从监控作业引入起就显式 `if (storage !== null) {…}`（`686990d`，11-03 14:09），null 时整段跳过，不会参与比较。全仓未找到其他把 `storage=null` 当 0 的路径。11-03 采样期间 `storage` 全程新鲜（年龄 0.4–5.0 s），也未触发。
- **影响**：未观察到实际影响。
- **结论**：证据不足以定为缺陷，保持观察项；除非找到新的消费端证据，否则不建议改动。
- **建议修法（保留备用）**：若未来有消费端把 null 当 0，再对它显式产出 `storage_unmeasured`，不要让未知态参与容量比较。
- **严重度**：P2。**是否阻塞其它工作**：否。
- **状态**：未证实（疑似误报）；11-04 未找到新证据，仍未关闭但也不改代码。

### F04 活跃会话的已知偏离（承继自 2026-11-03 #F19）

- **现象**：排序立即生效、活跃区只覆盖已加载列表、断连/未知无降级文案、完成时间不参与最近活动。
- **证据**：来自前序 review 的已知偏离，**11-03 与 11-04 均未重新取证**（未读活跃区实现与测试）。按用户要求记账。
- **影响**：用户可见的排序/会话列表行为与预期不一致。
- **可能根因**（未证实）。
- **建议修法**：先补证据：读 `src/queries` 与活跃区实现、对应测试，逐条确认上述四点是否仍成立，再决定是否改；不要泛泛而谈。
- **严重度**：P1。**是否阻塞其它工作**：否。
- **状态**：待补证据。**注意**：活跃区近期有过改动（`49ac7bf`「用摄入增量维护在途集合，列表按 60 秒窗口判定活跃」），复核时先确认这些偏离是否已被那次改动部分覆盖。

### F05 `turn_ref` 通道仍近空（承继自 2026-11-03 #F28 子项）

- **现象**：11-03 23:24 快照里全库 `turn_ref` 非空仍为 **0**；11-04 回归期出现 **0 → 68**，说明 OTLP 通道在写，但覆盖范围与写入条件未核实。
- **证据**：
  - `turn_ref` 由 OTLP 映射写入（`mapping.turnRef`），不是派生副作用；11-03 的 title 指纹通道已由 `titlePromptText` 修复（提交 `b156096`），那是独立子项，已关闭。
  - 11-04 批次回归记录（[批次修复 note](../../implemented/bug-fix/2026-11-04-monitoring-health-batch-fixes.md) 的 Testing）明确写「`turn_ref` 从 0 → 68（OTLP 通道在写，待查项有了部分答案）」。
  - 仍缺的口径：68 条覆盖哪些 agent、哪些时间桶；是否只覆盖新流量；与 `user_fingerprint`（全库非空 11,321）的比例差是数据源缺失还是映射条件未命中。
- **影响**：按 `turn_ref` 身份关联的验收会得到假阴性；跨来源归属迁移的判据不完整。
- **核查方案（只读）**：
  1. 按 agent × 日桶统计 `turn_ref` 非空数，与 `request` 总量对比，确认覆盖是否只来自某一来源。
  2. 抽样原始 OTLP 记录，确认 `mapping.turnRef` 的字段名与写入条件；区分「上游没给」与「映射没取」。
  3. 给出「存量是否需要回填」的明确结论；若需要，评估 `maintain rebuild` 对 `turn_ref` 是否生效（11-03 的 rebuild 只升 `purpose`，未必重写 OTLP 映射）。
- **严重度**：P0（身份关联不可用，且掩盖 F07 的组归属判断）。
- **状态**：待查（部分证据已有，未定性）。**是否阻塞其它工作**：不阻塞写窗口，但会阻塞按 `turn_ref` 做的验收。

### F06 unknown-actor 的 `["request",…]` 组从不进入派生队列（承继自 2026-11-03 #F32）

- **现象**：`conv_key` 以 `["request"` 开头的组没有任何派生队列行，读侧四个标题候选全部落空，最终空标题。
- **证据**：
  - [state.ts L191-196](../../../../src/derive/state.ts#L191-L196)：`requestGroupTx` 在 `actor_state !== 'known'` 时直接 `return null`，不进派生队列；[markRequestGroupsTx L199-204](../../../../src/derive/state.ts#L199-L204) 因此也不会把这类组标脏。
  - 库里实测：11-03 快照中 `conv_key` 以 `["request"` 开头的 key **414 个**，其中 `derive_queue` 有组的 **0 条**。
  - **第二轮补证**：还有 **1,283 行** `via='hook'`、`actor` 非空但 `actor_state='unknown'`——[src/hook.ts L164-177](../../../../src/hook.ts#L164-L177) 先填 session、`state` 留 `unknown`；这些行被 [src/queries/turns.ts L52](../../../../src/queries/turns.ts#L52) 与 [src/queries/session-summary.ts L121](../../../../src/queries/session-summary.ts#L121) 的 `actor_state='known'` 过滤，读侧同样看不到。
  - 读侧：[sessions.ts L128-159](../../../../src/queries/sessions.ts#L128-L159) 的 r1–r4 四个标题候选全部 `JOIN derive_queue` 落空；[L172-173](../../../../src/queries/sessions.ts#L172-L173) 的 `SESSION_TITLE_GUARD_SQL` 的 `EXISTS` 为假 → [L217](../../../../src/queries/sessions.ts#L217) `CASE WHEN guard THEN ${SESSION_TITLE_SQL} END` → 空标题。请求行上虽然存了 `title='<model> · 16:25'`、`title_source='model_time'`，但组不存在，连 r4 的 `derivedColSql` 回退都轮不到。
  - **最关键的一条**：即使把 11-03 篇旧编号 F31 的规则改成 `source:web_search → exclude`，当时首屏那 18 张卡（全库同族 136 张）**也不会自动收走**——它们根本没有派生组，列表读的是原始列回退。要收走，必须先让 unknown-actor 的请求组进派生，或单独做一次归并/回填。
- **影响**：所有 unknown-actor 会话标题为空、flags 缺失（组闸门为假），也无法通过重派生收敛；展示层现在靠 `tool_event` 折叠把 web_search 子事件收起来，但数据层仍不收敛。
- **根因（已证实）**：派生队列只接收 `actor_state='known'` 的组；unknown-actor 组没有任何派生或回填路径，读侧却仍把它们当会话展示。
- **修复方向（未采纳，待拍板）**：让 unknown-actor 组以独立键进派生队列（或对前缀组做一次性归并/回填），并把 `sessions.ts` 的 guard/候选从 `JOIN derive_queue` 改为可回退原始列；需补多 actor / unknown-actor 用例与回填脚本。
  - **改动面比 11-03 篇旧编号 F26 大**（派生键、队列基数、回填与读侧回退都要动），需单独评估风险，不要写成顺手能修。
- **严重度**：P0。
- **状态**：待修（另立批次，需单独评估风险）；展示缺口已由 `tool_event` 折叠兜住（见[收起方案](../../implemented/bug-fix/2026-11-03-websearch-subevent-cards.md)）。

### F07 长派生的成本来自同组正文被反复物化，而不是算法本身（`derive.compute` 单轮 18.6 s）（承继自 2026-11-03 篇 #F33；11-04 取证）

- **现象**：生产 `derive.compute` 单次最长 **18,572 ms**（实例 `71752-mw1o05ka`，`4ec6c91`，2026-11-04 13:17:09 启动；结构化日志时间 `05:59:47Z`，本地 13:59:47）。同一 uptime 6,400 s 内 **943 轮非空派生**累计 **2,245 s**，占空 **35–39%**；耗时分布：≥2 s **49%**（462 轮）、≥5 s **15.6%**（147 轮）、≥10 s **6 轮**，均值 **2,381 ms**。直接后果是常驻内存平台 **900–1,100 MB**：单次 compute 使进程 RSS **101 MB → 995 MB**，同进程连跑四次累到 **1,423 MB**，分配器不归还（与 2026-11-04 的 RSS 定性同源）。
- **关键取证**（`VACUUM INTO` 副本，部署 `4ec6c91` 与当前 HEAD `2751b58` 在 `src/derive/`、`src/body.ts`、`src/body-cache.ts`、`src/main.ts` 上零差异；最大组 `…679ab0be-005c-4c1d-b91d-dfa624bdb653`，单 actor，4,378 行）：

  放大比：

  | 项 | 数值 |
  | --- | --- |
  | 引用行（实际需要的） | 564,736 |
  | 本轮实际读行 | 4,145,906 → **7.3×** |
  | 去重压缩块 | 11,808 块 / 50.4 MB（原始 168.6 MB） |
  | 本轮实际搬运 blob | 2,501 MB → **约 50×** |

  解码（证明瓶颈不在 zstd）：

  | 项 | 数值 |
  | --- | --- |
  | 解码 / 命中 / 淘汰 | 22,623 / 1,374,403 / 18,065 |
  | 11,808 个不同块全解压一遍 | **262 ms**（占 compute 4.2%） |

  分段（副本热 **6,200 ms**、冷 **9,057 ms**；分段合计 **5,710 ms**，覆盖 92%）：

  | 阶段 | 毫秒 | 占比 | 其中 SQL | SQL 行数 | blob |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | P1 指纹与骨架判定 | 1,059 | 18.6% | 561 | 1,125,360 | 287 MB |
  | P2 `replyInfoOf`（只取回复却重建整笔正文） | 1,540 | 27.0% | 709 | 1,120,982 | 962 MB |
  | P3 前驱匹配 / 中断 / 上下文 | 394 | 6.9% | 189 | 10,939 | 15 MB |
  | P4 角色与链对比 | 11 | 0.2% | 9 | 4,378 | 0 |
  | P5a 工具配对前再次 `readBodyTx` | 916 | 16.0% | 531 | 1,094,635 | 837 MB |
  | P5b 工具抽取 | 77 | 1.3% | — | — | — |
  | P6 后台作业扫描 | 382 | 6.7% | 269 | 268,009 | 271 MB |
  | P7 展示取数 | 1,314 | 23.0% | 621 | 564,602 | 176 MB |
  | **合计** | **5,710** | 100% | **2,890（46%）** | **4,145,906** | **2,501 MB** |

  **白干证据**：该组 `input_revision = published_revision = 14,726`，对 4,378 笔请求 = 每笔标脏 **3.36 次**（全库 221,714 / 63,845 = **3.47 次**）；不变量下重放得 `changed_rows=0`、`changed_presentations=0`，即多算一轮**一列都不写**。`derive_request_result` / `derive_generation` **两表 0 行**，切片增量从未在生产跑过；`derive_queue.from_sort` **1,039/1,336** 组为空，没有任何「只算新增后缀」的游标。
- **已证伪的方向（下一个人不要再跑）**：
  - `cache_size=256 MB`、`mmap_size=512 MB` 对同组 compute **无改善**（6.1–7.1 s vs 6.4–6.6 s，噪声级）。
  - 实测 PRAGMA（只读连接与生产一致）：`cache_size` 2000 页 ≈ **7.8 MiB**、`mmap_size = 0`、`wal_autocheckpoint` 1000 页、`page_size` 4096、`journal_mode=wal`、`auto_vacuum=2`、`synchronous=NORMAL`。
- **不阻塞主线程（但摄入延迟未证实）**：compute 在 Worker（[main.ts L130-133](../../../../src/main.ts#L130-L133)、[worker-entry.ts L24-37](../../../../src/derive/worker-entry.ts#L24-L37)），主线程只做 apply，该轮 `apply_ms=4`；18.6 s 窗口（`05:59:28.500` 前一轮结束 → `05:59:47.077` 本轮结束）内**没有 ≥100 ms 的慢事件**（无 `http.read`、无 `write`），相邻分钟有 `/api/stats` 324–647 ms。**但**非慢请求不落日志、库内没有接收时间戳，**「摄入被推迟」属未证实**，不能写成「没有影响」。
- **候选修法（先记录，不选一个就开工）**：

  | # | 方案 | 改动面 | 预期收益 | 风险 |
  | --- | --- | --- | --- | --- |
  | A | 组内一次性预取：refs 只取结构列（req_id/ord/block_id/role/hash）+ 去重块的 `z` 一趟拉齐，P2/P5/P6/P7 从同一只读上下文消费 | `src/derive/read.ts`、`src/body.ts` 新增 GroupReadContext 约 200 行；`src/derive/sync.ts` 接线约 40 行；测试约 150 行 | blob 2,501 MB → ≤100 MB；SQL 行 4.15 M → 约 0.6 M；SQL 2,890 → 约 1,100 ms；副本 6,200 → ≤4,500 ms，生产同比例约 18.6 → 13 s | 每轮多占约 50 MB 原始 blob；共享解码对象被原地修改会污染后续行（现有块缓存踩过这个坑） |
  | B | 回复与预览只读骨架：`replyInfoOf` 与 `userPreview` 不再重建整笔正文 | `src/derive/read.ts` 约 30 行 + 语义测试 | 直接砍掉 P2 的 1,540 ms（27%），P7 同步下降 | 改变「可读」判定语义：块损坏时行为变化；需提升算法号并明确重建范围 |
  | C | 单组计算设时间预算 + 分片续做（P2/P5/P6/P7 均逐行独立，可按行切片、分片发布） | `src/derive/sync.ts` + `src/derive/unit.ts` 约 300 行 + CAS 语义设计 | 总 CPU 不变，把 18.6 s 长尾切成 ≤2–3 s 的块 | 半发布可见；分片边界与 role 依赖要证明；不解决 35–39% 占空 |
  | D | 真增量：启用切片 / 持久化 `derive_request_result`，按 `from_sort` 只算新增后缀 | 大（切片已冻结；v6 表已在库但 0 行） | 新来一笔只算 1 行而非 4,378 行 | 迟到正文、乱序、归属迁移、回收都会改历史结论；[2026-10-26 笔记](./2026-10-26-derive-body-decompression-amplification.md) 已明确拒绝在无正确性模型时用 `from_sort` |
  | E | 大组 dirty 去抖（30–60 s 合并修订） | `src/derive/unit.ts` 约 50 行 | 轮数约降 60%（3.36 修订/笔压到 1） | 数据陈旧；活跃长会话可能永远等不到安静窗口 |

  **倾向 A**：语义中性、可局部回滚、收益有分项数据支撑，且不必碰切片冻结与算法号；**B 单独评审**（收益最大但动语义）；**C 作为长尾护栏并行**；**D 归增量议程**，别把 A 当根治。
- **验收口径（A 落地后）**：
  - 同一组副本 compute 由 **6,200 ms** 降到 **≤4,500 ms**；blob 搬运量 **2,501 MB → ≤100 MB**；`GET /api/sessions?limit=50` 与 `event_loop.p99` **不退化**（对照 [11-03 篇](./2026-11-03-monitoring-health-check-findings.md) 的 F21 基线与本条目记录时的实测值）。
  - **冷热必须分开记**：热 **6,200 ms**、冷 **9,057 ms**；冷/热对比在**同一进程内先跑一次再取值**，第二次读数才是热值，跨进程读数会混入页缓存差异。
  - 修复前后都能复现：按下方步骤取副本并分段计时，分段合计覆盖真实调用 ≥90%。
  - 整组 `changed_rows=0` 的轮次能与 `derive.compute` 时长在日志里关联。当前日志**缺 `conv_key`**，修这条需先给 `derive.result` / `derive.compute` 补组标识字段——作为 **F07-a** 子项，与 A 分开提交。
- **复现步骤（只读，不依赖任何本机绝对路径）**：

  ```bash
  DB="$HOME/Library/Application Support/tracery/trace.db"   # 部署目录名以 src/config.ts 为准
  SNAP=/tmp/atc-f07/trace.db
  mkdir -p /tmp/atc-f07
  sqlite3 -readonly "$DB" "VACUUM INTO '$SNAP'"
  sqlite3 "$SNAP" "PRAGMA user_version; PRAGMA integrity_check; SELECT COUNT(*) FROM request;"
  ```

  - 在 `/tmp/atc-f07` 写临时脚本（**不改 `src/`**）：`bun:sqlite` 以 `readonly: true` 打开副本，先只在该副本把 `derive_queue` 对应组置 `dirty`，再 `import { computeDeriveGroup } from '<repo>/src/derive/sync.ts'` 计时调用。
  - 分段版按 `src/derive/sync.ts` 的 `computeDeriveGroup` 顺序复制执行，逐阶段 `performance.now()`；再用 SQL 代理统计每阶段 `.all()/.get()` 的次数、行数与返回 `Uint8Array.byteLength`，得到上面的放大比。
  - 解码/命中/淘汰直接从 `outcome.body_read` 读，不需要另插桩。
  - 冷/热对比必须在**同一进程**内先跑一次再跑第二次；对照 PRAGMA 用 `cache_size` / `mmap_size` / `page_size` / `journal_mode` / `auto_vacuum` / `synchronous` / `wal_autocheckpoint`。
  - 收尾：`rm -rf /tmp/atc-f07`；副本用完即删。
- **Risks**：
  - A 的预取上下文每轮多占约 **50 MB** 原始 blob；共享解码对象必须只读（现有块缓存已有「共享消息被原地修改」的坑），否则会污染后续行。
  - **只做 A 不会降低 35–39% 占空**，只是把单轮成本压约 30%；真正降占空靠 D，别把 A 当成根治。
  - `changed_rows=0` 的轮次占比无法从日志量化（缺 `conv_key`），A 之后仍需 F07-a 才能算清浪费比例。
- **未证实项**：
  1. 18,572 ms 归属 `679ab0be` 还是 `51d5bfac`（后者 733 行 / 1,090,386 引用 / 659 MB，副本 5,215 ms）；日志无组标识。
  2. 生产比副本慢 2–3 倍的原因（候选：2.5 GB blob 分配带来的 GC、主线程并发抢占、活库 WAL 页读取）；`vmmap`/`footprint` 需 root，`/api/metrics` 无 heap/GC 字段。
  3. 那轮 dirty 的触发者（窗口内该会话既无新请求开始、也无结束；库内无接收时间戳可比对）。
  4. 分阶段 RSS 贡献（只有总增量 101 → 995 MB，未做分阶段分解）。
- **第三轮交叉印证（切片路径）**：`derive_generation` **0 行**、`derive_request_result` **0 行**；slice 运行时只在 `config.deriveBudget` 有值时挂载（[src/main.ts L113-119](../../../../src/main.ts#L113-L119)），生产走同步路径（[src/derive/unit.ts](../../../../src/derive/unit.ts) 的 `store.deriveRuntime` 分支未进入）。这与本篇 F07「生产是同步 compute」的判断一致，不另立条目。
- **严重度**：P1（性能/内存，非数据正确性）。
- **状态**：待修。

### F08 `verify-cutover` 缺少只读预检（承继自 2026-11-03 #F01 残余项）

- **现象**：11-03 的 F01 本体（`schema_rebuild_required` 崩溃栈的误导性）已由 `fix(store)` 提交修好——迁移错误信息现在带 db 与 code 版本号（`7b376df`）。但原建议里的**只读预检**没有做：安装/升级监控时仍要等到服务启动失败，才知道旧库 `user_version` 不兼容。
- **证据**：11-03 修复记录的「遗留」明确写「F01 的 `verify-cutover` 只读预检未做」；11-04 回归窗口执行的是备份→重启→rebuild→验证，没有新增预检步骤。[operations.md](../../../../docs/operations.md) 的部署顺序也没有预检命令。
- **影响**：换机器、回滚到旧数据目录、或数据目录指向旧库时，会在重启窗口里才发现 schema 不兼容，浪费一次停服窗口；错误信息现在可读，但发现时机仍偏晚。
- **建议修法**：在 `verify-cutover` / `maintain` 增加只读预检：`PRAGMA user_version` 与代码 `SCHEMA_VERSION` 对比，输出「可原地迁移 / 需重建 / 不支持」三种结论并给非零退出码；只读打开，不做任何迁移写入。
- **严重度**：P2（流程缺口，不改变服务可用性）。
- **状态**：待做；11-04 未动手。

### F09 三路证据齐全但正文永久 pending，1,386 条不可恢复（11-04 新发现，系统巡查）

- **现象**：`body_state='pending'` 且 `have & HAVE_BODY = 1` 的 request 共 **1,386 条**，全部 `via='through'`、`miss_reason='disk_body_paused'`，时间集中在 2026-10-31 14:23:05–18:17:12。
- **证据**：
  - 三路证据齐全：每条都有 hook / ledger / route 三行 `request_evidence`，`merge_state='merged'`、`payload_state='present'`。
  - 正文骨架缺失：`skeleton_z IS NULL` **1,386/1,386**；关联 `request_block` **0 行**；`raw_hook.request_z` 总量 **0**。
  - 判据错配：[src/hook.ts L537](../../../../src/hook.ts#L537) 的 `markHookAbsent` 只在 `(have & HAVE_BODY) = 0` 时才处理；这批行**因为带 body 证据被永久排除**。全仓没有其他路径把 `pending` 改回 `partial` / `available`。
  - 全量一致性矩阵里，「`pending` + 有正文证据 + 无 skeleton」只有这一类，没有第二种形态。
  - **第二轮补证**：全库 `body_state='pending'` 共 **8,948 行**，按日 11-04=139、11-03=150、11-02=1,278；`request_evidence` 侧 pending **1,377**，`/api/stats` 的 `pending_hooks=1,378`——与 1,386 的差值是统计口径/时点不同，不改变「这一类不可恢复」的结论。
- **影响**：1,386 条请求永久显示正文缺失，且**不可恢复**（它们不在 `markHookAbsent` 的可达集合里）。
- **建议方向**：一次性把这类行重判为 `partial`，保留原 `miss_reason` 以保住诊断信息；`markHookAbsent` 增加「有 body 证据但无 skeleton」分支，改为 `partial` 而不是跳过。重判是一次写操作，需独立迁移脚本 + 写窗口，并先做只读计数确认范围。
- **严重度**：P1（数据不可恢复，影响历史可读性）。
- **未证实点**：2026-10-31 14:23–18:17 这个窗口为何集中产生该形态（当天是否发生过 `disk_body_paused` 抖动、hook 落盘中断）；这批 hook payload 是否曾落盘（`raw_hook.request_z = 0`，无法证明曾经存在）。
- **状态**：待修（等统一修复窗口）；重判脚本独立一笔提交。

### F10 summary / turns 读接口 p50 0.44–0.68 s，SQL 只占 0.11–0.16 s（11-04 新发现，系统巡查）

- **现象**：`/api/sessions/:key/summary` 与 `/turns` 稳定半秒级；其余读接口正常。
- **证据（15 轮、间隔 1 s、全部 200）**：

  | 接口 | p50 | p95 | p99 / max |
  | --- | ---: | ---: | ---: |
  | `/api/sessions/:key/summary` | 682.3 ms | 748.0 ms | 748.0 / 1,015.9 ms |
  | `/api/sessions/:key/turns` | 444.3 ms | 574.0 ms | — / 782.7 ms |
  | `/api/sessions?limit=20` | 445.8 ms | — | — |

  - 对照：`/api/requests?limit=100` 8.7 ms、trace 详情 6.2 ms、`/api/stats` p50 1.9 ms、`/api/metrics` 5.3 ms。
  - 日志原文（2026-11-04T08:24 时段）：`{"op":"http.read","phase":"/api/sessions/:key/summary","dur_ms":701}`、`{"op":"http.read","phase":"/api/sessions/:key/turns","dur_ms":394}`。
  - 副本同函数：summary **162 ms**、turns **109 ms**、listSessions(20) **123 ms**。
  - 已排除：进程 CPU 8.5%、事件循环 p50 1.02 / p95 13.4 ms、写事务占空 2.3%（265 s / 3.17 h）。
- **影响**：打开会话详情稳定半秒级，p95 约 0.75 s。
- **建议方向**：先做 **handler 内分段插桩**（连接/事务等待、查询、`JSON.stringify`、flush），并对照 `store.read` 的锁等待与 `jobs.pending`/`retention` 读连接占用；**先插桩再定修法**，不要在没定位那 0.32–0.52 s 之前改 SQL。附注：`summary` 不读 `request_block`，所以不是 F07 那类逐行物化放大。
- **严重度**：P1（用户可见延迟）。
- **未证实点**：HTTP 层比副本多出的 **0.32–0.52 s** 来源；现阶段只有总量，没有分段归属。
- **状态**：待修（等统一修复窗口）。

### F11 raw 层 7 天 TTL 实际未生效（11-04 新发现，系统巡查）

- **现象**：raw 三表 + otlp span 的 7 天 TTL 没有真实生效，超期存量持续累积。
- **证据**：
  - [src/retention.ts L125](../../../../src/retention.ts#L125) `PRUNE_BATCH = 100`；[src/main.ts L47](../../../../src/main.ts#L47) `RAW_PRUNE_INTERVAL_MS = 1h` ⇒ 每表每天最多清理 **2,400 行**。
  - 超期存量：hook **14,843**、ledger **17,214**、route **17,992**、otlp span **6,212**。
  - **第二轮复核（同日不同时点）**：超 7 天存量 raw_ledger **17,146**、raw_hook **14,771**、raw_route **17,923**；与首轮差值为新流量与清理之间的波动，未改变「清理吞吐 < 日增量」的结论。
  - 日增量观测：hook 2,141–7,436、ledger 2,333–8,092、otlp span 单日 **150,603**（11-03）——都超过每日 2,400 的清理上限。
- **影响**：保留承诺（7 天）不成立，DB 无界增长；当前 **4.72 GB**、磁盘剩 **363.5 GB**，短期不触发故障。
- **建议方向**：prune 改为「循环到空」或按字节预算；或提高批量/频率以覆盖日增量。改完用「超期计数 → 0」验收，不要只看单次 prune 返回值。
- **严重度**：P2（容量与承诺问题，非即时故障）。
- **未证实点**：各表超期存量的最早时间与增长斜率未逐日展开；`RAW_PRUNE_INTERVAL_MS` 的 1 h 是否为有意保守值，代码注释未说明。
- **状态**：待修（等统一修复窗口）；与 F12 同属保留层，同批处理。

### F12 v11 新表 `raw_droid_event` 不在保留与 body 预算内（11-04 新发现，系统巡查）

- **现象**：v11 新建的 `raw_droid_event` 既没进 raw TTL，也没进 body 字节计量。
- **证据**：
  - [src/schema-v11.sql L8](../../../../src/schema-v11.sql#L8) 建表；**49,204 行**，`payload_json` 合计 **108,134,210 B（103.1 MiB）**；事件时间 2026-08-21–09-02。
  - [src/retention.ts L469](../../../../src/retention.ts#L469) 的 `pruneRaw` **没有 droid 分支**。
  - `measureBodyBytes` 未计入该表（body 计量当前 **1.733 GB**）。
  - **第二轮补证**：同类问题不止 `raw_droid_event`——`raw_session_event` 共 **57,825 行**，其中 **54,377 行（94%）超 7 天**，保留链路同样没有覆盖该表。
- **影响**：保留层与容量预算都漏掉一张百万级 payload 表；目前 103 MiB 还可接受，但增长无约束。
- **建议方向**：明确纳入 TTL（与其它 raw 表同口径），或声明为长期归档并并入容量预算；两种都要在代码注释里写清意图。
- **严重度**：P2。
- **未证实点**：无 TTL 是否为有意长期归档，代码注释未说明；droid 事件的产生速率未采样。
- **状态**：待修（等统一修复窗口）；与 F11 同批。

### F13 83 组 170 行同时间槽重复请求，未生成 alias（11-04 新发现，系统巡查）

- **现象**：同一 `conv_key + actor + started_ms + agent` 出现多行，但没有 `request_alias` 记录。
- **证据**：共 **83 组 170 行**；`request_alias` 命中 **0**。
  - 构成：44 组两行均无 `response_id_norm`；113 行 `through/pending/have=6`、45 行 `hook/available/have=1`、11 行 `through/available/have=7`、1 行 `hook/evicted/have=1`。
  - 形态互补：一行有正文、另一行在等正文，指向同一次调用被两条通道各记了一行。
- **影响**：`request_count` 至多虚增 **170**；会话详情可能出现同槽重复轮次。
- **建议方向**：评估以 `(conv_key, actor, started_ms, agent)` 作兜底合并键，或在 ingest 端按槽去重；先做只读统计，确认 170 行里有多少会改变 `request_count` 的可见值。
- **严重度**：P2。
- **未证实点**：**同源无法证明**（缺 response id），只能证明「同槽、无 alias、形态互补」，不能断言就是同一次调用。
- **状态**：待修（等统一修复窗口）。

### F14 i18n 5 个 key 字典缺失，覆盖率测试未挡住（11-04 新发现，系统巡查）

- **现象**：静态扫描 531 个 key、0 重复、0 占位符不匹配，但有 5 个 `t()` key 在字典里不存在。
- **证据**：
  - [web/app.js L1473](../../../../web/app.js#L1473)：`轮次不可用`、`重新结算后这一轮不在列表里；点击轨迹任意行返回请求态。`
  - [web/session-view.js L571](../../../../web/session-view.js#L571)：`{n} 次失败`
  - [web/rail-facts.js L427](../../../../web/rail-facts.js#L427)：`首个文本`
  - [web/app.js L1178](../../../../web/app.js#L1178)：`req {id}` —— 回退后仍显示 `req 92718`，用户不可见。
  - 门禁漏洞：[tests/i18n-coverage.test.ts L56](../../../../tests/i18n-coverage.test.ts#L56) 对 `t()` 字符串直接 `continue`，从不校验是否为字典成员。
- **影响**：英文模式有 **4 条可见文案回退中文**（第 5 条回退结果恰好不可见）。
- **建议方向**：测试增加两条断言——「`t()` 的 key 必须在 dict」与「占位符集合相等」；把 5 个 key 补进字典。
- **严重度**：P2（可见文案质量）。
- **未证实点**：是否还有未被静态扫描覆盖的动态 key 拼接（本次只覆盖字面量 `t()`）。
- **状态**：待修（等统一修复窗口）；属门禁类，单独一小笔。

### F15 `session_usage` 按 `session` 查询绕不过主键前缀（11-04 新发现，系统巡查）

- **现象**：`session_usage` 的主键以别的列开头，按 `session` 过滤走全表扫描。
- **证据**：[src/queries/session-summary.ts L258](../../../../src/queries/session-summary.ts#L258) `FROM session_usage WHERE session=? ORDER BY agent LIMIT 2`；`EXPLAIN QUERY PLAN` 输出 **`SCAN session_usage`**；当前 140 行，耗时 <0.1 ms。
- **影响**：随 droid 会话数线性变差，是 v11 新表的索引陷阱；当前无感，量起来后会变成 F10 那类读延迟。
- **建议方向**：加 `(session, agent)` 索引，或调整主键顺序使 `session` 成为前缀；改后验收看 `EXPLAIN QUERY PLAN` 变为 `SEARCH ... USING INDEX`。
- **严重度**：P2。
- **未证实点**：droid 会话增长速率与 `session_usage` 行数上限未估算，无法给出触发时间。
- **状态**：待修（等统一修复窗口）；独立小笔。

### F16 并发 hook 被 `busy` 429 拒绝，服务端无重试队列（11-04 新发现，系统巡查）

- **现象**：并发 ingest 冲突时直接 429，服务端没有排队或重试。
- **证据**：`ingest.accepted=1,932`、`rejected_by_reason.busy=23`（3.17 h，约 **1.2%**）；[src/http.ts L303](../../../../src/http.ts#L303) 以单布尔 `ingesting` 做闸门，冲突即 429。
  - **第二轮复核（短窗口）**：`accepted=68`、`busy=10`，其余拒绝原因为 0；短窗口比例更高，说明 busy 与 ingest 并发度直接相关，不是偶发。
- **影响**：约 1.2% 的 hook 请求被拒；是否造成数据缺失取决于客户端重试。
- **建议方向**：改为排队/回压（有界队列），或先确认 hook 客户端的重试策略并在文档写明；不要在未确认前假定「客户端会重试」。
- **严重度**：P2。
- **未证实点**：**是否丢数据未证实**——取决于 hook 客户端是否重试；本次没有客户端侧日志。
- **状态**：待修（等统一修复窗口）；独立小笔。

### F17 状态脚本日志读取失败静默为空（11-04 新发现，系统巡查）

- **现象**：读日志失败时返回空数组，与「日志为空」无法区分。
- **证据**：[scripts/service-support.ts L237-243](../../../../scripts/service-support.ts#L237-L243) `catch { return [] }`；[scripts/service.ts L191](../../../../scripts/service.ts#L191) 直接消费该结果。
- **影响**：日志不存在、无权限、或路径写错时，状态输出看起来像「没有日志」，掩盖真实故障；排查时容易走错方向。
- **建议方向**：返回 `{lines, error}`，或在输出里显式标注 `unreadable`；调用方据此区分「空」与「读失败」。
- **严重度**：P2。
- **未证实点**：无（静态代码事实）；是否有其它调用方依赖当前「空数组」语义未逐一核对。
- **状态**：待修（等统一修复窗口）；独立小笔。

### F18 读 API 可用 `Sec-Fetch-Site` 头绕过读令牌（11-04 新发现，系统巡查）

- **现象**：不带令牌请求 `/api/stats` 得到 401；手工加一个任意可伪造的 `Sec-Fetch-Site: same-origin` 后返回 **200 且带真实数据**（`pending_hooks=1378`、`requests=73313`、`open_gaps=0`）；`/api/sessions?limit=1` 同样 200，并返回 `items` / `next_cursor`。
- **证据**：[src/http.ts L161-162](../../../../src/http.ts#L161-L162) `if (site === 'same-origin') return 'ok';`。
- **重要限定（判级前提）**：
  - [SECURITY.md L10](../../../../SECURITY.md#L10) 明示这是**有意设计**——信任同源浏览器导航；该头并非浏览器强制，curl 或任一本地进程都可伪造。
  - 服务仅监听 `127.0.0.1`；数据库与令牌权限为 `0600`，同用户进程本就可直接读库，因此令牌实际防的是**跨源浏览器**。
  - 所以：按「未鉴权可读 = P0」的口径成立；若威胁模型只覆盖跨源 Web，则应按 **P1** 处理。**这条取舍必须由下一个人显式判定，不要只按标题的 P0 直接开工。**
- **影响**：本机任意进程（含非浏览器）可无令牌读取统计与会话列表；跨源浏览器仍被挡住。
- **建议方向**：把同源信任收紧到真导航（同时要求 `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`），或对 `/api/` 的同源请求仍要求令牌。
- **严重度**：P0（按「未鉴权可读」口径；威胁模型仅覆盖跨源 Web 时降为 P1）。
- **未证实点**：未测其他读端点是否同样可绕（只测了 stats 与 sessions）；未做写入侧验证（写接口是否也吃这个头）。
- **状态**：待修（等统一修复窗口）；**威胁模型判定前不动手**。

### F19 日志落绝对路径且权限 0644，文档写 0600（11-04 新发现，系统巡查）

- **现象**：stderr 日志含源码绝对路径与栈帧，且日志文件是组内可读的 `0644`，与文档承诺的 `0600` 不符。
- **证据**：
  - `$HOME/Library/Logs/agent-trace-collector.err.log` 有 **52 处** `<home>/...` 形式的绝对路径与源码栈（示例三行为 `migrate` / `openStore` / `startCollector` 的栈帧）；权限 `-rw-r--r--`。
  - `tracery.log` 429,920 B、`tracery.err.log` 945 B，同为 `0644`；家目录 `drwxr-xr--`，`staff` 组可读。
  - 文档漂移：[docs/operations.md L7](../../../../docs/operations.md#L7) 称「目录 0700，数据库、WAL、日志与令牌都是 0600」；数据库与令牌确为 0600，**日志不是**。
  - 结构化日志本身干净：`tracery.log` 内 `<home>` 形式、`/home` 开头的路径、`Bearer`、`read.token` 命中均为 **0**；`monitor.log` 同。
- **影响**：同组用户可读日志；日志里暴露目录结构与源码栈；文档与实际权限不符。
- **建议方向**：启动/轮转时对日志 `chmod 0600`；清理废弃标签的旧日志；文档与实现对齐。
- **严重度**：P1（隐私/权限，非数据正确性）。
- **未证实点**：旧日志无时间戳，只能以 mtime（11-04 03:34）定位，无法确认每条栈是哪次启动写的。
- **状态**：待修（等统一修复窗口）；独立小笔，**需先决定旧日志是否删除**。

### F20 畸形百分号编码兜成 500（11-04 新发现，系统巡查）

- **现象**：`GET /api/sessions/a%zz/requests` 返回 HTTP **500** `{"error":"internal_error"}`，而不是 400。
- **证据**：[src/http.ts L554](../../../../src/http.ts#L554) 的 `decodeURIComponent` 在 `try` 内，`URIError` 被 [L685](../../../../src/http.ts#L685) 统一兜成 500。
- **影响**：客户端错误被映射成服务端错误；不泄露内部信息，但会污染 5xx 指标与告警。
- **建议方向**：`decodeURIComponent` 失败单独映射 **400**，不要进入统一 500 分支。
- **严重度**：P2。
- **未证实点**：其他路由参数是否也走同一段 `decodeURIComponent`（本次只测了 sessions 路径参数）。
- **状态**：待修（等统一修复窗口）；归入「HTTP 契约小修」。

### F21 `writer_failed` 回传内部错误文本（11-04 新发现，系统巡查，未触发）

- **现象**：写入失败时响应体直接带 `error.message`，可能含表/列名。
- **证据**：[src/http.ts L357-358](../../../../src/http.ts#L357-L358) 与 [L472-473](../../../../src/http.ts#L472-L473) 直接 `json({ error:'writer_failed', code }, 503)`，其中 `code = error.message`。当前 `rejected_by_reason` 中 `writer_failed=0`，**未触发**。
- **影响**：一旦触发，`UNIQUE constraint failed: 表.列` 这类内部结构会进响应体。
- **建议方向**：响应只给固定枚举码，原文只进结构化日志。
- **严重度**：P2。
- **未证实点**：无触发样本，未验证实际响应形状；是否有其他路径同样回传 `error.message` 未全查。
- **状态**：待修（等统一修复窗口）；归入「HTTP 契约小修」。

### F22 单行/单块无大小上限（11-04 新发现，系统巡查）

- **现象**：block 表存在 12.6 MB 的单块，没有入库上限。
- **证据**：`SELECT COUNT(*),SUM(LENGTH(z)=0),MAX(LENGTH(z)),SUM(LENGTH(z)>1048576) FROM block` → **129,315 / 0 / 12,630,905 / 17**；单行最长 **12.6 MB**，0 字节块为 0，超过 1 MiB 的块有 **17** 个。
- **影响**：阅读按字节分页，这一行必然跨页截断；派生与渲染可能退化。
- **第三轮补测（渲染）**：最大块的 `raw_size` 是 **16,847,583 B**（压缩后 12,630,905 B），归属于请求 95,914、`ord=0`；`GET /api/requests/95914/body?from=0&to=1` 返回 **16,849,074 B / 0.133 s**，整块一次下发。前端 `mdToHtml` 在 16.8 MB 合成输入上的实测：单行 **11–52 ms**、RSS 增量 **16–54 MB**（三次样本），未见非线性退化；浏览器端真实渲染与派生耗时**仍未实测**。
- **建议方向**：单列观察，不急着加上限；先实测详情页渲染与派生耗时是否受影响，再决定是限流、分块还是保持现状。
- **严重度**：P2（观察项）。
- **未证实点**：12.6 MB 压缩块（16.85 MB 原文）在浏览器详情页的实际渲染未测；派生阶段是否因该块变慢也未测；是否属于合法的大请求未确认。
- **状态**：待补观测（渲染已有合成上限数据，浏览器与派生仍缺）；**单列观察，不动代码**。

### F23 派生同步失败无 attempts/last_error、无重试上限（11-04 新发现，系统巡查）

- **现象**：永久失败的派生组会每 2 秒重试一次，队列里看不出失败原因。
- **证据**：
  - `derive_queue` clean 1,423 组、dirty 9 组，`attempts≠0 = 0`、`last_error` 全空。
  - [src/main.ts L302-307](../../../../src/main.ts#L302-L307) 的 `finally` 无条件 `setTimeout(trackedDeriveTick, nextDueMs)`。
  - [src/derive/state.ts L182-186](../../../../src/derive/state.ts#L182-L186) 的 `claimGroupTx` 不写 `attempts` / `last_error`（只有分片路径的 generation 写）。
- **影响**：永久失败组每 2 秒重试、无上限，队列看不出失败原因；不是静默停止（`derive.run` 有 60 s 节流的 `diagnostics.error`）。
- **建议方向**：归入派生可观测性——`claimGroupTx` 记录 `attempts` / `last_error`，并加指数退避或上限；先定「永久失败」的判据再改。
- **严重度**：P2。
- **未证实点**：**没有可复现的永久失败组可供验证**；本次只能从代码与全空字段推断。
- **状态**：待修（等统一修复窗口）；归入派生可观测性。

### F24 `body_bytes` 在 merge 路径漏写，`maintain purge` 低估可回收量（11-04 新发现，系统巡查）

- **现象**：`body_state='available'` 的行里，`body_bytes` 大量为 NULL。
- **证据**：
  - `body_state='available' AND body_bytes IS NULL` = **29,347 行**，全部 `via='through'`、`redact_version=NULL`。
  - [src/merge.ts L89-109](../../../../src/merge.ts#L89-L109) 的 SELECT/UPDATE 只搬 `skeleton_z` / `body_state` / …，**不含 `body_bytes`**。
  - [src/maintenance/purge.ts L52](../../../../src/maintenance/purge.ts#L52) 用 `IFNULL(body_bytes,0)` 计字节。
- **影响**：全局 body 预算按块计不受影响，仅 `maintain purge` 低估可回收量。
- **建议方向**：归入 `maintain purge` 估算修正——merge 时一并写 `body_bytes`，或 purge 用块表反算；改完用「可回收字节 vs 实际释放」对照验收。
- **严重度**：P2。
- **未证实点**：29,347 行是否全部由 merge 路径产生（本次按 `via='through'` + `redact_version=NULL` 归因，未逐行回溯）；purge 低估的绝对字节数未量化。
- **状态**：待修（等统一修复窗口）。

### F25 会话合并弱规则：同 conv+agent ±60 s 唯一候选即并，不校验模型（11-04 新发现，系统巡查，第三轮）

- **现象**：session 侧的调用若没有 response id、也没有 turn ref，会落到「同 conv + 同 agent、±60 秒、唯一候选」的弱规则上；模型名不同不阻止合并。
- **证据**：
  - [src/owner.ts L151-158](../../../../src/owner.ts#L151-L158) 的时间窗是 `startedMs ± 60_000`；[L171-185](../../../../src/owner.ts#L171-L185) 先看同模型候选，**没有同模型候选时唯一候选仍然合并**（注释写明「模型名不同不是拒绝理由」）；[L206-209](../../../../src/owner.ts#L206-L209) 在该规则之前没有更强证据就落到它。
  - [src/sources/session/ingest.ts L230-243](../../../../src/sources/session/ingest.ts#L230-L243) 直接把 `owner.rule`（缺省 `MATCH_AMBIGUOUS`）交给 `mergeIntoOwnerTx`，没有额外校验。
  - 生产 `request_evidence.match_rule='conv_time_model.v1'` 共 **5 行**：`codex_session_call` 2、`zcode_session_call` 2、`ledger` 1。
  - 其中 2 条 codex 命中属于同一请求的「双表示」：请求 93,483 / 93,701 各有 **2 条** `codex_session_call` 证据，一条带 `resp_...`，另一条是 `turnRef/offset`；没有观察到跨会话错并（hook/ledger 证据跨 >1 个 session 的目标 = **0**）。
- **影响**：同一 conv+agent 的 60 秒窗口内若有两次调用、其中一次缺强标识，弱规则可能把两次并成一条，usage/turn 归到错误请求；当前 5 例均未证实错并，但规则本身没有模型或用量交集作为第二道闸。
- **严重度**：P2（潜在内容正确性；已实际命中，未证实错并）。
- **建议方向**：弱规则加一条硬约束（模型归一后相等，或 usage 至少一段有交集）；`match_rule` 继续保留，便于事后审计。
- **未证实点**：`request_alias` 不保留旧行快照，无法从 alias 反推「两次调用」是否真的不同；客户端没有调用 id 日志可对照。

### F26 身份字段只 `COALESCE`，不按来源优先级提升（11-04 新发现，系统巡查，第三轮）

- **现象**：请求合并时，目标行已有的 `conv_key` / `session` / `conv_source` 不会被更强的来源覆盖，只有 NULL 才补。
- **证据**：
  - [src/merge.ts L117-136](../../../../src/merge.ts#L117-L136) 的 `fillIdentity` 分支全部是 `COALESCE(目标, 源)`；hook 阶段分支 [L140-146](../../../../src/merge.ts#L140-L146) 同样只补空。
  - [src/sources/session/ingest.ts L145](../../../../src/sources/session/ingest.ts#L145) 的 `mergeIntoOwnerTx` 也把 `conv_key=COALESCE(conv_key,?)`。
  - 当前库：`request_alias` **42,093** 行，目标落在 `["session",…]` 的 **38,492**、落在 conv 桶的 **3,601**；**0** 个目标同时「有 session 且仍是 conv/request/hook 弱键」；`have & HAVE_SESSION` 的弱键行 = **0**；同一 session 多 `conv_key` = **0**。
- **影响**：如果上游先落账本/路由（弱键），后到的 session 证据只把 `session` 补上、`conv_key` 仍是弱键，同一会话可能被拆成两个派生组；当前数据未出现该形态，属于潜在拆分。
- **严重度**：P3（代码不变量缺口，未观测到实例）。
- **建议方向**：把身份补写改成显式优先级（`session` > `conv` > `request`/`hook`/`conv-digest`），或在合并后按完整证据重算 `conv_key`；先加不变量测试。
- **未证实点**：弱键行如果从来没有匹配到 session 证据（例如账本/路由本身不带 session），无法判断是「拆分」还是「本来就只有 conv 身份」。

### F27 `normalize-response-ids` 裸 UPDATE 可能制造重复键（11-04 新发现，系统巡查，第三轮）

- **现象**：把历史 `response_id_norm` 重写成规范化值时，直接 UPDATE，不检查改写后是否与另一行冲突，也不触发合并。
- **证据**：
  - [src/maintenance/response-ids.ts L97-106](../../../../src/maintenance/response-ids.ts#L97-L106)：`UPDATE ${table} SET response_id_norm=? WHERE response_id_norm=?`，逐组执行，没有唯一性检查或 `mergeRequestTx`。
  - [src/owner.ts L60-68](../../../../src/owner.ts#L60-L68)：`byResponseId` 查到 >1 行时返回 `ambiguous`，不会自动合并。
  - 当前库 `response_id_norm` 重复组 = **0**，说明尚未触发。
- **影响**：若两行原本只差一个已知前缀（例如 `resp_` 与裸 id），规范化后会变成同一个键；此后 `byResponseId` 变成 ambiguous，两边都不再被自动合并，重复请求长期留在库里。
- **严重度**：P3（未触发，但修复动作本身可能引入重复）。
- **建议方向**：规范化前先按目标值分组，冲突组走合并而不是裸 UPDATE；改完用「重复键 = 0」验收。
- **未证实点**：没有历史样本证明真的存在只差前缀的两行；当前 0 重复也可能只是尚未跑到这类数据。

### F28 `session_` 前缀只对 UUID 归一，`session_`+32 hex 保持原前缀（11-04 新发现，系统巡查，第三轮）

- **现象**：`canonicalSessionId` 只剥掉「后面能对上 UUID」的 `session_` / `sess_` 前缀；不是 UUID 的 id 原样保留。
- **证据**：
  - [src/evidence.ts L25-36](../../../../src/evidence.ts#L25-L36)：前缀循环里先 `UUID_RE.test(...)`，不匹配就返回原值。
  - 当前库 `session GLOB 'session_*' AND LENGTH(session)=40`（`session_` + 32 hex）有 **4,726 行**；裸 32 hex（`LENGTH(session)=32`）为 **0**；同一 session 多 `conv_key` = **0**。
- **影响**：如果另一个上游对同一会话写裸 32 hex，而本地写 `session_`+32 hex，两者会被归成两个 key（`["session","session_…"]` 与 `["session","…"]`），派生、统计和阅读都会拆成两个会话。当前没有裸对照，所以未发生。
- **严重度**：P3（潜在拆分，当前 0 实例）。
- **建议方向**：按来源维护显式 canonical 规则（例如 codex/droid 的 32 hex 也剥前缀），或至少把「前缀族 + 原值」记进证据，避免只靠 UUID 形状判断。
- **未证实点**：未找到上游同时写两种形态的样本；4,726 行里有多少来自同一会话的另一种写法无法判断。

### F29 前端 `moreTargets` 超过 500 全表清空，旧 `+N` 弹层静默失效（11-04 新发现，系统巡查，第三轮）

- **现象**：渲染工具步骤时，`+N` 目标清单存在一张全局 Map；累计超过 500 条就把整张表清空，但页面上的旧 chip 不会重绘。
- **证据**：
  - [web/app.js L894-900](../../../../web/app.js#L894-L900)：`if (moreTargets.size > 500) moreTargets.clear();`，随后只写入当前行的条目。
  - [web/app.js L2545-2547](../../../../web/app.js#L2545-L2547)：`showMore` 取不到 key 就直接 `return`，不报错、不降级。
  - 最长会话（`679ab0be…`）有 **4,433** 条请求、`SUM(msg_count)` **564,736**；首屏 100 条 `/api/sessions/.../requests?limit=100` 返回 **106,750 B / 5.9 ms**，翻页累积很容易越过 500。
- **影响**：长会话翻到后面时，前面已经渲染的 `+N` chip 仍可见，但悬停/点击不再弹出清单；用户会以为「没有更多目标」，属于静默功能失效。Map 也不按会话清理，跨会话浏览会加速触顶。
- **严重度**：P2（交互静默失效，数据本身不丢）。
- **建议方向**：改成有界 LRU（保留最近 500）或只清理不可见行；会话切换时重置；补一个 600 条目标的 DOM 测试。
- **未证实点**：未在浏览器里用真实最长会话复现；「首屏 + 翻多少页触顶」依赖真实 tool 步骤数，未逐页统计。

### F30 备份「恢复成功」不等于「可服务」：白名单只有版本号测试，无迁移 smoke check（11-04 新发现，系统巡查，第三轮）

- **现象**：`restoreBundle` 只校验 manifest、哈希、完整性、盐绑定和包内 `user_version`；不验证恢复后的库能被当前代码 `openStore` 打开。白名单 6–12 的测试也不是真旧 schema。
- **证据**：
  - [src/maintenance/backup.ts L152](../../../../src/maintenance/backup.ts#L152) 白名单 `[6,7,8,9,10,11,12]`；[L356-385](../../../../src/maintenance/backup.ts#L356-L385) 的恢复校验止于 `manifest.schema` 与包内 `user_version` 相等，没有 `openStore` / 迁移 / 关键表计数。
  - [tests/maintenance.test.ts L656-700](../../../../tests/maintenance.test.ts#L656-L700)：测试标题写「v8/v7/v6」，实际只构造了 v7 与 v6；做法是 `PRAGMA user_version=7/6` 改当前 v12 全表结构（[L674-675](../../../../tests/maintenance.test.ts#L674-L675)、[L688-689](../../../../tests/maintenance.test.ts#L688-L689)），不是真正的旧 schema；v8/v9/v10/v11 没有单独用例。
  - 当前 v12 的「备份 → 恢复 → `openStore` → 盐绑定」路径由 [L661-671](../../../../tests/maintenance.test.ts#L661-L671) 证明可用。
- **影响**：对一个真正的旧库，`restore` 返回 `ok` 只代表文件复制与版本声明一致；首次启动迁移失败会发生在恢复之后，运维看到的是「恢复成功、服务起不来」。白名单把 v6–v12 都列为可恢复，但没有真实旧库样本支撑。
- **严重度**：P2（可验证性缺口，当前生产 v12 路径正常）。
- **建议方向**：`restoreBundle` 末尾加一次只读 smoke：`openStore`（或只跑迁移）+ `user_version` 断言 + 关键表计数；测试用真正的旧 schema fixture，至少覆盖 6/8/10/11 各一份。
- **未证实点**：未拿真实旧库包测试（本轮边界不允许复制生产库/盐到临时目录）；迁移代码是纯新增，理论上可升，但未实证。

### F31 备份注释三处口径矛盾；DB-only `backup` 无白名单/无盐（11-04 新发现，系统巡查，第三轮）

- **现象**：同一个 `RESTORABLE_SCHEMA_VERSIONS` 上方连续三条注释互相矛盾；另一条 `maintain backup` 路径产出的是不可恢复的 DB-only 副本。
- **证据**：
  - [src/maintenance/backup.ts L150-152](../../../../src/maintenance/backup.ts#L150-L152)：第一条写「只有当前版本」，第二条写「v6～v10」，常量实际是 `[6..12]`。
  - [src/maintenance/backup.ts L91](../../../../src/maintenance/backup.ts#L91) `backupDatabase` 不做白名单检查；[src/maintenance/cli.ts L117-119](../../../../src/maintenance/cli.ts#L117-L119) 输出 `ok:true` 同时带 `ingestion_restorable:false`。
- **影响**：只读 `ok` 字段的自动化会把 DB-only 副本当成恢复点；读注释的人会以为只支持到 v10。两条都不是数据损坏，但会让恢复演练判断错。
- **严重度**：P3（文档/契约口径）。
- **建议方向**：合并成一条权威注释；把字段改成 `usable_for_restore` 或让 DB-only 命令在 `ok:false` 下返回，避免只读 `ok` 的消费者误判；与 F30 同批评审。
- **未证实点**：没有外部自动化消费这两个字段的实际样本。

## 前提更正

早前笔记写的备份门槛「`1.1×` + 64 MiB」与代码不符：实际门槛是 **`1.1×`（DB 备份）** 与 **`1.1×` + 4,096 B（bundle）**，见 [src/maintenance/backup.ts L116](../../../../src/maintenance/backup.ts#L116) 与 [L270](../../../../src/maintenance/backup.ts#L270)；单位是**字节**，不是 MiB。本条只在新篇记录，**不改 11-03 归档篇与 F23 设计笔记的正文**。

- **schema 版本更正**：当前 `user_version` 是 **12**（不是 11）；文档里的 `v6–12` 可恢复白名单与代码一致。**F18–F24 成文时的 schema 版本即 12**，前文凡写「v11 新表」处应按「v12 已存在的表」理解（表本身由 v11 建，当前库版本是 12）。

## 测试空隙

本轮巡查确认以下覆盖缺口，均与上面的条目直接相关：

1. `markHookAbsent` 缺「`HAVE_BODY` 已置但 `skeleton_z` 为 NULL」这一组合（F09 的成因）：[tests/hook.test.ts L363](../../../../tests/hook.test.ts#L363) 种子固定 `have=2`；[L476](../../../../tests/hook.test.ts#L476) 的 `have=3` 是正文已落库之后；其余 8 类组合已覆盖。
2. `pruneRaw` 的 `PRUNE_BATCH=100` 与「多轮排空」从未被触发：[tests/retention.test.ts L375](../../../../tests/retention.test.ts#L375) / [L421](../../../../tests/retention.test.ts#L421) / [L459](../../../../tests/retention.test.ts#L459) 每个用例只有 1 行。
3. `raw_session_event` 的 prune 既无代码分支也无测试（对应 F12）。
4. 弱断言两处：[tests/retention.test.ts L234](../../../../tests/retention.test.ts#L234)、[tests/facts.test.ts L193](../../../../tests/facts.test.ts#L193) 只 `not.toThrow()`。
5. 全仓无 `.skip` / `.todo` / `.only`（用文本扫描确认）。
6. 备份恢复的白名单测试是「改版本号」而非真旧 schema：[tests/maintenance.test.ts L674-675](../../../../tests/maintenance.test.ts#L674-L675) / [L688-689](../../../../tests/maintenance.test.ts#L688-L689) 只 `PRAGMA user_version=7/6`，结构仍是 v12；v8/9/10/11 无用例（对应 F30）。
7. 前端 `+N` 无大数据量 DOM 测试：全仓没有超过 500 个 `moreTargets` 目标的用例，`clear()` 与 `showMore` 静默返回都只能在真实最长会话（4,433 请求）里触发（对应 F29）。

## 本轮判为正常（巡查结论）

以下各项本轮**未判为缺陷**，只留一句证据，防止下一轮重新翻查：

- 派生队列 **1,336 组全 clean**：`input_revision = published_revision`、`attempts=0`、`last_error=0`；活跃会话最大落后 160 revision，约 2 分钟追平。
- v11 迁移为纯 `CREATE TABLE / INDEX IF NOT EXISTS`，无 `ALTER`、无回填；`raw_droid_event.session_id` **49,204 行全非 NULL**。
- `web/` **39 个文件**与 `STATIC_FILES` **39 条**互覆盖，无直连 `fetch`。
- body 计量 **1.733 GB / 10 GB** 预算，未接近上限。
- `auto_vacuum=2` 与 `incremental_vacuum(256)` 生效。
- 备份与 WAL 正常（备份产物存在、WAL 未见异常增长）。

第二轮补充（与 F18–F24 同批巡查）：

- 路径穿越 **6 种变体**（`/../src/config.ts`、`/%2e%2e/...`、`%5c`、`%00`、`//etc/passwd` 等）全部 **404**；[src/http.ts L245](../../../../src/http.ts#L245) 精确查 `STATIC_FILES`，不做路径拼接。
- 读令牌比较为 **sha256 + `timingSafeEqual`**（[src/http.ts L129-134](../../../../src/http.ts#L129-L134)），不是普通字符串比较。
- 500 响应体仅 `{"error":"internal_error"}`，不带栈、SQL、路径。
- 请求体上限 **64 MiB**，且先解析后落库（[src/http.ts L309-331](../../../../src/http.ts#L309-L331)，本轮仅代码核验，未实测大包）。
- 无新增 `database is locked` 路径：`tracery.log` 中该串 **0** 次、`"kind":"error"` **0** 次，WAL 维持 **1.4–2.5 MB**。
- 无孤儿引用：`request_block` dangling req **0**、dangling block **0**、孤儿 block **0**。
- 畸形字段现状：`started_ms` 为 0 / 负 / 未来 = **0**；`conv_key` 最长 **77** 字符、>1k = **0**；0 字节 block = **0**。

第三轮补充（内容正确性 / 备份 / 前端）：

- 身份与 alias 一致：`request_alias` **42,093** 行，target 缺失 **0**、旧行残留 **0**、链式 alias **0**；`conv_key LIKE '["session"'` 与 `session` 不匹配 **0**；同一 session 多 key **0**；重复 `response_id_norm` **0**；重复 evidence ref **0**。
- 未观察到跨会话错并：hook/ledger 证据跨 >1 个 session 的目标 **0**；2 条 codex 弱规则命中是同一请求的双表示，未丢调用。
- 备份 v12 主路径正常：真实 `bundle → restore → openStore → 盐绑定` 由 [tests/maintenance.test.ts L661-671](../../../../tests/maintenance.test.ts#L661-L671) 覆盖；当前生产 `user_version=12`。
- 白名单外行为明确：v5 bundle 备份 `backup_schema_unsupported`、恢复 `restore_bundle_invalid`；v5 库首开 `schema_rebuild_required`，v13 `schema_version_unsupported`；`auto_vacuum=INCREMENTAL` 自初始提交 `f15b2ce` 即存在，推论 v6+ 库都满足首开检查。
- 备份与 `event_loop_max` **无因果证据**：仓库无自动备份任务，`backupBundle/backupDatabase` 都要求服务停写；`monitor/samples` 只从 11-03 开始，11-01 22:35 那次手工 `.backup` 不在样本内。最多只能算 IO 争用，不能算出服务内事件循环长尾，**证据不足，只登记不定性**。
- 前端极端数据主路径正常：最长会话 `/summary` **52,207 B / 226.8 ms**，数组最大 `paths` 180、`read_paths` 162、`failures` 80（均未触 1000/200 上限）；`requests?limit=100` **106,750 B / 5.9 ms**；`/turns` **1,036 B / 238.3 ms**（与 F10/F15 同源，不另立条目）。

## Proposal

按「先补证据、再动写窗口、最后做结构性性能与可验证性」排序。F03/F04/F05/F08 与 F13/F16/F18/F22 的取证都是只读工作，可与任何写窗口并行。**F09 是唯一涉及历史数据重判的写操作，单列在性能波之前。** 第二轮条目按性质归口：F19 并入 F11+F12 的保留/隐私批，F20/F21 合为「HTTP 契约小修」，F23 归派生可观测性，F24 归 `maintain purge` 估算修正，F22 只观察。第三轮：F25+F26+F27+F28 归「身份/合并不变量」，F29 是前端独立小笔，F30+F31 是备份可验证性与口径。

### 修复顺序

**第 0 波（只读取证，可并行）**

1. **F05（P0，`turn_ref`）**：按 agent × 日桶统计非空覆盖，抽样确认 `mapping.turnRef` 的写入条件，给出「存量是否需要回填」的结论。**不先定性就做 `turn_ref` 验收会得到假阴性。**
2. **F04（P1，活跃会话）**：读 `src/queries` 与活跃区实现及测试，逐条确认四点偏离是否仍成立（注意 `49ac7bf` 的活跃区改动可能已覆盖部分）。
3. **F03（P2，`storage=null`）**：再找消费端证据；找不到就明确关闭为观察项，不为凑数改代码。
4. **F08（P2，预检）**：先出只读预检方案（命令、退出码、输出三态），不动迁移代码。
5. **F13（P2，同槽重复）**：只读统计 170 行里有多少会改变 `request_count` 的可见值；**同源未证实前不改 ingest 去重逻辑**。
6. **F16（P2，busy 429）**：先确认 hook 客户端是否重试（服务端没有客户端日志）；未确认前不能判定「无数据损失」。
7. **F18（P0/P1，读令牌绕过）**：先判定威胁模型——是否只覆盖跨源浏览器。判定前**不动鉴权代码**；若覆盖本机进程则按 P0，若只覆盖跨源 Web 则降 P1 并记录理由。
8. **F22（P2，大块）**：渲染已补测（16.85 MB body 0.133 s、合成 `mdToHtml` 11–52 ms），**派生耗时仍未测**；**单列观察，不动代码**。

**数据修复（单列，先于性能波）**

9. **F09（P1，1,386 条 pending）**：独立迁移脚本 + `markHookAbsent` 门禁分支；先只读计数确认范围，再在写窗口执行；**单独一笔提交**，不与性能改动混在一起。

**第 1 波（写窗口，先预估再执行）**

10. **F06（P0，unknown-actor 进派生）**：先统计 `["request",…]` 前缀组数（11-03 快照 414 个）与回填耗时，再决定「进队列」还是「一次性归并/回填」；同批补读侧原始列回退与多 actor / unknown-actor 用例。必须在允许写操作的窗口做，并先预估队列基数。

**第 2 波（性能结构性，独立批次）**

11. **F07（P1，长派生）**：**A 先做**（组内一次性预取）；**F07-a（`derive.compute` / `derive.result` 日志补 `conv_key`）与 A 同批、单独提交**；**B 单独评审**（改「可读」语义，需提升算法号）；**C 作长尾护栏并行**；**D 归增量议程，不与 A 同批**。不要把 A 当根治——A 只压单轮成本约 30%，不降 35–39% 占空。验收用 F07 条目里的副本分段计时口径（热 6,200 / 冷 9,057，先跑一次再取值），不要用生产单轮时长当唯一判据。
12. **F10（P1，summary/turns 延迟）**：先做 handler 内分段插桩（连接/事务等待、查询、`JSON.stringify`、flush），再定修法；与 F07 同属读接口，但**不合并成一笔**——F07 动物化路径，F10 查 HTTP/IO 层那 0.32–0.52 s。
13. **F23（P2，派生可观测性）**：`claimGroupTx` 记录 `attempts` / `last_error`，并加指数退避或上限；先定「永久失败」判据，与 F07 同层但**独立小笔**。

**第 2.5 波（身份/合并不变量，写窗口）**

14. **F25 + F26（P2/P3，身份与合并同批）**：先补「同 conv+agent 60 s 内两次调用、一条缺强标识」的正反例测试；弱规则加模型/用量闸门，身份补写改为显式优先级。两条同批评审，但**各一笔提交**。当前 5 条弱合并与 0 条拆分实例作为回归基线。
15. **F27（P3，响应 id 规范化）**：先扫全库重复 `response_id_norm`，再把冲突组改为「合并」而不是裸 UPDATE；改完用重复键 = 0 验收。
16. **F28（P3，会话前缀归一）**：确认上游是否会写裸 32 hex；若会，补显式 canonical 规则；若不会，只加注释与测试锁定现状。

**第 3 波（保留/隐私、契约与门禁，独立小笔）**

17. **F11 + F12 + F19（P2，保留/隐私层同批）**：TTL 改为「循环到空」或按字节预算，把 `raw_droid_event` / `raw_session_event` 纳入 TTL 或明确声明长期归档并计入容量预算；F19 对日志 `chmod 0600`、文档与实现对齐，**旧日志删除与否要先决定**，并作为本批内的独立小笔。
18. **F14（P2，i18n 门禁）**：补 5 个 key，测试加两条断言（`t()` key 必须在 dict、占位符集合相等）。
19. **F15（P2）**：加 `(session, agent)` 索引或调整主键顺序，验收看 `EXPLAIN QUERY PLAN` 从 `SCAN` 变为 `SEARCH ... USING INDEX`。
20. **F17（P2）**：日志读取失败返回 `{lines, error}`，或输出显式标注 `unreadable`。
21. **F20 + F21（P2，HTTP 契约小修）**：`decodeURIComponent` 失败映射 400；`writer_failed` 响应只给固定枚举码，原文只进结构化日志。两条同批、各一笔。
22. **F24（P2，`maintain purge` 估算修正）**：merge 时一并写 `body_bytes`，或 purge 用块表反算；验收用「可回收字节 vs 实际释放」对照。

**第 4 波（前端与备份可验证性，独立小笔）**

23. **F29（P2，前端 `+N`）**：把 `moreTargets` 改成有界 LRU 或按可见行清理，会话切换重置；补 600 条目标的 DOM 测试，并在最长会话（4,433 请求）复现一次。
24. **F30（P2，备份 smoke）**：`restoreBundle` 末尾加只读 `openStore` + `user_version` + 关键表计数；测试补真正的 v6/8/10/11 旧 schema 样本，不再只改版本号。
25. **F31（P3，备份口径）**：合并三处矛盾注释；DB-only 输出改用 `usable_for_restore` 或 `ok:false`；与 F30 同批评审。

**第 5 波（排查型）**

26. **F01（P2，hook 缺失）**：排查 claude 侧 hook 安装与 `response_id` 回传；与 F06 的孤儿队列同一排查线。
27. **F02（P1，探针尖峰）**：给探针加分段计时；用 F07-a 的组标识把长派生轮次与 17:20–17:24 的停顿窗口对齐。

### 依赖图（文字版）

```
F09（1,386 条 pending 重判）→ 独立迁移脚本 + markHookAbsent 分支；先于性能波，不与性能改动同笔
F10（summary/turns 延迟）与 F07 同属读接口，但先分段插桩，不合并成一笔
F11 + F12 + F19 同批（保留/隐私层）；F19 为本批内独立小笔，先决定旧日志是否删除
F14 门禁独立；F15 / F17 各自独立小笔
F20 + F21 合并为「HTTP 契约小修」，两条同批、各一笔
F22 单列观察，先测渲染与派生耗时，不设上限之前不动代码
F23 归派生可观测性，与 F07 同层但独立小笔；先定「永久失败」判据
F24 归 maintain purge 估算修正，独立小笔
F18（读令牌绕过）→ 先判威胁模型；判定前不动鉴权，P0 与 P1 的取舍写进条目
F25 + F26 同批（身份/合并不变量）；F25 先补正反例，F26 只看代码不变量，各一笔
F27 独立小笔（写窗口）；与 F25/F26 同属身份层，但不合并
F28 独立小笔；先确认上游是否写裸 32 hex，未确认只锁现状
F29 前端独立小笔，不依赖后端；先用最长会话复现 500 触顶
F30 + F31 同批评审：F30 加 restore smoke，F31 改注释与 DB-only 口径；不涉生产数据
F13（同槽重复）要等 response id 证据补齐才能断言同源；未确认前不改 ingest
F16 要等客户端重试策略确认；未确认前不假定无数据损失
F06（unknown-actor 进派生）→ 存量 ["request" 卡数据层收敛（展示已由 tool_event 折叠兜住）
F07-A（组内预取）→ F07-C（分片护栏）；F07-D（真增量）独立议程；F07-a（日志补 conv_key）与 A 同批、单独提交
F05（turn_ref）独立只读；F04 / F03 / F08 独立只读，不阻塞任何写窗口
F02（探针尖峰）与 F01（hook 缺失）只在排查层关联，互不阻塞
```

## Acceptance criteria

- **F01**：claude 侧 hook 与 `response_id` 回传的排查有明确结论（安装缺失 / 关联失败 / 上游未给）；`hook_absent_marked` 的每日增量能从结构化诊断读数，而不是只靠 stderr 行数。
- **F02**：探针有分段计时，能指出 5,066 ms 里各端点各占多少；7.8–10.8 s 的停顿能定位到具体轮次（借助 F07-a 的 `conv_key`）。
- **F03**：要么给出一个真实把 `storage=null` 当 0 的消费端证据，要么明确关闭为观察项。
- **F04**：四点偏离逐条落成「已覆盖 / 仍成立 / 无法复现」，并对应到实现与测试行号。
- **F05**：按 agent 的 `turn_ref` 覆盖表给出，明确「存量是否回填」；回填若需要，验收看 `turn_ref` 非空计数从当前基线增长且不复位。
- **F06**：`["request"` 前缀的 414 个 key 有派生组（或读侧有原始列回退且标题非空）；同族 136 张 `source:web_search` 卡的数据层不再以 `participate/main` 参与；补齐多 actor / unknown-actor 用例。
- **F07**：同一组副本 compute 由热 **6,200 ms** 降到 **≤4,500 ms**（冷值单独记：当前 **9,057 ms**）；blob 搬运量 **2,501 MB → ≤100 MB**；分段合计仍覆盖真实调用 ≥90%；`GET /api/sessions?limit=50` 与 `event_loop.p99` 不退化。日志侧能看到带 `conv_key` 的 `derive.compute` / `derive.result`（F07-a）。
- **F08**：`verify-cutover` 对一份旧 `user_version` 副本只读运行，输出三态之一并以非零退出码拒绝不可迁移的情形；不写库。
- **F09**：1,386 条重判为 `partial` 且保留原 `miss_reason`；全库「`pending` + 有正文证据 + 无 skeleton」计数降为 **0**；`markHookAbsent` 新增分支有测试覆盖（有 body 证据但无 skeleton → `partial`）。
- **F10**：handler 分段插桩能解释 HTTP 层多出的 0.32–0.52 s；`/summary` p50 降到 **≤300 ms**（或给出根因与明确上限），`/turns` 同比例下降，其余接口不退化。
- **F11**：hook / ledger / route / otlp span 的超期计数归零；连续 24 h 无超期积累。
- **F12**：`raw_droid_event` 的行数与字节要么纳入 TTL 并归零，要么明确声明长期归档且计入容量预算；两种都要在注释与 `measureBodyBytes` 口径里可见。
- **F13**：给出 170 行对 `request_count` 的可见影响清单；没有同源证据就保持观察，不改 ingest。
- **F14**：5 个 key 进字典；覆盖率测试对「`t()` key 不在 dict」与「占位符集合不等」失败。
- **F15**：`EXPLAIN QUERY PLAN` 从 `SCAN session_usage` 变为 `SEARCH ... USING INDEX`。
- **F16**：给出客户端重试与否的结论；若需服务端排队，`rejected_by_reason.busy` 降到 0 或进入有界队列。
- **F17**：日志不可读时输出 `unreadable`（或 `{lines, error}`），与「日志为空」可区分。
- **F18**：威胁模型有明确书面判定（覆盖本机进程 → P0；仅跨源 Web → P1）；判定为 P0 时，不带令牌的 `/api/stats` 与 `/api/sessions` 在伪造 `Sec-Fetch-Site` 下也返回 401，真导航不受影响；判定为 P1 时，条目降级并保留理由与残余风险。
- **F19**：日志文件权限为 **0600**；`docs/operations.md` 与实现一致；旧日志的去留有明确决定并执行；结构化日志仍无绝对路径（回归扫描 0 命中）。
- **F20**：`GET /api/sessions/a%zz/requests` 返回 **400**（或明确的 4xx 契约），不再计入 5xx；统一 500 分支不再吞 `URIError`。
- **F21**：`writer_failed` 响应体只含固定枚举码，不含 `error.message`；原文（表/列名）只出现在结构化日志。
- **F22**：给出 12.6 MB 块在详情页的渲染行为与派生耗时结论；结论若为「无影响」，明确关闭为观察项，不加上限。
- **F23**：`claimGroupTx` 路径会写 `attempts` / `last_error`；永久失败组有退避或上限，队列能看出失败原因；「永久失败」判据写进注释与测试。
- **F24**：`body_state='available'` 且 `body_bytes IS NULL` 的计数降到 **0**（或 purge 按块表反算）；`maintain purge` 的「可回收字节」与实际释放量的偏差可量化。
- **F25**：有「同 conv+agent 60 s、两条调用、一条缺强标识」的正反例测试；弱规则命中时模型或用量至少一项有交集；回归基线仍是 0 跨会话错并。
- **F26**：合并后 `conv_key` 按 `session > conv > request/hook/conv-digest` 优先级收敛；不变量测试断言「有 HAVE_SESSION 的行不落弱键」。
- **F27**：全库 `response_id_norm` 重复组保持 **0**；规范化遇到冲突组走合并，而不是产生两个同键行。
- **F28**：明确记录上游是否会写裸 32 hex；若会，`session_`+32 hex 与裸值归一到同 key；若不会，测试锁定「多 key = 0」。
- **F29**：最长会话翻页超过 500 个目标后，先前渲染的 `+N` 仍能弹出；会话切换后 Map 重置；有 600 条目标的 DOM 测试。
- **F30**：`restore` 后自动 smoke（`openStore` + `user_version` + 关键表计数）；v6/8/10/11 至少各有真实旧 schema 用例；恢复失败在 `restore` 阶段暴露。
- **F31**：`RESTORABLE_SCHEMA_VERSIONS` 只保留一条权威注释；DB-only 输出不再单靠 `ok:true` 表达可用性；读 `ok` 的消费者不会误判。

## Risks

- **F07 的 A 只压单轮成本**：约 30%，不解决 35–39% 占空；若把它宣传成「长派生修好」，会掩盖 D（真增量）仍缺席。每轮多占约 50 MB 原始 blob，共享解码对象必须只读，否则污染后续行。
- **F07 验收容易用错数**：生产单轮 18.6 s 与副本 6,200/9,057 ms 不可直接对比；不先跑一次取热值就会把冷值当回归。
- **F06 会放大派生队列**：队列基数与首轮回填耗时未估，贸然进派生可能长时间占主线程；必须在写窗口做。
- **F05 的 68 条可能只是新流量**：若据此宣布 `turn_ref` 已修，存量仍空的部分会在身份关联验收里制造假阴性。
- **F03/F04 的证据缺口**：没有新证据就不应改代码，也不应为了让清单变短而宣布关闭。
- **F08 只读预检本身有边界**：它只能判断 schema 版本与迁移可行性，不能替代备份；预检通过不等于迁移一定成功。
- **F09 是写操作**：重判脚本必须保留原 `body_state` 与 `miss_reason` 以便回滚；先在副本/只读计数确认 1,386 这个范围，误判会把真正缺正文的行也改成 `partial`，反而掩盖问题。
- **F10 不插桩就改 SQL 可能白改**：副本同函数 162 / 109 ms，SQL 只占 0.11–0.16 s，差距在 HTTP/IO 层；先分段再定修法。
- **F11 首次「循环到空」会清掉大量超期行**：需评估 WAL 增长与 I/O 峰值，不要在高流量时段跑。
- **F16 未确认客户端重试前**：不能把 429 当作「无数据损失」；这条不确认，F16 只能算观察项。
- **F18 的判级依赖威胁模型**：按标题当 P0 直接收紧鉴权，可能破坏同源浏览器导航（前端读 `/api/` 不带令牌）；按 P1 放着不动，则本机任意进程仍可无令牌读统计。两种做法都要先写清威胁模型，不能默默选一边。
- **F19 删旧日志不可逆**：旧日志是排查 `migrate` / `openStore` 栈的唯一线索；删除前先确认不需要回溯。只改权限不删也能满足「0600」这一条。
- **F20/F21 都是契约变更**：把 500 改成 400、把 `code` 换成枚举值，可能影响现有客户端按字段判断的逻辑；先确认没有外部消费者依赖当前形状。
- **F22 「无上限」本身是设计选择**：冒然限制单块大小会让原本可接收的大请求开始失败；先测再定，别把观察项当成必修。
- **F23 没有可复现的失败组**：只能按代码推断；加了 `attempts` 后要观察一段时间才能证明退避有效，不要一次改到「永久失败即丢弃」。
- **F24 的归因未逐行回溯**：29,347 行按 `via='through'` + `redact_version=NULL` 归到 merge 路径，可能还有别的写入路径漏 `body_bytes`；修完要用全表计数验收。
- **F25 收紧弱规则的代价是拆开**：要求模型相等会拒掉模型别名（同一模型不同写法）的合并，把合法调用拆成两条；要求 usage 交集则在「先落调用、后补 usage」的时序下同样拆。加闸门前要先用正反例确认两类样本。
- **F25 的 60 s 窗口本身是经验值**：缩短会拆开正常重试，放宽会放大误并；窗口与「唯一候选」两个条件的相互作用没有独立的现场证据，回归只能靠 5 条已命中样本。
- **F26 改优先级会动存量 `conv_key`**：把弱键提升为 session 键需要回填历史，回填脚本写错会直接改变派生分组；当前 0 实例，说明没有「必须先修」的紧迫性，优先只加不变量测试。
- **F27 修法本身可能引入重复**：把冲突组改成合并，需要完整走 `mergeRequestTx`（含 block 搬运、alias 写入），改错会制造新的 alias 链；先跑一次全库重复扫描作基线，改完复扫。
- **F28 补 canonical 规则依赖上游形态**：如果不同上游确实把 32 hex 当独立会话（而不是同一会话的另一种写法），强行归一会把两个会话合并；未确认前只能锁现状，不能直接改归一函数。
- **F29 改 `moreTargets` 会牵动整个 tool 步骤渲染**：LRU 淘汰或按可见行清理会改变 `+N` 的生命周期，可能让刚渲染的 chip 立刻失效；只在最长会话复现后再改，不要顺手重写渲染层。
- **F30 加 smoke 会改变 `restore` 的语义**：恢复后自动 `openStore` 会触发迁移，也就意味着 `restore` 从「复制」变成「复制 + 首开」，失败点前移；要确认运维流程能接受这一点（恢复失败在 restore 阶段暴露，而不是首次启动）。
- **F30 的旧 schema fixture 成本高**：要真正覆盖 6/8/10/11，需要保留历史 schema 建表脚本或快照；只改版本号的做法看似省事，正是本轮 F30 的成因，不能再用它凑覆盖。
- **F31 改字段名会影响现有消费者**：`ok` 改成 `usable_for_restore` 或让 DB-only 返回 `ok:false`，可能破坏只读 `ok` 的脚本；本轮没有外部消费样本，改之前先确认调用方。

## Alternatives considered

- **把 11-03 整篇移到 `implemented/`**：11-03 仍有 6 条未关闭加 F28 的 `turn_ref` 子项，整篇归档会把未修写成已修。落选；改为保留在 `proposed/`、文首标注归档口径、未关闭项承继到本篇。
- **沿用 11-03 的 F 编号（直接从 F34 起，或保留 F33）**：两套编号并存，交接时「见 F33」会指向两个不同的文档位置，且旧篇编号本身已经按 11-03 的顺序排过。落选；本篇从 F01 重排，用「承继映射」表把新旧编号一次对齐。
- **F33 留在 11-03 篇，只加一句「本条属 11-04」**：11-03 是当晚体检的档案，混入 11-04 的取证会让「11-03 查了什么」失真。落选；整条搬到本篇 F07，旧篇只留指针。
- **一条 finding 一篇 Agent Note**：字段更整齐，但会稀释注意力、破坏单页清单，且互相引用成本高。落选，沿用单篇分节。
- **把 F03/F04 直接关闭以缩短清单**：没有新证据，关闭等于改写结论。落选，保留为未证实/待补证据。
- **F09 只改 `markHookAbsent` 分支、不回填历史**：新流量不再产生这类行，但 1,386 条历史永久坏掉。落选；门禁分支与一次性重判必须一起做。
- **F11 把 TTL 缩到 3 天**：能暂时压住超期存量，但保留承诺是 7 天，缩短只是掩盖清理能力不足。落选；改清理吞吐。
- **F10 直接改 SQL / 加索引**：SQL 只占 0.11–0.16 s，副本同函数也比生产快 4 倍，差距在 HTTP/IO 层。落选；先分段插桩。
- **F18 对 `/api/` 一律要求令牌**：最彻底，但会改变同源浏览器的使用方式，可能破坏现有前端；落选为待判选项，先判威胁模型。**窄化同源信任到真导航**（`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`）是另一条候选，改动面小但只挡跨源脚本，不挡本机进程。
- **F19 只改文档、不动权限**：文档承诺 0600 但实际 0644，只改文档等于承认隐私暴露；落选。只 `chmod` 不删旧日志可以接受，但旧日志的内容仍留在磁盘。
- **F22 直接加上限（例如单块 ≤1 MiB）**：会让 17 个已有大块所在的历史请求无法再入库/回放，且当前未证明有害；落选，先观察。
- **F23 给 `derive.compute` 加全局超时并丢弃失败组**：能止血，但会静默丢数据；落选，先做 `attempts` / `last_error` 可观测性，再谈丢弃策略。
- **F24 只在 purge 侧用块表反算、不回填 `body_bytes`**：改动最小，但 `body_bytes` 继续为 NULL，其他消费端仍可能漏算；落选为首选方案，**优先在 merge 路径补写，purge 反算只作兜底**。
- **F25 直接删掉 `conv_time_model.v1` 弱规则**：能彻底消除误并，但会让缺强标识的 codex/zcode 调用全部落空、变成孤儿（当前 5 条会变 5 个孤儿），把「可能并错」换成「确定拆开」。落选；保留规则但加第二道闸。
- **F25 按 usage 交集重算历史 5 条**：只用现有证据无法反推「两次调用」的边界，重算结果不可验证；落选，先把正反例做出来。
- **F26 一次性回填所有弱键 `conv_key`**：当前 0 例，回填没有收益却有改分组的风险；落选，先写不变量测试，等出现实例再回填。
- **F26 把身份优先级塞进 `COALESCE` 链**：看起来改动最小，但 `COALESCE` 只能「补空」，表达不了「弱键被强键覆盖」，会留下看似修好实则未改的假象。落选；要改就改成显式比较来源。
- **F27 保留裸 UPDATE、只加唯一索引让冲突报错**：能让冲突显式失败，但会把一次维护操作变成中途中断，留下半套数据；落选，冲突组必须先合并再写。
- **F28 直接把所有 40 字符里 `session_` 前缀无条件剥掉**：会误伤本身就带 `session_` 且不是 UUID 的真实 id；落选，按来源维护显式规则。
- **F29 把 500 上限调大（例如 5,000）**：只把触顶点后移，最长会话 4,433 条请求仍会触顶，且内存继续涨；落选，改成有界 LRU 或按可见行清理。
- **F29 直接去掉上限、让 Map 无限增长**：翻页永远可用，但长会话会持续持有 DOM 目标引用；落选，保留上限但换成有界淘汰。
- **F30 不在 `restore` 里加 smoke，另开 `verify-restore` 命令**：把「复制」和「可用性判断」分开，语义更干净，但运维多一步、容易跳过；落选为次选，若运维流程不接受自动迁移，再退回这条。
- **F30 只把白名单缩到 `[12]`**：能立刻消除「声明可恢复但没测过」的口径，但会把真实旧库挡在门外；落选，先补真实旧 schema 测试再决定白名单宽度。
- **F31 只改注释、保留 DB-only 的 `ok:true`**：文档不再矛盾，但自动化仍会误判；落选，注释与字段口径一起改。

## 第四轮起的前置提醒

本轮没有第四轮条目；以上 F25–F31 的「未证实点」应作为下一轮巡查的输入：弱规则正反例、裸 32 hex 上游形态、真实旧 schema 恢复、最长会话 `+N` 触顶，四项都只需要只读数据或合成样本即可补齐。
