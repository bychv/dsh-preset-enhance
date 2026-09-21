/**
 * Independent spec tests for lib/tool-presets.mjs.
 *
 * These assert docs/TOOL_GROUPS_IMPLEMENTATION.md (数据模型 / 有效策略 / 分组批量操作 /
 * API / 验收清单) rather than mirroring the implementation. Literal limits are
 * used on purpose so a mutated exported constant is caught too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_VIRTUAL_ALL,
  TOOL_VIRTUAL_UNGROUPED,
  TOOL_GROUP_LIMIT,
  TOOL_PRESET_LIMIT,
  TOOL_GROUP_MEMBER_LIMIT,
  TOOL_PRESET_RULE_LIMIT,
  toolRefKey,
  toolRefLabel,
  normalizeToolGroups,
  normalizeToolPresetRules,
  normalizeToolPreset,
  normalizeToolSelection,
  assertPresetGroupIds,
  normalizeToolState,
  toolPolicySnapshot,
  effectiveToolEnabled,
  effectiveToolPolicy,
  expandToolPresetPolicy,
  presetReferenceCounts,
  unresolvedToolRefs,
  groupMembersForMode,
  resetPresetSelections,
  validateToolsSection,
  remapToolPackage,
  exportToolsSection,
} from '../lib/tool-presets.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CATALOGS = {
  standard: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'shell' }],
  plugin: [{ name: 'shell' }, { name: 'plugin_tool' }],
};
const names = (...list) => list.map(name => ({ name }));
const member = (modeId, toolName) => ({ modeId, toolName });
const group = (over = {}) => ({
  id: 'g1',
  name: '读取类',
  description: '',
  order: 100,
  members: [member('standard', 'read_file')],
  ...over,
});
const preset = (over = {}) => ({
  id: 'p1',
  name: '只读',
  description: '',
  defaultEnabled: true,
  groupIds: [],
  rules: [{ modeId: 'standard', toolName: 'shell', enabled: true }],
  ...over,
});
const snapshotOf = state => toolPolicySnapshot(normalizeToolState(state));

function assertCleanPrototypes() {
  for (const key of ['kind', 'presetId', 'modes', 'sessions', 'read_file', 'name']) {
    assert.equal(Object.hasOwn(Object.prototype, key), false, `Object.prototype.${key} polluted`);
  }
}

// ---------------------------------------------------------------------------
// constants, keys, shapes
// ---------------------------------------------------------------------------

test('exported limits and virtual ids match the documented spec', () => {
  assert.equal(TOOL_VIRTUAL_ALL, '@all');
  assert.equal(TOOL_VIRTUAL_UNGROUPED, '@ungrouped');
  assert.equal(TOOL_GROUP_LIMIT, 100);
  assert.equal(TOOL_PRESET_LIMIT, 100);
  assert.equal(TOOL_GROUP_MEMBER_LIMIT, 2000);
  assert.equal(TOOL_PRESET_RULE_LIMIT, 5000);
});

test('toolRefKey keys a reference by mode and tool, not by tool name alone', () => {
  assert.equal(toolRefKey('standard', 'shell'), toolRefKey('standard', 'shell'));
  assert.notEqual(toolRefKey('standard', 'shell'), toolRefKey('plugin', 'shell'));
  assert.notEqual(toolRefKey('a', 'b'), toolRefKey('b', 'a'));
  // embedded separators must not collide
  assert.notEqual(toolRefKey('a,b', 'c'), toolRefKey('a', 'b,c'));
  assert.notEqual(toolRefKey('', 'tool'), toolRefKey('mode', 'tool'));
  assert.equal(toolRefLabel({ modeId: 'standard', toolName: 'shell' }), 'standard/shell');
  assert.equal(toolRefLabel({}), '/');
  assert.equal(toolRefLabel(undefined), '/');
});

// ---------------------------------------------------------------------------
// normalizeToolGroups
// ---------------------------------------------------------------------------

test('normalizeToolGroups fills defaults, copies members and leaves the input alone', () => {
  const input = [group({ description: undefined, order: undefined, id: 'g1' })];
  input[0].members = [member('standard', 'read_file')];
  const before = structuredClone(input);
  const result = normalizeToolGroups(input, { catalogs: CATALOGS });
  assert.deepEqual(result, [{
    id: 'g1', name: '读取类', description: '', order: 100,
    members: [{ modeId: 'standard', toolName: 'read_file' }],
  }]);
  assert.deepEqual(input, before);
  assert.equal(normalizeToolGroups(undefined).length, 0);
  assert.equal(normalizeToolGroups(null).length, 0);
  assert.deepEqual(normalizeToolGroups([]), []);
});

test('normalizeToolGroups rejects non-arrays and non-object rows', () => {
  assert.throws(() => normalizeToolGroups('nope', { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups({}, { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([null], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups(['g1'], { catalogs: CATALOGS }));
});

test('normalizeToolGroups enforces the group count limit', () => {
  const make = count => Array.from({ length: count }, (_, index) => ({
    id: `g${index}`, name: `G${index}`, members: [],
  }));
  assert.equal(normalizeToolGroups(make(100), { catalogs: CATALOGS }).length, 100);
  assert.throws(() => normalizeToolGroups(make(101), { catalogs: CATALOGS }));
  // absent catalogs must not silently accept anything
  assert.throws(() => normalizeToolGroups([group()]));
});

test('normalizeToolGroups enforces the member count limit', () => {
  const catalog = names(...Array.from({ length: 2001 }, (_, index) => `tool${index}`));
  const catalogs = { standard: catalog };
  const members = Array.from({ length: 2000 }, (_, index) => member('standard', `tool${index}`));
  assert.equal(normalizeToolGroups([group({ members })], { catalogs })[0].members.length, 2000);
  members.push(member('standard', 'tool2000'));
  assert.throws(() => normalizeToolGroups([group({ members })], { catalogs }));
});

test('normalizeToolGroups rejects duplicated members and cross-group claims', () => {
  assert.throws(() => normalizeToolGroups([group({
    members: [member('standard', 'read_file'), member('standard', 'read_file')],
  })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([
    group({ id: 'g1', members: [member('standard', 'read_file')] }),
    group({ id: 'g2', name: 'G2', members: [member('standard', 'read_file')] }),
  ], { catalogs: CATALOGS }));
});

test('the same tool name in two modes stays distinct and may be grouped separately', () => {
  const result = normalizeToolGroups([group({
    members: [member('standard', 'shell'), member('plugin', 'shell')],
  })], { catalogs: CATALOGS });
  assert.deepEqual(result[0].members, [
    { modeId: 'standard', toolName: 'shell' },
    { modeId: 'plugin', toolName: 'shell' },
  ]);
  // wrong mode for a known tool name is still an unknown reference
  assert.throws(() => normalizeToolGroups([group({ members: [member('plugin', 'read_file')] })], { catalogs: CATALOGS }));
});

test('normalizeToolGroups reserves @ ids for the virtual groups', () => {
  for (const id of ['@all', '@ungrouped', '@anything']) {
    assert.throws(() => normalizeToolGroups([group({ id, members: [] })], { catalogs: CATALOGS }));
  }
  assert.throws(() => normalizeToolPreset({ name: 'P', id: '@all', groupIds: [] }));
  assert.throws(() => normalizeToolPreset({ name: 'P', id: null, groupIds: ['@ungrouped'] }));
});

test('normalizeToolGroups rejects empty, non-string and blank identifiers', () => {
  for (const id of [undefined, null, '', '   ', 42, {}, []]) {
    assert.throws(() => normalizeToolGroups([group({ id, members: [] })], { catalogs: CATALOGS }), `id ${String(id)}`);
  }
  for (const name of [undefined, null, '', '   ', 42]) {
    assert.throws(() => normalizeToolGroups([group({ name, members: [] })], { catalogs: CATALOGS }), `name ${String(name)}`);
  }
});

test('normalizeToolGroups rejects malformed optional fields', () => {
  assert.throws(() => normalizeToolGroups([group({ description: 42 })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ description: 'x'.repeat(501) })], { catalogs: CATALOGS }));
  assert.equal(normalizeToolGroups([group({ description: 'x'.repeat(500) })], { catalogs: CATALOGS })[0].description.length, 500);
  assert.throws(() => normalizeToolGroups([group({ order: 'abc' })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ order: Number.NaN })], { catalogs: CATALOGS }));
  assert.equal(normalizeToolGroups([group({ order: '5' })], { catalogs: CATALOGS })[0].order, 5);
  assert.throws(() => normalizeToolGroups([group({ members: 'nope' })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ members: [null] })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ members: [{ modeId: 'standard' }] })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ members: [{ modeId: 1, toolName: 'read_file' }] })], { catalogs: CATALOGS }));
  assert.throws(() => normalizeToolGroups([group({ members: [{ modeId: 'standard', toolName: '' }] })], { catalogs: CATALOGS }));
});

test('new references must exist in the catalogs while pre-existing unmatched refs are preserved', () => {
  const existing = [group({ id: 'g1', members: [member('standard', 'read_file'), member('standard', 'ghost_tool')] })];
  const kept = normalizeToolGroups([
    group({ id: 'g1', name: '新名字', members: [member('standard', 'read_file'), member('standard', 'ghost_tool')] }),
  ], { catalogs: CATALOGS, existing });
  assert.deepEqual(kept[0].members, [member('standard', 'read_file'), member('standard', 'ghost_tool')]);
  // a brand-new unmatched reference is refused
  assert.throws(() => normalizeToolGroups([group({
    id: 'g2', name: 'G2', members: [member('standard', 'ghost_tool')],
  })], { catalogs: CATALOGS, existing: [] }));
  // and the reference must match the mode, not just the tool name
  assert.throws(() => normalizeToolGroups([group({
    id: 'g2', name: 'G2', members: [member('plugin', 'read_file')],
  })], { catalogs: CATALOGS, existing: [] }));
});

test('allowUnknownRefs keeps unknown package references but still enforces structure', () => {
  const result = normalizeToolGroups([
    group({ id: 'g1', members: [member('external-mode', 'external-tool')] }),
  ], { allowUnknownRefs: true });
  assert.deepEqual(result[0].members, [member('external-mode', 'external-tool')]);
  assert.throws(() => normalizeToolGroups([
    group({ id: 'g1', members: [member('external-mode', 'external-tool')] }),
    group({ id: 'g2', name: 'G2', members: [member('external-mode', 'external-tool')] }),
  ], { allowUnknownRefs: true }));
  assert.throws(() => normalizeToolGroups([group({ id: '@all', members: [] })], { allowUnknownRefs: true }));
});

// ---------------------------------------------------------------------------
// normalizeToolPresetRules / normalizeToolPreset / normalizeToolSelection
// ---------------------------------------------------------------------------

test('normalizeToolPresetRules validates syntax only and keeps unknown references', () => {
  const rules = normalizeToolPresetRules([
    { modeId: 'external-mode', toolName: 'external-tool', enabled: false },
    { modeId: 'standard', toolName: 'read_file', enabled: true },
  ]);
  assert.deepEqual(rules, [
    { modeId: 'external-mode', toolName: 'external-tool', enabled: false },
    { modeId: 'standard', toolName: 'read_file', enabled: true },
  ]);
  assert.deepEqual(normalizeToolPresetRules(undefined), []);
  assert.deepEqual(normalizeToolPresetRules(null), []);
  assert.throws(() => normalizeToolPresetRules('nope'));
  assert.throws(() => normalizeToolPresetRules([{ modeId: 'standard', toolName: 'shell' }]));
  assert.throws(() => normalizeToolPresetRules([{ modeId: 'standard', toolName: 'shell', enabled: 1 }]));
  assert.throws(() => normalizeToolPresetRules([{ modeId: 'standard', toolName: 'shell', enabled: 'no' }]));
  assert.throws(() => normalizeToolPresetRules([{ modeId: '', toolName: 'shell', enabled: true }]));
  assert.throws(() => normalizeToolPresetRules([null]));
  assert.throws(() => normalizeToolPresetRules([
    { modeId: 'standard', toolName: 'shell', enabled: true },
    { modeId: 'standard', toolName: 'shell', enabled: false },
  ]));
  // same tool name in another mode is not a duplicate
  assert.equal(normalizeToolPresetRules([
    { modeId: 'standard', toolName: 'shell', enabled: true },
    { modeId: 'plugin', toolName: 'shell', enabled: false },
  ]).length, 2);
});

test('normalizeToolPresetRules enforces the rule count limit', () => {
  const make = count => Array.from({ length: count }, (_, index) => ({
    modeId: 'standard', toolName: `tool${index}`, enabled: false,
  }));
  assert.equal(normalizeToolPresetRules(make(5000)).length, 5000);
  assert.throws(() => normalizeToolPresetRules(make(5001)));
});

test('normalizeToolPreset fills defaults and rejects malformed bodies', () => {
  const created = normalizeToolPreset({ name: '只读', id: '', groupIds: ['g1'], rules: [] });
  assert.equal(created.id, null);
  assert.equal(created.description, '');
  assert.equal(created.defaultEnabled, true);
  assert.deepEqual(created.groupIds, ['g1']);
  assert.deepEqual(created.rules, []);
  assert.equal(typeof created.updatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(created.updatedAt)));

  const kept = normalizeToolPreset(preset({ defaultEnabled: false, description: 'd', updatedAt: '2024-01-01T00:00:00.000Z' }));
  assert.equal(kept.id, 'p1');
  assert.equal(kept.name, '只读');
  assert.equal(kept.description, 'd');
  assert.equal(kept.defaultEnabled, false);
  assert.equal(kept.updatedAt, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(kept.rules, [{ modeId: 'standard', toolName: 'shell', enabled: true }]);

  assert.throws(() => normalizeToolPreset(undefined));
  assert.throws(() => normalizeToolPreset(null));
  assert.throws(() => normalizeToolPreset([preset()]));
  assert.throws(() => normalizeToolPreset(preset({ name: '' })));
  assert.throws(() => normalizeToolPreset(preset({ id: 42 })));
  assert.throws(() => normalizeToolPreset(preset({ defaultEnabled: 'yes' })));
  assert.throws(() => normalizeToolPreset(preset({ description: 42 })));
  assert.throws(() => normalizeToolPreset(preset({ groupIds: 'g1' })));
  assert.throws(() => normalizeToolPreset(preset({ groupIds: ['g1', 'g1'] })));
  assert.throws(() => normalizeToolPreset(preset({ groupIds: [42] })));
  assert.throws(() => normalizeToolPreset(preset({ rules: 'nope' })));
});

test('normalizeToolPreset enforces the group reference count limit', () => {
  const make = count => Array.from({ length: count }, (_, index) => `g${index}`);
  assert.equal(normalizeToolPreset(preset({ groupIds: make(100) })).groupIds.length, 100);
  assert.throws(() => normalizeToolPreset(preset({ groupIds: make(101) })));
});

test('normalizeToolSelection resolves the scope default and rejects inherit for modes', () => {
  assert.deepEqual(normalizeToolSelection(undefined, 'mode'), { kind: 'custom' });
  assert.deepEqual(normalizeToolSelection(null, 'mode'), { kind: 'custom' });
  assert.deepEqual(normalizeToolSelection(undefined, 'session'), { kind: 'inherit' });
  assert.deepEqual(normalizeToolSelection(null, 'session'), { kind: 'inherit' });
  assert.deepEqual(normalizeToolSelection({ kind: 'inherit' }, 'session'), { kind: 'inherit' });
  assert.deepEqual(normalizeToolSelection({ kind: 'custom' }, 'session'), { kind: 'custom' });
  assert.deepEqual(normalizeToolSelection({ kind: 'preset', presetId: 'p1' }, 'mode'), { kind: 'preset', presetId: 'p1' });
  assert.throws(() => normalizeToolSelection({ kind: 'inherit' }, 'mode'));
  assert.throws(() => normalizeToolSelection({ kind: 'preset' }, 'session'));
  assert.throws(() => normalizeToolSelection({ kind: 'preset', presetId: '' }, 'session'));
  assert.throws(() => normalizeToolSelection({ kind: 'preset', presetId: '@all' }, 'session'));
  assert.throws(() => normalizeToolSelection({ kind: 'preset', presetId: '@ungrouped' }, 'mode'));
  assert.throws(() => normalizeToolSelection({ kind: 'bogus' }, 'mode'));
  assert.throws(() => normalizeToolSelection('custom', 'mode'));
  assert.throws(() => normalizeToolSelection({ kind: 'custom' }, 'other'));
});

test('assertPresetGroupIds rejects dangling group references', () => {
  const body = normalizeToolPreset(preset({ groupIds: ['g1'] }));
  assert.equal(assertPresetGroupIds(body, [group({ id: 'g1', members: [] })]), body);
  assert.throws(() => assertPresetGroupIds(body, [group({ id: 'g2', members: [] })]));
  assert.throws(() => assertPresetGroupIds(body, []));
  assert.throws(() => assertPresetGroupIds(body, undefined));
});

// ---------------------------------------------------------------------------
// normalizeToolState (lenient)
// ---------------------------------------------------------------------------

test('normalizeToolState gives a fresh state empty new fields', () => {
  const state = normalizeToolState({ version: 1 });
  assert.deepEqual(state.toolGroups, []);
  assert.deepEqual(state.toolPresets, []);
  assert.deepEqual(state.modeToolSelections, {});
  assert.deepEqual(state.sessionToolSelections, {});
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'anything'), true);
});

test('normalizeToolState rebuilds custom selections for pre-upgrade flat policies', () => {
  const state = normalizeToolState({
    version: 1,
    modeToolPolicies: { standard: { read_file: false }, plugin: { shell: true } },
    sessionToolPolicies: { 'session-1': { read_file: false } },
  });
  assert.deepEqual(state.toolGroups, []);
  assert.deepEqual(state.toolPresets, []);
  assert.deepEqual(state.modeToolSelections, {
    standard: { kind: 'custom' },
    plugin: { kind: 'custom' },
  });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'custom' } });
  assert.deepEqual(state.modeToolPolicies, { standard: { read_file: false }, plugin: { shell: true } });
  assert.deepEqual(state.sessionToolPolicies, { 'session-1': { read_file: false } });

  // legacy mode defaults keep their exact behaviour
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'write_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'plugin', 'shell'), true);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), false);
});

test('normalizeToolState never overwrites an existing selection with the legacy fallback', () => {
  const state = normalizeToolState({
    toolPresets: [{ id: 'p1', name: 'P1', defaultEnabled: true }],
    modeToolPolicies: { standard: { read_file: false } },
    sessionToolPolicies: { 'session-1': { read_file: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    sessionToolSelections: { 'session-1': { kind: 'inherit' } },
  });
  assert.deepEqual(state.modeToolSelections, { standard: { kind: 'preset', presetId: 'p1' } });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'inherit' } });
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), true);
});

test('normalizeToolState coerces junk rows instead of throwing', () => {
  const state = normalizeToolState({
    toolGroups: [
      null, 'x', { id: 42 }, { id: 'g1' },
      {
        id: 'g2', name: '', description: 7, order: 'abc',
        members: [null, { modeId: 'standard' }, member('standard', 'read_file'), member('plugin', 'shell')],
      },
    ],
    toolPresets: [
      null, { id: '' },
      {
        id: 'p1', name: '', description: 5, defaultEnabled: 'yes', groupIds: ['g1', 7, ''],
        rules: [
          null, { modeId: 'standard' },
          { modeId: 'standard', toolName: 'shell', enabled: 'no' },
          { modeId: 'standard', toolName: 'read_file', enabled: true },
        ],
        updatedAt: 5,
      },
    ],
  });
  assert.deepEqual(state.toolGroups, [
    { id: 'g1', name: 'g1', description: '', order: 100, members: [] },
    {
      id: 'g2', name: 'g2', description: '', order: 100,
      members: [member('standard', 'read_file'), member('plugin', 'shell')],
    },
  ]);
  assert.deepEqual(state.toolPresets, [{
    id: 'p1', name: 'p1', description: '', defaultEnabled: true, groupIds: ['g1'],
    rules: [
      { modeId: 'standard', toolName: 'shell', enabled: false },
      { modeId: 'standard', toolName: 'read_file', enabled: true },
    ],
    updatedAt: '',
  }]);
  // defaultEnabled survives only an explicit false
  assert.equal(normalizeToolState({ toolPresets: [{ id: 'p', name: 'P', defaultEnabled: false }] }).toolPresets[0].defaultEnabled, false);
  assert.equal(normalizeToolState({ toolPresets: [{ id: 'p', name: 'P' }] }).toolPresets[0].defaultEnabled, true);
});

test('normalizeToolState repairs dangling and invalid selections by scope', () => {
  const state = normalizeToolState({
    toolPresets: [{ id: 'p1', name: 'P1' }],
    modeToolSelections: {
      m1: { kind: 'preset', presetId: 'p1' },
      m2: { kind: 'preset', presetId: 'gone' },
      m3: { kind: 'inherit' },
      m4: null,
      m5: { kind: 'preset' },
    },
    sessionToolSelections: {
      s1: { kind: 'preset', presetId: 'p1' },
      s2: { kind: 'inherit' },
      s3: { kind: 'preset', presetId: 'gone' },
      s4: { kind: 'bogus' },
    },
  });
  assert.deepEqual(state.modeToolSelections, {
    m1: { kind: 'preset', presetId: 'p1' },
    m2: { kind: 'custom' },
    m3: { kind: 'custom' },
    m4: { kind: 'custom' },
    m5: { kind: 'custom' },
  });
  assert.deepEqual(state.sessionToolSelections, {
    s1: { kind: 'preset', presetId: 'p1' },
    s2: { kind: 'inherit' },
    s3: { kind: 'inherit' },
    s4: { kind: 'inherit' },
  });
});

test('normalizeToolState treats non-object selection maps as empty', () => {
  const state = normalizeToolState({ modeToolSelections: 'nope', sessionToolSelections: [1, 2], toolGroups: 'nope', toolPresets: 7 });
  assert.deepEqual(state.modeToolSelections, {});
  assert.deepEqual(state.sessionToolSelections, {});
  assert.deepEqual(state.toolGroups, []);
  assert.deepEqual(state.toolPresets, []);
});

test('prototype keys stay ordinary own data properties and never pollute Object.prototype', () => {
  const parsed = JSON.parse('{"toolGroups":[],"toolPresets":[{"id":"__proto__","name":"P"}],' +
    '"modeToolSelections":{"__proto__":{"kind":"preset","presetId":"__proto__"}},' +
    '"sessionToolSelections":{"constructor":{"kind":"preset","presetId":"__proto__"}},' +
    '"modeToolPolicies":{"__proto__":{"read_file":false}}}');
  const state = normalizeToolState(parsed);

  assert.equal(Object.getPrototypeOf(state.modeToolSelections), Object.prototype);
  assert.equal(Object.hasOwn(state.modeToolSelections, '__proto__'), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(state.modeToolSelections, '__proto__').value, {
    kind: 'preset', presetId: '__proto__',
  });
  assert.equal(Object.hasOwn(state.sessionToolSelections, 'constructor'), true);

  const snapshot = toolPolicySnapshot(state);
  assert.equal(Object.getPrototypeOf(snapshot.presets), Object.prototype);
  assert.equal(Object.hasOwn(snapshot.presets, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(snapshot.modes), Object.prototype);
  assert.equal(Object.hasOwn(snapshot.modes, '__proto__'), true);

  // a preset literally called "__proto__" must still be usable, not silently ignored
  assert.equal(effectiveToolEnabled(snapshot, 'constructor', '__proto__', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, '__proto__', 'read_file'), true);
  // flat mode policy keyed "__proto__" still disables explicitly
  assert.equal(effectiveToolEnabled(snapshot, null, '__proto__', 'other'), true);

  const policy = effectiveToolPolicy(snapshot, null, 'standard', names('__proto__', 'read_file'));
  assert.equal(Object.hasOwn(policy, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(policy), Object.prototype);
  assertCleanPrototypes();
});

// ---------------------------------------------------------------------------
// snapshot + effective policy
// ---------------------------------------------------------------------------

test('toolPolicySnapshot detaches from later mutation of the state it was built from', () => {
  const state = normalizeToolState({
    toolPresets: [preset({ defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] })],
    modeToolPolicies: { standard: { read_file: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  const snapshot = toolPolicySnapshot(state);

  state.toolPresets[0].defaultEnabled = false;
  state.toolPresets[0].rules[0].enabled = true;
  state.modeToolPolicies.standard.read_file = true;
  state.modeToolSelections.standard.kind = 'custom';

  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'write_file'), true);
  assert.equal(snapshot.presets.p1.defaultEnabled, true);
  assert.deepEqual(snapshot.presets.p1.rules, [{ modeId: 'standard', toolName: 'shell', enabled: false }]);
  assert.deepEqual(snapshot.modes.standard, { read_file: false });
  assert.equal(snapshot.modeSelections.standard.kind, 'preset');
});

test('toolPolicySnapshot skips malformed presets and tolerates an empty state', () => {
  const snapshot = toolPolicySnapshot({ toolPresets: [{ name: 'no id' }, { id: '', name: 'blank' }, { id: 'p1', name: 'P' }] });
  assert.deepEqual(Object.keys(snapshot.presets), ['p1']);
  const empty = toolPolicySnapshot(undefined);
  assert.deepEqual(empty.presets, {});
  assert.deepEqual(empty.modeSelections, {});
  assert.equal(effectiveToolEnabled(empty, null, 'standard', 'read_file'), true);
});

test('flat policy semantics: only an explicit false disables a tool', () => {
  const state = { modeToolPolicies: { standard: { read_file: false, write_file: true } } };
  const snapshot = snapshotOf(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'write_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'never_seen'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'unknown-mode', 'read_file'), true);
});

test('a mode preset replaces the flat mode policy instead of layering on it', () => {
  const state = {
    toolPresets: [{ id: 'p1', name: 'P', defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] }],
    modeToolPolicies: { standard: { read_file: false, shell: true } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  };
  const snapshot = snapshotOf(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  // read_file=false from the flat policy must NOT survive the preset switch
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), true);
  // switching back to custom restores the flat policy
  const custom = snapshotOf({ ...state, modeToolSelections: { standard: { kind: 'custom' } } });
  assert.equal(effectiveToolEnabled(custom, null, 'standard', 'read_file'), false);
});

test('defaultEnabled plus explicit rules merge correctly, including tools added later', () => {
  const rules = [
    { modeId: 'standard', toolName: 'shell', enabled: false },
    { modeId: 'standard', toolName: 'write_file', enabled: true },
  ];
  const enabledByDefault = snapshotOf({
    toolPresets: [{ id: 'p1', name: 'P', defaultEnabled: true, rules }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  assert.equal(effectiveToolEnabled(enabledByDefault, null, 'standard', 'read_file'), true, 'absent tool follows defaultEnabled');
  assert.equal(effectiveToolEnabled(enabledByDefault, null, 'standard', 'write_file'), true, 'explicit true wins');
  assert.equal(effectiveToolEnabled(enabledByDefault, null, 'standard', 'shell'), false, 'explicit false wins');
  assert.equal(effectiveToolEnabled(enabledByDefault, null, 'standard', 'installed_later'), true);

  const disabledByDefault = snapshotOf({
    toolPresets: [{ id: 'p1', name: 'P', defaultEnabled: false, rules }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  assert.equal(effectiveToolEnabled(disabledByDefault, null, 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(disabledByDefault, null, 'standard', 'write_file'), true);
  assert.equal(effectiveToolEnabled(disabledByDefault, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(disabledByDefault, null, 'standard', 'installed_later'), false);
});

test('rules for another mode never leak into the effective preset policy', () => {
  const snapshot = snapshotOf({
    toolPresets: [{
      id: 'p1', name: 'P', defaultEnabled: false,
      rules: [
        { modeId: 'plugin', toolName: 'plugin_tool', enabled: true },
        { modeId: 'plugin', toolName: 'shell', enabled: true },
      ],
    }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolPolicy(snapshot, null, 'standard', names('shell', 'read_file')).shell, false);
  // the same preset still applies its own mode's rules
  assert.equal(effectiveToolEnabled(snapshot, null, 'plugin', 'plugin_tool'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'plugin', 'shell'), true);
});

test('cross-mode flat policies stay separate for the same tool name', () => {
  const state = {
    modeToolPolicies: { standard: { shell: false }, plugin: { shell: true } },
  };
  const snapshot = snapshotOf(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'plugin', 'shell'), true);
});

test('session inherit and missing selection use the mode result', () => {
  const snapshot = snapshotOf({
    toolPresets: [{ id: 'p1', name: 'P', defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    sessionToolPolicies: { s1: { read_file: false } },
    sessionToolSelections: { s1: { kind: 'inherit' }, s2: { kind: 'inherit' } },
  });
  for (const sessionId of [null, 's1', 's2', 'unknown-session']) {
    assert.equal(effectiveToolEnabled(snapshot, sessionId, 'standard', 'shell'), false, `session ${sessionId}`);
    assert.equal(effectiveToolEnabled(snapshot, sessionId, 'standard', 'read_file'), true, `session ${sessionId}`);
  }
});

test('a snapshot built without normalisation still honours a legacy flat session policy', () => {
  const legacy = toolPolicySnapshot({
    modeToolPolicies: { standard: { read_file: false, shell: true } },
    sessionToolPolicies: { s1: { read_file: true } },
  });
  // no selection at all: pre-upgrade state keeps the stored session override (acceptance 1)
  assert.equal(effectiveToolEnabled(legacy, 's1', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(legacy, 's1', 'standard', 'shell'), true);
  assert.equal(effectiveToolEnabled(legacy, 's2', 'standard', 'read_file'), false, 'other sessions keep the mode result');
  assert.equal(effectiveToolEnabled(legacy, null, 'standard', 'read_file'), false);
  // an explicit inherit selection returns to the mode result
  const inherited = toolPolicySnapshot({
    modeToolPolicies: { standard: { read_file: false } },
    sessionToolPolicies: { s1: { read_file: true } },
    sessionToolSelections: { s1: { kind: 'inherit' } },
  });
  assert.equal(effectiveToolEnabled(inherited, 's1', 'standard', 'read_file'), false);
});

test('session custom uses sessionToolPolicies as a full replacement, not an overlay', () => {
  const snapshot = snapshotOf({
    modeToolPolicies: { standard: { read_file: false, shell: true } },
    sessionToolPolicies: { s1: { shell: false } },
    sessionToolSelections: { s1: { kind: 'custom' } },
  });
  // mode disabled read_file, but the session policy replaces the mode policy entirely
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'write_file'), true);
  // a different session without a selection still follows the mode
  assert.equal(effectiveToolEnabled(snapshot, 's2', 'standard', 'read_file'), false);
});

test('a session preset fully replaces the mode policy', () => {
  const snapshot = snapshotOf({
    toolPresets: [
      { id: 'p-mode', name: 'M', defaultEnabled: false, rules: [{ modeId: 'standard', toolName: 'read_file', enabled: true }] },
      { id: 'p-session', name: 'S', defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] },
    ],
    modeToolPolicies: { standard: { write_file: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p-mode' } },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p-session' } },
  });
  // mode preset alone
  assert.equal(effectiveToolEnabled(snapshot, 'other', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, 'other', 'standard', 'write_file'), false);
  assert.equal(effectiveToolEnabled(snapshot, 'other', 'standard', 'shell'), false);
  // session preset wins wholesale: write_file=true even though mode/flat said false
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'write_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'shell'), false);
});

test('every session fallback keeps the narrower previous answer (permission-widening regression)', () => {
  const build = overrides => toolPolicySnapshot({
    toolPresets: [
      { id: 'p-mode', name: 'M', defaultEnabled: false, rules: [{ modeId: 'standard', toolName: 'read_file', enabled: true }] },
      { id: 'p-session', name: 'S', defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] },
    ],
    modeToolPolicies: { standard: { shell: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p-mode' } },
    ...overrides,
  });
  // mode result of the p-mode preset: read_file is explicitly true, everything else defaultEnabled false
  const MODE = { read_file: true, shell: false, write_file: false };
  const assertCase = (label, overrides, expected, sessionId = 's1') => {
    const snapshot = build(overrides);
    for (const [toolName, enabled] of Object.entries(expected)) {
      assert.equal(effectiveToolEnabled(snapshot, sessionId, 'standard', toolName), enabled, `${label} → ${toolName}`);
    }
  };

  assertCase('mode baseline', {}, MODE, null);
  assertCase('session preset present', {
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p-session' } },
  }, { read_file: true, shell: false, write_file: true });
  assertCase('dangling session preset with flat policy', {
    sessionToolPolicies: { s1: { read_file: false, shell: true } },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'gone' } },
  }, { read_file: false, shell: true });
  assertCase('dangling session preset without flat policy', {
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'gone' } },
  }, MODE);
  assertCase('custom without flat policy', {
    sessionToolSelections: { s1: { kind: 'custom' } },
  }, MODE);
  assertCase('custom with flat policy', {
    sessionToolPolicies: { s1: { read_file: false, shell: true } },
    sessionToolSelections: { s1: { kind: 'custom' } },
  }, { read_file: false, shell: true });
  assertCase('legacy no selection with flat policy', {
    sessionToolPolicies: { s1: { read_file: false, shell: true } },
  }, { read_file: false, shell: true });
  assertCase('no selection and no flat policy', {}, MODE);
  // an explicitly saved empty policy means "no restriction", because the key exists
  assertCase('explicit empty policy with custom', {
    sessionToolPolicies: { s1: {} },
    sessionToolSelections: { s1: { kind: 'custom' } },
  }, { read_file: true, shell: true, write_file: true });
  assertCase('explicit empty policy without selection', {
    sessionToolPolicies: { s1: {} },
  }, { read_file: true, shell: true, write_file: true });
  // inherit deliberately ignores a stored flat policy
  assertCase('inherit ignores flat policy', {
    sessionToolPolicies: { s1: { read_file: false, shell: true } },
    sessionToolSelections: { s1: { kind: 'inherit' } },
  }, MODE);
  assertCase('unknown session id', {}, MODE, 's2');
});

test('a dangling mode preset falls back to the flat mode policy, never all-on', () => {
  const snapshot = toolPolicySnapshot({
    modeToolPolicies: { standard: { shell: false, read_file: true } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'gone' } },
  });
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'write_file'), true);
  const existing = toolPolicySnapshot({
    toolPresets: [{ id: 'p1', name: 'P', defaultEnabled: false, rules: [] }],
    modeToolPolicies: { standard: { read_file: true } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  assert.equal(effectiveToolEnabled(existing, null, 'standard', 'read_file'), false, 'an existing preset still wins');
});

test('effectiveToolPolicy and effectiveToolEnabled are the same resolver', () => {
  const snapshot = snapshotOf({
    toolPresets: [
      { id: 'p1', name: 'P', defaultEnabled: false, rules: [{ modeId: 'standard', toolName: 'read_file', enabled: true }] },
      { id: 'p2', name: 'Q', defaultEnabled: true, rules: [{ modeId: 'plugin', toolName: 'plugin_tool', enabled: false }] },
    ],
    modeToolPolicies: { standard: { shell: false }, plugin: { shell: true } },
    sessionToolPolicies: { s1: { write_file: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' }, plugin: { kind: 'preset', presetId: 'p2' } },
    sessionToolSelections: {
      s1: { kind: 'custom' },
      s2: { kind: 'inherit' },
      s3: { kind: 'preset', presetId: 'p2' },
    },
  });
  const cases = [
    [null, 'standard'], ['unknown', 'standard'], ['s1', 'standard'], ['s2', 'standard'], ['s3', 'standard'],
    [null, 'plugin'], ['s1', 'plugin'], ['s2', 'plugin'], ['s3', 'plugin'], ['s3', 'other'],
  ];
  for (const [sessionId, modeId] of cases) {
    const policy = effectiveToolPolicy(snapshot, sessionId, modeId, CATALOGS.standard);
    assert.deepEqual(Object.keys(policy), ['read_file', 'write_file', 'shell']);
    for (const tool of CATALOGS.standard) {
      assert.equal(policy[tool.name], effectiveToolEnabled(snapshot, sessionId, modeId, tool.name),
        `${sessionId}/${modeId}/${tool.name}`);
    }
  }
});

test('effectiveToolPolicy builds one own key per usable catalog entry', () => {
  const snapshot = toolPolicySnapshot({});
  const policy = effectiveToolPolicy(snapshot, null, 'standard', [null, { name: 5 }, { name: 'read_file' }, undefined]);
  assert.deepEqual(policy, { read_file: true });
  assert.deepEqual(effectiveToolPolicy(snapshot, null, 'standard', undefined), {});
  assert.deepEqual(effectiveToolPolicy(snapshot, null, 'standard', 'nope'), {});
});

// ---------------------------------------------------------------------------
// expandToolPresetPolicy
// ---------------------------------------------------------------------------

test('expandToolPresetPolicy applies defaultEnabled then explicit rules for one mode only', () => {
  const body = {
    name: 'P',
    defaultEnabled: false,
    rules: [
      { modeId: 'standard', toolName: 'read_file', enabled: true },
      { modeId: 'plugin', toolName: 'plugin_tool', enabled: true },
    ],
  };
  assert.deepEqual(expandToolPresetPolicy(body, 'standard', names('read_file', 'write_file')), { read_file: true, write_file: false });
  assert.deepEqual(expandToolPresetPolicy(body, 'plugin', names('plugin_tool', 'shell')), { plugin_tool: true, shell: false });
  assert.deepEqual(expandToolPresetPolicy(body, 'other', names('read_file', 'plugin_tool')), { read_file: false, plugin_tool: false });
  assert.deepEqual(expandToolPresetPolicy({ defaultEnabled: true, rules: [] }, 'standard', names('a')), { a: true });
  assert.deepEqual(expandToolPresetPolicy(undefined, 'standard', names('a')), { a: true });
  assert.deepEqual(expandToolPresetPolicy(body, 'standard', undefined), {});
});

test('expandToolPresetPolicy never applies another mode rule with a matching tool name', () => {
  const body = {
    defaultEnabled: true,
    rules: [{ modeId: 'plugin', toolName: 'read_file', enabled: false }],
  };
  assert.deepEqual(expandToolPresetPolicy(body, 'standard', names('read_file')), { read_file: true });
});

test('expandToolPresetPolicy excludes rules the catalog does not contain', () => {
  const body = { defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'ghost', enabled: false }] };
  assert.deepEqual(expandToolPresetPolicy(body, 'standard', names('a')), { a: true });
  assert.deepEqual(expandToolPresetPolicy(body, 'standard', [null, { name: 7 }, { name: 'a' }]), { a: true });
});

// ---------------------------------------------------------------------------
// reference bookkeeping
// ---------------------------------------------------------------------------

test('presetReferenceCounts counts modes and sessions per preset and keeps every preset', () => {
  const state = {
    toolPresets: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    modeToolSelections: { m1: { kind: 'preset', presetId: 'p1' }, m2: { kind: 'custom' }, m3: { kind: 'preset', presetId: 'p1' } },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p1' }, s2: { kind: 'preset', presetId: 'p2' }, s3: { kind: 'inherit' } },
  };
  const before = structuredClone(state);
  assert.deepEqual(presetReferenceCounts(state), {
    p1: { modes: 2, sessions: 1 },
    p2: { modes: 0, sessions: 1 },
  });
  assert.deepEqual(state, before);
  assert.deepEqual(presetReferenceCounts({}), {});
  // a dangling selection is still surfaced instead of silently dropped
  assert.deepEqual(presetReferenceCounts({ modeToolSelections: { m1: { kind: 'preset', presetId: 'gone' } } }), {
    gone: { modes: 1, sessions: 0 },
  });
});

test('unresolvedToolRefs reports group and preset references the catalogs do not provide', () => {
  const state = {
    toolGroups: [
      { id: 'g1', name: 'G1', members: [member('standard', 'read_file'), member('gone', 'x')] },
      { id: 'g2', name: 'G2', members: [member('plugin', 'plugin_tool')] },
    ],
    toolPresets: [{
      id: 'p1', name: 'P1',
      rules: [
        { modeId: 'standard', toolName: 'shell', enabled: false },
        { modeId: 'standard', toolName: 'ghost', enabled: false },
      ],
    }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  };
  const before = structuredClone(state);
  assert.deepEqual(unresolvedToolRefs(state, CATALOGS), [
    { modeId: 'gone', toolName: 'x', kind: 'group', ownerId: 'g1', ownerName: 'G1' },
    { modeId: 'standard', toolName: 'ghost', kind: 'preset', ownerId: 'p1', ownerName: 'P1' },
  ]);
  assert.deepEqual(state, before);
  assert.equal(unresolvedToolRefs(state, {}).length, 5);
  assert.deepEqual(unresolvedToolRefs({}, CATALOGS), []);
});

test('groupMembersForMode keeps only members of that mode that the catalog provides', () => {
  const body = {
    id: 'g1',
    members: [
      member('standard', 'read_file'),
      member('plugin', 'plugin_tool'),
      member('standard', 'ghost'),
      member('standard', 'shell'),
    ],
  };
  assert.deepEqual(groupMembersForMode(body, 'standard', names('read_file', 'shell')), ['read_file', 'shell']);
  assert.deepEqual(groupMembersForMode(body, 'plugin', CATALOGS.plugin), ['plugin_tool']);
  assert.deepEqual(groupMembersForMode(body, 'other', CATALOGS.standard), []);
  assert.deepEqual(groupMembersForMode(undefined, 'standard', CATALOGS.standard), []);
});

test('resetPresetSelections only rewrites matching selections and keeps flat policies', () => {
  const state = normalizeToolState({
    toolPresets: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    modeToolPolicies: { standard: { read_file: false } },
    sessionToolPolicies: { s1: { read_file: false } },
    modeToolSelections: {
      m1: { kind: 'preset', presetId: 'p1' },
      m2: { kind: 'preset', presetId: 'p2' },
      m3: { kind: 'custom' },
    },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p1' }, s2: { kind: 'inherit' } },
  });
  const counts = resetPresetSelections(state, 'p1');
  assert.deepEqual(counts, { modes: 1, sessions: 1 });
  assert.deepEqual(state.modeToolSelections.m1, { kind: 'custom' });
  assert.deepEqual(state.sessionToolSelections.s1, { kind: 'inherit' });
  assert.deepEqual(state.modeToolSelections.m2, { kind: 'preset', presetId: 'p2' });
  assert.deepEqual(state.modeToolPolicies, { standard: { read_file: false } });
  assert.deepEqual(state.sessionToolPolicies, { s1: { read_file: false } });

  // after the fallback the old flat policy is in effect again: no sudden permission widening
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'read_file'), false);
  assert.deepEqual(resetPresetSelections({}, 'p1'), { modes: 0, sessions: 0 });
});

// ---------------------------------------------------------------------------
// share package helpers
// ---------------------------------------------------------------------------

test('validateToolsSection defaults a missing section and refuses to apply unknown sub-versions', () => {
  assert.deepEqual(validateToolsSection(undefined), { version: 1, applicable: true, activePresetId: null, presets: [], groups: [] });
  assert.deepEqual(validateToolsSection(null), { version: 1, applicable: true, activePresetId: null, presets: [], groups: [] });
  assert.deepEqual(validateToolsSection({}), { version: 1, applicable: true, activePresetId: null, presets: [], groups: [] });
  const future = validateToolsSection({
    version: 7,
    activePresetId: 'p',
    presets: [{ id: 'p', name: 'P' }],
    groups: [{ id: 'g', name: 'G' }],
    future: { keep: true },
  });
  assert.deepEqual(future, { version: 7, applicable: false, activePresetId: null, presets: [], groups: [] });
  assert.equal(validateToolsSection({ version: 1, activePresetId: '' }).activePresetId, null);
  assert.throws(() => validateToolsSection('nope'));
  assert.throws(() => validateToolsSection({ version: 0 }));
  assert.throws(() => validateToolsSection({ version: 1.5 }));
  assert.throws(() => validateToolsSection({ version: '1' }));
});

test('validateToolsSection accepts mismatched plugin references but checks structure', () => {
  const section = validateToolsSection({
    version: 1,
    activePresetId: 'p1',
    groups: [{
      id: 'g1', name: '读取类',
      members: [member('external-mode', 'external-tool'), member('standard', 'read_file')],
    }],
    presets: [{
      id: 'p1', name: '只读', defaultEnabled: false, groupIds: ['g1'],
      rules: [{ modeId: 'external-mode', toolName: 'external-tool', enabled: false }],
    }],
    future: { keep: true },
  });
  assert.equal(section.applicable, true);
  assert.equal(section.activePresetId, 'p1');
  assert.deepEqual(section.groups[0], {
    id: 'g1', name: '读取类', description: '', order: 100,
    members: [member('external-mode', 'external-tool'), member('standard', 'read_file')],
  });
  assert.equal(section.presets.length, 1);
  assert.equal(section.presets[0].id, 'p1');
  assert.equal(section.presets[0].defaultEnabled, false);
  assert.deepEqual(section.presets[0].groupIds, ['g1']);
  assert.deepEqual(section.presets[0].rules, [{ modeId: 'external-mode', toolName: 'external-tool', enabled: false }]);
  assert.equal(typeof section.presets[0].updatedAt, 'string');
});

test('validateToolsSection rejects duplicate, dangling and oversized package content', () => {
  const presetList = count => Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `P${index}` }));
  const groupList = count => Array.from({ length: count }, (_, index) => ({ id: `g${index}`, name: `G${index}` }));
  assert.throws(() => validateToolsSection({ version: 1, presets: [{ id: 'p', name: 'A' }, { id: 'p', name: 'B' }] }));
  assert.throws(() => validateToolsSection({ version: 1, presets: [{ id: 'p', name: 'A', groupIds: ['ghost'] }] }));
  assert.throws(() => validateToolsSection({ version: 1, activePresetId: 'nope', presets: [{ id: 'p', name: 'A' }] }));
  assert.throws(() => validateToolsSection({ version: 1, presets: 'nope' }));
  assert.throws(() => validateToolsSection({ version: 1, groups: 'nope' }));
  assert.throws(() => validateToolsSection({ version: 1, presets: [null] }));
  assert.throws(() => validateToolsSection({ version: 1, presets: [{ id: '', name: 'A' }] }));
  assert.throws(() => validateToolsSection({
    version: 1,
    presets: [{
      id: 'p', name: 'A',
      rules: [
        { modeId: 'standard', toolName: 'shell', enabled: true },
        { modeId: 'standard', toolName: 'shell', enabled: false },
      ],
    }],
  }));
  assert.throws(() => validateToolsSection({ version: 1, groups: [{ id: '@all', name: 'A' }] }));
  assert.throws(() => validateToolsSection({
    version: 1,
    groups: [
      { id: 'g1', name: 'A', members: [member('standard', 'read_file')] },
      { id: 'g2', name: 'B', members: [member('standard', 'read_file')] },
    ],
  }));
  assert.equal(validateToolsSection({ version: 1, presets: presetList(100) }).presets.length, 100);
  assert.throws(() => validateToolsSection({ version: 1, presets: presetList(101) }));
  assert.equal(validateToolsSection({ version: 1, groups: groupList(100) }).groups.length, 100);
  assert.throws(() => validateToolsSection({ version: 1, groups: groupList(101) }));
});

const PACKAGE = () => ({
  version: 1,
  activePresetId: 'p1',
  groups: [{ id: 'g1', name: '读取类', members: [member('standard', 'read_file')] }],
  presets: [{
    id: 'p1', name: '只读', defaultEnabled: true, groupIds: ['g1'],
    rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
  }],
});

test('remapToolPackage adds new rows, keeps matching ids and reports stats', () => {
  const state = { toolGroups: [], toolPresets: [] };
  const before = structuredClone(state);
  const plan = remapToolPackage(PACKAGE(), state, { catalogs: CATALOGS });
  assert.deepEqual(plan.stats, {
    groups: { added: 1, reused: 0, remapped: 0 },
    presets: { added: 1, reused: 0, remapped: 0 },
    matched: 2,
    unmatched: 0,
  });
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.tools.version, 1);
  assert.equal(plan.tools.activePresetId, 'p1');
  assert.deepEqual(plan.tools.groups.map(item => item.id), ['g1']);
  assert.deepEqual(plan.tools.groups[0].members, [member('standard', 'read_file')]);
  assert.equal(plan.tools.presets.length, 1);
  assert.equal(plan.tools.presets[0].id, 'p1');
  assert.deepEqual(plan.tools.presets[0].groupIds, ['g1']);
  assert.deepEqual(plan.tools.presets[0].rules, [{ modeId: 'standard', toolName: 'shell', enabled: false }]);
  assert.equal(typeof plan.tools.presets[0].updatedAt, 'string');
  assert.deepEqual(state, before, 'planning must not write to state');
});

test('remapToolPackage reuses rows with identical content and maps the active preset id', () => {
  const state = normalizeToolState({
    toolGroups: [{ ...group({ id: 'g1', name: '读取类' }) }],
    toolPresets: [{
      id: 'p1', name: '只读', description: '', defaultEnabled: true, groupIds: ['g1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
      updatedAt: '2000-01-01T00:00:00.000Z',
    }],
  });
  const before = structuredClone(state);
  const plan = remapToolPackage(PACKAGE(), state, { catalogs: CATALOGS });
  assert.deepEqual(plan.stats, {
    groups: { added: 0, reused: 1, remapped: 0 },
    presets: { added: 0, reused: 1, remapped: 0 },
    matched: 2,
    unmatched: 0,
  });
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.tools.presets, [], 'a reused preset is not re-added');
  assert.deepEqual(plan.tools.groups, [], 'a reused group is not re-added');
  assert.equal(plan.tools.activePresetId, 'p1', 'activePresetId follows the reused id');
  assert.deepEqual(state, before);
});

test('remapToolPackage remaps conflicting rows and rewrites in-package references', () => {
  const state = normalizeToolState({
    toolGroups: [{ id: 'g1', name: '旧组', members: [] }],
    toolPresets: [{ id: 'p1', name: '旧预设', defaultEnabled: true, groupIds: [], rules: [] }],
  });
  const before = structuredClone(state);
  const plan = remapToolPackage(PACKAGE(), state, { catalogs: CATALOGS });
  assert.deepEqual(plan.stats.groups, { added: 0, reused: 0, remapped: 1 });
  assert.deepEqual(plan.stats.presets, { added: 0, reused: 0, remapped: 1 });
  const newGroupId = plan.tools.groups[0].id;
  const newPresetId = plan.tools.presets[0].id;
  assert.match(newGroupId, UUID);
  assert.match(newPresetId, UUID);
  assert.notEqual(newGroupId, 'g1');
  assert.notEqual(newPresetId, 'p1');
  assert.deepEqual(plan.tools.presets[0].groupIds, [newGroupId], 'the rewritten group id must be used, not the original');
  assert.equal(plan.tools.activePresetId, newPresetId, 'activePresetId follows the remapped preset');
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.tools.groups[0].name, '读取类');
  assert.deepEqual(state, before);
});

test('remapToolPackage keeps untouched ids in a mixed package', () => {
  const tools = {
    version: 1,
    activePresetId: null,
    groups: [
      { id: 'g1', name: '冲突组', members: [member('standard', 'read_file')] },
      { id: 'g2', name: '新组', members: [member('standard', 'write_file')] },
    ],
    presets: [{
      id: 'p1', name: '预设', groupIds: ['g1', 'g2'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    }],
  };
  const state = normalizeToolState({ toolGroups: [{ id: 'g1', name: '别的', members: [] }] });
  const plan = remapToolPackage(tools, state, { catalogs: CATALOGS });
  assert.deepEqual(plan.stats.groups, { added: 1, reused: 0, remapped: 1 });
  assert.deepEqual(plan.stats.presets, { added: 1, reused: 0, remapped: 0 });
  const ids = plan.tools.groups.map(item => item.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes('g2'), 'non-conflicting id stays untouched');
  assert.ok(!ids.includes('g1'), 'conflicting id is replaced');
  const rewrittenGroupId = ids.find(id => id !== 'g2');
  assert.match(rewrittenGroupId, UUID);
  assert.deepEqual(plan.tools.presets[0].groupIds, [rewrittenGroupId, 'g2']);
  assert.equal(plan.tools.activePresetId, null);
});

test('remapToolPackage reuses an identical group while remapping a changed preset', () => {
  const state = normalizeToolState({
    toolGroups: [group({ id: 'g1', name: '读取类' })],
    toolPresets: [{ id: 'p1', name: '旧名字', defaultEnabled: true, groupIds: ['g1'], rules: [] }],
  });
  const plan = remapToolPackage(PACKAGE(), state, { catalogs: CATALOGS });
  assert.deepEqual(plan.stats.groups, { added: 0, reused: 1, remapped: 0 });
  assert.deepEqual(plan.stats.presets, { added: 0, reused: 0, remapped: 1 });
  assert.deepEqual(plan.tools.groups, [], 'the reused group must not be added again');
  assert.equal(plan.tools.presets.length, 1);
  assert.match(plan.tools.presets[0].id, UUID);
  assert.deepEqual(plan.tools.presets[0].groupIds, ['g1'], 'a reused group keeps its existing id');
  assert.equal(plan.tools.activePresetId, plan.tools.presets[0].id);
});

test('remapToolPackage counts matched and unmatched references and warns about mismatches', () => {
  const tools = {
    version: 1,
    activePresetId: 'p1',
    groups: [{
      id: 'g1', name: 'G1',
      members: [member('gone', 'missing_tool'), member('standard', 'read_file')],
    }],
    presets: [{
      id: 'p1', name: 'P1', groupIds: ['g1'],
      rules: [
        { modeId: 'standard', toolName: 'read_file', enabled: true },
        { modeId: 'standard', toolName: 'ghost', enabled: false },
      ],
    }],
  };
  const plan = remapToolPackage(tools, { toolGroups: [], toolPresets: [] }, { catalogs: CATALOGS });
  assert.equal(plan.stats.matched, 2);
  assert.equal(plan.stats.unmatched, 2);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /2/);
  // mismatched references are still exported so a reinstalled plugin can rematch
  assert.deepEqual(plan.tools.groups[0].members, [member('gone', 'missing_tool'), member('standard', 'read_file')]);
  assert.deepEqual(plan.tools.presets[0].rules, [
    { modeId: 'standard', toolName: 'read_file', enabled: true },
    { modeId: 'standard', toolName: 'ghost', enabled: false },
  ]);
});

test('remapToolPackage refuses an unknown sub-version and over-limit imports', () => {
  assert.throws(() => remapToolPackage({ version: 7, presets: [], groups: [] }, { toolGroups: [], toolPresets: [] }));
  const fullGroups = Array.from({ length: 100 }, (_, index) => ({ id: `g${index}`, name: `G${index}`, members: [] }));
  const fullPresets = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, name: `P${index}` }));
  assert.throws(() => remapToolPackage(PACKAGE(), { toolGroups: fullGroups, toolPresets: [] }, { catalogs: CATALOGS }));
  assert.throws(() => remapToolPackage(PACKAGE(), { toolGroups: [], toolPresets: fullPresets }, { catalogs: CATALOGS }));
});

test('exportToolsSection exports only the associated preset and the groups it references', () => {
  const state = normalizeToolState({
    toolPresets: [{
      id: 'p1', name: '只读', description: 'd', defaultEnabled: false, groupIds: ['g1', 'ghost'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }],
    toolGroups: [
      { id: 'g1', name: '读取类', description: '', order: 100, members: [member('standard', 'read_file')] },
      { id: 'g2', name: '其他', description: '', order: 100, members: [member('standard', 'write_file')] },
    ],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p1' } },
  });
  const section = exportToolsSection(state, 'p1');
  assert.deepEqual(section, {
    version: 1,
    activePresetId: 'p1',
    presets: [{
      id: 'p1', name: '只读', description: 'd', defaultEnabled: false, groupIds: ['g1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }],
    groups: [{
      id: 'g1', name: '读取类', description: '', order: 100,
      members: [member('standard', 'read_file')],
    }],
  });
  const serialized = JSON.stringify(section);
  assert.equal(serialized.includes('g2'), false, 'unrelated group leaked into the export');
  assert.equal(serialized.includes('modeToolSelections'), false);
  assert.equal(serialized.includes('sessionToolSelections'), false);

  assert.deepEqual(exportToolsSection(state, null), { version: 1, activePresetId: null, presets: [], groups: [] });
  assert.deepEqual(exportToolsSection(state, 'unknown'), { version: 1, activePresetId: null, presets: [], groups: [] });
  assert.deepEqual(exportToolsSection({}, 'p1'), { version: 1, activePresetId: null, presets: [], groups: [] });
});

test('exported sections round trip through validation into an empty state', () => {
  const state = normalizeToolState({
    toolPresets: [{
      id: 'p1', name: '只读', defaultEnabled: true, groupIds: ['g1'],
      rules: [{ modeId: 'plugin-mode', toolName: 'plugin-tool', enabled: false }],
    }],
    toolGroups: [{ id: 'g1', name: '读取类', description: '', order: 100, members: [member('plugin-mode', 'plugin-tool')] }],
  });
  const section = exportToolsSection(state, 'p1');
  const validated = validateToolsSection(section);
  assert.equal(validated.applicable, true);
  assert.equal(validated.activePresetId, 'p1');
  const plan = remapToolPackage(section, { toolGroups: [], toolPresets: [] }, { catalogs: {} });
  assert.deepEqual(plan.stats.groups, { added: 1, reused: 0, remapped: 0 });
  assert.deepEqual(plan.stats.presets, { added: 1, reused: 0, remapped: 0 });
  assert.equal(plan.stats.unmatched, 2);
  assert.equal(plan.tools.presets[0].id, 'p1');
  assert.deepEqual(plan.tools.presets[0].groupIds, ['g1']);
  // importing straight back onto the same state is a no-op reuse
  const again = remapToolPackage(section, state, { catalogs: {} });
  assert.deepEqual(again.stats, {
    groups: { added: 0, reused: 1, remapped: 0 },
    presets: { added: 0, reused: 1, remapped: 0 },
    matched: 0,
    unmatched: 2,
  });
  assert.deepEqual(again.tools.presets, []);
  assert.deepEqual(again.tools.groups, []);
});
