import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestSnapshots, traceRequest } from '../lib/request-preview.mjs';
import { installDeepSeekBetaBridge } from '../lib/deepseek-beta.mjs';

test('Raw captures bytes after Beta/DSML transformation and before failed response', async () => {
  const original = globalThis.fetch;
  const store = new RequestSnapshots(), sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, body: init.body }); return new Response('failure', { status: 400 }); };
  const bridge = installDeepSeekBetaBridge({ effect() {} });
  const release = bridge.activate('s', '<think>', { mode: 'chat-completions', toolCalls: true });
  try {
    const body = { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '<think>' }], tools: [{ type: 'function', function: { name: 'search', description: 'search', parameters: { type: 'object' } } }] };
    const events = [];
    const unsubscribe = store.subscribe('s', id => events.push(id), () => {});
    const source = async function* () {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'x-deepseek-harness-session-id': 's' }, body: JSON.stringify(body) });
      assert.equal(store.read('s').status, 'HTTP 400');
      assert.equal(response.status, 400); yield 'finish';
    };
    for await (const _ of traceRequest(store, 's', { messages: [] }, source())) {}
    const snapshot = store.read('s');
    assert.equal(snapshot.raw, sent[0].body); assert.equal(snapshot.source, 'wire');
    assert.equal(JSON.parse(snapshot.raw).messages.at(-1).prefix, true);
    assert.equal(JSON.parse(snapshot.raw).tools, undefined);
    assert.match(snapshot.raw, /search/); assert.ok(events.length >= 2);
    unsubscribe();
  } finally { release(); bridge.dispose(); store.close(); globalThis.fetch = original; }
});

test('concurrent sessions, retry attempts and Messages wire stay isolated', async () => {
  const original = globalThis.fetch;
  const store = new RequestSnapshots();
  globalThis.fetch = async () => { await new Promise(r => setTimeout(r, 3)); return new Response('{}'); };
  const bridge = installDeepSeekBetaBridge({ effect() {} });
  try {
    const send = async sessionId => {
      const source = async function* () {
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = '{"model":"ds","system":"' + sessionId + '","messages":[{"role":"user","content":[{"type":"text","text":"same"}]}],"max_tokens":1e3}';
          await fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', headers: { 'x-deepseek-harness-session-id': sessionId }, body: raw });
          yield attempt;
        }
      };
      for await (const _ of traceRequest(store, sessionId, { messages: [] }, source())) {}
    };
    await Promise.all(['a', 'b'].map(send));
    for (const id of ['a', 'b']) {
      const row = store.read(id);
      assert.equal(row.protocol, 'messages'); assert.equal(row.attempt, 2); assert.equal(row.choices.length, 2);
      assert.equal(JSON.parse(row.raw).system, id); assert.match(row.raw, /1e3/);
      assert.equal(store.read(id, store.read(id === 'a' ? 'b' : 'a').id), null);
    }
  } finally { bridge.dispose(); store.close(); globalThis.fetch = original; }
});

test('snapshot caps expire old bodies without pretending a summary is the full request', async () => {
  const store = new RequestSnapshots(1000, 2);
  try {
    for (let i = 0; i < 3; i++) { for await (const _ of traceRequest(store, 's', { messages: [{ role: 'user', content: [{ type: 'text', text: String(i) }] }] }, (async function* () {})())) {} }
    assert.equal(store.read('s').choices.length, 2);
    for await (const _ of traceRequest(store, 'large', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2000) }] }] }, (async function* () {})())) {}
    assert.equal(store.read('large').raw, undefined); assert.match(store.read('large').unavailable, /上限/);
    assert.equal(store.read('large').source, 'adapter-input');
  } finally { store.close(); }
});
