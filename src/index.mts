import { readDshSystemTemplate, withoutDshPrompt } from './lib/dsh-system-template.mjs';
import { readRequestSettings } from './lib/request-settings.mjs';
import { createPresetReader, PRESET_READ_BASE } from './lib/preset-reader.mjs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
export { Config } from './lib/plugin-config.mjs';
import { createChatModelCatalog } from './lib/chat-models.mjs';
import { PresetStore } from './lib/store.mjs';
import { createTemplateRegistry } from './lib/template-registry.mjs';
import { resolveTemplateBindings, selectTemplate, templateCatalogWithFingerprints, templateBindings } from './lib/template-bindings.mjs';
import { prepareDynamicTemplates } from './lib/dynamic-templates.mjs';
import { RequestSnapshots, traceRequest, previewMessages, messageOrigins } from './lib/request-preview.mjs';
import { PRESET_TEMPLATES_SERVICE } from './templates.mjs';
import { compilePreset, validatePreset, getOrder, dshSystemPromptEnabled } from './lib/preset.mjs';
import { decodePresetDocument, encodePresetPackage, attachPrefillSettings, applyPackagePrefill } from './lib/preset-package.mjs';
import {
  deleteLibraryEntry, presetLocks, restoreDefaultTemplates, saveLibraryEntry, setPresetLock,
  summarizeSPreset, syncSPresetMirror,
} from './lib/s-preset-library.mjs';
import { installDeepSeekBetaBridge, rewriteDeepSeekPrefixFetch } from './lib/deepseek-beta.mjs';
import { createProtocolObserver } from './lib/protocol.mjs';
import { connectionSelection, selectConnection, sessionConnection, writeConnectionProtocol } from './lib/connection.mjs';
import type { ConnectionProtocol, ConnectionProtocolInfo } from './lib/connection.mjs';
import { installToolRestrictions } from './lib/tool-restrictions.mjs';
import { disposeRegexRunner, getRegexRunner } from './lib/regex-runner.mjs';
import { createPresetModeController, modeCapability, readModeToolCatalog } from './lib/modes.mjs';
import {
  attributionHeaders, createDeepSeekChatAdapter, DEEPSEEK_CHAT_PROVIDER_ID, DeepSeekFileStore,
  deepSeekFilesIndexPath, resolveChatConnection, resolveRequestImageTarget,
  serializeRequest,
} from './vendor/deepseek-chat/index.mjs';
import type { LlmErrorFactory, RequestImageAttachment } from './vendor/deepseek-chat/index.mjs';
import { adaptPresetForMessages } from './lib/messages.mjs';
import { applyPromptRegex, planRegexScript, PREFILL_DEPTH, readPromptRegexOptions, readRegexScripts, regexName } from './lib/prompt-regex.mjs';
import { createMacroContext, seededRandom } from './lib/macros.mjs';
import {
  clearPresetEnhanceUnavailableReason, markPresetEnhanceActive, setPresetEnhanceUnavailableReason,
} from './lib/availability.mjs';
import { OUTPUT_EXTRACTION_PROMPT_TEMPLATE } from './lib/output-extractor.mjs';
import {
  normalizeToolGroups, normalizeToolPreset, normalizeToolSelection, assertPresetGroupIds,
  toolPolicySnapshot, effectiveToolEnabled, effectiveToolPolicy, remapToolPackage, editableToolCatalog,
  presetReferenceCounts, unresolvedToolRefs, resetPresetSelections, exportToolsSection, TOOL_PRESET_LIMIT,
} from './lib/tool-presets.mjs';
import type {
  AgentModeRow, CommandInvocation, HostMessage, HostRequest, HostResponse, PluginConfig, PluginContext,
  SessionLike, StreamOptions, ToolExecution, ToolSchemaRow,
} from './host-types.mjs';
import type {
  CompiledPreset, PresetBinding, PresetRecord, PresetState, SessionCompilation,
  PromptRegexTarget, ToolCatalogMap, ToolCatalogRow, ToolPolicy, ToolPreset, ToolPresetDraft, ToolSelection,
} from './lib/types.mjs';

export const name = 'preset-enhance';
export const inject = ['llm', 'sessions', 'webServer', 'commands', 'tools', 'agentPresets', 'agents'];
export const AGENT_PRESET_ID = 'st-preset';
const BASE = '/preset-enhance';
const DSH_SYSTEM_PROMPT = '@deepseek-ai/dsh-system-prompt';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PRESET_COMPILER_VERSION = 10;
function compilationKey(preset: unknown, messages: HostMessage[], options: Record<string, any>, protocol: string, references: unknown, dynamicBodies: unknown) {
  return digest({ compiler: PRESET_COMPILER_VERSION, preset, messages, characterId: String(options.characterId ?? 100001),
    values: { user: 'User', char: 'Assistant', ...options.values }, markers: options.markers ?? {},
    trigger: options.trigger ?? 'normal', postToolPrefix: options.postToolPrefix, protocol, references, dshSystemTemplate: options.dshSystemTemplate,
    dynamicBodies: dynamicBodies && Object.keys(dynamicBodies as object).length ? dynamicBodies : undefined });
}
const ownGet = <T,>(object: Record<string, T>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(object, key) ? object[key] : undefined;
const assign = <T,>(object: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
};
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
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
  let drained: Promise<void> | null = null;
  const inflight = new Set<Promise<unknown>>();
  return {
    get closing() { return closing; },
    /** Track an already-started unit of work so teardown can wait for it. */
    track<T>(work: Promise<T>): Promise<T> {
      if (closing) return work;
      const tracked = work.then(() => undefined, () => undefined);
      inflight.add(tracked);
      void tracked.then(() => inflight.delete(tracked));
      return work;
    },
    dispose(release: () => void | Promise<void>): Promise<void> {
      if (drained) return drained;
      closing = true;
      drained = (async () => {
        while (inflight.size > 0) await Promise.all([...inflight]);
        await release();
      })();
      return drained;
    },
  };
}

/** Managed preset files are compared before writing; the host derives its standing generation from mtime+size. */
async function writeManagedFile(file: string, content: string | Uint8Array): Promise<boolean> {
  const desired = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const existing = await readFile(file).catch(() => null);
  if (existing !== null && Buffer.compare(existing, desired) === 0) return false;
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, desired);
  await rename(temp, file);
  return true;
}

/** Compose one startup failure message that names the stage, the path and the cause. */
function describeStartupFailure(stage: string, detail: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `预设工作台初始化失败：${stage}（${detail}）：${cause}`;
}

/**
 * Minimal payload so the workbench can still mount and explain why the plugin
 * degraded instead of injecting. It deliberately carries no preset data.
 */
function degradedPayload(reason: string): Record<string, unknown> {
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

export async function apply(ctx: PluginContext, config: PluginConfig = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const store = new PresetStore(resolve(config.dataFile ?? join(home, 'preset-enhance', 'state.json')));
  const presetRoot = resolve(config.agentPresetRoot ?? join(home, '.agent-presets'));
  // Claim availability before the first await so the generated st-preset mode can
  // never be mounted against a plugin that is not actually injecting.
  const releaseAvailability = markPresetEnhanceActive();
  ctx.effect(() => () => releaseAvailability(), 'preset-enhance: mode availability');
  // Regex rules run in a worker; stopping the plugin must not leave it running.
  ctx.effect(() => () => disposeRegexRunner(), 'preset-enhance: prompt regex runner');

  const lifecycle = createPluginLifecycle();
  const routed = new WeakSet();
  const snapshots = new RequestSnapshots();
  // DSH 0.1.6 defaults the official connection to the Messages protocol, where the
  // assistant-prefix/toolcall compatibility bridge cannot apply. Observations are
  // recorded per session so the workbench can say so instead of pretending.
  const protocolObserver = createProtocolObserver();
  // 0.1.7 removed the official Chat Completions protocol and routes plain requests through
  // pi-ai, which rewrites system prompts; the plugin ships its own adapter so preset
  // ordering, the prefill bridge, DSML conversion and extraction keep a Chat wire format.
  /**
 * The public Chat root, unless the deployment points it elsewhere. This honours the same
 * $DEEPSEEK_BASE_URL the official adapter documents, so a full host request can be aimed at a
 * capture endpoint during verification; leaving it unset keeps the public API.
 */
const chatModels = createChatModelCatalog(ctx, config);
const chatConnection = () => {
  const baseURL = process.env.DEEPSEEK_BASE_URL?.trim();
  return resolveChatConnection({ ...(baseURL ? { baseURL } : {}), models: chatModels.models() });
};
  // The upload cache is owner-private and lives next to the plugin's own state file; the
  // index is keyed by a hash of the endpoint and key, so no credential reaches disk.
  const chatFiles = new DeepSeekFileStore({ indexPath: deepSeekFilesIndexPath(store.file) });
  const chatErrorFactory = await resolveHostErrorFactory();
  const chatAttribution = await resolveHostAttribution();
  const chatAdapter = createDeepSeekChatAdapter({
    connection: chatConnection,
    refreshModels: chatModels.refresh,
    resolveFiles: () => chatFiles,
    ...(chatErrorFactory ? { createError: chatErrorFactory } : {}),
    ...(chatAttribution ? { attributionHeaders: chatAttribution } : {}),
    resolveApiKey: async () => resolveChatApiKey(ctx, config.chatApiKeyEnv ?? DEFAULT_CHAT_API_KEY_ENV),
    resolveUserId: () => 'preset-enhance',
    // Images keep going through the host's attachment service: we only turn the
    // retained references into the bytes the provider request needs.
    resolveRequestImages: async (options, signal) => buildRequestImages(ctx, chatConnection, options, signal),
    resolveImageAccess: ref => imageAccessOf(ctx, ref),
  });
  const disposeChatAdapter = ctx.llm?.registerAdapter?.([DEEPSEEK_CHAT_PROVIDER_ID], chatAdapter as unknown as never);

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
      snapshots.close();
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
  let startupError: string | null = null;
  let standard: string | undefined;
  if (!presetModeCapability.declarative) {
    // 0.1.6 only. A 0.1.7 host registers declarations instead of scanning a directory, and
    // 0.1.7-rc.1 re-added a readDocument with a different shape that REJECTS an unknown preset -
    // calling it there made activation depend on composition order, and its result is unused on
    // a declarative host anyway.
    try {
      standard = config.standardComposition ??
        (ctx.agentPresets?.readDocument ? (await ctx.agentPresets.readDocument('standard')).content : undefined);
    } catch (error) {
      startupError = describeStartupFailure('无法读取 standard 模式组成', `服务 agentPresets，模式目录 ${presetRoot}`, error);
    }
  }
  if (!startupError) {
    if (presetModeCapability.declarative) {
      // The registry owns the mode: no directory write, and the registration is released
      // with the rest of the plugin.
      try {
        if (!presetMode.standard()) throw new Error(presetModeCapability.reason || 'ctx.loader 中找不到 standard 模式声明');
        const registration = await presetMode.register();
        ctx.effect(() => async () => { await registration.dispose(); }, 'preset-enhance: preset mode registration');
      } catch (error) {
        startupError = describeStartupFailure('无法注册预设模式', 'agentPresets.register（声明式注册）', error);
      }
    } else {
      try {
        await ensurePresetAgentMode(presetRoot, standard);
      } catch (error) {
        startupError = describeStartupFailure('无法写入预设模式目录', join(presetRoot, AGENT_PRESET_ID), error);
      }
    }
  }

  let policySnapshot = toolPolicySnapshot();
  if (!startupError) {
    try {
      policySnapshot = toolPolicySnapshot((await store.read()) as PresetState);
    } catch (error) {
      startupError = describeStartupFailure('无法读取状态文件',
        `${store.file}（插件不会自动清空它，请修复或移走该文件后重新启用）`, error);
    }
  }
  if (startupError) {
    // Loaded but unable to inject: the preset mode must refuse to mount with this
    // exact reason rather than silently running without any preset.
    setPresetEnhanceUnavailableReason(startupError);
    releaseAvailability();
  } else {
    clearPresetEnhanceUnavailableReason();
  }
  const refreshPolicies = (state: PresetState) => { policySnapshot = toolPolicySnapshot(state); };
  const templateRegistry = createTemplateRegistry(error => console.warn('preset-enhance: template catalog listener failed', error));
  ctx.effect(() => () => templateRegistry.close(), 'preset-enhance: template registry');
  const templateServiceAvailable = !startupError && typeof ctx.provide === 'function';
  if (templateServiceAvailable) ctx.provide!(PRESET_TEMPLATES_SERVICE, templateRegistry.service);
  if (!startupError) installToolRestrictions(ctx, () => policySnapshot, sessionModeId);
  const tools = ctx.tools;
  if (tools?.guard && !startupError) {
    const guard = tools.guard.bind(tools);
    ctx.effect(() => guard((exec: ToolExecution) => {
      const session = exec.agent?.session;
      if (!session) return;
      if (effectiveToolEnabled(policySnapshot, session.id, sessionModeId(session), exec.name) !== false) return;
      return `工具 ${exec.name} 已在预设工作台中关闭`;
    }), 'preset-enhance: tool policy guard');
  }
  const commands = ctx.commands;
  if (commands?.register && !startupError) {
    const register = commands.register.bind(commands);
    ctx.effect(() => register(presetCommand(store)), 'preset-enhance: /preset');
  }

  async function* injectStream(options: StreamOptions, next: () => AsyncIterable<unknown>, onDispatch: () => void) {
    // A degraded startup never injects a partial preset: requests pass through untouched.
    if (startupError) { yield* next(); return; }
    const sessionId = options.sessionId;
    const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
    if (routed.has(options) || options.purpose || !session || !sessionId) { yield* next(); return; }
    const templateCatalog = templateRegistry.service.list();

    const connectionInfo = sessionConnection(ctx, sessionId, options.provider);
    const modeId = sessionModeId(session);
    const exclusive = modeId === AGENT_PRESET_ID;
    const incoming = options.messages ?? [];
    const history = exclusive ? presetModeHistory(incoming) : incoming;
    const observed = catalogFromTools(options.tools);
    const initial = (await store.read()) as PresetState;
    refreshPolicies(initial);
    const explicit = ownGet(initial.bindings, sessionId);
    const wantsPreset = explicit?.enabled ||
      (!explicit && shouldAutoEnable(initial, session) && defaultRecord(initial));
    const catalogChanged = observed.length > 0 && !sameCatalog(initial.toolCatalogs[modeId] ?? [],
      editableToolCatalog([initial.toolCatalogs, { [modeId]: observed }])[modeId]);
    let compiled: CompiledPreset | null = null;
    // Resolver I/O must not hold the shared store's write queue.
    const effectiveBinding = (state: PresetState) => ownGet(state.bindings, sessionId) ??
      (shouldAutoEnable(state, session) && defaultRecord(state) ? { enabled: true, presetId: defaultRecord(state)!.id, characterId: null, values: {}, markers: {} } : undefined);
    const dependencyKey = (state: PresetState) => {
      const binding = effectiveBinding(state);
      return digest({ binding, mode: sessionModeId(session), record: state.presets.find(p => p.id === binding?.presetId), global: state.global,
        local: ownGet(state.sessions, sessionId)?.result.local, protocol: connectionProtocolFor(state, connectionInfo),
        beta: state.deepseekBetaPrefix, postToolPrefixMode: state.postToolPrefixMode, postToolPrefixText: state.postToolPrefixText,
        prefixToolCalls: state.prefixToolCalls, prefixNonOfficialRemoveTools: state.prefixNonOfficialRemoveTools, prefixOutputExtraction: state.prefixOutputExtraction });
    };
    const initialBinding = effectiveBinding(initial);
    const initialRecord = initial.presets.find(p => p.id === initialBinding?.presetId);
    const dynamic = initialBinding?.enabled && initialRecord && Object.values(templateBindings(initialRecord.preset, templateCatalog)).some(ref => ref?.mode === 'linked-dynamic');
    const needsDsh = initialBinding?.enabled && initialRecord && !exclusive && dshSystemPromptEnabled(initialRecord.preset);
    const expectedDependency = dynamic || needsDsh ? dependencyKey(initial) : undefined;
    const dshSystemTemplate = needsDsh ? await lifecycle.track(readDshSystemTemplate(ctx, sessionId, modeId, options.signal, options)) : undefined;
    if (needsDsh && !dshSystemTemplate?.available && Object.hasOwn(initialRecord!.preset.dsh_system_prompt_templates ?? {}, modeId)) throw new Error('当前无法读取 DSH 提示词服务，无法展开自定义模式模板');
    const preparedHistory = (preset: import('./lib/types.mjs').SillyTavernPreset) => exclusive || !dshSystemPromptEnabled(preset)
      ? presetModeHistory(history) : dshSystemTemplate?.available ? withoutDshPrompt(history) : history;
    let requestSettings: ReturnType<typeof readRequestSettings> | undefined;
    const historyRevision = dynamic && session.deriveMessages ? digest(session.deriveMessages()) : undefined;
    const dynamicBodies = dynamic ? (await lifecycle.track(prepareDynamicTemplates(templateRegistry, initialRecord!.preset,
      preparedHistory(initialRecord!.preset), {
        ...initialBinding, local: ownGet(initial.sessions, sessionId)?.result.local, global: initial.global,
        sessionId, presetId: initialRecord!.id, mode: modeId, protocol: connectionProtocolFor(initial, connectionInfo),
        purpose: 'request', signal: options.signal, templateCatalog,
      }))).bodies : undefined;

    if (wantsPreset || catalogChanged) {
      compiled = await lifecycle.track(store.transaction((current: PresetState) => {
        if (expectedDependency !== undefined && (dependencyKey(current) !== expectedDependency ||
          (historyRevision !== undefined && digest(session.deriveMessages!()) !== historyRevision))) throw new Error('动态解析期间预设、变量或会话已变化，请重新发送');
        let changed = false;
        if (observed.length > 0 && syncToolCatalog(current, modeId, observed)) changed = true;
        let binding = ownGet(current.bindings, sessionId);
        if (!binding && shouldAutoEnable(current, session)) {
          const record = defaultRecord(current);
          if (record) {
            binding = { enabled: true, presetId: record.id, characterId: null, values: {}, markers: {} };
            assign(current.bindings, sessionId, binding);
            changed = true;
          }
        }
        if (changed) current.revision++;
        refreshPolicies(current);
        if (!binding?.enabled) return null;
        const record = current.presets.find(p => p.id === binding.presetId);
        if (!record) throw new Error('当前会话启用的预设不存在');
        const presetHistory = preparedHistory(record.preset);
        requestSettings = readRequestSettings(record.preset);
        const postToolPrefix = current.deepseekBetaPrefix && current.postToolPrefixMode === 'custom'
          ? current.postToolPrefixText : undefined;
        const templateReferences = resolveTemplateBindings(record.preset, templateCatalog,
          new Set(getOrder(record.preset, binding.characterId).filter(item => item.enabled).map(item => item.identifier))).references;
        const key = compilationKey(record.preset, presetHistory, { ...binding, postToolPrefix, dshSystemTemplate }, connectionProtocolFor(current, connectionInfo), templateReferences, dynamicBodies);
        const prior = ownGet(current.sessions, sessionId);
        if (prior?.key === key) return prior.result;
        const compiledResult = compilePreset(record.preset, presetHistory, {
          ...binding, seed: key, local: prior?.result.local, global: current.global, postToolPrefix, templateCatalog, dynamicBodies, dshSystemTemplate,
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
        const result: CompiledPreset = messagesMode ? {
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
    if (!toolsChanged && !messagesChanged) { onDispatch(); yield* traceRequest(snapshots, sessionId, options, next()); return; }

    const request = routedRequest({ ...options, ...(requestSettings?.maxTokens ? { maxTokens: requestSettings.maxTokens } : {}) }, messages, filteredTools);
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
      ...requestSettings,
      toolCalls: initial.prefixToolCalls === true,
      removeNonOfficialTools: initial.prefixNonOfficialRemoveTools !== false,
      extractOutput: initial.prefixOutputExtraction === true,
    }) : () => {};
    routed.add(request);
    try { onDispatch(); yield* traceRequest(snapshots, sessionId, request, ctx.llm.stream(request), compiled ? { warnings: compiled.warnings, promptRegex: compiled.promptRegex } : undefined); } finally { releaseBeta(); routed.delete(request); }
  }

  ctx.on('llm/stream', async function* (options: StreamOptions, next: () => AsyncIterable<unknown>) {
    if (lifecycle.closing) throw new Error('插件正在停用，请稍后重试');
    let finish!: () => void;
    lifecycle.track(new Promise<void>(resolve => { finish = resolve; }));
    let dispatched = false;
    try { yield* injectStream(options, next, () => { dispatched = true; }); }
    catch (error) {
      if (!dispatched && !routed.has(options) && !options.purpose && options.sessionId && !startupError) snapshots.preparationFailed(options.sessionId, error);
      throw error;
    } finally { finish(); }
  });

  const assets = new Map<string, [string, string]>([
    [BASE, ['web/index.html', 'text/html']],
    [`${BASE}/editor.js`, ['web/editor.js', 'text/javascript']],
    [`${BASE}/tool-labels.js`, ['web/tool-labels.js', 'text/javascript']],
    [`${BASE}/editor.css`, ['web/editor.css', 'text/css']],
    // SPreset editor: its own page, script and stylesheet. The page URL stays /editor
    // because the workbench's own script already owns /editor.js.
    [`${BASE}/editor`, ['web/spreset.html', 'text/html']],
    [`${BASE}/spreset.js`, ['web/spreset.js', 'text/javascript']],
    [`${BASE}/spreset.css`, ['web/spreset.css', 'text/css']],
    [`${BASE}/plugin-templates.js`, ['web/plugin-templates.js', 'text/javascript']],
    [`${BASE}/plugin-templates.css`, ['web/plugin-templates.css', 'text/css']],
    [`${BASE}/request-preview.js`, ['web/request-preview.js', 'text/javascript']],
  ]);
  const reader = createPresetReader(ctx, async () => {
    if (startupError || lifecycle.closing) throw new Error('预设服务不可用');
    return await store.read() as PresetState;
  }, (state, sessionId) => ownGet(state.bindings, sessionId) ??
    (shouldAutoEnable(state, ctx.sessions.get(sessionId)) ? defaultBinding(state) : undefined));
  ctx.effect(() => () => reader.close(), 'preset-enhance: read API cleanup');
  ctx.provide?.('presetReader', reader.service);
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PRESET_READ_BASE, handler: reader.handler }), 'preset-enhance: read API');
  if (ctx.tools?.register) ctx.effect(() => ctx.tools!.register!(reader.tool), 'preset-enhance: read tool');
  const templateEventClosers = new Set<() => void>();
  ctx.effect(() => () => { for (const close of [...templateEventClosers]) close(); }, 'preset-enhance: template event cleanup');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${BASE}/api/template-events`, handler: (req: HostRequest, res: HostResponse) => {
      if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
      if (lifecycle.closing || !templateServiceAvailable || !res.write) return respond(res, 503, { error: '模板通知不可用' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (revision: number) => res.write!(`data: ${JSON.stringify({ revision })}\n\n`);
      const unsubscribe = templateRegistry.service.subscribe(send);
      const timer = setInterval(() => res.write!(': keepalive\n\n'), 25000);
      const close = () => { clearInterval(timer); unsubscribe(); templateEventClosers.delete(close); res.end(); };
      templateEventClosers.add(close);
      res.on?.('close', () => { clearInterval(timer); unsubscribe(); templateEventClosers.delete(close); });
      send(templateRegistry.service.list().revision);
    },
  }), 'preset-enhance: template event route');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${BASE}/api/templates`, handler: async (req: HostRequest, res: HostResponse) => {
      if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
      if (lifecycle.closing || !templateServiceAvailable) return respond(res, 503, {
        error: startupError ?? (lifecycle.closing ? '插件正在停用，请稍后重试' : '宿主未提供模板服务注册能力'),
      });
      return respond(res, 200, templateCatalogWithFingerprints(templateRegistry.service.list()));
    },
  }), 'preset-enhance: template catalog route');
  const modeWatchers = new Set<{ sessionId: string; notify(): void }>();
  ctx.on('agent-preset/selected', (sessionId: string) => {
    for (const watcher of modeWatchers) if (watcher.sessionId === sessionId) watcher.notify();
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${BASE}/api/request-events`, handler: (req: HostRequest, res: HostResponse) => {
      if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
      if (lifecycle.closing || !res.write) return respond(res, 503, { error: '请求预览通知不可用' });
      const sessionId = new URL(String(req.url ?? ''), 'http://preset.local').searchParams.get('sessionId') ?? '';
      if (!sessionId || !ctx.sessions.get(sessionId)) return respond(res, 400, { error: '需要当前会话' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (id: string) => res.write!(`data: ${JSON.stringify({ id })}\n\n`);
      let timer: ReturnType<typeof setInterval>;
      const watcher = { sessionId, notify: () => res.write!('event: mode\ndata: {}\n\n') };
      modeWatchers.add(watcher);
      const unsubscribe = snapshots.subscribe(sessionId, send, () => { clearInterval(timer); modeWatchers.delete(watcher); res.end(); });
      timer = setInterval(() => res.write!(': keepalive\n\n'), 25000);
      res.on?.('close', () => { clearInterval(timer); modeWatchers.delete(watcher); unsubscribe(); });
      send(snapshots.latestId(sessionId) ?? '');
    },
  }), 'preset-enhance: request snapshot notifications');
  for (const [path, [file, mime]] of assets) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req: HostRequest, res: HostResponse) => {
      if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
      res.writeHead(200, {
        'content-type': `${mime}; charset=utf-8`,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'",
      });
      res.end(await readFile(new URL(file, import.meta.url)));
    },
  }), `preset-enhance: ${path}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${BASE}/api`, handler: async (req: HostRequest, res: HostResponse) => {
      if (lifecycle.closing) return respond(res, 503, { error: '插件正在停用，请稍后重试' });
      // Writes are refused while degraded; GET still answers so the workbench can
      // mount and show the reason.
      if (startupError && req.method !== 'GET') return respond(res, 503, { error: startupError });
      try {
        const url = new URL(String(req.url ?? ''), 'http://preset.local');
        if (req.method === 'GET') {
          let state: PresetState;
          try {
            state = (await store.read()) as PresetState;
          } catch (error) {
            return respond(res, 200, degradedPayload(
              startupError ?? describeStartupFailure('无法读取状态文件', store.file, error)));
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
          const liveMode = sessionModeId(session) || (!session ? url.searchParams.get('modeId') : '') || ctx.agentPresets?.defaultId || '';
          const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, sessionId);
          let dshSystemTemplate;
          try { dshSystemTemplate = await readDshSystemTemplate(ctx, sessionId, liveMode); }
          catch (error) { dshSystemTemplate = { available: false, modeId: liveMode, warnings: [String(error)] }; }
          return respond(res, 200, {
            dshSystemTemplate,
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
            // SPreset editor library: the editor's own collection, unrelated to presets.
            sPresetLibrary: state.sPresetLibrary,
            // Editor-side entry locks, keyed by preset id.
            sPresetEditor: state.sPresetEditor,
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
            connectionChoice: connectionSelection(ctx, sessionId),
            protocolNotes: ownGet(state.sessions, sessionId)?.protocolNotes ?? [],
            protocolSwitched: Boolean(sessionId && protocolObserver.last(sessionId)?.switchedFrom),
            protocolMismatch: presetProtocolMismatch(state, sessionId, session, protocolObserver, connectionInfo),
          });
        }
        if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('需要 application/json');
        if (req.headers.origin && new URL(String(req.headers.origin)).host !== req.headers.host) throw new Error('拒绝跨来源写入');
        const body = await readJson(req);
        if (body.action === 'dsh-system-template') {
          const sessionId = String(body.sessionId ?? '');
          const modeId = String(body.modeId ?? sessionModeId(ctx.sessions.get(sessionId)));
          return respond(res, 200, await readDshSystemTemplate(ctx, sessionId, modeId));
        }
        if (body.action === 'request-snapshot') {
          return respond(res, 200, { snapshot: snapshots.read(String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), body.snapshotId) });
        }
        if (body.action === 'template-select') {
          const draft = validatePreset(body.preset);
          const current = await store.read();
          const locks = presetLocks(current.sPresetEditor, String(body.presetId ?? ''));
          const result = selectTemplate(draft, templateRegistry.service.list(), body.selection ?? {}, locks);
          validatePreset(result.preset);
          return respond(res, 200, result);
        }
        if (body.action === 'preview') {
          const sessionId = String(body.sessionId ?? '');
          const current = await store.read();
          const session = ctx.sessions.get(sessionId);
          const mode = sessionModeId(session) || (!session ? String(body.modeId ?? '') : '') || ctx.agentPresets?.defaultId || '';
          const connection = sessionConnection(ctx, sessionId);
          const protocol = connectionProtocolFor(current, connection);
          let history = previewHistory(ctx, body);
          const controller = new AbortController();
          res.on?.('close', () => controller.abort(new Error('预览已取消')));
          const dshSystemTemplate = mode !== AGENT_PRESET_ID && dshSystemPromptEnabled(body.preset)
            ? await readDshSystemTemplate(ctx, sessionId, mode, controller.signal) : undefined;
          if (mode !== AGENT_PRESET_ID && dshSystemPromptEnabled(body.preset) && !dshSystemTemplate?.available && Object.hasOwn(body.preset.dsh_system_prompt_templates ?? {}, mode)) throw new Error('当前无法读取 DSH 提示词服务，无法展开自定义模式模板');
          if (dshSystemTemplate?.available) history = withoutDshPrompt(history);
          const requestSettings = readRequestSettings(validatePreset(body.preset));
          const options = { ...body.options, dshSystemTemplate, local: ownGet(current.sessions, sessionId)?.result.local, global: current.global,
            postToolPrefix: current.deepseekBetaPrefix && current.postToolPrefixMode === 'custom' ? current.postToolPrefixText : undefined };
          const prepared = await prepareDynamicTemplates(templateRegistry, validatePreset(body.preset), history, {
            ...options, sessionId, presetId: body.presetId, mode, protocol, purpose: 'preview', signal: controller.signal,
          });
          const references = resolveTemplateBindings(body.preset, prepared.catalog,
            new Set(getOrder(body.preset, options.characterId).filter(i => i.enabled).map(i => i.identifier))).references;
          const key = compilationKey(body.preset, history, options, protocol, references, prepared.bodies);
          const compiled = compilePreset(body.preset, history, { ...options, seed: key, templateCatalog: prepared.catalog, dynamicBodies: prepared.bodies, dshSystemTemplate });
          const adapted = adaptPresetForMessages(compiled.messages);
          const result = { ...compiled, messages: adapted.messages,
            ...(protocol === 'messages' ? { assistantPrefix: { active: false }, warnings: [...compiled.warnings, ...adapted.notes] } : {}) };
          const selection = connectionSelection(ctx, sessionId);
          const provider = selection.provider ?? connection?.provider ?? '';
          const agentTools = ctx.agents?.get(sessionId)?.ctx?.tools?.schemas?.();
          const tools = filterTools(agentTools ?? [], effectiveToolPolicy(toolPolicySnapshot(current), sessionId, mode, agentTools));
          let callConfig: Record<string, unknown> = { provider, model: selection.model ?? '', reasoningEffort: selection.reasoningEffort ?? undefined };
          if (ctx.llm.resolveCallConfig && provider === DEEPSEEK_CHAT_PROVIDER_ID) {
            callConfig = await ctx.llm.resolveCallConfig(callConfig as { provider: string; model: string }, controller.signal);
          }
          const request = { ...callConfig, ...(requestSettings.maxTokens ? { maxTokens: requestSettings.maxTokens } : {}),
            sessionId, messages: result.messages, ...(tools.length ? { tools } : {}) };
          let raw = JSON.stringify(request), source = 'adapter-input';
          if (provider === DEEPSEEK_CHAT_PROVIDER_ID) {
            try {
              const config = chatConnection();
              const wire = serializeRequest(request as never, { thinking: config.thinking, reasoningEffort: config.reasoningEffort });
              const content = current.deepseekBetaPrefix && result.assistantPrefix.active ? messageText(result.messages.at(-1)) : '';
              const registry = new Map([[sessionId, new Map([[content, { count: 1, ...requestSettings, mode: 'chat-completions' as const, toolCalls: current.prefixToolCalls === true,
                removeNonOfficialTools: current.prefixNonOfficialRemoveTools !== false, extractOutput: current.prefixOutputExtraction === true }]])]]);
              const rewritten = rewriteDeepSeekPrefixFetch(config.baseURL + '/chat/completions', {
                method: 'POST', headers: { 'x-deepseek-harness-session-id': sessionId }, body: JSON.stringify(wire),
              }, [registry]);
              raw = String(rewritten.init?.body ?? JSON.stringify(wire)); source = 'draft-wire';
            } catch { result.warnings.push('附件或适配器需要发送阶段准备；当前预览为适配器输入，实际发送后可查看最终 Raw'); }
          } else result.warnings.push('当前适配器未提供纯序列化预览；显示适配器输入，实际发送后可查看最终 Raw');
          if (!agentTools) result.warnings.push('当前会话工具范围尚未建立；以发送时的工具列表为准');
          if (mode !== AGENT_PRESET_ID && dshSystemPromptEnabled(body.preset) && !dshSystemTemplate?.available) result.warnings.push('当前无法读取 DSH 提示词服务；宿主提示词以实际请求为准');
          return respond(res, 200, { ...result, raw, source, snapshotId: randomUUID(), displayMessages: previewMessages(JSON.parse(raw), messageOrigins(result.messages)),
            previewHistoryIds: history.map(m => m.id), at: new Date().toISOString() });
        }
        if (body.action === 'prefill-inspect') {
          const preset = validatePreset(body.preset);
          const order = getOrder(preset, body.options?.characterId).filter(i => i.enabled);
          const ids = new Set(order.map(i => i.identifier));
          const dynamic = Object.entries(templateBindings(preset, templateRegistry.service.list())).some(([id, ref]) => ids.has(id) && ref?.mode === 'linked-dynamic');
          const tail = preset.prompts.find(p => p.identifier === order.at(-1)?.identifier);
          return respond(res, 200, { pending: dynamic, assistantPrefix: { active: !!preset.assistant_prefill?.trim() || tail?.role === 'assistant' || tail?.role === 'model' } });
        }

        // The workbench test box. Regular expressions, the placement/depth plan and the macro engine
        // all come from the same modules a request uses; nothing returns or logs the chat text.
        if (body.action === 'regex-test') return respond(res, 200, regexTestResult(body));

        // SPreset editor library: its own collection in the state file, never inside a preset.
        if (body.action === 'library-save') {
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            const result = saveLibraryEntry(current.sPresetLibrary, body.entry);
            current.sPresetLibrary = result.library;
            current.revision++;
            return { revision: current.revision, entry: result.entry, created: result.created, entries: result.library.entries };
          }));
        }
        if (body.action === 'library-delete') {
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            const result = deleteLibraryEntry(current.sPresetLibrary, body.id);
            if (!result.removed) throw new Error('资源库条目不存在');
            current.sPresetLibrary = result.library;
            current.revision++;
            return { revision: current.revision, entries: result.library.entries };
          }));
        }
        if (body.action === 'library-restore-templates') {
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            current.sPresetLibrary = restoreDefaultTemplates(current.sPresetLibrary);
            current.revision++;
            return { revision: current.revision, entries: current.sPresetLibrary.entries };
          }));
        }
        // SPreset editor entry locks. They live in the plugin state (never in the preset) and are
        // an editor-side guard only: the request path neither reads nor acts on them.
        if (body.action === 's-preset-lock') {
          const lockPresetId = typeof body.presetId === 'string' ? body.presetId : '';
          const identifier = typeof body.identifier === 'string' ? body.identifier : '';
          if (!lockPresetId) throw new Error('缺少预设 ID');
          if (!identifier) throw new Error('缺少条目 ID');
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            current.sPresetEditor = setPresetLock(current.sPresetEditor, lockPresetId, identifier, body.locked === true);
            current.revision++;
            return { revision: current.revision, locks: presetLocks(current.sPresetEditor, lockPresetId) };
          }));
        }

        // Read-only view of one draft preset's extensions.SPreset block; regex verdicts come from
        // the shared prompt-regex engine, so the editor never re-implements channel/depth rules.
        if (body.action === 's-preset-plan') {
          const preset = validatePreset(body.preset);
          const depth = Number.isInteger(body.depth) ? body.depth : 0;
          return respond(res, 200, summarizeSPreset(preset, depth));
        }

        if (body.action === 'export-package') {
          const state = (await store.read()) as PresetState;
          if (body.revision !== state.revision) throw new Error('预设已被其他窗口更新，请重新加载后再导出');
          const record = state.presets.find(preset => preset.id === body.id);
          const requested = typeof body.toolPresetId === 'string' ? body.toolPresetId : '';
          const toolPresetId = requested && state.toolPresets.some(preset => preset.id === requested) ? requested : null;
          const tools = toolPresetId ? exportToolsSection(state, toolPresetId) : record?.sharePackage?.tools;
          return respond(res, 200, encodePresetPackage({
            ...record, name: String(body.name || record?.name || '未命名预设').slice(0, 200),
            preset: body.preset ?? record?.preset,
          } as PresetRecord, state, tools));
        }

        const needsModes = MODE_ACTIONS.has(body.action);
        const modeRows = needsModes ? await agentModeRows(ctx) : [];
        const knownModes = new Set(modeRows.map(mode => mode.id));
        const discovered: DiscoveredCatalogs = CATALOG_ACTIONS.has(body.action) ?
          await discoverModeToolCatalogs(ctx, modeRows) : { catalogs: {}, errors: {} };

        if (body.action === 'select-connection') {
          const provider = body.provider;
          if (typeof provider !== 'string' || !provider) throw new Error('缺少连接标识');
          const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
          const choice = await selectConnection(ctx, provider, model, url.searchParams.get('sessionId') ?? '');
          return respond(res, 200, { connectionChoice: choice });
        }

        if (body.action === 'save-connection-protocol') {
          const protocol = body.protocol;
          if (protocol !== 'chat-completions' && protocol !== 'messages') throw new Error('连接协议无效');
          // Re-read right before writing so the merge carries a fresh settings revision.
          const connectionSessionId = url.searchParams.get('sessionId') ?? '';
          const info = sessionConnection(ctx, connectionSessionId);
          if (!info) throw new Error('当前 DSH 未暴露可配置的连接，无法切换协议');
          if (info.source !== 'settings') throw new Error('当前 DSH 未提供设置服务，无法切换连接协议');
          await writeConnectionProtocol(ctx, info, protocol);
          const connectionInfo = sessionConnection(ctx, connectionSessionId);
          return respond(res, 200, { connection: connectionInfo });
        }

        if (body.action === 'save-tool-groups') {
          const state = (await store.read()) as PresetState;
          const catalogs = requestToolCatalogs(
            ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
          const groups = normalizeToolGroups(body.groups, { catalogs, existing: state.toolGroups });
          const warnings = unresolvedWarnings(unresolvedToolRefs({ toolGroups: groups }, catalogs));
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            current.toolGroups = groups;
            current.revision++;
            refreshPolicies(current);
            return { revision: current.revision, groups: current.toolGroups, warnings };
          }));
        }

        if (body.action === 'save-tool-preset') {
          if (!isRecord(body.preset)) throw new Error('工具预设必须是对象');
          const state = (await store.read()) as PresetState;
          const requestedId = typeof body.id === 'string' && body.id ? body.id
            : typeof body.preset.id === 'string' && body.preset.id ? body.preset.id : null;
          const existing = requestedId ? state.toolPresets.find(preset => preset.id === requestedId) : undefined;
          if (!existing && state.toolPresets.length >= TOOL_PRESET_LIMIT) {
            throw new Error(`工具预设最多 ${TOOL_PRESET_LIMIT} 个`);
          }
          const preset = normalizeToolPreset({ ...body.preset, id: existing ? requestedId : null }) as ToolPresetDraft;
          assertPresetGroupIds(preset, state.toolGroups);
          const record: ToolPreset = { ...preset, id: existing && requestedId ? requestedId : randomUUID() };
          const warnings = unresolvedWarnings(
            unresolvedToolRefs({ toolPresets: [record] }, requestToolCatalogs(
              ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '')));
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            const index = current.toolPresets.findIndex(item => item.id === record.id);
            if (index >= 0) current.toolPresets[index] = record;
            else current.toolPresets.push(record);
            current.revision++;
            refreshPolicies(current);
            return { id: record.id, warnings };
          }));
        }

        if (body.action === 'delete-tool-preset') {
          const state = (await store.read()) as PresetState;
          if (!state.toolPresets.some(preset => preset.id === body.id)) throw new Error('请选择要删除的工具预设');
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            const index = current.toolPresets.findIndex(preset => preset.id === body.id);
            if (index < 0) throw new Error('请选择要删除的工具预设');
            current.toolPresets.splice(index, 1);
            const { modes, sessions } = resetPresetSelections(current, body.id);
            current.revision++;
            refreshPolicies(current);
            return { id: body.id, modes, sessions };
          }));
        }

        if (body.action === 'select-tool-policy') {
          const state = (await store.read()) as PresetState;
          let key: 'modeToolSelections' | 'sessionToolSelections';
          let id: string;
          let selection: ToolSelection;
          if (body.scope === 'mode') {
            if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId)) throw new Error('请选择有效的 DSH 模式');
            key = 'modeToolSelections';
            id = body.modeId;
            selection = normalizeToolSelection(body.selection, 'mode') as ToolSelection;
          } else if (body.scope === 'session') {
            const session = typeof body.sessionId === 'string' ? ctx.sessions.get(body.sessionId) : undefined;
            if (!session) throw new Error('缺少有效的会话 ID');
            key = 'sessionToolSelections';
            id = body.sessionId;
            selection = normalizeToolSelection(body.selection, 'session') as ToolSelection;
          } else {
            throw new Error('未知的工具策略范围');
          }
          if (selection.kind === 'preset' &&
            !state.toolPresets.some(preset => preset.id === selection.presetId)) {
            throw new Error('请选择有效的工具预设');
          }
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            assign(current[key], id, selection);
            current.revision++;
            refreshPolicies(current);
            return { selection };
          }));
        }

        if (body.action === 'save-mode-tools') {
          if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId)) throw new Error('请选择有效的 DSH 模式');
          const state = (await store.read()) as PresetState;
          const catalogs = requestToolCatalogs(
            ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
          const policy = validateToolPolicy(body.policy, catalogs[body.modeId]);
          const selection = { kind: 'custom' };
          return respond(res, 200, await store.transaction((current: PresetState) => {
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
          if (!session) throw new Error('缺少有效的会话 ID');
          const modeId = sessionModeId(session);
          if (!knownModes.has(modeId)) throw new Error('当前会话没有可识别的 DSH 模式');
          const inherit = body.inherit === true;
          const state = (await store.read()) as PresetState;
          const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, body.sessionId);
          const policy = inherit ? null : validateToolPolicy(body.policy, catalogs[modeId]);
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            if (inherit) {
              delete current.sessionToolPolicies[body.sessionId];
              delete current.sessionToolSelections[body.sessionId];
            } else {
              assign(current.sessionToolPolicies, body.sessionId, policy);
              assign(current.sessionToolSelections, body.sessionId, { kind: 'custom' });
            }
            current.revision++;
            refreshPolicies(current);
            return { inherited: inherit, revision: current.revision };
          }));
        }

        if (body.action === 'import-package-tools') {
          const state = (await store.read()) as PresetState;
          const record = state.presets.find(preset => preset.id === body.id);
          if (!record) throw new Error('请选择带有工具配置的预设包');
          if (!record.sharePackage?.tools) throw new Error('该预设包不包含工具配置');
          const plan = remapToolPackage(record.sharePackage.tools, state, {
            catalogs: requestToolCatalogs(
              ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? ''),
          });
          if (body.dryRun === true) {
            return respond(res, 200, {
              applied: false, stats: plan.stats, groups: plan.tools.groups, presets: plan.tools.presets,
            });
          }
          return respond(res, 200, await store.transaction((current: PresetState) => {
            assertRevision(current, body);
            current.toolGroups.push(...plan.tools.groups);
            current.toolPresets.push(...plan.tools.presets);
            current.revision++;
            refreshPolicies(current);
            return { applied: true, stats: plan.stats, groups: plan.tools.groups, presets: plan.tools.presets };
          }));
        }

        const result = await store.transaction((state: PresetState) => {
          assertRevision(state, body);
          // A global preset change made inside a conversation also applies there.
          // The sidebar has no session context, and other bindings stay pinned.
          const selectPreset = (record: PresetRecord) => {
            const sessionId = body.sessionId ?? url.searchParams.get('sessionId');
            if (sessionId) {
              const session = ctx.sessions.get(sessionId);
              if (!session) throw new Error('缺少有效的会话 ID');
              const previous = ownGet(state.bindings, sessionId);
              validateBinding(state, { sessionId, binding: {
                ...previous,
                enabled: previous?.enabled ?? shouldAutoEnable(state, session),
                presetId: record.id,
                characterId: previous?.presetId === record.id ? previous.characterId : null,
              } });
            }
            state.selectedPresetId = record.id;
            state.defaultPresetId = record.id;
            state.revision++;
            return { id: record.id, revision: state.revision,
              ...(sessionId ? { binding: ownGet(state.bindings, sessionId) } : {}) };
          };
          if (body.action === 'save' || body.action === 'import') {
            const imported = body.action === 'import' ? decodePresetDocument(body.document, String(body.name || '未命名预设')) : null;
            validatePreset(imported?.preset ?? body.preset);
            // The SPreset editor asks for the settings mirror; every other caller saves verbatim.
            const source = imported?.preset ?? body.preset;
            const mirrored = body.mirrorSPreset === true ? syncSPresetMirror(source) : { preset: source, changed: false };
            const old = body.action === 'save' ? state.presets.find(p => p.id === body.id) : undefined;
            const record = {
              ...old,
              ...imported,
              id: old?.id ?? randomUUID(),
              name: String(imported?.name || body.name || '未命名预设').slice(0, 200),
              preset: mirrored.preset,
            };
            if (old) state.presets[state.presets.indexOf(old)] = record;
            else state.presets.push(record);
            return selectPreset(record);
          }
          if (body.action === 'delete-preset') {
            const index = state.presets.findIndex(preset => preset.id === body.id);
            if (index < 0) throw new Error('请选择要删除的已保存预设');
            const [removed] = state.presets.splice(index, 1);
            const fallback = state.presets.find(preset => preset.id === state.selectedPresetId) ??
              state.presets.find(preset => preset.id === state.defaultPresetId) ??
              state.presets[index] ?? state.presets[index - 1] ?? state.presets[0];
            if (state.selectedPresetId === removed.id) state.selectedPresetId = fallback?.id ?? null;
            if (state.defaultPresetId === removed.id) state.defaultPresetId = fallback?.id ?? null;
            for (const [sessionId, binding] of Object.entries(state.bindings)) {
              if (binding?.presetId !== removed.id) continue;
              assign(state.bindings, sessionId, {
                ...binding,
                enabled: !!fallback && binding.enabled === true,
                presetId: fallback?.id ?? '',
                characterId: null,
              });
            }
            for (const [sessionId, cached] of Object.entries(state.sessions)) {
              if (cached?.presetId === removed.id) delete state.sessions[sessionId];
            }
            state.revision++;
            return { id: fallback?.id ?? null };
          }
          if (body.action === 'set-default') {
            const record = state.presets.find(p => p.id === body.id);
            if (!record) throw new Error('请先保存并选择预设');
            return selectPreset(record);
          }
          if (body.action === 'select-preset') {
            const record = state.presets.find(p => p.id === body.id);
            if (!record) throw new Error('请选择有效的预设');
            return selectPreset(record);
          }
          if (body.action === 'apply-package-prefill') {
            const record = state.presets.find(preset => preset.id === body.id);
            if (!record?.sharePackage) throw new Error('请选择带有接口设置的预设包');
            applyPackagePrefill(state, record);
            state.revision++;
            return { id: record.id };
          }
          if (body.action === 'save-deepseek-beta') {
            if (typeof body.enabled !== 'boolean') throw new Error('预填充接口开关值无效');
            if (body.toolCalls !== undefined) {
              if (typeof body.toolCalls !== 'boolean') throw new Error('工具调用处理开关值无效');
              state.prefixToolCalls = body.toolCalls;
            }
            if (body.extractOutput !== undefined) {
              if (typeof body.extractOutput !== 'boolean') throw new Error('正文/工具调用提取开关值无效');
              state.prefixOutputExtraction = body.extractOutput;
            }
            if (body.removeNonOfficialTools !== undefined) {
              if (typeof body.removeNonOfficialTools !== 'boolean') throw new Error('非官方接口工具移除开关值无效');
              state.prefixNonOfficialRemoveTools = body.removeNonOfficialTools;
            }
            if (body.postToolPrefixMode !== undefined) {
              if (!['inherit', 'custom'].includes(body.postToolPrefixMode)) throw new Error('工具调用后预填充模式无效');
              state.postToolPrefixMode = body.postToolPrefixMode;
            }
            if (body.postToolPrefixText !== undefined) {
              if (typeof body.postToolPrefixText !== 'string') throw new Error('工具调用后预填充必须为文本');
              state.postToolPrefixText = body.postToolPrefixText;
            }
            state.deepseekBetaPrefix = body.enabled;
            if (body.presetId) {
              const record = state.presets.find(preset => preset.id === body.presetId);
              if (!record) throw new Error('请选择有效的已保存预设');
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
            if (mode !== 'chat-completions' && mode !== 'messages') throw new Error('协议模式无效');
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
            for (const id of selected) if (!previous.has(id)) state.autoEnableSince[id] = now;
            for (const id of Object.keys(state.autoEnableSince)) if (!selected.includes(id)) delete state.autoEnableSince[id];
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
      } catch (error) {
        respond(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }), 'preset-enhance: API');


}

function messageText(message: HostMessage | undefined): string {
  return message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
}

function validateBinding(state: PresetState, body: Record<string, any>) {
  if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200) {
    throw new Error('缺少有效的会话 ID');
  }
  const record = state.presets.find(p => p.id === body.binding?.presetId);
  if (body.binding?.enabled && !record) throw new Error('请先保存并选择预设');
  if (record) getOrder(record.preset, body.binding.characterId);
  const values = body.binding?.values ?? {};
  const markers = body.binding?.markers ?? {};
  for (const map of [values, markers]) {
    if (!isRecord(map) || Object.values(map).some(value => typeof value !== 'string')) {
      throw new Error('角色变量和标记内容必须是文本映射');
    }
  }
  if (ownGet(state.bindings, body.sessionId)?.presetId !== record?.id) delete state.sessions[body.sessionId];
  assign(state.bindings, body.sessionId, {
    enabled: body.binding.enabled === true,
    presetId: record?.id ?? '',
    characterId: body.binding.characterId ?? null,
    values,
    markers,
  });
}

function presetCommand(store: PresetStore) {
  return {
    name: 'preset',
    description: '切换当前会话的预设注入（/preset [on|off|status]）',
    input: { hint: '[on|off|status]' },
    handler: async (invocation: CommandInvocation) => {
      const input = String(invocation.rawInput ?? '').trim().toLowerCase();
      if (!['', 'on', 'off', 'status'].includes(input)) {
        return { kind: 'error', text: '用法：/preset [on|off|status]' };
      }
      const session = invocation.agent.session;
      const sessionKey = session.id ?? '';
      const before = (await store.read()) as PresetState;
      const explicit = ownGet(before.bindings, sessionKey);
      const enabled = explicit?.enabled ?? (shouldAutoEnable(before, session) && !!defaultRecord(before));
      if (input === 'status') {
        const record = explicit?.presetId ? before.presets.find(p => p.id === explicit.presetId) : defaultRecord(before);
        return { kind: 'success', text: `预设注入：${enabled ? '已开启' : '已关闭'}${record ? `（${record.name}）` : ''}` };
      }
      const target = input === 'on' ? true : input === 'off' ? false : !enabled;
      return await store.transaction((state: PresetState) => {
        const current = ownGet(state.bindings, sessionKey);
        const record = current?.presetId ? state.presets.find(p => p.id === current.presetId) : defaultRecord(state);
        if (target && !record) return { kind: 'error', text: '尚未保存模式默认预设，请先在预设工作台中设置。' };
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
function presetProtocolMismatch(
  state: PresetState,
  sessionId: string,
  session: SessionLike | undefined,
  observer: ReturnType<typeof createProtocolObserver>,
  connection: ConnectionProtocolInfo | null,
): string | null {
  if (connectionProtocolFor(state, connection) === 'messages') return null;
  const binding = ownGet(state.bindings, sessionId);
  const enabled = binding?.enabled ??
    (session ? shouldAutoEnable(state, session) && !!defaultRecord(state) : false);
  if (!enabled) return null;
  const observed = observer.last(sessionId);
  if (!observed) return null;
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
function connectionProtocolFor(
  state: PresetState, connection: ConnectionProtocolInfo | null,
): ConnectionProtocol {
  if (connection?.protocol === 'messages' || connection?.protocol === 'chat-completions') {
    return connection.protocol;
  }
  return state.protocolMode === 'messages' ? 'messages' : 'chat-completions';
}

const DEFAULT_CHAT_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * The host classifies a failed turn by class identity
 * (core/agent-loop/src/agent.ts:355 — `error instanceof LlmError ? error.failure : { code: 'UNKNOWN' }`),
 * and its own docs state that duck-typed or cross-realm errors do not narrow. Our
 * structural error therefore cannot carry a code to the panel on its own, so we use the
 * host's class when it is resolvable from the profile. When it is not, we keep the
 * structural error and accept the generic code rather than faking an identity we do not have.
 */
/**
 * Use the running host's attribution identity, so the provider sees the harness version we
 * are actually inside. The host package is resolvable from the plugin location at runtime
 * and exports attributionHeaders()/APP_IDENTITY; when neither is reachable we keep the
 * vendored replica rather than inventing a version.
 */
async function resolveHostAttribution(): Promise<(() => Record<string, string>) | undefined> {
  try {
    const specifier = '@deepseek-ai/dsh-llm';
    const host = await import(specifier) as {
      attributionHeaders?: () => Record<string, string>;
      APP_IDENTITY?: { version?: unknown };
    };
    if (typeof host.attributionHeaders === 'function') {
      const hostHeaders = host.attributionHeaders;
      return () => hostHeaders();
    }
    const version = host.APP_IDENTITY?.version;
    if (typeof version === 'string' && version.length > 0) return () => attributionHeaders(version);
  } catch {
    // Fall through to the vendored replica.
  }
  return undefined;
}

async function resolveHostErrorFactory(): Promise<LlmErrorFactory | undefined> {
  try {
    // A variable specifier keeps the compiler from requiring a package we deliberately
    // do not depend on at build time; the class only exists at runtime inside the host.
    const specifier = '@deepseek-ai/dsh-llm';
    const host = await import(specifier) as { LlmError?: new (message: string, code: string, options?: unknown) => Error };
    const HostLlmError = host.LlmError;
    if (typeof HostLlmError !== 'function') return undefined;
    return (message, code, details) => new HostLlmError(message, code, details);
  } catch {
    return undefined;
  }
}

/** The host's attachment service, as the official adapter consumes it. */
interface HostAttachments {
  readImageRequest?(ref: unknown, target: unknown, signal?: AbortSignal): Promise<unknown>;
  imageHostPath?(ref: unknown): string | undefined;
}

/**
 * Collect the retained image references of one request and resolve each through the
 * host attachment service, at the size target this model route asks for. Offloaded
 * occurrences stay placeholders and are neither read nor uploaded.
 */
async function buildRequestImages(
  ctx: PluginContext,
  connection: () => { models?: readonly { id?: string }[] },
  options: { model?: string; messages?: readonly { content?: readonly unknown[] }[] },
  signal?: AbortSignal,
): Promise<Map<string, RequestImageAttachment>> {
  const prepared = new Map<string, RequestImageAttachment>();
  const attachments = ctx.get?.('attachments') as HostAttachments | undefined;
  if (typeof attachments?.readImageRequest !== 'function') return prepared;
  const routes = connection().models ?? [];
  const route = routes.find(item => item.id === options.model) ?? routes[0];
  if (route === undefined) return prepared;
  const refs = new Map<string, { attachmentId?: string }>();
  for (const message of options.messages ?? []) {
    for (const block of (message.content ?? []) as { type?: string; offloaded?: boolean; attachment?: { attachmentId?: string } }[]) {
      if (block?.type !== 'image' || block.offloaded === true) continue;
      const ref = block.attachment;
      if (typeof ref?.attachmentId === 'string' && ref.attachmentId) refs.set(ref.attachmentId, ref);
    }
  }
  for (const ref of refs.values()) {
    const target = resolveRequestImageTarget(route as never, ref as never);
    prepared.set(ref.attachmentId as string,
      await attachments.readImageRequest(ref, target, signal) as RequestImageAttachment);
  }
  return prepared;
}

/** Read-only handle text for one image reference, so the wire shows a real path when the host has one. */
function imageAccessOf(ctx: PluginContext, ref: unknown): { readonlyPath: string } | undefined {
  const attachments = ctx.get?.('attachments') as HostAttachments | undefined;
  const hostPath = attachments?.imageHostPath?.(ref);
  if (hostPath === undefined) return undefined;
  const world = (ctx.get?.('fs') as { processPathFromHostPath?(path: string): string | undefined } | undefined)
    ?.processPathFromHostPath?.(hostPath);
  return world === undefined ? undefined : { readonlyPath: world };
}

/**
 * Resolve the bundled Chat provider's key for one request: the host credentials
 * service first (by reference), then the launching environment. Never cached, and
 * never written into the preset store or an exported package.
 */
async function resolveChatApiKey(ctx: PluginContext, ref: string): Promise<string> {
  const service = ctx.get?.('credentials') as
    { resolve?(name: string): Promise<{ value?: unknown } | undefined> } | undefined;
  const hit = await service?.resolve?.(ref).catch(() => undefined);
  const fromStore = hit && typeof hit.value === 'string' ? hit.value : '';
  const key = fromStore.trim() || String(process.env[ref] ?? '').trim();
  if (!key) throw new Error(`预设增强：连接缺少 API Key（引用 ${ref}）`);
  return key;
}

function defaultRecord(state: PresetState): PresetRecord | undefined {
  return state.presets.find(p => p.id === state.selectedPresetId) ??
    state.presets.find(p => p.id === state.defaultPresetId) ?? state.presets[0];
}
function defaultBinding(state: PresetState): PresetBinding | undefined {
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
function sessionModeId(session: SessionLike | undefined): string {
  if (!session) return '';
  let selected = session.header?.agentPreset ?? '';
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type === 'agent-preset/selected') selected = event.data?.agentPreset ?? '';
  }
  return selected;
}
function shouldAutoEnable(state: PresetState, session: SessionLike | undefined): boolean {
  if (!session) return false;
  const modeId = sessionModeId(session);
  if (!state.autoEnableModes.includes(modeId)) return false;
  const since = Number(state.autoEnableSince[modeId] ?? 0);
  const createdAt = Number(session.header?.createdAt ?? Number.POSITIVE_INFINITY);
  return createdAt >= since;
}
function presetModeHistory(messages: HostMessage[]): HostMessage[] {
  // Newer DSH sessions persist prompt/runtime messages with dedicated source kinds.
  // Remove all historical snapshots and cleared markers, retaining the legacy plugin check.
  return messages.filter(message => message.role !== 'system' &&
    message.source?.kind !== 'system-prompt' && message.source?.kind !== 'runtime-context' &&
    !(message.source?.kind === 'plugin' && message.source.plugin === DSH_SYSTEM_PROMPT));
}
function dshSystemPromptText(messages: HostMessage[]): string {
  return messages.filter(message => message.role === 'system')
    .map(messageText).filter(Boolean).join('\n\n');
}

/** Live catalogs plus the last catalog seen for each mode, so a removed plugin is not silently forgotten. */
function knownToolCatalogs(state: PresetState | undefined, discovered: ToolCatalogMap | undefined): ToolCatalogMap {
  return editableToolCatalog([state?.toolCatalogs, discovered]);
}
/** Match GET's catalog view for writes opened from a live conversation. */
function requestToolCatalogs(ctx: PluginContext, state: PresetState, discovered: ToolCatalogMap, sessionId: string): ToolCatalogMap {
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
export function mcpToolGroups(catalogs: ToolCatalogMap): Record<string, { serverName: string; tools: string[] }[]> {
  const result: Record<string, { serverName: string; tools: string[] }[]> = {};
  for (const [modeId, catalog] of Object.entries(catalogs ?? {})) {
    if (!Array.isArray(catalog)) continue;
    const servers = new Map();
    for (const tool of catalog) {
      const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(String(tool?.name ?? ''));
      if (!match) continue;
      const serverName = match[1];
      const tools = servers.get(serverName) ?? [];
      tools.push(tool.name);
      servers.set(serverName, tools);
    }
    const groups = [...servers].sort(([left], [right]) => left.localeCompare(right))
      .map(([serverName, tools]) => ({ serverName, tools: [...new Set(tools)].sort() }));
    if (groups.length > 0) assign(result, modeId, groups);
  }
  return result;
}
function unresolvedWarnings(refs: readonly unknown[]): string[] {
  return refs.length > 0
    ? [`${refs.length} 条工具引用在当前模式目录中不存在，已保留待插件恢复后重新匹配`]
    : [];
}
function assertRevision(state: PresetState, body: Record<string, any>): void {
  if (body.revision !== state.revision) throw new Error('预设已被其他窗口更新，请重新加载后再保存');
}
function validateToolPolicy(value: unknown, catalog: ToolCatalogRow[] | undefined): ToolPolicy {
  if (!isRecord(value)) throw new Error('工具开关必须是对象');
  if (!Array.isArray(catalog)) throw new Error('无法读取该模式的工具目录');
  const allowed = new Set(catalog.map(tool => tool.name));
  const policy = {};
  for (const [tool, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') throw new Error('工具开关值必须是布尔值');
    if (!allowed.has(tool)) throw new Error('工具不属于当前模式或已被移除');
    assign(policy, tool, enabled);
  }
  return policy;
}
function catalogFromTools(tools: unknown): ToolCatalogRow[] {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => ({
    name: String(tool.name),
    description: String(tool.description ?? '').slice(0, 500),
  })).filter(tool => tool.name.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}
function sameCatalog(left: ToolCatalogRow[], right: ToolCatalogRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function syncToolCatalog(state: PresetState, modeId: string, observed: ToolCatalogRow[]): boolean {
  if (!modeId) return false;
  const merged = editableToolCatalog([state.toolCatalogs, { [modeId]: observed }])[modeId];
  if (sameCatalog(state.toolCatalogs[modeId] ?? [], merged)) return false;
  assign(state.toolCatalogs, modeId, merged);
  return true;
}
function filterTools(tools: ToolSchemaRow[] | undefined, policy: ToolPolicy): ToolSchemaRow[] {
  return Array.isArray(tools) ? tools.filter(tool => policy[tool.name] !== false) : [];
}
function routedRequest(options: StreamOptions, messages: HostMessage[], tools: ToolSchemaRow[]): StreamOptions {
  const { tools: _tools, ...request } = options;
  return Object.freeze({ ...request, messages, ...(tools.length > 0 ? { tools } : {}) });
}
export interface DiscoveredCatalogs { catalogs: ToolCatalogMap; errors: Record<string, string> }

export async function discoverModeToolCatalogs(ctx: PluginContext, modes: AgentModeRow[]): Promise<DiscoveredCatalogs> {
  const catalogs: ToolCatalogMap = {};
  const errors: Record<string, string> = {};
  for (const mode of modes) {
    if (mode.broken) {
      assign(errors, mode.id, String(mode.broken));
      continue;
    }
    try {
      if (!ctx.tools?.schemas) throw new Error('当前 DSH 未提供模式工具枚举服务');
      if (ctx.agentPresets?.acquireScope) {
        // 0.1.7: lease the mode's scope, read it, release it again.
        const leased = await readModeToolCatalog(ctx, mode.id);
        assign(catalogs, mode.id, catalogFromTools(leased.tools));
      } else if (ctx.agentPresets?.standingKeyFor) {
        // 0.1.6: a standing key the host keeps alive for the process.
        const scope = await ctx.agentPresets.standingKeyFor(mode.id);
        assign(catalogs, mode.id, catalogFromTools(ctx.tools.schemas(scope)));
      } else {
        throw new Error('当前 DSH 未提供模式工具枚举服务');
      }
    } catch (error) {
      assign(errors, mode.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { catalogs, errors };
}

function liveToolCatalog(ctx: PluginContext, sessionId: string | undefined): ToolCatalogRow[] {
  if (!sessionId) return [];
  try {
    const agent = ctx.agents?.get?.(sessionId);
    return agent?.ctx?.tools?.schemas ? catalogFromTools(agent.ctx.tools.schemas(agent)) : [];
  } catch {
    return [];
  }
}
async function agentModeRows(ctx: PluginContext): Promise<AgentModeRow[]> {
  if (!ctx.agentPresets?.list) return [{ id: AGENT_PRESET_ID, name: '预设模式' }];
  return (await ctx.agentPresets.list()).map(mode => ({
    id: mode.id,
    name: mode.name ?? mode.id,
    description: mode.description ?? '',
    trust: mode.trust,
    broken: mode.broken ?? null,
  }));
}

export function buildPresetModeComposition(standard: string): string {
  const persona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: ''
    complete: true
    includeRuntimeContext: false

`;
  const pattern = /^- id: persona\r?\n[\s\S]*?(?=^- id: )/m;
  if (!pattern.test(standard)) throw new Error('standard 模式组成中找不到 persona 条目');
  const transformed = standard.replace(pattern, persona).trimEnd();
  if (transformed.includes('dsh-preset-enhance/mode')) return `${transformed}\n`;
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
export async function ensurePresetAgentMode(root: string, standard: string | undefined): Promise<string> {
  const destination = join(root, AGENT_PRESET_ID);
  await mkdir(destination, { recursive: true });
  const composition = standard ? buildPresetModeComposition(standard) :
    await readFile(new URL('agent-mode/agent.cordis.yml', import.meta.url), 'utf8');
  const template = await readFile(new URL('agent-mode/preset.yml', import.meta.url));
  await writeManagedFile(join(destination, 'preset.yml'), template);
  await writeManagedFile(join(destination, 'agent.cordis.yml'), composition);
  return destination;
}

/**
 * Plan and run the preset's prompt-side regex over one text for the workbench test box.
 *
 * The request path runs the same engine through compilePreset; a standalone text box has no history
 * to compile, so this entry hands one segment to the shared worker at the depth the user asked for.
 * That keeps the box inside the same timeout, cancellation and size limits a real request has, and it
 * is deliberately the only extra regex entry: nothing here re-implements matching, replacement or
 * depth windows, and the text is never written to a log - only returned to the caller that supplied it.
 */
function regexTestResult(body: Record<string, any>): Record<string, unknown> {
  const preset = validatePreset(body.preset);
  const options = readPromptRegexOptions(preset);
  const scripts = readRegexScripts(preset);
  const requested: 'user' | 'assistant' | 'prefill' =
    body.target === 'assistant' || body.target === 'prefill' ? body.target : 'user';
  const target: PromptRegexTarget = requested === 'prefill' ? 'assistant' : requested;
  const text = typeof body.text === 'string' ? body.text : '';
  const depth = Number.isInteger(body.depth) ? body.depth
    : requested === 'prefill' ? PREFILL_DEPTH : 0;
  // Same macro context compilePreset builds for a one-message view of the session's values.
  const ctx = createMacroContext({
    local: body.options?.local, global: body.options?.global,
    // Seeded rather than a captured closure, so the worker can replay the macro stream exactly.
    seed: 'regex-test',
    values: {
      user: 'User', char: 'Assistant',
      lastusermessage: requested === 'user' ? text : '',
      lastcharmessage: requested === 'user' ? '' : text,
      lastmessage: text,
      ...body.options?.values,
    },
  });
  const plan = scripts.map((script, index) => {
    const entry = planRegexScript(script, depth);
    return {
      index,
      id: typeof script.id === 'string' ? script.id : '',
      name: regexName(script),
      runs: entry.runs,
      supported: entry.supported,
      targets: entry.targets,
      unsupportedPlacements: entry.unsupportedPlacements,
      reason: entry.reason,
    };
  });
  const notes: string[] = [];
  if (!options.enabled) notes.push('总开关未开启：真实请求不会执行任何规则，下面是规则本身的效果');
  if (requested === 'prefill' && !options.includePrefill) notes.push('未开启“同时处理预填充”：真实请求不会处理预填充');
  // The box always runs the rules so a user can author them; the notes above say whether a real
  // request would run them (the switches are reported, not silently applied).
  const prepared = getRegexRunner().run({
    segments: [{ text, target, depth }],
    scripts,
    seed: ctx.seed,
    draws: ctx.draws,
    local: { ...ctx.local },
    global: { ...ctx.global },
    values: { ...ctx.values },
  });
  const ran = { text: prepared.texts[0] ?? text, applied: prepared.applied };
  const rules = plan.map(entry => ({ ...entry, applicable: entry.runs && entry.targets.includes(target),
    hit: ran.applied.includes(entry.name) }));
  return {
    enabled: options.enabled,
    includePrefill: options.includePrefill,
    target: requested,
    depth,
    appliedTarget: target,
    rules,
    notes,
    result: { before: text, after: ran.text, applied: ran.applied, changed: ran.text !== text },
  };
}

function previewHistory(ctx: PluginContext, body: Record<string, any>): HostMessage[] {
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
async function readJson(req: HostRequest): Promise<Record<string, any>> {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function respond(res: HostResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}
