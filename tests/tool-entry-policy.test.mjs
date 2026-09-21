/**
 * Spec tests for the PTC / program-call entry policy (task-3).
 *
 * Three invariants are asserted here:
 *  1. every stored policy shape (mode custom, preset-based, session inherit,
 *     session custom, legacy flat session) leaves the reserved run_code entry
 *     enabled, because a program-call session whose only direct tool was
 *     removed would deadlock;
 *  2. the model-facing restriction plan hides disabled tools but never names the
 *     entry and never names a tool the host cannot restrict;
 *  3. the full editable catalog survives a restrictive policy, so a switched-off
 *     tool can be switched back on.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PresetStore } from '../lib/store.mjs';
import {
  TOOL_ENTRY_NAME, isToolEntry, toolPolicySnapshot, normalizeToolState,
  effectiveToolEnabled, effectiveToolPolicy, planToolRestriction, editableToolCatalog,
} from '../lib/tool-presets.mjs';
import { AGENT_PRESET_ID, apply } from '../index.mjs';

const ENTRY = 'run_code';
const CATALOG = [
  { name: ENTRY, description: '程序调用入口' },
  { name: 'read', description: '读取文件' },
  { name: 'shell', description: '执行命令' },
];
const toolPreset = over => ({
  id: 'p1', name: '只读', description: '', defaultEnabled: false, groupIds: [], rules: [], updatedAt: '', ...over,
});
/** Minimal stored state for the resolver; only the fields normalizeToolState touches. */
const stored = over => ({
  toolGroups: [], toolPresets: [], modeToolSelections: {}, sessionToolSelections: {},
  modeToolPolicies: {}, sessionToolPolicies: {}, ...over,
});
const snapshotOf = value => toolPolicySnapshot(normalizeToolState(stored(value)));
const policyOf = (value, sessionId) => effectiveToolPolicy(snapshotOf(value), sessionId, 'standard', CATALOG);

/* ------------------------------------------------------------------ the entry */

test('run_code is the reserved entry name and is recognised by one predicate', () => {
  assert.equal(TOOL_ENTRY_NAME, 'run_code');
  assert.equal(isToolEntry('run_code'), true);
  assert.equal(isToolEntry('read'), false);
  assert.equal(isToolEntry(''), false);
});

test('every stored policy shape leaves the run_code entry enabled', () => {
  const shapes = [
    ['mode flat policy', { modeToolPolicies: { standard: { [ENTRY]: false, read: false } } }],
    ['mode custom selection', {
      modeToolPolicies: { standard: { [ENTRY]: false, read: false } },
      modeToolSelections: { standard: { kind: 'custom' } },
    }],
    ['mode preset with defaultEnabled false', {
      toolPresets: [toolPreset({ defaultEnabled: false })],
      modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    }],
    ['mode preset with an explicit entry rule', {
      toolPresets: [toolPreset({ defaultEnabled: true, rules: [
        { modeId: 'standard', toolName: ENTRY, enabled: false },
        { modeId: 'standard', toolName: 'read', enabled: false },
      ] })],
      modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
    }],
    ['session inherit', {
      modeToolPolicies: { standard: { [ENTRY]: false, read: false } },
      modeToolSelections: { standard: { kind: 'custom' } },
      sessionToolSelections: { s1: { kind: 'inherit' } },
    }],
    ['session custom flat policy', {
      modeToolPolicies: { standard: { [ENTRY]: false } },
      sessionToolPolicies: { s1: { [ENTRY]: false, read: false } },
      sessionToolSelections: { s1: { kind: 'custom' } },
    }],
    ['session preset with an explicit entry rule', {
      toolPresets: [toolPreset({ defaultEnabled: true, rules: [
        { modeId: 'standard', toolName: ENTRY, enabled: false },
        { modeId: 'standard', toolName: 'read', enabled: false },
      ] })],
      sessionToolSelections: { s1: { kind: 'preset', presetId: 'p1' } },
    }],
    ['legacy flat session policy without a selection', {
      modeToolPolicies: { standard: { [ENTRY]: false } },
      sessionToolPolicies: { s1: { [ENTRY]: false, read: false } },
    }],
  ];
  // A preset with defaultEnabled false switches off every tool it does not
  // explicitly re-enable, so one shape legitimately reports shell as disabled.
  const shellDisabled = new Set(['mode preset with defaultEnabled false']);
  for (const [name, value] of shapes) {
    const snapshot = snapshotOf(value);
    for (const sessionId of [null, 's1', 's2']) {
      assert.equal(effectiveToolEnabled(snapshot, sessionId, 'standard', ENTRY), true, name + ' / ' + String(sessionId));
    }
    // The entry is the only thing forced: a real tool disabled at the effective
    // scope still reads as disabled, so the resolver keeps deciding normally.
    assert.equal(effectiveToolEnabled(snapshot, 's1', 'standard', 'read'), false, name + ' / read');
    assert.deepEqual(policyOf(value, 's1'),
      { [ENTRY]: true, read: false, shell: !shellDisabled.has(name) }, name + ' / policy');
  }
});

test('a mode-scope disable never rewrites the stored entry value', () => {
  const snapshot = snapshotOf({ modeToolPolicies: { standard: { [ENTRY]: false } } });
  // The resolver ignores it, but the snapshot and the stored policy keep the
  // user's value so a re-export round trips unchanged.
  assert.equal(snapshot.modes.standard[ENTRY], false);
  assert.equal(effectiveToolEnabled(snapshot, null, 'standard', ENTRY), true);
});

/* --------------------------------------------------- model-facing restriction */

test('the restriction plan hides disabled tools and never names the entry', () => {
  const snapshot = snapshotOf({ modeToolPolicies: { standard: { [ENTRY]: false, read: false } } });
  const plan = planToolRestriction(snapshot, null, 'standard', CATALOG);
  assert.deepEqual(plan, { deny: ['read'] });
  assert.equal(plan.deny.includes(ENTRY), false);
  assert.equal(plan.allow, undefined);

  // No disabled tool means no filter at all: tools.restrict({}) throws.
  const enabled = snapshotOf({ modeToolPolicies: { standard: { [ENTRY]: false, read: true, shell: true } } });
  assert.equal(planToolRestriction(enabled, null, 'standard', CATALOG), undefined);
  assert.equal(planToolRestriction(enabled, null, 'standard', []), undefined);

  // Only names the host reports as restrictable are ever named.
  assert.deepEqual(planToolRestriction(snapshot, null, 'standard', CATALOG, { restrictable: ['read', ENTRY] }), { deny: ['read'] });
  assert.deepEqual(planToolRestriction(snapshot, null, 'standard', CATALOG, { restrictable: ['shell'] }), undefined);
  assert.equal(planToolRestriction(snapshot, null, 'standard', CATALOG, { restrictable: [] }), undefined);

  // A session-scoped policy goes through the same resolver.
  const sessionScope = snapshotOf({
    modeToolPolicies: { standard: {} },
    sessionToolPolicies: { s1: { shell: false } },
    sessionToolSelections: { s1: { kind: 'custom' } },
  });
  assert.deepEqual(planToolRestriction(sessionScope, 's1', 'standard', CATALOG), { deny: ['shell'] });
  assert.equal(planToolRestriction(sessionScope, null, 'standard', CATALOG), undefined);

  // A preset that disables everything still cannot name the entry.
  const presetScope = snapshotOf({
    toolPresets: [toolPreset({ defaultEnabled: false })],
    modeToolSelections: { standard: { kind: 'preset', presetId: 'p1' } },
  });
  assert.deepEqual(planToolRestriction(presetScope, null, 'standard', CATALOG), { deny: ['read', 'shell'] });
});

/* ------------------------------------------------- full editable catalog */

test('a restricted catalog can never shrink the full editable catalog', () => {
  const full = { standard: CATALOG };
  const restricted = { standard: [{ name: ENTRY }] };
  for (const sources of [[restricted, full], [full, restricted]]) {
    const merged = editableToolCatalog(sources);
    const names = merged.standard.map(tool => tool.name);
    assert.deepEqual(names, [ENTRY, 'read', 'shell']);
  }
  // The freshest row wins for one name, so a reloaded description is used.
  const merged = editableToolCatalog([full, { standard: [{ name: 'read', description: '新的说明' }] }]);
  assert.equal(merged.standard.find(tool => tool.name === 'read').description, '新的说明');
  assert.deepEqual(merged.standard.map(tool => tool.name), [ENTRY, 'read', 'shell']);
  // Modes are unioned independently and an empty source changes nothing.
  assert.deepEqual(Object.keys(editableToolCatalog([full, {}])), ['standard']);
  assert.deepEqual(editableToolCatalog([undefined, {}]), {});
});

test('a tool disabled by policy stays editable and can be switched back on', () => {
  const disabled = snapshotOf({ modeToolPolicies: { standard: { read: false } } });
  assert.equal(effectiveToolEnabled(disabled, 's1', 'standard', 'read'), false);
  // The editor keeps the row even though the model no longer sees it.
  const editable = editableToolCatalog([{ standard: [{ name: ENTRY }] }, { standard: CATALOG }]);
  assert.equal(editable.standard.some(tool => tool.name === 'read'), true);
  assert.equal(planToolRestriction(disabled, 's1', 'standard', editable.standard).deny.includes('read'), true);

  // Re-enabling is a normal policy write and takes effect immediately.
  const enabled = snapshotOf({ modeToolPolicies: { standard: { read: true } } });
  assert.equal(effectiveToolEnabled(enabled, 's1', 'standard', 'read'), true);
  assert.equal(planToolRestriction(enabled, 's1', 'standard', editable.standard), undefined);
});

/* ------------------------------------------------------ plugin API harness */

const STANDARD_COMPOSITION = [
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
const TOOL_CATALOGS = {
  standard: CATALOG.map(tool => ({ ...tool })),
  [AGENT_PRESET_ID]: [{ name: ENTRY, description: '程序调用入口' }, { name: 'read', description: '读取文件' }],
};
const MODE_ROWS = [
  { id: 'standard', name: '标准' },
  { id: AGENT_PRESET_ID, name: '预设模式' },
];
const msg = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' } });
const stPreset = () => ({
  prompts: [{ identifier: 'chatHistory', role: 'user', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
});
const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Mirrors tests/tool-groups-api.test.mjs: apply(ctx), one API handler, Readable bodies. */
async function createHarness(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-entry-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  const store = new PresetStore(file);
  if (seed) await store.transaction(seed);
  const listeners = {};
  const calls = [];
  const disposers = [];
  const sessions = new Map([
    ['s', { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [], deriveMessages: () => [] }],
    ['t', { id: 't', header: { agentPreset: 'standard' }, snapshotEvents: () => [], deriveMessages: () => [] }],
  ]);
  let handler;
  let guard;
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    on: (event, fn) => { listeners[event] = fn; },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    webServer: { register: definition => {
      if (definition.path === '/preset-enhance/api') handler = definition.handler;
      return () => {};
    } },
    tools: {
      guard: fn => { guard = fn; return () => {}; },
      schemas: scope => TOOL_CATALOGS[String(scope).replace(/^scope:/, '')] ?? [],
    },
    commands: { register: () => () => {} },
    agentPresets: {
      readDocument: async () => ({ content: STANDARD_COMPOSITION }),
      list: async () => MODE_ROWS,
      standingKeyFor: async id => 'scope:' + id,
    },
    llm: { stream: options => listeners['llm/stream'](options, async function* () {
      calls.push(options);
      yield { type: 'finish', reason: { kind: 'completed' } };
    }) },
  };
  await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });

  const toolList = modeId => (TOOL_CATALOGS[modeId] ?? []).map(tool => ({ ...tool }));
  const names = request => (request?.tools ?? []).map(tool => tool.name);
  const send = async sessionId => {
    const before = calls.length;
    for await (const _ of ctx.llm.stream({
      sessionId, provider: 'mock', model: 'mock', messages: [msg('u', 'user', 'hello')],
      tools: toolList(sessions.get(sessionId)?.header.agentPreset ?? ''),
    })) {}
    assert.equal(calls.length, before + 1, 'request for ' + sessionId + ' was not routed');
    return calls.at(-1);
  };
  const rawPost = async body => {
    const req = Readable.from([JSON.stringify(body)]);
    req.method = 'POST';
    req.url = '/preset-enhance/api';
    req.headers = { 'content-type': 'application/json', host: 'localhost' };
    let statusCode, payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    return { statusCode, payload };
  };
  const post = async body => {
    const request = { ...body };
    if (request.revision === undefined) request.revision = (await store.read()).revision;
    const { statusCode, payload } = await rawPost(request);
    assert.equal(statusCode, 200, payload?.error);
    return payload;
  };
  const get = async sessionId => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/preset-enhance/api?sessionId=' + encodeURIComponent(sessionId ?? '');
    req.headers = { host: 'localhost' };
    let statusCode, payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    assert.equal(statusCode, 200);
    return payload;
  };
  const checkGuard = (sessionId, name) => guard({ name, agent: { session: sessions.get(sessionId) } });
  return {
    post, get, send, names, checkGuard, read: () => store.read(),
    cleanup: async () => {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function seedStandard(state) {
  state.presets.push({ id: 'st', name: '预设', preset: stPreset() });
  state.defaultPresetId = 'st';
  state.selectedPresetId = 'st';
  state.revision++;
}

test('a disabled tool leaves the request, the guard rejects it, and run_code survives both', async () => {
  const h = await createHarness(seedStandard);
  try {
    await h.post({ action: 'save-mode-tools', modeId: 'standard', policy: { [ENTRY]: false, read: false, shell: true } });
    const request = await h.send('s');
    // The entry is never dropped from the request even though the stored policy disables it.
    assert.deepEqual(h.names(request), [ENTRY, 'shell']);
    assert.equal(h.checkGuard('s', ENTRY), undefined);
    assert.equal(h.checkGuard('s', 'shell'), undefined);
    assert.match(h.checkGuard('s', 'read'), /已在预设工作台中关闭/);

    // The stored policy still records the user's value; only execution and the
    // request filter ignore it for the reserved entry.
    const state = await h.read();
    assert.equal(state.modeToolPolicies.standard[ENTRY], false);
    assert.equal(state.toolCatalogs.standard.some(tool => tool.name === ENTRY), true);
  } finally { await h.cleanup(); }
});

test('GET keeps the full editable catalog after a restrictive policy is saved', async () => {
  const h = await createHarness(seedStandard);
  try {
    await h.post({ action: 'save-mode-tools', modeId: 'standard', policy: { [ENTRY]: false, read: false, shell: true } });
    const payload = await h.get('s');
    assert.deepEqual(payload.toolCatalogs.standard.map(tool => tool.name), ['read', ENTRY, 'shell']);
    assert.equal(payload.modeToolSelections.standard.kind, 'custom');
    assert.equal(payload.modeToolPolicies.standard.read, false);
    // A restriction must never replace the catalog the editor reads.
    assert.equal(payload.toolCatalogErrors.standard, undefined);
  } finally { await h.cleanup(); }
});

test('re-enabling a previously disabled tool puts it back in the request', async () => {
  const h = await createHarness(seedStandard);
  try {
    await h.post({ action: 'save-mode-tools', modeId: 'standard', policy: { [ENTRY]: false, read: false, shell: true } });
    assert.deepEqual(h.names(await h.send('s')), [ENTRY, 'shell']);
    await h.post({ action: 'save-mode-tools', modeId: 'standard', policy: { [ENTRY]: false, read: true, shell: true } });
    assert.deepEqual(h.names(await h.send('s')), [ENTRY, 'read', 'shell']);
    assert.equal(h.checkGuard('s', 'read'), undefined);
  } finally { await h.cleanup(); }
});

test('a session override never changes another session or the mode default', async () => {
  const h = await createHarness(seedStandard);
  try {
    await h.post({ action: 'save-session-tools', sessionId: 's', policy: { [ENTRY]: false, read: false, shell: true } });
    assert.deepEqual(h.names(await h.send('s')), [ENTRY, 'shell']);
    assert.deepEqual(h.names(await h.send('t')), [ENTRY, 'read', 'shell']);
    assert.equal(h.checkGuard('t', 'read'), undefined);
    assert.match(h.checkGuard('s', 'read'), /已在预设工作台中关闭/);
    // The other session inherits the mode default, which is still unrestricted.
    const other = await h.get('t');
    assert.equal(other.sessionToolSelection, null);
    assert.equal(other.modeToolPolicies.standard ?? null, null);
  } finally { await h.cleanup(); }
});
