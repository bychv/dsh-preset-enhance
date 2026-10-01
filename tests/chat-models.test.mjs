import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatModelCatalog } from '../lib/chat-models.mjs';
import { createDeepSeekChatAdapter } from '../vendor/deepseek-chat/adapter.mjs';
import { resolveChatConnection } from '../vendor/deepseek-chat/config.mjs';

test('Chat mirrors live official model settings without Messages-only policies; user overrides are live', async () => {
  let official = [{ id: 'future', name: 'Future', contextWindow: 123456, maxTokens: 9000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }];
  let own = [];
  const entry = { options: { config: {} } };
  const ctx = { fiber: { entry }, llm: { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'official', settingsPath: [] }] },
    get: name => name === 'settings' ? { describe: () => [{ ns: 'official', value: { models: official } }] } : undefined };
  const catalog = createChatModelCatalog(ctx, { chatModels: { get: () => own } });
  const adapter = createDeepSeekChatAdapter({ connection: () => resolveChatConnection({ models: catalog.models() }), refreshModels: catalog.refresh, resolveApiKey: async () => 'unused' });
  assert.equal((await adapter.listModels('chat'))[0].id, 'future');
  const resolved = await adapter.resolveModel('chat', 'future');
  assert.equal(resolved.context.contextWindow, 123456);
  assert.equal(resolved.defaultMaxTokens, 9000);
  assert.equal(catalog.models()[0].toolUpdate, undefined);
  assert.equal(catalog.models()[0].systemPromptUpdate, undefined);
  official = [{ id: 'changed', name: 'Changed' }];
  assert.equal((await adapter.listModels('chat'))[0].id, 'changed');
  own = [{ id: 'custom', name: 'Custom', maxTokens: 321 }];
  assert.equal((await adapter.listModels('chat'))[0].id, 'changed', 'synchronization defaults on even with stored custom models');
  entry.options.config.chatModels = own;
  assert.equal((await adapter.prepareCall('chat', 'custom')).model.defaultMaxTokens, 321);
  assert.equal((await adapter.listModels('chat'))[0].id, 'custom');
  delete entry.options.config.chatModels;
  assert.equal((await adapter.listModels('chat'))[0].id, 'changed');
});

test('official discovery is used when no settings service is available', async () => {
  const llm = { listModels: async provider => { assert.equal(provider, 'deepseek-official'); return [{ id: 'new', name: 'New' }]; },
    resolveModelInfo: async () => ({ context: { contextWindow: 2222 }, defaultMaxTokens: 333 }) };
  const catalog = createChatModelCatalog({ llm, get: () => llm }, {});
  await catalog.refresh();
  assert.deepEqual(catalog.models(), [{ id: 'new', name: 'New', contextWindow: 2222, maxTokens: 333 }]);
});
