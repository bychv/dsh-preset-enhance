import { RegexExecutor } from './executor.mjs';

/** Only adjacent text blocks match together. Non-text blocks remain owned by DSH. */
export function textRuns(blocks) {
  const runs=[];let run;
  blocks.forEach((block,index)=>{if(block.kind==='text'){if(!run){run={indexes:[],texts:[]};runs.push(run);}run.indexes.push(index);run.texts.push(block.text);}else run=null;});
  return runs.map(r=>({...r,text:r.texts.join('\n')}));
}
const isMarkdown = el => [...el.classList].some(cls=>/(?:^|_)markdown(?:_|$)/i.test(cls));
export function mapTextElements(row,blocks) {
  if(row.dataset.chatGroupPart==='reasoning')return [];
  let shell=row.firstElementChild;
  // Slot boundaries add a display:contents wrapper in the shipped client.
  if(shell?.dataset.slot==='conversation.chat.node'&&shell.children.length===1)shell=shell.firstElementChild;
  const body=shell?.firstElementChild;
  if(!body||!body.parentElement||shell.children.length!==1)return null;
  const candidates=[...body.children].filter(isMarkdown);
  const texts=blocks.map((b,i)=>b.kind==='text'?i:null).filter(i=>i!==null);
  if(candidates.length!==texts.length)return null;
  return new Map(texts.map((index,i)=>[index,candidates[i]]));
}
export function installDisplay(ctx, {React,createRoot,MarkdownText}) {
  let disposed=false,frame;
  const rows=new Map(),sessions=new Map();
  const executor=new RegexExecutor('/preset-enhance-display/worker.js');
  const labels={code:{copy:'复制',copied:'已复制',wrap:'换行',unwrap:'取消换行'},footnotes:'注释',footnoteBackLabel:'返回'};
  function CommittedMarkdown({text,streaming,onCommit}) {
    React.useLayoutEffect(()=>{onCommit?.();},[onCommit]);
    return React.createElement(MarkdownText,{text,streaming,labels});
  }
  const visible=new WeakMap();
  const intersection=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const e of entries){visible.set(e.target,e.isIntersecting);rows.get(e.target)?.update();}},{rootMargin:'250px'}):null;
  function releaseMount(entry, mount) {
    try{mount.root?.unmount();}catch{}
    mount.container.remove();
    for(const [el,display] of mount.originals)el.style.display=display;
    entry.mounts=entry.mounts.filter(m=>m!==mount);
  }
  function restore(entry) { for(const mount of [...entry.mounts])releaseMount(entry,mount); }
  function restoreSession(id){for(const entry of rows.values())if(entry.sessionId===id){entry.version++;entry.last=null;restore(entry);}}
  function configSession(id) {
    if(sessions.has(id)){const existing=sessions.get(id);void existing.refresh();return existing;}
    const state={config:null,fetching:false,eventEpoch:0,abort:new AbortController()};sessions.set(id,state);
    const accept=config=>{if(disposed||sessions.get(id)!==state||config.apiVersion!==1||config.sessionId!==id)return;
      if(state.config?.revision===config.revision)return;state.config=config;for(const entry of rows.values())if(entry.sessionId===id){entry.version++;entry.update();}};
    const events=new EventSource('/preset-enhance/api/display-events?sessionId='+encodeURIComponent(id));state.events=events;
    events.onmessage=event=>{state.eventEpoch++;try{accept(JSON.parse(event.data));}catch{}};
    events.onerror=()=>{state.eventEpoch++;state.config=null;restoreSession(id);};
    state.refresh=async()=>{if(state.fetching)return;state.fetching=true;const epoch=state.eventEpoch;try{const r=await fetch('/preset-enhance/api/display?sessionId='+encodeURIComponent(id),{signal:state.abort.signal});if(!r.ok)throw Error();const config=await r.json();if(epoch===state.eventEpoch)accept(config);}catch{if(!disposed&&epoch===state.eventEpoch){state.config=null;restoreSession(id);}}finally{state.fetching=false;}};
    void state.refresh();return state;
  }
  async function update(entry) {
    if(disposed||!entry.row.isConnected)return;
    const session=sessions.get(entry.sessionId),config=session?.config,node=entry.source.getSnapshot();
    if(!config?.enabled||node?.kind!=='assistant-step'||visible.get(entry.row)===false){entry.last=null;entry.version++;restore(entry);return;}
    const {blocks,status,finalNode}=node.data;
    if(entry.status==='running'&&status!=='running')void session.refresh();entry.status=status;
    const mapping=mapTextElements(entry.row,blocks);if(!mapping){restore(entry);entry.last=null;return;}
    const depth=config.depths[finalNode?.messageId];
    // A live reply has no id yet and is always the newest assistant floor.
    const effectiveDepth=depth??(status==='running'?0:undefined);
    const signature=JSON.stringify([config.revision,blocks,status,effectiveDepth]);
    const elements=[...mapping.values()];
    if(signature===entry.last&&entry.elements?.length===elements.length&&entry.elements?.every((el,i)=>el===elements[i])&&entry.mounts.every(m=>m.container.isConnected))return;
    if(entry.busy){entry.again=true;return;}
    if(entry.elements?.some((el,i)=>el!==elements[i]))restore(entry);
    entry.last=signature;entry.elements=elements;entry.busy=true;entry.again=false;const version=++entry.version;
    const retained=new Set();
    try {
      for(const [runIndex,run] of textRuns(blocks).entries()){
        const originals=run.indexes.map(index=>mapping.get(index));if(originals.some(el=>!el?.isConnected))continue;
        const key=entry.sessionId+':'+entry.key+':'+runIndex;
        if(entry.failed===config.revision)continue;
        const answer=await executor.run(key,{texts:[run.text],scripts:config.scripts,depth:effectiveDepth,seed:key+':'+config.revision,local:config.local,global:config.global,values:config.values});
        if(disposed||version!==entry.version||!entry.row.isConnected||signature!==entry.last||session.config?.revision!==config.revision)break;
        if(answer.error){entry.failed=config.revision;entry.row.dataset.presetRegexError=answer.error;restore(entry);break;}
        if(answer.cancelled)continue;
        const text=answer.result.texts[0];if(text===run.text)continue;
        delete entry.row.dataset.presetRegexError;
        const existing=entry.mounts.find(m=>m.key===key);
        retained.add(key);
        if(existing){
          if(status==='running')existing.container.dataset.streaming='';else delete existing.container.dataset.streaming;
          existing.root.render(React.createElement(CommittedMarkdown,{text,streaming:status==='running'}));
          continue;
        }
        const container=document.createElement('div');container.dataset.presetDisplay='';container.style.minWidth='0';container.style.display='none';
        if(status==='running')container.dataset.streaming='';
        // Render the transformed Markdown normally, leaving fences available to GenUI.
        const root=createRoot(container);
        originals[0].before(container);
        // React's concurrent commit need not happen in the next animation frame.
        // A layout-effect acknowledgement keeps original text visible until ready.
        await new Promise(resolve=>{
          const timer=setTimeout(resolve,1000);
          root.render(React.createElement(CommittedMarkdown,{text,streaming:status==='running',onCommit:()=>{clearTimeout(timer);resolve();}}));
        });
        if(disposed||version!==entry.version||!container.isConnected||!container.childNodes.length||originals.some(el=>!el.isConnected)){root?.unmount();container.remove();if(version===entry.version)entry.last=null;continue;}
        const saved=originals.map(el=>[el,el.style.display]);for(const el of originals)el.style.display='none';
        container.style.display='';entry.mounts.push({key,root,container,originals:saved});
      }
      if(version===entry.version)for(const mount of [...entry.mounts])if(!retained.has(mount.key))releaseMount(entry,mount);
    }finally{entry.busy=false;if(entry.again){entry.last=null;scheduleEntry(entry);}}
  }
  function scheduleEntry(entry){if(entry.timer)return;entry.timer=setTimeout(()=>{entry.timer=null;void update(entry).catch(()=>{restore(entry);entry.last=null;});},entry.status==='running'?120:0);}
  function disposeRow(entry){entry.version++;clearTimeout(entry.timer);entry.unsubscribe?.();intersection?.unobserve(entry.row);restore(entry);rows.delete(entry.row);delete entry.row.dataset.presetRegexError;}
  function discover() {
    if(disposed)return;
    for(const [row,entry] of rows){
      const owner=row.closest('[data-conversation-session]')?.dataset.conversationSession;
      if(!row.isConnected||owner!==entry.sessionId||row.dataset.chatNodeKey!==entry.key||row.dataset.chatFlowKind!=='assistant-step'||row.dataset.chatGroupPart==='reasoning')disposeRow(entry);
    }
    for(const row of document.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-node-key]')){
      if(row.dataset.chatGroupPart==='reasoning')continue;
      const sessionId=row.closest('[data-conversation-session]')?.dataset.conversationSession,key=row.dataset.chatNodeKey;if(!sessionId||!key)continue;
      let source;try{source=ctx.uiConversation.binding(sessionId).target('chat')?.getSnapshot()?.nodes.source(key);}catch{}if(!source)continue;
      const existing=rows.get(row);
      if(existing?.source===source)continue;
      if(existing)disposeRow(existing);
      configSession(sessionId);
      const entry={row,sessionId,key,source,mounts:[],version:0,last:null,busy:false,update(){scheduleEntry(entry);}};
      rows.set(row,entry);entry.unsubscribe=source.subscribe(()=>{entry.version++;scheduleEntry(entry);});intersection?.observe(row);scheduleEntry(entry);
    }
    for(const [id,session] of sessions)if(![...rows.values()].some(e=>e.sessionId===id)){session.events.close();session.abort.abort();sessions.delete(id);}
  }
  function schedule(){if(disposed||frame)return;frame=requestAnimationFrame(()=>{frame=null;discover();});}
  const observer=new MutationObserver(records=>{
    let discoverNeeded=false;
    for(const record of records){
      if(record.type==='attributes'){discoverNeeded=true;continue;}
      if(record.target.closest?.('[data-preset-display]'))continue;
      const row=record.target.closest?.('[data-chat-flow-kind="assistant-step"]');
      const entry=rows.get(row);
      if(entry)entry.update();else discoverNeeded=true;
    }
    if(discoverNeeded)schedule();
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-conversation-session','data-chat-node-key','data-chat-group-part','data-chat-flow-kind']});schedule();
  return ()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();intersection?.disconnect();executor.close();for(const entry of [...rows.values()])disposeRow(entry);for(const session of sessions.values()){session.events.close();session.abort.abort();}sessions.clear();};
}
