# Agent Note: 方向 A 第 2 步——徽章 pill 化与工具七档色删除

Status: implemented

## Problem

[方向 A 重制提案](../../proposed/feature/2026-11-02-frontend-direction-a-restyle.md)第 2 步：同屏 soft 底色超过十种的最大来源是工具七档身份色（Read 蓝、Edit 橙、Write 紫、Bash 玫红、Skill 黄、Agent 绿、其余青灰）叠在角色五档底块上。本步删工具七档、角色徽章 pill 化并封顶四档、pending 行去满铺底、选中行补齐左缘，中栏、右栏与头部摘要三处 chip 规则一次改齐。

## Decision

- **toolTint 与 tint-* 七类整体删除**：`web/body-view.js` 的 `toolTint` 函数、CSS 的 `.tint-*` 七条规则与 `--tool-*` 十四个变量全部移除。六个消费点（正文工具往返、右栏工具列表、中栏 `row-tint`、头部摘要工具与 Skill chip、配对页 `bp-kind` 两处）全部改中性：`row-tint`/`path-chip`/`path-more summary` 落 `--inset` 底加 `--text-2` 字，`tool-chip call` 保持 surface 底透明边框，配对页两个面板头统一 `kind tool` 角色橙。工具身份改由 mono 文本自身承载，失败仍走 `--warn`/`--bad`。
- **k-field 并档核对结果**：`--k-field` 的全部消费点只有两处——`.kind.unknown` 与 `.kind.FIELD,.kind.PARAM`，语义都是「无角色归属的中性结构元素」，并入 system 灰没有反例。变量三段删除，两处消费点改 `k-system`。FIELD/PARAM 若未来需要独立语义再另立 token，不预留在角色四档里。
- **角色徽章 pill 化**：`.row-label`（中栏对齐列，62px 槽位内全宽 pill）、`.kind`（右栏与正文，padding 收窄为 2px 8px）、`.row-reading`（读数槽标签）三处 border-radius 改 999px。四档色值第 1 步已就位。
- **pending 行去满铺**：`.compact-row.step-flag` 与 `.compact-row.step-error` 的 `--warn-soft`/`--bad-soft` 满铺底改透明底加 2px 虚线左缘（warn，失败变体 bad），`padding-left:3px` 补偿边框占位使内容与其他行对齐。首屏成串的米黄块消失，缺口强度仍一眼可辨。
- **选中态补齐**：右栏 `.compact-select[aria-current]` 在 accent-soft 底上加 `inset 2px 0 0 var(--accent)` 左缘；中栏 `.msg[aria-current] .msg-head` 已是左缘加浅蓝底，未动。两处共用同一视觉规则，单选。
- **path-chip 与 path-more 的 w/r/t/s 类**：随七档色删除失去色源，类别区分回到 mono 文本；两类 chip 统一 inset 底。写入/读取不再有色彩区分是本步的显式接受项（提案规则 1：颜色只给异常与选中）。

## Alternatives considered

- **path-chip 保留写橙读蓝两档**：与 tool 角色橙、user 角色蓝撞色相，且角色四档封顶后没有预算再给路径类别开新色相。放弃。
- **配对页未确认面板头用灰（unknown）**：原实现里未确认用 tint-other 灰。统一 tool 橙后「这是工具块的头部」语义更直接，未确认状态由标题文本「Tool result」与缺失的正文区表达，不需要颜色承担。
- **row-label 保持方角**：对齐列里 pill 全宽形状与 `.kind` 的一致性更重要；方角只在 row-label 上保留会形成第四种徽章形状。

## Testing

- `bun run typecheck` 通过；受影响的四个测试文件（body-view、trace-view、trace-pair、web）131 用例全过，断言从 tint 类改为中性/角色类。
- 全仓 grep `toolTint|tint-|k-field|tool-(read|edit|write|bash|skill|agent|other)` 在 web/ 无残留（`data-tool-read` 是读取正文按钮的业务属性，与色无关）。
- 合成服务器目测（`/tmp/atc-restyle/step2-{light,dark,select,tools}.png`）：四档角色 pill 生效；工具调用行中性；缺正文组的 warn 虚线与失败组的 bad 虚线可见；选中行浅深两主题左缘加浅蓝底可见；treemap 彩色按计划保留给第 6 步。

## Consequences

- **工具身份只能靠读名字**：七档色相的记忆辅助消失，长工具名（MCP 前缀）在 mono 中性下的扫读效率略有损失；换来了同屏 soft 底色收敛到角色四档加语义三色以内。
- **写入/读取路径 chip 失去色彩区分**：提案第 5 步重排工具列表页与配对页时若需要区分，用符号或文案而不是新色相。
- **选中态样式仍是两处独立规则**（msg-head 的 border-left 与 compact-select 的 box-shadow），视觉一致但实现未抽公共类；第 3 步动会话栏时若第三处需要同一选中态，再考虑归并。
- **`.tool-chip.res` 的 k-tool 橙保留**：结果 chip 的角色色语义（这是 tool 块）不受七档删除影响。
