import type { AgentHandle, PluginContext, SessionLike } from '../host-types.mjs';
import { planToolRestriction } from './tool-presets.mjs';
import type { ToolPolicySnapshot } from './tool-presets.mjs';

export type Preparation = { agent?: AgentHandle; toolSet?: unknown; [key: string]: unknown };
type PrepareMethod = (this: unknown, context: Preparation) => Promise<unknown>;

/** Install a reversible service-method bridge, preserving Cordis caller tracing. */
function beforePreparation(ctx: PluginContext, service: object, name: string,
  before: (context: Preparation) => Promise<void>, after?: (result: unknown, context: Preparation) => void): void {
  // Reading service[name] binds it to the plugin's Cordis context. Read the raw
  // descriptor instead so calls from agent scopes retain their original `this`.
  let owner: object | null = service;
  while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
  const original = owner && Object.getOwnPropertyDescriptor(owner, name)?.value as PrepareMethod | undefined;
  if (typeof original !== 'function') return;
  const own = Object.getOwnPropertyDescriptor(service, name);
  let active = true;
  const wrapped: PrepareMethod = async function(context = {}) {
    if (active) await before(context);
    const result = await original.call(this, context);
    if (active) after?.(result, context);
    return result;
  };
  ctx.effect(() => {
    Object.defineProperty(service, name, { configurable: true, writable: true, value: wrapped });
    return () => {
      active = false;
      if (Object.getOwnPropertyDescriptor(service, name)?.value !== wrapped) return;
      if (own) Object.defineProperty(service, name, own);
      else Reflect.deleteProperty(service, name);
    };
  });
}

/** Apply policy before step admission (0.2.2) and schema/SDK collection (0.2.1). */
export function installToolRestrictions(
  ctx: PluginContext, snapshot: () => ToolPolicySnapshot,
  modeOf: (session: SessionLike | undefined) => string,
  prepareTools?: (agent: AgentHandle) => Promise<void>,
  acceptedAssembly?: (result: unknown, context: Preparation) => void,
): void {
  const systemPrompt = typeof ctx.get === 'function'
    ? ctx.get('systemPrompt') : (ctx as { systemPrompt?: object }).systemPrompt;
  if (!systemPrompt || !ctx.tools?.get) return;
  const releases = new Map<AgentHandle, () => void>();
  const pending = new WeakMap<AgentHandle, Promise<void>>();
  const tracked = new WeakSet<AgentHandle>();
  const retired = new WeakSet<AgentHandle>();
  let closed = false;
  ctx.effect(() => () => { closed = true; for (const release of releases.values()) release(); releases.clear(); });

  async function refresh(agent: AgentHandle): Promise<void> {
    const tools = agent.ctx?.tools;
    if (closed || retired.has(agent) || !agent.session || !tools?.restrict || !tools.schemas) return;
    if (!tracked.has(agent) && agent.ctx?.effect) {
      tracked.add(agent);
      agent.ctx.effect(() => () => { retired.add(agent); releases.get(agent)?.(); releases.delete(agent); });
    }
    releases.get(agent)?.();
    releases.delete(agent);
    await prepareTools?.(agent);
    if (closed || retired.has(agent)) return;
    const modeId = modeOf(agent.session);
    const lease = await ctx.agentPresets?.acquireScope?.(modeId || undefined);
    try {
      const standing = lease?.key ?? await ctx.agentPresets?.standingKeyFor?.(modeId);
      if (closed || retired.has(agent)) return;
      const catalog = tools.schemas(agent);
      // Mode-owned tools are inherited too; root-only lookup misses these.
      // Agent-local overrides cannot be restricted and remain execution-guarded.
      const restrictable = catalog.filter(tool => {
        const inherited = ctx.tools?.get?.(tool.name, standing);
        return inherited !== undefined && tools.get?.(tool.name, agent) === inherited;
      }).map(tool => tool.name);
      const plan = planToolRestriction(snapshot(), agent.session.id, modeId, catalog, { restrictable });
      if (plan) releases.set(agent, tools.restrict(plan));
    } finally { await lease?.[Symbol.asyncDispose](); }
  }
  function prepare(context: Preparation): Promise<void> {
    const agent = context.agent;
    if (!agent) return Promise.resolve();
    const work = (pending.get(agent) ?? Promise.resolve()).catch(() => {}).then(() => refresh(agent));
    pending.set(agent, work);
    return work;
  }
  // There is no pre-admission waterfall in 0.2.2: agent/pre-step is too late.
  // Keep the bridge limited to the public preparation methods, with owned cleanup.
  beforePreparation(ctx, ctx.tools, 'resolve', prepare);
  beforePreparation(ctx, systemPrompt, 'assemble', context =>
    context.toolSet === undefined ? prepare(context) : Promise.resolve(), acceptedAssembly);
}
