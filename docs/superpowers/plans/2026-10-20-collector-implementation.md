# Collector 实施总入口

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 上述执行技能是否可用，以执行会话的技能列表为准；当前会话未提供它们。没有这些技能时，按任务顺序人工执行相同检查，不虚构调用，也不因此跳过测试与复核。

**Goal:** 将已有合成数据原型变成本机可持续使用的 magpie 请求记录器，完成真实元数据、正文、回收恢复和 AVA 切换。

**Architecture:** 单个 Bun 进程接收 hook、增量读取账本与路由，经同一个 SQLite writer 合并证据；查询使用独立只读连接。前端复用现有三栏布局与原生 JavaScript，正文按消息延迟加载。先证明持久化正确，再连接真实来源；回收、恢复和并行核对通过后才停 AVA。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib` zstd level 3、原生 HTML/CSS/JavaScript；不加生产依赖、前端框架、消息队列或 spool。

**Spec:** [architecture-design.md](../../architecture-design.md)、[project-overview.md](../../project-overview.md)、[architecture-review.md](../../architecture-review.md)。三份阶段计划必须与本入口一起读；本入口定义阶段间共同契约。

## Global Constraints

- 只监听 `127.0.0.1`；Host 只允许 `127.0.0.1:<port>`、`localhost:<port>`。
- 一个常驻进程、一个端口、一个 writer；SQLite WAL、`synchronous=NORMAL`，建表前设置 `auto_vacuum=INCREMENTAL`。
- 默认数据库位于 `~/Library/Application Support/agent-trace-collector/trace.db`，运行数据不进仓库。
- 账本轮询 5 秒，路由轮询 2 秒，reconciler 轮询 1 秒并响应 ingest 完成事件。
- collector envelope 上限 `64 MiB`；request、reply 分别上限 `32 MiB`。不把半截 JSON 当正文。
- 正文预算默认 `10 GB`，总磁盘上限默认 `16 GB`；80% 停新正文、95% 停新证据，采集缺口必须可查。
- 已验证 magpie 区间 `>=0.1.1294 <0.2.0`；越界仍启动并降级标记，持续做版本和形状探测。
- 一笔客户端调用对应一条顶层请求；`handed_on` 保留为尝试明细，`kind` 不用于推断尝试。
- 缺字段保留为 `NULL`，不补 0；金额区分 `priced / zero / unpriced / absent`。
- `have` 记录已经收到的证据，正文回收不清除位图。
- hook 认证后再检查 `origin=local`；脱敏在所有内容落盘和哈希之前完成。
- 第一版解析 `anthropic` 与 `chat`；`responses`、`gemini` 保存脱敏原对象，标 `unsupported`。
- direct 关闭；不接 S3 回填、不接 gateway-conversations、不扫描 Agent 会话文件、不导入 AVA 历史。
- 不做服务端正文全文搜索、规范哈希、引用计数、超大块预览替代或 zstd 字典。
- 测试只用合成数据。真实正文、账户、令牌、用户目录中的配置不能复制进 fixture、日志、截图或提交。

---

## 当前起点与交付拆分

计划于 2026-10-20 开始，2026-10-21 完成并修订。文件名保留创建日期。[项目定位](../../project-overview.md)顶部已限定版本拒启、direct和实时trace三处旧约定失效；相关实施以当前架构的越界降级、direct关闭、三路输入为准。额外收敛规则集中在本入口，其中涉及数据删除、推理正文保留的选择仍受上线门槛约束。

2026-10-20 检查时，collector 基准为 `0f6e510`，工作区干净。本仓只有研究、架构文档和 `prototypes/trace-reader-prototype.html`，没有 `package.json`、`src/`、`tests/` 或生产服务。环境可执行 `bun --version`，返回 `1.4.0`。架构中的历史性能与覆盖率仍是原文快照，本轮未重测。

建议把整套实施拆成以下三个可独立验收的交付。每份计划中的任务有具体文件、接口、失败用例、实现片段和验证命令。代码按 A→B→C 推进，合成验收随任务完成；生产接入另外遵循 A→B 合成链路→C1 容量保护→C2 恢复验证→C3 注册并行→切换。A 的阶段 0 物理收缩实验提前使用 C1 指定的独立临时库检查，不依赖后续生产模块。当前仅编写计划，不执行安装、接入或停服务。

| 顺序 | 计划 | 完成后可以使用什么 | 依赖 |
| --- | --- | --- | --- |
| A | [持久化与真实页面](2026-10-20-collector-foundation.md) | 合成恢复验证、只读账本/路由、真实会话与请求页面、through 费用状态 | 无；包含架构阶段 0 与第 1 步 |
| B | [正文与关联派生](2026-10-20-collector-body.md) | 薄 hook、脱敏内容库、两种协议、对话视图、乱序收敛 | A；对应第 2 步 |
| C | [保留、恢复与切换](2026-10-20-collector-retention.md) | 预算回收、缺口补采、恢复工具、并行核对、AVA 切换操作 | B；对应第 3 步 |

架构第 4 步 direct 不进入本次实施任务。其稳定身份尚未确定，相同字段不能证明同一调用；保持关闭就是第一版的完整交付，不预建 API 回填框架。

## 实施前统一的契约

以下是本计划提出的工程收敛规则，不能冒充上游保证。它们用于消除架构正文中的矛盾；涉及数据删除或正文保留偏好的事项保留在上线门槛中，不由实现者自行执行。

### 1. 文件身份与截断

`dev + inode + birthtime` 是基础文件身份，无法单独标识同 inode 原地重写后的内容。架构同时要求重写时换代、又要求截断后沿用代际；同一偏移出现新账本行时，后者会撞主键并丢行。

实现中保留基础身份，额外持久化 `rewrite_epoch`，最终 `file_generation = base_identity + ':' + rewrite_epoch`。正常追加绝不变 epoch；冻结的头部基线变化或当前 size 小于已提交偏移时递增 epoch。空文件首次观察不冻结零长度哈希，等第一次读取完整行时固定最多 64 KiB 的基线。打开 fd 后用 `fstat`，从同一个 fd 读字节，防止 stat 与 open 之间 rename。

无法证明两次代际的相同行是上游重放还是合法新记账时，保留两个物理观测并标 `source_rewritten`；不凭内容哈希删除一行。对同一 route 的完全重复计费候选，尝试总量标不确定，不把两代自动相加成确定金额。未被本轮观察到的 truncate-and-regrow 且冻结头部不变无法可靠检出，健康报告说明这个检测边界。

路由另按 `route_id` 幂等。`.gz` 按整文件摘要识别并全量解压；同日 `.jsonl` 和 `.gz` 都读，按 route 去重，优先保留 `.jsonl` 的同 id 记录。不能把新 gzip 的压缩偏移当账本身份。

### 2. 原始层过期与重建

原始层保留 7 天。`request_evidence` 的长期唯一约束是 `(source_kind, ref_key)`，一个证据最多归一个请求；保留 `payload_state=present|expired`，到期后链接明确变成已过期的来源引用。这样原始层清理后重扫旧文件仍可跳过已消费身份。

重建分两种：原始证据还在时可重算字段合并；原始证据过期后，只能用长期请求字段、路由摘要和仍在的正文重算标题、前驱、增量与工具关系。正文也已回收时，保留现有派生值并返回 `rebuild_unavailable`，不能把空正文重建成空对话。解析状态、算法版本、关联规则版本不能只放在会过期的 `raw_hook` 中。

### 3. 稳定顺序与归属

在 `request` 增加 `sort_source`、`sort_key`；优先使用最终账本证据的来源与字节偏移，其次路由 ID，最后 hook ID。字节偏移用数值比较或固定宽度编码，不能按普通十进制字符串比较。排序是 `(started_ms, sort_source, sort_key)`；`req_id` 只用于页面 keyset 的同时间兜底，不参与消息前驱判定。

内部会话键使用带类型的编码，例如 `JSON.stringify(['session', session])`、`JSON.stringify(['conv', conv])`，展示时仍可显示 `magpie-<conv>`。未知会话归属使用独立 `['request', stableKey]`，不能把所有NULL session聚到一起。hook未关联账本前没有可信subagent，长期保存 `actor=NULL, actor_state='unknown'`，不填公共哨兵；这类请求不入 `derive_queue`，不计算确定前驱或配工具。确认actor后再按新归属入队；原本已知的归属被撤回时，重算原组后继，本笔退回未知状态。

派生重算按 `(conv_key, actor)` 分批，单批最多 100 笔；未处理完的起点存入 `derive_queue`，下批继续，禁止截断后继链后悄悄丢弃余项。

### 4. 正文寿命与独立状态

每次收到 hook 的 `parse_state`、`reply_state` 和回复是否实际提供，要作为长期事实保存。`raw_hook.response_z IS NULL` 不能用来判定上游无回复，因为成功分块后该列也会被清空。

骨架保留脱敏后的 request 非消息字段、reply 原对象、协议和版本；消息块按原顺序保留，恢复出的 JSON 对象与脱敏输入深度相等。这里的相等指协议对象字段与数组顺序，不承诺还原 HTTP 原始空白或键序。unknown content block、图片引用、推理字段不能被适配器悄悄丢弃。

`unsupported` 原对象也移入长期骨架再清空 raw 副本，不能仅留在 7 天过期层。大 envelope 的元数据降级记录带原字节数和 collector 可观测原因；无回复与无 hook 分开。历史请求缺正文不自动显示前一笔正文。

### 5. 费用与尝试

through费用补齐属于A，不受direct开关控制。API按固定日期窗口分页批量取回，本地建立route候选索引并确认一对一关联；常态不按route逐条请求。初次回填账本涉及的历史日期，运行中重扫近期窗口并周期性复核旧窗口。offset没有跨页快照保证，重叠扫描与幂等只用于收敛，不能承诺一次扫描覆盖全部新增/修正。API只补费用，不替换文件token字段，也不把返回Row当新的顶层请求。

同一 route 出现多条账本和 API 行时，route 只用于寻找候选；还须比较原始 response ID、时间、status、handed_on 与用量等实际提供的字段。仅在可证明一对一时接受费用；候选仍重叠就保留 `absent` 和 `ambiguous_cost`，不能复制同一费用到每个尝试。最终费用与尝试费用分别计算，不能相加两次。

费用记录保存 `observed_at`、magpie 版本和 `pricing_version=NULL`。若 API 未提供定价版本，就明确 `pricing_version_unknown`；不能把采集时间或 magpie 版本伪装成定价版本。重新观察费用保留旧观测，当前展示选择最新确定观测。

### 6. 磁盘暂停与硬上限

单位在实现中固定：`GB=1_000_000_000`，`MiB=1024*1024`。80% 停正文，恢复到 75% 才重新接收；95% 停证据，恢复到 90% 才继续追赶。写前预估本批 DB/WAL/临时空间并保留至少 `max(256 MiB, 2 × 本批上界)` 的余量；正常摄入批次上限 128 行或 8 MiB，单条较大合法行独占一批。

暂停期间 `committed_off` 保持不动，只按A2返回的 `FileBatch.observedOff` 更新 `observed_off` 与按来源合并的缺口区间，不把stat文件长度冒充已读取位置。恢复后从 committed_off 补读；上游文件已消失时，缺口保留为 `unrecoverable`。hook 没有上游保留，暂停时返回明确拒绝，不能假装已经持久化。

架构中的 95% 停证据与继续推进提交游标不能同时成立。本计划采用上述双位置规则。默认也不自动淘汰长期元数据；淘汰会改变已约定的历史保留范围，C 提供先预览、后显式执行的命令。未批准淘汰时保持暂停，是可验收状态。

16 GB 是 collector 管理范围的容量目标。SQLite WAL、文件系统分配与同机外部程序写盘无法获得绝对数学上界；实现必须测实际文件字节、预留维护空间、限制写批，报告仍存在的超限风险，不能仅凭逻辑字节求和宣布硬上限已被证明。

### 7. 安全与故障确认

无Origin的页面API请求仅接受 `Sec-Fetch-Site: same-origin`，或独立的本地读取令牌。A4在服务启动前初始化 `<dataDir>/read.token`（32随机字节、0600、重启复用），本机curl/脚本读取并base64url编码后放入Authorization头；它与hook令牌分离，不注入前端、URL、日志或进程参数。首页仅接受精确 Host 和正常顶层导航；拒绝 `cross-site`、`Origin: null`、跨源 Origin，hook 也不允许浏览器跨站携带认证请求。绑定地址不能由环境变量改成通配地址。

正文、路由错误字符串、账本原始 payload 都走同一脱敏入口；账户定位字段只留本地专用列，公共 DTO 白名单不输出它们。脱敏占位符用本地持久化随机salt的HMAC，避免跨进程漂移和可逆的低熵明文摘要；A3在首次账本读取前初始化 `<dataDir>/redaction.salt`（32随机字节、0600），通过 `loadLocalSecret` 加载，并把同一个值传给账本/路由/费用和B3 hook。B1复用，不再首次生成。

宿主 `ctx.report` 只作为请求阶段聚合诊断能力出现在HookContext中，不能为onResponse的POST分类回报；当前固定源码的report闭包在请求阶段结束后已失效。薄hook自行检查网络/截止时间/HTTP与业务确认，失败记录安全的本地固定码；collector未收到的投递不伪造为已观测失败。保持best-effort与有界重试，不增加持久投递队列。

`NORMAL` 的事务确认覆盖进程崩溃恢复，不承诺整机掉电后每个 200 都持久存在。阶段 A/C 的故障报告必须区分这两类故障；本计划不暗改成 `FULL`。

## 文件职责

以下均相对 collector 根目录。目录按共同变化的职责分组；不做 repository/service/controller 三层包装。

| 文件或文件组 | 职责 | 首次创建任务 |
| --- | --- | --- |
| `package.json`, `tsconfig.json`, `.gitignore`, `README.md` | 运行、测试、类型检查与数据目录说明 | A1 |
| `src/store.ts`, `src/schema.sql`, `src/config.ts` | SQLite初始化、迁移、事务writer、配置校验；A1建 `collector_state`、`request_alias` 和会话时间索引 | A1 |
| `src/config.ts` 的本地secret初始化 | A3提供 `loadLocalSecret` 并初始化 `redaction.salt`；A4复用初始化 `read.token` | A3、A4扩展 |
| `src/sources/files.ts`, `src/sources/magpie.ts` | 完整行与文件代际；集中字段映射/形状/版本/API | A2、A3 |
| `src/reconcile.ts` | 物理证据、逻辑请求、尝试与来源关联 | A3，B3 扩展 |
| `src/privacy.ts` | 结构化脱敏、稳定占位符、日志白名单 | A3，B1 扩展 |
| `src/http.ts`, `src/queries.ts`, `src/main.ts` | 访问边界、查询 DTO、进程生命周期与轮询 | A4 |
| `web/index.html`, `web/app.js` | 从原型迁移布局，真实异步页面与数据渲染 | A5，B5 扩展 |
| `src/body.ts`, `src/protocols.ts` | 消息分块、骨架、还原、客户端协议适配 | B1、B2 |
| `plugins/collector.hooks.ts`, `src/hook.ts` | magpie 薄 hook；认证、尺寸、事务确认 | B3 |
| `src/derive.ts` | actor 内前驱、标题、增量、工具配对、重算队列 | B4 |
| `src/retention.ts`, `src/maintenance.ts` | 预算、回收、缺口、备份/恢复/重建命令 | C1、C2 |
| `scripts/verify-cutover.ts` | 并行统计与切换核对 | C3 |
| `docs/operations.md` | 维护、恢复和本地凭证使用；C3补切换/回滚操作 | C2，C3扩展 |
| `tests/*.test.ts`, `tests/fixtures.ts`, `tests/worker.ts` | 合成契约、子进程故障注入、受控时钟与文件 | 各任务 |

`prototypes/` 保留作为演示来源。生产页面不从演示 fixture 回退取值，不通过改造原型制造已接真实数据的错觉。

## 共用类型约定

类型定义各自跟随所属模块导出，不为单一实现创建抽象层。

```ts
// src/store.ts
import type { Database } from 'bun:sqlite';
export type Store = {
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T): T;
  close(): void;
};
// write 只接同步闭包；外部 I/O 与 await 全放事务外。

// src/queries.ts
export type Page<T> = { items: T[]; next_cursor: string | null };
export type CostState = 'priced' | 'zero' | 'unpriced' | 'absent';
export type BodyState = 'pending' | 'available' | 'partial' | 'evicted' | 'unsupported';
export type RequestRow = {
  req_id: number; conv_key: string; actor: string | null;
  actor_state: 'known' | 'unknown'; started_ms: number;
  title: string; status: number | null; model_requested: string | null;
  model_served: string | null; in_tok: number | null; out_tok: number | null;
  cache_read: number | null; cache_write: number | null;
  cost: number | null; cost_state: CostState; have: number;
  body_state: BodyState; miss_reason: string | null;
};
export type SessionRow = {
  conv_key: string; title: string; last_ms: number; request_count: number;
  agents: string[]; flags: string[];
};
```

`RequestDetail` 在 A4 定义，正文 DTO 在 B2 定义；列表永不包含 skeleton、消息或账户字段。SQL 列按架构定义创建，以上 DTO 只是对浏览器公开的子集。

## 验收与执行规则

每个任务先运行文中的单项失败测试，确认失败原因确实是缺行为，再补实现。同一任务通过单测和相关集成测试后提交，不反复跑无关全量测试。跨阶段执行 `bun test` 与 `bun run typecheck`；性能命令在独立临时库运行，不把机器抖动写成稳定承诺。

当前仓库在 `master`。开始实施时创建 `feat/collector-foundation` 等工作分支，或由执行会话的 worktree 技能创建隔离工作树；先检查工作区，保留他人改动。每次只暂存本任务的文件，所有提交消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。父仓只在子仓已有新提交且需要登记时更新 gitlink，本次不做。

生产上线前仍需用户决定两项：是否保留回复中的推理正文；是否授权磁盘紧急情况下淘汰最旧长期元数据。实现默认保持原始脱敏对象的保存能力，线上 hook 接入前明确推理配置；元数据淘汰默认关闭。S3 归档、direct 和多实例不阻塞前三阶段。

## 架构覆盖对照

| 架构要求 | 任务与验收 |
| --- | --- |
| 阶段 0、多计费行、事务恢复、完整行、gzip、物理收缩 | A1、A2、C1 |
| 三路事实、会话键、handed_on、费用、归属与字段存在性 | A3、B3、B4 |
| Host/Origin、独立令牌、local 过滤、脱敏、渲染转义 | A3、A4、B1、B3、B5 |
| 会话/请求/正文/路由/stats API、keyset、原型接入 | A4、A5、B2、B5、C1 |
| 内容哈希、整数引用、zstd 参数、骨架、raw 副本寿命 | B1、B2、C1 |
| 乱序、重复消息、父子代理、工具结果、派生版本/重建 | B4、C2 |
| 10/16 GB、80/95%、孤儿、原始层 7 天、路由长期层 | C1、C2 |
| 版本区间、持续形状探针、缺失与追赶中 | A3、A4、B3、C1 |
| 进程恢复、预算触顶、实际 DB/WAL、下线/回滚 | C1、C2、C3 |
| direct、请求归档、多实例 | 明确不实施；独立入口门槛保留 |

## 资料边界

本计划基于 collector 提交 `0f6e510d4d2c9e95f5dddbb52eb68f2b501a5ff8` 的文档和原型。原型入口与函数名来自当前文件；所有 `src/`、`web/`、`tests/` 文件均是计划创建，不能当作已有实现。

上游事实沿用项目研究登记的 `开源源码@magpie-2374ffe`：[yetone/magpie](https://github.com/yetone/magpie/tree/2374ffe161439b02a8e7f23b793461b39a635bf8)。源码契约不等于本机发布版已执行这些路径；阶段 B 上线前仍须用合成回调验证实际宿主形状。

## 本轮计划检查

2026-10-21 首轮检查确认了本地链接、围栏、36段示例语法及基础DDL可以合并；后续review指出，这些检查没有覆盖跨任务缺表和JS/TS消费类型，首轮检查不能据此宣布实施契约完整。

本次修订在保持13个实施任务的基础上增加以下检查：A1明确创建全部17张表，collector_state与request_alias的读写、外键及连续合并可执行；A4会话分页命中专用索引且无临时排序；40段TS/JS/JSON示例通过转译或解析。A5导出完整Reader类型，B5扩展正文方法，两阶段的JS导出与TS消费者通过TypeScript 5.9.3；实际运行旧请求不覆盖新选择、已回收正文返回原因两项合成测试，2通过、0失败。未知actor不入NOT NULL队列，salt/read token在首次使用前初始化，FileBatch明确返回observedOff。

这些检查覆盖计划示例的选定契约，不等于生产工程或所有任务测试已实现；未执行真实回调、线上费用同步、性能压测或恢复演练。生产模块尚未创建，任务复选框保持未完成。原架构正文未改；项目定位仅补限定旧契约失效的顶部说明。

## 评审处理记录

修订依据为2026-10-21对外部review的逐项核验。表中条号对应用户提供的11项意见；来源事实沿用上节固定物证，用户提供的真实行数与性能估算不写成本轮实测。

| 条号 | 处理 | 落点 |
| --- | --- | --- |
| 1 | 补collector_state、request_alias DDL，测试实际读写与别名外键 | A1、文件职责表、C2 |
| 2 | 采用日期窗口分页和本地匹配；撤逐route查询与逐秒route队列，说明上游缓存和offset边界 | A3、费用共同契约 |
| 3 | allowJs/checkJs、完整Reader JSDoc、窄ReaderFetch、resolver与nullable类型全部明确 | A1、A5、B5 |
| 4 | 保留actor=NULL；unknown不入队，不使用公共哨兵，归属确认后再派生 | A1、B3、B4 |
| 5 | FileBatch增加observedOff，区分已读、候选提交与stat长度 | A2、A3、C1 |
| 6 | 项目定位顶部标记三项旧约定失效，保留其余产品定位 | project-overview、docs索引 |
| 7 | read.token由A4初始化，供本地无Origin脚本使用，与hook令牌分离 | A4、安全共同契约、C3 |
| 8 | salt初始化前移A3并显式传给摄入；B1只复用 | A3、B1、B3 |
| 9 | 新增会话时间索引，查询使用行值范围比较，检查EXPLAIN | A1、A4 |
| 10 | 把既存docs索引改动纳入本次计划修订提交；不额外修改父仓gitlink | docs/README |
| 11 | 保留report真实签名，拒绝把它当onResponse投递回报；使用本地安全诊断与幂等重试 | B3、安全共同契约 |
