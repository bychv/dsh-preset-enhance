import { emulateToolCallRequest, transformToolCallResponse } from './toolcall-prefill.mjs';

export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';

const BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  if (Array.isArray(headers)) {
    const pair = headers.find(([key]) => String(key).toLowerCase() === name);
    return pair == null ? '' : String(pair[1]);
  }
  const key = Object.keys(headers).find(key => key.toLowerCase() === name);
  return key == null ? '' : String(headers[key]);
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return typeof Request !== 'undefined' && input instanceof Request ? input.url : '';
}

function parsedUrl(input) {
  try { return new URL(requestUrl(input)); } catch { return null; }
}

function isChatCompletions(url) {
  return /\/chat\/completions\/?$/u.test(url.pathname);
}

function officialBetaUrl(url) {
  if (!url || url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port) return null;
  if (!/^\/(?:beta\/|v1\/)?chat\/completions\/?$/u.test(url.pathname)) return null;
  const beta = new URL(DEEPSEEK_BETA_BASE_URL + '/chat/completions');
  beta.search = url.search;
  return beta.toString();
}

/** Legacy registries store a plain count; newer ones store an activation object. */
function entryCount(entry) {
  if (typeof entry === 'number') return entry;
  return typeof entry?.count === 'number' ? entry.count : 0;
}

function sessionActive(registries, sessionId) {
  for (const registry of registries) if (registry.has(sessionId)) return true;
  return false;
}

function activeEntry(registries, sessionId, content) {
  for (const registry of registries) {
    const entry = registry.get(sessionId)?.get(content);
    if (entryCount(entry) > 0) return entry;
  }
  return null;
}

function entryHandlesToolCalls(entry) {
  return typeof entry === 'object' && entry?.toolCalls === true;
}

function entryRemovesNonOfficialTools(entry) {
  return typeof entry !== 'object' || entry?.removeNonOfficialTools !== false;
}

/** Split SillyTavern's open/closed <think> convention into DeepSeek wire fields. */
export function splitReasoningPrefix(content) {
  const open = /^\s*<think>[ \t]*(?:\r?\n)?/iu.exec(content);
  if (!open) return { tagged: false, content, reasoningContent: '' };
  const start = open[0].length;
  const close = content.indexOf('</think>', start);
  if (close < 0) return { tagged: true, content: '', reasoningContent: content.slice(start) };
  return {
    tagged: true,
    content: content.slice(close + '</think>'.length).replace(/^\r?\n/u, ''),
    reasoningContent: content.slice(start, close),
  };
}

function thinkingMessages(messages, enabled) {
  if (!enabled) return [...messages];
  return messages.map(message => {
    if (message?.role !== 'assistant') return message;
    if (typeof message.content === 'string') {
      const split = splitReasoningPrefix(message.content);
      if (split.tagged) return { ...message, content: split.content, reasoning_content: split.reasoningContent };
    }
    if (typeof message.reasoning_content === 'string') return message;
    // Generic OpenAI-compatible providers can preserve the same reasoning block under
    // one of these aliases. DeepSeek requires it to be replayed as reasoning_content,
    // especially on assistant messages that contain tool_calls.
    for (const field of ['reasoning', 'reasoning_text']) {
      if (typeof message[field] === 'string') return { ...message, reasoning_content: message[field] };
    }
    return { ...message, reasoning_content: '' };
  });
}

/**
 * Rewrite an activated assistant-prefix request. Official DeepSeek requests always remove
 * native tool fields. Non-official adapters can either keep or remove them. When DSML tool
 * handling is enabled, both destinations emulate tools and convert the response back to
 * standard tool calls.
 */
export function rewriteDeepSeekPrefixFetch(input, init = {}, registries = []) {
  const url = parsedUrl(input);
  if (!url || !isChatCompletions(url)) return { input, init, changed: false, mode: 'none' };
  const sessionId = headerValue(init.headers, 'x-deepseek-harness-session-id');
  if (!sessionId) return { input, init, changed: false, mode: 'none' };
  const betaUrl = officialBetaUrl(url);
  if (!sessionActive(registries, sessionId)) return { input, init, changed: false, mode: 'none' };
  const raw = bodyText(init.body);
  if (raw == null) return { input, init, changed: false, mode: 'none' };
  let body;
  try { body = JSON.parse(raw); } catch { return { input, init, changed: false, mode: 'none' }; }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') {
    return { input, init, changed: false, mode: 'none' };
  }
  const entry = activeEntry(registries, sessionId, last.content);
  if (!entry) return { input, init, changed: false, mode: 'none' };
  const thinkingEnabled = body.thinking?.type !== 'disabled';
  const messages = thinkingMessages(body.messages, thinkingEnabled);
  messages[messages.length - 1] = { ...messages.at(-1), prefix: true };
  const prefixedBody = { ...body, messages };
  const emulation = entryHandlesToolCalls(entry) && Array.isArray(prefixedBody.tools) &&
    prefixedBody.tools.length > 0 ? emulateToolCallRequest(prefixedBody) : null;
  const source = emulation?.body ?? prefixedBody;
  const removeNativeTools = !!betaUrl || entryHandlesToolCalls(entry) || entryRemovesNonOfficialTools(entry);
  let compatibleBody = source;
  if (removeNativeTools) {
    const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallelToolCalls, ...rest } = source;
    compatibleBody = rest;
  }

  return {
    input: betaUrl ?? input,
    init: { ...init, body: JSON.stringify(compatibleBody) },
    changed: true,
    mode: betaUrl ? 'official' : 'adapter',
    ...(emulation ? {
      responseTransform: {
        contentPrefix: emulation.contentPrefix,
        reasoningPrefix: emulation.reasoningPrefix,
      },
    } : {}),
  };
}
function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return null;
}

function globalBridge() {
  let host = globalThis[BRIDGE];
  if (host) return host;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return null;
  const registries = new Set();
  const wrapped = async function (input, init) {
    const rewritten = rewriteDeepSeekPrefixFetch(input, init, registries);
    const response = await original.call(this, rewritten.input, rewritten.init);
    return rewritten.responseTransform ?
      transformToolCallResponse(response, rewritten.responseTransform) : response;
  };
  host = { original, wrapped, registries };
  Object.defineProperty(globalThis, BRIDGE, { value: host, configurable: true });
  globalThis.fetch = wrapped;
  return host;
}

/**
 * Install one scoped client for DeepSeek prefix completion. The shared fetch wrapper is
 * inert unless activate() holds an exact session/text pair. The activation also carries the
 * two tool-handling choices used by official and non-official endpoints.
 */
export function installDeepSeekBetaBridge(ctx) {
  const host = globalBridge();
  const registry = new Map();
  host?.registries.add(registry);
  let disposed = false;
  const controller = {
    activate(sessionId, content, { toolCalls = false, removeNonOfficialTools = true } = {}) {
      if (disposed || !host || !sessionId || typeof content !== 'string') return () => {};
      let texts = registry.get(sessionId);
      if (!texts) { texts = new Map(); registry.set(sessionId, texts); }
      texts.set(content, {
        count: entryCount(texts.get(content)) + 1,
        toolCalls: toolCalls === true,
        removeNonOfficialTools: removeNonOfficialTools !== false,
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const entry = texts.get(content);
        const count = entryCount(entry);
        if (count <= 1) texts.delete(content);
        else texts.set(content, {
          count: count - 1,
          toolCalls: entry.toolCalls === true,
          removeNonOfficialTools: entry.removeNonOfficialTools !== false,
        });
        if (texts.size === 0) registry.delete(sessionId);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registry.clear();
      host?.registries.delete(registry);
      if (host && host.registries.size === 0 && globalThis.fetch === host.wrapped) {
        globalThis.fetch = host.original;
        delete globalThis[BRIDGE];
      }
    },
  };
  ctx.effect(() => () => controller.dispose(), 'preset-enhance: prefix completion bridge');
  return controller;
}
