import { emulateToolCallRequest, transformToolCallResponse } from './toolcall-prefill.mjs';
import type { JsonObject, ResponseTransformMetadata } from './toolcall-prefill.mjs';
import { classifyProtocolPath, detectProtocol, observeProtocolRequest, protocolCapability } from './protocol.mjs';
import type { LlmProtocol, ProtocolObservation, ProtocolObserver } from './protocol.mjs';
import { messagesRequestHeadersToChat, messagesRequestToChat, translateChatResponse } from './messages-translate.mjs';
import type { PluginContext } from '../host-types.mjs';

export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';

const BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type RequestInitLike = NonNullable<FetchInit>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;
type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<FetchResponse>;

/** Wire protocol a preset injection was compiled for. */
export type BridgeProtocolMode = 'chat-completions' | 'messages';

/** Activation bookkeeping for one session/text pair. */
interface ActivationEntry {
  count: number;
  toolCalls: boolean;
  removeNonOfficialTools: boolean;
  extractOutput: boolean;
  /** Protocol this activation was armed for; 'messages' never switches endpoints. */
  mode: BridgeProtocolMode;
}

/** Legacy registries store a plain count; newer ones store an activation object. */
export type BridgeRegistryEntry = number | Partial<ActivationEntry>;
/** One controller's live session registry, read by the shared wrapper. */
export type SessionRegistry = ReadonlyMap<string, ReadonlyMap<string, BridgeRegistryEntry>>;
type ActivationRegistry = Map<string, Map<string, ActivationEntry>>;

function requestUrl(input: unknown): string {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return typeof Request !== 'undefined' && input instanceof Request ? input.url : '';
}

function parsedUrl(input: unknown): URL | null {
  try { return new URL(requestUrl(input)); } catch { return null; }
}

function officialBetaUrl(url: URL | null): string | null {
  if (!url || url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port) return null;
  if (!/^\/(?:beta\/|v1\/)?chat\/completions\/?$/u.test(url.pathname)) return null;
  const beta = new URL(DEEPSEEK_BETA_BASE_URL + '/chat/completions');
  beta.search = url.search;
  return beta.toString();
}

/** Official chat/completions endpoint of the same host as the Messages root. */
export const DEEPSEEK_OFFICIAL_CHAT_URL = 'https://api.deepseek.com/chat/completions';

/**
 * True only for the official DeepSeek Messages endpoint. Adapter and gateway
 * endpoints are never switched, however the request was compiled.
 */
function officialMessagesUrl(url: URL | null): boolean {
  if (!url || url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port) return false;
  return classifyProtocolPath(url.pathname) === 'messages';
}

function entryCount(entry: BridgeRegistryEntry | null | undefined): number {
  if (typeof entry === 'number') return entry;
  return entry && typeof entry === 'object' && typeof entry.count === 'number' ? entry.count : 0;
}

/**
 * Legacy registries (plain counts and objects without a mode) predate the
 * protocol switch and always mean 'messages': only an activation explicitly
 * armed for chat mode may reroute an official Messages request.
 */
function entryMode(entry: BridgeRegistryEntry | null | undefined): BridgeProtocolMode {
  return typeof entry === 'object' && entry !== null && entry.mode === 'chat-completions'
    ? 'chat-completions' : 'messages';
}

/** True when this session has at least one activation explicitly armed for chat mode. */
function sessionArmedForChat(registries: readonly SessionRegistry[], sessionId: string): boolean {
  for (const registry of registries) {
    const texts = registry.get(sessionId);
    if (!texts) continue;
    for (const entry of texts.values()) {
      if (entryCount(entry) > 0 && entryMode(entry) === 'chat-completions') return true;
    }
  }
  return false;
}

function sessionActive(registries: readonly SessionRegistry[], sessionId: string | null): boolean {
  if (!sessionId) return false;
  for (const registry of registries) if (registry.has(sessionId)) return true;
  return false;
}

function activeEntry(registries: readonly SessionRegistry[], sessionId: string, content: string): BridgeRegistryEntry | null {
  for (const registry of registries) {
    const entry = registry.get(sessionId)?.get(content);
    if (entryCount(entry) > 0) return entry ?? null;
  }
  return null;
}

function entryHandlesToolCalls(entry: BridgeRegistryEntry): boolean {
  return typeof entry === 'object' && entry !== null && entry.toolCalls === true;
}

function entryRemovesNonOfficialTools(entry: BridgeRegistryEntry): boolean {
  return typeof entry !== 'object' || entry === null || entry.removeNonOfficialTools !== false;
}

function entryExtractsOutput(entry: BridgeRegistryEntry): boolean {
  return typeof entry === 'object' && entry !== null && entry.extractOutput === true;
}

/** Split SillyTavern's open/closed <think> convention into DeepSeek wire fields. */
export function splitReasoningPrefix(content: string): { tagged: boolean; content: string; reasoningContent: string } {
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

function thinkingMessages(messages: any[], enabled: boolean): any[] {
  if (!enabled) return [...messages];
  return messages.map((message: any) => {
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

/** Why this request could not use the Chat Completions compatibility path. */
export interface DeepSeekSkippedReason {
  protocol: LlmProtocol;
  reason: string;
}

export interface DeepSeekPrefixRewrite {
  input: FetchInput;
  init: RequestInitLike;
  changed: boolean;
  mode: 'none' | 'official' | 'adapter' | 'switch';
  /** Protocol this rewrite made the request use on the wire. */
  protocol: LlmProtocol;
  /** Set when a session request cannot use the chat-completions compatibility path. */
  skipped?: DeepSeekSkippedReason;
  responseTransform?: ResponseTransformMetadata;
  /** Original protocol when the request was switched; absent otherwise. */
  switchedFrom?: LlmProtocol;
  /** Response body must be translated back to this protocol. */
  translateResponseTo?: 'messages';
  /** Model of the translated upstream request, for the translated message_start. */
  upstreamModel?: string;
}

/**
 * Rewrite an activated assistant-prefix request. Official DeepSeek requests always remove
 * native tool fields. Non-official adapters can either keep or remove them. When DSML tool
 * handling is enabled, both destinations emulate tools and convert the response back to
 * standard tool calls.
 *
 * DSH 0.1.6 defaults the official connection to the Messages protocol. In chat mode the
 * official Messages endpoint is switched to the official chat/completions endpoint and
 * translated both directions; a session with no chat-mode activation, a non-official
 * host, or messages mode is reported through `protocol`/`skipped` instead of silently
 * pretending the compatibility path applied.
 */
export function rewriteDeepSeekPrefixFetch(
  input: FetchInput, init: RequestInitLike = {}, registries: readonly SessionRegistry[] = [],
): DeepSeekPrefixRewrite {
  const detected = detectProtocol(input, init);
  const untouched: DeepSeekPrefixRewrite = {
    input, init, changed: false, mode: 'none', protocol: detected.protocol,
  };
  const url = parsedUrl(input);
  const pathProtocol = url ? classifyProtocolPath(url.pathname) : 'unknown';
  if (pathProtocol === 'messages' && url) {
    // Chat mode switches the OFFICIAL Messages endpoint to the official
    // chat/completions endpoint and translates both directions. Everything
    // else (non-official host, no armed chat-mode activation, unparseable
    // body) stays untouched and is reported exactly like before.
    const switched = switchOfficialMessagesRequest(input, init, url, detected, registries);
    if (switched) return switched;
  }
  if (pathProtocol !== 'chat-completions') {
    // Report every classified non-chat-completions LLM request that carries a
    // session, plus an unknown endpoint that still holds an armed activation,
    // so the workbench sees an explicit unsupported state instead of silence
    // (the panel must never have to guess from activation timing).
    const reportable = detected.sessionId !== null &&
      (detected.protocol !== 'unknown' || sessionActive(registries, detected.sessionId));
    return reportable
      ? { ...untouched, skipped: { protocol: detected.protocol, reason: detected.capability.reason } }
      : untouched;
  }
  const sessionId = detected.sessionId;
  if (!sessionId) return untouched;
  const betaUrl = officialBetaUrl(url);
  if (!sessionActive(registries, sessionId)) return untouched;
  const raw = bodyText(init.body);
  if (raw == null) return untouched;
  let body: JsonObject;
  try { body = JSON.parse(raw) as JsonObject; } catch { return untouched; }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') {
    return untouched;
  }
  const entry = activeEntry(registries, sessionId, last.content);
  if (!entry) return untouched;
  const thinkingEnabled = body.thinking?.type !== 'disabled';
  const messages = thinkingMessages(body.messages, thinkingEnabled);
  messages[messages.length - 1] = { ...messages.at(-1), prefix: true };
  const prefixedBody: JsonObject = { ...body, messages };
  const emulation = entryHandlesToolCalls(entry) && Array.isArray(prefixedBody.tools) &&
    prefixedBody.tools.length > 0 ? emulateToolCallRequest(prefixedBody) : null;
  const extractOutput = entryExtractsOutput(entry);
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
    protocol: detected.protocol,
    ...(emulation || extractOutput ? {
      responseTransform: {
        contentPrefix: emulation?.contentPrefix ?? '',
        reasoningPrefix: emulation?.reasoningPrefix ?? '',
        ...(extractOutput ? { extractOutput: true } : {}),
      },
    } : {}),
  };
}
function bodyText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return null;
}

function jsonBody(init: RequestInitLike): JsonObject | null {
  const raw = bodyText(init.body);
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

/**
 * Switch one official Messages request to the official chat/completions
 * endpoint. Fires only when the session has an activation explicitly armed for
 * chat mode, so a session whose preset was never injected is never touched.
 *
 * The activation content key keeps its prefill meaning: an exact match on the
 * translated trailing assistant message turns on 'prefix' (and sends the
 * request to the beta endpoint that supports it). Without a match the request
 * is still switched and translated, using the session's aggregated activation
 * options.
 */
function switchOfficialMessagesRequest(
  input: FetchInput, init: RequestInitLike, url: URL, detected: ProtocolObservation,
  registries: readonly SessionRegistry[],
): DeepSeekPrefixRewrite | null {
  const sessionId = detected.sessionId;
  if (!sessionId || !officialMessagesUrl(url)) return null;
  if (!sessionArmedForChat(registries, sessionId)) return null;
  const body = jsonBody(init);
  if (!body || !Array.isArray(body.messages)) return null;
  const translated = messagesRequestToChat(body);
  const chat = translated.body;
  const messages = Array.isArray(chat.messages) ? [...chat.messages] : [];
  const last = messages.at(-1);
  const key = typeof last?.content === 'string' ? last.content : '';
  const matched = key.length > 0 ? activeEntry(registries, sessionId, key) : null;
  // Native prefix continuation, DSML tool emulation and body extraction apply
  // only to the plugin's own trailing assistant prefill, exactly as on the
  // chat/completions path. An ordinary injected request whose preset has no
  // prefill is rerouted and translated only, so native tools keep working.
  const entry = matched && entryMode(matched) === 'chat-completions' && last?.role === 'assistant' ? matched : null;
  let finalBody: JsonObject = { ...chat, messages };
  let responseTransform: ResponseTransformMetadata | undefined;
  if (entry) {
    messages[messages.length - 1] = { ...last, prefix: true };
    const prefixed: JsonObject = { ...chat, messages };
    const emulation = entryHandlesToolCalls(entry) && Array.isArray(prefixed.tools) && prefixed.tools.length > 0
      ? emulateToolCallRequest(prefixed) : null;
    const extractOutput = entryExtractsOutput(entry);
    // The official destination always drops native tool fields, mirroring the
    // existing official chat/completions rewrite.
    const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallelToolCalls, ...rest } = emulation?.body ?? prefixed;
    finalBody = rest;
    if (emulation || extractOutput) {
      responseTransform = {
        contentPrefix: emulation?.contentPrefix ?? '',
        reasoningPrefix: emulation?.reasoningPrefix ?? '',
        ...(extractOutput ? { extractOutput: true } : {}),
      };
    }
  }
  // Prefix completion and DSML emulation need the beta endpoint, exactly like
  // the pre-existing official chat rewrite; a plain protocol switch uses the
  // general chat/completions endpoint.
  const target = entry ? new URL(DEEPSEEK_BETA_BASE_URL + '/chat/completions')
    : new URL(DEEPSEEK_OFFICIAL_CHAT_URL);
  target.search = url.search;
  const upstreamModel = typeof finalBody.model === 'string' ? finalBody.model : undefined;
  return {
    input: target.toString(),
    init: { ...init, headers: messagesRequestHeadersToChat(init.headers), body: JSON.stringify(finalBody) },
    changed: true,
    mode: 'switch',
    protocol: 'chat-completions',
    switchedFrom: 'messages',
    translateResponseTo: 'messages',
    ...upstreamModel === undefined ? {} : { upstreamModel },
    ...responseTransform === undefined ? {} : { responseTransform },
  };
}

/* ------------------------------------------------------- global fetch bridge */

interface BridgeHost {
  original: FetchLike;
  wrapped: FetchLike;
  registries: Set<ActivationRegistry>;
  observers: Set<ProtocolObserver>;
}

/** globalThis with our symbol slot typed; the runtime key is the shared Symbol.for. */
type BridgeStore = Record<symbol, BridgeHost | undefined>;
const bridgeStore = (): BridgeStore => globalThis as unknown as BridgeStore;
const currentHost = (): BridgeHost | undefined => bridgeStore()[BRIDGE];

export const BRIDGE_DISPOSED_REASON =
  '预设增强桥接已停止，激活未生效：请求按原样发出（不会静默套用兼容转换）。';
export const BRIDGE_UNAVAILABLE_REASON =
  'globalThis.fetch 不可用或安装失败，预设增强桥接未安装：请求按原样发出。';
export const BRIDGE_INPUT_REASON =
  '缺少会话 ID 或前缀文本，激活未生效：请求按原样发出。';

/**
 * The wrapper is created once per host and reads the host's live registries and observers
 * on every call, so a controller that installs later shares the same wrapper instead of
 * stacking a new one, and an existing (foreign) wrapper is never replaced.
 */
function createWrapper(host: BridgeHost): FetchLike {
  return async function (this: unknown, input: FetchInput, init?: FetchInit): Promise<FetchResponse> {
    const registries = [...host.registries];
    const observers = [...host.observers];
    const seen: Array<{ observer: ProtocolObserver; observation: ProtocolObservation }> = [];
    for (const observer of observers) {
      const observation = observeProtocolRequest(input, init, observer);
      if (observation) seen.push({ observer, observation });
    }
    const rewritten = rewriteDeepSeekPrefixFetch(input, init, registries);
    if (rewritten.skipped) {
      for (const { observer, observation } of seen) {
        observer.record({ ...observation, skipped: true, skippedReason: rewritten.skipped.reason });
      }
    } else {
      const switchedFrom = rewritten.switchedFrom;
      if (switchedFrom) {
        // The workbench reports what really went on the wire: the effective
        // protocol plus the one the caller originally asked for.
        for (const { observer, observation } of seen) {
          const routed: ProtocolObservation & { switchedFrom: LlmProtocol } = {
            ...observation,
            protocol: 'chat-completions',
            capability: protocolCapability('chat-completions'),
            switchedFrom,
          };
          observer.record(routed);
        }
      }
    }
    const response = await Reflect.apply(host.original, this, [rewritten.input, rewritten.init]) as FetchResponse;
    let out = rewritten.responseTransform ?
      await transformToolCallResponse(response, rewritten.responseTransform) : response;
    if (rewritten.translateResponseTo === 'messages') {
      // Only a response this bridge actually rewrote is translated back.
      out = await translateChatResponse(out,
        rewritten.upstreamModel === undefined ? {} : { model: rewritten.upstreamModel });
    }
    return out;
  };
}

/**
 * Install (or reuse) the single shared wrapper. A host installed by someone else is never
 * clobbered: when our symbol is already present the existing host is reused, and when
 * setup throws nothing is left behind.
 */
function acquireHost(): BridgeHost | null {
  const existing = currentHost();
  if (existing) return existing;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return null;
  const host: BridgeHost = {
    original: original as FetchLike,
    wrapped: undefined as unknown as FetchLike,
    registries: new Set(),
    observers: new Set(),
  };
  host.wrapped = createWrapper(host);
  Object.defineProperty(globalThis, BRIDGE, { value: host, configurable: true, writable: true });
  try {
    globalThis.fetch = host.wrapped;
  } catch (error) {
    // Roll back the half-installed bridge: keep globalThis.fetch and the symbol slot as found.
    if (bridgeStore()[BRIDGE] === host) delete bridgeStore()[BRIDGE];
    if (globalThis.fetch === host.wrapped) globalThis.fetch = original;
    throw error;
  }
  return host;
}

/** A release handle: call it to release, and read `applied`/`reason` to know whether it armed. */
export interface DeepSeekBridgeActivation {
  (): void;
  /** True when this activation is registered on the shared bridge. */
  readonly applied: boolean;
  /** Non-empty when `applied` is false. */
  readonly reason: string;
}

export interface DeepSeekBetaActivationOptions {
  toolCalls?: boolean;
  removeNonOfficialTools?: boolean;
  extractOutput?: boolean;
  /**
   * Protocol the injected preset was compiled for. Defaults to 'messages', so
   * an activation that does not state a mode never switches an official
   * Messages request to chat/completions.
   */
  mode?: BridgeProtocolMode;
}

export interface DeepSeekBetaBridgeOptions {
  /** Receives one observation per outbound request that looks like an LLM call. */
  observer?: ProtocolObserver;
}

export interface DeepSeekBetaBridgeStatus {
  /** The shared host exists and this controller still owns a registry in it. */
  attached: boolean;
  /** The shared wrapper currently sits directly on globalThis.fetch. */
  topmost: boolean;
  disposed: boolean;
  /** Live activations owned by this controller. */
  activations: number;
  /** Registries currently known to the shared host. */
  registries: number;
  /** Observers currently known to the shared host. */
  observers: number;
  /** Non-empty when the bridge could not be installed. */
  error: string;
}

export interface DeepSeekBetaBridgeController {
  activate(sessionId: string, content: string, options?: DeepSeekBetaActivationOptions): DeepSeekBridgeActivation;
  /** Idempotent. Restores globalThis.fetch only while it is still our own wrapper. */
  dispose(): void;
  readonly disposed: boolean;
  status(): DeepSeekBetaBridgeStatus;
}

function activation(applied: boolean, reason: string, release: () => void): DeepSeekBridgeActivation {
  const callable = (() => { release(); }) as unknown as DeepSeekBridgeActivation;
  Object.defineProperty(callable, 'applied', { value: applied, enumerable: true });
  Object.defineProperty(callable, 'reason', { value: reason, enumerable: true });
  return callable;
}

/**
 * Install one scoped client for DeepSeek prefix completion. The shared fetch wrapper is
 * inert unless activate() holds an exact session/text pair. The activation also carries the
 * two tool-handling choices used by official and non-official endpoints.
 *
 * Life cycle: activate() after dispose() reports `applied: false` with a reason instead of
 * pretending success, while activations armed before dispose() complete normally and are
 * only detached by their own release(), so a teardown never silently downgrades a rewritten
 * request to an untransformed one.
 */
export function installDeepSeekBetaBridge(
  ctx: PluginContext, options: DeepSeekBetaBridgeOptions = {},
): DeepSeekBetaBridgeController {
  let host: BridgeHost | null = null;
  let error = '';
  try {
    host = acquireHost();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    host = null;
  }
  const registry: ActivationRegistry = new Map();
  host?.registries.add(registry);
  const observer = options.observer;
  if (host && observer) host.observers.add(observer);
  let disposed = false;
  let activations = 0;

  const detachIfUnused = (): void => {
    if (!host) return;
    if (host.registries.size > 0) return;
    if (globalThis.fetch !== host.wrapped) return;
    globalThis.fetch = host.original;
    if (bridgeStore()[BRIDGE] === host) delete bridgeStore()[BRIDGE];
  };

  const releaseOne = (sessionId: string, content: string): void => {
    const texts = registry.get(sessionId);
    if (!texts) return;
    const entry = texts.get(content);
    const count = entryCount(entry);
    if (count <= 1) texts.delete(content);
    else if (entry && typeof entry === 'object') texts.set(content, {
      count: count - 1,
      toolCalls: entry.toolCalls === true,
      removeNonOfficialTools: entry.removeNonOfficialTools !== false,
      extractOutput: entry.extractOutput === true,
      mode: entryMode(entry),
    });
    if (texts.size === 0) registry.delete(sessionId);
    if (disposed && activations === 0) {
      host?.registries.delete(registry);
      detachIfUnused();
    }
  };

  const controller: DeepSeekBetaBridgeController = {
    activate(sessionId, content, activationOptions = {}) {
      if (disposed) return activation(false, BRIDGE_DISPOSED_REASON, () => {});
      if (!host) return activation(false, error || BRIDGE_UNAVAILABLE_REASON, () => {});
      if (!sessionId || typeof content !== 'string') return activation(false, BRIDGE_INPUT_REASON, () => {});
      let texts = registry.get(sessionId);
      if (!texts) { texts = new Map(); registry.set(sessionId, texts); }
      texts.set(content, {
        count: entryCount(texts.get(content)) + 1,
        toolCalls: activationOptions.toolCalls === true,
        removeNonOfficialTools: activationOptions.removeNonOfficialTools !== false,
        extractOutput: activationOptions.extractOutput === true,
        mode: activationOptions.mode === 'chat-completions' ? 'chat-completions' : 'messages',
      });
      activations += 1;
      let active = true;
      return activation(true, '', () => {
        if (!active) return;
        active = false;
        activations -= 1;
        releaseOne(sessionId, content);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!host) return;
      if (observer) host.observers.delete(observer);
      // Complete-in-flight policy: already-armed requests keep transforming until their own
      // release(), so teardown cannot silently emit an untransformed request. An idle
      // controller detaches from the shared host immediately.
      if (activations > 0) return;
      registry.clear();
      host.registries.delete(registry);
      detachIfUnused();
    },
    get disposed() { return disposed; },
    status() {
      return {
        attached: !!host && host.registries.has(registry),
        topmost: !!host && globalThis.fetch === host.wrapped,
        disposed,
        activations,
        registries: host?.registries.size ?? 0,
        observers: host?.observers.size ?? 0,
        error,
      };
    },
  };
  ctx.effect(() => () => controller.dispose(), 'preset-enhance: prefix completion bridge');
  return controller;
}
