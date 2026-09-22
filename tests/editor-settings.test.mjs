import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('../web/editor.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/, '').replace('await guard(() => reload())();', '');
function editor(storage = new Map(), fetch = async () => { throw new Error('offline'); }) {
  const nodes = new Map();
  const node = () => ({ checked: false, value: '', dataset: {}, style: {}, hidden: false,
    classList: { toggle() {}, add() {}, remove() {} }, append() {}, replaceChildren() {},
    addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], setAttribute() {} });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = { URLSearchParams, structuredClone, console, fetch,
    location: { search: '?sessionId=s' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: () => 1, clearTimeout() {},
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: node },
  };
  runInNewContext(script + `
    renderList = () => {}; renderEditor = () => {};
    globalThis.editor = { setup() {
      state = { revision: 1, presets: [], sessionMode: 'standard', toolCatalogs: {}, outputExtractionTemplate: 'format' };
      $('tool-mode').value = 'standard'; $('tool-scope').value = 'session';
      $('tool-auto-save').checked = true; $('order').value = '100001'; loadToolDraft(true);
    }, toggleExtraction() { $('prefix-output-extraction').checked = true; $('prefix-output-extraction').onchange(); },
    prompt: () => preset.prompts.find(p => p.identifier === 'dsh-output-extraction-template'),
    order: () => order(),
    protocol(value) {
      state.connectionChoice = { provider: 'p', model: null, reasoningEffort: null, canSwitch: true,
        choices: [{ provider: 'p', label: 'p', protocol: value, defaultModel: '' }] };
      state.connection = { source: 'settings', protocol: value };
      renderConnectionChoice();
    },
    change(value) { toolDraft.policy.read = value; markToolDirty(); },
    draft: () => toolDraft,
    save: runAutoSave, flush: flushToolDraftKeepalive,
    };
  `, context);
  context.editor.setup();
  return { ...context.editor, get, storage };
}

test('Messages disables prefill; enabling extraction inserts one template and preserves edits', () => {
  const ui = editor();
  ui.protocol('messages');
  assert.equal(ui.get('prefill-settings').disabled, true);
  assert.equal(ui.get('connection-select').disabled, false);
  ui.protocol('chat-completions');
  assert.equal(ui.get('prefill-settings').disabled, false);
  ui.toggleExtraction();
  assert.equal(ui.prompt().content, 'format');
  ui.prompt().content = 'edited';
  ui.toggleExtraction();
  assert.equal(ui.prompt().content, 'edited');
  assert.equal(ui.order().filter(p => p.identifier === ui.prompt().identifier).length, 1);
});

test('latest edit survives refresh while an older tool save is in flight', async () => {
  let finish;
  const storage = new Map();
  const ui = editor(storage, () => new Promise(resolve => { finish = resolve; }));
  ui.change(false);
  const saving = ui.save();
  await Promise.resolve();
  ui.change(true);
  assert.equal(ui.flush(), 0);
  finish({ ok: true, json: async () => ({ revision: 2 }) });
  await saving;
  const recovered = editor(storage, async () => ({ ok: true, json: async () => ({ revision: 3 }) }));
  assert.equal(recovered.draft().policy.read, true);
  assert.equal(recovered.draft().dirty, true);
  await recovered.save();
  assert.equal(recovered.draft().dirty, false);
  assert.equal(storage.size, 0);
});

test('failed keepalive keeps a recoverable draft', async () => {
  const ui = editor();
  ui.change(false);
  assert.equal(ui.flush(), 1);
  await new Promise(resolve => setImmediate(resolve));
  const recovered = editor(ui.storage);
  assert.equal(recovered.draft().policy.read, false);
  assert.equal(recovered.draft().dirty, true);
});
