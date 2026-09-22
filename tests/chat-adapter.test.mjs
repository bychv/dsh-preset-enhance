/**
 * Unit tests for the vendored DeepSeek Chat Completions adapter (DSH 0.1.7 wiring).
 * Imports the BUILT tree: run `node scripts/build.mjs` first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTION_PRODUCT, ATTRIBUTION_URL, DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEEPSEEK_CHAT_BASE_URL,
  DEEPSEEK_CHAT_PROVIDER_ID, DEEPSEEK_CHAT_PROVIDER_NAME, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError,
  createDeepSeekChatAdapter, deepSeekImageRequestPricing, deepSeekImageTokens, deepSeekRequestImageDimensions,
  longEdgeDimensions, mapUsage, offloadedImageText, requestImageDimensions, resolveChatConnection,
  resolveRequestImageMaxBytes, resolveRequestImageTarget, serializeRequest, serializeRequestWithImages, textOnlyImageText,
} from '../vendor/deepseek-chat/index.mjs';

const NL = String.fromCharCode(10);
const KEY = 'test-key-never-printed';
const ATTRIBUTION = {
  'user-agent': ATTRIBUTION_PRODUCT + '/0.1.7-alpha.1 (+' + ATTRIBUTION_URL + ')',
};

/** One SSE response whose bytes are emitted in configurable slices. */
function sseResponse(payloads, options = {}) {
  const chunkSize = options.chunkSize ?? (1 << 20);
  const text = payloads.map(payload => 'data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)) + NL + NL).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A stream that yields one event and then stalls forever (idle-timeout probe). */
function stalledResponse(payload, signal) {
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify(payload) + NL + NL);
  return new Response(new ReadableStream({
start(controller) { controller.enqueue(bytes); signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textChunk(text, reasoning) {
  return {
    id: 'r', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { ...reasoning === undefined ? {} : { reasoning_content: reasoning }, content: text }, finish_reason: null }],
  };
}

/** Build an adapter over a stub fetch; returns the adapter plus the captured requests. */
function makeAdapter(respond, overrides = {}) {
  const requests = [];
  const keys = [];
  const connection = resolveChatConnection({ streamIdleTimeoutMs: 50, ...overrides });
  const adapter = createDeepSeekChatAdapter({
    connection: () => connection,
    resolveApiKey: async (config, options) => { keys.push({ baseURL: config.baseURL, sessionId: options.sessionId }); return KEY; },
    resolveUserId: () => 'tester',
    fetch: async (url, init) => {
      requests.push({ url, init, body: init?.body === undefined ? null : JSON.parse(init.body), headers: init.headers });
return typeof respond === 'function' ? respond(requests.length, init) : respond;
    },
  });
  return { adapter, connection, requests, keys };
}

function baseOptions() {
  return {
    provider: DEEPSEEK_CHAT_PROVIDER_ID,
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test('plugin Chat connection defaults to the official Chat root, never the Messages base', () => {
  const connection = resolveChatConnection();
  assert.equal(connection.baseURL, 'https://api.deepseek.com');
  assert.equal(DEEPSEEK_CHAT_BASE_URL, 'https://api.deepseek.com');
  assert.equal(connection.baseURL.includes('anthropic'), false);
  assert.equal(DEEPSEEK_CHAT_PROVIDER_ID, 'preset-deepseek-chat');
  assert.equal(DEEPSEEK_CHAT_PROVIDER_NAME, 'DeepSeek Chat（预设增强）');
});

test('one plain-text request completes end to end and carries attribution', async () => {
  const response = sseResponse([
    textChunk('Hello'), textChunk(' world'),
    { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
    '[DONE]',
  ], { chunkSize: 7 });
  const parts = makeAdapter(response);
  const chunks = await collect(parts.adapter.stream({
    provider: DEEPSEEK_CHAT_PROVIDER_ID, model: 'deepseek-flash', sessionId: 'session-42',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));
  assert.equal(parts.requests.length, 1);
  assert.equal(parts.requests[0].url, DEEPSEEK_CHAT_BASE_URL + '/chat/completions');
  // Attribution contract: every provider request carries the host user-agent shape.
  const userAgent = parts.requests[0].headers['user-agent'];
  assert.equal(userAgent, ATTRIBUTION['user-agent']);
  assert.equal(userAgent.startsWith('deepseek-harness/'), true);
  assert.equal(userAgent.endsWith('(+https://github.com/deepseek-ai/deepseek-harness)'), true);
  assert.equal(parts.requests[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(parts.requests[0].headers['content-type'], 'application/json');
  assert.equal(parts.requests[0].headers.accept, 'text/event-stream');
  assert.equal(parts.requests[0].headers['x-deepseek-harness-user-id'], 'tester');
  assert.equal(parts.requests[0].headers['x-deepseek-harness-session-id'], 'session-42');
  assert.equal(parts.requests[0].body.model, 'deepseek-flash');
  assert.equal(parts.requests[0].body.stream, true);
  assert.deepEqual(parts.requests[0].body.stream_options, { include_usage: true });
  assert.deepEqual(parts.requests[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(parts.requests[0].body.tools, undefined);
  assert.deepEqual(parts.keys, [{ baseURL: DEEPSEEK_CHAT_BASE_URL, sessionId: 'session-42' }]);
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello' },
    { type: 'text-delta', index: 0, text: ' world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('the key resolver runs once per request and is never cached', async () => {
  const parts = makeAdapter(() => sseResponse([textChunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']));
  const options = { provider: DEEPSEEK_CHAT_PROVIDER_ID, model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] };
  await collect(parts.adapter.stream(options));
  await collect(parts.adapter.stream({ ...options, sessionId: 'second' }));
  assert.equal(parts.requests.length, 2);
  assert.deepEqual(parts.keys.map(entry => entry.sessionId), [undefined, 'second']);
  assert.equal(parts.requests[1].headers['x-deepseek-harness-session-id'], 'second');
});

test('message role order is preserved, including a system prompt after chatHistory', () => {
  const body = serializeRequest({
    provider: DEEPSEEK_CHAT_PROVIDER_ID, model: 'deepseek-flash', system: 'leading system',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'history user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'history answer' }] },
      { role: 'system', content: [{ type: 'text', text: 'system after chatHistory' }] },
      { role: 'user', content: [{ type: 'text', text: 'next question' }] },
    ],
  });
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'system', 'user']);
  assert.equal(body.messages[0].content, 'leading system');
  assert.equal(body.messages[3].content, 'system after chatHistory');
  assert.equal(body.messages[4].content, 'next question');
});

test('assistant reasoning and tool-call history keep ids and result association', () => {
  const body = serializeRequest({
    provider: DEEPSEEK_CHAT_PROVIDER_ID, model: 'deepseek-flash',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'need the tool' },
        { type: 'text', text: '' },
        { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '22C' }] },
      ] },
    ],
  });
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(body.messages[1], {
    role: 'assistant', content: '', reasoning_content: 'need the tool',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }],
  });
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call-1', content: '22C' });
});

test('thinking config and reasoning effort reach the wire without exposing off', () => {
  const on = serializeRequest({ provider: 'p', model: 'm', system: 's', messages: [], reasoningEffort: 'max' }, { thinking: 'enabled' });
  assert.deepEqual(on.thinking, { type: 'enabled' });
  assert.equal(on.reasoning_effort, 'max');
  const off = serializeRequest({ provider: 'p', model: 'm', system: 's', messages: [] }, { reasoningEffort: 'off' });
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.equal(off.reasoning_effort, undefined);
  const disabled = serializeRequest({ provider: 'p', model: 'm', system: 's', messages: [], purpose: 'session-title' }, { thinking: 'enabled', reasoningEffort: 'high' });
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  assert.throws(() => serializeRequest({ provider: 'p', model: 'm', system: 's', messages: [], reasoningEffort: 'turbo' }, {}), (error) => error instanceof LlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT');
});

test('SSE increments survive arbitrary chunk boundaries and terminate on [DONE]', async () => {
  const payloads = [
    textChunk(String.fromCharCode(0x4F60)), textChunk(String.fromCharCode(0x597D)),
    { id: 'r', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-7', function: { name: 'get_weather', arguments: '{"city":' } }] } }] },
    { id: 'r', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Shanghai"}' } }] }, finish_reason: 'tool_calls' }] },
    { id: 'r', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 2 } },
    '[DONE]',
  ];
  const oneShot = await collect(makeAdapter(sseResponse(payloads)).adapter.stream(baseOptions()));
  for (const chunkSize of [1, 3, 17]) {
    const split = await collect(makeAdapter(sseResponse(payloads, { chunkSize })).adapter.stream(baseOptions()));
    assert.deepEqual(split, oneShot, 'chunk size ' + chunkSize);
  }
  assert.equal(oneShot.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), String.fromCharCode(0x4F60, 0x597D));
  assert.deepEqual(oneShot.filter(chunk => chunk.type === 'usage').map(chunk => chunk.usage), [{ inputTokens: 3, outputTokens: 3, totalTokens: 8, cacheReadTokens: 2 }]);
  assert.deepEqual(oneShot.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  const toolChunks = oneShot.filter(chunk => chunk.type === 'tool-call-delta');
  assert.equal(toolChunks.at(-1).name, 'get_weather');
  assert.equal(toolChunks.map(chunk => chunk.argumentsDelta).join(''), '{"city":"Shanghai"}');
  assert.equal(toolChunks[0].id, 'call-7');
});

test('a truncated SSE stream fails instead of completing silently', async () => {
  const parts = makeAdapter(() => sseResponse([textChunk('partial')]));
  await assert.rejects(collect(parts.adapter.stream(baseOptions())), (error) => error instanceof LlmError && error.code === 'STREAM_CLOSED');
});

test('caller cancellation surfaces as ABORTED', async () => {
  const parts = makeAdapter((count, init) => stalledResponse(textChunk('first'), init.signal));
  const controller = new AbortController();
  const iterator = parts.adapter.stream({ ...baseOptions(), signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.type, 'block-start');
  const second = await iterator.next();
  assert.equal(second.value.type, 'text-delta');
  assert.equal(second.value.text, 'first');
  controller.abort();
  await assert.rejects(iterator.next(), (error) => error instanceof LlmError && error.code === 'ABORTED');
});

test('an idle stream surfaces as TIMEOUT', async () => {
  const parts = makeAdapter(() => stalledResponse(textChunk('first')));
  await assert.rejects(collect(parts.adapter.stream(baseOptions())), (error) => error instanceof LlmError && error.code === 'TIMEOUT');
});

test('HTTP failures map to stable codes with provider detail', async () => {
  const cases = [
    { status: 401, body: { error: { message: 'bad key' } }, code: 'AUTH' },
    { status: 400, body: { error: { message: 'invalid request' } }, code: 'INVALID_REQUEST' },
    { status: 400, body: { error: { message: 'maximum context length is 65536 tokens' } }, code: 'CONTEXT_WINDOW_EXCEEDED' },
    { status: 429, body: { error: { message: 'rate limited' } }, code: 'RATE_LIMIT' },
    { status: 402, body: { error: { message: 'Insufficient Balance' } }, code: 'QUOTA_EXCEEDED' },
    { status: 503, body: {}, code: 'SERVER' },
  ];
  for (const entry of cases) {
    const parts = makeAdapter(() => new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-request-id': 'req-1' },
    }));
    await assert.rejects(collect(parts.adapter.stream(baseOptions())), (error) => {
      assert.equal(error.code, entry.code);
      assert.equal(error.status, entry.status);
      assert.equal(error.providerRetryAfterMs, 2000);
      assert.equal(error.requestId, 'req-1');
      return true;
    }, String(entry.status));
  }
  const parts = makeAdapter(() => new Response('gateway text', { status: 502 }));
  await assert.rejects(collect(parts.adapter.stream(baseOptions())), (error) => error.code === 'SERVER' && error.message.includes('HTTP 502'));
});

test('usage mapping keeps counts disjoint and omits an inconsistent total', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } }),
    { inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, reasoningTokens: 5 });
  assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 }), { inputTokens: 10, outputTokens: 5 });
});

test('inline image serialization and its request budget', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const image = { attachmentId: 'att-1', mediaType: 'image/png', name: 'chart.png' };
  const options = {
    provider: 'p', model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: image }] }],
  };
  const images = {
    representation: { kind: 'base64' },
    requestImages: new Map([['att-1', { mediaType: 'image/png', data: bytes, bytes: bytes.byteLength, width: 2, height: 2 }]]),
    maxRequestImageBytes: 1024,
  };
  const body = serializeRequestWithImages(options, images, {});
  const content = body.messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].text, 'look');
  assert.equal(content[1].text.includes('att-1'), true);
  assert.equal(content[2].type, 'image_url');
  assert.equal(content[2].image_url.url, 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
  const offloaded = { ...options, messages: [{ role: 'user', content: [{ type: 'image', attachment: image, offloaded: true }] }] };
  const textOnly = serializeRequestWithImages(offloaded, images, {});
  assert.equal(typeof textOnly.messages[0].content, 'string');
  assert.equal(textOnly.messages[0].content.includes('omitted to fit request image limits'), true);
  assert.throws(() => serializeRequestWithImages(options, { ...images, maxRequestImageBytes: 2 }, {}),
    (error) => error instanceof LlmError && error.code === IMAGE_OFFLOAD_REQUIRED_CODE && error.offloadImages === 1);
  const assistantImage = { ...options, messages: [{ role: 'assistant', content: [{ type: 'image', attachment: image }] }] };
  assert.throws(() => serializeRequestWithImages(assistantImage, images, {}), (error) => error.code === 'UNSUPPORTED_CONTENT');
});

test('adapter metadata answers the host catalog questions', async () => {
  const parts = makeAdapter(() => sseResponse(['[DONE]']));
  assert.deepEqual(parts.adapter.providerInfo(DEEPSEEK_CHAT_PROVIDER_ID), { id: DEEPSEEK_CHAT_PROVIDER_ID, name: DEEPSEEK_CHAT_PROVIDER_NAME });
  const models = await parts.adapter.listModels(DEEPSEEK_CHAT_PROVIDER_ID);
  assert.deepEqual(models.map(model => model.id), ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']);
  const resolved = await parts.adapter.resolveModel(DEEPSEEK_CHAT_PROVIDER_ID, 'deepseek-flash');
  assert.equal(resolved.name, 'DeepSeek Flash');
  assert.equal(resolved.context.contextWindow, 1000000);
  assert.equal(resolved.defaultMaxTokens, 65536);
  assert.equal(resolved.reasoning.defaultEffort, 'high');
  assert.equal(parts.adapter.providerRetryPolicy(DEEPSEEK_CHAT_PROVIDER_ID).maxRetries, 5);
  const prepared = await parts.adapter.prepareCall(DEEPSEEK_CHAT_PROVIDER_ID, 'deepseek-flash');
  assert.equal(prepared.model.id, 'deepseek-flash');
  assert.equal(typeof prepared.stream, 'function');
});

test('request-image target maths never enlarges and converges under the caps', () => {
  // Small images are never enlarged on any path.
  assert.deepEqual(longEdgeDimensions(100, 80, 4096), { width: 100, height: 80 });
  assert.deepEqual(requestImageDimensions(100, 80, 512 * 512), { width: 100, height: 80 });
  assert.deepEqual(deepSeekRequestImageDimensions(100, 80), { width: 100, height: 80 });
  // A huge source converges to the published token cap and the provider per-side cap.
  const huge = resolveRequestImageTarget({ id: 'm', name: 'M', inputModalities: ['image'] }, { width: 8000, height: 6000 });
  assert.equal(Math.max(huge.width, huge.height) <= 4096, true);
  assert.equal(deepSeekImageTokens(huge.width, huge.height) <= 1024, true);
  assert.equal(huge.width < 8000 && huge.height < 6000, true);
  assert.equal(huge.maxBytes, DEFAULT_REQUEST_IMAGE_MAX_BYTES);
  assert.deepEqual(deepSeekRequestImageDimensions(huge.width, huge.height), { width: huge.width, height: huge.height });
  // A low-detail pixel budget is a total-pixel cap and still never enlarges.
  const low = resolveRequestImageTarget({ id: 'm', name: 'M', inputModalities: ['image'], imagePixelBudget: 'low' }, { width: 4000, height: 4000 });
  assert.equal(low.width * low.height <= 512 * 512, true);
  const lowSmall = resolveRequestImageTarget({ id: 'm', name: 'M', imagePixelBudget: 'low' }, { width: 100, height: 80 });
  assert.deepEqual({ width: lowSmall.width, height: lowSmall.height }, { width: 100, height: 80 });
  // The per-route byte target is configurable.
  assert.equal(resolveRequestImageMaxBytes({ id: 'm', name: 'M', imageMaxBytes: 1234 }), 1234);
});

test('pricing prices retained, offloaded and text-only occurrences', () => {
  const connection = resolveChatConnection();
  const ref = { attachmentId: 'sha256:abcdef1234567890', mediaType: 'image/png', width: 2000, height: 1000 };
  const pricing = deepSeekImageRequestPricing(connection, 'deepseek-flash');
  const target = resolveRequestImageTarget(connection.models[0], ref);
  const [retained] = pricing.priceImages([{ type: 'image', attachment: ref }]);
  assert.equal(retained.visualTokens, deepSeekImageTokens(target.width, target.height));
  assert.equal(retained.visualTokens > 0, true);
  assert.equal(retained.visualTokens <= 1024, true);
  assert.equal(retained.text.includes('request preview'), true);
  const [offloaded] = pricing.priceImages([{ type: 'image', attachment: ref, offloaded: true }]);
  assert.deepEqual(offloaded, { visualTokens: 0, text: offloadedImageText(ref) });
  // A text-only or uncatalogued route substitutes deterministic text and prices no vision tokens.
  const substituted = deepSeekImageRequestPricing(connection, 'not-a-model').priceImages([{ type: 'image', attachment: ref }])[0];
  assert.deepEqual(substituted, { visualTokens: 0, text: textOnlyImageText(ref) });
  assert.equal(substituted.text.includes('sha256:abcdef'), true);
  assert.equal(deepSeekImageRequestPricing(connection, 'deepseek-reasoner').priceImages([{ type: 'image', attachment: ref }])[0].visualTokens, 0);
  // The access resolver feeds the same handle text the serializer sends.
  const withPath = deepSeekImageRequestPricing(connection, 'deepseek-flash', () => ({ readonlyPath: '/world/img.png' }));
  assert.equal(withPath.priceImages([{ type: 'image', attachment: ref }])[0].text.includes('/world/img.png'), true);
});

test('the adapter exposes real image pricing for image routes', () => {
  const parts = makeAdapter(() => sseResponse(['[DONE]']));
  const pricing = parts.adapter.imageRequestPricing(DEEPSEEK_CHAT_PROVIDER_ID, 'deepseek-flash');
  assert.equal(typeof pricing.priceImages, 'function');
  const ref = { attachmentId: 'sha256:qwertyuiop', mediaType: 'image/png', width: 640, height: 480 };
  assert.equal(pricing.priceImages([{ type: 'image', attachment: ref }])[0].visualTokens > 0, true);
  const textOnly = parts.adapter.imageRequestPricing(DEEPSEEK_CHAT_PROVIDER_ID, 'deepseek-reasoner');
  assert.equal(textOnly.priceImages([{ type: 'image', attachment: ref }])[0].visualTokens, 0);
});

test('a retained image without prepared bytes fails before anything is sent', () => {
  const image = { attachmentId: 'att-missing', mediaType: 'image/png', width: 10, height: 10 };
  const options = { provider: 'p', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }] };
  assert.throws(() => serializeRequestWithImages(options, { representation: { kind: 'base64' }, requestImages: new Map(), maxRequestImageBytes: 1024 }, {}),
    (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST' && error.message.includes('att-missing'));
});

test('an image request without the attachment bridge is refused', async () => {
  const parts = makeAdapter(() => sseResponse(['[DONE]']));
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', width: 4, height: 4 } }] }];
  await assert.rejects(collect(parts.adapter.stream({ ...baseOptions(), messages })),
    (error) => error instanceof LlmError && error.code === 'UNSUPPORTED_CONTENT');
});

test('image requests use the injected attachment bridge as inline base64', async () => {
  const requests = [];
  const connection = resolveChatConnection({ streamIdleTimeoutMs: 50 });
  const adapter = createDeepSeekChatAdapter({
    connection: () => connection,
    resolveApiKey: async () => 'k',
    resolveRequestImages: async () => new Map([['a1', { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]), bytes: 3, width: 2, height: 2 }]]),
    resolveImageAccess: () => ({ readonlyPath: '/world/img.png' }),
    fetch: async (url, init) => { requests.push({ body: JSON.parse(init.body) }); return sseResponse(['[DONE]']); },
  });
  await collect(adapter.stream({ provider: DEEPSEEK_CHAT_PROVIDER_ID, model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', width: 2, height: 2 } }] }] }));
  const content = requests[0].body.messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].text.includes('/world/img.png'), true);
  assert.equal(content[1].image_url.url.startsWith('data:image/png;base64,'), true);
});
