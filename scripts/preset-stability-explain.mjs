/**
 * 解释器：把某个 transcript 的每一轮原始输出喂给当前策略，打印结构化处理结果。
 *
 *   node scripts/preset-stability-explain.mjs <transcript.json> [--summary] [--turn t1r2] [--limit 3]
 *
 * 关注三类判定：
 *   及时切换   switchedAt <= 输出区起点  —— 没有任何输出被误判成思维链
 *   切换偏晚   switchedAt >  输出区起点  —— 输出区起点到切换点之间的文字被当成思维链
 *   漏切       switchedAt < 0            —— 完全没切换
 */
import { readFileSync } from 'node:fs';
import { DSML_CALLS_OPEN } from '../lib/toolcall-prefill.mjs';
import {
  CONTENT_OPEN, LEGACY_OUTPUT_OPEN, OUTPUT_OPEN, OUTPUT_CLOSE, segmentTurn, END_MARKER, LEGACY_END_MARKER,
} from './preset-stability-core.mjs';
import { scanWithStrategy } from './preset-stability-strategy.mjs';

const args = process.argv.slice(2);
const file = args.find(value => !value.startsWith('--')) || '.stability-scratch/reports/flash20-buffer/transcript.json';
const wantSummary = args.includes('--summary');
const turnFilter = args.includes('--turn') ? args[args.indexOf('--turn') + 1] : null;
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 3;
const data = JSON.parse(readFileSync(file, 'utf8'));

function short(text, maxLength) {
  const value = String(text || '').replace(/\s+/gu, ' ');
  return value.length > maxLength ? value.slice(0, maxLength) + '…' : value;
}

function analyze(record, label) {
  const prefill = (record.requestBody.messages.at(-1) || {}).content || '';
  const raw = (record.responseBody.choices && record.responseBody.choices[0].message.content) || '';
  const text = prefill + raw;
  const toolCalls = (record.toolCallNames || []).length > 0
    ? record.toolCallNames.map((name, index) => ({ id: 'c' + index, type: 'function', function: { name, arguments: '{}' } }))
    : null;
  const scan = scanWithStrategy(text, 3, { gateCloseThink: true, outputTrigger: true });
  const seg = segmentTurn({ content: text, tool_calls: toolCalls });
  const regionTokens = [OUTPUT_OPEN, LEGACY_OUTPUT_OPEN, CONTENT_OPEN, DSML_CALLS_OPEN];
  const found = regionTokens.map(token => text.indexOf(token)).filter(index => index >= 0);
  const regionStart = found.length > 0 ? Math.min.apply(null, found) : -1;
  const exitSignals = [END_MARKER, LEGACY_END_MARKER, '</think>', '</thinking>']
    .map(token => text.indexOf(token)).filter(index => index >= 0);
  const lastExitBeforeRegion = exitSignals.filter(index => regionStart < 0 || index < regionStart).sort((a, b) => a - b).pop();
  let verdict = '漏切';
  if (scan.switchedAt >= 0) {
    if (scan.switchedAt > regionStart && regionStart >= 0) verdict = '切换偏晚';
    else if (lastExitBeforeRegion !== undefined && scan.switchedAt < lastExitBeforeRegion) verdict = '过早切换';
    else verdict = '及时切换';
  }
  return { label, text, scan, seg, regionStart, verdict };
}

const rows = [];
for (const trial of data.trials) {
  for (const record of trial.records) {
    const label = 't' + (trial.index + 1) + 'r' + record.turn;
    if (turnFilter && turnFilter !== label) continue;
    rows.push(analyze(record, label));
  }
}

if (wantSummary || !turnFilter) {
  const counts = new Map();
  let stripped = 0, clean = 0, complete = 0;
  for (const row of rows) {
    counts.set(row.verdict, (counts.get(row.verdict) || 0) + 1);
    stripped += row.scan.stripped;
    if (row.scan.clean) clean += 1;
    if (row.scan.complete) complete += 1;
  }
  console.log('文件: ' + file);
  console.log('轮数 ' + rows.length + '：' + Array.from(counts.entries()).map(entry => entry[0] + ' ' + entry[1]).join('  '));
  console.log('控制标签剥离 ' + stripped + ' 个；输出不含控制标签 ' + clean + '/' + rows.length + '；剥离后无损 ' + complete + '/' + rows.length);
  const modes = new Map();
  for (const row of rows) modes.set(row.scan.switchMode || 'none', (modes.get(row.scan.switchMode || 'none') || 0) + 1);
  console.log('切换来源: ' + Array.from(modes.entries()).sort((a, b) => b[1] - a[1]).map(entry => entry[0] + ' ×' + entry[1]).join('，'));
  console.log('');
}

const showcase = turnFilter ? rows : rows.filter(row => row.scan.switchedAt >= 0).slice(0, limitArg);
for (const row of showcase) {
  const seg = row.seg;
  console.log('==== ' + row.label + '  [' + row.verdict + ']');
  console.log('  切换: ' + row.scan.switchMode + ' @ 偏移 ' + row.scan.switchedAt + '（输出区起点 ' + row.regionStart + '）');
  console.log('  思维链: ' + seg.thinkingChars + ' 字  「' + short(seg.thinkingText, 80) + '」');
  console.log('  控制标签: 开场 ' + (seg.outputOpen >= 0 ? '有（已剥离）' : '无') + '，已剥离 ' + row.scan.stripped + ' 个');
  console.log('  输出区: ' + seg.outputChars + ' 字');
  console.log('  正文块: ' + seg.bodies.length + ' 个' + (seg.bodies.length ? '，主块 ' + seg.bodies[0].chars + ' 字' : ''));
  if (seg.bodies.length) {
    const start = seg.bodies[0].open + CONTENT_OPEN.length;
    console.log('  正文开头: 「' + short(row.text.slice(start, start + 60), 60) + '」');
  }
  console.log('  正文之外: ' + seg.extras.replace(/\s+/gu, '').length + ' 字');
  console.log('  工具调用: ' + (seg.toolCalls.length ? seg.toolCalls.map(call => call.name).join(',') : '无'));
  console.log('');
}
