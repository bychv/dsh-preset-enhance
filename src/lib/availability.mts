/**
 * Process-wide availability state for the generated preset mode.
 *
 * The dedicated `st-preset` mode is a real file the host enumerates from disk, so
 * it cannot be hidden per plugin: deleting it would break the sessions that use it
 * and would also throw away a user-visible mode. `src/mode.mts` therefore checks
 * this marker instead. While the host plugin is active the mode mounts normally;
 * once the plugin is disabled, unloaded, or its startup failed, the mode refuses to
 * mount with an explicit, actionable reason rather than silently degrading to a
 * request that carries no preset injection at all.
 *
 * The state is shared through `globalThis` under registered symbols so the
 * published `lib/availability.mjs` and the `dist/lib/availability.mjs` copy — or
 * two module copies in one process — agree on the same slot. The activation count
 * is a counter, so an overlapping activation (hot reload) cannot clear it early.
 */
const MARKER = Symbol.for('dsh-preset-enhance.active');
const UNAVAILABLE_REASON = Symbol.for('dsh-preset-enhance.unavailable-reason');

interface ActivationSlot { count: number }

const slots = (): Record<symbol, unknown> =>
  globalThis as unknown as Record<symbol, unknown>;

/**
 * Mark the host plugin active. The returned function removes this activation and
 * is idempotent, so a doubled dispose can never underflow the marker.
 */
export function markPresetEnhanceActive(): () => void {
  const store = slots();
  const slot = (store[MARKER] as ActivationSlot | undefined) ?? { count: 0 };
  slot.count += 1;
  store[MARKER] = slot;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = store[MARKER] as ActivationSlot | undefined;
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) delete store[MARKER];
  };
}

/** True while at least one activation of the host plugin is live. */
export function isPresetEnhanceActive(): boolean {
  return ((slots()[MARKER] as ActivationSlot | undefined)?.count ?? 0) > 0;
}

/**
 * Remember why the plugin could not finish starting. A failed startup must not
 * look like a plain disable: the preset mode reports this reason instead.
 */
export function setPresetEnhanceUnavailableReason(reason: string): void {
  slots()[UNAVAILABLE_REASON] = reason;
}

/** Forget a previous startup failure once the plugin starts cleanly again. */
export function clearPresetEnhanceUnavailableReason(): void {
  delete slots()[UNAVAILABLE_REASON];
}

/** Generic reason used when the plugin is simply not enabled. */
export const PRESET_ENHANCE_INACTIVE_REASON =
  '预设增强插件未启用：st-preset 模式只负责预设注入与工具策略，插件关闭时不会注入任何内容。'
  + '请先在插件管理中启用 dsh-preset-enhance 后重新选择该模式，或改用其他模式。';

/** The most specific known reason the preset mode cannot inject, for the mode to report. */
export function presetEnhanceUnavailableReason(): string {
  const recorded = slots()[UNAVAILABLE_REASON];
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : PRESET_ENHANCE_INACTIVE_REASON;
}
