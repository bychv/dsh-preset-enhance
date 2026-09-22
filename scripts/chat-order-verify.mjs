// 自建 API 探测：本地端点抓取插件 Chat 适配器真正发出的请求，核对预设注入的
// 角色与顺序被完整保留（重点是 chatHistory 之后的 system 提示与深度注入）。
//
// 用法：node scripts/chat-order-verify.mjs
import { startProtocolServer } from '../tests/fixtures/protocol-server.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { createDeepSeekChatAdapter, resolveChatConnection } from '../vendor/deepseek-chat/index.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const textOf = message => (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

const preset = {
  prompts: [
    { identifier: 'chatHistory' },
    { identifier: 'leading', role: 'system', content: 'PRESET-LEADING' },
    { identifier: 'after-history', role: 'system', content: 'PRESET-AFTER-HISTORY' },
    { identifier: 'deep', role: 'system', content: 'PRESET-DEPTH', injection_position: 1, injection_depth: 1, injection_order: 1 },
  ],
  prompt_order: [{ character_id: '100001', order: [
    { identifier: 'leading', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'after-history', enabled: true },
    { identifier: 'deep', enabled: true },
  ] }],
};
const history = [
  { id: 'dsh', role: 'system', content: [{ type: 'text', text: 'DSH-SYSTEM' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'history-user-1' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'history-assistant-1' }] },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'history-user-2' }] },
];
const compiled = compilePreset(preset, history, { seed: 'order-probe' });
const expected = compiled.messages.map(m => m.role + ':' + textOf(m));
console.log('compiled order:', JSON.stringify(expected));
check('compiler keeps the after-history system prompt after the history',
  expected.indexOf('system:DSH-SYSTEM') < expected.indexOf('user:history-user-1')
  && expected.indexOf('user:history-user-2') < expected.indexOf('system:PRESET-AFTER-HISTORY'),
  JSON.stringify(expected));
check('compiler injects the depth prompt inside the history',
  expected.indexOf('system:PRESET-DEPTH') > expected.indexOf('user:history-user-1')
  && expected.indexOf('system:PRESET-DEPTH') < expected.indexOf('system:PRESET-AFTER-HISTORY'));

const server = await startProtocolServer({ port: 0, reply: { content: 'ok' } });
try {
  const adapter = createDeepSeekChatAdapter({
    connection: () => resolveChatConnection({ baseURL: server.url }),
    resolveApiKey: async () => 'test-key',
    resolveUserId: () => 'order-probe',
    fetch: (...args) => fetch(...args),
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'preset-deepseek-chat', model: 'deepseek-flash',
    messages: compiled.messages, stream: true, sessionId: 'order-probe',
  })) chunks.push(chunk);

  const record = server.last();
  check('the adapter posted to the local endpoint', Boolean(record), record ? record.path : 'no request');
  const body = record?.body ?? {};
  const sent = Array.isArray(body.messages) ? body.messages.map(m => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))) : [];
  console.log('wire order:   ', JSON.stringify(sent));
  check('the wire keeps every message, in the compiled order',
    sent.length === expected.length && sent.every((entry, index) => {
      const [role, content] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)];
      return role === expected[index].slice(0, expected[index].indexOf(':'))
        && content.includes(expected[index].slice(expected[index].indexOf(':') + 1));
    }),
    'compiled=' + expected.length + ' wire=' + sent.length);
  check('a plain request stays on the Chat path (never /beta)', record?.path === '/chat/completions', String(record?.path));
  check('no assistant prefix flag is sent for a plain request', !JSON.stringify(body).includes('"prefix"'));
  check('attribution header is on the real request',
    String(record?.headers?.['user-agent'] ?? '').startsWith('deepseek-harness/'), String(record?.headers?.['user-agent']));
  check('the adapter streamed a completion back', chunks.length > 0, 'chunks=' + chunks.length);
} finally {
  await server.close();
}
const failed = results.filter(r => !r.pass);
console.log('== summary == ' + (results.length - failed.length) + '/' + results.length + ' passed, ' + failed.length + ' failed');
process.exit(failed.length === 0 ? 0 : 1);
