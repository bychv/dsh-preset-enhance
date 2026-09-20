import test from 'node:test';
import assert from 'node:assert/strict';
import { DSML_CALLS_CLOSE, DSML_CALLS_OPEN, parseToolCallsFromText } from '../lib/toolcall-prefill.mjs';
import { ANCHOR_SENTENCE, END_MARKER, OUTPUT_CLOSE, OUTPUT_OPEN } from '../scripts/preset-stability-core.mjs';
import {
  compareStrategies,
  createStrategyScanner,
  findStandaloneMarker,
  lookaheadCharsFor,
  scanWithStrategy,
  stripControlTags,
} from '../scripts/preset-stability-strategy.mjs';

const PREFILL = '<think>好的，现在我将开始';
const BODY = '正文内容重复填充以凑满字数。'.repeat(10);
const MARK = END_MARKER;

test('lookaheadCharsFor：10 token 默认折成 20 字符', () => {
  assert.equal(lookaheadCharsFor({}), 20);
  assert.equal(lookaheadCharsFor({ bufferTokens: 10, charsPerToken: 3 }), 30);
});

test('findStandaloneMarker：行内复述不算，独占一行才算', () => {
  const inline = PREFILL + '\n必须以 ' + MARK + ' 结束思考\n继续思考';
  assert.equal(findStandaloneMarker(inline, false), null);
  const standalone = PREFILL + '\n思考完毕\n' + MARK + '\n<content>x</content>';
  const found = findStandaloneMarker(standalone, false);
  assert.ok(found, '独占一行应被识别');
  assert.equal(standalone.slice(found.markerIndex, found.markerEnd), MARK);
});

test('策略：独立成行的复述会被 10 token 窗口排除', () => {
  const text = PREFILL + '\n格式要求如下：\n' + MARK + '\n标记要独占一行，前后都是换行。\n工具结果已经拿到，现在写正文。\n'
    + MARK + '\n<content>' + BODY + '</content>';
  const scan = scanWithStrategy(text, 3);
  assert.equal(scan.restatements, 1, '应排除 1 次复述');
  assert.equal(scan.switchMode, 'confirmed:content');
  assert.equal(scan.complete, true, '文本必须无损');
});

test('策略：没有规范标记时用 </think> 保底切换', () => {
  const text = PREFILL + '\n想好了。\n</think>\n<content>' + BODY + '</content>';
  const scan = scanWithStrategy(text, 4);
  assert.equal(scan.fallbackUsed, true, '应走 </think> 保底');
  assert.equal(scan.switchMode, 'fallback:close-think');
  assert.equal(scan.complete, true);
  assert.equal(compareStrategies(text).strategy.miss, false);
});

test('策略：10 token 窗口没攒够时不提前切换', () => {
  const scanner = createStrategyScanner();
  scanner.push(PREFILL + '\n思考完。\n' + MARK + '\n<cont');
  assert.equal(scanner.switchedAt, -1, '窗口不足时不应切换');
  const events = scanner.push('ent>' + BODY + '</content>');
  assert.ok(scanner.switchedAt >= 0, '补全后确认切换');
  assert.ok(events.some(event => event.kind === 'end-marker' && event.mode === 'confirmed'));
  assert.equal(scanner.push('').length >= 0, true);
});

test('策略：任意切分结果一致且文本无损', () => {
  const text = PREFILL + '\n先复述：必须以 ' + MARK + ' 结束思考\n然后结束\n' + MARK + '\n<content>' + BODY + '</content>';
  const baseline = scanWithStrategy(text, 1);
  for (const size of [1, 2, 3, 5, 8, 13, 40]) {
    const scan = scanWithStrategy(text, size);
    assert.equal(scan.complete, true, '块 ' + size + ' 文本无损');
    assert.equal(scan.switchedAt, baseline.switchedAt, '块 ' + size + ' 切换点一致');
    assert.equal(scan.restatements, baseline.restatements, '块 ' + size + ' 复述计数一致');
    const signals = value => value.events
      .filter(event => event.kind === 'end-marker' || event.kind === 'restatement')
      .map(event => event.kind + ':' + (event.mode || ''));
    assert.deepEqual(signals(scan), signals(baseline), '块 ' + size + ' 信号序列一致');
  }
});

test('策略：工具调用轮由 DSML 开场标签确认切换', () => {
  const text = PREFILL + '\n先查天气。\n' + MARK + '\n' + DSML_CALLS_OPEN + '\n...\n' + DSML_CALLS_CLOSE;
  const scan = scanWithStrategy(text, 3);
  assert.equal(scan.switchMode, 'confirmed:tool-call');
});

test('兜底开关：contentFallback 能在完全没有结束信号时切换', () => {
  const text = PREFILL + '\n想好了直接写。\n<content>' + BODY + '</content>';
  assert.equal(scanWithStrategy(text, 3, { contentFallback: false }).switchedAt, -1);
  assert.ok(scanWithStrategy(text, 3, { contentFallback: true }).switchedAt >= 0);
});

test('compareStrategies：策略切换点紧贴正文，旧做法会漏思考', () => {
  const text = PREFILL + '\n格式要求：\n' + MARK + '\n标记独占一行。\n数据齐了，开始写。\n' + MARK + '\n<content>' + BODY + '</content>';
  const compare = compareStrategies(text);
  assert.equal(compare.strategy.miss, false);
  assert.ok(compare.strategy.leak <= MARK.length + 2, '策略 leak=' + compare.strategy.leak);
  assert.ok(compare.firstMatch.leak > 30, '旧做法 leak=' + compare.firstMatch.leak);
});
test('策略 C：</think> 后面还在思考时不会被当成结束', () => {
  const text = PREFILL + '\n思考一。</think>\n又想了想很久，先看工具结果。\n然后根据结果写文章。\n<content>' + BODY + '</content>';
  const gated = scanWithStrategy(text, 3, { gateCloseThink: true, contentTrigger: true });
  assert.equal(gated.switchedAt, text.indexOf('<content>'), '应停在正文开始处');
  assert.equal(gated.switchMode, 'trigger:content');
  assert.ok(gated.heldCandidates >= 1, '早到的 </think> 应被窗口挡下');
  const ungated = scanWithStrategy(text, 3, {});
  assert.equal(ungated.switchMode, 'fallback:close-think', '不加窗口的保底会提前切');
  assert.ok(ungated.switchedAt < text.indexOf('<content>'), '提前切会漏思考');
});

test('策略 C：</think> 后紧跟工具调用时仍然立即切换', () => {
  const text = PREFILL + '\n想好了。</think>\n' + DSML_CALLS_OPEN + '\n...\n' + DSML_CALLS_CLOSE;
  const scan = scanWithStrategy(text, 3, { gateCloseThink: true, contentTrigger: true });
  assert.equal(scan.switchMode, 'fallback:close-think');
  assert.equal(scan.switchedAt, text.indexOf('</think>'));
});
test('输出区标签：标记后紧跟 <output> 时由标记确认切换', () => {
  const text = PREFILL + '\n思考完毕。\n' + MARK + '\n' + OUTPUT_OPEN + '\n<content>' + BODY + '</content>\n' + OUTPUT_CLOSE;
  const scan = scanWithStrategy(text, 3);
  assert.equal(scan.switchMode, 'confirmed:output');
  assert.equal(scan.switchedAt, text.indexOf(MARK));
});

test('输出区标签：标记缺失时 <content> 之前的前置输出不会被当成思维链', () => {
  const text = PREFILL + '\n思考完毕。\n' + OUTPUT_OPEN + '\n【前置说明】这段是正文之外的输出。\n<content>' + BODY
    + '</content>\n【后置格式】\n' + OUTPUT_CLOSE;
  const withOutput = scanWithStrategy(text, 3, { outputTrigger: true, contentTrigger: false });
  assert.equal(withOutput.switchMode, 'trigger:output');
  assert.equal(withOutput.switchedAt, text.indexOf(OUTPUT_OPEN));
  const thinking = withOutput.events.filter(event => event.kind === 'thinking')
    .map(event => event.text).join('');
  assert.equal(thinking.includes('【前置说明】'), false, '前置输出不应被当成思维链');
  assert.equal(thinking.includes(OUTPUT_OPEN), false, '输出区标签本身也不该算思维链');
  assert.equal(withOutput.complete, true, '文本无损');

  const contentOnly = scanWithStrategy(text, 3, { contentTrigger: true, outputTrigger: false });
  assert.equal(contentOnly.switchMode, 'trigger:content');
  const swallowed = contentOnly.events.filter(event => event.kind === 'thinking')
    .map(event => event.text).join('');
  assert.equal(swallowed.includes('【前置说明】'), true, '只看 <content> 会把前置输出吞成思维链');
});

test('输出区标签：完全没有输出区标签时不会误切', () => {
  const text = PREFILL + '\n想好了直接写。\n<content>' + BODY + '</content>';
  const strict = scanWithStrategy(text, 3, { outputTrigger: true, contentTrigger: false });
  assert.equal(strict.switchedAt, -1, '没有输出区标签就不该切换');
  assert.equal(compareStrategies(text) === null, false);
});
test('控制标签：在缓冲区里被扣掉，不进输出流程', () => {
  const text = PREFILL + '\n思考完毕。\n' + OUTPUT_OPEN + '\n<content>' + BODY + '</content>\n' + OUTPUT_CLOSE;
  const scan = scanWithStrategy(text, 3, { outputTrigger: true });
  assert.equal(scan.stripped, 2, '开闭标签都被扣掉');
  assert.equal(scan.clean, true, '输出里不再含控制标签');
  assert.equal(scan.output.includes(OUTPUT_OPEN), false);
  assert.equal(scan.output.includes(OUTPUT_CLOSE), false);
  assert.equal(scan.output, stripControlTags(text));
  assert.equal(scan.complete, true);
  assert.equal(scan.switchedAt, text.indexOf(OUTPUT_OPEN));
});

test('控制标签：剥离后 DSML 工具调用块仍然完整可解析', () => {
  const D = DSML_CALLS_OPEN.slice(1, DSML_CALLS_OPEN.length - 7);
  const param = '<' + D + ' parameter name="city" string="true">上海</' + D + ' parameter>';
  const invoke = '<' + D + ' invoke name="get_weather">\n' + param + '\n</' + D + ' invoke>';
  const block = DSML_CALLS_OPEN + '\n' + invoke + '\n' + DSML_CALLS_CLOSE;
  const text = PREFILL + '\n先查天气。\n' + MARK + '\n' + OUTPUT_OPEN + '\n' + block + '\n' + OUTPUT_CLOSE;
  const scan = scanWithStrategy(text, 3);
  assert.equal(scan.clean, true);
  assert.equal(scan.output.includes(DSML_CALLS_OPEN), true, '工具调用块必须完整保留');
  const parsed = parseToolCallsFromText(scan.output);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
});

test('滑动窗口缓冲区：长输出下待处理量有上界', () => {
  const long = '很长的正文内容。'.repeat(300);
  const text = PREFILL + '\n思考完毕。\n' + MARK + '\n' + OUTPUT_OPEN + '\n<content>' + long + '</content>\n' + OUTPUT_CLOSE;
  const scan = scanWithStrategy(text, 7);
  assert.equal(scan.complete, true);
  assert.ok(scan.maxPending < 200, '缓冲区不应随输出增长，实际 ' + scan.maxPending);
  const tiny = scanWithStrategy(text, 1);
  assert.ok(tiny.maxPending < 200, '逐字喂入也应有界，实际 ' + tiny.maxPending);
  assert.equal(tiny.output, scan.output, '任意切分输出一致');
});
test('滑动窗口：控制标签在任意位置被切开都不会漏出半截', () => {
  const head = '前置文本。'.repeat(6);
  const text = head + OUTPUT_OPEN + '<content>' + BODY + '</content>' + OUTPUT_CLOSE;
  const tagAt = head.length;
  for (let cut = 1; cut < OUTPUT_OPEN.length; cut += 1) {
    const scanner = createStrategyScanner();
    const events = scanner.push(text.slice(0, tagAt + cut));
    const rest = scanner.push(text.slice(tagAt + cut));
    const finished = scanner.finish();
    const output = events.concat(rest, finished)
      .filter(event => event.kind !== 'output-open' && event.kind !== 'output-close' && event.kind !== 'restatement')
      .map(event => event.text).join('');
    assert.equal(output.includes('<｜begin'), false, '切开位置 ' + cut + ' 漏出了半截标签');
    assert.equal(output.includes('▁of▁output'), false, '切开位置 ' + cut + ' 漏出了标签片段');
  }
});

test('滑动窗口：bufferChars 可配置且待处理量不超过它加上窗口', () => {
  const text = PREFILL + '\n思考完毕。\n' + MARK + '\n' + OUTPUT_OPEN + '\n<content>' + BODY + '</content>\n' + OUTPUT_CLOSE;
  for (const bufferChars of [16, 32, 64]) {
    const scan = scanWithStrategy(text, 5, { bufferChars });
    assert.equal(scan.complete, true, 'bufferChars=' + bufferChars + ' 应无损');
    assert.ok(scan.maxPending <= bufferChars + 64, 'bufferChars=' + bufferChars + ' 待处理量 ' + scan.maxPending);
  }
  const wide = scanWithStrategy(text, 3, { bufferChars: 64 });
  const narrow = scanWithStrategy(text, 3, { bufferChars: 16 });
  assert.equal(wide.output, narrow.output, 'bufferChars 不影响输出内容');
});
test('锚点默认只做窗口确认，不当触发点（防复述）', () => {
  const text = PREFILL + '\n格式要求：必须以"' + ANCHOR_SENTENCE + '"开始。\n继续思考……\n'
    + MARK + '\n' + OUTPUT_OPEN + '\n<content>' + BODY + '</content>' + OUTPUT_CLOSE;
  const byDefault = scanWithStrategy(text, 3, { outputTrigger: true });
  assert.equal(byDefault.switchMode.indexOf('anchor') >= 0, false, '默认不该被复述的锚点触发');
  assert.equal(byDefault.switchMode, 'confirmed:output', '应由标记经窗口确认后切换');
  assert.equal(byDefault.switchedAt, text.indexOf(MARK), '切换点落在标记处，比输出标签还早');
  const explicit = scanWithStrategy(text, 3, { outputTrigger: true, anchorTrigger: true, anchorLineStart: false });
  assert.equal(explicit.switchMode, 'trigger:anchor', '显式开启 anchorTrigger 才会被触发');
  assert.ok(explicit.switchedAt < text.indexOf(OUTPUT_OPEN), '复述会让它过早切换');
});

test('行首判定跨缓冲区边界仍然正确', () => {
  const head = '前文结束。\n';
  const text = PREFILL + '\n' + head + MARK + '\n<content>' + BODY + '</content>';
  for (const chunkSize of [1, 2, 3, 7]) {
    const scan = scanWithStrategy(text, chunkSize, { outputTrigger: false, contentTrigger: true });
    assert.equal(scan.switchMode, 'confirmed:content', '块 ' + chunkSize + ' 应识别独占一行的标记');
    assert.equal(scan.switchedAt, text.indexOf(MARK));
  }
});
