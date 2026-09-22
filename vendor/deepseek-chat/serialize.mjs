/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm-deepseek/src/protocols/chat-completions/serialize.ts and the
 * packages/llm/llm/src/content.ts helpers it calls (re-implemented locally).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1.
 */
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from './errors.mjs';
/** True when typed model content contains an image block. */
export function contentHasImage(content) {
    return content.some(block => block.type === 'image');
}
/** Stable identity text for one durable image reference (replica of the host helper). */
export function imageIdentity(ref) {
    const named = typeof ref.name === 'string' && ref.name.length > 0 ? ' (' + ref.name + ')' : '';
    return 'image ' + ref.attachmentId + named;
}
/** Read-only recovery path text (replica of the host helper). */
function normalizedAccessText(ref, access) {
    const path = typeof access.readonlyPath === 'string' ? access.readonlyPath : typeof access.path === 'string' ? access.path : '';
    return path.length === 0 ? '' : ' It is saved read-only at ' + path + '.';
}
/** Handle text sent beside a retained request image (replica of requestImageHandleText). */
export function requestImageHandleText(ref, version, access) {
    const width = version.width ?? 0;
    const height = version.height ?? 0;
    const preview = 'Image ' + imageIdentity(ref) + '; request preview ' + width + 'x' + height + 'px.';
    return access === undefined
        ? preview + ' It may be resized or re-encoded; source dimensions, format, and byte size may differ.'
        : preview + normalizedAccessText(ref, access);
}
/** Placeholder text for an offloaded image (replica of offloadedImageText). */
export function offloadedImageText(ref, access) {
    const identity = 'image omitted to fit request image limits; ' + imageIdentity(ref) + '.';
    if (access === undefined) {
        return '[' + identity + ' No local normalized image path is available; ask the user to attach it again if needed.]';
    }
    return '[' + identity + normalizedAccessText(ref, access) + ']';
}
/** Replace offloaded image occurrences with placeholder text. */
export function projectOffloadedImages(messages, placeholder) {
    return messages.map(message => {
        let changed = false;
        const content = [];
        for (const block of message.content) {
            if (block.type === 'image' && block.offloaded === true) {
                changed = true;
                content.push({ type: 'text', text: placeholder(block.attachment) });
            }
            else
                content.push(block);
        }
        return changed ? { ...message, content } : message;
    });
}
/** Base64 length of one byte count, as the wire representation measures it. */
function base64Length(bytes) {
    return Math.ceil(bytes / 3) * 4;
}
function offloadedImagePrefixCount(lengths, budget) {
    const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
    const excessCount = budget.maxImagesPerRequest === undefined ? 0 : Math.max(0, lengths.length - budget.maxImagesPerRequest);
    const excessBytes = Math.max(0, total - budget.maxRequestImageBytes);
    if (excessCount === 0 && excessBytes === 0)
        return 0;
    const countQuantum = budget.countQuantum ?? 1;
    const byteQuantum = budget.byteQuantum ?? 1;
    const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
    const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
    let count = 0;
    let removedBytes = 0;
    for (const imageBytes of lengths) {
        const byteTargetMet = removeBytes === 0
            || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes);
        if (count >= removeCount && byteTargetMet)
            break;
        removedBytes += imageBytes;
        count += 1;
    }
    return count;
}
/** Number of leading retained occurrences still to offload before the request fits. */
export function requiredImageOffload(messages, budget, versionBytes) {
    const lengths = [];
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'tool-result') {
                for (const nested of block.content) {
                    if (nested.type === 'image' && nested.offloaded !== true)
                        lengths.push(base64Length(versionBytes(nested)));
                }
                continue;
            }
            if (block.type === 'image' && block.offloaded !== true)
                lengths.push(base64Length(versionBytes(block)));
        }
    }
    return offloadedImagePrefixCount(lengths, budget);
}
/** Validate the adapter-owned effort before resolving wire fields. */
function reasoningEffort(effort) {
    if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max')
        return effort;
    throw new LlmError('DeepSeek does not support reasoning effort "' + effort + '"', 'UNSUPPORTED_REASONING_EFFORT');
}
/** Resolve one legal thinking/effort pair without exposing off as a wire effort. */
export function resolveThinking(options, defaults) {
    if (options.purpose === 'session-title')
        return { thinking: 'disabled' };
    const effort = options.reasoningEffort === undefined ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
    if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
        throw new LlmError('DeepSeek deployment does not support reasoning effort "' + effort + '"', 'UNSUPPORTED_REASONING_EFFORT');
    }
    if (effort === 'off')
        return { thinking: 'disabled' };
    if (effort === 'low' || effort === 'high' || effort === 'max')
        return { thinking: 'enabled', reasoningEffort: effort };
    return defaults.thinking === undefined ? {} : { thinking: defaults.thinking };
}
/** Join the text blocks of a message. */
function flattenText(blocks) {
    return blocks
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Eager text-only guard kept for the non-image serialization path. */
function assertTextOnly(blocks) {
    if (contentHasImage(blocks)) {
        throw new LlmError('The DeepSeek chat adapter needs an image-capable serialization path for this content.', 'UNSUPPORTED_CONTENT');
    }
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const reasoning = message.content.flatMap(block => block.type === 'reasoning' ? [String(block.text)] : []).join('');
    const toolCalls = message.content.flatMap(block => {
        if (block.type !== 'tool-call')
            return [];
        const call = block;
        return [{ id: String(call.id), type: 'function', function: { name: String(call.name), arguments: String(call.arguments) } }];
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
/** Serialize the conversation; tool results become standalone role:tool messages. */
export function serializeMessages(messages) {
    const wire = [];
    for (const message of messages) {
        assertTextOnly(message.content);
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            wire.push(serializeAssistant(message));
            continue;
        }
        const toolResults = message.content.filter(block => block.type === 'tool-result');
        const text = flattenText(message.content);
        if (text.length > 0 || toolResults.length === 0)
            wire.push({ role: 'user', content: text });
        for (const result of toolResults) {
            wire.push({
                role: 'tool',
                tool_call_id: String(result.toolCallId),
                content: flattenText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
const EMPTY_FILE_IDS = new Map();
/** Stable key for one 1-based wire location. */
function locationKey(location) {
    return location.message + ':' + location.image;
}
/** Request version for one retained occurrence; refuses an unprepared image. */
function requestImageVersion(block, images) {
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
function imageOccurrences(messages, images) {
    const occurrences = [];
    const walk = (blocks, message, nextImage) => {
        for (const block of blocks) {
            if (block.type === 'image') {
                nextImage.value += 1;
                const image = block;
                occurrences.push({
                    block: image,
                    version: requestImageVersion(image, images),
                    location: { message, image: nextImage.value },
                });
                continue;
            }
            if (block.type === 'tool-result')
                walk(block.content, message, nextImage);
        }
    };
    for (const [index, message] of messages.entries()) {
        if (message.role === 'system' || message.role === 'assistant')
            continue;
        const nextImage = { value: 0 };
        walk(message.content.filter(block => block.type !== 'tool-result'), index + 1, nextImage);
        for (const result of message.content.filter(block => block.type === 'tool-result')) {
            walk(result.content, index + 1, nextImage);
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
async function resolveFileIds(messages, images) {
    const representation = images.representation;
    if (representation.kind !== 'file')
        return EMPTY_FILE_IDS;
    const resolved = new Map();
    for (const occurrence of imageOccurrences(messages, images)) {
        resolved.set(locationKey(occurrence.location), await representation.resolveFileId(occurrence.version, occurrence.block, occurrence.location));
    }
    return resolved;
}
/** The resolved id for one occurrence; the file representation always pre-resolves it. */
function requireFileId(fileIds, location) {
    const fileId = fileIds.get(locationKey(location));
    if (fileId === undefined) {
        throw new LlmError('DeepSeek file id for message ' + location.message + ', image ' + location.image + ' was not resolved.', 'INVALID_REQUEST');
    }
    return fileId;
}
/** One retained image resolved to its text handle plus wire part (file id or inline base64). */
function imageParts(block, images, fileIds, location, precededByContent) {
    const version = requestImageVersion(block, images);
    const image = images.representation.kind === 'file'
        ? { type: 'file', file_id: requireFileId(fileIds, location) }
        : {
            type: 'image_url',
            image_url: { url: 'data:' + version.mediaType + ';base64,' + Buffer.from(version.data).toString('base64') },
        };
    const handle = (precededByContent ? '\n' : '') + requestImageHandleText(block.attachment, version, images.resolveImageAccess?.(block.attachment));
    return [{ type: 'text', text: handle }, image];
}
/** Convert user or nested tool-result blocks into ordered wire parts. */
function contentParts(blocks, images, message, nextImage, fileIds) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            const part = block;
            if (part.text.length > 0)
                parts.push({ type: 'text', text: part.text });
            continue;
        }
        if (block.type === 'image') {
            nextImage.value += 1;
            parts.push(...imageParts(block, images, fileIds, { message, image: nextImage.value }, parts.length > 0));
            continue;
        }
        if (block.type === 'tool-result') {
            parts.push(...contentParts(block.content, images, message, nextImage, fileIds));
            continue;
        }
    }
    return parts;
}
/** Keep text-only user messages on the compact string wire form. */
function userContent(parts) {
    const text = [];
    for (const part of parts) {
        if (part.type !== 'text')
            return [...parts];
        text.push(part.text);
    }
    return text.join('');
}
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
/** Serialize image-capable history after resolving durable attachments. */
export function serializeMessagesWithImages(messages, images, fileIds = EMPTY_FILE_IDS) {
    const wire = [];
    let pendingToolImages = [];
    const flushToolImages = () => {
        if (pendingToolImages.length === 0)
            return;
        wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] });
        pendingToolImages = [];
    };
    for (const [messageIndex, message] of messages.entries()) {
        const nextImage = { value: 0 };
        if (message.role === 'system') {
            flushToolImages();
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            flushToolImages();
            wire.push(serializeAssistant(message));
            continue;
        }
        const regular = message.content.filter(block => block.type !== 'tool-result');
        const toolResults = message.content.filter(block => block.type === 'tool-result');
        const content = userContent(contentParts(regular, images, messageIndex + 1, nextImage, fileIds));
        if (content.length > 0 || toolResults.length === 0) {
            flushToolImages();
            wire.push({ role: 'user', content });
        }
        for (const result of toolResults) {
            const parts = contentParts(result.content, images, messageIndex + 1, nextImage, fileIds);
            const imageOnly = parts.filter((part) => part.type !== 'text');
            const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
            wire.push({ role: 'tool', tool_call_id: String(result.toolCallId), content: text || '(no output)' });
            pendingToolImages.push(...imageOnly);
        }
    }
    flushToolImages();
    return wire;
}
/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(options, messages, defaults) {
    const tools = options.tools?.map(tool => ({
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
export function serializeRequest(options, defaults = {}) {
    const messages = [];
    if (options.system !== undefined)
        messages.push({ role: 'system', content: options.system });
    messages.push(...serializeMessages(options.messages));
    return requestWithMessages(options, messages, defaults);
}
/** Reject a request whose retained occurrences still exceed the inline budget. */
function assertRetainedImagesFit(messages, images) {
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
export function serializeRequestWithImages(options, images, defaults = {}) {
    const requestMessages = projectedImageMessages(options, images);
    if (images.representation.kind === 'base64') {
        return imageRequest(options, requestMessages, images, EMPTY_FILE_IDS, defaults);
    }
    return resolveFileIds(requestMessages, images).then(fileIds => (imageRequest(options, requestMessages, images, fileIds, defaults)));
}
/** Refuse image content in roles the wire cannot carry, then project offloaded occurrences. */
function projectedImageMessages(options, images) {
    for (const message of options.messages) {
        if (message.role !== 'user' && contentHasImage(message.content)) {
            throw new LlmError('The DeepSeek chat adapter cannot represent image content in a ' + message.role + ' message.', 'UNSUPPORTED_CONTENT');
        }
    }
    assertRetainedImagesFit(options.messages, images);
    return projectOffloadedImages(options.messages, ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)));
}
/** Assemble one image-capable request from an already projected history. */
function imageRequest(options, requestMessages, images, fileIds, defaults) {
    const messages = [];
    if (options.system !== undefined)
        messages.push({ role: 'system', content: options.system });
    messages.push(...serializeMessagesWithImages(requestMessages, images, fileIds));
    return requestWithMessages(options, messages, defaults);
}
