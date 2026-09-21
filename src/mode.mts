import { isPresetEnhanceActive, presetEnhanceUnavailableReason } from './lib/availability.mjs';

export const name = 'preset-enhance-mode';

/**
 * The host plugin performs the request injection. This scoped marker keeps the
 * dedicated agent preset composition non-empty without registering a second
 * host interceptor or changing the selected SillyTavern prompt.
 *
 * It is also the mode's availability check: with the host plugin disabled — or
 * with its startup failed — the mode would otherwise mount as an ordinary preset
 * and quietly send requests with no preset injection, which the compatibility
 * plan forbids. Failing the mount makes that state explicit and recoverable
 * instead of silent, and the reported reason distinguishes a plain disable from a
 * startup failure the user has to fix.
 */
export function apply() {
  if (!isPresetEnhanceActive()) throw new Error(presetEnhanceUnavailableReason());
}
