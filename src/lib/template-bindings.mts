import { createHash, randomUUID } from 'node:crypto';
import type { PromptTemplateV1, TemplateCatalogSnapshot } from '../template-api.mjs';
import type { SillyTavernPreset, PresetPrompt, PromptOrderEntry } from './types.mjs';

const NS = 'dsh-preset-enhance';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function templateBindings(preset: SillyTavernPreset): Record<string, any> {
  const extensions = preset.extensions;
  const raw = object(extensions) && object(extensions[NS]) ? extensions[NS].templateBindings : undefined;
  if (raw === undefined) return {};
  if (!object(raw)) throw new Error('templateBindings 必须为对象');
  return raw;
}
export const templateFingerprint = (template: PromptTemplateV1) => createHash('sha256').update(JSON.stringify(template)).digest('hex');
export function templateCatalogWithFingerprints(catalog: TemplateCatalogSnapshot) {
  return { ...catalog, fingerprints: catalog.providers.flatMap(provider => provider.templates.map(template => ({
    providerId: provider.providerId, templateId: template.id, templateVersion: template.version,
    fingerprint: templateFingerprint(template),
  }))) };
}
function find(catalog: TemplateCatalogSnapshot | undefined, ref: Record<string, any>) {
  return catalog?.providers.find(provider => provider.providerId === ref.providerId)?.templates
    .find(template => template.id === ref.templateId && template.version === ref.templateVersion);
}
const markerTarget = (prompt: PresetPrompt) => prompt.marker === true &&
  !['chatHistory', 'dsh-preset-enhance:dsh-system-prompt'].includes(prompt.identifier);

/** Resolve only into a request copy. Unavailable linked text must never fall back to its snapshot. */
export function resolveTemplateBindings(preset: SillyTavernPreset, catalog?: TemplateCatalogSnapshot, activeIds?: Set<string>) {
  const bindings = templateBindings(preset);
  const warnings: string[] = [];
  const references: Array<{ identifier: string; fingerprint: string | null; reason: string }> = [];
  const missing = new Set<string>();
  const prompts = preset.prompts.map(prompt => {
    if (!Object.hasOwn(bindings, prompt.identifier)) return prompt;
    const ref = bindings[prompt.identifier];
    const template = object(ref) ? find(catalog, ref) : undefined;
    const fingerprint = template ? templateFingerprint(template) : null;
    const marker = object(ref) && ref.target === 'marker';
    const reason = !object(ref) || ref.mode !== 'linked' || prompt.identifier === 'chatHistory' || prompt.identifier === 'dsh-preset-enhance:dsh-system-prompt' ||
      (marker ? !markerTarget(prompt) : !!prompt.marker) ||
      (template?.targetMarker !== undefined && (!marker || template.targetMarker !== prompt.identifier))
      ? '模板关联无效'
      : !template ? '提供者或锁定版本不可用'
      : ref.fingerprint !== fingerprint ? '同版本内容已变化，请查看并重新接受'
      : '';
    if (!activeIds || activeIds.has(prompt.identifier)) {
      references.push({ identifier: prompt.identifier, fingerprint, reason });
      if (reason) warnings.push(`插件模板「${prompt.name ?? prompt.identifier}」已跳过：${reason}`);
    }
    if (reason) { missing.add(prompt.identifier); return prompt; }
    return { ...prompt, role: marker ? prompt.role : template!.role, content: template!.content, ...(marker ? { marker: false } : {}) };
  });
  // Keep placeholders in the order table so missing templates do not produce duplicate warnings.
  return {
    preset: { ...preset, prompts: prompts.map(prompt => missing.has(prompt.identifier)
      ? { ...prompt, content: '', marker: false } : prompt) },
    warnings, references,
  };
}

export interface TemplateSelection {
  operation: 'add' | 'update' | 'detach' | 'bind-marker';
  identifier?: string;
  providerId?: string;
  templateId?: string;
  templateVersion?: string;
  expectedFingerprint?: string;
  characterId?: string | number | null;
}

/** Edit an unsaved draft; the caller retains responsibility for revision-aware saving. */
export function selectTemplate(source: SillyTavernPreset, catalog: TemplateCatalogSnapshot, selection: TemplateSelection, locks: string[] = []) {
  const preset = structuredClone(source);
  const extensions = preset.extensions;
  if (extensions !== undefined && !object(extensions)) throw new Error('extensions 必须为对象');
  const ext = (preset.extensions ??= {}) as Record<string, any>;
  if (ext[NS] !== undefined && !object(ext[NS])) throw new Error('预设插件扩展必须为对象');
  const settings = ext[NS] ??= {};
  const bindings = templateBindings(preset);
  settings.templateBindings = bindings;
  if (!['add', 'update', 'detach', 'bind-marker'].includes(selection.operation)) throw new Error('模板操作无效');
  let prompt = preset.prompts.find(item => item.identifier === selection.identifier);
  const previous = prompt && Object.hasOwn(bindings, prompt.identifier) ? bindings[prompt.identifier] : undefined;
  if (selection.operation === 'bind-marker') {
    if (!prompt || !markerTarget(prompt)) throw new Error('请选择可关联的酒馆 marker 条目');
    if (locks.includes(prompt.identifier)) throw new Error('条目已锁定，请先解锁');
    if (previous) throw new Error('条目已有关联，请更新版本或先解除关联');
  }
  if (selection.operation === 'update' || selection.operation === 'detach') {
    if (!prompt || !previous) throw new Error('关联模板条目不存在');
    if (locks.includes(prompt.identifier)) throw new Error('条目已锁定，请先解锁');
    if (selection.operation === 'detach') {
      delete bindings[prompt.identifier];
      return { preset, identifier: prompt.identifier, changed: true };
    }
    if (previous.providerId !== selection.providerId || previous.templateId !== selection.templateId) {
      throw new Error('更新只能选择同一提供者、同一模板的版本');
    }
  }
  const template = find(catalog, selection);
  if (!template) throw new Error('提供者或所选模板版本不可用，请刷新目录');
  const fingerprint = templateFingerprint(template);
  if (selection.expectedFingerprint !== fingerprint) throw new Error('目录已变化，请刷新并重新查看模板');
  const marker = selection.operation === 'bind-marker' || previous?.target === 'marker';
  if (marker && (!prompt || !markerTarget(prompt))) throw new Error('marker 条目已改变，请解除关联后重新选择');
  if (template.targetMarker !== undefined && (!marker || template.targetMarker !== prompt?.identifier)) throw new Error('模板仅适用于指定 marker');
  if (marker) {
    Object.defineProperty(bindings, prompt!.identifier, { enumerable: true, configurable: true, writable: true, value: {
      mode: 'linked', target: 'marker', providerId: selection.providerId, templateId: selection.templateId,
      templateVersion: template.version, fingerprint, contentSnapshot: template.content,
    } });
    return { preset, identifier: prompt!.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
  }
  if (selection.operation === 'add') {
    prompt = preset.prompts.find(item => {
      const ref = Object.hasOwn(bindings, item.identifier) ? bindings[item.identifier] : undefined;
      return ref?.providerId === selection.providerId && ref.templateId === selection.templateId && ref.templateVersion === selection.templateVersion;
    });
    if (prompt && locks.includes(prompt.identifier)) throw new Error('条目已锁定，请先解锁');
  }
  const existing = !!prompt;
  if (!prompt) {
    prompt = { identifier: `plugin-template:${randomUUID()}`, name: template.title, role: template.role, content: template.content,
      injection_position: template.defaults?.placement === 'depth' ? 1 : 0,
      ...(template.defaults?.placement === 'depth' ? { injection_depth: template.defaults.depth, injection_order: template.defaults.order ?? 100 } : {}),
    };
    preset.prompts.push(prompt);
  }
  if (selection.operation === 'update' || !existing) {
    prompt.role = template.role;
    prompt.content = template.content;
    Object.defineProperty(bindings, prompt.identifier, { enumerable: true, configurable: true, writable: true, value: {
      ...(object(previous) ? previous : {}), mode: 'linked', providerId: selection.providerId,
      templateId: selection.templateId, templateVersion: template.version, fingerprint,
    } });
  }
  if (selection.operation === 'add') {
    if (!preset.prompt_order?.length) preset.prompt_order = [{ character_id: selection.characterId ?? 100001,
      order: source.prompts.map(item => ({ identifier: item.identifier, enabled: item.enabled !== false })) }];
    const group = selection.characterId == null
      ? preset.prompt_order.find(item => String(item.character_id) === '100001') ?? preset.prompt_order[0]
      : preset.prompt_order.find(item => String(item.character_id) === String(selection.characterId));
    if (!group) throw new Error('所选顺序表不存在');
    if (!group.order.some(item => item.identifier === prompt!.identifier)) {
      const item: PromptOrderEntry = { identifier: prompt.identifier, enabled: true };
      let history = group.order.findIndex(entry => entry.identifier === 'chatHistory');
      if (template.defaults?.placement === 'afterHistory') {
        if (history < 0) {
          if (!preset.prompts.some(entry => entry.identifier === 'chatHistory')) preset.prompts.push({ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' });
          group.order.push({ identifier: 'chatHistory', enabled: true });
        } else if (!group.order[history].enabled) throw new Error('请先启用当前顺序表的 chatHistory，再添加历史之后的模板');
        group.order.push(item);
      } else group.order.splice(history < 0 ? group.order.length : history, 0, item);
    }
  }
  return { preset, identifier: prompt.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
}
