import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplateRegistry } from '../lib/template-registry.mjs';
import { prepareDynamicTemplates } from '../lib/dynamic-templates.mjs';
import { selectTemplate, templateFingerprint } from '../lib/template-bindings.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { validateHistoryPatches } from '../lib/history-patches.mjs';

const message = (id, text, role = 'user') => ({ id, role, content: [{ type: 'text', text }] });
function fixture(run) {
  const registry = createTemplateRegistry();
  const template = { id: 'history', version: '1', title: '历史修改', role: 'system', content: '', targetMarker: 'chatHistory',
    dynamic: { resolverId: 'read', input: 'history', output: 'history-patches' } };
  const registration = registry.service.register({ effect: f => f() }, { providerId: 'example', title: 'Example', templates: [template] }, { resolvers: { read: run } });
  const selection = { operation: 'bind-marker', identifier: 'chatHistory', providerId: 'example', templateId: 'history', templateVersion: '1', expectedFingerprint: templateFingerprint(registry.service.list().providers[0].templates[0]) };
  const source = { prompts: [{ identifier: 'before', content: 'before' }, { identifier: 'chatHistory', marker: true, role: 'user' }, { identifier: 'after', content: 'after' }] };
  const preset = selectTemplate(source, registry.service.list(), selection).preset;
  return { registry, registration, preset, selection, async compile(history, purpose = 'request') {
    const prepared = await prepareDynamicTemplates(registry, preset, history, { purpose });
    return compilePreset(preset, history, { templateCatalog: prepared.catalog, dynamicBodies: prepared.bodies });
  } };
}

test('history patches use original depth and text block coordinates, preserve attachments and remain literal', async () => {
  const f = fixture(ctx => {
    assert.ok(Object.isFrozen(ctx.history[0].content));
    return { patches: [
      { operation: 'insert', depth: 1, role: 'system', text: 'context' },
      { operation: 'replace-text', depth: 1, textIndex: 1, text: '{{setglobalvar::unsafe::1}}' },
      { operation: 'append-text', depth: 0, text: ' suffix' },
      { operation: 'insert', depth: 1, role: 'user', text: 'same boundary' },
      { operation: 'insert', depth: 100, role: 'system', text: 'oldest' },
      { operation: 'insert', depth: 0, role: 'system', text: 'newest' },
    ] };
  });
  try {
    const history = [message('a', 'first'), message('b', 'last')];
    history[0].content.push({ type: 'image', url: 'attachment' }, { type: 'text', text: 'second' });
    const original = structuredClone(history), saved = structuredClone(f.preset);
    const out = await f.compile(history);
    assert.deepEqual(out.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('|')),
      ['before', 'oldest', 'first|{{setglobalvar::unsafe::1}}', 'context', 'same boundary', 'last suffix', 'newest', 'after']);
    assert.deepEqual(out.messages[2].content[1], history[0].content[1]);
    assert.equal(out.global.unsafe, undefined);
    assert.deepEqual(history, original); assert.deepEqual(f.preset, saved);
    assert.deepEqual((await f.compile(history, 'preview')).messages, out.messages);
  } finally { f.registry.close(); }
});

test('insertions never split parallel calls and results, including role-only tool messages', async () => {
  const f = fixture(() => ({ patches: [{ operation: 'insert', depth: 1, role: 'system', text: 'context' },
    { operation: 'append-text', depth: 2, text: 'annotation' }] }));
  try {
    const call = { id: 'call', role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'echo', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'echo', arguments: '{}' }] };
    const history = [message('u', 'hello'), call, message('a', 'a result', 'tool'), message('b', 'b result', 'tool')];
    const out = await f.compile(history);
    assert.equal(out.messages[2].content[0].text, 'context');
    assert.equal(out.messages[3].id, 'call');
    assert.deepEqual(out.messages[3].content.slice(0, 2), call.content);
    assert.equal(out.messages[3].content[2].text, 'annotation');
    assert.equal(out.messages[4], history[2]); assert.equal(out.messages[5], history[3]);
    assert.match(out.warnings.join(), /配对/);
  } finally { f.registry.close(); }
});

test('invalid batches abort atomically or skip while keeping history and its boundary', async () => {
  const f = fixture(() => ({ patches: [{ operation: 'insert', depth: 0, role: 'system', text: 'must not leak' }, { operation: 'replace-text', depth: 99, text: 'bad' }] }));
  try {
    const history = [message('a', 'original')];
    await assert.rejects(f.compile(history), /目标不存在/);
    f.preset.extensions['dsh-preset-enhance'].templateBindings.chatHistory.failurePolicy = 'skip';
    for (const present of [true, false]) {
      if (!present) f.registration.dispose();
      const out = await f.compile(history);
      assert.deepEqual(out.messages.map(m => m.content[0].text), ['before', 'original', 'after']);
      assert.match(out.warnings.join(), /已跳过/);
    }
  } finally { f.registry.close(); }
});

test('history bindings respect toggle, triggers and detach; cannot silently bind text templates', async () => {
  let calls = 0;
  const f = fixture(() => { calls++; return { patches: [] }; });
  try {
    const p = f.preset.prompts.find(p => p.identifier === 'chatHistory');
    p.enabled = false; await f.compile([]);
    p.enabled = true; p.injection_trigger = ['continue']; await f.compile([]);
    delete p.injection_trigger; await f.compile([]); assert.equal(calls, 1);
    const detached = selectTemplate(f.preset, f.registry.service.list(), { operation: 'detach', identifier: 'chatHistory' }).preset;
    assert.deepEqual(detached.prompts, f.preset.prompts);
    assert.equal(detached.extensions['dsh-preset-enhance'].templateBindings.chatHistory, undefined);
    assert.equal(f.registry.service.capabilities.historyPatchesV1, true);
  } finally { f.registry.close(); }
});

test('history output declaration and result shapes are validated, tool results cannot be rewritten', () => {
  const registry = createTemplateRegistry();
  try {
    for (const extra of [{ targetMarker: undefined }, { dynamic: { resolverId: 'read', input: 'latest-user', output: 'history-patches' } }, { content: 'lost text' }]) {
      assert.throws(() => registry.service.register({ effect: f => f() }, { providerId: 'bad', title: 'Bad', templates: [{ id: 'h', version: '1', title: 'History', role: 'system', content: '', targetMarker: 'chatHistory', dynamic: { resolverId: 'read', input: 'history', output: 'history-patches' }, ...extra }] }, { resolvers: { read: () => ({ patches: [] }) } }), /历史修改/);
    }
    const history = [message('u', 'x'), message('t', 'result', 'tool')];
    for (const patch of [
      { operation: 'replace-text', depth: 0, text: 'no' },
      { operation: 'insert', depth: -1, role: 'user', text: 'no' },
      { operation: 'insert', depth: 0, role: 'tool', text: 'no' },
      { operation: 'replace-text', depth: 1, text: 'no', textIndex: 2 },
      { operation: 'insert', depth: 0, role: 'system', text: 'no', content: [] },
    ]) assert.throws(() => validateHistoryPatches({ patches: [patch] }, history));
    assert.throws(() => validateHistoryPatches({ patches: Array(257).fill({}) }, history));
    assert.throws(() => validateHistoryPatches({ patches: [{ operation: 'insert', depth: 0, role: 'system', text: 'x'.repeat(200001) }] }, history));
  } finally { registry.close(); }
});
