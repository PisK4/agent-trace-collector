# Agent Note: Hermes 视觉辅助误列会话与技能包装标题修复

Status: implemented

## Problem

2026-11-01 的截图反馈：只开了一条 Hermes 对话，ATC 左栏却出现多个 Hermes 会话，标题都以技能包装开头。逐字比对 ATC 与 Hermes 原生库后确认，两个大组分别对应主对话与后台 cron，是真实的不同执行；缺陷在两处解释错误，完整证据与归属判断见[专项提案](../../proposed/bug-fix/2026-11-01-hermes-auxiliary-session-noise.md)。

其一是视觉辅助调用被当成独立聊天。本机 Hermes 的视觉工具为识图另发模型请求：唯一一条 user 消息、无工具声明、无 system，内容块是文本加图片，文本块以固定模板开头。既有用途规则只认命令审查与标题生成，这批请求落 `unrecognized`/`chat`/`participate`；会话身份回退到路由 conv，每笔各成一个单笔组，而列表的旁路折叠要求全组排除主链，于是它们占据左栏。

其二是技能加载包装占据标题。Hermes 把技能正文与用户指令写进同一条 user 消息，派生标题取可用用户文本首行，取到的是包装头部行。生产 392 条样本里头部行只有两种变体，只差技能名；结构是头部行、技能正文、指令锚点行三段——锚点行冒号后是调用技能时的用户指令，手动调用的指令是明文，cron 的指令本身又是嵌套的 `[IMPORTANT:` 单行，两类的锚点之后各有一段无归属证据的 harness 段落。

## Decision

用途侧在 [Hermes adapter](../../../../src/harness/hermes.ts) 增加 `hermes.vision-analysis.v1`，登记次序位于命令审查之后、标题之前。判定按请求形状限定：`messageCount` 为 1、`toolCount` 为 0、user 消息里有图片内容块，且模板在实际用户文本块开头（块首小写前缀比较）。结论是 `vision-analysis`、排除链、模型标题为 null；回复不作门槛，识图失败没有回复的请求同样排除。`PurposeView` 为此增加 `userImageBlocks`：前 5 条 user 消息里 `image`、`image_url`、`input_image` 块的计数，与块首在同一次解压里取齐，不含图片字节。独立单笔组全员排除后由既有 `bypass` 标志折叠，与主请求同组时排除祖先候选，页面无新逻辑。规则与视图形状的现行描述归[架构设计](../../../../docs/architecture-design.md)。

解释侧在[共享输入解释](../../../../src/input-interpretation.ts)按完整结构处理技能加载：头部行语法与指令锚点行两行齐备才动文本，剥掉头部行、头部行到锚点行之间的技能正文与锚点前缀，锚点行冒号之后是用户指令。锚点之后的段落没有可证明的归属，随指令保留。指令缺失或本身以 `[IMPORTANT` 开头（cron 调度文本）时，整段按 `injected`/`skill_injection` 处理，标题回退模型时间。头部行在但锚点行不在的结构整段原样保留。规则不做 agent 门控，对其他标签、未知与空标签同样生效。cron 仍是独立执行，不为它加定时任务标签。

三个版本号一并提升：`PURPOSE_VERSION` 7→8，`GROUP_ALGORITHM` 6→7 与 `DERIVE_ALGORITHM` 10→11；[session-summary](../../../../src/queries/session-summary.ts) 的前一算法容忍窗口同步到 6 与 10。历史数据按[显式重建](../../../../docs/operations.md#rebuild)逐个 `conv_key` 交付：重建先升级用途目标再整链重排，一次覆盖用途与标题两处。

## Alternatives considered

**把 Hermes 请求合并成一条会话，或按时间、模型名、相似标题给视觉调用认父。** 截图里就有真实的 cron 执行，合并会破坏执行边界；19:32 两份没有 response ID 的证据说明时间接近不足以确认同一调用。只排除辅助用途，不猜父子关系。

**整段丢弃包装消息，或只删第一行。** 前者丢掉真实用户指令，后者让技能正文或锚点后段落变成标题。结构拆取保住可证明的部分。

**以 `[IMPORTANT:` 前缀通配删除。** 用户引用、cron 嵌套包装与真正的头部行都以这个前缀开头，通配会把用户的话一并清掉。头部行语法与锚点行都要命中才剥，两个锚都是 harness 写入的位置描述。

**把锚点之后的 Script Output、Context Warnings 段一并剥掉。** 这些段落没有锚点可证归属；cron 的实际任务行也混在其中，按段落截取可能把上下文数据当任务。保留是保守的一面，代价是这些段落留在输入文本里。

**从 cron 消息的后段提取任务行当标题。** 任务行与 Script Output 之间没有可证明的边界，不截取技能正文或调度文本冒充用户任务；cron 标题退到模型时间兜底，由后续采集到原生会话事实时再议。

**把图片字节或整条消息传给用途判定。** 计数事实够判定用，成本不随正文体积增长；adapter 不读数据库，字节不出取数层。

## Consequences

视觉调用折叠进旁路不等于找回父会话：hook-only 的失败视觉行保持归属未知，没有 response ID 的关联缺口维持原状。模板与包装措辞由上游维护，变化后退回未识别、包装退回原样，缺陷以原形重现。误判面由完整结构限定，但用户逐字引用头部行与锚点行两行文本的消息仍会被剥出指令——原文保留在 `original`，代价是这一条消息不按用户输入计。

cron 标题退到模型时间兜底，与主对话的标题可能同形或同样不可读；修复承诺的是内部包装不再命名会话，不是两个标题一定不同。存量 clean 行不自动重算，等显式重建；重建读取正文并重算长组，与[采集期间交互延迟提案](../../proposed/bug-fix/2026-11-01-collection-interactive-latency.md)的长同步任务风险重叠，按维护窗口执行。

## Testing

[tests/hermes-purpose.test.ts](../../../../tests/hermes-purpose.test.ts) 经生产正文存储与结算路径覆盖：同组视觉调用为 aux 且不干扰主链配对，独立单笔组标旁路，hook-only 行结算用途但不进组队列，缺回复的失败视觉调用仍排除；模板缺图、模板不在块首、带工具声明、多条消息、其他 agent 标签五个反例落回普通对话。技能包装的会话标题经同一结算路径断言，cron 调度文本回退模型时间。[tests/input-interpretation.test.ts](../../../../tests/input-interpretation.test.ts) 覆盖指令剥取、共享标签行为、cron 嵌套注入与无锚点、空指令、用户引用的保留路径。[tests/session-summary.test.ts](../../../../tests/session-summary.test.ts) 钉住算法号 7/11 与前一算法容忍窗口。真实库重建与真实列表复核未执行，合成验收不关闭[提案](../../proposed/bug-fix/2026-11-01-hermes-auxiliary-session-noise.md)的真实复核条件。
