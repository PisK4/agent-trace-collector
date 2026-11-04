# 领域术语表

本仓领域术语的定义与边界。词条只收含义与容易混淆的边界；字段清单、值域细节与默认值归 [docs/architecture-design.md](docs/architecture-design.md)，决策理由归 [.agents/notes/](.agents/notes/README.md)。

## 基础名词

**请求（request）**：
本项目的主记录单位，表示来源报告的一笔调用；网关请求可包含多次上游尝试。magpie、harness OTLP 与本地 Agent 会话文件（droid、Claude Code、Codex、Zcode、OMP、Pi）都可提供请求记录，同一调用经多条通道分别记录时，请求行数不等于去重后的调用数。

**session**：
客户端或 harness 声明的会话标识，由 magpie 转报、从 OTLP 属性映射或从本地 Agent 会话文件读出；标识缺失时不凭空推定会话归属。

**conv**：
magpie 根据首条用户消息生成的会话指纹，只在没有 session 时用于会话归属；它不等同于本项目通用的会话分组键 conv_key。

**trace**：
本项目对一笔请求记录及其详情的称呼，不等同于 OTLP 中由 trace_id 标识、可含多个 span 的 trace。页面可以按会话连续阅读多笔请求。

## 证据的坐标

**证据通道**：
提供请求证据的输入类别，如 hook、账本、路由、OTLP span 与 session_call；对应 request_evidence.source_kind，区别于读取原始记录的物理来源。
_Avoid_: 来源（不说明是证据通道、物理来源还是流量种类）

**物理来源**：
原始账本记录的取得方式，如文件读取或 API 拉取；对应 raw_ledger.source_kind。相同字段名在证据表中表示证据通道，引用时须带所属概念或表名。

**流量种类**：
magpie 账本对调用路径的分类，对应 raw_ledger.source；它与请求记录的创建通路分别描述上游调用和本地建行。
_Avoid_: via

**出生通路（via）**：
创建本地请求记录的通路，对应 request.via；后续证据汇入不使它变成证据来源的完整集合。hook 暂存请求可被折叠进账本请求；OTLP 与本地 Agent 会话文件各有自己的证据位，账本晚到时可按统一 owner 规则认领已建行，具体规则见[合并规则](docs/architecture-design.md#合并规则)。
_Avoid_: 当作流量种类或全部证据通道读

**关联（association）**：
证据记录与请求记录的挂接关系；关联状态与多候选歧义分别记录，字段约定见[请求与证据的关联](docs/architecture-design.md#请求与证据的关联)。
_Avoid_: 请求折叠

**请求折叠**：
将两条被判定为同一请求的本地记录合为一条，保留证据与引用的归属；它改变请求记录本身的身份关系。
_Avoid_: merge_state（证据关联状态）

## 身份、修订与版本

这些标识分别回答记录属于哪一代、输入变过几次、结果由哪套规则生成，不能统一当作递增计数。

**file_generation**：文件读取代际，用于区分文件更替或重写前后的记录；正常追加不换代。它与底层文件身份的区别见[物理记录身份](docs/architecture-design.md#物理记录身份)和[增量读取协议](docs/architecture-design.md#增量读取协议)。

**rewrite_epoch**：同一底层文件身份内的重写计数；用于区分截断或原地重写前后的读取代际，不能比较不同文件的新旧。

**group_epoch**：派生组的世代身份；组删除后重建会取得新身份，旧完成记录不能复用到新组。它不表示组重建过多少次。

**input_revision**：同一输入身份内的修订号，输入变化时递增；当前修订与结果已消费的修订需要分别判断，见[组完成与输入修订](docs/architecture-design.md#组完成与输入修订)。

**derive_generation**：一代派生结果的身份，涵盖构建中、已发布或已丢弃等阶段；标识本身不表示先后，也不证明该代已经发布。生命周期与读出规则见[派生代际与发布指针](docs/architecture-design.md#派生代际与发布指针)。

**derive_version**：请求行在同步派生路径上的历史更新计数；不表示当前算法，也不能用来判断结果是否最新。

**mapping_version / privacy_version**：记录变换时采用的字段映射或脱敏规则版本；规则升级不会使旧记录自动具备新版本的含义。

## 认识论五词

**缺失（missing）**：所需证据未取得或当前不可用；历史证据过期不等于从未观测过。

**歧义（ambiguous）**：存在多个候选且证据不足以唯一确定；不能任挑一个作为结论。

**未知（unknown）**：已有观测仍不足以推出结论；例如前驱关系未知不能升级成已确认的分支。

**未证实（unproven）**：某项判断缺少所需证明；例如时间相同的记录不能仅凭时间戳证明先后关系。

**保留（retained）**：当前无法重算而沿用的历史结论；它仍属于原算法与原输入，不能冒充本轮新结论。

派生结论是否可当作当前结论读取，见[读模型里的派生状态](docs/architecture-design.md#读模型里的派生状态)；该判定不限制独立来源事实的读取。

## 销毁动词

**回收（evict）**：为满足正文预算而释放正文存储，保留请求元数据；具体规则见[回收](docs/architecture-design.md#回收)。

**过期（expire）**：原始证据超过保留期后退出原始层；不代表相关请求从未发生。

**淘汰（purge）**：维护操作显式移除选定数据，并阻止对应来源回放使其重新出现；区别于预算回收与按保留期过期。

## kind 三族

**调用用途（kind）**：上游报告的调用用途，对应 raw_ledger.kind；与一次尝试是否转交给其他上游无关。

**请求种类（req_kind）**：本项目对单笔请求用途的判定结果；与上游自报用途和是否参与主链分别表达不同事实。

**链参与（purpose_chain）**：请求是否参与主链的判定；被排除的请求不进入祖先集合。

## 判定与读出

**结算（settle）**：一次判定形成结论的动作；用途结算确定单笔请求的用途，轮次结算确定请求与回复在轮次中的配对。
_Avoid_: 与派生混用（派生是组级视图的重算过程）

**读数（readings）**：页面呈现的数值及其面板，包括读数页、头部读数条与悬停读数。
_Avoid_: 与读取（正文读取动作）、读模型（查询侧）混用

**推理段（reasoning span）**：首个文本减首 token 的时长。只有末次尝试报告首个推理时才成立；首个内容是工具调用或直接文本时，这个差值不含推理。
_Avoid_: 把首 token 当思考时间；把首 token 到首个文本的差当成任何情况下的推理时长

**执行段（execution window）**：结果请求的开始时刻减调用请求的结束时刻（开始加时长）。窗口含客户端处理、权限确认与会话中断，是上界，不是工具进程自己的耗时。
_Avoid_: 与工具自身运行时间混用

## 上下文读数

**已用上下文（used context）**：本笔请求的 `prompt_tokens`，与上下文矩阵面积同源；不是厂商计费输入（`in_tok + cache_read + cache_write`），两者多数相等但不是同一事实。
_Avoid_: 当作会话累计或计费用量

**总上下文（context window）**：本笔回答模型的上下文窗口 `prompt_window`，由路由记录报告；窗口未知时只写未知，不给分母。
_Avoid_: 与本仓的读取窗口（列表分页）、执行窗口混用

**窗口进度**：`prompt_tokens ÷ prompt_window` 的整百分点，写在「已用上下文」副行（如 `总 1.0M · 已用 5%`），不再单独成格；只在结果重算且窗口为正时给出，旧结果与缺分母不补数。
_Avoid_: 与会话头的上下文峰值混用（后者是全会话 max）

**固定开销（fixed overhead）**：系统提示、工具定义、技能与记忆四类的 token 和，与对话无关、每笔请求都要背的部分；右栏以占已用上下文的整百分点呈现，没有构成分类时不给数。
_Avoid_: 与缓存写入、工具结果混用；把所有非对话类别都算进来

**提示词缓存命中（cache hit）**：请求级 `cache_read ÷ (in_tok + cache_read)`，与会话头合计行同口径；缺读数不给数，合法 0 照常显示。
_Avoid_: 与缓存写入混用；把 0 当缺失

**耗时（请求耗时；duration）**：本笔请求从发出到回复结束的时长，右栏合成一个读数；副行依次是首 token、首个文本与速度，缺项不写。
_Avoid_: 与推理段、执行段混用；把速度分母当成整笔时长

## 界面英文定名

界面 i18n（中英双语）按本表定名，与代码内部命名保持一致；新增界面文案不得另起译名。纯 UI 惯用语（collapse、load more、retry 等）不在此列，进 i18n 字典文件。英文文案遵守与中文相同的落笔风格。

| 中文 | 英文 | 边界 |
|---|---|---|
| 正文 | body | 四态：readable（可读）、not yet arrived（未到）、incomplete（不完整）、evicted（已回收） |
| 回复 | reply | _Avoid_: response（指 HTTP 或上游响应）；工具侧的另一端叫 result |
| 调用 / 结果 | call / result | 工具配对的两端，`calls_paired`、`result_req` 同名 |
| 配对 | pairing | 调用与结果的挂接判定 |
| 轮次 | turn | 时间线标签「轮 N」作 turn N，`turn_ref` 同名 |
| 主链 | main chain | `chain_role` 同名 |
| 旁路 | bypass | `sessions.ts` 的 bypass 标志同名 |
| 辅助请求 | auxiliary request | 「辅助请求，不在主链上」的行级称呼；汇总字段 `aux` |
| 探针 | probe | `probe_kind` 同名 |
| 子代理 | subagent | `subagent_actors` 同名 |
| 采集 | ingest | `/hook/ingest` 同名；「采集暂停」作 ingestion paused |
| 尝试 / 尝试链 | attempt / attempt chain | `attempts` 同名 |
| 账本 / 路由 | ledger / routing | `raw_ledger` 与路由记录同名 |
| 回调 | callback | 全表唯一没有代码锚点的定名；指正文与账本证据的回调到达 |
| 汇总 | totals | 会话头合计口径；_Avoid_: 与摘要（summary）混用 |
| 摘要 | summary | OTLP 摘要保持上游叫法 OTLP summary |
| 首 token / 首个文本 / 首个推理 | first token / first text / first reasoning | 耗时副行的三个里程碑，`ttft_ms` 等字段同名 |
| 思考 / 执行 | reasoning / execution | 时间线两段，与推理段、执行段同源；_Avoid_: thinking（见推理段的口径） |
| 归属 | attribution | 「归属未知」作 attribution unknown；_Avoid_: ownership |
| 目录 | index | context-detail 的已存正文分段目录；_Avoid_: TOC |
| 片段 | fragment | 已存正文的一段；_Avoid_: excerpt |
| 压缩归档 / 归档消息 | compaction archive / archive message | 上游 Claude Code 术语 |
| 标题生成 | title generation | 旁路请求的一种，生成会话标题 |
| 服务模型 | served model | `model_served` 同名 |
| 承载（请求） | carrier | 结果正文所在的那笔请求 |
| 分片 | slice | `derive-slice` 同名；_Avoid_: chunk、shard |
| 工具子事件 | tool subevent | 会话行里默认折叠的工具调用组 |
| 错误标记 | error flag | `is_error` 的界面称呼 |
| 缺口 | gap | 时间线上证据缺失的空档 |
| 明细 | details | context-detail 的下钻面板；_Avoid_: inspector |
