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
  /**
   * Opt into switching an official Messages request to the official chat/completions
   * endpoint. PARKED and off by default: the supported fix is the host's own
   * profile-level `protocol: chat-completions` setting, which needs no translation.
   * Set it (and re-check the translation notes) to bring the in-app switch back.
   */
  reroute?: boolean;
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
  provider?: string;
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
  requestHeader?: () => { config?: { provider?: string } } | undefined;
  id?: string;
  header?: { agentPreset?: string; createdAt?: number | string; [key: string]: unknown };
  snapshotEvents?: () => AgentPresetEvent[] | undefined;
  deriveMessages?: () => HostMessage[];
  [key: string]: unknown;
}

/** The agent-scoped tool surface. restrict() lives here, not on the plugin context. */
export interface AgentToolScope {
  get?(name: string, scope?: unknown): unknown;
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
  options?: { provider?: string };
  session?: SessionLike;
  id?: string;
  ctx?: { tools?: Partial<AgentToolScope>; effect?(callback: () => () => void): unknown };
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

/** One provider route the host can activate through configuration. */
export interface ConfigurableProviderInfo {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: readonly string[];
  declared?: boolean;
  error?: string;
}

/** One registered settings namespace, as described by the settings service. */
export interface SettingsDescriptorInfo {
  ns: string;
  /** Resolved value of the namespace. */
  value: unknown;
  revision: number;
}

export interface SettingsServiceLike {
  describe?(options?: { redactSecrets?: boolean }): SettingsDescriptorInfo[];
  update?(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

export interface PluginContext {
  /** Run a callback once the named services are available (host's own optional-dependency pattern). */
  inject?(names: string[], callback: (scoped: any) => void): unknown;
  /**
   * Resolve any registered service by name without declaring a dependency.
   * Used for optional services (`settings`) so a profile without them still loads.
   */
  get?<T = any>(name: string): T | undefined;
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
  llm: {
    stream(options: StreamOptions): AsyncIterable<unknown>;
    /** Routes the host can activate through configuration; absent on older hosts. */
    listConfigurableProviders?(): ConfigurableProviderInfo[];
  };
  sessions: { get(id: string): SessionLike | undefined };
  webServer: { register(route: WebRoute): void };
  commands?: { register(command: PluginCommand): void };
  systemPrompt?: { assemble(context: any): Promise<any> };
  tools?: {
    get?(name: string, scope?: unknown): unknown;
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
