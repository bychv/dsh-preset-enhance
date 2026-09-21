import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  ChatToMessagesStream,
  chatCompletionToMessage,
  createChatToMessagesStream,
  mapChatFinishReason,
  mapToolChoice,
  messagesRequestHeadersToChat,
  messagesRequestToChat,
  translateChatResponse,
} from '../lib/messages-translate.mjs';
import { installDeepSeekBetaBridge, rewriteDeepSeekPrefixFetch } from '../lib/deepseek-beta.mjs';
import { MESSAGES_BASE_URL, MESSAGES_PROTOCOL_REASON, SESSION_ID_HEADER, createProtocolObserver } from '../lib/protocol.mjs';

const FETCH_BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');
const harness = { effect: fn => fn() };

/** Earlier tests may leave the shared fetch wrapper installed; restore the real fetch. */
function resetFetchBridge() {
  const host = globalThis[FETCH_BRIDGE];
  if (!host) return;
  globalThis.fetch = host.original;
  delete globalThis[FETCH_BRIDGE];
}

function sse(chunk) {
  return 'data: ' + JSON.stringify(chunk) + '\n\n';
}

function parseFrames(text) {
  return text.split(/\r?\n\r?\n/u).filter(part => part.trim() !== '').map(part => {
    const lines = part.split(/\r?\n/u);
    const eventLine = lines.find(line => line.startsWith('event:'));
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    return { event: eventLine === undefined ? undefined : eventLine.slice(6).trim(), data, json: JSON.parse(data) };
  });
}

function anthropicRequest(overrides = {}) {
  return {
    model: 'deepseek-chat',
    max_tokens: 1024,
    stream: true,
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'what now?' }] },
    ],
    ...overrides,
  };
}

function messagesInit(overrides = {}) {
  return {
    method: 'POST',
    headers: {
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
      [SESSION_ID_HEADER]: 's',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(anthropicRequest()),
    ...overrides,
  };
}

function chatSseBody(chunks) {
  return chunks.map(sse).join('') + 'data: [DONE]\n\n';
}

const CHAT_TEXT_STREAM = [
  { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
  { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
  { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
];

/* ------------------------------------------------------------- request side */

test('a Messages request becomes a chat/completions request without lossy notes', () => {
  const { body, notes } = messagesRequestToChat(anthropicRequest({
    stop_sequences: ['STOP'],
    temperature: 0.5,
    top_p: 0.9,
    thinking: { type: 'enabled' },
    output_config: { effort: 'high' },
    tools: [{ name: 'noop', description: 'does nothing', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'noop', disable_parallel_tool_use: true },
  }));

  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(body.stop, ['STOP']);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
  }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'noop' }, parallel_tool_calls: false });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'what now?' },
  ]);
  assert.deepEqual(notes, []);
});

test('stream:false is preserved and no usage request is added', () => {
  const { body } = messagesRequestToChat(anthropicRequest({ stream: false }));
  assert.equal(body.stream, false);
  assert.equal(body.stream_options, undefined);
});

test('tool_use and tool_result blocks become chat tool calls and tool messages', () => {
  const { body, notes } = messagesRequestToChat(anthropicRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read.', signature: 'sig-1' },
          { type: 'text', text: 'Reading...' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }], is_error: false },
          { type: 'text', text: 'and now?' },
        ],
      },
    ],
  }));

  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: 'Reading...',
    reasoning_content: 'I should read.',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'file body' });
  assert.deepEqual(body.messages[4], { role: 'user', content: 'and now?' });
  const fields = notes.map(note => note.field);
  assert.ok(fields.includes('thinking.signature'), 'thinking signature must be recorded, not dropped silently');
  assert.ok(fields.includes('tool_result.is_error'));
});

test('unrepresentable Anthropic fields are recorded as notes', () => {
  const { body, notes } = messagesRequestToChat(anthropicRequest({
    top_k: 5,
    metadata: { user_id: 'u' },
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
      { role: 'user', content: [{ type: 'search_result', content: 'x', source: 's', title: 't' }] },
    ],
  }));
  const fields = notes.map(note => note.field);
  assert.ok(fields.includes('top_k'));
  assert.ok(fields.includes('metadata'));
  assert.ok(fields.includes('cache_control'));
  assert.ok(fields.includes('user block search_result'));
  assert.equal(body.top_k, undefined);
  assert.equal(body.metadata, undefined);
  assert.equal(body.messages[0].content, 'sys');
  assert.deepEqual(body.messages[1].content, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
});

test('base64 and file image sources map to the host chat representations', () => {
  const { body } = messagesRequestToChat(anthropicRequest({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'file', file_id: 'file-1' } },
    ] }],
  }));
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'file', file_id: 'file-1' },
  ]);
});

test('tool_choice and finish_reason mappings are explicit', () => {
  const notes = [];
  const note = (field, detail) => notes.push(field + ':' + detail);
  assert.deepEqual(mapToolChoice({ type: 'auto' }, note), { type: 'auto' });
  assert.deepEqual(mapToolChoice({ type: 'any' }, note), { type: 'required' });
  assert.deepEqual(mapToolChoice({ type: 'none' }, note), { type: 'none' });
  assert.equal(mapToolChoice({ type: 'bogus' }, note), undefined);
  assert.equal(notes.length, 1);
  assert.equal(mapChatFinishReason('stop'), 'end_turn');
  assert.equal(mapChatFinishReason('length'), 'max_tokens');
  assert.equal(mapChatFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapChatFinishReason('content_filter'), 'end_turn');
  assert.equal(mapChatFinishReason(undefined), 'end_turn');
});

test('Messages headers become chat/completions headers', () => {
  const expected = {
    'x-deepseek-harness-session-id': 's',
    authorization: 'Bearer secret',
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  assert.deepEqual(messagesRequestHeadersToChat(messagesInit().headers), expected);
  assert.deepEqual(messagesRequestHeadersToChat(new Headers(messagesInit().headers)), expected);
  assert.deepEqual(messagesRequestHeadersToChat(Object.entries(messagesInit().headers)), expected);
  assert.deepEqual(messagesRequestHeadersToChat(undefined), { 'content-type': 'application/json' });
  // An existing authorization header wins over the x-api-key mapping.
  assert.equal(
    messagesRequestHeadersToChat({ 'x-api-key': 'k', authorization: 'Bearer custom' }).authorization,
    'Bearer custom',
  );
});

/* ------------------------------------------------------------ response side */

test('chat SSE becomes an Anthropic stream with exactly one terminal pair', () => {
  const stream = new ChatToMessagesStream({ model: 'deepseek-chat', now: () => 7 });
  let out = '';
  for (const chunk of CHAT_TEXT_STREAM) out += stream.push(sse(chunk));
  out += stream.push('data: [DONE]\n\n');
  out += stream.push('data: [DONE]\n\n');

  const frames = parseFrames(out);
  assert.deepEqual(frames.map(frame => frame.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const start = frames[0].json;
  assert.equal(start.message.role, 'assistant');
  assert.equal(start.message.model, 'deepseek-chat');
  assert.equal(start.message.type, 'message');
  assert.equal(start.message.content.length, 0);
  assert.equal(frames[1].json.index, 0);
  assert.deepEqual(frames[1].json.content_block, { type: 'text', text: '' });
  assert.deepEqual(frames[2].json.delta, { type: 'text_delta', text: 'Hello' });
  assert.deepEqual(frames[3].json.delta, { type: 'text_delta', text: ' world' });
  assert.equal(frames[4].json.index, 0);
  assert.equal(frames[5].json.delta.stop_reason, 'end_turn');
  assert.equal(frames[5].json.delta.stop_sequence, null);
  assert.deepEqual(frames[5].json.usage, { input_tokens: 11, output_tokens: 2 });
  assert.equal(frames[6].json.type, 'message_stop');
  assert.equal(out.includes('[DONE]'), false);
  assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);
  assert.equal(frames.filter(frame => frame.event === 'message_delta').length, 1);
});

test('a delta split across two pushes is reassembled', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  const frame = sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'split delta' }, finish_reason: null }] });
  const half = Math.floor(frame.length / 2);
  assert.equal(stream.push(frame.slice(0, half)), '');
  const frames = parseFrames(stream.push(frame.slice(half)));
  assert.deepEqual(frames.map(frame => frame.event), ['message_start', 'content_block_start', 'content_block_delta']);
  assert.equal(frames[2].json.delta.text, 'split delta');
});

test('thinking and tool-call deltas become thinking and tool_use blocks', () => {
  const stream = new ChatToMessagesStream({ model: 'deepseek-chat' });
  let out = '';
  out += stream.push(sse({ choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }] }));
  // An empty reasoning delta must not open a block.
  assert.equal(out.includes('content_block_start'), false);
  out += stream.push(sse({ choices: [{ index: 0, delta: { reasoning_content: 'think ' }, finish_reason: null }] }));
  out += stream.push(sse({ choices: [{ index: 0, delta: { reasoning_content: 'more' }, finish_reason: null }] }));
  out += stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] }, finish_reason: null }] }));
  out += stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] }));
  out += stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 9 } }));
  out += stream.push('data: [DONE]\n\n');

  const frames = parseFrames(out);
  const starts = frames.filter(frame => frame.event === 'content_block_start');
  assert.deepEqual(starts.map(frame => frame.json.content_block.type), ['thinking', 'tool_use']);
  assert.deepEqual(starts.map(frame => frame.json.index), [0, 1]);
  assert.equal(starts[1].json.content_block.id, 'call_1');
  assert.equal(starts[1].json.content_block.name, 'read');
  const thinkingDeltas = frames.filter(frame => frame.event === 'content_block_delta' && frame.json.delta.type === 'thinking_delta');
  assert.deepEqual(thinkingDeltas.map(frame => frame.json.delta.thinking), ['think ', 'more']);
  const jsonDeltas = frames.filter(frame => frame.event === 'content_block_delta' && frame.json.delta.type === 'input_json_delta');
  assert.equal(jsonDeltas.map(frame => frame.json.delta.partial_json).join(''), '{"path":"a.txt"}');
  const stops = frames.filter(frame => frame.event === 'content_block_stop');
  assert.deepEqual(stops.map(frame => frame.json.index), [0, 1]);
  assert.equal(frames.at(-2).json.delta.stop_reason, 'tool_use');
  assert.equal(frames.at(-1).event, 'message_stop');
});

test('a tool call whose identity arrives late still starts one block', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  let out = stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: null }] }));
  assert.equal(out.includes('content_block_start'), false, 'no block before identity is known');
  out += stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'do', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }));
  out += stream.push('data: [DONE]\n\n');
  const frames = parseFrames(out);
  const starts = frames.filter(frame => frame.event === 'content_block_start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].json.content_block, { type: 'tool_use', id: 'call_9', name: 'do', input: {} });
  const jsonDeltas = frames.filter(frame => frame.event === 'content_block_delta');
  assert.equal(jsonDeltas.map(frame => frame.json.delta.partial_json).join(''), '{"a":1}');
});

test('a settled tool_use block always carries valid JSON', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  let out = stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'noop', arguments: '' } }] }, finish_reason: 'tool_calls' }] }));
  out += stream.push('data: [DONE]\n\n');
  const frames = parseFrames(out);
  const json = frames.filter(frame => frame.event === 'content_block_delta').map(frame => frame.json.delta.partial_json).join('');
  assert.equal(json, '{}');
});

test('upstream close without a finish reason emits no terminal', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  const pushed = stream.push(sse({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }));
  const tail = stream.finish();
  const frames = parseFrames(pushed + tail);
  assert.deepEqual(frames.map(frame => frame.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop']);
  assert.equal((pushed + tail).includes('message_stop'), false);
});

test('an in-band chat error frame becomes an Anthropic error event', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  const out = stream.push(sse({ error: { message: 'quota exceeded', type: 'rate_limit_error', code: '429' } }));
  const frames = parseFrames(out);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'error');
  assert.equal(frames[0].json.type, 'error');
  assert.deepEqual(frames[0].json.error, { message: 'quota exceeded', type: 'rate_limit_error', code: '429' });
  assert.equal(out.includes('message_stop'), false);
  assert.equal(stream.finish(), '');
});

test('a finish reason without [DONE] still settles the stream', () => {
  const stream = new ChatToMessagesStream({ model: 'm' });
  const out = stream.push(sse({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'length' }] })) + stream.finish();
  const frames = parseFrames(out);
  assert.deepEqual(frames.map(frame => frame.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(frames.at(-2).json.delta.stop_reason, 'max_tokens');
});

test('the byte transform reassembles frames split inside a multi-byte character', async () => {
  const payload = sse({ id: 'c1', choices: [{ index: 0, delta: { content: '中文' }, finish_reason: null }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);
  const charIndex = payload.indexOf('中');
  const split = encoder.encode(payload.slice(0, charIndex)).length + 1;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  const text = await new Response(source.pipeThrough(createChatToMessagesStream({ model: 'm' }))).text();
  const frames = parseFrames(text);
  assert.equal(frames.filter(frame => frame.event === 'content_block_delta')[0].json.delta.text, '中文');
  assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);
});

test('non-stream chat completions convert to one Anthropic message object', () => {
  const message = chatCompletionToMessage({
    id: 'chatcmpl-9',
    model: 'deepseek-chat',
    choices: [{
      message: {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'because',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
  }, { now: () => 1 });
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.id, 'msg_chatcmpl-9');
  assert.equal(message.model, 'deepseek-chat');
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'because' },
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
  ]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.stop_sequence, null);
  assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 });
});

test('translateChatResponse passes non-2xx and non-completion bodies through', async () => {
  const error = new Response('{"error":{"message":"bad key","type":"authentication_error"}}', {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(await translateChatResponse(error), error);

  const other = new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal(await (await translateChatResponse(other)).text(), 'not json');
});

/* ----------------------------------------------------------------- bridge */

test('no activation leaves an official Messages request byte-identical', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer: createProtocolObserver(), reroute: true });
    const init = messagesInit();
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', init);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, MESSAGES_BASE_URL + '/v1/messages');
    assert.equal(calls[0].init, init);
    assert.equal(calls[0].init.body, init.body);
    assert.equal(calls[0].init.headers, init.headers);
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('an activation armed for messages mode never switches protocols', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const observer = createProtocolObserver();
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer, reroute: true });
    const release = controller.activate('s', '', { mode: 'messages', removeNonOfficialTools: true });
    const init = messagesInit();
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', init);
    assert.equal(calls[0].input, MESSAGES_BASE_URL + '/v1/messages');
    assert.equal(calls[0].init, init);
    const observed = observer.last('s');
    assert.equal(observed.protocol, 'messages');
    assert.equal(observed.switchedFrom, undefined);
    assert.equal(observed.skipped, true);
    assert.equal(observed.skippedReason, MESSAGES_PROTOCOL_REASON);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('an activation without a mode (legacy shape) never switches protocols', () => {
  const registry = new Map([['s', new Map([['', { count: 1 }]])]]);
  const rewritten = rewriteDeepSeekPrefixFetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit(), [registry]);
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.mode, 'none');
  assert.equal(rewritten.switchedFrom, undefined);
  assert.deepEqual(rewritten.skipped, { protocol: 'messages', reason: MESSAGES_PROTOCOL_REASON });
});

test('chat mode switches the official Messages request and translates the response', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(chatSseBody(CHAT_TEXT_STREAM), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const observer = createProtocolObserver();
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer, reroute: true });
    const release = controller.activate('s', '', { mode: 'chat-completions', removeNonOfficialTools: true });
    const response = await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit());
    const text = await response.text();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'https://api.deepseek.com/chat/completions');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.model, 'deepseek-chat');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.deepEqual(sent.messages[0], { role: 'system', content: 'You are helpful.' });
    assert.equal(calls[0].init.headers['x-api-key'], undefined);
    assert.equal(calls[0].init.headers['anthropic-version'], undefined);
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[0].init.headers[SESSION_ID_HEADER], 's');

    const frames = parseFrames(text);
    assert.deepEqual(frames.map(frame => frame.event).slice(0, 3), ['message_start', 'content_block_start', 'content_block_delta']);
    assert.equal(frames.at(-1).event, 'message_stop');
    assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);

    const observed = observer.last('s');
    assert.equal(observed.protocol, 'chat-completions');
    assert.equal(observed.capability.supported, true);
    assert.equal(observed.switchedFrom, 'messages');
    assert.equal(observed.skipped, false);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('an assistant prefill key switches a Messages request to the beta endpoint with prefix:true', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    const release = controller.activate('s', 'Continue: ', { mode: 'chat-completions', toolCalls: true });
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit({
      body: JSON.stringify(anthropicRequest({
        tools: [{ name: 'read', description: 'reads', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Continue: ' }] },
        ],
      })),
    }));
    assert.equal(calls[0].input, 'https://api.deepseek.com/beta/chat/completions');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.messages.at(-1).role, 'assistant');
    assert.equal(sent.messages.at(-1).content, 'Continue: ');
    assert.equal(sent.messages.at(-1).prefix, true);
    // The prefill path mirrors the official chat rewrite: native tools are
    // removed and the DSML tool prompt is emulated instead.
    assert.equal(sent.tools, undefined);
    assert.match(sent.messages[0].content, /## Tools/);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('the prefill reroute composes DSML emulation with the protocol translation', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const pipe = '\uFF5C';
  const d = pipe + pipe + 'DSML' + pipe + pipe;
  const call = ' calls>';
  const invoke = ' invoke name="read">';
  const param = ' parameter name="path" string="true">a.txt</' + d + ' parameter>';
  const dsml = '<' + d + call + '\n<' + d + invoke + '\n<' + d + param + '\n</' + d + ' invoke>\n</' + d + call;
  const body = chatSseBody([
    { id: 'c1', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'Continuing. ' + dsml }, finish_reason: null }] },
    { id: 'c1', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
  ]);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    const release = controller.activate('s', 'Continue: ', { mode: 'chat-completions', toolCalls: true });
    const response = await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit({
      body: JSON.stringify(anthropicRequest({
        tools: [{ name: 'read', description: 'reads', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Continue: ' }] },
        ],
      })),
    }));
    const frames = parseFrames(await response.text());
    const toolStart = frames.find(frame => frame.event === 'content_block_start' && frame.json.content_block.type === 'tool_use');
    assert.ok(toolStart, JSON.stringify(frames));
    assert.equal(toolStart.json.content_block.name, 'read');
    const json = frames
      .filter(frame => frame.event === 'content_block_delta' && frame.json.delta.type === 'input_json_delta')
      .map(frame => frame.json.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { path: 'a.txt' });
    assert.equal(frames.at(-2).json.delta.stop_reason, 'tool_use');
    assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('a reroute without a prefill keeps native tools translated', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    const release = controller.activate('s', '', { mode: 'chat-completions', toolCalls: true });
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit({
      body: JSON.stringify(anthropicRequest({
        tools: [{ name: 'read', description: 'reads', input_schema: { type: 'object', properties: {} } }],
      })),
    }));
    assert.equal(calls[0].input, 'https://api.deepseek.com/chat/completions');
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.tools, [{
      type: 'function',
      function: { name: 'read', description: 'reads', parameters: { type: 'object', properties: {} } },
    }]);
    assert.equal(sent.messages.some(message => typeof message.content === 'string' && message.content.includes('## Tools')), false);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('an empty activation key never arms a prefix continuation', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    // The host arms every injected request with '' when the preset has no prefill.
    const release = controller.activate('s', '', { mode: 'chat-completions' });
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit({
      body: JSON.stringify(anthropicRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'no prefill' }] },
        ],
      })),
    }));
    assert.equal(calls[0].input, 'https://api.deepseek.com/chat/completions');
    assert.equal(JSON.parse(calls[0].init.body).messages.at(-1).prefix, undefined);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('a non-official Messages endpoint is never switched', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const observer = createProtocolObserver();
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer, reroute: true });
    const release = controller.activate('s', '', { mode: 'chat-completions' });
    const init = messagesInit();
    await globalThis.fetch('https://gateway.example.com/v1/messages', init);
    assert.equal(calls[0].input, 'https://gateway.example.com/v1/messages');
    assert.equal(calls[0].init, init);
    const observed = observer.last('s');
    assert.equal(observed.protocol, 'messages');
    assert.equal(observed.switchedFrom, undefined);
    assert.equal(observed.skipped, true);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('a rewritten response is translated while an untouched one is not', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const body = chatSseBody(CHAT_TEXT_STREAM);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    // Not armed: the raw chat/completions bytes reach the caller untouched.
    const raw = await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit());
    assert.equal(await raw.text(), body);

    const release = controller.activate('s', '', { mode: 'chat-completions' });
    const translated = await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit());
    const text = await translated.text();
    assert.equal(text.includes('chat.completion'), false);
    const frames = parseFrames(text);
    assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);
    assert.equal(frames.at(-1).event, 'message_stop');
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('the full switch works over a real HTTP chat/completions endpoint', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of CHAT_TEXT_STREAM) res.write(sse(chunk));
      res.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  resetFetchBridge();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.deepseek.com') {
      return realFetch('http://127.0.0.1:' + port + url.pathname + url.search, init);
    }
    return realFetch(input, init);
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { reroute: true });
    const release = controller.activate('real', '', { mode: 'chat-completions' });
    const response = await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', messagesInit({
      headers: { 'x-api-key': 'secret', 'anthropic-version': '2023-06-01', [SESSION_ID_HEADER]: 'real', accept: 'text/event-stream' },
    }));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.url, '/chat/completions');
    assert.equal(received.headers.authorization, 'Bearer secret');
    assert.equal(received.headers['anthropic-version'], undefined);
    assert.equal(received.headers['content-type'], 'application/json');
    assert.equal(received.body.messages[0].role, 'system');
    assert.equal(received.body.stream, true);
    const frames = parseFrames(text);
    assert.equal(frames.at(-1).event, 'message_stop');
    assert.equal(frames.filter(frame => frame.event === 'message_stop').length, 1);
    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = realFetch;
    server.close();
    await once(server, 'close');
  }
});
