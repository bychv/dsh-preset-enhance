/**
 * 流式思维链扫描 + DSML 工具调用格式审计。
 *
 * 独立模块（只依赖本仓库 lib 与 core 的标记常量），由 CLI 注入到测试循环里：
 *   - createMarkerStreamScanner()：逐块喂入文本，命中结束标记立刻把 phase 从
 *     thinking 切到 body / tool-call，并记录切换位置；不完整的标记前缀会扣留，
 *     所以按任意切分喂入都既不会漏判、也不会把半个标记当正文发出来。
 *   - auditTurnTools()：只检查原始文本里的 DSML 写法（忘记换行、标签不严谨、
 *     string 标记缺失、被代码围栏包裹、工具名拼错等），不依赖解析结果。
 */
import { DSML_CALLS_CLOSE, DSML_CALLS_OPEN, parseToolCallsFromText } from '../lib/toolcall-prefill.mjs';
import {
  CONTENT_CLOSE, CONTENT_OPEN, END_MARKER, LEGACY_END_MARKER, OUTPUT_CLOSE, OUTPUT_OPEN, THINK_OPEN,
} from './preset-stability-core.mjs';

const BAR = String.fromCharCode(0xFF5C);
const BLOCK = String.fromCharCode(0x2581);
const BACKTICK = String.fromCharCode(96);
const CODE_FENCE = BACKTICK + BACKTICK + BACKTICK;

function regExpEscape(value) { return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'); }

// 由仓库常量派生出 invoke / parameter 标签片段，避免硬编码特殊 token。
const D_INVOKE_OPEN = DSML_CALLS_OPEN.replace(/ calls>$/u, ' invoke name="');
const D_INVOKE_CLOSE = DSML_CALLS_CLOSE.replace(/ calls>$/u, ' invoke>');
const D_PARAM_OPEN = DSML_CALLS_OPEN.replace(/ calls>$/u, ' parameter name="');
const D_PARAM_CLOSE = DSML_CALLS_CLOSE.replace(/ calls>$/u, ' parameter>');

const INVOKE_RE = new RegExp('(' + regExpEscape(D_INVOKE_OPEN) + '([^"]*)"\\s*>)' +
  '([\\s\\S]*?)' + regExpEscape(D_INVOKE_CLOSE), 'gu');
const PARAM_RE = new RegExp('(' + regExpEscape(D_PARAM_OPEN) + '([^"]*)"' +
  '(?:\\s+string="(true|false)")?\\s*>)' + '([\\s\\S]*?)' + regExpEscape(D_PARAM_CLOSE), 'gu');

/** 流式需要识别的标记（含常见变体），用于“检测到就切换输出模式”。 */
export const STREAM_MARKERS = [
  { kind: 'think-open', text: THINK_OPEN, phase: 'thinking' },
  { kind: 'end-marker', text: END_MARKER, phase: 'body' },
  { kind: 'end-marker-variant', text: LEGACY_END_MARKER, phase: 'body' },
  { kind: 'end-marker-variant', text: '</' + END_MARKER.slice(1), phase: 'body' },
  { kind: 'end-marker-variant', text: END_MARKER.split(BAR).join('|'), phase: 'body' },
  { kind: 'end-marker-variant', text: END_MARKER.split(BLOCK).join('_'), phase: 'body' },
  { kind: 'end-marker-variant', text: END_MARKER.split(BLOCK).join(''), phase: 'body' },
  { kind: 'end-marker-variant', text: '</think>', phase: 'body' },
  { kind: 'end-marker-variant', text: '</thinking>', phase: 'body' },
  { kind: 'output-open', text: OUTPUT_OPEN, phase: 'body' },
  { kind: 'output-close', text: OUTPUT_CLOSE, phase: 'trailing' },
  { kind: 'body-open', text: CONTENT_OPEN, phase: 'body' },
  { kind: 'body-close', text: CONTENT_CLOSE, phase: 'trailing' },
  { kind: 'tool-call-begin', text: DSML_CALLS_OPEN, phase: 'tool-call' },
  { kind: 'tool-call-end', text: DSML_CALLS_CLOSE, phase: 'trailing' },
];

const MAX_MARKER_LENGTH = STREAM_MARKERS.reduce((max, marker) => Math.max(max, marker.text.length), 0);

const TEXT_KINDS = new Set(['thinking', 'body', 'tool-call', 'text']);

function phaseEventKind(phase) {
  if (phase === 'thinking') return 'thinking';
  if (phase === 'tool-call') return 'tool-call';
  if (phase === 'body') return 'body';
  return 'text';
}

/**
 * 创建流式扫描器。用法：
 *   const scanner = createMarkerStreamScanner();
 *   for (const chunk of chunks) {
 *     for (const event of scanner.push(chunk)) { ... }
 *     if (scanner.phase !== 'thinking') { /* 已切换成正文 / 工具调用 *​/ }
 *   }
 *   for (const event of scanner.finish()) { ... }
 */
export function createMarkerStreamScanner() {
  let buffer = '';
  let phase = 'thinking';
  let emitted = 0;
  let switchedAt = -1;
  let switchKind = null;

  function earliestMatch() {
    let best = null;
    for (const marker of STREAM_MARKERS) {
      if (!marker.text) continue;
      const index = buffer.indexOf(marker.text);
      if (index < 0) continue;
      if (best === null || index < best.index ||
        (index === best.index && marker.text.length > best.marker.text.length)) {
        best = { index, marker };
      }
    }
    return best;
  }

  /** 尾部是否可能是某个标记的前缀（可能是就先扣留，等下一块）。 */
  function holdbackLength() {
    const limit = Math.min(buffer.length, MAX_MARKER_LENGTH - 1);
    for (let length = limit; length > 0; length -= 1) {
      const tail = buffer.slice(buffer.length - length);
      if (STREAM_MARKERS.some(marker => marker.text.startsWith(tail))) return length;
    }
    return 0;
  }

  return {
    get phase() { return phase; },
    get switchedAt() { return switchedAt; },
    get switchKind() { return switchKind; },
    get pending() { return buffer.length; },
    push(chunk) {
      buffer += chunk == null ? '' : String(chunk);
      const events = [];
      while (buffer.length > 0) {
        const match = earliestMatch();
        if (!match) break;
        if (match.index > 0) events.push({ kind: phaseEventKind(phase), text: buffer.slice(0, match.index) });
        emitted += match.index;
        if (match.marker.phase !== 'thinking' && phase === 'thinking') {
          switchedAt = emitted;
          switchKind = match.marker.kind;
        }
        if (match.marker.kind === 'tool-call-begin') phase = 'tool-call';
        else if (match.marker.kind === 'tool-call-end' || match.marker.kind === 'body-close') phase = 'trailing';
        else if (match.marker.phase === 'body') phase = 'body';
        events.push({ kind: match.marker.kind, text: match.marker.text });
        emitted += match.marker.text.length;
        buffer = buffer.slice(match.index + match.marker.text.length);
      }
      const hold = holdbackLength();
      if (hold > 0 && hold < buffer.length) {
        const safe = buffer.slice(0, buffer.length - hold);
        if (safe) {
          events.push({ kind: phaseEventKind(phase), text: safe });
          emitted += safe.length;
        }
        buffer = buffer.slice(buffer.length - hold);
      }
      return events;
    },
    finish() {
      if (buffer.length === 0) return [];
      const events = [{ kind: phaseEventKind(phase), text: buffer }];
      emitted += buffer.length;
      buffer = '';
      return events;
    },
  };
}

/** 用给定块大小模拟流式喂入，返回合并输出、事件序列与切换位置。 */
export function scanTextStream(text, chunkSize) {
  const source = typeof text === 'string' ? text : '';
  const size = Math.max(1, Math.floor(chunkSize || 1));
  const scanner = createMarkerStreamScanner();
  const kinds = [];
  const order = [];
  let output = '';
  for (let index = 0; index < source.length; index += size) {
    for (const event of scanner.push(source.slice(index, index + size))) {
      output += event.text;
      kinds.push(event.kind);
      if (!TEXT_KINDS.has(event.kind)) order.push({ kind: event.kind, at: output.length - event.text.length });
    }
  }
  for (const event of scanner.finish()) {
    output += event.text;
    kinds.push(event.kind);
  }
  return {
    output,
    kinds,
    order,
    switchedAt: scanner.switchedAt,
    switchKind: scanner.switchKind,
    complete: output === source,
    pending: scanner.pending,
  };
}

/**
 * DSML 工具调用格式审计。只看原始文本，用来找“忘记换行”、标签不严谨、
 * string 标记缺失、被代码围栏包裹、工具名拼错等毛病。
 */
export function auditDsmlBlock(rawText, toolNames) {
  const text = typeof rawText === 'string' ? rawText : '';
  const names = Array.isArray(toolNames) ? toolNames : [];
  const issues = [];
  const calls = [];
  const begin = text.indexOf(DSML_CALLS_OPEN);
  const lenient = parseToolCallsFromText(text);

  if (begin < 0) {
    if (lenient.toolCalls) issues.push({ code: 'loose-begin', detail: '开场 calls 标签不严格（空格或竖线数量不同）' });
    return { found: Boolean(lenient.toolCalls), issues, calls };
  }

  const end = text.indexOf(DSML_CALLS_CLOSE, begin + DSML_CALLS_OPEN.length);
  if (end < 0) issues.push({ code: 'missing-end', detail: '缺少 calls 结束标签' });
  const blockEnd = end >= 0 ? end + DSML_CALLS_CLOSE.length : text.length;

  if (text.slice(Math.max(0, begin - 80), begin).includes(CODE_FENCE) ||
    text.slice(begin, blockEnd).includes(CODE_FENCE)) {
    issues.push({ code: 'code-fence', detail: 'DSML 块被 Markdown 代码围栏包裹' });
  }

  INVOKE_RE.lastIndex = 0;
  let match = INVOKE_RE.exec(text);
  while (match !== null) {
    if (end >= 0 && match.index >= end) break;
    const openTag = match[1];
    const name = match[2];
    const inner = match[3];
    const openEnd = match.index + openTag.length;
    const call = { name, parameters: [] };
    calls.push(call);

    if (names.length > 0 && !names.includes(name)) {
      issues.push({ code: 'unknown-tool', detail: '工具名不在清单里: ' + name });
    }
    if (inner.trim() !== '' && !/^\r?\n/u.test(text.slice(openEnd, openEnd + 2))) {
      issues.push({ code: 'invoke-open-no-newline', detail: 'invoke 开始标签后没有换行: ' + name });
    }
    if (inner.trim() !== '' && !/\n[ \t]*$/u.test(inner)) {
      issues.push({ code: 'invoke-close-no-newline', detail: 'invoke 结束标签前没有换行: ' + name });
    }

    PARAM_RE.lastIndex = 0;
    let parameter = PARAM_RE.exec(inner);
    let previousEnd = 0;
    while (parameter !== null) {
      const parameterName = parameter[2];
      const stringFlag = parameter[3];
      const value = parameter[4];
      const parameterStart = parameter.index;
      call.parameters.push({ name: parameterName, stringFlag: stringFlag || null, value });

      if (!stringFlag) {
        issues.push({ code: 'param-string-flag-missing', detail: '参数缺少 string 标记: ' + parameterName });
      } else if (stringFlag !== 'true' && stringFlag !== 'false') {
        issues.push({ code: 'param-string-flag-invalid', detail: 'string 标记只能是 true 或 false: ' + parameterName });
      }
      if (value.trim() === '') {
        issues.push({ code: 'param-empty', detail: '参数值为空: ' + parameterName });
      }
      if (previousEnd > 0 && inner.slice(previousEnd, parameterStart).trim() !== '' &&
        !inner.slice(previousEnd, parameterStart).includes('\n')) {
        issues.push({ code: 'param-no-newline', detail: '参数之间没有换行: ' + parameterName });
      }
      previousEnd = parameterStart + parameter[0].length;
      parameter = PARAM_RE.exec(inner);
    }
    if (call.parameters.length === 0) {
      issues.push({ code: 'no-parameter', detail: 'invoke 里没有解析到 parameter: ' + name });
    }
    match = INVOKE_RE.exec(text);
  }

  if (calls.length === 0) issues.push({ code: 'no-invoke', detail: 'DSML 块里没有解析到 invoke' });
  if (end >= 0 && text.slice(blockEnd).trim() !== '') {
    // 输出区收尾标签属于正常结构，不算多余文本
    let trailing = text.slice(blockEnd).trim();
    for (const tag of [OUTPUT_OPEN, OUTPUT_CLOSE, '<output>', '</output>']) {
      trailing = trailing.split(tag).join('');
    }
    if (trailing.trim() !== '') issues.push({ code: 'trailing-after-end', detail: 'calls 结束标签之后还有文本' });
  }
  return { found: true, issues, calls };
}

/** 审计一轮响应里的 DSML 工具调用格式。 */
export function auditTurnTools(rawText, toolNames) {
  const result = auditDsmlBlock(rawText, toolNames);
  const parsed = parseToolCallsFromText(typeof rawText === 'string' ? rawText : '');
  return {
    hasBlock: result.found,
    calls: result.calls.length > 0 ? result.calls : (parsed.toolCalls || []).map(call => ({
      name: (call.function && call.function.name) || '',
      parameters: [],
    })),
    issues: result.issues,
    ok: result.found && result.issues.length === 0,
  };
}
