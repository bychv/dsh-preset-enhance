import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { PresetStore } from '../lib/store.mjs';
import { installDeepSeekBetaBridge, rewriteDeepSeekPrefixFetch } from '../lib/deepseek-beta.mjs';
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
test('client registers the workbench and locks both DSH resize handles while mounted', async () => {
  let definition;
  const cleanups = [];
  const rootAttributes = new Set();
  const styles = [];
  globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
  globalThis.document = {
    documentElement: {
      setAttribute(name) { rootAttributes.add(name); },
      removeAttribute(name) { rootAttributes.delete(name); },
    },
    head: { appendChild(style) { styles.push(style); } },
    querySelector(selector) {
      return selector === 'style[data-preset-enhance-resize-lock]' ? styles[0] ?? null : null;
    },
    createElement(tag) {
      assert.equal(tag, 'style');
      const attributes = new Set();
      return {
        textContent: '',
        setAttribute(name) { attributes.add(name); },
        remove() {
          const index = styles.indexOf(this);
          if (index >= 0) styles.splice(index, 1);
        },
      };
    },
  };
  try {
    await import('../client.js?test=' + Date.now());
    const plugin = definition.factory(name => {
      assert.equal(name, 'react');
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useEffect(effect) { cleanups.push(effect()); },
      };
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

    registered.find(entry => entry.options.name === 'conversation.view').component({ sessionId: 's' });
    const frame = registered.find(entry => entry.options.name === 'main').component({ sessionId: 's' });
    assert.equal(frame.type, 'iframe');
    assert.equal(rootAttributes.has('data-preset-enhance-workbench'), true);
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, /data-side="sidebar"/);
    assert.match(styles[0].textContent, /data-side="rightbar"/);
    assert.match(styles[0].textContent, /display:none!important/);

    cleanups.shift()();
    assert.equal(rootAttributes.has('data-preset-enhance-workbench'), true);
    cleanups.shift()();
    assert.equal(rootAttributes.has('data-preset-enhance-workbench'), false);
    assert.equal(styles.length, 0);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
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
    await post({ revision: 3, action: 'save-deepseek-beta', enabled: true, toolCalls: true, removeNonOfficialTools: false, postToolPrefixMode: 'custom', postToolPrefixText: 'Review results' });

    const reopened = await new PresetStore(file).read();
    assert.deepEqual(reopened.presets.map(item => item.name), ['A', 'B']);
    assert.equal(reopened.selectedPresetId, first.id);
    assert.equal(reopened.defaultPresetId, first.id);
    assert.equal(reopened.deepseekBetaPrefix, true);
    assert.equal(reopened.prefixToolCalls, true);
    assert.equal(reopened.postToolPrefixMode, 'custom');
    assert.equal(reopened.postToolPrefixText, 'Review results');
    assert.equal(reopened.prefixNonOfficialRemoveTools, false);
    assert.equal(Object.hasOwn(reopened, 'prefixRelayUrl'), false);
    assert.notEqual(first.id, second.id);

    const rejected = await postRaw({
      revision: reopened.revision,
      action: 'save-deepseek-beta',
      enabled: true,
      removeNonOfficialTools: null,
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.payload.error, /工具移除开关/);
    assert.equal((await new PresetStore(file).read()).prefixNonOfficialRemoveTools, false);

    for (const invalid of [{ postToolPrefixMode: 'unknown' }, { postToolPrefixText: null }]) {
      const response = await postRaw({ revision: reopened.revision,
        action: 'save-deepseek-beta', enabled: true, ...invalid });
      assert.equal(response.statusCode, 400);
      assert.equal((await new PresetStore(file).read()).postToolPrefixText, 'Review results');
    }

    const external = new PresetStore(file);
    await external.transaction(state => {
      state.bindings.bound = {
        enabled: true,
        presetId: first.id,
        characterId: 100001,
        values: { user: 'User' },
        markers: {},
      };
      state.sessions.bound = { presetId: first.id, key: 'stale' };
      state.revision++;
    });
    const deleted = await post({ revision: 5, action: 'delete-preset', id: first.id });
    assert.equal(deleted.id, second.id);
    const afterFirstDelete = await external.read();
    assert.deepEqual(afterFirstDelete.presets.map(item => item.name), ['B']);
    assert.equal(afterFirstDelete.selectedPresetId, second.id);
    assert.equal(afterFirstDelete.defaultPresetId, second.id);
    assert.equal(afterFirstDelete.bindings.bound.enabled, true);
    assert.equal(afterFirstDelete.bindings.bound.presetId, second.id);
    assert.equal(afterFirstDelete.bindings.bound.characterId, null);
    assert.equal(afterFirstDelete.sessions.bound, undefined);

    const deletedLast = await post({ revision: 6, action: 'delete-preset', id: second.id });
    assert.equal(deletedLast.id, null);
    const empty = await external.read();
    assert.equal(empty.presets.length, 0);
    assert.equal(empty.selectedPresetId, null);
    assert.equal(empty.defaultPresetId, null);
    assert.equal(empty.bindings.bound.enabled, false);
    assert.equal(empty.bindings.bound.presetId, '');
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
  assert.equal(rewriteDeepSeekPrefixFetch('https://adapter.example.com/v1/chat/completions', init, []).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch('https://adapter.example.com/v1/files', init, [registry]).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', {
    ...init,
    headers: { ...init.headers, 'x-deepseek-harness-session-id': 'another-session' },
  }, [registry]).changed, false);
});

test('non-official adapter supports pass-through, removal and DSML tool handling', () => {
  const prefix = '<think>\ncontinue the plan';
  const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }];
  const body = {
    model: 'adapter-model',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'assistant', content: prefix },
    ],
    thinking: { type: 'enabled' },
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
  };
  const init = {
    method: 'POST',
    headers: { 'x-deepseek-harness-session-id': 'session-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const endpoint = 'https://adapter.example.com/v1/chat/completions';

  const removingRegistry = new Map([['session-1', new Map([[
    prefix, { count: 1, removeNonOfficialTools: true },
  ]])]]);
  const removed = rewriteDeepSeekPrefixFetch(endpoint, init, [removingRegistry]);
  assert.equal(removed.changed, true);
  assert.equal(removed.mode, 'adapter');
  assert.equal(removed.input, endpoint);
  const removedBody = JSON.parse(removed.init.body);
  assert.equal(removedBody.tools, undefined);
  assert.equal(removedBody.tool_choice, undefined);
  assert.equal(removedBody.parallel_tool_calls, undefined);
  assert.deepEqual(removedBody.messages.at(-1), {
    role: 'assistant', content: '', reasoning_content: 'continue the plan', prefix: true,
  });
  assert.equal(removedBody.messages[1].reasoning_content, '');

  const passThroughRegistry = new Map([['session-1', new Map([[
    prefix, { count: 1, removeNonOfficialTools: false },
  ]])]]);
  const passThrough = rewriteDeepSeekPrefixFetch(endpoint, init, [passThroughRegistry]);
  const passThroughBody = JSON.parse(passThrough.init.body);
  assert.deepEqual(passThroughBody.tools, tools);
  assert.equal(passThroughBody.tool_choice, 'auto');
  assert.equal(passThroughBody.parallel_tool_calls, false);
  assert.equal(passThroughBody.messages.at(-1).prefix, true);

  const emulatingRegistry = new Map([['session-1', new Map([[
    prefix, { count: 1, toolCalls: true, removeNonOfficialTools: false },
  ]])]]);
  const emulated = rewriteDeepSeekPrefixFetch(endpoint, init, [emulatingRegistry]);
  const emulatedBody = JSON.parse(emulated.init.body);
  assert.equal(emulatedBody.tools, undefined);
  assert.equal(emulatedBody.tool_choice, undefined);
  assert.match(emulatedBody.messages[0].content, /## Tools/);
  assert.match(emulatedBody.messages[0].content, /noop/);
  assert.deepEqual(emulated.responseTransform, {
    contentPrefix: '',
    reasoningPrefix: 'continue the plan',
  });

  const official = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/chat/completions', init, [passThroughRegistry]);
  assert.equal(official.mode, 'official');
  assert.equal(official.input, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal(JSON.parse(official.init.body).tools, undefined);

  assert.equal(rewriteDeepSeekPrefixFetch('https://adapter.example.com/v1/files', init, [passThroughRegistry]).changed, false);
});

test('adapter replays historical tool reasoning from tags and compatible aliases', () => {
  const prefix = 'Answer: ';
  const toolCalls = [{
    id: 'call-weather',
    type: 'function',
    function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
  }];
  const body = {
    messages: [
      { role: 'user', content: 'Check the weather.' },
      { role: 'assistant', content: '<think>\nI should call the weather tool.</think>\n', tool_calls: toolCalls },
      { role: 'tool', tool_call_id: 'call-weather', content: '{"temperature":22}' },
      { role: 'assistant', content: 'Earlier answer.', reasoning: 'Summarize the tool result.' },
      { role: 'user', content: 'Continue.' },
      { role: 'assistant', content: prefix },
    ],
    thinking: { type: 'enabled' },
    tools: [{ type: 'function', function: { name: 'lookup_weather' } }],
  };
  const init = {
    headers: { 'x-deepseek-harness-session-id': 's' },
    body: JSON.stringify(body),
  };
  const registry = new Map([['s', new Map([[
    prefix, { count: 1, removeNonOfficialTools: true },
  ]])]]);

  const rewritten = rewriteDeepSeekPrefixFetch('https://adapter.example.com/v1/chat/completions', init, [registry]);
  const messages = JSON.parse(rewritten.init.body).messages;
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: '',
    reasoning_content: 'I should call the weather tool.',
    tool_calls: toolCalls,
  });
  assert.equal(messages[3].reasoning, 'Summarize the tool result.');
  assert.equal(messages[3].reasoning_content, 'Summarize the tool result.');
  assert.equal(JSON.parse(rewritten.init.body).tools, undefined);
});

test('active assistant prefix is detected on any non-official adapter address', () => {
  const prefix = 'Answer: ';
  const makeInit = content => ({
    method: 'POST',
    headers: { 'x-deepseek-harness-session-id': 's' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content }],
      tools: [{ type: 'function', function: { name: 'noop' } }],
    }),
  });
  const activated = new Map([['s', new Map([[
    prefix, { count: 1, removeNonOfficialTools: false },
  ]])]]);

  for (const endpoint of [
    'https://first.example.com/v1/chat/completions',
    'http://127.0.0.1:8080/chat/completions',
  ]) {
    const rewritten = rewriteDeepSeekPrefixFetch(endpoint, makeInit(prefix), [activated]);
    assert.equal(rewritten.changed, true);
    assert.equal(rewritten.mode, 'adapter');
    assert.equal(rewritten.input, endpoint);
    assert.deepEqual(JSON.parse(rewritten.init.body).tools, [
      { type: 'function', function: { name: 'noop' } },
    ]);
  }
  assert.equal(rewriteDeepSeekPrefixFetch(
    'https://first.example.com/v1/chat/completions', makeInit('different'), [activated],
  ).changed, false);
  assert.equal(rewriteDeepSeekPrefixFetch(
    'https://first.example.com/v1/chat/completions', makeInit(prefix), [],
  ).changed, false);
});

test('the installed fetch bridge rewrites only an activated adapter prefill request', async () => {
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
    const release = controller.activate('s', '<think>\ncontinue', { removeNonOfficialTools: true });
    await globalThis.fetch('https://adapter.example.com/v1/chat/completions', init);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.messages.at(-1).prefix, true);
    assert.equal(body.tools, undefined);

    release();
    await globalThis.fetch('https://adapter.example.com/v1/chat/completions', init);
    assert.equal(calls[1].init, init);

    controller.dispose();
    assert.equal(globalThis.fetch, stub);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('installed fetch bridge converts an emulated adapter response back to tool calls', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  const dsml = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="noop">',
    '<｜｜DSML｜｜ parameter name="value" string="false">7</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: dsml, reasoning_content: '' },
        finish_reason: 'stop',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge({ effect: fn => fn() });
    const release = controller.activate('s', 'Prefix: ', { toolCalls: true });
    const response = await globalThis.fetch('https://adapter.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-deepseek-harness-session-id': 's', 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'use a tool' }, { role: 'assistant', content: 'Prefix: ' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      }),
    });
    const outgoing = JSON.parse(calls[0].init.body);
    assert.equal(outgoing.tools, undefined);
    assert.equal(outgoing.tool_choice, undefined);
    assert.match(outgoing.messages[0].content, /## Tools/);

    const data = await response.json();
    assert.equal(data.choices[0].finish_reason, 'tool_calls');
    assert.equal(data.choices[0].message.content, 'Prefix: ');
    assert.equal(data.choices[0].message.tool_calls[0].function.name, 'noop');
    assert.deepEqual(JSON.parse(data.choices[0].message.tool_calls[0].function.arguments), { value: 7 });

    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});


test('adapter tool settings drive prefix rewriting end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-adapter-'));
  resetFetchBridge();
  const previous = globalThis.fetch;
  const posted = [], disposers = [], listeners = {};
  try {
    globalThis.fetch = async (input, init) => {
      posted.push({ input: String(input), init });
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
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
      state.prefixToolCalls = true;
      state.prefixNonOfficialRemoveTools = true;
    });
    const session = { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [] };
    const nativeTools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }];
    const ctx = {
      sessions: { get: id => id === 's' ? session : undefined },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer; },
      webServer: { register: () => () => {} },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        await globalThis.fetch('https://adapter.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'x-deepseek-harness-session-id': options.sessionId, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'adapter-model',
            messages: options.messages.map(message => ({
              role: message.role,
              content: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
            })),
            thinking: { type: 'enabled' },
            tools: nativeTools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
          }),
        });
        yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const send = async (messages = [msg('u', 'user', 'hi')]) => {
      const before = posted.length;
      for await (const _ of ctx.llm.stream({
        sessionId: 's',
        provider: 'plugin-provided-adapter',
        model: 'adapter-model',
        messages,
      })) {}
      assert.equal(posted.length, before + 1);
      return JSON.parse(posted.at(-1).init.body);
    };
    const configure = async values => {
      await store.transaction(state => {
        Object.assign(state, values);
        state.revision++;
      });
    };

    const emulated = await send();
    assert.deepEqual(emulated.messages.at(-1), {
      role: 'assistant', content: '', reasoning_content: '继续', prefix: true,
    });
    assert.equal(emulated.tools, undefined);
    assert.match(emulated.messages[0].content, /## Tools/);

    const toolHistory = [msg('u', 'user', 'hi'), {
      ...msg('result', 'user', 'tool output'), source: { kind: 'tool' },
    }];
    assert.equal((await send(toolHistory)).messages.at(-1).reasoning_content, '继续');
    await configure({ postToolPrefixMode: 'custom', postToolPrefixText: '<think>\nReview {{lastmessage}}' });
    assert.equal((await new PresetStore(file).read()).postToolPrefixText, '<think>\nReview {{lastmessage}}');
    assert.equal((await send(toolHistory)).messages.at(-1).reasoning_content, 'Review tool output');
    assert.equal((await send([...toolHistory, {
      ...msg('result2', 'user', 'second output'), source: { kind: 'tool' },
    }])).messages.at(-1).reasoning_content, 'Review second output');
    assert.equal((await send([...toolHistory, msg('new', 'user', 'next turn')])).messages.at(-1).reasoning_content, '继续');
    await configure({ postToolPrefixText: 'Updated continuation' });
    assert.equal((await send(toolHistory)).messages.at(-1).content, 'Updated continuation');
    await configure({ deepseekBetaPrefix: false });
    assert.equal((await send(toolHistory)).messages.at(-1).content, '<think>\n继续');
    await configure({ deepseekBetaPrefix: true, postToolPrefixText: '' });
    assert.equal((await send(toolHistory)).messages.at(-1).reasoning_content, '继续');
    await configure({ postToolPrefixMode: 'inherit', postToolPrefixText: 'unused' });
    assert.equal((await send(toolHistory)).messages.at(-1).reasoning_content, '继续');

    await configure({ prefixToolCalls: false, prefixNonOfficialRemoveTools: false });
    const passedThrough = await send();
    assert.deepEqual(passedThrough.tools, nativeTools);
    assert.equal(passedThrough.tool_choice, 'auto');
    assert.equal(passedThrough.parallel_tool_calls, false);
    assert.doesNotMatch(passedThrough.messages[0].content, /## Tools/);

    await configure({ prefixNonOfficialRemoveTools: true });
    const removed = await send();
    assert.equal(removed.tools, undefined);
    assert.equal(removed.tool_choice, undefined);
    assert.equal(removed.parallel_tool_calls, undefined);
  } finally {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
    resetFetchBridge();
    globalThis.fetch = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
