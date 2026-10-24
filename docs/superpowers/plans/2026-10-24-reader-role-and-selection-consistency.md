# Reader Role and Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让英文角色标签、中栏选择与右栏来源一致，修复阅读缓存和内容缺口，并纠正 Chat System 用途取数、未适配协议能力状态及多 choice 工具身份冲突。

**Architecture:** 沿用现有 Module 分工：正文解释提供协议事实与内容类型，`body-view` 与 `trace-view` 生成可定位的阅读项，`reader-store` 管理有界读取与版本，`app.js` 装配选择和展示。每个步骤保留请求输入或回复的真实路径；当前回复不追加到输入消息数组。展示修复走读侧；用途和工具配对修复复用现有版本与按会话重算入口，不增加长期步骤表、不改变 schema、不重排消息 ord。

**Tech Stack:** TypeScript、Bun、原生 JavaScript、原生 DOM、`bun:test`，不引第三方依赖。

**Spec:** [阅读角色、步骤定位与缓存一致性提案](../../../.agents/notes/implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)；现行读取与存储依据见[架构设计](../../architecture-design.md#协议适配)。

## Global Constraints

- 所有 tag 使用英文：`System`、`User`、`Assistant`、`Tool`；用途和记录使用 `Aux`、`Event`；正文说明用中文。
- 工具调用属于 Assistant，内容类型为 `Tool call`；工具结果属于 Tool，内容类型为 `Tool result`；原始协议 role 保留并可查看。
- 不靠 `<system-reminder>` 等正文标签推断协议角色；混合 user 消息按块解释，不整条改成 Tool。
- 不增加依赖；固定4并发、40条历史分片、首轮最多两片增量，剩余提供显式续读。
- `messages` 序号、输入计数、可信 delta、前驱关系和 `owner + callOrd` 不因展示调整而改变。
- 409后作废并显示重新读取入口，不无限自动重试；旧响应不能清除新记录。
- 测试只用合成数据，真实正文、账号、令牌和配置不进 fixture、日志或提交；真实库仅做有界只读核对。
- 正文与路由内容全部转义，System内容同样遵守这一规则。
- 本计划针对本机单用户阅读与已有长会话预算，不以本轮结果宣称5rps容量目标达成。
- 本轮是评审与方案，运行代码未修改。前端评审基线为 `076ba6d`；评审期间并行工作继续调整用量折叠行，经差异核对未覆盖本提案的缺陷。实施时先检查当前工作区，保留最新右栏布局及其他并行修改。
- 提交需要用户明确要求；下述commit文本是建议，执行测试不等于获得提交授权。当前环境未列出上面模板提及的两项superpowers执行技能，可按本计划直接在会话中逐步实施，不伪称已调用。

---

## 文件职责

| 文件 | 本次负责的事实 |
| --- | --- |
| `src/protocols.ts`、`src/capabilities.ts` | 协议读取状态、能力可判定性和单 choice 工具抽取；保留未适配原对象 |
| `src/request-purpose.ts`、`src/semantics.ts` | 只读取用途需要的 System 块，版本化结算与显式历史升级 |
| `src/derive-decision.ts`、`src/derive-state.ts`、`src/maintenance.ts` | 工具身份的共同判据、算法版本和既有按会话恢复入口 |
| `src/input-interpretation.ts` | 保留既有服务端用户输入解释，展示角色变化不重写输入语义 |
| `web/body-view.js` | 一套角色标签与内容块类型；原始role、System字段和消息块详情 |
| `web/trace-view.js` | 纯步骤投影、System/Tool结果步骤、来源位置与稳定键 |
| `web/reader-store.js` | reading token的记录所有权、整笔失效、定点读取与增量消费 |
| `web/app.js` | 同一选中来源驱动右栏、已读并集、未读区间、续读与重新读取入口 |
| `web/index.html` | 英文标签宽度、单步骤高亮、来源位置提示 |
| `tests/body-view.test.ts`、`tests/trace-view.test.ts`、`tests/reader-store.test.ts`、`tests/web.test.ts` | 与上述Interface相同入口的合成反例 |
| `tests/reader-types.ts` | 新增角色、步骤来源与读取状态的类型约束 |
| `docs/architecture-design.md`与相关Agent Note | 交付后的现行机制与决定依据，各自保持唯一归属 |

## Task 1: 修复阅读版本与记录所有权

**Files:**
- Modify: `web/reader-store.js` 的 `fetchDetail`、`readRequest`、`readRange`、`readToolResult`、`readRoute`。
- Modify: `web/app.js` 的 `ensureRead`、`loadStructure`、`readToolResult`，清除展示副本并呈现重新读取入口。
- Test: `tests/reader-store.test.ts`、`tests/web.test.ts`。

**Interfaces:**
- Consumes: `createReaderStore(fetcher)`；`RequestDetail.reading_token`；现有 `reading_changed` 错误。
- Produces: 保留 `readRequest(id, validate?)`、`readRange(id, from, to)`、`readToolResult(id, ord)` 和 `invalidate(id)` 的Interface；同一请求的可用快照均来自同一token。409作废当前记录，下一次普通读取重新走详情和0/0元信息。

- [ ] **Step 1: 加入会在旧实现失败的版本回归。** 复用现有 `detail`、`bodyPage`、`harness`、`respond` 测试工厂：

```ts
test('token变化重新读取回复元信息', async () => {
  let token = TOKEN;
  const h = harness(url => {
    if (url.endsWith('/api/requests/1')) return respond(detail(1, { reading_token: token }));
    return respond(bodyPage(0, 0, 0, {
      request_fields: { system: token === TOKEN ? 'old-system' : 'new-system' },
      reply: { content: [{ type: 'text', text: token === TOKEN ? 'old' : 'new' }] },
    }));
  });
  const store = createReaderStore(h.fetcher);
  await store.readRequest(1);
  token = TOKEN2;
  const next = await store.readRequest(1, true);
  expect(next.meta?.request_fields).toEqual({ system: 'new-system' });
  expect(next.meta?.reply).toEqual({ content: [{ type: 'text', text: 'new' }] });
  expect(h.count('/body?from=0&to=0')).toBe(2);
});
```

- [ ] **Step 2: 补409与竞态回归并运行。** 现有正文/工具409用例去掉后续 `readRequest(1, true)` 中的 `true`，断言普通读取也取得新token；用两个独立resolve门控制旧请求409和新版本成功的先后，断言旧409不能删除新缓存。再加 `invalidate(1)` 后旧详情迟到的用例，旧Promise必须拒绝或返回明确失效，不能返回旧可用快照。执行 `bun test tests/reader-store.test.ts`，旧实现至少在meta和普通409重读处失败。

- [ ] **Step 3: 在store实现完整重置和当前记录校验。** token变化分支加 `rec.meta = null`。每个异步读取在回写前同时校验会话代次、`reads.get(id) === rec`、捕获的token；失败抛 `reading_changed`。正文和工具catch中在校验当前记录及token后调用 `invalidate(id)`，清页面区间Promise不能代替整笔作废。详情首次读取与validate读取串行到同一记录：同一读取合并inflight，validate在已有旧读取完成后再拉一次详情，不能复用旧读取当成验证完成。路由缓存随同一记录失效。

- [ ] **Step 4: 统一app的失效展示。** 将正文与工具失效都传入同一个请求失效处理函数，清 `reads`、该owner的全部 `toolReadings` 和 `routes`；记录失效后渲染说明与显式读取按钮。删除工具409分支中的自动 `ensureRead`。重新读取按钮先取得新detail/meta再按当前选中来源读取所需块，不悄悄复用旧选中正文。

- [ ] **Step 5: 验证并准备提交。** 运行 `bun test tests/reader-store.test.ts tests/web.test.ts`。同步更新[阅读缓存记录](../../../.agents/notes/implemented/feature/2026-10-24-reader-store-cache.md)的实现事实并交叉链接本提案。建议commit：`fix(reader): invalidate complete snapshots when reading versions change`。

## Task 2: 统一角色解释并补齐System阅读

**Files:**
- Modify: `web/body-view.js` 的 `roleOf`、`roleTag`、`messageEntries`、`renderMessages`、`renderMessageDetail`。
- Modify: `web/trace-view.js` 的 `TraceStep`、`projectSteps`、`renderTraceRows`。
- Modify: `web/app.js` 的 `traceHtml`、`railBody`；`web/index.html` 的tag样式。
- Modify only if required: `src/input-interpretation.ts`、`src/protocols.ts`的读侧返回解释；不能仅凭页面需要改变长期消息角色。
- Test: `tests/body-view.test.ts`、`tests/trace-view.test.ts`、`tests/reader-types.ts`。

**Interfaces:**
- Consumes: `BodyPage.request_fields`、`messages`、服务端`interpretations`、`reply`、可信`delta_ordinals`。
- Produces: `Entry`保留`role`和`rawRole`，内容块继续使用`kind=text/call/result/thinking/other`；`TraceStep.kind`保留已有行为类型并增加`system`和`tool_result`，不拿tag文本驱动点击行为。显示映射为`user→User`、`assistant/tool→Assistant`、`tool_result→Tool`、`system→System`、`aux→Aux`、`record→Event`；现有`tool`仍表示工具调用，内容类型显示Tool call。步骤来源明确为：

```ts
type StepSource =
  | { side: 'request'; path: 'request.system'; messageOrd: null; blockIndex: null }
  | { side: 'request'; path: string; messageOrd: number; blockIndex: number | null }
  | { side: 'reply'; path: string; messageOrd: null; blockIndex: number | null };
type TraceStepKind = 'user' | 'assistant' | 'tool' | 'tool_result' | 'system' | 'record' | 'aux';
```

System和结果步骤打开正文来源；只有`kind=tool`且`callOrd`有效时打开现有工具四页。Aux/Event的source为null，打开该请求读数。

来源path使用实际协议路径，例如 `request.messages[3].content[0]`、`request.system`、`reply.content[1]`、`reply.choices[0].message.tool_calls[0]`。不得从摘要文本反查路径。未知role显示Unknown，rawRole原样转义显示。

- [ ] **Step 1: 写角色与混合内容回归。** 在现有body工厂中构造Assistant文本+tool_use、User中的tool_result+真实文本、Chat tool消息、developer消息。断言调用主角色Assistant、结果块Tool，混合消息仍保留User文本；输入序号不变；rawRole分别保留assistant/user/tool/developer。断言 `roleTag('assistant')` 返回 `Assistant`，英文tag无中文标签。

- [ ] **Step 2: 写System投影回归并运行。** 第一笔的 `request_fields.system='base'`、消息ord1为system、回复含工具调用；断言顶层System有独立来源键、ord1有原消息路径、输入总数不变。同actor的已确认前驱在窗口内且可读时，system同值不重复、不同值标明变化；前驱不可读或不在窗口时只声明当前请求上下文，不能宣称变化，跨actor和分支不能按相邻时间比较。执行 `bun test tests/body-view.test.ts tests/trace-view.test.ts`，旧实现缺System步骤并失败。

- [ ] **Step 3: 在既有正文归一化里生成唯一显示解释。** `roleTag`只管理显示文本，CSS使用单独稳定的role类名，不以显示大小写作为class协议。`messageEntries`记录原始role，按块分别解释call/result；消息级列表用主role加内容类型，展开后逐块显示，工具结果正文不冒充用户输入。System字段复用已保存`request_fields`，不伪造负ord或把System塞进`messages`。

- [ ] **Step 4: 扩展步骤投影。** 保留可信delta的限制，除用户输入外提供真实System消息和工具结果的步骤。回复中的调用显示Assistant + Tool call，callOrd保持原值；工具结果显示Tool + Tool result。同一混合消息按块生成独立稳定键，并只产生一次真实用户文本步骤。`traceHtml`只把同actor已确认前驱的System比较结果交给投影，前驱不可用时仅显示当前上下文；不按时间猜前驱，不增加持久摘要或第二套服务端指纹。

- [ ] **Step 5: 验证与同步类型。** 扩展`reader-types.ts`的kind联合和来源类型断言，调整英文tag最小宽度及窄屏布局，运行 `bun test tests/body-view.test.ts tests/trace-view.test.ts tests/input-interpretation.test.ts tests/protocols.test.ts` 和 `bun run typecheck`。更新[步骤投影决定](../../../.agents/notes/implemented/feature/2026-10-24-trace-step-projection.md)的部分覆盖关系。建议commit：`fix(reader): align role labels and expose System context`。

## Task 3: 以选中来源定位右栏

**Files:**
- Modify: `web/app.js` 的 `selectRequest`、`railFacts`、`railBody`、结构消息点击及工具列表点击。
- Modify: `web/body-view.js` 的消息块和回复块详情。
- Modify: `web/index.html` 的请求组和步骤高亮。
- Test: `tests/web.test.ts`、`tests/trace-view.test.ts`。

**Interfaces:**
- Consumes: Task 2 的 `TraceStep.source`、`key`、`callOrd`；Task 1的版本化读取。
- Produces: `state.selectedStep`是当前步骤的唯一选择，右栏来源从该步骤解析。`toolOrd`继续确定工具详情，结构历史浏览与当前步骤有明确返回关系。

- [ ] **Step 1: 加定位测试。** 合成一笔回复依序为text0、call1、text2、call3，四次选择分别断言右栏定位`reply.content[0..3]`，两个文本不再都显示整份回复。输入消息选择断言`request.messages[N]`，顶层System选择断言`request.system`；未知块仍可读转义JSON。测试应调用导出的纯来源解析函数，DOM装配只消费结果。

- [ ] **Step 2: 加截图形状回归。** 请求A输入两条、reply含ponytail；请求B输入四条、reply含memmy。断言A的输入计数仍为2，选择ponytail指向A的回复调用；选择memmy指向B的回复调用；工具结果按配对指向B中的结果块，不能按时间跳到下一笔辅助请求。

- [ ] **Step 3: 最小化选择装配。** `selectRequest`取得对应step后保存来源并按其类型设置页签。右栏在固定位置显示当前步骤路径；请求输入与本次回复分区保留，点击回复步骤展开并滚到对应块。输入选择如果目标ord未缓存，调用一次`readRange(id, ord, ord + 1)`并保留当前选择。右栏结构内再选消息时同步当前选择；返回整笔回复明确清除步骤选择。

- [ ] **Step 4: 修复高亮与可访问性。** `.compact-select[aria-current=true]`承担明确选中样式，请求组去除相同底色，必要时仅保留轻微边界。更换页签或工具调用时同步选择提示；同一请求只有一个步骤处于当前状态，键盘焦点不被重绘丢失。

- [ ] **Step 5: 验证并记录。** 运行 `bun test tests/trace-view.test.ts tests/web.test.ts`。用合成浏览器场景验证两文本两工具、System、输入与结果位置，检查选择期间没有读取下一笔无关请求。建议commit：`fix(reader): locate inspector content by the selected step source`。

## Task 4: 保留稀疏已读内容并提供增量续读

**Files:**
- Modify: `web/app.js` 的 `structureFoldHtml`、`loadWindowReads`和续读click处理。
- Modify: `web/reader-store.js` 的 `loadDelta`。
- Modify: `web/trace-view.js` 的剩余/错误读取记录。
- Test: `tests/reader-store.test.ts`、`tests/web.test.ts`、`tests/trace-view.test.ts`。

**Interfaces:**
- Consumes: `RequestRead.entries`、`structure.next/ords/total`、`delta.next/done/error`。
- Produces: 连续历史游标保持原义，结构展示已缓存消息的有序并集，空洞有未读说明；`loadDelta(id, pages=2)`可重复显式消费，失败不消费未读ord。

- [ ] **Step 1: 写结构反例。** `structure.next=40`、`structure.ords=[0..39]`、`entries=[0..39,99]`、`delta={99}`，断言`structureFoldHtml`同时包含`data-msg="99"`、40–98的未读说明和下一片按钮，游标仍为40。再测无缓存与已回收状态，不能显示伪空列表。

- [ ] **Step 2: 写两片后续读和失败回归。** 合成81条可信输入，首次两片80条后断言delta未完成且页面有继续入口；再次调用读取ord80后完成。另返回total=2但messages为空的成功HTTP页，断言done保持false、next不动、error为固定原因；重试成功后两条均可见。

- [ ] **Step 3: 实现并集与未读说明。** 去掉`structureFoldHtml`按`structure.ords`删掉缓存尾部的过滤，按ord排序`entries`，相邻ord不连续时插入未读范围说明。仍由`loadStructure`推进历史游标，不以Map最大键替代连续边界。所选消息优先显示，折叠开合不让它从列表消失。

- [ ] **Step 4: 接上续读与错误入口。** 初始两片后 `delta.done=false` 的请求出现一条Event读取入口，显示剩余条数；错误状态显示失败与重试。点击后再消费两片，经原4并发队列读取。`loadDelta`在每片返回后验证所需ord均实际拿到，再推进消费；遇缺口抛固定错误并保留未消费位置。不做全会话自动排空。

- [ ] **Step 5: 验证并同步决定。** 运行 `bun test tests/reader-store.test.ts tests/trace-view.test.ts tests/web.test.ts`。更新阅读缓存与生产视图Note的实现事实，记录两套游标和未读范围仍然存在。建议commit：`fix(reader): retain cached tail messages and resume pending deltas`。

## Task 5: 修复 Chat System 用途取数与历史恢复

**Files:**
- Modify: `src/request-purpose.ts` 的 `readPurposeViewTx`；`src/semantics.ts` 的 `PURPOSE_VERSION`。
- Reuse: `src/request-purpose.ts` 的 `upgradePurposeTargetTx`、`src/maintenance.ts` 的 `rebuild --session`、`src/derive.ts` 的 `rebuildDerived`。这些入口已有作用域和排空逻辑，回归发现缺口时才修改。
- Test: `tests/request-purpose.test.ts`、`tests/maintenance.test.ts`；需要直接覆盖组消费者时使用 `tests/derive.test.ts`。

**Interfaces:**
- Consumes: `readBodyMetaTx` 的严格骨架读取、`request_block.role=2`、`readPurposeTaskTx(db, reqId)`、`classifyPurpose(view)`、现有用途 CAS 和按会话升级入口。
- Produces: Chat 与 Anthropic 相同 System 信号得到相同用途；`PURPOSE_VERSION` 从评审基线 2 提升到实施时的下一个版本。普通 tick 不升级已完成历史，显式会话重建才升级目标并排空用途与组。

- [ ] **Step 1: 写跨协议取数回归并确认失败。** 在 `tests/request-purpose.test.ts` 使用现有工厂。该工厂目前把 stop 写入 `stop_sequences`；语义解释同时支持该键与 Chat 的 `stop`，另用 `persistBodyTx` 覆盖标准 Chat `stop` 形状，不为此新增生产兼容层。

```ts
test('用途视图读取 Chat System 消息中的分类器指纹', () => {
  const f = fixture();
  try {
    const fingerprint = 'You are a security monitor for autonomous AI coding agents.';
    const id = seedPurposeRequest(f.store, {
      convKey: 'chat-system', agent: 'claude', protocol: 'chat',
      messages: [{ role: 'system', content: fingerprint }, { role: 'user', content: 'synthetic input' }],
      stop: ['</block>'],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    const task = readTask(f.store, id)!;
    expect(task.view.systemTexts).toEqual([fingerprint]);
    expect(classifyPurpose(task.view)).toMatchObject({
      status: 'recognized', kind: 'auto-mode-classifier', chain: 'exclude',
    });
  } finally { f.close(); }
});
```

运行 `bun test tests/request-purpose.test.ts`。补 developer、Anthropic 顶层 System 对照、普通 System 不误判的用例；旧实现至少在 Chat System 断言处失败。

- [ ] **Step 2: 只读取用途需要的 System 块。** `readPurposeViewTx` 在骨架通过严格检查后，按下列查询读取 System/developer 消息；解压或 JSON 解析失败交给现有用途错误结算，不用 catch 后继续的方式伪造空列表。保留 `systemTextsOf(body.request)` 的顶层结果，再拼接消息级文本；同步与切片用途共用此入口。普通 User/Assistant 块不解压。

```ts
const systemRows = db.query<{ z: Uint8Array }, [number]>(`
  SELECT b.z AS z FROM request_block rb JOIN block b ON b.id=rb.block
  WHERE rb.req_id=? AND rb.role=2 ORDER BY rb.ord
`).all(identity.reqId);
const systemMessages = systemRows.map(row =>
  JSON.parse(zstdDecompressSync(row.z).toString('utf8')) as unknown);
const systemTexts = [
  ...systemTextsOf(body.request),
  ...systemTextsOf({ messages: systemMessages }),
];
```

从 `node:zlib` 导入 `zstdDecompressSync`，返回视图使用 `systemTexts`。增加损坏 System 块的回归，断言进入错误/保留路径且不产出成功的无 System 结论。

- [ ] **Step 3: 提升用途版本并验证既有恢复入口。** 提升 `PURPOSE_VERSION`，同步测试工厂及版本断言。用旧目标版本、`purposePending=0`、已完成普通 chat 结论的合成 Chat 请求验证普通 tick 保持旧值；调用现有维护命令的合成测试，验证目标会话升级、用途变为 exclude、依赖链和标题重算，其他会话保持原值。正文已回收行保留旧解释及其实际版本。维护命令目前按会话升级其中全部旧目标行，不能声称只更新该会话中的 Chat 行。

- [ ] **Step 4: 验证并记录恢复代价。** 运行 `bun test tests/request-purpose.test.ts tests/maintenance.test.ts tests/derive.test.ts`。记录 `purpose_upgraded`、`purpose_processed`、`recomputed_requests`、`retained_requests`；这一轮只对合成库执行维护。更新[用途与主链记录](../../../.agents/notes/implemented/architecture/2026-10-22-request-purpose-and-chain.md)的版本及取数事实。建议 commit：`fix(purpose): include Chat System blocks in versioned classification`。

## Task 6: 区分未适配协议与空能力

**Files:**
- Modify: `src/capabilities.ts` 的 `capabilityView`；`src/protocols.ts` 的 `getBodyPage`。
- Modify: `web/body-view.js`、`web/app.js` 消费 `parse_state` 的结构和能力说明。
- Test: `tests/capabilities.test.ts`、`tests/body-api.test.ts`、`tests/body-view.test.ts`、`tests/web.test.ts`。

**Interfaces:**
- Consumes: 已有 `BodyPage.parse_state`、`state`、`request_fields`、`reply` 和 `CapabilityView`。
- Produces: `coverage` 继续表示已保存正文的覆盖；协议能否解释由 `parse_state` 表达。unsupported 的两项能力均为 `missing/protocol_unsupported`，页面不以完整保存推导已识别消息或零技能。原对象继续从现有正文元信息读取，不新增 `/raw` 端点。

- [ ] **Step 1: 写未适配协议能力回归并确认失败。** 在 `tests/capabilities.test.ts` 加入：

```ts
test('未适配协议不把未知技能显示为零', () => {
  const view = capabilityView({
    protocol: 'responses', request: { input: 'synthetic input' },
    systemTexts: [], coverage: complete, systemPresent: false, agent: null,
  });
  expect(view.tools).toEqual({ state: 'missing', items: [], reason: 'protocol_unsupported' });
  expect(view.skills).toEqual({ state: 'missing', items: [], reason: 'protocol_unsupported' });
});
```

运行 `bun test tests/capabilities.test.ts`，旧实现 skills 为 empty。在 `tests/body-api.test.ts` 使用已有 `seed` 保存 responses 请求和 output 回复，经 `handlerFor(f)('/api/requests/1/body?from=0&to=0')` 断言原请求字段与 reply 完整返回、`parse_state='unsupported'`、`total=null`。

- [ ] **Step 2: 统一能力的协议支持检查。** `capabilityView` 在不支持协议时对工具、技能返回同一个固定原因，并保留 coverage 与 agent。页面将保存覆盖和协议解释分开显示：unsupported 时保留原字段和回复入口，结构说明为未适配，不显示空消息的确定结论。不要把持久 `body_state` 改为骨架读取器拒绝的值，也不要在填充 `request_fields/reply` 前提前返回。

- [ ] **Step 3: 验证并同步决定。** 运行 `bun test tests/capabilities.test.ts tests/body-api.test.ts tests/body-view.test.ts tests/web.test.ts`。supported 协议原有五种能力状态继续通过，更新[输入解释与能力阅读](../../../.agents/notes/implemented/feature/2026-10-22-server-side-input-interpretation.md)的相关事实。建议 commit：`fix(reader): distinguish unsupported protocols from empty capabilities`。

## Task 7: 统一多 choice 工具定位限制

**Files:**
- Modify: `src/protocols.ts` 的 `chatCalls`；`src/derive-decision.ts` 的 `anthropicReplyCalls`。
- Modify: `src/derive-state.ts` 的 `GROUP_ALGORITHM`；相关版本消费者与断言。
- Reuse: `src/derive.ts`、`src/derive-slice.ts`、`src/derive-unit.ts` 的共同抽取入口和既有会话重算，不在各写入路径重复添加不同判据。
- Test: `tests/protocols.test.ts`、`tests/derive.test.ts`、`tests/derive-slice.test.ts`、`tests/derive-unit.test.ts`。

**Interfaces:**
- Consumes: `parseProtocol('chat', request, reply)`、`anthropicReplyCalls(reply)`、`owner + callOrd` 工具读取身份。
- Produces: 只有单 choice Chat 回复可发布确定工具位置；多 choice 保留原 reply，不发布会碰撞或指错 choice 的调用配对。已有单 choice 序号和结果定位不变，算法版本使新旧派生结果可区分。

- [ ] **Step 1: 写两个抽取入口的失败回归。** 在 `tests/protocols.test.ts` 从 `../src/derive-decision` 导入 `anthropicReplyCalls` 后加入：

```ts
test('多 choice 不发布只有 ord 的确定调用身份', () => {
  const reply = {
    choices: ['left', 'right'].map(id => ({ message: {
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
    } })),
  };
  expect(parseProtocol('chat', { messages: [] }, reply).calls).toEqual([]);
  expect(anthropicReplyCalls(reply)).toEqual([]);
});
```

运行 `bun test tests/protocols.test.ts`。旧实现返回两个 ord=0；同时保留现有单 choice 路径和序号断言。

- [ ] **Step 2: 将同一限制落实到两个抽取入口。** `chatCalls` 与 `anthropicReplyCalls` 的 Chat 分支在读取 choices 后要求 `length === 1`，不满足就返回空确定调用集合。保留前端现有多 choice 原对象与限制说明；不使用仍会被工具结果读取器解释成 choice0 的全局新序号。

- [ ] **Step 3: 验证派生与历史恢复。** 提升 `GROUP_ALGORITHM` 到实施时下一个版本，同步版本消费者与必要断言。用合成多 choice 回复分别经同步与切片派生，断言组可完成、`tool_call` 和发布代没有重复调用位置、原 reply 仍可读取。对曾失败或已完成的受影响合成会话走既有 rebuild，验证工具关系和阅读 token 追上，保留不可读行的实际版本。真实库只在实施后另行安排维护，不自动重算全库。

- [ ] **Step 4: 验证并记录。** 运行 `bun test tests/protocols.test.ts tests/derive.test.ts tests/derive-slice.test.ts tests/derive-unit.test.ts tests/reading.test.ts`。更新[生产阅读决定](../../../.agents/notes/implemented/architecture/2026-10-23-single-timeline-production-reader.md)的工具定位事实。建议 commit：`fix(derive): reject ambiguous multi-choice tool positions`。

## Task 8: 合成浏览器验收与文档收尾

**Files:**
- Modify: `docs/architecture-design.md` 的协议适配、输入解释、轨迹布局和阅读版本段。
- Modify: `README.md`的当前阅读说明与验收事实。
- Modify/move: 本提案及被部分覆盖的implemented Agent Note；保留独有理由，不改归档。
- Test: 前述定向测试和现有 `tests/body-api.test.ts`、`tests/reading.test.ts`。

**Interfaces:**
- Consumes: Tasks 1–7 的阅读行为、用途结算与工具定位规则；各任务已通过的定向测试不重复运行。
- Produces: 可复现的合成验收结果、与现行代码一致的常备文档、可单独审阅的Git差异。

- [ ] **Step 1: 补齐尚未通过的交付检查。** 确认 Tasks 1–7 已覆盖 reader-store、trace-view、body-view、web、protocols、body-api、capabilities、request-purpose、maintenance、derive、derive-slice、derive-unit、reading；尚未覆盖的输入解释回归执行 `bun test tests/input-interpretation.test.ts`。最后运行 `bun run typecheck`。已有通过项只在新代码变更影响它们时重跑；不顺带启动容量压测。

- [ ] **Step 2: 用ego-browser在隔离合成页面验收。** 使用同一个TaskSpace验证：两笔Skill时序、顶层和消息System、混合工具结果、两文本两调用、81条增量、99号稀疏尾部、token变化和409。每种失败需要可见重读/续读，不能只断言网络成功。服务只读合成库，记录临时服务的停止方式。

- [ ] **Step 3: 检查实际布局。** 400/620/1000/1240px、深浅主题，检查标签`scrollWidth <= clientWidth`与页面`scrollWidth <= innerWidth`，System全文和工具结果在内部滚动；逐步选择后只有一行明确高亮。英文Assistant完整可读。

- [ ] **Step 4: 单独报告真实数据核对。** 对用户截图会话只读核对req108/110形状和System入口，真实正文不输出、不复制到仓库。将合成通过、真实只读观察、未执行项分别写清。

- [ ] **Step 5: 同步文档并做最后检查。** 提案交付后移为implemented并改为Decision/Consequences；反向链接更新到新位置；仅被部分覆盖的旧Note保留。运行 `bun run verify:notes`、`git diff --check`和本轮新文档的相对链接检查。按用户授权决定是否提交，父仓库gitlink不自动更新。

建议最终commit正文按实际交付和实测结果填写，不能把本评审基线的测试通过冒充修复后的验收。

## 评审基线

2026-10-24：四个前端阅读测试文件59例通过，协议/输入解释/正文接口三个文件34例通过，`bun run typecheck`通过。另以独立内存fetch反例验证R1/R2/R3/R4，结果与提案表格一致；这些临时反例没有写入测试仓库。本计划未执行运行代码修复。
