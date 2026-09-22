/** Harness error codes this adapter emits (subset of the host vocabulary). */
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED';
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';
/**
 * Error shape the host llm service understands: a stable code plus optional
 * provider details. Mirrors @deepseek-ai/dsh-llm LlmError (structural copy).
 */
export class LlmError extends Error {
    code;
    status;
    providerRetryAfterMs;
    requestId;
    offloadImages;
    /**
      * Serializable facts the host reads off the live error: agent-loop normalizes a turn failure
      * with `error instanceof LlmError ? error.failure : { message: errorChain(error), code: "UNKNOWN" }`
      * (packages/core/agent-loop/src/agent.ts:359-361), and the host LlmError freezes exactly this shape
      * (packages/llm/llm/src/index.ts:120-127). Keep it identical so the code survives the boundary.
      */
    failure;
    constructor(message, code, details = {}) {
        super(message, details.cause === undefined ? undefined : { cause: details.cause });
        this.name = 'LlmError';
        this.code = code;
        this.status = details.status;
        this.providerRetryAfterMs = details.providerRetryAfterMs;
        this.requestId = details.requestId;
        this.offloadImages = details.offloadImages;
        this.failure = Object.freeze({
            message,
            code,
            ...details.status === undefined ? {} : { status: details.status },
            ...details.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: details.providerRetryAfterMs },
            ...details.requestId === undefined ? {} : { requestId: details.requestId },
            ...details.offloadImages === undefined ? {} : { offloadImages: details.offloadImages },
        });
    }
}
/**
 * Substring classification used by the vendored HTTP error mapping. The host
 * owns the authoritative predicates; these are the same documented markers.
 */
function detailIncludes(detail, markers) {
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
export function isQuotaExceededError(detail) {
    return detailIncludes(detail, QUOTA_MARKERS);
}
export function isContextWindowExceededError(detail) {
    return detailIncludes(detail, CONTEXT_MARKERS);
}
/** HTTP status -> stable code; provider detail refines 400/429 as the host does. */
export function httpErrorCode(status, error) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 413)
        return 'INVALID_REQUEST';
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
