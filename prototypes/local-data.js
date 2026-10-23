import { deltaOrdinals, messageEntries, messageBlocks, previewOf, replyView, renderCapabilities, renderMessages, renderMessageDetail, renderReply, bodyNotice, messageCopyText, esc } from '../web/body-view.js';

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
  async function request(id) {
    const [detail, page] = await Promise.all([get(`/api/requests/${id}`), body(id,0,0)]);
    const view = replyView(page);
    const steps = [];
    const messages = [];
    const delta = deltaOrdinals(detail);
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
      steps.push({key:`${id}:uncertain`,label:'记录',cls:'aux',text:'新增输入未确认 · '+(detail.prev_relation || detail.derived_state),raw:'前驱或派生关系未确认，未将历史上下文当成新用户消息。'});
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
      const normalized = {id:`${id}:${call.ord}`,function:{name:call.name,arguments:call.inputText},pair,result:null};
      calls.push(normalized);
      steps.push({key:`${id}:call:${call.ord}`,label:'工具',cls:'tool',text:block.text,call:normalized});
    }
    if (!blocks.length && view.text) steps.push({key:`${id}:reply`,label:'助手',cls:'reply',text:view.text,raw:view.text,path:'$response'});
    if (!steps.length || page.state !== 'available' && page.state !== 'partial') steps.push({key:`${id}:state`,label:'记录',cls:'aux',text:`正文状态：${page.state}`,raw:page.reason || '没有可读正文'});
    const raw = {request_fields:page.request_fields,messages,reply:page.reply,coverage:page.coverage};
    return {
      id:String(id),at:new Date(detail.started_ms).toLocaleTimeString('zh-CN',{hour12:false}),started_ms:detail.started_ms,
      title:detail.title,agent:detail.agent || '未知',status:detail.status === null ? 'unknown' : detail.status >= 400 ? 'failed' : 'success',
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
        if (value.localSteps.length > available) value.sampleCut = true;
        value.localSteps = value.localSteps.slice(0,available);
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
  async function result(call) {
    const pair=call.pair;
    if (call.result) return call.result;
    if (!pair || pair.state !== 'resolved' || pair.result_req == null || pair.result_ord == null || !pair.result_path) return null;
    const part=await body(pair.result_req,pair.result_ord);
    const message=part.messages.find(item=>item.ord===pair.result_ord)?.value;
    const match=/^request\.messages\[\d+\](?:\.content\[(\d+)\])?$/.exec(pair.result_path);
    if (!match || !message) return null;
    const value=match[1]===undefined ? message.content : message.content?.[Number(match[1])]?.content;
    call.result={request:{id:String(pair.result_req)},message:{content:readable(value)}};
    return call.result;
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
    // 结果读取复用 Demo 按精确配对路径读取的入口，避免生产控件在原型里失效。
    const html=renderReply(row.localReply,tools);
    return html.replace(/data-tool-result="(\d+)" data-tool-ord="(\d+)"/g,(_all,req,ord)=>{
      const call=row.replyMsg.tool_calls.find(item=>String(item.pair?.result_req)===req && String(item.pair?.result_ord)===ord);
      return call ? `data-tool-owner="${esc(row.id)}" data-tool-id="${esc(call.id)}" data-local-result="1"` : 'disabled';
    });
  }
  return {sessions,requests,load,result,loadStructure,renderContext,renderResponse,messageCopyText,hasMore:key=>windows.get(key)?.more===true,
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
