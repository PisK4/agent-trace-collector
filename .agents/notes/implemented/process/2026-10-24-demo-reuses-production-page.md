# Agent Note: Demo 复用生产页面

Status: implemented

## Problem

`prototypes/` 曾同时维护一份独立页面、一个本地数据适配器和一套手写合成 API。生产 `web/` 改了几轮之后，原型页面仍停在旧的行结构与旧交互；合成服务也没有映射新页面需要的模块，页面直接加载失败。Demo 的职责是让人读到各种请求状态，不是再维护一套阅读界面。每多一份界面副本，生产每次改版都要同步一次，漏一处就出现两套行为。

## Decision

Demo 不再拥有界面。`prototypes/synthetic-server.ts` 与 `prototypes/serve-local.ts` 都只提供数据，静态请求按路径直接读取 `web/` 目录，由 `prototypes/static-web.ts` 统一返回；生产新增或改名模块不需要同步 Demo。旧的原型 HTML 与 `local-data.js` 删除，旧路径仍返回生产页面。

两个数据源分工：

- 合成服务在 `127.0.0.1:8770` 返回与生产读取接口同形的场景数据，不连真实库、不读令牌。响应对象按生产类型检查，`prototypes/**/*.ts` 进入 `tsconfig`，字段改名会在 `bun run typecheck` 时失败。
- 本机真实数据入口在 `127.0.0.1:8768`，把 `/api/` GET 原样转给 collector，带数据目录里的只读令牌。没有第二份 SQL、窗口查询或响应拼装。

## Alternatives considered

**继续同步原型界面。** 这是这次返工的直接来源。生产页面每改一次布局、缓存或阅读协议，原型都要再实现一遍；Demo 的验证价值建立在自己那份实现上，越同步越像第二个前端。

**把生产 HTML 复制到 `prototypes/`。** 复制当下能对齐，之后仍然分叉；模块、CSP 与 URL 参数还要逐项跟上，维护成本只是从改写变成比对。

**用真实 SQLite 种子库驱动生产 HTTP handler。** 这样接口与存储都只有生产实现，但为了覆盖 pending、ambiguous、partial、attempt 链与结构缺口，种子要直接写请求、正文、派生组、工具配对与路由摘要，相当于把存储 schema 再抄一遍；Demo 仍是合成数据，只是把重复面从读取契约挪到存储 schema。当前选择把重复面限制在一个响应模块，并由类型检查兜底。

## Consequences

生产界面改动不需要同步 `prototypes/`；合成场景只在需要展示新状态时补数据，缺样本不会让 Demo 变成另一套实现。读取接口字段变化会先让 `bun run typecheck` 失败，而不是等页面运行时报错。本机真实数据入口没有契约副本，collector 返回什么，Demo 就显示什么。

合成场景仍然不是生产验收：它证明页面能读这些状态，不证明真实流量、派生或存储行为正确。原型的版式比较结论留在[单一轨迹原型](../../archived/feature/2026-10-23-single-timeline-prototype.md)、[本机读取原型](../../archived/feature/2026-10-23-local-trace-prototype-reader.md)与[原型阅读状态](../../archived/feature/2026-10-24-prototype-reading-states.md)，那些记录继续拥有原型范围与验证限制；生产阅读方式见[单一轨迹生产阅读](../architecture/2026-10-23-single-timeline-production-reader.md)。
