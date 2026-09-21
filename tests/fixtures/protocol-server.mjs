#!/usr/bin/env node
/**
 * tests/fixtures/protocol-server.mjs
 *
 * 本地双协议测试端点 / local dual-protocol LLM test endpoint.
 *
 * 一个真实的 HTTP 服务器，同时说两种线上协议，供本仓库的端到端测试和人手动验证使用：
 *
 *   chat-completions  POST /chat/completions        (also /v1/chat/completions, /beta/chat/completions)
 *     回复是 OpenAI 兼容 SSE：choices[].delta（content / reasoning_content / tool_calls），
 *     一个带 finish_reason 的收尾 chunk，最后是 data: [DONE]。
 *
 *   messages          POST /messages                (also /v1/messages, /anthropic/v1/messages)
 *     回复是 Anthropic 兼容 SSE：message_start -> content_block_start/delta/stop
 *     （text_delta / thinking_delta / input_json_delta / signature_delta）->
 *     message_delta（stop_reason + usage）-> message_stop。每一帧都带 event: <type>
 *     且与 data.type 一致（DSH 宿主 Messages 解析器会拒绝二者不一致的帧）。
 *
 * 服务器记录收到的每一个请求（path、headers、原始 body、解析后的 body、响应），
 * 所以测试可以断言“线上到底是什么”，而不只是断言本地对象。
 *
 * 人手动使用 / manual use（不需要测试框架）:
 *
 *   node tests/fixtures/protocol-server.mjs                 # 监听随机端口并打印两个 URL，收到请求就打印
 *   node tests/fixtures/protocol-server.mjs --port 8799     # 固定端口
 *   node tests/fixtures/protocol-server.mjs --demo          # 自检：各发一个请求，打印请求与 SSE 帧序列，然后退出
 *   node tests/fixtures/protocol-server.mjs --content 你好   # 自定义回复正文
 *
 * 启动后会打印可直接复制粘贴的 curl 命令，例如：
 *   curl -sN http://127.0.0.1:PORT/chat/completions -H "content-type: application/json" -d "{...}"
 *   curl -sN http://127.0.0.1:PORT/anthropic/v1/messages -H "anthropic-version: 2023-06-01" -H "x-api-key: fixture" -d "{...}"
 *
 * 编程使用 / programmatic use:
 *
 *   import { startProtocolServer } from './fixtures/protocol-server.mjs';
 *   const server = await startProtocolServer({ reply: { content: 'hi', reasoning: 'thinking' } });
 *   const response = await fetch(server.chatCompletionsUrl, { method: 'POST', body: '{"stream":true}' });
 *   console.log(await response.text());        // OpenAI SSE
 *   console.log(server.requests.at(-1).body);  // 服务器实际收到的 body
 *   await server.close();
 *
 * 每个测试可以临时改回复：
 *   server.script({ chat: { content: 'A' }, messages: { content: 'B', reasoning: 'r' } });
 *   server.script(record => record.protocol === 'messages' ? { content: 'per-request' } : {});
 *
 * 可选字段（reply spec，两种协议通用）:
 *   content, reasoning, signature, toolCalls: [{ id?, name, arguments }], usage: { inputTokens, outputTokens },
 *   contentChunks / reasoningChunks / argumentChunks（把文本切成几段流式发出）, model, id,
 *   stream（false 则返回普通 JSON）, status, contentType, headers, raw（原样返回这段文本）,
 *   chunkSize / chunkDelayMs（按字节切片写出，模拟 TCP 分片）, includeUsage（chat 收尾 chunk 带 usage）。
 *   finishReason（chat）与 stopReason（messages）可显式指定，否则按是否有 toolCalls 推导。
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ paths */

/** Paths that answer with the OpenAI Chat Completions wire format. */
export const CHAT_COMPLETIONS_PATHS = ['/chat/completions', '/beta/chat/completions', '/v1/chat/completions'];
/** Paths that answer with the Anthropic Messages wire format. */
export const MESSAGES_PATHS = ['/messages', '/v1/messages', '/anthropic/v1/messages'];

const CHAT_STOP_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const ANTHROPIC_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens']);

export const DEFAULT_CHAT_REPLY = {
  model: 'fixture-chat',
  id: 'chatcmpl-fixture',
  content: 'Hello from the dual-protocol fixture.',
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 12, outputTokens: 7 },
};

export const DEFAULT_MESSAGES_REPLY = {
  model: 'fixture-messages',
  id: 'msg_fixture',
  content: 'Hello from the dual-protocol fixture.',
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 12, outputTokens: 7 },
};

/* ------------------------------------------------------------- utilities */

function pathnameOf(rawUrl) {
  try {
    const path = new URL(String(rawUrl), 'http://fixture.local').pathname.replace(/\/+$/u, '');
    return path === '' ? '/' : path;
  } catch {
    return '/';
  }
}

/** Classify a request path exactly the way the plugin classifies an outbound one. */
export function protocolOfPath(pathname) {
  if (CHAT_COMPLETIONS_PATHS.includes(pathname)) return 'chat-completions';
  if (MESSAGES_PATHS.includes(pathname)) return 'messages';
  return 'unknown';
}

/** Split text into at most parts pieces, never dropping or reordering a character. */
export function splitText(text, parts = 1) {
  if (typeof text !== 'string' || text === '') return [];
  const wanted = Math.max(1, Math.floor(Number(parts) || 1));
  if (wanted === 1) return [text];
  const size = Math.ceil(text.length / wanted);
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

/** Normalize a reply's toolCalls into { id, name, arguments: string }. */
export function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => {
    const raw = call ?? {};
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'fixture_tool';
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'call_' + (index + 1);
    const args = typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments ?? {});
    return { id, name, arguments: args };
  });
}

function chatUsage(usage) {
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function anthropicUsage(usage) {
  return { input_tokens: Number(usage?.inputTokens ?? 0), output_tokens: Number(usage?.outputTokens ?? 0) };
}

/** Map a Chat Completions finish_reason to the Anthropic stop_reason. */
export function stopReasonFor(finishReason, hasToolCalls) {
  if (ANTHROPIC_STOP_REASONS.has(finishReason)) return finishReason;
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

/* --------------------------------------------------- chat completions SSE */

/** Build the OpenAI Chat Completions SSE chunk objects (excluding the [DONE] sentinel). */
export function chatCompletionEvents(reply = {}) {
  const model = reply.model || DEFAULT_CHAT_REPLY.model;
  const id = reply.id || DEFAULT_CHAT_REPLY.id;
  const created = Number.isFinite(reply.created) ? reply.created : Math.floor(Date.now() / 1000);
  const envelope = choices => ({ id, object: 'chat.completion.chunk', created, model, choices });
  const events = [envelope([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])];

  for (const piece of splitText(reply.reasoning, reply.reasoningChunks ?? 1)) {
    events.push(envelope([{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }]));
  }
  for (const piece of splitText(reply.content, reply.contentChunks ?? 1)) {
    events.push(envelope([{ index: 0, delta: { content: piece }, finish_reason: null }]));
  }
  normalizeToolCalls(reply.toolCalls).forEach((call, index) => {
    const pieces = splitText(call.arguments, reply.argumentChunks ?? 1);
    (pieces.length === 0 ? [''] : pieces).forEach((piece, pieceIndex) => {
      events.push(envelope([{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            ...(pieceIndex === 0 ? { id: call.id, type: 'function' } : {}),
            function: { name: pieceIndex === 0 ? call.name : undefined, arguments: piece },
          }],
        },
        finish_reason: null,
      }]));
    });
  });

  const toolCalls = normalizeToolCalls(reply.toolCalls);
  const finishReason = reply.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  events.push({
    ...envelope([{ index: 0, delta: {}, finish_reason: finishReason }]),
    ...(reply.includeUsage === true ? { usage: chatUsage(reply.usage) } : {}),
  });
  return events;
}

/** Encode chunk objects as an SSE body, terminated by the literal [DONE]. */
export function encodeChatSse(events) {
  return events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
}

/** A single non-streamed OpenAI chat completion object. */
export function chatCompletionBody(reply = {}) {
  const toolCalls = normalizeToolCalls(reply.toolCalls);
  return {
    id: reply.id || DEFAULT_CHAT_REPLY.id,
    object: 'chat.completion',
    created: Number.isFinite(reply.created) ? reply.created : Math.floor(Date.now() / 1000),
    model: reply.model || DEFAULT_CHAT_REPLY.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: typeof reply.content === 'string' ? reply.content : '',
        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
        ...(toolCalls.length === 0 ? {} : {
          tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        }),
      },
      finish_reason: reply.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: chatUsage(reply.usage),
  };
}

/* --------------------------------------------------------- messages SSE */

/** Build Anthropic Messages SSE frames: { event, data } with data.type === event. */
export function messagesEvents(reply = {}) {
  const model = reply.model || DEFAULT_MESSAGES_REPLY.model;
  const id = reply.id || DEFAULT_MESSAGES_REPLY.id;
  const usage = anthropicUsage(reply.usage);
  const toolCalls = normalizeToolCalls(reply.toolCalls);
  const events = [{
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
  }];

  let index = 0;
  if (typeof reply.reasoning === 'string' && reply.reasoning !== '') {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } } });
    for (const piece of splitText(reply.reasoning, reply.reasoningChunks ?? 1)) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } } });
    }
    if (typeof reply.signature === 'string' && reply.signature !== '') {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: reply.signature } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }

  const text = typeof reply.content === 'string' ? reply.content : '';
  if (text !== '' || reply.forceTextBlock === true) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    for (const piece of splitText(text, reply.contentChunks ?? 1)) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }

  for (const call of toolCalls) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } } });
    for (const piece of splitText(call.arguments, reply.argumentChunks ?? 1)) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }

  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReasonFor(reply.stopReason || reply.finishReason, toolCalls.length > 0), stop_sequence: null },
      usage,
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

/** Encode Anthropic frames as an SSE body. Messages has no [DONE] sentinel. */
export function encodeMessagesSse(events) {
  return events.map(({ event, data }) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n').join('');
}

/** A single non-streamed Anthropic message object. */
export function messagesBody(reply = {}) {
  const toolCalls = normalizeToolCalls(reply.toolCalls);
  const content = [];
  if (typeof reply.reasoning === 'string' && reply.reasoning !== '') {
    content.push({ type: 'thinking', thinking: reply.reasoning, ...(reply.signature ? { signature: reply.signature } : {}) });
  }
  if (typeof reply.content === 'string' && reply.content !== '') content.push({ type: 'text', text: reply.content });
  for (const call of toolCalls) {
    let input = {};
    try { input = JSON.parse(call.arguments); } catch { input = {}; }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  return {
    id: reply.id || DEFAULT_MESSAGES_REPLY.id,
    type: 'message',
    role: 'assistant',
    model: reply.model || DEFAULT_MESSAGES_REPLY.model,
    content,
    stop_reason: stopReasonFor(reply.stopReason || reply.finishReason, toolCalls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage(reply.usage),
  };
}

/* --------------------------------------------------------------- server */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lowercasedHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return out;
}

function isReplyPerProtocol(value) {
  return value !== null && typeof value === 'object' && ('chat' in value || 'messages' in value);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the dual-protocol endpoint on an ephemeral 127.0.0.1 port.
 *
 * @param {object} [options]
 * @param {string} [options.host] bind address, default 127.0.0.1
 * @param {number} [options.port] 0 (default) picks a free port
 * @param {object|Function} [options.reply] default reply spec, or { chat, messages }, or record => spec
 * @param {Function} [options.respond] ({ protocol, request, server }) => partial reply spec
 * @param {boolean} [options.log] print one line per request/response
 * @returns {Promise<object>} { url, port, requests, script, reset, last, byProtocol, close, ... }
 */
export async function startProtocolServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const requests = [];
  const state = { reply: options.reply ?? {} };
  let server = null;

  const serverRef = {};
  const resolveReply = (protocol, record) => {
    const source = typeof state.reply === 'function' ? state.reply(record, serverRef) : state.reply;
    const perProtocol = isReplyPerProtocol(source) ? source[protocol] : source;
    const respond = typeof options.respond === 'function'
      ? options.respond({ protocol, request: record, server: serverRef })
      : undefined;
    const base = protocol === 'messages' ? DEFAULT_MESSAGES_REPLY : DEFAULT_CHAT_REPLY;
    return { ...base, ...(perProtocol ?? {}), ...(respond ?? {}) };
  };

  const handle = async (req, res) => {
    const rawPath = String(req.url ?? '/');
    const pathname = pathnameOf(rawPath);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const payload = {
        ok: true,
        description: 'dsh-preset-enhance dual-protocol LLM test endpoint',
        chatCompletions: CHAT_COMPLETIONS_PATHS.map(path => serverRef.url + path),
        messages: MESSAGES_PATHS.map(path => serverRef.url + path),
        recordedRequests: requests.length,
      };
      const body = JSON.stringify(payload, null, 2) + '\n';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const protocol = protocolOfPath(pathname);
    if (protocol === 'unknown') {
      const body = JSON.stringify({ error: 'unknown path', path: pathname, chatCompletions: CHAT_COMPLETIONS_PATHS, messages: MESSAGES_PATHS }) + '\n';
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
      res.end(JSON.stringify({ error: 'method not allowed' }) + '\n');
      return;
    }

    const rawBody = await readBody(req).catch(() => '');
    let body = null;
    try { body = rawBody === '' ? null : JSON.parse(rawBody); } catch { body = null; }
    const record = {
      index: requests.length,
      method: String(req.method),
      path: pathname,
      rawPath,
      url: serverRef.url + rawPath,
      headers: lowercasedHeaders(req.headers),
      rawBody,
      body,
      protocol,
      receivedAt: Date.now(),
      stream: undefined,
      response: null,
    };
    requests.push(record);

    const reply = resolveReply(protocol, record);
    const status = Number.isFinite(reply.status) ? reply.status : 200;
    const wantsStream = reply.stream !== undefined
      ? reply.stream === true
      : body?.stream !== false;
    record.stream = wantsStream;

    let payload;
    let contentType;
    if (typeof reply.raw === 'string') {
      payload = reply.raw;
      contentType = reply.contentType || 'text/event-stream; charset=utf-8';
    } else if (status >= 400) {
      payload = JSON.stringify({ error: reply.error || 'fixture error', status }) + '\n';
      contentType = reply.contentType || 'application/json; charset=utf-8';
    } else if (wantsStream) {
      payload = protocol === 'messages' ? encodeMessagesSse(messagesEvents(reply)) : encodeChatSse(chatCompletionEvents(reply));
      contentType = reply.contentType || 'text/event-stream; charset=utf-8';
    } else {
      payload = JSON.stringify(protocol === 'messages' ? messagesBody(reply) : chatCompletionBody(reply)) + '\n';
      contentType = reply.contentType || 'application/json; charset=utf-8';
    }

    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-fixture-protocol': protocol,
      ...(reply.headers ?? {}),
    });
    const bytes = Buffer.from(payload, 'utf8');
    const sliceSize = Number(reply.chunkSize) > 0 ? Math.floor(Number(reply.chunkSize)) : 0;
    if (sliceSize === 0) {
      res.end(bytes);
    } else {
      for (let offset = 0; offset < bytes.length; offset += sliceSize) {
        res.write(bytes.subarray(offset, offset + sliceSize));
        if (Number(reply.chunkDelayMs) > 0) await sleep(Number(reply.chunkDelayMs));
      }
      res.end();
    }

    record.response = { status, contentType, body: payload, bytes: bytes.length };
    if (typeof options.onRequest === 'function') options.onRequest(record);
    if (options.log === true) {
      console.log('[fixture] ' + record.method + ' ' + record.path + ' -> ' + status + ' ' + contentType +
        ' (' + bytes.length + ' B, ' + (wantsStream ? 'stream' : 'json') + ')');
    }
  };

  server = createServer((req, res) => {
    handle(req, res).catch(error => {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(error && error.message || error) }) + '\n');
      } catch { /* response already sent */ }
    });
  });

  const wantedPort = Number.isFinite(options.port) ? Number(options.port) : 0;
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(wantedPort, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : wantedPort;

  Object.assign(serverRef, {
    server,
    host,
    port,
    url: 'http://' + host + ':' + port,
    chatCompletionsUrl: 'http://' + host + ':' + port + '/chat/completions',
    betaChatCompletionsUrl: 'http://' + host + ':' + port + '/beta/chat/completions',
    v1ChatCompletionsUrl: 'http://' + host + ':' + port + '/v1/chat/completions',
    messagesUrl: 'http://' + host + ':' + port + '/messages',
    v1MessagesUrl: 'http://' + host + ':' + port + '/v1/messages',
    anthropicMessagesUrl: 'http://' + host + ':' + port + '/anthropic/v1/messages',
    requests,
    /** Replace the reply script (a spec, a { chat, messages } spec, or record => spec). */
    script(next) { state.reply = next ?? {}; },
    /** Forget every recorded request. */
    reset() { requests.length = 0; },
    /** Last recorded request, or the last one matching a path/string/object/function. */
    last(match) {
      if (match === undefined) return requests.at(-1);
      const predicate = typeof match === 'function' ? match
        : typeof match === 'string' ? (record => record.path === match || record.url === match)
          : (record => Object.entries(match).every(([key, value]) => record[key] === value));
      return [...requests].reverse().find(predicate);
    },
    /** Every request that arrived on one protocol's paths. */
    byProtocol(protocol) { return requests.filter(record => record.protocol === protocol); },
    /** Close the listener and drop keep-alive sockets so a test process can exit. */
    async close() {
      await new Promise(resolve => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  });
  return serverRef;
}

/* ------------------------------------------------------------------- CLI */

function banner(server, reply) {
  const lines = [
    '',
    '双协议测试端点已启动 / dual-protocol test endpoint listening',
    '  chat-completions : ' + server.chatCompletionsUrl,
    '                     ' + server.betaChatCompletionsUrl + '   (assistant-prefix target)',
    '                     ' + server.v1ChatCompletionsUrl,
    '  messages         : ' + server.anthropicMessagesUrl,
    '                     ' + server.v1MessagesUrl,
    '                     ' + server.messagesUrl,
    '  信息 / info      : ' + server.url + '/        (GET 列出全部路径)',
    '',
    '默认回复 / default reply: ' + JSON.stringify({
      content: reply.content ?? DEFAULT_CHAT_REPLY.content,
      reasoning: reply.reasoning ?? '',
      toolCalls: reply.toolCalls ?? [],
    }),
    '',
    'curl 示例 / examples:',
    '  curl -sN ' + server.chatCompletionsUrl + " -H \"content-type: application/json\" -H \"x-deepseek-harness-session-id: demo\" \\",
    '    -d \'{"model":"fixture","stream":true,"messages":[{"role":"user","content":"hi"}]}\'',
    '  curl -sN ' + server.anthropicMessagesUrl + " -H \"content-type: application/json\" -H \"anthropic-version: 2023-06-01\" \\",
    '    -H "x-api-key: fixture" -H "x-deepseek-harness-session-id: demo" \\',
    '    -d \'{"model":"fixture","max_tokens":64,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}\'',
    '',
    '收到的请求会打印在这里；Ctrl+C 退出 / requests are logged below; Ctrl+C to exit',
    '',
  ];
  console.log(lines.join('\n'));
}

const DEMO_REPLY = {
  reasoning: '先想一下 / let me think.',
  content: '你好，这是双协议测试端点的回复。',
  signature: 'fixture-signature',
  toolCalls: [{ id: 'call_demo', name: 'lookup_weather', arguments: { city: 'Shanghai' } }],
  usage: { inputTokens: 9, outputTokens: 6 },
  contentChunks: 2,
  reasoningChunks: 2,
  argumentChunks: 2,
};

async function runDemo(server) {
  const requests = [
    ['chat-completions', server.chatCompletionsUrl, {
      model: 'fixture-chat', stream: true,
      messages: [{ role: 'system', content: 'demo system' }, { role: 'user', content: 'hi' }],
    }, { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 'fixture-demo' }],
    ['messages', server.anthropicMessagesUrl, {
      model: 'fixture-messages', max_tokens: 64, stream: true, system: 'demo system',
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, {
      'content-type': 'application/json', accept: 'text/event-stream',
      'anthropic-version': '2023-06-01', 'x-api-key': 'fixture-key',
      'x-deepseek-harness-session-id': 'fixture-demo',
    }],
  ];
  for (const [label, url, body, headers] of requests) {
    console.log('=== demo ' + label + ' -> ' + url + ' ===');
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    console.log('HTTP ' + response.status + ' ' + response.headers.get('content-type'));
    console.log(text.trimEnd());
    console.log('');
  }
  console.log('=== 服务器记录 / recorded requests ===');
  for (const record of server.requests) {
    console.log('#' + record.index + ' ' + record.method + ' ' + record.path + ' (' + record.protocol + ')');
    console.log('  headers: ' + JSON.stringify(record.headers));
    console.log('  body: ' + record.rawBody);
  }
  console.log('');
  console.log('=== 帧序列 / frame sequences ===');
  console.log('chat-completions: ' + JSON.stringify(chatCompletionEvents(DEMO_REPLY).map(event => event.choices[0].delta), null, 2));
  console.log('messages: ' + JSON.stringify(messagesEvents(DEMO_REPLY).map(frame => frame.event)));
}

async function main() {
  const argv = process.argv.slice(2);
  const valueOf = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
  };
  const demo = argv.includes('--demo');
  const content = valueOf('--content', undefined);
  const port = Number(valueOf('--port', '0'));
  const host = valueOf('--host', '127.0.0.1');
  // Each protocol falls back to its own default reply; only the CLI-supplied fields
  // override, so a chat default never leaks into a Messages response.
  const reply = demo ? DEMO_REPLY : content === undefined ? {} : { content };

  const server = await startProtocolServer({
    host, port, reply,
    log: !demo,
    onRequest: record => {
      if (demo) return;
      console.log('[fixture] 收到 ' + record.method + ' ' + record.path + ' (' + record.protocol + ') body=' +
        (record.rawBody.length > 300 ? record.rawBody.slice(0, 300) + '...' : record.rawBody));
    },
  });
  banner(server, reply);

  if (demo) {
    try {
      await runDemo(server);
    } finally {
      await server.close();
    }
    return;
  }

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (invokedDirectly) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
