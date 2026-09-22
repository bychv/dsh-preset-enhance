/**
 * Detect and change the wire protocol of the model connection the host is using.
 *
 * DSH 0.1.6 leaves the protocol to the connection's own settings (the official
 * route defaults to Messages) and the web UI has no selector for it. The plugin
 * therefore reads the session connection's current protocol from host settings
 * — no network call, no guessing — and can write it back through the same settings
 * service, so the switch belongs to the connection it changes instead of being a
 * plugin-local preference.
 *
 * The provider directory (llm.listConfigurableProviders) names the settings
 * namespace a route is configured by; the settings service describes the resolved
 * value of every registered namespace, including the revision a write must present
 * to avoid clobbering a concurrent edit.
 */
import type { PluginContext, SettingsDescriptorInfo, SettingsServiceLike } from '../host-types.mjs';

export type ConnectionProtocol = 'chat-completions' | 'messages';

export interface ConnectionProtocolInfo {
  /** Provider route key, e.g. `deepseek-official`. */
  provider: string;
  /** Human-readable name for the connection. */
  displayName: string;
  /** Settings namespace that configures this connection. */
  settingsNs: string;
  /** Path from that namespace's root to this connection's profile. */
  settingsPath: readonly string[];
  /** Protocol the connection is configured with, or 'unknown' when unreadable. */
  protocol: ConnectionProtocol | 'unknown';
  /** Revision the value was read at; presented on write to refuse a stale one. */
  revision: number | null;
  /** Where the answer came from: the host settings, or nothing at all. */
  source: 'settings' | 'none';
}

function protocolOf(value: unknown): ConnectionProtocol | 'unknown' {
  const raw = value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>).protocol
    : undefined;
  return raw === 'chat-completions' || raw === 'messages' ? raw : 'unknown';
}

function atPath(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const step of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return node;
}

/**
 * Read the protocol of the connection the host is actually using.
 * @returns the connection facts, or null when the host reports no configurable route.
 */
export function readConnectionProtocol(
  ctx: PluginContext, service?: SettingsServiceLike | null, provider?: string,
): ConnectionProtocolInfo | null {
  const directory = ctx.llm?.listConfigurableProviders?.() ?? [];
  const entry = provider ? directory.find(item => item.provider === provider)
    : directory.length === 1 ? directory[0] : undefined;
  if (!entry) return null;
  const settingsPath = [...(entry.settingsPath ?? [])];
  const info: ConnectionProtocolInfo = {
    provider: entry.provider,
    displayName: entry.displayName || entry.provider,
    settingsNs: entry.settingsNs,
    settingsPath,
    protocol: 'unknown',
    revision: null,
    source: 'none',
  };
  const settings = service ?? (ctx.get?.('settings') as SettingsServiceLike | undefined);
  const descriptors = (settings?.describe?.({ redactSecrets: true }) ?? []) as SettingsDescriptorInfo[];
  const descriptor = descriptors.find(item => item.ns === entry.settingsNs);
  if (!descriptor) return info;
  return {
    ...info,
    protocol: protocolOf(atPath(descriptor.value, settingsPath)),
    revision: typeof descriptor.revision === 'number' ? descriptor.revision : null,
    source: 'settings',
  };
}

/**
 * Write one connection's protocol through the host settings service.
 *
 * Merges only this field, so unrelated connection settings (endpoint, key
 * reference, model catalog) are never restated or dropped. Throws when the host
 * exposes no writable settings or the revision moved on.
 */
export async function writeConnectionProtocol(
  ctx: PluginContext, info: ConnectionProtocolInfo, protocol: ConnectionProtocol,
): Promise<void> {
  const settings = ctx.get?.('settings') as SettingsServiceLike | undefined;
  if (!settings?.update) throw new Error('当前 DSH 未提供设置写入服务，无法切换连接协议');
  let patch: Record<string, unknown> = { protocol };
  for (const step of [...info.settingsPath].reverse()) patch = { [step]: patch };
  await settings.update(info.settingsNs, patch, info.revision ?? undefined);
}

/** Live agent options win over the persisted header when the user changes models. */
export function sessionConnection(ctx: PluginContext, sessionId: string, provider?: string): ConnectionProtocolInfo | null {
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  const route = provider || ctx.agents?.get(sessionId)?.options?.provider || session?.requestHeader?.()?.config?.provider;
  // A session with an unresolved route must not change another provider's settings.
  if (sessionId && !route) return null;
  return readConnectionProtocol(ctx, undefined, route);
}
/** Providers the workbench can route a session to, with the protocol each speaks. */
export interface ConnectionChoice {
  provider: string;
  label: string;
  protocol: ConnectionProtocol;
  /** Model this provider is switched to when the caller names none. */
  defaultModel: string;
}

export interface ConnectionSelection {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  choices: ConnectionChoice[];
  /** False when the host exposes no agentDefaultModel service, so nothing can be switched. */
  canSwitch: boolean;
}

const CONNECTION_CHOICES: ConnectionChoice[] = [
  { provider: 'preset-deepseek-chat', label: '插件 DeepSeek Chat（预设增强）', protocol: 'chat-completions', defaultModel: 'deepseek-flash' },
  { provider: 'deepseek-official', label: 'DSH 官方连接（Messages）', protocol: 'messages', defaultModel: 'deepseek-v4-pro' },
];

interface DefaultModelService {
  currentSelection?(): { provider?: string; model?: string; reasoningEffort?: string } | undefined;
  saveSelection?(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>;
}

const defaultModelService = (ctx: PluginContext): DefaultModelService | undefined =>
  ctx.get?.('agentDefaultModel') as DefaultModelService | undefined;

/** The connection a new session is routed to, read from the host's default-model service. */
export function connectionSelection(ctx: PluginContext): ConnectionSelection {
  const service = defaultModelService(ctx);
  const current = service?.currentSelection?.() ?? undefined;
  return {
    provider: typeof current?.provider === 'string' && current.provider ? current.provider : null,
    model: typeof current?.model === 'string' && current.model ? current.model : null,
    reasoningEffort: typeof current?.reasoningEffort === 'string' ? current.reasoningEffort : null,
    choices: CONNECTION_CHOICES.map(choice => ({ ...choice })),
    canSwitch: typeof service?.saveSelection === 'function',
  };
}

/**
 * Route sessions to one of the offered connections.
 *
 * The switch happens at the host's provider/model layer on purpose: request records,
 * model capabilities and the adapter that actually runs then all describe the same
 * route. Rewriting the wire later (at the fetch stage) is exactly what the 0.1.7 plan
 * rules out, and nothing here writes a `protocol` field - 0.1.7 rejects it.
 */
export async function selectConnection(ctx: PluginContext, provider: string, model?: string): Promise<ConnectionSelection> {
  const service = defaultModelService(ctx);
  if (typeof service?.saveSelection !== 'function') {
    throw new Error('当前 DSH 未提供 agentDefaultModel 服务，无法切换连接');
  }
  const choice = CONNECTION_CHOICES.find(item => item.provider === provider);
  if (!choice) throw new Error('未知的连接');
  const current = service.currentSelection?.();
  const next = {
    provider,
    model: model && model.trim() ? model.trim() : choice.defaultModel,
    ...(typeof current?.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}),
  };
  await service.saveSelection(next);
  return connectionSelection(ctx);
}
