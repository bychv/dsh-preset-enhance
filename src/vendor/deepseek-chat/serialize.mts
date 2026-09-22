/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm-deepseek/src/protocols/chat-completions/serialize.ts and the
 * packages/llm/llm/src/content.ts helpers it calls (re-implemented locally).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1.
 */

import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from './errors.mjs';
import type {
  ContentBlock, GenerateOptions, ToolCallBlock, ToolResultBlock, ImageAttachmentAccess, ImageAttachmentRef, ImageBlock,
  Message, RequestImageAttachment,
} from './host-types.mjs';
import type { WireImageContentPart, WireMessage, WireRequest, WireTextContentPart, WireTool, WireUserContentPart } from './wire-types.mjs';
import type { ImageWireLocation } from './request-files.mjs';

/** Adapter-level thinking defaults from the connection config. */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
}

/** Position of one image occurrence in the request's conversation messages (1-based). */
export type { ImageWireLocation } from './request-files.mjs';

/** Provider representation for every retained image in one request. */
export type ImageRequestRepresentation =
  | {
    kind: 'file';
    /** Resolve a retained request version to a reusable DeepSeek file id. */
    resolveFileId: (version: RequestImageAttachment, block: ImageBlock, location: ImageWireLocation) => Promise<string>;
  }
  | { kind: 'base64' };

/** Dependencies required only when the request contains image input. */
export interface ImageSerializationOptions {
  representation: ImageRequestRepresentation;
  requestImages: ReadonlyMap<string, RequestImageAttachment>;
  resolveImageAccess?: (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined;
  maxRequestImageBytes: number;
  maxImagesPerRequest?: number;
  byteQuantum?: number;
  countQuantum?: number;
}

/** True when typed model content contains an image block. */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image');
}

/** Stable identity text for one durable image reference (replica of the host helper). */
export function imageIdentity(ref: ImageAttachmentRef): string {
  const named = typeof ref.name === 'string' && ref.name.length > 0 ? ' (' + ref.name + ')' : '';
  return 'image ' + ref.attachmentId + named;
}

/** Read-only recovery path text (replica of the host helper). */
function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  const path = typeof access.readonlyPath === 'string' ? access.readonlyPath : typeof access.path === 'string' ? access.path : '';
  return path.length === 0 ? '' : ' It is saved read-only at ' + path + '.';
}

/** Handle text sent beside a retained request image (replica of requestImageHandleText). */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: { width?: number; height?: number },
  access?: ImageAttachmentAccess,
): string {
  const width = version.width ?? 0;
  const height = version.height ?? 0;
  const preview = 'Image ' + imageIdentity(ref) + '; request preview ' + width + 'x' + height + 'px.';
  return access === undefined
    ? preview + ' It may be resized or re-encoded; source dimensions, format, and byte size may differ.'
    : preview + normalizedAccessText(ref, access);
}

/** Placeholder text for an offloaded image (replica of offloadedImageText). */
export function offloadedImageText(ref: ImageAttachmentRef, access?: ImageAttachmentAccess): string {
  const identity = 'image omitted to fit request image limits; ' + imageIdentity(ref) + '.';
  if (access === undefined) {
    return '[' + identity + ' No local normalized image path is available; ask the user to attach it again if needed.]';
  }
  return '[' + identity + normalizedAccessText(ref, access) + ']';
}

/** Placeholder text for an image the provider refuses in this message role. */
export function unsupportedRoleImageText(ref: ImageAttachmentRef, access?: ImageAttachmentAccess): string {
  const identity = 'image omitted: the chat-completions provider accepts images only in user and tool messages; ' + imageIdentity(ref) + '.';
  if (access === undefined) {
    return '[' + identity + ' No local normalized image path is available; ask the user to attach it again if needed.]';
  }
  return '[' + identity + normalizedAccessText(ref, access) + ']';
}

/** Replace offloaded image occurrences with placeholder text. */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[] {
  return messages.map(message => {
    let changed = false;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded === true) {
        changed = true;
        content.push({ type: 'text', text: placeholder((block as ImageBlock).attachment) });
      } else content.push(block);
    }
    return changed ? { ...message, content } : message;
  });
}

/** Base64 length of one byte count, as the wire representation measures it. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<ImageSerializationOptions, 'maxImagesPerRequest' | 'maxRequestImageBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
  const excessCount = budget.maxImagesPerRequest === undefined ? 0 : Math.max(0, lengths.length - budget.maxImagesPerRequest);
  const excessBytes = Math.max(0, total - budget.maxRequestImageBytes);
  if (excessCount === 0 && excessBytes === 0) return 0;
  const countQuantum = budget.countQuantum ?? 1;
  const byteQuantum = budget.byteQuantum ?? 1;
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
  let count = 0;
  let removedBytes = 0;
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes);
    if (count >= removeCount && byteTargetMet) break;
    removedBytes += imageBytes;
    count += 1;
  }
  return count;
}

/** Number of leading retained occurrences still to offload before the request fits. */
export function requiredImageOffload(
  messages: readonly Message[],
  budget: Pick<ImageSerializationOptions, 'maxImagesPerRequest' | 'maxRequestImageBytes' | 'countQuantum' | 'byteQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        for (const nested of (block as { content: ContentBlock[] }).content) {
          if (nested.type === 'image' && nested.offloaded !== true) lengths.push(base64Length(versionBytes(nested as ImageBlock)));
        }
        continue;
      }
      if (block.type === 'image' && block.offloaded !== true) lengths.push(base64Length(versionBytes(block as ImageBlock)));
    }
  }
  return offloadedImagePrefixCount(lengths, budget);
}

/** Validate the adapter-owned effort before resolving wire fields. */
function reasoningEffort(effort: string): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') return effort;
  throw new LlmError('DeepSeek does not support reasoning effort "' + effort + '"', 'UNSUPPORTED_REASONING_EFFORT');
}

/** Resolve one legal thinking/effort pair without exposing off as a wire effort. */
export function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' };
  const effort = options.reasoningEffort === undefined ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError('DeepSeek deployment does not support reasoning effort "' + effort + '"', 'UNSUPPORTED_REASONING_EFFORT');
  }
  if (effort === 'off') return { thinking: 'disabled' };
  if (effort === 'low' || effort === 'high' || effort === 'max') return { thinking: 'enabled', reasoningEffort: effort };
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking };
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/** Eager text-only guard kept for the non-image serialization path. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat adapter needs an image-capable serialization path for this content.', 'UNSUPPORTED_CONTENT');
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content);
  const reasoning = message.content.flatMap(block => block.type === 'reasoning' ? [String((block as { text: unknown }).text)] : []).join('');
  const toolCalls = message.content.flatMap(block => {
    if (block.type !== 'tool-call') return [];
    const call = block as ToolCallBlock;
    return [{ id: String(call.id), type: 'function' as const, function: { name: String(call.name), arguments: String(call.arguments) } }];
  });
  return {
    role: 'assistant',
    // Text-less turns send "" (never null): a null content with no tool_calls
    // is rejected by the API and would brick every later turn of the session.
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  };
}

/**
 * The call id of one tool message. The host writes camelCase `toolCallId` on the message
 * itself (its tool results are top-level blocks, not nested tool-result blocks); the wire
 * form and older shapes use snake_case `tool_call_id`. Read both.
 */
function toolCallIdOf(message: Message): string | undefined {
  const host = (message as { toolCallId?: unknown }).toolCallId;
  if (typeof host === 'string' && host.length > 0) return host;
  const wire = (message as { tool_call_id?: unknown }).tool_call_id;
  return typeof wire === 'string' && wire.length > 0 ? wire : undefined;
}

/**
 * A tool message without its call id cannot be paired with its tool_calls message. Failing
 * here is honest: emitting it as a user message instead made the provider reject the NEXT
 * request with "insufficient tool messages following tool_calls message".
 */
function requiredToolCallId(message: Message): string {
  const id = toolCallIdOf(message);
  if (id === undefined) {
    throw new LlmError('DeepSeek chat: a ' + message.role + ' message carries no tool call id, so its result cannot be paired.', 'INVALID_REQUEST');
  }
  return id;
}

/** Serialize the conversation; tool results become standalone role:tool messages. */
export function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === 'system') { wire.push({ role: 'system', content: flattenText(message.content) }); continue; }
    if (message.role === 'assistant') { wire.push(serializeAssistant(message)); continue; }
    const toolResults = message.content.filter(block => block.type === 'tool-result');
    const text = flattenText(message.content);
    if (message.role === 'tool' && toolResults.length === 0) {
      wire.push({ role: 'tool', tool_call_id: requiredToolCallId(message), content: text || '(no output)' });
      continue;
    }
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: String((result as ToolResultBlock).toolCallId),
        content: flattenText((result as { content: ContentBlock[] }).content) || '(no output)',
      });
    }
  }
  return wire;
}

/** Resolved file ids keyed by occurrence location (file representation only). */
type ResolvedFileIds = ReadonlyMap<string, string>;

const EMPTY_FILE_IDS: ResolvedFileIds = new Map<string, string>();

/** Stable key for one 1-based wire location. */
function locationKey(location: ImageWireLocation): string {
  return location.message + ':' + location.image;
}

/** One retained image occurrence in wire order, with its true wire location. */
interface ImageOccurrence {
  block: ImageBlock;
  version: RequestImageAttachment;
  location: ImageWireLocation;
}

/** Request version for one retained occurrence; refuses an unprepared image. */
function requestImageVersion(block: ImageBlock, images: ImageSerializationOptions): RequestImageAttachment {
  const version = images.requestImages.get(block.attachment.attachmentId);
  if (version === undefined) {
    throw new LlmError('DeepSeek request image ' + block.attachment.attachmentId + ' was not prepared.', 'INVALID_REQUEST');
  }
  return version;
}

/**
 * Every retained occurrence of one request in the exact order the wire
 * traversal emits them, carrying the same 1-based message index (as upstream)
 * and per-message image counter that contentParts uses for its location.
 */
function imageOccurrences(messages: readonly Message[], images: ImageSerializationOptions): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = [];
  const walk = (blocks: readonly ContentBlock[], message: number, nextImage: { value: number }): void => {
    for (const block of blocks) {
      if (block.type === 'image') {
        nextImage.value += 1;
        const image = block as ImageBlock;
        occurrences.push({
          block: image,
          version: requestImageVersion(image, images),
          location: { message, image: nextImage.value },
        });
        continue;
      }
      if (block.type === 'tool-result') walk((block as { content: ContentBlock[] }).content, message, nextImage);
    }
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' || message.role === 'assistant') continue;
    const nextImage = { value: 0 };
    walk(message.content.filter(block => block.type !== 'tool-result'), index + 1, nextImage);
    for (const result of message.content.filter(block => block.type === 'tool-result')) {
      walk((result as { content: ContentBlock[] }).content, index + 1, nextImage);
    }
  }
  return occurrences;
}

/**
 * Resolve every retained occurrence to a reusable file id before the wire
 * traversal. resolveFileId is asynchronous, so the file representation cannot
 * run inside the synchronous traversal the inline representation keeps for
 * existing callers; the traversal itself still derives the location from its
 * own counters and looks the id up by that location.
 */
async function resolveFileIds(messages: readonly Message[], images: ImageSerializationOptions): Promise<ResolvedFileIds> {
  const representation = images.representation;
  if (representation.kind !== 'file') return EMPTY_FILE_IDS;
  const resolved = new Map<string, string>();
  for (const occurrence of imageOccurrences(messages, images)) {
    resolved.set(locationKey(occurrence.location), await representation.resolveFileId(
      occurrence.version,
      occurrence.block,
      occurrence.location,
    ));
  }
  return resolved;
}

/** The resolved id for one occurrence; the file representation always pre-resolves it. */
function requireFileId(fileIds: ResolvedFileIds, location: ImageWireLocation): string {
  const fileId = fileIds.get(locationKey(location));
  if (fileId === undefined) {
    throw new LlmError(
      'DeepSeek file id for message ' + location.message + ', image ' + location.image + ' was not resolved.',
      'INVALID_REQUEST',
    );
  }
  return fileId;
}

/** One retained image resolved to its text handle plus wire part (file id or inline base64). */
function imageParts(
  block: ImageBlock,
  images: ImageSerializationOptions,
  fileIds: ResolvedFileIds,
  location: ImageWireLocation,
  precededByContent: boolean,
): [WireTextContentPart, WireImageContentPart] {
  const version = requestImageVersion(block, images);
  const image: WireImageContentPart = images.representation.kind === 'file'
    ? { type: 'file', file_id: requireFileId(fileIds, location) }
    : {
      type: 'image_url',
      image_url: { url: 'data:' + version.mediaType + ';base64,' + Buffer.from(version.data).toString('base64') },
    };
  const handle = (precededByContent ? '\n' : '') + requestImageHandleText(block.attachment, version, images.resolveImageAccess?.(block.attachment));
  return [{ type: 'text', text: handle }, image];
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  message: number,
  nextImage: { value: number },
  fileIds: ResolvedFileIds,
): WireUserContentPart[] {
  const parts: WireUserContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') { const part = block as { text: string }; if (part.text.length > 0) parts.push({ type: 'text', text: part.text }); continue; }
    if (block.type === 'image') {
      nextImage.value += 1;
      parts.push(...imageParts(block as ImageBlock, images, fileIds, { message, image: nextImage.value }, parts.length > 0));
      continue;
    }
    if (block.type === 'tool-result') {
      parts.push(...contentParts((block as { content: ContentBlock[] }).content, images, message, nextImage, fileIds));
      continue;
    }
  }
  return parts;
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') return [...parts];
    text.push(part.text);
  }
  return text.join('');
}

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';

/** Serialize image-capable history after resolving durable attachments. */
export function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
  fileIds: ResolvedFileIds = EMPTY_FILE_IDS,
): WireMessage[] {
  const wire: WireMessage[] = [];
  let pendingToolImages: WireImageContentPart[] = [];
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return;
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] });
    pendingToolImages = [];
  };
  for (const [messageIndex, message] of messages.entries()) {
    const nextImage = { value: 0 };
    if (message.role === 'system') { flushToolImages(); wire.push({ role: 'system', content: flattenText(message.content) }); continue; }
    if (message.role === 'assistant') { flushToolImages(); wire.push(serializeAssistant(message)); continue; }
    const regular = message.content.filter(block => block.type !== 'tool-result');
    const toolResults = message.content.filter(block => block.type === 'tool-result');
    // A tool message carrying its own content (an image a tool returned at top level) stays a
    // tool message: the provider accepts images there, so the result keeps its tool_call_id
    // instead of being relocated into a synthetic user turn.
    if (message.role === 'tool' && toolResults.length === 0) {
      flushToolImages();
      const parts = contentParts(regular, images, messageIndex + 1, nextImage, fileIds);
      wire.push({ role: 'tool', tool_call_id: requiredToolCallId(message), content: parts.length === 0 ? '(no output)' : parts });
      continue;
    }
    const content = userContent(contentParts(regular, images, messageIndex + 1, nextImage, fileIds));
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages();
      wire.push({ role: 'user', content });
    }
    for (const result of toolResults) {
      const parts = contentParts((result as { content: ContentBlock[] }).content, images, messageIndex + 1, nextImage, fileIds);
      const imageOnly = parts.filter((part): part is WireImageContentPart => part.type !== 'text');
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
      wire.push({ role: 'tool', tool_call_id: String((result as ToolResultBlock).toolCallId), content: text || '(no output)' });
      pendingToolImages.push(...imageOnly);
    }
  }
  flushToolImages();
  return wire;
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(options: GenerateOptions, messages: WireMessage[], defaults: RequestDefaults): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const resolvedThinking = resolveThinking(options, defaults);
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined ? { reasoning_effort: resolvedThinking.reasoningEffort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  };
}

/** Build the full text-only wire request (always streaming, usage reporting on). */
export function serializeRequest(options: GenerateOptions, defaults: RequestDefaults = {}): WireRequest {
  const messages: WireMessage[] = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  messages.push(...serializeMessages(options.messages));
  return requestWithMessages(options, messages, defaults);
}

/** Reject a request whose retained occurrences still exceed the inline budget. */
function assertRetainedImagesFit(messages: readonly Message[], images: ImageSerializationOptions): void {
  const offloadImages = requiredImageOffload(messages, images, (block) => {
    const version = images.requestImages.get(block.attachment.attachmentId);
    if (version === undefined) {
      throw new LlmError('DeepSeek request image ' + block.attachment.attachmentId + ' was not prepared.', 'INVALID_REQUEST');
    }
    return version.bytes;
  });
  if (offloadImages > 0) {
    throw new LlmError('DeepSeek base64 request images exceed the route budget; ' + offloadImages + ' more oldest occurrence(s) must be offloaded.', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
  }
}

/** Build one image-capable request over the inline base64 representation. */
export function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions & { representation: { kind: 'base64' } },
  defaults?: RequestDefaults,
): WireRequest;
/** Build one image-capable request over the file representation (resolves ids first). */
export function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults?: RequestDefaults,
): WireRequest | Promise<WireRequest>;
export function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
): WireRequest | Promise<WireRequest> {
  const requestMessages = projectedImageMessages(options, images);
  if (images.representation.kind === 'base64') {
    return imageRequest(options, requestMessages, images, EMPTY_FILE_IDS, defaults);
  }
  return resolveFileIds(requestMessages, images).then(fileIds => (
    imageRequest(options, requestMessages, images, fileIds, defaults)
  ));
}

/**
 * The chat wire carries images only in user messages, but the host can legitimately put one
 * in another role - a file-reading tool returns the image inside its tool result. Upstream
 * refused the whole request there (0.1.6 serialize.ts:112); we substitute the same
 * deterministic placeholder the offload path uses instead, so an otherwise valid
 * conversation is not lost. Substituted occurrences are gone before the budget check, so
 * they neither count against the inline budget nor ask the host to offload a real image.
 */
function projectForeignRoleImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[] {
  return messages.map(message => {
    // Measured against the live provider: images are accepted in user and tool messages, and
    // rejected in both assistant ('Image in assistant message is not supported') and system
    // ('Image in system message is unsupported'). Only the rejected roles degrade here.
    if (message.role === 'user' || message.role === 'tool') return message;
    let changed = false;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'image') {
        changed = true;
        content.push({ type: 'text', text: placeholder((block as ImageBlock).attachment) });
        continue;
      }
      const nested = (block as { content?: readonly ContentBlock[] }).content;
      if (block.type === 'tool-result' && Array.isArray(nested) && nested.some(inner => inner.type === 'image')) {
        changed = true;
        content.push({
          ...block,
          content: nested.map(inner => inner.type === 'image'
            ? { type: 'text', text: placeholder((inner as ImageBlock).attachment) }
            : inner),
        } as ContentBlock);
        continue;
      }
      content.push(block);
    }
    return changed ? { ...message, content } : message;
  });
}

/** Make every image wire-legal for its role, then project offloaded occurrences. */
function projectedImageMessages(options: GenerateOptions, images: ImageSerializationOptions): readonly Message[] {
  const access = (ref: ImageAttachmentRef) => images.resolveImageAccess?.(ref);
  const roleLegal = projectForeignRoleImages(options.messages, ref => unsupportedRoleImageText(ref, access(ref)));
  assertRetainedImagesFit(roleLegal, images);
  return projectOffloadedImages(roleLegal, ref => offloadedImageText(ref, access(ref)));
}

/** Assemble one image-capable request from an already projected history. */
function imageRequest(
  options: GenerateOptions,
  requestMessages: readonly Message[],
  images: ImageSerializationOptions,
  fileIds: ResolvedFileIds,
  defaults: RequestDefaults,
): WireRequest {
  const messages: WireMessage[] = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  messages.push(...serializeMessagesWithImages(requestMessages, images, fileIds));
  return requestWithMessages(options, messages, defaults);
}