import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PRESET_PLUGIN,
  PRESET_MODE_ENTRY_ID,
  PRESET_MODE_ENTRY_NAME,
  PRESET_MODE_ID,
  buildPresetModeDefinition,
  createPresetModeController,
  findStandardModeDeclaration,
  modeCapability,
  readModeToolCatalog,
  readSessionToolCatalog,
  releaseModeScope,
  standardModeDeclaration,
  waitForStandardDeclaration,
} from '../lib/modes.mjs';

const persona = { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are the {{model}} model.', suffix: 'cwd is {{cwd}}' } };
const toolRow = { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' };
const groupRow = { id: 'planning', name: 'cordis:group', group: true, config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }] };
const standardPlugins = [persona, toolRow, groupRow];
const standardConfig = { id: 'standard', order: 1, plugins: standardPlugins };
const loaderOf = (...entries) => ({ entries: () => entries });
const presetEntry = (config, id = 'preset-standard') => ({ id, options: { id, name: AGENT_PRESET_PLUGIN, config } });
const lease = (key, onRelease) => ({ key, [Symbol.asyncDispose]: async () => { onRelease?.(key); } });
const hostOf = (overrides = {}) => ({
  loader: loaderOf(presetEntry(standardConfig)),
  agentPresets: { register: async () => async () => {}, acquireScope: async id => lease(id) },
  tools: { schemas: () => [] },
  ...overrides,
});

test('the capability probe separates the 0.1.7 declarative API from the 0.1.6 directory surface', () => {
  const modern = modeCapability({ agentPresets: { register: async () => async () => {}, acquireScope: async () => lease('k') } });
  assert.deepEqual(modern, { declarative: true, scopeLease: true, legacyDirectory: false, reason: '' });

  const legacy = modeCapability({ agentPresets: { readDocument: async () => ({ content: '' }), standingKeyFor: async () => ({}) } });
  assert.equal(legacy.declarative, false);
  assert.equal(legacy.scopeLease, false);
  assert.equal(legacy.legacyDirectory, true);
  assert.match(legacy.reason, /0\.1\.6/);

  const bare = modeCapability({});
  assert.equal(bare.declarative, false);
  assert.equal(bare.legacyDirectory, false);
  assert.match(bare.reason, /register/);
  assert.match(bare.reason, /acquireScope/);
  assert.equal(modeCapability(undefined).declarative, false);

  const half = modeCapability({ agentPresets: { register: async () => async () => {} } });
  assert.equal(half.declarative, true);
  assert.equal(half.scopeLease, false);
  assert.match(half.reason, /acquireScope/);
});

test('the standard declaration comes from the composed loader entry with its full config', () => {
  const loader = loaderOf(
    { id: 'tools', options: { id: 'tools', name: '@deepseek-ai/dsh-tools' } },
    presetEntry(standardConfig),
  );
  const found = findStandardModeDeclaration(loader);
  assert.equal(found.entryId, 'preset-standard');
  assert.equal(found.definition.id, 'standard');
  assert.deepEqual(found.definition.plugins[0].config, { prefix: 'You are the {{model}} model.', suffix: 'cwd is {{cwd}}' });
  assert.deepEqual(found.definition.plugins[2].config, [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }], 'nested group config survives');
  assert.equal(found.definition.plugins.length, 3);

  // The entry is re-read, so a Web-editor override saved into the profile patch is honoured.
  const entry = presetEntry({ id: 'standard', plugins: [persona, toolRow] });
  assert.equal(standardModeDeclaration({ loader: loaderOf(entry) }).definition.plugins.length, 2);
  entry.options.config = { id: 'standard', plugins: [persona, toolRow, groupRow] };
  assert.equal(standardModeDeclaration({ loader: loaderOf(entry) }).definition.plugins.length, 3);

  assert.equal(findStandardModeDeclaration(loaderOf(presetEntry({ id: 'ptc', plugins: [] }))), null);
  assert.equal(findStandardModeDeclaration(loaderOf(presetEntry({ id: 'standard', plugins: 'nope' }))), null);
  assert.equal(findStandardModeDeclaration(loaderOf()), null);
  assert.equal(findStandardModeDeclaration(undefined), null);
  assert.equal(standardModeDeclaration({}), null);
});

test('the preset mode copies the standard composition, replaces persona and appends its row once', () => {
  const built = buildPresetModeDefinition({ id: 'standard', name: 'Standard', description: 'host', order: 1, plugins: standardPlugins });
  assert.equal(built.id, PRESET_MODE_ID);
  assert.equal(built.name, '预设模式');
  assert.equal(built.order, 4);
  assert.equal(built.plugins.length, 4);
  assert.deepEqual(built.plugins[0].config, { prefix: '', complete: true, includeRuntimeContext: false });
  assert.equal(built.plugins[0].id, 'persona');
  assert.deepEqual(built.plugins[1], toolRow);
  assert.deepEqual(built.plugins.at(-1), { id: PRESET_MODE_ENTRY_ID, name: PRESET_MODE_ENTRY_NAME });
  assert.equal(built.plugins.filter(row => row.name === PRESET_MODE_ENTRY_NAME).length, 1);

  // The host declaration is never mutated and rows are copies.
  assert.equal(standardPlugins[0].config.prefix, 'You are the {{model}} model.');
  assert.equal(built.plugins[0] === standardPlugins[0], false);
  assert.equal(built.plugins[2] === standardPlugins[2], false);

  // Appending is idempotent when the composition already names the row.
  const withEntry = buildPresetModeDefinition({ id: 'standard', plugins: [...standardPlugins, { id: PRESET_MODE_ENTRY_ID, name: PRESET_MODE_ENTRY_NAME }] });
  assert.equal(withEntry.plugins.filter(row => row.name === PRESET_MODE_ENTRY_NAME).length, 1);

  // Options win, and extra rows can be appended.
  const custom = buildPresetModeDefinition({ id: 'standard', plugins: standardPlugins },
    { id: 'other', name: 'Other', description: 'd', order: 9, append: [{ id: 'extra', name: '@deepseek-ai/dsh-extra' }] });
  assert.equal(custom.id, 'other');
  assert.equal(custom.name, 'Other');
  assert.equal(custom.order, 9);
  assert.equal(custom.plugins.at(-1).name, '@deepseek-ai/dsh-extra');

  assert.throws(() => buildPresetModeDefinition({ id: 'standard', plugins: [toolRow] }), /persona/);
});

test('register and dispose are idempotent, including concurrent calls', async () => {
  const calls = [];
  const host = hostOf({
    agentPresets: {
      register: async definition => { calls.push(['register', definition.id]); return async () => { calls.push(['unregister', definition.id]); }; },
      acquireScope: async id => lease(id),
    },
  });
  const controller = createPresetModeController(host);
  assert.equal(controller.capability.declarative, true);
  assert.equal(controller.standard().entryId, 'preset-standard');

  const [first, second] = await Promise.all([controller.register(), controller.register()]);
  assert.equal(first, second, 'concurrent register() calls share one host registration');
  await controller.register();
  assert.deepEqual(calls, [['register', PRESET_MODE_ID]]);
  assert.equal(controller.current(), first);
  assert.equal(first.definition.plugins.at(-1).name, PRESET_MODE_ENTRY_NAME);

  await controller.dispose();
  await controller.dispose();
  assert.deepEqual(calls, [['register', PRESET_MODE_ID], ['unregister', PRESET_MODE_ID]]);
  assert.equal(controller.current(), null);

  // Hot restart: one controller can register again after a teardown.
  await controller.register();
  assert.deepEqual(calls, [['register', PRESET_MODE_ID], ['unregister', PRESET_MODE_ID], ['register', PRESET_MODE_ID]]);
  await controller.dispose();
  assert.deepEqual(calls, [['register', PRESET_MODE_ID], ['unregister', PRESET_MODE_ID], ['register', PRESET_MODE_ID], ['unregister', PRESET_MODE_ID]]);
});

test('registering refuses a host without the declarative API instead of guessing', async () => {
  const legacy = createPresetModeController({ agentPresets: { readDocument: async () => ({ content: '' }) } });
  await assert.rejects(() => legacy.register(), /0\.1\.6|register/);
  assert.equal(legacy.current(), null);
  assert.equal(legacy.capability.declarative, false);
});

test('a missing standard declaration is reported, never silently registered', async () => {
  const host = hostOf({ loader: loaderOf({ id: 'tools', options: { id: 'tools', name: '@deepseek-ai/dsh-tools' } }) });
  const controller = createPresetModeController(host);
  await assert.rejects(() => controller.register(), /config\.id=standard/);
  assert.equal(controller.current(), null);
});

test('a dispose during an in-flight registration releases the late registration', async () => {
  const calls = [];
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const host = hostOf({
    agentPresets: {
      register: async () => { calls.push('register'); await gate; return async () => { calls.push('unregister'); }; },
      acquireScope: async id => lease(id),
    },
  });
  const controller = createPresetModeController(host);
  const registering = controller.register();
  const disposing = controller.dispose();
  openGate();
  await assert.rejects(() => registering, /已被释放/);
  await disposing;
  assert.equal(controller.current(), null);
  assert.deepEqual(calls, ['register', 'unregister'], 'the late mount is not leaked');
});

test('the mode catalog is read through a scope lease that is always released', async () => {
  const log = [];
  const host = hostOf({
    agentPresets: {
      register: async () => async () => {},
      acquireScope: async id => { log.push(['acquire', id]); return lease('scope-1', () => log.push(['release', id])); },
    },
    tools: { schemas: scope => { log.push(['schemas', scope]); return [{ name: 'run_code' }, { name: 'tool_fs' }, { nope: true }]; } },
  });
  const catalog = await readModeToolCatalog(host, PRESET_MODE_ID);
  assert.equal(catalog.modeId, PRESET_MODE_ID);
  assert.equal(catalog.scope, 'scope-1');
  assert.deepEqual(catalog.tools, [{ name: 'run_code' }, { name: 'tool_fs' }]);
  assert.deepEqual(log, [['acquire', PRESET_MODE_ID], ['schemas', 'scope-1'], ['release', PRESET_MODE_ID]]);
});

test('the lease is released when the catalog read throws', async () => {
  const log = [];
  const host = hostOf({
    agentPresets: { register: async () => async () => {}, acquireScope: async () => lease('k', () => log.push('release')) },
    tools: { schemas: () => { throw new Error('boom'); } },
  });
  await assert.rejects(() => readModeToolCatalog(host, PRESET_MODE_ID), /boom/);
  assert.deepEqual(log, ['release']);
});

test('a catalog read without the scope-lease API is refused, not faked', async () => {
  await assert.rejects(() => readModeToolCatalog({ agentPresets: {} }, PRESET_MODE_ID), /acquireScope/);
  await assert.rejects(() => readModeToolCatalog({ agentPresets: { acquireScope: async () => lease('k') } }, PRESET_MODE_ID), /tools\.schemas/);
});

test('a live session keeps its own revision and never receives the newest catalog', async () => {
  const log = [];
  const oldGeneration = [{ name: 'tool_fs_legacy' }];
  const newest = [{ name: 'tool_fs_2025' }];
  const host = hostOf({
    agents: {
      get: id => id === 'live'
        ? { ctx: { tools: { schemas: agent => { log.push(['session-schemas', agent?.ctx !== undefined]); return [...oldGeneration, { name: 'mcp__dynamic' }]; } } } }
        : undefined,
    },
    agentPresets: {
      register: async () => async () => {},
      acquireScope: async () => { log.push(['acquire']); return lease('current-generation', () => log.push(['release'])); },
    },
    tools: { schemas: () => newest },
  });

  const live = await readSessionToolCatalog(host, 'live', { modeId: PRESET_MODE_ID });
  assert.equal(live.source, 'session');
  assert.deepEqual(live.tools, [...oldGeneration, { name: 'mcp__dynamic' }], 'the session revision and its dynamic MCP tools');
  assert.notDeepEqual(live.tools, newest);
  assert.deepEqual(log, [['session-schemas', true]], 'no lease is acquired for a live session at all');

  const cold = await readSessionToolCatalog(host, 'cold', { modeId: PRESET_MODE_ID });
  assert.equal(cold.source, 'mode');
  assert.equal(cold.scope, 'current-generation');
  assert.deepEqual(cold.tools, newest);
  assert.deepEqual(log, [['session-schemas', true], ['acquire'], ['release']]);

  const unknown = await readSessionToolCatalog(host, 'cold');
  assert.equal(unknown.source, 'none');
  assert.deepEqual(unknown.tools, []);

  // The newest generation is never merged into the old session's list.
  assert.equal(live.tools.some(tool => tool.name === 'tool_fs_2025'), false);
});

test('an unavailable mode revision is reported without inventing tools', async () => {
  const host = hostOf({
    agentPresets: {
      register: async () => async () => {},
      acquireScope: async () => { throw new Error('agent-preset/not-found: Unknown agent preset: st-preset'); },
    },
  });
  const catalog = await readSessionToolCatalog(host, 'cold', { modeId: PRESET_MODE_ID });
  assert.equal(catalog.source, 'mode');
  assert.deepEqual(catalog.tools, []);
  assert.match(catalog.error, /not-found/);

  const broken = await readSessionToolCatalog(hostOf({
    agents: { get: () => ({ ctx: { tools: { schemas: () => { throw new Error('scope disposed'); } } } }) },
  }), 'live');
  assert.equal(broken.source, 'session');
  assert.match(broken.error, /scope disposed/);
  assert.deepEqual(broken.tools, []);
});

test('releaseModeScope accepts both release spellings and refuses an unreleasable lease', async () => {
  const log = [];
  await releaseModeScope(lease('a', () => log.push('a')));
  await releaseModeScope({ key: 'b', release: async () => { log.push('b'); } });
  await releaseModeScope(null);
  await releaseModeScope(undefined);
  assert.deepEqual(log, ['a', 'b']);
  await assert.rejects(() => releaseModeScope({ key: 'c' }), /无法释放/);
});

test('a late-composed standard declaration is awaited on a bounded timer, never loader.await()', async () => {
  const entries = [{ id: 'tools', options: { id: 'tools', name: '@deepseek-ai/dsh-tools' } }];
  const host = hostOf({ loader: { entries: () => entries } });
  assert.equal(await waitForStandardDeclaration(host, { timeoutMs: 0 }), null);

  const startedAt = Date.now();
  setTimeout(() => entries.push(presetEntry(standardConfig)), 20);
  const found = await waitForStandardDeclaration(host, { timeoutMs: 500, intervalMs: 5 });
  const elapsed = Date.now() - startedAt;
  assert.equal(found.entryId, 'preset-standard');
  assert.ok(elapsed >= 15 && elapsed < 500, `bounded wait, elapsed ${elapsed}ms`);

  const never = await waitForStandardDeclaration({ loader: { entries: () => [] } }, { timeoutMs: 40, intervalMs: 5 });
  assert.equal(never, null);
});

test('registerWhenAvailable registers once a late standard declaration lands', async () => {
  const calls = [];
  const entries = [];
  const host = hostOf({
    loader: { entries: () => entries },
    agentPresets: {
      register: async definition => { calls.push(['register', definition.id]); return async () => { calls.push(['unregister', definition.id]); }; },
      acquireScope: async id => lease(id),
    },
  });
  const controller = createPresetModeController(host);
  assert.equal(controller.standard(), null);
  setTimeout(() => entries.push(presetEntry(standardConfig)), 20);
  const registration = await controller.registerWhenAvailable({ timeoutMs: 500, intervalMs: 5 });
  assert.equal(registration.id, PRESET_MODE_ID);
  assert.deepEqual(calls, [['register', PRESET_MODE_ID]]);
  assert.equal(controller.standard().entryId, 'preset-standard');
  await controller.dispose();
  assert.deepEqual(calls, [['register', PRESET_MODE_ID], ['unregister', PRESET_MODE_ID]]);

  const absent = createPresetModeController(hostOf({ loader: { entries: () => [] } }));
  await assert.rejects(() => absent.registerWhenAvailable({ timeoutMs: 30, intervalMs: 5 }), /config\.id=standard/);
  assert.equal(absent.current(), null);
});

test('a 0.1.7-rc.1 host stays declarative even though readDocument came back', () => {
  // rc.1 re-added readDocument with a viewing-only contract that REJECTS an unknown preset, so
  // its presence must not push the plugin back onto the 0.1.6 directory path.
  const rc1 = modeCapability({
    agentPresets: {
      register: async () => async () => {},
      acquireScope: async () => lease('k'),
      readDocument: async () => { throw new Error('Unknown agent preset: standard'); },
    },
  });
  assert.equal(rc1.declarative, true);
  assert.equal(rc1.scopeLease, true);
  assert.equal(rc1.reason, '');
});
