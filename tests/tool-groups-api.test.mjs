import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PresetStore } from '../lib/store.mjs';
import { AGENT_PRESET_ID, apply, mcpToolGroups } from '../index.mjs';

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
  standard: [
    { name: 'read', description: 'Read a file' },
    { name: 'shell', description: 'Run a command' },
    { name: 'write', description: 'Write a file' },
  ],
  'plugin-mode': [
    { name: 'plugin.custom', description: 'Third-party tool' },
    { name: 'shell', description: 'Plugin shell' },
  ],
  [AGENT_PRESET_ID]: [
    { name: 'read', description: 'Read a file' },
    { name: 'shell', description: 'Run a command' },
  ],
};
const MODE_ROWS = [
  { id: 'standard', name: '标准' },
  { id: 'plugin-mode', name: '插件模式' },
  { id: AGENT_PRESET_ID, name: '预设模式' },
  { id: 'broken-mode', name: '故障模式', broken: 'composition missing' },
];
const msg = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' } });
const stPreset = () => ({
  prompts: [{ identifier: 'chatHistory', role: 'user', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
});

/** Mirrors tests/core.test.mjs: apply(ctx), one registered API handler, Readable.from bodies. */
async function createHarness(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-groups-'));
  const file = join(dir, 'state.json');
  const store = new PresetStore(file);
  if (seed) await store.transaction(seed);
  const listeners = {};
  const calls = [];
  const disposers = [];
  const sessions = new Map([
    ['s', { id: 's', header: { agentPreset: 'standard' }, snapshotEvents: () => [] }],
    ['p', { id: 'p', header: { agentPreset: 'plugin-mode' }, snapshotEvents: () => [] }],
    // A session id that is also an Object.prototype key proves `assign`-based maps stay own-property only.
    ['__proto__', { id: '__proto__', header: { agentPreset: 'standard' }, snapshotEvents: () => [] }],
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
      standingKeyFor: async id => `scope:${id}`,
    },
    llm: { stream: options => listeners['llm/stream'](options, async function* () {
      calls.push(options);
      yield { type: 'finish', reason: { kind: 'completed' } };
    }) },
  };
  await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });

  const modeOf = sessionId => sessions.get(sessionId)?.header.agentPreset ?? '';
  const toolList = modeId => (TOOL_CATALOGS[modeId] ?? []).map(tool => ({ ...tool }));
  const names = request => (request?.tools ?? []).map(tool => tool.name);
  const send = async (sessionId = 's', tools = toolList(modeOf(sessionId))) => {
    const before = calls.length;
    for await (const _ of ctx.llm.stream({
      sessionId, provider: 'mock', model: 'mock', messages: [msg('u', 'user', 'hello')], tools,
    })) {}
    assert.equal(calls.length, before + 1, `request for session ${sessionId} was not routed`);
    return calls.at(-1);
  };
  const rawPost = async (body, sessionId = '') => {
    const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]);
    req.method = 'POST';
    req.url = '/preset-enhance/api' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '');
    req.headers = { 'content-type': 'application/json', host: 'localhost' };
    let statusCode, payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    return { statusCode, payload };
  };
  const post = async (body, sessionId = '') => {
    const request = { ...body };
    if (request.revision === undefined) request.revision = (await store.read()).revision;
    const { statusCode, payload } = await rawPost(request, sessionId);
    assert.equal(statusCode, 200, payload?.error);
    return payload;
  };
  const get = async (sessionId = '') => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = `/preset-enhance/api${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`;
    req.headers = { host: 'localhost' };
    let statusCode, payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    assert.equal(statusCode, 200);
    return payload;
  };
  const checkGuard = (sessionId, name) => guard({ name, agent: { session: sessions.get(sessionId) } });
  return {
    ctx, store, post, rawPost, get, send, checkGuard, names, toolList, sessions,
    read: () => store.read(),
    cleanup: async () => {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const packageDocument = tools => ({
  format: 'dsh-preset-enhance',
  version: 1,
  metadata: { name: '分享包', description: '保留我' },
  preset: { format: 'sillytavern', data: stPreset() },
  prefill: { enabled: false, toolCalls: false, removeNonOfficialTools: true, postToolPrefix: { mode: 'inherit', text: '' } },
  tools,
  extensions: { 'external-plugin': { opaque: true } },
  future: { keep: 'me' },
});
const toolSection = () => ({
  version: 1,
  activePresetId: 'tp1',
  presets: [{
    id: 'tp1', name: '只读', description: '', defaultEnabled: false, groupIds: ['tg1'],
    rules: [
      { modeId: 'standard', toolName: 'read', enabled: true },
      { modeId: 'gone-mode', toolName: 'lost', enabled: false },
    ],
  }],
  groups: [{
    id: 'tg1', name: '读取类', description: '', order: 5,
    members: [{ modeId: 'standard', toolName: 'read' }, { modeId: 'gone-mode', toolName: 'lost' }],
  }],
});

test('legacy flat policies stay authoritative and equal tool names resolve per mode', async () => {
  const h = await createHarness(state => {
    state.modeToolPolicies.standard = { shell: false };
    state.modeToolPolicies['plugin-mode'] = { 'plugin.custom': false };
    state.sessionToolPolicies.s = { shell: true, read: false };
    state.revision++;
  });
  try {
    // A legacy session policy with no stored selection still overrides the mode default.
    assert.deepEqual(h.names(await h.send('s')), ['shell', 'write']);
    assert.equal(h.checkGuard('s', 'shell'), undefined);
    assert.match(h.checkGuard('s', 'read'), /已在预设工作台中关闭/);

    // The same tool name on another mode resolves independently.
    assert.deepEqual(h.names(await h.send('p')), ['shell']);
    assert.equal(h.checkGuard('p', 'shell'), undefined);
    assert.match(h.checkGuard('p', 'plugin.custom'), /已在预设工作台中关闭/);

    // Every pre-existing GET field survives, plus the new tool workbench fields.
    const payload = await h.get('s');
    for (const key of ['revision', 'presets', 'binding', 'selectedPresetId', 'postToolPrefixMode', 'postToolPrefixText',
      'deepseekBetaPrefix', 'prefixToolCalls', 'prefixNonOfficialRemoveTools', 'modeDefaultPresetId', 'modeDefaultName',
      'presetMode', 'sessionMode', 'agentModes', 'autoEnableModes', 'toolCatalogs', 'toolCatalogErrors',
      'modeToolPolicies', 'sessionToolPolicy', 'last', 'toolGroups', 'toolPresets', 'modeToolSelections',
      'sessionToolSelection', 'toolPresetRefCounts', 'unresolvedToolRefs', 'mcpToolGroups']) {
      assert.equal(key in payload, true, `GET lost ${key}`);
    }
    assert.deepEqual(payload.sessionToolPolicy, { shell: true, read: false });
    assert.deepEqual(payload.sessionToolSelection, { kind: 'custom' });
    assert.deepEqual(payload.modeToolSelections.standard, { kind: 'custom' });
    assert.deepEqual(payload.toolCatalogs.standard.map(tool => tool.name), ['read', 'shell', 'write']);
    assert.equal(payload.toolCatalogErrors['broken-mode'], 'composition missing');
  } finally { await h.cleanup(); }
});

test('preset defaultEnabled, explicit rules, new catalog tools and flat saves merge per mode', async () => {
  const h = await createHarness(state => {
    state.modeToolPolicies['plugin-mode'] = { 'plugin.custom': false };
    state.revision++;
  });
  try {
    const readOnly = await h.post({ action: 'save-tool-preset', preset: {
      name: '只读', defaultEnabled: false, groupIds: [],
      rules: [{ modeId: 'standard', toolName: 'read', enabled: true }],
    } });
    assert.deepEqual(readOnly.warnings, []);
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: readOnly.id } });
    assert.deepEqual(h.names(await h.send('s')), ['read']);
    assert.equal(h.checkGuard('s', 'read'), undefined);
    assert.match(h.checkGuard('s', 'write'), /已在预设工作台中关闭/);

    // A tool that only appears in the catalog later inherits defaultEnabled.
    const future = await h.send('s', h.toolList('standard').concat([{ name: 'newtool', description: 'Later' }]));
    assert.deepEqual(h.names(future), ['read']);
    assert.match(h.checkGuard('s', 'newtool'), /已在预设工作台中关闭/);

    const allButShell = await h.post({ action: 'save-tool-preset', preset: {
      name: '全开除 shell', defaultEnabled: true, groupIds: [],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    } });
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: allButShell.id } });
    const expanded = await h.send('s', h.toolList('standard').concat([{ name: 'newtool', description: 'Later' }]));
    assert.deepEqual(h.names(expanded), ['read', 'write', 'newtool']);
    assert.match(h.checkGuard('s', 'shell'), /已在预设工作台中关闭/);

    // Standard's preset must not touch plugin-mode, which has its own flat default.
    assert.deepEqual(h.names(await h.send('p')), ['shell']);
    assert.equal(h.checkGuard('p', 'shell'), undefined);
    assert.match(h.checkGuard('p', 'plugin.custom'), /已在预设工作台中关闭/);

    // Saving flat switches explicitly back to custom and stops using the selected preset.
    const saved = await h.post({ action: 'save-mode-tools', modeId: 'standard', policy: { read: false } });
    assert.deepEqual(saved.selection, { kind: 'custom' });
    assert.deepEqual(h.names(await h.send('s')), ['shell', 'write']);
    assert.deepEqual((await h.read()).modeToolSelections.standard, { kind: 'custom' });

    // Selecting the preset again and then custom toggles between the two sources.
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: readOnly.id } });
    assert.deepEqual(h.names(await h.send('s')), ['read']);
    const flipped = await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'custom' } });
    assert.deepEqual(flipped.selection, { kind: 'custom' });
    assert.deepEqual(h.names(await h.send('s')), ['shell', 'write']);
  } finally { await h.cleanup(); }
});

test('live session tools shown by GET can be saved for the session and its mode', async () => {
  const h = await createHarness();
  try {
    const dynamic = { name: 'plugin.dynamic', description: 'Added by a session plugin' };
    h.ctx.agents = {
      get: id => id === 's' ? {
        ctx: { tools: { schemas: () => [...TOOL_CATALOGS.standard, dynamic] } },
      } : undefined,
    };
    const shown = await h.get('s');
    assert.deepEqual(shown.toolCatalogs.standard.map(tool => tool.name),
      ['plugin.dynamic', 'read', 'shell', 'write']);
    const policy = { 'plugin.dynamic': false, read: true, shell: true, write: true };

    await h.post({ action: 'save-session-tools', sessionId: 's', policy });
    assert.deepEqual((await h.get('s')).sessionToolPolicy, policy);
    assert.deepEqual((await h.read()).sessionToolSelections.s, { kind: 'custom' });

    await h.post({ action: 'save-mode-tools', modeId: 'standard', policy }, 's');
    assert.deepEqual((await h.read()).modeToolPolicies.standard, policy);
  } finally { await h.cleanup(); }
});

test('MCP tools are exposed as stable per-server groups without mixing ordinary tools', async () => {
  const catalogs = {
    standard: [
      { name: 'read', description: 'ordinary' },
      { name: 'mcp__github__create_issue', description: 'MCP' },
      { name: 'mcp__drive-1__search', description: 'MCP' },
      { name: 'mcp__github__list_issues', description: 'MCP' },
      { name: 'mcp__github__create_issue', description: 'duplicate ignored' },
      { name: 'mcp__bad.server__ignored', description: 'invalid namespace' },
    ],
  };
  assert.deepEqual(mcpToolGroups(catalogs), {
    standard: [
      { serverName: 'drive-1', tools: ['mcp__drive-1__search'] },
      { serverName: 'github', tools: ['mcp__github__create_issue', 'mcp__github__list_issues'] },
    ],
  });

  const h = await createHarness();
  try {
    h.ctx.agents = {
      get: id => id === 's' ? { ctx: { tools: { schemas: () => catalogs.standard } } } : undefined,
    };
    const state = await h.get('s');
    assert.deepEqual(state.mcpToolGroups, mcpToolGroups(catalogs));
  } finally { await h.cleanup(); }
});

test('request schema and execution guard always agree on the same snapshot', async () => {
  const h = await createHarness();
  try {
    const preset = await h.post({ action: 'save-tool-preset', preset: {
      name: '混合', defaultEnabled: true,
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }, { modeId: 'standard', toolName: 'write', enabled: false }],
    } });
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's', selection: { kind: 'preset', presetId: preset.id } });

    const request = await h.send('s');
    const enabled = new Set(h.names(request));
    assert.deepEqual([...enabled], ['read']);
    for (const tool of h.toolList('standard')) {
      assert.equal(h.checkGuard('s', tool.name) === undefined, enabled.has(tool.name), `schema/guard mismatch for ${tool.name}`);
    }
    // The rejection text is unchanged for a disabled tool.
    assert.equal(h.checkGuard('s', 'shell'), '工具 shell 已在预设工作台中关闭');
  } finally { await h.cleanup(); }
});

test('session custom with nothing stored behind it never widens a mode preset', async () => {
  const h = await createHarness();
  try {
    const preset = await h.post({ action: 'save-tool-preset', preset: { name: '只读', defaultEnabled: true,
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }] } });
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: preset.id } });
    assert.equal((await h.read()).sessionToolPolicies.s, undefined);

    // select-tool-policy writes only the selection, so custom has no policy of its own yet.
    const flipped = await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's', selection: { kind: 'custom' } });
    assert.deepEqual(flipped.selection, { kind: 'custom' });
    const stored = await h.read();
    assert.deepEqual(stored.sessionToolSelections.s, { kind: 'custom' });
    assert.equal(stored.sessionToolPolicies.s, undefined);

    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);
    assert.match(h.checkGuard('s', 'shell'), /已在预设工作台中关闭/);
    assert.equal(h.checkGuard('s', 'read'), undefined);

    // An explicitly saved empty policy is a real custom choice and enables everything.
    await h.post({ action: 'save-session-tools', sessionId: 's', policy: {} });
    assert.equal(h.checkGuard('s', 'shell'), undefined);
    assert.deepEqual(h.names(await h.send('s')), ['read', 'shell', 'write']);
  } finally { await h.cleanup(); }
});

test('session switches inherit, custom, preset A and preset B; each takes effect next request', async () => {
  const h = await createHarness(state => { state.modeToolPolicies.standard = { write: false }; state.revision++; });
  try {
    const presetA = await h.post({ action: 'save-tool-preset', preset: {
      name: 'A', defaultEnabled: true, rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    } });
    const presetB = await h.post({ action: 'save-tool-preset', preset: {
      name: 'B', defaultEnabled: false, rules: [{ modeId: 'standard', toolName: 'read', enabled: true }],
    } });

    // inherit (no session selection) -> mode default {write:false}
    assert.deepEqual(h.names(await h.send('s')), ['read', 'shell']);
    assert.equal((await h.get('s')).sessionToolSelection, null);

    // session preset A fully replaces the mode policy: write comes back on.
    const selected = await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's',
      selection: { kind: 'preset', presetId: presetA.id } });
    assert.deepEqual(selected.selection, { kind: 'preset', presetId: presetA.id });
    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);
    assert.match(h.checkGuard('s', 'shell'), /已在预设工作台中关闭/);
    assert.deepEqual((await h.get('s')).toolPresetRefCounts[presetA.id], { modes: 0, sessions: 1 });

    // session preset B
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's',
      selection: { kind: 'preset', presetId: presetB.id } });
    assert.deepEqual(h.names(await h.send('s')), ['read']);
    assert.match(h.checkGuard('s', 'write'), /已在预设工作台中关闭/);

    // custom flat session policy replaces the mode default entirely
    await h.post({ action: 'save-session-tools', sessionId: 's', policy: { shell: true, read: false, write: false } });
    assert.deepEqual(h.names(await h.send('s')), ['shell']);
    assert.deepEqual((await h.get('s')).sessionToolSelection, { kind: 'custom' });

    // another session's selection is never reflected in this one
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 'p',
      selection: { kind: 'preset', presetId: presetA.id } });
    const sPayload = await h.get('s');
    assert.deepEqual(sPayload.sessionToolSelection, { kind: 'custom' });
    assert.equal('sessionToolSelections' in sPayload, false);
    assert.deepEqual(sPayload.toolPresetRefCounts[presetA.id], { modes: 0, sessions: 1 });
    assert.deepEqual((await h.get('p')).sessionToolSelection, { kind: 'preset', presetId: presetA.id });

    // selecting a preset again keeps the stored flat policy, which resumes with custom
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's',
      selection: { kind: 'preset', presetId: presetA.id } });
    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's', selection: { kind: 'custom' } });
    assert.deepEqual(h.names(await h.send('s')), ['shell']);

    // inherit clears both the selection and the session policy
    await h.post({ action: 'save-session-tools', sessionId: 's', inherit: true });
    assert.deepEqual(h.names(await h.send('s')), ['read', 'shell']);
    const after = await h.get('s');
    assert.equal(after.sessionToolSelection, null);
    assert.equal(after.sessionToolPolicy, null);
    const stored = await h.read();
    assert.equal(stored.sessionToolPolicies.s, undefined);
    assert.equal(stored.sessionToolSelections.s, undefined);
  } finally { await h.cleanup(); }
});

test('editing a preset updates every mode and session reference on the next request', async () => {
  const h = await createHarness();
  try {
    const preset = await h.post({ action: 'save-tool-preset', preset: {
      name: '共享', defaultEnabled: true,
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }, { modeId: 'plugin-mode', toolName: 'plugin.custom', enabled: false }],
    } });
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: preset.id } });
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 'p', selection: { kind: 'preset', presetId: preset.id } });
    assert.deepEqual((await h.get('s')).toolPresetRefCounts[preset.id], { modes: 1, sessions: 1 });

    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);
    assert.deepEqual(h.names(await h.send('p')), ['shell']);

    const edited = await h.post({ action: 'save-tool-preset', id: preset.id, preset: {
      name: '共享', defaultEnabled: true,
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }, { modeId: 'plugin-mode', toolName: 'shell', enabled: false }],
    } });
    assert.equal(edited.id, preset.id);
    assert.equal((await h.read()).toolPresets.length, 1);
    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);
    assert.deepEqual(h.names(await h.send('p')), ['plugin.custom']);
    assert.match(h.checkGuard('p', 'shell'), /已在预设工作台中关闭/);
  } finally { await h.cleanup(); }
});

test('deleting a group keeps every rule; deleting a preset falls back and keeps flat policies', async () => {
  const h = await createHarness(state => {
    state.modeToolPolicies.standard = { write: false };
    state.sessionToolPolicies.s = { read: false };
    state.revision++;
  });
  try {
    const saved = await h.post({ action: 'save-tool-groups', groups: [{
      id: 'g1', name: '读取类', description: '', order: 10,
      members: [{ modeId: 'standard', toolName: 'read' }, { modeId: 'standard', toolName: 'shell' }],
    }] });
    assert.deepEqual(saved.warnings, []);
    assert.equal(saved.groups.length, 1);
    const preset = await h.post({ action: 'save-tool-preset', preset: {
      name: '组引用', defaultEnabled: true, groupIds: ['g1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    } });
    await h.post({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard', selection: { kind: 'preset', presetId: preset.id } });
    await h.post({ action: 'select-tool-policy', scope: 'session', sessionId: 's', selection: { kind: 'preset', presetId: preset.id } });
    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);

    // Deleting the group only drops membership; flat and preset rules survive.
    const removedGroup = await h.post({ action: 'save-tool-groups', groups: [] });
    assert.deepEqual(removedGroup.groups, []);
    const afterGroup = await h.read();
    assert.deepEqual(afterGroup.modeToolPolicies.standard, { write: false });
    assert.deepEqual(afterGroup.sessionToolPolicies.s, { read: false });
    assert.deepEqual(afterGroup.toolPresets.find(item => item.id === preset.id).rules, [
      { modeId: 'standard', toolName: 'shell', enabled: false },
    ]);
    assert.deepEqual(h.names(await h.send('s')), ['read', 'write']);

    // Deleting the referenced preset falls back to custom/inherit and keeps the flat policies.
    const deleted = await h.post({ action: 'delete-tool-preset', id: preset.id });
    assert.deepEqual(deleted, { id: preset.id, modes: 1, sessions: 1 });
    const afterPreset = await h.read();
    assert.deepEqual(afterPreset.toolPresets, []);
    assert.deepEqual(afterPreset.modeToolSelections.standard, { kind: 'custom' });
    assert.deepEqual(afterPreset.sessionToolSelections.s, { kind: 'inherit' });
    assert.deepEqual(afterPreset.modeToolPolicies.standard, { write: false });
    assert.deepEqual(afterPreset.sessionToolPolicies.s, { read: false });
    assert.deepEqual(h.names(await h.send('s')), ['read', 'shell']);
    assert.equal((await h.get('s')).sessionToolPolicy.read, false);

    const again = await h.rawPost({ revision: afterPreset.revision, action: 'delete-tool-preset', id: preset.id });
    assert.equal(again.statusCode, 400);
  } finally { await h.cleanup(); }
});

test('GET reports unresolved refs and keeps existing unmatched references editable', async () => {
  const h = await createHarness(state => {
    state.toolGroups = [{ id: 'old', name: '旧组', description: '', order: 100,
      members: [{ modeId: 'gone-mode', toolName: 'lost' }] }];
    state.toolPresets = [{ id: 'tp', name: '只读', description: '', defaultEnabled: false, groupIds: ['old'],
      rules: [{ modeId: 'standard', toolName: 'read', enabled: true }], updatedAt: '2026-01-01T00:00:00.000Z' }];
    state.modeToolSelections.standard = { kind: 'preset', presetId: 'tp' };
    state.sessionToolSelections.s = { kind: 'preset', presetId: 'tp' };
    state.sessionToolSelections.p = { kind: 'inherit' };
    state.revision++;
  });
  try {
    const payload = await h.get('s');
    assert.deepEqual(payload.toolGroups[0].members, [{ modeId: 'gone-mode', toolName: 'lost' }]);
    assert.deepEqual(payload.toolPresets.map(item => item.id), ['tp']);
    assert.deepEqual(payload.modeToolSelections.standard, { kind: 'preset', presetId: 'tp' });
    assert.deepEqual(payload.sessionToolSelection, { kind: 'preset', presetId: 'tp' });
    assert.deepEqual(payload.toolPresetRefCounts.tp, { modes: 1, sessions: 1 });
    assert.deepEqual(payload.unresolvedToolRefs, [
      { modeId: 'gone-mode', toolName: 'lost', kind: 'group', ownerId: 'old', ownerName: '旧组' },
    ]);
    assert.deepEqual((await h.get('p')).sessionToolSelection, { kind: 'inherit' });

    // The unmatched member may stay, but a brand new unmatched reference is rejected.
    const renamed = await h.post({ action: 'save-tool-groups', groups: [{
      id: 'old', name: '旧组改名', description: '', order: 100,
      members: [{ modeId: 'gone-mode', toolName: 'lost' }, { modeId: 'standard', toolName: 'read' }],
    }] });
    assert.equal(renamed.groups[0].name, '旧组改名');
    assert.equal(renamed.warnings.length, 1);
    assert.match(renamed.warnings[0], /1 条工具引用/);
    const rejected = await h.rawPost({ revision: (await h.read()).revision, action: 'save-tool-groups', groups: [{
      id: 'new', name: '新组', members: [{ modeId: 'gone-mode', toolName: 'another' }],
    }] });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.payload.error, /不属于已知目录/);
  } finally { await h.cleanup(); }
});

test('package import never applies tools; explicit import remaps conflicts and preserves unknown fields', async () => {
  const h = await createHarness();
  try {
    const source = packageDocument(toolSection());
    const imported = await h.post({ action: 'import', document: source, name: 'filename' });
    let state = await h.read();
    assert.deepEqual(state.toolGroups, []);
    assert.deepEqual(state.toolPresets, []);
    assert.deepEqual(state.modeToolPolicies, {});
    assert.deepEqual(state.sessionToolPolicies, {});
    assert.deepEqual(state.modeToolSelections, {});
    assert.deepEqual(state.sessionToolSelections, {});
    assert.deepEqual(state.presets.find(item => item.id === imported.id).sharePackage, source);
    assert.deepEqual(await h.post({ action: 'export-package', id: imported.id }), source);

    // dryRun only reports the plan and writes nothing at all.
    const beforeDry = await h.read();
    const preview = await h.post({ action: 'import-package-tools', id: imported.id, dryRun: true });
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.stats, {
      groups: { added: 1, reused: 0, remapped: 0 },
      presets: { added: 1, reused: 0, remapped: 0 },
      matched: 2,
      unmatched: 2,
    });
    assert.equal(preview.groups[0].id, 'tg1');
    assert.equal(preview.presets[0].id, 'tp1');
    assert.deepEqual(await h.read(), beforeDry);

    // The explicit action writes groups and presets but still applies no selection anywhere.
    const applied = await h.post({ action: 'import-package-tools', id: imported.id });
    assert.equal(applied.applied, true);
    state = await h.read();
    assert.equal(state.revision, beforeDry.revision + 1);
    assert.deepEqual(state.toolGroups.map(group => group.id), ['tg1']);
    assert.deepEqual(state.toolGroups[0].members.map(member => `${member.modeId}/${member.toolName}`),
      ['standard/read', 'gone-mode/lost']);
    assert.deepEqual(state.toolPresets.map(preset => preset.id), ['tp1']);
    assert.deepEqual(state.modeToolSelections, {});
    assert.deepEqual(state.sessionToolSelections, {});
    assert.deepEqual(state.modeToolPolicies, {});
    assert.deepEqual(state.sessionToolPolicies, {});
    assert.deepEqual(await h.post({ action: 'export-package', id: imported.id }), source);

    // Same ids with different content get fresh UUIDs and in-package references follow.
    const conflicting = packageDocument({
      ...toolSection(),
      presets: [{
        id: 'tp1', name: '只读二号', description: '', defaultEnabled: true, groupIds: ['tg1'],
        rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
      }],
      groups: [{
        id: 'tg1', name: '读取类二号', description: '', order: 9,
        members: [{ modeId: 'standard', toolName: 'shell' }],
      }],
    });
    const second = await h.post({ action: 'import', document: conflicting, name: 'second' });
    const remapped = await h.post({ action: 'import-package-tools', id: second.id });
    assert.deepEqual(remapped.stats.groups, { added: 0, reused: 0, remapped: 1 });
    assert.deepEqual(remapped.stats.presets, { added: 0, reused: 0, remapped: 1 });
    state = await h.read();
    assert.equal(state.toolGroups.length, 2);
    assert.equal(state.toolPresets.length, 2);
    const addedGroup = state.toolGroups.find(group => group.id !== 'tg1');
    const addedPreset = state.toolPresets.find(preset => preset.id !== 'tp1');
    assert.notEqual(addedGroup.id, 'tg1');
    assert.notEqual(addedPreset.id, 'tp1');
    assert.equal(addedPreset.name, '只读二号');
    assert.deepEqual(addedPreset.groupIds, [addedGroup.id]);
    assert.deepEqual(state.sessionToolSelections, {});

    // Unknown tools.version round-trips untouched but refuses application.
    const future = packageDocument({
      version: 7, activePresetId: 'p', presets: [], groups: [], future: { keep: true },
    });
    const futureImport = await h.post({ action: 'import', document: future, name: 'future' });
    assert.deepEqual(await h.post({ action: 'export-package', id: futureImport.id }), future);
    const refused = await h.rawPost({
      revision: (await h.read()).revision, action: 'import-package-tools', id: futureImport.id,
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.payload.error, /暂不支持应用/);
  } finally { await h.cleanup(); }
});

test('export-package builds a tools section from a tool preset and keeps packages without one', async () => {
  const h = await createHarness();
  try {
    await h.post({ action: 'save-tool-groups', groups: [{
      id: 'tg1', name: '读取类', description: '', order: 3,
      members: [{ modeId: 'standard', toolName: 'read' }],
    }] });
    const preset = await h.post({ action: 'save-tool-preset', preset: {
      name: '只读', description: '', defaultEnabled: false, groupIds: ['tg1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    } });
    const record = await h.post({ action: 'save', name: '对话预设', preset: stPreset() });

    const document = await h.post({ action: 'export-package', id: record.id, name: '分享', preset: stPreset(), toolPresetId: preset.id });
    assert.equal(document.tools.version, 1);
    assert.equal(document.tools.activePresetId, preset.id);
    assert.deepEqual(document.tools.presets.map(item => ({
      id: item.id, name: item.name, defaultEnabled: item.defaultEnabled, groupIds: item.groupIds, rules: item.rules,
    })), [{
      id: preset.id, name: '只读', defaultEnabled: false, groupIds: ['tg1'],
      rules: [{ modeId: 'standard', toolName: 'shell', enabled: false }],
    }]);
    assert.deepEqual(document.tools.groups.map(item => ({
      id: item.id, name: item.name, description: item.description, order: item.order, members: item.members,
    })), [{
      id: 'tg1', name: '读取类', description: '', order: 3, members: [{ modeId: 'standard', toolName: 'read' }],
    }]);

    // An unavailable recommendation is ignored, an empty section is the fallback.
    const missing = await h.post({ action: 'export-package', id: record.id, toolPresetId: 'missing' });
    assert.deepEqual(missing.tools, { version: 1, activePresetId: null, presets: [], groups: [] });

    // A stored package without tools keeps round-tripping without one.
    const withoutTools = { format: 'dsh-preset-enhance', version: 1, metadata: { name: '无工具' },
      preset: { format: 'sillytavern', data: stPreset() }, extensions: { keep: true } };
    const legacy = await h.post({ action: 'import', document: withoutTools, name: 'legacy' });
    const roundTrip = await h.post({ action: 'export-package', id: legacy.id });
    assert.equal(roundTrip.tools, undefined);
    assert.deepEqual(roundTrip.extensions, { keep: true });
    assert.equal(roundTrip.metadata.name, '无工具');

    // A plain SillyTavern record gains the freshly built section.
    const plain = await h.post({ action: 'save', name: 'ST', preset: stPreset() });
    const withTools = await h.post({ action: 'export-package', id: plain.id, toolPresetId: preset.id });
    assert.equal(withTools.tools.activePresetId, preset.id);
    assert.equal(withTools.tools.presets.length, 1);
    assert.equal(withTools.tools.groups.length, 1);
  } finally { await h.cleanup(); }
});

test('a stale window cannot overwrite a newer save', async () => {
  const h = await createHarness();
  try {
    const base = (await h.get('s')).revision;
    const first = await h.post({ revision: base, action: 'save-tool-preset', preset: { name: 'A' } });
    const stale = await h.rawPost({ revision: base, action: 'save-tool-preset', preset: { name: 'B' } });
    assert.equal(stale.statusCode, 400);
    assert.match(stale.payload.error, /其他窗口/);
    assert.deepEqual((await h.read()).toolPresets.map(item => item.name), ['A']);

    const staleGroups = await h.rawPost({ revision: base, action: 'save-tool-groups', groups: [{ id: 'g', name: 'G', members: [] }] });
    assert.equal(staleGroups.statusCode, 400);
    assert.deepEqual((await h.read()).toolGroups, []);

    const stalePolicy = await h.rawPost({ revision: base, action: 'save-mode-tools', modeId: 'standard', policy: { read: false } });
    assert.equal(stalePolicy.statusCode, 400);
    assert.deepEqual((await h.read()).modeToolPolicies, {});

    const state = await h.read();
    assert.equal(state.revision, base + 1);
    assert.equal(state.toolPresets[0].id, first.id);
    assert.deepEqual(await h.post({ revision: state.revision, action: 'delete-tool-preset', id: first.id }), {
      id: first.id, modes: 0, sessions: 0,
    });
  } finally { await h.cleanup(); }
});

test('the 100 preset cap rejects new presets but still allows edits', async () => {
  const h = await createHarness(state => {
    state.toolPresets = Array.from({ length: 100 }, (_, index) => ({
      id: `p${index}`, name: `P${index}`, description: '', defaultEnabled: true, groupIds: [], rules: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    state.revision++;
  });
  try {
    const rejected = await h.rawPost({
      revision: (await h.read()).revision, action: 'save-tool-preset', preset: { name: '溢出' },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.payload.error, /最多 100 个/);
    assert.equal((await h.read()).toolPresets.length, 100);

    const updated = await h.post({ action: 'save-tool-preset', id: 'p0', preset: { name: 'P0 改名' } });
    assert.equal(updated.id, 'p0');
    const state = await h.read();
    assert.equal(state.toolPresets.length, 100);
    assert.equal(state.toolPresets[0].name, 'P0 改名');
  } finally { await h.cleanup(); }
});

test('limits, duplicates, dangling references and prototype keys are rejected without partial writes', async () => {
  const h = await createHarness();
  try {
    const base = (await h.get('s')).revision;
    const failing = async (body, pattern) => {
      const result = await h.rawPost({ revision: base, ...body });
      assert.equal(result.statusCode, 400, `expected rejection: ${JSON.stringify(result.payload)}`);
      assert.match(result.payload.error, pattern);
      return result.payload.error;
    };
    const member = (modeId, toolName) => ({ modeId, toolName });

    await failing({ action: 'save-tool-groups', groups: [{ id: '@all', name: '虚拟', members: [] }] }, /@/);
    await failing({ action: 'save-tool-groups', groups: [
      { id: 'g', name: 'G', members: [member('standard', 'read'), member('standard', 'read')] }] }, /重复成员/);
    await failing({ action: 'save-tool-groups', groups: [
      { id: 'g', name: 'G', members: [member('standard', 'read')] },
      { id: 'g2', name: 'G2', members: [member('standard', 'read')] }] }, /其他分组/);
    await failing({ action: 'save-tool-groups', groups: [
      { id: 'g', name: 'G', members: [member('standard', 'missing-tool')] }] }, /不属于已知目录/);
    await failing({ action: 'save-tool-groups', groups: Array.from({ length: 101 },
      (_, index) => ({ id: `g${index}`, name: `G${index}`, members: [] })) }, /最多 100 个/);
    await failing({ action: 'save-tool-groups', groups: [{ id: 'g', name: 'G',
      members: Array.from({ length: 2001 }, (_, index) => member('standard', `t${index}`)) }] }, /最多 2000 个成员/);
    await failing({ action: 'save-tool-preset', preset: { name: '大',
      rules: Array.from({ length: 5001 }, (_, index) => ({ modeId: 'standard', toolName: `t${index}`, enabled: false })) } }, /最多 5000 条规则/);
    await failing({ action: 'save-tool-preset', preset: { name: 'D', rules: [
      { modeId: 'standard', toolName: 'read', enabled: false },
      { modeId: 'standard', toolName: 'read', enabled: true }] } }, /重复/);
    await failing({ action: 'save-tool-preset', preset: { name: 'X', rules: [
      { modeId: 'standard', toolName: 'read', enabled: 'no' }] } }, /布尔/);
    await failing({ action: 'save-tool-preset', preset: { name: '悬空', groupIds: ['missing'] } }, /不存在的分组/);
    await failing({ action: 'save-tool-preset', preset: { name: '   ' } }, /名称不能为空/);
    await failing({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard',
      selection: { kind: 'preset', presetId: 'missing' } }, /有效的工具预设/);
    await failing({ action: 'select-tool-policy', scope: 'mode', modeId: 'standard',
      selection: { kind: 'inherit' } }, /模式默认不支持继承/);
    await failing({ action: 'select-tool-policy', scope: 'mode', modeId: '__proto__',
      selection: { kind: 'custom' } }, /有效的 DSH 模式/);
    await failing({ action: 'select-tool-policy', scope: 'session', sessionId: 'missing',
      selection: { kind: 'inherit' } }, /会话 ID/);
    await failing({ action: 'select-tool-policy', scope: 'session', sessionId: 's',
      selection: { kind: 'preset', presetId: '@all' } }, /@/);
    await failing({ action: 'select-tool-policy', scope: 'somewhere', selection: { kind: 'custom' } }, /策略范围/);
    await failing({ action: 'save-mode-tools', modeId: 'standard', policy: { ghost: false } }, /不属于当前模式/);
    await failing({ action: 'save-mode-tools', modeId: 'standard', policy: { read: 'yes' } }, /布尔/);

    // Nothing above wrote anything: no groups or presets, no policy, no selection.
    let state = await h.read();
    assert.deepEqual(state.toolGroups, []);
    assert.deepEqual(state.toolPresets, []);
    assert.deepEqual(state.modeToolPolicies, {});
    assert.deepEqual(state.modeToolSelections, {});
    assert.equal(state.revision, base);

    // Unknown tool references are allowed but reported as warnings.
    const warned = await h.post({ action: 'save-tool-preset', preset: { name: '失配',
      rules: [{ modeId: 'gone-mode', toolName: 'lost', enabled: false }] } });
    assert.equal(warned.warnings.length, 1);
    assert.match(warned.warnings[0], /1 条工具引用/);

    // `__proto__` keys stay own properties and never reach Object.prototype.
    const poison = await h.post({ action: 'save-tool-preset', preset: { name: '原型', rules: [
      { modeId: '__proto__', toolName: 'constructor', enabled: false }] } });
    assert.ok(poison.id);
    const sessionPolicy = await h.post({ action: 'save-session-tools', sessionId: '__proto__', policy: { read: false } });
    assert.equal(sessionPolicy.inherited, false);
    const poisoned = JSON.parse(`{"revision":${(await h.read()).revision},"action":"save-mode-tools","modeId":"standard","policy":{"__proto__":{"polluted":true},"read":false}}`);
    const poisonedResult = await h.rawPost(poisoned);
    assert.equal(poisonedResult.statusCode, 400);
    state = await h.read();
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.read, undefined);
    assert.equal(Object.prototype.constructor, Object);
    assert.equal(Object.hasOwn(state.sessionToolPolicies, '__proto__'), true);
    assert.deepEqual(state.sessionToolPolicies['__proto__'], { read: false });
    assert.deepEqual(state.sessionToolSelections['__proto__'], { kind: 'custom' });
    const stored = state.toolPresets.find(item => item.id === poison.id);
    assert.deepEqual(stored.rules, [{ modeId: '__proto__', toolName: 'constructor', enabled: false }]);
    assert.deepEqual((await h.get('__proto__')).sessionToolSelection, { kind: 'custom' });
    assert.deepEqual((await h.get('__proto__')).sessionToolPolicy, { read: false });
  } finally { await h.cleanup(); }
});
