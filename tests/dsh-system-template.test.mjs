import test from 'node:test';
import assert from 'node:assert/strict';
import { readDshSystemTemplate, withoutDshPrompt } from '../lib/dsh-system-template.mjs';
import { compilePreset, validatePreset } from '../lib/preset.mjs';
import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { readRequestSettings } from '../lib/request-settings.mjs';

const history = [{ id: 'old', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'OLD' }] },
  { id: 'ctx', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Runtime policy' }] },
  { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] }];
const preset = { prompts: [{ identifier: 'chatHistory', marker: true }] };
function harness() {
  const session = { header: { agentPreset: 'standard', cwd: 'C:\\work' }, requestHeader: () => ({ config: { model: 'one', provider: 'official' } }) };
  const agent = { session, options: { model: 'one', provider: 'official' } };
  let phase = '', calls = [], disposed = 0;
  const service = { assemble: async context => { calls.push(context); return { sections: [
    { name: 'identity', text: 'Powered by {{model}} ({{provider}}) in {{cwd}}.' },
    { name: 'literal', interpolate: false, text: 'Literal {{setglobalvar::evil::yes}} C:\\work' },
    { name: 'tools:sdk', text: 'SDK ' + phase }, { name: 'plan:policy', text: phase },
  ], variables: { model: context.agent.options.model, provider: context.agent.options.provider, cwd: session.header.cwd, extra: 'new variable' } }; } };
  const ctx = { sessions: { get: () => session }, agents: { get: () => agent }, systemPrompt: service,
    agentPresets: { acquireScope: async mode => ({ key: { mode }, [Symbol.asyncDispose]: async () => { disposed++; } }) } };
  return { ctx, agent, session, calls, setPhase: v => { phase = v; }, disposed: () => disposed };
}

test('source variables become dynamic macros, literal braces and Windows paths survive, default prompt is exact', async () => {
  const h = harness(), info = await readDshSystemTemplate(h.ctx, 's', 'standard');
  assert.equal(h.calls[0].scope, h.agent); assert.equal(h.calls[0].agent, h.agent);
  assert.match(info.template, /\{\{dsh::var::model\}\}/);
  assert.match(info.template, /\{\{dsh::var::cwd\}\}/);
  assert.ok(info.template.includes('{{dsh::section::plan:policy}}'), 'inactive dynamic sections remain available in saved overrides');
  assert.equal(renderMacros(info.sections[1].template, createMacroContext({ values: info.values })), info.sections[1].text);
  const compiled = compilePreset(preset, withoutDshPrompt(history), { dshSystemTemplate: info });
  assert.equal(compiled.messages[0].content[0].text, info.text);
  assert.equal(compiled.global.evil, undefined); assert.equal(compiled.messages[1], history[1]);
  assert.equal(history[0].content[0].text, 'OLD');
  const external = { role: 'system', source: { kind: 'plugin', plugin: 'other-plugin' }, content: [{ type: 'text', text: 'Other instructions' }] };
  assert.equal(withoutDshPrompt([...history, external]).at(-1), external, 'other plugins keep their own history contributions');
});

test('edited per-mode templates pick up new model, cwd, plugin variables and dynamic sections; reset restores current source', async () => {
  const h = harness(), initial = await readDshSystemTemplate(h.ctx, 's', 'standard');
  const custom = { ...preset, dsh_system_prompt_templates: { standard: 'Edited ' + initial.template + '\n{{dsh::var::extra}}', other: 'Other only' } };
  h.agent.options.model = 'two'; h.session.header.cwd = 'D:\\new'; h.setPhase('plan is now active');
  const info = await readDshSystemTemplate(h.ctx, 's', 'standard');
  const compiled = compilePreset(custom, [], { dshSystemTemplate: info });
  assert.match(compiled.messages[0].content[0].text, /Edited Powered by two/);
  assert.ok(compiled.messages[0].content[0].text.includes('D:\\new'));
  assert.match(compiled.messages[0].content[0].text, /plan is now active/);
  assert.match(compiled.messages[0].content[0].text, /new variable/);
  delete custom.dsh_system_prompt_templates.standard;
  assert.equal(compilePreset(custom, [], { dshSystemTemplate: info }).messages[0].content[0].text, info.text);
  assert.equal(custom.dsh_system_prompt_templates.other, 'Other only');
  const disabled = compilePreset({ ...custom, dsh_system_prompt_enabled: false }, [], { dshSystemTemplate: info });
  assert.equal(disabled.messages.length, 0);
});

test('an explicit other mode gets its own scope lease and releases it on success and failure', async () => {
  const h = harness(); await readDshSystemTemplate(h.ctx, 's', 'plugin-mode');
  assert.equal(h.calls[0].scope.mode, 'plugin-mode'); assert.notEqual(h.calls[0].agent, h.agent); assert.equal(h.disposed(), 1);
  h.ctx.systemPrompt.assemble = async () => { throw new Error('source failed'); };
  await assert.rejects(readDshSystemTemplate(h.ctx, 's', 'plugin-mode'), /source failed/); assert.equal(h.disposed(), 2);
});

test('DSH macro values are literal and missing variables abort rather than silently removing prompt text', () => {
  const ctx = createMacroContext({ values: { 'dsh::var::model': '{{setglobalvar::evil::yes}}' } });
  assert.equal(renderMacros('{{dsh::var::model}}', ctx), '{{setglobalvar::evil::yes}}');
  assert.equal(ctx.global.evil, undefined);
  assert.throws(() => renderMacros('{{dsh::var::missing}}', ctx), /不可用/);
});

test('request settings and mode templates validate imported presets and keep backward-compatible defaults', () => {
  assert.deepEqual(readRequestSettings(preset), { maxTokens: 0, stream: true });
  for (const value of [-1, 1000001, 1.2, '2', NaN]) assert.throws(() => validatePreset({ ...preset, dsh_request: { max_tokens: value } }), /max_tokens/);
  assert.throws(() => validatePreset({ ...preset, dsh_request: { stream: 'false' } }), /stream/);
  assert.throws(() => validatePreset({ ...preset, dsh_system_prompt_templates: { standard: 1 } }), /模板/);
  for (const value of [0, 1, 1000000]) assert.deepEqual(readRequestSettings(validatePreset({ ...preset, dsh_request: { max_tokens: value, stream: false } })), { maxTokens: value, stream: false });
});


test('new-conversation workbench reads the chosen scope without inventing an incomplete Agent', async () => {
  let scope;
  const ctx = { sessions: { get: () => undefined }, agentPresets: { defaultId: 'standard',
    acquireScope: async mode => ({ key: { mode }, [Symbol.asyncDispose]: async () => {} }) },
    systemPrompt: { assemble: async ({ agent, scope: value }) => {
      scope = value;
      return { sections: [{ name: 'persona', text: 'Mode ' + value.mode + ' Model {{model}} cwd {{cwd}}' }],
        variables: { model: agent?.options.model, cwd: agent?.session.header.cwd } };
    } } };
  const info = await readDshSystemTemplate(ctx, '', '');
  assert.equal(info.available, true); assert.equal(info.modeId, 'standard');
  assert.ok(info.template.includes('{{dsh::var::cwd}}'));
  assert.ok(info.warnings.length > 0);
  assert.throws(() => compilePreset(preset, [], { dshSystemTemplate: info }), /不可用/, 'unresolved values cannot leak into a sent prompt');
  const chosen = await readDshSystemTemplate(ctx, '', 'another');
  assert.equal(scope.mode, 'another'); assert.match(chosen.template, /Mode another/);
});

test('a blank cold session uses the current host model selection before its first request', async () => {
  const session = { header: { agentPreset: 'standard', cwd: 'D:\\blank' }, requestHeader: () => undefined };
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'official', model: 'current-model' }) },
    systemPrompt: { assemble: async ({ agent }) => ({ sections: [{ name: 'persona', text: '{{model}} in {{cwd}}' }],
      variables: { model: agent.options.model, cwd: agent.session.header.cwd } }) } };
  const ctx = { sessions: { get: () => session }, get: key => services[key] };
  const info = await readDshSystemTemplate(ctx, 'blank', 'standard');
  assert.equal(info.text, 'current-model in D:\\blank');
  assert.equal(compilePreset(preset, [], { dshSystemTemplate: info }).messages[0].content[0].text, info.text);
});

test('section macros use readable identifiers while previously saved encoded identifiers still resolve', async () => {
  const h = harness(), info = await readDshSystemTemplate(h.ctx, 's', 'standard');
  const macroContext = createMacroContext({ values: info.values });
  assert.ok(info.template.includes('{{dsh::section::tools:sdk}}'));
  assert.ok(!info.template.includes('%3A'));
  assert.equal(renderMacros('{{dsh::section::tools:sdk}}', macroContext), 'SDK ');
  assert.equal(renderMacros('{{dsh::section::tools%3Asdk}}', macroContext), 'SDK ');
  h.ctx.systemPrompt.assemble = async () => ({ sections: [{name: 'mcp:示例 {本地}', text:'literal result', interpolate:false}], variables:{} });
  const unusual = await readDshSystemTemplate(h.ctx, 's', 'standard');
  assert.equal(renderMacros(unusual.sections[0].macro, createMacroContext({values: unusual.values})), 'literal result');
});
