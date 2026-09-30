import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PresetStore } from '../lib/store.mjs';
import { apply } from '../index.mjs';
import {
  createDefaultSPresetLibrary, deleteLibraryEntry, normalizeSPresetData, normalizeSPresetEditor,
  normalizeSPresetLibrary, presetLocks, restoreDefaultTemplates, saveLibraryEntry, setPresetLock,
  SPRESET_DEFAULTS, SPRESET_MIRROR_ID, SPRESET_MIRROR_NAME, summarizeSPreset, syncSPresetMirror,
} from '../lib/s-preset-library.mjs';

/* ------------------------------------------------------------- unit: library */

test('a fresh library ships with the four seeded templates', () => {
  const library = createDefaultSPresetLibrary(1000);
  assert.equal(library.entries.length, 4);
  for (const entry of library.entries) {
    assert.equal(entry.kind, 'template');
    assert.equal(entry.builtin, true);
    assert.equal(typeof entry.title, 'string');
    assert.equal(typeof entry.content, 'string');
    assert.equal(entry.createdAt, 1000);
  }
});

test('normalize seeds a missing library, keeps an intentionally empty one, and drops junk', () => {
  assert.equal(normalizeSPresetLibrary(undefined).entries.length, 4, 'an old state file gets the templates');
  assert.equal(normalizeSPresetLibrary({ entries: [] }).entries.length, 0, 'emptying the library is respected');
  const messy = normalizeSPresetLibrary({ entries: [
    { id: 'a', title: '一', role: 'user', content: 'x' },
    null,
    { title: '' },
    { id: 'a', title: '重复 ID', role: 'nope', content: 'y' },
    { title: '未知字段', content: 'z', custom: { keep: true } },
  ] });
  assert.deepEqual(messy.entries.map(entry => entry.title), ['一', '重复 ID', '未知字段']);
  assert.equal(messy.entries[0].id, 'a');
  assert.notEqual(messy.entries[1].id, 'a', 'a duplicate id is minted, not kept');
  assert.equal(messy.entries[1].role, 'system', 'an unknown role falls back to system');
  assert.deepEqual(messy.entries[2].custom, { keep: true }, 'unknown fields of a stored entry survive');
});

test('saveLibraryEntry creates, updates, keeps ids and requires a title', () => {
  let library = createDefaultSPresetLibrary(1000);
  const created = saveLibraryEntry(library, { title: '我的模板', role: 'user', content: 'hi' }, { now: 2000, mintId: () => 'minted' });
  assert.equal(created.created, true);
  assert.equal(created.entry.id, 'minted');
  assert.equal(created.entry.kind, 'snippet');
  library = created.library;
  const updated = saveLibraryEntry(library, { id: 'minted', title: '改名', content: 'hi2' }, { now: 3000 });
  assert.equal(updated.created, false);
  assert.equal(updated.library.entries.length, 5, 'updating must not append');
  assert.equal(updated.entry.title, '改名');
  assert.equal(updated.entry.createdAt, 2000, 'createdAt is preserved');
  assert.equal(updated.entry.updatedAt, 3000);
  assert.throws(() => saveLibraryEntry(library, { title: '  ' }), /需要标题/);
  const removed = deleteLibraryEntry(updated.library, 'minted');
  assert.equal(removed.removed, true);
  assert.equal(removed.library.entries.length, 4);
  assert.equal(deleteLibraryEntry(removed.library, 'nope').removed, false);
  assert.equal(restoreDefaultTemplates({ entries: [] }).entries.length, 4);
});

/* --------------------------------------------------------- unit: SPreset view */

test('summarizeSPreset reports the RegexBinding verdicts from the shared engine', () => {
  const preset = { prompts: [], prompt_order: [], extensions: {
    SPreset: {
      FixedPresetName: '示例', MacroNest: true,
      ChatSquash: { enabled: true, role: 'system' },
      OutputPreprocessing: { enabled: false, script: '', consumeToolCalls: true },
      ToolBindings: {}, MessageInjections: {},
      RegexBinding: { regexes: [
        { id: 'r1', scriptName: '会执行', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true, minDepth: null, maxDepth: null },
        { id: 'r2', scriptName: '显示侧', findRegex: 'x', replaceString: 'y', placement: [2], promptOnly: false },
        { id: 'r3', scriptName: '停用', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true, disabled: true },
        { id: 'r4', scriptName: '深层', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true, minDepth: 2, maxDepth: 4 },
      ] },
    },
    tavern_helper: { scripts: [{}], variables: {} },
  } };
  const summary = summarizeSPreset(preset, 0);
  assert.equal(summary.present, true);
  assert.equal(summary.fixedPresetName, '示例');
  assert.equal(summary.macroNest, true);
  assert.equal(summary.chatSquash.enabled, true);
  assert.equal(summary.outputPreprocessing.consumeToolCalls, true);
  assert.equal(summary.tavernHelperScripts, 1);
  assert.equal(summary.regexDepth, 0);
  const by = name => summary.regexes.find(row => row.name === name);
  assert.equal(by('会执行').runs, true);
  assert.equal(by('显示侧').supported, false);
  assert.match(by('显示侧').reason, /显示侧/);
  assert.equal(by('停用').reason, '已停用');
  assert.equal(by('深层').runs, false);
  assert.match(by('深层').reason, /深度 0 不在规则窗口内/);
  assert.deepEqual(by('会执行').targets, ['user']);
  assert.equal(summarizeSPreset({ prompts: [], prompt_order: [] }).present, false);
});

test('normalizeSPresetData merges the defaults, repairs types and keeps unknown fields', () => {
  const source = {
    MacroNest: 'yes',
    FixedPresetName: '  示例  ',
    ToolBindings: [],
    MessageInjections: null,
    RegexBinding: { regexes: 'nope', keep: 1 },
    ChatSquash: { enabled: true, role: 7, unknown_squash_field: 'kept' },
    OutputPreprocessing: { enabled: true, toolCallFormatter: 'fmt', extra: { deep: true } },
    ForcedPostProcessing: { mode: 'x' },
    unknown_top_field: { keep: [1, 2] },
  };
  const data = normalizeSPresetData(source);
  assert.deepEqual(data.unknown_top_field, { keep: [1, 2] }, 'unknown top-level fields survive');
  assert.deepEqual(data.ChatSquash.unknown_squash_field, 'kept', 'unknown sub-fields survive');
  assert.deepEqual(data.OutputPreprocessing.extra, { deep: true });
  assert.equal(data.MacroNest, false, 'a non-boolean falls back to the default');
  assert.equal(data.FixedPresetName, '示例', 'strings are trimmed');
  assert.deepEqual(data.ToolBindings, {}, 'a non-object becomes an empty object');
  assert.deepEqual(data.MessageInjections, {});
  assert.deepEqual(data.RegexBinding.regexes, [], 'a non-array regex list becomes []');
  assert.equal(data.RegexBinding.keep, 1, 'other RegexBinding fields survive');
  assert.equal(data.ChatSquash.enabled, true);
  assert.equal(data.ChatSquash.role, 'system', 'a wrong-typed field falls back to its default');
  assert.equal(data.OutputPreprocessing.toolCallFormatter, 'fmt');
  for (const key of Object.keys(SPRESET_DEFAULTS.ChatSquash)) {
    assert.equal(key in data.ChatSquash, true, 'every documented ChatSquash field is present: ' + key);
  }
  for (const key of Object.keys(SPRESET_DEFAULTS.OutputPreprocessing)) {
    assert.equal(key in data.OutputPreprocessing, true, 'every documented OutputPreprocessing field is present: ' + key);
  }
  assert.deepEqual(normalizeSPresetData(data), data, 'normalisation is idempotent');
});

test('syncSPresetMirror projects the settings into the SPresetSettings prompt', () => {
  const preset = {
    prompts: [{ identifier: 'sys', name: '系统', role: 'system', content: 'x' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'sys', enabled: true }] }],
    extensions: { SPreset: { MacroNest: true, ChatSquash: { enabled: true } }, keep: 1 },
  };
  const first = syncSPresetMirror(preset);
  assert.equal(first.changed, true);
  const mirror = first.preset.prompts.find(item => item.identifier === SPRESET_MIRROR_ID);
  assert.equal(mirror.name, SPRESET_MIRROR_NAME);
  assert.deepEqual(JSON.parse(mirror.content), first.preset.extensions.SPreset, 'the body is the normalized block');
  assert.equal(first.preset.extensions.keep, 1, 'other extension fields survive');
  const order = first.preset.prompt_order[0].order;
  assert.equal(order.some(item => item.identifier === SPRESET_MIRROR_ID), false, 'the mirror is never injected');
  assert.equal(preset.prompts.length, 1, 'the input preset is not mutated in place');
  const again = syncSPresetMirror(first.preset);
  assert.equal(again.changed, false, 'a second sync is a no-op');
  assert.equal(again.preset.prompts.length, 2);
  const changed = syncSPresetMirror({ ...first.preset, extensions: { ...first.preset.extensions, SPreset: { MacroNest: false } } });
  assert.equal(changed.changed, true);
  assert.deepEqual(JSON.parse(changed.preset.prompts.find(i => i.identifier === SPRESET_MIRROR_ID).content).MacroNest, false);
  const plain = { prompts: [], prompt_order: [] };
  assert.equal(syncSPresetMirror(plain).changed, false, 'a preset without SPreset is never given one');
});

test('editor locks are per preset, structural and removable', () => {
  assert.deepEqual(normalizeSPresetEditor(undefined), { locks: {} });
  assert.deepEqual(normalizeSPresetEditor({ locks: { a: ['x', 'x', ''], b: 'nope', c: [] } }), { locks: { a: ['x'] } });
  let editor = { locks: {} };
  editor = setPresetLock(editor, 'p1', 'main', true);
  editor = setPresetLock(editor, 'p1', 'other', true);
  editor = setPresetLock(editor, 'p2', 'main', true);
  assert.deepEqual(presetLocks(editor, 'p1'), ['main', 'other']);
  assert.deepEqual(presetLocks(editor, 'p2'), ['main'], 'locks are keyed by preset');
  assert.deepEqual(presetLocks(editor, 'p3'), []);
  editor = setPresetLock(editor, 'p1', 'main', false);
  assert.deepEqual(presetLocks(editor, 'p1'), ['other']);
  editor = setPresetLock(editor, 'p1', 'other', false);
  assert.equal('p1' in editor.locks, false, 'an empty lock list is dropped');
});

/* ----------------------------------------------------------------- api side */

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-spreset-'));
  const file = join(dir, 'state.json');
  const disposers = [];
  let handler;
  const routes = new Map();
  const ctx = {
    sessions: { get: () => undefined },
    on: () => {},
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    webServer: { register: definition => {
      if (definition.path === '/preset-enhance/api') handler = definition.handler;
      routes.set(definition.path, definition);
      return () => {};
    } },
    tools: { guard: () => () => {}, schemas: () => [] },
    commands: { register: () => () => {} },
    agentPresets: { readDocument: async () => ({ content: '' }), list: async () => [], standingKeyFor: async id => 'scope:' + id },
    llm: { stream: () => (async function* () {})() },
  };
  await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
  const store = new PresetStore(file);
  const send = async (method, body) => {
    const req = Readable.from([body ? JSON.stringify(body) : '']);
    req.method = method;
    req.url = '/preset-enhance/api';
    req.headers = { 'content-type': 'application/json', host: 'localhost' };
    let statusCode;
    let payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    return { statusCode, payload };
  };
  const get = () => send('GET');
  const post = async body => {
    const revision = body.revision === undefined ? (await store.read()).revision : body.revision;
    return send('POST', { ...body, revision });
  };
  const fetchAsset = async path => {
    const route = routes.get(path);
    assert.ok(route, 'route ' + path + ' is not registered');
    const req = { method: 'GET', url: path, headers: {} };
    let statusCode;
    let headers;
    let body;
    await route.handler(req, { writeHead(code, extra) { statusCode = code; headers = extra; }, end(value) { body = String(value); } });
    return { statusCode, headers, body };
  };
  return { post, get, store, fetchAsset, routes, cleanup: async () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
    await rm(dir, { recursive: true, force: true });
  } };
}

const samplePreset = () => ({
  temperature: 1,
  prompts: [
    { identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user', content: '' },
    { identifier: 'sys', name: '系统', role: 'system', content: 'sys', system_prompt: true,
      forbid_overrides: true, hide_from_list: true, unknown_prompt_field: { deep: [1, 2] } },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'sys', enabled: true }] }],
  assistant_prefill: 'Continue:',
  extensions: {
    regex_scripts: [],
    SPreset: {
      FixedPresetName: '', MacroNest: false, ChatSquash: { enabled: false, role: 'system' },
      ToolBindings: {}, MessageInjections: {}, OutputPreprocessing: { enabled: false, script: '', consumeToolCalls: false },
      RegexBinding: { regexes: [] },
    },
    unknown_extension: { keep: [1, 2, 3] },
  },
});

test('the library lives in its own store, never inside a preset', async () => {
  const harness = await createHarness();
  try {
    const initial = await harness.get();
    assert.equal(initial.payload.sPresetLibrary.entries.length, 4, 'a fresh state ships the templates');
    const saved = await harness.post({ action: 'save', id: null, name: 'A', preset: samplePreset() });
    assert.equal(saved.statusCode, 200, saved.payload?.error);
    const added = await harness.post({ action: 'library-save', entry: { title: '我的模板', role: 'user', content: 'hello' } });
    assert.equal(added.statusCode, 200, added.payload?.error);
    assert.equal(added.payload.created, true);
    assert.equal(added.payload.entry.id.length > 0, true);
    assert.equal(added.payload.entries.length, 5);

    const after = await harness.get();
    const stored = after.payload.presets[0].preset;
    assert.equal(JSON.stringify(stored).includes('我的模板'), false, 'a template must not leak into the preset');
    assert.equal(stored.extensions.sPresetLibrary, undefined, 'the library has no preset-side home');
    assert.deepEqual(stored.extensions.unknown_extension, { keep: [1, 2, 3] }, 'unknown extension fields survive');
    assert.equal(stored.temperature, 1, 'top-level preset fields survive');
    assert.equal(stored.assistant_prefill, 'Continue:');
    assert.deepEqual(stored.prompts[1].unknown_prompt_field, { deep: [1, 2] }, 'unknown prompt fields survive');
    assert.equal(stored.prompts[1].forbid_overrides, true, 'reference flags survive a save round trip');
    assert.equal(stored.prompts[1].hide_from_list, true);

    const removed = await harness.post({ action: 'library-delete', id: added.payload.entry.id });
    assert.equal(removed.payload.entries.length, 4);
    const restored = await harness.post({ action: 'library-restore-templates' });
    assert.equal(restored.payload.entries.length, 4);
    const missing = await harness.post({ action: 'library-delete', id: 'nope' });
    assert.equal(missing.statusCode >= 400, true, 'deleting an unknown entry is refused');
  } finally { await harness.cleanup(); }
});

test('saving from the SPreset editor writes the mirror only when asked', async () => {
  const harness = await createHarness();
  try {
    const preset = samplePreset();
    const plain = await harness.post({ action: 'save', id: null, name: 'A', preset });
    assert.equal(plain.statusCode, 200, plain.payload?.error);
    let stored = (await harness.get()).payload.presets[0].preset;
    assert.equal(stored.prompts.some(prompt => prompt.identifier === 'SPresetSettings'), false,
      'a workbench save must not add the mirror');

    const mirrored = await harness.post({ action: 'save', id: plain.payload.id, name: 'A', preset,
      mirrorSPreset: true });
    assert.equal(mirrored.statusCode, 200, mirrored.payload?.error);
    stored = (await harness.get()).payload.presets[0].preset;
    const mirror = stored.prompts.find(prompt => prompt.identifier === 'SPresetSettings');
    assert.ok(mirror, 'the requested save adds the SPresetSettings prompt');
    assert.deepEqual(JSON.parse(mirror.content), stored.extensions.SPreset,
      'the mirror body is the normalized extensions.SPreset block');
    assert.equal(stored.prompt_order[0].order.some(item => item.identifier === 'SPresetSettings'), false,
      'the mirror never joins the order flow');
    assert.deepEqual(stored.extensions.unknown_extension, { keep: [1, 2, 3] }, 'unknown extensions survive the mirror save');
  } finally { await harness.cleanup(); }
});

test('s-preset-lock stores the guard outside the preset and survives a reload', async () => {
  const harness = await createHarness();
  try {
    const saved = await harness.post({ action: 'save', id: null, name: 'A', preset: samplePreset() });
    assert.equal(saved.statusCode, 200, saved.payload?.error);
    const presetId = saved.payload.id;

    const before = await harness.get();
    assert.deepEqual(before.payload.sPresetEditor, { locks: {} });

    const locked = await harness.post({ action: 's-preset-lock', presetId, identifier: 'sys', locked: true });
    assert.equal(locked.statusCode, 200, locked.payload?.error);
    assert.deepEqual(locked.payload.locks, ['sys']);

    // A reload (a fresh GET) still reports the lock, and the preset itself is untouched.
    const after = await harness.get();
    assert.deepEqual(after.payload.sPresetEditor.locks[presetId], ['sys'], 'the lock survives a reload');
    const stored = after.payload.presets.find(record => record.id === presetId).preset;
    assert.equal(JSON.stringify(stored).includes('sPresetEditor'), false, 'locks never enter a preset');
    assert.equal(stored.prompts.find(prompt => prompt.identifier === 'sys').forbid_overrides, true,
      'the preset keeps the reference field the editor mirrored');

    const unlocked = await harness.post({ action: 's-preset-lock', presetId, identifier: 'sys', locked: false });
    assert.deepEqual(unlocked.payload.locks, []);
    assert.equal('locks' in (await harness.get()).payload.sPresetEditor
      && Boolean((await harness.get()).payload.sPresetEditor.locks[presetId]), false, 'unlocking clears it');

    const missing = await harness.post({ action: 's-preset-lock', presetId, identifier: '', locked: true });
    assert.equal(missing.statusCode >= 400, true, 'an empty identifier is refused');
  } finally { await harness.cleanup(); }
});

test('the editor page is served with its own chrome and three columns', async () => {
  const harness = await createHarness();
  try {
    const page = await harness.fetchAsset('/preset-enhance/editor');
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    for (const label of ['SPreset Editor', '资源库', 'LIBRARY', '提示词链', 'PROMPT CHAIN', 'INSPECTOR',
      '搜索标题、正文或 ID', '全部角色', '顺序流程', '附加功能']) {
      assert.ok(page.body.includes(label), 'the page should contain ' + label);
    }
    for (const id of ['seg-unused', 'seg-templates', 'library-search', 'library-role', 'library-list',
      'chain-list', 'chain-count', 'inspector-body', 'menu-layer', 'extras-body']) {
      assert.ok(page.body.includes('id="' + id + '"'), 'the page should contain #' + id);
    }
    const script = await harness.fetchAsset('/preset-enhance/spreset.js');
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /javascript/);
    assert.ok(script.body.includes('s-preset-plan'), 'the page script talks to the plugin api');
    assert.ok(script.body.includes('library-save'), 'the script talks to the library actions');
    assert.ok(script.body.includes("const UNCATEGORIZED = '未分类'"), 'the library groups under 未分类');
    assert.ok(script.body.includes("category + '模板（'"), 'the section title is 未分类模板（N）');
    for (const label of ['在酒馆原生列表中隐藏', '根据条件自动启用', '锁定正文', '提示词正文', '字符 ·', '内容', '注入', '工具', '结构化']) {
      assert.ok(script.body.includes(label), 'the inspector should render ' + label);
    }
    for (const key of ['ChatSquash', 'RegexBinding', 'MacroNest', 'ToolBindings', 'MessageInjections',
      'OutputPreprocessing', 'FixedPresetName']) {
      assert.ok(script.body.includes(key), 'the extras tab should cover ' + key);
    }
    assert.ok(script.body.includes('本插件不读取'), 'controls with no plugin-side effect carry a visible hint');
    assert.ok(script.body.includes('spreset_condition_script'), '根据条件自动启用 edits the condition script');
    assert.ok(script.body.includes('ForcedPostProcessing'), 'the extras tab covers ForcedPostProcessing');
    assert.ok(script.body.includes('SPresetSettings'), 'saving explains the settings mirror');
    assert.ok(script.body.includes('mirrorSPreset: true'), 'the editor asks the server for the mirror');
    const css = await harness.fetchAsset('/preset-enhance/spreset.css');
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    // The workbench page and its script stay where they were.
    assert.equal(harness.routes.has('/preset-enhance'), true);
    assert.equal(harness.routes.has('/preset-enhance/editor.js'), true);
  } finally { await harness.cleanup(); }
});

test('s-preset-plan answers for a draft preset and needs no stored preset', async () => {
  const harness = await createHarness();
  try {
    const preset = samplePreset();
    preset.extensions.SPreset.RegexBinding.regexes = [
      { id: 'r1', scriptName: '规则一', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true },
    ];
    const { statusCode, payload } = await harness.post({ action: 's-preset-plan', preset, depth: 2 });
    assert.equal(statusCode, 200, payload?.error);
    assert.equal(payload.present, true);
    assert.equal(payload.regexDepth, 2);
    assert.equal(payload.regexes.length, 1);
    assert.equal(payload.regexes[0].name, '规则一');
    assert.equal(payload.regexes[0].runs, true);
    assert.deepEqual(payload.regexes[0].targets, ['user']);
  } finally { await harness.cleanup(); }
});
