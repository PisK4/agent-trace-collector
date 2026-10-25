# CONTEXT.md — collector 运行词汇表

运行模型术语的定义与边界。字段清单、值域细节与默认值归 [docs/architecture-design.md](docs/architecture-design.md)；定位级入门名词（请求、session、conv、trace）归 [docs/project-overview.md](docs/project-overview.md) 的名词节。

## 证据的坐标

**证据通道**：
一条逻辑请求由哪几路证据合成，取值 hook / ledger / route / api / otlp_span，落在 request_evidence.source_kind。have 位图（1 hook、2 账本、4 路由、8 OTLP span）是它的读侧影子。
_Avoid_: 来源（单独说「来源」时指代不明）

**物理来源**：
一条原始账本行从哪次读取来，取值 file / api，落在 raw_ledger.source_kind。文件行按 (file_generation, byte_offset) 定位，api 行按批次页内序号。
_Avoid_: 与证据通道共用同一个 source_kind 词形

**流量种类**：
一笔调用在网关侧走的路径，取值 through / direct / rejected，落在 raw_ledger.source。
_Avoid_: via

**出生通路（via）**：
创建该 request 行的通路，取值 through / hook / direct / rejected / otlp，回答这一行从哪条通路生出来。via='hook' 是暂存行：hook 先到且未对上账本时的行，合并成功即被删除，存活的是账本建的行。via='otlp' 是终态行：harness 侧 span 建的行，独立存在，不与 magpie 行合并。
_Avoid_: 当作流量种类读

**关联**：
一条证据行与请求行的挂接状态，merge_state 取 merged / pending；多候选歧义由 pending_hook.candidates 承载，不写进 merge_state。
_Avoid_: 请求折叠（两回事）

**请求折叠**：
两行 request 并成一行的动作：旧 id 进 request_alias，证据、正文引用与派生输入随迁，源行删除。
_Avoid_: merge_state（那是关联状态）

## 递增计数家族

七个计数各自回答一个问题，互不代入。

**file_generation**：文件身份，dev + inode + birthtime，不含 size；正常追加不换代际。

**rewrite_epoch**：同一文件身份内的重写计数；截断或原地重写时 +1，游标归零重读而旧行身份仍有效。

**group_epoch**：派生组删除重建后的世代；旧完成记录不复用到新组。

**input_revision**：组消费过的输入修订，只增不减；正文、证据、归属变化推进它，只改费用不推进。

**derive_generation**：派生结果的发布代；读口径由队列上的 published_generation 指针切换。

**derive_version**：该行被重算过的历史计数，不表示当前算法。

**mapping_version / privacy_version**：原始行按哪版字段映射或脱敏规则变换；规则改版后旧行保持旧口径。

## 认识论五词

**缺失（missing）**：没有观测到。have 位图为 0、费用 absent 都属于它；raw 过期是本次证据缺失，不是从没观测过。

**歧义（ambiguous）**：观测到多个候选，不挑一个。工具配对与费用匹配适用。

**未知（unknown）**：有观测但推不出结论。prev_relation=unknown 表示链断了；不许升级成 branch。

**未证实（unproven）**：同毫秒先后只有同一账本代际内的偏移能证明；证不了时尝试明细按 pending_final 处理。

**保留（retained）**：旧结论按旧算法与旧输入算得，本次读不出来，原样保留，不冒充新。

确定结论只认 derived_state='current'。

## 销毁动词

**回收（evict）**：正文预算驱动，body_state 置 evicted，body_prev_state 保留原状态；元数据不参与。

**过期（expire）**：raw 层按 TTL 删除，删除前先标 payload_state=expired。

**淘汰（purge）**：维护命令显式执行，按证据键写墓碑；来源回放命中墓碑计 purged_skip，不复活。

## kind 三族

**调用用途（kind）**：上游自报的调用用途，如 web_search、compact，落在 raw_ledger.kind，与 handed_on 无关。

**请求种类（req_kind）**：派生层判定的请求种类；title 等旁路请求由此排除出祖先集合，正式标题存 model_title。

**链参与（purpose_chain）**：这一笔参不参与主链；exclude 的请求不进祖先集合，判定规则归用途阶段。
