# Agent Note: 轨迹窗口锚定会话开头，阅读从头往下

Status: implemented

## Problem

进入会话默认落在最底部：初始窗口用 `direction=older` 无游标取会话最新一页，装配层默认选中最新一笔并滚动居中。这个默认服务"看刚发生什么"的监控场景，但按会话阅读轨迹的自然方向是从第一条命令往下读；每次进来都要先手动回到顶部，而且长会话的最早几笔根本不在窗口里——初始窗口只装最新一页，改滚动位置够不到它们。窗口分页的 API 早已支持 `direction=forward`（从最早一页向后），前端从未消费过这个方向。

## Decision

窗口锚点二元：`start`（默认）与 `latest`，落在 [reader-store.js](../../../../web/reader-store.js) 的 `selectSession(key, limit, anchor)`。

- **头锚点（默认）**：`direction=forward` 无游标取会话最早一页；进入会话默认选中第一笔（`session-default` 意图的入参改为 `firstReqId`），停在中栏顶部，从头往下读。
- **加载后续**：`loadEarlier` 改名 `loadLater`，走 forward 游标把新页 append 到窗口尾部；页大小 clamp 到服务端上限 200 的规则沿用。append 不重排既有行，已载入请求的序号不变；窗口下界不动，轮次快照无需重取。
- **加载入口移到列表尾部**（[trace-dom.js](../../../../web/trace-dom.js) 的 `listItems`），「已是最新记录」只在后续游标耗尽后出现，游标未耗尽时不冒充结尾。
- **尾锚点**：`latest` 走原 `direction=older` 路径取最新一页，选中并居中最新一笔。会话头的方向按钮按锚点换向：头锚点显示「回到最新 ↓」，尾锚点显示「回到开头 ↑」；两者都是重建对面锚点的单页窗口。`windowAnchor` 记在页面状态里，刷新按当前锚点重建（头锚点用新增的 `select-first` 意图，与 `select-latest` 对称），换会话复位为 start。
- **窗口外直达**：off-page 说明附「切到最新窗口/回到开头窗口」按钮（[session-view.js](../../../../web/session-view.js)），按当前锚点换到对面锚点重建；目标进入新窗口就定位到它，仍在窗口外（超长会话的中段）就恢复说明，不假装已到达。「不自动扫描全部历史」的立场不变。

准备流水线（[中栏窗口读取的准备流水线](../architecture/2026-10-27-trace-window-preparation.md)）不改：目标组（现在是第一笔）先单独准备，其余按窗口顺序四笔一组，顺序与阅读方向一致。

## Alternatives considered

**只改初始选中与滚动，窗口仍取最新一页。** 两三行改动，但长会话的开头几笔不在窗口里，进入后看到的还是会话中部，不满足"从前面几条数据开始展示"的本意。

**列表整体反转，最新在最上。** 时间轴倒置后工具调用与结果的上下配对、轮次带的左右方向、序号语义都要跟着反，改动面更大且没有换回任何东西；保留时间正序、只换窗口锚点是最小路径。

**URL 直达按请求在会话中的位置智能选锚点。** 头尾二选一仍可能都不含中段请求，判定还引入位置启发；off-page 说明加切窗按钮已覆盖主路径，智能选锚留给真实需要时再做。

**去掉「回到最新」，只留从头读。** 监控最新流量的场景没有消失，只是从默认态降为一次点击；删掉入口会把那个场景逼回浏览器刷新。

## Consequences

进入会话即从头读，长会话靠尾部「加载后续记录」往下翻；append 让已读行的序号稳定，不再因翻页全部重编号。轮次带在头锚点下覆盖会话开头的轮次，比最新锚点更完整。

监控最新从默认态变成一次点击（「回到最新」）；追尾模式由锚点记忆保持，刷新不把用户拽回开头，换会话才复位。

URL 直达指向较新请求的链接在头锚点下落窗口外，语义与提示承接不变；追尾模式下指向较早请求的链接同样落窗口外，由「回到开头窗口」承接。

「回到最新」与「回到开头」都重建单页窗口，已加载的扩展页丢弃——与显式刷新同代价，长会话往返两头要重新翻页。

## Testing

`bun test tests/reader-store.test.ts tests/selection.test.ts` 共 49 项通过：loadLater 的 clamp、失败保留旧窗口、append 去重与序号稳定，锚点方向断言（默认 forward、latest 走 older），`session-default` 选第一笔、`select-first`/`select-latest` 对称。`bun test tests/trace-commit.test.ts tests/web.test.ts tests/turn-band.test.ts tests/trace-view.test.ts tests/trace-pair.test.ts tests/files.test.ts tests/http.test.ts` 共 117 项通过，`bun run typecheck` 通过。

合成浏览器验收（ego lite，worktree 检出的 `prototypes/synthetic-server.ts` 端口 8770，生产采集器未动）逐项断言：进入会话窗口 30 组、scrollTop 0、选中第一笔且序号 1，加载入口是列表最后一个孩子，无「已是最新记录」；「加载后续记录」后 52 组、既有序号不变、结尾标记出现；「回到最新」切尾锚点选中末笔并换向，「回到开头」稳态 scrollTop 0 回到第一笔；`?trace=545` 直达窗口外请求给出说明与「切到最新窗口」，点击后定位到 545。逐项记录见[验收记录](../../../../docs/acceptance.md)。真实流量验收未执行，需单独授权。

## Related

[单一时间线生产阅读器](../architecture/2026-10-23-single-timeline-production-reader.md)定义了最初的窗口与刷新语义，本篇把默认锚点调转到会话开头并改「回到最新」为切锚点动作。[最近请求窗口与向前分页](2026-10-24-older-window-pagination.md)的分页契约不变，前端默认消费的方向由此篇调转。
