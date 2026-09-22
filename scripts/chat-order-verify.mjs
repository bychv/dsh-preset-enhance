// 自建 API 探测：本地端点抓取插件 Chat 适配器真正发出的请求，
// 1) 核对预设注入的角色与顺序被完整保留（chatHistory 之后的 system、深度注入）；
// 2) 核对带工具历史的新回复里，工具调用 ID 与结果关联、同轮多次调用都被保留。
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

const server = await startProtocolServer({ port: 0, reply: { content: 'ok' } });
const adapter = createDeepSeekChatAdapter({
  connection: () => resolveChatConnection({ baseURL: server.url }),
  resolveApiKey: async () => 'test-key',
  resolveUserId: () => 'order-probe',
});
const runTurn = async (messages, sessionId) => {
  server.reset();
  for await (const _chunk of adapter.stream({
    provider: 'preset-deepseek-chat', model: 'deepseek-flash',
    messages, stream: true, sessionId,
  })) { /* drain */ }
  return server.last();
};

try {
  /* ---------------------------------------------------------- 预设顺序 */
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
    && expected.indexOf('user:history-user-2') < expected.indexOf('system:PRESET-AFTER-HISTORY'));
  check('compiler injects the depth prompt inside the history',
    expected.indexOf('system:PRESET-DEPTH') > expected.indexOf('user:history-user-1')
    && expected.indexOf('system:PRESET-DEPTH') < expected.indexOf('system:PRESET-AFTER-HISTORY'));

  const record = await runTurn(compiled.messages, 'order-probe');
  const sent = (record?.body?.messages ?? []).map(m => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  console.log('wire order:   ', JSON.stringify(sent));
  check('the adapter posted to the local endpoint', Boolean(record), record ? record.path : 'no request');
  check('the wire keeps every message, in the compiled order',
    sent.length === expected.length && sent.every((entry, index) => {
      const role = entry.slice(0, entry.indexOf(':'));
      const content = entry.slice(entry.indexOf(':') + 1);
      return role === expected[index].slice(0, expected[index].indexOf(':'))
        && content.includes(expected[index].slice(expected[index].indexOf(':') + 1));
    }), 'compiled=' + expected.length + ' wire=' + sent.length);
  check('a plain request stays on the Chat path (never /beta)', record?.path === '/chat/completions', String(record?.path));
  check('no assistant prefix flag is sent for a plain request', !JSON.stringify(record?.body ?? {}).includes('"prefix"'));
  check('attribution header is on the real request',
    String(record?.headers?.['user-agent'] ?? '').startsWith('deepseek-harness/'), String(record?.headers?.['user-agent']));

  /* ------------------------------------------- 带工具历史 + 同轮多次调用 */
  const toolPreset = {
    prompts: [{ identifier: 'chatHistory' }],
    prompt_order: [{ character_id: '100001', order: [{ identifier: 'chatHistory', enabled: true }] }],
  };
  const toolHistory = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    { id: 'a1', role: 'assistant', content: [
      { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      { type: 'tool-call', id: 'call_2', name: 'get_time', arguments: '{"zone":"CST"}' },
    ] },
    { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny 25C' }] }] },
    { id: 't2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: '14:00' }] }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'and tomorrow?' }] },
  ];
  const toolCompiled = compilePreset(toolPreset, toolHistory, { seed: 'tool-probe' });
  const toolRecord = await runTurn(toolCompiled.messages, 'tool-probe');
  const wire = toolRecord?.body?.messages ?? [];
  const assistant = wire.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  check('both tool calls of one round survive on the wire',
    assistant?.tool_calls?.length === 2
    && assistant.tool_calls[0].id === 'call_1' && assistant.tool_calls[0].function?.name === 'get_weather'
    && assistant.tool_calls[1].id === 'call_2' && assistant.tool_calls[1].function?.name === 'get_time',
    JSON.stringify(assistant?.tool_calls ?? null));
  const toolMessages = wire.filter(m => m.role === 'tool');
  check('each tool result stays associated with its call id',
    toolMessages.length === 2
    && toolMessages[0].tool_call_id === 'call_1' && String(JSON.stringify(toolMessages[0].content)).includes('sunny 25C')
    && toolMessages[1].tool_call_id === 'call_2' && String(JSON.stringify(toolMessages[1].content)).includes('14:00'),
    JSON.stringify(toolMessages.map(m => m.tool_call_id)));
  check('the new reply keeps the user turn after the tool history',
    wire.at(-1)?.role === 'user' && String(JSON.stringify(wire.at(-1).content)).includes('and tomorrow?'),
    wire.map(m => m.role).join(','));
} finally {
  await server.close();
}
const failed = results.filter(r => !r.pass);
console.log('== summary == ' + (results.length - failed.length) + '/' + results.length + ' passed, ' + failed.length + ' failed');
// Give the closed server's sockets a moment to settle, then exit explicitly: setting
// only exitCode can hang on undici keep-alive, while exiting too early trips a libuv
// handle assert on Windows.
await new Promise(resolve => setTimeout(resolve, 150));
process.exit(failed.length === 0 ? 0 : 1);
