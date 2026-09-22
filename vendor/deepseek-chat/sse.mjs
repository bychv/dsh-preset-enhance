/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm-deepseek/src/protocols/chat-completions/sse.ts (eventsource-parser replaced by a local parser)
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports), plugin-owned connection config.
 */
import { LlmError } from './errors.mjs';
/** The terminal payload DeepSeek (and OpenAI) send after the last chunk. */
export const DONE = '[DONE]';
/**
 * Local replacement for eventsource-parser: incremental SSE framing over a byte
 * stream. Text is decoded incrementally (chunk boundaries may split a UTF-8
 * sequence), a leading BOM is dropped, CRLF/CR/LF all terminate a line, comment
 * (`:`) and non-`data` fields are skipped, multiple data lines of one event join
 * with a newline, and an event dispatches only on its blank-line terminator.
 */
export function createSseDecoder(onComment) {
    const decoder = new TextDecoder();
    let buffer = '';
    let bom = true;
    const events = [];
    const dispatch = (rawEvent) => {
        const dataLines = [];
        for (const line of rawEvent.split(/\r\n|\r|\n/u)) {
            if (line.length === 0)
                continue;
            if (line.startsWith(':')) {
                onComment?.(line.slice(1).trim());
                continue;
            }
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            if (field !== 'data')
                continue;
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' '))
                value = value.slice(1);
            dataLines.push(value);
        }
        if (dataLines.length > 0)
            events.push(dataLines.join('\n'));
    };
    const drain = () => {
        for (;;) {
            const match = /\r\n\r\n|\r\r|\n\n/u.exec(buffer);
            if (match === null)
                return;
            const rawEvent = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            dispatch(rawEvent);
        }
    };
    return {
        push(chunk) {
            let text = decoder.decode(chunk, { stream: true });
            if (bom) {
                bom = false;
                if (text.startsWith('\uFEFF'))
                    text = text.slice(1);
            }
            buffer += text;
            events.length = 0;
            drain();
            return [...events];
        },
        flush() {
            buffer += decoder.decode();
            events.length = 0;
            drain();
            // A non-terminated tail is truncation, not a flushable payload.
            buffer = '';
            return [...events];
        },
    };
}
/**
 * Parse an SSE byte stream into data payloads. Yields DONE as the final value and
 * returns; throws LlmError STREAM_CLOSED when the stream ends without it.
 */
export async function* parseSse(stream, onComment) {
    const reader = stream.getReader();
    const decoder = createSseDecoder(onComment);
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            for (const payload of decoder.push(value)) {
                yield payload;
                if (payload === DONE)
                    return;
            }
        }
        for (const payload of decoder.flush()) {
            yield payload;
            if (payload === DONE)
                return;
        }
    }
    finally {
        reader.releaseLock();
    }
    throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}
