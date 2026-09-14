// Runs the real installed DSH agent loop with an in-process adapter, without credentials.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_PRESET_ID, apply } from '../index.mjs';
import { PresetStore } from '../lib/store.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/runtime-check.mjs <dsh app/node_modules>');
const root = resolve(process.argv[2]);
const load = name => import(pathToFileURL(join(root, '@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm');
const ctx = new Context(), calls = [];
const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-runtime-'));
try {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name === 'dsh-agent-loop' ? { agents: [] } : {});
  }
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'OK' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['mock'], new Adapter());
  const file = join(dir, 'state.json'), store = new PresetStore(file);
  const preset = { prompts: [
    { identifier: 'before', role: 'system', content: 'BEFORE {{incvar::count}}' },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'after', role: 'assistant', content: 'AFTER {{getvar::count}}' },
  ] };
  await store.transaction(s => {
    s.presets.push({ id: 'p', name: 'test', preset });
    s.defaultPresetId = 'p';
  });
  await apply({ on: ctx.on.bind(ctx), llm: ctx.llm, sessions: ctx.sessions, effect() {} },
    { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
  const agent = await ctx.agentLoop.create('preset-runtime', { provider: 'mock', model: 'mock', cwd: dir },
    { agentPreset: AGENT_PRESET_ID });
  for (const text of ['first', 'second']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await agent.whenIdle();
  }
  assert.equal(calls.length, 2, 'one physical adapter request per turn');
  for (let i = 0; i < 2; i++) {
    const request = calls[i];
    assert.equal(request.messages[0].content[0].text, `BEFORE ${i + 1}`);
    assert.equal(request.messages.at(-1).role, 'assistant');
    assert.equal(request.messages.at(-1).content[0].text, `AFTER ${i + 1}`);
    assert.equal(request.messages.filter(m => m.source.plugin === 'dsh-preset-enhance').length, 2);
    assert.equal(request.messages.some(m => m.source.plugin === '@deepseek-ai/dsh-system-prompt'), false);
    assert.equal(request.messages.some(m => m.role === 'system' && m.source.plugin !== 'dsh-preset-enhance'), false);
    assert.equal(Object.hasOwn(request, 'tools'), false);
  }
  assert.ok(!agent.session.deriveMessages().some(m => m.source.plugin === 'dsh-preset-enhance'));
  for await (const _ of ctx.llm.stream({ provider: 'mock', model: 'mock', sessionId: agent.session.id,
    purpose: 'session-title', messages: [createUserMessage({ content: [{ type: 'text', text: 'title' }], source: { kind: 'user' } })] })) {}
  assert.equal(calls.at(-1).messages.length, 1, 'background title requests bypass injection');
  assert.equal((await store.read()).sessions['preset-runtime'].result.local.count, '2');
  console.log('PASS real DSH preset mode: preset + chat history only, DSH prompts removed, stable two-turn routing');
} finally {
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}
