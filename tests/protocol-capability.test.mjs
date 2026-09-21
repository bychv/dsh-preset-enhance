import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGES_BASE_URL,
  MESSAGES_PROTOCOL_REASON,
  SESSION_ID_HEADER,
  UNKNOWN_PROTOCOL_REASON,
  classifyProtocolPath,
  createProtocolObserver,
  detectProtocol,
  headerValue,
  observeProtocolRequest,
  protocolCapability,
  shouldRecordProtocol,
} from '../lib/protocol.mjs';
import {
  BRIDGE_DISPOSED_REASON,
  installDeepSeekBetaBridge,
  rewriteDeepSeekPrefixFetch,
} from '../lib/deepseek-beta.mjs';

const FETCH_BRIDGE = Symbol.for('dsh-preset-enhance.deepseek-beta-fetch-bridge');
/** Earlier tests may leave the shared fetch wrapper installed; restore the real fetch. */
function resetFetchBridge() {
  const host = globalThis[FETCH_BRIDGE];
  if (!host) return;
  globalThis.fetch = host.original;
  delete globalThis[FETCH_BRIDGE];
}
const harness = { effect: fn => fn() };
const stubFetch = () => async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

test('a URL path alone decides chat-completions vs messages vs unknown', () => {
  for (const path of ['/chat/completions', '/v1/chat/completions', '/beta/chat/completions', '/chat/completions/']) {
    assert.equal(classifyProtocolPath(path), 'chat-completions', path);
  }
  for (const path of ['/messages', '/v1/messages', '/anthropic/v1/messages', '/messages?beta=1']) {
    assert.equal(classifyProtocolPath(path), 'messages', path);
  }
  for (const path of ['/', '', '/v1/files', '/v1/completions', '/v1/messages-and-more', '/chat/completions/extra']) {
    assert.equal(classifyProtocolPath(path), 'unknown', path);
  }
});

test('an outbound URL classifies the protocol and the compatibility capability', () => {
  const chat = detectProtocol('https://api.deepseek.com/v1/chat/completions', { method: 'POST' });
  assert.equal(chat.protocol, 'chat-completions');
  assert.equal(chat.pathname, '/v1/chat/completions');
  assert.equal(chat.determinedBy, 'url');
  assert.equal(chat.capability.supported, true);
  assert.equal(chat.capability.reason, '');
  assert.deepEqual(chat.capability.features, {
    assistantPrefix: true, toolCallEmulation: true, outputExtraction: true,
  });
  assert.equal(chat.skipped, false);
  assert.equal(chat.skippedReason, '');

  // DSH 0.1.6 default: https://api.deepseek.com/anthropic + POST <root>/v1/messages.
  const messages = detectProtocol(MESSAGES_BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'key', 'anthropic-version': '2023-06-01' },
  });
  assert.equal(messages.protocol, 'messages');
  assert.equal(messages.pathname, '/anthropic/v1/messages');
  assert.equal(messages.capability.supported, false);
  assert.equal(messages.capability.reason, MESSAGES_PROTOCOL_REASON);
  assert.ok(messages.capability.reason.length > 0);
  assert.deepEqual(messages.capability.features, {
    assistantPrefix: false, toolCallEmulation: false, outputExtraction: false,
  });

  const unknown = detectProtocol('https://gateway.example.com/v1/files', { method: 'POST' });
  assert.equal(unknown.protocol, 'unknown');
  assert.equal(unknown.determinedBy, 'url');
  assert.equal(unknown.capability.supported, false);
  assert.equal(unknown.capability.reason, UNKNOWN_PROTOCOL_REASON);

  const unparseable = detectProtocol('not a url', { method: 'POST' });
  assert.equal(unparseable.protocol, 'unknown');
  assert.equal(unparseable.determinedBy, 'none');
  assert.equal(unparseable.pathname, '');

  assert.equal(protocolCapability('chat-completions').supported, true);
  assert.equal(protocolCapability('messages').supported, false);
  assert.equal(protocolCapability('unknown').supported, false);
});

test('the anthropic-version header classifies an otherwise unknown endpoint', () => {
  const detected = detectProtocol('https://gateway.example.com/custom/invoke', {
    method: 'POST',
    headers: { 'anthropic-version': '2023-06-01', [SESSION_ID_HEADER]: 's' },
  });
  assert.equal(detected.protocol, 'messages');
  assert.equal(detected.determinedBy, 'headers');
  assert.equal(detected.sessionId, 's');
  assert.equal(detected.capability.supported, false);
});

test('an unknown gateway endpoint without a session header is not worth recording', () => {
  assert.equal(shouldRecordProtocol(detectProtocol('https://cdn.example.com/app.js')), false);
  assert.equal(shouldRecordProtocol(detectProtocol(MESSAGES_BASE_URL + '/v1/messages')), true);
  assert.equal(shouldRecordProtocol(detectProtocol('https://cdn.example.com/app.js', {
    headers: { [SESSION_ID_HEADER]: 's' },
  })), true);
});

test('headerValue reads Headers, pair arrays and plain objects', () => {
  assert.equal(headerValue(new Headers({ [SESSION_ID_HEADER]: 's1' }), SESSION_ID_HEADER), 's1');
  assert.equal(headerValue([[SESSION_ID_HEADER.toUpperCase(), 's2']], SESSION_ID_HEADER), 's2');
  assert.equal(headerValue({ 'X-DeepSeek-Harness-Session-Id': 's3' }, SESSION_ID_HEADER), 's3');
  assert.equal(headerValue(undefined, SESSION_ID_HEADER), '');
  assert.equal(headerValue({}, SESSION_ID_HEADER), '');
});

test('the observer records the last observation per session', () => {
  const observer = createProtocolObserver();
  const first = observer.record(detectProtocol('https://api.deepseek.com/chat/completions', {
    headers: { [SESSION_ID_HEADER]: 'a' },
  }));
  observer.record(detectProtocol(MESSAGES_BASE_URL + '/v1/messages', {
    headers: { [SESSION_ID_HEADER]: 'b' },
  }));
  const latest = observer.record(detectProtocol(MESSAGES_BASE_URL + '/v1/messages', {
    headers: { [SESSION_ID_HEADER]: 'a' },
  }));

  assert.equal(observer.size, 2);
  assert.equal(observer.last('a'), latest);
  assert.equal(observer.last('a').protocol, 'messages');
  assert.equal(observer.last('a').capability.supported, false);
  assert.equal(observer.last('b').protocol, 'messages');
  assert.equal(observer.last('missing'), undefined);
  assert.notEqual(observer.last('a'), first);

  const unbound = observer.record(detectProtocol('https://api.deepseek.com/v1/chat/completions'));
  assert.equal(observer.last(), unbound);
  assert.equal(observer.last(null), unbound);
  assert.equal(observer.size, 3);
  assert.deepEqual(
    observer.snapshot().map(entry => entry.sessionId === null ? 'unbound' : entry.sessionId).sort(),
    ['a', 'b', 'unbound'],
  );

  observer.clear();
  assert.equal(observer.size, 0);
  assert.equal(observer.last('a'), undefined);
  assert.equal(observer.last(), undefined);
});

test('observeProtocolRequest records classified requests and drops unrelated fetches', () => {
  const observer = createProtocolObserver();
  const kept = observeProtocolRequest(MESSAGES_BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'key', 'anthropic-version': '2023-06-01', [SESSION_ID_HEADER]: 's' },
  }, observer);
  assert.equal(kept.protocol, 'messages');
  assert.equal(kept.method, 'POST');
  assert.equal(observer.size, 1);

  assert.equal(observeProtocolRequest('https://cdn.example.com/app.js', { method: 'GET' }, observer), null);
  assert.equal(observer.size, 1);

  // An unknown endpoint is still recorded when it carries a harness session id.
  const unknown = observeProtocolRequest('https://gateway.example.com/custom/invoke', {
    method: 'POST',
    headers: { [SESSION_ID_HEADER]: 's' },
  }, observer);
  assert.equal(unknown.protocol, 'unknown');
  assert.equal(observer.size, 1);
  assert.equal(observer.last('s'), unknown);

  const stamped = detectProtocol('https://api.deepseek.com/chat/completions', {}, { now: () => 12345 });
  assert.equal(stamped.observedAt, 12345);
  assert.equal(detectProtocol('https://api.deepseek.com/chat/completions').method, 'GET');
});

test('rewriting a Messages request reports the skip instead of pretending', () => {
  const prefix = 'Prefix: ';
  const registry = new Map([['s', new Map([[prefix, { count: 1 }]])]]);
  const init = {
    method: 'POST',
    headers: { [SESSION_ID_HEADER]: 's', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  };
  const rewritten = rewriteDeepSeekPrefixFetch(MESSAGES_BASE_URL + '/v1/messages', init, [registry]);
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.mode, 'none');
  assert.equal(rewritten.protocol, 'messages');
  assert.equal(rewritten.init, init);
  assert.equal(rewritten.input, MESSAGES_BASE_URL + '/v1/messages');
  assert.deepEqual(rewritten.skipped, { protocol: 'messages', reason: MESSAGES_PROTOCOL_REASON });
});

test('the installed bridge observes the request protocol and reports messages as skipped', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const observer = createProtocolObserver();
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer });
    const release = controller.activate('s', 'Prefix: ', { removeNonOfficialTools: true });
    assert.equal(release.applied, true);

    // 1) Chat Completions: observed as supported and actually rewritten.
    await globalThis.fetch('https://adapter.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { [SESSION_ID_HEADER]: 's' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Prefix: ' }],
      }),
    });
    const chat = observer.last('s');
    assert.equal(chat.protocol, 'chat-completions');
    assert.equal(chat.capability.supported, true);
    assert.equal(chat.skipped, false);
    assert.equal(chat.sessionId, 's');
    assert.equal(chat.method, 'POST');
    assert.equal(typeof chat.observedAt, 'number');
    assert.equal(JSON.parse(calls[0].init.body).messages.at(-1).prefix, true);

    // 2) Messages: never rewritten, always reported with an explicit reason.
    const messagesUrl = MESSAGES_BASE_URL + '/v1/messages';
    const messagesInit = {
      method: 'POST',
      headers: { 'x-api-key': 'key', 'anthropic-version': '2023-06-01', [SESSION_ID_HEADER]: 's' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'noop', input_schema: { type: 'object' } }],
      }),
    };
    await globalThis.fetch(messagesUrl, messagesInit);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].input, messagesUrl);
    assert.equal(calls[1].init, messagesInit);
    assert.equal(calls[1].init.body, messagesInit.body);
    const messages = observer.last('s');
    assert.equal(messages.protocol, 'messages');
    assert.equal(messages.capability.supported, false);
    assert.equal(messages.skipped, true);
    assert.equal(messages.skippedReason, MESSAGES_PROTOCOL_REASON);

    release();
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('the bridge restores only its own wrapper and dispose is idempotent', () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const stub = stubFetch();
  globalThis.fetch = stub;
  try {
    const controller = installDeepSeekBetaBridge(harness);
    const ours = globalThis.fetch;
    assert.notEqual(ours, stub);
    assert.equal(globalThis[FETCH_BRIDGE].original, stub);
    assert.equal(globalThis[FETCH_BRIDGE].wrapped, ours);
    assert.equal(controller.status().topmost, true);

    // Another plugin wraps us afterwards: our teardown must not clobber it.
    const foreign = (input, init) => ours(input, init);
    globalThis.fetch = foreign;
    controller.dispose();
    controller.dispose();
    assert.equal(globalThis.fetch, foreign);
    assert.equal(controller.disposed, true);

    // With no wrapper on top, dispose still restores the real fetch and frees the slot.
    globalThis.fetch = stub;
    delete globalThis[FETCH_BRIDGE];
    const second = installDeepSeekBetaBridge(harness);
    assert.equal(second.status().topmost, true);
    second.dispose();
    assert.equal(globalThis.fetch, stub);
    assert.equal(globalThis[FETCH_BRIDGE], undefined);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('a second install reuses the shared host instead of stacking wrappers', () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const stub = stubFetch();
  globalThis.fetch = stub;
  try {
    const first = installDeepSeekBetaBridge(harness);
    const wrapper = globalThis.fetch;
    const second = installDeepSeekBetaBridge(harness);
    assert.equal(globalThis.fetch, wrapper);
    assert.equal(globalThis[FETCH_BRIDGE].wrapped, wrapper);

    first.dispose();
    assert.equal(globalThis.fetch, wrapper);
    assert.equal(globalThis[FETCH_BRIDGE].wrapped, wrapper);

    second.dispose();
    assert.equal(globalThis.fetch, stub);
    assert.equal(globalThis[FETCH_BRIDGE], undefined);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('dispose makes later activations explicit and lets armed requests finish', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('{}', { status: 200 });
  };
  globalThis.fetch = stub;
  try {
    const controller = installDeepSeekBetaBridge(harness);
    const release = controller.activate('s', 'Prefix: ');
    assert.equal(release.applied, true);
    assert.equal(release.reason, '');
    assert.equal(controller.status().activations, 1);

    controller.dispose();
    // An activation armed before dispose completes: the request is still transformed,
    // never silently downgraded to an untransformed one.
    await globalThis.fetch('https://adapter.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { [SESSION_ID_HEADER]: 's' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Prefix: ' }],
      }),
    });
    assert.equal(JSON.parse(calls[0].init.body).messages.at(-1).prefix, true);

    release();
    assert.equal(controller.status().activations, 0);
    // The disposed, now idle controller detaches and restores the real fetch exactly once.
    assert.equal(globalThis.fetch, stub);
    assert.equal(globalThis[FETCH_BRIDGE], undefined);
    release();

    // A new activation after dispose is refused explicitly, with a reason.
    const after = controller.activate('s', 'Prefix: ');
    assert.equal(after.applied, false);
    assert.equal(after.reason, BRIDGE_DISPOSED_REASON);
    after();
    assert.equal(controller.status().activations, 0);
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

test('a failing install leaves no half-installed bridge', () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const stub = stubFetch();
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => stub,
    set: () => { throw new Error('locked fetch'); },
  });
  try {
    const controller = installDeepSeekBetaBridge(harness);
    assert.equal(globalThis[FETCH_BRIDGE], undefined);
    assert.equal(globalThis.fetch, stub);
    const status = controller.status();
    assert.equal(status.attached, false);
    assert.equal(status.topmost, false);
    assert.match(status.error, /locked fetch/);

    const refused = controller.activate('s', 'Prefix: ');
    assert.equal(refused.applied, false);
    assert.match(refused.reason, /locked fetch/);
    refused();

    controller.dispose();
    assert.equal(globalThis[FETCH_BRIDGE], undefined);
    assert.equal(globalThis.fetch, stub);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
    else delete globalThis.fetch;
    globalThis.fetch = previous;
  }
});
test('a Messages request is reported even when no activation is armed', () => {
  // Pure rewrite: the compat path is refused for the protocol itself, not only when a
  // prefix happened to be armed, so a panel never depends on activation timing.
  const init = {
    method: 'POST',
    headers: { [SESSION_ID_HEADER]: 's', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  };
  const rewritten = rewriteDeepSeekPrefixFetch(MESSAGES_BASE_URL + '/v1/messages', init, []);
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.protocol, 'messages');
  assert.deepEqual(rewritten.skipped, { protocol: 'messages', reason: MESSAGES_PROTOCOL_REASON });

  // A request with no session (a plain file fetch) is not classified as a skipped LLM call.
  const files = rewriteDeepSeekPrefixFetch('https://api.deepseek.com/v1/files', { method: 'POST' }, []);
  assert.equal(files.protocol, 'unknown');
  assert.equal(files.skipped, undefined);
});

test('the installed bridge flags the unsupported protocol without an activation', async () => {
  resetFetchBridge();
  const previous = globalThis.fetch;
  const observer = createProtocolObserver();
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('{}', { status: 200 });
  };
  try {
    const controller = installDeepSeekBetaBridge(harness, { observer });
    const init = {
      method: 'POST',
      headers: { 'x-api-key': 'key', 'anthropic-version': '2023-06-01', [SESSION_ID_HEADER]: 'fresh' },
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    };
    await globalThis.fetch(MESSAGES_BASE_URL + '/v1/messages', init);
    assert.equal(calls[0].init, init);
    const observed = observer.last('fresh');
    assert.equal(observed.protocol, 'messages');
    assert.equal(observed.capability.supported, false);
    assert.equal(observed.skipped, true);
    assert.equal(observed.skippedReason, MESSAGES_PROTOCOL_REASON);
    controller.dispose();
  } finally {
    resetFetchBridge();
    globalThis.fetch = previous;
  }
});

