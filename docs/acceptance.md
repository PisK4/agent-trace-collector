# 验收记录

本文件记录各轮验收的做法与结果：合成库上跑过的界面与接口检查、真实流量上暴露并修掉的问题、容量与保留的实测读数。每条记录带日期与前提，合成验收与真实流量验收分开写，不互相代替。

验收结果描述的是当时的代码与数据。现行行为以[架构设计](architecture-design.md)与代码为准；本文件回答的是「这条路径验证过没有、怎么验的」。

## 单一轨迹阅读界面（合成，2026-10-24）

合成服务端口 8770，18 笔状态会话 + 42 笔窗口会话 + 45 条消息深样本：

| 项 | 结果 |
| --- | --- |
| 行几何 | 每行 36px，只呈现序号、类型与内容；点击行在右栏查看详情，行右侧没有重复状态、结果请求入口、计量占位与展开箭头 |
| 窗口 | 最近窗口正序无重复；向前两页 prepend 后锚点残差约 3px（多帧重绘的 scrollTop 亚像素取整）；显式刷新重建窗口并记录时间 |
| 状态分离 | HTTP 失败独立记录行（107）；HTTP 200 + Chat `length` / Anthropic `max_tokens` 标回复截断且请求状态仍成功（108/109），正常停止不标截断（101）；辅助请求一笔一条记录（106） |
| 工具详情 | 同消息两个结果按调用序号分别读取；resolved 未读取显示「待读取」并提供承载请求入口；pending / ambiguous 不显示正文；Schema 五态文案各不相同，同名工具逐项列出 |
| 结构分页 | 45 条消息：折叠显示计数，首次展开读 40 条，下一片补 5 条；消息详情与返回保留计数 |
| 布局控制 | 侧栏 / 详情栏折叠（aria 同步、可见性隐藏分隔线）、详情栏拖拽 280..640（中栏保底 320）、默认与双击恢复可用最大宽度、方向键 ±20px；Session ID 复制成功与剪贴板拒绝降级（可选中文本 + 提示） |
| 响应式与主题 | 400 / 620 / 1000 / 1240 px 无横向溢出，工具结果 pre 内部滚动；1000px 以下堆叠布局移除分隔线；深色主题无溢出 |
| 读取成本（实测） | 窗口列表 → 首笔详情 +48ms → 元信息 +51ms；/api/ 传输 136,161 字节、57 次调用；路由、工具结果与结构历史片均未预取，并发上限 4 由 reader-store 单测钉住 |
| 三项阅读任务 | 生产页面复测通过：最新已记录回复定位（请求 19）；失败请求 107 与后续 12 笔（无「重试成功」表述）；116 调用 #0 结果定位到承载请求 17 |

## 阅读界面（A5，历史）

> 本节及下节验收针对已被单一轨迹替换的对话 / 账本双视图界面：`view` 参数、56px 账本行、对话卡片等事实已退役，仅作历史记录保留；现行界面见上一节。

页面从原型迁移后已接真实分页数据，正文通道按计划留到 B5。下面这轮验收在合成库上完成，没有接真实流量：

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 宽度 | 同一页面用 CDP 依次覆盖视口 1500 / 1200 / 900 / 619 / 400 px | 1500 与 1200 保持三栏（250/220 + 中间自适应 + 348/310）；≤1000 回到单列文档流：会话 → 请求 → 读数；≤620 隐藏面包屑、请求头改为两行。各档 `scrollWidth === innerWidth`，无横向滚动。 |
| 主题 | 切换 `data-theme` 与跟随系统 | 浅色 `#edf2f5` / 深色 `#101923` 两套表面都生效，`color-scheme` 跟随。 |
| 会话分页 | 120 个会话 | 首屏 50，点「加载更多会话」到 100，`conv_key` 无重复。 |
| 请求分页 | 单会话 123 笔 | 首屏 100，加载后 123，`req_id` 无重复；末页时按钮隐藏。 |
| 快速切换 | 连点三个会话，只有最后一个落定 | 选中、面包屑、标题、列表一致地停在最后一个。 |
| 刷新 / 后退 | 带 `session`、`trace`、`view` 的 URL 刷新 | 会话、选中请求与视图都还原；`replaceState` 不产生多余历史。 |
| 过期请求 id | URL 带库里不存在的 `trace=999999` | 面包屑显示「Request 999999 未找到」，并提示下面不是那一笔；不回退到最新一笔。 |
| 异页请求 id | URL 带落在更早页的 `trace=1` | 显示「未在已加载页」，提示继续加载可选到。 |
| 未知会话 | URL 带不存在的 `session` | 标题写「这个会话不在已加载列表里」，不借用别的会话。 |
| 空库 | 全新 dataDir 启动 | 会话栏空、正文区说明「库里还没有会话」，右栏「未选择请求」。 |
| API 失败 | 包装服务让 `/api/sessions/:key/requests` 固定返回 500 | 正文区显示「请求列表加载失败：http_500」，不渲染成空库。 |
| 404 / 400 | 直接请求 `/nope`、`?limit=abc`、`/api/requests/999999` | 分别 404、400 `invalid_limit`、404 `not_found`。 |
| 标题注入 | 合成标题 `<img src=x onerror=alert(1)>` | 只作为文本显示，`innerHTML` 为转义实体，页面无 `img` 节点，`alert` 未触发。 |

浏览器验收时发现并修掉两个问题：页面 CSP 原先没有放行内联样式，整块 `<style>` 被拦截，页面实际是无样式渲染；账本按时间倒序排列却从 01 递增，与对话视图的编号方向相反。两处都已改并补了回归测试。

## 正文阅读（B5，历史）

> 本节针对对话 / 账本双视图界面的正文阅读；正文读取语义（分页、状态说明、按需加载）已由单一轨迹视图继承，界面事实以「单一轨迹阅读界面」一节为准。

同一套合成库（三个会话、Anthropic 与 Chat 两种协议、父子代理、未支持协议、回收与未到正文）上跑完，没有接真实流量：

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 纯文本 | Anthropic 三笔连续请求 | 逐笔显示确定新增的用户消息与助手回复，后两笔标出「输入是上一笔的工具结果」。 |
| 工具往返 | 调用在第 2 笔、结果在第 3 笔 | 工具卡按 ord 对齐服务端配对，点「查看结果」跳到 `req 18 #4` 并高亮该消息。 |
| 多工具 | 一笔两调用 | 两个调用各自成行，都标「结果已配对」，不只展开第一个。 |
| 推理块 | thinking 块 | 折叠展示并给出段数；纯工具调用的回复也保留推理块，不读成「没有内容」。 |
| 空回复 | 回复对象为空数组 | 显示「回复对象存在，但没有文本内容」；回复为 null 时显示「上游未提供可用回复」。 |
| 分页 | 44 条消息 | 首片 40 条、计数「40 / 44」，点「加载下一片」追加到 44 且按钮消失。 |
| 未支持协议 | responses 协议 | 标「原对象已保存」，明说没有逐条消息视图，「原始脱敏对象」可读完整请求。 |
| 未到 / 回收 | pending 与 evicted | 各带原因，不出现消息列表、翻页按钮和伪造回复。 |
| 未知前驱 | 消息序列无公共前缀 | 显示「另起一支」，不标新增，仍可读整笔正文。 |
| 父子代理 | 同会话两个 actor | 各自独立成链，子代理的增量只按 child-1 自己的前驱算。 |
| 按需加载 | CDP 网络日志 | 首屏只取已加载请求各一片正文（`?from=0&to=40`）；切换会话同样只取新页，不下全量。 |
| 迟到响应 | 让 req 16 的正文慢 2 秒再点 17 | 最终停在 17，右栏与展开行都未被迟到的 16 覆盖。 |
| 别名跳转 | URL 带已合并的旧 id 98 | 跳到 canonical（req 99 / Request 01），不再报「未在已加载页」。 |
| 刷新 | 带 `session`/`trace`/`view`/`tab` 刷新 | 会话、请求、视图与页签都还原。 |
| XSS | 标题、消息、回复、工具名与参数全带 `<img onerror>` | 页面无 `img` 节点，`onerror` 未执行，全部作为文本显示。 |
| 超大单条 | 2 万字单条消息 | 预览行保持单行截断（141 字符），右栏原文可读且不横向溢出。 |
| 宽度 | 1500 / 1200 / 900 / 619 / 400 px | 各档 `scrollWidth === innerWidth`，无横向滚动；400px 下消息行改成三列。 |

浏览器验收中发现并修掉三个问题：`/body-view.js` 不在静态白名单里，页面模块会整块加载失败；账本正文区固定只显示前 40 条，点「加载下一片」后仍然看不到新消息；已回收的正文仍带着 `msg_count` 和骨架分支，页面显示出永远取不到的「0 / 9 条消息」和一句「上游没有提供回复」。另外派生层有个真实缺陷：后续请求重发历史时，同一工具结果再次出现会把已确认的 `resolved` 覆盖回 `pending`，现在已确认的配对是终态。

本轮截图接口在本机 CDP 上不可用（连 `example.com` 也超时），版式验收改用元素几何测量（`scrollWidth`、`getBoundingClientRect`、`gridTemplateColumns`）代替像素截图。

## 真实流量（B5 后续）

合成库跑不出的一类问题只有真实流量才暴露。在 `ef235e74-…` 这个 44 笔的会话上人工验收，报出四项：列表没有可读标题、时间顺序倒置、详细内容默认全展开、顶层折叠行没有摘要。顺着这几项查下去，根因是派生层的比对口径错了。

**块哈希不能当比对键。** 同一段历史在后续请求里会因为 `cache_control` 断点移动、`content` 从数组换成字符串、harness 重新包装而换掉字节。修复前这个会话里 42 笔可比请求一笔续写都没认出来，全部落成「无法确认与上一笔的新增关系」。现在每个块额外存一份语义指纹（`block.fingerprint`）：去掉 `cache_control` / `signature`，键排序，统一消息片段形状后取 sha256。同一会话上的四档对照：

| 比对口径 | 续写 | 判不出 |
| --- | --- | --- |
| 原始块哈希 | 0 | 42 |
| 键排序 + 剥传输标记 | 27 | 15 |
| 语义指纹 + 仅比紧邻上一笔 | 29 | 13 |
| 语义指纹 + 任意祖先 | 35 | 7 |

**候选前驱不限于紧邻的上一笔。** 改为在 `(conv_key, actor)` 组里对所有更早请求求共同前缀，取最长完整前缀为父节点。同时把「关系未知」拆成两种：`branch`（有更早请求但都不是本笔前缀）与 `unknown`（更早的请求里有正文不可读的，链是断的）。修复后该会话分布为 `confirmed=35, branch=6, unknown=1, first=1`；回填当时全库 `confirmed=384, branch=7, first=4`，之后随采集继续增长。

其余三项改动：

- **正序**：`listRequests` 改成 `started_ms ASC, req_id ASC`，游标比较也随之翻转。账本序号、对话卡片、分页方向现在一致。
- **折叠行摘要**：派生时把 `input_preview` / `input_preview_kind` / `reply_preview` 写进 `request`，列表接口不读正文块。`kind` 区分 `delta`（本笔新增）、`tail`（末轮输入兜底）、`tool_result`（输入是工具结果）。回填时全库 265 笔有摘要。
- **默认折叠**：进入会话不再自动展开第一笔；`prefetchBodies` 每批渲染一次并带 epoch 守卫，避免快速切换时旧批次覆盖新页面。
- **标题**：会话标题不再取 `MAX(title)`（字典序会把 `group/model` 排到前面），改成最早一笔 `title_source='user_delta'` 的标题。harness 壳（`<session>`、`<transcript>`、`<command-*>`、技能注入提示）在取标题前剥掉。回填时 `user_delta` 标题从 1 笔涨到 52 笔。

schema 因此升到 v3。旧库没有原地升级路径：错的派生结果本身不可信，就地改写只会把错误固化下来。`openStore` 遇到低版本直接拒绝，由 `scripts/backfill-fingerprint.ts` 补列、重算块指纹并整库重跑派生。这个脚本自己开连接绕开版本检查，因为它的职责恰恰是升级旧库。

浏览器端复核：44 笔列表全部有摘要，`autoOpen: 0`，序号 01→44 与时间同向，页面标题带请求序号；31 笔正文正常加载，无空壳。

## 标题与主链（B6）

Title Generator 是 harness 的旁路请求：Claude Code 用单块 `<session>用户消息</session>`，回复 `{"title":…}`；OMP 用 `<title-request>`，回复 `<title …>…</title>`。它们此前被当成普通请求，占据了会话的 `first`，真实主请求反而显示成「另起一支」。

派生层现在按回复形状识别标题请求（`req_kind='title'`、`chain_role='aux'`），它们不进祖先集合、不参与用户标题推导；生成的正式标题存进 `model_title`。会话标题按以下顺序取：

1. 最新一次 Title Generator 的正式标题；
2. 主链上最早的用户首句；
3. 任意一笔的用户首句；
4. 原有时间兜底（模型名 · HH:MM）。

每个 `(conv_key, actor)` 在派生末尾重算链角色：最早的一笔真实请求是主链根（`chain_role='main'`），其余互不相接的根及其后继标 `branch`。正文不可读的请求保持中性，不误标分支；界面只有真正的次链显示「⎇ 分支」。

清洗名单补了 `<local-command-caveat>`、插话前缀 `The user sent a new message while you were working:` 及其尾部的 harness 说明。这几类此前会直接变成标题或摘要。

schema 升到 v4（`req_kind`、`chain_role`、`model_title`）。沿用不原地升级的策略：`openStore` 拒绝低版本；全新库直接可用，旧库可以删除重建，也可以先停采集器再跑 `scripts/backfill-fingerprint.ts`（它同时补齐 v4 的三列）保住已有正文。

### 中栏版式（历史）

> 56px 六列账本行版式随单一轨迹切换退役（36px 紧凑单行 + 右栏读数页）；标签语义与固定行高的理由见 [Agent Note：固定账本行](../.agents/notes/archived/feature/2026-10-21-ledger-fixed-row-and-type-tags.md)。

折叠行固定 56px，六列网格：`状态点 12px | 类型标签 56px | 时间 46px | 内容 1fr | 读数 168px | 展开 12px`。内容列内两行各 18px；第二行没有回复也保留占位，保证所有行的主文本起点一致。读数列同样两行：上行是首字与总时长，下行是输入与输出 token，右对齐。两行布局把所需宽度压到单行的一半，现有数据最大值下单行最宽 133.5px，168px 仍有余量。类型标签固定 56×18，独占紧挨状态点的一列，两行各一个槽位，颜色沿用 `--k-*`：

| 类型 | 标签 | 颜色 |
| --- | --- | --- |
| 本轮新增用户文本 | 用户 | 绿 |
| 工具结果 | 工具 | 青 |
| 回复 | 回复 | 橙 |
| 末轮上下文 / 兜底 | 上下文 | 灰蓝 |
| Title Generator | 标题 | 紫 |

失败请求在行首加 2px 红条。异常标志（失败、待关联、正文未到/回收/不完整/协议不支持）、分支标记与 HTTP 状态码放在内容行右端并右对齐，不占读数列；正文预览按剩余宽度省略。1240px 以下移除读数列，内容列接管空间，标志仍可见；620px 以下类型标签收到 52px，行高改为 `min-height:56px`（底边框另计）。

合成库验收：13 行折叠态全部 56px，标签 56×18 且 x 坐标一致；1500 px 档每个读数行的所有子元素 left 不小于行左边界，1200 / 900 / 619 / 400 px 各档 `scrollWidth === innerWidth`，无横向滚动；标志右边缘落在内容列内；深色模式标签前景与背景随主题切换；只有真正的次链出现「⎇ 分支」；失败行有红条。本机 CDP 截图仍超时，验收使用元素几何与计算样式。

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

真机验收（合成库，40 笔约 6.4 MB 随机正文，预算压到 2 MB）：启动即回收 40 笔，`block` 清零，`page_count` 1651 → 45，库文件 6.7 MB → 180 KB，`freelist_count` 回到 0。验收中修掉一个真实缺陷：`main.ts` 原先用一个全局 `running` 锁串行所有定时任务，启动时连续调用的几个 tick 只有第一个真正执行，其余被静默跳过，回收因此在启动阶段整轮失效。现在按任务名加锁，写操作本来就在同步事务里，不需要全局互斥。

## 维护与恢复（C2）

离线维护四条命令：`verify`、`backup`、`rebuild`、`purge-metadata`，用 `bun run maintain` 调用，都要求采集器已停。完整命令、错误码与恢复步骤见[运维手册](operations.md)。

维护期间数据目录下有一把 `maintenance.lock`（`wx` 原子创建，内容记 pid 与持有者）。采集器启动时看到它就拒绝启动，陈旧锁不自动覆盖，路径原样报出来由人确认后删除。

备份走 `VACUUM INTO ?`（绑定参数），前置检查目标不存在、目录可写、余量够源库 1.1 倍，事后对备份再跑一次完整性校验，权限 0600。「源库是否已停」用 `locking_mode=EXCLUSIVE` 探测：只读连接跑不了 `wal_checkpoint`，看 `-wal` 大小也不可靠（TRUNCATE 之后在线库同样是 0 字节）。探测与复制共用同一个连接，不留中间窗口。

元数据淘汰默认只预览，`--apply` 必须带 `--approval-id`。一个事务里按顺序删费用观测、写墓碑、删工具链接、删块引用与孤儿块、删证据与别名、删请求、清无引用的路由摘要；外键是 `NO ACTION`，顺序错了整体回滚。墓碑按证据键记录，同一天只淘汰一部分也能精确处理；来源回放命中墓碑计 `purged_skip`，不复活。

`rebuild` 只重算正文仍可读的请求，并报告不可用数量与原因（`body_evicted_raw_present` / `body_evicted_raw_expired`）。正文已回收的请求保留旧标题与已确认的工具配对，不重写成时间兜底或空。

本轮修掉两个真实缺陷。一是 `openStore` 切到 WAL 后，第一次写事务之前不会创建 `-wal`/`-shm`，此时只读连接打不开库（`SQLITE_CANTOPEN`），打开一个没有新写入的旧库就会踩到；现在开库时补一个空写事务把它们落下来。二是费用时钟冲突原先只抛错误、不落状态，`/api/stats` 无从显示费用停滞；现在冲突整页回滚后记 `cost_health`（计数、阻塞时点、证据键、窗口）。

## 切换核对（C3）

`bun run verify-cutover` 只读比较 collector 与 AVA 的正文覆盖，用来判断能不能停 AVA。分母是 collector 已保存的账本，窗口左闭右开，两边同一筛选；AVA 的表名不猜，先读 `sqlite_master` 与 `PRAGMA table_info` 按字段名挑唯一映射，挑不出来就停下报告看到的表与字段。

守恒关系是 `分母 = 有正文 + 无正文 + 无法唯一判断`，`normalized`（规范化 ID）与 `raw`（原始 ID）两份报告各自成立。NULL response ID 与规范化后重复的 ID 单列，不丢弃也不压成一条；两边都缺失的 ID 单列在 `missing_both`，不藏在集合交集中。报告只含 ID、时间、状态、大小与可用性元数据，不含正文，强制写在仓库外、权限 0600。

安装、24 小时并行观察、停 AVA 与回滚的步骤写在[运维手册](operations.md)。这一轮没有执行任何外部配置变更：没有注册 magpie 插件、没有停 AVA、没有改动 launchd。真实运行需要等待，合成测试不能替代观察窗口。

## OMP harness 语义（2026-10-25）

OMP（oh-my-pi）的 feature 语义进读模型与阅读层，五项随 [Agent Note：OMP harness 集成](../.agents/notes/implemented/feature/2026-10-25-omp-harness-integration.md) 交付。合成验收进 `bun test`（700 用例，含 purpose/解释/派生/切片 parity/配对/web 投影各一组）；这里记生产库的真实数据验收，快照 2026-10-26 00:20，与合成验收分开呈报。

升级路径按交付清单执行：停采集器 → `maintain backup`（1.2 GB 全库备份）→ `scripts/backfill-omp-semantics.ts`（补 `context_event` 两列、建 `bg_job`、重建两个读模型视图，62 组 4,915 笔重派生）→ 9 个 OMP 会话逐个 `maintain rebuild --session`（用途目标 3→4）→ 起采集器。二次执行回填脚本幂等。

| 验收项 | 生产结果 |
| --- | --- |
| 旁路识别 | 四个 20:59:56 单笔 skill 描述压缩会话全部改判 `omp.skill-hint.v1`/`exclude`/`skill_hint`；两个标题会话保持 `title.reply.v1`；三个真实会话保持参与链 |
| 列表降噪 | `/api/sessions` 里 6 个全员 exclude 会话带 `bypass` 标志，界面默认折叠、计数行可展开 |
| 压缩事件位 | 24 笔会话的 req 4 判 `omp_compaction`，basis 记 `dropped_chars: 999551`（字符数）；其余参与行 `none`，正文不可读行保持 NULL；该会话标题退化为 `step-5-preview · 11:04` 模型时间兜底，不再是归档正文 |
| 背景作业配对 | 24 笔会话 24 个作业：同笔 resolved 13、跨笔 resolved 5、pending 6（含发起正文已回收的诚实缺口）；另一会话 1 个 resolved |
| effort 读数 | OMP 骨架可读请求的 `request_fields.reasoning_effort`（high/low）在用量折叠行显示，单次干净调用也显示 |
| 工具语义 | 小写 read 42 / edit 38 / write 15 / grep 1 的 `arg_path` 重算后非空，会话汇总「写入尝试 / 读取请求」对 OMP 会话有值；小写工具命中同族色类 |

## 读数页上下文分布 treemap（2026-10-26）

真实数据验收不动生产采集器：对生产库做在线 `VACUUM INTO` 快照（1.2 GB），复制脱敏盐到 0700 临时目录，临时 collector 用独立端口加载快照，验收后删除目录。快照含 magpie 10-24 拆出第七类之后的真实七类行。合成验收进 `bun test`（752 例全绿：`tests/context-map.test.ts` 三档宽度 × 四状态守恒断言、`tests/web.test.ts` 集成断言、`tests/http.test.ts` 静态白名单目录覆盖），与真实验收分开呈报。

| 验收项 | 真实结果 |
| --- | --- |
| 数字互证 | req 11444（glm-5.3，208,984 tokens，占用 20.9%）：图例七类之和等于 u-total 提示总量；对话内容 102.1k = 第 3 轮 56.9k + 第 1 轮 29.4k + 另外 2 项 15.8k；空闲 791.0k = 窗口 1.0M − 208,984；正常态无 pill |
| 白名单 items | req 10899（109,878 tokens）：`sum(parts) = tokens` 成立，七类 items 经 `safePrompt` 白名单透出，类内 item 之和与类总量一致（files 差 1 为四舍五入） |
| 第七色槽 | 两笔真实请求的 skills 类（4.0k）落 `--p7`，图例与 tile 同槽 |
| 布局合并桶 | req 11444 的 files 18 个碎项并成 rest 块，可视文字与悬停 title 均为「另外 18 项」——title 缺名是本轮真实数据暴露的缺陷，验收中修复（500e2eb）后复验 |
| 内容列表 | 同请求内容列表 53 行跨类降序，「显示全部」折叠接既有 data-fold 恢复机制 |
| 视觉快照 | 未取得：ego lite 的 CDP `Page.captureScreenshot` 对该页持续超时；视觉项由 DOM 断言与合成测试覆盖，数字互证在浏览器 DOM 内完成 |

## OTLP 两步走：Codex 条目与未知服务门铃（2026-10-26）

合成验收进 `bun test`（`tests/otlp-ingest.test.ts` 12 例、`tests/web.test.ts` 标签断言，typecheck 通过）：

| 验收项 | 合成结果 |
| --- | --- |
| Codex 建行 | `session_task.turn` span（字段清单取自真实流量，值自造）落 `via='otlp'`、`have=8`、`agent='codex'`，session 取 `thread.id`、模型取 `model`、四项用量取 `codex.turn.token_usage.*`；`model_served` 与 `stop` 保持 NULL，non_cached/reasoning/total 三项留原始层 |
| originator 家族 | `codex_exec`、`codex_cli_rs`、`codex_tui`、`codex_vscode`、`codex_mcp_server`、`codex_app_server` 六个取值都命中同一规则；家族外取值（`codex_unknown_entry`）不建行、记门铃 |
| 旁路任务 | `session_task.compact` 与 `session_task.user_shell` 不建行、不进未知桶 |
| 门铃 | 未登记服务 span 落原始层，按服务与接收日聚合记一行 `service_not_registered` issue；同日重发不新增，跨日新记一行；接收结果带 `unknownServices` 计数 |
| 版本 | `OTLP_MAPPING_VERSION=3`，既有两家规则行为不变（全量旧断言通过） |
| 页面 | `agentLabel` 带 `codex`，未知来源原样透出 |

真实流量验收（2026-10-26，本机 `codex-cli 0.162.0-alpha.17.2`，`codex exec` 直连 `127.0.0.1:8320`，三轮真实会话）。前提：`~/.codex/config.toml` 加 `[otel.trace_exporter.otlp-http]` 段（配置前已备份为 `config.toml.bak-atc-20261026`），令牌由 `otlp.token` 读入 base64url 后写入，未落屏。

| 验收项 | 真实结果 |
| --- | --- |
| 建行与用量 | `req_id 13565`：`agent='codex'`、`via='otlp'`、`have=8`、`body_state='summary'`；session 取 `thread.id`（`01a1765f-…`）；`in_tok 17234`、`cache_read 17152`、`out_tok 4` 与源 span 逐项相等，源 `total_tokens 17238 = 17234 + 4` |
| 证据身份 | `request_evidence` 记 `source_kind='otlp_span'`、`merge_state='merged'`、`match_rule='trace_span.v1'` |
| 门铃 | 规则修正前 `service/codex_exec/2026-10-26` 记过一行 `service_not_registered`（11:52:56）；修正后同一服务正常建行、不再记 |
| 旁路任务 | 未触发：三轮会话都没有 `session_task.compact` / `user_shell`，该断言仍只有合成证据 |
| 双通道并存 | 未验证：Codex 走 magpie 网关（`model_providers.magpie`），但本轮会话的 magpie 侧证据未与 OTLP 行对上，同会话两行形态留待下轮 |

本轮真实流量推翻了三处源码考察读法，全部按实测改写并在同一变更里同步文档与 note：`protocol` 取值是 `binary` / `json`（写 `protobuf` 会在加载配置时报 `unknown variant` 直接拒启）；`service.name` 是 `codex_exec` 而非考察档案的 `codex_cli_rs`（`codex exec` 覆盖 originator）；`OTEL_SERVICE_NAME` 覆盖无效（带该变量重跑仍为 `codex_exec`）。教训写进 note 的 Risks：源码考察不能替代真实流量核对。

## 派生正文读取复用（合成，2026-10-26）

本轮只做合成对照，没有接真实流量。`tests/body-cache.test.ts` 在临时库上构造 240 笔请求，每笔 40 条消息，其中 39 条在同组内逐字节共享、1 条唯一；用途冻结后直接调用组派生。对照组给同一代码路径注入 1 字节缓存预算，使每个块都退化为不缓存。

| 项 | 结果 |
| --- | --- |
| 解码次数 | 无缓存 33,939 次，有缓存 279 次；279 等于 240 条唯一消息加 39 个共享块 |
| 派生输出 | `req_id`、前驱关系、增量、链角色、标题、输入与回复摘要、回复形状、中断计数、上下文事件逐列相同 |
| 缓存退化 | 同 id 不同哈希分别解码；低预算按 LRU 淘汰并重读；单块超过上限与空哈希不入缓存；坏块与合法压缩但非法 JSON 不缓存 |
| 读取语义 | 命中不绕过 `body_state`、骨架与引用校验；正文替换后新作用域读到新内容；部分命中后遇到坏块仍返回不可读 |
| 消费者等价 | `replyInfoOf`、`messageAt`、`interruptCountTx`、`contextEventTx` 与展示 ports 在缓存与非缓存两条路径上结果一致 |

真实流量、完整组端到端对照、事件循环尾延迟与 RSS 未测，切片页的读取计数也不在本轮验收范围。本条只说明读取复用与结果等价在合成数据上成立，不作为容量结论。

## Responses 协议适配（合成，2026-10-26）

Codex 走 magpie 网关后，库里的 `responses` 请求一直停在「原对象已保存」：`input` 不进块库，逐条消息、工具往返与回复都读不出。本轮把该协议接进协议形状表，合成验收全部进 `bun test`（780 例全绿，typecheck 通过），没有跑真实流量回填。

| 验收项 | 合成结果 |
| --- | --- |
| 存储往返 | `input` 非空数组、空数组、裸字符串与带未知顶层字段四种形状，保存后恢复与脱敏原对象逐字相等；裸字符串合成一条用户消息存块，恢复时还原成字符串 |
| 语义指纹 | 不同 `call_id`、不同 `arguments`、不同 `output`、不同未知项产生不同指纹；只在工具结果处不同的两笔，公共前缀停在调用上 |
| 输入阅读 | `input_text` 用户消息形成输入步骤与标题文本；`developer` 消息按 system 角色解释 |
| 系统提示 | 顶层 `instructions` 与 `developer` 消息合并进能力视图与页面 System；空白 `instructions` 不算系统提示 |
| 工具往返 | 两笔 Responses 请求经真实派生流程得到 `resolved` 配对，`tool_call` 落库 `result_path=request.input[2]`，摘要「工具结果 · read_file」；HTTP 结果接口按 `call_id` 读出 `output`，`call_id` 不匹配返回 `invalid_location` |
| 回复与轮次 | `completed` 无调用判 `final`、`completed` 带有效调用判 `tools`；`status` 缺失、`incomplete`、`failed`、`in_progress` 与缺 `call_id` 都判 `unknown` |
| 页面块视图 | `replyView` 从 `output` 出块：消息项展开 content，调用与推理整项一块，路径 `reply.output[i]`，调用序号与 `tool_call.ord` 同口径；两条消息项各有 `content[0]` 时步骤键不撞 |
| 增量输入 | 带 `previous_response_id` 的请求关系落 `unknown`，不充当后续请求的祖先；其后的完整历史请求仍确认到更早的完整祖先 |
| 历史回填 | 旧布局（整段 `input` 在骨架里、`adapter_version` 为 NULL 或 1）重写后逐字恢复、消息进块、`parse_state` 转 `ok`；裸字符串形态记 `messages_form=string`；`partial` 与损坏骨架拒绝并原样保留；其它协议不动；第二次执行无写入、不推进 `input_revision` |

真实流量验收未做：本机库里已有的 `responses` 行还没跑 [reparse](operations.md#reparse)，Codex 会话的逐条消息与工具配对仍停在旧布局。

## 上下文分布图重排与点击明细（合成，2026-10-27）

本轮只做合成验收，全部进 `bun test`（810 例全绿，`bun run typecheck` 通过，`bun run verify:notes` 通过），没有跑真实统计核对。验收对象是布局重排（真实值面积、HTML tile）与点击明细（目录查询、明细弹窗），见 [Agent Note：上下文矩阵布局与点击明细](../.agents/notes/implemented/feature/2026-10-26-context-treemap-drilldown.md)。

| 验收项 | 合成结果 |
| --- | --- |
| 面积守恒 | 三档宽度 × 六状态：tile 界内不重叠、每类有面积、tile 总量等于 parts 和、有窗口必有空闲块；每类 tile 面积和等于该类份额 × 全图面积（0.5px² 容差），`share^0.35` 缓动与面积下限的旧口径断言删除 |
| 未逐项余量 | item 清单不覆盖类总量时差额渲染为显式余量块参与该类布局；逐块 token 合计与 parts 合计不一致是设计内事实，几何按类别守恒 |
| 碎项与整类 | 布局面积低于阈值的碎项并成员集合块后重排；类别矩形过小时整类一块不硬拆；成员身份随块保存并在明细列出 |
| 文字取舍 | 按实测尺寸判定：高度不足去数值行、更小全隐，无像素级字宽估算；名称与数值走正常文本布局、单行省略 |
| 目录查询定位 | results 用配对表列按输入顺序（result_ord → 内容块下标 → 调用序号）零消息块解压；files 按调用参数路径对齐、无对齐降级列全部结果块并说明；tools 读骨架 `tools`/`functions`；system 合并顶层字段与 role=2 块；chat/memory/skills 给承载块并说明未分离；未知 kind 返回 `unsupported` |
| 目录查询语义 | 同名工具多行全部保留；85 条消息按 80 条分页，游标绑定请求与类别，跨 kind 复用拒绝；pending/evicted/summary 按事实返回；阅读依据变化 409；HTTP 端点缺 `if_reading` 或 `kind` 返回 400 |
| 弹窗渲染 | iid 解析（tag 可空、名字段允许含分隔符）；单项默认展开、集合块列成员；状态行与 notes 原文呈现；文本直接显示、图片与密封推理按事实标注、非文本折叠为原始对象 JSON；读取失败与 409 显示可重试说明 |
| 页面集成 | tile、图例项与内容列表行同为 button 走同一选择动作；`context-detail.js` 进静态白名单；换请求重绘关闭弹窗 |

真实统计核对（生产库快照上对照 magpie 分解）未执行；触屏目标尺寸与像素截图未取得（见下）。

### 浏览器 DOM 验收（合成，2026-10-27）

临时 collector（端口 8771，合成库四笔请求 + 配对 + 七类 parts，生产采集器未动）+ ego lite 逐项断言。像素截图仍不可用：`Page.captureScreenshot` 对该页持续超时（与 2026-10-26 轮一致），视觉项以 DOM 几何与交互断言代替，不代表视觉通过。

| 验收项 | 浏览器实测 |
| --- | --- |
| tile 几何 | req 1 十四个 tile 两两零重叠、零越界（容器 576×240）；aria-label 含名称、tokens、占比与「打开明细」 |
| 图例数值 | 七类 55.1k/47.4k/27.0k/12.0k/8.0k/6.0k/4.0k 与合成 parts 一致 |
| 明细弹窗 | tile/图例/内容列表行三种入口同动作；item 命中对齐显示「片段」并默认展开，未对齐降级列全部结果块并带说明；类级弹窗列承载块与解释规则 note；条目正文经工具结果端点读出，非文本折叠为原始对象；Esc 关闭后焦点回到触发 tile，键盘 Enter 等效 |
| 三态读数 | 高占用 95.0% 出「占满」warn；窗口未知不显示占用率；files 两大一碎并出「其余文件引用 30 项」成员集合块与类级余量块 |
| 主题与窄栏 | 暗色 tile 深底浅字（表面 rgb(16,25,35)）；620px 视口 ResizeObserver 重排（34 → 6 tile） |

## Hermes 用途识别（合成 + 只读生产快照，2026-10-27）

两条 Hermes 旁路指纹随 [Agent Note：Hermes 用途识别](../.agents/notes/implemented/feature/2026-10-27-hermes-purpose-recognition.md) 交付。合成验收进 `bun test`；生产侧只做只读快照，统一截止时点 2026-10-27T05:33:18Z（本机 13:33），没有停采集器、没有写库。

合成部分：`tests/semantics.test.ts`、`tests/request-purpose.test.ts`、`tests/hermes-purpose.test.ts`、`tests/harness-purpose.test.ts`、`tests/web.test.ts` 与三个共享派生测试文件共 112 项通过，`tsc --noEmit` 通过。覆盖审查器与标题指纹的结论、规则 ID、信号与次序，user 内容与非 hermes 标签的反例，真实 Chat system 块的取数结算，以及主请求 A、审查器 R、续写 B 的链关系。

只读快照按 `started_ms <= 截止时点` 统计，只保存聚合值：

| 项 | 生产结果 |
| --- | --- |
| 规模 | 1,242 笔 Hermes 请求，159 个会话键；`conv_source='conv'` 1,186 笔、`'session'` 56 笔 |
| 用途现状（v4） | `unrecognized` 1,029 笔、`missing` 210 笔、`title.reply.v1` 3 笔；尚无 `command-review` 与 `hermes.session-title.v1` 结论 |
| 正文与回复 | `have=1` 且回复缺失 56 笔；`have=6`、正文 `pending` 210 笔；`have=7` 976 笔 |
| 链角色 | `main/confirmed` 447、`branch/confirmed` 381、`main/unknown` 243、`main/first` 112、`main/null` 56、`aux/aux` 3 |
| 空 session 桶 | `['session','']` 下 Hermes 56 笔、curl 1 笔，actor 均为 unknown |
| hook 缺口 | Hermes `miss_reason='hook_absent'` 205 笔；等待队列 605 条，其中 603 条无 response ID |
| 工具 | 924 次调用，resolved 893、pending 31 |

存量 Hermes 行不执行用途重建，按项目所有人的决定直接删除；上面是删除前的只读记录。新流量按 `PURPOSE_VERSION=5` 结算，v5 的真实流量验收要等新代码部署后另行记录。

## 空 session 身份修复与迁移（合成，2026-10-27）

随 [Agent Note：空 session 不是会话身份](../.agents/notes/implemented/bug-fix/2026-10-27-empty-session-identity-migration.md)交付。本轮全部是合成数据，`tests/evidence.test.ts`、`tests/hook.test.ts`、`tests/hook-identity.test.ts`、`tests/maintenance.test.ts` 共 76 项通过，`tsc --noEmit` 通过。真实库上未执行迁移，也没有删除任何行。

| 验收项 | 合成结果 |
| --- | --- |
| 新请求身份 | 空 session 的 hook 请求落 `["hook", hook_id]`、`conv_source='hook'`、`session` 与 `actor` 为 NULL、`actor_state='unknown'`；`raw_hook.session` 仍为空串；不产生派生队列行 |
| 有效 session | 非空 session 的 hook 请求保持 `["session", session]` 与既有 actor |
| 预览 | 五行种子给出 1 个候选与 4 个拒绝（`ownership_attached`、`hook_evidence_ambiguous`、`hook_session_present`、`hook_source_missing`）；`agents` 按桶内分布计数；预览不改库 |
| 命令闸门 | 预览退出 0 且 `applied:false`；`--apply` 缺 `--approval-id` 时退出 1、错误码 `approval_id_required`，不迁移 |
| 执行 | `migrated:1`、`remaining:1`、`conservation.conserved:true`；迁移行 `conv_key` 为 `["hook","hook-a"]`、`session` 与 `actor` 为 NULL、`actor_state='unknown'`、`have` 不变；`SUM(input_revision)` 恰好 +1，无派生队列行 |
| 重复执行 | 第二次 `migrated:0`，`SUM(input_revision)` 不变 |
| 迁移后关联 | 唯一 response ID 到达后按 `mergeHookInto` 合并：源行删除，证据 `merged` 落目标，`request_alias` 记旧 id，目标 `conv_key` 与 `actor` 不被 hook 回退覆盖 |
| helper 回退 | `hookConv('', 'h1')` 与 `hookConv(null, 'h1')` 同为 `["hook","h1"]` |

真实库验证待执行：生产空桶的形状记录在上一节的只读快照里，候选数、拒绝原因分布与守恒对账要在维护窗口跑预览后另行记录。`PURPOSE_VERSION` 升到 5 与本次身份修复是两件事：新流量按 v5 结算，旧 Hermes 行按既定决定删除，不经过迁移。

## hook 投递分层诊断（合成，2026-10-27）

随 [Agent Note：hook 投递分层诊断](../.agents/notes/implemented/feature/2026-10-27-hook-delivery-diagnostics.md)交付。本轮全部是合成数据，`tests/hook-delivery.test.ts`、`tests/hook.test.ts`、`tests/hook-identity.test.ts`、`tests/evidence.test.ts`、`tests/maintenance.test.ts` 共 85 项通过，`tsc --noEmit` 通过。真实流量的窗口对比未执行。

| 验收项 | 合成结果 |
| --- | --- |
| 窗口切分 | 请求按 `started_ms`、回调按 `received_at`、摄入问题按 `observed_at` 落窗；窗口外的行不计入 |
| 缺失分龄 | 以 `--until - HOOK_ABSENT_THRESHOLD_MS` 为界：早于阈值的缺证据行计入 `settled_missing`，晚于阈值的只进 `young_missing` |
| 缺口出口 | 已有账本或路由证据仍缺 hook 的行进 `missing_with_sources`；无 response ID 的行单独计数；等待队列已有候选的行进 `awaiting_candidate`，不再算作投递缺失 |
| 分档计数 | 按 agent、状态码、请求类别与 `prompt_tokens` 分档；未知值保留 `unknown` 档，不并入相邻档 |
| 回调侧 | `raw_hooks` 报总数、`reply_state='absent'` 与正文降级；`pending_hooks` 报队列总数与其无 response ID 条数；`issues` 按来源与原因聚合 |
| 命令闸门 | 缺 `--since`/`--until` 或值非法退出 2；区间倒置退出 1 且错误码 `hook-delivery_failed:invalid_window`；正常窗口退出 0 并输出 JSON |
| 投递码 | 单次超时重试后为 `collector_attempt_timeout`；宿主中止只调用一次并为 `collector_host_abort`；连接失败两次后为 `collector_network_error`；2xx 为 `collector_delivered` 且不留 `collector_status`；非 2xx 为 `collector_http_rejected`，4xx 不重试 |
| 晚到成功 | 接收方 650 ms 后返回 200，即使宿主预算更大，两次尝试仍记 `collector_attempt_timeout`，总耗时不短于一次单次截止 |

插件侧的失败码只存在宿主内存的 `ctx.state` 里，ATC 不读回，因此本轮的窗口统计无法断言某条请求因哪种原因丢投递。真实流量的前后窗口对比、宿主 `gatewayTimeoutMs` 配置实验都未执行；上一节记录的 Hermes 缺口仍是只读快照，不因诊断工具上线而改变含义。

## 按 agent 拆除对话数据（合成，2026-10-27）

随 [Agent Note：按 agent 拆除对话数据](../.agents/notes/implemented/feature/2026-10-27-agent-purge.md)交付。本轮全部是合成数据，`tests/maintenance.test.ts` 新增四项通过，`tsc --noEmit` 通过。真实库上的删除与重启在下一节单独记录。

| 验收项 | 合成结果 |
| --- | --- |
| 预览 | 四笔请求（三笔 hermes）给出 `requests:3`、`conv_keys:2`、`shared_conv_keys:1`、`groups:2`、`groups_with_remaining:1`、证据 2/2/2 与原始层可删计数；预览不改库 |
| 共享桶 | 与 claude 同桶的 hermes 行删除后 claude 行保留；组保留 `group_epoch` 并重新标脏 |
| 独占组 | 只剩未知归属行的组没有队列行；hermes 独占的已知组同步为 clean，`group_epoch` 不变 |
| 跨 agent 守卫 | 被 claude 请求共享的 `raw_ledger`（gen-B/50）与 `raw_hook`（h-shared）保留，对应证据与费用观测不动 |
| 请求侧级联 | 别名、工具链接、块引用、孤儿块、证据、费用观测与指向目标的 `prev_req_id` 一并清掉；共享正文块保留 |
| 来源层 | 目标 `raw_ledger`、`raw_route`、`raw_hook`、`pending_hook`、无引用的 `route_summary`、指向目标的 `bg_job` 与 `otlp_body_ref` 删除 |
| 派生快照 | 被删请求的 `derive_request_result` 行删除 |
| 事件与墓碑 | `retention_event` 记 `purge_agent` / `agent_removal:hermes` / `request_count:3`；`purged_evidence` 恰好六条，按证据键去重 |
| 重复执行 | 第二次 `deleted:0`、`event_id:0`，事件仍为一条，墓碑不增长 |
| 故障回滚 | `DELETE FROM request` 注入触发器中止后，请求、原始层、等待队列、派生快照与队列 epoch 全部保持原样，事件未写 |
| 命令闸门 | 预览退出 0；`--apply` 缺 `--approval-id` 退出 1；缺 `--agent` 退出 2 |
| 结构检查 | `PRAGMA foreign_key_check` 为空，`verify` 的 `dangling_blocks` 为 0 |

## Hermes 历史数据拆除（真实库，2026-10-27）

按[运维手册](operations.md#purge-agent)的顺序在生产库执行：停服务 → 可恢复 bundle 备份到数据目录外的受限目录 → 预览核对 → 单事务删除 → `verify` → 重启。预览与只读探针逐项一致，没有跨 agent 共享的证据键被守卫拦下。

| 项目 | 删除前 | 删除后 |
| --- | --- | --- |
| Hermes 请求 / 会话键 | 1,536 / 241（其中 1 个桶与 curl 共享） | 0 / — |
| 派生组 | 240，全部 clean，无跨 agent 成员 | 无 dirty 组 |
| 证据 | ledger 1,478 · route 1,478 · hook 1,318 | 0 |
| 原始层 | ledger 1,478 · route 1,478 · hook 1,318 | 0 |
| 等待队列 | 58 条 Hermes hook | 0（总数 702 → 644） |
| 路由摘要 | 1,478 | 0 |
| 估算字节 | 46,692,502 | — |
| 墓碑 | — | 4,274 条，按证据键去重 |
| 事件 | — | `purge_agent` · `agent_removal:hermes` · 1,536 笔 · approval `purge-hermes-2026-10-27` |

执行后 `integrity_check` 为 `ok`，`dangling_blocks` 与 `duplicate_evidence` 为 0，`foreign_key_check` 为空。采集器重启后正常接收新请求（请求数从 17,192 增至 17,207），采集问题仍为既有的 4 条 OTLP span 记录，没有新增。
