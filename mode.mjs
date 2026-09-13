export const name = 'preset-enhance-mode';

// The host plugin performs the request injection. This scoped marker keeps the
// dedicated agent preset composition non-empty without registering a second
// host interceptor or changing the selected SillyTavern prompt.
export function apply() {}
