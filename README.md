# agent-trace-collector

ATC 是本机 LLM 请求的轨迹记录器。它把经过 magpie 网关的每一笔请求落成一条结构化记录：请求体、回复、用量、耗时、路由决策，然后按会话把它们读成一条可以逐步骤翻看的轨迹。

用途有三个：看清某个 Agent Harness 在这一轮到底给模型发了什么、拿回了什么；定位失败、截断与重试发生在哪一笔；把不同 harness 的请求放进同一套读数、同一套轨迹结构与同一个会话列表里横向对照。

它挂在数据面旁边，不是代理。没在运行时，Agent 的请求照常走完，只是这段时间没有新记录。

真实数据有两条进路：装了 magpie 的走网关三路证据；harness 自带 OTLP 导出的（已实测 Claude Code 与 OMP），把 exporter 指到本机的 `/v1/traces` 与 `/v1/logs`，收 span 摘要与正文。两条也可以同时开。只想先看界面的话，下面的合成 demo 不依赖任何一条，也不碰真实数据。

## 能看到什么

**会话列表**按最后活动时间排，标出失败、待确认与缺正文。标题生成与分类器这类旁路请求不进主链，但它们生成的正式标题会被优先用来说明会话；旁路请求各自成会话时单独列在列表里。

**轨迹**是主体：中栏一行一个步骤，36px 高，只有序号、参与角色与内容摘要；工具调用与结果各自成行，按 `call_id` 与消息位置配对。点任意行，右栏定位到该步骤对应的协议来源。

**右栏**四个页签：读数（本次回复、请求结构、能力清单、用量与上下文、身份完整性）、正文（按 40 条一片翻页的原始消息）、工具（选中一次调用后有概览、参数、配对、Schema 四页）、路由（候选顺序与尝试链，并注明窗口过滤不保证完整留痕）。

**轮次带**贴在会话头下沿：一条用户命令到它的最终回复算一轮，跨多笔请求即时结算。点轮次看命令组与最终回复全文。

**会话汇总**给会话口径的合计：工具次数、失败数、中断次数、写入与读取路径、Skill、缓存命中、上下文峰值，以及覆盖缺口。

## 试一下

不需要 magpie，不需要任何真实数据：

```sh
bun install
bun prototypes/synthetic-server.ts
```

打开 `http://127.0.0.1:8770/?session=conv-synthetic-reading`。四个合成会话覆盖空状态排查、窗口分页、缺通道与轮次配对；合成服务只监听回环，不连真实库、不读令牌。

## 接真实流量

```sh
bun run start        # 127.0.0.1:8320
```

首次启动在数据目录生成 `read.token`、`hook.token`、`otlp.token` 与 `redaction.salt`，权限 0600，目录 0700。默认数据目录是 `~/Library/Application Support/agent-trace-collector`。可覆盖的项：`ATC_DATA_DIR`、`ATC_PORT`、`ATC_LEDGER_PATH`、`ATC_ROUTING_DIR`、`ATC_MAGPIE_URL`、`ATC_BODY_BUDGET`、`ATC_DISK_LIMIT`。监听地址写死回环，不接受配置成通配地址。

之后按数据进路选，两条也可以同时开。

### 走 magpie：三路证据，正文最全

前提是本机已经运行 magpie 网关（默认 `127.0.0.1:3425`），且已验证区间 `>=0.1.1294 <0.2.0`。超区间仍会启动，但采集的数据标未验证。不开 hook 时页面已经能读到账本与路由两路证据，但**没有正文**：请求体与回复只从 hook 来。

拿到正文要把 `plugins/collector.hooks.ts` 注册进 magpie 的插件配置，把 `hook.token` 交给它。插件入口文件名必须带 `.hooks.ts`，由 magpie 侧加载，本仓库不自动安装。插件只做三件事：请求期生成 `hook_id`、完成期上报完整对象、按固定码记录投递结果；不改正文、不做关联、不做脱敏。

投递预算固定：总 1500 ms、单次 600 ms、最多两次，只对网络错误与 408/429/5xx 重试，4xx 直接放弃。回调丢失按 best-effort 处理，不承诺补投；超限时发 metadata envelope（正文置空、带原始字节数与原因码），不截断 JSON。

没完成关联的 hook 请求留在 `pending_hook`，采集器每 5 秒按 response ID 重试一次；候选唯一才合并，多候选标 ambiguous。

### 走 OTLP：不装 magpie，harness 自己导出

已实测两个 harness：Claude Code 与 OMP。采集器收 `POST /v1/traces` 与 `POST /v1/logs`，认证用首次启动生成的 `otlp.token`。令牌文件是 32 字节裸二进制，环境变量里放它的 base64url 形式——直接 `cat` 文件会把非 ASCII 字节塞进 Authorization，请求在 HTTP 层就被判畸形：

```sh
ATC_TOKEN=$(base64 -i '<dataDir>/otlp.token' | tr '+/' '-_' | tr -d '\n=')
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8320
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $ATC_TOKEN"
```

带这两个环境变量启动 harness 即可，两个都按 OTel 标准变量读：

- **Claude Code**：LLM span 落成请求行；要逐笔正文再加 `OTEL_LOG_RAW_API_BODIES=file`，harness 把完整请求与回复写成文件、事件里带指针，采集器按指针读入并落库，正文完整不截断。
- **OMP**：span 落成请求行，正文一栏是结构化摘要（页面标「OTLP 摘要」）；它的 OTLP 不带逐笔正文通路。

同一会话同时开 magpie 与 OTLP 时，时间线里每笔调用会出现两行，一行 magpie 一行 OTLP，行上来源可区分；第一批不做自动合并。验证命令、错误码表与磁盘档位行为见[运维手册](docs/operations.md)的 OTLP 接入一节。

## 数据从哪来

magpie 三路证据各自补别人的缺失，收敛进同一个 SQLite 库；OTLP 是第四条通道，独立建行，不参与三路合并：

| 通道 | 拿什么 | 拿不到什么 |
| --- | --- | --- |
| magpie hook | 客户端协议请求体、合并回复、success、agent、session、model | 请求头、流内事件、provider 尝试、`route_id`；回调可能缺失 |
| 用量账本 | 状态、用量、`route_id`、`response_id`、provider、账户 | 请求与回复正文 |
| 路由历史 | 候选顺序、尝试、规则、亲和性、prompt 结构 | 窗口过滤不全留痕；只读盘、30 天滚动 |
| OTLP（harness 侧） | LLM span 的模型、用量、耗时与会话 id；Claude Code 另带正文文件指针 | 请求头、provider 尝试；OMP 只到摘要，无逐笔正文 |

连接靠两个键：`response_id` 把 hook 记录接到账本行，`route_id` 把账本行接到路由历史。OTLP 行靠 span 物理身份 `(trace_id, span_id)` 自持，第一批不与 magpie 行合并——同一会话双通道并存时时间线里每笔调用出现两次，行上来源可区分。

magpie 另有 OTLP 导出，但它的属性白名单里没有 `response_id`、`conv`、`subagent`、`archive`，正文以 `langfuse.observation.input` / `output` 两段文本发出。这些键正是三路证据的连接点，所以 magpie 自己的导出适合送观测平台，不能当本项目的证据源。这与上面的第四条通道不矛盾：表里接的是 harness 侧的 exporter（Claude Code、OMP 进程自己发的），属性键齐全；magpie 的导出器是网关侧的另一套白名单。

## trace 模型

记录单位是一笔请求，阅读单位是会话。数据形状的完整说明见 [ATC trace 格式](docs/trace-format.md)，术语边界见 [CONTEXT.md](CONTEXT.md)。六个概念够起步：

| 概念 | 含义 |
| --- | --- |
| request | 主实体。带正文、回复、读数与路由去向，`req_id` 自增不复用 |
| conv_key / actor | 会话归属键与组身份。子代理与主会话共用 `conv_key`，按 `actor` 各自成组 |
| prev_relation | 与前驱的关系：`confirmed` / `branch` / `unknown` / `first` / `aux` |
| purpose_chain | 这一笔参不参与主链。标题生成与分类器等旁路请求标 `exclude` |
| body_state | 正文当前能不能读。与 `have`（收到过哪几路证据）分开 |
| derived_state | 派生结论是不是当前。只有 `current` 能当结论读；其余三种在详情里以 `historical` 附上，列表不携带 |

`derived_state` 是这套模型最容易被误读的一处。派生列带置信度，不只是「有值或为空」：`dirty` 表示还没追上输入，`retained` 表示正文已回收、摘要按旧值保留，`legacy` 表示从未按当前算法算过。这三种情况下，关系、摘要与链角色都不放顶层。

## 边界与非目标

- **只记录 magpie 与已适配 harness 观察到的流量。** 不经过网关也不导 OTLP 的请求看不见。请求统计以已保存的观测范围为限，缺正文单独标明，不能把 hook 覆盖率当作总请求量。
- **不做代理。** 不转发、不改写、不拦截任何 LLM 流量。
- **不扫描 Agent 自己的会话文件。** 只读 magpie 自己写的三路来源：hook、用量账本文件、路由历史目录。magpie 从 Agent 会话文件里读出来的 direct 行不在账本文件里，当前不摄入。
- **不做跨 harness 的通用摄入协议。** 唯一的通用入口是 OTLP 的 `/v1/traces` 与 `/v1/logs`，接 harness 自己的 exporter；其余通用 trace 协议不做。`agent` 是 magpie 给出的客户端标签，OTLP 侧按 `service.name` 映射到同一值域；派生层是 harness 通用的，识别某个 harness 的 wire 痕迹是个别规则。新增 harness 支持意味着新增识别规则或协议适配器。
- **不做导出。** 当前没有对外 schema、没有导出端点、没有跨工具互操作。接口只服务本机页面。
- **不做告警、指标看板与多机聚合。**
- **不做服务端全文检索。** 正文在块里，建索引要把每块都解压一遍，写入与存储成本都不小。页面上的搜索只按会话标题与客户端标签过滤已加载列表。
- **正文预算驱动回收。** 默认正文 10 GB、总盘 16 GB，回收最旧正文到 90% 预算；总盘到 80% 只接元数据，到 95% 停止接收。回收的正文补不回来。
- **schema 不原地升级。** 升级前先停采集器，把旧数据目录移走或删除，让新版本建新库。旧库里的正文与派生结果一起丢弃。

运行数据不进仓库：数据库、WAL、日志与本地密钥都在数据目录。测试只用合成数据，真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。

## 与观测平台的分工

「这不就是 Langfuse 吗」是打开这个仓库时最常见的疑问。两者都在看 LLM 流量，但记录的东西不同。

Langfuse 这类平台的记录单位是一次 LLM 调用或一个 span：`input` / `output` 两段文本、耗时、成本、评分，用来回答「我写的应用表现如何」。ATC 的记录单位是一笔经过网关的请求：完整的脱敏协议对象、逐块可还原的消息、三路证据的对账结论，用来回答「这次会话到底发生了什么」。

能力表上的差异不如两件具体的事重要：

- **逐笔新增消息的比对。** ATC 保存逐条消息并按语义指纹比共同前缀，能回答「第 N 笔比第 N-1 笔多了哪几条」，并区分「另起一支」与「链断了」。观测平台以一次调用为记录单位，输入输出是发给模型的载荷，不做这一层序列比对。
- **组装后的上下文。** Langfuse 在[自己的集成文档](https://langfuse.com/resources/engineering/coding-agent-tracing)里写明：hook 读不到 `CLAUDE.md`、技能与自动加载内容对实际 system prompt 的贡献，看到的是对话与工具调用，而不是组装后的上下文。网关在发送点，看到的就是实际发出的请求体。

这两件事以外，平台明显更强：评测与数据集、提示词版本管理、多人协作与权限、聚合仪表盘与告警、跨机器共享。这些 ATC 都不做，也不打算做。

分工可以直说：**趋势与共享交给平台，逐笔原文与对账留在本机。** magpie 的 OTLP 导出本来就是给观测平台用的，两边可以同时开：同一批请求，平台侧看成本趋势与团队对比，本机侧读这次会话到底发生了什么。harness 侧 OTLP 也可以一份双发，本机收摘要与正文，平台收趋势。

受众边界讲清楚：本机必须有 magpie，或者用一个已适配的 harness（当前是 Claude Code 与 OMP）。两者都没有的话收不到任何数据——OTLP 通道不放宽这个边界，它只是把边界从「装 magpie」挪到「装 magpie 或已适配 harness」。

## 命令

```sh
bun install
bun run start            # 采集器，127.0.0.1:8320
bun test
bun run typecheck
bun run maintain <子命令> # 离线维护，要求采集器已停
bun run verify-cutover   # 只读比较 collector 与旧采集器的正文覆盖
bun run verify:notes     # 提交前
```

`maintain` 与 `verify-cutover` 必须带子命令，裸调用只打印 usage 并退出 2。

## 文档

- [ATC trace 格式](docs/trace-format.md)：主实体、正文切块、派生结论与置信度
- [架构设计](docs/architecture-design.md)：证据身份、存储模型、派生、容量与安全边界
- [运维手册](docs/operations.md)：维护命令、备份恢复、容量门槛、派生切片
- [验收记录](docs/acceptance.md)：各轮合成与真实流量的验收结果
- [项目定位](docs/project-overview.md)：记录单位与阅读入口的取舍
- [运行词汇表](CONTEXT.md)：术语定义与边界
- [文档索引](docs/README.md)
- [Demo 与合成场景](prototypes/README.md)
- [Agent Note 规则与决策记录](.agents/notes/README.md)
