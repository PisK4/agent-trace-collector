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
| 未知前驱 | 消息序列无公共前缀 | 显示"无法确认与上一笔的新增关系"，不标新增，仍可读整笔正文。 |
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

## 文档

- [项目文档索引](docs/README.md)
- [架构设计](docs/architecture-design.md)
- [持久化与真实页面](docs/superpowers/plans/2026-10-20-collector-foundation.md)
- [正文与关联派生](docs/superpowers/plans/2026-10-20-collector-body.md)
- [保留恢复与切换](docs/superpowers/plans/2026-10-20-collector-retention.md)
