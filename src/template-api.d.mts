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
  /** Optional Tavern marker identifier; selected explicitly, never chatHistory. */
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
  register(ownerContext: TemplateOwnerContext, definition: TemplateProviderV1): TemplateRegistration;
  /** Returns a detached snapshot; editing it cannot change registered templates. */
  list(): TemplateCatalogSnapshot;
  /** Microtask notifications may coalesce; call list() for the latest snapshot. */
  subscribe(listener: (catalogRevision: number) => void): () => void;
}
