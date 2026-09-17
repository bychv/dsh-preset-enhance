/**
 * Independent spec tests for lib/store.mjs: legacy normalisation, dangling preset
 * fallback and round-trip persistence of the new tool-group fields.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore } from '../lib/store.mjs';
import { toolPolicySnapshot, effectiveToolEnabled, effectiveToolPolicy } from '../lib/tool-presets.mjs';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function newStore(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-store-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  if (contents !== undefined) {
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return { dir, file, store: new PresetStore(file) };
}

const member = (modeId, toolName) => ({ modeId, toolName });
const LEGACY = () => ({
  version: 1,
  revision: 4,
  defaultPresetId: null,
  selectedPresetId: null,
  deepseekBetaPrefix: true,
  prefixToolCalls: false,
  postToolPrefixMode: 'inherit',
  postToolPrefixText: '',
  prefixNonOfficialRemoveTools: true,
  autoEnableModes: ['st-preset'],
  autoEnableSince: { 'st-preset': 0 },
  toolCatalogs: { standard: [{ name: 'read_file', description: 'Read a file' }] },
  modeToolPolicies: { standard: { read_file: false, shell: true } },
  sessionToolPolicies: { 'session-1': { read_file: true } },
  presets: [],
  bindings: {},
  global: {},
  sessions: {},
});

test('a legacy state without the new fields keeps its flat policies and gains custom selections', async () => {
  const { store } = await newStore(LEGACY());
  const state = await store.read();
  assert.equal(state.version, 1);
  assert.deepEqual(state.toolGroups, []);
  assert.deepEqual(state.toolPresets, []);
  // pre-upgrade flat policies are surfaced as explicit custom selections
  assert.deepEqual(state.modeToolSelections, { standard: { kind: 'custom' } });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'custom' } });
  assert.deepEqual(state.modeToolPolicies, { standard: { read_file: false, shell: true } });
  assert.deepEqual(state.sessionToolPolicies, { 'session-1': { read_file: true } });
  assert.deepEqual(state.toolCatalogs, { standard: [{ name: 'read_file', description: 'Read a file' }] });
  assert.deepEqual(state.autoEnableModes, ['st-preset']);

  // the stored flat policies keep deciding exactly as before the upgrade
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'installed_later'), true);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), true);
  const policy = effectiveToolPolicy(snapshot, null, 'standard', [{ name: 'read_file' }, { name: 'shell' }]);
  assert.deepEqual(policy, { read_file: false, shell: true });
});

test('a legacy flat session policy keeps applying until the session explicitly inherits', async () => {
  const { store } = await newStore(LEGACY());
  const state = await store.read();
  const snapshot = toolPolicySnapshot(state);
  // session override still applies (acceptance 1) and replaces the mode policy wholesale
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'shell'), true);
  // switching the session back to inherit returns the mode result
  const inherited = { ...state, sessionToolSelections: { 'session-1': { kind: 'inherit' } } };
  assert.equal(effectiveToolEnabled(toolPolicySnapshot(inherited), 'session-1', 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(toolPolicySnapshot(inherited), 'session-1', 'standard', 'shell'), true);
  // reading never rewrote the stored policies
  assert.deepEqual(state.sessionToolPolicies, { 'session-1': { read_file: true } });
});

test('reading a store without a file returns a fresh initial state and does not create it', async () => {
  const { file, store } = await newStore();
  const state = await store.read();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.toolGroups, []);
  assert.deepEqual(state.toolPresets, []);
  assert.deepEqual(state.modeToolSelections, {});
  assert.deepEqual(state.sessionToolSelections, {});
  assert.deepEqual(state.modeToolPolicies, {});
  assert.deepEqual(state.sessionToolPolicies, {});
  assert.ok(state.autoEnableModes.includes('st-preset'));
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });

  const again = await store.read();
  assert.notEqual(again, state, 'each read must return a detached object');
  state.toolGroups.push({ id: 'g1', name: 'G', description: '', order: 100, members: [] });
  assert.deepEqual(again.toolGroups, []);
});

test('an unsupported state.version is still rejected', async () => {
  for (const version of [2, 0, '1', null, undefined]) {
    const contents = { ...LEGACY() };
    if (version === undefined) delete contents.version;
    else contents.version = version;
    const { store } = await newStore(contents);
    await assert.rejects(store.read(), /不支持的预设数据库版本/, `version ${String(version)}`);
  }
  const { store } = await newStore('{ not json');
  await assert.rejects(store.read());
});

test('transaction round-trips groups, presets and selections through the file', async () => {
  const { file, store } = await newStore(LEGACY());
  const result = await store.transaction(state => {
    state.revision += 1;
    state.toolGroups = [{
      id: 'g1', name: '读取类', description: '', order: 100,
      members: [member('standard', 'read_file')],
    }];
    state.toolPresets = [{
      id: 'p1', name: '只读', description: '', defaultEnabled: false, groupIds: ['g1'],
      rules: [{ modeId: 'standard', toolName: 'read_file', enabled: true }],
      updatedAt: '2024-05-05T00:00:00.000Z',
    }];
    state.modeToolPolicies = { standard: { shell: true } };
    state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p1' } };
    state.sessionToolSelections = { 'session-1': { kind: 'inherit' } };
    return 'done';
  });
  assert.equal(result, 'done');

  const state = await store.read();
  assert.equal(state.revision, 5);
  assert.deepEqual(state.toolGroups, [{
    id: 'g1', name: '读取类', description: '', order: 100,
    members: [member('standard', 'read_file')],
  }]);
  assert.deepEqual(state.toolPresets, [{
    id: 'p1', name: '只读', description: '', defaultEnabled: false, groupIds: ['g1'],
    rules: [{ modeId: 'standard', toolName: 'read_file', enabled: true }],
    updatedAt: '2024-05-05T00:00:00.000Z',
  }]);
  assert.deepEqual(state.modeToolSelections, { standard: { kind: 'preset', presetId: 'p1' } });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'inherit' } });

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw.toolGroups, state.toolGroups);
  assert.deepEqual(raw.toolPresets, state.toolPresets);
  assert.deepEqual(raw.modeToolSelections, state.modeToolSelections);
  assert.deepEqual(raw.sessionToolSelections, state.sessionToolSelections);

  // the persisted selection drives the resolver: defaultEnabled false + explicit read_file rule
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', 'write_file'), false);
});

test('a rewritten state is byte-stable across further reads and writes', async () => {
  const { file, store } = await newStore({
    ...LEGACY(),
    toolGroups: [{ id: 'g1', name: '读取类', members: [member('standard', 'read_file')] }],
    toolPresets: [{
      id: 'p1', name: '只读', defaultEnabled: false, groupIds: ['g1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    sessionToolSelections: { 'session-1': { kind: 'custom' } },
  });
  const first = await store.read();
  await store.transaction(state => { state.revision += 1; });
  const second = await store.read();
  await store.transaction(state => { state.revision += 1; });
  const third = await store.read();
  const withoutRevision = state => {
    const { revision, ...rest } = state;
    return rest;
  };
  assert.deepEqual(withoutRevision(second), withoutRevision(first), 'normalisation must be idempotent');
  assert.deepEqual(withoutRevision(third), withoutRevision(first));
  assert.equal(first.revision, 4);
  assert.equal(second.revision, 5);
  assert.equal(third.revision, 6);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw, third);
});

test('dangling preset selections fall back on read and never widen the stored flat policy', async () => {
  const { file, store } = await newStore({
    ...LEGACY(),
    toolPresets: [],
    modeToolPolicies: { standard: { read_file: false, shell: true } },
    sessionToolPolicies: { 'session-1': { read_file: true, shell: false } },
    modeToolSelections: { standard: { kind: 'preset', presetId: 'gone' } },
    sessionToolSelections: { 'session-1': { kind: 'preset', presetId: 'gone' } },
  });
  const state = await store.read();
  assert.deepEqual(state.modeToolSelections, { standard: { kind: 'custom' } });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'inherit' } });

  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), false);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'shell'), true);
  // the session can still opt back into its preserved flat policy
  const custom = { ...state, sessionToolSelections: { 'session-1': { kind: 'custom' } } };
  assert.equal(effectiveToolEnabled(toolPolicySnapshot(custom), 'session-1', 'standard', 'read_file'), true);
  assert.equal(effectiveToolEnabled(toolPolicySnapshot(custom), 'session-1', 'standard', 'shell'), false);

  // both flat policies survive the repair on disk
  await store.transaction(current => { current.revision += 1; });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw.modeToolPolicies, { standard: { read_file: false, shell: true } });
  assert.deepEqual(raw.sessionToolPolicies, { 'session-1': { read_file: true, shell: false } });
  assert.deepEqual(raw.modeToolSelections, { standard: { kind: 'custom' } });
  assert.deepEqual(raw.sessionToolSelections, { 'session-1': { kind: 'inherit' } });
});

test('the short-lived single-mode draft migrates and is dropped from the file', async () => {
  const { file, store } = await newStore({
    ...LEGACY(),
    toolCatalog: [{ name: 'read_file' }],
    toolPolicy: { read_file: false, shell: true },
    prefixRelayUrl: 'https://example.invalid',
  });
  const state = await store.read();
  assert.deepEqual(state.toolCatalogs['st-preset'], [{ name: 'read_file' }]);
  assert.deepEqual(state.modeToolPolicies['st-preset'], { read_file: false, shell: true });
  assert.equal('toolCatalog' in state, false);
  assert.equal('toolPolicy' in state, false);
  assert.equal('prefixRelayUrl' in state, false);

  await store.transaction(current => { current.revision += 1; });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('toolCatalog' in raw, false);
  assert.equal('toolPolicy' in raw, false);
  assert.equal('prefixRelayUrl' in raw, false);
  assert.deepEqual(raw.toolCatalogs['st-preset'], [{ name: 'read_file' }]);
});

test('unknown fields survive a read/write round trip', async () => {
  const { file, store } = await newStore({
    ...LEGACY(),
    somethingFuture: { keep: true, nested: [1, 2] },
    bindings: { 'session-1': { enabled: true, presetId: 'p' } },
  });
  const state = await store.read();
  assert.deepEqual(state.somethingFuture, { keep: true, nested: [1, 2] });
  await store.transaction(current => { current.revision += 1; });
  const roundTripped = await store.read();
  assert.deepEqual(roundTripped.somethingFuture, { keep: true, nested: [1, 2] });
  assert.deepEqual(roundTripped.bindings, { 'session-1': { enabled: true, presetId: 'p' } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).somethingFuture, { keep: true, nested: [1, 2] });
});

test('concurrent transactions are serialized and no write is lost', async () => {
  const { dir, store } = await newStore(LEGACY());
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.transaction(state => {
    state.revision += 1;
    (state.writeLog ??= []).push(index);
    return index;
  })));
  const state = await store.read();
  assert.equal(state.revision, 12);
  assert.deepEqual([...state.writeLog].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6, 7]);
  const leftovers = (await readdir(dir)).filter(name => name !== 'state.json');
  assert.deepEqual(leftovers, [], `atomic writes must not leave temp files: ${leftovers.join(', ')}`);
});

test('a failing transaction writes nothing and the queue keeps working', async () => {
  const { store } = await newStore(LEGACY());
  await assert.rejects(store.transaction(state => {
    state.toolGroups.push({ id: 'g1', name: 'G', members: [] });
    state.revision += 1;
    throw new Error('boom');
  }), /boom/);
  const state = await store.read();
  assert.deepEqual(state.toolGroups, []);
  assert.equal(state.revision, 4);
  await store.transaction(current => { current.revision += 1; });
  assert.equal((await store.read()).revision, 5);
});

test('transaction creates nested parent directories and persists the new fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-store-'));
  dirs.push(dir);
  const file = join(dir, 'nested', 'deep', 'state.json');
  const store = new PresetStore(file);
  await store.transaction(state => {
    state.toolGroups = [{ id: 'g1', name: '读取类', members: [member('standard', 'read_file')] }];
    state.toolPresets = [{ id: 'p1', name: '只读', defaultEnabled: true, groupIds: ['g1'], rules: [] }];
    state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p1' } };
    state.sessionToolSelections = { 'session-1': { kind: 'custom' } };
  });
  const state = await store.read();
  assert.deepEqual(state.toolGroups, [{ id: 'g1', name: '读取类', description: '', order: 100, members: [member('standard', 'read_file')] }]);
  assert.deepEqual(state.toolPresets, [{
    id: 'p1', name: '只读', description: '', defaultEnabled: true, groupIds: ['g1'], rules: [], updatedAt: '',
  }]);
  assert.deepEqual(state.modeToolSelections, { standard: { kind: 'preset', presetId: 'p1' } });
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'custom' } });
});

test('prototype keys in the stored file round trip without polluting Object.prototype', async () => {
  const contents = '{"version":1,"revision":0,"toolGroups":[],' +
    '"toolPresets":[{"id":"__proto__","name":"P"}],' +
    '"modeToolSelections":{"__proto__":{"kind":"preset","presetId":"__proto__"}},' +
    '"sessionToolSelections":{"constructor":{"kind":"preset","presetId":"__proto__"}},' +
    '"modeToolPolicies":{},"sessionToolPolicies":{}}';
  const { file, store } = await newStore(contents);
  const state = await store.read();

  assert.equal(Object.getPrototypeOf(state.modeToolSelections), Object.prototype);
  assert.equal(Object.hasOwn(state.modeToolSelections, '__proto__'), true);
  assert.equal(Object.hasOwn(state.sessionToolSelections, 'constructor'), true);
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, 'constructor', '__proto__', 'read_file'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'read_file'), false);
  assert.equal(Object.prototype.kind, undefined);

  await store.transaction(current => { current.revision += 1; });
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(written.modeToolSelections, '__proto__'), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(written.modeToolSelections, '__proto__').value,
    { kind: 'preset', presetId: '__proto__' });
  assert.deepEqual(written.toolPresets, [{ id: '__proto__', name: 'P', description: '', defaultEnabled: true, groupIds: [], rules: [], updatedAt: '' }]);
});

test('invalid selection kinds stored on disk are repaired per scope', async () => {
  const { store } = await newStore({
    ...LEGACY(),
    toolPresets: [{ id: 'p1', name: 'P1' }],
    modeToolSelections: { m1: { kind: 'preset', presetId: 'p1' }, m2: { kind: 'inherit' }, m3: { kind: 'nope' } },
    sessionToolSelections: { s1: { kind: 'preset', presetId: 'p1' }, s2: { kind: 'custom' }, s3: { kind: 'preset', presetId: 'missing' } },
  });
  const state = await store.read();
  assert.deepEqual(state.modeToolSelections, {
    m1: { kind: 'preset', presetId: 'p1' },
    m2: { kind: 'custom' },
    m3: { kind: 'custom' },
    standard: { kind: 'custom' },
  });
  assert.deepEqual(state.sessionToolSelections, {
    s1: { kind: 'preset', presetId: 'p1' },
    s2: { kind: 'custom' },
    s3: { kind: 'inherit' },
    'session-1': { kind: 'custom' },
  });
});

test('a stored custom session selection without a saved policy keeps the mode result', async () => {
  const { store } = await newStore({
    ...LEGACY(),
    modeToolPolicies: { standard: { shell: false } },
    sessionToolPolicies: {},
    modeToolSelections: { standard: { kind: 'custom' } },
    sessionToolSelections: { 'session-1': { kind: 'custom' } },
  });
  const state = await store.read();
  assert.deepEqual(state.sessionToolSelections, { 'session-1': { kind: 'custom' } });
  assert.deepEqual(state.sessionToolPolicies, {});
  // 会话范围切到「自定义」但从未保存开关时，必须沿用模式结果，不能整表放开
  const snapshot = toolPolicySnapshot(state);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'shell'), false);
  assert.equal(effectiveToolEnabled(snapshot, 'session-1', 'standard', 'read_file'), true);

  // 显式保存的空策略对象表示「无限制」，因为键存在
  const explicit = { ...state, sessionToolPolicies: { 'session-1': {} } };
  assert.equal(effectiveToolEnabled(toolPolicySnapshot(explicit), 'session-1', 'standard', 'shell'), true);
});

