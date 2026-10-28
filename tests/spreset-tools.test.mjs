import test from 'node:test';
import assert from 'node:assert/strict';
import { runSPresetScript } from '../lib/spreset-script.mjs';
import { readSPresetTools, createSPresetTools, consumeSPresetStream } from '../lib/spreset-tools.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeSPresetData } from '../lib/s-preset-library.mjs';

const code = 'return {name:"story_reply",description:"Fictional output",parameters:{type:"object",properties:{content:{type:"string"}}},action:async args=>({accepted:args.content})};';
const preset = () => ({ dsh_spreset_tools_enabled:true, prompts:[{identifier:'tool',role:'system',content:''}],
  prompt_order:[{character_id:100001,order:[{identifier:'tool',enabled:true}]}],
  extensions:{SPreset:{ToolBindings:{tool:{enabled:true,valid:true,code}},OutputPreprocessing:{enabled:true,
    script:'({buffer})=>({output:buffer,hold:""})',consumeToolCalls:true,toolCallFormatter:{enabled:true,script:'({calls})=>calls.map(c=>c.arguments.content).join("\\n")'}}}} });
const config = () => preset().extensions.SPreset;
async function collect(chunks, settings=config(), signal) { const result=[]; for await (const c of consumeSPresetStream((async function*(){yield* chunks;})(),settings,{},signal)) result.push(c); return result; }
const call = (index=0,name='story_reply',args='{"content":"Fictional answer"}') => [
  {type:'block-start',index,blockType:'tool-call'},
  {type:'tool-call-delta',index,id:'fictional',name,argumentsDelta:args.slice(0,7)},
  {type:'tool-call-delta',index,id:'fictional',argumentsDelta:args.slice(7)},
  {type:'block-end',index,block:{type:'tool-call',id:'fictional',name,arguments:args}},
];
const finish = kind => ({type:'finish',reason:{kind},replayState:{provider:'fictional'}});

test('QuickJS pure sync/async code, host isolation, cancellation and bounded execution', async () => {
  assert.deepEqual(await runSPresetScript('Promise.resolve({ok:input.value})',{value:'fictional'}),{ok:'fictional'});
  assert.deepEqual(await runSPresetScript('[typeof process,typeof fetch,typeof require,typeof SillyTavern]',{}),['undefined','undefined','undefined','undefined']);
  await assert.rejects(runSPresetScript('(()=>{while(true){}})()',{}),/interrupted|超时/);
  await assert.rejects(runSPresetScript('new Promise(()=>{})',{}),/外部异步/);
  await assert.rejects(runSPresetScript('undefined',{}),/序列化/);
  await assert.rejects(runSPresetScript('input',{},AbortSignal.abort()),/abort/i);
});

test('binding code is authoritative; order, off switch, schema/name and unsupported flags',async()=>{
  const p=preset();p.extensions.SPreset.ToolBindings.tool.form={name:'wrong'};
  assert.equal((await readSPresetTools({id:'p',preset:p}))[0].name,'story_reply');
  p.dsh_spreset_tools_enabled=false;assert.deepEqual(await readSPresetTools({id:'p',preset:p}),[]);
  p.dsh_spreset_tools_enabled=true;p.prompt_order[0].order[0].enabled=false;assert.deepEqual(await readSPresetTools({id:'p',preset:p}),[]);
  p.prompt_order[0].order[0].enabled=true;p.extensions.SPreset.ToolBindings.tool.code=code.replace('action:', 'stealth:true,action:');
  await assert.rejects(readSPresetTools({id:'p',preset:p}),/stealth/);
  p.extensions.SPreset.ToolBindings.tool.code=code;p.prompts[0].spreset_condition_enabled=true;
  await assert.rejects(readSPresetTools({id:'p',preset:p}),/条件/);
});

test('agent registrations execute through the host, isolate, update code, and release on toggle/dispose',async()=>{
  const cleanups=[],p=preset();let allowed=true;
  const selections=new Map();
  const manager=createSPresetTools({effect:fn=>cleanups.push(fn())},async a=>selections.get(a),()=>allowed);
  function agent(){const defs=new Map(),cleanup=[];return {session:{id:String(Math.random())},defs,cleanup,ctx:{effect:fn=>cleanup.push(fn()),tools:{get:n=>defs.get(n),register:(def,opt)=>{defs.set(def.name,def);def.when=opt.when;return ()=>defs.delete(def.name);}}}};}
  const a=agent(),b=agent();selections.set(a,{id:'p',preset:p});selections.set(b,{id:'q',preset:preset()});
  await manager.prepare(a);await manager.prepare(b);
  assert.notEqual(a.defs.get('story_reply'),b.defs.get('story_reply'));
  const old=a.defs.get('story_reply');assert.deepEqual(await old.execute({content:'hello'},{}),{accepted:'hello'});
  allowed=false;assert.equal(old.when(),false);await assert.rejects(old.execute({content:'x'},{}),/停用/);allowed=true;
  p.extensions.SPreset.ToolBindings.tool.code=code.replace('accepted:args.content','changed:args.content');
  await manager.prepare(a);await assert.rejects(old.execute({},{}),/变化/);assert.deepEqual(await a.defs.get('story_reply').execute({content:'x'},{}),{changed:'x'});
  p.dsh_spreset_tools_enabled=false;await manager.prepare(a);assert.equal(a.defs.size,0);assert.equal(b.defs.size,1);
  for(const cleanup of cleanups.reverse())cleanup();assert.equal(b.defs.size,0);
});

test('successful consumption generates body, skips all calls, preserves usage and delays finish',async()=>{
  const rows=await collect([...call(),{type:'usage',usage:{inputTokens:1}},finish('tool-calls')]);
  assert.equal(rows.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'Fictional answer');
  assert.equal(rows.some(c=>c.type==='tool-call-delta'),false);assert.equal(rows.some(c=>c.block?.type==='tool-call'),false);
  assert.equal(rows.at(-1).reason.kind,'stop');assert.deepEqual(rows,JSON.parse(JSON.stringify(rows)));assert.equal(Object.hasOwn(rows.at(-1),'replayState'),false);
  assert.equal(rows.find(c=>c.type==='block-end').block.text,'Fictional answer');assert.ok(rows.some(c=>c.type==='usage'));
  const index=rows.find(c=>c.type==='block-start').index;assert.equal(index,rows.find(c=>c.type==='block-end').index);
});

test('body remains streaming; hold/state and final flush share one output session',async()=>{
 const s=config();s.OutputPreprocessing.script='({buffer,final,state})=>final?{output:buffer+state.tail,hold:""}:{output:buffer.slice(0,-1),hold:buffer.slice(-1),state:{tail:"!"}}';
 const rows=await collect([{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'AB'},{type:'block-end',index:0,block:{type:'text',text:'AB'}},finish('stop')],s);
 assert.equal(rows.find(c=>c.type==='text-delta').text,'A');assert.equal(rows.find(c=>c.type==='block-end').block.text,'AB!');
});

test('formatter disabled uses defaults; consume disabled leaves host tools intact',async()=>{
 const s=config();s.OutputPreprocessing.toolCallFormatter.enabled=false;
 assert.equal((await collect([...call(),finish('tool-calls')],s)).find(c=>c.type==='text-delta').text,'Fictional answer');
 s.OutputPreprocessing.consumeToolCalls=false;const rows=await collect([...call(),finish('tool-calls')],s);assert.ok(rows.some(c=>c.type==='tool-call-delta'));assert.equal(rows.at(-1).reason.kind,'tool-calls');
});

test('format or finalization failure restores complete native calls without fabricated body',async()=>{
 for(const field of ['formatter','output']){
  const s=config();if(field==='formatter')s.OutputPreprocessing.toolCallFormatter.script='()=>{throw Error("fictional")}';else s.OutputPreprocessing.script='({buffer,final})=>{if(final)throw Error("fictional");return buffer;}';
  const rows=await collect([...call(),finish('tool-calls')],s);
  assert.ok(rows.some(c=>c.type==='tool-call-delta'));assert.ok(rows.some(c=>c.block?.type==='tool-call'));assert.equal(rows.some(c=>c.type==='text-delta'),false);assert.equal(rows.at(-1).reason.kind,'tool-calls');
 }
});

test('errors, max tokens, incomplete arguments and missing terminal never become successful consumption',async()=>{
 for(const terminal of [finish('error'),finish('aborted'),finish('max-tokens'),undefined]){
  const rows=await collect([...call(),...terminal?[terminal]:[]]);assert.equal(rows.some(c=>c.type==='text-delta'),false);assert.ok(rows.some(c=>c.type==='tool-call-delta'));if(terminal)assert.equal(rows.at(-1).reason.kind,terminal.reason.kind);
 }
 const rows=await collect([...call(0,'story_reply','{bad'),finish('tool-calls')]);assert.ok(rows.some(c=>c.type==='tool-call-delta'));
 const partial=await collect([...call().slice(0,-1),finish('tool-calls')]);assert.ok(partial.some(c=>c.type==='tool-call-delta'));assert.equal(partial.some(c=>c.type==='text-delta'),false);
});

test('normalization preserves object formatter and legacy source',()=>{
 const s=config();assert.deepEqual(normalizeSPresetData(s).OutputPreprocessing.toolCallFormatter,s.OutputPreprocessing.toolCallFormatter);
 s.OutputPreprocessing.toolCallFormatter='({calls})=>"legacy"';assert.equal(normalizeSPresetData(s).OutputPreprocessing.toolCallFormatter,s.OutputPreprocessing.toolCallFormatter);
});

test('workbench toggle reads saved preference and changes the current preset draft',()=>{
 const nodes=new Map(),listeners=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{checked:false,textContent:'',addEventListener:(type,fn)=>listeners.set(id+type,fn)});return nodes.get(id);};
 let draft={};let changed=0;
 const context={document:{getElementById:get}};
 runInNewContext(readFileSync(new URL('../web/spreset-tools.js',import.meta.url),'utf8').replace(/^export /gm,'')+';globalThis.ui={renderSPresetTools,bindSPresetTools}',context);
 context.ui.bindSPresetTools(()=>draft,()=>changed++);
 context.ui.renderSPresetTools(draft);assert.equal(get('spreset-tools-enabled').checked,false);
 listeners.get('spreset-tools-enabledchange')({target:{checked:true}});assert.equal(draft.dsh_spreset_tools_enabled,true);assert.equal(changed,1);
 draft={dsh_spreset_tools_enabled:false};context.ui.renderSPresetTools(draft);assert.equal(get('spreset-tools-enabled').checked,false);
});

test('formatter failure flushes the original held body before restoring calls',async()=>{
 const s=config();s.OutputPreprocessing.toolCallFormatter.script='()=>{throw Error("fictional")}';s.OutputPreprocessing.script='({buffer,final})=>final?buffer:{output:"",hold:buffer}';
 const rows=await collect([{type:'block-start',index:2,blockType:'text'},{type:'text-delta',index:2,text:'Held text'},...call(),finish('tool-calls')],s);
 assert.equal(rows.find(c=>c.block?.type==='text').block.text,'Held text');assert.ok(rows.some(c=>c.type==='tool-call-delta'));
});
