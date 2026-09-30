import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * DOM stub for web/spreset.js.
 *
 * It models what the page relies on: a parent chain, bubbling clicks (walking up to the nearest
 * onclick handler, like a real click does), and the small selector set the script uses. That is
 * enough to exercise selection outside a browser.
 */
function element(tag) {
  const node = {
    tagName: tag, children: [], parentNode: null, dataset: {}, style: {},
    onclick: null, oninput: null, onchange: null, ondragstart: null, ondragend: null,
    ondragover: null, ondrop: null, onkeydown: null,
    checked: false, value: '', disabled: false, hidden: false, className: '', _text: '',
    type: '', rows: 0, placeholder: '', title: '', spellcheck: true, tabIndex: 0, draggable: false,
    files: undefined,
    // className and classList are linked, as in a real DOM: the page sets both.
    classList: {
      toggle(name, on) { if (on === undefined ? !node.classList.contains(name) : on) node.classList.add(name); else node.classList.remove(name); },
      add(name) { if (!node.classList.contains(name)) node.className = (String(node.className || '') + ' ' + name).trim(); },
      remove(name) { node.className = String(node.className || '').split(/\s+/).filter(token => token && token !== name).join(' '); },
      contains(name) { return String(node.className || '').split(/\s+/).includes(name); },
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    replaceChildren(...kids) { node.children = []; node.append(...kids); },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    querySelectorAll(selector) {
      const out = [];
      const visit = current => { for (const kid of current.children) { if (matches(kid, selector)) out.push(kid); visit(kid); } };
      visit(node);
      return out;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
    click() { return bubble(node, 'onclick'); },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return (node._text + ' ' + node.children.map(child => child.textContent).join(' ')).trim(); },
    set(value) { node._text = String(value); node.children.forEach(child => { child.parentNode = null; }); node.children = []; },
  });
  return node;
}
function matches(node, selector) {
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const [key, raw] = selector.slice(1, -1).split('=');
    const value = String(raw ?? '').replace(/^"|"$/g, '');
    return String(node.dataset[key.replace(/^data-/, '')] ?? '') === value;
  }
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  return node.tagName === selector;
}
/** Real clicks bubble: invoke the nearest ancestor handler, letting it stop propagation. */
function bubble(node, handler) {
  let stopped = false;
  const event = {
    currentTarget: null, target: node,
    preventDefault() {}, stopPropagation() { stopped = true; },
    dataTransfer: { effectAllowed: '', dropEffect: '' },
  };
  let cursor = node;
  while (cursor && !stopped) {
    if (typeof cursor[handler] === 'function') { event.currentTarget = cursor; cursor[handler](event); return true; }
    cursor = cursor.parentNode;
  }
  return false;
}

const PRESET = {
  dsh_system_prompt_enabled: true,
  prompts: [
    { identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user', content: '' },
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示词正文' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  extensions: { SPreset: { MacroNest: false } },
};

function editor() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
  const state = {
    revision: 1,
    presets: [{ id: 'p1', name: '测试预设', preset: structuredClone(PRESET) }],
    selectedPresetId: 'p1',
    binding: { presetId: 'p1' },
    sPresetLibrary: { entries: [
      { id: 't1', title: '人设模板', role: 'system', content: '模板正文', kind: 'template', builtin: true, createdAt: 1, updatedAt: 1 },
    ] },
  };
  const requests = [];
  const fetch = async (url, options) => {
    // The page always passes an options object; only a body means a POST.
    if (!options || !options.body) return { ok: true, json: async () => structuredClone(state) };
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === 'library-save') {
      const entry = { ...body.entry, id: body.entry.id || 'new-id' };
      state.sPresetLibrary.entries = [...state.sPresetLibrary.entries.filter(item => item.id !== entry.id), entry];
      return { ok: true, json: async () => ({ revision: 2, entry, created: true, entries: state.sPresetLibrary.entries }) };
    }
    if (body.action === 's-preset-plan') {
      return { ok: true, json: async () => ({ present: true, settings: {}, defaults: {}, regexes: [], regexDepth: 0,
        chatSquash: {}, outputPreprocessing: {}, toolBindings: null, messageInjections: null,
        fixedPresetName: '', macroNest: false, tavernHelperScripts: 0 }) };
    }
    return { ok: true, json: async () => ({ revision: 2, id: 'p1' }) };
  };
  const script = readFileSync(new URL('../web/spreset.js', import.meta.url), 'utf8');
  const context = {
    URLSearchParams, structuredClone, console, fetch, setTimeout, clearTimeout, confirm: () => true,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: value => String(value) },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    Blob: function () {},
    location: { search: '?sessionId=s' },
    window: { addEventListener() {}, open() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: element, createTextNode: text => ({ textContent: text, children: [] }) },
  };
  context.globalThis = context;
  runInNewContext(script, context);
  return { get, nodes, requests, context, state };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const byText = (root, text) => root.querySelectorAll('div').find(node => node.classList.contains('chain-row') && node.textContent.includes(text));

test('clicking a chain row selects it and opens the INSPECTOR', async () => {
  const ui = editor();
  await flush();
  const row = byText(ui.get('chain-list'), 'Main Prompt');
  assert.ok(row, 'the chain renders a row for the ordered prompt');
  assert.match(ui.get('inspector-body').textContent, /在资源库或提示词链里选择一个条目/);
  row.click();
  await flush();
  assert.match(ui.get('inspector-title').textContent, /INSPECTOR · 条目/);
  const inspector = ui.get('inspector-body');
  // The entry name is an input's value; the rest is text.
  assert.ok(inspector.querySelectorAll('input').some(input => input.value === 'Main Prompt'),
    'the inspector shows the selected entry');
  assert.match(inspector.textContent, /条目类型/, 'and its entry type control');
  assert.match(inspector.textContent, /提示词正文/, 'and the body editor');
  assert.match(inspector.querySelectorAll('textarea')[0]?.value ?? '', /主提示词正文/, 'with the entry body');
  // The row is rebuilt on selection, so look it up again.
  assert.ok(byText(ui.get('chain-list'), 'Main Prompt').classList.contains('selected'), 'the row is highlighted');
});

test('clicking a library card selects it and opens the INSPECTOR · 模板', async () => {
  const ui = editor();
  await flush();
  ui.get('seg-templates').click();
  const card = ui.get('library-list').querySelectorAll('div').find(node => node.classList.contains('card'));
  assert.ok(card, 'the template card renders');
  card.click();
  await flush();
  assert.match(ui.get('inspector-title').textContent, /INSPECTOR · 模板/);
  // The entry name lives in an input's value, not in text content.
  assert.ok(ui.get('inspector-body').querySelectorAll('input').some(input => input.value === '人设模板'),
    'the inspector edits the selected template');
  assert.match(ui.get('inspector-body').textContent, /保存模板/);
});

test('a row action button does not change the selection accidentally', async () => {
  const ui = editor();
  await flush();
  const row = byText(ui.get('chain-list'), 'Main Prompt');
  const buttons = row.querySelectorAll('button');
  const toggle = buttons.find(node => node.textContent === '⏻');
  assert.ok(toggle, 'the enable action exists');
  ui.get('inspector-body').replaceChildren();
  ui.get('inspector-title').textContent = 'INSPECTOR';
  toggle.click();
  await flush();
  assert.match(ui.get('inspector-title').textContent, /^INSPECTOR$/, 'the power action must not select the row');
});
