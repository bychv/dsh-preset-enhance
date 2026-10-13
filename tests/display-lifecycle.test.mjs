import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDisplayConfig } from '../lib/display-config.mjs';
import { PresetStore } from '../lib/store.mjs';
import { apply as applyDisplay } from '../packages/display-regex/index.mjs';
import { PRESET_DISPLAY_SERVICE, PRESET_DISPLAY_EVENT } from '../display-api.mjs';
import { observeDisplayAvailability, observeTemplateEvents } from '../web/display-availability.js';

const response = () => {
  const res = new EventEmitter(); res.output = '';
  res.writeHead = code => { res.code = code; }; res.write = text => { res.output += text; };
  res.end = text => { res.ended = true; res.output += text ?? ''; }; return res;
};
const snapshots = res => res.output.split('\n\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('display capability follows activation, disposal and replacement while preserving stored settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preset-display-life-'));
  const store = new PresetStore(join(directory, 'state.json'));
  const bus = new EventEmitter(), services = new Map(), routes = new Map(), mainStops = [];
  const effects = stops => fn => { const dispose = fn(); if (typeof dispose === 'function') stops.push(dispose); };
  const ctx = { on: (...args) => bus.on(...args), get: key => services.get(key), effect: effects(mainStops),
    sessions: { get: id => id === 's' ? { deriveMessages: () => [] } : undefined },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
  await store.transaction(state => { state.presets = [{id: 'p',name:'fixture',preset: {extensions: {'dsh-preset-enhance': {displayRegex: {enabled:true}}, regex_scripts: []}}}]; state.revision++; });
  installDisplayConfig(ctx, store, () => true, () => ({ presetId: 'p' }));
  const activate = async () => {
    const stops = [];
    await applyDisplay({ ...ctx, effect: effects(stops), provide: (key, value) => { services.set(key, value); stops.push(() => { if (services.get(key) === value) services.delete(key); }); }, emit: (...args) => bus.emit(...args) });
    return () => { for (const stop of stops.reverse()) stop(); };
  };
  const status = response(), config = response(); let stop;
  try {
    await routes.get('/preset-enhance/api/display-status-events')({method:'GET'}, status);
    await routes.get('/preset-enhance/api/display-events')({method:'GET',url:'/?sessionId=s'}, config);
    assert.equal(snapshots(status).at(-1).available, false);
    assert.equal(snapshots(config).at(-1).enabled, false);
    assert.equal(snapshots(config).at(-1).configuredEnabled, true);
    const saved = JSON.stringify(await store.read());
    stop = await activate(); await settle();
    const firstInstance = services.get(PRESET_DISPLAY_SERVICE).instance;
    assert.equal(snapshots(status).at(-1).available, true);
    assert.equal(snapshots(config).at(-1).enabled, true);
    stop(); await settle();
    assert.equal(snapshots(status).at(-1).available, false);
    assert.equal(snapshots(config).at(-1).enabled, false);
    assert.equal(JSON.stringify(await store.read()), saved);
    stop = await activate(); await settle();
    assert.notEqual(services.get(PRESET_DISPLAY_SERVICE).instance, firstInstance);
    assert.equal(snapshots(config).at(-1).enabled, true);
    await store.transaction(state => { state.presets[0].preset.extensions['dsh-preset-enhance'].displayRegex.enabled = false; state.revision++; });
    stop(); stop = await activate(); await settle();
    assert.equal(snapshots(config).at(-1).enabled, false);
    assert.ok(bus.listenerCount(PRESET_DISPLAY_EVENT) > 0);
  } finally { stop?.(); for (const dispose of mainStops.reverse()) dispose(); await store.close(); await rm(directory, {recursive:true,force:true}); }
  assert.equal(status.ended, true); assert.equal(config.ended, true);
});

test('browser availability rejects late GET after SSE, disconnects closed listeners and keeps unknown state off', async () => {
  const original = { fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  let events, finish;
  globalThis.EventSource = class { constructor(){ events = this; } close(){ this.closed = true; } };
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const seen = []; let stop;
  try {
    stop = observeDisplayAvailability(value => seen.push(value));
    assert.equal(seen.at(-1).available, false);
    events.onmessage({data:JSON.stringify({display:{apiVersion:1,available:false,instance:'new'}})});
    finish({ok:true,json:async()=>({apiVersion:1,available:true,instance:'old'})}); await settle();
    assert.equal(seen.at(-1).available, false);
    events.onmessage({data:JSON.stringify({display:{apiVersion:1,available:true,instance:'new'}})});
    assert.equal(seen.at(-1).available, true);
    events.onerror(); assert.equal(seen.at(-1).available, false);
    events.onmessage({data:'{}'}); assert.equal(seen.at(-1).available, false);
    stop(); const length = seen.length;
    events.onmessage({data:JSON.stringify({display:{apiVersion:1,available:true}})});
    assert.equal(seen.length, length); assert.equal(events.closed, true);
  } finally { stop?.(); Object.assign(globalThis, original); }
});

test('template and availability listeners share one connection and release their subscriptions independently', () => {
  const original = {fetch: globalThis.fetch, EventSource: globalThis.EventSource};
  const events = []; globalThis.EventSource = class { constructor(url){this.url=url;events.push(this);}close(){this.closed=true;} };
  globalThis.fetch = () => new Promise(() => {});
  let templates = 0, status;
  const releaseDisplay = observeDisplayAvailability(value => { status = value; });
  const releaseTemplate = observeTemplateEvents(() => { templates++; });
  try {
    assert.equal(events.length, 1);
    events[0].onmessage({data:JSON.stringify({revision:1,display:{apiVersion:1,available:true,instance:'a'}})});
    assert.equal(templates, 1);assert.equal(status.available,true);
    events[0].onmessage({data:JSON.stringify({revision:1,display:{apiVersion:1,available:false,instance:'a'}})});
    assert.equal(templates, 1);assert.equal(status.available,false);
    releaseDisplay();assert.equal(events[0].closed,undefined);
    events[0].onmessage({data:JSON.stringify({revision:2,display:{apiVersion:1,available:true,instance:'b'}})});
    assert.equal(templates,2);
    releaseTemplate();assert.equal(events[0].closed,true);
  }finally{releaseDisplay();releaseTemplate();Object.assign(globalThis,original);}
});

test('pagehide releases the notification transport and pageshow reconnects without stale availability', () => {
  const original = {fetch:globalThis.fetch,EventSource:globalThis.EventSource,window:globalThis.window};
  const hooks = new Map(),events=[],seen=[];
  globalThis.window={addEventListener(name,fn){(hooks.get(name)??hooks.set(name,new Set()).get(name)).add(fn);},removeEventListener(name,fn){hooks.get(name)?.delete(fn);}};
  globalThis.EventSource=class{constructor(){events.push(this);}close(){this.closed=true;}};
  globalThis.fetch=()=>new Promise(()=>{});
  const dispose=observeDisplayAvailability(value=>seen.push(value));
  try {
    events[0].onmessage({data:JSON.stringify({display:{apiVersion:1,available:true,instance:'old'}})});
    for(const fn of hooks.get('pagehide'))fn();assert.equal(events[0].closed,true);
    for(const fn of hooks.get('pageshow'))fn();assert.equal(events.length,2);assert.equal(seen.at(-1).available,false);
    events[0].onmessage({data:JSON.stringify({display:{apiVersion:1,available:true,instance:'old'}})});
    assert.equal(seen.at(-1).available,false);
    events[1].onmessage({data:JSON.stringify({display:{apiVersion:1,available:true,instance:'new'}})});assert.equal(seen.at(-1).instance,'new');
  }finally{dispose();Object.assign(globalThis,original);}
});
