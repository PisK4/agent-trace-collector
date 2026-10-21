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

## 文档

- [项目文档索引](docs/README.md)
- [架构设计](docs/architecture-design.md)
- [持久化与真实页面](docs/superpowers/plans/2026-10-20-collector-foundation.md)
- [正文与关联派生](docs/superpowers/plans/2026-10-20-collector-body.md)
- [保留恢复与切换](docs/superpowers/plans/2026-10-20-collector-retention.md)
