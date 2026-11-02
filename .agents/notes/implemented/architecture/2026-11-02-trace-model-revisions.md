# Agent Note: 按内容修订与依赖边复用显示投影

Status: implemented

## Problem

读取架构提案 Task 6：中栏投影逐帧全量重算——每次渲染对每组重新 `projectSteps`，30 笔窗口一次批量落地触发 30 次全量投影与行 HTML 重生成；保留投影（`retainedSteps`/`retainedTail`）与末尾组资格散在 app 里手工维护；前驱或工具 owner 的内容变化不会触发对应后继组重投影（后继的 System 标记、调用方摘要可能停留在旧依赖上）。

## Decision

- `reader-store` 的快照新增只读 `contentRevision`：detail/meta/消息/结构/增量/失败态任一真实变化自增（`clearRecordContent`、detail 写入、`applyBundle`、`mergeMessages` 新项、结构页推进、delta 推进与失败各一个收口点），peek 不推进。它描述已加载内容的修订，不复用只作废时变化的 `rec.rev`，也不以 reading token 代替——token 相同的消息新增必须投影。
- 新建 `web/trace-model.js`：组与尾组的投影按内容修订与依赖边重算，读取无变化时重用上一次对象。三态（当前/保留/占位）、末尾组资格（单次后向扫描 + 缓存，判据仍是 trace-view 的纯函数）与窗口线性索引都移入 model；依赖边来自 detail 的真实前驱与已解析工具 owner，变更时先删旧边再加新边，失效沿反向边传播（前驱 System 变更只更新对应后继）。`bgJobs` 按引用判事件，仅在事件发生时全窗口失效。
- app 不再另持相同缓存：`stepsOf`/`tailOf` 变成 model 的取值，`changedReads` 收集本轮修订变化的组，渲染前一次喂给 `model.update`。
- 行 HTML 按步骤数组引用缓存（`rowHtmlCache`）：显示模型重用未变的 steps 时跳过重生成，序号或投影资格变化才重建；`selectedStep` 不进缓存键，选择由提交后单独写回高亮。
- `trace-dom.commit` 返回 `'clean'|'selection'|'structural'`：clean/selection 不执行全栏折叠恢复与带定位（`restoreFolds`/`syncBandTop` 的布局读取），结构路径只计算一次行计划并沿用原同步锚点恢复；选中块回视野自带视野判断，保留在快路径里给轮次点选即时反馈。
- 读落地的重绘合并：`onStoreChange` 与准备块通知改排微任务，同一 tick 多笔读取只提交一次；选择仍走 dispatch 的同步路径；锚点捕获与补偿保持在一次同步 commit 内，不跨 rAF。

## Alternatives considered

**以 reading token 判重投影。** token 只绑定读取身份，不随增量消息、结构窗口与失败态变化——相同 token 的新增消息会漏投影。否决，修订必须描述已加载内容。

**以 `rec.rev` 判重投影。** rev 只在作废时自增，正常读取推进（批合入、delta 续读）不触发，投影会停在旧内容。否决。

**bgJobs 逐笔准备都重算资格。** 每次读取都全窗口失效等于退回全量重算；资格只在 bgJobs 事件本身发生时重建，事件按引用判别，调用方传 store 的稳定数组。沿用计划决定。

## Consequences

- 组显示形状统一为 `{steps, stale, placeholder, tail}`，同一显示版本返回同一对象，`get(id)` 可直接做身份比较；尾组撤下语义收紧为「依赖失效或离窗即撤」，不再保留旧回复冒充当前。
- 行 HTML 缓存键不含行对象身份：窗口行对象只在重建时更换，而重建必先清模型与缓存（`resetReading`），刷新路径不受影响。
- 静态白名单同步登记 `trace-model.js`；`http.test.ts` 的目录断言防止后续模块漏登记。
