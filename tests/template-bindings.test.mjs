import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTemplate, templateFingerprint, templateBindings } from '../lib/template-bindings.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { encodePresetPackage, decodePresetDocument } from '../lib/preset-package.mjs';
import { PresetStore } from '../lib/store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const template = { id: 'format', version: '1', title: 'Format', role: 'assistant', content: '{{user}}:', defaults: { placement: 'afterHistory' } };
const catalog = (t = template) => ({ contractVersion: 1, revision: 1, providers: [{ providerId: 'test', title: 'Test', templates: [t] }] });
const selection = (t = template) => ({ operation: 'add', providerId: 'test', templateId: t.id, templateVersion: t.version, expectedFingerprint: templateFingerprint(t) });
const history = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

test('selection persists snapshot and fixed version; history-after templates become assistant prefix', () => {
  const original = { prompts: [], extensions: { other: { keep: true } } };
  const { preset, identifier } = selectTemplate(original, catalog(), selection());
  assert.deepEqual(original.prompts, []);
  assert.equal(preset.extensions.other.keep, true);
  assert.deepEqual(preset.prompt_order[0].order.map(r => r.identifier), ['chatHistory', identifier]);
  const compiled = compilePreset(preset, history, { templateCatalog: catalog(), values: { user: 'Alice' } });
  assert.deepEqual(compiled.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(compiled.messages[1].content[0].text, 'Alice:');
  assert.equal(compiled.assistantPrefix.active, true);
  preset.prompt_order[0].order[1].enabled = false;
  const duplicate = selectTemplate(preset, catalog(), selection());
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.identifier, identifier);
  assert.deepEqual(compilePreset(duplicate.preset, history, { templateCatalog: catalog() }).messages, history);
});

test('missing or changed versions skip snapshot; update/detach preserve placement, toggles, locks', () => {
  const { preset, identifier } = selectTemplate({ prompts: [] }, catalog(), selection());
  const missing = compilePreset(preset, history);
  assert.deepEqual(missing.messages, history);
  assert.match(missing.warnings.join(), /已跳过/);
  const altered = { ...template, content: 'different' };
  assert.deepEqual(compilePreset(preset, history, { templateCatalog: catalog(altered) }).messages, history);
  preset.prompts.find(p => p.identifier === identifier).injection_position = 1;
  preset.prompts.find(p => p.identifier === identifier).injection_depth = 2;
  const next = { ...template, version: '2', content: 'new' };
  const update = { ...selection(next), operation: 'update', identifier };
  assert.throws(() => selectTemplate(preset, catalog(next), update, [identifier]), /锁定/);
  const changed = selectTemplate(preset, catalog(next), update).preset;
  assert.equal(changed.prompts[0].injection_depth, 2);
  assert.deepEqual(changed.prompt_order, preset.prompt_order);
  assert.equal(templateBindings(changed)[identifier].templateVersion, '2');
  const detached = selectTemplate(changed, catalog(next), { operation: 'detach', identifier }).preset;
  assert.deepEqual(templateBindings(detached), {});
  assert.ok(compilePreset(detached, history).messages.some(m => m.content[0]?.text === 'new'));
  assert.throws(() => selectTemplate(preset, catalog(next), { ...selection(next), expectedFingerprint: 'stale' }), /目录已变化/);
});

test('depth and beforeHistory defaults use regular compiler ordering; disabled missing bindings stay quiet', () => {
  const depth = { ...template, role: 'system', content: 'depth', defaults: { placement: 'depth', depth: 1, order: 12 } };
  const { preset } = selectTemplate({ prompts: [] }, catalog(depth), selection(depth));
  assert.equal(preset.prompts[0].injection_order, 12);
  assert.deepEqual(compilePreset(preset, history, { templateCatalog: catalog(depth) }).messages.map(m => m.content[0].text), ['depth', 'hello']);
  preset.prompt_order[0].order[0].enabled = false;
  assert.deepEqual(compilePreset(preset, history).warnings, []);
});

test('single-file share and store reload retain references and source snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'template-share-'));
  const store = new PresetStore(join(dir, 'state.json'));
  try {
    const { preset } = selectTemplate({ prompts: [] }, catalog(), selection());
    await store.transaction(state => { state.presets.push({ id: 'p', name: 'Example', preset }); });
    const state = await store.read();
    const packed = encodePresetPackage(state.presets[0], state);
    const decoded = decodePresetDocument(JSON.parse(JSON.stringify(packed)));
    assert.deepEqual(templateBindings(decoded.preset), templateBindings(preset));
    assert.deepEqual(decoded.preset.prompts, preset.prompts);
    assert.deepEqual((await new PresetStore(store.file).read()).presets[0].preset, preset);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
