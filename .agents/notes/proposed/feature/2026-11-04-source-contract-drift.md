# Agent Note: 数据源契约漂移检测与来源健康审计

Status: proposed

本文承接[多来源同一调用的身份归一与去重](2026-11-04-multi-source-call-identity.md)。那篇解决「同一笔调用只留一行」，这篇解决「上游改了格式，我们怎么知道」。它不取代[后台性能监控](../process/2026-11-03-background-monitoring.md)：性能监控看采集器自己，本文看外部来源的输入。它也不取代[magpie 字段保真](../architecture/2026-10-22-magpie-parity-and-field-fidelity.md)的一次性字段修补；那篇补历史缺口，本文管持续发现。

整套检测写成一份提案。各阶段共享同一个问题、同一组替代方案和同一条验收边界，拆成多份会让基线与问题描述重复。等某个阶段变成独立决策，例如新增观察表或自动回填，再另开一份。

**取代检查。** 活动树里没有记录持有「来源契约漂移」这一决策。`2026-10-22-magpie-parity-and-field-fidelity` 只处理 magpie 字段的已知缺口；`2026-11-03-background-monitoring` 只处理采集器性能；`2026-11-04-multi-source-call-identity` 提供跨源身份规则，不做持续检测。本文与三者互补，不移动或删除任何记录。

2026-11-04 对生产库做过只读核对，数字是当天快照。

## Problem

### 本地会话和网关字段都不是稳定接口

ATC 依赖四类输入：magpie 账本、路由、hook、direct，OTLP span，droid 转录，以及多来源接入后的 Zcode、Claude Code、Codex 本地会话。它们都没有版本化的字段承诺。上游升级可能改名、改类型、改时间基准、改 token 是否含缓存、改会话 id 前缀，甚至改文件布局。适配器读不到时通常不会抛错：值落成 NULL、行数变少，或者数字仍在但含义变了。

三个已发生的例子：

- **magpie 字段按记忆中的键名读。** 映射层读不到 `requested`、`own_cost`、`err` 等键时静默落 NULL，页面再把 NULL 解释成「本地估计」；同一个事实出现三种说法，测试不失败。见[字段保真](../architecture/2026-10-22-magpie-parity-and-field-fidelity.md)。
- **Codex 的 OTLP 服务名换了写法。** 白名单写 `codex_app_server`，真实上报是 `codex-app-server`。2026-11-03 调查时该服务下 109,579 条 span 只落原始层，其中 14 条 turn span 也没有建行，只靠 `service_not_registered` 才看见；2026-11-04 只读读数已增长到 182,311 条。这个铃铛只回答「服务不在白名单」，不回答「已登记服务的字段变了」。见[Codex 接入](2026-11-03-codex-integration.md)。
- **droid 没有版本契约。** `session_start.version` 当前为 2；格式变化只能靠坏行阻塞发现。droid 的选择是坏行停在原地、不推进游标，代价是后面的调用一起停。见[droid 摄入](../../implemented/feature/2026-11-04-droid-session-ingestion.md)。

现有检查各自回答局部问题：magpie 有版本探针和 `FieldState`，OTLP 有 `span_shape_unknown` 与 `service_not_registered`，droid 有坏行 issue 和停游标。它们没有回答三个问题：这一版的必含字段是否还在、语义有没有变、变化影响了多少行和哪些来源。

### 语义漂移没有形状变化

最危险的一类改动不改字段名。例如 `input` 从含缓存改成不含缓存，时间从开始改成结束，usage 从每次尝试改成每轮。JSON 仍然合法，类型仍然正确，解析器不会报错，数字却已经错了。单看本地来源没有 oracle；只有拿网关同一笔调用去对，token 和时间对不上才会暴露。多来源接入之后才有这个对照，所以本提案排在它后面。

### 现有基线

2026-11-04 只读读数：

| 来源 | 当前版本面 | 当前读数 | 备注 |
| --- | --- | --- | --- |
| magpie | `0.1.2899`，探针 `verified=true` | 账本、路由、hook、direct 四路 | 版本区间仍是人工白名单 |
| OTLP | `service.name` 加 `OTLP_MAPPING_VERSION=4` | `codex-app-server` 182,311 条 span；`via='otlp'` 请求 1 行 | 映射版本 3 与 4 的原始行并存（163,143 与 19,203） |
| droid | `session_start.version=2` | 216 个转录、9,582 行 `via='session'`；游标已追平 | 行数与全量扫描一致，正文与会话验收另做 |
| issue | — | `service_not_registered` 7、`span_shape_unknown` 1 | 没有 droid issue |

这些数字不是验收结果，是本文判断「哪些点值得盯」的起点。

第一版本地适配器接入后，`claude_session`、`codex_session`、`zcode_session`、`omp_session`、`pi_session` 与已有的 `droid_transcript` 各有一份契约。适配器发现、增量读取与预算归[本地 Agent 会话适配器第一版](2026-11-04-agent-session-adapters.md)；本文只规定这些来源要报什么。未接适配器的 Agent 在目录里显示 `installed_unsupported`，不生成零行来源，也不进入跨源对账。

### 目标与非目标

目标：尽早发现必含字段消失或类型变化、id 模式变化、时间与 token 语义变化、未知事件突增、覆盖率突降、跨源匹配率突降；解析不了的批次不静默丢数据；报告能直接指向要改的适配器。

非目标：不监控上游「架构」；不把 changelog 抓取当主信号；不自动改 parser；不自动回填；不存真实字段值；不新增 trace 库监控表；不替代性能监控。

## Proposal

### 1. 先定义来源契约

「来源契约」是 ATC 对一个来源所依赖的事实集合，不是上游的完整 schema。每个来源一份声明，放在 `src/sources/contract.ts`：

| 项 | 内容 |
| --- | --- |
| `sourceKind` | `ledger`、`route`、`hook`、`direct`、`otlp_span`、`otlp_log`、`droid_transcript`，以及本地 Agent 来源 `claude_session`、`codex_session`、`zcode_session`、`omp_session`、`pi_session`。未接适配器的 Agent 只进安装目录，不算来源 |
| `parserVersion` | 我方读取语义的版本；改读取规则时加一，不跟上游版本走 |
| `requiredFields` | 必须存在且类型正确的字段路径 |
| `optionalFields` | 已知可选字段；缺失不算漂移 |
| `eventTypes` | 必须出现的行类型或事件类型；未知类型只记录 |
| `idPatterns` | 会话、响应、turn、调用 id 的允许形状 |
| `timeBasis` | 开始、结束加时长、消息时间或未知 |
| `usageSemantics` | input 是否含缓存、按次还是按轮 |
| `invariants` | 例如含缓存源的 `input >= cache_read + cache_write`、`end >= start`、非负 |
| `versionSources` | 上游版本从哪读：文件头、CLI、span 资源、magpie 探针 |

声明是数据，检查是几个纯函数；不写通用 schema 语言，也不为未知来源预留插件系统。第二个本地 Agent 接入时，按真实字段补一份声明。

`parserVersion` 由 contract 声明持有，不改现有 `ADAPTER_VERSION`（正文协议）与 `OTLP_MAPPING_VERSION`（OTLP 映射）的含义；三者答的是不同问题。

### 2. 四层检查

| 层 | 看什么 | 跑在哪 | 失败后果 |
| --- | --- | --- | --- |
| 结构 | 必含字段、类型、事件类型、id 模式、表与列集合 | 每批摄入 | 硬 issue；能留原始行的来源继续，不能留的停游标 |
| 取值 | token 不变量、时间顺序与单位、模型非空、正文可读率 | 每批摄入 | 按比例升级；单条坏值只记该行 |
| 覆盖率 | 解析成功率、未知事件比例、零 token 调用比例、正文可读率、每会话调用数 | 每批聚合，5 分钟快照 | 持续低于基线才告警 |
| 跨源 | 匹配率、歧义率、token 差、开始时间差 | 5 分钟 tick，窗口 2 小时 | 持续下降才告警；覆盖差不算漂移 |

形状签名分两个：`requiredHash` 只覆盖必含字段与类型，变化就是硬信号；`observedHash` 覆盖全部字段路径与类型，变化只做 info 和差异展示。两者都不含字段值、计数与顺序。未知字段进 `payload_json`，不丢；新增字段不告警。

样本要有界。账本、路由与 OTLP 的映射已经逐行读过字段，观察层直接消费映射结果，不二次遍历；droid 解析已经逐行读过，观察层只累计计数。需要额外结构样本时，每批最多取前 100 行加固定间隔样本，不按正文大小复制。

### 3. 观察落在哪

- 硬失败写 `ingest_issue`，新增 reason：`contract_missing_required`、`contract_field_type`、`contract_id_pattern`、`contract_usage_invariant`、`contract_unknown_event`、`contract_coverage_drop`、`contract_cross_match_drop`、`contract_shape_changed`、`contract_version_changed`。按 `(source_kind, 'contract/<version>/<day>', reason)` 聚合，一批坏行只留一行 issue，不逐行刷表。
- 当前快照写 `collector_state` 的 `["source_contract", sourceKind]`，每个来源最多保留 8 个版本桶。每桶记 `version`、`parserVersion`、`requiredHash`、`observedHash`、`firstSeenMs`、`lastSeenMs`、`files`、`lines`、`parsed`、`ignored`、`invalid`、`unknownEvents`、`missingRequired`、`idPatternMisses`、`usageInvariantFailures`。快照按 5 分钟或变化时写，计数在两次写之间只存在于进程内；报告标注采样时间，不把内存计数当成持久事实。
- 不新增表。历史由 `scripts/monitor.ts` 每 300 秒采样一次，写 `monitor/sources/YYYY-MM-DD.jsonl`，沿用 `monitor/` 的 14 天保留与 0600/0700 权限。需要按文件追溯时再单独提案加表。
- `maintain source-health --db <path> [--since <ISO|ms>] [--json]` 是只读入口：独立只读连接，不取维护锁，不停采集器，输出当前快照、issue 汇总、跨源对账与结构样本引用。它和 `hook-delivery` 同一类，不是写库命令。

### 4. 跨源对账

跨源层直接消费 `request_evidence` 的 `source_kind` 与 `match_rule`，不另写匹配逻辑。对每一对应该有重叠的来源，按窗口统计：

- 匹配率：两边都有证据的请求数除以该来源窗口内的请求数；
- 歧义率：`match_ambiguous` 的数量与占比；
- 未命中：`match_absent` 的数量与占比，按已知覆盖差解释；
- 匹配上的 token 差与开始时间差：p50、p95、最大值。

多来源提案已经测过基线：网关 zcode 与本地 637 唯一命中、0 多候选、119 未命中；direct 与本地 585 唯一命中、57 子会话折叠。未命中不是匹配失败，是真实覆盖差。监控只对「同一来源、同一窗口、同一 `parserVersion` 下的比率明显下降」告警，不对绝对未命中数告警。

基线分两种：契约版本批准后的头 7 天冻结为固定基线，用于语义判断；最近 7 天的滚动中位数用于噪声容忍。只看滚动基线会让缓慢漂移被自己吸收。`maintain source-health --accept-baseline` 可以提前冻结某个版本的基线，冻结动作要写 issue 或日志，不能隐式发生。

没有第二来源的源，第一版里只有 droid，只能做结构、取值和覆盖率，语义漂移没有 oracle。这是明确的盲区，报告要写出来，不能用「无告警」冒充「没有变化」。Claude Code、Codex、OMP/Pi 与 Zcode 有网关、direct 或 OTLP 可对账，但覆盖差要单独解释，不能把未命中直接判成漂移。

### 5. 版本与基线

magpie 继续用 `last-version` 加 `/v1` 的探针；版本变化只记 info，形状和必含字段的检查才决定严重级别。探针给出 `verified=false` 时，报告标未验证，版本区间仍由人显式更新，不自动扩大。OTLP 记录 `service.name`、`scope.name` 与属性键集合，`OTLP_MAPPING_VERSION` 是我方版本，两者分开记；droid 记 `session_start.version`，缺失写 `unknown`；后续本地适配器记 CLI 或文件头能拿到的版本，拿不到就写 `unknown`。新版本的头 7 天不与旧版本的固定基线混算；旧版本的基线保留，用来判断「同一版本内的形状变化」。

### 6. 修复闭环

`maintain source-health` 的报告要能直接回答：哪个来源、哪个版本、哪一层、第一次出现时间、影响多少行、样本引用在哪。修复顺序固定为：读报告，取结构样本，只含字段路径与类型；补合成 fixture；写失败测试；改适配器与契约；升 `parserVersion`；跑最窄测试；更新架构文档、运维手册与验收记录；决定是否回填历史。报告可以生成一份 markdown 差异，供 agent 或人修改，但不自动改代码、不自动合并、不自动回填。

不静默推进游标的规则按来源分：

- 原始字节已经落库的来源，包括 `raw_ledger`、`raw_route`、`raw_hook`、`raw_otlp_span`、`raw_droid_event`，可以在硬漂移时继续读，但必须标记批次并保留原始行，修复后能重放；
- 直接读文件、且没有原始副本的本地来源，解析失败停在坏行起点，不跳过；下一轮从同一位置重试。Claude Code、Codex、OMP/Pi 的 JSONL 与 Zcode 的 SQLite 行都属于这一类；Zcode 库不可读时冻结整家，不折成空。
- 已知坏行长期阻塞时，报告给出人工处置入口，不靠自动跳过「恢复」。

### 7. 告警与展示

复用 `scripts/monitor.ts` 的采样、告警状态、30 分钟提醒与 15 分钟恢复窗口，不另起守护进程。新增规则：

| 规则 | 初始条件 | 级别 |
| --- | --- | --- |
| `source_required_missing` | 必含字段整批缺失，或同版本连续两批缺失 | hard |
| `source_parse_collapse` | 解析成功率低于 50%，或比同版本基线下降 30 个百分点并持续 30 分钟 | hard |
| `source_coverage_drop` | 解析率、正文可读率或每会话调用数比固定基线下降 10 个百分点，持续 30 分钟 | warn |
| `source_usage_invariant` | 2 小时窗口内不变量失败率超过 1% | warn；超过 10% hard |
| `source_cross_match_drop` | 匹配率比同版本固定基线下降 10 个百分点，持续 2 小时 | warn；下降 30 点 hard |
| `source_shape_changed` | `requiredHash` 变化但上游版本未变 | hard |
| `source_version_changed` | 新版本首次出现 | info，不通知 |

页面不新增状态标签。现有 issue 列表与服务状态已经能显示异常；只有 hard 漂移时，在现有健康入口给它一个计数，正常态不显示二级标签。

游标停滞与采集缺口沿用现有 `source_cursor.last_ok_ms` 与 `source_gap`，监控的 `collection_gap` 规则继续负责；本文只加来源契约规则，不重复已有告警。

### 8. 落地顺序

多来源实现时先埋三个钩子，避免以后补迁移：

1. 每个来源适配器带一份 contract 声明，字段清单就是它依赖的字段；
2. 每批摄入计算 `requiredHash`、`observedHash`、版本与计数，变化时写 `collector_state` 快照；
3. 未知事件、缺字段、类型错误写结构化 issue；跨源匹配率作为固定输出，不再只出现在一次性评估里。

完整落地排在多来源之后：

| 阶段 | 交付 | 验收 | 依赖 |
| --- | --- | --- | --- |
| 1 纯函数 | `src/sources/contract.ts`、`src/sources/observe.ts` 与单测：形状签名、必含字段、id 模式、token 不变量、版本桶 | 纯函数测试通过，不碰写库路径 | 无 |
| 2 接入 | 账本、路由、hook、OTLP、droid 与第一版本地 Agent 适配器的观察与 issue；快照写 `collector_state` | 现有 `bun test` 全过；观察层每 1,000 行小于 5 ms；新增字段不告警 | 阶段 1 |
| 3 只读入口 | `maintain source-health`；`/api/stats` 的 `source_health` 摘要；运维手册 | 只读、不取锁、服务不停；报告复现当前基线 | 阶段 2 |
| 4 跨源 | L4 匹配率、歧义率、token 差与时间差；固定基线 | 复现 637 与 585；已知覆盖差不告警；查询 p95 小于 50 ms | 多来源与本地适配器落地 |
| 5 监控 | `scripts/monitor.ts` 新规则、阈值、恢复窗口 | 合成故障能触发；无误报；真实库校准一周 | 阶段 3、4 |
| 6 文档与验收 | 架构设计的「版本与形状漂移」扩展到全部来源；验收记录分合成与真实 | 链接有效；`bun test`、`typecheck`、`verify:notes` 通过 | 全部 |

## Alternatives considered

**只抓上游 changelog 或 GitHub release。** 发布说明经常滞后，格式变化可能藏在 patch 版本里；Claude Code 的本地格式没有公开的版本化契约，拿不到可靠细节；本地实际读到的形状才是事实。changelog 以后可以作为早期提示，不能当主信号。

**只做每批必含字段检查。** 架构文档已经提出这个方向，但它只能发现缺字段，发现不了 token 语义、时间基准和 id 命名空间的变化；没有跨源对账，误报和漏报都高。

**新建 `source_observation` 表，每批写一行。** 查询方便，但增加迁移、写入和保留工作，还会和 `monitor/` 的历史重复。首版用 `collector_state` 快照加外部采样；需要按文件钻取时再单独提案。

**检测到变化就自动改 parser 或自动回填。** 语义变化需要判断、测试和验收；自动改会把一次可解释的漂移变成数据损坏。报告最多生成差异与 fixture 草稿。

**把来源健康并入性能监控的 trace 库。** 性能监控已经明确用仓库外文件，避免被测库写入；来源健康同属监控，沿用外部采样。

**对未知字段或未知事件硬失败。** 上游加字段是常态，硬失败会让采集停摆。未知新增只记录，必含字段缺失或类型变化才升级。

**只做跨源对账，不做本地检查。** droid 没有第二来源，会完全失去检测；本地解析失败也可能在跨源之前就丢行。两层都要有。

**用版本号判定一切。** 版本可能不变而形状变，也可能变了但形状不变；版本只是上下文，`requiredHash`、不变量与跨源对账才是信号。

## Acceptance criteria

合成数据：

1. 新增未知字段：不产生 hard issue，原始 payload 保留该字段，`observedHash` 变化但级别为 info。
2. 删除必含字段：产生 `contract_missing_required`，带来源、版本、首次出现时间；直接读文件且无原始副本的来源停游标。
3. 字段类型变化：值保持 NULL，不转类型，产生 `contract_field_type`；单行坏值不降级整批。
4. 整批缺字段且版本变化：判 hard；单条可选字段缺失：不告警。
5. 会话 id 换前缀：按来源、版本、日聚合一条 `contract_id_pattern`，不逐行刷。
6. token 不变量失败：warn；超过 10% hard；对 input 不含缓存的源不误报。
7. 时间基准从开始改成结束：跨源开始时间差分布移动，报告显示 p50 与 p95；不自动合并。
8. 版本变化但形状不变：info；形状变化但版本不变：hard `contract_shape_changed`。
9. 解析不了的坏行：issue 加停游标或保留原始行，不能静默跳过并推进。
10. 跨源匹配率下降：报告与告警；已知覆盖差 119、31、57 不触发告警。
11. 歧义率上升：warn，两个候选仍不合并。
12. 报告只含字段路径、类型、计数、哈希；不含正文、账号、令牌、会话标题。
13. 重启后快照与版本桶还在；计数重置不产生假恢复，监控把缺样本当缺口。
14. 性能：合成 1,000 行批次增加小于 5 ms；不新增全表扫描；`maintain source-health` 在接近生产规模的库上小于 50 ms。
15. 多版本并存：旧文件与新文件各成桶，不产生告警风暴。
16. 真实只读复核：报告能复现 magpie `0.1.2899`、droid 216 个转录与 9,582 行、OTLP `codex-app-server` 182,311 条 span 与现有 issue，不写库、不重启。
17. `bun run maintain source-health --db <path> --json` 退出 0，不取维护锁，服务保持运行；`bun run typecheck` 与相关 `bun test` 通过。
18. 文档：架构设计的「版本与形状漂移」扩展到全部来源，运维手册加入命令，验收记录分开写合成与真实读数。

## Risks

- **没有第二来源的源有语义盲区。** droid 当前只能看结构、取值与覆盖率；token 语义变了没有 oracle。报告必须写出这个限制。
- **固定基线会过期。** 上游稳定多年后，基线可能不再代表当前行为；每次 `parserVersion` 或批准的新版本要重建基线，并保留旧基线用于同版本比较。
- **形状签名过敏。** 可选字段、事件类型顺序、样本截断都会让 `observedHash` 抖动；`requiredHash` 只含必含字段，`observedHash` 只做 info，样本有界。
- **观察层拖慢摄入。** 映射已经逐行读字段，观察层只消费结果；如果实现需要第二遍遍历，就违背预算，必须改成增量计数。
- **快照增长。** 每个来源最多 8 个版本桶，每桶字段有界；超出时淘汰最老桶，不无限追加。
- **坏行停游标会阻塞来源。** 这是为了不丢数据；报告要给人工处置路径，长期阻塞要能被看见，不能用自动跳过掩盖。
- **跨源匹配率会被上游覆盖变化带动。** 未命中不等于漂移；只对同版本、同窗口的持续下降告警，并要求报告解释覆盖差。
- **版本字符串不可靠。** 有的来源没有版本，有的版本变了但格式没变；版本只做上下文，不做唯一判据。
- **告警疲劳。** 新模型名、新字段、新事件都可能是正常的；首版只对 hard 规则通知，warn 进报告，运行一周后校准。
- **修复后的回填有成本。** 历史行可能按旧语义解析；是否重放由来源原始层是否保留、影响范围与费用决定，不自动执行。
- **隐私。** 字段名也可能带标识，例如工具名、模型名、会话 id；报告只存字段路径与类型，必要时哈希，不存值。

## Deferred

- 按文件或代际的观察表与钻取。
- 从结构样本自动生成合成 fixture 的草稿。
- 把 changelog 或 release 作为早期提示源。
- trace 库 schema 自身的漂移检测；迁移是显式动作，暂不需要。
- 读取接口与页面渲染层的契约漂移检测。
- 自动回填与 agent 生成修复分支；报告可以先服务这个流程，决策仍要人确认。
