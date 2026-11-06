# 首页超时修复实施计划

> **For agentic workers:** 使用当前可用的 subagent 分工实施，主 Agent 逐项审查后整合。Task 1、Task 2、Task 3 可由不同 subagent 并行，只编辑各自代码和测试；共享 note 与 Git 暂存、提交由主 Agent 串行处理。Task 4、Task 5、Task 6 由主 Agent 串行完成。执行步骤用复选框跟踪。用户已授权实施。代码与合成回归完成，`61c14be` 已合并 `285ac99` 并部署；生产窗口显示部分改善，整体性能门槛尚未通过，待办保持开放。结果归[验收记录](../../acceptance.md#首页超时修复部署与回归真实生产2026-11-06)。Task 1–3 整合为同一修复提交，共享 note 由主 Agent 统一维护。

**Goal:** 消除已确认的 pending 历史范围扫描和 stats 宽表聚合，修正监控的实例变化误计，并用合成负载与生产持续窗口验证首页可用性。

**Architecture:** 保留 Bun 单进程、独立只读连接和单 writer。先改写查询以使用 v14 的既有索引，不改变 hook 缺席、迟到合并、统计输出和告警判定规则；生产正常摄入继续写入，不执行历史数据订正。

**Tech Stack:** TypeScript、Bun、bun:sqlite、SQLite WAL；无新依赖。

**Spec:** [现场证据](../../acceptance.md#生产首页超时排查只读2026-11-06)、[hook 缺席判定](../../../.agents/notes/implemented/bug-fix/2026-10-25-hook-absent-body-aging.md)、[读取功能接入规则](../../read-feature-rules.md)、[运维手册](../../operations.md)、[巡查程序](../../patrol.md)。

## 约束与范围

- TypeScript + Bun 单进程；不引第三方依赖，SQLite 用 `bun:sqlite`，压缩用 `node:zlib`。
- 测试只用合成数据；真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。
- 生产采集器由 launchd（`KeepAlive`）托管：起停走 `bun run service restart|stop|start`，不要 `kill`，也不要再手动起一个。
- 每个行为变更只跑能对该回归失败的最窄测试，提交前不重复已经通过的检查；全量套件与平台矩阵留给显式动作。
- 实现在仓库上级 `.codex-worktrees/atc-homepage-timeouts` 的 `fix/homepage-timeouts` 分支进行；master 只以 `--no-ff` 合并实现，合并后移除 worktree 目录、保留分支名。
- 这批首选方案保持 schema v14，以及 PURPOSE、GROUP、DERIVE 版本不变。不运行 rebuild、reparse、reset-source、capacity-recount 或 F09/F24 的存量订正。
- 用户通过开始落地授权执行本计划的实现提交、合并和生产部署；不包含 push、恢复覆盖或历史数据订正。

### 修复取舍

先给 `markHookAbsent` 增加语义等价的部分索引谓词。现场原查询沿 `i_req_time` 检查约 12.8 万条旧请求，追加谓词可改走 `i_req_body`，独立只读对照从 2 秒主动取消变为约 270 ms。270 ms 是单次观测，不是修复后的验收结果；合成负载和生产持续窗口仍必须过关。

stats 使用总请求数减去非 available 计数得到 available 数量。总请求计数可使用窄索引，非 available 分组由现有 `i_req_body` 覆盖；在同一个读事务里计算，维持空库不返回零计数组、状态顺序与快照一致性。

`reconcilePending` 本批不改。现场 1,579 条等待项只有 7 条带 response ID，请求候选点查只执行 7 次；它的重试策略、14 天孤儿 TTL 和返回计数不在本轮性能缺陷的最短修复路径内。保留对应回归，不删除等待项来降低指标。

如果现有索引方案仍达不到本计划的同步耗时和 HTTP 门槛，先按准备查询、队列反查、排序与 stats 分组拆分计时。证实候选回表仍是瓶颈后，另评估专用部分覆盖索引；不得在本批顺手加入启动建索引、schema 升级或新后台 Worker。

## 文件分工

| 文件 | 责任 |
| --- | --- |
| `src/hook.ts` | 缺席候选查询使用现有部分索引，维持判定与更新条件 |
| `tests/hook.test.ts` | 实际查询计划回归；复用已有迟到、NULL、歧义、批量上限用例 |
| `src/queries/stats.ts` | 用窄索引计算正文状态分布，修正文档注释中的缓存频率保证 |
| `tests/queries.test.ts` | 分布等价、空库、全 available、覆盖索引及写世代回归 |
| `scripts/monitor.ts` | 仅根据成功且有实例标识的样本统计实例变化 |
| `tests/monitor.test.ts` | 失败间隔不冒充重启、跨失败间隔的真实实例变化仍可见 |
| `scripts/perf-pending-stats.ts` | 新增显式合成宽行实验；不连接生产、不加入默认测试套件 |
| `.agents/notes/implemented/bug-fix/2026-11-06-homepage-timeout-query-scans.md` | 实施前记录取舍；合并时转为 implemented，并与原决策互链 |
| `docs/architecture-design.md` | 只补正文状态统计读取方式的现行事实 |
| `docs/patrol.md` | 补查询改动时的空命中与宽行性能回归要求，不复制阈值 |
| `docs/acceptance.md` | 追加合成、部署、真实流量和未覆盖项，保留排查历史 |
| `.agents/notes/LESSONS.md` | 收尾记录部分索引匹配与 LIMIT 不限制扫描工作量的教训 |

## Task 1：修复 hook 缺席候选查询

**Files:** `src/hook.ts:410`、`tests/hook.test.ts`。

**Interfaces:** 保持 `markHookAbsent(store: Store, now: number): number` 和 `reconcilePending` 的签名与返回值不变。候选仍按 started_ms 升序，每轮最多更新 200 行，NOT EXISTS 的 NULL 语义不变。

- [x] 进入实施时，先处理主检出中的本轮验收记录与本计划；获得提交授权后定向提交这些文档，再从当前 master 建实现 worktree。不得把其他会话文件混入提交。新 worktree 依赖按既有[工作规则](../../../.agents/notes/implemented/process/2026-10-28-implementation-worktree.md)处理。

```sh
ATC_REPO="$(git rev-parse --show-toplevel)"
ATC_WT="$(dirname "$ATC_REPO")/.codex-worktrees/atc-homepage-timeouts"
git worktree add -b fix/homepage-timeouts "$ATC_WT" master
```

- [x] 在 worktree 新建 proposed bug-fix note，Problem 链接现场证据；Proposal 说明保留 v14、复用索引；Alternatives considered 写明暂不新增索引、改队列重试或 Worker 化的依据。原 hook 缺席 note 与监控批次 note 仅部分相关，保留活跃，不归档；实现交付时更新其性能描述并互链。
- [x] 在 `tests/hook.test.ts` 追加一个回归，从真实 `markHookAbsent` 调用捕获 SELECT，再编译其查询计划。该文件已有 `fixture`、`seedLedgerRow`、`NOW`、`AGED` 和 `markHookAbsent` 导入，可复用：

```ts
test('无候选时缺席查询仍使用pending部分索引', () => {
  const f = fixture();
  const original = f.store.read.query;
  let sql = '';
  try {
    seedLedgerRow(f, 1, 'old', AGED, { missReason: 'hook_absent' });
    const query = original.bind(f.store.read);
    f.store.read.query = ((text: string) => {
      sql = text;
      return query(text);
    }) as typeof original;
    expect(markHookAbsent(f.store, NOW)).toBe(0);
    f.store.read.query = original;
    const plan = f.store.read.query(`EXPLAIN QUERY PLAN ${sql}`)
      .all(NOW - HOOK_ABSENT_THRESHOLD_MS, 200)
      .map(row => (row as { detail: string }).detail).join('\n');
    expect(plan).toContain('i_req_body');
    expect(plan).not.toContain('i_req_time');
  } finally {
    f.store.read.query = original;
    f.close();
  }
});
```

- [x] 先运行该用例，确认旧代码因查询计划仍走 i_req_time 而失败。

```sh
bun test tests/hook.test.ts --test-name-pattern '无候选时缺席查询'
```

- [x] 只在原候选 WHERE 中增加等价谓词，并用一句注释说明 SQLite 需要显式匹配部分索引条件：

```sql
WHERE body_state='pending' AND body_state!='available'
  AND (have & 1)=0 AND miss_reason IS NULL
```

生产 TypeScript 模板里的位常量继续使用 `${HAVE_BODY}`，不得改成另一份魔法数字。

- [x] 运行 `bun test tests/hook.test.ts`，保留既有 NULL response ID、歧义排除、等待关联保护、200 条续标、迟到 hook 两条清除路径，以及稳定歧义不重写、十项动作上限的断言。
- [x] 与 Task 2、Task 3 形成同一完整修复提交；按实际测试结果填写验证说明。

## Task 2：消除 stats 正文状态的宽表聚合

**Files:** `src/queries/stats.ts:58`、`tests/queries.test.ts`。

**Interfaces:** `getStats(store: Store): Stats`、`Stats.body_states` 和 HTTP JSON 字段不变。总数、各状态、游标与健康字段仍来自一个只读事务；写世代失效与 5 秒 TTL 不变。

- [x] 在 `tests/queries.test.ts` 使用既有 `insertRequests` 和 `fixture` 增加差分用例。空库、全 available、全 pending、六种合法状态混合分别建新 fixture；参考分组只在合成测试里执行。

```ts
test('stats正文分布与全量分组等价且不返回零计数组', () => {
  const cases = [
    [],
    ['available', 'available'],
    ['pending'],
    ['available', 'evicted', 'partial', 'pending', 'summary', 'unsupported'],
  ];
  for (const states of cases) {
    const f = fixture();
    try {
      insertRequests(f.store, 'synthetic-stats-states', states.length, false);
      f.store.write(db => {
        const rows = db.query('SELECT req_id FROM request ORDER BY req_id').all() as { req_id: number }[];
        rows.forEach((row, index) => db.run(
          'UPDATE request SET body_state=? WHERE req_id=?',
          [states[index]!, row.req_id],
        ));
      });
      const reference = f.store.read.query(`
        SELECT body_state AS state, COUNT(*) AS count
        FROM request GROUP BY body_state ORDER BY body_state`).all();
      expect(getStats(f.store).body_states).toEqual(reference);
    } finally { f.close(); }
  }
});
```

- [x] 增加实际 SQL 的计划回归：截取 `getStats` 执行中包含 `GROUP BY body_state` 的查询，用 `EXPLAIN QUERY PLAN` 编译；要求 `USING COVERING INDEX i_req_body`，不允许无索引 `SCAN request` 或分组临时 B-tree。先单跑这条计划回归，确认旧代码失败；行为差分在旧代码下通过是预期。
- [x] 将原 bodyStates 聚合替换为以下代码，保留它所在的读事务：

```ts
const bodyStates = store.read.query<{ state: string; count: number }, []>(`
  SELECT body_state AS state, COUNT(*) AS count
  FROM request WHERE body_state!='available'
  GROUP BY body_state ORDER BY body_state`).all();
const available = requests.n
  - bodyStates.reduce((total, row) => total + row.count, 0);
if (available > 0) bodyStates.push({ state: 'available', count: available });
bodyStates.sort((left, right) =>
  left.state < right.state ? -1 : left.state > right.state ? 1 : 0);
```

- [x] 修正 `getStats` 注释：写世代变化会立即重算，TTL 只约束进程外写入的缓存陈旧时间；删除最多每 5 秒重算一次的错误保证，不放宽实际新鲜度。
- [x] 运行 `bun test tests/queries.test.ts --test-name-pattern 'stats|getStats'`，覆盖新增等价与计划回归、既有写入后立即失效。HTTP 字段完整性留给 Task 4 的整合回归，不另造第二份端点。
- [x] 由主 Agent 在本批 note 中同步覆盖索引聚合的取舍，将该 note 与代码、测试一起暂存，运行 `bun run verify:notes:staged` 后与 Task 1、Task 3 一并提交。

## Task 3：修正 monitor 实例变化报告

**Files:** `scripts/monitor.ts:630`、`tests/monitor.test.ts`。

**Interfaces:** `buildReport(samples, nowMs, thresholds?, earliestArchived?)` 的参数和采样文件格式不变。失败样本继续参与失败次数、断档与告警判定；只从实例比较中排除。

- [x] 添加以下回归。已有 `sample`、`NOW`、`MINUTE` 和 `buildReport` 可直接复用：

```ts
test('失败样本不冒充实例变化，跨失败间隔仍识别真实变化', () => {
  const a = sample(NOW - 2 * MINUTE);
  const failed = { ...sample(NOW - MINUTE, {}, false), instance: null };
  const same = sample(NOW);
  expect(buildReport([a, failed, same], NOW).join('\n'))
    .toContain('进程实例未变化');
  const b = { ...same, instance: 'proc-b' };
  expect(buildReport([a, failed, b], NOW).join('\n'))
    .toContain('进程实例变化 1 次');
  expect(buildReport([failed], NOW).join('\n'))
    .toContain('进程实例未知');
});
```

- [x] 单跑新测试，确认旧实现将 A → null → A 算成两次变化。
- [x] 将相邻样本比较替换为成功样本的已知实例序列比较；保留报告其余内容：

```ts
let previousInstance: string | null = null;
let knownSamples = 0;
let restarts = 0;
for (const sample of samples) {
  if (!sample.ok || !sample.instance) continue;
  knownSamples += 1;
  if (previousInstance !== null && previousInstance !== sample.instance) restarts += 1;
  previousInstance = sample.instance;
}
lines.push(knownSamples === 0
  ? '进程实例未知（没有成功且带标识的样本）。'
  : restarts === 0 ? '进程实例未变化。'
    : `进程实例变化 ${restarts} 次；实例变化后不跨进程做计数差。`);
```

这段替换原报告中的实例变化输出，不能另追加一条重复结论。告警阈值、恢复窗口、失败样本字段与 `collectSample` 不改。

- [x] 运行 `bun test tests/monitor.test.ts`，确认原有断档、告警、恢复、日志与实例变化测试一起通过。
- [x] 由主 Agent 在本批 note 中同步失败样本与已知实例比较的取舍，将该 note 与代码、测试一起暂存，运行 `bun run verify:notes:staged` 后与 Task 1、Task 2 一并提交。

## Task 4：整合、显式负载与文档

**Files:** 新增 `scripts/perf-pending-stats.ts`，更新架构、巡查、验收和 note；回归涉及 hook、queries、http、monitor、metrics-light 与 patrol 测试。

**Interfaces:** 性能脚本只用自己创建的临时合成库，调用真实 `reconcilePending`、`markHookAbsent` 和 `getStats`，输出计数、逻辑载荷、计划与耗时，不读取本机 Agent 目录或生产配置。不新增生产运行选项。

- [x] 脚本沿用 `scripts/perf-capacity-meter.ts` 的临时目录、`openStore`、finally 关闭与清理方式。CLI 接受下面两种调用，其他参数退出 2；不接受数据库路径，因此不能误指向生产。

```sh
bun scripts/perf-pending-stats.ts --rows 8192 --payload-bytes 4096
bun scripts/perf-pending-stats.ts --rows 131072 --payload-bytes 16384
```

- [x] 参数须为正安全整数，最多 262,144 行、每行最多 65,536 字节、总合成载荷最多 3 GiB；先打印预计字节并检查临时目录可用空间不少于预计载荷的三倍，失败直接退出，不降规格冒充通过。
- [x] 使用下述数据构造 SQL；所有字段均为合成值，宽 BLOB 只用于重现表页读取成本，不承担正文可读性验收，不启动派生或真实来源适配器。每 1,024 行独立写事务，避免造数阶段把单个事务扩大为整个实验。

```sql
INSERT INTO request(
  req_id, conv_key, conv_source, actor, actor_state, agent,
  started_ms, day, via, body_state, derive_version, have,
  miss_reason, skeleton_z, created_at, updated_at
) VALUES (?, 'synthetic-perf', 'session', 'synthetic-actor', 'known', 'synthetic',
  ?, '2026-11-06', 'through', ?, 0, ?, ?, zeroblob(?), 1, 1);

INSERT INTO pending_hook(hook_id, response_id_norm, first_seen)
VALUES (?, ?, ?);
```

其中九成请求为 available/have=1，其余为 pending/have=0/miss_reason=hook_absent；时间全部早于一小时阈值。等待队列固定 1,579 条，7 条带不匹配的合成 response ID，其余为 NULL，first_seen 为实验 now 前一天，不触发 14 天 TTL。

- [x] 先做零候选轮次三次，再插入 201 条未标记的超龄 pending 请求。第一轮必须标记 200 条、第二轮 1 条、第三轮 0 条。每次测整个同步任务体，不能用 writer 提交时间代替候选准备耗时：

```ts
const started = performance.now();
reconcilePending(store, now);
const marked = markHookAbsent(store, now);
const pendingMs = performance.now() - started;
```

- [x] 测三次 stats 计算，每次调用前经 `store.write` 更新一个合成 collector_state 键，使缓存失效；计时仅包含 `getStats`。参考 GROUP BY 只在合成库上运行；六种状态的分布对照由单测覆盖，断言计数完全一致。输出首次、后续各次和 max，不把操作系统热缓存描述为真实冷盘。
- [x] 实验门槛是本次新增验收目标，不修改 monitor 常量：零候选与命中轮次的 pending 同步 max ≤500 ms，后续热轮次目标 ≤100 ms；stats 强制重算 max ≤250 ms。查询计划回归是硬约束，墙钟实验单独报告机器和规模。若越界，记录实际值并定位，不继续部署，也不自动加入 v15 索引。
- [x] 首次在修复前基点的合成库记录旧方案；候选代码在相同规格重新运行。大规模实验串行执行，不与别的 GiB 实验竞争 IO。此步骤是显式动作，不并入 `bun test`。
- [x] 主 Agent 审查差异与调用方后，运行一次整合回归：

```sh
bun test tests/hook.test.ts tests/queries.test.ts tests/http.test.ts tests/monitor.test.ts tests/metrics-light.test.ts tests/patrol.test.ts
bun run typecheck
```

- [x] note 转入 implemented：将 Proposal 改为 Decision，以真实交付改写结果；保留否决方案与未覆盖项。更新原 hook 缺席 note 中现有部分索引自动可用的错误描述，与本批 note 互链。监控批次旧 note 保留，只补当前机制引用；不复写本次验收数字。
- [x] 架构文档只记录 stats 的同快照窄索引聚合方式；巡查 C4 增加实际查询计划、空命中、候选满批与宽行载荷检查，门槛链接本批 note/实验，不把 500/250 ms 再抄一份。验收记录追加合成结果；LESSONS 对已有最慢同步单元条目补本次 pending 准备读的证据与 Seen 日期，不重复新建同类教训。
- [x] 暂存最终文件后运行 notes 门禁；未修改的测试不重复运行：

```sh
bun run verify:notes:staged
bun run verify:notes
git diff --cached --check
```

- [x] 取得提交授权后提交整合结果，记录候选分支 tip、主检出的发布前 SHA 和待合并范围。实际 `--no-ff` 合并留到 Task 5 停服且 bundle 成功之后，运行中的主检出不提前更换 src。工作区不干净或出现别的会话改动时，先定向协调，不做整库 stash、reset 或覆盖。合并冲突改到代码时只补跑受影响的检查。

## Task 5：生产部署与代码回退

**Owner:** 主 Agent。命令在主检出运行，不能在实现 worktree 里操作服务。具体命令与错误码以[运维手册](../../operations.md#起停与状态)为准。

### 部署前与停服窗口

- [x] 沿用已记录的 145 次采样/69 失败、主页 15–20 秒超时基线。部署前只再确认主检出、待发布 SHA、src 是否一致、launchd pid 与运行入口，不重跑原始重查询或全库 integrity_check。
- [x] 用只读连接确认生产 schema=14，候选 hook SELECT 计划使用 i_req_body，stats 非 available 分组使用覆盖索引。最多计时三次候选新查询，记录与合成实验的差别；不输出真实 ID 或正文，不执行 ANALYZE/optimize/建索引。
- [x] 在仍为旧生产代码的主检出下预检并停服；若在合并前做停服准备，代码合并只在停服后进行，避免服务中途装入新 Worker 或模块。候选回归通过后才进入这个窗口。

```sh
ATC_DATA_DIR="$HOME/Library/Application Support/tracery"
bun run maintain precheck --db "$ATC_DATA_DIR/trace.db"
bun run service stop
```

precheck 必须 `ok:true`、`state:in_place`、db/code 均为 14；stop 必须确认作业消失、端口释放。失败则停止发布，不使用 kill。

- [x] 在数据目录外制作新的 0700 私有备份父目录；bundle 目标必须尚不存在。备份包含数据库、盐与 manifest，生成后检查权限和 manifest，不打印盐。路径保存在本机验收材料中，不提交备份内容：

```sh
ATC_BACKUP_PARENT="$(mktemp -d "$HOME/Library/Application Support/tracery-homepage-20261106.XXXXXX")"
bun run maintain bundle --dir "$ATC_DATA_DIR" --out "$ATC_BACKUP_PARENT/bundle"
```

备份失败时确认主检出 src 仍为发布前版本，再按手册启动旧服务，记录停服时段；不带着失败备份继续发布。没有删备份的收尾动作。

- [x] 在停服期间完成已验证实现的 `--no-ff` 合并，记录 merge SHA；再次 precheck，确认 schema 仍为 14，然后只调用一次 start：

```sh
bun run maintain precheck --db "$ATC_DATA_DIR/trace.db"
bun run service start
bun run service status
```

readiness 失败、返回非预期 schema、启动退出或发生数据/输出正确性回归时，进入下面的回退流程。不得连续重启碰运气，不改 plist 指向 worktree。

### 回退方式

本批无 schema 或数据解释迁移。回退代码保留上线后的普通摄入数据，通常不需要 restore；从备份覆盖当前库会丢失新采集结果，不作为本次自动回退手段。

- [ ] 先 `bun run service stop`。在从当前 master 建立的 `fix/revert-homepage-timeouts` 分支，对本次发布的唯一 merge commit 做 `git revert -m 1`；有冲突时停止并解决，不 reset master、不切换到更旧的历史快照。
- [ ] 反向提交同样带本批 note 更新与英文提交说明，经 `--no-ff` 合并回 master；在主检出执行 precheck、start、status。回退后只读观察至少 5 分钟，报告仍可能存在的旧版超时，不能把启动成功写成已恢复。
- [ ] 若出现数据库损坏迹象，停止代码回退和采集，保留库、WAL、日志与 bundle，按运维手册单独制定恢复范围；本计划不授权恢复覆盖或历史数据订正。

### 性能不达标时的处理

正确性错误、无法启动、非预期 schema、持续 writer_failed 或新版本明显更差时回退。单次性能越界先判验收失败并归因；若新版本显著改善且没有正确性回归，可保持候选继续定位，记录为部分改善。不得只因一个 2 秒指标越界，就自动回到已有约 48% 采样失败的版本并声称恢复。

## Task 6：持续回归与真实页面验收

**Owner:** 主 Agent。HTTP 主动探针访问生产真实库，属于生产只读验收；只有临时合成库上的行为和宽行实验称为合成验收。

### 15 分钟窗口

- [x] start/readiness 完成后记录 `pid`、`instance`、发布 SHA、窗口起点和启动阶段的 loop/jobs 数值。稳定窗口至少 15 分钟；任一失败或自然流量不足时延长至 30 分钟，不能用重试覆盖首次失败。
- [x] 使用仓库外受限脚本，每 15 秒启动一轮，顺序 GET `/`、`/api/metrics`、`/api/stats`、`/api/sessions?limit=10`。每次独立超时 5 秒，不重叠堆积轮次；轮次超过 15 秒则跳过到下一轮，不追赶补发。记录每个端点实际尝试数、成功数、错误分类、状态码与 min/p50/p95/max。
- [x] 脚本只在内存中从 read.token 生成认证头，禁用代理；不打印认证头、完整响应、真实会话键、ID 或正文。读取 metrics 后只保留允许列表指标；sessions 仅保留列表条数、响应大小与耗时。

以下是本次建议的发布门槛，不是对 monitor 现有阈值的修改：

| 验收面 | 通过条件 |
| --- | --- |
| HTTP 可用性 | 四端点各至少 60 次实际尝试，成功率 100%，没有超时或非预期 4xx/5xx；延长窗口后仍保留首次失败 |
| 首页与轻量指标 | `/` 和 `/api/metrics` p95 ≤250 ms、max ≤1,000 ms |
| stats 与会话首屏 | `/api/stats`、`/api/sessions?limit=10` p95 ≤1,000 ms、max ≤2,000 ms |
| pending 同步任务 | 新进程累计 jobs.pending.max_ms ≤500 ms；同时检查 writer.hook_absent 与 writer.pending，不以提交耗时代替准备阶段 |
| 事件循环 | 成功样本 p99 ≤既有 330 ms，max ≤既有 2,000 ms；启动尖峰单列，不用重置指标、删样本或猜测固定环形窗口来宣称恢复 |
| 来源进展 | 有自然流量的来源游标或最新成功时刻前进，采集计数可见增量，admission 保持 normal，无新增 writer_failed；无流量来源标未覆盖 |
| 统计正确性 | 只读同快照核对 `requests = SUM(body_states.count)`，空状态不凭空补组；页面与接口字段保持一致 |

若启动尖峰仍保留在累计 max 或环形样本中，明确记录其归属，稳定段 max 无法单独取得时记为证据不足。不能把 lifetime max 的前后差当窗口 max，也不能假定 8,192 个 50 ms 采样总能覆盖固定 6.8 分钟；主线程阻塞会拉长实际时间跨度。

### monitor、契约与浏览器

- [x] 读取现有后台 monitor 的真实样本，稳定窗口内至少覆盖 3 个成功样本，不通过临时密集采样伪造后台连续性。必要时延长窗口；monitor 的 15 分钟恢复计时从第一次无命中判定开始，和 HTTP 窗口分别记录。
- [x] 执行 `bun scripts/monitor.ts inspect`、`bun scripts/monitor.ts report --days 1`。日报历史失败仍应保留，不能要求发布后 24 小时失败数归零；验证失败样本不再被算成实例变化。
- [ ] 确认 `service_unreadable`、`event_loop_max` 按既有恢复规则得到 recovered。15 分钟时仍在恢复等待则延长观察；其他既有告警逐项说明，不能写成全部正常。
- [x] 运行一次 `bun run patrol smoke`。六项均须按当前契约为 ok；不沿用旧文档里 F40/F41 的 200 基线。`weekly --if-due` 可报告本周跳过，但跳过不计为验收通过；本批不改摄入映射、schema 或容量策略，不为收尾强跑 dbstat/raw 属性全扫。
- [x] 使用 ego-browser 进行真实页面验收：主页连续重新打开三次；打开一个合并来源会话与一个纯本地会话；翻页、打开一条正文和右栏证据，再切回列表。记录首屏可用时间、HTTP 失败和浏览器错误，不把真实内容写进报告。若浏览器不可用，HTTP 验证继续，但页面验收明确未完成。
- [x] 整理最后状态：合成结果、部署停服时段与备份位置、HTTP 窗口、自然流量覆盖、monitor 恢复、页面操作及未通过项分别记录进验收文档。故障恢复、性能达标、自然流量覆盖和历史数据完整性不得相互替代。
- [ ] 合成与生产门槛通过后，任务才标完成；仅部分改善则保留待办和下一步归因。确认本轮 worktree 没有未提交文件后移除目录，保留实现分支名；不删除生产 bundle。

## 计划自检

- 修复证据、范围和原有判定分别有来源；没有把单次 270 ms 当成完成验收。
- 原有 schema、正文状态、迟到合并、写世代缓存、告警阈值和恢复规则保持原义。
- 实施分工包含代码、实际 SQL 计划、行为回归、显式宽行载荷、部署、回退和真实页面。
- 生产读取与合成数据实验分开；停止条件不依赖只有 writer 才能看见的耗时。
- 合成回归与类型检查的结果见[验收记录](../../acceptance.md#首页超时修复回归合成2026-11-06)。部署及生产复选框只随实际完成更新。
