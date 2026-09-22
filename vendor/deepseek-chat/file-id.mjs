/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/file-id.ts, plus the attachment identity
 * brands it exchanges (packages/attachment/attachment/src/brand.ts).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * the plugin has no @deepseek-ai/* dependency, so the branded identities are
 * declared here as structural string brands instead of importing dsh-brand.
 */
/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - non-empty Files API identifier.
 * @returns the same string with its provider identity attached at type level.
 */
export function DeepSeekFileId(id) {
    return id;
}
/**
 * Brand a locally derived namespace digest.
 * @param scope - SHA-256 digest of endpoint and API key.
 * @returns the same string with namespace identity attached at type level.
 */
export function DeepSeekFileScope(scope) {
    return scope;
}
