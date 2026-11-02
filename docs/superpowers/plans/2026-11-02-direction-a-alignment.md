# 方向 A 界面对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复方向 A 走查记录的 22 项实现与交互缺口，并按设计稿调整会话笔数和有事实来源的列表摘要。

**Architecture:** 前端继续复用生产 web 模块和读取架构；头部使用共享行轨道，截断只作用于名称，不截断计数。工具目录沿现有具名操作补充现存路径、Skill 与执行窗口，不读取正文、不改 schema 和派生版本。

**Tech Stack:** TypeScript、Bun、bun:sqlite、原生 JavaScript 与 CSS；不新增依赖。

**Spec:** [方向 A 对照走查](../../../.agents/notes/implemented/bug-fix/2026-11-02-direction-a-alignment-audit.md)、主检出的 `.archify/style-direction-a-detail-20261101-230459/atc-geist-detail.html`。

## Global Constraints

- 用户指定 Sub-Agent 实施，主 Agent 负责方向和统一验收；本计划不再询问执行模式。
- worktree：`creator-intelligence/.codex-worktrees/atc-direction-a-alignment`，分支 `fix/direction-a-alignment`。
- 不引第三方依赖；正文、路径和工具参数一律转义。
- 不修改生产库、配置、schema、派生版本或后台任务，不启动第二个采集器。
- 读取继续使用现有 operation、HTTP adapter、scheduler 与 reader-store；禁止逐列表项请求正文。
- duration 阈值和等待型工具豁免保持现行规则；exec_ms 是执行等待窗口上界，不能标成工具进程精确耗时。
- 默认会话数显示已加载 N；后端没有全库总数，不补造分母。
- 未确定设计稿底部阅读分片 tabs 对应的具体控件，保留当前轮次带与右栏页签选中色。
- 实施阶段不创建提交、不合并、不重启生产服务；2026-11-02 用户显式授权发布，步骤见下方「发布」。

---

### Task 1: 前端布局与信息展示

**Files:**
- 修改：`web/app.css`、`web/session-view.js`、`web/app.js`、`web/body-view.js`、`web/context-map.js`、`web/index.html`、必要的 `web/trace-view.js`。
- 测试：`tests/web.test.ts` 与直接受影响的正文、轨迹、树图测试。
- 同步：现有方向 A 第 3–6 步 note 中被实际实现改变的事实。

**Interfaces:**
- 消费：`sessionHead(input)`、`railSummaryListHtml(list, labelOf, meta)`、`RequestDetail.tool_calls[].exec_ms`。
- 消费 Task 2 的 `SummaryEntry.exec_ms` 与 `SummaryEntry.summary`。
- 产出：既有函数签名及事件定位属性保持可用；新增折叠键含 sessionKey，沿 folds 恢复。

- [x] 读取走查记录 H1–H7、R1–R3、C1–C2、T1–T3、B1–B2、S1–S2、P1–P2、U1，对照设计稿与实际调用。
- [x] 为有行为变化的顺序、fold 键、计数、缺值和转义添加最窄断言；CSS 几何用浏览器验证，不添加样式镜像测试。

```sh
bun test tests/web.test.ts
```

- [x] 头部改共享三条轨道；资源、性能、结构对应工具、写入、读取。允许右侧 chip 换行，次数和失败数不收缩。
- [x] 截断仅限制名称或路径；写入、读取短前缀常驻；说明浮层不被自身裁切，键盘可达。
- [x] +N 使用已有 folds 状态；刷新保持独立开合，切会话不串状态，sticky 头部与轮次带同步高度。
- [x] 请求结构按序号、角色、预览排列，头部显示新增数，纯工具结果 mono 弱化。
- [x] 上下文数字改 mono；树图数值只给前四名且尺寸足够的块，所有块保留完整可访问名称。
- [x] 正常耗时弱灰，读数槽无角色色底，工具调用 mono、名称加重、结果弱化；不改阈值与配对语义。
- [x] logo 使用中性主干、两枚中性节点、一枚蓝色分支点；面包屑请求位置在前，标题可截断。
- [x] 会话笔数和时间放到元信息行；标题右侧常驻已加载数，加载更多置列表末尾居中。
- [x] 工具列表失败段独立红字；展示有值摘要和执行窗口，缺值不给 0；配对页从现有 pair.exec_ms 取值。
- [x] 汇总列表额外摘要仅同步复用已缓存 detail/meta 的 toolEntries，不新增读取、缓存或预取。
- [x] 刷新、回到最新和返回动作使用局部 ghost 样式，不全局修改 chip-btn。
- [x] 跑本任务受影响的最窄测试，回报真实输出与未覆盖项。

### Task 2: 工具目录展示事实

**Files:**
- 修改：`src/queries/session-summary.ts`、`prototypes/synthetic-server.ts`，必要时修改 `prototypes/star-session.ts`、`web/read-http.js`。
- 测试：`tests/session-summary.test.ts`、必要的原型与 adapter 测试。
- 文档：简短 implemented bug-fix note；现行读取事实若有变化则更新所属文档。

**Interfaces:**
- 消费：同步 tool_call、已发布 derive_tool_result、request 开始时刻与时长；选源沿 EFFECTIVE_TOOL_SQL。
- 产出：

```ts
export type SummaryEntry = SummaryCallRef & {
  state: string;
  exec_ms: number | null;
  summary: string | null;
};
```

- [x] 对 resolved 正值、零、负值、缺时长、pending、已发布代覆盖旧同步行，以及路径／Skill／空摘要添加合成测试。

```sh
bun test tests/session-summary.test.ts
```

- [x] exec_ms 复用 `src/queries/requests.ts` 的现行公式和前提；只在点击目录查询时补充，保持 LIMIT 1000+1 与稳定排序。
- [x] summary 只取现存 arg_path 或 arg_skill；命令参数未提取时给 null，不解压正文、不扩 schema。
- [x] 保持已发布代与同步回退互斥，不能用陈旧同步结果补当前发布代缺值；避免每行调用 getRequest。
- [x] 合成服务所有 summary entries 返回新字段；已有 execMsOf 可用时复用，无法确定则 null。
- [x] 核查 adapter 需要的运行时对应校验；保持统一读取架构。
- [x] 跑本任务最窄测试，记录字段语义、查询成本与缺值边界。

### Task 3: 主 Agent 集成与浏览器验收

**Files:**
- 更新：本计划、对应 Agent Note、验收记录。
- 检查：两位实施者的差异、类型与读取边界。

**Interfaces:**
- 消费：Task 1 与 Task 2 的完整 diff、测试输出和已知限制。
- 产出：可审阅分支、按缺口编号的覆盖结果、明确的剩余限制。

- [x] 核对两个实施者接口一致，检查没有额外 Fetch、正文扫描、schema 变化或生产配置变更。
- [x] 执行一次集成类型检查和读取边界检查；先前通过的测试只在发现新变动影响时重跑。

```sh
bun run typecheck
bun test tests/read-boundaries.test.ts
bun run verify:notes
git diff --check
```

- [x] 在 worktree 起合成服务并加载同一份生产 web；不启动采集器或接触真实库。

```sh
bun prototypes/synthetic-server.ts
```

- [x] 浅深主题检查宽屏三行对齐、窄容器单列、多 Skill、长工具名、完整次数与失败数、hover 和键盘说明。
- [x] 检查 +N 独立开合、刷新恢复、会话隔离、调宽与折叠后 sticky；实际滚动测量吸顶，完整滚动定位路径本轮未重跑。
- [x] 检查请求结构、树图、工具目录与配对读数；阈值规则保持不变。各态缺值与转义由最窄测试覆盖，逐态浏览器样本未补造，范围见[验收记录](../../acceptance.md#方向-a-界面对齐修正合成2026-11-02)。
- [x] 独立审查整批差异；问题交由相应 Sub-Agent 修复，主 Agent 不接管实施。
- [x] 更新验收记录与计划复选框，报告已完成、未执行和待发布内容；提供英文提交信息，不代替用户提交或部署。

### Task 4: 用户授权发布与生产验收

**Files:**
- 更新：本计划、两篇 implemented bug-fix note、`docs/acceptance.md`。
- 检查：生产 `bun run service status`、`restart` 与新 pid；只读 API 与真实页面。

**Interfaces:**
- 消费：Task 1–3 的已提交分支与合成验收结果。
- 产出：master 上的 merge commit、生产验收段与真实页面证据；合成结果不改为生产结果。

- [ ] 发布前记录生产服务 pid、代码新鲜度与 local master 未被并行变动。
- [ ] 计划补入发布步骤，note 把「尚未部署」改为用户已授权发布、生产验收另记。
- [ ] 显式暂存本轮文件，`bun run verify:notes` 与 `git diff --cached --check` 通过后提交实现分支。
- [ ] 在 master 以 `git merge --no-ff` 合并实现分支，保留用户未提交的 note 修改。
- [ ] 合并后 `bun run service restart`，确认服务可读、src 版本新鲜、无旧服务消费新前端字段的窗口。
- [ ] 只读 API 与真实页面验收：新字段、目录、三行头部、+N、tooltip、主题、窄容器、配对耗时与吸顶。
- [ ] 在 `docs/acceptance.md` 新增生产验收段，记录提交与合并 hash、restart 结果、接口与 DOM 证据、未覆盖项。
- [ ] 确认分支已合并且工作区干净，移除实施 worktree 目录、保留分支名，并行 worktree 不动。
