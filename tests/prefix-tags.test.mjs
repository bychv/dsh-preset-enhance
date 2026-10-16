import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReasoningPrefix, rewriteDeepSeekPrefixFetch } from '../lib/deepseek-beta.mjs';

test('think and thinking prefixes preserve exact reasoning and body across spelling and whitespace',()=>{
  for(const tag of ['think','thinking','THINK','Thinking']) {
    assert.deepEqual(splitReasoningPrefix(`< ${tag} >\r\nContinue here `),{tagged:true,content:'',reasoningContent:'Continue here '});
    assert.deepEqual(splitReasoningPrefix(`<${tag}>first\nsecond</ ${tag.toLowerCase()} >\nAnswer: `),{tagged:true,content:'Answer: ',reasoningContent:'first\nsecond'});
  }
  for(const content of ['Answer: ','Quoted <thinking>text','<thinker>text','```\n<think>text']) assert.deepEqual(splitReasoningPrefix(content),{tagged:false,content,reasoningContent:''});
});

test('thinking prefix reaches reasoning_content with and without tool conversion, while body prefixes stay body',()=>{
  for(const toolCalls of [false,true]) for(const tagged of [false,true]) {
    const prefix=tagged?'<thinking>\nContinue the fixture plan':'Answer: ';
    const registry=new Map([['s',new Map([[prefix,{count:1,mode:'chat-completions',toolCalls}]])]]);
    const body={model:'deepseek-flash',thinking:{type:'enabled'},messages:[{role:'user',content:'fixture'},{role:'assistant',content:prefix}],tools:[{type:'function',function:{name:'fixture_echo',parameters:{type:'object'}}}],stream:true};
    const init={method:'POST',headers:{'x-deepseek-harness-session-id':'s'},body:JSON.stringify(body)};
    const result=rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions',init,[registry]);
    assert.equal(result.input,'https://api.deepseek.com/beta/chat/completions');
    const wire=JSON.parse(result.init.body);const tail=wire.messages.at(-1);
    assert.equal(tail.prefix,true);assert.equal(tail.content,tagged?'':prefix);assert.equal(tail.reasoning_content,tagged?'Continue the fixture plan':'');
    assert.equal(wire.tools,undefined);
    if(toolCalls) assert.equal(result.responseTransform.reasoningPrefix,tail.reasoning_content);
    const disabled=rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions',{...init,body:JSON.stringify({...body,thinking:{type:'disabled'}})},[registry]);
    assert.equal(JSON.parse(disabled.init.body).messages.at(-1).content,prefix,'non-thinking requests keep literal tags');
  }
});


test('an explicit target routes tagged and plain prefixes independently of tool conversion',()=>{
  for(const target of ['reasoning','content']) for(const prefix of ['Continue here','<thinking>\nContinue here','<think>Continue here</think>\nThen this']) for(const toolCalls of [true,false]) {
    const entry={count:1,mode:'chat-completions',target,toolCalls};
    const registry=new Map([['s',new Map([[prefix,entry]])]]);
    const body={thinking:{type:'enabled'},messages:[{role:'assistant',content:'prior answer',reasoning_content:'prior reasoning'},{role:'user',content:'fixture'},{role:'assistant',content:prefix}],tools:[{type:'function',function:{name:'fixture_echo',parameters:{type:'object'}}}]};
    const init={method:'POST',headers:{'x-deepseek-harness-session-id':'s'},body:JSON.stringify(body)};
    const result=rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions',init,[registry]);
    const wire=JSON.parse(result.init.body),tail=wire.messages.at(-1);
    assert.equal(tail.prefix,true);
    assert.equal(tail.content,target==='content'?prefix:'');
    assert.equal(tail.reasoning_content,target==='reasoning'?(prefix.includes('Then this')?'Continue here\nThen this':'Continue here'):'');
    if(toolCalls) {assert.equal(result.responseTransform.reasoningPrefix,tail.reasoning_content);assert.equal(result.responseTransform.contentPrefix,tail.content);}
    else assert.equal(wire.messages[0].reasoning_content,'prior reasoning','history retains its original channel');
    const disabled=rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions',{...init,body:JSON.stringify({...body,thinking:{type:'disabled'}})},[registry]);
    assert.equal(JSON.parse(disabled.init.body).messages.at(-1).content,prefix);
  }
});
