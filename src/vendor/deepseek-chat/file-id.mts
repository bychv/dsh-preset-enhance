/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/file-id.ts, plus the attachment identity
 * brands it exchanges (packages/attachment/attachment/src/brand.ts).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * the plugin has no @deepseek-ai/* dependency, so the branded identities are
 * declared here as structural string brands instead of importing dsh-brand.
 */

/** Opaque identifier returned by the DeepSeek Files API. */
export type DeepSeekFileId = string & { readonly __deepSeekFileId: 'DeepSeekFileId' };

/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - non-empty Files API identifier.
 * @returns the same string with its provider identity attached at type level.
 */
export function DeepSeekFileId(id: string): DeepSeekFileId {
  return id as DeepSeekFileId;
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type DeepSeekFileScope = string & { readonly __deepSeekFileScope: 'DeepSeekFileScope' };

/**
 * Brand a locally derived namespace digest.
 * @param scope - SHA-256 digest of endpoint and API key.
 * @returns the same string with namespace identity attached at type level.
 */
export function DeepSeekFileScope(scope: string): DeepSeekFileScope {
  return scope as DeepSeekFileScope;
}

/** Provider-independent normalized attachment identity (sha256:<64 hex>). */
export type AttachmentId = string;

/** Complete request-image transformation identity (sha256:<64 hex>). */
export type ImageVariantId = string;
