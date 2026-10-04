import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplateRegistry } from '../lib/template-registry.mjs';
import { PRESET_TEMPLATES_SERVICE } from 'dsh-preset-enhance/templates';

function scope() {
  const disposers = [];
  let closed = false;
  return {
    effect(setup) { if (closed) throw new Error('scope closed'); disposers.push(setup()); },
    dispose() { closed = true; for (const dispose of disposers.splice(0)) dispose(); },
  };
}
const template = (overrides = {}) => ({
  id: 'choices', version: '1', title: '选项格式', role: 'system',
  content: '{{setvar::test::unchanged}}返回候选项',
  defaults: { placement: 'afterHistory' }, ...overrides,
});
const provider = (providerId = 'example.one', templates = [template()]) => ({ providerId, title: providerId, templates });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('two providers can use the same template id; input and catalog snapshots stay detached', () => {
  assert.equal(PRESET_TEMPLATES_SERVICE, 'presetTemplates');
  const { service } = createTemplateRegistry();
  const a = provider();
  service.register(scope(), a);
  service.register(scope(), provider('example.two'));
  a.templates[0].content = 'changed outside';
  a.templates[0].defaults.placement = 'beforeHistory';
  const snapshot = service.list();
  assert.equal(snapshot.providers.length, 2);
  assert.equal(snapshot.providers[0].templates[0].content, template().content);
  snapshot.providers[0].templates[0].defaults.placement = 'depth';
  snapshot.providers.splice(1);
  assert.equal(service.list().providers.length, 2);
  assert.equal(service.list().providers[0].templates[0].defaults.placement, 'afterHistory');
});

test('updates are atomic, require a new version, and allow retaining older versions', () => {
  const { service } = createTemplateRegistry();
  const handle = service.register(scope(), provider());
  const initial = service.list();
  handle.update([template()]);
  assert.deepEqual(service.list(), initial, 'no-op update does not change the revision');
  assert.throws(() => handle.update([template({ content: 'different' })]), /新版本/);
  assert.throws(() => handle.update([template({ version: '2' }), template({ id: 'broken', role: 'tool' })]), /role/);
  assert.deepEqual(service.list(), initial);
  const v2 = template({ version: '2', content: 'new format' });
  handle.update([template(), v2]);
  assert.deepEqual(service.list().providers[0].templates.map(t => t.version), ['1', '2']);
  handle.update([v2]);
  assert.throws(() => handle.update([template({ content: 'reuse withdrawn version' })]), /新版本/);
  assert.equal(service.list().providers[0].templates[0].content, v2.content);
});

test('owner disposal releases only its provider and stale handles cannot affect a reload', () => {
  const registry = createTemplateRegistry();
  const owner = scope();
  const old = registry.service.register(owner, provider());
  registry.service.register(scope(), provider('example.two'));
  assert.throws(() => registry.service.register(scope(), provider()), /已注册/);
  owner.dispose();
  assert.deepEqual(registry.service.list().providers.map(p => p.providerId), ['example.two']);
  registry.service.register(scope(), provider());
  old.dispose();
  assert.equal(registry.service.list().providers.length, 2);
  assert.throws(() => old.update([template({ version: '2' })]), /已释放/);
  registry.close();
  registry.close();
  assert.throws(() => registry.service.list(), /已停用/);
  assert.throws(() => registry.service.register(scope(), provider('new')), /已停用/);
  old.dispose();
});

test('failed registration and invalid shapes never leave partial catalog entries', () => {
  const { service } = createTemplateRegistry();
  const inactive = scope(); inactive.dispose();
  assert.throws(() => service.register(inactive, provider()), /scope closed/);
  for (const templates of [
    [template(), template()],
    [template({ defaults: { placement: 'depth', depth: -1 } })],
    [template({ defaults: { placement: 'depth' } })],
    [template({ defaults: { placement: { toString: () => 'depth' }, depth: 1 } })],
    [template({ content: 'x'.repeat(200_001) })],
    [template({ content: () => 'no callbacks' })],
    Array(1),
  ]) assert.throws(() => service.register(scope(), provider('invalid', templates)));
  assert.deepEqual(service.list(), { contractVersion: 1, revision: 0, providers: [] });
  service.register(scope(), provider('valid', [template({ defaults: { placement: 'depth', depth: 0, order: -1 } })]));
  assert.equal(service.list().providers.length, 1);
});

test('a new provider scope may reload changed content; updates still require a new version', () => {
  const { service } = createTemplateRegistry();
  service.register(scope(), provider()).dispose();
  const handle = service.register(scope(), provider('example.one', [template({ content: 'mutated' })]));
  assert.equal(service.list().providers[0].templates[0].content, 'mutated');
  assert.throws(() => handle.update([template({ content: 'again' })]), /新版本/);
});

test('catalog notifications coalesce, isolate listener errors, and unsubscribe cleanly', async () => {
  const errors = [];
  const registry = createTemplateRegistry(error => errors.push(error));
  const revisions = [];
  const listener = revision => revisions.push(revision);
  const unsubscribe = registry.service.subscribe(listener);
  registry.service.subscribe(listener)(); // Removing a second lease must not remove the first.
  registry.service.subscribe(() => { throw new Error('sync observer failure'); });
  registry.service.subscribe(async () => { throw new Error('async observer failure'); });
  const handle = registry.service.register(scope(), provider());
  handle.update([template({ version: '2' })]);
  await flush();
  assert.deepEqual(revisions, [2]);
  assert.equal(errors.length, 2);
  unsubscribe();
  handle.dispose();
  registry.close(); // Pending notifications must not run after shutdown.
  await flush();
  assert.deepEqual(revisions, [2]);
  assert.equal(errors.length, 2);
});

test('catalog budget rejects oversized batches without discarding the previous catalog', () => {
  const { service } = createTemplateRegistry();
  const handle = service.register(scope(), provider());
  const before = service.list();
  assert.throws(() => handle.update(Array.from({ length: 21 }, (_, index) =>
    template({ id: `large-${index}`, content: 'x'.repeat(200_000) }))), /总文本/);
  assert.deepEqual(service.list(), before);
});
