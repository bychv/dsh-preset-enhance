/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm/src/types.ts, content.ts, retry-policy.ts (structural replica).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1.
 */

/*
 * Minimal structural replica of the DSH 0.1.7-alpha.1 host LLM surface consumed and
 * returned by this adapter. The plugin has no build-time @deepseek-ai/* dependency, and
 * host registerAdapter() duck-types its adapter (it only calls providerInfo and
 * providerRetryPolicy before validating id/name), so a structural replica plus one cast at
 * the registration site is sufficient. Keep aligned with packages/llm/llm/src/{types,index}.ts.
 */

export type ModelModality = 'text' | 'image';

/** Encoded image media types the DeepSeek Files API accepts for a request image. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface TextBlock { type: 'text'; text: string }
export interface ReasoningBlock { type: 'reasoning'; text: string }

export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  width?: number;
  height?: number;
  name?: string;
  byteSize?: number;
  [key: string]: unknown;
}
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true }
export interface ToolCallBlock { type: 'tool-call'; id: string; name: string; arguments: string }
export interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: string;
  content: ContentBlock[];
  isError?: boolean;
}
export interface FileBlock { type: 'file'; attachment: { attachmentId: string; name?: string } }
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | FileBlock
  | { type: string; [key: string]: unknown };

export interface Message { role: string; content: ContentBlock[] }

export interface RequestImageAttachment {
  mediaType: string;
  data: Uint8Array;
  bytes: number;
  width?: number;
  height?: number;
  /**
   * Durable normalized attachment this request version was derived from.
   * Optional because the inline base64 path never needs it; the Files upload
   * path requires it (and fails the request cleanly when it is absent).
   */
  attachment?: ImageAttachmentRef;
  /** Complete request-image transformation identity; required by the Files upload path. */
  variantId?: string;
  /** Whether the encoded request version retains an alpha channel (diagnostics only). */
  hasAlpha?: boolean;
}

/** Read-only description of one current image occurrence, for handle text. */
export interface ImageAttachmentAccess {
  /** Read-only execution-world path of the normalized copy. */
  readonlyPath?: string;
  /** Legacy alias accepted alongside readonlyPath. */
  path?: string;
  [key: string]: unknown;
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure };

export interface LlmFailure { message: string; code: string; [key: string]: unknown }

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferLoading?: true;
}

export interface GenerateOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  messages: Message[];
  system?: string;
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  sessionId?: string;
  purpose?: 'compaction' | 'session-title';
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };

export interface ReplayEnvelope { response: unknown; blocks?: readonly unknown[] }
export interface LlmProviderInfo { id: string; name: string }

export interface LlmModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
  inputModalities?: readonly ModelModality[];
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number };
  defaultMaxTokens?: number;
  reasoning?: { efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string };
  systemPromptUpdate?: 'in-history';
}

export interface LlmImageRequestPrice { visualTokens: number; text: string }
export interface LlmImageRequestPricing {
  priceImages(images: readonly ImageBlock[]): readonly LlmImageRequestPrice[];
}

/**
 * Resolved retry policy replica (host: packages/llm/llm/src/retry-policy.ts:60-79).
 * The host retry plugin reads policy.retryableCodes.includes(code) for a normal-mode
 * policy (packages/llm/llm-retry/src/index.ts:215), so every field below MUST be present:
 * a partial policy throws "Cannot read properties of undefined (reading 'includes')"
 * exactly when a provider request fails.
 */
export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal';
  readonly maxRetries: number;
  readonly retryableCodes: readonly string[];
}
export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always';
}
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy;

export interface PreparedAdapterCall {
  model: LlmResolvedModelInfo;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

export type AttributionHeaders = () => Record<string, string>;
