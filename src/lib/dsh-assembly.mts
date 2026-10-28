import { isDeepStrictEqual } from 'node:util';
import type { AgentHandle, PluginContext, SessionLike, StreamOptions } from '../host-types.mjs';
import { DSH_PREVIEW, dshTemplateFromAssembly } from './dsh-system-template.mjs';
import type { DshAssembly, DshSystemTemplate } from './dsh-system-template.mjs';
import type { Preparation } from './tool-restrictions.mjs';

interface Accepted {
  signal: AbortSignal;
  mode: string;
  selection: Record<string, unknown>;
  assembly: DshAssembly;
  position?: { turn: number; step: number };
  ready?: boolean;
}

/** Only real step assemblies participate. Preview reads never replace an accepted step. */
export function createDshAssemblyTracker(ctx: PluginContext, modeOf: (session: SessionLike | undefined) => string) {
  let records = new WeakMap<AgentHandle, Accepted>(), closed = false;
  ctx.effect(() => () => { closed = true; records = new WeakMap(); });
  ctx.on('agent/pre-step', async (payload, next) => {
    const accepted = records.get(payload.agent);
    try {
      const decision = await next();
      if (accepted && records.get(payload.agent) === accepted && accepted.signal === payload.signal && decision.kind === 'enter') {
        accepted.position = { turn: payload.turn, step: payload.step };
      } else if (accepted && records.get(payload.agent) === accepted) records.delete(payload.agent);
      return decision;
    } catch (error) { if (records.get(payload.agent) === accepted) records.delete(payload.agent); throw error; }
  });
  ctx.on('agent/request', async (payload, next) => {
    const accepted = records.get(payload.agent);
    const sameStep = accepted && accepted.signal === payload.signal && accepted.position?.turn === payload.turn && accepted.position?.step === payload.step;
    try {
      const config = await next();
      if (sameStep && records.get(payload.agent) === accepted) accepted!.ready = true;
      return config;
    } catch (error) { if (records.get(payload.agent) === accepted) records.delete(payload.agent); throw error; }
  });
  ctx.on('session/event', (session, event) => {
    if (!['step/end', 'turn/end', 'agent-preset/selected'].includes(event.type)) return;
    const agent = ctx.agents?.get(session.id);
    if (agent) records.delete(agent);
  });
  return {
    capture(result: unknown, context: Preparation) {
      const agent = context.agent, signal = context.signal as AbortSignal | undefined;
      if (closed || (context as Record<symbol, unknown>)[DSH_PREVIEW] || !agent?.session?.id ||
        !signal || signal.aborted || context.scope !== agent || ctx.agents?.get(agent.session.id) !== agent) return;
      const assembly = result as DshAssembly;
      if (!Array.isArray(assembly?.sections)) return;
      // Detach data only: never retain or dispose the host's scope/toolSet.
      records.set(agent, { signal, mode: modeOf(agent.session), selection: { ...(context.modelSelection as object ?? agent.options) },
        assembly: structuredClone({ sections: assembly.sections, contexts: assembly.contexts ?? [], variables: assembly.variables ?? {}, tools: assembly.tools ?? [] }) });
    },
    forRequest(options: StreamOptions, mode: string): DshSystemTemplate | undefined {
      if (closed || options.purpose || !options.sessionId) return;
      const agent = ctx.agents?.get(options.sessionId), accepted = agent && records.get(agent);
      if (!accepted?.ready) return;
      if (accepted.signal.aborted || accepted.signal !== options.signal || accepted.mode !== mode ||
        ['provider', 'model'].some(key => accepted.selection[key] !== options[key])) {
        throw new Error('DSH 本轮系统模板与请求不匹配，请重新发送');
      }
      const info = dshTemplateFromAssembly(accepted.assembly, mode);
      const system = options.messages?.findLast(message => message.source?.kind === 'system-prompt');
      const text = system?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? '';
      if (text !== info.text || !isDeepStrictEqual(options.tools ?? [], accepted.assembly.tools ?? [])) {
        throw new Error('DSH 本轮系统正文或工具集合已变化，请重新发送');
      }
      return info;
    },
  };
}
