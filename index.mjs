import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PresetStore } from './lib/store.mjs';
import { compilePreset, validatePreset, getOrder } from './lib/preset.mjs';

export const name = 'preset-enhance';
export const inject = ['llm', 'sessions', 'webServer'];
export const AGENT_PRESET_ID = 'st-preset';
const BASE = '/preset-enhance';
const DSH_SYSTEM_PROMPT = '@deepseek-ai/dsh-system-prompt';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownGet = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const assign = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

export async function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const store = new PresetStore(resolve(config.dataFile ?? join(home, 'preset-enhance', 'state.json')));
  const routed = new WeakSet();
  await ensurePresetAgentMode(resolve(config.agentPresetRoot ?? join(home, '.agent-presets')));

  ctx.on('llm/stream', async function* (options, next) {
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : undefined;
    if (routed.has(options) || options.purpose || !session) { yield* next(); return; }
    const state = await store.read();
    const explicit = ownGet(state.bindings, options.sessionId);
    if (!(explicit?.enabled || (!explicit && isPresetMode(session) && defaultRecord(state)))) { yield* next(); return; }
    const exclusive = isPresetMode(session);
    const history = exclusive ? presetModeHistory(options.messages) : options.messages;
    const result = await store.transaction(current => {
      let binding = ownGet(current.bindings, options.sessionId);
      if (!binding && isPresetMode(session)) {
        const record = defaultRecord(current);
        if (!record) return null;
        binding = { enabled: true, presetId: record.id, characterId: null, values: {}, markers: {} };
        assign(current.bindings, options.sessionId, binding);
        current.revision++;
      }
      if (!binding?.enabled) return null;
      const record = current.presets.find(p => p.id === binding.presetId);
      if (!record) throw new Error('当前会话启用的预设不存在');
      const key = digest({ messages: history, preset: record, binding });
      const prior = ownGet(current.sessions, options.sessionId);
      // A provider retry reuses the exact expansion and variable state, including RNG.
      if (prior?.key === key) return prior.result;
      const compiled = compilePreset(record.preset, history, {
        ...binding, seed: key, local: prior?.result.local, global: current.global,
      });
      options.signal?.throwIfAborted();
      current.global = compiled.global;
      assign(current.sessions, options.sessionId, { key, at: new Date().toISOString(), presetId: record.id, result: compiled });
      return compiled;
    });
    if (!result) { yield* next(); return; }
    // Never mutate the frozen loop request. This is an explicit nested routing call.
    // The sidecar stores its exact message plan before dispatch for inspection/retry.
    const request = exclusive ? withoutTools(options, result.messages) : Object.freeze({ ...options, messages: result.messages });
    routed.add(request);
    try { yield* ctx.llm.stream(request); } finally { routed.delete(request); }
  });

  const assets = new Map([
    [BASE, ['web/index.html', 'text/html']],
    [`${BASE}/editor.js`, ['web/editor.js', 'text/javascript']],
    [`${BASE}/editor.css`, ['web/editor.css', 'text/css']],
  ]);
  for (const [path, [file, mime]] of assets) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path,
    handler: async (req, res) => {
      if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
      res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'" });
      res.end(await readFile(new URL(file, import.meta.url)));
    },
  }), `preset-enhance: ${path}`);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${BASE}/api`, handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://preset.local');
      if (req.method === 'GET') {
        const state = await store.read(), sessionId = url.searchParams.get('sessionId') ?? '';
        const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
        const fallback = !ownGet(state.bindings, sessionId) && isPresetMode(session) ? defaultBinding(state) : undefined;
        const modeDefault = defaultRecord(state);
        return respond(res, 200, { revision: state.revision, presets: state.presets,
          binding: ownGet(state.bindings, sessionId) ?? fallback ?? { enabled: false },
          modeDefaultPresetId: modeDefault?.id ?? null, modeDefaultName: modeDefault?.name ?? null,
          presetMode: isPresetMode(session), last: ownGet(state.sessions, sessionId) ?? null });
      }
      if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
      // Host owns authentication; require JSON and same-origin writes as an extra CSRF boundary.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('需要 application/json');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error('拒绝跨来源写入');
      const body = await readJson(req);
      if (body.action === 'preview') {
        return respond(res, 200, compilePreset(body.preset, previewHistory(ctx, body), { ...body.options, seed: 'preview' }));
      }
      const result = await store.transaction(state => {
        if (body.revision !== state.revision) throw new Error('预设已被其他窗口更新，请重新加载后再保存');
        if (body.action === 'save') {
          validatePreset(body.preset);
          const old = state.presets.find(p => p.id === body.id);
          const record = { id: old?.id ?? randomUUID(), name: String(body.name || '未命名预设').slice(0, 200), preset: body.preset };
          if (old) state.presets[state.presets.indexOf(old)] = record; else state.presets.push(record);
          state.defaultPresetId ||= record.id;
          state.revision++; return { id: record.id };
        }
        if (body.action === 'set-default') {
          const record = state.presets.find(p => p.id === body.id);
          if (!record) throw new Error('请先保存并选择预设');
          state.defaultPresetId = record.id;
          state.revision++; return { id: record.id };
        }
        if (body.action === 'bind') {
          if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200) throw new Error('缺少有效的会话 ID');
          const record = state.presets.find(p => p.id === body.binding?.presetId);
          if (body.binding?.enabled && !record) throw new Error('请先保存并选择预设');
          if (record) getOrder(record.preset, body.binding.characterId);
          const values = body.binding?.values ?? {}, markers = body.binding?.markers ?? {};
          for (const map of [values, markers]) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(v => typeof v !== 'string')) throw new Error('角色变量和标记内容必须是文本映射');
          assign(state.bindings, body.sessionId, { enabled: body.binding.enabled === true, presetId: record?.id ?? '',
            characterId: body.binding.characterId ?? null, values, markers });
          state.revision++; return { ok: true };
        }
        throw new Error('未知操作');
      });
      respond(res, 200, result);
    } catch (error) { respond(res, 400, { error: error.message }); }
  } }), 'preset-enhance: API');
}

function defaultRecord(state) {
  return state.presets.find(p => p.id === state.defaultPresetId) ?? state.presets[0];
}
function defaultBinding(state) {
  const record = defaultRecord(state);
  return record ? { enabled: true, presetId: record.id, characterId: null, values: {}, markers: {}, inherited: true } : undefined;
}
function isPresetMode(session) {
  if (!session) return false;
  let selected = session.header?.agentPreset;
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type === 'agent-preset/selected') selected = event.data?.agentPreset;
  }
  return selected === AGENT_PRESET_ID;
}
function presetModeHistory(messages) {
  return messages.filter(message => message.role !== 'system' &&
    !(message.source?.kind === 'plugin' && message.source.plugin === DSH_SYSTEM_PROMPT));
}
function withoutTools(options, messages) {
  const { tools: _tools, ...request } = options;
  return Object.freeze({ ...request, messages });
}

export async function ensurePresetAgentMode(root) {
  const destination = join(root, AGENT_PRESET_ID);
  await mkdir(destination, { recursive: true });
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    await writeFile(join(destination, file), await readFile(new URL(`agent-mode/${file}`, import.meta.url)));
  }
  return destination;
}

function previewHistory(ctx, body) {
  const session = ctx.sessions.get(body.sessionId);
  const derived = session?.deriveMessages() ?? [];
  const history = isPresetMode(session) ? presetModeHistory(derived) : derived;
  return body.input ? [...history, { id: 'preview-user', role: 'user', content: [{ type: 'text', text: String(body.input) }], source: { kind: 'user' } }] : history;
}
async function readJson(req) {
  const parts = []; let size = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part); size += bytes.length;
    if (size > 8_000_000) throw new Error('预设文件不能超过 8 MB');
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
