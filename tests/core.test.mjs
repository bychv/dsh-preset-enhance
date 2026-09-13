import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { PresetStore } from '../lib/store.mjs';
import { AGENT_PRESET_ID, apply, ensurePresetAgentMode } from '../index.mjs';

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
test('sample: both groups compile; active macros are fully resolved; extensions unchanged', async () => {
  const preset = JSON.parse(await readFile(new URL('../sample/夏瑾 天琴座 V2 Beta 1.0.json', import.meta.url), 'utf8'));
  const original = JSON.stringify(preset);
  for (const characterId of [100000, 100001]) {
    const result = compilePreset(preset, [msg('u', 'user', '测试消息')], { characterId });
    assert.equal(result.messages.some(m => /\{\{/.test(m.content[0]?.text)), false);
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
test('new conversations in preset mode inherit and then pin the mode default preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-auto-'));
  try {
    const file = join(dir, 'state.json'), store = new PresetStore(file), listeners = {}, calls = [];
    await store.transaction(s => {
      s.presets.push({ id: 'default', name: 'Default', preset: { prompts: [{ identifier: 'a', role: 'system', content: 'MODE' }] } });
      s.defaultPresetId = 'default';
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
    assert.equal(calls[0].messages[0].content[0].text, 'MODE');
    assert.deepEqual(calls[0].messages.map(x => x.content[0].text), ['MODE', 'hello']);
    assert.equal(Object.hasOwn(calls[0], 'tools'), false);
    assert.equal(calls[1].messages.length, 3); assert.equal(calls[1].tools[0].name, 'shell');
    assert.deepEqual((await store.read()).bindings.auto, { enabled: true, presetId: 'default', characterId: null, values: {}, markers: {} });
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
