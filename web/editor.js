const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId') ?? '';
let state = { presets: [], revision: 0 }, selectedId = '', selectedPrompt = '', dirty = false;
let preset = blank();
function blank() { return { prompts: [{ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] }; }
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function updateDefaultButton() {
  const active = !!selectedId && selectedId === state.modeDefaultPresetId;
  $('mode-default').textContent = active ? '模式默认 ✓' : '设为模式默认';
  $('mode-default').disabled = !selectedId || dirty || active;
}
function updateSessionNote() {
  const chosen = state.modeDefaultName ? `“${state.modeDefaultName}”` : '尚未设置';
  if (!sessionId) $('session-note').textContent = `侧边栏工作台 · 预设模式的新对话默认使用：${chosen}`;
  else if (state.presetMode) $('session-note').textContent = `当前对话处于预设模式 · 新对话默认使用：${chosen}`;
  else $('session-note').textContent = `当前会话：${sessionId} · 会话启用设置仅作用于当前对话`;
}
function markDirty() { dirty = true; status('草稿未保存'); updateDefaultButton(); }
async function api(body) {
  const res = await fetch(`/preset-enhance/api?sessionId=${encodeURIComponent(sessionId)}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: state.revision, ...body }) } : {});
  const result = await res.json(); if (!res.ok) throw new Error(result.error ?? '请求失败'); return result;
}
function guard(fn) { return async () => { try { await fn(); } catch (e) { status(e.message, true); } }; }
function order() { return preset.prompt_order.find(g => String(g.character_id) === $('order').value)?.order ?? []; }
function current() { return preset.prompts.find(p => p.identifier === selectedPrompt); }
function options() { return { characterId: $('order').value, values: { user: $('user').value, char: $('char').value }, markers: JSON.parse($('markers').value) }; }
function ensureGroups() {
  if (!preset.prompt_order?.length) preset.prompt_order = [{ character_id: 100001, order: preset.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false })) }];
}
function loadDraft(id) {
  selectedId = id; const record = state.presets.find(p => p.id === id);
  preset = structuredClone(record?.preset ?? blank()); ensureGroups();
  $('name').value = record?.name ?? '新预设'; $('library').value = id;
  $('order').replaceChildren(...preset.prompt_order.map(g => new Option(String(g.character_id), String(g.character_id))));
  const binding = state.binding ?? {};
  $('order').value = String(binding.presetId === id && binding.characterId != null ? binding.characterId : preset.prompt_order.find(g => String(g.character_id) === '100001')?.character_id ?? preset.prompt_order[0].character_id);
  $('prefill').value = preset.assistant_prefill ?? '';
  selectedPrompt = order()[0]?.identifier ?? preset.prompts[0]?.identifier ?? ''; dirty = false; renderList(); renderEditor(); updateDefaultButton();
}
async function reload(id) {
  state = await api();
  $('library').replaceChildren(new Option('新预设', ''), ...state.presets.map(p => new Option(`${p.id === state.modeDefaultPresetId ? '★ ' : ''}${p.name}`, p.id)));
  const b = state.binding ?? {};
  $('enabled').checked = b.enabled === true; $('user').value = b.values?.user ?? 'User'; $('char').value = b.values?.char ?? 'Assistant'; $('markers').value = JSON.stringify(b.markers ?? {}, null, 2);
  loadDraft(id ?? b.presetId ?? state.modeDefaultPresetId ?? ''); updateSessionNote(); status('已加载');
}
function renderList() {
  const term = $('search').value.toLowerCase(), listed = new Set(order().map(p => p.identifier));
  const used = order().map(item => ({ item, prompt: preset.prompts.find(p => p.identifier === item.identifier) })).filter(x => x.prompt);
  const unused = preset.prompts.filter(p => !listed.has(p.identifier)).map(prompt => ({ prompt }));
  $('used-count').textContent = `${used.length} 项`; $('unused-count').textContent = `${unused.length} 项`;
  $('used-prompts').replaceChildren(); $('unused-prompts').replaceChildren();
  for (const entry of used) renderPromptItem(entry.prompt, entry.item, true, term, $('used-prompts'));
  for (const entry of unused) renderPromptItem(entry.prompt, null, false, term, $('unused-prompts'));
}
function renderPromptItem(p, item, used, term, parent) {
  if (!`${p.name ?? ''} ${p.identifier} ${p.content ?? ''}`.toLowerCase().includes(term)) return;
  const div = document.createElement('div');
  div.className = `item ${used ? (item.enabled ? '' : 'off') : 'unused'} ${selectedPrompt === p.identifier ? 'active' : ''}`;
  if (used) {
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = item.enabled;
    toggle.setAttribute('aria-label', `启用 ${p.name ?? p.identifier}`);
    toggle.onchange = () => { setEnabled(p.identifier, toggle.checked); renderList(); renderEditor(); };
    div.append(toggle);
  }
  const button = document.createElement('button'); button.className = 'entry';
  button.textContent = `${p.name ?? p.identifier} · ${p.marker ? '标记' : p.role ?? 'system'}`;
  button.onclick = () => { selectedPrompt = p.identifier; renderList(); renderEditor(); };
  const membership = document.createElement('button'); membership.className = 'membership'; membership.type = 'button';
  membership.textContent = used ? '移出' : '加入'; membership.disabled = p.identifier === 'chatHistory';
  membership.setAttribute('aria-label', `${used ? '移出顺序表' : '加入顺序表'} ${p.name ?? p.identifier}`);
  membership.onclick = () => { used ? removeFromOrder(p.identifier) : addToOrder(p.identifier); renderList(); renderEditor(); };
  div.append(button, membership); parent.append(div);
}
function setEnabled(id, enabled) {
  const item = order().find(p => p.identifier === id);
  if (!item) return;
  item.enabled = enabled; markDirty();
}
function addToOrder(id) {
  if (order().some(item => item.identifier === id)) return;
  const marker = order().findIndex(item => item.identifier === 'chatHistory');
  order().splice(marker < 0 ? order().length : marker, 0, { identifier: id, enabled: true }); markDirty();
}
function removeFromOrder(id) {
  if (id === 'chatHistory') return;
  const index = order().findIndex(item => item.identifier === id);
  if (index >= 0) { order().splice(index, 1); markDirty(); }
}
function renderEditor() {
  const p = current(); $('editor').hidden = !p; $('empty').hidden = !!p; if (!p) return;
  const item = order().find(x => x.identifier === p.identifier), used = !!item;
  $('prompt-name').value = p.name ?? ''; $('role').value = p.role ?? 'system'; $('position').value = p.injection_position ?? 0;
  $('depth').value = p.injection_depth ?? 4; $('priority').value = p.injection_order ?? 100; $('content').value = p.content ?? '';
  $('content').disabled = !!p.marker; $('prompt-enabled').checked = item?.enabled ?? false; $('prompt-enabled').disabled = !used;
  $('up').disabled = !used; $('down').disabled = !used;
  $('marker-note').textContent = p.marker ? `标记 ${p.identifier}：chatHistory 展开真实会话；其他标记在下方 JSON 中填写。` :
    `${p.identifier}${used ? '' : ' · 当前为闲置条目，加入顺序表后才会参与注入'}`;
}
for (const [id, key, numeric] of [['prompt-name', 'name'], ['role', 'role'], ['position', 'injection_position', true], ['depth', 'injection_depth', true], ['priority', 'injection_order', true], ['content', 'content']]) {
  $(id).oninput = () => { if (!current()) return; current()[key] = numeric ? Number($(id).value) : $(id).value; markDirty(); if (id === 'prompt-name' || id === 'role') renderList(); };
}
$('prompt-enabled').onchange = () => { setEnabled(selectedPrompt, $('prompt-enabled').checked); renderList(); };
$('order').onchange = () => { selectedPrompt = order()[0]?.identifier ?? ''; renderList(); renderEditor(); };
$('search').oninput = renderList; $('name').oninput = markDirty;
$('prefill').oninput = () => { preset.assistant_prefill = $('prefill').value; markDirty(); };
for (const [id, delta] of [['up', -1], ['down', 1]]) $(id).onclick = () => {
  const items = order(), index = items.findIndex(p => p.identifier === selectedPrompt), target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]]; markDirty(); renderList();
};
$('add').onclick = () => {
  selectedPrompt = crypto.randomUUID(); preset.prompts.push({ identifier: selectedPrompt, name: '新提示词', role: 'system', content: '', injection_position: 0 });
  order().splice(Math.max(0, order().findIndex(p => p.identifier === 'chatHistory')), 0, { identifier: selectedPrompt, enabled: true }); markDirty(); renderList(); renderEditor();
};
function discardOkay() { return !dirty || confirm('放弃尚未保存的预设草稿？'); }
$('new').onclick = () => { if (discardOkay()) loadDraft(''); };
$('library').onchange = () => { if (discardOkay()) loadDraft($('library').value); else $('library').value = selectedId; };
$('reload').onclick = guard(async () => { if (discardOkay()) await reload(selectedId); });
$('import').onchange = guard(async () => {
  const file = $('import').files[0]; if (!file || !discardOkay()) return;
  if (file.size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
  const parsed = JSON.parse(await file.text()); if (!Array.isArray(parsed.prompts)) throw new Error('文件不是 SillyTavern 提示词预设');
  loadDraft(''); preset = parsed; ensureGroups(); $('name').value = file.name.replace(/\.json$/i, '');
  $('order').replaceChildren(...preset.prompt_order.map(g => new Option(String(g.character_id), String(g.character_id))));
  $('order').value = String(preset.prompt_order.find(g => String(g.character_id) === '100001')?.character_id ?? preset.prompt_order[0].character_id);
  $('prefill').value = preset.assistant_prefill ?? ''; selectedPrompt = order()[0]?.identifier ?? ''; markDirty(); renderList(); renderEditor(); $('import').value = '';
});
$('save').onclick = guard(async () => {
  const result = await api({ action: 'save', id: selectedId, name: $('name').value, preset });
  await reload(result.id); status('预设已保存');
});
$('mode-default').onclick = guard(async () => {
  if (dirty) throw new Error('请先保存预设草稿');
  await api({ action: 'set-default', id: selectedId });
  await reload(selectedId); status('已设为预设模式的新对话默认值');
});
$('bind').disabled = !sessionId;
$('bind').onclick = guard(async () => {
  if (dirty) throw new Error('请先保存预设草稿');
  await api({ action: 'bind', sessionId, binding: { enabled: $('enabled').checked, presetId: selectedId, ...options() } });
  await reload(selectedId); status('会话设置已应用，下一次请求生效');
});
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${$('name').value || 'preset'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function show(result) {
  $('warnings').textContent = result.warnings.join('\n'); $('output').replaceChildren();
  for (const m of result.messages) {
    const box = document.createElement('div'); box.className = 'message';
    const label = document.createElement('b'); label.textContent = `${m.role} · ${m.source?.plugin === 'dsh-preset-enhance' ? '预设注入' : '会话消息'}`;
    const pre = document.createElement('pre'); pre.textContent = m.content.map(b => b.type === 'text' ? b.text : `[${b.type}]`).join('\n'); box.append(label, pre); $('output').append(box);
  }
  status(`已解析 ${result.messages.length} 条消息 · ${result.warnings.length} 项提示`);
}
$('preview').onclick = guard(async () => show(await api({ action: 'preview', sessionId, preset, input: $('input').value, options: options() })));
$('last').onclick = guard(async () => { const s = await api(); if (!s.last) throw new Error('当前会话还没有实际注入记录'); show(s.last.result); });
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
await guard(() => reload())();
