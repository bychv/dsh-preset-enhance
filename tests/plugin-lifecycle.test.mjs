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
