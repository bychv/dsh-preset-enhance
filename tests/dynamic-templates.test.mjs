import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplateRegistry } from '../lib/template-registry.mjs';
import { prepareDynamicTemplates } from '../lib/dynamic-templates.mjs';
import { selectTemplate, templateFingerprint } from '../lib/template-bindings.mjs';
import { compilePreset } from '../lib/preset.mjs';

const user = text => ({ id: text, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
function fixture(run, extra = {}) {
  const registry = createTemplateRegistry();
  const template = { id: 'body', version: '1', title: '动态', role: 'system', content: '资料：{{dynamic::body}}', dynamic: { resolverId: 'read', input: 'history' }, ...extra };
  const registration = registry.service.register({ effect: f => f() }, { providerId: 'example', title: 'Example', templates: [template] }, { resolvers: { read: run } });
  const selection = { operation: 'add', providerId: 'example', templateId: 'body', templateVersion: '1', expectedFingerprint: templateFingerprint(template) };
  const source = { prompts: [{ identifier: 'chatHistory', marker: true, role: 'user' }] };
  const preset = selectTemplate(source, registry.service.list(), selection).preset;
  const id = preset.prompts.find(p => p.identifier !== 'chatHistory').identifier;
  return { registry, template, registration, preset, id, selection };
}
test('dynamic data is evaluated per request and remains literal; all inputs are immutable', async () => {
  let calls = 0;
  const f = fixture(ctx => {
    calls++;
    assert.ok(Object.isFrozen(ctx.history)); assert.ok(Object.isFrozen(ctx.history[0].content));
    assert.throws(() => { ctx.variables.global.x = 'changed'; });
    assert.equal(ctx.userText, ctx.latestUser.content[0].text);
    return ctx.userText + '{{setglobalvar::unsafe::1}}';
  });
  try {
    for (const input of ['one', 'two']) {
      const history = [user(input), { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 't', content: [] }] }];
      const prepared = await prepareDynamicTemplates(f.registry, f.preset, history, { purpose: 'request', global: { x: 'safe' } });
      const compiled = compilePreset(f.preset, history, { templateCatalog: prepared.catalog, dynamicBodies: prepared.bodies });
      assert.equal(compiled.messages[0].content[0].text, '资料：' + input + '{{setglobalvar::unsafe::1}}');
      assert.equal(compiled.global.unsafe, undefined);
    }
    assert.equal(calls, 2); assert.equal(f.preset.prompts[0].content, undefined);
    assert.equal(JSON.stringify(f.registry.service.list()).includes('resolvers'), false);
  } finally { f.registry.close(); }
});

test('invalid imported resolver config rejects before invoking the provider', async () => {
  let calls = 0;
  const f = fixture(() => { calls++; return 'body'; });
  try {
    f.preset.extensions['dsh-preset-enhance'].templateBindings[f.id].config = [];
    await assert.rejects(prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request' }), /配置必须/);
    assert.equal(calls, 0);
  } finally { f.registry.close(); }
});

test('disabled, idle and non-triggered dynamic entries do not call the resolver', async () => {
  let calls = 0;
  const f = fixture(() => { calls++; return 'body'; });
  try {
    const order = f.preset.prompt_order[0].order;
    order.find(row => row.identifier === f.id).enabled = false;
    await prepareDynamicTemplates(f.registry, f.preset, [user('x')], { purpose: 'preview' });
    order.find(row => row.identifier === f.id).enabled = true;
    f.preset.prompts.find(p => p.identifier === f.id).injection_trigger = ['continue'];
    await prepareDynamicTemplates(f.registry, f.preset, [user('x')], { purpose: 'request' });
    f.preset.prompt_order[0].order = order.filter(row => row.identifier !== f.id);
    await prepareDynamicTemplates(f.registry, f.preset, [user('x')], { purpose: 'request' });
    assert.equal(calls, 0);
  } finally { f.registry.close(); }
});

test('timeout, caller cancellation and unload discard unresolved or late results', async () => {
  const f = fixture(() => new Promise(() => {}));
  try {
    await assert.rejects(prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request', timeoutMs: 15 }), /超时/);
    const controller = new AbortController();
    const work = prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request', signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await assert.rejects(work, /cancelled/);
    const unload = prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request' });
    f.registration.dispose(); await assert.rejects(unload, /卸载|不可用/);
  } finally { f.registry.close(); }
});

test('failure policy and missing providers never reuse the stored content snapshot', async () => {
  const f = fixture(() => { throw new Error('read failed'); });
  try {
    await assert.rejects(prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request' }), /read failed/);
    const ref = f.preset.extensions['dsh-preset-enhance'].templateBindings[f.id]; ref.failurePolicy = 'skip';
    for (const available of [true, false]) {
      if (!available) f.registration.dispose();
      const prepared = await prepareDynamicTemplates(f.registry, f.preset, [user('hi')], { purpose: 'preview' });
      const result = compilePreset(f.preset, [user('hi')], { templateCatalog: prepared.catalog, dynamicBodies: prepared.bodies });
      assert.equal(result.messages.length, 1); assert.match(result.warnings.join(), /已跳过/);
    }
  } finally { f.registry.close(); }
});

test('resolver concurrency is bounded, output keeps order, repeated order references resolve once', async () => {
  let active = 0, max = 0, calls = 0;
  const f = fixture(async ctx => { max = Math.max(max, ++active); calls++; await new Promise(r => setTimeout(r, 3)); active--; return ctx.identifier; });
  try {
    const ref = f.preset.extensions['dsh-preset-enhance'].templateBindings[f.id];
    for (let i = 0; i < 7; i++) {
      const id = 'copy-' + i; f.preset.prompts.push({ identifier: id, role: 'system', content: 'snapshot' });
      f.preset.prompt_order[0].order.push({ identifier: id, enabled: true });
      f.preset.extensions['dsh-preset-enhance'].templateBindings[id] = structuredClone(ref);
    }
    f.preset.prompt_order[0].order.push({ identifier: f.id, enabled: true });
    const prepared = await prepareDynamicTemplates(f.registry, f.preset, [], { purpose: 'request' });
    assert.equal(calls, 8); assert.equal(max, 4);
    assert.equal(prepared.bodies['copy-5'].text, 'copy-5');
  } finally { f.registry.close(); }
});

test('dynamic marker keeps its original role and has revision-aware configuration and safe detach', async () => {
  const f = fixture(ctx => JSON.stringify(ctx.config), { targetMarker: undefined });
  try {
    let preset = selectTemplate({ prompts: [{ identifier: 'charDescription', role: 'user', marker: true }] }, f.registry.service.list(),
      { ...f.selection, operation: 'bind-marker', identifier: 'charDescription' }).preset;
    assert.throws(() => selectTemplate(preset, f.registry.service.list(), { operation: 'configure', identifier: 'charDescription', config: {}, failurePolicy: 'skip' }, ['charDescription']), /锁定/);
    preset = selectTemplate(preset, f.registry.service.list(), { operation: 'configure', identifier: 'charDescription', config: { topic: 'x' }, failurePolicy: 'abort' }).preset;
    const prepared = await prepareDynamicTemplates(f.registry, preset, [], { purpose: 'preview' });
    const compiled = compilePreset(preset, [], { templateCatalog: prepared.catalog, dynamicBodies: prepared.bodies });
    assert.equal(compiled.messages[0].role, 'user'); assert.match(compiled.messages[0].content[0].text, /"topic":"x"/);
    assert.equal(preset.prompts[0].marker, true);
    preset = selectTemplate(preset, f.registry.service.list(), { operation: 'detach', identifier: 'charDescription' }).preset;
    assert.equal(preset.prompts[0].marker, true);
  } finally { f.registry.close(); }
});
