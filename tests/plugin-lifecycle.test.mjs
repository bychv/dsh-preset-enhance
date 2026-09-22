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
