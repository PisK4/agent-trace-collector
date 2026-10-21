# agent-trace-collector

本机 magpie 请求记录器。账本、路由与 hook 三路证据进入同一个 SQLite 库，查询走独立只读连接；浏览器页面复用 `prototypes/` 里的三栏布局和原生 JavaScript。

当前处于实施阶段，生产代码按 [实施总入口](docs/superpowers/plans/2026-10-20-collector-implementation.md) 推进。已落地的是存储基座，采集、查询与页面随后补上；计划里的复选框逐项完成后才会更新为可用状态。

## 运行

```bash
bun install
bun run start        # 默认 127.0.0.1:8320
bun test
bun run typecheck
```

默认数据库为 `~/Library/Application Support/agent-trace-collector/trace.db`。可用 `ATC_DATA_DIR`、`ATC_PORT`、`ATC_LEDGER_PATH`、`ATC_ROUTING_DIR`、`ATC_MAGPIE_URL`、`ATC_BODY_BUDGET`、`ATC_DISK_LIMIT` 覆盖；监听地址固定为回环，不接受配置成通配地址。

### hook 回调

`plugins/collector.hooks.ts` 是给 magpie 的薄插件：请求期生成 `hook_id`，完成期把完整请求与回复 POST 到 `/hook/ingest`。它不改正文、不做关联。注册前需要两件事：

1. 读取令牌与 hook 令牌是两个独立文件（`read.token`、`hook.token`），都在数据目录下，首次启动自动生成、权限 0600。插件只拿 hook 令牌。
2. 插件入口文件名必须带 `.hooks.ts`；插件由 magpie 侧配置加载，本仓库不自动安装。

投递预算固定：总 1500 ms，单次 600 ms，最多两次，只对网络错误与 408/429/5xx 重试；4xx 直接放弃。回调丢失按 best-effort 处理，不承诺补投。回调超限时发送 metadata envelope（正文置空、带原始字节数与原因码），不截断 JSON。

合并没有完成时，hook 请求留在 `pending_hook`，collector 每 5 秒按 response ID 重试一次；候选唯一才合并，多候选标 ambiguous，没有 ID 的长期 pending。

## 数据边界

运行数据不进仓库：数据库、WAL、日志和本地密钥都在数据目录，文件权限为 0600，目录为 0700。测试只用合成数据；真实请求正文、账号、令牌和用户配置不复制进 fixture、日志或提交。

## 阅读界面验收（A5）

页面从原型迁移后已接真实分页数据，正文通道按计划留到 B5。下面这轮验收在合成库上完成，没有接真实流量：

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 宽度 | 同一页面用 CDP 依次覆盖视口 1500 / 1200 / 900 / 619 / 400 px | 1500 与 1200 保持三栏（250/220 + 中间自适应 + 348/310）；≤1000 回到单列文档流：会话 → 请求 → 读数；≤620 隐藏面包屑、请求头改为两行。各档 `scrollWidth === innerWidth`，无横向滚动。 |
| 主题 | 切换 `data-theme` 与跟随系统 | 浅色 `#edf2f5` / 深色 `#101923` 两套表面都生效，`color-scheme` 跟随。 |
| 会话分页 | 120 个会话 | 首屏 50，点“加载更多会话”到 100，`conv_key` 无重复。 |
| 请求分页 | 单会话 123 笔 | 首屏 100，加载后 123，`req_id` 无重复；末页时按钮隐藏。 |
| 快速切换 | 连点三个会话，只有最后一个落定 | 选中、面包屑、标题、列表一致地停在最后一个。 |
| 刷新 / 后退 | 带 `session`、`trace`、`view` 的 URL 刷新 | 会话、选中请求与视图都还原；`replaceState` 不产生多余历史。 |
| 过期请求 id | URL 带库里不存在的 `trace=999999` | 面包屑显示“Request 999999 未找到”，并提示下面不是那一笔；不回退到最新一笔。 |
| 异页请求 id | URL 带落在更早页的 `trace=1` | 显示“未在已加载页”，提示继续加载可选到。 |
| 未知会话 | URL 带不存在的 `session` | 标题写“这个会话不在已加载列表里”，不借用别的会话。 |
| 空库 | 全新 dataDir 启动 | 会话栏空、正文区说明“库里还没有会话”，右栏“未选择请求”。 |
| API 失败 | 包装服务让 `/api/sessions/:key/requests` 固定返回 500 | 正文区显示“请求列表加载失败：http_500”，不渲染成空库。 |
| 404 / 400 | 直接请求 `/nope`、`?limit=abc`、`/api/requests/999999` | 分别 404、400 `invalid_limit`、404 `not_found`。 |
| 标题注入 | 合成标题 `<img src=x onerror=alert(1)>` | 只作为文本显示，`innerHTML` 为转义实体，页面无 `img` 节点，`alert` 未触发。 |

浏览器验收时发现并修掉两个问题：页面 CSP 原先没有放行内联样式，整块 `<style>` 被拦截，页面实际是无样式渲染；账本按时间倒序排列却从 01 递增，与对话视图的编号方向相反。两处都已改并补了回归测试。

## 正文阅读验收（B5）

同一套合成库（三个会话、Anthropic 与 Chat 两种协议、父子代理、未支持协议、回收与未到正文）上跑完，没有接真实流量：

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 纯文本 | Anthropic 三笔连续请求 | 逐笔显示确定新增的用户消息与助手回复，后两笔标出"输入是上一笔的工具结果"。 |
| 工具往返 | 调用在第 2 笔、结果在第 3 笔 | 工具卡按 ord 对齐服务端配对，点"查看结果"跳到 `req 18 #4` 并高亮该消息。 |
| 多工具 | 一笔两调用 | 两个调用各自成行，都标"结果已配对"，不只展开第一个。 |
| 推理块 | thinking 块 | 折叠展示并给出段数；纯工具调用的回复也保留推理块，不读成"没有内容"。 |
| 空回复 | 回复对象为空数组 | 显示"回复对象存在，但没有文本内容"；回复为 null 时显示"上游未提供可用回复"。 |
| 分页 | 44 条消息 | 首片 40 条、计数"40 / 44"，点"加载下一片"追加到 44 且按钮消失。 |
| 未支持协议 | responses 协议 | 标"原对象已保存"，明说没有逐条消息视图，「原始脱敏对象」可读完整请求。 |
| 未到 / 回收 | pending 与 evicted | 各带原因，不出现消息列表、翻页按钮和伪造回复。 |
| 未知前驱 | 消息序列无公共前缀 | 显示"另起一支"，不标新增，仍可读整笔正文。 |
| 父子代理 | 同会话两个 actor | 各自独立成链，子代理的增量只按 child-1 自己的前驱算。 |
| 按需加载 | CDP 网络日志 | 首屏只取已加载请求各一片正文（`?from=0&to=40`）；切换会话同样只取新页，不下全量。 |
| 迟到响应 | 让 req 16 的正文慢 2 秒再点 17 | 最终停在 17，右栏与展开行都未被迟到的 16 覆盖。 |
| 别名跳转 | URL 带已合并的旧 id 98 | 跳到 canonical（req 99 / Request 01），不再报"未在已加载页"。 |
| 刷新 | 带 `session`/`trace`/`view`/`tab` 刷新 | 会话、请求、视图与页签都还原。 |
| XSS | 标题、消息、回复、工具名与参数全带 `<img onerror>` | 页面无 `img` 节点，`onerror` 未执行，全部作为文本显示。 |
| 超大单条 | 2 万字单条消息 | 预览行保持单行截断（141 字符），右栏原文可读且不横向溢出。 |
| 宽度 | 1500 / 1200 / 900 / 619 / 400 px | 各档 `scrollWidth === innerWidth`，无横向滚动；400px 下消息行改成三列。 |

浏览器验收中发现并修掉三个问题：`/body-view.js` 不在静态白名单里，页面模块会整块加载失败；账本正文区固定只显示前 40 条，点"加载下一片"后仍然看不到新消息；已回收的正文仍带着 `msg_count` 和骨架分支，页面显示出永远取不到的"0 / 9 条消息"和一句"上游没有提供回复"。另外派生层有个真实缺陷：后续请求重发历史时，同一工具结果再次出现会把已确认的 `resolved` 覆盖回 `pending`，现在已确认的配对是终态。

本轮截图接口在本机 CDP 上不可用（连 `example.com` 也超时），版式验收改用元素几何测量（`scrollWidth`、`getBoundingClientRect`、`gridTemplateColumns`）代替像素截图。

## 真实数据验收（B5 后续）

合成库跑不出的一类问题只有真实流量才暴露。在 `ef235e74-…` 这个 44 笔的会话上人工验收，报出四项：列表没有可读标题、时间顺序倒置、详细内容默认全展开、顶层折叠行没有摘要。顺着这几项查下去，根因是派生层的比对口径错了。

**块哈希不能当比对键。** 同一段历史在后续请求里会因为 `cache_control` 断点移动、`content` 从数组换成字符串、harness 重新包装而换掉字节。修复前这个会话里 42 笔可比请求一笔续写都没认出来，全部落成"无法确认与上一笔的新增关系"。现在每个块额外存一份语义指纹（`block.fingerprint`）：去掉 `cache_control` / `signature`，键排序，统一消息片段形状后取 sha256。同一会话上的四档对照：

| 比对口径 | 续写 | 判不出 |
| --- | --- | --- |
| 原始块哈希 | 0 | 42 |
| 键排序 + 剥传输标记 | 27 | 15 |
| 语义指纹 + 仅比紧邻上一笔 | 29 | 13 |
| 语义指纹 + 任意祖先 | 35 | 7 |

**候选前驱不限于紧邻的上一笔。** 改为在 `(conv_key, actor)` 组里对所有更早请求求共同前缀，取最长完整前缀为父节点。同时把"关系未知"拆成两种：`branch`（有更早请求但都不是本笔前缀）与 `unknown`（更早的请求里有正文不可读的，链是断的）。修复后该会话分布为 `confirmed=35, branch=6, unknown=1, first=1`；回填当时全库 `confirmed=384, branch=7, first=4`，之后随采集继续增长。

其余三项改动：

- **正序**：`listRequests` 改成 `started_ms ASC, req_id ASC`，游标比较也随之翻转。账本序号、对话卡片、分页方向现在一致。
- **折叠行摘要**：派生时把 `input_preview` / `input_preview_kind` / `reply_preview` 写进 `request`，列表接口不读正文块。`kind` 区分 `delta`（本笔新增）、`tail`（末轮输入兜底）、`tool_result`（输入是工具结果）。回填时全库 265 笔有摘要。
- **默认折叠**：进入会话不再自动展开第一笔；`prefetchBodies` 每批渲染一次并带 epoch 守卫，避免快速切换时旧批次覆盖新页面。
- **标题**：会话标题不再取 `MAX(title)`（字典序会把 `group/model` 排到前面），改成最早一笔 `title_source='user_delta'` 的标题。harness 壳（`<session>`、`<transcript>`、`<command-*>`、技能注入提示）在取标题前剥掉。回填时 `user_delta` 标题从 1 笔涨到 52 笔。

schema 因此升到 v3。旧库没有原地升级路径：错的派生结果本身不可信，就地改写只会把错误固化下来。`openStore` 遇到低版本直接拒绝，由 `scripts/backfill-fingerprint.ts` 补列、重算块指纹并整库重跑派生。这个脚本自己开连接绕开版本检查，因为它的职责恰恰是升级旧库。

浏览器端复核：44 笔列表全部有摘要，`autoOpen: 0`，序号 01→44 与时间同向，页面标题带请求序号；31 笔正文正常加载，无空壳。


## 保留与容量（C1）

正文预算 `10 GB`、总盘 `16 GB`（十进制字节），用 `ATC_BODY_BUDGET`、`ATC_DISK_LIMIT` 覆盖。三道门槛都带滞回，模式变化才写 `collector_state`，重启后接着上次的模式算：

| 触发 | 效果 | 恢复条件 |
| --- | --- | --- |
| 正文占用 ≥ 预算 | 回收最旧正文到 90% 预算 | 回到 90% 以下 |
| 总盘 ≥ 80% | 只接元数据：证据、关联、raw 元数据照写，正文标 `partial` / `disk_body_paused` | 跌回 75% 以下 |
| 总盘 ≥ 95% | hook 一律 507，什么都不写 | 跌回 90% 以下 |
| 剩余空间 < `max(256 MiB, 2 × 本批上界)` | 暂停 | 余量回到门槛以上 |

回收按 `day`、`started_ms`、`req_id` 从旧到新，单批最多 100 笔、10,000 条块引用；删引用、删孤儿块、清骨架、改状态在同一个事务里，`have` 与历史读数不动，`body_prev_state` 保留原状态。共享块只在最后一个引用消失时删除。每批后 `incremental_vacuum(256)`，再 `wal_checkpoint(TRUNCATE)`；不做在线全库 VACUUM。

账本暂停时 `committed_off` 不动、只推进 `observed_off`，重读还能拿到那一段；同一来源代际的连续区间合并成一条 `source_gap`，补齐后标 `filled`，文件换代补不回来的标 `unrecoverable` 并一直可见。`/api/stats` 的 `open_gaps` 是未了缺口数。

raw 层保留 7 天：先给对应证据标 `payload_state=expired` 再删原文，attempt 字段、`route_summary`、解析状态与正文都不依赖 raw 层。仍带正文又没完成关联的 hook 原文不按到期删，只在 `ingest_issue` 记 `raw_hook_body_unlinked`。

真机验收（合成库，40 笔约 6.4 MB 随机正文，预算压到 2 MB）：启动即回收 40 笔，`block` 清零，`page_count` 1651 → 45，库文件 6.7 MB → 180 KB，`freelist_count` 回到 0。验收中修掉一个真实缺陷：`main.ts` 原先用一个全局 `running` 锁串行所有定时任务，启动时连续调用的几个 tick 只有第一个真正执行，其余被静默跳过——回收因此在启动阶段整轮失效。现在按任务名加锁，写操作本来就在同步事务里，不需要全局互斥。

## 维护与恢复（C2）

离线维护四条命令：`verify`、`backup`、`rebuild`、`purge-metadata`，用 `bun run maintain` 调用，都要求采集器已停。完整命令、错误码与恢复步骤见[运维手册](docs/operations.md)。

维护期间数据目录下有一把 `maintenance.lock`（`wx` 原子创建，内容记 pid 与持有者）。采集器启动时看到它就拒绝启动，陈旧锁不自动覆盖，路径原样报出来由人确认后删除。

备份走 `VACUUM INTO ?`（绑定参数），前置检查目标不存在、目录可写、余量够源库 1.1 倍，事后对备份再跑一次完整性校验，权限 0600。“源库是否已停”用 `locking_mode=EXCLUSIVE` 探测：只读连接跑不了 `wal_checkpoint`，看 `-wal` 大小也不可靠（TRUNCATE 之后在线库同样是 0 字节）。探测与复制共用同一个连接，不留中间窗口。

元数据淘汰默认只预览，`--apply` 必须带 `--approval-id`。一个事务里按顺序删费用观测、写墓碑、删工具链接、删块引用与孤儿块、删证据与别名、删请求、清无引用的路由摘要；外键是 `NO ACTION`，顺序错了整体回滚。墓碑按证据键记录，同一天只淘汰一部分也能精确处理；来源回放命中墓碑计 `purged_skip`，不复活。

`rebuild` 只重算正文仍可读的请求，并报告不可用数量与原因（`body_evicted_raw_present` / `body_evicted_raw_expired`）。正文已回收的请求保留旧标题与已确认的工具配对，不重写成时间兜底或空。

本轮修掉两个真实缺陷。一是 `openStore` 切到 WAL 后，第一次写事务之前不会创建 `-wal`/`-shm`，此时只读连接打不开库（`SQLITE_CANTOPEN`）——打开一个没有新写入的旧库就会踩到；现在开库时补一个空写事务把它们落下来。二是费用时钟冲突原先只抛错误、不落状态，`/api/stats` 无从显示费用停滞；现在冲突整页回滚后记 `cost_health`（计数、阻塞时点、证据键、窗口）。

## 切换核对（C3）

`bun run verify-cutover` 只读比较 collector 与 AVA 的正文覆盖，用来判断能不能停 AVA。分母是 collector 已保存的账本，窗口左闭右开，两边同一筛选；AVA 的表名不猜，先读 `sqlite_master` 与 `PRAGMA table_info` 按字段名挑唯一映射，挑不出来就停下报告看到的表与字段。

守恒关系是 `分母 = 有正文 + 无正文 + 无法唯一判断`，`normalized`（规范化 ID）与 `raw`（原始 ID）两份报告各自成立。NULL response ID 与规范化后重复的 ID 单列，不丢弃也不压成一条；两边都缺失的 ID 单列在 `missing_both`，不藏在集合交集中。报告只含 ID、时间、状态、大小与可用性元数据，不含正文，强制写在仓库外、权限 0600。

安装、24 小时并行观察、停 AVA 与回滚的步骤写在[运维手册](docs/operations.md)。**本轮没有执行任何外部配置变更**：没有注册 magpie 插件、没有停 AVA、没有改动 launchd。真实运行需要等待，合成测试不能替代观察窗口。

## 文档

- [项目文档索引](docs/README.md)
- [架构设计](docs/architecture-design.md)
- [持久化与真实页面](docs/superpowers/plans/2026-10-20-collector-foundation.md)
- [正文与关联派生](docs/superpowers/plans/2026-10-20-collector-body.md)
- [保留恢复与切换](docs/superpowers/plans/2026-10-20-collector-retention.md)
- [运维手册](docs/operations.md)
