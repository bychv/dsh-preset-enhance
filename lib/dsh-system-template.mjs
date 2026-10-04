import { connectionSelection } from './connection.mjs';
export const DSH_TEMPLATE_ID = 'dsh-preset-enhance:dsh-system-prompt';
const variablePattern = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
// These DSH providers embed changing SDKs, connection instructions, paths or endpoints.
// Whole-section slots also remain available for third-party providers.
function dynamicSection(name) {
    return /^(?:mcp:|mcp-resource-servers$|tools:|context:file-reference$|plan:policy$|app:web-surface$|harness:source$|tool:)/.test(name);
}
function escapeLiteral(text) { return text.replace(/[{}]/g, '\\$&'); }
function sectionTemplate(section) {
    if (section.interpolate === false)
        return escapeLiteral(section.text);
    let cursor = 0, out = '';
    for (const match of section.text.matchAll(variablePattern)) {
        out += escapeLiteral(section.text.slice(cursor, match.index)) + '{{dsh::var::' + match[1] + '}}';
        cursor = match.index + match[0].length;
    }
    return out + escapeLiteral(section.text.slice(cursor));
}
function renderedSection(section, variables, missing) {
    if (section.interpolate === false)
        return section.text;
    return section.text.replace(variablePattern, (_all, name) => {
        if (!Object.hasOwn(variables, name) || variables[name] === undefined) {
            missing.add(name);
            return '{{dsh::var::' + name + '}}';
        }
        return variables[name];
    });
}
/** Public assembly API preserves scoped mode contributions and leaves runtime context separate. */
export async function readDshSystemTemplate(ctx, sessionId, modeId, signal, callOptions) {
    const session = ctx.sessions.get(sessionId);
    let selectedMode = session?.header?.agentPreset ?? '';
    for (const event of session?.snapshotEvents?.() ?? [])
        if (event.type === 'agent-preset/selected')
            selectedMode = event.data?.agentPreset ?? '';
    modeId ||= selectedMode || ctx.agentPresets?.defaultId || '';
    const empty = { available: false, modeId, template: '', text: '', values: {}, variables: [], sections: [], warnings: [] };
    const live = selectedMode === modeId ? ctx.agents?.get(sessionId) : undefined;
    const service = (live?.ctx?.get ? live.ctx.get('systemPrompt') : live?.ctx?.systemPrompt)
        ?? (ctx.get ? ctx.get('systemPrompt') : ctx.systemPrompt);
    if (!service || typeof service.assemble !== 'function')
        return empty;
    let lease;
    try {
        let scope = live;
        if (!scope && ctx.agentPresets?.acquireScope) {
            lease = await ctx.agentPresets.acquireScope(modeId || undefined);
            scope = lease.key;
        }
        else if (!scope && ctx.agentPresets?.standingKeyFor && modeId)
            scope = await ctx.agentPresets.standingKeyFor(modeId);
        // A sidebar/new-conversation view can precede Session creation. Do not fabricate
        // an Agent whose Session is undefined; host providers support an absent Agent.
        const selected = connectionSelection(ctx, sessionId);
        const defaults = connectionSelection(ctx);
        const pending = session ? ctx.get?.('sessionProjections')?.stateOf?.(session, 'modelSelection')?.pending : undefined;
        const options = { ...Object.fromEntries(Object.entries({ provider: selected.provider ?? defaults.provider,
                model: selected.model ?? defaults.model, reasoningEffort: selected.reasoningEffort ?? defaults.reasoningEffort }).filter(([, value]) => value != null)),
            ...session?.requestHeader?.()?.config, ...live?.options, ...pending, ...Object.fromEntries(['provider', 'model', 'reasoningEffort'].filter(key => callOptions?.[key] !== undefined).map(key => [key, callOptions[key]])) };
        const agent = live && Object.entries(options).every(([key, value]) => live.options?.[key] === value)
            ? live : session ? Object.assign(Object.create(live ?? null), { session, options }) : undefined;
        signal?.throwIfAborted();
        // Preserve the live Agent scope; cold reads use a preset scope without creating an Agent.
        const assembly = await service.assemble({ agent, scope, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        const variables = assembly.variables ?? {};
        const values = Object.create(null);
        for (const [key, value] of Object.entries(variables))
            if (typeof value === 'string')
                values['dsh::var::' + key.toLowerCase()] = value;
        const missing = new Set();
        const sections = assembly.sections.map(section => {
            const sectionMissing = new Set(), text = renderedSection(section, variables, sectionMissing);
            for (const key of sectionMissing)
                missing.add(key);
            if (sectionMissing.size === 0) {
                values['dsh::section::' + section.name.toLowerCase()] = text;
                // Keep already-saved encoded macros readable by the compiler.
                values['dsh::section::' + encodeURIComponent(section.name).toLowerCase()] = text;
            }
            return { name: section.name, text, template: sectionTemplate(section), macro: '{{dsh::section::' + section.name.replace(/[{}\\]/g, '\\$&') + '}}' };
        });
        const text = sections.map(s => s.text).filter(Boolean).join('\n\n');
        if (missing.size === 0)
            values['dsh::prompt'] = text;
        return { available: true, modeId, text, values, variables: Object.keys(variables), sections,
            template: sections.filter(s => s.text.length > 0 || dynamicSection(s.name)).map(s => dynamicSection(s.name) ? s.macro : s.template).join('\n\n'), warnings: missing.size ? ['待会话就绪后解析变量：' + [...missing].join('、')] : [] };
    }
    finally {
        await lease?.[Symbol.asyncDispose]();
    }
}
/** Replace durable host snapshots only on the request copy; keep separate runtime contexts. */
export function withoutDshPrompt(messages) {
    return messages.filter(m => m.source?.kind !== 'system-prompt' &&
        !(m.source?.kind === 'plugin' && (m.source.plugin === '@deepseek-ai/dsh-system-prompt' || m.id?.startsWith('preset:dsh-system:'))));
}
export function validateDshTemplates(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('dsh_system_prompt_templates 必须是对象');
    for (const [mode, text] of Object.entries(value)) {
        if (!mode || typeof text !== 'string' || text.length > 2_000_000)
            throw new Error('DSH 模式模板必须为小于 2 MB 的文本');
    }
}
