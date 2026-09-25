/**
 * Terminable regex execution: the worker boundary, its limits and its failure reporting.
 * Imports the BUILT tree: run `node scripts/build.mjs` first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegexRunner, disposeRegexRunner, getRegexRunner } from '../lib/regex-runner.mjs';

const rule = (over = {}) => ({ scriptName: '规则', findRegex: '/foo/g', replaceString: 'bar', placement: 1, promptOnly: true, ...over });
const segment = (text, target = 'user', depth = 0) => ({ text, target, depth });
const preparation = (over = {}) => ({
  segments: [segment('foo and foo')], scripts: [rule()], seed: 'seed-1', draws: 0,
  local: {}, global: {}, values: {}, ...over,
});

test('a preparation runs in the worker and returns texts, hits and macro state', () => {
  const runner = createRegexRunner({ timeoutMs: 5000 });
  try {
    const result = runner.run(preparation({
      segments: [segment('foo one'), segment('foo two', 'assistant', -1)],
      scripts: [
        rule({ scriptName: '用户侧', findRegex: '/foo/', replaceString: 'bar', placement: 1 }),
        rule({ scriptName: '助手侧', findRegex: '/two/', replaceString: '2', placement: 2 }),
      ],
    }));
    assert.deepEqual(result.texts, ['bar one', 'foo 2']);
    assert.deepEqual(result.applied, ['用户侧', '助手侧']);
    assert.equal(result.replacements, 2);

    // A replacement that sets a variable comes back as state the caller can commit.
    const withVariable = runner.run(preparation({
      segments: [segment('foo')],
      scripts: [rule({ replaceString: '{{setvar::greeted::yes}}' })],
    }));
    assert.equal(withVariable.local.greeted, 'yes');
    assert.equal(withVariable.texts[0], '');

    // The macro random stream continues from the draw count the caller sent.
    const drawn = runner.run(preparation({
      segments: [segment('foo')],
      scripts: [rule({ replaceString: '{{roll::1d6}}' })],
      draws: 3,
    }));
    assert.equal(drawn.draws, 4);
  } finally { runner.dispose(); }
});

test('a runaway rule is terminated, named, and does not poison the next preparation', () => {
  const runner = createRegexRunner({ timeoutMs: 400 });
  try {
    const doomed = preparation({
      segments: [segment('a'.repeat(32) + 'b')],
      scripts: [rule({ scriptName: '灾难回溯', findRegex: '/(a+)+$/', replaceString: 'x' })],
    });
    // Promise.race cannot interrupt a RegExp, so this must be a real termination.
    assert.throws(() => runner.run(doomed), (error) => {
      assert.match(error.message, /超时/);
      assert.match(error.message, /灾难回溯/);
      return true;
    });
    // The terminated worker is gone: the runner respawns and keeps working.
    const recovered = runner.run(preparation());
    assert.deepEqual(recovered.texts, ['bar and bar']);
  } finally { runner.dispose(); }
});

test('limits stop a preparation before any text is rewritten', () => {
  const runner = createRegexRunner({ timeoutMs: 2000, maxRules: 1, maxSegmentChars: 10, maxTotalChars: 12, maxReplacements: 1 });
  try {
    assert.throws(() => runner.run(preparation({ scripts: [rule(), rule({ scriptName: '第二条' })] })), /规则数/);
    assert.throws(() => runner.run(preparation({ segments: [segment('x'.repeat(11))] })), /单条文本/);
    assert.throws(() => runner.run(preparation({ segments: [segment('aaaaaa'), segment('bbbbbb'), segment('cc')] })), /文本总量/);
    // The default rule is global, so this is two replacements against a cap of one.
    assert.throws(() => runner.run(preparation({ segments: [segment('foo foo')] })), /替换次数/);
  } finally { runner.dispose(); }
});

test('a context without a deterministic seed refuses to run instead of guessing', () => {
  const runner = createRegexRunner({ timeoutMs: 1000 });
  try {
    assert.throws(() => runner.run(preparation({ seed: undefined })), /确定性种子/);
  } finally { runner.dispose(); }
});

test('no rules means no worker task at all', () => {
  const runner = createRegexRunner({ timeoutMs: 1000 });
  try {
    const result = runner.run(preparation({ scripts: [], segments: [segment('untouched')] }));
    assert.deepEqual(result.texts, ['untouched']);
    assert.deepEqual(result.applied, []);
    assert.equal(result.replacements, 0);
  } finally { runner.dispose(); }
});

test('the shared runner survives disposal and can be recreated', () => {
  const first = getRegexRunner();
  assert.equal(getRegexRunner(), first);
  const result = first.run(preparation());
  assert.deepEqual(result.texts, ['bar and bar']);
  disposeRegexRunner();
  const second = getRegexRunner();
  assert.notEqual(second, first);
  assert.deepEqual(second.run(preparation()).texts, ['bar and bar']);
  disposeRegexRunner();
});
