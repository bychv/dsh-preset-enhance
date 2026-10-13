import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { transformDisplayText, planDisplayRegex } from '../lib/display-regex.mjs';
import { PresetStore } from '../lib/store.mjs';
import { installDisplayConfig } from '../lib/display-config.mjs';
import { RegexExecutor } from '../packages/display-regex/executor.mjs';
import { textRuns, mapTextElements } from '../packages/display-regex/runtime.mjs';
import { decodePresetDocument, encodePresetPackage } from '../lib/preset-package.mjs';
const rule = (over = {}) => ({ id:'r',findRegex:'/foo/g',replaceString:'bar',placement:[2],markdownOnly:true,promptOnly:false,...over });

test('display channel is independent from prompt selection and preserves raw inputs',()=>{
  for(const promptOnly of [true,false]) for(const markdownOnly of [true,false]) {
    const scripts=[rule({promptOnly,markdownOnly})];
    assert.equal(transformDisplayText({texts:['foo'],scripts}).texts[0],markdownOnly?'bar':'foo');
    assert.equal(transformDisplayText({texts:['foo'],scripts,channel:'prompt'}).texts[0],promptOnly?'bar':'foo');
  }
  assert.equal(transformDisplayText({texts:['foo'],scripts:[rule()],target:'user'}).texts[0],'foo');
  assert.equal(planDisplayRegex(rule({placement:[1]}),0).runs,false);
  assert.equal(planDisplayRegex(rule({disabled:true}),0).runs,false);
  assert.equal(planDisplayRegex(rule({minDepth:0})).runs,false);
  assert.equal(planDisplayRegex(rule({minDepth:1}),0).runs,false);
  assert.equal(planDisplayRegex(rule({maxDepth:0}),0).runs,true);
  assert.equal(planDisplayRegex(rule({findRegex:'/[/'}),0).runs,false);
});

test('capture groups, macros and ordered rules run on a copy without persisting variables',()=>{
  const local={k:'before'},global={x:'before'},texts=['foo-42'];
  const scripts=[rule({findRegex:'/foo-(\\d+)/g',replaceString:'{{setvar::k::changed}}item-$1'}),rule({id:'second',findRegex:'/item/g',replaceString:'{{getvar::k}}'})];
  const result=transformDisplayText({texts,scripts,local,global});
  assert.equal(result.texts[0],'changed-42');
  assert.deepEqual(result.applied,['r','second']);
  assert.deepEqual(local,{k:'before'});assert.deepEqual(global,{x:'before'});assert.deepEqual(texts,['foo-42']);
  assert.equal(transformDisplayText({texts:['<b>foo</b>'],scripts:[rule({replaceString:'<script>literal</script>'})]}).texts[0],'<b><script>literal</script></b>');
  assert.throws(()=>transformDisplayText({texts:['a'.repeat(10000)],scripts:[rule({findRegex:'/a/g',replaceString:'b'.repeat(1000)})]}),/上限/);
  assert.throws(()=>transformDisplayText({texts:['a'.repeat(524289)],scripts:[]}),/上限/);
  assert.throws(()=>transformDisplayText({texts:['a'.repeat(300000),'b'.repeat(300000)],scripts:[]}),/上限/);
});

test('share packages keep display configuration, unknown fields and separate RegexBinding',()=>{
  const preset={prompts:[],extensions:{regex_scripts:[rule({future:{keep:1}})],SPreset:{RegexBinding:[{id:'not-active'}]},'dsh-preset-enhance':{displayRegex:{enabled:true}}}};
  const result=decodePresetDocument(encodePresetPackage({name:'虚构',preset},{}));
  assert.deepEqual(result.preset.extensions,preset.extensions);
});

test('store observers see only committed writes, share a path and dispose independently',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'display-store-'));
  const a=new PresetStore(join(dir,'state.json')),b=new PresetStore(a.file);const seen=[];
  const stop=a.subscribe(s=>{seen.push(s.revision);s.global.modified='observer';});
  const stopBad=b.subscribe(()=>{throw Error('observer');});
  try {
    await b.transaction(s=>{s.revision++;});assert.deepEqual(seen,[1]);
    assert.equal((await a.read()).global.modified,undefined);
    await assert.rejects(b.transaction(()=>{throw Error('abort');}));assert.deepEqual(seen,[1]);
    stop();await a.transaction(s=>{s.revision++;});assert.deepEqual(seen,[1]);
  } finally {stop();stopBad();await a.close();await b.close();await rm(dir,{recursive:true,force:true});}
});

test('authenticated display config excludes message text, streams committed changes and closes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'display-api-')),store=new PresetStore(join(dir,'state.json'));
  const routes=new Map(),cleanup=[];
  const ctx={on(){}, get:()=>({apiVersion:1,instance:'fixture',ready:true}), sessions:{get:id=>id==='s'?{deriveMessages:()=>[{id:'m',role:'assistant',content:[{type:'text',text:'PRIVATE_HISTORY'}]}]}:null},webServer:{register:r=>{routes.set(r.path,r.handler);return ()=>routes.delete(r.path);}},effect(fn){const stop=fn();if(stop)cleanup.push(stop);}};
  await store.transaction(s=>{s.revision=1;s.presets=[{id:'p',name:'fixture',preset:{prompts:[{content:'PRIVATE_PRESET'}],extensions:{regex_scripts:[rule()], 'dsh-preset-enhance':{displayRegex:{enabled:true}}}}}];});
  installDisplayConfig(ctx,store,()=>true,()=>({presetId:'p',enabled:true}));
  const response=()=>{const res=new EventEmitter();res.output='';res.writeHead=(code,headers)=>{res.code=code;res.headers=headers;};res.write=t=>{res.output+=t;};res.end=t=>{res.ended=true;res.output+=t??'';};return res;};
  try {
    const get=routes.get('/preset-enhance/api/display'),res=response();await get({method:'GET',url:'/?sessionId=s'},res);
    const config=JSON.parse(res.output);assert.equal(config.enabled,true);assert.equal(config.depths.m,0);assert.equal(res.output.includes('PRIVATE'),false);
    const invalid=response();await get({method:'GET',url:'/?sessionId=missing'},invalid);assert.equal(invalid.code,400);
    const stream=response();await routes.get('/preset-enhance/api/display-events')({method:'GET',url:'/?sessionId=s'},stream);
    assert.equal(stream.output.split('data: ').length,2);
    await store.transaction(s=>{s.revision++;s.presets[0].preset.extensions['dsh-preset-enhance'].displayRegex.enabled=false;});
    const events=stream.output.split('\n\n').filter(v=>v.startsWith('data: ')).map(v=>JSON.parse(v.slice(6)));
    assert.equal(events.length,2);assert.equal(events[1].enabled,false);assert.notEqual(events[0].revision,events[1].revision);
    for(const stop of cleanup.reverse())stop();assert.equal(stream.ended,true);
  } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});

test('text runs do not match across reasoning, image or tool boundaries and unsafe mapping is rejected',()=>{
  const blocks=[{kind:'text',text:'a'},{kind:'text',text:'b'},{kind:'reasoning',text:'private'},{kind:'text',text:'c'},{kind:'tool-call'}];
  assert.deepEqual(textRuns(blocks).map(r=>r.text),['a\nb','c']);
  assert.equal(mapTextElements({dataset:{},firstElementChild:null},blocks),null);
  const el={classList:['fixture_markdown_hash']};const body={parentElement:{},children:[el]};const shell={dataset:{},firstElementChild:body,children:[body]};
  assert.equal(mapTextElements({dataset:{},firstElementChild:shell},blocks),null);
  assert.equal(mapTextElements({dataset:{},firstElementChild:shell},[{kind:'text',text:'a'}]).get(0),el);
  const slot={dataset:{slot:'conversation.chat.node'},firstElementChild:shell,children:[shell]};
  assert.equal(mapTextElements({dataset:{},firstElementChild:slot},[{kind:'text',text:'a'}]).get(0),el);
});

test('executor discards stale queued work, kills timeout and restarts without blocking the UI',async()=>{
  const previous=globalThis.Worker,workers=[];
  class Worker {constructor(){workers.push(this);}postMessage(message){this.message=message;}terminate(){this.terminated=true;}reply(){this.onmessage({data:{id:this.message.id,result:{texts:['ok']}}});}}
  globalThis.Worker=Worker;const executor=new RegexExecutor('fixture',30);
  try {
    const a=executor.run('a',{}),old=executor.run('b',{}),latest=executor.run('b',{});
    assert.equal((await old).cancelled,true);assert.match((await a).error,/超时/);assert.equal(workers[0].terminated,true);
    workers[1].reply();assert.deepEqual((await latest).result.texts,['ok']);
    const closing=executor.run('c',{});executor.close();assert.equal((await closing).cancelled,true);
  } finally {executor.close();globalThis.Worker=previous;}
});
