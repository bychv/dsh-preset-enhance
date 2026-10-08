import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DSML_CALLS_OPEN,
  DSML_CALLS_CLOSE,
  buildToolsPrompt,
  emulateToolCallRequest,
  inlineToolHistory,
  parseDsmlCalls,
  parseToolCallsFromText,
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

test('DSML parser accepts official, V3.2 and whitespace-drift variants without requiring newlines', () => {
  const variants = [
    '<｜DSML｜tool_calls><｜DSML｜invoke name = "lookup_weather"><｜DSML｜parameter string = "true" name = "city">Shanghai</｜DSML｜parameter><｜DSML｜parameter name = "days">2</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    "<|DSML|function_calls ><|DSML|invoke name='lookup_weather'><|DSML|parameter name='city' string='true'>Shanghai</|DSML|parameter><|DSML|parameter string='false'name='days'>2</|DSML|parameter></|DSML|invoke></|DSML|function_calls>",
    '<｜DSML｜toolcalls> <｜DSML｜ invoke name=“lookup_weather”> <｜DSML｜ parameter name=“city” string=“true”>Shanghai</｜DSML｜ parameter> </｜DSML｜ invoke> </｜DSML｜tool_calls>',
    '<｜DSML｜tool><｜DSML｜invoke name="lookup_weather"><｜DSML｜parameter name="city" string="true">Shanghai</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
  ];
  for (const [index, text] of variants.entries()) {
    const parsed = parseToolCallsFromText('checking' + text);
    assert.equal(parsed.content, 'checking', `content variant ${index}`);
    assert.equal(parsed.toolCalls?.[0].function.name, 'lookup_weather', `name variant ${index}`);
    const args = JSON.parse(parsed.toolCalls[0].function.arguments);
    assert.equal(args.city, 'Shanghai', `city variant ${index}`);
    if (index < 2) assert.equal(args.days, 2, `days variant ${index}`);
  }
});

test('DSML parser preserves the V4.1 namespace-qualified tool format', () => {
  const text = '<｜DSML｜ calls><｜DSML｜ invoke name="search::lookup">' +
    '<｜DSML｜ parameter name="query" string="true">DeepSeek V4.1</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';
  const parsed = parseToolCallsFromText(text);
  assert.equal(parsed.content, '');
  assert.equal(parsed.toolCalls[0].namespace, 'search');
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'DeepSeek V4.1' });
});

test('V4.1 namespace-qualified tool names round trip through prompts and history', () => {
  const tool = {
    type: 'function',
    namespace: { name: 'search', description: 'Search tools.' },
    function: { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object' } },
  };
  assert.match(buildToolsPrompt([tool]), /^### search::lookup$/mu);
  const messages = inlineToolHistory([{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call-search',
      type: 'function',
      namespace: 'search',
      function: { name: 'lookup', arguments: '{"query":"DeepSeek V4.1"}' },
    }],
  }]);
  assert.match(messages[0].content, /invoke name="search::lookup"/u);
});

test('DSML parser accepts spaced double pipes and ignores duplicate invoke closes', () => {
  const text = '< | | DSML | | invoke name="skill">' +
    '< | | DSML | | parameter name="name" string="true">anima-tagger</ | | DSML | | parameter>' +
    '</ | | DSML | | invoke></ | | DSML | | invoke>' +
    '< | | DSML | | invoke name="read_image">' +
    '< | | DSML | | parameter name="file_path" string="true">C:\\images\\sample.png</ | | DSML | | parameter>' +
    '</ | | DSML | | invoke></ | | DSML | | calls>';
  const parsed = parseToolCallsFromText(text);
  assert.equal(parsed.content, '');
  assert.deepEqual(parsed.toolCalls.map(call => call.function.name), ['skill', 'read_image']);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { name: 'anima-tagger' });
  assert.deepEqual(JSON.parse(parsed.toolCalls[1].function.arguments), { file_path: 'C:\\images\\sample.png' });
});

test('DSML parser recovers complete orphan invokes and missing parameter close tags conservatively', () => {
  const orphan = '<｜DSML｜invoke name="lookup_weather">' +
    '<｜DSML｜parameter name="city" string="true">Shanghai' +
    '<｜DSML｜parameter name="days" string="false">2</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const parsed = parseToolCallsFromText('checking\\' + orphan);
  assert.equal(parsed.content, 'checking');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { city: 'Shanghai', days: 2 });

  const incomplete = 'ordinary text <｜DSML｜invoke name="lookup_weather">' +
    '<｜DSML｜parameter name="city" string="true">Shanghai';
  assert.deepEqual(parseToolCallsFromText(incomplete), { content: incomplete, toolCalls: null });
  assert.equal(parseDsmlCalls('<invoke name="not_dsml"></invoke>').length, 0);
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

test('stream response captures compact whitespace-drift DSML across single-character deltas', async () => {
  const dsml = '<｜DSML｜toolcalls ><｜DSML｜ invoke name = \'lookup_weather\'>' +
    '<｜DSML｜ parameter string = \'true\' name = \'city\'>Shanghai</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜tool_calls>';
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const events = [...('checking' + dsml)].map((content, index) => sse({
    id: 'r',
    choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }],
  }));
  events.push(sse({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]'));
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const transformed = await transformToolCallResponse(response, {});
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean)
    .map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse)
    .flatMap(chunk => chunk.choices ?? []);
  const content = choices.map(choice => choice.delta?.content ?? '').join('');
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));

  assert.equal(content, 'checking');
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(toolChoice.delta.tool_calls[0].function.arguments), { city: 'Shanghai' });
  assert.equal(payloads.at(-1), '[DONE]');
});
/** Marker characters shared by the tolerance tests below. */
const BAR = String.fromCharCode(0xFF5C);
const BLK = String.fromCharCode(0x2581);
const ZW = String.fromCharCode(0x200B);

test('official chat-template envelope recovers pipe-prefixed invokes without the DSML literal', () => {
  const begin = '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'begin' + BAR + '>';
  const end = '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'end' + BAR + '>';
  const text = 'prefix text' + '\n'
    + begin + '\n'
    + '<' + BAR + 'invoke name="lookup_weather"' + BAR + '>' + '\n'
    + '<' + BAR + 'parameter name="city" string="true">Shanghai</' + BAR + 'parameter' + BAR + '>' + '\n'
    + '<' + BAR + '/invoke' + BAR + '>' + '\n'
    + end;
  const parsed = parseToolCallsFromText(text);
  assert.equal(parsed.content, 'prefix text' + String.fromCharCode(10));
  assert.deepEqual(parsed.toolCalls.map(call => call.function.name), ['lookup_weather']);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { city: 'Shanghai' });

  // The DSML-prefixed dialect keeps working inside the same envelope.
  const dsmlInside = begin + '\n' + invoke('lookup_weather', [['city', 'true', 'Shanghai']]) + '\n' + end;
  const nested = parseToolCallsFromText(dsmlInside);
  assert.deepEqual(nested.toolCalls.map(call => call.function.name), ['lookup_weather']);
});

test('bare pipe-prefixed markers outside the official envelope are never tool calls', () => {
  const bare = '<' + BAR + 'invoke name="lookup_weather"' + BAR + '>' + '\n'
    + '<' + BAR + 'parameter name="city" string="true">Shanghai</' + BAR + 'parameter' + BAR + '>' + '\n'
    + '<' + BAR + '/invoke' + BAR + '>';
  assert.deepEqual(parseToolCallsFromText(bare), { content: bare, toolCalls: null });

  // An end marker without a begin marker, and a begin marker without an invoke, stay inert.
  const endOnly = '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'end' + BAR + '>' + '\n' + bare;
  assert.deepEqual(parseToolCallsFromText(endOnly), { content: endOnly, toolCalls: null });
  const emptyEnvelope = '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'begin' + BAR + '>just prose<' + BAR + 'tool' + BLK + 'calls' + BLK + 'end' + BAR + '>';
  assert.deepEqual(parseToolCallsFromText(emptyEnvelope), { content: emptyEnvelope, toolCalls: null });

  // The relaxed region ends at the matching end marker: markers after it stay unparsed.
  const trailing = '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'begin' + BAR + '>' + '\n'
    + '<' + BAR + 'invoke name="lookup_weather"' + BAR + '>' + '\n'
    + '<' + BAR + 'parameter name="city" string="true">Shanghai</' + BAR + 'parameter' + BAR + '>' + '\n'
    + '<' + BAR + '/invoke' + BAR + '>' + '\n'
    + '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'end' + BAR + '>' + '\n' + bare;
  const bounded = parseToolCallsFromText(trailing);
  assert.equal(bounded.toolCalls.length, 1);
});

test('zero-width characters and U+2581 padding inside a marker still count as one marker', () => {
  const zwPrefixed = '<' + BAR + ZW + BAR + 'DSML' + ZW + BAR + BAR + ' invoke name="lookup_weather">' + '\n'
    + '<' + BAR + BAR + 'DSML' + ZW + BAR + BAR + ' parameter name="city" string="true">Shanghai</' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>' + '\n'
    + '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
  const padded = parseToolCallsFromText(zwPrefixed);
  assert.deepEqual(padded.toolCalls.map(call => call.function.name), ['lookup_weather']);
  assert.deepEqual(JSON.parse(padded.toolCalls[0].function.arguments), { city: 'Shanghai' });

  const blockSeparated = '<' + BAR + BLK + BAR + BLK + 'DSML' + BLK + BAR + BLK + BAR + ' invoke name="lookup_weather">' + '\n'
    + '<' + BAR + BLK + BAR + BLK + 'DSML' + BLK + BAR + BLK + BAR + ' parameter name="city" string="true">Shanghai</' + BAR + BLK + BAR + BLK + 'DSML' + BLK + BAR + BLK + BAR + ' parameter>' + '\n'
    + '</' + BAR + BLK + BAR + BLK + 'DSML' + BLK + BAR + BLK + BAR + ' invoke>';
  const blocks = parseToolCallsFromText(blockSeparated);
  assert.deepEqual(blocks.toolCalls.map(call => call.function.name), ['lookup_weather']);

  // Padding inside prose still invents nothing.
  const prose = 'the word invoke' + ZW + ' appears here, and so does parameter' + ZW + ' naming.';
  assert.deepEqual(parseToolCallsFromText(prose), { content: prose, toolCalls: null });
});

test('missing parameter closes drop formatting padding while closed values stay exact', () => {
  const noClose = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="lookup_weather">' + '\n'
    + '<' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter name="city" string="true">Shanghai' + '\n'
    + '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
  const parsed = parseToolCallsFromText(noClose);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { city: 'Shanghai' });

  // A self-closing parameter carries no value, so the argument is the empty string.
  const selfClosing = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="lookup_weather">' + '\n'
    + '<' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter name="city" string="true"/>' + '\n'
    + '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
  const empty = parseToolCallsFromText(selfClosing);
  assert.deepEqual(JSON.parse(empty.toolCalls[0].function.arguments), { city: '' });

  // A closed value keeps every character, including intentional trailing whitespace.
  const closed = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="lookup_weather">' + '\n'
    + '<' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter name="city" string="true">Shanghai </' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>' + '\n'
    + '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
  const exact = parseToolCallsFromText(closed);
  assert.deepEqual(JSON.parse(exact.toolCalls[0].function.arguments), { city: 'Shanghai ' });
});

test('a Markdown code fence around a DSML block neither hides nor invents a call', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const fenced = fence + 'xml' + '\n' + invoke('lookup_weather', [['city', 'true', 'Shanghai']]) + '\n' + fence;
  const parsed = parseToolCallsFromText(fenced);
  assert.deepEqual(parsed.toolCalls.map(call => call.function.name), ['lookup_weather']);
  const plainXml = fence + 'xml' + '\n' + '<tool_calls><invoke name="lookup_weather"><parameter name="city">Shanghai</parameter></invoke></tool_calls>' + '\n' + fence;
  assert.deepEqual(parseToolCallsFromText(plainXml), { content: plainXml, toolCalls: null });
});
test('self-closing parameters never leak the trailing slash into a value', () => {
  const NL = String.fromCharCode(10);
  const prefix = BAR + BAR + 'DSML' + BAR + BAR;
  const callsOpen = '<' + prefix + ' calls>';
  const callsClose = '</' + prefix + ' calls>';
  const invokeOpen = '<' + prefix + ' invoke name="lookup_weather">';
  const invokeClose = '</' + prefix + ' invoke>';
  const selfClosingCity = '<' + prefix + ' parameter name="city" string="true"/>';
  const argsOf = text => JSON.parse(parseToolCallsFromText(text).toolCalls[0].function.arguments);

  // 1. only child, same line as the closing invoke.
  assert.deepEqual(argsOf(callsOpen + invokeOpen + selfClosingCity + invokeClose + callsClose), { city: '' });

  // 2. only child, newline before the closing invoke.
  assert.deepEqual(argsOf([callsOpen, invokeOpen, selfClosingCity, invokeClose, callsClose].join(NL)), { city: '' });

  // 3. followed by another parameter on the SAME line.
  const nextSameLine = callsOpen + invokeOpen + selfClosingCity + '<' + prefix + ' parameter name="days" string="false">2</' + prefix + ' parameter>' + invokeClose + callsClose;
  assert.deepEqual(argsOf(nextSameLine), { city: '', days: 2 });

  // 4. followed by another parameter on the NEXT line (this used to leak the newline as the value).
  const nextLine = [callsOpen, invokeOpen, selfClosingCity, '<' + prefix + ' parameter name="days" string="false">2</' + prefix + ' parameter>', invokeClose, callsClose].join(NL);
  assert.deepEqual(argsOf(nextLine), { city: '', days: 2 });

  // 5. string="false" self-closing parameter.
  const falseFlag = callsOpen + invokeOpen + '<' + prefix + ' parameter name="limit" string="false"/>' + invokeClose + callsClose;
  assert.deepEqual(argsOf(falseFlag), { limit: '' });

  // 6. official envelope self-closing, with and without the trailing pipe.
  const official = suffix => ['<' + BAR + 'tool' + BLK + 'calls' + BLK + 'begin' + BAR + '>',
    '<' + BAR + 'invoke name="lookup_weather"' + suffix + '>',
    '<' + BAR + 'parameter name="city" string="true"' + suffix + '/>',
    '<' + BAR + '/invoke' + suffix + '>',
    '<' + BAR + 'tool' + BLK + 'calls' + BLK + 'end' + BAR + '>'].join(NL);
  assert.deepEqual(argsOf(official(BAR)), { city: '' });
  assert.deepEqual(argsOf(official('')), { city: '' });

  // A slash that belongs to a closed value is preserved, never mistaken for self-closing.
  const slashValue = callsOpen + invokeOpen + '<' + prefix + ' parameter name="path" string="true">/tmp/x/</' + prefix + ' parameter>' + invokeClose + callsClose;
  assert.deepEqual(argsOf(slashValue), { path: '/tmp/x/' });
});

/* ---------------------------------------------------------------- stream delivery */

const BAR_CHAR = '｜';
const DSML_PREFIX = BAR_CHAR + BAR_CHAR + 'DSML' + BAR_CHAR + BAR_CHAR;
const sseFrame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const dsmlInvoke = (name, parameters) => '<' + DSML_PREFIX + 'invoke name="' + name + '">' +
  parameters.map(([key, value]) => '<' + DSML_PREFIX + 'parameter name="' + key + '" string="true">' + value +
    '</' + DSML_PREFIX + 'parameter>').join('') + '</' + DSML_PREFIX + 'invoke>';
const dsmlWrap = body => '<' + DSML_PREFIX + 'tool_calls>' + body + '</' + DSML_PREFIX + 'tool_calls>';

async function streamResult(frames, metadata) {
  const encoder = new TextEncoder();
  const transformed = await transformToolCallResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frames.join(''))); controller.close(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }), metadata);
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean)
    .map(event => event.replace(/^data: /u, ''));
  const chunks = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse);
  const choices = chunks.flatMap(chunk => chunk.choices ?? []);
  return {
    payloads,
    choices,
    calls: choices.flatMap(choice => choice.delta?.tool_calls ?? []),
    shown: choices.map(choice => (choice.delta?.content ?? '') + (choice.delta?.reasoning_content ?? '')).join(''),
  };
}

test('two identical calls written once each are both delivered, not deduplicated', async () => {
  // Only a repeat a previous channel already delivered is a duplicate. The same call
  // written twice in one channel is a deliberate sequence (note: 2026-10-07).
  const result = await streamResult([
    sseFrame({ id: 'dup', choices: [{ index: 0, delta: { content: dsmlWrap(dsmlInvoke('glob', [['pattern', '*']]) + dsmlInvoke('glob', [['pattern', '*']])) }, finish_reason: null }] }),
    sseFrame({ id: 'dup', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseFrame('[DONE]'),
  ], {});
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.calls.map(call => call.function.name), ['glob', 'glob']);
  assert.equal(result.shown.includes('DSML'), false);
});

test('one call written into both channels is delivered exactly once', async () => {
  const call = dsmlWrap(dsmlInvoke('glob', [['pattern', '*']]));
  const result = await streamResult([
    sseFrame({ id: 'both', choices: [{ index: 0, delta: { reasoning_content: call }, finish_reason: null }] }),
    sseFrame({ id: 'both', choices: [{ index: 0, delta: { content: call }, finish_reason: null }] }),
    sseFrame({ id: 'both', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseFrame('[DONE]'),
  ], {});
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].function.name, 'glob');
});

test('a truncated call is never turned into a tool call, and unrelated text still streams', async () => {
  const truncated = dsmlWrap(dsmlInvoke('glob', [['pattern', 'a-much-longer-pattern-value']])).slice(0, 58);
  const result = await streamResult([
    sseFrame({ id: 'short', choices: [{ index: 0, delta: { content: truncated }, finish_reason: null }] }),
    sseFrame({ id: 'short', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseFrame('[DONE]'),
  ], {});
  assert.equal(result.calls.length, 0, 'incomplete markup must not be faked into a call');
  assert.ok(result.shown.length > 0, 'the incomplete text is surfaced rather than silently swallowed');
  const plain = await streamResult([
    sseFrame({ id: 'plain', choices: [{ index: 0, delta: { content: '普通正文' }, finish_reason: null }] }),
    sseFrame({ id: 'plain', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseFrame('[DONE]'),
  ], {});
  assert.equal(plain.calls.length, 0);
  assert.equal(plain.shown, '普通正文');
});

test('an error after a complete call does not deliver a fabricated tool call', async () => {
  const result = await streamResult([
    sseFrame({ id: 'err', choices: [{ index: 0, delta: { reasoning_content: dsmlWrap(dsmlInvoke('glob', [['pattern', '*']])) }, finish_reason: null }] }),
    sseFrame({ error: { message: 'upstream failed' } }),
    sseFrame('[DONE]'),
  ], {});
  assert.equal(result.calls.length, 0);
  assert.equal(result.shown.includes('DSML'), false);
});

test('a body-written call is captured under output extraction even next to a thinking close tag', async () => {
  const call = dsmlWrap(dsmlInvoke('glob', [['pattern', '*']]));
  const result = await streamResult([
    sseFrame({ id: 'after-think', choices: [{ index: 0, delta: { content: '思考内容</thinking>' + call }, finish_reason: null }] }),
    sseFrame({ id: 'after-think', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseFrame('[DONE]'),
  ], { extractOutput: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].function.name, 'glob');
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { pattern: '*' });
  assert.equal(result.shown.includes('DSML'), false, 'the captured call must not stay visible in a channel');
});

test('a call written into the thinking channel is captured when the stream ends without a finish reason', async () => {
  // Reported shape: during prefix continuation the model sometimes writes the whole call
  // into its thinking channel and never switches to the body. If the connection then ends
  // with no finish_reason and no [DONE], the buffered call used to be flushed as text.
  const call = dsmlWrap(dsmlInvoke('glob', [['pattern', '*']]));
  for (const metadata of [{}, { extractOutput: true }]) {
    const result = await streamResult([
      sseFrame({ id: 'eof', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想一下。' + call }, finish_reason: null }] }),
    ], metadata);
    assert.equal(result.calls.length, 1, 'the complete call is delivered even without a terminator');
    assert.equal(result.calls[0].function.name, 'glob');
    assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { pattern: '*' });
    const choice = result.choices.find(item => Array.isArray(item.delta?.tool_calls));
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(result.shown.includes('DSML'), false, 'the call text must not leak into a channel');
  }
});

test('a split call in the thinking channel survives a stream that just stops', async () => {
  const call = dsmlWrap(dsmlInvoke('glob', [['pattern', '*']]));
  const frames = [...call].map((reasoning_content, index) => sseFrame({
    id: 'eof-split',
    choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', reasoning_content } : { reasoning_content }, finish_reason: null }],
  }));
  const result = await streamResult(frames, { extractOutput: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].function.name, 'glob');
  assert.equal(result.shown.includes('DSML'), false);
});

test('an unterminated stream still never fabricates a call from truncated markup', async () => {
  const truncated = dsmlWrap(dsmlInvoke('glob', [['pattern', 'a-long-enough-pattern-value']])).slice(0, 60);
  const result = await streamResult([
    sseFrame({ id: 'eof-short', choices: [{ index: 0, delta: { reasoning_content: truncated }, finish_reason: null }] }),
  ], { extractOutput: true });
  assert.equal(result.calls.length, 0, 'incomplete markup must stay text');
  assert.ok(result.shown.length > 0, 'and it must remain visible rather than vanish');
});

test('a call written without any newlines is captured on every path and split granularity', async () => {
  // Models often emit the whole call as one line, with the wrapper, the invoke and every
  // parameter immediately adjacent. Recognition must not depend on line breaks.
  const compact = '<' + DSML_PREFIX + 'calls><' + DSML_PREFIX + 'invoke name="lookup_weather">' +
    '<' + DSML_PREFIX + 'parameter name="city" string="true">上海</' + DSML_PREFIX + 'parameter>' +
    '<' + DSML_PREFIX + 'parameter name="days" string="false">2</' + DSML_PREFIX + 'parameter>' +
    '</' + DSML_PREFIX + 'invoke></' + DSML_PREFIX + 'calls>';
  // Non-streaming: both with and without extraction.
  for (const metadata of [{}, { extractOutput: true }]) {
    const choice = transformToolCallJson({
      choices: [{ message: { role: 'assistant', content: compact }, finish_reason: 'stop' }],
    }, metadata).choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: '上海', days: 2 });
    assert.equal(String(choice.message.content ?? '').includes('DSML'), false);
  }
  // Streaming: one delta, then one character at a time, in the body and in the thinking
  // channel, each with a finish reason and again with an EOF that never reports one.
  const split = (field) => [...compact].map((value, index) => sseFrame({
    id: 'compact',
    choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', [field]: value } : { [field]: value }, finish_reason: null }],
  }));
  for (const metadata of [{}, { extractOutput: true }]) {
    for (const field of ['content', 'reasoning_content']) {
      const terminated = await streamResult([
        ...split(field),
        sseFrame({ id: 'compact', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        sseFrame('[DONE]'),
      ], metadata);
      const unterminated = await streamResult(split(field), metadata);
      for (const [shape, result] of [['terminated', terminated], ['unterminated', unterminated]]) {
        assert.equal(result.calls.length, 1, shape + '/' + field + ' delivers one call');
        assert.equal(result.calls[0].function.name, 'lookup_weather', shape + '/' + field);
        assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { city: '上海', days: 2 }, shape + '/' + field);
        assert.equal(result.shown.includes('DSML'), false, shape + '/' + field + ' leaks nothing');
      }
    }
  }
  // Two adjacent invokes inside one wrapper on a single line.
  const pair = '<' + DSML_PREFIX + 'calls><' + DSML_PREFIX + 'invoke name="a">' +
    '<' + DSML_PREFIX + 'parameter name="x" string="true">1</' + DSML_PREFIX + 'parameter></' + DSML_PREFIX + 'invoke>' +
    '<' + DSML_PREFIX + 'invoke name="b"><' + DSML_PREFIX + 'parameter name="y" string="true">2</' + DSML_PREFIX + 'parameter>' +
    '</' + DSML_PREFIX + 'invoke></' + DSML_PREFIX + 'calls>';
  const double = transformToolCallJson({
    choices: [{ message: { role: 'assistant', content: pair }, finish_reason: 'stop' }],
  }, {}).choices[0];
  assert.deepEqual(double.message.tool_calls.map(call => call.function.name), ['a', 'b']);
});
