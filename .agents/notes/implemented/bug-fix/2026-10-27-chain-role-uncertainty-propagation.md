# Agent Note: 祖先未知时确认后继不标分支

Status: implemented

## Problem

2026-10-27，用户在会话 `["conv","magpie-4cf9563aac3e5b1ff35dc430"]`（hermes）的轨迹页看到成片的 Event 记录：分支链请求、新增输入未确认 · retained / unknown、未收到回复、请求失败 · HTTP 499、正文状态 · pending（hook_absent），并提问这些记录是否有信息量、是否由错误引起，以及为什么 Claude Code 会话里没有这么密集。调查回答了前两问的一半：多数记录是真实事实的如实展示，但其中占比最高的一类（分支链请求）是派生判定缺陷的产物，把证据最充分的链延续标成了另起一支。

调查只做了三类动作：生产库只读查询、源码静态阅读、临时合成库复现。锚定提交 `4e82df1`。会话共 51 笔请求：49 笔 HTTP 200、2 笔 HTTP 499；其中 4 笔没有已关联正文（2 笔 499 与 2 笔 200）。会话在这些缺口之后继续产生了大量成功请求与回复，页面展示的密集记录不等于会话中断。

两笔 499 的账本与路由证据都是 `the agent canceled the request`（magpie 的 `internal/gateway/side_deadline.go` 在请求上下文先于应答结束时记 499）。这条证据说明请求在完成前被客户端一侧终止；它是真实的请求取消，但单凭它不能断言是用户手动中断还是宿主放弃等待。两次 499 附近各收到一个回复缺失的孤立 hook：collector 的关联规则只认 response id（[hook 关联](../../../../src/hook.ts)的 `findCandidates`），缺少可证明唯一关联的身份，正文按现行规则留在 `["hook",…]` 独立会话里——本决策不改关联规则。两笔 200 却缺正文的请求成因未定，保持 unknown 是合法终态。

### 缺陷机制

链角色判定把 `prev_relation='unknown'` 的请求排除出链森林：同步路径的 `assignChainRoles` 与切片路径的角色收集都带这个过滤。这是[正文不可读的请求保持中性](2026-10-21-unreadable-requests-stay-neutral.md)的决策：unknown 请求既不能证明在主链上，也不能证明是分支，保持中性、不误标。

排除同时切断了经过 unknown 节点的 confirmed 边。后继请求的父节点不在森林里，`chainTrunkRoot` 把它当成新根，它不属于首个根的可达集，`chainTrunk` 于是给它 branch；再往后的整条确认链跟着 branch。目标会话里 44 笔 `prev_relation='confirmed'` 的请求因此被标分支，其中 2 笔 `input_preview_kind='delta'` 的行被轮次读取排除在轮次起点之外。这些行恰恰是前缀证据最充分的链延续：分支标签与它们携带的证据直接矛盾。

现象不随 hermes 特有。同一时段一个 Claude Code 会话呈同形状：分支根 confirmed 接在一条正文可读但关系 unknown 的请求之后，81 笔确认后继被标 branch。用户观察到的密度差异来自会话构成，不来自采集通道。

### 相关发现，另立决策

以下三项在调查中确认，属展示与文档口径，各自另评，不与链角色修正捆绑：

- 未收到回复 Event 在正文不可读时同样出现：[trace-view.js](../../../../web/trace-view.js) 在回复视图为 null 或 absent 时一律记 `missing_reply`，把没有可读正文与已保存的空回复混为一谈。
- 请求失败 · HTTP 499 文案的后半句断言输入与回复仍保留在步骤里，未检查正文可读性与投影结果。
- `retained` 在摘要阶段的实际范围比 [trace-format.md](../../../../docs/trace-format.md) 置信度一节的描述宽：指纹不可比即 retained，不限于正文已回收。

## Decision

森林不再排除关系 unknown 的节点：它们以无父节点身份入森林，trunk 计算照旧（首个根的可达集为 main）。在此之上传播一条不确定闭包：关系 unknown 的节点，以及从它们沿 confirmed 子边可达的全部后继，`chain_role` 记 `unknown`；闭包优先于 trunk——unknown 节点若是首个根，它的整条可达集都证明不了归属。`branch` 只保留一种来源：父链可证明与主链不相接（现有「两个互不相接的根」场景）。凡是链上存在 unknown 环节、无法证明与主链不相接的，一律不标 branch。

判定收进 [decision.ts](../../../../src/derive/decision.ts) 的 `chainRolesOf`，与 `chainTrunkRoot`/`chainTrunk` 同层；同步路径的 `assignChainRoles` 与切片路径的角色扫描收尾调用同一份，不各写一遍。切片工作行的 `in_trunk` 列承载三态编码（1=main、2=unknown、0=branch），角色传播阶段只做翻译。

### 编码与消费方审计

链角色启用 [trace-format.md](../../../../docs/trace-format.md) 已声明的 `unknown` 取值（派生此前从不写入它；[projection](../../../../src/queries/projection.ts) 在非 current 时对外同样映射 unknown，语义兼容）。关系 unknown 的节点从原先的中性 main 改记 unknown：这是对 2026-10-21 note 编码决策的部分取代。理由：main 同时承担已证明与无法判断两种含义，本缺陷长期不被发现与这个双载直接相关；不确定闭包需要独立取值，读模型才不必从关系列反推。

`chain_role` 读写点逐一核对后的结论：

- [turns.ts](../../../../src/queries/turns.ts) 的轮次起点：资格判据是 `chain_role='main'`，或 `chain_role='unknown'` 且自身 `prev_relation='unknown'`。提案时以为「unknown 节点自身没有 delta，`input_preview_kind` 不可能是 `delta`」，实施审计发现不成立：正文回收的行按 retained 语义保留旧的 `input_preview_kind='delta'`，而[轮次两端阅读](../feature/2026-10-25-turn-pair-reading.md)的既有决策是回收起点照常进带（ordinals 清空、终点按保留的形状位）。判据因此多一个 prev_relation 条件：回收起点（关系自身 unknown）保留进带资格，不确定闭包后继（confirmed）排除。轮次集合与修复前逐请求一致。
- [sessions.ts](../../../../src/queries/sessions.ts) 的标题回退：第二候选池缩小到已证明主链；第三候选（不筛角色，只要求 `title_source='user_delta'`）兜底同一批行。标题只在「更早的 user_delta 行全部落 unknown、稍后才有 main 行」的会话里前移到更早一句——那是归属未证明的行的首句，不再冒充主链首句。
- [trace-view.js](../../../../web/trace-view.js)：分支 Event 只对 `branch` 触发，unknown 不再点亮它；不给 unknown 新增中性 Event，正文状态与新增输入未确认 Event 已覆盖缺失事实。会话详情的辅助提示只认 `aux`，同样不受影响。
- [ready.ts](../../../../src/derive/slice/ready.ts) 的覆盖校验按 `purpose_chain` 筛选、[session-summary.ts](../../../../src/queries/session-summary.ts) 按算法号核对事实已知性：都不读 branch/main 之外的角色值，核对后无改动。

### 版本与历史数据

`GROUP_ALGORITHM` 4→5、`DERIVE_ALGORITHM` 8→9：两条路径的产物都变化，旧结论不得冒充新结论。

版本提升只影响之后被标脏或被显式重建的组。quiet 会话的队列行 target 与 published 仍相等，读模型继续按 current 展示旧分支结论，直到下次输入变化或显式 rebuild——这个并存窗口不理想，但按仓库纪律不自动重算全库。生产采集器从主检出加载代码，rebuild 必须在新代码上线（合并并重启服务）之后执行：先 rebuild 的话，后续新流量会由旧代码把 target 算法归一回旧号，把结论拖回旧判定。目标会话的 rebuild 属交付动作，聚合计数记录在[验收记录](../../../../docs/acceptance.md)。正文不可读的行重建后仍 retained，旧值保留：本决策不补回任何缺失正文。

## Alternatives considered

**把 unknown 节点放回森林当普通根。** trunk 仍是首个根的可达集，unknown 根与它们的后继依然不在其中，后继照样 branch；同时推翻 2026-10-21 note 对 unknown 自身的中性结论。不采用。

**给 unknown 节点补一条猜测边接回主链。** 没有证据支持这条边，接上等于把后继错误并入主链；这正是 2026-10-21 note 否决过的方向。不采用。

**只改分支 Event 文案，不动派生。** 错误结论仍在库里，轮次、会话汇总与未来消费方继续读到 branch；展示修补掩盖不了判定缺陷。不采用。

**不确定后继沿用 main 作为中性编码。** 改动最小，但 main 继续双载已证明与无法判断；轮次读取会把无法证明归属的 delta 行当轮次起点，制造幻影轮次。采用显式 unknown。

**在读模型层动态改判。** 查询层重算祖先闭包把派生逻辑复制进 queries；派生是链结论的唯一属主，两处判据必然漂移。不采用。

## Consequences

- 得到：confirmed 后继不再因为链上存在 unknown 环节而误标 branch；unknown 第一次有独立取值，读模型与界面不必从关系列反推中性；分支 Event 的中栏噪声在受影响会话里消失。
- 代价：不确定闭包可能覆盖整个会话——一条早期请求正文缺失，其后所有确认链都归 unknown，会话级主链与分支的区分在这些会话里整体失效。这是诚实的代价，2026-10-21 note 已对节点自身接受同样结果；读者失去的判断由正文状态与新增未确认 Event 补足。无骨架请求排在会话最前时整组落 unknown（`tests/derive-chain.test.ts` 的无骨架场景断言了这个形状）。
- 新旧并存窗口内，quiet 会话继续把旧 branch 结论按 current 展示，读者仍可能被误导；显式 rebuild 是唯一收敛路径，rebuild 走整链重排，长会话成本受既有派生预算约束。生产采集器运行旧代码期间 rebuild 会被后续流量回写覆盖，收敛以新代码上线为前提。
- 本决策不改变正文缺失本身：hook_absent、无 response id 的孤儿 hook 与成因未定的 200 缺正文继续按现行证据边界展示，不得被读成解决了采集缺失。

## Testing

- `tests/derive-slice.test.ts` 新增缺陷场景：五笔 `[S]` / 不可读 / `[X]` / `[X,Y]` / `[S,X,Y,Z]`，断言两条路径第 3、4 笔 `chain_role='unknown'`、第 4 笔 prev 仍 confirmed 指向第 3 笔、第 5 笔重新锚定记 main；该场景在修复前失败。「不可读祖先」与「同毫秒顺序未证实」两个既有场景补上角色断言，锁定 unknown 编码。
- `tests/derive-chain.test.ts` 三处断言随编码更新：无骨架请求排最前的形状整组落 unknown；增量输入节点自身落 unknown、其后的重新锚定行保持 main；前驱正文缺失的两笔落 unknown。
- `tests/derive-rebuild.test.ts` 新增维护入口回归：缺陷形状的合成会话经 `maintain rebuild` 产出 unknown 角色，报告如实记 3 笔重算、1 笔 retained。
- `bun test` 全量 867 通过；`bun run typecheck` 通过。合成与真实流量验收分开记录，真实会话的 rebuild 结果见[验收记录](../../../../docs/acceptance.md)。
