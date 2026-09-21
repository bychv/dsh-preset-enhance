/** Official DeepSeek route; preferred when the directory offers several routes. */
const OFFICIAL_PROVIDER = 'deepseek-official';
function protocolOf(value) {
    const raw = value !== null && typeof value === 'object'
        ? value.protocol
        : undefined;
    return raw === 'chat-completions' || raw === 'messages' ? raw : 'unknown';
}
function atPath(root, path) {
    let node = root;
    for (const step of path) {
        if (node === null || typeof node !== 'object')
            return undefined;
        node = node[step];
    }
    return node;
}
/**
 * Read the protocol of the connection the host is actually using.
 * @returns the connection facts, or null when the host reports no configurable route.
 */
export function readConnectionProtocol(ctx, service) {
    const directory = ctx.llm?.listConfigurableProviders?.() ?? [];
    const entry = directory.find(item => item.provider === OFFICIAL_PROVIDER) ?? directory[0];
    if (!entry)
        return null;
    const settingsPath = [...(entry.settingsPath ?? [])];
    const info = {
        provider: entry.provider,
        displayName: entry.displayName || entry.provider,
        settingsNs: entry.settingsNs,
        settingsPath,
        protocol: 'unknown',
        revision: null,
        source: 'none',
    };
    const settings = service ?? ctx.get?.('settings');
    const descriptors = (settings?.describe?.({ redactSecrets: true }) ?? []);
    const descriptor = descriptors.find(item => item.ns === entry.settingsNs);
    if (!descriptor)
        return info;
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
export async function writeConnectionProtocol(ctx, info, protocol) {
    const settings = ctx.get?.('settings');
    if (!settings?.update)
        throw new Error('当前 DSH 未提供设置写入服务，无法切换连接协议');
    let patch = { protocol };
    for (const step of [...info.settingsPath].reverse())
        patch = { [step]: patch };
    await settings.update(info.settingsNs, patch, info.revision ?? undefined);
}
