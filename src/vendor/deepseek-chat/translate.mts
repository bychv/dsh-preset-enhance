/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline),
 * packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1.
 */

import { EMPTY_RESPONSE_CODE, LlmError } from './errors.mjs';
import { DONE } from './sse.mjs';
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from './host-types.mjs';
import type { WireChunk, WireUsage } from './wire-types.mjs';

interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  callId?: string | undefined;
  name?: string | undefined;
}

/** Wire finish_reason -> harness FinishReason (unknown values become error finishes). */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    default:
      return { kind: 'error', failure: { message: 'model stopped: ' + reason, code: reason.toUpperCase() } };
  }
}

/** Wire usage -> disjoint harness counts; DeepSeek prompt_tokens includes cache hits. */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const combined = usage.prompt_tokens + usage.completion_tokens;
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens)
    && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.completion_tokens)
    && usage.completion_tokens >= 0
    && Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined || usage.total_tokens === combined);
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  };
}

function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current;
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text };
    case 'reasoning': return { type: 'reasoning', text: block.text };
    default: return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text };
  }
}

export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textBlock: OpenBlock | undefined;
  let reasoningBlock: OpenBlock | undefined;
  const toolBlocks = new Map<number, OpenBlock>();
  const order: OpenBlock[] = [];
  let pendingFinish: FinishReason | undefined;
  let pendingUsage: TokenUsage | undefined;

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
      const reason: FinishReason = pendingFinish ?? { kind: 'stop' };
      yield { type: 'finish', reason: reason.kind === 'stop' && order.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
        : reason };
      return;
    }
    let chunk: WireChunk;
    try { chunk = JSON.parse(payload) as WireChunk; }
    catch { throw new LlmError('malformed SSE payload: ' + payload.slice(0, 120), 'MALFORMED_RESPONSE'); }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(call.index, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        block.callId = acceptIdentity(block.callId, call.id);
        block.name = acceptIdentity(block.name, call.function?.name);
        const fragment = call.function?.arguments ?? '';
        block.text += fragment;
        yield { type: 'tool-call-delta', index: block.index, id: block.callId ?? '',
          ...block.name !== undefined ? { name: block.name } : {}, argumentsDelta: fragment };
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}
