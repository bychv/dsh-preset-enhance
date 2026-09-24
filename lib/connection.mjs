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
export function readConnectionProtocol(ctx, service, provider) {
    const directory = ctx.llm?.listConfigurableProviders?.() ?? [];
    const entry = provider ? directory.find(item => item.provider === provider)
        : directory.length === 1 ? directory[0] : undefined;
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
/** Live agent options win over the persisted header when the user changes models. */
export function sessionConnection(ctx, sessionId, provider) {
    const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
    const route = provider || ctx.agents?.get(sessionId)?.options?.provider || session?.requestHeader?.()?.config?.provider;
    // A session with an unresolved route must not change another provider's settings.
    if (sessionId && !route)
        return null;
    return readConnectionProtocol(ctx, undefined, route);
}
/** Hosts may route through providers we do not curate (pi-ai, gateways), so they stay selectable. */
const hostProviderChoices = (ctx) => {
    const providers = ctx.llm?.listProviders?.() ?? [];
    return providers
        .filter(provider => typeof provider?.id === 'string' && provider.id.length > 0)
        .map(provider => ({
        provider: provider.id,
        label: typeof provider.name === 'string' && provider.name ? provider.name : String(provider.id),
        protocol: 'unknown',
        defaultModel: '',
    }));
};
const CONNECTION_CHOICES = [
    { provider: 'preset-deepseek-chat', label: '插件 DeepSeek Chat（预设增强）', protocol: 'chat-completions', defaultModel: 'deepseek-flash' },
    { provider: 'deepseek-official', label: 'DSH 官方连接（Messages）', protocol: 'messages', defaultModel: 'deepseek-v4-pro' },
];
const defaultModelService = (ctx) => ctx.get?.('agentDefaultModel');
/** The connection a new session is routed to, read from the host's default-model service. */
export function connectionSelection(ctx) {
    const service = defaultModelService(ctx);
    const current = service?.currentSelection?.() ?? undefined;
    return {
        provider: typeof current?.provider === 'string' && current.provider ? current.provider : null,
        model: typeof current?.model === 'string' && current.model ? current.model : null,
        reasoningEffort: typeof current?.reasoningEffort === 'string' ? current.reasoningEffort : null,
        choices: [...CONNECTION_CHOICES.map(choice => ({ ...choice })),
            ...hostProviderChoices(ctx).filter(extra => !CONNECTION_CHOICES.some(known => known.provider === extra.provider))],
        canSwitch: typeof service?.saveSelection === 'function',
    };
}
/** Model ids one provider advertises, or undefined when the host cannot answer. */
async function advertisedModelIds(ctx, provider) {
    const llm = ctx.get?.('llm');
    if (typeof llm?.listModels !== 'function')
        return undefined;
    try {
        const models = await llm.listModels(provider);
        return models.map(entry => entry?.id).filter((id) => typeof id === 'string' && id.length > 0);
    }
    catch {
        // Discovery is advisory: a provider that cannot answer keeps the curated default.
        return undefined;
    }
}
/**
 * Route sessions to one of the offered connections.
 *
 * The switch happens at the host's provider/model layer on purpose: request records,
 * model capabilities and the adapter that actually runs then all describe the same
 * route. Rewriting the wire later (at the fetch stage) is exactly what the 0.1.7 plan
 * rules out, and nothing here writes a `protocol` field - 0.1.7 rejects it.
 */
export async function selectConnection(ctx, provider, model) {
    const service = defaultModelService(ctx);
    if (typeof service?.saveSelection !== 'function') {
        throw new Error('当前 DSH 未提供 agentDefaultModel 服务，无法切换连接');
    }
    const choice = CONNECTION_CHOICES.find(item => item.provider === provider)
        ?? hostProviderChoices(ctx).find(item => item.provider === provider);
    if (!choice)
        throw new Error('未知的连接');
    const current = service.currentSelection?.();
    const requested = model && model.trim() ? model.trim() : undefined;
    const currentModel = typeof current?.model === 'string' && current.model ? current.model : undefined;
    // Both curated connections advertise the same catalog, so a toggle must not silently change the
    // model. Keep the current id when the target provider confirms it advertises it; a host that
    // cannot answer leaves the curated default in place.
    const preserved = requested === undefined && currentModel !== undefined
        && (await advertisedModelIds(ctx, provider))?.includes(currentModel) === true
        ? currentModel
        : undefined;
    const next = {
        provider,
        model: requested ?? preserved ?? (choice.defaultModel || currentModel || ''),
        ...(typeof current?.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}),
    };
    await service.saveSelection(next);
    return connectionSelection(ctx);
}
