import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';
import { PRESET_TEMPLATES_SERVICE } from 'dsh-preset-enhance/templates';

const definition = providerId => ({ providerId, title: providerId, templates: [{
  id: 'format', version: '1', title: '格式模板', role: 'system',
  content: '{{setglobalvar::must_not_run::1}}说明',
}] });

test('plugin exposes a read-only catalog; registration neither writes presets nor injects requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-template-api-'));
  const routes = new Map();
  const services = new Map();
  const disposers = [];
  const listeners = {};
  const file = join(dir, 'state.json');
  const ctx = {
    effect(setup) { const disposer = setup(); if (typeof disposer === 'function') disposers.push(disposer); },
    provide(name, value) { services.set(name, value); disposers.push(() => services.delete(name)); },
    get: name => services.get(name),
    on(name, callback) { listeners[name] = callback; },
    sessions: { get: id => ({ id, header: { agentPreset: 'standard' } }) },
    llm: { async *stream() { throw new Error('catalog registration must not reroute a request'); } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
  };
  try {
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    const readState = () => readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const before = await readState();
    const service = services.get(PRESET_TEMPLATES_SERVICE);
    assert.equal(service.contractVersion, 1);
    const owners = [[], []];
    for (const [index, providerId] of ['one', 'two'].entries()) {
      service.register({ effect: setup => owners[index].push(setup()) }, definition(providerId));
    }
    const route = routes.get('/preset-enhance/api/templates');
    const request = async method => {
      let status, payload, headers;
      await route.handler({ method }, {
        writeHead(value, fields) { status = value; headers = fields; },
        end(value) { payload = JSON.parse(value); },
      });
      return { status, payload, headers };
    };
    const catalog = await request('GET');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers['cache-control'], 'no-store');
    assert.deepEqual(catalog.payload.providers.map(p => p.providerId), ['one', 'two']);
    assert.equal((await request('POST')).status, 405);
    owners[0].forEach(dispose => dispose());
    assert.deepEqual((await request('GET')).payload.providers.map(p => p.providerId), ['two']);
    const options = { sessionId: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
    const messages = structuredClone(options.messages);
    const output = [];
    for await (const event of listeners['llm/stream'](options, async function* () { yield 'unchanged'; })) output.push(event);
    assert.deepEqual(output, ['unchanged']);
    assert.deepEqual(options.messages, messages);
    assert.equal(await readState(), before, 'catalog operations and disabled preset requests do not write state');
    await Promise.all(disposers.splice(0).map(dispose => dispose()));
    assert.equal(services.has(PRESET_TEMPLATES_SERVICE), false);
    assert.throws(() => service.list(), /已停用/);
    assert.equal((await request('GET')).status, 503);
    owners[1].forEach(dispose => dispose());
  } finally {
    await Promise.all(disposers.splice(0).map(dispose => dispose()));
    await rm(dir, { recursive: true, force: true });
  }
});


test('selected templates save normally; preview and cached requests follow provider unload/reload', async () => {
  const { Readable } = await import('node:stream');
  const { PresetStore } = await import('../lib/store.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'template-inject-'));
  const file = join(dir, 'state.json');
  const services = new Map(), routes = new Map(), listeners = {}, disposers = [], calls = [];
  const history = [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  const ctx = {
    effect: setup => { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    provide: (name, value) => services.set(name, value), get: name => services.get(name),
    on: (name, handler) => { listeners[name] = handler; },
    sessions: { get: id => ({ id, header: { agentPreset: 'standard' }, deriveMessages: () => history }) },
    webServer: { register: route => routes.set(route.path, route) },
    llm: { stream: options => listeners['llm/stream'](options, async function* () { calls.push(options); yield { type: 'finish', reason: { kind: 'stop' } }; }) },
  };
  const store = new PresetStore(file);
  try {
    await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, 'modes') });
    const service = services.get(PRESET_TEMPLATES_SERVICE);
    const owner = { effect: setup => disposers.push(setup()) };
    const source = { providerId: 'test', title: 'Test', templates: [{ id: 'format', version: '1', title: 'Format', role: 'system', content: 'external' }] };
    let registration = service.register(owner, source);
    const post = async body => {
      const req = Readable.from([JSON.stringify({ revision: (await store.read()).revision, ...body })]);
      Object.assign(req, { method: 'POST', url: '/preset-enhance/api?sessionId=s', headers: { host: 'localhost', 'content-type': 'application/json' } });
      let code, result;
      await routes.get('/preset-enhance/api').handler(req, { writeHead: v => { code = v; }, end: v => { result = JSON.parse(v); } });
      assert.equal(code, 200, result?.error);
      return result;
    };
    let catalog;
    await routes.get('/preset-enhance/api/templates').handler({ method: 'GET' }, { writeHead() {}, end: value => { catalog = JSON.parse(value); } });
    const revision = (await store.read()).revision;
    const draft = await post({ action: 'template-select', preset: { prompts: [] }, selection: {
      operation: 'add', providerId: 'test', templateId: 'format', templateVersion: '1', expectedFingerprint: catalog.fingerprints[0].fingerprint,
    } });
    assert.equal((await store.read()).revision, revision, 'selection only edits the draft');
    await post({ action: 'import', name: 'Example', document: draft.preset });
    const state = await store.read();
    await post({ action: 'bind', sessionId: 's', binding: { enabled: true, presetId: state.presets[0].id } });
    const send = async () => { for await (const _ of ctx.llm.stream({ sessionId: 's', provider: 'mock', model: 'mock', messages: history })) {} return calls.at(-1).messages; };
    for (const available of [true, true, false, true]) {
      if (!available) registration.dispose();
      if (available && calls.length === 3) registration = service.register(owner, source);
      const messages = await send();
      assert.deepEqual(messages.map(m => m.content[0].text), available ? ['external', 'hello'] : ['hello']);
      const preview = await post({ action: 'preview', sessionId: 's', preset: draft.preset });
      assert.deepEqual(preview.messages.map(m => m.content[0].text), messages.map(m => m.content[0].text));
      if (!available) assert.match(preview.warnings.join(), /已跳过/);
    }
    await post({ action: 'bind', sessionId: 's', binding: { enabled: false, presetId: state.presets[0].id } });
    assert.deepEqual(await send(), history);
  } finally { await Promise.all(disposers.reverse().map(dispose => dispose())); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
