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
  $('status').textContent = text;
  $('status').className = error ? 'error' : '';
}
function updateDefaultButton() {
  const active = !!selectedId && selectedId === state.selectedPresetId;
  $('mode-default').textContent = active ? '当前默认 ✓' : '设为当前默认';
  $('mode-default').disabled = !selectedId || dirty || active;
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
async function api(body) {
  const res = await fetch(`/preset-enhance/api?sessionId=${encodeURIComponent(sessionId)}`, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, ...body }),
  } : {});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? '请求失败');
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
  $('prefix-relay-url').value = state.prefixRelayUrl ?? '';
  renderAutoModes();
  renderToolModes(previousToolMode);
  loadDraft(id ?? state.selectedPresetId ?? binding.presetId ?? '');
  updateSessionNote();
  status('已加载');
}

async function refreshPrefillWarning() {
  const recordId = selectedId;
  try {
    const result = await api({ action: 'preview', sessionId, preset, input: '预填充检测', options: options() });
    if (recordId !== selectedId) return;
    const active = result.assistantPrefix?.active === true;
    $('prefill-warning').hidden = !active;
    if (!active) return;
    $('prefill-warning-text').textContent = state.deepseekBetaPrefix === true ?
      state.prefixRelayUrl ?
        `此预设的最终注入消息是 assistant，属于预填充续写。预填充自动兼容已开启：命中 ${state.prefixRelayUrl} 的请求只做最小改写并保留工具原样发送。` :
        '此预设的最终注入消息是 assistant，属于预填充续写。预填充自动兼容已开启：官方地址会移除工具字段，非官方接口按中转方式保留工具。' :
      '此预设的最终注入消息是 assistant，属于预填充续写。请使用支持 assistant prefix 的接口；可在下方开启预填充自动兼容，或填写自定义中转地址。';
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
function renderToolModes(previous) {
  const modes = (state.agentModes ?? []).filter(mode => !mode.broken);
  $('tool-mode').replaceChildren(...modes.map(mode => new Option(mode.name, mode.id)));
  const preferred = previous && modes.some(mode => mode.id === previous) ? previous :
    state.sessionMode && modes.some(mode => mode.id === state.sessionMode) ? state.sessionMode :
      modes.find(mode => mode.id === 'st-preset')?.id ?? modes[0]?.id ?? '';
  $('tool-mode').value = preferred;
  renderToolPanel();
}
function renderToolPanel() {
  const sessionScope = $('tool-scope').value === 'session';
  $('tool-mode').disabled = sessionScope;
  if (sessionScope && state.sessionMode) $('tool-mode').value = state.sessionMode;
  const modeId = sessionScope ? state.sessionMode : $('tool-mode').value;
  const inherited = state.modeToolPolicies?.[modeId] ?? {};
  const own = sessionScope ? state.sessionToolPolicy : null;
  const policy = own ?? inherited;
  const catalog = state.toolCatalogs?.[modeId] ?? [];
  const catalogError = state.toolCatalogErrors?.[modeId];
  $('inherit-tools').hidden = !sessionScope;
  $('inherit-tools').disabled = !sessionId || own === null;
  $('save-tools').disabled = sessionScope && !sessionId || !modeId || catalog.length === 0;
  $('tool-note').textContent = !modeId ? '当前会话没有可识别的 DSH 模式。' :
    catalog.length === 0 ? `${modeName(modeId)} 尚无工具目录；打开该模式的会话后即可配置。` :
      sessionScope ? own === null ? `当前会话继承 ${modeName(modeId)} 的模式默认，共 ${catalog.length} 个工具。` :
        `当前会话正在使用独立覆盖，共 ${catalog.length} 个工具；保存后下一次请求生效。` :
        `${modeName(modeId)} 的模式默认工具策略，共 ${catalog.length} 个。`;
  $('tool-list').replaceChildren();
  for (const tool of catalog) {
    const label = document.createElement('label');
    label.className = 'check-entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.tool = tool.name;
    input.checked = policy[tool.name] !== false;
    const text = document.createElement('span');
    text.textContent = tool.name;
    const small = document.createElement('small');
    small.textContent = tool.description || '无描述';
    text.append(small);
    label.append(input, text);
    $('tool-list').append(label);
  }
}
function collectToolPolicy() {
  const policy = {};
  for (const input of $('tool-list').querySelectorAll('input[data-tool]')) policy[input.dataset.tool] = input.checked;
  return policy;
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
$('deepseek-beta-prefix').onchange = () => status('预填充接口设置尚未保存');
$('prefix-relay-url').oninput = () => status('预填充接口设置尚未保存');
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
  return !dirty || confirm('放弃尚未保存的预设草稿？');
}
$('new').onclick = () => { if (discardOkay()) loadDraft(''); };
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
$('reload').onclick = guard(async () => { if (discardOkay()) await reload(selectedId); });
$('import').onchange = guard(async () => {
  const file = $('import').files[0];
  if (!file || !discardOkay()) return;
  try {
    if (file.size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.prompts)) throw new Error('文件不是 SillyTavern 提示词预设');
    const name = file.name.replace(/\.json$/i, '');
    const result = await api({ action: 'save', id: '', name, preset: parsed });
    await reload(result.id);
    status('预设已导入、全局保存并设为当前默认');
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
$('save-deepseek-beta').onclick = guard(async () => {
  await api({
    action: 'save-deepseek-beta',
    enabled: $('deepseek-beta-prefix').checked,
    relayUrl: $('prefix-relay-url').value,
  });
  await reload(selectedId);
  const relay = $('prefix-relay-url').value.trim();
  status(`预填充接口设置已保存${relay ? `（中转：${relay}）` : '（中转留空，非官方接口自动按中转处理）'}`);
});
$('save-auto-modes').onclick = guard(async () => {
  const modes = [...$('auto-mode-list').querySelectorAll('input[data-mode]:checked')].map(input => input.dataset.mode);
  await api({ action: 'save-auto-modes', modes });
  await reload(selectedId);
  status('自动启用模式列表已保存，仅影响之后新建的会话');
});
$('tool-scope').onchange = renderToolPanel;
$('tool-mode').onchange = renderToolPanel;
for (const [id, checked] of [['select-all-tools', true], ['clear-all-tools', false]]) {
  $(id).onclick = () => {
    for (const input of $('tool-list').querySelectorAll('input[data-tool]')) input.checked = checked;
  };
}
$('save-tools').onclick = guard(async () => {
  const policy = collectToolPolicy();
  if ($('tool-scope').value === 'session') {
    await api({ action: 'save-session-tools', sessionId, policy });
    await reload(selectedId);
    status('当前会话工具已更新，下一次请求生效');
  } else {
    await api({ action: 'save-mode-tools', modeId: $('tool-mode').value, policy });
    await reload(selectedId);
    status('模式默认工具已保存，该模式会话的下一次请求生效');
  }
});
$('inherit-tools').onclick = guard(async () => {
  await api({ action: 'save-session-tools', sessionId, inherit: true });
  await reload(selectedId);
  status('当前会话已恢复继承模式默认工具');
});
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${$('name').value || 'preset'}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
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

$('tool-scope').value = sessionId ? 'session' : 'mode';
window.addEventListener('beforeunload', event => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
await guard(() => reload())();
