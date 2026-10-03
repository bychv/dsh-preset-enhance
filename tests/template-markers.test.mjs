import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTemplate, templateFingerprint, resolveTemplateBindings } from '../lib/template-bindings.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { createTemplateRegistry } from '../lib/template-registry.mjs';

const template = { id: 'character', version: '1', title: '角色描述', role: 'assistant', content: '角色：{{char}}', targetMarker: 'charDescription' };
const catalog = (t = template) => ({ contractVersion: 1, revision: 1, providers: [{ providerId: 'addon', title: 'Addon', templates: [t] }] });
const selection = (t = template) => ({ operation: 'bind-marker', identifier: 'charDescription', providerId: 'addon', templateId: t.id, templateVersion: t.version, expectedFingerprint: templateFingerprint(t) });
const original = () => ({ prompts: [{ identifier: 'charDescription', marker: true, role: 'system', content: '原始字段', injection_position: 0 }, { identifier: 'chatHistory', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'charDescription', enabled: true }] }] });
const history = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
test('marker binding overrides the request copy and preserves source, role, order and toggles', () => {
  const source = original(), bound = selectTemplate(source, catalog(), selection()).preset;
  assert.deepEqual(bound.prompts, source.prompts); assert.deepEqual(bound.prompt_order, source.prompt_order);
  const output = compilePreset(bound, history, { templateCatalog: catalog(), values: { char: 'Example' }, markers: { charDescription: 'OLD' } });
  assert.deepEqual(output.messages.map(m => m.role), ['user', 'system']);
  assert.equal(output.messages[1].content[0].text, '角色：Example');
  assert.equal(bound.prompts[0].marker, true);
  bound.prompt_order[0].order[1].enabled = false;
  assert.deepEqual(compilePreset(bound, history, { templateCatalog: catalog() }).messages, history);
});
test('missing/changed marker providers skip old content, reloading invalidates references, detach restores marker', () => {
  const bound = selectTemplate(original(), catalog(), selection()).preset;
  const options = { markers: { charDescription: 'RESTORED' } };
  assert.deepEqual(compilePreset(bound, history, options).messages, history);
  const changed = { ...template, content: 'CHANGED' };
  assert.deepEqual(compilePreset(bound, history, { ...options, templateCatalog: catalog(changed) }).messages, history);
  assert.notDeepEqual(resolveTemplateBindings(bound, catalog()).references, resolveTemplateBindings(bound).references);
  const detached = selectTemplate(bound, catalog(), { operation: 'detach', identifier: 'charDescription' }).preset;
  assert.deepEqual(detached.prompts, original().prompts);
  assert.equal(compilePreset(detached, history, options).messages[1].content[0].text, 'RESTORED');
  const next = { ...template, version: '2', content: 'NEXT' };
  const updated = selectTemplate(bound, catalog(next), { ...selection(next), operation: 'update' }).preset;
  assert.equal(compilePreset(updated, history, { templateCatalog: catalog(next) }).messages[1].content[0].text, 'NEXT');
});
test('marker binding refuses history, ordinary prompts, locks, and mismatched target; registry keeps target', () => {
  assert.throws(() => selectTemplate(original(), catalog(), { ...selection(), identifier: 'chatHistory' }), /marker/);
  assert.throws(() => selectTemplate(original(), catalog(), selection(), ['charDescription']), /锁定/);
  const ordinary = original(); ordinary.prompts[0].marker = false;
  assert.throws(() => selectTemplate(ordinary, catalog(), selection()), /marker/);
  assert.throws(() => selectTemplate(original(), catalog(), { ...selection(), operation: 'add' }), /marker/);
  const other = { ...template, targetMarker: 'worldInfoBefore' };
  assert.throws(() => selectTemplate(original(), catalog(other), selection(other)), /marker/);
  const registry = createTemplateRegistry(); const owner = { effect: setup => setup() };
  registry.service.register(owner, { providerId: 'addon', title: 'Addon', templates: [template] });
  assert.equal(registry.service.list().providers[0].templates[0].targetMarker, 'charDescription');
  assert.throws(() => registry.service.register(owner, { providerId: 'bad', title: 'Bad', templates: [{ ...template, targetMarker: 'chatHistory' }] }), /聊天记录/);
  registry.close();
});
