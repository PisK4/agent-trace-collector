# Agent Note: 证据登记词汇收进 evidence.ts

Status: implemented

## Problem

have 的 1/2/4 位义在 CONTEXT.md 与架构文档有定义，代码里却散用字面量：写入侧五处 `have=have|1/2/4`（hook、账本、路由、投影），读侧 queries 的 SQL `(have & 1)` 与页面的七处位判断。request_evidence 的三条 INSERT 各自拼同样的语句；conv_key 的三种回退前缀散在 hook 与 reconcile 的局部函数里，改写形状等于改派生组身份却没有一处把它当作契约钉住。

## Decision

新增 `src/evidence.ts`（叶子级，只收拢词汇与登记写法）：

- `HAVE_BODY`/`HAVE_LEDGER`/`HAVE_ROUTE` 位常量；SQL 写入片段与 `(have & n)` 读侧片段由同一常量生成，页面按同一份位义在 web 侧声明同名常量。
- `insertEvidenceTx` 统一三条 `INSERT OR IGNORE INTO request_evidence`，merge_state 收成 `'pending' | 'merged'`，hook 的匹配规则收成 `MATCH_BY_RESPONSE_ID`；helper 只执行 INSERT，留在调用方现有事务内。
- 会话键构造收成 `hookConv`/`ledgerConv`/`routeConv`/`sessionRef`，三种回退前缀逐字固定——hook `['hook', id]`、账本 `['request', refKey]`、路由 `['conv', id]`，`conv_source` 参与归属优先级；红线测试逐字断言这些形状。

是否把 HTTP 接口的 have 改成语义字段是独立决定，本决策不做前置，页面继续按位义消费数字。

## Alternatives considered

**把登记并进 hook 的 ingestSource 统一入口。** 三路合并没有共同输入，已被[来源摄入单元](../../implemented/architecture/2026-10-24-source-ingest-unit.md)否决；本决策只收拢登记写法，不动入口与事务边界。

**conv_key 前缀统一成一个前缀。** 三种回退各自记录「这条组键从哪来」，`conv_source` 的归属优先级依赖这个区分；统一前缀等于改派生组身份，会重判全部历史。

## Consequences

改共享词义（位义、回退形状、匹配规则）有唯一位置；新增摄入通道仍需实现自己的摄入、存储与展示，不能承诺只改一个文件。重排或改写回退前缀会先撞上红线测试。`tests/fixtures.ts` 的种子约定（组键写成 JSON 数组）与本 helper 共享同一形状契约。

## Testing

- 红线测试：三种回退前缀逐字断言；登记幂等（重复登记不产生第二行，merge_state 保持首写值）。
- `bun test` 595 例全过（39 文件），`bun run typecheck` 通过（2026-10-24）。
