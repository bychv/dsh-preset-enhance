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

/** Wire protocol actually used by one outbound LLM request. */
export type LlmProtocol = 'chat-completions' | 'messages' | 'unknown';

/** How a classification was reached. */
export type ProtocolEvidence = 'url' | 'headers' | 'none';

/** Per-feature support of the preset compatibility path. */
export interface ProtocolFeatures {
  /** Trailing-assistant-prefix rewrite of a chat request. */
  assistantPrefix: boolean;
  /** DSML tool-call emulation and response-to-tool-call conversion. */
  toolCallEmulation: boolean;
  /** `<output>` / `<content>` body extraction. */
  outputExtraction: boolean;
}

/** Whether the preset compatibility path can apply to one protocol. */
export interface ProtocolCapability {
  protocol: LlmProtocol;
  supported: boolean;
  /** Empty when supported; otherwise the exact reason shown to the user. */
  reason: string;
  features: ProtocolFeatures;
}

/** One classified outbound request, as recorded by a {@link ProtocolObserver}. */
export interface ProtocolObservation {
  protocol: LlmProtocol;
  capability: ProtocolCapability;
  /** Absolute URL when it could be resolved, otherwise the raw input string. */
  url: string;
  /** URL pathname ('' when the input had no parseable URL). */
  pathname: string;
  method: string;
  /** `x-deepseek-harness-session-id`, or null for a request without one. */
  sessionId: string | null;
  determinedBy: ProtocolEvidence;
  /** Milliseconds since epoch. */
  observedAt: number;
  /**
   * True when this request could not use the Chat Completions compatibility path:
   * the protocol is not chat-completions and the request carries a session id
   * (recorded by the bridge), so the panel can show an explicit unsupported state.
   */
  skipped: boolean;
  /** Empty unless `skipped`; the exact reason. */
  skippedReason: string;
  /**
   * Set by the fetch bridge when it rerouted this request: the protocol the
   * caller originally asked for, before the request was switched (chat mode
   * switches an official Messages request to chat/completions). Absent when the
   * request went out on the protocol it was built for.
   */
  switchedFrom?: LlmProtocol;
}

/**
 * Explicit, injectable observation store. One entry per session id (plus one
 * unbound slot for requests without a session header); each `record`
 * overwrites the previous observation for that slot, so `last()` always
 * reports the protocol most recently used by that session.
 */
export interface ProtocolObserver {
  record(observation: ProtocolObservation): ProtocolObservation;
  /** Last observation for one session; pass nothing for the unbound slot. */
  last(sessionId?: string | null): ProtocolObservation | undefined;
  /** All current entries, ordered by `observedAt`. */
  snapshot(): ProtocolObservation[];
  clear(): void;
  readonly size: number;
}

export interface ProtocolDetectOptions {
  /** Clock used for `observedAt`; injectable for deterministic tests. */
  now?: () => number;
}

export interface ProtocolObserveOptions extends ProtocolDetectOptions {
  /** Recording filter; defaults to {@link shouldRecordProtocol}. */
  keep?: (observation: ProtocolObservation) => boolean;
}

/** Session header the host adds to every provider request. */
export const SESSION_ID_HEADER = 'x-deepseek-harness-session-id';

/** Header that unambiguously identifies an Anthropic-style Messages request. */
export const MESSAGES_VERSION_HEADER = 'anthropic-version';

/** Official Messages root of DSH 0.1.6 (llm-deepseek config.ts). */
export const MESSAGES_BASE_URL = 'https://api.deepseek.com/anthropic';

export const MESSAGES_PROTOCOL_REASON =
  'Messages 协议（POST /messages、x-api-key + anthropic-version、content_block_* 事件流）' +
  '不受预设兼容路径支持：助手预填充、工具调用模拟和正文提取都不会生效。' +
  '请把该连接的 protocol 显式配置为 chat-completions，或等待第二阶段的 Messages 实现。';

export const UNKNOWN_PROTOCOL_REASON =
  '无法从出站请求的 URL/路径判定协议（既不是 /chat/completions 也不是 /messages），' +
  '预设兼容路径不会生效，请求按原样发出。';

const CHAT_COMPLETIONS_PATH = /(?:^|\/)chat\/completions\/?$/u;
const MESSAGES_PATH = /(?:^|\/)messages\/?$/u;
const SUPPORTED_FEATURES: ProtocolFeatures = { assistantPrefix: true, toolCallEmulation: true, outputExtraction: true };
const UNSUPPORTED_FEATURES: ProtocolFeatures = { assistantPrefix: false, toolCallEmulation: false, outputExtraction: false };

function features(value: ProtocolFeatures): ProtocolFeatures {
  return { assistantPrefix: value.assistantPrefix, toolCallEmulation: value.toolCallEmulation, outputExtraction: value.outputExtraction };
}

/**
 * Classify only a URL path. Pure: no headers, no clock, no state.
 * `/chat/completions`, `/v1/chat/completions` and `/beta/chat/completions`
 * are chat-completions; `/messages` and `/anthropic/v1/messages` are
 * messages; anything else is unknown.
 */
export function classifyProtocolPath(pathname: string): LlmProtocol {
  const value = typeof pathname === 'string' ? pathname.split(/[?#]/u, 1)[0] ?? '' : '';
  if (CHAT_COMPLETIONS_PATH.test(value)) return 'chat-completions';
  if (MESSAGES_PATH.test(value)) return 'messages';
  return 'unknown';
}

/** Whether the preset compatibility path may be applied to one protocol. */
export function protocolCapability(protocol: LlmProtocol): ProtocolCapability {
  if (protocol === 'chat-completions') {
    return { protocol, supported: true, reason: '', features: features(SUPPORTED_FEATURES) };
  }
  if (protocol === 'messages') {
    return { protocol, supported: false, reason: MESSAGES_PROTOCOL_REASON, features: features(UNSUPPORTED_FEATURES) };
  }
  return { protocol: 'unknown', supported: false, reason: UNKNOWN_PROTOCOL_REASON, features: features(UNSUPPORTED_FEATURES) };
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (input !== null && typeof input === 'object') {
    const candidate = (input as { url?: unknown }).url;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/** Case-insensitive header lookup for Headers, pair arrays and plain objects. */
export function headerValue(headers: unknown, name: string): string {
  if (headers == null) return '';
  const wanted = String(name).toLowerCase();
  if (typeof headers === 'object' || typeof headers === 'function') {
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') {
      const value = (get as (key: string) => unknown).call(headers, name);
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
    const record = headers as Record<string, unknown>;
    const key = Object.keys(record).find(candidate => candidate.toLowerCase() === wanted);
    return key == null ? '' : String(record[key] ?? '');
  }
  return '';
}

function requestHeaders(input: unknown, init: unknown): unknown {
  const fromInit = init !== null && typeof init === 'object' ? (init as { headers?: unknown }).headers : undefined;
  if (fromInit != null) return fromInit;
  if (input !== null && typeof input === 'object' && 'headers' in input) {
    return (input as { headers?: unknown }).headers;
  }
  return undefined;
}

function requestMethod(input: unknown, init: unknown): string {
  const fromInit = init !== null && typeof init === 'object' ? (init as { method?: unknown }).method : undefined;
  if (typeof fromInit === 'string' && fromInit !== '') return fromInit.toUpperCase();
  const fromInput = input !== null && typeof input === 'object' ? (input as { method?: unknown }).method : undefined;
  if (typeof fromInput === 'string' && fromInput !== '') return fromInput.toUpperCase();
  return 'GET';
}

/**
 * Classify one outbound request from its URL/path plus a header fallback: an
 * unknown path that still carries `anthropic-version` is a Messages request.
 * Pure apart from the injected clock.
 */
export function detectProtocol(
  input: unknown, init?: unknown, options: ProtocolDetectOptions = {},
): ProtocolObservation {
  const now = options.now ?? Date.now;
  const raw = urlOf(input);
  let url = raw;
  let pathname = '';
  if (raw !== '') {
    try {
      const parsed = new URL(raw);
      url = parsed.toString();
      pathname = parsed.pathname;
    } catch {
      pathname = '';
    }
  }
  const headers = requestHeaders(input, init);
  let protocol = classifyProtocolPath(pathname);
  let determinedBy: ProtocolEvidence = pathname === '' ? 'none' : 'url';
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
export function shouldRecordProtocol(observation: ProtocolObservation): boolean {
  return observation.protocol !== 'unknown' || observation.sessionId !== null;
}

/** Create an explicit observation store; no module-level state is involved. */
export function createProtocolObserver(): ProtocolObserver {
  const sessions = new Map<string, ProtocolObservation>();
  let unbound: ProtocolObservation | undefined;
  return {
    record(observation: ProtocolObservation): ProtocolObservation {
      if (observation.sessionId) sessions.set(observation.sessionId, observation);
      else unbound = observation;
      return observation;
    },
    last(sessionId?: string | null): ProtocolObservation | undefined {
      return sessionId ? sessions.get(sessionId) : unbound;
    },
    snapshot(): ProtocolObservation[] {
      const entries = [...sessions.values()];
      if (unbound) entries.push(unbound);
      return entries.sort((left, right) => left.observedAt - right.observedAt);
    },
    clear(): void {
      sessions.clear();
      unbound = undefined;
    },
    get size(): number {
      return sessions.size + (unbound ? 1 : 0);
    },
  };
}

/**
 * Classify one outbound request and, when {@link shouldRecordProtocol} (or a
 * custom `keep`) accepts it, record it in the observer. Returns null when the
 * request was filtered out.
 */
export function observeProtocolRequest(
  input: unknown, init: unknown, observer: ProtocolObserver, options: ProtocolObserveOptions = {},
): ProtocolObservation | null {
  const observation = detectProtocol(input, init, options);
  const keep = options.keep ?? shouldRecordProtocol;
  if (!keep(observation)) return null;
  return observer.record(observation);
}
