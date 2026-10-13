import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberDisclosures} from '../web/disclosures.js';
function panel(key,open=false){let listener;return {dataset:{presetDisclosure:key},open,addEventListener(_name,fn){listener=fn;},removeEventListener(){listener=undefined;},toggle(value){this.open=value;listener?.({target:this});},initialEvent(){listener?.({target:this});}};}
const root=panels=>({querySelectorAll(selector){assert.equal(selector,'details[data-preset-disclosure]');return panels;}});
test('disclosure preferences survive remounts without resetting defaults or writing restored state',()=>{
 const values=new Map(),writes=[];const storage={getItem:key=>values.get(key),setItem(key,value){values.set(key,value);writes.push([key,value]);}};
 const first=panel('regex'),defaultOpen=panel('request',true);const dispose=rememberDisclosures(root([first,defaultOpen]),storage);
 assert.equal(defaultOpen.open,true);first.toggle(true);defaultOpen.toggle(false);assert.equal(writes.length,2);
 const second=panel('regex'),secondRequest=panel('request',true);rememberDisclosures(root([second,secondRequest]),storage);
 assert.equal(second.open,true);assert.equal(secondRequest.open,false);second.initialEvent();secondRequest.initialEvent();assert.equal(writes.length,2);
 dispose();first.toggle(false);assert.equal(writes.length,2);
});
test('storage failures do not block toggling; another panel toggle cannot overwrite the enclosing preference',()=>{
 const outer=panel('regex');rememberDisclosures(root([outer]),{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
 assert.doesNotThrow(()=>outer.toggle(true));assert.equal(outer.open,true);
});
