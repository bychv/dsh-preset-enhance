/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm/src/error.ts (codes and classification)
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports), plugin-owned connection config.
 */
/** Stable machine code carried by every plugin-side LLM failure. */
export type LlmErrorCode = string;

/** Harness error codes this adapter emits (subset of the host vocabulary). */
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED';
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';

/** Extra provider facts attached to a failure for retry and diagnostics. */
export interface LlmErrorDetails {
  cause?: unknown;
  status?: number;
  providerRetryAfterMs?: number;
  requestId?: string;
  offloadImages?: number;
}

/**
 * Error shape the host llm service understands: a stable code plus optional
 * provider details. Mirrors @deepseek-ai/dsh-llm LlmError (structural copy).
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status: number | undefined;
  readonly providerRetryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  readonly offloadImages: number | undefined;

  constructor(message: string, code: LlmErrorCode, details: LlmErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'LlmError';
    this.code = code;
    this.status = details.status;
    this.providerRetryAfterMs = details.providerRetryAfterMs;
    this.requestId = details.requestId;
    this.offloadImages = details.offloadImages;
  }
}

/**
 * Substring classification used by the vendored HTTP error mapping. The host
 * owns the authoritative predicates; these are the same documented markers.
 */
function detailIncludes(detail: string, markers: readonly string[]): boolean {
  const lowered = detail.toLowerCase();
  return markers.some(marker => lowered.includes(marker));
}

const QUOTA_MARKERS = [
  'insufficient balance', 'insufficient_quota', 'quota exceeded', 'exceeded your current quota',
  'account balance', 'billing', 'payment required', 'recharge',
];

const CONTEXT_MARKERS = [
  'context length', 'context_length_exceeded', 'maximum context', 'too many tokens',
  'reduce the length of the messages', 'exceeds the context',
];

export function isQuotaExceededError(detail: string): boolean {
  return detailIncludes(detail, QUOTA_MARKERS);
}

export function isContextWindowExceededError(detail: string): boolean {
  return detailIncludes(detail, CONTEXT_MARKERS);
}

/** HTTP status -> stable code; provider detail refines 400/429 as the host does. */
export function httpErrorCode(status: number, error?: { code?: string; type?: string; message?: string }): string {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 413) return 'INVALID_REQUEST';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}
