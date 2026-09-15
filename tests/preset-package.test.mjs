import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../index.mjs';
import { PresetStore } from '../lib/store.mjs';
import { decodePresetDocument, encodePresetPackage, attachPrefillSettings,
  applyPackagePrefill, validatePresetPackage } from '../lib/preset-package.mjs';

const prompt = () => ({
  prompts: [{ identifier: 'chatHistory', role: 'user', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
  assistant_prefill: '<think>\n{{getvar::plan}}',
  extensions: { opaque: { keep: true } },
});
const settings = () => ({
  deepseekBetaPrefix: true, prefixToolCalls: true, prefixNonOfficialRemoveTools: false,
  postToolPrefixMode: 'custom', postToolPrefixText: '<think>\nReview {{lastmessage}}',
});
const packet = () => encodePresetPackage({ name: 'Shared draft', preset: prompt() }, settings());

function futurePacket() {
  const document = packet();
  document.future = { revision: 'retained' };
  document.metadata.description = 'description';
  document.preset.future = ['preset extension'];
  document.prefill.future = { enabled: true };
  document.prefill.postToolPrefix.future = ['prefix extension'];
  document.tools = {
    version: 7, activePresetId: 'p',
    presets: [{ id: 'p', groupIds: ['g'], rules: [
      { modeId: 'external-mode', toolName: 'external-tool', enabled: true },
    ], future: { value: 1 } }],
    groups: [{ id: 'g', members: [{ modeId: 'external-mode', toolName: 'external-tool' }] }],
    future: { untouched: true },
  };
  document.extensions = { 'external-plugin': { data: 'opaque' } };
  return document;
}

test('single-file packages retain prompts, macro source and prefill without copying local state', () => {
  const local = { ...settings(), apiKey: 'LOCAL_ONLY', sessions: { secret: 'LOCAL_ONLY' }, global: { key: 'LOCAL_ONLY' } };
  const document = encodePresetPackage({ id: 'local-id', name: 'Draft', preset: prompt() }, local);
  assert.equal(document.format, 'dsh-preset-enhance');
  assert.equal(document.version, 1);
  assert.deepEqual(document.preset.data, prompt());
  assert.equal(document.prefill.postToolPrefix.text, '<think>\nReview {{lastmessage}}');
  assert.deepEqual(document.tools, { version: 1, activePresetId: null, presets: [], groups: [] });
  assert.doesNotMatch(JSON.stringify(document), /LOCAL_ONLY|local-id/);
  const decoded = decodePresetDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(decoded.preset, prompt());
  assert.deepEqual(encodePresetPackage(decoded, {}), document);
  const legacy = { ...prompt(), format: 'legacy-extra-field' };
  assert.deepEqual(decodePresetDocument(legacy, 'Legacy'), { name: 'Legacy', preset: legacy });
});

test('editing a package preserves unknown fields and reserved plugin tool groups', () => {
  const source = futurePacket(), original = structuredClone(source);
  const record = decodePresetDocument(source);
  record.name = 'Renamed';
  record.preset.assistant_prefill = 'Edited';
  const saved = encodePresetPackage(record, {});
  const expected = structuredClone(original);
  expected.metadata.name = 'Renamed';
  expected.preset.data.assistant_prefill = 'Edited';
  assert.deepEqual(saved, expected);
  assert.deepEqual(source, original);
  attachPrefillSettings(record, { ...settings(), postToolPrefixText: 'New' });
  assert.equal(record.sharePackage.prefill.postToolPrefix.text, 'New');
  assert.deepEqual(record.sharePackage.prefill.future, original.prefill.future);
  assert.deepEqual(record.sharePackage.prefill.postToolPrefix.future, original.prefill.postToolPrefix.future);
  assert.deepEqual(record.sharePackage.tools, original.tools);
  const state = { modeToolPolicies: { standard: { existing: false } } };
  applyPackagePrefill(state, record);
  assert.equal(state.postToolPrefixText, 'New');
  assert.deepEqual(state.modeToolPolicies, { standard: { existing: false } });
});

test('unsupported versions and malformed packages fail without ST fallback', () => {
  assert.throws(() => decodePresetDocument({ ...packet(), version: 2, prompts: [] }), /版本/);
  assert.throws(() => decodePresetDocument({ ...packet(), version: '1' }), /版本/);
  assert.throws(() => decodePresetDocument({ ...packet(), format: 'other-package' }), /格式/);
  for (const invalid of [
    { metadata: [] }, { tools: [] }, { tools: { groups: {} } },
    { tools: { presets: null } }, { extensions: [] },
    { prefill: { ...packet().prefill, enabled: 'true' } },
    { prefill: { ...packet().prefill, postToolPrefix: { mode: 'other', text: '' } } },
    { preset: { format: 'other', data: prompt() } },
  ]) assert.throws(() => validatePresetPackage({ ...packet(), ...invalid }));
  const withoutPrefill = { ...packet(), prefill: null };
  assert.deepEqual(encodePresetPackage(decodePresetDocument(withoutPrefill), settings()), withoutPrefill);
  assert.throws(() => applyPackagePrefill({}, decodePresetDocument(withoutPrefill)), /未附带/);
});

test('package API imports, edits and exports durably; applies settings only on explicit action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-package-'));
  const file = join(dir, 'state.json'), store = new PresetStore(file), disposers = [];
  let handler;
  try {
    const ctx = {
      sessions: { get: () => undefined }, on: () => {},
      effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
      webServer: { register: definition => {
        if (definition.path === '/preset-enhance/api') handler = definition.handler;
        return () => {};
      } },
    };
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    const request = async (body, code = 200) => {
      const revision = (await store.read()).revision;
      const req = Readable.from(body ? [JSON.stringify({ revision, ...body })] : []);
      req.method = body ? 'POST' : 'GET'; req.url = '/preset-enhance/api';
      req.headers = { 'content-type': 'application/json', host: 'localhost' };
      let status, result;
      await handler(req, { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } });
      assert.equal(status, code, result?.error);
      return result;
    };
    const source = futurePacket();
    const { id } = await request({ action: 'import', document: source, name: 'filename' });
    const imported = await store.read();
    assert.equal(imported.selectedPresetId, id);
    assert.equal(imported.deepseekBetaPrefix, false);
    assert.deepEqual(imported.modeToolPolicies, {});
    assert.deepEqual((await request()).presets[0].sharePackage, source);
    const exported = await request({ action: 'export-package', id });
    assert.deepEqual(exported, source);
    assert.equal((await store.read()).revision, imported.revision);
    await request({ action: 'save', id, name: 'Edited', preset: { ...prompt(), assistant_prefill: 'Changed' } });
    const edited = await request({ action: 'export-package', id });
    assert.equal(edited.metadata.name, 'Edited');
    assert.equal(edited.preset.data.assistant_prefill, 'Changed');
    assert.deepEqual(edited.tools, source.tools);
    assert.deepEqual(edited.extensions, source.extensions);
    await request({ action: 'apply-package-prefill', id });
    assert.equal((await store.read()).postToolPrefixText, source.prefill.postToolPrefix.text);
    await request({ action: 'save-deepseek-beta', presetId: id, enabled: true,
      postToolPrefixMode: 'custom', postToolPrefixText: 'Updated' });
    const updated = await request({ action: 'export-package', id });
    assert.equal(updated.prefill.postToolPrefix.text, 'Updated');
    assert.deepEqual(updated.tools, source.tools);
    assert.deepEqual(updated.prefill.future, source.prefill.future);
    assert.deepEqual(updated.prefill.postToolPrefix.future, source.prefill.postToolPrefix.future);
    assert.deepEqual((await store.read()).sessionToolPolicies, {});
    const before = await store.read();
    await request({ action: 'import', document: { ...source, version: 2 } }, 400);
    await request({ action: 'save-deepseek-beta', presetId: 'missing', enabled: false }, 400);
    assert.deepEqual(await store.read(), before);
    const legacy = await request({ action: 'import', document: prompt(), name: 'Legacy' });
    assert.equal((await store.read()).presets.find(record => record.id === legacy.id).sharePackage, undefined);
    const newExport = await request({ action: 'export-package', id: legacy.id });
    assert.equal(newExport.prefill.postToolPrefix.text, 'Updated');
    assert.deepEqual(newExport.tools.presets, []);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
