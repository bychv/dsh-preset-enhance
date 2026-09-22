import type { AgentHandle, PluginContext, SessionLike } from '../host-types.mjs';
import { planToolRestriction } from './tool-presets.mjs';
import type { ToolPolicySnapshot } from './tool-presets.mjs';

/** The host's system-prompt assembly service (accessed without declaring an inject dependency). */
interface SystemPromptService { assemble(context: unknown): Promise<unknown> }

/** Refresh scoped restrictions before rebuilding both native schemas and the PTC SDK. */
export function installToolRestrictions(
  ctx: PluginContext, snapshot: () => ToolPolicySnapshot,
  modeOf: (session: SessionLike | undefined) => string,
): void {
  // Resolve through ctx.get(): a bare ctx.systemPrompt access throws in Cordis when the
  // service is not declared in inject, which is why the whole plugin failed to load.
  const systemPrompt = typeof ctx.get === 'function'
    ? (ctx.get('systemPrompt') as SystemPromptService | undefined)
    : (ctx as { systemPrompt?: SystemPromptService }).systemPrompt;
  if (!systemPrompt || !ctx.tools?.get) return;
  const releases = new Map<AgentHandle, () => void>();
  const rebuilding = new WeakSet<object>();
  const tracked = new WeakSet<AgentHandle>();
  ctx.effect(() => () => { for (const release of releases.values()) release(); releases.clear(); });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent as AgentHandle | undefined;
    const tools = agent?.ctx?.tools;
    if (!agent?.session || !tools?.restrict || !tools.schemas || rebuilding.has(context)) return next();
    if (!tracked.has(agent) && agent.ctx?.effect) {
      tracked.add(agent);
      agent.ctx.effect(() => () => { releases.get(agent)?.(); releases.delete(agent); });
    }
    const previous = releases.get(agent);
    previous?.();
    releases.delete(agent);
    const modeId = modeOf(agent.session);
    const standing = await ctx.agentPresets?.standingKeyFor?.(modeId);
    const catalog = tools.schemas(agent);
    // Only inherited definitions can be restricted; agent-local overrides remain guarded.
    const restrictable = catalog.filter(tool => {
      const inherited = ctx.tools?.get?.(tool.name, standing);
      return inherited !== undefined && tools.get?.(tool.name, agent) === inherited;
    }).map(tool => tool.name);
    const plan = planToolRestriction(snapshot(), agent.session.id, modeId, catalog, { restrictable });
    if (plan) releases.set(agent, tools.restrict(plan));
    if (!previous && !plan) return next();
    // The host assembles the SDK before this hook. Rebuild once with the new visibility.
    rebuilding.add(context);
    try { return await systemPrompt.assemble(context); }
    finally { rebuilding.delete(context); }
  });
}
