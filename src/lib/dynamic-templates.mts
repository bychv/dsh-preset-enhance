import { createHash, randomUUID } from 'node:crypto';
import { validateHistoryPatches } from './history-patches.mjs';
import type { DynamicTemplateResultV1 } from '../template-api.mjs';
import { getOrder } from './preset.mjs';
import { resolveTemplateBindings, templateBindings } from './template-bindings.mjs';
import type { DynamicBody } from './template-bindings.mjs';
import type { createTemplateRegistry } from './template-registry.mjs';
import type { CompilePresetOptions, HostMessage, SillyTavernPreset } from './types.mjs';

const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
export interface DynamicPreparation extends CompilePresetOptions {
  sessionId?: string; requestId?: string; presetId?: string; mode?: string; protocol?: string;
  purpose: 'preview' | 'request'; signal?: AbortSignal; timeoutMs?: number;
}

/** No store lock, no write or cross-request memoization. One shared immutable input per preparation. */
export async function prepareDynamicTemplates(registry: ReturnType<typeof createTemplateRegistry>, preset: SillyTavernPreset, history: HostMessage[], options: DynamicPreparation) {
  const catalog = options.templateCatalog ?? registry.service.list();
  const prompts = new Map(preset.prompts.map(p => [p.identifier, p]));
  const ids = new Set(getOrder(preset, options.characterId).filter(item => item.enabled &&
    (!prompts.get(item.identifier)?.injection_trigger?.length || prompts.get(item.identifier)!.injection_trigger!.includes(options.trigger ?? 'normal'))).map(item => item.identifier));
  const refs = templateBindings(preset);
  const work = [...ids].filter(id => refs[id]?.mode === 'linked-dynamic');
  const bodies: Record<string, DynamicBody> = Object.create(null);
  if (!work.length) return { catalog, bodies };
  const references = resolveTemplateBindings(preset, catalog, ids).references;
  // Pin the registration leases too: a reload must not mix old and new callbacks in one request.
  const leases = new Map(work.map(id => {
    const ref = refs[id];
    const template = catalog.providers.find(p => p.providerId === ref.providerId)?.templates.find(t => t.id === ref.templateId && t.version === ref.templateVersion);
    return [id, { template, runtime: template?.dynamic ? registry.resolver(ref.providerId, template.dynamic.resolverId) : undefined }] as const;
  }));
  const needsHistory = work.some(id => catalog.providers.find(p => p.providerId === refs[id].providerId)?.templates.find(t => t.id === refs[id].templateId && t.version === refs[id].templateVersion)?.dynamic?.input === 'history');
  const copied = needsHistory ? freeze(structuredClone(history)) : undefined;
  const latest = (copied ?? history).findLast(m => m.role === 'user' && m.source?.kind !== 'tool' && !m.content?.some(b => b.type === 'tool-result'));
  const latestUser = latest ? copied ? latest : freeze(structuredClone(latest)) : undefined;
  const userText = latestUser?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') ?? '';
  const variables = freeze(structuredClone({ local: options.local ?? {}, global: options.global ?? {}, values: options.values ?? {} }));
  const historyRevision = createHash('sha256').update(JSON.stringify(history)).digest('hex');
  const requestId = options.requestId ?? randomUUID();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('动态模板解析超时')), options.timeoutMs ?? 5000);
  let cursor = 0, total = 0;
  const worker = async () => {
    while (cursor < work.length) {
      const id = work[cursor++], ref = refs[id];
      options.signal?.throwIfAborted();
      try {
        const invalid = references.find(r => r.identifier === id)?.reason;
        if (invalid) throw new Error(invalid);
        if (ref.config !== undefined && (ref.config === null || typeof ref.config !== 'object' || Array.isArray(ref.config) || JSON.stringify(ref.config).length > 20_000)) throw new Error('动态模板配置必须是最多 20,000 字符的 JSON 对象');
        const { template, runtime } = leases.get(id)!;
        if (!runtime) throw new Error('动态模板解析器不可用');
        const signal = AbortSignal.any([deadline.signal, runtime.signal, ...(options.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        const context = Object.freeze({ sessionId: options.sessionId ?? '', requestId, historyRevision, presetId: options.presetId,
          identifier: id, mode: options.mode ?? '', protocol: options.protocol ?? 'unknown', purpose: options.purpose,
          latestUser, userText, ...(template!.dynamic!.input === 'history' ? { history: copied } : {}), variables,
          config: freeze(structuredClone(ref.config ?? {})), signal });
        const text = await new Promise<DynamicTemplateResultV1>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
          Promise.resolve().then(() => { signal.throwIfAborted(); return runtime.run(context); }).then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted));
        });
        signal.throwIfAborted();
        if (template?.dynamic?.output === 'history-patches') {
          const patches = validateHistoryPatches(text, history);
          const size = patches.reduce((sum, patch) => sum + patch.text.length, 0);
          if (total + size > 2_000_000) throw new Error('动态正文总量超过 2 MB');
          total += size; bodies[id] = { patches }; continue;
        }
        if (typeof text !== 'string' || text.length > 200_000) throw new Error('动态正文必须是最多 200,000 字符的文本');
        if (total + text.length > 2_000_000) throw new Error('动态正文总量超过 2 MB');
        total += text.length;
        bodies[id] = { text };
      } catch (error) {
        options.signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : '动态解析失败';
        if (ref.failurePolicy !== 'skip') { deadline.abort(error); throw new Error(`动态模板「${prompts.get(id)?.name ?? id}」：${reason}`); }
        bodies[id] = { reason };
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(4, work.length) }, worker)); return { catalog, bodies }; }
  finally { clearTimeout(timer); deadline.abort(new Error('动态模板准备已结束')); }
}
