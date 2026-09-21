/**
 * tests/protocol-e2e.test.mjs
 *
 * 端到端协议行为测试 / end-to-end protocol behaviour tests.
 *
 * 运行前请先构建 / build first:  node scripts/build.mjs
 * 然后 / then:                  node --test tests/protocol-e2e.test.mjs
 *
 * 本文件有两个层次：
 *
 * A. 纯 fixture 层（不需要插件）：用真实的 127.0.0.1 端口分别验证 chat-completions 与
 *    messages 两种协议的 SSE 帧序列、content-type、请求记录、按字节分片写出。
 *    tests/fixtures/protocol-server.mjs 也可以被人直接运行（--port / --demo）。
 *
 * B. 插件 e2e 层：import 已构建的 ../index.mjs，用与 DSH 宿主同样的方式驱动它
 *    （ctx.on('llm/stream') 拦截 + ctx.llm.stream 重入），并“扮演”宿主的 DeepSeek 适配器：
 *    把插件交下来的 options 按宿主 protocols 下各 serialize.ts 的规则序列化成真实 HTTP 请求。
 *
 * 关键测试接缝 / key test seam：
 *   插件在 apply() 里把 globalThis.fetch 换成自己的桥接包装（installDeepSeekBetaBridge ->
 *   acquireHost 捕获当时的 globalThis.fetch 作为 host.original）。测试因此在 apply() 之前
 *   就把 globalThis.fetch 换成“官方域路由”：hostname === api.deepseek.com 的请求原样转发到
 *   fixture 服务器，其他请求走原生 fetch。这样 hostname 与 path 完全保持真实（桥接看到的
 *   仍然是 https://api.deepseek.com/...），不需要 src 里加任何测试专用开关。
 *
 * 用例矩阵 / case matrix:
 *   1. fixture 双协议演示（无插件）
 *   2. fixture 记录精确字节 + 脚本化响应 + 分片写入（含 UTF-8 跨片）
 *   3. fixture CLI 可独立运行（--demo）
 *   4. 未启用预设：请求 byte-identical 到达（不接管、不改投、不翻译）
 *   5. chat-completions 模式：/chat/completions 收到按顺序编译好的预设消息（断言完整 body）
 *   6. messages 模式：单条前置 system 消息、按顺序合并、不带 prefix 标志、protocolNotes 非空
 *   7. messages 模式单条 system：无可损失内容时 protocolNotes 为空
 *   8. chat 模式 + 宿主发 Messages 请求：改投 chat 路径 + 翻译后的 body + Anthropic 形状回包
 *      （依赖 src/lib/messages-translate.mts；未构建时显式 skip）
 *   9. chat 模式不报告 messages 笔记；save-protocol-mode 拒绝非法值
 *  10. chat 模式 + 非官方端点：永不改投，protocolMismatch 说明原因
 *  11. chat 模式改投后，前置 system 预设文本全部保留且顺序不变
 *      （宿主 Messages 序列化在桥接之前就 last-wins 丢掉前面的 system，因此插件在编译期合并）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CHAT_COMPLETIONS_PATHS,
  MESSAGES_PATHS,
  startProtocolServer,
} from './fixtures/protocol-server.mjs';
import { PresetStore } from '../lib/store.mjs';
import { apply } from '../index.mjs';

const execFileAsync = promisify(execFile);
const FETCH_BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');
const FIXTURE_CLI = fileURLToPath(new URL('./fixtures/protocol-server.mjs', import.meta.url));
const REROUTE_BUILT = existsSync(fileURLToPath(new URL('../lib/messages-translate.mjs', import.meta.url)));

/** The real fetch, captured before any test installs its own wrapper. */
const nativeFetch = globalThis.fetch.bind(globalThis);

const SESSION_ID = 'protocol-session';
const TEST_MODEL = 'deepseek-v4-flash';
const API_KEY = 'fixture-api-key';
/** Exactly where the host adapter would send an official Messages request. */
const OFFICIAL_MESSAGES_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
/** Exactly where the host adapter would send an official Chat Completions request. */
const OFFICIAL_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/* ------------------------------------------------------------------ seam */

let routedServer = null;

/**
 * Route an outbound absolute URL to the active fixture server while keeping the path the
 * bridge classified intact. The bridge reads the URL/hostname BEFORE this transport-level
 * redirection, so official api.deepseek.com classification and rewriting stay real, and a
 * non-official host (which must never be rerouted) keeps its own path too.
 * Installed before apply() so the plugin's bridge captures it as host.original.
 */
async function localRouter(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
  if (routedServer) {
    let url = null;
    try { url = new URL(String(raw)); } catch { url = null; }
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
      const target = new URL(url.pathname + url.search, routedServer.url);
      return nativeFetch(target, init);
    }
  }
  return nativeFetch(input, init);
}

/** Install the router directly on globalThis.fetch and drop a stale bridge host, if any. */
function installRouter(server) {
  routedServer = server;
  const host = globalThis[FETCH_BRIDGE];
  if (host && globalThis.fetch === host.wrapped) globalThis.fetch = nativeFetch;
  if (host) delete globalThis[FETCH_BRIDGE];
  globalThis.fetch = localRouter;
}

/* ------------------------------- host adapter mirrors (serialize.ts) */

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}
function flattenBlocks(content) {
  return blocksOf({ content }).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}

/**
 * Mirror of packages/llm/llm-deepseek/src/protocols/chat-completions/serialize.ts:
 * system stays a role:'system' message, user text flattens to a string, tool results
 * become standalone role:'tool' messages, assistant keeps text/reasoning/tool_calls.
 */
function serializeChatRequest(options) {
  const messages = [];
  for (const message of options.messages ?? []) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: flattenBlocks(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const reasoning = blocksOf(message).filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('');
      const toolCalls = blocksOf(message).filter(block => block.type === 'tool-call')
        .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
      messages.push({
        role: 'assistant',
        content: flattenBlocks(message.content),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const toolResults = blocksOf(message).filter(block => block.type === 'tool-result');
    const text = flattenBlocks(message.content);
    if (text.length > 0 || toolResults.length === 0) messages.push({ role: 'user', content: text });
    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenBlocks(result.content) || '(no output)',
      });
    }
  }
  const tools = (options.tools ?? []).map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: 'enabled' },
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Mirror of packages/llm/llm-deepseek/src/protocols/messages/serialize.ts for the default
 * model entry (no systemPromptUpdate === 'in-history'):
 *
 *   serialize.ts:83-95  every system message overwrites the single historySystem slot
 *                       (LAST-WINS: [system A, system B, user] keeps only B);
 *   serialize.ts:126    body.system = [options.system, historySystem].filter(Boolean).join('\n\n').
 *
 * For a LEADING system message both code paths agree (messages.length === 0 hits the else
 * branch), which is exactly the shape the plugin's Messages adaptation produces.
 */
function serializeMessagesRequest(options) {
  const messages = [];
  let historySystem;
  for (const message of options.messages ?? []) {
    if (message.role === 'system') {
      historySystem = flattenBlocks(message.content);
      continue;
    }
    if (message.role === 'assistant') {
      const content = blocksOf(message).map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
        if (block.type === 'reasoning') return { type: 'thinking', thinking: block.text ?? '' };
        if (block.type === 'tool-call') {
          let input = {};
          try { input = JSON.parse(block.arguments ?? '{}'); } catch { input = {}; }
          return { type: 'tool_use', id: block.id, name: block.name, input };
        }
        return { type: 'text', text: '' };
      });
      messages.push({ role: 'assistant', content });
      continue;
    }
    const content = [];
    for (const block of blocksOf(message)) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text ?? '' });
      else if (block.type === 'tool-result') {
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: blocksOf(block).filter(inner => inner.type === 'text').map(inner => ({ type: 'text', text: inner.text ?? '' })),
          ...(block.isError === undefined ? {} : { is_error: block.isError }),
        });
      }
    }
    messages.push({ role: 'user', content });
  }
  const system = [options.system, historySystem].filter(Boolean).join('\n\n');
  const tools = (options.tools ?? []).map(tool => ({
    name: tool.name, description: tool.description, input_schema: tool.parameters,
  }));
  return {
    model: options.model,
    stream: true,
    max_tokens: 8192,
    messages,
    thinking: { type: 'enabled' },
    ...(system.length === 0 ? {} : { system }),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/* ---------------------------------------------- SSE consumers (host mirror) */

/** Spec-strict SSE framing: an event dispatches only on its blank-line terminator. */
function parseSseFrames(text) {
  const frames = [];
  for (const block of String(text).split(/\r?\n\r?\n/u)) {
    const dataLines = [];
    const eventLines = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line === '' || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventLines.push(value);
    }
    if (dataLines.length === 0 && eventLines.length === 0) continue;
    frames.push({ event: eventLines[0], data: dataLines.join('\n') });
  }
  return frames;
}

/**
 * Consume an OpenAI chat-completions SSE body the way the host does
 * (chat-completions/sse.ts requires the literal [DONE], translate.ts assembles deltas).
 */
function consumeChatSse(text) {
  const frames = parseSseFrames(text);
  const events = [];
  let done = false;
  for (const frame of frames) {
    if (frame.data === '[DONE]') { done = true; break; }
    if (frame.data === '') continue;
    events.push(JSON.parse(frame.data));
  }
  assert.equal(done, true, 'chat-completions SSE must terminate with "data: [DONE]"');

  let role = null;
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = new Map();
  for (const event of events) {
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.role === 'string') role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const current = toolCalls.get(call.index) ?? { id: undefined, name: undefined, arguments: '' };
      if (typeof call.id === 'string') current.id = call.id;
      if (typeof call.function?.name === 'string') current.name = call.function.name;
      if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
      toolCalls.set(call.index, current);
    }
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
    if (event.usage !== undefined) usage = event.usage;
  }
  const calls = [...toolCalls.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value);
  for (const call of calls) JSON.parse(call.arguments);
  return { events, role, content, reasoning, finishReason, usage, toolCalls: calls };
}

/**
 * Consume an Anthropic messages SSE body the way the host does
 * (messages/sse.ts: event must equal data.type; messages/translate.ts: block lifecycle,
 * legal stop_reason, all blocks closed before message_stop).
 */
function consumeMessagesSse(text) {
  const frames = parseSseFrames(text);
  const events = [];
  for (const frame of frames) {
    const data = JSON.parse(frame.data);
    assert.equal(typeof data.type, 'string', 'every Messages frame needs a string type');
    if (frame.event !== undefined) {
      assert.equal(frame.event, data.type, 'event: must equal data.type (' + frame.event + ' vs ' + data.type + ')');
    }
    events.push(data);
  }
  assert.ok(events.length > 0, 'Messages SSE must not be empty');
  assert.equal(events[0].type, 'message_start', 'Messages SSE must start with message_start');

  const blocks = new Map();
  const open = new Set();
  let stopReason = null;
  let usage = null;
  let settled = false;
  let stopped = false;
  for (const event of events.slice(1)) {
    if (event.type === 'content_block_start') {
      assert.equal(stopped, false, 'no block may start after message_delta');
      assert.ok(Number.isSafeInteger(event.index) && event.index >= 0, 'block index must be a non-negative integer');
      assert.equal(blocks.has(event.index), false, 'block index must not repeat');
      const native = event.content_block ?? {};
      if (native.type === 'text') blocks.set(event.index, { index: event.index, type: 'text', text: native.text ?? '', deltas: 0 });
      else if (native.type === 'thinking') blocks.set(event.index, { index: event.index, type: 'thinking', text: native.thinking ?? '', deltas: 0 });
      else if (native.type === 'tool_use') blocks.set(event.index, { index: event.index, type: 'tool_use', id: native.id, name: native.name, json: '', deltas: 0 });
      else assert.fail('unsupported Messages block type ' + String(native.type));
      open.add(event.index);
      continue;
    }
    if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      assert.ok(block && open.has(event.index), 'delta needs an open block at index ' + String(event.index));
      const delta = event.delta ?? {};
      block.deltas += 1;
      if (delta.type === 'text_delta') { assert.equal(block.type, 'text'); block.text += delta.text; }
      else if (delta.type === 'thinking_delta') { assert.equal(block.type, 'thinking'); block.text += delta.thinking; }
      else if (delta.type === 'input_json_delta') { assert.equal(block.type, 'tool_use'); block.json += delta.partial_json; }
      else if (delta.type === 'signature_delta') { /* signature only */ }
      else assert.fail('unsupported Messages delta ' + String(delta.type));
      continue;
    }
    if (event.type === 'content_block_stop') {
      assert.ok(open.has(event.index), 'stop needs an open block at index ' + String(event.index));
      open.delete(event.index);
      continue;
    }
    if (event.type === 'message_delta') {
      const reason = event.delta?.stop_reason;
      if (reason != null) {
        assert.ok(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(reason),
          'illegal stop_reason ' + String(reason));
        stopReason = reason;
      }
      if (event.usage !== undefined) usage = event.usage;
      stopped = true;
      continue;
    }
    if (event.type === 'message_stop') {
      assert.equal(stopped, true, 'message_stop requires a preceding message_delta');
      assert.equal(open.size, 0, 'every block must be closed before message_stop');
      assert.equal(settled, false, 'message_stop must appear exactly once');
      settled = true;
      continue;
    }
    assert.fail('unexpected Messages event ' + String(event.type));
  }
  assert.equal(settled, true, 'Messages SSE must end with message_stop');
  assert.equal(events.at(-1).type, 'message_stop', 'message_stop must be the last frame');

  const ordered = [...blocks.values()].sort((left, right) => left.index - right.index);
  for (const block of ordered) {
    assert.ok(block.deltas > 0, 'every block must carry at least one delta');
    if (block.type === 'tool_use') JSON.parse(block.json === '' ? '{}' : block.json);
  }
  return {
    events,
    start: events[0].message,
    blocks: ordered,
    stopReason,
    usage,
    text: ordered.filter(block => block.type === 'text').map(block => block.text).join(''),
    thinking: ordered.filter(block => block.type === 'thinking').map(block => block.text).join(''),
  };
}

/* --------------------------------------------------------------- harness */

function makeRequest(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    provider: 'deepseek-official',
    model: TEST_MODEL,
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
    ...overrides,
  };
}

function adapterHeaders(protocol, options) {
  const common = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-deepseek-harness-user-id': 'fixture-user',
    'x-deepseek-harness-session-id': String(options.sessionId),
  };
  return protocol === 'messages'
    ? { ...common, 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    : { ...common, authorization: 'Bearer ' + API_KEY };
}

/**
 * Build the plugin harness plus a stand-in host adapter for one protocol. The adapter
 * serializes the options the plugin handed downstream, performs the real HTTP request
 * through globalThis.fetch (i.e. through the plugin's bridge), and mirrors the events
 * back so a test can assert what the host would have seen.
 */
function createHarness({ protocol, server, endpoint }) {
  const hostCalls = [];
  const listeners = {};
  const cleanups = [];
  let apiHandler = null;
  const session = {
    id: SESSION_ID,
    header: { agentPreset: 'standard' },
    snapshotEvents: () => [],
    deriveMessages: () => [],
  };

  const adapter = async function* adapter(options) {
    const requestBody = protocol === 'messages' ? serializeMessagesRequest(options) : serializeChatRequest(options);
    const url = endpoint ?? (protocol === 'messages' ? OFFICIAL_MESSAGES_ENDPOINT : OFFICIAL_CHAT_ENDPOINT);
    const sentBody = JSON.stringify(requestBody);
    const response = await globalThis.fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: adapterHeaders(protocol, options),
      body: sentBody,
    });
    const bodyText = await response.text();
    const call = {
      options,
      url,
      requestBody,
      sentBody,
      headers: adapterHeaders(protocol, options),
      status: response.status,
      contentType: response.headers.get('content-type'),
      bodyText,
    };
    if (protocol === 'messages') call.messages = consumeMessagesSse(bodyText);
    else call.chat = consumeChatSse(bodyText);
    hostCalls.push(call);
    yield { type: 'finish', reason: { kind: 'completed' } };
  };

  const ctx = {
    sessions: { get: id => (id === SESSION_ID ? session : undefined) },
    on: (event, handler) => { listeners[event] = handler; },
    effect: callback => {
      const disposer = callback();
      if (typeof disposer === 'function') cleanups.push(disposer);
    },
    webServer: {
      register: definition => {
        if (definition.path === '/preset-enhance/api') apiHandler = definition.handler;
        return () => {};
      },
    },
    llm: {
      stream(options) {
        const emit = listeners['llm/stream'];
        assert.equal(typeof emit, 'function', 'the plugin must register an llm/stream listener');
        return emit(options, () => adapter(options));
      },
    },
  };
  return {
    ctx,
    listeners,
    session,
    server,
    hostCalls,
    get apiHandler() { return () => apiHandler; },
    /** Drive one turn exactly like the host would. */
    async runTurn(request = makeRequest()) {
      for await (const _chunk of ctx.llm.stream(request)) { /* drain */ }
    },
    async dispose() {
      for (const disposer of [...cleanups].reverse()) await disposer?.();
      cleanups.length = 0;
    },
  };
}

/**
 * Start a fixture server + built plugin with one preset and one binding, run the body,
 * then dispose the plugin (releasing the fetch bridge) and remove the temp state dir.
 */
async function withPlugin(options, body) {
  const server = await startProtocolServer({ reply: options.reply ?? {}, port: 0 });
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-protocol-'));
  installRouter(server);
  let harness = null;
  try {
    const file = join(dir, 'state.json');
    const store = new PresetStore(file);
    await store.transaction(state => {
      state.presets.push({ id: 'p', name: 'Protocol preset', preset: options.preset });
      if (options.binding !== false) {
        state.bindings[SESSION_ID] = {
          enabled: options.enabled !== false,
          presetId: 'p',
          characterId: null,
          values: {},
          markers: {},
        };
      }
      if (options.protocolMode) state.protocolMode = options.protocolMode;
    });
    harness = createHarness({ protocol: options.protocol, server, endpoint: options.endpoint });
    await apply(harness.ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
    if (options.beforeTurn) await options.beforeTurn(harness, file);
    await options.turn(harness, server);
  } finally {
    if (harness) await harness.dispose();
    routedServer = null;
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
}

/** POST/GET helpers for the plugin web API, mirroring tests/core.test.mjs. */
async function pluginApi(harness, method, { body, sessionId } = {}) {
  const handler = harness.apiHandler();
  assert.equal(typeof handler, 'function', 'the plugin must register /preset-enhance/api');
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = '/preset-enhance/api' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '');
  req.headers = { 'content-type': 'application/json', host: 'localhost' };
  let statusCode;
  let payload;
  const res = {
    writeHead(code) { statusCode = code; },
    end(value) { payload = value === undefined ? undefined : JSON.parse(String(value)); },
  };
  await handler(req, res);
  return { statusCode, payload };
}

/* ----------------------------------------------------------------- presets */

/** Two leading system prompts: exactly the shape the host Messages serializer would lose. */
const TWO_SYSTEM_PRESET = {
  prompts: [
    { identifier: 'chatHistory', marker: true },
    { identifier: 'sysA', name: 'Alpha', role: 'system', content: 'ALPHA_RULE' },
    { identifier: 'sysB', name: 'Beta', role: 'system', content: 'BETA_RULE' },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'sysA', enabled: true },
    { identifier: 'sysB', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ] }],
};

/** One leading system prompt: nothing to merge, so no best-effort notes. */
const ONE_SYSTEM_PRESET = {
  prompts: [
    { identifier: 'chatHistory', marker: true },
    { identifier: 'sysA', name: 'Alpha', role: 'system', content: 'ALPHA_RULE' },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'sysA', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ] }],
};

const OK_REPLY = { content: 'REPLY_OK', reasoning: 'REASON_OK', usage: { inputTokens: 3, outputTokens: 4 } };

/* =============================================================== A. fixture */

test('fixture: one local port speaks both protocols, frame by frame', async () => {
  const server = await startProtocolServer({
    reply: {
      content: '你好，世界',
      reasoning: 'thinking out loud',
      signature: 'sig-1',
      toolCalls: [{ id: 'call_1', name: 'lookup_weather', arguments: { city: 'Shanghai' } }],
      usage: { inputTokens: 11, outputTokens: 5 },
      contentChunks: 3,
      reasoningChunks: 2,
      argumentChunks: 2,
    },
  });
  try {
    assert.equal(server.url.startsWith('http://127.0.0.1:'), true, 'an ephemeral 127.0.0.1 port is used');
    assert.equal(CHAT_COMPLETIONS_PATHS.includes('/chat/completions'), true);

    // --- chat-completions -------------------------------------------------
    const chatResponse = await nativeFetch(server.chatCompletionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 'plain-chat' },
      body: JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chatResponse.status, 200);
    assert.match(chatResponse.headers.get('content-type'), /^text\/event-stream/);
    const chatText = await chatResponse.text();
    assert.match(chatText, /^data: /);
    assert.match(chatText, /data: \[DONE\]\n\n$/);
    const chat = consumeChatSse(chatText);
    assert.equal(chat.role, 'assistant');
    assert.equal(chat.content, '你好，世界');
    assert.equal(chat.reasoning, 'thinking out loud');
    assert.equal(chat.finishReason, 'tool_calls');
    assert.deepEqual(chat.toolCalls, [{ id: 'call_1', name: 'lookup_weather', arguments: '{"city":"Shanghai"}' }]);
    // The delta chunk count proves the fixture really streamed, not one blob.
    assert.ok(chat.events.length >= 8, 'expected several chat chunks, got ' + chat.events.length);

    // --- messages ---------------------------------------------------------
    const messagesResponse = await nativeFetch(server.anthropicMessagesUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        'anthropic-version': '2023-06-01', 'x-api-key': 'fixture-key',
        'x-deepseek-harness-session-id': 'plain-messages',
      },
      body: JSON.stringify({ model: 'fixture', max_tokens: 64, stream: true, messages: [] }),
    });
    assert.equal(messagesResponse.status, 200);
    assert.match(messagesResponse.headers.get('content-type'), /^text\/event-stream/);
    const messagesText = await messagesResponse.text();
    assert.doesNotMatch(messagesText, /\[DONE\]/, 'Anthropic SSE has no [DONE] sentinel');
    const messages = consumeMessagesSse(messagesText);
    assert.deepEqual(messages.blocks.map(block => block.type), ['thinking', 'text', 'tool_use']);
    assert.equal(messages.thinking, 'thinking out loud');
    assert.equal(messages.text, '你好，世界');
    assert.equal(messages.stopReason, 'tool_use');
    assert.deepEqual(messages.usage, { input_tokens: 11, output_tokens: 5 });
    assert.equal(messages.blocks[2].name, 'lookup_weather');
    assert.equal(messages.blocks[2].json, '{"city":"Shanghai"}');

    // --- request recording ------------------------------------------------
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests.map(record => record.path), ['/chat/completions', '/anthropic/v1/messages']);
    assert.deepEqual(server.requests.map(record => record.headers['x-deepseek-harness-session-id']), ['plain-chat', 'plain-messages']);
    assert.equal(server.requests[1].body.stream, true);
    assert.equal(server.requests[0].body.messages[0].content, 'hi');
    assert.deepEqual(server.byProtocol('messages').map(record => record.path), ['/anthropic/v1/messages']);
    assert.equal(server.last().path, '/anthropic/v1/messages');
    assert.equal(server.last('/chat/completions').path, '/chat/completions');
  } finally {
    await server.close();
  }
});

test('fixture: records exact bytes, scripts per request, survives split TCP writes', async () => {
  const server = await startProtocolServer({ reply: { content: 'DEFAULT' } });
  try {
    // UTF-8 text written in 3-byte slices splits every multi-byte character.
    server.script({ content: '分块流式', contentChunks: 1, chunkSize: 3, usage: { inputTokens: 2, outputTokens: 2 } });
    const response = await nativeFetch(server.chatCompletionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'x' }] }),
    });
    const split = consumeChatSse(await response.text());
    assert.equal(split.content, '分块流式', 'byte-sliced SSE must reassemble the exact UTF-8 text');

    const record = server.last();
    assert.equal(record.method, 'POST');
    assert.equal(record.protocol, 'chat-completions');
    assert.equal(record.rawBody, JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'x' }] }));
    assert.deepEqual(record.body.messages, [{ role: 'user', content: 'x' }]);
    assert.equal(record.response.status, 200);
    assert.match(record.response.contentType, /^text\/event-stream/);

    // Per-request scripting through a function.
    server.reset();
    server.script(record => record.path === '/messages'
      ? { content: 'MESSAGES-SCRIPTED', reasoning: '' }
      : { content: 'CHAT-SCRIPTED' });
    const messagesResponse = await nativeFetch(server.messagesUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}',
    });
    assert.equal(consumeMessagesSse(await messagesResponse.text()).text, 'MESSAGES-SCRIPTED');
    const chatResponse = await nativeFetch(server.v1ChatCompletionsUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}',
    });
    assert.equal(consumeChatSse(await chatResponse.text()).content, 'CHAT-SCRIPTED');

    // Error status and non-stream JSON are scriptable too.
    server.reset();
    server.script({ status: 429, error: 'rate limited' });
    const failed = await nativeFetch(server.chatCompletionsUrl, { method: 'POST', body: '{}' });
    assert.equal(failed.status, 429);
    assert.deepEqual(await failed.json(), { error: 'rate limited', status: 429 });

    server.script({ content: 'NONSTREAM' });
    const single = await nativeFetch(server.messagesUrl, { method: 'POST', body: '{"stream":false}' });
    assert.match(single.headers.get('content-type'), /^application\/json/);
    const singleBody = await single.json();
    assert.equal(singleBody.type, 'message');
    assert.deepEqual(singleBody.content.find(block => block.type === 'text'), { type: 'text', text: 'NONSTREAM' });

    // Unknown paths are refused, GET / documents the endpoint.
    const missing = await nativeFetch(server.url + '/v1/files', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
    const index = await nativeFetch(server.url + '/');
    assert.equal(index.status, 200);
    assert.deepEqual((await index.json()).messages.length, MESSAGES_PATHS.length);
  } finally {
    await server.close();
  }
});

test('fixture: node tests/fixtures/protocol-server.mjs --demo runs standalone', async () => {
  const { stdout } = await execFileAsync(process.execPath, [FIXTURE_CLI, '--demo'], { timeout: 60_000 });
  assert.match(stdout, /dual-protocol test endpoint listening/);
  assert.match(stdout, /=== demo chat-completions/);
  assert.match(stdout, /=== demo messages/);
  assert.match(stdout, /data: \[DONE\]/);
  assert.match(stdout, /event: message_start/);
  assert.match(stdout, /event: message_stop/);
  assert.match(stdout, /=== 服务器记录 \/ recorded requests ===/);
});

/* ====================================================== B. plugin end-to-end */

test('no preset enabled: the plugin does not touch the outbound request at all', async () => {
  await withPlugin({
    protocol: 'messages',
    preset: TWO_SYSTEM_PRESET,
    enabled: false,
    reply: OK_REPLY,
    turn: async (harness, server) => {
      assert.notEqual(globalThis.fetch, nativeFetch, 'the plugin bridge must be installed for this test to mean anything');
      await harness.runTurn();
      const call = harness.hostCalls[0];
      assert.equal(harness.hostCalls.length, 1, 'exactly one outbound request');
      assert.equal(call.options.sessionId, SESSION_ID);
      const record = server.last();
      assert.equal(record.path, '/anthropic/v1/messages', 'no reroute to the chat path');
      assert.equal(record.rawBody, call.sentBody, 'body reaches the server byte-identical');
      assert.equal(record.headers['x-api-key'], API_KEY);
      assert.equal(record.headers['anthropic-version'], '2023-06-01');
      assert.equal(record.headers.authorization, undefined, 'no chat-completions Authorization rewrite');
      assert.equal(record.headers['x-deepseek-harness-session-id'], SESSION_ID);
      assert.equal(call.messages.text, 'REPLY_OK', 'the Messages SSE is passed through unchanged');
      assert.equal(call.messages.stopReason, 'end_turn');
      assert.equal(call.requestBody.system, undefined, 'no preset text and no injected system prompt');
      assert.equal(server.requests.length, 1);
    },
  });
});

test('no preset enabled: a chat-completions connection is untouched too', async () => {
  await withPlugin({
    protocol: 'chat-completions',
    preset: TWO_SYSTEM_PRESET,
    binding: false,
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];
      const record = server.last();
      assert.equal(record.path, '/chat/completions', 'no beta rewrite without an armed prefix');
      assert.equal(record.rawBody, call.sentBody);
      assert.equal(record.headers.authorization, 'Bearer ' + API_KEY);
      assert.deepEqual(call.requestBody.messages, [{ role: 'user', content: 'hello' }], 'history stays history');
      assert.equal(call.chat.content, 'REPLY_OK');
    },
  });
});

test('chat-completions mode: /chat/completions carries the compiled preset messages in order', async () => {
  await withPlugin({
    protocol: 'chat-completions',
    preset: TWO_SYSTEM_PRESET,
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];
      // Leading system messages are merged into one ordered message in BOTH modes: the host
      // Messages serializer keeps only the last leading system snapshot before the fetch
      // bridge runs, so a split pair would lose ALPHA_RULE whenever the official request is
      // rerouted from Messages to this chat path. Text and order are fully preserved.
      assert.deepEqual(
        call.options.messages.map(message => message.content.map(block => block.text).join('')),
        ['ALPHA_RULE\n\nBETA_RULE', 'hello'],
        'the injected history keeps the configured order',
      );
      assert.deepEqual(call.requestBody, {
        model: TEST_MODEL,
        messages: [
          { role: 'system', content: 'ALPHA_RULE\n\nBETA_RULE' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: 'enabled' },
      }, 'the exact body the local endpoint received');
      const record = server.last();
      assert.equal(record.path, '/chat/completions');
      assert.equal(record.rawBody, call.sentBody);
      assert.equal(record.body.messages.length, 2);
      assert.equal(call.chat.content, 'REPLY_OK');
      assert.equal(call.chat.reasoning, 'REASON_OK');
      assert.equal(call.chat.finishReason, 'stop');
    },
  });
});

test('messages mode: one leading system message, merged in order, no prefix flag, notes explain the loss', async () => {
  await withPlugin({
    protocol: 'messages',
    preset: TWO_SYSTEM_PRESET,
    reply: OK_REPLY,
    beforeTurn: async (harness, file) => {
      // The protocol switch goes through the documented API action, not a state poke.
      const state = await new PresetStore(file).read();
      const saved = await pluginApi(harness, 'POST', {
        body: { action: 'save-protocol-mode', mode: 'messages', revision: state.revision },
      });
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.payload));
      assert.deepEqual(saved.payload, { mode: 'messages' });
    },
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];

      // Injected options: exactly ONE leading system message holding both texts in order.
      const roles = call.options.messages.map(message => message.role);
      assert.equal(roles.filter(role => role === 'system').length, 1, 'exactly one system message');
      assert.equal(roles[0], 'system', 'it leads the request');
      assert.equal(
        call.options.messages[0].content.map(block => block.text).join(''),
        'ALPHA_RULE\n\nBETA_RULE',
        'both preset system prompts survive, in order, separated by a blank line',
      );

      // Wire body: no reroute, one top-level system string, no chat-only prefix flag.
      const record = server.last();
      assert.equal(record.path, '/anthropic/v1/messages', 'messages mode never reroutes');
      assert.equal(record.rawBody, call.sentBody);
      assert.equal(record.body.system, 'ALPHA_RULE\n\nBETA_RULE', 'the single surviving snapshot keeps everything');
      assert.equal(record.body.messages.some(message => message.role === 'system'), false);
      assert.doesNotMatch(record.rawBody, /"prefix"\s*:/, 'no assistant prefix flag on the Messages wire');
      assert.doesNotMatch(record.rawBody, /reasoning_content/, 'no chat-completions-only fields');
      assert.equal(call.messages.text, 'REPLY_OK', 'the Anthropic SSE is parsed without corruption');
      assert.equal(call.messages.usage.output_tokens, 4);

      // Workbench surface: the compilation notes are exposed for this session.
      const got = await pluginApi(harness, 'GET', { sessionId: SESSION_ID });
      assert.equal(got.statusCode, 200, JSON.stringify(got.payload));
      assert.equal(got.payload.protocolMode, 'messages');
      assert.ok(Array.isArray(got.payload.protocolNotes), 'protocolNotes must be an array');
      assert.ok(got.payload.protocolNotes.length > 0, 'merging two system prompts is a real limitation');
      assert.match(got.payload.protocolNotes.join('\n'), /system/);
      assert.equal(got.payload.protocolMismatch, null);
      assert.equal(got.payload.last.protocolNotes.length, got.payload.protocolNotes.length);
      assert.equal(got.payload.last.result.assistantPrefix.active, false, 'messages mode never claims a prefix');
    },
  });
});

test('messages mode: a single system prompt needs no notes (nothing is lost)', async () => {
  await withPlugin({
    protocol: 'messages',
    preset: ONE_SYSTEM_PRESET,
    protocolMode: 'messages',
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];
      assert.deepEqual(
        call.options.messages.map(message => message.role),
        ['system', 'user'],
      );
      assert.equal(server.last().body.system, 'ALPHA_RULE');
      const got = await pluginApi(harness, 'GET', { sessionId: SESSION_ID });
      assert.deepEqual(got.payload.protocolNotes, [], 'nothing cannot be preserved, so there is nothing to report');
      assert.equal(got.payload.protocolMode, 'messages');
    },
  });
});

test('chat-completions mode does not report messages notes', async () => {
  await withPlugin({
    protocol: 'chat-completions',
    preset: TWO_SYSTEM_PRESET,
    reply: OK_REPLY,
    turn: async (harness) => {
      await harness.runTurn();
      const got = await pluginApi(harness, 'GET', { sessionId: SESSION_ID });
      assert.equal(got.payload.protocolMode, 'chat-completions');
      assert.deepEqual(got.payload.protocolNotes, [], 'chat-completions has the full compatibility path');
    },
  });
});

test('save-protocol-mode rejects an unknown mode and keeps the default', async () => {
  await withPlugin({
    protocol: 'messages',
    preset: ONE_SYSTEM_PRESET,
    reply: OK_REPLY,
    beforeTurn: async (harness, file) => {
      const state = await new PresetStore(file).read();
      const rejected = await pluginApi(harness, 'POST', {
        body: { action: 'save-protocol-mode', mode: 'smoke-signals', revision: state.revision },
      });
      assert.equal(rejected.statusCode, 400, JSON.stringify(rejected.payload));
      assert.match(String(rejected.payload.error), /协议模式/);
      assert.equal((await new PresetStore(file).read()).protocolMode, 'chat-completions');
      const saved = await pluginApi(harness, 'POST', {
        body: { action: 'save-protocol-mode', mode: 'chat-completions', revision: state.revision },
      });
      assert.deepEqual(saved.payload, { mode: 'chat-completions' });
    },
    turn: async (harness, server) => {
      await harness.runTurn();
      // The mode stayed chat-completions because the invalid write was refused, so the
      // request still carries the full compatibility path; only that fact is asserted here.
      assert.equal(harness.hostCalls.length, 1);
      assert.equal(server.requests.length, 1);
      assert.equal(server.last().headers['x-deepseek-harness-session-id'], SESSION_ID);
    },
  });
});

test('chat mode + host Messages request: reroute to the chat path, Anthropic response back', {
  skip: REROUTE_BUILT ? false : 'awaiting src/lib/messages-translate.mts + the built lib/messages-translate.mjs',
}, async () => {
  await withPlugin({
    protocol: 'messages',
    preset: TWO_SYSTEM_PRESET,
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];
      const record = server.last();

      // The official Messages request was switched to the official chat endpoint.
      assert.ok(
        ['/chat/completions', '/beta/chat/completions'].includes(record.path),
        'expected a reroute to the chat path, got ' + record.path,
      );
      assert.equal(record.method, 'POST');
      assert.equal(record.headers['x-deepseek-harness-session-id'], SESSION_ID, 'harness headers survive the rewrite');
      assert.equal(record.headers.authorization, 'Bearer ' + API_KEY, 'x-api-key becomes Authorization: Bearer');
      assert.equal(record.headers['anthropic-version'], undefined, 'Anthropic-only headers are dropped');
      assert.equal(record.headers['x-api-key'], undefined);

      if (process.env.PROTOCOL_E2E_DEBUG) console.log('REROUTED BODY:', record.rawBody.slice(0, 900));
      // The translated body is chat-shaped, not Messages-shaped.
      assert.equal(record.body.system, undefined, 'Messages uses a top-level system; chat does not');
      assert.ok(Array.isArray(record.body.messages) && record.body.messages.length > 0);
      for (const message of record.body.messages) {
        assert.equal(typeof message.role, 'string');
        assert.equal(typeof message.content === 'string' || Array.isArray(message.content), true);
      }
      assert.doesNotMatch(record.rawBody, /tool_result|tool_use|input_schema/, 'no Anthropic block vocabulary on the chat wire');

      // The host still receives the Anthropic event stream it asked for.
      assert.match(call.contentType, /^text\/event-stream/);
      assert.equal(call.messages.text, 'REPLY_OK');
      assert.equal(call.messages.thinking, 'REASON_OK');
      assert.equal(call.messages.stopReason, 'end_turn');
      assert.doesNotMatch(call.bodyText, /\[DONE\]/, 'the host must not see the raw chat sentinel');
    },
  });
});

test('chat mode + non-official endpoint: never rerouted, mismatch is explained', async () => {
  await withPlugin({
    protocol: 'messages',
    preset: TWO_SYSTEM_PRESET,
    endpoint: 'https://third-party.example.com/anthropic/v1/messages',
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const call = harness.hostCalls[0];
      const record = server.last();
      // Safety property: only the OFFICIAL endpoint is switched; a third-party connection is left alone.
      assert.equal(record.path, '/anthropic/v1/messages', 'a non-official Messages endpoint must never be rerouted');
      assert.equal(record.rawBody, call.sentBody, 'the third-party request reaches the server byte-identical');
      assert.equal(record.headers['x-api-key'], API_KEY, 'no x-api-key -> Authorization rewrite');
      assert.equal(record.headers.authorization, undefined);
      assert.equal(call.messages.text, 'REPLY_OK');

      // The workbench must say that the selected mode could not be honoured.
      const got = await pluginApi(harness, 'GET', { sessionId: SESSION_ID });
      assert.equal(got.payload.protocolMode, 'chat-completions');
      assert.equal(got.payload.protocol?.protocol, 'messages', 'the observed protocol is reported per session');
      assert.equal(got.payload.protocol?.skipped, true, 'the compatibility path could not run');
      assert.equal(got.payload.protocolSwitched, false);
      assert.equal(typeof got.payload.protocolMismatch, 'string');
      assert.match(got.payload.protocolMismatch, /官方|api\.deepseek\.com/);
    },
  });
});

test('chat mode reroute preserves every leading preset system prompt', async () => {
  // The host Messages serializer collapses leading system messages (last-wins) BEFORE the
  // fetch bridge can reroute, so the plugin merges them into one ordered message while it
  // compiles the preset. Every leading prompt therefore survives the reroute, in order.

  await withPlugin({
    protocol: 'messages',
    preset: TWO_SYSTEM_PRESET,
    reply: OK_REPLY,
    turn: async (harness, server) => {
      await harness.runTurn();
      const wire = JSON.stringify(server.last().body);
      assert.match(wire, /ALPHA_RULE/, 'the first leading preset system prompt must not be dropped');
      assert.match(wire, /BETA_RULE/);
      assert.ok(wire.indexOf('ALPHA_RULE') < wire.indexOf('BETA_RULE'), 'and it must keep the original order');
    },
  });
});

