import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const element = tag => ({ tag, children: [], textContent: '', hidden: false,
  append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
  removeChild(item) { this.children.splice(this.children.indexOf(item), 1); }, get lastChild() { return this.children.at(-1); },
  get open() { return this._open ?? false; }, set open(value) { this._open = value; this.ontoggle?.(); } });
const all = n => [n, ...n.children.flatMap(all)];
test('history collapses around depth injections; Raw structures and copies the same complete snapshot without callbacks', async () => {
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
  dom.rawButton.onclick(); assert.ok(all(dom.raw).some(n => n.tag === 'summary' && n.textContent === '"messages": 数组 [6]')); assert.equal(dom.output.hidden, true);
  await dom.copyButton.onclick(); assert.equal(copied, raw);
  dom.rawButton.onclick();
  all(dom.output).find(n => n.tag === 'button' && n.textContent === '展开全部').onclick();
  assert.deepEqual(shown(), ['h1', 'depth', 'h2', 'h3', 'h4', 'prefix']);
  assert.equal(chosen, undefined);
  view.show({ id: 'two', source: 'wire', raw: '{"messages":[]}', messages: [] });
  dom.rawButton.onclick(); assert.ok(all(dom.raw).some(n => n.textContent === '"messages": []'));
  view.clear(); assert.equal(dom.rawButton.disabled, true);
});


function rawFixture() {
  let copied;
  const context = { document: { createElement: element }, setTimeout, navigator: { clipboard: { writeText: async value => { copied = value; } } } };
  runInNewContext(readFileSync(new URL('../web/request-preview.js', import.meta.url), 'utf8'), context);
  const dom = Object.fromEntries(['output', 'warnings', 'raw', 'rawButton', 'copyButton', 'note', 'choices'].map(key => [key, element('div')]));
  const view = context.PresetRequestPreview.mount({ ...dom, onChoose() {}, onStatus() {} });
  return { dom, view, copied: () => copied };
}

test('JSON branches are lazy, collapsible and paginated; copying keeps whitespace and precision', async () => {
  const f = rawFixture();
  const raw = ' { "large": 9223372036854775807, "messages": ' + JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ role: 'user', content: 'message ' + i }))) + ' } ';
  f.view.show({ raw, messages: [] }); f.dom.rawButton.onclick();
  assert.ok(all(f.dom.raw).some(n => n.textContent === '9223372036854775807'));
  const list = all(f.dom.raw).find(n => n.tag === 'details' && n.children[0].textContent.includes('"messages"'));
  assert.equal(list.children.length, 1);
  list.open = true;
  assert.equal(all(list).filter(n => n.tag === 'details').length, 51);
  all(list).find(n => n.tag === 'button').onclick();
  assert.equal(all(list).filter(n => n.tag === 'details').length, 101);
  const child = all(list).find(n => n.tag === 'details' && n.children[0].textContent.startsWith('[0]'));
  child.open = true; assert.ok(all(child).some(n => n.textContent === '"message 0"'));
  list.open = false; assert.equal(list.children.length, 1);
  list.open = true; assert.equal(all(list).filter(n => n.tag === 'details').length, 51);
  await f.dom.copyButton.onclick(); assert.equal(f.copied(), raw);
  f.view.show({ raw: '{"other":true}', messages: [] });
  assert.ok(!all(f.dom.raw).some(n => n.textContent.includes('messages')));
  assert.ok(all(f.dom.raw).some(n => n.textContent === 'true'));
});

test('long strings use text nodes, invalid JSON falls back to original text, unavailable Raw cannot copy', async () => {
  const f = rawFixture();
  const literal = '<script>bad()</script>\n' + 'long'.repeat(100);
  const raw = JSON.stringify({ body: literal, values: [false, null, '', {}, []] });
  f.view.show({ raw, messages: [] }); f.dom.rawButton.onclick();
  const text = all(f.dom.raw).find(n => n.tag === 'details' && n.children[0].textContent.includes('字符串'));
  assert.equal(text.children.length, 1); text.open = true;
  assert.equal(text.children[1].textContent, literal);
  await f.dom.copyButton.onclick(); assert.equal(f.copied(), raw);
  f.view.show({ raw: '{ incomplete', messages: [] });
  assert.ok(all(f.dom.raw).some(n => n.tag === 'pre' && n.textContent === '{ incomplete'));
  f.view.show({ unavailable: '未发送', messages: [] });
  assert.equal(f.dom.copyButton.disabled, true);
  f.view.clear(); assert.equal(f.dom.raw.children.length, 0);
});
