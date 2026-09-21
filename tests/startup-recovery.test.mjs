import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';
import {
  clearPresetEnhanceUnavailableReason, isPresetEnhanceActive, presetEnhanceUnavailableReason,
  PRESET_ENHANCE_INACTIVE_REASON, setPresetEnhanceUnavailableReason,
} from '../lib/availability.mjs';

/**
 * A failed startup must degrade the plugin, never throw: the plugin is a required
 * root bundle entry, so throwing kills the whole host (no web UI to repair from).
 */
function harness() {
  const listeners = {};
  const routes = new Map();
  const ctx = {
    sessions: { get: () => undefined },
    on: (name, fn) => { listeners[name] = fn; },
    effect: fn => { fn(); },
    webServer: { register: definition => { routes.set(definition.path, definition); return () => {}; } },
    llm: { stream: options => listeners['llm/stream'](options, async function* () {}) },
  };
  return { ctx, routes };
}

function fakeResponse() {
  return {
    status: 0, body: '', headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(body) { this.body = String(body); },
  };
}

const emptyRequest = () => ({ [Symbol.asyncIterator]: async function* () {} });

test('a corrupted state file degrades the plugin instead of bricking the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-degraded-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"version":1,"revision":');
    const before = await readFile(file);
    const { ctx, routes } = harness();

    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });

    assert.equal(isPresetEnhanceActive(), false, 'a plugin that cannot inject must not claim availability');
    assert.match(presetEnhanceUnavailableReason(), /无法读取状态文件/);
    assert.deepEqual(await readFile(file), before, 'recovery must never clear user data');

    const api = routes.get('/preset-enhance/api');
    assert.ok(api, 'the workbench API must stay mounted so the reason is visible');

    const get = fakeResponse();
    await api.handler({ method: 'GET', url: '/preset-enhance/api', headers: {}, ...emptyRequest() }, get);
    assert.equal(get.status, 200);
    const payload = JSON.parse(get.body);
    assert.match(payload.startupError, /无法读取状态文件/);
    assert.deepEqual(payload.presets, []);
    assert.equal(payload.binding.enabled, false);

    const post = fakeResponse();
    await api.handler({
      method: 'POST', url: '/preset-enhance/api',
      headers: { 'content-type': 'application/json' }, ...emptyRequest(),
    }, post);
    assert.equal(post.status, 503, 'writes are refused while degraded');
    assert.match(JSON.parse(post.body).error, /无法读取状态文件/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failing standard read degrades and names the stage, the path and the cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-degraded-standard-'));
  try {
    const { ctx } = harness();
    ctx.agentPresets = { readDocument: async () => { throw new Error('ENOENT: standard composition missing'); } };

    await apply(ctx, { dataFile: join(dir, 'state.json'), agentPresetRoot: join(dir, '.agent-presets') });

    assert.equal(isPresetEnhanceActive(), false);
    assert.match(presetEnhanceUnavailableReason(), /standard 模式组成/);
    assert.match(presetEnhanceUnavailableReason(), /ENOENT: standard composition missing/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a clean startup claims availability and clears a previous failure reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-recovered-'));
  try {
    setPresetEnhanceUnavailableReason('预设工作台初始化失败：上一次启动失败');
    const { ctx } = harness();

    await apply(ctx, { dataFile: join(dir, 'state.json'), agentPresetRoot: join(dir, '.agent-presets') });

    assert.equal(isPresetEnhanceActive(), true);
    assert.equal(presetEnhanceUnavailableReason(), PRESET_ENHANCE_INACTIVE_REASON);
  } finally {
    clearPresetEnhanceUnavailableReason();
    await rm(dir, { recursive: true, force: true });
  }
});
