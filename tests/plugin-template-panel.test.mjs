import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const element = tag => ({ tag, children: [], value: '', textContent: '', open: false,
  append(...nodes) { this.children.push(...nodes); },
  replaceChildren(...nodes) { this.children = nodes; },
  setAttribute() {}, get firstChild() { return this.children[0]; },
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
