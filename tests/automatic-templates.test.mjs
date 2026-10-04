import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplateRegistry } from '../lib/template-registry.mjs';
import { templateBindings, selectTemplate } from '../lib/template-bindings.mjs';
import { prepareDynamicTemplates } from '../lib/dynamic-templates.mjs';
import { compilePreset } from '../lib/preset.mjs';
const owner = { effect: setup => setup() };
const source = () => ({ prompts: [{ identifier: 'charDescription', marker: true, role: 'system' }, { identifier: 'chatHistory', marker: true }] });
const definition = (content = 'automatic') => ({ providerId: 'one', title: 'One', templates: [{ id: 't', version: '1', title: 'Template', role: 'system', content, targetMarker: 'charDescription' }] });
const compile = (registry, preset) => compilePreset(preset, [], { templateCatalog: registry.service.list(), markers: { charDescription: 'original' } });

test('unique targets auto-bind, collisions retain original, manual selection and opt-out persist', () => {
  const r = createTemplateRegistry();
  try {
    r.service.register(owner, definition());
    const preset = source(), saved = structuredClone(preset);
    assert.equal(compile(r, preset).messages[0].content[0].text, 'automatic');
    assert.deepEqual(preset, saved);
    const ref = templateBindings(preset, r.service.list()).charDescription;
    const pinned = selectTemplate(preset, r.service.list(), { operation: 'bind-marker', identifier: 'charDescription', ...ref, expectedFingerprint: ref.fingerprint }).preset;
    const second = r.service.register(owner, { ...definition('other'), providerId: 'two' });
    assert.equal(compile(r, preset).messages[0].content[0].text, 'original');
    assert.match(compile(r, preset).warnings.join(), /冲突/);
    assert.equal(compile(r, pinned).messages[0].content[0].text, 'automatic');
    second.dispose();
    const detached = selectTemplate(preset, r.service.list(), { operation: 'detach', identifier: 'charDescription' }).preset;
    assert.equal(compile(r, detached).messages[0].content[0].text, 'original');
    const restored = selectTemplate(detached, r.service.list(), { operation: 'restore-auto', identifier: 'charDescription' }).preset;
    assert.equal(compile(r, restored).messages[0].content[0].text, 'automatic');
  } finally { r.close(); }
});

test('hot reload replaces automatic content and invalidates pinned fingerprints without changing source', () => {
  const r = createTemplateRegistry();
  try {
    const p = source(); const old = r.service.register(owner, definition());
    const ref = templateBindings(p, r.service.list()).charDescription;
    const pinned = selectTemplate(p, r.service.list(), { operation: 'bind-marker', identifier: 'charDescription', ...ref, expectedFingerprint: ref.fingerprint }).preset;
    old.dispose(); assert.equal(compile(r, p).messages[0].content[0].text, 'original');
    r.service.register(owner, definition('reloaded'));
    assert.equal(compile(r, p).messages[0].content[0].text, 'reloaded');
    assert.match(compile(r, pinned).warnings.join(), /同版本内容已变化/);
  } finally { r.close(); }
});

test('automatic history resolvers obey order toggles and switch to the new scope after reload', async () => {
  const r = createTemplateRegistry(); let calls = 0;
  const register = text => r.service.register(owner, { providerId: 'history', title: 'History', templates: [{ id: 'h', version: '1', title: 'History', role: 'system', content: '', targetMarker: 'chatHistory', dynamic: { resolverId: 'h', input: 'history', output: 'history-patches' } }] }, { resolvers: { h: () => { calls++; return { patches: [{ operation: 'insert', depth: 0, role: 'system', text }] }; } } });
  const p = source();
  const prepare = () => prepareDynamicTemplates(r, p, [], { purpose: 'request' });
  try {
    const old = register('old');
    let out = await prepare(); assert.equal(out.bodies.chatHistory.patches[0].text, 'old');
    old.dispose(); register('new');
    out = await prepare(); assert.equal(out.bodies.chatHistory.patches[0].text, 'new');
    p.prompts[1].enabled = false; await prepare(); assert.equal(calls, 2);
    p.prompts[1].enabled = true;
    const configured = selectTemplate(p, r.service.list(), { operation: 'configure', identifier: 'chatHistory', config: { a: 1 }, failurePolicy: 'skip' }).preset;
    assert.equal(templateBindings(configured).chatHistory.automatic, true);
    assert.deepEqual(templateBindings(configured).chatHistory.config, { a: 1 });
  } finally { r.close(); }
});

test('plugin scope disable/enable refreshes bindings and aborts only the old resolver lease', async () => {
  const r = createTemplateRegistry(); let setup, cleanup;
  const scope = { effect(fn) { setup = fn; cleanup = fn(); } };
  const revisions = []; r.service.subscribe(revision => revisions.push(revision));
  try {
    r.service.register(scope, definition());
    const preset = source();
    const disabled = selectTemplate(preset, r.service.list(), { operation: 'detach', identifier: 'charDescription' }).preset;
    await Promise.resolve(); const staleCleanup = cleanup;
    cleanup(); await Promise.resolve();
    assert.equal(compile(r, preset).messages[0].content[0].text, 'original');
    cleanup = setup(); await Promise.resolve(); staleCleanup();
    assert.equal(compile(r, preset).messages[0].content[0].text, 'automatic');
    assert.equal(compile(r, disabled).messages[0].content[0].text, 'original');
    assert.deepEqual(revisions, [1, 2, 3]);
  } finally { cleanup?.(); r.close(); }
});
