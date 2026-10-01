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
    append(...kids) { for (const kid of kids) { if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter(n => n !== kid); kid.parentNode = node; node.children.push(kid); } },
    insertBefore(kid, before) { if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter(n => n !== kid); const index = before ? node.children.indexOf(before) : node.children.length; node.children.splice(index, 0, kid); kid.parentNode = node; },
    replaceWith(kid) { const parent = node.parentNode; parent.insertBefore(kid, node); parent.children = parent.children.filter(n => n !== node); node.parentNode = null; },
    closest(selector) { return selector.split(',').some(part => matches(node, part)) ? node : node.parentNode?.closest(selector) ?? null; },
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
    { identifier: 'other', name: 'Other Prompt', role: 'user', content: '另一个条目' },
  ],
  prompt_order: [
    { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
    // 'main' exists here but is disabled: it must never read as 已启用 in this view.
    { character_id: 100002, order: [{ identifier: 'other', enabled: true }, { identifier: 'main', enabled: false }] },
    // 'main' is absent here, so it shows up in 未使用 - the case the user hit.
    { character_id: 100003, order: [{ identifier: 'other', enabled: true }] },
  ],
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
    sPresetEditor: { locks: {} },
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
    if (body.action === 's-preset-lock') {
      const locks = new Set(state.sPresetEditor.locks[body.presetId] ?? []);
      if (body.locked) locks.add(body.identifier); else locks.delete(body.identifier);
      state.sPresetEditor.locks = { ...state.sPresetEditor.locks, [body.presetId]: [...locks] };
      return { ok: true, json: async () => ({ revision: 2, locks: [...locks] }) };
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
  // Test hook: the editor keeps its working copy in a module-level variable, which loadPreset
  // clones from the record, so assertions must read the draft, not state.presets[0].preset.
  runInNewContext(script + '\nglobalThis.__draft = () => preset;', context);
  return { get, nodes, requests, context, state, draft: () => context.__draft() };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const byText = (root, text) => root.querySelectorAll('div').find(node => node.classList.contains('chain-row') && node.textContent.includes(text));
const badges = node => node.querySelectorAll('span').filter(span => span.classList.contains('badge')).map(span => span.textContent);
const nameBadges = inspector => badges(inspector.querySelectorAll('div').find(node => node.classList.contains('name-row')));
const inspectorOf = ui => ui.get('inspector-body');
const bodyArea = ui => inspectorOf(ui).querySelectorAll('textarea')[0];
const lockBoxOf = inspector => inspector.querySelectorAll('label').find(node => node.textContent.includes('锁定正文'))
  ?.children.find(child => child.tagName === 'input');
const selectGroup = async (ui, characterId) => {
  const select = ui.get('chain-group');
  select.value = String(characterId);
  select.onchange();
  await flush();
};

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

test('锁定正文 blocks editing until it is unlocked, and persists through the editor store', async () => {
  const ui = editor();
  await flush();
  byText(ui.get('chain-list'), 'Main Prompt').click();
  await flush();
  const draftPrompt = () => ui.draft().prompts.find(item => item.identifier === 'main');
  assert.equal(bodyArea(ui).disabled, false, 'the body starts editable');
  assert.equal(draftPrompt().content, '主提示词正文');

  const lockBox = lockBoxOf(inspectorOf(ui));
  assert.ok(lockBox, 'the 锁定正文 toggle exists');
  lockBox.checked = true;
  lockBox.onchange();
  await flush();

  assert.equal(bodyArea(ui).disabled, true, 'a locked body is read-only');
  assert.match(inspectorOf(ui).textContent, /已锁定，防止误编辑；解锁后可编辑/, 'the user is told why and how to unlock');
  // A programmatic write through the page must not change a locked body.
  bodyArea(ui).value = '被篡改';
  bodyArea(ui).oninput();
  assert.equal(draftPrompt().content, '主提示词正文', 'the locked body is not modified');
  assert.equal(bodyArea(ui).value, '主提示词正文', 'the field is reverted');
  // The lock is stored in the editor store, and the reference field is kept in sync.
  assert.deepEqual(ui.state.sPresetEditor.locks.p1, ['main'], 'the lock lives in the editor store');
  assert.equal(draftPrompt().forbid_overrides, true, 'the reference field is mirrored for round-tripping');
  assert.equal(ui.requests.some(body => body.action === 's-preset-lock' && body.locked === true), true);

  // The 编辑 action is refused while locked.
  const editButton = byText(ui.get('chain-list'), 'Main Prompt').querySelectorAll('button').find(button => button.textContent === '编辑');
  editButton.click();
  await flush();
  assert.match(ui.get('state').textContent, /已锁定/, 'the edit action explains the refusal');

  // Unlock from the inspector.
  const unlock = inspectorOf(ui).querySelectorAll('button').find(button => button.textContent === '解锁');
  assert.ok(unlock, 'an unlock affordance is offered');
  unlock.click();
  await flush();
  assert.equal(bodyArea(ui).disabled, false, 'unlocking restores editing');
  assert.deepEqual(ui.state.sPresetEditor.locks.p1 ?? [], [], 'the lock is removed from the store');
  bodyArea(ui).value = '改好了';
  bodyArea(ui).oninput();
  assert.equal(draftPrompt().content, '改好了', 'after unlocking the body is editable again');
});

test('已启用 follows the selected order group; another group is named explicitly', async () => {
  const ui = editor();
  await flush();
  // Group 100001 - the entry the picker points at is enabled.
  byText(ui.get('chain-list'), 'Main Prompt').click();
  await flush();
  assert.equal(nameBadges(inspectorOf(ui)).includes('已启用'), true, 'the current group decides the badge');
  assert.match(ui.get('chain-count').textContent, /1\/1 启用/);

  // Group 100002 - the entry is in the group but disabled.
  await selectGroup(ui, 100002);
  assert.match(ui.get('chain-count').textContent, /1\/2 启用/, 'the counter counts the selected group only');
  byText(ui.get('chain-list'), 'Main Prompt').click();
  await flush();
  assert.equal(nameBadges(inspectorOf(ui)).includes('已启用'), false, 'a disabled entry is not 已启用');
  assert.equal(nameBadges(inspectorOf(ui)).includes('已在其他顺序组启用'), true, 'it names the other group instead');

  // Group 100003 - the entry is not in this group at all, so it shows up in 未使用.
  await selectGroup(ui, 100003);
  const card = ui.get('library-list').querySelectorAll('div').find(node => node.classList.contains('card') && node.textContent.includes('Main Prompt'));
  assert.ok(card, 'the entry appears as 未使用 in this group');
  card.click();
  await flush();
  assert.equal(nameBadges(inspectorOf(ui)).includes('已启用'), false,
    'a 未使用 entry must never show 已启用 - this is the contradiction the user reported');
  assert.equal(nameBadges(inspectorOf(ui)).includes('已在其他顺序组启用'), true);
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


test('pointer sorting reorders before release, stays opaque and supports cancellation', async () => {
  const ui = editor(); await flush(); await selectGroup(ui, 100002);
  const events = new Map();
  ui.context.window.addEventListener = (type, fn) => events.set(type, fn);
  ui.context.window.removeEventListener = (type, fn) => { if (events.get(type) === fn) events.delete(type); };
  ui.context.document.body = element('body');
  ui.context.requestAnimationFrame = () => 1;
  ui.context.cancelAnimationFrame = () => {};
  const list = ui.get('chain-list');
  const wireBounds = () => { for (const row of list.children) row.getBoundingClientRect = () => ({ left: 0, width: 300, height: 50, top: list.children.indexOf(row) * 60, bottom: list.children.indexOf(row) * 60 + 50 }); };
  wireBounds();
  const row = list.children[0];
  const pointer = (y, target = row) => ({ button: 0, pointerId: 1, pointerType: 'mouse', clientY: y, clientX: 10, target, preventDefault() {} });
  row.onpointerdown(pointer(20));
  events.get('pointermove')(pointer(110));
  assert.deepEqual(Array.from(ui.draft().prompt_order[1].order, p => p.identifier), ['main', 'other'], 'order changes during the gesture');
  assert.equal(row.parentNode, ui.context.document.body);
  assert.equal(row.classList.contains('dragging'), true);
  assert.equal(row.style.opacity, undefined, 'no faded native drag image');
  events.get('pointerup')(pointer(110));
  assert.deepEqual(list.children.map(n => n.dataset.id), ['main', 'other']);
  wireBounds();
  const next = list.children[0];
  next.onpointerdown(pointer(20, next));
  events.get('pointermove')(pointer(110, next));
  events.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.deepEqual(Array.from(ui.draft().prompt_order[1].order, p => p.identifier), ['main', 'other'], 'cancel restores the prior order');
  assert.equal(events.has('pointermove'), false);
});
