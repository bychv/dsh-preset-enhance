import { validatePreset } from './preset.mjs';
import { validateToolsSection } from './tool-presets.mjs';

export const PRESET_PACKAGE_FORMAT = 'dsh-preset-enhance';
export const PRESET_PACKAGE_VERSION = 1;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyToolsSection = () => ({ version: 1, activePresetId: null, presets: [], groups: [] });

function validatePrefill(prefill) {
  if (prefill === null || prefill === undefined) return;
  if (!isRecord(prefill)) throw new Error('预设包 prefill 必须为对象或 null');
  for (const key of ['enabled', 'toolCalls', 'removeNonOfficialTools']) {
    if (typeof prefill[key] !== 'boolean') throw new Error(`预设包 prefill.${key} 必须为布尔值`);
  }
  const post = prefill.postToolPrefix;
  if (!isRecord(post) || !['inherit', 'custom'].includes(post.mode) || typeof post.text !== 'string') {
    throw new Error('预设包 postToolPrefix 必须包含有效的 mode 和 text');
  }
}

/**
 * Validate the `tools` container of a share package.
 *
 * Same-version sections get the full `validateToolsSection` treatment — counts,
 * uniqueness and reference integrity (dangling `groupIds`/`activePresetId`,
 * duplicate ids, duplicate or doubly claimed `{modeId,toolName}` references) —
 * plus the package rule that a present `presets`/`groups` key is a real array.
 * A section declared with an unknown `tools.version` is opaque: it is reported
 * as `applicable:false` and never rejected, so the package keeps importing,
 * exporting and round-tripping untouched; only application is refused (that
 * refusal lives in `remapToolPackage`).
 *
 * The returned section is a projection of known fields. Callers that must keep
 * unknown same-version fields have to retain the original container instead of
 * replacing it with this projection; `validatePresetPackage` does exactly that.
 */
export function validateToolsPackage(tools) {
  if (tools === undefined) return validateToolsSection(tools);
  if (!isRecord(tools)) throw new Error('预设包 tools 必须为对象');
  const section = validateToolsSection(tools);
  if (!section.applicable) return section;
  for (const key of ['presets', 'groups']) {
    if (tools[key] !== undefined && !Array.isArray(tools[key])) {
      throw new Error(`预设包 tools.${key} 必须为数组`);
    }
  }
  return section;
}

/** Validate the envelope, but keep unknown fields for same-version round trips. */
export function validatePresetPackage(document) {
  if (!isRecord(document) || document.format !== PRESET_PACKAGE_FORMAT) throw new Error('无法识别预设包格式');
  if (document.version !== PRESET_PACKAGE_VERSION) throw new Error('不支持的预设包版本，请升级插件后重试');
  if (!isRecord(document.preset) || document.preset.format !== 'sillytavern') {
    throw new Error('预设包 preset.format 必须为 sillytavern');
  }
  validatePreset(document.preset.data);
  if (document.metadata !== undefined && !isRecord(document.metadata)) throw new Error('预设包 metadata 必须为对象');
  if (document.metadata?.name !== undefined && typeof document.metadata.name !== 'string') throw new Error('预设包名称必须为文本');
  validatePrefill(document.prefill);
  if (document.tools !== undefined) validateToolsPackage(document.tools);
  if (document.extensions !== undefined && !isRecord(document.extensions)) throw new Error('预设包 extensions 必须为对象');
  return document;
}

export function decodePresetDocument(document, fallbackName = '未命名预设') {
  if (isRecord(document) && (document.format === PRESET_PACKAGE_FORMAT || !Array.isArray(document.prompts))) {
    validatePresetPackage(document);
    return {
      name: document.metadata?.name || fallbackName,
      preset: structuredClone(document.preset.data),
      sharePackage: structuredClone(document),
    };
  }
  validatePreset(document);
  return { name: fallbackName, preset: structuredClone(document) };
}

export function prefillFromState(state) {
  return {
    enabled: state.deepseekBetaPrefix === true,
    toolCalls: state.prefixToolCalls === true,
    removeNonOfficialTools: state.prefixNonOfficialRemoveTools !== false,
    postToolPrefix: {
      mode: state.postToolPrefixMode === 'custom' ? 'custom' : 'inherit',
      text: typeof state.postToolPrefixText === 'string' ? state.postToolPrefixText : '',
    },
  };
}

/**
 * New packages snapshot saved interface settings; imported packages keep their attachments.
 *
 * `tools` optionally replaces the exported tool section with a freshly built one
 * (`exportToolsSection(state, toolPresetId)`); passing `undefined`/`null` keeps the
 * section already stored in `record.sharePackage`, so packages without tools keep
 * round-tripping unchanged. Unknown same-version fields of the handed-in section
 * are cloned as-is, and an unknown `tools.version` is embedded, not rejected.
 */
export function encodePresetPackage(record, state, tools) {
  const document = record.sharePackage ? structuredClone(record.sharePackage) : {
    format: PRESET_PACKAGE_FORMAT,
    version: PRESET_PACKAGE_VERSION,
    metadata: {},
    preset: { format: 'sillytavern' },
    prefill: prefillFromState(state),
    tools: emptyToolsSection(),
    extensions: {},
  };
  document.metadata = { ...document.metadata, name: record.name };
  document.preset = { ...document.preset, data: structuredClone(record.preset) };
  if (tools !== undefined && tools !== null) {
    validateToolsPackage(tools);
    document.tools = structuredClone(tools);
  }
  return validatePresetPackage(document);
}

/** Only an explicit settings save replaces known prefill fields, retaining future fields. */
export function attachPrefillSettings(record, state) {
  const document = encodePresetPackage(record, state);
  const prefill = prefillFromState(state);
  document.prefill = {
    ...document.prefill,
    ...prefill,
    postToolPrefix: { ...document.prefill?.postToolPrefix, ...prefill.postToolPrefix },
  };
  record.sharePackage = document;
}

export function applyPackagePrefill(state, record) {
  const document = validatePresetPackage(record.sharePackage);
  if (!document.prefill) throw new Error('该预设包未附带接口设置');
  const prefill = document.prefill;
  state.deepseekBetaPrefix = prefill.enabled;
  state.prefixToolCalls = prefill.toolCalls;
  state.prefixNonOfficialRemoveTools = prefill.removeNonOfficialTools;
  state.postToolPrefixMode = prefill.postToolPrefix.mode;
  state.postToolPrefixText = prefill.postToolPrefix.text;
}
