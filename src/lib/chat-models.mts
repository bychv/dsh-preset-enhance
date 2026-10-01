import type { PluginConfig, PluginContext, SettingsServiceLike } from '../host-types.mjs';
import { DEFAULT_CHAT_CONNECTION } from '../vendor/deepseek-chat/config.mjs';
import type { ChatModelConfig } from '../vendor/deepseek-chat/config.mjs';

/** Copy only Chat-supported model facts; Messages prompt/tool policies must not leak in. */
function modelConfig(row: any): ChatModelConfig {
  const result: ChatModelConfig = { id: row.id, name: row.name || row.id };
  for (const key of ['description', 'contextWindow', 'maxTokens', 'inputModalities', 'imagePixelBudget', 'imageMaxBytes', 'reasoningEffort'] as const) {
    if (row[key] !== undefined) (result as any)[key] = structuredClone(row[key]);
  }
  return result;
}
export function createChatModelCatalog(ctx: PluginContext, config: PluginConfig) {
  let discovered: readonly ChatModelConfig[] = DEFAULT_CHAT_CONNECTION.models;
  const configured = () => {
    // The host supplies schema defaults too. Only an explicit profile value overrides discovery.
    const entry = ctx.fiber?.entry;
    if (entry && !Object.hasOwn(entry.options.config ?? {}, 'chatModels')) return undefined;
    const setting = config.chatModels;
    return setting && !Array.isArray(setting) ? setting.get() : setting;
  };
  const official = (): ChatModelConfig[] | undefined => {
    const directory = ctx.llm?.listConfigurableProviders?.();
    const entry = directory?.find(row => row.provider === 'deepseek-official');
    if (!entry) return undefined;
    const settings = ctx.get?.('settings') as SettingsServiceLike | undefined;
    let value: any = settings?.describe?.({ redactSecrets: true }).find(row => row.ns === entry.settingsNs)?.value;
    for (const key of entry.settingsPath ?? []) value = value?.[key];
    return Array.isArray(value?.models) ? value.models.map(modelConfig) : undefined;
  };
  const models = (): readonly ChatModelConfig[] => {
    const own = configured();
    return own?.length ? own.map(modelConfig) : official() ?? discovered;
  };
  const refresh = async () => {
    if (configured()?.length || official() !== undefined) return;
    const llm = ctx.get?.('llm') ?? ctx.llm;
    if (typeof llm?.listModels !== 'function') return;
    try {
      const rows = await llm.listModels('deepseek-official');
      discovered = await Promise.all(rows.map(async (row: any) => {
        const resolved = await llm.resolveModelInfo?.('deepseek-official', row.id);
        return modelConfig({ ...DEFAULT_CHAT_CONNECTION.models.find(model => model.id === row.id), ...row,
          ...(resolved?.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
          ...(resolved?.defaultMaxTokens === undefined ? {} : { maxTokens: resolved.defaultMaxTokens }),
        });
      }));
    } catch { /* Keep the last known catalog while the official provider is unavailable. */ }
  };
  return { models, refresh };
}
