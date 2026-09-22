/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm-deepseek/src/protocols/chat-completions/types.ts
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports), plugin-owned connection config.
 */
/** Request body for POST {baseURL}/chat/completions. */
export interface WireRequest {
  model: string;
  messages: WireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'high' | 'max';
  tools?: WireTool[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface WireSystemMessage { role: 'system'; content: string }
export interface WireTextContentPart { type: 'text'; text: string }
export interface WireFileContentPart { type: 'file'; file_id: string }
export interface WireImageUrlContentPart {
  type: 'image_url';
  image_url: { url: string };
}
export type WireImageContentPart = WireFileContentPart | WireImageUrlContentPart;
export type WireUserContentPart = WireTextContentPart | WireImageContentPart;
export interface WireUserMessage {
  role: 'user';
  content: string | WireUserContentPart[];
}
export interface WireToolMessage {
  role: 'tool';
  tool_call_id: string;
  /**
   * Upstream typed this as a bare string. Measured against the live provider
   * (api.deepseek.com/chat/completions, deepseek-flash): a tool message whose content is a
   * content-part array carrying image_url is accepted (200), while the same part in an
   * assistant or system message is rejected ("Image in assistant message is not supported",
   * "Image in system message is unsupported"). Widen accordingly so a tool that returns an
   * image can keep it on its own tool_call_id.
   */
  content: string | WireUserContentPart[];
}
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface WireAssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: WireToolCall[];
}
export type WireMessage = WireSystemMessage | WireUserMessage | WireAssistantMessage | WireToolMessage;
export interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}
export interface WireToolCallDelta {
  index: number;
  id?: string | null;
  type?: 'function';
  function?: { name?: string | null; arguments?: string | null };
}
export interface WireDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: WireToolCallDelta[];
}
export interface WireChoice { delta?: WireDelta; finish_reason?: string | null }
export interface WireChunk { choices?: WireChoice[]; usage?: WireUsage | null }
export interface WireError { error?: { message?: string; type?: string; code?: string } }
