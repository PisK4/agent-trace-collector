# Agent Note: 页面交互动效层（Tracery）

Status: implemented

## Problem

页面的状态反馈全部瞬时硬切：全仓只有四处 chevron 的 `transition:transform .12s`，零 keyframes。弹窗瞬开瞬关、toast 闪现即删、双栏折叠跳变、换页签内容整块闪换、加载文案与静态说明无视觉区分。用户确认最高频交互是中栏逐条选 Trace，并点名页签、Agent 筛选这类切换动作要有动效。方案先出可交互 HTML demo（A/B 对比开关）定稿后才实施，demo 的效果集与时长档位（120–220ms）由用户逐项过目。

## Decision

动效分两层，各有各的家：

- **CSS 层（app.css 末尾「动效」区，声明一个家）**：状态驱动型——hover 与选中的底色/描边/box-shadow 过渡（120ms）、折叠箭头旋转（原四处内联声明收编）、页签下划线从左生长、分段控件选中段弹起、读取文案呼吸（`.pulse`，含 preparing 占位行的属性选择器）、尾部追加组渐显、定位落点呼吸、toast 入场、弹窗入场、面板折叠的列宽过渡与 visibility 延迟、折叠行高度过渡（`::details-content` + `interpolate-size`，渐进增强，不支持的浏览器瞬开）。令牌 `--t-fast/--t-move/--ease-out` 集中在该区，主题无关，不进暗色复制块。
- **JS 层（web/motion.js 统一入口）**：生命周期型——弹窗与 toast 的离场（完成后才 hidden/移除）、右栏换页签的方向性滑入与换请求的渐入、treemap 换请求时的矩形 FLIP、换会话中栏整体渐显。全部经 `motion()`：reduced-motion 或缺 WAAPI 时返回 null，调用方按 null 跳过等待；`settled()` 给 `finished` 加超时兜底。

瞬态类只挂用户点击：页签下划线（`.tab-fresh`）与分段弹起（`.chip-fresh`）在点击处理器里加类，store 驱动的重绘重建的按钮不带类，不会重播。右栏进场的重放判定用 `{key, phase}`：同键同相位（常规 store 重绘）不播，相位从未读变已读才补一次渐显。

**web/motion.vendor.js** 是 motion@14.9.0 的 `motion/mini` 入口经 esbuild 摊平的 vendor 产物（8.3KB，仅 re-export `animate`），文件头记录构建命令与依赖链版本，升级等于显式重跑。`motion.js` 是我们自己的 12 行封装，调用方只 import 它。

**切主题决策修订**：app.css 原注释「背景色一律不做过渡（切主题残留旧色一帧）」放宽为——切主题时 `body.theme-switching` 两帧禁用全部过渡（layout.js），主题仍当帧完成，其余时刻交互底色过渡照常。

**reduced-motion**：CSS 侧动效区末尾 media blanket 一网打尽；JS 侧 `motion()` 同口径短路；既有 JS 平滑滚动守卫保持。蜘蛛插画（[2026-11-02-empty-state-spider](../../proposed/feature/2026-11-02-empty-state-spider.md)）自带静态降级，与本层并存。

**范围修正**：`select-turn` 刻意不加滚动——轮次点选保持「轨迹高亮不动」的既有语义，落点呼吸只挂 `locate` 路径（汇总条目定位、切窗定位、URL 轮锚点）。

## Alternatives considered

- **motion@14 全量 dom 入口**（62KB gz）：含 scroll/projection 等大量用不上的能力，否。仅 `animate` 的 tree-shake 也有 25KB gz。`motion/mini`（3.3KB gz）砍掉的恰是本项目否决的 spring/独立 transform/编排，选定。
- **Motion One v10**（4.2KB gz）：已归档停止维护，不选现行版本更小的 mini。
- **View Transitions API 换会话交叉溶解**：innerHTML 直换做不了真溶解，大会话全页快照捕获成本高（大会话 6 万+ DOM 节点），否。
- **页签滑动指示条**：rail-head 整块 innerHTML 重绘，滑块无法跨重绘存续；用瞬态类的生长下划线替代。
- **vendor 放 `web/vendor/` 子目录**：静态白名单测试对 web/ 顶层做目录互查（readdirSync 非递归），子目录会打破互查；沿用 web/ 平铺惯例，命名 `motion.vendor.js`。
- **依赖 `finished` promise 本身**：嵌入式 WebKit（IAB 实测）动画时钟可能不前进，`finished` 永不 settle；`settled()` 超时兜底，离场永不卡住界面。

## Consequences

- 代价：vendor 产物不进 package.json、无 lockfile 管着，版本来源靠文件头与 git 历史，升级是显式动作；STATIC_FILES 与白名单互查测试各加一行；`body.theme-switching` 是新的一帧级全局开关，切主题当帧任何过渡都被禁用。
- 收益：弹窗与 toast 的离场不再依赖手工计时器猜测时长，重开竞态由 cancel + 代次数组处理；未读正文到达有明确的「到了」反馈；treemap 构成差异可视化；折叠与页签切换不再跳变。
- 验证口径：`bun run typecheck`、全量 `bun test`（1146 pass）、trace-commit 新增 `tailAppendKeys` 五个边界用例；合成页走查确认模块链、选中迁移、页签瞬态类、弹窗开闭、令牌与过渡声明。时序类视觉（渐显、FLIP、折叠收拢的流畅度）在动画时钟冻结的嵌入式环境不可验，需真实浏览器确认；大会话下折叠过渡的帧率是留观项。
