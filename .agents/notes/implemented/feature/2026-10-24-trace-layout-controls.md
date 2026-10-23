# Agent Note: 轨迹布局控制与生产阅读收尾

Status: implemented

## Problem

单一轨迹页面（[2026-10-23-single-timeline-production-reader.md](../architecture/2026-10-23-single-timeline-production-reader.md)）交付时布局是固定三栏：会话栏与详情栏不可折叠，详情栏宽度不可调；会话身份没有复制入口；左栏还留着笼统的「待确认」标记，中栏有通用缺正文整行；README 的阅读验收仍是双视图口径。

## Decision

布局控制复用原型验证过的机制，只迁有效样式：三栏网格改 CSS 变量（侧栏 250px、详情栏 380px，1240px 以下 220/310），分隔线占独立网格列。折叠用 body 类 + `visibility:hidden`（分隔线与可聚焦后代一并退出可访问树，不用 opacity 假装隐藏），按钮带 `aria-controls`/`aria-expanded` 并同步标题；1000px 以下堆叠布局移除分隔线、折叠改 `display:none`。详情栏调宽：`role=separator` + 方向键（±20px）+ 双击恢复 380，pointerdown 捕获、move 只在按住时更新、up/cancel 释放；宽度夹取范围 280..640 且给中栏保底 320（`clampWidth`），窗口 resize 重新夹取；宽度与折叠状态只存内存，不进 localStorage（主题读写继续 try/catch）。

Session ID 复制：JSON 数组 `["session", id]` 复制第二项原始 ID，conv 身份标「会话键」并复制完整 conv_key，不把 JSON 数组误称 UUID；剪贴板拒绝或不可用时给出可选中文本与手工复制提示（toast + 临时 textarea），成功才显示「已复制」。左栏去掉未知派生的「待确认」标记（具体状态留在选中请求），中栏删除通用缺正文整行；失败、具体异常与历史未读范围仍就地显示。

文档同步：README 新增「阅读界面（当前：单一轨迹）」一节并记录本轮合成验收，A5/B5/中栏版式标注为历史记录；生产阅读提案迁入 implemented（Proposal→Decision，Acceptance/Risks 折入 Consequences/Testing 并引用实测），固定账本行与读数裁剪两篇旧 note 交叉链接，实施计划复选框全部勾选，docs/README 入口描述更新。

## Alternatives considered

**宽度与折叠状态存 localStorage。** 每台机器的正确布局不同，持久化会把一次试验固化成默认；本轮只存内存，跨会话重置是可接受代价。

**折叠只用 opacity 或 width:0。** 不可见但仍可聚焦是可访问性陷阱；visibility/display 把分隔线与后代一起移出 Tab 序。

**复制失败时静默。** 剪贴板在非聚焦页签常被拒绝；降级为选中文本让用户手工 ⌘C，失败可见。

## Consequences

布局三态（默认 / 折叠侧栏 / 折叠详情栏）与宽度调整全部原生控件可操作，纯键盘可用；≤1000px 无分隔线。左栏只保留具体事实标记；中栏不再有与选中请求重复的通用缺正文提示。已知边界：宽度不跨会话持久；合成验收矩阵中「最大时长 131.56s/133.44s」一行未在合成样本复现（合成最大 12.8s），以长状态字符串与同屏读数检查代替；canonical 别名与 503/409 的浏览器级演练由单测覆盖（合成服务不产生这些响应）。

## Testing

`bun test`（八文件 136 例）、`bun run typecheck`、`bun run verify:notes`、`git diff --check` 全过（2026-10-24）。浏览器验收（合成服务，2026-10-24）：初始几何 250/380/自适应；侧栏折叠后 main 保留宽度、aria-expanded 同步；详情栏折叠时分隔线一并隐藏；拖拽到 480 生效、未按住的 pointermove 不生效；ArrowLeft +20 / ArrowRight −20 / 双击恢复 380 且变量清除；Session 复制成功与拒绝降级（临时 textarea + toast）两条路径都走通；900px 堆叠布局分隔线 display:none、折叠栏移出文档流；全程无 pageErrors。综合矩阵其余行（36px、向前两页、未知会话、深色主题、读取成本、三项阅读任务）见 [Agent Note：单一轨迹生产阅读](../architecture/2026-10-23-single-timeline-production-reader.md) 的 Testing 节与 README 验收表。
