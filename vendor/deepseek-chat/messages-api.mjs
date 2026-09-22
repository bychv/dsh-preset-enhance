/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/messages-api.ts.
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports); the shared protocol identity that
 * upstream imports from common/types.ts is declared here beside the endpoint
 * policy that consumes it.
 */
/** Required opt-in for Messages file operations and file-referenced image requests. */
export const MESSAGES_FILES_BETA = 'files-api-2025-04-14';
/**
 * Resolve the API root without duplicating an explicit provider version path.
 * @param baseURL - validated configured endpoint root.
 * @returns the root beneath which Messages resources are exposed.
 */
export function messagesApiRoot(baseURL) {
    const base = baseURL.replace(/\/+$/u, '');
    return new URL(base).pathname.endsWith('/v1') ? base : base + '/v1';
}
