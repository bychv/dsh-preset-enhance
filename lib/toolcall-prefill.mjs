import { randomUUID } from 'node:crypto';
import {
  createOutputExtractionStream,
  extractOutputText,
  extractTaggedOutputFallback,
  stripExtractionSpecialTokens,
} from './output-extractor.mjs';

const D = '｜｜DSML｜｜';
export const DSML_CALLS_OPEN = '<' + D + ' calls>';
export const DSML_CALLS_CLOSE = '</' + D + ' calls>';
export const TOOL_CALLS_OPEN = '<tool_calls>';
export const TOOL_CALLS_CLOSE = '</tool_calls>';

const DSML_BEGIN_RE = /<[｜|]+\s*DSML\s*[｜|]+\s*calls\s*>/u;
const TOOL_CALLS_BEGIN_RE = /\\?<tool_calls\s*>/iu;
const DSML_INVOKE_RE = /<[｜|]+\s*DSML\s*[｜|]+\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]+\s*invoke\s*>/gu;
const DSML_PARAM_RE = /<[｜|]+\s*DSML\s*[｜|]+\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]+\s*parameter\s*>/gu;
const DATA_URI_RE = /data:(image\/[\w.+-]+);base64,[A-Za-z0-9+/=]{100,}/gu;
const B64_BODY_RE = /^[A-Za-z0-9+/=\s]{200,}$/u;
const B64_MAGIC = new Map([
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
]);

function sniffBase64Mime(value) {
  for (const [magic, mime] of B64_MAGIC) if (value.startsWith(magic)) return mime;
  return null;
}

function harvestString(value, images) {
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

function harvestImages(value, images) {
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
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'b64_json' && typeof item === 'string' && item.length > 200) {
      const mime = sniffBase64Mime(item) || 'image/png';
      images.push('data:' + mime + ';base64,' + item);
      output[key] = '[Image #' + images.length + ' attached]';
    } else output[key] = harvestImages(item, images);
  }
  return output;
}

function toolResultContent(content) {
  const images = [];
  let cleaned;
  if (typeof content === 'string') {
    const compact = content.trim();
    if (compact.startsWith('{') || compact.startsWith('[')) {
      try { cleaned = harvestImages(JSON.parse(compact), images); }
      catch { cleaned = harvestString(content, images); }
    } else cleaned = harvestString(content, images);
  } else cleaned = harvestImages(content, images);
  return { text: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned), images };
}

function toolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return {};
  return tool.function && typeof tool.function === 'object' ? tool.function : tool;
}

export function buildToolsPrompt(tools) {
  const lines = ['## Tools', '', 'You have access to the following tools:', ''];
  for (const tool of tools) {
    const fn = toolDefinition(tool);
    lines.push('### ' + String(fn.name ?? ''));
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

function argumentObject(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return { _raw: value }; }
  }
  if (parsed == null) return {};
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _raw: parsed };
}

export function renderDsmlCall(name, argumentsValue) {
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

export function inlineToolHistory(messages) {
  const output = [];
  const toolNames = new Map();
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = [];
      for (const toolCall of message.tool_calls) {
        const fn = toolCall?.function ?? {};
        const name = String(fn.name ?? '');
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

export function emulateToolCallRequest(body) {
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

export function parseDsmlCalls(segment) {
  segment = String(segment ?? '').replace(/\\(?=<\/?(?:tool_calls|[｜|]+\s*DSML\b))/giu, '');
  const calls = [];
  for (const match of segment.matchAll(DSML_INVOKE_RE)) {
    const args = {};
    for (const parameter of match[2].matchAll(DSML_PARAM_RE)) {
      const [, name, stringFlag, raw] = parameter;
      if (stringFlag === 'false') {
        try { args[name] = JSON.parse(raw.trim()); } catch { args[name] = raw.trim(); }
      } else args[name] = raw;
    }
    calls.push({
      id: 'call_' + randomUUID().replaceAll('-', '').slice(0, 24),
      type: 'function',
      function: { name: match[1], arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

function findToolCallsBegin(text) {
  const dsml = DSML_BEGIN_RE.exec(text);
  const wrapped = TOOL_CALLS_BEGIN_RE.exec(text);
  if (!dsml) return wrapped;
  if (!wrapped) return dsml;
  return dsml.index <= wrapped.index ? dsml : wrapped;
}

export function parseToolCallsFromText(text) {
  const normalized = String(text ?? '').replace(/\\(?=<\/?(?:tool_calls|[｜|]+\s*DSML\b))/giu, '');
  const match = findToolCallsBegin(normalized);
  if (!match) return { content: text, toolCalls: null };
  const toolCalls = parseDsmlCalls(normalized.slice(match.index + match[0].length));
  return toolCalls.length > 0 ? { content: normalized.slice(0, match.index), toolCalls } :
    { content: text, toolCalls: null };
}

function mergeToolCalls(...groups) {
  const merged = [];
  const seen = new Set();
  for (const calls of groups) {
    for (const call of calls ?? []) {
      const key = String(call?.function?.name ?? '') + '\n' + String(call?.function?.arguments ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(call);
    }
  }
  return merged;
}

function isPartialDsmlBegin(value) {
  if (!value.startsWith('<')) return false;
  let rest = value.slice(1);
  if (!rest) return true;
  let index = 0;
  while (index < rest.length && '｜|'.includes(rest[index])) index += 1;
  if (index === 0) return false;
  rest = rest.slice(index).trimStart();
  if (!rest) return true;
  const first = 'DSML';
  if (rest.length < first.length) return first.startsWith(rest);
  if (!rest.startsWith(first)) return false;
  rest = rest.slice(first.length).trimStart();
  if (!rest) return true;
  index = 0;
  while (index < rest.length && '｜|'.includes(rest[index])) index += 1;
  if (index === 0) return false;
  rest = rest.slice(index).trimStart();
  if (!rest) return true;
  const second = 'calls';
  if (rest.length < second.length) return second.startsWith(rest);
  if (!rest.startsWith(second)) return false;
  return rest.slice(second.length).trimStart() === '';
}

function isPartialToolCallsBegin(value) {
  const normalized = value.startsWith('\\') ? value.slice(1) : value;
  return TOOL_CALLS_OPEN.startsWith(normalized.toLowerCase());
}

function markerHoldback(text) {
  const start = text.lastIndexOf('<');
  if (start < 0) return 0;
  const actualStart = start > 0 && text[start - 1] === '\\' ? start - 1 : start;
  const candidate = text.slice(actualStart);
  return isPartialDsmlBegin(text.slice(start)) || isPartialToolCallsBegin(candidate) ?
    text.length - actualStart : 0;
}

class DsmlStreamParser {
  constructor() {
    this.buffer = '';
    this.toolBuffer = '';
    this.inToolCall = false;
  }
  feed(text) {
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
  finish() {
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
  drainRaw() {
    const content = this.buffer + this.toolBuffer;
    this.buffer = '';
    this.toolBuffer = '';
    this.inToolCall = false;
    return content;
  }
}

export function transformToolCallJson(data, metadata) {
  const output = { ...data };
  output.choices = Array.isArray(data.choices) ? data.choices.map(choice => {
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
  constructor(index, metadata) {
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
  transform(choice, forceFinal = false) {
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
  drainRaw() {
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

function sseData(event) {
  const values = [];
  for (const line of event.split(/\r?\n/u)) {
    if (line === 'data') values.push('');
    else if (line.startsWith('data:')) values.push(line.slice(5).replace(/^ /u, ''));
  }
  return values.length > 0 ? values.join('\n') : null;
}
function encodeSse(value) {
  return 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
}
function syntheticChunk(template, choice) {
  const chunk = {};
  for (const [key, value] of Object.entries(template)) if (key !== 'choices' && key !== 'usage') chunk[key] = value;
  chunk.choices = [choice];
  return chunk;
}

function createSseTransform(metadata) {
  const states = new Map();
  let buffer = '';
  let errored = false;
  function transformPayload(payload, rawEvent, controller) {
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
    const choices = chunk.choices.map(choice => {
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

function transformedHeaders(response, contentType) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

export async function transformToolCallResponse(response, metadata) {
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
  let data;
  try { data = JSON.parse(text); } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: transformedHeaders(response),
    });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, 'error') ||
      !Array.isArray(data.choices)) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: transformedHeaders(response),
    });
  }
  return new Response(JSON.stringify(transformToolCallJson(data, metadata)), {
    status: response.status,
    statusText: response.statusText,
    headers: transformedHeaders(response, 'application/json; charset=utf-8'),
  });
}
