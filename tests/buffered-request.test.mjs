import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteDeepSeekPrefixFetch, installDeepSeekBetaBridge } from '../lib/deepseek-beta.mjs';
import { bufferedResponseToSse } from '../lib/buffered-response.mjs';
import { translate } from '../vendor/deepseek-chat/translate.mjs';
import { parseSse } from '../vendor/deepseek-chat/sse.mjs';

const headers = { 'x-deepseek-harness-session-id': 's' };
const registry = entry => [new Map([['s', new Map([['', { count: 1, stream: false, maxTokens: 1000000, ...entry }]])]])];
const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }];
const completion = { id: 'test', model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'done', reasoning_content: 'thought',
  tool_calls: [{ id: 'a', type: 'function', function: { name: 'echo', arguments: '{"x":1}' } }, { id: 'b', type: 'function', function: { name: 'echo', arguments: '{"x":2}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } };

test('normal Chat and Messages requests override max_tokens and stream without changing tools or unrelated sessions', () => {
  for (const path of ['chat/completions', 'messages']) {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools, stream: true, stream_options: { include_usage: true }, max_tokens: 12 };
    const changed = rewriteDeepSeekPrefixFetch('https://example.test/v1/' + path, { headers, body: JSON.stringify(body) }, registry());
    const wire = JSON.parse(changed.init.body);
    assert.equal(wire.stream, false); assert.equal(wire.max_tokens, 1000000); assert.equal(wire.stream_options, undefined); assert.deepEqual(wire.tools, tools);
    assert.equal(changed.bufferedResponseProtocol, path === 'messages' ? 'messages' : 'chat-completions');
    const unrelated = rewriteDeepSeekPrefixFetch('https://example.test/v1/' + path, { headers: { 'x-deepseek-harness-session-id': 'other' }, body: JSON.stringify(body) }, registry());
    assert.equal(unrelated.init.body, JSON.stringify(body));
    const inherited = rewriteDeepSeekPrefixFetch('https://example.test/v1/' + path, { headers, body: JSON.stringify(body) }, registry({ maxTokens: 0, stream: true }));
    assert.equal(JSON.parse(inherited.init.body).max_tokens, 12);
  }
});

test('completed Chat JSON retains multiple tools, reasoning, usage and max-token termination through the real stream translator', async () => {
  const response = await bufferedResponseToSse(Response.json(completion), 'chat-completions');
  const chunks = [];
  for await (const chunk of translate(parseSse(response.body))) chunks.push(chunk);
  const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block);
  assert.ok(blocks.some(b => b.type === 'reasoning' && b.text === 'thought'));
  assert.deepEqual(blocks.filter(b => b.type === 'tool-call').map(b => b.id), ['a', 'b']);
  const finish = chunks.find(c => c.type === 'finish'); assert.equal(finish.reason.kind, 'tool-calls'); assert.equal(chunks.find(c => c.type === 'usage').usage.totalTokens, 13);
  const limited = structuredClone(completion); limited.choices[0].finish_reason = 'length';
  const limitedResponse = await bufferedResponseToSse(Response.json(limited), 'chat-completions');
  for await (const chunk of translate(parseSse(limitedResponse.body))) if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'max-tokens');
});

test('completed Messages JSON preserves thinking signature and tool inputs with one terminal event', async () => {
  const response = await bufferedResponseToSse(Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'test', stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: 'think', signature: 'sig' }, { type: 'text', text: 'hello' }, { type: 'tool_use', id: 'call', name: 'echo', input: { a: 2 } }],
    usage: { input_tokens: 8, output_tokens: 3 } }), 'messages');
  const frames = await response.text();
  assert.match(frames, /signature_delta/); assert.ok(frames.includes('partial_json')); assert.ok(frames.includes('tool_use'));
  assert.equal(frames.match(/event: message_stop/g).length, 1); assert.match(frames, /"output_tokens":3/);
});

test('HTTP errors and existing SSE pass through; invalid or unfinished non-stream responses never fabricate completion', async () => {
  const error = new Response('bad', { status: 400 }), sse = new Response('data: x', { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await bufferedResponseToSse(error, 'chat-completions'), error); assert.equal(await bufferedResponseToSse(sse, 'chat-completions'), sse);
  await assert.rejects(bufferedResponseToSse(Response.json({ error: { message: 'provider error' } }), 'chat-completions'), /provider error/);
  await assert.rejects(bufferedResponseToSse(Response.json({ choices: [{ message: { content: 'partial' } }] }), 'chat-completions'), /结束原因/);
});

test('real fetch bridge applies non-stream parameters after prefix tool emulation and converts the completed DSML response', async () => {
  const original = globalThis.fetch; let wire;
  globalThis.fetch = async (_url, init) => { wire = JSON.parse(init.body); return Response.json({ ...completion, choices: [{ message: { role: 'assistant', content: '<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="echo"><｜｜DSML｜｜parameter name="x" string="false">1</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>' }, finish_reason: 'stop' }] }); };
  const bridge = installDeepSeekBetaBridge({ effect: () => {} });
  const release = bridge.activate('s', '<think>', { mode: 'chat-completions', toolCalls: true, maxTokens: 50000, stream: false });
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', { headers, body: JSON.stringify({ model: 'test', stream: true, tools, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '<think>' }] }) });
    assert.equal(wire.stream, false); assert.equal(wire.max_tokens, 50000); assert.equal(wire.tools, undefined); assert.equal(wire.messages.at(-1).prefix, true);
    const chunks = []; for await (const chunk of translate(parseSse(response.body))) chunks.push(chunk);
    assert.ok(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call' && c.block.name === 'echo'));
  } finally { release(); bridge.dispose(); globalThis.fetch = original; }
});
