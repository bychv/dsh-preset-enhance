/** Public data contract; independent of the host and the future display package. */
export declare const PRESET_TEMPLATES_SERVICE: 'presetTemplates';

export interface TemplateOwnerContext {
  effect(setup: () => (() => void), label?: string): unknown;
}

export interface PromptTemplateV1 {
  id: string;
  version: string;
  title: string;
  description?: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Request-time literal body for {{dynamic::body}}; callbacks are registered separately. */
  dynamic?: { resolverId: string; input?: 'latest-user' | 'history'; output?: 'text' | 'history-patches' };
  /** Optional Tavern marker identifier; selected explicitly; chatHistory requires structured history-patches output. */
  targetMarker?: string;
  defaults?: {
    placement: 'beforeHistory' | 'afterHistory' | 'depth';
    depth?: number;
    order?: number;
  };
}

export interface TemplateProviderV1 {
  providerId: string;
  title: string;
  templates: PromptTemplateV1[];
}

export interface TemplateCatalogSnapshot {
  contractVersion: 1;
  revision: number;
  providers: TemplateProviderV1[];
}

export interface TemplateRegistration {
  /** Atomically replace this provider's catalog. Changed content needs a new version. */
  update(templates: PromptTemplateV1[]): void;
  dispose(): void;
}

export interface PresetTemplatesV1 {
  readonly contractVersion: 1;
  readonly capabilities: { readonly dynamicTemplatesV1: true; readonly historyPatchesV1: true };
  register(ownerContext: TemplateOwnerContext, definition: TemplateProviderV1, runtime?: TemplateRuntimeV1): TemplateRegistration;
  /** Returns a detached snapshot; editing it cannot change registered templates. */
  list(): TemplateCatalogSnapshot;
  /** Microtask notifications may coalesce; call list() for the latest snapshot. */
  subscribe(listener: (catalogRevision: number) => void): () => void;
}

export interface DynamicMessageV1 {
  readonly id?: string;
  readonly role: string;
  readonly content?: readonly Readonly<{ type: string; [key: string]: unknown }>[];
  readonly source?: Readonly<{ kind?: string; [key: string]: unknown }>;
}

export interface DynamicTemplateContextV1 {
  readonly sessionId: string;
  readonly requestId: string;
  readonly historyRevision: string;
  readonly presetId?: string;
  readonly identifier: string;
  readonly mode: string;
  readonly protocol: string;
  readonly purpose: 'preview' | 'request';
  readonly latestUser?: DynamicMessageV1;
  readonly userText: string;
  readonly history?: readonly DynamicMessageV1[];
  readonly variables: Readonly<{ local: Readonly<Record<string, string>>; global: Readonly<Record<string, string>>; values: Readonly<Record<string, unknown>> }>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/** Depth uses the original context.history message array, including tool messages. */
export type HistoryPatchV1 =
  | { operation: 'insert'; depth: number; role: 'system' | 'user' | 'assistant'; text: string }
  | { operation: 'replace-text' | 'append-text'; depth: number; text: string; textIndex?: number };
export interface HistoryPatchResultV1 { patches: HistoryPatchV1[] }
export type DynamicTemplateResultV1 = string | HistoryPatchResultV1;

export interface TemplateRuntimeV1 {
  resolvers: Record<string, (context: DynamicTemplateContextV1) => DynamicTemplateResultV1 | Promise<DynamicTemplateResultV1>>;
}
