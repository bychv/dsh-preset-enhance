import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeToolState } from './tool-presets.mjs';
import type { PresetState, ToolCatalogRow, ToolPolicy } from './types.mjs';

const initialState = (): PresetState => ({
  version: 1,
  revision: 0,
  defaultPresetId: null,
  selectedPresetId: null,
  deepseekBetaPrefix: false,
  prefixToolCalls: false,
  prefixOutputExtraction: false,
  postToolPrefixMode: 'inherit',
  postToolPrefixText: '',
  prefixNonOfficialRemoveTools: true,
  autoEnableModes: ['st-preset'],
  autoEnableSince: { 'st-preset': 0 },
  toolCatalogs: {},
  modeToolPolicies: {},
  sessionToolPolicies: {},
  toolGroups: [],
  toolPresets: [],
  modeToolSelections: {},
  sessionToolSelections: {},
  presets: [],
  bindings: {},
  global: {},
  sessions: {},
});

/** Persisted JSON is untrusted: keep only plain objects, otherwise use an empty object. */
function recordOf<T>(value: unknown): Record<string, T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {};
}

function normalize(state: PresetState): PresetState {
  state.presets = Array.isArray(state.presets) ? state.presets : [];
  state.defaultPresetId ??= null;
  state.deepseekBetaPrefix = state.deepseekBetaPrefix === true;
  state.prefixToolCalls = state.prefixToolCalls === true;
  state.prefixOutputExtraction = state.prefixOutputExtraction === true;
  state.prefixNonOfficialRemoveTools = state.prefixNonOfficialRemoveTools !== false;
  state.postToolPrefixMode = state.postToolPrefixMode === 'custom' ? 'custom' : 'inherit';
  state.postToolPrefixText = typeof state.postToolPrefixText === 'string' ? state.postToolPrefixText : '';
  delete state.prefixRelayUrl;
  state.selectedPresetId ??= state.defaultPresetId ?? state.presets[0]?.id ?? null;
  if (!state.presets.some(preset => preset?.id === state.selectedPresetId)) {
    state.selectedPresetId = state.presets.find(preset => preset?.id === state.defaultPresetId)?.id ??
      state.presets[0]?.id ?? null;
  }
  state.autoEnableModes = Array.isArray(state.autoEnableModes) ? state.autoEnableModes : ['st-preset'];
  if (!state.autoEnableModes.includes('st-preset')) state.autoEnableModes.unshift('st-preset');
  state.autoEnableSince = recordOf<number>(state.autoEnableSince);
  state.autoEnableSince['st-preset'] ??= 0;
  state.toolCatalogs = recordOf<ToolCatalogRow[]>(state.toolCatalogs);
  state.modeToolPolicies = recordOf<ToolPolicy>(state.modeToolPolicies);
  state.sessionToolPolicies = recordOf<ToolPolicy>(state.sessionToolPolicies);
  // Migrate the short-lived single-mode draft without losing a user's choices.
  if (Array.isArray(state.toolCatalog) && !state.toolCatalogs['st-preset']) state.toolCatalogs['st-preset'] = state.toolCatalog as ToolCatalogRow[];
  if (state.toolPolicy && !state.modeToolPolicies['st-preset']) state.modeToolPolicies['st-preset'] = recordOf<boolean>(state.toolPolicy);
  delete state.toolCatalog;
  delete state.toolPolicy;
  // Tool groups, presets and selections are additive; old states simply have none.
  normalizeToolState(state);
  return state;
}

function parseState(raw: string): PresetState {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('不支持的预设数据库版本');
  }
  return normalize(parsed as PresetState);
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

/** Atomic temp-file + rename: readers never observe a half-written state file. */
async function writeStateFile(file: string, state: PresetState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, file);
}

/**
 * One process owns a DSH home, but apply() builds a fresh PresetStore per
 * activation, so several instances can point at the same state file. Write
 * coordination is therefore keyed on the resolved file path and stored on
 * globalThis under a registered symbol, so every module copy in the process
 * (published lib/store.mjs and dist/lib/store.mjs) shares one queue and an old
 * instance can never interleave a read-modify-write with a newer one.
 */
interface StoreQueue { tail: Promise<unknown> }

const QUEUES_KEY = Symbol.for('dsh-preset-enhance.preset-store-queues');

function sharedQueues(): Map<string, StoreQueue> {
  const globals = globalThis as unknown as Record<symbol, Map<string, StoreQueue> | undefined>;
  let queues = globals[QUEUES_KEY];
  if (!queues) { queues = new Map<string, StoreQueue>(); globals[QUEUES_KEY] = queues; }
  return queues;
}

function queueFor(key: string): StoreQueue {
  const queues = sharedQueues();
  let queue = queues.get(key);
  if (!queue) { queue = { tail: Promise.resolve() }; queues.set(key, queue); }
  return queue;
}

/** Append one job to its path queue. The stored tail never rejects, so one failure cannot stall the queue. */
function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const queue = queueFor(key);
  const work = queue.tail.then(task);
  queue.tail = work.then(() => undefined, () => undefined);
  return work;
}

/** Thrown when a transaction is started on a PresetStore instance that was already closed. */
export class PresetStoreClosedError extends Error {
  readonly code = 'PRESET_STORE_CLOSED';
  constructor(file: string) {
    super('预设存储已关闭，已拒绝新的写入：' + file);
    this.name = 'PresetStoreClosedError';
  }
}

/** One process owns a DSH home. Serialized atomic updates prevent lost editor writes. */
export class PresetStore {
  readonly file: string;
  #key: string;
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(file: string) {
    this.file = file;
    this.#key = resolve(file);
  }

  /** Whether close() was called; from then on new transactions are refused. */
  get closed(): boolean { return this.#closed; }

  /** Side-effect free: reading a missing file returns a fresh state and does not create it. */
  async read(): Promise<PresetState> {
    try {
      return parseState(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      return initialState();
    }
  }

  /**
   * Read-modify-write one state file atomically, serialized across every
   * PresetStore instance that targets the same resolved path. Rejects
   * immediately after close() so a disposed plugin cannot start new work.
   */
  transaction<T>(fn: (state: PresetState) => T | Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new PresetStoreClosedError(this.file));
    return enqueueWrite(this.#key, async () => {
      const state = await this.read();
      const result = await fn(state);
      await writeStateFile(this.file, state);
      return result;
    });
  }

  /**
   * Wait for every write queued on this path so far (including writes made by
   * other instances). Never rejects and is safe to call twice: a failed
   * transaction is reported by its own promise, not by the drain.
   */
  async drain(): Promise<void> {
    await queueFor(this.#key).tail;
  }

  /**
   * Dispose this instance: refuse new transactions, let already-queued work
   * finish, then resolve once the path queue is empty. Idempotent - the second
   * call returns the same promise. Reads stay available (they never write).
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.drain();
    return this.#closing;
  }
}
