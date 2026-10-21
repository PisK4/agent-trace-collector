# AGENTS.md — agent-trace-collector

agent-trace-collector 是本机 magpie 请求记录器：账本、路由与 hook 三路证据收敛进同一个 SQLite 库，查询走独立只读连接，浏览器页面负责按会话阅读正文。动手改核心目录前先读 [docs/architecture-design.md](docs/architecture-design.md)。

## 首版前立场：地基优先于兼容

首个 tag 发布前优先正确的地基：目录、命名与接口可以自由调整，同步更新全部引用。仓库已有本机真实数据，schema 变更必须带可执行的 backfill 或明确的拒绝路径，不靠原地改写掩盖错误的派生结果。

## 仓库布局

```
src/          采集、存储、派生、查询与 HTTP 服务
web/          浏览器阅读界面，原生 JavaScript
plugins/      magpie 薄 hook 插件
scripts/      回填、切换核对与 Agent Note 闸门
tests/        Bun 测试，只用合成数据
docs/         架构、评审、研究、运维与实施计划
prototypes/   界面原型与版式比较
.agents/      Agent Note 规则、决策记录与 kit 版本基线
```

## 命令

```sh
bun install
bun run start
bun test
bun run typecheck
bun run verify:notes
bun run maintain
bun run verify-cutover
```

### 本地跑相关检查

- 每个行为变更只跑能对该回归失败的最窄测试；全量套件与平台矩阵留给显式动作。
- 提交前不重复已经通过的检查。
- 提交前跑 `bun run verify:notes`，它同时检查活跃 note 的格式、归档封印，以及本次改动是否带 note。

## 常规约定

- **非平凡变更必须在同一提交里带至少一篇 Agent Note**。范围限于行为、跨文件或跨包契约、流程与工具、测试策略、磁盘或协议格式、配置格式；纯机械或局部编辑豁免，bug-fix note 可以写短。规则见 [.agents/notes/README.md](.agents/notes/README.md)。
- **每篇新 note 先做 supersession check**：在活动树里搜索覆盖同一决策或机制的旧记录，完全取代的 implemented 记录在同一变更里归档，部分取代的保持活跃并交叉链接。
- **决策不可改写**：implemented note 的事实跟随代码走，同一变更更新路径、符号与默认值；反转决策只能写新 note 并交叉链接。
- **归档区冻结**：`.agents/notes/archived/` 下永不编辑，不作为现行权威。
- **文档写现状，不写变更史**：previously、now、no longer 这类叙述进 commit 或 note，不进常备文档。文档分层见 [docs/AGENTS.md](docs/AGENTS.md)。
- **一个事实一个家**：架构与存储形状以 [docs/architecture-design.md](docs/architecture-design.md) 为准，运维步骤以 [docs/operations.md](docs/operations.md) 为准。note 只写为什么这样定、否决了什么、代价是什么，链接过去，不复述字段与默认值。
- **报告忠实**：不把重试、跳过、未执行描述为通过；合成数据验收与真实流量验收分开写。

## 栈特有约定

- TypeScript + Bun 单进程；不引第三方依赖，SQLite 用 `bun:sqlite`，压缩用 `node:zlib`。
- 监听地址写死 `127.0.0.1`，不读环境变量覆盖；数据目录在仓库外，文件权限 0600、目录 0700。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。
- 正文与路由内容在页面一律转义，不直接插 HTML。

## 上位文档

工作流规格与本仓库在父知识库的引用边界见父仓库根 `../../AGENTS.md`；中文写作遵守 de-AI-writing 与 `Agent知识库/docs/文档落笔风格.md`。
