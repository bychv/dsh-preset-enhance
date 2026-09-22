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
import { FileResolutionFailure, RequestFiles } from './request-files.mjs';
/** Provider route id the plugin registers. */
export const DEEPSEEK_CHAT_PROVIDER_ID = 'preset-deepseek-chat';
/** Display name shown by the host selectors. */
export const DEEPSEEK_CHAT_PROVIDER_NAME = 'DeepSeek Chat（预设增强）';
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
/**
 * Idle guard as a stream transform: every received byte re-arms the timer and a stall
 * errors the stream explicitly, so the timeout does not depend on the transport
 * honoring an AbortSignal (real fetch does; this makes the contract local anyway).
 */
function idleTimeoutStream(timeoutMs, state) {
    let timer;
    const arm = (controller) => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => { state.timedOut = true; controller.error(new Error(STREAM_IDLE_TIMEOUT_CODE)); }, timeoutMs);
    };
    return new TransformStream({
        start(controller) { arm(controller); },
        transform(chunk, controller) { arm(controller); controller.enqueue(chunk); },
        flush() { if (timer !== undefined)
            clearTimeout(timer); },
    });
}
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
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
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    providerInfo(provider) {
        return { id: provider, name: provider === DEEPSEEK_CHAT_PROVIDER_ID ? DEEPSEEK_CHAT_PROVIDER_NAME : provider };
    }
    providerRetryPolicy(_provider) {
        return this.dependencies.connection().retryPolicy;
    }
    /** DeepSeek vision-token pricing for one exact route (synchronous, no I/O). */
    imageRequestPricing(_provider, model) {
        return deepSeekImageRequestPricing(this.dependencies.connection(), model, this.dependencies.resolveImageAccess);
    }
    listModels(provider) {
        return Promise.resolve(this.dependencies.connection().models.map(model => catalogModelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        return Promise.resolve(modelInfo(this.dependencies.connection(), provider, model));
    }
    prepareCall(provider, model, _signal) {
        const connection = this.dependencies.connection();
        return Promise.resolve({
            model: modelInfo(connection, provider, model),
            stream: options => this.streamWithConnection(options, connection),
        });
    }
    stream(options) {
        return this.streamWithConnection(options, this.dependencies.connection());
    }
    get fetchImpl() {
        return this.dependencies.fetch ?? globalThis.fetch;
    }
    async *streamWithConnection(options, connection) {
        const hasImages = options.messages.some(message => contentHasImage(message.content));
        if (hasImages && this.dependencies.resolveRequestImages === undefined) {
            throw new LlmError('DeepSeek image input requires the host attachment bridge (resolveRequestImages).', 'UNSUPPORTED_CONTENT');
        }
        const apiKey = await this.dependencies.resolveApiKey(connection, options);
        const consumer = new AbortController();
        const upstream = options.signal === undefined
            ? consumer.signal
            : AbortSignal.any([options.signal, consumer.signal]);
        const idle = { timedOut: false };
        let exhausted = false;
        try {
            const iterator = this.request(options, upstream, connection, apiKey, idle)[Symbol.asyncIterator]();
            for (;;) {
                const result = await iterator.next();
                if (result.done === true) {
                    exhausted = true;
                    return;
                }
                yield result.value;
            }
        }
        catch (error) {
            if (idle.timedOut) {
                throw new LlmError('DeepSeek stream idle timeout after ' + connection.streamIdleTimeoutMs + 'ms', 'TIMEOUT', { cause: error });
            }
            if (options.signal?.aborted === true) {
                throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error });
            }
            if (error instanceof LlmError)
                throw error;
            throw new LlmError('DeepSeek API stream from ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
        }
        finally {
            // The consumer controller owns termination for every exit path.
            consumer.abort('DeepSeek stream consumer stopped');
            if (exhausted) { /* normal completion */ }
        }
    }
    async *request(options, signal, connection, apiKey, idle) {
        const attribution = (this.dependencies.attributionHeaders ?? defaultAttributionHeaders)();
        const headers = {
            authorization: 'Bearer ' + apiKey,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...attribution,
            'x-deepseek-harness-user-id': this.dependencies.resolveUserId?.() ?? 'preset-enhance',
            ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
            ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
        };
        const defaults = {
            ...connection.thinking === undefined ? {} : { thinking: connection.thinking },
            ...connection.reasoningEffort === undefined ? {} : { reasoningEffort: connection.reasoningEffort },
        };
        let body;
        if (!options.messages.some(message => contentHasImage(message.content))) {
            body = serializeRequest(options, defaults);
        }
        else {
            const resolveImages = this.dependencies.resolveRequestImages;
            if (resolveImages === undefined) {
                throw new LlmError('DeepSeek image input requires the host attachment bridge.', 'UNSUPPORTED_CONTENT');
            }
            const requestImages = await resolveImages(options, signal);
            const imageAccess = this.dependencies.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.dependencies.resolveImageAccess };
            // Inline fallback knobs: the base64 payload bound after a Files downgrade.
            const base64Images = {
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
            }
            else {
                const fileConnection = { baseURL: connection.baseURL, apiKey, protocol: 'chat-completions' };
                const requestFiles = new RequestFiles(files, fileConnection, connection.filePolicy, connection.filesApiTimeoutMs, signal);
                // Representation starts on the Files path; exactly one downgrade is allowed.
                let representation = 'file';
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
                    }
                    catch (error) {
                        // Only a Files resolution failure may downgrade the whole request, and only once.
                        if (!(error instanceof FileResolutionFailure))
                            throw error;
                        representation = 'base64';
                    }
                }
            }
        }
        let response;
        try {
            response = await this.fetchImpl(connection.baseURL + '/chat/completions', {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal,
            });
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw new LlmError('DeepSeek API request to ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            let message = 'DeepSeek API error (HTTP ' + response.status + ')';
            let providerError;
            const rawResponse = await response.text();
            try {
                const parsed = JSON.parse(rawResponse);
                providerError = parsed.error;
                if (providerError?.message !== undefined)
                    message = providerError.message;
            }
            catch {
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
        if (response.body === null)
            throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE');
        const sseBody = response.body.pipeThrough(idleTimeoutStream(connection.streamIdleTimeoutMs, idle));
        yield* translate(parseSse(sseBody));
    }
}
/** Factory the plugin entry calls once; the result is passed to ctx.llm.registerAdapter. */
export function createDeepSeekChatAdapter(dependencies) {
    return new DeepSeekChatAdapter(dependencies);
}
/** Exports the plugin entry registers with the host llm service. */
export const DEEPSEEK_CHAT_REGISTRATION = {
    provider: DEEPSEEK_CHAT_PROVIDER_ID,
    name: DEEPSEEK_CHAT_PROVIDER_NAME,
};
