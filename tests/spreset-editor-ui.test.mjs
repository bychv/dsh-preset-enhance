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
    tagName: tag, children: [], parentNode: null, dataset: {}, style: {}, attributes: {},
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
    setAttribute(key, value) { node.attributes[key] = String(value); }, getAttribute(key) { return node.attributes[key]; }, removeAttribute(key) { delete node.attributes[key]; }, addEventListener() {},
    getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    querySelectorAll(selector) {
      const out = [];
      const visit = current => { for (const kid of current.children) { if (matches(kid, selector)) out.push(kid); visit(kid); } };
      visit(node);
      return out;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
    click() { return node.disabled ? false : bubble(node, 'onclick'); },
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

function editor(options = {}) {
  const nodes = new Map();
  const create = tag => { const node = element(tag); node.focus = () => { context.document.activeElement = node; }; return node; };
  const get = id => { if (!nodes.has(id)) nodes.set(id, create('div')); return nodes.get(id); };
  const state = {
    revision: 1,
    presets: [{ id: 'p1', name: '测试预设', preset: structuredClone(options.preset ?? PRESET) }],
    selectedPresetId: 'p1',
    binding: { presetId: 'p1' },
    sPresetLibrary: { entries: [
      { id: 't1', title: '人设模板', role: 'system', content: '模板正文', kind: 'template', builtin: true, createdAt: 1, updatedAt: 1 },
    ] },
    sPresetEditor: { locks: options.locks ?? {} },
  };
  const requests = [];
  const fetch = async (url, requestOptions) => {
    // The page always passes an options object; only a body means a POST.
    if (!requestOptions || !requestOptions.body) return { ok: true, json: async () => structuredClone(state) };
    const body = JSON.parse(requestOptions.body);
    requests.push(body);
    if (body.action === 'library-save') {
      if (options.failLibrary) return { ok: false, json: async () => ({ error: '模板保存失败' }) };
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
    if (body.action === 'save') state.presets[0].preset = structuredClone(body.preset);
    return { ok: true, json: async () => ({ revision: 2, id: 'p1' }) };
  };
  const script = readFileSync(new URL('../web/spreset.js', import.meta.url), 'utf8');
  const context = {
    URLSearchParams, structuredClone, console, fetch, setTimeout, clearTimeout, confirm: options.confirm ?? (() => true),
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: value => String(value) },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    Blob: function () {},
    location: { search: '?sessionId=s' },
    window: { addEventListener() {}, open() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: create, createTextNode: text => ({ textContent: text, children: [] }) },
  };
  context.PresetPluginTemplates = options.pluginTemplates ? { mount: () => null, bindings: () => ({}), ...options.pluginTemplates } : undefined;
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

  // Row selection remains available for viewing and unlocking a read-only body.
  byText(ui.get('chain-list'), 'Main Prompt').click();
  assert.equal(bodyArea(ui).disabled, true, 'selecting the row never bypasses the lock');
  byText(ui.get('chain-list'), 'Main Prompt').querySelectorAll('button').find(node => node.title === '更多操作').click();
  assert.equal(ui.get('menu-layer').querySelectorAll('button').find(node => node.textContent === '创建副本').disabled, true);
  ui.get('menu-layer').click();

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
  const toggle = buttons.find(node => node.classList.contains('power'));
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

const chainRow = (ui, id) => ui.get('chain-list').children.find(node => node.dataset.id === id);
const openRowMenu = (ui, id) => {
  chainRow(ui, id).querySelectorAll('button').find(node => node.title === '更多操作').click();
  return ui.get('menu-layer').querySelectorAll('button');
};
const menuAction = (ui, id, label) => openRowMenu(ui, id).find(node => node.textContent === label);
const inspectorRole = ui => inspectorOf(ui).querySelectorAll('select')[0];

test('row roles and power stay in sync with the inspector and survive a save/reload', async () => {
  const ui = editor(); await flush();
  chainRow(ui, 'main').click();
  chainRow(ui, 'main').querySelectorAll('button').find(node => node.dataset.role === 'assistant').click();
  assert.equal(ui.draft().prompts.find(p => p.identifier === 'main').role, 'assistant');
  assert.equal(inspectorRole(ui).value, 'assistant');
  assert.equal(chainRow(ui, 'main').querySelectorAll('button').find(node => node.dataset.role === 'assistant').getAttribute('aria-pressed'), 'true');
  const role = inspectorRole(ui); role.value = 'user'; role.onchange();
  assert.equal(chainRow(ui, 'main').querySelectorAll('button').find(node => node.dataset.role === 'user').getAttribute('aria-pressed'), 'true');
  chainRow(ui, 'main').querySelector('.power').click();
  assert.match(ui.get('chain-count').textContent, /0\/1/);
  assert.equal(nameBadges(inspectorOf(ui)).includes('已启用'), false);
  assert.ok(chainRow(ui, 'main'), 'disabled rows stay used');
  assert.equal(ui.draft().prompt_order[1].order.find(p => p.identifier === 'main').enabled, false);
  ui.get('save-preset').click(); await flush();
  ui.get('preset-select').value = 'p1'; ui.get('preset-select').onchange(); await flush();
  assert.equal(ui.draft().prompts.find(p => p.identifier === 'main').role, 'user');
  assert.equal(ui.draft().prompt_order[0].order[0].enabled, false);
});

test('menu distinguishes moving to unused, copying a template and independent duplicates', async () => {
  const source = structuredClone(PRESET);
  source.prompts[1].injection_depth = 3;
  source.prompts[1].injection_trigger = ['normal'];
  source.prompts[1].unknown = { kept: [1] };
  const ui = editor({ preset: source }); await flush();
  const menu = openRowMenu(ui, 'main');
  assert.deepEqual(menu.map(node => node.textContent), ['上移', '下移', '移到未使用', '复制为模板', '创建副本', '删除']);
  assert.equal(menu[0].disabled, true); assert.equal(menu[1].disabled, true);
  menu.find(node => node.textContent === '复制为模板').click(); await flush();
  const saved = ui.requests.find(body => body.action === 'library-save');
  assert.equal(saved.entry.content, '主提示词正文');
  assert.equal(saved.entry.injectionDepth, 3);
  assert.equal(ui.draft().prompts.length, 3, 'template copy does not change preset prompts');
  chainRow(ui, 'main').querySelector('.power').click();
  menuAction(ui, 'main', '创建副本').click(); await flush();
  const order = ui.draft().prompt_order[0].order;
  const duplicate = ui.draft().prompts.find(p => p.identifier === order[1].identifier);
  assert.notEqual(duplicate.identifier, 'main');
  assert.equal(order[1].enabled, false, 'duplicate inherits current group power');
  assert.equal(duplicate.injection_depth, 3);
  duplicate.unknown.kept.push(2);
  assert.deepEqual(Array.from(ui.draft().prompts[1].unknown.kept), [1], 'nested fields are independent');
  menuAction(ui, 'main', '移到未使用').click(); await flush();
  assert.equal(ui.draft().prompts.some(p => p.identifier === 'main'), true);
  assert.equal(ui.draft().prompt_order[1].order.some(p => p.identifier === 'main'), true, 'other group is preserved');
  assert.equal(ui.draft().prompt_order[0].order.some(p => p.identifier === 'main'), false);
  assert.match(ui.get('library-list').textContent, /Main Prompt/);
});

test('delete removes all order references and only its own template metadata after confirmation', async () => {
  const source = structuredClone(PRESET);
  source.extensions['dsh-preset-enhance'] = {
    templateBindings: { main: { mode: 'linked', providerId: 'demo' }, other: { keep: true } },
    autoTemplateDisabled: ['main', 'other'], unknown: { preserved: true },
  };
  let accept = false, question = '';
  const ui = editor({ preset: source, confirm: text => { question = text; return accept; } }); await flush();
  chainRow(ui, 'main').click();
  menuAction(ui, 'main', '删除').click(); await flush();
  assert.match(question, /2 个顺序组/);
  assert.equal(ui.draft().prompts.some(p => p.identifier === 'main'), true, 'cancel is non-mutating');
  accept = true;
  menuAction(ui, 'main', '删除').click(); await flush();
  assert.equal(ui.draft().prompts.some(p => p.identifier === 'main'), false);
  assert.equal(ui.draft().prompt_order.some(g => g.order.some(p => p.identifier === 'main')), false);
  const meta = ui.draft().extensions['dsh-preset-enhance'];
  assert.equal(Object.hasOwn(meta.templateBindings, 'main'), false);
  assert.equal(meta.templateBindings.other.keep, true);
  assert.deepEqual(Array.from(meta.autoTemplateDisabled), ['other']);
  assert.equal(meta.unknown.preserved, true);
  assert.match(inspectorOf(ui).textContent, /选择一个条目/);
  ui.get('save-preset').click(); await flush();
  ui.context.loadPreset('p1');
  assert.equal(ui.draft().prompts.some(p => p.identifier === 'main'), false);
});

test('marker, linked and locked entries cannot be copied through row shortcuts or direct actions', async () => {
  const source = structuredClone(PRESET);
  source.prompt_order[0].order.push({ identifier: 'chatHistory', enabled: true }, { identifier: 'other', enabled: true });
  const ui = editor({ preset: source, locks: { p1: ['main'] }, pluginTemplates: {
    linked: (_preset, id) => id === 'other',
  } }); await flush();
  for (const id of ['main', 'chatHistory', 'other']) {
    assert.equal(menuAction(ui, id, '创建副本').disabled, true);
    ui.context.copyChainItem(ui.draft().prompt_order[0].order.findIndex(p => p.identifier === id));
    await ui.context.savePromptToLibrary(ui.draft().prompts.find(p => p.identifier === id));
  }
  assert.equal(ui.draft().prompts.length, 3);
  assert.equal(ui.requests.some(body => body.action === 'library-save'), false);
  for (const id of ['chatHistory', 'other']) {
    const roles = chainRow(ui, id).querySelectorAll('button').filter(node => node.dataset.role);
    assert.equal(roles.every(node => node.disabled), true);
    ui.context.changePromptRole(id, 'assistant');
    assert.equal(ui.draft().prompts.find(p => p.identifier === id).role, 'user');
    chainRow(ui, id).click();
    assert.equal(inspectorRole(ui).disabled, true);
  }
  assert.equal(menuAction(ui, 'main', '删除').disabled, true);
  assert.equal(menuAction(ui, 'chatHistory', '删除').disabled, true);
  assert.equal(menuAction(ui, 'other', '删除').disabled, false, 'an unlocked linked prompt can be deleted without deleting the provider');
});

test('menu keyboard navigation skips disabled items, restores focus and catches failed template saves', async () => {
  const ui = editor({ failLibrary: true }); await flush();
  const row = chainRow(ui, 'main');
  const anchor = row.querySelectorAll('button').find(node => node.title === '更多操作');
  const menu = openRowMenu(ui, 'main');
  assert.equal(ui.context.document.activeElement, menu[2]);
  const key = (key, shiftKey = false) => ui.get('menu-layer').onkeydown({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
  key('End'); assert.equal(ui.context.document.activeElement, menu[5]);
  key('ArrowDown'); assert.equal(ui.context.document.activeElement, menu[2]);
  key('Tab', true); assert.equal(ui.context.document.activeElement, menu[5]);
  key('Escape'); assert.equal(ui.get('menu-layer').hidden, true);
  assert.equal(ui.context.document.activeElement, anchor);
  menuAction(ui, 'main', '复制为模板').click(); await flush();
  assert.match(ui.get('state').textContent, /模板保存失败/);
  assert.equal(ui.get('state').classList.contains('error'), true);
  assert.equal(ui.draft().prompts.length, 3);
});

test('row shortcut keyboard and pointer events do not select or drag the row', async () => {
  const ui = editor(); await flush();
  const row = chainRow(ui, 'main'), role = row.querySelectorAll('button').find(node => node.dataset.role === 'user');
  row.onkeydown({ target: role, key: 'Enter', preventDefault() { throw new Error('row intercepted button'); } });
  row.onpointerdown({ target: role, button: 0 });
  role.click();
  assert.equal(ui.draft().prompts.find(p => p.identifier === 'main').role, 'user');
  assert.match(inspectorOf(ui).textContent, /选择一个条目/, 'role change does not select the row');
});


test('menu move actions update the current order without changing other groups', async () => {
  const ui = editor(); await flush(); await selectGroup(ui, 100002);
  const before = JSON.stringify(ui.draft().prompt_order[0]);
  menuAction(ui, 'main', '上移').click(); await flush();
  assert.deepEqual(Array.from(ui.draft().prompt_order[1].order, p => p.identifier), ['main', 'other']);
  assert.deepEqual(ui.get('chain-list').children.map(p => p.dataset.id), ['main', 'other']);
  menuAction(ui, 'main', '下移').click(); await flush();
  assert.deepEqual(Array.from(ui.draft().prompt_order[1].order, p => p.identifier), ['other', 'main']);
  assert.equal(JSON.stringify(ui.draft().prompt_order[0]), before);
});

test('model alias displays as assistant and copies to the library with its canonical role', async () => {
  const source = structuredClone(PRESET); source.prompts[1].role = 'model';
  const ui = editor({ preset: source }); await flush();
  assert.equal(chainRow(ui, 'main').querySelectorAll('button').find(b => b.dataset.role === 'assistant').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.draft().prompts[1].role, 'model', 'rendering does not rewrite an imported alias');
  menuAction(ui, 'main', '复制为模板').click(); await flush();
  assert.equal(ui.requests.find(body => body.action === 'library-save').entry.role, 'assistant');
});
