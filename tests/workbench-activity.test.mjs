import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWorkbenchActivity } from '../web/workbench-activity.js';
import { observeRequestEvents } from '../web/request-events.js';
import { observeDisplayAvailability } from '../web/display-availability.js';

function fixture(parked = false) {
  const original = {window:globalThis.window, document:globalThis.document, EventSource:globalThis.EventSource, fetch:globalThis.fetch};
  const hooks = new Map(), docHooks = new Map(), events = [];
  const on = map => (name, fn) => { if (!map.has(name)) map.set(name,new Set()); map.get(name).add(fn); };
  const off = map => (name, fn) => map.get(name)?.delete(fn);
  globalThis.window = {parent:{},location:{origin:'http://fixture'},frameElement:{dataset:{presetEnhanceActive:String(!parked)}},addEventListener:on(hooks),removeEventListener:off(hooks)};
  globalThis.document = {visibilityState:'visible',addEventListener:on(docHooks),removeEventListener:off(docHooks)};
  globalThis.EventSource = class {constructor(url){this.url=url;events.push(this);}addEventListener(name,fn){this[name]=fn;}close(){this.closed=true;}};
  globalThis.fetch = () => new Promise(()=>{});
  const fire = (name,event) => { for (const fn of hooks.get(name)??[]) fn(event); };
  const message = (active,extra={}) => fire('message',{source:window.parent,origin:window.location.origin,data:{type:'preset-enhance:activity',active},...extra});
  return {events,fire,message,visibility(value){document.visibilityState=value;for(const fn of docHooks.get('visibilitychange')??[])fn();},restore(){Object.assign(globalThis,original);}};
}

test('parked workbenches release both subscriptions and resume once, ignoring stale events',()=>{
  const f=fixture(); const seen=[], snapshots=[]; let modes=0,pauses=0;
  const stopStatus=observeDisplayAvailability(v=>seen.push(v));
  const stopRequests=observeRequestEvents('session-a',{snapshot:id=>snapshots.push(id),mode:()=>modes++,pause:()=>pauses++});
  try {
    assert.equal(f.events.length,2);
    const request=f.events[1];
    request.onmessage({data:'{"id":"one"}'}); assert.deepEqual(snapshots,['one']);
    f.message(false,{source:{}});f.message(false,{origin:'http://other'});
    assert.ok(f.events.every(e=>!e.closed),'foreign messages cannot pause the workbench');
    f.message(false);assert.ok(f.events.every(e=>e.closed));assert.equal(pauses,1);
    request.onmessage({data:'{"id":"late"}'});request.mode();assert.deepEqual(snapshots,['one']);assert.equal(modes,0);
    f.message(true);f.message(true);assert.equal(f.events.length,4);
    assert.equal(seen.at(-1).available,false);
    f.visibility('hidden');assert.ok(f.events.every(e=>e.closed));
    f.message(false);f.visibility('visible');assert.equal(f.events.length,4,'hidden iframe stays paused when browser tab returns');
    f.message(true);assert.equal(f.events.length,6);
    f.fire('pagehide');assert.ok(f.events.every(e=>e.closed));f.fire('pageshow');assert.equal(f.events.length,8);
  }finally{stopRequests();stopStatus();assert.ok(f.events.every(e=>e.closed));f.restore();}
});

test('a cached frame loading after it was parked does not open subscriptions',()=>{
  const f=fixture(true);const seen=[];const stop=observeWorkbenchActivity(active=>seen.push(active));
  const requests=observeRequestEvents('s',{snapshot(){},mode(){},pause(){}});
  try{assert.deepEqual(seen,[false]);assert.equal(f.events.length,0);f.message(true);assert.deepEqual(seen,[false,true]);assert.equal(f.events.length,1);}
  finally{requests();stop();f.restore();}
});
