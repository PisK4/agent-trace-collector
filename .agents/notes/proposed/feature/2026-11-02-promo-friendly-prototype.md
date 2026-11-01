# Agent Note: 宣传样片友好的合成明星会话与页面直达状态

Status: proposed

## Problem

ATC 正在拍一部 41 秒的产品宣传片（Remotion 工程，仓库外 `../../atc-promo/`，相对本仓库根）。拍摄链路：Playwright 无头浏览器（viewport 1920×1080、deviceScaleFactor 2、colorScheme dark）打开 `prototypes/synthetic-server.ts`（127.0.0.1:8770，加载生产 `web/index.html`）→ 静置约 2.5s → 整页与元素级 2x 截图加元素页面坐标 JSON → Remotion 把截图当纹理做 2.5D 运镜，把高亮环叠在真实 DOM 坐标上。宣传片只依赖三样东西：HTTP 页面、URL 直达状态、2x 截图稳定性，不依赖实现方式。

第一版样片已用现有四个功能验证会话拍完。这四个会话是按功能验证设计的（空状态排查、窗口分页、缺通道、轮次配对），撑第二版的主叙事有五个缺口：

- **没有叙事样本**：指标平淡、工具分布无主次、没有「顺利推进 → 真实失败 → 重试成功」的弧线，观众 3 秒看不懂 Agent 在干嘛。
- **treemap 缺 harness 类**：生产 `web/parts.js` 的 PARTS 登记表只有七类（system/tools/memory/files/results/chat/skills），真实数据里 harness 约占 10–19%，是演示的王牌类别，目前没有任何画面。
- **treemap 点开明细 404**：页面依赖 `GET /api/requests/:id/context-item`（生产实现 `src/http.ts:502`），合成服务器未实现，弹层只显示 HTTP 404。
- **状态不可 URL 直达**：拍摄不点击、全靠 URL 复现，但 cue-board 展开态、cue 条目支撑清单（`railSummaryListHtml`，`web/session-view.js:387`）、轮次定位都没有 URL 参数。
- **静置期间数据可能变动**：`web/reader-store.js` 的「作废即自动重读」10 秒冷却、无尝试上限，若合成数据存在持久 reading token 不匹配的记录，会在截图瞬间持续发请求。

本提案与[前端方向 A 重制提案](2026-11-02-frontend-direction-a-restyle.md)同方向：重制改变视觉语言，本提案保证样片数据与可达性，两份提案互为前提。红线不变：合成数据只是场景样本、不参与生产验收；服务只监听回环、不连真实库、不读令牌；合成时间基准用固定 `BASE_MS`（`prototypes/synthetic-server.ts:25`），渲染路径不引入 `Date.now()`/`Math.random()`；接口字段与生产类型一致（typecheck 同场检查）。

## Proposal

需求分八项，按优先级落地：

### 1. 明星会话（P0）

在现有四会话之外新增第五个并置顶（沿用 `startOf` 的 id 分桶，给它最新的 id 段与 `BASE_MS` 偏移）。

- **故事**：「给 CLI 工具加 `--json` 输出模式」——调研现有输出路径 → 设计序列化层 → 时间戳格式疑问 → 中途一次网关 500（部分回复保留）→ 重试换路成功 → 测试收尾。观众 3 秒能看懂。
- **规模与指标**：主链 41–52 笔（`protocol` 保持 `anthropic` 与 `chat` 混合），提示 token 总量约 208k，缓存命中约 93%，费用约 $0.42；首字 p50 约 0.42s、平均约 3.1s。数字自洽性见下方关键数字表，实现脚本从表生成。
- **工具量级**：Read 34 / Bash 22（2 次失败）/ Edit 17 / Grep 9 / Write 6；读路径 5 条、写路径 6 条真实文件名（如 `src/commands/json.ts`、`src/serialize.ts`、`src/formats/timestamps.ts`、`tests/json.test.ts`），两份清单不同。
- **失败弧线**：一笔 HTTP 500 嵌在漂亮数据里——保留部分正文、Event 行（请求失败 · HTTP 500）、prevRelation/confirmed 恢复关系，下一笔重试成功。
- **轮次带**：8 个已结算轮，chip 标题为人类可读疑问句（8–16 字，如「序列化时间戳用哪种格式？」「为什么管道里丢了换行？」）。
- **Aux 旁支**：2–3 笔（标题生成、会话分类，`purposeChain: 'exclude'`），不计入主链计数。

### 2. treemap 七类加 harness（P0）

明星会话的路由侧 prompt 分解覆盖全部八类：chat / files / results / harness / tools / system / memory / skills。`RoutePromptPart.kind` 是自由字符串（`src/queries/routes.ts`），合成数据可直接发 `harness`；但生产 `web/parts.js` 的 PARTS 登记表需要加一行 harness 映射，否则落灰槽、显示原名。面积目标（对齐 100%）：chat 38%、files 24%（内部 5 个文件子块）、results 15%、harness 9%、tools 8%、system 4%、memory 1.3%、skills 0.7%。图例行 token 数与百分比合计对上会话总量。

### 3. context-item 读端点（P0）

`prototypes/synthetic-server.ts` 路由表补 `GET /api/requests/:id/context-item`，语义照抄生产 `src/http.ts:502`：`if_reading` 必带（缺失或非法 400 `invalid_reading_token`），`kind` 必带（缺失 400），token 不匹配 409 `reading_changed`，未知 404。返回目录形状与 `web/context-detail.js` 消费端及 `tests/context-item.test.ts` 一致：若干条 ctx-d 条目（序号、消息定位、token 数、内容摘要）。明星会话 chat 类至少 6 条条目，files 类按文件 3–6 条。

### 4. URL 直达状态（P0）

新参数全部走 `web/url-route.js` 解析纯函数并在 `tests/url-route.test.ts` 加测试（现有模式照做）：

- `?expand=summary`：会话头 cue-board 内全部 `<details class="path-more">` 展开态（折叠点见 `web/session-view.js:202,224,259`）。
- `?summary=<kind>`：会话级阅读态，右栏出现 cue 条目支撑记录清单；kind 枚举与 cue 条目类型对齐（tools / skills / writes / reads 等），与右栏页签参数并存时互不覆盖。
- `?turn=<n>`：n 为轮次带 chip 序号（1 起），解析层翻译成该轮锚点请求号、复用现有 trace 选中路径，不新增独立阅读态；与 `?trace=` 并存时 trace 优先（更深链接）。

### 5. 截图稳定性（P0）

- `?demo=1`：页面进入 demo 模式——禁用自动重读，不做任何周期性读取与自动刷新，数据静止。生产无此参数时行为不变。
- 现状核实：`web/` 没有周期轮询定时器（仅两处 setTimeout：chip 移除与 auto-reread 冷却），networkidle 不达成的主嫌是 auto-reread 无上限循环与全会话加载的长尾请求；实现前先跑一次「静置 15 秒无请求」的实测确认触发面。
- 布局无竞态：数字保持 tabular-nums，字体加载完成（`document.fonts.ready`）后布局不再变；新会话时间偏移走 `BASE_MS`。

### 6. 多 harness 对照行（P1）

同一段工作流里 3–4 笔请求带第二个 harness 的对照行（Claude Code 主链 + OMP 对照）：`have` 通道位不同、行上来源徽标可区分、同一 response 双通道并存。对照行不计入主链 41–52 笔的计数。中栏行的分组渲染（两行并存不合并）在实现时验证。

### 7. 路由页签尝试链（P1）

明星会话 1–2 笔请求造两跳尝试链：第一候选（synth-b）超时/5xx，第二候选（synth-a）200。字段用现有 `SynthAttempt`/`AttemptChain` 形状（start_ms/ms/ttft_ms/served/status/fail），让路由页签演出「网关帮你兜底」。

### 8. 配套样本（P2）

agent 筛选 chip 至少三种值（Claude Code / OMP / Codex）；四个旧功能验证会话原样保留（空态/分页/缺通道/轮次配对样本仍有测试价值）；加载态与骨架屏保持现有样式（部分转场需要「数据到达前」的帧）。

## 关键数字表（字幕与文案直接取用）

| 项目 | 值 |
| --- | --- |
| 主链请求数 | 44 笔（anthropic 31 / chat 13）+ Aux 3 笔（不计） |
| harness 对照行 | 4 笔（不计） |
| 提示 tokens | 208k；缓存命中 93.2% |
| 输出 tokens | 17.4k；费用 $0.42 |
| 首字 p50 / 平均时长 | 0.42s / 3.1s；峰值 118 tok/s |
| 工具分布 | Read 34 · Bash 22（2 失败）· Edit 17 · Grep 9 · Write 6 |
| Read 路径 | `src/cli.ts`、`src/commands/json.ts`、`src/serialize.ts`、`src/formats/timestamps.ts`、`package.json` |
| Write 路径 | `src/commands/json.ts`、`src/serialize.ts`、`src/formats/timestamps.ts`、`tests/json.test.ts`、`tests/serialize.test.ts`、`README.md` |
| treemap 占比 | chat 38 · files 24 · results 15 · harness 9 · tools 8 · system 4 · memory 1.3 · skills 0.7（合计 100） |
| 轮次 chip | 8 个疑问句（见故事设定） |
| 失败-重试 | 1 笔 HTTP 500（synth-b 超时）→ 重试 synth-a 200 |

费用自洽口径：208k 提示 × 93% 缓存读 + 17.4k 输出，按当期模型价折算约 $0.42；表是唯一口径，实现从表生成，改数字先改表。

## Alternatives considered

- **demo 模式按 origin 判断**（监听端口 8770 即静默）：少一个参数，但把端口魔数写进生产页读取逻辑，且 `prototypes/serve-local.ts` 等本地服务同样非生产端口，判定面模糊。选 `?demo=1`：显式、可测（url-route 纯函数）、生产无参行为不变，拍摄 URL 多一段但无害。
- **`?turn` 做成独立阅读态**（与 `?trace` 平级的状态机分支）：状态机多一个正交维度，解析与恢复路径都要新增分支。选「翻译成该轮锚点请求、复用 trace 选中路径」：零新增阅读态，`?trace` 优先规则一行。
- **harness 只发合成数据、不登记 PARTS**：typecheck 不会拦（kind 是自由字符串），但页面落灰槽、显示原名，宣传画面难看；且若真实 magpie 数据已拆出该类，登记行本来就是欠账。登记 + 分配色槽是正解，色值随方向 A 重制的 token 表一并定。
- **复制一份 promo 专用页面**：违反 prototypes README「保留数据来源，不是界面副本」的边界，弃。
- **需求原稿的 treemap 占比**（40+26+16+9+5+10+memory+skills）：合计超过 100，与它自己的「图例数值自洽」验收冲突；本 note 关键数字表的占比为绑定口径。

## Acceptance criteria

1. `GET /api/sessions` 返回五个会话，明星会话排第一，标题无「（合成）」以外的告警标记。
2. `/?session=<明星会话>&trace=<失败笔>` 直达：中栏失败行有红色 Event 标记，右栏读数含 HTTP 500 与部分保留正文。
3. cue-board 资源行数字 ≥200k 级提示、缓存 ≥90%；工具/Skill/写入/读取组各有 ≥3 条真实条目；`?expand=summary` 直达后所有 details 展开。
4. `?summary=tools` 直达后右栏出现工具支撑清单，条目 ≥10。
5. `GET /api/requests/<id>/context-item?kind=chat&if_reading=<有效token>` 返回目录 JSON（非 404/400），条目 ≥6；token 缺失与不匹配分别返回 400 与 409。
6. treemap 覆盖八类含 harness，文件类 ≥4 个文件子块；页面截图目测面积比与关键数字表一致。
7. `?turn=3` 直达后中栏定位到第 3 轮锚点请求；与 `?trace` 并存时 trace 优先。
8. `?demo=1` 静置 15 秒无网络请求发出、无布局跳动。
9. `bun run typecheck` 通过；`tests/` 全绿，url-route 新参数、context-item 形状、明星会话数据形状各有新测试。
10. 四个旧会话行为与之前一致（回归）。

## Risks

- **context-item 消费形状漂移**：以 `web/context-detail.js` 与 `tests/context-item.test.ts` 为准取最小子集；漂移由 typecheck 与测试钉住。
- **auto-reread 触发面评估不全**：本 note 只核实了无周期定时器与 auto-reread 循环；实现前先做 15 秒静置实测，若还有别的请求源，按实测扩 demo 静默面而不是按推测。
- **多 harness 对照行的中栏分组**：同一 response 两行并存的分组键在 `row-summary` 的现有逻辑下是否成立需实现时验证；若合并，调整合成行的 call_id 关系而不是改生产分组逻辑。
- **treemap 面积是 24 列 grid 近似**：面积比不承诺精确等于 token 比，验收口径是截图目测。
- **PARTS 加 harness 行是生产视觉变更**：需要分配色槽（现有 p1–p7）与色值；与方向 A 重制的 token 映射同批定稿，避免两次改色。
- **旧四会话回归**：新增会话动了共享的会话列表与 id 分桶（`startOf`），四会话的既有测试是安全网，动了就修数据不动测试口径。
