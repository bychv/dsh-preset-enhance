/**
 * Prompt-side regex rules (docs/PROMPT_REGEX_IMPLEMENTATION_PLAN.md).
 * Constructed cases only: no sample presets or extracted rule text are committed.
 * Imports the BUILT tree: run `node scripts/build.mjs` first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacroContext } from '../lib/macros.mjs';
import {
  PREFILL_DEPTH, applyPromptRegex, depthInWindow, ensureRegexIds, escapeRegexLiteral, planRegexScript,
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
