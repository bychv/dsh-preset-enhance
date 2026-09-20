import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_SENTENCE,
  END_MARKER,
  OUTPUT_CLOSE,
  OUTPUT_EXTRACTION_PROMPT_TEMPLATE,
  OUTPUT_OPEN,
  createOutputExtractionStream,
  extractTaggedOutputFallback,
  extractOutputText,
} from '../lib/output-extractor.mjs';
import {
  DSML_CALLS_CLOSE, DSML_CALLS_OPEN, TOOL_CALLS_CLOSE, TOOL_CALLS_OPEN,
  transformToolCallJson, transformToolCallResponse,
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

test('inline extraction tokens and a tool_calls-wrapped DSML call are removed and converted', () => {
  const webInvoke = '<｜｜DSML｜｜ invoke name="web_search"> ' +
    '<｜｜DSML｜｜ parameter name="queries" string="false">' +
    '["龙族 江南 ","龙族 ","龙族 电子书 阅读平台 正版"]' +
    '</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke>';
  const source = END_MARKER + ' ' + OUTPUT_OPEN + ' ' + TOOL_CALLS_OPEN + ' ' +
    webInvoke + ' ' + TOOL_CALLS_CLOSE + ' ' + OUTPUT_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: { role: 'assistant', content: source }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  const choice = transformed.choices[0];
  const serialized = JSON.stringify(choice);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), {
    queries: ['龙族 江南 ', '龙族 ', '龙族 电子书 阅读平台 正版'],
  });
  assert.doesNotMatch(serialized, /end▁of▁think|begin▁of▁output|end▁of▁output|<\/?tool_calls>/u);
});

test('native reasoning makes plain provider content an already-separated body', () => {
  const transformed = transformToolCallJson({
    choices: [{ message: { role: 'assistant', reasoning_content: 'native plan', content: 'plain answer' }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  assert.equal(transformed.choices[0].message.reasoning_content, 'native plan');
  assert.equal(transformed.choices[0].message.content, 'plain answer');
});

test('empty provider content falls back to the final tagged output inside reasoning', () => {
  const reasoning = '先规划\n' + END_MARKER + '\n' + OUTPUT_OPEN +
    '<content>从思维链迁移的正文</content>' + OUTPUT_CLOSE;
  const direct = extractTaggedOutputFallback(reasoning);
  assert.equal(direct.matched, true);
  assert.equal(direct.content, '<content>从思维链迁移的正文</content>');
  const transformed = transformToolCallJson({
    choices: [{ message: { role: 'assistant', reasoning_content: reasoning, content: '' }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  const message = transformed.choices[0].message;
  assert.equal(message.content, '<content>从思维链迁移的正文</content>');
  assert.match(message.reasoning_content, /先规划/u);
  assert.doesNotMatch(JSON.stringify(message), /end▁of▁think|begin▁of▁output|end▁of▁output/u);
});

test('reasoning fallback output can become a standard tool call', () => {
  const wrapped = TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: {
      role: 'assistant',
      reasoning_content: '需要工具' + OUTPUT_OPEN + wrapped + OUTPUT_CLOSE,
      content: null,
    }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  const choice = transformed.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
  assert.doesNotMatch(JSON.stringify(choice), /begin▁of▁output|end▁of▁output|<\/?tool_calls>/u);
});

test('tool calls are captured from reasoning even when normal body content exists', () => {
  const wrapped = TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: {
      role: 'assistant',
      reasoning_content: '先检查天气\n' + wrapped,
      content: '这段正文由接口单独返回',
    }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  const choice = transformed.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, '这段正文由接口单独返回');
  assert.equal(choice.message.reasoning_content.trim(), '先检查天气');
  assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
});

test('mirrored tool calls in reasoning and content are deduplicated', () => {
  const wrapped = TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: {
      role: 'assistant',
      reasoning_content: '思考\n' + wrapped,
      content: wrapped,
    }, finish_reason: 'stop' }],
  }, { extractOutput: true });
  assert.equal(transformed.choices[0].message.tool_calls.length, 1);
});

test('reasoning tool calls are captured even when output extraction is disabled', () => {
  const wrapped = TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const transformed = transformToolCallJson({
    choices: [{ message: {
      role: 'assistant',
      reasoning_content: '独立工具处理\n' + wrapped,
      content: null,
    }, finish_reason: 'stop' }],
  }, {});
  const choice = transformed.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.reasoning_content.trim(), '独立工具处理');
  assert.equal(choice.message.tool_calls[0].function.name, 'lookup_weather');
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

test('SSE extraction handles an inline tool_calls wrapper and never leaks special tokens', async () => {
  const webInvoke = '<｜｜DSML｜｜ invoke name="web_search"><｜｜DSML｜｜ parameter name="queries" string="false">' +
    '["龙族 江南 ","龙族 "]</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
  const source = END_MARKER + ' ' + OUTPUT_OPEN + ' ' + TOOL_CALLS_OPEN + webInvoke +
    TOOL_CALLS_CLOSE + OUTPUT_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const frames = [];
  for (let index = 0; index < source.length; index += 3) {
    frames.push(sse({ id: 'wrapped', choices: [{
      index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: source.slice(index, index + 3) },
      finish_reason: null,
    }] }));
  }
  frames.push(sse({ id: 'wrapped', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]'));
  const encoder = new TextEncoder();
  const transformed = await transformToolCallResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frames.join(''))); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }), { extractOutput: true });
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse).flatMap(chunk => chunk.choices ?? []);
  const serialized = JSON.stringify(choices);
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));
  assert.equal(choices.map(choice => choice.delta?.content ?? '').join('').trim(), '');
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(toolChoice.delta.tool_calls[0].function.arguments), { queries: ['龙族 江南 ', '龙族 '] });
  assert.doesNotMatch(serialized, /end▁of▁think|begin▁of▁output|end▁of▁output|<\/?tool_calls>/u);
});

test('SSE waits for choice completion before moving tagged reasoning output into content', async () => {
  const reasoning = '流式思考' + END_MARKER + OUTPUT_OPEN + '<content>结束时提取</content>' + OUTPUT_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const frames = [];
  for (let index = 0; index < reasoning.length; index += 4) {
    frames.push(sse({ id: 'reasoning-fallback', choices: [{
      index: 0,
      delta: { ...(index === 0 ? { role: 'assistant' } : {}), reasoning_content: reasoning.slice(index, index + 4) },
      finish_reason: null,
    }] }));
  }
  frames.push(sse({ id: 'reasoning-fallback', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]'));
  const encoder = new TextEncoder();
  const transformed = await transformToolCallResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frames.join(''))); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }), { extractOutput: true });
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse).flatMap(chunk => chunk.choices ?? []);
  const reasoningText = choices.map(choice => choice.delta?.reasoning_content ?? '').join('');
  const content = choices.map(choice => choice.delta?.content ?? '').join('');
  const finalIndex = choices.findIndex(choice => choice.finish_reason != null);
  assert.match(reasoningText, /流式思考/u);
  assert.equal(content, '<content>结束时提取</content>');
  assert.equal(choices.slice(0, finalIndex).some(choice => typeof choice.delta?.reasoning_content === 'string'), true);
  assert.equal(choices.slice(0, finalIndex).some(choice => typeof choice.delta?.content === 'string'), false);
  assert.equal(choices[finalIndex].delta.content, '<content>结束时提取</content>');
  assert.doesNotMatch(content, /end▁of▁think|begin▁of▁output|end▁of▁output/u);
  assert.equal(payloads.at(-1), '[DONE]');
});

test('SSE captures a tool call from reasoning while preserving separately streamed body content', async () => {
  const wrapped = '流式思考\n' + TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const frames = [];
  for (let index = 0; index < wrapped.length; index += 5) {
    frames.push(sse({ id: 'reasoning-tool', choices: [{
      index: 0,
      delta: { ...(index === 0 ? { role: 'assistant' } : {}), reasoning_content: wrapped.slice(index, index + 5) },
      finish_reason: null,
    }] }));
  }
  frames.push(
    sse({ id: 'reasoning-tool', choices: [{ index: 0, delta: { content: '正文仍然保留' }, finish_reason: null }] }),
    sse({ id: 'reasoning-tool', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse('[DONE]'),
  );
  const encoder = new TextEncoder();
  const transformed = await transformToolCallResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frames.join(''))); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }), { extractOutput: true });
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse).flatMap(chunk => chunk.choices ?? []);
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));
  assert.equal(choices.map(choice => choice.delta?.content ?? '').join(''), '正文仍然保留');
  assert.match(choices.map(choice => choice.delta?.reasoning_content ?? '').join(''), /流式思考/u);
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'lookup_weather');
});

test('SSE reasoning tool capture also works without output extraction', async () => {
  const wrapped = '独立流式工具处理\n' + TOOL_CALLS_OPEN + invoke + TOOL_CALLS_CLOSE;
  const sse = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const frames = [];
  for (let index = 0; index < wrapped.length; index += 2) {
    frames.push(sse({ id: 'reasoning-tool-only', choices: [{
      index: 0,
      delta: { ...(index === 0 ? { role: 'assistant' } : {}), reasoning_content: wrapped.slice(index, index + 2) },
      finish_reason: null,
    }] }));
  }
  frames.push(sse({ id: 'reasoning-tool-only', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]'));
  const encoder = new TextEncoder();
  const transformed = await transformToolCallResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frames.join(''))); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }), {});
  const payloads = (await transformed.text()).split(/\n\n/u).filter(Boolean).map(event => event.replace(/^data: /u, ''));
  const choices = payloads.filter(payload => payload !== '[DONE]').map(JSON.parse).flatMap(chunk => chunk.choices ?? []);
  const toolChoice = choices.find(choice => Array.isArray(choice.delta?.tool_calls));
  assert.equal(choices.map(choice => choice.delta?.reasoning_content ?? '').join('').trim(), '独立流式工具处理');
  assert.equal(toolChoice.finish_reason, 'tool_calls');
  assert.equal(toolChoice.delta.tool_calls[0].function.name, 'lookup_weather');
});
