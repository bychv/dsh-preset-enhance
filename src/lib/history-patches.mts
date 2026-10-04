import type { HistoryPatchV1 } from '../template-api.mjs';
import type { HostMessage } from './types.mjs';

export const isToolResult = (message: HostMessage | undefined) => message?.role === 'tool' ||
  message?.source?.kind === 'tool' || !!message?.content?.some(block => block.type === 'tool-result');

/** Boundaries before a result belong before its entire assistant call group. */
export function historyInsertionIndex(history: HostMessage[], depth: number): number {
  let index = Math.max(0, history.length - depth);
  if (isToolResult(history[index])) {
    while (index > 0 && isToolResult(history[index - 1])) index--;
    if (index > 0 && history[index - 1].role === 'assistant') index--;
  }
  return index;
}

/** Validate and copy the entire batch before any change can be applied. */
export function validateHistoryPatches(value: unknown, history: HostMessage[]): HistoryPatchV1[] {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!record(value) || Object.keys(value).some(key => key !== 'patches') || !Array.isArray(value.patches) || value.patches.length > 256) throw new Error('历史修改必须返回 { patches: [...] }，最多 256 项');
  let size = 0;
  return Array.from(value.patches, raw => {
    if (!record(raw) || !['insert', 'replace-text', 'append-text'].includes(String(raw.operation)) ||
      !Number.isSafeInteger(raw.depth) || (raw.depth as number) < 0 || typeof raw.text !== 'string') throw new Error('历史修改操作、深度或文本无效');
    size += raw.text.length;
    if (size > 200_000) throw new Error('历史修改文本超过 200,000 字符');
    const depth = raw.depth as number, text = raw.text;
    const keys = raw.operation === 'insert' ? ['operation', 'depth', 'role', 'text'] : ['operation', 'depth', 'text', 'textIndex'];
    if (Object.keys(raw).some(key => !keys.includes(key))) throw new Error('历史修改包含不支持的字段');
    if (raw.operation === 'insert') {
      if (!['system', 'user', 'assistant'].includes(String(raw.role))) throw new Error('历史插入角色无效');
      return { operation: 'insert', depth, role: raw.role as 'system' | 'user' | 'assistant', text };
    }
    const target = history[history.length - 1 - depth];
    if (!target || isToolResult(target)) throw new Error('历史修改目标不存在或为工具结果');
    const textIndex = raw.textIndex ?? 0;
    const count = target.content?.filter(block => block.type === 'text').length ?? 0;
    if (!Number.isSafeInteger(textIndex) || (textIndex as number) < 0 ||
      ((textIndex as number) >= count && !(raw.operation === 'append-text' && count === 0 && textIndex === 0))) throw new Error('历史修改 textIndex 超出原消息文本块范围');
    return { operation: raw.operation as 'replace-text' | 'append-text', depth, text, textIndex: textIndex as number };
  });
}

/** Copy changed messages only. All coordinates refer to the unmodified history. */
export function applyHistoryPatches(history: HostMessage[], patches: HistoryPatchV1[], seed: string) {
  const messages = history.slice();
  const insertions: Array<{ message: HostMessage; depth: number; order: number }> = [];
  for (const [ordinal, patch] of patches.entries()) {
    if (patch.operation === 'insert') {
      if (patch.text.trim()) insertions.push({ depth: patch.depth, order: 100,
        message: { id: `preset:${seed}:chatHistory:${ordinal}`, role: patch.role,
          content: [{ type: 'text', text: patch.text }], source: { kind: 'plugin', plugin: 'dsh-preset-enhance' } } });
      continue;
    }
    const index = history.length - 1 - patch.depth;
    const message = messages[index];
    const content = [...(message.content ?? [])];
    const positions = content.flatMap((block, i) => block.type === 'text' ? [i] : []);
    const position = positions[patch.textIndex ?? 0];
    if (position === undefined) content.push({ type: 'text', text: patch.text });
    else content[position] = { ...content[position], text: patch.operation === 'replace-text' ? patch.text : String(content[position].text ?? '') + patch.text };
    messages[index] = { ...message, content };
  }
  return { messages, insertions };
}
