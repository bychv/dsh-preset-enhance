import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const initialState = () => ({
  version: 1,
  revision: 0,
  defaultPresetId: null,
  selectedPresetId: null,
  deepseekBetaPrefix: false,
  autoEnableModes: ['st-preset'],
  autoEnableSince: { 'st-preset': 0 },
  toolCatalogs: {},
  modeToolPolicies: {},
  sessionToolPolicies: {},
  presets: [],
  bindings: {},
  global: {},
  sessions: {},
});
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function normalize(state) {
  state.presets = Array.isArray(state.presets) ? state.presets : [];
  state.defaultPresetId ??= null;
  state.deepseekBetaPrefix = state.deepseekBetaPrefix === true;
  state.selectedPresetId ??= state.defaultPresetId ?? state.presets[0]?.id ?? null;
  if (!state.presets.some(preset => preset?.id === state.selectedPresetId)) {
    state.selectedPresetId = state.presets.find(preset => preset?.id === state.defaultPresetId)?.id ??
      state.presets[0]?.id ?? null;
  }
  state.autoEnableModes = Array.isArray(state.autoEnableModes) ? state.autoEnableModes : ['st-preset'];
  if (!state.autoEnableModes.includes('st-preset')) state.autoEnableModes.unshift('st-preset');
  state.autoEnableSince = record(state.autoEnableSince);
  state.autoEnableSince['st-preset'] ??= 0;
  state.toolCatalogs = record(state.toolCatalogs);
  state.modeToolPolicies = record(state.modeToolPolicies);
  state.sessionToolPolicies = record(state.sessionToolPolicies);
  // Migrate the short-lived single-mode draft without losing a user's choices.
  if (Array.isArray(state.toolCatalog) && !state.toolCatalogs['st-preset']) state.toolCatalogs['st-preset'] = state.toolCatalog;
  if (state.toolPolicy && !state.modeToolPolicies['st-preset']) state.modeToolPolicies['st-preset'] = record(state.toolPolicy);
  delete state.toolCatalog;
  delete state.toolPolicy;
  return state;
}

/** One process owns a DSH home. Serialized atomic updates prevent lost editor writes. */
export class PresetStore {
  constructor(file) { this.file = file; this.tail = Promise.resolve(); }
  async read() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 1) throw new Error('不支持的预设数据库版本');
      return normalize(state);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return initialState();
    }
  }
  transaction(fn) {
    const work = this.tail.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
