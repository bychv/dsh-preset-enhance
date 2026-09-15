// Real-browser E2E for the tool preset workbench, driven over the Chrome DevTools Protocol.
// Usage: node scripts/browser-e2e.mjs --base http://127.0.0.1:3180 --token-url "http://127.0.0.1:3180/?token=..."
// Launches headless Edge with its own profile, logs in with the sandbox token, then exercises
// the real DOM: tabs, keyboard, tri-state, batch operations, collapse/localStorage, mobile
// select, group management page and one save round trip. Writes screenshots next to --out.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const BASE = (arg('base') ?? 'http://127.0.0.1:3180').replace(/\/$/, '');
const TOKEN_URL = arg('token-url') ?? BASE;
const OUT = arg('out') ?? join(tmpdir(), 'dsv-ui');
const EDGE = arg('browser') ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(arg('port') ?? 9333);

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsv-edge-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const logFile = join(OUT, 'browser.log');
const logFd = openSync(logFile, 'a');
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', logFd, logFd], detached: false });
browser.on('error', error => console.error('browser spawn error', error.message));
browser.on('exit', (code, signal) => console.error(`browser exited code=${code} signal=${signal}`));

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return response.json();
}
async function waitForBrowser() {
  for (let i = 0; i < 60; i++) {
    try { return await json('/json/version'); } catch { await sleep(500); }
  }
  throw new Error('headless browser did not expose the debugging port');
}

let socket;
let nextId = 1;
const pending = new Map();
const listeners = new Map();
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function once(event, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    const list = listeners.get(event) ?? [];
    list.push(value => { clearTimeout(timer); resolve(value); });
    listeners.set(event, list);
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(`page exception: ${response.exceptionDetails.text} ${response.exceptionDetails.exception?.description ?? ''}`);
  return response.result?.value;
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate('document.readyState === "complete" && !!document.getElementById("tool-tablist")').catch(() => false);
    if (ready) return true;
    await sleep(250);
  }
  return false;
}
async function settle(ms = 1200) { await sleep(ms); }
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
async function shotClip(name, selector, scale = 2) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'start' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x + window.scrollX - 8), y: Math.max(0, r.y + window.scrollY - 8), width: r.width + 16, height: r.height + 16 };
  })()`);
  if (!box) return null;
  await settle(250);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale } });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

try {
  await waitForBrowser();
  const targets = await json('/json/list');
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('no page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    listeners.delete(message.method);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  listeners.set('Page.javascriptDialogOpening', []);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.javascriptDialogOpening') {
      socket.send(JSON.stringify({ id: nextId++, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
  });

  // 1. log in with the sandbox launch token, then open the workbench
  const login = once('Page.loadEventFired');
  await send('Page.navigate', { url: TOKEN_URL });
  await login;
  const workbench = once('Page.loadEventFired');
  await send('Page.navigate', { url: `${BASE}/preset-enhance?sessionId=` });
  await workbench;
  check('workbench page loads', await waitReady());
  await settle(2000);

  // 2. static structure from the live API
  const tabs = await evaluate(`[...document.querySelectorAll('#tool-tablist [role="tab"]')].map(b => ({
    id: b.dataset.group, label: b.textContent, selected: b.getAttribute('aria-selected'),
    controls: b.getAttribute('aria-controls'), tabindex: b.tabIndex,
    targetExists: !!document.getElementById(b.getAttribute('aria-controls')),
  }))`);
  check('tablist renders 全部 + 未分组', tabs.length >= 2 && tabs[0].id === '@all' && tabs[1].id === '@ungrouped',
    tabs.map(tab => `${tab.label}`).join(' | '));
  check('tabs expose aria-selected/aria-controls and roving tabindex',
    tabs.every(tab => tab.controls && tab.targetExists) && tabs.filter(tab => tab.selected === 'true').length === 1,
    `selected=${tabs.find(tab => tab.selected === 'true')?.id}`);
  const stat = await evaluate(`(() => { const s = document.querySelector('.group-stat'); return s ? s.textContent : null; })()`);
  check('active group shows 已启用/总数 statistic', /已启用\s*\d+\/\d+/.test(stat ?? ''), stat);
  const catalogSize = await evaluate(`document.querySelectorAll('#tool-group-panels input[data-tool]').length`);
  check('live tool catalog rendered', catalogSize > 0, `${catalogSize} tools`);

  // 3. tri-state group switch exists and reflects the current draft
  const tri = await evaluate(`(() => { const s = document.querySelector('.group-switch'); return s ? { checked: s.checked, indeterminate: s.indeterminate } : null; })()`);
  check('tri-state group switch present', tri !== null, JSON.stringify(tri));

  // 4. 全关 / 全开 are draft-only and untouched by tab filtering
  await evaluate(`document.getElementById('clear-all-tools').click()`);
  await settle(300);
  const afterClear = await evaluate(`(() => ({
    checked: [...document.querySelectorAll('#tool-group-panels input[data-tool]')].filter(i => i.checked).length,
    status: document.getElementById('status').textContent,
    tri: (() => { const s = document.querySelector('.group-switch'); return s ? s.checked : null; })(),
  }))()`);
  check('全不选 clears every tool of the mode', afterClear.checked === 0, JSON.stringify(afterClear));
  check('batch edit marks the draft 尚未保存', /尚未保存/.test(afterClear.status), afterClear.status);
  await evaluate(`document.getElementById('select-all-tools').click()`);
  await settle(300);
  const afterAll = await evaluate(`[...document.querySelectorAll('#tool-group-panels input[data-tool]')].filter(i => i.checked).length`);
  check('全选 selects every tool of the mode', afterAll === catalogSize, `${afterAll}/${catalogSize}`);

  // 5. keyboard navigation on the real tablist
  const keyboard = await evaluate(`(() => {
    const list = document.getElementById('tool-tablist');
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    tabs[0].focus();
    return { before: document.activeElement.dataset.group, count: tabs.length };
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await settle(400);
  const afterKey = await evaluate(`({ focus: document.activeElement.dataset.group, selected: document.querySelector('#tool-tablist [aria-selected="true"]')?.dataset.group })`);
  check('ArrowRight moves tab focus and selection', keyboard.before !== afterKey.focus && afterKey.focus === afterKey.selected,
    `${keyboard.before} -> ${afterKey.focus} (selected ${afterKey.selected})`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
  await settle(400);
  const afterEnd = await evaluate(`({ focus: document.activeElement.dataset.group, selected: document.querySelector('#tool-tablist [aria-selected="true"]')?.dataset.group })`);
  check('End jumps to the last tab', afterEnd.focus === afterEnd.selected && afterEnd.focus !== afterKey.focus, JSON.stringify(afterEnd));
  await shot('01-workbench.png');

  // 6. collapse to the compact select, persisted in localStorage across a reload
  await evaluate(`document.getElementById('tool-tabs-toggle').click()`);
  await settle(400);
  const collapsed = await evaluate(`(() => ({
    tablistHidden: document.getElementById('tool-tablist').hidden,
    selectVisible: !document.getElementById('tool-group-select-wrap').hidden,
    expanded: document.getElementById('tool-tabs-toggle').getAttribute('aria-expanded'),
    stored: localStorage.getItem('dsh-preset-enhance.tool-tabs-collapsed'),
    value: document.getElementById('tool-group-select').value,
  }))()`);
  check('收起标签栏 swaps the tablist for the compact select',
    collapsed.tablistHidden && collapsed.selectVisible && collapsed.expanded === 'false' && collapsed.stored === '1',
    JSON.stringify(collapsed));
  const reload = once('Page.loadEventFired');
  await send('Page.reload', {});
  await reload;
  await waitReady();
  await settle(1800);
  const persisted = await evaluate(`(() => ({
    tablistHidden: document.getElementById('tool-tablist').hidden,
    selectVisible: !document.getElementById('tool-group-select-wrap').hidden,
    active: document.getElementById('tool-group-select').value,
  }))()`);
  check('collapse state survives a reload (localStorage only)', persisted.tablistHidden && persisted.selectVisible, JSON.stringify(persisted));
  await evaluate(`document.getElementById('tool-tabs-toggle').click()`);
  await settle(400);

  // 7. narrow viewport falls back to the select automatically
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 950, deviceScaleFactor: 1, mobile: false });
  await settle(500);
  const narrow = await evaluate(`(() => ({
    tablistHidden: document.getElementById('tool-tablist').hidden,
    selectVisible: !document.getElementById('tool-group-select-wrap').hidden,
    media: window.matchMedia('(max-width: 760px)').matches,
  }))()`);
  await shot('02-narrow.png');
  check('<760px uses the compact select', narrow.media && narrow.tablistHidden && narrow.selectVisible, JSON.stringify(narrow));
  await send('Emulation.clearDeviceMetricsOverride');
  await settle(500);

  // 8. group management page renders from the live groups
  await evaluate(`document.getElementById('manage-groups').click()`);
  await settle(600);
  const groups = await evaluate(`(() => ({
    pageVisible: !document.getElementById('tool-groups-page').hidden,
    listHidden: document.getElementById('tool-tab-area').hidden,
    editors: document.querySelectorAll('#group-list .group-editor').length,
    expanded: document.getElementById('manage-groups').getAttribute('aria-expanded'),
  }))()`);
  check('管理分组 opens the second-level page with the groups', groups.pageVisible && groups.listHidden && groups.expanded === 'true',
    JSON.stringify(groups));
  const groupCounts = await evaluate(`(() => [...document.querySelectorAll('#group-list .group-editor')].map(editor => {
    const label = editor.querySelector('[data-role="member-count"]')?.textContent ?? '';
    const boxes = editor.querySelectorAll('input[data-tool]');
    const match = label.match(/本组共\\s*(\\d+)\\s*个成员（(.+?)\\s*中\\s*(\\d+)\\s*个）/);
    return { label, shown: boxes.length, checked: [...boxes].filter(box => box.checked).length,
      total: match ? Number(match[1]) : null, inMode: match ? Number(match[3]) : null };
  }))()`);
  check('group counts are mode-scoped and agree with the assignment grid',
    groupCounts.length > 0 && groupCounts.every(item => item.inMode !== null && item.inMode === item.checked),
    JSON.stringify(groupCounts));
  await shot('03-groups.png');
  await evaluate(`document.getElementById('group-back').click()`);
  await settle(400);
  const groupPageOpen = await evaluate(`!document.getElementById('tool-groups-page').hidden`);
  check('返回工具列表 closes the group page', groupPageOpen === false, `groupPageHidden=${!groupPageOpen}`);

  // 9. user group batch operation (draft only): 仅启用此组
  const groupMode = await evaluate(`(async () => {
    const select = document.getElementById('tool-mode');
    const available = new Set([...select.options].map(option => option.value));
    const state = await fetch('/preset-enhance/api').then(response => response.json());
    for (const group of state.toolGroups ?? []) {
      const member = (group.members ?? []).find(item => available.has(item.modeId) &&
        (state.toolCatalogs?.[item.modeId] ?? []).some(tool => tool.name === item.toolName));
      if (member) return { mode: member.modeId, group: group.id, label: group.name };
    }
    return null;
  })()`);
  const userTab = groupMode ? await (async () => {
    await evaluate(`(() => {
      const select = document.getElementById('tool-mode');
      select.value = ${JSON.stringify(groupMode.mode)};
      select.dispatchEvent(new Event('change'));
    })()`);
    await settle(1200);
    const label = await evaluate(`(() => {
      const tab = document.querySelector('#tool-tablist [data-group=${JSON.stringify(groupMode.group)}]');
      tab?.click();
      return tab?.textContent.trim() ?? '';
    })()`);
    await settle(500);
    return { ...groupMode, label };
  })() : null;
  if (userTab) {
    const clicked = await evaluate(`(() => {
      const id = document.querySelector('#tool-tablist [aria-selected="true"]').getAttribute('aria-controls');
      const panel = document.getElementById(id);
      const only = [...panel.querySelectorAll('button')].find(b => b.textContent.includes('仅启用此组'));
      if (!only || only.disabled) return null;
      only.click();
      return true;
    })()`);
    await settle(600);
    const draft = await evaluate(`(() => {
      const id = document.querySelector('#tool-tablist [aria-selected="true"]').getAttribute('aria-controls');
      const panel = document.getElementById(id);
      const checked = [...panel.querySelectorAll('input[data-tool]')].filter(i => i.checked).map(i => i.dataset.tool);
      return { checked, status: document.getElementById('status').textContent };
    })()`);
    await evaluate(`(() => { const t = [...document.querySelectorAll('#tool-tablist [role="tab"]')].find(b => b.dataset.group === '@all'); t?.click(); })()`);
    await settle(500);
    const overall = await evaluate(`(() => {
      const id = document.querySelector('#tool-tablist [aria-selected="true"]').getAttribute('aria-controls');
      const panel = document.getElementById(id);
      const checked = [...panel.querySelectorAll('input[data-tool]')].filter(i => i.checked).map(i => i.dataset.tool);
      const total = panel.querySelectorAll('input[data-tool]').length;
      return { checked, total };
    })()`);
    check('仅启用此组 keeps exactly the group members enabled',
      clicked === true && draft.checked.length > 0 && draft.checked.length < overall.total &&
      JSON.stringify([...overall.checked].sort()) === JSON.stringify([...draft.checked].sort()) &&
      /尚未保存/.test(draft.status),
      `mode=${userTab.mode} group=${userTab.group} "${userTab.label}" enabled=${draft.checked.join(',')} mode=${overall.checked.length}/${overall.total} status=${draft.status}`);
  } else {
    check('仅启用此组 keeps exactly the group members enabled', false, 'no user group with tools in any mode');
  }
  await shot('04-group-only.png');
  const reloadAfterDraft = once('Page.loadEventFired');
  await send('Page.reload', {});
  await reloadAfterDraft;
  await waitReady();
  await settle(1800);

  // 10. objective layout checks on the real rendered workbench
  const layout = await evaluate(`(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 &&
      getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const tabButtons = [...document.querySelectorAll('#tool-tablist [role="tab"]')];
    const tabs = tabButtons.map(b => ({ id: b.dataset.group, label: b.textContent.trim(), ...rect(b) }));
    const overlaps = [];
    for (let i = 0; i < tabs.length; i++) {
      for (let j = i + 1; j < tabs.length; j++) {
        const a = tabs[i], b = tabs[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push([a.id, b.id]);
      }
    }
    const active = document.querySelector('#tool-tablist [aria-selected="true"]');
    const panel = document.getElementById(active.getAttribute('aria-controls'));
    const buttons = [...panel.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), ...rect(b), visible: visible(b) }));
    const list = panel.querySelector('.tool-list-toggle') ?? panel.querySelector('details');
    const tools = [...panel.querySelectorAll('input[data-tool]')];
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      tablist: { ...rect(document.getElementById('tool-tablist')), display: getComputedStyle(document.getElementById('tool-tablist')).display },
      tabs, overlaps,
      panel: { ...rect(panel), display: getComputedStyle(panel).display },
      panelVisible: visible(panel),
      listVisible: visible(list),
      toolRows: tools.length,
      toolRowBox: tools[0] ? rect(tools[0].closest('label') ?? tools[0]) : null,
      switch: (() => {
        const sw = panel.querySelector('.group-switch');
        if (!sw) return null;
        const r = sw.getBoundingClientRect();
        return { tag: sw.tagName, type: sw.type, w: Math.round(r.width), h: Math.round(r.height), visible: visible(sw),
          disabled: sw.disabled, indeterminate: sw.indeterminate, checked: sw.checked,
          inSummary: !!sw.closest('summary'), ariaLabel: sw.getAttribute('aria-label') };
      })(),
      stat: panel.querySelector('.group-stat')?.textContent ?? null,
      batchButtons: ['全开', '全关', '仅启用此组', '恢复预设值'].filter(text => buttons.some(b => b.text.includes(text))),
      contentDetails: { tag: panel.tagName, open: panel.hasAttribute('open') },
      tabLabelPattern: tabs.map(t => t.label).filter(l => /·\\s*\\d+\\/\\d+/.test(l)).length,
    };
  })()`);
  check('no horizontal overflow at 1440px', layout.scrollWidth <= layout.viewport.w + 1 && layout.bodyScrollWidth <= layout.viewport.w + 1,
    `scrollWidth=${layout.scrollWidth} viewport=${layout.viewport.w}`);
  check('tab buttons are laid out without overlap', layout.tabs.length >= 2 && layout.overlaps.length === 0,
    `${layout.tabs.length} tabs, overlaps=${JSON.stringify(layout.overlaps)}`);
  check('every tab has a positive visible box', layout.tabs.every(tab => tab.w > 20 && tab.h > 10),
    layout.tabs.map(tab => `${tab.id}:${tab.w}x${tab.h}`).join(' '));
  check('active panel and its tool list are visible', layout.panelVisible && layout.listVisible && layout.toolRows > 0,
    `panel=${JSON.stringify(layout.panel)} rows=${layout.toolRows} row0=${JSON.stringify(layout.toolRowBox)}`);
  check('tri-state group switch is a live checkbox in the summary row',
    layout.switch?.tag === 'INPUT' && layout.switch.type === 'checkbox' && layout.switch.visible &&
    !layout.switch.disabled && layout.switch.inSummary,
    JSON.stringify(layout.switch));
  check('all four batch buttons are rendered', layout.batchButtons.length === 4, layout.batchButtons.join(','));
  check('group content lives in an open <details>', layout.contentDetails.open === true, JSON.stringify(layout.contentDetails));
  check('tab labels show 名称 · 已启用/总数', layout.tabLabelPattern >= 2, layout.stat ?? '');
  const tabStress = await evaluate(`(() => {
    const list = document.getElementById('tool-tablist');
    const seed = list.querySelector('[role="tab"]');
    const clones = [];
    for (let index = 0; index < 32; index += 1) {
      const clone = seed.cloneNode(true);
      clone.id = 'mcp-stress-tab-' + index;
      clone.dataset.group = '@mcp:stress_' + index;
      clone.querySelector('.tab-label').textContent = 'stress_server_w…long_name_' + index + ' · MCP · 1/1';
      clone.setAttribute('aria-selected', 'false');
      clone.tabIndex = -1;
      list.append(clone);
      clones.push(clone);
    }
    const style = getComputedStyle(list);
    const pageWidthBefore = document.documentElement.scrollWidth;
    const overflow = list.scrollWidth > list.clientWidth;
    list.scrollLeft = 0;
    clones.at(-1).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const scrolledToLast = list.scrollLeft > 0;
    const labelStyle = getComputedStyle(clones.at(-1).querySelector('.tab-label'));
    const result = {
      count: list.querySelectorAll('[role="tab"]').length,
      overflow,
      scrolledToLast,
      flexWrap: style.flexWrap,
      overflowX: style.overflowX,
      pageStayedContained: document.documentElement.scrollWidth === pageWidthBefore,
      ellipsis: labelStyle.textOverflow,
      whiteSpace: labelStyle.whiteSpace,
    };
    clones.forEach(clone => clone.remove());
    return result;
  })()`);
  check('many MCP tabs stay on one horizontally scrollable row without widening the page',
    tabStress.count >= 34 && tabStress.overflow && tabStress.scrolledToLast && tabStress.flexWrap === 'nowrap' &&
    ['auto', 'scroll'].includes(tabStress.overflowX) && tabStress.pageStayedContained,
    JSON.stringify(tabStress));
  check('long MCP tab labels use ellipsis', tabStress.ellipsis === 'ellipsis' && tabStress.whiteSpace === 'nowrap',
    JSON.stringify(tabStress));
  await shot('05-layout.png');
  writeFileSync(join(OUT, 'layout.json'), JSON.stringify(layout, null, 2));
  await shotClip('06-toolcard.png', 'details.config-card:nth-of-type(2)', 1.2);
  await shotClip('07-tabbar.png', '#tool-tab-area', 1.6);
  await evaluate(`document.getElementById('manage-groups').click()`);
  await settle(700);
  await shotClip('08-group-page.png', '#tool-groups-page', 1.5);
  await evaluate(`document.getElementById('group-back').click()`);
  await settle(300);

  // 10. save round trip through the real API, then restore
  const modeSwitch = await evaluate(`(() => {
    const select = document.getElementById('tool-mode');
    const target = [...select.options].find(o => o.value === 'minimal') ?? select.options[0];
    select.value = target.value;
    select.dispatchEvent(new Event('change'));
    return target.value;
  })()`);
  await settle(900);
  const cleared = await evaluate(`(() => { document.getElementById('clear-all-tools').click(); return document.querySelectorAll('#tool-group-panels input[data-tool]').length; })()`);
  await settle(300);
  await evaluate(`document.getElementById('save-tools').click()`);
  await settle(1800);
  const status = await evaluate(`document.getElementById('status').textContent`);
  const saved = await fetch(`${BASE}/preset-enhance/api`).then(response => response.json()).catch(() => null);
  let cookieState = null;
  try {
    const state = await evaluate(`fetch('/preset-enhance/api').then(r => r.json())`);
    cookieState = state;
  } catch { /* logged below */ }
  const modePolicy = cookieState?.modeToolPolicies?.[modeSwitch] ?? null;
  check('保存工具开关 persists through the real API', /已保存|生效/.test(status) && modePolicy !== null &&
    Object.values(modePolicy).every(value => value === false), `${modeSwitch}: ${JSON.stringify(modePolicy)}`);
  await evaluate(`document.getElementById('select-all-tools').click()`);
  await settle(300);
  await evaluate(`document.getElementById('save-tools').click()`);
  await settle(1800);
  const restored = await evaluate(`fetch('/preset-enhance/api').then(r => r.json()).then(s => s.modeToolPolicies[${JSON.stringify(modeSwitch)}] ?? null)`);
  check('restored the mode policy to all-enabled', restored !== null && Object.values(restored).every(value => value === true), JSON.stringify(restored));

  // 12. tool-switch persistence: unrelated saves keep the draft, reload remembers the mode
  const persistMode = await evaluate(`(() => {
    const select = document.getElementById('tool-mode');
    const target = [...select.options].find(o => o.value === 'ptc') ?? select.options[0];
    select.value = target.value;
    select.dispatchEvent(new Event('change'));
    return target.value;
  })()`);
  await settle(1400);
  const persistenceDraft = await evaluate(`(() => {
    const all = [...document.querySelectorAll('#tool-list input[data-tool]')];
    const beforeOff = all.filter(box => !box.checked).map(box => box.dataset.tool);
    const targets = all.filter(box => box.checked).slice(0, 2);
    for (const box of targets) box.click();
    return { targets: targets.map(box => box.dataset.tool), expectedOff: [...new Set([
      ...beforeOff, ...targets.map(box => box.dataset.tool),
    ])] };
  })()`);
  await settle(600);
  await evaluate(`document.getElementById('save-deepseek-beta').click()`);
  await settle(2000);
  const afterUnrelated = await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('#tool-list input[data-tool]')];
    return { off: boxes.filter(box => !box.checked).map(box => box.dataset.tool), status: document.getElementById('status').textContent };
  })()`);
  check('an unrelated save keeps the unsaved tool-switch draft',
    JSON.stringify([...afterUnrelated.off].sort()) === JSON.stringify([...persistenceDraft.expectedOff].sort()) &&
      /尚未保存/.test(afterUnrelated.status),
    `off=[${afterUnrelated.off.join(',')}] status=${afterUnrelated.status}`);
  await evaluate(`document.getElementById('save-tools').click()`);
  await settle(2200);
  const persistedPolicy = await evaluate(`fetch('/preset-enhance/api').then(r => r.json()).then(s => s.modeToolPolicies[${JSON.stringify(persistMode)}] ?? null)`);
  const persistedOff = Object.entries(persistedPolicy ?? {}).filter(([, value]) => value === false).map(([name]) => name);
  check('保存工具开关 persists exactly the unchecked tools',
    persistenceDraft.targets.length > 0 && persistenceDraft.expectedOff.every(name => persistedPolicy?.[name] === false) &&
      persistedOff.length === persistenceDraft.expectedOff.length,
    `${persistMode}: off=[${persistedOff.join(',')}]`);
  const persistReload = once('Page.loadEventFired');
  await send('Page.reload', {});
  await persistReload;
  await waitReady();
  await settle(2200);
  const afterPersistReload = await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('#tool-list input[data-tool]')];
    return { mode: document.getElementById('tool-mode').value, off: boxes.filter(box => !box.checked).map(box => box.dataset.tool) };
  })()`);
  check('a page reload remembers the configured mode and renders its saved switches',
    afterPersistReload.mode === persistMode &&
    JSON.stringify([...afterPersistReload.off].sort()) === JSON.stringify([...persistenceDraft.expectedOff].sort()),
    `mode=${afterPersistReload.mode} off=[${afterPersistReload.off.join(',')}]`);

  // 13. auto-save switch: one edit = one request, no manual save; OFF keeps the draft behaviour
  const hasAutoSave = await evaluate(`!!document.getElementById('tool-auto-save')`);
  if (hasAutoSave) {
    await evaluate(`(() => {
      if (!window.__origFetch) window.__origFetch = window.fetch;
      window.__apiPosts = [];
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (String(init.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/preset-enhance/api')) {
          try { window.__apiPosts.push(JSON.parse(init.body).action); } catch { window.__apiPosts.push('unknown'); }
        }
        return window.__origFetch(input, init);
      };
      const box = document.getElementById('tool-auto-save');
      if (box.checked) box.click();
      return box.checked;
    })()`);
    await settle(500);
    await evaluate(`document.getElementById('tool-auto-save').click()`);
    await settle(500);
    await evaluate(`window.__apiPosts = []`);
    const autoTarget = await evaluate(`(() => {
      const box = [...document.querySelectorAll('#tool-list input[data-tool]')].find(item => item.checked);
      box.click();
      return box.dataset.tool;
    })()`);
    await settle(2200);
    const autoPosts = await evaluate(`window.__apiPosts.slice()`);
    const autoPolicy = await evaluate(`fetch('/preset-enhance/api').then(r => r.json()).then(s => s.modeToolPolicies[${JSON.stringify(persistMode)}] ?? null)`);
    const autoStatus = await evaluate(`document.getElementById('status').textContent`);
    check('auto-save persists a single toggle without 保存工具开关',
      autoPosts.filter(action => action === 'save-mode-tools' || action === 'save-session-tools').length === 1 &&
      autoPolicy?.[autoTarget] === false,
      `${autoTarget}: posts=[${autoPosts.join(',')}] saved=${autoPolicy?.[autoTarget]} status=${autoStatus}`);
    await evaluate(`window.__apiPosts = []`);
    await evaluate(`(() => { for (const box of [...document.querySelectorAll('#tool-list input[data-tool]')].slice(0, 4)) box.click(); })()`);
    await settle(2200);
    const burstPosts = await evaluate(`window.__apiPosts.slice()`);
    check('rapid edits coalesce into a single auto-save request',
      burstPosts.filter(action => action.startsWith('save-')).length === 1, `posts=[${burstPosts.join(',')}]`);
    await evaluate(`(() => { const box = document.getElementById('tool-auto-save'); if (box.checked) box.click(); })()`);
    await settle(400);
    await evaluate(`window.__apiPosts = []`);
    await evaluate(`(() => { document.querySelector('#tool-list input[data-tool]').click(); })()`);
    await settle(1800);
    const offPosts = await evaluate(`window.__apiPosts.slice()`);
    const offStatus = await evaluate(`document.getElementById('status').textContent`);
    check('auto-save OFF keeps the manual draft behaviour',
      offPosts.length === 0 && /尚未保存/.test(offStatus), `posts=[${offPosts.join(',')}] status=${offStatus}`);
    await evaluate(`document.getElementById('select-all-tools').click()`);
    await settle(400);
    await evaluate(`document.getElementById('save-tools').click()`);
    await settle(2000);
    const autoReload = once('Page.loadEventFired');
    await send('Page.reload', {});
    await autoReload;
    await waitReady();
    await settle(1800);
    const autoPersisted = await evaluate(`(() => {
      const box = document.getElementById('tool-auto-save');
      return { checked: box?.checked ?? null, stored: localStorage.getItem('dsh-preset-enhance.tool-auto-save') };
    })()`);
    check('auto-save switch state is UI-local and off after being turned off',
      autoPersisted.checked === false, JSON.stringify(autoPersisted));
  } else {
    check('auto-save switch exists', false, 'no #tool-auto-save in the tool card');
  }

  const summary = { verified: results.filter(item => item.pass).length, falsified: results.filter(item => !item.pass).length, results };
  writeFileSync(join(OUT, 'browser-e2e.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.verified} verified / ${summary.falsified} falsified`);
  console.log(`artifacts: ${OUT}`);
  process.exitCode = summary.falsified > 0 ? 1 : 0;
} catch (error) {
  console.error('DRIVER ERROR', error);
  process.exitCode = 2;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { browser.kill(); } catch { /* ignore */ }
}
