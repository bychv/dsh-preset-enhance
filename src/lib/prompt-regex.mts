/**
 * Prompt-side regex scripts: Tavern-compatible rule data, executed on the request copy only.
 *
 * Scope of this first version (docs/PROMPT_REGEX_IMPLEMENTATION_PLAN.md):
 *  - the prompt channel only, over historical user and assistant chat text;
 *  - display-side, markdown, slash-command, world-info and reasoning placements are preserved
 *    untouched and never executed, and the workbench states why;
 *  - tool names, arguments, results, images, attachments and reasoning blocks are never rewritten.
 */
import { renderMacros } from './macros.mjs';
import type {
  MacroContext, PromptRegexOptions, PromptRegexTarget, RegexScript, RegexScriptPlan, SillyTavernPreset,
} from './types.mjs';

/** Extension namespace this plugin owns inside one preset. */
export const PRESET_EXTENSION_KEY = 'dsh-preset-enhance';
/** Tavern placement values this version executes; every other value is kept but not run. */
export const PLACEMENT_USER_INPUT = 1;
export const PLACEMENT_AI_OUTPUT = 2;
/** Depth of the synthetic assistant prefix: it never occupies a real chat floor. */
export const PREFILL_DEPTH = -1;

const SCRIPT_LIMIT = 500;
const TRIM_LIMIT = 64;
const PATTERN_CACHE_LIMIT = 200;
const SUBSTITUTE_RAW = 1;
const SUBSTITUTE_ESCAPED = 2;
const ALLOWED_FLAGS = 'dgimsuvy';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function namespaceOf(preset: SillyTavernPreset | null | undefined): Record<string, unknown> | undefined {
  const extensions = preset?.extensions;
  if (!isRecord(extensions)) return undefined;
  const namespace = extensions[PRESET_EXTENSION_KEY];
  return isRecord(namespace) ? namespace : undefined;
}

/**
 * Read this plugin's execution switches.
 * A missing field means off, so an upgrade never starts rewriting requests on its own.
 */
export function readPromptRegexOptions(preset: SillyTavernPreset | null | undefined): PromptRegexOptions {
  const raw = namespaceOf(preset)?.promptRegex;
  return {
    enabled: isRecord(raw) && raw.enabled === true,
    includePrefill: isRecord(raw) && raw.includePrefill === true,
  };
}

/** Merge the switches into one preset, keeping every other extension and namespace field. */
export function writePromptRegexOptions(preset: SillyTavernPreset, patch: Partial<PromptRegexOptions>): SillyTavernPreset {
  const extensions = { ...(isRecord(preset.extensions) ? preset.extensions : {}) };
  const namespace = { ...(isRecord(extensions[PRESET_EXTENSION_KEY]) ? (extensions[PRESET_EXTENSION_KEY] as Record<string, unknown>) : {}) };
  const current = isRecord(namespace.promptRegex) ? namespace.promptRegex : {};
  namespace.promptRegex = { ...current, ...patch };
  extensions[PRESET_EXTENSION_KEY] = namespace;
  return { ...preset, extensions };
}

/** Rules exactly as stored, in array order. Nothing here rewrites the preset. */
export function readRegexScripts(preset: SillyTavernPreset | null | undefined): RegexScript[] {
  const extensions = preset?.extensions;
  const list = isRecord(extensions) ? extensions.regex_scripts : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord).slice(0, SCRIPT_LIMIT) as unknown as RegexScript[];
}

/** Fill missing or conflicting rule ids once; an existing id is never regenerated. */
export function ensureRegexIds(scripts: readonly RegexScript[], mint: (index: number) => string = index => 'regex-' + (index + 1)): RegexScript[] {
  const seen = new Set<string>();
  return scripts.map((script, index) => {
    const current = typeof script.id === 'string' ? script.id.trim() : '';
    let id = current;
    if (!id || seen.has(id)) {
      id = mint(index) || 'regex-' + (index + 1);
      let attempt = 2;
      while (seen.has(id)) id = (mint(index) || 'regex') + '-' + attempt++;
    }
    seen.add(id);
    return { ...script, id };
  });
}

/** Which chat roles one placement selects, and which values this version does not run. */
export function regexPlacement(raw: unknown): { targets: PromptRegexTarget[]; unsupported: number[] } {
  const values = (Array.isArray(raw) ? raw : [raw]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value));
  const targets: PromptRegexTarget[] = [];
  const unsupported: number[] = [];
  for (const value of values) {
    if (value === PLACEMENT_USER_INPUT) { if (!targets.includes('user')) targets.push('user'); }
    else if (value === PLACEMENT_AI_OUTPUT) { if (!targets.includes('assistant')) targets.push('assistant'); }
    else unsupported.push(value);
  }
  return { targets, unsupported };
}

/** Depth window: -1 means unbounded, and 0 is a real floor rather than "unset". */
export function depthInWindow(script: RegexScript, depth: number): boolean {
  const min = typeof script.minDepth === 'number' && Number.isFinite(script.minDepth) ? script.minDepth : -1;
  const max = typeof script.maxDepth === 'number' && Number.isFinite(script.maxDepth) ? script.maxDepth : -1;
  if (min >= 0 && depth < min) return false;
  if (max >= 0 && depth > max) return false;
  return true;
}

/** Name shown to the user when a rule runs or fails. */
export function regexName(script: RegexScript): string {
  const name = typeof script.scriptName === 'string' ? script.scriptName.trim() : '';
  if (name) return name;
  return typeof script.id === 'string' && script.id ? script.id : '未命名规则';
}

/**
 * Decide whether one rule runs for one depth, and say why when it does not.
 *
 * Tavern enters the prompt pass when `promptOnly` is set. The plan deliberately drops Tavern's
 * "both flags false" branch: that one belongs to message input, output cleanup and editing, where
 * re-running it on every request would change semantics and repeat macro side effects.
 */
export function planRegexScript(script: RegexScript, depth: number): RegexScriptPlan {
  const placement = regexPlacement(script.placement);
  const base = { targets: placement.targets, unsupportedPlacements: placement.unsupported, reason: '' };
  const find = typeof script.findRegex === 'string' ? script.findRegex : '';
  if (script.disabled === true) return { ...base, runs: false, supported: true, reason: '已停用' };
  if (!find) return { ...base, runs: false, supported: false, reason: '查找式为空' };
  if (placement.targets.length === 0) {
    return { ...base, runs: false, supported: false,
      reason: placement.unsupported.length
        ? 'placement ' + placement.unsupported.join('/') + ' 本版不执行（仅支持 user_input 与 ai_output）'
        : 'placement 未指定 user_input / ai_output' };
  }
  if (script.promptOnly !== true) {
    return { ...base, runs: false, supported: false, reason: '仅作用于显示侧或消息写入阶段，本次请求不执行' };
  }
  if (!depthInWindow(script, depth)) {
    return { ...base, runs: false, supported: true, reason: '深度 ' + depth + ' 不在规则窗口内' };
  }
  if (!isPatternUsable(find, script.substituteRegex)) {
    return { ...base, runs: false, supported: false, reason: '查找式无法编译为合法正则' };
  }
  return { ...base, runs: true, supported: true, reason: '' };
}

/** Cache keyed by the fully expanded pattern, as the plan requires. */
const patternCache = new Map<string, RegExp>();

function sanitizeFlags(raw: string): string {
  const seen = new Set<string>();
  let out = '';
  for (const ch of raw) if (ALLOWED_FLAGS.includes(ch) && !seen.has(ch)) { seen.add(ch); out += ch; }
  return out;
}

/** Compile `/pattern/flags` or a plain pattern string into a native RegExp. */
export function compilePattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(pattern);
  const regex = literal ? new RegExp(literal[1], sanitizeFlags(literal[2])) : new RegExp(pattern);
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(pattern, regex);
  return regex;
}

function isPatternUsable(pattern: string, substitute: unknown): boolean {
  try { compilePattern(expandPattern(pattern, substitute, null)); return true; }
  catch { return false; }
}

function substituteMode(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw === SUBSTITUTE_ESCAPED ? SUBSTITUTE_ESCAPED : raw === SUBSTITUTE_RAW ? SUBSTITUTE_RAW : 0;
  const name = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (name === 'ESCAPED') return SUBSTITUTE_ESCAPED;
  return name === 'RAW' ? SUBSTITUTE_RAW : 0;
}

/** Escape a macro value so it matches literally while the pattern's own syntax stays active. */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandPattern(pattern: string, substitute: unknown, ctx: MacroContext | null): string {
  const how = substituteMode(substitute);
  if (how === 0 || ctx === null) return pattern;
  if (how === SUBSTITUTE_RAW) return renderMacros(pattern, ctx);
  // ESCAPED escapes only what the macros expand to; the pattern's own regex syntax is kept.
  return renderMacros(pattern, { ...ctx, valueTransform: escapeRegexLiteral });
}

function resolveTrimStrings(raw: unknown, ctx: MacroContext): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, TRIM_LIMIT).map(value => renderMacros(value, ctx));
}

/** Remove each literal everywhere: Tavern's filterString, applied before insertion. */
function filterLiterals(value: string, trim: readonly string[]): string {
  let out = value;
  for (const literal of trim) if (literal) out = out.split(literal).join('');
  return out;
}

interface RegexMatch {
  full: string;
  groups: (string | undefined)[];
  named: Record<string, string | undefined>;
}

function matchOf(args: readonly unknown[]): RegexMatch {
  const full = String(args[0] ?? '');
  const tail = args.at(-1);
  const hasNamed = isRecord(tail);
  const named = hasNamed ? (tail as Record<string, string | undefined>) : {};
  const groups = args.slice(1, args.length - (hasNamed ? 3 : 2))
    .map(value => (value === undefined ? undefined : String(value)));
  return { full, groups, named };
}

/**
 * Expand the replacement template: `{{match}}` and `$0` are the whole match, then numbered and
 * named captures, each filtered by trimStrings. An unmatched capture inserts nothing.
 */
export function renderReplacement(template: string, match: RegexMatch, trim: readonly string[]): string {
  let out = '', cursor = 0;
  while (cursor < template.length) {
    if (template.startsWith('{{match}}', cursor)) { out += filterLiterals(match.full, trim); cursor += 9; continue; }
    const ch = template[cursor] as string;
    if (ch !== '$') { out += ch; cursor++; continue; }
    const named = /^\$<([^>]+)>/.exec(template.slice(cursor));
    if (named) { out += filterLiterals(match.named[named[1] as string] ?? '', trim); cursor += named[0].length; continue; }
    const numbered = /^\$(\d+)/.exec(template.slice(cursor));
    if (numbered) {
      const index = Number(numbered[1]);
      const value = index === 0 ? match.full : match.groups[index - 1];
      out += filterLiterals(value ?? '', trim);
      cursor += numbered[0].length; continue;
    }
    out += ch; cursor++;
  }
  return out;
}

/** Run one rule over one text. Macro expansion happens last, over the replacement result. */
export function runRegexScript(text: string, script: RegexScript, ctx: MacroContext): string {
  const find = typeof script.findRegex === 'string' ? script.findRegex : '';
  if (script.disabled === true || !find || text === '') return text;
  const pattern = expandPattern(find, script.substituteRegex, ctx);
  let regex: RegExp;
  try { regex = compilePattern(pattern); }
  catch (error) { throw new Error('正则规则「' + regexName(script) + '」的查找式无效：' + message(error)); }
  const trim = resolveTrimStrings(script.trimStrings, ctx);
  const template = typeof script.replaceString === 'string' ? script.replaceString : '';
  // Global and sticky regexes carry lastIndex between calls; every run starts from the beginning.
  if (regex.global || regex.sticky) regex.lastIndex = 0;
  let matched = false;
  const replaced = text.replace(regex, (...args: unknown[]) => { matched = true; return renderReplacement(template, matchOf(args), trim); });
  // Only a real replacement pulls in the macro pass: expanding macros inside untouched chat text
  // is not what the request copy is for.
  return matched ? renderMacros(replaced, ctx) : text;
}

export interface PromptRegexResult {
  text: string;
  applied: string[];
}

/**
 * Run every applicable rule over one chat text, in array order, chaining each result into the next.
 * A failure names the rule and aborts the whole preparation instead of sending a partial rewrite.
 */
export function applyPromptRegex(
  text: string,
  scripts: readonly RegexScript[],
  ctx: MacroContext,
  options: { target: PromptRegexTarget; depth: number },
): PromptRegexResult {
  let out = text;
  const applied: string[] = [];
  for (const script of scripts) {
    const plan = planRegexScript(script, options.depth);
    if (!plan.runs || !plan.targets.includes(options.target)) continue;
    out = runRegexScript(out, script, ctx);
    applied.push(regexName(script));
  }
  return { text: out, applied };
}
