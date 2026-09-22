/**
 * Plugin-owned connection config for the vendored DeepSeek Chat adapter.
 * Upstream basis: dsh-v0.1.6-alpha.2 packages/llm/llm-deepseek/src/common/{model-info,types,defaults}.ts
 * and packages/llm/llm/src/attribution.ts. MIT licensed upstream; Copyright (c) DeepSeek.
 */

import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality, RetryPolicy } from './host-types.mjs';

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
  retryPolicy: RetryPolicy;
}

/** Reasoning levels the Chat wire accepts (off is expressed as thinking disabled). */
export const CHAT_REASONING_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as const;

/** Defaults for the plugin Chat connection (model ids and caps are config-overridable). */
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
  retryPolicy: { mode: 'normal', maxRetries: 5, baseDelayMs: 500 },
};

/** Merge partial plugin config over the defaults. */
export function resolveChatConnection(config: Partial<ChatConnectionConfig> = {}): ChatConnectionConfig {
  return {
    ...DEFAULT_CHAT_CONNECTION,
    ...config,
    models: config.models ?? DEFAULT_CHAT_CONNECTION.models,
    retryPolicy: config.retryPolicy ?? DEFAULT_CHAT_CONNECTION.retryPolicy,
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
export function modelInfo(connection: ChatConnectionConfig, provider: string, model: string): LlmResolvedModelInfo {
  const entry = connection.models.find(candidate => candidate.id === model);
  const base: LlmResolvedModelInfo = { provider, id: model, name: entry?.name ?? model };
  if (entry === undefined) return base;
  const effort = entry.reasoningEffort ?? connection.reasoningEffort;
  const reasoning = effort === undefined ? undefined : { efforts: CHAT_REASONING_EFFORTS, defaultEffort: effort };
  return {
    ...base,
    ...entry.description === undefined ? {} : { description: entry.description },
    ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
    ...entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } },
    ...entry.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens },
    ...reasoning === undefined ? {} : { reasoning },
    ...entry.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: entry.systemPromptUpdate },
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
