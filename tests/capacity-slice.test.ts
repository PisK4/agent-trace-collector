/**
 * 切片与同步两条派生路径的等价性。
 *
 * 判据是"同一组输入给出同样的关系与角色、同样的标题与摘录、同样的工具往返"：
 * 所以对照值由同步入口在同一份种子上的另一个库跑出来，不手写期望值。
 * 切片那一侧把预算压到每批一行，页边界因此落在每一笔请求之间——页边界不该
 * 影响结果，这正是要压的地方。
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture, seedChain } from './fixtures';
import type { Store } from '../src/store';
import { persistBody } from '../src/body';
import { drainDeriveTx, enqueueDerive } from '../src/derive';
import { drainDeriveEntry } from '../src/derive-unit';
import { DEFAULT_DERIVE_BUDGET } from '../src/config';
import type { SliceRuntime } from '../src/config';


type GroupKey = { convKey: string; actor: string };

/** 组键的形状与真实摄入一致：会话身份是 JSON 数组，不是短名字。 */
const GROUP: GroupKey = { convKey: JSON.stringify(['session', 'c']), actor: 'actor-a' };

/** 逐行比较的列：关系、角色与四列展示结果，都在请求行上。 */
const REQUEST_COLUMNS = `req_id,prev_req_id,prev_relation,delta_ordinals,chain_role,
  title,title_source,input_preview,input_preview_kind,reply_preview`;

const TOOL_COLUMNS = 'req_id,ord,call_id,tool_name,result_req,result_ord,result_path,state';

type Snapshot = {
  requests: Record<string, unknown>[];
  tools: Record<string, unknown>[];
};

/**
 * 一条路径上的组事实快照。
 *
 * 同步的落点是 `request` 与 `tool_call` 旧列，切片的落点是已发布代的
 * `derive_request_result` 与 `derive_tool_result`：同一份事实的两个家。
 */
function snapshot(store: Store, group: GroupKey, mode: 'sync' | 'slice'): Snapshot {
  const source = mode === 'sync' ? 'request' : 'effective_request';
  const requests = store.read.query<Record<string, unknown>, [string, string]>(`
    SELECT ${REQUEST_COLUMNS} FROM ${source}
    WHERE conv_key=? AND actor=? ORDER BY req_id`).all(group.convKey, group.actor);
  const tools = mode === 'sync'
    ? store.read.query<Record<string, unknown>, [string, string]>(`
        SELECT ${TOOL_COLUMNS} FROM tool_call
        WHERE req_id IN (SELECT req_id FROM request WHERE conv_key=? AND actor=?)
        ORDER BY req_id,ord`).all(group.convKey, group.actor)
    : store.read.query<Record<string, unknown>, [string, string]>(`
        SELECT ${TOOL_COLUMNS} FROM derive_tool_result
        WHERE generation=(SELECT published_generation FROM derive_queue
          WHERE conv_key=? AND actor=?) ORDER BY req_id,ord`).all(group.convKey, group.actor);
  return { requests, tools };
}

/** 差异要指到第一行：一条链上二十几笔请求，只说"不相等"等于没说。 */
function expectEquivalent(group: GroupKey, sync: Snapshot, slice: Snapshot): void {
  const left = [...sync.requests, ...sync.tools];
  const right = [...slice.requests, ...slice.tools];
  if (left.length !== right.length) {
    throw new Error(`组 ${group.convKey}/${group.actor} 行数不同：`
      + `同步 ${left.length} 切片 ${right.length}`);
  }
  for (const [index, row] of left.entries()) {
    const other = right[index]!;
    if (JSON.stringify(row) !== JSON.stringify(other)) {
      throw new Error(`组 ${group.convKey}/${group.actor} 第 ${index} 行不同：`
        + `同步 ${JSON.stringify(row)} 切片 ${JSON.stringify(other)}`);
    }
  }
}

/** 同步入口排空到没有待派生组为止。 */
function drainSync(store: Store): void {
  for (let poll = 0; poll < 100; poll++) {
    const result = store.write(db => drainDeriveTx(db, { limit: 100 }));
    if (result.remaining === 0) return;
  }
  throw new Error('sync_drain_did_not_converge');
}

/**
 * 压缩预算：每批一行、每步一个写事务，把页边界压到每一笔请求之间。
 *
 * 候选额度同时是"单笔请求能整笔算完"的下限：一笔请求的调用与结果候选超过它
 * 就只能丢弃，所以带工具往返的模糊组给 2，其余给 1。
 */
function compressedRuntime(dir: string, maxCandidatesPerBatch = 1): SliceRuntime {
  return {
    budget: {
      ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch, maxWritesPerBatch: 1,
      maxStageBatchMs: 1,
    },
    dataDir: dir,
    dbPath: join(dir, 'trace.db'),
  };
}

/** 切片入口排空到没有待派生组为止。一次调用只推进一个阶段批次。 */
function drainSlice(store: Store, runtime: SliceRuntime): void {
  store.deriveRuntime = runtime;
  const why = (): string => JSON.stringify(store.read.query<Record<string, unknown>, []>(
    'SELECT conv_key,actor,last_error FROM derive_queue WHERE last_error IS NOT NULL').all());
  for (let step = 0; step < 20_000; step++) {
    const result = drainDeriveEntry(store, 1);
    if (result.remaining === 0) return;
    // 等价性场景里没有"输入在构建期变化"这回事，丢弃只会是指向真实缺陷的信号。
    if (result.discarded > 0) throw new Error(`slice_discarded:${result.discarded}:${why()}`);
  }
  throw new Error('slice_drain_did_not_converge');
}

/**
 * 固定用例：一条四笔的链、一笔缺正文、三笔展示分支的定点。
 *
 * 三个定点分别是正文不可读的标题请求（旧来源是 user_delta）、可读但
 * `model_title` 为空且库里留着旧标题的标题请求、排除用途的非标题请求。
 */
function seedEquivalenceCase(store: Store, group: GroupKey): void {
  seedChain(store, [{ texts: ['S'] }, { texts: ['S', 'A'] }, { texts: ['S', 'A', 'B'] },
    { texts: ['OTHER'] }], group);
  store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,purpose_pending,req_kind)
      VALUES (5,?,'session',?,'known',1300,'2026-10-22','hook','available',0,1,1,1,
        '旁路旧标题','model_time','ledger','ledger|0005','e1',1,0,1,'exclude',0,'title')`,
    [group.convKey, group.actor]);
    // 用例 1：正文不可读的标题请求，旧 title_source 是 user_delta。标题分支先判，
    // 来源因此提升为 model_time；若先判不可读，就会错留 user_delta 与旧摘录。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,purpose_pending,req_kind)
      VALUES (6,?,'session',?,'known',1400,'2026-10-22','hook','missing',0,1,1,1,
        'retained title user_delta','user_delta','ledger','ledger|0006','e1',1,0,1,
        'exclude',0,'title')`, [group.convKey, group.actor]);
    // 用例 2：正文可读、model_title 为空、库里有旧标题的标题请求。标题用模型与时间
    // 兜底；把旧标题当 fallback 就会把库里的旧值写成新结果。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,purpose_pending,req_kind,model_title,model_served)
      VALUES (7,?,'session',?,'known',1500,'2026-10-22','hook','available',0,1,1,1,
        '旧库里标题','user_delta','ledger','ledger|0007','e1',1,0,1,'exclude',0,'title',
        NULL,'模型X')`, [group.convKey, group.actor]);
    // 用例 3：排除用途但不是标题请求。标题判定只看 req_kind，不能与 purpose_chain
    // 合成一个谓词，否则这笔会拿到标题摘录。带模型标题且关系判不出来（`delta` 为空）
    // 是最容易走样的那一格：兜底写下的模型标题不能随"关系判不判得出"而变。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,purpose_pending,req_kind,model_title,model_served)
      VALUES (8,?,'session',?,'known',1600,'2026-10-22','hook','available',0,1,1,1,
        '旁路旧标题','user_delta','ledger','ledger|0008','e1',1,0,1,'exclude',0,'chat',
        '模型Y','模型X')`, [group.convKey, group.actor]);
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,body_evict_reason,derive_version,have,created_at,updated_at,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,purpose_pending,req_kind)
      VALUES (9,?,'session',?,'known',1700,'2026-10-22','hook','evicted','raw_expired',0,1,1,1,
        'ledger','ledger|0009','e1',1,0,1,'participate',0,'chat')`,
    [group.convKey, group.actor]);
  });
  // 用例 2 与 3 的正文必须真的可读，否则 `current` 仍为 null，测不到兜底与分支差别。
  persistBody(store, 7, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'preferred titles' }] }] },
    reply: { id: 'msg_7', content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  });
  persistBody(store, 8, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: '旁路问题' }] }] },
    reply: { id: 'msg_8', content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  });
  // 正文写入会把这两笔重新标成待判定；种下的用途就是它们要消费的结论。
  store.write(db => db.run(`UPDATE request SET purpose_pending=0
    WHERE conv_key=? AND actor=? AND req_id IN (7,8)`, [group.convKey, group.actor]));
  enqueueDerive(store, group.convKey, group.actor, '');
}

test('切片与同步在压缩预算下逐行等价', () => {
  const sync = fixture();
  const slice = fixture();
  try {
    seedEquivalenceCase(sync.store, GROUP);
    seedEquivalenceCase(slice.store, GROUP);
    drainSync(sync.store);
    drainSlice(slice.store, compressedRuntime(slice.dir));

    expectEquivalent(GROUP, snapshot(sync.store, GROUP, 'sync'),
      snapshot(slice.store, GROUP, 'slice'));
    expect(slice.store.read.query<{ state: string }, [string, string]>(
      'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?')
      .get(GROUP.convKey, GROUP.actor)).toEqual({ state: 'clean' });

    // 展示分支的三个定点：整行相等已经覆盖，这里把每条判据的事实说出来。
    const rows = slice.store.read.query<{
      req_id: number; title: string | null; title_source: string | null;
      input_preview: string | null; input_preview_kind: string | null;
    }, [string, string]>(`SELECT req_id,title,title_source,input_preview,input_preview_kind
      FROM effective_request WHERE conv_key=? AND actor=? AND req_id IN (6,7,8)
      ORDER BY req_id`).all(GROUP.convKey, GROUP.actor);
    // 用例 1：不可读的标题请求仍走标题分支，来源提升为 model_time。
    expect(rows[0]).toMatchObject({ req_id: 6, title_source: 'model_time',
      input_preview_kind: 'title', input_preview: '生成会话标题' });
    // 用例 2：可读且 model_title 为空时用模型与时间兜底，不沿用库里的旧标题。
    expect(rows[1]).toMatchObject({ req_id: 7, title_source: 'model_time' });
    expect(rows[1]!.title).not.toBe('旧库里标题');
    // 用例 3：排除用途的非标题请求走普通分支，标题也不来自用户增量。模型标题必须
    // 留下：关系判不出来不是"没有标题可用"的理由。
    expect(rows[2]).toMatchObject({ req_id: 8, title: '模型Y', title_source: 'model_title' });
    expect(rows[2]!.input_preview_kind).not.toBe('title');
    expect(rows[2]!.title).not.toContain('旁路问题');
  } finally { sync.close(); slice.close(); }
});

// ---------------------------------------------------------------------------
// 种子模糊测试：固定 PRNG，乱序到达、同毫秒偏移、缺正文、标题旁路、
// 排除用途、重复 call_id、结果早于调用与回收墓碑都在同一个种子池里生成。
// ---------------------------------------------------------------------------

type FuzzRequest = {
  reqId: number;
  startedMs: number;
  sortSource: string | null;
  sortKey: string | null;
  texts: string[];
  toolCall: string | null;
  toolResults: { id: string; content: string }[];
  readable: boolean;
  evicted: boolean;
  purposeChain: 'participate' | 'exclude';
  reqKind: 'chat' | 'title';
  modelTitle: string | null;
  modelServed: string | null;
};

type FuzzGroup = { key: GroupKey; requests: FuzzRequest[] };

/** 线性同余：种子写死，随机序列就是可复现的输入。 */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fuzzGroups(seed: number, count: number): FuzzGroup[] {
  const random = randomOf(seed);
  const letters = ['S', 'A', 'B', 'C', 'D'];
  const groups: FuzzGroup[] = [];
  for (let index = 0; index < count; index++) {
    const size = 1 + Math.floor(random() * 20);
    const requests: FuzzRequest[] = [];
    for (let position = 0; position < size; position++) {
      const sameMillisecond = position > 0 && random() < 0.25;
      const texts = letters.slice(0, 1 + Math.floor(random() * 3));
      // 重复的 call_id 是常态：同一批工具调用会在后续请求里被重发。
      const issues = random() < 0.35 ? `call-${Math.floor(random() * 2)}` : null;
      const carriesResult = position > 0 && random() < 0.3;
      const unreadable = random() < 0.2;
      const evicted = unreadable && random() < 0.5;
      requests.push({
        reqId: position + 1,
        startedMs: 1000 + (sameMillisecond ? requests[position - 1]!.startedMs : position * 10),
        // 第三种来源身份只够定序、不够证明先后：同毫秒的那几笔正是要压这个。
        sortSource: random() < 0.3 ? null : 'ledger',
        sortKey: random() < 0.3 ? null : `ledger|${String(position).padStart(4, '0')}`,
        texts,
        toolCall: issues,
        toolResults: carriesResult && requests[position - 1]!.toolCall !== null
          ? [{ id: requests[position - 1]!.toolCall!, content: `body-${position}` }]
          : [],
        readable: !unreadable,
        evicted,
        purposeChain: random() < 0.2 ? 'exclude' : 'participate',
        reqKind: random() < 0.2 ? 'title' : 'chat',
        modelTitle: random() < 0.5 ? `模型标题${position}` : null,
        modelServed: random() < 0.8 ? '模型X' : null,
      });
    }
    groups.push({
      key: { convKey: JSON.stringify(['session', `c-${seed}-${index}`]), actor: `actor-${index % 3}` },
      requests,
    });
  }
  return groups;
}

/** 按到达顺序打乱插入：`req_id` 是到达序，逻辑顺序由时间与来源位置定。 */
function seedFuzzGroup(store: Store, group: FuzzGroup): void {
  const arrival = [...group.requests].reverse();
  const idByPosition = new Map<number, number>();
  store.write(db => {
    for (const request of arrival) {
      // 主键由自增给出：两个库按同一顺序种同样的行，拿到的号也相同。
      const id = Number(db.run(`INSERT INTO request(conv_key,conv_source,actor,actor_state,
        started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
        sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
        purpose_chain,purpose_pending,req_kind,model_title,model_served)
        VALUES (?,'session',?,'known',?,'2026-10-22','hook','pending',0,1,1,1,
          ?,?,'e1',1,0,1,?,0,?,?,?)`,
      [group.key.convKey, group.key.actor, request.startedMs, request.sortSource,
        request.sortKey, request.purposeChain, request.reqKind, request.modelTitle,
        request.modelServed]).lastInsertRowid);
      idByPosition.set(request.reqId, id);
    }
  });
  for (const request of group.requests) {
    const id = idByPosition.get(request.reqId)!;
    if (!request.readable) continue;
    const messages: unknown[] = request.texts.map(text => ({
      role: 'user', content: [{ type: 'text', text }],
    }));
    if (request.toolResults.length > 0) {
      const previous = group.requests[request.reqId - 2]!;
      messages.push({ role: 'assistant',
        content: [{ type: 'tool_use', id: previous.toolCall, name: 'read' }] });
      messages.push({ role: 'user', content: request.toolResults.map(result => ({
        type: 'tool_result', tool_use_id: result.id, content: result.content,
      })) });
    }
    persistBody(store, id, {
      protocol: 'anthropic',
      request: { messages },
      reply: request.toolCall === null
        ? { id: `msg_${id}`, content: [{ type: 'text', text: 'ok' }] }
        : { id: `msg_${id}`, content: [{ type: 'tool_use', id: request.toolCall, name: 'read' }] },
      redact_version: 1,
    });
  }
  store.write(db => {
    // 用途与链身份冻结：这两条要消费的是种下的结论，不让分类器重判。
    db.run('UPDATE request SET purpose_pending=0 WHERE conv_key=? AND actor=?',
      [group.key.convKey, group.key.actor]);
    // 回收墓碑：正文写过再标成已回收，读取端于是只能拿旧标题与旧摘要。
    for (const request of group.requests) {
      if (!request.evicted) continue;
      db.run(`UPDATE request SET body_state='evicted',body_evict_reason='raw_expired'
        WHERE req_id=?`, [idByPosition.get(request.reqId)!]);
    }
  });
  enqueueDerive(store, group.key.convKey, group.key.actor, '');
}

test('固定种子的模糊组在两条路径上等价', () => {
  const sync = fixture();
  const slice = fixture();
  try {
    for (const seed of [20261022, 20261023]) {
      for (const group of fuzzGroups(seed, 50)) {
        seedFuzzGroup(sync.store, group);
        seedFuzzGroup(slice.store, group);
        drainSync(sync.store);
        drainSlice(slice.store, compressedRuntime(slice.dir, 2));
        expectEquivalent(group.key, snapshot(sync.store, group.key, 'sync'),
          snapshot(slice.store, group.key, 'slice'));
      }
    }
  } finally { sync.close(); slice.close(); }
});