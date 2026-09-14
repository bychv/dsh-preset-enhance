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

/**
 * Normalize the relay address a user typed into `<origin><path>` so request URLs can be
 * matched against it. An empty result means "recognize the relay from the request itself".
 */
export function normalizeRelayUrl(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('中转地址必须是文本');
  const text = value.trim();
  if (!text) return '';
  if (/\s/u.test(text)) throw new Error('中转地址不能包含空白字符');
  let url;
  try { url = new URL(text); } catch { throw new Error('中转地址不是合法的 URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('中转地址必须使用 http 或 https');
  if (url.username || url.password) throw new Error('中转地址不能包含用户名或密码');
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

function safeRelayUrl(value) {
  try { return normalizeRelayUrl(value); } catch { return ''; }
}

/** A relay matches its own origin and either its exact path or a path below it. */
function relayMatches(url, relay) {
  let base;
  try { base = new URL(relay); } catch { return false; }
  if (url.origin !== base.origin) return false;
  const path = base.pathname.replace(/\/+$/u, '');
  return path === '' || url.pathname === path || url.pathname.startsWith(`${path}/`);
}

/** Legacy registries store a plain count; newer ones store `{ count, relay }`. */
function entryCount(entry) {
  if (typeof entry === 'number') return entry;
  return typeof entry?.count === 'number' ? entry.count : 0;
}

function sessionActive(registries, sessionId) {
  for (const registry of registries) if (registry.has(sessionId)) return true;
  return false;
}

function sessionRelay(registries, sessionId) {
  for (const registry of registries) {
    for (const entry of registry.get(sessionId)?.values() ?? []) {
      if (entryCount(entry) > 0 && typeof entry === 'object' && entry.relay) return entry.relay;
    }
  }
  return '';
}

function activeMatch(registries, sessionId, content) {
  for (const registry of registries) {
    if (entryCount(registry.get(sessionId)?.get(content)) > 0) return true;
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

/**
 * Pure request rewrite used by the installed bridge and unit tests.
 *
 * Official DeepSeek endpoints get the Beta address plus the field surgery the official
 * Prefix API requires. A user-configured relay (or, when the relay field is empty, any
 * non-official chat-completion endpoint) only gets the minimum prefix rewrite and keeps
 * `tools`, `tool_choice` and `parallel_tool_calls` so the request is sent as-is.
 */
export function rewriteDeepSeekPrefixFetch(input, init = {}, registries = []) {
  const url = parsedUrl(input);
  if (!url || !isChatCompletions(url)) return { input, init, changed: false, mode: 'none' };
  const sessionId = headerValue(init.headers, 'x-deepseek-harness-session-id');
  if (!sessionId) return { input, init, changed: false, mode: 'none' };
  const betaUrl = officialBetaUrl(url);
  if (!betaUrl) {
    const relay = sessionRelay(registries, sessionId);
    if (relay ? !relayMatches(url, relay) : !sessionActive(registries, sessionId)) {
      return { input, init, changed: false, mode: 'none' };
    }
  }
  const raw = bodyText(init.body);
  if (raw == null) return { input, init, changed: false, mode: 'none' };
  let body;
  try { body = JSON.parse(raw); } catch { return { input, init, changed: false, mode: 'none' }; }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') {
    return { input, init, changed: false, mode: 'none' };
  }
  if (!activeMatch(registries, sessionId, last.content)) return { input, init, changed: false, mode: 'none' };
  const thinkingEnabled = body.thinking?.type !== 'disabled';
  const messages = thinkingMessages(body.messages, thinkingEnabled);
  messages[messages.length - 1] = { ...messages.at(-1), prefix: true };
  if (betaUrl) {
    const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallelToolCalls, ...compatibleBody } = body;
    return {
      input: betaUrl,
      init: { ...init, body: JSON.stringify({ ...compatibleBody, messages }) },
      changed: true,
      mode: 'official',
    };
  }
  return {
    input,
    init: { ...init, body: JSON.stringify({ ...body, messages }) },
    changed: true,
    mode: 'relay',
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
 * Install one scoped client for DeepSeek prefix completion. The shared fetch wrapper is
 * inert unless activate() holds an exact session/text pair; the optional relay address
 * decides whether the matched request keeps its tools (relay) or drops them (official).
 */
export function installDeepSeekBetaBridge(ctx) {
  const host = globalBridge();
  const registry = new Map();
  host?.registries.add(registry);
  let disposed = false;
  const controller = {
    activate(sessionId, content, relayUrl = '') {
      if (disposed || !host || !sessionId || typeof content !== 'string') return () => {};
      let texts = registry.get(sessionId);
      if (!texts) { texts = new Map(); registry.set(sessionId, texts); }
      texts.set(content, { count: entryCount(texts.get(content)) + 1, relay: safeRelayUrl(relayUrl) });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const entry = texts.get(content);
        const count = entryCount(entry);
        if (count <= 1) texts.delete(content);
        else texts.set(content, { count: count - 1, relay: entry.relay });
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
