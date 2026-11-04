import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/* ------------------------------------------------------------------ DOM stub */

function element(tag) {
  const node = {
    tagName: tag, children: [], parentNode: null, dataset: {}, style: { setProperty() {} }, attributes: {},
    listeners: new Map(), onclick: null, oninput: null, onchange: null,
    checked: false, value: '', disabled: false, hidden: false, className: '', _text: '',
    type: '', rows: 0, placeholder: '', title: '', spellcheck: true, tabIndex: 0, draggable: false,
    files: undefined, src: '', alt: '', decoding: '', accept: '', multiple: false,
    classList: {
      toggle(name, on) { if (on === undefined ? !node.classList.contains(name) : on) node.classList.add(name); else node.classList.remove(name); },
      add(name) { if (!node.classList.contains(name)) node.className = (String(node.className || '') + ' ' + name).trim(); },
      remove(name) { node.className = String(node.className || '').split(/\s+/).filter(token => token && token !== name).join(' '); },
      contains(name) { return String(node.className || '').split(/\s+/).includes(name); },
    },
    append(...kids) { for (const kid of kids) { if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter(n => n !== kid); kid.parentNode = node; node.children.push(kid); } },
    insertBefore(kid, before) { if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter(n => n !== kid); const index = before ? node.children.indexOf(before) : node.children.length; node.children.splice(index, 0, kid); kid.parentNode = node; },
    replaceWith(kid) { const parent = node.parentNode; if (!parent) return; parent.insertBefore(kid, node); parent.children = parent.children.filter(n => n !== node); node.parentNode = null; },
    replaceChildren(...kids) { node.children = []; node.append(...kids); },
    closest(selector) { return matches(node, selector) ? node : node.parentNode?.closest(selector) ?? null; },
    contains(target) { return target === node || node.children.some(kid => kid.contains?.(target)); },
    setAttribute(key, value) { node.attributes[key] = String(value); },
    getAttribute(key) { return node.attributes[key]; },
    removeAttribute(key) { delete node.attributes[key]; },
    addEventListener(type, fn) { if (!node.listeners.has(type)) node.listeners.set(type, []); node.listeners.get(type).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    focus() {},
    querySelectorAll(selector) {
      const out = [];
      const visit = current => { for (const kid of current.children) { if (matches(kid, selector)) out.push(kid); visit(kid); } };
      visit(node);
      return out;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
    click() {
      let cursor = node;
      while (cursor) {
        if (typeof cursor.onclick === 'function') { cursor.onclick({ target: node, currentTarget: cursor, preventDefault() {}, stopPropagation() {} }); return true; }
        cursor = cursor.parentNode;
      }
      return false;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return (node._text + ' ' + node.children.map(child => child.textContent).join(' ')).trim(); },
    set(value) { node._text = String(value); node.children.forEach(child => { child.parentNode = null; }); node.children = []; },
  });
  return node;
}
function matches(node, selector) {
  const attributed = /^([a-z0-9]+)\[([a-z-]+)="([^"]*)"\]$/i.exec(selector);
  if (attributed) {
    return node.tagName === attributed[1]
      && String(node.attributes[attributed[2]] ?? node[attributed[2]] ?? '') === attributed[3];
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const [key, raw] = selector.slice(1, -1).split('=');
    return String(node.dataset[key.replace(/^data-/, '')] ?? '') === String(raw ?? '').replace(/^"|"$/g, '');
  }
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  return node.tagName === selector;
}
const textOf = node => [node._text || '', ...node.children.map(textOf)].join(' ');

/* --------------------------------------------------------- file decode stubs */

const readers = [], images = [];
class FakeFileReader {
  constructor() { readers.push(this); }
  readAsDataURL(file) { this.file = file; }
}
class FakeImage {
  set src(value) { this._src = value; images.push(this); }
  get src() { return this._src; }
}
const flushReaders = () => {
  for (const reader of readers.splice(0)) {
    if (reader.file.fail) { reader.onerror?.(); continue; }
    // 预算按 file.size 记账，所以假 File 的 base64 长度也按声明的字节数生成，
    // 这样“写入后的合计”与真实浏览器一致。
    const declared = reader.file.size ?? 0;
    const generated = declared > 0 ? 'A'.repeat(Math.max(4, Math.ceil(declared / 3) * 4)) : 'QUJDRA==';
    reader.result = 'data:' + reader.file.type + ';base64,' + (reader.file.base64 ?? generated);
    reader.onload?.();
  }
};
const flushImages = (width = 10, height = 10) => {
  for (const image of images.splice(0)) { image.naturalWidth = width; image.naturalHeight = height; image.onload?.(); }
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { flushReaders(); await tick(); flushImages(); await tick(); await tick(); };
const file = (name, type, base64, size) => ({ name, type, base64, size: size ?? Math.ceil((base64 ?? 'QUJDRA==').length * 3 / 4) });

/* ------------------------------------------------------------- workbench page */

function workbench() {
  const nodes = new Map();
  const created = [];
  const make = tag => { const node = element(tag); node.tagName = tag; created.push(node); return node; };
  const get = id => { if (!nodes.has(id)) nodes.set(id, make('div')); return nodes.get(id); };
  const optionNode = value => { const option = make('option'); option.attributes.value = value; option.value = value; return option; };
  const toolScope = make('select');
  toolScope.append(optionNode('mode'), optionNode('session'));
  nodes.set('tool-scope', toolScope);
  const context = {
    URLSearchParams, structuredClone, console, JSON, fetch: async () => { throw new Error('offline'); },
    observeRequestEvents: () => () => {}, observeDisplayAvailability: () => () => {},
    location: { search: '?sessionId=s' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    Option: function (label, value) { const option = make('option'); option.textContent = label; option.value = value; return option; },
    crypto: { randomUUID: () => 'uuid' },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    FileReader: FakeFileReader, Image: FakeImage,
    PresetRequestPreview: { mount: () => ({ stale() {}, clear() {}, show() {} }) },
    renderSPresetTools: () => {}, bindSPresetTools: () => {}, mcpTabNames: () => [], rememberWorkbenchScroll: () => ({}),
    document: {
      getElementById: get, querySelector: () => make('section'), querySelectorAll: () => [],
      createElement: make, createTextNode: text => ({ textContent: text, children: [] }), addEventListener() {},
    },
  };
  context.globalThis = context;
  context.__created = created;
  const script = readFileSync(new URL('../web/editor.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("await import('./dsh-template-editor.js')", '({ renderDshSections: globalThis.renderDshSections })')
    .replace('await guard(() => reload())();', '');
  runInNewContext(script + '\n' + "globalThis.PresetPluginTemplates = undefined;\nrenderList = () => {}; renderEditor = () => {};\nglobalThis.__workbench = {\n  open(presets, id) {\n    state = { revision: 1, presets, sessionMode: 'standard', toolCatalogs: {}, outputExtractionTemplate: 'format' };\n    loadDraft(id);\n  },\n  load: id => loadDraft(id),\n  select(id) { selectedPrompt = id; renderContextFileField(current()); },\n  attach: files => attachContextFiles(files),\n  remove: index => removeContextFileAt(index),\n  prompt: () => current(),\n  draft: () => preset,\n  token: () => contextFileToken,\n  hint: () => $('ctx-file-hint').textContent,\n  count: () => $('ctx-file-count').textContent,\n  renderedImages: () => globalThis.__created.filter(node => node.tagName === 'img'),\n};" + '\n', context);
  return context.__workbench;
}

const promptsOf = () => [
  { identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user', content: '' },
  { identifier: 'main', name: 'Main', role: 'system', content: '正文' },
];

test('workbench drops a late attachment batch after switching presets (race guard)', async () => {
  const ui = workbench();
  ui.open([
    { id: 'A', name: 'A', preset: { prompts: promptsOf() } },
    { id: 'B', name: 'B', preset: { prompts: promptsOf() } },
  ], 'A');
  const before = ui.token();
  const pending = ui.attach([file('late.png', 'image/png')]);
  ui.load('B');
  assert.ok(ui.token() > before, 'loadDraft invalidates the pending batch token');
  await settle();
  await pending;
  assert.equal(ui.draft().prompts.find(prompt => prompt.identifier === 'chatHistory').contextFiles, undefined,
    'the late result never lands in the newly loaded preset');
  assert.equal(ui.draft().prompts.find(prompt => prompt.identifier === 'main').contextFiles, undefined);
});

test('workbench enforces the total byte budget and recovers after removal', async () => {
  const ui = workbench();
  // 预算按 base64 编码后的字符数计：16 MiB 的 data 就是 16 MiB 预算（解码后只有 12 MiB）。
  const big = 'A'.repeat(16 * 1024 * 1024);
  ui.open([{ id: 'A', name: 'A', preset: { prompts: [
    { identifier: 'chatHistory', marker: true, role: 'user', content: '' },
    { identifier: 'main', role: 'user', content: 'x', contextFiles: [
      { kind: 'file', mediaType: 'text/plain', data: big, name: 'existing.txt' },
    ] },
  ] } }], 'A');
  ui.select('main');
  assert.match(ui.count(), /1 \/ 24 项 · 16\.00 MiB \/ 24\.00 MiB/);

  // 16 MiB 已用 + 5 MiB 原始字节（编码后约 6.67 MiB）：仍在上限内。
  const first = ui.attach([file('five.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  await settle();
  await first;
  assert.equal(ui.prompt().contextFiles.length, 2);
  assert.match(ui.hint(), /已附加 1 项 · 合计 2[23]\.\d\d MiB \/ 24\.00 MiB/);

  // 再 5 MiB 超过 24 MiB：跳过并说明剩余额度。
  const rejected = ui.attach([file('another.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  await tick();
  await rejected;
  assert.equal(ui.prompt().contextFiles.length, 2, 'over-budget file is not stored');
  assert.match(ui.hint(), /超过合计 24\.00 MiB 预算（剩余 [\d.]+ MiB）/);

  // 移除一项后预算回升，可以继续添加。
  ui.remove(1);
  assert.equal(ui.prompt().contextFiles.length, 1);
  const accepted = ui.attach([file('another.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  await settle();
  await accepted;
  assert.equal(ui.prompt().contextFiles.length, 2, 'removal frees budget for a new attachment');
});

test('workbench budget counts every prompt of the preset, matching the host limit', async () => {
  const ui = workbench();
  const big = 'A'.repeat(16 * 1024 * 1024); // 每个条目 16 MiB 编码字节，合计 32 MiB 已超预算
  ui.open([{ id: 'A', name: 'A', preset: { prompts: [
    { identifier: 'chatHistory', marker: true, role: 'user', content: '', contextFiles: [
      { kind: 'file', mediaType: 'text/plain', data: big, name: 'a.txt' }] },
    { identifier: 'main', role: 'user', content: 'x', contextFiles: [
      { kind: 'file', mediaType: 'text/plain', data: big, name: 'b.txt' }] },
  ] } }], 'A');
  ui.select('main');
  assert.match(ui.count(), /1 \/ 24 项 · 32\.00 MiB \/ 24\.00 MiB/, 'header shows the preset-wide total');
  const rejected = ui.attach([file('small.txt', 'text/plain', undefined, 1024)]);
  await tick();
  await rejected;
  assert.match(ui.hint(), /超过合计 24\.00 MiB 预算（剩余 0 B）/);
  ui.remove(0);
  const accepted = ui.attach([file('small.txt', 'text/plain', undefined, 1024)]);
  await settle();
  await accepted;
  assert.equal(ui.prompt().contextFiles.length, 1);
});

test('workbench refuses images above the pixel cap and marks thumbnails async', async () => {
  const ui = workbench();
  ui.open([{ id: 'A', name: 'A', preset: { prompts: promptsOf() } }], 'A');
  const huge = ui.attach([file('panorama.png', 'image/png')]);
  await tick();
  flushReaders();
  await tick();
  flushImages(8000, 6000); // 48 MP
  await tick();
  await huge;
  assert.equal(ui.prompt().contextFiles, undefined, 'oversize pixels are refused');
  assert.match(ui.hint(), /8000×6000 超过 40 万像素上限/);

  const ok = ui.attach([file('photo.jpg', 'image/jpeg')]);
  await tick();
  flushReaders();
  await tick();
  flushImages(4000, 3000); // 12 MP
  await tick();
  await ok;
  assert.equal(ui.prompt().contextFiles.length, 1);
  assert.equal(ui.prompt().contextFiles[0].width, 4000);
  const image = ui.renderedImages().find(node => node.className === 'ctx-thumb');
  assert.ok(image, 'accepted image renders a thumbnail');
  assert.equal(image.decoding, 'async');
  assert.match(image.src, /^data:image\/jpeg;base64,/);
});

/* ---------------------------------------------------------------- SPreset page */

function spreset() {
  const nodes = new Map();
  const make = tag => element(tag);
  const get = id => { if (!nodes.has(id)) nodes.set(id, make('div')); return nodes.get(id); };
  const requests = [];
  const state = {
    revision: 1,
    presets: [{ id: 'p1', name: '预设', preset: { prompts: [
      { identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user', content: '' },
      // Attachments need a user entry: the host accepts images in user messages only.
      { identifier: 'main', name: 'Main', role: 'user', content: '正文' },
    ], prompt_order: [{ character_id: '100001', order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'main', enabled: true }] }] } }],
    selectedPresetId: 'p1',
    binding: { presetId: 'p1' },
    sPresetLibrary: { entries: [] },
    sPresetEditor: { locks: {} },
  };
  const context = {
    URLSearchParams, structuredClone, console, setTimeout, clearTimeout, confirm: () => true,
    FileReader: FakeFileReader, Image: FakeImage,
    fetch: async (url, options) => {
      if (!options || !options.body) return { ok: true, json: async () => structuredClone(state) };
      const body = JSON.parse(options.body);
      requests.push(body);
      return { ok: true, json: async () => ({ revision: 2, id: 'p1', entries: state.sPresetLibrary.entries }) };
    },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: value => String(value) },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    Blob: function () {},
    location: { search: '?sessionId=s' },
    window: { addEventListener() {}, open() {}, innerWidth: 1400, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: make, createTextNode: text => ({ textContent: text, children: [] }) },
  };
  context.globalThis = context;
  context.__requests = requests;
  const script = readFileSync(new URL('../web/spreset.js', import.meta.url), 'utf8');
  runInNewContext(script + '\n' + "globalThis.__spreset = {\n  load: id => loadPreset(id),\n  prompt: id => promptOf(id),\n  add(id, files) {\n    const capture = el('p', 'context-file-hint');\n    return addContextFiles(promptOf(id), files, capture).then(() => capture);\n  },\n  savePromptToLibrary: prompt => savePromptToLibrary(prompt),\n  setLibrary: entries => { library = { entries }; },\n  selectChain(id) { selection = { kind: 'chain', id }; renderAll(); },\n  selectLibrary(id) { selection = { kind: 'library', id }; renderAll(); },\n  inspector: () => $('inspector-body'),\n  requests: () => globalThis.__requests,\n};" + '\n', context);
  return context.__spreset;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('spreset enforces the same total budget as the workbench', async () => {
  const ui = spreset();
  await flush();
  ui.selectChain('main');
  const prompt = ui.prompt('main');
  prompt.contextFiles = [{ kind: 'file', mediaType: 'text/plain', data: 'A'.repeat(16 * 1024 * 1024), name: 'existing.txt' }];

  // 16 MiB 已用（按 base64 编码计）+ 5 MiB 原始字节：仍在上限内。
  const first = ui.add('main', [file('five.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  await settle();
  await first;
  assert.equal(ui.prompt('main').contextFiles.length, 2);

  // 再加 5 MiB 超过合计预算：跳过并说明剩余额度。
  const capture = await ui.add('main', [file('another.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  assert.equal(ui.prompt('main').contextFiles.length, 2, 'over-budget file is not stored');
  assert.match(capture.textContent, /超过合计 24\.00 MiB 预算（剩余 [\d.]+ MiB）/);

  // 移除一项后可以再次添加，成功提示带合计占用。
  ui.prompt('main').contextFiles.splice(1, 1);
  const again = ui.add('main', [file('another.txt', 'text/plain', undefined, 5 * 1024 * 1024)]);
  await settle();
  await again;
  assert.equal(ui.prompt('main').contextFiles.length, 2);
  assert.match(textOf(ui.inspector()), /已附加 1 项 · 合计/);
});

test('spreset copies attachments into library templates and renders them read-only', async () => {
  const ui = spreset();
  await flush();
  const prompt = ui.prompt('main');
  prompt.contextFiles = [{ kind: 'file', mediaType: 'text/plain', data: 'aGk=', name: 'note.txt' }];
  await ui.savePromptToLibrary(prompt);
  const saved = ui.requests().find(body => body.action === 'library-save');
  assert.ok(saved, 'library-save request is sent');
  assert.equal(saved.entry.contextFiles.length, 1, 'attachments travel with the template');
  assert.equal(saved.entry.contextFiles[0].name, 'note.txt');
  assert.notEqual(saved.entry.contextFiles, prompt.contextFiles, 'template gets its own copy');

  ui.setLibrary([{ id: 't1', title: '带图模板', role: 'system', content: '', kind: 'template', createdAt: 1, updatedAt: 1,
    contextFiles: [{ kind: 'file', mediaType: 'text/plain', data: 'aGk=', name: 'note.txt' }] }]);
  ui.selectLibrary('t1');
  const inspector = ui.inspector();
  const cards = inspector.querySelectorAll('div').filter(node => node.classList.contains('context-file'));
  assert.equal(cards.length, 1, 'template INSPECTOR lists its attachments');
  assert.ok(cards.every(card => card.querySelectorAll('button').length === 0), 'read-only: no remove button');
  assert.match(textOf(inspector), /note\.txt/);
  assert.doesNotMatch(textOf(inspector), /aGk=/, 'raw base64 is not rendered as text');
});

test('spreset structured tab redacts inline base64 instead of dumping it into the DOM', async () => {
  const ui = spreset();
  await flush();
  ui.prompt('main').contextFiles = [{ kind: 'image', mediaType: 'image/png', data: 'QUJDRA==', name: 'pic.png' }];
  ui.selectChain('main');
  const tab = ui.inspector().querySelectorAll('button').find(node => node.textContent === '结构化');
  assert.ok(tab, 'structured tab exists');
  tab.click();
  const text = textOf(ui.inspector());
  assert.match(text, /<base64 4 B>/);
  assert.doesNotMatch(text, /QUJDRA==/);
});
