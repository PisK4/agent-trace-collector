# Agent Note: HTTP 契约小修：URI 解码 400、写失败固定枚举与安全整数区间（F20/F21/F41/F44）

Status: implemented

## Problem

2026-11-04 巡查清单（[open-bug-findings](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)）归入「HTTP 契约小修」的四条，都在 `src/http.ts` / `src/protocols.ts` 的同一批对外边界上：

- F20：畸形百分号编码（`/api/sessions/a%zz/requests`）在路径解码处抛 URIError，被统一 catch 兜成 500 `internal_error`，客户端错误污染 5xx 指标。
- F21：hook 与 OTLP 的写失败 catch 把 `error.message` 原文放进响应体 `code`，一旦触发会外泄 `UNIQUE constraint failed: 表.列` 这类内部结构（当时未触发）。
- F41：`parseIndex` 只查 `/^\d+$/`，`bodyRangeError` 用 `Number.isInteger`——`from=1e20` 时 `from+40===from`，区间校验通过，返回 200 的 `from=to` 零宽伪完整页；批读 item 的 `id` 却要求 `Number.isSafeInteger`，同一份参数规则不自洽。
- F44：写失败 catch 只认字符串恰好等于 `disk_full` 的错误映射 507；真实 SQLite 写满是 `code:"SQLITE_FULL"`、`message:"database or disk is full"`，落进 503 `writer_failed`，两个入口的容量错误契约不一致。

## Decision

四条同批落地，只改 `src/http.ts` 与 `src/protocols.ts`：

- **F20**：新增 `decodeParam` 助手，7 个路径参数解码点统一收口；解码失败抛 `QueryInputError('invalid_path_param')`，复用既有的 QueryInputError → 400 通道，码名 `invalid_path_param`。统一 catch 里另加一行 `instanceof URIError` 分支同样映射 400，保证助手之外的 URIError 也不会被 500 分支吞掉。
- **F21**：两处写失败 catch 的响应 `code` 换成固定枚举 `write_failed`；`error:'writer_failed'` 字段保持不变，按 error 字段判断的客户端不受影响。原始错误对象改走 `diagnostics.error('hook.write' | 'otlp.write', { code: error })`；monitoring 层的 `errorCode` 分类器把自由文本归为 `unclassified`、固定 snake_case 码原样保留，所以结构化日志里只出现错误分类，不出现 SQL 文本——沿用「不把路径、SQL 或正文带进日志」的监控纪律，不新开日志机制。两个 ingest handler 因此各加一个 `diagnostics?: DiagnosticLog` 参数，由 `createHandler` 透传。
- **F41**：`parseIndex` 在 `/^\d+$/` 与 `Number()` 之后要求 `Number.isSafeInteger`，否则抛 `QueryInputError('invalid_body_range')`；`bodyRangeError` 的整数检查换成 `Number.isSafeInteger`。批读端点的 `from/to` 经 `parseBatchRanges` 走同一条 `bodyRangeError`，与 item `id` 的安全整数要求对齐。`from > total` 仍按契约返回空页；`from` 是安全整数但 `from+PAGE_MAX` 越过 2^53 时（如 `from=2^53-1` 缺省 `to`），默认上界无法精确表示，直接 400，不用浮点坍缩值拼一个看似合法的窗口。
- **F44**：新增 `isDiskFull` 判定：`message === 'disk_full'`（准入闸门抛的字符串）或 `code === 'SQLITE_FULL'`（真实 SQLite 写满）都映射 507 `{error:'insufficient_storage'}`，响应体与准入闸门暂停档同形、不带 `code` 字段；hook 与 OTLP 两个入口用同一助手。其余写失败维持 503 `writer_failed`。

## Testing

- `tests/http.test.ts`：畸形 `%zz` 路径参数在五个会话端点返回 400 `invalid_path_param`（F20）；`from/to` 超过 2^53 返回 400 `invalid_body_range` 且合法安全整数区间仍 200，批读非法区间循环补 `1e20` 项（F41）；broken store 注入三种写失败——SQLITE_FULL 与 disk_full 同为 507、其余 503 且响应体与结构化日志都不含原始文本、metrics 按固定原因计数（F21/F44）。
- `tests/otlp-http.test.ts`：OTLP traces 入口在真实 SQLITE_FULL 写失败下同样 507 `{error:'insufficient_storage'}` 且不落行（F44）。

## Alternatives considered

- **只在统一 catch 加 URIError 分支，不收口解码点。** 两处都做了，但只靠 catch 分支会让七处解码继续把客户端错误混进异常路径，行为依赖 catch 顺序；助手收口后解码失败在调用点就是明确的 QueryInputError，catch 分支退化为防线。
- **把 SQLITE_READONLY 并入 507。** 否决。F43（只读挂载是否算支持场景）尚未拍板；并进 507 会把只读状态下的写失败从「可重试的 503」变成「容量错误 507」，改变客户端重试语义，而只读挂载下重试注定无意义，报 507 反而掩盖真实原因。重新引入条件：F43 拍板只读挂载为支持场景并确定客户端重试策略后，把 `SQLITE_READONLY` 加进 `isDiskFull`（或按诊断另立映射），与 F43 的启动降级一起交付。
- **把原始 error.message 写进结构化日志。** 否决。清单建议「原文只进结构化日志」，但 monitoring 层的既有纪律是固定错误码、自由文本一律 `unclassified`（与 F19「日志不带源码栈与绝对路径」同源）。沿用纪律意味着原文哪里都不出现；诊断靠 `op='hook.write'`/`'otlp.write'` 的错误条目与 `insufficient_storage`/`writer_failed` 计数。若未来确需原文，应作为一次显式推翻监控纪律的独立决策，不混进本批。
- **507 响应体带固定 `code` 枚举。** 否决。准入闸门暂停档的既有响应体是 `{error:'insufficient_storage'}`，两个来源保持同形，客户端只按 error 字段与状态码判断。

## Consequences

- 畸形百分号编码不再计入 5xx 指标与告警；`invalid_path_param` 成为新的对外 400 码。
- 写失败响应体不再可能携带内部错误文本；`writer_failed.code` 的取值从任意 message 收窄为固定枚举 `write_failed`，依赖原文做分支的客户端（当前无已知消费方）需要改按枚举判断。
- 容量写满在「准入检查之后、提交之前」的窄窗口里也返回 507，客户端据此停止重试；SQLITE_FULL 从可重试的 503 变为明确的容量错误，重试压力不再打回服务。
- 超过 2^53 的分页偏移从 200 零宽伪完整页变为 400；`from=2^53-1` 且缺省 `to` 的极端请求也从（伪）200 变 400。安全整数范围内的分页行为不变。
- 两个 ingest handler 各多一个可选参数；diagnostics 未注入时（部分测试直连）写失败只走响应与计数、不记日志，响应契约与注入路径一致。
