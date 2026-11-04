# Agent Note: 开源门面：英文 README、CI 与死链清理

Status: implemented

## Problem

仓库对外，但读者只能访问仓库自身。三类东西挡在门口：

- **仓库外引用。** 根 `AGENTS.md` 指向父知识库与父仓库根的规则文件；`docs/` 与 note 里散着父知识库路径、其他本地仓库、本机私有 Skill、未跟踪的 `.archify/` 工作产物、未公开前身项目 ATA 的源码路径。读者点进去全是空。
- **相对链接路径错。** 46 处 Markdown 相对链接指向不存在的文件，多数是 note 在两个生命周期目录间移动后没有跟着改深度，少数是目标文件改名。
- **没有对外入口。** 全仓文档纯中文，README 没有安装前置、没有徽章、没有贡献说明。陌生人 clone 下来不知道要先装 Bun，也不知道点开哪个地址看页面。

另有一处名不副实：README 引用徽章要能反映真实状态，而仓库没有任何 CI，放了也只是装饰。

## Decision

**加 CI，让徽章有依据。** `.github/workflows/ci.yml` 在 ubuntu 上跑 `bun install --frozen-lockfile`、`bun run typecheck`、`bun test`，固定 `bun-version: 1.4.4`，`fetch-depth: 0` 供需要历史的检查使用。`verify:notes` 不进 CI：它按 `origin/master..HEAD` 判定变更批次，在 PR 场景下语义不对，留给维护者本地执行。

**README 双版，其余文档保持中文。** `README.md` 重写为英文，`README.zh-CN.md` 保留中文版，两版互链。英文版自包含：一句定位、徽章、截图、两条摄入进路、快速开始（先合成数据看界面，再接真实流量）、隐私与数据落点、边界、与观测平台的分工、命令、文档索引、贡献、许可。中文版与英文版同构，不承载英文版没有的内容。

**死链按可修性分四类处理，不做统一遮蔽：**

- 相对链接路径错：按 basename 在仓库内唯一匹配重算相对路径，改不了的人工判定。39 处自动修复，其余逐条核对。
- 父知识库与父仓库引用：删除或改写成通用表述（「不随仓库发布」「仓库上级目录」）。
- 本机私有 Skill（ponytail、de-AI-writing）：只留英文名，不链接、不解释。
- 未跟踪的工作产物（`.archify/` 参考库与样张）：整段删除引用，改成「本地工作产物，不随仓库发布」。
- 未公开前身项目：`AVA` 与 `ATA` 的名字保留（它们解释了设计来路），在首次出现处加一句「作者的私有项目，不在本仓库」，不逐处改名。

**`package.json` 补开源元数据。** `version`、`repository`、`homepage`、`bugs`、`engines.bun`、`keywords`，并加 `demo` 脚本。保留 `private: true`：这个包不发布到 npm，标记可以防止误发布。

**`docs/acceptance.md` 与 `docs/architecture-design.md` 的事实基线加范围声明。** 两处的数字、端口、pid 与耗时来自作者机器，说明当时怎么判断，不是可复现的基准。

**社区文件按英文写。** `CONTRIBUTING.md` 与 `SECURITY.md` 用英文，与英文 README 一致：它们是陌生人读的第一批文件。`CHANGELOG.md` 用 Keep a Changelog 格式，当前只有 `[Unreleased]`——没有打 tag 就不编版本号，不写未发布的日期。issue 模板用 YAML 表单，把「不要贴真实请求正文」写成表单顶部的硬提示，而不是指望提交者点开安全政策。PR 模板带一条中英文 README 同步的勾选。

**数据目录默认值改为按平台选根。** `src/config.ts` 之前写死 `~/Library/Application Support/agent-trace-collector`，Linux 用户会把库落进 `~/Library`。新增 `defaultDataDir(env, platform, home)`：macOS 走 `~/Library/Application Support`，其余走 `XDG_DATA_HOME` 或 `~/.local/share`。目录名当时沿用仓库名而不是产品名 Tracery：改名会让已有数据的用户找不到自己的库。后来按[统一改名为 Tracery](2026-11-04-rename-to-tracery.md) 用停→移→起的显式迁移改成了 `tracery`，这条理由随迁移窗口消解。四个 backfill 脚本原本各自硬编码同一路径，改为调用这个函数。

## Alternatives considered

- **把 `docs/` 与 note 全部英文化。** 对外最友好，代价是 20 多篇中文文档的翻译与长期双写维护。这次只做 README，其余保持中文并在英文 README 里明说。
- **把 `AVA` 全量改名为「旧采集器」。** 106 处，其中 `--ava` 参数与 `ava_schema_*` 错误码是真实 CLI 契约，不能盲目改。加一句说明的成本远低于全量改名，且保留历史可读性。
- **不加 CI，只放静态徽章。** 测试数徽章会迅速过期，写着 passing 的徽章没有 workflow 支撑属于误导。加 CI 是让徽章诚实的最小代价。
- **修掉 archived/ 下的死链。** 归档是冻结快照，规则明文禁止编辑，三条死链留在那里。
- **给数据目录加 Windows 分支。** 写 `LOCALAPPDATA` 看起来更完整，但 `readLocalSecret` 靠 `mode & 0o077` 校验 0600，Windows 上这个校验不成立，整条路径跑不通。写出来只会让 Windows 用户以为能用。改为在 README 明说不支持 Windows。
- **把 `LOCALAPPDATA` 与 `XDG_DATA_HOME` 一起做进同一版。** 首次实现时确实加了这个分支，测试立刻抓到问题：`node:path` 的 `join` 用宿主分隔符，注入的 `platform` 只切换分支、不切换分隔符，构造出来的 Windows 路径是混着反斜杠与正斜杠的假路径。这正说明该分支不可验证，索性不做。

## Consequences

- **两份 README 要同步维护。** 改功能描述、命令或截图时两版一起改，否则中英文会分叉。
- **对外阅读面仍是中文。** 英文读者只有 README 一条完整路径，深挖设计要读中文文档。术语表给了英文对照，是当前的补偿手段。
- **徽章依赖 CI 运行。** 首次推送后才有状态；`tests-1163` 是静态徽章，测试数变化时需要手动更新。
- **相对链接会再次腐坏。** 本次修完没有加自动检查。note 在生命周期目录间移动仍会带来同类死链，值得后续加一个链接检查脚本进 `verify:notes`。
- **已有 macOS 用户不受影响。** 默认路径在 darwin 上没变，Linux 新用户才落到 XDG 目录。四个 backfill 脚本也因此跟着走配置，不再各自硬编码。
- **不支持 Windows 现在是明说的。** 之前是默认行为跑不通、文档不提；现在 README 与 CONTRIBUTING 都写清楚，issue 模板没提这一条，靠模板的环境字段兜住。
- **`engines` 只声明了 `>=1.4.0`。** 更早的 Bun 版本未验证，低于此版本由包管理器提示，不是运行时兜底。

## Testing

- 全仓 markdown 相对链接检查：0 处真实死链。剩余 6 处命中是正文里的正则表达式与反引号内的占位示例，不是链接。
- `bun run typecheck` 通过；`bun test` 1163 通过、0 失败（91 个文件），与 README 的测试徽章一致。
- `bun test tests/config.test.ts` 2 通过：darwin、linux、freebsd 三个平台分支与 `XDG_DATA_HOME` 覆盖各一例。
- `bun test` 全量 1165 通过、0 失败（92 个文件）。
- `git grep '父知识库\|父仓库\|repos-external\|/Applications/magpie\|Agent知识库'` 在跟踪文件里零命中（`archived/` 之外）。
