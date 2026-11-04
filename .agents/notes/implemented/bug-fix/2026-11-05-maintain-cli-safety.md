# Agent Note: 维护 CLI 的输入门与退出码口径

Status: implemented

## Problem

2026-11-04 的系统巡查在维护 CLI 上查出四个输入与失败口径缺口（[缺陷清单](../../proposed/bug-fix/2026-11-04-open-bug-findings.md) F35/F34/F32/F08）：

- `purge-metadata --before` 只做 `YYYY-MM-DD` 形状正则，不校验日历也没有上界；删除谓词是字符串比较 `day < ?`，`--before 2027-01-01` 或 `2026-13-01` 会把当时全库 77,417 行全部命中，`--apply --approval-id` 一过就删。
- `maintain verify` 无论 `integrity`、悬空块、重复证据是什么都输出 `ok:true`、退出 0；以退出码或 `ok` 字段判定的自动化会把损坏库当成通过。
- `hook-delivery` 的日期简写走 `Date.parse`，纯日期按 UTC 零点解析，而 `day` 列与页面按本地日；Asia/Shanghai 下窗口整体偏 8 小时，漏掉本地日的前 8 小时、带入次日的前 8 小时。
- 装监控、换机器、数据目录指向旧库时，没有启动前的 schema 兼容预检；不兼容要等服务启动失败才暴露，浪费一次停服窗口。

`purge-metadata` 的预览与 `--approval-id` 门来自[维护锁与备份探测](../process/2026-10-20-maintenance-lock-and-backup-probe.md)，本篇在它之上补输入侧的门，不反转原有语义。

## Decision

### purge-metadata 的日期门与全库放行

`--before` 在 CLI 解析层过三道门：`YYYY-MM-DD` 形状、日历合法性、不得晚于今天的本地日。日历校验用字段回读（构造后 `getUTCFullYear/Month/Date` 必须与输入一致），`2026-02-31` 这类会被 `Date` 构造静默滚到 3 月的输入直接拒绝，报 `invalid_before`，退出 2；未来日报 `before_after_today`，同样退出 2。删除谓词永远见不到非法输入。

全库命中要求显式放行：预览后若命中数等于 `request` 全表行数且大于 0，`--apply` 必须再带 `--allow-all`，否则输出 `ok:false`、`error: allow_all_required` 并退出 1，拒绝输出里带预览计数。`--approval-id` 的语义不动，仍是执行授权；`--allow-all` 表达的是「这个范围我确认要删」。预览（不带 `--apply`）不受门限制，命中全库也照常计数。`purgeMetadata` 与删除主干 `purgeTargetsTx` 零改动。

### verify 的健康口径

`verifyDatabase` 只产报告，健康结论长在 CLI：`integrity` 恰为 `['ok']`、`dangling_blocks` 与 `duplicate_evidence` 都是 0 才输出 `ok:true`、退出 0；任一不满足输出 `ok:false`、退出 1。`pending_derivations` 保持信息字段，不参与判定——停机前有积压是正常形态，把它算进失败会让每次停服都报错。损坏的库在 `verifyDatabase` 阶段抛错，经 CLI 的失败路径报 `verify_failed:<原因>`、退出 1。

### hook-delivery 的日期简写按本地日解析

`momentFlag` 给 `YYYY-MM-DD` 简写加了一个分支：显式按本地时区构造零点（`new Date(y, m-1, d)`），不再走 `Date.parse` 对纯日期的 UTC 口径；复用 `isCalendarDay`，`2026-02-31` 这类会被 `Date` 静默滚月的简写按用法错误（退出 2）拒绝。epoch 毫秒与完整 ISO 的解析路径不动；带时区偏移的 ISO 在 Asia/Shanghai 下与简写现在给出同一条边界。窗口端点的既有校验（缺端点退出 2、倒置区间报 `invalid_window`）来自[hook 投递分层诊断](../feature/2026-10-27-hook-delivery-diagnostics.md)，本批只改简写的解析口径。解析结果本就经 `window.since_ms` / `until_ms` 回显，运维核对以这个字段为准。`delivery.ts`、`day` 列与 `localDay` 都没动。

### precheck 作为独立只读子命令

新增 `maintain precheck --db <path>`：只读打开目标库，读 `PRAGMA user_version` 与表数，与代码侧版本对比，输出 `in_place` / `rebuild_required` / `unsupported` 三态之一加 `db_version` / `code_version`，不可迁移的两态以退出 1 拒绝。判据与 [store.ts 的 migrate](../../../../src/store.ts) 对齐：当前版本、v6 起有原地升级路径的旧版本与待新建的空库都算 `in_place`；更早版本需重建；带表但版本为 0 与高于代码的版本不支持。「旧库没有升级路径」的语义来自[旧库删除重建](../architecture/2026-10-23-destructive-schema-replacement.md)，precheck 只是把同一套判据提前到只读场景。不取维护锁、不做任何迁移写入，用例断言 v11 库预检后 `user_version` 原样保留。

代码侧版本是 verify.ts 里的 `CODE_SCHEMA_VERSION`，未从 store.ts 导出 `SCHEMA_VERSION`：那个常量目前没有第二个消费方，为一次预检扩大 store 的导出面不值得，出现第二个需要它的模块时再晋升导出。漂移由测试钉住——新装 fixture 断言 `db_version: 12 === code_version`，store 升版而这里没跟时该断言先报红。`bun run verify-cutover` 是 collector 与 AVA 前身库的正文覆盖对比工具，与预检无关，未动。

## Testing

`tests/maintenance.test.ts` 新增 CLI 用例：非法日历（`2026-13-01`、`2026-02-31`、`2026-1-01`）与未来日退出 2，库未被改动；部分命中 `--apply` 不需要 `--allow-all`；全库命中拒绝、带 `--allow-all` 后删除数与预览一致。verify 的退出码用例：只有派生积压仍 `ok:true`、退出 0；悬空块 `ok:false`、退出 1；损坏的库经 CLI 退出 1。日期窗口用例：epoch 与带偏移的完整 ISO 原样直通；简写解析由子进程用 `TZ=Asia/Shanghai` 钉住，断言窗口端点等于本地零点（1_793_721_600_000 / 1_793_808_000_000，UTC 口径各多 8 小时）——Bun 不认运行时改 `process.env.TZ`，进程内断言只能证同构，钉时区必须独立进程；非法简写按用法拒绝。precheck 用例覆盖 v12/v11 放行（含 user_version 不变的只读断言）、v5 重建、v13 与带表空版本拒绝、空文件放行、损坏文件报 `precheck_failed`。全部合成数据。

## Alternatives considered

**F35 只靠预览让人发现全量命中。** 预览确实把 `requests` 显示为全量，但自动化或赶时间的操作员会直接接 `--apply`；输入侧拒绝把错误挡在删除谓词之前，预览留给人核对，不承担拦截。落选。

**F34 把 `pending_derivations` 也判失败。** 退出码全红的 verify 看起来最严格，但停机前队列有积压是正常形态，每次停服都会误报；「完整性/悬空/重复」与「队列积压」是两类事实，前者定健康，后者只是信息。落选。

**F32 把 `day` 列改成 UTC 日期。** 能统一 CLI 与列的口径，但要迁移全部历史 `day`、页面日期整体偏移，还牵动按 `day` 聚合的既有查询；`day` 的本地日语义是 [format.ts](../../../../src/format.ts) 的明确定位，客户端入参解析对齐它改动面最小。落选。

**F08 并入 `maintain verify`。** verify 回答「这份库健康吗」，precheck 回答「这份库这份代码能不能直接启动」；后者在版本不支持时要把库判成拒绝服务，混进 verify 会让完整性体检在旧版本库上整个失效（integrity_check 本可以在旧结构上照跑）。两个问题的时间点也不同：precheck 在部署前、服务未启，verify 在停服窗口内。落选。

**F08 另开 verify-restore 命令。** 把预检挂到恢复路径只覆盖「从 bundle 恢复」一个场景；换机器、回滚代码、数据目录指向旧库都不经过 restore，照样要等服务启动失败才发现不兼容。独立 precheck 对任何路径都可用，恢复场景对恢复产物跑同一条命令即可。落选。

## Consequences

未来日期不能再用于预清理（例如提前导入的数据要按未来日截断）；真有这个需求时加显式旗标，而不是放开上界。`--before` 等于今天仍允许，「删今天之前」的语义不变，命中是否全库由计数门兜底。校验只长在 CLI 入口，直接调 `purgeMetadata` 的代码路径（目前只有 CLI 与测试）不受保护。

verify 的 `ok` 字段语义从「命令执行成功」变为「库健康」：只读 `ok` 的自动化从此拿到真实结论，此前把损坏当通过的行为是本批要消灭的假阳性。以退出码判定的既有脚本若在积压场景依赖恒 0，需要确认它们没有把「结构问题」当正常。

简写改按本地日解析后，一直按 UTC 心算日期调用的外部脚本会看到窗口整体平移一个时区（Asia/Shanghai 下早 8 小时开始、早 8 小时结束）；核对入口是输出里的 `window.since_ms` / `until_ms`，混用简写与无偏移 ISO 的两套口径也随之收敛成一种。

precheck 只对比版本号：`auto_vacuum` 不符、半迁移状态这类也会让启动失败的形态不在它的判据里，预检通过仍不等于迁移一定成功。`CODE_SCHEMA_VERSION` 与 store.ts 的 `SCHEMA_VERSION` 是两处数字，靠测试钉住；晋升为导出常量的时机是下一次需要跨模块读它的改动。precheck 的版本下界（v6 起可升级）也与 migrate 的分支硬编码并存，迁移路径变化时两处一起动。
