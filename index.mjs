import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PresetStore } from './lib/store.mjs';
import { compilePreset, validatePreset, getOrder } from './lib/preset.mjs';
import { decodePresetDocument, encodePresetPackage, attachPrefillSettings, applyPackagePrefill } from './lib/preset-package.mjs';
import { installDeepSeekBetaBridge } from './lib/deepseek-beta.mjs';
import {
  normalizeToolGroups, normalizeToolPreset, normalizeToolSelection, assertPresetGroupIds,
  toolPolicySnapshot, effectiveToolEnabled, effectiveToolPolicy, remapToolPackage,
  presetReferenceCounts, unresolvedToolRefs, resetPresetSelections, exportToolsSection, TOOL_PRESET_LIMIT,
} from './lib/tool-presets.mjs';

export const name = 'preset-enhance';
export const inject = ['llm', 'sessions', 'webServer', 'commands', 'tools', 'agentPresets', 'agents'];
export const AGENT_PRESET_ID = 'st-preset';
const BASE = '/preset-enhance';
const DSH_SYSTEM_PROMPT = '@deepseek-ai/dsh-system-prompt';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PRESET_COMPILER_VERSION = 3;
const ownGet = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const assign = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
/** Actions that need the DSH mode registry; catalog-backed ones also enumerate mode tools. */
const MODE_ACTIONS = new Set(['save-auto-modes', 'save-mode-tools', 'save-session-tools',
  'save-tool-groups', 'save-tool-preset', 'select-tool-policy', 'import-package-tools']);
const CATALOG_ACTIONS = new Set(['save-mode-tools', 'save-session-tools',
  'save-tool-groups', 'save-tool-preset', 'import-package-tools']);

export async function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const store = new PresetStore(resolve(config.dataFile ?? join(home, 'preset-enhance', 'state.json')));
  const routed = new WeakSet();
  const deepSeekBeta = installDeepSeekBetaBridge(ctx);
  const standard = config.standardComposition ??
    (ctx.agentPresets ? (await ctx.agentPresets.readDocument('standard')).content : undefined);
  await ensurePresetAgentMode(resolve(config.agentPresetRoot ?? join(home, '.agent-presets')), standard);

  let policySnapshot = toolPolicySnapshot(await store.read());
  const refreshPolicies = state => { policySnapshot = toolPolicySnapshot(state); };
  if (ctx.tools?.guard) ctx.effect(() => ctx.tools.guard(exec => {
    const session = exec.agent?.session;
    if (!session) return;
    if (effectiveToolEnabled(policySnapshot, session.id, sessionModeId(session), exec.name) !== false) return;
    return `工具 ${exec.name} 已在预设工作台中关闭`;
  }), 'preset-enhance: tool policy guard');
  if (ctx.commands?.register) ctx.effect(() => ctx.commands.register(presetCommand(store)), 'preset-enhance: /preset');

  ctx.on('llm/stream', async function* (options, next) {
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : undefined;
    if (routed.has(options) || options.purpose || !session) { yield* next(); return; }

    const modeId = sessionModeId(session);
    const exclusive = modeId === AGENT_PRESET_ID;
    const history = exclusive ? presetModeHistory(options.messages) : options.messages;
    const observed = catalogFromTools(options.tools);
    const initial = await store.read();
    refreshPolicies(initial);
    const explicit = ownGet(initial.bindings, options.sessionId);
    const wantsPreset = explicit?.enabled ||
      (!explicit && shouldAutoEnable(initial, session) && defaultRecord(initial));
    const catalogChanged = observed.length > 0 && !sameCatalog(initial.toolCatalogs[modeId] ?? [], observed);
    let compiled = null;

    if (wantsPreset || catalogChanged) {
      compiled = await store.transaction(current => {
        let changed = false;
        if (observed.length > 0 && syncToolCatalog(current, modeId, observed)) changed = true;
        let binding = ownGet(current.bindings, options.sessionId);
        if (!binding && shouldAutoEnable(current, session)) {
          const record = defaultRecord(current);
          if (record) {
            binding = { enabled: true, presetId: record.id, characterId: null, values: {}, markers: {} };
            assign(current.bindings, options.sessionId, binding);
            changed = true;
          }
        }
        if (changed) current.revision++;
        refreshPolicies(current);
        if (!binding?.enabled) return null;
        const record = current.presets.find(p => p.id === binding.presetId);
        if (!record) throw new Error('当前会话启用的预设不存在');
        const postToolPrefix = current.deepseekBetaPrefix && current.postToolPrefixMode === 'custom'
          ? current.postToolPrefixText : undefined;
        const key = digest({ compiler: PRESET_COMPILER_VERSION, messages: history, preset: record, binding, postToolPrefix });
        const prior = ownGet(current.sessions, options.sessionId);
        if (prior?.key === key) return prior.result;
        const result = compilePreset(record.preset, history, {
          ...binding, seed: key, local: prior?.result.local, global: current.global, postToolPrefix,
        });
        options.signal?.throwIfAborted();
        current.global = result.global;
        assign(current.sessions, options.sessionId, {
          key, at: new Date().toISOString(), presetId: record.id, result,
        });
        return result;
      });
    }

    const policy = effectiveToolPolicy(policySnapshot, options.sessionId, modeId, options.tools);
    const filteredTools = filterTools(options.tools, policy);
    const toolsChanged = (options.tools?.length ?? 0) !== filteredTools.length;
    const messages = compiled?.messages ?? history;
    const messagesChanged = compiled !== null || messages !== options.messages;
    if (!toolsChanged && !messagesChanged) { yield* next(); return; }

    const request = routedRequest(options, messages, filteredTools);
    const betaPrefix = initial.deepseekBetaPrefix === true && compiled?.assistantPrefix?.active === true;
    const releaseBeta = betaPrefix ? deepSeekBeta.activate(options.sessionId, messageText(messages.at(-1)), {
      toolCalls: initial.prefixToolCalls === true,
      removeNonOfficialTools: initial.prefixNonOfficialRemoveTools !== false,
    }) : () => {};
    routed.add(request);
    try { yield* ctx.llm.stream(request); } finally { releaseBeta(); routed.delete(request); }
  });

  const assets = new Map([
    [BASE, ['web/index.html', 'text/html']],
    [`${BASE}/editor.js`, ['web/editor.js', 'text/javascript']],
    [`${BASE}/tool-labels.js`, ['web/tool-labels.js', 'text/javascript']],
    [`${BASE}/editor.css`, ['web/editor.css', 'text/css']],
  ]);
  for (const [path, [file, mime]] of assets) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req, res) => {
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
    kind: 'exact', path: `${BASE}/api`, handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://preset.local');
        if (req.method === 'GET') {
          const state = await store.read();
          refreshPolicies(state);
          const sessionId = url.searchParams.get('sessionId') ?? '';
          const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
          const fallback = !ownGet(state.bindings, sessionId) && shouldAutoEnable(state, session) ?
            defaultBinding(state) : undefined;
          const modeDefault = defaultRecord(state);
          const modes = await agentModeRows(ctx);
          const discovered = await discoverModeToolCatalogs(ctx, modes);
          const liveMode = sessionModeId(session);
          const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, sessionId);
          return respond(res, 200, {
            revision: state.revision,
            presets: state.presets,
            binding: ownGet(state.bindings, sessionId) ?? fallback ?? { enabled: false },
            selectedPresetId: state.selectedPresetId ?? modeDefault?.id ?? null,
            postToolPrefixMode: state.postToolPrefixMode,
            postToolPrefixText: state.postToolPrefixText,
            deepseekBetaPrefix: state.deepseekBetaPrefix === true,
            prefixToolCalls: state.prefixToolCalls === true,
            prefixNonOfficialRemoveTools: state.prefixNonOfficialRemoveTools !== false,
            modeDefaultPresetId: modeDefault?.id ?? null,
            modeDefaultName: modeDefault?.name ?? null,
            presetMode: liveMode === AGENT_PRESET_ID,
            sessionMode: liveMode,
            agentModes: modes,
            autoEnableModes: state.autoEnableModes,
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
          });
        }
        if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('需要 application/json');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error('拒绝跨来源写入');
        const body = await readJson(req);
        if (body.action === 'preview') {
          return respond(res, 200, compilePreset(body.preset, previewHistory(ctx, body), {
            ...body.options, seed: 'preview',
          }));
        }

        if (body.action === 'export-package') {
          const state = await store.read();
          if (body.revision !== state.revision) throw new Error('预设已被其他窗口更新，请重新加载后再导出');
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
        const knownModes = needsModes ? new Set(modeRows.map(mode => mode.id)) : null;
        const discovered = CATALOG_ACTIONS.has(body.action) ?
          await discoverModeToolCatalogs(ctx, modeRows) : null;

        if (body.action === 'save-tool-groups') {
          const state = await store.read();
          const catalogs = requestToolCatalogs(
            ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
          const groups = normalizeToolGroups(body.groups, { catalogs, existing: state.toolGroups });
          const warnings = unresolvedWarnings(unresolvedToolRefs({ toolGroups: groups }, catalogs));
          return respond(res, 200, await store.transaction(current => {
            assertRevision(current, body);
            current.toolGroups = groups;
            current.revision++;
            refreshPolicies(current);
            return { groups: current.toolGroups, warnings };
          }));
        }

        if (body.action === 'save-tool-preset') {
          if (!isRecord(body.preset)) throw new Error('工具预设必须是对象');
          const state = await store.read();
          const requestedId = typeof body.id === 'string' && body.id ? body.id
            : typeof body.preset.id === 'string' && body.preset.id ? body.preset.id : null;
          const existing = requestedId ? state.toolPresets.find(preset => preset.id === requestedId) : undefined;
          if (!existing && state.toolPresets.length >= TOOL_PRESET_LIMIT) {
            throw new Error(`工具预设最多 ${TOOL_PRESET_LIMIT} 个`);
          }
          const preset = normalizeToolPreset({ ...body.preset, id: existing ? requestedId : null });
          assertPresetGroupIds(preset, state.toolGroups);
          const record = { ...preset, id: existing ? requestedId : randomUUID() };
          const warnings = unresolvedWarnings(
            unresolvedToolRefs({ toolPresets: [record] }, requestToolCatalogs(
              ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '')));
          return respond(res, 200, await store.transaction(current => {
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
          const state = await store.read();
          if (!state.toolPresets.some(preset => preset.id === body.id)) throw new Error('请选择要删除的工具预设');
          return respond(res, 200, await store.transaction(current => {
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
          const state = await store.read();
          let key;
          let id;
          let selection;
          if (body.scope === 'mode') {
            if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId)) throw new Error('请选择有效的 DSH 模式');
            key = 'modeToolSelections';
            id = body.modeId;
            selection = normalizeToolSelection(body.selection, 'mode');
          } else if (body.scope === 'session') {
            const session = typeof body.sessionId === 'string' ? ctx.sessions.get(body.sessionId) : undefined;
            if (!session) throw new Error('缺少有效的会话 ID');
            key = 'sessionToolSelections';
            id = body.sessionId;
            selection = normalizeToolSelection(body.selection, 'session');
          } else {
            throw new Error('未知的工具策略范围');
          }
          if (selection.kind === 'preset' &&
            !state.toolPresets.some(preset => preset.id === selection.presetId)) {
            throw new Error('请选择有效的工具预设');
          }
          return respond(res, 200, await store.transaction(current => {
            assertRevision(current, body);
            assign(current[key], id, selection);
            current.revision++;
            refreshPolicies(current);
            return { selection };
          }));
        }

        if (body.action === 'save-mode-tools') {
          if (typeof body.modeId !== 'string' || !knownModes.has(body.modeId)) throw new Error('请选择有效的 DSH 模式');
          const state = await store.read();
          const catalogs = requestToolCatalogs(
            ctx, state, discovered.catalogs, url.searchParams.get('sessionId') ?? '');
          const policy = validateToolPolicy(body.policy, catalogs[body.modeId]);
          const selection = { kind: 'custom' };
          return respond(res, 200, await store.transaction(current => {
            assertRevision(current, body);
            assign(current.modeToolPolicies, body.modeId, policy);
            assign(current.modeToolSelections, body.modeId, selection);
            current.revision++;
            refreshPolicies(current);
            return { modeId: body.modeId, selection };
          }));
        }

        if (body.action === 'save-session-tools') {
          const session = typeof body.sessionId === 'string' ? ctx.sessions.get(body.sessionId) : undefined;
          if (!session) throw new Error('缺少有效的会话 ID');
          const modeId = sessionModeId(session);
          if (!knownModes.has(modeId)) throw new Error('当前会话没有可识别的 DSH 模式');
          const inherit = body.inherit === true;
          const state = await store.read();
          const catalogs = requestToolCatalogs(ctx, state, discovered.catalogs, body.sessionId);
          const policy = inherit ? null : validateToolPolicy(body.policy, catalogs[modeId]);
          return respond(res, 200, await store.transaction(current => {
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
            return { inherited: inherit };
          }));
        }

        if (body.action === 'import-package-tools') {
          const state = await store.read();
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
          return respond(res, 200, await store.transaction(current => {
            assertRevision(current, body);
            current.toolGroups.push(...plan.tools.groups);
            current.toolPresets.push(...plan.tools.presets);
            current.revision++;
            refreshPolicies(current);
            return { applied: true, stats: plan.stats, groups: plan.tools.groups, presets: plan.tools.presets };
          }));
        }

        const result = await store.transaction(state => {
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
            if (old) state.presets[state.presets.indexOf(old)] = record;
            else state.presets.push(record);
            state.selectedPresetId = record.id;
            state.defaultPresetId = record.id;
            state.revision++;
            return { id: record.id };
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
            state.selectedPresetId = record.id;
            state.defaultPresetId = record.id;
            state.revision++;
            return { id: record.id };
          }
          if (body.action === 'select-preset') {
            const record = state.presets.find(p => p.id === body.id);
            if (!record) throw new Error('请选择有效的预设');
            state.selectedPresetId = record.id;
            state.defaultPresetId = record.id;
            state.revision++;
            return { id: record.id };
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
              enabled: state.deepseekBetaPrefix,
              toolCalls: state.prefixToolCalls === true,
              removeNonOfficialTools: state.prefixNonOfficialRemoveTools !== false,
            };
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
            return { modes: selected };
          }
          if (body.action === 'bind') {
            validateBinding(state, body);
            state.revision++;
            return { ok: true };
          }
          throw new Error('未知操作');
        });
        respond(res, 200, result);
      } catch (error) {
        respond(res, 400, { error: error.message });
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
  if (body.binding?.enabled && !record) throw new Error('请先保存并选择预设');
  if (record) getOrder(record.preset, body.binding.characterId);
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
    handler: async invocation => {
      const input = invocation.rawInput.trim().toLowerCase();
      if (!['', 'on', 'off', 'status'].includes(input)) {
        return { kind: 'error', text: '用法：/preset [on|off|status]' };
      }
      const session = invocation.agent.session;
      const before = await store.read();
      const explicit = ownGet(before.bindings, session.id);
      const enabled = explicit?.enabled ?? (shouldAutoEnable(before, session) && !!defaultRecord(before));
      if (input === 'status') {
        const record = explicit?.presetId ? before.presets.find(p => p.id === explicit.presetId) : defaultRecord(before);
        return { kind: 'success', text: `预设注入：${enabled ? '已开启' : '已关闭'}${record ? `（${record.name}）` : ''}` };
      }
      const target = input === 'on' ? true : input === 'off' ? false : !enabled;
      return await store.transaction(state => {
        const current = ownGet(state.bindings, session.id);
        const record = current?.presetId ? state.presets.find(p => p.id === current.presetId) : defaultRecord(state);
        if (target && !record) return { kind: 'error', text: '尚未保存模式默认预设，请先在预设工作台中设置。' };
        assign(state.bindings, session.id, {
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
  if (!session) return '';
  let selected = session.header?.agentPreset ?? '';
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type === 'agent-preset/selected') selected = event.data?.agentPreset ?? '';
  }
  return selected;
}
function shouldAutoEnable(state, session) {
  if (!session) return false;
  const modeId = sessionModeId(session);
  if (!state.autoEnableModes.includes(modeId)) return false;
  const since = Number(state.autoEnableSince[modeId] ?? 0);
  const createdAt = Number(session.header?.createdAt ?? Number.POSITIVE_INFINITY);
  return createdAt >= since;
}
function presetModeHistory(messages) {
  return messages.filter(message => message.role !== 'system' &&
    !(message.source?.kind === 'plugin' && message.source.plugin === DSH_SYSTEM_PROMPT));
}

/** Live catalogs plus the last catalog seen for each mode, so a removed plugin is not silently forgotten. */
function knownToolCatalogs(state, discovered) {
  const catalogs = {};
  for (const source of [state?.toolCatalogs, discovered]) {
    for (const [modeId, catalog] of Object.entries(source ?? {})) {
      if (Array.isArray(catalog)) assign(catalogs, modeId, catalog);
    }
  }
  return catalogs;
}
/** Match GET's catalog view for writes opened from a live conversation. */
function requestToolCatalogs(ctx, state, discovered, sessionId) {
  const catalogs = knownToolCatalogs(state, discovered);
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  const modeId = sessionModeId(session);
  const live = liveToolCatalog(ctx, sessionId);
  if (live.length > 0 && modeId) assign(catalogs, modeId, live);
  return catalogs;
}
/** Group DSH MCP public tool names by their stable server namespace. */
export function mcpToolGroups(catalogs) {
  const result = {};
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
function unresolvedWarnings(refs) {
  return refs.length > 0
    ? [`${refs.length} 条工具引用在当前模式目录中不存在，已保留待插件恢复后重新匹配`]
    : [];
}
function assertRevision(state, body) {
  if (body.revision !== state.revision) throw new Error('预设已被其他窗口更新，请重新加载后再保存');
}
function validateToolPolicy(value, catalog) {
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
function catalogFromTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => ({
    name: String(tool.name),
    description: String(tool.description ?? '').slice(0, 500),
  })).filter(tool => tool.name.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}
function sameCatalog(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function syncToolCatalog(state, modeId, observed) {
  if (!modeId || sameCatalog(state.toolCatalogs[modeId] ?? [], observed)) return false;
  assign(state.toolCatalogs, modeId, observed);
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
      if (!ctx.agentPresets?.standingKeyFor || !ctx.tools?.schemas) {
        throw new Error('当前 DSH 未提供模式工具枚举服务');
      }
      const scope = await ctx.agentPresets.standingKeyFor(mode.id);
      assign(catalogs, mode.id, catalogFromTools(ctx.tools.schemas(scope)));
    } catch (error) {
      assign(errors, mode.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { catalogs, errors };
}

function liveToolCatalog(ctx, sessionId) {
  if (!sessionId) return [];
  try {
    const agent = ctx.agents?.get?.(sessionId);
    return agent?.ctx?.tools?.schemas ? catalogFromTools(agent.ctx.tools.schemas(agent)) : [];
  } catch {
    return [];
  }
}
async function agentModeRows(ctx) {
  if (!ctx.agentPresets?.list) return [{ id: AGENT_PRESET_ID, name: '预设模式' }];
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
  if (!pattern.test(standard)) throw new Error('standard 模式组成中找不到 persona 条目');
  const transformed = standard.replace(pattern, persona).trimEnd();
  if (transformed.includes('dsh-preset-enhance/mode')) return `${transformed}\n`;
  return `${transformed}

- id: preset-enhance-mode
  name: dsh-preset-enhance/mode
`;
}

export async function ensurePresetAgentMode(root, standard) {
  const destination = join(root, AGENT_PRESET_ID);
  await mkdir(destination, { recursive: true });
  const composition = standard ? buildPresetModeComposition(standard) :
    await readFile(new URL('agent-mode/agent.cordis.yml', import.meta.url), 'utf8');
  await writeFile(join(destination, 'preset.yml'), await readFile(new URL('agent-mode/preset.yml', import.meta.url)));
  await writeFile(join(destination, 'agent.cordis.yml'), composition);
  return destination;
}

function previewHistory(ctx, body) {
  const session = ctx.sessions.get(body.sessionId);
  const derived = session?.deriveMessages() ?? [];
  const history = sessionModeId(session) === AGENT_PRESET_ID ? presetModeHistory(derived) : derived;
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
    if (size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
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
