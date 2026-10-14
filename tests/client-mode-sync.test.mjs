import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('the unbound workbench follows the input mode store without reloading its iframe or selecting a mode', () => {
  let definition, mode = 'standard', selected = 0, cursor = 0, entryListeners = [], storeSubscriptions = 0;
  const refs = [], effects = [], registrations = [], messages = [], frames = [], hooks = [];
  let effectCursor = 0;
  const source = {getSnapshot:()=>({current:mode}), subscribe:()=>{storeSubscriptions++; return ()=>{};}};
  let entry = {inject:()=>({hooks:{agentPresetSeat:source},select:()=>{selected++;}})};
  const window = {addEventListener(){}, removeEventListener(){}, innerWidth:1000, innerHeight:800, location:{origin:'http://localhost'}, __ModuleLoader__:{load:value=>{definition=value;}}};
  const style = {setAttribute(){},remove(){},isConnected:true};
  const document = {querySelector:()=>style, createElement:(tag)=>tag === 'iframe' ? {style:{},setAttribute(){},removeAttribute(){},addEventListener(){},removeEventListener(){},remove(){this.isConnected=false;},contentWindow:{postMessage:(value,origin)=>messages.push({value,origin})}} : style, body:{appendChild(frame){frame.isConnected=true;frames.push(frame);}}, head:{appendChild(){}}, documentElement:{setAttribute(){},removeAttribute(){}}};
  runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),{window,document,Set});
  const React = {createElement:(type,props)=>({type,props}),
    useRef:value=>refs[cursor++]??(refs[cursor-1]={current:value}),
    useEffect:(fn,deps)=>{const i=effectCursor++;const prev=hooks[i];
      if(!prev || deps.some((d,n)=>d!==prev.deps[n])) effects.push(()=>{prev?.cleanup?.();hooks[i]={deps,cleanup:fn()};});}, useSyncExternalStore:(subscribe,read)=>{subscribe(()=>{});return read();}};
  const plugin = definition.factory(()=>React);
  plugin.apply({slots:{inject:(_key,fn)=>fn(),register:(options,component)=>{registrations.push({options,component});return()=>{};},
    entriesOfSlot:()=>[entry],subscribe:(_key,listener)=>{entryListeners.push(listener);return()=>{};}}});
  const Main = registrations.find(row=>row.options.name==='main').component;
  const render = (current='', byId={})=>{cursor=0;effectCursor=0;return Main({useSessions:select=>select({current,byId})});};
  const first=render();
  const anchor={isConnected:true,getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:800,width:1000,height:800}),closest:()=>null};
  first.props.ref.current=anchor;
  for(const effect of effects.splice(0))effect();
  const firstFrame=frames.at(-1);
  assert.equal(firstFrame.src,'/preset-enhance?sessionId=&modeId=standard');
  mode='minimal';
  const changed=render();
  for(const effect of effects.splice(0))effect();
  assert.equal(frames.at(-1),firstFrame,'mode updates must preserve the workbench draft');
  assert.equal(frames.length,1);
  assert.equal(messages.at(-1).value.modeId,'minimal'); assert.equal(messages.at(-1).origin,'http://localhost');
  assert.equal(selected,0,'reading the chip never applies a selection'); assert.ok(storeSubscriptions>0);
  // Host hot reload replaces the slot face; next render binds its new source.
  entry={inject:()=>({hooks:{agentPresetSeat:{getSnapshot:()=>({current:'ptc'}),subscribe:()=>()=>{}}}})};
  for(const listener of entryListeners)listener();
  render();for(const effect of effects.splice(0))effect();
  assert.equal(messages.at(-1).value.modeId,'ptc');
  // Typing creates a retained blank Session; current is absent in DSH 0.2.1.
  let requestedSession;
  entry={inject:id=>{requestedSession=id;return {hooks:{agentPresetSeat:source}};}};
  const byId={unrelated:{id:'unrelated',retainedBy:{sidebar:1}}, blank:{id:'created-session',blank:true,retainedBy:{mainView:1}}};
  const bound=render(undefined,byId);
  assert.equal(requestedSession,'created-session');
  mode='standard';for(const effect of effects.splice(0))effect();
  const boundFrame=frames.at(-1);
  mode='minimal';const afterTyping=render(undefined,byId);for(const effect of effects.splice(0))effect();
  assert.equal(frames.at(-1),boundFrame);
  assert.equal(messages.at(-1).value.modeId,'minimal','bound blank Sessions also notify the iframe');
  assert.equal(boundFrame.src,'/preset-enhance?sessionId=created-session','the new Session gets its own frame and server-effective mode');
});
