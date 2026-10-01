import { DEFAULT_CHAT_CONNECTION } from '../vendor/deepseek-chat/config.mjs';
/** Copy only Chat-supported model facts; Messages prompt/tool policies must not leak in. */
function modelConfig(row) {
    const result = { id: row.id, name: row.name || row.id };
    for (const key of ['description', 'contextWindow', 'maxTokens', 'inputModalities', 'imagePixelBudget', 'imageMaxBytes', 'reasoningEffort']) {
        if (row[key] !== undefined)
            result[key] = structuredClone(row[key]);
    }
    return result;
}
export function createChatModelCatalog(ctx, config) {
    let discovered = DEFAULT_CHAT_CONNECTION.models;
    const configured = () => {
        // The host supplies schema defaults too. Only an explicit profile value overrides discovery.
        const entry = ctx.fiber?.entry;
        if (entry && !Object.hasOwn(entry.options.config ?? {}, 'chatModels'))
            return undefined;
        const setting = config.chatModels;
        return setting && !Array.isArray(setting) ? setting.get() : setting;
    };
    const official = () => {
        const directory = ctx.llm?.listConfigurableProviders?.();
        const entry = directory?.find(row => row.provider === 'deepseek-official');
        if (!entry)
            return undefined;
        const settings = ctx.get?.('settings');
        let value = settings?.describe?.({ redactSecrets: true }).find(row => row.ns === entry.settingsNs)?.value;
        for (const key of entry.settingsPath ?? [])
            value = value?.[key];
        return Array.isArray(value?.models) ? value.models.map(modelConfig) : undefined;
    };
    const models = () => {
        const own = configured();
        return own?.length ? own.map(modelConfig) : official() ?? discovered;
    };
    const refresh = async () => {
        if (configured()?.length || official() !== undefined)
            return;
        const llm = ctx.get?.('llm') ?? ctx.llm;
        if (typeof llm?.listModels !== 'function')
            return;
        try {
            const rows = await llm.listModels('deepseek-official');
            discovered = await Promise.all(rows.map(async (row) => {
                const resolved = await llm.resolveModelInfo?.('deepseek-official', row.id);
                return modelConfig({ ...DEFAULT_CHAT_CONNECTION.models.find(model => model.id === row.id), ...row,
                    ...(resolved?.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
                    ...(resolved?.defaultMaxTokens === undefined ? {} : { maxTokens: resolved.defaultMaxTokens }),
                });
            }));
        }
        catch { /* Keep the last known catalog while the official provider is unavailable. */ }
    };
    return { models, refresh };
}
