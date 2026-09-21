/**
 * Protocol capability detection for DSH 0.1.6.
 *
 * DSH 0.1.6-alpha.2 defaults the official DeepSeek connection to the Messages
 * protocol (`protocol: 'messages'`, root https://api.deepseek.com/anthropic,
 * `POST <root>/v1/messages` with `x-api-key` + `anthropic-version`). The
 * plugin's preset compatibility path (assistant prefill, DSML tool-call
 * emulation, `<output>` body extraction) is written against the Chat
 * Completions wire format, so under Messages it must be reported as
 * unsupported instead of silently doing nothing.
 *
 * This module is deliberately dependency-free and free of global state: the
 * only mutable store is an explicit, injectable {@link ProtocolObserver}.
 * Verified against the pinned host source
 * (packages/llm/llm-deepseek/src/{config.ts,protocols/messages/adapter.ts,serialize.ts}).
 */
/** Session header the host adds to every provider request. */
export const SESSION_ID_HEADER = 'x-deepseek-harness-session-id';
/** Header that unambiguously identifies an Anthropic-style Messages request. */
export const MESSAGES_VERSION_HEADER = 'anthropic-version';
/** Official Messages root of DSH 0.1.6 (llm-deepseek config.ts). */
export const MESSAGES_BASE_URL = 'https://api.deepseek.com/anthropic';
export const MESSAGES_PROTOCOL_REASON = 'Messages 协议（POST /messages、x-api-key + anthropic-version、content_block_* 事件流）' +
    '不受预设兼容路径支持：助手预填充、工具调用模拟和正文提取都不会生效。' +
    '请把该连接的 protocol 显式配置为 chat-completions，或等待第二阶段的 Messages 实现。';
export const UNKNOWN_PROTOCOL_REASON = '无法从出站请求的 URL/路径判定协议（既不是 /chat/completions 也不是 /messages），' +
    '预设兼容路径不会生效，请求按原样发出。';
const CHAT_COMPLETIONS_PATH = /(?:^|\/)chat\/completions\/?$/u;
const MESSAGES_PATH = /(?:^|\/)messages\/?$/u;
const SUPPORTED_FEATURES = { assistantPrefix: true, toolCallEmulation: true, outputExtraction: true };
const UNSUPPORTED_FEATURES = { assistantPrefix: false, toolCallEmulation: false, outputExtraction: false };
function features(value) {
    return { assistantPrefix: value.assistantPrefix, toolCallEmulation: value.toolCallEmulation, outputExtraction: value.outputExtraction };
}
/**
 * Classify only a URL path. Pure: no headers, no clock, no state.
 * `/chat/completions`, `/v1/chat/completions` and `/beta/chat/completions`
 * are chat-completions; `/messages` and `/anthropic/v1/messages` are
 * messages; anything else is unknown.
 */
export function classifyProtocolPath(pathname) {
    const value = typeof pathname === 'string' ? pathname.split(/[?#]/u, 1)[0] ?? '' : '';
    if (CHAT_COMPLETIONS_PATH.test(value))
        return 'chat-completions';
    if (MESSAGES_PATH.test(value))
        return 'messages';
    return 'unknown';
}
/** Whether the preset compatibility path may be applied to one protocol. */
export function protocolCapability(protocol) {
    if (protocol === 'chat-completions') {
        return { protocol, supported: true, reason: '', features: features(SUPPORTED_FEATURES) };
    }
    if (protocol === 'messages') {
        return { protocol, supported: false, reason: MESSAGES_PROTOCOL_REASON, features: features(UNSUPPORTED_FEATURES) };
    }
    return { protocol: 'unknown', supported: false, reason: UNKNOWN_PROTOCOL_REASON, features: features(UNSUPPORTED_FEATURES) };
}
function urlOf(input) {
    if (typeof input === 'string')
        return input;
    if (typeof URL !== 'undefined' && input instanceof URL)
        return input.toString();
    if (input !== null && typeof input === 'object') {
        const candidate = input.url;
        if (typeof candidate === 'string')
            return candidate;
    }
    return '';
}
/** Case-insensitive header lookup for Headers, pair arrays and plain objects. */
export function headerValue(headers, name) {
    if (headers == null)
        return '';
    const wanted = String(name).toLowerCase();
    if (typeof headers === 'object' || typeof headers === 'function') {
        const get = headers.get;
        if (typeof get === 'function') {
            const value = get.call(headers, name);
            return value == null ? '' : String(value);
        }
    }
    if (Array.isArray(headers)) {
        for (const item of headers) {
            if (Array.isArray(item) && String(item[0]).toLowerCase() === wanted) {
                return item[1] == null ? '' : String(item[1]);
            }
        }
        return '';
    }
    if (headers !== null && typeof headers === 'object') {
        const record = headers;
        const key = Object.keys(record).find(candidate => candidate.toLowerCase() === wanted);
        return key == null ? '' : String(record[key] ?? '');
    }
    return '';
}
function requestHeaders(input, init) {
    const fromInit = init !== null && typeof init === 'object' ? init.headers : undefined;
    if (fromInit != null)
        return fromInit;
    if (input !== null && typeof input === 'object' && 'headers' in input) {
        return input.headers;
    }
    return undefined;
}
function requestMethod(input, init) {
    const fromInit = init !== null && typeof init === 'object' ? init.method : undefined;
    if (typeof fromInit === 'string' && fromInit !== '')
        return fromInit.toUpperCase();
    const fromInput = input !== null && typeof input === 'object' ? input.method : undefined;
    if (typeof fromInput === 'string' && fromInput !== '')
        return fromInput.toUpperCase();
    return 'GET';
}
/**
 * Classify one outbound request from its URL/path plus a header fallback: an
 * unknown path that still carries `anthropic-version` is a Messages request.
 * Pure apart from the injected clock.
 */
export function detectProtocol(input, init, options = {}) {
    const now = options.now ?? Date.now;
    const raw = urlOf(input);
    let url = raw;
    let pathname = '';
    if (raw !== '') {
        try {
            const parsed = new URL(raw);
            url = parsed.toString();
            pathname = parsed.pathname;
        }
        catch {
            pathname = '';
        }
    }
    const headers = requestHeaders(input, init);
    let protocol = classifyProtocolPath(pathname);
    let determinedBy = pathname === '' ? 'none' : 'url';
    if (protocol === 'unknown' && headerValue(headers, MESSAGES_VERSION_HEADER) !== '') {
        protocol = 'messages';
        determinedBy = 'headers';
    }
    const sessionId = headerValue(headers, SESSION_ID_HEADER);
    return {
        protocol,
        capability: protocolCapability(protocol),
        url,
        pathname,
        method: requestMethod(input, init),
        sessionId: sessionId === '' ? null : sessionId,
        determinedBy,
        observedAt: now(),
        skipped: false,
        skippedReason: '',
    };
}
/**
 * Default recording filter: keep anything the bridge could classify, plus
 * anything carrying a harness session id (an unclassifiable endpoint with a
 * session is still worth reporting as `unknown`). Asset/file fetches without a
 * session header are dropped so they cannot overwrite a real LLM observation.
 */
export function shouldRecordProtocol(observation) {
    return observation.protocol !== 'unknown' || observation.sessionId !== null;
}
/** Create an explicit observation store; no module-level state is involved. */
export function createProtocolObserver() {
    const sessions = new Map();
    let unbound;
    return {
        record(observation) {
            if (observation.sessionId)
                sessions.set(observation.sessionId, observation);
            else
                unbound = observation;
            return observation;
        },
        last(sessionId) {
            return sessionId ? sessions.get(sessionId) : unbound;
        },
        snapshot() {
            const entries = [...sessions.values()];
            if (unbound)
                entries.push(unbound);
            return entries.sort((left, right) => left.observedAt - right.observedAt);
        },
        clear() {
            sessions.clear();
            unbound = undefined;
        },
        get size() {
            return sessions.size + (unbound ? 1 : 0);
        },
    };
}
/**
 * Classify one outbound request and, when {@link shouldRecordProtocol} (or a
 * custom `keep`) accepts it, record it in the observer. Returns null when the
 * request was filtered out.
 */
export function observeProtocolRequest(input, init, observer, options = {}) {
    const observation = detectProtocol(input, init, options);
    const keep = options.keep ?? shouldRecordProtocol;
    if (!keep(observation))
        return null;
    return observer.record(observation);
}
