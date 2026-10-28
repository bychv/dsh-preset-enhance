import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolRestrictions } from '../lib/tool-restrictions.mjs';
import { toolPolicySnapshot } from '../lib/tool-presets.mjs';
import { createDshAssemblyTracker } from '../lib/dsh-assembly.mjs';
import { readDshSystemTemplate, dshTemplateFromAssembly } from '../lib/dsh-system-template.mjs';

function fixture() {
  const events = {}, stops = [], agents = new Map(); let calls = 0, phase = 0;
  const prompt = { async assemble(context) {
    calls++;
    const allowed = context.toolSet ?? [{ name: 'allowed' }, { name: 'not-admitted' }];
    // This is the final return, including any later waterfall/complete rule.
    return { sections: [{ name: 'third:dynamic', text: `sdk ${phase}: ${allowed.map(t => t.name).join(',')}` }],
      contexts: [{ name: 'cwd', text: '/fictional' }], variables: {}, tools: allowed };
  } };
  const ctx = { effect(fn) { stops.push(fn()); }, on(key, fn) { events[key] = fn; },
    tools: { get() {}, resolve: async () => [{ name: 'allowed' }] }, systemPrompt: prompt,
    sessions: { get: id => agents.get(id)?.session }, agents: { get: id => agents.get(id) } };
  const tracker = createDshAssemblyTracker(ctx, s => s.header.agentPreset);
  const original = prompt.assemble;
  installToolRestrictions(ctx, () => toolPolicySnapshot(), s => s.header.agentPreset, undefined, tracker.capture);
  function agent(id) {
    const value = { session: { id, header: { agentPreset: 'standard' } }, options: { provider: 'test', model: 'model' }, ctx: { systemPrompt: prompt } };
    agents.set(id, value); return value;
  }
  async function prepare(agent, signal, step = 1) {
    const toolSet = await ctx.tools.resolve({ agent });
    const result = await prompt.assemble({ agent, scope: agent, signal, modelSelection: agent.options, toolSet });
    await events['agent/pre-step']({ agent, signal, turn: 1, step }, async () => ({ kind: 'enter' }));
    await events['agent/request']({ agent, signal, turn: 1, step }, async () => agent.options);
    return { ...agent.options, sessionId: agent.session.id, signal, tools: result.tools,
      messages: [{ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: dshTemplateFromAssembly(result, 'standard').text }] }] };
  }
  return { ctx, tracker, prompt, original, events, agent, prepare, stops, calls: () => calls, phase: () => phase++ };
}

test('accepted step uses admitted SDK without a second assembly; previews cannot overwrite it', async () => {
  const f = fixture(), agent = f.agent('a'), controller = new AbortController();
  const request = await f.prepare(agent, controller.signal);
  const before = f.calls();
  assert.equal(f.tracker.forRequest(request, 'standard').text, 'sdk 0: allowed');
  assert.equal(f.calls(), before);
  f.phase();
  const preview = await readDshSystemTemplate(f.ctx, 'a', 'standard', controller.signal);
  assert.equal(preview.text, 'sdk 1: allowed,not-admitted');
  assert.equal(f.tracker.forRequest(request, 'standard').text, 'sdk 0: allowed');
  const continuation = await f.prepare(agent, controller.signal, 2);
  assert.equal(f.tracker.forRequest(continuation, 'standard').text, 'sdk 1: allowed');
  assert.throws(() => f.tracker.forRequest(request, 'standard'), /正文或工具集合/);
  // Transport retries keep the same accepted result, including resolved adapter defaults.
  assert.equal(f.tracker.forRequest({ ...continuation, reasoningEffort: 'high' }, 'standard').text, 'sdk 1: allowed');
});

test('association isolates agents, excludes auxiliary calls and rejects changed envelopes', async () => {
  const f = fixture(), a = f.agent('a'), b = f.agent('b');
  const ra = await f.prepare(a, new AbortController().signal);
  f.phase(); const rb = await f.prepare(b, new AbortController().signal);
  assert.equal(f.tracker.forRequest(ra, 'standard').text, 'sdk 0: allowed');
  assert.equal(f.tracker.forRequest(rb, 'standard').text, 'sdk 1: allowed');
  assert.equal(f.tracker.forRequest({ ...ra, purpose: 'title' }, 'standard'), undefined);
  for (const diff of [{ signal: new AbortController().signal }, { model: 'other' }, { tools: [] }]) {
    assert.throws(() => f.tracker.forRequest({ ...ra, ...diff }, 'standard'), /不匹配|已变化/);
  }
  f.events['session/event'](a.session, { type: 'step/end' });
  assert.equal(f.tracker.forRequest(ra, 'standard'), undefined);
  f.ctx.agents.get = () => ({ ...b });
  assert.equal(f.tracker.forRequest(rb, 'standard'), undefined, 'replaced agent cannot inherit the old result');
});

test('aborted steps, preparation failures and unload clear association and restore method', async () => {
  const f = fixture(), a = f.agent('a'), controller = new AbortController();
  const request = await f.prepare(a, controller.signal); controller.abort();
  assert.throws(() => f.tracker.forRequest(request, 'standard'), /不匹配/);
  await f.prepare(a, new AbortController().signal);
  await assert.rejects(f.events['agent/request']({ agent: a }, async () => { throw Error('failed'); }), /failed/);
  assert.equal(f.tracker.forRequest(request, 'standard'), undefined);
  for (const stop of f.stops.reverse()) stop?.();
  assert.equal(f.prompt.assemble, f.original);
});

test('late failed preparation cannot discard a newer accepted step', async () => {
  const f=fixture(),a=f.agent('a'),signal=new AbortController().signal;
  await f.prepare(a,signal);
  let reject;
  const pending=f.events['agent/pre-step']({agent:a,signal,turn:1,step:1},()=>new Promise((_,r)=>{reject=r;}));
  f.phase();const current=await f.prepare(a,signal,2);
  reject(Error('late failure'));await assert.rejects(pending,/late failure/);
  assert.equal(f.tracker.forRequest(current,'standard').text,'sdk 1: allowed');
});
