import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_SENTENCE,
  END_MARKER,
  OUTPUT_CLOSE,
  OUTPUT_EXTRACTION_PROMPT_TEMPLATE,
  OUTPUT_OPEN,
  createOutputExtractionStream,
  extractOutputText,
} from '../lib/output-extractor.mjs';
import {
  DSML_CALLS_CLOSE, DSML_CALLS_OPEN, transformToolCallJson, transformToolCallResponse,
} from '../lib/toolcall-prefill.mjs';

const invoke = '<｜｜DSML｜｜ invoke name="lookup_weather">\n' +
  '<｜｜DSML｜｜ parameter name="city" string="true">上海</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>';

test('the bundled template is the stability test final strategy prompt', () => {
  assert.match(OUTPUT_EXTRACTION_PROMPT_TEMPLATE, new RegExp(END_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(OUTPUT_EXTRACTION_PROMPT_TEMPLATE, new RegExp(OUTPUT_OPEN.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(OUTPUT_EXTRACTION_PROMPT_TEMPLATE, /您好，这是约定的内容，请查收/u);
  assert.match(OUTPUT_EXTRACTION_PROMPT_TEMPLATE, /1200~1600/u);
});

test('final strategy separates thinking from the output region and strips control tags', () => {
  const source = '<think>先分析问题\n' + END_MARKER + '\n' + OUTPUT_OPEN +
    ANCHOR_SENTENCE + '\n<content>最终正文</content>' + OUTPUT_CLOSE;
  const result = extractOutputText(source);
  assert.equal(result.switched, true);
  assert.match(result.reasoning, /先分析问题/u);
  assert.doesNotMatch(result.reasoning, /最终正文/u);
  assert.match(result.content, /<content>最终正文<\/content>/u);
  assert.doesNotMatch(result.content, /begin▁of▁output|end▁of▁output/u);
});

test('stream extraction is invariant across split control tags', () => {
  const source = '<think>逐步思考\n' + END_MARKER + '\n' + OUTPUT_OPEN +
    ANCHOR_SENTENCE + '\n<content>流式正文</content>' + OUTPUT_CLOSE;
  const expected = extractOutputText(source);
  for (const size of [1, 2, 5, 13, 40]) {
    const scanner = createOutputExtractionStream();
    let reasoning = '', content = '';
    for (let index = 0; index < source.length; index += size) {
      const part = scanner.push(source.slice(index, index + size));
      reasoning += part.reasoning;
      content += part.content;
    }
    const tail = scanner.finish();
    reasoning += tail.reasoning;
    content += tail.content;
    assert.equal(reasoning, expected.reasoning, `reasoning differs at chunk size ${size}`);
    assert.equal(content, expected.content, `content differs at chunk size ${size}`);
  }
});

test('extracted DSML becomes a standard tool call while thinking remains separate', () => {
  const dsml = DSML_CALLS_OPEN + '\n' + invoke + '\n' + DSML_CALLS_CLOSE;
  const source = '<think>需要查询天气\n' + END_MARKER + '\n' + OUTPUT_OPEN + dsml + OUTPUT_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: { role: 'assistant', content: source }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  const choice = transformed.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content?.trim() || null, null);
  assert.match(choice.message.reasoning_content, /需要查询天气/u);
  assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: '上海' });
});

test('native reasoning makes plain provider content an already-separated body', () => {
  const transformed = transformToolCallJson({
    choices: [{ message: { role: 'assistant', reasoning_content: 'native plan', content: 'plain answer' }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  assert.equal(transformed.choices[0].message.reasoning_content, 'native plan');
  assert.equal(transformed.choices[0].message.content, 'plain answer');
});

test('SSE extraction survives split markers and emits a standard tool-call delta', async () => {
  const dsml = DSML_CALLS_OPEN + '\n' + invoke + '\n' + DSML_CALLS_CLOSE;
  const source = '<think>流式判断工具\n' + END_MARKER + '\n' + OUTPUT_OPEN + dsml + OUTPUT_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const frames = [];
  for (let index = 0; index < source.length; index += 7) {
    frames.push(sse({ id: 'extract', choices: [{
      index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: source.slice(index, index + 7) },
      finish_reason: null,
    }] }));
  }
  frames.push(sse({ id: 'extract', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]'));
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const wire = frames.join('');
      for (let index = 0; index < wire.length; index += 19) controller.enqueue(encoder.encode(wire.slice(index, index + 19)));
      controller.close();
    },
  });
  const transformed = await transformToolCallResponse(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    { extractOutput: true },
  );
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse)
    .flatMap(chunk => chunk.choices ?? []);
  const reasoning = choices.map(choice => choice.delta?.reasoning_content ?? '').join('');
  const content = choices.map(choice => choice.delta?.content ?? '').join('');
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));
  assert.match(reasoning, /流式判断工具/u);
  assert.equal(content.trim(), '');
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(toolChoice.delta.tool_calls[0].function.arguments), { city: '上海' });
  assert.equal(payloads.at(-1), '[DONE]');
});
