type PickerData = {
  revision: number; sessionReady: boolean; mode: string; presetId: string | null; explicit: boolean; enabled: boolean;
  startupError?: string;
  presets: { id: string; name: string }[];
  preview: { id: string; prefix: boolean; prefixText: string; entries: {
    name: string; role: string; enabled: boolean; marker: boolean; dynamic: boolean; depth: number | null; text: string;
  }[] } | null;
};
const query = new URLSearchParams(location.search);
const sessionId = query.get('sessionId') ?? '';
let modeId = query.get('modeId') ?? '';
const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = field<HTMLInputElement>('search');
const list = field<HTMLSelectElement>('presets');
const apply = field<HTMLButtonElement>('apply');
const inherit = field<HTMLButtonElement>('inherit');
const status = field<HTMLParagraphElement>('status');
const preview = field<HTMLElement>('preview');
field<HTMLAnchorElement>('workbench').href = '/preset-enhance?' + new URLSearchParams({ sessionId, modeId });
let snapshot: PickerData | undefined;
let candidate = '';
let saving = false;
let request: AbortController | undefined;

function renderList() {
  const filter = search.value.trim().toLocaleLowerCase();
  list.replaceChildren(...(snapshot?.presets ?? []).filter(row => row.name.toLocaleLowerCase().includes(filter))
    .map(row => new Option(row.name, row.id)));
  list.value = candidate;
}
function updateButtons() {
  const ready = !saving && !request && snapshot?.sessionReady;
  apply.disabled = !ready || !candidate || (snapshot?.explicit === true && snapshot.enabled && snapshot.presetId === candidate);
  inherit.disabled = !ready || !snapshot?.explicit;
}
function renderPreview(data: PickerData) {
  const active = data.presets.find(row => row.id === data.presetId);
  field('current').textContent = [
    data.mode, active?.name ?? '未选择预设',
    data.explicit ? '本会话' : '默认', data.enabled ? '注入已开启' : '注入已关闭',
  ].filter(Boolean).join(' · ');
  preview.replaceChildren();
  if (!data.preview) return;
  if (data.preview.prefix) preview.append(Object.assign(document.createElement('p'), { textContent: '包含助手预填充' }));
  const entries = [...data.preview.entries];
  if (data.preview.prefixText) entries.push({
    name: '助手预填充', role: 'assistant', enabled: true, marker: false, dynamic: false, depth: null, text: data.preview.prefixText,
  });
  for (const entry of entries) {
    const details = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = entry.name;
    const meta = document.createElement('small');
    meta.textContent = [entry.role, entry.enabled ? '启用' : '停用', entry.dynamic ? '动态模板' : entry.marker ? '标记' : '',
      entry.depth === null ? '' : '深度 ' + entry.depth].filter(Boolean).join(' · ');
    const text = document.createElement('pre');
    text.textContent = entry.text || (entry.marker ? '运行时读取' : '空正文');
    details.append(title, meta, text);
    preview.append(details);
  }
}
async function load(selected?: string) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  updateButtons();
  const params = new URLSearchParams({ picker: '', sessionId, modeId, ...(selected ? { presetId: selected } : {}) });
  try {
    const res = await fetch('/preset-enhance/api?' + params, { signal: controller.signal });
    const data = await res.json() as PickerData;
    if (!res.ok || data.startupError) throw Error(data.startupError || '无法读取预设');
    if (request !== controller) return;
    snapshot = data;
    candidate = data.preview?.id ?? data.presetId ?? '';
    renderList();
    renderPreview(data);
  } catch (error) {
    if (request === controller) status.textContent = (error as Error).message;
  } finally {
    if (request === controller) { request = undefined; updateButtons(); }
  }
}
function save(presetId: string | null) {
  if (!snapshot?.sessionReady || saving) return;
  saving = true;
  status.textContent = '正在应用…';
  updateButtons();
  window.parent.postMessage({ type: 'preset-enhance:picker-save', revision: snapshot.revision, presetId }, location.origin);
}
search.oninput = renderList;
list.onchange = () => { if (list.value) void load(list.value); };
apply.onclick = () => save(candidate);
inherit.onclick = () => save(null);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  const data = event.data;
  if (data?.type === 'preset-enhance:input-mode' && typeof data.modeId === 'string' && data.modeId !== modeId) {
    modeId = data.modeId;
    void load();
  } else if (data?.type === 'preset-enhance:picker-result') {
    saving = false;
    status.textContent = data.error || '已应用';
    void load(data.error ? candidate : undefined);
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !saving) void load(candidate); });
void load();
export {};
