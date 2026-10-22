# Agent Note: hook 拒绝按固定原因计数并走读取认证

Status: implemented

## Problem

`/hook/ingest` 的拒绝分支各自返回错误码，但进程内没有计数，容量基线无法回答"被拒了多少、因为什么"。若把拒绝原因写成自由文本，请求头、来源字符串与被拒正文的片段会跟着进入观测数据；若统计入口使用 hook 令牌，插件凭据就获得了读取统计的能力。

## Decision

每条拒绝分支在返回前调用 `IngestMetrics.reject`，只接受固定 `REJECT_REASONS` 枚举；成功接收记录 `accept`，带重复标记与声明的请求/回复字节数。原因码之外的字符串直接抛 `invalid_reject_reason`，不截断、不改写成近似值。

`createHandler` 接受可选的 `CapacityMetrics`。未注入时仍用本地 `createIngestMetrics()` 保留 hook 计数，但不开放读取入口：`GET /api/ingest-metrics` 与页面读取共用 `checkAccess`，只接受读取令牌或同源导航，未注入观测运行时返回 404 `metrics_unavailable`。`startCollector` 在存储打开后创建观测运行时并启动事件循环采样，`stop` 在关闭数据库前停止采样。

## Alternatives considered

**只按 HTTP 状态计数。** 401、403 与 507 都可能是不同原因，按状态归组会把认证失败、来源拒绝与磁盘不足混成一类。

**把拒绝正文或错误文本写进日志。** 观测入口会变成第二份正文存储，也避开不了脱敏与保留期规则。

**让插件用 hook 令牌读统计。** hook 令牌只应能写入；读取统计走读取认证，凭据边界不因观测放宽。

**统计失败时返回空对象。** 空对象会被读成"没有拒绝"，掩盖观测未接入；404 明确说明入口未启用。

## Consequences

- 拒绝原因只能取固定枚举，新增分支必须同时扩展枚举与测试，否则运行期直接抛错。
- 计数只在进程内，重启归零；报告用 `started_at_ms` 与 `uptime_ms` 说明边界，不跨重启合并。
- `accept` 的字节数取 envelope 的声明值，不是实际落库字节；报告需要与存储快照分开读。
- 未注入 `CapacityMetrics` 的测试与调用方仍能正常拒绝请求，只是无法读取统计。

## Testing

`bun test tests/http.test.ts tests/capacity.test.ts`：四个拒绝分支各计一次且快照不含正文标记、拒绝请求不落库；统计入口未认证返回 401，认证后返回 `started_at_ms`、`writer` 与 `event_loop`。另由 `bun run typecheck` 检查可选参数没有破坏既有四参数调用。
