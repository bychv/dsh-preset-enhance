import { planToolRestriction } from './tool-presets.mjs';
/** Install a reversible service-method bridge, preserving Cordis caller tracing. */
function beforePreparation(ctx, service, name, before) {
    // Reading service[name] binds it to the plugin's Cordis context. Read the raw
    // descriptor instead so calls from agent scopes retain their original `this`.
    let owner = service;
    while (owner && !Object.getOwnPropertyDescriptor(owner, name))
        owner = Object.getPrototypeOf(owner);
    const original = owner && Object.getOwnPropertyDescriptor(owner, name)?.value;
    if (typeof original !== 'function')
        return;
    const own = Object.getOwnPropertyDescriptor(service, name);
    let active = true;
    const wrapped = async function (context = {}) {
        if (active)
            await before(context);
        return original.call(this, context);
    };
    ctx.effect(() => {
        Object.defineProperty(service, name, { configurable: true, writable: true, value: wrapped });
        return () => {
            active = false;
            if (Object.getOwnPropertyDescriptor(service, name)?.value !== wrapped)
                return;
            if (own)
                Object.defineProperty(service, name, own);
            else
                Reflect.deleteProperty(service, name);
        };
    });
}
/** Apply policy before step admission (0.2.2) and schema/SDK collection (0.2.1). */
export function installToolRestrictions(ctx, snapshot, modeOf, prepareTools) {
    const systemPrompt = typeof ctx.get === 'function'
        ? ctx.get('systemPrompt') : ctx.systemPrompt;
    if (!systemPrompt || !ctx.tools?.get)
        return;
    const releases = new Map();
    const pending = new WeakMap();
    const tracked = new WeakSet();
    const retired = new WeakSet();
    let closed = false;
    ctx.effect(() => () => { closed = true; for (const release of releases.values())
        release(); releases.clear(); });
    async function refresh(agent) {
        const tools = agent.ctx?.tools;
        if (closed || retired.has(agent) || !agent.session || !tools?.restrict || !tools.schemas)
            return;
        if (!tracked.has(agent) && agent.ctx?.effect) {
            tracked.add(agent);
            agent.ctx.effect(() => () => { retired.add(agent); releases.get(agent)?.(); releases.delete(agent); });
        }
        releases.get(agent)?.();
        releases.delete(agent);
        await prepareTools?.(agent);
        if (closed || retired.has(agent))
            return;
        const modeId = modeOf(agent.session);
        const lease = await ctx.agentPresets?.acquireScope?.(modeId || undefined);
        try {
            const standing = lease?.key ?? await ctx.agentPresets?.standingKeyFor?.(modeId);
            if (closed || retired.has(agent))
                return;
            const catalog = tools.schemas(agent);
            // Mode-owned tools are inherited too; root-only lookup misses these.
            // Agent-local overrides cannot be restricted and remain execution-guarded.
            const restrictable = catalog.filter(tool => {
                const inherited = ctx.tools?.get?.(tool.name, standing);
                return inherited !== undefined && tools.get?.(tool.name, agent) === inherited;
            }).map(tool => tool.name);
            const plan = planToolRestriction(snapshot(), agent.session.id, modeId, catalog, { restrictable });
            if (plan)
                releases.set(agent, tools.restrict(plan));
        }
        finally {
            await lease?.[Symbol.asyncDispose]();
        }
    }
    function prepare(context) {
        const agent = context.agent;
        if (!agent)
            return Promise.resolve();
        const work = (pending.get(agent) ?? Promise.resolve()).catch(() => { }).then(() => refresh(agent));
        pending.set(agent, work);
        return work;
    }
    // There is no pre-admission waterfall in 0.2.2: agent/pre-step is too late.
    // Keep the bridge limited to the public preparation methods, with owned cleanup.
    beforePreparation(ctx, ctx.tools, 'resolve', prepare);
    beforePreparation(ctx, systemPrompt, 'assemble', context => context.toolSet === undefined ? prepare(context) : Promise.resolve());
}
