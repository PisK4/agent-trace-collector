# 工作教训

本仓库的代码由 Agent 写、审、提交。这里记录在本仓库反复踩的工作方式错误：规则、证据与可执行防护。改代码前先读与本次改动相关的章节。

这里不是决策记录。为什么这样设计、否决了什么，写进[Agent Note](README.md)；单次缺陷的完整复盘写进 bug-fix note；每个会话都要遵守的稳定规则写进根 [AGENTS.md](../../AGENTS.md)。一条教训稳定成测试、脚本或常备约定后，从正文删除并迁入对应家；本文件末尾只保留一行迁移指针与证据锚点。

当前维护方式是任务收尾自检，没有夜间 review。非平凡任务结束前，把本次踩到、下次还会踩的坑追加一条；同一坑再次出现，在 Seen 行补日期。同一规则在三个不同日期出现，或防护已经变成测试、脚本、常备约定，就晋升。

## 条目格式

**一句话祈使句规则。**
- 证据：commit、文件与行、日期，说明当时错在哪。
- 防护：可执行动作，命令、测试或检查项。
- Seen N× (日期列表).

## 派生与版本

**升算法号时，容忍窗口与测试钉子一起动。**
- 证据：2026-11-01 Hermes 修复把 `PURPOSE_VERSION` 7 升到 8、`GROUP_ALGORITHM` 6 升到 7、`DERIVE_ALGORITHM` 10 升到 11；容忍窗口漏移会把前一代工具事实误判为未知，全量套件靠两处测试钉子抓出漏改。
- 防护：升号后 grep `algo ===`，再 grep 测试里的 `GROUP_ALGORITHM).toBe`；位置包括 `src/semantics.ts`、`src/derive/state.ts`、`src/queries/session-summary.ts` 的两处窗口、`tests/session-summary.test.ts` 与 `tests/derive-slice.test.ts`；合并前跑全量 `bun test`。
- Seen 1× (2026-11-01).

## Worktree 与提交

**合并被并行会话的在途文件挡住时，定向 stash 该文件、合并、再 pop，不整库 stash、不代提交。**
- 证据：2026-11-03 合并 fix/websearch-subevent-cards 时，主检出里另一个会话对同一 note 文件有未提交的 F26 修复记录，`git merge` 以 "local changes would be overwritten" 拒绝；分支改动（F31/F32 状态行）与在途改动（F26 段落）分处同一文件不同段落。
- 防护：`git stash push -m <说明> -- <path>` → `git merge --no-ff` → `git stash pop`；pop 前确认两批编辑不在同一行段。整库 stash 会把对方所有在途文件一起卷走。
- Seen 1× (2026-11-03).

**暂存后又改了同一文件，提交前重新 `git add` 并用 `git diff --cached` 核对最终内容。**
- 证据：2026-11-02 `bb27546` 的 note 暂存后又被改成 implemented 骨架，index 仍是 Proposal/Acceptance criteria；`3ba7c8b` 补发 Decision/Consequences，`docs/acceptance.md` 记录这次返工。
- 防护：`git add <paths>` 后跑 `git diff --cached --stat` 与 `git show :<path>`；确认 index 是最终版本再 commit。
- Seen 1× (2026-11-02).

**note 要交给其他会话接手时，先提交进 `proposed/`，别把唯一副本留成 `??`。**
- 证据：2026-11-04 `5a102e1` 提交 `proposed/bug-fix/2026-11-03-migration-failure-autorebuild.md` 时注明「这是设计的唯一未跟踪副本，接 F23 的 agent 看不到」。
- 防护：交接前跑 `git status --short .agents/notes`；有 `??` 的提案先 add 并提交，再让对方基于该检出工作。
- Seen 1× (2026-11-04).

**用生产库副本起本地预览时，先 rebase 到 master、用 `sqlite3 .backup` 拷贝，并带上 `redaction.salt`。**
- 证据：2026-11-04 会话切换预览，分支基点 schema v10、生产库 v11，启动报 `schema_version_unsupported`；`bun run maintain backup` 报 `backup_failed:source_must_be_stopped`（备份要求源采集器停止）；数据目录缺 `redaction.salt` 时启动报 `redaction_salt_missing`。3.9GB 库用 `sqlite3 .backup` 约 3 分钟。
- 防护：预览前 `git rebase master`；`sqlite3 <prod>/trace.db ".backup '<tmp>/trace.db'"`；复制生产目录的 `redaction.salt`（0600）到 `ATC_DATA_DIR`；用独立 `ATC_PORT` 起，不碰生产 8320。验收完成后删掉整个临时目录（含库与 salt），保留生产原件。
- Seen 1× (2026-11-04).

## 验证

**改过 JS/TS 后，提交前跑 `bun run typecheck`；`bun test` 不检查 JSDoc 类型。**
- 证据：2026-11-01 `9a97ed9` 才补 `web/app.js:1018-1019` 的 `headResizeObserver`/`observedHead` 注解，并单独合并为 `ba40614`；2026-11-02 `cb30675` 才补 `web/icons.js` 两处映射与 `web/trace-view.js:556` 的参数注解，修掉 3 处 TS7053/TS7006。
- 防护：合并前跑 `bun run typecheck`；只动 web 的 JS 也跑，JSDoc 由 tsc 检查。
- Seen 2× (2026-11-01, 2026-11-02).

**带 note 的提交先跑 `bun run verify:notes:staged`；master 直提也算。**
- 证据：2026-11-04 `a9c6d74` 在 master 直提 `proposed/bug-fix/2026-11-04-timing-safe-equal-stdlib.md`，缺 `## Proposal` / `## Acceptance criteria` / `## Risks`，全量 `verify:notes` 至今报红。
- 防护：提交前跑 `bun run verify:notes:staged`；新增或移动 note 的 commit 不走合并也跑。
- Seen 1× (2026-11-04).

**`list.param` 是分组键，展示文案放 `label`。**
- 证据：2026-11-02 方向 A 第 5 步第一版把 `param` 传成 `${name} 的调用`，对组永不命中、失败数恒 0；测试直接传 meta 测不到这条装配路径，真实后端同样中招，靠合成数据 curl 对比抓到。
- 防护：改 `summaryList` 的取数后，用合成页面 curl 对比 chip 与页头计数；参数摘要从 `arg_path`/`arg_skill` 读，不从 `param` 反解。
- Seen 1× (2026-11-02).

**`bun:sqlite` 的 `get`/`all` 参数按位置逐个展开传，不能塞进一个数组。**
- 证据：2026-11-04 droid 摄入测试把组键写成 `.get([JSON.stringify(['session','s1'])])`，SQL 只收到一个数组参数，查询恒 0 行，误判成派生队列没入队；改成 `.get(JSON.stringify([...]))` 才命中。
- 防护：按 SQL 占位符数量逐个传参；带参数的断言先跑同一查询的无参版本核对总行数，再收紧到参数形状。
- Seen 1× (2026-11-04).

**新增常驻采集路径时，先给它留测试注入点，测试不能落回真实 home。**
- 证据：2026-11-04 会话适配器接入 `sessions` 定时器后，`startCollector` 直接读 `process.env`/`homedir()`，三个既有 main 测试在开发机上把真实 `~/.claude` 的行写进合成库，断言从 droid 行变成 claude 行；改成 `CollectorOptions.sessionAdapters`/`sessionRoots` 注入后才隔离。
- 防护：凡是启动时读本机目录或环境变量的路径，同时提供 options 注入；单测一律传合成根，缺省值只在生产与显式启动里生效。
- Seen 1× (2026-11-04).

**门禁报红先确认文件是否属于本批改动，再判断是否自己引入。**
- 证据：2026-11-03 全量 `verify:notes` 在 `.agents/notes/implemented/feature/2026-11-03-live-session-activity-and-navigation.md` 报 implemented 格式错，该文件是并发会话尚未跟踪的迁移中途产物；本批改动在 `--staged` 与 `--range` 两处均通过。同一轮还有 7 个历史批次真的缺 note，不能因为存在并发文件就全部当成误报。
- 防护：报红文件先跑 `git ls-files <path>`，输出为空说明未跟踪、归并发会话；本批范围单独跑 `node scripts/verify-change-notes.mjs --range origin/master..HEAD`；历史缺口逐批看提交信息里有没有 `Agent-Note: none`。
- Seen 1× (2026-11-03).

## 依赖与命名

**引入 `t` 前，先查同作用域里叫 `t` 的局部变量。**
- 证据：2026-11-04 i18n 批次，app.js 三个事件委托的 `const t = e.target`、tileSpec/chip/resourceGroup 的参数 `t` 共六处遮蔽翻译函数；typecheck 只抓到其中两处——`t !== null` 比较与 `t instanceof HTMLDetailsElement` 静默指向错误对象，靠逐行手查才清干净。
- 防护：web 模块 import t 前 `grep -n "const t = \|(t) =>" web/<file>.js`；对事件委托区额外核对裸 `t`（无点、无括号）引用，typecheck 不兜底这个坑。
- Seen 1× (2026-11-04).

## 方案与回填

**预测重派生/判据变更的效果前，先查存量行的 `body_state` 与 `purpose_version` 分布。**
- 证据：2026-11-03 WebSearch 子事件方案立项时推断「version bump 后 64 张 conv 卡会被新判据收走（bypass）」；落地时只读核查发现 69 个 conv 行全部 `body_state='pending'` 且已存 `purpose_version=10`，正文不可读走 `unavailableDecision` 的 retained 保留，新判据根本执行不到，69 键 rebuild 是无效果写库。新判据只对 `purpose_version` 为空的新行生效。
- 防护：任何「bump/重派生会翻转存量行」的结论，先用只读 SQL 按 `(body_state, purpose_version, purpose_status)` 分组数一遍；retained 优先于新判据是设计行为，不是 bug。
- Seen 1× (2026-11-03).

## 查询与并发

**守卫类修复要按「守卫放行后的每组成本 × 预计放行面」复测退化，不能只测零命中态。**
- 证据：2026-11-04 F26 候选①（指纹短路）在零命中态实测 1.5 ms，部署后参与链指纹随流量增长、守卫对每个真实会话组放行，qt 驱动的相关子查询回到 O(current 组数)×页内指纹会话数，原始 SQL 75 ms；模拟页内 50 组指纹 367 ms。候选① 的 note 里本就写了这条退化预警，但当晚验收只对了零命中口径。
- 防护：给「仅当 X 才执行的昂贵分支」做修复验收时，先估 X 的增长面，再造出 X 满铺的合成态测一遍（本次用 `UPDATE` 副本把 top-50 组全部置指纹模拟）；EXPLAIN 断言钉住驱动表形状（`SEARCH t` 而非 `SEARCH qt`）。
- Seen 1× (2026-11-04).

**全同步查询的并发合并只在同一宏任务内生效，测试要区分「同 tick 并发」与「跨宏任务并发」两个口径。**
- 证据：2026-11-04 F27-A 单飞测试里 5 个 `handler()` 同 tick 发出，`listSessions` 调用数等于 1 次；生产上各请求是独立宏任务，同步查询执行期间事件循环被占住，后续请求进不来，等它完成时 map 已清理——热查询（40 ms）下 5 并发各跑各的（墙钟 188 ms），合并只对冷页慢查询这种「查询在途跨宏任务」的形态有意义，而全同步查询根本不会跨宏任务。
- 防护：给同步查询做请求合并时，先确认查询会不会让出事件循环；不会让出的，合并的收益上限就是「同 tick 重复」，跨请求合并要靠缓存或 Worker 化，报告里如实分开写。
- Seen 1× (2026-11-04).

## 已晋升到常备规则

晋升后的条目在这里保留一行规则名、日期与证据锚点；规则正文只在它的新家。

**新 worktree 的依赖软链与 `info/exclude`。**
- 证据：2026-10-25 新建 worktree 后 `tsc --noEmit` 找不到 `@types/bun`；规则正文见[落地方案在 worktree 分支里做](implemented/process/2026-10-28-implementation-worktree.md)的「依赖」节。