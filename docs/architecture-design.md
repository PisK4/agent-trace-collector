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

设计目标是承载本机后续全部大模型调用的记录流量，功能点以原型已覆盖的为准，不扩范围。

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
  └─ 用量接口（只读）───────> direct 回填 ───┘        │
                                                      │
浏览器 ─────────────────────────────────────────> /api/*
```

进程内分四个职责，跑在同一个 Bun 事件循环里：

| 职责 | 触发方式 | 作用 |
| --- | --- | --- |
| ingest | HTTP 请求 | 脱敏、分块、入块库、写 `raw_hook` 头与 `request`，事务提交后返回 |
| tailer | 定时（账本 5 秒，路由 2 秒） | 按文件代际与完整行偏移增量读两个来源 |
| reconciler | 定时（1 秒）加 ingest 完成事件 | 合并证据、补前驱、重算受影响派生 |
| query | HTTP 请求 | 只读查询 |

写操作全部走一个 writer，避免 SQLite 的 `database is locked`。实测第二个连接在写事务期间写会被拒绝，读不受影响。查询用独立只读连接。

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
  source_kind     TEXT NOT NULL,       -- ledger / route_file
  source_name     TEXT NOT NULL,       -- usage.jsonl / 2026-10-20.jsonl
  file_generation TEXT NOT NULL,       -- dev+inode+birthtime，不含 size
  committed_off   INTEGER NOT NULL,    -- 已提交的完整行末尾字节
  seen_size       INTEGER,             -- 上一轮看到的长度，只用于判断截断
  head_len        INTEGER,             -- 首次见到时冻结的基线长度，不随后续增长变
  head_hash       TEXT,                -- 该长度的哈希，用于识别 inode 复用
  fingerprint     TEXT,                -- 压缩文件的整体摘要，重新识别用
  last_ok_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_name)
);
```

`seen_size` 只参与判断，不进 `file_generation`；`head_len` 写入之后不再改。

证据与游标同事务。一批行入库、游标前移、`last_ok_ms` 更新在一个事务内提交。中途崩溃时游标回到上批末尾，重读的那几行靠物理记录身份去重，不产生重复。

半行不前移游标。只读到换行符为止，末行没有换行就等下一轮，不猜也不补。盘上文件末尾本来就没有换行时，这个行为会一直等到该行写完，这是对的。

代际变了就重新识别，长度变了只判断截断。每轮读取前重算 `file_generation`，与游标里记录的不一致说明文件被替换，把该来源的 `committed_off` 归零、换上新代际再重读，已有的行按物理身份幂等跳过。dev 与 inode 都没变时补一次头部基线比对，按 `head_len` 重算哈希，与 `head_hash` 不一致说明 inode 被复用或者文件被原地重写，同样算新代际。文件身份不变而 `seen_size` 小于 `committed_off`，说明文件被截断重写，把偏移归零重读，但代际保持不变，旧行的身份仍然有效，不会重复入库。

历史日整体重写是常态。`pruneHistory` 会读整个 `.jsonl`、以 gzip 成员形式追加到 `.gz`、再临时文件替换整个 `.gz`（`internal/gateway/history.go:110-160`）。所以 `.gz` 的偏移没有意义，同一天可能在 `.jsonl` 与 `.gz` 里各存一份。做法是 `.gz` 按 `fingerprint` 识别，整体摘要没变就跳过，变了就全量解压重读、靠物理身份去重；`.jsonl` 与 `.gz` 都在时优先读 `.jsonl`，`.gz` 只补它没有的行。

跨午夜的迟到路由。凌晨之后到达的路由可能写进前一天的 `.jsonl`，所以读取不按当前日期筛文件，而按每个文件自己的游标判断。一个已经被判为彻底归档的日期文件被重新创建时，按新代际重读。

账本与路由共用一个读取器，只差解析函数。实测日增 22 MB（路由）加 10.7 MB（账本），按当前节奏一轮读几 KB 到几百 KB，不构成压力。

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

每个 `req_id` 维护一个来源位图 `have`：1 为 hook，2 为账本，4 为路由。

```text
through 请求：期望 1|2|4
rejected：    期望 2（永远不会有 1 和 4）
hook 独有：   只有 1，超时未对上账本则停在 1，标记为待关联
```

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

当前结构版本是 v5。普通 `openStore` 从不做 `ALTER`：空库直接建到 v5；低版本报 `schema_rebuild_required`；高版本报 `schema_version_unsupported`。

首版发布前不提供跨结构升级。旧库的处理是停采集器、把数据目录整体移走或删除，让新版本建新库；旧库里的正文与派生结果一起丢弃。因此不存在"结构已升级、数据未迁移"的中间态，也没有完成标记或续跑入口。

### 脱敏盐绑定与可恢复快照

脱敏盐是数据目录里的 `redaction.salt`（32 字节，0600），不写进数据库。库与盐是否配对记在 `collector_state['privacy:salt']`：`{format:1, id, confirmedLegacy}`，`id` 是 `sha256('atc-redaction-salt-v1\0' + salt)`，不含盐明文。有请求却没有绑定、绑定与盐不符或盐文件缺失，都拒绝启动，不生成新盐；换盐会让库里已写入的占位符再也解释不了。旧库有盐无绑定时只有显式确认才绑定，并如实记下 `confirmedLegacy`——确认只说明"从今往后用这一份盐"，不能证明历史占位符的血统。

可恢复快照是 bundle，不是裸数据库：`trace.db`、`redaction.salt` 与 `manifest.json` 三件，清单记 `{format:1, schema, salt_id, database_sha256}`。可接受的结构版本只有一份导出常量 `RESTORABLE_SCHEMA_VERSIONS`，备份与恢复都查它；恢复还要求包内数据库自身的 `user_version` 与清单相等。发布用同父目录的 0700 staging 加 `rename`，目标已存在就拒绝，不覆盖任何已有目录。认证令牌不随包走，恢复后按首次启动规则重新生成。

### 原始层

三张表，互不覆盖。`payload_json` 保留整行原文，应对 magpie 改字段：不用提前把所有字段解析成列，出现新字段时先从原始载荷补，再改表。

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
  via              TEXT NOT NULL,       -- through / hook / direct / rejected
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
  body_state       TEXT NOT NULL,       -- pending / available / partial / evicted / unsupported
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
  have             INTEGER NOT NULL,    -- 位：1 hook 2 账本 4 路由
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
  merge_state TEXT NOT NULL,           -- merged / pending / ambiguous
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
  ord    INTEGER NOT NULL,             -- messages 数组下标
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

### 不做规范哈希

哈希对象取完整脱敏消息的字节，不做规范哈希。剥掉 `cache_control` 后再哈希能让同一段内容在不同请求里落到同一个块，存储收益只有 2.3%，代价是块里存的字节不再是每笔请求的原字段，要恢复某笔的协议对象还得另存差异。另外它给增量计算引入了一个额外变量：比较上一笔与本笔是否同一条消息时，还要保证两边的剥离规则一致。按完整字节哈希之后，共同前缀比较就是直接的字节比较，前后一致性更容易验证。

### 骨架不带 summary

AVA 的骨架里，`request.summary` 与 `response.summary` 合计占骨架大小的 62.9%（400 条样本，13.1 MB 骨架里 8.3 MB 是摘要）。它是对正文的第二次结构化解析，内容与 `body` 重复。

去掉之后骨架原文从 82 MB 降到 42 MB，压缩后 9.5 KB/笔。摘要要用到的字段在摄入时直接算进 `request` 的列，骨架里不存第二份。

## 派生字段

界面依赖这几个字段。它们在摄入时算好，并在受影响的证据到达时局部重算。

### 标题

取该笔第一条新增 USER 消息的首行，去掉 harness 包装（`<system-reminder>`、`<command-*>`、工作目录说明这类），压空白，截到 60 字。

没有正文时回落到 `模型 · HH:MM`，`title_source` 记为 `model_time`。direct 行永远走回落，界面要能显示这个差别。

harness 的 Title Generator 是旁路请求：Claude Code 与 OMP 的输入/回复形状不同，但回复都可以解析成 `<title>` 或 `{"title":…}`。这类请求记 `req_kind='title'`，不进入祖先集合，不参与用户标题推导；解析出的正式标题存 `model_title`。会话标题优先取最新一次生成的正式标题，没有才退回用户首句。

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

"可比较"由持久化的消息数量判定：`body_state` 为 `available`/`partial`、骨架存在、`msg_count` 为非负整数，且块引用的数量、ordinal 连续性与指纹都符合。真实空消息数组是有效证据，整笔算新增并可以占主链根；没有骨架、缺消息引用或 `msg_count` 为 NULL 的行不可比较，记 `unknown` 并保留旧摘要。

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

harness 包装也在指纹前剥掉：`<session>` 保留内容、`<transcript>` / `<command-*>` / 技能注入提示整段丢弃。这类壳只影响标题与增量提取，不影响链。

### 折叠行摘要

列表接口不读正文块。派生时把两行摘要写进 `request`：`input_preview`（本笔新增的用户消息）与 `reply_preview`（回复首段）。`input_preview_kind` 说明摘要来源：

| kind | 含义 |
| --- | --- |
| `delta` | 本笔新增的用户消息 |
| `tail` | 没有新增，取末轮用户消息兜底 |
| `tool_result` | 本笔没有用户消息，输入是上一轮的工具结果 |

用中文文案做前缀匹配来判断来源不可靠，所以单独立列。

### 工具配对

从回复里取 `tool_use`（Anthropic）或 `tool_calls`（OpenAI）的 id，到后续同会话同 `actor` 的请求里按 id 找 `tool_result` / `role=tool`。配对是可变状态：

```sql
CREATE TABLE tool_call (
  call_id    TEXT NOT NULL,
  req_id     INTEGER NOT NULL,          -- 发出调用的那笔
  ord        INTEGER NOT NULL,
  tool_name  TEXT,
  result_req INTEGER,                   -- 结果所在请求，未到为 NULL
  result_ord INTEGER,
  state      TEXT NOT NULL,             -- pending / resolved / ambiguous
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
CREATE INDEX i_tool_call_id ON tool_call(call_id, req_id);
```

结果到达时更新 `result_req` / `result_ord` / `result_path`。同一 `call_id` 命中多个候选时标 `ambiguous`，不按时间或位置猜。只在同一 `actor` 内配对，跨子代理不串。标题请求是旁路，不进工具候选。

配对在派生的同一个事务里完成，排在链阶段之后、摘要之前：摘要里"这一轮回传了哪个工具的结果"只消费本次确定下来的关联（调用位置 + 结果 ord + 结果 path），不跨组按 `call_id` 取首行。本组正文仍可读的工具行每轮清空重建；正文已回收的行原样保留，既不参与重建，也不充当本次摘要的依据。

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

第一版实现 `anthropic` 与 `chat` 两个适配器，覆盖当前全部流量。`responses` 与 `gemini` 先保存、标记 `unsupported`，不显示成零消息。

映射表的形状（以已实现的两个为例）：

| 统一字段 | Anthropic | OpenAI Chat |
| --- | --- | --- |
| 角色 | `role` | `role`，工具结果用 `role: tool` |
| 文本 | `content[].type == text` | `content` 字符串或 `content[].type == text` |
| 工具调用 | `content[].type == tool_use`，id 在 `id` | `message.tool_calls[]`，id 在 `id` |
| 工具结果 | `content[].type == tool_result`，指向 `tool_use_id` | `role: tool`，指向 `tool_call_id` |
| 推理 | `content[].type == thinking` | `reasoning_content` |
| 系统提示 | 顶层 `system` | `messages[].role == system` |

未实现的两种记录在案，接入时补：Responses 用 `input` / `output` / `instructions`，工具通过 `function_call` / `function_call_output` 与 `call_id` 关联；Gemini 用 `contents[].parts` 与 `systemInstruction`。Responses 的前序响应引用不能解释为本笔包含全会话历史。

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

派生按 `(conv_key, actor)` 成组重算整条链，所以"这一组的产物是不是最新的"必须由持久状态回答，不能靠队列里还有没有这一行。

| 字段 | 含义 |
| --- | --- |
| `group_epoch` | 组的世代。组被删除后重建拿到新 epoch，旧完成记录因此不能复用到新组 |
| `input_revision` | 该组消费过的输入修订，只增不减；任何写入者发现输入变化就推进它 |
| `published_revision` / `published_algorithm` | 完成时实际消费的修订与算法；与当前修订相等且 `state='clean'` 才表示产物最新 |
| `state` | `dirty` 待派生，`clean` 已完成；待办查询一律 `state<>'clean'` |
| `dirty_since_ms` | 首次未完成触发时间。重复 dirty 保留最早值，clean 后清空 |

组内请求的 `input_epoch` / `input_revision` 是同一套修订的请求侧。输入指正文、回复、归属与来源证据：正文保存、hook 到达或合并、账本或路由的字段级事实变化、证据过期、正文回收都会推进它；只改费用不推进，因为费用不改变用途判定与派生结果。合并把两笔请求的证据并成一笔时，存活请求换新 `input_epoch`，旧 epoch 下的用途结论不再复用。

完成用比较交换而不是无条件写：drain 读到 `{group_epoch, input_revision, target_algorithm}` 后，全部阶段在同一事务里完成才把状态改成 clean 并记下这两个值；若同事务里后到的输入变化抬高了修订，交换失败即整批回滚，旧完成记录不会覆盖新输入。

#### 两个粒度：请求用途先于组结果

同一事务里先跑请求阶段、再跑组阶段，入口只有一个 `drainDeriveTx(db, {limit, scope?, purposeLimit?})`，在线调度、维护与迁移都走它。

请求阶段按 `req_id` 取 `purpose_pending=1` 的行，判完写 `purpose_status`（`recognized`/`unrecognized`/`retained`/`missing`）、`purpose_version`、`purpose_rule`、`purpose_chain`、`req_kind` 与 `model_title`，把 `purpose_pending` 清 0 并让 `purpose_revision` 追上当前 `input_revision`。正文不可读时：有旧 `purpose_version` 就保留原值并标 `retained`，从未判过则标 `missing`。该阶段不推进自己请求的输入修订——它消费输入，不改变输入；只在用途、链归属或正式标题真的变了时标所属组。

组阶段只消费已经定下来的 `purpose_chain`，不再自己识别一遍标题请求。组内仍有 `purpose_pending=1` 的成员时整组跳过、保持 dirty：把组算干净等于替那些请求猜了一个用途。`limit` 按组计，`purposeLimit` 是请求阶段的每批大小，drain 会连续推进到没有待判请求为止。

未知归属的请求也要完成用途：它不在任何组里，但"这一笔是标题生成"是它自己的事实，与它属于谁无关。

`DrainResult` 因此有两个排空条件：`remaining`（未完成组数）与 `purpose_remaining`（未判用途的请求数）。维护的排空循环要求两者都为 0，任一阶段无进展即报 `derive_no_progress`。

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

`miss_reason` 只记 collector 真能观测到的事实：

| 值 | 判定依据 |
| --- | --- |
| `hook_absent` | 账本已到，等满阈值仍没有任何 hook |
| `reply_unavailable` | hook 到了，但 `success = 0` 且 `response_z IS NULL` |
| `parse_failed` | hook 到了，`parse_state = invalid` |
| `unsupported_protocol` | hook 到了，`parse_state = unsupported` |
| `origin_not_local` | hook 到了，`origin` 不是 `local`，按配置不接收 |
| `evicted` | 曾经可用，已按预算回收 |

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
| `GET /api/sessions/:key/requests?limit=100&cursor=` | 会话内请求列表，只返回列字段 | keyset，(started_ms, req_id) |
| `GET /api/requests/:id` | 单笔读数、费用状态、正文状态 | 无 |
| `GET /api/requests/:id/body?from=0&to=40` | 分页取消息 | 消息序号区间 |
| `GET /api/requests/:id/route` | 路由决策与尝试链，来自 `route_summary` | 无 |
| `GET /api/stats` | 体积、覆盖位统计、健康状态、探针结果 | 无 |

列表接口不返回骨架。会话内 1,825 笔的列表，每笔骨架 9.5 KB，全取就是 17 MB，列表只返回 `req_id`、时间、状态、模型、四个读数、标题、`have`、`body_state`。

列表与详情都带 `derived_state`，并只在该值为 `current` 时把关系、增量与折叠行摘要放在顶层。详情另带 `historical`（旧派生结论连同状态）与摘要的算法三列；列表不携带这几项。判定的具体规则见[读模型里的派生状态](#读模型里的派生状态)。

分页用 keyset 不用 offset。摄入一直在写，offset 会漂移，游标是本页最后一行的 `(started_ms, req_id)`。

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
| Host 校验 | 只接受 `127.0.0.1:<port>` 与 `localhost:<port>`，其余 403 |
| 页面 API 来源 | 限同源；拒绝跨站与 `Origin: null`；无 Origin 的非浏览器访问走独立规则 |
| hook 认证 | 薄 hook 持本地随机令牌，写在 `plugins.json` 的 options 里，不暴露给前端 |
| `origin` 过滤 | 在认证之后执行，`origin=local` 只是来源标签，不是认证 |
| 渲染 | 正文与路由内容一律转义，不直接插 HTML |
| 账号字段 | `providerAccount`、`providerKeyId`、`host` 只在本地库，接口默认不返回 |
| 运行数据 | 库、日志都在用户目录，`.gitignore` 再加一层 |
| 不扫描 Agent 会话文件 | 只读 magpie 自己写的来源 |

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
