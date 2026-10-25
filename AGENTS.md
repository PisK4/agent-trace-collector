# AGENTS.md — agent-trace-collector

本机 magpie 请求记录器：账本、路由与 hook 三路证据收敛进同一个 SQLite 库，查询走独立只读连接，页面按会话阅读正文。改核心目录前先读[架构设计](docs/architecture-design.md)。

## 首版前立场：地基优先于兼容

首个 tag 发布前优先正确的地基：目录、命名与接口可以自由调整，同步更新全部引用。仓库已有本机真实数据，schema 变更必须带可执行的 backfill 或明确的拒绝路径，不靠原地改写掩盖错误的派生结果。

## 命令

```sh
bun install
bun run start          # 127.0.0.1:8320
bun test
bun run typecheck
bun run verify:notes   # 提交前
```

- 每个行为变更只跑能对该回归失败的最窄测试，提交前不重复已经通过的检查；全量套件与平台矩阵留给显式动作。
- `bun run maintain` 与 `bun run verify-cutover` 必须带子命令，裸调用只打印 usage 并退出 2；命令与恢复步骤见[运维手册](docs/operations.md)。
- `verify:notes` 检查活跃 note 格式、归档封印与本次改动是否带 note。纯机械改动豁免：提交信息写 `Agent-Note: none — <reason>`，暂存阶段用 `ATC_NOTE_EXEMPT=<reason>` 放行。来由见[变更闸门](.agents/notes/implemented/process/2026-10-21-change-note-gate.md)。

## 常备约定

- **非平凡变更必须在同一提交里带至少一篇 Agent Note**，判据见 [Agent Note 规则](.agents/notes/README.md)；纯机械或局部编辑豁免，bug-fix note 可以写短。
- **报告忠实**：不把重试、跳过、未执行描述为通过；合成数据验收与真实流量验收分开写。
- 测试只用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。
- **不装本地 git hook**：闸门是 `.agents/KIT-VERSION` 基线下显式执行的 `verify:notes`，kit 升级也是显式动作，见[接入 agent-kit](.agents/notes/implemented/process/2026-10-21-adopt-agent-kit-notes.md)。
- **一个事实一个家**：架构与存储形状归[架构设计](docs/architecture-design.md)，运维步骤归[运维手册](docs/operations.md)，术语归 [CONTEXT.md](CONTEXT.md)，对外介绍归 [README](README.md)，验收结果归[验收记录](docs/acceptance.md)；note 只写为什么这样定、否决了什么、代价是什么。文档分层与文风归[文档标准](docs/AGENTS.md)。

## 栈特有约定

- TypeScript + Bun 单进程；不引第三方依赖，SQLite 用 `bun:sqlite`，压缩用 `node:zlib`。
- 依赖方向单向：`config`（叶子，不 import 仓库内其他模块）← `store` ← 引擎与读模型，见[五个放错层的符号归位](.agents/notes/implemented/architecture/2026-10-23-symbol-relocations.md)。
- **Harness 专属用途判定走静态登记**：新 Harness 的强指纹写成 `src/harness/<name>.ts` 的判定函数，在 `harness/purpose.ts` 的登记数组加一行，数组次序即优先级；分派与结算不另写品牌分支，`semantics.ts`、`request-purpose.ts` 及消费端不出现 Harness 名称比较，也不建只转发通用行为的空壳 adapter。见[harness 语义 adapter](.agents/notes/implemented/architecture/2026-10-26-harness-semantics-adapters.md)。
- **共享解释规则不悄悄加 agent 门控**：输入包装、OMP 归档锚点与 Claude 技能标题格式的定义留在 `input-interpretation.ts` 与 `capabilities.ts`，对未知与空标签同样生效；收紧门控是行为变化，先列反例、升 `PURPOSE_VERSION` 并按显式重建交付，不混进重构提交，纯移动不升版、不开重建。
- `main.ts` 只做 wiring（timer、防重入锁、配置装配、进程日志），任务体归持有对应概念的 module，见[定时任务体归位](.agents/notes/implemented/architecture/2026-10-23-main-orchestration-delegation.md)。
- 监听地址写死 `127.0.0.1`，不读环境变量覆盖；运行数据在仓库外，文件 0600、目录 0700，其余边界见[安全边界](docs/architecture-design.md#安全边界)。
- 正文与路由内容在页面一律转义，不直接插 HTML。
- 界面不加多余的二级标签与说明文字，让布局解释结构：分组、间距、对齐与表面明度差承担解释职责；正常态不带装饰性状态，异常才出现标签。见[前端降噪常备约束](.agents/notes/implemented/process/2026-10-24-frontend-denoise-standing-rule.md)。

## 目录与上位文档

目录一眼可见，只有三处不显然：`prototypes/` 只提供数据源、加载同一份生产页面；`plugins/` 是给 magpie 的薄插件；`.agents/` 是 note 规则与 kit 版本基线。工作流规格与本仓库在父知识库的引用边界见父仓库根 `../../AGENTS.md`；中文写作遵守 de-AI-writing 与 `Agent知识库/docs/文档落笔风格.md`。
