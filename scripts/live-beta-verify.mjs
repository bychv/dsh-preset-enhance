#!/usr/bin/env node
/**
 * Live probe for the DeepSeek beta prefix-completion bridge (shared task-11).
 *
 * What it proves against the real API:
 *   1. assistant prefill  -> the outbound URL really is /beta/chat/completions, the last
 *      message really carries prefix:true, and the streamed reply really continues it;
 *   2. DSML tool emulation -> native tools/tool_choice really leave the request and the
 *      model's DSML answer is converted back into standard tool_calls;
 *   3. output extraction  -> the raw provider stream (recorded below the bridge) really
 *      contains the control tags / DSML and the transformed stream really strips them while
 *      still yielding executable tool calls;
 *   4. cancellation/retry -> an aborted stream leaves no dangling activation, a retry on the
 *      same session is byte-identical (no double injection), and a released session is not
 *      rewritten any more.
 *
 * The plugin's real published code is exercised: this script installs the actual global
 * fetch bridge from ../lib/deepseek-beta.mjs on top of a recording wrapper that sits in
 * front of the real fetch and tees the raw SSE for comparison. Requests use the same URL,
 * headers and JSON body shape as the host chat-completions adapter
 * (packages/llm/llm-deepseek/src/protocols/chat-completions/{adapter,serialize}.ts).
 *
 * The API key is read at runtime from the sandbox .env and is never printed.
 *
 * Usage (sandbox node):
 *   <sandbox>\.runtime\node.exe scripts/live-beta-verify.mjs [--only=prefill,toolcall,extract,cancel] [--model=deepseek-flash]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { installDeepSeekBetaBridge } from '../lib/deepseek-beta.mjs';
import { createProtocolObserver } from '../lib/protocol.mjs';
import {
  ASCII_END_MARKER, CONTROL_TAGS, END_MARKER, LEGACY_END_MARKER, OUTPUT_EXTRACTION_PROMPT_TEMPLATE,
} from '../lib/output-extractor.mjs';

const ENV_PATH = process.env.SANDBOX_ENV ?? 'F:\\Git\\dsh-compact-sandbox\\.sandboxes\\alpha\\home\\.env';
const HOST = 'https://api.deepseek.com';
const MODEL = flag('--model', process.env.PROBE_MODEL ?? 'deepseek-flash');
const ONLY = flag('--only', 'prefill,toolcall,extract,cancel').split(',').map(item => item.trim());
const SESSION_PREFIX = 'live-beta-' + Date.now().toString(36);

function flag(name, fallback) {
  const hit = process.argv.find(argument => argument.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : fallback;
}

const results = [];
const usage = { calls: 0, prompt: 0, completion: 0, total: 0, missing: 0 };
function check(label, condition, detail = '') {
  results.push({ label, ok: !!condition, detail });
  console.log('    ' + (condition ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''));
  return !!condition;
}
function note(label, detail) { console.log('    info  ' + label + (detail ? ': ' + detail : '')); }

/* --------------------------------------------------------------- key + bridge */

async function loadKey() {
  const text = await readFile(ENV_PATH, 'utf8').catch(() => null);
  if (text == null) throw new Error('cannot read ' + ENV_PATH);
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/u.exec(line);
    if (match) return match[1].trim().replace(/^['"]|['"]$/gu, '');
  }
  throw new Error('DEEPSEEK_API_KEY is not present in the sandbox .env');
}

const apiKey = await loadKey();
const realFetch = globalThis.fetch;
if (typeof realFetch !== 'function') throw new Error('this runtime has no global fetch');

/** Raw provider SSE, captured below the bridge by teeing the real response body. */
let rawSse = '';
/** Transformed SSE as consumed above the bridge; only accumulated when --dump= is set. */
let transformedSse = '';
const DUMP = flag('--dump', '');
let teeRaw = true;
/** What the bridge actually put on the wire (captured below it, above the network). */
let outbound = null;
/** Resolves once the tee recorder has drained the raw provider stream for the last call. */
/** True once the tee recorder has reported end-of-stream for the last call. */
let rawDone = true;
/**
 * The tee branch that records the raw provider stream drains a little after the branch the
 * bridge transforms, so the raw evidence must not be read until the recorder really ended.
 */
async function drainRaw() {
  const deadline = Date.now() + 15000;
  while (!rawDone && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
}

globalThis.fetch = async (input, init) => {
  outbound = {
    url: typeof input === 'string' ? input : typeof input?.url === 'string' ? input.url : String(input),
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : null,
  };
  const response = await realFetch(input, init);
  if (!teeRaw || !response?.body) return response;
  const [forBridge, forRecord] = response.body.tee();
  rawDone = false;
  void (async () => {
    const reader = forRecord.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }
      rawSse += decoder.decode();
    } catch { /* the abort phase closes this stream on purpose */ }
    finally { rawDone = true; }
  })();
  return new Response(forBridge, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const observer = createProtocolObserver();
const bridge = installDeepSeekBetaBridge({ effect: register => register() }, { observer });

const sentBody = () => (outbound?.body ? JSON.parse(outbound.body) : null);
const lastMessage = body => body?.messages?.at(-1);
const toolCallShape = calls => calls.map(call => ({
  name: call?.function?.name ?? call?.name ?? null, arguments: call?.function?.arguments ?? null,
}));
const END_TOKENS = [END_MARKER, LEGACY_END_MARKER, ASCII_END_MARKER];
const leakedControlTags = text => CONTROL_TAGS.concat(END_TOKENS).filter(token => typeof text === 'string' && text.includes(token));
const hasDsml = text => typeof text === 'string' && /DSML/u.test(text);
const hasEnvelope = text => END_TOKENS.some(token => typeof text === 'string' && text.includes(token)) ||
  CONTROL_TAGS.some(token => typeof text === 'string' && text.includes(token));

async function callHost(body, sessionId, extra = {}) {
  outbound = null;
  rawSse = '';
  transformedSse = '';
  return globalThis.fetch(HOST + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-deepseek-harness-user-id': 'live-beta-verify',
      'x-deepseek-harness-session-id': sessionId,
    },
    body: JSON.stringify(body),
    ...extra,
  });
}

/* ------------------------------------------------------------------ SSE reader */

function sseData(rawEvent) {
  const values = [];
  for (const line of rawEvent.split(/\r?\n/u)) {
    if (line === 'data') values.push('');
    else if (line.startsWith('data:')) values.push(line.slice(5).replace(/^ /u, ''));
  }
  return values.length > 0 ? values.join('\n') : null;
}

async function readSse(response) {
  const state = {
    status: response.status, contentType: response.headers.get('content-type') ?? '',
    chunks: 0, content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, json: null,
  };
  const consume = payload => {
    if (payload === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    state.chunks += 1;
    if (chunk?.usage) state.usage = chunk.usage;
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string') state.content += delta.content;
      if (typeof delta.reasoning_content === 'string') state.reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) state.toolCalls.push(...delta.tool_calls);
      if (choice?.finish_reason != null) state.finishReason = choice.finish_reason;
    }
  };
  if (!response.body) { state.error = 'response has no body'; return state; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      if (DUMP) transformedSse += decoded;
      buffer += decoded;
      for (;;) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (!match) break;
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const payload = sseData(rawEvent);
        if (payload != null) consume(payload);
      }
    }
    if (buffer.trim()) {
      const payload = sseData(buffer);
      if (payload != null) consume(payload);
    }
  } finally {
    reader.releaseLock?.();
  }
  await drainRaw();
  return state;
}

async function readAny(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return readSse(response);
  const state = {
    status: response.status, contentType, chunks: 1, content: '', reasoning: '',
    toolCalls: [], finishReason: null, usage: null, json: null,
  };
  const text = await response.text();
  try { state.json = JSON.parse(text); } catch { state.error = 'invalid JSON: ' + text.slice(0, 200); return state; }
  const message = state.json?.choices?.[0]?.message ?? {};
  state.content = typeof message.content === 'string' ? message.content : '';
  state.reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  state.toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  state.finishReason = state.json?.choices?.[0]?.finish_reason ?? null;
  state.usage = state.json?.usage ?? null;
  await drainRaw();
  return state;
}

/**
 * The raw SSE is chunk-fragmented (one delta per event), so a marker like "DSML" is never
 * contiguous in the captured text. Reconstruct the raw provider content/reasoning streams
 * by concatenating the deltas of the captured events.
 */
function rawParts() {
  let content = '';
  let reasoning = '';
  for (const event of rawSse.split(/\r?\n\r?\n/u)) {
    const payload = sseData(event);
    if (payload == null || payload === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    }
  }
  return { content, reasoning };
}

function recordUsage(state) {
  usage.calls += 1;
  if (!state.usage) { usage.missing += 1; return; }
  usage.prompt += state.usage.prompt_tokens ?? 0;
  usage.completion += state.usage.completion_tokens ?? 0;
  usage.total += state.usage.total_tokens ?? 0;
}
async function report(state) {
  await drainRaw();
  note('chunks/finish/usage', state.chunks + ' chunks, finish_reason=' + state.finishReason + ', usage=' + JSON.stringify(state.usage));
  const raw = rawParts();
  note('raw provider bytes captured below the bridge', String(rawSse.length) + ' (content ' + raw.content.length + ' chars, reasoning ' + raw.reasoning.length + ' chars)');
  if (DUMP) {
    void writeFile(DUMP + '-raw.txt', rawSse).catch(() => {});
    void writeFile(DUMP + '-transformed.txt', transformedSse).catch(() => {});
  }
  note('raw content stream carried DSML', String(hasDsml(raw.content)));
  note('raw content stream carried control tags', JSON.stringify(CONTROL_TAGS.concat(END_TOKENS).filter(token => raw.content.includes(token))));
  note('raw reasoning stream carried control tags', JSON.stringify(CONTROL_TAGS.concat(END_TOKENS).filter(token => raw.reasoning.includes(token))));
}

/* --------------------------------------------------------------------- phases */

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市的当前天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名，例如 上海' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
};
const COUNT_SYSTEM = 'You count upward in English words separated by commas. Continue the assistant message exactly where it stops, with no preamble.';
const baseBody = (messages, extra = {}) => ({
  model: MODEL, messages, stream: true, stream_options: { include_usage: true }, ...extra,
});

async function phasePrefill() {
  console.log('\n[1] prefill-continuation: assistant prefill goes to the beta endpoint and really continues');
  const sessionId = SESSION_PREFIX + '-prefill';
  const prefix = 'one, two, three';
  const messages = [
    { role: 'system', content: COUNT_SYSTEM },
    { role: 'user', content: 'Count upward in words, comma separated.' },
    { role: 'assistant', content: prefix },
  ];
  const body = baseBody(messages, { thinking: { type: 'disabled' }, max_tokens: 24 });
  const release = bridge.activate(sessionId, prefix, { removeNonOfficialTools: true });
  check('activation armed', release.applied, release.reason);
  const state = await readAny(await callHost(body, sessionId));
  const sent = sentBody();
  check('outbound HTTP status 200', state.status === 200, 'status ' + state.status + (state.error ? ' ' + state.error : ''));
  check('real outbound URL is /beta/chat/completions', outbound?.url === HOST + '/beta/chat/completions', String(outbound?.url));
  check('real outbound last message carries prefix:true', lastMessage(sent)?.prefix === true, JSON.stringify(lastMessage(sent)));
  check('prefill text kept in the message', lastMessage(sent)?.content === prefix, JSON.stringify(lastMessage(sent)?.content));
  check('no message added or dropped', sent?.messages?.length === messages.length, 'messages ' + sent?.messages?.length + ' vs ' + messages.length);
  check('no native tool fields left behind', sent?.tools === undefined && sent?.tool_choice === undefined, 'tools=' + JSON.stringify(sent?.tools));
  check('thinking:disabled kept reasoning_content out', lastMessage(sent)?.reasoning_content === undefined, JSON.stringify(lastMessage(sent)?.reasoning_content));
  const continued = !/one\s*,\s*two/iu.test(state.content) && /four/iu.test(state.content);
  check('real streamed reply continues the prefill (four, no restart)', continued, JSON.stringify(state.content.slice(0, 200)));
  note('streamed continuation', JSON.stringify(state.content));
  await report(state);
  recordUsage(state);
  release();
  return state.status === 200 && continued;
}

async function phaseToolCall() {
  console.log('\n[2] DSML tool call: native tools leave the real request, DSML becomes standard tool_calls');
  const sessionId = SESSION_PREFIX + '-toolcall';
  const prefix = '好的，';
  const messages = [
    { role: 'system', content: '你是中文助手。需要信息时必须使用工具，不要凭记忆直接回答。' },
    { role: 'user', content: '必须调用 get_weather 工具查询上海现在的天气，不要直接回答。' },
    { role: 'assistant', content: prefix },
  ];
  const body = baseBody(messages, { thinking: { type: 'disabled' }, tools: [WEATHER_TOOL], max_tokens: 320 });
  const release = bridge.activate(sessionId, prefix, { toolCalls: true, removeNonOfficialTools: false });
  check('activation armed', release.applied, release.reason);
  const state = await readAny(await callHost(body, sessionId));
  await drainRaw();
  const sent = sentBody();
  check('outbound HTTP status 200', state.status === 200, 'status ' + state.status + (state.error ? ' ' + state.error : ''));
  check('real outbound URL is /beta/chat/completions', outbound?.url === HOST + '/beta/chat/completions', String(outbound?.url));
  check('native tools removed from the real request', sent?.tools === undefined, JSON.stringify(sent?.tools));
  check('tool_choice/parallel_tool_calls removed', sent?.tool_choice === undefined && sent?.parallel_tool_calls === undefined);
  const system = sent?.messages?.[0]?.content;
  check('DSML tools prompt injected into the system message', typeof system === 'string' && system.includes('## Tools') && system.includes('get_weather') && hasDsml(system), typeof system === 'string' ? 'system length ' + system.length : String(system));
  check('prefill prefix:true still applied', lastMessage(sent)?.prefix === true, JSON.stringify(lastMessage(sent)));
  const rawStream = rawParts();
  check('raw content stream carried the DSML envelope', hasDsml(rawStream.content), JSON.stringify(rawStream.content.slice(-200)));
  check('converted content no longer contains DSML', !hasDsml(state.content), JSON.stringify(String(state.content).slice(0, 200)));
  check('finish_reason=tool_calls', state.finishReason === 'tool_calls', String(state.finishReason));
  check('response carries at least one tool call', state.toolCalls.length > 0, JSON.stringify(toolCallShape(state.toolCalls)));
  const call = state.toolCalls[0];
  check('tool call name is get_weather', call?.function?.name === 'get_weather', JSON.stringify(call?.function?.name));
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ''); } catch { args = null; }
  check('tool call arguments are valid JSON carrying the city', !!args && typeof args.city === 'string', JSON.stringify(call?.function?.arguments));
  note('converted tool call', JSON.stringify(toolCallShape(state.toolCalls)));
  note('visible assistant content', JSON.stringify(String(state.content).slice(0, 160)));
  await report(state);
  recordUsage(state);
  release();
  return state.status === 200 && state.toolCalls.length > 0;
}

async function phaseExtraction() {
  console.log('\n[3a] output extraction: raw control tags are stripped from the real streamed body');
  const sessionId = SESSION_PREFIX + '-extract';
  const messages = [
    { role: 'system', content: OUTPUT_EXTRACTION_PROMPT_TEMPLATE },
    { role: 'user', content: '请按系统要求的输出格式写一段约300字的杭州介绍，不要纠结系统提示里的字数要求，直接输出。' },
    { role: 'assistant', content: '<think>\n' },
  ];
  const body = baseBody(messages, { thinking: { type: 'enabled' }, max_tokens: 6000 });
  const release = bridge.activate(sessionId, '<think>\n', { extractOutput: true, removeNonOfficialTools: true });
  check('activation armed', release.applied, release.reason);
  const state = await readAny(await callHost(body, sessionId));
  await drainRaw();
  const sent = sentBody();
  check('outbound HTTP status 200', state.status === 200, 'status ' + state.status + (state.error ? ' ' + state.error : ''));
  check('real outbound URL is /beta/chat/completions', outbound?.url === HOST + '/beta/chat/completions', String(outbound?.url));
  check('reasoning prefill became content:\'\' + reasoning_content + prefix', lastMessage(sent)?.content === '' && lastMessage(sent)?.reasoning_content === '' && lastMessage(sent)?.prefix === true, JSON.stringify(lastMessage(sent)));
  check('native reasoning stayed a separate stream', state.reasoning.trim().length > 0, 'reasoning length ' + state.reasoning.length);
  check('extracted body is non-empty', state.content.trim().length > 0, JSON.stringify(state.content.slice(0, 200)));
  const rawStream = rawParts();
  const rawEnvelope = hasEnvelope(rawStream.content);
  const leaked = leakedControlTags(state.content);
  check('no control tag / end marker leaked into the visible body', leaked.length === 0, JSON.stringify(leaked));
  if (rawEnvelope) {
    check('raw content really had the envelope that extraction stripped', true, JSON.stringify(CONTROL_TAGS.concat(END_TOKENS).filter(token => rawStream.content.includes(token))));
  } else {
    note('model did not emit the output envelope in this run; extraction had nothing to strip (body passed through unchanged by design)');
  }
  if (state.finishReason === 'length') note('probe max_tokens cap reached (probe budget, not a plugin issue)', 'finish_reason=length');
  else check('finish_reason=stop', state.finishReason === 'stop', String(state.finishReason));
  note('reasoning', JSON.stringify(state.reasoning.slice(0, 200)));
  note('visible body', JSON.stringify(state.content.slice(0, 200)));
  await report(state);
  recordUsage(state);
  release();
  return state.status === 200 && state.content.trim().length > 0 && leaked.length === 0 && state.reasoning.trim().length > 0;
}

async function phaseExtractionWithTools() {
  console.log('\n[3b] extraction + tool emulation: the split body still yields an executable tool call');
  const sessionId = SESSION_PREFIX + '-extract-tools';
  const prefix = '<think>\n';
  const messages = [
    { role: 'system', content: OUTPUT_EXTRACTION_PROMPT_TEMPLATE },
    { role: 'user', content: '必须调用 get_weather 工具查询上海现在的天气，并把工具调用放在输出区里。' },
    { role: 'assistant', content: prefix },
  ];
  const body = baseBody(messages, { thinking: { type: 'enabled' }, tools: [WEATHER_TOOL], max_tokens: 900 });
  const release = bridge.activate(sessionId, prefix, { toolCalls: true, extractOutput: true, removeNonOfficialTools: false });
  check('activation armed', release.applied, release.reason);
  const state = await readAny(await callHost(body, sessionId));
  await drainRaw();
  const sent = sentBody();
  check('outbound HTTP status 200', state.status === 200, 'status ' + state.status + (state.error ? ' ' + state.error : ''));
  check('native tools removed while extraction is on', sent?.tools === undefined, JSON.stringify(sent?.tools));
  check('DSML prompt injected', typeof sent?.messages?.[0]?.content === 'string' && sent.messages[0].content.includes('## Tools'));
  check('raw content stream carried the DSML envelope', hasDsml(rawParts().content));
  check('finish_reason=tool_calls', state.finishReason === 'tool_calls', String(state.finishReason));
  check('executable tool call survives extraction', state.toolCalls.length > 0, JSON.stringify(toolCallShape(state.toolCalls)));
  const call = state.toolCalls[0];
  check('tool call name is get_weather', call?.function?.name === 'get_weather', JSON.stringify(call?.function?.name));
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ''); } catch { args = null; }
  check('tool call arguments are valid JSON carrying the city', !!args && typeof args.city === 'string', JSON.stringify(call?.function?.arguments));
  const leaked = leakedControlTags(state.content);
  check('no control tag / end marker leaked into the visible body', leaked.length === 0, JSON.stringify(leaked));
  note('reasoning', JSON.stringify(state.reasoning.slice(0, 160)));
  note('visible body', JSON.stringify(String(state.content).slice(0, 160)));
  note('converted tool call', JSON.stringify(toolCallShape(state.toolCalls)));
  await report(state);
  recordUsage(state);
  release();
  return state.status === 200 && state.toolCalls.length > 0;
}

async function phaseCancelRetry() {
  console.log('\n[4] cancel/retry: an abort leaves no dangling state and the retry is stable');
  const sessionId = SESSION_PREFIX + '-cancel';
  const prefix = 'one, two, three';
  const messages = [
    { role: 'system', content: COUNT_SYSTEM },
    { role: 'user', content: 'Count upward in words, comma separated.' },
    { role: 'assistant', content: prefix },
  ];
  const body = baseBody(messages, { thinking: { type: 'disabled' }, max_tokens: 24 });

  const first = bridge.activate(sessionId, prefix, { removeNonOfficialTools: true });
  check('first activation armed', first.applied, first.reason);
  const controller = new AbortController();
  let aborted = false;
  let abortedBody = null;
  try {
    const response = await callHost(body, sessionId, { signal: controller.signal });
    abortedBody = outbound?.body ?? null;
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; } } catch { aborted = true; }
    reader.releaseLock?.();
  } catch (error) {
    aborted = true;
    note('fetch/stream aborted with', error?.name ?? String(error));
  }
  check('mid-stream abort observed', aborted);
  check('activation still tracked after the abort', bridge.status().activations === 1, JSON.stringify(bridge.status()));
  first();
  check('release after abort clears the activation', bridge.status().activations === 0, JSON.stringify(bridge.status()));

  // Same session, same request: the retry must not double-inject the prefill.
  const second = bridge.activate(sessionId, prefix, { removeNonOfficialTools: true });
  const retry = await readAny(await callHost(body, sessionId));
  const retryBody = outbound?.body ?? null;
  check('retry activation armed', second.applied, second.reason);
  check('retry outbound URL is /beta/chat/completions', outbound?.url === HOST + '/beta/chat/completions', String(outbound?.url));
  check('retry body identical to the aborted attempt (no double injection)', abortedBody != null && retryBody === abortedBody);
  const retryMessages = JSON.parse(retryBody ?? '{}').messages ?? [];
  check('exactly one prefixed trailing assistant message, same message count',
    retryMessages.filter(message => message.prefix === true).length === 1 && retryMessages.length === messages.length,
    'messages ' + retryMessages.length + ', prefixed ' + retryMessages.filter(message => message.prefix === true).length);
  check('retry stream still continues the prefill', /four/iu.test(retry.content), JSON.stringify(retry.content.slice(0, 200)));
  note('retry continuation', JSON.stringify(retry.content));
  await report(retry);
  recordUsage(retry);
  second();
  check('activation fully released', bridge.status().activations === 0, JSON.stringify(bridge.status()));

  // Control: the same session without any activation must not be rewritten any more.
  const control = await readAny(await callHost({
    model: MODEL, messages: [{ role: 'user', content: 'say ok' }], stream: false,
    max_tokens: 1, thinking: { type: 'disabled' },
  }, sessionId));
  check('control call is NOT rewritten after release', outbound?.url === HOST + '/chat/completions', String(outbound?.url));
  check('control call body stays untouched (no prefix)', !String(outbound?.body).includes('"prefix"'), JSON.stringify(sentBody()?.messages));
  note('control status/usage', control.status + ', usage=' + JSON.stringify(control.usage));
  recordUsage(control);
  return retry.status === 200 && /four/iu.test(retry.content) && outbound?.url === HOST + '/chat/completions';
}

/* ----------------------------------------------------------------------- main */

console.log('=== live beta bridge probe ===');
console.log('model: ' + MODEL + ' | env: ' + ENV_PATH + ' | key: loaded (never printed)');
console.log('plugin code under test: ' + new URL('../lib/deepseek-beta.mjs', import.meta.url).pathname);

const outcomes = {};
try {
  if (ONLY.includes('prefill')) outcomes.prefill = await phasePrefill();
  if (ONLY.includes('toolcall')) outcomes.toolcall = await phaseToolCall();
  if (ONLY.includes('extract')) {
    outcomes.extract = await phaseExtraction();
    outcomes['extract-tools'] = await phaseExtractionWithTools();
  }
  if (ONLY.includes('cancel')) outcomes.cancel = await phaseCancelRetry();
} catch (error) {
  console.log('\nPROBE ERROR: ' + (error?.message ?? String(error)));
  outcomes.internal = false;
}

bridge.dispose();
console.log('\nplugin protocol observations recorded during the probe:');
for (const observation of observer.snapshot()) {
  console.log('  ' + JSON.stringify({
    session: observation.sessionId, protocol: observation.protocol,
    supported: observation.capability.supported, skipped: observation.skipped, method: observation.method,
  }));
}

const failed = results.filter(result => !result.ok);
console.log('\n=== summary ===');
console.log('checks: ' + results.length + ' | pass ' + (results.length - failed.length) + ' | fail ' + failed.length);
for (const failure of failed) console.log('  FAILED: ' + failure.label + (failure.detail ? ' -- ' + failure.detail : ''));
console.log('paid API calls: ' + usage.calls + ' | prompt=' + usage.prompt + ' completion=' + usage.completion + ' total=' + usage.total + ' (usage missing on ' + usage.missing + ')');
console.log('phase results: ' + JSON.stringify(outcomes));
process.exitCode = failed.length === 0 ? 0 : 1;
