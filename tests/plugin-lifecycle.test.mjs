import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
    rewritten = { url, body: JSON.parse(init.body), userAgent: new Headers(init.headers).get('user-agent') };
    return new Response('{}');
  };
  try {
    await new PresetStore(file).transaction(state => {
      state.deepseekBetaPrefix = true;
      state.deepseekSafetyCheck = true; // A saved on/off setting from before the three-level selector.
      state.presets.push({ id: 'p', name: 'test', preset: {
        prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'prefix', role: 'assistant', content: 'Continue:' }],
      } });
      state.bindings.s = { enabled: true, presetId: 'p', values: {}, markers: {} };
    });
    const ctx = {
      effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
      on(event, handler) { if (event === 'llm/stream') intercept = handler; },
      sessions: { get() { return { id: 's', header: { agentPreset: 'standard', createdAt: 0 } }; } },
      webServer: { register() { return () => {}; } },
      llm: { async *stream(options) {
        started.resolve();
        await finish.promise;
        await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'x-deepseek-harness-session-id': 's' },
          body: JSON.stringify({ messages: options.messages.map(m => ({ role: m.role, content: m.content.map(b => b.text).join('') })) }),
        });
        yield 'done';
      } },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes'), requestUserAgent: 'Preset-Test/1.0' });
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
    assert.deepEqual(rewritten.body.safety_check, { level: 'high' });
    assert.equal(rewritten.userAgent, 'Preset-Test/1.0');
  } finally {
    finish.resolve();
    await Promise.all(disposers.map(dispose => dispose()));
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('live model request settings apply with presets disabled and safety review stays on official inference endpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-user-agent-'));
  const originalFetch = globalThis.fetch;
  const disposers = [];
  const sent = [];
  const file = join(dir, 'state.json');
  let userAgent = 'Local Client/1.0';
  let api;
  let intercept;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    sent.push({ url: input instanceof Request ? input.url : String(input), headers, body: raw ? JSON.parse(raw) : undefined });
    return new Response('{}');
  };
  const ctx = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    on(event, handler) { if (event === 'llm/stream') intercept = handler; },
    sessions: { get: () => ({ id: 's', header: { agentPreset: 'standard' } }) },
    webServer: { register(definition) {
      if (definition.path === '/preset-enhance/api') api = definition.handler;
      return () => {};
    } },
    llm: { async *stream() {} },
  };
  const input = new Request('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST', headers: { 'User-Agent': 'official/1', 'x-api-key': 'fixture' }, body: '{}',
  });
  const relayUrl = 'https://example.invalid/v1/responses';
  const relayHeaders = { 'USER-AGENT': 'relay/1', authorization: 'Bearer fixture' };
  const run = (options, transport) => Array.fromAsync(intercept(options, async function* () { await transport(); }));
  const setSafety = async level => {
    const before = await new PresetStore(file).read();
    const req = Readable.from([JSON.stringify({ revision: before.revision, action: 'set-deepseek-safety-check', level })]);
    Object.assign(req, { method: 'POST', url: '/preset-enhance/api', headers: { host: 'localhost', 'content-type': 'application/json' } });
    let status, result;
    await api(req, { writeHead: value => { status = value; }, end: value => { result = JSON.parse(value); } });
    assert.equal(status, 200, result?.error);
    assert.equal(result.level, level);
    assert.equal((await new PresetStore(file).read()).deepseekSafetyCheck, level);
  };
  try {
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes'), requestUserAgent: { get: () => userAgent } });
    assert.equal((await new PresetStore(file).read()).deepseekSafetyCheck, 'omit');
    await setSafety('high');
    await run({ provider: 'deepseek-official', sessionId: 's', messages: [] }, () => fetch(input, {
      headers: { 'x-api-key': 'fixture', 'content-length': '42' }, body: '{"messages":[],"tool_choice":"auto"}',
    }));
    assert.equal(sent[0].headers.get('user-agent'), 'Local Client/1.0');
    assert.equal(sent[0].headers.get('x-api-key'), 'fixture');
    assert.equal(input.headers.get('user-agent'), 'official/1');
    assert.equal(sent[0].headers.get('content-length'), null);
    assert.deepEqual(sent[0].body, { messages: [], tool_choice: 'auto', safety_check: { level: 'high' } });

    userAgent = 'Local Client/2.0';
    const relayOptions = { method: 'POST', headers: relayHeaders, body: '{"input":"fixture"}' };
    await run({ provider: 'custom', purpose: 'title' }, () => fetch(relayUrl, relayOptions));
    assert.equal(sent[1].headers.get('user-agent'), 'Local Client/2.0');
    assert.equal(sent[1].headers.get('authorization'), 'Bearer fixture');
    assert.equal(relayHeaders['USER-AGENT'], 'relay/1');
    assert.deepEqual(sent[1].body, { input: 'fixture' });

    await fetch(relayUrl, { headers: relayHeaders });
    assert.equal(sent[2].headers.get('user-agent'), 'relay/1', 'out-of-stream requests keep their own headers');
    userAgent = '';
    await run({ provider: 'custom' }, () => fetch(relayUrl, { headers: relayHeaders }));
    assert.equal(sent[3].headers.get('user-agent'), 'relay/1');
    await run({}, () => fetch('https://api.deepseek.com/responses', relayOptions));
    assert.deepEqual(sent[4].body, { input: 'fixture', safety_check: { level: 'high' } });
    await run({}, () => fetch('https://api.deepseek.com/v1/files', relayOptions));
    assert.deepEqual(sent[5].body, { input: 'fixture' });
    await fetch('https://api.deepseek.com/responses', relayOptions);
    assert.deepEqual(sent[6].body, { input: 'fixture' }, 'non-model requests remain outside the setting scope');
    const explicitHigh = { ...relayOptions, body: '{"input":"fixture","safety_check":{"level":"high"}}' };
    await setSafety('low');
    await run({}, () => fetch('https://api.deepseek.com/responses', explicitHigh));
    assert.deepEqual(sent[7].body, { input: 'fixture', safety_check: { level: 'low' } });
    await setSafety('omit');
    await run({}, () => fetch('https://api.deepseek.com/responses', explicitHigh));
    assert.deepEqual(sent[8].body, { input: 'fixture' });
    await run({}, () => fetch(relayUrl, explicitHigh));
    assert.deepEqual(sent[9].body, { input: 'fixture', safety_check: { level: 'high' } });

    userAgent = 'invalid\r\nInjected: value';
    await assert.rejects(run({}, () => fetch(relayUrl)), /User-Agent/);
    assert.equal(sent.length, 10);
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripHarnessHeaders removes built-in x-deepseek-harness headers while plugin chat adapter works without them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-strip-harness-'));
  const originalFetch = globalThis.fetch;
  const disposers = [];
  const sent = [];
  const file = join(dir, 'state.json');
  let api;
  let intercept;
  let chatAdapter;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body: raw ? JSON.parse(raw) : undefined,
    });
    return new Response(
      'data: {"id":"r","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  await new PresetStore(file).transaction(state => {
    state.selectedPresetId = 'p1';
    state.autoEnableModes.push('standard');
    state.deepseekBetaPrefix = true;
    state.presets = [{
      id: 'p1',
      name: 'Prefill',
      preset: {
        assistant_prefill: '继续写',
        prompts: [
          { identifier: 'sys', role: 'system', content: '系统设定' },
          { identifier: 'chatHistory', role: 'user', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'sys', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
      },
    }];
  });
  const ctx = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    on(event, handler) { if (event === 'llm/stream') intercept = handler; },
    sessions: {
      get: id => id === 's1'
        ? { id: 's1', header: { agentPreset: 'standard' } }
        : id === 's-builtin'
          ? { id: 's-builtin', header: { agentPreset: 'minimal' } }
          : undefined,
    },
    webServer: { register(definition) {
      if (definition.path === '/preset-enhance/api') api = definition.handler;
      return () => {};
    } },
    llm: {
      registerAdapter(_ids, adapter) { chatAdapter = adapter; return () => {}; },
      async *stream(options) { yield* chatAdapter.stream(options); },
    },
  };
  const callApi = async (body, expected = 200) => {
    const req = Readable.from([JSON.stringify({ revision: (await new PresetStore(file).read()).revision, ...body })]);
    Object.assign(req, { method: 'POST', url: '/preset-enhance/api', headers: { host: 'localhost', 'content-type': 'application/json' } });
    let status, result;
    await api(req, { writeHead: value => { status = value; }, end: value => { result = JSON.parse(value); } });
    assert.equal(status, expected, result?.error);
    return result;
  };
  const runBuiltIn = (options, transport) => Array.fromAsync(intercept(options, async function* () { await transport(); }));
  try {
    process.env.DEEPSEEK_API_KEY = 'fixture-key';
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    assert.equal((await new PresetStore(file).read()).stripHarnessHeaders, false);

    // Reject invalid non-boolean payload.
    await callApi({ action: 'set-strip-harness-headers', enabled: 'yes' }, 400);

    // Default (false): built-in adapter keeps x-deepseek-harness-* headers.
    const officialReq = new Request('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'fixture',
        'user-agent': 'dsh/test',
        'x-deepseek-harness-user-id': 'u-1',
        'x-deepseek-harness-session-id': 's1',
        'x-deepseek-harness-compact': '1',
      },
      body: '{}',
    });
    await runBuiltIn({ provider: 'deepseek-official', purpose: 'compaction', messages: [] }, () => fetch(officialReq));
    assert.equal(sent[0].headers.get('x-deepseek-harness-user-id'), 'u-1');
    assert.equal(sent[0].headers.get('x-deepseek-harness-session-id'), 's1');
    assert.equal(sent[0].headers.get('x-deepseek-harness-compact'), '1');

    // Enable stripping: built-in Requests and init objects strip all x-deepseek-harness-* without mutating inputs.
    const toggled = await callApi({ action: 'set-strip-harness-headers', enabled: true });
    assert.equal(toggled.enabled, true);
    assert.equal((await new PresetStore(file).read()).stripHarnessHeaders, true);

    await runBuiltIn({ provider: 'deepseek-official', purpose: 'compaction', messages: [] }, () => fetch(officialReq));
    assert.equal(sent[1].headers.get('x-deepseek-harness-user-id'), null);
    assert.equal(sent[1].headers.get('x-deepseek-harness-session-id'), null);
    assert.equal(sent[1].headers.get('x-deepseek-harness-compact'), null);
    assert.equal(sent[1].headers.get('x-api-key'), 'fixture');
    assert.equal(sent[1].headers.get('user-agent'), 'dsh/test');
    assert.equal(officialReq.headers.get('x-deepseek-harness-user-id'), 'u-1', 'original Request must stay intact');

    const initHeaders = { 'X-DeepSeek-Harness-Session-Id': 's-init', 'X-DeepSeek-Harness-User-Id': 'u-init', authorization: 'Bearer k' };
    await runBuiltIn({ provider: 'deepseek-official', sessionId: 's-builtin', messages: [] }, () =>
      fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', headers: initHeaders, body: '{}' }));
    assert.equal(sent[2].headers.get('x-deepseek-harness-session-id'), null);
    assert.equal(sent[2].headers.get('x-deepseek-harness-user-id'), null);
    assert.equal(sent[2].headers.get('authorization'), 'Bearer k');
    assert.equal(initHeaders['X-DeepSeek-Harness-Session-Id'], 's-init', 'caller headers object must stay intact');

    // Out-of-stream requests are untouched.
    await fetch('https://api.deepseek.com/responses', { method: 'POST', headers: { 'x-deepseek-harness-user-id': 'outside' }, body: '{}' });
    assert.equal(sent[3].headers.get('x-deepseek-harness-user-id'), 'outside');

    // Plugin chat adapter emits no x-deepseek-harness-* headers yet still triggers prefill beta rewrite via session scope.
    await Array.fromAsync(intercept({
      provider: 'preset-deepseek-chat',
      model: 'deepseek-flash',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }, () => ctx.llm.stream({
      provider: 'preset-deepseek-chat',
      model: 'deepseek-flash',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })));
    assert.equal(sent[4].url, 'https://api.deepseek.com/beta/chat/completions');
    assert.equal(sent[4].body.messages.at(-1).prefix, true);
    for (const key of sent[4].headers.keys()) {
      assert.equal(key.startsWith('x-deepseek-harness'), false, 'plugin chat adapter must not send ' + key);
    }
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
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
