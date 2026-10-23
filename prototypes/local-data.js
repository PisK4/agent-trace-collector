import { deltaOrdinals, messageEntries, messageBlocks, previewOf, replyView, renderCapabilities, renderMessages, renderMessageDetail, renderReply, bodyNotice, messageCopyText, esc } from '../web/body-view.js';

// 状态五组（与生产迁移计划 §3.4 对齐）：
// HTTP 状态 / 回复完整性 / 正文状态 / 工具关联 / 结果正文加载。
// 「未读取」不写成「未记录」，resolved 只代表关联已确认，不代表工具成功。
const NORMAL_FINISH = ['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use'];

export function createLocalReader() {
  const sessions = [];
  const requests = {};
  const windows = new Map();
  const params = new URLSearchParams(location.search);
  const firstSteps = params.get('sample') === 'first50';
  const get = async path => {
    const response = await fetch(path, { cache:'no-store' });
    if (!response.ok) throw new Error(`本机读取失败（HTTP ${response.status}）`);
    return response.json();
  };
  const body = (id, ord = 0, count = 1) => get(`/api/requests/${id}/body?from=${ord}&to=${ord+count}`);
  const readable = value => typeof value === 'string' ? value : previewOf(value);
  // 记录行：请求级异常与口径说明，独立于内容步骤，renderSteps 不再整体覆盖它们。
  const record = (id, key, label, cls, status, raw) => ({key:`${id}:record:${key}`, label, cls, isRecord:true, status, raw});
  async function request(id) {
    const [detail, page] = await Promise.all([get(`/api/requests/${id}`), body(id,0,0)]);
    const view = replyView(page);
    const steps = [];
    const messages = [];
    const delta = deltaOrdinals(detail);
    const isAux = detail.purpose_chain === 'exclude' || detail.chain_role === 'aux';
    const isBranch = detail.chain_role === 'branch' || detail.prev_relation === 'branch';
    const finish = view.finish;
    const records = [];
    if (isBranch) records.push(record(id,'branch','分支','aux','分支链请求 · 归属来自派生记录，不按时间推断父子','分支请求保持归属标记；与主链的前驱关系按 branch 记录。'));
    if (detail.status !== null && detail.status >= 400) records.push(record(id,'http','失败','fail',`请求失败 · HTTP ${detail.status}；已收到的输入与回复仍保留在步骤里`,'HTTP 层失败不抹掉已观测到的用户输入与回复。'));
    else if (detail.status === null) records.push(record(id,'http','记录','aux','HTTP 状态未知','没有观测到这笔请求的 HTTP 状态。'));
    if (view.state === 'absent') records.push(record(id,'reply','记录','aux','未收到回复','正文已保存，上游没有提供可用回复；不标成功完成。'));
    else if (finish === 'length' || finish === 'max_tokens') records.push(record(id,'reply','记录','aux',`回复因长度上限结束（finish=${finish}）；请求仍为 HTTP 成功`,'回复截断是成功响应内的完整性状态，不把请求行改成失败。'));
    else if (finish !== null && !NORMAL_FINISH.includes(finish)) records.push(record(id,'reply','记录','aux',`停止原因未知 · ${finish}（按原值显示，不判失败）`,`上游报告了未归类的停止原因 ${finish}。`));
    if (page.state !== 'available' && page.state !== 'partial') records.push(record(id,'body','记录','aux',`正文状态：${page.state}${page.reason ? ' · '+page.reason : ''}`,page.reason || '没有可读正文'));
    if (isAux) {
      // 辅助请求一笔只保留一条记录，分类器输入不画成用户消息。
      steps.push(record(id,'aux','辅助','aux',`辅助请求 · ${detail.req_kind === 'title' ? '标题生成' : detail.req_kind}${page.state === 'available' || page.state === 'partial' ? '' : ' · '+page.state}`,`由 purpose_chain/chain_role 判定，不参与主链；输入不是用户消息。`));
    } else {
      // 只读取确定的新增用户消息；历史 Assistant 由实际回复展示，避免重发重复。
      if (delta) {
        const ordinals = [...delta].sort((a,b)=>a-b);
        for (let i=0;i<ordinals.length;) {
          const start = ordinals[i];
          const selected = new Set();
          while (i<ordinals.length && ordinals[i]<start+40) selected.add(ordinals[i++]);
          const part = await body(id,start,Math.max(...selected)-start+1);
          messages.push(...part.messages);
          for (const entry of messageEntries(part)) {
            if (!selected.has(entry.ord) || !entry.isInput || entry.input?.state !== 'text') continue;
            steps.push({ key:`${id}:message:${entry.ord}`, label:'用户', cls:'', text:entry.input.text, raw:entry.input.original, path:`messages[${entry.ord}]` });
          }
        }
      } else {
        records.push(record(id,'uncertain','记录','aux','新增输入未确认 · '+(detail.prev_relation || detail.derived_state),'前驱或派生关系未确认，未将历史上下文当成新用户消息。'));
      }
      const calls = [];
      // 按协议块顺序显示回复，保留文本和工具调用之间的穿插。
      const reply = page.reply;
      const chatMessage = reply?.choices?.[0]?.message;
      const blocks = reply?.content ? messageBlocks({role:'assistant',content:reply.content}) : messageBlocks(chatMessage);
      for (const block of blocks) {
        if (block.kind === 'text' && block.text) steps.push({key:`${id}:reply:${block.index}`,label:'助手',cls:'reply',text:block.text,raw:block.text,path:'$response'});
        if (block.kind !== 'call') continue;
        const call = view.calls.find(item=>item.ord===block.index);
        if (!call) continue;
        const pair = detail.tool_calls?.find(item=>item.ord===call.ord);
        // 关联状态与结果正文加载状态分开：loadState 只在读取时推进。
        const normalized = {id:`${id}:${call.ord}`, callId:call.id, name:call.name, inputText:call.inputText,
          function:{name:call.name, arguments:call.inputText}, pair, result:null, loadState:'not_loaded', error:null};
        calls.push(normalized);
        steps.push({key:`${id}:call:${call.ord}`,label:'工具',cls:'tool',text:block.text,call:normalized});
      }
      if (!blocks.length && view.text) steps.push({key:`${id}:reply`,label:'助手',cls:'reply',text:view.text,raw:view.text,path:'$response'});
      steps.push(...records);
      const raw = {request_fields:page.request_fields,messages,reply:page.reply,coverage:page.coverage};
      return finishRow(id, detail, page, view, steps, calls, raw);
    }
    const raw = {request_fields:page.request_fields,messages,reply:page.reply,coverage:page.coverage};
    return finishRow(id, detail, page, view, steps, [], raw);
  }
  function finishRow(id, detail, page, view, steps, calls, raw) {
    return {
      id:String(id),at:new Date(detail.started_ms).toLocaleTimeString('zh-CN',{hour12:false}),started_ms:detail.started_ms,
      title:detail.title,agent:detail.agent || '未知',
      status: detail.status === null ? 'unknown' : detail.status >= 400 ? 'failed' : 'success',
      timing:{ms:detail.ms,ttft:detail.ttft_ms,flow:detail.flow_ms,firstText:detail.first_text_ms},
      usage:{in:detail.in_tok,out:detail.out_tok,cacheRead:detail.cache_read,cacheWrite:detail.cache_write,cost:detail.cost},
      request:null,newMsgs:[],local:true,localSteps:steps,localDetail:detail,localBody:raw,
      localPage:page,localReply:view,structure:{open:false,entries:[],next:0,total:page.total,loading:false,error:null,selected:null},
      replyMsg:{role:'assistant',content:view.text,tool_calls:calls},replyState:{model:view.model,finish:view.finish},
    };
  }
  async function load(session, earlier = false) {
    if (firstSteps) {
      const page = await get('/api/sessions/'+encodeURIComponent(session.key)+'/requests?limit=50');
      const loaded = [];
      let count = 0;
      for (const row of page.items) {
        const value = await request(row.req_id);
        const available = 50-count;
        if (value.localSteps.length > available) {
          value.sampleCut = true;
          value.localSteps = value.localSteps.slice(0,available);
          value.localSteps.push(record(row.req_id,'cut','记录','aux','样本截断 · 该请求其余步骤与后续请求未载入','sample=first50 只加载前 50 条步骤；截断处之后的内容不在本页。'));
        }
        loaded.push(value);
        count += value.localSteps.length;
        if (count >= 50) break;
      }
      for (const value of loaded) requests[value.id]=value;
      session.requests=loaded.map(value=>value.id);
      windows.set(session.key,{more:false});
      return loaded;
    }
    const old = windows.get(session.key);
    const before = earlier && old?.before ? '&before='+encodeURIComponent(JSON.stringify(old.before)) : '';
    const window = await get('/api/local-window?session='+encodeURIComponent(session.key)+before);
    const loaded = [];
    // 限制同时解压的请求数量。
    for (let i=0;i<window.items.length;i+=3) loaded.push(...await Promise.all(window.items.slice(i,i+3).map(row=>request(row.req_id))));
    for (const row of loaded) requests[row.id]=row;
    session.requests = earlier ? [...loaded.map(row=>row.id),...session.requests] : loaded.map(row=>row.id);
    const first=window.items[0];
    windows.set(session.key,{more:window.more,before:first ? [first.started_ms,first.req_id] : old?.before});
    return loaded;
  }
  // 按调用位置读取结果：只在关系已确认时发起，读取失败保留原因并可重试。
  async function result(call) {
    if (call.result) return call.result;
    if (call.loadState === 'loading') return null;
    const pair = call.pair;
    if (!pair || pair.state !== 'resolved' || pair.result_req == null || pair.result_ord == null || !pair.result_path) return null;
    call.loadState = 'loading'; call.error = null;
    try {
      const part = await body(pair.result_req, pair.result_ord);
      const message = part.messages.find(item=>item.ord===pair.result_ord)?.value;
      const match = /^request\.messages\[(\d+)\](?:\.content\[(\d+)\])?$/.exec(pair.result_path);
      if (!match || !message || Number(match[1]) !== pair.result_ord) {
        call.loadState = 'invalid_location'; call.error = '结果路径与消息位置不一致';
        return null;
      }
      if (part.state !== 'available' && part.state !== 'partial') {
        call.loadState = 'unavailable'; call.error = part.reason || `正文${part.state}`;
        return null;
      }
      const value = match[2] === undefined ? message.content : Array.isArray(message.content) ? message.content[Number(match[2])] : undefined;
      if (value === undefined || value === null) {
        call.loadState = 'unavailable'; call.error = '结果内容块缺失';
        return null;
      }
      if (match[2] !== undefined && value && typeof value === 'object' && value.type === 'tool_result'
        && typeof value.tool_use_id === 'string' && call.callId && value.tool_use_id !== call.callId) {
        call.loadState = 'invalid_location'; call.error = '结果块的 tool_use_id 与该调用不匹配';
        return null;
      }
      call.result = {request:{id:String(pair.result_req)}, message:{content:readable(value)},
        isError: value && typeof value === 'object' ? (value.is_error === true ? true : value.is_error === false ? false : null) : null};
      call.loadState = 'loaded';
      return call.result;
    } catch (error) {
      call.loadState = 'failed'; call.error = error.message;
      return null;
    }
  }
  // 窗口外目标只读详情，不装载目标的历史，也不把它并进当前窗口。
  async function readOutside(id) {
    if (requests[String(id)]) return requests[String(id)];
    const [detail, page] = await Promise.all([get(`/api/requests/${id}`), body(id,0,0)]);
    const view = replyView(page);
    const row = finishRow(id, detail, page, view, [record(id,'outside','记录','aux','该请求未在当前载入窗口 · 只读取了详情','窗口外请求不扫描全部历史；需要完整轨迹时从顶部继续加载。')], [], {request_fields:page.request_fields,messages:[],reply:page.reply,coverage:page.coverage});
    row.outside = true;
    requests[row.id] = row;
    return row;
  }
  async function loadStructure(row) {
    const state = row.structure;
    if (state.loading || state.total !== null && state.next >= state.total) return;
    state.loading = true; state.error = null;
    try {
      const part = await body(row.id,state.next,40);
      const entries = messageEntries(part);
      state.entries.push(...entries);
      state.total = part.total;
      state.next = part.to;
      state.notice = bodyNotice(part);
      if (!entries.length && part.total !== null && state.next < part.total) state.error = '这一片没有消息，读取在此停止，请重试。';
    } catch (error) {state.error=error.message;}
    finally {state.loading=false;}
  }
  function renderContext(row) {
    const state = row.structure;
    const delta = deltaOrdinals(row.localDetail);
    const selected = state.entries.find(entry=>entry.ord===state.selected);
    const unread = state.total !== null && state.next < state.total;
    const readableBody = ['available','partial'].includes(row.localPage.state);
    const count = state.total === null ? '消息数量未知' : `${state.total} 条消息`;
    const messages = selected
      ? `<button class="chip-btn" data-structure-back="${esc(row.id)}">← 返回请求消息</button>${renderMessageDetail(selected)}`
      : `${renderMessages(state.entries,{delta,limit:state.entries.length})}${state.loading ? '<p class="note">正在读取消息…</p>' : ''}${state.error ? `<p class="note">${esc(state.error)}</p>` : ''}${readableBody && (unread || state.error) ? `<button class="chip-btn" data-structure-more="${esc(row.id)}" ${state.loading ? 'disabled' : ''}>${state.error ? '重试读取' : `加载下一片（已读 ${state.entries.length} / ${state.total}）`}</button>` : ''}`;
    const notice = bodyNotice(row.localPage);
    return `${renderCapabilities(row.localPage)}<section class="section rail-structure"><div class="section-head"><h3>请求结构</h3><span class="count">${count}</span>${delta ? `<span class="count">新增 ${delta.size}</span>` : ''}</div><details data-structure="${esc(row.id)}" ${state.open ? 'open' : ''}><summary>查看请求消息 · 已读 ${state.entries.length}${state.total === null ? '' : ' / '+state.total}</summary>${notice ? `<p class="note">${esc(notice)}</p>` : ''}${delta === null ? '<p class="note">新增关系未确认，按原顺序展示，不标记新增。</p>' : ''}${!readableBody ? '<p class="note">当前正文不可读，没有可加载的消息区间。</p>' : messages}</details></section>`;
  }
  function renderResponse(row) {
    const calls=replyView(row.localPage).calls;
    const tools=calls.map(call=>({call_id:call.id,name:call.name,inputText:call.inputText,ord:call.ord,...row.localDetail.tool_calls?.find(pair=>pair.ord===call.ord)}));
    // 结果读取复用按精确配对路径读取的入口，避免生产控件在原型里失效。
    const html=renderReply(row.localReply,tools);
    return html.replace(/data-tool-result="(\d+)" data-tool-ord="(\d+)"/g,(_all,req,ord)=>{
      const call=row.replyMsg.tool_calls.find(item=>String(item.pair?.result_req)===req && String(item.pair?.result_ord)===ord);
      return call ? `data-tool-owner="${esc(row.id)}" data-call-id="${esc(call.id)}"` : 'disabled';
    });
  }
  return {sessions,requests,load,result,readOutside,loadStructure,renderContext,renderResponse,messageCopyText,hasMore:key=>windows.get(key)?.more===true,
    async init() {
      const selectedSession = params.get('session');
      let prefix = selectedSession;
      if (selectedSession?.startsWith('[')) {
        try { prefix = JSON.parse(selectedSession)[1]; } catch { throw new Error('会话参数无效'); }
      }
      if (prefix) {
        sessions.push(await get('/api/local-session?prefix='+encodeURIComponent(prefix)));
        return;
      }
      const page=await get('/api/sessions?limit=20');
      sessions.push(...page.items.map(row=>({key:row.conv_key,session:row.conv_key,title:row.title,agent:row.agents.join(' / ') || '未知',requests:[],total:row.request_count})));
      if (!sessions.length) throw new Error('本机数据库中没有会话');
    },
  };
}
