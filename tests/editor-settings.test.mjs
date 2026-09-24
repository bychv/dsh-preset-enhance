import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('../web/editor.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/, '').replace('await guard(() => reload())();', '');
function editor(storage = new Map(), fetch = async () => { throw new Error('offline'); }) {
  const nodes = new Map();
  const node = () => ({ checked: false, value: '', dataset: {}, style: {}, hidden: false,
    classList: { toggle() {}, add() {}, remove() {} }, append() {}, replaceChildren() {},
    addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], setAttribute() {} });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = { URLSearchParams, structuredClone, console, fetch,
    location: { search: '?sessionId=s' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: () => 1, clearTimeout() {},
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: get, addEventListener() {}, createElement: node },
  };
  runInNewContext(script + `
    renderList = () => {}; renderEditor = () => {};
    globalThis.editor = { setup() {
      state = { revision: 1, presets: [], sessionMode: 'standard', toolCatalogs: {}, outputExtractionTemplate: 'format' };
      $('tool-mode').value = 'standard'; $('tool-scope').value = 'session';
      $('tool-auto-save').checked = true; $('order').value = '100001'; loadToolDraft(true);
    }, toggleExtraction() { $('prefix-output-extraction').checked = true; $('prefix-output-extraction').onchange(); },
    prompt: () => preset.prompts.find(p => p.identifier === 'dsh-output-extraction-template'),
    order: () => order(),
    protocol(value) {
      // The switch needs two sides to be usable, so the stub offers both the way a host does,
      // and the current provider decides which protocol this session is on.
      state.connectionChoice = { provider: value === 'messages' ? 'official' : 'plugin', model: null, reasoningEffort: null, canSwitch: true,
        choices: [
          { provider: 'plugin', label: 'plugin', protocol: 'chat-completions', defaultModel: '' },
          { provider: 'official', label: 'official', protocol: 'messages', defaultModel: '' },
        ] };
      state.connection = { source: 'settings', protocol: value };
      renderConnectionChoice();
    },
    change(value) { toolDraft.policy.read = value; markToolDirty(); },
    setPreset(value) { preset = value; selectedPrompt = order()[0]?.identifier ?? ''; renderList(); },
    prefill(value) { state.prefixOutputExtraction = value; },
    autoExtraction: () => ensurePrefillExtractionTemplate(),
    showImportNotice: () => showImportedExtractionNotice(),
    hideImportNotice: () => hidePresetNotice(),
    notice: () => ({ hidden: $('preset-notice').hidden, kind: $('preset-notice').dataset.kind }),
    identifiers: () => order().map(item => item.identifier),
    selectionSetup(waitForSave = Promise.resolve()) {
      selectedId = 'A';
      state.binding = { enabled: true, presetId: 'A' };
      state.selectedPresetId = 'A';
      globalConfigAutoSaveChain = waitForSave;
      renderProtocolNotice = renderPresetLibrary = renderConnectionChoice = syncPrefixToolControls =
        renderAutoModes = syncDraftsWithState = renderToolModes = updateSessionNote = () => {};
      loadDraft = id => { selectedId = id; };
    },
    choose(id) { $('library').value = id; return $('library').onchange(); },
    reloadSelection: () => reload(),
    selected: () => selectedId,
    draft: () => toolDraft,
    save: runAutoSave, flush: flushToolDraftKeepalive,
    };
  `, context);
  context.editor.setup();
  return { ...context.editor, get, storage };
}

test('Messages disables prefill; enabling extraction inserts one template and preserves edits', () => {
  const ui = editor();
  ui.protocol('messages');
  assert.equal(ui.get('prefill-settings').disabled, true);
  assert.equal(ui.get('connection-toggle').disabled, false);
  ui.protocol('chat-completions');
  assert.equal(ui.get('prefill-settings').disabled, false);
  ui.toggleExtraction();
  assert.equal(ui.prompt().content, 'format');
  ui.prompt().content = 'edited';
  ui.toggleExtraction();
  assert.equal(ui.prompt().content, 'edited');
  assert.equal(ui.order().filter(p => p.identifier === ui.prompt().identifier).length, 1);
});

test('latest edit survives refresh while an older tool save is in flight', async () => {
  let finish;
  const storage = new Map();
  const ui = editor(storage, () => new Promise(resolve => { finish = resolve; }));
  ui.change(false);
  const saving = ui.save();
  await Promise.resolve();
  ui.change(true);
  assert.equal(ui.flush(), 0);
  finish({ ok: true, json: async () => ({ revision: 2 }) });
  await saving;
  const recovered = editor(storage, async () => ({ ok: true, json: async () => ({ revision: 3 }) }));
  assert.equal(recovered.draft().policy.read, true);
  assert.equal(recovered.draft().dirty, true);
  await recovered.save();
  assert.equal(recovered.draft().dirty, false);
  assert.equal(storage.size, 0);
});

test('failed keepalive keeps a recoverable draft', async () => {
  const ui = editor();
  ui.change(false);
  assert.equal(ui.flush(), 1);
  await new Promise(resolve => setImmediate(resolve));
  const recovered = editor(ui.storage);
  assert.equal(recovered.draft().policy.read, false);
  assert.equal(recovered.draft().dirty, true);
});

test('importing a prefill preset with extraction on adds and positions the extraction prompt', () => {
  const ui = editor();
  ui.prefill(true);
  ui.setPreset({
    prompts: [
      { identifier: 'chatHistory', marker: true },
      { identifier: 'lead', role: 'system', content: 'sys' },
      { identifier: 'tail', role: 'assistant', content: 'Continue:' },
    ],
    prompt_order: [{ character_id: '100001', order: [
      { identifier: 'lead', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'tail', enabled: true },
    ] }],
  });
  assert.equal(ui.autoExtraction(), true, 'a prefill preset with extraction on gets the prompt');
  assert.equal(ui.prompt()?.identifier, 'dsh-output-extraction-template');
  assert.equal(ui.prompt()?.content, 'format');
  const ids = ui.identifiers();
  assert.equal(ids[ids.indexOf('chatHistory') + 1], 'dsh-output-extraction-template',
    'it is placed right after the chat history');
  // Idempotent: the same import shape again must not add a second entry.
  assert.equal(ui.autoExtraction(), false);
  assert.equal(ui.identifiers().filter(id => id === 'dsh-output-extraction-template').length, 1);
});

test('the extraction prompt is not added when extraction is off or the preset does not prefill', () => {
  const off = editor();
  off.prefill(false);
  off.setPreset({
    prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'tail', role: 'assistant', content: 'x' }],
    prompt_order: [{ character_id: '100001', order: [
      { identifier: 'chatHistory', enabled: true }, { identifier: 'tail', enabled: true },
    ] }],
  });
  assert.equal(off.autoExtraction(), false, 'extraction off means no insertion');
  assert.equal(off.prompt(), undefined);

  const notPrefill = editor();
  notPrefill.prefill(true);
  notPrefill.setPreset({
    prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'u', role: 'user', content: 'x' }],
    prompt_order: [{ character_id: '100001', order: [
      { identifier: 'chatHistory', enabled: true }, { identifier: 'u', enabled: true },
    ] }],
  });
  assert.equal(notPrefill.autoExtraction(), false, 'a preset that does not end on an assistant turn is left alone');
  assert.equal(notPrefill.prompt(), undefined);
});

test('the auto-inserted extraction prompt is announced to the user', () => {
  const ui = editor();
  // The DOM stub starts elements visible, so drive the clearing path explicitly instead of
  // relying on the element's hidden attribute in index.html.
  ui.hideImportNotice();
  assert.equal(ui.notice().hidden, true, 'a fresh import clears any previous notice');
  assert.equal(ui.notice().kind, '', 'and forgets what it was about');
  ui.showImportNotice();
  assert.equal(ui.notice().hidden, false, 'the notice is visible after the insert');
  assert.equal(ui.notice().kind, 'import-extraction');
  ui.hideImportNotice();
  assert.equal(ui.notice().hidden, true, 'dismissing hides it again');
});

test('library selection waits for older saves and includes the current session', async () => {
  const requests = [];
  let finishSave;
  const saving = new Promise(resolve => { finishSave = resolve; });
  const ui = editor(new Map(), async (_url, options) => {
    if (options?.body) {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: 'B', revision: 2 }) };
    }
    return { ok: true, json: async () => ({ revision: 2, presets: [], selectedPresetId: 'B',
      binding: { enabled: true, presetId: 'B' } }) };
  });
  ui.selectionSetup(saving);
  const switching = ui.choose('B');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0);
  finishSave();
  await switching;
  assert.deepEqual(requests, [{ revision: 1, action: 'select-preset', id: 'B', sessionId: 's' }]);
  assert.equal(ui.selected(), 'B');
  assert.match(ui.get('status').textContent, /当前会话/);
});

test('reopening the editor shows the session preset before the global default', async () => {
  let binding = { enabled: true, presetId: 'A' };
  const ui = editor(new Map(), async () => ({ ok: true, json: async () => ({
    revision: 2, presets: [], selectedPresetId: 'B', binding,
  }) }));
  ui.selectionSetup();
  await ui.reloadSelection();
  assert.equal(ui.selected(), 'A');
  binding = { enabled: false, presetId: '' };
  await ui.reloadSelection();
  assert.equal(ui.selected(), 'B');
});