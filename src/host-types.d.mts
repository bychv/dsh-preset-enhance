/**
 * Host surface used by the preset-enhance plugin.
 *
 * Hand-written on purpose: the plugin never bundles another copy of Cordis, the
 * host framework or React, so the runtime contract it consumes is declared here
 * and re-checked against the pinned host source (currently DSH 0.1.6-alpha.2)
 * before every release. Members marked optional are probed with optional
 * chaining at runtime and must stay optional here as well.
 */

export interface PluginConfig {
  dataFile?: string;
  agentPresetRoot?: string;
  standardComposition?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface MessageSource {
  kind?: string;
  plugin?: string;
  [key: string]: unknown;
}

export interface HostMessage {
  id?: string;
  role: string;
  content?: ContentBlock[];
  source?: MessageSource;
  [key: string]: unknown;
}

export interface ToolSchemaRow {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface ToolExecution {
  name: string;
  agent?: { session?: SessionLike };
  [key: string]: unknown;
}

export interface StreamOptions {
  sessionId?: string;
  messages?: HostMessage[];
  tools?: ToolSchemaRow[];
  purpose?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface AgentPresetEvent {
  type?: string;
  data?: { agentPreset?: string };
  [key: string]: unknown;
}

export interface SessionLike {
  id?: string;
  header?: { agentPreset?: string; createdAt?: number | string; [key: string]: unknown };
  snapshotEvents?: () => AgentPresetEvent[] | undefined;
  deriveMessages?: () => HostMessage[];
  [key: string]: unknown;
}

/** The agent-scoped tool surface. restrict() lives here, not on the plugin context. */
export interface AgentToolScope {
  schemas(scope: unknown): ToolSchemaRow[];
  /**
   * Narrow what the model is offered in this scope. The host throws when the
   * context is not agent-scoped, when the filter is empty, when it names the
   * reserved PTC transport run_code, or when it names a non-restrictable tool.
   * Returns the exact disposer that lifts the restriction.
   */
  restrict(filter: { allow?: string[]; deny?: string[] }): () => void;
}

export interface AgentHandle {
  id?: string;
  ctx?: { tools?: Partial<AgentToolScope> };
  [key: string]: unknown;
}

export interface AgentModeRow {
  id: string;
  name?: string;
  description?: string;
  trust?: unknown;
  broken?: string | null;
}

export interface HostRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string>;
}

export interface HostResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: unknown): unknown;
}

export interface WebRoute {
  kind: 'exact';
  path: string;
  handler: (req: HostRequest, res: HostResponse) => unknown;
}

export interface CommandInput {
  args?: string[];
  sessionId?: string;
  text?: string;
  [key: string]: unknown;
}

export interface CommandResult {
  kind: string;
  text: string;
}

export interface CommandInvocation {
  rawInput: string;
  agent: { session: SessionLike };
  [key: string]: unknown;
}

export interface PluginCommand {
  name: string;
  description?: string;
  input?: { hint?: string; [key: string]: unknown };
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

export interface PluginContext {
  /**
   * A disposer may be synchronous or asynchronous. The host awaits an async
   * disposer before the activation is considered unloaded, which is what lets
   * this plugin drain in-flight saves before it releases the fetch bridge.
   * Verified against packages/boot/plugin-manager/src/index.ts, which itself
   * registers `ctx.effect(() => async () => { ... })`.
   */
  effect(callback: () => void | (() => void | Promise<void>), label?: string): void;
  on(event: 'llm/stream', handler: (options: StreamOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): void;
  on(event: string, handler: (...args: any[]) => any): void;
  llm: { stream(options: StreamOptions): AsyncIterable<unknown> };
  sessions: { get(id: string): SessionLike | undefined };
  webServer: { register(route: WebRoute): void };
  commands?: { register(command: PluginCommand): void };
  tools?: {
    guard?(handler: (exec: ToolExecution) => string | undefined): void;
    schemas?(scope: unknown): ToolSchemaRow[];
    /**
     * tools.restrict() requires an agent-scoped context and throws on the plugin
     * context. Declared so the shape is honest; reach it through
     * ctx.agents.get(id)?.ctx?.tools instead of calling it here.
     */
    restrict?(filter: { allow?: string[]; deny?: string[] }): () => void;
  };
  agentPresets?: {
    readDocument(id: string): Promise<{ content: string }>;
    list?(): Promise<AgentModeRow[]>;
    standingKeyFor?(id: string): Promise<unknown>;
  };
  agents?: { get(id: string): AgentHandle | undefined };
}
