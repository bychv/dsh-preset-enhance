/**
 * Vendored DeepSeek Chat Completions adapter for DSH 0.1.7-alpha.1.
 * Upstream basis: dsh-v0.1.6-alpha.2 packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts
 * (transport, error mapping, abort and idle handling). MIT licensed; Copyright (c) DeepSeek.
 */

import { LlmError, httpErrorCode } from './errors.mjs';
import { attributionHeaders as defaultAttributionHeaders, catalogModelInfo, modelInfo } from './config.mjs';
import { parseSse } from './sse.mjs';
import { translate } from './translate.mjs';
import { contentHasImage, serializeRequest, serializeRequestWithImages } from './serialize.mjs';
import { deepSeekImageRequestPricing } from './pricing.mjs';
import type { RequestDefaults } from './serialize.mjs';
import type { ChatConnectionConfig } from './config.mjs';
import type { WireError, WireRequest } from './wire-types.mjs';
import type {
  AttributionHeaders, GenerateOptions, ImageAttachmentAccess, ImageAttachmentRef, LlmImageRequestPricing, LlmModelInfo, LlmProviderInfo,
  LlmResolvedModelInfo, PreparedAdapterCall, RequestImageAttachment, StreamChunk,
} from './host-types.mjs';

/** Provider route id the plugin registers. */
export const DEEPSEEK_CHAT_PROVIDER_ID = 'preset-deepseek-chat';
/** Display name shown by the host selectors. */
export const DEEPSEEK_CHAT_PROVIDER_NAME = 'DeepSeek Chat（预设增强）';

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';

/** Dependencies the plugin entry wires into the adapter (all resolved per request). */
export interface DeepSeekChatDependencies {
  /** Connection facts, re-resolved for every stream call. */
  connection: () => ChatConnectionConfig;
  /** Resolve the provider API key for one request; never cache or copy it. */
  resolveApiKey: (connection: ChatConnectionConfig, options: GenerateOptions) => Promise<string>;
  /** Anonymous user id sent as x-deepseek-harness-user-id. */
  resolveUserId?: () => string;
  /** Host attribution headers; defaults to the local replica of the host default. */
  attributionHeaders?: AttributionHeaders;
  /** fetch implementation; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Host attachment bridge: prepare request versions for the retained images. */
  resolveRequestImages?: (options: GenerateOptions, signal: AbortSignal) => Promise<Map<string, RequestImageAttachment>>;
  /** Current read-only access for one image reference (handle text). */
  resolveImageAccess?: (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined;
}

/** Abort-driven per-read idle watchdog: pulses on transport activity. */
/** Per-request idle facts shared with the stream error mapping. */
interface IdleState { timedOut: boolean }

/** Structural view of the TransformStream controller used here (no DOM lib). */
interface IdleController { enqueue(chunk: Uint8Array): void; error(reason?: unknown): void }

/**
 * Idle guard as a stream transform: every received byte re-arms the timer and a stall
 * errors the stream explicitly, so the timeout does not depend on the transport
 * honoring an AbortSignal (real fetch does; this makes the contract local anyway).
 */
function idleTimeoutStream(timeoutMs: number, state: IdleState): TransformStream<Uint8Array, Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (controller: IdleController): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { state.timedOut = true; controller.error(new Error(STREAM_IDLE_TIMEOUT_CODE)); }, timeoutMs);
  };
  return new TransformStream({
    start(controller: IdleController) { arm(controller); },
    transform(chunk: Uint8Array, controller: IdleController) { arm(controller); controller.enqueue(chunk); },
    flush() { if (timer !== undefined) clearTimeout(timer); },
  });
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]+$/u.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/**
 * Chat Completions adapter. Transport-only: connection facts come from the
 * injected thunk and the bearer token from the injected per-request resolver,
 * so the registering plugin owns config layering and credential policy.
 */
export class DeepSeekChatAdapter {
  private readonly dependencies: DeepSeekChatDependencies;

  constructor(dependencies: DeepSeekChatDependencies) {
    this.dependencies = dependencies;
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider === DEEPSEEK_CHAT_PROVIDER_ID ? DEEPSEEK_CHAT_PROVIDER_NAME : provider };
  }

  providerRetryPolicy(_provider: string): ChatConnectionConfig['retryPolicy'] {
    return this.dependencies.connection().retryPolicy;
  }

  /** DeepSeek vision-token pricing for one exact route (synchronous, no I/O). */
  imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    return deepSeekImageRequestPricing(this.dependencies.connection(), model, this.dependencies.resolveImageAccess);
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.dependencies.connection().models.map(model => catalogModelInfo(provider, model)));
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.dependencies.connection(), provider, model));
  }

  prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.dependencies.connection();
    return Promise.resolve({
      model: modelInfo(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    });
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.dependencies.connection());
  }

  private get fetchImpl(): typeof fetch {
    return this.dependencies.fetch ?? globalThis.fetch;
  }

  private async * streamWithConnection(options: GenerateOptions, connection: ChatConnectionConfig): AsyncIterable<StreamChunk> {
    const hasImages = options.messages.some(message => contentHasImage(message.content));
    if (hasImages && this.dependencies.resolveRequestImages === undefined) {
      throw new LlmError('DeepSeek image input requires the host attachment bridge (resolveRequestImages).', 'UNSUPPORTED_CONTENT');
    }
    const apiKey = await this.dependencies.resolveApiKey(connection, options);
    const consumer = new AbortController();
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal]);
    const idle: IdleState = { timedOut: false };
    let exhausted = false;
    try {
      const iterator = this.request(options, upstream, connection, apiKey, idle)[Symbol.asyncIterator]();
      for (;;) {
        const result = await iterator.next();
        if (result.done === true) { exhausted = true; return; }
        yield result.value;
      }
    } catch (error: unknown) {
      if (idle.timedOut) {
        throw new LlmError('DeepSeek stream idle timeout after ' + connection.streamIdleTimeoutMs + 'ms', 'TIMEOUT', { cause: error });
      }
      if (options.signal?.aborted === true) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError('DeepSeek API stream from ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
    } finally {
      // The consumer controller owns termination for every exit path.
      consumer.abort('DeepSeek stream consumer stopped');
      if (exhausted) { /* normal completion */ }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: ChatConnectionConfig,
    apiKey: string,
    idle: IdleState,
  ): AsyncIterable<StreamChunk> {
    const attribution = (this.dependencies.attributionHeaders ?? defaultAttributionHeaders)();
    const headers: Record<string, string> = {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attribution,
      'x-deepseek-harness-user-id': this.dependencies.resolveUserId?.() ?? 'preset-enhance',
      ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
      ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
    };
    const defaults: RequestDefaults = {
      ...connection.thinking === undefined ? {} : { thinking: connection.thinking },
      ...connection.reasoningEffort === undefined ? {} : { reasoningEffort: connection.reasoningEffort },
    };
    let body: WireRequest;
    if (!options.messages.some(message => contentHasImage(message.content))) {
      body = serializeRequest(options, defaults);
    } else {
      const resolveImages = this.dependencies.resolveRequestImages;
      if (resolveImages === undefined) {
        throw new LlmError('DeepSeek image input requires the host attachment bridge.', 'UNSUPPORTED_CONTENT');
      }
      const requestImages = await resolveImages(options, signal);
      body = serializeRequestWithImages(options, {
        representation: { kind: 'base64' },
        requestImages,
        ...this.dependencies.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.dependencies.resolveImageAccess },
        maxRequestImageBytes: connection.maxInlineRequestImageBytes,
        ...connection.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: connection.maxImagesPerRequest },
        ...connection.inlineImageOffloadByteQuantum === undefined ? {} : { byteQuantum: connection.inlineImageOffloadByteQuantum },
        ...connection.imageOffloadCountQuantum === undefined ? {} : { countQuantum: connection.imageOffloadCountQuantum },
      }, defaults);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(connection.baseURL + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      throw new LlmError('DeepSeek API request to ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      let message = 'DeepSeek API error (HTTP ' + response.status + ')';
      let providerError: WireError['error'];
      const rawResponse = await response.text();
      try {
        const parsed = JSON.parse(rawResponse) as WireError;
        providerError = parsed.error;
        if (providerError?.message !== undefined) message = providerError.message;
      } catch {
        // The HTTP status remains authoritative for a malformed gateway body.
      }
      const detail = [providerError?.code, providerError?.type, providerError?.message].filter(Boolean).join(' ');
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      const id = response.headers.get('x-request-id') ?? response.headers.get('x-deepseek-request-id') ?? undefined;
      throw new LlmError(message, httpErrorCode(response.status, providerError ?? {}), {
        cause: new Error(rawResponse.length > 0 ? rawResponse : 'DeepSeek HTTP ' + response.status),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined || id.length === 0 ? {} : { requestId: id },
      });
    }
    if (response.body === null) throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE');
    const sseBody = response.body.pipeThrough(idleTimeoutStream(connection.streamIdleTimeoutMs, idle));
    yield* translate(parseSse(sseBody));
  }
}

/** Factory the plugin entry calls once; the result is passed to ctx.llm.registerAdapter. */
export function createDeepSeekChatAdapter(dependencies: DeepSeekChatDependencies): DeepSeekChatAdapter {
  return new DeepSeekChatAdapter(dependencies);
}

/** Exports the plugin entry registers with the host llm service. */
export const DEEPSEEK_CHAT_REGISTRATION = {
  provider: DEEPSEEK_CHAT_PROVIDER_ID,
  name: DEEPSEEK_CHAT_PROVIDER_NAME,
} as const;