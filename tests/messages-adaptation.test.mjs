import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset } from '../lib/preset.mjs';
import { adaptPresetForMessages } from '../lib/messages.mjs';

const plugin = { kind: 'plugin', plugin: 'dsh-preset-enhance' };
const sys = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { ...plugin } });
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] });
const assistant = (id, text, source = { ...plugin }) => ({ id, role: 'assistant', content: [{ type: 'text', text }], source });

const EMPTY = { messages: [], notes: [], leadingSystemMerged: 0, prefixUnsupported: false };

test('an empty list is a no-op', () => {
  assert.deepEqual(adaptPresetForMessages([]), EMPTY);
});

test('a single leading system message passes through untouched', () => {
  const input = [sys('a', 'A'), user('u', 'hi')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], input[0]);
  assert.equal(result.messages[1], input[1]);
  assert.deepEqual(result.notes, []);
  assert.equal(result.leadingSystemMerged, 0);
  assert.equal(result.prefixUnsupported, false);
  assert.notEqual(result.messages, input, 'returns a fresh array, not the caller array');
});

test('multiple leading system messages merge in order with a count', () => {
  const input = [sys('a', 'A'), sys('b', 'B'), sys('c', 'C'), user('u', 'hi')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].id, 'a', 'the merged message keeps the first message metadata');
  assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'A\n\nB\n\nC' }]);
  assert.equal(result.leadingSystemMerged, 3);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /3/);
  assert.equal(result.messages[1], input[3], 'history passes through by identity');
  assert.equal(input.length, 4, 'input array is not mutated');
  assert.deepEqual(input[1].content, [{ type: 'text', text: 'B' }], 'input messages are not mutated');
});

// Host rule this test pins down (F:\Git\dsh-compact-sandbox\sources\deepseek-harness-master):
// packages/llm/llm-deepseek/src/protocols/messages/serialize.ts:74,83-95 keeps ONE
// historySystem variable that every non-in-history system message overwrites, so
// [system A, system B, user] serializes to { system: 'B', messages: [user] } and A
// is lost. serialize.ts:126 joins only options.system (not a message) with that one
// survivor. Host specs: tests/messages/serialize.spec.ts:97-106 and :108-112.
test('every leading system text survives in original order, separated by blank lines', () => {
  const texts = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'];
  const input = [...texts.map((text, index) => sys('s' + index, text)), user('u', 'hi')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.leadingSystemMerged, 4, 'all four source messages are counted');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content[0].text, texts.join('\n\n'), 'concatenation in original order');
  assert.equal(result.messages[1], input[4]);
  for (const text of texts) assert.ok(result.messages[0].content[0].text.includes(text), text);
  assert.equal(result.notes.length, 1);
});

test('a leading system message followed by history and a mid-history system message', () => {
  const input = [sys('a', 'A'), user('u1', 'hi'), assistant('m1', 'yo'), sys('deep', 'DEEP'), user('u2', 'again')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.messages.length, 5, 'nothing is dropped');
  assert.equal(result.messages[3], input[3], 'the mid-history system message stays in place by identity');
  assert.equal(result.messages[3].role, 'system', 'its role is not rewritten');
  assert.equal(result.leadingSystemMerged, 0);
  assert.equal(result.prefixUnsupported, false);
  assert.equal(result.notes.length, 1);
  assert.ok(result.notes[0].includes('system'));
  assert.match(result.notes[0], /1/);
});

test('leading merge and mid-history retention produce two distinct notes', () => {
  const input = [sys('a', 'A'), sys('b', 'B'), user('u1', 'hi'), sys('d1', 'D1'), assistant('m1', 'x'), sys('d2', 'D2')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.leadingSystemMerged, 2);
  assert.equal(result.notes.length, 2);
  assert.equal(new Set(result.notes).size, 2, 'notes are distinct');
  assert.match(result.notes[0], /2/);
  assert.match(result.notes[1], /2/);
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0].content[0].text, 'A\n\nB');
  assert.equal(result.messages[2], input[3]);
  assert.equal(result.messages[4], input[5]);
  assert.equal(result.prefixUnsupported, false, 'a trailing system message is not a prefix');
});

test('a trailing assistant prefix is flagged and its content is kept', () => {
  const marked = { ...assistant('p0', 'Sure'), prefix: true };
  const fromSource = assistant('p1', 'Sure', { kind: 'assistant_prefill' });
  const fromId = assistant('preset:preview:prefill', 'Sure');
  for (const prefix of [marked, fromSource, fromId]) {
    const input = [sys('a', 'A'), user('u', 'hi'), prefix];
    const result = adaptPresetForMessages(input);
    assert.equal(result.prefixUnsupported, true, String(prefix.id));
    assert.equal(result.messages.at(-1), prefix);
    assert.deepEqual(result.messages.at(-1).content, [{ type: 'text', text: 'Sure' }]);
    assert.equal(result.notes.length, 1);
    assert.ok(result.notes[0].includes('Messages'));
    assert.equal(result.leadingSystemMerged, 0);
  }
});

test('a plain trailing assistant message is not reported as a prefix', () => {
  const input = [sys('a', 'A'), user('u', 'hi'), assistant('m1', 'done')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.prefixUnsupported, false);
  assert.deepEqual(result.notes, []);
  assert.equal(result.messages.at(-1), input[2]);
});

test('every distinct limitation is reported exactly once', () => {
  const input = [sys('a', 'A'), sys('b', 'B'), user('u', 'hi'), sys('deep', 'D'), { ...assistant('p', 'Sure'), prefix: true }];
  const result = adaptPresetForMessages(input);
  assert.equal(result.leadingSystemMerged, 2);
  assert.equal(result.prefixUnsupported, true);
  assert.equal(result.notes.length, 3);
  assert.equal(new Set(result.notes).size, 3);
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].content[0].text, 'A\n\nB');
  assert.equal(result.messages[2], input[3]);
  assert.equal(result.messages[3], input[4]);
});

test('tool calls and tool results pass through untouched', () => {
  const call = {
    id: 'call-msg',
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call_1', name: 'run_code', arguments: '{"code":"1+1"}' }],
    source: { ...plugin },
  };
  const result = {
    id: 'result-msg',
    role: 'tool',
    source: { kind: 'tool' },
    content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '2' }], isError: false }],
  };
  const input = [sys('a', 'A'), user('u', 'hi'), call, result, user('u2', 'ok')];
  const adapted = adaptPresetForMessages(input);
  assert.equal(adapted.messages.length, 5);
  input.forEach((message, index) => assert.equal(adapted.messages[index], message, `message ${index}`));
  assert.deepEqual(adapted.notes, []);
  assert.equal(adapted.prefixUnsupported, false);
  assert.equal(adapted.leadingSystemMerged, 0);
});

test('adaptation never mutates its input', () => {
  const input = [sys('a', 'A'), sys('b', 'B'), user('u', 'hi'), sys('deep', 'D'), { ...assistant('p', 'Sure'), prefix: true }];
  const before = JSON.parse(JSON.stringify(input));
  const result = adaptPresetForMessages(input);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), before);
  assert.equal(input.length, 5);
  assert.notEqual(result.messages, input);
});

test('empty leading system texts do not inject blank separators', () => {
  const input = [{ id: 'a', role: 'system', content: [] }, sys('b', 'B'), sys('c', ''), user('u', 'hi')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.leadingSystemMerged, 3);
  assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'B' }]);
  assert.equal(result.messages.length, 2);
});

test('an all-system history merges down to one message', () => {
  const input = [sys('a', 'A'), sys('b', 'B')];
  const result = adaptPresetForMessages(input);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content[0].text, 'A\n\nB');
  assert.equal(result.leadingSystemMerged, 2);
  assert.equal(result.prefixUnsupported, false);
  assert.equal(result.notes.length, 1);
});

test('a non-text leading system block is preserved instead of dropped', () => {
  const image = { type: 'image', attachment: { attachmentId: 'att-1' } };
  const input = [{ id: 'a', role: 'system', content: [{ type: 'text', text: 'A' }, image] }, sys('b', 'B'), user('u', 'hi')];
  const result = adaptPresetForMessages(input);
  assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'A\n\nB' }, image]);
  assert.equal(result.messages.length, 2);
});

test('real compiler output is adapted end to end', () => {
  const history = [
    { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'go' }] },
  ];
  const compiled = compilePreset({
    prompts: [
      { identifier: 'chatHistory', marker: true },
      { identifier: 's1', role: 'system', content: 'SYS-ONE' },
      { identifier: 's2', role: 'system', content: 'SYS-TWO' },
      { identifier: 'd', role: 'system', injection_position: 1, injection_depth: 1, content: 'DEEP' },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 's1', enabled: true }, { identifier: 's2', enabled: true },
      { identifier: 'chatHistory', enabled: true }, { identifier: 'd', enabled: true },
    ] }],
    assistant_prefill: 'PREFILL-BODY',
  }, history, { seed: 'adapt-e2e' });
  const result = adaptPresetForMessages(compiled.messages);
  assert.deepEqual(compiled.messages.map(message => message.role), ['system', 'system', 'user', 'assistant', 'system', 'user', 'assistant']);
  assert.deepEqual(result.messages.map(message => message.role), ['system', 'user', 'assistant', 'system', 'user', 'assistant']);
  assert.equal(result.leadingSystemMerged, 2);
  assert.equal(result.prefixUnsupported, true, 'the compiler marks the prefill tail through its :prefill id');
  assert.equal(result.notes.length, 3);
  assert.equal(result.messages[0].content[0].text, 'SYS-ONE\n\nSYS-TWO');
  assert.equal(result.messages[1], compiled.messages[2], 'history is passed through by identity');
  assert.equal(result.messages.at(-1).content[0].text, 'PREFILL-BODY', 'prefix content is not dropped');
  assert.deepEqual(compiled.messages.map(message => message.role), ['system', 'system', 'user', 'assistant', 'system', 'user', 'assistant'], 'compiled input is not mutated');
});

test('non-array input is rejected defensively', () => {
  for (const junk of [undefined, null, 'x', 42, {}, { messages: [] }]) {
    assert.deepEqual(adaptPresetForMessages(junk), EMPTY);
  }
});
