/** Runtime key and type-only public contract. Importing this entry has no plugin side effects. */
export const PRESET_TEMPLATES_SERVICE = 'presetTemplates';
export type {
  TemplateOwnerContext, PromptTemplateV1, TemplateProviderV1,
  TemplateCatalogSnapshot, TemplateRegistration, PresetTemplatesV1,
  DynamicMessageV1, DynamicTemplateContextV1, TemplateRuntimeV1,
  HistoryPatchV1, HistoryPatchResultV1, DynamicTemplateResultV1,
} from './template-api.mjs';
