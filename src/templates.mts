/** Runtime key and type-only public contract. Importing this entry has no plugin side effects. */
export const PRESET_TEMPLATES_SERVICE = 'presetTemplates';
export type {
  TemplateOwnerContext, PromptTemplateV1, TemplateProviderV1,
  TemplateCatalogSnapshot, TemplateRegistration, PresetTemplatesV1,
} from './template-api.mjs';
