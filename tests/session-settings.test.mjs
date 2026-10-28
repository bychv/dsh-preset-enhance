import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConnection, sessionConnection, connectionSelection, writeConnectionProtocol } from '../lib/connection.mjs';
import { installToolRestrictions } from '../lib/tool-restrictions.mjs';
import { toolPolicySnapshot } from '../lib/tool-presets.mjs';

test('session protocol follows live provider and fresh settings', async () => {
  const values = { official: { protocol: 'messages' }, relay: { profile: { protocol: 'chat-completions' } } };
  let provider = 'relay', written;
  const ctx = {
    llm: { listConfigurableProviders: () => [
      { provider: 'official', settingsNs: 'official', settingsPath: [] },
      { provider: 'relay', settingsNs: 'relay', settingsPath: ['profile'] },
    ] },
    sessions: { get: () => ({ requestHeader: () => ({ config: { provider: 'official' } }) }) },
    agents: { get: () => ({ options: { provider } }) },
    get: () => ({ describe: () => Object.entries(values).map(([ns, value]) => ({ ns, value, revision: 7 })),
      update: async (...args) => { written = args; } }),
  };
  assert.equal(sessionConnection(ctx, 's').protocol, 'chat-completions');
  values.relay.profile.protocol = 'messages';
  assert.equal(sessionConnection(ctx, 's').protocol, 'messages');
  await writeConnectionProtocol(ctx, sessionConnection(ctx, 's'), 'chat-completions');
  assert.deepEqual(written, ['relay', { profile: { protocol: 'chat-completions' } }, 7]);
  provider = 'missing';
  assert.equal(sessionConnection(ctx, 's'), null);
  assert.equal(sessionConnection(ctx, ''), null);
  assert.equal(sessionConnection(ctx, 's', 'official').provider, 'official');
  provider = undefined;
  assert.equal(sessionConnection(ctx, 's').provider, 'official');
});

test('PTC assembly hides disabled tools, restores dynamically and isolates sessions', async () => {
  const inherited = { read: { name: 'read' }, shell: { name: 'shell' }, run_code: { name: 'run_code' } };
  const local = { name: 'local' };
  let snapshot = toolPolicySnapshot({ modeToolPolicies: { standard: { shell: false, local: false, run_code: false } } });
  const cleanup = [];
  function makeAgent(id) {
    const denied = new Set();
    return { session: { id }, ctx: { effect: fn => cleanup.push(fn()), tools: {
      get: name => inherited[name] ?? (name === 'local' ? local : undefined),
      schemas: () => [...Object.values(inherited), local].filter(tool => !denied.has(tool.name)),
      restrict: ({ deny }) => { for (const name of deny) { assert.ok(inherited[name]); denied.add(name); }
        return () => { for (const name of deny) denied.delete(name); }; },
    } } };
  }
  const agent = makeAgent('s'), other = makeAgent('t');
  const ctx = {
    tools: { get: name => inherited[name] },
    agentPresets: { standingKeyFor: async () => 'standard' },
    effect: fn => cleanup.push(fn()),
    systemPrompt: { assemble: async context => {
      const names = context.agent.ctx.tools.schemas().map(tool => tool.name);
      const assembly = { tools: names, sections: [{ name: 'TOOLS_SDK', text: names.join(',') }] };
      return assembly;
    } },
  };
  installToolRestrictions(ctx, () => snapshot, () => 'standard');
  assert.equal((await ctx.systemPrompt.assemble({ agent })).sections[0].text, 'read,run_code,local');
  assert.ok(other.ctx.tools.schemas().some(tool => tool.name === 'shell'));
  snapshot = toolPolicySnapshot({ modeToolPolicies: { standard: { shell: true } } });
  assert.ok((await ctx.systemPrompt.assemble({ agent })).tools.includes('shell'));
  snapshot = toolPolicySnapshot({ modeToolPolicies: { standard: { shell: false } } });
  await ctx.systemPrompt.assemble({ agent });
  for (const dispose of cleanup.reverse()) dispose();
  assert.ok(agent.ctx.tools.schemas().some(tool => tool.name === 'shell'));
});

test('switching connections keeps a model the target advertises', async () => {
  // Both curated connections now advertise the host's own catalog, so toggling must not silently
  // move the session to another model.
  const saved = [];
  const catalogue = {
    'preset-deepseek-chat': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  };
  let current = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
  const llm = { listModels: async (provider) => catalogue[provider] ?? [], listProviders: () => [] };
  const service = {
    currentSelection: () => current,
    saveSelection: async (next) => { saved.push(next); current = next; },
  };
  const ctx = { llm, get: (name) => (name === 'agentDefaultModel' ? service : name === 'llm' ? llm : undefined) };

  const selection = await selectConnection(ctx, 'preset-deepseek-chat');
  assert.deepEqual(saved[0], { provider: 'preset-deepseek-chat', model: 'deepseek-v4-pro' });
  assert.equal(selection.model, 'deepseek-v4-pro');

  // An id the target does not advertise falls back to that connection's own curated default.
  current = { provider: 'deepseek-official', model: 'not-in-any-catalog' };
  await selectConnection(ctx, 'preset-deepseek-chat');
  assert.equal(saved[1].model, 'deepseek-flash');

  // A host that cannot answer discovery also keeps the curated default rather than guessing.
  const bare = {
    get: (name) => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }), saveSelection: async (next) => { saved.push(next); } }
      : undefined),
  };
  await selectConnection(bare, 'preset-deepseek-chat');
  assert.equal(saved[2].model, 'deepseek-flash');

  // An explicit model always wins.
  await selectConnection(ctx, 'deepseek-official', 'deepseek-flash');
  assert.equal(saved[3].model, 'deepseek-flash');
});


test('protocol switch updates the current conversation through the host selector, keeping its own model', async () => {
  const initial = { provider: 'deepseek-official', model: 'session-model', reasoningEffort: 'low' };
  const other = { provider: 'deepseek-official', model: 'other-model' };
  const states = { s: { pending: initial }, other: { pending: other } };
  const calls = [];
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'global-model' }), saveSelection: () => { throw new Error('must use session controller'); } },
    sessionProjections: { stateOf: session => states[session.id] },
    sessionController: { selectModel: async ({ sessionId, ...selected }) => { calls.push({ sessionId, ...selected }); states[sessionId].pending = selected; return { selected }; } },
    llm: { listModels: async () => [{ id: 'session-model' }], listProviders: () => [] },
  };
  const ctx = { get: name => services[name], llm: services.llm, sessions: { get: id => ({ id }) } };
  const selected = await selectConnection(ctx, 'preset-deepseek-chat', undefined, 's');
  assert.deepEqual(calls, [{ sessionId: 's', provider: 'preset-deepseek-chat', model: 'session-model', reasoningEffort: 'low' }]);
  assert.equal(selected.provider, 'preset-deepseek-chat');
  assert.equal(states.other.pending, other);
  await selectConnection(ctx, 'deepseek-official', undefined, 's');
  assert.equal(states.s.pending.model, 'session-model');
  delete services.sessionController;
  await assert.rejects(selectConnection(ctx, 'preset-deepseek-chat', undefined, 's'), /模型切换服务/);
});


test('0.2.2 step admission sees re-enabled mode tools before providers collect schemas', async () => {
  const modeKey = {}, definitions = { read: { name: 'read' }, shell: { name: 'shell' } };
  const denied = new Set(), cleanup = [];
  let acquired = 0, released = 0, snapshot = toolPolicySnapshot({ modeToolPolicies: { standard: { shell: false } } });
  const scope = {
    get: name => definitions[name],
    schemas: () => Object.values(definitions).filter(tool => !denied.has(tool.name)),
    restrict: ({ deny }) => { deny.forEach(name => denied.add(name)); return () => deny.forEach(name => denied.delete(name)); },
  };
  const agent = { session: { id: 's' }, ctx: { tools: scope, effect: fn => cleanup.push(fn()) } };
  const tools = {
    get: (name, key) => key === modeKey ? definitions[name] : undefined,
    async resolve({ agent: caller }) {
      assert.equal(this, tools, 'keep the caller instead of binding the service to plugin ctx');
      const admitted = new Set(caller.ctx.tools.schemas().map(tool => tool.name));
      return { view: () => caller.ctx.tools.schemas().filter(tool => admitted.has(tool.name)) };
    },
  };
  const systemPrompt = { async assemble({ toolSet }) { return { tools: toolSet.view() }; } };
  const original = tools.resolve, assemblyOriginal = systemPrompt.assemble;
  const ctx = { tools, systemPrompt, agentPresets: { acquireScope: async () => {
    acquired++; return { key: modeKey, [Symbol.asyncDispose]: async () => { released++; } };
  } }, effect: fn => cleanup.push(fn()) };
  installToolRestrictions(ctx, () => snapshot, () => 'standard');
  let toolSet = await tools.resolve({ agent });
  assert.deepEqual((await systemPrompt.assemble({ agent, toolSet })).tools.map(t => t.name), ['read']);
  snapshot = toolPolicySnapshot({ modeToolPolicies: { standard: { shell: true } } });
  toolSet = await tools.resolve({ agent });
  assert.deepEqual((await systemPrompt.assemble({ agent, toolSet })).tools.map(t => t.name), ['read', 'shell']);
  assert.equal(acquired, 2); assert.equal(released, acquired);
  for (const dispose of cleanup.reverse()) dispose();
  assert.equal(tools.resolve, original); assert.equal(systemPrompt.assemble, assemblyOriginal);
  assert.deepEqual([...denied], []);
});

test('current selection reads public wire snapshots and live model without deprecated state access', () => {
  let live, snapshot = { next: { provider: 'p', model: 'next' }, lastUsed: { provider: 'p', model: 'old' } };
  const ctx = { sessions: { get: () => ({ id: 's' }) }, agents: { get: () => ({ model: { current: () => live } }) },
    get: name => name === 'sessionProjections' ? {
      snapshot: (_session, keys) => { assert.deepEqual(keys, ['modelSelection']); return { values: { modelSelection: snapshot } }; },
      stateOf: () => { throw Error('deprecated'); },
    } : undefined };
  assert.equal(connectionSelection(ctx, 's').model, 'next');
  snapshot = { next: null, lastUsed: { provider: 'p', model: 'old' } };
  assert.equal(connectionSelection(ctx, 's').model, 'old');
  live = { provider: 'p', model: 'live' };
  assert.equal(connectionSelection(ctx, 's').model, 'live');
});


test('preparation bridge preserves no-argument assembly and reverses on reload', async () => {
  const disposers = [];
  let calls = 0;
  class Prompt { async assemble(context = {}) { calls++; return context; } }
  const prompt = new Prompt(), ctx = { tools: { get() {} }, systemPrompt: prompt, effect: fn => disposers.push(fn()) };
  installToolRestrictions(ctx, () => toolPolicySnapshot(), () => 'standard');
  assert.deepEqual(await prompt.assemble(), {});
  for (const stop of disposers.reverse()) stop();
  assert.equal(Object.hasOwn(prompt, 'assemble'), false);
  assert.deepEqual(await prompt.assemble(), {});
  assert.equal(calls, 2);
});
