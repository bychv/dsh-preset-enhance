import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PresetStore } from './lib/store.mjs';
import { compilePreset, validatePreset, getOrder, dshSystemPromptEnabled } from './lib/preset.mjs';
import { decodePresetDocument, encodePresetPackage, attachPrefillSettings, applyPackagePrefill } from './lib/preset-package.mjs';
import { installDeepSeekBetaBridge } from './lib/deepseek-beta.mjs';
import { createProtocolObserver } from './lib/protocol.mjs';
import { connectionSelection, selectConnection, sessionConnection, writeConnectionProtocol } from './lib/connection.mjs';
import { installToolRestrictions } from './lib/tool-restrictions.mjs';
import { createPresetModeController, modeCapability, readModeToolCatalog } from './lib/modes.mjs';
import { createDeepSeekChatAdapter, DEEPSEEK_CHAT_PROVIDER_ID, DeepSeekFileStore, deepSeekFilesIndexPath, resolveChatConnection, resolveRequestImageTarget, } from './vendor/deepseek-chat/index.mjs';
import { adaptPresetForMessages } from './lib/messages.mjs';
import { clearPresetEnhanceUnavailableReason, markPresetEnhanceActive, setPresetEnhanceUnavailableReason, } from './lib/availability.mjs';
import { OUTPUT_EXTRACTION_PROMPT_TEMPLATE } from './lib/output-extractor.mjs';
import { normalizeToolGroups, normalizeToolPreset, normalizeToolSelection, assertPresetGroupIds, toolPolicySnapshot, effectiveToolEnabled, effectiveToolPolicy, remapToolPackage, editableToolCatalog, presetReferenceCounts, unresolvedToolRefs, resetPresetSelections, exportToolsSection, TOOL_PRESET_LIMIT, } from './lib/tool-presets.mjs';
export const name = 'preset-enhance';
export const inject = ['llm', 'sessions', 'webServer', 'commands', 'tools', 'agentPresets', 'agents'];
export const AGENT_PRESET_ID = 'st-preset';
const BASE = '/preset-enhance';
const DSH_SYSTEM_PROMPT = '@deepseek-ai/dsh-system-prompt';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PRESET_COMPILER_VERSION = 4;
const ownGet = (object, key) => key !== undefined && Object.hasOwn(object, key) ? object[key] : undefined;
const assign = (object, key, value) => {
    Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
};
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** Actions that need the DSH mode registry; catalog-backed ones also enumerate mode tools. */
const MODE_ACTIONS = new Set(['save-auto-modes', 'save-mode-tools', 'save-session-tools',
    'save-tool-groups', 'save-tool-preset', 'select-tool-policy', 'import-package-tools']);
const CATALOG_ACTIONS = new Set(['save-mode-tools', 'save-session-tools',
    'save-tool-groups', 'save-tool-preset', 'import-package-tools']);
/**
 * Ordered teardown shared by every activation.
 *
 * Disabling the plugin must not leave duplicated routes, commands or listeners
 * behind, and a save that is already in flight must not repopulate state through
 * an instance that is being released. Teardown therefore (1) refuses new work,
 * (2) waits for everything already tracked, and only then (3) releases the
 * process-global fetch bridge.
 */
function createPluginLifecycle() {
    let closing = false;
    let drained = null;
    const inflight = new Set();
    return {
        get closing() { return closing; },
        /** Track an already-started unit of work so teardown can wait for it. */
        track(work) {
            if (closing)
                return work;
            const tracked = work.then(() => undefined, () => undefined);
            inflight.add(tracked);
            void tracked.then(() => inflight.delete(tracked));
            return work;
        },
        dispose(release) {
            if (drained)
                return drained;
            closing = true;
            drained = (async () => {
                while (inflight.size > 0)
                    await Promise.all([...inflight]);
                await release();
            })();
            return drained;
        },
    };
}
/** Managed preset files are compared before writing; the host derives its standing generation from mtime+size. */
async function writeManagedFile(file, content) {
    const desired = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const existing = await readFile(file).catch(() => null);
    if (existing !== null && Buffer.compare(existing, desired) === 0)
        return false;
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, desired);
    await rename(temp, file);
    return true;
}
/** Compose one startup failure message that names the stage, the path and the cause. */
function describeStartupFailure(stage, detail, error) {
    const cause = error instanceof Error ? error.message : String(error);
    return `预设工作台初始化失败：${stage}（${detail}）：${cause}`;
}
/**
 * Minimal payload so the workbench can still mount and explain why the plugin
 * degraded instead of injecting. It deliberately carries no preset data.
 */
function degradedPayload(reason) {
    return {
        startupError: reason,
        revision: 0,
        presets: [],
        binding: { enabled: false },
        selectedPresetId: null,
        defaultPresetId: null,
        modeDefaultPresetId: null,
        modeDefaultName: null,
        postToolPrefixMode: 'inherit',
        postToolPrefixText: '',
        deepseekBetaPrefix: false,
        prefixToolCalls: false,
        prefixOutputExtraction: false,
        prefixNonOfficialRemoveTools: true,
        outputExtractionTemplate: OUTPUT_EXTRACTION_PROMPT_TEMPLATE,
        presetMode: false,
        sessionMode: '',
        agentModes: [],
        autoEnableModes: [],
        dshSystemPromptText: '',
        toolCatalogs: {},
        mcpToolGroups: {},
        toolCatalogErrors: {},
        modeToolPolicies: {},
        sessionToolPolicy: null,
        toolGroups: [],
        toolPresets: [],
        modeToolSelections: {},
        sessionToolSelection: null,
        toolPresetRefCounts: {},
        unresolvedToolRefs: [],
        last: null,
        protocol: null,
    };
}
export async function apply(ctx, config = {}) {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
    const store = new PresetStore(resolve(config.dataFile ?? join(home, 'preset-enhance', 'state.json')));
    const presetRoot = resolve(config.agentPresetRoot ?? join(home, '.agent-presets'));
    // Claim availability before the first await so the generated st-preset mode can
    // never be mounted against a plugin that is not actually injecting.
    const releaseAvailability = markPresetEnhanceActive();
    ctx.effect(() => () => releaseAvailability(), 'preset-enhance: mode availability');
    const lifecycle = createPluginLifecycle();
    const routed = new WeakSet();
    // DSH 0.1.6 defaults the official connection to the Messages protocol, where the
    // assistant-prefix/toolcall compatibility bridge cannot apply. Observations are
    // recorded per session so the workbench can say so instead of pretending.
    const protocolObserver = createProtocolObserver();
    // 0.1.7 removed the official Chat Completions protocol and routes plain requests through
    // pi-ai, which rewrites system prompts; the plugin ships its own adapter so preset
    // ordering, the prefill bridge, DSML conversion and extraction keep a Chat wire format.
    const chatConnection = () => resolveChatConnection({});
    // The upload cache is owner-private and lives next to the plugin's own state file; the
    // index is keyed by a hash of the endpoint and key, so no credential reaches disk.
    const chatFiles = new DeepSeekFileStore({ indexPath: deepSeekFilesIndexPath(store.file) });
    const chatAdapter = createDeepSeekChatAdapter({
        connection: chatConnection,
        resolveFiles: () => chatFiles,
        resolveApiKey: async () => resolveChatApiKey(ctx, config.chatApiKeyEnv ?? DEFAULT_CHAT_API_KEY_ENV),
        resolveUserId: () => 'preset-enhance',
        // Images keep going through the host's attachment service: we only turn the
        // retained references into the bytes the provider request needs.
        resolveRequestImages: async (options, signal) => buildRequestImages(ctx, chatConnection, options, signal),
        resolveImageAccess: ref => imageAccessOf(ctx, ref),
    });
    const disposeChatAdapter = ctx.llm?.registerAdapter?.([DEEPSEEK_CHAT_PROVIDER_ID], chatAdapter);
    // The in-app official-request switch is parked behind an explicit opt-in; the shipped
    // default leaves the host's own protocol behaviour untouched.
    const deepSeekBeta = installDeepSeekBetaBridge(ctx, {
        observer: protocolObserver, reroute: config.reroute === true, managedLifecycle: true,
    });
    // Cordis runs disposers concurrently. This callback alone owns bridge teardown,
    // keeping it available until every tracked stream and queued write has settled.
    ctx.effect(() => async () => {
        await lifecycle.dispose(async () => {
            await store.close();
            disposeChatAdapter?.();
            deepSeekBeta.dispose();
        });
    }, 'preset-enhance: ordered teardown');
    // 0.1.7 declares agent presets through the registry; 0.1.6 materialised a mode file on
    // disk. Probe once and take whichever shape this host actually offers.
    const presetModeCapability = modeCapability(ctx);
    const presetMode = createPresetModeController(ctx, {
        description: '新对话从第一轮起自动启用预设工作台中设置的模式默认预设。',
    });
    // Startup is staged and names the failing stage together with its path. It must
    // Keep the recovery UI available even when initialization fails. A failed
    // stage degrades the plugin — the workbench still
    // mounts and reports the reason, request injection stays off, and user data is
    // never cleared as a recovery step.
    let startupError = null;
    let standard;
    try {
        standard = config.standardComposition ??
            (ctx.agentPresets?.readDocument ? (await ctx.agentPresets.readDocument('standard')).content : undefined);
    }
    catch (error) {
        startupError = describeStartupFailure('无法读取 standard 模式组成', `服务 agentPresets，模式目录 ${presetRoot}`, error);
    }
    if (!startupError) {
        if (presetModeCapability.declarative) {
            // The registry owns the mode: no directory write, and the registration is released
            // with the rest of the plugin.
            try {
                if (!presetMode.standard())
                    throw new Error(presetModeCapability.reason || 'ctx.loader 中找不到 standard 模式声明');
                const registration = await presetMode.register();
                ctx.effect(() => async () => { await registration.dispose(); }, 'preset-enhance: preset mode registration');
            }
            catch (error) {
                startupError = describeStartupFailure('无法注册预设模式', 'agentPresets.register（声明式注册）', error);
            }
        }
        else {
            try {
                await ensurePresetAgentMode(presetRoot, standard);
            }
            catch (error) {
                startupError = describeStartupFailure('无法写入预设模式目录', join(presetRoot, AGENT_PRESET_ID), error);
            }
        }
    }
    let policySnapshot = toolPolicySnapshot();
    if (!startupError) {
        try {
            policySnapshot = toolPolicySnapshot((await store.read()));
        }
        catch (error) {
            startupError = describeStartupFailure('无法读取状态文件', `${store.file}（插件不会自动清空它，请修复或移走该文件后重新启用）`, error);
        }
    }
    if (startupError) {
        // Loaded but unable to inject: the preset mode must refuse to mount with this
        // exact reason rather than silently running without any preset.
        setPresetEnhanceUnavailableReason(startupError);
        releaseAvailability();
    }
    else {
        clearPresetEnhanceUnavailableReason();
    }
    const refreshPolicies = (state) => { policySnapshot = toolPolicySnapshot(state); };
    if (!startupError)
        installToolRestrictions(ctx, () => policySnapshot, sessionModeId);
    const tools = ctx.tools;
    if (tools?.guard && !startupError) {
        const guard = tools.guard.bind(tools);
        ctx.effect(() => guard((exec) => {
            const session = exec.agent?.session;
            if (!session)
                return;
            if (effectiveToolEnabled(policySnapshot, session.id, sessionModeId(session), exec.name) !== false)
                return;
            return `工具 ${exec.name} 已在预设工作台中关闭`;
        }), 'preset-enhance: tool policy guard');
    }
    const commands = ctx.commands;
    if (commands?.register && !startupError) {
        const register = commands.register.bind(commands);
        ctx.effect(() => register(presetCommand(store)), 'preset-enhance: /preset');
    }
    async function* injectStream(options, next) {
        // A degraded startup never injects a partial preset: requests pass through untouched.
        if (startupError) {
            yield* next();
            return;
        }
        const sessionId = options.sessionId;
        const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
        if (routed.has(options) || options.purpose || !session || !sessionId) {
            yield* next();
            return;
        }
        const connectionInfo = sessionConnection(ctx, sessionId, options.provider);
        const modeId = sessionModeId(session);
        const exclusive = modeId === AGENT_PRESET_ID;
        const incoming = options.messages ?? [];
        const history = exclusive ? presetModeHistory(incoming) : incoming;
        const observed = catalogFromTools(options.tools);
        const initial = (await store.read());
        refreshPolicies(initial);
        const explicit = ownGet(initial.bindings, sessionId);
        const wantsPreset = explicit?.enabled ||
            (!explicit && shouldAutoEnable(initial, session) && defaultRecord(initial));
        const catalogChanged = observed.length > 0 && !sameCatalog(initial.toolCatalogs[modeId] ?? [], editableToolCatalog([initial.toolCatalogs, { [modeId]: observed }])[modeId]);
        let compiled = null;
        if (wantsPreset || catalogChanged) {
            compiled = await lifecycle.track(store.transaction((current) => {
                let changed = false;
                if (observed.length > 0 && syncToolCatalog(current, modeId, observed))
                    changed = true;
                let binding = ownGet(current.bindings, sessionId);
                if (!binding && shouldAutoEnable(current, session)) {
                    const record = defaultRecord(current);
                    if (record) {
                        binding = { enabled: true, presetId: record.id, characterId: null, values: {}, markers: {} };
                        assign(current.bindings, sessionId, binding);
                        changed = true;
                    }
                }
                if (changed)
                    current.revision++;
                refreshPolicies(current);
                if (!binding?.enabled)
                    return null;
                const record = current.presets.find(p => p.id === binding.presetId);
                if (!record)
                    throw new Error('当前会话启用的预设不存在');
                const presetHistory = !exclusive && !dshSystemPromptEnabled(record.preset)
                    ? presetModeHistory(history) : history;
                const postToolPrefix = current.deepseekBetaPrefix && current.postToolPrefixMode === 'custom'
                    ? current.postToolPrefixText : undefined;
                const key = digest({ compiler: PRESET_COMPILER_VERSION, messages: presetHistory, preset: record, binding, postToolPrefix, protocol: connectionProtocolFor(current, connectionInfo) });
                const prior = ownGet(current.sessions, sessionId);
                if (prior?.key === key)
                    return prior.result;
                const compiledResult = compilePreset(record.preset, presetHistory, {
                    ...binding, seed: key, local: prior?.result.local, global: current.global, postToolPrefix,
                });
                options.signal?.throwIfAborted();
                // The host serializes the request with whichever protocol its connection uses, and
                // its Messages serializer keeps only the LAST leading system snapshot
                // (protocols/messages/serialize.ts:83-95: \`historySystem = text\` overwrites). Leading
                // preset system prompts are therefore merged into one ordered message in BOTH modes:
                // it is a no-op for a chat connection and for a preset with fewer than two leading
                // system prompts, and it is the only thing that keeps every preset prompt alive when
                // the chat path is reached by rerouting an official Messages request, because that
                // collapse already happened before the fetch bridge could reroute anything.
                const adapted = adaptPresetForMessages(compiledResult.messages);
                const messagesMode = connectionProtocolFor(current, connectionInfo) === 'messages';
                const result = messagesMode ? {
                    ...compiledResult,
                    messages: adapted.messages,
                    // No prefix flag exists on the Messages wire format: never claim one.
                    assistantPrefix: { active: false },
                } : { ...compiledResult, messages: adapted.messages };
                current.global = result.global;
                assign(current.sessions, sessionId, {
                    key, at: new Date().toISOString(), presetId: record.id, result,
                    // Notes describe what the Messages wire format cannot express; they are only
                    // meaningful for the mode that targets it.
                    ...(messagesMode ? { protocolNotes: adapted.notes } : {}),
                });
                return result;
            }));
        }
        const policy = effectiveToolPolicy(policySnapshot, sessionId, modeId, options.tools);
        const filteredTools = filterTools(options.tools, policy);
        const toolsChanged = (options.tools?.length ?? 0) !== filteredTools.length;
        const messages = compiled?.messages ?? history;
        const messagesChanged = compiled !== null || messages !== options.messages;
        if (!toolsChanged && !messagesChanged) {
            yield* next();
            return;
        }
        const request = routedRequest(options, messages, filteredTools);
        // The compatibility bridge is chat-completions only: under the Messages mode it
        // must never arm, so an unadapted prefix is never sent.
        const betaPrefix = connectionProtocolFor(initial, connectionInfo) !== 'messages' &&
            initial.deepseekBetaPrefix === true && compiled?.assistantPrefix?.active === true;
        // Arm the fetch bridge only when this request actually carries an injected preset:
        // with no preset the plugin must not intervene at all (no reroute, no translation).
        // The content key arms the assistant-prefix path, so it is only the plugin's own
        // trailing prefill; an empty key can never match a real assistant message and keeps
        // the bridge to the reroute/translation role for ordinary injected requests.
        const prefixKey = betaPrefix ? messageText(messages.at(-1)) : '';
        const releaseBeta = compiled !== null ? deepSeekBeta.activate(sessionId, prefixKey, {
            mode: connectionProtocolFor(initial, connectionInfo),
            toolCalls: initial.prefixToolCalls === true,
            removeNonOfficialTools: initial.prefixNonOfficialRemoveTools !== false,
            extractOutput: initial.prefixOutputExtraction === true,
        }) : () => { };
        routed.add(request);
        try {
            yield* ctx.llm.stream(request);
        }
        finally {
            releaseBeta();
            routed.delete(request);
        }
    }
    ctx.on('llm/stream', async function* (options, next) {
        if (lifecycle.closing)
            throw new Error('插件正在停用，请稍后重试');
        let finish;
        lifecycle.track(new Promise(resolve => { finish = resolve; }));
        try {
            yield* injectStream(options, next);
        }
        finally {
            finish();
        }
    });
    const assets = new Map([
        [BASE, ['web/index.html', 'text/html']],
        [`${BASE}/editor.js`, ['web/editor.js', 'text/javascript']],
        [`${BASE}/tool-labels.js`, ['web/tool-labels.js', 'text/javascript']],
        [`${BASE}/editor.css`, ['web/editor.css', 'text/css']],
    ]);
    for (const [path, [file, mime]] of assets)
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact', path,
            handler: async (req, res) => {
                if (req.method !== 'GET')
                    return respond(res, 405, { error: 'Method not allowed' });
                res.writeHead(200, {
                    'content-type': `${mime}; charset=utf-8`,
                    'cache-control': 'no-store',
                    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'",
                });
                res.end(await readFile(new URL(file, import.meta.url)));
            },
        }), `preset-enhance: ${path}`);
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact', path: `${BASE}/api`, handler: async (req, res) => {
            if (lifecycle.closing)
                return respond(res, 503, { error: '插件正在停用，请稍后重试' });
            // Writes are refused while degraded; GET still answers so the workbench can
            // mount and show the reason.
            if (startupError && req.method !== 'GET')
                return respond(res, 503, { error: startupError });
            try {
                const url = new URL(String(req.url ?? ''), 'http://preset.local');
                if (req.method === 'GET') {
                    let state;
                    try {
                        state = (await store.read());
                    }
                    catch (error) {
                        return respond(res, 200, degradedPayload(startupError ?? describeStartupFailure('无法读取状态文件', store.file, error)));
                    }
                    refreshPolicies(state);
                    const sessionId = url.searchParams.get('sessionId') ?? '';
                    const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
                    const connectionInfo = sessionConnection(ctx, sessionId);
                    const fallback = !ownGet(state.bindings, sessionId) && shouldAutoEnable(state, session) ?
                        defaultBinding(state) : undefined;
                    const modeDefault = defaultRecord(state);
                    const modes = await agentModeRows(ctx);
                    const discovered = await discoverModeToolCatalogs(ctx, modes);
                    const liveMode = sessionModeId(session);
                    const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, sessionId);
                    return respond(res, 200, {
                        revision: state.revision,
                        startupError,
                        presets: state.presets,
                        binding: ownGet(state.bindings, sessionId) ?? fallback ?? { enabled: false },
                        selectedPresetId: state.selectedPresetId ?? modeDefault?.id ?? null,
                        postToolPrefixMode: state.postToolPrefixMode,
                        postToolPrefixText: state.postToolPrefixText,
                        deepseekBetaPrefix: state.deepseekBetaPrefix === true,
                        prefixToolCalls: state.prefixToolCalls === true,
                        prefixOutputExtraction: state.prefixOutputExtraction === true,
                        prefixNonOfficialRemoveTools: state.prefixNonOfficialRemoveTools !== false,
                        outputExtractionTemplate: OUTPUT_EXTRACTION_PROMPT_TEMPLATE,
                        modeDefaultPresetId: modeDefault?.id ?? null,
                        modeDefaultName: modeDefault?.name ?? null,
                        presetMode: liveMode === AGENT_PRESET_ID,
                        sessionMode: liveMode,
                        agentModes: modes,
                        autoEnableModes: state.autoEnableModes,
                        dshSystemPromptText: dshSystemPromptText(session?.deriveMessages?.() ?? []),
                        toolCatalogs: catalogs,
                        mcpToolGroups: mcpToolGroups(catalogs),
                        toolCatalogErrors: discovered.errors,
                        modeToolPolicies: state.modeToolPolicies,
                        sessionToolPolicy: sessionId ? ownGet(state.sessionToolPolicies, sessionId) ?? null : null,
                        toolGroups: state.toolGroups,
                        toolPresets: state.toolPresets,
                        modeToolSelections: state.modeToolSelections,
                        sessionToolSelection: sessionId ? ownGet(state.sessionToolSelections, sessionId) ?? null : null,
                        toolPresetRefCounts: presetReferenceCounts(state),
                        unresolvedToolRefs: unresolvedToolRefs(state, catalogs),
                        last: ownGet(state.sessions, sessionId) ?? null,
                        // Null until a request has actually been observed for THIS session; without a
                        // session id the panel has nothing to report and must not fall back to another
                        // session's (or a session-less) observation.
                        protocol: sessionId ? protocolObserver.last(sessionId) ?? null : null,
                        protocolMode: state.protocolMode,
                        connection: connectionInfo,
                        // 0.1.7: which connection sessions are routed to, and the ones we can route to.
                        connectionChoice: connectionSelection(ctx),
                        protocolNotes: ownGet(state.sessions, sessionId)?.protocolNotes ?? [],
                        protocolSwitched: Boolean(sessionId && protocolObserver.last(sessionId)?.switchedFrom),
                        protocolMismatch: presetProtocolMismatch(state, sessionId, session, protocolObserver, connectionInfo),
                    });
                }
                if (req.method !== 'POST')
                    return respond(res, 405, { error: 'Method not allowed' });
                if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
                    throw new Error('需要 application/json');
                if (req.headers.origin && new URL(String(req.headers.origin)).host !== req.headers.host)
                    throw new Error('拒绝跨来源写入');
                const body = await readJson(req);
                if (body.action === 'preview') {
                    return respond(res, 200, compilePreset(body.preset, previewHistory(ctx, body), {
                        ...body.options, seed: 'preview',
                    }));
                }
                if (body.action === 'export-package') {
                    const state = (await store.read());
                    if (body.revision !== state.revision)
                        throw new Error('预设已被其他窗口更新，请重新加载后再导出');
                    const record = state.presets.find(preset => preset.id === body.id);
                    const requested = typeof body.toolPresetId === 'string' ? body.toolPresetId : '';
                    const toolPresetId = requested && state.toolPresets.some(preset => preset.id === requested) ? requested : null;
                    const tools = toolPresetId ? exportToolsSection(state, toolPresetId) : record?.sharePackage?.tools;
                    return respond(res, 200, encodePresetPackage({
                        ...record, name: String(body.name || record?.name || '未命名预设').slice(0, 200),
                        preset: body.preset ?? record?.preset,
                    }, state, tools));
                }
                const needsModes = MODE_ACTIONS.has(body.action);
                const modeRows = needsModes ? await agentModeRows(ctx) : [];
                const knownModes = new Set(modeRows.map(mode => mode.id));
                const discovered = CATALOG_ACTIONS.has(body.action) ?
                    await discoverModeToolCatalogs(ctx, modeRows) : { catalogs: {}, errors: {} };
                if (body.action === 'select-connection') {
                    const provider = body.provider;
                    if (typeof provider !== 'string' || !provider)
                        throw new Error('缺少连接标识');
                    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
                    const choice = await selectConnection(ctx, provider, model);
                    return respond(res, 200, { connectionChoice: choice });
                }
                if (body.action === 'save-connection-protocol') {
                    const protocol = body.protocol;
                    if (protocol !== 'chat-completions' && protocol !== 'messages')
                        throw new Error('连接协议无效');
                    // Re-read right before writing so the merge carries a fresh settings revision.
                    const connectionSessionId = url.searchParams.get('sessionId') ?? '';
                    const info = sessionConnection(ctx, connectionSessionId);
                    if (!info)
                        throw new Error('当前 DSH 未暴露可配置的连接，无法切换协议');
                    if (info.source !== 'settings')
                        throw new Error('当前 DSH 未提供设置服务，无法切换连接协议');
                    await writeConnectionProtocol(ctx, info, protocol);
                    const connectionInfo = sessionConnection(ctx, connectionSessionId);
                    return respond(res, 200, { connection: connectionInfo });
                }
                if (body.action === 'save-tool-groups') {
                    const state = (await store.read());
                    const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
                    const groups = normalizeToolGroups(body.groups, { catalogs, existing: state.toolGroups });
                    const warnings = unresolvedWarnings(unresolvedToolRefs({ toolGroups: groups }, catalogs));
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        current.toolGroups = groups;
                        current.revision++;
                        refreshPolicies(current);
                        return { revision: current.revision, groups: current.toolGroups, warnings };
                    }));
                }
                if (body.action === 'save-tool-preset') {
                    if (!isRecord(body.preset))
                        throw new Error('工具预设必须是对象');
                    const state = (await store.read());
                    const requestedId = typeof body.id === 'string' && body.id ? body.id
                        : typeof body.preset.id === 'string' && body.preset.id ? body.preset.id : null;
                    const existing = requestedId ? state.toolPresets.find(preset => preset.id === requestedId) : undefined;
                    if (!existing && state.toolPresets.length >= TOOL_PRESET_LIMIT) {
                        throw new Error(`工具预设最多 ${TOOL_PRESET_LIMIT} 个`);
                    }
                    const preset = normalizeToolPreset({ ...body.preset, id: existing ? requestedId : null });
                    assertPresetGroupIds(preset, state.toolGroups);
                    const record = { ...preset, id: existing && requestedId ? requestedId : randomUUID() };
                    const warnings = unresolvedWarnings(unresolvedToolRefs({ toolPresets: [record] }, requestToolCatalogs(ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '')));
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        const index = current.toolPresets.findIndex(item => item.id === record.id);
                        if (index >= 0)
                            current.toolPresets[index] = record;
                        else
                            current.toolPresets.push(record);
                        current.revision++;
                        refreshPolicies(current);
                        return { id: record.id, warnings };
                    }));
                }
                if (body.action === 'delete-tool-preset') {
                    const state = (await store.read());
                    if (!state.toolPresets.some(preset => preset.id === body.id))
                        throw new Error('请选择要删除的工具预设');
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        const index = current.toolPresets.findIndex(preset => preset.id === body.id);
                        if (index < 0)
                            throw new Error('请选择要删除的工具预设');
                        current.toolPresets.splice(index, 1);
                        const { modes, sessions } = resetPresetSelections(current, body.id);
                        current.revision++;
                        refreshPolicies(current);
                        return { id: body.id, modes, sessions };
                    }));
                }
                if (body.action === 'select-tool-policy') {
                    const state = (await store.read());
                    let key;
                    let id;
                    let selection;
                    if (body.scope === 'mode') {
                        if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId))
                            throw new Error('请选择有效的 DSH 模式');
                        key = 'modeToolSelections';
                        id = body.modeId;
                        selection = normalizeToolSelection(body.selection, 'mode');
                    }
                    else if (body.scope === 'session') {
                        const session = typeof body.sessionId === 'string' ? ctx.sessions.get(body.sessionId) : undefined;
                        if (!session)
                            throw new Error('缺少有效的会话 ID');
                        key = 'sessionToolSelections';
                        id = body.sessionId;
                        selection = normalizeToolSelection(body.selection, 'session');
                    }
                    else {
                        throw new Error('未知的工具策略范围');
                    }
                    if (selection.kind === 'preset' &&
                        !state.toolPresets.some(preset => preset.id === selection.presetId)) {
                        throw new Error('请选择有效的工具预设');
                    }
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        assign(current[key], id, selection);
                        current.revision++;
                        refreshPolicies(current);
                        return { selection };
                    }));
                }
                if (body.action === 'save-mode-tools') {
                    if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId))
                        throw new Error('请选择有效的 DSH 模式');
                    const state = (await store.read());
                    const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
                    const policy = validateToolPolicy(body.policy, catalogs[body.modeId]);
                    const selection = { kind: 'custom' };
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        assign(current.modeToolPolicies, body.modeId, policy);
                        assign(current.modeToolSelections, body.modeId, selection);
                        current.revision++;
                        refreshPolicies(current);
                        return { modeId: body.modeId, selection, revision: current.revision };
                    }));
                }
                if (body.action === 'save-session-tools') {
                    const session = typeof body.sessionId === 'string' ? ctx.sessions.get(body.sessionId) : undefined;
                    if (!session)
                        throw new Error('缺少有效的会话 ID');
                    const modeId = sessionModeId(session);
                    if (!knownModes.has(modeId))
                        throw new Error('当前会话没有可识别的 DSH 模式');
                    const inherit = body.inherit === true;
                    const state = (await store.read());
                    const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, body.sessionId);
                    const policy = inherit ? null : validateToolPolicy(body.policy, catalogs[modeId]);
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        if (inherit) {
                            delete current.sessionToolPolicies[body.sessionId];
                            delete current.sessionToolSelections[body.sessionId];
                        }
                        else {
                            assign(current.sessionToolPolicies, body.sessionId, policy);
                            assign(current.sessionToolSelections, body.sessionId, { kind: 'custom' });
                        }
                        current.revision++;
                        refreshPolicies(current);
                        return { inherited: inherit, revision: current.revision };
                    }));
                }
                if (body.action === 'import-package-tools') {
                    const state = (await store.read());
                    const record = state.presets.find(preset => preset.id === body.id);
                    if (!record)
                        throw new Error('请选择带有工具配置的预设包');
                    if (!record.sharePackage?.tools)
                        throw new Error('该预设包不包含工具配置');
                    const plan = remapToolPackage(record.sharePackage.tools, state, {
                        catalogs: requestToolCatalogs(ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? ''),
                    });
                    if (body.dryRun === true) {
                        return respond(res, 200, {
                            applied: false, stats: plan.stats, groups: plan.tools.groups, presets: plan.tools.presets,
                        });
                    }
                    return respond(res, 200, await store.transaction((current) => {
                        assertRevision(current, body);
                        current.toolGroups.push(...plan.tools.groups);
                        current.toolPresets.push(...plan.tools.presets);
                        current.revision++;
                        refreshPolicies(current);
                        return { applied: true, stats: plan.stats, groups: plan.tools.groups, presets: plan.tools.presets };
                    }));
                }
                const result = await store.transaction((state) => {
                    assertRevision(state, body);
                    if (body.action === 'save' || body.action === 'import') {
                        const imported = body.action === 'import' ? decodePresetDocument(body.document, String(body.name || '未命名预设')) : null;
                        validatePreset(imported?.preset ?? body.preset);
                        const old = body.action === 'save' ? state.presets.find(p => p.id === body.id) : undefined;
                        const record = {
                            ...old,
                            ...imported,
                            id: old?.id ?? randomUUID(),
                            name: String(imported?.name || body.name || '未命名预设').slice(0, 200),
                            preset: imported?.preset ?? body.preset,
                        };
                        if (old)
                            state.presets[state.presets.indexOf(old)] = record;
                        else
                            state.presets.push(record);
                        state.selectedPresetId = record.id;
                        state.defaultPresetId = record.id;
                        state.revision++;
                        return { id: record.id };
                    }
                    if (body.action === 'delete-preset') {
                        const index = state.presets.findIndex(preset => preset.id === body.id);
                        if (index < 0)
                            throw new Error('请选择要删除的已保存预设');
                        const [removed] = state.presets.splice(index, 1);
                        const fallback = state.presets.find(preset => preset.id === state.selectedPresetId) ??
                            state.presets.find(preset => preset.id === state.defaultPresetId) ??
                            state.presets[index] ?? state.presets[index - 1] ?? state.presets[0];
                        if (state.selectedPresetId === removed.id)
                            state.selectedPresetId = fallback?.id ?? null;
                        if (state.defaultPresetId === removed.id)
                            state.defaultPresetId = fallback?.id ?? null;
                        for (const [sessionId, binding] of Object.entries(state.bindings)) {
                            if (binding?.presetId !== removed.id)
                                continue;
                            assign(state.bindings, sessionId, {
                                ...binding,
                                enabled: !!fallback && binding.enabled === true,
                                presetId: fallback?.id ?? '',
                                characterId: null,
                            });
                        }
                        for (const [sessionId, cached] of Object.entries(state.sessions)) {
                            if (cached?.presetId === removed.id)
                                delete state.sessions[sessionId];
                        }
                        state.revision++;
                        return { id: fallback?.id ?? null };
                    }
                    if (body.action === 'set-default') {
                        const record = state.presets.find(p => p.id === body.id);
                        if (!record)
                            throw new Error('请先保存并选择预设');
                        state.selectedPresetId = record.id;
                        state.defaultPresetId = record.id;
                        state.revision++;
                        return { id: record.id };
                    }
                    if (body.action === 'select-preset') {
                        const record = state.presets.find(p => p.id === body.id);
                        if (!record)
                            throw new Error('请选择有效的预设');
                        state.selectedPresetId = record.id;
                        state.defaultPresetId = record.id;
                        state.revision++;
                        return { id: record.id };
                    }
                    if (body.action === 'apply-package-prefill') {
                        const record = state.presets.find(preset => preset.id === body.id);
                        if (!record?.sharePackage)
                            throw new Error('请选择带有接口设置的预设包');
                        applyPackagePrefill(state, record);
                        state.revision++;
                        return { id: record.id };
                    }
                    if (body.action === 'save-deepseek-beta') {
                        if (typeof body.enabled !== 'boolean')
                            throw new Error('预填充接口开关值无效');
                        if (body.toolCalls !== undefined) {
                            if (typeof body.toolCalls !== 'boolean')
                                throw new Error('工具调用处理开关值无效');
                            state.prefixToolCalls = body.toolCalls;
                        }
                        if (body.extractOutput !== undefined) {
                            if (typeof body.extractOutput !== 'boolean')
                                throw new Error('正文/工具调用提取开关值无效');
                            state.prefixOutputExtraction = body.extractOutput;
                        }
                        if (body.removeNonOfficialTools !== undefined) {
                            if (typeof body.removeNonOfficialTools !== 'boolean')
                                throw new Error('非官方接口工具移除开关值无效');
                            state.prefixNonOfficialRemoveTools = body.removeNonOfficialTools;
                        }
                        if (body.postToolPrefixMode !== undefined) {
                            if (!['inherit', 'custom'].includes(body.postToolPrefixMode))
                                throw new Error('工具调用后预填充模式无效');
                            state.postToolPrefixMode = body.postToolPrefixMode;
                        }
                        if (body.postToolPrefixText !== undefined) {
                            if (typeof body.postToolPrefixText !== 'string')
                                throw new Error('工具调用后预填充必须为文本');
                            state.postToolPrefixText = body.postToolPrefixText;
                        }
                        state.deepseekBetaPrefix = body.enabled;
                        if (body.presetId) {
                            const record = state.presets.find(preset => preset.id === body.presetId);
                            if (!record)
                                throw new Error('请选择有效的已保存预设');
                            attachPrefillSettings(record, state);
                        }
                        state.revision++;
                        return {
                            revision: state.revision,
                            enabled: state.deepseekBetaPrefix,
                            toolCalls: state.prefixToolCalls === true,
                            extractOutput: state.prefixOutputExtraction === true,
                            removeNonOfficialTools: state.prefixNonOfficialRemoveTools !== false,
                        };
                    }
                    if (body.action === 'save-protocol-mode') {
                        const mode = body.mode;
                        if (mode !== 'chat-completions' && mode !== 'messages')
                            throw new Error('协议模式无效');
                        state.protocolMode = mode;
                        state.revision++;
                        return { mode };
                    }
                    if (body.action === 'save-auto-modes') {
                        if (!Array.isArray(body.modes) || body.modes.some(id => typeof id !== 'string' || !knownModes.has(id))) {
                            throw new Error('自动启用模式列表包含未知模式');
                        }
                        const previous = new Set(state.autoEnableModes);
                        const selected = [...new Set([AGENT_PRESET_ID, ...body.modes])];
                        const now = Date.now();
                        for (const id of selected)
                            if (!previous.has(id))
                                state.autoEnableSince[id] = now;
                        for (const id of Object.keys(state.autoEnableSince))
                            if (!selected.includes(id))
                                delete state.autoEnableSince[id];
                        state.autoEnableSince[AGENT_PRESET_ID] = 0;
                        state.autoEnableModes = selected;
                        state.revision++;
                        return { revision: state.revision, modes: selected };
                    }
                    if (body.action === 'bind') {
                        validateBinding(state, body);
                        state.revision++;
                        return { revision: state.revision, ok: true };
                    }
                    throw new Error('未知操作');
                });
                respond(res, 200, result);
            }
            catch (error) {
                respond(res, 400, { error: error instanceof Error ? error.message : String(error) });
            }
        },
    }), 'preset-enhance: API');
}
function messageText(message) {
    return message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
}
function validateBinding(state, body) {
    if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200) {
        throw new Error('缺少有效的会话 ID');
    }
    const record = state.presets.find(p => p.id === body.binding?.presetId);
    if (body.binding?.enabled && !record)
        throw new Error('请先保存并选择预设');
    if (record)
        getOrder(record.preset, body.binding.characterId);
    const values = body.binding?.values ?? {};
    const markers = body.binding?.markers ?? {};
    for (const map of [values, markers]) {
        if (!isRecord(map) || Object.values(map).some(value => typeof value !== 'string')) {
            throw new Error('角色变量和标记内容必须是文本映射');
        }
    }
    assign(state.bindings, body.sessionId, {
        enabled: body.binding.enabled === true,
        presetId: record?.id ?? '',
        characterId: body.binding.characterId ?? null,
        values,
        markers,
    });
}
function presetCommand(store) {
    return {
        name: 'preset',
        description: '切换当前会话的预设注入（/preset [on|off|status]）',
        input: { hint: '[on|off|status]' },
        handler: async (invocation) => {
            const input = String(invocation.rawInput ?? '').trim().toLowerCase();
            if (!['', 'on', 'off', 'status'].includes(input)) {
                return { kind: 'error', text: '用法：/preset [on|off|status]' };
            }
            const session = invocation.agent.session;
            const sessionKey = session.id ?? '';
            const before = (await store.read());
            const explicit = ownGet(before.bindings, sessionKey);
            const enabled = explicit?.enabled ?? (shouldAutoEnable(before, session) && !!defaultRecord(before));
            if (input === 'status') {
                const record = explicit?.presetId ? before.presets.find(p => p.id === explicit.presetId) : defaultRecord(before);
                return { kind: 'success', text: `预设注入：${enabled ? '已开启' : '已关闭'}${record ? `（${record.name}）` : ''}` };
            }
            const target = input === 'on' ? true : input === 'off' ? false : !enabled;
            return await store.transaction((state) => {
                const current = ownGet(state.bindings, sessionKey);
                const record = current?.presetId ? state.presets.find(p => p.id === current.presetId) : defaultRecord(state);
                if (target && !record)
                    return { kind: 'error', text: '尚未保存模式默认预设，请先在预设工作台中设置。' };
                assign(state.bindings, sessionKey, {
                    enabled: target,
                    presetId: record?.id ?? '',
                    characterId: current?.characterId ?? null,
                    values: current?.values ?? {},
                    markers: current?.markers ?? {},
                });
                state.revision++;
                return { kind: 'success', text: `预设注入已${target ? '开启' : '关闭'}${record ? `：${record.name}` : ''}` };
            });
        },
    };
}
/**
 * Explain the one case where the selected protocol mode cannot be honoured.
 *
 * Chat mode asks the fetch bridge to switch an official Messages request to
 * chat/completions. If that cannot happen (the endpoint is not the official one,
 * or nothing has been observed yet) the compatibility path silently does not
 * apply, which the user has to see. A request the plugin never armed for — no
 * preset injected — is reported as null: the plugin intervenes not at all.
 */
function presetProtocolMismatch(state, sessionId, session, observer, connection) {
    if (connectionProtocolFor(state, connection) === 'messages')
        return null;
    const binding = ownGet(state.bindings, sessionId);
    const enabled = binding?.enabled ??
        (session ? shouldAutoEnable(state, session) && !!defaultRecord(state) : false);
    if (!enabled)
        return null;
    const observed = observer.last(sessionId);
    if (!observed)
        return null;
    if (observed.protocol === 'messages' && !observed.switchedFrom) {
        return '当前连接使用 Messages 协议：预填充续写、工具调用转换与正文提取不会生效，插件也不会改写该请求。'
            + '可在工作台的「Assistant 预填充接口」里把这个连接的协议切换为对话补全接口，保存后立即生效。';
    }
    return null;
}
/**
 * Protocol this request will really travel over.
 *
 * The host connection's own setting wins because that is what serializes the request;
 * the plugin-local preference is only a fallback for a host that does not expose it.
 */
function connectionProtocolFor(state, connection) {
    if (connection?.protocol === 'messages' || connection?.protocol === 'chat-completions') {
        return connection.protocol;
    }
    return state.protocolMode === 'messages' ? 'messages' : 'chat-completions';
}
const DEFAULT_CHAT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
/**
 * Collect the retained image references of one request and resolve each through the
 * host attachment service, at the size target this model route asks for. Offloaded
 * occurrences stay placeholders and are neither read nor uploaded.
 */
async function buildRequestImages(ctx, connection, options, signal) {
    const prepared = new Map();
    const attachments = ctx.get?.('attachments');
    if (typeof attachments?.readImageRequest !== 'function')
        return prepared;
    const routes = connection().models ?? [];
    const route = routes.find(item => item.id === options.model) ?? routes[0];
    if (route === undefined)
        return prepared;
    const refs = new Map();
    for (const message of options.messages ?? []) {
        for (const block of (message.content ?? [])) {
            if (block?.type !== 'image' || block.offloaded === true)
                continue;
            const ref = block.attachment;
            if (typeof ref?.attachmentId === 'string' && ref.attachmentId)
                refs.set(ref.attachmentId, ref);
        }
    }
    for (const ref of refs.values()) {
        const target = resolveRequestImageTarget(route, ref);
        prepared.set(ref.attachmentId, await attachments.readImageRequest(ref, target, signal));
    }
    return prepared;
}
/** Read-only handle text for one image reference, so the wire shows a real path when the host has one. */
function imageAccessOf(ctx, ref) {
    const attachments = ctx.get?.('attachments');
    const hostPath = attachments?.imageHostPath?.(ref);
    if (hostPath === undefined)
        return undefined;
    const world = ctx.get?.('fs')
        ?.processPathFromHostPath?.(hostPath);
    return world === undefined ? undefined : { readonlyPath: world };
}
/**
 * Resolve the bundled Chat provider's key for one request: the host credentials
 * service first (by reference), then the launching environment. Never cached, and
 * never written into the preset store or an exported package.
 */
async function resolveChatApiKey(ctx, ref) {
    const service = ctx.get?.('credentials');
    const hit = await service?.resolve?.(ref).catch(() => undefined);
    const fromStore = hit && typeof hit.value === 'string' ? hit.value : '';
    const key = fromStore.trim() || String(process.env[ref] ?? '').trim();
    if (!key)
        throw new Error(`预设增强：连接缺少 API Key（引用 ${ref}）`);
    return key;
}
function defaultRecord(state) {
    return state.presets.find(p => p.id === state.selectedPresetId) ??
        state.presets.find(p => p.id === state.defaultPresetId) ?? state.presets[0];
}
function defaultBinding(state) {
    const record = defaultRecord(state);
    return record ? {
        enabled: true,
        presetId: record.id,
        characterId: null,
        values: {},
        markers: {},
        inherited: true,
    } : undefined;
}
function sessionModeId(session) {
    if (!session)
        return '';
    let selected = session.header?.agentPreset ?? '';
    for (const event of session.snapshotEvents?.() ?? []) {
        if (event.type === 'agent-preset/selected')
            selected = event.data?.agentPreset ?? '';
    }
    return selected;
}
function shouldAutoEnable(state, session) {
    if (!session)
        return false;
    const modeId = sessionModeId(session);
    if (!state.autoEnableModes.includes(modeId))
        return false;
    const since = Number(state.autoEnableSince[modeId] ?? 0);
    const createdAt = Number(session.header?.createdAt ?? Number.POSITIVE_INFINITY);
    return createdAt >= since;
}
function presetModeHistory(messages) {
    return messages.filter(message => message.role !== 'system' &&
        !(message.source?.kind === 'plugin' && message.source.plugin === DSH_SYSTEM_PROMPT));
}
function dshSystemPromptText(messages) {
    return messages.filter(message => message.role === 'system')
        .map(messageText).filter(Boolean).join('\n\n');
}
/** Live catalogs plus the last catalog seen for each mode, so a removed plugin is not silently forgotten. */
function knownToolCatalogs(state, discovered) {
    return editableToolCatalog([state?.toolCatalogs, discovered]);
}
/** Match GET's catalog view for writes opened from a live conversation. */
function requestToolCatalogs(ctx, state, discovered, sessionId) {
    const catalogs = knownToolCatalogs(state, discovered);
    const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
    const modeId = sessionModeId(session);
    const live = liveToolCatalog(ctx, sessionId);
    if (live.length > 0 && modeId) {
        // The union keeps rows a restricted or dynamic catalog no longer reports (the editor must
        // stay able to switch them back on), and the sort keeps the workbench ordering stable.
        const merged = editableToolCatalog([catalogs, { [modeId]: live }])[modeId] ?? [];
        assign(catalogs, modeId, [...merged].sort((a, b) => a.name.localeCompare(b.name)));
    }
    return catalogs;
}
/** Group DSH MCP public tool names by their stable server namespace. */
export function mcpToolGroups(catalogs) {
    const result = {};
    for (const [modeId, catalog] of Object.entries(catalogs ?? {})) {
        if (!Array.isArray(catalog))
            continue;
        const servers = new Map();
        for (const tool of catalog) {
            const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(String(tool?.name ?? ''));
            if (!match)
                continue;
            const serverName = match[1];
            const tools = servers.get(serverName) ?? [];
            tools.push(tool.name);
            servers.set(serverName, tools);
        }
        const groups = [...servers].sort(([left], [right]) => left.localeCompare(right))
            .map(([serverName, tools]) => ({ serverName, tools: [...new Set(tools)].sort() }));
        if (groups.length > 0)
            assign(result, modeId, groups);
    }
    return result;
}
function unresolvedWarnings(refs) {
    return refs.length > 0
        ? [`${refs.length} 条工具引用在当前模式目录中不存在，已保留待插件恢复后重新匹配`]
        : [];
}
function assertRevision(state, body) {
    if (body.revision !== state.revision)
        throw new Error('预设已被其他窗口更新，请重新加载后再保存');
}
function validateToolPolicy(value, catalog) {
    if (!isRecord(value))
        throw new Error('工具开关必须是对象');
    if (!Array.isArray(catalog))
        throw new Error('无法读取该模式的工具目录');
    const allowed = new Set(catalog.map(tool => tool.name));
    const policy = {};
    for (const [tool, enabled] of Object.entries(value)) {
        if (typeof enabled !== 'boolean')
            throw new Error('工具开关值必须是布尔值');
        if (!allowed.has(tool))
            throw new Error('工具不属于当前模式或已被移除');
        assign(policy, tool, enabled);
    }
    return policy;
}
function catalogFromTools(tools) {
    if (!Array.isArray(tools))
        return [];
    return tools.map(tool => ({
        name: String(tool.name),
        description: String(tool.description ?? '').slice(0, 500),
    })).filter(tool => tool.name.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}
function sameCatalog(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function syncToolCatalog(state, modeId, observed) {
    if (!modeId)
        return false;
    const merged = editableToolCatalog([state.toolCatalogs, { [modeId]: observed }])[modeId];
    if (sameCatalog(state.toolCatalogs[modeId] ?? [], merged))
        return false;
    assign(state.toolCatalogs, modeId, merged);
    return true;
}
function filterTools(tools, policy) {
    return Array.isArray(tools) ? tools.filter(tool => policy[tool.name] !== false) : [];
}
function routedRequest(options, messages, tools) {
    const { tools: _tools, ...request } = options;
    return Object.freeze({ ...request, messages, ...(tools.length > 0 ? { tools } : {}) });
}
export async function discoverModeToolCatalogs(ctx, modes) {
    const catalogs = {};
    const errors = {};
    for (const mode of modes) {
        if (mode.broken) {
            assign(errors, mode.id, String(mode.broken));
            continue;
        }
        try {
            if (!ctx.tools?.schemas)
                throw new Error('当前 DSH 未提供模式工具枚举服务');
            if (ctx.agentPresets?.acquireScope) {
                // 0.1.7: lease the mode's scope, read it, release it again.
                const leased = await readModeToolCatalog(ctx, mode.id);
                assign(catalogs, mode.id, catalogFromTools(leased.tools));
            }
            else if (ctx.agentPresets?.standingKeyFor) {
                // 0.1.6: a standing key the host keeps alive for the process.
                const scope = await ctx.agentPresets.standingKeyFor(mode.id);
                assign(catalogs, mode.id, catalogFromTools(ctx.tools.schemas(scope)));
            }
            else {
                throw new Error('当前 DSH 未提供模式工具枚举服务');
            }
        }
        catch (error) {
            assign(errors, mode.id, error instanceof Error ? error.message : String(error));
        }
    }
    return { catalogs, errors };
}
function liveToolCatalog(ctx, sessionId) {
    if (!sessionId)
        return [];
    try {
        const agent = ctx.agents?.get?.(sessionId);
        return agent?.ctx?.tools?.schemas ? catalogFromTools(agent.ctx.tools.schemas(agent)) : [];
    }
    catch {
        return [];
    }
}
async function agentModeRows(ctx) {
    if (!ctx.agentPresets?.list)
        return [{ id: AGENT_PRESET_ID, name: '预设模式' }];
    return (await ctx.agentPresets.list()).map(mode => ({
        id: mode.id,
        name: mode.name ?? mode.id,
        description: mode.description ?? '',
        trust: mode.trust,
        broken: mode.broken ?? null,
    }));
}
export function buildPresetModeComposition(standard) {
    const persona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: ''
    complete: true
    includeRuntimeContext: false

`;
    const pattern = /^- id: persona\r?\n[\s\S]*?(?=^- id: )/m;
    if (!pattern.test(standard))
        throw new Error('standard 模式组成中找不到 persona 条目');
    const transformed = standard.replace(pattern, persona).trimEnd();
    if (transformed.includes('dsh-preset-enhance/mode'))
        return `${transformed}\n`;
    return `${transformed}

- id: preset-enhance-mode
  name: dsh-preset-enhance/mode
`;
}
/**
 * Materialise the dedicated preset mode next to the user's other modes.
 *
 * Both files are managed, but they are only rewritten when their bytes actually
 * change: the host derives a new standing generation from the directory's
 * mtime+size, and generations from earlier activations are not reclaimed yet, so
 * rewriting identical content on every apply would leak one generation per
 * enable. Changed content is replaced atomically through a temp file + rename so
 * a half-written composition can never be enumerated. Files the user placed in
 * the directory are never touched.
 */
export async function ensurePresetAgentMode(root, standard) {
    const destination = join(root, AGENT_PRESET_ID);
    await mkdir(destination, { recursive: true });
    const composition = standard ? buildPresetModeComposition(standard) :
        await readFile(new URL('agent-mode/agent.cordis.yml', import.meta.url), 'utf8');
    const template = await readFile(new URL('agent-mode/preset.yml', import.meta.url));
    await writeManagedFile(join(destination, 'preset.yml'), template);
    await writeManagedFile(join(destination, 'agent.cordis.yml'), composition);
    return destination;
}
function previewHistory(ctx, body) {
    const session = ctx.sessions.get(body.sessionId);
    const derived = session?.deriveMessages?.() ?? [];
    const exclusive = sessionModeId(session) === AGENT_PRESET_ID;
    const history = exclusive || !dshSystemPromptEnabled(body.preset) ? presetModeHistory(derived) : derived;
    return body.input ? [...history, {
            id: 'preview-user',
            role: 'user',
            content: [{ type: 'text', text: String(body.input) }],
            source: { kind: 'user' },
        }] : history;
}
async function readJson(req) {
    const parts = [];
    let size = 0;
    for await (const part of req) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > 8_000_000)
            throw new Error('预设文件不能超过 8 MB');
        parts.push(bytes);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function respond(res, status, value) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
}
