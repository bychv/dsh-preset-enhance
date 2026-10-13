/** Shared, browser-safe display/preview regex computation. No state writes. */
import { createMacroContext } from './macros.mjs';
import { regexPlacement, planRegexScript, runRegexScriptDetailed } from './prompt-regex.mjs';
export function planDisplayRegex(script, depth) {
    const placement = regexPlacement(script.placement);
    const base = { targets: placement.targets.filter(t => t === 'assistant'), unsupportedPlacements: placement.unsupported };
    if (script.disabled === true)
        return { ...base, runs: false, supported: true, reason: '已停用' };
    if (script.markdownOnly !== true)
        return { ...base, runs: false, supported: false, reason: '未选择正文显示' };
    if (!base.targets.length)
        return { ...base, runs: false, supported: false, reason: '正文仅支持模型输出' };
    if (depth === undefined && ((script.minDepth ?? -1) >= 0 || (script.maxDepth ?? -1) >= 0))
        return { ...base, runs: false, supported: true, reason: '历史深度尚不可用' };
    // Compile validation is shared, while channel selection remains independent.
    return { ...planRegexScript({ ...script, promptOnly: true }, depth ?? 0), ...base };
}
export function transformDisplayText(task) {
    if (task.scripts.length > 200 || task.texts.some(t => typeof t !== 'string') || task.texts.reduce((n, t) => n + t.length, 0) > 524288)
        throw new Error('正则输入超过上限');
    if (JSON.stringify(task.scripts).length > 2097152)
        throw new Error('正则配置超过上限');
    if (task.channel !== 'prompt' && task.target === 'user')
        return { texts: [...task.texts], applied: [], warnings: ['正文显示仅支持模型输出'] };
    const ctx = createMacroContext({ local: task.local, global: task.global, values: task.values, seed: task.seed ?? 'display' });
    let texts = [...task.texts];
    let replacements = 0;
    const applied = [];
    for (const script of task.scripts) {
        const plan = task.channel === 'prompt' ? planRegexScript(script, task.depth ?? 0) : planDisplayRegex(script, task.depth);
        if (!plan.runs || (task.channel === 'prompt' && !regexPlacement(script.placement).targets.includes(task.target ?? 'assistant')))
            continue;
        texts = texts.map(text => {
            const result = runRegexScriptDetailed(text, script, ctx, { maxReplacements: 20000 - replacements, maxOutputChars: 2097152 });
            replacements += result.replacements;
            if (replacements > 20000 || result.text.length > 2097152)
                throw new Error('正则输出超过上限');
            if (result.matched && !applied.includes(script.id ?? script.scriptName ?? ''))
                applied.push(script.id ?? script.scriptName ?? '');
            return result.text;
        });
        if (texts.reduce((n, t) => n + t.length, 0) > 2097152)
            throw new Error('正则输出超过上限');
    }
    return { texts, applied, warnings: ctx.warnings };
}
