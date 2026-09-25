/**
 * Domain model shared by the storage, preset compiler, tool policy and the
 * plugin entry. Field names mirror what is persisted in state.json and in
 * exported preset packages; every persisted shape keeps an index signature so
 * unknown fields written by a newer plugin version survive a round trip.
 */
import type { ContentBlock, HostMessage, MessageSource } from '../host-types.mjs';

export type { ContentBlock, HostMessage, MessageSource };

/* ------------------------------------------------------------------ macros */

export interface MacroContext {
  /** Preset-local variables (never global state). */
  local: Record<string, string>;
  /** Variables shared across the session and persisted with the state file. */
  global: Record<string, string>;
  values: Record<string, string>;
  warnings: string[];
  random: () => number;
  /** Present when the stream is seeded; a worker replays its draws to continue it. */
  seed?: string;
  /** Macro random draws consumed so far. */
  draws: number;
  remaining: number;
  /** Applied to every macro-resolved value at the outermost level only (regex ESCAPED mode). */
  valueTransform?: (value: string) => string;
}

export interface MacroContextOptions {
  local?: Record<string, string>;
  global?: Record<string, string>;
  values?: Record<string, unknown>;
  random?: () => number;
  /** Seeded stream; omit only when the caller supplies its own random function. */
  seed?: string | number;
  valueTransform?: (value: string) => string;
}

/** One matchable text run, with the channel and floor it belongs to. */
export interface RegexSegment {
  text: string;
  target: PromptRegexTarget;
  depth: number;
}

/** Bounds enforced around one worker task. */
export interface RegexLimits {
  timeoutMs: number;
  maxRules: number;
  maxSegmentChars: number;
  maxTotalChars: number;
  maxOutputChars: number;
  maxReplacements: number;
}

/** One preparation handed to the worker: every segment of a single compilation. */
export interface RegexPreparation {
  segments: RegexSegment[];
  scripts: readonly RegexScript[];
  seed?: string;
  draws: number;
  local: Record<string, string>;
  global: Record<string, string>;
  values: Record<string, string>;
}

export interface RegexPreparationResult {
  texts: string[];
  applied: string[];
  local: Record<string, string>;
  global: Record<string, string>;
  draws: number;
  warnings: string[];
  replacements: number;
}

export interface RegexWorkerTask extends RegexPreparation {
  limits: RegexLimits;
  /** Two int32 slots: 0 signals completion, 1 carries the running rule index. */
  control: SharedArrayBuffer;
}

export interface RegexWorkerReply {
  ok: boolean;
  error?: string;
  rule?: string;
  texts?: string[];
  applied?: string[];
  local?: Record<string, string>;
  global?: Record<string, string>;
  draws?: number;
  warnings?: string[];
  replacements?: number;
}

export interface RegexRunnerOptions {
  timeoutMs?: number;
  maxRules?: number;
  maxSegmentChars?: number;
  maxTotalChars?: number;
  maxOutputChars?: number;
  maxReplacements?: number;
}

/** Synchronous, terminable regex execution. */
export interface RegexRunner {
  run(preparation: RegexPreparation): RegexPreparationResult;
  dispose(): void;
}

/* ---------------------------------------------------------- prompt regex */

/** One Tavern regex script as stored in a preset; unknown fields survive a round trip. */
export interface RegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  /** Tavern placement set: 1 = user_input, 2 = ai_output; other values are kept but not run. */
  placement?: number | number[];
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  /** 0/NONE keeps the pattern as written, 1/RAW expands macros, 2/ESCAPED escapes expanded values. */
  substituteRegex?: number | string;
  minDepth?: number;
  maxDepth?: number;
  disabled?: boolean;
  [key: string]: unknown;
}

/** This plugin's own execution switches, stored beside the rules. */
export interface PromptRegexOptions {
  enabled: boolean;
  includePrefill: boolean;
}

/** Chat text a rule can target in this version. */
export type PromptRegexTarget = 'user' | 'assistant';

/** Why one rule runs or does not, for the workbench to display. */
export interface RegexScriptPlan {
  runs: boolean;
  supported: boolean;
  targets: PromptRegexTarget[];
  unsupportedPlacements: number[];
  reason: string;
}

/* ------------------------------------------------------------------ preset */

export type PresetRole = 'system' | 'user' | 'assistant' | 'model';

export interface PresetPrompt {
  identifier: string;
  name?: string;
  content?: string;
  role?: PresetRole;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  injection_trigger?: string[];
  enabled?: boolean;
  marker?: boolean;
  [key: string]: unknown;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface PromptOrderGroup {
  character_id?: string | number;
  order: PromptOrderEntry[];
}

export interface SillyTavernPreset {
  prompts: PresetPrompt[];
  prompt_order?: PromptOrderGroup[];
  assistant_prefill?: string;
  dsh_system_prompt_enabled?: boolean;
  [key: string]: unknown;
}

export interface CompiledEntry {
  identifier: string;
  name: string;
  role: string;
  text: string;
}

export interface AssistantPrefix {
  active: boolean;
  /** `assistant_prefill` or `ordered-prompt`; widened while the compiler module migrates. */
  kind?: string;
  messageId?: string;
}

/** What one compilation did with the preset's prompt-side regex rules. */
export interface PromptRegexSummary {
  enabled: boolean;
  includePrefill: boolean;
  rules: number;
  applied: string[];
}
export interface CompiledPreset {
  messages: HostMessage[];
  entries: CompiledEntry[];
  assistantPrefix: AssistantPrefix;
  local: Record<string, string>;
  global: Record<string, string>;
  warnings: string[];
  /** Present on every compilation so the workbench can show rule state. */
  promptRegex?: PromptRegexSummary;
}

export interface CompilePresetOptions {
  seed?: string;
  local?: Record<string, string>;
  global?: Record<string, string>;
  values?: Record<string, unknown>;
  markers?: Record<string, string>;
  characterId?: string | number | null;
  trigger?: string;
  postToolPrefix?: string;
}

/* -------------------------------------------------------------------- tools */

export interface ToolRef {
  modeId: string;
  toolName: string;
}

export interface ToolGroup {
  id: string;
  name: string;
  description: string;
  order: number;
  members: ToolRef[];
}

export interface ToolPresetRule extends ToolRef {
  enabled: boolean;
}

/** A validated preset body whose id is still null until it is stored. */
export interface ToolPresetDraft {
  id: string | null;
  name: string;
  description: string;
  defaultEnabled: boolean;
  groupIds: string[];
  rules: ToolPresetRule[];
  updatedAt: string;
}

export interface ToolPreset extends Omit<ToolPresetDraft, 'id'> {
  id: string;
}

export type ToolSelection =
  | { kind: 'inherit' }
  | { kind: 'custom' }
  | { kind: 'preset'; presetId: string };

export interface ToolCatalogRow {
  name: string;
  description: string;
}

export type ToolCatalogMap = Record<string, ToolCatalogRow[]>;
export type ToolPolicy = Record<string, boolean>;

/* -------------------------------------------------------- preset packages */

export interface PresetPackagePrefill {
  enabled: boolean;
  toolCalls: boolean;
  removeNonOfficialTools: boolean;
  extractOutput?: boolean;
  postToolPrefix: { mode: 'inherit' | 'custom'; text: string };
}

export interface ToolsSection {
  version: number;
  applicable?: boolean;
  activePresetId: string | null;
  presets: ToolPreset[];
  groups: ToolGroup[];
  [key: string]: unknown;
}

export interface PresetPackageDocument {
  format: string;
  version: number;
  metadata?: { name?: string; [key: string]: unknown };
  preset?: { format?: string; data?: SillyTavernPreset; [key: string]: unknown };
  prefill?: PresetPackagePrefill;
  tools?: ToolsSection;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PresetRecord {
  id: string;
  name: string;
  preset: SillyTavernPreset;
  sharePackage?: PresetPackageDocument;
  [key: string]: unknown;
}

export interface PresetBinding {
  enabled: boolean;
  presetId: string;
  characterId: string | null;
  values: Record<string, string>;
  markers: Record<string, string>;
  inherited?: boolean;
  [key: string]: unknown;
}

export interface SessionCompilation {
  key: string;
  at: string;
  presetId: string;
  result: CompiledPreset;
  /** Messages-mode adaptation notes for this compilation; absent for chat-completions. */
  protocolNotes?: string[];
  [key: string]: unknown;
}

/* ------------------------------------------------------------- state file */

/** Wire protocol the plugin adapts the preset injection to. */
export type PresetProtocol = 'chat-completions' | 'messages';

export interface PresetState {
  version: number;
  revision: number;
  defaultPresetId: string | null;
  selectedPresetId: string | null;
  deepseekBetaPrefix: boolean;
  prefixToolCalls: boolean;
  prefixOutputExtraction: boolean;
  postToolPrefixMode: 'inherit' | 'custom';
  postToolPrefixText: string;
  prefixNonOfficialRemoveTools: boolean;
  /**
   * Which protocol the preset injection is compiled for. Defaults to
   * chat-completions, where the full compatibility path applies.
   */
  protocolMode: PresetProtocol;
  autoEnableModes: string[];
  autoEnableSince: Record<string, number>;
  toolCatalogs: ToolCatalogMap;
  modeToolPolicies: Record<string, ToolPolicy>;
  sessionToolPolicies: Record<string, ToolPolicy>;
  toolGroups: ToolGroup[];
  toolPresets: ToolPreset[];
  modeToolSelections: Record<string, ToolSelection>;
  sessionToolSelections: Record<string, ToolSelection>;
  presets: PresetRecord[];
  bindings: Record<string, PresetBinding>;
  global: Record<string, string>;
  sessions: Record<string, SessionCompilation>;
  /** Fields written by a newer version are preserved but not modelled. */
  [key: string]: unknown;
}
