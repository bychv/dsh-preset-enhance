import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../index.mjs';
import { PresetStore } from '../lib/store.mjs';
import { decodePresetDocument, encodePresetPackage, attachPrefillSettings,
  applyPackagePrefill, validatePresetPackage, validateToolsPackage } from '../lib/preset-package.mjs';
import { exportToolsSection, remapToolPackage, TOOL_GROUP_LIMIT, TOOL_PRESET_LIMIT,
  TOOL_GROUP_MEMBER_LIMIT, TOOL_PRESET_RULE_LIMIT } from '../lib/tool-presets.mjs';

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
const emptyTools = (overrides = {}) => ({ version: 1, activePresetId: null, presets: [], groups: [], ...overrides });
const toolPack = () => ({
  version: 1,
  activePresetId: 'profile-1',
  presets: [{
    id: 'profile-1', name: '只读', description: '只读工具组合', defaultEnabled: true,
    groupIds: ['group-1'], updatedAt: '2024-01-01T00:00:00.000Z',
    rules: [
      { modeId: 'standard', toolName: 'shell', enabled: false, future: 'rule extension' },
      { modeId: 'plugin-mode', toolName: 'plugin-tool', enabled: true },
    ],
    future: { author: 'package' },
  }],
  groups: [{
    id: 'group-1', name: '读取类', description: '读取相关工具', order: 100,
    members: [
      { modeId: 'standard', toolName: 'read_file', future: 'member extension' },
      { modeId: 'plugin-mode', toolName: 'plugin-tool' },
    ],
    future: ['group extension'],
  }],
  future: { untouched: true },
});

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

function toolPacket() {
  const document = packet();
  document.future = { revision: 'retained' };
  document.preset.future = ['preset extension'];
  document.prefill.future = { enabled: true };
  document.prefill.postToolPrefix.future = ['prefix extension'];
  document.tools = toolPack();
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
    { metadata: [] }, { tools: [] }, { tools: null }, { tools: { groups: {} } },
    { tools: { presets: null } }, { extensions: [] },
    { prefill: { ...packet().prefill, enabled: 'true' } },
    { prefill: { ...packet().prefill, postToolPrefix: { mode: 'other', text: '' } } },
    { preset: { format: 'other', data: prompt() } },
  ]) assert.throws(() => validatePresetPackage({ ...packet(), ...invalid }));
  const withoutPrefill = { ...packet(), prefill: null };
  assert.deepEqual(encodePresetPackage(decodePresetDocument(withoutPrefill), settings()), withoutPrefill);
  assert.throws(() => applyPackagePrefill({}, decodePresetDocument(withoutPrefill)), /未附带/);
});

test('tools sub-format round trip keeps presets, groups, unmatched refs and unknown fields', () => {
  const source = toolPacket(), original = structuredClone(source);
  const section = validateToolsPackage(source.tools);
  assert.equal(section.version, 1);
  assert.equal(section.applicable, true);
  assert.equal(section.activePresetId, 'profile-1');
  assert.deepEqual(section.presets.map(preset => preset.id), ['profile-1']);
  assert.deepEqual(section.groups.map(group => group.id), ['group-1']);
  assert.deepEqual(section.presets[0].rules, [
    { modeId: 'standard', toolName: 'shell', enabled: false },
    { modeId: 'plugin-mode', toolName: 'plugin-tool', enabled: true },
  ]);
  assert.deepEqual(section.groups[0].members, [
    { modeId: 'standard', toolName: 'read_file' },
    { modeId: 'plugin-mode', toolName: 'plugin-tool' },
  ]);
  assert.equal(Object.hasOwn(section, 'future'), false, 'the validated section is a known-field projection');
  assert.equal(validatePresetPackage(source), source);
  assert.deepEqual(source, original, 'validation never rewrites the document it validates');

  const record = decodePresetDocument(structuredClone(source));
  assert.deepEqual(record.preset, prompt());
  const saved = encodePresetPackage(record, {});
  assert.deepEqual(saved, original, 'unknown fields survive at every level of the round trip');
  assert.deepEqual(saved.tools.presets[0].future, original.tools.presets[0].future);
  assert.deepEqual(saved.tools.presets[0].rules[0].future, original.tools.presets[0].rules[0].future);
  assert.deepEqual(saved.tools.groups[0].future, original.tools.groups[0].future);
  assert.deepEqual(saved.tools.groups[0].members[0].future, original.tools.groups[0].members[0].future);
  assert.deepEqual(saved.future, original.future);
  assert.deepEqual(saved.preset.future, original.preset.future);
  assert.deepEqual(saved.extensions, original.extensions);
  attachPrefillSettings(record, settings());
  assert.deepEqual(record.sharePackage.tools, original.tools);
  assert.deepEqual(record.sharePackage.future, original.future);
  assert.deepEqual(record.sharePackage.preset.future, original.preset.future);

  const explicit = encodePresetPackage({ name: 'Explicit', preset: prompt() }, {}, toolPack());
  assert.deepEqual(explicit.tools, original.tools, 'a handed-in section is cloned, not projected');
});

test('unknown tools.version is preserved and exported but refused for application', () => {
  const source = futurePacket();
  const section = validateToolsPackage(source.tools);
  assert.equal(section.version, 7);
  assert.equal(section.applicable, false);
  assert.equal(section.activePresetId, null);
  assert.deepEqual(section.presets, []);
  assert.deepEqual(section.groups, []);
  assert.equal(validatePresetPackage(source), source);
  const record = decodePresetDocument(structuredClone(source));
  assert.deepEqual(encodePresetPackage(record, {}), source);
  assert.deepEqual(encodePresetPackage(record, {}, source.tools).tools, source.tools);
  assert.throws(() => remapToolPackage(source.tools, {}), /工具子版本 7/);
  const futureShape = { ...packet(), tools: { version: 2, anything: ['newer'] } };
  assert.equal(validateToolsPackage(futureShape.tools).applicable, false);
  assert.deepEqual(encodePresetPackage(decodePresetDocument(futureShape), {}).tools, { version: 2, anything: ['newer'] });
});

test('tools sub-format rejects dangling references, duplicates, bad shapes and over-limit lists', () => {
  const pack = toolPack();
  const document = tools => ({ ...packet(), tools });
  assert.throws(() => validatePresetPackage(document({ ...pack, activePresetId: 'ghost' })), /activePresetId/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ presets: [{ id: 'p', name: 'x', groupIds: ['ghost'] }] }) })), /不存在的分组/);
  assert.throws(() => validatePresetPackage(document({ ...pack, presets: [...pack.presets, { ...pack.presets[0], name: '副本' }] })), /预设 ID 重复/);
  assert.throws(() => validatePresetPackage(document({ ...pack, groups: [...pack.groups, { ...pack.groups[0], name: '副本' }] })), /分组 ID 重复/);
  assert.throws(() => validatePresetPackage(document({ ...pack, groups: [{
    ...pack.groups[0], members: [...pack.groups[0].members, pack.groups[0].members[0]],
  }] })), /重复成员/);
  assert.throws(() => validatePresetPackage(document({ ...pack, groups: [
    pack.groups[0], { ...pack.groups[0], id: 'group-2', name: '其他' },
  ] })), /已属于其他分组/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ groups: [{ id: '@all', name: '全部', members: [] }] }) })), /虚拟分组/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ presets: [{
    id: 'p', name: 'x', rules: [{ modeId: 'standard', toolName: 'shell', enabled: 'yes' }],
  }] }) })), /enabled/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ presets: [{ id: 'p', name: 'x', defaultEnabled: 'yes' }] }) })), /defaultEnabled/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ groups: 'nope' }) })), /必须是数组/);
  assert.throws(() => validatePresetPackage(document({ ...emptyTools({ presets: null }) })), /必须为数组/);
  for (const version of [0, -1, 1.5, '1', null]) {
    assert.throws(() => validatePresetPackage(document({ ...pack, version })), /version/);
  }
  const groups = Array.from({ length: TOOL_GROUP_LIMIT + 1 }, (_, index) => ({ id: `group-${index}`, name: `组 ${index}`, members: [] }));
  assert.throws(() => validatePresetPackage(document(emptyTools({ groups }))), /最多 100 个/);
  const presets = Array.from({ length: TOOL_PRESET_LIMIT + 1 }, (_, index) => ({ id: `preset-${index}`, name: `预设 ${index}`, groupIds: [], rules: [] }));
  assert.throws(() => validatePresetPackage(document(emptyTools({ presets }))), /最多 100 个/);
  const members = Array.from({ length: TOOL_GROUP_MEMBER_LIMIT + 1 }, (_, index) => ({ modeId: 'standard', toolName: `tool-${index}` }));
  assert.throws(() => validatePresetPackage(document(emptyTools({ groups: [{ id: 'big', name: '大组', members }] }))), /最多 2000 个成员/);
  const rules = Array.from({ length: TOOL_PRESET_RULE_LIMIT + 1 }, (_, index) => ({ modeId: 'standard', toolName: `tool-${index}`, enabled: true }));
  assert.throws(() => validatePresetPackage(document(emptyTools({ presets: [{ id: 'big', name: '大预设', groupIds: [], rules }] }))), /最多 5000 条规则/);
});

test('packages without a tools section keep importing and exporting unchanged', () => {
  const document = packet();
  delete document.tools;
  const original = structuredClone(document);
  assert.equal(validatePresetPackage(document), document);
  const record = decodePresetDocument(structuredClone(document));
  const saved = encodePresetPackage(record, {});
  assert.equal(Object.hasOwn(saved, 'tools'), false);
  assert.deepEqual(saved, original);
  assert.deepEqual(validateToolsPackage(undefined), {
    version: 1, applicable: true, activePresetId: null, presets: [], groups: [],
  });
  const state = {};
  applyPackagePrefill(state, record);
  assert.equal(state.postToolPrefixText, packet().prefill.postToolPrefix.text);
});

test('an explicitly exported tools section carries only the associated preset and its groups', () => {
  const state = {
    toolGroups: [
      { id: 'group-1', name: '读取类', description: '', order: 100, members: [{ modeId: 'standard', toolName: 'read_file' }] },
      { id: 'group-2', name: '写入类', description: '', order: 200, members: [{ modeId: 'standard', toolName: 'write_file' }] },
    ],
    toolPresets: [
      { id: 'profile-1', name: '只读', description: '', defaultEnabled: true, groupIds: ['group-1', 'ghost-group'],
        rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }], updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'profile-2', name: '全开', description: '', defaultEnabled: true, groupIds: ['group-2'], rules: [], updatedAt: '' },
    ],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'profile-1' } },
    sessionToolSelections: { 'session-secret': { kind: 'preset', presetId: 'profile-1' } },
    sessionToolPolicies: { 'session-secret': { read_file: false } },
    toolCatalogs: { standard: [{ name: 'read_file', description: 'LOCAL_ONLY' }] },
    apiKey: 'LOCAL_ONLY',
  };
  const section = exportToolsSection(state, 'profile-1');
  const document = encodePresetPackage({ name: '分享', preset: prompt() }, state, section);
  assert.deepEqual(document.tools.presets.map(preset => preset.id), ['profile-1']);
  assert.deepEqual(document.tools.groups.map(group => group.id), ['group-1']);
  assert.deepEqual(document.tools.presets[0].groupIds, ['group-1']);
  assert.equal(document.tools.activePresetId, 'profile-1');
  assert.equal(validateToolsPackage(document.tools).applicable, true);
  assert.equal(validatePresetPackage(document), document);
  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /profile-2|group-2|ghost-group|session-secret|LOCAL_ONLY|modeToolSelections|toolCatalogs/);
  const empty = exportToolsSection(state, 'missing-preset');
  assert.deepEqual(empty, { version: 1, activePresetId: null, presets: [], groups: [] });
  assert.deepEqual(encodePresetPackage({ name: '分享', preset: prompt() }, state, empty).tools, empty);
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
    await request({ action: 'import', document: { ...packet(), tools: { ...toolPack(), activePresetId: 'ghost' } } }, 400);
    await request({ action: 'save-deepseek-beta', presetId: 'missing', enabled: false }, 400);
    const refused = await request({ action: 'import-package-tools', id }, 400);
    assert.match(refused.error, /工具子版本 7/);
    assert.deepEqual(await store.read(), before);
    const withTools = { ...packet(), tools: toolPack() };
    const toolsImport = await request({ action: 'import', document: withTools, name: 'tools-package' });
    assert.deepEqual((await store.read()).presets.find(record => record.id === toolsImport.id).sharePackage, withTools);
    assert.deepEqual(await request({ action: 'export-package', id: toolsImport.id }), withTools);
    const afterToolsImport = await store.read();
    assert.deepEqual(afterToolsImport.toolGroups ?? [], []);
    assert.deepEqual(afterToolsImport.toolPresets ?? [], []);
    assert.deepEqual(afterToolsImport.modeToolSelections ?? {}, {});
    const preview = await request({ action: 'import-package-tools', id: toolsImport.id, dryRun: true });
    assert.equal(preview.applied, false);
    assert.equal(preview.stats.groups.added, 1);
    assert.equal(preview.stats.presets.added, 1);
    assert.deepEqual((await store.read()).toolGroups ?? [], []);
    const applied = await request({ action: 'import-package-tools', id: toolsImport.id });
    assert.equal(applied.applied, true);
    const withAppliedTools = await store.read();
    assert.deepEqual((withAppliedTools.toolGroups ?? []).map(group => group.id), ['group-1']);
    assert.deepEqual((withAppliedTools.toolPresets ?? []).map(preset => preset.id), ['profile-1']);
    assert.deepEqual(withAppliedTools.modeToolSelections ?? {}, {});
    assert.deepEqual(withAppliedTools.sessionToolSelections ?? {}, {});
    assert.deepEqual((await request()).presets.find(record => record.id === toolsImport.id).sharePackage, withTools);
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
