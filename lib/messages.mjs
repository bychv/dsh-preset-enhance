/**
 * Best-effort preset adaptation for the DSH 0.1.6 Messages protocol.
 *
 * DSH 0.1.6-alpha.2 defaults the official DeepSeek connection to the Messages
 * protocol, where the preset compatibility path (assistant prefill, DSML
 * tool-call emulation, `<output>` extraction) cannot apply. Preset *injection*
 * can still be attempted, but the host serializer cannot express every shape
 * the plugin compiles, so this module rewrites only what it must and reports
 * every remaining limitation as a note instead of pretending the request is
 * equivalent.
 *
 * Verified against the pinned host source
 * (packages/llm/llm-deepseek/src/protocols/messages/serialize.ts):
 *
 * - LAST-WINS, and A is really dropped. `serialize()` keeps one
 *   `historySystem` variable (serialize.ts:74) that every non-in-history
 *   `system` message overwrites (serialize.ts:83-95, `historySystem = text`),
 *   and emits it as the single top-level `system` field
 *   (serialize.ts:126, `[options.system, historySystem].filter(Boolean).join('\n\n')`).
 *   For `[system A, system B, user]` the outbound body is therefore
 *   `{ system: 'B', messages: [{ role: 'user', ... }] }` — A never reaches the
 *   wire. The `join('\n\n')` at serialize.ts:126 joins the request-level
 *   `options.system` (the harness prompt, which is not a message) with that one
 *   surviving snapshot; it never concatenates two system messages, and the
 *   `join('')` at serialize.ts:87 only joins text blocks *within* one message.
 *   Merging all leading system messages into one is thus a real data-loss fix,
 *   and the host's own tests pin the behaviour down:
 *   tests/messages/serialize.spec.ts:97-106 ("uses the latest complete system
 *   snapshot"), :108-112 ("joins blocks only within the current snapshot"),
 *   tests/messages/adapter.spec.ts:268-270 and :310-317 (one `body.system`
 *   string per request, replaced when the prompt changes).
 * - With `in-history`, a mid-history system message is pushed as a native
 *   `system` update that the host only accepts right after a `user` /
 *   `tool-result` turn (otherwise it throws `UNSUPPORTED_CONTENT`), and that is
 *   emitted after that turn rather than at its original position. With the
 *   default `systemPromptUpdate`, a mid-history system message is hoisted to
 *   the single top-level `system` field and overwrites the leading one. Either
 *   way the position is not preserved, so this module keeps the message exactly
 *   where it is and only adds a note.
 * - Messages has no `prefix` flag (the Chat Completions bridge sets
 *   `prefix: true` on the trailing assistant message), so a trailing assistant
 *   continuation prefix cannot be expressed; the content is kept as-is and the
 *   limitation is reported through `prefixUnsupported`.
 *
 * The module is pure and dependency-free: it never mutates its input and it
 * holds no state, so it is directly unit-testable.
 */
/** Separator used between the text of two merged system messages. */
const MERGE_SEPARATOR = '\n\n';
/** Separator used between two text blocks of the same system message. */
const BLOCK_SEPARATOR = '\n';
function textOf(message) {
    if (message == null || !Array.isArray(message.content))
        return '';
    return message.content
        .filter(block => block != null && block.type === 'text')
        .map(block => (typeof block.text === 'string' ? block.text : ''))
        .join(BLOCK_SEPARATOR);
}
function isSystemMessage(message) {
    return message != null && message.role === 'system';
}
/**
 * Whether one message is a trailing assistant continuation prefix. The bridge
 * marks it with `prefix: true` on the wire body; the preset compiler marks it
 * either through the message source or through its `:prefill` id.
 */
function isPrefixMessage(message) {
    if (message == null || message.role !== 'assistant')
        return false;
    if (message.prefix === true)
        return true;
    const kind = message.source?.kind;
    if (kind === 'prefix' || kind === 'assistant_prefix' || kind === 'assistant_prefill')
        return true;
    return message.source?.plugin === 'dsh-preset-enhance' &&
        typeof message.id === 'string' && message.id.endsWith(':prefill');
}
function mergeNote(count) {
    return `开头有 ${count} 条 system 消息：host 只保留最后一条 system 快照（后一条覆盖前一条），前面的文本会被直接丢弃；` +
        '已按原顺序用空行合并为 1 条 system 消息后再发送。';
}
function midHistoryNote(count) {
    return `历史中段仍有 ${count} 条 system 消息：Messages 协议无法等价表达，` +
        '它们的位置可能被重排（提升到顶层 system 字段且只保留最后一条，或在前置 user 轮之后追加），内容也可能被覆盖。';
}
const PREFIX_UNSUPPORTED_NOTE = '最后一条是 assistant 续写前缀（prefill）：Messages 协议没有 prefix 标志，无法保留从该前缀继续生成的语义，' +
    '该内容会按普通 assistant 消息原样发送，模型可能重复这段前缀。';
/**
 * Adapt one compiled preset message list to the Messages protocol, best effort.
 *
 * - All leading system messages are merged into one leading system message that
 *   keeps their order and text (blank-line separated), because the host keeps
 *   only the last one.
 * - A system message after the first non-system message is kept in place; the
 *   limitation is reported instead of silently changing its role or position.
 * - Everything else, including tool calls, tool results and ordering, is
 *   returned as the same objects in a new array.
 *
 * `chat-completions` requests must not be passed through this function.
 */
export function adaptPresetForMessages(messages) {
    const notes = [];
    const note = (text) => {
        if (!notes.includes(text))
            notes.push(text);
    };
    if (!Array.isArray(messages))
        return { messages: [], notes, leadingSystemMerged: 0, prefixUnsupported: false };
    const out = messages.slice();
    let leading = 0;
    while (leading < messages.length && isSystemMessage(messages[leading]))
        leading += 1;
    let leadingSystemMerged = 0;
    if (leading >= 2) {
        const merged = messages.slice(0, leading);
        const mergedText = merged.map(textOf).filter(text => text !== '').join(MERGE_SEPARATOR);
        const content = [{ type: 'text', text: mergedText }];
        // Non-text system blocks cannot be expressed by Messages either way (the
        // host throws UNSUPPORTED_CONTENT), so keep them instead of dropping
        // content behind the user's back.
        for (const message of merged) {
            for (const block of message.content ?? []) {
                if (block.type !== 'text')
                    content.push(block);
            }
        }
        out[0] = { ...messages[0], content };
        out.splice(1, leading - 1);
        leadingSystemMerged = leading;
        note(mergeNote(leading));
    }
    const midHistory = messages.slice(leading).filter(isSystemMessage).length;
    if (midHistory > 0)
        note(midHistoryNote(midHistory));
    const prefixUnsupported = isPrefixMessage(messages.at(-1));
    if (prefixUnsupported)
        note(PREFIX_UNSUPPORTED_NOTE);
    return { messages: out, notes, leadingSystemMerged, prefixUnsupported };
}
