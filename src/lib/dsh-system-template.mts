import type { PluginContext, HostMessage } from '../host-types.mjs';
import { connectionSelection, sessionSelection } from './connection.mjs';
export { dshTemplateSource } from './dsh-template-source.mjs';

export const DSH_TEMPLATE_ID = 'dsh-preset-enhance:dsh-system-prompt';
interface Section { name: string; text: string; interpolate?: boolean }
export interface DshAssembly {
  sections: Section[];
  contexts?: Section[];
  variables?: Record<string, string | undefined>;
  tools?: unknown[];
}
export type DshSectionOverride = { mode: 'custom'; template: string } | { mode: 'disabled' };
export type DshSectionTemplates = Record<string, Record<string, DshSectionOverride>>;
export const DSH_PREVIEW = Symbol('preset-enhance: independent assembly');
export interface DshSystemTemplate {
  available: boolean;
  modeId: string;
  template: string;
  text: string;
  values: Record<string, string>;
  variables: string[];
  sections: { name: string; template: string; text: string; macro: string }[];
  contexts?: { name: string; text: string }[];
  warnings: string[];
}

const variablePattern = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
function escapeLiteral(text: string): string { return text.replace(/[{}]/g, '\\$&'); }
function sectionTemplate(section: Section): string {
  if (section.interpolate === false) return escapeLiteral(section.text);
  let cursor = 0, out = '';
  for (const match of section.text.matchAll(variablePattern)) {
    out += escapeLiteral(section.text.slice(cursor, match.index)) + '{{dsh::var::' + match[1] + '}}';
    cursor = match.index! + match[0].length;
  }
  return out + escapeLiteral(section.text.slice(cursor));
}
function renderedSection(section: Section, variables: Record<string, string | undefined>, missing: Set<string>): string {
  if (section.interpolate === false) return section.text;
  return section.text.replace(variablePattern, (_all, name: string) => {
    if (!Object.hasOwn(variables, name) || variables[name] === undefined) {
      missing.add(name); return '{{dsh::var::' + name + '}}';
    }
    return variables[name]!;
  });
}

/** Project an accepted host assembly without running any provider again. */
export function dshTemplateFromAssembly(assembly: DshAssembly, modeId: string): DshSystemTemplate {
  const variables = assembly.variables ?? {};
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(variables)) if (typeof value === 'string') values['dsh::var::' + key.toLowerCase()] = value;
  const missing = new Set<string>();
  const sections = assembly.sections.map(section => {
    const sectionMissing = new Set<string>(), text = renderedSection(section, variables, sectionMissing);
    for (const key of sectionMissing) missing.add(key);
    if (sectionMissing.size === 0) {
      values['dsh::section::' + section.name.toLowerCase()] = text;
      values['dsh::section::' + encodeURIComponent(section.name).toLowerCase()] = text;
    }
    return { name: section.name, text, template: sectionTemplate(section), macro: '{{dsh::section::' + section.name.replace(/[{}\\]/g, '\\$&') + '}}' };
  });
  const text = sections.map(s => s.text).filter(Boolean).join('\n\n');
  if (missing.size === 0) values['dsh::prompt'] = text;
  return { available: true, modeId, text, values, variables: Object.keys(variables), sections,
    // All sections stay live, including empty and third-party sections.
    template: sections.map(s => s.macro).join('\n\n'),
    contexts: (assembly.contexts ?? []).map(section => ({ name: section.name, text: renderedSection(section, variables, new Set()) })),
    warnings: missing.size ? ['待会话就绪后解析变量：' + [...missing].join('、')] : [] };
}

/** Public assembly API preserves scoped mode contributions and leaves runtime context separate. */
export async function readDshSystemTemplate(ctx: PluginContext, sessionId: string, modeId: string,
  signal?: AbortSignal, callOptions?: Record<string, unknown>): Promise<DshSystemTemplate> {
  const session = ctx.sessions.get(sessionId);
  let selectedMode = session?.header?.agentPreset ?? '';
  for (const event of session?.snapshotEvents?.() ?? []) if (event.type === 'agent-preset/selected') selectedMode = event.data?.agentPreset ?? '';
  modeId ||= selectedMode || ctx.agentPresets?.defaultId || '';
  const empty: DshSystemTemplate = { available: false, modeId, template: '', text: '', values: {}, variables: [], sections: [], warnings: [] };
  const live = selectedMode === modeId ? ctx.agents?.get(sessionId) : undefined;
  const service = (live?.ctx?.get ? live.ctx.get('systemPrompt') : live?.ctx?.systemPrompt)
    ?? (ctx.get ? ctx.get('systemPrompt') : ctx.systemPrompt);
  if (!service || typeof (service as any).assemble !== 'function') return empty;
  let lease: { key: unknown; [Symbol.asyncDispose](): Promise<void> } | undefined;
  try {
    let scope: unknown = live;
    if (!scope && ctx.agentPresets?.acquireScope) { lease = await ctx.agentPresets.acquireScope(modeId || undefined); scope = lease.key; }
    else if (!scope && ctx.agentPresets?.standingKeyFor && modeId) scope = await ctx.agentPresets.standingKeyFor(modeId);
    // A sidebar/new-conversation view can precede Session creation. Do not fabricate
    // an Agent whose Session is undefined; host providers support an absent Agent.
    const selected = connectionSelection(ctx, sessionId);
    const defaults = connectionSelection(ctx);
    const current = sessionSelection(ctx, sessionId);
    const options = { ...Object.fromEntries(Object.entries({ provider: selected.provider ?? defaults.provider,
        model: selected.model ?? defaults.model, reasoningEffort: selected.reasoningEffort ?? defaults.reasoningEffort }).filter(([, value]) => value != null)),
      ...session?.requestHeader?.()?.config, ...live?.options, ...current, ...Object.fromEntries(['provider', 'model', 'reasoningEffort'].filter(key => callOptions?.[key] !== undefined).map(key => [key, callOptions![key]])) };
    // Omitting effort in a newly selected route means adapter default, not the old header's effort.
    if (current && current.reasoningEffort === undefined && callOptions?.reasoningEffort === undefined) delete options.reasoningEffort;
    const agent = live && live.options?.reasoningEffort === options.reasoningEffort && Object.entries(options).every(([key, value]) => live.options?.[key] === value)
      ? live : session ? Object.assign(Object.create(live ?? null), { session, options }) : undefined;
    signal?.throwIfAborted();
    // Preserve the live Agent scope; cold reads use a preset scope without creating an Agent.
    const assembly = await (service as any).assemble({ agent, scope, modelSelection: options, [DSH_PREVIEW]: true, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    return dshTemplateFromAssembly(assembly, modeId);
  } finally { await lease?.[Symbol.asyncDispose](); }
}

/** Replace durable host snapshots only on the request copy; keep separate runtime contexts. */
export function withoutDshPrompt(messages: HostMessage[]): HostMessage[] {
  return messages.filter(m => m.source?.kind !== 'system-prompt' &&
    !(m.source?.kind === 'plugin' && (m.source.plugin === '@deepseek-ai/dsh-system-prompt' || m.id?.startsWith('preset:dsh-system:'))));
}

export function validateDshTemplates(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dsh_system_prompt_templates 必须是对象');
  for (const [mode, text] of Object.entries(value)) {
    if (!mode || typeof text !== 'string' || text.length > 2_000_000) throw new Error('DSH 模式模板必须为小于 2 MB 的文本');
  }
}

export function validateDshSections(value: unknown): void {
  if (value === undefined) return;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!record(value)) throw new Error('dsh_system_prompt_sections 必须为对象');
  let count = 0, chars = 0;
  for (const [mode, sections] of Object.entries(value)) {
    if (!mode || !record(sections)) throw new Error('DSH 模式段落配置必须为对象');
    for (const [name, item] of Object.entries(sections)) {
      if (!name || !record(item) || !['custom', 'disabled'].includes(item.mode as string) ||
        (item.mode === 'custom' && typeof item.template !== 'string')) throw new Error('DSH 段落必须包含 custom/template 或 disabled');
      chars += typeof item.template === 'string' ? item.template.length : 0;
      if (++count > 4096 || chars > 2_000_000) throw new Error('DSH 段落配置过大');
    }
  }
}
