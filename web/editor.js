const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId') ?? '';
let state = { presets: [], revision: 0 }, selectedId = '', selectedPrompt = '', dirty = false;
let preset = blank();

function blank() {
  return {
    prompts: [{ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
  };
}
function status(text, error = false) {
  // 无关的保存/刷新不再丢弃未保存的工具草稿，因此成功提示需要附带待保存提醒。
  const pending = [];
  if (toolDraft.dirty) pending.push('工具开关尚未保存');
  if (groupsDirty) pending.push('工具分组尚未保存');
  const suffix = !error && pending.length && !text.includes('尚未保存') ? ` · ${pending.join('；')}` : '';
  $('status').textContent = `${text}${suffix}`;
  $('status').className = error ? 'error' : '';
}
function updateDefaultButton() {
  const active = !!selectedId && selectedId === state.selectedPresetId;
  $('mode-default').textContent = active ? '当前默认 ✓' : '设为当前默认';
  $('mode-default').disabled = !selectedId || dirty || active;
  $('delete-preset').disabled = !selectedId || dirty;
}
function modeName(id) {
  return state.agentModes?.find(mode => mode.id === id)?.name ?? (id || '未选择');
}
function updateSessionNote() {
  const chosen = state.modeDefaultName ? `“${state.modeDefaultName}”` : '尚未设置';
  if (!sessionId) $('session-note').textContent = `侧边栏工作台 · 新会话自动注入使用：${chosen}`;
  else $('session-note').textContent = `当前会话模式：${modeName(state.sessionMode)} · 预设注入可用 /preset 随时切换`;
}
function markDirty() {
  dirty = true;
  status('草稿未保存');
  updateDefaultButton();
}
async function api(body, options = {}) {
  const res = await fetch(`/preset-enhance/api?sessionId=${encodeURIComponent(sessionId)}`, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, ...body }),
    ...(options.keepalive === true ? { keepalive: true } : {}),
  } : {});
  const result = await res.json();
  if (!res.ok) {
    const error = new Error(result.error ?? '请求失败');
    error.status = res.status;
    throw error;
  }
  return result;
}
function guard(fn) {
  return async () => {
    try { await fn(); } catch (error) { status(error.message, true); }
  };
}
function order() {
  return preset.prompt_order.find(group => String(group.character_id) === $('order').value)?.order ?? [];
}
function current() {
  return preset.prompts.find(prompt => prompt.identifier === selectedPrompt);
}
function options() {
  return {
    characterId: $('order').value,
    values: { user: $('user').value, char: $('char').value },
    markers: JSON.parse($('markers').value),
  };
}
function ensureGroups() {
  if (!preset.prompt_order?.length) {
    preset.prompt_order = [{
      character_id: 100001,
      order: preset.prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false })),
    }];
  }
}
function loadDraft(id) {
  selectedId = id;
  const record = state.presets.find(item => item.id === id);
  preset = structuredClone(record?.preset ?? blank());
  const packaged = record?.sharePackage;
  $('apply-package-prefill').hidden = !packaged?.prefill;
  $('package-note').textContent = packaged
    ? '此预设附带分享数据。导入不会改动全局接口设置；可点击应用包内设置。保存接口设置会同时更新当前已保存预设的分享数据。包内工具预设与分组需在“工具预设”卡片中显式导入。'
    : '分享文件为单个 .dsh-preset.json，包含预设与已保存接口设置，并预留工具预设和分组。';
  ensureGroups();
  $('name').value = record?.name ?? '新预设';
  $('library').value = id;
  $('order').replaceChildren(...preset.prompt_order.map(group => new Option(String(group.character_id), String(group.character_id))));
  const binding = state.binding ?? {};
  $('order').value = String(binding.presetId === id && binding.characterId != null ? binding.characterId :
    preset.prompt_order.find(group => String(group.character_id) === '100001')?.character_id ?? preset.prompt_order[0].character_id);
  $('prefill').value = preset.assistant_prefill ?? '';
  selectedPrompt = order()[0]?.identifier ?? preset.prompts[0]?.identifier ?? '';
  dirty = false;
  renderList();
  renderEditor();
  updateDefaultButton();
  renderPackageTools(record);
  void refreshPrefillWarning();
}
async function reload(id) {
  const previousToolMode = $('tool-mode').value;
  state = await api();
  $('library').replaceChildren(new Option('新预设', ''), ...state.presets.map(item =>
    new Option(`${item.id === state.selectedPresetId ? '★ ' : ''}${item.name}`, item.id)));
  const binding = state.binding ?? {};
  $('enabled').checked = binding.enabled === true;
  $('user').value = binding.values?.user ?? 'User';
  $('char').value = binding.values?.char ?? 'Assistant';
  $('markers').value = JSON.stringify(binding.markers ?? {}, null, 2);
  $('deepseek-beta-prefix').checked = state.deepseekBetaPrefix === true;
  $('prefix-tool-calls').checked = state.prefixToolCalls === true;
  $('prefix-nonofficial-remove-tools').checked = state.prefixNonOfficialRemoveTools !== false;
  $('post-tool-prefix-mode').value = state.postToolPrefixMode ?? 'inherit';
  $('post-tool-prefix-text').value = state.postToolPrefixText ?? '';
  syncPrefixToolControls();
  renderAutoModes();
  syncDraftsWithState();
  renderToolModes(previousToolMode);
  loadDraft(id ?? state.selectedPresetId ?? binding.presetId ?? '');
  updateSessionNote();
  status('已加载');
}

function syncPrefixToolControls() {
  $('post-tool-prefix-field').hidden = $('post-tool-prefix-mode').value !== 'custom';
  $('prefix-nonofficial-remove-tools').disabled = $('prefix-tool-calls').checked;
}

async function refreshPrefillWarning() {
  const recordId = selectedId;
  try {
    const result = await api({ action: 'preview', sessionId, preset, input: '预填充检测', options: options() });
    if (recordId !== selectedId) return;
    const active = result.assistantPrefix?.active === true;
    $('prefill-warning').hidden = !active;
    if (!active) return;
    if (state.deepseekBetaPrefix === true) {
      const tools = state.prefixToolCalls ?
        '工具调用会通过 DSML 转换并恢复为标准 tool_calls。' :
        state.prefixNonOfficialRemoveTools !== false ?
          '官方与非官方接口都会移除原生工具字段。' :
          '官方 Beta 会移除原生工具字段，非官方接口会将其原样发送。';
      $('prefill-warning-text').textContent =
        '此预设的最终注入消息是 assistant，属于预填充续写。官方地址会切换到 Beta，非官方适配器地址保持不变。' + tools;
    } else {
      $('prefill-warning-text').textContent =
        '此预设的最终注入消息是 assistant，属于预填充续写。请使用支持 assistant prefix 的接口，或在下方开启预填充自动兼容。';
    }
  } catch {
    if (recordId === selectedId) $('prefill-warning').hidden = true;
  }
}

function renderAutoModes() {
  $('auto-mode-list').replaceChildren();
  for (const mode of state.agentModes ?? []) {
    const label = document.createElement('label');
    label.className = `check-entry ${mode.id === 'st-preset' ? 'locked' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.mode = mode.id;
    input.checked = mode.id === 'st-preset' || state.autoEnableModes?.includes(mode.id);
    input.disabled = mode.id === 'st-preset' || !!mode.broken;
    const text = document.createElement('span');
    text.textContent = mode.name;
    const small = document.createElement('small');
    small.textContent = mode.broken ? `不可用：${mode.broken}` : mode.id === 'st-preset' ? '专用模式，始终自动注入' : mode.id;
    text.append(small);
    label.append(input, text);
    $('auto-mode-list').append(label);
  }
}
/* ---------- 工具预设、分组标签与草稿模型 ---------- */
const TOOL_TABS_COLLAPSED_KEY = 'dsh-preset-enhance.tool-tabs-collapsed';
const TOOL_CONTENT_OPEN_KEY = 'dsh-preset-enhance.tool-group-content-open';
const TOOL_LAST_MODE_KEY = 'dsh-preset-enhance.tool-last-mode';
const TOOL_AUTO_SAVE_KEY = 'dsh-preset-enhance.tool-auto-save';
const TOOL_AUTO_SAVE_DELAY = 400;
const TOOL_PRESET_PREFIX = 'preset:';
const toolActiveGroupKey = modeId => `dsh-preset-enhance.tool-active-group:${modeId}`;
const compactToolTabs = window.matchMedia?.('(max-width:760px)') ?? { matches: false, addEventListener() {} };

let toolDraft = { key: '', policy: {}, dirty: false };
let toolDraftVersion = 0;
let autoSaveTimer = null;
let autoSaveChain = Promise.resolve();
let autoSaveInFlight = false;
let autoSaveInFlightVersion = -1;
let keepaliveFlushedVersion = -1;
let groupDraft = [];
let groupsDirty = false;
let groupPageOpen = false;
let toolView = { sessionScope: false, modeId: '', tabs: [], active: '@all' };
let packageToolsRecordId = '';
const groupEditorModes = new Map();

function storageGet(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式下写入失败时保持内存状态 */ }
}
function toolCatalog(modeId) {
  return state.toolCatalogs?.[modeId] ?? [];
}
function findToolPreset(id) {
  return (state.toolPresets ?? []).find(item => item.id === id) ?? null;
}
function toolSelection(scope, modeId) {
  return scope === 'session' ? state.sessionToolSelection ?? null : state.modeToolSelections?.[modeId] ?? null;
}
function toolSelectionKind(scope, modeId) {
  const kind = toolSelection(scope, modeId)?.kind;
  if (kind === 'inherit' || kind === 'custom' || kind === 'preset') return kind;
  return scope === 'session' ? state.sessionToolPolicy ? 'custom' : 'inherit' : 'custom';
}
function normalizeToolPolicy(raw, modeId) {
  const policy = {};
  for (const tool of toolCatalog(modeId)) policy[tool.name] = raw?.[tool.name] !== false;
  return policy;
}
function expandToolPreset(preset, modeId) {
  const policy = {};
  for (const tool of toolCatalog(modeId)) policy[tool.name] = preset.defaultEnabled !== false;
  for (const rule of preset.rules ?? []) {
    if (rule.modeId === modeId) policy[rule.toolName] = rule.enabled !== false;
  }
  return policy;
}
function modeToolPolicy(modeId) {
  const selection = toolSelection('mode', modeId);
  const preset = selection?.kind === 'preset' ? findToolPreset(selection.presetId) : null;
  return preset ? normalizeToolPolicy(expandToolPreset(preset, modeId), modeId) :
    normalizeToolPolicy(state.modeToolPolicies?.[modeId] ?? {}, modeId);
}
function sessionToolPolicy(modeId) {
  const kind = toolSelectionKind('session', modeId);
  if (kind === 'preset') {
    const preset = findToolPreset(toolSelection('session', modeId)?.presetId);
    if (preset) return normalizeToolPolicy(expandToolPreset(preset, modeId), modeId);
    return modeToolPolicy(modeId);
  }
  if (kind === 'custom') {
    // GET 在没有保存会话策略时返回 null：服务端把 null 解析为模式结果，显式 {} 才是全部启用。
    return state.sessionToolPolicy == null
      ? modeToolPolicy(modeId)
      : normalizeToolPolicy(state.sessionToolPolicy, modeId);
  }
  return modeToolPolicy(modeId);
}
function effectiveToolPolicy(modeId, sessionScope) {
  return sessionScope ? sessionToolPolicy(modeId) : modeToolPolicy(modeId);
}
function toolContext() {
  const sessionScope = $('tool-scope').value === 'session';
  const modeId = sessionScope ? (state.sessionMode ?? $('tool-mode').value) : $('tool-mode').value;
  return { sessionScope, modeId };
}
function loadToolDraft(force) {
  const { sessionScope, modeId } = toolContext();
  const key = `${sessionScope ? 'session' : 'mode'}:${modeId}`;
  if (force && toolDraft.dirty && toolDraft.key === key) {
    // 保留尚未保存的草稿：无关的 reload()（保存预设、保存接口设置等）不得丢弃用户的开关改动。
  } else if (force || toolDraft.key !== key) {
    toolDraft = { key, policy: effectiveToolPolicy(modeId, sessionScope), dirty: false };
  }
  toolView.sessionScope = sessionScope;
  toolView.modeId = modeId;
}
function resetToolDraft() {
  toolDraft = { key: '', policy: {}, dirty: false };
}
function resetGroupDraft() {
  groupDraft = structuredClone(state.toolGroups ?? []);
  groupsDirty = false;
  groupEditorModes.clear();
}
function syncDraftsWithState() {
  // reload() 之后刷新基线，但保留仍然脏的草稿，避免静默丢弃。
  if (!toolDraft.dirty) resetToolDraft();
  if (!groupsDirty) resetGroupDraft();
}
function markToolDirty() {
  toolDraft.dirty = true;
  toolDraftVersion++;
  status('工具开关草稿尚未保存');
  scheduleAutoSave();
}
function markGroupsDirty() {
  groupsDirty = true;
  status('工具分组草稿尚未保存');
}
function presetDiscardOkay() {
  return !dirty || confirm('放弃尚未保存的预设草稿？');
}
function toolDiscardOkay() {
  if (!toolDraft.dirty) return true;
  if (!confirm('放弃尚未保存的工具开关草稿？')) return false;
  resetToolDraft();
  return true;
}
function groupDiscardOkay() {
  if (!groupsDirty) return true;
  if (!confirm('放弃尚未保存的工具分组草稿？')) return false;
  resetGroupDraft();
  return true;
}

/* ---------- 工具开关自动保存（可关闭；关闭时行为与手工保存完全一致） ---------- */
function autoSaveIsOn() {
  return $('tool-auto-save').checked === true;
}
function autoSaveNote() {
  return autoSaveIsOn()
    ? '自动保存已开启：工具开关改动即时生效；分组名称、排序和成员结构改动仍需“保存分组”。'
    : '自动保存未开启：工具开关改动需点击“保存工具开关”。';
}
function cancelAutoSave() {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}
function scheduleAutoSave() {
  if (!autoSaveIsOn()) return;
  cancelAutoSave();
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void runAutoSave();
  }, TOOL_AUTO_SAVE_DELAY);
}
function isRevisionConflict(error) {
  return error?.status === 409 || /预设已被其他窗口更新/.test(String(error?.message ?? ''));
}
function toolSaveRequest(scope, modeId, policy) {
  return scope === 'session'
    ? { action: 'save-session-tools', sessionId, policy }
    : { action: 'save-mode-tools', modeId, policy };
}
async function persistToolDraft() {
  if (!toolDraft.dirty) return { ok: true, skipped: true };
  const scope = toolView.sessionScope ? 'session' : 'mode';
  const modeId = toolView.modeId;
  if (!modeId) return { ok: false, error: new Error('当前没有可保存的 DSH 模式') };
  if (scope === 'session' && !sessionId) return { ok: false, error: new Error('当前页面没有会话，无法自动保存') };
  const key = toolDraft.key;
  const version = toolDraftVersion;
  const policy = { ...toolDraft.policy };
  const send = () => api(toolSaveRequest(scope, modeId, policy));
  try {
    await send();
  } catch (error) {
    if (!isRevisionConflict(error)) return { ok: false, error };
    try {
      await reload(selectedId);            // 刷新 revision，reload 会保留脏草稿
      await send();                        // 用新 revision 重试一次
    } catch (retryError) {
      return { ok: false, error: retryError };
    }
  }
  if (toolDraft.key === key) {
    if (toolDraftVersion === version) {
      // 以刚保存的策略作为新基线：不能清空，否则下一次改动会提交不完整的策略。
      toolDraft = { key, policy: { ...policy }, dirty: false };
    } else {
      scheduleAutoSave();                    // 保存在途时又有新改动，稍后再存一次
    }
  }
  // 每次成功事务服务端只 +1；冲突时上面的 reload() 会重新同步 revision。
  state.revision += 1;
  return { ok: true, scope, modeId };
}
function runAutoSave() {
  autoSaveChain = autoSaveChain.then(async () => {
    autoSaveInFlight = true;
    autoSaveInFlightVersion = toolDraftVersion;
    let result;
    try {
      result = await persistToolDraft();
    } finally {
      autoSaveInFlight = false;
    }
    if (result.ok) {
      if (!result.skipped) {
        status(`已自动保存（${result.scope === 'session' ? '当前会话覆盖' : '模式默认'} · ${modeName(result.modeId)}）`);
      }
    } else {
      status(`自动保存失败：${result.error.message}（改动尚未保存，仍保留在草稿中，可继续编辑或点击“保存工具开关”）`, true);
    }
    return result;
  }).catch(error => {
    autoSaveInFlight = false;
    status(`自动保存失败：${error.message}（改动尚未保存，仍保留在草稿中）`, true);
  });
  return autoSaveChain;
}
// 页面卸载/隐藏时的尽力而为冲刷：同一个 payload 构造函数，keepalive 让浏览器在卸载期间完成请求。
// 卸载期间无法观察结果，因此草稿保持为脏，也不从卸载处理函数里弹错；同一批改动最多发送一次。
function flushToolDraftKeepalive() {
  if (!autoSaveIsOn() || !toolDraft.dirty) return 0;
  cancelAutoSave();                        // 先取消排队定时器，保证不会双发
  if (autoSaveInFlight && autoSaveInFlightVersion === toolDraftVersion) return 0;
  if (keepaliveFlushedVersion === toolDraftVersion) return 0;
  const scope = toolView.sessionScope ? 'session' : 'mode';
  const modeId = toolView.modeId;
  if (!modeId || (scope === 'session' && !sessionId)) return 0;
  keepaliveFlushedVersion = toolDraftVersion;
  const policy = { ...toolDraft.policy };
  void api(toolSaveRequest(scope, modeId, policy), { keepalive: true }).catch(() => {});
  return 1;
}
// 返回 true 表示没有待处理的自动保存；false 表示自动保存失败且草稿仍处于未保存状态。
async function flushPendingToolDraft() {
  if (!autoSaveIsOn() || !toolDraft.dirty) return true;
  cancelAutoSave();
  await runAutoSave();
  return !toolDraft.dirty;
}

function sortToolGroups(groups) {
  return [...groups].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) ||
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN'));
}
function toolTabsFor(modeId) {
  const names = toolCatalog(modeId).map(tool => tool.name);
  const known = new Set(names);
  const tabs = [{ id: '@all', name: '全部', tools: names }];
  const claimed = new Set();
  const userTabs = [];
  for (const group of sortToolGroups(groupDraft)) {
    const tools = [];
    for (const member of group.members ?? []) {
      if (member.modeId === modeId && known.has(member.toolName) && !tools.includes(member.toolName)) tools.push(member.toolName);
    }
    for (const name of tools) claimed.add(name);
    userTabs.push({ id: group.id, name: group.name || '未命名分组', tools });
  }
  tabs.push({ id: '@ungrouped', name: '未分组', tools: names.filter(name => !claimed.has(name)) });
  return [...tabs, ...userTabs];
}
function toolSlug(tabId) {
  return tabId === '@all' ? 'v-all' : tabId === '@ungrouped' ? 'v-ungrouped' : String(tabId).replace(/[^A-Za-z0-9_-]/g, '-');
}
function toolTabElementId(tabId) {
  return `tool-tab-${toolSlug(tabId)}`;
}
function toolPanelElementId(tabId) {
  return `tool-panel-${toolSlug(tabId)}`;
}
function toolGroupEnabledCount(tab) {
  return tab.tools.filter(name => toolDraft.policy[name] !== false).length;
}
function toolTabLabel(tab) {
  return `${tab.name} · ${toolGroupEnabledCount(tab)}/${tab.tools.length}`;
}
function activeToolPanel() {
  return [...$('tool-group-panels').children].find(panel => panel.dataset.group === toolView.active) ?? null;
}

function renderToolModes(previous) {
  const modes = (state.agentModes ?? []).filter(mode => !mode.broken);
  $('tool-mode').replaceChildren(...modes.map(mode => new Option(mode.name, mode.id)));
  const known = id => !!id && modes.some(mode => mode.id === id);
  const stored = storageGet(TOOL_LAST_MODE_KEY, '');
  const preferred = known(previous) ? previous :
    known(stored) ? stored :
      known(state.sessionMode) ? state.sessionMode :
        modes.find(mode => mode.id === 'st-preset')?.id ?? modes[0]?.id ?? '';
  $('tool-mode').value = preferred;
  renderToolPanel({ force: true });
}
function renderToolPanel(options = {}) {
  const sessionScope = $('tool-scope').value === 'session';
  $('tool-mode').disabled = sessionScope;
  if (sessionScope && state.sessionMode) $('tool-mode').value = state.sessionMode;
  loadToolDraft(options.force === true);
  const modeId = toolView.modeId;
  const catalog = toolCatalog(modeId);
  const scope = sessionScope ? 'session' : 'mode';
  const kind = toolSelectionKind(scope, modeId);
  renderToolPresetBar(scope, modeId, kind, catalog);
  renderUnresolvedToolRefs();
  renderToolTabs();
  renderGroupPage();
  $('save-tools').disabled = (sessionScope && !sessionId) || !modeId || catalog.length === 0;
  $('select-all-tools').disabled = $('clear-all-tools').disabled = !modeId || catalog.length === 0;
  $('inherit-tools').hidden = !sessionScope;
  $('inherit-tools').disabled = !sessionId || kind !== 'custom';
  const unmatched = unmatchedToolRuleCount(modeId, scope);
  const catalogError = state.toolCatalogErrors?.[modeId];
  const note = !modeId ? '当前会话没有可识别的 DSH 模式。' :
    catalog.length === 0 ? `${modeName(modeId)} 尚无工具目录；打开该模式的会话后即可配置。${catalogError ? `（${catalogError}）` : ''}` :
      describeToolSelection(scope, modeId, kind, catalog) + (unmatched ? ` · 另有 ${unmatched} 条未匹配工具规则（缺少对应模式或插件）` : '');
  $('tool-note').textContent = `${note} · ${autoSaveNote()}`;
}
function describeToolSelection(scope, modeId, kind, catalog) {
  const name = modeName(modeId);
  if (kind === 'preset') {
    const presetName = findToolPreset(toolSelection(scope, modeId)?.presetId)?.name ?? '已删除的预设';
    return scope === 'session'
      ? `当前会话使用工具预设“${presetName}”，共 ${catalog.length} 个工具；修改预设后下一次请求生效。`
      : `${name} 使用工具预设“${presetName}”，共 ${catalog.length} 个工具。`;
  }
  if (scope === 'session') {
    return kind === 'inherit'
      ? `当前会话继承 ${name} 的模式默认，共 ${catalog.length} 个工具。`
      : `当前会话正在使用独立覆盖，共 ${catalog.length} 个工具；保存后下一次请求生效。`;
  }
  return `${name} 的模式默认工具策略，共 ${catalog.length} 个。`;
}
function unmatchedToolRuleCount(modeId, scope) {
  if (!modeId) return 0;
  const known = new Set(toolCatalog(modeId).map(tool => tool.name));
  const unmatched = new Set();
  const collectRules = rules => {
    for (const rule of rules ?? []) {
      if (rule.modeId === modeId && rule.toolName && !known.has(rule.toolName)) unmatched.add(rule.toolName);
    }
  };
  const collectFlat = policy => {
    for (const toolName of Object.keys(policy ?? {})) if (!known.has(toolName)) unmatched.add(toolName);
  };
  const collectModeLayer = () => {
    const modeSelection = toolSelection('mode', modeId);
    if (modeSelection?.kind === 'preset') {
      const preset = findToolPreset(modeSelection.presetId);
      if (preset) {
        collectRules(preset.rules);
        return;
      }
    }
    collectFlat(state.modeToolPolicies?.[modeId]);
  };
  if (scope === 'mode') {
    collectModeLayer();
  } else {
    const kind = toolSelectionKind('session', modeId);
    if (kind === 'preset') {
      const preset = findToolPreset(toolSelection('session', modeId)?.presetId);
      if (preset) collectRules(preset.rules);
      else collectModeLayer();
    } else if (kind === 'custom' && state.sessionToolPolicy != null) {
      collectFlat(state.sessionToolPolicy);
    } else {
      // inherit，以及选择自定义但尚未保存会话策略（服务端解析为模式结果）
      collectModeLayer();
    }
  }
  for (const ref of state.unresolvedToolRefs ?? []) {
    if (ref.modeId === modeId && ref.toolName && !known.has(ref.toolName)) unmatched.add(ref.toolName);
  }
  return unmatched.size;
}
function renderToolPresetBar(scope, modeId, kind, catalog) {
  const sessionScope = scope === 'session';
  const selection = toolSelection(scope, modeId);
  const presets = state.toolPresets ?? [];
  const options = [];
  if (sessionScope) options.push(new Option('继承模式默认', 'inherit'));
  options.push(new Option('自定义', 'custom'));
  for (const preset of presets) options.push(new Option(preset.name || preset.id, `${TOOL_PRESET_PREFIX}${preset.id}`));
  $('tool-preset').replaceChildren(...options);
  const selectedId = kind === 'preset' && findToolPreset(selection?.presetId) ? selection.presetId : '';
  $('tool-preset').value = selectedId ? `${TOOL_PRESET_PREFIX}${selectedId}` :
    kind === 'inherit' && sessionScope ? 'inherit' : 'custom';
  $('tool-preset-copy').disabled = $('tool-preset-rename').disabled = $('tool-preset-delete').disabled = !selectedId;
  $('tool-preset-new').disabled = !modeId || catalog.length === 0;
  const counts = selectedId ? state.toolPresetRefCounts?.[selectedId] : null;
  $('tool-preset-refs').textContent = !selectedId ? '' : counts
    ? `被 ${counts.modes ?? 0} 个模式、${counts.sessions ?? 0} 个会话引用`
    : `被 ${Object.values(state.modeToolSelections ?? {}).filter(item => item?.kind === 'preset' && item.presetId === selectedId).length} 个模式引用（会话引用计数暂不可用）`;
}
function renderUnresolvedToolRefs() {
  const box = $('unresolved-tools');
  const refs = state.unresolvedToolRefs ?? [];
  box.hidden = refs.length === 0;
  box.replaceChildren();
  if (!refs.length) return;
  const head = document.createElement('p');
  head.textContent = `未匹配引用 ${refs.length} 项（安装对应插件并打开其会话后自动重新匹配）：`;
  box.append(head);
  const list = document.createElement('ul');
  for (const ref of refs.slice(0, 20)) {
    const item = document.createElement('li');
    item.textContent = `${ref.ownerName ?? ref.ownerId ?? '未知来源'} · ${ref.kind === 'group' ? '分组' : '工具预设'} · ${ref.modeId} / ${ref.toolName}`;
    list.append(item);
  }
  if (refs.length > 20) {
    const item = document.createElement('li');
    item.textContent = `… 另有 ${refs.length - 20} 项`;
    list.append(item);
  }
  box.append(list);
}

function renderToolTabs() {
  const tabs = toolTabsFor(toolView.modeId);
  const available = new Set(tabs.map(tab => tab.id));
  const remembered = storageGet(toolActiveGroupKey(toolView.modeId), '@all');
  if (!available.has(toolView.active)) toolView.active = available.has(remembered) ? remembered : '@all';
  toolView.tabs = tabs;
  const collapsed = storageGet(TOOL_TABS_COLLAPSED_KEY, '0') === '1' || compactToolTabs.matches;
  const tablist = $('tool-tablist');
  tablist.hidden = collapsed;
  tablist.replaceChildren(...tabs.map(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.id = toolTabElementId(tab.id);
    button.dataset.group = tab.id;
    button.setAttribute('aria-controls', toolPanelElementId(tab.id));
    button.setAttribute('aria-selected', String(tab.id === toolView.active));
    button.tabIndex = tab.id === toolView.active ? 0 : -1;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = toolTabLabel(tab);
    button.append(label);
    button.onclick = () => activateToolGroup(tab.id);
    return button;
  }));
  $('tool-group-select-wrap').hidden = !collapsed;
  $('tool-group-select').replaceChildren(...tabs.map(tab => new Option(toolTabLabel(tab), tab.id)));
  $('tool-group-select').value = toolView.active;
  $('tool-tabs-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('tool-tabs-toggle').textContent = collapsed ? '展开标签栏' : '收起标签栏';
  const panels = $('tool-group-panels');
  const contentOpen = storageGet(TOOL_CONTENT_OPEN_KEY, '1') !== '0';
  panels.replaceChildren(...tabs.map(tab => {
    const panel = document.createElement('details');
    panel.className = 'tool-group-content';
    panel.id = toolPanelElementId(tab.id);
    panel.dataset.group = tab.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', toolTabElementId(tab.id));
    panel.open = contentOpen;
    panel.addEventListener('toggle', event => {
      if (event.target === panel) storageSet(TOOL_CONTENT_OPEN_KEY, panel.open ? '1' : '0');
    });
    return panel;
  }));
  syncToolTabs(false);
}
function syncToolTabs(focus) {
  for (const button of $('tool-tablist').querySelectorAll('[role="tab"]')) {
    const selected = button.dataset.group === toolView.active;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  $('tool-group-select').value = toolView.active;
  for (const panel of $('tool-group-panels').children) {
    const selected = panel.dataset.group === toolView.active;
    panel.hidden = !selected;
    if (selected) renderToolGroupPanel(panel);
    else panel.replaceChildren();
  }
}
function activateToolGroup(id, options = {}) {
  if (!toolView.tabs.some(tab => tab.id === id)) return;
  toolView.active = id;
  if (options.persist !== false) storageSet(toolActiveGroupKey(toolView.modeId), id);
  syncToolTabs(options.focus === true);
}
function toolButton(text, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.onclick = handler;
  return button;
}
function renderToolGroupPanel(panel) {
  const tab = toolView.tabs.find(item => item.id === panel.dataset.group);
  panel.replaceChildren();
  if (!tab) return;
  const descriptions = new Map(toolCatalog(toolView.modeId).map(tool => [tool.name, tool.description || '无描述']));
  const summary = document.createElement('summary');
  const head = document.createElement('span');
  head.className = 'group-summary';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'group-switch';
  toggle.setAttribute('aria-label', `全开或全关 ${tab.name}`);
  toggle.onchange = () => {
    for (const name of tab.tools) toolDraft.policy[name] = toggle.checked;
    markToolDirty();
    rerenderToolGroup();
  };
  const stat = document.createElement('span');
  stat.className = 'group-stat';
  head.append(toggle, stat);
  const actions = document.createElement('span');
  actions.className = 'group-actions';
  for (const [op, text] of [['all-on', '全开'], ['all-off', '全关'], ['only', '仅启用此组'], ['restore', '恢复预设值']]) {
    const button = toolButton(text, () => applyToolBatch(op, tab));
    button.dataset.op = op;
    actions.append(button);
  }
  summary.append(head, actions);
  summary.addEventListener('click', event => {
    if (!event.target.closest('input,button,select,textarea,a')) return;
    const wasOpen = panel.open;
    queueMicrotask(() => { if (panel.open !== wasOpen) panel.open = wasOpen; });
  });
  const listWrap = document.createElement('details');
  listWrap.className = 'tool-list-toggle';
  listWrap.open = true;
  const listSummary = document.createElement('summary');
  const list = document.createElement('div');
  list.className = 'check-list tools';
  list.id = 'tool-list';
  for (const name of tab.tools) {
    const label = document.createElement('label');
    label.className = 'check-entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.tool = name;
    input.checked = toolDraft.policy[name] !== false;
    input.onchange = () => {
      toolDraft.policy[name] = input.checked;
      markToolDirty();
      updateToolGroupSummary(panel);
      refreshToolTabLabels();
    };
    const text = document.createElement('span');
    text.textContent = name;
    const small = document.createElement('small');
    small.textContent = descriptions.get(name) ?? '无描述';
    text.append(small);
    label.append(input, text);
    list.append(label);
  }
  listWrap.append(listSummary, list);
  panel.append(summary, listWrap);
  updateToolGroupSummary(panel);
}
function updateToolGroupSummary(panel) {
  const tab = toolView.tabs.find(item => item.id === panel?.dataset.group);
  if (!tab) return;
  const enabled = toolGroupEnabledCount(tab);
  const total = tab.tools.length;
  const toggle = panel.querySelector('.group-switch');
  if (toggle) {
    toggle.checked = total > 0 && enabled === total;
    toggle.indeterminate = enabled > 0 && enabled < total;
    toggle.disabled = total === 0;
  }
  const stat = panel.querySelector('.group-stat');
  if (stat) stat.textContent = `已启用 ${enabled}/${total}`;
  const listSummary = panel.querySelector('.tool-list-toggle>summary');
  if (listSummary) listSummary.textContent = `工具列表（${total} 个）`;
  const restorable = !!restoreToolReference();
  for (const button of panel.querySelectorAll('[data-op]')) {
    if (button.dataset.op === 'restore') {
      button.disabled = !restorable;
      button.title = restorable ? toolView.sessionScope ? '将本组工具恢复为模式继承值' : '将本组工具恢复为已保存的模式默认值'
        : '仅自定义策略可以恢复预设值';
    } else {
      button.disabled = total === 0;
    }
  }
}
function refreshToolTabLabels() {
  for (const tab of toolView.tabs) {
    const label = toolTabLabel(tab);
    const button = $('tool-tablist').querySelector(`[role="tab"][data-group="${CSS.escape(tab.id)}"]`);
    const span = button?.querySelector('.tab-label');
    if (span) span.textContent = label;
    const option = [...$('tool-group-select').options].find(item => item.value === tab.id);
    if (option) option.textContent = label;
  }
}
function rerenderToolGroup() {
  const panel = activeToolPanel();
  if (panel) renderToolGroupPanel(panel);
  refreshToolTabLabels();
}
function restoreToolReference() {
  const scope = toolView.sessionScope ? 'session' : 'mode';
  if (toolSelectionKind(scope, toolView.modeId) !== 'custom') return null;
  return toolView.sessionScope
    ? modeToolPolicy(toolView.modeId)
    : normalizeToolPolicy(state.modeToolPolicies?.[toolView.modeId] ?? {}, toolView.modeId);
}
function applyToolBatch(op, tab) {
  const modeId = toolView.modeId;
  if (op === 'all-on') {
    for (const name of tab.tools) toolDraft.policy[name] = true;
  } else if (op === 'all-off') {
    for (const name of tab.tools) toolDraft.policy[name] = false;
  } else if (op === 'only') {
    for (const tool of toolCatalog(modeId)) toolDraft.policy[tool.name] = false;
    for (const name of tab.tools) toolDraft.policy[name] = true;
  } else if (op === 'restore') {
    const reference = restoreToolReference();
    if (!reference) return;
    for (const name of tab.tools) toolDraft.policy[name] = reference[name] !== false;
  } else return;
  markToolDirty();
  rerenderToolGroup();
}

function assignableToolModes() {
  const modes = (state.agentModes ?? []).filter(mode => !mode.broken && toolCatalog(mode.id).length > 0);
  const known = new Set(modes.map(mode => mode.id));
  for (const modeId of Object.keys(state.toolCatalogs ?? {})) {
    if (!known.has(modeId) && toolCatalog(modeId).length > 0) modes.push({ id: modeId, name: modeId });
  }
  return modes;
}
function renderGroupPage() {
  $('tool-groups-page').hidden = !groupPageOpen;
  $('tool-tab-area').hidden = groupPageOpen;
  $('manage-groups').setAttribute('aria-expanded', String(groupPageOpen));
  $('manage-groups').textContent = groupPageOpen ? '隐藏分组管理' : '管理分组';
  if (!groupPageOpen) return;
  const list = $('group-list');
  list.replaceChildren();
  const modes = assignableToolModes();
  const ordered = sortToolGroups(groupDraft);
  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '还没有自定义分组。点击“＋ 新增分组”，再用复选框把工具分配到分组。';
    list.append(empty);
  }
  for (const [index, group] of ordered.entries()) list.append(groupEditor(group, index, ordered.length, modes));
}
function groupMemberCountText(group, modeId) {
  const members = group.members ?? [];
  if (!modeId) return `本组共 ${members.length} 个成员（暂无可配置模式）`;
  const known = new Set(toolCatalog(modeId).map(tool => tool.name));
  const local = members.filter(member => member.modeId === modeId && known.has(member.toolName)).length;
  const name = (state.agentModes ?? []).find(mode => mode.id === modeId)?.name ?? modeId;
  return `本组共 ${members.length} 个成员（${name} 中 ${local} 个）`;
}
function groupEditor(group, index, count, modes) {
  const box = document.createElement('div');
  box.className = 'group-editor';
  box.dataset.group = group.id;
  const head = document.createElement('div');
  head.className = 'row';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'grow';
  nameLabel.textContent = '分组名称';
  const nameInput = document.createElement('input');
  nameInput.value = group.name ?? '';
  nameInput.oninput = () => {
    group.name = nameInput.value;
    markGroupsDirty();
    renderToolTabs();
  };
  nameLabel.append(nameInput);
  const orderLabel = document.createElement('label');
  orderLabel.textContent = '顺序';
  const orderInput = document.createElement('input');
  orderInput.type = 'number';
  orderInput.min = '0';
  orderInput.value = String(Number(group.order) || 0);
  orderInput.onchange = () => {
    group.order = Math.max(0, Math.round(Number(orderInput.value) || 0));
    markGroupsDirty();
    renderGroupPage();
    renderToolTabs();
  };
  orderLabel.append(orderInput);
  const up = toolButton('↑ 上移', () => moveToolGroup(group.id, -1));
  up.disabled = index === 0;
  const down = toolButton('↓ 下移', () => moveToolGroup(group.id, 1));
  down.disabled = index === count - 1;
  const remove = toolButton('删除', () => {
    if (!confirm(`删除分组“${group.name || '未命名分组'}”？只删除成员关系，不改变工具开关。`)) return;
    groupDraft = groupDraft.filter(item => item.id !== group.id);
    groupEditorModes.delete(group.id);
    markGroupsDirty();
    renderGroupPage();
    renderToolTabs();
  });
  remove.className = 'danger';
  head.append(nameLabel, orderLabel, up, down, remove);
  const descLabel = document.createElement('label');
  descLabel.className = 'grow';
  descLabel.textContent = '分组描述（可选）';
  const descInput = document.createElement('input');
  descInput.value = group.description ?? '';
  descInput.oninput = () => {
    group.description = descInput.value;
    markGroupsDirty();
  };
  descLabel.append(descInput);
  const members = document.createElement('div');
  members.className = 'group-members';
  const modeRow = document.createElement('div');
  modeRow.className = 'row';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = '分配工具的模式';
  const modeSelect = document.createElement('select');
  modeSelect.className = 'group-member-mode';
  modeSelect.replaceChildren(...modes.map(mode => new Option(mode.name, mode.id)));
  const candidates = modes.map(mode => mode.id);
  const preferred = groupEditorModes.get(group.id);
  const chosen = candidates.includes(preferred) ? preferred : candidates.includes(toolView.modeId) ? toolView.modeId : candidates[0] ?? '';
  modeSelect.value = chosen;
  groupEditorModes.set(group.id, chosen);
  modeSelect.onchange = () => {
    groupEditorModes.set(group.id, modeSelect.value);
    renderGroupPage();
  };
  modeLabel.append(modeSelect);
  const counts = document.createElement('span');
  counts.className = 'muted';
  counts.dataset.role = 'member-count';
  counts.textContent = groupMemberCountText(group, chosen);
  modeRow.append(modeLabel, counts);
  const grid = document.createElement('div');
  grid.className = 'check-list tools';
  if (!chosen) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = '暂无可分配的工具目录；打开对应模式的会话后即可配置。';
    grid.append(none);
  }
  for (const tool of toolCatalog(chosen)) {
    const label = document.createElement('label');
    label.className = 'check-entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.mode = chosen;
    input.dataset.tool = tool.name;
    input.checked = (group.members ?? []).some(member => member.modeId === chosen && member.toolName === tool.name);
    input.onchange = () => {
      group.members = (group.members ?? []).filter(member => !(member.modeId === chosen && member.toolName === tool.name));
      if (input.checked) {
        for (const other of groupDraft) {
          if (other.id === group.id) continue;
          other.members = (other.members ?? []).filter(member => !(member.modeId === chosen && member.toolName === tool.name));
        }
        group.members.push({ modeId: chosen, toolName: tool.name });
      }
      markGroupsDirty();
      syncGroupMembership(chosen, tool.name);
      renderToolTabs();
    };
    const text = document.createElement('span');
    text.textContent = tool.name;
    const small = document.createElement('small');
    small.textContent = tool.description || '无描述';
    text.append(small);
    label.append(input, text);
    grid.append(label);
  }
  members.append(modeRow, grid);
  box.append(head, descLabel, members);
  return box;
}
function syncGroupMembership(modeId, toolName) {
  for (const box of $('group-list').querySelectorAll('.group-editor')) {
    const group = groupDraft.find(item => item.id === box.dataset.group);
    if (!group) continue;
    const select = box.querySelector('.group-member-mode');
    const counts = box.querySelector('[data-role="member-count"]');
    if (counts) counts.textContent = groupMemberCountText(group, select ? select.value : '');
    if (!select || select.value !== modeId) continue;
    const input = box.querySelector(`input[data-mode="${CSS.escape(modeId)}"][data-tool="${CSS.escape(toolName)}"]`);
    if (input) input.checked = (group.members ?? []).some(member => member.modeId === modeId && member.toolName === toolName);
  }
}
function moveToolGroup(id, delta) {
  const ordered = sortToolGroups(groupDraft);
  const index = ordered.findIndex(group => group.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  ordered.forEach((group, position) => { group.order = (position + 1) * 100; });
  markGroupsDirty();
  renderGroupPage();
  renderToolTabs();
}

function renderPackageTools(record) {
  const tools = record?.sharePackage?.tools;
  const box = $('package-tools');
  const button = $('import-package-tools');
  const note = $('package-tools-note');
  const preview = $('package-tools-preview');
  packageToolsRecordId = '';
  if (!tools || !selectedId) {
    box.hidden = true;
    note.textContent = '';
    preview.replaceChildren();
    button.hidden = true;
    return;
  }
  box.hidden = false;
  button.hidden = false;
  const groups = Array.isArray(tools.groups) ? tools.groups.length : 0;
  const presets = Array.isArray(tools.presets) ? tools.presets.length : 0;
  const supported = Number(tools.version) === 1;
  button.disabled = !supported;
  note.textContent = `包内工具配置：${groups} 个分组 · ${presets} 个工具预设 · tools.version=${tools.version ?? '未标注'}` +
    (supported ? '。导入不会自动应用，需显式点击。' : '（版本未知，禁止应用；仍会随分享文件原样保留）');
  preview.replaceChildren();
  if (!supported) return;
  const recordId = selectedId;
  packageToolsRecordId = recordId;
  preview.textContent = '正在预览导入内容…';
  api({ action: 'import-package-tools', id: recordId, dryRun: true }).then(result => {
    if (packageToolsRecordId !== recordId) return;
    renderPackageToolsPreview(result, '预览导入');
  }).catch(error => {
    if (packageToolsRecordId !== recordId) return;
    preview.textContent = `预览失败：${error.message}`;
  });
}
function renderPackageToolsPreview(result, title) {
  const box = $('package-tools-preview');
  box.replaceChildren();
  const stats = result.stats ?? {};
  const line = document.createElement('p');
  line.className = 'muted';
  line.textContent = `${title}：分组 新增 ${stats.groups?.added ?? 0} / 复用 ${stats.groups?.reused ?? 0} / 重映射 ${stats.groups?.remapped ?? 0}` +
    `；工具预设 新增 ${stats.presets?.added ?? 0} / 复用 ${stats.presets?.reused ?? 0} / 重映射 ${stats.presets?.remapped ?? 0}` +
    `；引用匹配 ${stats.matched ?? 0}、未匹配 ${stats.unmatched ?? 0}`;
  box.append(line);
  const warnings = result.warnings ?? [];
  if (warnings.length) {
    const warning = document.createElement('p');
    warning.className = 'muted';
    warning.textContent = `未匹配警告：${warnings.join('；')}`;
    box.append(warning);
  }
}

function renderList() {
  const term = $('search').value.toLowerCase();
  const listed = new Set(order().map(item => item.identifier));
  const used = order().map(item => ({
    item,
    prompt: preset.prompts.find(prompt => prompt.identifier === item.identifier),
  })).filter(entry => entry.prompt);
  const unused = preset.prompts.filter(prompt => !listed.has(prompt.identifier)).map(prompt => ({ prompt }));
  $('used-count').textContent = `${used.length} 项`;
  $('unused-count').textContent = `${unused.length} 项`;
  $('used-prompts').replaceChildren();
  $('unused-prompts').replaceChildren();
  for (const entry of used) renderPromptItem(entry.prompt, entry.item, true, term, $('used-prompts'));
  for (const entry of unused) renderPromptItem(entry.prompt, null, false, term, $('unused-prompts'));
}
function renderPromptItem(prompt, item, used, term, parent) {
  if (!`${prompt.name ?? ''} ${prompt.identifier} ${prompt.content ?? ''}`.toLowerCase().includes(term)) return;
  const div = document.createElement('div');
  div.className = `item ${used ? item.enabled ? '' : 'off' : 'unused'} ${selectedPrompt === prompt.identifier ? 'active' : ''}`;
  if (used) {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = item.enabled;
    toggle.setAttribute('aria-label', `启用 ${prompt.name ?? prompt.identifier}`);
    toggle.onchange = () => {
      setEnabled(prompt.identifier, toggle.checked);
      renderList();
      renderEditor();
    };
    div.append(toggle);
  }
  const button = document.createElement('button');
  button.className = 'entry';
  button.textContent = `${prompt.name ?? prompt.identifier} · ${prompt.marker ? '标记' : prompt.role ?? 'system'}`;
  button.onclick = () => {
    selectedPrompt = prompt.identifier;
    renderList();
    renderEditor();
  };
  const membership = document.createElement('button');
  membership.className = 'membership';
  membership.type = 'button';
  membership.textContent = used ? '移出' : '加入';
  membership.disabled = prompt.identifier === 'chatHistory';
  membership.setAttribute('aria-label', `${used ? '移出顺序表' : '加入顺序表'} ${prompt.name ?? prompt.identifier}`);
  membership.onclick = () => {
    used ? removeFromOrder(prompt.identifier) : addToOrder(prompt.identifier);
    renderList();
    renderEditor();
  };
  div.append(button, membership);
  parent.append(div);
}
function setEnabled(id, enabled) {
  const item = order().find(entry => entry.identifier === id);
  if (!item) return;
  item.enabled = enabled;
  markDirty();
}
function addToOrder(id) {
  if (order().some(item => item.identifier === id)) return;
  const marker = order().findIndex(item => item.identifier === 'chatHistory');
  order().splice(marker < 0 ? order().length : marker, 0, { identifier: id, enabled: true });
  markDirty();
}
function removeFromOrder(id) {
  if (id === 'chatHistory') return;
  const index = order().findIndex(item => item.identifier === id);
  if (index >= 0) {
    order().splice(index, 1);
    markDirty();
  }
}
function renderEditor() {
  const prompt = current();
  $('editor').hidden = !prompt;
  $('empty').hidden = !!prompt;
  if (!prompt) return;
  const item = order().find(entry => entry.identifier === prompt.identifier);
  const used = !!item;
  $('prompt-name').value = prompt.name ?? '';
  $('role').value = prompt.role ?? 'system';
  $('position').value = prompt.injection_position ?? 0;
  $('depth').value = prompt.injection_depth ?? 4;
  $('priority').value = prompt.injection_order ?? 100;
  $('content').value = prompt.content ?? '';
  $('content').disabled = !!prompt.marker;
  $('prompt-enabled').checked = item?.enabled ?? false;
  $('prompt-enabled').disabled = !used;
  $('up').disabled = !used;
  $('down').disabled = !used;
  $('marker-note').textContent = prompt.marker ?
    `标记 ${prompt.identifier}：chatHistory 展开真实会话；其他标记在下方 JSON 中填写。` :
    `${prompt.identifier}${used ? '' : ' · 当前为闲置条目，加入顺序表后才会参与注入'}`;
}

for (const [id, key, numeric] of [
  ['prompt-name', 'name'], ['role', 'role'], ['position', 'injection_position', true],
  ['depth', 'injection_depth', true], ['priority', 'injection_order', true], ['content', 'content'],
]) {
  $(id).oninput = () => {
    if (!current()) return;
    current()[key] = numeric ? Number($(id).value) : $(id).value;
    markDirty();
    if (id === 'prompt-name' || id === 'role') renderList();
  };
}
$('prompt-enabled').onchange = () => {
  setEnabled(selectedPrompt, $('prompt-enabled').checked);
  renderList();
};
$('order').onchange = () => {
  selectedPrompt = order()[0]?.identifier ?? '';
  renderList();
  renderEditor();
};
$('search').oninput = renderList;
$('name').oninput = markDirty;
$('prefill').oninput = () => {
  preset.assistant_prefill = $('prefill').value;
  markDirty();
};
$('post-tool-prefix-mode').onchange = () => {
  syncPrefixToolControls();
  status('预填充接口设置尚未保存');
};
$('post-tool-prefix-text').oninput = () => status('预填充接口设置尚未保存');
$('deepseek-beta-prefix').onchange = () => status('预填充接口设置尚未保存');
$('prefix-tool-calls').onchange = () => {
  syncPrefixToolControls();
  status('预填充接口设置尚未保存');
};
$('prefix-nonofficial-remove-tools').onchange = () => status('预填充接口设置尚未保存');
for (const [id, delta] of [['up', -1], ['down', 1]]) $(id).onclick = () => {
  const items = order();
  const index = items.findIndex(item => item.identifier === selectedPrompt);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
  markDirty();
  renderList();
};
$('add').onclick = () => {
  selectedPrompt = crypto.randomUUID();
  preset.prompts.push({
    identifier: selectedPrompt,
    name: '新提示词',
    role: 'system',
    content: '',
    injection_position: 0,
  });
  order().splice(Math.max(0, order().findIndex(item => item.identifier === 'chatHistory')), 0, {
    identifier: selectedPrompt,
    enabled: true,
  });
  markDirty();
  renderList();
  renderEditor();
};

function discardOkay() {
  return presetDiscardOkay() && toolDiscardOkay() && groupDiscardOkay();
}
$('new').onclick = () => {
  // 新建提示词预设与工具配置无关：只确认提示词草稿，工具/分组草稿继续保留。
  if (!presetDiscardOkay()) return;
  loadDraft('');
};
$('library').onchange = guard(async () => {
  const id = $('library').value;
  if (!discardOkay()) {
    $('library').value = selectedId;
    return;
  }
  if (!id) {
    loadDraft('');
    return;
  }
  await api({ action: 'select-preset', id });
  await reload(id);
  status('已切换全局默认注入预设');
});
$('reload').onclick = guard(async () => {
  // 重新加载只刷新提示词预设草稿；未保存的工具/分组草稿会被保留。
  if (presetDiscardOkay()) await reload(selectedId);
});
$('delete-preset').onclick = guard(async () => {
  if (!selectedId) throw new Error('请选择要删除的已保存预设');
  if (dirty) throw new Error('请先保存或放弃预设草稿');
  const record = state.presets.find(item => item.id === selectedId);
  if (!record || !confirm('确定删除预设“' + record.name + '”？此操作无法撤销。')) return;
  const result = await api({ action: 'delete-preset', id: selectedId });
  await reload(result.id ?? '');
  status('预设已删除');
});
$('import').onchange = guard(async () => {
  const file = $('import').files[0];
  if (!file || !discardOkay()) return;
  try {
    if (file.size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
    const parsed = JSON.parse(await file.text());
    const name = file.name.replace(/(?:\.dsh-preset)?\.json$/i, '');
    const result = await api({ action: 'import', name, document: parsed });
    await reload(result.id);
    status(parsed.format === 'dsh-preset-enhance' ? '预设包已导入并设为当前默认；全局接口设置保持原值' : '预设已导入、全局保存并设为当前默认');
  } finally {
    $('import').value = '';
  }
});
$('save').onclick = guard(async () => {
  const result = await api({ action: 'save', id: selectedId, name: $('name').value, preset });
  await reload(result.id);
  status('预设已保存');
});
$('mode-default').onclick = guard(async () => {
  if (dirty) throw new Error('请先保存预设草稿');
  await api({ action: 'set-default', id: selectedId });
  await reload(selectedId);
  status('已设为当前默认注入预设');
});
$('bind').disabled = !sessionId;
$('bind').onclick = guard(async () => {
  if (dirty) throw new Error('请先保存预设草稿');
  await api({
    action: 'bind',
    sessionId,
    binding: { enabled: $('enabled').checked, presetId: selectedId, ...options() },
  });
  await reload(selectedId);
  status('会话设置已应用，下一次请求生效');
});
$('apply-package-prefill').onclick = guard(async () => {
  if (!presetDiscardOkay()) return;
  await api({ action: 'apply-package-prefill', id: selectedId });
  await reload(selectedId);
  status('包内接口设置已应用到全局，下一次请求生效');
});
$('save-deepseek-beta').onclick = guard(async () => {
  if (dirty) throw new Error('请先保存或放弃预设草稿');
  await api({
    action: 'save-deepseek-beta',
    presetId: selectedId,
    postToolPrefixMode: $('post-tool-prefix-mode').value,
    postToolPrefixText: $('post-tool-prefix-text').value,
    enabled: $('deepseek-beta-prefix').checked,
    toolCalls: $('prefix-tool-calls').checked,
    removeNonOfficialTools: $('prefix-nonofficial-remove-tools').checked,
  });
  await reload(selectedId);
  status('预填充接口设置已保存');
});
$('save-auto-modes').onclick = guard(async () => {
  const modes = [...$('auto-mode-list').querySelectorAll('input[data-mode]:checked')].map(input => input.dataset.mode);
  await api({ action: 'save-auto-modes', modes });
  await reload(selectedId);
  status('自动启用模式列表已保存，仅影响之后新建的会话');
});
$('tool-scope').onchange = guard(async () => {
  const previousScope = toolView.sessionScope ? 'session' : 'mode';
  if ((!(await flushPendingToolDraft()) || toolDraft.dirty) && !toolDiscardOkay()) {
    $('tool-scope').value = previousScope;
    renderToolPanel();
    return;
  }
  renderToolPanel({ force: true });
});
$('tool-mode').onchange = guard(async () => {
  const previousMode = toolView.modeId;
  if ((!(await flushPendingToolDraft()) || toolDraft.dirty) && !toolDiscardOkay()) {
    $('tool-mode').value = previousMode;
    renderToolPanel();
    return;
  }
  // 记住用户最后配置的模式，刷新页面后优先回到它，而不是回到会话模式/st-preset。
  storageSet(TOOL_LAST_MODE_KEY, $('tool-mode').value);
  renderToolPanel({ force: true });
});
$('tool-preset').onchange = guard(async () => {
  const value = $('tool-preset').value;
  const sessionScope = $('tool-scope').value === 'session';
  if (sessionScope && !sessionId) throw new Error('当前页面没有会话，无法切换会话工具策略');
  const modeId = sessionScope ? state.sessionMode ?? '' : $('tool-mode').value;
  if (!modeId) {
    renderToolPanel();
    throw new Error('请先选择要配置的 DSH 模式');
  }
  if ((!(await flushPendingToolDraft()) || toolDraft.dirty) && !toolDiscardOkay()) {
    renderToolPanel();
    return;
  }
  const selection = value === 'inherit' ? { kind: 'inherit' } :
    value === 'custom' ? { kind: 'custom' } :
      { kind: 'preset', presetId: value.slice(TOOL_PRESET_PREFIX.length) };
  await api({
    action: 'select-tool-policy',
    scope: sessionScope ? 'session' : 'mode',
    ...(sessionScope ? { sessionId } : { modeId }),
    selection,
  });
  await reload(selectedId);
  status(selection.kind === 'inherit' ? '当前会话已恢复继承模式默认工具，下一次请求生效' :
    selection.kind === 'custom' ? '已切换为逐工具自定义策略，下一次请求生效' :
      `工具预设已应用到当前${sessionScope ? '会话' : '模式'}，下一次请求生效`);
});
$('tool-preset-new').onclick = guard(async () => {
  const { sessionScope, modeId } = toolContext();
  const catalog = toolCatalog(modeId);
  if (!modeId || !catalog.length) throw new Error('当前模式没有可用的工具目录');
  // 新建后会把选择切到新预设：先刷掉待自动保存的改动，再按约定确认。
  if ((!(await flushPendingToolDraft()) || toolDraft.dirty) && !toolDiscardOkay()) return;
  const suggested = `${modeName(modeId)} 工具预设`;
  const input = prompt('新工具预设名称', suggested);
  if (input === null) return;
  const policy = effectiveToolPolicy(modeId, sessionScope);
  const rules = catalog
    .filter(tool => policy[tool.name] === false)
    .map(tool => ({ modeId, toolName: tool.name, enabled: false }));
  const name = input.trim() || suggested;
  const created = await api({
    action: 'save-tool-preset',
    id: null,
    preset: { name, description: '', defaultEnabled: true, groupIds: [], rules },
  });
  await api({
    action: 'select-tool-policy',
    scope: sessionScope ? 'session' : 'mode',
    ...(sessionScope ? { sessionId } : { modeId }),
    selection: { kind: 'preset', presetId: created.id },
  });
  await reload(selectedId);
  status(`工具预设“${name}”已新建并应用到当前${sessionScope ? '会话' : '模式'}，下一次请求生效`);
});
$('tool-preset-copy').onclick = guard(async () => {
  const { sessionScope, modeId } = toolContext();
  const preset = findToolPreset(toolSelection(sessionScope ? 'session' : 'mode', modeId)?.presetId);
  if (!preset) throw new Error('请先选择一个工具预设');
  const input = prompt('复制工具预设名称', `${preset.name} 副本`);
  if (input === null) return;
  const name = input.trim() || `${preset.name} 副本`;
  await api({
    action: 'save-tool-preset',
    id: null,
    preset: {
      name,
      description: preset.description ?? '',
      defaultEnabled: preset.defaultEnabled !== false,
      groupIds: [...(preset.groupIds ?? [])],
      rules: structuredClone(preset.rules ?? []),
    },
  });
  await reload(selectedId);
  status(`工具预设已复制为“${name}”；当前选择未改变`);
});
$('tool-preset-rename').onclick = guard(async () => {
  const { sessionScope, modeId } = toolContext();
  const preset = findToolPreset(toolSelection(sessionScope ? 'session' : 'mode', modeId)?.presetId);
  if (!preset) throw new Error('请先选择一个工具预设');
  const input = prompt('重命名工具预设', preset.name);
  if (input === null || !input.trim() || input.trim() === preset.name) return;
  const name = input.trim();
  await api({
    action: 'save-tool-preset',
    id: preset.id,
    preset: {
      name,
      description: preset.description ?? '',
      defaultEnabled: preset.defaultEnabled !== false,
      groupIds: [...(preset.groupIds ?? [])],
      rules: structuredClone(preset.rules ?? []),
    },
  });
  await reload(selectedId);
  status(`工具预设已重命名为“${name}”`);
});
$('tool-preset-delete').onclick = guard(async () => {
  const { sessionScope, modeId } = toolContext();
  const preset = findToolPreset(toolSelection(sessionScope ? 'session' : 'mode', modeId)?.presetId);
  if (!preset) throw new Error('请先选择一个工具预设');
  const counts = state.toolPresetRefCounts?.[preset.id];
  const modes = counts?.modes ?? Object.values(state.modeToolSelections ?? {})
    .filter(item => item?.kind === 'preset' && item.presetId === preset.id).length;
  const sessions = counts?.sessions ?? 0;
  // 删除会让引用它的模式/会话回退：先刷掉待自动保存的改动，再按约定确认。
  if ((!(await flushPendingToolDraft()) || toolDraft.dirty) && !toolDiscardOkay()) return;
  if (!confirm(`确定删除工具预设“${preset.name}”？它被 ${modes} 个模式、${sessions} 个会话引用；删除后这些模式回到自定义策略，会话回到继承模式默认。此操作无法撤销。`)) return;
  await api({ action: 'delete-tool-preset', id: preset.id });
  await reload(selectedId);
  status('工具预设已删除，引用它的模式回到自定义、会话回到继承');
});
for (const [id, checked] of [['select-all-tools', true], ['clear-all-tools', false]]) {
  $(id).onclick = () => {
    for (const tool of toolCatalog(toolView.modeId)) toolDraft.policy[tool.name] = checked;
    markToolDirty();
    rerenderToolGroup();
  };
}
$('save-tools').onclick = guard(async () => {
  // 显式保存：取消待触发的自动保存，并等待在途自动保存结束，避免同一改动提交两次。
  cancelAutoSave();
  await autoSaveChain;
  const scope = toolView.sessionScope ? 'session' : 'mode';
  const modeId = toolView.modeId;
  const kind = toolSelectionKind(scope, modeId);
  const policy = { ...toolDraft.policy };
  if (scope === 'session') {
    if (!sessionId) throw new Error('当前页面没有会话，无法保存会话工具开关');
    await api({ action: 'save-session-tools', sessionId, policy });
  } else {
    if (!modeId) throw new Error('请先选择要保存的 DSH 模式');
    await api({ action: 'save-mode-tools', modeId, policy });
    storageSet(TOOL_LAST_MODE_KEY, modeId);
  }
  resetToolDraft();
  await reload(selectedId);
  status(kind === 'preset' ? '工具开关已保存并切换为自定义策略，下一次请求生效' :
    scope === 'session' ? '当前会话工具已更新，下一次请求生效' :
      '模式默认工具已保存，该模式会话的下一次请求生效');
});
$('inherit-tools').onclick = guard(async () => {
  if (!sessionId) throw new Error('当前页面没有会话，无法恢复继承');
  if (!toolDiscardOkay()) return;
  await api({ action: 'save-session-tools', sessionId, inherit: true });
  await reload(selectedId);
  status('当前会话已恢复继承模式默认工具');
});
$('tool-auto-save').onchange = () => {
  const enabled = $('tool-auto-save').checked;
  storageSet(TOOL_AUTO_SAVE_KEY, enabled ? '1' : '0');
  if (enabled) {
    status('已开启工具开关自动保存');
    if (toolDraft.dirty) scheduleAutoSave();   // 立即把已有草稿纳入自动保存
  } else {
    cancelAutoSave();
    status('已关闭工具开关自动保存，改动需要点击“保存工具开关”');
  }
  renderToolPanel();
};
$('tool-tabs-toggle').onclick = () => {
  const collapsed = storageGet(TOOL_TABS_COLLAPSED_KEY, '0') === '1';
  storageSet(TOOL_TABS_COLLAPSED_KEY, collapsed ? '0' : '1');
  renderToolTabs();
};
$('tool-group-select').onchange = () => activateToolGroup($('tool-group-select').value);
$('tool-tablist').onkeydown = event => {
  const tabs = [...$('tool-tablist').querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = -1;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else if (event.key === 'Enter' || event.key === ' ') next = index;
  else return;
  event.preventDefault();
  activateToolGroup(tabs[next].dataset.group, { focus: true });
};
$('manage-groups').onclick = () => {
  groupPageOpen = !groupPageOpen;
  renderGroupPage();
};
$('group-back').onclick = () => {
  groupPageOpen = false;
  renderGroupPage();
};
$('group-new').onclick = () => {
  const maxOrder = groupDraft.reduce((max, group) => Math.max(max, Number(group.order) || 0), 0);
  groupDraft.push({
    id: crypto.randomUUID(),
    name: `新分组 ${groupDraft.length + 1}`,
    description: '',
    order: maxOrder + 100,
    members: [],
  });
  markGroupsDirty();
  renderGroupPage();
  renderToolTabs();
};
$('group-save').onclick = guard(async () => {
  const groups = groupDraft.map(group => ({
    id: group.id,
    name: group.name ?? '',
    description: group.description ?? '',
    order: Number(group.order) || 0,
    members: (group.members ?? []).map(member => ({ modeId: member.modeId, toolName: member.toolName })),
  }));
  const result = await api({ action: 'save-tool-groups', groups });
  resetGroupDraft();
  await reload(selectedId);
  const warnings = result.warnings ?? [];
  status(warnings.length ? `工具分组已保存 · ${warnings.length} 项提示：${warnings.join('；')}` : '工具分组已保存');
});
$('import-package-tools').onclick = guard(async () => {
  if (!selectedId) throw new Error('请先在预设库中选择带工具配置的预设');
  // 导入会替换分组基线；工具开关草稿不受影响，reload 会保留它。
  if (!groupDiscardOkay()) return;
  if (!confirm('导入包内工具配置？会新增或更新工具分组与工具预设，不会自动应用到任何模式或会话。')) return;
  const result = await api({ action: 'import-package-tools', id: selectedId });
  await reload(selectedId);
  const stats = result.stats ?? {};
  status(`包内工具配置已导入：分组新增 ${stats.groups?.added ?? 0} 个、工具预设新增 ${stats.presets?.added ?? 0} 个、未匹配 ${stats.unmatched ?? 0} 个`);
});
compactToolTabs.addEventListener('change', () => renderToolTabs());
$('export-package').onclick = guard(async () => {
  const scope = toolView.sessionScope ? 'session' : 'mode';
  const selection = toolSelection(scope, toolView.modeId);
  const toolPresetId = selection?.kind === 'preset' ? selection.presetId : '';
  const document = await api({
    action: 'export-package',
    id: selectedId,
    name: $('name').value,
    preset,
    ...(toolPresetId ? { toolPresetId } : {}),
  });
  downloadJson(document, `${$('name').value || 'preset'}.dsh-preset.json`);
  status(toolPresetId ? '分享文件已导出，并附带当前选中的工具预设；接口配置取自包内保存值或全局已保存设置' : '分享文件已导出；接口配置取自包内保存值或全局已保存设置');
});
function downloadJson(document, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').onclick = () => downloadJson(preset, `${$('name').value || 'preset'}.json`);

function show(result) {
  $('warnings').textContent = result.warnings.join('\n');
  $('output').replaceChildren();
  for (const message of result.messages) {
    const box = document.createElement('div');
    box.className = 'message';
    const label = document.createElement('b');
    const prefix = result.assistantPrefix?.active && result.assistantPrefix.messageId === message.id ? ' · Assistant Prefix' : '';
    label.textContent = `${message.role} · ${message.source?.plugin === 'dsh-preset-enhance' ? '预设注入' : '会话消息'}${prefix}`;
    const pre = document.createElement('pre');
    pre.textContent = message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n');
    box.append(label, pre);
    $('output').append(box);
  }
  status(`已解析 ${result.messages.length} 条消息 · ${result.warnings.length} 项提示`);
}
$('preview').onclick = guard(async () => show(await api({
  action: 'preview',
  sessionId,
  preset,
  input: $('input').value,
  options: options(),
})));
$('last').onclick = guard(async () => {
  const latest = await api();
  if (!latest.last) throw new Error('当前会话还没有实际注入记录');
  show(latest.last.result);
});

$('tool-auto-save').checked = storageGet(TOOL_AUTO_SAVE_KEY, '0') === '1';
$('tool-scope').querySelector('option[value="session"]').disabled = !sessionId;
$('tool-scope').value = sessionId ? 'session' : 'mode';
window.addEventListener('beforeunload', event => {
  if (dirty || toolDraft.dirty || groupsDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
// 自动保存开启时，页面隐藏/卸载前尽力把最近的工具开关改动发出去（keepalive），避免丢失最后一次编辑。
window.addEventListener('pagehide', () => { flushToolDraftKeepalive(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushToolDraftKeepalive();
});
await guard(() => reload())();
