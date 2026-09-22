/**
 * Vendored DeepSeek Chat Completions adapter for DSH 0.1.7-alpha.1.
 * Upstream basis: dsh-v0.1.6-alpha.2 packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts
 * (transport, error mapping, abort and idle handling). MIT licensed; Copyright (c) DeepSeek.
 */

import { LlmError, httpErrorCode } from './errors.mjs';
import type { LlmErrorDetails } from './errors.mjs';
import { attributionHeaders as defaultAttributionHeaders, catalogModelInfo, modelInfo } from './config.mjs';
import { parseSse } from './sse.mjs';
import { translate } from './translate.mjs';
import { contentHasImage, serializeRequest, serializeRequestWithImages } from './serialize.mjs';
import { deepSeekImageRequestPricing } from './pricing.mjs';
import { FileResolutionFailure, RequestFiles } from './request-files.mjs';
import type { ImageSerializationOptions, RequestDefaults } from './serialize.mjs';
import type { DeepSeekFileStore } from './file-store.mjs';
import type { ChatConnectionConfig } from './config.mjs';
import type { WireError, WireRequest } from './wire-types.mjs';
import type {
  AttributionHeaders, GenerateOptions, ImageAttachmentAccess, ImageAttachmentRef, LlmImageRequestPricing, LlmModelInfo, LlmProviderInfo,
  LlmErrorFactory, LlmResolvedModelInfo, PreparedAdapterCall, RequestImageAttachment, StreamChunk,
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
  /**
   * Build the error thrown for every adapter failure. Pass a factory returning real host
   * LlmError instances so the host keeps our code: agent-loop narrows by class identity and reads
   * error.failure (packages/core/agent-loop/src/agent.ts:359-361). Omitted means our structural
   * LlmError is thrown and the panel reports UNKNOWN.
   */
  createError?: LlmErrorFactory;
  /**
   * Process-wide Files upload reuse store, resolved per request. Absence keeps
   * the inline base64 representation; when present the adapter first tries the
   * provider Files path and downgrades to base64 once on FileResolutionFailure.
   */
  resolveFiles?: () => DeepSeekFileStore;
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
  /** Errors built by the injected factory, so normalization passes them through untouched. */
  private readonly produced = new WeakSet<object>();

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

  /** Build one failure through the injected host factory when present. */
  private fail(message: string, code: string, details: LlmErrorDetails = {}): Error {
    const factory = this.dependencies.createError;
    if (factory === undefined) return new LlmError(message, code, details);
    const error = factory(message, code, details);
    if (typeof error === 'object' && error !== null) this.produced.add(error);
    return error;
  }

  /** Rebuild one of our failures through the factory so the host class carries the same facts. */
  private rewrap(error: LlmError): Error {
    return this.fail(error.message, error.code, {
      cause: error,
      ...error.status === undefined ? {} : { status: error.status },
      ...error.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: error.providerRetryAfterMs },
      ...error.requestId === undefined ? {} : { requestId: error.requestId },
      ...error.offloadImages === undefined ? {} : { offloadImages: error.offloadImages },
    });
  }

  private get fetchImpl(): typeof fetch {
    return this.dependencies.fetch ?? globalThis.fetch;
  }

  private async * streamWithConnection(options: GenerateOptions, connection: ChatConnectionConfig): AsyncIterable<StreamChunk> {
    const hasImages = options.messages.some(message => contentHasImage(message.content));
    if (hasImages && this.dependencies.resolveRequestImages === undefined) {
      throw this.fail('DeepSeek image input requires the host attachment bridge (resolveRequestImages).', 'UNSUPPORTED_CONTENT');
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
        throw this.fail('DeepSeek stream idle timeout after ' + connection.streamIdleTimeoutMs + 'ms', 'TIMEOUT', { cause: error });
      }
      if (options.signal?.aborted === true) {
        throw this.fail('DeepSeek request aborted by caller', 'ABORTED', { cause: error });
      }
      if (error instanceof LlmError) {
        // A serializer/pricing failure reaches this normalization too: rebuild it through the
        // factory so the host recognizes the class and keeps the code instead of UNKNOWN.
        if (this.dependencies.createError !== undefined) throw this.rewrap(error);
        throw error;
      }
      if (typeof error === 'object' && error !== null && this.produced.has(error)) throw error;
      throw this.fail('DeepSeek API stream from ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
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
        throw this.fail('DeepSeek image input requires the host attachment bridge.', 'UNSUPPORTED_CONTENT');
      }
      const requestImages = await resolveImages(options, signal);
      const imageAccess: Pick<ImageSerializationOptions, 'resolveImageAccess'> =
        this.dependencies.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.dependencies.resolveImageAccess };
      // Inline fallback knobs: the base64 payload bound after a Files downgrade.
      const base64Images: ImageSerializationOptions & { representation: { kind: 'base64' } } = {
        representation: { kind: 'base64' },
        requestImages,
        ...imageAccess,
        maxRequestImageBytes: connection.maxInlineRequestImageBytes,
        ...connection.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: connection.maxImagesPerRequest },
        ...connection.inlineImageOffloadByteQuantum === undefined ? {} : { byteQuantum: connection.inlineImageOffloadByteQuantum },
        ...connection.imageOffloadCountQuantum === undefined ? {} : { countQuantum: connection.imageOffloadCountQuantum },
      };
      const files = this.dependencies.resolveFiles?.();
      if (files === undefined) {
        // No Files store is wired for this activation: inline base64 is the only representation.
        body = serializeRequestWithImages(options, base64Images, defaults);
      } else {
        const fileConnection = { baseURL: connection.baseURL, apiKey, protocol: 'chat-completions' } as const;
        const requestFiles = new RequestFiles(files, fileConnection, connection.filePolicy, connection.filesApiTimeoutMs, signal);
        // Representation starts on the Files path; exactly one downgrade is allowed.
        let representation: 'file' | 'base64' = 'file';
        for (;;) {
          requestFiles.beginAttempt();
          if (representation === 'base64') {
            body = serializeRequestWithImages(options, base64Images, defaults);
            break;
          }
          try {
            body = await serializeRequestWithImages(options, {
              representation: {
                kind: 'file',
                resolveFileId: (version, _block, location) => requestFiles.resolve(version, location),
              },
              requestImages,
              ...imageAccess,
              maxRequestImageBytes: connection.maxRequestFilesBytes,
              ...connection.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: connection.maxImagesPerRequest },
              ...connection.imageOffloadByteQuantum === undefined ? {} : { byteQuantum: connection.imageOffloadByteQuantum },
              ...connection.imageOffloadCountQuantum === undefined ? {} : { countQuantum: connection.imageOffloadCountQuantum },
            }, defaults);
            break;
          } catch (error: unknown) {
            // Only a Files resolution failure may downgrade the whole request, and only once.
            if (!(error instanceof FileResolutionFailure)) throw error;
            representation = 'base64';
          }
        }
      }
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
      throw this.fail('DeepSeek API request to ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
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
      throw this.fail(message, httpErrorCode(response.status, providerError ?? {}), {
        cause: new Error(rawResponse.length > 0 ? rawResponse : 'DeepSeek HTTP ' + response.status),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined || id.length === 0 ? {} : { requestId: id },
      });
    }
    if (response.body === null) throw this.fail('DeepSeek API returned no response body', 'EMPTY_RESPONSE');
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