/**
 * 结束思考的“独占一行 + 10 token 滑动窗口 + 保底”策略，外加输出区控制标签的剥离。
 *
 * 策略（按优先级）：
 *   1. 独占一行的规范结束标记，且其后的滑动窗口里出现锚点句 / 输出区标签 / <content> / DSML；
 *   2. </think> / </thinking>，走同一个窗口（gateCloseThink）；
 *   3. 锚点开场句：位置在输出区之前时，直接视为最终文本已开始；
 *   4. 输出区控制标签（默认 <｜begin▁of▁output｜>）：兜底，命中即切换；
 *   5. 可选的内容兜底（<content> / DSML）。
 *
 * 控制标签的剥离：
 *   输出区标签是结构控制符，不是内容。扫描器命中的瞬间就把它从缓冲区里扣掉，
 *   只发一个不带文本的结构事件，因此它不会进入后续的正文拼接或工具调用解析流程。
 *   （这样做之后，校验“无损”时用的是去掉控制标签后的期望文本。）
 *
 * 滑动窗口缓冲区：
 *   缓冲区只保留“尚未确定”的尾部——可能的标签前缀（约 20 字符）与候选窗口
 *   （lookahead 20 字符）。其余文本随到随发，因此内存占用有上界，
 *   且按任意切分喂入结果一致。
 */
const BAR = '\uFF5C';
const BLOCK = '\u2581';
const BACKTICK = String.fromCharCode(96);
const DSML_CALLS_OPEN = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>';
const DSML_CALLS_CLOSE = '</' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>';
const DSML_INVOKE_OPEN = '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="工具名">';
const DSML_INVOKE_CLOSE = '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>';
const DSML_PARAM = '<' + BAR + BAR + 'DSML' + BAR + BAR +
    ' parameter name="参数名" string="false">合法 JSON</' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>';
export const END_MARKER = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'think' + BAR + '>';
export const LEGACY_END_MARKER = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'thinkings' + BAR + '>';
export const ASCII_END_MARKER = '<|end_of_think|>';
export const THINK_OPEN = '<think>';
export const CONTENT_OPEN = '<content>';
export const CONTENT_CLOSE = '</content>';
export const OUTPUT_OPEN = '<' + BAR + 'begin' + BLOCK + 'of' + BLOCK + 'output' + BAR + '>';
export const OUTPUT_CLOSE = '<' + BAR + 'end' + BLOCK + 'of' + BLOCK + 'output' + BAR + '>';
export const LEGACY_OUTPUT_OPEN = '<output>';
export const LEGACY_OUTPUT_CLOSE = '</output>';
export const ASCII_OUTPUT_OPEN = '<|begin_of_output|>';
export const ASCII_OUTPUT_CLOSE = '<|end_of_output|>';
export const ANCHOR_SENTENCE = '您好，这是约定的内容，请查收：';
const OUTPUT_TAG_PAIRS = [
    [OUTPUT_OPEN, OUTPUT_CLOSE],
    [ASCII_OUTPUT_OPEN, ASCII_OUTPUT_CLOSE],
    [LEGACY_OUTPUT_OPEN, LEGACY_OUTPUT_CLOSE],
];
const OUTPUT_OPEN_TAGS = OUTPUT_TAG_PAIRS.map(pair => pair[0]);
const OUTPUT_CLOSE_TAGS = OUTPUT_TAG_PAIRS.map(pair => pair[1]);
/** 与稳定性测试最终策略相同的预置格式提示词。 */
export const OUTPUT_EXTRACTION_PROMPT_TEMPLATE = [
    '你是一个写作助手。请严格遵循下面的输出格式约定。',
    '***回答或使用工具前，必须让结束思考标记独占一行来结束思考，格式严格为：换行 + ' + END_MARKER + ' + 换行***',
    '也就是说，结束思考时必须单独输出下面这一行（该行前后各有一个换行，行内不能有任何其他文字）：',
    '',
    END_MARKER,
    '',
    '***必须以输出“' + ANCHOR_SENTENCE + '”开始最终文本的生成。***',
    '- 最终文本在 ' + BACKTICK + '</thinking>' + BACKTICK + ' 标签后面生成；',
    '- 例外：正文输出需要调用工具时，不输出这句话。',
    '',
    '结束思考后，必须紧接着用 ' + OUTPUT_OPEN + ' 开始输出区，把**全部**对外内容都放进去，最后用 ' + OUTPUT_CLOSE + ' 收尾；正文依然写在 ' + BACKTICK + '<content></content>' + BACKTICK + ' 里。',
    '完整结构如下（' + OUTPUT_OPEN + ' 之前只能是思考内容）：',
    '',
    END_MARKER,
    OUTPUT_OPEN,
    '（正文之外的其他格式）',
    '<content>正文</content>',
    '（正文之外的其他格式）',
    OUTPUT_CLOSE,
    '',
    '把回答正文的内容写在 ' + BACKTICK + '<content></content>' + BACKTICK + ' 的里面，总字数在1200~1600字之间。',
    '如果上文的回答正文外部需要某种格式，把它们放在 ' + BACKTICK + '</content>' + BACKTICK + ' 的后面，或者 ' + BACKTICK + '<content>' + BACKTICK + ' 的前面。',
    '你可以使用系统提供的工具；需要调用工具时，在结束思考标记之后立刻给出工具调用。',
    '工具调用必须使用下面的 DSML calls 外层格式，不能改成原生工具调用标签、JSON 或 Markdown 代码块：',
    DSML_CALLS_OPEN,
    DSML_INVOKE_OPEN,
    DSML_PARAM,
    DSML_INVOKE_CLOSE,
    DSML_CALLS_CLOSE,
    '每次调用都放在 ' + DSML_CALLS_OPEN + ' 与 ' + DSML_CALLS_CLOSE + ' 之间；字符串参数使用 string="true"，非字符串参数使用 string="false" 并填写合法 JSON。',
].join('\n');
const CLOSE_THINK_TAGS = ['</think>', '</thinking>'];
/** 结构控制标签：命中后在缓冲区里扣掉，不进后续处理流程。 */
export const CONTROL_TAGS = OUTPUT_TAG_PAIRS.flat();
/** Runtime-only cleanup set. END markers are omitted from CONTROL_TAGS because the
 * stability scanner records them as semantic boundary events, but API responses must
 * never expose them after output extraction has switched successfully. */
const EXTRACTION_SPECIAL_TOKENS = [END_MARKER, LEGACY_END_MARKER, ASCII_END_MARKER].concat(CONTROL_TAGS);
export function stripExtractionSpecialTokens(text) {
    let output = typeof text === 'string' ? text : '';
    for (const token of EXTRACTION_SPECIAL_TOKENS)
        output = output.split(token).join('');
    return output;
}
/**
 * Some compatible providers put the complete output envelope in reasoning_content and
 * finish with an empty content field. At the end of the choice, move the last complete
 * envelope into content. Choosing the last pair avoids treating a format example quoted
 * earlier in the chain of thought as the final answer.
 */
export function extractTaggedOutputFallback(reasoning) {
    const source = typeof reasoning === 'string' ? reasoning : '';
    const pairs = OUTPUT_TAG_PAIRS;
    let best = null;
    for (const [open, close] of pairs) {
        let from = 0;
        for (;;) {
            const openAt = source.indexOf(open, from);
            if (openAt < 0)
                break;
            const closeAt = source.indexOf(close, openAt + open.length);
            if (closeAt < 0)
                break;
            if (!best || openAt >= best.openAt)
                best = { open, close, openAt, closeAt };
            from = openAt + open.length;
        }
    }
    if (!best) {
        return { matched: false, reasoning: stripExtractionSpecialTokens(source), content: '' };
    }
    const content = stripExtractionSpecialTokens(source.slice(best.openAt + best.open.length, best.closeAt));
    if (!content.trim()) {
        return { matched: false, reasoning: stripExtractionSpecialTokens(source), content: '' };
    }
    const remainder = source.slice(0, best.openAt) + source.slice(best.closeAt + best.close.length);
    return {
        matched: true,
        reasoning: stripExtractionSpecialTokens(remainder),
        content,
    };
}
const HOLD_PATTERNS = [
    END_MARKER, LEGACY_END_MARKER, ASCII_END_MARKER, THINK_OPEN, CONTENT_OPEN, CONTENT_CLOSE, ANCHOR_SENTENCE,
].concat(CONTROL_TAGS).concat(CLOSE_THINK_TAGS);
export const STRATEGY_DEFAULTS = {
    bufferTokens: 10,
    charsPerToken: 2,
    // 控制标签比较长（<｜begin▁of▁output｜> 19 字符、旧变体 21 字符），
    // 缓冲区至少保留这么多尾字符，保证标签被任意切开都能拼回来。
    bufferChars: 32,
    contentFallback: false,
    outputTrigger: true,
    anchor: ANCHOR_SENTENCE,
    // 锚点句只作为“结束标记/</think> 窗口”的确认信号，默认不当切换触发点：
    // 模型会在思考里复述它（“必须以“您好…”开始”），拿来当触发点会过早切换。
    anchorTrigger: false,
    anchorLineStart: true,
    stripControlTags: true,
};
export function lookaheadCharsFor(options) {
    const config = Object.assign({}, STRATEGY_DEFAULTS, options || {});
    return Math.max(1, Math.round(config.bufferTokens * config.charsPerToken));
}
/** 去掉结构控制标签，用于校验“剥离后依然无损”。 */
export function stripControlTags(text) {
    let output = typeof text === 'string' ? text : '';
    for (const tag of CONTROL_TAGS)
        output = output.split(tag).join('');
    return output;
}
function textKindForPhase(phase) {
    if (phase === 'thinking')
        return 'thinking';
    if (phase === 'tool-call')
        return 'tool-call';
    if (phase === 'body')
        return 'body';
    return 'text';
}
function findEarliest(haystack, needles) {
    let best = null;
    for (const needle of needles) {
        const index = haystack.indexOf(needle);
        if (index < 0)
            continue;
        if (best === null || index < best.index)
            best = { index, text: needle };
    }
    return best;
}
/** 找“独占一行”的规范结束标记。 */
export function findStandaloneMarker(buffer, atEnd, atLineStart) {
    let from = 0;
    for (;;) {
        const index = buffer.indexOf(END_MARKER, from);
        if (index < 0)
            return null;
        const before = buffer.slice(0, index);
        const lineBreak = before.lastIndexOf('\n');
        const prefixOnLine = lineBreak < 0 ? before : before.slice(lineBreak + 1);
        const startsLine = prefixOnLine.trim() === '' && (lineBreak >= 0 || atLineStart !== false);
        const afterIndex = index + END_MARKER.length;
        const after = buffer.slice(afterIndex);
        const newlineAt = after.indexOf('\n');
        const suffixOnLine = newlineAt < 0 ? after : after.slice(0, newlineAt);
        const endsLine = suffixOnLine.trim() === '';
        if (startsLine && endsLine) {
            if (newlineAt >= 0) {
                return { markerIndex: index, markerEnd: afterIndex, lineEnd: afterIndex + newlineAt + 1, lineComplete: true };
            }
            if (atEnd)
                return { markerIndex: index, markerEnd: afterIndex, lineEnd: afterIndex, lineComplete: false };
            return { markerIndex: index, markerEnd: afterIndex, lineEnd: -1, lineComplete: false };
        }
        from = index + END_MARKER.length;
    }
}
/**
 * 判断某个位置是否位于行首。
 * 关键点：缓冲区起点不一定就是源码行首（前面的文本可能已经发出去了），
 * 所以 index === 0 时必须用调用方维护的 atLineStart 状态，不能直接返回 true，
 * 否则“刚被切开”的行内锚点/标记会被误判成独占一行。
 */
function isLineStart(buffer, index, atLineStart) {
    const lineBreak = buffer.lastIndexOf('\n', index - 1);
    if (lineBreak >= 0)
        return buffer.slice(lineBreak + 1, index).trim() === '';
    return (index === 0 ? atLineStart : atLineStart) && buffer.slice(0, index).trim() === '';
}
/** 尾部可能是某个模式前缀时，扣留这部分等下一块。 */
/**
 * 把所有模式的前缀预先放进 Set：扣留判定从 O(后缀长度 × 模式数 × 模式长度)
 * 降到 O(缓冲区尾长) 次 Set 查找，热路径上不再做 any/startsWith 扫描。
 */
function buildPrefixSet(patterns) {
    const set = new Set();
    for (const pattern of patterns) {
        for (let length = 1; length < pattern.length; length += 1)
            set.add(pattern.slice(0, length));
    }
    return set;
}
const HOLD_PREFIXES = buildPrefixSet(HOLD_PATTERNS);
const CLOSE_PREFIXES = buildPrefixSet(CLOSE_THINK_TAGS.concat(CONTROL_TAGS));
function holdLength(buffer, prefixes, holdLimit) {
    const limit = Math.min(buffer.length, holdLimit - 1);
    for (let length = limit; length > 0; length -= 1) {
        if (prefixes.has(buffer.slice(buffer.length - length)))
            return length;
    }
    return 0;
}
/**
 * 创建策略扫描器。事件 kind：
 *   thinking / body / tool-call / text —— 带文本的内容事件
 *   end-marker（mode: confirmed | fallback）—— 结束思考标记
 *   restatement —— 被判为思考链内复述的独立成行标记（文本已在 thinking 里）
 *   output-open / output-close —— 控制标签，text 为空（已从缓冲区扣掉）
 */
export function createStrategyScanner(options) {
    const config = Object.assign({}, STRATEGY_DEFAULTS, options || {});
    const outputTags = OUTPUT_OPEN_TAGS;
    const closeTags = OUTPUT_CLOSE_TAGS;
    // 确认窗口至少要能装下最长的触发标签（再多留 4 字符余量）
    const longestTag = HOLD_PATTERNS.reduce((max, pattern) => Math.max(max, pattern.length), 0);
    const lookahead = Math.max(lookaheadCharsFor(config), longestTag + 4);
    const holdLimit = Math.max(config.bufferChars, longestTag);
    // contentTrigger 与旧名 contentFallback 等价
    const contentTrigger = config.contentTrigger === true || config.contentFallback === true;
    let buffer = '';
    let phase = 'thinking';
    let emitted = 0;
    let switchedAt = -1;
    let switchMode = null;
    let restatements = 0;
    let heldCandidates = 0;
    let fallbackUsed = false;
    let stripped = 0;
    let maxPending = 0;
    // 缓冲区起点是否正好位于源码行首（前面的文本已经消费掉，但状态要记住）
    let atLineStart = true;
    function consume(text) {
        if (!text)
            return;
        for (let index = text.length - 1; index >= 0; index -= 1) {
            const char = text[index];
            if (char === '\n') {
                atLineStart = true;
                return;
            }
            if (char === ' ' || char === '\t' || char === '\r')
                continue;
            atLineStart = false;
            return;
        }
    }
    function emitText(events, text) {
        if (!text)
            return;
        events.push({ kind: textKindForPhase(phase), text });
        consume(text);
    }
    function holdAndFlush(events, prefixes) {
        const hold = holdLength(buffer, prefixes, holdLimit);
        const safe = buffer.length - hold;
        if (safe > 0) {
            emitText(events, buffer.slice(0, safe));
            emitted += safe;
            buffer = buffer.slice(safe);
        }
    }
    function drainBody(events) {
        // 正文相位也要处理控制标签：标记确认路径进入正文时，<begin▁of▁output｜> 可能还留在缓冲区里
        const tags = config.stripControlTags ? CONTROL_TAGS : closeTags;
        for (;;) {
            if (phase === 'thinking')
                return events;
            const hit = findEarliest(buffer, tags);
            if (hit) {
                if (hit.index > 0) {
                    emitText(events, buffer.slice(0, hit.index));
                    emitted += hit.index;
                }
                const isClose = closeTags.includes(hit.text);
                events.push({ kind: isClose ? 'output-close' : 'output-open', text: '' });
                if (config.stripControlTags)
                    stripped += 1;
                emitted += hit.text.length;
                buffer = buffer.slice(hit.index + hit.text.length);
                if (isClose)
                    phase = 'trailing';
                continue;
            }
            holdAndFlush(events, config.stripControlTags ? HOLD_PREFIXES : CLOSE_PREFIXES);
            return events;
        }
    }
    function drain(atEnd) {
        const events = [];
        for (;;) {
            if (phase !== 'thinking') {
                maxPending = Math.max(maxPending, buffer.length);
                return drainBody(events);
            }
            const close = findEarliest(buffer, CLOSE_THINK_TAGS);
            const candidate = findStandaloneMarker(buffer, atEnd, atLineStart);
            // 1) 结束标记（独占一行）——先攒窗口再判定
            if (candidate && (!close || candidate.markerIndex <= close.index)) {
                const available = buffer.length - candidate.markerEnd;
                if (available < lookahead && !atEnd) {
                    if (candidate.markerIndex > 0) {
                        emitText(events, buffer.slice(0, candidate.markerIndex));
                        emitted += candidate.markerIndex;
                        buffer = buffer.slice(candidate.markerIndex);
                    }
                    maxPending = Math.max(maxPending, buffer.length);
                    return events;
                }
                const window = buffer.slice(candidate.markerEnd, candidate.markerEnd + lookahead);
                const anchorAt = config.anchor ? window.indexOf(config.anchor) : -1;
                const outputAt = findEarliest(window, outputTags);
                const toolFirst = window.indexOf(DSML_CALLS_OPEN);
                const contentFirst = window.indexOf(CONTENT_OPEN);
                // 直接取最小值，避免热路径上 filter/sort 的数组分配
                let earliest = -1;
                let confirmed = null;
                const consider = (at, kind) => {
                    if (at < 0)
                        return;
                    if (earliest < 0 || at < earliest) {
                        earliest = at;
                        confirmed = kind;
                    }
                };
                consider(anchorAt, 'anchor');
                consider(outputAt ? outputAt.index : -1, 'output');
                consider(toolFirst, 'tool-call');
                consider(contentFirst, 'content');
                if (confirmed) {
                    if (candidate.markerIndex > 0) {
                        emitText(events, buffer.slice(0, candidate.markerIndex));
                        emitted += candidate.markerIndex;
                    }
                    switchedAt = emitted;
                    switchMode = 'confirmed:' + confirmed;
                    events.push({ kind: 'end-marker', text: END_MARKER, mode: 'confirmed' });
                    consume(END_MARKER);
                    emitted += END_MARKER.length;
                    buffer = buffer.slice(candidate.markerEnd);
                    phase = 'body';
                    continue;
                }
                restatements += 1;
                const restatementEnd = candidate.lineComplete ? candidate.lineEnd : candidate.markerEnd;
                events.push({ kind: 'restatement', text: buffer.slice(candidate.markerIndex, candidate.markerEnd) });
                emitText(events, buffer.slice(0, restatementEnd));
                emitted += restatementEnd;
                buffer = buffer.slice(restatementEnd);
                continue;
            }
            // 2) </think> 保底：gateCloseThink 时同样要过窗口
            if (close) {
                if (!config.gateCloseThink) {
                    if (close.index > 0) {
                        emitText(events, buffer.slice(0, close.index));
                        emitted += close.index;
                    }
                    events.push({ kind: 'end-marker', text: close.text, mode: 'fallback' });
                    consume(close.text);
                    emitted += close.text.length;
                    switchedAt = emitted - close.text.length;
                    switchMode = 'fallback:close-think';
                    fallbackUsed = true;
                    phase = 'body';
                    buffer = buffer.slice(close.index + close.text.length);
                    continue;
                }
                const closeAvailable = buffer.length - (close.index + close.text.length);
                if (closeAvailable < lookahead && !atEnd) {
                    if (close.index > 0) {
                        emitText(events, buffer.slice(0, close.index));
                        emitted += close.index;
                        buffer = buffer.slice(close.index);
                    }
                    maxPending = Math.max(maxPending, buffer.length);
                    return events;
                }
                const closeWindow = buffer.slice(close.index + close.text.length, close.index + close.text.length + lookahead);
                const closeConfirms = (config.anchor && closeWindow.indexOf(config.anchor) >= 0) ||
                    findEarliest(closeWindow, outputTags) !== null ||
                    closeWindow.indexOf(CONTENT_OPEN) >= 0 || closeWindow.indexOf(DSML_CALLS_OPEN) >= 0;
                if (closeConfirms) {
                    if (close.index > 0) {
                        emitText(events, buffer.slice(0, close.index));
                        emitted += close.index;
                    }
                    events.push({ kind: 'end-marker', text: close.text, mode: 'fallback' });
                    emitted += close.text.length;
                    switchedAt = emitted - close.text.length;
                    switchMode = 'fallback:close-think';
                    fallbackUsed = true;
                    phase = 'body';
                    buffer = buffer.slice(close.index + close.text.length);
                    continue;
                }
                heldCandidates += 1;
                if (close.index > 0) {
                    emitText(events, buffer.slice(0, close.index));
                    emitted += close.index;
                }
                emitText(events, close.text);
                emitted += close.text.length;
                buffer = buffer.slice(close.index + close.text.length);
                continue;
            }
            // 3) 锚点开场句（仅在显式开启 anchorTrigger 时作为触发点）
            if (config.anchorTrigger && config.anchor) {
                const anchorAt = buffer.indexOf(config.anchor);
                if (anchorAt >= 0 && (!config.anchorLineStart || isLineStart(buffer, anchorAt, atLineStart))) {
                    if (anchorAt > 0) {
                        emitText(events, buffer.slice(0, anchorAt));
                        emitted += anchorAt;
                    }
                    switchedAt = emitted;
                    switchMode = 'trigger:anchor';
                    phase = 'body';
                    continue;
                }
                // 行内提及（复述要求）：当普通思考放行，但不要把它当成切换点
                if (anchorAt >= 0) {
                    const inlineEnd = anchorAt + config.anchor.length;
                    emitText(events, buffer.slice(0, inlineEnd));
                    emitted += inlineEnd;
                    buffer = buffer.slice(inlineEnd);
                    continue;
                }
            }
            // 4) 输出区控制标签：切换并把它从缓冲区扣掉
            if (config.outputTrigger !== false) {
                const outputHit = findEarliest(buffer, outputTags);
                if (outputHit) {
                    if (outputHit.index > 0) {
                        emitText(events, buffer.slice(0, outputHit.index));
                        emitted += outputHit.index;
                    }
                    switchedAt = emitted;
                    switchMode = 'trigger:output';
                    phase = 'body';
                    if (config.stripControlTags) {
                        stripped += 1;
                        events.push({ kind: 'output-open', text: '' });
                        emitted += outputHit.text.length;
                        buffer = buffer.slice(outputHit.index + outputHit.text.length);
                    }
                    continue;
                }
            }
            // 5) 可选的内容兜底
            if (contentTrigger) {
                const hit = findEarliest(buffer, [CONTENT_OPEN, DSML_CALLS_OPEN]);
                if (hit) {
                    if (hit.index > 0) {
                        emitText(events, buffer.slice(0, hit.index));
                        emitted += hit.index;
                    }
                    switchedAt = emitted;
                    switchMode = 'trigger:' + (hit.text === CONTENT_OPEN ? 'content' : 'tool-call');
                    phase = hit.text === CONTENT_OPEN ? 'body' : 'tool-call';
                    continue;
                }
            }
            holdAndFlush(events, HOLD_PREFIXES);
            maxPending = Math.max(maxPending, buffer.length);
            return events;
        }
    }
    return {
        get phase() { return phase; },
        get switchedAt() { return switchedAt; },
        get switchMode() { return switchMode; },
        get restatements() { return restatements; },
        get heldCandidates() { return heldCandidates; },
        get fallbackUsed() { return fallbackUsed; },
        get stripped() { return stripped; },
        get pending() { return buffer.length; },
        get maxPending() { return maxPending; },
        push(chunk) {
            buffer += chunk == null ? '' : String(chunk);
            return drain(false);
        },
        finish() {
            const events = drain(true);
            if (phase === 'thinking' && buffer.length > 0) {
                emitText(events, buffer);
                emitted += buffer.length;
                buffer = '';
            }
            else if (phase !== 'thinking' && buffer.length > 0) {
                emitText(events, buffer);
                emitted += buffer.length;
                buffer = '';
            }
            return events;
        },
    };
}
/** 用固定块大小模拟流式喂入；输出 = 原始文本去掉控制标签。 */
export function scanWithStrategy(text, chunkSize, options) {
    const config = Object.assign({}, STRATEGY_DEFAULTS, options || {});
    const source = typeof text === 'string' ? text : '';
    const size = Math.max(1, Math.floor(chunkSize || 1));
    const scanner = createStrategyScanner(config);
    const events = [];
    let output = '';
    for (let index = 0; index < source.length; index += size) {
        for (const event of scanner.push(source.slice(index, index + size)))
            events.push(event);
    }
    for (const event of scanner.finish())
        events.push(event);
    for (const event of events) {
        if (event.kind === 'restatement' || event.kind === 'output-open' || event.kind === 'output-close')
            continue;
        output += event.text;
    }
    const expected = config.stripControlTags ? stripControlTags(source) : source;
    return {
        events,
        output,
        expected,
        complete: output === expected,
        clean: CONTROL_TAGS.every(tag => !output.includes(tag)),
        switchedAt: scanner.switchedAt,
        switchMode: scanner.switchMode,
        restatements: scanner.restatements,
        heldCandidates: scanner.heldCandidates,
        fallbackUsed: scanner.fallbackUsed,
        stripped: scanner.stripped,
        maxPending: scanner.maxPending,
    };
}
/**
 * 比较三种策略的切换点：first-match（旧做法）/ strategy（策略）/ safe（策略 + 内容兜底）。
 */
export function compareStrategies(text) {
    const source = typeof text === 'string' ? text : '';
    const regionTokens = OUTPUT_OPEN_TAGS.concat([CONTENT_OPEN, DSML_CALLS_OPEN]);
    const found = regionTokens.map(token => source.indexOf(token)).filter(index => index >= 0);
    const bodyStart = found.length > 0 ? Math.min.apply(null, found) : -1;
    const measure = (switchedAt) => {
        if (switchedAt < 0)
            return { switchedAt: -1, leak: 0, miss: true, late: 0 };
        if (bodyStart < 0)
            return { switchedAt, leak: 0, miss: false, late: 0 };
        return { switchedAt, leak: Math.max(0, bodyStart - switchedAt), miss: false, late: Math.max(0, switchedAt - bodyStart) };
    };
    const signals = [END_MARKER, LEGACY_END_MARKER, ASCII_END_MARKER, '</think>', '</thinking>']
        .concat(regionTokens).map(token => source.indexOf(token)).filter(index => index >= 0);
    const firstMatch = signals.length > 0 ? Math.min.apply(null, signals) : -1;
    const strategy = scanWithStrategy(source, 3, { gateCloseThink: true, contentTrigger: false });
    const safe = scanWithStrategy(source, 3, { gateCloseThink: true, contentTrigger: true });
    return {
        bodyStart,
        firstMatch: measure(firstMatch),
        strategy: Object.assign({ restatements: strategy.restatements, fallbackUsed: strategy.fallbackUsed, mode: strategy.switchMode }, measure(strategy.switchedAt)),
        safeStrategy: Object.assign({ restatements: safe.restatements, fallbackUsed: safe.fallbackUsed, mode: safe.switchMode }, measure(safe.switchedAt)),
    };
}
function extractionParts(events) {
    let reasoning = '';
    let content = '';
    for (const event of events) {
        if (event.kind === 'thinking')
            reasoning += event.text;
        else if (event.kind === 'body' || event.kind === 'tool-call' || event.kind === 'text')
            content += event.text;
    }
    return {
        reasoning: stripExtractionSpecialTokens(reasoning.split(THINK_OPEN).join('')),
        content: stripExtractionSpecialTokens(content),
    };
}
/**
 * Extract one complete response. When the strategy finds no output boundary, the original
 * content is preserved so enabling the experiment cannot erase a non-conforming response.
 */
export function extractOutputText(text, { assumeBody = false } = {}) {
    const source = typeof text === 'string' ? text : '';
    const scanner = createStrategyScanner({ gateCloseThink: true, outputTrigger: true });
    const events = [];
    if (assumeBody)
        events.push(...scanner.push(OUTPUT_OPEN));
    events.push(...scanner.push(source), ...scanner.finish());
    const parts = extractionParts(events);
    const switched = assumeBody || scanner.switchedAt >= 0;
    return {
        ...parts,
        content: switched ? parts.content : source,
        reasoning: switched ? parts.reasoning : '',
        switched,
        missed: !switched,
        switchMode: scanner.switchMode,
    };
}
/** Stateful adapter used by the SSE transformer. */
export function createOutputExtractionStream({ assumeBody = false } = {}) {
    const scanner = createStrategyScanner({ gateCloseThink: true, outputTrigger: true });
    let forced = false;
    function forceBody() {
        if (forced || scanner.phase !== 'thinking')
            return { reasoning: '', content: '' };
        forced = true;
        return extractionParts(scanner.push(OUTPUT_OPEN));
    }
    if (assumeBody)
        forceBody();
    return {
        get phase() { return scanner.phase; },
        get switched() { return forced || scanner.switchedAt >= 0; },
        get switchMode() { return forced ? 'native-reasoning' : scanner.switchMode; },
        assumeBody: forceBody,
        push(chunk) { return extractionParts(scanner.push(chunk)); },
        finish() { return extractionParts(scanner.finish()); },
    };
}
