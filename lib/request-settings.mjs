/** Kept in the preset so save, auto-save and single-file exports use the same settings. */
export function readRequestSettings(preset) {
    return { maxTokens: preset.dsh_request?.max_tokens ?? 0, stream: preset.dsh_request?.stream !== false };
}
export function validateRequestSettings(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('dsh_request 必须是对象');
    const settings = value;
    if (settings.max_tokens !== undefined && (!Number.isInteger(settings.max_tokens) || Number(settings.max_tokens) < 0 || Number(settings.max_tokens) > 1_000_000)) {
        throw new Error('max_tokens 必须是 0–1000000 的整数');
    }
    if (settings.stream !== undefined && typeof settings.stream !== 'boolean')
        throw new Error('stream 必须是布尔值');
}
