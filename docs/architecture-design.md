# 收敛型技术架构设计

评审日期 2026-10-20。本文把前一阶段的只读评审收敛成一份可施工的架构：技术栈、进程边界、存储模型、接口形状和分阶段落地顺序。产品范围与字段语义仍以 [项目定位](project-overview.md) 和两篇 magpie 研究为准，本文不复述，只补它们没有回答的架构问题。

文中数字是 2026-10-20 20:48 在本机的实测快照。账本与路由随使用增长，引用时必须带时间。

## 这份文档定什么

评审阶段确认了五件事，本文按它们展开：

1. 技术栈用 TypeScript + Bun。
2. AVA 停用，后续以本项目作为 Agent trace 的唯一跟踪入口。
3. 版本锁从单点改为区间加形状探针。
4. 正文存储按滚动 10 GB 预算回收，上限可配置。
5. direct 行第一版可不做。

设计目标是承载本机后续全部大模型调用的记录流量，功能点以原型已覆盖的为准，不扩范围。

## 事实基线

这一节是设计依据。评审早期的一些数字在这一轮换了更细的度量口径后不成立，修正项集中列在文末，避免和本节打架。

### magpie 实际状态

| 项 | 值 |
| --- | --- |
| 运行版本 | 0.1.1296（`last-version` 与 `Info.plist` 一致） |
| 源码基准 | `repos-external/magpie` @ `2374ffe` |
| 网关监听 | `*:3425`（IPv6 通配），回环可达 |
| 账本文件 | `~/.config/magpie/usage.jsonl`，20,034 行，10.6 MB |
| 路由历史 | `~/.config/magpie/routing/`，当日 4,288 行，22 MB / 8 个日期文件 |
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

线上真实的请求体比评审早期的估计大：p99 已过 2 MB，最大 3.9 MB。这个数字直接否掉了「按 2 MB 截断」的做法。

### 三通道连接质量

| 检查 | 结果 |
| --- | --- |
| `route_id` 账本到路由 | 4,288 / 4,288 |
| `ms` 两侧相等 | 4,288 / 4,288 |
| `prompt.tokens = in + cache_read + cache_write` | 4,271 / 4,288，99.60% |
| `sum(parts[].tokens) = prompt.tokens` | 4,287 / 4,287 |
| hook `response_id` 规范化后到账本 | 3,435 / 3,435 |
| 会话键可合成（ledger session 或 route conv） | 4,288 / 4,288 |

17 条不满足提示量等式的行里，16 条是 status 499 的客户端取消（没有 usage 记入），1 条是 `usage` 与 `tries` 对不上的重试。

### 正文覆盖率

以 13:00 之后的账本行为分母（3,664 笔带 `response_id`），按 AVA 库实测：

| 状态 | 笔数 | 占比 |
| --- | --- | --- |
| 有可用正文 | 3,480 | 94.98% |
| 记录存在但正文被截断 | 98 | 2.67% |
| 完全没有回调 | 86 | 2.35% |

截断的那 98 笔不是 magpie 造成的。AVA 自己的 `max_capture_bytes` 默认 200 万字节（`config.py:71`，`hook_ingest.py:130`），原始正文中位 2.17 MB、最大 4.0 MB，被切在 2 MB 处，骨架因此不是合法 JSON，正文一条都读不出来。这是本项目不能照抄的设置。

完全没有回调的 86 笔集中在超大请求：prompt token 在 19 万以上的 423 笔里有 74 笔没有回调，占 17.5%；19 万以下的 3,241 笔里只有 12 笔，占 0.37%。截断同样集中在这个量级：423 笔里 59 笔被切。对照同会话的命中与缺失可以排除并发因素（并发中位数两边都是 1），也排除了 AVA 误判（同时段的 AVA 摄入耗时中位 25 ms，与其他时段相同）。

### 内容复用

最大那段会话（1,618 笔可解析请求）实测：

- 块引用 241,214 次，对应 4,887 个不同哈希；
- 引用字节 1,261.6 MB，块级去重后 142.7 MB，11.3%；
- 剥掉 `cache_control` 再做规范哈希，不同块降到 3,474 个，字节 139.4 MB，11.0%。

`cache_control` 影响的是哈希个数，不是字节量。42% 的块含这个字段，但它的标记本身很小，规范化的收益是让同一段内容在不同请求里落到同一个哈希，存储上只省 2.3%。要做，但别指望它省空间。

这 1,618 笔摊下来，每笔正文的边际新增内容约 88 KB 原文，按 zstd 实测 3.45 倍压缩后约 26 KB。

### Bun 运行时能力

本机 Bun 1.4.0 实测：

| 能力 | 结果 |
| --- | --- |
| `zlib.zstdCompressSync` / `zstdDecompressSync` | 可用 |
| `bun:sqlite` WAL | 可用，第二个连接能在写事务期间读 |
| FTS5 | 可用 |
| STRICT 表、WITHOUT ROWID | 可用 |

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

表体积：`block` 89.6 MB，`request` 32.8 MB（其中骨架压缩后约 9.5 KB/笔），`request_block` 15.8 MB，块引用索引 13.6 MB，其余不到 1 MB。

写路径余量在三个数量级以上。读路径单笔最重 14 ms，一页一百笔列表 0.2 ms，也够。

### 四个必须写进设计的陷阱

**hook 看到的是脱敏前的正文。** `serveAgent` 先调 `gatewayHooks` 再调 `serve`，而 `serve` 内部才跑 `redacted`（`internal/gateway/middleware.go:26`、`internal/gateway/gateway.go:1564`）。当前 `redact` 未开启，hook 拿到的是原始凭证。

**账本文件不是按时间排序的。** 20,034 行里有 3,758 处相邻时间倒退，最大倒退 810 秒。不能用时间戳当读取游标。

**路由 id 不单调。** 当日 4,288 条里有 370 处相邻 id 递减。id 唯一，但不递增。

**账本文件里没有 direct 行。** 文件 20,034 行全部是 through，`source` 这个键在文件里根本不存在。31,072 条 direct 记录只能从 `/v1/magpie/usage/requests?via=direct` 拿到。评审早期以为 direct 也在文件里，这是错的。

### 账号身份与 LAN

`/v1/magpie/usage/requests` 会带出 `providerAccount`（常见是手机号或邮箱）、`providerKeyId`、`host`。本机 `lan` 为 true，网关在 `*:3425` 上监听，局域网可达（需要网关 key）。这些字段只应留在本机，不进仓库、不上报。hook 侧已有 `origin` 判定（`local` / `remote` / `gateway-key`），collector 默认只收 `local`。

## 已定决策与由此产生的约束

| 决策 | 直接后果 |
| --- | --- |
| TypeScript + Bun | 单进程、单语言；hook 与后端共用类型和脱敏实现；`bun:sqlite` 与 `node:zlib` 原生可用，不引第三方依赖 |
| AVA 停用 | 需要先做正文并轨：新 hook 上线后 AVA 停用，切换窗口内的请求只有账本与路由 |
| 版本锁改为区间 | 启动时探测，超区间仍启动但降级，每条记录带采集版本 |
| 滚动 10 GB | 需要明确的回收单位、块引用计数和孤儿清理；正文与元数据分开回收 |
| direct 第一版不做 | 账本摄入只处理 through 与 rejected；direct 走同一个表结构但开关默认关闭 |

## 系统边界与进程模型

一个常驻进程，两个 HTTP 面，共用一个端口，只绑 `127.0.0.1`。

```text
magpie gateway
  ├─ hook POST ─────────────> /hook/ingest      写入后立即 200
  ├─ 账本文件（只读）───────> ledger tailer
  ├─ 路由文件（只读）───────> route tailer
  └─ 用量接口（只读）───────> direct 回填（可选，默认关）
                                    │
                              reconciler（合并成 request 行）
                                    │
                              SQLite（WAL）
                                    │
浏览器 ─────────────────────────> /api/*          查询与页面
```

进程内分四个职责，跑在同一个 Bun 事件循环里：

| 职责 | 触发方式 | 作用 |
| --- | --- | --- |
| ingest | HTTP 请求 | 收 hook 载荷，落 spool，立即返回 |
| tailer | 定时（账本 5 秒，路由 2 秒） | 按字节偏移增量读两个文件 |
| reconciler | 定时（1 秒）加 ingest 完成事件 | 把各路证据合成一条 request |
| query | HTTP 请求 | 只读查询 |

写操作全部走一个 writer，避免 SQLite 的 `database is locked`。实测第二个连接在写事务期间写会被拒绝，读不受影响。查询用独立只读连接。

### 为什么 hook 先落 spool 再入库

magpie 给单个 hook 的默认预算是 1 秒，可调到 10 秒；总预算是各 hook 预算之和，夹在 2 到 10 秒之间（`internal/plugin/host.js:1279-1280`）。回调在 goroutine 里异步发，客户端不会被拖住，但超过预算的通知会被丢弃。

落 spool 是追加写；直接写 SQLite 需要压缩正文（3.9 MB 在 660 MB/s 下约 6 ms）加事务提交。正常情况下也够，但回收任务正在跑时可能被锁住。先落 spool 把这两件事解耦，spool 文件本身也是崩溃恢复的凭据。

spool 用 JSONL：hook 送来的载荷由 `JSON.stringify` 生成，不含裸换行，一行一条。每行带接收时间和 magpie 版本。worker 消费成功后在文件里记一个消费偏移，进程重启从偏移继续。

**hook 侧不要设 2 MB 上限。** AVA 的 2 MB 截断吃掉了 2.75% 的正文，全是最大的那些请求。magpie 给 hook 的请求体上限是 `conversationBodyMax = 8 MiB`（`internal/gateway/conversations.go:19`），实测最大请求 3.9 MB，远在限额内。collector 按 8 MiB 收，超了再标记截断，并在界面上写明。

### 为什么不用 magpie 自己的存储

路由历史 30 天滚动、200 MB 上限；账本按 magpie 的定义只覆盖它读得到的 Agent 会话文件；正文一条都不留。三者都是上游的临时产物，不能代替本项目的事实库。本项目只把它们当证据源。

## 各路证据怎样收敛

### 身份

一个请求在库里有一个内部主键 `req_id`，外部键单独索引。这样各路的键形态不会污染读模型。

| 来源 | 外部键 | 说明 |
| --- | --- | --- |
| through | `route_id` | 整数，全局唯一，账本与路由两侧都有 |
| hook | `response_id` | 需要前缀规范化后才能对上账本 |
| rejected | 无 | 只有账本行，`route_id`、`response_id`、`session` 都为空。账本全量 5 笔，今日 0 笔 |
| direct（暂不启用） | 复合键 | 无 `route_id`；31,072 行里 170 组复合键重复，不能当唯一键 |
| handed_on | `route_id` | 账本里有（今日 8 笔），但它是 magpie 内部调用，不能算顶层请求 |

handed_on 行在账本里有 `kind` 与 `for` 字段，路由侧同样有。摄入时按 `kind` 非空过滤掉，否则每次 web_search 都会多出一笔假请求，费用也会重复计。

正文回调单独到达、暂未对上账本时，先用 hook 自己的 id 建一条待关联记录；对上之后合并，不留重复行。

### 前缀规范化

实测需要统一的一组前缀：`chatcmpl-`、`msg_`、`resp_`、`msg_resp_`。只比较去前缀后的主体。今日 3,435 / 3,435 命中。

规范化规则放在一张按协议登记的表里，不写成单条 if。命中多个候选时保留原始候选并标记歧义，不按时间接近强行合并。

### 会话键

会话键取 `session` 优先，缺失时用 `magpie-` 前缀加 `conv`，并把用的是哪个记在行上。

今日账本 4,288 笔里 3,856 笔有 session，剩 432 笔全部能经 `route_id` 从路由行取到 conv，合成率 100%。那 432 笔全是 `omp` 这个 Agent（400 笔）、curl 探测和少量其他直连工具，走的是 `/v1/chat/completions`，客户端本来就不声明 session。所以账本摄入必须等路由到位才能定会话键，或者先落一个可空的键，reconciler 再补。

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
| 状态、用量、费用、`response_id`、`provider` | 账本 | 网关记账的结果，hook 的 `success` 只是布尔 |
| 正文、请求结构、回复 | hook | 账本没有正文 |
| `prompt` 分解、`tries`、`affinity`、`order`、`conv` | 路由 | 只有路由有 |
| agent、session、cwd | hook 优先，账本兜底 | 两处覆盖一致（3,435 对匹配里两边 session 都非空 3,405） |

## 存储模型

SQLite，WAL，单文件，放仓库外。默认路径 `~/Library/Application Support/agent-trace-collector/trace.db`，可用环境变量或配置改。

### 原始层：三张表，互不覆盖

```sql
CREATE TABLE raw_ledger (
  row_key          TEXT PRIMARY KEY,   -- 'r:<route_id>' / 'x:<哈希>'
  route_id         INTEGER,
  t_text           TEXT NOT NULL,      -- 原始时间串，保留时区写法
  t_ms             INTEGER NOT NULL,   -- 解析后的 epoch 毫秒，所有比较用它
  source           TEXT NOT NULL,      -- through / direct / rejected
  agent            TEXT, provider TEXT, host TEXT, account TEXT,
  model            TEXT, requested TEXT, served TEXT,
  in_tok           INTEGER, out_tok INTEGER,
  cache_read       INTEGER, cache_write INTEGER,
  reasoning        INTEGER, effort TEXT,
  ms               INTEGER, status INTEGER, stop TEXT,
  response_id      TEXT, response_id_norm TEXT, rid TEXT, ep TEXT,
  session          TEXT, native_session TEXT, subagent TEXT,
  ttft_ms          INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  cost             REAL, credits REAL, priced INTEGER,
  magpie_version   TEXT,
  payload_json     TEXT NOT NULL       -- 整行原样，保留未知字段
);

CREATE TABLE raw_route (
  route_id         INTEGER PRIMARY KEY,
  time_ms          INTEGER NOT NULL,
  day              TEXT NOT NULL,
  agent TEXT, session TEXT, conv TEXT, folder TEXT, subagent_id TEXT,
  model TEXT, provider TEXT, served TEXT, effort TEXT,
  status INTEGER, error TEXT, done INTEGER,
  ms INTEGER, ttft INTEGER, first_text INTEGER, flow INTEGER,
  tokens INTEGER, out_tok INTEGER, reasoning INTEGER,
  kind TEXT, for_json TEXT,           -- handed_on 的内部调用
  payload_json     TEXT NOT NULL,     -- 整条路由，保留 tries/order/affinity/prompt
  magpie_version   TEXT
);

CREATE TABLE raw_hook (
  hook_id          TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL,
  protocol TEXT, path TEXT, agent TEXT, session TEXT, cwd TEXT,
  origin TEXT, model TEXT, stream INTEGER, success INTEGER, duration_ms INTEGER,
  request_z        BLOB, response_z BLOB,
  request_bytes    INTEGER, response_bytes INTEGER,
  truncated        INTEGER NOT NULL DEFAULT 0,
  parse_error      TEXT,
  magpie_version   TEXT
);
```

保留 `payload_json` 的整份原文，是为了应对 magpie 改字段：不用提前把所有字段解析成列，出现新字段时先从原始载荷补，再改表。代价是原始层按天增长，用单独的保留策略回收，建议 7 天。

### 读模型：一条请求一行

```sql
CREATE TABLE request (
  req_id           INTEGER PRIMARY KEY,
  route_id         INTEGER UNIQUE,
  response_id_norm TEXT,
  -- 归属
  agent TEXT, session TEXT, conv_key TEXT, conv_source TEXT,
  started_ms       INTEGER NOT NULL,
  day              TEXT NOT NULL,      -- 本地日期，用于回收
  via              TEXT NOT NULL,      -- through / hook / direct / rejected
  -- 身份与状态
  status INTEGER, stop TEXT,
  model_requested TEXT, model_served TEXT, provider TEXT,
  -- 读数
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning INTEGER, cost REAL, priced INTEGER,
  ms INTEGER, ttft_ms INTEGER, flow_ms INTEGER, first_text_ms INTEGER,
  -- 上下文
  prompt_tokens INTEGER, prompt_counted INTEGER,
  prompt_window INTEGER, prompt_turns INTEGER, parts_json TEXT,
  -- 正文
  skeleton_z       BLOB,               -- 去掉 summary 后的骨架，zstd
  body_bytes       INTEGER,            -- 原始正文字节数
  msg_count        INTEGER,
  prev_req_id      INTEGER,            -- 同会话上一笔
  delta_ordinals   TEXT,               -- 新增消息下标，JSON 数组
  tool_pairs       TEXT,               -- tool_use id 到结果序号的映射，JSON
  -- 派生
  title TEXT, title_source TEXT,       -- first_user / model_time / none
  -- 完整性
  have             INTEGER NOT NULL,   -- 位：1 hook 2 账本 4 路由
  miss_reason      TEXT,
  magpie_version   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX i_req_conv ON request(conv_key, started_ms DESC, req_id DESC);
CREATE INDEX i_req_time ON request(started_ms DESC, req_id DESC);
CREATE INDEX i_req_resp ON request(response_id_norm);
CREATE INDEX i_req_day  ON request(day);
CREATE INDEX i_req_fail ON request(started_ms DESC) WHERE status >= 400;
```

### 内容库

```sql
CREATE TABLE block (
  hash     BLOB PRIMARY KEY,   -- 32 字节 sha256
  z        BLOB NOT NULL,      -- zstd
  raw_size INTEGER NOT NULL,
  refs     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE block_id (
  hash BLOB PRIMARY KEY,
  id   INTEGER NOT NULL UNIQUE   -- 引用行用的整数代理键
);

CREATE TABLE request_block (
  req_id INTEGER NOT NULL,
  ord    INTEGER NOT NULL,      -- messages 数组下标
  role   INTEGER NOT NULL,      -- 0 user / 1 assistant / 2 system / 3 tool
  block  INTEGER NOT NULL,      -- block_id.id
  PRIMARY KEY (req_id, ord)
) WITHOUT ROWID;

CREATE INDEX i_rb_block ON request_block(block);
```

**引用行为什么用整数代理键。** 第一版试过在引用行里存 32 字节全哈希，也试过存 8 字节前缀再回查 `block`。全哈希让每条引用多 24 字节，占总开销的 16%（43.6 KB 里约 7 KB）；前缀回查则必须在 `block` 上做范围扫描，实测合并一笔请求从 3 ms 涨到 703 ms，差了 200 倍。整数代理键两头都不占：引用行 4 字节，回查是主键命中。

引用按消息粒度存。`role` 单列是为了查询时只取 user 消息做标题、只取 assistant 做回复，不必解压全部块。

### 为什么去掉 summary

AVA 的骨架里，`request.summary` 与 `response.summary` 合计占骨架大小的 62.9%（400 条样本，13.1 MB 骨架里 8.3 MB 是摘要）。它是对正文的第二次结构化解析，内容与 `body` 重复。

去掉之后骨架原文从 82 MB 降到 42 MB，压缩后 9.5 KB/笔。摘要要用到的字段（消息数、工具名、模型）在摄入时直接算进 `request` 的列，不在骨架里存第二份。

### 引用计数

`block.refs` 维护引用数，删除请求时递减，减到 0 的块进入孤儿清理。不用触发器，在同一个事务里显式维护。

## 派生字段

这三个字段是界面不塌的前提，全部在摄入时算好，查询时不再扫全量。

### 标题

取该笔第一条新增 USER 消息的首行，去掉 harness 包装（`<system-reminder>`、`<command-*>`、工作目录说明这类），压空白，截到 60 字。

没有正文时回落到 `模型 · HH:MM`，并把 `title_source` 记为 `model_time`。direct 行永远走回落，界面要能显示这个差别。

### 新增消息

正文按消息粒度分块后，每条消息的哈希已经在 `request_block.block` 里。增量计算：

```text
上一笔的块集合 = SELECT block FROM request_block WHERE req_id = prev_req_id
本笔新增 = 本笔里 block 不在上一笔集合中的 ord
```

结果只存下标数组 `delta_ordinals`。实测每笔新增通常是 1 到 3 条。压缩或裁剪会让历史被重写，这时增量会退化成几乎全部消息，那笔就把 `prev_req_id` 置空，界面标出「无法判定增量」。

这一步的计算成本实测 0.17 ms（167 条消息），放在摄入时做没有压力。放到查询时做则是 O(N²)，不能接受。

### 工具配对

从回复里取 `tool_use`（Anthropic）或 `tool_calls`（OpenAI）的 id，到后续同会话请求的 `tool_result` / `role=tool` 里按 id 找结果。找到就记 `id → (req_id, ord)`，找不到就留空，界面显示「未出现在后续请求中」。

配对只做一次，存在 `tool_pairs` 里。不做跨会话配对，也不按名称或位置猜。

### 协议归一

真实数据里 87% 的请求是 Anthropic Messages 形状，而原型假设的是 OpenAI 形状。需要一个协议适配层，把两种形状映射成统一的消息模型：

| 统一字段 | Anthropic | OpenAI |
| --- | --- | --- |
| 角色 | `role` | `role`，工具结果用 `role: tool` |
| 文本 | `content[].type == text` | `content` 字符串或 `content[].type == text` |
| 工具调用 | `content[].type == tool_use`，id 在 `id` | `message.tool_calls[]`，id 在 `id` |
| 工具结果 | `content[].type == tool_result`，指向 `tool_use_id` | `role: tool`，指向 `tool_call_id` |
| 推理 | `content[].type == thinking` | `reasoning_content` |
| 系统提示 | 顶层 `system` | `messages[].role == system` |

原型的渲染函数基本可以复用，替换数据来源即可。适配层是唯一需要按协议写代码的地方，其余逻辑都吃统一模型。

## 缺失语义

这是原型做得对、必须原样保留的部分。

`have` 位图区分缺在哪个通道。界面按位显示，不合并成一个笼统的缺失。

| 现象 | 判定 | 界面处理 |
| --- | --- | --- |
| 有账本、无 hook | `have & 1 == 0` | 显示身份与读数，正文区写明回调未收到 |
| 有 hook、无账本 | `have & 2 == 0` 且超过阈值 | 标待关联，保留候选，不按时间强行匹配 |
| 无路由 | `have & 4 == 0` | 路由段显示当前来源不提供 |
| 正文超过上限 | `truncated == 1` | 显示已截断与原字节数 |
| `ttft` 缺失 | 字段不存在 | 显示未报告，不写 0，也不推断非流式 |
| `window` 缺失 | 字段不存在 | 不显示占用率 |
| 费用未定价 | `priced == 0` | 显示未定价，不写 $0 |

三条硬规则：

**缺失等于键不存在。** 账本文件里 `cache_write`、`credits` 等键在多数行根本不存在，而 API 把它们补成 0，还额外算出 `cost`、`priced` 等字段。所以摄入以文件为权威，API 只用来补 direct 行。

**时间统一转 epoch 毫秒再比较。** 原始串保留在 `t_text` 里，因为 through 行带本地时区偏移、direct 行是 `Z`，字符串比较在排序、去重、按天分组三处都会错。

**截断要单独记账。** 不能把截断的正文当完整正文解析，也不能把截断当成缺失。AVA 那 98 条就是教训：记录在，骨架不是合法 JSON，解析器静默失败，看起来像「这笔没有正文」。

## 查询接口

内部接口，只给本机页面用。全部返回 JSON，路径前缀 `/api`。

| 接口 | 用途 | 分页 |
| --- | --- | --- |
| `GET /api/sessions?limit=50&cursor=` | 会话列表，含笔数、最后时间、异常标记 | keyset，(last_ms, conv_key) |
| `GET /api/sessions/:key/requests?limit=100&cursor=` | 会话内请求列表，只返回列字段 | keyset，(started_ms, req_id) |
| `GET /api/requests/:id` | 单笔的全部读数字段与路由 | 无 |
| `GET /api/requests/:id/body?from=0&to=40` | 分页取消息，按需解压块 | 消息序号区间 |
| `GET /api/requests/:id/route` | 路由决策与尝试链 | 无 |
| `GET /api/stats` | 库体积、覆盖位统计、版本探针结果 | 无 |

四条约束：

**列表接口不返回骨架。** 会话内 1,825 笔的列表，每笔骨架 9.5 KB，全取就是 17 MB。列表只返回 `req_id`、时间、状态、模型、四个读数、标题、`have`。

**分页用 keyset，不用 offset。** 摄入一直在写，offset 会漂移。游标是本页最后一行的 `(started_ms, req_id)`。

**正文按消息序号区间取。** 一次取 40 条，块解码在单次请求内复用缓存。实测取 40 条 0.13 ms，最重的一笔 526 块全取 13.7 ms。

**不做服务端全文搜索。** FTS5 可用，但正文在块里，建索引要把每块都解压一遍，写入成本与存储成本都不小。第一版的会话导航不需要它，先不做。

## 容量与保留

### 单笔请求的存储成本

回放实测 43.6 KB/笔，拆开是：

| 组成 | 每笔 |
| --- | --- |
| 正文边际新增内容（88 KB 原文，3.45 倍压缩） | 约 26 KB |
| 骨架（去 summary，2.7 倍压缩） | 9.5 KB |
| 引用行与索引 | 约 6 KB |
| 读数字段与索引 | 约 2 KB |

### 滚动预算

按 43.6 KB 一笔：

| 日请求量 | 日增长 | 10 GB 可保留 |
| --- | --- | --- |
| 4,000（当前） | 约 178 MB | 约 56 天 |
| 12,000（3 倍） | 约 534 MB | 约 19 天 |
| 40,000（10 倍） | 约 1.78 GB | 约 5.6 天 |

这个结论要直说：10 GB 是一个正文预算，而正文体积由 Agent 实际读了多少文本决定。压缩和去重只能削减重复部分，不能削减新增部分。现成的 3.45 倍压缩比已经用掉了 zstd 级别 3 的收益，再往上调只换来个位数百分点。

三个可调杠杆，按代价从低到高：

1. **分级保留。** 元数据（`request` 行）保留全部历史，正文（`skeleton_z`、`block`）按预算滚动。丢了正文仍然能看所有读数、路由和会话结构，这与项目定位里「最新记录缺正文时显示原因」的处理一致。
2. **超大块降级。** 超过 256 KB 的单个块只存哈希、前 4 KB 预览和原始大小。实测块最大 602 KB，这类通常是整文件读取。
3. **训练 zstd 字典。** 对块内容训练一个 64 KB 的字典，小块压缩比能改善。代价是多一套训练与版本管理流程。

第一版只做分级保留，另两个留接口不做。

### 回收

回收以天为单位，按 `day` 列从旧到新删：

```text
1. 选出最旧一天的 req_id 集合
2. 事务内：删除 request_block 行，同时把对应 block.refs 减 1
3. 删除 block 中 refs = 0 的行，连带删除 block_id 对应行
4. 删除 request 行
5. 删除该天的 raw_ledger / raw_route / raw_hook
6. 每 1000 行 PRAGMA incremental_vacuum
```

回收在写入低峰执行（实测 16:00 前后是高峰，凌晨是低谷），单次限量，避免长事务把写者挡住。

## 版本与形状漂移

启动时做两步探测，结果写进 `/api/stats` 并在界面角标显示。

**版本探测。** 读 `~/.config/magpie/last-version`，再调 `GET /v1` 取 `version` 字段，两者不一致时以 HTTP 为准并记录。已验证区间初始定为 `>=0.1.1294 <0.2.0`。超区间仍启动，但：

- 每条记录写 `magpie_version`；
- 界面对超区间采集的数据标未验证；
- 不做拒绝启动。

单点锁已经失效：评审当天本机从 0.1.1294 升到了 0.1.1296。

**形状探测。** 启动时各取最近若干行做一次字段检查：

| 源 | 必含字段 |
| --- | --- |
| 账本 | `t`、`agent`、`model`、`in`、`out`、`status`、`route_id` |
| 路由 | `id`、`time`、`agent`、`model`、`tries`、`prompt`、`order` |
| hook | `protocol`、`path`、`agent`、`request` |

任一必含字段缺失就进入降级模式：继续采集，但界面标出形状不符，并在日志里记一条。未知字段不丢弃，进 `payload_json`。

**接口形状的假设集中在一处。** 各路的字段名映射写在一个模块里，magpie 改名时只改那处。

## 安全边界

| 约束 | 做法 |
| --- | --- |
| 只监听 `127.0.0.1` | 绑定写死回环地址，不读环境变量覆盖 |
| 禁止凭证落盘 | hook 载荷在写 spool 之前先脱敏；spool 文件权限 600 |
| hook 只收本机流量 | 默认丢弃 `origin != local`，与 AVA 现有 hook 的默认一致 |
| 账号字段不外传 | `providerAccount`、`providerKeyId`、`host` 只在本地库，接口默认不返回 |
| 运行数据在仓库外 | 库文件、spool、日志都在用户目录，`.gitignore` 再加一层 |
| 不扫描 Agent 会话文件 | 只读 magpie 自己写的来源 |

### 脱敏

hook 拿到的是脱敏前的正文。collector 自己实现一层，规则分四类：

| 类 | 处理 |
| --- | --- |
| 请求头 | 白名单保留 `content-type` 之类，`authorization`、`x-api-key` 等一律替换为占位符 |
| 已知凭证形态 | `sk-`、`Bearer `、`AKIA`、私钥块、JWT 三段式等按模式替换 |
| 敏感字段名 | 键名匹配 `token`、`password`、`secret`、`key`、`authorization` 时替换值 |
| 用户自定义 | 配置文件里的正则列表 |

占位符保持稳定（同类同值映射到同一个占位符），这样正文仍然可读，去重也不会因为脱敏变得零碎。

脱敏在分块之前做，保证块哈希基于脱敏后的内容。这一条决定了同一份内容不会因为一次带凭证一次不带而存两份。

## AVA 下线

顺序不能颠倒，否则切换窗口里会丢正文。

```text
1. collector 的 hook 上线，与 AVA 并行，各自收一份
2. 观察 collector 侧覆盖率与 AVA 侧一致（以共用 response_id 为对照）
3. 停 AVA 服务，从 plugins.json 摘掉 AVA hook
4. 撤 AVA 的常驻进程与开机启动
5. 保留 AVA 库只读，不导入数据，不写入
```

第 2 步的判据用实测口径：两边对同一批 `response_id` 的记录条数与可用正文条数。AVA 侧今日 3,480 条有可用正文、98 条被自己的 2 MB 上限截断，collector 侧应当比它多出这 98 条，其余一致。

并行期有一个具体的预算问题：两个 hook 串行执行，总预算按各自 `gatewayTimeoutMs` 相加，夹在 2 到 10 秒之间。AVA 没设这个值，取默认 1 秒。collector 若设 2 秒，合计 3 秒，在限额内。所以并行期间不需要改 AVA 的配置，但要确认 collector 不超过 2000。

已知的两次缺口要分清性质：

- 19:02 到 19:41 之间 AVA 有 39 分钟几乎无记录，同期账本也只有 1 行。那段时间本机确实没有请求，不是 hook 掉线。
- 20:07 到 20:19 的 12 分钟空档同理，账本只有 4 行。
- 18:08 到 18:33 那 83 笔缺失是另一回事：账本有 172 笔，AVA 有 90 笔，缺的 83 笔全部来自同一会话、同一模型，prompt token 在 18 万以上，回复输出中位 342 token（命中的那些是 119）。这指向超大请求的 hook 回调丢失，需要在 collector 上线后带 `miss_reason` 单列统计，不能再靠猜。

## 落地顺序

分四步，每一步都有可验证的判据。第 1 步不接 hook，可以先证明读路径。

**第 1 步：只读账本与路由，出一个真实数据页面。**

- 范围：`raw_ledger`、`raw_route`、`request`（无正文）、`/api/sessions`、`/api/sessions/:key/requests`、`/api/requests/:id`；
- 前端把 `TIMELINE` 换成一次 `fetch`，界面不动；
- 判据：`prompt.tokens = in + cache_read + cache_write` 的成立比例不低于 99%，`route_id` 连接率 100%，1,825 笔会话分页在 100 ms 内返回。

这一步结束时，界面上正文全空、只有读数与路由，这是预期状态。

**第 2 步：接 hook，落正文，写派生字段。**

- 范围：hook 端点、spool、脱敏、分块、内容库、标题、增量、工具配对、协议适配层；
- AVA 并行运行；
- 判据：用共用 `response_id` 对照，两边记录条数一致，collector 侧可用正文多出 AVA 被截断的那些；最重的一笔正文合并不超过 50 ms（实测 13.7 ms）；新增消息在对话视图里没有错位。

**第 3 步：停 AVA，做回收与保留。**

- 范围：滚动预算、分级保留、孤儿清理、`/api/stats`；
- 判据：注入 10 GB 以上的合成数据，回收能回到预算以下且不阻塞写入；回收后历史请求的读数仍可查。

**第 4 步：direct 回填（可选）。**

- 范围：走 `/v1/magpie/usage/requests?via=direct` 分页拉取，`limit=500` 一页，31,072 行约 63 次请求；
- 判据：31,072 行全部入库，复合键重复的 170 组按 `(t, session, agent, model, in, out)` 合并成一条并记下这条规则，会话键与 through 不混。

## 未决问题

1. **超大请求的 hook 回调为什么会丢。** 缺失集中在 18 万 token 以上，占了该量级的 21%，但同会话的并发中位数和命中组一样。需要在 collector 上线后按 `ep`、`status`、正文大小、`ms` 分桶统计，找出规律再决定要不要在客户端侧补救。
2. **direct 是否还会新增。** 31,072 条全部落在 2026-08-20 到 2026-10-13，之后到 10-20 只有 1 条（就是本次会话）。判断它是 magpie 对会话文件的首次索引回填。如果 magpie 重启或会话文件变动时会重新扫描，需要再测。
3. **分级保留的切分点。** 正文按天滚动、元数据全留，是当前建议。多大预算下开始丢正文、丢哪些会话，需要先定一个偏好，比如「最近 30 天全留，更早只留读数」。
4. **是否保留推理正文。** 路由里有 `reasoningHidden` 标记，账本有 `reasoning` token 数，推理正文只在 hook 的回复里。是否入库、入哪一层会影响正文体积，需要先定。
5. **多实例。** 当前设计是单进程单库。`route_id` 是进程内时钟计数，跨机可能撞。现在不加实例标识，但要预留一列。

## 本轮修正的旧结论

评审早期的这几条在这一轮被更细的度量推翻，后续文档不应再引用：

| 旧结论 | 实测修正 |
| --- | --- |
| 去重后内容占 5.8% | 11.3%。块级 1,261.6 MB 引用降到 142.7 MB；规范哈希 11.0% |
| hook 覆盖率 97.3% | 可用正文 94.98%，另有 2.67% 被 AVA 的 2 MB 上限截断 |
| 单笔约 34 KB，10 GB 可留 75 天 | 43.6 KB，56 天 |
| zstd 级别 3 得 3.72 倍、级别 9 得 4.06 倍 | 3.45 倍与 3.75 倍；早期用 `{ level }` 参数，被 Bun 静默忽略 |
| direct 行在账本文件里 | 文件里一条都没有，只有 API 拿得到 |
| 账本 19,799 行、今日 3,957 笔 | 20,034 行、今日 4,288 笔 |
