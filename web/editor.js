import { mcpTabNames } from './tool-labels.js';

const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId') ?? '';
let state = { presets: [], revision: 0 }, selectedId = '', selectedPrompt = '', dirty = false;
let preset = blank();
const DSH_SYSTEM_PROMPT_TEMPLATE_ID = 'dsh-preset-enhance:dsh-system-prompt';
const PRESET_AUTO_SAVE_KEY = 'dsh-preset-enhance.preset-auto-save';
const PRESET_AUTO_SAVE_DELAY = 600;
const GLOBAL_CONFIG_AUTO_SAVE_DELAY = 700;
let presetDraftVersion = 0;
let presetDraftGeneration = 0;
let presetAutoSaveTimer = null;
let presetAutoSaveChain = Promise.resolve();
let globalConfigAutoSaveTimer = null;
let globalConfigAutoSaveChain = Promise.resolve();
let prefillSettingsDirty = false;
let prefillSettingsVersion = 0;
let autoModesDirty = false;
let autoModesVersion = 0;
let bindingDirty = false;
let bindingVersion = 0;
// 顶部会话连接选择器直接改宿主的 provider/model：选中即切换，不参与任何自动保存。
let connectionSwitchSaving = false;

function blank() {
  return {
    dsh_system_prompt_enabled: true,
    prompts: [{ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
  };
}
function status(text, error = false) {
  // 无关的保存/刷新不再丢弃未保存的工具草稿，因此成功提示需要附带待保存提醒。
  const pending = [];
  if (toolDraft.dirty) pending.push('工具开关尚未保存');
  if (groupsDirty) pending.push('工具分组尚未保存');
  if (prefillSettingsDirty) pending.push('接口设置尚未保存');
  if (autoModesDirty) pending.push('自动启用模式尚未保存');
  if (bindingDirty) pending.push('会话设置尚未应用');
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
  presetDraftVersion++;
  status('草稿未保存');
  updateDefaultButton();
  schedulePresetAutoSave();
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
  if (selectedPrompt === DSH_SYSTEM_PROMPT_TEMPLATE_ID) return dshSystemPromptTemplate();
  return preset.prompts.find(prompt => prompt.identifier === selectedPrompt);
}
function dshSystemPromptTemplate() {
  return {
    identifier: DSH_SYSTEM_PROMPT_TEMPLATE_ID,
    name: 'DSH 系统提示词',
    role: 'system',
    marker: true,
    content: state.dshSystemPromptText || '此内容从当前 DSH 模式的系统提示词读取',
  };
}
function isDshSystemPromptTemplate(promptOrId) {
  return (typeof promptOrId === 'string' ? promptOrId : promptOrId?.identifier) === DSH_SYSTEM_PROMPT_TEMPLATE_ID;
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
  presetDraftGeneration++;
  selectedId = id;
  const record = state.presets.find(item => item.id === id);
  preset = structuredClone(record?.preset ?? blank());
  if (preset.dsh_system_prompt_enabled === undefined) preset.dsh_system_prompt_enabled = true;
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
function renderPresetLibrary() {
  $('library').replaceChildren(new Option('新预设', ''), ...state.presets.map(item =>
    new Option(`${item.id === state.selectedPresetId ? '★ ' : ''}${item.name}`, item.id)));
  $('library').value = selectedId;
}
async function reload(id) {
  if (presetAutoSaveIsOn() && dirty) {
    const saved = await flushPendingPresetDraft();
    if (!saved) throw new Error('预设自动保存失败，已保留当前草稿');
  }
  const previousToolMode = $('tool-mode').value;
  state = await api();
  renderProtocolNotice();
  renderPresetLibrary();
  const binding = state.binding ?? {};
  $('enabled').checked = binding.enabled === true;
  $('user').value = binding.values?.user ?? 'User';
  $('char').value = binding.values?.char ?? 'Assistant';
  $('markers').value = JSON.stringify(binding.markers ?? {}, null, 2);
  $('deepseek-beta-prefix').checked = state.deepseekBetaPrefix === true;
  $('prefix-tool-calls').checked = state.prefixToolCalls === true;
  $('prefix-output-extraction').checked = state.prefixOutputExtraction === true;
  $('prefix-nonofficial-remove-tools').checked = state.prefixNonOfficialRemoveTools !== false;
  $('post-tool-prefix-mode').value = state.postToolPrefixMode ?? 'inherit';
  $('post-tool-prefix-text').value = state.postToolPrefixText ?? '';
  renderConnectionChoice();
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

/* ---------- 会话连接：选择会话被路由到的连接（宿主 provider/model） ---------- */

const CONNECTION_PROTOCOL_LABELS = { 'chat-completions': '对话补全接口', messages: 'Messages 接口' };
function connectionProtocolLabel(protocol) {
  return CONNECTION_PROTOCOL_LABELS[protocol] ?? '协议未知';
}
function connectionSelectionState() {
  const selection = state.connectionChoice;
  return selection && typeof selection === 'object' ? selection : null;
}
function connectionChoices() {
  const choices = connectionSelectionState()?.choices;
  return Array.isArray(choices)
    ? choices.filter(choice => choice && typeof choice.provider === 'string' && choice.provider)
    : [];
}
/** 当前会话路由到的连接；宿主没给出信息时不伪造协议。 */
function currentConnectionChoice() {
  const provider = connectionSelectionState()?.provider;
  if (typeof provider !== 'string' || !provider) return null;
  return connectionChoices().find(choice => choice.provider === provider)
    ?? { provider, label: provider, protocol: 'unknown', defaultModel: '' };
}
/** 连接自己声明的协议优先；未知时退回本会话观测到的协议与宿主设置里的连接协议，都不知就是未知。 */
function currentConnectionProtocol() {
  const choice = currentConnectionChoice();
  if (choice && choice.protocol !== 'unknown') return choice.protocol;
  return state.protocol?.protocol ?? state.connection?.protocol ?? 'unknown';
}
function connectionChoiceLabel(choice) {
  return `${choice.label || choice.provider} · ${connectionProtocolLabel(choice.protocol)}`;
}
/** 能切换到的对话补全连接；没有就不给出无法执行的建议。 */
function chatCompletionChoice() {
  if (connectionSelectionState()?.canSwitch !== true) return null;
  return connectionChoices().find(choice => choice.protocol === 'chat-completions') ?? null;
}
/**
 * 顶部选择器：列出宿主提供的连接并标明各自的协议。读不到连接信息或 canSwitch === false 时
 * 禁用控件并说明原因，绝不猜测一个默认连接。
 */
function renderConnectionChoice() {
  const selection = connectionSelectionState();
  const select = $('connection-select');
  const choices = connectionChoices();
  const current = currentConnectionChoice();
  const rows = current && !choices.some(choice => choice.provider === current.provider)
    ? [current, ...choices] : choices;
  const optionFor = choice => {
    const option = document.createElement('option');
    option.value = choice.provider;
    option.textContent = connectionChoiceLabel(choice);
    return option;
  };
  if (current) {
    select.replaceChildren(...rows.map(optionFor));
  } else {
    // 宿主没有给出当前连接时用一个禁用占位项说明，绝不让下拉框停在第 1 个选项上冒充已选。
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = rows.length ? '未读取到当前连接' : '未能从宿主读取连接信息';
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...rows.map(optionFor));
  }
  const canSwitch = selection?.canSwitch === true && rows.length > 0;
  // 切换进行中保留用户刚选中的那一项，不要先弹回旧值再跳过去。
  if (!connectionSwitchSaving) select.value = current ? current.provider : '';
  select.disabled = !canSwitch || connectionSwitchSaving;
  $('connection-name').textContent = current ? `当前：${current.label || current.provider}` : '';
  // 连接声明为 Messages 时预填充设置不适用：整块禁用并说明原因，而不是让它看起来可用。
  const messages = currentConnectionProtocol() === 'messages';
  $('prefill-settings').disabled = messages;
  $('prefill-disabled-note').hidden = !messages;
  if (!selection) {
    $('connection-note').textContent = '未能从宿主读取连接信息：工作台无法列出会话可用的连接，也无法切换。';
    return;
  }
  if (!rows.length) {
    $('connection-note').textContent = selection.canSwitch === true
      ? '未能从宿主读取连接信息：宿主没有返回任何可选连接，无法切换。'
      : '未能从宿主读取连接信息：当前 DSH 未提供 agentDefaultModel 服务，无法切换会话连接。';
    return;
  }
  if (selection.canSwitch !== true) {
    $('connection-note').textContent = '未能从宿主读取连接信息：当前 DSH 未提供 agentDefaultModel 服务，无法切换会话连接。';
    return;
  }
  if (connectionSwitchSaving) {
    $('connection-note').textContent = '正在切换连接…';
    return;
  }
  const protocol = currentConnectionProtocol();
  const protocolText = protocol === 'unknown'
    ? '协议未知（无法确认该连接是否支持对话补全兼容路径）'
    : connectionProtocolLabel(protocol);
  $('connection-note').textContent = current
    ? `当前连接：${current.label || current.provider} · ${protocolText}。切换会改变会话被路由到的连接，立即生效，不需要重启。`
    : '未读取到当前连接。切换会改变会话被路由到的连接，立即生效，不需要重启。';
}
/**
 * 选中即切换：走宿主自己的 provider/model 选择（agentDefaultModel），请求记录、模型能力与
 * 真正执行的适配器因此保持一致。切换中禁用选择器；失败时按服务端已确认的选择回退。
 */
async function selectConnectionChoice(provider) {
  if (connectionSwitchSaving || !provider) return;
  connectionSwitchSaving = true;
  try {
    renderConnectionChoice();
    const result = await api({ action: 'select-connection', provider });
    if (result?.connectionChoice) state.connectionChoice = result.connectionChoice;
    const applied = currentConnectionChoice();
    status(`连接已切换：${applied ? connectionChoiceLabel(applied) : provider}`);
  } catch (error) {
    status(`连接切换失败：${error.message}`, true);
  } finally {
    connectionSwitchSaving = false;
    renderConnectionChoice();
    renderProtocolNotice();
  }
}

/**
 * 协议提示只在用户需要知道时出现，且不涉及插件自身的协议切换方案（该方案的 UI 仍隐藏，
 * 实现保留在 src/lib/messages-translate.mts 与 fetch 桥里，默认不启用）：
 * 1. 没有会话、未启用预设注入、或尚未观测到协议时：不显示任何内容；
 * 2. 连接使用 Messages 协议且预设已启用：说明预设兼容路径不适用，并指向顶部的会话连接选择器。
 */
function protocolNoteList(notes) {
  return Array.isArray(notes) ? notes.filter(note => typeof note === 'string' && note.trim() !== '') : [];
}
function renderProtocolNotice() {
  const box = $('protocol-notice');
  const binding = state.binding ?? {};
  const observation = state.protocol ?? null;
  const currentProtocol = currentConnectionProtocol();
  const notes = currentProtocol === 'messages' ? protocolNoteList(state.protocolNotes) : [];
  const hide = () => { box.hidden = true; box.className = 'notice'; box.replaceChildren(); };
  if (!sessionId || binding.enabled !== true) { hide(); return; }
  if (!currentProtocol && notes.length === 0) { hide(); return; }
  const parts = [];
  if (currentProtocol === 'messages') {
    const head = document.createElement('strong');
    const body = document.createElement('p');
    head.textContent = '当前连接使用 Messages 协议：预设兼容路径不适用';
    const target = chatCompletionChoice();
    body.textContent = '预填充续写、工具调用转换与正文提取只在对话补全接口下生效，插件不会改写该请求。' +
      (target
        ? `如需这些能力，请在页面顶部的“会话连接”里切换到「${target.label || target.provider}」（对话补全接口）。`
        : '如需这些能力，请切换到提供对话补全接口的连接。');
    parts.push(head, body);
  }
  if (notes.length) {
    const head = document.createElement('strong');
    const intro = document.createElement('p');
    head.textContent = 'Messages 协议无法保留的能力';
    intro.textContent = '以下内容不会被转换或恢复：';
    const list = document.createElement('ul');
    for (const note of notes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.append(item);
    }
    parts.push(head, intro, list);
  }
  if (!parts.length) { hide(); return; }
  box.className = 'notice warning';
  box.hidden = false;
  box.replaceChildren(...parts);
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
    input.onchange = markAutoModesDirty;
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
// PTC 程序调用入口：DSH 保留 run_code 作为传输层名称，任何工具策略都不能关闭它，
// 也不能把它从模型工具说明中移除（见 src/lib/tool-presets.mts 的 TOOL_ENTRY_NAME）。
// 面板只展示入口行，不参与开关、批量操作和预设规则生成。
const TOOL_ENTRY_NAME = 'run_code';
const TOOL_ENTRY_NOTE = '程序调用入口（PTC）：始终启用，不受工具策略影响';
const isToolEntry = name => name === TOOL_ENTRY_NAME;
const setToolEnabled = (policy, name, enabled) => {
  if (isToolEntry(name)) return;
  policy[name] = enabled;
};
const compactToolTabs = window.matchMedia?.('(max-width:760px)') ?? { matches: false, addEventListener() {} };

let toolDraft = { key: '', policy: {}, dirty: false };
let toolDraftVersion = 0;
let autoSaveTimer = null;
let autoSaveChain = Promise.resolve();
let autoSaveInFlight = false;
let keepaliveFlushedVersion = -1;
let groupDraft = [];
let groupsDirty = false;
let groupDraftVersion = 0;
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
  for (const tool of toolCatalog(modeId)) policy[tool.name] = isToolEntry(tool.name) ? true : raw?.[tool.name] !== false;
  return policy;
}
function expandToolPreset(preset, modeId) {
  const policy = {};
  for (const tool of toolCatalog(modeId)) policy[tool.name] = isToolEntry(tool.name) ? true : preset.defaultEnabled !== false;
  for (const rule of preset.rules ?? []) {
    if (rule.modeId === modeId && !isToolEntry(rule.toolName)) policy[rule.toolName] = rule.enabled !== false;
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
function toolJournalKey(key = toolDraft.key) {
  return 'dsh-preset-enhance.pending-tools:' + (key.startsWith('session:') ? sessionId + ':' : '') + key;
}
function journalToolDraft() {
  if (autoSaveIsOn() && toolDraft.dirty) storageSet(toolJournalKey(), JSON.stringify(toolDraft.policy));
}
function acknowledgeToolDraft(key, policy) {
  const storageKey = toolJournalKey(key);
  if (storageGet(storageKey, '') === JSON.stringify(policy)) {
    try { localStorage.removeItem(storageKey); } catch { /* keep the draft for recovery */ }
  }
}
function loadToolDraft(force) {
  const { sessionScope, modeId } = toolContext();
  const key = `${sessionScope ? 'session' : 'mode'}:${modeId}`;
  if (force && toolDraft.dirty && toolDraft.key === key) {
    // 保留尚未保存的草稿：无关的 reload()（保存预设、保存接口设置等）不得丢弃用户的开关改动。
  } else if (force || toolDraft.key !== key) {
    toolDraft = { key, policy: effectiveToolPolicy(modeId, sessionScope), dirty: false };
    const pending = storageGet(toolJournalKey(key), '');
    if (pending) {
      try {
        const policy = JSON.parse(pending);
        if (policy && typeof policy === 'object' && !Array.isArray(policy) &&
            Object.values(policy).every(value => typeof value === 'boolean')) {
          toolDraft = { key, policy, dirty: true };
          toolDraftVersion++;
          scheduleAutoSave();
        }
      } catch { /* ignore malformed browser storage */ }
    }
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
  journalToolDraft();
  status('工具开关草稿尚未保存');
  scheduleAutoSave();
}
function markGroupsDirty() {
  groupsDirty = true;
  groupDraftVersion++;
  status('工具分组草稿尚未保存');
  scheduleGlobalConfigAutoSave();
}
function presetDiscardOkay() {
  return !dirty || confirm('放弃尚未保存的预设草稿？');
}
function toolDiscardOkay() {
  if (!toolDraft.dirty) return true;
  if (!confirm('放弃尚未保存的工具开关草稿？')) return false;
  acknowledgeToolDraft(toolDraft.key, toolDraft.policy);
  resetToolDraft();
  return true;
}
function groupDiscardOkay() {
  if (!groupsDirty) return true;
  if (!confirm('放弃尚未保存的工具分组草稿？')) return false;
  resetGroupDraft();
  return true;
}

/* ---------- 预设自动保存（浏览器本地开关，默认关闭） ---------- */
function presetAutoSaveIsOn() {
  return $('preset-auto-save').checked === true;
}
function cancelPresetAutoSave() {
  if (presetAutoSaveTimer !== null) {
    clearTimeout(presetAutoSaveTimer);
    presetAutoSaveTimer = null;
  }
}
function schedulePresetAutoSave() {
  if (!presetAutoSaveIsOn()) return;
  cancelPresetAutoSave();
  presetAutoSaveTimer = setTimeout(() => {
    presetAutoSaveTimer = null;
    void runPresetAutoSave();
  }, PRESET_AUTO_SAVE_DELAY);
}
async function persistPresetDraft({ force = false } = {}) {
  if (!dirty && !force) return { ok: true, skipped: true };
  const generation = presetDraftGeneration;
  const version = presetDraftVersion;
  const recordId = selectedId;
  const name = $('name').value;
  const document = structuredClone(preset);
  const send = () => api({ action: 'save', id: recordId, name, preset: document });
  let result;
  try {
    result = await send();
  } catch (error) {
    if (!isRevisionConflict(error)) return { ok: false, error };
    try {
      const latest = await api();
      state.revision = latest.revision;
      result = await send();
    } catch (retryError) {
      return { ok: false, error: retryError };
    }
  }

  state.revision += 1;
  const savedId = result.id;
  const existingIndex = state.presets.findIndex(item => item.id === savedId);
  const existing = existingIndex >= 0 ? state.presets[existingIndex] : undefined;
  const savedRecord = { ...existing, id: savedId, name: String(name || '未命名预设').slice(0, 200), preset: document };
  if (existingIndex >= 0) state.presets[existingIndex] = savedRecord;
  else state.presets.push(savedRecord);
  state.selectedPresetId = savedId;
  state.defaultPresetId = savedId;
  state.modeDefaultPresetId = savedId;
  state.modeDefaultName = savedRecord.name;

  const sameDraft = presetDraftGeneration === generation && selectedId === recordId;
  if (sameDraft) {
    if (!recordId) selectedId = savedId;
    if (presetDraftVersion === version) {
      dirty = false;
    } else {
      schedulePresetAutoSave();
    }
    renderPresetLibrary();
    updateDefaultButton();
    updateSessionNote();
    if (!dirty) void refreshPrefillWarning();
  }
  return { ok: true, id: savedId, version, saved: document };
}
function runPresetAutoSave() {
  presetAutoSaveChain = presetAutoSaveChain.then(async () => {
    const result = await persistPresetDraft();
    if (result.ok) {
      if (!result.skipped && !dirty) status('预设已自动保存');
    } else {
      status(`预设自动保存失败：${result.error.message}（草稿仍保留，可继续编辑或点击“保存预设”）`, true);
    }
    return result;
  }).catch(error => {
    status(`预设自动保存失败：${error.message}（草稿仍保留）`, true);
    return { ok: false, error };
  });
  return presetAutoSaveChain;
}
async function flushPendingPresetDraft() {
  if (!presetAutoSaveIsOn() || !dirty) return true;
  cancelPresetAutoSave();
  await runPresetAutoSave();
  return !dirty;
}
async function presetDraftReady() {
  if (!dirty) return true;
  if (presetAutoSaveIsOn()) return flushPendingPresetDraft();
  return presetDiscardOkay();
}

function markPrefillSettingsDirty() {
  prefillSettingsDirty = true;
  prefillSettingsVersion++;
  status('预填充接口设置尚未保存');
  scheduleGlobalConfigAutoSave();
}
function markAutoModesDirty() {
  autoModesDirty = true;
  autoModesVersion++;
  status('自动启用模式列表尚未保存');
  scheduleGlobalConfigAutoSave();
}
function markBindingDirty() {
  if (!sessionId) return;
  bindingDirty = true;
  bindingVersion++;
  status('当前会话设置尚未应用');
  scheduleGlobalConfigAutoSave();
}
function cancelGlobalConfigAutoSave() {
  if (globalConfigAutoSaveTimer !== null) {
    clearTimeout(globalConfigAutoSaveTimer);
    globalConfigAutoSaveTimer = null;
  }
}
function scheduleGlobalConfigAutoSave() {
  if (!presetAutoSaveIsOn()) return;
  cancelGlobalConfigAutoSave();
  globalConfigAutoSaveTimer = setTimeout(() => {
    globalConfigAutoSaveTimer = null;
    void runGlobalConfigAutoSave();
  }, GLOBAL_CONFIG_AUTO_SAVE_DELAY);
}
async function configWrite(payload) {
  try {
    return await api(payload);
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    const latest = await api();
    state.revision = latest.revision;
    return api(payload);
  }
}
function acceptRevision(result) {
  state.revision = Number.isInteger(result?.revision) ? Math.max(state.revision, result.revision) : state.revision + 1;
}
function toolGroupsPayload() {
  return groupDraft.map(group => ({
    id: group.id,
    name: group.name ?? '',
    description: group.description ?? '',
    order: Number(group.order) || 0,
    members: (group.members ?? []).map(member => ({ modeId: member.modeId, toolName: member.toolName })),
  }));
}
async function persistPrefillSettingsDraft() {
  if (!prefillSettingsDirty) return false;
  const version = prefillSettingsVersion;
  if ($('prefill-settings').disabled) return false;
  if (dirty) {
    const saved = await runPresetAutoSave();
    if (!saved?.ok) throw saved?.error ?? new Error('预设保存失败');
  }
  const payload = prefillSettingsPayload();
  const result = await configWrite(payload);
  acceptRevision(result);
  state.deepseekBetaPrefix = result.enabled === true;
  state.prefixToolCalls = result.toolCalls === true;
  state.prefixOutputExtraction = result.extractOutput === true;
  state.prefixNonOfficialRemoveTools = result.removeNonOfficialTools !== false;
  state.postToolPrefixMode = payload.postToolPrefixMode;
  state.postToolPrefixText = payload.postToolPrefixText;
  if (prefillSettingsVersion === version) prefillSettingsDirty = false;
  else scheduleGlobalConfigAutoSave();
  return true;
}
async function persistAutoModesDraft() {
  if (!autoModesDirty) return false;
  const version = autoModesVersion;
  const modes = [...$('auto-mode-list').querySelectorAll('input[data-mode]:checked')].map(input => input.dataset.mode);
  const result = await configWrite({ action: 'save-auto-modes', modes });
  acceptRevision(result);
  state.autoEnableModes = result.modes;
  if (autoModesVersion === version) autoModesDirty = false;
  else scheduleGlobalConfigAutoSave();
  return true;
}
async function persistGroupDraft() {
  if (!groupsDirty) return false;
  const version = groupDraftVersion;
  const groups = toolGroupsPayload();
  const result = await configWrite({ action: 'save-tool-groups', groups });
  acceptRevision(result);
  state.toolGroups = structuredClone(result.groups ?? groups);
  if (groupDraftVersion === version) groupsDirty = false;
  else scheduleGlobalConfigAutoSave();
  return true;
}
async function persistBindingDraft() {
  if (!bindingDirty || !sessionId) return false;
  const version = bindingVersion;
  const binding = { enabled: $('enabled').checked, presetId: selectedId, ...options() };
  const result = await configWrite({ action: 'bind', sessionId, binding });
  acceptRevision(result);
  state.binding = structuredClone(binding);
  if (bindingVersion === version) bindingDirty = false;
  else scheduleGlobalConfigAutoSave();
  return true;
}
function runGlobalConfigAutoSave() {
  globalConfigAutoSaveChain = globalConfigAutoSaveChain.then(async () => {
    if (!presetAutoSaveIsOn()) return false;
    if (dirty) {
      cancelPresetAutoSave();
      const saved = await runPresetAutoSave();
      if (!saved?.ok) throw saved?.error ?? new Error('预设自动保存失败');
    }
    if (toolDraft.dirty) {
      cancelAutoSave();
      const saved = await runAutoSave();
      if (!saved?.ok) throw saved?.error ?? new Error('工具开关自动保存失败');
    }
    const saved = [
      await persistPrefillSettingsDraft(),
      await persistAutoModesDraft(),
      await persistGroupDraft(),
      await persistBindingDraft(),
    ].some(Boolean);
    if (saved) status('全部配置已自动保存');
    return saved;
  }).catch(error => {
    status(`全局自动保存失败：${error.message}（改动仍保留）`, true);
    return false;
  });
  return globalConfigAutoSaveChain;
}

/* ---------- 工具开关自动保存（可关闭；关闭时行为与手工保存完全一致） ---------- */
function autoSaveIsOn() {
  return presetAutoSaveIsOn() || $('tool-auto-save').checked === true;
}
function autoSaveNote() {
  return presetAutoSaveIsOn()
    ? '全局自动保存已开启：工具开关与分组改动会自动保存。'
    : autoSaveIsOn()
      ? '已单独开启工具开关自动保存；分组改动仍需“保存分组”。'
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
  journalToolDraft();
  let result;
  try {
    result = await send();
  } catch (error) {
    if (!isRevisionConflict(error)) return { ok: false, error };
    try {
      const latest = await api();
      state.revision = latest.revision;
      result = await send();
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
  acknowledgeToolDraft(key, policy);
  acceptRevision(result);
  return { ok: true, scope, modeId };
}
function runAutoSave() {
  autoSaveChain = autoSaveChain.then(async () => {
    autoSaveInFlight = true;
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
// 失败时保留本地草稿；新页面用最新 revision 续存，旧请求的回执不能清除更新的草稿。
function flushToolDraftKeepalive() {
  if (!autoSaveIsOn() || !toolDraft.dirty) return 0;
  journalToolDraft();
  cancelAutoSave();
  if (autoSaveInFlight) return 0;
  if (keepaliveFlushedVersion === toolDraftVersion) return 0;
  const scope = toolView.sessionScope ? 'session' : 'mode';
  const modeId = toolView.modeId;
  if (!modeId || (scope === 'session' && !sessionId)) return 0;
  const version = toolDraftVersion;
  const key = toolDraft.key;
  keepaliveFlushedVersion = version;
  const policy = { ...toolDraft.policy };
  // Keep the revision in sync even though this request is fire-and-forget: without it a
  // second hide/close in the same page lifetime would post the pre-flush revision and be
  // rejected as stale.
  void api(toolSaveRequest(scope, modeId, policy), { keepalive: true })
    .then(result => {
      acceptRevision(result);
      acknowledgeToolDraft(key, policy);
      if (toolDraft.key === key && toolDraftVersion === version) toolDraft.dirty = false;
    })
    .catch(() => {
      if (keepaliveFlushedVersion === version) keepaliveFlushedVersion = -1;
      scheduleAutoSave();
    });
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
  const mcpTabs = [];
  const mcpClaimed = new Set();
  for (const group of state.mcpToolGroups?.[modeId] ?? []) {
    const tools = [...new Set((group.tools ?? []).filter(name => known.has(name)))];
    if (!tools.length) continue;
    for (const name of tools) mcpClaimed.add(name);
    const names = mcpTabNames(group.serverName);
    mcpTabs.push({
      id: '@mcp:' + group.serverName,
      name: names.display,
      fullName: names.full,
      tools,
    });
  }
  tabs.push({
    id: '@ungrouped',
    name: '未分组',
    tools: names.filter(name => !claimed.has(name) && !mcpClaimed.has(name)),
  });
  return [...tabs, ...mcpTabs, ...userTabs];
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
  return tab.tools.filter(name => isToolEntry(name) || toolDraft.policy[name] !== false).length;
}
function toolTabLabel(tab, full = false) {
  return `${full ? tab.fullName ?? tab.name : tab.name} · ${toolGroupEnabledCount(tab)}/${tab.tools.length}`;
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
    button.title = toolTabLabel(tab, true);
    button.setAttribute('aria-label', button.title);
    button.append(label);
    button.onclick = () => activateToolGroup(tab.id);
    return button;
  }));
  $('tool-group-select-wrap').hidden = !collapsed;
  $('tool-group-select').replaceChildren(...tabs.map(tab => new Option(toolTabLabel(tab, true), tab.id)));
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
    if (selected) {
      if (focus) button.focus();
      button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
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
    for (const name of tab.tools) setToolEnabled(toolDraft.policy, name, toggle.checked);
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
    const entry = isToolEntry(name);
    const label = document.createElement('label');
    label.className = entry ? 'check-entry locked' : 'check-entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.tool = name;
    input.checked = entry ? true : toolDraft.policy[name] !== false;
    input.disabled = entry;
    input.onchange = () => {
      if (entry) return;
      toolDraft.policy[name] = input.checked;
      markToolDirty();
      updateToolGroupSummary(panel);
      refreshToolTabLabels();
    };
    const text = document.createElement('span');
    text.textContent = name;
    const small = document.createElement('small');
    small.textContent = entry ? TOOL_ENTRY_NOTE : descriptions.get(name) ?? '无描述';
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
    if (button) {
      button.title = toolTabLabel(tab, true);
      button.setAttribute('aria-label', button.title);
    }
    const option = [...$('tool-group-select').options].find(item => item.value === tab.id);
    if (option) option.textContent = toolTabLabel(tab, true);
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
    for (const name of tab.tools) setToolEnabled(toolDraft.policy, name, true);
  } else if (op === 'all-off') {
    for (const name of tab.tools) setToolEnabled(toolDraft.policy, name, false);
  } else if (op === 'only') {
    for (const tool of toolCatalog(modeId)) setToolEnabled(toolDraft.policy, tool.name, false);
    for (const name of tab.tools) setToolEnabled(toolDraft.policy, name, true);
  } else if (op === 'restore') {
    const reference = restoreToolReference();
    if (!reference) return;
    for (const name of tab.tools) setToolEnabled(toolDraft.policy, name, reference[name] !== false);
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
  const used = [{
    item: { identifier: DSH_SYSTEM_PROMPT_TEMPLATE_ID, enabled: preset.dsh_system_prompt_enabled !== false },
    prompt: dshSystemPromptTemplate(),
  }, ...order().map(item => ({
    item,
    prompt: preset.prompts.find(prompt => prompt.identifier === item.identifier),
  })).filter(entry => entry.prompt)];
  const unused = preset.prompts.filter(prompt => prompt.identifier !== DSH_SYSTEM_PROMPT_TEMPLATE_ID &&
    !listed.has(prompt.identifier)).map(prompt => ({ prompt }));
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
  const fixed = isDshSystemPromptTemplate(prompt);
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
  button.dataset.promptId = prompt.identifier;
  button.textContent = fixed ? 'DSH 系统提示词 · 内置模板' :
    `${prompt.name ?? prompt.identifier} · ${prompt.marker ? '标记' : prompt.role ?? 'system'}`;
  button.onclick = () => {
    selectedPrompt = prompt.identifier;
    renderList();
    renderEditor();
  };
  const membership = document.createElement('button');
  membership.className = 'membership';
  membership.type = 'button';
  membership.textContent = used ? '移出' : '加入';
  membership.disabled = fixed || prompt.identifier === 'chatHistory';
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
  if (isDshSystemPromptTemplate(id)) {
    preset.dsh_system_prompt_enabled = enabled;
    markDirty();
    return;
  }
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
  if (id === 'chatHistory' || isDshSystemPromptTemplate(id)) return;
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
  const fixed = isDshSystemPromptTemplate(prompt);
  const used = fixed || !!item;
  $('prompt-name').value = prompt.name ?? '';
  $('role').value = prompt.role ?? 'system';
  $('position').value = prompt.injection_position ?? 0;
  $('depth').value = prompt.injection_depth ?? 4;
  $('priority').value = prompt.injection_order ?? 100;
  const chatHistory = prompt.identifier === 'chatHistory';
  $('content').value = chatHistory ? '此内容从当前聊天记录读取' : prompt.content ?? '';
  for (const id of ['prompt-name', 'role', 'position', 'depth', 'priority']) $(id).disabled = fixed;
  $('content').disabled = fixed || !!prompt.marker;
  $('prompt-enabled').checked = fixed ? preset.dsh_system_prompt_enabled !== false : item?.enabled ?? false;
  $('prompt-enabled').disabled = !used;
  $('up').disabled = fixed || !used;
  $('down').disabled = fixed || !used;
  $('marker-note').textContent = fixed ?
    '内置模板：控制其他 DSH 模式启用此预设时是否保留该模式的系统提示词；正文从当前模式动态读取，只可开关。' : prompt.marker ?
    `标记 ${prompt.identifier}：chatHistory 展开真实会话；其他标记在下方 JSON 中填写。` :
    `${prompt.identifier}${used ? '' : ' · 当前为闲置条目，加入顺序表后才会参与注入'}`;
}

for (const [id, key, numeric] of [
  ['prompt-name', 'name'], ['role', 'role'], ['position', 'injection_position', true],
  ['depth', 'injection_depth', true], ['priority', 'injection_order', true], ['content', 'content'],
]) {
  $(id).oninput = () => {
    if (!current() || isDshSystemPromptTemplate(selectedPrompt)) return;
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
  markPrefillSettingsDirty();
};
$('post-tool-prefix-text').oninput = markPrefillSettingsDirty;
$('deepseek-beta-prefix').onchange = markPrefillSettingsDirty;
// 选中即切换：走宿主自己的 provider/model 选择，立即生效。
// 不参与自动保存，也不触碰未保存的工具开关/分组草稿。
$('connection-select').onchange = () => {
  void selectConnectionChoice($('connection-select').value);
};
$('prefix-tool-calls').onchange = () => {
  syncPrefixToolControls();
  markPrefillSettingsDirty();
};
$('prefix-output-extraction').onchange = () => {
  if ($('prefix-output-extraction').checked) insertOutputExtractionTemplate();
  markPrefillSettingsDirty();
};
$('prefix-nonofficial-remove-tools').onchange = markPrefillSettingsDirty;
for (const id of ['user', 'char', 'markers']) $(id).oninput = markBindingDirty;
$('enabled').onchange = markBindingDirty;
function insertOutputExtractionTemplate() {
  const identifier = 'dsh-output-extraction-template';
  let prompt = preset.prompts.find(item => item.identifier === identifier);
  if (!prompt) {
    prompt = {
      identifier,
      name: '正文/工具调用提取格式（实验）',
      role: 'user',
      content: state.outputExtractionTemplate ?? '',
      injection_position: 0,
    };
    preset.prompts.push(prompt);
  }
  const items = order();
  const oldIndex = items.findIndex(item => item.identifier === identifier);
  if (oldIndex >= 0) items.splice(oldIndex, 1);
  const historyIndex = items.findIndex(item => item.identifier === 'chatHistory');
  const tail = items.findLastIndex(item => item.enabled !== false &&
    ['assistant', 'model'].includes(preset.prompts.find(prompt => prompt.identifier === item.identifier)?.role));
  items.splice(historyIndex >= 0 ? historyIndex + 1 : tail >= 0 ? tail : items.length, 0, { identifier, enabled: true });
  selectedPrompt = identifier;
  markDirty();
  renderList();
  renderEditor();
  status('已将格式提示词加入当前预设，可在条目中编辑；保存接口设置时一并保存');
}
/**
 * A prefill preset ends on an assistant turn, so the next request continues from what the
 * model already wrote - exactly the case output extraction exists for. Importing one while
 * extraction is enabled adds the format prompt (the caller then saves it) instead of leaving
 * the user to flip the switch and save by hand.
 */
function ensurePrefillExtractionTemplate() {
  if (state.prefixOutputExtraction !== true) return false;
  if (preset.prompts.some(item => item.identifier === 'dsh-output-extraction-template')) return false;
  const items = order();
  const lastEnabled = items.findLast(item => item.enabled !== false);
  const role = preset.prompts.find(prompt => prompt.identifier === lastEnabled?.identifier)?.role;
  if (!['assistant', 'model'].includes(role)) return false;
  insertOutputExtractionTemplate();
  return true;
}
/** Clear the import notice: a fresh import must not leave the previous one on screen. */
function hidePresetNotice() {
  const box = $('preset-notice');
  box.hidden = true;
  box.dataset.kind = '';
  box.replaceChildren();
}

/**
 * Tell the user the import added the extraction format prompt. The entry appears in their list
 * without them asking for it, so say why it is there and that it is theirs to edit or remove.
 */
function showImportedExtractionNotice() {
  const box = $('preset-notice');
  const title = document.createElement('strong');
  title.textContent = '已自动加入正文提取格式提示词';
  const text = document.createElement('p');
  text.textContent = '导入的是预填充预设（最后一条是 Assistant 回复），且正文提取已开启，因此自动加入了「正文/工具调用提取格式（实验）」条目并已保存；可在提示词条目中编辑或删除。';
  const dismiss = document.createElement('button');
  dismiss.textContent = '知道了';
  dismiss.onclick = () => hidePresetNotice();
  box.className = 'notice';
  box.dataset.kind = 'import-extraction';
  box.hidden = false;
  box.replaceChildren(title, text, dismiss);
}

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

async function discardOkay() {
  return await presetDraftReady() && toolDiscardOkay() && groupDiscardOkay();
}
$('new').onclick = guard(async () => {
  // 新建提示词预设与工具配置无关：只确认提示词草稿，工具/分组草稿继续保留。
  if (!(await presetDraftReady())) return;
  loadDraft('');
});
$('library').onchange = guard(async () => {
  const id = $('library').value;
  if (!(await discardOkay())) {
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
  if (await presetDraftReady()) await reload(selectedId);
});
$('delete-preset').onclick = guard(async () => {
  if (!selectedId) throw new Error('请选择要删除的已保存预设');
  if (!(await presetDraftReady())) return;
  const record = state.presets.find(item => item.id === selectedId);
  if (!record || !confirm('确定删除预设“' + record.name + '”？此操作无法撤销。')) return;
  const result = await api({ action: 'delete-preset', id: selectedId });
  await reload(result.id ?? '');
  status('预设已删除');
});
$('import').onchange = guard(async () => {
  const file = $('import').files[0];
  if (!file || !(await discardOkay())) return;
  hidePresetNotice();
  try {
    if (file.size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
    const parsed = JSON.parse(await file.text());
    const name = file.name.replace(/(?:\.dsh-preset)?\.json$/i, '');
    const result = await api({ action: 'import', name, document: parsed });
    await reload(result.id);
    // Add the extraction format prompt for an imported prefill preset, and persist it: the
    // import already saved the preset, so leaving the addition as an unsaved draft would drop
    // it whenever auto-save is off.
    const autoExtraction = ensurePrefillExtractionTemplate();
    if (autoExtraction) {
      const saved = await persistPresetDraft({ force: true });
      if (!saved.ok) throw saved.error;
      await reload(saved.id ?? result.id);
      showImportedExtractionNotice();
    }
    const imported = parsed.format === 'dsh-preset-enhance' ? '预设包已导入并设为当前默认；全局接口设置保持原值' : '预设已导入、全局保存并设为当前默认';
    status(autoExtraction ? imported + '；已检测到预填充预设并自动加入正文提取格式提示词' : imported);
  } finally {
    $('import').value = '';
  }
});
$('save').onclick = guard(async () => {
  cancelPresetAutoSave();
  await presetAutoSaveChain;
  const result = await persistPresetDraft({ force: !presetAutoSaveIsOn() });
  if (!result.ok) throw result.error;
  if (result.skipped) {
    status('预设已保存');
    return;
  }
  await reload(result.id);
  status('预设已保存');
});
$('mode-default').onclick = guard(async () => {
  if (!(await presetDraftReady())) return;
  await api({ action: 'set-default', id: selectedId });
  await reload(selectedId);
  status('已设为当前默认注入预设');
});
$('bind').disabled = !sessionId;
$('bind').onclick = guard(async () => {
  if (!(await presetDraftReady())) return;
  await api({
    action: 'bind',
    sessionId,
    binding: { enabled: $('enabled').checked, presetId: selectedId, ...options() },
  });
  await reload(selectedId);
  status('会话设置已应用，下一次请求生效');
});
$('apply-package-prefill').onclick = guard(async () => {
  if (!(await presetDraftReady())) return;
  await api({ action: 'apply-package-prefill', id: selectedId });
  await reload(selectedId);
  status('包内接口设置已应用到全局，下一次请求生效');
});
function prefillSettingsPayload() {
  return {
    action: 'save-deepseek-beta',
    presetId: selectedId,
    postToolPrefixMode: $('post-tool-prefix-mode').value,
    postToolPrefixText: $('post-tool-prefix-text').value,
    enabled: $('deepseek-beta-prefix').checked,
    toolCalls: $('prefix-tool-calls').checked,
    extractOutput: $('prefix-output-extraction').checked,
    removeNonOfficialTools: $('prefix-nonofficial-remove-tools').checked,
  };
}
$('save-deepseek-beta').onclick = guard(async () => {
  if ($('prefill-settings').disabled) return;
  if (dirty) {
    cancelPresetAutoSave();
    const saved = await runPresetAutoSave();
    if (!saved?.ok) throw saved?.error ?? new Error('预设保存失败');
  }
  const result = await api(prefillSettingsPayload());
  acceptRevision(result);
  prefillSettingsDirty = false;
  await reload(selectedId);
  status('预填充接口设置已保存');
});
$('save-auto-modes').onclick = guard(async () => {
  const modes = [...$('auto-mode-list').querySelectorAll('input[data-mode]:checked')].map(input => input.dataset.mode);
  const result = await api({ action: 'save-auto-modes', modes });
  acceptRevision(result);
  autoModesDirty = false;
  await reload(selectedId);
  status('自动启用模式列表已保存，仅影响之后新建的会话');
});
$('refresh-tools').onclick = guard(async () => {
  if (!(await presetDraftReady())) return;
  await reload(selectedId);
  const { modeId } = toolContext();
  const groups = state.mcpToolGroups?.[modeId] ?? [];
  const toolCount = groups.reduce((sum, group) => sum + (group.tools?.length ?? 0), 0);
  status('工具列表已刷新：' + groups.length + ' 个 MCP 服务，' + toolCount + ' 个 MCP 工具');
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
    .filter(tool => !isToolEntry(tool.name) && policy[tool.name] === false)
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
    for (const tool of toolCatalog(toolView.modeId)) setToolEnabled(toolDraft.policy, tool.name, checked);
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
  toolDraft.dirty = true;
  const saved = await runAutoSave();
  if (!saved?.ok) throw saved?.error ?? new Error('工具开关保存失败');
  if (scope === 'mode') storageSet(TOOL_LAST_MODE_KEY, modeId);
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
$('preset-auto-save').onchange = () => {
  const enabled = $('preset-auto-save').checked;
  storageSet(PRESET_AUTO_SAVE_KEY, enabled ? '1' : '0');
  $('tool-auto-save').disabled = enabled;
  if (enabled) {
    status('已开启全局自动保存');
    if (dirty) schedulePresetAutoSave();
    if (toolDraft.dirty) scheduleAutoSave();
    if (groupsDirty || prefillSettingsDirty || autoModesDirty || bindingDirty) scheduleGlobalConfigAutoSave();
  } else {
    cancelPresetAutoSave();
    cancelGlobalConfigAutoSave();
    if (!$('tool-auto-save').checked) cancelAutoSave();
    status('已关闭全局自动保存，改动需要使用各区域的保存按钮');
  }
  renderToolPanel();
};
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
  const groups = toolGroupsPayload();
  const result = await api({ action: 'save-tool-groups', groups });
  acceptRevision(result);
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

$('preset-auto-save').checked = storageGet(PRESET_AUTO_SAVE_KEY, '0') === '1';
$('tool-auto-save').checked = storageGet(TOOL_AUTO_SAVE_KEY, '0') === '1';
$('tool-auto-save').disabled = presetAutoSaveIsOn();
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
  else void refreshConnectionState();
});
async function refreshConnectionState() {
  if (connectionSwitchSaving) return;
  try {
    const latest = await api();
    state.connectionChoice = latest.connectionChoice;
    state.protocol = latest.protocol;
    state.protocolNotes = latest.protocolNotes;
    renderConnectionChoice();
    renderProtocolNotice();
  } catch { /* keep the last confirmed state while disconnected */ }
}
window.addEventListener('focus', () => { void refreshConnectionState(); });
await guard(() => reload())();
