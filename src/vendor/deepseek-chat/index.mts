/**
 * Public surface of the vendored DeepSeek Chat Completions adapter.
 * Plugin entry imports { createDeepSeekChatAdapter, resolveChatConnection,
 * DEEPSEEK_CHAT_PROVIDER_ID, DEEPSEEK_CHAT_PROVIDER_NAME } from here.
 */

export { DeepSeekChatAdapter, createDeepSeekChatAdapter, DEEPSEEK_CHAT_PROVIDER_ID, DEEPSEEK_CHAT_PROVIDER_NAME, DEEPSEEK_CHAT_REGISTRATION } from './adapter.mjs';
export type { DeepSeekChatDependencies } from './adapter.mjs';
export {
  ATTRIBUTION_PRODUCT, ATTRIBUTION_URL, ATTRIBUTION_VERSION_FALLBACK, CHAT_REASONING_EFFORTS,
  DEFAULT_CHAT_CONNECTION, DEFAULT_CONTEXT_WINDOW, UNCATALOGUED_MODALITIES, DEEPSEEK_CHAT_BASE_URL, attributionHeaders, catalogModelInfo, modelInfo, resolveChatConnection, resolveRetryPolicy,
} from './config.mjs';
export type { ChatConnectionConfig, ChatModelConfig } from './config.mjs';
export {
  contentHasImage, offloadedImageText, projectOffloadedImages, requestImageHandleText,
  requiredImageOffload, resolveThinking, serializeMessages, serializeRequest, serializeRequestWithImages,
} from './serialize.mjs';
export type { ImageSerializationOptions, ImageRequestRepresentation, RequestDefaults } from './serialize.mjs';
export { DONE, createSseDecoder, parseSse } from './sse.mjs';
export { mapFinishReason, mapUsage, translate } from './translate.mjs';
export { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, QUOTA_EXCEEDED_CODE, httpErrorCode } from './errors.mjs';
export type { LlmErrorCode, LlmErrorDetails } from './errors.mjs';
export type { RequestImageAttachment } from './host-types.mjs';

export { DeepSeekFileId, DeepSeekFileScope } from './file-id.mjs';
export type { AttachmentId, ImageVariantId } from './file-id.mjs';
export { MESSAGES_FILES_BETA, messagesApiRoot } from './messages-api.mjs';
export type { DeepSeekProtocol } from './messages-api.mjs';
export {
  DeepSeekFilesClient, DeepSeekFilesError, MAX_FILE_EXPIRY_SECONDS, MAX_FILE_UPLOAD_BYTES, MAX_STORED_FILE_BYTES,
  MAX_STORED_FILE_COUNT, MIN_FILE_EXPIRY_SECONDS, isFilesQuotaError,
} from './files-api.mjs';
export type { DeepSeekFileObject, DeepSeekFilePage } from './files-api.mjs';
export { DeepSeekUploadIndex, deepSeekFileScope } from './upload-index.mjs';
export type { DeepSeekUploadRecord, UploadIndexCommit } from './upload-index.mjs';
export { DeepSeekFileStore, MAX_IMAGE_BYTES, deepSeekFilesIndexPath } from './file-store.mjs';
export type { DeepSeekFileConnection, DeepSeekFilePolicy, DeepSeekFileReference, DeepSeekFileStoreOptions } from './file-store.mjs';
export { FileResolutionFailure, RequestFiles } from './request-files.mjs';
export type { ImageWireLocation } from './request-files.mjs';
export type { ImageMediaType } from './host-types.mjs';

export {
  DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET, DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES, REQUEST_IMAGE_MAX_DIMENSION, deepSeekImageRequestPricing, deepSeekImageTokens,
  deepSeekRequestImageDimensions, longEdgeDimensions, requestImageDimensions, resolveRequestImageMaxBytes,
  resolveRequestImageTarget, textOnlyImageText,
} from './pricing.mjs';
export type { ProjectedDimensions } from './pricing.mjs';
export type { LlmErrorFactory } from './host-types.mjs';
