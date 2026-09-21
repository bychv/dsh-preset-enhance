/**
 * Detect and change the wire protocol of the model connection the host is using.
 *
 * DSH 0.1.6 leaves the protocol to the connection's own settings (the official
 * route defaults to Messages) and the web UI has no selector for it. The plugin
 * therefore reads the connection's `protocol` from the host's settings at start-up
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

/** Official DeepSeek route; preferred when the directory offers several routes. */
const OFFICIAL_PROVIDER = 'deepseek-official';

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
  ctx: PluginContext, service?: SettingsServiceLike | null,
): ConnectionProtocolInfo | null {
  const directory = ctx.llm?.listConfigurableProviders?.() ?? [];
  const entry = directory.find(item => item.provider === OFFICIAL_PROVIDER) ?? directory[0];
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
