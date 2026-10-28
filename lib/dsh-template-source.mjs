/** Shared by request compilation and the workbench; old whole-body edits win. */
export function dshTemplateParts(preset, host) {
    if (Object.hasOwn(preset.dsh_system_prompt_templates ?? {}, host.modeId))
        return [preset.dsh_system_prompt_templates[host.modeId]];
    const overrides = preset.dsh_system_prompt_sections?.[host.modeId] ?? {};
    return host.sections.map(section => {
        const override = Object.hasOwn(overrides, section.name) ? overrides[section.name] : undefined;
        return override?.mode === 'disabled' ? '' : override?.mode === 'custom' ? override.template : section.macro;
    }).filter(Boolean);
}
export function dshTemplateSource(preset, host) {
    return dshTemplateParts(preset, host).join('\n\n');
}
