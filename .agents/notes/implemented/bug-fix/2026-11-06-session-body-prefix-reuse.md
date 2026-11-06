# Agent Note: 会话正文按前缀复用块引用

Status: implemented

## Problem

首页读取路径的 5 秒超时在 [首页超时中的重复宽表读取](2026-11-06-homepage-timeout-query-scans.md) 修复后仍有残留。2026-11-06 的实测把归因从"列表查询"挪到了主线程占用：

- 生产库只读连接上 `listSessions` 两阶段 SQL 合计约 15ms，不是超时来源。
- 60 轮并发探针（同期发 `/api/sessions`、`/api/metrics`、`/api/stats`）里唯一一次慢轮把三个端点一起拖到 1249–1471ms；`/api/metrics` 几乎不做 SQL，说明是全局事件循环阻塞。
- 进程 94 分钟内 `writer.claude` 事务累计 148.5s（约 27.6% 墙钟），单笔最大 4.46s；慢轮所在 5 秒窗口内该事务总时长增加 4928ms。
- 合成复现（4,500 行历史 26MB + 100 行新数据、51 笔调用）单文件事务约 1.97s，其中重放 parse+apply 只有 56ms；大头在 `persistBodyTx`：每笔调用都把整份 `requestMessages` 重新序列化、逐条 sha256、查块并插入 `request_block`，成本是 O(调用数 × 历史消息数)。

同一会话的相邻调用天然共享一长段消息前缀（适配器把同一批消息对象追加进新数组），前缀块的字节完全相同；逐条重算与重插只是重复劳动。

## Decision

- `persistBodyTx` 增加可选的 `BodyPrefix`（同一次写入事务里上一笔请求的 `reqId` 与消息数组快照）。
- 仅当新请求的消息数组与快照按**对象同一性**共享前缀时，用一条 `INSERT INTO request_block ... SELECT` 复制前缀引用，只对新增尾部执行原有的序列化、哈希与插入。
- `body_bytes` 改为对 `request_block` 做一次 `DISTINCT` 聚合，保持"共享块只在本请求计一次"的原语义。
- `src/sources/session/ingest.ts` 在单批内按 `convKey` 维护快照；正文被原地刷新时丢弃快照；跨事务一律不复用（引用行是否仍在不做假设）。

## Alternatives considered

- 跨批缓存重放状态：Claude 的 `state.messages` 持有整段会话内容，常驻缓存会让内存随会话体积线性增长。
- 把正文写入移出事务或异步化：不消除生成正文的 O(n) CPU，还破坏"块、引用、状态必须一起提交"的既有不变量。
- 按字节截断 `requestMessages`：改变正文可还原语义，且会让派生输入不完整。
- 调小回填文件批次：只是把一次 5 秒阻塞摊成多次 1 秒，并拖慢回填，不解决重复写入本身。

## Verification

- 合成前后对比，同一输入重复 3 次：单文件事务 1656 / 1614 / 1609ms → 217 / 220 / 216ms；其中重放 parse+apply 约 40ms，未随优化变化。
- 等价性测试（`tests/body.test.ts`）：复用写入的请求与完整写入的请求在 `request_block` 行、`msg_count`、`body_bytes`、`parse_state`、`reply_state` 上逐项相等，`restoreBody` 还原一致，`block` 表不新增重复块。
- `bun run typecheck` 通过；body 相关 26 个测试、会话摄入相关 28 个测试通过。
- 生产复测：部署后同一探针与 `writer.claude` 占用见部署记录；若与上述量级不符，以部署后实测为准。

## Consequences

- 收益：同批相邻调用从每笔 O(历史消息数) 降到 O(新增消息数)，主线程占用随调用数下降，读取路径排队时间同步缩短。
- 代价：正确性依赖"同一批内前缀消息对象不被原地修改"；正文刷新路径显式丢弃快照作为兜底。
- 边界：每批第一笔仍要付一次完整写入；若适配器改为每次新建消息对象，复用自动退化为完整路径——不会写错，只是不再加速。
