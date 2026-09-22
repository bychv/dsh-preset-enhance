import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionConnection, writeConnectionProtocol } from '../lib/connection.mjs';
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
  let hook;
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
    effect: fn => cleanup.push(fn()), on: (_, handler) => { hook = handler; },
    systemPrompt: { assemble: async context => {
      const names = context.agent.ctx.tools.schemas().map(tool => tool.name);
      const assembly = { tools: names, sections: [{ name: 'TOOLS_SDK', text: names.join(',') }] };
      return hook(assembly, context, async () => assembly);
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
