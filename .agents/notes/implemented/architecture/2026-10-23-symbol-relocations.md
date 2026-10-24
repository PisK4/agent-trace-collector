# Agent Note: 五个放错层的符号归位

Status: implemented

## Problem

模块间出现了五处下层 import 上层的倒挂：`store.ts` 为 `Store.deriveRuntime` 的类型 import 切片实现（`derive-slice` 同时 import `Store`，形成双向）；`config.ts` 为一个可选字段 import 切片实现；`body.ts`（摄入层）从读模型 `queries.ts` 拿别名解析；`protocols.ts`（协议适配）从读模型拿 `BodyState` 两词的联合类型；`reconcile.ts`（在线摄入热路径）为四行的墓碑查询 import 离线维护模块，而后者拖着整台派生引擎。依赖方向成了网：任何一层的重构都可能被迫牵动不相干的一层。

## Decision

每个符号移回它的概念层，四处小规模的移动加上删除一个包装函数：

- `DeriveBudget`、`DEFAULT_DERIVE_BUDGET`、`SliceRuntime` 移到 `config.ts`：预算与运行模式是配置词汇，`Config.deriveBudget`、`store.deriveRuntime` 与切片引擎从同一处导入类型；容量脚本的预算文件键映射（`capacity-gate.ts`）跟着改 import，`SnakeCase` 类型映射不受影响。
- `resolveRequestId` 移到 `store.ts`：`request_alias` 是 schema 层的表，别名读写统一归存储层。`hook.ts` 的写入与 `queries.ts`/`http.ts` 的读取此前分在两层，这个分裂随这次移动消失。
- `BodyState` 类型移到 `store.ts`：正文状态是 schema 词汇，`protocols.ts` 与 `queries.ts` 改从存储层取。
- `isPurgedEvidence` 移到 `sources/raw.ts`：`purged_evidence` 是 raw 层的墓碑表，在线热路径每行都要问一次，判定放在 raw 层；`maintenance.ts` 保留 `purgeMetadata` 的墓碑写入。
- `loadBoundSalt` 包装函数删除：它存在的唯一理由是把 `Store` 类型带进 `config.ts`。调用方（`main.ts` 与三个测试文件）直接 `store.write(db => loadBoundSaltTx(db, dir))`，`config.ts` 变成不依赖仓库内其他模块的叶子。

## Alternatives considered

**在 store.ts 里内联声明 runtime 槽位的结构类型。** 不新增依赖，但七个预算字段失去键名检查，容量预算文件的类型映射（`keyof DeriveBudget`）也要另起一份手写清单，等于为省一个 import 重新引入一种漂移。

**把 runtime 类型放进 store.ts。** store 是存储基底，不该认识「派生按哪条路径跑」的业务词汇；`config.ts` 已经持有 `intervals` 这类运行期配置，模式与预算放在它那里更顺。

**保留 `loadBoundSalt` 包装、维持 config→store 的类型依赖。** 双向 type-only cycle 在 TS 里合法，但它正是本轮要消灭的形状。下次有人给 config 加字段时，还得重新论证一遍方向。

## Consequences

- 依赖方向恢复单向：config（叶子）← store ← 引擎与读模型；热路径不再拖离线维护模块。
- `loadBoundSalt` 的调用方多一层 `store.write`。三个测试文件的写法同步更新。
- `BodyState` 的对外消费方（`tests/reader-types.ts` 的类型探针）改从 `store` 取；读模型的 JSON 契约不变。
