# Agent Note: 派生公平调度与 OTLP 巡查产出核对

Status: implemented

## Problem

F23 的 `attempts` / `last_error` 已经落地，但同步派生候选仍按 `conv_key` 排序：常驻失败的组排在最前，每轮都被选中并让整轮上抛，后面的健康组永远轮不到。失败记录存在，调度却没有用它。

F37 把已登记服务里的非 LLM span 静默 `continue`，结果对象没有 `skipped` 计数。巡查一侧拿全历史 `request_evidence` 当分子、按全 `raw_otlp_span` 算产出比，并用 `body_ref` 为 0 单独报警：内部 span 与本来不写正文的来源因此被误报，真正遗漏的 LLM span 又被 99.9% 的分母稀释。分子与分母的生命周期不同，读数无法对账。

## Decision

同步派生候选（[unit.ts](../../../../src/derive/unit.ts)）按 `last_error IS NOT NULL, attempts, last_completed_ms, conv_key, actor` 排序。健康组永远先于失败组；全部失败时按认领次数与最后完成时间轮转。失败仍在本轮上抛让日志可见；不丢弃组、不新增 schema、不加常驻状态，新输入到达后照常重试。

OTLP traces（[ingest.ts](../../../../src/sources/otlp/ingest.ts)）的 `AcceptOtlpTracesResult` 增加 `skipped`，在已登记服务的非 LLM 分支计数。原始层照旧落盘；它只用于观测，不进入 HTTP 拒收口径，响应保持规范的 `{"partialSuccess":{}}`。

巡查（[patrol.ts](../../../../scripts/patrol.ts)）的 span 与证据都限定在 raw 的 7 天保留窗内；分子改成窗口内 raw span 按 `(trace_id, span_id)` 物理身份 JOIN 到的证据，TTL 后的长期证据不算。分母改成 `classifySpan` 认出的 LLM span，分类直接复用 [mapping.ts](../../../../src/sources/otlp/mapping.ts)，巡查不另抄服务清单或形状键。`otlp_yield` 只在 LLM span 达到 10 条、匹配率低于 99% 时越界；`body_ref` 为 0 不再触发越界，内部 span 与不写正文的来源只在 detail 里出现。未知形状继续由 `otlp_issues` 的近 7 日 issue 计数负责。巡查的落点与阈值位置仍归[巡查程序](../process/2026-11-04-patrol-routine.md)。

## Testing

- [derive-unit.test.ts](../../../../tests/derive-unit.test.ts)：常驻失败组不阻塞健康组；全部失败时两组都拿到 attempts；失败组收到新输入后完成。
- [otlp-ingest.test.ts](../../../../tests/otlp-ingest.test.ts)、[otlp-http.test.ts](../../../../tests/otlp-http.test.ts)：内部 `fs.read_file` span 落 raw、`skipped=1`、不建请求不记 issue，HTTP 仍 200 与空 `partialSuccess`。
- [patrol.test.ts](../../../../tests/patrol.test.ts)：纯内部 span 与无正文来源不越界；窗口内 10 条遗漏 LLM span 越界，身份匹配后放行；窗口外旧证据与没有对应 raw 的长期证据不进分子。F20/F41 的旧返回码必须记越界；该回归在旧巡查上失败，删除基线豁免后通过。

## Alternatives considered

- **永久失败判据落地后直接丢弃组**：没有可复现的永久失败组时就丢弃会静默少算；先保留记录与轮转。
- **另加常驻 round-robin 游标**：需要写库或进程状态，重启后失真；现有列足够做公平排序。
- **把 skipped 写进 HTTP `rejectedSpans`**：非 LLM 内部 span 不是拒收，写进去会误导上游重投。
- **巡查继续用全历史证据比全 span**：分子分母生命周期不同，TTL 越久越容易假绿或假红。
- **巡查按静态服务清单判断应识别 span**：会与 mapping 漂移；直接调用 `classifySpan`。
- **非 LLM span 不落 raw 或直接采样**：会失去事后判断规则漏识别的唯一证据，先补计数再谈保留策略。

## Consequences

- 生产上 `otlp_yield` 会按新的 LLM 分母继续报越界：窗口内 16 条 LLM span、1 条证据，覆盖率 6.25%，属于 F37 的原有缺口，不是本次引入。
- 巡查每周会解析保留窗内的 raw span 属性 JSON（本机约 80 MB），仍是一次只读周任务，没有新增在线扫描。
- 分类使用当前 mapping 版本；跨 mapping 升级的窗口内旧 raw 可能被重新分类，读数要结合 `OTLP_MAPPING_VERSION` 看。
- 切片派生路径（`store.deriveRuntime`）的调度没有改动，本次只修同步候选查询。
- 认领会清空 `last_error`；进程在认领与失败回写之间崩溃的组会被当作健康组重试一次，这是可接受的代价。
