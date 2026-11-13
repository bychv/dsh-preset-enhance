import { isUserAuthored } from './compaction.mjs';
import type { PluginContext, StreamOptions } from '../host-types.mjs';
import type { PrefillContextV1 } from '../template-api.mjs';
import type { HostMessage } from './types.mjs';

export const DYNAMIC_PREFILL_ID = 'dshDynamicPrefill';
type Phase = Pick<PrefillContextV1, 'phase' | 'turnId' | 'step'> & { turnSignal?: AbortSignal };

export function trackPrefillTurns(ctx: PluginContext) {
  const turns = new Map<string, { turn: number; first?: number; step?: number; signal?: AbortSignal; controller: AbortController }>();
  ctx.effect(() => () => {
    for (const row of turns.values()) row.controller.abort(new Error('预填充服务已停用'));
    turns.clear();
  });
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!sessionId || !['turn/start', 'turn/end', 'agent-preset/selected'].includes(event.type)) return;
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
  return (options: StreamOptions): Phase => {
    const record = options.sessionId && turns.get(options.sessionId);
    if (!record || !options.signal || record.signal !== options.signal || record.step === undefined) return { phase: 'unknown' };
    return { phase: record.step === record.first ? 'first' : 'continuation', turnId: String(record.turn), step: record.step, turnSignal: record.controller.signal };
  };
}

/** Discard inline reasoning, including unmatched opening tags. */
function plainText(text: string): string {
  const tags = /<(\/?)(think|thinking|reasoning)\b[^>]*(?:>|$)/gi;
  const open: string[] = [];
  let start = 0, result = '';
  for (const match of text.matchAll(tags)) {
    if (!open.length) result += text.slice(start, match.index);
    const tag = match[2].toLowerCase();
    if (!match[1]) open.push(tag);
    else if (open.at(-1) === tag) open.pop();
    start = match.index + match[0].length;
  }
  return (result + (open.length ? '' : text.slice(start))).trim();
}

export function conversationText(history: HostMessage[], count: number, maxChars: number): PrefillContextV1['turns'] {
  const turns: { role: 'user' | 'assistant'; text: string }[][] = [];
  let current: typeof turns[number] = [];
  // Work backwards so old history outside the configured window is never copied.
  for (let index = history.length - 1; index >= 0 && turns.length < count; index--) {
    const message = history[index];
    const user = isUserAuthored(message);
    if (!user && message.role !== 'assistant') continue;
    if (['plugin', 'system-prompt', 'runtime-context', 'tool', 'developer', 'compact-checkpoint'].includes(message.source?.kind ?? '') ||
        message.content?.some(block => block.type === 'tool-call' || block.type === 'tool-result')) continue;
    const text = plainText((message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'));
    if (text) current.push({ role: user ? 'user' : 'assistant', text });
    if (user) { turns.push(current.reverse()); current = []; }
  }
  const selected = turns.reverse();
  if (selected.reduce((total, turn) => total + turn.reduce((n, message) => n + message.text.length, 0), 0) > maxChars) {
    throw new Error('预填充对话正文超过配置的字符上限');
  }
  return selected;
}
