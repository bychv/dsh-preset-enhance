const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId') || '';
// The compiler's whitelist: role values it accepts, and the marker identifiers it fills in.
const ROLES = [['system', 'System'], ['user', 'User'], ['assistant', 'Assistant'], ['model', 'Model']];
const ROLE_LABEL = { system: 'SYSTEM', user: 'USER', assistant: 'ASSISTANT', model: 'MODEL' };
const ROLE_NAME = Object.fromEntries(ROLES);
const QUICK_ROLES = [['system', '系统'], ['user', '用户'], ['assistant', '助手']];
const ICONS = {
  system: '<path d="M5 6h14M5 18h14M5 12h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  assistant: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12v3M16 12v3M1 12h3M20 12h3"/>',
  power: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  up: '<path d="m5 10 7-7 7 7M12 3v18"/>',
  down: '<path d="m5 14 7 7 7-7M12 3v18"/>',
  unused: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  template: '<path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
};
const UNCATEGORIZED = '未分类';
const TABS = ['内容', '注入', '工具', '结构化'];
const NOT_IMPLEMENTED = '本插件未实现（数据原样保留）';
// 酒馆/SPreset 侧设置：本插件既不读取也不执行，但会原样保存。界面在每个控件旁给出这句提示。
const ST_ONLY = '酒馆/SPreset 侧功能，本插件不读取，仅原样保存';
const ST_ONLY_SHORT = '本插件不读取该字段';
// 参考编辑器暴露、但本插件编译器不读取的条目字段。
const ST_ONLY_PROMPT_FIELDS = ['hide_from_list', 'system_prompt', 'spreset_condition_script'];
// 根据条件自动启用 写入的初始表达式（酒馆/SPreset 侧求值；本插件不执行）。
const DEFAULT_CONDITION_SCRIPT = '({ model, provider, entry, chat }) => true';
const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
// Tavern's built-in markers, shown as 内置 badges on chain rows.
const BUILTIN_IDS = new Set(['main', 'jailbreak', 'nsfw', 'enhanceDefinitions', 'personaDescription',
  'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario',
  'dialogueExamples', 'chatHistory', 'systemPrompt', 'worldInfoDepth']);

let state = { revision: 0, presets: [] };
let preset = null;
let presetId = '';
let presetName = '';
let presetDirty = false;
let templateDirty = false;
let library = { entries: [] };
let pluginTemplatePanel = null;
const isLinkedTemplate = id => globalThis.PresetPluginTemplates?.linked(preset, id) === true;
let segment = 'unused';
let search = '';
let roleFilter = '';
let groupId = '';
let selection = null;
let inspectorTab = '内容';
let cancelChainDrag = null;
let menuAnchor = null;
// Editor-side entry locks, keyed by preset id (state.sPresetEditor). Never written into a preset:
// the preset field forbid_overrides is mirrored for round-tripping, but the guard reads this.
let editorLocks = { locks: {} };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function button(label, title, onClick, cls) {
  const node = el('button', cls, label);
  if (title) node.title = title;
  node.type = 'button';
  node.onclick = event => { if (event) event.stopPropagation(); onClick(event); };
  return node;
}
function actionIcon(name) {
  const node = el('span', 'action-icon');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return node;
}
function iconButton(icon, label, onClick, cls = '') {
  const node = button('', label, onClick, 'action-button ' + cls);
  node.setAttribute('aria-label', label);
  node.append(actionIcon(icon));
  return node;
}
function roleReadOnlyReason(prompt) {
  if (!prompt) return '提示词不存在';
  if (isLinkedTemplate(prompt.identifier)) return '插件模板的角色只读';
  if (prompt.marker === true || prompt.identifier === 'chatHistory') return '占位符的角色由内容来源决定';
  return '';
}
function copyReadOnlyReason(prompt) {
  if (!prompt) return '提示词不存在';
  if (prompt.marker === true || prompt.identifier === 'chatHistory') return '占位符不能复制为普通提示词';
  if (isLinkedTemplate(prompt.identifier)) return '请先解除插件关联，再复制';
  if (isBodyLocked(prompt, false)) return '请先解锁正文，再复制';
  return '';
}
function field(labelText, control) {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', labelText), control);
  return wrap;
}
function status(text, kind) {
  const node = $('state');
  node.textContent = text;
  node.className = 'state' + (kind ? ' ' + kind : '');
}
function short(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}
function fmtCount(value) { return Number(value || 0).toLocaleString('en-US'); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(16).slice(2); }
function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function api(body) {
  const url = '/preset-enhance/api?sessionId=' + encodeURIComponent(sessionId);
  const res = await fetch(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, ...body }),
  } : {});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '请求失败');
  return result;
}
function guard(fn) {
  return async event => {
    try { await fn(event); } catch (error) { status(error.message, 'error'); }
  };
}

/* ------------------------------------------------------------------ preset */

function chainGroups() { return preset?.prompt_order ?? []; }
function currentGroup() { return chainGroups().find(group => String(group.character_id) === groupId) ?? chainGroups()[0]; }
function chainOrder() { return currentGroup()?.order ?? []; }
function promptOf(identifier) { return (preset?.prompts ?? []).find(prompt => prompt.identifier === identifier); }
function lockedIds() {
  const list = editorLocks?.locks?.[presetId];
  return new Set(Array.isArray(list) ? list : []);
}
/** True when this entry's body is locked against editing in the editor (editor guard only). */
function isBodyLocked(source, isTemplate) {
  if (!source) return false;
  if (isTemplate) return source.forbidOverrides === true;
  return lockedIds().has(source.identifier);
}
async function setLock(source, isTemplate, locked) {
  if (isTemplate) {
    source.forbidOverrides = locked;
    templateDirty = true;
    status(locked ? '已锁定，防止误编辑；解锁后可编辑' : '已解锁，可以编辑正文', 'dirty');
    renderInspector();
    return;
  }
  // The plugin store owns the guard; the preset field is kept in sync for round-tripping.
  source.forbid_overrides = locked;
  markPreset();
  const result = await api({ action: 's-preset-lock', presetId, identifier: source.identifier, locked });
  state.revision = Number.isInteger(result.revision) ? result.revision : state.revision + 1;
  editorLocks = { locks: { ...(editorLocks.locks ?? {}), [presetId]: result.locks ?? [] } };
  if (!(result.locks ?? []).length) delete editorLocks.locks[presetId];
  status(locked ? '已锁定，防止误编辑；解锁后可编辑' : '已解锁，可以编辑正文');
  renderAll();
}
function chainIdentifiers() { return new Set(chainOrder().map(item => item.identifier)); }
let draftVersion = 0, autoSaveTimer, saveChain = Promise.resolve();
function scheduleEditorSave() {
  clearTimeout(autoSaveTimer);
  if ($('regex-auto-save').checked && presetDirty) autoSaveTimer = setTimeout(() => { void savePreset().catch(error => status(error.message, 'error')); }, 700);
}
function markPreset() { draftVersion++; presetDirty = true; status('未保存修改', 'dirty'); scheduleEditorSave(); }
function markSaved(text) { presetDirty = false; templateDirty = false; status(text || '已保存'); }

function renderPresetSelect() {
  const select = $('preset-select');
  select.replaceChildren();
  for (const record of state.presets ?? []) {
    const option = el('option', '', record.name || record.id);
    option.value = record.id;
    select.append(option);
  }
  select.value = presetId;
}
function loadPreset(id) {
  clearTimeout(autoSaveTimer); draftVersion++;
  const record = (state.presets ?? []).find(item => item.id === id) ?? (state.presets ?? [])[0];
  if (!record) { status('没有可用预设', 'error'); return false; }
  presetId = record.id;
  presetName = record.name || record.id;
  // structuredClone keeps every unknown field of every prompt, so a save writes them back unchanged.
  preset = structuredClone(record.preset ?? { prompts: [], prompt_order: [] });
  if (!Array.isArray(preset.prompts)) preset.prompts = [];
  if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
  const binding = state.binding ?? {};
  const preferred = binding.presetId === presetId && binding.characterId != null ? String(binding.characterId) : '';
  groupId = String(chainGroups().find(group => preferred && String(group.character_id) === preferred)?.character_id
    ?? chainGroups()[0]?.character_id ?? '100001');
  selection = null;
  presetDirty = false;
  templateDirty = false;
  $('preset-select').value = presetId;
  renderAll();
  return true;
}

/* ----------------------------------------------------------------- library */

function libraryEntries() { return library.entries ?? []; }
function unusedPrompts() {
  const used = chainIdentifiers();
  return (preset?.prompts ?? []).filter(prompt => prompt && !used.has(prompt.identifier));
}
function libraryCategories(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim() : UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}
function matches(text) {
  if (roleFilter && text.role !== roleFilter) return false;
  if (!search) return true;
  const needle = search.toLowerCase();
  return [text.title, text.content, text.id].some(value => String(value || '').toLowerCase().includes(needle));
}
function renderLibrary() {
  const list = $('library-list');
  list.replaceChildren();
  $('count-unused').textContent = String(unusedPrompts().length);
  $('count-templates').textContent = String(libraryEntries().length);
  $('seg-unused').classList.toggle('active', segment === 'unused');
  $('seg-templates').classList.toggle('active', segment === 'templates');

  if (segment === 'unused') {
    const rows = unusedPrompts()
      .map(prompt => ({ kind: 'prompt', id: prompt.identifier, title: prompt.name || prompt.identifier, role: prompt.role === 'model' ? 'assistant' : prompt.role || 'system', content: prompt.content || '', prompt }))
      .filter(matches);
    list.append(el('div', 'section-title', '未使用（' + rows.length + '）'));
    if (!rows.length) list.append(el('p', 'empty', '没有匹配的未使用条目。'));
    for (const row of rows) list.append(renderLibraryCard(row));
    return;
  }
  const rows = libraryEntries()
    .map(entry => ({ kind: 'library', id: entry.id, title: entry.title, role: entry.role, content: entry.content, entry }))
    .filter(matches);
  const groups = libraryCategories(rows);
  if (!groups.size) list.append(el('p', 'empty', '资源库还没有模板，点右上角 + 新建。'));
  for (const [category, entries] of groups) {
    list.append(el('div', 'section-title', category + '模板（' + entries.length + '）'));
    for (const entry of entries) list.append(renderLibraryCard(entry));
  }
}
function renderLibraryCard(row) {
  const card = el('div', 'card' + (selection && selection.kind === row.kind && selection.id === row.id ? ' selected' : ''));
  const top = el('div', 'card-top');
  top.append(el('span', 'name', row.title), el('span', 'badge role', ROLE_LABEL[row.role] || String(row.role).toUpperCase()));
  const actions = el('span', 'card-actions');
  actions.append(
    button('加入', '加入当前提示词链', () => insertIntoChain(row), 'primary'),
    button('复制', '复制一份', () => duplicateRow(row)),
    button('下载', '下载为 JSON', () => downloadJson(exportRow(row), (row.title || 'entry') + '.json')),
    button('…', '更多', event => openMenu(event.currentTarget, libraryMenu(row))),
  );
  top.append(actions);
  card.append(top, el('p', 'preview', short(row.content, 90) || '（空内容）'));
  card.onclick = () => { selection = { kind: row.kind, id: row.id }; renderAll(); };
  return card;
}
function libraryMenu(row) {
  const items = [['在检视器中打开', () => { selection = { kind: row.kind, id: row.id }; renderAll(); }]];
  if (row.kind === 'library') {
    items.push(['加入当前预设链', () => insertIntoChain(row)]);
    items.push(['删除模板', () => removeLibraryEntry(row.id)]);
  } else {
    items.push(['存为资源库模板', () => savePromptToLibrary(row.prompt)]);
  }
  return items;
}
function exportRow(row) {
  if (row.kind === 'library') return row.entry;
  return { title: row.title, role: row.role, content: row.content, identifier: row.id };
}
function duplicateRow(row) {
  if (row.kind !== 'library') { savePromptToLibrary(row.prompt); return; }
  saveLibrary({ ...row.entry, id: '', title: row.title + ' 副本' });
}

/* ------------------------------------------------------------------- chain */

function renderChain() {
  cancelChainDrag?.();
  const list = $('chain-list');
  list.replaceChildren();
  const order = chainOrder();
  const enabled = order.filter(item => item.enabled !== false).length;
  $('chain-count').textContent = enabled + '/' + order.length + ' 启用';
  const groupSelect = $('chain-group');
  groupSelect.replaceChildren();
  for (const group of chainGroups()) {
    const option = el('option', '', '顺序表 ' + group.character_id);
    option.value = String(group.character_id);
    groupSelect.append(option);
  }
  groupSelect.value = groupId;
  if (!order.length) list.append(el('p', 'empty', '这条顺序流程还是空的，从资源库加入条目或点 + 新增。'));
  order.forEach((item, index) => list.append(renderChainRow(item, index)));
}
function renderChainRow(item, index) {
  const prompt = promptOf(item.identifier) ?? { identifier: item.identifier, name: item.identifier, role: 'system', content: '' };
  const row = el('div', 'chain-row' + (selection && selection.kind === 'chain' && selection.id === item.identifier ? ' selected' : '')
    + (item.enabled === false ? ' disabled' : ''));
  row.dataset.id = item.identifier;
  row.draggable = false;
  // Selecting the row is what opens the INSPECTOR. The row actions below stop propagation, so
  // copy/edit/power/… keep their own behaviour and a click anywhere else in the row selects.
  const select = () => { selection = { kind: 'chain', id: item.identifier }; renderAll(); };
  row.onclick = select;
  row.title = '点击在 INSPECTOR 中查看';
  row.tabIndex = 0;
  row.onkeydown = event => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  };
  row.onpointerdown = event => beginChainDrag(event, row, item.identifier);
  row.append(el('span', 'handle', '⠿'));
  const main = el('div', 'chain-main');
  const top = el('div', 'chain-top');
  top.append(el('span', 'name', prompt.name || item.identifier));
  if (prompt.marker === true) top.append(el('span', 'badge marker', '占位符'));
  if (BUILTIN_IDS.has(item.identifier)) top.append(el('span', 'badge builtin', '内置'));
  if (prompt.injection_position === 1) top.append(el('span', 'badge', '注入'));
  main.append(top, el('p', 'preview', short(prompt.content, 90) || '（空内容）'));
  const actions = el('span', 'row-actions');
  const roles = el('span', 'role-switch');
  roles.setAttribute('role', 'group');
  roles.setAttribute('aria-label', '消息角色');
  const roleReason = roleReadOnlyReason(promptOf(item.identifier));
  for (const [value, label] of QUICK_ROLES) {
    const active = (prompt.role === 'model' ? 'assistant' : prompt.role || 'system') === value;
    const node = iconButton(value, label + '消息', () => changePromptRole(item.identifier, value), active ? 'active' : '');
    node.dataset.role = value;
    node.setAttribute('aria-pressed', String(active));
    node.disabled = !!roleReason;
    if (roleReason) node.title = roleReason;
    roles.append(node);
  }
  const power = iconButton('power', item.enabled === false ? '启用' : '停用', () => {
    item.enabled = item.enabled === false;
    markPreset(); renderChain(); renderInspector();
  }, 'power' + (item.enabled === false ? '' : ' active'));
  power.setAttribute('aria-pressed', String(item.enabled !== false));
  actions.append(
    roles, power,
    iconButton('more', '更多操作', event => openMenu(event.currentTarget, chainMenu(index))),
  );
  row.append(main, actions);
  return row;
}
function changePromptRole(identifier, role) {
  const prompt = promptOf(identifier);
  if (roleReadOnlyReason(prompt) || !QUICK_ROLES.some(([value]) => value === role)) return;
  prompt.role = role;
  markPreset(); renderLibrary(); renderChain(); renderInspector();
}
/** Pointer sorting keeps the lifted row opaque and moves its gap immediately. */
function beginChainDrag(event, row, identifier) {
  if (event.button !== 0 || event.target.closest('button,input,label,a,select,textarea')) return;
  if (event.pointerType === 'touch' && !event.target.closest('.handle')) return;
  cancelChainDrag?.();
  const list = $('chain-list'), order = chainOrder(), original = [...order];
  const startY = event.clientY, startX = event.clientX;
  let pointerY = startY, pointerX = startX, lifted = false, gap, bounds, frame;
  const rows = () => [...list.children].filter(node => node.classList.contains('chain-row'));
  const update = () => {
    row.style.top = (bounds.top + pointerY - startY) + 'px';
    row.style.left = (bounds.left + pointerX - startX) + 'px';
    const siblings = rows();
    const before = siblings.find(node => pointerY < node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2);
    const to = before ? order.findIndex(item => item.identifier === before.dataset.id) : order.length;
    const from = order.findIndex(item => item.identifier === identifier);
    const target = to > from ? to - 1 : to;
    if (target === from) return;
    const positions = new Map(siblings.map(node => [node, node.getBoundingClientRect().top]));
    const [moved] = order.splice(from, 1); order.splice(target, 0, moved);
    list.insertBefore(gap, before ?? null);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of siblings) {
        const delta = positions.get(node) - node.getBoundingClientRect().top;
        if (delta) node.animate?.([{ transform: 'translateY(' + delta + 'px)' }, { transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' });
      }
    }
  };
  const scroll = () => {
    if (!lifted) return;
    const viewport = list.getBoundingClientRect();
    const direction = pointerY < viewport.top + 36 ? -1 : pointerY > viewport.bottom - 36 ? 1 : 0;
    if (direction) { list.scrollTop += direction * 9; update(); }
    frame = requestAnimationFrame(scroll);
  };
  const move = e => {
    if (e.pointerId !== event.pointerId) return;
    pointerY = e.clientY; pointerX = e.clientX;
    if (!lifted && Math.hypot(pointerY - startY, pointerX - startX) < 6) return;
    e.preventDefault();
    if (!lifted) {
      lifted = true; bounds = row.getBoundingClientRect();
      gap = el('div', 'chain-placeholder'); gap.style.height = bounds.height + 'px';
      list.insertBefore(gap, row); document.body.append(row);
      row.classList.add('dragging'); row.style.width = bounds.width + 'px'; row.style.height = bounds.height + 'px';
      row.setPointerCapture?.(event.pointerId);
      frame = requestAnimationFrame(scroll);
    }
    update();
  };
  const finish = (cancelled, rerender = true) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', key);
    cancelChainDrag = null;
    if (!lifted) return;
    cancelAnimationFrame(frame);
    if (cancelled) order.splice(0, order.length, ...original);
    else if (order.some((item, index) => item !== original[index])) markPreset();
    row.releasePointerCapture?.(event.pointerId);
    gap.replaceWith(row); row.classList.remove('dragging'); row.removeAttribute('style');
    // Suppress only the click generated by this drag release.
    const suppress = e => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('click', suppress, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', suppress, true), 0);
    if (rerender) renderChain();
  };
  const up = e => { if (e.pointerId === event.pointerId) finish(false); };
  const cancel = e => { if (e.pointerId === undefined || e.pointerId === event.pointerId) finish(true); };
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); finish(true); } };
  cancelChainDrag = () => finish(true, false);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', key);
}

function chainMenu(index) {
  const order = chainOrder(), item = order[index];
  const prompt = promptOf(item?.identifier);
  const copyReason = copyReadOnlyReason(prompt);
  const deleteReason = deleteReadOnlyReason(prompt);
  return [
    ['上移', () => moveChain(index, index - 1), { icon: 'up', disabled: index === 0, reason: '已在最前' }],
    ['下移', () => moveChain(index, index + 1), { icon: 'down', disabled: index === order.length - 1, reason: '已在最后' }],
    ['移到未使用', () => removeChainItem(index), { icon: 'unused' }],
    ['复制为模板', () => savePromptToLibrary(prompt), { icon: 'template', disabled: !!copyReason, reason: copyReason }],
    ['创建副本', () => copyChainItem(index), { icon: 'copy', disabled: !!copyReason, reason: copyReason }],
    ['删除', () => deleteChainPrompt(item?.identifier), { icon: 'delete', danger: true, disabled: !!deleteReason, reason: deleteReason }],
  ];
}
function deleteReadOnlyReason(prompt) {
  if (!prompt) return '提示词不存在';
  if (prompt.marker === true || prompt.identifier === 'chatHistory') return '占位符请移到未使用或停用';
  if (isBodyLocked(prompt, false)) return '请先解锁正文，再删除';
  return '';
}
function deleteChainPrompt(identifier) {
  const prompt = promptOf(identifier);
  const reason = deleteReadOnlyReason(prompt);
  if (reason) { status(reason, 'error'); return; }
  const groups = chainGroups().filter(group => group.order.some(item => item.identifier === identifier)).length;
  if (!confirm('删除「' + (prompt.name || identifier) + '」及其在 ' + groups + ' 个顺序组中的引用？提示词本体将删除。')) return;
  preset.prompts = preset.prompts.filter(item => item.identifier !== identifier);
  for (const group of chainGroups()) group.order = group.order.filter(item => item.identifier !== identifier);
  const settings = preset.extensions?.['dsh-preset-enhance'];
  if (settings?.templateBindings) delete settings.templateBindings[identifier];
  if (Array.isArray(settings?.autoTemplateDisabled)) settings.autoTemplateDisabled = settings.autoTemplateDisabled.filter(id => id !== identifier);
  if (selection && selection.kind !== 'library' && selection.id === identifier) selection = null;
  markPreset(); renderAll();
}
function moveChain(from, to) {
  const order = chainOrder();
  if (from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) return;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  markPreset();
  renderChain();
}
function copyChainItem(index) {
  const order = chainOrder();
  const source = promptOf(order[index]?.identifier);
  const reason = copyReadOnlyReason(source);
  if (reason) { status(reason, 'error'); return; }
  const identifier = uid();
  preset.prompts.push({ ...structuredClone(source), identifier, name: (source.name || identifier) + ' 副本' });
  order.splice(index + 1, 0, { identifier, enabled: order[index].enabled !== false });
  markPreset();
  selection = { kind: 'chain', id: identifier };
  renderAll();
}
function removeChainItem(index) {
  const order = chainOrder();
  const item = order[index];
  if (!item) return;
  if (!confirm('从顺序流程移除「' + (promptOf(item.identifier)?.name || item.identifier) + '」？（提示词本体保留在预设里）')) return;
  order.splice(index, 1);
  if (selection?.kind === 'chain' && selection.id === item.identifier) selection = { kind: 'prompt', id: item.identifier };
  segment = 'unused';
  markPreset();
  renderAll();
}
/** Insert a library template or an unused preset prompt. Only compiler-read fields are written. */
function insertIntoChain(row) {
  if (!preset) return;
  if (row.kind === 'prompt') {
    if (chainIdentifiers().has(row.id)) { status('该条目已在链路上'); return; }
    chainOrder().push({ identifier: row.id, enabled: true });
    selection = { kind: 'chain', id: row.id };
    markPreset();
    renderAll();
    status('已加入提示词链', 'dirty');
    return;
  }
  const entry = row.entry ?? row;
  const identifier = uid();
  const prompt = {
    identifier,
    name: entry.title || '模板条目',
    role: ROLE_NAME[entry.role] ? entry.role : 'system',
    content: entry.content || '',
    injection_position: entry.injectionPosition === 1 ? 1 : 0,
    injection_depth: numberOr(entry.injectionDepth, 4),
    injection_order: numberOr(entry.injectionOrder, 100),
  };
  if (Array.isArray(entry.injectionTrigger) && entry.injectionTrigger.length) prompt.injection_trigger = entry.injectionTrigger.slice();
  if (entry.hideFromList === true) prompt.hide_from_list = true;
  if (entry.forbidOverrides === true) prompt.forbid_overrides = true;
  preset.prompts.push(prompt);
  chainOrder().push({ identifier, enabled: true });
  selection = { kind: 'chain', id: identifier };
  markPreset();
  renderAll();
  status('模板已加入提示词链', 'dirty');
}
async function savePromptToLibrary(prompt) {
  const reason = copyReadOnlyReason(prompt);
  if (reason) { status(reason, 'error'); return; }
  const entry = {
    title: prompt.name || prompt.identifier || '未命名条目',
    role: prompt.role === 'model' ? 'assistant' : prompt.role || 'system',
    content: prompt.content || '',
    injectionPosition: prompt.injection_position === 1 ? 1 : 0,
  };
  if (prompt.injection_depth !== undefined) entry.injectionDepth = prompt.injection_depth;
  if (prompt.injection_order !== undefined) entry.injectionOrder = prompt.injection_order;
  if (Array.isArray(prompt.injection_trigger)) entry.injectionTrigger = prompt.injection_trigger.slice();
  if (prompt.hide_from_list !== undefined) entry.hideFromList = prompt.hide_from_list === true;
  if (prompt.forbid_overrides !== undefined) entry.forbidOverrides = prompt.forbid_overrides === true;
  await saveLibrary(entry, '已存入资源库');
}

/* --------------------------------------------------------------- inspector */

/** 计数：这条记录里有多少个本插件不读取的字段（用于顶部的诚实提示）。 */
function flaggedCount(source) {
  if (!source || typeof source !== 'object') return 0;
  return ST_ONLY_PROMPT_FIELDS.filter(key => source[key] !== undefined).length;
}

/** True when another prompt_order group enables this identifier (never shown as 已启用 here). */
function enabledInOtherGroups(identifier) {
  return chainGroups().some(group => String(group.character_id) !== groupId
    && (group.order ?? []).some(item => item.identifier === identifier && item.enabled !== false));
}

function inspectorTarget() {
  if (!selection) return null;
  if (selection.kind === 'library') {
    const entry = libraryEntries().find(item => item.id === selection.id);
    return entry ? { kind: 'library', entry } : null;
  }
  const item = chainOrder().find(entry => entry.identifier === selection.id);
  const prompt = promptOf(selection.id);
  return prompt ? { kind: 'chain', prompt, item } : null;
}
function promptToLibraryShape(prompt) {
  return {
    title: prompt.name || prompt.identifier || '未命名条目',
    role: prompt.role === 'model' ? 'assistant' : prompt.role || 'system',
    content: prompt.content || '',
    injectionPosition: prompt.injection_position === 1 ? 1 : 0,
    injectionDepth: prompt.injection_depth,
    injectionOrder: prompt.injection_order,
    injectionTrigger: Array.isArray(prompt.injection_trigger) ? prompt.injection_trigger : [],
    hideFromList: prompt.hide_from_list === true,
    forbidOverrides: prompt.forbid_overrides === true,
  };
}
function libraryToEntryShape(entry) {
  return {
    title: entry.title, role: entry.role, content: entry.content,
    injectionPosition: entry.injectionPosition === 1 ? 1 : 0,
    injectionDepth: entry.injectionDepth, injectionOrder: entry.injectionOrder,
    injectionTrigger: Array.isArray(entry.injectionTrigger) ? entry.injectionTrigger : [],
    hideFromList: entry.hideFromList === true,
    forbidOverrides: entry.forbidOverrides === true,
  };
}
function renderInspector() {
  const body = $('inspector-body');
  body.replaceChildren();
  const target = inspectorTarget();
  if (!target) {
    $('inspector-title').textContent = 'INSPECTOR';
    body.append(el('p', 'empty', '在资源库或提示词链里选择一个条目。'));
    return;
  }
  const isTemplate = target.kind === 'library';
  const source = isTemplate ? target.entry : target.prompt;
  const linked = !isTemplate && isLinkedTemplate(source.identifier);
  if (linked) body.append(el('p', 'honesty', '插件模板：正文与角色只读。可更新版本或转为本地副本。'));
  $('inspector-title').textContent = isTemplate ? 'INSPECTOR · 模板' : 'INSPECTOR · 条目';
  const stOnly = flaggedCount(source);
  if (stOnly > 0) {
    body.append(el('p', 'honesty', '本条目含 ' + stOnly + ' 项酒馆/SPreset 侧设置，本插件不会执行，仅原样保存。'));
  }

  const nameRow = el('div', 'name-row');
  const name = el('input');
  name.value = (isTemplate ? source.title : source.name) ?? '';
  name.placeholder = '条目名称';
  name.oninput = () => {
    if (isTemplate) { source.title = name.value; templateDirty = true; status('模板未保存', 'dirty'); }
    else { source.name = name.value; markPreset(); const row = $('chain-list').querySelector('[data-id="' + CSS.escape(selection.id) + '"] .name'); if (row) row.textContent = name.value; }
  };
  nameRow.append(name);
  // 已启用 is decided by the CURRENTLY selected order group alone; another group's state is named.
  if (!isTemplate) {
    if (target.item && target.item.enabled !== false) nameRow.append(el('span', 'badge', '已启用'));
    else if (enabledInOtherGroups(source.identifier)) nameRow.append(el('span', 'badge builtin', '已在其他顺序组启用'));
  }
  if (isTemplate) nameRow.append(el('span', 'badge builtin', '模板'));
  if (!isTemplate && source.marker === true) nameRow.append(el('span', 'badge marker', '占位符'));
  if (!isTemplate && BUILTIN_IDS.has(source.identifier)) nameRow.append(el('span', 'badge builtin', '内置'));
  body.append(field('条目名称', nameRow));

  const idRow = el('div', 'id-row');
  const idCode = el('code', '', isTemplate ? source.id : source.identifier);
  idRow.append(idCode, button('复制', '复制 ID', () => copyText(String(idCode.textContent))));
  body.append(field('条目 ID', idRow));

  const role = el('select');
  for (const [value, label] of ROLES) {
    const option = el('option', '', label);
    option.value = value;
    role.append(option);
  }
  role.value = ROLE_NAME[source.role] ? source.role : 'system';
  role.onchange = () => {
    if (!isTemplate && roleReadOnlyReason(source)) return;
    if (isTemplate) { source.role = role.value; templateDirty = true; status('模板未保存', 'dirty'); }
    else { source.role = role.value; markPreset(); renderLibrary(); renderChain(); }
  };
  body.append(field('角色', role));
  role.disabled = !isTemplate && !!roleReadOnlyReason(source);
  if (role.disabled) role.title = roleReadOnlyReason(source);

  const position = isTemplate ? (source.injectionPosition === 1 ? 1 : 0) : (source.injection_position === 1 ? 1 : 0);
  const segmentRow = el('div', 'segment');
  for (const [label, value] of [['顺序', 0], ['注入', 1]]) {
    const node = button(label, '', () => {
      if (isTemplate) { source.injectionPosition = value; templateDirty = true; status('模板未保存', 'dirty'); }
      else { source.injection_position = value; markPreset(); }
      renderInspector();
      renderChain();
    });
    if (value === position) node.classList.add('active');
    segmentRow.append(node);
  }
  body.append(field('条目类型 · 决定条目如何进入最终上下文', segmentRow));

  // 根据条件自动启用 = prompt.spreset_condition_script（一段函数表达式）。本插件没有脚本运行时。
  const conditionScript = typeof source.spreset_condition_script === 'string' ? source.spreset_condition_script : '';
  const conditional = el('input');
  conditional.type = 'checkbox';
  conditional.checked = conditionScript.length > 0;
  conditional.onchange = () => {
    if (conditional.checked) source.spreset_condition_script = DEFAULT_CONDITION_SCRIPT;
    else delete source.spreset_condition_script;
    if (isTemplate) { templateDirty = true; status('模板未保存', 'dirty'); }
    else markPreset();
    renderInspector();
  };
  // 在酒馆原生列表中隐藏：参考编辑器的字段，本插件不读取，但仍可编辑并原样保存。
  // 锁定正文（forbid_overrides）：编辑器侧的防误编辑开关，见 setLock。
  const hidden = el('input');
  hidden.type = 'checkbox';
  hidden.checked = isTemplate ? source.hideFromList === true : source.hide_from_list === true;
  hidden.onchange = () => {
    if (isTemplate) { source.hideFromList = hidden.checked; templateDirty = true; status('模板未保存', 'dirty'); }
    else { source.hide_from_list = hidden.checked; markPreset(); renderInspector(); }
  };
  const bodyLocked = isBodyLocked(source, isTemplate);
  const locked = el('input');
  locked.type = 'checkbox';
  locked.checked = bodyLocked;
  locked.onchange = () => { void setLock(source, isTemplate, locked.checked); };
  for (const [label, control, hint] of [
    ['根据条件自动启用', conditional, 'spreset_condition_script：酒馆/SPreset 侧按条目求值的函数表达式，本插件不执行，仅原样保存'],
    ['在酒馆原生列表中隐藏', hidden, ST_ONLY_SHORT],
    ['锁定正文', locked, bodyLocked
      ? '已锁定，防止误编辑；解锁后可编辑'
      : '开启后本条正文在本编辑器里只读（防止误编辑）'],
  ]) {
    const row = el('label', 'toggle-row');
    row.append(el('span', '', label), control);
    body.append(row);
    if (hint) body.append(el('p', 'hint', hint));
  }

  if (typeof source.spreset_condition_script === 'string' && source.spreset_condition_script.length) {
    const area = el('textarea');
    area.rows = 3;
    area.spellcheck = false;
    area.value = source.spreset_condition_script;
    area.oninput = () => {
      source.spreset_condition_script = area.value;
      if (isTemplate) { templateDirty = true; status('模板未保存', 'dirty'); }
      else markPreset();
    };
    body.append(field('spreset_condition_script', area));
  }

  const counter = el('div', 'counter');
  const textarea = el('textarea');
  const templateRef = !isTemplate ? globalThis.PresetPluginTemplates?.bindings(preset)?.[source.identifier] : null;
  const displayContent = () => templateRef?.target === 'marker' ? templateRef.contentSnapshot ?? '' : source.content ?? '';
  textarea.value = displayContent();
  textarea.spellcheck = false;
  const marker = !isTemplate && source.marker === true;
  // 锁定正文：编辑器侧防误编辑。锁定后正文只读，粘贴/输入/程序化写入都不生效。
  textarea.disabled = marker || bodyLocked || linked;
  const refreshCounter = () => {
    const value = textarea.value;
    counter.textContent = fmtCount(value.length) + ' 字符 · ' + fmtCount(value ? value.split('\n').length : 0) + ' 行';
  };
  textarea.oninput = () => {
    if (linked) { textarea.value = displayContent(); return; }
    if (isTemplate) { source.content = textarea.value; templateDirty = true; status('模板未保存', 'dirty'); }
    else { source.content = textarea.value; markPreset(); renderChainRowInPlace(selection.id); }
    refreshCounter();
  };
  if (bodyLocked) {
    // Belt and braces: the field is disabled, and any write that still reaches here is reverted.
    textarea.oninput = () => {
      textarea.value = source.content ?? '';
      refreshCounter();
      status('本条正文已锁定，先解锁再编辑', 'error');
    };
  }
  refreshCounter();
  const contentField = field('提示词正文', textarea);
  if (marker) contentField.append(el('span', 'muted', '占位符条目的正文由酒馆按标记填充，这里不可编辑。'));
  if (bodyLocked) {
    const lockRow = el('div', 'lock-row');
    lockRow.append(
      el('span', 'hint', '已锁定，防止误编辑；解锁后可编辑'),
      button('解锁', '解除本条正文的编辑锁', () => { void setLock(source, isTemplate, false); }, 'primary'),
    );
    contentField.append(lockRow);
  }

  const tabRow = el('div', 'tabs2');
  for (const tab of TABS) {
    const node = button(tab, '', () => { inspectorTab = tab; renderInspector(); });
    if (tab === inspectorTab) node.classList.add('active');
    tabRow.append(node);
  }
  body.append(tabRow);
  if (inspectorTab === '内容') body.append(contentField, counter);
  else if (inspectorTab === '注入') body.append(isTemplate ? templateInjectionTab(target.entry) : injectionTab(source));
  else if (inspectorTab === '工具') body.append(readOnlyBlock('工具与消息注入（extensions.SPreset.ToolBindings / MessageInjections）',
    { ToolBindings: preset?.extensions?.SPreset?.ToolBindings ?? null, MessageInjections: preset?.extensions?.SPreset?.MessageInjections ?? null }));
  else body.append(structuredTab(target, isTemplate, source));

  if (isTemplate) {
    const actions = el('div', 'card-actions');
    actions.append(
      button('保存模板', '写入资源库（与预设无关）', () => saveLibrary(libraryToEntryShape(source)), 'primary'),
      button('删除模板', '从资源库删除', () => removeLibraryEntry(source.id)),
    );
    body.append(actions);
  }
}
function renderChainRowInPlace(identifier) {
  const prompt = promptOf(identifier);
  const row = $('chain-list').querySelector('[data-id="' + CSS.escape(String(identifier)) + '"]');
  if (!row || !prompt) return;
  row.querySelector('.name').textContent = prompt.name || identifier;
  row.querySelector('.preview').textContent = short(prompt.content, 90) || '（空内容）';
}
function numberField(labelText, value, fallback, onCommit) {
  const input = el('input');
  input.type = 'number';
  input.value = String(value ?? fallback);
  input.onchange = () => { onCommit(numberOr(input.value, fallback)); };
  return field(labelText, input);
}
function injectionTab(prompt) {
  const wrap = el('div', 'field');
  wrap.append(el('p', 'muted', 'injection_position = 1 时按 injection_depth / injection_order 注入；0 表示按顺序表进入上下文。'));
  wrap.append(
    numberField('injection_depth（深度）', prompt.injection_depth, 4, value => { prompt.injection_depth = value; markPreset(); }),
    numberField('injection_order（同深度顺序）', prompt.injection_order, 100, value => { prompt.injection_order = value; markPreset(); }),
  );
  const trigger = el('input');
  trigger.value = (prompt.injection_trigger ?? []).join(',');
  trigger.placeholder = TRIGGERS.join(',');
  trigger.onchange = () => {
    const values = trigger.value.split(',').map(value => value.trim()).filter(Boolean);
    if (values.length) prompt.injection_trigger = values; else delete prompt.injection_trigger;
    markPreset();
  };
  wrap.append(field('injection_trigger（逗号分隔，只有 normal 会命中）', trigger));
  return wrap;
}
function templateInjectionTab(entry) {
  const wrap = el('div', 'field');
  wrap.append(el('p', 'muted', '这些值会在模板加入提示词链时写进新条目。'));
  wrap.append(
    numberField('injection_depth（深度）', entry.injectionDepth, 4, value => { entry.injectionDepth = value; templateDirty = true; status('模板未保存', 'dirty'); }),
    numberField('injection_order（同深度顺序）', entry.injectionOrder, 100, value => { entry.injectionOrder = value; templateDirty = true; status('模板未保存', 'dirty'); }),
  );
  const trigger = el('input');
  trigger.value = (entry.injectionTrigger ?? []).join(',');
  trigger.placeholder = TRIGGERS.join(',');
  trigger.onchange = () => {
    const values = trigger.value.split(',').map(value => value.trim()).filter(Boolean);
    entry.injectionTrigger = values;
    templateDirty = true;
    status('模板未保存', 'dirty');
  };
  wrap.append(field('injection_trigger（逗号分隔）', trigger));
  return wrap;
}
function readOnlyBlock(title, value) {
  const wrap = el('div', 'field');
  wrap.append(el('span', '', title));
  wrap.append(el('p', 'muted', NOT_IMPLEMENTED));
  wrap.append(el('pre', 'json', JSON.stringify(value, null, 2)));
  return wrap;
}
function structuredTab(target, isTemplate, source) {
  const wrap = el('div', 'field');
  wrap.append(el('p', 'muted', '原始字段：保存时原样写回，未在本插件中实现的字段（例如 hide_from_list）不会被改写。锁定正文是编辑器侧的防误编辑开关，不影响发送内容。'));
  wrap.append(el('pre', 'json', JSON.stringify(isTemplate ? source : promptToLibraryShape(source), null, 2)));
  return wrap;
}

/* ----------------------------------------------------------------- extras */

let regexEditor = null;
function renderExtras() {
  regexEditor ??= globalThis.PresetRegexEditor?.mount($('extras-body'), { getPreset: () => preset, onChange: markPreset });
  regexEditor?.render();
}
/* ---------------------------------------------------------------- helpers */

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => status('已复制'), () => status('复制失败', 'error'));
}
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function closeMenu(restoreFocus = true) {
  const layer = $('menu-layer');
  layer.hidden = true;
  layer.replaceChildren();
  if (restoreFocus && menuAnchor?.isConnected !== false) menuAnchor?.focus?.();
  menuAnchor = null;
}
function openMenu(anchor, items) {
  closeMenu(false);
  menuAnchor = anchor;
  const layer = $('menu-layer');
  layer.hidden = false;
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const [label, run, options = {}] of items) {
    const node = button('', options.disabled ? options.reason : '', guard(async () => {
      if (options.disabled) return;
      closeMenu();
      await run();
    }), options.danger ? 'danger' : '');
    if (options.icon) node.append(actionIcon(options.icon));
    node.append(el('span', '', label));
    node.setAttribute('role', 'menuitem');
    node.disabled = options.disabled === true;
    menu.append(node);
  }
  layer.append(menu);
  const rect = anchor.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
  const width = window.innerWidth ?? 1024, height = window.innerHeight ?? 768;
  menu.style.maxHeight = Math.max(80, height - 16) + 'px';
  menu.style.left = Math.max(8, Math.min(rect.right - bounds.width, width - bounds.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, height - bounds.height - 8)) + 'px';
  const buttons = [...menu.querySelectorAll('button')].filter(node => !node.disabled);
  buttons[0]?.focus?.();
  layer.onclick = () => closeMenu();
  layer.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key) || !buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus?.();
  };
}

/* ---------------------------------------------------------------- actions */

function savePreset() {
  clearTimeout(autoSaveTimer);
  saveChain = saveChain.catch(() => {}).then(performSavePreset);
  return saveChain;
}
async function performSavePreset() {
  if (!preset) return;
  // mirrorSPreset makes the server project extensions.SPreset into the SPresetSettings prompt
  // (the reference editor's "已与酒馆同步"); extensions.SPreset stays the source of truth.
  const version = draftVersion, savedId = presetId, savedName = presetName, snapshot = structuredClone(preset);
  const result = await api({ action: 'save', id: savedId, name: savedName, preset: snapshot, mirrorSPreset: true });
  state.revision = Number.isInteger(result.revision) ? result.revision : state.revision + 1;
  if (result.id) {
    presetId = result.id;
    const record = (state.presets ?? []).find(item => item.id === result.id);
    if (record) { record.preset = snapshot; record.name = savedName; }
    const unsaved = (state.presets ?? []).find(item => !item.id);
    if (unsaved) unsaved.preset = structuredClone(preset);
  }
  renderPresetSelect();
  if (version === draftVersion) markSaved('已保存');
  else scheduleEditorSave();
}
async function saveLibrary(entry, done) {
  const result = await api({ action: 'library-save', entry });
  state.revision = Number.isInteger(result.revision) ? result.revision : state.revision + 1;
  library = { entries: result.entries ?? library.entries };
  if (selection && selection.kind === 'library') selection = { kind: 'library', id: result.entry.id };
  templateDirty = false;
  renderAll();
  status(done || '模板已保存');
}
async function removeLibraryEntry(id) {
  const entry = libraryEntries().find(item => item.id === id);
  if (!entry) return;
  if (!confirm('删除模板「' + entry.title + '」？')) return;
  const result = await api({ action: 'library-delete', id });
  state.revision = Number.isInteger(result.revision) ? result.revision : state.revision + 1;
  library = { entries: result.entries ?? [] };
  if (selection && selection.kind === 'library' && selection.id === id) selection = null;
  renderAll();
  status('模板已删除');
}

/* ----------------------------------------------------------------- render */

function renderAll() {
  pluginTemplatePanel?.render();
  renderLibrary();
  renderChain();
  renderInspector();
  if (!$('extras-view').hidden) renderExtras();
}

/* ------------------------------------------------------------------- init */

$('back-workbench').href = '/preset-enhance' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '');
$('save-preset').onclick = guard(savePreset);
try { $('regex-auto-save').checked = localStorage.getItem('dsh-preset-enhance.preset-auto-save') !== '0'; } catch {}
$('regex-auto-save').onchange = () => { try { localStorage.setItem('dsh-preset-enhance.preset-auto-save', $('regex-auto-save').checked ? '1' : '0'); } catch {} scheduleEditorSave(); };
globalThis.addEventListener?.('storage', event => {
  if (event.key !== 'dsh-preset-enhance.preset-auto-save') return;
  $('regex-auto-save').checked = event.newValue !== '0';
  scheduleEditorSave();
});
$('preset-select').onchange = guard(async () => {
  await saveChain.catch(() => {});
  if (presetDirty && !confirm('放弃尚未保存的预设修改？')) { $('preset-select').value = presetId; return; }
  loadPreset($('preset-select').value);
  status('已保存');
});
$('chain-group').onchange = () => { groupId = $('chain-group').value; selection = null; renderAll(); };
$('library-search').oninput = () => { search = $('library-search').value.trim(); renderLibrary(); };
$('library-role').onchange = () => { roleFilter = $('library-role').value; renderLibrary(); };
$('seg-unused').onclick = () => { segment = 'unused'; renderLibrary(); };
$('seg-templates').onclick = () => { segment = 'templates'; renderLibrary(); };
$('library-add').onclick = guard(async () => {
  segment = 'templates';
  await saveLibrary({ title: '新模板 ' + (libraryEntries().length + 1), role: 'system', content: '' }, '已新建模板');
});
$('chain-add').onclick = () => {
  const identifier = uid();
  preset.prompts.push({ identifier, name: '新条目', role: 'system', content: '', injection_position: 0, injection_depth: 4, injection_order: 100 });
  chainOrder().push({ identifier, enabled: true });
  selection = { kind: 'chain', id: identifier };
  markPreset();
  renderAll();
};
$('tab-prompt').onclick = () => {
  $('tab-prompt').setAttribute('aria-selected', 'true');
  $('tab-extras').setAttribute('aria-selected', 'false');
  $('tab-prompt').classList.add('active');
  $('tab-extras').classList.remove('active');
  $('prompt-view').hidden = false;
  $('extras-view').hidden = true;
};
$('tab-extras').onclick = guard(async () => {
  $('tab-extras').setAttribute('aria-selected', 'true');
  $('tab-prompt').setAttribute('aria-selected', 'false');
  $('tab-extras').classList.add('active');
  $('tab-prompt').classList.remove('active');
  $('prompt-view').hidden = true;
  $('extras-view').hidden = false;
  renderExtras();
});

window.addEventListener('beforeunload', event => {
  if (presetDirty || templateDirty) { event.preventDefault(); event.returnValue = ''; }
});

async function boot() {
  try {
    state = await api();
    library = state.sPresetLibrary ?? { entries: [] };
    editorLocks = state.sPresetEditor ?? { locks: {} };
    renderPresetSelect();
    const binding = state.binding ?? {};
    const initial = (state.presets ?? []).find(record => record.id === (binding.presetId || state.selectedPresetId))
      ?? (state.presets ?? [])[0];
    if (!initial) { status('没有可用预设', 'error'); renderAll(); return; }
    loadPreset(initial.id);
    markSaved('已保存');
  } catch (error) {
    status('加载失败：' + error.message, 'error');
  }
}
pluginTemplatePanel = globalThis.PresetPluginTemplates?.mount($('plugin-template-panel'), {
  api, getPreset: () => preset, getPresetId: () => presetId, getCharacterId: () => groupId,
  getOrder: chainOrder, isLocked: id => lockedIds().has(id),
  onSelect: id => { selection = { kind: 'chain', id }; renderAll(); },
  onChange: (draft, id) => { preset = draft; selection = { kind: 'chain', id }; markPreset(); renderAll(); },
});
boot();
