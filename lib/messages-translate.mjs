function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return '';
}
/** Collects de-duplicated translation notes. */
class Notes {
    items = [];
    seen = new Set();
    add(field, detail) {
        const key = field + '\u0000' + detail;
        if (this.seen.has(key))
            return;
        this.seen.add(key);
        this.items.push({ field, detail });
    }
    list() {
        return this.items;
    }
}
function contentBlocks(content) {
    if (typeof content === 'string')
        return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content : [];
}
function joinText(blocks) {
    let out = '';
    for (const block of blocks)
        if (isObject(block) && block.type === 'text')
            out += text(block.text);
    return out;
}
function noteCacheControl(block, note) {
    if (block.cache_control !== undefined) {
        note('cache_control', '缓存提示是 Anthropic 专有字段，Chat Completions 无对应能力，已丢弃。');
    }
}
function noteUnsupportedBlock(block, role, note) {
    note(role + ' block ' + String(block.type), 'Chat Completions 没有对应内容类型，已丢弃。');
}
/* --------------------------------------------------------------- request side */
function systemText(system, note) {
    if (typeof system === 'string')
        return system;
    if (!Array.isArray(system)) {
        if (system != null)
            note('system', '无法识别的 system 形态，已丢弃。');
        return '';
    }
    let out = '';
    for (const raw of system) {
        if (!isObject(raw)) {
            note('system[]', '非对象 system 块已丢弃。');
            continue;
        }
        if (raw.type === 'text') {
            out += text(raw.text);
            noteCacheControl(raw, note);
            continue;
        }
        noteUnsupportedBlock(raw, 'system', note);
    }
    return out;
}
function toolResultText(content, note) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return content == null ? '' : text(content);
    let out = '';
    for (const raw of content) {
        if (!isObject(raw))
            continue;
        if (raw.type === 'text') {
            out += text(raw.text);
            noteCacheControl(raw, note);
            continue;
        }
        if (raw.type === 'image') {
            note('tool_result image', 'Chat Completions 的工具消息只能携带文本，工具结果中的图片已丢弃。');
            continue;
        }
        noteUnsupportedBlock(raw, 'tool_result', note);
    }
    return out;
}
function imagePart(block, note) {
    const source = isObject(block.source) ? block.source : {};
    if (source.type === 'base64') {
        const mediaType = text(source.media_type) || 'application/octet-stream';
        return { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + text(source.data) } };
    }
    if (source.type === 'file')
        return { type: 'file', file_id: text(source.file_id) };
    if (source.type === 'url')
        return { type: 'image_url', image_url: { url: text(source.url) } };
    note('image.source.type=' + String(source.type), '无法映射为 Chat Completions 图片，已丢弃。');
    return null;
}
function userParts(blocks, note) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            if (text(block.text).length > 0)
                parts.push({ type: 'text', text: text(block.text) });
            noteCacheControl(block, note);
            continue;
        }
        if (block.type === 'image') {
            const part = imagePart(block, note);
            if (part)
                parts.push(part);
            noteCacheControl(block, note);
            continue;
        }
        noteUnsupportedBlock(block, 'user', note);
    }
    return parts;
}
function assistantMessage(blocks, note) {
    let body = '';
    let reasoning = '';
    const toolCalls = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            body += text(block.text);
            noteCacheControl(block, note);
            continue;
        }
        if (block.type === 'thinking') {
            reasoning += text(block.thinking);
            if (block.signature !== undefined) {
                note('thinking.signature', 'Anthropic 思考签名没有 Chat Completions 对应字段，已丢弃（宿主会按 reasoning_content 重新推导）。');
            }
            continue;
        }
        if (block.type === 'redacted_thinking') {
            note('redacted_thinking', 'Chat Completions 无法回传加密思考块，已丢弃。');
            continue;
        }
        if (block.type === 'tool_use') {
            const input = isObject(block.input) ? block.input : {};
            if (!isObject(block.input) && block.input !== undefined) {
                note('tool_use.input', '非对象工具参数按空对象发送。');
            }
            toolCalls.push({
                id: text(block.id),
                type: 'function',
                function: { name: text(block.name), arguments: JSON.stringify(input) },
            });
            continue;
        }
        noteUnsupportedBlock(block, 'assistant', note);
    }
    // Mirror the host chat-completions serializer: assistant content is always a
    // JSON string (empty on tool-call-only turns), never null.
    const message = { role: 'assistant', content: body };
    if (reasoning.length > 0)
        message.reasoning_content = reasoning;
    if (toolCalls.length > 0)
        message.tool_calls = toolCalls;
    return message;
}
function appendMessage(raw, out, note) {
    if (!isObject(raw)) {
        note('messages[]', '非对象消息已丢弃。');
        return;
    }
    const role = raw.role;
    const blocks = contentBlocks(raw.content);
    if (role === 'system') {
        out.push({ role: 'system', content: joinText(blocks) });
        for (const block of blocks)
            if (isObject(block) && block.type !== 'text')
                noteUnsupportedBlock(block, 'system', note);
        return;
    }
    if (role === 'assistant') {
        out.push(assistantMessage(blocks.filter(isObject), note));
        return;
    }
    if (role !== 'user')
        note('messages[].role=' + String(role), '未知角色按 user 处理。');
    const toolResults = [];
    const regular = [];
    for (const block of blocks) {
        if (!isObject(block))
            continue;
        if (block.type === 'tool_result')
            toolResults.push(block);
        else
            regular.push(block);
    }
    // Anthropic puts tool results first in a user turn (the host Messages
    // serializer reorders them that way); chat/completions wants the matching
    // role:'tool' messages directly after the assistant tool_calls, so first.
    for (const result of toolResults) {
        if (result.is_error !== undefined) {
            note('tool_result.is_error', 'Chat Completions 的工具消息没有错误标记，已丢弃。');
        }
        const content = toolResultText(result.content, note);
        out.push({ role: 'tool', tool_call_id: text(result.tool_use_id), content: content || '(no output)' });
    }
    const parts = userParts(regular, note);
    if (parts.length > 0 || toolResults.length === 0) {
        const onlyText = parts.length > 0 && parts.every(part => part.type === 'text');
        out.push({ role: 'user', content: onlyText ? parts.map(part => text(part.text)).join('') : parts });
    }
}
function toolsOf(raw, note) {
    const tools = [];
    for (const tool of raw) {
        if (!isObject(tool)) {
            note('tools[]', '非对象工具定义已丢弃。');
            continue;
        }
        if (tool.type !== undefined && tool.type !== 'custom') {
            note('tools[].type=' + String(tool.type), 'Chat Completions 仅支持函数工具，已丢弃。');
            continue;
        }
        noteCacheControl(tool, note);
        tools.push({
            type: 'function',
            function: {
                name: text(tool.name),
                description: text(tool.description),
                parameters: isObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
            },
        });
    }
    return tools;
}
/**
 * Map one Anthropic tool_choice onto the chat/completions vocabulary.
 * auto -> auto, any -> required, tool -> function, none -> none;
 * disable_parallel_tool_use becomes parallel_tool_calls: false.
 */
export function mapToolChoice(choice, note) {
    if (!isObject(choice))
        return undefined;
    let mapped;
    if (choice.type === 'auto')
        mapped = { type: 'auto' };
    else if (choice.type === 'none')
        mapped = { type: 'none' };
    else if (choice.type === 'any')
        mapped = { type: 'required' };
    else if (choice.type === 'tool')
        mapped = { type: 'function', function: { name: text(choice.name) } };
    else {
        note('tool_choice.type=' + String(choice.type), 'Chat Completions 没有对应 tool_choice，已丢弃。');
        return undefined;
    }
    if (choice.disable_parallel_tool_use === true)
        mapped.parallel_tool_calls = false;
    return mapped;
}
/**
 * Convert one Anthropic Messages request body into a chat/completions body.
 *
 * Faithfully carried: model, stream (plus stream_options.include_usage),
 * max_tokens, temperature, top_p, stop_sequences -> stop, thinking,
 * output_config.effort -> reasoning_effort, tools -> function tools,
 * tool_choice, system, and every message/block with a chat representation
 * (text, thinking -> reasoning_content, tool_use -> tool_calls, tool_result ->
 * role:'tool'). Anthropic source.url images map to image_url; base64 and file
 * sources map to the host chat-completions representations.
 */
export function messagesRequestToChat(body) {
    const notes = new Notes();
    const note = (field, detail) => notes.add(field, detail);
    const chat = {};
    if (body.model !== undefined)
        chat.model = body.model;
    if (body.stream === false)
        chat.stream = false;
    else {
        chat.stream = true;
        // The host chat-completions adapter always asks for usage; message_delta
        // usage translation depends on it.
        chat.stream_options = { include_usage: true };
    }
    if (body.max_tokens !== undefined)
        chat.max_tokens = body.max_tokens;
    if (body.temperature !== undefined)
        chat.temperature = body.temperature;
    if (body.top_p !== undefined)
        chat.top_p = body.top_p;
    if (body.top_k !== undefined)
        note('top_k', 'Chat Completions 没有 top_k 字段，已丢弃。');
    if (Array.isArray(body.stop_sequences))
        chat.stop = [...body.stop_sequences];
    else if (body.stop_sequences !== undefined)
        note('stop_sequences', '非数组 stop_sequences 已丢弃。');
    if (isObject(body.thinking)) {
        if (body.thinking.type === 'enabled' || body.thinking.type === 'disabled') {
            chat.thinking = { type: body.thinking.type };
        }
        else if (body.thinking.type !== undefined) {
            note('thinking.type=' + String(body.thinking.type), '未知 thinking 类型已丢弃。');
        }
        if (body.thinking.budget_tokens !== undefined) {
            note('thinking.budget_tokens', 'Chat Completions 没有思考预算字段，已丢弃（思考等级由 output_config.effort 决定）。');
        }
    }
    const effort = isObject(body.output_config) ? body.output_config.effort : undefined;
    if (effort === 'low' || effort === 'high' || effort === 'max')
        chat.reasoning_effort = effort;
    else if (effort !== undefined && effort !== 'off') {
        note('output_config.effort=' + String(effort), 'Chat Completions 不支持的思考等级，已丢弃。');
    }
    if (isObject(body.output_config)) {
        for (const key of Object.keys(body.output_config)) {
            if (key !== 'effort')
                note('output_config.' + key, 'Chat Completions 没有对应字段，已丢弃。');
        }
    }
    if (Array.isArray(body.tools)) {
        const tools = toolsOf(body.tools, note);
        if (tools.length > 0)
            chat.tools = tools;
    }
    else if (body.tools !== undefined)
        note('tools', '非数组 tools 已丢弃。');
    const toolChoice = mapToolChoice(body.tool_choice, note);
    if (toolChoice)
        chat.tool_choice = toolChoice;
    const messages = [];
    const system = systemText(body.system, note);
    if (system.length > 0)
        messages.push({ role: 'system', content: system });
    if (Array.isArray(body.messages)) {
        for (const message of body.messages)
            appendMessage(message, messages, note);
    }
    else if (body.messages !== undefined)
        note('messages', '非数组 messages 已丢弃。');
    chat.messages = messages;
    for (const key of ['metadata', 'container', 'mcp_servers', 'service_tier']) {
        if (body[key] !== undefined)
            note(key, 'Anthropic 专有请求字段在 Chat Completions 上没有对应能力，已丢弃。');
    }
    return { body: chat, notes: notes.list() };
}
/* --------------------------------------------------------------- header side */
function headerEntries(headers) {
    if (headers == null)
        return [];
    // Arrays must be handled before the entries() probe: Array.prototype.entries
    // is a function too and would yield [index, element] pairs.
    if (Array.isArray(headers)) {
        const out = [];
        for (const item of headers) {
            if (Array.isArray(item))
                out.push([String(item[0]), String(item[1] ?? '')]);
        }
        return out;
    }
    if (typeof headers === 'object' || typeof headers === 'function') {
        const entries = headers.entries;
        if (typeof entries === 'function') {
            const out = [];
            for (const entry of entries.call(headers)) {
                out.push([String(entry[0]), String(entry[1] ?? '')]);
            }
            return out;
        }
        if (isObject(headers)) {
            return Object.entries(headers).map(([name, value]) => [name, String(value ?? '')]);
        }
    }
    return [];
}
/**
 * Rewrite Messages request headers for the official chat/completions endpoint:
 * x-api-key becomes Authorization: Bearer <key>, the Anthropic-only
 * anthropic-version/anthropic-beta headers and the stale content-length are
 * dropped, content-type is forced to JSON, and every other header
 * (attribution, harness session/user ids, accept) is preserved lower-cased.
 */
export function messagesRequestHeadersToChat(headers) {
    const out = {};
    let apiKey = '';
    for (const [name, value] of headerEntries(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'x-api-key') {
            apiKey = value;
            continue;
        }
        if (lower === 'anthropic-version' || lower === 'anthropic-beta' || lower === 'content-length')
            continue;
        out[lower] = value;
    }
    if (apiKey.length > 0 && out.authorization === undefined)
        out.authorization = 'Bearer ' + apiKey;
    out['content-type'] = 'application/json';
    return out;
}
/* -------------------------------------------------------------- response side */
/**
 * Map a chat/completions finish_reason onto the Anthropic stop_reason set the
 * harness accepts. length -> max_tokens, tool_calls -> tool_use; content_filter
 * and unknown values become end_turn (Chat Completions has no equivalent
 * termination vocabulary).
 */
export function mapChatFinishReason(reason) {
    if (reason === 'length')
        return 'max_tokens';
    if (reason === 'tool_calls')
        return 'tool_use';
    if (reason === 'stop_sequence')
        return 'stop_sequence';
    return 'end_turn';
}
/**
 * Fold one chat usage object into Anthropic counters. DeepSeek's prompt_tokens
 * INCLUDES cache hits while Anthropic splits them out, so cache reads are
 * subtracted from input_tokens (the disjoint convention the host
 * chat-completions translator uses).
 */
function applyUsage(target, usage) {
    const cacheRead = isObject(usage.prompt_tokens_details) && typeof usage.prompt_tokens_details.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : (typeof usage.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : undefined);
    const prompt = typeof usage.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
    target.input_tokens = Math.max(0, prompt - (cacheRead ?? 0));
    target.output_tokens = completion;
    if (cacheRead !== undefined && cacheRead > 0)
        target.cache_read_input_tokens = cacheRead;
}
function usagePayload(usage) {
    const payload = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    if (usage.cache_read_input_tokens !== undefined)
        payload.cache_read_input_tokens = usage.cache_read_input_tokens;
    return payload;
}
function sseData(raw) {
    const values = [];
    for (const line of raw.split(/\r?\n/u)) {
        if (line.startsWith(':'))
            continue;
        if (line === 'data')
            values.push('');
        else if (line.startsWith('data:'))
            values.push(line.slice(5).replace(/^ /u, ''));
    }
    return values.length > 0 ? values.join('\n') : null;
}
/**
 * Incremental chat/completions SSE -> Anthropic Messages SSE translator.
 *
 * One push per decoded TCP chunk; output is complete SSE frames. The state
 * machine assigns non-repeating block indices in first-appearance order, emits
 * message_start exactly once, closes every block, then emits exactly one
 * message_delta and one message_stop on [DONE] (or on upstream close once a
 * finish_reason was seen). Upstream close without any finish_reason is treated
 * as truncation and emits no message_stop, so the host reports STREAM_CLOSED
 * instead of a bogus completed response.
 */
export class ChatToMessagesStream {
    options;
    blocks = new Map();
    usage = { input_tokens: 0, output_tokens: 0 };
    buffer = '';
    started = false;
    done = false;
    nextIndex = 0;
    reason = null;
    model = 'unknown';
    id = '';
    constructor(options = {}) {
        this.options = options;
    }
    /** Feed one decoded text chunk; returns complete Anthropic SSE frames. */
    push(chunk) {
        if (this.done)
            return '';
        this.buffer += chunk;
        let out = '';
        while (true) {
            const match = /\r?\n\r?\n/u.exec(this.buffer);
            if (!match)
                break;
            const raw = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            out += this.handleFrame(raw);
        }
        return out;
    }
    /** Upstream ended. Returns residual frames (never a bogus terminal on truncation). */
    finish() {
        if (this.done)
            return '';
        if (this.buffer.length > 0) {
            const raw = this.buffer;
            this.buffer = '';
            const frame = this.handleFrame(raw);
            if (this.done)
                return frame;
            return frame + this.closeWithoutTerminal();
        }
        if (this.reason !== null)
            return this.finalize();
        return this.closeWithoutTerminal();
    }
    frame(type, payload) {
        return 'event: ' + type + '\ndata: ' + JSON.stringify(payload) + '\n\n';
    }
    handleFrame(raw) {
        const data = sseData(raw);
        if (data === null)
            return '';
        if (data.trim() === '[DONE]')
            return this.finalize();
        let chunk;
        try {
            chunk = JSON.parse(data);
        }
        catch {
            throw new Error('chat->messages: SSE payload is not JSON');
        }
        if (!isObject(chunk))
            return '';
        if (Object.hasOwn(chunk, 'error')) {
            // Surface an in-band chat error as the Anthropic error event the host
            // classifies (messages/sse.ts throws providerError on it), instead of a
            // generic transform failure.
            this.done = true;
            const error = isObject(chunk.error) ? chunk.error : { message: 'upstream chat/completions error' };
            return this.frame('error', { type: 'error', error });
        }
        return this.consume(chunk);
    }
    ensureStarted(chunk) {
        if (this.started)
            return '';
        this.started = true;
        const upstreamId = typeof chunk.id === 'string' ? chunk.id.replace(/[^A-Za-z0-9_-]/gu, '') : '';
        this.id = 'msg_' + (upstreamId.length > 0 ? upstreamId : (this.options.now ?? Date.now)());
        this.model = typeof chunk.model === 'string' && chunk.model.length > 0
            ? chunk.model
            : (this.options.model ?? 'unknown');
        return this.frame('message_start', {
            type: 'message_start',
            message: {
                id: this.id,
                type: 'message',
                role: 'assistant',
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        });
    }
    consume(chunk) {
        let out = this.ensureStarted(chunk);
        const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : undefined;
        if (choice) {
            const delta = isObject(choice.delta) ? choice.delta : {};
            out += this.consumeDelta(delta);
            if (typeof choice.finish_reason === 'string')
                this.reason = mapChatFinishReason(choice.finish_reason);
        }
        if (isObject(chunk.usage))
            applyUsage(this.usage, chunk.usage);
        return out;
    }
    consumeDelta(delta) {
        let out = '';
        const reasoning = delta.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
            out += this.openTextBlock('thinking');
            out += this.deltaFrame('thinking', 'thinking_delta', { thinking: reasoning });
        }
        const content = delta.content;
        if (typeof content === 'string' && content.length > 0) {
            out += this.openTextBlock('text');
            out += this.deltaFrame('text', 'text_delta', { text: content });
        }
        if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls)
                out += this.consumeToolDelta(call);
        }
        return out;
    }
    openTextBlock(kind) {
        if (this.blocks.has(kind))
            return '';
        const state = { index: this.nextIndex++, kind, started: true, open: true, argumentsText: '', pending: '' };
        this.blocks.set(kind, state);
        return this.frame('content_block_start', {
            type: 'content_block_start',
            index: state.index,
            content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
        });
    }
    block(kind) {
        return this.blocks.get(kind);
    }
    deltaFrame(kind, deltaType, delta) {
        return this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: this.block(kind).index,
            delta: { type: deltaType, ...delta },
        });
    }
    consumeToolDelta(raw) {
        if (!isObject(raw))
            return '';
        const openaiIndex = Number.isSafeInteger(raw.index) ? Number(raw.index) : 0;
        const key = 'tool:' + openaiIndex;
        let state = this.blocks.get(key);
        if (!state) {
            state = { index: this.nextIndex++, kind: 'tool', started: false, open: true, argumentsText: '', pending: '' };
            this.blocks.set(key, state);
        }
        // Identity fields are set-once: an empty/null continuation never clears them.
        if (typeof raw.id === 'string' && raw.id.length > 0)
            state.id = raw.id;
        const fn = isObject(raw.function) ? raw.function : {};
        if (typeof fn.name === 'string' && fn.name.length > 0)
            state.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0)
            state.pending += fn.arguments;
        let out = '';
        if (!state.started && state.id !== undefined && state.name !== undefined)
            out += this.startToolBlock(state);
        if (state.started && state.pending.length > 0)
            out += this.argumentsFrame(state, state.pending);
        return out;
    }
    startToolBlock(state) {
        state.started = true;
        return this.frame('content_block_start', {
            type: 'content_block_start',
            index: state.index,
            content_block: {
                type: 'tool_use',
                id: state.id ?? '',
                name: state.name ?? '',
                input: {},
            },
        });
    }
    argumentsFrame(state, partial) {
        state.argumentsText += partial;
        state.pending = '';
        return this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'input_json_delta', partial_json: partial },
        });
    }
    openToolBlocks() {
        let out = '';
        for (const state of this.blocks.values()) {
            if (state.kind !== 'tool' || state.started)
                continue;
            out += this.startToolBlock(state);
            if (state.pending.length > 0)
                out += this.argumentsFrame(state, state.pending);
        }
        return out;
    }
    closeBlocks() {
        let out = this.openToolBlocks();
        for (const state of this.blocks.values()) {
            if (!state.open)
                continue;
            // The host rejects an empty tool argument string on a settled response.
            if (state.kind === 'tool' && state.argumentsText.length === 0)
                out += this.argumentsFrame(state, '{}');
            state.open = false;
            out += this.frame('content_block_stop', { type: 'content_block_stop', index: state.index });
        }
        return out;
    }
    finalize() {
        if (this.done)
            return '';
        this.done = true;
        let out = this.ensureStarted({});
        out += this.closeBlocks();
        out += this.frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: this.reason ?? 'end_turn', stop_sequence: null },
            usage: usagePayload(this.usage),
        });
        out += this.frame('message_stop', { type: 'message_stop' });
        return out;
    }
    /** Upstream closed without a finish_reason: flush what arrived, no terminal. */
    closeWithoutTerminal() {
        if (this.done)
            return '';
        this.done = true;
        return this.ensureStarted({}) + this.closeBlocks();
    }
}
/** Byte-level wrapper over ChatToMessagesStream for Response.body.pipeThrough. */
export function createChatToMessagesStream(options = {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const state = new ChatToMessagesStream(options);
    return new TransformStream({
        transform(chunk, controller) {
            const out = state.push(decoder.decode(chunk, { stream: true }));
            if (out.length > 0)
                controller.enqueue(encoder.encode(out));
        },
        flush(controller) {
            const tail = decoder.decode();
            const out = (tail.length > 0 ? state.push(tail) : '') + state.finish();
            if (out.length > 0)
                controller.enqueue(encoder.encode(out));
        },
    });
}
function messageId(data, options) {
    const raw = typeof data.id === 'string' ? data.id.replace(/[^A-Za-z0-9_-]/gu, '') : '';
    return 'msg_' + (raw.length > 0 ? raw : (options.now ?? Date.now)());
}
/**
 * Convert one non-stream chat completion object into an Anthropic message
 * object (blocks in thinking -> text -> tool_use order, exactly what the host
 * Messages translator reconstructs from a stream).
 */
export function chatCompletionToMessage(data, options = {}) {
    const choice = Array.isArray(data.choices) && isObject(data.choices[0]) ? data.choices[0] : {};
    const message = isObject(choice.message) ? choice.message : {};
    const content = [];
    const reasoning = message.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0)
        content.push({ type: 'thinking', thinking: reasoning });
    const body = message.content;
    if (typeof body === 'string' && body.length > 0)
        content.push({ type: 'text', text: body });
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (!isObject(call))
                continue;
            const fn = isObject(call.function) ? call.function : {};
            let input = {};
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
                try {
                    const parsed = JSON.parse(fn.arguments);
                    input = isObject(parsed) ? parsed : {};
                }
                catch {
                    input = {};
                }
            }
            content.push({ type: 'tool_use', id: text(call.id), name: text(fn.name), input });
        }
    }
    const usage = { input_tokens: 0, output_tokens: 0 };
    if (isObject(data.usage))
        applyUsage(usage, data.usage);
    return {
        id: messageId(data, options),
        type: 'message',
        role: 'assistant',
        model: typeof data.model === 'string' && data.model.length > 0 ? data.model : (options.model ?? 'unknown'),
        content,
        stop_reason: mapChatFinishReason(choice.finish_reason),
        stop_sequence: null,
        usage: usagePayload(usage),
    };
}
function responseHeaders(response, contentType) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    if (contentType !== undefined)
        headers.set('content-type', contentType);
    return headers;
}
/**
 * Translate a chat/completions Response back into the Anthropic Messages wire
 * format. SSE bodies are re-framed incrementally; a JSON body becomes one
 * Anthropic message object; anything else (including non-2xx error envelopes)
 * is passed through untouched so the host provider-error classification sees
 * the original bytes.
 */
export async function translateChatResponse(response, options = {}) {
    if (response.status !== 200)
        return response;
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (contentType.toLowerCase().includes('text/event-stream') && response.body) {
        const type = contentType.toLowerCase().includes('charset') ? contentType : 'text/event-stream; charset=utf-8';
        return new Response(response.body.pipeThrough(createChatToMessagesStream(options)), {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response, type),
        });
    }
    const raw = await response.text();
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return new Response(raw, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response),
        });
    }
    if (!isObject(data) || !Array.isArray(data.choices)) {
        return new Response(raw, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response),
        });
    }
    return new Response(JSON.stringify(chatCompletionToMessage(data, options)), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response, 'application/json; charset=utf-8'),
    });
}
