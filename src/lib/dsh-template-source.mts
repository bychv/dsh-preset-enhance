import type { DshSectionTemplates, DshSystemTemplate } from './dsh-system-template.mjs';

/** Shared by request compilation and the workbench; old whole-body edits win. */
export function dshTemplateParts(preset: { dsh_system_prompt_templates?: Record<string, string>; dsh_system_prompt_sections?: DshSectionTemplates }, host: DshSystemTemplate): string[] {
  if (Object.hasOwn(preset.dsh_system_prompt_templates ?? {}, host.modeId)) return [preset.dsh_system_prompt_templates![host.modeId]];
  const overrides = preset.dsh_system_prompt_sections?.[host.modeId] ?? {};
  return host.sections.map(section => {
    const override = Object.hasOwn(overrides, section.name) ? overrides[section.name] : undefined;
    return override?.mode === 'disabled' ? '' : override?.mode === 'custom' ? override.template : section.macro;
  }).filter(Boolean);
}

export function dshTemplateSource(preset: Parameters<typeof dshTemplateParts>[0], host: DshSystemTemplate): string {
  return dshTemplateParts(preset, host).join('\n\n');
}
