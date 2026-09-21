import { randomUUID } from 'node:crypto';
import {
  createOutputExtractionStream,
  extractOutputText,
  extractTaggedOutputFallback,
  stripExtractionSpecialTokens,
} from './output-extractor.mjs';
import type { OutputExtractionStream } from './output-extractor.mjs';

/** Loose JSON object for provider request/response payloads (wire shapes are dynamic). */
export type JsonObject = Record<string, any>;

/** One chat message in a Chat Completions payload. */
export interface WireChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  reasoning_content?: unknown;
  [key: string]: unknown;
}

/** One recovered DSML tool call in OpenAI tool-call shape. */
export interface ParsedToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string; namespace?: unknown };
  namespace?: string;
}

/** Response-side transform metadata attached to a rewritten request. */
export interface ResponseTransformMetadata {
  contentPrefix: string;
  reasoningPrefix: string;
  extractOutput?: boolean;
}

/** Regex match with an absolute offset; only `index` and group text are read. */
interface RegexMatch {
  0: string;
  index: number;
  [group: number]: string | undefined;
}

const D = '｜｜DSML｜｜';
export const DSML_CALLS_OPEN = '<' + D + ' calls>';
export const DSML_CALLS_CLOSE = '</' + D + ' calls>';
export const TOOL_CALLS_OPEN = '<tool_calls>';
export const TOOL_CALLS_CLOSE = '</tool_calls>';

// DeepSeek emits several DSML dialects in practice. Keep this deliberately narrower than
// generic XML: a recovered invoke/parameter must look like a marker - either the DSML
// literal between pipes, or a pipe-prefixed tag inside the official template envelope.
// Wrapper spelling, padding and pipe width may drift, including the U+2581 separator and
// the zero-width characters models sometimes insert. Every character class below is built
// from char codes so no escape sequence can be lost when this block is edited by tooling.
const PAD_CHARS = String.fromCharCode(32, 9, 13, 10, 12, 11, 0x200B, 0x200C, 0x200D, 0xFEFF, 0x2581);
const SEP_CHARS = PAD_CHARS + String.fromCharCode(0x5F);
const PAD_SOURCE = '[' + PAD_CHARS + ']*';
const SEP_SOURCE = '[' + SEP_CHARS + ']+';
const PIPE_SOURCE = '(?:[｜|]' + PAD_SOURCE + ')+';
const DSML_PREFIX_SOURCE = PIPE_SOURCE + 'DSML' + PAD_SOURCE + PIPE_SOURCE;
const DSML_WRAPPER_SOURCE = '(?:calls|tool(?:' + PAD_SOURCE + '_?' + PAD_SOURCE + 'calls?)?|function' + PAD_SOURCE + '_?' + PAD_SOURCE + 'calls?)';
const OPTIONAL_BACKSLASH = String.fromCharCode(92, 92) + '?';
const OPTIONAL_SLASH = String.fromCharCode(47) + '?';
const DSML_BEGIN_RE = new RegExp(OPTIONAL_BACKSLASH + '<' + PAD_SOURCE + DSML_PREFIX_SOURCE + DSML_WRAPPER_SOURCE + PAD_SOURCE + '>', 'iu');
const TOOL_CALLS_BEGIN_RE = new RegExp(OPTIONAL_BACKSLASH + '<' + PAD_SOURCE + 'tool' + PAD_SOURCE + '_?' + PAD_SOURCE + 'calls?' + PAD_SOURCE + '>', 'iu');
const DSML_INVOKE_OPEN_RE = new RegExp('<' + PAD_SOURCE + DSML_PREFIX_SOURCE + 'invoke' + PAD_SOURCE + '([^>]*)>', 'giu');
const DSML_INVOKE_CLOSE_RE = new RegExp('</' + PAD_SOURCE + DSML_PREFIX_SOURCE + 'invoke' + PAD_SOURCE + '>', 'iu');
const DSML_WRAPPER_CLOSE_RE = new RegExp('</' + PAD_SOURCE + DSML_PREFIX_SOURCE + DSML_WRAPPER_SOURCE + PAD_SOURCE + '>', 'iu');
const TOOL_CALLS_CLOSE_RE = new RegExp('</' + PAD_SOURCE + 'tool' + PAD_SOURCE + '_?' + PAD_SOURCE + 'calls?' + PAD_SOURCE + '>', 'iu');
const DSML_PARAM_OPEN_RE = new RegExp('<' + PAD_SOURCE + DSML_PREFIX_SOURCE + 'parameter' + PAD_SOURCE + '([^>]*?)' + PAD_SOURCE + '(/?)>', 'giu');
const DSML_PARAM_CLOSE_RE = new RegExp('</' + PAD_SOURCE + DSML_PREFIX_SOURCE + 'parameter' + PAD_SOURCE + '>', 'iu');
const ZERO_WIDTH_RE = new RegExp('[' + String.fromCharCode(0x200B, 0x200C, 0x200D, 0xFEFF) + ']', 'gu');
// A leading backslash before a marker is an escaping artefact some models emit.
const ESCAPED_MARKER_RE = new RegExp(
  String.fromCharCode(92, 92) + "(?=<" + PAD_SOURCE + OPTIONAL_SLASH + PAD_SOURCE +
  "(?:tool" + PAD_SOURCE + "_?" + PAD_SOURCE + "calls?|(?:invoke|parameter)|" + PIPE_SOURCE + "(?:DSML|invoke|parameter)" + PAD_SOURCE + "))",
  "giu",
);

// Official DeepSeek chat-template envelope: a tool-calls begin marker, pipe-prefixed
// invoke/parameter tags (no DSML literal), then the matching end marker. Support is gated
// on that explicit begin marker, so a bare pipe-prefixed invoke elsewhere in the text still
// never becomes a tool call.
const officialMarker = (word: string): string => PIPE_SOURCE + 'tool' + SEP_SOURCE + 'calls' + SEP_SOURCE + word + PAD_SOURCE + PIPE_SOURCE;
const OFFICIAL_BEGIN_RE = new RegExp('<' + PAD_SOURCE + officialMarker('begin') + PAD_SOURCE + '>', 'iu');
const OFFICIAL_END_RE = new RegExp('<' + PAD_SOURCE + OPTIONAL_SLASH + officialMarker('end') + PAD_SOURCE + '>', 'iu');
const OFFICIAL_INVOKE_OPEN_RE = new RegExp('<' + PAD_SOURCE + '(?:' + DSML_PREFIX_SOURCE + '|' + PIPE_SOURCE + ')invoke' + PAD_SOURCE + '([^>]*)>', 'giu');
const OFFICIAL_INVOKE_CLOSE_RE = new RegExp('<' + PAD_SOURCE + '(?:' + PIPE_SOURCE + ')?' + PAD_SOURCE + '/' + PAD_SOURCE + '(?:' + DSML_PREFIX_SOURCE + '|' + PIPE_SOURCE + ')?invoke' + PAD_SOURCE + '(?:' + PIPE_SOURCE + ')?' + PAD_SOURCE + '>', 'iu');
const OFFICIAL_PARAM_OPEN_RE = new RegExp('<' + PAD_SOURCE + '(?:' + DSML_PREFIX_SOURCE + '|' + PIPE_SOURCE + ')parameter' + PAD_SOURCE + '([^>]*?)' + PAD_SOURCE + '(/?)>', 'giu');
const OFFICIAL_PARAM_CLOSE_RE = new RegExp('<' + PAD_SOURCE + '(?:' + PIPE_SOURCE + ')?' + PAD_SOURCE + '/' + PAD_SOURCE + '(?:' + DSML_PREFIX_SOURCE + '|' + PIPE_SOURCE + ')?parameter' + PAD_SOURCE + '(?:' + PIPE_SOURCE + ')?' + PAD_SOURCE + '>', 'iu');
const DATA_URI_RE = /data:(image\/[\w.+-]+);base64,[A-Za-z0-9+/=]{100,}/gu;
const B64_BODY_RE = /^[A-Za-z0-9+/=\s]{200,}$/u;
const B64_MAGIC = new Map([
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
]);

function sniffBase64Mime(value: string): string | null {
  for (const [magic, mime] of B64_MAGIC) if (value.startsWith(magic)) return mime;
  return null;
}

function harvestString(value: string, images: string[]): string {
  const replaced = value.replace(DATA_URI_RE, match => {
    images.push(match);
    return '[Image #' + images.length + ' attached]';
  });
  const compact = replaced.trim();
  const mime = sniffBase64Mime(compact);
  if (mime && B64_BODY_RE.test(compact)) {
    images.push('data:' + mime + ';base64,' + compact);
    return '[Image #' + images.length + ' attached]';
  }
  return replaced;
}

function harvestImages(value: any, images: string[]): any {
  if (Array.isArray(value)) return value.map(item => harvestImages(item, images));
  if (typeof value === 'string') return harvestString(value, images);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'image' && typeof value.data === 'string') {
    const mime = value.mimeType || sniffBase64Mime(value.data) || 'image/png';
    images.push('data:' + mime + ';base64,' + value.data);
    return '[Image #' + images.length + ' attached]';
  }
  if (value.type === 'image_url') {
    const candidate = typeof value.image_url === 'object' ? value.image_url?.url : value.image_url;
    if (typeof candidate === 'string' && candidate.startsWith('data:image')) {
      images.push(candidate);
      return '[Image #' + images.length + ' attached]';
    }
  }
  const output: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'b64_json' && typeof item === 'string' && item.length > 200) {
      const mime = sniffBase64Mime(item) || 'image/png';
      images.push('data:' + mime + ';base64,' + item);
      output[key] = '[Image #' + images.length + ' attached]';
    } else output[key] = harvestImages(item, images);
  }
  return output;
}

function toolResultContent(content: unknown): { text: string; images: string[] } {
  const images: string[] = [];
  let cleaned: any;
  if (typeof content === 'string') {
    const compact = content.trim();
    if (compact.startsWith('{') || compact.startsWith('[')) {
      try { cleaned = harvestImages(JSON.parse(compact), images); }
      catch { cleaned = harvestString(content, images); }
    } else cleaned = harvestString(content, images);
  } else cleaned = harvestImages(content, images);
  return { text: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned), images };
}

function toolDefinition(tool: unknown): Record<string, any> {
  if (!tool || typeof tool !== 'object') return {};
  const record = tool as Record<string, any>;
  return record.function && typeof record.function === 'object' ? record.function : record;
}

function qualifiedToolDefinitionName(tool: unknown): string {
  const fn = toolDefinition(tool);
  const name = String(fn.name ?? '');
  if (name.includes('::')) return name;
  const record = tool && typeof tool === 'object' ? tool as Record<string, any> : {};
  const rawNamespace = record.namespace ?? fn.namespace;
  const namespace = rawNamespace && typeof rawNamespace === 'object' ? rawNamespace.name : rawNamespace;
  return namespace == null || String(namespace).trim() === '' ? name : String(namespace).trim() + '::' + name;
}

export function buildToolsPrompt(tools: readonly unknown[]): string {
  const lines = ['## Tools', '', 'You have access to the following tools:', ''];
  for (const tool of tools) {
    const fn = toolDefinition(tool);
    lines.push('### ' + qualifiedToolDefinitionName(tool));
    lines.push('Description: ' + String(fn.description ?? ''));
    lines.push('Parameters (JSON Schema): ' + JSON.stringify(fn.parameters ?? {}));
    lines.push('');
  }
  lines.push(
    'To call tools, use EXACTLY this DSML format:',
    DSML_CALLS_OPEN,
    '<' + D + ' invoke name="tool_name">',
    '<' + D + ' parameter name="param_name" string="true">string value</' + D + ' parameter>',
    '<' + D + ' parameter name="param_name" string="false">123</' + D + ' parameter>',
    '</' + D + ' invoke>',
    DSML_CALLS_CLOSE,
    '',
    'Rules:',
    '- string="true" for string values (write the raw text, no extra quotes)',
    '- string="false" for numbers, booleans, null, arrays and objects (write valid JSON)',
    '- Multiple invokes may be chained inside one calls block',
    '- tool_name must exactly match one of the tools above',
    '- Do not wrap the DSML calls block in a Markdown code fence',
  );
  return lines.join('\n');
}

function argumentObject(value: unknown): Record<string, any> {
  let parsed: any = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return { _raw: value }; }
  }
  if (parsed == null) return {};
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _raw: parsed };
}

export function renderDsmlCall(name: string, argumentsValue: unknown): string {
  const parts = ['<' + D + ' invoke name="' + name + '">'];
  for (const [key, value] of Object.entries(argumentObject(argumentsValue))) {
    if (typeof value === 'string') {
      parts.push('<' + D + ' parameter name="' + key + '" string="true">' + value + '</' + D + ' parameter>');
    } else {
      parts.push('<' + D + ' parameter name="' + key + '" string="false">' + JSON.stringify(value) + '</' + D + ' parameter>');
    }
  }
  parts.push('</' + D + ' invoke>');
  return parts.join('\n');
}

function qualifiedToolName(toolCall: unknown): string {
  const record = toolCall && typeof toolCall === 'object' ? toolCall as Record<string, any> : {};
  const fn = record.function ?? {};
  const name = String(fn.name ?? '');
  if (name.includes('::')) return name;
  const namespace = record.namespace ?? fn.namespace;
  return namespace == null || String(namespace).trim() === '' ? name : String(namespace).trim() + '::' + name;
}

export function inlineToolHistory(messages: readonly WireChatMessage[]): WireChatMessage[] {
  const output: WireChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = [];
      for (const toolCall of message.tool_calls) {
        const fn = toolCall?.function ?? {};
        const name = qualifiedToolName(toolCall);
        toolNames.set(String(toolCall?.id ?? ''), name);
        calls.push(renderDsmlCall(name, fn.arguments ?? '{}'));
      }
      const content = typeof message.content === 'string' ? message.content : '';
      const converted = { ...message };
      delete converted.tool_calls;
      converted.content = content + (content ? '\n' : '') +
        DSML_CALLS_OPEN + '\n' + calls.join('\n') + '\n' + DSML_CALLS_CLOSE;
      output.push(converted);
      index += 1;
      continue;
    }
    if (message?.role === 'tool') {
      const texts = [];
      const images = [];
      while (index < messages.length && messages[index]?.role === 'tool') {
        const toolMessage = messages[index];
        const id = String(toolMessage.tool_call_id ?? '');
        const name = toolNames.get(id) ?? 'tool';
        const result = toolResultContent(toolMessage.content ?? '');
        texts.push(
          '<tool_execution_result tool_call_id="' + id + '" tool_name="' + name + '">\n' +
          '    This is the returned result of the assistant\'s preceding tool call with ID ' + id +
          '. It is not a new user request or a user-uploaded image.\n' +
          '    ' + result.text + '\n</tool_execution_result>\n'
        );
        images.push(...result.images);
        index += 1;
      }
      const text = texts.join('\n\n');
      output.push(images.length > 0 ? {
        role: 'user',
        content: [
          { type: 'text', text },
          ...images.map(url => ({ type: 'image_url', image_url: { url } })),
        ],
      } : { role: 'user', content: text });
      continue;
    }
    output.push(message && typeof message === 'object' ? { ...message } : message);
    index += 1;
  }
  return output;
}

export function emulateToolCallRequest(body: JsonObject): { body: JsonObject; contentPrefix: string; reasoningPrefix: string } {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
  const contentPrefix = typeof last?.content === 'string' ? last.content : '';
  const reasoningPrefix = typeof last?.reasoning_content === 'string' ? last.reasoning_content : '';
  const request = { ...body };
  delete request.tools;
  delete request.tool_choice;
  delete request.parallel_tool_calls;
  const messages = inlineToolHistory(Array.isArray(body.messages) ? body.messages : []);
  const prompt = buildToolsPrompt(tools);
  const system = messages.find(message => message?.role === 'system');
  if (system) system.content = String(system.content ?? '') + '\n\n' + prompt;
  else messages.unshift({ role: 'system', content: prompt });
  request.messages = messages;
  return { body: request, contentPrefix, reasoningPrefix };
}

/** One family of invoke/parameter markers: the DSML dialect or the official envelope. */
interface InvokePatterns {
  invokeOpen: RegExp;
  invokeClose: RegExp;
  wrapperCloses: readonly RegExp[];
  paramOpen: RegExp;
  paramClose: RegExp;
}

const DSML_PATTERNS: InvokePatterns = {
  invokeOpen: DSML_INVOKE_OPEN_RE,
  invokeClose: DSML_INVOKE_CLOSE_RE,
  wrapperCloses: [DSML_WRAPPER_CLOSE_RE, TOOL_CALLS_CLOSE_RE],
  paramOpen: DSML_PARAM_OPEN_RE,
  paramClose: DSML_PARAM_CLOSE_RE,
};

const OFFICIAL_PATTERNS: InvokePatterns = {
  invokeOpen: OFFICIAL_INVOKE_OPEN_RE,
  invokeClose: OFFICIAL_INVOKE_CLOSE_RE,
  wrapperCloses: [OFFICIAL_END_RE],
  paramOpen: OFFICIAL_PARAM_OPEN_RE,
  paramClose: OFFICIAL_PARAM_CLOSE_RE,
};

/**
 * Shared invoke/parameter walker. Both families must prove the call is complete before it is
 * recovered: a closing invoke, a following invoke or a closing wrapper has to terminate the
 * body, otherwise the orphan (a truncated stream) is dropped instead of executed.
 */
function parseInvokeCalls(segment: string, patterns: InvokePatterns): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  patterns.invokeOpen.lastIndex = 0;
  const invokes = [...segment.matchAll(patterns.invokeOpen)];
  for (let index = 0; index < invokes.length; index += 1) {
    const match = invokes[index];
    const bodyStart = match.index + match[0].length;
    const nextInvoke = invokes[index + 1]?.index ?? Number.POSITIVE_INFINITY;
    const invokeClose = matchAfter(patterns.invokeClose, segment, bodyStart);
    const bodyEnd = patterns.wrapperCloses.reduce((end, pattern) => {
      const close = matchAfter(pattern, segment, bodyStart);
      return close && close.index < end ? close.index : end;
    }, Math.min(nextInvoke, invokeClose?.index ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(bodyEnd)) continue;
    const name = attributeValue(match[1], "name")?.trim();
    if (!name) continue;
    const args: Record<string, any> = {};
    const body = segment.slice(bodyStart, bodyEnd);
    patterns.paramOpen.lastIndex = 0;
    const parameters = [...body.matchAll(patterns.paramOpen)];
    for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
      const parameter = parameters[parameterIndex];
      const rawStart = parameter.index + parameter[0].length;
      const nextParameter = parameters[parameterIndex + 1]?.index ?? Number.POSITIVE_INFINITY;
      const closeMatch = matchAfter(patterns.paramClose, body, rawStart);
      // A close tag after the next parameter open belongs to that parameter, not to this
      // one, so only a close that comes first terminates this value.
      const parameterClose = closeMatch && closeMatch.index < nextParameter ? closeMatch : null;
      const selfClosing = parameter[2] === "/";
      const rawEnd = Math.min(nextParameter, parameterClose?.index ?? body.length, body.length);
      const parameterName = attributeValue(parameter[1], "name")?.trim();
      if (!parameterName) continue;
      const stringFlag = attributeValue(parameter[1], "string")?.trim().toLowerCase();
      // A self-closing tag carries no value at all; its "/" was consumed by the marker pattern.
      const raw = selfClosing ? "" : body.slice(rawStart, rawEnd);
      // With a closing tag the value is exact; otherwise it ends at the invoke or wrapper
      // bound, where the surrounding padding is formatting rather than content.
      if (stringFlag === "true") args[parameterName] = selfClosing || parameterClose ? raw : raw.trimEnd();
      else {
        try { args[parameterName] = JSON.parse(raw.trim()); }
        catch { args[parameterName] = raw.trim(); }
      }
    }

    const separator = name.indexOf("::");
    const namespace = separator > 0 && separator === name.lastIndexOf("::") ? name.slice(0, separator) : null;
    const functionName = namespace ? name.slice(separator + 2) : name;
    const call: ParsedToolCall = {
      id: "call_" + randomUUID().replaceAll("-", "").slice(0, 24),
      type: "function",
      function: { name: functionName, arguments: JSON.stringify(args) },
    };
    if (namespace) call.namespace = namespace;
    calls.push(call);
  }
  return calls;
}

export function parseDsmlCalls(segment: string): ParsedToolCall[] {
  return parseInvokeCalls(normalizeDsmlText(segment), DSML_PATTERNS);
}

/** Official template envelope: DSML-prefixed or bare-pipe invoke/parameter tags. */
function parseOfficialCalls(segment: string): ParsedToolCall[] {
  return parseInvokeCalls(normalizeDsmlText(segment), OFFICIAL_PATTERNS);
}

function normalizeDsmlText(value: unknown): string {
  return String(value ?? "")
    .replace(new RegExp("[" + String.fromCharCode(0x201C, 0x201D, 0xFF02) + "]", "gu"), String.fromCharCode(34))
    .replace(new RegExp("[" + String.fromCharCode(0x2018, 0x2019) + "]", "gu"), String.fromCharCode(39))
    .replace(ZERO_WIDTH_RE, "")
    .replace(ESCAPED_MARKER_RE, "");
}

function attributeValue(attributes: unknown, name: string): string | null {
  const pattern = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'iu');
  const match = pattern.exec(String(attributes ?? ''));
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : null;
}

function matchAfter(pattern: RegExp, text: string, start: number): RegexMatch | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(text.slice(start));
  return match ? { ...match, index: start + match.index } as RegexMatch : null;
}

function firstMatch(pattern: RegExp, text: string): RegexMatch | null {
  pattern.lastIndex = 0;
  return pattern.exec(text);
}

function findToolCallsBegin(text: string): { kind: string; index: number; text: string } | null {
  const candidates: Array<{ kind: string; match: RegexMatch }> = [];
  const begin = firstMatch(DSML_BEGIN_RE, text);
  if (begin) candidates.push({ kind: "wrapper", match: begin });
  const plain = firstMatch(TOOL_CALLS_BEGIN_RE, text);
  if (plain) candidates.push({ kind: "wrapper", match: plain });
  // The official chat-template envelope is a distinct, gated kind: only text inside it may
  // use bare pipe-prefixed invoke/parameter markers without the DSML literal.
  const official = firstMatch(OFFICIAL_BEGIN_RE, text);
  if (official) candidates.push({ kind: "official", match: official });
  const invoke = firstMatch(DSML_INVOKE_OPEN_RE, text);
  if (invoke) candidates.push({ kind: "invoke", match: invoke });
  if (candidates.length === 0) return null;
  const best = candidates.reduce((current, item) => item.match.index < current.match.index ? item : current);
  const index = best.match.index > 0 && text[best.match.index - 1] === String.fromCharCode(92) ? best.match.index - 1 : best.match.index;
  return { kind: best.kind, index, text: best.match[0] };
}

export function parseToolCallsFromText(text: unknown): { content: any; toolCalls: ParsedToolCall[] | null } {
  const source = String(text ?? "");
  const match = findToolCallsBegin(source);
  if (!match) return { content: text, toolCalls: null };
  if (match.kind === "official") {
    const segmentStart = match.index + match.text.length;
    const end = matchAfter(OFFICIAL_END_RE, source, segmentStart);
    // Bound the relaxed region to the matching end marker so nothing after it is parsed.
    const segment = end ? source.slice(segmentStart, end.index + end[0].length) : source.slice(segmentStart);
    const officialCalls = parseOfficialCalls(segment);
    return officialCalls.length > 0 ? { content: source.slice(0, match.index), toolCalls: officialCalls } :
      { content: text, toolCalls: null };
  }
  const segmentStart = match.kind === "invoke" ? match.index : match.index + match.text.length;
  const toolCalls = parseDsmlCalls(source.slice(segmentStart));
  return toolCalls.length > 0 ? { content: source.slice(0, match.index), toolCalls } :
    { content: text, toolCalls: null };
}

function mergeToolCalls(...groups: ReadonlyArray<readonly ParsedToolCall[] | null | undefined>): ParsedToolCall[] {
  const merged: ParsedToolCall[] = [];
  const seen = new Set();
  for (const calls of groups) {
    for (const call of calls ?? []) {
      const key = String(call?.namespace ?? call?.function?.namespace ?? '') + '\n' +
        String(call?.function?.name ?? '') + '\n' + String(call?.function?.arguments ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(call);
    }
  }
  return merged;
}

function isPartialToolMarker(value: unknown): boolean {
  let normalized = String(value ?? "").replace(new RegExp("^" + String.fromCharCode(92, 92), "u"), "").replaceAll("｜", "|")
    .replace(ZERO_WIDTH_RE, "").replaceAll(String.fromCharCode(0x2581), "_")
    .replace(new RegExp("[ " + String.fromCharCode(9, 10, 13, 12, 11) + "]+", "gu"), "").toLowerCase();
  normalized = normalized.replace(new RegExp("^<[|_]+", "u"), "<|").replace(new RegExp("^<[|_]dsml[|_]+", "u"), "<|dsml|");
  if (!normalized.startsWith("<") || normalized.includes(">")) return false;
  const block = String.fromCharCode(0x2581);
  const starts = [
    "<tool_calls", "<tool_call", "<tool" + block + "calls",
    "<|dsml|calls", "<|dsml|tool_calls", "<|dsml|toolcalls",
    "<|dsml|tool_call", "<|dsml|function_calls", "<|dsml|functioncalls", "<|dsml|invoke",
    "<|dsml|parameter", "<|invoke", "<|parameter",
    "<|tool" + block + "calls" + block + "begin", "<|tool" + block + "calls" + block + "end",
    "<|tool_calls_begin", "<|tool_calls_end", "<|toolcallsbegin",
  ];
  return starts.some(start => start.startsWith(normalized) || normalized.startsWith(start));
}

function markerHoldback(text: string): number {
  const start = text.lastIndexOf('<');
  if (start < 0) return 0;
  const actualStart = start > 0 && text[start - 1] === '\\' ? start - 1 : start;
  const candidate = text.slice(actualStart);
  return isPartialToolMarker(candidate) ? text.length - actualStart : 0;
}

class DsmlStreamParser {
  declare buffer: string;
  declare toolBuffer: string;
  declare inToolCall: boolean;
  constructor() {
    this.buffer = '';
    this.toolBuffer = '';
    this.inToolCall = false;
  }
  feed(text: string): string {
    if (!text) return '';
    if (this.inToolCall) {
      this.toolBuffer += text;
      return '';
    }
    this.buffer += text;
    const match = findToolCallsBegin(this.buffer);
    if (match) {
      const before = this.buffer.slice(0, match.index);
      const visible = before.trim() ? before : '';
      this.toolBuffer = this.buffer.slice(match.index);
      this.buffer = '';
      this.inToolCall = true;
      return visible;
    }
    const markerHold = markerHoldback(this.buffer);
    const whitespaceHold = markerHold === 0 ? (this.buffer.match(/\s*$/u)?.[0].length ?? 0) : 0;
    const safeLength = this.buffer.length - Math.max(markerHold, whitespaceHold);
    if (safeLength <= 0) return '';
    const visible = this.buffer.slice(0, safeLength);
    this.buffer = this.buffer.slice(safeLength);
    return visible;
  }
  finish(): { content: string; toolCalls: ParsedToolCall[] | null } {
    if (this.inToolCall) {
      const text = this.toolBuffer;
      this.toolBuffer = '';
      this.inToolCall = false;
      return parseToolCallsFromText(text);
    }
    const content = this.buffer;
    this.buffer = '';
    return { content, toolCalls: null };
  }
  drainRaw(): string {
    const content = this.buffer + this.toolBuffer;
    this.buffer = '';
    this.toolBuffer = '';
    this.inToolCall = false;
    return content;
  }
}

export function transformToolCallJson(data: JsonObject, metadata: ResponseTransformMetadata): JsonObject {
  const output = { ...data };
  output.choices = Array.isArray(data.choices) ? data.choices.map((choice: any) => {
    if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') return choice;
    const result = { ...choice, message: { ...choice.message } };
    const message = result.message;
    const observedReasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;
    if (metadata.contentPrefix && (message.content == null || typeof message.content === 'string')) {
      message.content = metadata.contentPrefix + (message.content ?? '');
    }
    if (metadata.reasoningPrefix && (message.reasoning_content == null || typeof message.reasoning_content === 'string')) {
      message.reasoning_content = metadata.reasoningPrefix + (message.reasoning_content ?? '');
    }
    if (metadata.extractOutput === true && typeof message.content === 'string') {
      const extracted = extractOutputText(message.content, { assumeBody: observedReasoning });
      if (extracted.switched) {
        message.content = extracted.content || null;
        if (extracted.reasoning) {
          message.reasoning_content = (typeof message.reasoning_content === 'string' ? message.reasoning_content : '') +
            extracted.reasoning;
        }
      }
    }
    if (metadata.extractOutput === true && typeof message.reasoning_content === 'string') {
      const fallback = extractTaggedOutputFallback(message.reasoning_content);
      const contentEmpty = typeof message.content !== 'string' || message.content.trim() === '';
      if (contentEmpty && fallback.matched) message.content = fallback.content;
      message.reasoning_content = (contentEmpty && fallback.matched ? fallback.reasoning :
        stripExtractionSpecialTokens(message.reasoning_content)) || null;
    }
    let reasoningToolCalls = null;
    if (typeof message.reasoning_content === 'string') {
      const parsed = parseToolCallsFromText(message.reasoning_content);
      if (parsed.toolCalls) {
        message.reasoning_content = (metadata.extractOutput === true ?
          stripExtractionSpecialTokens(parsed.content) : parsed.content) || null;
        reasoningToolCalls = parsed.toolCalls;
      }
    }
    let contentToolCalls = null;
    if (typeof message.content === 'string') {
      const parsed = parseToolCallsFromText(message.content);
      if (parsed.toolCalls) {
        message.content = parsed.content.trim() ? parsed.content : null;
        contentToolCalls = parsed.toolCalls;
      }
    }
    const captured = mergeToolCalls(message.tool_calls, reasoningToolCalls, contentToolCalls);
    if (captured.length > 0) {
      message.tool_calls = captured;
      result.finish_reason = 'tool_calls';
    }
    return result;
  }) : data.choices;
  return output;
}

class ChoiceState {
  declare index: number;
  declare metadata: ResponseTransformMetadata;
  declare started: boolean;
  declare finished: boolean;
  declare parser: DsmlStreamParser;
  declare reasoningParser: DsmlStreamParser;
  declare extractor: OutputExtractionStream | null;
  declare nativeReasoningBuffer: string;
  declare reasoningToolCalls: ParsedToolCall[];
  declare bodyObserved: boolean;
  declare template: JsonObject;
  constructor(index: number, metadata: ResponseTransformMetadata) {
    this.index = index;
    this.metadata = metadata;
    this.started = false;
    this.finished = false;
    this.parser = new DsmlStreamParser();
    this.reasoningParser = new DsmlStreamParser();
    this.extractor = metadata.extractOutput === true ? createOutputExtractionStream() : null;
    this.nativeReasoningBuffer = '';
    this.reasoningToolCalls = [];
    this.bodyObserved = false;
    this.template = {};
  }
  transform(choice: any, forceFinal = false): any {
    if (this.finished) return choice;
    const result = { ...choice };
    const delta = { ...(choice.delta ?? {}) };
    const final = forceFinal || choice.finish_reason != null;
    const nativeReasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0;
    let extractedReasoning = '';
    if (nativeReasoning && this.extractor) {
      const forced = this.extractor.assumeBody();
      extractedReasoning += forced.reasoning;
    }
    if (!this.started) {
      this.started = true;
      if (this.metadata.reasoningPrefix &&
          (delta.reasoning_content == null || typeof delta.reasoning_content === 'string')) {
        delta.reasoning_content = this.metadata.reasoningPrefix + (delta.reasoning_content ?? '');
      }
      if (this.metadata.contentPrefix && (delta.content == null || typeof delta.content === 'string')) {
        delta.content = this.metadata.contentPrefix + (delta.content ?? '');
      }
    }
    if (typeof delta.reasoning_content === 'string') {
      if (this.extractor) {
        // Keep native reasoning streaming. A shadow copy is inspected only when the
        // choice ends, so fallback body/tool extraction can finish before [DONE]
        // without holding every reasoning delta.
        this.nativeReasoningBuffer += delta.reasoning_content;
      } else {
        const reasoningVisible = this.reasoningParser.feed(delta.reasoning_content);
        if (reasoningVisible) delta.reasoning_content = reasoningVisible;
        else delete delta.reasoning_content;
      }
    }
    let visible = '';
    if (typeof delta.content === 'string') {
      const extracted = this.extractor ? this.extractor.push(delta.content) : { reasoning: '', content: delta.content };
      extractedReasoning += extracted.reasoning;
      if (extracted.content.trim()) this.bodyObserved = true;
      visible = this.parser.feed(extracted.content);
      delete delta.content;
    }
    if (final) {
      if (this.extractor) {
        const tail = this.extractor.finish();
        extractedReasoning += tail.reasoning;
        if (tail.content.trim()) this.bodyObserved = true;
        visible += this.parser.feed(tail.content);
      }
      if (this.nativeReasoningBuffer) {
        const fallback = extractTaggedOutputFallback(this.nativeReasoningBuffer);
        if (!this.bodyObserved && fallback.matched) {
          this.bodyObserved = fallback.content.trim().length > 0;
          visible += this.parser.feed(fallback.content);
        } else {
          const parsedReasoning = parseToolCallsFromText(this.nativeReasoningBuffer);
          if (parsedReasoning.toolCalls) {
            this.reasoningToolCalls = mergeToolCalls(this.reasoningToolCalls, parsedReasoning.toolCalls);
          }
        }
        this.nativeReasoningBuffer = '';
      }
      if (!this.extractor) {
        const parsedReasoning = this.reasoningParser.finish();
        if (parsedReasoning.content) {
          delta.reasoning_content = (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') +
            parsedReasoning.content;
        }
        this.reasoningToolCalls = mergeToolCalls(this.reasoningToolCalls, parsedReasoning.toolCalls);
      }
      const parsed = this.parser.finish();
      visible += parsed.content;
      const captured = mergeToolCalls(this.reasoningToolCalls, parsed.toolCalls);
      if (captured.length > 0) {
        delta.tool_calls = captured.map((call, index) => ({ index, ...call }));
        result.finish_reason = 'tool_calls';
      }
      this.finished = true;
    }
    if (extractedReasoning) {
      delta.reasoning_content = (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') +
        extractedReasoning;
    }
    if (visible) delta.content = visible;
    result.delta = delta;
    return result;
  }
  drainRaw(): { content: string; reasoning: string } {
    let reasoning = '';
    let visible = '';
    if (this.extractor) {
      const tail = this.extractor.finish();
      reasoning = tail.reasoning;
      visible = this.parser.feed(tail.content);
    }
    this.nativeReasoningBuffer = '';
    reasoning += this.reasoningParser.drainRaw();
    visible += this.parser.drainRaw();
    return { content: visible, reasoning };
  }
}

function sseData(event: string): string | null {
  const values = [];
  for (const line of event.split(/\r?\n/u)) {
    if (line === 'data') values.push('');
    else if (line.startsWith('data:')) values.push(line.slice(5).replace(/^ /u, ''));
  }
  return values.length > 0 ? values.join('\n') : null;
}
function encodeSse(value: unknown): string {
  return 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
}
function syntheticChunk(template: JsonObject, choice: any): JsonObject {
  const chunk: JsonObject = {};
  for (const [key, value] of Object.entries(template)) if (key !== 'choices' && key !== 'usage') chunk[key] = value;
  chunk.choices = [choice];
  return chunk;
}

function createSseTransform(metadata: ResponseTransformMetadata): TransformStream {
  const states = new Map<number, ChoiceState>();
  let buffer = '';
  let errored = false;
  function transformPayload(payload: string | null, rawEvent: string, controller: { enqueue(chunk: string): void }): void {
    if (payload == null) {
      controller.enqueue(rawEvent + '\n\n');
      return;
    }
    if (payload.trim() === '[DONE]') {
      if (!errored) {
        for (const state of states.values()) {
          if (state.finished) continue;
          const choice = state.transform({ index: state.index, delta: {}, finish_reason: null }, true);
          if (Object.keys(choice.delta ?? {}).length > 0 || choice.finish_reason != null) {
            controller.enqueue(encodeSse(syntheticChunk(state.template, choice)));
          }
        }
      }
      controller.enqueue(encodeSse('[DONE]'));
      return;
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch {
      controller.enqueue(rawEvent + '\n\n');
      return;
    }
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      controller.enqueue(encodeSse(chunk));
      return;
    }
    if (Object.hasOwn(chunk, 'error')) {
      errored = true;
      controller.enqueue(encodeSse(chunk));
      return;
    }
    if (errored || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
      controller.enqueue(encodeSse(chunk));
      return;
    }
    const choices = chunk.choices.map((choice: any) => {
      if (!choice || typeof choice !== 'object' || !choice.delta || typeof choice.delta !== 'object') return choice;
      const index = choice.index ?? 0;
      let state = states.get(index);
      if (!state) {
        state = new ChoiceState(index, metadata);
        states.set(index, state);
      }
      state.template = chunk;
      return state.transform(choice);
    });
    controller.enqueue(encodeSse({ ...chunk, choices }));
  }
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      while (true) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (!match) break;
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        transformPayload(sseData(rawEvent), rawEvent, controller);
      }
    },
    flush(controller) {
      if (buffer) {
        transformPayload(sseData(buffer), buffer, controller);
        buffer = '';
      }
      if (!errored) {
        for (const state of states.values()) {
          if (state.finished) continue;
          const drained = state.drainRaw();
          if (drained.content || drained.reasoning) {
            controller.enqueue(encodeSse(syntheticChunk(state.template, {
              index: state.index,
              delta: {
                ...(drained.reasoning ? { reasoning_content: drained.reasoning } : {}),
                ...(drained.content ? { content: drained.content } : {}),
              },
              finish_reason: null,
            })));
          }
        }
      }
    },
  });
}

function transformedHeaders(response: Response, contentType?: string): Headers {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

export async function transformToolCallResponse(response: Response, metadata: ResponseTransformMetadata): Promise<Response> {
  if (!response || response.status !== 200) return response;
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/event-stream') && response.body) {
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSseTransform(metadata))
      .pipeThrough(new TextEncoderStream());
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: transformedHeaders(response, contentType),
    });
  }
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: transformedHeaders(response),
    });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, 'error') ||
      !Array.isArray((data as JsonObject).choices)) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: transformedHeaders(response),
    });
  }
  return new Response(JSON.stringify(transformToolCallJson(data as JsonObject, metadata)), {
    status: response.status,
    statusText: response.statusText,
    headers: transformedHeaders(response, 'application/json; charset=utf-8'),
  });
}