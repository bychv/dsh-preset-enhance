/**
 * Public surface of the vendored DeepSeek Chat Completions adapter.
 * Plugin entry imports { createDeepSeekChatAdapter, resolveChatConnection,
 * DEEPSEEK_CHAT_PROVIDER_ID, DEEPSEEK_CHAT_PROVIDER_NAME } from here.
 */

export { DeepSeekChatAdapter, createDeepSeekChatAdapter, DEEPSEEK_CHAT_PROVIDER_ID, DEEPSEEK_CHAT_PROVIDER_NAME, DEEPSEEK_CHAT_REGISTRATION } from './adapter.mjs';
export type { DeepSeekChatDependencies } from './adapter.mjs';
export {
  ATTRIBUTION_PRODUCT, ATTRIBUTION_URL, ATTRIBUTION_VERSION_FALLBACK, CHAT_REASONING_EFFORTS,
  DEFAULT_CHAT_CONNECTION, DEEPSEEK_CHAT_BASE_URL, attributionHeaders, catalogModelInfo, modelInfo, resolveChatConnection,
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

