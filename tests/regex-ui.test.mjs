import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { PresetStore } from '../lib/store.mjs';
import { apply } from '../index.mjs';

/* ------------------------------------------------------------------ API side */

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-regex-ui-'));
  const file = join(dir, 'state.json');
  const disposers = [];
  let handler;
  const ctx = {
    sessions: { get: () => undefined },
    on: () => {},
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    webServer: { register: definition => {
      if (definition.path === '/preset-enhance/api') handler = definition.handler;
      return () => {};
    } },
    tools: { guard: () => () => {}, schemas: () => [] },
    commands: { register: () => () => {} },
    agentPresets: { readDocument: async () => ({ content: '' }), list: async () => [], standingKeyFor: async id => 'scope:' + id },
    llm: { stream: () => (async function* () {})() },
  };
  await apply(ctx, { dataFile: file, agentPresetRoot: join(dir, '.agent-presets') });
  const post = async body => {
    const req = Readable.from([JSON.stringify(body)]);
    req.method = 'POST';
    req.url = '/preset-enhance/api';
    req.headers = { 'content-type': 'application/json', host: 'localhost' };
    let statusCode;
    let payload;
    await handler(req, { writeHead(code) { statusCode = code; }, end(value) { payload = JSON.parse(String(value)); } });
    return { statusCode, payload };
  };
  return { post, store: new PresetStore(file), cleanup: async () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
    await rm(dir, { recursive: true, force: true });
  } };
}

const rule = (over = {}) => ({
  id: 'r1', scriptName: '去掉括号', findRegex: '/\\(.*?\\)/g', replaceString: '',
  placement: [1, 2], promptOnly: true, minDepth: -1, maxDepth: -1, disabled: false, ...over,
});
const presetWith = (scripts, options = {}) => ({
  prompts: [{ identifier: 'chatHistory', role: 'user', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
  extensions: {
    regex_scripts: scripts,
    'dsh-preset-enhance': { promptRegex: { enabled: options.enabled !== false, includePrefill: options.includePrefill === true } },
    untouched: { keep: true },
  },
});
const test$ = (harness, preset, body) => harness.post({ action: 'regex-test', preset, text: '', target: 'user', depth: 0, ...body });

test('regex-test runs the preset rules on the request copy and reports the plan', async () => {
  const harness = await createHarness();
  try {
    const result = await test$(harness, presetWith([rule()]), { text: 'a(b)c' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.result.before, 'a(b)c');
    assert.equal(result.payload.result.after, 'ac');
    assert.equal(result.payload.result.changed, true);
    assert.deepEqual(result.payload.result.applied, ['去掉括号']);
    assert.equal(result.payload.depth, 0);
    assert.equal(result.payload.target, 'user');
    assert.equal(result.payload.rules.length, 1);
    assert.equal(result.payload.rules[0].hit, true);
    assert.equal(result.payload.rules[0].applicable, true);
    assert.equal(result.payload.rules[0].name, '去掉括号');
  } finally { await harness.cleanup(); }
});

test('regex-test keeps 已停用 / 当前不支持 / 深度窗口外 apart, with the engine reason text', async () => {
  const harness = await createHarness();
  try {
    const scripts = [
      rule({ id: 'off', scriptName: '停用的', disabled: true }),
      rule({ id: 'display', scriptName: '显示侧', promptOnly: false }),
      rule({ id: 'placement', scriptName: '斜杠命令', promptOnly: true, placement: 3 }),
      rule({ id: 'deep', scriptName: '只要深层', minDepth: 2, maxDepth: 5 }),
      rule({ id: 'empty', scriptName: '空查找式', findRegex: '' }),
    ];
    const { payload } = await test$(harness, presetWith(scripts), { text: 'nothing matches' });
    const by = name => payload.rules.find(entry => entry.name === name);
    assert.equal(by('停用的').reason, '已停用');
    assert.equal(by('停用的').supported, true);
    assert.equal(by('显示侧').supported, false);
    assert.match(by('显示侧').reason, /显示侧/);
    assert.equal(by('斜杠命令').supported, false);
    assert.match(by('斜杠命令').reason, /placement 3/);
    assert.equal(by('只要深层').supported, true);
    assert.equal(by('只要深层').runs, false);
    assert.match(by('只要深层').reason, /深度 0 不在规则窗口内/);
    assert.equal(by('空查找式').supported, false);
    assert.match(by('空查找式').reason, /查找式为空/);
    for (const entry of payload.rules) assert.equal(entry.hit, false);
    assert.deepEqual(payload.result.applied, []);
  } finally { await harness.cleanup(); }
});

test('regex-test honours the target, the depth and the prefill switch', async () => {
  const harness = await createHarness();
  try {
    const userOnly = rule({ scriptName: '只处理用户', placement: 1 });
    const assistantRule = rule({ id: 'r2', scriptName: '只处理助手', placement: 2 });
    const user = await test$(harness, presetWith([userOnly, assistantRule]), { text: 'x(y)', target: 'user' });
    assert.deepEqual(user.payload.result.applied, ['只处理用户']);
    assert.equal(user.payload.rules.find(entry => entry.name === '只处理助手').applicable, false);
    assert.equal(user.payload.rules.find(entry => entry.name === '只处理助手').hit, false);

    const assistant = await test$(harness, presetWith([userOnly, assistantRule]), { text: 'x(y)', target: 'assistant' });
    assert.deepEqual(assistant.payload.result.applied, ['只处理助手']);
    assert.equal(assistant.payload.rules.find(entry => entry.name === '只处理用户').applicable, false);

    const deep = await test$(harness, presetWith([rule({ maxDepth: 0 })]), { text: 'x(y)', depth: 4 });
    assert.deepEqual(deep.payload.result.applied, []);
    assert.match(deep.payload.rules[0].reason, /深度 4 不在规则窗口内/);
    const shallow = await test$(harness, presetWith([rule({ maxDepth: 0 })]), { text: 'x(y)', depth: 0 });
    assert.deepEqual(shallow.payload.result.applied, ['去掉括号']);

    // No depth is supplied here on purpose: a prefill test must default to the synthetic -1 floor.
    const prefill = await harness.post({ action: 'regex-test', preset: presetWith([rule({ placement: 2 })], { includePrefill: false }),
      text: 'x(y)', target: 'prefill' });
    assert.equal(prefill.payload.target, 'prefill');
    assert.equal(prefill.payload.depth, -1);
    assert.equal(prefill.payload.appliedTarget, 'assistant');
    assert.ok(prefill.payload.notes.some(note => note.includes('同时处理预填充')), JSON.stringify(prefill.payload.notes));
  } finally { await harness.cleanup(); }
});

test('regex-test reports the master switch without hiding the rule effect', async () => {
  const harness = await createHarness();
  try {
    const { payload } = await test$(harness, presetWith([rule()], { enabled: false }), { text: 'a(b)c' });
    assert.equal(payload.enabled, false);
    assert.ok(payload.notes.some(note => note.includes('总开关未开启')), JSON.stringify(payload.notes));
    assert.equal(payload.result.after, 'ac', 'the box still shows what the rule would do');
  } finally { await harness.cleanup(); }
});

test('regex-test never writes the chat text to a server log', async () => {
  const harness = await createHarness();
  const seen = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const key of Object.keys(originals)) console[key] = (...args) => { seen.push(args.map(String).join(' ')); };
  try {
    const secret = 'SECRET-CHAT-TEXT-42';
    const { payload } = await test$(harness, presetWith([rule({ findRegex: 'SECRET', replaceString: 'X' })]), { text: secret });
    assert.equal(payload.result.before, secret, 'the caller that supplied the text gets it back');
    assert.equal(payload.result.after, 'X-CHAT-TEXT-42');
    assert.equal(seen.some(line => line.includes(secret)), false, 'the text never reached a log: ' + seen.join(' | '));
  } finally {
    for (const [key, fn] of Object.entries(originals)) console[key] = fn;
    await harness.cleanup();
  }
});

test('the switches and rules the workbench writes are the ones the compile path reads', async () => {
  const harness = await createHarness();
  try {
    const on = await harness.post({ action: 'preview', preset: presetWith([rule()], { enabled: true }), input: 'a(b)c' });
    assert.equal(on.statusCode, 200);
    assert.equal(on.payload.promptRegex.enabled, true);
    assert.equal(on.payload.promptRegex.rules, 1);
    assert.deepEqual(on.payload.promptRegex.applied, ['去掉括号']);
    const off = await harness.post({ action: 'preview', preset: presetWith([rule()], { enabled: false }), input: 'a(b)c' });
    assert.equal(off.payload.promptRegex.enabled, false);
    assert.deepEqual(off.payload.promptRegex.applied, []);
  } finally { await harness.cleanup(); }
});

/* ----------------------------------------------------------------- editor side */

const basePreset = extra => ({
  dsh_system_prompt_enabled: true,
  prompts: [{ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
  ...extra,
});

function element(tag) {
  const node = {
    tagName: tag, children: [], _text: '', checked: false, value: '', disabled: false, hidden: false,
    className: '', dataset: {}, style: {}, type: '', rows: 0, placeholder: '', title: '', spellcheck: true,
    min: '', step: '', files: undefined, files: undefined,
    classList: {
      _set: new Set(),
      toggle(name, on) { if (on === undefined ? !this._set.has(name) : on) this._set.add(name); else this._set.delete(name); },
      add(name) { this._set.add(name); }, remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    },
    append(...kids) { for (const kid of kids) node.children.push(kid); },
    replaceChildren(...kids) { node.children = kids.slice(); },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelector() { return element('span'); }, querySelectorAll() { return []; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = String(value); node.children = []; },
  });
  return node;
}
const textOf = node => [node._text, ...(node.children ?? []).map(textOf)].join(' ');

function editor(presetValue = basePreset(), fetchImpl) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
  const requests = [];
  const fetch = fetchImpl ?? (async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ revision: 1 }) };
  });
  const script = readFileSync(new URL('../web/editor.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/, '').replace('await guard(() => reload())();', '');
  const context = {
    URLSearchParams, structuredClone, console, fetch, __initialPreset: presetValue,
    location: { search: '?sessionId=s' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1, clearTimeout() {},
    confirm: () => true,
    Option: function (text, value) { const option = element('option'); option.textContent = text; option.value = value; return option; },
    crypto: { randomUUID: () => 'uuid' },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: element, createTextNode: text => ({ _text: text, children: [] }) },
  };
  runInNewContext(script + `
    renderList = () => {}; renderEditor = () => {};
    function __textOf(node) { return [node._text || '', ...((node.children ?? []).map(__textOf))].join(' '); }
    preset = structuredClone(__initialPreset);
    globalThis.regexUi = {
      load(value) { preset = value; selectedId = ''; renderRegexPanel(); return preset; },
      preset: () => preset,
      scripts: () => regexScripts(),
      options: () => regexOptions(),
      dirty: () => dirty,
      add: () => regexAdd(),
      remove: index => regexRemove(index),
      move: (index, delta) => regexMove(index, delta),
      duplicate: index => regexDuplicate(index),
      importRules: parsed => { const result = regexImportRules(parsed); renderRegexPanel();
        return { added: result.added, updated: result.updated, skipped: result.skipped }; },
      addPlan(plan) { regexPlan = plan; renderRegexSkipped(); renderRegexList(); },
      showResult(value) { regexTestResult = value; renderRegexTest(); },
      list: () => $('regex-list').children.map(__textOf),
      skipped: () => $('regex-skipped-body').children.map(__textOf),
      hits: () => $('regex-test-result').children.map(__textOf),
      beforePlan: () => regexPlan,
      editorText: () => __textOf($('regex-editor')),
      editorBox: () => $('regex-editor'),
      savePreset: () => persistPresetDraft({ force: true }),
      previewWarnings: result => { show(result); return $('warnings').textContent; },
    };
  `, context);
  return { ...context.regexUi, get, requests, nodes };
}

test('the regex list shows name, order, enabled state, target and depth range', () => {
  const ui = editor(basePreset({
    extensions: {
      regex_scripts: [
        { id: 'a', scriptName: '清理括号', findRegex: '\\(x\\)', replaceString: '', placement: [1, 2], promptOnly: true, minDepth: 0, maxDepth: 3 },
        { id: 'b', scriptName: '显示侧规则', findRegex: 'y', replaceString: '', placement: 2, promptOnly: false, disabled: true },
      ],
      untouched: { keep: true },
    },
  }));
  ui.load(ui.preset());
  const rows = ui.list();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /1\. 清理括号/);
  assert.match(rows[0], /用户正文 \+ 助手正文/);
  assert.match(rows[0], /深度 0–3/);
  assert.match(rows[1], /2\. 显示侧规则/);
  assert.match(rows[1], /助手正文/);
  assert.match(rows[1], /全部深度/);
});

test('the panel edits the preset draft the existing save path persists', () => {
  const ui = editor(basePreset({ extensions: { regex_scripts: [], untouched: { keep: true } } }));
  ui.load(ui.preset());
  ui.add();
  assert.equal(ui.scripts().length, 1);
  assert.equal(ui.scripts()[0].promptOnly, true);
  assert.deepEqual([...ui.scripts()[0].placement], [1, 2]);
  assert.equal(ui.dirty(), true, 'editing rules marks the preset draft dirty for save/auto-save');

  const firstId = ui.scripts()[0].id;
  ui.duplicate(0);
  assert.equal(ui.scripts().length, 2);
  assert.equal(ui.scripts()[1].id !== firstId, true, 'the copy gets its own id');
  assert.match(ui.scripts()[1].scriptName, /副本/);

  ui.scripts()[1].scriptName = '第二条';
  ui.move(0, 1);
  assert.equal(ui.scripts()[0].scriptName, '第二条');
  ui.move(1, -1);
  assert.equal(ui.scripts()[0].id, firstId);

  ui.remove(0);
  assert.equal(ui.scripts().length, 1);
  assert.deepEqual({ ...ui.preset().extensions.untouched }, { keep: true }, 'other extension fields survive');

  // The switches merge into the plugin namespace and keep every other field.
  const onchange = ui.get('regex-enabled').onchange;
  ui.get('regex-enabled').checked = true;
  onchange();
  assert.equal(ui.options().enabled, true);
  assert.deepEqual({ ...ui.preset().extensions.untouched }, { keep: true });
  ui.get('regex-include-prefill').checked = true;
  ui.get('regex-include-prefill').onchange();
  assert.equal(ui.options().includePrefill, true);
  assert.equal(ui.options().enabled, true);
});

test('importing ST rules merges into the array and never turns the master switch on', () => {
  const ui = editor(basePreset({
    extensions: {
      regex_scripts: [{ id: 'keep', scriptName: '已有规则', findRegex: 'a', replaceString: 'b', placement: 1, promptOnly: true }],
      'dsh-preset-enhance': { promptRegex: { enabled: false, includePrefill: false }, other: 7 },
    },
  }));
  ui.load(ui.preset());
  const result = ui.importRules([
    { id: 'keep', scriptName: '已有规则改名', findRegex: 'a', replaceString: 'c', placement: 1, promptOnly: true },
    { scriptName: '新规则', findRegex: 'q', replaceString: 'w', placement: 2, promptOnly: false },
    { scriptName: '新规则', findRegex: 'q', replaceString: 'w', placement: 2, promptOnly: false },
  ]);
  assert.deepEqual({ added: result.added, updated: result.updated, skipped: result.skipped },
    { added: 1, updated: 1, skipped: 1 });
  assert.equal(ui.scripts().length, 2);
  assert.equal(ui.scripts()[0].replaceString, 'c', 'an exported id updates the rule with that id');
  assert.equal(ui.scripts()[1].promptOnly, false, 'import must not promote a display-side rule');
  assert.equal(ui.scripts()[1].id.length > 0, true, 'imported rules get an id');
  assert.equal(ui.options().enabled, false, 'the master switch is untouched by import');
  assert.equal(ui.preset().extensions['dsh-preset-enhance'].other, 7, 'other namespace fields survive');
});

test('the skipped area lists disabled, unsupported and out-of-window rules separately', () => {
  const ui = editor(basePreset({ extensions: { regex_scripts: [
    { id: 'a', scriptName: '停用', findRegex: 'x', replaceString: '', placement: [1], promptOnly: true, disabled: true },
    { id: 'b', scriptName: '显示侧', findRegex: 'x', replaceString: '', placement: [1], promptOnly: false },
    { id: 'c', scriptName: '深层', findRegex: 'x', replaceString: '', placement: [1], promptOnly: true, minDepth: 3 },
  ] } }));
  ui.load(ui.preset());
  ui.addPlan([
    { index: 0, name: '停用', runs: false, supported: true, targets: ['user'], unsupportedPlacements: [], reason: '已停用' },
    { index: 1, name: '显示侧', runs: false, supported: false, targets: ['user'], unsupportedPlacements: [], reason: '仅作用于显示侧或消息写入阶段，本次请求不执行' },
    { index: 2, name: '深层', runs: false, supported: true, targets: ['user'], unsupportedPlacements: [], reason: '深度 0 不在规则窗口内' },
  ]);
  const blocks = ui.skipped();
  const joined = blocks.join(' || ');
  assert.match(joined, /已停用（1）/);
  assert.match(joined, /当前不支持（1）/);
  assert.match(joined, /深度窗口外（1）/);
  assert.match(joined, /仅作用于显示侧或消息写入阶段/);
  assert.match(joined, /深度 0 不在规则窗口内/);
});

test('findRegex and replaceString are edited directly, the rest sits under 高级选项', () => {
  const ui = editor(basePreset({ extensions: { regex_scripts: [
    { id: 'a', scriptName: '规则', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true },
  ] } }));
  ui.load(ui.preset());
  const box = ui.editorBox();
  const find = box.children[4].children[1];
  const replace = box.children[5].children[1];
  assert.equal(find.value, 'x');
  assert.equal(replace.value, 'y');
  find.value = 'foo(';
  find.oninput();
  replace.value = 'bar';
  replace.oninput();
  assert.equal(ui.scripts()[0].findRegex, 'foo(');
  assert.equal(ui.scripts()[0].replaceString, 'bar');
  const advanced = ui.editorText();
  assert.match(advanced, /trimStrings/);
  assert.match(advanced, /substituteRegex/);
  assert.match(advanced, /runOnEdit/);
});

test('regex edits ride the existing preset save', async () => {
  const ui = editor(basePreset({ extensions: { regex_scripts: [] } }));
  ui.load(ui.preset());
  ui.add();
  assert.equal(ui.dirty(), true);
  await ui.savePreset();
  const saved = ui.requests.find(request => request.action === 'save');
  assert.ok(saved, 'the preset save posts the draft');
  assert.equal(saved.preset.extensions.regex_scripts.length, 1);
  assert.equal(saved.preset.extensions.regex_scripts[0].scriptName, '新规则 1');
});

test('the request preview shows the same regex summary, and the card states the send-only scope', async () => {
  const ui = editor();
  const warnings = ui.previewWarnings({
    messages: [], warnings: ['已有提示'],
    assistantPrefix: { active: false },
    promptRegex: { enabled: true, includePrefill: false, rules: 3, applied: ['清理'] },
  });
  assert.match(warnings, /提示词正则：已启用 · 规则 3 条 · 本次命中：清理/);
  assert.match(warnings, /已有提示/);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /提示词正则只改写发送给模型的请求副本/);
  assert.match(html, /不会改变聊天界面|聊天界面里已显示的内容不会变化/);
  assert.match(html, /整段聊天正文不会写入服务端日志/);
  assert.match(html, /id="regex-test-text"/);
  assert.match(html, /id="regex-skipped"/);
});

test('the test box posts to the shared regex entry and keeps 命中 / 未命中 / 不适用 apart', async () => {
  const ui = editor(basePreset({ extensions: { regex_scripts: [
    { id: 'a', scriptName: '命中规则', findRegex: 'x', replaceString: '', placement: [1], promptOnly: true },
  ] } }));
  ui.load(ui.preset());
  ui.get('regex-test-text').value = 'a(b)c';
  ui.get('regex-test-target').value = 'user';
  ui.get('regex-test-depth').value = '2';
  await ui.get('regex-test-run').onclick();
  assert.equal(ui.requests.length, 1);
  const body = ui.requests[0];
  assert.equal(body.action, 'regex-test');
  assert.equal(body.text, 'a(b)c');
  assert.equal(body.target, 'user');
  assert.equal(body.depth, 2);
  // The draft is posted as-is (JSON comparison: the vm realm makes the objects reference-unequal).
  assert.equal(JSON.stringify(body.preset), JSON.stringify(ui.preset()), 'the draft preset is sent as-is');
  assert.deepEqual(body.preset.extensions.regex_scripts.map(script => script.id), ['a']);

  ui.showResult({
    depth: -1, target: 'prefill', notes: ['未开启“同时处理预填充”：真实请求不会处理预填充'],
    rules: [
      { index: 0, name: '命中规则', applicable: true, hit: true, reason: '' },
      { index: 1, name: '没匹配上', applicable: true, hit: false, reason: '' },
      { index: 2, name: '显示侧', applicable: false, hit: false, reason: '仅作用于显示侧或消息写入阶段，本次请求不执行' },
    ],
    result: { before: 'before', after: 'after', applied: ['命中规则'], changed: true },
  });
  const rendered = ui.hits().join(' || ');
  assert.match(rendered, /命中：命中规则/);
  assert.match(rendered, /未命中（规则可执行，但这段文本没有匹配）：没匹配上/);
  assert.match(rendered, /仅作用于显示侧或消息写入阶段，本次请求不执行：显示侧/);
  assert.match(ui.get('regex-test-note').textContent, /使用深度 -1/);
  assert.match(ui.get('regex-test-note').textContent, /预填充/);
});
