import { createMacroContext, renderMacros, seededRandom } from './macros.mjs';
import type {
  AssistantPrefix, CompiledEntry, CompiledPreset, CompilePresetOptions, HostMessage,
  PresetPrompt, PromptOrderEntry, SillyTavernPreset,
} from './types.mjs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const PRESET_ROLES: readonly string[] = ['system', 'user', 'assistant', 'model'];

/**
 * Validate untrusted preset JSON (file import, share package, editor save) and
 * return it unchanged. Validation is intentionally structural: unknown fields
 * survive, only the fields the compiler relies on are checked.
 */
export function validatePreset(preset: unknown): SillyTavernPreset {
  if (!isRecord(preset) || !Array.isArray(preset.prompts) || preset.prompts.length > 2000) throw new Error('预设必须包含 prompts 数组（最多 2000 项）');
  if (preset.dsh_system_prompt_enabled != null && typeof preset.dsh_system_prompt_enabled !== 'boolean') {
    throw new Error('dsh_system_prompt_enabled 必须是布尔值');
  }
  const ids = new Set<string>();
  for (const p of preset.prompts as unknown[]) {
    if (!isRecord(p) || typeof p.identifier !== 'string' || !p.identifier || ids.has(p.identifier)) throw new Error('提示词 identifier 缺失或重复');
    ids.add(p.identifier);
    if (p.content != null && typeof p.content !== 'string') throw new Error('content 必须是文本');
    if (p.role != null && !PRESET_ROLES.includes(p.role as string)) throw new Error(`不支持的角色：${String(p.role)}`);
    if (p.injection_position != null && ![0, 1].includes(p.injection_position as number)) throw new Error('injection_position 必须是 0 或 1');
    if (p.injection_depth != null && (!Number.isInteger(p.injection_depth) || (p.injection_depth as number) < 0)) throw new Error('injection_depth 必须是非负整数');
    if (p.injection_order != null && !Number.isInteger(p.injection_order)) throw new Error('injection_order 必须是整数');
    if (p.injection_trigger != null && !Array.isArray(p.injection_trigger)) throw new Error('injection_trigger 必须是数组');
  }
  if (preset.prompt_order != null && !Array.isArray(preset.prompt_order)) throw new Error('prompt_order 必须是数组');
  for (const group of (preset.prompt_order ?? []) as unknown[]) {
    if (!isRecord(group) || !Array.isArray(group.order)) throw new Error('顺序表缺少 order 数组');
    const seen = new Set<string>();
    for (const p of group.order as unknown[]) {
      if (!isRecord(p) || typeof p.identifier !== 'string' || seen.has(p.identifier) || typeof p.enabled !== 'boolean') throw new Error('顺序表条目无效或重复');
      seen.add(p.identifier);
    }
  }
  return preset as SillyTavernPreset;
}

/** Existing presets keep DSH's mode prompt unless the user explicitly disables it. */
export function dshSystemPromptEnabled(preset: SillyTavernPreset | null | undefined): boolean {
  return preset?.dsh_system_prompt_enabled !== false;
}

export function getOrder(preset: SillyTavernPreset, characterId?: string | number | null): PromptOrderEntry[] {
  const groups = preset.prompt_order ?? [];
  const chosen = characterId == null ? groups.find(x => String(x.character_id) === '100001') ?? groups[0]
    : groups.find(x => String(x.character_id) === String(characterId));
  if (characterId != null && !chosen) throw new Error('所选 prompt_order 不存在');
  return chosen?.order ?? preset.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
}

interface DepthEntry { message: HostMessage; depth: number; order: number }

function textOf(message: HostMessage | undefined): string {
  return message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
}

/** Compile only preset text; history, attachments and tool blocks pass through intact. */
export function compilePreset(preset: SillyTavernPreset, history: HostMessage[] = [], options: CompilePresetOptions = {}): CompiledPreset {
  validatePreset(preset);
  const last = (role: 'user' | 'assistant') => textOf(history.findLast(m => m.role === role && (role !== 'user' || m.source?.kind !== 'tool')));
  const ctx = createMacroContext({ local: options.local, global: options.global,
    random: seededRandom(options.seed ?? 'preview'), values: {
      user: 'User', char: 'Assistant', lastusermessage: last('user'), lastcharmessage: last('assistant'),
      lastmessage: textOf(history.at(-1)), ...options.values,
    } });
  const before: HostMessage[] = [], after: HostMessage[] = [], depthEntries: DepthEntry[] = [], entries: CompiledEntry[] = [];
  let hasHistory = false;
  const byId = new Map<string, PresetPrompt>(preset.prompts.map(p => [p.identifier, p] as [string, PresetPrompt]));
  for (const item of getOrder(preset, options.characterId)) {
    if (!item.enabled) continue;
    const p = byId.get(item.identifier);
    if (!p) { ctx.warnings.push(`顺序表引用了不存在的提示词：${item.identifier}`); continue; }
    if (p.identifier === 'chatHistory') { hasHistory = true; continue; }
    const trigger = p.injection_trigger;
    if (trigger?.length && !trigger.includes(options.trigger ?? 'normal')) continue;
    let content = p.content ?? '';
    if (p.marker) {
      content = options.markers?.[p.identifier] ?? '';
      if (!content) { ctx.warnings.push(`未提供标记内容：${p.identifier}`); continue; }
    }
    const rendered = renderMacros(content, ctx);
    entries.push({ identifier: p.identifier, name: p.name ?? p.identifier, role: p.role ?? 'system', text: rendered });
    if (!rendered.trim()) continue;
    const role = p.role === 'model' ? 'assistant' : p.role ?? 'system';
    const message: HostMessage = { id: `preset:${options.seed ?? 'preview'}:${p.identifier}`, role,
      content: [{ type: 'text', text: rendered }], source: { kind: 'plugin', plugin: 'dsh-preset-enhance' } };
    if (p.injection_position === 1) depthEntries.push({ message, depth: p.injection_depth ?? 4, order: p.injection_order ?? 100 });
    else (hasHistory ? after : before).push(message);
  }
  // Depth is counted from original history, never from already inserted prompts.
  const buckets = new Map<number, HostMessage[]>();
  for (const entry of depthEntries.sort((a, b) => a.order - b.order)) {
    let index = Math.max(0, history.length - entry.depth);
    // Never split a tool-call from its results (possibly multiple tool calls).
    if (history[index]?.source?.kind === 'tool' || history[index]?.content?.some(b => b.type === 'tool-result')) {
      while (index > 0 && history[index - 1]?.role !== 'assistant') index--;
      if (index > 0) index--;
      ctx.warnings.push('深度注入已移到工具调用之前，以保留调用/结果配对');
    }
    const bucket = buckets.get(index) ?? []; bucket.push(entry.message); buckets.set(index, bucket);
  }
  const messages = [...before];
  for (let i = 0; i <= history.length; i++) { messages.push(...(buckets.get(i) ?? [])); if (i < history.length) messages.push(history[i]); }
  messages.push(...after);
  if (preset.assistant_prefill) {
    const text = renderMacros(preset.assistant_prefill, ctx);
    if (text.trim()) messages.push({ id: `preset:${options.seed ?? 'preview'}:prefill`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-preset-enhance' } });
  }
  let tail = messages.at(-1);
  const lastHistory = history.at(-1);
  const afterTool = lastHistory?.role === 'tool' || lastHistory?.source?.kind === 'tool' ||
    lastHistory?.content?.some(block => block.type === 'tool-result');
  if (afterTool && typeof options.postToolPrefix === 'string' && options.postToolPrefix.trim() &&
      tail?.role === 'assistant' && tail.source?.plugin === 'dsh-preset-enhance') {
    const text = renderMacros(options.postToolPrefix, ctx);
    // An empty custom template falls back to the preset's existing prefix.
    if (text.trim()) {
      const prefixed: HostMessage = { ...tail, content: [{ type: 'text', text }] };
      tail = prefixed;
      messages[messages.length - 1] = prefixed;
    }
  }
  const assistantPrefix: AssistantPrefix = tail?.role === 'assistant' && tail.source?.kind === 'plugin' &&
    tail.source.plugin === 'dsh-preset-enhance' && textOf(tail).length > 0 ? {
      active: true,
      kind: tail.id === `preset:${options.seed ?? 'preview'}:prefill` ? 'assistant_prefill' : 'ordered-prompt',
      messageId: tail.id,
    } : { active: false };
  if (assistantPrefix.active) {
    ctx.warnings.push('最终注入消息是 assistant 预填充；请使用支持 assistant prefix 续写的接口');
  }
  return { messages, entries, assistantPrefix, local: { ...ctx.local }, global: { ...ctx.global }, warnings: [...new Set(ctx.warnings)] };
}
