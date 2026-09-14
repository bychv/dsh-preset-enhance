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

function officialBetaUrl(input) {
  try {
    const url = new URL(requestUrl(input));
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port) return null;
    if (!/^\/(?:beta\/|v1\/)?chat\/completions\/?$/u.test(url.pathname)) return null;
    const beta = new URL(DEEPSEEK_BETA_BASE_URL + '/chat/completions');
    beta.search = url.search;
    return beta.toString();
  } catch {
    return null;
  }
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return null;
}

function activeMatch(registries, sessionId, content) {
  for (const registry of registries) {
    if ((registry.get(sessionId)?.get(content) ?? 0) > 0) return true;
  }
  return false;
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
  const lastIndex = messages.length - 1;
  return messages.map((message, index) => {
    if (message?.role !== 'assistant') return message;
    if (index === lastIndex && typeof message.content === 'string') {
      const split = splitReasoningPrefix(message.content);
      if (split.tagged) return { ...message, content: split.content, reasoning_content: split.reasoningContent };
    }
    return typeof message.reasoning_content === 'string' ? message : { ...message, reasoning_content: '' };
  });
}

/** Pure request rewrite used by the installed bridge and unit tests. */
export function rewriteDeepSeekPrefixFetch(input, init = {}, registries = []) {
  const betaUrl = officialBetaUrl(input);
  if (!betaUrl) return { input, init, changed: false };
  const sessionId = headerValue(init.headers, 'x-deepseek-harness-session-id');
  if (!sessionId) return { input, init, changed: false };
  const raw = bodyText(init.body);
  if (raw == null) return { input, init, changed: false };
  let body;
  try { body = JSON.parse(raw); } catch { return { input, init, changed: false }; }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') {
    return { input, init, changed: false };
  }
  if (!activeMatch(registries, sessionId, last.content)) return { input, init, changed: false };
  const thinkingEnabled = body.thinking?.type !== 'disabled';
  const messages = thinkingMessages(body.messages, thinkingEnabled);
  messages[messages.length - 1] = { ...messages.at(-1), prefix: true };
  const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallelToolCalls, ...compatibleBody } = body;
  return {
    input: betaUrl,
    init: { ...init, body: JSON.stringify({ ...compatibleBody, messages }) },
    changed: true,
  };
}

function globalBridge() {
  let host = globalThis[BRIDGE];
  if (host) return host;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return null;
  const registries = new Set();
  const wrapped = function (input, init) {
    const rewritten = rewriteDeepSeekPrefixFetch(input, init, registries);
    return original.call(this, rewritten.input, rewritten.init);
  };
  host = { original, wrapped, registries };
  Object.defineProperty(globalThis, BRIDGE, { value: host, configurable: true });
  globalThis.fetch = wrapped;
  return host;
}

/**
 * Install one scoped client for DeepSeek's official prefix-completion Beta API.
 * The shared fetch wrapper is inert unless activate() holds an exact session/text pair.
 */
export function installDeepSeekBetaBridge(ctx) {
  const host = globalBridge();
  const registry = new Map();
  host?.registries.add(registry);
  let disposed = false;
  const controller = {
    activate(sessionId, content) {
      if (disposed || !host || !sessionId || typeof content !== 'string') return () => {};
      let texts = registry.get(sessionId);
      if (!texts) { texts = new Map(); registry.set(sessionId, texts); }
      texts.set(content, (texts.get(content) ?? 0) + 1);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const count = texts.get(content) ?? 0;
        if (count <= 1) texts.delete(content); else texts.set(content, count - 1);
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
  ctx.effect(() => () => controller.dispose(), 'preset-enhance: DeepSeek Beta prefix bridge');
  return controller;
}
