import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { selectTemplate, templateFingerprint } from '../lib/template-bindings.mjs';
const element = tag => ({ tag, children: [], value: '', textContent: '', open: false,
  append(...nodes) { this.children.push(...nodes); },
  replaceChildren(...nodes) { this.children = nodes; },
  setAttribute() {}, get firstChild() { return this.children[0]; },
});

test('shared editor panel binds a marker, shows its snapshot and restores the original marker', async () => {
  const template = { id: 'character', version: '1', title: '角色', role: 'assistant', content: '插件正文', targetMarker: 'charDescription' };
  const ref = { providerId: 'example', templateId: template.id, templateVersion: template.version };
  const catalog = { contractVersion: 1, revision: 1, providers: [{ providerId: 'example', title: 'Example', templates: [template] }],
    fingerprints: [{ ...ref, fingerprint: templateFingerprint(template) }] };
  const original = { prompts: [{ identifier: 'charDescription', marker: true, role: 'system', content: '原字段' }, { identifier: 'chatHistory', marker: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] };
  let draft = structuredClone(original);
  const root = element('details'), calls = [];
  const context = { document: { createElement: element, hidden: false }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => catalog }), setInterval: () => 1, clearInterval() {}, confirm: () => true };
  runInNewContext(readFileSync(new URL('../web/plugin-templates.js', import.meta.url), 'utf8'), context);
  context.PresetPluginTemplates.mount(root, {
    api: async body => { calls.push(body.selection.operation); return selectTemplate(draft, catalog, JSON.parse(JSON.stringify(body.selection))); },
    getPreset: () => draft, getPresetId: () => 'p', getCharacterId: () => 100001,
    getOrder: () => draft.prompt_order[0].order, isLocked: () => false, onSelect() {}, onChange: value => { draft = value; },
  });
  await tick();
  const select = all(root).find(n => n.tag === 'select');
  select.value = JSON.stringify(['example', 'character', '1']); select.onchange();
  assert.ok(!all(root).some(n => n.textContent === '加入当前顺序表'));
  const target = all(root).filter(n => n.tag === 'select')[1];
  assert.ok(!target.children.some(n => n.value === 'chatHistory'));
  target.value = 'charDescription'; target.onchange();
  const bind = all(root).find(n => n.textContent === '关联到标记条目'); assert.equal(bind.disabled, false);
  await bind.onclick();
  assert.deepEqual(draft.prompts, original.prompts); assert.deepEqual(draft.prompt_order, original.prompt_order);
  assert.ok(all(root).some(n => n.tag === 'pre' && n.textContent === '插件正文'));
  all(root).find(n => n.textContent === '恢复原标记').onclick(); await tick();
  assert.deepEqual(calls, ['bind-marker', 'detach']);
  assert.deepEqual(draft.extensions['dsh-preset-enhance'].templateBindings, {});
  assert.deepEqual(draft.prompts, original.prompts);
});
const all = node => [node, ...node.children.flatMap(all)];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('template panel hands changes to normal save hook and refuses an outdated draft response', async () => {
  const ref = { providerId: 'example', templateId: 'format', templateVersion: '1' };
  const catalog = { contractVersion: 1, providers: [{ providerId: 'example', title: 'Example', templates: [{ id: 'format', version: '1', title: 'Format', role: 'system', content: 'text' }] }], fingerprints: [{ ...ref, fingerprint: 'hash' }] };
  let draft = { prompts: [] }, resolveRequest, changed = 0;
  const root = element('details');
  const context = { document: { createElement: element, hidden: false }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => catalog }), setInterval: () => 1, clearInterval() {}, confirm: () => true };
  runInNewContext(readFileSync(new URL('../web/plugin-templates.js', import.meta.url), 'utf8'), context);
  const panel = context.PresetPluginTemplates.mount(root, {
    api: body => { assert.equal(body.action, 'template-select'); return new Promise(resolve => { resolveRequest = resolve; }); },
    getPreset: () => draft, getPresetId: () => 'p', getCharacterId: () => 100001,
    getOrder: () => [], isLocked: () => false, onSelect() {}, onChange: next => { changed++; draft = next; },
  });
  await tick();
  const select = all(root).find(n => n.tag === 'select');
  select.value = JSON.stringify(['example', 'format', '1']); select.onchange();
  const add = () => all(root).find(n => n.textContent === '加入当前顺序表').onclick();
  const first = add();
  resolveRequest({ changed: true, identifier: 'new', preset: { prompts: [{ identifier: 'new' }] } });
  await first;
  assert.equal(changed, 1);
  const stale = add();
  draft = { prompts: [{ identifier: 'user-edit' }] };
  resolveRequest({ changed: true, identifier: 'stale', preset: { prompts: [] } });
  await stale;
  assert.equal(changed, 1);
  assert.equal(draft.prompts[0].identifier, 'user-edit');
  assert.match(all(root).map(n => n.textContent).join(' '), /未覆盖/);
  await panel.refresh();
  assert.equal(draft.prompts[0].identifier, 'user-edit');
});
