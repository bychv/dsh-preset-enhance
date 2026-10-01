import { createHash } from 'node:crypto';
import type {
  PresetTemplatesV1, PromptTemplateV1, TemplateProviderV1, TemplateOwnerContext,
} from '../template-api.mjs';

const MAX_PROVIDERS = 64;
const MAX_TEMPLATES = 256;
const MAX_CONTENT = 200_000;
const MAX_CATALOG_TEXT = 4_000_000;
const MAX_VERSIONS = 8192;
const MAX_SUBSCRIBERS = 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new Error(`${name} 必须是${empty ? '' : '非空'}文本（最多 ${max} 字符）`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const out = text(value, name, 128);
  if (!/^[a-zA-Z0-9@][a-zA-Z0-9._/@+-]*$/.test(out)) throw new Error(`${name} 格式无效`);
  return out;
}

function templatesOf(value: unknown): PromptTemplateV1[] {
  if (!Array.isArray(value) || value.length > MAX_TEMPLATES) throw new Error(`templates 必须是数组（最多 ${MAX_TEMPLATES} 项）`);
  const seen = new Set<string>();
  return Array.from(value, raw => {
    if (!isRecord(raw)) throw new Error('模板必须是普通对象');
    const id = identifier(raw.id, '模板 id');
    const version = identifier(raw.version, '模板 version');
    const key = JSON.stringify([id, version]);
    if (seen.has(key)) throw new Error(`模板 id/version 重复：${id}@${version}`);
    seen.add(key);
    if (raw.role !== 'system' && raw.role !== 'user' && raw.role !== 'assistant') throw new Error('模板 role 无效');
    const item: PromptTemplateV1 = {
      id, version, title: text(raw.title, '模板 title', 200), role: raw.role,
      content: text(raw.content, '模板 content', MAX_CONTENT, true),
    };
    if (raw.description !== undefined) item.description = text(raw.description, '模板 description', 2000, true);
    if (raw.defaults !== undefined) {
      const defaults = raw.defaults;
      if (!isRecord(defaults) || typeof defaults.placement !== 'string' || !['beforeHistory', 'afterHistory', 'depth'].includes(defaults.placement)) {
        throw new Error('模板 defaults.placement 无效');
      }
      item.defaults = { placement: defaults.placement as NonNullable<PromptTemplateV1['defaults']>['placement'] };
      if (defaults.depth !== undefined) {
        if (!Number.isSafeInteger(defaults.depth) || (defaults.depth as number) < 0) throw new Error('模板 depth 必须是非负整数');
        item.defaults.depth = defaults.depth as number;
      }
      if (defaults.order !== undefined) {
        if (!Number.isSafeInteger(defaults.order)) throw new Error('模板 order 必须是整数');
        item.defaults.order = defaults.order as number;
      }
      if (defaults.placement === 'depth' && defaults.depth === undefined) throw new Error('深度模板必须指定 depth');
      if (defaults.placement !== 'depth' && (defaults.depth !== undefined || defaults.order !== undefined)) {
        throw new Error('depth/order 仅适用于 depth 位置');
      }
    }
    return item;
  });
}

/** One registry per activation. Never writes presets, macro state, or request messages. */
export function createTemplateRegistry(onListenerError: (error: unknown) => void = () => {}) {
  const providers = new Map<string, TemplateProviderV1>();
  // Keep fingerprints across provider reloads, but never keep withdrawn template bodies.
  const versions = new Map<string, string>();
  const listeners = new Set<(revision: number) => void>();
  let revision = 0;
  let closed = false;
  let scheduled = false;
  const assertOpen = () => { if (closed) throw new Error('模板注册服务已停用'); };
  const report = (error: unknown) => { try { onListenerError(error); } catch { /* observer errors cannot break registration */ } };
  const changed = () => {
    revision++;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      const current = revision;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { void Promise.resolve(listener(current)).catch(report); } catch (error) { report(error); }
      }
    });
  };
  const checkCatalog = (provider: TemplateProviderV1): Map<string, string> => {
    const fingerprints = new Map<string, string>();
    for (const template of provider.templates) {
      const key = JSON.stringify([provider.providerId, template.id, template.version]);
      const fingerprint = createHash('sha256').update(JSON.stringify(template)).digest('hex');
      if (versions.has(key) && versions.get(key) !== fingerprint) throw new Error(`模板 ${template.id}@${template.version} 内容已改变，请使用新版本`);
      fingerprints.set(key, fingerprint);
    }
    const additions = [...fingerprints.keys()].filter(key => !versions.has(key)).length;
    if (versions.size + additions > MAX_VERSIONS) throw new Error('模板版本登记数量已达上限');
    let size = JSON.stringify(provider).length;
    for (const other of providers.values()) if (other.providerId !== provider.providerId) size += JSON.stringify(other).length;
    if (size > MAX_CATALOG_TEXT) throw new Error('模板目录总文本超过上限');
    return fingerprints;
  };
  const remember = (fingerprints: Map<string, string>) => {
    for (const [key, value] of fingerprints) versions.set(key, value);
  };
  const service: PresetTemplatesV1 = Object.freeze({
    contractVersion: 1 as const,
    register(owner: TemplateOwnerContext, definition: TemplateProviderV1) {
      assertOpen();
      if (!owner || typeof owner.effect !== 'function') throw new Error('注册模板需要有效的插件作用域');
      if (!isRecord(definition)) throw new Error('模板提供者必须是普通对象');
      const providerId = identifier(definition.providerId, 'providerId');
      if (providers.has(providerId)) throw new Error(`模板提供者已注册：${providerId}`);
      if (providers.size >= MAX_PROVIDERS) throw new Error('模板提供者数量已达上限');
      let entry: TemplateProviderV1 = {
        providerId, title: text(definition.title, '提供者 title', 200), templates: templatesOf(definition.templates),
      };
      const fingerprints = checkCatalog(entry);
      let active = false;
      const dispose = () => {
        if (!active) return;
        active = false;
        if (!closed && providers.get(providerId) === entry) { providers.delete(providerId); changed(); }
      };
      try {
        owner.effect(() => {
          assertOpen();
          if (providers.has(providerId)) throw new Error(`模板提供者已注册：${providerId}`);
          providers.set(providerId, entry);
          remember(fingerprints);
          active = true;
          changed();
          return dispose;
        }, `preset-enhance: templates ${providerId}`);
      } catch (error) { dispose(); throw error; }
      if (!active) throw new Error('模板提供者作用域未启用');
      return Object.freeze({
        update(templates: PromptTemplateV1[]) {
          assertOpen();
          if (!active || providers.get(providerId) !== entry) throw new Error('模板注册已释放');
          const next = { providerId, title: entry.title, templates: templatesOf(templates) };
          const updates = checkCatalog(next);
          if (JSON.stringify(next) === JSON.stringify(entry)) return;
          remember(updates);
          entry = next;
          providers.set(providerId, entry);
          changed();
        },
        dispose,
      });
    },
    list() {
      assertOpen();
      return { contractVersion: 1 as const, revision, providers: structuredClone([...providers.values()]) };
    },
    subscribe(listener: (revision: number) => void) {
      assertOpen();
      if (typeof listener !== 'function') throw new Error('模板目录订阅者必须是函数');
      if (listeners.size >= MAX_SUBSCRIBERS) throw new Error('模板目录订阅数量已达上限');
      // Separate leases even when a consumer subscribes the same function twice.
      const wrapped = (value: number) => listener(value);
      listeners.add(wrapped);
      return () => { listeners.delete(wrapped); };
    },
  });
  return {
    service,
    close() {
      if (closed) return;
      closed = true;
      providers.clear();
      versions.clear();
      listeners.clear();
    },
  };
}
