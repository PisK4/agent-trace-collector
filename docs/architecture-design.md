# 收敛型技术架构设计

第二版。第一版写于 2026-10-20，同日经过一轮独立评审（[architecture-review.md](architecture-review.md)），本文按评审结论重写。产品范围与字段语义仍以 [项目定位](project-overview.md) 和两篇 magpie 研究为准，本文不复述，只补它们没有回答的架构问题。

评审提出的问题全部采纳，其中三条是第一版的事实错误（`handed_on` 与 `kind` 混淆、费用来源取错、8 MiB 上限张冠李戴），另有两条修法比评审建议更进一步（去掉 spool、路由摘要进长期层）。改动集中列在文末。

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

这一节是设计依据。第一版的一部分数字在本轮换了度量口径后不成立，修正项集中列在文末，避免和本节打架。

### magpie 实际状态

| 项 | 值 |
| --- | --- |
| 运行版本 | 0.1.1296（`last-version` 与 `Info.plist` 一致） |
| 源码基准 | `repos-external/magpie` @ `2374ffe` |
| 网关监听 | `*:3425`（IPv6 通配），回环可达 |
| 账本文件 | `~/.config/magpie/usage.jsonl`，20,185 行，10.7 MB |
| 路由历史 | `~/.config/magpie/routing/`，当日 4,439 行，22 MB / 8 个日期文件 |
| 脱敏设置 | `settings.json` 未设置 `redact`，即关闭 |
| hook | AVA 的 hook 注册在 `plugins.json`，端点 `127.0.0.1:8319`，未设 `gatewayTimeoutMs`（取默认 1000 ms） |

### 流量与规模

| 指标 | 实测 |
| --- | --- |
| 今日 through 请求 | 4,288 行（20:48 快照） |
| 峰值 | 57 次/分钟（16:16），约 1 次/秒 |
| 最大会话 | 1,825 笔请求 |
| 单笔请求体 | 中位 346 KB，p90 1,091 KB，p99 2,162 KB，最大 3.9 MB |
| 超过 2 MB 的请求 | 98 / 3,504，2.80% |
| 单请求消息数 | 中位 42，p90 389，最大 665 |
| 今日 prompt token | 4.612 亿，单笔最大 245,588 |

### 协议分布

按账本 `ep` 的客户端侧计，今日 4,433 笔：

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
| 账本 `route_id` 出现多于一次 | 0 组（20,185 行全量） |

17 条不满足提示量等式的行里，16 条是 status 499 的客户端取消，1 条是 `usage` 与 `tries` 对不上的重试。

这些比例是某次样本的观察，不能单独当正确性判据。第一版把它们当成了验收标准，这次改成守恒关系：输入行数、唯一请求数、尝试行数、待关联数与缺失数之间必须对得上。

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

`cache_control` 影响的是哈希个数，不是字节量。42% 的块含这个字段，但标记本身很小，规范化的存储收益只有 2.3%。第一版据此决定做规范哈希，这次反过来：第一版不做（理由见存储模型一节）。

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

zstd 压缩级别有一个必须记住的坑。`zstdCompressSync(buf, { level: 9 })` 会被**静默忽略**，永远按默认级别 3 压缩，不报错。只有 `{ params: { [constants.ZSTD_c_compressionLevel]: 9 } }` 生效。实测 478 KB 样本，`level: 19` 与 `level: 3` 输出字节完全相同，`params` 写法才从 2,401 字节降到 1,504 字节。

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

**hook 看到的是脱敏前的正文。** `serveAgent` 先调 `gatewayHooks` 再调 `serve`，而 `serve` 内部才跑 `redacted`（`internal/gateway/middleware.go:26`、`internal/gateway/gateway.go:1564`）。当前 `redact` 未开启，hook 拿到的是原始凭证。

**账本文件不是按时间排序的。** 20,034 行里有 3,758 处相邻时间倒退，最大倒退 810 秒。不能用时间戳当读取游标。

**路由 id 不单调。** 当日 4,288 条里有 370 处相邻 id 递减。id 唯一，但不递增。

**账本文件里没有 direct 行。** 20,185 行全部是 through，`source` 这个键在文件里根本不存在。31,072 条 direct 记录只能从 `/v1/magpie/usage/requests?via=direct` 拿到。

**账本文件里也没有费用。** `cost` 与 `priced` 这两个键在 20,185 行里出现 0 次。文件直接序列化 `usage.Record`，其中可选的 `OwnCost` 只在客户端自报时才有值。按定价算出的 `cost` 和 `priced` 只存在于 API 返回的 `Row`。

**超过 32 MiB 的请求体不会触发 hook。** `gatewayBegin` 把请求体作为参数发给插件，并要求插件把 `body` 原样回显；插件写回宿主的单行受 `maxWireLine = 32 MiB` 约束（`internal/plugin/host.go:154`）。超线时 `gatewayBegin` 返回 `nil`，`gatewayHooks` 直接放行，整笔请求连 hook 都不跑，也不报错。今天最大请求 3.9 MB，离得很远。

**回复超过 8 MiB 会被主动置空。** `gatewayResponse` 里 `capture.full.cut()` 为真就 `run.Finish(ctx, nil, false, body)`，hook 收到 `reply = null` 与 `success = false`（`internal/gateway/gateway_hooks.go:22`）。这是「收到 null 回复」与「没收到 hook」必须分开的原因之一。

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

第一版设计了一个 JSONL spool，先落盘再异步入库。这次去掉。

理由是实测的提交延迟不需要它：3.82 MB 正文的一次事务提交中位 15.2 ms、最大 18.4 ms，hook 的单个预算默认 1 秒（`internal/plugin/host.js:1279-1280`，可调到 10 秒；总预算是各 hook 预算之和，夹在 2 到 10 秒）。余量在二十倍以上。

spool 唯一换来的是把 HTTP 确认和写库解耦，可它并不提升可用性：collector 挂掉时 hook 的 POST 一样失败。反过来，spool 要求定义一套完整的确认与重放协议——确认前是否已 fsync、偏移存在哪里、偏移与数据库提交的先后、半行怎么恢复、重放时 `request_block` 等副作用如何幂等——这套协议的成本远高于它解决的问题。

少一套日志，少一套崩溃恢复路径。写库直接 `synchronous=NORMAL` 写 WAL，提交成功即返回 200。

### 尺寸预算分四层

上游的几个长度常量各管一段，不能互相代入。

| 层 | 限制 | 来源 |
| --- | --- | --- |
| magpie 读取客户端请求 | `defaultBodyLimit = 512 MiB` | `internal/gateway/request_bounds.go:29` |
| 插件宿主单行 | `maxWireLine = 32 MiB`，超线整笔不跑 hook | `internal/plugin/host.go:154` |
| hook 捕获回复 | `conversationBodyMax = 8 MiB`，超线 `reply = null` | `internal/gateway/conversations.go:19` |
| collector 接收 envelope | 自定 | 本文 |

collector 自己定两个数，都按观测决定，不按上游常量推：

- **envelope 上限 64 MiB**。实测最大请求 3.9 MB，p99 2.16 MB，留一个数量级余量。
- **请求对象与回复对象各自 32 MiB 的上限**，独立校验。合法大 JSON 正常入库；非法或超限的 envelope 返回明确错误码，不静默截断后按完整对象处理。

第一版写的「按 8 MiB 收」是错的：`conversationBodyMax` 只作用于回复捕获，请求体作为 `json.RawMessage(body)` 直接进插件，不受它约束。按 8 MiB 收会让一个 6 MiB 请求加 3 MiB 回复的合法回调被整笔拒绝。

**截断只有一种合法形态。** 薄 hook 在正文超过 envelope 预算时，只发送带稳定 ID、原始大小与缺失原因的元数据，不发半截 JSON。收到半截 JSON 一律按解析失败处理，不当作正文。

### 为什么不用 magpie 自己的存储

路由历史 30 天滚动、200 MB 上限；账本按 magpie 的定义只覆盖它读得到的 Agent 会话文件；正文一条都不留。三者都是上游的临时产物，不能代替本项目的事实库。本项目只把它们当证据源。

## 证据身份与收敛

### 物理记录身份

第一版用 `r:<route_id>` 当账本行的主键，这是错的。源码里 `HandedOn` 的定义是「某次尝试失败但仍被计费的那一行」，它与最终成功的行共用同一个 `RouteID`（`internal/usage/usage.go:163-176`，写入点在 `internal/gateway/gateway.go:2953-2969`）。两行都写进 `r:<route_id>`，忽略冲突会丢掉失败的计费，覆盖会丢掉最终的成败。

原始账本按**物理记录身份**入库：

```text
(source_kind, file_generation, byte_offset)
```

- `source_kind`：`file` 表示 `usage.jsonl`，`api` 表示从 HTTP 接口拉到的 direct 行；
- `file_generation`：文件指纹（dev + inode + 首块哈希），文件被替换后自动变成新代际；
- `byte_offset`：该行在文件中的起始字节。

`route_id` 降为普通索引，不唯一。真唯一键是上面这个三元组。

本机现状值得说明：20,185 行里 `route_id` 重复组为 0，237 条多尝试路由在账本里各恰好一行。原因是 `handed_on` 行只在失败尝试真的产生了计费时才写（源码里 `if call.To != ""` 那个分支）。所以这个缺陷目前是潜伏的，按第一版的写法实现不会立刻出错，但表结构撑不住它一旦出现。

### 增量读取协议

两个来源都是 append-only 文件，但都不是简单的追加流：账本行乱序、路由跨午夜回写、历史日被整体换成 gzip。第一版没写这一层，等于把「读文件」当成了「读数组」。

游标只有一张表，与证据写在同一个事务里：

```sql
CREATE TABLE source_cursor (
  source_kind     TEXT NOT NULL,       -- ledger / route_file
  source_name     TEXT NOT NULL,       -- usage.jsonl / 2026-10-20.jsonl
  file_generation TEXT NOT NULL,       -- dev+inode+size+首块哈希
  committed_off   INTEGER NOT NULL,    -- 已提交的完整行末尾字节
  fingerprint     TEXT,                -- 压缩文件的整体摘要，重新识别用
  last_ok_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_name)
);
```

五条规则：

**证据与游标同事务。** 一批行入库、游标前移、`last_ok_ms` 更新在一个事务内提交。中途崩溃时游标回到上批末尾，重读的那几行靠物理记录身份去重，不产生重复。

**半行不前移游标。** 只读到换行符为止。末行没有换行就等下一轮，不猜、不补。盘上文件末尾本来就没有换行时，这个行为会一直等到该行写完，是正确的。

**代际变了就重新识别。** 每轮读取前重算 `file_generation`。与游标里记录的不一致，说明文件被替换、被截断或被别的进程改写，把该来源的 `committed_off` 归零、换上新代际再重读。已有的行按物理身份幂等跳过。仅凭 size 变小也可以判断截断，但 dev、inode 与首块哈希合在一起更能识别「删了重建」这种大小不变的情况。

**历史日整体重写是常态。** `pruneHistory` 会读整个 `.jsonl`、以 gzip 成员形式追加到 `.gz`、再临时文件替换整个 `.gz`（`internal/gateway/history.go:110-160`）。所以 `.gz` 的偏移没有意义，同一天可能在 `.jsonl` 与 `.gz` 里各存一份。做法是：`.gz` 按 `fingerprint` 识别，整体摘要没变就跳过；变了就全量解压重读，靠物理身份去重。`.jsonl` 与 `.gz` 都在时优先读 `.jsonl`，`.gz` 只补它没有的行。

**跨午夜的迟到路由。** 凌晨之后到达的路由可能写进前一天的 `.jsonl`。读取不按「今天」筛文件，而按每个文件自己的游标判断；一个已经被判为彻底归档的日期文件被重新创建时，按新代际重读。

账本与路由共用一个读取器，只差解析函数。实测日增 22 MB（路由）加 10.7 MB（账本），按当前节奏一轮读几 KB 到几百 KB，不构成压力。

### `handed_on` 与 `kind` 是两件事

第一版把两者混为一谈，写了「按 `kind` 非空过滤掉 handed_on」。这条同时错两处。

| 字段 | 含义 | 处理 |
| --- | --- | --- |
| `handed_on` | 某次尝试失败并转交后续候选，该行的用量仍计入 | 保留为尝试明细，不是独立请求，不增加顶层请求数 |
| `kind` | 调用用途，如 Codex 的 `review`、`compact`、`web_search` | 保留，记入分类 |

今天 8 条 `kind = web_search` 全是真实调用（`callKind` 从 `User-Agent: SearchAgent` 推出），按第一版的规则会被整批丢掉，而真正的 `handed_on` 一条都没滤掉。

一笔请求的最终结果取该 `route_id` 下**最后一条非 `handed_on` 的行**。费用分两个数：最终回复的用量，与整笔请求的尝试总量。两者分开存，不相加。

### 前缀规范化

实测需要统一的一组前缀：`chatcmpl-`、`msg_`、`resp_`、`msg_resp_`。只比较去前缀后的主体。今日 3,435 / 3,435 命中。

规范化规则放在一张按协议登记的表里，不写成单条 if。命中多个候选时保留原始候选并标记歧义，不按时间接近强行合并。规范化规则带版本号，写进每条关联结果。

### 会话键与子代理

会话键取 `session` 优先，缺失时用 `magpie-` 前缀加 `conv`（避免与客户端声明的 session 撞键），并把用的是哪个记在行上。

今日账本 4,288 笔里 3,856 笔有 session，剩 432 笔全部能经 `route_id` 从路由行取到 conv，合成率 100%。那 432 笔全是 `omp`（400 笔）、curl 探测和少量直连工具，走 `/v1/chat/completions`，客户端本来就不声明 session。

**同 session 不等于同一条消息历史。** 子代理沿用父会话的 `session`，另用 `subagent` 区分（`internal/usage/usage.go:153-159`、`internal/gateway/trace.go:73-83`）。本机 408 条子代理行里 407 条与父代理共享 session。

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
| 费用 `cost`、`priced` | 账本 API，按 `route_id` 补齐 | 文件里没有这两个键；API 的 `Row` 才算得出 |
| 正文、请求结构、回复 | hook | 账本没有正文 |
| `prompt` 分解、`tries`、`affinity`、`order`、`conv` | 路由 | 只有路由有 |
| agent、session、cwd | hook 优先，账本兜底 | 两处覆盖一致（3,435 对匹配里两边 session 都非空 3,405） |

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

三条规则：

**稳定排序不用 `req_id`。** `req_id` 是摄入时分配的，不能当逻辑顺序。排序键取 `(started_ms, source_kind, source_offset)`，同毫秒时用来源键定序。

**写入触发局部重算。** 插入、关联成功、补到正文、会话键变更，都重算当前请求及其后继链上已算过的派生值。链长按同会话上限截断，避免一次关联扫全库。

**工具配对是可变状态。** A 的回复里发出调用 x 时，携带结果的 B 尚未发生，只配一次会永久留空。配对写成「待配对调用」表，后续结果到达时更新归属，并按稳定顺序处理反向到达与重复投递。

每个派生结果记录算法版本与未知原因，便于整体重建。

## 存储模型

SQLite，WAL，单文件，放仓库外。默认路径 `~/Library/Application Support/agent-trace-collector/trace.db`，可用环境变量或配置改。

### 原始层

三张表，互不覆盖。`payload_json` 保留整行原文，应对 magpie 改字段：不用提前把所有字段解析成列，出现新字段时先从原始载荷补，再改表。

```sql
CREATE TABLE raw_ledger (
  source_kind      TEXT NOT NULL,      -- file / api
  file_generation  TEXT NOT NULL,      -- dev+inode+首块哈希；api 行用 (via, offset)
  byte_offset      INTEGER NOT NULL,
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
  parse_state      TEXT NOT NULL,      -- ok / truncated / unsupported / invalid
  miss_reason      TEXT,
  magpie_version   TEXT
);
```

`raw_hook` 的正文副本只在解析成功后短暂保留：块与骨架提交完成的同一事务里把它清空（置 NULL，保留行），作为可重放的重放层，按独立上限滚动。它不参与正文预算的重复计数。

### 路由摘要长期层

原始路由 7 天滚动，但 `/api/requests/:id/route` 需要长期可查。第一版没考虑这一点，清理原始层后历史路由就查不到了。

解法是另存一张摘要表，只保留展示需要的字段，去掉 `prompt`、`for`、`nested` 与 `order` 的完整结构：

```sql
CREATE TABLE route_summary (
  route_id    INTEGER PRIMARY KEY,
  time_ms     INTEGER NOT NULL,
  model TEXT, served TEXT, provider TEXT,
  status INTEGER, ms INTEGER, ttft INTEGER, flow INTEGER, first_text INTEGER,
  order_json  TEXT,      -- provider / model / who 三项
  tries_json  TEXT,      -- provider / model / status / ms / error / fail
  affinity_json TEXT,
  z           BLOB       -- 整行摘要的 zstd 副本，供重建
);
```

实测当日 4,453 条路由，摘要行原文 p50 从 4,401 字节降到 1,022 字节，zstd 后 0.46 KB/行。按每天 4,000 笔算 1.9 MB/天，10 GB 能放约 14.6 年。所以路由详情不需要宣布保留期，直接进长期层。

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
  -- 上下文
  prompt_tokens INTEGER, prompt_counted INTEGER,
  prompt_window INTEGER, prompt_turns INTEGER, parts_json TEXT,
  -- 正文
  body_state       TEXT NOT NULL,       -- pending / available / partial / evicted / unsupported
  body_evicted_at  INTEGER, body_evict_reason TEXT,
  skeleton_z       BLOB,
  body_bytes       INTEGER,
  msg_count        INTEGER,
  prev_req_id      INTEGER,
  prev_relation    TEXT,                -- confirmed / unknown / first
  delta_ordinals   TEXT,
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

`body_state` 与 `have` 分开是这版的关键修正。`have` 表示收到哪几路证据，回收不能把「收到过」改写成「没收到」；`body_state` 表示正文当前能否读取。第一版把两者混在一个位图里，导致回收后界面会显示成「回调未收到」，这是错的。

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
  z        BLOB NOT NULL,
  raw_size INTEGER NOT NULL
);

CREATE TABLE request_block (
  req_id INTEGER NOT NULL,
  ord    INTEGER NOT NULL,             -- messages 数组下标
  role   INTEGER NOT NULL,             -- 0 user / 1 assistant / 2 system / 3 tool
  block  INTEGER NOT NULL,             -- block.id
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;
```

**引用行为什么用整数代理键。** 第一版试过在引用行里存 32 字节全哈希，也试过存 8 字节前缀再回查 `block`。全哈希让每条引用多 24 字节，占总开销的 16%（43.6 KB 里约 7 KB）；前缀回查必须在 `block` 上做范围扫描，实测合并一笔请求从 3 ms 涨到 703 ms，差了 200 倍。整数代理键两头都不占：引用行 4 字节，回查是主键命中。

**不维护 `refs` 计数。** 第一版用一列引用计数判断孤儿。这次去掉：计数需要与引用删除在同一事务内递减，任何一次中断或迁移都会留下漂移，而对不上账时无法判断是计数错还是数据错。

孤儿改由候选集判定：回收某一天时，先取出该天所有引用指向的块 id，只对这个子集做反连接，没有引用的删掉。全库反连接实测 191 ms（11,187 块 / 971,635 引用），会随规模线性增长；候选集把 N 压到当天涉及的块数，量级完全不同，也不存在漂移。

### 不做规范哈希

第一版计划剥掉 `cache_control` 后做规范哈希，让同一段内容在不同请求里落到同一个块。这次不做，改为对完整脱敏消息的字节做哈希。

两个原因。存储收益只有 2.3%，但代价是块里存的字节不再是每笔请求的原字段，要恢复某笔的协议对象还得另存差异。更要紧的是它给增量计算引入了一个额外变量：比较「上一笔与本笔是否同一条消息」时还要考虑剥离口径是否一致。第一版按完整字节哈希之后，共同前缀比较就是直接的字节比较，前后一致性更容易验证。

脱敏规则本身需要版本：按字段路径区分凭证与用量，不用宽泛的 `token`、`key` 匹配，否则会破坏数字、工具 schema 与关联 ID。字符串里的 JSON 工具参数也要纳入脱敏验证，不能只遍历外层对象。

### 为什么去掉 summary

AVA 的骨架里，`request.summary` 与 `response.summary` 合计占骨架大小的 62.9%（400 条样本，13.1 MB 骨架里 8.3 MB 是摘要）。它是对正文的第二次结构化解析，内容与 `body` 重复。

去掉之后骨架原文从 82 MB 降到 42 MB，压缩后 9.5 KB/笔。摘要要用到的字段在摄入时直接算进 `request` 的列，不在骨架里存第二份。

## 派生字段

这几个字段是界面不塌的前提，在摄入时算好，并在受影响的证据到达时局部重算。

### 标题

取该笔第一条新增 USER 消息的首行，去掉 harness 包装（`<system-reminder>`、`<command-*>`、工作目录说明这类），压空白，截到 60 字。

没有正文时回落到 `模型 · HH:MM`，`title_source` 记为 `model_time`。direct 行永远走回落，界面要能显示这个差别。

### 新增消息

按块序列比较，不按集合比较。

```text
上一笔 = [user:A, assistant:B]
本笔   = [user:A, assistant:B, user:A]
集合差 → []          （错）
序列比较 → [2]        （对）
```

实测 600 条真实请求里 55 条含完全相同的重复消息，最多一条消息在一笔里出现 14 次。集合差在这些请求上会把用户真正新增的那条吞掉，同时影响对话视图与标题。

算法：比较两笔的 `block` 序列共同前缀。上一笔的序列是完整前缀时，取本笔的后缀作为新增，`prev_relation = confirmed`；不是前缀（压缩、裁剪、分支、前序响应引用）时，`prev_relation = unknown`，不算增量。首笔用 `first`，与 `unknown` 分开。

比较成本实测 0.17 ms（167 条消息）。

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

结果到达时更新 `result_req` / `result_ord`。同一 `call_id` 命中多个候选时标 `ambiguous`，不按时间或位置猜。只在同一 `actor` 内配对，跨子代理不串。

### 协议适配

hook 保留客户端协议形状。源码里四种 `Protocol` 都存在（`internal/provider/provider.go:35-41`）：`chat`、`responses`、`anthropic`、`gemini`。

保存能力与解析能力分开记状态：

| `parse_state` | 含义 | 界面 |
| --- | --- | --- |
| `ok` | 已按适配器解析 | 正常渲染 |
| `unsupported` | 原对象已保存，暂无适配器 | 显示原始 JSON，标「暂不支持解析」 |
| `truncated` | 正文被截断 | 显示已截断与原字节数 |
| `invalid` | 解析失败 | 显示失败原因 |

第一版实现 `anthropic` 与 `chat` 两个适配器，覆盖今天全部流量。`responses` 与 `gemini` 先保存、标记 `unsupported`，不显示成「零消息」。

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

`request.derive_version` 记录产生当前派生值的算法版本。算法改动后按会话或按天批量重算，`/api/stats` 显示还有多少行低于当前版本。整体重建入口：从 `request_evidence` 找到原始记录，按当前算法重跑，写回同一 `req_id`。

## 缺失与健康

### 证据缺失

`have` 位图区分缺在哪一路。界面按位显示，不合并成一个笼统的缺失。

| 现象 | 判定 | 界面处理 |
| --- | --- | --- |
| 有账本、无 hook | `have & 1 == 0` | 显示身份与读数，正文区写具体原因 |
| 有 hook、无账本 | `have & 2 == 0` 且超过阈值 | 标待关联，保留候选，不按时间强行匹配 |
| 无路由 | `have & 4 == 0` | 路由段显示当前来源不提供 |
| 收到 null 回复 | `raw_hook.success = 0` 且 `response_z IS NULL` | 显示上游未给出回复，与「没收到 hook」分开 |

### 正文缺失

`body_state` 独立于 `have`：

| 状态 | 含义 |
| --- | --- |
| `pending` | 账本已到，正文预期会到，尚未到 |
| `available` | 正文完整可读 |
| `partial` | 正文存在但被截断 |
| `evicted` | 正文已按预算回收 |
| `unsupported` | 已保存原对象，暂无适配器解析 |

`miss_reason` 进一步区分成因：`hook_absent`、`envelope_too_large`、`line_over_32miB`、`reply_over_8MiB`、`parse_failed`、`origin_not_local`、`evicted`。

### 健康状态

缺失与健康是两回事：缺正文可能是上游没提供，也可能是 collector 还没追上。`/api/stats` 记录：

| 指标 | 含义 |
| --- | --- |
| 各路已处理位置 | 账本偏移、路由文件代际与偏移、最后成功时间 |
| 解析失败计数 | 按来源与原因分桶 |
| 待关联数与最老待关联年龄 | 判断 hook 与账本的对账是否卡住 |
| 磁盘 | 库、WAL、临时文件的字节，正文预算占用 |
| 版本探针结果 | 当前 magpie 版本是否在已验证区间 |

新进程刚启动、回放尚未追平的时候，不要立即报告某一路永久缺失，而是标「追赶中」。

### 三条硬规则

**缺失等于键不存在。** 账本文件里 `cache_write`、`credits` 在多数行根本不存在，API 把它们补成 0。所以 token 与字段存在性以文件为权威，`cost` 与 `priced` 以 API 为权威，两者分开记来源。

**时间统一转 epoch 毫秒再比较。** 原始串保留在 `t_text` 里，因为 through 行带本地时区偏移、direct 行是 `Z`，字符串比较在排序、去重、按天分组三处都会错。

**截断要单独记账。** 不能把截断的正文当完整正文解析，也不能把截断当成缺失。AVA 那 98 条就是教训：记录在，骨架不是合法 JSON，解析静默失败，看起来像「这笔没有正文」。

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

五条约束：

**列表接口不返回骨架。** 会话内 1,825 笔的列表，每笔骨架 9.5 KB，全取就是 17 MB。列表只返回 `req_id`、时间、状态、模型、四个读数、标题、`have`、`body_state`。

**分页用 keyset，不用 offset。** 摄入一直在写，offset 会漂移。游标是本页最后一行的 `(started_ms, req_id)`。

**正文按消息序号区间取。** 一次取 40 条，块解码在单次请求内复用缓存。实测取 40 条 0.13 ms，最重的一笔 526 块全取 13.7 ms。正文已回收时返回 `evicted` 与回收原因，不返回空。

**过期状态要能被调用方区分。** 原始路由过期但摘要还在时，路由接口照常返回；摘要也没有时返回明确的过期标记，不返回空对象。

**不做服务端全文搜索。** FTS5 可用，但正文在块里，建索引要把每块都解压一遍，写入与存储成本都不小。第一版的会话导航不需要它。

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

第一版只定义了一个 10 GB，实际有两笔账要算。

**正文预算（默认 10 GB，可配置）**：计入 `block.z`、`skeleton_z`、`raw_hook` 里未清空的正文副本。这是回收的对象。

**总磁盘上限（默认 16 GB）**：计入数据库文件、WAL、临时文件与库外产物。达到上限时停止接收正文（只记元数据），并告警。

按 43.6 KB 一笔：

| 日请求量 | 日增长 | 10 GB 可保留 |
| --- | --- | --- |
| 4,000（当前） | 约 178 MB | 约 56 天 |
| 12,000（3 倍） | 约 534 MB | 约 19 天 |
| 40,000（10 倍） | 约 1.78 GB | 约 5.6 天 |

10 GB 是一个正文预算，而正文体积由 Agent 实际读了多少文本决定。压缩和去重只能削减重复部分，不能削减新增部分。3.45 倍的压缩比已经用掉了 zstd 级别 3 的收益，再往上调只换来个位数百分点。

三个可调杠杆，按代价从低到高：

1. **分级保留。** 元数据（`request` 行与 `route_summary`）保留全部历史，正文（`block.z`、`skeleton_z`）按预算滚动。
2. **超大块降级。** 超过 256 KB 的单个块只存哈希、前 4 KB 预览和原始大小。实测块最大 602 KB，这类通常是整文件读取。
3. **训练 zstd 字典。** 对块内容训练一个 64 KB 的字典，小块压缩比能改善。代价是多一套训练与版本管理流程。

第一版只做分级保留，另两个留接口不做。

### 回收

第一版的回收第 4 步删除 `request` 行，与「元数据保留全部历史」自相矛盾：超过正文预算后，历史请求的读数、会话导航与标题会一起消失，第 3 步的验收条件也无从满足。合成验证确认，执行该删除后请求行数为 0。

改后的回收只动正文：

```text
1. 选出最旧一天 body_state = 'available' 的 req_id 集合
2. 事务内删除这些 req_id 的 request_block 行
3. 对第 2 步涉及的块 id 集合做反连接，删除无引用的 block 行
4. 同一事务内：置 skeleton_z = NULL，body_state = 'evicted'，
   body_evicted_at = now，body_evict_reason = 'budget'
5. 超过保留期的 raw_ledger / raw_route / raw_hook 按天删除
6. PRAGMA incremental_vacuum，随后 PRAGMA wal_checkpoint(TRUNCATE)
```

`request` 行、`route_summary`、`request_evidence` 都不删。

**回收中断要能被检出。** 第 2 步与第 4 步在同一事务内，中断则整体回滚。引用删除、孤儿清理与正文标记三者不可分离。

**物理收缩。** SQLite 默认 `auto_vacuum = 0`，删数据后页进入空闲列表可复用，文件不缩。本次复现：删约 6.7 MB 数据后页数维持 522、空闲 520，文件 6.7 MB 不变。

`auto_vacuum = INCREMENTAL` 必须在建表前设置并验证；已有库需要单独迁移（`VACUUM` 一次）。设置之后，删除数据、`incremental_vacuum`、`wal_checkpoint(TRUNCATE)` 三步缺一不可：只做前两步文件仍是 6.7 MB，三步都做才归到 0.0 MB。

**回收不在凌晨等。** 磁盘接近上限时就触发，按批次限量执行，单批事务不阻塞写入。写入低峰（实测 16:00 前后是高峰，凌晨是低谷）只是调度上的偏好，不是前提。

## 版本与形状漂移

**版本探测。** 读 `~/.config/magpie/last-version`，再调 `GET /v1` 取 `version`，两者不一致时以 HTTP 为准并记录。已验证区间初始定为 `>=0.1.1294 <0.2.0`。超区间仍启动，但每条记录写 `magpie_version`，界面对超区间采集的数据标未验证。单点锁已经失效：评审当天本机从 0.1.1294 升到了 0.1.1296。

**形状探测持续做，不只在启动时做一次。** 每批新记录抽取样本检查必含字段：

| 源 | 必含字段 |
| --- | --- |
| 账本 | `t`、`agent`、`model`、`in`、`out`、`status` |
| 路由 | `id`、`time`、`agent`、`model`、`tries`、`prompt`、`order` |
| hook | `protocol`、`path`、`agent`、`request` |

缺字段分两种处理。整批都缺、且与版本变化同时发生，判为形状漂移，进入降级模式并标记新采集的数据。个别记录缺某个可选字段，按该字段合法缺失处理，不触发降级。本地升级与按类型缺字段不能混为一谈。

未知字段不丢弃，进 `payload_json`。字段名映射集中在一个模块里，magpie 改名时只改那处。

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

三条实现约束：

**占位符保持稳定。** 同类同值映射到同一个占位符，正文仍可读，去重不会因为脱敏变得零碎。

**脱敏在分块之前做。** 块哈希基于脱敏后的内容，同一份内容不会因为一次带凭证一次不带而存两份。

**字符串里的 JSON 也要检查。** 工具参数常以字符串形式携带 JSON，只遍历外层对象会漏掉。脱敏规则带版本号，验证集覆盖凭证、数字、工具 schema 与关联 ID 四类，确保规则没有误伤。

## AVA 下线

顺序不能颠倒，否则切换窗口里会丢正文。

```text
1. collector 的 hook 上线，与 AVA 并行，各自收一份
2. 观察 collector 侧覆盖率，按同一时间窗、相同筛选比对
3. 停 AVA 服务，从 plugins.json 摘掉 AVA hook
4. 撤 AVA 的常驻进程与开机启动
5. 保留 AVA 库只读，不导入数据，不写入
```

第 2 步的比对口径：同一时间窗、相同筛选范围下，按原始与规范化两种 `response_id` 集合分别比对条数。AVA 侧今日 3,480 条有可用正文、98 条被自己的 2 MB 上限截断，collector 侧应当多出这 98 条。但 98 是历史快照，不能当成未来并行窗口必须多出的固定数量，只能作为量级参照。

下线前还要求两件事：回收与恢复能力已完成并通过恢复测试，以及有明确的回滚方式。预算触顶、磁盘满与停机行为也要进下线判据。

并行期的预算：两个 hook 串行，总预算按各自 `gatewayTimeoutMs` 相加，夹在 2 到 10 秒之间。AVA 没设这个值，取默认 1 秒。collector 若设 2 秒，合计 3 秒，在限额内。并行期间不需要改 AVA 的配置，但要确认 collector 不超过 2000。

已知的两次缺口要分清性质：

- 19:02 到 19:41 之间 AVA 有 39 分钟几乎无记录，同期账本也只有 1 行。那段时间本机确实没有请求，不是 hook 掉线。
- 20:07 到 20:19 的 12 分钟空档同理，账本只有 4 行。
- 18:08 到 18:33 那 83 笔缺失是另一回事：账本有 172 笔，AVA 有 90 笔，缺的 83 笔全部来自同一会话、同一模型，prompt token 在 18 万以上。这指向超大请求的回调丢失，上线后按 `miss_reason` 分桶统计，不再靠猜。

## 落地顺序

在原四步之前加一个持久化验证阶段。

**阶段 0：持久化验证。** 不接真实流量，用合成库验证四件事：账本物理记录身份能容纳同 `route_id` 的多行；事务中断后重启不丢不重；路由文件跨午夜、`.jsonl` 与 `.gz` 并存、`.gz` 被替换三种情形下证据集合一致；`auto_vacuum` 与磁盘策略按预期收缩。

**第 1 步：只读账本与路由，出一个真实数据页面。**

- 范围：`raw_ledger`、`raw_route`、`route_summary`、`request`（无正文）、`/api/sessions`、`/api/sessions/:key/requests`、`/api/requests/:id`；
- 前端把 `TIMELINE` 换成一次 `fetch`，界面不动；
- 判据：尝试不增加顶层请求数、最终状态取最后一条非 `handed_on` 行；回放中断后不丢不重；费用状态有来源；Host 与 Origin 校验生效；1,825 笔会话分页在 100 ms 内返回。

这一步结束时，界面上正文全空、只有读数与路由，这是预期状态。

**第 2 步：接 hook，落正文，写派生字段。**

- 范围：hook 端点与认证、脱敏、分块、内容库、标题、增量、工具配对、协议适配（anthropic 与 chat）、`pending_hook`；
- AVA 并行运行；
- 判据：大 envelope、不支持协议、重复消息、父子代理、迟到正文与工具结果各自有合成验收；脱敏在所有落盘之前完成；最重的一笔正文合并不超过 50 ms（实测 13.7 ms）。

**第 3 步：停 AVA，做回收与保留。**

- 范围：正文预算、总磁盘上限、分级保留、孤儿清理、`/api/stats`；
- 判据：强制回收最旧一天后，历史请求仍可分页查询，读数与会话请求数不变，正文返回 `evicted` 与原因；灌入可重复正文、唯一正文与 `raw_hook` 副本，持续观测库、WAL 与临时文件的实际字节，预算触顶后停止增长；回收中断后无悬空引用、无误删共享块；恢复测试通过后才进入 AVA 下线。

**第 4 步：direct 回填（可选）。**

- 范围：走 `/v1/magpie/usage/requests?via=direct` 分页拉取，`limit=500` 一页，31,072 行约 63 次请求；
- 判据：单独确定稳定身份。相同 `(t, session, agent, model, in, out)` 只视为候选重复，未经证明不合并两条合法调用；会话键与 through 不混。

## 未决问题

1. **超大请求的 hook 回调为什么会丢。** 缺失集中在 18 万 token 以上，占该量级 17.5%。同会话并发中位数与命中组相同，AVA 同时段摄入耗时也正常。上线后按 `ep`、`status`、正文大小、`ms` 与 `miss_reason` 分桶统计。32 MiB 单行上限与回复 8 MiB 上限是两个已知的确定性成因，但都解释不了今天的量级。
2. **direct 是否还会新增。** 31,072 条全部落在 2026-08-20 到 2026-10-13，之后到 10-20 只有 1 条。判断它是 magpie 对会话文件的首次索引回填。如果 magpie 重启或会话文件变动时会重新扫描，需要再测。
3. **分级保留的切分点。** 正文按天滚动、元数据全留是当前建议。多大预算下开始丢正文、丢哪些会话，需要先定一个偏好，比如「最近 30 天全留，更早只留读数」。
4. **是否保留推理正文。** 路由里有 `reasoningHidden` 标记，账本有 `reasoning` token 数，推理正文只在 hook 的回复里。是否入库、入哪一层会影响正文体积。
5. **`route_summary` 是否要保留 `prompt` 分解。** 现在 `prompt_tokens` 与 `parts_json` 存在 `request` 行上，够用。如果以后要按工具名统计历史用量，需要在摘要层补一份。
6. **多实例。** 当前设计是单进程单库。`route_id` 是进程内时钟计数，跨机可能撞。现在不加实例标识，但要预留一列。

## 两轮修正的记录

第一版相对评审早期推翻的结论：

| 旧结论 | 实测修正 |
| --- | --- |
| 去重后内容占 5.8% | 11.3%。块级 1,261.6 MB 引用降到 142.7 MB；规范哈希 11.0% |
| hook 覆盖率 97.3% | 可用正文 94.98%，另有 2.67% 被 AVA 的 2 MB 上限截断 |
| 单笔约 34 KB，10 GB 可留 75 天 | 43.6 KB，56 天 |
| zstd 级别 3 得 3.72 倍、级别 9 得 4.06 倍 | 3.45 倍与 3.75 倍；早期用 `{ level }` 参数，被 Bun 静默忽略 |
| direct 行在账本文件里 | 文件里一条都没有，只有 API 拿得到 |
| 账本 19,799 行、今日 3,957 笔 | 20,185 行、今日 4,288 笔 |

第二版相对第一版推翻的结论：

| 旧结论 | 修正 |
| --- | --- |
| 账本主键 `r:<route_id>` | 改为物理记录身份 `(source_kind, file_generation, byte_offset)`；`route_id` 降为普通索引 |
| `kind` 非空即 handed_on | 两者是不同的字段。`handed_on` 是计费失败行，`kind` 是调用用途，8 条真实 `web_search` 会被误删 |
| 费用取账本文件 | 文件里没有 `cost` 与 `priced`，只能从 API 按 `route_id` 补 |
| 回收第 4 步删除 `request` 行 | 与「元数据全留」矛盾，改为只清正文并标 `evicted` |
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
