# ATC trace 格式（内部读模型 v0）

本文件描述 ATC 把一次 LLM 请求结构化成什么样：主实体、它的身份与读数、正文怎么切块、派生结论有哪些、每条结论的置信度怎么表达。它描述的是当前代码与 schema v7 的现状，不是对外承诺的稳定协议。

三个限定先说清楚：

- **不是交换格式。** 目前没有导出、没有版本化的对外 schema、没有跨工具互操作。本文件描述的是本库自己的读模型，外部读者可以据此理解数据形状，但接口只服务本机页面。
- **两个进路。** 记录的对象主要是经过 magpie 网关的请求；harness 侧 OTLP 导出的 LLM span 也建行（`via='otlp'`），独立存在、不与 magpie 行合并。`agent` 标签对 magpie 行来自 magpie（`claude`、`omp` 等），对 OTLP 行按 `service.name` 映射到同一值域；派生规则是 harness 通用的，识别某个 harness 的 wire 痕迹是个别规则，不是插件体系。
- **版本会变。** v6 库打开时原地升到 v7，更早的 schema 拒绝启动、由操作者重建；派生算法号变化会让旧结论标成 `legacy` 或 `retained`，不冒充新结论。

字段清单、值域细节与默认值的权威在[架构设计](architecture-design.md)；术语定义与边界在 [CONTEXT.md](../CONTEXT.md)。

## 主实体：一笔请求

记录单位是 LLM request：客户端发给 magpie 的一笔请求，带请求体、回复、agent、会话、模型、状态、用量、耗时与路由去向。magpie 内部对 provider 的多次尝试不增加顶层请求数，作为这笔请求的明细保存。

会话、Agent、模型、日期都是查询出来的视图，不存聚合行。一笔请求至少由一路证据证明存在：

| 证据通道 | 给什么 | 缺什么 |
| --- | --- | --- |
| hook | 客户端协议的请求对象与合并回复、success、agent、session、model | 请求头、流内事件、provider 尝试、`route_id`；回调可能丢失 |
| 账本 | 状态、用量、`route_id`、`response_id`、provider、账户 | 请求与回复正文 |
| 路由历史 | 候选顺序、尝试、规则、亲和性、prompt 结构 | 窗口过滤不全部留痕；只读盘、30 天滚动 |
| OTLP span | 模型、用量、耗时、会话 id；Claude Code 另带正文文件指针 | 请求头、provider 尝试；OMP 只到摘要 |

`have` 是这些通道的位图（1 hook、2 账本、4 路由、8 OTLP span），回答「收到过哪几路证据」。它与 `body_state` 分开：回收正文不会把收到过的证据改写成没收到。OTLP 行只有第 4 位，会话的缺正文判定对它只期望这一位。

magpie 另有 OTLP 导出，不作为证据源。它只发 `gen_ai.*`、`magpie.*` 与 `langfuse.*` 三类属性键，其中没有 `response_id`、`conv`、`subagent`、`archive`（`开源源码@magpie-2374ffe`，`internal/otlp/otel_wire.go`）；正文以 `langfuse.observation.input` / `output` 两段文本发出。这几项正是三路证据的连接点，缺了就合并不起来。表里的第四行接的是 harness 进程自己的 exporter，属性键齐全，与 magpie 网关侧那套导出是两个东西。

## 身份与归属

| 字段 | 含义 | 边界 |
| --- | --- | --- |
| `req_id` | 主键，自增不复用 | 请求折叠后旧 id 进 `request_alias`，读取端解析到 canonical |
| `agent` | magpie 给的客户端标签 | 字符串匹配产生，按标签用，不当身份凭证 |
| `session` | 客户端声明的会话 id，magpie 原样记录 | — |
| `conv_key` | 归属键，JSON 数组形状，来源见 `conv_source` | 优先 `session`，缺失时依次退到 `conv`、hook 自身或账本行引用 |
| `actor` | 组身份：`subagent` 优先，否则等于会话 | 同一 `conv_key` 下的子代理按 actor 各自成组 |
| `actor_state` | `known` / `unknown` | 未知归属的请求不进派生队列，不产生关系结论 |
| `via` | 出生通路：`through` / `hook` / `rejected` / `otlp` | 回答这一行从哪条通路生出来，不是流量种类；账本 `direct` 行的摄入当前未启用。`otlp` 行独立存在，不参与 magpie 三路合并 |

归属未知的请求照样保存、照样能在页面读到，只是没有前驱关系、增量与链角色。这是设计选择：缺归属不等于缺记录。

## 读数

读数分两组，不能混。

**最终回复**：`status`、`stop`、`model_requested`、`model_served`、`provider`、`in_tok`、`out_tok`、`cache_read`、`cache_write`、`reasoning`、`cost`、`ms`、`ttft_ms`、`flow_ms`、`first_text_ms`。

**整笔尝试总量**：`attempt_count`、`attempt_billed`、`attempt_in`、`attempt_out`、`attempt_cache_read`、`attempt_cache_write`、`attempt_reasoning`、`attempt_cost`。这组在关联完成时就算好写进 `request`，不依赖原始层还在：原始账本第 8 天过期后，前一次被转交的尝试消耗仍有承接的地方。`attempt_billed` 计真正产生计费的尝试，`attempt_count` 取路由 `tries` 的长度，两者不相等是正常的。

费用四态写在 `cost_state` / `attempt_cost_state`：`priced`、`zero`、`unpriced`、`absent`。`absent` 是「没有观测到」，不是零。

## 正文

正文按消息存，不按请求存全文。Anthropic 与 OpenAI 都是全上下文重发，第 N 轮请求带前 N-1 轮全部内容，按请求存全文是 O(N²)，真正新增的只有 O(N)。做法是按内容哈希去重：`request_block` 记请求的消息位置，`block` 记去重后的片段。

| 表 | 内容 |
| --- | --- |
| `block` | `hash`（字节哈希，只服务去重与还原）、`fingerprint`（语义指纹，服务派生比对）、`z`（zstd 压缩的消息）、`raw_size` |
| `request_block` | `(req_id, ord)` 指向 `block`，`role` 用 0 user / 1 assistant / 2 system / 3 tool / 4 unknown |
| `request.skeleton_z` | 去掉 `messages` 的请求骨架与回复，格式 1，带 `protocol`、`has_messages`、`redact_version` |

两个哈希分工明确。`hash` 只在字节完全相同时复用块；`fingerprint` 去掉 `cache_control`、`signature` 这类传输标记、键排序、统一消息片段形状后取 sha256，用来判断「这一笔是不是上一笔的续写」。拿 `hash` 做比对会把整条链读断：缓存断点移动、`content` 从数组换成字符串、harness 重新包装都会换掉字节。

`body_state` 四态：`pending`（等 hook）、`available`（可读）、`partial`（只拿到部分，原因在 `miss_reason`）、`evicted`（按预算回收，原状态留在 `body_prev_state`）。类型里还声明了第五个值 `unsupported`，当前没有写入方；协议认不出的正文照样保存，`parse_state` 记 `unsupported`。OTLP 行出生时是 `summary`：只有 span 摘要，Claude Code 的 body_ref 接线成功后转 `available`，读不到指针则停在 `summary` 并记 `body_ref_read_failed`。`msg_count` 为 NULL 或块引用不连续的正文不可比较，派生记 `unknown` 而不是猜。

## 派生结论

派生按 `(conv_key, actor)` 分组重算整条链。结论落在两类地方：组的发布代（`derive_request_result` 等表）或 `request` 的同步旧列；读侧由队列上的 `published_generation` 指针整组切换，不出现标题取发布代、摘要取同步列的混拼。

| 结论 | 字段 | 取值 |
| --- | --- | --- |
| 前驱 | `prev_req_id` / `prev_relation` | `first` / `confirmed` / `branch` / `unknown` / `aux` |
| 新增 | `delta_ordinals` | 本笔相对父节点的消息序号 |
| 链角色 | `chain_role` | `main` / `branch` / `aux` / `unknown` |
| 请求种类 | `req_kind` | `chat`、`title`、`auto-mode-classifier` 等；未知值原样返回 |
| 链参与 | `purpose_chain` | `participate` / `exclude` |
| 标题 | `title` / `title_source` / `model_title` | 用户首句、模型时间兜底，或 Title Generator 的正式标题 |
| 折叠行摘要 | `input_preview` / `input_preview_kind` / `reply_preview` | kind 取 `delta` / `tail` / `tool_result` / `title` |
| 回复形状 | `reply_shape` | `final` / `tools` / `unknown`；只有 `final` 能当轮次终点 |
| 中断计数 | `interrupt_count` | 按确定增量归属，同一标记跨请求只计一次 |
| 工具配对 | `tool_call` 的 `state` | `resolved` / `pending` / `ambiguous` |

关系取值要分清：`branch` 是有更早请求但没有一个的序列是本笔前缀；`unknown` 是更早的请求里有正文不可读的，链断了。`unknown` 不能升级成 `branch`，不可读的祖先可能正是真正的父节点。

## 置信度：结论是不是「当前」

这是这套格式最容易被误读的地方。派生列不是「值或空」，而是带状态：

| `derived_state` | 含义 | 读侧行为 |
| --- | --- | --- |
| `current` | 用途已判定、组已完成、完成的修订与算法都是当前目标 | 派生列放顶层，可当结论读 |
| `dirty` | 结果还没追上输入 | 派生列移到 `historical`，顶层给中性值 |
| `retained` | 正文已回收，摘要按旧值保留 | 同上 |
| `legacy` | 从未按当前算法算过 | 同上 |

非 `current` 的行，关系为 null、链角色为 `unknown`、摘要为 null，标题退到不依赖正文的那一档。这样界面上不会出现「看起来像当前结论」的旧值。

同一条认识论贯穿全库：`missing` 是没有观测到；`ambiguous` 是观测到多个候选、不挑一个；`unknown` 是有观测但推不出结论；`unproven` 是同一毫秒的先后证不了；`retained` 是旧结论原样保留。确定结论只认 `derived_state='current'`。

## 阅读版本

页面读取时附带 `reading_token`（`r1-` 加 64 位十六进制）。它绑定一笔请求的轨迹输入与派生位置：输入修订、组代际、发布指针、正文状态与用途身份变化都会换发，只改费用不换。正文与工具结果接口携带 `if_reading`，与当前身份不符返回 409 `reading_changed`，整笔作废并给出显式重读入口。

token 只是读取身份，不是认证凭证。

## 版本字段

每条记录带采集与算法口径，事后能区分数据由哪版规则产出：

| 字段 | 回答 |
| --- | --- |
| `magpie_version` | 这笔记录由哪个 magpie 版本采得；探测结果落在 `/api/stats` 的 `probe` 里，超已验证区间时 `verified` 为 false |
| `mapping_version` | 原始行按哪版字段映射变换 |
| `privacy_version` | 按哪版脱敏规则变换 |
| `redact_version` | 正文脱敏的规则版本 |
| `adapter_version` | 协议适配器版本 |
| `purpose_version` | 请求用途规则的版本 |
| `derive_version` | 这一行被重算过几次；只是历史计数，不表示按哪版算 |
| `summary_algorithm` | 摘要实际用的算法号 |

已验证的 magpie 区间是 `>=0.1.1294 <0.2.0`。超区间仍启动，但每条记录写 `magpie_version`，探测结果与 `verified` 标记落在 `/api/stats`；接口形状的假设集中在一个模块里，版本变了只改那处。

## 与「多 harness」的关系

派生层本身不绑定 harness：工具配对按 `call_id` 与消息位置，前驱按语义指纹的共同前缀，轮次按回复形状与命令位，标题按回复形状识别旁路请求。harness 差异体现在三处：

1. `agent` 标签由 magpie 给出，决定页面上的显示名。
2. 输入解释层剥包装标签：`<session>` / `<user>` 剥壳留内容，`<system-reminder>` / `<transcript>` / `<command-*>` / OMP 的 `<job>` / `<file>` / `<chat>` 整段丢弃。未知标签整段保留并标 `unrecognized`，不丢用户正文。
3. 协议适配器认 `anthropic` 与 `chat` 两种请求形状；其余协议正文原样保存，标 `unsupported`，没有逐条消息视图。

这三处都是单向适配：读懂某个 harness 写进 wire 的痕迹。新增 harness 支持意味着新增识别规则或协议适配器。
