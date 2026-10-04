import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../index.mjs';
import { PresetStore } from '../lib/store.mjs';
import { serializeRequest } from '../vendor/deepseek-chat/index.mjs';

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
async function setup(run, historyMode = false) {
  const dir = await mkdtemp(join(tmpdir(), 'preset-dynamic-request-'));
  const store = new PresetStore(join(dir, 'state.json'));
  const originalFetch = globalThis.fetch, sent = [], routes = new Map(), services = new Map(), listeners = {}, disposers = [];
  const histories = { a: [user('u1', 'hello')], b: [user('u2', 'other')] };
  const tools = [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } }];
  globalThis.fetch = async (url, init) => { sent.push({ url, raw: init.body }); return new Response('{}'); };
  const session = id => ({ id, header: { agentPreset: 'standard' }, deriveMessages: () => histories[id] ?? [],
    requestHeader: () => ({ config: { provider: 'preset-deepseek-chat', model: 'deepseek-chat', reasoningEffort: 'off' } }) });
  const ctx = {
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    provide: (key, value) => services.set(key, value), get: key => services.get(key), on: (key, fn) => { listeners[key] = fn; },
    sessions: { get: session }, agents: { get: id => ({ session: session(id), ctx: { tools: { schemas: () => tools } } }) },
    webServer: { register: route => { routes.set(route.path, route); } },
    llm: { stream: options => listeners['llm/stream'](options, async function* () {
      const wire = serializeRequest(options);
      for (let retry = 0; retry < (options.retries ?? 1); retry++) await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { 'x-deepseek-harness-session-id': options.sessionId }, body: JSON.stringify(wire) });
      yield 'finish';
    }) },
  };
  const post = async body => {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method: 'POST', url: '/preset-enhance/api', headers: { host: 'localhost', 'content-type': 'application/json' } });
    let status, result;
    await routes.get('/preset-enhance/api').handler(req, { writeHead: s => { status = s; }, end: s => { result = JSON.parse(s); } });
    assert.equal(status, 200, result.error); return result;
  };
  try {
    await apply(ctx, { dataFile: store.file, agentPresetRoot: join(dir, 'modes') });
    const service = services.get('presetTemplates');
    service.register({ effect: fn => disposers.push(fn()) }, { providerId: 'dynamic', title: 'Dynamic', templates: [{
      id: 'read', version: '1', title: '动态', role: 'system', content: '{{incglobalvar::count}} {{dynamic::body}} {{random::A::B::C}}', dynamic: { resolverId: 'read', input: 'history' },
      ...(historyMode ? { content: '', targetMarker: 'chatHistory', dynamic: { resolverId: 'read', input: 'history', output: 'history-patches' } } : {}),
    }] }, { resolvers: { read: run } });
    const template = service.list().providers[0].templates[0];
    const { templateFingerprint } = await import('../lib/template-bindings.mjs');
    const { preset } = await post({ action: 'template-select', preset: { prompts: [{ identifier: 'chatHistory', marker: true }], dsh_system_prompt_enabled: true }, selection: {
      operation: historyMode ? 'bind-marker' : 'add', ...(historyMode ? { identifier: 'chatHistory' } : {}), providerId: 'dynamic', templateId: 'read', templateVersion: '1', expectedFingerprint: templateFingerprint(template),
    } });
    await store.transaction(state => {
      state.presets.push({ id: 'p', name: 'Test', preset });
      for (const id of ['a', 'b']) state.bindings[id] = { enabled: true, presetId: 'p', values: {}, markers: {} };
    });
    return { store, histories, preset, post, sent, tools, ctx, routes,
      async send(sessionId, retries = 1) { for await (const _ of ctx.llm.stream({ sessionId, provider: 'preset-deepseek-chat', model: 'deepseek-chat', reasoningEffort: 'off', messages: histories[sessionId], tools, retries })) {} },
      async close() { await Promise.all(disposers.reverse().map(dispose => dispose())); await store.close(); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); },
    };
  } catch (error) { await Promise.all(disposers.reverse().map(f => f())); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); throw error; }
}

test('draft preview matches the outgoing Chat body, is read-only, and Raw needs no resolver replay', async () => {
  let calls = 0;
  const f = await setup(ctx => { calls++; return ctx.userText; });
  try {
    const before = await f.store.read();
    const draft = await f.post({ action: 'preview', sessionId: 'a', preset: f.preset, options: { characterId: 100001, values: { user: 'User', char: 'Assistant' }, markers: {} } });
    assert.equal((await f.store.read()).global.count, undefined);
    assert.equal((await f.store.read()).revision, before.revision);
    assert.equal(draft.source, 'draft-wire');
    await f.send('a');
    assert.equal(draft.raw, f.sent[0].raw);
    const actual = (await f.post({ action: 'request-snapshot', sessionId: 'a' })).snapshot;
    assert.equal(actual.raw, f.sent[0].raw); assert.equal(actual.source, 'wire');
    await f.post({ action: 'prefill-inspect', preset: f.preset });
    await f.post({ action: 'request-snapshot', sessionId: 'a', snapshotId: actual.id });
    assert.equal(calls, 2); assert.equal((await f.store.read()).global.count, '1');
  } finally { await f.close(); }
});

test('tool continuations resolve current history, transport retries resolve once, later user messages replace the body', async () => {
  const inputs = [];
  const f = await setup(ctx => { inputs.push(ctx); return ctx.userText + ' / ' + ctx.history.length; });
  try {
    await f.send('a', 2);
    assert.equal(inputs.length, 1); assert.equal(f.sent[0].raw, f.sent[1].raw);
    f.histories.a.push({ id: 'call', role: 'assistant', content: [{ type: 'tool-call', id: 't', name: 'echo', arguments: '{}' }] },
      { id: 'result', role: 'tool', toolCallId: 't', source: { kind: 'tool' }, content: [{ type: 'text', text: 'echo-result' }] });
    await f.send('a');
    assert.equal(inputs.length, 2); assert.equal(inputs[1].userText, 'hello'); assert.equal(inputs[1].history.length, 3);
    assert.match(f.sent.at(-1).raw, /hello \/ 3/);
    f.histories.a.push(user('u3', 'changed')); await f.send('a');
    assert.equal(inputs.at(-1).userText, 'changed'); assert.match(f.sent.at(-1).raw, /changed \/ 4/);
    const snapshot = (await f.post({ action: 'request-snapshot', sessionId: 'a' })).snapshot;
    assert.equal(snapshot.choices.length, 4);
    assert.equal(snapshot.raw, f.sent.at(-1).raw);
  } finally { await f.close(); }
});

test('slow parsing leaves the save queue available and conflicting changes abort without variable writes', async () => {
  let entered, finish;
  const began = new Promise(r => { entered = r; });
  const gate = new Promise(r => { finish = r; });
  const f = await setup(async () => { entered(); await gate; return 'late'; });
  try {
    const work = f.send('a');
    await began;
    await f.store.transaction(state => { state.presets[0].preset.assistant_prefill = 'edited'; });
    finish(); await assert.rejects(work, /已变化/);
    assert.equal(f.sent.length, 0); assert.equal((await f.store.read()).global.count, undefined);
    const latest = (await f.post({ action: 'request-snapshot', sessionId: 'a' })).snapshot;
    assert.equal(latest.status, 'failed'); assert.equal(latest.raw, undefined); assert.match(latest.unavailable, /未发送/);
  } finally { finish(); await f.close(); }
});

test('history patches are reflected identically in draft and actual Raw; continuations use fresh depth', async () => {
  let calls = 0;
  const f = await setup(ctx => { calls++; return { patches: [
    { operation: 'append-text', depth: ctx.history.length - 1, text: ' annotated' },
    { operation: 'insert', depth: 1, role: 'system', text: 'context: ' + ctx.history.length },
  ] }; }, true);
  try {
    for (const continuation of [false, true]) {
      if (continuation) f.histories.a.push(
        { id: 'call', role: 'assistant', content: [{ type: 'tool-call', id: 't', name: 'echo', arguments: '{}' }] },
        { id: 'result', role: 'tool', toolCallId: 't', content: [{ type: 'text', text: 'result' }] });
      const original = structuredClone(f.histories.a);
      const draft = await f.post({ action: 'preview', sessionId: 'a', preset: f.preset, options: {} });
      await f.send('a');
      assert.equal(draft.raw, f.sent.at(-1).raw);
      const actual = (await f.post({ action: 'request-snapshot', sessionId: 'a' })).snapshot;
      assert.equal(actual.raw, draft.raw);
      assert.match(actual.raw, /hello annotated/);
      assert.deepEqual(f.histories.a, original);
    }
    assert.equal(calls, 4);
  } finally { await f.close(); }
});


test('read API mounts on the actual DSH prefix boundary and rejects unauthenticated child paths', async () => {
  const f = await setup(() => 'body');
  try {
    const pathname = '/preset-enhance/api/v1/current';
    const route = [...f.routes.values()].find(route => route.kind === 'prefix' &&
      (pathname === route.path || pathname.startsWith(route.path + '/')));
    assert.ok(route, 'DSH prefix matching must reach the read API');
    let status, result;
    await route.handler({ method: 'GET', url: pathname, headers: {} }, {
      writeHead: value => { status = value; }, end: value => { result = JSON.parse(value); },
    });
    assert.equal(status, 401); assert.equal(result.error.code, 'access_required');
  } finally { await f.close(); }
});
