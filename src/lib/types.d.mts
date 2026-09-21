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
  remaining: number;
}

export interface MacroContextOptions {
  local?: Record<string, string>;
  global?: Record<string, string>;
  values?: Record<string, unknown>;
  random?: () => number;
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

export interface CompiledPreset {
  messages: HostMessage[];
  entries: CompiledEntry[];
  assistantPrefix: AssistantPrefix;
  local: Record<string, string>;
  global: Record<string, string>;
  warnings: string[];
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
  [key: string]: unknown;
}

/* ------------------------------------------------------------- state file */

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
