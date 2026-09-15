// Focused repro: does a saved tool-switch edit survive scope/mode switching and a reload?
// Usage: node scripts/tool-persist-repro.mjs --base <url> --token-url <url> [--mode <modeId>]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const BASE = (arg('base') ?? 'http://127.0.0.1:3182').replace(/\/$/, '');
const TOKEN_URL = arg('token-url') ?? BASE;
const OUT = arg('out') ?? join(tmpdir(), 'dsv-repro');
const MODE = arg('mode') ?? 'ptc';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(arg('port') ?? 9334);
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsv-edge-repro-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: ['ignore', openSync(join(OUT, 'browser.log'), 'a'), openSync(join(OUT, 'browser.log'), 'a')] });

const trace = [];
const record = (step, value) => { trace.push({ step, value }); console.log(step, JSON.stringify(value)); };

try {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(target => target.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  const events = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
      return;
    }
    for (const listener of events.get(message.method) ?? []) listener(message.params);
    events.delete(message.method);
  };
  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const once = event => new Promise(resolve => {
    const list = events.get(event) ?? [];
    list.push(resolve);
    events.set(event, list);
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const load = async url => { const done = once('Page.loadEventFired'); await send('Page.navigate', { url }); await done; };
  await load(TOKEN_URL);
  await load(`${BASE}/preset-enhance?sessionId=`);
  for (let i = 0; i < 40; i++) { if (await evaluate('!!document.getElementById("tool-tablist") && !!document.querySelector("#tool-list input[data-tool]")')) break; await sleep(300); }
  await sleep(1500);

  // select the target mode
  await evaluate(`(() => { const s = document.getElementById('tool-mode'); s.value = ${JSON.stringify(MODE)}; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);

  const snapshot = async label => {
    const ui = await evaluate(`(() => {
      const boxes = [...document.querySelectorAll('#tool-list input[data-tool]')];
      return {
        scope: document.getElementById('tool-scope').value,
        mode: document.getElementById('tool-mode').value,
        status: document.getElementById('status').textContent,
        checkedCount: boxes.filter(b => b.checked).length,
        total: boxes.length,
        off: boxes.filter(b => !b.checked).map(b => b.dataset.tool),
        tabLabel: document.querySelector('#tool-tablist [aria-selected="true"]')?.textContent ?? null,
      };
    })()`);
    const api = await evaluate(`fetch('/preset-enhance/api').then(r => r.json()).then(s => ({
      revision: s.revision,
      policy: s.modeToolPolicies[${JSON.stringify(MODE)}] ?? null,
      selection: s.modeToolSelections[${JSON.stringify(MODE)}] ?? null,
      sessionPolicy: s.sessionToolPolicy ?? null,
      sessionSelection: s.sessionToolSelection ?? null,
    }))`);
    record(label, { ui, api });
    return { ui, api };
  };

  const before = await snapshot('0-initial');
  const targets = before.ui.off.length ? before.ui.off.slice(0, 2) : await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('#tool-list input[data-tool]')].filter(b => b.checked).slice(0, 2);
    for (const box of boxes) box.click();
    return boxes.map(box => box.dataset.tool);
  })()`);
  await sleep(600);
  await snapshot('1-after-uncheck');
  await evaluate(`document.getElementById('save-tools').click()`);
  await sleep(2500);
  await snapshot('2-after-save');
  await evaluate(`(() => { const s = document.getElementById('tool-scope'); s.value = 'session'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  await snapshot('3-session-scope');
  await evaluate(`(() => { const s = document.getElementById('tool-scope'); s.value = 'mode'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  await snapshot('4-back-to-mode');
  await evaluate(`(() => { const s = document.getElementById('tool-mode'); s.value = s.options[0].value; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  await evaluate(`(() => { const s = document.getElementById('tool-mode'); s.value = ${JSON.stringify(MODE)}; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  await snapshot('5-mode-away-and-back');
  const reloaded = once('Page.loadEventFired');
  await send('Page.reload', {});
  await reloaded;
  for (let i = 0; i < 40; i++) { if (await evaluate('!!document.getElementById("tool-tablist") && !!document.querySelector("#tool-list input[data-tool]")')) break; await sleep(300); }
  await sleep(1800);
  await snapshot('6-after-reload');
  writeFileSync(join(OUT, 'repro.json'), JSON.stringify({ mode: MODE, targets, trace }, null, 2));
  console.log('targets (should stay disabled):', JSON.stringify(targets));
} catch (error) {
  console.error('REPRO ERROR', error);
  process.exitCode = 2;
} finally {
  try { browser.kill(); } catch { /* ignore */ }
}
