import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeToolState } from './tool-presets.mjs';
const initialState = () => ({
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
function recordOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function normalize(state) {
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
    if (!state.autoEnableModes.includes('st-preset'))
        state.autoEnableModes.unshift('st-preset');
    state.autoEnableSince = recordOf(state.autoEnableSince);
    state.autoEnableSince['st-preset'] ??= 0;
    state.toolCatalogs = recordOf(state.toolCatalogs);
    state.modeToolPolicies = recordOf(state.modeToolPolicies);
    state.sessionToolPolicies = recordOf(state.sessionToolPolicies);
    // Migrate the short-lived single-mode draft without losing a user's choices.
    if (Array.isArray(state.toolCatalog) && !state.toolCatalogs['st-preset'])
        state.toolCatalogs['st-preset'] = state.toolCatalog;
    if (state.toolPolicy && !state.modeToolPolicies['st-preset'])
        state.modeToolPolicies['st-preset'] = recordOf(state.toolPolicy);
    delete state.toolCatalog;
    delete state.toolPolicy;
    // Tool groups, presets and selections are additive; old states simply have none.
    normalizeToolState(state);
    return state;
}
function parseState(raw) {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
        throw new Error('不支持的预设数据库版本');
    }
    return normalize(parsed);
}
function isErrno(error, code) {
    return error !== null && typeof error === 'object' && error.code === code;
}
/** Atomic temp-file + rename: readers never observe a half-written state file. */
async function writeStateFile(file, state) {
    await mkdir(dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, file);
}
const QUEUES_KEY = Symbol.for('dsh-preset-enhance.preset-store-queues');
function sharedQueues() {
    const globals = globalThis;
    let queues = globals[QUEUES_KEY];
    if (!queues) {
        queues = new Map();
        globals[QUEUES_KEY] = queues;
    }
    return queues;
}
function queueFor(key) {
    const queues = sharedQueues();
    let queue = queues.get(key);
    if (!queue) {
        queue = { tail: Promise.resolve() };
        queues.set(key, queue);
    }
    return queue;
}
/** Append one job to its path queue. The stored tail never rejects, so one failure cannot stall the queue. */
function enqueueWrite(key, task) {
    const queue = queueFor(key);
    const work = queue.tail.then(task);
    queue.tail = work.then(() => undefined, () => undefined);
    return work;
}
/** Thrown when a transaction is started on a PresetStore instance that was already closed. */
export class PresetStoreClosedError extends Error {
    code = 'PRESET_STORE_CLOSED';
    constructor(file) {
        super('预设存储已关闭，已拒绝新的写入：' + file);
        this.name = 'PresetStoreClosedError';
    }
}
/** One process owns a DSH home. Serialized atomic updates prevent lost editor writes. */
export class PresetStore {
    file;
    #key;
    #closed = false;
    #closing = null;
    constructor(file) {
        this.file = file;
        this.#key = resolve(file);
    }
    /** Whether close() was called; from then on new transactions are refused. */
    get closed() { return this.#closed; }
    /** Side-effect free: reading a missing file returns a fresh state and does not create it. */
    async read() {
        try {
            return parseState(await readFile(this.file, 'utf8'));
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            return initialState();
        }
    }
    /**
     * Read-modify-write one state file atomically, serialized across every
     * PresetStore instance that targets the same resolved path. Rejects
     * immediately after close() so a disposed plugin cannot start new work.
     */
    transaction(fn) {
        if (this.#closed)
            return Promise.reject(new PresetStoreClosedError(this.file));
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
    async drain() {
        await queueFor(this.#key).tail;
    }
    /**
     * Dispose this instance: refuse new transactions, let already-queued work
     * finish, then resolve once the path queue is empty. Idempotent - the second
     * call returns the same promise. Reads stay available (they never write).
     */
    close() {
        this.#closed = true;
        this.#closing ??= this.drain();
        return this.#closing;
    }
}
