import test from 'node:test';
import assert from 'node:assert/strict';
import { DSML_CALLS_CLOSE, DSML_CALLS_OPEN } from '../lib/toolcall-prefill.mjs';
import {
  STREAM_MARKERS,
  auditTurnTools,
  createMarkerStreamScanner,
  scanTextStream,
} from '../scripts/preset-stability-stream.mjs';
import { END_MARKER, VIRTUAL_TOOLS } from '../scripts/preset-stability-core.mjs';

const TOOL_NAMES = VIRTUAL_TOOLS.map(tool => tool.function.name);
// 从仓库常量反解出 DSML 分隔符，避免测试里硬编码特殊 token。
const D = DSML_CALLS_OPEN.slice(1, DSML_CALLS_OPEN.length - 7);
const OPEN = DSML_CALLS_OPEN;
const CLOSE = DSML_CALLS_CLOSE;

function invoke(name, parameters) {
  const parts = ['<' + D + ' invoke name="' + name + '">'];
  for (const entry of parameters) {
    parts.push('<' + D + ' parameter name="' + entry[0] + '" string="' + entry[1] + '">' + entry[2] + '</' + D + ' parameter>');
  }
  parts.push('</' + D + ' invoke>');
  return parts.join('\n');
}

const GOOD_BLOCK = OPEN + '\n' + invoke('get_weather', [['city', 'true', '上海']]) + '\n' + CLOSE;

test('createMarkerStreamScanner：任意切分都得到相同事件与相同切换点', () => {
  const text = '<think>思考过程……\n先查一下天气。\n' + END_MARKER + '\n<content>正文</content>';
  const baseline = scanTextStream(text, 1);
  assert.equal(baseline.complete, true, '输出必须与输入完全一致');
  for (const size of [1, 2, 3, 5, 7, 13, 40]) {
    const scan = scanTextStream(text, size);
    assert.equal(scan.output, text, '块大小 ' + size + ' 时文本无损');
    assert.deepEqual(scan.kinds, baseline.kinds, '块大小 ' + size + ' 时事件序列一致');
    assert.equal(scan.switchedAt, baseline.switchedAt, '块大小 ' + size + ' 时切换点一致');
  }
  assert.equal(baseline.switchKind, 'end-marker');
  assert.ok(baseline.switchedAt > 0, '应在思维链结束处切换');
});

test('createMarkerStreamScanner：半个标记不会提前当作正文发出', () => {
  const scanner = createMarkerStreamScanner();
  const events = scanner.push('<think>思考' + END_MARKER.slice(0, 6));
  const emitted = events.map(event => event.text).join('');
  assert.equal(emitted.includes(END_MARKER), false);
  assert.equal(scanner.switchedAt, -1, '标记不完整时不应切换');
  assert.ok(scanner.pending > 0, '不完整前缀应扣留在缓冲区');
  const rest = scanner.push(END_MARKER.slice(6));
  assert.equal(scanner.switchedAt >= 0, true, '补全后立刻切换');
  assert.equal(rest.some(event => event.kind === 'end-marker'), true);
});

test('createMarkerStreamScanner：DSML 块切换到 tool-call 相位', () => {
  const scanner = createMarkerStreamScanner();
  scanner.push('<think>先查天气。\n');
  scanner.push(END_MARKER + '\n');
  assert.equal(scanner.phase, 'body');
  scanner.push(GOOD_BLOCK);
  assert.equal(scanner.phase, 'trailing', 'calls 结束标签之后进入 trailing');
});

test('createMarkerStreamScanner：变体也能触发切换', () => {
  const scan = scanTextStream('<think>思考</think>\n<content>正文</content>', 4);
  assert.ok(scan.output.includes('</think>'));
  assert.equal(scan.kinds.includes('end-marker-variant'), true);
  assert.ok(scan.switchedAt >= 0);
});

test('auditTurnTools：规范写法没有格式问题', () => {
  const result = auditTurnTools('思考结束。\n' + END_MARKER + '\n' + GOOD_BLOCK, TOOL_NAMES);
  assert.equal(result.hasBlock, true);
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  assert.equal(result.ok, true);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'get_weather');
});

test('auditTurnTools：能抓出忘记换行 / 缺 string 标记 / 拼错工具名 / 代码围栏 / 缺结束标签', () => {
  const codes = issues => issues.map(issue => issue.code);

  const inline = '<' + D + ' invoke name="get_weather">' + '<' + D + ' parameter name="city" string="true">上海</' + D + ' parameter>' + '</' + D + ' invoke>';
  const noNewline = auditTurnTools(OPEN + '\n' + inline + '\n' + CLOSE, TOOL_NAMES);
  assert.ok(codes(noNewline.issues).includes('invoke-open-no-newline'));
  assert.ok(codes(noNewline.issues).includes('invoke-close-no-newline'));

  const flagless = '<' + D + ' invoke name="get_weather">\n<' + D + ' parameter name="city">上海</' + D + ' parameter>\n</' + D + ' invoke>';
  const noFlag = auditTurnTools(OPEN + '\n' + flagless + '\n' + CLOSE, TOOL_NAMES);
  assert.ok(codes(noFlag.issues).includes('param-string-flag-missing'));

  const wrongName = auditTurnTools(OPEN + '\n' + invoke('tool_name', [['city', 'true', '上海']]) + '\n' + CLOSE, TOOL_NAMES);
  assert.ok(codes(wrongName.issues).includes('unknown-tool'));

  const fence = String.fromCharCode(96).repeat(3);
  const fenced = auditTurnTools(fence + '\n' + GOOD_BLOCK + '\n' + fence, TOOL_NAMES);
  assert.ok(codes(fenced.issues).includes('code-fence'));

  const noEnd = auditTurnTools(OPEN + '\n' + invoke('get_weather', [['city', 'true', '上海']]), TOOL_NAMES);
  assert.ok(codes(noEnd.issues).includes('missing-end'));
});

test('auditTurnTools：没有 DSML 块时不报错', () => {
  const result = auditTurnTools('直接写正文，没有工具调用。', TOOL_NAMES);
  assert.equal(result.hasBlock, false);
  assert.deepEqual(result.issues, []);
});

test('STREAM_MARKERS 覆盖规范标记与常见变体', () => {
  const texts = STREAM_MARKERS.map(marker => marker.text);
  assert.ok(texts.includes(END_MARKER), '应包含规范结束标记');
  assert.ok(texts.includes('</think>'), '应包含 </think> 变体');
  assert.ok(texts.includes('<think>'), '应包含进入思维链标记');
});
