# 收敛型技术架构设计

产品范围与字段语义以[项目定位](project-overview.md)和两篇 magpie 研究为准，这里不复述，只补它们没有回答的架构问题。两轮独立评审的意见已全部落进正文，[architecture-review.md](architecture-review.md) 是原始记录，逐条对照在文末。

文中数字是 2026-10-20 20:48 至 22:10 在本机的实测快照。账本与路由随使用增长，引用时必须带时间。

## 这份文档定什么

已确认的五件事：

1. 技术栈用 TypeScript + Bun。
2. AVA 停用，后续以本项目作为 Agent trace 的唯一跟踪入口。
3. 版本锁从单点改为区间加形状探针。
4. 正文存储按滚动 10 GB 预算回收，上限可配置。
5. direct 行第一版可不做。

设计目标是承载本机后续全部大模型调用的记录流量，功能点以现有阅读页面已覆盖的为准，不扩范围。

## 事实基线

这一节是设计依据，所有数字都用同一套度量方法重新测过。

### magpie 实际状态

| 项 | 值 |
| --- | --- |
| 运行版本 | 0.1.1296（`last-version` 与 `Info.plist` 一致） |
| 源码基准 | `repos-external/magpie` @ `2374ffe` |
| 网关监听 | `*:3425`（IPv6 通配），回环可达 |
| 账本文件 | `~/.config/magpie/usage.jsonl`，20,470 行，10.9 MB |
| 路由历史 | `~/.config/magpie/routing/`，2026-10-20 4,439 行，22 MB / 8 个日期文件 |
| 脱敏设置 | `settings.json` 未设置 `redact`，即关闭 |
| hook | AVA 的 hook 注册在 `plugins.json`，端点 `127.0.0.1:8319`，未设 `gatewayTimeoutMs`（取默认 1000 ms） |

### 流量与规模

| 指标 | 实测 |
| --- | --- |
| 2026-10-20 through 请求 | 4,288 行（当日 20:48 快照） |
| 峰值 | 57 次/分钟（16:16），约 1 次/秒 |
| 最大会话 | 1,825 笔请求 |
| 单笔请求体 | 中位 346 KB，p90 1,091 KB，p99 2,162 KB，最大 3.9 MB |
| 超过 2 MB 的请求 | 98 / 3,504，2.80% |
| 单请求消息数 | 中位 42，p90 389，最大 665 |
| 2026-10-20 prompt token | 4.612 亿，单笔最大 245,588 |

### 协议分布

按账本 `ep` 的客户端侧计，同一时点 4,433 笔：

| 客户端协议 | 笔数 | 占比 |
| --- | --- | --- |
| Anthropic Messages | 3,616 | 81.6% |
| OpenAI Chat Completions | 817 | 18.4% |
| OpenAI Responses | 0 | 0 |
| Gemini | 0 | 0 |

另有 213 笔 `ep` 形如 `/v1/messages → /v1/responses`，是客户端用 Anthropic、上游用 Responses。hook 保留的是客户端形状，所以这 213 笔仍按 Anthropic 解析。

### 三通道连接质量

| 检查 | 结果 |
| --- | --- |
| `route_id` 账本到路由 | 4,288 / 4,288 |
| `ms` 两侧相等 | 4,288 / 4,288 |
| `prompt.tokens = in + cache_read + cache_write` | 4,271 / 4,288，99.60% |
| `sum(parts[].tokens) = prompt.tokens` | 4,287 / 4,287 |
| hook `response_id` 规范化后到账本 | 3,435 / 3,435 |
| 会话键可合成（ledger session 或 route conv） | 4,288 / 4,288 |
| 账本 `route_id` 出现多于一次 | 0 组（20,470 行全量）；`handed_on` 出现 0 次 |

17 条不满足提示量等式的行里，16 条是 status 499 的客户端取消，1 条是 `usage` 与 `tries` 对不上的重试。

这些比例是某次样本的观察，不能单独当正确性判据。它们只用来确认形状，验收要用守恒关系：输入行数、唯一请求数、尝试行数、待关联数与缺失数之间必须对得上。

### 正文覆盖率

以 13:00 之后的账本行为分母（3,664 笔带 `response_id`），按 AVA 库实测：

| 状态 | 笔数 | 占比 |
| --- | --- | --- |
| 有可用正文 | 3,480 | 94.98% |
| 记录存在但正文被截断 | 98 | 2.67% |
| 完全没有回调 | 86 | 2.35% |

截断的那 98 笔不是 magpie 造成的。AVA 自己的 `max_capture_bytes` 默认 200 万字节（`config.py:71`，`hook_ingest.py:130`），原始正文中位 2.17 MB、最大 4.0 MB，被切在 2 MB 处，骨架因此不是合法 JSON。这是本项目不能照抄的设置。

完全没有回调的 86 笔集中在超大请求：prompt token 在 19 万以上的 423 笔里有 74 笔没有回调，占 17.5%；19 万以下的 3,241 笔里只有 12 笔，占 0.37%。截断同样集中在这个量级：423 笔里 59 笔被切。同会话的命中与缺失并发中位数都是 1，AVA 同时段摄入耗时中位 25 ms，与其他时段相同，所以不是并发或服务端慢导致的。

### 内容复用

最大那段会话（1,618 笔可解析请求）实测：

- 块引用 241,214 次，对应 4,887 个不同哈希；
- 引用字节 1,261.6 MB，块级去重后 142.7 MB，11.3%；
- 剥掉 `cache_control` 再做规范哈希，不同块降到 3,474 个，字节 139.4 MB，11.0%。

`cache_control` 影响的是哈希个数，不是字节量。42% 的块含这个字段，但标记本身很小，规范化的存储收益只有 2.3%。第一版不做规范哈希，理由见存储模型一节。

这 1,618 笔摊下来，每笔正文的边际新增内容约 88 KB 原文，按 zstd 实测 3.45 倍压缩后约 26 KB。

### Bun 运行时能力

本机 Bun 1.4.0 实测：

| 能力 | 结果 |
| --- | --- |
| `zlib.zstdCompressSync` / `zstdDecompressSync` | 可用 |
| `bun:sqlite` WAL | 可用，第二个连接能在写事务期间读 |
| FTS5 | 可用 |
| STRICT 表、WITHOUT ROWID | 可用 |
| `auto_vacuum` 默认值 | 0（不回收），文件删数据后不缩 |

zstd 压缩级别的 `level` 参数不生效。`zstdCompressSync(buf, { level: 9 })` 会被静默忽略，永远按默认级别 3 压缩，不报错。要用 `{ params: { [constants.ZSTD_c_compressionLevel]: 9 } }` 才生效。实测 478 KB 样本，`level: 19` 与 `level: 3` 输出字节完全相同，`params` 写法才从 2,401 字节降到 1,504 字节。

用真实的 11,187 个块（293 MB）与 3,442 个骨架（82 MB）测各级别：

| 级别 | 块压缩比 | 块吞吐 | 骨架压缩比 | 骨架吞吐 |
| --- | --- | --- | --- | --- |
| 1 | 3.21 | 781 MB/s | 2.68 | 810 MB/s |
| 3 | 3.45 | 660 MB/s | 2.72 | 617 MB/s |
| 9 | 3.75 | 148 MB/s | 2.74 | 176 MB/s |
| 19 | 3.94 | 8 MB/s | 2.86 | 14 MB/s |

正文用级别 3。级别 9 只多 8% 空间却慢 4.5 倍，19 更不值得。

端到端回放实测（3,442 笔真实请求、971,635 条引用、真实引用数分布）：

| 指标 | 值 |
| --- | --- |
| 写入耗时 | 1,469 ms，2,343 笔/秒 |
| 库体积 | 153.5 MB，43.6 KB/笔 |
| 会话列表页（100 行） | 0.17 ms |
| 合并最重的一笔（526 块，14.2 MB） | 13.7 ms |
| 取 40 条消息（带解压缓存） | 0.13 ms |
| 相对上一笔算增量（167 条消息） | 0.17 ms |

表体积：`block` 89.6 MB，`request` 32.8 MB（骨架压缩后约 9.5 KB/笔），`request_block` 15.8 MB，块引用索引 13.6 MB，其余不到 1 MB。

单次事务提交延迟（含分块、哈希、zstd、引用写入）：

| 正文大小 | 提交延迟 |
| --- | --- |
| 1.55 MB / 900 条消息 | 中位 6.8 ms，最大 12.2 ms |
| 3.82 MB / 2,264 条消息 | 中位 15.2 ms，最大 18.4 ms |

这个数字是去掉 spool 的依据，见进程模型一节。

### 必须写进设计的陷阱

`serveAgent` 先调 `gatewayHooks` 再调 `serve`，而 `serve` 内部才跑 `redacted`（`internal/gateway/middleware.go:26`、`internal/gateway/gateway.go:1564`）。也就是说 hook 拿到的是脱敏前的正文，当前 `redact` 未开启时就是原始凭证。脱敏必须由 collector 自己做，不能指望上游。

两个文件都不适合按时序读。一次 20,034 行的扫描里有 3,758 处相邻时间倒退，最大倒退 810 秒；路由的 id 唯一但不递增，同一批 4,288 条里有 370 处相邻递减。时间戳和 id 都不能当读取游标。

账本文件的内容比接口少。20,470 行全部是 through，`source` 这个键在文件里根本不存在，31,072 条 direct 记录只能从 `/v1/magpie/usage/requests?via=direct` 拿。`cost` 与 `priced` 同样一次都没出现：文件直接序列化 `usage.Record`，其中可选的 `OwnCost` 只在客户端自报时才有值，按定价算出的这两个数只存在于 API 返回的 `Row` 里。

请求体超过 32 MiB 时 hook 根本不跑。`gatewayBegin` 把请求体作为参数发给插件，并要求插件把 `body` 原样回显，插件写回宿主的单行受 `maxWireLine = 32 MiB` 约束（`internal/plugin/host.go:154`）。超线时 `gatewayBegin` 返回 `nil`，`gatewayHooks` 直接放行，整笔请求连 hook 都不跑，也不报错。本机最大请求 3.9 MB，离得很远，但这是静默失效的一类。

回复超过 8 MiB 时会被主动置空。`gatewayResponse` 里 `capture.full.cut()` 为真就 `run.Finish(ctx, nil, false, body)`，hook 收到 `reply = null` 与 `success = false`（`internal/gateway/gateway_hooks.go:22`）。这是收到 null 回复与没收到 hook 必须分开记录的原因之一。

### 账号身份与 LAN

`/v1/magpie/usage/requests` 会带出 `providerAccount`（常见是手机号或邮箱）、`providerKeyId`、`host`。本机 `lan` 为 true，网关在 `*:3425` 上监听，局域网可达（需要网关 key）。这些字段只应留在本机，不进仓库、不上报。hook 侧已有 `origin` 判定（`local` / `remote` / `gateway-key`），collector 默认只收 `local`。

## 已定决策与由此产生的约束

| 决策 | 直接后果 |
| --- | --- |
| TypeScript + Bun | 单进程、单语言；hook 与后端共用类型和脱敏实现；`bun:sqlite` 与 `node:zlib` 原生可用，不引第三方依赖 |
| AVA 停用 | 需要先做正文并轨：新 hook 上线后 AVA 停用，切换窗口内的请求只有账本与路由 |
| 版本锁改为区间 | 启动时探测，超区间仍启动但降级，每条记录带采集版本 |
| 滚动 10 GB | 正文预算与总磁盘上限分开定义；元数据不参与回收 |
| direct 第一版不做 | 账本摄入只处理 through 与 rejected；direct 走同一个表结构但开关默认关闭 |

## 系统边界与进程模型

一个常驻进程，共用一个端口，只绑 `127.0.0.1`。

```text
magpie gateway
  ├─ hook POST ─────────────> /hook/ingest ──┐
  ├─ 账本文件（只读）───────> ledger tailer ─┤
  ├─ 路由文件（只读）───────> route tailer ──┼─> reconciler ─> SQLite（WAL）
  └─ 用量接口（只读）───────> direct 回填 ───┘                   ▲
                                                                │
harness OTLP exporter（Claude Code / OMP / Codex）
  └─ POST /v1/traces、/v1/logs ─────────────────────────────────┘

浏览器 ─────────────────────────────────────────> /api/*
```

进程内分四个职责，跑在同一个 Bun 事件循环里：

| 职责 | 触发方式 | 作用 |
| --- | --- | --- |
| ingest | HTTP 请求 | 脱敏、分块、入块库、写 `raw_hook` 头与 `request`，事务提交后返回；OTLP 端点同走这里：解码、映射、落 `raw_otlp_*` 与 `otlp_body_ref` |
| tailer | 定时（账本 5 秒，路由 2 秒） | 按文件代际与完整行偏移增量读两个来源 |
| reconciler | 定时（1 秒）加 ingest 完成事件 | 合并证据、补前驱、重算受影响派生 |
| query | HTTP 请求 | 只读查询 |

两个摄入端点 `POST /v1/traces` 与 `POST /v1/logs` 收 harness 侧 OTLP。Bearer 认证用独立的 `otlp.token`，与 `hook.token` 分开——一份密钥不进两份上游配置。content-type 只收 `application/x-protobuf` 与 `application/json`，非白名单的简单请求形态直接 415：浏览器防线三件套（预检、Host 校验、显式拒绝非白名单 content-type）与 hook 共用同一段。解码失败 400 带原因码，单飞守卫共用（429），整批上限 64 MiB（413），95% 磁盘档整批拒绝（507），成功回 OTLP 规范的 `{"partialSuccess":{}}`。

span 选取按 `(service.name, 规则)` 白名单：Claude Code 按 span 名 `claude_code.llm_request`，OMP 按 `gen_ai.operation.name='chat'`，Codex CLI 按 span 名 `session_task.turn`（用量键是自有 `codex.turn.token_usage.*` 族，无正文与回复侧模型；`service.name` 取 originator，按 `codex_exec` / `codex_cli_rs` 等一族取值收）。白名单外的服务不建行：span 只落原始层，并按服务与日聚合记 `service_not_registered` issue，未登记 harness 指向端点这件事可被发现（对外规范见[接入 profile](otlp-exporter-profile.md)）。OTLP 行不参与三路合并，独立建 `request`（`via='otlp'`，`have` 第 4 位）。同一会话双通道并存时每笔调用出现两行，行上来源可区分；跨通道精确锚点（`gen_ai.response.id` 等）已实测存在，合并策略另评。

写操作全部走一个 writer，避免 SQLite 的 `database is locked`。实测第二个连接在写事务期间写会被拒绝，读不受影响。查询用独立只读连接。

后台任务通过 `commitUnit(store,name,prepare)` 先在只读连接准备意图，返回 null 时不打开事务，存在操作时立即交给 writer 同步提交。`write(fn,name?)` 的耗时按固定任务名累计到 `writer.by_name`，失败与回滚也计数；未命名写入归 `other`，指标快照不随后续写入变化。probe 仅在结果变化时持久化，`at` 表示该结果开始被观测到的时点；pending 每轮最多提交十个合并或新歧义，稳定候选不重复写；gap 每轮最多更新一百个状态变化，raw_prune 每来源最多清理一百条候选，已记过的未关联 hook 正文保留且不反复更新 issue。费用扫描的窗口重置只在内存发生，费用观测与页进度同事务提交；失败页不改进度，已结束窗口再次得到空页时不提交。

### 不做 spool

不做先落盘再异步入库的中间层。实测的提交延迟不需要它：3.82 MB 正文的一次事务提交中位 15.2 ms、最大 18.4 ms，而 hook 的单个预算默认 1 秒（`internal/plugin/host.js:1279-1280`，可调到 10 秒；总预算是各 hook 预算之和，夹在 2 到 10 秒），余量在二十倍以上。

spool 换来的是把 HTTP 确认和写库解耦，这个解耦并不提升可用性：collector 挂掉时 hook 的 POST 一样失败。它还要配一套完整的确认与重放协议，包括确认前是否已 fsync、偏移存在哪里、偏移与数据库提交的先后、半行怎么恢复、重放时 `request_block` 等副作用如何幂等。协议成本远高于它解决的问题，去掉之后少一套日志、少一套崩溃恢复路径。写库直接 `synchronous=NORMAL` 写 WAL，提交成功即返回 200。

### 尺寸预算分四层

上游的几个长度常量各管一段，不能互相代入。

| 层 | 限制 | 来源 |
| --- | --- | --- |
| magpie 读取客户端请求 | `defaultBodyLimit = 512 MiB` | `internal/gateway/request_bounds.go:29` |
| 插件宿主单行 | `maxWireLine = 32 MiB`，超线整笔不跑 hook | `internal/plugin/host.go:154` |
| hook 捕获回复 | `conversationBodyMax = 8 MiB`，超线 `reply = null` | `internal/gateway/conversations.go:19` |
| collector 接收 envelope | 自定 | 本设计 |

collector 自己定两个数，都按观测决定，不按上游常量推。envelope 上限取 64 MiB，实测最大请求 3.9 MB、p99 2.16 MB，留了一个数量级余量。请求对象与回复对象各自再加 32 MiB 的上限，独立校验：合法大 JSON 正常入库，非法或超限的 envelope 返回明确错误码，不静默截断后按完整对象处理。

`conversationBodyMax` 只作用于回复捕获，请求体作为 `json.RawMessage(body)` 直接进插件，不受它约束。按 8 MiB 收会让一个 6 MiB 请求加 3 MiB 回复的合法回调被整笔拒绝。

截断只有一种合法形态。薄 hook 在正文超过 envelope 预算时，只发送带稳定 ID、原始大小与缺失原因的元数据，不发半截 JSON。收到半截 JSON 一律按解析失败处理，不当作正文。

### 上游还有两条正文通路

hook 之外，magpie 自己还有两条正文通路，性质不同，都影响设计。

请求归档（`RequestArchive`）开启后，每一笔网关调用都落到用户自己的 S3 桶（与 sync 共用），路径 `<prefix>/magpie/archive/<date>/<id>.json`，响应头带 `X-Magpie-Archive-Id`，账本行与路由行都记 `<date>/<id>`（`internal/gateway/archive.go`）。它与 hook 的差别：

| 维度 | hook | 请求归档 |
| --- | --- | --- |
| 时机 | 请求结束时的 best-effort 通知 | 请求答完才上传，走队列 |
| 保留 | 无，丢了就没了 | 与 S3 生命周期一致，比本地任何东西都长 |
| 正文上限 | 回复捕获 8 MiB | `RequestArchiveMaxMB`，默认 32 MiB，上限 1 GiB |
| 脱敏 | 无（hook 在 `redacted` 之前） | 已脱敏，`redact` 先跑 |
| 依赖 | magpie + collector 同时在 | magpie + S3 配置 |
| 内容 | `ctx.request` 与整份回复 | 请求与回复的头与体 |

本机 `settings.json` 里没有 `requestArchive`，即未开启。这条通路的意义在于它能把正文丢失从不可恢复变成可恢复：collector 记下账本行的 `archive` 字段（`<date>/<id>`），缺正文时按它回源。

归档由 magpie 拥有、写到用户桶里、且已经有 `archive` 字段做索引，本项目不接管它。collector 只把 `archive` 抄进 `request` 行，并在 `miss_reason` 里记可从归档回填。是否为它做回填流程，取决于是否愿意开归档。

网关会话记录（`GatewayConversations`）是另一个 opt-in 的本地开关，写到 `~/.config/magpie/gateway-conversations/`，保留 7 天、整库 256 MB、单轮 1 MiB、每方向 64 KiB 截断（`internal/sessions/gateway.go`）。它存的是解析后的分段文本，不是原始协议对象，截断方式与 hook 也不同，本机同样未开启。这条不作为证据源：它是 magpie 自己的会话视图，字段定义与 hook 不一致，混用会出现两套新增消息。

三条通路的分工因此清楚了：hook 是实时、原始、无保留的主通路，归档是带保留、已脱敏的兜底，会话记录是 magpie 的展示层，不接。设计上只依赖 hook，另外两个只作为 `archive` 字段与 `miss_reason` 的诊断线索。

### 自己存一份的理由

路由历史 30 天滚动、200 MB 上限；账本按 magpie 的定义只覆盖它读得到的 Agent 会话文件；hook 没有落盘。三者都是上游的临时产物，不能代替本项目的事实库，这里只把它们当证据源。

## 证据身份与收敛

### 物理记录身份

账本行不能按 `route_id` 当主键。源码里 `HandedOn` 指的是某次尝试失败但仍被计费的那一行，它与最终成功的行共用同一个 `RouteID`（`internal/usage/usage.go:163-176`，写入点在 `internal/gateway/gateway.go:2953-2969`）。两行都写进 `r:<route_id>`，忽略冲突会丢掉失败的计费，覆盖会丢掉最终的成败。

原始账本按物理记录身份入库：

```text
(source_kind, file_generation, byte_offset)
```

`source_kind` 里 `file` 表示 `usage.jsonl`，`api` 表示从 HTTP 接口拉到的 direct 行。`file_generation` 是文件身份，只有 dev + inode + birthtime，不含 size、mtime 或任何随内容增长而变的东西。`byte_offset` 是该行在文件中的起始字节。`route_id` 降为普通索引，不唯一，真唯一键是上面这个三元组。

身份里放 size 或者放内容哈希都会失效。写进 size 的话，每次正常追加都会换一个代际，于是偏移归零、整文件重读，而代际又是主键的一部分，旧行会以新身份再入库一次，尝试明细与用量汇总随之重复。把首块哈希定义成文件前 64 KiB 同样不行：文件从 10 KiB 长到 100 KiB 时，参与哈希的字节从 10 KiB 变成 64 KiB，指纹照样变。凡是拿内容做身份，都会在文件增长时失效。

所以代际只取不随追加变化的元数据：

```text
file_generation = dev + inode + birthtime
```

`birthtime` 取自 `stat`，用于区分同一个 inode 被复用这种少见情形。文件身份回答的是这是哪个文件，长度与修改时间回答的是它变了吗，两者分开存。本机三个字段都在：`usage.jsonl` 的 `birthtimeMs` 与 `stat` 的 `%B` 一致，Bun 的 `fs.statSync(p, { bigint: true })` 直接给到 `birthtimeMs`。

首次见到一个文件时另记一条冻结的头部基线：当时的长度与这段长度的哈希，存进游标就不再重算。之后每轮只在 dev 与 inode 都没变时，按存下来的长度重新哈希同一段并比对。一致说明还是那个文件，不一致说明 inode 被复用了或者文件被原地重写，这才算新代际。基线长度取 `min(size, 64 KiB)` 且在第一次见到时就固定，不随后续增长而变。

两个来源的去重规则不共用。路由可以用 `route_id` 做逻辑去重，一条路由一份记录；账本不行，同一 `route_id` 下可能有多条计费行，物理身份是唯一能区分它们的东西。读取器的公共部分只到切出完整行、按代际与偏移去重这一层，之后的幂等键由各来源自己决定。`.gz` 被整体重写时偏移没有意义，路由重读后按 `route_id` upsert，与物理身份无关。

账本里到底会不会出现多条计费行，源码与运行数据给出的信号不一致。magpie 自己的 `docs/subsystems/gateway-routing.md` 写得很明确：一笔请求一条用量记录，多尝试的请求在最终记录里带 `tries`，`handed_on` 行只是被拒绝或被转交那次的单独记账。本机 20,470 行账本里：

| 观察 | 结果 |
| --- | --- |
| `handed_on` 出现的行数 | 0 |
| `route_id` 重复的组数 | 0 |
| 带 `tries` 的行 | 5 行，全部 `tries >= 2`，`status = 200` |

`handed_on` 在 `usage.Record` 的类型定义里存在（`internal/usage/usage.go:172`），但本机样本里一次都没写进文件。可能是版本差异，也可能是 `handed_on` 行只在特定失败路径才产生，例如 Codex 单账号过载重试那条路径。

主键仍然按物理身份设计，理由有三条：物理身份不依赖对 `handed_on` 语义的推断，上游写不写都成立；同一路由若真出现两行，`r:<route_id>` 会静默丢一行；物理身份让重读历史日天然幂等。代价是每行多存 `file_generation`（约 40 字节），20,470 行约 800 KB，换来一个不依赖上游语义的稳定键。

API 来源没有物理身份。分页位置会随新记录插入而整体位移，同一条 direct 记录第二次回填时可能落在另一个 offset，被当成新记录再插一遍，所以 `(via, offset)` 不能当身份。API 拉到的行分两层对待：

| 层 | 身份 | 用途 |
| --- | --- | --- |
| 原始观测 | `(source_kind='api', run_id, page_offset)` | 一次回填批次内幂等，防止同一批次重复写；跨批次不唯一 |
| 逻辑请求 | 待定的稳定键 | 决定是不是同一笔 direct 调用 |

`run_id` 是每次回填运行的标识。它只保证同一次运行内不重复，不能当作记录身份。

稳定键留到第 4 阶段再定，候选是 `(t_ms, session, agent, model, in_tok, out_tok)` 这样的组合。即使定了，也只用来判候选重复：两个字段全同不证明是同一笔调用，重叠的两条不能自动合并。第 4 阶段当前关闭，不影响前三阶段。

按 `r:<route_id>` 实现，在现在的数据上不会出错，因为确实还是一行一路由；会出问题的是上游真开始写 `handed_on` 行的情形。

### 增量读取协议

两个来源都是 append-only 文件，但都不是简单的追加流：账本行乱序，路由跨午夜回写，历史日会被整体换成 gzip。把读文件当成读数组会错过这些。

游标只有一张表，与证据写在同一个事务里：

```sql
CREATE TABLE source_cursor (
  source_kind     TEXT NOT NULL,       -- ledger / route_file / route_gz
  source_name     TEXT NOT NULL,       -- usage.jsonl / 日期.jsonl / 日期.jsonl.gz
  file_generation TEXT NOT NULL,       -- jsonl: dev+inode+birthtime+epoch；gz: 整份指纹
  committed_off   INTEGER NOT NULL,    -- jsonl: 已提交完整行末尾；gz: 解压后长度
  seen_size       INTEGER,             -- 读取时的文件长度，不参与物理身份
  head_len        INTEGER,             -- jsonl 当前代际冻结的头部基线长度
  head_hash       TEXT,                -- 头部基线哈希，用于识别原地重写
  fingerprint     TEXT,                -- gz 整份压缩字节的 SHA-256
  last_ok_ms      INTEGER NOT NULL,
  rewrite_epoch   INTEGER NOT NULL DEFAULT 0,
  observed_off    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_kind, source_name)
);
```

`seen_size` 不进 `file_generation`；`head_len` 在当前代际首次提交完整行时冻结，换代后重新建立。账本在库内固定标识为 `ledger / usage.jsonl`，不随配置里的文件名改变。

读取结果统一为 `SourceRead`，包含 `SourceCursor` 的来源身份与全部游标字段，以及文件形态、状态、行与坏行。在线账本与路由共用 `ingestSource`：追加 jsonl 与封口 gzip 按不同引用基址记录路由坏行，记录内核分别保留账本物理身份与路由 `route_id` 规则。坏行、证据、游标与 `last_ok_ms` 在一个具名事务内提交（`ledger` 或 `route`）。失败时共同回滚，游标回到上批末尾，下轮重新读取并记账，证据按既有身份幂等。

同一 `file_generation` 和 `rewrite_epoch` 下，摄入游标的 `committed_off` 与 `observed_off` 都取新旧最大值；换代或重写时允许归零。只观察到新的半行字节时仅推进 `observed_off`，相同观察位置不重复提交。暂停只记录缺口和观察位置，保留已提交位置以便恢复重读。

半行不前移游标。只读到换行符为止，末行没有换行就等下一轮，不猜也不补。盘上文件末尾本来就没有换行时，这个行为会一直等到该行写完，这是对的。

文件身份使用 dev、inode 与 birthtime，代际附带 `rewrite_epoch`。每轮读取比对文件身份；不同则从偏移 0 重读。身份不变时，实际长度小于 `committed_off` 或按冻结 `head_len` 重算的哈希不符，表示截断或原地重写，递增 epoch、清空头部基线并从偏移 0 重读，避免新内容复用旧物理记录身份。

历史日整体重写是常态。`pruneHistory` 会读整个 `.jsonl`、以 gzip 成员形式追加到 `.gz`、再临时文件替换整个 `.gz`（`internal/gateway/history.go:110-160`）。所以 `.gz` 的偏移没有意义，同一天可能在 `.jsonl` 与 `.gz` 里各存一份。做法是 `.gz` 按 `fingerprint` 识别，整体摘要没变就跳过，变了就全量解压重读、靠 `route_id` upsert 去重；`.jsonl` 按游标增量读取，只消费新增的完整行。同一天两个文件都在时两份都读，重复的 `route_id` 收敛成一份。

跨午夜的迟到路由。凌晨之后到达的路由可能写进前一天的 `.jsonl`，所以读取不按当前日期筛文件，而按每个文件自己的游标判断。一个已经被判为彻底归档的日期文件被重新创建时，按新代际重读。

路由入口每轮按三态记账：`decoded`（读到新内容）、`unchanged`（没有新内容）、`error`（`route_file_unreadable` 读取失败、`route_gzip_invalid` 解压失败、`route_gzip_limit` 输出超过 512 MiB）。`.jsonl` 走与账本相同的行读取器：文件身份 + `committed_off` + 冻结的头部基线，每批最多 128 行或 8 MiB，只消费已经写完的完整行，末行没有换行就等下一轮；`.gz` 用整份字节的 SHA-256 作 `fingerprint`，摘要没变就跳过，变了就整份解压重读。只有 `decoded` 且 ingest 成功才推进游标：`.jsonl` 推进身份与偏移，`.gz` 推进 `fingerprint`；`unchanged` 与 `error` 都不推进，`error` 下一轮重试。单行超过 64 MiB 的完整行只记 `route_line_too_large` 与位置，游标照常推进。

账本与路由的 `.jsonl` 共用 `readBatch`，读取结果本身可直接作为下一轮游标；`.gz` 同样返回 `SourceRead`，以整份指纹识别，偏移仅记录解压后长度，不用于定位。

### `handed_on` 与 `kind` 是两件事

| 字段 | 含义 | 处理 |
| --- | --- | --- |
| `handed_on` | 某次尝试失败并转交后续候选，该行的用量仍计入 | 保留为尝试明细，不是独立请求，不增加顶层请求数 |
| `kind` | 调用用途，如 Codex 的 `review`、`compact`、`web_search` | 保留，记入分类 |

两者不相关，不能用 `kind` 非空来推断 `handed_on`。本机 8 条 `kind = web_search` 全是真实调用（`callKind` 从 `User-Agent: SearchAgent` 推出），按那条规则会被整批丢掉，而真正的 `handed_on` 一条都没滤掉。

一笔请求的最终结果取该 `route_id` 下最后一条非 `handed_on` 的行。费用分两个数：最终回复的用量，与整笔请求的尝试总量。两者分开存，不相加。

### 前缀规范化

实测需要统一的一组前缀：`chatcmpl-`、`msg_`、`resp_`、`msg_resp_`。只比较去前缀后的主体，2026-10-20 的快照里 3,435 / 3,435 命中。

规范化规则放在一张按协议登记的表里，不写成单条 if。命中多个候选时保留原始候选并标记歧义，不按时间接近强行合并。规范化规则带版本号，写进每条关联结果。

### 会话键与子代理

会话键取 `session` 优先，缺失时用 `magpie-` 前缀加 `conv`（避免与客户端声明的 session 撞键），并把用的是哪个记在行上。

同一时点的账本 4,288 笔里 3,856 笔有 session，剩 432 笔全部能经 `route_id` 从路由行取到 conv，合成率 100%。那 432 笔全是 `omp`（400 笔）、curl 探测和少量直连工具，走 `/v1/chat/completions`，客户端本来就不声明 session。

同 session 不等于同一条消息历史。子代理沿用父会话的 `session`，另用 `subagent` 区分（`internal/usage/usage.go:153-159`、`internal/gateway/trace.go:73-83`）。本机 408 条子代理行里 407 条与父代理共享 session。

父代理 P1、子代理 S1、父代理 P2 交错时，P2 会把 S1 当成上一笔；不同代理使用相同的局部工具 ID 时还会错误配对。

所以读模型保留 `subagent` 与 `parent_agent` 两列。会话导航仍按 `conv_key` 统一，但前驱计算与工具配对按 `(conv_key, actor)` 做，`actor` 取 `subagent` 优先、否则是会话本身。身份不足以判定归属时明确标不确定，不按名称或时间猜。

### 合并规则

每个 `req_id` 维护一个来源位图 `have`：1 为 hook，2 为账本，4 为路由，8 为 OTLP span。

```text
through 请求：期望 1|2|4
rejected：    期望 2（永远不会有 1 和 4）
hook 独有：   只有 1，超时未对上账本则停在 1，标记为待关联
otlp：        只有 8，独立建行，不参与上面三种的合并
```

OTLP 行不走加法合并：它没有 `response_id` / `route_id` 可挂，物理身份是 `(trace_id, span_id)`，落到 `request_evidence` 的 `source_kind='otlp_span'`。会话缺正文的判定按期望位图算——otlp 行只期望第 4 位，不因缺 magpie 三路证据被标采集失败。

合并只做加法，从不覆盖已有证据。字段级来源优先级：

| 字段 | 取哪个来源 | 理由 |
| --- | --- | --- |
| 状态、用量、`response_id`、`provider` | 账本文件 | 网关记账的结果，hook 的 `success` 只是布尔 |
| 请求模型 `model_requested` | 账本 `req` | agent 请求的模型（别名、路由组或 `provider/model`），与 provider 实得的 `model` 是两件事 |
| 服务模型 `model_served` | 账本 `served` | 厂商回复里声明它答了哪个模型；缺失保持未知，不用 provider `model` 顶替 |
| 费用 `cost`、`priced` | 账本 API，按 `route_id` 补齐 | 文件里没有这两个键；API 的 `Row` 才算得出 |
| 正文、请求结构、回复 | hook | 账本没有正文 |
| `prompt` 分解、`tries`、`affinity`、`order`、`conv` | 路由 | 只有路由有 |
| agent、session、cwd | hook 优先，账本兜底 | 两处覆盖一致（3,435 对匹配里两边 session 都非空 3,405） |

hook 的 `model` 与 `success` 只作为独立报告保留在 `raw_hook`：前者是 hook 侧看到的模型，不是 provider 侧读数；后者是"这次观察到成功"，不是 HTTP 状态码，两者都不写进 `request` 的模型列或 `status`。

费用必须区分三种状态，不能合并成一个数：

| 状态 | 判定 | 界面 |
| --- | --- | --- |
| 已定价 | `priced = 1` 且 `cost > 0` | 显示金额 |
| 已定价为零 | `priced = 1` 且 `cost = 0` | 显示 $0 |
| 未定价 | `priced = 0` | 显示未定价，不写 0 |
| 未取得 | 没有 API 行 | 显示未取得，附原因 |

每条费用记录取值时点与所用定价版本。不建议为此复制 magpie 的价格表；确实需要离线计价时再引入带版本的定价快照。

### 乱序到达与重算

逻辑顺序 A→B→C，实际按 A→C→B 到达时，C 已经按 A 算了前驱和增量。B 到位后若不重算，C 的结果会长期与全量重建不同。账本先到、正文后到、待关联 hook 合并都会触发同样的问题。

稳定排序不用 `req_id`，它是摄入时分配的，不能当逻辑顺序。排序键取 `(started_ms, source_kind, source_offset)`，同毫秒时用来源键定序。

同毫秒的先后只有同一账本代际内的不同偏移能证明。整桶出现非账本来源、缺失/非法位置或跨代际时，整桶标为顺序未证实；同代际重复偏移只标重复的那几条。这些请求仍按遍历顺序处理，但关系记 `unknown`、不作为确定祖先或主链根，同毫秒的工具关系不 `resolved`。该标记沿组内顺序向后传播，与正文不可读的处理一致。

写入要触发局部重算。插入、关联成功、补到正文、会话键变更，都重算当前请求及其后继链上已算过的派生值。链长按同会话上限截断，避免一次关联扫全库。

工具配对是可变状态。A 的回复里发出调用 x 时，携带结果的 B 尚未发生，只配一次会永久留空。所以配对写成待配对调用表，后续结果到达时更新归属，并按稳定顺序处理反向到达与重复投递。

每个派生结果记录算法版本与未知原因，便于整体重建。

## 存储模型

SQLite，WAL，单文件，放仓库外。默认路径 `~/Library/Application Support/agent-trace-collector/trace.db`，可用环境变量或配置改。

### 版本与破坏式替换

当前结构版本是 v7。空库在同一个事务里建到 v7。存量库只有一条升级路径：v6 打开时在单个事务里原地升到 v7（纯新增表与索引，不动旧行），更早的版本报 `schema_rebuild_required`，高版本报 `schema_version_unsupported`。

首版发布前的破坏式替换只对 v6 之前的库：停采集器、把数据目录整体移走或删除，让新版本建新库，旧库里的正文与派生结果一起丢弃，不存在"结构已升级、数据未迁移"的中间态。v6→v7 不走这条路，原因是仓库已有本机真实数据且 v7 变更纯新增，原地升级可执行、可验证。备份白名单随之收两版：v6 与 v7 的 bundle 都可恢复，v6 包恢复后首次打开时同样原地升级。

v7 在 v6 之上加的是 OTLP 三张表：`raw_otlp_span`（span 原始层，主键 `(trace_id, span_id)`）、`raw_otlp_log`（logs 原始层，按记录内容哈希判重）与 `otlp_body_ref`（Claude Code 正文指针状态机）。v6 在 v5 之上加的是派生代际结构：`derive_generation`（一代一行）、`derive_request_result`、`derive_tool_result` 与四张只建不改的工作表（`derive_chain_work`、`derive_role_work`、`derive_call_work`、`derive_result_work`），并把 `derive_queue` 原地补上 `published_generation` 等列。派生结果从 `request` 行搬进代际结果表；`request` 上的旧列这一版保留不动，切片模式不写它们，同步模式照旧写。

### 脱敏盐绑定与可恢复快照

脱敏盐是数据目录里的 `redaction.salt`（32 字节，0600），不写进数据库。库与盐是否配对记在 `collector_state['privacy:salt']`：`{format:1, id}`，`id` 是 `sha256('atc-redaction-salt-v1\0' + salt)`，不含盐明文。有请求却没有绑定、绑定与盐不符或盐文件缺失，都拒绝启动，不生成新盐；换盐会让库里已写入的占位符再也解释不了。有盐无绑定同样拒绝，没有确认绕过的入口：无法证明历史占位符是这份盐算的，旧库按破坏式替换处理。

可恢复快照是 bundle，不是裸数据库：`trace.db`、`redaction.salt` 与 `manifest.json` 三件，清单记 `{format:1, schema, salt_id, database_sha256}`。可接受的结构版本只有一份导出常量 `RESTORABLE_SCHEMA_VERSIONS`，备份与恢复都查它；恢复还要求包内数据库自身的 `user_version` 与清单相等。发布用同父目录的 0700 staging 加 `rename`，目标已存在就拒绝，不覆盖任何已有目录。认证令牌不随包走，恢复后按首次启动规则重新生成。

### 原始层

magpie 三张表，互不覆盖。`payload_json` 保留整行原文，应对 magpie 改字段：不用提前把所有字段解析成列，出现新字段时先从原始载荷补，再改表。

结构化列、`payload_json` 与路由长期摘要都来自同一个已脱敏对象：先 `redact` 再 `mapLedgerRow` / `mapRouteRow`。否则列与载荷会各说一套，而载荷里会留着未脱敏副本。

字段按上游真实键读取：请求模型是 `req`（不是 `requested`），客户自报费用是 `cost`（不是 `own_cost`），vendor 错误原话是 `err`（`err_type` 是另一个字段），`prompt.counted` 是布尔。读不到的键保持 NULL，不拿相邻字段顶替。

```sql
CREATE TABLE raw_ledger (
  source_kind      TEXT NOT NULL,      -- file / api
  file_generation  TEXT NOT NULL,      -- 文件身份；api 行存 'api:<run_id>'，只在本批次内唯一
  byte_offset      INTEGER NOT NULL,   -- 文件内起始字节；api 行存该批次内的页内序号
  route_id         INTEGER,            -- 普通索引，不唯一
  t_text           TEXT NOT NULL,      -- 原始时间串，保留时区写法
  t_ms             INTEGER NOT NULL,   -- 解析后的 epoch 毫秒，所有比较用它
  source           TEXT NOT NULL,      -- through / direct / rejected
  handed_on        INTEGER NOT NULL DEFAULT 0,
  kind             TEXT,               -- 调用用途，与 handed_on 无关
  agent TEXT, provider TEXT, host TEXT, account TEXT,
  model TEXT, requested TEXT, served TEXT,
  in_tok INTEGER, out_tok INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  reasoning INTEGER, effort TEXT,
  ms INTEGER, status INTEGER, stop TEXT,
  response_id TEXT, response_id_norm TEXT, rid TEXT, ep TEXT,
  session TEXT, native_session TEXT, subagent TEXT, parent_agent TEXT,
  ttft_ms INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  sent_ms INTEGER, retried_ms INTEGER, queued_ms INTEGER,
  own_ms INTEGER, reasoning_hidden INTEGER,
  tier_asked TEXT, tier_sent TEXT, tier_served TEXT,
  err_type TEXT, computer TEXT, via TEXT,
  archive TEXT,                        -- '<date>/<id>'，magpie 请求归档的定位键
  tries INTEGER,                       -- 网关对这笔做过几次尝试
  credits REAL, own_cost REAL,         -- own_cost 只保留客户端自报值
  magpie_version TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (source_kind, file_generation, byte_offset)
) WITHOUT ROWID;

CREATE INDEX i_raw_ledger_route ON raw_ledger(route_id);
CREATE INDEX i_raw_ledger_resp  ON raw_ledger(response_id_norm);
CREATE INDEX i_raw_ledger_time  ON raw_ledger(t_ms);

CREATE TABLE raw_route (
  route_id         INTEGER PRIMARY KEY,
  time_ms          INTEGER NOT NULL,
  day              TEXT NOT NULL,
  agent TEXT, session TEXT, conv TEXT, folder TEXT,
  subagent_id TEXT, kind TEXT, for_json TEXT,
  model TEXT, provider TEXT, served TEXT, effort TEXT,
  status INTEGER, error TEXT, done INTEGER,
  ms INTEGER, ttft INTEGER, first_text INTEGER, flow INTEGER,
  tokens INTEGER, out_tok INTEGER, reasoning INTEGER,
  payload_json     TEXT NOT NULL,
  magpie_version   TEXT
);

CREATE TABLE raw_hook (
  hook_id          TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL,
  protocol TEXT, path TEXT, agent TEXT, session TEXT, cwd TEXT,
  origin TEXT, model TEXT, stream INTEGER, success INTEGER, duration_ms INTEGER,
  request_z        BLOB, response_z BLOB,
  request_bytes    INTEGER, response_bytes INTEGER,
  parse_state      TEXT NOT NULL,      -- 请求侧：ok / truncated / unsupported / invalid
  reply_state      TEXT,               -- 回复侧：ok / absent / unsupported / invalid，NULL 表示未判定
  miss_reason      TEXT,
  magpie_version   TEXT
);
```

`raw_hook` 的正文副本只在解析成功后短暂保留：块与骨架提交完成的同一事务里把它清空（置 NULL，保留行），作为可重放的重放层，按独立上限滚动。它不参与正文预算的重复计数。

OTLP 通道另有三张表。span 与 log 的原始层同样脱敏先于落盘（`attributes_json` 与 `body` 是脱敏后的），TTL 与 magpie 原始层同等生效：

```sql
CREATE TABLE raw_otlp_span (
  trace_id   BLOB NOT NULL,
  span_id    BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  service    TEXT, scope_name TEXT,
  name       TEXT NOT NULL, kind INTEGER,
  start_ms   INTEGER NOT NULL, end_ms INTEGER, status_code INTEGER,
  attributes_json TEXT NOT NULL,          -- 脱敏后的属性表
  mapping_version INTEGER NOT NULL, privacy_version INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
) WITHOUT ROWID;

CREATE TABLE raw_otlp_log (               -- 记录无内生 id，按内容哈希判重
  record_hash     BLOB PRIMARY KEY,
  received_at     INTEGER NOT NULL,
  service TEXT, trace_id BLOB, span_id BLOB, time_ms INTEGER,
  body TEXT, attributes_json TEXT NOT NULL,
  privacy_version INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE otlp_body_ref (              -- Claude Code 正文指针状态机
  request_body_id TEXT PRIMARY KEY,
  trace_id        BLOB NOT NULL,
  req_id          INTEGER,                -- 关联到的 otlp 行；未关联为 NULL
  request_ref     TEXT, response_ref TEXT, message_id TEXT,
  state           TEXT NOT NULL,          -- pending_span / awaiting_response / wired / …
  detail          TEXT,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
```

白名单外的 span（agent 层、工具层）只落 `raw_otlp_span`，不建 `request` 行。`otlp_body_ref` 按 `request_body_id` 聚 Claude Code 的 `api_request_body` / `api_response_body` 事件，traces 先到或 logs 先到都能收敛：span 行落库时回接 pending 指针，双指针齐后读文件、脱敏、走既有 `persistBodyTx` 落正文，`body_state` 从 `summary` 转 `available`。同 trace 多 attempt 撞出多候选时记 `span_ambiguous`，不猜。指针读取只认事件指到的单个普通文件，非普通文件、符号链接、超 32 MiB 或读不到分别记因，读失败行保持 `summary` 并写 `miss_reason='body_ref_read_failed'`。

### 路由摘要长期层

原始路由 7 天滚动，但 `/api/requests/:id/route` 需要长期可查，清理原始层后历史路由不能跟着消失。所以另存一张摘要表，只保留展示需要的字段，去掉 `prompt`、`for`、`nested` 与 `order` 的完整结构：

```sql
CREATE TABLE route_summary (
  route_id    INTEGER PRIMARY KEY,
  time_ms     INTEGER NOT NULL,
  model TEXT, served TEXT, provider TEXT,
  status INTEGER, ms INTEGER, ttft INTEGER, flow INTEGER, first_text INTEGER,
  order_json  TEXT,      -- provider / model / who 三项
  tries_json  TEXT,      -- provider / model / status / ms / error / fail / in / out / cache / cost_state
  affinity_json TEXT,
  z           BLOB       -- 整行摘要的 zstd 副本，供重建
);
```

同一时点实测 4,453 条路由，摘要行原文 p50 从 4,401 字节降到 1,022 字节，zstd 后 0.46 KB/行。按每天 4,000 笔算 1.9 MB/天，10 GB 能放约 14.6 年。所以路由详情不需要宣布保留期，直接进长期层。

`prompt` 分解仍只在 `request` 行上存（`prompt_tokens`、`parts_json`），原始路由过期不影响它。

`z` 的写入格式是 format 2：在原有字段外带 `kind`、`folder`、`effort` 与 `prompt` 分解。路由详情只读展示需要的白名单标量与 `z` 里的安全字段：候选顺序与尝试项都按固定键挑选，`who`、`account`、`host`、`id` 与任意原始 JSON 不进入响应。旧行按 format 1 读取，format 2 才有的字段返回 null，不从 `raw_route.payload_json` 补。尝试链保留未知 `fail` 与错误码原值；缺少开始时间时只说明时间不完整，不推算间隔。

### 读模型

```sql
CREATE TABLE request (
  req_id           INTEGER PRIMARY KEY,
  route_id         INTEGER,             -- 索引，不唯一
  response_id_norm TEXT,
  -- 归属
  agent TEXT, session TEXT, conv_key TEXT, conv_source TEXT,
  actor TEXT,                           -- subagent 优先，否则等于会话本身
  subagent TEXT, parent_agent TEXT,
  started_ms       INTEGER NOT NULL,
  day              TEXT NOT NULL,
  via              TEXT NOT NULL,       -- through / hook / direct / rejected / otlp
  -- 身份与状态
  status INTEGER, stop TEXT,
  model_requested TEXT, model_served TEXT, provider TEXT,
  -- 读数
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning INTEGER,
  cost REAL, cost_state TEXT, cost_at INTEGER,      -- priced / zero / unpriced / absent
  ms INTEGER, ttft_ms INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  -- 整笔请求的尝试总量（含被转交但仍计费的尝试），与上面的最终回复读数字段并存
  attempt_count INTEGER, attempt_billed INTEGER,
  attempt_in INTEGER, attempt_out INTEGER,
  attempt_cache_read INTEGER, attempt_cache_write INTEGER,
  attempt_reasoning INTEGER,
  attempt_cost REAL, attempt_cost_state TEXT,
  attempt_derive_version INTEGER,
  -- 上下文
  prompt_tokens INTEGER, prompt_counted INTEGER,
  prompt_window INTEGER, prompt_turns INTEGER, parts_json TEXT,
  -- 正文
  body_state       TEXT NOT NULL,       -- pending / available / partial / evicted / unsupported / summary
  body_prev_state  TEXT,                -- 回收前的状态，保留原状
  body_evicted_at  INTEGER, body_evict_reason TEXT,
  archive TEXT,                         -- magpie 归档定位键，正文缺失时可回源
  skeleton_z       BLOB,
  body_bytes       INTEGER,
  msg_count        INTEGER,
  prev_req_id      INTEGER,
  prev_relation    TEXT,                -- confirmed / branch / unknown / first
  delta_ordinals   TEXT,
  -- 折叠行摘要：派生时写入，列表接口直接返回，不读正文块
  input_preview    TEXT,
  input_preview_kind TEXT,              -- delta / tail / tool_result
  reply_preview    TEXT,
  -- 派生
  title TEXT, title_source TEXT,
  derive_version   INTEGER NOT NULL,
  -- 完整性
  have             INTEGER NOT NULL,    -- 位：1 hook 2 账本 4 路由 8 OTLP span
  miss_reason      TEXT,
  magpie_version   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX i_req_conv ON request(conv_key, actor, started_ms DESC, req_id DESC);
CREATE INDEX i_req_time ON request(started_ms DESC, req_id DESC);
CREATE INDEX i_req_route ON request(route_id);
CREATE INDEX i_req_resp ON request(response_id_norm);
CREATE INDEX i_req_day  ON request(day);
CREATE INDEX i_req_body ON request(body_state) WHERE body_state != 'available';
CREATE INDEX i_req_fail ON request(started_ms DESC) WHERE status >= 400;
```

`body_state` 与 `have` 分开：`have` 表示收到哪几路证据，回收不能把收到过改写成没收到；`body_state` 表示正文当前能否读取。两者混在一个位图里，回收后界面就会显示成回调未收到。

尝试总量必须有长期列。一次有计费的拒绝尝试随后成功时，账本里是两行：一行 `handed_on = 1` 带前一次的用量，一行是最终回复。原始账本第 8 天过期以后，如果 `request` 只有最终回复那一组读数，前一次消耗就没有承接的地方。所以 `attempt_*` 这一组在关联完成时就算好写进 `request`，不依赖原始层还在。

统计上 `attempt_billed` 只计真正产生了计费的尝试，等于账本里该 `route_id` 的行数；`attempt_count` 取路由 `tries` 的长度，包含没计费的尝试。两者不相等是正常的，界面要能分别显示试了几次、其中几次计费。

`attempt_cost` 与最终回复的 `cost` 一样从 API 按 `route_id` 补齐，四态一致（priced / zero / unpriced / absent）。

同一时点的实测：账本里 `tries >= 2` 的 5 行全部是 `status = 200` 的单行记录，路由里 `usage` 数组长度为 1 的 4,627 条、大于 1 的 0 条。所以这组字段当前大致等于最终回复的读数。这也符合 `docs/subsystems/gateway-routing.md` 的说法：一笔请求一条用量记录，多尝试体现在 `tries` 字段上，不体现在多行上。

保留这组字段的依据是上游可能改写行为：`handed_on` 的类型定义就在 `usage.Record` 里，本机只是还没写过。真出现时，没有 `attempt_*` 就没有地方承接前一次的消耗，而原始账本又会在第 8 天过期。

逐尝试的费用明细不放进 `request`。页面要按尝试解释时再取 `route_summary` 的 `tries_json` 与 `attempt_*` 对照；确实需要逐次金额时，在摘要层加用量与费用状态，不回原始层。

#### 行级事实由来源投影决定

`request` 的行级事实列不由各写入路径自己拼，而由 `src/sources/projection.ts` 的 `projectRequestTx` 从 `request_evidence` 重读证据后统一写。在线摄入与离线重建走同一入口。

`model_requested` 存上游 `req`，`model_served` 存回复声明的 `served`，provider 侧 `model` 只留在 `raw_ledger` 与路由里。三者不互相顶替；缺失保持 NULL。

尝试合计（`attempt_billed`、`attempt_*`、起始时间）只在账本 owner 证据完整时重算。任一条物理证据过期或读不懂、或同一行被两条证据指到（重复记账嫌疑）时，旧值与旧合计原样保留，不用部分行重算，也不取 MAX 掩盖。

同毫秒的先后只有同一账本代际内的不同偏移能证明。跨代际的同毫秒无法证明顺序时，合计照常发布（它与顺序无关），但最终尝试不发布：`status`、模型三列与响应身份写 NULL，排序键清空，`attempt_state` 写 `pending_final`。

`prompt_tokens`、`prompt_counted`、`prompt_window`、`prompt_turns` 与 `parts_json` 取 `time_ms` 唯一最大的那条原始 route，与到达顺序无关。两条 route 同毫秒并列，或该 route 的 Prompt 缺失、非法时，旧值只是历史保留，读模型不得当成本次事实；长期落列与隐藏由[长期信息与显式重建计划](superpowers/plans/2026-10-22-atc-durable-rebuild.md)交付。

### 请求与证据的关联

```sql
CREATE TABLE request_evidence (
  req_id      INTEGER NOT NULL,
  source_kind TEXT NOT NULL,           -- hook / ledger / route / api
  ref_key     TEXT NOT NULL,           -- hook_id / 物理记录三元组 / route_id
  merge_state TEXT NOT NULL,           -- merged / pending；多候选歧义由 pending_hook.candidates 承载
  match_rule  TEXT,                    -- 命中的规范化规则与版本
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (req_id, source_kind, ref_key)
) WITHOUT ROWID;

CREATE TABLE pending_hook (
  hook_id     TEXT PRIMARY KEY,
  response_id TEXT, response_id_norm TEXT,
  first_seen  INTEGER NOT NULL,
  last_tried  INTEGER,
  candidates  TEXT                     -- 歧义候选的 route_id 列表
);
```

`request_evidence` 让每条 `request` 都能追到它由哪些原始记录合成，重建时有据可依。合并两条重复请求时，正文引用、前驱与工具链接的迁移在同一事务内完成。

### 内容库

```sql
CREATE TABLE block (
  id       INTEGER PRIMARY KEY,        -- 引用行用的整数代理键
  hash     BLOB NOT NULL UNIQUE,       -- 32 字节 sha256，脱敏后完整消息的字节
  fingerprint TEXT NOT NULL,           -- 语义指纹：去掉传输标记后的规范化消息，比对用
  z        BLOB NOT NULL,
  raw_size INTEGER NOT NULL
);
CREATE INDEX i_block_fp ON block(fingerprint);

CREATE TABLE request_block (
  req_id INTEGER NOT NULL,
  ord    INTEGER NOT NULL,             -- 消息数组下标：Anthropic/Chat 是 messages，Responses 是 input
  role   INTEGER NOT NULL,             -- 0 user / 1 assistant / 2 system / 3 tool
  block  INTEGER NOT NULL,             -- block.id
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_rb_block ON request_block(block);
```

反向索引不能省。主键 `(req_id, ord)` 只能按请求查引用，回答不了这个块还有没有人引用。候选集回收正是后一个问题；没有这个索引，候选块的反连接退化成全表扫描。实测 `EXPLAIN QUERY PLAN`：不建索引时是 `SCAN rb`，建了之后是 `SEARCH rb USING COVERING INDEX i_rb_block (block=?)`。候选集把候选块的数量降下来了，但每次反查的成本没有降。

引用行之所以用整数代理键，是因为另外两种做法都测过。存 32 字节全哈希，每条引用多 24 字节，占总开销的 16%（43.6 KB 里约 7 KB）；存 8 字节前缀再回查 `block`，必须在 `block` 上做范围扫描，实测合并一笔请求从 3 ms 涨到 703 ms，差了 200 倍。整数代理键两头都不占：引用行 4 字节，回查是主键命中。

不维护 `refs` 引用计数。计数需要与引用删除在同一事务内递减，任何一次中断或迁移都会留下漂移，而对不上账时无法判断是计数错还是数据错。

孤儿改由候选集判定：回收某一天时，先取出该天所有引用指向的块 id，只对这个子集做反连接，没有引用的删掉。全库反连接实测 191 ms（11,187 块 / 971,635 引用），会随规模线性增长；候选集把 N 压到当天涉及的块数，量级完全不同，也不存在漂移。

骨架记录消息数组在原始协议对象里的键与形态（`messages_key` 是 `messages` 或 `input`，`messages_form` 是 `array` 或 `string`），恢复时按这两项把数组放回原键，不按协议名二次推断。Responses 的裸字符串 `input` 合成一条用户消息存块，恢复时逐字还原成字符串。旧骨架缺这两项时按 `messages` / `array` 读。

### 不做规范哈希

哈希对象取完整脱敏消息的字节，不做规范哈希。剥掉 `cache_control` 后再哈希能让同一段内容在不同请求里落到同一个块，存储收益只有 2.3%，代价是块里存的字节不再是每笔请求的原字段，要恢复某笔的协议对象还得另存差异。另外它给增量计算引入了一个额外变量：比较上一笔与本笔是否同一条消息时，还要保证两边的剥离规则一致。按完整字节哈希之后，共同前缀比较就是直接的字节比较，前后一致性更容易验证。

### 骨架不带 summary

AVA 的骨架里，`request.summary` 与 `response.summary` 合计占骨架大小的 62.9%（400 条样本，13.1 MB 骨架里 8.3 MB 是摘要）。它是对正文的第二次结构化解析，内容与 `body` 重复。

去掉之后骨架原文从 82 MB 降到 42 MB，压缩后 9.5 KB/笔。摘要要用到的字段在摄入时直接算进 `request` 的列，骨架里不存第二份。

## 派生字段

界面依赖这几个字段。它们在摄入时算好，并在受影响的证据到达时局部重算。

### 标题

取该笔第一条新增 USER 消息里状态为 `text` 的解释文本首行，压空白，截到 60 字。包装剥离、注入识别与"这条消息算不算用户输入"由[输入解释与能力阅读](#输入解释与能力阅读)统一判定，标题不再自己维护一份规则。

没有正文时回落到 `模型 · HH:MM`，`title_source` 记为 `model_time`。direct 行永远走回落，界面要能显示这个差别。

harness 的 Title Generator 是旁路请求：Claude Code 与 OMP 的输入/回复形状不同，但回复都可以解析成 `<title>` 或 `{"title":…}`。这类请求由用途阶段记 `purpose_chain='exclude'` 与 `req_kind='title'`，不进入祖先集合；解析出的正式标题存 `model_title`。会话标题优先取已完成组里最新一次生成的正式标题，没有才退回用户首句。

链角色在每组派生末尾重算：最早的一笔真实请求是 `main`，其余互不相接的根及其后继是 `branch`；正文不可读的请求保持中性，不参与主链竞争。

### 新增消息

按块序列比较，不按集合比较。

```text
上一笔 = [user:A, assistant:B]
本笔   = [user:A, assistant:B, user:A]
集合差 → []          （错）
序列比较 → [2]        （对）
```

实测 600 条真实请求里 55 条含完全相同的重复消息，最多一条消息在一笔里出现 14 次。集合差在这些请求上会把用户真正新增的那条吞掉，同时影响对话视图与标题。

算法：比较两笔的**语义指纹**序列共同前缀。上一笔的序列是完整前缀时，取本笔的后缀作为新增，`prev_relation = confirmed`。比对不能拿块哈希做，见下一节。

"可比较"由持久化的消息数量判定：`body_state` 为 `available`/`partial`、骨架存在、`msg_count` 为非负整数，且块引用的数量、ordinal 连续性与指纹都符合。真实空消息数组是有效证据，整笔算新增并可以占主链根；没有骨架、缺消息引用或 `msg_count` 为 NULL 的行不可比较，记 `unknown` 并保留旧摘要。带 `previous_response_id` 的 Responses 请求同样不可比较：本笔只带增量，共同前缀比较会把无关请求连成父子。

零长度序列不当父节点：完整前缀要求公共长度大于零。空序列是任何序列的前缀，认它当父节点等于用"这一笔没有消息"证明"本笔续自它"。

候选前驱不限于"紧邻的上一笔"，而是该 `(conv_key, actor)` 组里所有更早的请求：取共同前缀最长的那一笔当"近似"，取完整前缀里最长的一笔当父节点。会话里出现并发分支或乱序到达时，紧邻上一笔往往不是真正的续写来源。

关系取值：

| 值 | 含义 |
| --- | --- |
| `first` | 本组第一笔，全部消息算新增；真实空消息数组也算 `first` |
| `confirmed` | 找到完整前缀的祖先，算得出增量 |
| `branch` | 有更早的请求，但没有任何祖先的序列是本笔前缀：另起一支或上下文被重写过 |
| `unknown` | 更早的请求里有正文不可读的，链是断的，不能断言是分支 |

`unknown` 不能升级成 `branch`：不可读的祖先可能就是真正的父节点，说"另起一支"是把缺失当成结论。

比较成本实测 0.17 ms（167 条消息）。

### 语义指纹

块哈希只服务去重与还原，不能拿来比对。同一段历史在后续请求里会因为缓存断点移动（`cache_control` 从一处挪到另一处）、`content` 从数组换成字符串、以及 harness 重新包装而换掉字节，哈希随之全变。

所以每个块额外存一份语义指纹：去掉 `cache_control`、`signature` 这类传输标记，键排序后序列化，再统一消息片段的形状（裸字符串与 `{"type":"text"}` 等价，`tool_use` / `tool_result` 各走专用分支），最后 sha256 定长存进 `block.fingerprint`。比对用指纹，去重用哈希。

真实数据上的差别（同一会话 44 笔）：

| 比对口径 | 判定为续写 | 判不出 |
| --- | --- | --- |
| 原始块哈希 | 0 | 42 |
| 键排序 + 剥传输标记 | 27 | 15 |
| 语义指纹 + 仅比紧邻上一笔 | 29 | 13 |
| 语义指纹 + 任意祖先 | 35 | 7 |

harness 包装留在指纹里：指纹只归一传输标记与内容形状，不剥文本中的 `<session>` / `<system-reminder>` 这类壳。历史消息在后续请求里字节稳定，包装因此不影响链；包装的剥离只服务标题与增量提取，规则见[输入解释与能力阅读](#输入解释与能力阅读)。

### 折叠行摘要

列表接口不读正文块。派生时把两行摘要写进 `request`：`input_preview`（本笔新增的用户消息）与 `reply_preview`（回复首段）。`input_preview_kind` 说明摘要来源：

| kind | 含义 |
| --- | --- |
| `delta` | 本笔新增的用户消息 |
| `tail` | 没有新增，取末轮用户消息兜底 |
| `tool_result` | 本笔没有用户消息，输入是上一轮的工具结果 |

用中文文案做前缀匹配来判断来源不可靠，所以单独立列。

### 工具配对

从回复里取 `tool_use`（Anthropic）、`tool_calls`（Chat）或 `function_call` / `custom_tool_call`（Responses）的 id，到后续同会话同 `actor` 的请求里按 id 找 `tool_result` / `role=tool` / `function_call_output`。配对是可变状态：

```sql
CREATE TABLE tool_call (
  call_id    TEXT NOT NULL,
  req_id     INTEGER NOT NULL,          -- 发出调用的那笔
  ord        INTEGER NOT NULL,
  tool_name  TEXT,
  -- 调用参数与结果失败位：会话汇总的事实来源，工具阶段顺带提取
  arg_path   TEXT,                      -- Edit/Write/Read 的 file_path；缺键 NULL，不猜近邻键
  arg_skill  TEXT,                      -- Skill 的 skill
  is_error   INTEGER,                   -- 配对结果显式 true 才是 1；false 与缺席按协议缺省读 0，未配对 NULL
  result_req INTEGER,                   -- 结果所在请求，未到为 NULL
  result_ord INTEGER,
  state      TEXT NOT NULL,             -- pending / resolved / ambiguous
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_tool_call_id ON tool_call(call_id, req_id);
```

结果到达时更新 `result_req` / `result_ord` / `result_path` 与 `is_error`。同一 `call_id` 命中多个候选时标 `ambiguous`，不按时间或位置猜。只在同一 `actor` 内配对，跨子代理不串。标题请求是旁路，不进工具候选。

配对在派生的同一个事务里完成，排在链阶段之后、摘要之前：摘要里"这一轮回传了哪个工具的结果"只消费本次确定下来的关联（调用位置 + 结果 ord + 结果 path），不跨组按 `call_id` 取首行。本组正文仍可读的工具行每轮清空重建；正文已回收的行原样保留，既不参与重建，也不充当本次摘要的依据。参数与失败位是行内事实：重建时从调用与结果块顺带提取，切片路径经 `derive_call_work` / `derive_result_work` 暂存转写；回收的行带着提取过的值一起保留，没提取过的留 NULL，由会话汇总的覆盖度如实呈现。

### 协议适配

hook 保留客户端协议形状。源码里四种 `Protocol` 都存在（`internal/provider/provider.go:35-41`）：`chat`、`responses`、`anthropic`、`gemini`。

保存能力与解析能力分开记状态。请求与回复各一套，因为两者会独立失败：回复超 8 MiB 被置空时请求完好，请求解析失败时回复仍可保存。

| `parse_state` / `reply_state` | 含义 | 界面 |
| --- | --- | --- |
| `ok` | 已按适配器解析 | 正常渲染 |
| `unsupported` | 原对象已保存，暂无适配器 | 显示原始 JSON，标注暂不支持解析 |
| `truncated` | 正文被截断（请求侧） | 显示已截断与原字节数 |
| `invalid` | 解析失败 | 显示失败原因 |
| `absent` | 只有回复侧：上游没给出可用回复 | 显示请求，回复区说明原因 |

`reply_state = absent` 与 `parse_state = ok` 可以同时成立，这是最常见的一类中间态。

已实现 `anthropic`、`chat` 与 `responses` 三个适配器。`gemini` 先保存、标记 `unsupported`，不显示成零消息。

协议形状（消息数组键、文本块类型、工具调用与结果的提取、系统提示来源、增量输入判据）集中在 `src/protocol-shape.ts` 一张表里。存储拆块、无损恢复、解析状态、派生抽取、结果定位与页面取键都读同一份事实，名单外协议返回空表，不按字段猜协议。

映射表的形状：

| 统一字段 | Anthropic | OpenAI Chat | OpenAI Responses |
| --- | --- | --- | --- |
| 消息数组 | `messages` | `messages` | `input`，可以是数组或裸字符串 |
| 角色 | `role` | `role`，工具结果用 `role: tool` | `message` 项的 `role`；其余项按 `type` 推断：调用与推理记 assistant，结果记 tool |
| 文本 | `content[].type == text` | `content` 字符串或 `content[].type == text` | `content[].type == input_text` / `output_text` |
| 工具调用 | `content[].type == tool_use`，id 在 `id` | `message.tool_calls[]`，id 在 `id` | 回复 `output[].type == function_call` / `custom_tool_call`，id 在 `call_id`，参数在 `arguments` / `input` |
| 工具结果 | `content[].type == tool_result`，指向 `tool_use_id` | `role: tool`，指向 `tool_call_id` | `input[].type == function_call_output` / `custom_tool_call_output`，指向 `call_id`，正文在 `output` |
| 推理 | `content[].type == thinking` | `reasoning_content` | `output[].type == reasoning`，正文在摘要项里 |
| 系统提示 | 顶层 `system` | `messages[].role == system` | 顶层 `instructions`，与 `developer` 消息同源合并 |
| 回复完成状态 | `stop_reason` | `choices[].finish_reason` | 顶层 `status`；只有 `completed` 判为正常收尾 |

Gemini 用 `contents[].parts` 与 `systemInstruction`，接入时补。

Responses 的前序响应引用（`previous_response_id`）不能解释为本笔包含全会话历史：这时 `input` 只是新增部分，链比对把它当不可比，关系落 `unknown`，也不让它充当后续请求的祖先。

### 输入解释与能力阅读

正文分页在服务端附带消息级展示解释与能力视图。解释只影响显示：原始脱敏消息、块哈希与语义指纹保持原值，页面不再维护第二套包装规则。

输入解释先逐个文本块清洗，再按换行拼接，最后对整段再剥一遍开头包装。包装按块出现，也常排在用户正文之后，因此块级清洗是主要规则，整段规则只补跨块的配对标签与插话前缀。

| 标签 | 处理 | 说明 |
| --- | --- | --- |
| `system-reminder`、`transcript`、`local-command-stdout`、`local-command-caveat`、`command-*`、`system-notice`、`recap` | 整段丢弃 | 注入内容，不是用户说的话 |
| `job`、`file`、`chat` | 整段丢弃 | omp 的作业规格、附件正文与命令简报 |
| `session`、`user` | 剥壳留内容 | 套着用户正文 |
| `<pasted_content id=…>` | 只删开标签行与闭标签 | 粘贴正文是用户输入，保留 |

只在块的**开头**剥包装，块中间的同名标签属于用户内容，原样保留。未闭合的块内标签也不动：跨块的 `<transcript>` 在块内看是未闭合的，交给整段规则按拼接后的全文配对。结果状态是 `text`、`empty`、`injected` 或 `unrecognized`；未闭合或无法识别的开头包装保留原文并标未识别。只有 `text` 与 `unrecognized` 算用户输入（`is_input`），`injected` 与 `empty` 不产生用户气泡。同一请求的多条用户消息逐条解释，不合并成一条。标题与折叠行摘要复用同一解释结果。

能力视图把协议工具定义与 Agent 技能声明分开。工具只读请求的 `tools` / `functions` 字段；技能只读 system 文本里的标签清单与 Claude 标题列表。两种能力各分 `present`、`empty`、`unrecognized`、`missing`、`partial`：正文不完整时技能最多报 partial，正文不可读时报 missing，不把没读到解释成零技能。覆盖状态记录本片的读取区间与整笔消息总数。能力按正文读取即时计算，不长期复制技能描述或工具 schema。协议未适配时工具与技能统一报 `missing/protocol_unsupported`：保存覆盖与协议解释分开表达，完整保存不推导已识别消息或零技能，原对象仍按现有正文元信息读取。

链关系与新增消息只在 `derivation.chain_state` 为 `current` 时标记为确定结论。`dirty`、`retained`、`legacy` 与状态未知分别显示重建中、历史保留、旧算法与状态未知，不显示 confirmed，也不把旧的增量序号当成这一轮新增。

### 轨迹阅读布局

中栏每个步骤占 36px 一行；序号槽整个当前窗口共用一个宽度，基准 28px，按窗口内最大序号的位数以等宽字体的 `ch` 加内距扩展，不按单行数字各自撑宽。行内显示窗口内请求序号、英文参与角色标签（`User`/`Assistant`/`Tool`/`System`，辅助与记录用 `Aux`/`Event`）、工具身份着色 chip 与内容摘要：调用行 chip 是工具名，结果行按配对三级显示调用方工具名加参数摘要、仅工具名或中性 `Tool result`；色类只包工具名，工具按 Read/Edit/Write/Bash/Skill/Agent 六色相加中性青灰着色，行内摘要按工具分派（文件参数 basename 化、Read 区间与 Edit 行数是显示折算），不在字符数上截断、超长由列宽省略号处理，`is_error=true` 的结果行整行 warn 软色，悬停给完整参数 JSON 或完整结果正文。步骤携带协议来源：输入消息按协议指向 `request.messages[N]` 或 `request.input[N]`，顶层 System 指向 `request.system` 或 `request.instructions`，回复文本与未知块指向各自内容块（如 `reply.content[i]`、`reply.choices[0].message.tool_calls[i]`、`reply.output[i]`）。点击后在右栏定位到该来源：调用步骤与已配对的结果步骤（经 `tool_results` 反向索引取得调用方）直达工具配对页，未配对的结果步骤、输入与 System 步骤打开正文，可信 delta 内的消息级 System 与工具结果内容块各占一行，记录或辅助步骤打开请求读数；右栏已折叠时自动展开。配对页是工具四页的第三页：Call 面板在上、Result 面板在下，默认同时展开，复用正文详情的 `body-panel`/`pre.raw` 组件语言，两端面板头用与中栏同款的工具色类 chip（配对 result 沿用 call 的颜色，未确认保持中性），Edit 调用的 `old_string`/`new_string` 各渲染成红绿对照块、原始参数 JSON 折叠保留，`is_error=true` 的 Result 面板给 warn 软色；进入配对页自动发起一次结果读取（已缓存不重复），调用方在窗口外时按需读取该请求；两端身份与承载请求只以文本标注，不提供跳转到别处阅读的按钮。选中步骤是唯一高亮，请求组只保留轻微边界。顶层 System 的显示由阅读层按同 actor 已确认前驱比较控制：首个已加载主请求提供当前上下文，前驱可读且同值不重复，变化才标明；比较只在阅读层发生，不改变消息 ord、指纹或前驱关系。异常作为记录步骤保留，列表不重复附加状态、结果请求链接、计量占位或展开箭头。结构列表展示已缓存消息的有序并集，相邻序号之间的空洞标明未读取；可信增量未完成或失败时提供显式续读入口（每轮两片，失败不推进消费位置），连续历史上界仍由结构游标表达。工具配对与结果读取都在右栏就地完成，加载更早记录使用行按钮的稳定步骤键保持滚动位置。历史区只保留加载入口、读取反馈与常驻的顺序说明。右栏页签（读数/正文/工具/路由）可由 URL 的 `tab` 参数声明：初始化与历史恢复解析合法页签，无效或缺省落读数；切会话与刷新保留当前页签，仍清除请求内的步骤与工具选择。当前页签为路由时，导航完成处（进入、切会话、刷新、定位）按选中请求自动读取路由，无当前请求不预取，读取失败再次进入页签可重试。用量与上下文折叠行的计时与用量各按标签和值两列展示，数值列右对齐成列，样式只作用于读数范围，不改变其他 chain 文字详情的排版；首 token 与首个文本是两个测量事件，分别成行；构成条与图例共用正值类别，图例按 token 数降序，没有正值类别时不留空的条和图例，总量、窗口、占用与估计说明保留。

桌面布局的详情栏范围为 280–640px，并给中栏保留至少 320px；默认宽度为当前窗口允许的最大值。拖拽与方向键调整当前页的首选宽度，方向键每次调整 20px，双击恢复可用最大宽度；窗口缩放和侧栏折叠后重新夹取，首选宽度只存内存。窗口宽度不超过 1000px 时三栏按文档流堆叠，分隔线隐藏。

### 轮次带与轮次两端阅读

轮次是「一条用户命令到它的最终回复」的跨请求配对，在读模型即时结算（`listTurns`），不落轮次表。轮次带贴在会话头下沿吸顶常驻，一行高横向滚动，每块是轮号加 `input_preview` 摘要，旧轮在左；无可结算轮整条不渲染，起点在已加载窗口外的轮不进带，轮号是会话内已结算轮的全序序号，加载更早历史不重号。点选后右栏进入轮次态：身份行只标「轮 N · 命令 req X · 回复 req Y」，页签行隐藏，命令组全文（起点请求内用户主动文本的消息按序）与最终回复全文两个面板默认展开；点轨迹任意行回请求态。轮次接口是 `GET /api/sessions/:key/turns?from=<req_id>`，`from` 是累计窗口下界（浏览器已加载的最早请求），结算单位是累计窗口而非单页，未知会话返回空表。

收尾判定消费派生期写下的回复形状位 `request.reply_shape`（`final`/`tools`/`unknown`，与标题摘要同一套选源：发布代优先、正文回收保留旧值、NULL 表示从未判定），起点与路径污染判定消费派生期的 `input_preview_kind='delta'` 位。只结算派生状态为 current 的组；终点沿确定 parent 前驱边可达、路径不经过其他用户命令请求，可达的 `final` 恰好一个才结算，分叉保守不结算。判据的来由、否决过的备选与正反代价见[轮次两端阅读](../.agents/notes/implemented/feature/2026-10-25-turn-pair-reading.md)。

### 会话信息汇总

会话口径的事实汇总落在 session-head：合计行就地升级为会话口径（SUM over `conv_key` 全部请求，含子代理与归属未知的行），尾部带缓存命中——Σ`cache_read` ÷ Σ(`in_tok + cache_read`)，只计两个读数都在的请求，分母为空不给数；费用覆盖（`cost_state='absent'` 笔数）与分母口径进悬停。合计行之下是 `rail-fold` 语言的折叠区：收起一行核心数（工具次数、失败数、中断次数、写入尝试与读取请求的去重路径数），展开后是工具 chip、路径流式双色 chip（各前三加二级展开）、Skill 区（无显式调用整区不渲染）与结构行（主链/旁路按 `purpose_chain` 分、上下文峰值取 max(`prompt_tokens`/`prompt_window`) 整百分点、子代理/重试/多模型足迹非零才出现）四个分区。命中率只在这一处表达；读数页的请求级命中行已退役，缓存读数悬停指向会话头。

数据由 `GET /api/sessions/:key/summary` 查询时聚合，不物化：单会话量级小，物化要跨 actor 组协调代际发布，买不来收益。有效工具行与请求详情同一套选源（发布代有该请求的行用发布代，否则回退同步旧表）；`interrupt_count` 与标题摘要同一套选源（发布代优先、回收保留旧值）。中断计数按 delta 归属：中断标记随上下文延续出现在后续每笔请求里，只在首次落入某笔确定增量的那笔计一次，判定只认用户消息第一个文本块的开头前缀（大小写不敏感），摘要引用与 tool_result 内文不算。覆盖度（配对数、失败位已知数、参数事实已知数、中断未判定数）如实呈现缺口；组 dirty 时返回已发布事实加 dirty 标志。失败调用集合直接随首屏返回；工具、路径与 Skill 条目点击后经 `GET /api/sessions/:key/summary/entries` 按组查询，右栏先开条目列表再逐项跳配对页或定位请求（窗口外走既有窗口外详情）。判据的来由、否决过的备选与正反代价见[会话信息汇总](../.agents/notes/implemented/feature/2026-10-25-session-trace-summary.md)。

### 派生算法版本

`request.derive_version` 记录这一行被重算过几次，只是历史计数，不再表示"按哪版算出来"。算法改动后按会话或按天批量重算，整体重建入口：从 `request_evidence` 找到原始记录，按当前算法重跑，写回同一 `req_id`。目标版本、实际算法与保留行由下面两节的三类记录回答。

### 有界来源事实与结果依据

原始层按保留期删除，但有些结论删了 raw 就再也推不出来：来源用途集合、hook 的独立报告、选定尝试的身份与模型。这些结论落在两列 JSON 上，与行级事实同一事务写：

| 列 | 内容 | 上限 |
| --- | --- | --- |
| `source_facts_json` | `format`、按来源分开的有界用途集合（`ledger`/`route`/`state`/`value`）、hook 的模型与成功集合、`selected` 整对象 | 16 KiB |
| `projection_meta_json` | `order`（顺序是否可证）与 models/attempts/prompt 三个族的 `actualVersion`/`state`/`reason`/`basis` | 16 KiB |

集合是有界的：单值 256 字节、每来源 8 个值、basis 16 条，按字节序去重排序，所以同一批观测无论到达顺序与重复次数都得到同一个集合。溢出标 `overflow` 而不是悄悄少几个值；非法值标 `invalid`。集合只增不减——raw 过期是本次证据缺失，不是"从没观测过"，长期集合不能因此撤销。

`selected` 是整对象替换，不做字段级拼接：两笔不同请求的模型、供应商与错误拼在一起会造出一条不存在的记录。顺序不可证时 `pending_final` 保存全 null 字段，不沿用旧值假装知道。

三个族分开记版本：`recomputed` 的 `actualVersion` 是本次版本；`retained` 保留原实际版本，不把本次版本冒充成它算出来的；从未观测过的族是 `missing`，`actualVersion` 为空。序列化超预算时先去掉只用于展示的 `error`/`errorType`，仍超限则拒绝整个投影事务（`source_facts_budget_exceeded`），不截断 JSON，也不清空旧事实。

原始行与证据行记下 `mapping_version` 与 `privacy_version`：脱敏规则或字段映射改动后，旧行是按旧规则变换的，读模型与迁移要能分辨，而不是假设库里所有行同口径。

摘要与工具配对也记自己的依据。`summary_state='recomputed'` 时写 `summary_algorithm` 与 `summary_basis`（输入修订、组世代、算法）；正文不可读时 `summary_state='retained'`，原算法与 basis 原样保留。工具行写 `algorithm_version` 与 `basis_json`，正文已回收、本轮没有重建的行只标 `retention_state='retained'`。`derive_version` 不再逐次累加，也不再被当作"当前算法"读：维护报告用 `target_algorithm`、`actual_algorithms`（按实际算法分组计数，null 归 `legacy`）与 `legacy_requests` 分开回答目标、实际与保留。

### 组完成与输入修订

派生按 `(conv_key, actor)` 成组重算整条链，所以"这一组的产物是不是最新的"必须由持久状态回答，不能靠队列里还有没有这一行。判定只有一份实现：`src/derive/state.ts` 的 `groupCurrentSql` / `queuePendingSql` / `groupIsCurrent`，读模型、组选取、切片认领、维护报告与容量探测都引用同一片段，理由见[组待办与当前判定收进 derive-state](../.agents/notes/implemented/architecture/2026-10-23-group-current-predicate-single-home.md)。

| 字段 | 含义 |
| --- | --- |
| `group_epoch` | 组的世代。组被删除后重建拿到新 epoch，旧完成记录因此不能复用到新组 |
| `input_revision` | 该组消费过的输入修订，只增不减；任何写入者发现输入变化就推进它 |
| `published_revision` / `published_algorithm` | 完成时实际消费的修订与算法；与当前修订相等且 `state='clean'` 才表示产物最新 |
| `state` | `dirty` 待派生，`clean` 已完成；待办查询一律 `state<>'clean'` |
| `dirty_since_ms` | 首次未完成触发时间。重复 dirty 保留最早值，clean 后清空 |

组内请求的 `input_epoch` / `input_revision` 是同一套修订的请求侧。输入指正文、回复、归属与来源证据：正文保存、hook 到达或合并、账本或路由的字段级事实变化、证据过期、正文回收都会推进它；只改费用不推进，因为费用不改变用途判定与派生结果。合并把两笔请求的证据并成一笔时，存活请求换新 `input_epoch`，旧 epoch 下的用途结论不再复用。

完成用比较交换而不是无条件写：drain 读到 `{group_epoch, input_revision, target_algorithm}` 后，本组全部阶段在同一事务里完成才把状态改成 clean 并记下消费的修订与算法；交换失败回滚本组，旧完成记录不会覆盖新输入。在线已提交组独立保留，重启只需继续未完成组；未发布的切片代由启动恢复丢弃，上一代发布指针保持不动。离线调用 `drainDeriveTx` 时，由调用方外层事务决定整批回滚范围。

#### 两个粒度：请求用途先于组结果

派生编排归 `src/derive/unit.ts`。在线用 `createDeriveUnit(store).run({budgetMs})` 返回 `{didWork,nextDueMs}`：每轮预算 400 ms、最多十个组或切片步骤，用途按十笔一批独立提交，组间检查剩余预算；空闲先只读判定，不开写事务。有积压时 `nextDueMs=0`，调度用定时器让出事件循环后续跑，空闲等待两秒。同步单组内部不切开，单个大组仍可能超过预算；生产切片启用限制见[派生代际与发布指针](#派生代际与发布指针)。维护与容量实验用同模块的 `drainDeriveEntry(store, limit, scope?)`，保留完整统计；需要把多个组放进外层事务的离线调用使用 `drainDeriveTx(db, {limit, scope?, purposeLimit?})`。

请求阶段按 `req_id` 取 `purpose_pending=1` 的行，按 `PURPOSE_VERSION` 解释并写 `purpose_status`（`recognized`/`unrecognized`/`missing`/`retained`/`unsupported`/`error`）、`purpose_version`、`purpose_rule`、`purpose_chain`、`req_kind` 与 `model_title`，把 `purpose_pending` 清 0 并让 `purpose_revision` 追上当前 `input_revision`。规则优先级固定为 Harness 专属强指纹 > 来源 kind > 标题兼容 > 兜底。专属指纹按 agent 标签在 `src/harness/` 的静态登记里选取，登记与编排在 `harness/purpose.ts`，同 agent 多条规则按登记次序，未知与空标签不命中任何登记项：claude 分类器（`harness/claude.ts`）要求 system 文本含 `security monitor for autonomous ai coding agents`、`stop_sequences` 含 `</block>` 同时成立，消息数 2 与工具数 0 只写信号，判定取回复里最后一个 `<block>yes|no`；omp skill 压缩（`harness/omp.ts`）要求任一 user 文本块块首命中模板前缀 `Compress into one routing hint of at most 12 words:`。通用判定留在 `semantics.ts`：来源 kind 只把精确的 `title` 当标题别名并排除链，其它非空值变成 `source:<value>` 参与链；标题兼容先看严格回复形状（整段 `<title>` 或只含 `title` 键的 JSON），再看已存 `req_kind='title'`；兜底是 `unrecognized` + `chat` + `participate`。

正文不可读时：有旧 `purpose_version` 就原样保留并标 `retained`，没有旧解释才落 `missing` 或 `unsupported`；来源 kind 只对没有旧解释的行生效。读取只解骨架与引用索引，不解压消息块。解释出错最多三次，终态记 `error` 并消费当前修订，避免一笔读不出的请求把整组卡在 dirty。写回以请求行上的身份、修订、目标与 `purpose_pending=1` 为条件，交换失败返回 stale 并保留 pending。该阶段不推进自己请求的输入修订——它消费输入，不改变输入；只在用途、链归属或正式标题真的变了时标所属组。

组阶段只消费已经定下来的 `purpose_chain`，不再自己识别一遍标题请求。组内仍有 `purpose_pending=1` 的成员时整组跳过、保持 dirty：把组算干净等于替那些请求猜了一个用途。`limit` 按组计，`purposeLimit` 是请求阶段的每批大小，drain 会连续推进到没有待判请求为止。

未知归属的请求也要完成用途：它不在任何组里，但"这一笔是标题生成"是它自己的事实，与它属于谁无关。

`DrainResult` 因此有两个排空条件：`remaining`（未完成组数）与 `purpose_remaining`（未判用途的请求数）。维护的排空循环要求两者都为 0，任一阶段无进展即报 `derive_no_progress`。

#### 派生代际与发布指针

同一组的派生结果可以整体按代存在，也可以逐字段写回请求行。两种模式共用请求用途阶段与同一份取值实现，区别只在组阶段写到哪里、读从哪里来。

代际身份是 `derive_generation.generation`：由组键、`group_epoch`、`input_revision` 与算法号拼出，主键唯一；`i_derive_generation_published` 保证一个组同时只有一代 `published`。一代的构建拆成六个阶段（`requests`、`roles`、`role_assign`、`tools`、`summary`、`ready`），每个阶段带自己的续跑游标，进程重启后从游标继续，不从头重扫。构建期的四张工作表只建不改，发布即删。

读口径由 `derive_queue.published_generation` 切换，不靠"行里有没有值"判断：

| 视图 | 给出什么 |
| --- | --- |
| `published_derive_request` | 已发布代的请求结果行，按组键连接队列指针 |
| `effective_request` | `request` 行 + 队列状态 + 该组已发布代的结果行，左连接 |

`effective_request` 让一次查询拿到同一代的快照：结果行全部来自 `published_generation` 指向的那一代，不会一半来自旧代、一半来自新代。

查询与 reading token 按 `published_generation` 选择发布代，具体读口径见[查询接口](#查询接口)；`effective_request` 与 `readEffectiveGroup` 主要供测试和容量实验使用。生产切片仍被冻结：`startCollector` 见到 `deriveBudget` 即以保留错误码 `slice_read_unmigrated` 拒绝启动，声明实验身份（`capacityExperiment`）的容量采集器可运行切片。发布代读取的合成测试不代表切片长组容量已收敛；生产启用还须验证实际切片发布后的完整读取与算法切换，并通过既有长组和速率门槛。

发布是指针的原子切换，条件在切换前全部校验完：组修订与逐请求修订一致、每笔候选都有结果行、这一代覆盖了全部已知请求、暂存行与 WAL 增长都在预算内。任何一条不成立就丢弃整代（`derive_generation.state='discarded'`，队列行写 `last_error`），指针不动，旧代继续可读。丢弃不是"抛错回滚后的补救"，而是校验结论本身，与校验在同一个事务里提交。

退役代按发布时间保留最近若干代（默认两代），更旧的连同 `derive_request_result`、`derive_tool_result` 一起删除。保留最近几代是为了历史详情与换算法前后的对照；删除最旧的那几代不改变指针，也不影响已发布代的读。

算法号区分这套结果是谁算的：`derive_generation.algorithm` 与结果行的 `algorithm` 记切片号。认领一个 dirty 组时把队列行的 `target_algorithm` 归一到当前模式的算法号——两个写入口（同步路径的组标记与切片路径的认领）会写下不同的号，混合会让认领直接失败。

### 读模型里的派生状态

行级列里有"上一次算出来是什么"，没有"这还算不算当前结论"。两者混在一起时，界面只能靠猜：正文已回收的行与刚重算的行长得一模一样。

`derivedStateOf` 用四个输入回答这件事：请求的 `purpose_pending`、所属组的 `state`/`input_revision`/`published_revision`、`target_algorithm`/`published_algorithm`、以及摘要的 `summary_state`/`summary_algorithm`。

| 取值 | 含义 |
| --- | --- |
| `current` | 用途已判、组已完成且修订与算法都追上。唯一可以当已确认结论读的取值 |
| `dirty` | 用途未判、组未完成或修订/算法没追上；未知归属的请求没有组，也只能是 dirty |
| `retained` | 组完成了，但正文已回收，标题与摘要按旧值保留 |
| `legacy` | 从未按当前算法算过 |

`listRequests` 与 `getRequest` 各自在一个只读事务里取行、组状态与工具行，投影按同一个 `current` 判定做替换：

- 关系、增量、`chain_role`、折叠行摘要与工具结果位置只在 `current` 时出现在顶层；否则为 `null`、`unknown` 与 `pending`。
- 标题退到不依赖正文的那一档：标题请求用已判定的 `model_title`，其余用模型时间占位。
- 独立事实（耗时、费用、正文状态、回复摘要、模型、时间）不受状态影响。
- 详情另带 `historical` 白名单，把旧的标题、摘要、关系与增量连同 `derived_state` 一起给出；列表不携带它。

`summary_state`/`summary_algorithm`/`summary_basis` 只在详情返回，供后续能力读取区分"当前摘要"与"保留摘要"。

会话标题的候选查询与 `current` 同条件：用途已结算、所属组已完成、修订与算法都追上；脏组或待判用途里的旧标题不拿来命名会话。排除用途提供 `model_title`，参与链的行提供用户首句；用户标题不再要求 `req_kind='chat'`，未知来源类别只要参与链也可以提供。

## 缺失与健康

### 证据缺失

`have` 位图区分缺在哪一路。界面按位显示，不合并成一个笼统的缺失。

| 现象 | 判定 | 界面处理 |
| --- | --- | --- |
| 有账本、无 hook | `have & 1 == 0` | 显示身份与读数，正文区写具体原因 |
| 有 hook、无账本 | `have & 2 == 0` 且超过阈值 | 标待关联，保留候选，不按时间强行匹配 |
| 无路由 | `have & 4 == 0` | 路由段显示当前来源不提供 |
| 收到 null 回复 | `raw_hook.success = 0` 且 `response_z IS NULL` | 显示上游未给出回复，与没收到 hook 分开 |

原始证据过期或被回收时，保留旧的最终尝试、开始时间、排序键与尝试合计：证据不完整不等于旧事实已被推翻。只有证据完整而顺序不可证这一种情形会清空排序键与响应身份，因为留着它们等于声称知道顺序。重复尝试嫌疑同样保留旧值，不用 MAX 保住合计。

### 正文缺失

`body_state` 独立于 `have`：

| 状态 | 含义 |
| --- | --- |
| `pending` | 账本已到，正文预期会到，尚未到 |
| `available` | 正文完整可读 |
| `partial` | 正文存在但被截断 |
| `evicted` | 正文已按预算回收 |
| `unsupported` | 已保存原对象，暂无适配器解析 |
| `summary` | OTLP 行只有 span 摘要；body_ref 接线成功后转 `available` |

`miss_reason` 只记 collector 真能观测到的事实：

| 值 | 判定依据 |
| --- | --- |
| `hook_absent` | 账本已到，等满阈值（默认 1 小时）仍没有任何已关联的 hook 证据，等待关联队列中也没有指向本行的候选 |
| `reply_unavailable` | hook 到了，但 `success = 0` 且 `response_z IS NULL` |
| `parse_failed` | hook 到了，`parse_state = invalid` |
| `unsupported_protocol` | hook 到了，`parse_state = unsupported` |
| `origin_not_local` | hook 到了，`origin` 不是 `local`，按配置不接收 |
| `evicted` | 曾经可用，已按预算回收 |
| `body_ref_read_failed` | OTLP 行的 body_ref 指针读不到（文件缺失、非普通文件、超 32 MiB）；行保持 `summary` |

`hook_absent` 由 pending 定时器里的老化守卫（`src/hook.ts` 的 `markHookAbsent`）在每轮合并重试之后写入，只写 `miss_reason`，不改 `body_state`。它断言的是"没有已关联的 hook 证据"，不是"hook 从未发生"：reply 缺失的回调没有 response ID 可关联，会长期留在等待队列里，对这些行 hook 其实到过。迟到的 hook 由两条路径解除标注：直接命中在落正文时清掉原因；后台合并按合并后的正文现实对账，正文完整即清空，降级原因随源行正文走。

`line_over_32MiB` 与 `reply_over_8MiB` 不能当缺失原因。`gatewayResponse` 里回复捕获超限、捕获读取失败、HTTP 状态码 ≥ 400 三种情形都落到同一句 `run.Finish(ctx, nil, false, body)`（`internal/gateway/gateway_hooks.go:27`），collector 只看得到 `reply = null` 加 `success = false`，分不出是哪一种。插件单行超过 32 MiB 时整笔 hook 都不跑，collector 连请求大小都收不到，更无从判断原因。

上游确实有一套结果码（`ready`、`empty`、`invalid`、`timeout`、`cancelled` 等，`internal/plugin/host.js` 的 `report`），但只覆盖请求阶段，通过 `onResponse` 交出去的对象里没有对应字段。回复阶段只有一个布尔 `success`。这是无法归因的结构性原因，不是实现偷懒。

所以这两个上游限制降为诊断候选：写进健康状态与排查文档，附上判定所需的额外信号。要在界面上显示确定原因，得先有新的诊断信号，例如 magpie 在 `gatewayFinish` 的参数里带上结果码。在那之前允许 `miss_reason` 长期停在 `hook_absent` 或 `reply_unavailable`，`unknown` 是合法终态，不用编一个更具体的原因。

回复失败不等于什么都没收到。上面那句 `run.Finish(ctx, nil, false, body)` 的第三个参数是请求体，`ctx.request` 照常交给 hook。所以 `reply_unavailable` 的记录仍然带完整请求，界面能显示这次问了什么、只是看不到回答。设计上必须支持这种有请求、无回复的中间态，不能因为缺回复就把整条记录丢掉。`parse_state` 记请求的解析结果，回复侧另用一个可为空的标记。

### 健康状态

缺失与健康是两回事：缺正文可能是上游没提供，也可能是 collector 还没追上。`/api/stats` 记录：

| 指标 | 含义 |
| --- | --- |
| 各路已处理位置 | 账本偏移、路由文件代际与偏移、最后成功时间 |
| 解析失败计数 | 按来源与原因分桶 |
| 待关联数与最老待关联年龄 | 判断 hook 与账本的对账是否卡住 |
| 磁盘 | 库、WAL、临时文件的字节，正文预算占用 |
| 版本探针结果 | 当前 magpie 版本是否在已验证区间 |

新进程刚启动、回放尚未追平的时候，某一路缺数据不代表它永久缺失，健康页先标为追赶中。

### 三条硬规则

缺失等于键不存在。账本文件里 `cache_write`、`credits` 在多数行根本不存在，API 把它们补成 0。所以 token 与字段存在性以文件为权威，`cost` 与 `priced` 以 API 为权威，两者分开记来源。

时间统一转 epoch 毫秒再比较。原始串保留在 `t_text` 里，因为 through 行带本地时区偏移、direct 行是 `Z`，字符串比较在排序、去重、按天分组三处都会错。

截断要单独记账。不能把截断的正文当完整正文解析，也不能把截断当成缺失。AVA 那 98 条就是教训：记录在，骨架不是合法 JSON，解析静默失败，看起来像这笔没有正文。

## 查询接口

内部接口，只给本机页面用。路径前缀 `/api`。

| 接口 | 用途 | 分页 |
| --- | --- | --- |
| `GET /api/sessions?limit=50&cursor=` | 会话列表，含笔数、最后时间、异常标记 | keyset，(last_ms, conv_key) |
| `GET /api/sessions/:key/requests?limit=100&cursor=&direction=older` | 会话内请求列表，只返回列字段；direction 省略为 forward | keyset，(started_ms, req_id)；older 游标绑定会话与方向 |
| `GET /api/sessions/:key/summary` | 会话口径汇总：工具、路径、Skill、中断、资源合计、结构与覆盖度；查询时聚合 | 无 |
| `GET /api/sessions/:key/summary/entries?kind=&name=/path=` | 汇总条目点击后的按组支撑记录；kind 取 tool/written/read/skill/interrupts | 上限 1000 |
| `GET /api/requests/:id` | 单笔读数、费用状态、正文状态 | 无 |
| `GET /api/requests/:id/body?from=0&to=40&if_reading=` | 分页取消息；`if_reading` 可选，携带时校验阅读版本 | 消息序号区间 |
| `GET /api/requests/:owner/tools/:ord/result?if_reading=` | 按调用位置读取一个工具结果内容块与原始协议对象；token 必填 | 无 |
| `GET /api/requests/:id/route` | 路由决策与尝试链，来自 `route_summary` | 无 |
| `GET /api/stats` | 体积、覆盖位统计、健康状态、探针结果 | 无 |

列表接口不返回骨架。会话内 1,825 笔的列表，每笔骨架 9.5 KB，全取就是 17 MB，列表只返回 `req_id`、时间、状态、模型、四个读数、标题、`have`、`body_state`、`via`。

列表与详情都带 `derived_state`，并只在该值为 `current` 时把关系、增量与折叠行摘要放在顶层。详情另带 `historical`（旧派生结论连同状态）、摘要的算法三列与 `tool_results` 反向配对；列表不携带这几项。`tool_results` 是本请求承载的结果块指向的已发布调用（调用方请求加既有工具行）：与 `tool_calls` 同源同闸门，发布代表先、非空不回退，同步回退用同组请求（conv_key/actor）的 IN 子查询驱动 `(req_id, ord)` 主键，候选规模是组内请求数，不全局扫描，也不外露跨组脏行；非 current 为空数组。判定的具体规则见[读模型里的派生状态](#读模型里的派生状态)。

派生列的取值来源整套一致：队列带 `published_generation` 指针时，标题、摘要、关系、增量、链角色、回复摘要、中断计数与工具配对整组读 `derive_request_result` / `derive_tool_result`，摘要状态映射代际的 `retention_state` / `algorithm` / `basis_json`；没有指针时整组读 `request` / `tool_call` 同步旧列，它们同时是「上一次完成值」的家，dirty 组的 `historical` 从这里取。同一条件应用于整组列，不出现标题取发布代、摘要取同步列的混拼；当前与否的屏蔽闸门仍是 `projectRow` 与 `derived_state`。同步可用性判据唯一落在 `derive-state` 的 `groupCurrentSql` / `groupIsCurrent`，查询不另立第二套口径。alias 解析与行读取在同一只读事务内，避免跨快照。

详情另附四个展示视图：`prompt`（上下文阅读）、`source_facts`、`projection_meta` 与 `derivation`。上下文比例只在 prompt 族状态为 `recomputed` 且窗口为正时计算；`retained`、`invalid_input`、`missing` 即使带着旧计数也不给比例，并说明原因。正文分页附带 `interpretations`、`coverage` 与 `capabilities`，解释只覆盖当前页。这些视图都按白名单挑标量，不返回原始 JSON；失效或缺失的值保持 null，不从邻近字段补猜。

分页用 keyset 不用 offset。摄入一直在写，offset 会漂移，游标是本页边界行的 `(started_ms, req_id)`。`direction=older` 无游标取最近一页并向更早翻页，返回仍按时间正序；它的游标额外绑定会话与方向，未知方向返回 400，不静默按 forward 处理。为什么两方向共用一个索引、以及旧二元游标不能混用，见[最近请求窗口与向前分页](../.agents/notes/implemented/feature/2026-10-24-older-window-pagination.md)。

阅读版本（reading token）绑定一笔请求的轨迹输入与派生位置：输入修订、组代际、发布指针、正文状态与用途身份变化都会换发，只改费用不换。token 形如 `r1-` 加 64 位十六进制，只是读取身份，不是认证凭证。详情响应附带 `reading_token`；正文接口的 `if_reading` 可选，携带后与当前身份不符返回 409 `reading_changed`，畸形值 400。工具结果接口必须携带 token：它按 owner 的调用序号定位一次调用，再按记录的 `result_req + result_ord + result_path` 精确取一个内容块，路径只认 `request.messages[N](.content[M])?` 且 N 必须等于 `result_ord`，目标 canonical 与 actor 要和调用方一致；Anthropic 块须是配对 `tool_use_id` 的 `tool_result`，Chat 须是 `role=tool` 且 `tool_call_id` 匹配。关联未确认或组不 current 返回 `pending` / `ambiguous` / `unpaired`，目标不可读返回 `unavailable`，位置或身份不符返回 `invalid_location`；原因用固定词（`body_evicted`、`location_mismatch`、`call_id_mismatch` 等），不回传 SQL 错误。`resolved` 只代表关联已确认，`is_error` 三态表达工具是否报告失败。成功响应另带 `raw` 精确协议对象：Anthropic 是配对的 `tool_result` 块，Chat 是整条 `role=tool` 消息；其余状态 `raw` 为 null。alias 解析、身份与读取在同一个只读事务内完成。

正文按消息序号区间取，一次 40 条，块解码在单次请求内复用缓存。实测取 40 条 0.13 ms，最重的一笔 526 块全取 13.7 ms。正文已回收时返回 `evicted` 与回收原因，不返回空。

过期状态要能被调用方区分。原始路由过期但摘要还在时，路由接口照常返回；摘要也没有时返回明确的过期标记，不返回空对象。

不做服务端全文搜索。FTS5 可用，但正文在块里，建索引要把每块都解压一遍，写入与存储成本都不小，第一版的会话导航不需要它。

## 容量与保留

### 单笔请求的存储成本

回放实测 43.6 KB/笔，拆开是：

| 组成 | 每笔 |
| --- | --- |
| 正文边际新增内容（88 KB 原文，3.45 倍压缩） | 约 26 KB |
| 骨架（去 summary，2.7 倍压缩） | 9.5 KB |
| 引用行与索引 | 约 6 KB |
| 读数字段与索引 | 约 2 KB |

### 两个预算

10 GB 只覆盖正文，实际有两笔账要算。正文预算默认 10 GB、可配置，计入 `block.z`、`skeleton_z`、`raw_hook` 里未清空的正文副本，这是回收的对象。总磁盘上限默认 16 GB，计入数据库文件、WAL、临时文件与库外产物，到线时停止接收正文、只记元数据，并告警。

按 43.6 KB 一笔：

| 日请求量 | 日增长 | 10 GB 可保留 |
| --- | --- | --- |
| 4,000（当前） | 约 178 MB | 约 56 天 |
| 12,000（3 倍） | 约 534 MB | 约 19 天 |
| 40,000（10 倍） | 约 1.78 GB | 约 5.6 天 |

10 GB 是一个正文预算，而正文体积由 Agent 实际读了多少文本决定。压缩和去重只能削减重复部分，不能削减新增部分。3.45 倍的压缩比已经用掉了 zstd 级别 3 的收益，再往上调只换来个位数百分点。

16 GB 是硬上限。只停正文挡不住整个库的增长：`request`、`request_evidence`、`route_summary` 都是长期保留的，正文停了它们照涨。按每笔约 2 KB 的读数字段加索引，4,000 笔/天约 8 MB/天，一年 2.9 GB 左右；请求量翻十倍就是 29 GB，单靠元数据就会超过 16 GB。

所以分两级：

| 水位 | 动作 |
| --- | --- |
| 达到正文预算 | 按天回收正文，正常运转 |
| 达到总磁盘 80%（12.8 GB） | 停止接收新正文，只记元数据，告警 |
| 达到总磁盘 95%（15.2 GB） | 停止写入新证据行，只推进游标与健康计数，健康页与接口明确报告采集缺口 |

OTLP 摄入走同一梯度：80% 档 span 与摘要照收，body_ref 停止读文件、状态记 `metadata_only`（指针保留，腾出空间后不补读）；95% 档 `/v1/traces` 与 `/v1/logs` 整批拒绝，回 507，不产生半批入库。

第二级必须在 16 GB 之前落地，否则硬上限只是一句承诺。停止写证据时要留一条可查记录：从哪个偏移开始没有入库，等空间恢复后能从那个偏移补上，不做静默丢弃。

停止接收正文之后，元数据本身也不能无限长。真正到 95% 时只剩一种可执行的收敛方式：按天淘汰最旧的长期元数据。这违背元数据保留全部历史的初衷，所以它是最后一档，触发时必须显式记录淘汰区间，不能悄悄执行。

两个量要分开测。回收之后的长期元数据成本不能从当前 43.6 KB/笔反推，那个数字含正文。不按固定天数推断触顶时间；上线后跑一段时间，单独统计 `request` 每行的实际字节（含索引），再据此判断 16 GB 是否够用。

三个可调杠杆，按代价从低到高：

1. 分级保留。元数据（`request` 行与 `route_summary`）保留全部历史，正文（`block.z`、`skeleton_z`）按预算滚动。
2. 超大块降级。超过 256 KB 的单个块只存哈希、前 4 KB 预览和原始大小。实测块最大 602 KB，这类通常是整文件读取。
3. 训练 zstd 字典。对块内容训练一个 64 KB 的字典，小块压缩比能改善。代价是多一套训练与版本管理流程。

第一版只做分级保留，另两个留接口不做。

### 回收

回收只动正文。删 `request` 行会让超过正文预算后的历史请求读数、会话导航与标题一起消失，与元数据保留全部历史的初衷自相矛盾。合成验证里执行这条删除之后，请求行数为 0。

```text
1. 选出最旧一天仍持有可回收正文的 req_id 集合：
   body_state IN ('available', 'partial', 'unsupported')
   或 skeleton_z IS NOT NULL
2. 事务内删除这些 req_id 的 request_block 行
3. 对第 2 步涉及的块 id 集合做反连接，删除无引用的 block 行
4. 同一事务内：置 skeleton_z = NULL，body_prev_state = body_state，
   body_state = 'evicted'，body_evicted_at = now，
   body_evict_reason = 'budget'
5. 清空这些 req_id 在 raw_hook 里未清空的正文副本
6. 超过保留期的 raw_ledger / raw_route / raw_hook 按天删除
7. PRAGMA incremental_vacuum，随后 PRAGMA wal_checkpoint(TRUNCATE)
```

`request` 行、`route_summary`、`request_evidence` 都不删。

候选不能只挑 `available`。`partial` 保存着截断前的正文，`unsupported` 保存着整份原对象，两者都计入正文预算，只挑 `available` 会让它们永远占着空间。第 6 步的 raw 清理还会把 `unsupported` 的对象按天删掉，而 `body_state` 仍写着已保存原对象，两边自相矛盾。

所以候选条件是仍持有可回收正文。删完之后 `body_state` 统一写成 `evicted`，原状态写进 `body_prev_state`：能不能解析与正文还在不在是两个问题，前者由 `parse_state` 表达，后者由 `body_state` 表达，两者的历史都不能被回收动作覆盖掉。

`pending` 不进候选。它的正文还没到，删它没有意义，而且它大概率还没占空间。

回收中断要能被检出。第 2 步与第 4 步在同一事务内，中断则整体回滚；引用删除、孤儿清理与正文标记三者不可分离。

物理收缩。SQLite 默认 `auto_vacuum = 0`，删数据后页进入空闲列表可复用，文件不缩。复现结果：删约 6.7 MB 数据后页数维持 522、空闲 520，文件 6.7 MB 不变。

`auto_vacuum = INCREMENTAL` 必须在建表前设置并验证；已有库需要单独迁移（`VACUUM` 一次）。设置之后，删除数据、`incremental_vacuum`、`wal_checkpoint(TRUNCATE)` 三步缺一不可：只做前两步文件仍是 6.7 MB，三步都做才归到 0.0 MB。

回收不在凌晨等。磁盘接近上限时就触发，按批次限量执行，单批事务不阻塞写入。写入低峰（实测 16:00 前后是高峰，凌晨是低谷）只是调度上的偏好。

## 版本与形状漂移

版本探测读 `~/.config/magpie/last-version`，再调 `GET /v1` 取 `version`，两者不一致时以 HTTP 为准并记录。已验证区间初始定为 `>=0.1.1294 <0.2.0`。超区间仍启动，但每条记录写 `magpie_version`，界面对超区间采集的数据标未验证。版本不能只在启动时锁一次：设计期间本机从 0.1.1294 升到了 0.1.1296。

形状探测也要持续做，每批新记录抽取样本检查必含字段：

| 源 | 必含字段 |
| --- | --- |
| 账本 | `t`、`agent`、`model`、`in`、`out`、`status` |
| 路由 | `id`、`time`、`agent`、`model`、`tries`、`prompt`、`order` |
| hook | `protocol`、`path`、`agent`、`request` |

缺字段分两种处理。整批都缺、且与版本变化同时发生，判为形状漂移，进入降级模式并标记新采集的数据。个别记录缺某个可选字段，按该字段合法缺失处理，不触发降级。本地升级与按类型缺字段不能混为一谈。

未知字段不丢弃，进 `payload_json`。字段名映射集中在一个模块里，magpie 改名时只改那处。每个字段同时记录读取状态：读到值、空串、没有键、类型不对，四者分开。空串既不是值也不是撤销；类型不对不抛错、不转类型，值保持 NULL 并记下状态，一条坏字段不降级整批。`prompt.counted` 省略时写 0 但状态记作未校准——合法省略不等于 false。

## 安全边界

只绑回环地址不足以保护正文接口。任意网页也运行在本机浏览器里，DNS rebinding 可以让外部域名解析到 127.0.0.1；magpie 自己就因为这个问题修过（LESSONS.md 记录的 c431225a）。只监听地址加不开 CORS 不构成浏览器访问边界。

| 约束 | 做法 |
| --- | --- |
| 监听地址 | 写死 `127.0.0.1`，不读环境变量覆盖 |
| Host 校验 | 只接受 `127.0.0.1:<port>` 与 `localhost:<port>`，其余 403；hook 与 OTLP 端点共用 |
| 页面 API 来源 | 限同源；拒绝跨站与 `Origin: null`；无 Origin 的非浏览器访问走独立规则 |
| hook 认证 | 薄 hook 持本地随机令牌，写在 `plugins.json` 的 options 里，不暴露给前端 |
| OTLP 认证 | Bearer 独立 `otlp.token`，与 `hook.token` 分开；content-type 非白名单的简单请求 415，不给跨站浏览器留下无预检写入口 |
| `origin` 过滤 | 在认证之后执行，`origin=local` 只是来源标签，不是认证 |
| 渲染 | 正文与路由内容一律转义，不直接插 HTML |
| 账号字段 | `providerAccount`、`providerKeyId`、`host` 只在本地库，接口默认不返回 |
| 运行数据 | 库、日志都在用户目录，`.gitignore` 再加一层 |
| 不扫描 Agent 会话文件 | 只读 magpie 自己写的来源；OTLP 的 body_ref 只读事件显式指到的单个文件 |

### 脱敏

hook 拿到的是脱敏前的正文。collector 自己实现一层，规则分四类：

| 类 | 处理 |
| --- | --- |
| 请求头 | 白名单保留 `content-type` 之类，`authorization`、`x-api-key` 等替换为占位符 |
| 已知凭证形态 | `sk-`、`Bearer `、`AKIA`、私钥块、JWT 三段式等按模式替换 |
| 敏感字段路径 | 按字段路径匹配，不用宽泛键名。凭证路径替换，用量字段（`usage.*`、token 计数）保留 |
| 用户自定义 | 配置文件里的正则列表 |

占位符要保持稳定。同类同值映射到同一个占位符，正文仍可读，去重也不会因为脱敏变得零碎。`account` 与 `providerAccount` 指向同一订阅身份，两者都得到同一个 `credential` 占位符，否则同一个人在两个入口下看起来像两个人。已经是占位符的值原样返回，重复脱敏不会把占位符再散列成另一个 digest。

脱敏在分块之前做。块哈希基于脱敏后的内容，同一份内容不会因为一次带凭证一次不带而存两份。

字符串里的 JSON 也要检查。工具参数常以字符串形式携带 JSON，只遍历外层对象会漏掉。脱敏规则带版本号，验证集覆盖凭证、数字、工具 schema 与关联 ID 四类，确保规则没有误伤。

## AVA 下线

顺序不能颠倒，否则切换窗口里会丢正文。

```text
1. collector 的 hook 上线，与 AVA 并行，各自收一份
2. 观察 collector 侧覆盖率，按同一时间窗、相同筛选比对
3. 停 AVA 服务，从 plugins.json 摘掉 AVA hook
4. 撤 AVA 的常驻进程与开机启动
5. 保留 AVA 库只读，不导入数据，不写入
```

第 2 步的比对方法：同一时间窗、相同筛选范围下，按原始与规范化两种 `response_id` 集合分别比对条数。AVA 侧在采样时点有 3,480 条带可用正文、98 条被自己的 2 MB 上限截断，collector 侧应当多出这 98 条。但 98 是历史快照，不能当成未来并行窗口必须多出的固定数量，只能作为量级参照。

下线前还要求两件事：回收与恢复能力已完成并通过恢复测试，以及有明确的回滚方式。预算触顶、磁盘满与停机行为也要进下线判据。

并行期的预算：两个 hook 串行，总预算按各自 `gatewayTimeoutMs` 相加，夹在 2 到 10 秒之间。AVA 没设这个值，取默认 1 秒。collector 若设 2 秒，合计 3 秒，在限额内。并行期间不需要改 AVA 的配置，但要确认 collector 不超过 2000。

已知的缺口分两类，性质不同。

- 19:02 到 19:41 之间 AVA 有 39 分钟几乎无记录，同期账本也只有 1 行。那段时间本机确实没有请求，不是 hook 掉线。
- 20:07 到 20:19 的 12 分钟空档同理，同期账本只有 4 行。
- 18:08 到 18:33 那 83 笔缺失是另一回事：账本有 172 笔，AVA 有 90 笔，缺的 83 笔全部来自同一会话、同一模型，prompt token 在 18 万以上。这指向超大请求的回调丢失，上线后按 `miss_reason` 分桶统计。

## 落地顺序

在原四步之前加一个持久化验证阶段。

阶段 0 做持久化验证。不接真实流量，用合成库验证四件事：账本物理记录身份能容纳同 `route_id` 的多行；事务中断后重启不丢不重；路由文件跨午夜、`.jsonl` 与 `.gz` 并存、`.gz` 被替换三种情形下证据集合一致；`auto_vacuum` 与磁盘策略按预期收缩。

第 1 步只读账本与路由，出一个真实数据页面。

- 范围：`raw_ledger`、`raw_route`、`route_summary`、`request`（无正文）、`/api/sessions`、`/api/sessions/:key/requests`、`/api/requests/:id`；
- 前端把 `TIMELINE` 换成一次 `fetch`，界面不动；
- 判据：尝试不增加顶层请求数、最终状态取最后一条非 `handed_on` 行；回放中断后不丢不重；费用状态有来源；Host 与 Origin 校验生效；1,825 笔会话分页在 100 ms 内返回。

这一步结束时，界面上正文全空、只有读数与路由，这是预期状态。

第 2 步接 hook，落正文，写派生字段。

- 范围：hook 端点与认证、脱敏、分块、内容库、标题、增量、工具配对、协议适配（anthropic 与 chat）、`pending_hook`；
- AVA 并行运行；
- 判据：大 envelope、不支持协议、重复消息、父子代理、迟到正文与工具结果各自有合成验收；脱敏在所有落盘之前完成；最重的一笔正文合并不超过 50 ms（实测 13.7 ms）。

第 3 步停 AVA，做回收与保留。

- 范围：正文预算、总磁盘上限、分级保留、孤儿清理、`/api/stats`；
- 判据：强制回收最旧一天后，历史请求仍可分页查询，读数与会话请求数不变，正文返回 `evicted` 与原因；灌入可重复正文、唯一正文与 `raw_hook` 副本，持续观测库、WAL 与临时文件的实际字节，预算触顶后停止增长；回收中断后无悬空引用、无误删共享块；恢复测试通过后才进入 AVA 下线。

第 4 步 direct 回填，可选。

- 范围：走 `/v1/magpie/usage/requests?via=direct` 分页拉取，`limit=500` 一页，31,072 行约 63 次请求；
- 判据：单独确定稳定身份。相同 `(t, session, agent, model, in, out)` 只视为候选重复，未经证明不合并两条合法调用；会话键与 through 不混。

## 未决问题

1. 超大请求的 hook 回调为什么会丢。缺失集中在 18 万 token 以上，占该量级 17.5%。同会话并发中位数与命中组相同，AVA 同时段摄入耗时也正常。上线后按 `ep`、`status`、正文大小、`ms` 与 `miss_reason` 分桶统计。32 MiB 单行上限与回复 8 MiB 上限是两个已知的确定性成因，但 collector 现在无法逐笔区分它们，只能归到 `hook_absent` 或 `reply_unavailable`。要让缺失原因更精确，需要 magpie 在 hook 载荷里带上失败类型，这件事取决于是否愿意改上游。
2. direct 是否还会新增。31,072 条全部落在 2026-08-20 到 2026-10-13，之后到 10-20 只有 1 条。判断它是 magpie 对会话文件的首次索引回填。如果 magpie 重启或会话文件变动时会重新扫描，需要再测。
3. 分级保留的切分点。正文按天滚动、元数据全留是当前建议。多大预算下开始丢正文、丢哪些会话，需要先定一个偏好，比如最近 30 天全留、更早只留读数。
4. 是否保留推理正文。路由里有 `reasoningHidden` 标记，账本有 `reasoning` token 数，推理正文只在 hook 的回复里。是否入库、入哪一层会影响正文体积。
5. `route_summary` 是否要保留 `prompt` 分解。现在 `prompt_tokens` 与 `parts_json` 存在 `request` 行上，够用。如果以后要按工具名统计历史用量，需要在摘要层补一份。
6. 多实例。当前设计是单进程单库。`route_id` 是进程内时钟计数，跨机可能撞。现在不加实例标识，但要预留一列。
7. 长期元数据的实际单笔成本。16 GB 的上限与 95% 那一档淘汰策略，取决于 `request` 每行加索引后的真实字节。当前 43.6 KB/笔含正文，不能直接用来推算。上线后单独测这一个数，再决定 16 GB 是否合适。
8. direct 的稳定身份。第 4 阶段开工前要定，候选是时间加多个读数字段的组合，但同字段全同不证明是同一笔调用。在第 4 阶段之前，API 行只在单次回填批次内幂等。
9. 要不要开请求归档。`RequestArchive` 能把 hook 丢失的正文补回来，代价是正文出本机、进 S3。设计上已经把 `archive` 抄进 `request`，开与不开都不影响主通路，但影响缺正文是不是终态。这需要先定隐私偏好。
10. `handed_on` 行会不会真的出现。本机 20,470 行一次都没有，但类型定义在。如果它只在 Codex 单账号过载重试那条路径产生，就要在测试里构造该场景，否则 `attempt_*` 字段永远是最终回复的副本，无法验证。

## 两轮修正的记录

早期估算被实测推翻的部分：

| 旧结论 | 实测修正 |
| --- | --- |
| 去重后内容占 5.8% | 11.3%。块级 1,261.6 MB 引用降到 142.7 MB；规范哈希 11.0% |
| hook 覆盖率 97.3% | 可用正文 94.98%，另有 2.67% 被 AVA 的 2 MB 上限截断 |
| 单笔约 34 KB，10 GB 可留 75 天 | 43.6 KB，56 天 |
| zstd 级别 3 得 3.72 倍、级别 9 得 4.06 倍 | 3.45 倍与 3.75 倍；早期用 `{ level }` 参数，被 Bun 静默忽略 |
| direct 行在账本文件里 | 文件里一条都没有，只有 API 拿得到 |
| 账本 19,799 行、当日 3,957 笔 | 同一时点 20,470 行、当日 4,288 笔 |

第一轮评审推翻的结论：

| 旧结论 | 修正 |
| --- | --- |
| 账本主键 `r:<route_id>` | 改为物理记录身份 `(source_kind, file_generation, byte_offset)`；`route_id` 降为普通索引 |
| `kind` 非空即 handed_on | 两者是不同的字段。`handed_on` 是计费失败行，`kind` 是调用用途，8 条真实 `web_search` 会被误删 |
| 费用取账本文件 | 文件里没有 `cost` 与 `priced`，只能从 API 按 `route_id` 补 |
| 回收第 4 步删除 `request` 行 | 与元数据全留矛盾，改为只清正文并标 `evicted` |
| 单个 10 GB 预算 | 拆成正文预算与总磁盘上限两个数 |
| spool 先落盘再入库 | 去掉。直接事务提交中位 15.2 ms（3.82 MB），预算余量二十倍以上 |
| 按 8 MiB 收 hook 载荷 | `conversationBodyMax` 只管回复捕获；请求体上限是插件单行 32 MiB，envelope 自定 64 MiB |
| 增量用集合差 | 改用块序列共同前缀。55/600 条真实请求含重复消息，集合差会吞掉新增 |
| 派生一次算完 | 加稳定排序与局部重算；工具配对改为可变状态 |
| 派生只按 `session` | 加 `actor`（子代理优先）。408 条子代理行里 407 条与父代理共享 session |
| 做 `cache_control` 规范哈希 | 不做。存储收益 2.3%，却让块不再是原字段，并给增量比较引入额外变量 |
| 路由详情随原始层过期 | 另存 `route_summary`，0.46 KB/行，10 GB 可放约 14.6 年 |
| `block.refs` 引用计数 | 去掉。孤儿改由当天候选集反连接判定，避免计数漂移 |
| `auto_vacuum` 用默认 | 必须建表前设 `INCREMENTAL`，且回收后要 `incremental_vacuum` 加 checkpoint |
| 只绑回环地址 | 加 Host 校验、同源限制、hook 独立令牌；`origin` 过滤放在认证之后 |
| 启动时探测一次形状 | 持续抽样探测，区分形状漂移与按类型合法缺字段 |
| 未定义增量读取协议 | 游标与证据同事务；半行不前移；代际变了重读；`.gz` 按摘要识别 |

第二轮评审推翻的结论：

| 旧结论 | 修正 |
| --- | --- |
| 文件代际含 size | 代际只含 dev + inode + birthtime。含 size 会让每次追加都换代，旧行以新身份重复入库；首块哈希也不能按增长的字节算，改为首次见到时冻结的基线 |
| 账本与路由共用一套去重 | 分开。路由按 `route_id` 逻辑去重，账本必须保留同 route 的多条计费行，只能按物理身份 |
| 声称账本实测有多条计费行 | 没有。20,470 行里 `handed_on` 0 次、`route_id` 重复 0 组。主键仍按物理身份，理由是不依赖上游语义，不是现状需要 |
| 尝试总量没有长期位置 | `request` 加 `attempt_*` 一组列，原始层过期后仍可查；`tries_json` 补用量与费用状态 |
| 回收只挑 `available` | 候选改为仍持有可回收正文，覆盖 `partial` 与 `unsupported`；原状态留 `body_prev_state` |
| 没有按块反查引用 | 恢复 `i_rb_block`。缺它时候选块反连接是 `SCAN rb`，有了才是覆盖索引查找 |
| `miss_reason` 写上游限制 | 只记可观测事实（`hook_absent`、`reply_unavailable` 等）；8 MiB 与 32 MiB 降为诊断候选，`unknown` 允许长期存在 |
| 16 GB 只停正文 | 明确为硬上限，加 80% / 95% 两级水位与停止写入策略；元数据自身的增长单独统计 |
| API 行身份用 `(via, offset)` | 删除。分页位置会位移，只在单次回填批次内幂等；逻辑身份留到第 4 阶段 |

读 magpie 子系统文档后补的结论：

| 旧结论 | 修正 |
| --- | --- |
| hook 是唯一的正文来源 | 上游还有请求归档（`RequestArchive`，S3，已脱敏，单笔上限 32 MiB 默认）与网关会话记录（`GatewayConversations`，本地 7 天）。主通路仍是 hook，归档作为 `archive` 字段写进 `request`，缺正文时可回源 |
| 回复失败就是缺正文 | `run.Finish(ctx, nil, false, body)` 的第三个参数是请求体，失败时请求照常交给 hook。新增 `reply_state`，与 `parse_state` 分开 |
| 缺失原因可以写得更细 | 上游给 hook 的结果码只覆盖请求阶段；`onResponse` 交出的对象里没有失败分类，回复阶段只有一个布尔。这是结构性限制 |
| `handed_on` 行是常态 | magpie 的 `gateway-routing.md` 写明一笔请求一条用量记录，多尝试记在 `tries` 上。本机 20,470 行印证 |
