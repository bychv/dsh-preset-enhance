import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { atomicFilePath, cleanAtomicTemps, isErrno, withWriterLock, writeAtomicFile } from './atomic-file.mjs';
import { normalizeToolState } from './tool-presets.mjs';
import { createDefaultSPresetLibrary, normalizeSPresetEditor, normalizeSPresetLibrary } from './s-preset-library.mjs';
const initialState = () => ({
    version: 1,
    revision: 0,
    defaultPresetId: null,
    selectedPresetId: null,
    deepseekBetaPrefix: false,
    forcePrefill: false,
    prefixToolCalls: false,
    prefixOutputExtraction: false,
    postToolPrefixMode: 'inherit',
    postToolPrefixText: '',
    prefixNonOfficialRemoveTools: true,
    protocolMode: 'chat-completions',
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
    // The SPreset editor library is additive and unrelated to preset documents; a fresh
    // state starts with the seeded templates so the editor is usable immediately.
    sPresetLibrary: createDefaultSPresetLibrary(),
    sPresetEditor: { locks: {} },
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
    state.forcePrefill = state.forcePrefill === true;
    state.prefixToolCalls = state.prefixToolCalls === true;
    state.prefixOutputExtraction = state.prefixOutputExtraction === true;
    state.prefixNonOfficialRemoveTools = state.prefixNonOfficialRemoveTools !== false;
    state.postToolPrefixMode = state.postToolPrefixMode === 'custom' ? 'custom' : 'inherit';
    state.postToolPrefixText = typeof state.postToolPrefixText === 'string' ? state.postToolPrefixText : '';
    // Absent on every state written before the protocol switch existed: default to the
    // fully compatible chat-completions path rather than silently choosing Messages.
    state.protocolMode = state.protocolMode === 'messages' ? 'messages' : 'chat-completions';
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
    // A state file written before the SPreset library existed gets the seeded templates once;
    // a library the user emptied stays empty, because the field is then present with zero entries.
    state.sPresetLibrary = normalizeSPresetLibrary(state.sPresetLibrary);
    state.sPresetEditor = normalizeSPresetEditor(state.sPresetEditor);
    return state;
}
function parseState(raw) {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
        throw new Error('不支持的预设数据库版本');
    }
    const state = normalize(parsed);
    const sessions = [];
    let legacySessions = false;
    for (const [id, entry] of Object.entries(recordOf(state.sessions))) {
        if (typeof entry?.presetId !== 'string') {
            legacySessions = true;
            continue;
        }
        const local = recordOf(entry.result?.local);
        // Keep the old key for deduplication, but never let an older build treat this
        // compact row as a usable compiled result. Older builds can still read local.
        if (typeof entry.key === 'string') {
            legacySessions = true;
            sessions.push([id, { presetId: entry.presetId, result: { local }, replay: { key: entry.key } }]);
        }
        else {
            sessions.push([id, { presetId: entry.presetId, result: { local }, ...(entry.replay ? { replay: entry.replay } : {}) }]);
        }
    }
    state.sessions = Object.fromEntries(sessions);
    return { state, legacySessions };
}
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
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
/** Serialized atomic updates prevent lost editor writes. */
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
    async #read(file = this.file) {
        try {
            return parseState(await readFile(file, 'utf8'));
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            return { state: initialState(), legacySessions: false };
        }
    }
    /** Side-effect free: reading a missing file returns a fresh state and does not create it. */
    async read() {
        return (await this.#read()).state;
    }
    /** Clean abandoned temps and compact legacy sessions on activation. */
    async maintain() {
        // A missing parent is normal on a new install. Leave it untouched until a write.
        const entries = await readdir(dirname(this.#key)).catch(error => {
            if (isErrno(error, 'ENOENT'))
                return [];
            throw error;
        });
        if (entries.some(name => name === basename(this.#key) || name.startsWith(basename(this.#key) + '.'))) {
            await this.transaction(() => undefined, { shouldWrite: () => false, compactLegacy: true });
        }
    }
    /** Post-commit notifications, shared across instances of the same state file. */
    subscribe(listener) {
        const queue = queueFor(this.#key);
        (queue.listeners ??= new Set()).add(listener);
        return () => { queue.listeners?.delete(listener); };
    }
    /** Lock the complete read-modify-write across processes. Observers see committed state only. */
    transaction(fn, options = {}) {
        if (this.#closed)
            return Promise.reject(new PresetStoreClosedError(this.file));
        return enqueueWrite(this.#key, async () => {
            options.signal?.throwIfAborted();
            await mkdir(dirname(this.#key), { recursive: true, mode: 0o700 });
            const file = await atomicFilePath(this.#key);
            const queue = queueFor(this.#key);
            const outcome = await withWriterLock(file, async () => {
                if (options.compactLegacy || Date.now() >= (queue.nextCleanup ?? 0)) {
                    queue.nextCleanup = Date.now() + CLEANUP_INTERVAL_MS;
                    await cleanAtomicTemps(file).catch(error => console.warn('preset-enhance: could not scan abandoned state files', error));
                }
                const { state, legacySessions } = await this.#read(file);
                options.signal?.throwIfAborted();
                const result = await fn(state);
                options.signal?.throwIfAborted();
                const write = (options.compactLegacy && legacySessions) || (options.shouldWrite?.(result) ?? true);
                if (write)
                    await writeAtomicFile(file, JSON.stringify(state), options.signal);
                return { result, committed: write ? state : undefined };
            }, options.signal);
            const { committed } = outcome;
            if (committed)
                for (const listener of queueFor(this.#key).listeners ?? []) {
                    try {
                        listener(structuredClone(committed));
                    }
                    catch { /* Observers cannot fail a committed write. */ }
                }
            return outcome.result;
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
