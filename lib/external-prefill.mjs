import { isUserAuthored } from './compaction.mjs';
export const DYNAMIC_PREFILL_ID = 'dshDynamicPrefill';
export function trackPrefillTurns(ctx) {
    const turns = new Map();
    ctx.effect(() => () => {
        for (const row of turns.values())
            row.controller.abort(new Error('预填充服务已停用'));
        turns.clear();
    });
    ctx.on('session/event', (session, event) => {
        const sessionId = session?.id;
        if (!sessionId || !['turn/start', 'turn/end', 'agent-preset/selected'].includes(event.type))
            return;
        turns.get(sessionId)?.controller.abort(new Error('动态预填充所属轮次已结束或模式已变化'));
        turns.delete(sessionId);
        if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
            turns.set(sessionId, { turn: event.data.turn, controller: new AbortController() });
        }
    });
    ctx.on('agent/request', async (payload, next) => {
        const sessionId = payload.agent?.session?.id;
        const record = sessionId && turns.get(sessionId);
        const result = await next();
        if (record && record.turn === payload.turn && !payload.signal?.aborted && Number.isSafeInteger(payload.step)) {
            record.first ??= payload.step;
            record.step = payload.step;
            record.signal = payload.signal;
        }
        return result;
    });
    return (options) => {
        const record = options.sessionId && turns.get(options.sessionId);
        if (!record || !options.signal || record.signal !== options.signal || record.step === undefined)
            return { phase: 'unknown' };
        return { phase: record.step === record.first ? 'first' : 'continuation', turnId: String(record.turn), step: record.step, turnSignal: record.controller.signal };
    };
}
/** Discard inline reasoning, including unmatched opening tags. */
function plainText(text) {
    const tags = /<(\/?)(think|thinking|reasoning)\b[^>]*(?:>|$)/gi;
    const open = [];
    let start = 0, result = '';
    for (const match of text.matchAll(tags)) {
        if (!open.length)
            result += text.slice(start, match.index);
        const tag = match[2].toLowerCase();
        if (!match[1])
            open.push(tag);
        else if (open.at(-1) === tag)
            open.pop();
        start = match.index + match[0].length;
    }
    return (result + (open.length ? '' : text.slice(start))).trim();
}
const NON_DIALOGUE_SOURCES = new Set(['plugin', 'system-prompt', 'runtime-context', 'tool', 'developer', 'compact-checkpoint']);
export function projectConversationMessage(message) {
    const user = isUserAuthored(message);
    if (!user && message.role !== 'assistant')
        return;
    if (NON_DIALOGUE_SOURCES.has(message.source?.kind ?? '') ||
        message.content?.some(block => block.type === 'tool-call' || block.type === 'tool-result'))
        return;
    const text = plainText((message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'));
    return { role: user ? 'user' : 'assistant', text };
}
export function conversationText(history, count, maxChars) {
    const turns = [];
    let current = [];
    // Work backwards so old history outside the configured window is never copied.
    for (let index = history.length - 1; index >= 0 && turns.length < count; index--) {
        const row = projectConversationMessage(history[index]);
        if (!row)
            continue;
        if (row.text)
            current.push(row);
        if (row.role === 'user') {
            turns.push(current.reverse());
            current = [];
        }
    }
    const selected = turns.reverse();
    if (selected.reduce((total, turn) => total + turn.reduce((n, message) => n + message.text.length, 0), 0) > maxChars) {
        throw new Error('预填充对话正文超过配置的字符上限');
    }
    return selected;
}
