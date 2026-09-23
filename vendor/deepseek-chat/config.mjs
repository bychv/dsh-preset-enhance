/**
 * Plugin-owned connection config for the vendored DeepSeek Chat adapter.
 * Upstream basis: dsh-v0.1.6-alpha.2 packages/llm/llm-deepseek/src/common/{model-info,types,defaults}.ts
 * and packages/llm/llm/src/attribution.ts. MIT licensed upstream; Copyright (c) DeepSeek.
 */
/** Official Chat Completions root. Never the /anthropic Messages base. */
export const DEEPSEEK_CHAT_BASE_URL = 'https://api.deepseek.com';
/** Reasoning levels the Chat wire accepts (off is expressed as thinking disabled). */
export const CHAT_REASONING_EFFORTS = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
];
/** Defaults for the plugin Chat connection (model ids and caps are config-overridable). */
/** Context capacity assumed for an id the plugin does not catalogue. */
export const DEFAULT_CONTEXT_WINDOW = 1000000;
export const DEFAULT_CHAT_CONNECTION = {
    baseURL: DEEPSEEK_CHAT_BASE_URL,
    models: [
        { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, maxTokens: 65536, inputModalities: ['text', 'image'] },
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 1000000, maxTokens: 65536, inputModalities: ['text', 'image'] },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 1000000, maxTokens: 65536, reasoningEffort: 'high', inputModalities: ['text'] },
    ],
    thinking: 'enabled',
    reasoningEffort: 'high',
    maxTokens: 65536,
    streamIdleTimeoutMs: 300000,
    maxInlineRequestImageBytes: 20 * 1024 * 1024,
    maxImagesPerRequest: 600,
    inlineImageOffloadByteQuantum: 10 * 1024 * 1024,
    imageOffloadCountQuantum: 20,
    // Files path bounds and policy mirror the upstream Chat defaults.
    maxRequestFilesBytes: 128 * 1024 * 1024,
    imageOffloadByteQuantum: 64 * 1024 * 1024,
    filesApiTimeoutMs: 60_000,
    filePolicy: { expiresAfterSeconds: 7 * 24 * 60 * 60, refreshMarginSeconds: 60 * 60, quotaCleanupBatch: 100 },
    retryPolicy: {
        mode: 'normal',
        maxRetries: 5,
        // Host default transient codes (packages/llm/llm/src/retry-policy.ts:18-24).
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        initialDelayMs: 500,
        maxDelayMs: 10000,
        jitterRatio: 0.1,
    },
};
/** Merge partial plugin config over the defaults. */
/**
 * Complete a partially configured retry policy. Never returns a partial shape: the host
 * dereferences retryableCodes on every failed request, so a caller-supplied partial policy
 * (for example { mode: "normal", maxRetries: 3 }) must be filled in here.
 */
export function resolveRetryPolicy(policy) {
    const fallback = DEFAULT_CHAT_CONNECTION.retryPolicy;
    if (policy?.mode === 'always') {
        return {
            mode: 'always',
            initialDelayMs: policy.initialDelayMs ?? fallback.initialDelayMs,
            maxDelayMs: policy.maxDelayMs ?? fallback.maxDelayMs,
            jitterRatio: policy.jitterRatio ?? fallback.jitterRatio,
        };
    }
    const configured = policy;
    const requested = configured?.retryableCodes;
    const retryableCodes = Array.isArray(requested) && requested.length > 0 ? [...requested] : [...fallback.retryableCodes];
    return {
        mode: 'normal',
        maxRetries: configured?.maxRetries ?? fallback.maxRetries,
        retryableCodes,
        initialDelayMs: policy?.initialDelayMs ?? fallback.initialDelayMs,
        maxDelayMs: policy?.maxDelayMs ?? fallback.maxDelayMs,
        jitterRatio: policy?.jitterRatio ?? fallback.jitterRatio,
    };
}
export function resolveChatConnection(config = {}) {
    return {
        ...DEFAULT_CHAT_CONNECTION,
        ...config,
        models: config.models ?? DEFAULT_CHAT_CONNECTION.models,
        filePolicy: config.filePolicy ?? DEFAULT_CHAT_CONNECTION.filePolicy,
        retryPolicy: resolveRetryPolicy(config.retryPolicy),
    };
}
/** Advisory catalog row for one configured model. */
export function catalogModelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities },
    };
}
/** Exact-route metadata for one model id (unlisted ids keep id/name only). */
/** Conservative modality claim for an id we do not catalogue: text only. */
export const UNCATALOGUED_MODALITIES = ['text'];
export function modelInfo(connection, provider, model) {
    const entry = connection.models.find(candidate => candidate.id === model);
    const effort = entry?.reasoningEffort ?? connection.reasoningEffort;
    // Every requested id resolves a COMPLETE shape: the host validates provider metadata and
    // downstream consumers read inputModalities/reasoning/context, so an unlisted id must not
    // yield a partial object (that produced a live TypeError before this fix).
    return {
        provider,
        id: model,
        name: entry?.name ?? model,
        ...entry?.description === undefined ? {} : { description: entry.description },
        inputModalities: entry?.inputModalities ?? UNCATALOGUED_MODALITIES,
        context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: entry?.maxTokens ?? connection.maxTokens,
        reasoning: { efforts: CHAT_REASONING_EFFORTS, ...effort === undefined ? {} : { defaultEffort: effort } },
        ...entry?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: entry.systemPromptUpdate },
    };
}
/**
 * Replica of the host default attribution identity: product/url match
 * packages/llm/llm/src/attribution.ts, and the version tracks the DSH baseline this tree
 * was vendored for.
 *
 * This is only the LAST resort. The entry injects the host's own attributionHeaders()
 * (or its APP_IDENTITY.version) when the host module is reachable from the plugin
 * location, so a request normally names the harness version actually running rather than
 * this constant - reporting a version we are not running would misattribute the request.
 */
export const ATTRIBUTION_PRODUCT = 'deepseek-harness';
export const ATTRIBUTION_URL = 'https://github.com/deepseek-ai/deepseek-harness';
export const ATTRIBUTION_VERSION_FALLBACK = '0.1.7-alpha.2';
export function attributionHeaders(version = ATTRIBUTION_VERSION_FALLBACK) {
    return { 'user-agent': ATTRIBUTION_PRODUCT + '/' + version + ' (+' + ATTRIBUTION_URL + ')' };
}
