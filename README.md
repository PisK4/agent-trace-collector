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

## 文档

- [项目文档索引](docs/README.md)
- [架构设计](docs/architecture-design.md)
- [持久化与真实页面](docs/superpowers/plans/2026-10-20-collector-foundation.md)
- [正文与关联派生](docs/superpowers/plans/2026-10-20-collector-body.md)
- [保留恢复与切换](docs/superpowers/plans/2026-10-20-collector-retention.md)
