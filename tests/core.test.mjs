import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { PresetStore } from '../lib/store.mjs';
import { installDeepSeekBetaBridge, normalizeRelayUrl, rewriteDeepSeekPrefixFetch } from '../lib/deepseek-beta.mjs';
import { AGENT_PRESET_ID, apply, buildPresetModeComposition, discoverModeToolCatalogs, ensurePresetAgentMode } from '../index.mjs';

const FETCH_BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');
/** Earlier tests may leave the shared fetch wrapper installed; restore the real fetch. */
function resetFetchBridge() {
  const host = globalThis[FETCH_BRIDGE];
  if (!host) return;
  globalThis.fetch = host.original;
  delete globalThis[FETCH_BRIDGE];
}

test('variables resolve in textual order, nested values preserve delimiters, comments are inert', () => {
  const ctx = createMacroContext({ values: { user: 'A::B' } });
  assert.equal(renderMacros('{{setvar::x::{{user}}}}{{getvar::x}}/{{setvar::y:value}}{{getvar::y}}', ctx), 'A::B/value');
  assert.equal(renderMacros('{{// {{setvar::x::wrong}} }}{{getvar::x}}\n{{trim}}\nend', ctx), 'A::Bend');
  assert.equal(renderMacros('{{setvar::n::2}}{{incvar::n}}{{addvar::n::3}}{{getvar::n}}{{decvar::n}}', ctx), '365');
  assert.equal(renderMacros('{{setglobalvar::a::global}}{{getglobalvar::a}}', ctx), 'global');
});
test('unknown and escaped macros never execute hidden nested side effects', () => {
  const ctx = createMacroContext();
  assert.equal(renderMacros('\\{\\{getvar::x\\}\\}', ctx), '{{getvar::x}}');
  assert.equal(renderMacros('{{unsupported::{{setvar::x::bad}}}}{{getvar::x}}', ctx), '{{unsupported::{{setvar::x::bad}}}}');
  assert.equal(ctx.local.x, undefined); assert.ok(ctx.warnings.length);
  renderMacros('{{setvar::__proto__::safe}}', ctx); assert.equal(ctx.local.__proto__, 'safe');
  assert.equal({}.safe, undefined);
});
const msg = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' } });
test('selected order controls activation and places assistant after original history', () => {
  const history = [msg('u', 'user', '{{setvar::unsafe::no}}')];
  const preset = { prompts: [
    { identifier: 'a', role: 'system', content: '{{setvar::x::value}}system', enabled: false },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'b', role: 'assistant', content: '{{getvar::x}}' },
    { identifier: 'c', content: 'disabled' },
  ], prompt_order: [{ character_id: 100001, order: [
    { identifier: 'a', enabled: true }, { identifier: 'chatHistory', enabled: true },
    { identifier: 'b', enabled: true }, { identifier: 'c', enabled: false },
  ] }] };
  const result = compilePreset(preset, history);
  assert.deepEqual(result.messages.map(x => x.role), ['system', 'user', 'assistant']);
  assert.equal(result.messages[1], history[0]); assert.equal(result.local.unsafe, undefined);
  assert.equal(result.messages[2].content[0].text, 'value');
});
test('depth insertion respects original positions and tool-call/result boundaries', () => {
  const history = [msg('u', 'user', 'hi'), { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 't', name: 'test', arguments: '{}' }] },
    { id: 't', role: 'user', source: { kind: 'tool', callId: 't' }, content: [{ type: 'tool-result', callId: 't', content: [] }] }];
  const result = compilePreset({ prompts: [{ identifier: 'd', role: 'system', injection_position: 1, injection_depth: 1, content: 'depth' }] }, history);
  assert.deepEqual(result.messages.map(x => x.id), ['u', 'preset:preview:d', 'a', 't']);
  assert.ok(result.warnings[0].includes('配对'));
});
test('multiple order groups compile deterministically without changing extension data', () => {
  const preset = {
    prompts: [
      { identifier: 'chatHistory', marker: true, role: 'user' },
      { identifier: 'set', role: 'system', content: '{{setvar::tone::calm}}' },
      { identifier: 'use', role: 'system', content: '{{getvar::tone}}' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'use', enabled: true }] },
      { character_id: 100001, order: [{ identifier: 'set', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'use', enabled: true }] },
    ],
    extensions: { untouched: { enabled: true } },
  };
  const original = JSON.stringify(preset);
  for (const characterId of [100000, 100001]) {
    const result = compilePreset(preset, [msg('u', 'user', '测试消息')], { characterId });
    assert.equal(result.messages.some(message => /\{\{/.test(message.content[0]?.text)), false);
    assert.deepEqual(result, compilePreset(preset, [msg('u', 'user', '测试消息')], { characterId }));
  }
  assert.equal(JSON.stringify(preset), original);
});
test('store serializes competing writes and survives reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-test-'));
  try {
    const store = new PresetStore(join(dir, 'state.json'));
    await Promise.all(Array.from({ length: 10 }, () => store.transaction(s => { s.revision++; })));
    assert.equal((await new PresetStore(store.file).read()).revision, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('agent preset mode refreshes managed files while keeping unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-mode-'));
  try {
    const destination = await ensurePresetAgentMode(dir);
    assert.match(await readFile(join(destination, 'preset.yml'), 'utf8'), /name: 预设模式/);
    await import('node:fs/promises').then(async fs => {
      await fs.writeFile(join(destination, 'custom.txt'), 'keep');
      await fs.writeFile(join(destination, 'agent.cordis.yml'), 'stale');
    });
    assert.equal(await ensurePresetAgentMode(dir), destination);
    assert.equal(await readFile(join(destination, 'custom.txt'), 'utf8'), 'keep');
    assert.match(await readFile(join(destination, 'agent.cordis.yml'), 'utf8'), /includeRuntimeContext: false/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('routing: frozen input preserved, once-only injection, retries stable, isolation and durable audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-route-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(s => {
      s.presets.push({ id: 'p', preset: { prompts: [{ identifier: 'a', role: 'assistant', content: '{{incvar::count}}/{{roll 1d999999}}' }] } });
      s.bindings.s = { enabled: true, presetId: 'p' };
    });
    const ctx = { sessions: { get: id => id === 's' ? {} : undefined }, on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(), webServer: { register: () => () => {} },
      llm: { stream: options => listeners['llm/stream'](options, async function* () { calls.push(options); yield { type: 'finish', reason: { kind: 'completed' } }; }) } };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const request = Object.freeze({ sessionId: 's', provider: 'mock', model: 'mock', messages: Object.freeze([Object.freeze(msg('u', 'user', 'hello'))]) });
    for await (const _ of ctx.llm.stream(request)) {}
    for await (const _ of ctx.llm.stream(request)) {}
    assert.equal(calls.length, 2); assert.equal(calls[0].messages.length, 2); assert.equal(request.messages.length, 1);
    assert.deepEqual(calls[0].messages, calls[1].messages);
    assert.equal((await store.read()).sessions.s.result.local.count, '1');
    for await (const _ of ctx.llm.stream({ ...request, sessionId: 'other' })) {}
    assert.equal(calls.at(-1).messages, request.messages);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('new conversations inject and pin the globally selected preset after reopening the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-auto-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(s => {
      s.presets.push(
        { id: 'default', name: 'Old default', preset: { prompts: [{ identifier: 'a', role: 'system', content: 'OLD' }] } },
        { id: 'selected', name: 'Last selected', preset: { prompts: [{ identifier: 'b', role: 'system', content: 'SELECTED' }] } },
      );
      s.defaultPresetId = 'default';
      s.selectedPresetId = 'selected';
    });
    const modeSession = { header: { agentPreset: AGENT_PRESET_ID }, snapshotEvents: () => [] };
    const normalSession = { header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
    const ctx = { sessions: { get: id => id === 'auto' ? modeSession : id === 'normal' ? normalSession : undefined },
      on: (name, fn) => listeners[name] = fn, effect: fn => fn(), webServer: { register: () => () => {} },
      llm: { stream: options => listeners['llm/stream'](options, async function* () { calls.push(options); yield { type: 'finish', reason: { kind: 'completed' } }; }) } };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const dshSystem = { id: 'dsh-system', role: 'system', content: [{ type: 'text', text: 'You are DSH' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } };
    const dshRuntime = { id: 'dsh-runtime', role: 'user', content: [{ type: 'text', text: 'Current runtime context' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } };
    const request = id => ({ sessionId: id, provider: 'mock', model: 'mock', tools: [{ name: 'shell' }],
      messages: [dshSystem, msg('u', 'user', 'hello'), dshRuntime] });
    for await (const _ of ctx.llm.stream(request('auto'))) {}
    for await (const _ of ctx.llm.stream(request('normal'))) {}
    assert.equal(calls[0].messages[0].content[0].text, 'SELECTED');
    assert.deepEqual(calls[0].messages.map(x => x.content[0].text), ['SELECTED', 'hello']);
    assert.deepEqual(calls[0].tools.map(tool => tool.name), ['shell']);
    assert.equal(calls[1].messages.length, 3); assert.equal(calls[1].tools[0].name, 'shell');
    assert.deepEqual((await new PresetStore(file).read()).bindings.auto, { enabled: true, presetId: 'selected', characterId: null, values: {}, markers: {} });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('client registers the conversation view, main panel and sidebar button through slot injection', async () => {
  let definition;
  globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
  try {
    await import(`../client.js?test=${Date.now()}`);
    const plugin = definition.factory(name => {
      assert.equal(name, 'react');
      return { createElement: (type, props, ...children) => ({ type, props, children }) };
    });
    const injected = [], registered = [];
    plugin.apply({ slots: {
      inject(name, fn) { injected.push(name); return fn(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    } });
    assert.deepEqual(injected, ['conversation.view', 'main', 'sidebar.panellist']);
    assert.deepEqual(registered.map(x => [x.options.name, x.options.id ?? x.options.key]), [
      ['conversation.view', 'preset-enhance-editor'], ['main', 'preset-enhance-editor'], ['sidebar.panellist', 'preset-enhance-editor'],
    ]);
  } finally { delete globalThis.window; }
});

test('preset mode composition inherits standard tools while replacing its persona', () => {
  const standard = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: coding',
    '    includeRuntimeContext: true',
    '- id: filesystem',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '  config:',
    '    root: .',
    '',
  ].join('\n');
  const generated = buildPresetModeComposition(standard);
  assert.match(generated, /prefix: ''/);
  assert.match(generated, /complete: true/);
  assert.match(generated, /includeRuntimeContext: false/);
  assert.match(generated, /name: '@deepseek-ai\/dsh-tool-fs'/);
  assert.doesNotMatch(generated, /prefix: coding/);
  assert.match(generated, /name: dsh-preset-enhance\/mode/);
});

test('tool policies apply to every mode and session overrides take effect on the next request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-tools-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    let guard;
    const session = { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
    await store.transaction(state => {
      state.modeToolPolicies.standard = { shell: false, read: true };
    });
    const ctx = {
      sessions: { get: id => id === 's' ? session : undefined },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(),
      webServer: { register: () => () => {} },
      tools: { guard: fn => { guard = fn; return () => {}; } },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        calls.push(options);
        yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const request = () => ({ sessionId: 's', provider: 'mock', model: 'mock',
      messages: [msg('u', 'user', 'hello')],
      tools: [{ name: 'shell', description: 'shell' }, { name: 'read', description: 'read' }] });
    for await (const _ of ctx.llm.stream(request())) {}
    assert.deepEqual(calls[0].tools.map(tool => tool.name), ['read']);
    assert.match(guard({ name: 'shell', agent: { session } }), /已在预设工作台中关闭/);
    assert.equal(guard({ name: 'read', agent: { session } }), undefined);

    await store.transaction(state => {
      state.sessionToolPolicies.s = { shell: true, read: false };
      state.revision++;
    });
    for await (const _ of ctx.llm.stream(request())) {}
    assert.deepEqual(calls[1].tools.map(tool => tool.name), ['shell']);
    assert.equal(guard({ name: 'shell', agent: { session } }), undefined);
    assert.match(guard({ name: 'read', agent: { session } }), /已在预设工作台中关闭/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('/preset toggles injection for the current session without sending a model message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-command-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {};
    let command;
    const session = { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
    await store.transaction(state => {
      state.presets.push({ id: 'p', name: 'Command preset', preset: { prompts: [] } });
      state.defaultPresetId = 'p';
    });
    const ctx = {
      sessions: { get: id => id === 's' ? session : undefined },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(),
      webServer: { register: () => () => {} },
      commands: { register: definition => { command = definition; return () => {}; } },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {}) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    assert.equal(command.name, 'preset');
    assert.match((await command.handler({ rawInput: 'on', agent: { session } })).text, /已开启/);
    assert.equal((await store.read()).bindings.s.enabled, true);
    assert.match((await command.handler({ rawInput: 'status', agent: { session } })).text, /已开启/);
    assert.match((await command.handler({ rawInput: '', agent: { session } })).text, /已关闭/);
    assert.equal((await store.read()).bindings.s.enabled, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('auto-enabled modes only affect conversations created after the mode was selected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-mode-time-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(state => {
      state.presets.push({ id: 'p', name: 'Auto', preset: { prompts: [{ identifier: 'p', role: 'system', content: 'AUTO' }] } });
      state.defaultPresetId = 'p';
      state.autoEnableModes.push('standard');
      state.autoEnableSince.standard = 100;
    });
    const sessions = {
      old: { id: 'old', header: { agentPreset: 'standard', createdAt: 99 }, snapshotEvents: () => [] },
      fresh: { id: 'fresh', header: { agentPreset: 'standard', createdAt: 100 }, snapshotEvents: () => [] },
    };
    const ctx = {
      sessions: { get: id => sessions[id] },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(),
      webServer: { register: () => () => {} },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        calls.push(options);
        yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    for (const sessionId of ['old', 'fresh']) {
      for await (const _ of ctx.llm.stream({ sessionId, provider: 'mock', model: 'mock',
        messages: [msg('u', 'user', 'hello')] })) {}
    }
    assert.deepEqual(calls[0].messages.map(item => item.content[0].text), ['hello']);
    assert.deepEqual(calls[1].messages.map(item => item.content[0].text), ['AUTO', 'hello']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('tool catalogs are resolved independently for every built-in and plugin-provided mode', async () => {
  const mounted = [];
  const ctx = {
    agentPresets: {
      standingKeyFor: async id => {
        mounted.push(id);
        if (id === 'mount-fails') throw new Error('plugin dependency unavailable');
        return 'scope:' + id;
      },
    },
    tools: {
      schemas: scope => scope === 'scope:standard'
        ? [{ name: 'shell', description: 'Shell' }, { name: 'read', description: 'Read' }]
        : [{ name: 'plugin.custom', description: 'Third-party tool' }],
    },
  };
  const modes = [
    { id: 'standard', name: 'Standard' },
    { id: 'third-party-mode', name: 'Plugin mode' },
    { id: 'declared-broken', name: 'Broken', broken: 'invalid composition' },
    { id: 'mount-fails', name: 'Mount fails' },
  ];
  const result = await discoverModeToolCatalogs(ctx, modes);
  assert.deepEqual(mounted, ['standard', 'third-party-mode', 'mount-fails']);
  assert.deepEqual(result.catalogs.standard.map(tool => tool.name), ['read', 'shell']);
  assert.deepEqual(result.catalogs['third-party-mode'].map(tool => tool.name), ['plugin.custom']);
  assert.equal(result.errors['declared-broken'], 'invalid composition');
  assert.equal(result.errors['mount-fails'], 'plugin dependency unavailable');
});

test('saved imports are global and the last library selection survives reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-selection-'));
  try {
    const file = join(dir, 'state.json'), listeners = {};
    let apiHandler;
    const ctx = {
      sessions: { get: () => undefined },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(),
      webServer: { register: definition => {
        if (definition.path === '/preset-enhance/api') apiHandler = definition.handler;
        return () => {};
      } },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {}) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const postRaw = async body => {
      const req = Readable.from([JSON.stringify(body)]);
      req.method = 'POST';
      req.url = '/preset-enhance/api';
      req.headers = { 'content-type': 'application/json', host: 'localhost' };
      let statusCode, payload;
      const res = {
        writeHead(code) { statusCode = code; },
        end(value) { payload = JSON.parse(String(value)); },
      };
      await apiHandler(req, res);
      return { statusCode, payload };
    };
    const post = async body => {
      const { statusCode, payload } = await postRaw(body);
      assert.equal(statusCode, 200, payload?.error);
      return payload;
    };
    const preset = {
      prompts: [{ identifier: 'chatHistory', marker: true, role: 'user' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
    };
    const first = await post({ revision: 0, action: 'save', name: 'A', preset });
    const second = await post({ revision: 1, action: 'save', name: 'B', preset });
    await post({ revision: 2, action: 'select-preset', id: first.id });
    await post({ revision: 3, action: 'save-deepseek-beta', enabled: true, relayUrl: ' https://relay.example.com/v1/ ' });

    const reopened = await new PresetStore(file).read();
    assert.deepEqual(reopened.presets.map(item => item.name), ['A', 'B']);
    assert.equal(reopened.selectedPresetId, first.id);
    assert.equal(reopened.defaultPresetId, first.id);
    assert.equal(reopened.deepseekBetaPrefix, true);
    assert.equal(reopened.prefixRelayUrl, 'https://relay.example.com/v1');
    assert.notEqual(first.id, second.id);

    const rejected = await postRaw({ revision: reopened.revision, action: 'save-deepseek-beta', enabled: true, relayUrl: 'ftp://relay.example.com' });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.payload.error, /中转地址/);
    const nullRelay = await postRaw({ revision: reopened.revision, action: 'save-deepseek-beta', enabled: true, relayUrl: null });
    assert.equal(nullRelay.statusCode, 400);
    assert.match(nullRelay.payload.error, /文本/);
    assert.equal((await new PresetStore(file).read()).prefixRelayUrl, 'https://relay.example.com/v1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('negative order and trailing ordered assistant compile as a prefix', () => {
  const preset = {
    prompts: [
      { identifier: 'chatHistory', marker: true, role: 'user' },
      { identifier: 'negative', role: 'system', content: '', injection_order: -999 },
      { identifier: 'prefix', role: 'model', content: '<think>continue here' },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'negative', enabled: true },
      { identifier: 'prefix', enabled: true },
    ] }],
  };
  const result = compilePreset(preset, [msg('u', 'user', 'hello')], { characterId: 100001 });
  assert.deepEqual(result.messages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(result.assistantPrefix, {
    active: true,
    kind: 'ordered-prompt',
    messageId: 'preset:preview:prefix',
  });
  assert.match(result.warnings.at(-1), /assistant prefix/);

  const ordinary = compilePreset({ prompts: [] }, [
    { ...msg('a', 'assistant', 'answer'), source: { kind: 'model', provider: 'mock', model: 'mock' } },
  ]);
  assert.equal(ordinary.assistantPrefix.active, false);
});

test('DeepSeek Beta bridge supplies reasoning fields only for the activated official prefix request', () => {
  const prefix = '<think>\ncontinue the plan';
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: prefix },
    ],
    thinking: { type: 'enabled' },
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    stream: true,
  };
  const registry = new Map([['session-1', new Map([[prefix, 1], ['Answer: ', 1]])]]);
  const init = {
    method: 'POST',
    headers: { 'x-deepseek-harness-session-id': 'session-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const rewritten = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', init, [registry]);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.input, 'https://api.deepseek.com/beta/chat/completions');
  const rewrittenBody = JSON.parse(rewritten.init.body);
  const messages = rewrittenBody.messages;
  assert.equal(rewrittenBody.tools, undefined);
  assert.equal(messages[1].reasoning_content, '');
  assert.deepEqual(messages.at(-1), {
    role: 'assistant',
    content: '',
    reasoning_content: 'continue the plan',
    prefix: true,
  });
  assert.equal(JSON.parse(init.body).messages.at(-1).reasoning_content, undefined);

  const plainBody = { ...body, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Answer: ' }] };
  const plain = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/v1/chat/completions', {
    ...init,
    body: JSON.stringify(plainBody),
  }, [registry]);
  assert.deepEqual(JSON.parse(plain.init.body).messages.at(-1), {
    role: 'assistant', content: 'Answer: ', reasoning_content: '', prefix: true,
  });

  const disabledBody = { ...body, thinking: { type: 'disabled' } };
  const disabled = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', {
    ...init,
    body: JSON.stringify(disabledBody),
  }, [registry]);
  assert.equal(JSON.parse(disabled.init.body).messages.at(-1).content, prefix);
  assert.equal(JSON.parse(disabled.init.body).messages.at(-1).reasoning_content, undefined);

  // Without an activation nothing is rewritten, and non chat-completion URLs are never touched.
  assert.equal(rewriteDeepSeekPrefixFetch('https://relay.example.com/v1/chat/completions', init, []).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch('https://relay.example.com/v1/files', init, [registry]).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', {
    ...init,
    headers: { ...init.headers, 'x-deepseek-harness-session-id': 'another-session' },
  }, [registry]).changed, false);
});

test('a configured relay keeps tools while the official endpoint still drops them', () => {
  const prefix = '<think>\ncontinue the plan';
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'assistant', content: prefix },
    ],
    thinking: { type: 'enabled' },
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
  };
  const relay = 'https://relay.example.com/v1';
  const init = {
    method: 'POST',
    headers: { 'x-deepseek-harness-session-id': 'session-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const registry = new Map([['session-1', new Map([[prefix, { count: 1, relay }]])]]);

  const relayed = rewriteDeepSeekPrefixFetch(`${relay}/chat/completions`, init, [registry]);
  assert.equal(relayed.changed, true);
  assert.equal(relayed.mode, 'relay');
  assert.equal(relayed.input, `${relay}/chat/completions`);
  const relayedBody = JSON.parse(relayed.init.body);
  assert.deepEqual(relayedBody.tools, body.tools);
  assert.equal(relayedBody.tool_choice, 'auto');
  assert.equal(relayedBody.parallel_tool_calls, false);
  assert.deepEqual(relayedBody.messages.at(-1), {
    role: 'assistant', content: '', reasoning_content: 'continue the plan', prefix: true,
  });
  assert.equal(relayedBody.messages[1].reasoning_content, '');
  assert.equal(JSON.parse(init.body).messages.at(-1).reasoning_content, undefined);

  const disabled = rewriteDeepSeekPrefixFetch(`${relay}/chat/completions`, {
    ...init,
    body: JSON.stringify({ ...body, thinking: { type: 'disabled' } }),
  }, [registry]);
  assert.equal(JSON.parse(disabled.init.body).messages.at(-1).content, prefix);
  assert.equal(JSON.parse(disabled.init.body).messages.at(-1).reasoning_content, undefined);

  // The official endpoint keeps the tool surgery no matter what relay is configured.
  const official = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', init, [registry]);
  assert.equal(official.mode, 'official');
  assert.equal(official.input, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal(JSON.parse(official.init.body).tools, undefined);

  // A configured relay never touches a different endpoint.
  const elsewhere = rewriteDeepSeekPrefixFetch('https://other.example.com/v1/chat/completions', init, [registry]);
  assert.equal(elsewhere.changed, false);
  assert.equal(elsewhere.input, 'https://other.example.com/v1/chat/completions');
  assert.equal(elsewhere.init, init);
});

test('an empty relay field treats any forwarded chat-completion endpoint as the relay', () => {
  const prefix = 'Answer: ';
  const body = {
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: prefix }],
    tools: [{ type: 'function', function: { name: 'noop' } }],
  };
  const init = { method: 'POST', headers: { 'x-deepseek-harness-session-id': 's' }, body: JSON.stringify(body) };
  const activated = new Map([['s', new Map([[prefix, 1]])]]);

  const rewritten = rewriteDeepSeekPrefixFetch('https://relay.example.com/v1/chat/completions', init, [activated]);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.mode, 'relay');
  assert.equal(rewritten.input, 'https://relay.example.com/v1/chat/completions');
  const rewrittenBody = JSON.parse(rewritten.init.body);
  assert.deepEqual(rewrittenBody.tools, body.tools);
  assert.deepEqual(rewrittenBody.messages.at(-1), { role: 'assistant', content: 'Answer: ', reasoning_content: '', prefix: true });

  assert.equal(rewriteDeepSeekPrefixFetch('https://relay.example.com/v1/chat/completions', init, []).changed, false);
});

test('the relay address accepts base and full endpoints while rejecting unusable input', () => {
  assert.equal(normalizeRelayUrl(''), '');
  assert.equal(normalizeRelayUrl('   '), '');
  assert.equal(normalizeRelayUrl(' https://relay.example.com/v1/ '), 'https://relay.example.com/v1');
  assert.equal(normalizeRelayUrl('https://relay.example.com'), 'https://relay.example.com');
  assert.equal(normalizeRelayUrl('http://127.0.0.1:8080/beta/chat/completions'), 'http://127.0.0.1:8080/beta/chat/completions');
  assert.throws(() => normalizeRelayUrl(), /文本/);
  assert.throws(() => normalizeRelayUrl(null), /文本/);
  assert.throws(() => normalizeRelayUrl(42), /文本/);
  assert.throws(() => normalizeRelayUrl('relay.example.com'), /合法的 URL/);
  assert.throws(() => normalizeRelayUrl('ftp://relay.example.com'), /中转地址必须使用/);
  assert.throws(() => normalizeRelayUrl('https://user:pass@relay.example.com'), /用户名或密码/);
  assert.throws(() => normalizeRelayUrl('https://relay example.com'), /空白字符/);
  assert.throws(() => normalizeRelayUrl('https://relay.example.com/v1?token=abc'), /查询参数/);
  assert.throws(() => normalizeRelayUrl('https://relay.example.com/v1#frag'), /查询参数/);
});

test('the relay address comes from the activation that matched the outgoing text', () => {
  const stale = 'https://old-relay.example.com/v1';
  const current = 'https://new-relay.example.com/v1';
  const registry = new Map([['s', new Map([
    ['AAAA', { count: 1, relay: stale }],
    ['PREFIX', { count: 1, relay: current }],
  ])]]);
  const init = content => ({ headers: { 'x-deepseek-harness-session-id': 's' },
    body: JSON.stringify({ messages: [{ role: 'assistant', content }], tools: [{ type: 'function' }] }) });
  const matched = rewriteDeepSeekPrefixFetch(`${current}/chat/completions`, init('PREFIX'), [registry]);
  assert.equal(matched.changed, true);
  assert.equal(matched.mode, 'relay');
  // Another activation's relay must not decide where this request may go.
  assert.equal(rewriteDeepSeekPrefixFetch(`${stale}/chat/completions`, init('PREFIX'), [registry]).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch('https://anywhere.example.com/v1/chat/completions', init('PREFIX'), [registry]).changed, false);
});

test('the installed fetch bridge rewrites only the activated relay prefill request', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => { calls.push({ input: String(input), init }); return { ok: true, status: 200 }; };
  globalThis.fetch = stub;
  try {
    const controller = installDeepSeekBetaBridge({ effect: fn => { fn(); } });
    const init = { method: 'POST', headers: { 'x-deepseek-harness-session-id': 's' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '<think>\ncontinue' }],
        tools: [{ type: 'function', function: { name: 'noop' } }] }) };
    const release = controller.activate('s', '<think>\ncontinue', 'https://relay.example.com/v1/');
    await globalThis.fetch('https://relay.example.com/v1/chat/completions', init);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.messages.at(-1).prefix, true);
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'noop' } }]);

    release();
    await globalThis.fetch('https://relay.example.com/v1/chat/completions', init);
    assert.equal(calls[1].init, init);

    controller.dispose();
    assert.equal(globalThis.fetch, stub);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('relay configuration drives prefix rewriting end to end for the routed provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-relay-'));
  resetFetchBridge();
  const previous = globalThis.fetch;
  const posted = [], disposers = [], listeners = {};
  try {
    globalThis.fetch = async (input, init) => { posted.push({ input: String(input), init }); return { ok: true, status: 200 }; };
    const file = join(dir, 'state.json'), store = new PresetStore(file);
    await store.transaction(state => {
      state.presets.push({ id: 'p', name: 'Prefix', preset: {
        prompts: [
          { identifier: 'chatHistory', marker: true, role: 'user' },
          { identifier: 'prefix', role: 'assistant', content: '<think>\n继续' },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'prefix', enabled: true },
        ] }],
      } });
      state.selectedPresetId = 'p';
      state.defaultPresetId = 'p';
      state.bindings.s = { enabled: true, presetId: 'p', characterId: null, values: {}, markers: {} };
      state.deepseekBetaPrefix = true;
      state.prefixRelayUrl = 'https://relay.example.com/v1';
    });
    const session = { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
    const ctx = {
      sessions: { get: id => id === 's' ? session : undefined },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer; },
      webServer: { register: () => () => {} },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        await globalThis.fetch('https://relay.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'x-deepseek-harness-session-id': options.sessionId, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay-model',
            messages: options.messages.map(message => ({
              role: message.role,
              content: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
            })),
            thinking: { type: 'enabled' },
            tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
          }),
        });
        yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const send = async provider => {
      const before = posted.length;
      for await (const _ of ctx.llm.stream({ sessionId: 's', provider, model: 'relay-model',
        messages: [msg('u', 'user', 'hi')] })) {}
      assert.equal(posted.length, before + 1);
      return JSON.parse(posted.at(-1).init.body);
    };
    const relax = async relay => {
      await store.transaction(state => { state.prefixRelayUrl = relay; state.revision++; });
    };

    // A configured relay extends the rewrite to the provider routed through it.
    const configured = await send('relay-provider');
    assert.deepEqual(configured.messages.at(-1), { role: 'assistant', content: '', reasoning_content: '继续', prefix: true });
    assert.deepEqual(configured.tools, [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }]);

    // An empty relay keeps the official provider's non-official endpoint on the relay path.
    await relax('');
    const blankOfficial = await send('deepseek-official');
    assert.deepEqual(blankOfficial.messages.at(-1), { role: 'assistant', content: '', reasoning_content: '继续', prefix: true });
    assert.deepEqual(blankOfficial.tools, [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }]);

    // Other providers stay untouched while the relay field is empty.
    const untouched = await send('other-provider');
    assert.equal(untouched.messages.at(-1).prefix, undefined);

    // A hand-edited, unusable relay must not widen into a wildcard.
    await relax('ftp://relay.example.com/v1');
    const malformed = await send('relay-provider');
    assert.equal(malformed.messages.at(-1).prefix, undefined);
    assert.deepEqual(malformed.tools, [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }]);
  } finally {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
    resetFetchBridge();
    globalThis.fetch = previous;
    await rm(dir, { recursive: true, force: true });
  }
});