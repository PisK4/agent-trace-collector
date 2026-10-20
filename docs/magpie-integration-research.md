# magpie 集成调研：身份、会话与可接入面

本文回答一个问题：如果新工程要复用 magpie 对 Agent 流量的识别结果，能从 magpie 拿到哪些事实，这些事实由什么机制产生，边界在哪里。

补充阅读：[机制与复用边界](magpie-mechanisms-research.md) 钉在 `开源源码@magpie-2374ffe`。该研究补充了模型与窗口选路、`Route.prompt`、`handed_on` 多行记账、OTLP 尝试 span、本地录制与插件形态。本文后续涉及请求失败就丢 hook、`success` 只看 error、OTLP 没有额外信息、正文只有 hook 的概括，须按新研究限定；正文表格中的旧采集数字、条件与时间保持原样，不算重测。

调研时间为 2026-10-20，对象是本机安装的 magpie 0.1.1294（`/Applications/magpie.app`，网关监听 `127.0.0.1:3425`），源码钉在 `开源源码@magpie-2c3c903`，文末给提交 permalink。文中每个结论后标注来源等级，等级词表见文末。

## 结论先行

值得复用 magpie 的地方在它已经做好的三件事：把一笔请求归属到某个 Agent、把同一段对话的请求归到一起、把一笔请求的路由结果与分析数据留在本地。它那份 Agent 名单的复用价值有限。

三件事各自的稳定性差别很大：

- Agent 归属是字符串匹配，规则简单到可以照抄，不需要调它的接口。
- 会话归属有两套标识：客户端自己声明的 session，和 magpie 对首条用户消息做哈希得到的 conv。两者互斥，覆盖的 Agent 群体正好互补。
- 路由与用量数据有两条通道：网关 API（JSON，可用）和路由历史文件（磁盘，可用）；GUI 的 `/api/*` 外部完全不可达。

新工程的最小可行形态是：用 gateway hook 拿请求与回复正文，用 usage ledger 拿权威元数据，两者按 `response_id` 连接。这条连接在实测中 100% 命中，前提是把两侧的 `chatcmpl-` 前缀统一去掉。

文中所有数字取自同一次采集（2026-10-20T15:57+08:00）。账本随使用增长，引用时必须带采集时间，否则复现不出同一个数。

## magpie 如何认人

### Agent 注册表

`internal/agent/agents.go:89` 的 `builtins` 声明了 63 个内置 Agent（Claude Code、Codex、Gemini CLI、OpenCode、Pi、omp、Cursor、Zed、Cline、Qoder、CodeBuddy、WorkBuddy 等），`internal/agent/agents.go:47` 另有 3 个 `others`（magpie 自己、curl、PI-Desktop），运行时再追加 omp profile 与 WSL 双胞胎。每个条目声明 `ID / Name / Icon / Aliases / Bin / Dir / UA`。

这张表里大部分条目需要本机安装了对应 CLI 才会被真正识别，除此之外它只影响 GUI 的图标和命名。

### 一次请求如何被归属

`internal/gateway/gateway.go:60` 的 `agentOf` 按固定顺序判断：

1. 请求携带 `Authorization: Bearer magpie-<id>` 时，直接取 `<id>`，不再看 User-Agent。这是 magpie 写给各 Agent 配置的专用 token（`TokenFor`，`internal/gateway/gateway.go:56`）。
2. Claude Desktop 与 Claude Science 两个特例。
3. User-Agent 以 `cursor` 开头的，归为 `cursor-local`。
4. 其余交给 `usage.AgentOf`。

`internal/usage/usage.go:333` 的 `AgentOf` 先做切分：按 `/` 截断，再按空格截断，转小写。然后先按 id 与别名精确匹配，再按 UA 前缀匹配。都不中时返回 UA 里的产品名本身；UA 为空返回 `other`。它不会返回 `Unknown`，也不会拒绝一个没见过的名字。

这条规则有两个直接后果，对新工程有用：

- 任何客户端都能用一个自定义 token 把自己命名成一个新 Agent，名字会原样出现在用量账本里（实测用 `magpie-mynewprobe` 得到 `agent: mynewprobe`，图标回落为 `generic`）。
- 因此账本里的 agent 字段是自我声明加启发式匹配的结果，不是身份凭证。

### GUI 的 Agent 接口拿不到

GUI 的 HTTP 接口由 `noFramedAPI`（`internal/gui/api.go:2242`）看守，非 magpie 窗口自身的请求一律 403。实测 `curl http://127.0.0.1:3425/api/state`、`/api/usage`、`/api/sessions` 全部返回 404，这些路由不在网关的 mux 上，由 webview 桥独占。

所以 63 个内置 Agent 的完整清单外部读不到。能读到的只有 `/v1/magpie/usage` 响应里的 `agents` 数组，它只列出当期有调用的 Agent（本机实测 9 个），每个给 `id / name / icon`。

结论：新工程不要指望从 magpie 拿到 Agent 目录，也不要复制那份 63 条表。只把 magpie 已经给出的 `agent` 字符串当一个带图标和显示名的标签用；需要补全显示名时，自己维护一份小映射。

## 外部可以调用的接口面

网关 mux 上所有 `magpie` 自有路由（`internal/gateway/gateway.go:645-655`）：

| 方法 | 路径 | 用途 | 访问控制 |
| --- | --- | --- | --- |
| GET | `/v1/magpie/usage` | 周期汇总，与 GUI 的 `/api/usage` 同一份 JSON | 本机，或局域网共享 + 网关 key |
| GET | `/v1/magpie/usage/requests` | 用量账本分页，带筛选 | 同上；受限 key 只看到自己的调用 |
| POST | `/v1/magpie/usage/requests` | 客户端上报自己直连厂商的调用 | 同上；浏览器来源另需 key |
| GET | `/v1/magpie/route?session=` | 某会话最近一次路由 | 本机，或共享 + key |
| GET | `/v1/magpie/trace` | 最近路由环形缓冲 | 仅本机，且不得经过代理 |
| GET | `/v1/magpie/quotas`、`/quotas/history` | 订阅额度 | 本机，或共享 + key |
| GET | `/v1/magpie/concurrency`、`/limit` | 并发与 key 限额 | 本机，或共享 + key |

`local` 的定义在 `internal/gateway/lan.go:547`：对端地址是回环，且请求头里没有代理或隧道的转发标记。`sharedWith` 在 `internal/gateway/lan.go:479`，表示局域网共享已开且请求带了启用的网关 key。

### 分页与筛选的真实语义

`GET /v1/magpie/usage/requests` 的 `limit` 缺省 100，上限 500（`internal/usage/request_page.go:405-407`）；`offset` 可以一直往后翻到末页。实测全量 49,042 行翻 99 页、耗时 17 秒，约 2,900 行/秒，末页按剩余行数返回。翻页期间有新行写入时 offset 会漂移，全量拉取要按记录自身的时间戳或 `route_id` 去重。

`period` 缺省是 `30d`（`internal/usage/usage.go:362-365`、`internal/usageapi/usageapi.go:160-165`）。这个缺省值只影响接口返回的时间窗，账本本身不裁剪：`Append`（`internal/usage/usage.go:227-251`）只追加，`Load`（`:266-288`）读全文件，源码里没有按大小或天数轮转 `usage.jsonl` 的路径。实测（2026-10-20T15:57+08:00）`period=all` 返回 49,056 行，缺省 `30d` 返回 28,657 行，差额是 30 天以前的记录；本机文件最早一行是 2026-10-12，即 magpie 开始记账的那天。

这条对回补有直接影响：能回补的元数据是账本实际覆盖的全部时间，从 magpie 安装那天起，不受 30 天窗限制。

direct 行的时间跨度比 through 长，方向和直觉相反。同一时刻全量扫描 31,071 行 direct，最早一行是 2026-08-20，最晚是 2026-10-13，覆盖 41 天；同期 through 只到 magpie 开始记账的 2026-10-12。原因在数据来源：through 由网关逐笔写盘，没装 magpie 之前一笔都没有；direct 是从各 Agent 的会话文件里读出来的，那些文件比 magpie 老。

按 `period` 看更清楚：`all` 下 direct 31,071 行，`30d` 下 10,672 行，`7d` 与 `today` 下为 0。`7d` 的 10,278 行里 10,277 行是 through，剩下 1 行是本地拒绝。所以两个来源的可用区间不同，一个是装了 magpie 之后，一个是会话文件还留着的全部时间。

筛选参数里有两个容易踩的坑：

- `via=` 只接受 `through` / `direct` / `reported` 三个值（`internal/usageapi/usageapi.go:173`）。传其它值不会报错，静默返回全部行。实测 `via=gateway` 与不加筛选时行数一致。
- `q=` 是若干字段的包含匹配，字段清单在 `internal/usage/ledger.go:183`：requested、model、served、upstream、provider、host、session、effort、账户与 key 名等。它不搜索 `rid` 与 `response_id`。实测 `q=msg_` 与 `q=resp_` 均为 0，`q=sess-omp-test` 命中 1 行。

`agent=` 是精确匹配，且比较前会过一遍 `ReportedAs`（`internal/usage/ledger.go:162`），因此受用户在设置里改写的 Agent 归并影响。

### 三种数据源

账本行按来源分三类，常量在 `internal/usage/ledger.go:91-96`：

- `through`：经过 magpie 网关的调用。
- `direct`：magpie 从各 Agent 自己的会话文件里读到的调用，网关从未见过；行的 `source` 为 `log`。
- `reported`：客户端通过 `POST /v1/magpie/usage/requests` 主动上报的直连调用。

`SourceOf`（`internal/usage/ledger.go:104`）还有一个隐含的第四类：被网关在本地拒绝的请求，既不属于 through 也不属于 direct，选任一筛选都会漏掉它。

本机一次全量扫描（2026-10-20T15:57+08:00）的结果：

| 来源 | 行数 |
| --- | --- |
| through | 17,981 |
| direct | 31,071 |
| reported | 0 |

不加 `via=` 时返回 49,056 行，比三者之和多 4 行；差额是网关在本地拒绝的请求，它们既不算 through 也不算 direct，随使用持续增长。

按 Agent 拆分（through / direct）：

| agent | through | direct |
| --- | --- | --- |
| omp | 16,179 | 5,022 |
| claude | 1,771 | 0 |
| codex | 0 | 13,479 |
| zcode | 1 | 6,917 |
| pi | 0 | 2,976 |
| dsh | 0 | 2,536 |
| workbuddy | 0 | 141 |
| curl | 21 | 0 |

表里没列出的还有留作探针的几条（ava-probe、crush、goose、mynewprobe、opencode 各 1–5 条），它们的作用见 Agent 注册表一节。

direct 占总量约 63%。magpie 不只记录经过自己的流量，它还会读 Codex、Pi、ZCode、DSH、WorkBuddy 等 Agent 自己的会话文件，把没走网关的调用也补进账本。

### 字节级细节

- `/v1/magpie/usage` 的 `sessions` 数组只包含声明过 session 的调用。实测 44 个会话、合计 1,871 次调用，而同期总调用 17,981 次。
- `trace` 环形缓冲只保留 60 条（`internal/gateway/trace.go:30`），仅存内存，重启即清空；`?after=` 长轮询在 handler 内最多等 25 秒（`internal/gateway/trace.go:673`）。
- `route` 接口返回的是裁剪后的对象，字段见 `internal/gateway/session_route.go:66`，不含 token 用量与 prompt 结构；长轮询上限 60 秒。
- 路由历史落盘在 `~/.config/magpie/routing/<日期>.jsonl(.gz)`（`internal/gateway/history.go:36`），保留 30 天、总量 200 MB、每天最多服务 2,000 条（`internal/gateway/history.go:30-32`）。这些文件没有任何 HTTP 出口，GUI 直接读盘。
- `Recent calls` 环形缓冲只有 40 条（`internal/gateway/gateway.go:474`），同样只有 GUI 能读。

## session 与 conv：两套会话标识

### session 是客户端声明的

`sessionOf`（`internal/gateway/gateway.go:6305`）按固定顺序取第一个非空头，截断到 128 字符：

```text
X-Magpie-Session
x-opencode-session
x-session-affinity
x-session-id
session_id
session-id
x-claude-code-session-id
x-conversation-id
x-deepseek-harness-session-id
```

magpie 不会为没有声明的请求编造 session。它也给部分 Agent 写好配置让它们声明：Pi 的 provider 块打开 `compat.sendSessionAffinityHeaders`（`internal/agent/agents.go:426`），omp 16.0.6 起设置 `compat.promptCacheSessionHeader: x-session-affinity`（`internal/agent/omp.go:677`）。

当客户端声明了 session，响应会带回同一个值（`internal/gateway/conversations.go:26`）。

### conv 是内容指纹

没有 session 时，magpie 计算 conv（`internal/gateway/gateway.go:6350`，调用点在 `internal/gateway/prompt.go:1172`）：

1. 解出请求体的 `messages` / `input` / `contents`。
2. 找第一个 `role` 为 `user` 的条目；Gemini 的 `contents` 里缺省 role 也算 user。
3. 对该条目反序列化后再序列化的字节做 sha256，取前 12 字节，拼成 `magpie-<24 位十六进制>`。
4. 请求体无法解析时，对整体字节做哈希。

这两个标识互斥：只要 session 存在，conv 就为空。实测 60 条 trace 中 60 条有 session、0 条有 conv；磁盘路由历史 17,993 行里 1,883 行有 session、16,110 行有 conv、0 行两者都有。

### conv 的可复现性

实测可以外部复现，但要按 magpie 的序列化方式：

- 请求体外层的空白与字段顺序不影响结果。
- 首条用户消息内部的对象键顺序会被保留；空白被去掉；转义字符被还原（`你` 还原成 UTF-8，`\/` 还原成 `/`）；数字按最短形式输出（`1e3` 变 `1000`，`2.50` 变 `2.5`）。
- 等价形式是一次重新序列化：去掉空白、还原转义、数字取最短写法、保留键序。简单做字节压缩得不出同样的哈希，直接对原始字节或其压缩结果哈希也对不上。
- 文本内容一旦不同，conv 必然不同；键顺序不同，conv 也不同。
- 哈希的输入是 magpie 自己改写之后的请求体：`redacted` 在 `internal/gateway/gateway.go:1564` 先跑，`convOf` 在 `:2249` 才调用。开启脱敏时，conv 落在占位符文本上。

因此 conv 只能判断两条请求是否来自同一段对话的同一个开头，不能反推内容。它也不是原文指纹：任何会改写请求体的设置（脱敏、模型别名规范化）都会改变它。

### 覆盖是互补的

磁盘路由历史中按 Agent 统计（17,993 行）：

| agent | 行数 | 有 session | 有 conv |
| --- | --- | --- | --- |
| omp | 16,179 | 101 | 16,078 |
| claude | 1,771 | 1,763 | 8 |
| codex | 12 | 12 | 0 |
| 其他 | 31 | 7 | 24 |

omp 的 session 覆盖只有 0.6%，conv 覆盖 99.4%；Claude Code 反过来，session 覆盖 99.5%，conv 只有 0.5%。

这就是新工程必须同时接两套标识的原因：只认 session 会丢掉几乎全部 omp 数据，只认 conv 会把 Claude Code 切成一个个假会话。

## 四条可接入面

| 接入面 | 拿得到什么 | 拿不到什么 | 代价 |
| --- | --- | --- | --- |
| Gateway hook（Bun） | 请求体、合并后的回复、agent、session、model、stream、cwd、origin | 请求头、凭证、流内事件、每次 provider 尝试 | 旁路，best-effort，可能丢 |
| 用量账本 API | 元数据全集、权威的状态与用量、路由 id、响应 id | 请求与回复正文 | 只能轮询，实测约 2,900 行/秒 |
| OTLP 导出 | 与账本同源的 span 与指标，可带正文 | 默认关闭，需要 collector | 额外依赖，正文 256 KB 截断 |
| 路由历史文件 | 每次请求的路由决策全过程 | 没有 HTTP 出口，只能读盘 | 依赖本机路径，30 天滚动 |

### hook 看到什么

`internal/gateway/middleware.go:91-94` 构造的上下文只有：`Origin / Protocol / Model / Stream / Path / Agent / Session / Cwd / Query`。其中 `Cwd` 与 `Query` 只有在请求体能被解析时才有值；cwd 是从请求正文里按各 Agent 的固定文案抠出来的（`internal/gateway/workdir.go:41`），认 Claude Code 的 `Primary working directory`、Codex 的 `<cwd>`、Pi 的 `<cwd>` 与 OpenCode 的 `Working directory` 四种写法（`internal/gateway/workdir.go:6-19`）。

实测 1,658 条 hook 记录里 817 条有 cwd。这 817 条全部是流式请求，802 条非流式请求一条都没有；反过来，856 条流式请求里有 39 条也没有 cwd，都是 omp 发出的，其正文用 `<system-reminder>` 里的 `current working directory:` 报目录，不在这四种写法之内。所以 cwd 的有无取决于请求体里有没有那种能被解析的文案，与流式与否相关但不对应。

hook 拿到的请求体是脱敏前的，回复是已按协议合并后的完整对象；投递是 fire-and-forget，关停、宿主退休、超过 8 MiB、请求失败都会丢通知。

middleware 是另一条路，但它跑在网关进程里的 moejs（用 Go 写的 JS 引擎），不提供 Node 运行时。它每个请求的钩子只有 250 ms（单个流事件 50 ms），失败信息只能写进日志，而日志每分钟最多 60 行（`docs/subsystems/gateway-middleware.md`）。它能把请求体改掉，却送不出数据。要往外送只能用 hook，hook 的默认时限是 1 秒，可用 `gatewayTimeoutMs` 调到 10 秒（`internal/plugin/host.js:1279`）。

### 账本是权威

账本行包含 body 里没有的事实：`route_id`、`response_id`、`rid`、`status`、`ep`、`tries`、`providerAccount`、`kind`。这些字段的赋值点分散在网关主流程，是 magpie 自己记账的结果。

反过来，账本没有正文，且 direct 行没有状态码与请求 id（`ep`、`route_id`、`rid` 全为空），因为它读的是会话文件，只能拿到文件里写了什么。

全量扫描的字段覆盖率：

| 字段 | through（17,981 行） | direct（31,071 行） |
| --- | --- | --- |
| session | 10% | 100% |
| response_id | 96% | 20% |
| route_id | 100% | 0% |
| rid | 65% | 0% |
| ep | 100% | 0% |
| providerAccount | 99% | 0% |

### 两条连接键

**response_id**：hook 记录与账本行之间的桥。实测 1,630 条带 response_id 的 hook 记录，全部能在账本里找到对应行，命中率 100%。

这条命中依赖一次规范化。同一个响应在 hook 里带 `chatcmpl-` 前缀，在账本里可能是裸十六进制，两者是同一个值。源码注释也点明了这一点：上游 ID 可能缺失，也可能被加上协议前缀（`internal/gateway/response_id.go:6-8`），所以账本记录的是编码器最终写出的那个 ID（`:26`、`:46`）。实测 1,630 条里有 39 条需要去掉 hook 侧的 `chatcmpl-` 才能命中，账本侧没有需要反向补前缀的情况。直接按原字符串比对会得到 97.6%，看起来像有丢数据，实际是格式差异。

**route_id**：账本行与路由历史之间的桥。实测账本里 17,981 个 route_id，全部能在 `~/.config/magpie/routing/` 的文件里找到对应路由（17,981/17,981），路由文件里的 id 本身唯一。

这两条连接成立的前提不同：response_id 来自厂商回复或网关生成，route_id 来自 magpie 自己的计数器。

### OTLP 是第三条路

内置 `otel` 插件默认关闭，打开后每个请求生成 span 与指标。属性名已核对（`internal/otlp/otel_wire.go:37-151`）：`gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`magpie.agent`、`gen_ai.usage.*`、`magpie.ttft_ms`、`magpie.route.id`；会话态 span 额外带 `langfuse.session.id`。

配置入口是 `settings.json` 的 `otel` 段或五个环境变量 `MAGPIE_OTEL_ENABLED / METRICS / BODIES / BODIES_WHOLE / SESSIONS`，外加 `MAGPIE_OTEL_ENDPOINT` 与 `MAGPIE_OTEL_HEADERS`（`internal/settings/otel.go:64-76`）。带正文时默认在 256 KB 处截断（`internal/otlp/otel_sessions.go:73`）。

对 trace 工程来说 OTLP 的价值主要在生态兼容（Langfuse、任意 OTel collector），不在信息量：它没有比账本多出任何字段。

## 对新工程的建议

### 把身份拆成四个轴

不要做一个 agent/session 的二元模型。至少四层：

- `agent`：字符串，直接采用 magpie 或 UA 的结果，保留原文，不做枚举。
- `session`：客户端声明，权威，用于跨 Agent 对齐。
- `conv`：内容指纹，只在没有 session 时使用，用于把 omp 这类不说话但重复首条消息的流量聚起来。
- `subagent`：`x-claude-code-agent-id` 与 `x-claude-code-parent-agent-id`（`internal/gateway/gateway.go:6322`），Codex 侧另有会话文件推出的 actor 关系。

会话主键建议写成 `session or conv`，并把用的是哪个标在行上。

### 最小形态

```text
agent ──> magpie gateway ──> provider
               │
               ├── hook POST ──> 正文库（请求体 + 合并回复 + 身份）
               └── usage ledger ──> 元数据库（状态、用量、route_id、response_id）
                                          │
                                          └── response_id 连接
                                          └── route_id → routing/*.jsonl 取路由决策
```

理由：

- 正文只能从 hook 拿，账本里没有。
- 权威元数据只能从账本拿，hook 里的 `success` 只是一个布尔，且会因为丢通知而与事实不符。
- 两条通道都会漏：hook 会丢投递，账本会漏掉没有 session 也没有 response_id 的行。把两边都当证据，缺哪边标哪边。

### 不要做的事

- 不要复刻 Agent 注册表。magpie 的 63 条表随版本变化，且外部不可达；自己只需要一个显示名映射，未知 id 原样显示。
- 不要用 conv 做去重。同一段对话的第二次请求如果改了首条消息（重开会话、编辑后重发），conv 会变；反过来，两个 Agent 的相同提示词会得到相同 conv。
- 不要把 hook 的 `cwd` 当可靠字段。它取决于请求体里有没有那种能被解析的文案，实测非流式请求一条都没有。
- 不要假设 route_id 永远可连。direct 行没有 route_id；超过 30 天或超过 200 MB 的路由历史会被裁掉。

## 边界与坑

- 分页上限 500 行，没有游标，只能用 offset；全量拉取需要自己算翻页次数。
- trace 环只有 60 条，重启即空，且只对本机开放。需要历史就要自己落库。
- 路由历史没有 HTTP 出口，读盘路径依赖 `~/.config/magpie`；换成非默认配置目录时会变。
- hook 是 best-effort。丢一条通知与请求没发生不可区分，所有结论都要写成下界。
- hook 里的 `success` 不可靠地表示业务成功：它判断的是回复有没有 error 字段。
- conv 依赖 magpie 的序列化方式。外部复现要按重新序列化后的字节哈希；直接对原始字节哈希会失败。
- `via=` 传错值会静默返回全量，写代码时要做白名单校验，不要透传用户输入。
- `q=` 不搜 response_id 与 rid。按响应 id 找账本行必须全量拉取后本地索引，或者用 `route_id` 反查。
- response_id 两侧的写法不一定一致。同一个响应可以在 hook 里带 `chatcmpl-`、在账本里不带；比对前要把前缀统一去掉，否则会得到约 2% 的假缺失。
- 分页期间有新行写入时，offset 会漂移。实测全量扫描时账本没有新增，未观察到漏行；采集器要按时间窗口或记录自身的时间戳去重，不要假设翻页是一致快照。
- 账本会带出 `providerAccount`（订阅账号，通常是邮箱）、provider key 名、caller key 名、目录名。这些数据只应留在本机，不要进仓库、不要上报。
- 浏览器页面对这些接口基本不可用。网关对 localhost 来源不拦（`foreignPage` 放行），但只有列进设置 `CORSOrigins` 的页面才会收到 `Access-Control-Allow-Origin`（`internal/gateway/cors.go:199`），实测普通 localhost 页面拿不到该响应头，浏览器会拦住读取；预检请求本身返回 404。新工程要做网页前端，就用自己的后端代理，不要试图在浏览器里直连 3425。

## 事实来源与来源等级

本文使用的等级定义（逐字照抄自共享词表）：

| 等级 | 含义 | 稳定性 |
| --- | --- | --- |
| `协议` | 公开协议或 provider 公开 API 规范定义的字段、取值与关系 | 只随规范版本变化 |
| `厂商文档` | 厂商产品或运行时文档明确承诺的语义，未进入公开协议规范 | 产品可在无协议版本变更时改变 |
| `SDK 生成` | 官方 SDK 代码生成器统一注入或生成的字段 | 字段名跨使用该 SDK 的全部客户端稳定，取值随运行环境变化 |
| `实测` | 受控采集下可复现的行为，未被任何官方文档承诺 | 受客户端版本约束 |
| `版本锁定` | 针对特定客户端版本或特定源码快照逆向得到的实现事实，包括本地文件布局、落盘结构与源码控制流 | 任何版本发布都可能改变 |
| `推断` | 从以上事实外推的解析或判定规则，不是事实 | 不稳定，仅供参考 |
| `未知` | 当前证据不能推出的内容 | — |

各节结论的等级归属：

- Agent 注册表条目数、`agentOf` 与 `AgentOf` 的判定顺序、session 头优先级、conv 的哈希算法与截断长度、账本字段清单、三种来源常量、分页上限、路由历史保留策略、OTLP 属性名与配置项：`版本锁定`，物证 `开源源码@magpie-2c3c903`，按正文的 `文件:行号` 解析到该提交。
- GUI `/api/*` 外部不可达：`版本锁定`（`noFramedAPI`）加以 `实测`（curl 得到 404）互相印证。
- 本机账本行数、按 Agent 与来源的分布、字段覆盖率、session 与 conv 的覆盖差异、response_id 与 route_id 的连接命中率、conv 的序列化行为、hook 的 cwd 覆盖率、`via=` 与 `q=` 的实际语义、分页吞吐：`实测`，物证 `采集@2026-10-20-magpie-0.1.1294`，采集前提是本机 loopback 直连、未开启脱敏、网关共享关闭。
- middleware 跑在 moejs 里、hook 的上下文只含九个字段：`版本锁定`（`docs/subsystems/gateway-middleware.md`、`docs/subsystems/gateway-request-hooks.md`、`internal/middleware/middleware.go:1-14`），并以 `实测` 的 AVA hook 跑通结果印证。
- 关于新工程应如何取舍的建议：`推断`。

## 物证声明

- `开源源码@magpie-2c3c903`：magpie 上游仓库，提交 [yetone/magpie@2c3c903](https://github.com/yetone/magpie/tree/2c3c903974b65c145f9f009d83a2cf7e0fb3ee01)，对应标签 `v0.1.1294`。正文行号按该提交核对，核对方式为以 `--filter=blob:none --sparse` 检出该提交后读源码。
- `采集@2026-10-20-magpie-0.1.1294`：本机 magpie 0.1.1294 网关（`127.0.0.1:3425`）的一次性读数，采集脚本只调用 `GET /v1/magpie/usage`、`GET /v1/magpie/usage/requests`、`GET /v1/magpie/trace`、`GET /v1/magpie/route`，并只读扫描 `~/.config/magpie/routing/` 与 AVA 的 evidence 库。所有数字随本机使用增长而变化，引用时须带采集时间。
