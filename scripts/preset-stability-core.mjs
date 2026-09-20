/**
 * 预设稳定性测试 —— 纯逻辑层（真实模型，非流式）。
 *
 * 统计“思考预设”的契约稳定性：模型每次在回答正文前、在工具调用前，
 * 是否都恰好输出了一次结束思考标记 <｜end▁of▁thinkings｜>。
 *
 * 本文件不发起网络请求，只负责：
 *   1. 构造与 lib/deepseek-beta.mjs + lib/toolcall-prefill.mjs 同构的 Chat Completion 请求
 *      （assistant 预填充续写 prefix:true、<think> 拆分到 reasoning_content、DSML 工具模拟）；
 *   2. 把非流式响应还原成一整轮可见文本；
 *   3. 判定该轮是否满足预设契约，并汇总成统计；
 *   4. 调用方通过 callModel 注入真实传输（见 scripts/preset-stability.mjs）。
 */
import { compilePreset } from '../lib/preset.mjs';
import { splitReasoningPrefix } from '../lib/deepseek-beta.mjs';
import {
  emulateToolCallRequest,
  transformToolCallJson,
} from '../lib/toolcall-prefill.mjs';

/* ------------------------------------------------------------------ *
 * 标记常量
 * ------------------------------------------------------------------ */

const BT = String.fromCharCode(96); // 反引号字符，避免在源码里出现嵌套模板符号

const BAR = '\uFF5C';      // 全角竖线，DeepSeek 特殊 token 的边界字符
const BLOCK = '\u2581';    // SentencePiece 空格标记
const DSML_CALLS_OPEN = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>';
const DSML_CALLS_CLOSE = '</' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>';
const DSML_INVOKE_OPEN = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="工具名">';
const DSML_INVOKE_CLOSE = '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
const DSML_PARAM = '<' + BAR + BAR + 'DSML' + BAR + BAR +
  ' parameter name="参数名" string="false">合法 JSON</' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>';

/** 规范结束思考标记（新格式要求：必须独占一行）。 */
export const END_MARKER = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'think' + BAR + '>';
/** 旧写法，现在只作为变体统计。 */
export const LEGACY_END_MARKER = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'thinkings' + BAR + '>';
export const THINK_OPEN = '<think>';
export const THINK_CLOSE = '</think>';
export const CONTENT_OPEN = '<content>';
export const CONTENT_CLOSE = '</content>';
/**
 * 输出区标签：包裹整段对外输出（含正文与正文之外的其他格式）。
 * 用全角竖线 + SentencePiece 块的特殊 token 形式，模型几乎不可能在正文里自然重复它；
 * 旧的 <output> 写法保留为兼容变体，只用于解析，不再要求模型输出。
 */
export const OUTPUT_OPEN = '<' + BAR + 'begin' + BLOCK + 'of' + BLOCK + 'output' + BAR + '>';
export const OUTPUT_CLOSE = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'output' + BAR + '>';
export const LEGACY_OUTPUT_OPEN = '<output>';
export const LEGACY_OUTPUT_CLOSE = '</output>';
/** 最终文本的固定开场句（锚点）：一旦出现就说明已经开始最终输出。 */
export const ANCHOR_SENTENCE = '您好，这是约定的内容，请查收：';

const MARKER_LIKE_RE = /<\/?[｜|][^<>\n]{1,40}[｜|]>/gu;
const MARKER_NEAR_RE = /<\/?[^<>\n]{0,24}end[^<>\n]{0,24}think[^<>\n]{0,24}>/giu;
const CLOSE_THINK_RE = /<\/think(?:ing)?[ \t]*>/giu;
const BODY_OPEN_RE = /<content\s*>/giu;

function allIndexes(text, needle) {
  const out = [];
  if (!needle) return out;
  let index = text.indexOf(needle);
  while (index >= 0) { out.push(index); index = text.indexOf(needle, index + needle.length); }
  return out;
}

function firstIndexOfAny(text, tokens) {
  const found = tokens.map(token => text.indexOf(token)).filter(index => index >= 0);
  return found.length > 0 ? Math.min.apply(null, found) : -1;
}

function matches(text, re) {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re)).map(match => match[0]);
}

/* ------------------------------------------------------------------ *
 * 预设定义
 * ------------------------------------------------------------------ */

/**
 * 用户描述的测试预设的默认实现：
 *   User: （指令）…必须输出“<｜end▁of▁thinkings｜>”结束思考…
 *   Assistant: <think>好的，现在我将开始      ← assistant 预填充，由 prefix:true 续写
 */
export const DEFAULT_PRESET_TEXT = [
  '你是一个写作助手。请严格遵循下面的输出格式约定。',
  '***回答或使用工具前，必须让结束思考标记独占一行来结束思考，格式严格为：换行 + ' + END_MARKER + ' + 换行***',
  '也就是说，结束思考时必须单独输出下面这一行（该行前后各有一个换行，行内不能有任何其他文字）：',
  '',
  END_MARKER,
  '',
  '***必须以输出“' + ANCHOR_SENTENCE + '”开始最终文本的生成。***',
  '- 最终文本在 ' + BT + '</thinking>' + BT + ' 标签后面生成；',
  '- 例外：正文输出需要调用工具时，不输出这句话。',
  '',
  '结束思考后，必须紧接着用 ' + OUTPUT_OPEN + ' 开始输出区，把**全部**对外内容都放进去，最后用 ' + OUTPUT_CLOSE + ' 收尾；正文依然写在 ' + BT + '<content></content>' + BT + ' 里。',
  '完整结构如下（' + OUTPUT_OPEN + ' 之前只能是思考内容）：',
  '',
  END_MARKER,
  OUTPUT_OPEN,
  '（正文之外的其他格式）',
  '<content>正文</content>',
  '（正文之外的其他格式）',
  OUTPUT_CLOSE,
  '',
  '把回答正文的内容写在 ' + BT + '<content></content>' + BT + ' 的里面，总字数在1200~1600字之间。',
  '如果上文的回答正文外部需要某种格式，把它们放在 ' + BT + '</content>' + BT + ' 的后面，或者 ' + BT + '<content>' + BT + ' 的前面。',
  '你可以使用系统提供的工具；需要调用工具时，在结束思考标记之后立刻给出工具调用。',
  '工具调用必须使用下面的 DSML calls 外层格式，不能改成原生工具调用标签、JSON 或 Markdown 代码块：',
  DSML_CALLS_OPEN,
  DSML_INVOKE_OPEN,
  DSML_PARAM,
  DSML_INVOKE_CLOSE,
  DSML_CALLS_CLOSE,
  '每次调用都放在 ' + DSML_CALLS_OPEN + ' 与 ' + DSML_CALLS_CLOSE + ' 之间；字符串参数使用 string="true"，非字符串参数使用 string="false" 并填写合法 JSON。',
].join('\n');

export const DEFAULT_ASSISTANT_PREFILL = '<think>好的，现在我将开始';

/** 人工构造的预设（不依赖外部文件）。 */
export function createSyntheticPreset({
  instruction = DEFAULT_PRESET_TEXT,
  assistantPrefill = DEFAULT_ASSISTANT_PREFILL,
  postToolPrefix = null,
  role = 'user',
} = {}) {
  return {
    name: '用户描述的测试预设（内置）',
    kind: 'synthetic',
    instruction,
    assistantPrefill,
    postToolPrefix,
    role,
    build(history) {
      // 与真实预设一致：预设指令注入在 chatHistory 之后、assistant 预填充之前。
      const messages = history.concat([{ role, content: instruction }]);
      const last = history[history.length - 1];
      const afterTool = last && last.role === 'tool';
      const prefill = afterTool && postToolPrefix ? postToolPrefix : assistantPrefill;
      if (prefill && prefill.trim()) messages.push({ role: 'assistant', content: prefill });
      return messages;
    },
  };
}

function plainText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n');
  }
  return '';
}

/** 把纯文本消息转换成 compilePreset 需要的 DSH 消息形状。 */
export function toDshHistory(history) {
  return history.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool', tool_call_id: message.tool_call_id, name: message.name,
        content: [{ type: 'tool-result', text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }],
        source: { kind: 'tool' },
      };
    }
    const copy = {
      role: message.role,
      content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }],
      source: { kind: message.role === 'assistant' ? 'model' : 'user' },
    };
    if (Array.isArray(message.tool_calls)) copy.tool_calls = message.tool_calls;
    if (typeof message.reasoning_content === 'string') copy.reasoning_content = message.reasoning_content;
    return copy;
  });
}

/** 用本仓库的 compilePreset 装载真实 SillyTavern 预设（顺序表 / assistant_prefill / 后置 assistant 前缀）。 */
export function createCompiledPreset(rawPreset, options) {
  const config = options || {};
  return {
    name: config.name || '外部预设',
    kind: 'sillytavern',
    build(history) {
      const result = compilePreset(rawPreset, toDshHistory(history), {
        characterId: config.characterId === undefined ? 100001 : config.characterId,
        seed: config.seed || 'stability',
        markers: config.markers || {},
        ...(config.postToolPrefix ? { postToolPrefix: config.postToolPrefix } : {}),
      });
      return result.messages.map(message => Object.assign(
        { role: message.role, content: plainText(message) },
        Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {},
      ));
    },
  };
}

/* ------------------------------------------------------------------ *
 * 虚拟工具（供模型调用，结果为确定性假数据）
 * ------------------------------------------------------------------ */

const VIRTUAL_RESULTS = {
  get_weather(args) {
    const table = { 上海: { condition: '多云', temperature_c: 6, humidity: 71 }, 北京: { condition: '晴', temperature_c: 1, humidity: 33 } };
    const city = String((args && args.city) || '').trim() || '上海';
    const hit = table[city] || { condition: '未知', temperature_c: null, humidity: null };
    return Object.assign({ tool: 'get_weather', city, source: 'virtual-weather-api', observed_at: '2026-01-15T04:30:00.000Z' }, hit);
  },
  search_notes(args) {
    const query = String((args && args.query) || '').trim();
    return {
      tool: 'search_notes', query, source: 'virtual-note-store',
      results: [
        { title: '虚拟笔记 · ' + (query || '未命名'), snippet: '这是一条用于测试的虚拟检索结果，不指向任何真实资料。' },
        { title: '虚拟笔记 · 备用条目', snippet: '第二条虚拟结果，用于制造多结果场景。' },
      ],
    };
  },
  calculate(args) {
    const a = Number(args && args.a), b = Number(args && args.b), op = String((args && args.op) || '+');
    const ops = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => (y === 0 ? NaN : x / y) };
    const value = ops[op] ? ops[op](a, b) : NaN;
    return { tool: 'calculate', a, op, b, value: Number.isNaN(value) ? null : value };
  },
  get_current_time(args) {
    return { tool: 'get_current_time', timezone: String((args && args.timezone) || 'UTC'), iso: '2026-01-15T04:30:00.000Z', source: 'virtual-clock' };
  },
};

/** 标准 OpenAI tools 数组。 */
export const VIRTUAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的当前天气（虚拟数据，仅用于测试）。',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，例如 上海' } }, required: ['city'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '在虚拟笔记库中检索与关键词相关的条目（虚拟数据，仅用于测试）。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '检索关键词' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '对两个数字做一次四则运算（虚拟计算器，仅用于测试）。',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: '左操作数' },
          op: { type: 'string', enum: ['+', '-', '*', '/'], description: '运算符' },
          b: { type: 'number', description: '右操作数' },
        },
        required: ['a', 'op', 'b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '查询当前时间（虚拟时钟，仅用于测试）。',
      parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai' } }, required: [] },
    },
  },
];

export function runVirtualTool(name, args) {
  const handler = VIRTUAL_RESULTS[name];
  if (!handler) return { tool: name, error: 'unknown_virtual_tool' };
  try { return handler(args || {}); } catch (error) { return { tool: name, error: String((error && error.message) || error) }; }
}

/** 执行一次工具调用，返回可直接塞进 messages 的 tool 消息。 */
export function executeToolCall(call) {
  const fn = (call && call.function) || {};
  const name = String(fn.name || (call && call.name) || '');
  let args = {};
  const raw = fn.arguments != null ? fn.arguments : (call && call.arguments);
  if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { args = { _raw: raw }; } }
  else if (raw && typeof raw === 'object') args = raw;
  return {
    role: 'tool',
    tool_call_id: (call && call.id) || 'call_virtual',
    name: name || 'tool',
    content: JSON.stringify(runVirtualTool(name, args)),
  };
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export const TASKS = [
  {
    id: 'weather-compare',
    text: '先用 get_weather 工具分别查询上海和北京的当前天气（必须实际调用两次，禁止凭空编造数据），然后根据两次查询结果写一篇对比两地天气的短文。',
    calls: [
      { name: 'get_weather', arguments: { city: '上海' } },
      { name: 'get_weather', arguments: { city: '北京' } },
    ],
  },
  {
    id: 'calc-report',
    text: '先用 calculate 工具分别计算 1234*5678 和 9876-5432（必须实际调用两次，禁止心算代替），然后根据这两个结果写一篇介绍数字的文章。',
    calls: [
      { name: 'calculate', arguments: { a: 1234, op: '*', b: 5678 } },
      { name: 'calculate', arguments: { a: 9876, op: '-', b: 5432 } },
    ],
  },
  {
    id: 'single-tool',
    text: '请先调用 get_current_time 查询当前时间（一次调用），然后围绕这个时间点写一篇短文。',
    calls: [{ name: 'get_current_time', arguments: { timezone: 'Asia/Shanghai' } }],
  },
  {
    id: 'no-tool',
    text: '不需要调用任何工具，直接写一篇关于冬天清晨的短文。',
    calls: [],
  },
];

export function findTask(id) {
  return TASKS.find(task => task.id === id) || null;
}

/* ------------------------------------------------------------------ *
 * 请求构造（与 lib/deepseek-beta.mjs 的改写结果同构）
 * ------------------------------------------------------------------ */

function splitAssistantThinking(message, enabled) {
  if (!enabled || !message || message.role !== 'assistant' || typeof message.content !== 'string') return message;
  const split = splitReasoningPrefix(message.content);
  if (split.tagged) return Object.assign({}, message, { content: split.content, reasoning_content: split.reasoningContent });
  if (typeof message.reasoning_content === 'string') return message;
  return Object.assign({}, message, { reasoning_content: '' });
}

/**
 * 构造发往 Chat Completion 的请求体。
 * 对齐 rewriteDeepSeekPrefixFetch()：
 *   thinking=enabled 时把 <think> 前缀拆进 reasoning_content；
 *   末条 assistant 加 prefix:true（DeepSeek Beta 对话前缀续写）；
 *   DSML 工具模式下注入工具说明、内联工具历史并移除原生工具字段；
 *   official / DSML 模式下移除 tools、tool_choice、parallel_tool_calls。
 */
export function buildWireRequest(options) {
  const config = options || {};
  const messages = config.messages || [];
  const tools = config.tools || [];
  const transport = config.transport || 'official';
  const toolsMode = config.toolsMode || 'dsml';
  const thinking = config.thinking || 'omit';
  const prefixMode = config.prefixMode || 'prefix';
  const thinkingEnabled = thinking === 'enabled';

  let wireMessages = messages.map(message => Object.assign({}, message));
  if (thinkingEnabled) wireMessages = wireMessages.map(message => splitAssistantThinking(message, true));

  const last = wireMessages[wireMessages.length - 1];
  if (prefixMode === 'prefix' && last && last.role === 'assistant' && typeof last.content === 'string') {
    wireMessages[wireMessages.length - 1] = Object.assign({}, last, { prefix: true });
  }

  const body = { model: config.model || 'deepseek-chat', messages: wireMessages, stream: false };
  if (thinking === 'enabled' || thinking === 'disabled') body.thinking = { type: thinking };
  if (typeof config.temperature === 'number') body.temperature = config.temperature;
  if (typeof config.maxTokens === 'number') body.max_tokens = config.maxTokens;

  // 预填充续写：接口只返回“前缀之后”的续写，所以还原时必须把前缀拼回。
  const tail = wireMessages[wireMessages.length - 1];
  const tailIsPrefix = prefixMode !== 'none' && Boolean(tail) && tail.role === 'assistant';
  let contentPrefix = tailIsPrefix && typeof tail.content === 'string' ? tail.content : '';
  let reasoningPrefix = tailIsPrefix && typeof tail.reasoning_content === 'string' ? tail.reasoning_content : '';
  let emulated = false;
  if (tools.length > 0) {
    body.tools = tools.slice();
    body.tool_choice = 'auto';
    if (toolsMode === 'dsml') {
      const emulation = emulateToolCallRequest(body);
      body.messages = emulation.body.messages;
      contentPrefix = emulation.contentPrefix;
      reasoningPrefix = emulation.reasoningPrefix;
      emulated = true;
    }
  }
  const removeNativeTools = transport === 'official' || toolsMode === 'dsml';
  if (removeNativeTools) { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }

  return { body, contentPrefix, reasoningPrefix, emulated, removeNativeTools, thinkingEnabled, prefixMode, toolCount: tools.length };
}

/* ------------------------------------------------------------------ *
 * 响应还原（非流式）
 * ------------------------------------------------------------------ */

/** 有些适配器会把预填充前缀一并回显，这里避免重复拼接。 */
function withoutEchoedPrefix(prefix, observed) {
  if (!prefix || typeof observed !== 'string') return prefix;
  return observed.startsWith(prefix) ? '' : prefix;
}

/** 把一次非流式 Chat Completion 响应还原成一轮结果。 */
export function normalizeResponse(data, wire) {
  const contentPrefix = wire.contentPrefix;
  const reasoningPrefix = wire.reasoningPrefix;
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message;
  if (!message || typeof message !== 'object') {
    return {
      content: '', reasoning: '', tool_calls: null, finish_reason: null, echoed: false,
      error: (data && data.error) || '响应缺少 choices[0].message',
    };
  }
  const observedContent = typeof message.content === 'string' ? message.content : '';
  const observedReasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const echoed = Boolean((contentPrefix && observedContent.startsWith(contentPrefix)) ||
    (reasoningPrefix && observedReasoning.startsWith(reasoningPrefix)));

  if (wire.emulated) {
    const transformed = transformToolCallJson(data, {
      contentPrefix: withoutEchoedPrefix(contentPrefix, observedContent),
      reasoningPrefix: withoutEchoedPrefix(reasoningPrefix, observedReasoning),
    });
    const out = (transformed.choices && transformed.choices[0] && transformed.choices[0].message) || {};
    return {
      content: typeof out.content === 'string' ? out.content : '',
      reasoning: typeof out.reasoning_content === 'string' ? out.reasoning_content : '',
      tool_calls: Array.isArray(out.tool_calls) && out.tool_calls.length > 0 ? out.tool_calls : null,
      finish_reason: (transformed.choices && transformed.choices[0] && transformed.choices[0].finish_reason) || null,
      echoed, error: null,
    };
  }
  return {
    content: withoutEchoedPrefix(contentPrefix, observedContent) + observedContent,
    reasoning: withoutEchoedPrefix(reasoningPrefix, observedReasoning) + observedReasoning,
    tool_calls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : null,
    finish_reason: choice.finish_reason || null,
    echoed, error: null,
  };
}

/* ------------------------------------------------------------------ *
 * 单轮判定
 * ------------------------------------------------------------------ */

export const CHECK_LABELS = {
  think_open: '<think> 起始标记',
  marker_present: '结束标记 · 存在',
  marker_single: '结束标记 · 恰好一次',
  marker_before_body: '结束标记 · 位于正文前',
  marker_before_tool: '结束标记 · 位于工具调用前',
  content_wrapped: '<content> 包裹正文',
  content_length: '正文字数在区间内',
  tool_call_expected: '按预期发生工具调用',
};

/**
 * 定位正文块。模型经常在思考里提到“正文放在 <content></content> 标签内”，
 * 这种行内提及不是正文，因此优先选择“位于行首且有闭合标签”的 <content>。
 */
function bodyCandidates(full) {
  const out = [];
  BODY_OPEN_RE.lastIndex = 0;
  let match = BODY_OPEN_RE.exec(full);
  while (match !== null) {
    out.push({
      open: match.index,
      tagLength: match[0].length,
      close: full.indexOf(CONTENT_CLOSE, match.index + match[0].length),
    });
    match = BODY_OPEN_RE.exec(full);
  }
  return out;
}

function isLineStart(full, index) {
  if (index === 0) return true;
  return /\n[ \t]*$/u.test(full.slice(Math.max(0, index - 40), index));
}

function innerOf(full, candidate) {
  return candidate.close >= 0
    ? full.slice(candidate.open + candidate.tagLength, candidate.close)
    : full.slice(candidate.open + candidate.tagLength);
}

function boundsFromCandidate(full, chosen) {
  if (!chosen) return null;
  return { open: chosen.open, close: chosen.close, inner: innerOf(full, chosen) };
}

/**
 * 选择主正文块。优先级：
 *   1. 行首 + 有闭合标签 + 内容非空（真正的正文）
 *   2. 有闭合标签 + 内容非空
 *   3. 行首 + 有闭合标签（空正文也算失败样本）
 *   4. 第一个有闭合标签的，最后退化为第一个 <content>
 * 这样可以把思维链里当作模板写出的空 <content></content> 与真正的正文区分开。
 */
function pickPrimaryBody(full) {
  const candidates = bodyCandidates(full);
  const closed = candidates.filter(candidate => candidate.close >= 0);
  const lineStart = closed.filter(candidate => isLineStart(full, candidate.open));
  const nonEmpty = list => list.find(candidate => innerOf(full, candidate).trim() !== '');
  return nonEmpty(lineStart) || nonEmpty(closed) || lineStart[0] || closed[0] || candidates[0] || null;
}

/**
 * 把一轮原始输出切分成有序片段，作为统计的唯一依据。
 *
 * 提取 schema（kind 取值）：
 *   think-open           进入思维链的 <think>
 *   thinking             思维链文本（<think> 之后到第一个结束标记 / 正文 / 工具调用之前）
 *   end-marker           规范结束标记 <｜end▁of▁thinkings｜>
 *   end-marker-variant   非规范结束标记（</think>、<|end_of_thinking|> 等）
 *   body-open / body-close / body   正文块 <content>…</content>
 *   tool-call            工具调用（DSML 解析结果或原生 tool_calls）
 *   text                 其余可见文本（正文之外的格式、附加栏等）
 */
export function segmentTurn(turn) {
  const content = typeof turn.content === 'string' ? turn.content : '';
  const reasoning = typeof turn.reasoning === 'string' ? turn.reasoning : '';
  const full = reasoning && content ? reasoning + '\n' + content : (reasoning || content);
  const toolCalls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
  const enteredThinking = full.replace(/^\s*/u, '').startsWith(THINK_OPEN);

  const events = [];
  if (enteredThinking) {
    events.push({ kind: 'think-open', index: full.indexOf(THINK_OPEN), length: THINK_OPEN.length, text: THINK_OPEN });
  }
  for (const match of full.matchAll(/<content[ \t]*>/giu)) {
    events.push({ kind: 'body-open', index: match.index, length: match[0].length, text: match[0] });
  }
  for (const match of full.matchAll(/<\/content>/giu)) {
    events.push({ kind: 'body-close', index: match.index, length: match[0].length, text: match[0] });
  }
  for (const tag of [OUTPUT_OPEN, LEGACY_OUTPUT_OPEN, OUTPUT_CLOSE, LEGACY_OUTPUT_CLOSE]) {
    for (const index of allIndexes(full, tag)) {
      events.push({
        kind: index >= 0 && tag === OUTPUT_CLOSE || tag === LEGACY_OUTPUT_CLOSE ? 'output-close' : 'output-open',
        index, length: tag.length, text: tag,
      });
    }
  }
  for (const index of allIndexes(full, END_MARKER)) {
    events.push({ kind: 'end-marker', index, length: END_MARKER.length, text: END_MARKER });
  }
  for (const match of full.matchAll(MARKER_LIKE_RE)) {
    if (match[0] !== END_MARKER) events.push({ kind: 'end-marker-variant', index: match.index, length: match[0].length, text: match[0] });
  }
  for (const match of full.matchAll(CLOSE_THINK_RE)) {
    events.push({ kind: 'end-marker-variant', index: match.index, length: match[0].length, text: match[0] });
  }
  for (const match of full.matchAll(MARKER_NEAR_RE)) {
    if (match[0] !== END_MARKER) events.push({ kind: 'end-marker-variant', index: match.index, length: match[0].length, text: match[0] });
  }
  for (const call of toolCalls) {
    const fn = (call && call.function) || {};
    events.push({
      kind: 'tool-call', index: full.length, length: 0, text: '',
      name: String(fn.name || ''), arguments: String(fn.arguments || ''),
    });
  }

  const seen = new Set();
  const ordered = events
    .filter(event => {
      const key = event.kind + '@' + event.index;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.index - b.index) || (b.length - a.length));

  const segments = [];
  let cursor = 0;
  for (const event of ordered) {
    if (event.index > cursor) segments.push({ kind: 'text', text: full.slice(cursor, event.index) });
    if (event.kind === 'tool-call') segments.push({ kind: 'tool-call', name: event.name, arguments: event.arguments });
    else segments.push({ kind: event.kind, text: event.text });
    cursor = Math.max(cursor, event.index + event.length);
  }
  if (cursor < full.length) segments.push({ kind: 'text', text: full.slice(cursor) });

  const markers = ordered.filter(event => event.kind === 'end-marker').map(event => ({ index: event.index, text: event.text }));
  const variants = ordered.filter(event => event.kind === 'end-marker-variant').map(event => ({ index: event.index, text: event.text }));
  const bodies = bodyCandidates(full).map((candidate, index) => ({
    index,
    open: candidate.open,
    close: candidate.close,
    chars: (candidate.close >= 0
      ? full.slice(candidate.open + candidate.tagLength, candidate.close)
      : full.slice(candidate.open + candidate.tagLength)).replace(/\s/gu, '').length,
  }));
  const primaryBody = pickPrimaryBody(full);

  // 思维链：<think> 之后 → 第一个结束标记；没有标记就退到正文/工具调用之前。
  const thinkStart = enteredThinking ? full.indexOf(THINK_OPEN) + THINK_OPEN.length : 0;
  const boundary = markers.length > 0 ? markers[0].index : (primaryBody ? primaryBody.open : full.length);
  const thinkingText = full.slice(thinkStart, Math.max(thinkStart, boundary));

  const outputOpen = firstIndexOfAny(full, [OUTPUT_OPEN, LEGACY_OUTPUT_OPEN]);
  const outputClose = outputOpen < 0 ? -1
    : firstIndexOfAny(full.slice(outputOpen + 1), [OUTPUT_CLOSE, LEGACY_OUTPUT_CLOSE]);
  const outputCloseAt = outputClose < 0 ? -1 : outputOpen + 1 + outputClose;

  const lastClose = bodies
    .filter(body => body.close >= 0)
    .map(body => body.close + CONTENT_CLOSE.length)
    .sort((a, b) => b - a)[0];
  const extras = lastClose === undefined ? '' : full.slice(lastClose);

  return {
    full,
    enteredThinking,
    segments,
    markers,
    variants,
    bodies,
    primaryBody,
    thinkingText,
    thinkingChars: thinkingText.replace(/\s/gu, '').length,
    outputOpen,
    outputClose: outputCloseAt,
    outputChars: outputOpen < 0 ? 0
      : (outputCloseAt < 0 ? full.slice(outputOpen) : full.slice(outputOpen, outputCloseAt)).replace(/\s/gu, '').length,
    extras,
    toolCalls: toolCalls.map(call => {
      const fn = (call && call.function) || {};
      return { name: String(fn.name || ''), arguments: String(fn.arguments || '') };
    }),
  };
}

/**
 * 判定一轮助手输出。full = reasoning + content（含我们预填充的前缀）。
 * expect: { body, toolCall, min, max, requireThinkOpen, thinkingSplit }
 */
export function analyzeTurn(turn, expect) {
  const spec = expect || {};
  const toolCalls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
  const hasToolCalls = toolCalls.length > 0;
  // 所有判定统一基于结构化片段（进入思维链 / 思维链 / 结束标记 / 正文块 / 工具调用）
  const extracted = segmentTurn(turn);
  const full = extracted.full;
  const markerIndexes = extracted.markers.map(marker => marker.index);
  const markerCount = markerIndexes.length;
  const markerLikes = Array.from(new Set(extracted.variants.map(variant => variant.text))).filter(value => value !== END_MARKER);
  const closeThink = markerLikes.filter(value => /^<\/think/iu.test(value));
  const bounds = boundsFromCandidate(full, extracted.primaryBody);
  const bodyRequired = spec.body !== false && !hasToolCalls;
  const min = Number.isFinite(spec.min) ? spec.min : 1200;
  const max = Number.isFinite(spec.max) ? spec.max : 1600;

  const checks = {};
  const record = (name, status, detail) => { checks[name] = { status, detail: detail || '' }; };

  const thinkOpen = full.replace(/^\s*/u, '').startsWith(THINK_OPEN);
  if (spec.requireThinkOpen) record('think_open', thinkOpen ? 'pass' : 'fail', thinkOpen ? '' : '输出开头不是 <think>');
  else if (spec.thinkingSplit) record('think_open', 'na', '思考字段模式：<think> 已拆分到 reasoning_content');
  else record('think_open', thinkOpen ? 'pass' : 'warn', thinkOpen ? '' : '输出开头不是 <think>（预填充已提供）');

  record('marker_present', markerCount >= 1 ? 'pass' : 'fail', markerCount >= 1 ? '' : '未输出规范结束标记');
  if (markerCount > 1) record('marker_single', 'fail', '结束标记出现 ' + markerCount + ' 次');
  else if (markerCount === 1) record('marker_single', 'pass', '');
  else record('marker_single', 'fail', '结束标记缺失');

  if (bodyRequired) {
    const markerBefore = markerCount >= 1 && Boolean(bounds) && markerIndexes[0] <= bounds.open;
    record('marker_before_body', markerBefore ? 'pass' : 'fail',
      !bounds ? '没有 <content> 正文' : (markerCount === 0 ? '标记缺失' : (markerBefore ? '' : '标记出现在 <content> 之后')));
    if (!bounds) record('content_wrapped', 'fail', '没有找到 <content> 正文块');
    else if (bounds.close < 0) record('content_wrapped', 'fail', '缺少 </content>');
    else if (bounds.inner.trim() === '') record('content_wrapped', 'fail', '<content> 内容为空');
    else record('content_wrapped', 'pass', '');
    if (bounds) {
      const chars = bounds.inner.replace(/\s/gu, '').length;
      record('content_length', chars >= min && chars <= max ? 'pass' : 'fail', '正文 ' + chars + ' 字（要求 ' + min + '~' + max + '）');
    } else record('content_length', 'fail', '无法统计字数');
    record('marker_before_tool', 'na', '本轮没有工具调用');
  } else if (hasToolCalls) {
    record('marker_before_body', 'na', '本轮是工具调用轮');
    record('content_wrapped', 'na', '本轮是工具调用轮');
    record('content_length', 'na', '本轮是工具调用轮');
    record('marker_before_tool', markerCount >= 1 ? 'pass' : 'fail', markerCount >= 1 ? '' : '调用工具前没有结束标记');
  } else {
    record('marker_before_body', 'na', '');
    record('content_wrapped', 'na', '');
    record('content_length', 'na', '');
    record('marker_before_tool', 'na', '');
  }

  if (spec.toolCall && !hasToolCalls) record('tool_call_expected', 'warn', '本轮预期调用工具，模型直接给出了正文');
  else if (spec.toolCall) record('tool_call_expected', 'pass', '');
  else record('tool_call_expected', 'na', '');

  const failed = Object.keys(checks).filter(name => checks[name].status === 'fail');
  const inner = (bounds && bounds.inner) || '';
  const bodyChars = inner ? inner.replace(/\s/gu, '').length : 0;
  const cjk = inner ? matches(inner, /[\u3400-\u9fff]/gu).length : 0;
  // 标记落点：thinking = 思维链内（正文块之前），body = 正文块内，after-body = 正文之后，none = 没有规范标记
  const markerRegion = markerCount === 0 ? 'none'
    : !bounds ? 'thinking'
      : markerIndexes[0] < bounds.open ? 'thinking'
        : (bounds.close >= 0 && markerIndexes[0] > bounds.close) ? 'after-body'
          : 'body';

  return {
    ok: failed.length === 0,
    strictOk: failed.length === 0,
    lenientOk: markerCount === 1,
    markerRegion,
    enteredThinking: extracted.enteredThinking,
    thinkingChars: extracted.thinkingChars,
    outputOpen: extracted.outputOpen,
    outputChars: extracted.outputChars,
    bodyBlocks: extracted.bodies.length,
    extrasChars: extracted.extras.replace(/\s/gu, '').length,
    segmentKinds: extracted.segments.map(segment => segment.kind),
    segmentPreview: extracted.segments.map(segment => segment.kind + (segment.name ? ':' + segment.name : '')),
    failed,
    checks,
    markerCount,
    markerVariants: markerLikes,
    closeThinkMarks: closeThink,
    bodyChars,
    bodyCharsRaw: inner.length,
    cjkChars: cjk,
    hasToolCalls,
    toolCallCount: toolCalls.length,
    toolCallNames: toolCalls.map(call => String((call && call.function && call.function.name) || '')),
    bodyBeforeTool: hasToolCalls && Boolean(bounds) && bounds.close >= 0,
    text: full,
    excerpt: full.slice(0, 600),
    preview: full.slice(-400),
    error: (turn && turn.error) || null,
    reason: describeFailure(failed, { markerCount, markerLikes, closeThink, bodyChars, min, max }),
  };
}

function describeFailure(failed, info) {
  if (failed.length === 0) return '';
  const parts = [];
  if (failed.indexOf('marker_present') >= 0) {
    const hint = info.markerLikes.length > 0 ? '（出现疑似变体：' + info.markerLikes.slice(0, 3).join(' ') + '）'
      : info.closeThink.length > 0 ? '（改用 </think>）' : '（完全没有结束标记）';
    parts.push('缺少规范结束标记' + hint);
  }
  if (failed.indexOf('marker_single') >= 0 && info.markerCount > 1) parts.push('结束标记重复 ' + info.markerCount + ' 次');
  if (failed.indexOf('marker_before_body') >= 0) parts.push('标记未出现在正文之前');
  if (failed.indexOf('marker_before_tool') >= 0) parts.push('工具调用前没有结束标记');
  if (failed.indexOf('content_wrapped') >= 0) parts.push('正文未用 <content></content> 包裹');
  if (failed.indexOf('content_length') >= 0) parts.push('正文字数 ' + info.bodyChars + ' 不在 ' + info.min + '~' + info.max + ' 区间');
  if (failed.indexOf('think_open') >= 0) parts.push('没有以 <think> 进入思考');
  return parts.join('；');
}

export function classifyPhase(turn, hasToolCalls) {
  if (turn === 1) return hasToolCalls ? '首轮·工具调用前' : '首轮·直接回答';
  return hasToolCalls ? '工具结果后·再次调用工具' : '工具结果后·输出正文';
}

/* ------------------------------------------------------------------ *
 * 统计汇总
 * ------------------------------------------------------------------ */

export function percent(ok, total) {
  return total === 0 ? 'n/a' : (Math.round((ok / total) * 1000) / 10).toFixed(1) + '%';
}

function pushOutcome(map, key, detail) {
  const entry = map.get(key) || { reason: key, count: 0, details: [] };
  entry.count += 1;
  if (entry.details.length < 5) entry.details.push(detail);
  map.set(key, entry);
}

export function summarize(trials) {
  const records = trials.reduce((all, trial) => all.concat(
    trial.records.map(record => Object.assign({}, record, { trial: trial.index, taskId: trial.taskId })),
  ), []);
  const checks = {};
  Object.keys(CHECK_LABELS).forEach(name => { checks[name] = { pass: 0, fail: 0, warn: 0, na: 0 }; });
  const phases = {};
  const markerHistogram = {};
  const outcomes = new Map();
  const lengths = [];
  const lenientRegions = { thinking: 0, body: 0, 'after-body': 0, none: 0 };
  const formatIssues = new Map();
  const switchKinds = new Map();
  const variantKinds = new Map();
  const finishReasons = new Map();
  const thinkingLengths = [];
  let toolBlocks = 0;
  let toolBlocksOk = 0;
  let streamDetected = 0;
  let streamLossless = 0;
  let passed = 0;
  let lenientPassed = 0;

  for (const record of records) {
    if (record.ok) passed += 1;
    if (record.lenientOk) lenientPassed += 1;
    lenientRegions[record.markerRegion] = (lenientRegions[record.markerRegion] || 0) + 1;
    if (record.toolFormat && record.toolFormat.hasBlock) {
      toolBlocks += 1;
      if (record.toolFormat.ok) toolBlocksOk += 1;
      for (const issue of record.toolFormat.issues) {
        const entry = formatIssues.get(issue.code) ||
          { code: issue.code, count: 0, samples: [] };
        entry.count += 1;
        if (entry.samples.length < 3) entry.samples.push(issue.detail);
        formatIssues.set(issue.code, entry);
      }
    }
    if (record.stream && record.stream.detected) streamDetected += 1;
    if (record.stream && record.stream.lossless) streamLossless += 1;
    switchKinds.set((record.stream && record.stream.switchKind) || 'none',
      (switchKinds.get((record.stream && record.stream.switchKind) || 'none') || 0) + 1);
    for (const variant of record.markerVariants || []) {
      variantKinds.set(variant, (variantKinds.get(variant) || 0) + 1);
    }
    if (record.thinkingChars) thinkingLengths.push(record.thinkingChars);
    finishReasons.set(record.finishReason || 'unknown', (finishReasons.get(record.finishReason || 'unknown') || 0) + 1);
    Object.keys(record.checks).forEach(name => {
      if (!checks[name]) checks[name] = { pass: 0, fail: 0, warn: 0, na: 0 };
      const status = record.checks[name].status;
      checks[name][status] = (checks[name][status] || 0) + 1;
    });
    const bucket = phases[record.phase] || (phases[record.phase] = { total: 0, pass: 0 });
    bucket.total += 1;
    if (record.ok) bucket.pass += 1;
    markerHistogram[record.markerCount] = (markerHistogram[record.markerCount] || 0) + 1;
    if (record.bodyChars > 0) lengths.push(record.bodyChars);
    if (!record.ok) pushOutcome(outcomes, record.reason || record.failed.join(','), '第 ' + (record.trial + 1) + ' 组第 ' + record.turn + ' 轮');
    if (record.toolCallExpected && !record.hasToolCalls) pushOutcome(outcomes, '未按预期调用工具（提前给出正文）', '第 ' + (record.trial + 1) + ' 组第 ' + record.turn + ' 轮');
  }

  const bodyTurns = records.filter(record => !record.hasToolCalls && record.checks.marker_before_body.status !== 'na');
  const toolTurns = records.filter(record => record.hasToolCalls);
  const sorted = lengths.slice().sort((a, b) => a - b);
  const cleanTrials = trials.filter(trial => trial.records.every(record => record.ok)).length;

  return {
    trials: trials.length,
    turns: records.length,
    passed,
    passRate: records.length === 0 ? null : Math.round((passed / records.length) * 1000) / 10,
    cleanTrials,
    cleanRate: trials.length === 0 ? null : Math.round((cleanTrials / trials.length) * 1000) / 10,
    signals: {
      switchKinds: Array.from(switchKinds.entries()).sort((a, b) => b[1] - a[1]),
      variantKinds: Array.from(variantKinds.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
      finishReasons: Array.from(finishReasons.entries()).sort((a, b) => b[1] - a[1]),
      thinkingLength: thinkingLengths.length === 0 ? null : {
        min: Math.min.apply(null, thinkingLengths),
        max: Math.max.apply(null, thinkingLengths),
        mean: Math.round(thinkingLengths.reduce((sum, value) => sum + value, 0) / thinkingLengths.length),
      },
    },
    extraction: {
      turns: records.length,
      enteredThinking: records.filter(record => record.enteredThinking).length,
      markerInThinking: records.filter(record => record.markerRegion === 'thinking').length,
      bodyBlocks: records.filter(record => record.bodyBlocks > 0).length,
      outputWrapped: records.filter(record => record.outputOpen >= 0).length,
      toolCalls: records.filter(record => record.hasToolCalls).length,
      extras: records.filter(record => record.extrasChars > 0).length,
    },
    lenient: {
      total: records.length,
      pass: lenientPassed,
      rate: records.length === 0 ? null : Math.round((lenientPassed / records.length) * 1000) / 10,
      regions: lenientRegions,
    },
    bodyTurns: {
      total: bodyTurns.length,
      pass: bodyTurns.filter(record => record.checks.marker_before_body.status === 'pass' && record.checks.marker_single.status === 'pass').length,
    },
    toolTurns: {
      total: toolTurns.length,
      pass: toolTurns.filter(record => record.checks.marker_before_tool.status === 'pass' && record.checks.marker_single.status === 'pass').length,
    },
    checks,
    phases,
    markerHistogram,
    bodyLength: lengths.length === 0 ? null : {
      count: lengths.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
      p50: sorted[Math.floor(sorted.length / 2)],
      inRange: records.filter(record => record.checks.content_length.status === 'pass').length,
      outOfRange: records.filter(record => record.checks.content_length.status === 'fail').length,
    },
    toolFormat: {
      blocks: toolBlocks,
      ok: toolBlocksOk,
      issues: Array.from(formatIssues.values()).sort((a, b) => b.count - a.count),
    },
    stream: {
      turns: records.length,
      detected: streamDetected,
      lossless: streamLossless,
    },
    closeThinkTurns: records.filter(record => (record.closeThinkMarks || []).length > 0).length,
    variantTurns: records.filter(record => (record.markerVariants || []).length > 0).length,
    variantExamples: Array.from(new Set(records.flatMap(record => record.markerVariants || []))).slice(0, 8),
    outcomes: Array.from(outcomes.values()).sort((a, b) => b.count - a.count),
    failedRecords: records.filter(record => !record.ok).map(record => ({
      trial: record.trial, turn: record.turn, phase: record.phase, reason: record.reason,
      markerCount: record.markerCount, excerpt: record.excerpt,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 测试主循环
 * ------------------------------------------------------------------ */

/**
 * 跑一组完整对话：预设注入 → 预填充请求 → 解析 → 判定 → 执行虚拟工具 → 再次预填充续写。
 * callModel(context) 由调用方注入真实传输，返回解析后的非流式响应 JSON。
 */
export async function runTrial(args) {
  const index = args.index;
  const task = args.task;
  const tools = args.tools;
  const options = args.options;
  const callModel = args.callModel;
  const history = task ? [{ role: 'user', content: task.text }] : [];
  const records = [];
  const maxTurns = options.maxTurns || 4;
  const plannedCalls = task && task.calls ? task.calls.length : 0;
  let callsMade = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    // 一次响应里可以并行发起多个调用，所以按“还差几次调用”判断是否仍期待工具调用。
    const expectToolCall = callsMade < plannedCalls;
    const messages = options.preset.build(history);
    const wire = buildWireRequest({
      messages,
      tools,
      transport: options.transport,
      toolsMode: options.toolsMode,
      thinking: options.thinking,
      prefixMode: options.prefixMode,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    const context = { wire, turn, expectToolCall, task, trial: index, options };
    const data = await callModel(context);
    const result = normalizeResponse(data, wire);
    // 原始续写（含 DSML 原文），用于工具调用格式审计与流式扫描模拟
    const rawContinuation = (data && data.choices && data.choices[0] && data.choices[0].message &&
      typeof data.choices[0].message.content === 'string') ? data.choices[0].message.content : '';
    const rawFull = wire.contentPrefix + rawContinuation;
    const toolNames = tools.map(tool => ((tool && tool.function) || tool || {}).name).filter(Boolean);
    const toolFormat = typeof options.auditTools === 'function' ? options.auditTools(rawFull, toolNames) : null;
    const streamScan = typeof options.scanStream === 'function' ? options.scanStream(rawFull, 3) : null;
    const analysis = analyzeTurn(result, {
      body: true,
      toolCall: expectToolCall,
      min: options.bodyMin,
      max: options.bodyMax,
      requireThinkOpen: options.prefixMode === 'none',
      thinkingSplit: options.thinking === 'enabled',
    });
    const record = Object.assign({}, analysis, {
      trial: index,
      turn,
      phase: classifyPhase(turn, analysis.hasToolCalls),
      toolCallExpected: expectToolCall,
      taskId: task ? task.id : null,
      requestSummary: {
        messages: messages.length,
        tools: tools.length,
        contentPrefixChars: wire.contentPrefix.length,
        reasoningPrefixChars: wire.reasoningPrefix.length,
        emulated: wire.emulated,
        prefixFlag: wire.prefixMode === 'prefix' && messages.length > 0 && messages[messages.length - 1].role === 'assistant',
      },
      requestBody: wire.body,
      responseBody: data,
      normalized: result,
      toolFormat,
      finishReason: result.finish_reason || null,
      stream: streamScan ? {
        switchedAt: streamScan.switchedAt,
        switchKind: streamScan.switchKind,
        detected: streamScan.switchedAt >= 0,
        lossless: streamScan.complete,
        order: streamScan.order || [],
      } : null,
    });
    records.push(record);
    if (typeof options.onRecord === 'function') options.onRecord(record);

    if (result.error && !result.content && (!result.tool_calls || result.tool_calls.length === 0)) break;
    if (!result.tool_calls || result.tool_calls.length === 0) break;
    callsMade += result.tool_calls.length;
    history.push(Object.assign(
      { role: 'assistant', content: result.content },
      result.reasoning ? { reasoning_content: result.reasoning } : {},
      { tool_calls: result.tool_calls },
    ));
    for (const call of result.tool_calls) history.push(executeToolCall(call));
  }
  return { index, taskId: task ? task.id : null, records };
}

export async function runTrials(options, callModel) {
  const trials = [];
  for (let index = 0; index < options.trials; index += 1) {
    const task = options.tasks[index % options.tasks.length];
    trials.push(await runTrial({ index, task, tools: options.tools, options, callModel }));
  }
  return { trials, summary: summarize(trials) };
}

/* ------------------------------------------------------------------ *
 * 报告渲染
 * ------------------------------------------------------------------ */

export function renderTextReport(summary, meta) {
  const info = meta || {};
  const lines = [];
  lines.push('================ 预设稳定性测试报告 ================');
  lines.push('预设      : ' + (info.presetName || '-'));
  lines.push('接口      : ' + (info.endpoint || '-') + '   (' + (info.transport || '-') + ')');
  lines.push('模型      : ' + (info.model || '-'));
  lines.push('工具模式  : ' + (info.toolsMode || '-') + '    思考字段: ' + (info.thinking || '-') + '    预填充: ' + (info.prefixMode || '-'));
  lines.push('样本      : ' + summary.trials + ' 组对话 / 每组最多 ' + (info.maxTurns || '-') + ' 轮    任务: ' + (info.taskIds || '-'));
  lines.push('----------------------------------------------------');
  lines.push('助手输出 ' + summary.turns + ' 轮，通过 ' + summary.passed + ' 轮（' + percent(summary.passed, summary.turns) + '）');
  Object.keys(summary.phases).forEach(phase => {
    const bucket = summary.phases[phase];
    lines.push('  ├ ' + phase + '：' + bucket.pass + '/' + bucket.total + ' 通过（' + percent(bucket.pass, bucket.total) + '）');
  });
  lines.push('  └ 对话整体干净 ' + summary.cleanTrials + '/' + summary.trials + '（' + percent(summary.cleanTrials, summary.trials) + '）');
  lines.push('');
  lines.push('关键契约');
  lines.push('  工具调用前的结束标记  ' + summary.toolTurns.pass + '/' + summary.toolTurns.total + '（' + percent(summary.toolTurns.pass, summary.toolTurns.total) + '）');
  lines.push('  回答正文前的结束标记  ' + summary.bodyTurns.pass + '/' + summary.bodyTurns.total + '（' + percent(summary.bodyTurns.pass, summary.bodyTurns.total) + '）');
  lines.push('');
  lines.push('提取结果（结构化片段）');
  lines.push('  进入思维链 <think>      ' + summary.extraction.enteredThinking + '/' + summary.extraction.turns);
  lines.push('  思维链内结束标记        ' + summary.extraction.markerInThinking + '/' + summary.extraction.turns);
  lines.push('  输出区 <output> 提取    ' + summary.extraction.outputWrapped + '/' + summary.extraction.turns);
  lines.push('  正文块 <content> 提取   ' + summary.extraction.bodyBlocks + '/' + summary.extraction.turns);
  lines.push('  工具调用提取            ' + summary.extraction.toolCalls + '/' + summary.extraction.turns);
  lines.push('  正文之后还有附加格式    ' + summary.extraction.extras + ' 轮');
  lines.push('');
  lines.push('宽松口径（规范标记恰好一次即算正确，在思维链内同样计分）');
  lines.push('  正确输出  ' + summary.lenient.pass + '/' + summary.lenient.total + '（' + percent(summary.lenient.pass, summary.lenient.total) + '）');
  lines.push('  标记落点  思维链内 ' + summary.lenient.regions.thinking + ' 轮 / 正文块内 ' + summary.lenient.regions.body +
    ' 轮 / 正文之后 ' + summary.lenient.regions['after-body'] + ' 轮 / 完全没有 ' + summary.lenient.regions.none + ' 轮');
  if (summary.toolFormat && summary.toolFormat.blocks > 0) {
    lines.push('');
    lines.push('工具调用格式（DSML 原文审计）');
    lines.push('  完全合规  ' + summary.toolFormat.ok + '/' + summary.toolFormat.blocks);
    summary.toolFormat.issues.slice(0, 8).forEach(issue => {
      lines.push('  ' + issue.code + ' ×' + issue.count + '  ' + (issue.samples[0] || ''));
    });
  }
  if (summary.stream && summary.stream.turns > 0) {
    lines.push('');
    lines.push('流式切换检测（模拟分块喂入）');
    lines.push('  检出切换点  ' + summary.stream.detected + '/' + summary.stream.turns +
      '   文本无损 ' + summary.stream.lossless + '/' + summary.stream.turns);
    lines.push('  切换信号来源  ' + summary.signals.switchKinds.map(item => item[0] + ' ' + item[1]).join(' / '));
  }
  if (summary.signals.variantKinds.length > 0) {
    lines.push('  非规范标记清单  ' + summary.signals.variantKinds.map(item => item[0] + ' ×' + item[1]).join(' / '));
  }
  if (summary.signals.thinkingLength) {
    const t = summary.signals.thinkingLength;
    lines.push('  思维链长度    min ' + t.min + ' / mean ' + t.mean + ' / max ' + t.max + ' 字');
  }
  lines.push('  finish_reason  ' + summary.signals.finishReasons.map(item => item[0] + ' ' + item[1]).join(' / '));
  lines.push('');
  lines.push('逐项检查');
  Object.keys(CHECK_LABELS).forEach(name => {
    const item = summary.checks[name] || { pass: 0, fail: 0, warn: 0, na: 0 };
    const total = item.pass + item.fail + item.warn;
    lines.push('  ' + CHECK_LABELS[name] + '：' + item.pass + '/' + total +
      (item.fail ? '  失败 ' + item.fail : '') + (item.warn ? '  警告 ' + item.warn : '') +
      (item.na ? '  (不适用 ' + item.na + ')' : ''));
  });
  if (summary.bodyLength) {
    const b = summary.bodyLength;
    lines.push('  正文字数分布：min ' + b.min + ' / p50 ' + b.p50 + ' / mean ' + b.mean + ' / max ' + b.max +
      '，区间内 ' + b.inRange + '，越界 ' + b.outOfRange);
  }
  lines.push('  结束标记出现次数：' + Object.keys(summary.markerHistogram).map(count => count + ' 次×' + summary.markerHistogram[count]).join('，'));
  lines.push('  诊断：出现 </think> 的轮数 ' + summary.closeThinkTurns + '；出现非规范标记的轮数 ' + summary.variantTurns +
    (summary.variantExamples.length > 0 ? '（如 ' + summary.variantExamples.slice(0, 3).join(' / ') + '）' : ''));
  lines.push('----------------------------------------------------');
  if (summary.failedRecords.length === 0) {
    lines.push('未发现契约失败。');
  } else {
    lines.push('失败明细（最多 20 条）');
    summary.failedRecords.slice(0, 20).forEach(item => {
      lines.push('  第 ' + (item.trial + 1) + ' 组第 ' + item.turn + ' 轮 [' + item.phase + '] ' + item.reason);
      lines.push('      片段: ' + item.excerpt.replace(/\s+/gu, ' ').slice(0, 160));
    });
  }
  if (summary.outcomes.length > 0) {
    lines.push('----------------------------------------------------');
    lines.push('原因统计');
    summary.outcomes.forEach(item => lines.push('  ' + item.count + ' 次  ' + item.reason));
  }
  lines.push('====================================================');
  return lines.join('\n');
}

export function renderMarkdownReport(summary, meta) {
  const info = meta || {};
  const lines = [];
  lines.push('# 预设稳定性测试报告');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  [['预设', info.presetName], ['接口', info.endpoint], ['传输', info.transport], ['模型', info.model],
    ['工具模式', info.toolsMode], ['思考字段', info.thinking], ['预填充', info.prefixMode],
    ['样本', summary.trials + ' 组 × 最多 ' + (info.maxTurns || '-') + ' 轮'], ['任务', info.taskIds],
  ].forEach(row => lines.push('| ' + row[0] + ' | ' + (row[1] || '-') + ' |'));
  lines.push('');
  lines.push('## 总体');
  lines.push('');
  lines.push('- 助手输出 **' + summary.turns + '** 轮，通过 **' + summary.passed + '** 轮（' + percent(summary.passed, summary.turns) + '）');
  lines.push('- 工具调用前的结束标记：**' + summary.toolTurns.pass + '/' + summary.toolTurns.total + '**（' + percent(summary.toolTurns.pass, summary.toolTurns.total) + '）');
  lines.push('- 回答正文前的结束标记：**' + summary.bodyTurns.pass + '/' + summary.bodyTurns.total + '**（' + percent(summary.bodyTurns.pass, summary.bodyTurns.total) + '）');
  lines.push('- 对话整体干净：**' + summary.cleanTrials + '/' + summary.trials + '**（' + percent(summary.cleanTrials, summary.trials) + '）');
  lines.push('');
  lines.push('## 提取结果（结构化片段）');
  lines.push('');
  lines.push('| 片段 | 提取到的轮数 |');
  lines.push('| --- | --- |');
  lines.push('| 进入思维链 <think> | ' + summary.extraction.enteredThinking + '/' + summary.extraction.turns + ' |');
  lines.push('| 思维链内的结束标记 | ' + summary.extraction.markerInThinking + '/' + summary.extraction.turns + ' |');
  lines.push('| 正文块 <content> | ' + summary.extraction.bodyBlocks + '/' + summary.extraction.turns + ' |');
  lines.push('| 工具调用 | ' + summary.extraction.toolCalls + '/' + summary.extraction.turns + ' |');
  lines.push('| 正文之后还有附加格式 | ' + summary.extraction.extras + ' 轮 |');
  lines.push('');
  lines.push('## 宽松口径（含思维链内）');
  lines.push('');
  lines.push('- 规范标记恰好出现一次：**' + summary.lenient.pass + '/' + summary.lenient.total + '**（' + percent(summary.lenient.pass, summary.lenient.total) + '）');
  lines.push('- 标记落点：思维链内 ' + summary.lenient.regions.thinking + ' 轮 / 正文块内 ' + summary.lenient.regions.body +
    ' 轮 / 正文之后 ' + summary.lenient.regions['after-body'] + ' 轮 / 完全没有 ' + summary.lenient.regions.none + ' 轮');
  lines.push('');
  lines.push('## 逐项检查');
  lines.push('');
  lines.push('| 检查 | 通过/总数 | 失败 | 警告 | 不适用 |');
  lines.push('| --- | --- | --- | --- | --- |');
  Object.keys(CHECK_LABELS).forEach(name => {
    const item = summary.checks[name] || { pass: 0, fail: 0, warn: 0, na: 0 };
    lines.push('| ' + CHECK_LABELS[name] + ' | ' + item.pass + '/' + (item.pass + item.fail + item.warn) + ' | ' + item.fail + ' | ' + item.warn + ' | ' + item.na + ' |');
  });
  lines.push('');
  lines.push('## 分阶段');
  lines.push('');
  lines.push('| 阶段 | 通过/总数 | 通过率 |');
  lines.push('| --- | --- | --- |');
  Object.keys(summary.phases).forEach(phase => {
    const bucket = summary.phases[phase];
    lines.push('| ' + phase + ' | ' + bucket.pass + '/' + bucket.total + ' | ' + percent(bucket.pass, bucket.total) + ' |');
  });
  lines.push('');
  if (summary.bodyLength) {
    const b = summary.bodyLength;
    lines.push('## 正文字数');
    lines.push('');
    lines.push('- min ' + b.min + ' / p50 ' + b.p50 + ' / mean ' + b.mean + ' / max ' + b.max);
    lines.push('- 区间内 ' + b.inRange + '，越界 ' + b.outOfRange);
    lines.push('');
  }
  if (summary.toolFormat && summary.toolFormat.blocks > 0) {
    lines.push('## 工具调用格式（DSML 原文审计）');
    lines.push('');
    lines.push('- 完全合规：**' + summary.toolFormat.ok + '/' + summary.toolFormat.blocks + '**');
    lines.push('');
    if (summary.toolFormat.issues.length === 0) lines.push('- 未发现格式问题。');
    else {
      lines.push('| 问题 | 次数 | 示例 |');
      lines.push('| --- | --- | --- |');
      summary.toolFormat.issues.forEach(issue => {
        lines.push('| ' + issue.code + ' | ' + issue.count + ' | ' + (issue.samples[0] || '') + ' |');
      });
    }
    lines.push('');
  }
  if (summary.stream && summary.stream.turns > 0) {
    lines.push('## 流式切换检测');
    lines.push('');
    lines.push('- 检出切换点：**' + summary.stream.detected + '/' + summary.stream.turns + '**');
    lines.push('- 文本无损：**' + summary.stream.lossless + '/' + summary.stream.turns + '**');
    lines.push('');
    lines.push('| 切换信号来源 | 轮数 |');
    lines.push('| --- | --- |');
    summary.signals.switchKinds.forEach(item => lines.push('| ' + item[0] + ' | ' + item[1] + ' |'));
    lines.push('');
  }
  if (summary.signals.variantKinds.length > 0) {
    lines.push('## 非规范结束标记清单');
    lines.push('');
    lines.push('| 写法 | 次数 |');
    lines.push('| --- | --- |');
    summary.signals.variantKinds.forEach(item => lines.push('| ' + item[0] + ' | ' + item[1] + ' |'));
    lines.push('');
  }
  if (summary.signals.thinkingLength) {
    const t = summary.signals.thinkingLength;
    lines.push('## 思维链长度（非空白字符）');
    lines.push('');
    lines.push('- min ' + t.min + ' / mean ' + t.mean + ' / max ' + t.max);
    lines.push('');
  }
  lines.push('## finish_reason');
  lines.push('');
  lines.push('| 值 | 轮数 |');
  lines.push('| --- | --- |');
  summary.signals.finishReasons.forEach(item => lines.push('| ' + item[0] + ' | ' + item[1] + ' |'));
  lines.push('');
  lines.push('## 诊断');
  lines.push('');
  lines.push('- 出现 </think> 的轮数：' + summary.closeThinkTurns);
  lines.push('- 出现非规范标记的轮数：' + summary.variantTurns +
    (summary.variantExamples.length > 0 ? '（如 ' + summary.variantExamples.slice(0, 3).join(' / ') + '）' : ''));
  lines.push('');
  lines.push('## 结束标记出现次数分布');
  lines.push('');
  Object.keys(summary.markerHistogram).forEach(count => lines.push('- ' + count + ' 次：' + summary.markerHistogram[count] + ' 轮'));
  lines.push('');
  lines.push('## 失败明细');
  lines.push('');
  if (summary.failedRecords.length === 0) lines.push('未发现契约失败。');
  else summary.failedRecords.slice(0, 50).forEach(item => {
    lines.push('- 第 ' + (item.trial + 1) + ' 组第 ' + item.turn + ' 轮 [' + item.phase + ']：' + item.reason);
  });
  lines.push('');
  return lines.join('\n');
}
