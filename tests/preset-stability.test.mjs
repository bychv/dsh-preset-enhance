import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END_MARKER,
  VIRTUAL_TOOLS,
  analyzeTurn,
  buildWireRequest,
  createSyntheticPreset,
  normalizeResponse,
  runTrials,
  segmentTurn,
  summarize,
  percent,
} from '../scripts/preset-stability-core.mjs';

const D = '｜｜DSML｜｜';
const DSML_OPEN = '<' + D + ' calls>';
const DSML_CLOSE = '</' + D + ' calls>';
const INVOKE = [
  '<' + D + ' invoke name="get_weather">',
  '<' + D + ' parameter name="city" string="true">上海</' + D + ' parameter>',
  '</' + D + ' invoke>',
].join('\n');

const PREFILL = '<think>好的，现在我将开始';
const BODY = '正文内容重复填充以凑满字数。'.repeat(100);
const FULL_BODY = '<content>' + BODY + '</content>';
const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } };

function nonSpace(text) { return text.replace(/\s/gu, '').length; }

test('buildWireRequest：official + dsml 复刻仓库的前缀续写改写', () => {
  const messages = [{ role: 'user', content: '任务' }, { role: 'assistant', content: PREFILL }];
  const wire = buildWireRequest({
    messages, tools: VIRTUAL_TOOLS, transport: 'official', toolsMode: 'dsml',
    thinking: 'omit', prefixMode: 'prefix', model: 'm',
  });
  assert.equal(wire.body.stream, false);
  assert.equal(wire.body.tools, undefined, '官方 Beta 不接受原生工具字段');
  assert.equal(wire.body.tool_choice, undefined);
  assert.equal(wire.body.thinking, undefined);
  assert.equal(wire.body.messages.length, 3, '工具说明作为 system 注入');
  assert.equal(wire.body.messages[0].role, 'system');
  assert.match(wire.body.messages[0].content, /## Tools/);
  assert.match(wire.body.messages[0].content, /get_weather/);
  assert.equal(wire.body.messages[2].role, 'assistant');
  assert.equal(wire.body.messages[2].prefix, true);
  assert.equal(wire.body.messages[2].content, PREFILL);
  assert.equal(wire.contentPrefix, PREFILL);
  assert.equal(wire.reasoningPrefix, '');
  assert.equal(wire.emulated, true);
  assert.equal(messages[1].prefix, undefined, '不得修改调用方传入的消息');
});

test('buildWireRequest：thinking=enabled 时把 <think> 前缀拆进 reasoning_content', () => {
  const wire = buildWireRequest({
    messages: [{ role: 'assistant', content: PREFILL }], tools: [],
    transport: 'official', toolsMode: 'dsml', thinking: 'enabled', prefixMode: 'prefix',
  });
  const last = wire.body.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.reasoning_content, '好的，现在我将开始');
  assert.equal(last.content, '');
  assert.equal(last.prefix, true);
  assert.deepEqual(wire.body.thinking, { type: 'enabled' });
  assert.equal(wire.reasoningPrefix, '好的，现在我将开始');
  assert.equal(wire.contentPrefix, '');
});

test('buildWireRequest：adapter + native 保留原生工具字段', () => {
  const wire = buildWireRequest({
    messages: [{ role: 'assistant', content: PREFILL }], tools: VIRTUAL_TOOLS,
    transport: 'adapter', toolsMode: 'native', thinking: 'omit', prefixMode: 'prefix',
  });
  assert.equal(wire.body.tools.length, VIRTUAL_TOOLS.length);
  assert.equal(wire.body.tool_choice, 'auto');
  assert.equal(wire.emulated, false);
  assert.equal(wire.body.messages.at(-1).prefix, true);
  assert.equal(wire.contentPrefix, PREFILL, '原生工具模式同样需要拼回预填充前缀');
});

test('buildWireRequest：prefill-mode=none / plain 的行为', () => {
  const messages = [{ role: 'assistant', content: PREFILL }];
  const plain = buildWireRequest({ messages, tools: [], prefixMode: 'plain' });
  assert.equal(plain.body.messages[0].prefix, undefined);
  const none = buildWireRequest({ messages, tools: [], prefixMode: 'none' });
  assert.equal(none.body.messages.length, 1);
});

test('normalizeResponse：DSML 文本还原为标准工具调用并补回前缀', () => {
  const wire = buildWireRequest({
    messages: [{ role: 'assistant', content: PREFILL }], tools: VIRTUAL_TOOLS,
    transport: 'official', toolsMode: 'dsml', prefixMode: 'prefix',
  });
  const data = {
    choices: [{
      index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: '继续思考\n' + END_MARKER + '\n' + DSML_OPEN + '\n' + INVOKE + '\n' + DSML_CLOSE },
    }],
  };
  const result = normalizeResponse(data, wire);
  assert.equal(result.content, PREFILL + '继续思考\n' + END_MARKER + '\n');
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { city: '上海' });
  assert.equal(result.echoed, false);
});

test('normalizeResponse：适配器回显前缀时不重复拼接', () => {
  const wire = { contentPrefix: PREFILL, reasoningPrefix: '', emulated: false };
  const data = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: PREFILL + '后续' } }] };
  const result = normalizeResponse(data, wire);
  assert.equal(result.echoed, true);
  assert.equal(result.content, PREFILL + '后续');
});

test('analyzeTurn：合规的正文轮通过', () => {
  const result = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n' + FULL_BODY }, { min: 1200, max: 1600 });
  assert.equal(result.ok, true);
  assert.equal(result.markerCount, 1);
  assert.equal(result.checks.marker_before_body.status, 'pass');
  assert.ok(result.bodyChars >= 1200 && result.bodyChars <= 1600);
  assert.equal(result.reason, '');
});

test('analyzeTurn：各类失败模式都能识别', () => {
  const missing = analyzeTurn({ content: PREFILL + '\n' + FULL_BODY }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.marker_present.status, 'fail');
  assert.match(missing.reason, /缺少规范结束标记/);

  const duplicate = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n' + END_MARKER + '\n' + FULL_BODY }, {});
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.markerCount, 2);
  assert.equal(duplicate.checks.marker_single.status, 'fail');

  const late = analyzeTurn({ content: PREFILL + '\n' + FULL_BODY + '\n' + END_MARKER }, {});
  assert.equal(late.ok, false);
  assert.equal(late.checks.marker_before_body.status, 'fail');

  const unwrapped = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n' + '一句很短的话。' }, {});
  assert.equal(unwrapped.ok, false);
  assert.equal(unwrapped.checks.content_wrapped.status, 'fail');

  const short = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n<content>字</content>' }, { min: 1200, max: 1600 });
  assert.equal(short.ok, false);
  assert.equal(short.checks.content_length.status, 'fail');

  const variant = analyzeTurn({ content: PREFILL + '\n<|end_of_thinking|>\n' + FULL_BODY }, {});
  assert.equal(variant.ok, false);
  assert.ok(variant.markerVariants.length >= 1, '应识别出标记变体');

  const closeThink = analyzeTurn({ content: PREFILL + '\n</think>\n' + FULL_BODY }, {});
  assert.equal(closeThink.ok, false);
  assert.equal(closeThink.closeThinkMarks.length, 1);
});

test('analyzeTurn：工具调用轮要求标记在调用之前出现', () => {
  const ok = analyzeTurn({ content: PREFILL + '\n' + END_MARKER, tool_calls: [TOOL_CALL] }, { toolCall: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.marker_before_tool.status, 'pass');
  assert.equal(ok.checks.content_wrapped.status, 'na');

  const bad = analyzeTurn({ content: PREFILL + '\n', tool_calls: [TOOL_CALL] }, { toolCall: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.marker_before_tool.status, 'fail');

  const earlyAnswer = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n' + FULL_BODY }, { toolCall: true });
  assert.equal(earlyAnswer.ok, true, '提前给正文不算契约失败');
  assert.equal(earlyAnswer.checks.tool_call_expected.status, 'warn');
});

test('analyzeTurn：prefill-mode=none 时才强制 <think> 开头', () => {
  const turn = { content: END_MARKER + '\n' + FULL_BODY };
  assert.equal(analyzeTurn(turn, { requireThinkOpen: true }).ok, false);
  assert.equal(analyzeTurn(turn, { requireThinkOpen: false }).checks.think_open.status, 'warn');
});

function stubModel() {
  const calls = [];
  const callModel = async context => {
    calls.push(context);
    if (context.expectToolCall) {
      return {
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '需要先查天气。\n' + END_MARKER + '\n' + DSML_OPEN + '\n' + INVOKE + '\n' + DSML_CLOSE,
          },
        }],
      };
    }
    return {
      choices: [{
        index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: '数据到手。\n' + END_MARKER + '\n' + FULL_BODY },
      }],
    };
  };
  return { callModel, calls };
}

test('runTrials：驱动工具循环、执行虚拟工具并汇总统计', async () => {
  const stub = stubModel();
  const task = { id: 'stub-task', text: '先查天气再写作。', calls: [{ name: 'get_weather', arguments: { city: '上海' } }] };
  const options = {
    trials: 1, maxTurns: 3, bodyMin: 1200, bodyMax: 1600,
    transport: 'official', toolsMode: 'dsml', thinking: 'omit', prefixMode: 'prefix',
    model: 'stub', tasks: [task], tools: VIRTUAL_TOOLS, preset: createSyntheticPreset(),
  };
  const result = await runTrials(options, stub.callModel);

  assert.equal(result.trials.length, 1);
  const records = result.trials[0].records;
  assert.equal(records.length, 2, '第一轮工具调用，第二轮正文');
  assert.equal(records[0].phase, '首轮·工具调用前');
  assert.equal(records[0].ok, true);
  assert.deepEqual(records[0].toolCallNames, ['get_weather']);
  assert.equal(records[1].phase, '工具结果后·输出正文');
  assert.equal(records[1].ok, true);

  assert.equal(stub.calls.length, 2);
  const second = stub.calls[1].wire;
  assert.equal(second.body.messages.at(-1).prefix, true, '工具结果后继续预填充续写');
  const serialized = JSON.stringify(second.body.messages);
  assert.match(serialized, /tool_execution_result/);
  assert.match(serialized, /virtual-weather-api/);
  assert.equal(serialized.includes('tool_calls'), false, 'DSML 模式下原生 tool_calls 已内联');

  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.passed, 2);
  assert.equal(result.summary.toolTurns.total, 1);
  assert.equal(result.summary.bodyTurns.total, 1);
  assert.equal(result.summary.cleanTrials, 1);
  assert.equal(result.summary.markerHistogram['1'], 2);
  assert.equal(result.summary.bodyLength.min, nonSpace(BODY));
  assert.equal(percent(1, 2), '50.0%');
});

test('runTrials：失败回合进入统计与失败明细', async () => {
  const callModel = async () => ({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '没有标记，也没有正文。' } }],
  });
  const task = { id: 'bad', text: '写正文', calls: [] };
  const options = {
    trials: 2, maxTurns: 2, bodyMin: 1200, bodyMax: 1600,
    transport: 'official', toolsMode: 'dsml', thinking: 'omit', prefixMode: 'prefix',
    model: 'stub', tasks: [task], tools: VIRTUAL_TOOLS, preset: createSyntheticPreset(),
  };
  const result = await runTrials(options, callModel);
  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.passed, 0);
  assert.equal(result.summary.passRate, 0);
  assert.equal(result.summary.cleanTrials, 0);
  assert.equal(result.summary.failedRecords.length, 2);
  assert.equal(result.summary.markerHistogram['0'], 2);
  assert.match(result.summary.failedRecords[0].reason, /缺少规范结束标记/);
  assert.ok(result.summary.outcomes.length >= 1);
});

test('segmentTurn：按 schema 提取进入思维链 / 思维链 / 结束标记 / 正文 / 工具调用', () => {
  const body = segmentTurn({ content: PREFILL + '\n思考中，先看数据。\n' + END_MARKER + '\n<content>' + BODY + '</content>' });
  assert.deepEqual(
    body.segments.map(segment => segment.kind),
    ['think-open', 'text', 'end-marker', 'text', 'body-open', 'text', 'body-close'],
  );
  assert.equal(body.enteredThinking, true);
  assert.equal(body.markers.length, 1);
  assert.equal(body.bodies.length, 1);
  assert.equal(body.bodies[0].chars, nonSpace(BODY));
  assert.match(body.thinkingText, /思考中，先看数据。/);
  assert.equal(body.thinkingText.includes(END_MARKER), false, '思维链文本不包含结束标记');

  const tool = segmentTurn({ content: PREFILL + '\n先查天气。\n' + END_MARKER, tool_calls: [TOOL_CALL] });
  assert.equal(tool.markers.length, 1);
  assert.equal(tool.toolCalls.length, 1);
  const kinds = tool.segments.map(segment => segment.kind);
  assert.equal(kinds[kinds.length - 1], 'tool-call');
  assert.equal(tool.segments[tool.segments.length - 1].name, 'get_weather');
  assert.deepEqual(tool.bodies, []);

  const variant = segmentTurn({ content: PREFILL + '\n</think>\n<content>' + BODY + '</content>' });
  assert.equal(variant.markers.length, 0);
  assert.deepEqual(variant.variants.map(item => item.text), ['</think>']);
});

test('analyzeTurn：思维链里写出空的 <content></content> 模板不会顶替真正的正文', () => {
  const turn = {
    content: PREFILL + '\n输出格式：先给结束标记，正文放在 <content></content> 里。\n'
      + '<content></content>\n' + END_MARKER + '\n<content>\n' + BODY + '\n</content>',
  };
  const result = analyzeTurn(turn, { min: 1200, max: 1600 });
  assert.ok(result.bodyBlocks >= 2, '模板提及 + 真实正文都应被提取为正文块');
  assert.equal(result.bodyChars, nonSpace(BODY), '应选中非空的真实正文块');
});

test('analyzeTurn：思维链里提到 <content> 标签不会影响正文定位', () => {
  const turn = {
    content: PREFILL + '\n思考：正文要放在<content>标签内，控制1200-1600字。\n' + END_MARKER + '\n<content>\n' + BODY + '\n</content>',
  };
  const result = analyzeTurn(turn, { min: 1200, max: 1600 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.markerRegion, 'thinking');
  assert.equal(result.bodyChars, nonSpace(BODY));
});

test('analyzeTurn：宽松口径计思维链内的标记，正文内/正文后的标记不算严格通过', () => {
  const inThinking = analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n<content>' + BODY + '</content>' }, {});
  assert.equal(inThinking.lenientOk, true);
  assert.equal(inThinking.markerRegion, 'thinking');

  const inBody = analyzeTurn({ content: PREFILL + '\n<content>' + BODY + END_MARKER + '</content>' }, {});
  assert.equal(inBody.lenientOk, true, '规范标记确实出现了');
  assert.equal(inBody.markerRegion, 'body');
  assert.equal(inBody.strictOk, false, '但它没有结束思考就写了正文');

  const afterBody = analyzeTurn({ content: PREFILL + '\n<content>' + BODY + '</content>\n' + END_MARKER }, {});
  assert.equal(afterBody.markerRegion, 'after-body');
  assert.equal(afterBody.strictOk, false);
});

test('summarize：宽松口径与标记落点分布', () => {
  const trials = [{
    index: 0,
    taskId: 't',
    records: [
      analyzeTurn({ content: PREFILL + '\n' + END_MARKER + '\n<content>' + BODY + '</content>' }, {}),
      analyzeTurn({ content: PREFILL + '\n<content>' + BODY + END_MARKER + '</content>' }, {}),
    ],
  }];
  const summary = summarize(trials);
  assert.equal(summary.lenient.total, 2);
  assert.equal(summary.lenient.pass, 2);
  assert.equal(summary.lenient.regions.thinking, 1);
  assert.equal(summary.lenient.regions.body, 1);
  assert.equal(summary.passed, 1, '严格口径只有第一轮通过');
});

test('summarize：空输入不抛异常', () => {
  const empty = summarize([]);
  assert.equal(empty.trials, 0);
  assert.equal(empty.turns, 0);
  assert.equal(empty.passRate, null);
});
