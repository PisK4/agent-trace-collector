# Demo 与阅读页

`prototypes/` 不提供第二套阅读界面。两个入口都加载生产页 [`web/index.html`](../web/index.html) 及其模块，布局、交互与阅读协议只由 `web/` 和 collector 的 GET 接口决定。原型目录保留的是数据来源，不是界面副本。

## 合成数据

```sh
bun prototypes/synthetic-server.ts
```

打开 `http://127.0.0.1:8770/?session=conv-synthetic-reading`；根路径 `/` 按生产顺序列出三个会话。服务只监听回环地址，不连接真实库、不读取令牌、不启动 collector，返回与生产读取接口同形的合成响应。

三个会话覆盖不同状态：

- **空状态排查**：19 笔请求，含 HTTP 500 但输入与回复保留、Chat `length` 与 Anthropic `max_tokens` 截断、未知停止原因、辅助请求、分支、工具结果已配对未读取、pending、ambiguous、同名工具、能力五态、路由 absent/expired、两次尝试链、prompt 构成与 45 条消息的结构分页样本。
- **窗口分页**：52 笔简单请求，默认 30 笔窗口保留更早历史，可以连续向前加载。
- **缺少通道**：2 笔请求，第一笔缺正文、路由与用量，第二笔恢复，用来读缺正文标记与身份完整性异常。

合成数据是场景样本，不参与生产验收；接口字段与生产类型在同一次 `bun run typecheck` 里检查，字段改名会在类型检查时暴露。

## 本机真实数据

```sh
bun prototypes/serve-local.ts
```

collector 需按 [`loadConfig`](../src/config.ts) 的默认端口与数据目录运行。服务把 `/api/` 的 GET 请求原样转发给 collector，附带数据目录里的只读令牌；页面与接口都直接使用生产实现，没有另一份 SQL 或响应拼装。collector 不可达时返回 503。

打开 `http://127.0.0.1:8768/`。页面支持的 `?session=`、`?trace=`、`?tab=` 参数与生产页面一致。

服务只监听 `127.0.0.1`，检查 Host、Origin 与请求方法。令牌留在服务进程，真实正文只按需返回本机浏览器；不生成数据快照、fixture 或日志。

## 边界

生产界面改动不需要同步 `prototypes/`：两个入口加载的是同一份 `web/` 文件。合成数据只补状态样本；新增界面状态若缺样本，Demo 少一个可看场景，不会出现第二套实现走偏。本机真实数据入口没有数据副本，接口契约完全由 collector 决定。

## 参考

[架构设计](../docs/architecture-design.md)、[Demo 复用生产页面的决策](../.agents/notes/implemented/process/2026-10-24-demo-reuses-production-page.md)。
