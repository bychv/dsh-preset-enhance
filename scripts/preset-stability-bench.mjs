/**
 * 流式扫描器吞吐基准。
 *
 *   node scripts/preset-stability-bench.mjs [轮数]
 *
 * 对比两条路径：
 *   strategy  策略扫描器（独占一行 + 滑动窗口 + 控制标签剥离），客户端实际使用的热路径
 *   stream    旧的事件扫描器（createMarkerStreamScanner），作为参照
 * 切分粒度覆盖 1 / 3 / 10 / 50 字符，模拟不同 tokenizer 的输出节奏。
 */
import { performance } from 'node:perf_hooks';
import { DSML_CALLS_CLOSE, DSML_CALLS_OPEN } from '../lib/toolcall-prefill.mjs';
import { END_MARKER, OUTPUT_CLOSE, OUTPUT_OPEN } from './preset-stability-core.mjs';
import { createStrategyScanner } from './preset-stability-strategy.mjs';
import { createMarkerStreamScanner } from './preset-stability-stream.mjs';

const THINKING = ('需要先看工具返回的数据，再决定正文的写法。' + '不能编造数据。').repeat(12);
const BODY = '正文内容重复填充以凑满字数。'.repeat(80);
const D = DSML_CALLS_OPEN.slice(1, DSML_CALLS_OPEN.length - 7);
const INVOKE = '<' + D + ' invoke name="get_weather">' + String.fromCharCode(10)
  + '<' + D + ' parameter name="city" string="true">上海</' + D + ' parameter>' + String.fromCharCode(10)
  + '</' + D + ' invoke>';
const TOOL_BLOCK = DSML_CALLS_OPEN + String.fromCharCode(10) + INVOKE + String.fromCharCode(10) + DSML_CALLS_CLOSE;

const BODY_TURN = '<think>' + THINKING + String.fromCharCode(10) + END_MARKER + String.fromCharCode(10)
  + OUTPUT_OPEN + String.fromCharCode(10) + '<content>' + BODY + '</content>' + String.fromCharCode(10) + OUTPUT_CLOSE;
const TOOL_TURN = '<think>' + THINKING + String.fromCharCode(10) + END_MARKER + String.fromCharCode(10)
  + OUTPUT_OPEN + String.fromCharCode(10) + TOOL_BLOCK + String.fromCharCode(10) + OUTPUT_CLOSE;

function bench(name, factory, text, chunkSize, rounds) {
  let events = 0;
  // 预热
  for (let r = 0; r < Math.max(1, Math.floor(rounds / 10)); r += 1) {
    const scanner = factory();
    for (let at = 0; at < text.length; at += chunkSize) events += scanner.push(text.slice(at, at + chunkSize)).length;
    events += scanner.finish().length;
  }
  const started = performance.now();
  for (let r = 0; r < rounds; r += 1) {
    const scanner = factory();
    for (let at = 0; at < text.length; at += chunkSize) events += scanner.push(text.slice(at, at + chunkSize)).length;
    events += scanner.finish().length;
  }
  const ms = performance.now() - started;
  const pushes = Math.ceil(text.length / chunkSize) * rounds;
  return {
    name,
    chunkSize,
    chars: text.length,
    rounds,
    ms,
    usPerPush: (ms * 1000) / pushes,
    pushesPerSec: pushes / (ms / 1000),
    charsPerSec: (text.length * rounds) / (ms / 1000),
    events,
  };
}

function format(row) {
  return row.name.padEnd(28)
    + ' 块=' + String(row.chunkSize).padStart(3)
    + '  文本=' + String(row.chars).padStart(5) + ' 字'
    + '  ' + row.usPerPush.toFixed(2).padStart(6) + ' µs/push'
    + '  ' + Math.round(row.pushesPerSec).toLocaleString('en-US').padStart(12) + ' push/s'
    + '  ' + Math.round(row.charsPerSec).toLocaleString('en-US').padStart(12) + ' 字/s';
}

const rounds = Math.max(1, Number(process.argv[2] || 300));
const rows = [];
for (const text of [{ label: '正文轮', value: BODY_TURN }, { label: '工具轮', value: TOOL_TURN }]) {
  for (const chunkSize of [1, 3, 10, 50]) {
    rows.push(bench('strategy ' + text.label, () => createStrategyScanner({ gateCloseThink: true, outputTrigger: true }), text.value, chunkSize, rounds));
    rows.push(bench('stream   ' + text.label, () => createMarkerStreamScanner(), text.value, chunkSize, rounds));
  }
}

console.log('流式扫描基准（每行 ' + rounds + ' 轮）');
console.log('-'.repeat(118));
for (const row of rows) console.log(format(row));
console.log('-'.repeat(118));

// 缓冲区上界：验证滑窗不会随输出增长
const scanner = createStrategyScanner({ gateCloseThink: true, outputTrigger: true });
for (let at = 0; at < BODY_TURN.length; at += 3) scanner.push(BODY_TURN.slice(at, at + 3));
scanner.finish();
console.log('滑动窗口：最大待处理 ' + scanner.maxPending + ' 字符（文本 ' + BODY_TURN.length + ' 字符），剥离控制标签 ' + scanner.stripped + ' 个');
