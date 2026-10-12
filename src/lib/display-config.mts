import { randomUUID, createHash } from 'node:crypto';
import { buildChatDepths, readRegexScripts } from './prompt-regex.mjs';
import type { PresetStore } from './store.mjs';
import type { PresetState, PresetBinding } from './types.mjs';
import type { PluginContext, HostRequest, HostResponse } from '../host-types.mjs';

/** Authenticated browser configuration; intentionally excludes preset text and history. */
export function installDisplayConfig(ctx: PluginContext, store: PresetStore,
  available: () => boolean, bindingOf: (state: PresetState, sessionId: string) => PresetBinding | undefined) {
  const instance = randomUUID();
  const closers = new Set<() => void>();
  const snapshot = (state: PresetState, sessionId: string) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) throw new Error('会话不存在');
    const binding = bindingOf(state, sessionId);
    const record = state.presets.find(p => p.id === binding?.presetId);
    const namespace = (record?.preset.extensions as Record<string, any> | undefined)?.['dsh-preset-enhance'] as Record<string, any> | undefined;
    const cached = state.sessions[sessionId];
    const value = { apiVersion: 1, instance, sessionId, presetId: record?.id ?? null,
      enabled: namespace?.displayRegex?.enabled === true,
      scripts: record ? readRegexScripts(record.preset) : [],
      local: cached?.presetId === record?.id ? cached?.result.local ?? {} : {}, global: state.global,
      values: { user: 'User', char: 'Assistant', ...binding?.values },
      depths: Object.fromEntries(buildChatDepths(session.deriveMessages?.() ?? [])),
    };
    return { ...value, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  };
  const json = (res: HostResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  for (const streaming of [false, true]) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/preset-enhance/api/display' + (streaming ? '-events' : ''),
    handler: async (req: HostRequest, res: HostResponse) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      if (!available()) return json(res, 503, { error: '预设服务不可用' });
      const sessionId = new URL(String(req.url ?? ''), 'http://preset.local').searchParams.get('sessionId') ?? '';
      if (!sessionId || !ctx.sessions.get(sessionId)) return json(res, 400, { error: '需要有效会话' });
      if (!streaming || !res.write) {
        try { return json(res, 200, snapshot(await store.read(), sessionId)); }
        catch { return json(res, 503, { error: '显示配置不可用' }); }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      let closed = false, last = '', seen = -1;
      const send = (state: PresetState) => {
        if (closed || !available() || state.revision < seen) return;
        seen = state.revision;
        try {
          const value = snapshot(state, sessionId);
          if (value.revision !== last) { last = value.revision; res.write!('data: ' + JSON.stringify(value) + '\n\n'); }
        } catch { close(); }
      };
      const unsubscribe = store.subscribe(send);
      const timer = setInterval(() => { if (!available()) close(); else res.write!(': keepalive\n\n'); }, 15000);
      const close = () => { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); closers.delete(close); res.end(); };
      closers.add(close); res.on?.('close', close);
      try { send(await store.read()); } catch { close(); }
    },
  }), 'preset-enhance: display configuration');
  ctx.effect(() => () => { for (const close of [...closers]) close(); }, 'preset-enhance: display cleanup');
}
