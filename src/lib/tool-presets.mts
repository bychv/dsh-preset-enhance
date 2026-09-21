/**
 * Tool preset and tool group domain logic.
 *
 * Groups and presets only organise tools. Runtime resolution always expands a
 * preset into a flat per-tool answer, and both the request filter and the
 * execution guard call the same resolver so they can never disagree.
 */

import type {
  PresetState, ToolCatalogMap, ToolCatalogRow, ToolGroup, ToolPolicy, ToolPreset, ToolPresetRule,
  ToolRef, ToolSelection, ToolsSection,
} from './types.mjs';

export const TOOL_VIRTUAL_ALL = '@all';
export const TOOL_VIRTUAL_UNGROUPED = '@ungrouped';
export const TOOL_GROUP_LIMIT = 100;
export const TOOL_PRESET_LIMIT = 100;
export const TOOL_GROUP_MEMBER_LIMIT = 2000;
export const TOOL_PRESET_RULE_LIMIT = 5000;

/**
 * The PTC program-call entry, reserved by DSH for the generated transport
 * (`packages/core/tools/src/ptc.ts` RUN_CODE_NAME).
 *
 * It is not an ordinary tool: `packages/core/tools/src/index.ts` never
 * registers it in the global layer and `tools.restrict()` refuses a filter that
 * names it, because restricting it would leave a program-call session with no
 * tool it may call directly. A stored, exported or hand-edited policy can still
 * claim it is disabled, so every resolver here keeps it enabled and every
 * restriction planner here refuses to name it.
 */
export const TOOL_ENTRY_NAME = 'run_code';

const ID_LIMIT = 100;
const NAME_LIMIT = 100;
const DESCRIPTION_LIMIT = 500;
const REF_LIMIT = 200;

/** The one predicate behind every "is this the program-call entry" decision. */
export function isToolEntry(toolName: string): boolean {
  return toolName === TOOL_ENTRY_NAME;
}

/** Any catalog-like row list; only `name` is read by this module. */
export interface ToolNameRow {
  name?: unknown;
}

/** Anything that lists tools for one mode: host schemas or the stored catalog. */
export type ToolNameList = readonly ToolNameRow[] | undefined;

/** A map whose values are copied out of stored state; never forwarded by reference. */
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Own-property read: stored maps may legitimately carry `__proto__` as a real key. */
const ownGet = <T,>(object: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined;

/** Define instead of set, so a key like `__proto__` becomes an own property. */
const assign = <T,>(object: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
};

const entries = <T,>(value: unknown): [string, T][] =>
  isRecord(value) ? Object.entries(value) as [string, T][] : [];

/** Stable key for a `{modeId, toolName}` reference; JSON keeps embedded separators unambiguous. */
export function toolRefKey(modeId: unknown, toolName: unknown): string {
  return JSON.stringify([String(modeId), String(toolName)]);
}
export function toolRefLabel(ref?: Partial<ToolRef> | null): string {
  return `${ref?.modeId ?? ''}/${ref?.toolName ?? ''}`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}不能为空`);
  if (value.length > ID_LIMIT) throw new Error(`${label}不能超过 ${ID_LIMIT} 个字符`);
  if (value.trim().length === 0) throw new Error(`${label}不能为空`);
  return value;
}
function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}不能为空`);
  if (value.length > NAME_LIMIT) throw new Error(`${label}不能超过 ${NAME_LIMIT} 个字符`);
  return value;
}
function optionalText(value: unknown, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  if (value.length > DESCRIPTION_LIMIT) throw new Error(`${label}不能超过 ${DESCRIPTION_LIMIT} 个字符`);
  return value;
}
function requireRef(value: unknown, label: string): ToolRef {
  if (!isRecord(value)) throw new Error(`${label}必须是对象`);
  const { modeId, toolName } = value;
  if (typeof modeId !== 'string' || modeId.length === 0 || modeId.length > REF_LIMIT) throw new Error(`${label}的 modeId 无效`);
  if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > REF_LIMIT) throw new Error(`${label}的 toolName 无效`);
  return { modeId, toolName };
}
function catalogRefs(catalogs: ToolCatalogMap | undefined): Set<string> {
  const known = new Set<string>();
  for (const [modeId, catalog] of entries<ToolCatalogRow[]>(catalogs)) {
    if (!Array.isArray(catalog)) continue;
    for (const tool of catalog) if (tool && typeof tool.name === 'string') known.add(toolRefKey(modeId, tool.name));
  }
  return known;
}
function existingGroupRefs(groups: ToolGroup[] | undefined): Set<string> {
  const known = new Set<string>();
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const member of Array.isArray(group?.members) ? group.members : []) {
      if (typeof member?.modeId === 'string' && typeof member?.toolName === 'string') {
        known.add(toolRefKey(member.modeId, member.toolName));
      }
    }
  }
  return known;
}

/** Options of {@link normalizeToolGroups}; catalogs are the full discovered list. */
export interface NormalizeToolGroupsOptions {
  catalogs?: ToolCatalogMap;
  existing?: ToolGroup[];
  allowUnknownRefs?: boolean;
}

/**
 * Validate and normalise a whole group list.
 * New references must exist in `catalogs`; references already stored in
 * `existing` may stay unmatched so a missing plugin can be reinstalled later.
 */
export function normalizeToolGroups(value: unknown, options: NormalizeToolGroupsOptions = {}): ToolGroup[] {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) throw new Error('工具分组必须是数组');
  if (list.length > TOOL_GROUP_LIMIT) throw new Error(`工具分组最多 ${TOOL_GROUP_LIMIT} 个`);
  const known = options.allowUnknownRefs === true ? null : catalogRefs(options.catalogs);
  const kept = options.allowUnknownRefs === true ? null : existingGroupRefs(options.existing);
  const ids = new Set<string>();
  const claimed = new Set<string>();
  const groups: ToolGroup[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) throw new Error('工具分组必须是对象');
    const id = requireId(raw.id, '分组 ID');
    if (id.startsWith('@')) throw new Error('分组 ID 不能以 @ 开头，@all 和 @ungrouped 是虚拟分组');
    if (ids.has(id)) throw new Error(`分组 ID 重复：${id}`);
    ids.add(id);
    const name = requireName(raw.name, `分组「${id}」的名称`);
    const description = optionalText(raw.description, `分组「${name}」的说明`);
    const order = raw.order === undefined ? 100 : Number(raw.order);
    if (!Number.isFinite(order)) throw new Error(`分组「${name}」的排序必须是数字`);
    const members = raw.members === undefined || raw.members === null ? [] : raw.members;
    if (!Array.isArray(members)) throw new Error(`分组「${name}」的成员必须是数组`);
    if (members.length > TOOL_GROUP_MEMBER_LIMIT) throw new Error(`分组「${name}」最多 ${TOOL_GROUP_MEMBER_LIMIT} 个成员`);
    const normalized: ToolRef[] = [];
    const seen = new Set<string>();
    for (const item of members) {
      const ref = requireRef(item, `分组「${name}」的成员`);
      const key = toolRefKey(ref.modeId, ref.toolName);
      if (seen.has(key)) throw new Error(`分组「${name}」中存在重复成员：${toolRefLabel(ref)}`);
      seen.add(key);
      if (claimed.has(key)) throw new Error(`工具 ${toolRefLabel(ref)} 已属于其他分组`);
      claimed.add(key);
      if (known && !known.has(key) && !(kept?.has(key) ?? false)) {
        throw new Error(`工具引用不属于已知目录：${toolRefLabel(ref)}`);
      }
      normalized.push({ modeId: ref.modeId, toolName: ref.toolName });
    }
    groups.push({ id, name, description, order, members: normalized });
  }
  return groups;
}

/** Syntax-only rule validation: a rule may reference a tool that is not installed. */
export function normalizeToolPresetRules(value: unknown): ToolPresetRule[] {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) throw new Error('工具预设规则必须是数组');
  if (list.length > TOOL_PRESET_RULE_LIMIT) throw new Error(`工具预设最多 ${TOOL_PRESET_RULE_LIMIT} 条规则`);
  const rules: ToolPresetRule[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const ref = requireRef(raw, '工具预设规则');
    if (!isRecord(raw) || typeof raw.enabled !== 'boolean') throw new Error(`工具预设规则 ${toolRefLabel(ref)} 的 enabled 必须是布尔值`);
    const key = toolRefKey(ref.modeId, ref.toolName);
    if (seen.has(key)) throw new Error(`工具预设规则重复：${toolRefLabel(ref)}`);
    seen.add(key);
    rules.push({ modeId: ref.modeId, toolName: ref.toolName, enabled: raw.enabled });
  }
  return rules;
}

/** A preset body whose `id` is still unresolved; `null` means "about to be created". */
export interface ToolPresetDraft extends Omit<ToolPreset, 'id'> {
  id: string | null;
}

/** Normalise a preset body. `id` is null for a preset that is about to be created. */
export function normalizeToolPreset(value: unknown): ToolPresetDraft {
  if (!isRecord(value)) throw new Error('工具预设必须是对象');
  const name = requireName(value.name, '工具预设名称');
  const description = optionalText(value.description, '工具预设说明');
  const defaultEnabled = value.defaultEnabled === undefined ? true : value.defaultEnabled;
  if (typeof defaultEnabled !== 'boolean') throw new Error('工具预设的 defaultEnabled 必须是布尔值');
  const groupIdsRaw = value.groupIds === undefined || value.groupIds === null ? [] : value.groupIds;
  if (!Array.isArray(groupIdsRaw)) throw new Error('工具预设引用的分组必须是数组');
  if (groupIdsRaw.length > TOOL_GROUP_LIMIT) throw new Error(`工具预设最多引用 ${TOOL_GROUP_LIMIT} 个分组`);
  const groupIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of groupIdsRaw) {
    const id = requireId(raw, '工具预设引用的分组 ID');
    if (id.startsWith('@')) throw new Error('工具预设不能引用虚拟分组');
    if (seen.has(id)) throw new Error(`工具预设引用的分组重复：${id}`);
    seen.add(id);
    groupIds.push(id);
  }
  const rules = normalizeToolPresetRules(value.rules);
  const id = value.id === undefined || value.id === null || value.id === '' ? null : requireId(value.id, '工具预设 ID');
  if (id?.startsWith('@')) throw new Error('工具预设 ID 不能以 @ 开头');
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.length > 0 ? value.updatedAt : new Date().toISOString();
  return { id, name, description, defaultEnabled, groupIds, rules, updatedAt };
}

/** `inherit` only exists for a session; a mode default is always custom or a preset. */
export function normalizeToolSelection(value: unknown, scope: 'mode' | 'session'): ToolSelection {
  if (scope !== 'mode' && scope !== 'session') throw new Error('未知的工具策略范围');
  const fallback = (): ToolSelection => scope === 'session' ? { kind: 'inherit' } : { kind: 'custom' };
  if (value === undefined || value === null) return fallback();
  if (!isRecord(value)) throw new Error('工具策略选择必须是对象');
  if (value.kind === 'inherit') {
    if (scope !== 'session') throw new Error('模式默认不支持继承');
    return { kind: 'inherit' };
  }
  if (value.kind === 'custom') return { kind: 'custom' };
  if (value.kind === 'preset') {
    const presetId = requireId(value.presetId, '工具预设 ID');
    if (presetId.startsWith('@')) throw new Error('工具预设 ID 不能以 @ 开头');
    return { kind: 'preset', presetId };
  }
  throw new Error('工具策略选择无效');
}

export function assertPresetGroupIds<T extends { groupIds: string[] }>(preset: T, groups: readonly (ToolGroup | undefined)[] | undefined): T {
  const known = new Set((Array.isArray(groups) ? groups : []).map(group => group?.id));
  for (const id of preset.groupIds) {
    if (!known.has(id)) throw new Error(`工具预设引用了不存在的分组：${id}`);
  }
  return preset;
}

/** The stored row shapes this module repairs; fields stay `unknown` until checked. */
interface StoredGroupRow extends UnknownRecord { id: string; name?: unknown; description?: unknown; order?: unknown; members?: unknown }
interface StoredMemberRow extends UnknownRecord { modeId: string; toolName: string }
interface StoredPresetRow extends UnknownRecord {
  id: string; name?: unknown; description?: unknown; defaultEnabled?: unknown;
  groupIds?: unknown; rules?: unknown; updatedAt?: unknown;
}
interface StoredRuleRow extends UnknownRecord { modeId: string; toolName: string; enabled?: unknown }

const isStoredGroupRow = (row: unknown): row is StoredGroupRow =>
  isRecord(row) && typeof row.id === 'string' && row.id.length > 0;
const isStoredMemberRow = (row: unknown): row is StoredMemberRow =>
  isRecord(row) && typeof row.modeId === 'string' && row.modeId.length > 0 &&
  typeof row.toolName === 'string' && row.toolName.length > 0;
const isStoredPresetRow = (row: unknown): row is StoredPresetRow =>
  isRecord(row) && typeof row.id === 'string' && row.id.length > 0;
const isStoredRuleRow = (row: unknown): row is StoredRuleRow =>
  isRecord(row) && typeof row.modeId === 'string' && typeof row.toolName === 'string';

/** Lenient normalisation for stored state; never throws so old data keeps loading. */
export function normalizeToolState(state: PresetState): PresetState {
  const rawGroups: unknown[] = Array.isArray(state.toolGroups) ? state.toolGroups : [];
  state.toolGroups = rawGroups.filter(isStoredGroupRow).map(group => ({
    id: group.id,
    name: typeof group.name === 'string' && group.name.length > 0 ? group.name : group.id,
    description: typeof group.description === 'string' ? group.description : '',
    order: Number.isFinite(Number(group.order)) ? Number(group.order) : 100,
    members: (Array.isArray(group.members) ? group.members : []).filter(isStoredMemberRow)
      .map(member => ({ modeId: member.modeId, toolName: member.toolName })),
  }));
  const rawPresets: unknown[] = Array.isArray(state.toolPresets) ? state.toolPresets : [];
  state.toolPresets = rawPresets.filter(isStoredPresetRow).map(preset => ({
    id: preset.id,
    name: typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : preset.id,
    description: typeof preset.description === 'string' ? preset.description : '',
    defaultEnabled: preset.defaultEnabled !== false,
    groupIds: (Array.isArray(preset.groupIds) ? preset.groupIds : []).filter(id => typeof id === 'string' && id.length > 0),
    rules: (Array.isArray(preset.rules) ? preset.rules : []).filter(isStoredRuleRow)
      .map(rule => ({ modeId: rule.modeId, toolName: rule.toolName, enabled: rule.enabled === true })),
    updatedAt: typeof preset.updatedAt === 'string' ? preset.updatedAt : '',
  }));
  const presetIds = new Set(state.toolPresets.map(preset => preset.id));
  if (!isRecord(state.modeToolSelections)) state.modeToolSelections = {};
  if (!isRecord(state.sessionToolSelections)) state.sessionToolSelections = {};
  // Pre-upgrade states store flat policies without any selection. Rebuild the
  // matching selection so an existing override keeps its exact behaviour.
  for (const [modeId] of entries<unknown>(state.modeToolPolicies)) {
    if (!isRecord(ownGet(state.modeToolSelections, modeId))) assign<ToolSelection>(state.modeToolSelections, modeId, { kind: 'custom' });
  }
  for (const [sessionId] of entries<unknown>(state.sessionToolPolicies)) {
    if (!isRecord(ownGet(state.sessionToolSelections, sessionId))) assign<ToolSelection>(state.sessionToolSelections, sessionId, { kind: 'custom' });
  }
  for (const [modeId, selection] of entries<unknown>(state.modeToolSelections)) {
    const valid = isRecord(selection) && (selection.kind === 'custom' ||
      (selection.kind === 'preset' && typeof selection.presetId === 'string' && presetIds.has(selection.presetId)));
    if (!valid) assign<ToolSelection>(state.modeToolSelections, modeId, { kind: 'custom' });
  }
  for (const [sessionId, selection] of entries<unknown>(state.sessionToolSelections)) {
    const valid = isRecord(selection) && (selection.kind === 'inherit' || selection.kind === 'custom' ||
      (selection.kind === 'preset' && typeof selection.presetId === 'string' && presetIds.has(selection.presetId)));
    if (!valid) assign<ToolSelection>(state.sessionToolSelections, sessionId, { kind: 'inherit' });
  }
  return state;
}

/** One preset as the resolver sees it: identity, mode-level default and rule index. */
export interface PresetSnapshot {
  id: string;
  defaultEnabled: boolean;
  rules: ToolPresetRule[];
}

/**
 * Immutable view of the stored tool policy, shared by the request filter, the
 * execution guard and the model-facing restriction plan.
 */
export interface ToolPolicySnapshot {
  presets: Record<string, PresetSnapshot>;
  presetRules: Record<string, Record<string, boolean>>;
  modes: Record<string, ToolPolicy>;
  sessions: Record<string, ToolPolicy>;
  modeSelections: Record<string, ToolSelection>;
  sessionSelections: Record<string, ToolSelection>;
}

/** Immutable snapshot shared by the request filter and the execution guard. */
export function toolPolicySnapshot(state?: PresetState): ToolPolicySnapshot {
  const presets: Record<string, PresetSnapshot> = {};
  const presetRules: Record<string, Record<string, boolean>> = {};
  for (const preset of Array.isArray(state?.toolPresets) ? state.toolPresets : []) {
    if (!isRecord(preset) || typeof preset.id !== 'string' || preset.id.length === 0) continue;
    assign<PresetSnapshot>(presets, preset.id, {
      id: preset.id,
      defaultEnabled: preset.defaultEnabled !== false,
      rules: (Array.isArray(preset.rules) ? preset.rules : []).map(rule => ({ ...rule })),
    });
    const index: Record<string, boolean> = {};
    for (const rule of Array.isArray(preset.rules) ? preset.rules : []) {
      if (!isRecord(rule) || typeof rule.modeId !== 'string' || typeof rule.toolName !== 'string') continue;
      assign<boolean>(index, toolRefKey(rule.modeId, rule.toolName), rule.enabled === true);
    }
    assign<Record<string, boolean>>(presetRules, preset.id, index);
  }
  const modes: Record<string, ToolPolicy> = {};
  for (const [modeId, policy] of entries<unknown>(state?.modeToolPolicies)) if (isRecord(policy)) assign<ToolPolicy>(modes, modeId, { ...policy } as ToolPolicy);
  const sessions: Record<string, ToolPolicy> = {};
  for (const [sessionId, policy] of entries<unknown>(state?.sessionToolPolicies)) if (isRecord(policy)) assign<ToolPolicy>(sessions, sessionId, { ...policy } as ToolPolicy);
  const modeSelections: Record<string, ToolSelection> = {};
  for (const [modeId, selection] of entries<unknown>(state?.modeToolSelections)) if (isRecord(selection)) assign<ToolSelection>(modeSelections, modeId, { ...selection } as ToolSelection);
  const sessionSelections: Record<string, ToolSelection> = {};
  for (const [sessionId, selection] of entries<unknown>(state?.sessionToolSelections)) if (isRecord(selection)) assign<ToolSelection>(sessionSelections, sessionId, { ...selection } as ToolSelection);
  return { presets, presetRules, modes, sessions, modeSelections, sessionSelections };
}

function flatEnabled(policy: ToolPolicy | undefined, toolName: string): boolean {
  return ownGet(policy ?? {}, toolName) !== false;
}
/** `undefined` when the referenced preset is missing, so the caller keeps the previous source. */
function presetEnabled(snapshot: ToolPolicySnapshot, presetId: string, modeId: string, toolName: string): boolean | undefined {
  const preset = ownGet(snapshot.presets, presetId);
  if (!preset) return undefined;
  const explicit = ownGet(ownGet(snapshot.presetRules, presetId) ?? {}, toolRefKey(modeId, toolName));
  return explicit === undefined ? preset.defaultEnabled !== false : explicit === true;
}
function modeDecision(snapshot: ToolPolicySnapshot, modeId: string, toolName: string): boolean {
  const selection = modeId ? ownGet(snapshot.modeSelections, modeId) : undefined;
  if (selection?.kind === 'preset' && selection.presetId) {
    const enabled = presetEnabled(snapshot, selection.presetId, modeId, toolName);
    if (enabled !== undefined) return enabled;
  }
  return flatEnabled(modeId ? ownGet(snapshot.modes, modeId) : undefined, toolName);
}

/**
 * The single resolver behind the request tool schema, the execution guard and
 * the model-facing restriction plan.
 * Every fallback keeps the previous, narrower answer: a dangling reference or a
 * not-yet-saved custom policy must never silently enable more tools.
 *
 * The program-call entry is never a policy subject (see {@link TOOL_ENTRY_NAME}):
 * a session that could not call anything directly would deadlock, so a stored
 * policy that disables it is ignored instead of honoured.
 */
export function effectiveToolEnabled(
  snapshot: ToolPolicySnapshot,
  sessionId: string | null | undefined,
  modeId: string | null | undefined,
  toolName: string,
): boolean {
  if (isToolEntry(toolName)) return true;
  const mode = modeId ?? '';
  const inherited = modeDecision(snapshot, mode, toolName);
  if (!sessionId) return inherited;
  const selection = ownGet(snapshot.sessionSelections, sessionId);
  if (!selection) {
    // A flat session policy without a selection is pre-selection state: keep it,
    // otherwise upgrading would silently drop an existing session override.
    const legacy = ownGet(snapshot.sessions, sessionId);
    return legacy === undefined ? inherited : flatEnabled(legacy, toolName);
  }
  if (selection.kind === 'inherit') return inherited;
  if (selection.kind === 'preset' && selection.presetId) {
    const enabled = presetEnabled(snapshot, selection.presetId, mode, toolName);
    if (enabled !== undefined) return enabled;
  }
  // `custom` before any session policy was saved, or a dangling preset reference,
  // has nothing of its own to apply: use the session flat policy when one exists
  // and otherwise inherit the mode result, never falling through to "all on".
  const policy = ownGet(snapshot.sessions, sessionId);
  return policy === undefined ? inherited : flatEnabled(policy, toolName);
}

/** Flat view of the same resolver, for a concrete catalog. */
export function effectiveToolPolicy(
  snapshot: ToolPolicySnapshot,
  sessionId: string | null | undefined,
  modeId: string | null | undefined,
  catalog: ToolNameList,
): ToolPolicy {
  const policy: ToolPolicy = {};
  for (const tool of Array.isArray(catalog) ? catalog : []) {
    if (!tool || typeof tool.name !== 'string') continue;
    assign<boolean>(policy, tool.name, effectiveToolEnabled(snapshot, sessionId, modeId, tool.name));
  }
  return policy;
}

/** A `tools.restrict()` filter body. The host intersects restrictions per scope. */
export interface ToolRestrictionPlan {
  allow?: string[];
  deny?: string[];
}

/** Inputs beyond the resolver that the caller can prove about the host. */
export interface ToolRestrictionOptions {
  /**
   * Global names the host reports as restrictable for this scope. `tools.restrict()`
   * throws on an unknown or scope-local name, so a caller that has the host's
   * restrictable set must pass it; without it the plan assumes the catalog rows
   * are the global names (the usual case for a mode's standing scope).
   */
  restrictable?: Iterable<string>;
}

/**
 * Plan the `tools.restrict()` filter that removes disabled tools from what the
 * model is offered.
 *
 * DSH builds the PTC SDK section from the restricted visibility
 * (`wireSchemas`/`sdkSchemas` in `packages/core/tools/src/index.ts`), so
 * restrictions are how a switched-off tool disappears from the model's tool
 * descriptions instead of only failing at execution time. This planner:
 * - never names the reserved entry (the host rejects a filter naming it, and
 *   removing it would deadlock a program-call session),
 * - never names a tool the host cannot restrict (an unknown name throws),
 * - returns `undefined` when nothing is hidden, because an empty filter throws.
 */
export function planToolRestriction(
  snapshot: ToolPolicySnapshot,
  sessionId: string | null | undefined,
  modeId: string | null | undefined,
  catalog: ToolNameList,
  options: ToolRestrictionOptions = {},
): ToolRestrictionPlan | undefined {
  const restrictable = options.restrictable === undefined ? undefined : new Set(options.restrictable);
  const deny = new Set<string>();
  for (const tool of Array.isArray(catalog) ? catalog : []) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    if (isToolEntry(tool.name)) continue;
    if (restrictable !== undefined && !restrictable.has(tool.name)) continue;
    if (effectiveToolEnabled(snapshot, sessionId, modeId, tool.name) === false) deny.add(tool.name);
  }
  if (deny.size === 0) return undefined;
  return { deny: [...deny] };
}

/**
 * Union of every tool catalog the workbench has seen, for the editor only.
 *
 * A restriction narrows what the MODEL may call; it must never narrow what the
 * user may edit, otherwise a tool switched off in one session could not be
 * switched back on. Later sources win for one tool name, and no source can
 * remove a row another source contributed.
 */
export function editableToolCatalog(sources: readonly (ToolCatalogMap | undefined)[]): ToolCatalogMap {
  const byMode = new Map<string, Map<string, ToolCatalogRow>>();
  for (const source of sources) {
    for (const [modeId, catalog] of entries<ToolCatalogRow[]>(source)) {
      if (!Array.isArray(catalog)) continue;
      const rows = byMode.get(modeId) ?? new Map<string, ToolCatalogRow>();
      for (const row of catalog) {
        if (row && typeof row.name === 'string' && row.name.length > 0) rows.set(row.name, row);
      }
      byMode.set(modeId, rows);
    }
  }
  const merged: ToolCatalogMap = {};
  for (const [modeId, rows] of byMode) assign<ToolCatalogRow[]>(merged, modeId, [...rows.values()]);
  return merged;
}

/** Expand one preset for one mode; rules for other modes never leak in. */
export function expandToolPresetPolicy(preset: ToolPreset | undefined, modeId: string, catalog: ToolNameList): ToolPolicy {
  const policy: ToolPolicy = {};
  const rules = new Map<string, boolean>();
  for (const rule of Array.isArray(preset?.rules) ? preset.rules : []) {
    if (rule?.modeId === modeId) rules.set(rule.toolName, rule.enabled === true);
  }
  for (const tool of Array.isArray(catalog) ? catalog : []) {
    if (!tool || typeof tool.name !== 'string') continue;
    const explicit = rules.get(tool.name);
    assign<boolean>(policy, tool.name, explicit === undefined ? preset?.defaultEnabled !== false : explicit);
  }
  return policy;
}

/** Reference counts of every tool preset, by mode and by session. */
export type PresetReferenceCounts = Record<string, { modes: number; sessions: number }>;

/** Everything {@link presetReferenceCounts} reads. */
export interface ToolPresetReferenceSource {
  toolPresets?: unknown;
  modeToolSelections?: unknown;
  sessionToolSelections?: unknown;
}

export function presetReferenceCounts(state?: ToolPresetReferenceSource): PresetReferenceCounts {
  const counts: PresetReferenceCounts = {};
  const ensure = (id: string): { modes: number; sessions: number } => {
    if (!ownGet(counts, id)) assign<{ modes: number; sessions: number }>(counts, id, { modes: 0, sessions: 0 });
    return ownGet(counts, id) as { modes: number; sessions: number };
  };
  for (const preset of Array.isArray(state?.toolPresets) ? state.toolPresets : []) {
    if (isRecord(preset) && typeof preset.id === 'string' && preset.id.length > 0) ensure(preset.id);
  }
  for (const selection of Object.values(isRecord(state?.modeToolSelections) ? state?.modeToolSelections as UnknownRecord : {})) {
    if (isRecord(selection) && selection.kind === 'preset' && typeof selection.presetId === 'string') ensure(selection.presetId).modes++;
  }
  for (const selection of Object.values(isRecord(state?.sessionToolSelections) ? state?.sessionToolSelections as UnknownRecord : {})) {
    if (isRecord(selection) && selection.kind === 'preset' && typeof selection.presetId === 'string') ensure(selection.presetId).sessions++;
  }
  return counts;
}

/** One reference kept in a group or preset that the current catalogs do not provide. */
export interface UnresolvedToolRef {
  modeId: string;
  toolName: string;
  kind: string;
  ownerId: unknown;
  ownerName: unknown;
}

/** Everything {@link unresolvedToolRefs} reads; a partial state is enough. */
export interface ToolReferenceSource {
  toolGroups?: unknown;
  toolPresets?: unknown;
}

/** References kept in groups or presets that the current catalogs do not provide. */
export function unresolvedToolRefs(state: ToolReferenceSource | undefined, catalogs: ToolCatalogMap | undefined): UnresolvedToolRef[] {
  const refs: UnresolvedToolRef[] = [];
  const known = catalogRefs(catalogs);
  const consider = (ref: unknown, kind: string, owner: UnknownRecord): void => {
    if (!isRecord(ref) || typeof ref.modeId !== 'string' || typeof ref.toolName !== 'string') return;
    if (known.has(toolRefKey(ref.modeId, ref.toolName))) return;
    refs.push({ modeId: ref.modeId, toolName: ref.toolName, kind, ownerId: owner.id, ownerName: owner.name });
  };
  for (const group of Array.isArray(state?.toolGroups) ? state.toolGroups : []) {
    const owner = isRecord(group) ? group : {};
    for (const member of Array.isArray(owner.members) ? owner.members : []) consider(member, 'group', owner);
  }
  for (const preset of Array.isArray(state?.toolPresets) ? state.toolPresets : []) {
    const owner = isRecord(preset) ? preset : {};
    for (const rule of Array.isArray(owner.rules) ? owner.rules : []) consider(rule, 'preset', owner);
  }
  return refs;
}

/** Tool names of one user group that the given mode catalog actually provides. */
export function groupMembersForMode(group: ToolGroup | undefined, modeId: string, catalog: ToolNameList): string[] {
  const available = new Set((Array.isArray(catalog) ? catalog : [])
    .filter(tool => tool && typeof tool.name === 'string').map(tool => tool.name));
  return (Array.isArray(group?.members) ? group.members : [])
    .filter(member => member?.modeId === modeId && available.has(member.toolName))
    .map(member => member.toolName);
}

/** The two selection maps {@link resetPresetSelections} rewrites in place. */
export interface ToolSelectionStore {
  modeToolSelections: Record<string, ToolSelection>;
  sessionToolSelections: Record<string, ToolSelection>;
}

/** Turn every selection that points at `presetId` back into the safe fallback. */
export function resetPresetSelections(state: ToolSelectionStore, presetId: string): { modes: number; sessions: number } {
  let modes = 0;
  let sessions = 0;
  for (const [modeId, selection] of entries<ToolSelection>(state?.modeToolSelections)) {
    if (selection?.kind === 'preset' && selection.presetId === presetId) {
      assign<ToolSelection>(state.modeToolSelections, modeId, { kind: 'custom' });
      modes++;
    }
  }
  for (const [sessionId, selection] of entries<ToolSelection>(state?.sessionToolSelections)) {
    if (selection?.kind === 'preset' && selection.presetId === presetId) {
      assign<ToolSelection>(state.sessionToolSelections, sessionId, { kind: 'inherit' });
      sessions++;
    }
  }
  return { modes, sessions };
}

const EMPTY_TOOLS_SECTION = (): ToolsSection => ({ version: 1, applicable: true, activePresetId: null, presets: [], groups: [] });

/**
 * Validate the `tools` sub-format of a share package.
 * A same-version section is fully checked; an unknown sub-version is reported
 * as `applicable:false` so the caller keeps (and re-exports) it untouched.
 */
export function validateToolsSection(tools?: unknown): ToolsSection {
  if (tools === undefined || tools === null) return EMPTY_TOOLS_SECTION();
  if (!isRecord(tools)) throw new Error('预设包 tools 必须为对象');
  const version = tools.version === undefined ? 1 : tools.version;
  if (!Number.isInteger(version) || (version as number) < 1) throw new Error('预设包 tools.version 必须是正整数');
  if (version !== 1) return { version: version as number, applicable: false, activePresetId: null, presets: [], groups: [] };
  const groups = normalizeToolGroups(tools.groups, { allowUnknownRefs: true });
  const rawPresets = tools.presets === undefined || tools.presets === null ? [] : tools.presets;
  if (!Array.isArray(rawPresets)) throw new Error('预设包 tools.presets 必须为数组');
  if (rawPresets.length > TOOL_PRESET_LIMIT) throw new Error(`预设包 tools.presets 最多 ${TOOL_PRESET_LIMIT} 个`);
  const groupIds = new Set(groups.map(group => group.id));
  const presetIds = new Set<string>();
  const presets: ToolPreset[] = [];
  for (const raw of rawPresets) {
    if (!isRecord(raw)) throw new Error('预设包工具预设必须是对象');
    const id = requireId(raw.id, '预设包工具预设 ID');
    if (presetIds.has(id)) throw new Error(`预设包工具预设 ID 重复：${id}`);
    presetIds.add(id);
    const preset: ToolPreset = { ...normalizeToolPreset({ ...raw, id }), id };
    for (const groupId of preset.groupIds) {
      if (!groupIds.has(groupId)) throw new Error(`预设包工具预设引用了不存在的分组：${groupId}`);
    }
    presets.push(preset);
  }
  const activeRaw = tools.activePresetId === undefined ? null : tools.activePresetId;
  const activePresetId = activeRaw === null || activeRaw === '' ? null : requireId(activeRaw, '预设包 activePresetId');
  if (activePresetId !== null && !presetIds.has(activePresetId)) {
    throw new Error('预设包 activePresetId 未指向任何工具预设');
  }
  return { version: 1, applicable: true, activePresetId, presets, groups };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
function sameGroup(left: ToolGroup, right: ToolGroup): boolean {
  return sameJson(
    { name: left.name, description: left.description ?? '', order: left.order ?? 100, members: left.members ?? [] },
    { name: right.name, description: right.description ?? '', order: right.order ?? 100, members: right.members ?? [] },
  );
}
function samePreset(left: ToolPreset, right: ToolPreset): boolean {
  return sameJson(
    { name: left.name, description: left.description ?? '', defaultEnabled: left.defaultEnabled !== false, groupIds: left.groupIds ?? [], rules: left.rules ?? [] },
    { name: right.name, description: right.description ?? '', defaultEnabled: right.defaultEnabled !== false, groupIds: right.groupIds ?? [], rules: right.rules ?? [] },
  );
}

/** Per-kind reuse/remap counters of {@link remapToolPackage}. */
export interface RemapToolPackageStats {
  groups: { added: number; reused: number; remapped: number };
  presets: { added: number; reused: number; remapped: number };
  matched: number;
  unmatched: number;
}

/** Result of {@link remapToolPackage}: the section to append plus warnings. */
export interface RemapToolPackageResult {
  tools: ToolsSection;
  stats: RemapToolPackageStats;
  warnings: string[];
}

/** Options of {@link remapToolPackage}. */
export interface RemapToolPackageOptions {
  catalogs?: ToolCatalogMap;
}

/** The stored rows {@link remapToolPackage} compares against. */
export interface ToolStoreView {
  toolGroups?: ToolGroup[];
  toolPresets?: ToolPreset[];
}

/**
 * Plan an explicit package import: reuse identical rows, give conflicting rows a
 * fresh UUID and rewrite every in-package reference. Nothing is written here.
 */
export function remapToolPackage(tools: unknown, state: ToolStoreView | undefined, options: RemapToolPackageOptions = {}): RemapToolPackageResult {
  const section = validateToolsSection(tools);
  if (!section.applicable) throw new Error(`分享文件的工具子版本 ${section.version} 暂不支持应用`);
  const existingGroups = Array.isArray(state?.toolGroups) ? state.toolGroups : [];
  const existingPresets = Array.isArray(state?.toolPresets) ? state.toolPresets : [];
  const known = catalogRefs(options.catalogs);
  const stats: RemapToolPackageStats = {
    groups: { added: 0, reused: 0, remapped: 0 },
    presets: { added: 0, reused: 0, remapped: 0 },
    matched: 0,
    unmatched: 0,
  };
  const packageRefs: ToolRef[] = [
    ...section.presets.flatMap(preset => preset.rules),
    ...section.groups.flatMap(group => group.members),
  ];
  for (const ref of packageRefs) {
    if (known.has(toolRefKey(ref.modeId, ref.toolName))) stats.matched++;
    else stats.unmatched++;
  }

  const groupIdMap = new Map<string, string>();
  const groups: ToolGroup[] = [];
  const usedGroupIds = new Set(existingGroups.map(group => group.id));
  for (const group of section.groups) {
    const current = existingGroups.find(item => item.id === group.id);
    if (current && sameGroup(current, group)) {
      stats.groups.reused++;
      groupIdMap.set(group.id, current.id);
      continue;
    }
    let id = group.id;
    if (current || usedGroupIds.has(id)) {
      id = globalThis.crypto.randomUUID();
      stats.groups.remapped++;
    } else {
      stats.groups.added++;
    }
    usedGroupIds.add(id);
    groupIdMap.set(group.id, id);
    groups.push({ ...group, id, members: group.members.map(member => ({ ...member })) });
  }

  const usedPresetIds = new Set(existingPresets.map(preset => preset.id));
  const presetIdMap = new Map<string, string>();
  const presets: ToolPreset[] = [];
  for (const preset of section.presets) {
    const rewritten: ToolPreset = {
      ...preset,
      groupIds: preset.groupIds.map(id => groupIdMap.get(id) ?? id),
      rules: preset.rules.map(rule => ({ ...rule })),
    };
    const current = existingPresets.find(item => item.id === preset.id);
    if (current && samePreset(current, rewritten)) {
      stats.presets.reused++;
      presetIdMap.set(preset.id, current.id);
      continue;
    }
    let id = preset.id;
    if (current || usedPresetIds.has(id)) {
      id = globalThis.crypto.randomUUID();
      stats.presets.remapped++;
    } else {
      stats.presets.added++;
    }
    usedPresetIds.add(id);
    presetIdMap.set(preset.id, id);
    presets.push({ ...rewritten, id, updatedAt: new Date().toISOString() });
  }

  const addedGroups = groups.length;
  const addedPresets = presets.length;
  if (existingGroups.length + addedGroups > TOOL_GROUP_LIMIT) throw new Error(`导入后工具分组将超过 ${TOOL_GROUP_LIMIT} 个`);
  if (existingPresets.length + addedPresets > TOOL_PRESET_LIMIT) throw new Error(`导入后工具预设将超过 ${TOOL_PRESET_LIMIT} 个`);

  const warnings: string[] = [];
  if (stats.unmatched > 0) warnings.push(`${stats.unmatched} 条工具引用在当前模式目录中不存在，已保留待插件恢复后重新匹配`);
  if (stats.groups.remapped > 0 || stats.presets.remapped > 0) warnings.push('存在 ID 冲突，已为新内容生成新 ID 并重写包内引用');

  const activePresetId = section.activePresetId === null ? null : (presetIdMap.get(section.activePresetId) ?? null);

  return {
    tools: { version: 1, activePresetId, presets, groups },
    stats,
    warnings,
  };
}

/** The stored rows {@link exportToolsSection} reads. */
export interface ToolPresetSource {
  toolPresets?: ToolPreset[];
  toolGroups?: ToolGroup[];
}

/** Build the exported `tools` section: only the associated preset and its groups. */
export function exportToolsSection(state: ToolPresetSource | undefined, toolPresetId?: string | null): ToolsSection {
  const empty: ToolsSection = { version: 1, activePresetId: null, presets: [], groups: [] };
  if (!toolPresetId) return empty;
  const preset = (Array.isArray(state?.toolPresets) ? state.toolPresets : []).find(item => item.id === toolPresetId);
  if (!preset) return empty;
  const groups = (Array.isArray(state?.toolGroups) ? state.toolGroups : []).filter(group => preset.groupIds?.includes(group.id));
  const ids = new Set(groups.map(group => group.id));
  return {
    version: 1,
    activePresetId: preset.id,
    presets: [{
      id: preset.id,
      name: preset.name,
      description: preset.description ?? '',
      defaultEnabled: preset.defaultEnabled !== false,
      groupIds: (preset.groupIds ?? []).filter(id => ids.has(id)),
      rules: (preset.rules ?? []).map(rule => ({ modeId: rule.modeId, toolName: rule.toolName, enabled: rule.enabled === true })),
      updatedAt: preset.updatedAt ?? '',
    }],
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      description: group.description ?? '',
      order: group.order ?? 100,
      members: (group.members ?? []).map(member => ({ modeId: member.modeId, toolName: member.toolName })),
    })),
  };
}