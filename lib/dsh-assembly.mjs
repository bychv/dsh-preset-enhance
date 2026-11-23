import { isDeepStrictEqual } from 'node:util';
import { DSH_PREVIEW, dshTemplateFromAssembly } from './dsh-system-template.mjs';
/** DSH 0.2.3 admits changed sources as deltas and stores notices in separate blocks. */
function matchesIncrementalPrompt(messages, assembly, template) {
    const effective = new Map();
    for (const message of messages) {
        const source = message.source;
        if (source?.kind !== 'system-prompt')
            continue;
        if (source.reset || !source.sections)
            effective.clear();
        for (const section of source.sections ?? []) {
            if (section.state === 'retired') {
                effective.delete(section.name);
                continue;
            }
            const block = message.content?.[section.contentIndex];
            if (block?.type !== 'text' || typeof block.text !== 'string')
                return false;
            effective.set(section.name, block.text);
        }
    }
    return assembly.sections.every(section => !section.retire || !effective.has(section.name))
        && template.sections.every(section => (effective.get(section.name) ?? '') === section.text.trim());
}
/** Only real step assemblies participate. Preview reads never replace an accepted step. */
export function createDshAssemblyTracker(ctx, modeOf) {
    let records = new WeakMap(), closed = false;
    ctx.effect(() => () => { closed = true; records = new WeakMap(); });
    ctx.on('agent/pre-step', async (payload, next) => {
        const accepted = records.get(payload.agent);
        try {
            const decision = await next();
            if (accepted && records.get(payload.agent) === accepted && accepted.signal === payload.signal && decision.kind === 'enter') {
                accepted.position = { turn: payload.turn, step: payload.step };
            }
            else if (accepted && records.get(payload.agent) === accepted)
                records.delete(payload.agent);
            return decision;
        }
        catch (error) {
            if (records.get(payload.agent) === accepted)
                records.delete(payload.agent);
            throw error;
        }
    });
    ctx.on('agent/request', async (payload, next) => {
        const accepted = records.get(payload.agent);
        const sameStep = accepted && accepted.signal === payload.signal && accepted.position?.turn === payload.turn && accepted.position?.step === payload.step;
        try {
            const config = await next();
            if (sameStep && records.get(payload.agent) === accepted)
                accepted.ready = true;
            return config;
        }
        catch (error) {
            if (records.get(payload.agent) === accepted)
                records.delete(payload.agent);
            throw error;
        }
    });
    ctx.on('session/event', (session, event) => {
        if (!['step/end', 'turn/end', 'agent-preset/selected'].includes(event.type))
            return;
        const agent = ctx.agents?.get(session.id);
        if (agent)
            records.delete(agent);
    });
    return {
        capture(result, context) {
            const agent = context.agent, signal = context.signal;
            if (closed || context[DSH_PREVIEW] || !agent?.session?.id ||
                !signal || signal.aborted || context.scope !== agent || ctx.agents?.get(agent.session.id) !== agent)
                return;
            const assembly = result;
            if (!Array.isArray(assembly?.sections))
                return;
            // Detach data only: never retain or dispose the host's scope/toolSet.
            records.set(agent, { signal, mode: modeOf(agent.session), selection: { ...(context.modelSelection ?? agent.options) },
                incremental: typeof assembly.systemUpdates === 'function',
                assembly: structuredClone({ sections: assembly.sections, contexts: assembly.contexts ?? [], variables: assembly.variables ?? {}, tools: assembly.tools ?? [] }) });
        },
        forRequest(options, mode) {
            if (closed || options.purpose || !options.sessionId)
                return;
            const agent = ctx.agents?.get(options.sessionId), accepted = agent && records.get(agent);
            if (!accepted?.ready)
                return;
            if (accepted.signal.aborted || accepted.signal !== options.signal || accepted.mode !== mode ||
                ['provider', 'model'].some(key => accepted.selection[key] !== options[key])) {
                throw new Error('DSH 本轮系统模板与请求不匹配，请重新发送');
            }
            const info = dshTemplateFromAssembly(accepted.assembly, mode);
            const messages = options.messages ?? [];
            const matches = accepted.incremental
                ? matchesIncrementalPrompt(messages, accepted.assembly, info)
                : (messages.findLast(message => message.source?.kind === 'system-prompt')
                    ?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? '') === info.text;
            if (!matches || !isDeepStrictEqual(options.tools ?? [], accepted.assembly.tools ?? [])) {
                throw new Error('DSH 本轮系统正文或工具集合已变化，请重新发送');
            }
            return info;
        },
    };
}
