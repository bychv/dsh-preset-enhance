import { DEFAULT_CHAT_CONNECTION } from '../vendor/deepseek-chat/config.mjs';
/** Reuse the host schema runtime; keep plain imports usable outside DSH. */
export function createPluginConfigSchema(z) {
    return z.object({
        dataFile: z.string(),
        agentPresetRoot: z.string(),
        standardComposition: z.string(),
        chatApiKeyEnv: z.string().role('credential-ref'),
        reroute: z.boolean(),
        chatModels: z.array(z.object({
            id: z.string().required().description('模型 ID'),
            name: z.string().description('显示名称'),
            description: z.string().description('说明'),
            contextWindow: z.number().step(1).min(1).description('上下文长度'),
            maxTokens: z.number().step(1).min(1).description('最大输出'),
            inputModalities: z.array(z.union(['text', 'image'])).min(1).default(['text']).description('输入类型'),
            imagePixelBudget: z.union([z.number().step(1).min(1), 'low']).description('图片像素预算'),
            imageMaxBytes: z.number().step(1).min(1).description('图片字节上限'),
            reasoningEffort: z.union(['off', 'low', 'high', 'max']).description('默认思考强度'),
        })).default(structuredClone(DEFAULT_CHAT_CONNECTION.models)).description('DeepSeek-预设增强模型（默认同官方，可自定义）').volatile(),
    });
}
export const Config = await (async () => {
    try {
        const specifier = '@deepseek-ai/schemastery';
        const { default: z } = await import(specifier);
        return createPluginConfigSchema(z);
    }
    catch {
        return undefined;
    }
})();
