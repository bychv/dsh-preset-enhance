import { createHash } from 'node:crypto';
import { getOrder } from './preset.mjs';
import { runSPresetScript, scriptFunction } from './spreset-script.mjs';
import type { AgentHandle, PluginContext } from '../host-types.mjs';
import type { SillyTavernPreset } from './types.mjs';

export interface SPresetSelection { id: string; preset: SillyTavernPreset; characterId?: string | number | null }
export interface SPresetTool { name: string; description: string; parameters: Record<string, unknown>; code: string; bindingId: string }
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function spresetSettings(preset?: SillyTavernPreset): Record<string, any> | undefined {
  return preset?.dsh_spreset_tools_enabled === true ? (preset.extensions as any)?.SPreset ?? {} : undefined;
}
export async function readSPresetTools(selection: SPresetSelection, signal?: AbortSignal): Promise<SPresetTool[]> {
  const settings = spresetSettings(selection.preset);
  if (!settings) return [];
  const active = new Set(getOrder(selection.preset, selection.characterId).filter(row => row.enabled !== false).map(row => row.identifier));
  for (const prompt of selection.preset.prompts) {
    if (active.has(prompt.identifier) && prompt.spreset_condition_enabled === true) throw new Error('实验性 SPreset 工具暂不支持条目条件脚本');
  }
  const bindings = object(settings.ToolBindings) ? settings.ToolBindings : {};
  const rows: SPresetTool[] = [];
  for (const [bindingId, binding] of Object.entries(bindings)) {
    if (!object(binding) || !binding.enabled || binding.valid === false || !active.has(bindingId)) continue;
    if (rows.length >= 32) throw new Error('SPreset 工具数量超过 32');
    const code = String(binding.code ?? '');
    const value = await runSPresetScript(`(() => { const tool = (function(){${code}\n})();
      if (!tool || typeof tool.action !== 'function') throw Error('工具缺少 action');
      return { name:tool.name, description:tool.description, parameters:tool.parameters, stealth:tool.stealth };
    })()`, {}, signal);
    if (!object(value) || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name) || typeof value.description !== 'string' || !object(value.parameters)) throw new Error('SPreset 工具定义无效');
    if (value.stealth === true) throw new Error('实验性 SPreset 工具暂不支持 stealth');
    if (value.name === 'run_code' || rows.some(row => row.name === value.name)) throw new Error('SPreset 工具名称冲突：' + value.name);
    rows.push({ ...value, code, bindingId } as SPresetTool);
  }
  return rows;
}

/** Agent-owned registrations are prepared before the host admits its tool set. */
export function createSPresetTools(ctx: PluginContext, select: (agent: AgentHandle) => Promise<SPresetSelection | undefined>,
  enabled: (agent: AgentHandle, name: string) => boolean) {
  const agents = new Map<AgentHandle, { key: string; dispose: (() => void)[] }>();
  const retired = new WeakSet<AgentHandle>();
  let closed = false;
  function clear(agent: AgentHandle) { const state = agents.get(agent); agents.delete(agent); for (const dispose of state?.dispose ?? []) dispose(); }
  ctx.effect(() => () => { closed = true; for (const agent of agents.keys()) clear(agent); });
  return {
    async prepare(agent: AgentHandle) {
      if (closed || retired.has(agent)) return;
      const selection = await select(agent);
      if (closed || retired.has(agent)) return;
      const key = selection && spresetSettings(selection.preset) ? createHash('sha256').update(JSON.stringify(selection)).digest('hex') : '';
      if (!key) { clear(agent); return; }
      if (!agents.has(agent)) {
        agents.set(agent, { key: '', dispose: [] });
        agent.ctx?.effect?.(() => () => { retired.add(agent); clear(agent); });
      }
      if (agents.get(agent)?.key === key) return;
      clear(agent);
      const state = { key: '', dispose: [] as (() => void)[] };
      agents.set(agent, state);
      if (!key || !selection) return;
      try {
        const rows = await readSPresetTools(selection);
        if (closed || retired.has(agent)) return;
        const tools = agent.ctx?.tools;
        if (!tools?.register) throw new Error('当前 DSH 不支持会话工具注册');
        for (const row of rows) {
          if (tools.get?.(row.name, agent)) throw new Error('SPreset 与已有工具名称冲突：' + row.name);
          const dispose = tools.register({
            name: row.name, description: row.description, parameters: row.parameters,
            output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
            execute: async (args: unknown, exec: { signal?: AbortSignal }) => {
              const current = await select(agent);
              if (closed || retired.has(agent) || !current || createHash('sha256').update(JSON.stringify(current)).digest('hex') !== key || !enabled(agent, row.name)) throw new Error('SPreset 工具已停用或预设已变化');
              return runSPresetScript(`(function(){${row.code}\n})().action(input)`, args, exec.signal);
            },
          }, { when: () => !closed && !retired.has(agent) && enabled(agent, row.name) });
          if (typeof dispose === 'function') state.dispose.push(dispose);
        }
        state.key = key;
      } catch (error) { clear(agent); throw error; }
    },
  };
}

/** Stateful data-only output processing, with script state kept within one request. */
class OutputSession {
  state: unknown = {}; hold = ''; raw = ''; output = '';
  readonly config: any; readonly context: any; readonly signal?: AbortSignal;
  constructor(config: any, context: any, signal?: AbortSignal) { this.config=config; this.context=context; this.signal=signal; }
  async push(chunk: string, final = false): Promise<string> {
    this.raw += chunk;
    if (this.raw.length > 2 * 1024 * 1024) throw new Error('SPreset 输出超过大小限制');
    let emitted = chunk;
    if (this.config.enabled) {
      const result = await runSPresetScript(`${scriptFunction(this.config.script)}(input)`, {
        ...this.context, buffer: this.hold + chunk, chunk, hold: this.hold, output: this.output, raw: this.raw, state: this.state, final, channel: 'main',
      }, this.signal);
      if (typeof result === 'string') { emitted = result; this.hold = ''; }
      else if (object(result) && ['output','emit','text','content'].some(key => Object.hasOwn(result,key))) {
        emitted = String(result.output ?? result.emit ?? result.text ?? result.content ?? '');
        this.hold = String(result.hold ?? '');
        if (result.state !== undefined) this.state = result.state;
      } else throw new Error('SPreset 输出预处理结果无效');
      if (final) { emitted += this.hold; this.hold = ''; }
    }
    this.output += emitted;
    return emitted;
  }
}

async function formatCalls(calls: any[], config: any, context: any, signal?: AbortSignal): Promise<string> {
  const parsed = calls.map(call => ({ id: call.id, name: call.name, arguments: JSON.parse(call.arguments) }));
  const defaultText = parsed.map(call => {
    const value = call.arguments;
    if (typeof value === 'string') return value;
    if (object(value) && Object.keys(value).length === 1) { const only = Object.values(value)[0]; if (typeof only === 'string') return only; }
    return JSON.stringify(value);
  }).join('\n');
  const formatter = typeof config.toolCallFormatter === 'string' ? { enabled: !!config.toolCallFormatter, script: config.toolCallFormatter } : config.toolCallFormatter;
  if (!formatter?.enabled) return defaultText;
  const result = await runSPresetScript(`${scriptFunction(formatter.script)}(input)`, { calls: parsed, defaultText, ...context, final: true, channel:'main' }, signal);
  if (typeof result === 'string') return result;
  if (object(result) && ['output','text','content'].some(key => Object.hasOwn(result,key))) return String(result.output ?? result.text ?? result.content ?? '');
  throw new Error('SPreset 工具格式化结果无效');
}

/** Official llm/stream chunks, after protocol/DSML recovery and before durable history. */
export async function* consumeSPresetStream(source: AsyncIterable<any>, settings: any, context: any = {}, signal?: AbortSignal): AsyncGenerator<any> {
  const config = settings?.OutputPreprocessing;
  if (!config?.enabled) { yield* source; return; }
  const consume = config.consumeToolCalls === true;
  const pending: any[] = [], calls = new Map<number, any>();
  const session = new OutputSession(config, context, signal);
  let opened = false, failed = false;
  const emit = (text: string) => {
    const chunks: any[] = [];
    if (text) { if (!opened) { chunks.push({ type:'block-start', index:1, blockType:'text' }); opened = true; }
      chunks.push({ type:'text-delta', index:1, text }); }
    return chunks;
  };
  const complete = new Set<number>();
  let terminal: any;
  for await (const original of source) {
    signal?.throwIfAborted();
    const chunk = typeof original?.index === 'number' ? { ...original, index: original.index * 2 + 2 } : original;
    if (chunk.type === 'finish') { terminal = chunk; break; }
    if (chunk.type === 'block-start' && chunk.blockType === 'text') continue;
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') continue;
    if (chunk.type === 'text-delta') {
      if (failed) { session.output += chunk.text; yield* emit(chunk.text); }
      else try { yield* emit(await session.push(chunk.text)); }
      catch { failed = true; console.warn('preset-enhance: SPreset 输出预处理失败，后续正文保持原文');
        const text = session.hold + chunk.text; session.hold = ''; session.output += text; yield* emit(text); }
      continue;
    }
    const tool = (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
    if (consume && tool) {
      if (pending.length > 16384) throw new Error('SPreset 工具分片超过限制');
      pending.push(chunk);
      if (chunk.type === 'tool-call-delta') {
        const call = calls.get(chunk.index) ?? { id:chunk.id, name:'', arguments:'' };
        call.name = chunk.name ?? call.name; call.arguments += chunk.argumentsDelta ?? ''; calls.set(chunk.index,call);
        if (call.arguments.length > 2 * 1024 * 1024) throw new Error('SPreset 工具参数超过大小限制');
      }
      if (chunk.type === 'block-end') { calls.set(chunk.index, chunk.block); complete.add(chunk.index); }
      continue;
    }
    yield chunk;
  }
  const normal = terminal && ['stop','tool-calls'].includes(terminal.reason?.kind);
  let consumed = false;
  // Formatting is transactional: do not emit its result until output finalization succeeds.
  if (consume && calls.size && complete.size === calls.size && normal && !failed) {
    const checkpoint = { raw:session.raw, output:session.output, hold:session.hold, state:structuredClone(session.state) };
    try {
      const text = await formatCalls([...calls.values()], config, context, signal);
      const addition = session.raw && !session.raw.endsWith('\n') && text ? '\n' + text : text;
      const tail = await session.push(addition) + await session.push('', true);
      yield* emit(tail); consumed = true;
    } catch {
      Object.assign(session,checkpoint);
      console.warn('preset-enhance: SPreset 调用消费失败，恢复 DSH 工具处理');
      try { yield* emit(await session.push('', true)); }
      catch { const held = session.hold; session.hold = ''; session.output += held; yield* emit(held); }
    }
  } else if (normal && !failed) {
    try { yield* emit(await session.push('', true)); }
    catch { failed = true; yield* emit(session.hold); session.hold = ''; }
  }
  signal?.throwIfAborted();
  if (opened) yield { type:'block-end', index:1, block:{ type:'text', text:session.output } };
  if (!consumed) yield* pending;
  if (terminal) {
    const { replayState: _replay, ...finish } = terminal;
    yield { ...finish, ...(consumed ? { reason:{ kind:'stop' } } : {}) };
  }
}
