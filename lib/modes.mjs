/**
 * DSH 0.1.7 declarative agent-mode registration and scoped tool catalogs.
 *
 * 0.1.7 removed the `.agent-presets` directory scan and the
 * `agentPresets.readDocument()/standingKeyFor()` surface: an agent mode is now
 * declared as a `@deepseek-ai/dsh-agent-preset` loader row whose config is a
 * `PresetDefinition`, and a mode's tool catalog is read from a scope lease
 * acquired with `agentPresets.acquireScope()`.
 *
 * Verified against the 0.1.7-alpha.1 source (commit c36a83ff6b):
 *
 * - `ctx.agentPresets` is `AgentPresetRegistry`
 *   (packages/preset/agent-preset-registry/src/index.ts:49). `register()`
 *   (index.ts:84-104) eagerly mounts the definition and returns the idempotent
 *   unregister disposer the declaring plugin owns; a duplicate id throws.
 *   `acquireScope(id?)` (index.ts:326-335) returns `{ key } & AsyncDisposable`;
 *   releasing it decrements the generation's users and collects the scope.
 * - `ctx.loader` is the Cordis `Loader extends EntryTree`
 *   (vendor/loader/src/index.ts:77, src/config/tree.ts:7-33). `loader.entries()`
 *   yields entries whose `options` is the complete `EntryOptions`
 *   (src/config/entry.ts:10-23, 50), so the host's *current* `standard`
 *   declaration — including its whole `config.plugins` list with `!!js` nodes
 *   intact — is read straight from the entry, never rebuilt from
 *   `compositionInventory()`, whose rows carry no `config` at all
 *   (composition-inventory.ts:21-35, index.ts:340-350).
 * - Ordering: sibling entries are created through `Promise.all` and their
 *   `options` are assigned before `init()` is awaited
 *   (src/config/group.ts:56-64, src/config/entry.ts:116-155), so a synchronous
 *   scan already sees every declaration. This module never awaits
 *   `loader.await()` (src/config/tree.ts:43-49 would wait on the calling
 *   plugin's own entry) and never calls `agentPresets.list()/resolve()/
 *   acquireScope()` while a plugin is still activating (registry
 *   `diagnostic()` awaits `loader.await()`: index.ts:135-146 reached from
 *   `retain()` line 200), which is what avoids the mutual wait the plan warns
 *   about.
 * - `register()` itself is safe during activation: `mountPreset`
 *   (src/mount.ts:254-268) awaits only its own scope fiber and its own subtree,
 *   and a row waiting for a Host service stays mounted as `pending` instead of
 *   failing (mount.ts:244-252).
 * - `ctx.tools.schemas(scope?: ScopeKey)` (packages/core/tools/src/index.ts:1247)
 *   and `ctx.tools.get(name, scope?)` (index.ts:1217) both take the lease key,
 *   so a catalog read is always paired with a released lease.
 *
 * Sessions are the other half of the rule: an old session can still hold the
 * revision it joined while the registry serves a newer one, so a live session's
 * catalog is read from that session's own agent context and the newest mode
 * catalog is never substituted for it (see {@link readSessionToolCatalog}).
 *
 * The module is pure apart from the host calls it is given, holds no module
 * state, and is directly unit-testable with stubs.
 */
/** Id of the preset-enhance agent mode declared on 0.1.7. */
export const PRESET_MODE_ID = 'st-preset';
/** Id of the host's standard mode declaration. */
export const STANDARD_MODE_ID = 'standard';
/** Loader row name that declares a preset definition. */
export const AGENT_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset';
/** Persona row replaced inside the standard composition. */
export const PERSONA_PLUGIN = '@deepseek-ai/dsh-persona';
/** Row appended to the copied standard composition for the preset mode itself. */
export const PRESET_MODE_ENTRY_ID = 'preset-enhance-mode';
export const PRESET_MODE_ENTRY_NAME = 'dsh-preset-enhance/mode';
function recordOf(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function isPluginRow(value) {
    const row = recordOf(value);
    return typeof row.name === 'string' && row.name !== '';
}
/**
 * Probe the host for the 0.1.7 declarative API. Never calls the host: pure
 * feature detection, so it is safe during activation.
 */
export function modeCapability(host) {
    const service = host?.agentPresets;
    const declarative = typeof service?.register === 'function';
    const scopeLease = typeof service?.acquireScope === 'function';
    const legacyDirectory = typeof service?.readDocument === 'function' || typeof service?.standingKeyFor === 'function';
    if (declarative && scopeLease)
        return { declarative, scopeLease, legacyDirectory, reason: '' };
    if (!declarative && legacyDirectory) {
        return { declarative, scopeLease, legacyDirectory,
            reason: '当前 DSH 只提供 0.1.6 的目录扫描接口（agentPresets.readDocument/standingKeyFor），没有声明式模式注册（agentPresets.register）。' };
    }
    const missing = [!declarative ? 'agentPresets.register' : '', !scopeLease ? 'agentPresets.acquireScope' : '']
        .filter(Boolean).join('、');
    return { declarative, scopeLease, legacyDirectory,
        reason: `当前 DSH 未提供 ${missing}，无法声明式注册预设模式或读取模式工具目录。` };
}
/**
 * Find the host's current `standard` declaration in the loader entry tree.
 *
 * Reads `entry.options.config` — the *composed* row, so a Web-editor override
 * saved into the profile patch is honoured — and never
 * `compositionInventory()`, whose rows carry no plugin config.
 *
 * @param loader - `ctx.loader`, or undefined on a host without it.
 * @param standardId - declaration id to match, `standard` by default.
 * @returns the first matching declaration, or null when the host declares none.
 */
export function findStandardModeDeclaration(loader, standardId = STANDARD_MODE_ID) {
    if (loader === undefined || typeof loader.entries !== 'function')
        return null;
    for (const entry of loader.entries()) {
        const options = entry?.options;
        if (options === undefined || options.name !== AGENT_PRESET_PLUGIN)
            continue;
        const config = recordOf(options.config);
        if (config.id !== standardId)
            continue;
        if (!Array.isArray(config.plugins))
            continue;
        return {
            entryId: typeof options.id === 'string' ? options.id : (typeof entry.id === 'string' ? entry.id : ''),
            definition: {
                id: standardId,
                ...(typeof config.name === 'string' ? { name: config.name } : {}),
                ...(typeof config.description === 'string' ? { description: config.description } : {}),
                ...(typeof config.order === 'number' ? { order: config.order } : {}),
                plugins: config.plugins.filter(isPluginRow),
            },
        };
    }
    return null;
}
/** {@link findStandardModeDeclaration} for a whole host surface. */
export function standardModeDeclaration(host, standardId = STANDARD_MODE_ID) {
    return findStandardModeDeclaration(host?.loader, standardId);
}
/**
 * Build the preset mode declaration from the host's standard declaration: the
 * same child plugins, with the persona replaced by the preset workbench's own
 * empty persona and the preset-enhance mode row appended exactly once. Mirrors
 * the 0.1.6 `buildPresetModeComposition()` string transform, on the object
 * representation 0.1.7 registers.
 *
 * The input declaration is never mutated.
 *
 * @throws when the standard composition has no persona row: registering it
 *   would mount the deployment persona and silently change every prompt.
 */
export function buildPresetModeDefinition(standard, options = {}) {
    const plugins = standard.plugins.map(row => ({ ...row }));
    const personaIndex = plugins.findIndex(row => row.name === PERSONA_PLUGIN);
    if (personaIndex < 0)
        throw new Error('standard 模式组成中找不到 persona 条目');
    plugins[personaIndex] = {
        ...plugins[personaIndex],
        config: { prefix: '', complete: true, includeRuntimeContext: false },
    };
    const entryName = options.presetEntryName ?? PRESET_MODE_ENTRY_NAME;
    const hasEntry = plugins.some(row => row.id === PRESET_MODE_ENTRY_ID || row.name === entryName);
    if (!hasEntry)
        plugins.push({ id: PRESET_MODE_ENTRY_ID, name: entryName });
    if (Array.isArray(options.append)) {
        for (const row of options.append)
            if (isPluginRow(row))
                plugins.push({ ...row });
    }
    return {
        id: options.id ?? PRESET_MODE_ID,
        name: options.name ?? '预设模式',
        description: options.description ?? '新对话从第一轮起自动启用预设工作台中设置的模式默认预设。',
        order: options.order ?? 4,
        plugins,
    };
}
function sleep(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}
/**
 * Wait for the host's standard declaration to appear in the loader tree.
 *
 * The loaders composes sibling entries together, but the preset row may be
 * inserted into a group that is composed after the calling plugin's own group,
 * so a first synchronous scan can legitimately come up empty. This retries on a
 * bounded timer and deliberately does NOT call `loader.await()`: waiting for
 * the whole host tree from inside a plugin's own activation is the mutual wait
 * the 0.1.7 plan forbids (`tree.await()` includes the caller's own entry).
 *
 * @returns the declaration once found, or null after the timeout.
 */
export async function waitForStandardDeclaration(host, options = {}, standardId = STANDARD_MODE_ID) {
    const immediate = findStandardModeDeclaration(host?.loader, standardId);
    if (immediate !== null)
        return immediate;
    const timeoutMs = Math.max(0, options.timeoutMs ?? 5000);
    const intervalMs = Math.max(1, options.intervalMs ?? 50);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await sleep(intervalMs);
        const found = findStandardModeDeclaration(host?.loader, standardId);
        if (found !== null)
            return found;
    }
    return findStandardModeDeclaration(host?.loader, standardId);
}
/** Release one scope lease, tolerating the spellings a host may use. */
export async function releaseModeScope(lease) {
    if (lease == null)
        return;
    const releasable = lease;
    const release = releasable[Symbol.asyncDispose] ?? releasable.release ?? releasable.dispose;
    if (typeof release !== 'function')
        throw new Error('模式作用域租约无法释放：宿主未提供异步释放方法');
    await release.call(lease);
}
function rowsOf(value) {
    return Array.isArray(value) ? value.filter(entry => typeof recordOf(entry).name === 'string') : [];
}
/**
 * Create the preset mode's registration controller.
 *
 * `register()` reads the standard declaration synchronously and then calls the
 * registry, which is why it is safe to start during the plugin's own
 * activation. The controller never touches `loader.await()`.
 */
export function createPresetModeController(host, options = {}) {
    const capability = modeCapability(host);
    const standardId = options.standardId ?? STANDARD_MODE_ID;
    let active = null;
    let inflight = null;
    let epoch = 0;
    async function performRegistration() {
        if (!capability.declarative)
            throw new Error(capability.reason);
        const declaration = findStandardModeDeclaration(host?.loader, standardId);
        if (declaration === null) {
            throw new Error(`loader 条目中没有 ${AGENT_PRESET_PLUGIN} 且 config.id=${standardId} 的声明，无法复制标准模式组成。`);
        }
        const definition = buildPresetModeDefinition(declaration.definition, options);
        const register = host?.agentPresets?.register;
        if (typeof register !== 'function')
            throw new Error(capability.reason);
        const unregister = await register.call(host?.agentPresets, definition);
        let disposed = false;
        return {
            id: definition.id, definition, standard: declaration,
            async dispose() {
                if (disposed)
                    return;
                disposed = true;
                await unregister();
            },
        };
    }
    function registerMode() {
        if (active !== null)
            return Promise.resolve(active);
        if (inflight !== null)
            return inflight;
        const started = epoch;
        const run = (async () => {
            const registration = await performRegistration();
            if (started !== epoch) {
                await registration.dispose();
                throw new Error('预设模式注册在完成前已被释放。');
            }
            active = registration;
            return registration;
        })();
        const tracked = run.finally(() => { if (inflight === tracked)
            inflight = null; });
        inflight = tracked;
        return tracked;
    }
    return {
        capability,
        standard: () => findStandardModeDeclaration(host?.loader, standardId),
        current: () => active,
        register: registerMode,
        async registerWhenAvailable(wait = {}) {
            if (findStandardModeDeclaration(host?.loader, standardId) === null) {
                await waitForStandardDeclaration(host, wait, standardId);
            }
            return registerMode();
        },
        async dispose() {
            epoch += 1;
            const pending = inflight;
            if (pending !== null) {
                try {
                    await pending;
                }
                catch { /* the pending registration released itself */ }
            }
            const current = active;
            active = null;
            if (current !== null)
                await current.dispose();
        },
    };
}
/**
 * Read one mode's current tool catalog: acquire the scope lease, read
 * `tools.schemas(lease.key)`, then always release the lease.
 */
export async function readModeToolCatalog(host, modeId) {
    const service = host?.agentPresets;
    if (typeof service?.acquireScope !== 'function') {
        throw new Error('当前 DSH 未提供 agentPresets.acquireScope，无法读取模式工具目录。');
    }
    if (typeof host?.tools?.schemas !== 'function') {
        throw new Error('当前 DSH 未提供 tools.schemas，无法读取模式工具目录。');
    }
    const lease = await service.acquireScope(modeId);
    try {
        return { modeId, scope: lease.key, tools: rowsOf(host.tools.schemas(lease.key)) };
    }
    finally {
        await releaseModeScope(lease);
    }
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Read a session's tool list without ever mixing generations.
 *
 * A live session is read from its own agent context, which resolves the scope
 * chain it actually joined — including MCP tools registered dynamically on
 * that scope — even when the registry already serves a newer revision. Only a
 * session with no live agent may fall back to the mode's current revision, and
 * that result is labelled `'mode'` so a caller never presents it as the
 * session's tool set.
 */
export async function readSessionToolCatalog(host, sessionId, options = {}) {
    const agent = sessionId === '' ? undefined : host?.agents?.get(sessionId);
    const tools = agent?.ctx?.tools;
    if (typeof tools?.schemas === 'function') {
        try {
            return { sessionId, source: 'session', tools: rowsOf(tools.schemas(agent)) };
        }
        catch (error) {
            return { sessionId, source: 'session', tools: [], error: errorText(error) };
        }
    }
    const modeId = options.modeId;
    if (modeId !== undefined && modeId !== '') {
        try {
            const catalog = await readModeToolCatalog(host, modeId);
            return { sessionId, source: 'mode', scope: catalog.scope, tools: catalog.tools };
        }
        catch (error) {
            return { sessionId, source: 'mode', tools: [], error: errorText(error) };
        }
    }
    return { sessionId, source: 'none', tools: [] };
}
