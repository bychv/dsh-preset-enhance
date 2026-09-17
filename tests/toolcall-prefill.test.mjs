import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DSML_CALLS_OPEN,
  DSML_CALLS_CLOSE,
  emulateToolCallRequest,
  transformToolCallJson,
  transformToolCallResponse,
} from '../lib/toolcall-prefill.mjs';

const invoke = (name, parameters) => [
  '<｜｜DSML｜｜ invoke name="' + name + '">',
  ...parameters.map(([key, stringFlag, value]) =>
    '<｜｜DSML｜｜ parameter name="' + key + '" string="' + stringFlag + '">' +
    value + '</｜｜DSML｜｜ parameter>'),
  '</｜｜DSML｜｜ invoke>',
].join('\n');

test('tool emulation converts definitions, native history, results and images into DSML messages', () => {
  const image = 'iVBORw0KGgo' + 'A'.repeat(220);
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Check weather.' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need a lookup.',
        tool_calls: [{
          id: 'call-weather',
          type: 'function',
          function: { name: 'lookup_weather', arguments: '{"city":"Shanghai","days":2}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-weather',
        content: JSON.stringify({ temperature: 22, image }),
      },
      { role: 'assistant', content: 'Weather: ', reasoning_content: 'Use the result.', prefix: true },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'lookup_weather',
        description: 'Look up weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };

  const result = emulateToolCallRequest(body);
  assert.equal(result.contentPrefix, 'Weather: ');
  assert.equal(result.reasoningPrefix, 'Use the result.');
  assert.equal(result.body.tools, undefined);
  assert.equal(result.body.tool_choice, undefined);
  assert.equal(result.body.parallel_tool_calls, undefined);
  assert.match(result.body.messages[0].content, /## Tools/);
  assert.match(result.body.messages[0].content, /lookup_weather/);
  assert.equal(result.body.messages[2].reasoning_content, 'Need a lookup.');
  assert.equal(result.body.messages[2].tool_calls, undefined);
  assert.match(result.body.messages[2].content, /DSML/);
  assert.equal(result.body.messages[3].role, 'user');
  assert.ok(Array.isArray(result.body.messages[3].content));
  assert.match(result.body.messages[3].content[0].text, /tool_execution_result/);
  assert.equal(result.body.messages[3].content[1].type, 'image_url');
  assert.deepEqual(result.body.messages.at(-1), body.messages.at(-1));
  assert.deepEqual(body.tools[0].function.name, 'lookup_weather');
});

test('non-stream response restores prefixes and converts DSML into standard tool calls', () => {
  const dsml = DSML_CALLS_OPEN + '\n' + invoke('lookup_weather', [
    ['city', 'true', 'Shanghai'],
    ['days', 'false', '2'],
  ]) + '\n' + DSML_CALLS_CLOSE;
  const transformed = transformToolCallJson({
    id: 'response',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'checking\n' + dsml, reasoning_content: ' suffix' },
      finish_reason: 'stop',
    }],
  }, { contentPrefix: 'Weather: ', reasoningPrefix: 'prefix' });

  const choice = transformed.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, 'Weather: checking\n');
  assert.equal(choice.message.reasoning_content, 'prefix suffix');
  assert.equal(choice.message.tool_calls.length, 1);
  assert.match(choice.message.tool_calls[0].id, /^call_[a-f0-9]{24}$/u);
  assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: 'Shanghai', days: 2 });
});

test('stream response recognizes a split DSML marker and emits an OpenAI tool-call delta', async () => {
  const dsml = DSML_CALLS_OPEN + '\n' + invoke('lookup_weather', [['city', 'true', 'Shanghai']]) +
    '\n' + DSML_CALLS_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + String.fromCharCode(10, 10);
  const chunks = [
    sse({ id: 'r', choices: [{
      index: 0,
      delta: { role: 'assistant', reasoning_content: ' suffix', content: 'checking' + dsml.slice(0, 8) },
      finish_reason: null,
    }] }),
    sse({ id: 'r', choices: [{
      index: 0,
      delta: { content: dsml.slice(8) },
      finish_reason: null,
    }] }),
    sse({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse('[DONE]'),
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const wire = chunks.join('');
      for (const cut of [17, 61, 143, wire.length]) {
        const start = this.offset ?? 0;
        if (cut > start) controller.enqueue(encoder.encode(wire.slice(start, cut)));
        this.offset = cut;
      }
      controller.close();
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const transformed = await transformToolCallResponse(response, {
    contentPrefix: 'Weather: ',
    reasoningPrefix: 'prefix',
  });
  const text = await transformed.text();
  const payloads = text.split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const json = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse);
  const choices = json.flatMap(chunk => chunk.choices ?? []);
  const content = choices.map(choice => choice.delta?.content ?? '').join('');
  const reasoning = choices.map(choice => choice.delta?.reasoning_content ?? '').join('');
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));

  assert.equal(content, 'Weather: checking');
  assert.equal(reasoning, 'prefix suffix');
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].index, 0);
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(toolChoice.delta.tool_calls[0].function.arguments), { city: 'Shanghai' });
  assert.equal(payloads.at(-1), '[DONE]');
});
