/**
 * SPreset editor support.
 *
 * Two things live here:
 *  - the editor's own library of reusable prompt entries. It is stored in the plugin
 *    state file next to the presets but never inside a preset document, so browsing and
 *    editing templates cannot change what a preset contains or exports;
 *  - read-only summaries of the `extensions.SPreset` block found in imported presets.
 *    The regex rows deliberately call src/lib/prompt-regex.mts (planRegexScript) instead of
 *    re-implementing Tavern's placement/channel/depth rules.
 */
import { randomUUID } from 'node:crypto';
import { planRegexScript, regexName } from './prompt-regex.mjs';
import type { RegexScript, SillyTavernPreset, SPresetLibrary, SPresetLibraryEntry } from './types.mjs';

/** Upper bounds so an imported or hand-edited state file cannot grow without limit. */
export const LIBRARY_ENTRY_LIMIT = 500;
const TITLE_LIMIT = 200;
const CONTENT_LIMIT = 200_000;
const ROLES = ['system', 'user', 'assistant'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.slice(0, limit) : '';

const stamp = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

/**
 * The four starting templates. They are ordinary prompt text, owned by the library rather
 * than by any preset, and stay editable - only the plugin's own seed copy is fixed.
 */
const DEFAULT_TEMPLATES: ReadonlyArray<{ id: string; title: string; role: string; content: string }> = [
  {
    id: 'spreset-template-persona', title: '系统人设骨架', role: 'system',
    content: '你正在扮演{{char}}。\n\n【身份】\n\n【说话方式】\n\n【行为目标】\n',
  },
  {
    id: 'spreset-template-style', title: '写作风格约束', role: 'system',
    content: '写作要求：\n- 叙述视角：\n- 时态：\n- 节奏：\n- 不要出现：\n',
  },
  {
    id: 'spreset-template-input', title: '用户输入整形', role: 'user',
    content: '<最新互动>\n{{lastusermessage}}\n</最新互动>\n',
  },
  {
    id: 'spreset-template-output', title: '回复格式约束', role: 'system',
    content: '输出格式：\n- 正文只写剧情推进\n- 状态变化写在 <状态> 块内\n- 不要复述用户输入\n',
  },
];

/**
 * Fixed creation time for the seeded templates.
 *
 * Seeding must be deterministic: a state file written before the library existed is normalized
 * on every read until something is written back, and a wall-clock timestamp there would make
 * normalization depend on how fast the two reads follow each other (and rewrite the file).
 */
const TEMPLATE_EPOCH = 1_700_000_000_000;

/** Fresh library for a state file that has never had one. */
export function createDefaultSPresetLibrary(now: number = TEMPLATE_EPOCH): SPresetLibrary {
  return {
    entries: DEFAULT_TEMPLATES.map(template => ({
      id: template.id, title: template.title, role: template.role, content: template.content,
      kind: 'template' as const, builtin: true,
      // Present from the start so normalization is idempotent: the seed and a re-read agree.
      injectionPosition: 0 as const,
      createdAt: now, updatedAt: now,
    })),
  };
}

const wholeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;

const triggerList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 16);
  return list.length ? list : undefined;
};

/** Only the fields the preset compiler reads are carried over from a stored entry. */
function insertionShape(raw: Record<string, unknown>): Partial<SPresetLibraryEntry> {
  const shape: Partial<SPresetLibraryEntry> = { injectionPosition: raw.injectionPosition === 1 ? 1 : 0 };
  const depth = wholeNumber(raw.injectionDepth);
  const order = wholeNumber(raw.injectionOrder);
  const trigger = triggerList(raw.injectionTrigger);
  if (depth !== undefined) shape.injectionDepth = depth;
  if (order !== undefined) shape.injectionOrder = order;
  if (trigger) shape.injectionTrigger = trigger;
  if (raw.hideFromList !== undefined) shape.hideFromList = raw.hideFromList === true;
  if (raw.forbidOverrides !== undefined) shape.forbidOverrides = raw.forbidOverrides === true;
  return shape;
}

function normalizeEntry(raw: unknown, index: number, now: number): SPresetLibraryEntry | null {
  if (!isRecord(raw)) return null;
  const title = text(raw.title, TITLE_LIMIT).trim();
  if (!title) return null;
  const id = text(raw.id, 200).trim() || 'spreset-entry-' + (index + 1);
  const role = ROLES.includes(String(raw.role)) ? String(raw.role) : 'system';
  const createdAt = stamp(raw.createdAt, now);
  return {
    // Unknown fields of a stored entry survive: only the modelled ones are normalized.
    ...raw,
    id, title, role,
    content: text(raw.content, CONTENT_LIMIT),
    kind: raw.kind === 'snippet' ? 'snippet' : 'template',
    builtin: raw.builtin === true,
    ...insertionShape(raw),
    createdAt,
    updatedAt: stamp(raw.updatedAt, createdAt),
  } as SPresetLibraryEntry;
}

function dedupe(entries: SPresetLibraryEntry[]): SPresetLibraryEntry[] {
  const seen = new Set<string>();
  const out: SPresetLibraryEntry[] = [];
  for (const entry of entries) {
    let id = entry.id;
    let attempt = 2;
    while (seen.has(id)) id = entry.id + '-' + attempt++;
    seen.add(id);
    out.push(id === entry.id ? entry : { ...entry, id });
    if (out.length >= LIBRARY_ENTRY_LIMIT) break;
  }
  return out;
}

/**
 * Normalize whatever the state file holds.
 *
 * A missing field (a state file written before the library existed) is seeded; a field the
 * user emptied on purpose stays empty. Untrusted JSON is structural-only, like the rest of
 * the store.
 */
export function normalizeSPresetLibrary(raw: unknown, now: number = TEMPLATE_EPOCH): SPresetLibrary {
  if (raw === undefined || raw === null) return createDefaultSPresetLibrary(now);
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const entries: SPresetLibraryEntry[] = [];
  list.forEach((candidate, index) => {
    const entry = normalizeEntry(candidate, index, now);
    if (entry) entries.push(entry);
  });
  return { entries: dedupe(entries) };
}

export interface LibrarySaveResult {
  library: SPresetLibrary;
  entry: SPresetLibraryEntry;
  created: boolean;
}

/** Upsert one library entry. Titles are required; ids are minted when absent or unknown. */
export function saveLibraryEntry(
  library: SPresetLibrary,
  input: unknown,
  options: { now?: number; mintId?: () => string } = {},
): LibrarySaveResult {
  if (!isRecord(input)) throw new Error('资源库条目必须是对象');
  const now = options.now ?? Date.now();
  const title = text(input.title, TITLE_LIMIT).trim();
  if (!title) throw new Error('资源库条目需要标题');
  const requestedId = text(input.id, 200).trim();
  const index = requestedId ? library.entries.findIndex(entry => entry.id === requestedId) : -1;
  const previous = index >= 0 ? library.entries[index] : undefined;
  const entry: SPresetLibraryEntry = {
    // A partial save must not drop fields this editor does not model.
    ...(previous ?? {}),
    id: previous ? previous.id : requestedId || (options.mintId ?? randomUUID)(),
    title,
    role: ROLES.includes(String(input.role)) ? String(input.role) : previous?.role ?? 'system',
    content: text(input.content, CONTENT_LIMIT),
    kind: input.kind === 'snippet' || input.kind === 'template' ? input.kind : previous?.kind ?? 'snippet',
    // Editing a seeded template keeps its builtin mark so "restore templates" can still find it.
    builtin: previous ? previous.builtin : input.builtin === true,
    // Absent insertion fields fall back to the stored entry, so a partial save cannot drop them.
    injectionPosition: input.injectionPosition === 0 || input.injectionPosition === 1
      ? input.injectionPosition
      : previous?.injectionPosition ?? 0,
    injectionDepth: wholeNumber(input.injectionDepth) ?? previous?.injectionDepth,
    injectionOrder: wholeNumber(input.injectionOrder) ?? previous?.injectionOrder,
    injectionTrigger: triggerList(input.injectionTrigger) ?? previous?.injectionTrigger,
    hideFromList: input.hideFromList === undefined ? previous?.hideFromList : input.hideFromList === true,
    forbidOverrides: input.forbidOverrides === undefined ? previous?.forbidOverrides : input.forbidOverrides === true,
    createdAt: previous ? previous.createdAt : stamp(input.createdAt, now),
    updatedAt: now,
  };
  const entries = index >= 0
    ? library.entries.map((item, at) => (at === index ? entry : item))
    : [...library.entries, entry].slice(-LIBRARY_ENTRY_LIMIT);
  return { library: { entries: dedupe(entries) }, entry, created: index < 0 };
}

export function deleteLibraryEntry(library: SPresetLibrary, id: unknown): { library: SPresetLibrary; removed: boolean } {
  const target = text(id, 200).trim();
  const entries = library.entries.filter(entry => entry.id !== target);
  return { library: { entries }, removed: entries.length !== library.entries.length };
}

/** Put the seeded templates back without touching the user's own snippets. */
export function restoreDefaultTemplates(library: SPresetLibrary, now: number = TEMPLATE_EPOCH): SPresetLibrary {
  const defaults = createDefaultSPresetLibrary(now).entries;
  const kept = library.entries.filter(entry => !(entry.builtin && defaults.some(item => item.id === entry.id)));
  return { entries: dedupe([...defaults, ...kept]).slice(0, LIBRARY_ENTRY_LIMIT) };
}

/* ------------------------------------- extensions.SPreset data (spec §2 / §3) */

/**
 * Defaults every SPreset-aware editor merges over the stored block, field by field.
 * The shape comes from docs/SPRESET_EDITOR_BEHAVIOUR_SPEC.md; unknown fields are kept.
 */
export const SPRESET_DEFAULTS = Object.freeze({
  RegexBinding: { regexes: [] as unknown[] },
  ChatSquash: {
    enabled: false, conditional_enabled: false, conditional_tag: '', separate_chat_history: false,
    parse_clewd: false, user_role_system: false, role: 'system', enable_stop_string: false,
    stop_string: '', user_prefix: '', user_suffix: '', char_prefix: '', char_suffix: '',
    prefix_system: '', suffix_system: '', enable_squashed_separator: false,
    squashed_separator_regex: '', squashed_separator_string: '', squashed_post_script_enable: false,
    squashed_post_script: '', re_split: false,
  },
  MacroNest: false,
  ToolBindings: {} as Record<string, unknown>,
  MessageInjections: {} as Record<string, unknown>,
  OutputPreprocessing: { enabled: false, script: '', consumeToolCalls: false, toolCallFormatter: '' },
  FixedPresetName: '',
  ForcedPostProcessing: {} as Record<string, unknown>,
});

/** Merge stored values over the defaults, keeping the source's own fields. */
function mergeDefaults(defaults: Record<string, unknown>, source: unknown): Record<string, unknown> {
  const raw = isRecord(source) ? source : {};
  // Start from the source so a sub-field this build does not model survives the merge.
  const out: Record<string, unknown> = { ...raw };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key];
    if (typeof fallback === 'boolean') out[key] = typeof value === 'boolean' ? value : fallback;
    else if (typeof fallback === 'string') out[key] = typeof value === 'string' ? value : fallback;
    else out[key] = value === undefined ? fallback : value;
  }
  return out;
}

/**
 * Normalize one preset's SPreset block: defaults merged in, wrong types repaired, and every
 * field this editor does not model carried through untouched.
 */
export function normalizeSPresetData(source: unknown): Record<string, unknown> {
  const raw = isRecord(source) ? source : {};
  const regexBinding = isRecord(raw.RegexBinding) ? raw.RegexBinding : {};
  return {
    ...raw,
    RegexBinding: {
      ...regexBinding,
      regexes: Array.isArray(regexBinding.regexes) ? regexBinding.regexes : [],
    },
    ChatSquash: mergeDefaults(SPRESET_DEFAULTS.ChatSquash, raw.ChatSquash),
    MacroNest: typeof raw.MacroNest === 'boolean' ? raw.MacroNest : SPRESET_DEFAULTS.MacroNest,
    ToolBindings: isRecord(raw.ToolBindings) ? raw.ToolBindings : {},
    MessageInjections: isRecord(raw.MessageInjections) ? raw.MessageInjections : {},
    OutputPreprocessing: mergeDefaults(SPRESET_DEFAULTS.OutputPreprocessing, raw.OutputPreprocessing),
    FixedPresetName: typeof raw.FixedPresetName === 'string' ? raw.FixedPresetName.trim() : '',
    ForcedPostProcessing: mergeDefaults(SPRESET_DEFAULTS.ForcedPostProcessing, raw.ForcedPostProcessing),
  };
}

export const SPRESET_MIRROR_ID = 'SPresetSettings';
export const SPRESET_MIRROR_NAME = 'SPreset配置';

/**
 * Keep the reference's "已与酒馆同步" mirror: one prompt whose body is the settings JSON.
 *
 * extensions.SPreset stays the single source of truth; the prompt is a projection of it and is
 * only written when the preset already carries an SPreset block, so a plain preset is never
 * given one by accident. The prompt deliberately gets no prompt_order entry, so it is never
 * injected into the request - it exists for the Tavern-side list only.
 */
export function syncSPresetMirror(preset: SillyTavernPreset): { preset: SillyTavernPreset; changed: boolean } {
  const extensions = isRecord(preset.extensions) ? preset.extensions as Record<string, unknown> : {};
  if (!isRecord(extensions.SPreset)) return { preset, changed: false };
  const data = normalizeSPresetData(extensions.SPreset);
  const content = JSON.stringify(data, null, 2);
  const prompts = Array.isArray(preset.prompts) ? [...preset.prompts] : [];
  const index = prompts.findIndex(prompt => isRecord(prompt) && prompt.identifier === SPRESET_MIRROR_ID);
  if (index >= 0) {
    const current = prompts[index];
    if (current.content === content && current.name === SPRESET_MIRROR_NAME) {
      return { preset: { ...preset, extensions: { ...extensions, SPreset: data } }, changed: false };
    }
    prompts[index] = { ...current, name: SPRESET_MIRROR_NAME, content };
  } else {
    prompts.push({ identifier: SPRESET_MIRROR_ID, name: SPRESET_MIRROR_NAME, role: 'system', content });
  }
  return { preset: { ...preset, prompts, extensions: { ...extensions, SPreset: data } }, changed: true };
}

/* --------------------------------------------------- extensions.SPreset view */

export interface SPresetRegexRow {
  id: string;
  name: string;
  disabled: boolean;
  placement: unknown;
  minDepth: number | null;
  maxDepth: number | null;
  targets: string[];
  unsupportedPlacements: number[];
  runs: boolean;
  supported: boolean;
  reason: string;
}

export interface SPresetSummary {
  /** False when the preset carries no extensions.SPreset block at all. */
  present: boolean;
  fixedPresetName: string;
  macroNest: boolean;
  chatSquash: Record<string, unknown> | null;
  outputPreprocessing: Record<string, unknown> | null;
  toolBindings: unknown;
  messageInjections: unknown;
  tavernHelperScripts: number;
  /** Depth used for the placement/depth plan below, echoed so the view can show it. */
  regexDepth: number;
  regexes: SPresetRegexRow[];
  /** The block with every default merged in, so the editor can show the whole field set. */
  settings: Record<string, unknown>;
  defaults: typeof SPRESET_DEFAULTS;
}

/**
 * Read-only view of one preset's SPreset block. Every regex verdict comes from
 * planRegexScript, so the editor explains "why it will not run" with the engine's own reason.
 */
export function summarizeSPreset(preset: SillyTavernPreset | null | undefined, depth = 0): SPresetSummary {
  const extensions = isRecord(preset?.extensions) ? preset?.extensions as Record<string, unknown> : {};
  const block = isRecord(extensions.SPreset) ? extensions.SPreset as Record<string, unknown> : null;
  const binding = block && isRecord(block.RegexBinding) ? block.RegexBinding as Record<string, unknown> : null;
  const list = binding && Array.isArray(binding.regexes) ? binding.regexes : [];
  const regexes: SPresetRegexRow[] = list.filter(isRecord).map((script, index) => {
    const plan = planRegexScript(script as unknown as RegexScript, depth);
    return {
      id: typeof script.id === 'string' && script.id ? script.id : 'regex-' + (index + 1),
      name: regexName(script as unknown as RegexScript),
      disabled: script.disabled === true,
      placement: script.placement ?? null,
      minDepth: typeof script.minDepth === 'number' ? script.minDepth : null,
      maxDepth: typeof script.maxDepth === 'number' ? script.maxDepth : null,
      targets: plan.targets,
      unsupportedPlacements: plan.unsupportedPlacements,
      runs: plan.runs,
      supported: plan.supported,
      reason: plan.reason,
    };
  });
  const helper = isRecord(extensions.tavern_helper) ? extensions.tavern_helper as Record<string, unknown> : null;
  return {
    present: block !== null,
    fixedPresetName: block && typeof block.FixedPresetName === 'string' ? block.FixedPresetName : '',
    macroNest: block?.MacroNest === true,
    chatSquash: block && isRecord(block.ChatSquash) ? block.ChatSquash as Record<string, unknown> : null,
    outputPreprocessing: block && isRecord(block.OutputPreprocessing) ? block.OutputPreprocessing as Record<string, unknown> : null,
    toolBindings: block?.ToolBindings ?? null,
    messageInjections: block?.MessageInjections ?? null,
    tavernHelperScripts: helper && Array.isArray(helper.scripts) ? helper.scripts.length : 0,
    regexDepth: depth,
    regexes,
    settings: normalizeSPresetData(block),
    defaults: SPRESET_DEFAULTS,
  };
}
