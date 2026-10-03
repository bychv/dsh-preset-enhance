// Read-only host integration check. No model calls or settings writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = process.argv[2] ?? 'F:/Git/dsh-compact-sandbox';
const { isolatedEnv } = await import(pathToFileURL(join(sandbox, 'scripts/sandbox.mjs')));
const slot = join(sandbox, '.sandboxes/alpha'), port = 3196;
const version = JSON.parse(await readFile(join(slot, 'app/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
assert.equal(version, '0.2.1-alpha.1');
const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
await new Promise(resolve => probe.close(resolve));
const child = spawn(join(sandbox, '.runtime/node.exe'), [
  join(slot, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open',
], { cwd: join(slot, 'work'), env: isolatedEnv(slot), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', failure;
child.on('error', error => { failure = error; });
child.stdout.on('data', value => { output += value; });
child.stderr.on('data', value => { output += value; });
const closed = once(child, 'close');
const origin = 'http://127.0.0.1:' + port;
try {
  let cookie;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw new Error('隔离宿主启动失败');
    const launch = output.match(/http:\/\/127\.0\.0\.1:3196\/\?token=[^\s]+/)?.[0];
    if (launch) {
      const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      await login.arrayBuffer();
      if (cookie) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(cookie, '宿主未完成认证启动');
  async function request(path, body) {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
      headers: { cookie, ...(body ? { 'content-type': 'application/json', origin } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, path); return response;
  }
  const state = await (await request('/preset-enhance/api')).json();
  assert.equal(state.startupError, null);
  assert.ok(state.agentModes.some(mode => mode.id === 'st-preset'));
  assert.ok(state.toolCatalogs['st-preset'].length > 0);
  assert.deepEqual(state.toolCatalogErrors, {});
  assert.ok(state.connectionChoice.choices.some(choice => choice.provider === 'preset-deepseek-chat'));
  for (const path of ['/preset-enhance', '/preset-enhance/editor', '/preset-enhance/editor.js', '/preset-enhance/spreset.js']) await (await request(path)).arrayBuffer();
  const preview = await (await request('/preset-enhance/api', { action: 'preview', input: 'CHECK',
    preset: { prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'tail', role: 'assistant', content: 'PREFIX' }],
      prompt_order: [{ character_id: '100001', order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'tail', enabled: true }] }] },
    options: { characterId: '100001' },
  })).json();
  assert.equal(preview.assistantPrefix.active, true);
  assert.equal(preview.messages.at(-1).role, 'assistant');
  console.log(JSON.stringify({ host: version, checks: ['authenticated startup', 'preset mode', 'mode tool catalogs', 'Chat adapter', 'editor resources', 'prefill preview'],
    toolCounts: Object.fromEntries(Object.entries(state.toolCatalogs).map(([id, rows]) => [id, rows.length])), modelCalls: 0 }, null, 2));
} finally {
  if (child.exitCode === null) child.kill();
  await closed;
}
