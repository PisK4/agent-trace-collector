# Agent Note: 清仓——死出口退役、共享常量与格式函数单点

Status: implemented

## Problem

架构评审 v2 的清仓清单逐项核实后全部成立：`row-summary` 的 `purposeLabel`/`isAuxRow`/`auxSummary` 与 `body-view` 的 `renderRaw` 只剩测试在消费，生产面零调用（`renderRaw` 的 UI 引用已在[面板常驻说明清理](2026-10-25-body-panel-standing-notes.md)里移除，函数被遗留）；`capacity.ts` 手抄了 `retention.ts` 的 `RAW_TTL_MS`；`localDay`/`modelTimeTitle` 长在 magpie 适配器里却被 kernel、查询与 hook 反向引用；`ingestLedger`/`ingestRoute` 两个兼容出口仅为测试保留（见[来源摄入单元](../architecture/2026-10-24-source-ingest-unit.md)）；`STATIC_FILES` 白名单在 `http.ts` 与 `http.test.ts` 各有一份手清单，两边同漏时放行——b260ee1 加 selection.js 就漏过一次。

## Decision

六项各自归位：`purposeLabel`/`isAuxRow`/`auxSummary` 与 `renderRaw` 连同其测试纯删除；`capacity.ts` import `retention.ts` 的 `RAW_TTL_MS`；`localDay`/`modelTimeTitle` 挪进中立叶子 `src/format.ts`（不 import 仓库内其他模块），magpie 与其余五个引用方全部改从新家取；摄入行为测试（reconcile 37 处账本 + 11 处路由、hook 1 处）迁到 `ingestSource` 直调——`batchOf` 本就产出完整 `SourceRead`，路由侧经 `routeReadOf` 把记录包成文件行、走同一记录级内核——两个兼容出口与孤儿类型 `IngestLedgerResult` 退役，`FileBatch` 因 `resumePausedLedger` 仍是真实形状而保留；`STATIC_FILES` 导出，白名单测试消费真清单，另加读 `web/` 目录的互相覆盖断言（目录文件必须在清单、清单文件必须在目录）。

`auxSummary` 接入生产（改进辅助行显示）不属清仓：那是一个会改变界面行为的决定，需要时单独立项。

## Alternatives considered

**测试本地保留一层兼容包装再调 ingestSource。** 只是把出口换了间房子，测试仍不经文件入口；直调后 `startOff` 等批次字段如实参与（账本路径不消费它，路由侧它只进坏行引用键，合法记录路径无差）。

**目录自动发布（扫 web/ 动态建白名单）。** 运行时行为变化，超出清仓边界；显式清单加目录断言已把「漏登记」变成测试失败而不是页面加载失败。

**renderRaw 留作原始对象阅读入口。** 没有任何页面路径指向它；想要原始对象阅读时再按真实需求设计，不靠退役出口占位。

## Consequences

删除测试即删除行为锚——这些出口描述的显示规则（用途标签文案、分类器判定摘要）随之失去记录，若将来要恢复需重写。`ingestSource` 成为摄入唯一入口后，「测试构造的批次」与「读取器批次」不再有第二种形状桥接；新测试直接构造 `SourceRead`。web 新增模块忘记登记 `STATIC_FILES` 时 `bun test tests/http.test.ts` 直接红，不再依赖人工同步两份清单。

## Testing

- `bun test` 全量 40 文件 625 例全过、`bun run typecheck`、`bun run verify:notes` 通过（2026-10-25）。迁移零断言修改：reconcile/hook/magpie 85 例在出口退役后原样通过。
- 新增目录覆盖断言做过变异验证：向 web/ 放一个临时模块文件，断言立即失败。
