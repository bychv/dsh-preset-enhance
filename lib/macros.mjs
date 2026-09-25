export function createMacroContext(options = {}) {
    const seed = options.seed === undefined ? undefined : String(options.seed);
    const source = options.random ?? (seed === undefined ? Math.random : seededRandom(seed));
    const ctx = {
        local: Object.assign(Object.create(null), options.local),
        global: Object.assign(Object.create(null), options.global),
        values: Object.fromEntries(Object.entries(options.values ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])),
        warnings: [], remaining: 10000, draws: 0,
        // Counted so a worker can rebuild this exact stream before it continues the run.
        random: () => { ctx.draws += 1; return source(); },
        ...seed === undefined ? {} : { seed },
        ...options.valueTransform === undefined ? {} : { valueTransform: options.valueTransform },
    };
    return ctx;
}
export function renderMacros(input, ctx = createMacroContext(), level = 0) {
    if (level > 32)
        throw new Error('宏嵌套超过 32 层');
    if (typeof input !== 'string' || input.length > 2_000_000)
        throw new Error('提示词必须是小于 2 MB 的文本');
    let out = '', cursor = 0, trimNext = false;
    while (cursor < input.length) {
        // Escaped individual braces remain literal and cannot become executable macros.
        if (input[cursor] === '\\' && '{}'.includes(input[cursor + 1] ?? '\0')) {
            out += input[cursor + 1];
            cursor += 2;
            continue;
        }
        if (input.slice(cursor, cursor + 2) !== '{{') {
            const ch = input[cursor++];
            if (trimNext && (ch === '\r' || ch === '\n'))
                continue;
            trimNext = false;
            out += ch;
            continue;
        }
        const start = cursor;
        let depth = 1;
        cursor += 2;
        const bodyStart = cursor;
        while (cursor < input.length && depth) {
            if (input[cursor] === '\\') {
                cursor += 2;
                continue;
            }
            const pair = input.slice(cursor, cursor + 2);
            if (pair === '{{') {
                depth++;
                cursor += 2;
            }
            else if (pair === '}}') {
                depth--;
                if (depth)
                    cursor += 2;
            }
            else
                cursor++;
        }
        if (depth) {
            ctx.warnings.push('未闭合的宏');
            out += input.slice(start);
            break;
        }
        const raw = input.slice(bodyStart, cursor);
        cursor += 2;
        if (--ctx.remaining < 0)
            throw new Error('宏执行数量超过 10000');
        if (raw.trimStart().startsWith('//'))
            continue; // Nested side effects in comments never execute.
        if (raw.trim().toLowerCase() === 'trim') {
            out = out.replace(/[\r\n]+$/, '');
            trimNext = true;
            continue;
        }
        // Split arguments BEFORE expanding children: values containing :: are preserved.
        const parts = splitArguments(raw);
        let head = (parts.shift() ?? '').trim();
        const headMatch = head.match(/^([a-z]+)(?:\s+|:)([\s\S]*)$/i);
        if (headMatch) {
            head = headMatch[1];
            parts.unshift(headMatch[2]);
        }
        const name = head.toLowerCase();
        const known = /^(?:(?:set|get|add|inc|dec|flush)(?:global)?var|random|pick|roll|newline|noop|reverse)$/;
        if (!known.test(name) && !Object.hasOwn(ctx.values, name)) {
            ctx.warnings.push(`未支持的宏：${head}`);
            out += input.slice(start, cursor);
            continue;
        }
        const args = parts.map(part => renderMacros(part, ctx, level + 1).trim());
        const variable = name.match(/^(set|get|add|inc|dec|flush)(global)?var$/);
        let value = '';
        if (variable) {
            const [, op, global] = variable, vars = global ? ctx.global : ctx.local;
            // Accept the user's key:value spelling as well as ST key::value.
            if (op === 'set' && args.length === 1 && args[0].includes(':')) {
                const at = args[0].indexOf(':');
                args.splice(0, 1, args[0].slice(0, at), args[0].slice(at + 1));
            }
            const key = args[0];
            if (!key) {
                ctx.warnings.push(`${name} 缺少变量名`);
                continue;
            }
            const current = vars[key] ?? '';
            if (op === 'set')
                vars[key] = args.slice(1).join('::');
            if (op === 'get')
                value = current;
            if (op === 'flush')
                delete vars[key];
            if (op === 'inc' || op === 'dec')
                value = vars[key] = String((Number(current) || 0) + (op === 'inc' ? 1 : -1));
            if (op === 'add') {
                const added = args.slice(1).join('::');
                vars[key] = Number.isFinite(Number(current)) && Number.isFinite(Number(added))
                    ? String(Number(current) + Number(added)) : current + added;
            }
        }
        else if (name === 'random' || name === 'pick') {
            const choices = args.length === 1 ? args[0].split(',').map(x => x.trim()) : args;
            value = choices[Math.floor(ctx.random() * choices.length)] ?? '';
        }
        else if (name === 'roll') {
            const dice = (args[0] ?? '1d6').match(/^(\d*)d(\d+)([+-]\d+)?$/i);
            if (!dice || Number(dice[1] || 1) > 100 || Number(dice[2]) < 1 || Number(dice[2]) > 1e9) {
                ctx.warnings.push('无效骰子表达式');
                value = input.slice(start, cursor);
            }
            else {
                let sum = Number(dice[3] ?? 0);
                for (let i = 0; i < Number(dice[1] || 1); i++)
                    sum += 1 + Math.floor(ctx.random() * Number(dice[2]));
                value = String(sum);
            }
        }
        else if (name === 'newline')
            value = '\n';
        else if (name === 'reverse')
            value = [...(args[0] ?? '')].reverse().join('');
        else if (name !== 'noop')
            value = ctx.values[name] ?? '';
        // Only the outermost level transforms: nested expansions keep their own text, so an escaped
        // value is escaped once instead of once per nesting level.
        out += ctx.valueTransform && level === 0 ? ctx.valueTransform(value) : value;
        if (out.length > 2_000_000)
            throw new Error('宏展开结果超过 2 MB');
    }
    return out;
}
function splitArguments(raw) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < raw.length - 1; i++) {
        if (raw[i] === '\\') {
            i++;
            continue;
        }
        const pair = raw.slice(i, i + 2);
        if (pair === '{{') {
            depth++;
            i++;
        }
        else if (pair === '}}') {
            depth--;
            i++;
        }
        else if (!depth && pair === '::') {
            parts.push(raw.slice(start, i));
            start = i + 2;
            i++;
        }
    }
    parts.push(raw.slice(start));
    return parts;
}
/** Stable across retries and previews when given the same seed. */
export function seededRandom(seed) {
    let state = 2166136261;
    for (const ch of String(seed))
        state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
    return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
