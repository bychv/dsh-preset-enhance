import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';
import { PresetStore } from '../lib/store.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('concurrent host disposal waits for an active stream and preserves its beta bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-stream-teardown-'));
  const originalFetch = globalThis.fetch;
  const started = deferred();
  const finish = deferred();
  const disposers = [];
  let intercept;
  let rewritten;
  const file = join(dir, 'state.json');
  globalThis.fetch = async (url, init) => {
    rewritten = { url, body: JSON.parse(init.body) };
    return new Response('{}');
  };
  try {
    await new PresetStore(file).transaction(state => {
      state.deepseekBetaPrefix = true;
      state.presets.push({ id: 'p', name: 'test', preset: {
        prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'prefix', role: 'assistant', content: 'Continue:' }],
      } });
      state.bindings.s = { enabled: true, presetId: 'p', values: {}, markers: {} };
    });
    const ctx = {
      effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
      on(_event, handler) { intercept = handler; },
      sessions: { get() { return { id: 's', header: { agentPreset: 'standard', createdAt: 0 } }; } },
      webServer: { register() { return () => {}; } },
      llm: { async *stream(options) {
        started.resolve();
        await finish.promise;
        await fetch('https://api.deepseek.com/chat/completions', {
          headers: { 'x-deepseek-harness-session-id': 's' },
          body: JSON.stringify({ messages: options.messages.map(m => ({ role: m.role, content: m.content.map(b => b.text).join('') })) }),
        });
        yield 'done';
      } },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    const consume = async () => {
      const values = [];
      for await (const value of intercept({ sessionId: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, async function* () {})) values.push(value);
      return values;
    };
    const request = consume();
    await started.promise;
    let disposed = false;
    // Cordis awaits disposers concurrently, not in registration order.
    const teardown = Promise.all(disposers.map(dispose => dispose())).then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    await assert.rejects(consume(), /正在停用/);
    finish.resolve();
    assert.deepEqual(await request, ['done']);
    await teardown;
    assert.equal(rewritten.url, 'https://api.deepseek.com/beta/chat/completions');
    assert.equal(rewritten.body.messages.at(-1).prefix, true);
  } finally {
    finish.resolve();
    await Promise.all(disposers.map(dispose => dispose()));
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('activation registers the chat provider and the preset mode once and releases both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-registration-'));
  const file = join(dir, 'state.json');
  const adapterRegistrations = [];
  const modeRegistrations = [];
  const modeDisposals = [];
  const disposers = [];
  let adapterDisposals = 0;
  // The host's own declaration of the standard preset: the plugin copies this list.
  const standardEntry = {
    id: 'preset-standard',
    options: {
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'standard',
        plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'from-host' } }],
      },
    },
  };
  const makeCtx = () => ({
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    on() {},
    get() { return undefined; },
    loader: { entries: () => [standardEntry] },
    llm: {
      async *stream() {},
      registerAdapter(providers, adapter) {
        adapterRegistrations.push({ providers, adapter });
        return () => { adapterDisposals += 1; };
      },
    },
    agentPresets: {
      async register(definition) {
        modeRegistrations.push(definition);
        return async () => { modeDisposals.push(definition.id); };
      },
    },
    sessions: { get() { return undefined; } },
    webServer: { register() { return () => {}; } },
  });
  try {
    await apply(makeCtx(), { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    assert.equal(adapterRegistrations.length, 1, 'the chat provider is registered exactly once');
    assert.deepEqual(adapterRegistrations[0].providers, ['preset-deepseek-chat']);
    assert.equal(modeRegistrations.length, 1, 'the preset mode is registered exactly once');
    assert.equal(modeRegistrations[0].id, 'st-preset');
    // The registered mode must carry the host's full row list, with the persona overridden.
    const rows = modeRegistrations[0].plugins;
    assert.ok(Array.isArray(rows) && rows.length >= 2, 'the mode carries the standard rows plus our own');
    assert.deepEqual(rows.find(row => row.id === 'persona')?.config,
      { prefix: '', complete: true, includeRuntimeContext: false });
    assert.ok(rows.some(row => row.id === 'preset-enhance-mode' && row.name === 'dsh-preset-enhance/mode'));

    for (const dispose of disposers.splice(0).reverse()) await dispose();
    assert.equal(adapterDisposals, 1, 'the provider registration is released');
    assert.deepEqual(modeDisposals, ['st-preset'], 'the mode registration is released');

    // A second activation must not accumulate: one provider and one mode again.
    await apply(makeCtx(), { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    assert.equal(adapterRegistrations.length, 2);
    assert.equal(modeRegistrations.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an image turn resolves through the host attachment service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-image-'));
  const file = join(dir, 'state.json');
  const originalFetch = globalThis.fetch;
  const disposers = [];
  const readCalls = [];
  let adapter;
  let sent;
  const attachments = {
    async readImageRequest(ref, target) {
      readCalls.push({ ref, target });
      return { mediaType: 'image/png', data: Uint8Array.from([1, 2, 3]), bytes: 3, width: 100, height: 80 };
    },
    imageHostPath() { return 'C:/tmp/shot.png'; },
  };
  const { chatCompletionEvents, encodeChatSse } = await import('./fixtures/protocol-server.mjs');
  // No credentials service in this stub, so the launching-environment fallback supplies the key.
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const ctx = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    on() {},
    get(name) {
      if (name === 'attachments') return attachments;
      if (name === 'fs') return { processPathFromHostPath: () => '/world/shot.png' };
      return undefined;
    },
    loader: { entries: () => [] },
    llm: {
      async *stream() {},
      registerAdapter(_providers, registered) { adapter = registered; return () => {}; },
    },
    agentPresets: { async register() { return async () => {}; } },
    sessions: { get() { return undefined; } },
    webServer: { register() { return () => {}; } },
  };
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(encodeChatSse(chatCompletionEvents({ content: 'ok' })), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    assert.ok(adapter, 'the chat adapter was registered');
    const messages = [{ role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    ] }];
    for await (const _chunk of adapter.stream({
      provider: 'preset-deepseek-chat', model: 'deepseek-flash', messages, sessionId: 's',
    })) { /* drain */ }
    assert.equal(readCalls.length, 1, 'the host attachment service was asked exactly once');
    assert.equal(readCalls[0].ref.attachmentId, 'a1');
    assert.ok(readCalls[0].target && typeof readCalls[0].target === 'object', 'the read carried a size target');
    const parts = sent.body.messages.at(-1).content;
    const image = Array.isArray(parts) ? parts.find(part => part.type === 'image_url') : undefined;
    assert.ok(image, 'the outbound body carries an image part');
    assert.match(String(image.image_url?.url ?? ''), /^data:image\/png;base64,/);
    assert.equal(String(image.image_url.url).includes(Buffer.from([1, 2, 3]).toString('base64')), true);
    assert.match(JSON.stringify(sent.body), /\/world\/shot\.png/, 'the handle text carries the resolved read-only path');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a declarative host is never asked for the legacy preset document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-rc1-'));
  const file = join(dir, 'state.json');
  const disposers = [];
  const registrations = [];
  let legacyReads = 0;
  const standardEntry = {
    id: 'preset-standard',
    options: {
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'standard', plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'from-host' } }] },
    },
  };
  const ctx = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    on() {},
    get() { return undefined; },
    loader: { entries: () => [standardEntry] },
    llm: { async *stream() {}, registerAdapter() { return () => {}; } },
    // The 0.1.7-rc.1 shape: register and acquireScope exist, and readDocument is back with a
    // contract that rejects an unknown preset.
    agentPresets: {
      async register(definition) { registrations.push(definition); return async () => {}; },
      async acquireScope() { return { key: 'k', async [Symbol.asyncDispose]() {} }; },
      async readDocument() { legacyReads += 1; throw new Error('Unknown agent preset: standard'); },
    },
    sessions: { get() { return undefined; } },
    webServer: { register() { return () => {}; } },
  };
  try {
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    assert.equal(legacyReads, 0, 'the 0.1.6 document is never requested on a declarative host');
    // Registering proves activation got past the staging step, i.e. no startup failure was recorded.
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, 'st-preset');
  } finally {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
