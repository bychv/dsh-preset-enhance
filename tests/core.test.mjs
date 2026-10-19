import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { validateHistoryPatches } from '../lib/history-patches.mjs';
import { compilePreset, dshSystemPromptEnabled, DYNAMIC_PREFILL_ID, lastContentRole, validatePreset } from '../lib/preset.mjs';
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
test('DSH system prompt switch defaults on and accepts only a boolean override', () => {
  assert.equal(dshSystemPromptEnabled({ prompts: [] }), true);
  assert.equal(dshSystemPromptEnabled({ prompts: [], dsh_system_prompt_enabled: true }), true);
  assert.equal(dshSystemPromptEnabled({ prompts: [], dsh_system_prompt_enabled: false }), false);
  assert.throws(() => validatePreset({ prompts: [], dsh_system_prompt_enabled: 'false' }),
    /dsh_system_prompt_enabled 必须是布尔值/);
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
test('client hides conversation width handles locally while keeping sidebar resizing available', async () => {
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
        useEffect(effect) { const dispose = effect(); if (typeof dispose === 'function') cleanups.push(dispose); },
        useRef(value) { return { current: value }; },
        useSyncExternalStore(_subscribe, read) { return read(); },
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

    const conversationEntry = registered.find(entry => entry.options.name === 'conversation.view');
    assert.equal(conversationEntry.options.inject, undefined);
    const conversationFrame = conversationEntry.component({
      sessionId: 'conversation-session',
      useSessions(selector) { return selector({ current: 'other-session' }); },
    });
    assert.equal(conversationFrame.type, 'div');
    assert.equal(conversationFrame.props['data-preset-enhance-frame-host'], '');
    const frame = registered.find(entry => entry.options.name === 'main').component({
      useSessions(selector) { return selector({ current: 'current-session' }); },
    });
    assert.equal(frame.type, 'div');
    assert.equal(frame.props['data-preset-enhance-frame-host'], '');
    assert.equal(rootAttributes.has('data-preset-enhance-workbench'), false);
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, /data-width-handle/);
    assert.match(styles[0].textContent, /data-conversation-content/);
    assert.doesNotMatch(styles[0].textContent, /data-side|html\[/);
    assert.equal(conversationFrame.props['data-preset-enhance-frame-host'], '');
    assert.match(styles[0].textContent, /display:none!important/);

    cleanups.shift()();
    assert.equal(rootAttributes.has('data-preset-enhance-workbench'), false);
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
test('a preset can remove or retain the DSH system prompt in other modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-system-toggle-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(state => {
      state.presets.push({
        id: 'p', name: 'Auto',
        preset: {
          dsh_system_prompt_enabled: false,
          prompts: [{ identifier: 'p', role: 'system', content: 'PRESET' }],
        },
      });
      state.defaultPresetId = 'p';
      state.selectedPresetId = 'p';
      state.autoEnableModes.push('standard');
      state.autoEnableSince.standard = 0;
    });
    const sessions = {
      off: { id: 'off', header: { agentPreset: 'standard', createdAt: 1 }, snapshotEvents: () => [] },
      on: { id: 'on', header: { agentPreset: 'standard', createdAt: 2 }, snapshotEvents: () => [] },
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
    const system = {
      id: 'dsh-system', role: 'system', content: [{ type: 'text', text: 'DSH SYSTEM' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    };
    const runtime = {
      id: 'dsh-runtime', role: 'user', content: [{ type: 'text', text: 'DSH RUNTIME' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
    };
    const request = sessionId => ({ sessionId, provider: 'mock', model: 'mock',
      messages: [system, runtime, msg('u', 'user', 'hello')] });

    for await (const _ of ctx.llm.stream(request('off'))) {}
    assert.deepEqual(calls[0].messages.map(message => message.content[0].text), ['PRESET', 'hello']);

    await store.transaction(state => {
      state.presets[0].preset.dsh_system_prompt_enabled = true;
      state.revision++;
    });
    for await (const _ of ctx.llm.stream(request('on'))) {}
    // The two leading system messages (the preset's own prompt and the retained DSH
    // system prompt) are merged into one ordered message. The host's Messages serializer
    // keeps only the LAST leading system snapshot (protocols/messages/serialize.ts:83-95),
    // so leaving them split would silently drop the preset prompt on a Messages
    // connection - and on the chat path reached by rerouting an official Messages request.
    assert.deepEqual(calls[1].messages.map(message => message.content[0].text),
      ['PRESET\n\nDSH SYSTEM', 'DSH RUNTIME', 'hello']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('system prompt toggle filters durable DSH history in requests and previews without changing the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-durable-system-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    const preset = { prompts: [{ identifier: 'p', role: 'system', content: 'PRESET' }] };
    await store.transaction(state => {
      state.presets.push({ id: 'p', preset });
      for (const id of ['standard', AGENT_PRESET_ID]) state.bindings[id] = { enabled: true, presetId: 'p' };
    });
    const owned = (id, role, text, source) => ({ ...msg(id, role, text), source });
    const history = [
      owned('old-system', 'system', 'OLD SYSTEM', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }),
      msg('human', 'user', 'Current runtime context. This is a real user message.'),
      owned('old-runtime', 'user', 'OLD RUNTIME', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }),
      msg('answer', 'assistant', 'reply'),
      owned('new-system', 'system', 'NEW SYSTEM', { kind: 'system-prompt' }),
      owned('new-runtime', 'user', 'NEW RUNTIME', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
      owned('cleared', 'user', 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.', { kind: 'runtime-context' }),
      owned('other-plugin', 'user', 'OTHER', { kind: 'plugin', plugin: 'other-plugin' }),
    ];
    const original = structuredClone(history);
    const sessions = Object.fromEntries(['standard', AGENT_PRESET_ID].map(id => [id, {
      id, header: { agentPreset: id }, snapshotEvents: () => [], deriveMessages: () => history,
    }]));
    let apiHandler;
    const ctx = {
      sessions: { get: id => sessions[id] },
      on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(),
      webServer: { register: definition => {
        if (definition.path === '/preset-enhance/api') apiHandler = definition.handler;
        return () => {};
      } },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        calls.push(options);
        yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    // Repeat the disabled request to exercise cached compilation, then re-enable
    // in the same conversation: filtering must never rewrite durable history.
    for (const enabled of [true, false, false, true]) {
      await store.transaction(state => {
        state.presets[0].preset.dsh_system_prompt_enabled = enabled;
        state.revision++;
      });
      for (const sessionId of ['standard', AGENT_PRESET_ID]) {
        const stripped = !enabled || sessionId === AGENT_PRESET_ID;
        const kept = stripped ? [history[1], history[3], history[7]] : history;
        for await (const _ of ctx.llm.stream({ sessionId, provider: 'mock', model: 'mock', messages: history })) {}
        const expected = ['PRESET', ...kept.map(m => m.content[0].text)];
        if (!stripped) expected.splice(0, 2, 'PRESET\n\nOLD SYSTEM');
        assert.deepEqual(calls.at(-1).messages.map(m => m.content[0].text), expected);

        const req = Readable.from([JSON.stringify({ action: 'preview', sessionId,
          preset: { ...preset, dsh_system_prompt_enabled: enabled } })]);
        Object.assign(req, { method: 'POST', url: '/preset-enhance/api',
          headers: { 'content-type': 'application/json', host: 'localhost' } });
        let status, preview;
        await apiHandler(req, { writeHead: value => { status = value; },
          end: value => { preview = JSON.parse(String(value)); } });
        assert.equal(status, 200, preview?.error);
        assert.deepEqual(preview.messages, calls.at(-1).messages, 'preview includes the same system-message adaptation as dispatch');
        assert.deepEqual(history, original);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('selecting a preset rebinds only the current session and drops the previous preset cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-switch-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(state => {
      state.presets = ['A', 'B'].map((id, index) => ({ id, name: id, preset: {
        prompts: [{ identifier: 'p', role: 'system', content: `${id}:{{incvar::count}}:{{user}}` }],
        prompt_order: [{ character_id: index + 1, order: [{ identifier: 'p', enabled: true }] }],
      } }));
      state.selectedPresetId = state.defaultPresetId = 'A';
      for (const id of ['s', 'other', 'disabled']) state.bindings[id] = {
        enabled: id !== 'disabled', presetId: 'A', characterId: 1,
        values: { user: 'Alice' }, markers: { custom: 'keep' },
      };
    });
    const sessions = Object.fromEntries(['s', 'other', 'disabled', 'fresh'].map(id => [id, {
      id, header: { agentPreset: AGENT_PRESET_ID }, snapshotEvents: () => [],
    }]));
    let apiHandler;
    const ctx = {
      sessions: { get: id => sessions[id] }, on: (name, fn) => listeners[name] = fn,
      effect: fn => fn(), webServer: { register: definition => {
        if (definition.path === '/preset-enhance/api') apiHandler = definition.handler;
        return () => {};
      } },
      llm: { stream: options => listeners['llm/stream'](options, async function* () {
        calls.push(options); yield { type: 'finish', reason: { kind: 'completed' } };
      }) },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const send = async (sessionId = 's') => {
      for await (const _ of ctx.llm.stream({ sessionId, provider: 'mock', model: 'mock',
        messages: [msg('u', 'user', 'hello')] })) {}
      return calls.at(-1).messages[0].content[0].text;
    };
    const post = async (body, sessionId = '') => {
      const req = Readable.from([JSON.stringify({ revision: (await store.read()).revision, ...body })]);
      Object.assign(req, { method: 'POST', url: '/preset-enhance/api?sessionId=' + encodeURIComponent(sessionId),
        headers: { 'content-type': 'application/json', host: 'localhost' } });
      let status, result;
      await apiHandler(req, { writeHead: value => { status = value; }, end: value => { result = JSON.parse(String(value)); } });
      assert.equal(status, 200, result?.error);
      return result;
    };
    assert.equal(await send(), 'A:1:Alice');
    assert.equal(await send(), 'A:1:Alice');
    await post({ action: 'select-preset', id: 'B', sessionId: 's' });
    const switched = await store.read();
    assert.equal(switched.sessions.s, undefined);
    assert.deepEqual(switched.bindings.s, { enabled: true, presetId: 'B', characterId: null,
      values: { user: 'Alice' }, markers: { custom: 'keep' } });
    assert.equal(switched.bindings.other.presetId, 'A');
    assert.equal(await send(), 'B:1:Alice');
    assert.equal(await send(), 'B:1:Alice');
    assert.equal(await send('other'), 'A:1:Alice');

    // A sidebar-only choice changes the default, not an existing conversation.
    await post({ action: 'select-preset', id: 'A' });
    assert.equal(await send(), 'B:1:Alice');
    await post({ action: 'select-preset', id: 'B', sessionId: 'disabled' });
    assert.equal((await new PresetStore(file).read()).bindings.disabled.enabled, false);
    assert.equal(await send('disabled'), 'hello');
    await post({ action: 'select-preset', id: 'B', sessionId: 'fresh' });
    assert.equal(await send('fresh'), 'B:1:User');

    // Explicit Apply also switches the preset without carrying its old macro cache.
    await post({ action: 'bind', sessionId: 's', binding: { ...switched.bindings.s, presetId: 'A' } });
    assert.equal(await send(), 'A:1:Alice');
    const presetB = (await store.read()).presets.find(record => record.id === 'B').preset;
    for (const body of [
      { action: 'set-default', id: 'B' },
      { action: 'save', id: 'B', name: 'Updated B', preset: presetB },
      { action: 'import', name: 'Imported B', document: presetB },
    ]) {
      // The editor carries session context on the URL for global save/import actions.
      const result = await post(body, 's');
      const current = await new PresetStore(file).read();
      assert.equal(current.selectedPresetId, result.id);
      assert.equal(current.bindings.s.presetId, result.id);
      assert.equal(result.binding.presetId, result.id);
      assert.equal(current.bindings.other.presetId, 'A');
      assert.match(await send(), /^B:\d+:Alice$/);
    }
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
    await post({ revision: 3, action: 'save-deepseek-beta', enabled: true, forcePrefill: true, toolCalls: true, extractOutput: true, removeNonOfficialTools: false, postToolPrefixMode: 'custom', postToolPrefixText: 'Review results' });

    const reopened = await new PresetStore(file).read();
    assert.deepEqual(reopened.presets.map(item => item.name), ['A', 'B']);
    assert.equal(reopened.selectedPresetId, first.id);
    assert.equal(reopened.defaultPresetId, first.id);
    assert.equal(reopened.deepseekBetaPrefix, true);
    assert.equal(reopened.forcePrefill, true);
    assert.equal(reopened.prefixToolCalls, true);
    assert.equal(reopened.prefixOutputExtraction, true);
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

    for (const invalid of [{ postToolPrefixMode: 'unknown' }, { postToolPrefixText: null }, { forcePrefill: 'yes' }]) {
      const response = await postRaw({ revision: reopened.revision,
        action: 'save-deepseek-beta', enabled: true, ...invalid });
      assert.equal(response.statusCode, 400);
      assert.equal((await new PresetStore(file).read()).postToolPrefixText, 'Review results');
      assert.equal((await new PresetStore(file).read()).forcePrefill, true);
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

test('prefill detection ignores trailing placeholders instead of the assistant prefill', () => {
  // An empty marker or a blank prompt at the end of the order produces no message at all, so it must
  // not hide the assistant prefill in front of it. Tavern markers are content-bearing: chatHistory
  // stands for the conversation, which makes the final message the chat's rather than the preset's.
  const system = { identifier: 'sys', role: 'system', content: 'S' };
  const history = { identifier: 'chatHistory', marker: true, role: 'user' };
  const prefill = { identifier: 'prefix', role: 'assistant', content: '好的现在我是猫' };
  const presetOf = (order, prompts) => ({
    prompts,
    prompt_order: [{ character_id: 100001, order: order.map(identifier => ({ identifier, enabled: true })) }],
  });
  const chat = [msg('u', 'user', 'hello')];
  const cases = [
    ['trailing empty marker', presetOf(['sys', 'chatHistory', 'prefix', 'empty'], [system, history, prefill, { identifier: 'empty', role: 'system', marker: true }]), 'assistant'],
    ['prefill closes the order', presetOf(['sys', 'chatHistory', 'prefix'], [system, history, prefill]), 'assistant'],
    ['trailing blank content', presetOf(['sys', 'chatHistory', 'prefix', 'blank'], [system, history, prefill, { identifier: 'blank', role: 'system', content: '   ' }]), 'assistant'],
    ['trailing depth injection', presetOf(['sys', 'chatHistory', 'prefix', 'deep'], [system, history, prefill, { identifier: 'deep', role: 'system', content: 'deep', injection_position: 1 }]), 'assistant'],
    ['chatHistory closes the order', presetOf(['sys', 'prefix', 'chatHistory'], [system, prefill, history]), 'other'],
    ['trailing real system text', presetOf(['sys', 'chatHistory', 'prefix', 'tail'], [system, history, prefill, { identifier: 'tail', role: 'system', content: 'real' }]), 'other'],
    ['no chatHistory marker', presetOf(['sys', 'prefix'], [system, prefill]), 'other'],
  ];
  for (const [name, preset, expected] of cases) {
    assert.equal(lastContentRole(preset, 100001), expected, name);
    // The workbench badge and the request path must agree on every shape.
    assert.equal(compilePreset(preset, chat, { characterId: 100001 }).assistantPrefix.active, expected === 'assistant', name + ': compile');
  }

  // A marker does carry content when the caller supplies its text, so it can then be the final message.
  const marker = presetOf(['sys', 'chatHistory', 'prefix', 'worldInfoAfter'],
    [system, history, prefill, { identifier: 'worldInfoAfter', marker: true, role: 'system' }]);
  assert.equal(lastContentRole(marker, 100001), 'assistant');
  assert.equal(lastContentRole(marker, 100001, { worldInfoAfter: 'lore' }), 'other');
  assert.equal(compilePreset(marker, chat, { characterId: 100001, markers: { worldInfoAfter: 'lore' } }).assistantPrefix.active, false);
});

test('the forced prefill switch fills in the last assistant preset entry', () => {
  // Manual fallback: the order may close with system prompts or markers, so take the last assistant
  // entry the preset itself declares and move it to the end.
  const system = { identifier: 'sys', role: 'system', content: 'S' };
  const history = { identifier: 'chatHistory', marker: true, role: 'user' };
  const prefill = { identifier: 'prefix', role: 'assistant', content: '好的现在我是猫' };
  const presetOf = (order, prompts) => ({
    prompts,
    prompt_order: [{ character_id: 100001, order: order.map(identifier => ({ identifier, enabled: true })) }],
  });
  const chat = [msg('u', 'user', 'hello')];
  const trailing = presetOf(['sys', 'chatHistory', 'prefix', 'tail'],
    [system, history, prefill, { identifier: 'tail', role: 'system', content: '真正内容' }]);

  assert.equal(compilePreset(trailing, chat, { characterId: 100001 }).assistantPrefix.active, false);
  const forced = compilePreset(trailing, chat, { characterId: 100001, forcePrefill: true });
  assert.equal(forced.assistantPrefix.active, true);
  assert.deepEqual(forced.messages.map(message => message.role), ['system', 'user', 'system', 'assistant']);
  assert.match(forced.messages.at(-1).content[0].text, /好的现在我是猫/);
  assert.match(forced.warnings.join('\n'), /强制启用预填充/);

  // Assistant text a Tavern marker injects is never adopted as the prefill.
  const marked = presetOf(['sys', 'chatHistory', 'prefix', 'marker'],
    [system, history, prefill, { identifier: 'marker', marker: true, role: 'assistant' }]);
  const adopted = compilePreset(marked, chat, { characterId: 100001, forcePrefill: true, markers: { marker: '标记里的助手文本' } });
  assert.equal(adopted.assistantPrefix.active, true);
  assert.equal(adopted.messages.at(-1).content[0].text, '好的现在我是猫');

  // Nothing to adopt: the request stays ordinary.
  const noAssistant = presetOf(['sys', 'chatHistory', 'tail'],
    [system, history, { identifier: 'tail', role: 'system', content: 'x' }]);
  assert.equal(compilePreset(noAssistant, chat, { characterId: 100001, forcePrefill: true }).assistantPrefix.active, false);
});

test('the dynamic prefill marker supplies the trailing continuation instead of injecting in place', () => {
  // The one entry exempt from injection: its rendered text becomes the final assistant message, so
  // the prefill can change per request through the marker value without reordering the preset.
  const system = { identifier: 'sys', role: 'system', content: 'S' };
  const history = { identifier: 'chatHistory', marker: true, role: 'user' };
  const dynamic = { identifier: DYNAMIC_PREFILL_ID, marker: true, role: 'assistant', content: '默认续写' };
  const trailing = { identifier: 'tail', role: 'system', content: '结尾系统条目' };
  const preset = {
    prompts: [system, history, dynamic, trailing],
    prompt_order: [{ character_id: 100001, order: [system, history, dynamic, trailing]
      .map(prompt => ({ identifier: prompt.identifier, enabled: true })) }],
  };
  const chat = [msg('u', 'user', 'hello')];

  const fallback = compilePreset(preset, chat, { characterId: 100001 });
  assert.equal(fallback.assistantPrefix.active, true);
  assert.deepEqual(fallback.messages.map(message => message.role), ['system', 'user', 'system', 'assistant']);
  assert.equal(fallback.messages.at(-1).content[0].text, '默认续写');
  // The entry itself never appears where it sits in the order.
  assert.equal(fallback.messages.filter(message => message.content[0].text === '默认续写').length, 1);

  // Marker values drive it, so the continuation can differ per request.
  const first = compilePreset(preset, chat, { characterId: 100001, markers: { [DYNAMIC_PREFILL_ID]: '动态一' } });
  const second = compilePreset(preset, chat, { characterId: 100001, markers: { [DYNAMIC_PREFILL_ID]: '动态二' } });
  assert.equal(first.messages.at(-1).content[0].text, '动态一');
  assert.equal(second.messages.at(-1).content[0].text, '动态二');

  // It is appended after everything, so it outranks an earlier ordered assistant prompt.
  const overlapped = compilePreset({
    prompts: [system, history, { identifier: 'prefix', role: 'assistant', content: '前面的 assistant' }, dynamic],
    prompt_order: [{ character_id: 100001, order: ['sys', 'chatHistory', 'prefix', DYNAMIC_PREFILL_ID]
      .map(identifier => ({ identifier, enabled: true })) }],
  }, chat, { characterId: 100001, markers: { [DYNAMIC_PREFILL_ID]: '最终动态' } });
  assert.deepEqual(overlapped.messages.map(message => message.role), ['system', 'user', 'assistant', 'assistant']);
  assert.equal(overlapped.messages.at(-1).content[0].text, '最终动态');

  // Without text it contributes nothing at all.
  const emptied = compilePreset({
    prompts: [system, history, { ...dynamic, content: '' }, trailing],
    prompt_order: [{ character_id: 100001, order: ['sys', 'chatHistory', DYNAMIC_PREFILL_ID, 'tail']
      .map(identifier => ({ identifier, enabled: true })) }],
  }, chat, { characterId: 100001 });
  assert.equal(emptied.assistantPrefix.active, false);
  assert.deepEqual(emptied.messages.map(message => message.role), ['system', 'user', 'system']);

  // Detection agrees on every shape above.
  assert.equal(lastContentRole(preset, 100001), 'assistant');
  assert.equal(lastContentRole({ ...preset, prompts: [system, history, { ...dynamic, content: '' }, trailing] }, 100001), 'other');
});

test('the forced prefill switch persists on its own and rejects junk values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-force-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file);
    await store.transaction(state => { state.forcePrefill = 'yes'; });
    assert.equal((await new PresetStore(file).read()).forcePrefill, false, 'junk normalizes to false');
    await store.transaction(state => { state.forcePrefill = true; });
    assert.equal((await new PresetStore(file).read()).forcePrefill, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

  const extractingRegistry = new Map([['session-1', new Map([[
    prefix, { count: 1, extractOutput: true, removeNonOfficialTools: false },
  ]])]]);
  const extracting = rewriteDeepSeekPrefixFetch(endpoint, init, [extractingRegistry]);
  assert.deepEqual(extracting.responseTransform, {
    contentPrefix: '',
    reasoningPrefix: '',
    extractOutput: true,
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

test('the installed bridge rewrites a prefill the host passes as a Request object', async () => {
  // The host inspector normalizes every fetch call into `new Request(input, init)` before the
  // plugin bridge sees it. Reading only `init.body` therefore saw no body at all and silently
  // skipped the rewrite, so no prefix ever reached the beta endpoint.
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => { calls.push({ input, init }); return { ok: true, status: 200 }; };
  globalThis.fetch = stub;
  try {
    const controller = installDeepSeekBetaBridge({ effect: fn => { fn(); } });
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '<think>\ncontinue' }],
      tools: [{ type: 'function', function: { name: 'noop' } }] });
    const request = new Request('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 's' }, body,
    });
    const release = controller.activate('s', '<think>\ncontinue', { removeNonOfficialTools: true });
    await globalThis.fetch(request);
    assert.equal(calls.length, 1);
    // The rewrite reached the official beta endpoint and carried the continuation flag.
    assert.equal(String(calls[0].input), 'https://api.deepseek.com/beta/chat/completions');
    const rewritten = JSON.parse(calls[0].init.body);
    assert.equal(rewritten.messages.at(-1).prefix, true);
    assert.equal(rewritten.tools, undefined);

    release();
    // Without an activation the caller's own request object is forwarded untouched.
    await globalThis.fetch(request);
    assert.equal(calls[1].input, request);

    controller.dispose();
    assert.equal(globalThis.fetch, stub);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('the installed bridge reads every BodyInit shape the host may pass', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => { calls.push({ input, init }); return { ok: true, status: 200 }; };
  globalThis.fetch = stub;
  try {
    const controller = installDeepSeekBetaBridge({ effect: fn => { fn(); } });
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'continue' }],
      tools: [{ type: 'function', function: { name: 'noop' } }] });
    const url = 'https://api.deepseek.com/chat/completions';
    const headers = { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 's' };
    const encoded = () => new TextEncoder().encode(body);
    const shapes = {
      Uint8Array: () => encoded(),
      ArrayBuffer: () => encoded().buffer,
      Blob: () => new Blob([body]),
      ReadableStream: () => new ReadableStream({ start(controller) { controller.enqueue(encoded()); controller.close(); } }),
    };
    const release = controller.activate('s', 'continue', { removeNonOfficialTools: true });
    for (const [name, make] of Object.entries(shapes)) {
      calls.length = 0;
      await globalThis.fetch(url, { method: 'POST', headers, body: make() });
      assert.equal(calls.length, 1, name + ': should reach the transport');
      assert.equal(String(calls[0].input), 'https://api.deepseek.com/beta/chat/completions', name + ': should switch to beta');
      const rewritten = JSON.parse(calls[0].init.body);
      assert.equal(rewritten.messages.at(-1).prefix, true, name + ': should carry the prefix flag');
      assert.equal(rewritten.tools, undefined, name + ': should drop native tools');
    }
    release();
    // A body nobody had to consume keeps the caller's own init object; a consumed one is forwarded
    // from the normalized pair, because the original stream is gone.
    calls.length = 0;
    const init = { method: 'POST', headers, body };
    await globalThis.fetch(url, init);
    assert.equal(calls[0].init, init, 'an untouched body keeps the caller init object');
    calls.length = 0;
    await globalThis.fetch(url, { method: 'POST', headers, body: new Blob([body]) });
    assert.equal(typeof calls[0].init.body, 'string', 'a consumed body is forwarded as text');
    assert.equal(JSON.parse(calls[0].init.body).messages.at(-1).prefix, undefined);
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
    assert.equal((await send(toolHistory)).messages.at(-1).reasoning_content, 'Updated continuation');
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

    await store.transaction(state => { state.presets[0].preset.dsh_prefill_target = 'content'; });
    const bodyPrefix = (await send()).messages.at(-1);
    assert.equal(bodyPrefix.content, '<think>\n继续', 'explicit body target preserves the exact prefix');
    assert.equal(bodyPrefix.reasoning_content, '');

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

/* ------------------------------------------------- compaction checkpoints (proposal A) */

const checkpoint = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint', compactionId: id } });

test('a compaction checkpoint is not treated as the latest user message', () => {
  const preset = { prompts: [
    { identifier: 'p', role: 'system', content: 'last={{lastusermessage}}' },
  ] };
  // Real user turn first, checkpoint last: the macro must read what the user wrote.
  const withUser = compilePreset(preset, [msg('u', 'user', '真实提问'), checkpoint('c1', '这是模型写的摘要')]);
  assert.equal(withUser.messages[0].content[0].text, 'last=真实提问');
  // Only a checkpoint: there is no user-authored turn, so the macro must not surface the summary.
  const onlyCheckpoint = compilePreset(preset, [checkpoint('c1', '这是模型写的摘要')]);
  assert.equal(onlyCheckpoint.messages[0].content[0].text, 'last=');
  // The checkpoint itself still reaches the model through history.
  assert.equal(onlyCheckpoint.messages.some(m => JSON.stringify(m).includes('这是模型写的摘要')), true);
});

test('a message whose text merely contains the marker word is still a real user turn', () => {
  const preset = { prompts: [{ identifier: 'p', role: 'system', content: 'last={{lastusermessage}}' }] };
  const spoken = msg('u', 'user', '我说了 compact-checkpoint 这个词');
  assert.equal(compilePreset(preset, [spoken]).messages[0].content[0].text, 'last=我说了 compact-checkpoint 这个词');
});

test('history edits refuse to rewrite a compaction checkpoint', () => {
  const target = checkpoint('c1', '摘要正文');
  // Validation rejects the patch with a clear reason rather than silently rewriting it.
  assert.throws(() => validateHistoryPatches({ patches: [{ operation: 'replace-text', depth: 0, text: '篡改', textIndex: 0 }] }, [target]),
    /压缩检查点/);
  // Insertions next to a checkpoint are unaffected.
  const insertion = validateHistoryPatches({ patches: [{ operation: 'insert', depth: 1, role: 'user', text: '插入' }] }, [target]);
  assert.equal(insertion.length, 1);
});

test('prompt regex never rewrites a compaction checkpoint', () => {
  const preset = { prompts: [], extensions: { 'dsh-preset-enhance': { promptRegex: { enabled: true, scripts: [
    { scriptName: 'rewrite', findRegex: '/摘要/u', replaceString: '改掉', placement: [1], disabled: false, markdownOnly: false, promptOnly: true, runOnEdit: false, substituteRegex: 0 },
  ] } } } };
  const compiled = compilePreset(preset, [checkpoint('c1', '摘要正文'), msg('u', 'user', '摘要正文')], { seed: 's' });
  const serialized = JSON.stringify(compiled.messages);
  // The user's own message may be rewritten; the checkpoint's copy must remain intact.
  assert.equal(serialized.includes('摘要正文'), true, 'the checkpoint text survives');
});
