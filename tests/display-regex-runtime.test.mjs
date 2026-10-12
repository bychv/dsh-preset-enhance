import test from 'node:test';
import assert from 'node:assert/strict';
import { installDisplay } from '../packages/display-regex/runtime.mjs';
import { transformDisplayText } from '../lib/display-regex.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i=0;i<120;i++) { if(fn())return;await delay(10); }
  assert.fail('display state did not settle');
}

// A delayed React commit is intentional: a frame is not a commit acknowledgement.
// The browser integration additionally checks the actual DSH/React/Markdown modules.
test('display survives concurrent commits, restores on config changes and releases on teardown', async()=>{
  const saved = Object.fromEntries(['document','Worker','EventSource','fetch','MutationObserver','IntersectionObserver','requestAnimationFrame','cancelAnimationFrame'].map(k=>[k,globalThis[k]]));
  class Element {
    constructor(){this.dataset={};this.style={display:''};this.classList=[];this.children=[];this.parentElement=null;this.textContent='';}
    get firstElementChild(){return this.children[0];}
    get childNodes(){return this.children;}
    get isConnected(){return this===body||this.parentElement?.isConnected===true;}
    append(child){child.parentElement=this;this.children.push(child);}
    before(child){const parent=this.parentElement;child.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,child);}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(e=>e!==this);this.parentElement=null;}
    closest(selector){
      if(selector==='[data-preset-display]'&&Object.hasOwn(this.dataset,'presetDisplay'))return this;
      if(selector==='[data-conversation-session]'&&this.dataset.conversationSession)return this;
      return this.parentElement?.closest(selector)??null;
    }
  }
  const body=new Element(),view=new Element(),row=new Element(),slot=new Element(),shell=new Element(),prose=new Element(),raw=new Element();
  view.dataset.conversationSession='s';row.dataset={chatFlowKind:'assistant-step',chatNodeKey:'node',chatGroupPart:'response'};slot.dataset.slot='conversation.chat.node';raw.classList=['host_markdown'];
  body.append(view);view.append(row);row.append(slot);slot.append(shell);shell.append(prose);prose.append(raw);
  const listeners=new Set();let node={kind:'assistant-step',data:{status:'settled',finalNode:{messageId:'m'},blocks:[{kind:'text',text:'foo'}]}};
  const source={getSnapshot:()=>node,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
  const ctx={uiConversation:{binding:()=>({target:()=>({getSnapshot:()=>({nodes:{source:()=>source}})})})}};
  const base={apiVersion:1,sessionId:'s',enabled:true,revision:'one',depths:{m:0},scripts:[{id:'rule',findRegex:'/foo/g',replaceString:'bar',placement:[2],markdownOnly:true}]};
  const events=[];let observerCallback,observerDisconnected=false,workerTerminated=false,rootCount=0;
  class Worker {
    postMessage({id,task}) {setTimeout(()=>{if(!this.stopped)this.onmessage({data:{id,result:transformDisplayText(task)}});},1);}
    terminate(){this.stopped=true;workerTerminated=true;}
  }
  class EventSource {
    constructor(){events.push(this);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(base)}));}
    close(){this.closed=true;}
  }
  const React={createElement:(type,props)=>({type,props}),useLayoutEffect(fn){React.effects.push(fn);},effects:[]};
  const createRoot=container=>{
    rootCount++;let dead=false;
    return {render(v){setTimeout(()=>{if(dead)return;React.effects=[];v.type(v.props);const child=new Element();child.textContent=v.props.text;container.children=[];container.append(child);for(const effect of React.effects)effect();},40);},unmount(){dead=true;container.children=[];}};
  };
  globalThis.document={body,createElement:()=>new Element(),querySelectorAll:()=>[row]};
  globalThis.Worker=Worker;globalThis.EventSource=EventSource;
  let releaseFetch;
  globalThis.fetch=()=>new Promise(resolve=>{releaseFetch=()=>resolve({ok:true,json:async()=>base});});
  globalThis.MutationObserver=class {constructor(fn){observerCallback=fn;}observe(){}disconnect(){observerDisconnected=true;}};
  globalThis.IntersectionObserver=undefined;
  globalThis.requestAnimationFrame=cb=>setTimeout(cb,5);globalThis.cancelAnimationFrame=clearTimeout;
  const displays=()=>prose.children.filter(e=>Object.hasOwn(e.dataset,'presetDisplay'));
  let stop;
  try {
    stop=installDisplay(ctx,{React,createRoot,MarkdownText:()=>null});
    await until(()=>displays().length===1&&raw.style.display==='none');
    const first=displays()[0];assert.equal(first.children[0].textContent,'bar');assert.equal(node.data.blocks[0].text,'foo');
    node={...node,data:{...node.data,blocks:[{kind:'text',text:'foo updated'}]}};for(const fn of listeners)fn();
    await until(()=>displays()[0]?.children[0]?.textContent==='bar updated');assert.equal(displays()[0],first);assert.equal(rootCount,1,'stream updates reuse the committed root');
    node={...node,data:{...node.data,blocks:[{kind:'text',text:'foo updated\n```dsh-ui\n{}\n```'}]}};for(const fn of listeners)fn();
    await until(()=>displays()[0]?.children[0]?.textContent.includes('```dsh-ui'));assert.equal(displays()[0],first,'component fence does not force rollback');
    events[0].onmessage({data:JSON.stringify({...base,revision:'two',enabled:false})});
    await until(()=>!displays().length);assert.equal(raw.style.display,'');
    releaseFetch();await delay(20);assert.equal(displays().length,0,'late GET cannot undo a newer SSE configuration');
    events[0].onmessage({data:JSON.stringify({...base,revision:'three'})});
    await until(()=>displays().length===1&&raw.style.display==='none');assert.ok(displays()[0].children[0].textContent.startsWith('bar updated'));
    events[0].onerror();await until(()=>!displays().length);assert.equal(raw.style.display,'');
    events[0].onmessage({data:JSON.stringify({...base,revision:'four'})});await until(()=>displays().length===1&&raw.style.display==='none');
    // React may reuse a row with the same node key when changing sessions.
    view.dataset.conversationSession='other';observerCallback([{type:'attributes',target:view}]);
    await until(()=>events.length===2&&events[0].closed===true);
    assert.equal(displays().length,0,'old-session display must not leak into a reused row');
    events[1].onmessage({data:JSON.stringify({...base,sessionId:'other',revision:'other'})});
    await until(()=>displays().length===1&&raw.style.display==='none');
    stop();assert.equal(displays().length,0);assert.equal(raw.style.display,'');assert.equal(listeners.size,0);assert.equal(events[1].closed,true);assert.equal(observerDisconnected,true);assert.equal(workerTerminated,true);
  } finally {stop?.();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
