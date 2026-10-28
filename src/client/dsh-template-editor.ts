import { createMacroContext, renderMacros } from '../lib/macros.mjs';
import { dshTemplateSource, dshTemplateParts } from '../lib/dsh-template-source.mjs';
import type { DshSystemTemplate, DshSectionTemplates, DshSectionOverride } from '../lib/dsh-system-template.mjs';

interface Document {
  dsh_system_prompt_templates?: Record<string, string>;
  dsh_system_prompt_sections?: DshSectionTemplates;
}
interface Options {
  preset: Document;
  info?: DshSystemTemplate;
  mode: string;
  changed(): void;
  refresh(): void;
}
const titles: Record<string, string> = { 'harness:identity': '身份', 'deployment:persona-prefix': '模式提示词',
  'deployment:persona-suffix': '模式后缀', 'tools:sdk': '工具 SDK', 'plan:policy': '计划规则' };
function own<T extends object>(object: T, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, configurable: true, enumerable: true, writable: true });
}
function details(key: string, title: string): HTMLDetailsElement {
  const node = document.createElement('details'), summary = document.createElement('summary');
  node.className = 'dsh-section'; summary.textContent = title; node.append(summary);
  const storageKey = 'dsh-preset-enhance:disclosure:dsh-section:' + key;
  try { node.open = localStorage.getItem(storageKey) === '1'; } catch {}
  node.ontoggle = event => { if (event.target === node) try { localStorage.setItem(storageKey, node.open ? '1' : '0'); } catch {} };
  return node;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = action; return node;
}

export function renderDshSections({ preset, info, mode, changed, refresh }: Options): void {
  const root = document.getElementById('dsh-template-sections');
  if (!root) return;
  root.replaceChildren();
  if (!info?.available) return;
  const legacy = Object.hasOwn(preset.dsh_system_prompt_templates ?? {}, mode);
  const toolbar = document.createElement('div'); toolbar.className = 'row';
  toolbar.append(button(legacy ? '改为分段编辑' : '编辑整篇', () => {
    if (legacy) {
      if (!confirm('切换为分段编辑将移除当前模式的整篇修改，继续？')) return;
      delete preset.dsh_system_prompt_templates![mode];
    } else {
      preset.dsh_system_prompt_templates ??= {};
      own(preset.dsh_system_prompt_templates, mode, dshTemplateSource(preset, info));
    }
    changed(); refresh();
  }));
  root.append(toolbar);
  const preview = details(mode + ':preview', '完整组装预览'), output = document.createElement('pre');
  let previewDirty = true;
  function updatePreview() {
    previewDirty = true;
    if (!preview.open) return;
    try {
      const context = createMacroContext({ values: info!.values, seed: 'dsh-template-preview' });
      output.textContent = dshTemplateParts(preset, info!).map(part => renderMacros(part, context)).filter(Boolean).join('\n\n');
    }
    catch (error) { output.textContent = String(error); }
    previewDirty = false;
  }
  const rememberPreview = preview.ontoggle;
  preview.ontoggle = event => { rememberPreview?.call(preview, event); if (preview.open && previewDirty) updatePreview(); };
  if (!legacy) {
    const overrides = preset.dsh_system_prompt_sections?.[mode] ?? {};
    const active = new Set(info.sections.map(section => section.name));
    const names = [...active, ...Object.keys(overrides).filter(name => !active.has(name))];
    for (const name of names) {
      const source = info.sections.find(section => section.name === name), saved = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
      const panel = details(mode + ':' + name, (titles[name] ?? name) + (source ? '' : ' · 来源不可用'));
      const row = document.createElement('div'); row.className = 'row';
      const select = document.createElement('select'); select.setAttribute('aria-label', name + ' 状态');
      for (const [value, title] of [['default', '跟随默认'], ['custom', '自定义'], ['disabled', '禁用']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option);
      }
      select.value = saved?.mode ?? 'default';
      const editor = document.createElement('textarea'); editor.rows = 7; editor.spellcheck = false;
      editor.setAttribute('aria-label', name + ' 正文'); editor.value = saved?.mode === 'custom' ? saved.template : source?.template ?? '';
      editor.hidden = select.value !== 'custom'; editor.disabled = !source;
      const original = document.createElement('pre'); original.textContent = source?.text ?? '段落来源暂未加载';
      original.hidden = select.value === 'custom';
      const write = (value?: DshSectionOverride) => {
        preset.dsh_system_prompt_sections ??= {};
        if (!Object.hasOwn(preset.dsh_system_prompt_sections, mode)) own(preset.dsh_system_prompt_sections, mode, {});
        const saved = preset.dsh_system_prompt_sections[mode];
        if (value) own(saved, name, value); else delete saved[name];
        if (!Object.keys(saved).length) delete preset.dsh_system_prompt_sections[mode];
        changed(); updatePreview();
      };
      select.disabled = !source;
      select.onchange = () => {
        editor.hidden = select.value !== 'custom'; original.hidden = select.value === 'custom';
        write(select.value === 'custom' ? { mode: 'custom', template: editor.value } : select.value === 'disabled' ? { mode: 'disabled' } : undefined);
      };
      editor.oninput = () => { if (source && select.value === 'custom') write({ mode: 'custom', template: editor.value }); };
      row.append(select, button('恢复默认', () => { write(); refresh(); }));
      panel.append(row, editor, original); root.append(panel);
    }
  }
  updatePreview(); preview.append(output); root.append(preview);
  const context = details(mode + ':context', '运行环境上下文（只读）'), text = document.createElement('pre');
  text.textContent = (info.contexts ?? []).filter(item => item.text).map(item => item.name + '\n' + item.text).join('\n\n') || '暂无运行环境上下文';
  context.append(text); root.append(context);
}
