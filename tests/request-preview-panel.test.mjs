import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const element = tag => ({ tag, children: [], textContent: '', hidden: false,
  append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
  removeChild(item) { this.children.splice(this.children.indexOf(item), 1); }, get lastChild() { return this.children.at(-1); },
  get open() { return this._open ?? false; }, set open(value) { this._open = value; this.ontoggle?.(); } });
const all = n => [n, ...n.children.flatMap(all)];
test('history collapses around depth injections; Raw shows and copies the same complete snapshot without callbacks', async () => {
  let copied, chosen;
  const context = { document: { createElement: element }, setTimeout, navigator: { clipboard: { writeText: async value => { copied = value; } } } };
  runInNewContext(readFileSync(new URL('../web/request-preview.js', import.meta.url), 'utf8'), context);
  const dom = Object.fromEntries(['output', 'warnings', 'raw', 'rawButton', 'copyButton', 'note', 'choices'].map(key => [key, element('div')]));
  const view = context.PresetRequestPreview.mount({ ...dom, onChoose: id => { chosen = id; }, onStatus() {} });
  const message = (name, history) => ({ role: history ? 'user' : 'system', previewHistory: history, content: [{ type: 'text', text: name }] });
  const messages = [message('h1', true), message('depth', false), message('h2', true), message('h3', true), message('h4', true), message('prefix', false)];
  const raw = '{"messages":' + JSON.stringify(messages) + '}';
  view.show({ id: 'one', source: 'wire', raw, messages, choices: [{ id: 'one', attempt: 1 }, { id: 'two', attempt: 1 }] });
  const shown = () => all(dom.output).filter(n => n.tag === 'pre').map(n => n.textContent);
  assert.deepEqual(shown(), ['depth', 'h3', 'h4', 'prefix']);
  dom.rawButton.onclick(); assert.equal(dom.raw.textContent, raw); assert.equal(dom.output.hidden, true);
  await dom.copyButton.onclick(); assert.equal(copied, raw);
  dom.rawButton.onclick();
  all(dom.output).find(n => n.tag === 'button' && n.textContent === '展开全部').onclick();
  assert.deepEqual(shown(), ['h1', 'depth', 'h2', 'h3', 'h4', 'prefix']);
  assert.equal(chosen, undefined);
  view.show({ id: 'two', source: 'wire', raw: '{"messages":[]}', messages: [] });
  dom.rawButton.onclick(); assert.equal(dom.raw.textContent, '{"messages":[]}');
  view.clear(); assert.equal(dom.rawButton.disabled, true);
});
