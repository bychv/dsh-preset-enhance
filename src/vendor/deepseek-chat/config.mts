/**
 * Plugin-owned connection config for the vendored DeepSeek Chat adapter.
 * Upstream basis: dsh-v0.1.6-alpha.2 packages/llm/llm-deepseek/src/common/{model-info,types,defaults}.ts
 * and packages/llm/llm/src/attribution.ts. MIT licensed upstream; Copyright (c) DeepSeek.
 */

import type { DeepSeekFilePolicy } from './file-store.mjs';
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality, ResolvedNormalRetryPolicy, ResolvedRetryPolicy } from './host-types.mjs';

/** Official Chat Completions root. Never the /anthropic Messages base. */
export const DEEPSEEK_CHAT_BASE_URL = 'https://api.deepseek.com';

/** One model route declared by the plugin connection config. */
export interface ChatModelConfig {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
  inputModalities?: readonly ModelModality[];
  /** Provider pixel budget for request images: published grid when absent, 'low' for low detail. */
  imagePixelBudget?: 'low' | number;
  /** Per-route encoded-byte target for every request image. */
  imageMaxBytes?: number;
  systemPromptUpdate?: 'in-history';
}

/** Complete connection facts for one request generation. */
export interface ChatConnectionConfig {
  baseURL: string;
  models: readonly ChatModelConfig[];
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
  maxTokens: number;
  streamIdleTimeoutMs: number;
  maxInlineRequestImageBytes: number;
  maxImagesPerRequest?: number;
  inlineImageOffloadByteQuantum?: number;
  imageOffloadCountQuantum?: number;
  /** Maximum accumulated file-referenced image bytes in one request (Files path bound). */
  maxRequestFilesBytes: number;
  /** Raw-byte removal step after the file-reference bound is exceeded. */
  imageOffloadByteQuantum: number;
  /** Maximum duration of one request-image Files API resolution. */
  filesApiTimeoutMs: number;
  /** Upload expiry, refresh, and quota-recovery policy. */
  filePolicy: DeepSeekFilePolicy;
  retryPolicy: ResolvedRetryPolicy;
}

/** Reasoning levels the Chat wire accepts (off is expressed as thinking disabled). */
export const CHAT_REASONING_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as const;

/** Defaults for the plugin Chat connection (model ids and caps are config-overridable). */
/** Context capacity assumed for an id the plugin does not catalogue. */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

export const DEFAULT_CHAT_CONNECTION: ChatConnectionConfig = {
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
export function resolveRetryPolicy(policy?: Partial<ResolvedRetryPolicy>): ResolvedRetryPolicy {
  const fallback = DEFAULT_CHAT_CONNECTION.retryPolicy as ResolvedNormalRetryPolicy;
  if (policy?.mode === 'always') {
    return {
      mode: 'always',
      initialDelayMs: policy.initialDelayMs ?? fallback.initialDelayMs,
      maxDelayMs: policy.maxDelayMs ?? fallback.maxDelayMs,
      jitterRatio: policy.jitterRatio ?? fallback.jitterRatio,
    };
  }
  const configured = policy as Partial<ResolvedNormalRetryPolicy> | undefined;
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

export function resolveChatConnection(config: Partial<ChatConnectionConfig> = {}): ChatConnectionConfig {
  return {
    ...DEFAULT_CHAT_CONNECTION,
    ...config,
    models: config.models ?? DEFAULT_CHAT_CONNECTION.models,
    filePolicy: config.filePolicy ?? DEFAULT_CHAT_CONNECTION.filePolicy,
    retryPolicy: resolveRetryPolicy(config.retryPolicy),
  };
}

/** Advisory catalog row for one configured model. */
export function catalogModelInfo(provider: string, model: ChatModelConfig): LlmModelInfo {
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
export const UNCATALOGUED_MODALITIES: readonly ModelModality[] = ['text'];

export function modelInfo(connection: ChatConnectionConfig, provider: string, model: string): LlmResolvedModelInfo {
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
 * Replica of the host default attribution identity. product/url match
 * packages/llm/llm/src/attribution.ts of the pinned 0.1.7 clone; the version is
 * injectable so the caller can supply the real host value when reachable.
 */
export const ATTRIBUTION_PRODUCT = 'deepseek-harness';
export const ATTRIBUTION_URL = 'https://github.com/deepseek-ai/deepseek-harness';
export const ATTRIBUTION_VERSION_FALLBACK = '0.1.7-alpha.1';

export function attributionHeaders(version: string = ATTRIBUTION_VERSION_FALLBACK): Record<string, string> {
  return { 'user-agent': ATTRIBUTION_PRODUCT + '/' + version + ' (+' + ATTRIBUTION_URL + ')' };
}