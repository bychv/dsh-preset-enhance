import { randomBytes } from 'node:crypto';
import type { PluginContext, AgentHandle, HostRequest, HostResponse } from '../host-types.mjs';
import type { PresetState } from './types.mjs';

export const PRESET_READ_BASE = '/preset-enhance/api/v1';
class ReadError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
export function createPresetReader(ctx: PluginContext, readState: () => Promise<PresetState>, currentBinding: (state: PresetState, sessionId: string) => { enabled?: boolean; presetId?: string } | undefined) {
  const grants = new Map<string, { agent: AgentHandle; expiresAt: number }>();
  let closed = false;
  const identity = (agent: AgentHandle | undefined) => {
    if (closed) throw new ReadError(503, 'unavailable', '预设读取服务已停用');
    const id = agent?.session?.id;
    if (!id || ctx.agents?.get(id) !== agent) throw new ReadError(403, 'agent_required', '需要当前宿主 agent 身份');
    return id;
  };
  async function read(agent: AgentHandle, query: { action?: unknown; id?: unknown; offset?: unknown; limit?: unknown }, signal?: AbortSignal) {
    const sessionId = identity(agent);
    signal?.throwIfAborted();
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(k => !['action', 'id', 'offset', 'limit'].includes(k))) throw new ReadError(400, 'invalid_query', '不支持的查询参数');
    const action = query.action ?? 'current';
    if (!['list', 'get', 'current'].includes(String(action))) throw new ReadError(400, 'invalid_action', '仅支持 list/get/current');
    const state = await readState();
    identity(agent); signal?.throwIfAborted();
    const base = { apiVersion: 1, revision: state.revision };
    if (action === 'list') {
      const offset = query.offset ?? 0, limit = query.limit ?? 25;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ReadError(400, 'invalid_page', 'offset 必须非负，limit 为 1–100');
      const items = state.presets.slice(offset as number, (offset as number) + (limit as number)).map(p => ({ id: p.id, name: p.name, promptCount: p.preset.prompts.length }));
      return { ...base, items, total: state.presets.length, nextOffset: (offset as number) + items.length < state.presets.length ? (offset as number) + items.length : null };
    }
    if (action === 'get') {
      if (typeof query.id !== 'string' || !query.id) throw new ReadError(400, 'id_required', '需要预设 id');
      const record = state.presets.find(p => p.id === query.id);
      if (!record) throw new ReadError(404, 'preset_not_found', '预设不存在');
      return { ...base, preset: { id: record.id, name: record.name, content: structuredClone(record.preset) } };
    }
    const binding = currentBinding(state, sessionId);
    return { ...base, sessionId, enabled: binding?.enabled === true, presetId: binding?.presetId ?? null, selectedPresetId: state.selectedPresetId ?? null };
  }
  const service = Object.freeze({ apiVersion: 1, read,
    issueHttpAccess(agent: AgentHandle) {
      identity(agent);
      for (const [key, grant] of grants) if (grant.expiresAt <= Date.now() || grant.agent === agent) grants.delete(key);
      if (grants.size >= 256) throw new ReadError(429, 'grant_limit', '读取凭证数量已达上限');
      const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 300_000;
      grants.set(token, { agent, expiresAt });
      return { basePath: PRESET_READ_BASE, token, expiresAt };
    },
  });
  const handler = async (req: HostRequest, res: HostResponse) => {
    const respond = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'GET') throw new ReadError(405, 'read_only', '此 API 仅支持 GET');
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const grant = grants.get(token);
      if (!grant || grant.expiresAt <= Date.now()) { grants.delete(token); throw new ReadError(401, 'access_required', '需要有效的内部读取凭证；外部访问未开放'); }
      identity(grant.agent);
      const url = new URL(req.url ?? '', 'http://preset.local');
      const path = url.pathname.slice(PRESET_READ_BASE.length);
      let query: { action: string; id?: string; offset?: number; limit?: number };
      if (path === '/current') query = { action: 'current' };
      else if (path === '/presets') query = { action: 'list' };
      else if (/^\/presets\/[^/]+$/.test(path)) query = { action: 'get', id: decodeURIComponent(path.slice('/presets/'.length)) };
      else throw new ReadError(404, 'route_not_found', '接口不存在');
      for (const key of url.searchParams.keys()) {
        if (query.action !== 'list' || !['offset', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1 || !/^\d+$/.test(url.searchParams.get(key)!)) throw new ReadError(400, 'invalid_query', '不支持的查询参数');
        query[key as 'offset' | 'limit'] = Number(url.searchParams.get(key));
      }
      respond(200, await read(grant.agent, query));
    } catch (error) {
      const known = error instanceof ReadError;
      respond(known ? error.status : 500, { apiVersion: 1, error: { code: known ? error.code : 'internal_error', message: known ? error.message : '读取预设失败' } });
    }
  };
  const tool = { name: 'preset_read', description: '只读查看预设：list 列出预设，get 按 id 获取保存的预设内容，current 查看当前会话启用状态。不修改预设，不解析动态模板。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'current'] }, id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: any, exec: { agent?: AgentHandle; signal?: AbortSignal }) { identity(exec.agent); return JSON.stringify(await read(exec.agent!, args, exec.signal)); },
    isConcurrencySafe: () => true,
  };
  return { service, handler, tool, close() { closed = true; grants.clear(); } };
}
