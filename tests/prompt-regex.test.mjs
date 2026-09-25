/**
 * Prompt-side regex rules (docs/PROMPT_REGEX_IMPLEMENTATION_PLAN.md).
 * Constructed cases only: no sample presets or extracted rule text are committed.
 * Imports the BUILT tree: run `node scripts/build.mjs` first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacroContext } from '../lib/macros.mjs';
import { createRegexRunner } from '../lib/regex-runner.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { decodePresetDocument, encodePresetPackage } from '../lib/preset-package.mjs';
import {
  PREFILL_DEPTH, applyPromptRegex, buildChatDepths, chatTargetOf, depthInWindow, ensureRegexIds, escapeRegexLiteral,
  planRegexScript, rewriteChatText,
  readPromptRegexOptions, readRegexScripts, regexPlacement, runRegexScript, writePromptRegexOptions,
} from '../lib/prompt-regex.mjs';

const ctx = (values = {}) => createMacroContext({ values, random: () => 0.5 });
const rule = (over = {}) => ({ scriptName: '规则', findRegex: '/foo/g', replaceString: 'bar', placement: 1, promptOnly: true, ...over });

test('the switches default to off and merging keeps every other extension field', () => {
  assert.deepEqual(readPromptRegexOptions({ prompts: [] }), { enabled: false, includePrefill: false });
  assert.deepEqual(readPromptRegexOptions({ prompts: [], extensions: { 'dsh-preset-enhance': { promptRegex: { enabled: 'yes' } } } }),
    { enabled: false, includePrefill: false });
  const preset = {
    prompts: [],
    extensions: {
      regex_scripts: [{ findRegex: 'a', placement: 1 }],
      'dsh-preset-enhance': { keepMe: 1, promptRegex: { enabled: true, extra: 'x' } },
      other: { untouched: true },
    },
  };
  assert.deepEqual(readPromptRegexOptions(preset), { enabled: true, includePrefill: false });
  const written = writePromptRegexOptions(preset, { includePrefill: true });
  assert.deepEqual(written.extensions['dsh-preset-enhance'], { keepMe: 1, promptRegex: { enabled: true, extra: 'x', includePrefill: true } });
  assert.deepEqual(written.extensions.other, { untouched: true });
  assert.deepEqual(written.extensions.regex_scripts, preset.extensions.regex_scripts);
  // The original object is never mutated.
  assert.equal(preset.extensions['dsh-preset-enhance'].promptRegex.includePrefill, undefined);
});

test('rules are read in array order and ids are filled without regenerating existing ones', () => {
  const preset = { prompts: [], extensions: { regex_scripts: [{ id: 'keep', findRegex: 'a' }, { findRegex: 'b' }, { id: 'keep', findRegex: 'c' }, 'not-an-object'] } };
  const scripts = readRegexScripts(preset);
  assert.equal(scripts.length, 3);
  assert.deepEqual(scripts.map(item => item.findRegex), ['a', 'b', 'c']);
  const withIds = ensureRegexIds(scripts, index => 'minted-' + index);
  assert.deepEqual(withIds.map(item => item.id), ['keep', 'minted-1', 'minted-2']);
  assert.deepEqual(ensureRegexIds(withIds, index => 'other-' + index).map(item => item.id), ['keep', 'minted-1', 'minted-2']);
});

test('placement selects chat roles and preserves values this version does not run', () => {
  assert.deepEqual(regexPlacement(1), { targets: ['user'], unsupported: [] });
  assert.deepEqual(regexPlacement(2), { targets: ['assistant'], unsupported: [] });
  assert.deepEqual(regexPlacement([2, 1, 2]), { targets: ['assistant', 'user'], unsupported: [] });
  assert.deepEqual(regexPlacement(3), { targets: [], unsupported: [3] });
  assert.deepEqual(regexPlacement(undefined), { targets: [], unsupported: [] });
});

test('the prompt channel runs only rules that ask for the prompt side', () => {
  const cases = [
    [{ promptOnly: true, markdownOnly: false }, true],
    [{ promptOnly: true, markdownOnly: true }, true],
    [{ promptOnly: false, markdownOnly: true }, false],
    // Tavern's "both flags false" branch is deliberately dropped for the prompt pass.
    [{ promptOnly: false, markdownOnly: false }, false],
  ];
  for (const [flags, runs] of cases) {
    assert.equal(planRegexScript(rule({ ...flags }), 0).runs, runs, JSON.stringify(flags));
  }
  assert.equal(planRegexScript(rule({ disabled: true }), 0).runs, false);
  assert.equal(planRegexScript(rule({ disabled: true }), 0).supported, true);
  assert.equal(planRegexScript(rule({ findRegex: '' }), 0).supported, false);
});

test('depth windows treat -1 as unbounded and 0 as a real floor', () => {
  assert.equal(depthInWindow({ findRegex: 'a' }, 0), true);
  assert.equal(depthInWindow({ findRegex: 'a', minDepth: 2 }, 1), false);
  assert.equal(depthInWindow({ findRegex: 'a', minDepth: 2 }, 2), true);
  assert.equal(depthInWindow({ findRegex: 'a', maxDepth: 4 }, 5), false);
  assert.equal(depthInWindow({ findRegex: 'a', minDepth: 0, maxDepth: 0 }, 0), true);
  assert.equal(depthInWindow({ findRegex: 'a', minDepth: -1, maxDepth: -1 }, 9), true);
  assert.equal(PREFILL_DEPTH, -1);
  assert.equal(depthInWindow({ findRegex: 'a' }, PREFILL_DEPTH), true);
});

test('the replacement expands {{match}}, $0, numbered and named captures, empty when unmatched', () => {
  const source = 'name: Ada, id: 42';
  assert.equal(runRegexScript(source, rule({ findRegex: '/name: (\\w+)/', replaceString: '[$1]' }), ctx()), 'name: [Ada], id: 42'.replace('name: [Ada]', '[Ada]'));
  assert.equal(runRegexScript(source, rule({ findRegex: '/(?<who>\\w+), id: (\\d+)/', replaceString: '$<who>#$2' }), ctx()), 'name: Ada#42');
  assert.equal(runRegexScript(source, rule({ findRegex: '/id: (\\d+)/', replaceString: '{{match}}/$0/$9' }), ctx()), 'name: Ada, id: 42/id: 42/');
});

test('trimStrings removes literals from captured values after their macros expand', () => {
  const values = { cut: '--' };
  // The trim literal is macro-expanded first, then removed from every inserted capture.
  assert.equal(runRegexScript('start x--y end', rule({ findRegex: '/x(--)y/', replaceString: '[$1]', trimStrings: ['{{cut}}'] }), ctx(values)), 'start [] end');
  assert.equal(runRegexScript('x--y', rule({ findRegex: '/x(--)y/', replaceString: '{{match}}', trimStrings: ['{{cut}}'] }), ctx(values)), 'xy');
});

test('substituteRegex keeps, expands or escapes the pattern macros', () => {
  const values = { char: 'A.ice' };
  // NONE: the braces stay literal, so only the literal text matches.
  assert.equal(runRegexScript('x {{char}} y', rule({ findRegex: '{{char}}', replaceString: 'Z', substituteRegex: 0 }), ctx(values)), 'x Z y');
  // RAW: the value is inserted as written, so its dot stays a metacharacter.
  assert.equal(runRegexScript('x A.ice y', rule({ findRegex: '{{char}}', replaceString: 'Z', substituteRegex: 1 }), ctx(values)), 'x Z y');
  // ESCAPED: only the expanded value is escaped, so "A.ice" matches literally.
  assert.equal(runRegexScript('x A.ice y', rule({ findRegex: '{{char}}', replaceString: 'Z', substituteRegex: 2 }), ctx(values)), 'x Z y');
  assert.equal(runRegexScript('x A-ice y', rule({ findRegex: '{{char}}', replaceString: 'Z', substituteRegex: 2 }), ctx(values)), 'x A-ice y');
  assert.equal(escapeRegexLiteral('a.b*c'), 'a\\.b\\*c');
});

test('macros expand over the replacement result, and untouched text is left alone', () => {
  const values = { char: 'Ada' };
  assert.equal(runRegexScript('hi X', rule({ findRegex: '/X/', replaceString: '{{char}}' }), ctx(values)), 'hi Ada');
  // No match means no macro pass: chat text that happens to contain braces is not rewritten.
  assert.equal(runRegexScript('hi {{char}}', rule({ findRegex: '/X/', replaceString: '{{char}}' }), ctx(values)), 'hi {{char}}');
});

test('reusing a global rule gives the same result every time', () => {
  const shared = rule({ findRegex: '/a/g', replaceString: 'b' });
  const run = () => runRegexScript('a a a', shared, ctx());
  assert.equal(run(), 'b b b');
  assert.equal(run(), 'b b b');
});

test('rules chain in array order and only for the requested target', () => {
  const scripts = [
    rule({ scriptName: 'first', findRegex: '/one/', replaceString: 'two', placement: 1 }),
    rule({ scriptName: 'second', findRegex: '/two/', replaceString: 'three', placement: 1 }),
    rule({ scriptName: 'assistant-only', findRegex: '/three/', replaceString: 'four', placement: 2 }),
    rule({ scriptName: 'display-only', findRegex: '/three/', replaceString: 'four', promptOnly: false, markdownOnly: true, placement: 1 }),
  ];
  const user = applyPromptRegex('one', scripts, ctx(), { target: 'user', depth: 0 });
  assert.equal(user.text, 'three');
  assert.deepEqual(user.applied, ['first', 'second']);
  const assistant = applyPromptRegex('three', scripts, ctx(), { target: 'assistant', depth: 0 });
  assert.equal(assistant.text, 'four');
  assert.deepEqual(assistant.applied, ['assistant-only']);
});

test('an unusable pattern fails with the rule name instead of sending a partial rewrite', () => {
  assert.throws(() => runRegexScript('x', rule({ scriptName: '坏规则', findRegex: '/[/' }), ctx()), /坏规则/);
  assert.equal(planRegexScript(rule({ findRegex: '/[/' }), 0).supported, false);
});

test('a rule outside its depth window is reported as skipped, not unsupported', () => {
  const plan = planRegexScript(rule({ minDepth: 3 }), 0);
  assert.equal(plan.runs, false);
  assert.equal(plan.supported, true);
  assert.match(plan.reason, /深度/);
});

/* ------------------------------------------------------------ integration */

const presetWith = (scripts, switches = { enabled: true }) => ({
  prompts: [{ identifier: 'main', name: '主提示', content: '系统提示' }],
  prompt_order: [{ character_id: '100001', order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
  extensions: { regex_scripts: scripts, 'dsh-preset-enhance': { promptRegex: switches } },
});

test('chat floors ignore tool plumbing and share one floor across a split assistant turn', () => {
  const history = [
    { id: 'sys', role: 'system', content: [{ type: 'text', text: 'host snapshot' }], source: { kind: 'runtime-context' } },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'thinking' }, { type: 'tool-call', name: 'read' }] },
    { id: 't1', role: 'tool', content: [{ type: 'text', text: 'tool output' }], source: { kind: 'tool' } },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second' }] },
  ];
  const depths = buildChatDepths(history);
  assert.equal(depths.get('u2'), 0);
  assert.equal(depths.get('a2'), 1);
  // The same turn, split by a tool call, keeps one floor.
  assert.equal(depths.get('a1'), 1);
  assert.equal(depths.get('u1'), 2);
  assert.equal(depths.has('sys'), false);
  assert.equal(depths.has('t1'), false);
});

test('only real chat text is a regex target', () => {
  assert.equal(chatTargetOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), 'user');
  assert.equal(chatTargetOf({ role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', name: 'read' }] }), 'assistant');
  assert.equal(chatTargetOf({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] }), undefined);
  assert.equal(chatTargetOf({ role: 'tool', content: [{ type: 'text', text: 'out' }], source: { kind: 'tool' } }), undefined);
  assert.equal(chatTargetOf({ role: 'developer', content: [{ type: 'text', text: 'note' }] }), undefined);
  assert.equal(chatTargetOf({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'system-prompt' } }), undefined);
  assert.equal(chatTargetOf({ role: 'assistant', content: [{ type: 'image', attachmentId: 'a' }] }), undefined);
});

test('adjacent text blocks match as one segment and never across an image', () => {
  // The join is a newline, so only a joined pair can match this pattern.
  const scripts = [rule({ findRegex: '/aaa\nbbb/', replaceString: 'MATCH', placement: 1 })];
  const joined = rewriteChatText(
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'aaa' }, { type: 'text', text: 'bbb' }] },
    scripts, ctx(), { target: 'user', depth: 0 });
  assert.equal(joined.message.content.length, 1);
  assert.equal(joined.message.content[0].text, 'MATCH');
  const split = rewriteChatText(
    { id: 'm2', role: 'user', content: [{ type: 'text', text: 'aaa' }, { type: 'image', attachmentId: 'a' }, { type: 'text', text: 'bbb' }] },
    scripts, ctx(), { target: 'user', depth: 0 });
  assert.equal(split.message.content[0].text, 'aaa');
  assert.equal(split.message.content[1].type, 'image');
  assert.equal(split.message.content[2].text, 'bbb');
});

test('compilePreset rewrites a request copy only when the switch is on', () => {
  const history = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Hello back' }] },
  ];
  const scripts = [
    rule({ scriptName: '用户侧', findRegex: '/Hello/', replaceString: 'Goodbye', placement: 1 }),
    rule({ scriptName: '助手侧', findRegex: '/Hello/', replaceString: 'Cheers', placement: 2 }),
  ];
  const off = compilePreset(presetWith(scripts, { enabled: false }), history, { seed: 's' });
  assert.equal(off.messages.find(m => m.id === 'u1').content[0].text, 'Hello world');
  assert.deepEqual(off.promptRegex, { enabled: false, includePrefill: false, rules: 0, applied: [] });

  const on = compilePreset(presetWith(scripts), history, { seed: 's' });
  assert.equal(on.messages.find(m => m.id === 'u1').content[0].text, 'Goodbye world');
  assert.equal(on.messages.find(m => m.id === 'a1').content[0].text, 'Cheers back');
  assert.deepEqual(on.promptRegex.applied, ['用户侧', '助手侧']);
  // The caller's history is untouched: the next request starts from the original text again.
  assert.equal(history[0].content[0].text, 'Hello world');
});

test('depth windows reach the right floors inside a compilation', () => {
  const history = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'older' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'older2' }] },
  ];
  // u2 is floor 0, u1 is floor 2 (one assistant turn in between).
  const scripts = [rule({ scriptName: '仅最近', findRegex: '/older/', replaceString: 'recent', placement: 1, maxDepth: 0 })];
  const compiled = compilePreset(presetWith(scripts), history, { seed: 's' });
  assert.equal(compiled.messages.find(m => m.id === 'u2').content[0].text, 'recent2');
  assert.equal(compiled.messages.find(m => m.id === 'u1').content[0].text, 'older');
  assert.deepEqual(compiled.promptRegex.applied, ['仅最近']);
});

test('the prefill is only rewritten when asked, and emptying it disables the prefix', () => {
  const scripts = [rule({ scriptName: '前缀', findRegex: '/PRE/', replaceString: 'POST', placement: 2 })];
  const preset = { ...presetWith(scripts, { enabled: true, includePrefill: false }), assistant_prefill: 'PRE fill' };

  const kept = compilePreset(preset, [], { seed: 's' });
  assert.equal(kept.messages.at(-1).content[0].text, 'PRE fill');
  assert.equal(kept.assistantPrefix.active, true);

  const rewritten = compilePreset({ ...preset, extensions: { ...preset.extensions, 'dsh-preset-enhance': { promptRegex: { enabled: true, includePrefill: true } } } }, [], { seed: 's' });
  assert.equal(rewritten.messages.at(-1).content[0].text, 'POST fill');
  assert.equal(rewritten.assistantPrefix.active, true);

  const emptied = compilePreset({
    ...presetWith([rule({ scriptName: '清空', findRegex: '/^PRE fill$/', replaceString: '', placement: 2 })], { enabled: true, includePrefill: true }),
    assistant_prefill: 'PRE fill',
  }, [], { seed: 's' });
  assert.equal(emptied.assistantPrefix.active, false);
  assert.equal(emptied.messages.some(m => m.role === 'assistant'), false);
});

/* --------------------------------------------------- plan acceptance cases */

test('a tool continuation keeps one floor and the tool-specific prefix is rewritten last', () => {
  const history = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool-call', name: 'read' }] },
    { id: 't1', role: 'tool', content: [{ type: 'text', text: 'file contents' }], source: { kind: 'tool' } },
  ];
  const scripts = [
    rule({ scriptName: '用户侧', findRegex: '/read/', replaceString: 'open', placement: 1 }),
    rule({ scriptName: '助手侧', findRegex: '/reading/', replaceString: 'looking', placement: 2 }),
  ];
  const preset = { ...presetWith(scripts, { enabled: true, includePrefill: true }), assistant_prefill: 'reading' };
  const compiled = compilePreset(preset, history, { seed: 's', postToolPrefix: 'reading now' });
  // History text of both channels is rewritten, and the tool call survives untouched.
  assert.equal(compiled.messages.find(m => m.id === 'u1').content[0].text, 'open the file');
  const assistant = compiled.messages.find(m => m.id === 'a1');
  assert.equal(assistant.content[0].text, 'looking');
  assert.equal(assistant.content[1].type, 'tool-call');
  // The custom prefix after the tool call is what the rules see, because it is chosen first.
  assert.equal(compiled.messages.at(-1).content[0].text, 'looking now');
  assert.equal(compiled.assistantPrefix.active, true);
  assert.deepEqual(compiled.promptRegex.applied, ['用户侧', '助手侧']);
});

test('non-text blocks are never rewritten or reordered', () => {
  const scripts = [rule({ scriptName: '正文', findRegex: '/secret/', replaceString: 'public' })];
  const history = [{
    id: 'u1', role: 'user',
    content: [{ type: 'text', text: 'secret' }, { type: 'image', attachmentId: 'a1' }, { type: 'text', text: 'tail' }],
  }];
  const compiled = compilePreset(presetWith(scripts), history, { seed: 's' });
  const content = compiled.messages.find(m => m.id === 'u1').content;
  assert.equal(content[0].text, 'public');
  assert.deepEqual(content[1], { type: 'image', attachmentId: 'a1' });
  assert.equal(content[2].text, 'tail');
});

test('the preview and the real preparation agree, and neither touches the history', () => {
  const history = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'one two' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'three' }] },
  ];
  const scripts = [rule({ scriptName: '数字', findRegex: '/one/', replaceString: '1' })];
  const snapshot = JSON.stringify(history);
  const preview = compilePreset(presetWith(scripts), history, { seed: 'preview' });
  const request = compilePreset(presetWith(scripts), history, { seed: 'preview' });
  assert.deepEqual(preview, request);
  assert.equal(JSON.stringify(history), snapshot);
  assert.equal(request.messages.find(m => m.id === 'u1').content[0].text, '1 two');
});

test('an unusable rule is skipped, and a run-time failure commits nothing', () => {
  const runner = createRegexRunner({ timeoutMs: 3000, maxReplacements: 0 });
  const local = {};
  const global = { keep: 'me' };
  try {
    // An uncompilable pattern is classified as unusable, so the preparation skips it rather than
    // failing the send: the plan wants the rule shown and repaired, not the request broken.
    const skipped = runner.run({
      segments: [{ text: 'x', target: 'user', depth: 0 }],
      scripts: [rule({ scriptName: '坏规则', findRegex: '/[/' })],
      seed: 's', draws: 0, local, global, values: {},
    });
    assert.deepEqual(skipped.texts, ['x']);
    assert.deepEqual(skipped.applied, []);

    // A rule that really fails mid-run aborts the whole preparation and commits nothing.
    assert.throws(() => runner.run({
      segments: [{ text: 'foo', target: 'user', depth: 0 }],
      scripts: [rule({ scriptName: '超限', findRegex: '/foo/' })],
      seed: 's', draws: 0, local, global, values: {},
    }), /超限/);
    assert.deepEqual(local, {});
    assert.deepEqual(global, { keep: 'me' });
  } finally { runner.dispose(); }
});

test('the share format carries the rules and the switches unchanged', () => {
  const preset = presetWith([rule({ id: 'keep', scriptName: '清理', findRegex: '/x/', replaceString: 'y' })], { enabled: true, includePrefill: true });
  preset.extensions.other = { untouched: 1 };
  const document = encodePresetPackage({ id: 'r1', name: '带正则的预设', preset }, {});
  const back = decodePresetDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(back.preset.extensions.regex_scripts, preset.extensions.regex_scripts);
  assert.deepEqual(back.preset.extensions['dsh-preset-enhance'], { promptRegex: { enabled: true, includePrefill: true } });
  assert.deepEqual(back.preset.extensions.other, { untouched: 1 });
  assert.deepEqual(readPromptRegexOptions(back.preset), { enabled: true, includePrefill: true });
  // A second round trip is stable.
  assert.deepEqual(decodePresetDocument(JSON.parse(JSON.stringify(encodePresetPackage(back, {})))).preset.extensions.regex_scripts, preset.extensions.regex_scripts);
});
